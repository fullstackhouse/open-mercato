import { type Kysely, sql, type SqlBool } from 'kysely'
import type {
  SearchStrategy,
  SearchStrategyId,
  SearchOptions,
  SearchResult,
  IndexableRecord,
} from '../types'
import type { EntityId } from '@open-mercato/shared/modules/entities'

/**
 * Configuration for TokenSearchStrategy.
 */
export type TokenStrategyConfig = {
  /**
   * Minimum share of the term's trigram groups a record must contain (0-1 ratio, default 0.5).
   *
   * Under the token index this was a ratio over whole-word hashes; it is now a ratio over the
   * term's per-word containment groups, which is the closest equivalent — a two-word query still
   * matches a record carrying only one of the words, as global search's fallback always did.
   */
  minMatchRatio?: number
  /** Default limit for search results */
  defaultLimit?: number
}

function normalizeOrganizationIds(options: SearchOptions): string[] | null {
  const single = typeof options.organizationId === 'string' ? options.organizationId.trim() : ''
  if (single) return [single]
  if (!Array.isArray(options.organizationIds)) return null
  return Array.from(new Set(
    options.organizationIds
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0),
  ))
}

const CF_ALIAS_PREFIX = 'cf_'
const CF_CANONICAL_PREFIX = 'cf:'

/**
 * Rewrites the query engine's aliased custom-field keys back to the spelling `search_tokens` is
 * meant to carry.
 *
 * The engine cannot label a column `cf:<key>` — `:` is not a valid SQL identifier — so it sanitizes
 * the alias down to `cf_<key>`. Core's token writer builds from `entity_indexes.doc`, which keeps
 * `cf:<key>`, and both writers replace a record's tokens by deleting only the `(entity_id, field)`
 * pairs their own document carries. Under two spellings neither deletes the other's custom-field
 * rows: every custom field is tokenized twice under names that carry the same hashes, while the
 * base-field rows the two documents share are alternately deleted and re-inserted on every write.
 *
 * `cf:` is the side to converge on because it is the side that is read — the query engine's search
 * predicate and every caller of `findEntityIdsBySearchTokens` ask for `cf:<key>`.
 *
 * Deliberately scoped to the rows this strategy writes rather than applied to
 * `IndexableRecord.fields` upstream: the same object is handed to the fulltext driver, and
 * Meilisearch rejects an attribute name containing `:`.
 *
 * The reversal assumes word-character keys. The engine's alias sanitizer is
 * `[^a-zA-Z0-9_] -> _` and a custom-field key is an unconstrained `z.string()`, so a key named
 * `order-ref` arrives as `cf_order_ref` and is rewritten to `cf:order_ref` — a name nothing reads,
 * which leaves that one field's double-write unfixed. Inverting the sanitizer would need the
 * field-definition key list, which this strategy has not got.
 */
function normalizeCustomFieldKeys(
  fields: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!fields) return fields
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith(CF_ALIAS_PREFIX)) {
      normalized[key] = value
      continue
    }
    const canonical = `${CF_CANONICAL_PREFIX}${key.slice(CF_ALIAS_PREFIX.length)}`
    // A document carrying both spellings meant the explicit one; the alias is the sanitizer's
    // output for the same field.
    if (canonical in fields) continue
    normalized[canonical] = value
  }
  return normalized
}

/**
 * TokenSearchStrategy provides hash-based search using the keyed trigram hash set on
 * `entity_indexes.search_trgm`. This strategy is always available and serves as a fallback when
 * other strategies fail.
 *
 * The id is still `tokens` and the shape is unchanged — only the store moved. It hashes the query
 * the same way the writer hashed the record's values, so search on encrypted fields keeps working
 * without exposing plaintext to external services.
 */
export class TokenSearchStrategy implements SearchStrategy {
  readonly id: SearchStrategyId = 'tokens'
  readonly name = 'Token Search'
  readonly priority = 10 // Lowest priority, always available as fallback

  private readonly minMatchRatio: number
  private readonly defaultLimit: number

  constructor(
    private readonly db: Kysely<any>,
    config?: TokenStrategyConfig,
  ) {
    this.minMatchRatio = config?.minMatchRatio ?? 0.5
    this.defaultLimit = config?.defaultLimit ?? 50
  }

  async isAvailable(): Promise<boolean> {
    return true // Always available
  }

