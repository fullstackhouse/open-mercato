import { Migration } from '@mikro-orm/migrations';

export class Migration20260716114207_notifications extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "notification_types" add "channels" jsonb null;`);
    this.addSql(`alter table "notification_types" alter column "non_opt_out" drop default;`);
    this.addSql(`alter table "notification_types" alter column "non_opt_out" drop not null;`);
    // non_opt_out was previously a pure mirror of the code-declared flag; it is now an
    // operator-owned override (NULL = inherit the code declaration). Reset the mirrored
    // values so no pre-existing row masquerades as an operator edit.
    this.addSql(`update "notification_types" set "non_opt_out" = null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "notification_types" drop column "channels";`);
    this.addSql(`alter table "notification_types" alter column "non_opt_out" set default false;`);
    this.addSql(`alter table "notification_types" alter column "non_opt_out" set not null;`);
  }

}
