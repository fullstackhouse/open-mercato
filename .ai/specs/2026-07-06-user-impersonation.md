# Backend User Impersonation (`auth` module)

- Status: Draft (pending review)
- Scope: OSS (`packages/core/src/modules/auth` + `packages/shared/src/lib/auth`)
- Related: `.ai/specs/enterprise/` (none), no existing GitHub issue/PR as of 2026-07-06

## TLDR

Let an authorized admin **act as another backend (staff) user** for support/troubleshooting — see the app exactly as that user does, with that user's own roles and org scope — while the platform keeps recording the **real** admin as the acting party. Impersonation starts from the users list, shows a persistent "Impersonating …" banner with an **Exit** action, never elevates privileges, is gated by a new `auth.users.impersonate` feature, and writes start/stop audit events plus per-action attribution. It reuses the existing `Session` + audience-derived JWT machinery and mirrors the super-admin `actorTenantId`/`actorOrgId` scope-override pattern already in `packages/shared/src/lib/auth/server.ts`.

## Overview

The platform already supports one narrow "view as" capability: a **super-admin** can set `om_selected_tenant` / `om_selected_org` cookies and `applySuperAdminScope()` rewrites their `AuthContext.tenantId`/`orgId` (recording the originals as `actorTenantId`/`actorOrgId`) — but the admin still acts **as themselves** with **their own** (super-admin) permissions. There is no way to reproduce a specific user's experience with *that user's* exact roles/features/org scope, which is what support and QA actually need to debug "it doesn't work for me" reports.

This spec adds first-class **user impersonation**: a bounded, fully-audited session where the acting request resolves to the target user's identity and permissions, while every write remains attributable to the real admin.

## Problem Statement

- Support/QA cannot reproduce a user-specific issue without asking the user for credentials (a security anti-pattern) or guessing at their role/feature/org configuration.
- Super-admin tenant/org switching changes *scope* but not *identity or permissions* — it cannot reveal what a limited-permission user actually sees or can do.
- Any home-grown "log in as" hack (copying tokens, sharing sessions) breaks the audit trail: actions would be attributed to the target user, hiding who really performed them. That is unacceptable for a multi-tenant system where `ActionLog.actorUserId` is the accountability record.

## Goals / Non-Goals

### Goals

1. An authorized admin can start impersonating a chosen backend user and browse the backend UI **as that user** (their roles, features, org scope, tenant).
2. The acting user's **effective permissions are exactly the target's** — impersonation is never a privilege-escalation path.
3. Every request and every mutation during impersonation is attributable to the **real admin** (audit + `ActionLog`), not just the target.
4. Start and stop are explicit, produce audit events, and are visibly indicated in the UI with a one-click **Exit** that restores the admin's own session.
5. Impersonation is bounded (short TTL, no nesting) and scoped (you can only impersonate users you are permitted to reach within your tenant/org authority).

### Non-Goals

- Portal/customer-account impersonation (separate `customer_accounts` auth system). Explicitly out of scope for phase 1; noted as a future extension.
- API-key or programmatic impersonation (API keys already carry a `userId`; unchanged here).
- Impersonating across tenants for **non**-super-admins.
- Editing/reset of the target user's credentials while impersonating (blocked — see Guardrails).

## Proposed Solution (high-level)

Impersonation is modeled as a **dedicated staff session for the target user that carries the impersonator's identity**. Concretely:

1. Admin invokes `POST /api/auth/impersonate` with `{ userId, reason? }`.
2. The handler authorizes (`auth.users.impersonate` + reachability + guardrails), then creates a new `Session` for the **target** user annotated with `impersonatorUserId` / `impersonatorSessionId`, and issues a staff JWT whose `sub` is the target but which also carries `imp` claims identifying the real admin.
3. The admin's **own** session is left intact (not deleted) so **Exit** can mint a fresh admin token from it. The new impersonation JWT replaces the `auth_token` cookie; a short-lived, httpOnly `impersonation` marker is unnecessary because the JWT itself carries the `imp` claims.
4. On every request, `AuthContext` resolution surfaces `impersonatorUserId`/`impersonatorEmail`/`impersonatorSessionId` alongside the (target-derived) identity. Downstream permission checks, org scoping, and data reads all use the **target** identity unchanged; only audit/attribution reads the impersonator fields.
5. `POST /api/auth/impersonate/exit` validates the impersonator's original session is still alive, mints a fresh admin `auth_token`, deletes the impersonation session, and emits the stop event.

