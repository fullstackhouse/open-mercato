import type { EntityManager } from '@mikro-orm/postgresql'
import { getNotificationType } from '@open-mercato/core/modules/notifications/lib/notification-type-registry'
import type { PushOptions } from '@open-mercato/core/modules/communication_channels/lib/push-envelope'
import { fanOutPushDeliveries } from './push-fanout'
import { sendCustomPush, type SendCustomPushArgs } from './send-custom-push'

type Resolve = <T = unknown>(name: string) => T

export interface SendSilentPushArgs {
  /** Scoped DI resolver (e.g. a subscriber's `ctx.resolve`). */
  resolve: Resolve
  tenantId: string
  userId: string
  organizationId?: string | null
  /** A notification type registered with `silent: true`. Throws otherwise. */
  type: string
  /** Arbitrary app-readable key/values delivered in the push data payload. */
  data?: Record<string, string>
  /** Optional per-provider push customization (sound is irrelevant for a silent wake-up). */
  pushOptions?: PushOptions
}

export interface PushNotificationService {
  sendSilentPush(args: SendSilentPushArgs): Promise<{ enqueued: number }>
  sendCustomPush(args: SendCustomPushArgs): Promise<{ enqueued: number }>
}

/**
 * Deliver a silent / content-available push to all of a user's push-capable devices.
 *
 * Silent-ness is a property of the registered notification TYPE — the `type` MUST be declared with
 * `silent: true` in its module's `notifications.ts`; this is validated against the in-memory type
 * registry and throws on violation (keeps silent strictly opt-in, mirroring the downstream guard).
 *
 * Unlike a normal notification, this creates NO in-app `Notification` row and bypasses per-channel
 * preferences/caps — it is a background wake-up. The actual provider send happens asynchronously in
 * the `send-push` worker; the returned `enqueued` is the number of per-device jobs scheduled.
 */
export async function sendSilentPush(args: SendSilentPushArgs): Promise<{ enqueued: number }> {
  const { resolve, tenantId, userId, organizationId = null, type, data, pushOptions } = args

  const definition = getNotificationType(type)
  if (!definition) {
    throw new Error(`[internal] sendSilentPush: notification type "${type}" is not registered`)
  }
  if (definition.silent !== true) {
    throw new Error(`[internal] sendSilentPush: notification type "${type}" is not declared silent`)
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
      data: { ...(data ?? {}), type },
      options: pushOptions,
      silent: true,
    },
  })
}

export const pushNotificationService: PushNotificationService = { sendSilentPush, sendCustomPush }
