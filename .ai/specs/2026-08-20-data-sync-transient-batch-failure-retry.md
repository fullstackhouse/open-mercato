# Surviving a transient batch failure in a data sync run

Status: draft — decisions requested before implementation
Scope: `packages/core/src/modules/data_sync/lib/{sync-engine,sync-run-service,adapter}.ts`, `packages/shared/src/lib/delivery/retry.ts` (reuse)
Baseline: `develop` (0.6.8-develop). References are to symbols rather than line numbers, since the engine
moves often.

## TLDR

A sync run has no answer to a network blip. `SyncEngine.runImport`/`runExport` catch any error out of the
batch stream, finalize the run `failed`, and return — so a multi-day backfill is discarded in full because one
connection could not be acquired for a few seconds, and the queue's retry budget never fires because the error
was swallowed rather than rethrown. This spec asks upstream to settle three things before anyone writes the
code: **who classifies an error as transient**, **what exhausting the retry
budget means**, and **whether re-driving a batch is safe**. It argues each side, recommends an answer, and
names the implementation consequences of the alternative.

## Problem

`SyncEngine.runImport` (`lib/sync-engine.ts`) drives the adapter's batch stream and commits progress per
batch. Its `catch` does three things in order: writes the message to the integration log, calls
`finalizeRun(run.id, 'failed', …)`, and returns. `runExport` is identical. There is no classification step and
no retry — every error out of the stream, from a syntax error to a socket reset, ends the run.

Two consequences follow, and the second is the one reviewers consistently miss.

**The run is terminal.** `finalizeRun` marks it `failed` and emits `data_sync.run.failed`. Nothing resumes a
`failed` run: the claim in `SyncRunService.markStatus` only matches `status IN ('pending', 'running')`,
deliberately, so a cancelled or completed run cannot be revived. A `failed` run is excluded by the same
predicate. Resuming it takes an operator on `POST /api/data_sync/runs/[id]/retry`, which starts a
*new* run from the stored cursor.

**From the queue's point of view the job succeeded.** The engine swallows the error rather than rethrowing,
so the worker handler returns normally and the queue's retry budget is never spent. Both strategies budget
three attempts with exponential backoff — `attempts` defaults to 3 in `packages/queue/src/strategies/async.ts`,
`DEFAULT_MAX_ATTEMPTS = 3` in `strategies/local.ts` — and neither applies here. That budget covers a
*different* failure: a worker hard-killed mid-batch never reaches the `catch`, the run row stays `running`,
and the redelivered job re-claims it (`const resumed = run.status === 'running'`) and re-drives from the last
committed cursor. That path works. The path where the engine catches its own error
does not, and the two are easy to conflate because the queue reports success in both.

So one transient blip discards arbitrarily much completed work — and "arbitrarily" is structural, not
rhetorical. The engine commits a cursor per batch and puts no bound on how many batches a run may have
committed before the first error escapes the stream, so what is lost is everything applied so far:
`batchSize × batchesCompleted` records, at a default `batchSize` of 100 (`startDataSyncRun`). A backfill is
precisely the workload where that product is large and the window for a blip to land in is long: a run of a
day or more discards a six-figure record count over a failure that lasted seconds.

Two error classes make that reachable rather than theoretical, and neither is exotic:

| Error | Raised by | Lasts |
|---|---|---|
| `timeout exceeded when trying to connect` | core's own Postgres pool, after `DB_POOL_ACQUIRE_TIMEOUT` (documented default 60 s) | as long as the pool is saturated — typically seconds |
| a source read timing out (`Request failed to complete in 60000ms` and equivalents) | the adapter's transport | seconds to minutes |

Whether a given deployment has already paid this is checkable directly:

```sql
select id, entity_type, batches_completed, last_error, created_at, updated_at
from sync_runs
where status = 'failed' and batches_completed > 0
order by batches_completed desc;
```

Every row combining a high `batches_completed` with a connection- or timeout-shaped `last_error` is a run
that was thrown away where it could have been resumed.

Retries do exist inside a run today, but only on the **source** side, inside adapters that chose to implement
them (`packages/channel-gmail/.../gmail-client.ts` is the pattern: bounded retry on 429/5xx with backoff and
jitter). **Nothing retries the write side** — and the pool-acquire timeout in the table above is core's own,
raised on a connection no adapter can see, let alone retry.

## Why this is a spec and not a patch

The shape of the fix is cheap; the shape of the *contract* is not. If classification lands in the wrong layer,
the implementation is thrown away rather than adjusted, and any downstream patch built on the wrong shape has
to be carried until upstream disagrees with it. Hence: decisions first.

## Decision 1 — who decides an error is transient?

