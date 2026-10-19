import { Migration } from '@mikro-orm/migrations';

// Seven foreign keys on the delete path of an order or a quote had no index whose
// leading column is the referencing column:
//
//   sales_shipment_items.order_line_id            -> sales_order_lines
//   sales_order_adjustments.order_line_id         -> sales_order_lines
//   sales_invoice_lines.order_line_id             -> sales_order_lines
//   sales_credit_memo_lines.order_line_id         -> sales_order_lines
//   sales_document_tag_assignments.order_id       -> sales_orders
//   sales_document_tag_assignments.quote_id       -> sales_quotes
//   sales_quote_adjustments.quote_line_id         -> sales_quote_lines
//
// PostgreSQL does not index the child side of a constraint, and on every deleted
// parent row the constraint trigger looks the child table up by that column. The
// existing indexes do not serve the lookup: each table's scope index leads with
// its own parent (shipment_id, order_id, invoice_id, credit_memo_id, quote_id),
// and the tag assignment's document_idx is on document_id. sales.orders.delete
// and sales.quotes.delete (commands/documents.ts) remove the children they own
// first, by those parents, and then the lines and the document — so every
// deleted line and every deleted document still pays a sequential scan of each
// child table, including the ones whose rows that command has just removed.
//
// Reproduced on a synthetic dataset — one organization, 300,000 orders with three
// shipped lines and two tags each (900,000 shipment items, 600,000 tag
// assignments): deleting one order's lines took 90.6 ms and the order row 17.5 ms,
// almost all of it in the constraint triggers; with the indexes, 0.23 ms and
// 0.19 ms. The full delete sequence for 200 orders went from 20.5 s to 31 ms. The
// cost grows with the child tables, not with the order being deleted, and an order
// with many lines multiplies it by its line count.
//
// The scope columns are deliberately omitted, for the reason given in
// Migration20260821120000: a parent id is gen_random_uuid() from its own table,
// so it already determines its tenant and organization. invoice_lines,
// credit_memo_lines and the quote-side pair are usually small, and are indexed
// here because the same delete probes them; leaving them out would make the cost
// reappear as soon as a deployment uses invoices, credit memos or quotes.
//
// Built CONCURRENTLY — shipment items and tag assignments take a write per
// document save and are large on any install that has been running a while.
// CREATE INDEX CONCURRENTLY cannot run inside a transaction, hence
// isTransactional() => false; the runner applies migrations one-by-one, so the
// opt-out is safe. Drop first so retrying a failed concurrent build removes
// PostgreSQL's INVALID index stub instead of letting IF NOT EXISTS report success
// over a table that stays unindexed. Same shape as Migration20260806120000,
// Migration20260821120000 and Migration20260916120000.
//
// On a database that does not have these indexes yet — every fresh install — the
// drops are no-ops and there is no window without them. An operator who already
// created one out of band should expect it to be rebuilt here.
export class Migration20261019120000_sales_document_delete_fk_idx extends Migration {

  override isTransactional(): boolean {
    return false;
  }

  override up(): void | Promise<void> {
    this.addSql(`drop index concurrently if exists "sales_shipment_items_order_line_idx";`);
    this.addSql(`create index concurrently "sales_shipment_items_order_line_idx" on "sales_shipment_items" ("order_line_id");`);
    this.addSql(`drop index concurrently if exists "sales_order_adjustments_order_line_idx";`);
    this.addSql(`create index concurrently "sales_order_adjustments_order_line_idx" on "sales_order_adjustments" ("order_line_id");`);
    this.addSql(`drop index concurrently if exists "sales_invoice_lines_order_line_idx";`);
    this.addSql(`create index concurrently "sales_invoice_lines_order_line_idx" on "sales_invoice_lines" ("order_line_id");`);
    this.addSql(`drop index concurrently if exists "sales_credit_memo_lines_order_line_idx";`);
    this.addSql(`create index concurrently "sales_credit_memo_lines_order_line_idx" on "sales_credit_memo_lines" ("order_line_id");`);
    this.addSql(`drop index concurrently if exists "sales_document_tag_assignments_order_idx";`);
    this.addSql(`create index concurrently "sales_document_tag_assignments_order_idx" on "sales_document_tag_assignments" ("order_id");`);
    this.addSql(`drop index concurrently if exists "sales_document_tag_assignments_quote_idx";`);
    this.addSql(`create index concurrently "sales_document_tag_assignments_quote_idx" on "sales_document_tag_assignments" ("quote_id");`);
    this.addSql(`drop index concurrently if exists "sales_quote_adjustments_quote_line_idx";`);
    this.addSql(`create index concurrently "sales_quote_adjustments_quote_line_idx" on "sales_quote_adjustments" ("quote_line_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index concurrently if exists "sales_quote_adjustments_quote_line_idx";`);
    this.addSql(`drop index concurrently if exists "sales_document_tag_assignments_quote_idx";`);
    this.addSql(`drop index concurrently if exists "sales_document_tag_assignments_order_idx";`);
    this.addSql(`drop index concurrently if exists "sales_credit_memo_lines_order_line_idx";`);
    this.addSql(`drop index concurrently if exists "sales_invoice_lines_order_line_idx";`);
    this.addSql(`drop index concurrently if exists "sales_order_adjustments_order_line_idx";`);
    this.addSql(`drop index concurrently if exists "sales_shipment_items_order_line_idx";`);
  }

}
