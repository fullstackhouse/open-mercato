import { type Kysely } from 'kysely'
import type { SearchConfig } from './config'
import {
  findEntityIdsBySearchTrigrams,
  type SearchTrigramDatabase,
  type SearchTrigramLookupResult,
} from './trigramLookup'

/**
 * @deprecated `search_tokens` no longer exists. Kept as a name so the direct-route consumers
 * compile unchanged; every member now describes the trigram column on `entity_indexes`.
 * Import from `./trigramLookup` in new code.
 */
export type SearchTokenDatabase = SearchTrigramDatabase

/** @deprecated Renamed — use `SearchTrigramScope` from `./trigramLookup`. */
export type SearchTokenScope = {
  tenantId?: string | null
  organizationId?: string | null
  organizationIds?: readonly string[] | null
}

/**
 * @deprecated Renamed — use `SearchTrigramLookupSkipReason`.
 *
 * `no-tokens` is retained as a spelling of "the term produced nothing indexable"; the trigram
 * path reports `term-too-short` for the same condition.
 */
export type SearchTokenLookupSkipReason = 'empty-query' | 'search-disabled' | 'no-tokens'

export type SearchTokenLookupResult =
  | { matched: true; ids: string[] }
  | { matched: false; reason: SearchTokenLookupSkipReason }

export type FindEntityIdsBySearchTokensInput = {
  db: Kysely<SearchTokenDatabase>
  entityType: string
  query: string
  fields?: readonly string[] | null
  scope?: SearchTokenScope
  config?: SearchConfig
}

function translate(result: SearchTrigramLookupResult): SearchTokenLookupResult {
  if (result.matched) return result
  return { matched: false, reason: result.reason === 'term-too-short' ? 'no-tokens' : result.reason }
}

/**
 * @deprecated Delegates to {@link findEntityIdsBySearchTrigrams}. The signature is unchanged so
 * the six direct-route consumers keep compiling; the semantics improve (word-prefix for text,
 * literal substring for identifiers) and the result may over-match until the caller rechecks.
 */
export async function findEntityIdsBySearchTokens(
  input: FindEntityIdsBySearchTokensInput,
): Promise<SearchTokenLookupResult> {
  return translate(await findEntityIdsBySearchTrigrams(input))
}

/**
 * @deprecated Legacy-shaped adapter: `null` for a blank query, `[]` for every other non-answer.
 */
export async function findEntityIdsBySearchTokensCompat(
  input: FindEntityIdsBySearchTokensInput,
): Promise<string[] | null> {
  const result = await findEntityIdsBySearchTokens(input)
  if (result.matched) return result.ids
  return result.reason === 'empty-query' ? null : []
}
