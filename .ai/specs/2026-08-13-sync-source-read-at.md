# Source Read Stamp on External ID Mappings

**Status:** Proposed
**Date:** 2026-08-13
**Modules:** `integrations` (entity, migration), `data_sync` (service)

## TLDR

`SyncExternalIdMapping` gains a nullable `source_read_at` column recording **when the source produced
the data**, alongside the existing `last_synced_at` which records when *we wrote*. Adapters can then
refuse an apply carrying an older read than the one already applied, which fixes silent data loss when
two writers for one integration read at different times and write in the other order.

Everything is opt-in and additive: `storeExternalIdMapping` gains a trailing optional argument, the
service gains a `lookupMapping` read method, and a pure `isSourceReadStale` comparator ships beside
them. An adapter that passes neither the option nor the check behaves exactly as it does today.

## Problem Statement

A state-based sync applies whatever the source said **at the moment it read**. When two writers for the
same integration read at different times but write in the other order, the older read wins.

Reported by an adapter that runs both an incremental change feed and a whole-table backfill against the
same source. Concretely:

1. The backfill reads a page of documents at **T0**. It now holds a snapshot of document X as of T0.
2. The feed picks up an edit to X and applies it at **T0 + 20s** — current truth.
3. The backfill's batch finishes and applies its page at **T0 + 50s**, overwriting X with the version it
   read at T0.

The record is now stale, and **nothing repairs it**: the source already emitted its change, so no
further event is coming. It stays wrong until the next edit to that document or the next full backfill.

Three properties make this worse than it first looks:

- **Ordering is not enough.** Feed-vs-feed is safe today because each drain re-reads current state at
  apply time. Backfill-vs-feed is not, because a backfill applies a snapshot taken up to a whole batch
  earlier.
- **The exposure is not uniform.** A backfill that walks newest-first spends its early minutes on
  exactly the records most likely to be edited concurrently. Collisions concentrate where they hurt.
- **It is silent.** No error, no counter, no log line. The only symptom is a record that disagrees with
  the source until something unrelated touches it.

Existing state does not help. `last_synced_at` records when the *write* happened, which orders the
writers by when they finished — precisely backwards, because the clobbering writer finishes later with
older data.

The concept is not novel in this codebase, only missing from the core table: the create-app template's
`example_customers_sync` module already carries `source_updated_at` on its own mapping table
(`packages/create-app/template/src/modules/example_customers_sync/data/entities.ts`) for this reason.

## Proposed Solution

Record **when the source was read**, and give callers what they need to refuse an older apply.

### Data model

`packages/core/src/modules/integrations/data/entities.ts` — `SyncExternalIdMapping`:

```ts
@Property({ name: 'source_read_at', type: Date, nullable: true })
sourceReadAt?: Date | null
```

Nullable, so existing rows need no backfill: a null stamp always loses the comparison and is stamped on
first apply. Added to the `[OptionalProps]` union. No index — every read of it rides the existing
`(integration_id, external_id, organization_id)` lookup.

The field carries a doc comment stating the clock requirement, because that requirement is not
enforceable in code (see § Clock Contract).

### API contracts

`packages/core/src/modules/data_sync/lib/id-mapping.ts`:

```ts
export type StoreExternalIdMappingOptions = { sourceReadAt?: Date | null }

export type ExternalIdMappingSnapshot = {
  localId: string
  externalId: string
  syncStatus: SyncExternalIdMapping['syncStatus']
  lastSyncedAt: Date | null
  sourceReadAt: Date | null
}

// New trailing optional parameter
storeExternalIdMapping(integrationId, entityType, localId, externalId, scope, options?)

// New method
lookupMapping(integrationId, entityType, externalId, scope, opts?: { forUpdate?: boolean })
  : Promise<ExternalIdMappingSnapshot | null>

// New pure comparator
export function isSourceReadStale(
  stored: Date | string | null | undefined,
  incoming: Date | string | null | undefined,
): boolean
```

`undefined` and `null` deliberately differ on the write option:

- **absent / `undefined`** → column untouched. On the update path no assignment happens; on the create
  path the key is omitted from the `em.create` object entirely, so the INSERT column list is identical
  to today's.
