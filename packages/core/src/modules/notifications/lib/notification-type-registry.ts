import type { EntityManager } from '@mikro-orm/postgresql'
import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'
import { withAtomicFlush } from '@open-mercato/shared/lib/commands/flush'
import { NotificationType } from '../data/entities'

const registry = new Map<string, NotificationTypeDefinition>()

let synced = false

export type RegisterNotificationTypesOptions = {
  replace?: boolean
}

/**
 * In-memory mirror of the code-registered notification type catalogue. Fed at
 * app bootstrap from the generated aggregate (`notificationTypes`) — mirrors the
 * `messages` registry. This stays the source of truth for code; the
 * `notification_types` table is a read-through mirror for remote clients.
 */
export function registerNotificationTypes(
  types: NotificationTypeDefinition[],
  options: RegisterNotificationTypesOptions = {},
): void {
  if (options.replace) {
    registry.clear()
    synced = false
  }
  for (const type of types) {
    registry.set(type.type, type)
  }
}

export function getNotificationType(type: string): NotificationTypeDefinition | undefined {
  return registry.get(type)
}

export function getNotificationTypes(): NotificationTypeDefinition[] {
  return Array.from(registry.values())
}

export type SyncNotificationTypesResult = {
  created: number
  updated: number
  total: number
}

/**
 * Reconcile the in-memory catalogue into the `notification_types` table.
 * Code-registered types are system-wide, so rows are written with
 * `tenant_id IS NULL`. Idempotent: updates `label_key`/`description_key` only on
 * drift. Guarded by a once-per-process flag on the lazy path; pass `force` to
 * bypass it (used by the explicit `notifications.type_registry.sync` subscriber).
 */
export async function syncNotificationTypes(
  em: EntityManager,
  opts: { force?: boolean } = {},
): Promise<SyncNotificationTypesResult> {
  const definitions = getNotificationTypes()
  if (synced && !opts.force) {
    return { created: 0, updated: 0, total: definitions.length }
  }

  const existing = await em.find(NotificationType, { tenantId: null })
  const byId = new Map(existing.map((row) => [row.id, row]))

  let created = 0
  let updated = 0

  await withAtomicFlush(
    em,
    [
      () => {
        for (const def of definitions) {
          const labelKey = def.labelKey ?? def.titleKey
          const descriptionKey = def.descriptionKey ?? null
          const row = byId.get(def.type)
          if (!row) {
            const next = em.create(NotificationType, {
              id: def.type,
              tenantId: null,
              labelKey,
              descriptionKey,
            })
            em.persist(next)
            created += 1
            continue
          }
          if (row.labelKey !== labelKey || (row.descriptionKey ?? null) !== descriptionKey) {
            row.labelKey = labelKey
            row.descriptionKey = descriptionKey
            updated += 1
          }
        }
      },
    ],
    { transaction: true, label: 'notifications.syncNotificationTypes' },
  )

  synced = true
  return { created, updated, total: definitions.length }
}
