# Nulled ACL Feature Overrides Act as a Runtime Deny-List

- Date: 2026-07-22
- Status: Implemented
- Scope: OSS — `@open-mercato/shared` (enabled-modules registry, module overrides), `@open-mercato/core` (auth `RbacService`)
- Related: `.ai/specs/implemented/2026-05-04-modules-ts-unified-overrides.md` (umbrella overrides spec), `.ai/specs/implemented/2026-04-30-ai-overrides-and-module-disable.md`

## Problem

`entry.overrides.acl.features: { '<feature-id>': null }` (and the programmatic
`applyAclFeatureOverrides`) removes a feature from the module registry's ACL
catalog. Before this change, that removal only affected **catalog surfaces**:
the role-management UI checkboxes, `setup.ts` / `sync-role-acls` seeding, and
docs. Runtime enforcement never consulted the registry for feature existence:

1. `hasAllFeatures(granted, required)` is a pure string match between the
   required feature id and the caller's grant strings. A removed feature id
   hardcoded at a call site (e.g. `sales.documents.number.edit` in the sales
   routes) was still satisfied by a wildcard grant such as `sales.*`.
2. Grants come from the database (`role_acls.features_json`), not the
   registry. `filterGrantsByEnabledModules()` filters at **module**
   granularity only, and `getOwningModuleId()` falls back to the feature-id
   prefix for ids unknown to the registry — so both wildcard grants and stale
   explicit grants for a removed feature survived filtering.
3. The super-admin branch of `RbacService.userHasAllFeatures` passed whenever
   the required feature's **owning module** was enabled — the prefix fallback
   again resolved a removed feature to its enabled module.

Net effect: nulling a feature read as "this feature does not exist in this
app", but every enforcement path disagreed. The override silently did not
deny anything.

## Decision

Treat feature ids overridden to `null` as a **deny-list at enforcement time**,
mirroring the existing disabled-modules handling (which already denies even
super admins):

- `@open-mercato/shared/security/enabledModulesRegistry` gains:
  - `getRemovedAclFeatureIds(): ReadonlySet<string>` — composed from
    `composeAclFeatureOverrides()` entries whose value is `null` (modules-tier
    and programmatic-tier, with the existing programmatic-over-modules
    precedence; a non-null replacement override is NOT removed).
  - `isAclFeatureRemoved(featureId): boolean` — membership check.
  - `filterGrantsByEnabledModules()` now drops **explicit** grants whose id is
    a removed feature, including when the module registry is unavailable
    (tests/CLI). Wildcard grants are left in place — the required-side check
    below is the authoritative gate.
- `RbacService` (core auth):
  - `userHasAllFeatures()` returns `false` when any required feature is
    removed — checked **before** the super-admin branch, so super admins are
    denied too.
  - `tenantHasFeature()` returns `false` for a removed feature.
  - `getGrantedFeatures()` filters explicit removed ids out of the returned
    grant list (wildcards pass through; consumers matching against a concrete
    required id go through `userHasAllFeatures` / feature-check for
    authoritative answers).
- `CustomerRbacService` (core customer_accounts, portal RBAC):
  - `userHasAllFeatures()` denies removed required features **before** the
    portal-admin branch, mirroring the backend super-admin handling. (Portal
    RBAC still has no module-level grant filtering — that pre-existing gap is
    orthogonal to this spec.)
- Removal-aware matcher variants:
  - Server-side (registry-backed, `security/enabledModulesRegistry`):
    `hasFeatureRespectingRemovals(granted, required)` /
    `hasAllFeaturesRespectingRemovals(granted, required)` — for authorization
    checks that compare a concrete required id against a raw grant array.
  - Isomorphic pure (`security/features`): `hasFeatureExcluding` /
    `hasAllFeaturesExcluding` take the removed ids as an explicit third
    argument — for client code holding `BackendChromePayload.removedFeatures`.
- Server-side in-handler sweep (all **authorization** checks migrated to the
  removal-aware helpers; sites with an `isSuperAdmin` bypass fold it in as
  `isSuperAdmin ? ['*'] : features` so super admins are denied removed
  features here too): dashboards routes (`layout`, `layout/[itemId]`,
  `widgets/catalog`, `roles/widgets`, `users/widgets`),
  `messages/lib/routeHelpers`, `entities/lib/entityAcl` (removed-feature check
  runs before the super-admin early return), `communication_channels/lib/access-control`,
  `customers/lib/visibilityFilter`, `inbox_ops/ai-tools`, `search/ai-tools`,
  `workflows/lib/activity-executor` (UPDATE_ENTITY command gate),
  `ai-assistant/lib/auth` (`hasRequiredFeatures` MCP per-tool gate),
  `staff/api/interceptors` (manage_all elevated-scope check),
  `auth/lib/grantChecks` (actors can no longer grant a removed feature),
  `notifications/lib/notificationRecipients` (removed-feature notifications
  route to nobody), and the backend layout `configs.manage` capability flag
  (`apps/mercato` + create-app template).
- Client chrome: `BackendChromePayload` gains an additive
  `removedFeatures: string[]` (built from `getRemovedAclFeatureIds()` in
  `resolveBackendChromePayload`, declared in the admin-nav response schema).
  Client call sites that match concrete ids against chrome grants use
  `hasFeatureExcluding`/`hasAllFeaturesExcluding` with it: `ProgressTopBar`,
  `UpgradeActionBanner`, `useInjectedMenuItems`, customers `RolesSection` /
  `useDealsAccess`, and `BackendHeaderChrome` (app + template).