**The case for the adapter.** It knows its own source. An adapter over a database driver classifies on that
driver's own codes (`ETIMEOUT`, `ECONNRESET`, `ESOCKET` and siblings); one over a REST source classifies on
HTTP 429/5xx; one over gRPC on `UNAVAILABLE`; one over a vendor SDK on its error classes. Core has no
business knowing any of these, and every new adapter brings a different set — a core taxonomy that tried to
cover them would be wrong on arrival and stale forever.

**The case for core.** Core owns the write side. A pool-acquire timeout comes from core's Postgres pool,
raised under core's `commitBatchProgress`, on a connection the adapter never sees.
Serialization failures (`40001`), deadlocks (`40P01`), admin shutdown (`57P01`) and connection resets on
core's own socket are the same story. An adapter cannot classify these and should not have to.

Both are right, which means the answer is *both* and the spec's real job is the composition rule.

**Recommendation — core classifies first, silence delegates.**

```ts
// data_sync/lib/transient-errors.ts (core taxonomy — core's own write-side failures only)
export function isCoreTransientError(error: unknown): boolean

// DataSyncAdapter (additive, optional)
/**
 * Classify an error the adapter's own source raised. Return `undefined` (or omit
 * the method) to leave the decision to core. Core's own write-side taxonomy is
 * consulted first and is not overridable — an adapter is not asked about a
 * failure to acquire a connection from core's pool.
 */
isTransientError?(error: unknown, ctx: { entityType: string; scope: TenantScope }): boolean | undefined
```

Order: `isCoreTransientError(error) || adapter.isTransientError?.(error, ctx) === true`. Core's *yes* wins
because core is the only layer that can see its own infrastructure. Core's *silence* delegates, because the
adapter is the only layer that can see the source's. An adapter cannot veto core's yes — the errors core
claims are ones the adapter has no basis to judge — and an adapter's yes never needs core's permission. The
default with no hook and no core match is **not transient**, i.e. today's behavior.

*The alternative upstream may prefer:* a tri-state where an explicit `false` from the adapter vetoes core's
classification. It buys an escape hatch for an adapter that knows a particular pool timeout is really its
source wedging a connection forever; it costs the layering, because an adapter can then make core's own
failures fatal. If upstream wants the veto, the hook's contract must say which error classes the adapter is
entitled to veto, or it becomes a coin toss between two classifiers.

## Decision 2 — what does exhausting the budget mean: `failed`, or `paused`?

`paused` exists as a status literal on `SyncRun` (`data/entities.ts`), in the run validators, in the status
badge map (`lib/syncRunStatus.ts`) and in every locale file — and **nothing writes it**. No code path in the tree moves a run to
`paused`; the only "paused" in the UI is a *schedule* that is disabled.

On paper it is the more attractive answer: the run keeps its cursor and something picks it up later. Three
things make it worse than `failed` unless upstream also commits to a resumer.

1. **Nothing re-animates a paused run.** The only automatic starter is `sync-scheduled.ts`, which fires per
   `SyncSchedule` row and creates a *new* run; it never looks at an existing one. A run started from the
   dashboard by an operator — which is how a one-off backfill is started, and the only way to start one where
   no `SyncSchedule` row exists — therefore has nothing that could ever pick it back up. For that run,
   `paused` is a dead run under a friendlier name, and strictly worse than `failed`, which at least reads as
   needing attention. It is worse in the UI too: the dashboard renders the Retry row action only for
   `row.status === 'failed'`, so a `paused` run would offer an operator no way forward at all.
2. **The claim predicate would have to change.** `markStatus('running')` matches `pending`/`running` only, so
   a `paused` run cannot be claimed by any worker — a resumer would have to widen a predicate whose narrowness
   is load-bearing for cancel/complete safety.
3. **Overlap detection ignores it.** `findRunningOverlap` matches `pending`/`running`, so a `paused` run does
   not block a new run for the same (integration, entityType, direction). Two runs would then hold two
   different resume positions for one shared `sync_cursors` row.

**Recommendation:** keep `failed` as the terminal state after the budget is exhausted, with the resume
position and the attempt history already on the row (`cursor`, `lastError`), and leave `paused` unused. If
upstream instead expects a scheduler tick to resume `paused` runs, the spec that introduces it must name the
sweeper, its queue, its own bounded budget, and its behavior in a deployment with no schedules at all —
because that deployment is not exotic, it is the normal shape of an operator-driven backfill.

**Sub-decision — does the engine rethrow after exhausting the budget?** Recommendation: **no**, keep
swallowing and finalize `failed`. A rethrow would hand the error to the queue's three attempts, but the run
has just been marked `failed`, so each redelivery is refused by the claim predicate and returns immediately;
the only effects are three queue-level failure logs and a delay before the job is dropped. If upstream wants
the queue's budget to mean something here, that is a separate change: finalize `failed` only once the queue's
attempts are spent, which requires the engine to see `ctx.attemptNumber` — it currently does not.

