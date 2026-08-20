# Legal Documents & Consent Ledger (core `legal` module)

## TLDR

A new upstream core module `packages/core/src/modules/legal/` providing a versioned, append-only
**legal-documents ledger** and an append-only **consent ledger**. Each document type has an ordered
history of **versions**; a version carries its title and body as **separate per-language content
rows** (translations), not a mutable JSONB blob. Versions get auto-assigned effective-date-aware
dotted-decimal labels and can incorporate other documents by reference. Recording one user's
acceptance also records acceptance of the whole referenced closure under a shared `actionId`, each
row pointing at the exact **content row** (version + language) the user was shown. Design highlights:

1. Documents reference each other with a **stable token** (`legal:<type>[:<version>][?lang=<code>]`,
   optionally pinning an exact version and/or display language) in the content, never a real URL. The
   backend never resolves the token to a URL - it stores and returns it verbatim; each client (web,
   mobile, …) substitutes it into a link of its own choosing. No deeplink configuration exists in the
   backend.
2. References are **computed in the backend** from those tokens - never admin-selected. The admin UI
   shows the resulting incorporated-document names read-only (no checkboxes).
3. Content accepts **any language** (validated with `isValidIso639`, the i18n way), not only served
   locales; and an admin can **add a language** to a document's current or any future version by
   **appending a new content row** - existing translations are never modified.

Scope: documents + consent ledger only. Consent subject = auth user.

## Overview

Applications built on Open Mercato need to serve versioned legal documents (Terms & Conditions,
Privacy Policy, etc.) to clients, prove which exact wording a user accepted, and re-ask for consent
when a document changes. There is no such capability upstream today. This spec introduces one as a
reusable core module.

Three append-only tables:

- **`legal_documents`** - one row per **version** of a document type. Holds the version label, its
  `effectiveFrom` date, the computed list of documents it incorporates by reference, and scope.
  Immutable once written - a correction is a new version.
- **`legal_document_contents`** - one row per **(version, language)** translation: the localized
  title and body. This is what makes the ledger genuinely append-only: adding a language is an
  INSERT of a new row, and existing translations are never mutated. Unique `(document_id, language)`.
- **`legal_consents`** - one row per accepted content. A single acceptance writes one row for the
  content the user saw plus one row per document in the transitive reference closure (each in its
  served language), all sharing an `actionId`. Each row references a `legal_document_contents` row,
  so the exact version **and** language the user was shown are captured without a separate `language`
  column. App-supplied placeholder substitutions the user saw are stored alongside.

## Problem Statement

- **No versioned legal documents upstream.** Apps cannot serve, version, or prove legal-document
  acceptance without building it themselves.
- **Baking real URLs into the content couples the ledger to one app's URL layout and rots.** Content
  rows are immutable, so a URL written into a body goes stale the moment the app's domain or routing
  changes, with no way to fix past versions. Worse, different clients want different targets - a web
  app wants an `href`, a mobile app wants a native screen or a `myapp://` deep link. The document must
  therefore carry a portable, stable reference and leave link-building to each client.
- **An editable references field can drift from reality.** If an admin hand-picks incorporated
  documents, the stored list can diverge from what the content actually links. References must be
  derived from the content so the ledger cannot misrepresent what a document incorporates.
- **Restricting content to served locales is too narrow, and a mutable per-version blob is not a
  ledger.** A legal team may need to publish in a language the app UI does not (yet) serve, and to
  backfill a translation onto an existing version. Storing translations as rows lets that be an
  append, preserving the provenance of the languages already published.

## Proposed Solution

Build `packages/core/src/modules/legal/` following the `customers` reference module structure, reusing
the platform's existing i18n, dictionaries, markdown-editor, CRUD-factory, and command
infrastructure. The module is generic: document types are a `dictionaries` value, consent metadata is
an open shape, and there is no app-specific document type, payment metadata, or third-party
observability coupling.

### Change 1 - references are stable tokens the client resolves

