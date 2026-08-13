import { Migration } from '@mikro-orm/migrations';

export class Migration20260813120000 extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "sync_external_id_mappings" add "source_read_at" timestamptz null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "sync_external_id_mappings" drop column "source_read_at";`);
  }

}
