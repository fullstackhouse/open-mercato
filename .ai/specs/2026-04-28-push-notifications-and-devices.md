# Push Notifications and Devices Modules

**Status:** In progress — Phase 1 (`devices` module) complete (`TC-DEV-001` + `TC-DEV-002` colocated); **Phase 2 (`notifications` extensions) complete** (`TC-NOTIF-011` colocated; type catalogue + preferences on `feat/devices-push-e2e`); **Phase 3 (`push_notifications` rails + delivery-log UI) complete** (`push` delivery strategy + delivery log + `send-push` worker + `push_stub` adapter + read-only delivery-log API/UI; `push-delivery`/`push-delivery-strategy` unit suites + `TC-PUSH-001` API suite colocated); Phases 4–6 pending. **Module 3 architecture revised 2026-06-25** to deliver push **through the `communication_channels` hub** (FCM/APNs/Expo as hub `ChannelAdapter`s) per maintainer request on PR #2595 — see "Module 3" below and the 2026-06-25 changelog entry. Targeting `develop`; one PR per phase.
**Date:** 2026-04-28
**Author:** Jacek Tomaszewski (`@jtomaszewski`)
**Related:** `packages/core/src/modules/notifications/` (in-app notifications, #412), `#539` (security/MFA — future device-trust consumer)

## TLDR

- Open Mercato currently ships only **in-app** notifications. There is no mobile push channel, no device-token registry, no DB-persistent notification type registry, and no per-channel user preferences.
- This spec proposes:
  - **Two new core modules**:
    - `@open-mercato/core/modules/devices` — generic per-tenant `(user, device, platform)` registry. Push is one consumer; MFA device trust (#539) and session-aware auth/audit logs are plausible future consumers.
    - `@open-mercato/core/modules/push_notifications` — push-token registry, mobile push delivery strategy, provider-pluggable sender (FCM + APNs reference providers), retry worker.
  - **A minimal extension to the existing `notifications` module**: a DB-backed notification type registry and a channel-agnostic preferences table. Designed so future channels (email/SMS) plug in without schema changes.
- The design is informed by a production implementation already running in a downstream app; ports are validated, not green-field. App-specific concerns (hard-coded categories, app i18n keys, deploy env wiring) are stripped before landing in core.
- Verified 2026-04-28 (`gh search`): no existing upstream issue/PR covers push, devices, preferences, or a persistent type registry.

**Out of scope:**
- Web push (browser Push API). Plausible follow-up.
- Email and SMS channels. Spec designs preferences/registry to accommodate them additively, but no implementation here.
- **Notification governance tier — deferred to a later spec** (see "Downstream Parity Review" below). Specifically: notification **categories**, **priority**, **`non_opt_out`** (server-side opt-out enforcement), the **`silent` / `hidden_from_settings` / `group_key`** type-metadata fields, **daily/weekly frequency caps** (`FrequencyGuardService`), **silent push** (content-available wake-ups that carry no `Notification` row and bypass preferences/caps), and **admin custom / one-off send** (`admin.custom_message` type + send page + API + command). Phase-1 governance is just "user can toggle a type off per channel." These all exist in the downstream `user_notifications` module, but a clean upstream implementation approach is still open, so they are intentionally deferred and reintroduced when an app hits a real need. **Silent push is the highest-priority item** in this deferred set.
- Delivery-table **range partitioning** + scheduled partition worker, **GDPR data-export / consumer-deletion purge** for push data, per-device **locale** resolution + title/body rewrite, and **cross-user token-handoff** deactivation on register — all present downstream, deferred here (the delivery-table purge is already tracked as Phase 6).
- Reworking the existing in-app `notifications` module's runtime — we extend it, we don't replace anything.

## Overview

Today, an Open Mercato app that wants to deliver mobile push must build the following itself:
1. A device-token store keyed by `(tenant, user, device)`.
2. A delivery strategy registered into the notifications module's strategy seam.
3. An FCM/APNs sender wrapper.
4. A type registry that mobile clients can read (so a settings screen can render the catalogue without a hard dependency on server source code).
5. Per-user, per-channel preference toggles.
6. A worker for retryable delivery with exponential backoff.

That is a lot of infrastructure — and it is the same in every app. This spec splits the work along channel-agnostic vs. channel-specific lines:

- **Channel-agnostic** (lives in existing `notifications` module): type registry, preferences. Future email/SMS modules read from the same tables.
- **Channel-specific** (lives in new `push_notifications` module): tokens, delivery rows, sender, worker, provider seam.
- **Cross-cutting** (new `devices` module): device identity, reusable beyond push.

## Problem Statement

### Gaps in the current `notifications` module

- `NotificationTypeDefinition` is **in-memory only**. A mobile app cannot enumerate types via API to render a preferences screen — it would have to ship a copy of the catalogue.
- No notion of **user preferences** per channel: `Notification.channels` is fixed at creation time; users cannot opt out per type.
- No **mobile push** delivery strategy.
- No **device registry**. There is no first-class `(user, device, platform)` entity, no `is_active` lifecycle, no platform metadata.

### Why a separate `devices` module

A device registry is useful beyond push:
- **MFA device trust** (#539) — "trusted device" lists.
- **Session-aware auth** — bind sessions to a registered device.
- **Audit logs** — attribute actions to a known device.

Folding device storage into `push_notifications` would force these consumers to depend on the push module. Splitting them is a one-time cost paid in two extra files for clear reuse downstream.

### Why pluggable push providers

FCM + APNs are the obvious defaults but not universal:
- Expo apps need the Expo push API.
- Some apps standardize on OneSignal / Pushwoosh.
- Test/dev environments want a stub provider.

A `PushProvider` interface lets apps register additional providers in `di.ts` without forking the core module.

### Why preferences and registry live in `notifications`

Preferences are inherently cross-channel. If they lived in `push_notifications`, a future `email_notifications` module would either duplicate the table or take a hard dependency on `push_notifications` — both wrong. Keeping them in the channel-agnostic module means each channel reads the same source of truth via a small DI-injected service.

The same logic applies to the type registry: there is one catalogue of "things a system can notify a user about." In-app, push, and future channels are *renderings* of the same catalogue.

## Proposed Solution

### Module 1 — `@open-mercato/core/modules/devices` (new)

Generic device registry. Owns `(tenant, user, device, platform)` and lifecycle. Push-token storage **does not live here** to keep the module channel-agnostic.

**Entities:**
- `UserDevice` (`user_devices`)
  - `id` (uuid PK), `tenant_id`, `organization_id` (nullable), `user_id`
  - `device_id` (client-supplied stable id, e.g. iOS `identifierForVendor`), `platform` (`ios|android|web`)
  - `client_app_version`, `os_version` (text|null)
  - `push_token` (text|null), `push_provider` (text|null — `fcm|apns|expo|...`), `push_token_updated_at` (timestamptz|null)
  - `last_seen_at` (timestamptz)
  - `created_at`, `updated_at`, `deleted_at`
  - Unique: `(tenant_id, user_id, device_id)` for non-soft-deleted rows.

"Active" means `deleted_at IS NULL`. Push delivery additionally requires `push_token IS NOT NULL`.

**`push_token` is a secret.** It is never returned by list/detail responses (only `push_provider` and `push_token_updated_at` are exposed). Because the registry's writes go through the command bus, the token is also redacted (`'[redacted]'`) from the `snapshotBefore`/`snapshotAfter` the commands persist on each audit-log entry — and therefore from the `changesJson` the command bus derives from those snapshots — so it cannot leak through the `audit_logs.view_self` API (notably for admin register-on-behalf, where the snapshot would otherwise hold another user's token). It is likewise stripped from the mutation-guard payload so it cannot surface in enterprise record-lock conflict details returned to a conflicting client. The real token is retained only in the internal undo payload (which no API exposes), so register/update/deactivate stay fully undoable — undo/restore writes the original token back unchanged. The admin register form renders the token field as a password input.

**APIs** — split into self-serve and admin trees, matching the codebase convention (`customer_accounts/api/admin`, `staff/api/.../self`). *(As implemented; the original draft listed all verbs under `/api/devices`.)*

Self-serve (`devices.view` / `devices.manage`) — always scoped to the acting user:
- `POST /api/devices` — register/upsert the **caller's own** device. Idempotent on `(tenant, user, device_id)`; revives a soft-deleted row. Accepts optional `pushToken`/`pushProvider`.
- `GET /api/devices` — the caller's own devices only (does **not** honor `?userId`).
- `PUT /api/devices/:id` — **owner-only** update of `last_seen_at`, `client_app_version`, `push_token`, `push_provider`. Setting `push_token` to `null` signals revoked OS permission.
- `DELETE /api/devices/:id` — **owner-only** soft-delete.

Admin (`devices.admin`) under `api/admin/devices`:
- `GET /api/devices/admin/devices` — tenant-wide list; optional `?userId=` / `?platform=`.
- `POST /api/devices/admin/devices` — register on behalf of any user (`userId` in body).
- `GET` / `PUT` / `DELETE /api/devices/admin/devices/:id` — read/update/deactivate any device.

All routes export `openApi`. List routes use `makeCrudRoute` with `indexer: { entityType: 'devices:user_device' }` **and** `events: { module: 'devices', entity: 'user_device' }` so the CRUD-cache resource tag matches the command's `resourceKind` and writes bust the list cache. Shared write boilerplate (guard → command bus → undo header) lives in `api/deviceOps.ts`; the shared list schema/fields/item in `api/deviceList.ts`. Server also soft-deletes a device when a provider returns "unregistered" (future `push_notifications` worker).

**ACL features (`acl.ts`):**
- `devices.view`, `devices.manage` (self-serve).
- `devices.admin` — gates the entire `api/admin/devices` tree **and** the admin backend pages.

**Setup (`setup.ts`):** `defaultRoleFeatures` grants `devices.view`/`devices.manage` to `employee`; `admin`/`superadmin` get `devices.*`. *(Customer-role grants from the original draft are deferred — devices are employee/ops-facing in Phase 1.)*

**Events (`events.ts`):**
- `devices.user_device.registered`
- `devices.user_device.deactivated`

### Module 2 — Extensions to `@open-mercato/core/modules/notifications`

Two additive surfaces — no breaking changes to existing in-app behavior.

#### 2a. DB-backed type registry

**New entity:** `NotificationType` (`notification_types`)
- `id` (string PK, e.g. `orders.shipped`), `tenant_id` (nullable for system-wide types)
- `label_key` (i18n key — short type name shown in the preferences UI, e.g. `notifications.types.orders_shipped.label`)
- `description_key` (i18n key, nullable — optional helper text for the preferences UI)
- `created_at`, `updated_at`

The actual notification message (title + body) lives on the per-instance `Notification` row, not the type — this entity is just the catalogue. Both keys resolve via locale JSON files (`packages/.../i18n/<locale>.json`); the runtime `translations.ts` system is not used here because types are code-registered, not tenant-defined.

**Mechanism:** at boot, a subscriber listens to `notifications.type_registry.sync` and reconciles registered `NotificationTypeDefinition` calls into the table. The in-memory definition seam stays the source of truth for code; the DB is a read-through mirror so remote clients (mobile apps) can enumerate types.

**API:**
- `GET /api/notifications/types` — registry read for clients (tenant-filtered).

#### 2b. Channel-agnostic preferences

**New entity:** `NotificationPreference` (`notification_preferences`)
- `id` (uuid PK), `tenant_id`, `user_id`
- `notification_type_id` (FK → `notification_types.id`)
- `channel` (string — `in_app`, `push`, future `email`/`sms`)
- `enabled` (bool)
- `created_at`, `updated_at`
- Unique: `(tenant_id, user_id, notification_type_id, channel)`.

**Service:** `NotificationPreferenceService` (DI-registered)
- `isChannelEnabled(userId, typeId, channel): Promise<boolean>` — defaults to `true` when no row exists (lazy-seed pattern).
- `setPreferences(userId, [{typeId, channel, enabled}]): Promise<void>`
- `listForUser(userId): Promise<NotificationPreference[]>`

Channel modules consume this service via DI; they do not query the table directly.

**APIs:**
- `GET /api/notifications/preferences` — current user's prefs (lazy-default to `true` for unset rows).
- `PUT /api/notifications/preferences` — bulk update.

**ACL:** `notifications.manage_preferences` (self-serve, granted by default to all roles).

### Module 3 — `@open-mercato/core/modules/push_notifications` (new)

> **Architecture revision (2026-06-25).** The original draft (below) put the provider seam (`PushProvider` interface + FCM/APNs implementations) inside this module. **Revised:** the actual provider send rides the existing **`communication_channels` hub**, per the maintainer's request on PR #2595 ("push notifications support via the `communication_channels` hub … so it will be end2end feature"). This was verified feasible with **no `ChannelAdapter` contract change**:
>
> - **FCM / APNs / Expo are hub `ChannelAdapter`s** in separate npm packages (`packages/channel-fcm`, `packages/channel-apns`, `packages/channel-expo`), mirroring `packages/channel-gmail`. Each declares `channelType: 'push'`, `capabilities.realtimePush: true` (⇒ `pollIntervalSeconds = null`, no polling), implements `sendMessage` / `convertOutbound` / `validateCredentials` + health, no-ops `verifyWebhook` (`eventType: 'other'`), and omits history/oauth/registerPush.
> - **Provider credentials vs device tokens are separate.** Provider creds (FCM service account, APNs `.p8`, Expo token) live on **one tenant-scoped `CommunicationChannel` per provider** (`channelType:'push'`), encrypted via `IntegrationCredentials` under `channel_<providerKey>`. Per-device push tokens stay in `UserDevice.push_token` (devices module). An operator enables push by connecting a channel via the **existing** `POST /api/communication_channels/channels/connect/credentials`.
> - **`push_notifications` keeps the fan-out + audit.** The `MobilePushDeliveryStrategy` (registered via `registerNotificationDeliveryStrategy('push')`) resolves the recipient's devices + preferences, then for each device resolves the tenant's push channel + adapter + creds and invokes `adapter.sendMessage(...)` **directly** — the exact pattern `communication_channels/api/post/channels/[id]/test-send/route.ts` uses (`getChannelAdapter` → `integrationCredentialsService.resolve('channel_<providerKey>', scope)` → `convertOutbound` → `sendMessage`), **not** the conversation/message pipeline. `PushNotificationDelivery` rows + the `send-push` worker (retry/backoff, device soft-delete on `unregistered`) stay here.
> - **No `PushProvider` interface in this module** — the hub's `ChannelAdapter` registry is the provider seam. The original `lib/providers/{types,fcm,apns}.ts` paths below are superseded by the channel packages; a `push_stub` adapter is used in tests.
> - **Mapping:** call `adapter.sendMessage` **once per device token**; `content` carries the push envelope (`raw:{title,body,data}`), per-call `metadata` carries `{ pushToken, platform, userDeviceId, provider }`. The `unregistered` sentinel (`result.metadata.unregistered` or `error:'device_unregistered'`) must be identical across fcm/apns/expo so the worker's device soft-delete fires uniformly.
>
> The remainder of this section is the original draft, retained for the delivery-row/worker/strategy-pipeline detail that still applies.

Push channel only. Reads type registry + preferences from `notifications`, devices from `devices`. Owns deliveries, sender, worker, providers.

**Entities:**

- `PushNotificationDelivery` (`push_notification_deliveries`)
  - `id` (uuid PK), `tenant_id`, `notification_id` (nullable soft FK → `notifications.notifications`), `notification_type_id` (string)
  - `user_device_id` (soft FK → `devices.user_devices` via `data/extensions.ts`), `user_id`
  - `provider` (string — snapshot of the provider used at send time), `token_snapshot` (text — last 8 chars only, for debugging without exposing the full token)
  - `status` (`pending|sent|failed|skipped`), `attempts` (int), `last_error` (text|null)
  - `payload` (JSONB), `provider_response` (JSONB|null)
  - `created_at`, `sent_at`, `updated_at`

  Snapshotting `provider` and the truncated token on the delivery row means the audit trail survives token rotation on the device.

**Services (DI-registered in `di.ts`):**

- `PushSenderService` — orchestrator. Resolves provider per token via `PushProvider` interface; returns `PushResult[]`.
- `MobilePushDeliveryStrategy` — registered via the existing `registerNotificationDeliveryStrategy('push')` seam. Pipeline:
  1. Resolve `NotificationType` from registry (skip if absent).
  2. Check `NotificationPreferenceService.isChannelEnabled(user, type, 'push')` — skip if false.
  3. Load `UserDevice` rows for `(tenant, user)` where `deleted_at IS NULL AND push_token IS NOT NULL`. Skip if none.
  4. Insert `PushNotificationDelivery` rows (status=`pending`, snapshotting `provider` and truncated token).
  5. Enqueue `push_notifications:send-push` worker job.

**Provider interface:**

```ts
// lib/providers/types.ts
export interface PushProvider {
  id: string                                  // 'fcm' | 'apns' | 'expo' | ...
  supports(platform: 'ios' | 'android' | 'web'): boolean
  send(payload: PushPayload, tokens: DevicePushToken[]): Promise<PushResult[]>
}

export type PushPayload = {
  title: string
  body: string
  data?: Record<string, string>
  badge?: number
  sound?: string
}

// PushProvider.send accepts UserDevice rows (with push_token, push_provider, platform).
export type PushResult = {
  userDeviceId: string
  ok: boolean
  providerMessageId?: string
  error?: { code: string; message: string; retryable: boolean }
}
```

Reference implementations: `lib/providers/fcm.ts`, `lib/providers/apns.ts`. Apps register additional providers via Awilix `resolveAll`.

**Worker:**
- `workers/send-push.worker.ts` — picks pending `PushNotificationDelivery` rows, batches by provider, retries with exponential backoff (3 attempts default). Marks `sent`/`failed`. On provider "unregistered" responses, soft-deletes the source `UserDevice` row. Idempotent on delivery id.

**No token-management APIs in this module.** Push tokens are device fields, set/cleared via `PUT /api/devices/:id` in the `devices` module.

**Backend admin pages** (under `/backend/push-notifications/`):
- `page.tsx` — delivery log list (filter by status, user, date range).
- `[id]/page.tsx` — delivery detail.

**ACL features (`acl.ts`):**
- `push_notifications.view_deliveries` (admin observability).

**Events (`events.ts`):**
- `push_notifications.delivery.sent`
- `push_notifications.delivery.failed`

### Designing for email/SMS without building them

The shape this spec locks in for v1 is what makes future channels cheap:

- `NotificationPreference.channel` is a free-form string. Adding `email` is new rows, no schema change.
- The existing `registerNotificationDeliveryStrategy(channel)` seam in `notifications` is the integration point. A future `email_notifications` module:
  1. Registers a `DeliveryStrategy` under `'email'`.
  2. Owns its own credentials, identity (e.g. verified email addresses), worker, delivery log.
  3. Reads `NotificationPreferenceService.isChannelEnabled(user, type, 'email')`.
- `NotificationDispatcher` in `notifications` already fans out to registered strategies; preferences are consulted per channel inside each strategy (not centrally) so each channel can have its own skip-conditions.
- No "send anything" facade — channel modules stay independent and swappable.

When categories/governance return as a later spec, they are additive: a new `category` column on `NotificationType`, a new optional preference fallback (type → category), and an optional `FrequencyGuard` service. Nothing in this spec blocks that.

## Architecture (file-level map)

```
packages/core/src/modules/devices/          # as implemented (Phase 1)
  index.ts
  acl.ts
  setup.ts
  events.ts
  di.ts
  data/entities.ts                          # UserDevice
  data/validators.ts
  commands/devices.ts                       # register / update / deactivate (undoable)
  lib/operationMetadata.ts                  # x-om-operation undo header helper
  api/route.ts                              # self: GET (own) + POST (register self)
  api/[id]/route.ts                         # self: PUT/DELETE (owner-only)
  api/admin/devices/route.ts                # admin: GET (all) + POST (register for user)
  api/admin/devices/[id]/route.ts           # admin: GET/PUT/DELETE (any device)
  api/auth.ts                               # resolveDeviceActorUserId
  api/deviceList.ts                         # shared list schema/fields/item
  api/deviceOps.ts                          # shared guard→command→undo-header helpers
  api/openapi.ts
  backend/devices/page.tsx                  # admin list (gated devices.admin)
  backend/devices/create/page.tsx           # admin: register on behalf of a user
  backend/devices/[id]/page.tsx             # admin: edit a device
  i18n/{en,de,es,pl}.json
  migrations/Migration*.ts
  AGENTS.md
  __integration__/TC-DEV-001.spec.ts        # self-serve + TC-DEV-002 admin endpoints

packages/core/src/modules/notifications/        # extending existing module (as implemented, Phase 2)
  data/entities.ts                              # ADD: NotificationType, NotificationPreference
  data/validators.ts                            # ADD: updatePreferencesSchema, type/preference item schemas
  lib/notification-type-registry.ts             # ADD: in-memory registry (fed at bootstrap) + syncNotificationTypes reconcile
  lib/notificationPreferenceService.ts          # ADD: NotificationPreferenceService (+ resolve helper)
  lib/routeHelpers.ts                           # EDIT: NOTIFICATION_PREFERENCE_RESOURCE_KIND
  subscribers/sync-notification-types.ts        # ADD: re-sync on notifications.type_registry.sync
  api/types/route.ts                            # ADD: GET catalogue (lazy read-through sync)
  api/preferences/route.ts                      # ADD: GET + PUT (service + mutation guard)
  acl.ts / setup.ts / events.ts / di.ts         # EDIT: manage_preferences feature, seedDefaults sync emit, 2 events, preference service DI
  migrations/Migration20260625122947_notifications.ts  # ADD migration for two new tables (+ snapshot)
  AGENTS.md                                     # ADD
  __integration__/TC-NOTIF-011.spec.ts          # ADD (type catalogue + preferences)
  lib/__tests__/notification-type-registry.test.ts  # ADD unit test

apps/mercato/src/bootstrap.ts                   # EDIT: registerNotificationTypes(notificationTypes, { replace: true })
packages/shared/src/modules/notifications/types.ts  # EDIT: additive optional labelKey/descriptionKey on NotificationTypeDefinition

packages/core/src/modules/push_notifications/          # as implemented (Phase 3)
  index.ts                                             # requires: auth, devices, notifications, communication_channels, integrations
  acl.ts                                               # push_notifications.view_deliveries
  setup.ts                                             # defaultRoleFeatures: admin/superadmin → push_notifications.*
  events.ts                                            # delivery.sent / delivery.failed
  di.ts                                                # registers PushNotificationDelivery + (test) push_stub adapter
  data/entities.ts                                     # PushNotificationDelivery (append-only; optimistic-lock-exempt)
  data/validators.ts                                   # delivery list/detail zod schemas (no full token)
  data/extensions.ts                                   # links to devices.user_device + notifications.notification
  notifications.delivery-strategies.ts                 # exports the `push` strategy (discovered by the generator plugin)
  lib/push-delivery-strategy.ts                        # the `push` NotificationDeliveryStrategy (enqueue-only)
  lib/queue.ts                                         # push-deliveries queue + enqueue + local-worker bootstrap
  lib/push-delivery.ts                                 # processPushDeliveryJob: hub send + retry/backoff + unregistered soft-delete
  lib/push-stub-adapter.ts                             # in-process test ChannelAdapter (OM_ENABLE_PUSH_STUB_ADAPTER)
  lib/__tests__/push-delivery.test.ts                  # worker-branch unit suite
  lib/__tests__/push-delivery-strategy.test.ts         # strategy-branch unit suite
  workers/send-push.worker.ts                          # auto-discovered queue worker
  api/openapi.ts
  api/deliveries/route.ts                              # GET list (makeCrudRoute, view_deliveries)
  api/deliveries/[id]/route.ts                         # GET detail (payload + provider response)
  backend/page.tsx + page.meta.ts                      # delivery-log list
  backend/[id]/page.tsx + page.meta.ts                 # delivery detail (read-only)
  i18n/{en,de,es,pl}.json
  migrations/Migration20260625150049_push_notifications.ts  (+ .snapshot-open-mercato.json)
  __integration__/TC-PUSH-001.spec.ts                  # delivery-log API: ACL + scoping + token secrecy

packages/core/src/modules/notifications/               # Phase 3 additions (strategy registration seam)
  generators.ts                                        # `delivery-strategies` GeneratorPlugin (bootstrap registration)
  lib/delivery-strategies-registry.ts                  # registerNotificationDeliveryStrategyEntries (idempotent)

apps/mercato/src/modules.ts                            # EDIT: enable { id: 'push_notifications', from: '@open-mercato/core' }
```

## Data Models

See entity definitions above. Key design notes:

- `UserDevice` carries push-token fields directly. Splitting tokens into a separate entity is YAGNI for v1 — single token per `(device, app install)` is the universal case for FCM/APNs/Expo, and a future split is a single migration if a real edge case ever shows up.
- Soft-delete via the standard `deleted_at` column; no separate `is_active` flag.
- **Optimistic locking**: `UserDevice` is a genuinely editable entity, so metadata edits are version-checked (detail GET exposes `updated_at`; `CrudForm` sends the expected-version header; `executeUpdate` enforces it). Deactivate is exempt because an idempotent soft-delete of a registry row has no lost-update risk.
- `PushNotificationDelivery` references `user_device_id` and snapshots `provider` + a truncated `token_snapshot` so the delivery audit trail survives both token rotation and device deletion.
- `NotificationPreference.channel` is a free-form string for forward compatibility with email/SMS.
- `NotificationPreference` rows are **lazy-seeded**: when no row exists, the channel is treated as enabled (default-on). This avoids backfilling preferences for every existing user when a new type is added.
- `NotificationType.label_key` / `description_key` resolve via locale JSON files, not the runtime `translations.ts` system, because types are code-registered, not tenant-defined.
- Cross-module references use `data/extensions.ts` (`defineLink`), not direct ORM relationships.

## API Contracts

Schemas in `data/validators.ts` (zod). Highlights:

```ts
// POST /api/devices
const RegisterDeviceSchema = z.object({
  deviceId: z.string().min(1).max(128),
  platform: z.enum(['ios', 'android', 'web']),
  clientAppVersion: z.string().optional(),
  osVersion: z.string().optional(),
  pushToken: z.string().min(1).optional(),
  pushProvider: z.string().min(1).optional(),
})

// PUT /api/devices/:id
const UpdateDeviceSchema = z.object({
  clientAppVersion: z.string().optional(),
  osVersion: z.string().optional(),
  pushToken: z.string().min(1).nullable().optional(),  // null clears (e.g. user revoked OS permission)
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

All routes wire `openApi` via `createCrudOpenApiFactory`.

## Integration Test Coverage

Per `.ai/qa/AGENTS.md` — self-contained, fixtures created in setup, cleaned in teardown.

**`devices` module:**
- Register → list → update last-seen → soft-delete.
- Register with `pushToken` set on first call; later `PUT` with `pushToken: null` clears it.
- ACL: a non-admin user cannot list another user's devices.
- Idempotency: re-registering same `(user, device_id)` upserts, does not duplicate.

**`notifications` module (new surfaces):**
- Boot fires `notifications.type_registry.sync`; subscribers register types; `notification_types` reflects DB state.
- `NotificationPreferenceService.isChannelEnabled` returns `true` when no row exists; `false` after explicit opt-out; round-trips across `setPreferences`.

**`push_notifications` — strategy + provider:**
- With a stub `PushProvider`, fire `notificationService.create()` for a push-enabled type → assert `PushNotificationDelivery` row enqueued (status=`pending`) → run worker → status transitions to `sent`, `provider_response` populated.
- Failed provider call → retried 3× → final status `failed`, `last_error` populated.
- Provider returns "unregistered" → worker soft-deletes the source `UserDevice` row.
- Opt-out via `PUT /api/notifications/preferences` (`channel='push'`, `enabled=false`) → next dispatch skips delivery (no row enqueued).
- Device with `push_token=null` → strategy skips it (no row enqueued).

**`push_notifications` — admin pages:**
- Filter by status/user/date.
- Detail page renders payload + provider response.
- ACL: page gated by `push_notifications.view_deliveries`.

## Risks & Impact Review

| Risk | Severity | Area | Mitigation | Residual |
|---|---|---|---|---|
| Module-shape bikeshed: reviewers prefer one merged module over three | Medium | Module boundary | Spec lists explicit reuse cases for `devices` (MFA #539, audit, sessions) and channel-agnostic justification for putting prefs/registry in `notifications`. Reversible if reuse never materializes. | Low. |
| Provider abstraction adds complexity for apps that only need FCM+APNs | Low | DX | Default `di.ts` registration ships FCM+APNs out of the box. Apps that don't extend never see the provider seam. | Low. |
| FCM/APNs credentials in env are sensitive; misconfig leaks tokens to logs | High | Security | Provider implementations MUST NOT log tokens or full payloads. Add a redact filter in `push-sender.ts` and a unit test asserting redaction. Document env keys in `AGENTS.md`. | Low after redaction test. |
| `push_token` leaks through generic platform surfaces that echo write payloads/snapshots back to clients (audit-log `snapshotBefore`/`snapshotAfter` + derived `changesJson` via `audit_logs.view_self`; enterprise record-lock conflict details) | High | Security | Redact the token from the persisted command snapshots and strip it from the mutation-guard payload; keep the real token only in the non-exposed undo payload so commands stay undoable. Never add `push_token` to list/detail field sets. | Low. |
| Lazy preference seeding = surprise opt-in for existing users when a new type is added | Medium | UX | Default-on contract documented. Apps that want default-off insert explicit `enabled=false` rows during type registration. | Low. |
| `push_notification_deliveries` table grows unbounded | Medium | Storage | Periodic purge worker (90-day default, configurable per tenant). Declared in this spec; landed as a Phase 6 follow-up if it slips. | Medium until purge ships. |
| Notification type IDs are FROZEN (per BACKWARD_COMPATIBILITY.md) — typos stick forever | High | BC contract | Document the frozen-id contract in `AGENTS.md`. Migration tooling for renames left to a future spec. | Low. |
| Mobile clients depend on stable token-register endpoint shapes | High | API contract | Lock request/response schemas in this spec; mark routes STABLE per BC contract. Additive-only changes thereafter. | Low. |
| Existing `notifications` module's in-memory registry diverges from new DB registry | Medium | Module overlap | DB registry is a read-through mirror, not a replacement. Same source of truth (`registerNotificationTypes` calls), two storage layers. Sync subscriber reconciles on boot. | Low. |
| Preferences service introduces an extra DB read per dispatch | Low | Performance | Service caches per-request via DI; bulk-loads when dispatching to many users. Worst case is a few extra ms per send. | Low. |
| Splitting prefs/registry from `push_notifications` means push module depends on `notifications` | Low | Coupling | This is correct: every channel depends on the channel-agnostic registry. The dependency is unidirectional and matches the existing strategy seam. | None. |

## Open Questions

- `PushProvider` discovery: Awilix `resolveAll` (DI-idiomatic in this codebase) vs. an explicit `registerPushProvider()` registry? **Recommendation:** Awilix `resolveAll` over an `Array<PushProvider>` token; mirrors how the codebase wires other plugin seams.
- Should `NotificationPreference` carry an optional `tenant_id`-scoped row to support tenant-level defaults (admin overrides "all users default to push-off for marketing types")? **Recommendation:** out of scope for this spec; revisit when categories/governance return.
- Should the `notifications` module's existing `Notification.channels` JSONB column be deprecated in favor of resolving channels per-dispatch from preferences? **Recommendation:** no — `channels` records what was attempted at create time (audit), preferences gate what gets attempted. Distinct concerns.

## Implementation Phases

Each phase ends with passing integration tests + green build. One PR per phase. **Admin UI is split per phase** (revised 2026-06-25): each phase ships the UI for the surface it introduces, rather than deferring all UI to a single late phase — so every phase is a self-contained, demoable vertical slice. The former Phase 5 ("Backend admin + preferences UI") is therefore dissolved into Phases 2 (preferences settings page) and 3 (push delivery-log pages); Phase 4 needs no new admin screen because push-provider credentials use the existing `communication_channels` connect UI.

1. **Phase 1 — `devices` module.** Entities, migrations, APIs, ACL, setup, integration tests. Standalone — no dependents yet. *(Complete: implemented, optimistic-lock pass present, self-serve `TC-DEV-001` + admin-tree `TC-DEV-002` integration suites colocated.)*
2. **Phase 2 — `notifications` extensions.** *(Complete.)* `NotificationType` + `NotificationPreference` entities, migration + snapshot, runtime type registry (bootstrap-fed, mirroring `messages/lib/message-types-registry.ts`) consuming the **existing** per-module `notifications.ts` `NotificationTypeDefinition` aggregate + `syncNotificationTypes` DB read-through mirror, `NotificationPreferenceService`, `GET /api/notifications/types` + `GET`/`PUT /api/notifications/preferences` (preferences write = service + mutation guard via `runGuardedNotificationWrite`, **not** the command bus — mirrors the existing `settings` route), `TC-NOTIF-011` integration suite. **UI (this phase):** (1) a **self-serve** preferences page under **Profile** (`/backend/profile/notification-preferences`, `notifications.manage_preferences`) — a type×channel toggle matrix backed by `GET /types` + `GET`/`PUT /preferences`; (2) an **admin** page (`/backend/notifications/user-preferences`, new `notifications.manage_user_preferences`) to search a user and edit their matrix, backed by `GET`/`PUT /api/notifications/admin/preferences?userId=` (tenant-membership validated). Shared `NotificationPreferenceMatrix` component. The pages **persist** preferences today; **no channel consumes them yet** — the existing in-app delivery path is unchanged, and `push` consumption lands in Phase 3 (its strategy calls `isChannelEnabled(..., 'push')`). No new channels yet. **BC:** new ACL feature `notifications.manage_preferences`, new DI name `notificationPreferenceService`, STABLE API URLs, FROZEN type ids (sourced from existing module definitions — no new ids minted), additive optional `labelKey`/`descriptionKey` on `NotificationTypeDefinition`.
3. **Phase 3 — `push_notifications` rails (hub-based) + push delivery-log UI.** *(Complete.)* `PushNotificationDelivery` log (append-only; optimistic-lock-exempt), the `push` delivery strategy (resolves devices + the tenant push `CommunicationChannel` softly via DI tokens, checks Phase-2 `isChannelEnabled(..., 'push')`, snapshots provider + truncated token, inserts pending rows, enqueues per device), `send-push` worker + `lib/queue.ts` (retry/backoff up to 3 attempts; on the uniform `unregistered` sentinel soft-deletes the device through the devices `devices.devices.deactivate` command with a `systemActor` ctx — no business-logic import), in-process `push_stub` adapter for tests (gated by `OM_ENABLE_PUSH_STUB_ADAPTER`). **Strategy registration:** a new notifications `delivery-strategies` generator plugin (`generators.ts` + `lib/delivery-strategies-registry.ts`) discovers each module's `notifications.delivery-strategies.ts` and wires a `runBootstrapRegistrations()` call — mirrors the security MFA-provider plugin; no app-bootstrap edit. **UI:** read-only push delivery-log list + detail backend pages (`push_notifications.view_deliveries`, under settings → Module Configs). **No `PushProvider` interface** — uses the hub `channelAdapterRegistry`. **BC:** new ACL feature `push_notifications.view_deliveries`, 2 new event ids (`push_notifications.delivery.{sent,failed}`), 1 new entity, 1 new generator-plugin convention file (all additive). Tests: `push-delivery` + `push-delivery-strategy` unit suites (11 cases: sent / idempotent / skip / no-adapter / unregistered-soft-delete / retry→fail; opt-out / no-channel / no-device / fan-out), `TC-PUSH-001` API suite (ACL + tenant scoping + token-secrecy + detail 400/404).
4. **Phase 4 — Reference provider adapters (hub channel packages).** `packages/channel-fcm`, `packages/channel-apns`, `packages/channel-expo` — each a `ChannelAdapter` package mirroring `channel-gmail`: credentials schema, health check, log redaction, uniform `unregistered` sentinel. **No new admin UI** — operators connect a push provider through the existing `communication_channels` connect flow. *(APNs risk: verify Node HTTP/2 transport before committing.)*
5. **~~Phase 5~~ — dissolved.** UI split per phase: the notification-preferences settings page moved into **Phase 2**, the push delivery-log pages into **Phase 3**. Retained only as an optional cross-cutting polish pass if needed after Phases 2–4.
6. **Phase 6 (follow-up).** Purge worker (90-day default) for `push_notification_deliveries`, web push, additional providers. Categories/priority/non-opt-out/frequency caps land as a separate later spec when an app needs them.

## Verification

### Local

1. `yarn db:migrate` applies new tables.
2. Boot — `notifications.type_registry.sync` fires; types appear in `notification_types`.
3. Register a device with a `pushToken` via `/api/devices` → fire a `notificationService.create()` for a known type → verify delivery row enqueued, worker processed, stub provider called.
4. `PUT /api/notifications/preferences` with `(type, 'push', enabled=false)` → repeat dispatch → verify no new delivery row.

### Automated

- `packages/core/src/modules/devices/__integration__/`
- `packages/core/src/modules/notifications/__integration__/types-and-preferences.spec.ts`
- `packages/core/src/modules/push_notifications/__integration__/`
- `yarn test:integration` runs all green.

### Compliance

- `packages/core/AGENTS.md` patterns: `makeCrudRoute`, `openApi`, `setup.ts`, `acl.ts`, `events.ts`, cross-module links via `data/extensions.ts`, integration suites colocated.
- `BACKWARD_COMPATIBILITY.md`: type IDs treated FROZEN; entity columns ADDITIVE-ONLY going forward; API URLs STABLE.
- Design system: backend admin pages use `DataTable`, `StatusBadge` (delivery status map: `pending→info`, `sent→success`, `failed→error`, `skipped→neutral`), `EmptyState`, `LoadingMessage`. No hardcoded status colors.

## Final Compliance Report

**Phase 1 (`devices` module) — complete.** `yarn generate` clean, `yarn typecheck` green, integration suites `TC-DEV-001` (self-serve) + `TC-DEV-002` (admin) pass under the cache-enabled ephemeral harness. `yarn lint` is blocked by a pre-existing `eslint-plugin-react`/ESLint 10 toolchain crash unrelated to this change. Phase 1 items below are met (`devices`-scoped); provider/redaction/worker items remain for Phases 3–4.

- [x] All routes export `openApi` *(Phase 1)*
- [x] Module entities follow snake_case table names *(`user_devices`)*
- [x] No direct ORM relationships across module boundaries *(Phase 1 has none)*
- [x] All write routes use the Command pattern *(register/update/deactivate via command bus)*
- [x] Integration suites self-contained and stable *(poll-based; cache-tag fix removes flakiness)*
- [x] `AGENTS.md` shipped with the `devices` module
- [x] No hardcoded design-system colors or arbitrary text sizes *(admin pages)*
- [x] BC contract honored (type IDs frozen, additive-only schema changes thereafter)
- [x] `push_token` treated as a secret: excluded from list/detail responses, redacted from audit-log command snapshots + derived `changesJson`, and stripped from the mutation-guard payload; real token retained only in the non-exposed undo payload

Phases 2–6 (remaining):

- [ ] All routes export `openApi`
- [ ] Module entities follow snake_case table names with `<module>_` prefix
- [ ] No direct ORM relationships across module boundaries (links declared via `data/extensions.ts`)
- [ ] All write routes use the Command pattern OR `makeCrudRoute`
- [ ] Provider implementations redact tokens and payloads from logs
- [ ] Integration suites self-contained and stable
- [ ] `AGENTS.md` shipped with each new module; existing `notifications/AGENTS.md` updated for new surfaces
- [ ] No hardcoded design-system colors or arbitrary text sizes
- [ ] `yarn lint` and `yarn build` green
- [ ] BC contract honored (type IDs frozen, additive-only schema changes thereafter)

## Downstream Parity Review (`user_notifications`)

On 2026-06-26 the three upstream modules were diffed against the downstream production module `apps/mercato/src/modules/user_notifications/` (covo-backend, the implementation this spec was originally informed by) to decide how close a "1:1 logic" port should be. Outcome: this spec is a **deliberate re-architecture, not a 1:1 port**. The differences below fall into two buckets — *intentional divergences to keep* and *features deferred to a later spec*.

### Intentional divergences — keep as-is (do NOT "fix" toward downstream)

These are platform-correctness decisions; a future implementer should not treat them as gaps:

- **Module shape:** one combined `user_notifications` module downstream → three upstream modules (`devices`, `notifications` extensions, `push_notifications`). Keeps the device registry reusable (MFA/audit/session) and preferences/registry channel-agnostic.
- **Provider integration:** downstream sends FCM+APNs directly via `node-pushnotifications`; upstream rides the **`communication_channels` hub** (`channelAdapterRegistry` + `IntegrationCredentials`), per the maintainer's mandate on PR #2595. Real adapters land as Phase-4 channel packages; the only push adapter today is the test-only `push_stub`.
- **Preference schema:** downstream stores one row per `(user, type)` with `push_enabled`/`email_enabled` boolean columns; upstream stores one row per `(user, type, channel)` with a free-form `channel` string + `enabled` bool (forward-compatible with email/SMS without a schema change).
- **Device entity:** downstream `push_notification_tokens` requires a token and uses an `is_active` flag; upstream `user_devices` is a generic registry with a **nullable** token, soft-delete via `deleted_at`, and `push_provider` metadata.
- **Token handling:** downstream masks the token (last-8) in admin surfaces; upstream treats it as a hard secret — never returned by any list/detail response, redacted from audit snapshots and the mutation-guard payload, retained only in the non-exposed undo payload.
- **Delivery trigger:** downstream uses a `notification.created` subscriber (its `mobile_push` strategy fn is intentionally left unregistered to avoid double-send); upstream uses a registered `push` delivery strategy via the notifications seam. Same effect, cleaner seam.

### Deferred to a later spec (out of scope here)

Present downstream, intentionally not ported now — see the expanded "Out of scope" list above. Summary, in rough priority order:

1. **Silent push** (highest priority) — `sendSilentPush`: content-available wake-ups that create no `Notification` row and bypass preferences + frequency caps; gated on a `silent: true` type.
2. **Governance/type metadata** — `category`, `priority`, `non_opt_out`, `silent`, `hidden_from_settings`, `group_key` on `NotificationType`, plus server-side `non_opt_out` enforcement in the delivery strategy.
3. **Frequency guard** — `FrequencyGuardService` daily/weekly caps per category with `non_opt_out` bypass.
4. **Admin custom / one-off send** — `admin.custom_message` type + send backend page + API + command.
5. **Operational** — weekly range-partitioning of `push_notification_deliveries` + scheduled partition worker, GDPR data-export collectors + consumer-deletion purge, per-device locale resolution with title/body rewrite, and cross-user token-handoff deactivation.

A clean upstream design for items 1–4 (how categories/priority/non-opt-out compose with the existing channel-row preferences and the hub strategy) is still an **open question** — this is why they are deferred rather than scoped now.

## Changelog

- **2026-06-26** — **Downstream parity review + scope update.** Diffed the three upstream modules against the downstream `user_notifications` module (covo-backend) to settle how close a "1:1 logic" port should be. Decision: keep the upstream re-architecture (3-module split, `communication_channels` hub provider seam, channel-row preferences, generic `user_devices` registry, hard token secrecy) as **intentional divergences**, and **defer the downstream governance/operational tier** — notification categories, priority, `non_opt_out` enforcement, `silent`/`hidden_from_settings`/`group_key` metadata, frequency caps (`FrequencyGuardService`), **silent push** (highest-priority deferred item), admin custom-send, delivery-table partitioning + scheduled worker, GDPR export/purge, per-device locale, and cross-user token-handoff deactivation. Recorded all of this in the expanded "Out of scope" list and the new "Downstream Parity Review" section. No code change — documentation/scope only.
- **2026-06-26** — **Phase 3 review-fix pass #2** on `feat/devices-push-e2e` (worktree code review). (1) **Nullable-org delivery visibility:** tenant-level notifications produce delivery rows with `organization_id IS NULL`; the read APIs were hiding them from org-restricted admins. The list route (`api/deliveries/route.ts`) now scopes a restricted principal to `organization_id ∈ allowed **OR** NULL` via a `$or` filter, and the detail route (`api/deliveries/[id]/route.ts`) skips the per-organization read-access check for org-less rows (tenant scope already isolates them). Unrestricted principals are unchanged. (2) **Credential refresh on send:** `processPushDeliveryJob` now calls `refreshCredentialsIfNeeded` before `sendMessage`, mirroring the reference `test-send` flow, so Phase-4 OAuth-token providers (FCM/APNs) don't send with a near-expiry token; it's a no-op for adapters without `refreshCredentials` (the `push_stub`). (3) **Event contract:** documented that `push_notifications.delivery.failed` fires on every failed attempt and carries `willRetry:true` for retries — subscribers counting ultimate failures MUST filter `willRetry !== true` (added `description` to the event declaration). (4) **`TC-PUSH-001` hardening:** added an ORM-backed detail describe block that seeds real `push_notification_deliveries` rows via SQL (`dbFixtures.withClient`) and exercises the entity-backed detail route — proving token secrecy against real data (full token never in the response body; only the last-8 `token_snapshot`), tenant isolation (a foreign-tenant row → 404), and tenant-level (org-less) row readability. The list route reads the eventually-consistent query index, so the authoritative secrecy/scoping coverage now lives on the detail route. Validation: `yarn typecheck` green across all 21 packages; `push_notifications` unit suites green (15) and `optimistic-lock-*`/`module-decoupling` guards green (112).
- **2026-06-26** — **Phase 3 review-fix pass** on `feat/devices-push-e2e`. (1) **Strategy ordering:** the push strategy now checks the per-tenant active push `CommunicationChannel` **before** the per-recipient `isChannelEnabled` preference query, so the common no-push-channel tenant short-circuits without the extra preference DB lookup on the notification hot path (strategy is `defaultEnabled: true`, runs for every notification). (2) **Enqueue resilience:** a failed `enqueuePushDelivery` now marks that delivery row `failed` (`enqueue_failed`) instead of leaving it orphaned in `pending` forever. (3) **Migration:** added the missing reversible `down()` (`drop table push_notification_deliveries`) to match the repo convention. (4) **New jest E2E suite** `lib/__tests__/push-stub-adapter.test.ts` drives the **real** `push_stub` adapter through the **real** `processPushDeliveryJob` (the sibling `push-delivery` suite mocks the adapter) — proves stub registration, `channelAdapterRegistry.get()` resolution, sent/retry branches, and the `unregistered → devices.devices.deactivate` system-actor (`auth:null, systemActor:true`) soft-delete dispatch. (5) **`TC-PUSH-001` fix:** the "unknown delivery → 404" case used an id (`…0000000000aa`) whose RFC-4122 variant nibble is invalid, so strict `z.string().uuid()` returned 400, not 404; switched to a valid-but-nonexistent v4 UUID. All 5 API tests now pass against the dev server (after `yarn mercato auth sync-role-acls` granted the new feature). Validation: `yarn typecheck` green across all 21 packages; `push_notifications` + guard suites (`optimistic-lock-*`, `module-decoupling`) green (127 tests); `TC-PUSH-001` green (5/5). Note: in dev, the new ACL grant only takes effect after the RbacService cache (sqlite, 5-min TTL) expires or is cleared.
- **2026-06-25** — **Phase 3 (`push_notifications` rails + delivery-log UI) implemented** on `feat/devices-push-e2e`. New core module `packages/core/src/modules/push_notifications/` (registered in `apps/mercato/src/modules.ts`): `PushNotificationDelivery` (`push_notification_deliveries`) append-only log — **optimistic-lock-exempt** (background-job/log row; not added to the curated editable-entities guard); cross-module soft links to `devices:user_device` + `notifications:notification` via `data/extensions.ts`. The `push` `NotificationDeliveryStrategy` (`lib/push-delivery-strategy.ts`, `defaultEnabled: true`) resolves the recipient's devices + the tenant push `CommunicationChannel` **softly via DI tokens** (`UserDevice`/`CommunicationChannel`, no import-time coupling), gates on `NotificationPreferenceService.isChannelEnabled(..., 'push')`, snapshots `provider` + last-8 `token_snapshot` (never the full token), inserts pending rows and enqueues one `send-push` job per device. The worker (`workers/send-push.worker.ts` + `lib/queue.ts` + `lib/push-delivery.ts`, mirroring the webhooks queue/local-worker pattern) resolves the hub adapter via `channelAdapterRegistry` + creds via `integrationCredentialsService` and calls `convertOutbound` → `sendMessage` (the `test-send` flow), retries transient failures with exponential backoff (3 attempts), and on the uniform `unregistered` sentinel soft-deletes the device through the `devices.devices.deactivate` command dispatched with a `{ auth: null, systemActor: true }` ctx (audit/events/undo stay consistent; no devices business-logic import). **Strategy registration** uses a new notifications **`delivery-strategies` generator plugin** (`notifications/generators.ts` + `lib/delivery-strategies-registry.ts`) that discovers each module's `notifications.delivery-strategies.ts` and contributes a `runBootstrapRegistrations()` call — mirrors `security.mfa-providers`; keeps `push_notifications` self-contained with no `bootstrap.ts` edit. Real FCM/APNs/Expo adapters are **not** in this phase (Phase 4 channel packages); an in-process `push_stub` adapter (`lib/push-stub-adapter.ts`, gated by `OM_ENABLE_PUSH_STUB_ADAPTER`, registered in `di.ts` like the communication_channels test-seed adapter) covers tests with token sentinels for sent / retryable-fail / unregistered. **UI:** read-only delivery-log list + detail backend pages (`push_notifications.view_deliveries`, settings → Module Configs), `StatusBadge` map `pending→info / sent→success / failed→error / skipped→neutral`; i18n en/de/es/pl. New ACL feature `push_notifications.view_deliveries` (admin/superadmin via `push_notifications.*`), 2 events. Validation: `yarn generate` clean, `yarn db:generate` emits only the push migration + snapshot, `yarn typecheck` green across all 21 packages, guard suites pass (`optimistic-lock-editable-entities`, `optimistic-lock-ui-coverage`, `module-decoupling` — 49), new `push-delivery` + `push-delivery-strategy` unit suites pass (11), `TC-PUSH-001` API suite colocated. Post-merge: run `yarn mercato auth sync-role-acls`. `yarn lint` remains blocked by the pre-existing ESLint-10 toolchain crash (unrelated).
- **2026-06-25** — **Phase 2 (`notifications` extensions) implemented** on `feat/devices-push-e2e`. Key delta from the original draft: the "in-memory type registry" is **not** a new defaults file — it **reuses the existing per-module `notifications.ts` → generated `notifications.generated.ts` `NotificationTypeDefinition` aggregate** (the seam the draft's "reconcile registered `NotificationTypeDefinition` calls" already referred to). A core `lib/notification-type-registry.ts` is fed at bootstrap via `registerNotificationTypes(notificationTypes, { replace: true })` in `apps/mercato/src/bootstrap.ts` (mirrors `registerMessageTypes`), and `syncNotificationTypes(em)` mirrors the catalogue into the new `notification_types` table (`tenant_id IS NULL`, idempotent) — triggered lazily on `GET /api/notifications/types` (process-gated) and via the `notifications.type_registry.sync` subscriber (emitted from `setup.ts` `seedDefaults`). Field map: `id←type`, `label_key←labelKey ?? titleKey`, `description_key←descriptionKey ?? null`; `labelKey`/`descriptionKey` added **additively** to `NotificationTypeDefinition`. **No new frozen type ids minted.** `NotificationPreference` is lazy-seeded (absent row ⇒ enabled) and read/written only through DI-registered `NotificationPreferenceService`; `PUT /api/notifications/preferences` uses the service + `runGuardedNotificationWrite` mutation guard (the existing `settings`-route pattern), **not** the command bus — the "(set via command)" phase-list parenthetical was overridden by the detailed spec text. `NotificationPreference` carries `updated_at` but is intentionally **excluded** from the `optimistic-lock-editable-entities` curated list (idempotent self-setting, service write). New ACL feature `notifications.manage_preferences` (granted to `employee`; admin/superadmin via `notifications.*`). Validation: `yarn generate` clean, `yarn db:generate` emits only the notifications migration + snapshot, `yarn typecheck` green across all packages, `yarn workspace @open-mercato/{shared,core} build` green, guard suites + notifications unit suites pass (`optimistic-lock-editable-entities`, `optimistic-lock-ui-coverage`, `module-decoupling`, + new `notification-type-registry` test), i18n hardcoded check flags no new Phase-2 strings. Post-merge: run `yarn mercato auth sync-role-acls`.
- **2026-06-25** — Phase 1 finalize/verify pass. Confirmed the `devices` module is feature-complete on `feat/devices-push-e2e`: both integration suites are colocated in `__integration__/TC-DEV-001.spec.ts` (self-serve `TC-DEV-001` + admin-tree `TC-DEV-002`), so the earlier "remaining: TC-DEV-002" phase note was stale and is now corrected (phase list + status line updated to "complete"). Validation: `yarn generate` clean (no generated diff), `yarn typecheck` green, and the three devices-governing guard suites pass (`optimistic-lock-editable-entities`, `optimistic-lock-ui-coverage`, `module-decoupling` — 49 tests). Phase 1 is PR-ready against `develop`.
- **2026-06-25** — **Module 3 architecture revised to ride the `communication_channels` hub** (maintainer request on PR #2595: push must be an end-to-end feature built on the hub, not a standalone provider seam). Verified feasible with **no `ChannelAdapter` contract change**: FCM/APNs/Expo become hub `ChannelAdapter` packages (`packages/channel-{fcm,apns,expo}`, `channelType:'push'`, outbound-only, `pollIntervalSeconds=null`); provider creds live on a tenant-scoped `CommunicationChannel` (encrypted `IntegrationCredentials`) while device tokens stay in `UserDevice`; the `push` delivery strategy fans out per device and invokes `adapter.sendMessage` directly (the `test-send` route pattern). The `PushProvider` interface in the original draft is superseded by the hub adapter registry; a `push_stub` adapter covers tests. Phases re-scoped: Phase 4 now ships three channel-adapter packages; preferences UI folded into Phase 5. Feasibility confirmed against `communication_channels/api/post/channels/[id]/test-send/route.ts`, `lib/connect-channel.ts`, and `lib/adapter.ts`. Decision driven by branch `feat/devices-push-e2e`.
- **2026-06-05** — Phase 1 optimistic-locking pass (review follow-up). Device **edits** are now optimistically locked: the admin detail GET returns `updated_at`, the admin edit `CrudForm` forwards it as `optimisticLockUpdatedAt` (sending the expected-version header), and `executeUpdate` enforces it via `enforceCommandOptimisticLock` (covers both the self `PUT /api/devices/:id` and admin `PUT /api/devices/admin/devices/:id`, since both funnel through it). Enforcement no-ops when the header is absent, so existing mobile self-update clients are unaffected. `UserDevice` was added to the curated `optimistic-lock-editable-entities` guard. Device **deactivate** is deliberately **exempt** (idempotent soft-delete of a registry row, not a concurrent field edit) — marked inline on the admin list page's raw `DELETE` and intentionally not enforced in `executeDeactivate`.
- **2026-06-03** — Phase 1 security/UX hardening. (1) `push_token` secret handling extended beyond the original "not in list/detail" rule: it is now redacted from the audit-log command `snapshotBefore`/`snapshotAfter` (and therefore the derived `changesJson`) and stripped from the mutation-guard payload, closing leaks via `audit_logs.view_self` and enterprise record-lock conflict details; the real token is kept only in the non-exposed undo payload so commands stay undoable. (2) Admin register form renders the `push_token` field as a password input. (3) Confirmed and documented that device identity stays `(tenant, user, device_id)` — `device_id` is a per-app-install id (iOS IDFV; a generated UUID for web), so the iOS app and a browser on the same physical device register as distinct rows; `platform` is descriptive metadata, **not** part of the unique key (adding it would weaken the one-row-per-install guarantee).
- **2026-06-02** — Phase 1 (`devices` module) implemented. Deltas from the original draft, now reflected above: (1) APIs split into self-serve (`/api/devices`, scoped to the acting user) vs admin (`/api/devices/admin/devices`, `devices.admin`) trees instead of a single path with optional cross-user listing; (2) added admin backend pages — list + **create (register-for-user)** + **edit** — beyond the draft's list-only page; (3) `makeCrudRoute` list routes pass `events: { module:'devices', entity:'user_device' }` so the CRUD-cache tag matches the command `resourceKind` (writes now bust the list cache — fixes stale lists under `ENABLE_CRUD_API_CACHE`); (4) shared `api/deviceOps.ts` + `api/deviceList.ts` helpers; (5) customer-role `defaultRoleFeatures` deferred (employee/admin only in Phase 1); (6) integration coverage `TC-DEV-001` + `TC-DEV-002`. Phases 2–6 (notifications extensions, push_notifications, providers, purge worker) remain pending.
- **2026-04-28** — Initial draft. Three-part change: new `devices` module (generic device registry), new `push_notifications` module (push tokens + strategy + provider seam + worker), and additive extensions to existing `notifications` module (DB-backed type registry + channel-agnostic preferences). Categories, priority, non-opt-out, and daily/weekly frequency caps deferred to a later spec. Email/SMS channels designed-for but not built. Verified no existing upstream issue/PR via `gh search` on 2026-04-28. Design informed by a downstream production implementation; app-specific coupling is stripped for core.
