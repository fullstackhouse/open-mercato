/**
 * RBAC-driven UI read-only source.
 *
 * Derives a read-only map from RBAC: an entity is marked *whole-entity*
 * read-only in the admin UI when the current principal lacks the **write
 * feature that the entity's CRUD mutation API already requires** (the
 * `requireFeatures` on its POST/PUT/DELETE). That makes the feature the write
 * API enforces the single source of truth — the UI hides edit/create/delete
 * affordances for exactly the entities the caller cannot mutate, instead of
 * showing them and failing the save with a 403.
 *
 * The registry (`entity id -> write features`) is populated by `makeCrudRoute`
 * at route construction, so every factory-built CRUD surface participates
 * automatically. Output plugs straight into the same `UiReadOnlyMap` that the
 * `@open-mercato/ui` provider consumes.
 *
 * This is the whole-entity gate only. Per-field write-feature gating is
 * intentionally out of scope: the write feature the route already enforces is
 * the existing RBAC mechanism, so no new per-field feature surface is
 * introduced.
 */

import { hasAllFeatures } from '../../security/features'
import { UI_READ_ONLY_WHOLE_ENTITY, type UiReadOnlyMap } from './policy'

/** Snapshot of the entity id (`module:entity`) → write-feature ids map. */
export type CrudWriteFeatureRegistry = Record<string, readonly string[]>

const registry = new Map<string, string[]>()

function sanitizeFeatures(features: readonly string[] | undefined): string[] {
  if (!Array.isArray(features)) return []
  const out: string[] = []
  for (const f of features) {
    if (typeof f !== 'string') continue
    const trimmed = f.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/**
 * Register the write feature(s) that gate an entity's CRUD mutations. Called by
 * `makeCrudRoute`; idempotent and additive (a re-registration merges features).
 * No-ops when the entity id or feature list is empty (e.g. a read-only route).
 */
export function registerCrudWriteFeatures(
  entityId: unknown,
  features: readonly string[] | undefined,
): void {
  if (typeof entityId !== 'string') return
  const id = entityId.trim()
  if (!id) return
  const list = sanitizeFeatures(features)
  if (!list.length) return
  const existing = registry.get(id)
  if (existing) {
    for (const f of list) if (!existing.includes(f)) existing.push(f)
  } else {
    registry.set(id, list)
  }
}

/**
 * Bulk-seed the registry from a pre-computed manifest (`entity id -> write
 * features`), typically the `crud-write-features.generated` artifact emitted at
 * `mercato generate` by executing every route module. Called once at bootstrap
 * so the registry is *deterministically complete* before the first UI read-only
 * resolution — without it, resolution depends on which routes have been imported
 * (Next.js server bundles load routes lazily). Additive and idempotent: it
 * layers on top of any lazy `makeCrudRoute` registrations via
 * `registerCrudWriteFeatures`, so a stale or partial manifest can only
 * under-populate, never mis-populate. No-op on nullish input.
 */
export function seedCrudWriteFeatureRegistry(
  manifest: CrudWriteFeatureRegistry | null | undefined,
): void {
  if (!manifest || typeof manifest !== 'object') return
  for (const [entityId, features] of Object.entries(manifest)) {
    registerCrudWriteFeatures(entityId, features)
  }
}

/** Immutable snapshot of the process-wide registry. */
export function getCrudWriteFeatureRegistry(): CrudWriteFeatureRegistry {
  const out: Record<string, string[]> = {}
  for (const [id, features] of registry) out[id] = [...features]
  return out
}

/** Reset the registry — for tests/tooling only. */
export function clearCrudWriteFeatureRegistry(): void {
  registry.clear()
}

/** The principal fields the RBAC read-only resolution needs. */
export type RbacReadOnlyPrincipal = {
  /** Granted feature ids (wildcards like `catalog.*` supported). */
  features?: readonly string[] | null
  /** Superadmin bypasses every feature check. */
  isSuperAdmin?: boolean | null
}

export type ResolveRbacReadOnlyOptions = {
  /**
   * When true, a superadmin is ALSO subject to the read-only map — their
   * feature bypass is ignored for UI editability. Defaults to `false`, so a
   * superadmin keeps full edit access (matching server-side RBAC). This is the
   * knob for "make even superadmin view-only" without touching their grants.
   */
  enforceForSuperAdmin?: boolean
  /** Whole-entity registry override; defaults to the process registry. */
  registry?: CrudWriteFeatureRegistry
}

/**
 * Resolve the RBAC-driven read-only map for a principal. An entity is marked
 * *whole-entity* read-only (`['*']`) when the principal lacks the feature its
 * mutation API requires. A superadmin resolves to an empty map (fully editable)
 * unless `enforceForSuperAdmin` is set.
 */
export function resolveRbacReadOnlyMap(
  principal: RbacReadOnlyPrincipal | null | undefined,
  options: ResolveRbacReadOnlyOptions = {},
): UiReadOnlyMap {
  const isSuperAdmin = principal?.isSuperAdmin === true
  if (isSuperAdmin && !options.enforceForSuperAdmin) return {}
  const reg = options.registry ?? getCrudWriteFeatureRegistry()
  const granted = (principal?.features ?? []) as readonly string[]
  const map: Record<string, readonly string[]> = {}
  for (const [entityId, features] of Object.entries(reg)) {
    if (!features.length) continue
    if (!hasAllFeatures(granted, features)) {
      map[entityId] = [UI_READ_ONLY_WHOLE_ENTITY]
    }
  }
  return map
}
