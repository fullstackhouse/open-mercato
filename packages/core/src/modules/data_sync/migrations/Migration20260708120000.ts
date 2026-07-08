import { Migration } from '@mikro-orm/migrations';

export class Migration20260708120000 extends Migration {

  override async up(): Promise<void> {
    // First-class sync `mode` (e.g. 'backfill' | 'feed'), defaulting to 'backfill'
    // so existing rows and single-mode adapters are unaffected.
    this.addSql(`alter table "sync_runs" add column if not exists "mode" text not null default 'backfill';`);
    this.addSql(`alter table "sync_cursors" add column if not exists "mode" text not null default 'backfill';`);
    this.addSql(`alter table "sync_schedules" add column if not exists "mode" text not null default 'backfill';`);

    // Re-key the sync_cursors uniqueness to include `mode`, so one entity can hold
    // independent cursors per mode (e.g. a backfill keyset cursor and a feed watermark).
    this.addSql(`drop index if exists "sync_cursors_integration_id_entity_type_direction__b4d87_index";`);
    this.addSql(`create unique index if not exists "sync_cursors_scope_mode_uq" on "sync_cursors" ("integration_id", "entity_type", "direction", "mode", "organization_id", "tenant_id");`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "sync_cursors_scope_mode_uq";`);
    this.addSql(`create unique index if not exists "sync_cursors_integration_id_entity_type_direction__b4d87_index" on "sync_cursors" ("integration_id", "entity_type", "direction", "organization_id", "tenant_id");`);
    this.addSql(`alter table "sync_schedules" drop column "mode";`);
    this.addSql(`alter table "sync_cursors" drop column "mode";`);
    this.addSql(`alter table "sync_runs" drop column "mode";`);
  }

}
