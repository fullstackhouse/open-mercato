import { Migration } from '@mikro-orm/migrations';

export class Migration20260831120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table "sync_runs" add column "cursor_origin" text null;`);
    this.addSql(`alter table "sync_runs" add column "cursor_source_run_id" uuid null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "sync_runs" drop column "cursor_source_run_id";`);
    this.addSql(`alter table "sync_runs" drop column "cursor_origin";`);
  }

}