Authors reference another legal document with a **stable token**, not a real URL - a markdown link
whose target is `legal:<type>[:<version>][?lang=<code>]`:

- `legal:<type>` - the **currently-active** version of `<type>`, served in the reader's language, e.g.
  `[Terms and Conditions](legal:terms_and_conditions)`.
- `legal:<type>:<version>` - a **pinned exact version**, incorporated even after it is superseded, e.g.
  `[Privacy Policy v2.1](legal:privacy_policy:2.1)`.
- `?lang=<code>` - a **pinned display language**, overriding the reader's locale for that reference,
  e.g. `[English Privacy Policy](legal:privacy_policy:2.0?lang=en)` (for "governed by the English
  version" clauses). Combines with or without a pinned version.

Token grammar: `legal:` scheme (fixed), then `<type>` (`[a-z0-9_]+`), then an optional `:<version>`
(dotted-decimal `[0-9.]+`), then an optional `?lang=<code>` (`<code>` validated with `isValidIso639`).
**`<type>` must not contain a colon or a question mark** - the type validator forbids `:` and `?`, so
the token parses unambiguously: strip an optional `?lang=<code>` suffix, then split the rest on `:`.

The backend **stores and returns the token verbatim** and never turns it into a URL. Each consumer
detects `legal:<type>[:<version>][?lang=<code>]` link targets and substitutes them however suits it
(web route, native navigation, `myapp://` deep link, an emailed/PDF URL, …), using knowledge it
already has at render time. This keeps the stored wording stable and immutable, needs no per-tenant
deeplink configuration in the backend at all, and lets web and mobile handle the same document
differently.

### Change 2 - references computed, not selected

`publishDocumentSchema` has no `references` field. The publish command derives `references` **only**
from the tokens found across the version's content rows (deduplicated, own type excluded). Each
reference is stored as `{ type, version?, language? }` (`version`/`language` present only when the
token pins them). Guards: every language of the version must link the same set of
`{ type, version?, language? }` tuples (`findReferenceDiscrepancies`); an unpinned reference's type must
exist in the ledger and a pinned reference's exact `(type, version)` must exist (a pinned `?lang` is
**not** required to exist at publish - translations can be added later, and serving falls back to the
default locale); a document cannot reference its own type. The admin create form inserts tokens via an
"insert legal link" helper and shows a read-only "Incorporated documents" panel recomputed client-side
from the tokens - no checkboxes/multi-select.

### Change 3 - any language input + append-a-language

- Content rows are keyed by arbitrary language codes validated with `isValidIso639` (ISO 639-1, ~184
  codes). Every content row carries a non-empty `title` **and** `body` (no metadata-only rows - there
  is nothing else to serve). The default locale (`en`) content row is required at publish so the
  serving fallback always resolves.
- New command/endpoint `legal.document.add_language`: **inserts** a new `legal_document_contents` row
  for a `(version, language)`. Rejects if that language row already exists (unique constraint /
  existing translations are immutable), rejects unless the version is the currently-effective one
  **or** future-dated (never a superseded past version), and requires the new content to link the same
  referenced documents as the version's existing content rows.

### Reference closure & consent recording

Recording consent for a document resolves its transitive reference closure (BFS, cycle-safe) and
writes one `legal_consents` row per document, all sharing one `actionId`:

- An **unpinned** reference (`{ type }`) resolves to that type's **currently-active** version; a
  client-supplied version for it must be the currently-effective one (else 409).
- A **pinned** reference (`{ type, version }`) resolves to that **exact** version regardless of
  whether it is still active; the supplied/recorded version must equal the pinned one.
- A reference with a **pinned `language`** is served in that language (falling back to the default
  locale if that translation does not exist); an unpinned reference is served in the requested language
  with the same fallback. Either way the consent row points at the exact `legal_document_contents` row
  actually served.
- App-supplied `{{placeholder}}` values (e.g. an amount shown in a waiver) are stored in
  `placeholder_values` on the accepted (primary) document's row. The `legal:` tokens in the immutable
  body are themselves the durable record of what was incorporated - there is nothing to freeze.