- **explicit `null`** → written as NULL. This is a meaningful operation, not an accident: an adapter
  that has just applied data it knows carries no trustworthy source clock must be able to *reset* the
  fence rather than leave a stale stamp silently blocking every subsequent write.

`isSourceReadStale` returns `true` when `incoming` is older than `stored` — i.e. "the caller should
skip":

| case | result | why |
|---|---|---|
| `stored` null / undefined / unparseable | `false` | legacy rows lose to any stamp |
| `incoming` null / undefined / unparseable | `false` | an unstamped writer cannot be fenced; preserves today's last-write-wins |
| equal | `false` | at-least-once redelivery must re-apply idempotently |
| `incoming < stored` | `true` | the fence |

It accepts `Date` or ISO string on either side (feeds carry strings; adapters should not hand-roll
parsing) and **fails open** on anything unparseable, degrading to current behaviour rather than
silently dropping writes.

### Usage

```ts
const mapping = await externalIdMappingService.lookupMapping(integrationId, entityType, externalId, scope)
if (isSourceReadStale(mapping?.sourceReadAt, payload.sourceReadAt)) return

await applyDocument(payload)
await externalIdMappingService.storeExternalIdMapping(
  integrationId, entityType, localId, externalId, scope,
  { sourceReadAt: payload.sourceReadAt },
)
```

## Architecture — why core stores a value it never reads

The obvious objection to this change is that it adds a column core never uses. The answer is
structural, not a preference, and it is worth stating before anyone asks.

The check must happen **immediately before the record is written**. In `data_sync` there is no such
moment inside core. The adapter contract's unit of exchange is a whole batch — `streamImport` yields
`ImportBatch { items: ImportItem[], cursor, hasMore }`
(`packages/core/src/modules/data_sync/lib/adapter.ts`) — and `ImportItem.action`
(`'create' | 'update' | 'skip' | 'failed'`) is a past-tense **report** of what the adapter already did,
not an instruction for core to carry out. The engine's loop over those items
(`lib/sync-engine.ts`) only counts them, logs failures, and commits cursor progress. Both in-tree
adapters loop internally and complete every write before yielding
(`sync-akeneo/.../adapter.ts`, `sync_excel/lib/adapters/customers.ts`).

The one core function on that path is `storeExternalIdMapping`, and it runs **after** the record is
written. That ordering is not merely conventional — at several call sites it is data-dependent and
cannot be inverted, because the mapping call consumes the write's output:

```ts
// packages/core/src/modules/sync_excel/lib/adapters/customers.ts
const commandResult = await params.commandBus.execute(/* customers.people.create */)
await params.externalIdMappingService.storeExternalIdMapping(
  'sync_excel', 'customers.person',
  commandResult.result.entityId,   // ← the id the write just produced
  externalId, params.scope,
)
```

The same shape holds across the Akeneo importer (`created.categoryId`, `offerId`, `priceId`,
`attachment.id`, `localProductId`, `localVariantId`). No call site invokes `storeExternalIdMapping`
before its corresponding record write. So a refusal inside it would be too late to prevent the
overwrite: it could only decline to update the mapping row, leaving the record written and the
bookkeeping inconsistent with it — strictly worse than doing nothing.

**Scoping the claim honestly:** the framework does have a per-write hook — `beforeExecute` on command
interceptors (`packages/shared/src/lib/commands/command-interceptor.ts`), which can block an individual
command and supports `'*'` targets. It does not close this gap, for two reasons. It fires per
**command**, not per logical source record, so it sees fragments of an aggregate rather than the
aggregate; and it does not cover every write — the Akeneo attachment path writes through raw ORM
(`em.create` / `em.persist` / `em.flush`) and bypasses the bus entirely.

That is also the second, independent reason the refusal should not live in core even if such a hook
existed: **what gets skipped is a whole record aggregate.** One Akeneo product spans up to seven
`storeExternalIdMapping` calls across six `internalEntityType`s (option schema, categories, product,
variant, offers, prices, attachments) inside a single `upsertProduct`, and returns several
`ImportItem`s. There is no single point at which that aggregate can be declined atomically, and
partially applying it is not an option. Only the adapter knows where those boundaries are.

