# Amendments to Tenant Legal Documents & Consent Versioning

## TLDR

This spec is an **amendment layered on** `.ai/specs/2026-08-18-tenant-legal-documents-and-consent-versioning.md`
(the merged base design). It keeps that design's **module placement and infrastructure wholesale** -
legal documents in `content`, controller identity in `directory`, the append-only consent ledger in
`auth`, `onboarding`/`checkout` as consumers, host-based public-page tenant resolution, the neutral
sample fallback, `{{controller*}}` identity-token baking, integrity seals, and the pseudonym-salt
erasure model - and adds four capabilities on top:

1. **Append-a-translation to a live version.** Per-language **content rows** in `content` so a locale
   can be added to an already-published (current or future) version without cutting a new version -
   each row write-once and separately hashed.
2. **Cross-document references + closure consent.** A stable `legal:<kind>[:<version>][?lang=<code>]`
   token in a document body incorporates another legal document; accepting the primary also records
   consent for its whole reference closure under one action, in `auth`.
3. **Open consent metadata + off-session pre-check.** An unsealed `metadata` bag on the ledger (e.g.
   `{ source:'payment', paymentId }`) and a read-only "is this user's consent still current?" check for
   charges taken with no user present (auto-refill).
4. **Any-language input.** Content locales accept any ISO 639-1 code (`isValidIso639`), not only the
   app's served locales.

Nothing here changes the base spec's GDPR-erasure, host-resolution, or seal design; those are adopted
as-is. Where an earlier standalone draft of this file proposed a separate `legal` module, that is
**superseded** - see § Superseded.

## Relationship to the base spec

| Base spec area | This amendment |
|---|---|
| Placement (`content`/`directory`/`auth`/`onboarding`/`checkout`) | **Keep unchanged.** |
| GDPR erasure via `subject_ref = HMAC(salt, user_id)` + salt destruction; integrity seals (`cev1`/`v2`/legacy); idempotency key | **Adopt as-is.** These supersede the lighter retention note in the earlier draft. |
| Host classification + neutral sample + `legal_document_domains` + default tenant | **Keep unchanged.** |
| Controller identity in `directory` (`legal_entity` config, `legalEntityService`, `{{controller*}}` baking) | **Keep unchanged.** |
| Versioning: `version int = max+1` per `(scope, kind)` + `effective_at` | **Keep** - drop the earlier draft's dotted-decimal `compute-version`; integer monotonicity resolves same-effective-date ties (higher version wins). |
| Consent write path via DI `consentLogService` (not the command bus) | **Keep** - the append-only ledger is itself the audit record and `consentLogService` emits `auth.consent.granted/withdrawn`, so a command's "free" ActionLog would only duplicate the ledger while forcing undo ceremony onto a system-flow write. Our closure/metadata/pre-check logic lives **inside** the service. Draft CRUD stays undoable commands; publish stays the guarded action. |
| Document content stored as `published_locales` jsonb on the version row | **Amended** to per-language content rows (delta 1). |

## Delta 1 - per-language content rows (append-a-translation), in `content`

Replace the base spec's `locales` / `published_locales` jsonb columns on `legal_documents` with a child
table so a translation is a row, not a key in a frozen blob - which is what lets a locale be appended
to a live version without a new version, while keeping every published locale immutable.

### `legal_document_contents` (`content`, NEW) - append-only once published

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `document_id` | uuid | FK → `legal_documents.id` (intra-module) |
| `locale` | text | any ISO 639-1 code (`isValidIso639`) - see delta 4 |
| `title` | text | authored title (may carry `{{controller*}}` and `legal:` tokens) |
| `markdown` | text | authored body (tokens verbatim) |
| `published_title` | text NULL | baked at publish/append, immutable |
| `published_markdown` | text NULL | baked at publish/append, immutable |
| `content_hash` | text NULL | `sha256:<hex>` over canonical JSON `{ kind, version, locale, published_title, published_markdown }`, set once when this row is baked; the exact string a consent snapshot pins |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | draft rows editable/soft-deletable (`updated_at` → optimistic lock); published rows reject update/delete |

Unique `(document_id, locale) where deleted_at is null`.

- **Draft** rows are fully editable/soft-deletable (mirrors base-spec draft editing). **Publish** bakes
  tokens into every draft locale row (`published_*` + `content_hash`) and flips the version to
  `published`; those rows become immutable.
- **Append-a-translation** (`content.legal_documents.add_language`, an intra-module command): insert a
  new content row for a locale not yet present on a version, baked + hashed at insert. Allowed only on
  the **currently-effective or a future-dated** version of the `(scope, kind)` - never a superseded past
  version. Existing rows are untouched (immutability preserved). The new locale must incorporate the
  same `legal:` references as the version's existing published locales (delta 2 discrepancy check).