- Portal nav: `buildPortalNav` accepts `removedFeatures` and drops routes
  requiring a removed feature even for portal admins; the portal nav API
  passes the set from the registry.

### Deliberately NOT deny-aware

1. **The pure matchers (`hasFeature`/`hasAllFeatures`) stay removal-blind.**
   They also gate **activation** of interceptors
   (`command-interceptor-runner`, `interceptor-runner`), mutation guards
   (`mutation-guard-registry`), response enrichers, and component overrides.
   At those sites `features` means "this component applies when the user holds
   the feature" — globally denying removed ids would silently *deactivate*
   security-enforcing components, failing open instead of closed. The
   removal-aware variants are opt-in per call site for authorization semantics
   only.
2. **`ai-api-operation-runner` tool-vs-route coverage check.** That
   `hasAllFeatures(toolFeatures, routeFeatures)` compares a tool's static
   feature contract against a route's requirements, not a live user's grants;
   the live-user gate happens at route execution through `RbacService`.
3. **Portal AI-assistant trigger widget.** It reads context-hydrated
   `resolvedFeatures` (PortalContext/JWT), so a portal wildcard grant can
   still show the trigger; the portal AI endpoints enforce through
   `CustomerRbacService`, so it fails closed server-side. Threading
   `removedFeatures` through the portal profile payload/JWT is possible
   follow-up polish.
4. **Client surfaces backed by `/api/auth/feature-check` or the portal
   feature-check endpoint** (attachment library, component-override provider,
   message detail widgets, portal menu/dashboard hooks) needed no change —
   they were already server-authoritative and became deny-aware through
   `userHasAllFeatures`.

### End-to-end verification (2026-07-22)

Performed against a live app (`yarn dev:app`, fresh Postgres, tenant seeded
via `mercato auth setup`) with `dashboards.configure` nulled through
`entry.overrides.acl.features` in `apps/mercato/src/modules.ts`, exercised as
a **super admin** whose role also carries the `dashboards.*` wildcard:

| Probe | Result |
|-------|--------|
| `POST /api/auth/feature-check {dashboards.configure}` | `{ok: false, granted: []}` — denied despite super admin + wildcard |
| `POST /api/auth/feature-check {dashboards.view}` | `{ok: true}` — sibling unaffected |
| `GET /api/dashboards/layout` | `canConfigure: false` — migrated in-handler capability flag |
| `PUT /api/dashboards/layout` | HTTP 403 `requiredFeatures: [dashboards.configure]` — migrated in-handler write gate |
| `GET /api/auth/admin/nav` | `removedFeatures: ['dashboards.configure']`, grants still `dashboards.*` — client chrome deny-list delivered |

## Migration & Backward Compatibility

- No contract surface is removed or renamed; `enabledModulesRegistry` gains
  two additive exports.
- Behavior change (intended, fail-closed): downstream apps that null an ACL
  feature now actually deny it at runtime for all users, including super
  admins and holders of wildcard or stale explicit grants. Apps that nulled a
  feature merely to hide the role-management checkbox while still relying on
  wildcard grants to permit the action must replace the `null` override with a
  replacement entry (e.g. `{ id: '<feature-id>' }`) or remove the override.
- A stale `null` override targeting a feature id no module declares still
  denies that id (and bootstrap logs the existing stale-override warning) —
  consistent with "this feature does not exist here".
- No DB migration: stale explicit grants persisted in `role_acls` /
  `user_acls` become inert instead of being rewritten.

## Test Coverage

- `packages/shared/src/security/__tests__/enabledModulesRegistry.test.ts` —
  removed-id reporting, replacement-override non-removal, explicit-grant
  filtering with and without a populated module registry.
- `packages/core/src/modules/auth/services/__tests__/rbacService.test.ts` —
  wildcard-grant denial, stale-explicit-grant denial, super-admin denial,
  `tenantHasFeature` denial, `getGrantedFeatures` filtering.
- `packages/core/src/modules/customer_accounts/services/__tests__/customerRbacService.test.ts` —
  portal wildcard-grant denial and portal-admin denial.

Integration coverage: enforcement is fully covered at the unit level against
the real override store; no HTTP-level flow changes (guards already route
through `userHasAllFeatures`).

## Changelog

- 2026-07-22: Implemented deny-list enforcement for nulled ACL feature
  overrides across `enabledModulesRegistry` and `RbacService`.
- 2026-07-22: Extended the deny-list to portal `CustomerRbacService` and
  replaced the "Known limitation" note with a triage of the residual
  grant-side gaps (client cosmetic, in-handler fine-grained checks) and the
  fail-open rationale for keeping the shared matcher deny-unaware.
- 2026-07-22: Closed the triaged gaps: added removal-aware matcher variants
  (registry-backed server helpers + pure `*Excluding` client helpers), swept
  all ~16 server in-handler authorization checks, shipped
  `BackendChromePayload.removedFeatures` + client chrome updates, made
  `buildPortalNav` removal-aware, and verified end-to-end against a live app
  (super admin + wildcard grant denied at every layer). Activation-gating
  call sites intentionally remain on the pure matchers.