**So the split: core remembers the fact, the adapter acts on it.**

That makes the remaining question narrow — how much core takes on:

- **Minimum** — the column and the write option only; each adapter reads the mapping row for itself.
- **Middle (chosen)** — the above, plus a way to read the stamp back without a second query, and a pure
  comparator so the null/equality rules are written once. Adapters that already query the mapping table
  directly need nothing extra; ones that go through the service do.
- **Most** — core refuses stale writes in `storeExternalIdMapping`. Rejected for the ordering reason
  above: it fences the wrong moment. Some adapters may also legitimately want last-write-wins.

`lookupMapping` returns a plain projection rather than the managed ORM row so adapters cannot mutate a
live identity-map object and accidentally flush it — the hazard class `withAtomicFlush` exists for.

**The surface question is still the contestable one.** If maintainers prefer the minimum,
`lookupMapping` is deleted and the rest stands.

## Concurrency & Atomicity

Check-then-write is racy on its own: two writers can both read the stored stamp, both decide they are
newer, and land in either order. The compare and the stamp must serialize per record, held across the
document's apply — not just across the mapping write.

**What ships:** `lookupMapping(..., { forUpdate: true })`, which passes
`{ lockMode: LockMode.PESSIMISTIC_WRITE }` through `findOneWithDecryption` — the existing repo pattern
(`wms/commands/inventory-actions.ts`, `sales/api/quotes/accept/route.ts`). Chosen over documenting only,
because otherwise an adapter wanting a lock drops to raw `em.findOne` and bypasses
`findOneWithDecryption` along with its tenant scoping. MikroORM throws if a lock mode is used outside a
transaction; this is noted on the method.

**What is documented but not shipped:** row locking alone **cannot** make this correct on the current
schema. There is no unique constraint on
`(integration_id, internal_entity_type, external_id, organization_id)`, so `FOR UPDATE` locks nothing
when the row does not exist yet — two concurrent first-time writers both find nothing and both insert.
The duplicate-retirement branch already present in `storeExternalIdMapping` is direct evidence that
duplicates occur in production today. Adapters that must cover first-insert races should take
`pg_advisory_xact_lock(hashtext($key))` keyed on
`integration_id|entity_type|external_id|organization_id` at the top of the transaction.

**Deliberately out of scope:** adding the missing partial unique index
`(integration_id, internal_entity_type, external_id, organization_id) WHERE deleted_at IS NULL`. It is
the real structural fix, but it would fail on already-duplicated rows in deployed databases and needs
its own dedupe migration. It is the highest-value follow-up to this change.

**Rejected:** a core advisory-lock helper. It would freeze a key-derivation contract, needs a
transaction it does not own, and puts Postgres-specific policy into a module whose AGENTS.md says
"Never special-case … mappings … in `data_sync`".

## Clock Contract

The stamp MUST come from **one clock** — the source's own, read in the same query that reads the data
(`SYSUTCDATETIME()`, `now()`, a feed watermark, whatever the source offers). Not the application's, and
not the OMS database's: with several application replicas, per-replica skew silently reorders writers.

This is unenforceable in code — nothing stops an adapter passing `new Date()` — so it lives in the
field's doc comment, in the framework docs, and here. **A correctly-implemented fence fed from the wrong
clock is worse than none, because it looks safe.**

A dev-mode "this stamp is suspiciously close to now" warning was considered and rejected: it produces
false positives for sources whose clock genuinely tracks wall time.

### Resolution limit

The fence is only as fine-grained as the source's clock. Because equal stamps are defined as **not**
stale (to preserve at-least-once redelivery), a source reporting whole-second granularity will not fence
a same-second out-of-order pair. Sources needing that guarantee require a monotonic sequence or LSN
rather than a timestamp. This is a genuine limitation of the design, not an implementation gap.

## Migration & Backward Compatibility

