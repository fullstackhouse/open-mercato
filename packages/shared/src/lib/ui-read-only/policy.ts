/**
 * UI read-only policy engine (pure, framework-agnostic).
 *
 * A UI-read-only policy marks a whole entity — or specific fields — as
 * non-editable in the admin UI. This module is the pure map/policy engine that
 * both the server (resolution) and the client (`@open-mercato/ui` provider/hook
 * that CrudForm, DataTable and the inline detail editors read) consume.
 *
 * Entities are addressed by their canonical `module:entity` id
 * (e.g. `sales:sales_order`, `customers:customer_entity`). The value is a list
 * of read-only field ids, or the single wildcard `'*'` meaning the whole entity
 * is read-only in the UI.
 *
 * In this build the sole producer of the map is RBAC (`./rbac`): an entity is
 * whole-entity read-only when the viewer lacks the write feature its mutation
 * API already requires. The engine itself stays generic so other producers can
 * plug in later.
 */

/** Wildcard field id meaning "the whole entity is read-only in the UI". */
export const UI_READ_ONLY_WHOLE_ENTITY = '*'

/** Read-only field ids for an entity; `['*']` marks the whole entity. */
export type UiReadOnlyFields = readonly string[]

/** Map of canonical entity id (`module:entity`) → read-only field ids. */
export type UiReadOnlyMap = Record<string, UiReadOnlyFields>

/**
 * Override-tier value for a single entity: a field list, or `null` to
 * *disable* (remove) a read-only declaration inherited from a lower tier.
 */
export type UiReadOnlyOverride = UiReadOnlyFields | null

/** Override-tier map keyed by entity id. */
export type UiReadOnlyOverrideMap = Record<string, UiReadOnlyOverride>

/**
 * A resolved, queryable read-only policy. Cheap to build and immutable;
 * safe to serialize the underlying `map` across the server → client
 * boundary and rebuild a policy on the client.
 */
export interface UiReadOnlyPolicy {
  /** The resolved map (already merged across tiers, normalized). */
  readonly map: UiReadOnlyMap
  /** True when the entity has ANY read-only declaration (field or whole). */
  hasEntity(entityId: string | null | undefined): boolean
  /** True when the WHOLE entity is read-only (declared `'*'`). */
  isEntityReadOnly(entityId: string | null | undefined): boolean
  /** True when a specific field is read-only (or the whole entity is). */
  isFieldReadOnly(entityId: string | null | undefined, field: string | null | undefined): boolean
  /** Read-only field ids for an entity (`['*']` when whole-entity). */
  readOnlyFields(entityId: string | null | undefined): UiReadOnlyFields
}

function normalizeFields(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
  }
  return out.length ? out : null
}

function foldFields(existing: readonly string[] | undefined, next: readonly string[]): string[] {
  // `'*'` (whole entity) subsumes any explicit field list.
  const set = new Set(existing ?? [])
  for (const f of next) set.add(f)
  if (set.has(UI_READ_ONLY_WHOLE_ENTITY)) return [UI_READ_ONLY_WHOLE_ENTITY]
  return Array.from(set)
}

/**
 * Normalize a raw declaration map: trims entity ids, drops malformed/empty
 * entries, dedupes field ids and collapses `'*'` to the sole entry.
 */
export function normalizeUiReadOnlyMap(
  raw: Record<string, unknown> | null | undefined,
): UiReadOnlyMap {
  const out: Record<string, string[]> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [rawKey, rawVal] of Object.entries(raw)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) continue
    const fields = normalizeFields(rawVal)
    if (!fields) continue
    out[key] = foldFields(out[key], fields)
  }
  return out
}

/**
 * Merge read-only declaration maps in ascending precedence order (earlier
 * args are lower precedence). Read-only is an *additive restriction*, so
 * fields union across tiers and `'*'` dominates. Use
 * {@link applyUiReadOnlyOverrideMap} when a tier needs `null`-to-disable
 * semantics.
 */
export function mergeUiReadOnlyMaps(
  ...maps: Array<UiReadOnlyMap | null | undefined>
): UiReadOnlyMap {
  const out: Record<string, string[]> = {}
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue
    for (const [entity, fields] of Object.entries(normalizeUiReadOnlyMap(map))) {
      out[entity] = foldFields(out[entity], fields)
    }
  }
  return out
}

/**
 * Apply an override-tier map on top of a base map. An array value
 * *replaces* the entity's read-only fields; `null` *disables* (removes)
 * the base declaration for that entity.
 */
export function applyUiReadOnlyOverrideMap(
  base: UiReadOnlyMap | null | undefined,
  overrides: UiReadOnlyOverrideMap | null | undefined,
): UiReadOnlyMap {
  const out: Record<string, string[]> = {}
  const normalizedBase = normalizeUiReadOnlyMap(base as Record<string, unknown>)
  for (const [entity, fields] of Object.entries(normalizedBase)) out[entity] = Array.from(fields)
  if (overrides && typeof overrides === 'object') {
    for (const [rawKey, value] of Object.entries(overrides)) {
      const key = typeof rawKey === 'string' ? rawKey.trim() : ''
      if (!key) continue
      if (value === null) {
        delete out[key]
        continue
      }
      const fields = normalizeFields(value)
      if (!fields) continue
      out[key] = foldFields(undefined, fields)
    }
  }
  return out
}

/** Build a queryable {@link UiReadOnlyPolicy} from a resolved map. */
export function createUiReadOnlyPolicy(
  map: UiReadOnlyMap | null | undefined,
): UiReadOnlyPolicy {
  const resolved = normalizeUiReadOnlyMap(map as Record<string, unknown>)
  const whole = new Set<string>()
  const fieldsByEntity = new Map<string, Set<string>>()
  for (const [entity, fields] of Object.entries(resolved)) {
    if (fields.includes(UI_READ_ONLY_WHOLE_ENTITY)) {
      whole.add(entity)
    } else {
      fieldsByEntity.set(entity, new Set(fields))
    }
  }
  return {
    map: resolved,
    hasEntity(entityId) {
      if (!entityId) return false
      return whole.has(entityId) || fieldsByEntity.has(entityId)
    },
    isEntityReadOnly(entityId) {
      if (!entityId) return false
      return whole.has(entityId)
    },
    isFieldReadOnly(entityId, field) {
      if (!entityId || !field) return false
      if (whole.has(entityId)) return true
      const set = fieldsByEntity.get(entityId)
      return set ? set.has(field) : false
    },
    readOnlyFields(entityId) {
      if (!entityId) return []
      if (whole.has(entityId)) return [UI_READ_ONLY_WHOLE_ENTITY]
      const set = fieldsByEntity.get(entityId)
      return set ? Array.from(set) : []
    },
  }
}

/** Shared empty policy (no entity is read-only). */
export const EMPTY_UI_READ_ONLY_POLICY: UiReadOnlyPolicy = createUiReadOnlyPolicy({})
