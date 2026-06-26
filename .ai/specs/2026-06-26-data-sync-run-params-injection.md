# SPEC — Data Sync "Run once now" provider parameter injection

**Status:** proposed
**Owner:** core / data_sync
**Date:** 2026-06-26

## Problem

The Data Sync dashboard ("Run once now" card at `/backend/data-sync`) can launch a manual run with
exactly two knobs: **batch size** and **full sync**. These are the only parameters the generic
`runSyncSchema` / `POST /api/data_sync/run` understands, and they are the same for every provider.

Real integrations need provider-specific launch parameters that the generic run has no vocabulary
for. The motivating case is the Subiekt GT order backfill, where an operator needs to:

- start the keyset backfill from a specific document id (`--last-id=N`) instead of the saved cursor,
- run a **dry run** (read + map, no writes) to validate before a real import,
- force a run **from the beginning** (ignore the cursor) independently of `fullSync` semantics.

Today the only ways to surface those controls are bad: **fork `@open-mercato/core`** (patch the run
form + validator + `run.ts`), or bolt a second, disconnected panel onto the integration detail page.
Both drift from upstream on every core bump, and neither is reusable by the next provider that needs
its own parameters.

The run record carries exactly one opaque field to the adapter — `cursor` (text). There is no
generic `parameters` column, so threading arbitrary provider params through the generic run worker
would require a schema migration and a new adapter-input contract — a much larger, provider-agnostic
change than the immediate need.

## Goals

- Give any integration provider a **first-class place in the run-now form** to render its own launch
  controls and dispatch a provider-specific run — with **no core schema change and no fork**.
- Keep the generic Start button and the vanilla cursor-resume run **unchanged** when no provider
  injects anything (zero visual or behavioural impact on existing installs).
- Make the contract **typed and stable** so provider packages get compile-time safety.

## Non-goals

- Teaching the generic `runSyncSchema` / `POST /api/data_sync/run` / run worker about per-provider
  parameters (no `parameters` jsonb column, no adapter-input change). A provider that needs params
  dispatches its own run (its own API route / Cloud Run Job), exactly as the Subiekt backfill already
  does. A generic host-run parameter channel is possible future work (see below) but is out of scope.
- A declarative parameter-schema DSL (provider declares `{key,type,label}` and core renders the
  fields). Widget injection already lets the provider render real primitives with full control; a DSL
  can layer on later if a pattern emerges across providers.

## Design

A single widget-injection spot in the run-now card, mirroring how the integration **detail** page
exposes `integrations.detail:tabs` for provider-specific tabs.

### Contract (`packages/core/src/modules/data_sync/lib/run-injection.ts`)

```ts
export const DATA_SYNC_RUN_PARAMS_SPOT_ID: InjectionSpotId = 'data_sync.dashboard:run-params'

export type DataSyncRunParamsContext = {
  integrationId: string
  providerKey: string | null
  entityType: string
  direction: 'import' | 'export'
  fullSync: boolean
  batchSize: number
  isEnabled: boolean
  hasCredentials: boolean
  reloadRuns: () => void   // refresh the runs table after the widget launches its own run
}
```

### Host (`data_sync/backend/data-sync/page.tsx`)

The run-now card renders the spot between the built-in batch-size / full-sync controls and the Start
button, passing a memoised `DataSyncRunParamsContext` derived from the current form selection. The
spot is only mounted once an integration + entity are selected. `InjectionSpot` renders nothing when
no widget is registered, so the vanilla form is byte-for-byte unchanged for providers that don't opt
in.

### Provider side (downstream, illustrative — not part of this PR)

A provider registers a widget for `data_sync.dashboard:run-params` via its module's
`widgets/injection-table.ts`. The widget reads the context, renders its controls (e.g. a last-id
`Input`, dry-run / from-beginning `Switch`es), and on submit calls its own run endpoint — for the
Subiekt backfill, `POST /api/subiekt_sync/backfill/run`, which dispatches the resumable Cloud Run
Job — then calls `context.reloadRuns()`. No core run-schema involvement.

## Backward compatibility

Additive only. New exported symbols (`DATA_SYNC_RUN_PARAMS_SPOT_ID`, `DataSyncRunParamsContext`) and
a new injection spot id — all in the ADDITIVE-ONLY classes of `BACKWARD_COMPATIBILITY.md`. No
existing type, signature, route, schema, DB column, or spot id changes. With no registered widget the
runtime behaviour and rendered DOM of the run-now form are identical to before.

## Integration coverage

- **UI** `/backend/data-sync` — with no widget registered for `data_sync.dashboard:run-params`, the
  run-now form renders and starts a vanilla run exactly as today (Start button, batch size, full
  sync). A test widget registered for the spot renders inside the card and receives a
  `DataSyncRunParamsContext` matching the current selection (integrationId, entityType, direction,
  fullSync, batchSize).
- **API** none changed. `POST /api/data_sync/run` is untouched; provider-specific launches go through
  the provider's own route.

## Future work

If multiple providers converge on "contribute parameters to the *generic* run" (one Start button,
params reach the adapter), add a generic optional `parameters` (jsonb) to `SyncRun`, forward it to
the adapter input, and let this same spot feed it via `InjectionSpot`'s `data` / `onDataChange`
channel. That is a migration-bearing, provider-agnostic change deliberately deferred out of this spec.
