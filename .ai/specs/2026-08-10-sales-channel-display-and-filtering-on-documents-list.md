# Sales channel on the documents list — resolved names and multi-value filtering

Status: draft
Scope: `packages/core/src/modules/sales/{api/documents/factory.ts,api/channels/route.ts,components/documents/SalesDocumentsTable.tsx,i18n/*.json}`
Upstream: **§2 of this spec is in flight as [open-mercato#5198](https://github.com/open-mercato/open-mercato/pull/5198)** (open, targets `develop`) — see § Relationship to #5198. No other issue or PR found (searched open + closed for a channel column/filter on the orders list on 2026-08-10; every open `channel` issue belongs to `communication_channels`/`channel-discord`). Related, not overlapping: [#668](https://github.com/open-mercato/open-mercato/issues/668) channel-specific product projections.

All line numbers verified on fork `main` @ `bdf361155` (2026-08-10), i.e. **before** #5198. That PR
adds 2 lines to `listSchema` and 8 to `buildFilters`, so citations below `factory.ts:90` shift by
roughly +10 once it merges.

## TLDR

The sales-documents list API returns a bare `channelId` uuid and offers **single-value** filtering
only. The orders/quotes table already renders a Channel column and a Channel filter, but it does so
by fetching the **first 50** channels from `/api/sales/channels` and joining client-side — so on a
tenant with more than 50 channels the column silently degrades to raw uuids, and on any role that
holds `sales.orders.view` without `sales.channels.manage` the fetch 403s and the filter is empty.

Three changes close the four defects enumerated below:

1. **Server-side name resolution** — `channelName` / `channelCode` on every list item, batched in one
   query per page, composed into the documents factory's existing `afterList` hook alongside
   `attachTags` (closes defects 1–3).
2. **Multi-value filtering** — a `channelIds` comma-separated parameter (`$in`), plus `channelIdsEmpty`
   for unassigned documents. `channelId` keeps working unchanged (closes defect 4). **Carved out and
   shipped separately as upstream #5198**; this spec keeps the design rationale and defers the
   implementation to that PR.
3. **ACL correction** — `GET /api/sales/channels` requires `sales.channels.manage`, which no role
   needs in order to *read* a channel name. It drops to `sales.channels.view`, the feature
   `sales.orders.view` already depends on (independently closes defect 3 for direct callers of that
   endpoint).

No database change and no new UI primitive. Every API change is additive: existing fields and
parameters keep their shape and meaning, and the one permission change is a widening — callers that
succeed today still succeed, and callers that got a 403 without `sales.channels.manage` now get a
response.

## Overview

Open Mercato models sales channels as a first-class concept — the `SalesChannel` entity, admin CRUD
at `/backend/sales/channels`, per-document assignment on the detail form, a `sales_channels_enabled`
feature toggle. The one place the concept doesn't carry its own weight is the documents list: the
API hands out an identifier and expects the consumer to find a name for it.

The current UI works around that client-side. This spec moves the resolution to the server, where
the set of channels on a page is small and bounded, and makes the filter accept the set of channels
a user actually wants to compare.

## Problem Statement

### Verified source sites

`packages/core/src/modules/sales/api/documents/factory.ts` (shared by `api/orders/route.ts` and
`api/quotes/route.ts` through `buildDocumentCrudOptions`)

| line | what |
|---|---|
| 81 | `listSchema` — `channelId: z.string().uuid().optional()`, the only channel input |
| 110–111 | `buildFilters` — `filters.channel_id = { $eq: query.channelId }`, single value |
| 314 | `channel_id` is in `commonFields`, so the column is selected on every list request |
| 422 | `transformItem` — `channelId: item.channel_id ?? null`, the raw uuid and nothing else |
| 587 | OpenAPI `documentSchema` — `channelId: z.string().uuid().nullable()` |

`packages/core/src/modules/sales/components/documents/SalesDocumentsTable.tsx`

| line | what |
|---|---|
| 178–197 | `fetchChannelOptions` — `GET /api/sales/channels?page=1&pageSize=50`; returns `[]` on any non-ok response |
| 305–311 | the Channel filter — `type: 'select'`, single value |
| 380–381 | `const channelId = typeof filterValues.channelId === 'string' ? … ; params.set('channelId', channelId)` |
| 620–631 | the Channel column — `channelOptions.find((opt) => opt.value === channelId)`, falling back to rendering the raw uuid |

`packages/core/src/modules/sales/api/channels/route.ts:41` — `GET: { requireFeatures: ['sales.channels.manage'] }`.

`packages/core/src/modules/sales/acl.ts` — `sales.channels.view` is declared (`:103`) and is a
dependency of both `sales.orders.view` (`:7`) and `sales.quotes.view` (`:43`), but **guards nothing**:
no route or page references it. `sales.channels.manage` `dependsOn: ['sales.channels.view']` (`:105–108`).

### The four defects

**1. The list can't render what it returns.** `channelId` is emitted with nothing to resolve it
from. Every consumer of the orders list has to solve this again — a second request and a client-side
join, or a response interceptor. The in-repo UI chose the second request, which is why the next two
defects exist as *its* bugs rather than the API's.

**2. The client-side join is bounded by one page of options.** `fetchChannelOptions` asks for
`pageSize=50`. A tenant with more than 50 channels — a marketplace integration creates one per
storefront — gets raw uuids in the Channel column for every channel outside that page, with no
error and no indication anything is missing. The same 50-row window is the entire filter dropdown.

**3. The join fails closed on a legitimate role.** `sales.orders.view` pulls in `sales.channels.view`
(acl.ts:7), but the channels list API requires `sales.channels.manage`. A least-privilege role that
grants order viewing without channel administration gets a 403, `fetchChannelOptions` swallows it
(`if (!call.ok) return []`), and the user sees an empty Channel filter and a column full of uuids.
The seeded `admin` and `employee` roles both hold `manage` (`setup.ts:53–54`), so this is invisible
in a default install and hits exactly the custom roles a real deployment builds.

**4. The filter can't express the question people ask.** `$eq` answers "orders from the web shop".
It cannot answer "orders from the web shop **and** the marketplace listing", which is the normal
comparison when a merchant runs several storefronts. Any consumer that needs it has to keep a
private override — which defeats the point of the filter being upstream at all.

## Proposed Solution

### 1. Resolve the name server-side, in `afterList`

Add `channelName: string | null` and `channelCode: string | null` to each list item, resolved in one
batched query per page.

The mechanism already exists, and the closest precedent is in this very file: `attachTags`
(`factory.ts:214–260`) is a batched post-list resolution with exactly this shape — collect ids from
the page, one scoped `em.find`, group, assign back onto the items. `enrichShipmentListResponse`
(`api/shipments/route.ts:56`, wired at `:311`, unit coverage at
`api/__tests__/shipments.afterList.test.ts`) does the same for `shipping_method_name` and
`status_label` and is the model for the test.

```ts
// packages/core/src/modules/sales/api/documents/factory.ts
const attachChannelNames = async (payload: any, ctx: any) => {
  const items = Array.isArray(payload?.items) ? (payload.items as Array<Record<string, any>>) : []
  if (!items.length) return
  const channelIds = Array.from(new Set(
    items
      .map((item) => (item && typeof item.channelId === 'string' ? item.channelId : null))
      .filter((value): value is string => !!value)
  ))
  if (!channelIds.length) return
  const em = ctx?.container?.resolve ? (ctx.container.resolve('em') as EntityManager) : null
  if (!em) return

  // Same scoping predicate as attachTags (factory.ts:224-234): tenant, plus the
  // request's organization scope — the SET of orgs, not ctx.auth.orgId, so a
  // multi-org scope selection does not blank the names of documents outside the
  // primary org.
  const where: Record<string, unknown> = { id: { $in: channelIds } }
  if (ctx?.auth?.tenantId) where.tenantId = ctx.auth.tenantId
  const orgIds =
    Array.isArray(ctx?.organizationIds) && ctx.organizationIds.length
      ? ctx.organizationIds.filter((val: string | null) => !!val)
      : ctx?.selectedOrganizationId
        ? [ctx.selectedOrganizationId]
        : []
  if (orgIds.length) where.organizationId = { $in: orgIds }

  const byId = new Map((await em.find(SalesChannel, where)).map((channel) => [channel.id, channel]))
  items.forEach((item) => {
    if (!item || typeof item.channelId !== 'string') return
    const channel = byId.get(item.channelId)
    item.channelName = channel?.name ?? null
    item.channelCode = channel?.code ?? null
  })
}
```

**Composition, not replacement.** `buildDocumentCrudOptions` **already declares** `hooks.afterList`
(`factory.ts:513–556`): it runs `attachTags` on every list response, and on a single-item order
response it runs `recalculateOrderTotalsForDisplay` on a forked `EntityManager`. Assigning a new
`afterList` would silently drop both — tags would vanish from the list and single-order totals would
stop being recalculated. The new step is appended inside the existing hook:

```ts
hooks: {
  afterList: async (payload: any, ctx: CrudCtx) => {
    await attachTags(payload, { ...ctx, bindingKind: binding.kind })
    await attachChannelNames(payload, ctx)
    if (binding.kind === 'order' && …) { /* unchanged display-totals recalculation */ }
  },
},
```

`attachTags` and `attachChannelNames` touch disjoint fields and share no state, so they may run
concurrently under `Promise.all` if the second query is ever worth overlapping; the sequential form
above is the default because both are single indexed lookups. One hook covers orders and quotes
together, since both routes are built from this config.

Four properties make `afterList` the right seam rather than `transformItem`:

- **One query per page, never N+1.** The distinct channel ids on a page of ≤100 documents is a tiny
  bounded set; in practice a handful.
- **No stale names.** The CRUD list cache tags a stored payload from `resourceTargets` only
  (`packages/shared/src/lib/crud/factory.ts:1489–1512`) — the document entity. Renaming a channel
  would not invalidate a cached orders page. `afterList` runs on the **cache-hit** path too
  (`factory.ts:1614`, alongside `:1859` and `:2040` on the miss path), so names are resolved against
  live data on every response and no name is ever embedded in a shared cache entry.
- **Exports inherit it.** The export paths call `afterList` as well (`factory.ts:1821`, `:2022`), so
  CSV/XLSX exports of the orders list carry the channel name. *Verify during implementation that the
  export column mapping picks up the field; enricher-namespaced fields are stripped from exports
  (`factory.ts:395`) but `afterList` output is not namespaced.*
- **Zero cost when unused.** No channel ids on the page → no query. Documents with a null
  `channel_id` are untouched.

The tenant + organization predicate is defence in depth: the ids already arrive on tenant- and
org-scoped documents, but the lookup states its own scope rather than inheriting one, and
`SalesChannel` is org-scoped in its own right (`organizationId` is non-nullable; the channels CRUD
route declares `orgField: 'organizationId'`). A channel outside the request's scope resolves to
`channelName: null` rather than leaking a name — the same failure mode as a deleted channel, which
the UI already handles. `SalesChannel.name` is not encrypted, so a plain `em.find` is correct here;
`findWithDecryption` is not needed.

**Rejected alternative — a `channels` lookup map beside `items`.** It avoids repeating a name across
rows, but it breaks the flat-item contract that `DataTable`, the export path, and the OpenAPI item
schema all assume, and it forces every consumer to implement the join the flat field removes. The
per-page duplication it saves is a few hundred bytes.

### 2. `channelIds` — multi-value filtering → upstream #5198

**Implemented in [open-mercato#5198](https://github.com/open-mercato/open-mercato/pull/5198)**, which
carves this section out and ships it on its own: two optional params on `listSchema`, eight lines in
`buildFilters`, and 11 unit cases in `documents.factory.test.ts`. This spec keeps the rationale; the
code lives there.

The semantics it implements are the ones specified here:

- **Comma-separated `channelIds`, not repeated params.** Matches `catalog/products`
  (`api/products/route.ts:70`, `:190`) and the platform-wide `ids` parameter from SPEC-042, which
  exists because `makeCrudRoute` parses the query with `Object.fromEntries(searchParams.entries())`.
- **Singular wins over plural.** `api/channels/route.ts:76–81` already resolves `id` before `ids` the
  same way. Documented, not incidental.
- **Non-uuid entries are dropped, not rejected** — a malformed value narrows the filter rather than
  400-ing a list page, and an all-malformed list narrows to *no* channel filter rather than an
  empty-set filter, so a typo returns the unfiltered page instead of silently returning zero rows.
- **`$exists: false` for unassigned.** That is the operator the advanced-filter builder emits for
  `is_empty` (`packages/shared/src/lib/query/advanced-filter-tree.ts:122`) and it is in `WhereOps`
  (`packages/shared/src/lib/query/types.ts:36`). Deliberately *not* modelled on the sibling
  `tagIdsEmpty` (`factory.ts:148–149`), which forces a sentinel uuid to return an empty result set —
  a different, narrower meaning.

**One improvement over what this spec originally proposed.** The draft called for a local
`parseIdList` in the shape of `api/channels/route.ts:66` — a fourth copy of the same uuid regex.
#5198 uses the shared `parseIdsParam` from `@open-mercato/shared/lib/crud/ids` instead, which
validates, trims, dedupes, and caps at `MAX_IDS_PER_REQUEST` (200). That is the better call and this
spec adopts it. The cap is worth knowing about: `parseIdsParam` **silently truncates** past 200 ids
(`ids.ts:49`, `.slice(0, safeMax)`). Irrelevant for a channel picker — no operator selects 200
channels — but it is a silent narrowing, not an error, and any future caller generating channel id
lists programmatically should know the ceiling exists.

`channelId` is untouched; per `BACKWARD_COMPATIBILITY.md` this is an additive API-route change.

### 3. `GET /api/sales/channels` requires `sales.channels.view`

```ts
GET: { requireAuth: true, requireFeatures: ['sales.channels.view'] },
// POST / PUT / DELETE keep sales.channels.manage
```

This is a **widening** — `sales.channels.manage` `dependsOn` `sales.channels.view`, so every role
that can call the endpoint today still can. It makes the `sales.orders.view → sales.channels.view`
dependency (acl.ts:7) mean what it says, and it gives `sales.channels.view` its first actual guard.
The backend page `backend/sales/channels/page.meta.ts:6` keeps `manage`: reading names through the
API is not the same as reaching the admin CRUD screen.

Exposure this creates: a user who can read an order can read the name and code of the channel it
belongs to. That is already the intent of the ACL dependency, and it is the minimum required for the
Channel column to be meaningful.

### 4. UI — render the resolved name, filter on a set

`SalesDocumentsTable.tsx`:

- **Column** (`:620–631`) renders `row.original.channelName ?? row.original.channelId`, with the
  existing `Unassigned` label for a null `channelId`. The uuid stays only as the degenerate fallback
  for a channel deleted between write and read. `channelOptions` is no longer on the column's
  dependency list.
- **Filter** (`:305–311`) becomes `type: 'tags'` with `formatValue`, mirroring the neighbouring
  `tagIds` and `customerId` filters (`FilterDef` supports it — `packages/ui/src/backend/FilterOverlay.tsx:23–35`).
- **Query building** (`:380–381`) emits `channelIds` from the selected array. **Depends on #5198** —
  see § Relationship to #5198; shipping this ahead of it produces a filter that silently does nothing.
- **Persisted-perspective compatibility.** `DataTable` persists `filterValues` into the perspective
  snapshot (`packages/ui/src/backend/DataTable.tsx:1739–1746`). A snapshot saved before this change
  holds `channelId: "<uuid>"` as a **string**; the new reader must normalise `string → [string]` so a
  saved perspective keeps filtering instead of silently clearing. This is the one real
  backward-compat trap in the UI half.
- **Feature toggle.** Everything channel-related stays behind `useSalesChannelsEnabled` (`:150`,
  `:305`, `:620`), unchanged and fail-open. The server-side resolution deliberately does **not**
  consult `isSalesChannelsEnabledForTenant`: that would add a container resolve and a toggle lookup
  to the hot list path to save a query that is already skipped whenever no document on the page has
  a channel.
- **i18n.** Existing keys `sales.documents.list.filters.channel` and
  `sales.documents.list.table.channel` are reused (present in all four locales at `i18n/*.json:1033`
  and `:1049`). One new key for the multi-select placeholder, added to `en/de/es/pl`.

The column stays visible by default when channels are enabled, as today. Users who don't want it hide
it through the existing `DataTable` column-visibility control, which persists into perspectives — no
new mechanism needed, and no change to what an existing user sees.

## API Contract

`GET /api/sales/orders`, `GET /api/sales/quotes`

| parameter | type | behaviour |
|---|---|---|
| `channelId` | uuid | unchanged — `$eq`. Wins over `channelIds`/`channelIdsEmpty` when both are sent |
| `channelIds` | comma-separated uuids | `$in`. Non-uuid entries dropped; all-malformed or empty → no filter; capped at 200 — **#5198** |
| `channelIdsEmpty` | boolean token | documents with no channel; non-truthy token ignored — **#5198** |

Item shape, additive:

```jsonc
{
  "channelId":   "…uuid…",       // unchanged
  "channelName": "Web shop",     // new — null when unassigned or channel missing
  "channelCode": "web-shop"      // new — null when unassigned, missing, or the channel has no code
}
```

`documentSchema` (`factory.ts:587`) and the OpenAPI query schema are updated so the generated spec
documents both. Existing consumers see two extra fields and no removals.

## Test Plan

Per `.ai/qa/AGENTS.md`, integration coverage for the affected API and UI paths ships in the same change.

**Unit — `packages/core/src/modules/sales/api/__tests__/documents.channelResolution.test.ts`** (new,
modelled on `shipments.afterList.test.ts`)

- resolves `channelName`/`channelCode` for a mixed page
- **one** `em.find` for a page containing repeated and distinct channel ids (the N+1 guard)
- no query at all when every item has a null `channelId`
- a `channelId` with no surviving channel row → `channelName: null`, `channelId` preserved
- a channel outside the request's organization scope → `channelName: null`, no name leaked
- the lookup predicate carries both the tenant and the request's organization scope, and uses the
  full `organizationIds` set when the request selects more than one org
- **composition guard:** after the change, a list response still carries `tags` (`attachTags` ran),
  and a single-item order response still carries recalculated totals — the regression test for the
  hook being appended to rather than replaced

**Unit — `packages/core/src/modules/sales/api/__tests__/documents.factory.test.ts`** — **already
covered by #5198**, which lands 11 cases: `$in`, trim/dedupe, singular-beats-plural for both new
params, `$exists: false`, non-truthy token ignored, malformed dropped, all-malformed → no filter,
empty string → no filter, `channelId` alone still `$eq`, and quotes matching orders. Nothing to add
here; if #5198 is rejected, these cases come back into this spec's scope.

**Unit — `packages/core/src/modules/sales/api/__tests__/channels.route.test.ts`** (extend)

- `GET` metadata requires `sales.channels.view`; `POST`/`PUT`/`DELETE` still require `manage`

**Component — `packages/core/src/modules/sales/components/documents/__tests__/`**

- the Channel column renders `channelName` without any `/api/sales/channels` request
- selecting two channels emits `channelIds=a,b`
- a legacy perspective snapshot holding `channelId: "<uuid>"` restores as a one-element selection

**Integration (Playwright, `.ai/qa/`)** — self-contained, API-created fixtures, cleaned up in teardown

- create two channels + three orders (two channels, one unassigned); assert the Channel column shows
  names on first paint; filter by both channels → two rows; filter unassigned → one row
- a role holding `sales.orders.view` without `sales.channels.manage` sees a populated Channel filter
  (the ACL regression guard for defect 3)

The first case is the one #5198 offered to add and left out (its checklist says integration coverage
was omitted because a Playwright spec needs a running stack to validate). It belongs here either way:
the assertion that matters — *the column shows names on first paint* — is this spec's behaviour, not
#5198's, and cannot be written before § 1 exists. If a maintainer asks #5198 to carry the filter half
of it, this plan reduces to the column and ACL assertions.

## Relationship to #5198

[open-mercato#5198](https://github.com/open-mercato/open-mercato/pull/5198) (open, targets `develop`)
is § 2 of this spec, extracted and shipped on its own. The split is the right shape — the filter
params are a self-contained API addition with unit-testable semantics, while the rest of this spec
needs a hook change, an ACL change, and UI work — but it creates one ordering constraint and one
overlap worth stating.

**Ordering.** § 4's UI change emits `channelIds`. It cannot merge before #5198, or the multi-select
sends a parameter the API ignores — which fails *silently*, returning an unfiltered page that looks
like a working filter. Anyone implementing § 4 must confirm #5198 has landed on the target branch
first. This is the only hard dependency between the two.

**No code overlap.** #5198 touches `listSchema` and `buildFilters`; § 1 touches `hooks.afterList`.
Different regions of `factory.ts`, no conflict beyond line drift. §§ 3 and 4 touch different files
entirely.

**If #5198 is rejected or reshaped**, § 2 and its unit cases return to this spec's scope unchanged —
nothing here depends on *where* the params land, only that they exist with these semantics.

## Out of Scope / Follow-ups

- **The `customerId` filter drops all but the first selection.** `SalesDocumentsTable.tsx:382–388`
  builds a `customerIds` array from a multi-select and then emits `params.set('customerId', customerIds[0])`,
  because the API takes one uuid. Same defect class as this spec's #4, different entity — worth its
  own change once `channelIds` sets the pattern.
- **Sorting by channel name.** `buildSortMap` (`factory.ts:157–168`) sorts on document columns; sorting
  by a name resolved after the query would need a join in the projection. The column stays
  `enableSorting: false`, as today.
- **Channel on the analytics/dashboard surfaces.** Grouping by `channel_id` already exists there and
  has the same name-resolution gap; out of scope here.

## Changelog

| date | change |
|---|---|
| 2026-08-10 | Initial draft. Verified against fork `main` @ `bdf361155`. |
| 2026-08-10 | Review round 1 (Copilot): compose into the existing `hooks.afterList` instead of replacing it (`attachTags` + display-totals recalculation would have been dropped); scope the channel lookup by organization as well as tenant; defect count and the "no behaviour change" claim corrected. |
| 2026-08-11 | § 2 carved out and shipped as upstream #5198. Section now defers to that PR, adopts its shared `parseIdsParam` over the locally-copied `parseIdList` this spec had proposed (and documents its silent 200-id cap), and drops the `documents.factory.test.ts` cases it already covers. Added § Relationship to #5198 recording the one hard ordering constraint: § 4's multi-select must not ship before those params exist. |
