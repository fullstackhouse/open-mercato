# Sales Line Discounts — Stable Semantics, Visibility, and Editing

- **Status:** Draft (2026-08-04) — spec only, no implementation in this change
- **Scope:** OSS (`packages/core/src/modules/sales`)
- **Origin:** Defect report #1 of 3 raised while integrating Subiekt GT (ERP) into an Open Mercato deployment at production scale (1.42M orders, 4.14M order lines). Items #2 (`line_number` sort default) and #3 (line `description` in the admin items table) ship as standalone PRs; this one needs a spec because it carries a calculation-semantics decision.
- **Risk:** `risk-medium` (changes document math for lines that carry a discount; UI-only for every other line) · **Priority:** `priority-medium`
- **Category:** `bug` + `feature` (a data-integrity fix followed by additive UI)
- **Related:** [`SPEC-055`](SPEC-055-2026-02-23-promotions-module.md) (Promotions module — future owner of promotion-driven discounts), [`SPEC-058`](implemented/SPEC-058-2026-03-09-order-returns-adjustments.md) (returns / line-level adjustments)

## TLDR

Line-level discounts exist in the data model, in the validators, in the list API projection, and in the totals block — but they are **invisible in the admin items table, not editable anywhere in the UI, and not idempotent under recalculation**. An operator sees `Discounts −18.45` in the totals with no way to attribute it to a line; an ERP importer that sets a line discount watches it silently double on the next line edit.

This spec (1) pins down one canonical discount contract for sales lines and fixes two verified calculation defects, (2) adds a self-hiding **Discount** column plus a struck-through pre-discount total to the items table, and (3) makes the discount editable in `LineItemDialog` as a single percent-or-amount control. **No schema change and no new column** — every field involved already exists.

## Problem Statement

### What already exists

| Layer | State |
|---|---|
| Entities | `discount_amount numeric(18,4) default '0'`, `discount_percent numeric(7,4) default '0'` on order lines (`data/entities.ts:634-638`), quote lines (`:1071-1075`) and invoice lines (`:1521-1525`) |
| Validators | `discountAmount: decimal({ min: 0 }).optional()`, `discountPercent: percentage().optional()` (`data/validators.ts:342-343`) |
| List API | both columns projected — already in the payload `ItemsSection` receives (`lib/makeSalesLineRoute.ts:186-187`) |
| Calculation | line discount folded into net subtotal and into the document `discountTotalAmount` (`lib/calculations.ts:88-96`, `:120`, `:153`) |
| Totals UI | a `Discounts` row on the document detail page (`backend/sales/documents/[id]/page.tsx:2836-2838`) |
| Public quote | a `discount` row in the customer-facing totals (`frontend/quote/[token]/page.tsx:202-204`) |

### What is missing or wrong

**1. Not visible.** The admin items table is a fixed 5-column layout — Product | Status | Qty | Unit price | Total (`components/documents/ItemsSection.tsx:636-661`) — and `ItemsSection`'s row mapper never reads `discount_amount` / `discount_percent` at all (`:251-282`), so the fields are dropped before render. `SalesLineRecord` has no discount member (`components/documents/lineItemTypes.ts:3-25`).

**2. Not enterable.** `LineItemDialog`'s `LineFormState` (`:156-172`) has no discount member and its submit payload (`:1468-1500`) never sends one. A discount can therefore only arrive through the API or an import, and once there it is permanently unattributable — `Discounts −18.45` gives the operator no way to tell whether that was one big discount or three small ones, short of querying the database.

**3. Rows look like arithmetic errors.** When the source system stores the line total already net of discount but the unit price *before* it — a common ERP shape — the row shows `qty × unit price ≠ total` with nothing explaining the gap.

**4. The absolute-amount semantics are inconsistent between input and storage, so recalculation is not idempotent.** *Verified by executing the calculation logic:*

- `buildBaseLineResult` treats `line.discountAmount` as **per unit**: `discountTotal = clamp(discountPerUnit × quantity)` (`lib/calculations.ts:88-96`).
- The persisted column receives the **line total**: `discountAmount: toNumericString(lineResult.discountAmount)` (`commands/documents.ts:3052`).
- Reloading a line feeds that stored total straight back in as if it were per-unit (`commands/documents.ts:2834`, `:2865`), and **every line upsert recalculates all lines of the document** from those snapshots (`:6866-6890`).

