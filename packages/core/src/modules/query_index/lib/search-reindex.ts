import type { EntityManager } from '@mikro-orm/postgresql'
import { type Kysely, sql } from 'kysely'
import { resolveTenantEncryptionService } from '@open-mercato/shared/lib/encryption/customFieldValues'
import { decryptIndexDocForSearch } from '@open-mercato/shared/lib/encryption/indexDoc'
import { mapWithConcurrency } from '@open-mercato/shared/lib/query/bounded-decrypt'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { buildSearchTrigramHashes } from './search-trigrams'
import { trigramArraySql } from './indexer'

const logger = createLogger('query_index').child({ component: 'search-reindex' })

const DEFAULT_BATCH_SIZE = 500
const DECRYPT_CONCURRENCY = 8

export type SearchReindexOptions = {
  entityType: string
  tenantId?: string | null
  organizationId?: string | null
  batchSize?: number
  /** Recompute rows that already carry a set; off by default so an upgrade fill is resumable. */
  force?: boolean
  onProgress?: (info: { processed: number; total: number; chunkSize: number }) => void
}

export type SearchReindexResult = { processed: number; total: number }

type IndexRow = {
  id: string
  entity_type: string
  entity_id: string
  organization_id: string | null
  tenant_id: string | null
  doc: Record<string, unknown> | null
}

/**
 * Recompute `entity_indexes.search_trgm` from the document already stored on the row.
 *
 * This is `reindex --target search`. It never reads the source table and never rewrites `doc`, so
 * it is cheap enough to run as the upgrade fill on a large install — the WAL of a full document
 * rewrite is what forced the token table to `UNLOGGED` downstream. It decrypts each document the
 * way the write path does, so encrypted values are trigrammed from plaintext.
 *
 * Skips rows that already carry a set unless `force`, which makes the fill resumable: an
 * interrupted run picks up where it stopped instead of starting over.
 */
export async function reindexSearchTrigrams(
  em: EntityManager,
  options: SearchReindexOptions,
): Promise<SearchReindexResult> {
  const entityType = String(options.entityType || '')
  if (!entityType) return { processed: 0, total: 0 }
  const db = (em as any).getKysely() as Kysely<any>
  const batchSize = Number.isFinite(options.batchSize) && options.batchSize! > 0
    ? Math.max(1, Math.trunc(options.batchSize!))
    : DEFAULT_BATCH_SIZE
  const encryption = resolveTenantEncryptionService(em as any)

  const scope = <QB extends { where: (...args: any[]) => QB }>(query: QB): QB => {
    let next = query.where('entity_type' as any, '=', entityType)
    if (options.tenantId !== undefined) {
      next = next.where(sql`tenant_id is not distinct from ${options.tenantId ?? null}`)
    }
    if (options.organizationId !== undefined) {
      next = next.where(sql`organization_id is not distinct from ${options.organizationId ?? null}`)
    }
    if (!options.force) next = next.where('search_trgm' as any, 'is', null as any)
    return next
  }

  const totalRow = await scope(
    db.selectFrom('entity_indexes' as any).select(sql<string>`count(*)`.as('count')),
  ).executeTakeFirst() as { count?: unknown } | undefined
  const total = Number(totalRow?.count ?? 0)
  if (!total) return { processed: 0, total: 0 }

  let processed = 0
  let cursor: string | null = null
  // Keyset pagination on the primary key: a `search_trgm IS NULL` predicate that the batch itself
  // falsifies makes OFFSET skip rows, and `force` runs have no such predicate to lean on either.
  for (;;) {
    let query = scope(
      db
        .selectFrom('entity_indexes' as any)
        .select(['id' as any, 'entity_type' as any, 'entity_id' as any, 'organization_id' as any, 'tenant_id' as any, 'doc' as any]),
    )
    if (cursor) query = query.where('id' as any, '>', cursor)
    const rows = await query.orderBy('id' as any, 'asc').limit(batchSize).execute() as IndexRow[]
    if (!rows.length) break
    cursor = String(rows[rows.length - 1].id)

    const updates = await mapWithConcurrency(rows, DECRYPT_CONCURRENCY, async (row) => {
      const doc = row.doc && typeof row.doc === 'object' ? row.doc : {}
      let searchDoc: Record<string, unknown> = doc
      try {
        searchDoc = await decryptIndexDocForSearch(
          entityType,
          doc,
          { tenantId: row.tenant_id ?? null, organizationId: row.organization_id ?? null },
          encryption,
        )
      } catch (error) {
        logger.warn('Failed to decrypt index document during search reindex', {
          entityType,
          recordId: row.entity_id,
          err: error,
        })
      }
      const hashes = buildSearchTrigramHashes({
        entityType,
        tenantId: row.tenant_id ?? null,
        doc: searchDoc,
      })
      return { id: String(row.id), hashes }
    })

    for (const update of updates) {
      // `null` means search is switched off entirely; leave the column as it stands rather than
      // blanking a set the operator may want back when they switch search on again.
      if (!update.hashes) continue
      await db
        .updateTable('entity_indexes' as any)
        .set({ search_trgm: trigramArraySql(update.hashes) } as any)
        .where('id' as any, '=', update.id)
        .execute()
    }

    processed += rows.length
    options.onProgress?.({ processed, total, chunkSize: rows.length })
    if (rows.length < batchSize) break
  }

  return { processed, total }
}

/** Entity types this install actually has projection rows for. */
export async function listIndexedEntityTypes(em: EntityManager): Promise<string[]> {
  const db = (em as any).getKysely() as Kysely<any>
  const rows = await db
    .selectFrom('entity_indexes' as any)
    .select('entity_type' as any)
    .distinct()
    .execute() as Array<{ entity_type?: unknown }>
  return rows
    .map((row) => (typeof row.entity_type === 'string' ? row.entity_type : null))
    .filter((entityType): entityType is string => !!entityType)
}

/** Rows whose trigram set the upgrade fill has not reached yet, per entity type. */
export async function countRowsMissingTrigrams(
  em: EntityManager,
): Promise<Array<{ entityType: string; missing: number }>> {
  const db = (em as any).getKysely() as Kysely<any>
  const rows = await db
    .selectFrom('entity_indexes' as any)
    .select(['entity_type' as any, sql<string>`count(*)`.as('missing')])
    .where('search_trgm' as any, 'is', null as any)
    .groupBy('entity_type' as any)
    .orderBy('entity_type' as any, 'asc')
    .execute() as Array<{ entity_type: string; missing: unknown }>
  return rows.map((row) => ({ entityType: String(row.entity_type), missing: Number(row.missing ?? 0) }))
}
