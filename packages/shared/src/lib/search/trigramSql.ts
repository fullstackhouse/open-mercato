import { sql, type RawBuilder } from 'kysely'
import type { TrigramQuery } from './trigram'

export type TrigramOrganizationScope = { ids: string[]; includeNull: boolean }

export const SEARCH_TRIGRAM_COLUMN = 'search_trgm'

function arrayLiteral(hashes: readonly number[]): RawBuilder<unknown> {
  return sql`array[${sql.join(hashes.map((hash) => sql`${hash}`), sql`, `)}]::int4[]`
}

/**
 * `col @> ARRAY[…]` per group, ANDed within a shaping and ORed across shapings.
 *
 * Containment is what a GIN index over `int4[]` answers directly, which is the whole point of the
 * shape: one index probe per group, no join, no `GROUP BY … HAVING` per outer row.
 */
export function buildTrigramContainment(
  column: RawBuilder<unknown>,
  query: TrigramQuery,
): RawBuilder<boolean> {
  const shapings = query.shapings
    .map((shaping) => {
      const groups = shaping.groups.map((group) => sql<boolean>`${column} @> ${arrayLiteral(group)}`)
      if (!groups.length) return null
      if (groups.length === 1) return groups[0]
      return sql<boolean>`(${sql.join(groups, sql` and `)})`
    })
    .filter((part): part is RawBuilder<boolean> => part !== null)
  if (!shapings.length) return sql<boolean>`false`
  if (shapings.length === 1) return sql<boolean>`(${shapings[0]})`
  return sql<boolean>`(${sql.join(shapings, sql` or `)})`
}

export type TrigramSemiJoinOptions = {
  entityType: string
  /** Column holding the record id on the outer query, e.g. `b.id` or `ei.entity_id`. */
  recordIdColumn: string
  query: TrigramQuery
  tenantId?: string | null
  organizationScope?: TrigramOrganizationScope | null
  /** Alias for the `entity_indexes` row inside the sub-select; must be unique per statement. */
  alias: string
}

function organizationScopePredicate(
  column: RawBuilder<unknown>,
  scope: TrigramOrganizationScope,
): RawBuilder<boolean> {
  if (scope.ids.length === 0 && !scope.includeNull) return sql<boolean>`1 = 0`
  const parts: RawBuilder<boolean>[] = []
  if (scope.ids.length > 0) {
    parts.push(sql<boolean>`${column} in (${sql.join(scope.ids.map((id) => sql`${id}`), sql`, `)})`)
  }
  if (scope.includeNull) parts.push(sql<boolean>`${column} is null`)
  if (parts.length === 1) return parts[0]
  return sql<boolean>`(${sql.join(parts, sql` or `)})`
}

/**
 * A NON-correlated semi-join against the projection row's trigram column.
 *
 * Deliberately `IN (SELECT …)` rather than a correlated `EXISTS`: the sub-select is independent of
 * the outer row, so the planner can answer it once through the GIN index and hash-semi-join the
 * result, instead of re-probing per outer row the way the token path's
 * `EXISTS … GROUP BY … HAVING` did.
 *
 * `search_trgm IS NULL` rows are excluded rather than treated as empty: a null column means the
 * queued upgrade reindex has not reached that row yet, and "not searchable yet" is the honest
 * answer for it.
 */
export function buildTrigramSemiJoin(options: TrigramSemiJoinOptions): RawBuilder<boolean> {
  const alias = sql.ref(options.alias)
  const trgmColumn = sql`${sql.ref(`${options.alias}.${SEARCH_TRIGRAM_COLUMN}`)}`
  const conditions: RawBuilder<boolean>[] = [
    sql<boolean>`${sql.ref(`${options.alias}.entity_type`)} = ${options.entityType}`,
    sql<boolean>`${trgmColumn} is not null`,
    buildTrigramContainment(trgmColumn, options.query),
  ]
  if (options.tenantId !== undefined) {
    conditions.push(
      sql<boolean>`${sql.ref(`${options.alias}.tenant_id`)} is not distinct from ${options.tenantId ?? null}`,
    )
  }
  if (options.organizationScope) {
    conditions.push(
      organizationScopePredicate(
        sql`${sql.ref(`${options.alias}.organization_id`)}`,
        options.organizationScope,
      ),
    )
  }
  return sql<boolean>`(${sql.ref(options.recordIdColumn)})::text in (
    select ${sql.ref(`${options.alias}.entity_id`)}
    from "entity_indexes" as ${alias}
    where ${sql.join(conditions, sql` and `)}
  )`
}