Observed sequence for a line of qty 3 @ 10.00 net with a 5.00 discount:

| Recalculation | line net | line discount | document `discountTotalAmount` |
|---|---:|---:|---:|
| initial write | 15.00 | 15.00 | 15.00 |
| after any later line edit | **0.00** | **30.00** | **30.00** |

The line's net collapses to zero (clamped), its gross stays at the persisted 15.00, and the document's discount total doubles. Editing an unrelated line is enough to trigger it.

**5. `discountPercent` is silently dead on every path that starts from a persisted row.** The precedence is `line.discountAmount ?? (percent ? … : 0)` (`lib/calculations.ts:88-92`), but `discount_amount` is a `NOT NULL DEFAULT '0'` column, so a reloaded snapshot always supplies the *number* `0` — and `0 ?? x` is `0`. Verified: 10% off 2 × 100.00 yields a 20.00 discount when `discountAmount` is `null`, and **0.00** when it is `0`. The same holds for the line-upsert path, which coalesces the field to `0` when the request omits it (`commands/documents.ts:6834-6835`). Net effect: a percent-only line (the normal shape for an ERP import) loses its discount as soon as anything recalculates the document.

### Consequence at scale

An importer doing delete-and-reinsert upserts against 4.14M order lines has no way to see what it wrote, and the values it writes drift on unrelated operator edits. Defects 4 and 5 are the reason this cannot be a UI-only change: exposing an editable field on top of non-idempotent math would let operators produce wrong invoices faster.

## Goals / Non-Goals

**Goals**
- One documented, idempotent contract for what `discount_percent` and `discount_amount` mean on a sales line, with the precedence between them stated and tested.
- Line discounts visible in the admin items table, self-hiding when no line of the document carries one.
- Line discounts editable in `LineItemDialog` for orders and quotes, with the recalculation interaction spelled out.
- A stated relationship between an operator-entered discount and a promotion-driven one (`promotion_code` / `promotion_snapshot`).
- No database migration; no new contract-surface field beyond one additive, defaulted request field.

**Non-Goals**
- Line-scoped adjustments (`scope: 'line'` is still explicitly rejected — `commands/documents.ts:2991-2995`); order-level discounts continue to flow through adjustments.
- Implementing the Promotions module (SPEC-055) or authoring `promotion_snapshot` anywhere in core.
- Discounts in order-confirmation / quote emails and in any PDF or print surface.
- Registering `ItemsSection` behind `useRegisteredComponent` (a separate observation from the same report).
- Documenting the `catalog_snapshot` shape contract (same report, separate item).
- `discount_strategy_key` on orders (`data/entities.ts:401`, `data/validators.ts:670`) — stored, no reader; left inert.

## Proposed Solution

### 1. The canonical contract

> **A sales line carries at most one discount.** It is expressed **either** as a percentage of the line's net subtotal **or** as an absolute amount off the whole line — never both.

| Field | Role after this spec | Notes |
|---|---|---|
| `discount_percent` | **Input.** Percent of the line's net subtotal (`unit_price_net × quantity`). Idempotent by construction: it re-derives correctly after quantity or price changes. | Preferred representation. |
| `discount_amount` | **Resolved line-total discount.** Always the whole-line figure, in the line's currency — the value the totals block sums. Also accepted as *input* when `discount_percent` is `0`/absent. | Column meaning is unchanged from what is stored today. |

**Precedence (new, replaces `amount ?? percent`):**

1. `discount_percent > 0` → percent governs; `discount_amount` is **derived** (`percent/100 × unit_price_net × quantity`) and overwritten on every recalculation.
2. otherwise `discount_amount > 0` → that amount governs as a **line-total** discount and is preserved verbatim across recalculations.
3. otherwise no discount.

This ordering is what makes the round trip stable: the stored amount is an *output* whenever a percent is present, so it must never be allowed to outrank the percent that produced it. Legacy rows where both are non-zero resolve to the percent — the intent of any importer that sets a percent.

