export type OrganizationScope = { ids: string[]; includeNull: boolean }

export function isSearchFilterOp(op: string | null | undefined): boolean {
  return op === 'like' || op === 'ilike'
}

/**
 * The single definition of "this query actually searches".
 *
 * What used to sit behind this gate — a `search_tokens` table probe plus a per-scope
 * token-presence probe, three specs' worth of tuning and a process-level TTL cache — is gone with
 * the token table. The trigram predicate is always emitted: a projection row either carries a
 * trigram set or has not been reindexed yet, and an un-reindexed row is simply not found until
 * the queued fill reaches it. That is a temporary state of an upgrade, not a steady-state
 * condition worth a per-request check; `mercato query_index status` reports what is left.
 */
export function hasSearchFilter(filters: ReadonlyArray<{ op?: string | null }>): boolean {
  return filters.some((filter) => isSearchFilterOp(filter.op))
}