## Decision 3 — is re-driving the apply half safe?

The standard objection is that writes are not idempotent the way reads are, so a batch that failed halfway
cannot simply be re-applied. For this engine that objection is already answered — by a contract adapters must
satisfy today.

The adapter contract states it directly (`lib/adapter.ts`, `streamImport` doc comment): *"Batch work MUST be
replay-safe. Sync jobs are delivered at least once: BullMQ redelivers a job whose lock was not renewed, and
the engine resumes the run from its last committed cursor. A batch the generator already yielded can
therefore be produced and executed again."* A worker killed mid-apply already leaves a half-applied batch and
a cursor pointing before it; the redelivered job re-drives exactly that batch.

An in-run retry has the same shape, because it is implemented the same way: **a retry rebuilds the stream
from the last committed cursor and continues** — it cannot resume a generator that already threw. So the
retry is the redelivery-resume the engine already supports, minus the process restart. It introduces no
idempotency requirement that the contract does not already impose.

It is worth recording what satisfying that clause looks like concretely, because "replay-safe" is the kind of
requirement everyone agrees to and nobody checks. The strongest shape: stamp every source read with the
**source's own clock**, and claim each record before writing it in a single statement that compares
`stored <= incoming`. The comparison has to be `<=` rather than `<` *so that an equal stamp re-applies* —
under `<`, an at-least-once redelivery stops re-applying and the guarantee the engine depends on quietly
breaks. Any adapter meeting the clause has some equivalent; an adapter that cannot name its equivalent
probably does not meet it.

**Recommendation:** no new opt-in. Retry-on-transient is on by default for every adapter, because the
prerequisite is already mandatory. Add an explicit opt-*out* — `readonly retriesBatchesInRun?: boolean`
(default `true`) — for an adapter that knows it violates the clause (a stream with per-record non-idempotent
side effects) and wants the old fail-fast behavior until it is fixed. Do not phrase the default as "writes
are not idempotent, so no retry": for a stamped adapter that premise is false, and it is false for every
adapter the contract already binds.

## Budget shape

Per **consecutive** transient failures, reset whenever a batch commits. This makes the per-batch-vs-per-run
question moot in the right direction: a multi-day run may ride out many separate blips, but a source that is
simply down still fails within a bounded window.

| Knob | Default | Env |
|---|---|---|
| Consecutive attempts before `failed` | 6 | `DATA_SYNC_TRANSIENT_RETRY_ATTEMPTS` |
| Base delay | 5 s, factor 2 | `DATA_SYNC_TRANSIENT_RETRY_BASE_MS` |
| Delay cap | 5 min | `DATA_SYNC_TRANSIENT_RETRY_MAX_DELAY_MS` |

Reuse `calculateBackoffDelayMs` from `@open-mercato/shared/lib/delivery/retry` (exponential with jitter;
jitter matters because concurrency is 5 per queue and one pool outage fails every in-flight run at once).
Defaults ride out roughly ten minutes of outage — long enough for a pool to recover or a tunnel to
re-establish, short enough that a genuinely dead source is not mistaken for a slow one.

Two implementation requirements that are easy to miss and must be in the implementing PR:

- **Heartbeat through the backoff.** The engine's `withHeartbeat` wrapper (`lib/sync-engine.ts`) only ticks
  while the adapter's `next()` is pending, on `HEARTBEAT_TICK_MS` — derived as `STALE_JOB_TIMEOUT_SECONDS / 4`,
  so 15 s against the 60 s sweep. A backoff sleep sits outside that window, so any wait longer than the
  60 s timeout would let `markStaleJobsFailed` treat a healthy, waiting run as abandoned — and the delay cap
  proposed above is five minutes. The wait must drive the same keepalive
  (`progressService.touchJobHeartbeat?.(…)`), not merely sleep.

  Not to be confused with `HEARTBEAT_INTERVAL_MS` (5 s) in `progress/lib/progressService.ts`: that one
  throttles how often *already-flowing* progress updates are persisted, and it does nothing for a run that has
  stopped calling `updateProgress` because it is waiting. The two are independent, and only the first one
  keeps a backing-off run alive.