Clamping is unchanged: the resolved discount is bounded to `[0, unit_price_net × quantity]`.

**Request-time basis for absolute amounts.** Today's API semantics for the `discountAmount` request field are per-unit (undocumented, code-only). Rather than silently reinterpret it for existing callers, add one field to the line create/update schema, optional on the wire and defaulted in the schema itself so the generated OpenAPI advertises the fallback:

```ts
// data/validators.ts — linePricingSchema (additive)
discountAmountBasis: z.enum(['unit', 'line']).default('unit'),
```

`.default(...)` rather than `.optional()` is deliberate: the field stays omittable for callers, and every downstream consumer reads a defined value, so no code path has to re-apply the fallback during request→snapshot mapping. `z.infer` therefore types the parsed field as `'unit' | 'line'`, not `… | undefined`.

- `'unit'` (default) — today's behavior: the submitted amount is multiplied by quantity. Existing API clients and the Subiekt GT importer are unaffected.
- `'line'` — the submitted amount **is** the line-total discount. The admin UI always sends `'line'`.

The basis is a request-time concept only; nothing persists it. Recalculation from persisted rows always uses the line-total reading, which is exactly what the column holds. That is the whole fix for defect 4.

### 2. Calculation changes (`lib/calculations.ts`, `commands/documents.ts`)

- `SalesLineSnapshot` gains `discountAmountBasis?: 'unit' | 'line' | null`, optional here because the type is also constructed by third-party calculators; an absent value reads as `'unit'` inside `buildBaseLineResult`. Snapshots built from entities (`mapOrderLineEntityToSnapshot`, `mapQuoteLineEntityToSnapshot`) set `'line'`; snapshots built from request input carry the schema-defaulted value straight through.
- `buildBaseLineResult` resolves the discount by the precedence above instead of `discountAmount ?? percent`, treating a `0` amount as "no absolute discount" rather than as an explicit zero.
- `convertLineCalculationToEntityInput` keeps writing the resolved line total to `discount_amount` and now also writes back the **resolved** `discount_percent` unchanged (`commands/documents.ts:3052-3053` stays semantically as-is).
- The line-upsert merge (`commands/documents.ts:6834-6837`) stops coalescing an omitted `discountAmount` to `0` — it must fall through to the existing snapshot and then to *absent*, so an omitted amount cannot mask a percent.
- Invoice lines copied from order lines (`commands/documents.ts:2006-2007`) inherit the resolved line total, which is consistent under the new contract; no change needed there.
- `sales.line.calculate.*` / `sales.document.calculate.*` hook contracts are unchanged; third-party line calculators keep receiving the same result shape.

### 3. Items table — read-only visibility (`components/documents/ItemsSection.tsx`)

- **Row mapping**: carry `discountPercent`, `discountAmount` (resolved line total), `promotionCode` and `promotionSnapshot` onto `SalesLineRecord` (`lineItemTypes.ts`).
- **New column `Discount`**, inserted **between Unit price and Total**. Injected widget columns keep appending after Total, so their order is unaffected.
- **Self-hiding**: the column renders only when at least one line of the document has `discountPercent > 0 || discountAmount > 0`. The common no-discount document grows no column of dashes.
- **Cell content**: the negative line-total amount as the primary value (e.g. `−18.45`), with a muted sub-line carrying `10%` when percent-driven, or the promotion code when `promotionCode` / `promotionSnapshot` is present. Empty for lines with no discount.
- **Total cell**: when the line carries a discount, show the pre-discount gross struck through above the discounted total (`ItemsSection.tsx:794-813`). This is what makes `qty × unit price ≠ total` self-explanatory on the row.
- **Rejected alternative**: a muted sub-line under Unit price. It reads as though the *unit price* were discounted, which is wrong — the unit price is the entered/catalog price and stays untouched — and it hides the figure from anyone scanning the money columns.

### 4. `LineItemDialog` — editing

