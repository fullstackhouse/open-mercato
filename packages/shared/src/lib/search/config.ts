import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import { parseNumberWithDefault } from '@open-mercato/shared/lib/number'
import { parseCommaSeparatedList } from '@open-mercato/shared/lib/string'
import { TRIGRAM_LENGTH } from './normalize'

export type SearchConfig = {
  enabled: boolean
  blocklistedFields: string[]
  entityBlocklistedFields?: Record<string, string[]>
  maxFieldChars?: number
  /**
   * Above this many trigram candidates the engine stops proving the result set exact: it
   * rechecks only the page it returns and reports the candidate count with
   * `meta.searchRecheckApproximate` (surfaced to clients as `totalIsApproximate`).
   */
  recheckMaxRows: number
}

export const DEFAULT_SEARCH_MAX_FIELD_CHARS = 20_000
export const DEFAULT_SEARCH_RECHECK_MAX_ROWS = 1_000

export type SearchFieldLimits = {
  maxFieldChars: number
}

const DEFAULT_BLOCKLIST = ['password', 'token', 'secret', 'hash']

const ENTITY_BLOCKLIST_SEPARATOR = '@'

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  return parseBooleanWithDefault(raw, fallback)
}

function parseNumber(raw: string | undefined, fallback: number, min = 1): number {
  return parseNumberWithDefault(raw, fallback, { integer: true, min })
}

export function resolveSearchFieldLimits(config: SearchConfig): SearchFieldLimits {
  const value = config.maxFieldChars
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return { maxFieldChars: DEFAULT_SEARCH_MAX_FIELD_CHARS }
  }
  return { maxFieldChars: Math.trunc(value) }
}

/**
 * Parses `OM_SEARCH_FIELD_BLOCKLIST` into a global list plus per-entity-type lists.
 *
 * Why: a deployment often needs to keep one large free-text column out of the token
 * index (e-mail bodies on `customers:customer_interaction`) while still indexing the
 * same-named column elsewhere. A flat global list cannot express that.
 *
 * How to apply: entries are comma-separated; an entry may carry an optional
 * `entityType@` prefix — `body` blocks the field everywhere, while
 * `customers:customer_interaction@body` blocks it only for that entity type. Entries
 * whose field part is empty are ignored so malformed env input cannot break indexing.
 */
function parseFieldBlocklist(raw: string | undefined): {
  global: string[]
  byEntity: Record<string, string[]>
} {
  const global: string[] = []
  const byEntity = new Map<string, string[]>()

  for (const rawEntry of parseCommaSeparatedList(raw)) {
    const entry = rawEntry.toLowerCase()
    const separatorIndex = entry.indexOf(ENTITY_BLOCKLIST_SEPARATOR)
    const entityType = separatorIndex >= 0 ? entry.slice(0, separatorIndex).trim() : ''
    const field = separatorIndex >= 0 ? entry.slice(separatorIndex + 1).trim() : entry
    if (!field.length) continue

    if (!entityType.length) {
      if (!global.includes(field)) global.push(field)
      continue
    }

    const scoped = byEntity.get(entityType) ?? []
    if (!scoped.includes(field)) scoped.push(field)
    byEntity.set(entityType, scoped)
  }

  for (const fallback of DEFAULT_BLOCKLIST) {
    if (!global.includes(fallback)) global.push(fallback)
  }

  const scopedBlocklist = Object.create(null) as Record<string, string[]>
  for (const [entityType, fields] of byEntity) scopedBlocklist[entityType] = fields

  return { global, byEntity: scopedBlocklist }
}

export function resolveSearchConfig(): SearchConfig {
  const blocklist = parseFieldBlocklist(process.env.OM_SEARCH_FIELD_BLOCKLIST)
  return {
    enabled: parseBoolean(process.env.OM_SEARCH_ENABLED, true),
    blocklistedFields: blocklist.global,
    entityBlocklistedFields: blocklist.byEntity,
    maxFieldChars: parseNumber(process.env.OM_SEARCH_MAX_FIELD_CHARS, DEFAULT_SEARCH_MAX_FIELD_CHARS, 0),
    recheckMaxRows: parseNumber(process.env.OM_SEARCH_RECHECK_MAX_ROWS, DEFAULT_SEARCH_RECHECK_MAX_ROWS, 0),
  }
}

/**
 * Single matcher for "should this field be kept out of the search index?".
 *
 * Why: the per-field token path and the `search_text` aggregate previously each
 * decided this on their own, and the aggregate simply never consulted the config —
 * so a blocklisted column's text came back into the index under the aggregate's
 * field name (#4624). Both paths now share this function so they cannot drift.
 *
 * How to apply: pass the document's field name and the entity type being indexed;
 * `entityType` may be omitted when unknown, in which case only global entries apply.
 * Matching keeps the historical substring semantics (`fieldName.includes(pattern)`).
 */
export function isSearchFieldBlocklisted(
  field: string,
  entityType: string | null | undefined,
  config: SearchConfig,
): boolean {
  const lower = field.toLowerCase()
  if (config.blocklistedFields.some((blocked) => lower.includes(blocked))) return true
  if (!entityType) return false
  const scoped = config.entityBlocklistedFields?.[entityType.trim().toLowerCase()]
  if (!Array.isArray(scoped) || !scoped.length) return false
  return scoped.some((blocked) => lower.includes(blocked))
}

/**
 * Browser-safe accessor for the shortest term list search can answer.
 *
 * A trigram is three characters, so the minimum is a constant rather than a knob — client
 * components (the global search dialog) gate the request on the same number the server uses.
 */
export function resolveSearchMinTokenLength(): number {
  return TRIGRAM_LENGTH
}