A supplied consent map must still cover the whole closure (400 if any document is missing).

## Architecture

Module tree (mirrors `customers`):

```
packages/core/src/modules/legal/
  index.ts            ModuleInfo + export { features } from './acl'
  acl.ts              feature ids
  setup.ts            defaultRoleFeatures, seedDefaults (types dictionary)
  di.ts               register legalDocumentResolver
  events.ts           legal.document.published, legal.document.language_added, legal.consent.recorded
  data/entities.ts    LegalDocument, LegalDocumentContent, LegalConsent
  data/validators.ts  zod schemas (language via isValidIso639; type forbids ':' and '?')
  lib/
    compute-version.ts         effective-date-aware version assignment
    document-references.ts      legal:<type>[:<version>][?lang=<code>] token parse + cross-lang discrepancy
    select-document-content.ts  pick a content row for a locale, with default fallback
    record-consent.ts           closure resolution + append (content-row subject)
    serialize-document.ts       public/admin serializers (return body verbatim, tokens intact)
    seeds.ts                    LEGAL_DOCUMENT_TYPES_DICTIONARY_KEY + default types
  services/legal-document.service.ts     LegalDocumentResolver (active/current/all/version + closure)
  commands/
    index.ts, publish-document.ts, add-document-language.ts, record-consent.ts
  api/
    openapi.ts
    documents/route.ts                      GET public list, POST publish
    documents/admin/route.ts                GET admin list (current|all)
    documents/[type]/route.ts               GET active detail + reference tree
    documents/[type]/[version]/route.ts     GET one version
    documents/[type]/[version]/languages/route.ts  POST add language
    consents/route.ts                       POST record consent (auth user)
    consents/admin/route.ts                 GET consents by userId
  backend/
    legal-documents/page.tsx (+ .meta)      DataTable list, Add-translation row action
    legal-documents/create/page.tsx (+ .meta)  publish form (dynamic langs, no ref checkboxes)
    legal-documents/add-language/...         add-translation UI (useGuardedMutation)
    legal-documents/document-details-dialog.tsx
  i18n/{en,pl,es,de,ko}.json
  migrations/Migration<fullTimestamp>_legal.ts + .snapshot-open-mercato.json
  __tests__/  __integration__/  AGENTS.md
```

Reused platform pieces: `isValidIso639` / `getIso639Label` / `ISO_639_1`
(`@open-mercato/shared/lib/i18n/iso639`), `defaultLocale`, the `dictionaries` module
(`DictionarySelectControl`, `loadDictionaryEntriesByKey`), `MarkdownField`
(`@open-mercato/ui/backend/inputs/MarkdownField`), `makeCrudRoute` + command bus,
`getAuthFromRequest`, `createLogger`.

Cross-module rules honored: no direct ORM relations across modules (consent `userId` is an auth-user
FK-id only, resolved separately). Within the module, `legal_document_contents.document_id` and
`legal_consents.document_content_id` are ordinary intra-module FKs. All queries scoped by
`tenantId`/`organizationId`.

## Data Models

