# Declarative field-level UI editability (read-only fields/sections)

**Status:** draft
**Owner:** ui / shared
**Date:** 2026-07-09

## TLDR
Open Mercato has no clean way to mark a field, section or entity as **not
editable in the admin UI**. RBAC feature-gating does not reliably hide/disable
edit affordances, and a **superadmin bypasses every feature check**, so a
role-based approach cannot restrict a superadmin at all. Nulling write routes
blocks persistence but still lets the UI mount editors (bad UX); CSS-hiding
leaks because many core controls are clickable containers, not icon buttons.

This spec introduces a **declarative, role-independent** mechanism to mark
entity fields (or whole entities) read-only **in the UI** — a *display policy,
not a permission* — enforced even for a superadmin, and orthogonal to /
composable with RBAC.

## Config surface
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

## Resolution & data flow
- `packages/shared/src/lib/ui-read-only/policy.ts` — pure, framework-agnostic
  types + resolver (`createUiReadOnlyPolicy`, `mergeUiReadOnlyMaps`,
  `applyUiReadOnlyOverrideMap`). Shared by server and client.
- `packages/shared/src/lib/ui-read-only/resolve.ts` — server-only
  `resolveUiReadOnlyMap()` = module tier (from the module registry) with app
  overrides layered on top.
- The backend layout (server component) resolves the map and hands it to
  `UiReadOnlyPolicyProvider` (`@open-mercato/ui/backend/ui-read-only/context`).
  Editable primitives read it via `useUiReadOnly(entityId)`.

## Enforcement in UI primitives
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

## Optional server-side enforcement
The same declaration pairs with a built-in `MutationGuard`
(`createUiReadOnlyWriteGuard`) so a read-only field/entity both hides the UI
**and** rejects the write — defense-in-depth. It is registered for every app but
**inert unless enabled** via `OM_UI_READ_ONLY_ENFORCE_WRITES`
(`off` (default) | `all` | comma-separated entity ids). Whole-entity read-only
rejects create/update/delete; per-field read-only rejects only writes that touch
those fields. *(implemented)*

## Why upstream
OM has no "read-only backoffice" story — a framework gap. Generally useful for
view-only ops consoles, compliance, and records mastered by an external system
that must never be hand-edited (a manual edit would be overwritten on the next
sync). Replaces the app-side stopgaps (custom read-only pages, transport-level
write guard, leaky CSS) with clean per-field granularity.

## Status / rollout
- [x] Core policy + resolver (shared)
- [x] `uiReadOnly` override domain + module-manifest field
- [x] Client provider + `useUiReadOnly` hook
- [x] CrudForm display-only rendering + whole-entity footer/submit gating
- [x] Backend layout wiring (template + demo app)
- [x] DataTable suppression (create/"New", row actions, bulk actions, empty-state CTA)
- [x] Inline detail editors (customer person/company) via `DetailReadOnlyContext`
- [x] Optional server-side write guard (`OM_UI_READ_ONLY_ENFORCE_WRITES`)
- [ ] Sales document inline sections + heavily-bespoke pages (product edit)
- [ ] Annotate core DataTable edit row actions with `mutates: true` (drop the heuristic)
