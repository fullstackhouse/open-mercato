import type { EntityManager } from '@mikro-orm/postgresql'
import type { EntityName } from '@mikro-orm/core'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { PushOptions } from '@open-mercato/core/modules/communication_channels/lib/push-envelope'
import type { UserDevice } from '@open-mercato/core/modules/devices/data/entities'
import type { CommunicationChannel } from '@open-mercato/core/modules/communication_channels/data/entities'
import { PushNotificationDelivery } from '../data/entities'
import { enqueuePushDelivery } from './queue'

export const PUSH_CHANNEL = 'push'

type Resolve = <T = unknown>(name: string) => T

/** The push payload persisted on each delivery row and unpacked by the worker into the send envelope. */
export interface PushFanoutPayload {
  title?: string
  body?: string | null
  data: Record<string, string>
  options?: PushOptions
  silent?: boolean
}

export interface FanOutPushDeliveriesArgs {
  em: EntityManager
  resolve: Resolve
  scope: { tenantId: string; organizationId: string | null }
  userId: string
  /** Source in-app notification id, or `null` for a silent push (no Notification row). */
  notificationId: string | null
  notificationTypeId: string
  payload: PushFanoutPayload
}

function tokenSnapshot(token: string): string {
  // Persist at most the last 8 chars of the (long) provider token — never the full secret.
  return token.slice(-8)
}

/**
 * Resolve a recipient's push-capable devices, route each to its provider's tenant push
 * `CommunicationChannel`, persist one `pending` {@link PushNotificationDelivery} per device, and
 * enqueue a send job per row. Shared by the `push` delivery strategy (visible notifications) and
 * `sendSilentPush` (content-available wake-ups); it is preference-agnostic — the caller decides
 * whether to consult per-channel preferences before fanning out.
 *
 * Cross-module entities are resolved via DI tokens (registered `asValue` by their owning modules)
 * so this stays decoupled from those modules' internals. Returns the number of jobs enqueued.
 */
export async function fanOutPushDeliveries(args: FanOutPushDeliveriesArgs): Promise<{ enqueued: number }> {
  const { em, resolve, scope, userId, notificationId, notificationTypeId, payload } = args
  const { tenantId, organizationId } = scope

  // Require at least one active push CommunicationChannel for the tenant (push not configured ⇒ skip).
  // Channels are indexed by providerKey so each device routes to its matching provider (ios→apns, etc.).
  const ChannelRef = resolve('CommunicationChannel') as EntityName<CommunicationChannel>
  const channels = await em.find(ChannelRef, {
    tenantId,
    channelType: PUSH_CHANNEL,
    isActive: true,
    deletedAt: null,
  })
  if (channels.length === 0) return { enqueued: 0 }
  const channelsByProvider = new Map<string, CommunicationChannel>()
  for (const channel of channels) {
    if (!channelsByProvider.has(channel.providerKey)) channelsByProvider.set(channel.providerKey, channel)
  }

  // Load the recipient's devices that can receive push (active + has a token).
  // `push_token` is encrypted at rest; decrypt on read (no-op when encryption is disabled).
  const DeviceRef = resolve('UserDevice') as EntityName<UserDevice>
  const devices = await findWithDecryption(
    em,
    DeviceRef,
    { tenantId, userId, deletedAt: null, pushToken: { $ne: null } },
    undefined,
    { tenantId, organizationId },
  )
  if (devices.length === 0) return { enqueued: 0 }

  const silent = payload.silent === true

  // Insert one pending delivery row per device, routing each device to the push channel whose
  // providerKey matches the device's pushProvider. Devices with no provider, or no matching
  // configured channel, are skipped. Snapshot the matched provider + truncated token per row.
  const fork = em.fork()
  const deliveries: PushNotificationDelivery[] = []
  for (const device of devices) {
    const providerKey = device.pushProvider
    if (!providerKey) continue
    const channel = channelsByProvider.get(providerKey)
    if (!channel) continue
    deliveries.push(
      fork.create(PushNotificationDelivery, {
        tenantId,
        organizationId,
        notificationId,
        notificationTypeId,
        userDeviceId: device.id,
        userId,
        provider: channel.providerKey,
        tokenSnapshot: tokenSnapshot(device.pushToken as string),
        status: 'pending',
        attempts: 0,
        silent,
        payload,
      }),
    )
  }
  if (deliveries.length === 0) return { enqueued: 0 }
  fork.persist(deliveries)
  await fork.flush()

  // Enqueue one send job per delivery row (per-device retry isolation, idempotent on delivery id).
  // If enqueue fails, mark that row failed instead of leaving it orphaned in `pending` forever.
  let enqueued = 0
  let enqueueFailures = false
  for (const delivery of deliveries) {
    try {
      await enqueuePushDelivery({ deliveryId: delivery.id, tenantId, organizationId })
      enqueued += 1
    } catch (error) {
      enqueueFailures = true
      delivery.status = 'failed'
      delivery.lastError = error instanceof Error ? `enqueue_failed: ${error.message}` : 'enqueue_failed'
    }
  }
  if (enqueueFailures) await fork.flush()
  return { enqueued }
}
