import { Migration } from '@mikro-orm/migrations';

export class Migration20260716111124_notifications extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "notification_types" add "channels" jsonb null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "notification_types" drop column "channels";`);
  }

}