- **Stay cancellable during the backoff.** Poll `isCancellationRequested` while waiting, or Cancel appears
  dead for up to the delay cap — the same complaint the mid-batch cancellation change (#5403) is fixing.

Each retry writes one `warn` to the integration log (attempt number, delay, error message) so the run detail
page shows an outage as a handful of warnings rather than as unexplained silence.

## What stays fatal

Classification must be a narrow allowlist, not "anything we do not recognize". These end the run **fast**,
without spending a single attempt:

- SQL that cannot succeed: syntax error (`42601`), undefined table/column (`42P01`, `42703`), constraint
  violations that are not serialization failures.
- Permissions: `42501` and any auth/credential rejection from the source.
- Mapping and validation errors, and anything thrown before the stream starts (missing credentials, no
  adapter registered) — these already bypass the batch `catch` entirely.
- `SyncRunOwnershipConflictError` keeps its current precedence: it means another worker owns the run, and
  retrying is exactly wrong.

The failure already carries its resume position — the cursor is committed per batch — so a fatal error ends
the run with everything an operator needs to restart it. Nothing about that changes.

## Out of scope

- Reporting on runs that die without reaching the `catch` at all (worker abandoned, host lost) — the queue's
  abandoned-job path, filed separately (#5368).
- Mid-batch cancellation latency, filed separately (#5403). This spec depends on it only in one direction:
  whatever the wait loop is, it must stay cancellable.
- Any change to `sync_cursors` semantics, overlap detection, or the retry endpoint's contract.
- Automatic resumption of terminal runs — see Decision 2.

## Risks & impact review

| Risk | Severity | Mitigation | Residual |
|---|---|---|---|
| A non-replay-safe adapter double-applies a batch on retry | High | Replay-safety is already a contract requirement for at-least-once redelivery; `retriesBatchesInRun: false` opt-out for adapters that violate it | An adapter already broken under redelivery gets a second way to show it |
| A genuine outage is retried instead of reported, delaying the alert | Low | Bounded consecutive attempts; every attempt logged `warn` to the integration log; the run still ends `failed` | Failure is reported up to ~10 min later |
| Misclassification (fatal error treated as transient) burns the budget before failing | Low | Allowlist-only classification; fatal list above | Same failure, delayed |
| A long backoff is mistaken for a stalled job and swept | Medium | Heartbeat during the wait (above) | Regression risk if a later refactor moves the wait outside the tick — needs a test that pins it |
| Retry masks a source that is slowly failing every batch | Low | The counter resets only on a *committed* batch, so a source failing every batch exhausts the budget normally | None |

**Contract surfaces touched** (`BACKWARD_COMPATIBILITY.md`): `DataSyncAdapter` gains two optional members —
additive, existing adapters compile and behave unchanged. No DB schema change, no event-ID change, no API
route change under the recommended answers. Choosing `paused` in Decision 2 would additionally change the run
lifecycle, the claim predicate and overlap detection — a behavior change to a documented contract, and an
"Ask First" item in `data_sync/AGENTS.md`.

## Test coverage the implementing PR must ship

Unit (`lib/__tests__/sync-engine-transient-retry.test.ts`), import and export symmetrically:

- A stream that throws a core-transient error once, then yields: the run reaches `completed`, the cursor
  advances past the retried batch, no `data_sync.run.failed` is emitted.
- The same error thrown on every attempt: `failed` after exactly the configured attempts, `lastError` carries
  the underlying message.
- A fatal error (syntax/permission): `failed` on the first throw, zero delays consumed.
- An adapter whose `isTransientError` returns `true` for its own driver code: retried, though the core
  taxonomy does not recognize it.
- An adapter returning `false`/`undefined` for a core-transient error: still retried (core's yes is not
  vetoable) — the test that pins Decision 1's composition rule.
- `retriesBatchesInRun: false`: fails on the first transient error, i.e. today's behavior.
- The heartbeat ticks during the backoff wait, and a cancel requested during the wait finalizes `cancelled`
  without waiting the delay out.
- Counter reset: transient, commit, transient, … stays alive past the attempt limit in aggregate.

Integration (`data_sync/__integration__/`): a run whose adapter fails transiently mid-stream reaches
`completed` with the full record count, and `GET /api/data_sync/runs/[id]` reports the retry warnings in its
logs. No UI path changes; the run detail page renders the new warnings through the existing log list.

## Documentation to update on implementation

- `packages/core/src/modules/data_sync/AGENTS.md` → Run Lifecycle (classification, budget, what stays fatal).
- `apps/docs/docs/framework/modules/integrations-data-sync.mdx` → adapter contract: the two new optional
  members and the replay-safety clause they lean on.

## Open questions for upstream

1. Composition rule for classification: core-first with silence delegating (recommended), or an adapter veto?
2. Terminal state after exhaustion: `failed` (recommended), or `paused` **plus** a named resumer that works in
   a deployment with no schedules?
3. Retry-on-transient default-on with an opt-out (recommended), or default-off with an adapter opt-in?
4. Are the budget defaults (6 attempts, 5 s base, 5 min cap) the right order of magnitude for a multi-day run?

## Changelog

- 2026-08-20 — Initial draft. Decisions requested; no implementation.
