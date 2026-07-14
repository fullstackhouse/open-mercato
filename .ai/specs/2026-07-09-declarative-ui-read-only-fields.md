# RBAC-driven UI read-only (+ declarative field-level overrides)

**Status:** draft
**Owner:** ui / shared
**Date:** 2026-07-09 (reframed 2026-07-14)

## TLDR
Removing a content `*.manage` feature from a role blocks the write API (`403`)
but the admin **UI still shows** every edit/create/delete affordance — RBAC
gates *data*, not the *UI*. So a role stripped to view-only still mounts editors
that fail on save: bad UX and a bug in OM.

The primary fix is **RBAC-driven**: an entity becomes whole-entity read-only in
the UI when the viewer lacks the write feature its CRUD mutation API already
requires (the `requireFeatures` on its `POST/PUT/DELETE`). The feature the write
API enforces is the single source of truth — the UI hides exactly the
affordances the caller cannot exercise.

A superadmin **bypasses every feature check**, so RBAC alone cannot restrict a
superadmin. For cases that need editability suppressed regardless of grants
(data mastered by an external system of record, per-field read-only, or a
view-only superadmin), a secondary **declarative, role-independent** layer marks
fields/sections/entities read-only in the UI as a *display policy, not a
permission*. Both layers resolve into the same `UiReadOnlyMap` and share the same
enforcement primitives.

## Two composable sources → one map
The backend layout merges two independently-resolved maps
(`mergeUiReadOnlyMaps`) and hands the result to the UI provider:

1. **RBAC-driven** (`packages/shared/src/lib/ui-read-only/rbac.ts`) —
   `resolveRbacReadOnlyMap(principal, { enforceForSuperAdmin })` returns
   whole-entity read-only (`['*']`) for every registered entity whose write
   feature the principal does not hold. A superadmin resolves to an empty map
   (fully editable) unless `enforceForSuperAdmin` is set (env
   `OM_UI_READ_ONLY_ENFORCE_SUPERADMIN`) — the knob for a view-only superadmin.
2. **Declarative** (`policy.ts` / `resolve.ts`) — per-entity, per-field or
   whole-entity read-only declared through the unified `modules.ts` override
   surface, independent of RBAC and enforced even for a superadmin.

### RBAC source: registry + deterministic manifest
The RBAC map is keyed by the write feature an entity's CRUD mutations require.
`makeCrudRoute` records this automatically for every factory-built route
(`registerCrudWriteFeatures(entityId, union(POST/PUT/DELETE.requireFeatures))`),
so there is **zero per-route wiring**.

That registry is populated *lazily* at route import, so a request-time
resolution is only as complete as the set of routes Next.js has loaded — a
determinism gap. It is closed by a generated manifest:

- `mercato generate` emits `.mercato/generated/crud-write-features.generated.ts`
  (`{ entityId: writeFeatures[] }`, sorted/deterministic). The snapshot is
  captured by the **OpenAPI generator's existing module-execution pass** — it
  already bundles and runs every route module (which populates the registry), so
  the manifest rides on that single pass with no second route bundle.
- `bootstrap.ts` seeds it up front (`seedCrudWriteFeatureRegistry`), so the
  registry is deterministically complete before the first resolution. Seeding is
  additive over the lazy registrations, so a stale/partial manifest can only
  under-populate, never mis-populate; on a static-fallback generate the manifest
  is empty and the lazy registrations remain the backstop.

### Declarative source: config surface
Read-only is declared per canonical entity id (`module:entity`), valued by a
list of field ids or the wildcard `'*'` (whole entity):

```ts
uiReadOnly: {
  'sales:sales_order': ['*'],                                   // whole entity
  'customers:customer_entity': ['first_name', 'primary_email'], // per-field
}
```

Two declaration tiers, resolved lowest → highest precedence:

1. **Module tier** — a module's own `uiReadOnly` manifest field (additive/union
   default across modules). Lets a module ship sensible read-only defaults.