This deliberately mirrors the existing scope-override seam (`actorTenantId`/`actorOrgId`) so the mental model and code shape are already familiar.

### Design Decisions

- **Identity swap, not permission overlay.** `sub` becomes the target user so *all* existing RBAC/query/scoping code paths work with zero changes and cannot accidentally leak the admin's elevated rights. The admin is tracked only in additive `impersonatorUserId` fields.
- **Persist impersonation on the `Session` row** (new nullable columns) rather than only in the JWT, so the server can (a) validate an impersonation token against DB state on every request exactly like normal sessions, (b) render an admin-facing "active impersonations" view, and (c) force-revoke.
- **Exit restores from the live admin session**, not from a client-held return token — the return path is derived from server state, so a tampered/edited cookie cannot forge admin restoration. If the admin session expired mid-impersonation, Exit fails closed and forces re-login.
- **No nesting.** A request that is already impersonating may not start a new impersonation; the start handler rejects when `auth.impersonatorUserId` is set.
- **Additive contract only.** New optional JWT claims, new optional `AuthContext` fields, new nullable DB columns, new ACL feature, new endpoints — no existing signature/type/route changes. See Backward Compatibility.

### Alternatives Considered

- **Cookie-only "view as" (extend `applySuperAdminScope`)** — rejected: it changes scope, not identity/permissions, so it can't reproduce a limited user's experience, and it's super-admin-only.
- **Client holds an admin "return token" cookie** — rejected: forgeable/edit-prone and can desync from server session state; deriving Exit from the persisted admin session is safer.
- **Brand-new `ImpersonationSession` entity** — rejected for phase 1: reusing `Session` with nullable columns keeps the per-request validation path (`resolveCanonicalStaffAuthContext`) identical and avoids a parallel session lifecycle. Revisit if impersonation grows independent lifecycle needs.

## Architecture

Touched surfaces (all additive):

- `packages/shared/src/lib/auth/jwt.ts` — allow signing/verifying optional `imp` claims (they already flow through `JwtPayload = Record<string, any>`; no signature change, just documented claim names).
- `packages/shared/src/lib/auth/server.ts` — `AuthContext` gains optional `impersonatorUserId?`, `impersonatorEmail?`, `impersonatorSessionId?`. Canonical resolution copies the `imp` claims through after the same session/user integrity checks used today; **scope override and permission resolution are unchanged** (they run against the target identity).
- `packages/core/src/modules/auth/data/entities.ts` — `Session` gains nullable `impersonatorUserId`, `impersonatorSessionId`, `impersonationReason`, `impersonationStartedAt`.
- `packages/core/src/modules/auth/lib/sessionIntegrity.ts` — when resolving a session flagged as impersonation, additionally confirm the impersonator user still exists and is not soft-deleted; otherwise treat the token as invalid (fail closed).
- `packages/core/src/modules/auth/services/authService.ts` — `createImpersonationSession(admin, target, reason)`, `endImpersonation(session)` helpers building on existing `createSession` / `deleteSessionById`.
- `packages/core/src/modules/auth/api/impersonate.ts` — `POST` start handler.
- `packages/core/src/modules/auth/api/impersonate-exit.ts` — `POST` exit handler (route `/api/auth/impersonate/exit`).
- `packages/core/src/modules/auth/acl.ts` — new feature `auth.users.impersonate`.
- `packages/core/src/modules/auth/events.ts` — `auth.impersonation.started`, `auth.impersonation.ended`.
- `packages/core/src/modules/auth/backend/…` (users list) — "Impersonate" row action gated by the feature.
- `packages/ui` topbar (or auth-provided widget injection) — persistent impersonation banner + Exit button.