- The base spec's version-level `content_hash` moves here (per row). Rendering resolution is unchanged
  except it selects a content **row** for the locale (requested → `en` → first available); the `en` row
  is required at publish so the fallback always resolves. Public/admin responses return `published_*`
  (with `legal:` tokens intact - delta 2).

## Delta 2 - cross-document references + closure consent

### Tokens (in `content`)
A document body references another legal document with a stable token - never a real URL - as a markdown
link target `legal:<kind>[:<version>][?lang=<code>]`:
- `legal:<kind>` - the currently-active version of that kind; `legal:<kind>:<version>` - a pinned exact
  version (incorporated even after superseded); `?lang=<code>` - a pinned display locale
  (default-locale fallback if absent). `<kind>` is `[a-z0-9_]+` and the validator forbids `:` and `?`
  so the token parses unambiguously.
- The backend **stores and returns the token verbatim**; there is no deeplink config. Each consumer
  resolves it: API/mobile consumers substitute their own link; content's **own server-rendered public
  page** resolves `legal:<kind>` to its own route for that kind (e.g. `/privacy`) using local knowledge
  of its routes and the already-resolved tenant scope - not configuration.

### References + closure
- `legal_documents.references` (`content`, NEW jsonb `Array<{ kind, version?, locale? }>`): computed at
  publish/append from the tokens across a version's published locales - never client-set. Every published
  locale must link the same reference set (`findReferenceDiscrepancies`); an unpinned reference's `kind`
  must exist, a pinned one's exact `(kind, version)` must exist; a document cannot reference its own kind.
- `legalDocumentService.resolveClosure(kind, scope, locale?, at?)` returns the accepted document plus its
  transitive closure (BFS, cycle-safe), each entry resolved to a content row (pinned or active version;
  pinned or requested locale, with `en` fallback).

### Consent closure (in `auth`)
- `consentLogService.record` accepts the resolved closure and writes **one `consent_event` per document**
  (accepted kind + each referenced kind), all sharing one **`action_id`** (new column) and per-entry
  idempotency keys derived from the base key (`<base>:<kind>`). Each event snapshots that entry's
  `document_id`, `document_kind`, `document_version`, `document_content_hash`, and the new
  `document_locale` (the content row served). A supplied closure must be complete (else the caller is
  told which documents are missing).

## Delta 3 - open consent metadata + off-session pre-check (in `auth`)

- **`consent_events.metadata`** (NEW jsonb, **unsealed**): an open caller bag for provenance and links to
  the business event, e.g. `{ source:'payment', paymentId, paymentMethodId }`. Deliberately **outside**
  the `cev1` sealed payload (which the base spec forbids from carrying free text), stored beside
  `ip_address` and **cleared by the erasure-only path** - so it never traps PII under a seal and never
  affects a seal. `source` stays the sealed constrained tag; `metadata` is the unsealed extra.
- **Standing-consent check** `consentLogService.isConsentCurrent({ userId, tenantId, consentType, at? })`:
  reads the user's projection/latest events and reports whether they still hold a current consent for the
  kind **and its currently-active closure**, each at the current version - **writes nothing**. In the
  on-session flow, consent is recorded when the intent is minted (that record is the gate); this check is
  for charges with **no user present** (auto-refill, delayed capture) and for deciding whether to prompt
  re-consent. Exposed as `POST /api/auth/users/consents/verify` (same guard/scoping as the events route)
  and resolvable server-side via DI by a payment flow before an off-session charge.

## Delta 4 - any-language input

`legal_document_contents.locale` is validated with `isValidIso639` (ISO 639-1, ~184 codes), decoupled
from the app's served `locales` and from the tenant's `translations.supported_locales`. The default
locale (`en`) content row remains required at publish so the base spec's render fallback resolves. `?lang`
targets on `legal:` tokens are likewise ISO 639-1.

## Data-model & API deltas (summary)

- `content`: **drop** `legal_documents.{locales, published_locales, content_hash}`; **add** table
  `legal_document_contents` (above) and column `legal_documents.references`. Publish and the new
  `add_language` command write/parse content rows. Public/admin document responses return per-locale
  `published_*` with tokens intact; `references` exposed read-only. New CLI import maps `<kind>.<locale>.md`
  files into content rows (one version, many locale rows) exactly as the base spec's importer intended.
