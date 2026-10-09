import { Migration } from '@mikro-orm/migrations';

export class Migration20261008074840_sales extends Migration {

  override name = 'Migration20261008074840';

  override up(): void | Promise<void> {
    this.addSql(`alter table "sales_orders" alter column "exchange_rate" type numeric using ("exchange_rate"::numeric);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "sales_orders" alter column "exchange_rate" type numeric(18,8) using ("exchange_rate"::numeric(18,8));`);
  }

}
