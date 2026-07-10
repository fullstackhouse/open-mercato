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
- **DataTable** — suppress the edit/delete row actions and mutating bulk
  actions for a read-only entity. *(planned)*
- **Inline detail editors** (sales document sections, customer/product detail)
  — render display-only, hide the edit toggle, add-row and delete controls.
  *(planned)*

## Optional server-side enforcement
The same declaration can pair with a server-side write guard (via the existing
`MutationGuard` registry) so a read-only field/entity both hides the UI **and**
rejects the write — configurable, defense-in-depth. *(planned)*

## Why upstream
OM has no "read-only backoffice" story — a framework gap. Generally useful for
view-only ops consoles, compliance, and data synced from an external system of
record (e.g. contractors/products/orders synced from an ERP that must never be
hand-edited because a manual edit is overwritten on the next sync). Replaces the
app-side stopgaps (custom read-only pages, transport-level write guard, leaky
CSS) with clean per-field granularity.

## Status / rollout
- [x] Core policy + resolver (shared)
- [x] `uiReadOnly` override domain + module-manifest field
- [x] Client provider + `useUiReadOnly` hook
- [x] CrudForm display-only rendering + whole-entity footer/submit gating
- [x] Backend layout wiring (template + demo app)
- [ ] DataTable action suppression
- [ ] Inline detail editors (sales/customers/catalog)
- [ ] Optional server-side write guard