2. **App tier** — `modules.ts` inline `overrides.uiReadOnly` (+ the programmatic
   `applyUiReadOnlyOverrides`). Applied on top with *replace* semantics; a
   `null` value **disables** a lower-tier declaration for that entity.

This reuses the existing unified `modules.ts` override surface — `uiReadOnly`
is registered as a first-class override domain alongside `interceptors`, `di`,
`encryption`, etc.

## Enforcement in UI primitives (shared by both sources)
For any read-only target: render the value **display-only, do not mount the
input**, and hide the edit toggle / add-row / delete affordances.

- **CrudForm** — per-field: policy-read-only fields render display-only (the
  input is never mounted, so it cannot be activated); whole-entity read-only
  additionally hides the footer Save/Delete and blocks submit. *(implemented)*
- **DataTable** — for a read-only entity: suppress the header create ("New")
  action slot, the row-actions menu items (delete via `destructive`, edit/other
  via the `mutates` flag or an id/href heuristic), all bulk actions, and the
  `ListEmptyState` create CTA. Wired through a `RowActionsReadOnlyContext` the
  table provides from the policy. *(implemented)*
- **Inline detail editors** (`@open-mercato/ui/backend/detail` — InlineText/
  Multiline/SelectEditor) — render display-only (no pencil trigger, no editor)
  when their own `readOnly` prop or the surrounding `DetailReadOnlyContext` is
  set. Detail pages (customer person/company) set the context from the policy.
  *(implemented)*
- **Known limitations** — heavily-bespoke pages that build their own inputs
  outside CrudForm / the shared inline editors (e.g. the catalog product edit
  page: media manager, variant builder, custom "Edit name" control) are not yet
  covered and must opt in per-section. *(follow-up)*

## Optional server-side enforcement (declarative source)
The declarative source pairs with a built-in `MutationGuard`
(`createUiReadOnlyWriteGuard`) so a read-only field/entity both hides the UI
**and** rejects the write — defense-in-depth. It is registered for every app but
**inert unless enabled** via `OM_UI_READ_ONLY_ENFORCE_WRITES`
(`off` (default) | `all` | comma-separated entity ids). Whole-entity read-only
rejects create/update/delete; per-field read-only rejects only writes that touch
those fields. *(implemented)*

The RBAC source needs no such guard: the write API it derives from is the guard
— the `requireFeatures` it reads already reject the mutation server-side.

## Why upstream
The RBAC-driven layer fixes a real bug: view-only roles see edit affordances
that 403 on save. The declarative layer adds a "read-only backoffice" story OM
otherwise lacks — useful for view-only ops consoles, compliance, and data synced
from an external system of record (e.g. contractors/products/orders synced from
an ERP that must never be hand-edited because a manual edit is overwritten on the
next sync). Together they replace the app-side stopgaps (custom read-only pages,
transport-level write guard, leaky CSS) with clean granularity.

## Status / rollout
- [x] Core policy + resolver (shared)
- [x] RBAC-driven source: registry (`registerCrudWriteFeatures` in `makeCrudRoute`) + `resolveRbacReadOnlyMap`
- [x] Deterministic manifest (`crud-write-features.generated.ts`) via the OpenAPI route-execution pass + bootstrap seeding
- [x] `enforceForSuperAdmin` knob (`OM_UI_READ_ONLY_ENFORCE_SUPERADMIN`)
- [x] Declarative `uiReadOnly` override domain + module-manifest field
- [x] Client provider + `useUiReadOnly` hook
- [x] CrudForm display-only rendering + whole-entity footer/submit gating
- [x] Backend layout wiring — merges RBAC + declarative maps (template + app)
- [x] DataTable suppression (create/"New", row actions, bulk actions, empty-state CTA)
- [x] Inline detail editors (customer person/company) via `DetailReadOnlyContext`
- [x] Optional server-side write guard for the declarative source (`OM_UI_READ_ONLY_ENFORCE_WRITES`)
- [ ] Sales document inline sections + heavily-bespoke pages (product edit)
- [ ] Annotate core DataTable edit row actions with `mutates: true` (drop the heuristic)
- [ ] First-class superadmin view-only ergonomics (beyond the env flag)
