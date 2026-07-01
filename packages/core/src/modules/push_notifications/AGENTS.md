# push_notifications Module — Agent Guidelines

Push delivery **rails**. Owns the delivery log, the `push` notification delivery strategy, and the
`send-push` worker. It does **not** own device tokens (that's `devices`), per-user opt-out (that's
`notifications`), or provider credentials/transport (that's the `communication_channels` hub +
FCM/APNs/Expo channel packages). Spec: `.ai/specs/2026-04-28-push-notifications-and-devices.md` (Module 3).

## Architecture

- **Strategy** (`lib/push-delivery-strategy.ts`) registers via the notifications `delivery-strategies`
  generator plugin (export `deliveryStrategies` from `notifications.delivery-strategies.ts`). It runs
  inside the persistent `notifications:deliver` subscriber and only enqueues — the actual send happens
  in the worker so a slow provider never blocks notification creation.
- **Worker** (`workers/send-push.worker.ts` → `lib/push-delivery.ts`) atomically claims the row
  (`pending` → `sending`, so a redelivered at-least-once job is processed once), resolves the tenant push
  `CommunicationChannel` + hub adapter (`channelAdapterRegistry`) + creds (`integrationCredentialsService`)
  and calls `convertOutbound` → `sendMessage` — the `communication_channels` `test-send` flow. Retries
  transient failures with exponential backoff + jitter (3 attempts, shared
  `@open-mercato/shared/lib/delivery/retry`), records `next_retry_at`, and marks the row `expired` once
  retries are exhausted (vs `failed` for terminal errors); on the `unregistered` sentinel soft-deletes the device.
- **Queue** (`lib/queue.ts`) mirrors the webhooks queue: `createModuleQueue` + `enqueuePushDelivery` +
  a local-worker bootstrap for dev/test (`QUEUE_STRATEGY !== 'async'`).
- **Reaper** (`lib/push-reaper.ts` → `workers/reclaim-stuck.worker.ts`) recovers rows stranded in
  `sending` by a crashed worker — the send-path claim only matches `pending`, so such a row has no
  outstanding job and would never terminate. A per-tenant `@open-mercato/scheduler` interval entry
  (registered best-effort in `setup.ts`, mirroring the `communication_channels` poll-tick) fires the
  tick; rows still in `sending` past `OM_PUSH_STUCK_RECLAIM_MINUTES` (default 5) are re-opened +
  re-enqueued when attempts remain, else finalized `expired`. Each transition is an atomic
  `nativeUpdate` guarded on `status='sending'` + still-stale `updated_at`, so overlapping ticks or a
  worker that re-claimed the row never re-open an active delivery.

## Always

- Resolve cross-module entities (`UserDevice`, `CommunicationChannel`) via DI tokens (`ctx.resolve(...)`),
  not import-time references, to stay decoupled.
- Keep `push_token` a secret: persist only `provider` + last-8 `token_snapshot`; never expose a full token
  in any API/UI/log.
- Soft-delete an `unregistered` device through the `devices.devices.deactivate` command (system ctx:
  `auth: null, systemActor: true`) — never mutate the `devices` table directly.
- Keep the `unregistered` sentinel identical across provider adapters (`result.metadata.unregistered ===
  true` or `result.error === 'device_unregistered'`) so the worker's soft-delete fires uniformly.
- Keep the delivery log append-only (status transitions only); it is intentionally optimistic-lock-exempt.

## Never

- Never add token-management or self-serve notification CRUD here (device fields live in `devices`).
- Never introduce a `PushProvider` interface — the hub `ChannelAdapter` registry is the provider seam;
  real providers are separate `channel-*` packages (Phase 4).

## Validation

```bash
yarn workspace @open-mercato/core test -- push-delivery
yarn workspace @open-mercato/core build
```