- `auth`: **add** `consent_events.{action_id, document_locale, metadata}`; extend `consentLogService.record`
  for closures; add `consentLogService.isConsentCurrent` + `POST /api/auth/users/consents/verify`. The
  `cev1` sealed payload is unchanged (metadata and closure ids are opaque references/enums; `metadata`
  stays unsealed). Erasure clears `metadata` alongside `ip_address`.

## Integration Coverage (deltas; self-contained fixtures, cleanup in teardown)

- **content** — publish a version with two locales; `add_language` a third locale to the published,
  currently-effective version (row inserted, existing rows untouched, hash per row); rejected on a
  superseded past version; rejected on a duplicate locale; rejected on a reference discrepancy across
  locales. References computed from a `legal:<kind>` token; a pinned `legal:<kind>:<version>` recorded with
  its version; bodies returned verbatim with tokens intact; the server-rendered public page resolves a
  `legal:privacy` token to the `/privacy` route.
- **auth** — recording consent for a kind with a reference closure writes one event per document under one
  `action_id`, each pinning its content row's `document_content_hash` + `document_locale`; a pinned-version
  reference records the pinned version, a `?lang` reference records the pinned locale (default-locale
  fallback); `metadata` (`{ source:'payment', paymentId }`) round-trips through the events endpoint and is
  cleared after `erase-consent-subject` while seals still verify; `POST …/consents/verify` returns current
  vs needs-re-consent and writes no row.
- **Unit** — content-row hashing (golden), token parse (`legal:<kind>`, pinned version, `?lang`, `:`/`?` in
  kind rejected, invalid `lang` rejected), reference discrepancy over locales, closure BFS (cycle-safe,
  pinned vs active), `isConsentCurrent` (current / moved-on-referenced-version / no-consent), any-language
  acceptance + `en`-fallback selection.

## Risks & Impact Review (deltas only; base-spec risks stand)

| Risk | Severity | Area | Mitigation | Residual |
|---|---|---|---|---|
| Appending a locale mutates a live version's meaning | Low | content | It is an INSERT of a write-once row; existing published rows and their hashes are immutable; consents pin the row they saw | Low |
| Per-row hashing diverges from the base spec's version-level hash | Low | content | Move the hash to the content row and pin it in the consent snapshot; publish/append are the only writers; golden-vector test | Low |
| Closure recording writes partial rows | Low | auth | Recorded in the same transaction as the primary event under one `action_id`; idempotency keys per entry make retries safe | Low |
| `metadata` traps PII under a seal or blocks erasure | Low | auth/GDPR | `metadata` is unsealed (never in `cev1`) and cleared by the erasure path, exactly like `ip_address`; callers advised to keep direct identifiers out | Low |
| A consumer renders a `legal:` token literally | Low | client contract | Verbatim by design; content's own page resolves it; the incorporated set is also exposed structurally as `references` | Low |
| Any-language input widens the stored locale set | Low | i18n | `isValidIso639` bounds it to real ISO 639-1; render falls back to `en` | Low |

New contract surfaces (additive on top of the base spec): table `legal_document_contents`; columns
`legal_documents.references`, `consent_events.{action_id, document_locale, metadata}`; command
`content.legal_documents.add_language`; `POST /api/auth/users/consents/verify`; `consentLogService`
gains `resolveClosure` handling and `isConsentCurrent`. No base-spec contract is removed.

## Superseded

The earlier draft of this file specified a **standalone `legal` core module** with its own
`legal_documents` / `legal_document_contents` / `legal_consents` tables, a dotted-decimal
`compute-version`, a `legal.consent.record` command, a client-only deeplink-token scheme with no server
resolution, and a lightweight retention/erasure note. All of that is **superseded** by the base spec's
placement (content/directory/auth), integer versioning, DI `consentLogService`, host-based resolution,
and pseudonym-salt erasure. What survives from the earlier draft - now re-homed as the deltas above - is:
per-language append-only content rows, `legal:<kind>[:<version>][?lang=<code>]` reference tokens + closure
consent, open consent `metadata` with payment linkage, the off-session standing-consent check, and
any-language (ISO 639-1) input.

## Open decisions
- Append-translation via per-language rows (confirmed).
- Consent stays a DI-service write, not a command (decided: the ledger is the audit record; the
  base-spec taxonomy is followed).
- Delta-spec framing on the merged base spec (confirmed).

## Changelog
- 2026-08-20 - Reframed as an amendment on the merged `2026-08-18-tenant-legal-documents-and-consent-versioning.md`:
  keep its placement + GDPR/host/seal/identity design wholesale; add per-language append translations,
  cross-document reference tokens + closure consent, open consent metadata + off-session pre-check, and
  any-language input. Superseded the earlier standalone-`legal`-module draft. Not yet implemented.
