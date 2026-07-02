import type { EntityManager } from '@mikro-orm/postgresql'
import type { EntityName } from '@mikro-orm/core'
import { sql } from 'kysely'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { NotificationDeliveryStrategy } from '@open-mercato/core/modules/notifications/lib/deliveryStrategies'
import { getNotificationType } from '@open-mercato/core/modules/notifications/lib/notification-type-registry'
import { resolveNotificationPreferenceService } from '@open-mercato/core/modules/notifications/lib/notificationPreferenceService'
import type { UserDevice } from '@open-mercato/core/modules/devices/data/entities'
import type { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { enqueuePushDelivery } from './queue'

export const PUSH_CHANNEL = 'push'

function tokenSnapshot(token: string): string {
  // Persist at most the last 8 chars of the (long) provider token — never the full secret.
  return token.slice(-8)
}

/**
 * `push` notification delivery strategy.
 *
 * Registered into the notifications strategy seam (see notifications.delivery-strategies.ts).
 * Runs inside the persistent `notifications:deliver` subscriber for every created notification.
 * It only enqueues fast work — the actual provider send (with retry/backoff) happens in the
 * `send-push` worker, so a slow/unavailable provider never blocks notification creation.
 *
 * Cross-module entities are resolved via DI tokens (registered `asValue` by their owning
 * modules) rather than imported, so this strategy stays decoupled from those modules' internals.
 */
export const mobilePushDeliveryStrategy: NotificationDeliveryStrategy = {
  id: PUSH_CHANNEL,
  label: 'Mobile push',
  // Attempt push whenever a tenant has a push channel configured; the pipeline below short-circuits
  // (no rows, no enqueue) when push is not set up for the tenant/recipient.
  defaultEnabled: true,
  async deliver(ctx) {
    const { notification } = ctx
    const tenantId = notification.tenantId
    const userId = notification.recipientUserId
    const organizationId = notification.organizationId ?? null

    // 1. Skip unknown types (the catalogue is the source of truth for what can notify a user).
    const type = getNotificationType(notification.type)
    if (!type) return

    const em = ctx.resolve('em') as EntityManager

    // 2. Require at least one active push CommunicationChannel for the tenant (push not configured ⇒ skip).
    //    This is the cheapest, most selective short-circuit (most tenants have no push channel), so it
    //    runs before the per-recipient preference lookup. Channels are indexed by providerKey so each
    //    device can be routed to its matching provider in step 5 (ios→apns, android→fcm, expo→expo).
    const ChannelRef = ctx.resolve('CommunicationChannel') as EntityName<CommunicationChannel>
    const channels = await em.find(ChannelRef, {
      tenantId,
      channelType: PUSH_CHANNEL,
      isActive: true,
      deletedAt: null,
    })
    if (channels.length === 0) return
    const channelsByProvider = new Map<string, CommunicationChannel>()
    for (const channel of channels) {
      if (!channelsByProvider.has(channel.providerKey)) channelsByProvider.set(channel.providerKey, channel)
    }

    // 3. Respect the recipient's per-channel preference (default-on when unset).
    const preferences = resolveNotificationPreferenceService({ resolve: ctx.resolve })
    const enabled = await preferences.isChannelEnabled({ tenantId, userId }, notification.type, PUSH_CHANNEL)
    if (!enabled) return

    // 4. Load the recipient's devices that can receive push (active + has a token). Scoped to the
    //    notification's organization so an org-scoped notification never fans out to a device the
    //    user registered under a different org — device identity is per (tenant, org, user, device)
    //    (see devices module), so this matches standard devices org scoping. A tenant-level
    //    (null-org) notification targets the user's tenant-level (null-org) devices.
    //    `push_token` is encrypted at rest; decrypt on read (no-op when encryption is disabled) so
    //    the per-row token snapshot below is taken from the plaintext value.
    const DeviceRef = ctx.resolve('UserDevice') as EntityName<UserDevice>
    const devices = await findWithDecryption(
      em,
      DeviceRef,
      {
        tenantId,
        organizationId,
        userId,
        deletedAt: null,
        pushToken: { $ne: null },
      },
      undefined,
      { tenantId, organizationId },
    )
    if (devices.length === 0) return

    const data: Record<string, string> = {
      notificationId: notification.id,
      type: notification.type,
    }
    if (notification.linkHref) data.linkHref = notification.linkHref

    const payload = { title: ctx.title, body: ctx.body, data }

    // 5. Insert one pending delivery row per device, routing each device to the push channel whose
    //    providerKey matches the device's pushProvider (ios→apns, android→fcm, expo→expo). Devices
    //    with no provider, or no matching configured channel, are skipped — so the row set can be
    //    empty even when the user has devices. Insert via INSERT ... ON CONFLICT DO NOTHING on the
    //    (notification_id, user_device_id) partial unique index: this strategy runs inside the
    //    at-least-once persistent `notifications:deliver` subscriber, so a redelivered event re-runs
    //    it — the conflict clause makes the re-fan-out a no-op instead of inserting a duplicate set of
    //    rows (and duplicate pushes). Only the rows actually inserted are returned, so exactly those
    //    are enqueued.
    const rows = devices.flatMap((device) => {
      const providerKey = device.pushProvider
      if (!providerKey) return []
      const channel = channelsByProvider.get(providerKey)
      if (!channel) return []
      return [{
        tenant_id: tenantId,
        organization_id: organizationId,
        notification_id: notification.id,
        notification_type_id: notification.type,
        user_device_id: device.id,
        user_id: userId,
        provider: channel.providerKey,
        token_snapshot: tokenSnapshot(device.pushToken as string),
        status: 'pending',
        attempts: 0,
        payload: sql`${JSON.stringify(payload)}::jsonb`,
        created_at: sql`now()`,
        updated_at: sql`now()`,
      }]
    })
    if (rows.length === 0) return
    const db = em.getKysely<any>()
    const inserted = (await db
      .insertInto('push_notification_deliveries')
      .values(rows)
      .onConflict((oc: any) =>
        oc.columns(['notification_id', 'user_device_id']).where('notification_id', 'is not', null).doNothing(),
      )
      .returning(['id'])
      .execute()) as Array<{ id: string }>

    // 6. Enqueue one send job per inserted row (per-device retry isolation, idempotent on delivery id).
    //    If enqueue fails, mark that row failed instead of leaving it orphaned in `pending` forever
    //    (the worker only ever processes rows it receives a job for).
    for (const row of inserted) {
      try {
        await enqueuePushDelivery({ deliveryId: row.id, tenantId, organizationId })
      } catch (error) {
        const reason = error instanceof Error ? `enqueue_failed: ${error.message}` : 'enqueue_failed'
        await db
          .updateTable('push_notification_deliveries')
          .set({ status: 'failed', last_error: reason, updated_at: sql`now()` })
          .where('id', '=', row.id)
          .execute()
      }
    }
  },
}

export default mobilePushDeliveryStrategy
