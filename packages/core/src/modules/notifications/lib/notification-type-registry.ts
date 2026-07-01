import type { EntityManager } from '@mikro-orm/postgresql'
import { type Kysely, sql } from 'kysely'
import type { NotificationTypeDefinition } from '@open-mercato/shared/modules/notifications/types'

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
  deleted: number
  total: number
}

/**
 * Reconcile the in-memory catalogue into the `notification_types` table.
 * Code-registered types are system-wide, so rows are written with
 * `tenant_id IS NULL`. Idempotent: updates `label_key`/`description_key` only on
 * drift, and prunes system-wide rows no longer in the catalogue. Guarded by a
 * once-per-process flag on the lazy path; pass `force` to bypass it (used by the
 * explicit `notifications.type_registry.sync` subscriber).
 *
 * Writes go through kysely with `INSERT ... ON CONFLICT DO NOTHING` so a
 * concurrent first-sync (or the seedDefaults subscriber racing a `GET /types`)
 * can never raise a duplicate-PK 500 — mirrors `query_index/lib/jobs.ts`.
 */
export async function syncNotificationTypes(
  em: EntityManager,
  opts: { force?: boolean } = {},
): Promise<SyncNotificationTypesResult> {
  const definitions = getNotificationTypes()
  if (synced && !opts.force) {
    return { created: 0, updated: 0, deleted: 0, total: definitions.length }
  }

  const db = em.getKysely<any>() as Kysely<any>

  // Read existing system-wide rows via kysely (not the ORM) so they stay out of the identity map and
  // the route's subsequent em.find reflects exactly what this function just wrote.
  const existing = (await db
    .selectFrom('notification_types')
    .select(['id', 'label_key', 'description_key'])
    .where('tenant_id', 'is', null)
    .execute()) as Array<{ id: string; label_key: string; description_key: string | null }>
  const byId = new Map(existing.map((row) => [row.id, row]))

  const labelKeyFor = (def: NotificationTypeDefinition) => def.labelKey ?? def.titleKey
  const descKeyFor = (def: NotificationTypeDefinition) => def.descriptionKey ?? null

  const toCreate = definitions.filter((def) => !byId.has(def.type))
  const toUpdate = definitions.filter((def) => {
    const row = byId.get(def.type)
    if (!row) return false
    return row.label_key !== labelKeyFor(def) || (row.description_key ?? null) !== descKeyFor(def)
  })

  let created = 0
  let updated = 0
  let deleted = 0

  if (toCreate.length) {
    await db
      .insertInto('notification_types')
      .values(
        toCreate.map((def) => ({
          id: def.type,
          tenant_id: null,
          label_key: labelKeyFor(def),
          description_key: descKeyFor(def),
          created_at: sql`now()`,
          updated_at: sql`now()`,
        })),
      )
      .onConflict((oc: any) => oc.column('id').doNothing())
      .execute()
    created = toCreate.length
  }

  // Bump updated_at only on real drift, so repeated syncs don't churn timestamps.
  for (const def of toUpdate) {
    await db
      .updateTable('notification_types')
      .set({ label_key: labelKeyFor(def), description_key: descKeyFor(def), updated_at: sql`now()` })
      .where('id', '=', def.type)
      .where('tenant_id', 'is', null)
      .execute()
    updated += 1
  }

  // Prune system-wide rows no longer in the catalogue (a removed/renamed module's type stops showing
  // in the preferences matrix). Guarded by a non-empty catalogue so a mis-bootstrapped process with an
  // empty registry can never wipe the table. Caveat: multiple apps with different module sets sharing
  // one DB would prune each other's types — out of scope for the standard one-app-per-DB deployment.
  if (definitions.length > 0) {
    const validIds = new Set(definitions.map((def) => def.type))
    const staleIds = existing.filter((row) => !validIds.has(row.id)).map((row) => row.id)
    if (staleIds.length) {
      await db
        .deleteFrom('notification_types')
        .where('tenant_id', 'is', null)
        .where('id', 'in', staleIds)
        .execute()
      deleted = staleIds.length
    }
  }

  synced = true
  return { created, updated, deleted, total: definitions.length }
}
