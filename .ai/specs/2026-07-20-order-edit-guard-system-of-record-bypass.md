# System-of-Record Bypass for Order Edit-Status Guards

- **Date**: 2026-07-20
- **Status**: Implemented
- **Scope**: `packages/core` — sales module order/document-address update commands
- **Related**: [SPEC-018](implemented/SPEC-018-2026-02-05-safe-entity-flush.md) (`withAtomicFlush`, the pipeline these guards run in)

## Context

`sales.orders.update` (via `applyDocumentUpdate`) and the `sales.document-addresses.*`
commands (via `assertAddressEditable`) enforce two per-tenant status guards:

- `orderCustomerEditableStatuses` — statuses in which the order's customer may be changed
- `orderAddressEditableStatuses` — statuses in which the order's addresses may be changed

When a list is a non-null array that does not contain the order's current status (an empty
list `[]` blocks every status), the command rejects the write with `CrudHttpError(400)`
(`sales.orders.edit_customer_blocked` / `sales.orders.edit_addresses_blocked`). This is a
**human-UI concern**: it stops an operator from mutating fields that the order's lifecycle
status has frozen, and the order detail page mirrors it by locking the customer/address cards.

The problem: the guard lives in the *shared* order-update command, so it fires for **every**
caller of that command — including trusted server-side writers that are not operators. A
common case is an ERP/marketplace integration for which the external system is the
**system of record**: it must apply the source's truth to an order regardless of the order's
current status. With the customer/address lists locked down (e.g. `[]`, a frequent setup that
makes synced orders read-only for humans), such an integration's own `sales.orders.update`
calls die with "Editing the customer is blocked for this status."

Downstream, this forced integrations to carry a bespoke context flag plus a patch on
`@open-mercato/core` that short-circuits the guard — fragile across version bumps, and a
second mechanism fighting the first (one config unconditionally blocks; the integration
unconditionally bypasses).

## Decision

Make the bypass a first-class capability keyed on the **command context**, not a bespoke flag.

Reuse the existing `CommandRuntimeContext.systemActor` field (already used by
`feature_toggles` to let CLI/tenant-setup writes clear a super-admin-only guard). It is
documented as *"a trusted server-side invocation that runs without an authenticated end-user
actor … HTTP request paths MUST NOT set it."* When `ctx.systemActor === true`, the
customer/address status guards are skipped — the caller is a system-of-record writer, not an
operator.

`systemActor` was chosen over the also-available `auth == null` signal deliberately:
`auth == null` conflates *unauthenticated* with *system-of-record*, so a request path that
lost its actor (a bug/misconfig) would silently bypass the guard. `systemActor` is explicit,
opt-in, greppable, and — per its own contract — never set on HTTP paths, which always carry a
real `auth` actor. An interactive edit therefore stays fully subject to the guards.

This is additive and backwards compatible: callers that do not set `systemActor` (all HTTP
request paths, all existing command callers) behave exactly as before.

## Design

`packages/core/src/modules/sales/commands/documents.ts`

- `applyDocumentUpdate({ … })` gains an optional `ctx?: Pick<CommandRuntimeContext, 'systemActor'>`.
- `const systemWrite = ctx?.systemActor === true`. When `systemWrite`, the function skips both
  `guardStatus(...)` calls **and** the `loadSalesSettings(...)` read that backs them (the
  settings are only fetched to enforce the guards, so a system write does no extra query).
- `ctx` is threaded in from both callers of `applyDocumentUpdate`: `updateOrderCommand.execute`
  and `updateQuoteCommand.execute` (quotes never hit the `kind === "order"` guards, but the
  parameter is passed uniformly).

`packages/core/src/modules/sales/commands/documentAddresses.ts`

- `assertAddressEditable(em, params)` gains `params.systemActor?: boolean` and returns early
  when it is `true`, before loading settings.
- Threaded from the create / update / delete document-address commands as
  `systemActor: ctx.systemActor === true`.

### Security / permissions

- `systemActor` is a trusted server-side grant. Per its contract, HTTP route handlers never
  set it (they resolve a real `auth` actor), so this change cannot be triggered by an end user,
  authenticated or not. RBAC on the API routes (`sales.orders.manage`, `sales.settings.manage`)
  is unaffected.
- The guards remain fully in force for every interactive/HTTP write.

## Testing

- **Unit** — `packages/core/src/modules/sales/commands/__tests__/documents.edit-guard-system-actor.test.ts`:
  against locked (`[]`) settings, an interactive `sales.orders.update` (no `systemActor`) is
  rejected with the 400 customer/address-blocked error, while a `systemActor: true` write
  applies **and never reads the settings** (proving the short-circuit). Both the customer and
  the address guard are covered.
- **Integration (e2e)** — not applicable for the bypass by design: the capability is reachable
  only through a trusted, non-HTTP command context, and HTTP request paths must never set
  `systemActor`, so no browser/API flow can exercise it. The complementary human-facing block
  it does not affect is enforced at the same command boundary and is covered by the unit tests
  above; an HTTP test would additionally require globally mutating shared per-tenant sales
  settings (cross-spec pollution) for no signal beyond the unit coverage.
- `yarn typecheck` (packages/core) and the full sales command/API unit suites pass.

## Changelog

- **2026-07-20** — Initial spec + implementation: `systemActor`-keyed bypass of the
  customer/address edit-status guards in `applyDocumentUpdate` and `assertAddressEditable`,
  with unit coverage.