### Request flow (while impersonating)

```
Request → auth_token (impersonation JWT: sub=target, imp.userId=admin)
        → resolveCanonicalStaffAuthContext:
            • verify JWT (staff audience)                      [unchanged]
            • load Session by sid; confirm not expired/deleted [unchanged]
            • confirm session.user === sub (target)            [unchanged]
            • confirm target User exists / not deleted         [unchanged]
            • if session.impersonatorUserId set:
                 confirm impersonator User exists / not deleted [NEW, fail-closed]
            • resolve target roles + ACL/features + org scope  [unchanged — TARGET's]
        → AuthContext { sub: target, …target perms…,
                        impersonatorUserId, impersonatorEmail, impersonatorSessionId }
```

### Commands & Events

- Emit `auth.impersonation.started` (payload: `{ impersonatorUserId, targetUserId, tenantId, organizationId, reason, sessionId }`) on start.
- Emit `auth.impersonation.ended` (payload adds `{ startedAt, endedAt, durationMs }`) on exit and on force-revoke.
- Any `ActionLog` written during an impersonated request MUST record the **real admin** as `actorUserId` and stamp `contextJson.impersonatedUserId = <target>` (+ `contextJson.impersonation = true`). This is the accountability guarantee; see Test Coverage.

## Data Models

### `Session` (extend existing table — `packages/core/src/modules/auth/data/entities.ts`)

New nullable columns (default null → existing rows unaffected):

| Column | Type | Meaning |
|--------|------|---------|
| `impersonator_user_id` | uuid nullable | Real admin who started impersonation; null for normal sessions |
| `impersonator_session_id` | uuid nullable | Admin's own session id, used to mint the return token on Exit |
| `impersonation_reason` | text nullable | Optional free-text reason captured at start (for audit) |
| `impersonation_started_at` | timestamptz nullable | When impersonation began |

Migration: additive `ALTER TABLE … ADD COLUMN` only; update `migrations/.snapshot-open-mercato.json` for the `auth` module. No backfill.

### JWT claims (documented, additive; `JwtPayload` already permissive)

`imp` block on the staff token while impersonating:

```
imp: { userId: <adminId>, email: <adminEmail>, sid: <adminSessionId> }
```

Normal tokens omit `imp` entirely.

## API Contracts

### `POST /api/auth/impersonate`

- Guard: authenticated staff + `auth.users.impersonate`.
- Body: `{ userId: string (uuid), reason?: string }` (zod-validated in `data/validators.ts`).
- Rejections (all fail closed, minimal messages):
  - target not found / soft-deleted → 404
  - target not reachable in caller's authority (non-super-admin: target must share tenant and be within the caller's org scope; super-admin: any tenant) → 403
  - caller is **already** impersonating (`auth.impersonatorUserId` set) → 409 (no nesting)
  - target is a super-admin and caller is not a super-admin → 403 (no escalation)
  - target `userId === auth.sub` (self) → 400
- Effect: create impersonation `Session` for target, issue impersonation JWT, set `auth_token` cookie (short TTL, see Guardrails), keep admin session, emit `auth.impersonation.started`.
- Response: `{ ok: true, redirect: '/backend' }`.

### `POST /api/auth/impersonate/exit`

- Guard: authenticated staff whose `AuthContext.impersonatorUserId` is set (otherwise 400 — nothing to exit).
- Effect: validate admin session (`impersonator_session_id`) still exists and unexpired; if valid mint fresh admin `auth_token`; delete impersonation session; clear impersonation state; emit `auth.impersonation.ended`. If admin session is gone/expired → clear cookies and 401 with `{ ok: false, redirect: '/login' }` (forces re-login).
- Response: `{ ok: true, redirect: '/backend' }`.

### (Optional, phase 2) `GET /api/auth/impersonate/active`

