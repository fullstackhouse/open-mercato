import { getSearchModuleConfigs } from '@open-mercato/shared/modules/search'
import { isSearchFieldBlocklisted, type SearchConfig } from './config'
import { isSearchFieldKind, type SearchFieldKind } from './trigram'

export function collectSearchTextValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry)
  }
  return out
}

/**
 * The default field selection: every string (or string-array) value of the index document that is
 * not an id, a timestamp, a scope column or blocklisted.
 *
 * Unchanged from the token writer's `shouldIndexField`, deliberately — it is what makes trigrams a
 * drop-in: every entity searchable today stays searchable, with better semantics.
 */
export function isSearchIndexableField(
  field: string,
  value: unknown,
  config: SearchConfig,
  entityType: string | null,
): boolean {
  if (typeof value !== 'string' && !Array.isArray(value)) return false
  const lower = field.toLowerCase()
  if (lower === 'id' || lower.endsWith('_id') || lower.endsWith('.id')) return false
  if (lower.endsWith('_at')) return false
  if (['created_at', 'updated_at', 'deleted_at', 'tenant_id', 'organization_id'].includes(lower)) return false
  if (isSearchFieldBlocklisted(field, entityType, config)) return false
  return collectSearchTextValues(value).some((text) => text.length > 0)
}

export type EntitySearchFieldPolicy = {
  /** Per-field kind; a field absent from the map is cleaned as `text`. */
  kinds: Record<string, SearchFieldKind>
  /** When the declaration replaces the default field selection instead of refining it. */
  replaceDefaults: boolean
}

const EMPTY_POLICY: EntitySearchFieldPolicy = { kinds: {}, replaceDefaults: false }

/**
 * The per-entity search-field declaration, read from the module `search.ts` configs the app
 * registers at bootstrap.
 *
 * Reading it from `@open-mercato/shared/modules/search` — not from `@open-mercato/search` — is
 * what keeps list search usable on installs that never enable the global-search package: the
 * registry lives in `shared` and is populated from `search.generated.ts` regardless.
 *
 * With no declaration the caller gets an empty policy, which means "today's field selection,
 * `text` semantics" — the drop-in default.
 */
export function resolveEntitySearchFieldPolicy(entityType: string): EntitySearchFieldPolicy {
  const configs = getSearchModuleConfigs()
  if (!configs.length) return EMPTY_POLICY
  const kinds: Record<string, SearchFieldKind> = {}
  let replaceDefaults = false
  let found = false
  for (const moduleConfig of configs) {
    for (const entity of moduleConfig.entities ?? []) {
      if (String(entity.entityId) !== entityType) continue
      const policy = entity.fieldPolicy
      if (!policy?.kinds) continue
      found = true
      if (policy.kindsReplaceDefaults === true) replaceDefaults = true
      for (const [field, kind] of Object.entries(policy.kinds)) {
        if (isSearchFieldKind(kind)) kinds[field] = kind
      }
    }
  }
  return found ? { kinds, replaceDefaults } : EMPTY_POLICY
}

/**
 * Which readings of a term apply to a named filter field.
 *
 * A declared field constrains the term to its own kind, so a `taxId` column never answers a
 * phone-shaped term. An undeclared field tries every shaping the term's own shape allows, which
 * is the "match wherever it can" behaviour a list search box wants.
 */
export function resolveTermKindsForField(
  entityType: string,
  field: string | null | undefined,
): SearchFieldKind[] | null {
  if (!field) return null
  const policy = resolveEntitySearchFieldPolicy(entityType)
  const kind = policy.kinds[field]
  return kind ? [kind] : null
}