| Surface | Change | Classification |
|---------|--------|----------------|
| DB schema | Nullable `source_read_at timestamptz` on `sync_external_id_mappings` via `Migration20260813120000`; no index, no backfill | ADDITIVE (§8) |
| `storeExternalIdMapping` | Trailing optional `options` parameter | ADDITIVE (§3, new optional parameter) |
| `ExternalIdMappingService` | New optional method `lookupMapping`; no existing signature changes | ADDITIVE (§9) |
| `…/data_sync/lib/id-mapping` | New exports `isSourceReadStale`, `StoreExternalIdMappingOptions`, `ExternalIdMappingSnapshot`; no new import path | ADDITIVE (§4) |
| Enricher response `_integrations` | No change — `sourceReadAt` deliberately not surfaced | No change |
| OpenAPI / CRUD routes | No change — no core route serializes this table | No change |

Existing rows keep `NULL` and compare as older than any incoming stamp, so the first apply after deploy
stamps them. No tenant action is required. Both the write option and the comparison are opt-in per
adapter; an adapter that passes neither keeps last-write-wins exactly as before — machine-checked by the
existing `customers-adapter.test.ts` and `catalog-importer.test.ts` suites, which pin exact five-argument
call signatures and pass unedited.

`storeExternalIdMapping` is deliberately **not** added to `BACKWARD_COMPATIBILITY.md` § 3's
function-signature table: that table is a whitelist of cross-package framework functions, and listing a
module service method there would newly freeze a signature this change is extending.

`sourceReadAt` is deliberately not added to the `_integrations` enricher payload. `ExternalIdMapping` in
`packages/shared/src/modules/integrations/types.ts` is a STABLE type under § 2 and the enricher targets
`'*'`, so widening it would commit every enriched entity in the system to carrying a field with no
current consumer. Surfacing it for debugging is an open question below, not a decision made here.

## Testing

All in `packages/core/src/modules/data_sync/lib/__tests__/id-mapping.test.ts`.

- **Write option:** stored stamp untouched when no options supplied (today's behaviour); stamped on a
  newly created row; column absent from the insert entirely when no option is supplied; updated on an
  existing row; cleared when `null` is passed explicitly.
- **Comparator:** null / undefined stored → not stale (legacy-row path); null / undefined incoming → not
  stale; **equal stamps → not stale** (redelivery); older incoming → stale; newer incoming → not stale;
  ISO strings behave identically to `Date`; unparseable input fails open.
- **Reader:** returns `null` without flushing when absent; maps a row to the snapshot and scopes by
  external id; normalizes an unstamped legacy row to `null` rather than `undefined`; takes no lock by
  default and `PESSIMISTIC_WRITE` under `forUpdate`.

The stamped-create test is the first coverage of `storeExternalIdMapping`'s `em.create` path in this
suite — a pre-existing gap this change closes.

## Risks & Impact Review

- The fence ships available but **unused** — no in-tree adapter is wired up, deliberately, since doing so
  would change that adapter's behaviour and its pinned tests.
- Clock discipline is unenforceable; only review catches a wrong clock.
- The missing unique constraint means duplicate mapping rows can defeat the fence entirely.
- Second-granularity sources are not fenced within the same second.

## Open Questions for Maintainers

1. **How much of the read surface should core carry** — the middle option is proposed here; the
   minimum (column and write option only) is equally defensible. Core owning the refusal is argued
   against above on ordering grounds, but say so if you disagree.
2. **Should `forUpdate` ship at all**, given it cannot cover first-insert and throws outside a
   transaction? Dropping it leaves the rest of the change intact.
3. **Should the missing partial unique index be pursued** as a follow-up, with the dedupe migration it
   requires?
4. **Should `sourceReadAt` be surfaced on the `_integrations` enricher payload** for debugging
   out-of-order applies? Recommended no, for the STABLE-type reason above.
5. **Should an in-tree adapter be wired up** as proof, or is a documented usage sample sufficient?
6. **Comparator location** — `data_sync/lib/id-mapping` (chosen; no new import path) vs
   `packages/shared` (client-bundle-safe). Nothing needs it client-side today.

## Changelog

- 2026-08-13 — Initial proposal.