- Guard: `auth.users.impersonate` (or a manage variant). Lists live impersonation sessions in the caller's authority for oversight + force-revoke. Deferred; not required for MVP.

## RBAC / Guardrails

- New feature id: **`auth.users.impersonate`** (module `auth`, title "Impersonate users"). Wildcard-aware via existing `hasFeature`/`matchFeature`; `auth.*` and `*` grant it as usual.
- **No privilege escalation**: effective permissions are always the target's, because `sub` is the target and RBAC resolves from the target's roles/ACL unchanged.
- **Reachability**: non-super-admin may impersonate only users in the **same tenant** and within their **org scope**; super-admin may impersonate cross-tenant (consistent with existing super-admin scope powers).
- **No nesting**: cannot start impersonation from an impersonated session.
- **No super-admin capture**: a non-super-admin cannot impersonate a super-admin.
- **Credential safety**: while impersonating, block target-account credential mutations (password change/reset, email change, delete-self) — the impersonation session is not proof of the target's consent. Enforced by a guard that rejects those specific auth writes when `impersonatorUserId` is set.
- **Bounded TTL**: impersonation `auth_token` gets a short lifetime (default 30 min, env-tunable, e.g. `OM_IMPERSONATION_TTL_MINUTES`) — shorter than the normal 8h staff token. No refresh token is issued for impersonation (no `session_token`), so it cannot be silently extended.

## Audit

- Reuse the `audit_logs` module: impersonated requests set `ActionLog.actorUserId = adminId` and `contextJson.impersonatedUserId = targetId`, `contextJson.impersonation = true`. This keeps the accountability record pointed at the real actor while still recording who was impersonated.
- Start/stop emit dedicated `auth.impersonation.*` events (subscribable, e.g. for notifications/alerting).
- `impersonation_started_at` + `impersonation_reason` persist on the session for post-hoc review.

## UI/UX

- **Users list** (auth backend): a feature-gated "Impersonate" row action → optional reason prompt → start → redirect to `/backend`.
- **Persistent banner**: while `AuthContext.impersonatorUserId` is set, render a top-of-app banner ("You are viewing as **{targetName}** — Exit") with an always-visible **Exit** button calling `/api/auth/impersonate/exit`. Use DS status tokens (not hardcoded colors); the banner must be visually distinct and non-dismissable so the admin never forgets they are impersonating.
- Wrap the Exit mutation with the standard guarded-mutation/`apiCall` helpers (never raw `fetch`).

## Internationalization (i18n)

- All new strings (row action, reason prompt, banner text, error toasts) go through `auth/i18n` locale files via `useT()` / `resolveTranslations()`. Internal-only throws prefixed `[internal]`.

## Migration & Compatibility

See Backward Compatibility below. Net: additive columns, additive optional claims/fields, new feature, new routes. Opt-in per tenant by granting the feature to a support role. Default: no role has `auth.users.impersonate` unless a super-admin (who has `*`) or an explicit grant provides it.

## Backward Compatibility

- **DB schema**: additive nullable columns only; no data migration; snapshot updated. (STABLE surface respected.)
- **Types**: `AuthContext` gains **optional** fields; `JwtPayload` already `Record<string, any>`. No existing field changes.
- **API routes**: two brand-new routes; no existing route touched.
- **ACL**: one additive feature id (ADDITIVE-ONLY surface). No existing id renamed/removed.
- **Events**: two additive event ids under existing `auth.*` namespace.
- No deprecations required; `BACKWARD_COMPATIBILITY.md` deprecation protocol not triggered.

## Phasing

### Phase 1 — Core impersonation (MVP)
- `Session` columns + migration + snapshot.
- `AuthContext`/JWT `imp` claim plumbing + `sessionIntegrity` fail-closed check.
- `authService` start/end helpers; start + exit endpoints; validators; ACL feature; events.
- Guardrails (reachability, no nesting, no super-admin capture, credential-write block, bounded TTL, no refresh token).
- `ActionLog` attribution stamping for impersonated requests.