- `LineFormState` gains `discountMode: 'percent' | 'amount'` and `discountValue: string`.
- One **Discount** field placed directly after Unit price, rendered with the same input-plus-select composition already used for the gross/net price mode (`LineItemDialog.tsx:2071-2184`): a numeric input plus a select for `%` / the document currency. Switching mode clears the value, so percent and amount can never disagree — the mutual exclusion of the data contract is enforced at the only place that authors both.
- Submit maps to exactly one field: percent mode → `{ discountPercent: v, discountAmount: 0 }`; amount mode → `{ discountPercent: 0, discountAmount: v, discountAmountBasis: 'line' }`.
- **The dialog's client-side totals must become discount-aware.** It currently posts `totalNetAmount`/`totalGrossAmount` as plain `unitPrice × qty` (`LineItemDialog.tsx:1438-1439`), and the calculation engine treats a supplied gross as authoritative (`lib/calculations.ts:101-104`). Left as-is, a discount would be visible in the net but silently ignored in the gross. The dialog subtracts the resolved discount from both figures before posting.
- Edit prefill reads the persisted values back: a non-zero `discountPercent` opens in percent mode, otherwise a non-zero `discountAmount` opens in amount mode.
- Validation: percent in `[0, 100]`, amount in `[0, unit_price_net × quantity]`; over-range values surface through `createCrudFormError` with a field-scoped message.
- **Promotion-managed lines are read-only**: when a line carries `promotion_snapshot`, the control is disabled with a muted "managed by promotion `{code}`" hint. Core never authors `promotion_code` / `promotion_snapshot` (it clones them verbatim) and must not let a manual edit clobber what a future Promotions engine wrote. Per SPEC-055 the promotions engine owns all discount math and hands over resolved amounts, so a promotion-driven line discount lands in the same two fields — hence one discount per line, whoever authored it. Order-level stacking continues to happen through adjustments.
- Optimistic locking is unchanged: the dialog already wraps the write in the document's lock header (`LineItemDialog.tsx:1512-1525`).

### 5. Deferred: source-total deviation hint

For imported lines that carry **no** recorded discount but whose persisted total still deviates from `qty × unit_price_net` by more than a rounding tolerance, show a muted info affordance on the Total cell explaining that the total was supplied by the source system. Useful for exactly the ERP shape in the report, but it is a heuristic and can be noisy — kept as its own phase so phases 1–3 can ship without it, and droppable without touching them.

## Data Models

No migration. No new column. No entity change.

Additive type/schema changes only:

| Surface | Change | Classification |
|---|---|---|
| `data/validators.ts` → `linePricingSchema` | `+ discountAmountBasis: z.enum(['unit','line']).default('unit')` — omittable on the wire, always defined after parse | ADDITIVE |
| `lib/types.ts` → `SalesLineSnapshot` | `+ discountAmountBasis?: 'unit' \| 'line' \| null` | ADDITIVE |
| `components/documents/lineItemTypes.ts` → `SalesLineRecord` | `+ discountPercent`, `discountAmount`, `promotionCode`, `promotionSnapshot` | ADDITIVE (UI-internal type) |
| `lib/calculations.ts` → discount resolution | precedence and basis change | **BEHAVIOR CHANGE** — see Risks |

## API Contracts

`POST` / `PUT /api/sales/order-lines` and `/api/sales/quote-lines` (`lib/makeSalesLineRoute.ts`):

Percent-driven (preferred — re-derives correctly after quantity or price changes):

```jsonc
{
  "orderId": "…",
  "quantity": 3,
  "unitPriceNet": 10.0,
  "taxRate": 23,
  "discountPercent": 10,
  "discountAmount": 0
}
```

Amount-driven, whole line:

```jsonc
{
  "orderId": "…",
  "quantity": 3,
  "unitPriceNet": 10.0,
  "taxRate": 23,
  "discountPercent": 0,
  "discountAmount": 15.0,
  "discountAmountBasis": "line"   // omit ⇒ "unit": 15.0 is read per unit (legacy behavior)
}
```

Responses are unchanged in shape: `discount_amount` and `discount_percent` are already projected by the list route (`:186-187`) and already typed in the OpenAPI line schema (`:305-306`). `discount_amount` continues to mean the resolved line-total discount — the same reading integrations get today — it simply stops drifting. The OpenAPI request schema picks up `discountAmountBasis` automatically from the validator, including its `'unit'` default, so the fallback is documented rather than implied.

## Phasing

