# Notifications Module — Agent Guidelines

In-app notifications plus two channel-agnostic surfaces that every delivery channel (in-app, push, future email/SMS) reads from: a **DB-mirrored notification type catalogue** and **per-user channel preferences**. See `.ai/specs/2026-04-28-push-notifications-and-devices.md` (Phase 2).

## Always

- Register new notification types in your **own** module's `notifications.ts` (`notificationTypes: NotificationTypeDefinition[]`). The generator aggregates them; `bootstrap.ts` feeds the aggregate into the in-memory registry (`lib/notification-type-registry.ts`) via `registerNotificationTypes(...)`. Do **not** add a defaults array here.
- Read channel preferences through `NotificationPreferenceService` (DI: `notificationPreferenceService`) — never query `notification_preferences` directly from another module. Use `isChannelEnabled(scope, typeId, channel)` (defaults to `true` when no row exists — lazy-seed, default-on).
- Keep type ids **FROZEN** (BACKWARD_COMPATIBILITY.md): once a `NotificationTypeDefinition.type` ships it is a stable contract; renames need the deprecation protocol.
- Keep API URLs **STABLE**: `/api/notifications/types`, `/api/notifications/preferences` are additive-only.
- Wire custom write routes through the mutation guard via `runGuardedNotificationWrite(...)` in `lib/routeHelpers.ts` (the preferences `PUT` does this).

## Never

- Never create a cross-module ORM relationship to `notification_types` / `notification_preferences`. `NotificationPreference.notificationTypeId` is a **soft string ref** to a type id, not a FK relation.
- Never write per-tenant rows into `notification_types`. Code-registered types are **system-wide** (`tenant_id IS NULL`); the column is nullable only to leave room for future tenant-defined types.
- Never expose another tenant's preferences — all reads/writes are scoped by `(tenantId, userId)`.

## Type catalogue (read-through mirror)

- The in-memory `NotificationTypeDefinition` registry is the source of truth for code. `notification_types` is a **read-through DB mirror** so remote clients (mobile apps) can enumerate types over HTTP without shipping the catalogue.
- `syncNotificationTypes(em)` reconciles the registry into the table (idempotent, `tenant_id IS NULL`). It runs lazily on the first `GET /api/notifications/types` per process and on the `notifications.type_registry.sync` event (emitted from `setup.ts` `seedDefaults`; handled by `subscribers/sync-notification-types.ts`).
- Field map: `id ← def.type`, `label_key ← def.labelKey ?? def.titleKey`, `description_key ← def.descriptionKey ?? null`. Give a type a distinct preferences-screen label by adding optional `labelKey`/`descriptionKey` to its `NotificationTypeDefinition` (additive — falls back to `titleKey`).
- Mark a type `silent: true` on its `NotificationTypeDefinition` to make its pushes content-available wake-ups (no banner, data-only, bypass the per-channel push preference). This is the gate for `push_notifications` `sendSilentPush`; the flag lives only in the in-memory registry (not mirrored to `notification_types`).
- A create call may carry an optional `data` (arbitrary app-readable string map — persisted on the row, exposed in the notification DTO, and delivered in the push data payload) and `pushOptions` (flat `sound`/`badge`/`image`/`priority`/`channelId`/`body` map — persisted, push-only, mapped per provider by the push adapters). Both are additive optional fields on the create/batch/role/feature schemas.

## Preferences & optimistic locking

- `NotificationPreference` carries `updated_at` but is **intentionally excluded** from the curated `optimistic-lock-editable-entities.test.ts` `notifications` list: it is an idempotent, lazy-seeded self-setting written through a service (`setPreferences`) + mutation guard, **not** `CrudForm`/`makeCrudRoute`, so a lost-update undo stack adds no value. When a preferences UI lands (Phase 5), its mutating call must either send the optimistic-lock version header or carry an inline `optimistic-lock-exempt` marker to satisfy `optimistic-lock-ui-coverage.test.ts`.

## ACL

- `notifications.view`, `notifications.create`, `notifications.manage`, `notifications.manage_preferences` (self-serve; granted to all default roles). After editing `acl.ts`, run `yarn mercato auth sync-role-acls`.

## Validation

```bash
yarn generate
yarn db:generate            # diff probe; keep only the notifications migration + snapshot
yarn workspace @open-mercato/core build
yarn workspace @open-mercato/core test
```
