# data_sync: first-class backfill + change-feed sync modes

## Problem

An adapter that ingests an external system needs two read strategies for the *same*
entity: a **backfill** (bulk historical load, keyset-paginated, resumable) and a
**change-feed** (incremental tail, watermarked, continuous). These are two phases of
one sync — the universal snapshot→stream (CDC) pattern.

`data_sync` had no concept of a mode, so the distinction could only be encoded by
convention: because `SyncCursor` is unique on `(integration, entityType, direction)`,
an adapter had to model each entity **twice** (e.g. `sales_orders` + `sales_orders_feed`)
just to keep the two cursors independent — doubling the entity taxonomy, and with it
the per-entity mapping / schedule / run surface.

## What this does

Adds a first-class **sync mode** dimension, analogous to `direction`:

- `SyncRun.mode`, `SyncCursor.mode`, `SyncSchedule.mode` — new `text` columns, default
  `'backfill'`. `SyncCursor`'s unique index becomes
  `(integration, entityType, direction, mode)` (explicitly named `sync_cursors_scope_mode_uq`),
  so one entity holds independent cursors per mode.
- `DataSyncAdapter.syncModes?: Record<entityType, SyncMode[]>` declares the modes each
  entity supports. `StreamImportInput` / `StreamExportInput` gain `mode`.
- `POST /api/data_sync/run` accepts `mode` (default `'backfill'`), validates it against
  the adapter's `syncModes` for the entity (422 otherwise), persists it, threads it
  into cursor resolution/commit, and passes it to the adapter. Retry and the scheduler
  worker carry the run/schedule mode. `/api/data_sync/options` exposes `syncModes`.
- `RunParameter` gains `mode?: SyncMode | SyncMode[]` scoping (mirrors the existing
  `entityType` scoping), so a knob can be backfill-only or feed-only.

## Backward compatibility

**Additive.** All new columns default to `'backfill'`; an adapter that omits `syncModes`
supports only `'backfill'` and behaves exactly as before. New optional adapter/request
fields and exported symbols only — no existing signature, route, or default changes.

## Not in this change (follow-ups)

- Dashboard **Mode selector** in the run-now card (UI); options already exposes
  `syncModes`. Runs can set `mode` via the API today.
- Adapter migrations that collapse `_feed` twin entities onto `(entity, mode:'feed')`
  — including the data migration of live feed cursors — are per-adapter and out of core.

## Validation

- `tsc --noEmit` on `@open-mercato/core` — clean.
- `jest data_sync` — 11 suites / 46 tests pass.
- ⚠️ The MikroORM migration + `.snapshot-open-mercato.json` were authored by hand (the
  index uses an explicit name to stay deterministic); regenerate via
  `mikro-orm migration:create` against a database to confirm before merge.