### `legal_documents` (entity `LegalDocument`)
One row per version. Append-only. Unique `(type, version)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | `gen_random_uuid()` |
| `type` | text | document type (a `legal_document_types` dictionary value) |
| `version` | text | dotted-decimal, auto-assigned (effective-date-aware) |
| `effective_from` | timestamptz | activation instant |
| `references` | jsonb null | `Array<{ type: string; version?: string; language?: string }>` incorporated references (`version`/`language` set only when the `legal:<type>[:<version>][?lang=<code>]` token pins them) - **computed from content tokens, never client-set** |
| `tenant_id` | uuid null | scope |
| `organization_id` | uuid null | scope |
| `created_at` | timestamptz | tie-breaker for same-`effective_from` versions |

No `updated_at`: a version row is immutable. There is no in-place edit and no undo - a correction is
always a **new version**. A mistaken version that has not yet taken effect is neutralized by
publishing another version at the same `effective_from` (the newer-created row wins the tie, so the
mistaken one never serves); a version that has already taken effect can only be corrected going
forward by publishing a superseding version. In both cases the earlier row stays in the ledger as
evidence.

**Version ordering & same-date ties.** Versions are ordered by `(effective_from ASC, created_at
ASC)`; the dotted-decimal label is assigned to match that order (a new row is appended with the next
leading integer, or given the shortest label strictly between its neighbours). `effective_from` has
no unique constraint, so two versions may share a date. When a new version is published with the same
`effective_from` as an existing (e.g. future-dated) version, the new row - created later - sorts
**after** the existing one and takes a higher label; and once that date is reached, active resolution
(`ORDER BY effective_from DESC, created_at DESC`) serves the **newer-created** row, superseding the
earlier same-date version (the sanctioned "re-publish to correct a future version" path). The earlier
version remains in the ledger as evidence but never serves. Consequences: (a) you cannot insert a
same-date version that sorts *before* an existing same-date one - choose an earlier `effective_from`
instead; (b) concurrent publishes computing the same label collide on `(type, version)` and the loser
recomputes via the retry loop.

### `legal_document_contents` (entity `LegalDocumentContent`)
One row per `(version, language)` translation. Append-only. Unique `(document_id, language)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `document_id` | uuid | FK → `legal_documents.id` (intra-module) |
| `language` | text | ISO 639-1 code (`isValidIso639`) |
| `title` | text | localized title (required, non-empty) |
| `body` | text | localized body markdown (required, non-empty), storing `legal:<type>[:<version>][?lang=<code>]` reference tokens verbatim |
| `tenant_id` | uuid null | scope |
| `organization_id` | uuid null | scope |
| `created_at` | timestamptz | |

Existing rows are never updated; adding a language inserts a new row. Reference detection scans the
`body` for `legal:<type>[:<version>][?lang=<code>]` tokens. The body is stored and served verbatim
(tokens intact); consumers resolve tokens themselves.

### `legal_consents` (entity `LegalConsent`)
One row per accepted content. Append-only. Indexes on `user_id` and `action_id`. Exempt from
`updated_at`/optimistic locking (append-only log).

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `user_id` | uuid | auth user (FK-id only, cross-module - resolved separately) |
| `document_content_id` | uuid | FK → `legal_document_contents.id` - captures version **and** language |
| `action_id` | uuid null | groups the rows of one acceptance (accepted content + closure) |
| `metadata` | jsonb null | caller-supplied context bag stored verbatim - the acceptance's provenance and any external links (e.g. `{ source: 'payment', paymentId, paymentMethodId, ... }`); see note below |
| `placeholder_values` | jsonb null | app-supplied `{{placeholder}}` substitutions the user saw (e.g. `{ amount: '€10.00' }`) |
| `tenant_id` | uuid null | scope |
| `organization_id` | uuid null | scope |
| `created_at` | timestamptz | |

No separate `language` column - the referenced content row already encodes the served language. The
consented wording is reproduced from the immutable content row (`title` + `body`, tokens intact) with
`placeholder_values` substituted into `{{...}}`; the `legal:` tokens in the body are the durable record
of the incorporated documents.

**Consent metadata.** `metadata` is an **open, caller-supplied JSON object** (validated only as an
object with string keys; no fixed schema), stored verbatim on each row written for the acceptance
(all rows sharing the `action_id` carry the same metadata, so any row is self-describing). It captures
*why/where* the consent was taken and links it to the business event that required it - the most
important case being a **payment authorization**, where the caller passes the payment identity so the
consent is provably tied to the charge it authorized, e.g.:

```json
{ "source": "payment", "paymentId": "pi_123", "paymentMethodId": "pm_456", "platform": "stripe" }
```

`source` is a free-form string (app-defined: `signup`, `reconsent`, `payment`, `top_up`, …) - the core
module does not enumerate a closed set, keeping it generic. Metadata is never interpreted by the
module beyond storage; it is part of the immutable, append-only record.

