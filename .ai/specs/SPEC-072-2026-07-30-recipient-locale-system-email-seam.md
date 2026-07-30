# SPEC-072: Recipient-locale seam for system emails and notification delivery

## Problem

Open Mercato core renders three classes of system message keyed on the
**initiator's request locale** (or a single global default), never on the
**recipient's stored language**. Any OM app whose users have a per-user language
preference therefore sends wrong-language mail on background sends and cross-user
sends — most visibly, an invitation renders in the *inviting admin's* interface
language rather than the *invitee's* preference.

This is a platform-level gap, not an app concern: core owns the render, so no
downstream app can fix it without a seam. It affects every multi-locale OM
deployment. (Tournee — EN/PL, fallback PL — is the concrete example that surfaced
it; see § Example consumer.)

The three affected send paths in `@open-mercato/core`:

1. **Password reset** — `modules/auth/api/reset.ts` renders and sends inline via
   `resolveTranslations()` (request locale); no pre-send event, no
   recipient-locale parameter.
2. **Brand-new invitee** — `modules/auth/commands/users.ts` (`auth.users.create`
   with `sendInviteEmail: true`) sends inline via `resolveTranslations()`. Its
   validator requires `password || sendInviteEmail`, so a password-less invite
   cannot pass `sendInviteEmail: false` to suppress the core send.
3. **Notification delivery** —
   `modules/notifications/subscribers/deliver-notification` renders through a
   private, non-exported `resolveNotificationCopy` that calls
   `loadDictionary(defaultLocale)` once, with no recipient input and no
   DI/callback seam. NOTE: this path is being restructured by
   `open-mercato/open-mercato#4326` — see § Sequencing & interaction with #4326.

## Goal

Add a **backward-compatible recipient-locale seam** across the three paths so a
downstream app can resolve each recipient's stored locale before the mail is
rendered. When no host resolver is registered, behavior is byte-for-byte today's
(request-locale / default). Purely additive across every contract surface.

## Seam design (per path)

One consistent shape — an **optional host-registered resolver**, consumed before
dictionary load, defaulting to existing behavior when unregistered.

### Notification delivery

```
resolveNotificationLocale(recipientUserId, ctx) => locale | Promise<locale> | undefined
```

Consumed in the `notifications:deliver` subscriber before the copy is rendered;
unregistered ⇒ `defaultLocale` (current behavior). Then the selected dictionary
loads once per delivered notification.

**`ctx` must carry what the resolver needs to look up a stored preference —
concretely a DI container / `EntityManager` handle and `tenantId`** (the
subscriber already resolves both). Resolving a recipient's stored locale is a
tenant-scoped DB lookup, not a pure function of the user id; a hook shaped as
`(recipientUserId) => locale` alone cannot drive a real preference store without
new plumbing. The seam must therefore expose `em` + `tenantId` on `ctx` (or take
`tenantId` as an explicit parameter).

### Password reset

`auth/api/reset.ts` — same resolver-hook shape (resolve recipient locale by user
id before rendering `ResetPasswordEmail`). Same input constraint: `em` +
`tenantId` must be reachable (both available once the route looks up the user by
email). Acceptable alternatives if maintainers prefer: a recipient-locale render
parameter, or a DI-overridable reset-mailer service.

### New invitee

`auth/commands/users.ts` — either the same recipient-locale seam on the inline
send, or a "mint invite token but do not send" option (relax the
`password || sendInviteEmail` validator so a password-less invite can pass
`sendInviteEmail: false`) so the app owns and localizes the send. Maintainers
pick the least invasive.

## Sequencing & interaction with #4326

`open-mercato/open-mercato#4326` (devices + end-to-end push) rewrites the
notification delivery pipeline this seam hooks into: it adds a `shouldDeliver`
gate on every channel, a module-registered channel catalogue, per-`(user, type,
channel)` preferences, a `NotificationDeliveryContext` split, **and a per-device
locale concept**. It rewrites the `resolveNotificationCopy` path directly.

Therefore:

- **Paths 1 and 2 (auth emails) are independent of #4326** and can be
  contributed at any time.
- **Path 3 (notification delivery) should land after #4326 merges** and be
  designed on top of the restructured pipeline: resolve recipient locale once per
  delivery, before the per-channel render, reconciled with #4326's per-device
  locale (device locale, when present, likely takes precedence for push;
  recipient stored locale drives email / in-app). Building path 3 against today's
  `resolveNotificationCopy` guarantees a rebase conflict and risks the wrong seam
  location.
- Open a coordinating note/issue on #4326 so the maintainers place the locale
  hook inside the new gate rather than the old copy function.

## Non-goals

- No change to stored in-app notification records — they stay language-neutral
  keys + variables, localized only at render time.
- No new locale storage mechanism — the seam only *resolves* a locale the host
  already stores.

## Backward compatibility

Additive across all 13 contract surfaces (per `BACKWARD_COMPATIBILITY.md`). New
optional resolver registration; unregistered ⇒ unchanged behavior. No signature
break: any new `ctx` field is additive, any validator relaxation widens (never
narrows) accepted input.

## Tests and acceptance

- Default path unchanged when no resolver is registered (all three paths).
- A registered resolver selects the recipient's locale for each path.
- Notification path: two recipients with different stored locales each render in
  their own locale.

## Example consumer (Tournee)

Tournee already built the recipient-locale rendering (SPEC-059 P28/P29) but has
no core seam to hook it in:

- `user_preferences/lib/localized-auth-mail.ts` (`sendLocalizedAuthEmail`)
- `user_preferences/lib/localized-notification-delivery.ts`
  (`resolveNotificationLocale(em, recipientUserId, tenantId)` — the tenant-scoped
  lookup that dictates the `ctx` requirement above)

Once this seam ships, Tournee registers a thin adapter that reads `em` +
`tenantId` off `ctx` and calls its existing implementation; the wrong-language
behavior disappears with no further app-side logic. Tournee's own migration spec
(SPEC-063) tracks the dependency bump, wiring, and interim English-only fallback
— that scheduling is a Tournee concern and stays out of this spec.

## Status

Draft
