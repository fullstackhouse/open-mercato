/**
 * Data migrations rewrite columns in raw SQL, so they bypass every CRUD/indexer helper that
 * would normally emit `query_index.upsert_one`. A migration also cannot emit from where it
 * stands: it runs inside its own transaction with no DI container, and the projection must
 * only be refreshed once the rewrite has committed.
 *
 * A migration therefore *declares* the entity types whose projections it invalidated, and
 * `mercato db migrate` discharges the obligation after the whole run commits.
 */

export const QUERY_INDEX_REINDEX_EXPORT = 'queryIndexReindexEntityTypes'

const ENTITY_TYPE_PATTERN = /^[a-z0-9_]+:[a-z0-9_]+$/

/**
 * Stands for "every entity type this install actually has projection rows for". A static
 * declaration cannot enumerate them — which modules are installed is a deploy-time fact — so the
 * wildcard is resolved against `entity_indexes` when the reindex is queued.
 */
export const QUERY_INDEX_REINDEX_ALL = '*'

/**
 * Which part of the projection a queued reindex has to recompute. `search` recomputes only
 * `entity_indexes.search_trgm` from the stored document, which is what a search-only change needs
 * and what keeps a fill off the write-amplifying path of a full document rewrite.
 */
export type QueryIndexReindexTarget = 'all' | 'search'

export type QueryIndexReindexDeclaration = {
  entityTypes: readonly string[]
  target: QueryIndexReindexTarget
}

export function isQueryIndexEntityType(value: unknown): value is string {
  return typeof value === 'string' && (value === QUERY_INDEX_REINDEX_ALL || ENTITY_TYPE_PATTERN.test(value))
}

export function declareQueryIndexReindex(
  entityTypes: readonly string[],
  options?: { target?: QueryIndexReindexTarget },
): QueryIndexReindexDeclaration {
  if (!Array.isArray(entityTypes) || entityTypes.length === 0) {
    throw new Error('[internal] declareQueryIndexReindex requires at least one entity type')
  }
  const normalized: string[] = []
  for (const entityType of entityTypes) {
    if (!isQueryIndexEntityType(entityType)) {
      throw new Error(
        `[internal] declareQueryIndexReindex expects "module:entity" identifiers, received: ${String(entityType)}`,
      )
    }
    if (!normalized.includes(entityType)) normalized.push(entityType)
  }
  const declaration: QueryIndexReindexDeclaration = {
    entityTypes: Object.freeze(normalized),
    target: options?.target ?? 'all',
  }
  return Object.freeze(declaration)
}

/**
 * The reader — not `declareQueryIndexReindex` — is the contract's real boundary: it accepts any
 * `queryIndexReindexEntityTypes` array, including one written as a plain literal. A rejected entry
 * is therefore reported through `onReject` rather than dropped silently, so a typo such as
 * `customers:customerDictionaryEntry` cannot leave a projection stale behind a green migrate run.
 */
export function readQueryIndexReindexDeclaration(
  moduleExports: unknown,
  onReject?: (value: unknown) => void,
): QueryIndexReindexDeclaration {
  const empty: QueryIndexReindexDeclaration = { entityTypes: [], target: 'all' }
  if (!moduleExports || typeof moduleExports !== 'object') return empty
  const declared = (moduleExports as Record<string, unknown>)[QUERY_INDEX_REINDEX_EXPORT]
  // A plain array is the pre-`target` spelling and still the contract's boundary: a migration may
  // export a literal rather than call the helper.
  const entries = Array.isArray(declared)
    ? declared
    : Array.isArray((declared as QueryIndexReindexDeclaration | undefined)?.entityTypes)
      ? (declared as QueryIndexReindexDeclaration).entityTypes
      : null
  if (!entries) return empty
  const target = !Array.isArray(declared) && (declared as QueryIndexReindexDeclaration).target === 'search'
    ? 'search'
    : 'all'
  const collected: string[] = []
  for (const entityType of entries) {
    if (!isQueryIndexEntityType(entityType)) {
      onReject?.(entityType)
      continue
    }
    if (!collected.includes(entityType)) collected.push(entityType)
  }
  return { entityTypes: collected, target }
}

export function formatQueryIndexRebuildCommands(
  entityTypes: readonly string[],
  target: QueryIndexReindexTarget = 'all',
): string[] {
  const suffix = target === 'search' ? ' --target search' : ''
  return entityTypes.map((entityType) =>
    entityType === QUERY_INDEX_REINDEX_ALL
      ? `mercato query_index reindex --all${suffix}`
      : `mercato query_index rebuild --entity ${entityType} --global${suffix}`,
  )
}