  async ensureReady(): Promise<void> {
    // No initialization needed
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const organizationIds = normalizeOrganizationIds(options)
    if (organizationIds && organizationIds.length === 0) return []

    // Dynamically import the trigram helpers to avoid circular dependencies
    const { buildTrigramQuery } = await import('@open-mercato/shared/lib/search/trigram')
    const { buildTrigramContainment, SEARCH_TRIGRAM_COLUMN } = await import(
      '@open-mercato/shared/lib/search/trigramSql'
    )
    const { resolveSearchConfig } = await import('@open-mercato/shared/lib/search/config')
    const { listSearchTokenExcludedEntityTypes } = await import(
      '@open-mercato/core/modules/query_index/lib/search-entity-policy'
    )

    const config = resolveSearchConfig()
    if (!config.enabled) return []

    // The rows themselves stay in `search_tokens` — list routes and the query engines' encrypted
    // like/ilike rewrite depend on them — so the exclusion is enforced here, at read time.
    const excludedEntityTypes = listSearchTokenExcludedEntityTypes()
    const requestedEntityTypes = options.entityTypes?.length
      ? options.entityTypes.filter((entityType) => !excludedEntityTypes.includes(entityType))
      : undefined
    if (options.entityTypes?.length && !requestedEntityTypes?.length) return []

    const trigramQuery = buildTrigramQuery({ term: query, tenantId: options.tenantId })
    if (!trigramQuery) return []

    // The term's `text` shaping carries one containment group per word; a partial match is
    // "contains at least this share of them", which is the ratio the token path applied to whole
    // words. Every group of at least one shaping still has to be scored, so the per-group
    // predicates are counted rather than ANDed.
    const textShaping = trigramQuery.shapings.find((shaping) => shaping.kind === 'text')
      ?? trigramQuery.shapings[0]
    const groups = textShaping.groups
    const minMatches = Math.max(1, Math.ceil(groups.length * this.minMatchRatio))
    const limit = options.limit ?? this.defaultLimit

    const trgmColumn = sql`${sql.ref(`entity_indexes.${SEARCH_TRIGRAM_COLUMN}`)}`
    const matchCountExpr = sql<number>`(${sql.join(
      groups.map((group) => sql`(case when ${buildTrigramContainment(trgmColumn, {
        term: trigramQuery.term,
        shapings: [{ ...textShaping, groups: [group] }],
      })} then 1 else 0 end)`),
      sql` + `,
    )})`

    let queryBuilder = this.db
      .selectFrom('entity_indexes' as any)
      .select([
        'entity_type' as any,
        'entity_id' as any,
        'organization_id' as any,
        matchCountExpr.as('match_count'),
      ])
      .where(sql<SqlBool>`${trgmColumn} is not null`)
      .where('tenant_id' as any, '=', options.tenantId)
      .where('deleted_at' as any, 'is', null as any)
      .where(sql<SqlBool>`${matchCountExpr} >= ${minMatches}`)
      .orderBy(sql`${matchCountExpr} desc`)
      .limit(limit)

    if (organizationIds) {
      queryBuilder = queryBuilder.where('organization_id' as any, 'in', organizationIds)
    }

    if (requestedEntityTypes?.length) {
      queryBuilder = queryBuilder.where('entity_type' as any, 'in', requestedEntityTypes)
    } else if (excludedEntityTypes.length) {
      queryBuilder = queryBuilder.where('entity_type' as any, 'not in', excludedEntityTypes)
    }

    const rows = await queryBuilder.execute() as Array<{
      entity_type: string
      entity_id: string
      organization_id: string | null
      match_count: string | number
    }>

    return rows.map((row) => {
      const matchCount = typeof row.match_count === 'string'
        ? parseInt(row.match_count, 10)
        : row.match_count
      // Calculate score based on match ratio
      const score = matchCount / groups.length

      return {
        entityId: row.entity_type as EntityId,
        recordId: row.entity_id,
        score,
        source: this.id,
        organizationId: row.organization_id ?? null,
      }
    })
  }

  /**
   * The trigram set is a column on the projection row, written by `query_index`'s own indexer in
   * the same statement as the document. This strategy therefore no longer owns a write path — an
   * index call here would have to duplicate the projection write and could only diverge from it.
   *
   * `index`/`bulkIndex`/`delete`/`purge` stay as no-ops rather than being removed so the
   * `SearchStrategy` contract and this strategy's `SearchStrategyId` are unchanged.
   */
  async index(record: IndexableRecord): Promise<void> {
    void normalizeCustomFieldKeys(record.fields)
  }

  async delete(_entityId: EntityId, _recordId: string, _tenantId: string): Promise<void> {
    // Deleting the projection row deletes its trigram set; nothing to do here.
  }

  async bulkIndex(_records: IndexableRecord[]): Promise<void> {
    // See `index`.
  }

  async purge(_entityId: EntityId, _tenantId: string, _organizationId?: string | null): Promise<void> {
    // `query_index purge` removes the projection rows, and the trigram set with them.
  }
}
