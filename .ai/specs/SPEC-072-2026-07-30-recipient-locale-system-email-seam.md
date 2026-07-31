# SPEC-072: Recipient-locale rendering for system emails and notifications

## TLDR

Open Mercato core renders system emails and notification mail in the
**initiator's request locale** (or a global default), never the **recipient's
stored language**. Give core a stored per-user locale and a backward-compatible
recipient-locale seam so mail renders in the recipient's language out of the box,
with an optional override. **Phase 1 (auth emails) is implemented now; Phase 2
(notification delivery) is deferred until after the upstream notification-pipeline
rewrite `open-mercato/open-mercato#4326`.**

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
     hardcodes `loadDictionary(defaultLocale)`; the recipient row is loaded but
     locale is never read.
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

- **Phase 1 — auth emails (implemented now).** Password reset + new-invitee.
  Independent of the notification-pipeline rewrite.
- **Phase 2 — notification delivery (deferred, after #4326).**
  `open-mercato/open-mercato#4326` (devices + end-to-end push) rewrites the
  delivery pipeline this path hooks into — adds a `shouldDeliver` gate, a
  module-registered channel catalogue, per-`(user, type, channel)` preferences, a
  `NotificationDeliveryContext` split, **and a per-device locale concept**, and
  rewrites the `resolveNotificationCopy` path directly. Building path 3 now
  guarantees a rebase conflict. Phase 2 lands after #4326 merges, reuses the same
  resolver on the new pipeline, and reconciles with per-device locale (device
  locale likely wins for push; stored locale drives email / in-app).

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
- **Phase 2 sequencing** — building the notification path before #4326 merges
  risks conflicts; mitigated by deferring Phase 2.

## Backward compatibility

Additive across all 13 contract surfaces (`BACKWARD_COMPATIBILITY.md`).
Unregistered resolver + no stored preference ⇒ byte-for-byte today's behavior.

## Tests and acceptance

- Reset: user with stored `pl` → PL mail regardless of request locale.
- Invite: invitee with stored `en`, admin on PL → EN invite (language follows the
  recipient, not the initiator).
- No stored preference + no resolver → today's behavior (request locale).
- Registered override takes precedence over the stored preference.
- Phase 2: two recipients with different stored locales each render in their own.

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

## Changelog

- 2026-07-31 — Reframed as an OM-platform spec (Tournee/Covo as example
  consumers); added built-in stored locale + resolver design, resolution
  precedence, phasing (emails now / notifications after #4326), and usage
  examples. Phase 1 implemented on `feat/recipient-locale-auth-emails`.
- 2026-07-30 — Initial draft (recipient-locale seam across three paths).

## Status

Phase 1 implemented; Phase 2 deferred pending #4326. Draft for review.
