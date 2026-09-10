# List search over encrypted and plain fields: keyed trigram hashes on the projection row

- **Status:** Draft (RFC — pending maintainer review)
- **Scope:** OSS — `packages/core/src/modules/query_index`, `packages/shared/src/lib/search`, `packages/shared/src/lib/query`, `packages/core/src/modules/sales/api/documents`
- **Author:** Jacek Tomaszewski (Full Stack House)
- **Date:** 2026-09-10
- **Related:**
  - `.ai/specs/2026-07-24-search-architecture-clarification-and-evolution.md` — A.3 (division of labour: tokens back DataTable list filters), B.3 ("`search_tokens` cannot be dropped while searchable PII is encrypted at rest"; the Postgres-only profile)
  - `.ai/specs/2026-07-30-search-tokens-unbounded-growth.md`, `.ai/specs/2026-07-31-search-token-probe-index.md`, `.ai/specs/2026-08-24-search-token-double-write.md` — the cost of the prefix-hash design, each paid down one guardrail at a time
  - `packages/shared/src/lib/search/config.ts:11-18` — the comment that names the semantic defect this spec removes (the file's token-only keys go with it) ("`ZK 1/2026` degrades to its year")
  - #6025 (`TENANT_DATA_ENCRYPTION=no` across credentials, session keys and search)
  - #5819 (`declareQueryIndexReindex` — a migration declares the projections it invalidates and `db migrate` queues their reindex after the run commits; this spec's migration uses it to fill the column)
  - Downstream evidence: an order-desk deployment at 1.4M `sales_orders` (Full Stack House / Groomershop), whose measurements are quoted below

## TLDR

List search in Open Mercato is served by `search_tokens`: every eligible string field of every record is split into words, every word is expanded into every prefix from three characters up, and every prefix is stored as one row holding an unkeyed SHA-256. It exists because searchable PII is encrypted at rest and `ILIKE` on ciphertext matches nothing. It has two costs that no guardrail removes. **Semantically** it can only answer "starts with": `1/2026` and `91/2026` hash to the same tokens, the last six digits of a phone never match, and a document number is found by its year. **Physically** it is one row per prefix per field per record — 412M rows and 132 GB on the downstream deployment, 83% of its database — queried through a correlated `EXISTS … GROUP BY … HAVING` executed once per outer row, which is where a 366 s order-number search came from.

This spec replaces the *matching primitive*, not the architecture. Each record's searchable values are cleaned, split into **trigrams**, each trigram is **keyed-hashed per tenant** and truncated to 32 bits, and the set is stored as **one `int4[]` column on the `entity_indexes` row** under **one GIN index**. A search hashes the term's trigrams the same way and asks for rows whose set **contains** them all — pg_trgm's own algorithm, with opaque keys — then **rechecks** the candidates on the decrypted values the engine already holds. That gives word-prefix matching for text and literal substring matching for identifiers, over encrypted and plain fields alike, with no plaintext stored, no extension, no third table, and no new rows: 1.5M records stay 1.5M rows, about a kilobyte of hashes each. The same migration drops `search_tokens`; after the merge the token table, its writer, its four indexes and its seven tuning knobs no longer exist. Modules may declare **`searchFields`** with a *kind* (`text`, `identifier`, `phone`, `taxId`, `email`, `exact`) so phones and tax ids are cleaned and matched the way an operator types them; entities without a declaration get today's field selection with `text` semantics, so nothing has to opt in to benefit. One merge: from it on, list search reads trigrams only; the migration queues the reindex that fills existing rows, and until that job reaches a row the row is simply not found.

## Problem Statement

Everything below was verified on `origin/develop` @ `00d0391` (2026-09-08).

### What list search is today

- **Producer.** `buildSearchTokenRows` (`packages/core/src/modules/query_index/lib/search-tokens.ts:86-150`) iterates every key of the index document and, for each `string`/`string[]` value that `shouldIndexField` (:71-84) accepts, calls `tokenizeText` (`packages/shared/src/lib/search/tokenize.ts:116-131`): NFKD + fold + lowercase (:75-79), split on `[^a-z0-9]+` (:81-85), drop tokens under `OM_SEARCH_MIN_LEN` (3), expand each token into every prefix from that length up (:101-109), hash each with **unkeyed** `crypto.createHash(sha256)` (:111-114). One row per `(record, field, prefix)`.
- **Consumer, engines.** A base-column `like`/`ilike` filter is rewritten in `applyFilterOp` (`packages/shared/src/lib/query/engine.ts:575-620`; hybrid twin in `packages/core/src/modules/query_index/lib/engine.ts`) into `applySearchTokens` (:1633-1695), whose core (:1667-1684) is a correlated subquery per outer row: `EXISTS (SELECT 1 FROM search_tokens st WHERE st.entity_type = ? AND st.field = ? AND st.entity_id = <row>.id::text AND st.token_hash IN (…) GROUP BY entity_id, field HAVING count(distinct token_hash) >= N)`.
- **Consumer, routes.** Customers, auth users, customer accounts, messages, checkout transactions and inbox proposals query the table directly through `findEntityIdsBySearchTokens` (`packages/shared/src/lib/search/tokenLookup.ts:63-115`), same all-tokens semantics (:106-107). The sales documents factory searches **one column**: `filters[numberColumn] = { $ilike: term }` (`packages/core/src/modules/sales/api/documents/factory.ts:127-130`). The CRUD factory has no search option at all (`packages/shared/src/lib/crud/factory.ts` — every `search` hit is URL plumbing).
- **Switch.** `OM_SEARCH_USE_ILIKE_FOR_NON_ENCRYPTED_FIELDS` (default `false`, `config.ts:124`) routes plaintext base columns to real `ILIKE` and keeps the token rewrite for encrypted ones (`engine.ts:465-503`). It is the only way today to make an order number match literally, and it does nothing for a phone inside an encrypted snapshot.

### Why the guardrails cannot fix it

Three specs and four indexes later, the table is bounded, probed cheaply and written once — and still answers the wrong question, expensively:

| | Fact | Consequence |
|---|---|---|
| Semantics | A hash answers equality; prefixes give "starts with" per word. | No substring. `ZK 1/2026` ≡ `ZK 91/2026` (both tokenize to `202`,`2026`). Typing the last six digits of a phone, or a fragment inside an order number matches nothing. `config.ts:11-18` documents this as known. |
| Volume | One row per prefix per field per record. | Downstream: **412M rows, 132 GB, 83% of the database**; `search_tokens` had to be made `UNLOGGED` after a bulk reindex produced 354 GB of WAL. Token inserts were ~65% of write time during an import. |
| Query shape | Correlated `EXISTS … GROUP BY … HAVING` per outer row. | 366 s for an order-number search over 1.38M rows (196 s data + 170 s count); a broad term (`202`) matches 1.29M token rows and never completes. |
| Key | `sha256(prefix)`, no pepper, no tenant. | Any dump reverses every token with a dictionary; the same plaintext hashes identically across tenants. `hashForLookup` (`packages/shared/src/lib/encryption/aes.ts:141-150`) already has a keyed primitive the tokens never adopted. |
| Declaration | None. Every string field is tokenized; the blocklist matches by substring (`config.ts:145-156`). | A module cannot say "this field is a phone" or "match this one whole"; a `hash_id` column is silently unsearchable. |

The 2026-07-24 spec (B.3) is right that the token store *cannot be dropped* — an encrypted deployment needs a hash-based structure. It does not follow that the structure must be prefix hashes in a side table.

## Goals

1. **Word-prefix semantics for text and literal substring for identifiers, on every searchable field**, encrypted or not, with results that are exact (rechecked), explainable, and never fuzzy.
2. **One physical shape**: a column on the projection row the engines already scan. No new table, no extension, no dependency on the tenant's encryption state.
3. **Bounded size**: proportional to records, not to prefix count. Target ≤ 2 KB per row including the index at ~14 searchable values per record.
4. **Index-backed for every term**: the first page of a broad term costs what a selective term costs; only the count is capped.
5. **Per-entity declaration** of searchable fields and their kinds, with a default that needs no declaration.
6. **Country-agnostic** cleaning for phones and tax ids.
7. **One merge, one code path, one table fewer**: no feature flag, no phases, no fallback, no operator step, no bridge. Trigrams are the only search path from the merge on; the migration drops `search_tokens` and queues the reindex that fills the column (#5819), and a row is not found only until that queued job reaches it.

## Non-goals

- Global search (`@open-mercato/search`, Cmd+K, `SearchService`, RRF merging) — untouched except `TokenSearchStrategy`, which reads `search_trgm` instead of `search_tokens` so nothing reads the token table after the merge.
- Meilisearch, vector, tsvector — no engine is added or removed.
- Ranking, typo tolerance, stemming.

## Design

### 1. Storage — `entity_indexes.search_trgm int4[]`

One migration in `query_index`:

```sql
alter table "entity_indexes" add column "search_trgm" int4[] null;
create index concurrently "entity_indexes_search_trgm_idx" on "entity_indexes" using gin ("search_trgm");
drop table if exists "search_tokens";
```

The `down` migration recreates `search_tokens` with its four indexes, empty; a revert then refills it with the old code's `reindex`. GIN over an integer array is built into Postgres (`array_ops`); no `pg_trgm`, no `btree_gin`. `CREATE INDEX CONCURRENTLY` with the drop-if-invalid guard the repo already uses for `search_tokens_presence_idx`. `EntityIndexRow` (`packages/core/src/modules/query_index/data/entities.ts:40-88`) gains the property; the `SearchToken` entity (:254-292) is deleted.

**Why the projection row and not a table.** `entity_indexes` already holds exactly one row per record, is already the table both engines filter on, and is already tenant/org-scoped. A separate `search_values` table would be a third search store beside `entity_indexes` and `search_tokens` (the maintainer's objection that turned the presence marker table into an index in `2026-07-31-search-token-probe-index.md` applies verbatim), and would cost a join the row itself does not need. The column is nullable so the migration is instant and unfilled rows are distinguishable from empty ones.

**Size.** A record with ~14 searchable values of ~250 cleaned characters has ~250 distinct trigrams → ~1 KB of `int4` in the row and roughly the same in the index (GIN posting lists compress well on 32-bit keys). The downstream deployment's 1.5M orders: ~1.5 GB heap + ~1 GB index, against 132 GB today.

### 2. What goes in — fields, kinds, cleaning

**Default (no declaration).** The same field selection as today: every `string`/`string[]` value that `shouldIndexField` accepts from the *decrypted* index document (`decryptIndexDocForSearch`, `packages/shared/src/lib/encryption/indexDoc.ts:45-76`, already computed as `tokenDoc` in `indexer.ts:370-410` and `batch.ts:278-326`), kind `text`. This is what makes the change a drop-in: every entity that is searchable today is searchable tomorrow, with better semantics.

**Declaration (optional refinement).** On the `Module` type (`packages/shared/src/modules/registry.ts:244-277`, next to `entityExtensions` and `defaultEncryptionMaps`):

```ts
searchFields?: Array<{
  entityId: EntityId
  fields: Array<{
    field: string                       // base column, 'cf:<key>', or a label for a collector
    kind?: 'text' | 'identifier' | 'phone' | 'taxId' | 'email' | 'exact'   // default 'text'
    source?: string | ((record, ctx) => Promise<string[] | string | null>)  // JSON path into a column, or a collector
  }>
  replaceDefaults?: boolean             // default false: declared fields refine the default set
}>
```

and on `CustomFieldDefinition` (`packages/shared/src/modules/entities.ts:43-93`) a `searchable?: boolean | SearchFieldKind` beside `filterable`/`indexed`; `cf.text(...)` needs no change (`dsl.ts:19-20` spreads options through). A collector lets a related entity contribute — an order's shipment tracking numbers — with the documented obligation that the related module emits `query_index.upsert_one` for the parent when it writes (the same bridge non-canonical creation events use, 2026-07-24 A.3).

**Cleaning per kind** (one implementation, used by writer and reader, next to `tokenize.ts`):

| kind | cleaning | stored forms | matches |
|---|---|---|---|
| `text` | today's `normalizeText` (NFKD, fold, lowercase), collapse whitespace; split into words on whitespace, `-`, `.` | each word, boundary-padded | **word prefix**: every word of the term starts a word of the value — `wal` finds *Walczak*, not *Kowalski* (see §3) |
| `identifier` | as `text`, whitespace kept | the string | substring, spaces included — `ZK 1/2026` is a literal |
| `email` | lowercase, trim | the string | substring (local part, domain, or whole) |
| `phone` | digits only; a leading `+` or `00` dropped as the prefix marker, nothing else removed | the digit string; plus the national number when a default region is configured (§2a) | substring, ≥ 6 digits |
| `taxId` | uppercase letters and digits only | the string; plus the string with a leading two-letter prefix removed when one is followed by digits (`PL5261040828` → also `5261040828`) | whole value only |
| `exact` | as `text` | the string | whole value only |

"Whole value only" is implemented by wrapping the stored form in two control characters that cleaning never emits (`U+0001 … U+0002`) before trigramming, and wrapping the term the same way at query time; a tax id then never matches inside a phone number.

**Trigrams.** From each stored form: every 3-character window. For `text` each word is first padded with two leading spaces, the way pg_trgm does, so `  w`, ` wa`, `wal` encode "a word starts with *wal*" and a prefix term is a containment query like any other; `identifier`, `email` and `phone` forms are trigrammed unpadded, which is what makes them substring. A form shorter than 3 characters produces no trigrams and is unsearchable (consistent with `OM_SEARCH_MIN_LEN`). Multi-valued fields contribute the union of their values' trigrams.

**2a. Phones and countries.** Open Mercato has no tenant region setting (`Tenant` in `packages/core/src/modules/directory/data/entities.ts:4-26` carries none; locale is per request). Substring on the full digit string already covers the common direction — a term *without* the country code finds a value *with* it. The reverse (value stored bare, term typed with a code) is covered when a default region is configured: `OM_SEARCH_PHONE_DEFAULT_REGION` (env, install-wide) or a tenant setting `search.phoneDefaultRegion` through the `configs` module; both sides are then parsed with `libphonenumber-js/min` and the national number is stored and tried as well. With no region, the reader makes a second attempt with the term's first one to three digits dropped when the term is longer than eight digits — a heuristic, so it runs only after the exact digit string found nothing, and the recheck keeps it honest.

### 3. Hashing and the key

`h(trigram) = int4(HMAC-SHA256(pepper, tenantId + ':' + trigram)[0..4])`, i.e. the existing `hashForLookup` machinery (`aes.ts:141-150`: pepper from `LOOKUP_HASH_PEPPER` → `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` → `TENANT_DATA_ENCRYPTION_KEY`) with the tenant id as `context`, truncated. Properties:

- **Per tenant.** The same plaintext hashes differently in different tenants; a cross-tenant dump join learns nothing.
- **No pepper configured** (e.g. `TENANT_DATA_ENCRYPTION=no` installs): unkeyed SHA-256 with the tenant context — the same strength as today's tokens, never weaker. Logged once at startup, as the token layer does.
- **Rotation.** Changing the pepper means a reindex (`--target search`, §5); the same rule the encryption key already has.
- **32-bit truncation.** ~4 × 10⁹ buckets for ~40 k plausible trigrams per language: collisions are rare, and a collision can only produce a false candidate, which the recheck removes. `int4` halves the row and index against `int8` and the GIN key comparison is cheaper.

**Leakage, stated plainly.** Hashed trigrams are searchable encryption, and every searchable encryption leaks statistics: someone holding a dump *and* the pepper can dictionary-attack trigrams; someone holding only the dump can count hash frequencies across rows within a tenant and guess common fragments. This is strictly less than today, which stores every *prefix* unkeyed and identical across tenants. Fields that must not leak even that stay out of search (`excluded` / blocklist), exactly as now. Plaintext is never stored.

### 4. Query path

**Term shaping.** The term is cleaned once per kind that its shape allows — a term with `@` is tried as `email` and `text`; a digit-only term of ≥ 6 as `phone`, `identifier` and `text`; of 8–14 also as `taxId` (delimited); anything as `text`/`identifier`. Each shaping yields a trigram set. A `text` term with several words yields one set per word. Terms whose every shaping is under 3 characters are rejected with a 400 and a message before any SQL runs (today the engine silently drops the predicate: `engine.ts:533-549` reason `no-indexable-tokens`).

**Predicate.** In both engines, at the site that today builds `applySearchTokens`, a base-column or `cf:` `like`/`ilike` on an entity whose rows carry `search_trgm` becomes

```sql
"entity_indexes"."search_trgm" @> ARRAY[h1, h2, …]::int4[]          -- one per shaping, OR-ed
```

on the row already being scanned: no join, no subquery, no `GROUP BY`. The GIN index answers containment for each array; a multi-word `text` term ANDs its per-word, boundary-padded arrays (`@> a AND @> b`). The field named in the filter selects which shapings apply when a declaration exists; without one every shaping is tried, which is the "match wherever it can" behaviour list boxes want.

**Recheck.** Containment proves every fragment is present, not that they are contiguous, so candidates can be false positives (a record whose name holds *Kowacz* and whose e-mail holds *walter@…* contains every padded trigram of the prefix term `kowal`). The engine already decrypts the rows it returns; the recheck is a substring test of the cleaned term against the cleaned values of the candidate rows:

- **Candidates ≤ `OM_SEARCH_RECHECK_MAX_ROWS`** (default `1000`): all are decrypted (`mapWithConcurrency`, `bounded-decrypt.ts:9-26`, concurrency 8 as elsewhere), false positives dropped, count exact.
- **Above it:** the page is decrypted and rechecked, over-fetched by 25% and re-fetched once if still short; the count is the candidate count and the response sets `totalIsApproximate: true` beside the existing `totalIsCapped`. A three-character term is one trigram, so containment is exact and no recheck runs.

**Route helper.** `findEntityIdsBySearchTrigrams(db, { entity, tenantId, organizationIds, term, fields? })` beside `findEntityIdsBySearchTokens` with the same scope semantics, so the six direct-route consumers switch by one import and keep their `id IN (…)` unions.

**Factories.** `buildDocumentCrudOptions` gains `searchFields?: string[]` (default `[numberColumn]`, so behaviour is unchanged until a module opts in); the CRUD factory gains the same option and, when set, turns `?search=` into the shaped predicate over those fields instead of leaving it to each route's `buildFilters`.

**No availability probe.** The token path needs one (`staticEnabled` + `hasTokens`, three specs' worth of tuning) because the table may be absent, empty, or partially rebuilt, and "no predicate" was the failure mode. Here the predicate is always emitted: a row either carries trigrams or has not been reindexed yet, and an unreindexed row is simply not found until the one-off reindex (§6) reaches it. That is a temporary state of an upgrade, not a steady-state condition worth a per-request check, and it is visible in `query_index status` as *rows missing trigrams* per entity. The presence probe, its partial index and the `search:*` availability debug events are removed with the token read path.

### 5. Write path and reindex

- `upsertIndexRow` (`indexer.ts:255-362`) computes `search_trgm` from the decrypted document (the `tokenDoc` the token writer used to consume) and writes it **with the row**, not deferred: it is one array, not thousands of rows, and read-your-writes for list search is worth more than the deferral bought for tokens. `reindexSearchTokensForRecord`, `deferSearchTokens` and the fire-and-forget token step of `upsert_one.ts` go away.
- `batch.ts:366-388` fills it in the same batch statement as `doc`; `writeSearchTokens` and `searchTokenFailures` go away.
- `search-tokens.ts` (the token writer, the count probe, the tally comparison, the delete-then-insert) is deleted, and with it the double-write and unbounded-growth machinery of the 2026-07-30 and 2026-08-24 specs, which no longer has anything to guard.
- `reindex` gains `--target search|all` (the flag the 2026-07-24 spec's B.1 proposes; `search` recomputes only `search_trgm` from the stored `doc`, decrypting as the token path does, and touches no token row — the WAL of a token rewrite is what forced `UNLOGGED` downstream). The `query_index.reindex` event payload carries the same `target`.
- **The migration fills the column itself.** It exports `queryIndexReindexEntityTypes = declareQueryIndexReindex('*', { target: 'search' })`, and `db migrate` queues one persistent `query_index.reindex` per entity type after the run commits (#5819). Two small extensions of that helper: `'*'` resolves at queue time to `SELECT DISTINCT entity_type FROM entity_indexes` (a static declaration cannot know which entities an install has rows for), and `target` passes through to the payload so the fill rewrites only `search_trgm`. `OM_MIGRATION_REINDEX=off` opts out as today and prints the manual `reindex --target search` command instead.
- Coverage: `entity_index_coverage` gets no new column; `query_index status` reports `count(*) FILTER (WHERE search_trgm IS NULL)` per entity as *rows missing trigrams* — a one-off scan an operator runs, not something the read path consults.

### 6. Rollout — one merge, one path

Everything in this spec ships in one pull request:

1. **Migration**: the column and the GIN index, instant on an existing table.
2. **Write path**: every index write fills `search_trgm`. New and updated rows are searchable from the first deploy.
3. **Read path**: the engines' token rewrite (`applySearchTokens`, both engines), the availability resolver and the direct-route token lookups are **replaced**, not wrapped: list search answers through trigrams only. `findEntityIdsBySearchTokens` stays as a `@deprecated` alias delegating to `findEntityIdsBySearchTrigrams`, so the six direct-route consumers compile unchanged. `TokenSearchStrategy` reads `search_trgm` with a containment ratio in place of its 50% token ratio, so global search's fallback keeps working and nothing reads `search_tokens` after the merge.
4. **Fill**: `db migrate` queues the trigram reindex for every entity type with projection rows (#5819, §5), off the deploy's critical path, non-fatal, one job per entity type. Until the job reaches a row, that row is not found by list search — the same class of temporary gap a coverage reindex has today; `query_index status` shows how many rows remain. A fresh install has nothing to fill. `UPGRADE_NOTES.md` states the gap and the manual command for installs that run with `OM_MIGRATION_REINDEX=off`.
5. **Tokens**: the same migration drops the table; the writer, the probe, the entity and the token-only configuration are deleted in the same PR. Nothing bridges, because after the merge nothing reads or writes tokens, and the helper and strategy that third parties could call keep their names.

Rollback is a revert plus the down migration, which recreates an empty `search_tokens`, followed by the old code's `reindex` to refill it. Until that completes, the old code's search on encrypted fields is blind — the same window a fresh token reindex has always had. No step in either direction takes the application down: the column is added and the table dropped without rewriting rows, and the fill runs queued.

## Alternatives considered

- **`pg_trgm` over plaintext cleaned values.** Same algorithm, simpler, and the right answer for an unencrypted install — but it stores plaintext beside ciphertext, needs an extension the app role may not be allowed to create, and forces a per-field "readable vs hashed" policy plus a privacy decision per deployment. The hashed form costs a recheck and gives one behaviour everywhere. Considered as a second lane and rejected: two columns, two indexes, a policy, for a count that is exact instead of near-exact on mid-size result sets.
- **Fix the token query shape only** (semi-join instead of the correlated `EXISTS`). Worth doing regardless and cheap, but a prefix hash still cannot answer substring, and the row count stays.
- **Store all substrings instead of prefixes.** Quadratic per value on a table already at 412M rows.
- **A separate `search_values` / `search_trigrams` table.** A third store; see §1.
- **Meilisearch for list search.** It is the global search's engine (2026-07-24 A.3), has no infix matching, indexes plaintext outside Postgres, and is a second pipeline to keep consistent — the exact reason B.3 keeps tokens.
- **Postgres `tsvector`.** Token-based like the tokens, no substring, and plaintext.

## Backward Compatibility

- **Schema**: one nullable column and one concurrent index added; the `search_tokens` table and its four indexes **dropped** — the one non-additive change, called out in `UPGRADE_NOTES.md` with the down-migration route back. No change to `entity_index_coverage` or any FROZEN surface (`SearchStrategyId`, event ids, queue names, DI keys).
- **Engines**: from the merge on, a `like`/`ilike` filter on a searchable field is answered by trigrams. Operator semantics change in two documented ways: `text` fields match by word prefix (today: prefix per word, order-independent — the same thing) and `identifier` fields match literally as a substring (today: per-word prefix, which over-matched). Rows not yet reached by the queued reindex are not found until it does; `UPGRADE_NOTES.md` says so.
- **Token consumers**: `findEntityIdsBySearchTokens` keeps its signature as a deprecated alias delegating to trigrams; `TokenSearchStrategy` keeps its id and shape. The `search:*` availability debug events disappear with the probe. Code that ran raw SQL against `search_tokens` breaks at the migration; OM never documented that as a way in.
- **Routes**: `findEntityIdsBySearchTokens` stays; the new helper is additive. `buildDocumentCrudOptions.searchFields` defaults to the current single column.
- **Responses**: `totalIsApproximate` is a new optional boolean; absent means exact, as today.
- **Env — removed** (token-only, dead after the merge; `resolveSearchConfig` stops reading them and `UPGRADE_NOTES.md` lists them): `OM_SEARCH_MIN_LEN` (a trigram is three characters; the minimum becomes a constant), `OM_SEARCH_ENABLE_PARTIAL`, `OM_SEARCH_HASH_ALGO`, `OM_SEARCH_STORE_RAW_TOKENS`, `OM_SEARCH_USE_ILIKE_FOR_NON_ENCRYPTED_FIELDS`, `OM_SEARCH_MAX_TOKENS_PER_FIELD`, `OM_SEARCH_MAX_TOKENS_PER_RECORD`, `OM_SEARCH_TOKEN_PRESENCE_CACHE_MS`.
- **Env — kept**: `OM_SEARCH_ENABLED` (kill switch: no trigram writes, no search predicate), `OM_SEARCH_FIELD_BLOCKLIST`, `OM_SEARCH_MAX_FIELD_CHARS` (still bounds trigrams per value), `OM_SEARCH_DEBUG`.
- **Env — new**: `OM_SEARCH_RECHECK_MAX_ROWS` (`1000`), `OM_SEARCH_PHONE_DEFAULT_REGION` (unset). All documented in both `.env.example` files and `packages/search/AGENTS.md` per the template-sync rule.
- **Dependency**: `libphonenumber-js/min` (~85 KB, MIT) in `@open-mercato/shared`, loaded lazily only when a region is configured. If maintainers prefer no dependency, phones fall back to the digit rules alone.

## Verification

- **Unit (`@open-mercato/shared`)**: cleaners per kind with the scenario inputs (`+48 600-100-200` / `0048600100200` / `600 100 200`; `PL 526-10-40-828` / `5261040828` / `DE123456789` / `NL123456789B01`; `Łódź` / `lodz`; `ZK 1/2026` vs `ZK 91/2026`); trigram sets; keyed hashing is tenant-dependent and pepper-dependent; term shaping by kind; the emitted `@>` SQL for a single word, a multi-word term and a delimited exact term.
- **Unit (`@open-mercato/core`)**: writer fills `search_trgm` from the decrypted doc on the single-record and batch paths; `--target search` touches no `search_tokens` row (count before/after); recheck drops a constructed false positive and keeps the count exact under the bound; over-fetch fills a page above the bound; a row with `search_trgm IS NULL` is not returned and is returned after `--target search`; `TokenSearchStrategy` returns the same records for whole-word terms from `search_trgm` as from `search_tokens`.
- **Integration (`.ai/qa/AGENTS.md`)**: a customers list search on an encrypted `email` field and a plaintext `name` field returns the same records before and after `reindex --target search` for whole-word terms, and additionally the prefix and substring matches after it; the sales orders `?search=` with `searchFields` declared finds an order by phone, tax id and a shipment tracking number; a two-character term is a 400.
- **Performance (downstream, reported back on the PR)**: p95 per term class on 1.4M orders — identifier, name, phone, broad (`202`) — with the target "first page under 500 ms for every class, count capped"; row and index size after `reindex --target search`.

## Follow-ups (not in this spec)

- The semi-join rewrite of `applySearchTokens` for installs that stay on tokens.
- A tenant-level "default region" setting is useful beyond search (formatting, validation); this spec only reads it.

## Open questions for maintainers

1. **Where the declaration lives** — on `Module` (proposed, beside `entityExtensions`) or on the per-module `search.ts` config (`SearchEntityConfig.fieldPolicy` vocabulary, today consumed by the external providers only). The former keeps list search independent of `@open-mercato/search`, which is not installed everywhere.
2. **`libphonenumber-js` in `shared`** — acceptable as a lazy optional dependency, or should the region-aware parse live in a provider package?
3. **32-bit vs 64-bit hashes** — proposed `int4`; `int8` doubles the footprint for a collision rate that the recheck already absorbs.

## Changelog

- 2026-09-10 — Initial RFC.
- 2026-09-10 — Implemented. Four deliberate departures from the RFC, each stated on the PR:
  1. **Where the declaration lives** (open question 1): on the existing per-module `search.ts`
     config, as `SearchFieldPolicy.kinds` / `kindsReplaceDefaults`, rather than a new
     `Module.searchFields` surface. The RFC's stated objection to `search.ts` was that it would
     couple list search to `@open-mercato/search`, which is not installed everywhere — but the
     registry that holds these configs (`getSearchModuleConfigs`) lives in `@open-mercato/shared`
     and is populated from `search.generated.ts` at bootstrap regardless, so the coupling does not
     exist. Choosing it avoids adding a fourth auto-discovery convention file.
  2. **`text` also emits an unpadded whole-value form.** §2 gives `text` word-padded forms only,
     which cannot answer a substring — so an entity that never declares its kinds, the drop-in
     default the spec relies on, would not get the literal matching that is half of goal 1.
     `text` therefore contributes one padded form per word *plus* the whole cleaned string
     unpadded, at roughly one extra trigram per character.
  3. **`OM_SEARCH_PHONE_DEFAULT_REGION` and `libphonenumber-js` are not shipped** (open question
     2). §2a's region-free half — substring on the full digit string, plus a bounded prefix-drop
     retry for a term longer than eight digits — is implemented and tested. The region-aware half
     waits on the maintainer's answer about the dependency; no dead knob was added.
  4. **`BasicQueryEngine` keeps exact SQL `ILIKE` on plaintext base columns.** That engine is the
     fallback for entities the query index does not cover, where no `entity_indexes` row exists to
     carry a trigram set, so routing everything through trigrams would make such an entity
     unsearchable. Encrypted columns always take the trigram path there, and
     `HybridQueryEngine` — the list path — is trigram-only as specified. This makes
     `OM_SEARCH_USE_ILIKE_FOR_NON_ENCRYPTED_FIELDS=true` the unconditional behaviour and removes
     the knob, as §Backward Compatibility asks.
