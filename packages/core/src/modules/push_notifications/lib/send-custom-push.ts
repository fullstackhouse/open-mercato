import type { EntityManager } from '@mikro-orm/postgresql'
import { getNotificationType } from '@open-mercato/core/modules/notifications/lib/notification-type-registry'
import type { PushOptions } from '@open-mercato/core/modules/communication_channels/lib/push-envelope'
import { ADMIN_CUSTOM_MESSAGE_TYPE } from '../notifications'
import { fanOutPushDeliveries } from './push-fanout'

type Resolve = <T = unknown>(name: string) => T

export interface SendCustomPushArgs {
  /** Scoped DI resolver (e.g. an API route's request container `resolve`). */
  resolve: Resolve
  tenantId: string
  userId: string
  organizationId?: string | null
  /** Literal, already-authored push title (free text — not an i18n key, so not translated). */
  title: string
  /** Optional literal push body. */
  body?: string | null
  /** Arbitrary app-readable key/values delivered in the push data payload. */
  data?: Record<string, string>
  /** Optional per-provider push customization (sound, badge, priority, …). */
  pushOptions?: PushOptions
  /** Registered, non-silent notification type. Defaults to the admin custom-message type. */
  type?: string
}

/**
 * Deliver an admin-composed, one-off **visible** push to all of a user's push-capable devices.
 *
 * The mirror image of {@link sendSilentPush}: same direct fan-out (no in-app `Notification` row, no
 * email, no per-channel preference check), but a visible payload carrying a literal title/body. The
 * `type` MUST be registered and **not** silent (a visible push cannot target a silent type) — the
 * inverse of the silent guard. Because the copy is literal free text, it is delivered verbatim (no
 * per-device locale translation). The actual provider send happens in the `send-push` worker; the
 * returned `enqueued` is the number of per-device jobs scheduled.
 */
export async function sendCustomPush(args: SendCustomPushArgs): Promise<{ enqueued: number }> {
  const {
    resolve,
    tenantId,
    userId,
    organizationId = null,
    title,
    body = null,
    data,
    pushOptions,
    type = ADMIN_CUSTOM_MESSAGE_TYPE,
  } = args

  const definition = getNotificationType(type)
  if (!definition) {
    throw new Error(`[internal] sendCustomPush: notification type "${type}" is not registered`)
  }
  if (definition.silent === true) {
    throw new Error(`[internal] sendCustomPush: notification type "${type}" is declared silent`)
  }

  const em = resolve('em') as EntityManager

  return fanOutPushDeliveries({
    em,
    resolve,
    scope: { tenantId, organizationId },
    userId,
    notificationId: null,
    notificationTypeId: type,
    payload: {
      title,
      body,
      data: { ...(data ?? {}), type },
      options: pushOptions,
      silent: false,
    },
  })
}
