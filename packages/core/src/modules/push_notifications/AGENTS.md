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
- **Worker** (`workers/send-push.worker.ts` → `lib/push-delivery.ts`) resolves the tenant push
  `CommunicationChannel` + hub adapter (`channelAdapterRegistry`) + creds (`integrationCredentialsService`)
  and calls `convertOutbound` → `sendMessage` — the `communication_channels` `test-send` flow. Retries
  transient failures with backoff (3 attempts); on the `unregistered` sentinel soft-deletes the device.
- **Queue** (`lib/queue.ts`) mirrors the webhooks queue: `createModuleQueue` + `enqueuePushDelivery` +
  a local-worker bootstrap for dev/test (`QUEUE_STRATEGY !== 'async'`).

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