## API Contracts

All routes export `openApi` (tag `Legal`). Feature-gated via `metadata.requireFeatures`. Public and
admin responses return the body **verbatim** (with `legal:<type>[:<version>]` tokens intact) for the
requested locale, falling back to the `en` content row; consumers resolve the tokens.

| Method & path | Auth / feature | Purpose |
|---------------|----------------|---------|
| `GET /api/legal/documents` | public | Active version of each type (metadata only), locale-resolved title. Uncached. |
| `POST /api/legal/documents` | `legal.document.publish` | Publish a version. Body: `{ type, translations: [{ language, title, body }], effectiveFrom? }` (must include the `en` translation; every translation carries a non-empty title and body). Creates the version row + one content row per translation; `references` derived server-side from `legal:<type>[:<version>][?lang=<code>]` tokens in the bodies. |
| `GET /api/legal/documents/admin?view=current\|all` | `legal.document.view` | Admin listing incl. all content rows (every language) per version. |
| `GET /api/legal/documents/[type]?language=` | public | Active version detail + referenced-documents tree (bodies verbatim). |
| `GET /api/legal/documents/[type]/[version]?language=` | public | A specific version (body verbatim). |
| `POST /api/legal/documents/[type]/[version]/languages` | `legal.document.add_language` | Body: `{ language, title, body }` (both non-empty). Inserts a content row on a current/future version. 4xx on duplicate language, past-version, or reference-discrepancy violations. |
| `POST /api/legal/consents` | authenticated user | Record consent for the caller. Body: `{ type, consentByType?, language?, placeholderValues?, metadata? }`. `metadata` is an open object stored verbatim on every row of the acceptance (e.g. `{ source: 'payment', paymentId }`). Resolves each accepted/closure document to a content row and appends the acceptance. |
| `GET /api/legal/consents/admin?userId=` | `legal.consent.view` | A user's recorded consents (rendered wording, resolved via `document_content_id`). |

Status codes: publish 201/400/401/500; add-language 400 (invalid / discrepancy), 404 (unknown
version), 409 (duplicate language / past version) - final mapping locked in implementation; consent
400 (incomplete closure) / 409 (supplied version not effective).

### Commands
All three are append-only and **audit-logged but not undoable** (`isUndoable: false`, `buildLog`
defined, no `undo` handler) - nothing in this module mutates or removes an existing row. See
§ Audit & Access Logging.
- `legal.document.publish` - insert version + content rows in one atomic write; references computed;
  unique-constraint retry on version. Not undoable; correct/supersede by publishing another version.
- `legal.document.add_language` - insert one content row on a current/future version. Not undoable.
- `legal.consent.record` - append the acceptance closure (one row per content) under one `actionId`.
  Not undoable (a recorded consent is a fact).

## Audit & Access Logging

Non-undoable does **not** mean un-logged - the two are independent in the command framework. Every
write is action-logged; every read of the sensitive ledgers is access-logged.

