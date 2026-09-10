import { Migration } from '@mikro-orm/migrations';
import { declareQueryIndexReindex } from '@open-mercato/shared/lib/query/migration-reindex';

/**
 * List search moves from `search_tokens` (one row per prefix per field per record, unkeyed
 * SHA-256, answered by a correlated `EXISTS … GROUP BY … HAVING` per outer row) to a keyed
 * trigram hash set on the projection row itself.
 * See `.ai/specs/2026-09-10-trigram-hash-list-search.md`.
 *
 * Adding a nullable column and dropping a table are both instant — neither rewrites a row — so
 * this migration does not take the application down even on the 412M-row token tables the spec
 * quotes. The GIN index is built CONCURRENTLY because `entity_indexes` is the table every list
 * request reads; `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, hence
 * `isTransactional() => false` (the runner applies migrations one at a time, the same opt-out
 * `Migration20260731105052_query_index` takes). Drop first so retrying a failed concurrent build
 * removes PostgreSQL's invalid index stub instead of letting `IF NOT EXISTS` accept it.
 *
 * The declaration below is what fills the column: `mercato db migrate` queues one persistent
 * `query_index.reindex` per entity type once the whole run commits (#5819). `'*'` resolves at
 * queue time to the entity types that actually have projection rows — a static declaration cannot
 * know which entities an install carries — and `target: 'search'` makes the fill recompute only
 * `search_trgm` from the stored document, so it never rewrites `doc` and never touches a token
 * row. Until that job reaches a row, list search does not find it; `query_index status` reports
 * how many rows remain, and `OM_MIGRATION_REINDEX=off` opts out and prints the manual command.
 *
 * `down` recreates `search_tokens` EMPTY with its four indexes. A revert therefore needs the old
 * code's `reindex` to refill it before search on encrypted fields works again — the same window a
 * fresh token reindex has always had.
 */
export const queryIndexReindexEntityTypes = declareQueryIndexReindex(['*'], { target: 'search' });

export class Migration20260910120000_query_index_search_trigrams extends Migration {

  override isTransactional(): boolean {
    return false;
  }

  override up(): void | Promise<void> {
    this.addSql(`alter table "entity_indexes" add column if not exists "search_trgm" int4[] null;`);
    this.addSql(`drop index concurrently if exists "entity_indexes_search_trgm_idx";`);
    this.addSql(`create index concurrently "entity_indexes_search_trgm_idx" on "entity_indexes" using gin ("search_trgm");`);
    this.addSql(`drop table if exists "search_tokens";`);
  }

  override down(): void | Promise<void> {
    this.addSql(`create table if not exists "search_tokens" ("id" uuid not null default gen_random_uuid(), "entity_type" text not null, "entity_id" text not null, "organization_id" uuid null, "tenant_id" uuid null, "field" text not null, "token_hash" text not null, "token" text null, "created_at" timestamptz not null default now(), constraint "search_tokens_pkey" primary key ("id"));`);
    this.addSql(`create index if not exists "search_tokens_lookup_idx" on "search_tokens" ("entity_type", "field", "token_hash", "tenant_id", "organization_id");`);
    this.addSql(`create index if not exists "search_tokens_entity_idx" on "search_tokens" ("entity_type", "entity_id");`);
    this.addSql(`create index if not exists "search_tokens_tenant_token_hash_idx" on "search_tokens" ("tenant_id", "token_hash");`);
    this.addSql(`create index if not exists "search_tokens_presence_idx" on "search_tokens" ("entity_type", "tenant_id", "organization_id");`);
    this.addSql(`drop index concurrently if exists "entity_indexes_search_trgm_idx";`);
    this.addSql(`alter table "entity_indexes" drop column if exists "search_trgm";`);
  }

}