### Phase 2 — UX + oversight
- Users-list row action, reason prompt, persistent banner + Exit.
- Optional `GET /api/auth/impersonate/active` + force-revoke for oversight.

### Phase 3 (future, separate spec)
- Portal/customer-account impersonation (`customer_accounts`).

## Integration & Test Coverage

Unit:
- `sessionIntegrity`: impersonation token invalid when impersonator user is deleted; valid otherwise; normal sessions unaffected.
- `authService.createImpersonationSession` / `endImpersonation` happy path + admin-session-expired-on-exit.
- Guardrails: nesting rejected, super-admin capture rejected, self rejected, cross-tenant rejected for non-super-admin, allowed for super-admin.
- `AuthContext` resolution surfaces `impersonatorUserId` and still resolves **target's** features/org scope.

Integration (Playwright, self-contained fixtures per `.ai/qa/AGENTS.md`):
- `POST /api/auth/impersonate` without feature → 403; with feature → 200 and subsequent request identity is target with target permissions.
- A mutation during impersonation writes `ActionLog` with `actorUserId=admin` and `contextJson.impersonatedUserId=target`.
- Credential-change endpoints blocked while impersonating.
- `POST /api/auth/impersonate/exit` restores admin identity; with expired admin session → 401 + login redirect.
- Banner appears while impersonating and Exit clears it. (needs-qa: UI)

## Risks & Impact Review

| Risk | Severity | Area | Mitigation | Residual |
|------|----------|------|------------|----------|
| Impersonation becomes a privilege-escalation path | High | auth/RBAC | `sub`=target so perms resolve from target only; no admin features carried; explicit no-super-admin-capture guard | Low |
| Actions mis-attributed to target, hiding the admin | High | audit | `ActionLog.actorUserId`=admin + `contextJson.impersonatedUserId`; dedicated start/stop events; integration test asserts attribution | Low |
| Cross-tenant data exposure via impersonation | High | tenancy | Reachability guard (same-tenant for non-super-admin; super-admin parity with existing scope powers); org-scope check | Low |
| Forged/edited return path restores admin illegitimately | Med | auth | Exit derives from persisted admin `Session`, not a client token; fail closed to re-login | Low |
| Stale/never-ending impersonation | Med | auth | Bounded TTL, no refresh token, no nesting; optional force-revoke (phase 2) | Low |
| Target credential change under impersonation | Med | auth | Block credential-mutating auth writes while `impersonatorUserId` set | Low |
| Migration adds columns to hot `sessions` table | Low | db | Nullable, no backfill, no index change | Low |

## Resolved Decisions

- Reuse `Session` (not a new entity) for phase 1.
- Identity-swap model (`sub`=target) over permission-overlay.
- Exit restores from server-side admin session, fails closed on expiry.
- Portal impersonation deferred.

## Open Questions

- Should impersonation be **OSS or enterprise-gated**? It extends core `auth`, so this spec places it in OSS; if product wants it as a paid support capability, move guardrail/oversight (phase 2 `active`/force-revoke) behind enterprise and keep the primitive in OSS. **Needs product decision.**
- Default TTL value (proposed 30 min) and whether a hard max-session cap should also apply.
- Whether to notify the impersonated user (e.g. email/notification) that their account was accessed — privacy/compliance call per deployment.

## Final Compliance Report

- Tenant scoping preserved (target identity drives all scope/RBAC). ✅
- No contract-surface breakage (all additive). ✅
- No cross-module ORM relationships introduced. ✅
- i18n for all user-facing strings; DS tokens for banner. ✅
- Optimistic-locking rule: no new user-editable entity introduced (columns on `Session`, not a CRUD form). N/A.
- Integration + unit coverage enumerated above; to be implemented with the change. ⏳ (on implementation)

## Changelog

- 2026-07-06 — Initial draft. No prior GitHub issue/PR existed; created after auth/session architecture review. Pending maintainer review of Open Questions (OSS vs enterprise gating, TTL, user notification).