- **Action logs (writes).** Each command returns `buildLog()` metadata
  (`{ actionLabel, resourceKind, resourceId, tenantId, organizationId }`); the command bus persists an
  `ActionLog` row and stamps `actorUserId` from `ctx.auth.sub`. Because these commands are append-only
  they set `isUndoable: false` and define **no** `undo` handler and no undo snapshot - the action is
  still recorded, it just cannot be reversed. Resource kinds:
  - `legal.document` (id = the version's `legal_documents.id`) for `legal.document.publish` and
    `legal.document.add_language` (the language-add log names the added language in `actionLabel` and
    can set `relatedResourceKind/Id` = the new `legal_document_contents.id`).
  - `legal.consent` (id = the accepted `legal_consents.id`, `actorUserId` = the consenting user) for
    `legal.consent.record`.
- **Access logs (reads).** The admin endpoints that expose evidence -
  `GET /api/legal/documents/admin` and especially `GET /api/legal/consents/admin` - call
  `logCrudAccess` (`@open-mercato/shared/lib/crud/factory`, backed by the `audit_logs` access log) with
  the returned item ids, so "who viewed whose consent records" is itself auditable. Public document
  reads are not access-logged (they are unauthenticated and non-sensitive).

This reuses the platform's existing `audit_logs` action/access logging - no new logging surface.

## Integration Coverage (required)

Ships with the change (self-contained fixtures created in setup, cleaned up in teardown; no reliance
on seeded/demo data).

**API paths**
- `POST /api/legal/documents` → publish; assert version auto-assignment, that content rows are
  created per translation, and computed `references` from a `legal:<type>` token in a body.
- `GET /api/legal/documents` and `GET /api/legal/documents/[type]` → active resolution + reference
  tree + locale fallback (requested language missing → `en` row served); assert the body is returned
  verbatim with `legal:<type>[:<version>][?lang=<code>]` tokens intact (backend does not rewrite them).
- `GET /api/legal/documents/admin?view=current|all` → all content rows per version.
- `POST /api/legal/documents/[type]/[version]/languages` → happy path (inserts a content row);
  rejects a duplicate language; rejects a past/superseded version; rejects a reference discrepancy.
- `POST /api/legal/consents` + `GET /api/legal/consents/admin?userId=` → records the closure under one
  `actionId`, each row bound to a content row; a pinned `legal:<type>:<version>` reference records the
  pinned version while an unpinned one records the active version, and a `?lang=<code>` reference
  records the pinned language (falling back to the default locale when that translation is absent);
  `placeholder_values` holds the
  app-supplied values on the primary row; supplied `metadata` (e.g. `{ source: 'payment', paymentId }`)
  is stored verbatim on every row of the acceptance and round-trips through the admin listing; 400 on
  incomplete closure, 409 on a non-effective supplied version.
- Logging: publish and `record-consent` write an `ActionLog` (correct `resourceKind`, `resourceId`,
  `actorUserId`); `GET /api/legal/consents/admin` writes an access-log entry for the viewed ids.

**UI paths**
- Legal documents list, publish form (dynamic language rows, no reference checkboxes, read-only
  incorporated-documents panel), add-translation flow.

**Unit tests**
- `compute-version` incl. the same-`effectiveFrom`-as-a-future-version tie (new row sorts after and
  takes a higher label; active resolution serves the newer-created row); `document-references` token
  parsing (`legal:<type>`, pinned `legal:<type>:<version>`, and `?lang=<code>` variants parsed to
  `{ type, version?, language? }`; a colon- or question-mark-bearing type rejected; an invalid `lang`
  code rejected; a plain URL or unrelated link ignored; discrepancy detection over full tuples across
  content rows); `add-document-language` (duplicate-language rejection, past-version rejection,
  reference consistency, row inserted); `record-consent` (closure resolution to content rows, pinned
  vs active version selection, pinned-language selection with default-locale fallback,
  effective-version check); `select-document-content` (row selection + `en` fallback).

## Risks & Impact Review

| Risk | Severity | Area | Mitigation | Residual |
|------|----------|------|------------|----------|
| Adding a language changes what a live version serves | Low | serving | It is an INSERT of a new content row; existing rows are immutable; existing consents point at the content row they saw | Low |
| A consumer renders a `legal:` token literally instead of substituting a link | Low | client contract | Token substitution is a documented client responsibility; the token is human-readable and unambiguous; the incorporated set is also exposed structurally as `references` for clients that prefer it | Low |
| Author writes a raw URL instead of a `legal:<type>` token | Medium | authoring | Such a link is not detected as a reference; the create form inserts tokens via a helper and the read-only incorporated-documents panel makes a missing reference visible before publish | Low |
| Reference cycles in the incorporation graph | Low | closure | BFS closure is cycle-safe (`seen` set) | None |
| Concurrent publishes computing the same version | Low | publish | Unique `(type, version)` + retry loop | None |
| Version + its content rows written non-atomically | Low | publish | Publish command writes the version and its content rows in one atomic flush/transaction | None |
| Consent `userId` referencing a deleted auth user | Low | data | FK-id + no ORM relation; admin listing tolerates missing user; append-only evidence retained | Low |
| Any-language input widens stored language set beyond served UI locales | Low | i18n | `isValidIso639` bounds input to real ISO 639-1 codes; serving falls back to `en` | Low |

New contract surfaces (additive): entities/tables `legal_documents`, `legal_document_contents`,
`legal_consents`; API routes under `/api/legal/*`; DI key `legalDocumentResolver`; ACL features
`legal.*`; events `legal.document.published`, `legal.document.language_added`,
`legal.consent.recorded`; commands `legal.document.publish`, `legal.document.add_language`,
`legal.consent.record`. No existing contract surface is modified, so `BACKWARD_COMPATIBILITY.md`
deprecation protocol does not apply.

## Open questions / decisions log
- Deeplink resolution is **entirely client-side** (confirmed). The backend stores and returns
  `legal:<type>[:<version>]` tokens verbatim and holds **no** deeplink config - no base URL, no path
  prefix, no settings page, no `ModuleConfigService` usage. Each client substitutes tokens into links
  its own way (web `href`, native navigation, `myapp://`, emailed/PDF URL). Rationale: the backend
  cannot resolve a token without being told a base URL, and any consumer that knows its base can
  substitute trivially itself - so a backend resolver adds nothing and would only rot. This reverses
  the original "user-specified base URL + path prefix" ask, deliberately.
- Reference links use a fixed `legal:` token scheme (confirmed) rather than a raw URL.
- Token grammar (confirmed): `legal:<type>[:<version>][?lang=<code>]` - optionally pinning an exact
  `<version>` (dotted-decimal) and/or a display `<code>` (ISO 639-1). `<type>` MUST NOT contain a colon
  or a question mark (the type validator forbids `:` and `?`), so the token parses unambiguously (strip
  a `?lang=` suffix, then split on `:`). A pinned version incorporates that exact version even after it
  is superseded; a pinned language forces that translation (default-locale fallback if it is absent),
  overriding the reader's locale for that one reference. `?lang` need not exist at publish time.
- `placeholder_values` holds **only** app-supplied `{{value}}` substitutions (confirmed). Deeplinks are
  not frozen into it: the `legal:` token in the immutable body is itself the durable record of the
  incorporated document, robust to any later client-side change of how the link is rendered.
- Language granularity: **ISO 639-1** (confirmed) via `isValidIso639`; BCP-47 regional variants
  (`pt-BR`) are out of scope for now.
- Consent subject: **auth user** (confirmed).
- Consent `metadata` is an **open caller-supplied JSON object** (confirmed), stored verbatim on every
  row of the acceptance, for provenance and linking the consent to the business event that required it
  (notably a payment: `{ source: 'payment', paymentId, paymentMethodId, ... }`). The core module does
  not enumerate a closed `source` set or interpret metadata.
- `body` (and `title`) on a content row are **required, non-empty** (confirmed). There are no
  metadata-only rows: a title without a body has nothing to serve or consent against.
- No `published_url` column (confirmed, dropped). The stored per-language content is the canonical,
  immutable source of a version's wording; an external URL would be a second, un-versioned source that
  could drift from the recorded wording and weaken the consent proof.
- Correcting a mistaken **added translation**: a content row is immutable and unique per
  `(version, language)`, so a typo in an added translation is corrected only by publishing a new
  version (same rule as the version level). A "supersede a single content row" mechanism is
  intentionally **not** included - it would complicate content resolution for little gain. Revisit
  only if operational need appears.
- Default document types to seed: generic (e.g. `terms_and_conditions`, `privacy_policy`) - final
  list TBD during implementation.

## Final Compliance Report
_To be completed after implementation (validation gate results, migration + snapshot, ACL sync,
integration-test run)._

## Changelog
- 2026-08-20 - Initial spec drafted. Not yet implemented.