| Phase | Content | Independently shippable |
|---|---|---|
| **1 — semantics** | Precedence + basis fix in `lib/calculations.ts` and the two upsert paths in `commands/documents.ts`; `discountAmountBasis` in validators and `SalesLineSnapshot`; unit tests below. No UI change. | yes |
| **2 — visibility** | `SalesLineRecord` fields, self-hiding Discount column, struck-through pre-discount total, promotion sub-line, i18n. | yes (after 1) |
| **3 — editing** | `LineItemDialog` discount control, discount-aware client totals, prefill, validation, promotion read-only state. | yes (after 2) |
| **4 — optional** | Source-total deviation hint (§5). | yes, droppable |

Phase 1 must land before 2 and 3: shipping an editable field on non-idempotent math would let operators produce wrong invoices faster than the API already can.

## Testing

### Unit (`yarn test`)

`packages/core/src/modules/sales/lib/__tests__/calculations.test.ts`:
- percent governs when both percent and a non-zero amount are present;
- a `0` amount does **not** suppress a percent (defect 5 regression);
- amount governs, as a line total, when percent is `0`;
- `basis: 'unit'` still multiplies by quantity (legacy contract intact);
- **idempotency**: feeding a result's `discountAmount` back in with `basis: 'line'` reproduces the same line net, discount and document `discountTotalAmount` across three consecutive recalculations (defect 4 regression);
- clamping at `unit_price_net × quantity`, including quantity `0`;
- percent-driven discount re-derives after a quantity change.

`packages/core/src/modules/sales/commands/__tests__/` — a line-upsert round trip proving that editing line B does not alter line A's discount, and that omitting `discountAmount` on an update does not erase an existing percent.

### Integration (Playwright, `packages/core/src/modules/sales/__integration__/`)

Self-contained per `.ai/qa/AGENTS.md` — each test creates its own channel/customer/order fixtures via API and cleans up in `finally`.

| Test | Covers |
|---|---|
| `TC-SALES-040-line-discount-api-semantics.spec.ts` | `POST /api/sales/order-lines` with `discountPercent`; `PUT` a second line; re-`GET` and assert the first line's `discount_amount` and the order's `discountTotalAmount` are unchanged. Same for `discountAmount` + `discountAmountBasis: 'line'`, and for the legacy `'unit'` default. |
| `TC-SALES-041-line-discount-items-table.spec.ts` | `/backend/sales/documents/[id]` — Discount column absent on a discount-free order; present with the amount, the `10%` sub-line and a struck-through pre-discount total once a line carries a discount. |
| `TC-SALES-042-line-discount-dialog.spec.ts` | Edit a line through `LineItemDialog`: enter a percent, save, assert the row, the column and the totals `Discounts` row; switch the same line to a fixed amount; assert an over-range value is rejected with a field error. |
| `TC-SALES-043-line-discount-quote-lines.spec.ts` | The same read + write path on a quote, plus the customer-facing `/quote/[token]` discount total. |

Optional markdown scenarios under `.ai/qa/scenarios/TC-SALES-04{0..3}-*.md` (not required by the QA guide).

### Manual QA

Screenshots of: a discount-free order (no extra column), a mixed order (some lines discounted), the dialog in percent mode and in amount mode, and a promotion-managed line showing the disabled control.

## Risks & Impact Review

