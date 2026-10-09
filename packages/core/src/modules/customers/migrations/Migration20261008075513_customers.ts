import { Migration } from '@mikro-orm/migrations';

export class Migration20261008075513_customers extends Migration {

  override name = 'Migration20261008075513';

  override up(): void | Promise<void> {
    this.addSql(`alter table "customer_deals" alter column "value_amount" type numeric using ("value_amount"::numeric);`);

    this.addSql(`alter table "customer_companies" alter column "annual_revenue" type numeric using ("annual_revenue"::numeric);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "customer_companies" alter column "annual_revenue" type numeric(16,2) using ("annual_revenue"::numeric(16,2));`);

    this.addSql(`alter table "customer_deals" alter column "value_amount" type numeric(14,2) using ("value_amount"::numeric(14,2));`);
  }

}
