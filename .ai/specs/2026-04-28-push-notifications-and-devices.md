# Push Notifications and Devices Modules

**Date:** 2026-04-28
**Author:** Jacek Tomaszewski (`@jtomaszewski`)
**Status:** Implemented — Phases 1–8. Ships as a single PR against `develop`.
**Related:** `packages/core/src/modules/notifications/` (in-app notifications, #412); `#539` (security/MFA — future device-trust consumer); upstream PR #2595 (superseded, devices-only)
**Companion specs:** [`2026-07-01-push-delivery-e2e-findings.md`](2026-07-01-push-delivery-e2e-findings.md) (org-propagation blockers found during e2e), [`2026-07-03-push-channels-tenant-scope.md`](2026-07-03-push-channels-tenant-scope.md) (tenant-wide push channels)

## TLDR

**Key Points:**
- Open Mercato ships only **in-app** notifications. There is no mobile push channel, no device registry, no DB-persistent notification type registry, and no per-channel user preferences.
- This spec adds two core modules (`devices`, `push_notifications`), extends `notifications` with a type catalogue + channel-agnostic preferences, and delivers push **through the existing `communication_channels` hub** — FCM, APNs, and Expo are hub `ChannelAdapter`s in their own npm packages.

**Scope:**
- `devices` — generic per-tenant `(user, device, platform)` registry. Push is one consumer; MFA device-trust (#539), session-aware auth, and audit logs are plausible future consumers.
- `notifications` extensions — DB-backed type registry, per-`(user, type, channel)` preferences, and a single delivery gate that every channel obeys.
- `push_notifications` — delivery log, delivery strategy, retry/reclaim worker.
- `packages/channel-{fcm,apns,expo}` — hub `ChannelAdapter` packages holding all provider-specific code.

**Concerns:**
- Push tokens are secrets. They are encrypted at rest and must never reach a list/detail response, an audit snapshot, a mutation-guard payload, or a provider response.
- The delivery queue is at-least-once. Exactly-once *send* is enforced by an atomic `pending → sending` claim, not by the queue.
- No fake validates conformance with the real providers. Only live credentials do; that gap is stated deliberately and is not closed by any option considered.

## Overview

An Open Mercato app that wants mobile push must today build a device-token store, a delivery strategy, an FCM/APNs sender, a client-readable type registry, per-channel preference toggles, and a retrying worker. That is a lot of infrastructure, and it is the same in every app.

This spec splits the work along channel-agnostic vs. channel-specific lines:

- **Channel-agnostic** (existing `notifications` module): type registry, preferences, the `shouldDeliver` gate. Future email/SMS channels read the same tables.
- **Channel-specific** (new `push_notifications` module): delivery rows, fan-out, worker.
- **Provider-specific** (new `channel-*` packages): the FCM/APNs/Expo SDKs and their message builders.
- **Cross-cutting** (new `devices` module): device identity, reusable beyond push.

> **Design stance**: This module distills the patterns that a production push stack needs. **Adopted:** a delivery-log shape, an exponential-backoff worker, and `unregistered`-token device cleanup. **Rejected as anti-patterns:** a single combined module, a `(user, type)` preference row with `push_enabled`/`email_enabled` boolean columns, a required-token `is_active` device entity, direct `node-pushnotifications` provider calls, and last-8 token masking in admin surfaces (upstream treats the token as a hard secret). See § Alternatives Considered.

## Problem Statement

### Gaps in the current `notifications` module

- `NotificationTypeDefinition` is **in-memory only**. A mobile app cannot enumerate types via API to render a preferences screen — it would have to ship a copy of the catalogue.
- There are no **per-channel user preferences**. `Notification.channels` is fixed at creation time and purely descriptive; users cannot opt out per type.
- There is no **mobile push** delivery strategy.
- There is no **device registry** — no first-class `(user, device, platform)` entity, no lifecycle, no platform metadata.

### The channels that bypass the seam get no enforcement

The `NotificationDeliveryStrategy` seam is correct, but before Phase 7 the two pre-existing channels did not use it: **in-app** delivery was the implicit act of writing the `Notification` row, and **email** was hard-coded inline in the dispatch subscriber. Because per-channel enforcement lived *inside each strategy*, disabling `in_app` or `email` for a type silently still delivered it, and the `nonOptOut`/`silent` governance flags were honored on push only.

## Proposed Solution

### Module 1 — `devices` (new, in `@open-mercato/core`)

Generic device registry owning `(tenant, org, user, device)` identity and lifecycle.

Device identity **includes the organization**: a device registered in a different org is a different row. The partial unique index coalesces a null `organization_id` to the nil UUID, because Postgres otherwise treats NULLs as distinct and null-org rows would stop deduping. "Active" means `deleted_at IS NULL`; push delivery additionally requires a non-null `push_token`.

**`push_token` is a hard secret.** It is encrypted at rest (`devices/encryption.ts` → `findWithDecryption`/`findOneWithDecryption` at every read site), never returned by any list/detail response (only `push_provider` and `push_token_updated_at` are exposed), redacted to `'[redacted]'` from the command snapshots the audit log persists (and therefore from the derived `changesJson` exposed via `audit_logs.view_self`), and stripped from the mutation-guard payload so it cannot surface in enterprise record-lock conflict details. The real token survives only in the internal undo payload, which no API exposes, so register/update/deactivate stay undoable.

APIs split into self-serve and admin trees, matching the `customer_accounts` / `staff` convention. Both are org-scoped through the standard `orgField: 'organizationId'` rather than a hand-rolled narrowing — the query engine's `resolveOrganizationScope` is null-aware, so a nullable column does not hide rows from unrestricted admins.

- **Self-serve** (`devices.view` / `devices.manage`): `POST /api/devices` (idempotent upsert of the caller's own device, revives a soft-deleted row), `GET /api/devices`, `PUT /api/devices/:id` (owner-only), `DELETE /api/devices/:id` (owner-only soft-delete).
- **Admin** (`devices.admin`, under `api/admin/devices`): list/create/read/update/deactivate any in-scope device; 403 outside the admin's org scope.

`last_seen_at` advances **only** when the client explicitly sends `lastSeenAt`. Metadata edits do not touch presence — presence is owned by the register heartbeat.

**Events:** `devices.user_device.registered`, `devices.user_device.deactivated`.

### Module 2 — extensions to `notifications`

**2a. DB-backed type registry.** New `NotificationType` (`notification_types`) mirrors the in-memory `NotificationTypeDefinition` aggregate so remote clients can enumerate types. The in-memory registry stays the source of truth for code; the table is a read-through mirror reconciled by a subscriber on `notifications.type_registry.sync`, and lazily by `GET /api/notifications/types`. The message title/body lives on the per-instance `Notification` row — this entity is only the catalogue. `label_key`/`description_key` resolve via locale JSON, not the runtime `translations.ts` system, because types are code-registered rather than tenant-defined.

**2b. Channel-agnostic preferences.** New `NotificationPreference` (`notification_preferences`), unique on `(tenant, user, notification_type_id, channel)`, with a free-form `channel` string. Rows are **lazy-seeded**: absence means enabled. `NotificationPreferenceService` (DI) exposes `isChannelEnabled` / `setPreferences` / `listForUser`; channel modules consume the service, never the table.

**2c. Module-registered channel catalogue.** `NotificationChannelDefinition` + an in-memory channel registry fed by a `generators.ts` plugin that discovers each module's `notification-channels.ts` and emits `notification-channels.generated.ts`. `GET /api/notifications/channels` serves the registry directly — no DB mirror, because the set is tiny. A third-party module registers a channel with **zero core edits**. Core dogfoods this by shipping `in_app`, `email`, and `push` through the same mechanism.

**2d. The single delivery gate.** `lib/shouldDeliver.ts` (`shouldDeliver` + `resolveEffectiveChannels`) composes: per-send target ∩ per-type eligibility ∩ registered strategies ∩ the recipient's preference (with `nonOptOut` bypassing it). `silent` composes orthogonally — it selects delivery *style*, never enforcement. The gate runs **once at create time** and its result is snapshotted onto `Notification.channels`; the dispatcher replays that set before each `strategy.deliver(ctx)`. Legacy `channels = NULL` rows recompute via `resolveEffectiveChannels` and are treated as "all channels / visible".

**Events:** `notifications.preference.updated`.

### Module 3 — `push_notifications` (new, in `@open-mercato/core`)

Owns the delivery log, the fan-out, and the worker. It owns **no provider code**: the hub's `channelAdapterRegistry` is the provider seam.

- `PushNotificationDelivery` (`push_notification_deliveries`) — append-only; snapshots `provider` and a last-8 `token_snapshot` so the audit trail survives token rotation and device deletion. Statuses: `pending | sending | sent | failed | skipped | expired`. `expired` (retries exhausted) is deliberately distinct from `failed` so the admin log carries real signal.
- The `push` `NotificationDeliveryStrategy` is **enqueue-only** — it resolves devices, snapshots provider + token tail, inserts `pending` rows, and enqueues. This keeps notification creation off the provider's latency path.
- `workers/send-push.worker.ts` claims a row with an atomic `pending → sending` transition (exactly-once *send* under an at-least-once queue), retries with exponential backoff to `MAX_ATTEMPTS = 3`, and on the uniform `device_unregistered` sentinel soft-deletes the source device through the `devices.devices.deactivate` command (no business-logic import).
- `workers/reclaim-stuck.worker.ts` recovers rows a crashed worker stranded in `sending`, **and** orphaned `pending` rows whose enqueue was lost after the INSERT committed. `attempts` increments at claim time so `MAX_ATTEMPTS` caps real provider sends across crashes. `OM_PUSH_STUCK_RECLAIM_MINUTES` is floored at 1 — a `0` would re-open actively-sending rows and duplicate pushes. The same tick drives Expo receipt polling.

Cross-module reads resolve softly via DI tokens; links are declared in `data/extensions.ts`. There are no token-management APIs here — tokens are device fields.

**Events:** `push_notifications.delivery.sent`, `push_notifications.delivery.failed`.

### Provider adapters — `packages/channel-{fcm,apns,expo}`

Each is a hub `ChannelAdapter` package mirroring `channel-gmail`: `channelType: 'push'`, `capabilities.realtimePush: true` (so `pollIntervalSeconds = null`), `channelScope: 'tenant'`, a credentials zod schema, a health check, and the SDK isolated behind an exported test seam (`setFcmMessagingFactory` / `setApnsSenderFactory` / `setExpoClientFactory`). The provider client is cached per credentials hash, LRU-bounded at 32 with `shutdown()`/`app.delete()` on eviction (an unbounded cache leaked a live HTTP/2 socket or an OAuth refresh timer per key rotation), and a **rejected** init promise self-evicts so a transient failure cannot poison the cache until process restart.

**Push channels are tenant-wide infrastructure.** One FCM service account serves every device in the tenant, so the channel row is stored with `organization_id = NULL` and its credentials are pinned to `organizationId = tenantId`. Read and write therefore land on the same key regardless of which org the connecting admin had selected. Connecting is admin-gated (`communication_channels.connect_tenant_channel`); the per-user connect route refuses a tenant-scoped provider with `403 wrong_scope_for_route`.

Each adapter maps its provider's permanent-token errors to the **uniform `device_unregistered` sentinel** so the worker's device soft-delete fires identically:

| Provider | Permanent-token errors → `device_unregistered` |
|---|---|
| FCM | `messaging/registration-token-not-registered`, `messaging/invalid-registration-token` |
| APNs | `Unregistered` (410), `BadDeviceToken` (400) |
| Expo | `DeviceNotRegistered` (receipt phase), malformed `!Expo.isExpoPushToken` |

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `devices` is its own module, **not** folded into `communication_channels` | They are orthogonal axes: the hub routes *messages* between providers and the unified inbox and has no notion of devices or push tokens; a user can have 5 devices and 0 channels, or 1 device and 3 email channels. Folding device storage into `push_notifications` would force MFA (#539), session-aware auth, and audit-log consumers to depend on the push module. Subsuming it into the hub would be the "wrong kind of reuse" — one abstraction serving two unrelated purposes. |
| Push *delivery* nevertheless rides the `communication_channels` hub | Maintainer mandate on #2595: *"push notifications support via the `communication_channels` hub … so it will be end2end feature."* Verified feasible with **no `ChannelAdapter` contract change**. This satisfies the end-to-end demand without collapsing the device registry into the hub. |
| **No `PushProvider` interface** in `push_notifications` | The hub's `channelAdapterRegistry` *is* the provider seam. A second seam would be a parallel, divergent registry. The strategy calls `adapter.sendMessage(...)` once per device token, exactly as `channels/[id]/test-send` does — not the conversation/message pipeline. |
| Type registry + preferences live in `notifications`, not `push_notifications` | Preferences are inherently cross-channel. A future `email_notifications` module would otherwise duplicate the table or depend on the push module — both wrong. There is one catalogue of "things a system can notify a user about"; in-app, push, and email are *renderings* of it. |
| `NotificationPreference` = one row per `(user, type, channel)` with a free-form `channel` string | Adding `email`/`sms` is new rows, not a schema change. A `(user, type)` row with per-channel boolean columns (`push_enabled`/`email_enabled`) would require a migration per channel. |
| Preferences are lazy-seeded (absent row ⇒ enabled) | Avoids backfilling a row for every user × every type whenever a new type is registered. Apps wanting default-off insert explicit `enabled=false` rows at type registration. |
| `UserDevice` carries push-token fields directly | Single token per `(device, app install)` is the universal case for FCM/APNs/Expo. A separate token entity is YAGNI; splitting later is one migration. |
| Device identity includes `organization_id` | Without it, re-registering the same device in a different org silently *moved* the existing row between orgs. |
| The gate runs once at create time and is snapshotted onto `Notification.channels` | Behaviorally equivalent to a per-deliver gate but computed once. It also promotes `channels` from a descriptive audit field to the authoritative target set, so channel targeting can never bypass opt-out enforcement. |
| `silent` selects delivery style; only `nonOptOut` bypasses preferences | A silent push is still a notification. Conflating the two would let any `silent` type ignore a user's opt-out. |
| FCM `messaging/invalid-argument` is **excluded** from the permanent-token set | FCM v1 returns it for *any* malformed request field, not just a bad token. Mapping it to `device_unregistered` meant a single payload-shape bug would progressively soft-delete every targeted device tenant-wide. It now falls through to the retryable path. |
| APNs returns an **empty** `externalMessageId` on success | node-apn has no message id. The previous `token.slice(-12)` persisted 12 characters of the raw token into the admin-exposed `provider_response`, undercutting the last-8-only secrecy contract. |
| The delivery strategy is enqueue-only; a worker sends | Keeps notification creation off the provider's latency path. |
| Exactly-once send via an atomic `pending → sending` claim | The queue is at-least-once; a redelivered job would otherwise re-send. `attempts` increments at claim so `MAX_ATTEMPTS` holds across worker crashes. |
| `expired` is a distinct terminal state from `failed` | Retries-exhausted and hard-failure are different operational signals in the admin log. |
| Push channel rows use `organization_id = NULL`, credentials pinned to `organizationId = tenantId` | Channel dedup/heal is org-agnostic. Keying credentials by the connecting admin's selected org meant an org-B key rotation wrote a credential row that the delivery path (reading at `channel.organizationId ?? tenantId`) never found. |
| Tenant-scoped providers are **refused** (403) on the per-user connect route, not silently downgraded | The defensive `effectiveUserId = null` downgrade let a non-admin holding only `connect_user_channel` mint or overwrite the shared tenant-wide push channel — a privilege-escalation bypass of the admin-only `connect_tenant_channel` ACL. |
| `setup.ts` swallows the `type_registry.sync` seed error | Contrary to the module norm (customers/sales/catalog throw to abort init for required reference data). Justified only because the emit is a best-effort nudge with a reliable fallback: `GET /api/notifications/types` reconciles lazily. Same pattern as `communication_channels` and `customer_accounts`. |
| `findWithDecryption` is used even though `TenantEncryptionSubscriber.onLoad` auto-decrypts | The subscriber only resolves entities whose own `tenant_id`/`organization_id` it can read. Keeping the helper is both convention (~1000+ read sites; AGENTS.md guidance, not an enforced gate) and fail-safe if the subscriber is absent from that EM or the entity later gains encrypted fields. |
| Provider-adapter tests use env-gated **in-process fakes** that swap the SDK *client*, never the adapter | `registerChannelAdapter` throws on a duplicate provider key, so the real adapter object stays registered and merely has its client swapped. This means real message construction, credential parsing, client caching, and every error→sentinel mapping execute end-to-end. |
| The fake records native messages to a **JSONL sink**, not `provider_response` | See § Alternatives Considered — it is infeasible via the delivery row, and a file (not memory) is required because the adapter runs in a different *process* than the spec. |
| Golden-file assertions use exact `toEqual` fixtures, not Jest snapshots | A snapshot silently re-records drift under `--updateSnapshot` instead of failing — the exact opposite of what the goldens exist for. |
| The APNs golden builds against a real `apn.Notification` | Production builds via `buildApnsNotification(new Notification(), payload)`. Pinning a plain-object projection the SDK never serializes would leave a hole in exactly the drift-detection the goldens exist for. Writing them this way immediately caught a wrong assumption: the envelope's custom `data` rides as top-level keys beside `aps` on **every** branch, visible as well as silent. |
| Root `resolutions` pin `node-forge@1.4.0` | `@parse/node-apn@6.5.0` declares `node-forge` as an **exact** version (`npm:1.3.1`), not a range, so no install can pick up a security patch. Documented in `packages/channel-apns/AGENTS.md` and `UPGRADE_NOTES.md`. |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|--------------|
| Fold `devices` into the `communication_channels` hub | Orthogonal concerns; the hub has no device/token axis. Would force one abstraction to serve two unrelated purposes. (Push *delivery* does ride the hub — the device *registry* does not.) |
| A `PushProvider` interface + FCM/APNs implementations inside `push_notifications` (the original draft) | Superseded by the maintainer mandate on #2595. It would have created a second provider seam parallel to the hub's `channelAdapterRegistry`. |
| A 1:1 port of a monolithic push-notifications module | Deliberate re-architecture instead. A combined module, boolean-column preferences, a required-token device entity, and direct `node-pushnotifications` calls each fail an upstream platform constraint. |
| A `sendSilentPush` primitive that writes no `Notification` row and bypasses preferences | Removed 2026-06-30. Silent push now rides the ordinary `notificationService.create()` flow: the row is still written, and preferences still apply unless the type is `nonOptOut`. Unifying on the create flow genuinely shrinks the surface, and the bypass conflated delivery style with enforcement. |
| A separate `PushToken` entity | YAGNI. One token per `(device, app install)` is universal across FCM/APNs/Expo. |
| A **fake HTTP provider server** for integration tests | Three independent reasons. (0) It does not buy what it appears to: it cannot validate conformance with the real provider, because its schema is our own belief about the contract — a wrong belief passes under either approach. (1) Its sole genuine gain is running the vendor SDK's client-side validation, and that is structurally unavailable for FCM: `firebase-admin@13.10.0` hardcodes `const FCM_SEND_HOST = 'fcm.googleapis.com'` and ships no messaging emulator, so FCM needs the in-process shim regardless — a server buys *nothing* for the provider that runs in production. (2) Every existing external-service fake in this repo is in-process and env-gated, while the one fake *service* (LocalStack) appears in no workflow file, so discovery silently drops its four `TC-ATT-004..007` specs from every CI run. A compose sidecar would repeat that failure mode. |
| Surface the provider-native message through the delivery row's `provider_response` (the spec's original preference) | Infeasible without editing `adapter.ts`. No adapter returns `metadata` on success — the worker persists only `{ externalMessageId }`. FCM and Expo could smuggle it through the id string; **APNs cannot**, because it deliberately hardcodes an empty id that is admin-exposed and must never carry token material. |
| An in-memory array to record fake sends | The adapter never runs in the spec's process, and *which* process it runs in is not fixed (app server inline / drain child / Playwright). A module-level array would live in whichever one happened to run it — the flakiest possible failure. The queue already crosses those boundaries via `QUEUE_BASE_DIR`; the sink rides the same directory. |
| A new HTTP/IPC endpoint to read fake sends | A production surface for a test-only concern. |
| Range-partitioning `push_notification_deliveries` | Deferred. A 90-day purge worker is the cheaper first step. |

## Architecture

### Commands & Events

- **Commands:** `devices.devices.register`, `devices.devices.update`, `devices.devices.deactivate` (one undoable command per file, matching `sales`/`customers`).
- **Events:** `devices.user_device.{registered,deactivated}`, `notifications.preference.updated`, `push_notifications.delivery.{sent,failed}`.

> `delivery.failed` carries `status: 'pending'` on a retryable failure. Subscribers must filter on `willRetry !== true`, not on `status`.

### Delivery flow

```
notificationService.create()
  └─ resolveChannelsFor()            # the gate, once, snapshotted onto Notification.channels
       └─ dispatch subscriber        # pure "resolve copy → loop strategies", no channel branches
            ├─ in_app strategy       # row already written; visibility filtered on channels
            ├─ email strategy
            └─ push strategy         # enqueue-only
                 └─ fanOutPushDeliveries()      # per-device provider routing
                      └─ PushNotificationDelivery (pending)  ──enqueue──┐
                                                                        │
   send-push worker ◄───────────────────────────────────────────────────┘
     ├─ atomic pending→sending claim (attempts++)
     ├─ resolve tenant push channel + adapter + credentials by delivery.provider
     ├─ adapter.sendMessage()  →  channel-{fcm,apns,expo}
     └─ sent | failed(retry) | expired | device_unregistered → devices.devices.deactivate

   reclaim-stuck worker: stranded `sending` + orphaned `pending` + Expo receipt polling
```

### File-level map

```
packages/core/src/modules/devices/
  data/entities.ts                          # UserDevice
  encryption.ts                             # push_token encrypted at rest
  commands/{register,update,deactivate}.ts  # one undoable command per file
  api/route.ts, api/[id]/route.ts           # self-serve
  api/admin/devices/**                      # admin tree
  backend/devices/**                        # admin list / create / edit
  __integration__/TC-DEV-00{1,5,6}.spec.ts

packages/core/src/modules/notifications/     # extended, not replaced
  data/entities.ts                          # + NotificationType, NotificationPreference, Notification.channels
  lib/shouldDeliver.ts                      # the single gate
  lib/notification-type-registry.ts
  lib/notification-channel-registry.ts
  lib/strategies/{in-app,email}-delivery-strategy.ts
  generators.ts                             # delivery-strategies + notification-channels plugins
  notification-channels.ts                  # core ships in_app/email/push through its own mechanism
  api/{types,channels,preferences}/**
  __integration__/TC-NOTIF-01{1,2,3,4}.spec.ts

packages/core/src/modules/push_notifications/
  lib/push-delivery-strategy.ts             # enqueue-only
  lib/push-fanout.ts                        # shared device/channel fan-out
  lib/push-delivery.ts                      # claim + send + retry + soft-delete
  lib/send-custom-push.ts                   # admin one-off send
  lib/push-stub-adapter.ts                  # OM_ENABLE_PUSH_STUB_ADAPTER
  lib/fake-provider-recorder.ts             # OM_PUSH_FAKE_PROVIDERS JSONL sink
  workers/{send-push,reclaim-stuck}.worker.ts
  backend/**                                # read-only delivery log
  __integration__/TC-PUSH-00{1..9}.spec.ts

packages/channel-{fcm,apns,expo}/src/modules/channel_{fcm,apns,expo}/
  integration.ts, di.ts, setup.ts, acl.ts
  lib/{adapter,credentials,health,fake-provider}.ts
  lib/__tests__/{message-golden,fake-provider}.test.ts
  __integration__/TC-CHANNEL-PUSH-00{1..7}.spec.ts

packages/core/src/helpers/integration/{pushFake,appRoot}.ts
packages/shared/src/modules/notifications/types.ts   # additive optional fields
```

## Data Models

### UserDevice (`user_devices`)
- `id` (uuid PK), `tenant_id`, `organization_id` (nullable), `user_id`
- `device_id` (client-supplied stable id, e.g. iOS `identifierForVendor`), `platform` (`ios|android|web`)
- `client_app_version`, `os_version`, `locale` (text|null)
- `push_token` (text|null, **encrypted at rest**), `push_provider` (text|null), `push_token_updated_at`
- `last_seen_at`, `created_at`, `updated_at`, `deleted_at`
- Unique (non-deleted): `(tenant_id, coalesce(organization_id, nil-uuid), user_id, device_id)`
- Optimistic-locked on metadata edits; deactivate is exempt (idempotent soft-delete of a registry row has no lost-update risk).

### NotificationType (`notification_types`)
- `id` (string PK, e.g. `orders.shipped`), `tenant_id` (nullable for system-wide)
- `label_key`, `description_key` (i18n keys), `category` (free-form string|null)
- `silent`, `non_opt_out`, `hidden_from_settings` (bool)
- Type IDs are **FROZEN** per `BACKWARD_COMPATIBILITY.md`.

### NotificationPreference (`notification_preferences`)
- `id` (uuid PK), `tenant_id`, `user_id`, `notification_type_id`, `channel` (free-form), `enabled`
- Unique: `(tenant_id, user_id, notification_type_id, channel)`; absent row ⇒ enabled.

### Notification (`notifications`) — additive columns
- `channels` (JSONB|null — the resolved delivery-channel set; `NULL` ⇒ all channels / visible)
- `data` (JSONB|null — arbitrary app-readable string map), `push_options` (JSONB|null — push-only)

### PushNotificationDelivery (`push_notification_deliveries`)
- `id` (uuid PK), `tenant_id`, `organization_id`, `notification_id` (soft FK|null), `notification_type_id`
- `user_device_id` (soft FK via `data/extensions.ts`), `user_id`
- `provider` (snapshot), `token_snapshot` (**last 8 chars only**), `silent` (bool)
- `status` (`pending|sending|sent|failed|skipped|expired`), `attempts`, `last_error`, `next_retry_at`
- `payload` (JSONB), `provider_response` (JSONB|null), `created_at`, `sent_at`, `updated_at`
- Append-only; optimistic-lock exempt. Cross-module references use `defineLink`, never a direct ORM relationship.

## API Contracts

Schemas live in each module's `data/validators.ts` (zod); every route exports `openApi`.

| Method & path | ACL | Notes |
|---|---|---|
| `POST` / `GET /api/devices` | `devices.manage` / `devices.view` | Idempotent upsert; caller's own devices, active org |
| `PUT` / `DELETE /api/devices/:id` | `devices.manage` | Owner-only; 404 outside active org |
| `GET|POST /api/devices/admin/devices` | `devices.admin` | Org-scoped; `?userId=`, `?platform=` |
| `GET|PUT|DELETE /api/devices/admin/devices/:id` | `devices.admin` | 403 outside org scope |
| `GET /api/notifications/types` | authed | Tenant-filtered; excludes `hiddenFromSettings` types |
| `GET /api/notifications/channels` | `notifications.view` | Registry-driven |
| `GET|PUT /api/notifications/preferences` | `notifications.manage_preferences` | PUT sends only the diff; `setPreferences` refuses opt-out rows for `nonOptOut` types |
| `GET|PUT /api/notifications/admin/preferences?userId=` | `notifications.manage_user_preferences` | Target gated by `assertActorCanAccessUserTarget` (tenant **and** org) |
| `GET /api/push_notifications/deliveries[/:id]` | `push_notifications.view_deliveries` | Read-only; never exposes the full token |
| `POST /api/push_notifications/custom-send` | `push_notifications.send_custom` | Returns `200` + `enqueued: 0` + `no_matching_devices_in_scope` on the no-op branch |
| `POST /api/communication_channels/channels/connect/tenant-credentials` | `communication_channels.connect_tenant_channel` | The only path that connects a push provider |

```ts
// PUT /api/devices/:id — null clears the token (user revoked OS permission)
const UpdateDeviceSchema = z.object({
  clientAppVersion: z.string().optional(),
  osVersion: z.string().optional(),
  pushToken: z.string().min(1).nullable().optional(),
  pushProvider: z.string().min(1).nullable().optional(),
})

// PUT /api/notifications/preferences
const UpdatePreferencesSchema = z.object({
  preferences: z.array(z.object({
    notificationTypeId: z.string(),
    channel: z.string(),
    enabled: z.boolean(),
  })),
})
```

## Migration & Backward Compatibility

**Purely additive across every contract surface** in `BACKWARD_COMPATIBILITY.md`. Nothing is removed, renamed, or narrowed, so no deprecation bridge is required — with one deprecation and one intentional corrective behavior change, both below.

- `packages/shared/.../notifications/types.ts` — 6 new **optional** fields on `NotificationTypeDefinition` (`labelKey`, `descriptionKey`, `category`, `silent`, `nonOptOut`, `hiddenFromSettings`), plus optional `channels` eligibility and `NotificationDto.data`. Required fields untouched.
- `notifications/data/entities.ts` — 3 new **nullable** JSON columns on `Notification` (`channels`, `data`, `push_options`); 2 brand-new tables.
- `auth/notifications.ts` — `nonOptOut: true` set on 2 existing security types. Type IDs unchanged; per-channel preferences arrive in this same branch, so there is no prior opt-out behavior to regress.

**Deprecation.** `NotificationDeliveryContext` splits into a channel-agnostic `NotificationDeliveryContextCore` and `EmailDeliveryExtras` (`panelUrl`, `panelLink`, `actionLinks`, `recipient.email`). The flat intersection is retained so existing strategies compile and run unchanged; the email-shaped fields are `@deprecated` and move behind an email-scoped accessor in a future major.

**Intentional corrective behavior change.** Per-channel opt-out and the `nonOptOut`/`silent` flags are now enforced on **every** channel, not just push. Previously, disabling `in_app` or `email` for a type was silently ignored. A user who never changed their preferences sees no difference (preferences default to on). `Notification.channels` becomes authoritative rather than merely descriptive; legacy `NULL` rows and untargeted sends behave exactly as before. A shared tenant-wide (`organization_id = NULL`) push channel is now visible and deletable from any org in the tenant — previously it was unmanageable and could not be removed at all.

**Database safety (fork-safe, no backfill).** Every migration is `CREATE TABLE`, `ADD COLUMN ... NULL`, or `ADD COLUMN ... NOT NULL DEFAULT <const>`. The only pre-existing core table touched is `notifications` (nullable JSON adds). No rename, drop, type-narrowing, or index removal.

**Post-merge:** run `yarn mercato auth sync-role-acls` for the new ACL features. Forks adopting these modules replicate the `modules.ts` entries and run `yarn generate` — expected app boilerplate, not a contract change.

## Implementation Plan

Each phase is a self-contained, demoable vertical slice that ships its own admin UI. The phase list is the unit of work and review; the branch ships as one PR.

| Phase | Scope | Status |
|---|---|---|
| 1 | `devices` module — entities, migrations, APIs, ACL, setup | Done |
| 2 | `notifications` extensions — type catalogue, preferences, both preference UIs | Done |
| 3 | `push_notifications` rails — delivery log, `push` strategy, worker, `push_stub`, delivery-log UI | Done |
| 4 | Provider adapters (`channel-{fcm,apns,expo}`) + `push_token` encryption at rest | Done |
| 5 | Silent push + flexible push payload (`data`, `pushOptions`) | Done |
| 6 | Per-device locale, admin custom send, hygiene | Done |
| 7 | Unify **all** channels on the delivery-strategy seam | Done |
| 8 | Provider-adapter e2e coverage without live credentials | Done |

**Phase 4** was re-scoped mid-review — an 82-file PR was judged unreviewable, so it split into a core-only contract PR (`BasePushChannelAdapter`, `push-capabilities`, `readPushEnvelope`, token encryption, per-device provider routing) plus three independent provider PRs, mergeable in any order once the core landed.

**Phase 7** shipped in ordered sub-phases: (7.0) the additive `Notification.channels` column and per-type eligibility; (7.1) the single `shouldDeliver` gate; (7.2) the module-registered channel catalogue and registry-driven preferences UI; (7.3) in-app and email extracted into first-class strategies, with `isConfigured`/`supports` capability hooks and the context split; (7.4) the gate wired at create time, and push's now-redundant inline gate deleted; (7.5) in-app visibility applied to the inbox, unread count, `markAllAsRead`, and the bell SSE; (7.6) coverage.

> Broadcast paths resolve channels for the whole recipient set *before* the write transaction, reusing one forked EM (R forks → 1). The remaining R×C preference reads are inherent to the default-on per-user/per-channel model; a set-keyed batch query is a follow-up if broadcast size warrants it.

**Phase 8** makes each adapter's already-exported client seam installable from `OM_PUSH_FAKE_PROVIDERS` via each package's `di.ts`, copying the `ensurePushStubAdapterRegistered()` production-safety pattern (no-op unless the flag is set, never installed at import, inert in production). Installing in `di.ts` `register()` is safe because `createRequestContainer()` runs every registrar and the queue builds a fresh container per job — a hard barrier before the first `sendMessage`. The registry is a `globalThis` singleton *per process* and the worker runs in its own process, so the flag must reach both harness env blocks. `push_stub`, `TC-PUSH-003`, and `TC-CHANNEL-PUSH-001..004` are untouched.

### Testing Strategy

Integration specs are colocated in `__integration__/`, self-contained (fixtures created in setup, cleaned in teardown), and gated by a sibling `.meta.ts` where they need an env flag.

| Spec | Covers |
|---|---|
| `TC-DEV-001..008` | Self-serve + admin trees, `last_seen_at` presence semantics, optimistic lock, org dimension, `push_token` encryption at rest, admin cross-org denial |
| `TC-NOTIF-011..014` | Type catalogue, preferences round-trip, `data`/`pushOptions` payload, in-app/email opt-out + per-send channel targeting |
| `TC-PUSH-001..003` | Delivery-log ACL/scoping/token secrecy; admin custom send; real pipeline → `sent` (org propagation) via `push_stub` |
| `TC-PUSH-004..009` | Real adapters: `unregistered` → `failed` + device soft-deleted; `fail` → `MAX_ATTEMPTS` → `expired`, device survives; silent → data-only; `pushOptions` round-trip; Expo async receipt → device pruned; admin send page → delivery log |
| `TC-CHANNEL-PUSH-001..004` | Each adapter registered and reachable through the real credential-connect route (fcm carries two: per-user refusal + tenant-wide connect) |
| `TC-CHANNEL-PUSH-005..007` | Each **real** adapter drives a delivery to `sent` and records a correct provider-native message (`aps.badge`, `apns-push-type: background`, `android.notification.channelId`, Expo `sound`/`priority`) |

Unit suites cover each adapter's success / transient / permanent-token mappings, the gate, both new strategies, the channel registry, and — via `message-golden.test.ts` — serialization drift in our own message builders.

Three harness notes. `TC-PUSH-005` cannot reach its terminal state in one drain, because each retry re-enqueues behind exponential backoff + jitter; it drains repeatedly inside an `expect.poll`. `TC-PUSH-008` needs the receipt reaper, which no scheduler runs under Playwright (the spec enqueues a tick itself) and which skips rows younger than `OM_PUSH_RECEIPT_MIN_AGE_MINUTES` (the harness pins it to `0`). And any spec whose own waits approach a minute must call `test.setTimeout(...)` explicitly: `test.slow()` merely triples the config's `timeout: 20_000`, so a 60s poll inside a `slow()` test consumes the entire budget and the test dies before the poll can reach its deadline.

**Locating `CrudForm` fields from a UI spec.** `CrudForm` renders a field's `<label>` as a sibling of the control, with no `htmlFor` and without wrapping it, so `page.getByLabel(...)` never resolves a CrudForm field. `ComboboxInput` likewise renders its suggestions as `<Button>`s in a popover rather than ARIA `option`s. Locate the field through its label's wrapper and click suggestions by their visible label.

**Fake-sink safety.** The JSONL sink is append-only and is **not** truncated on the reused-environment path. A compile-time-constant token tail would let a *previous* run's entry satisfy an assertion before this run's worker wrote anything — a false pass, which is worse than a failure because it hollows out the evidence the phase exists to produce. Two guards, both required: every spec draws a run-unique tail from `uniquePushTokenTail()` (`crypto.randomBytes`), and `findFakePush(provider, tail, sinceIso)` rejects entries older than the caller. Reads skip malformed lines, since a reader can observe a line the writer has not finished appending.

## Risks & Impact Review

#### Push token leaks through a generic platform surface
- **Scenario**: A surface that echoes write payloads or snapshots back to clients — audit-log `snapshotBefore`/`snapshotAfter` and the derived `changesJson` via `audit_logs.view_self`, or enterprise record-lock conflict details — carries the raw token. Admin register-on-behalf is the sharpest case: the snapshot would hold another user's token.
- **Severity**: High · **Affected area**: `devices`, `audit_logs`, enterprise mutation guard
- **Mitigation**: Encrypted at rest; redacted from persisted command snapshots; stripped from the mutation-guard payload; never in any list/detail field set; retained only in the non-exposed undo payload. Asserted by `devices/__tests__/push-token-redaction.test.ts`.
- **Residual risk**: Low.

#### A payload bug soft-deletes every device in the tenant
- **Scenario**: A provider error that is *not* actually a permanent token error is mapped to `device_unregistered`; the worker then soft-deletes each targeted device. FCM's `messaging/invalid-argument` is returned for any malformed request field.
- **Severity**: High · **Affected area**: `push_notifications` worker, `devices`
- **Mitigation**: Only `registration-token-not-registered` and `invalid-registration-token` are permanent for FCM. `invalid-argument` falls through to the retryable path. Every mapping is unit-tested per adapter and exercised end-to-end in `TC-PUSH-004`.
- **Residual risk**: Low.

#### Duplicate push from an at-least-once queue
- **Scenario**: The dispatch subscriber is at-least-once, so redelivery re-runs the strategy; and a reaper that reclaims an in-flight `sending` row causes a double send.
- **Severity**: Medium · **Affected area**: `push_notifications` worker
- **Mitigation**: Atomic `pending → sending` claim; fan-out inserts use `ON CONFLICT DO NOTHING`; `attempts` increments at claim so `MAX_ATTEMPTS` holds across crashes; `OM_PUSH_STUCK_RECLAIM_MINUTES` floored at 1 (a `0` re-opened actively-sending rows).
- **Residual risk**: Low. The invariant `send timeout < reclaim minutes` is documented, not enforced.

#### Cross-org credential orphaning
- **Scenario**: Tenant-wide push credentials keyed by the connecting admin's selected org, while channel dedup is org-agnostic — an org-B key rotation writes a credential row the delivery path never reads, and push silently stops.
- **Severity**: High · **Affected area**: `communication_channels`, `push_notifications`
- **Mitigation**: Tenant-scoped credentials are pinned to `organizationId = tenantId` and the channel row stores `organization_id = NULL`, so read and write land on the same key. Covered by `2026-07-03-push-channels-tenant-scope.md`.
- **Residual risk**: Low.

#### Privilege escalation onto the shared push channel
- **Scenario**: A non-admin holding only `connect_user_channel` posts FCM credentials to the per-user connect route and mints or overwrites the tenant-wide push channel.
- **Severity**: High · **Affected area**: `communication_channels`
- **Mitigation**: The connect command refuses a tenant-scoped provider arriving with a non-null `userId` (`wrong_scope_for_route` → 403) instead of silently downgrading; the per-user route short-circuits tenant-scoped providers with 403.
- **Residual risk**: Low.

#### Cross-org push silently drops
- **Scenario**: Notifications are stamped with the *creator's* org, and the push strategy scopes the recipient's device lookup to that org. An admin in org A notifying a user whose devices live in org B delivers in-app but no push.
- **Severity**: Medium · **Affected area**: `push_notifications`
- **Mitigation**: Same-org and self are the paths in use; skipped devices are warn-logged with a count so a provider-config gap is diagnosable. Scoping the device lookup by the *recipient's* org is the fix if cross-org push is ever required.
- **Residual risk**: Medium — accepted, documented, not yet exercised.

#### Lazy preference seeding surprises existing users
- **Scenario**: A new notification type is registered; every existing user is opted in by default.
- **Severity**: Medium · **Affected area**: UX
- **Mitigation**: Default-on is a documented contract. Apps wanting default-off insert explicit `enabled=false` rows at type registration.
- **Residual risk**: Low.

#### `push_notification_deliveries` grows unbounded
- **Scenario**: Every push writes an append-only row; no purge exists.
- **Severity**: Medium · **Affected area**: Storage
- **Mitigation**: A 90-day purge worker is specified but deferred.
- **Residual risk**: Medium until the purge ships.

#### Notification type IDs are FROZEN — a typo sticks forever
- **Scenario**: A misspelled type ID is registered and mirrored to `notification_types`; mobile clients bind to it.
- **Severity**: High · **Affected area**: BC contract
- **Mitigation**: The frozen-id contract is documented in the module `AGENTS.md`. No new IDs are minted here — the DB mirrors the existing in-memory aggregate. Rename tooling is left to a future spec.
- **Residual risk**: Low.

#### Provider-client cache leaks sockets or poisons itself
- **Scenario**: An unbounded cache keyed by credentials hash leaks an HTTP/2 socket (APNs) or an OAuth refresh timer (FCM) per key rotation; and a rejected init promise stays cached forever, so every later `getApp()` returns the cached rejection until the process restarts.
- **Severity**: Medium · **Affected area**: `channel-{fcm,apns,expo}`
- **Mitigation**: LRU-bounded at 32 with `shutdown()`/`app.delete()` on eviction; rejected promises self-evict.
- **Residual risk**: Low.

#### Conformance drift with the real providers
- **Scenario**: Our belief about a provider's payload shape is wrong. Every fake accepts it identically and CI stays green.
- **Severity**: Medium · **Affected area**: `channel-{fcm,apns,expo}`
- **Mitigation**: None available in CI, under *any* option — a fake server has the same blind spot, since its schema is also our own belief. Drift in **our** builders is caught by golden-file assertions against each provider's published reference. Drift in **theirs** stays a manual live-key check.
- **Residual risk**: Medium — stated deliberately; a periodic live smoke test is the only closure.

## Deferred Follow-ups

Raised in review, intentionally not in scope here.

| Item | Why deferred |
|---|---|
| Delivery-log purge worker (90-day default) + range partitioning | Storage hygiene; no app has hit the volume yet. |
| Web push (browser Push API) | Plausible follow-up; needs its own credential and subscription model. |
| Email/SMS channel modules | The registry, preferences, and strategy seam are shaped to accept them additively. |
| Governance: `priority`, `group_key`, daily/weekly frequency caps (`FrequencyGuardService`) | A clean upstream design for how these compose with per-channel preference rows is still open. `category`, `non_opt_out`, `silent`, and `hidden_from_settings` are implemented. |
| GDPR data-export collectors + consumer-deletion purge for push data | Cross-cutting; belongs with a platform-wide GDPR pass. |
| Cross-user token handoff (deactivate a token that reappears under another user) | Rare; needs a decision on which user wins. |
| Actionable push buttons | Feasible, not blocked. iOS registers `UNNotificationCategory` client-side (backend only picks the category); Android has no OS-level category→buttons and must build them from a data message via Notifee. The clean design projects the existing `NotificationTypeDefinition.actions` onto push rather than inventing a parallel `pushOptions.category` — one action model for in-app + iOS + Android. Parked on client-side work and an i18n decision, and it cannot be verified end-to-end in the current harness (Android emulator + FCM only). |
| `delivered` delivery state (device-confirmed receipt) | `sent` means the provider *accepted* the message. Only a client ack (delivery id echoed in the push `data`, posted back to a device-scoped, replay-guarded route) truly confirms receipt — APNs and FCM expose no device-delivery receipt, and Expo's receipts confirm handoff only. Deferred because the authoritative path is client-driven and not e2e-verifiable here. |
| Un-skipping `TC-CHANNEL-EMAIL-027/028` via the Phase-8 technique on `setImapClient`/`setSmtpClient` | Kept out of scope so this PR does not expand into `channel-imap`. |
| A fake push provider *server* | Rejected on testing grounds (§ Alternatives Considered). The stronger case would be **product**: giving a downstream mobile app a live endpoint to develop against. Revisit on that basis. |
| RFC-4122-correct `stableScheduleUuid` | The helper is a verbatim copy of the `communication_channels` original and produces a uuid-*shaped* string Postgres accepts. Kept identical on purpose; fixing it is a cross-cutting change to both modules. |
| Wiring or removing `channel_{fcm,apns,expo}.{view,configure}` ACL features | Granted in each package's `setup.ts` but never consulted by a `requireFeatures` guard — the connect flow uses `communication_channels.connect_tenant_channel`. Brand-new and unmerged, so not yet a BC concern. |

## Final Compliance Report — 2026-07-09

### AGENTS.md Files Reviewed
- `AGENTS.md` (root), `BACKWARD_COMPATIBILITY.md`
- `packages/core/AGENTS.md`, `packages/shared/AGENTS.md`, `packages/ui/AGENTS.md`
- `packages/core/src/modules/{communication_channels,notifications,customers}/AGENTS.md`
- `packages/{queue,events,cli}/AGENTS.md`, `.ai/qa/AGENTS.md`, `.ai/specs/AGENTS.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | `defineLink` in `data/extensions.ts`; cross-module reads via DI tokens |
| root AGENTS.md | Filter by `organization_id` for tenant-scoped entities | Compliant | Standard `orgField: 'organizationId'` on every list route |
| root AGENTS.md | Validate inputs with zod in `data/validators.ts` | Compliant | |
| root AGENTS.md | Use `findWithDecryption` / `findOneWithDecryption` | Compliant | Every device read that serializes the token |
| root AGENTS.md | Never hard-code user-facing strings | Compliant | `i18n/{en,de,es,pl}.json` per module |
| root AGENTS.md | No hardcoded status colors / arbitrary text sizes | Compliant | Delivery-log + preference pages use status tokens |
| root AGENTS.md | Boolean parsing via `parseBooleanToken` | Compliant | `OM_PUSH_FAKE_PROVIDERS`. Pre-existing `isPushStubEnabled()` / `ensureTestSeedAdapterRegistered()` retain a hand-rolled check — separate cleanup |
| root AGENTS.md | Optimistic locking on new user-editable entities | Compliant | `UserDevice` version-checked on update; deactivate exempt (idempotent soft-delete); delivery rows append-only |
| packages/core/AGENTS.md | All API routes export `openApi` | Compliant | |
| packages/core/AGENTS.md | Write routes use the Command pattern or `makeCrudRoute` | Compliant | Devices via command bus; preferences via mutation guard (mirrors `settings`) |
| packages/core/AGENTS.md | `AGENTS.md` ships with each new module | Compliant | `devices` + three `channel-*` packages; `notifications/AGENTS.md` covers new surfaces |
| BACKWARD_COMPATIBILITY.md | Type IDs FROZEN; API URLs STABLE; columns additive-only | Compliant | No new type IDs minted |
| BACKWARD_COMPATIBILITY.md | Deprecation protocol for contract changes | Compliant | `NotificationDeliveryContext` split ships behind an `@deprecated` flat-intersection bridge |
| .ai/qa/AGENTS.md | Integration tests self-contained, colocated | Compliant | Fixtures created in setup, cleaned in teardown |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Data models match API contracts | Pass | Token never appears in any response schema |
| Risks cover all write operations | Pass | Register/update/deactivate, preference writes, channel connect, delivery claim |
| Commands defined for all mutations | Pass | Devices via command bus; preferences deliberately via mutation guard, per the `settings` precedent |
| Phases in the plan match shipped code | Pass | 1–8 all implemented |
| Deferred items are not silently implied as done | Pass | Consolidated in § Deferred Follow-ups |

### Verdict

**Compliant, with the integration suite repaired.** When Phase 8 landed, its Playwright specs had **never been executed** (no Docker in the authoring environment). Running them for the first time on 2026-07-09 exposed four defects in the specs themselves — not in the shipped code — all fixed and re-verified; see the Changelog entry below.

Three caveats are recorded rather than waived:
- Conformance with the real providers is untestable in CI under any option (§ Risks).
- `yarn lint` covers only `apps/mercato`, because no package in the repo defines a lint script.
- Under the **full** parallel integration suite (32 tests across `push_notifications` + the three channel packages) the worker-dependent specs timed out, while the same specs pass in 3.4 min when scoped to `push_notifications` alone. This points at resource contention rather than a logic fault, but CI runs the suite sharded, so it must be confirmed before merge.

## Changelog

### 2026-07-09
- **First real execution of the Phase 8 integration suite — four spec defects found and fixed.** The specs had never run (the authoring environment had no Docker), so drift accumulated unnoticed across PRs #30 and #38. None of the defects were in shipped code; all four were in the specs. (1) `TC-PUSH-002` asserted `201` on the custom-send no-op branch, which PR #38 deliberately changed to `200 OK` so a caller can distinguish "sent" from "matched nobody" — the spec now asserts `200` plus `warning: 'no_matching_devices_in_scope'`. (2) `TC-CHANNEL-PUSH-003` (APNs) and (3) `TC-CHANNEL-PUSH-004` (Expo) still asserted `422` from the **per-user** connect route, which PR #30 changed to `403 provider_is_tenant_scoped` when it made push providers tenant-scoped; the FCM sibling was updated then, these two were not. Both now assert `403` on the per-user route and were given a **tenant**-route case so the adapter's own `validateCredentials` (→ `422`) is still covered — Expo keeps its wrong-typed `accessToken`, because its all-optional credentials mean an empty `{}` would validate and create a stray channel. (4) `TC-PUSH-009` used `page.getByLabel(...)` and `getByRole('option')`, neither of which can ever resolve against `CrudForm`: its `<label>` is a sibling of the control with no `htmlFor` (`CrudForm.tsx:4234`), and `ComboboxInput` renders suggestions as `<Button>`s, never ARIA `option`s. Rewritten to locate the field through its label's wrapper. Separately, `TC-PUSH-005` and `TC-PUSH-009` were **mis-budgeted**: `test.slow()` only triples the config's `timeout: 20_000` to 60s, which their own 60s poll (resp. 30s poll plus two 30s visibility waits) would consume entirely, leaving nothing for setup — both now call `test.setTimeout(120_000)`.
- **Spec rewritten for readability.** Restructured onto `.ai/skills/om-spec-writing/references/spec-template.md`. Rationale that previously lived in prose, strikethrough edit-scars, and changelog entries is consolidated into § Design Decisions and § Alternatives Considered. Removed the superseded `PushProvider` interface draft (never built — the hub's `channelAdapterRegistry` is the seam), the stale "§2c DEFERRED" heading (implemented in Phase 7.2), the duplicated Phase 7/8 narratives, and the resolved Open Questions. Risks converted to the required Risk Register format; a Final Compliance Report replaces the per-phase checklists. No behavior or code change.
- **Phase 8 implemented — provider-adapter e2e coverage without live credentials.** Test-only, fully additive. Each channel package gains `lib/fake-provider.ts` with `ensure{Fcm,Apns,Expo}FakeProviderInstalled()`, called from its `di.ts` `register()` behind `OM_PUSH_FAKE_PROVIDERS`. The fake swaps **only the SDK client** — never `registerChannelAdapter`, which throws on a duplicate provider key — so the real adapter's message construction, credential parsing, client caching, and error→sentinel mapping all execute. Both open design questions resolved during implementation, the second **against** the spec's stated preference: the native message cannot ride `provider_response` (no adapter returns `metadata` on success; APNs deliberately hardcodes an empty `externalMessageId` that must never carry token material), so the fakes append to a JSONL sink at `<QUEUE_BASE_DIR>/push-fake-messages.jsonl`. New: `TC-CHANNEL-PUSH-005..007`, `TC-PUSH-004..009`, per-package `message-golden.test.ts` and `fake-provider.test.ts` (including an inertness case proving the flag-less `ensure…()` installs nothing).
- **Phase 8 review fixes.** Seven self-review findings, two of which changed the design: a **false pass** from the un-truncated sink on the reused-environment path (fixed with `crypto.randomBytes` run-unique token tails plus a `since` filter), and an **APNs golden fidelity gap** — the fixture built against `{}` instead of a real `apn.Notification`, pinning a projection node-apn never serializes. Fixing it caught a wrong assumption: custom `data` rides as top-level keys beside `aps` on every branch, not just silent. Also: `isDeviceSoftDeleted` returned `true` for a missing row, making the headline assertion of `TC-PUSH-004`/`008` vacuous.

### 2026-07-07
- Reconciled `TC-CHANNEL-PUSH-*` numbering (fcm carries `001`+`002`; apns `003`; expo `004`).
- Aligned the three channel packages to the monorepo's lockstep `0.6.5`, unblocking `check-version-alignment.sh`.

### 2026-07-06
- **Phase 7 implemented — all channels unified on the delivery-strategy seam.** In-app and email extracted into first-class strategies; the single `shouldDeliver` gate; the module-registered channel catalogue; `Notification.channels` made authoritative. One intentional corrective behavior change (per-channel opt-out and `nonOptOut`/`silent` now enforced everywhere). Two spec-vs-code divergences corrected: `Notification.channels` did not previously exist, and the §2c catalogue — documented as deferred — had never been built.
- **Merge-readiness pass.** `create-app` template registers `devices` + `push_notifications`; the three channel packages declare their React/UI deps; `TC-PUSH-003` locks in the `resolveNotificationContext` org-propagation fix at the integration layer.

### 2026-07-03
- Push-provider channels made tenant-wide (`channelScope: 'tenant'`, `organization_id = NULL`, credentials pinned to `organizationId = tenantId`). Closed a privilege-escalation bypass on the per-user connect route and a cross-org credential-orphaning bug. See the companion spec.

### 2026-07-01
- Three e2e blockers found and fixed with real FCM keys: notifications were always created tenant-level so org-scoped devices never matched; the worker resolved channel credentials under the wrong organization; encrypted columns were not decrypted on the delivery read path. See the companion spec.

### 2026-06-30
- **`sendSilentPush` removed.** Silent push now rides the ordinary `notificationService.create()` flow — the in-app row is written and preferences still apply. `silent` controls delivery *style*, not enforcement; only `nonOptOut` bypasses the gate.

### 2026-06-26
- Phase 5 implemented (silent push, arbitrary `data`, flat `pushOptions`), plus `category`, `non_opt_out`, `silent`, and `hidden_from_settings` type metadata.
- Phase 4 review corrections: FCM `messaging/invalid-argument` de-scoped from the permanent-token set; APNs stopped leaking a 12-char token slice through `externalMessageId`; Expo's receipt-phase `DeviceNotRegistered` documented (polling landed later).

### 2026-06-25
- **Module 3 re-architected** to deliver push through the `communication_channels` hub (FCM/APNs/Expo as hub `ChannelAdapter`s), per the maintainer's request on upstream PR #2595. The standalone `PushProvider` interface is dropped. Verified feasible with no `ChannelAdapter` contract change.
- Admin UI split per phase, so every phase is a demoable vertical slice.

### 2026-04-28
- Initial specification. Verified via `gh search` that no existing upstream issue or PR covers push, devices, preferences, or a persistent type registry.