| # | Failure scenario | Severity | Area | Mitigation | Residual |
|---|---|---|---|---|---|
| 1 | A tenant whose lines carry a non-zero `discount_percent` **and** a non-zero `discount_amount` sees totals move on the next recalculation, because percent now outranks amount. | medium | sales totals | This is the intended correction — the stored amount is percent-derived in every core write path. Called out in UPGRADE_NOTES; unit tests pin the resolution. Nothing is rewritten in place: totals change only when a document is next recalculated. | Deliberate one-time correction for affected documents. |
| 2 | An external client that sends a per-unit `discountAmount` is silently reinterpreted as a line total. | high if it happened | API contract | It does not: `discountAmountBasis` defaults to `'unit'`, preserving today's reading for every existing caller. Only the admin UI opts into `'line'`. | none |
| 3 | An integration reads `discount_amount` from the list API expecting the drifted value. | low | integrations | The column's meaning (resolved line total) is unchanged; only the drift stops. Documented in the spec's changelog and UPGRADE_NOTES. | Reports that reconciled against inflated totals will shift toward correctness. |
| 4 | The dialog's discount-aware client totals disagree with the server calculation (rounding, tax-class-priced lines). | medium | line writes | Client sends discount-aware net **and** gross; server remains authoritative and recomputes the net. Round-tripping is covered by TC-SALES-042. Interaction with the gross/net tax-derivation branch (`lib/calculations.ts:110-113`, #2457) gets an explicit unit test. | Sub-cent rounding differences on exotic tax rates. |
| 5 | A future Promotions engine and an operator both write the same line's discount. | medium | promotions | One discount per line, promotion-managed lines read-only in the dialog, `promotion_code` / `promotion_snapshot` still pass-through and never authored by core. | Needs re-confirmation when SPEC-055 is implemented. |
| 6 | The new column shifts the items table layout for injected widget columns. | low | widget contract | Discount is inserted **before** Total; injected columns keep appending after it (`ItemsSection.tsx:814-829`). No spot ID, accessor or ordering contract changes. | none |
| 7 | Missing translations in `de` / `es` / `pl` leave English strings in a localized admin. | low | i18n | New keys added to all four locale files under `sales.documents.items.*`; verified with `yarn i18n:check-values`. | none |

**Backward compatibility.** No FROZEN or STABLE surface is removed or renamed. Added: one optional defaulted request field, one optional snapshot field, four UI-internal record fields. Changed: the discount resolution rule inside the calculation engine — a bug fix to non-idempotent math, to be listed in `UPGRADE_NOTES.md` with the before/after table from the Problem Statement. No deprecation bridge is needed because nothing is being removed.

**Performance.** Both discount columns are already in the list projection, so the items table gains no query and no extra round trip. The calculation change is arithmetic-only. At the reporter's scale (4.14M lines) the relevant win is that recalculations stop mutating discount values, which removes a class of write amplification on re-sync.

## Open Questions

1. **Legacy rows with both values non-zero** — resolve to percent silently (proposed), or ship a `mercato` CLI report so operators can inspect affected documents before they are next recalculated? The proposal assumes silent, since core never authors that combination.
2. **Struck-through pre-discount total** — gross only (proposed) or both gross and net? Both doubles the strike-through noise in a two-line cell.
3. **Phase 4** — is the deviation hint wanted at all, or should an importer be expected to write an explicit `discountAmount` so the row explains itself through the normal column?

## Final Compliance Report

*To be completed at implementation time.* Gate: `yarn generate` (not expected to change output — no discovered-file change), `yarn build:packages`, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn build:app`, plus `yarn test:integration` for the four specs above and `yarn i18n:check-values`.

Checklist for the implementing change:
- [ ] No hardcoded user-facing strings; all new copy in `i18n/{en,de,es,pl}.json`
- [ ] No hardcoded status colors or arbitrary Tailwind values in the new column (DS tokens only)
- [ ] `apiCall`-family helpers only; no raw `fetch`
- [ ] Optimistic locking unchanged (document-scoped header already sent by the dialog)
- [ ] No new cross-module import and no ORM relationship added
- [ ] `BACKWARD_COMPATIBILITY.md` reviewed — behavior change documented in `UPGRADE_NOTES.md`
- [ ] Integration coverage for every touched API path and the two touched UI paths

## Changelog

- **2026-08-04** — Initial draft. Documented the four existing layers of discount support and the five gaps; verified defects 4 (per-unit input vs line-total storage ⇒ non-idempotent recalculation) and 5 (`discountPercent` suppressed by a `0` `discount_amount`) by executing the calculation logic; proposed the percent-first precedence, the additive `discountAmountBasis` request field, the self-hiding Discount column, and the percent-or-amount dialog control. No implementation.
- **2026-08-04** — Review follow-up: `discountAmountBasis` now carries its `'unit'` fallback via `z.enum(...).default('unit')` (was `.optional()` with the default described only in prose, which would not have reached the generated OpenAPI); split the single request example into separate percent-driven and amount-driven objects instead of repeating keys in one invalid JSONC block.
