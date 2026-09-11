# SPEC-072: Recipient-locale rendering for system emails and notifications

## TLDR

Open Mercato core renders system emails and notification mail in the
**initiator's request locale** (or a global default), never the **recipient's
stored language**. Give core a stored per-user locale and a backward-compatible
recipient-locale seam so mail renders in the recipient's language out of the box,
with an optional override. **Phase 1 (auth emails) is implemented; Phase 2
(notification delivery) is now unblocked — the notification-pipeline rewrite
landed upstream as `open-mercato/open-mercato#5366` (supersedes the closed
#4326) — and has narrowed to the email channel plus a base-copy-locale handoff
to the push fan-out, because the merged pipeline already localizes push
per device and in-app per viewer.**

## Problem

Core renders three classes of system message keyed on the **initiator's request
locale** (or a single global default), never on the **recipient's stored
language**. Any OM app whose users have a per-user language preference sends
wrong-language mail on background sends and cross-user sends — most visibly, an
invitation renders in the *inviting admin's* interface language rather than the
*invitee's* preference.

This is a platform-level gap, not an app concern: core owns the render, so no
downstream app can fix it without a seam. It affects every multi-locale OM
deployment. Two independent apps hit it — **Tournee** (EN/PL) and **Covo**; the
latter worked around it by abandoning the notification channel and sending mail
inline via `sendEmail`. (See § Example consumers.)

Root cause, confirmed in core:

- **No stored per-user locale.** `User` has no locale/language field; locale is
  resolved purely per request (`i18n/server.ts` `detectLocale`: cookie →
  `Accept-Language` → `defaultLocale`). `/api/auth/locale` only sets a cookie.
- **The three send paths inherit the wrong locale:**
  1. **Password reset** — `auth/api/reset.ts` uses `resolveTranslations()`
     (request locale of whoever hit the endpoint).
  2. **Brand-new invitee** — `auth/commands/users.ts` (`sendInviteToUser`) uses
     `resolveTranslations()` (the inviting admin's request locale).
  3. **Notification delivery** — `notifications/subscribers/deliver-notification`
     resolves the base copy via `resolveNotificationCopy(notification)` without a
     locale argument, i.e. always `defaultLocale`; the recipient row is loaded but
     locale is never read. Post-#5366 this only mis-renders the **email** channel:
     push re-resolves copy per device locale in the fan-out and in-app resolves
     keys client-side in the viewer's UI locale (see § Phasing).
- **No seam.** There is no DI/callback hook for an app to feed a recipient locale
  into the render; an app would have to override the whole subscriber/route.

## Proposed solution

### Built-in default + optional override

Per maintainer direction (this should work out of the box, not be per-app
config), core ships both layers:

1. **Stored locale** — a core `user_preferences` module: one row per
   `(user, tenant)` holding `preferred_locale`, set explicitly by the user via
   `GET`/`PUT /api/user_preferences/me`. Mirrors 1:1 the shape Tournee already
   built (SPEC-059/P27) so Tournee can drop its app-level satellite and consume
   core's.
2. **Recipient-locale resolver seam** — `registerRecipientLocaleResolver(fn)` in
   `@open-mercato/shared/lib/i18n`, with `fn: (em, userId, tenantId) => Locale |
   undefined`. The `user_preferences` module registers a default reader over the
   stored preference; a downstream app may re-register to override (last wins).
   Signature matches Tournee's `resolveUserLocale(em, userId, tenantId)` exactly,
   so Tournee registers its resolver verbatim (no adapter) — this also resolves
   the review note that the hook must expose `em` + `tenantId`.

### Resolution precedence

`resolveTranslationsForRecipient(em, userId, tenantId)` picks the locale as:

1. `OM_FORCE_LOCALE` — ops-level override (same as `detectLocale`).
2. host-registered resolver result — the recipient's **stored** locale.
3. `detectLocale()` — request cookie / `Accept-Language` (today's behavior).
4. `defaultLocale`.

The default resolver returns `undefined` when the user has **no** stored row, so
paths 3–4 preserve current behavior for users who never set a preference. This is
what keeps the change non-regressive and upstream-mergeable.

Core's stored default is the platform `defaultLocale` (`en`) — not Tournee's
historical `pl`. Apps needing a different fallback override the resolver rather
than changing this default.

## Phasing

- **Phase 1 — auth emails (implemented).** Password reset + new-invitee.
  Independent of the notification-pipeline rewrite.
- **Phase 2 — notification delivery (unblocked).** The rewrite this phase was
  waiting on landed upstream as `open-mercato/open-mercato#5366` (devices
  registry + end-to-end mobile push; supersedes the closed #4326, merged as
  `fb93574fa`). The merged pipeline already localizes two of the three channels,
  which narrows Phase 2 to:
  - **Push — no locale work needed.** The `push` strategy hands raw i18n keys +
    variables to `fanOutPushDeliveries`, which resolves title/body **per
    `device.locale`** (memoized per distinct locale) via the shared
    `resolveNotificationCopy(copy, locale)` helper. Device locale wins for push,
    as intended.
  - **In-app — no locale work needed.** The `Notification` row carries the keys;
    the bell/inbox resolves them client-side in the viewer's own UI locale
    (`NotificationItem.tsx`). The in-app strategy itself is a no-op.
  - **Email — the remaining gap.** The dispatch subscriber resolves the base
    copy (`title`/`body`/`t`) in `defaultLocale` and the email strategy bakes
    the subject, body, and mail chrome from it. Phase 2 resolves the recipient's
    stored locale via the SPEC-072 resolver (precedence: `OM_FORCE_LOCALE` →
    registered resolver → `defaultLocale`; there is no request context in the
    subscriber, so the `detectLocale()` step does not apply) and passes it to
    `resolveNotificationCopy`, exposing the resolved locale on
    `NotificationDeliveryContext` (e.g. `copyLocale`).
  - **Base-copy handoff to push (required reconciliation).** The push fan-out
    has a fast path that reuses `ctx.title`/`ctx.body` verbatim when a device's
    locale resolves to `defaultLocale` — it assumes the base copy IS
    default-locale. Once the base copy follows the recipient's stored locale,
    that assumption breaks (an `en` device of a user with a `pl` preference
    would get a Polish push). The fan-out must compare against the base copy's
    actual locale (`copyLocale`) instead of `defaultLocale`, and a device with
    **no** locale falls back to `copyLocale` (the recipient's stored preference)
    rather than `defaultLocale` — device locale still wins whenever set.

## Architecture

Modules stay decoupled: `auth` never imports `user_preferences`. The link is the
shared registry — `user_preferences` registers the resolver as a load-time side
effect; `auth` consumes it via `resolveTranslationsForRecipient`. `shared` keeps
zero domain dependencies (`em` is passed opaquely as `unknown`; the registered
resolver casts it back).

## Data models

`user_preferences` (new table):

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `user_id` | uuid | core auth user id (no FK across modules) |
| `tenant_id` | uuid | indexed |
| `preferred_locale` | text | one of the platform `locales` |
| `created_at` / `updated_at` | timestamptz | |

Unique `(user_id, tenant_id)`. The frozen `User` entity is untouched.

## API contracts

- `GET /api/user_preferences/me` → `{ preferredLocale }` (defaults to platform
  default when unset). `requireAuth`.
- `PUT /api/user_preferences/me` `{ preferredLocale }` → `{ preferredLocale }`;
  `422` on an unsupported locale. `requireAuth`. Routes through the
  `user_preferences.preference.set` command (undoable).

## Usage (app-side)

**Out of the box** — no wiring. With `user_preferences` enabled (default), a user
who set their locale receives system mail in that language automatically:

```
PUT /api/user_preferences/me   { "preferredLocale": "en" }
```

**Override** — an app that stores locale elsewhere registers its own resolver:

```ts
import { registerRecipientLocaleResolver } from '@open-mercato/shared/lib/i18n/server'

registerRecipientLocaleResolver(async (em, userId, tenantId) => {
  return myStore.getLocale(em, userId, tenantId) // Locale | undefined
})
```

## Implementation (Phase 1)

Branch `feat/recipient-locale-auth-emails`:

- `packages/shared/src/lib/i18n/recipient-locale.ts` — registry +
  `resolveRecipientLocale` (ORM-agnostic, fail-closed).
- `packages/shared/src/lib/i18n/server.ts` — `resolveTranslationsForRecipient`,
  re-export of `registerRecipientLocaleResolver`.
- `packages/core/src/modules/user_preferences/` — `UserPreference` entity +
  migration/snapshot, `preference.set` command, `GET`/`PUT
  /api/user_preferences/me`, `resolveUserLocale(s)`, default resolver
  registration.
- `packages/core/src/modules/auth/api/reset.ts` and `auth/commands/users.ts` —
  render via `resolveTranslationsForRecipient`.
- `apps/mercato/src/modules.ts` — `user_preferences` enabled by default.

Validated: `build:packages`, `generate`, `typecheck`, `lint` (0 errors).

## Risks & impact review

- **Behavior change for users with a stored preference** (intended): mail now
  follows the recipient, not the initiator. Users without a stored preference are
  unaffected (fall back to request locale). Severity low; mitigation is the
  `undefined`-on-absence default.
- **Contract surface** — additive only: new module, new optional resolver, new
  table. Frozen `User` untouched. Residual risk low.
- **Email↔push base-copy coupling (Phase 2)** — the push fan-out's fast path
  assumes the base copy is default-locale; changing the base copy to the
  recipient's stored locale without passing `copyLocale` down would send
  wrong-language pushes to devices explicitly set to the default locale.
  Mitigation: the handoff described in § Phasing, covered by a dedicated
  fan-out test (an `en` device of a `pl`-preference user gets `en`).

## Backward compatibility

Additive across all 13 contract surfaces (`BACKWARD_COMPATIBILITY.md`).
Unregistered resolver + no stored preference ⇒ byte-for-byte today's behavior.

## Tests and acceptance

- Reset: user with stored `pl` → PL mail regardless of request locale.
- Invite: invitee with stored `en`, admin on PL → EN invite (language follows the
  recipient, not the initiator).
- No stored preference + no resolver → today's behavior (request locale).
- Registered override takes precedence over the stored preference.
- Phase 2 (email): notification email renders in the recipient's stored locale;
  two recipients with different stored locales each get their own; no stored
  preference ⇒ `defaultLocale` (today's behavior).
- Phase 2 (push handoff): a device with an explicit locale keeps it regardless
  of the recipient's stored preference (`en` device + `pl` preference ⇒ `en`
  push); a device with no locale falls back to the stored preference; per-locale
  memoization in the fan-out is unchanged.
- Phase 2 (in-app): row still carries raw keys — bell rendering follows the
  viewer's UI locale, unaffected by the stored preference.

## Example consumers

- **Tournee** (SPEC-059/P27–P29) already stores per-user locale in an app-level
  `user_preferences` satellite and has localized send services, wired only into
  the one path it owns (org re-invite). The three core-owned paths still fall back
  to request/default because core had no seam. Post-release: bump
  `@open-mercato/core`, drop the satellite (or keep a PL-fallback override),
  remove workarounds.
- **Covo** hit the same gap and bypassed the notification channel with inline
  `sendEmail` — evidence this is a platform problem, not a single-app quirk.

## Delivery workflow

Contribution fork (`fullstackhouse/open-mercato`) → internal FSH review →
upstream PR to `open-mercato/open-mercato` → on release, downstream apps bump the
dependency. Not an eject: the change lands back upstream.

## Implementation (Phase 2)

Small delta on the merged pipeline:

- `packages/core/src/modules/notifications/subscribers/deliver-notification.ts`
  — resolve the recipient's stored locale (resolver seam; `em`,
  `recipientUserId`, `tenantId`), pass it to `resolveNotificationCopy`, expose
  it as `copyLocale` on `NotificationDeliveryContext`.
- `packages/core/src/modules/notifications/lib/deliveryStrategies.ts` —
  additive `copyLocale` field on the context type.
- `packages/core/src/modules/push_notifications/lib/push-delivery-strategy.ts` /
  `push-fanout.ts` — thread `copyLocale` through; reuse-base-copy condition
  becomes `locale === copyLocale`; no-locale device fallback becomes
  `copyLocale`.
- Email / in-app strategies — no changes (email consumes the already-localized
  `ctx.title`/`ctx.body`/`ctx.t`; in-app is a no-op).

## Changelog

- 2026-08-18 — Phase 2 unblocked: #4326 was closed and superseded by #5366
  (merged as `fb93574fa`). Re-scoped Phase 2 to the merged pipeline: push is
  already per-device localized and in-app is viewer-localized, so the remaining
  work is the email base copy in the dispatch subscriber plus the
  `copyLocale` handoff to the push fan-out. Added Phase 2 implementation notes,
  acceptance tests, and the email↔push coupling risk.
- 2026-07-31 — Reframed as an OM-platform spec (Tournee/Covo as example
  consumers); added built-in stored locale + resolver design, resolution
  precedence, phasing (emails now / notifications after #4326), and usage
  examples. Phase 1 implemented on `feat/recipient-locale-auth-emails`.
- 2026-07-30 — Initial draft (recipient-locale seam across three paths).

## Status

Phase 1 implemented; Phase 2 unblocked (#5366 merged) and re-scoped — ready to
implement. Draft for review.
