# Data Sync — cursor provenance on run start and adapter input

**Status:** draft
**Module:** `packages/core/src/modules/data_sync`
**Related:** `.ai/specs/2026-08-12-data-sync-run-scoped-cursor.md` (closes its Risk #2 residual risk),
`.ai/specs/implemented/SPEC-045b-data-sync-hub.md`

## TLDR

A run reaches an adapter carrying a cursor and no indication of where that cursor came from. A fresh
dashboard start that silently inherited a previous run's position is byte-for-byte indistinguishable
from a Retry that was told to resume. For an adapter whose cursor encodes **scope** rather than only a
position, the difference decides whether the run is correct: an inherited cursor imposes a stranger
run's window, and the run reports `completed` having skipped everything outside it. This adds
`cursorOrigin` — `'none' | 'explicit' | 'inherited' | 'self'` — to the adapter input, persists the
start-time origin and its source run on `sync_runs`, and surfaces it on the run detail page. Behaviour
is unchanged; adapters that ignore the field behave exactly as today.

## Overview

Additive and behaviour-preserving. One new exported union, one optional field on each of the two
adapter input types, two nullable columns on `sync_runs`, one derivation helper, and provenance-aware
variants of the two existing resolvers (the originals stay as delegating wrappers). The three start
paths label the cursor they resolved; the engine derives what it is actually handing over on this
delivery; the run detail page renders it.

## Problem Statement

`resolveStartCursor` (`lib/start-cursor.ts:22`) resolves a start position for every non-`fullSync`
start — the shared `sync_cursors` row, or for an opted-out entity type the last incomplete run's cursor
(`resolveResumeCursor`, `lib/sync-run-service.ts:376`). `api/run.ts:125` calls it for every dashboard
start. So pressing **Run** means *"continue whatever ran last"*. The operator is never told, and the
only opt-out is a `fullSync` switch they must remember to tick.

That is correct for a cursor that is purely a position. It is wrong for a cursor that encodes scope —
filters, id/date bounds, dry-run flags, per-record suppression. A fresh, unfiltered run inherits a
failed run's date window, walks only that window, and reports `completed` having skipped everything
outside it. Adapters that notice this end up hand-rolling a *"may I believe this cursor?"* heuristic,
which is guesswork built on a value core handed over without provenance.

**This is a recorded residual risk, not a new discovery.**
`.ai/specs/2026-08-12-data-sync-run-scoped-cursor.md` Risk #2 states it directly:

> Resuming an interrupted run is the intended behaviour, but "interrupted with a different window" is
> indistinguishable from "interrupted with the same window" without a window fingerprint on the run row.

### Why the obvious fix is wrong

Refusing an inherited cursor on a fresh run would break Retry. `api/runs/[id]/retry.ts:121` sets
`cursor = fromBeginning ? null : previous.cursor ?? resolveStartCursor(...)` and `:146` passes the
previous run's parameters, so a retry arrives at the adapter carrying both a cursor and parameters,
indistinguishable from a fresh dashboard start that inherited one. Nothing on the run row separates
them: `createRun` (`lib/sync-run-service.ts:126`) writes `initialCursor` for both paths, and no column
links a retry to its predecessor. An adapter that refused inherited cursors would make Retry restart
from the top.

### The third case the framing misses

Retry is not uniformly explicit. `retry.ts:123` is `previous.cursor ?? await resolveStartCursor(...)`,
so a retry of a run that never committed a batch falls through to exactly the same inherited
resolution as a dashboard start. A discriminator that labelled all retries `'explicit'` would be a
second thing to distrust. This spec labels that fallback `'inherited'`, which is what it is.

## Proposed Solution

Provenance, not a behaviour change: make the origin of the cursor explicit and visible to the adapter,
leaving today's default resolution exactly as it is. Existing adapters ignore the new field; an adapter
that cares can refuse a silently inherited cursor without breaking Retry.

### Why four values and not three

The natural set is `'none' | 'explicit' | 'inherited'`. It is not sufficient, because the engine does
not hand the adapter the cursor the run started with.

`sync-engine.ts:621` (import) and `:848` (export) pass `run.cursor`, not `run.initialCursor`. After the
first batch commits, `run.cursor` is the adapter's own output. BullMQ redelivers a job whose lock was
not renewed, and the engine re-enters the adapter with that advanced cursor. A row stamped `'inherited'`
at creation would still read `'inherited'` on that redelivery, so an adapter that refuses inherited
cursors would refuse its own legitimate mid-run resume — reintroducing the Retry breakage one level
down, in a path with no operator to notice it.

So the two things are deliberately distinct:

- the **column** records the provenance of the run's *starting* cursor — a fact about the run, stable
  for its lifetime, and what an operator wants to read;
- the **value handed to the adapter** describes the cursor *actually being delivered on this call*,
  which is `'self'` once the run has committed work of its own.

`batchesCompleted` is the right signal for that derivation, and is the same token the ownership fence
already uses precisely because it advances by construction on every commit. A cursor is a free-form
adapter string an adapter may legitimately repeat between batches, so comparing `cursor` against
`initialCursor` would misreport a repeat as a fresh start.

## Architecture

### 1. `lib/adapter.ts`

```ts
export type CursorOrigin = 'none' | 'explicit' | 'inherited' | 'self'
```

Optional `cursorOrigin?: CursorOrigin` on `StreamImportInput` and `StreamExportInput`:

| Value | Meaning |
|---|---|
| `none` | No cursor. Start from the beginning. |
| `explicit` | The caller supplied this cursor deliberately — a Retry resuming the previous run's own position, or a provider flow that computed one. |
| `inherited` | Core resolved it from prior state the caller never named: the shared `sync_cursors` row, or the last incomplete run. |
| `self` | This run's own committed progress, handed back after a redelivery. |
| *absent* | A run created before this change, or a caller that supplied nothing. Adapters see what they see today. |

### 2. `lib/start-cursor.ts` — resolution with provenance

```ts
export type ResolvedStartCursor = {
  cursor: string | null
  origin: CursorOrigin        // only 'none' | 'inherited' from this function
  sourceRunId: string | null  // set only when the cursor came from a previous run
}
export async function resolveStartCursorWithOrigin(params): Promise<ResolvedStartCursor>
```

`resolveStartCursor` stays as a `@deprecated` wrapper returning `.cursor`, so no existing signature
changes.

The shared-row branch yields `sourceRunId: null`, because a `sync_cursors` row has no run id. That
asymmetry is load-bearing, not incidental: it is how the UI distinguishes *"continuing run X"* from
*"continuing the saved incremental cursor"* without a second discriminator column.

### 3. `lib/sync-run-service.ts`

New `resolveResumeCursorWithSource(...)` returning `{ cursor, runId }`. The existing
`resolveResumeCursor` is reimplemented as a delegating wrapper, so its behaviour and its four existing
tests are unchanged.

### 4. `lib/cursor-origin.ts` — the delivered origin

```ts
export function deliveredCursorOrigin(run: SyncRun): CursorOrigin | undefined {
  if (run.cursor == null) return 'none'
  if ((run.batchesCompleted ?? 0) > 0) return 'self'
  return run.cursorOrigin ?? undefined
}
```

A separate file so `start-cursor.ts` stays about *resolution* and this one about *delivery* — the two
answer different questions and are called from different layers (start paths vs engine).

`run.cursorOrigin ?? undefined` is what keeps pre-migration rows honest: `null` means *unknown*, and an
absent field is exactly what every adapter sees today. No backfill.

### 5. `lib/sync-engine.ts`

Passes `cursorOrigin: deliveredCursorOrigin(run)` at the two adapter calls (`:619-621` import,
`:846-848` export). `committedBatches` is already seeded from `activeRun.batchesCompleted` at `:603` /
`:830`, so the signal is in hand.

### 6. The three start paths

| Path | Cases |
|---|---|
| `api/run.ts:125` | `fullSync` → `'none'`; otherwise the resolved origin |
| `api/runs/[id]/retry.ts:121` | `fromBeginning` → `'none'`; `previous.cursor` present → `'explicit'` with `sourceRunId: previous.id`; fallback → the resolved origin (`'inherited'`) |
| `workers/sync-scheduled.ts:73` | `fullSync` → `'none'`; otherwise the resolved origin |

### 7. `lib/start-run.ts`

`StartDataSyncRunInput` gains `cursorOrigin?` and `cursorSourceRunId?`, passed to `createRun`.

A caller that omits them gets `input.cursor == null ? 'none' : 'explicit'`. A caller that supplied a
cursor without going through `resolveStartCursorWithOrigin` did so deliberately, so `'explicit'` is the
honest label. This is correct for both out-of-module callers — `packages/sync-excel/.../api/import/route.ts:154`
and `packages/sync-akeneo/.../lib/first-import.ts:161` — so neither has to change, and neither silently
acquires an `'inherited'` label it did not earn.

### 8. Run detail UI

`backend/data-sync/runs/[id]/page.tsx` renders one line: *"Continuing run <link>"* when
`cursorSourceRunId` is set, *"Continuing the saved incremental cursor"* for `'inherited'` without one,
nothing for `'none'` and `'explicit'`. This closes the operator half of the problem — today the page
renders neither `cursor` nor `initialCursor`, though the API has returned both since the hub shipped.

**Out of scope**, as the request states: the start-form hint (*"this will continue the last incomplete
run — [start from the beginning]"*). That is a follow-up.

## Data Models

Two nullable columns on `sync_runs`. One additive migration; no backfill.

| Table | Column | Type | Role |
|---|---|---|---|
| `sync_runs` | `cursor_origin` | `text null` | Provenance of the run's **starting** cursor. Written once at `createRun`, never mutated. `null` for pre-migration rows |
| `sync_runs` | `cursor_source_run_id` | `uuid null` | The run the cursor came from, when it came from a run. `null` for the shared-row and `'none'` cases |
| `sync_runs` | `batches_completed` | existing | Read by `deliveredCursorOrigin` to derive `'self'`; unchanged |
| `sync_runs` | `initial_cursor` | existing | Unchanged. `cursor_origin` describes *this* column's provenance |

`cursor_source_run_id` is a bare `uuid`, not a foreign key, matching `progress_job_id` on the same
table. A run row is an append-only operational record; a FK would make run retention deletion order-
dependent for a column read only to render a link.

Both columns are added to the `[OptionalProps]` list on the entity.

## API Contracts

No request-shape change. No zod schema changes. Two read responses gain two optional fields:

| Route | Change |
|---|---|
| `GET /api/data_sync/runs/[id]` | adds `cursorOrigin`, `cursorSourceRunId` (both nullable) |
| `GET /api/data_sync/runs` | adds the same two fields per item |
| `POST /api/data_sync/run` | unchanged request and response; persists the resolved origin |
| `POST /api/data_sync/runs/[id]/retry` | unchanged request and response; persists the resolved origin |

TypeScript contracts (all additive):

| Symbol | Kind | Note |
|---|---|---|
| `CursorOrigin` | new exported type | `lib/adapter.ts` |
| `StreamImportInput.cursorOrigin?` | new optional member | absent = today's behaviour |
| `StreamExportInput.cursorOrigin?` | new optional member | absent = today's behaviour |
| `ResolvedStartCursor` | new exported type | `lib/start-cursor.ts` |
| `resolveStartCursorWithOrigin` | new export | `lib/start-cursor.ts` |
| `resolveStartCursor` | unchanged signature | now `@deprecated`, delegates |
| `SyncRunService.resolveResumeCursorWithSource` | new method | |
| `deliveredCursorOrigin` | new export | `lib/cursor-origin.ts` |
| `StartDataSyncRunInput.cursorOrigin?` / `.cursorSourceRunId?` | new optional members | defaulted when omitted |

## Backward Compatibility

Additive throughout. Per `BACKWARD_COMPATIBILITY.md`:

- **§2 Type Definitions & Interfaces (STABLE)** — optional fields added to `StreamImportInput`,
  `StreamExportInput` and `StartDataSyncRunInput`. No required field removed or narrowed. Same shape as
  the `signal?: AbortSignal` addition that shipped on `develop`.
- **§3 Function Signatures (STABLE)** — no existing signature changes. `resolveStartCursor` and
  `resolveResumeCursor` keep their exact signatures and behaviour as delegating wrappers.
- **§8 Database Schema (ADDITIVE-ONLY)** — two new nullable columns, no default, no rename, no removal,
  no index change.

An adapter compiled against the previous types keeps compiling and keeps behaving identically. A run
row written before the migration reads `cursor_origin = null`, which `deliveredCursorOrigin` maps to an
absent field rather than guessing an origin it cannot know.

## Risks & Impact Review

| # | Failure scenario | Severity | Affected area | Mitigation | Residual risk |
|---|---|---|---|---|---|
| 1 | An adapter refuses `'inherited'` and, on a redelivery mid-run, is handed its own advanced cursor still labelled `'inherited'` — so it restarts from the top on every worker hiccup | High | Adapters that act on the discriminator | `deliveredCursorOrigin` returns `'self'` once `batchesCompleted > 0`; the persisted column and the delivered value are documented as answering different questions | Low. A run killed before its first commit is genuinely still on its start cursor, so `'inherited'` is correct there — a refusing adapter restarts, which is what it asked for |
| 2 | A caller uses `startDataSyncRun` directly with a cursor and gets the `'explicit'` default when the cursor was in fact inherited by that caller's own logic | Medium | Out-of-module start paths | The two in-tree callers (`sync_excel`, `sync_akeneo`) compute their own cursors, so `'explicit'` is accurate for both; the field is settable for callers that know better | Real for a third-party caller that resolves an inherited cursor itself and does not label it. Nothing in code can detect that from inside `startDataSyncRun` |
| 3 | The shared-row and previous-run inheritance cases are collapsed into one `'inherited'` value, so an adapter cannot tell a durable feed position from a stranger backfill's scan state | Medium | Adapters serving both kinds | `sourceRunId` is non-null only for the previous-run case, so the two are distinguishable; the run detail copy already relies on that split | An adapter must know to check `sourceRunId`, not just `cursorOrigin`. Documented in `AGENTS.md` and the field's doc comment |
| 4 | `cursor_origin` is a free-form `text` column, so a bad write could persist a value outside the union | Low | Data integrity | The only writer is `createRun`, fed by typed call sites; TypeScript rejects anything else | A raw SQL write could still store garbage. `deliveredCursorOrigin` returns it verbatim, so an adapter doing an exhaustive switch would fall through its default |
| 5 | The migration adds two columns to `sync_runs`, which can be large on an instance with long run retention | Low | Deployment | Both columns are nullable with no default, so Postgres adds them as metadata-only operations without a table rewrite | Negligible |
| 6 | The run detail page renders a link to a source run the operator cannot open — a run outside their organization, or one since deleted | Low | Run detail UI | `cursorSourceRunId` is only ever set from a run resolved inside the same tenant/organization scope, and the detail route re-scopes on read | A soft-deleted source run yields a link that 404s. Acceptable; the id itself is still the useful diagnostic |

## Testing

**Unit**

- `lib/__tests__/cursor-origin.test.ts` *(new)* — the `deliveredCursorOrigin` truth table: null cursor →
  `'none'`; `batchesCompleted > 0` → `'self'` regardless of the stored value; stored value passed through
  on the first delivery; `cursorOrigin: null` → `undefined`.
- `lib/__tests__/start-cursor.test.ts` — extended for `origin` and `sourceRunId` across the shared-row
  branch (`sourceRunId: null`), the resume branch (`sourceRunId` set), and no cursor at all.
- `lib/__tests__/sync-run-service.shared-cursor.test.ts` — extended for
  `resolveResumeCursorWithSource`, and that `resolveResumeCursor` still returns exactly what it did.
- `api/__tests__/run.test.ts` — the persisted origin for `fullSync` (`'none'`) versus an inherited start.
- `api/runs/[id]/__tests__/retry-cursor-origin.test.ts` *(new)* — the three retry cases, including the
  `previous.cursor == null` fallback labelled `'inherited'`. There is currently no test of retry cursor
  precedence at all, so this covers pre-existing behaviour as well as the new field.
- `lib/__tests__/sync-engine-*.test.ts` — the engine passes `'self'` on a redelivery after a committed
  batch, and the stored origin on the first delivery.
- `workers/__tests__/sync-scheduled.test.ts` — the origin persisted for scheduled runs.

**Integration** — `__integration__/TC-DS-011.spec.ts` *(new)*, self-contained per `.ai/qa/AGENTS.md`
(fixtures created in setup, cleaned up in teardown, no reliance on seeded data): start a run through
`POST /api/data_sync/run`, assert `GET /api/data_sync/runs/[id]` returns `cursorOrigin`, and assert the
run detail page renders the provenance line. Required by root `AGENTS.md` because this change touches
both an API surface and a UI path.

Not covered: no test exercises an adapter that actually refuses an inherited cursor, because no in-tree
adapter does. That behaviour is the adapter's to implement; this spec ships the information it needs.

## Final Compliance Report

| Check | Result |
|---|---|
| Schema / migration | Two nullable columns on `sync_runs`; additive migration + updated `.snapshot-open-mercato.json` |
| HTTP surface | Two read responses gain optional fields; no request shape, zod schema or status code change |
| `BACKWARD_COMPATIBILITY.md` contracts | Additive under §2, §3 and §8; dated section added to that file |
| Tenant scoping | No new query. `cursorSourceRunId` is only set from a run already resolved under `organizationId` + `tenantId` |
| Encryption helpers | `resolveResumeCursorWithSource` reads via `findWithDecryption`, as its predecessor did |
| `yarn generate` | No diff — no auto-discovered file added |
| Locales / user-facing strings | Two keys added to all five locale files (`en`, `de`, `es`, `ko`, `pl`); none hardcoded |
| Unit tests | To be confirmed at implementation |
| Docs updated | `packages/core/src/modules/data_sync/AGENTS.md`, `apps/docs/docs/framework/modules/integrations-data-sync.mdx` |

## Changelog

- 2026-08-31 — drafted.
