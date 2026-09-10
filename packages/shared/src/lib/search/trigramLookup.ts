import { type Kysely, sql } from 'kysely'
import { resolveSearchConfig, type SearchConfig } from './config'
import { resolveTermKindsForField } from './fields'
import { buildTrigramQuery, type SearchFieldKind } from './trigram'
import { buildTrigramContainment, SEARCH_TRIGRAM_COLUMN } from './trigramSql'

export type SearchTrigramDatabase = {
  entity_indexes: {
    entity_id: string
    entity_type: string
    tenant_id: string | null
    organization_id: string | null
    search_trgm: number[] | null
  }
}

/**
 * Tenant/organization scoping for a trigram lookup.
 *
 * `undefined` and `null` are NOT interchangeable:
 * - `undefined` omits the predicate entirely (the caller owns visibility).
 * - `null` emits a null-safe predicate that matches only globally scoped rows.
 */
export type SearchTrigramScope = {
  tenantId?: string | null
  organizationId?: string | null
  organizationIds?: readonly string[] | null
}

/**
 * Why a lookup could not produce an id set. Callers MUST NOT read these as "nothing matched" —
 * the trigram index was never consulted, so the caller's own predicate is still authoritative.
 */
export type SearchTrigramLookupSkipReason = 'empty-query' | 'search-disabled' | 'term-too-short'

export type SearchTrigramLookupResult =
  | { matched: true; ids: string[] }
  | { matched: false; reason: SearchTrigramLookupSkipReason }

export type FindEntityIdsBySearchTrigramsInput = {
  db: Kysely<SearchTrigramDatabase>
  entityType: string
  query: string
  /**
   * Filter fields the term is meant for. Only used to narrow the term's shapings when the entity
   * declares a kind for the field; the stored hash set is per record, not per field.
   */
  fields?: readonly string[] | null
  scope?: SearchTrigramScope
  config?: SearchConfig
  /** Bound on the returned id set; the caller unions it into an `id IN (…)` predicate. */
  limit?: number
}

const DEFAULT_LOOKUP_LIMIT = 5_000

/**
 * Resolve the record ids whose projection row carries every trigram of `query`.
 *
 * This is the encryption-safe replacement for `ilike` filtering on columns an encryption map
 * covers: the stored column holds ciphertext, so `ilike '%term%'` silently matches nothing, while
 * the trigram column stores keyed hashes of the plaintext and keeps matching (issue #2990).
 *
 * Containment can over-match — it proves the fragments are present, not contiguous — so a caller
 * that needs an exact answer MUST recheck the returned records against the decrypted values.
 * The query engines do this for their own list path.
 */
export async function findEntityIdsBySearchTrigrams({
  db,
  entityType,
  query,
  fields,
  scope,
  config,
  limit,
}: FindEntityIdsBySearchTrigramsInput): Promise<SearchTrigramLookupResult> {
  const trimmed = query.trim()
  if (!trimmed) return { matched: false, reason: 'empty-query' }

  const searchConfig = config ?? resolveSearchConfig()
  if (!searchConfig.enabled) return { matched: false, reason: 'search-disabled' }

  const scopedFields = (fields ?? []).filter((field) => typeof field === 'string' && field.length > 0)
  const kinds = resolveTermKinds(entityType, scopedFields)
  const trigramQuery = buildTrigramQuery({ term: trimmed, tenantId: scope?.tenantId ?? null, kinds })
  if (!trigramQuery) return { matched: false, reason: 'term-too-short' }

  const trgmColumn = sql`${sql.ref(`entity_indexes.${SEARCH_TRIGRAM_COLUMN}`)}`
  let builder = db
    .selectFrom('entity_indexes')
    .select('entity_id')
    .where('entity_type', '=', entityType)
    .where(sql<boolean>`${trgmColumn} is not null`)
    .where(buildTrigramContainment(trgmColumn, trigramQuery))

  if (scope?.tenantId !== undefined) {
    builder = builder.where(sql<boolean>`tenant_id is not distinct from ${scope.tenantId}`)
  }

  if (scope?.organizationId !== undefined) {
    builder = scope.organizationId === null
      ? builder.where(sql<boolean>`organization_id is not distinct from ${null}`)
      : builder.where('organization_id', '=', scope.organizationId)
  } else if (scope?.organizationIds?.length) {
    builder = builder.where('organization_id', 'in', Array.from(scope.organizationIds))
  }

  const rows = (await builder
    .limit(limit ?? DEFAULT_LOOKUP_LIMIT)
    .execute()) as Array<{ entity_id?: unknown }>

  const ids = rows
    .map((row) => (typeof row.entity_id === 'string' ? row.entity_id : null))
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  return { matched: true, ids }
}

function resolveTermKinds(entityType: string, fields: readonly string[]): SearchFieldKind[] | null {
  if (fields.length !== 1) return null
  return resolveTermKindsForField(entityType, fields[0])
}

/**
 * Legacy-shaped adapter for call sites that predate {@link SearchTrigramLookupResult}: `null` for
 * a blank query, `[]` for every other non-answer, otherwise the matched ids.
 */
export async function findEntityIdsBySearchTrigramsCompat(
  input: FindEntityIdsBySearchTrigramsInput,
): Promise<string[] | null> {
  const result = await findEntityIdsBySearchTrigrams(input)
  if (result.matched) return result.ids
  return result.reason === 'empty-query' ? null : []
}
