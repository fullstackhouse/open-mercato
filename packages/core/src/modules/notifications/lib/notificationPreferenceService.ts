import type { EntityManager } from '@mikro-orm/postgresql'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { NotificationPreference } from '../data/entities'
import { getNotificationType } from './notification-type-registry'

/**
 * Tenant + user scope for preference operations. Tenant scoping is mandatory,
 * so it is part of every call (the spec's bare `userId` signatures are widened
 * here to stay tenant-safe).
 */
export interface NotificationPreferenceScope {
  tenantId: string
  userId: string
}

export interface NotificationPreferenceInput {
  typeId: string
  channel: string
  enabled: boolean
}

export interface NotificationPreferenceService {
  /**
   * Whether a channel is enabled for a user + type. Defaults to `true` when no
   * row exists (lazy-seed, default-on) — does not write.
   */
  isChannelEnabled(scope: NotificationPreferenceScope, typeId: string, channel: string): Promise<boolean>
  /** Bulk find-or-upsert of preference rows for the scoped user. */
  setPreferences(scope: NotificationPreferenceScope, items: NotificationPreferenceInput[]): Promise<void>
  /** All stored preference rows for the scoped user (absence ⇒ enabled). */
  listForUser(scope: NotificationPreferenceScope): Promise<NotificationPreference[]>
}

export interface NotificationPreferenceServiceDeps {
  em: EntityManager
}

export function createNotificationPreferenceService(
  deps: NotificationPreferenceServiceDeps,
): NotificationPreferenceService {
  const { em: rootEm } = deps

  return {
    async isChannelEnabled(scope, typeId, channel) {
      const row = await rootEm.findOne(NotificationPreference, {
        tenantId: scope.tenantId,
        userId: scope.userId,
        notificationTypeId: typeId,
        channel,
      })
      return row ? row.enabled : true
    },

    async listForUser(scope) {
      return rootEm.find(
        NotificationPreference,
        { tenantId: scope.tenantId, userId: scope.userId },
        { orderBy: { notificationTypeId: 'asc', channel: 'asc' } },
      )
    },

    async setPreferences(scope, items) {
      // nonOptOut types ignore stored preferences at delivery time; refuse to persist an opt-out
      // row for them so the stored state can never contradict enforcement.
      const writable = items.filter((item) => getNotificationType(item.typeId)?.nonOptOut !== true)
      if (writable.length === 0) return
      const em = rootEm.fork()
      const existing = await em.find(NotificationPreference, {
        tenantId: scope.tenantId,
        userId: scope.userId,
      })
      const byKey = new Map(
        existing.map((row) => [`${row.notificationTypeId}::${row.channel}`, row]),
      )

      await withAtomicFlush(
        em,
        [
          () => {
            for (const item of writable) {
              const row = byKey.get(`${item.typeId}::${item.channel}`)
              if (row) {
                row.enabled = item.enabled
                continue
              }
              const next = em.create(NotificationPreference, {
                tenantId: scope.tenantId,
                userId: scope.userId,
                notificationTypeId: item.typeId,
                channel: item.channel,
                enabled: item.enabled,
              })
              em.persist(next)
            }
          },
        ],
        { transaction: true, label: 'notifications.setPreferences' },
      )
    },
  }
}

export function resolveNotificationPreferenceService(container: {
  resolve: (name: string) => unknown
}): NotificationPreferenceService {
  const em = container.resolve('em') as EntityManager
  return createNotificationPreferenceService({ em })
}
