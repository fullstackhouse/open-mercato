# Arbitrary-Precision Money and FX Rates

## TLDR

Make every money and FX column an unconstrained Postgres `numeric`. Move all money math from JS floats to exact decimal arithmetic (`big.js` through `@open-mercato/shared/lib/decimal`), and add free-form `metadata` to exchange rates.

- Add, subtract and multiply are exact.
- Division is the only operation that is cut. Money amounts round to the currency precision, `max(4, currency.decimalPlaces)`. FX math rounds to 50 decimals.
- Division never keeps fewer than 17 significant digits, so it is never less precise than a JS `number`.

Public TypeScript contracts and API payloads that expose amounts as `number` keep those fields, now deprecated and derived from the exact value. Each gets a sibling `<field>Exact: string` that carries the exact value.

**Scope:**
- **Columns:** exchange rates (`exchange_rates.rate`, `sales_orders.exchange_rate`) and about 100 money columns in sales, catalog, checkout, customers, customer_groups, payment_gateways, staff and warranty_claims.
- **Math:** the sales calculation engine, tax service, shipping/payment providers, payment gateways, Stripe minor-unit conversion, and the sales UI dialogs.

**Out of scope:** quantities, tax-rate percentages (`numeric(7,4)`), weights, dimensions, unit conversion factors, coordinates and scores.

## Overview

Open Mercato stores money in fixed-scale columns: `(18,4)` in sales, `(16,4)` for catalog prices, and `(12,2)`, `(14,2)` and `(16,2)` in checkout, staff, customers and customer_groups. FX rates use `(18,8)`. All arithmetic runs on JS `number` with hard-coded rounding to 4, 2 or 100. That rules out crypto currencies such as BTC (8 dp) and ETH (18 dp), and it truncates small or inverted FX rates. For example, 1 IDR is about `0.000056` USD, which keeps at most 4 significant digits at 8 dp.

## Problem Statement

1. **Column limits.** Values beyond the column scale are silently rounded by Postgres. Values beyond the integer digits fail the insert.
2. **Float math.** `0.1 + 0.2 !== 0.3`. Rounding happens at a hard-coded 4 dp (`Math.round(x * 1e4) / 1e4`) or 2 dp, whatever the currency.
3. **Number-typed inputs.** Validators coerce amounts to `number` (`z.coerce.number()`), so precision is lost before persistence. `value.toString()` can also emit exponent notation (`1e-7`).
4. **`currency.decimalPlaces` is ignored** by every calculation, and it is capped at 8.
5. **Exchange rates cannot carry metadata**, such as a provider table number, notes or source references.

## Proposed Solution

### Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Money and FX columns become unconstrained `numeric` | Postgres allows 131072 integer and 16383 fractional digits. `ALTER ... TYPE numeric` from `numeric(p,s)` does not rewrite the table |
| D2 | `big.js` is a production dependency of `@open-mercato/shared` | Small (~3 KB), immutable, exact `plus`/`minus`/`times`. Decimal places apply only to `div`/`sqrt`. `decimal.js` rounds every operation to N significant digits, which would re-introduce a limit |
| D3 | Division cutoff is `max(decimalPlaces, 17 significant digits)` | Infinite expansions (`1/3`) must be cut somewhere. 17 significant digits is what an IEEE 754 double needs to round-trip, so the result is never worse than `number` |
| D4 | Amount precision is `max(4, currency.decimalPlaces)`, falling back to the `Intl` ISO digits and then to 4 | Fiat keeps today's 4 dp internal precision (currencies AGENTS rule 1). Crypto gets its full precision |
| D5 | FX division precision is 50 dp | Far beyond any real rate. Combined with D3, tiny rates still keep 17 significant digits |
| D6 | Rounding mode is half-up (away from zero) | Matches `Math.round` for positive values. Negative halves now round away from zero, the accounting convention |
| D7 | Dual fields: keep `number` fields as float copies (documented "prefer the exact field"), add optional `<field>Exact: string` | Additive for TS contracts and API payloads; existing consumers keep compiling |
| D8 | Validator output types stay unchanged (`number`); commands read exact digits from the raw request with `withExactAmounts`. Validators that only accepted JSON numbers (gateway, staff rate override) also accept decimal strings | Changing parsed output types would silently break arithmetic in `@ts-nocheck` command files (`documents.ts`, `payments.ts`, `shipments.ts`) and change exported `z.infer` types |
| D10 | Staff amounts round to the currency's own decimals (2 when unknown), not `max(4, dp)` | Staff always billed in minor units (2 for fiat); keeps fiat behaviour unchanged |
| D11 | Precision for amounts is resolved centrally in `salesCalculationService` when the context lacks `amountDecimalPlaces` | Every caller gets currency precision without touching each context builder |
| D9 | Exchange rate `metadata` is free-form `jsonb`, editable as JSON in the backend form | Providers and operators can attach arbitrary context |

### Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Widen columns to a bigger fixed scale (e.g. `(38,18)`) | Still a limit. Crypto tokens can exceed 18 dp |
| `decimal.js` / `bignumber.js` | `decimal.js` applies significant-digit precision to every op. `bignumber.js` is equivalent to `big.js` but larger |
| Rational numbers (numerator/denominator) | Not representable in SQL `numeric` columns. Heavy for every consumer |
| Switch TS contract fields from `number` to `string` | Silently breaks third-party hooks (`a + b` concatenates) |

## Architecture

### Shared decimal toolkit - `packages/shared/src/lib/decimal.ts`

Plain functions over `big.js`:

- `toDecimal(value)`: accepts `string | number | Big` and throws on NaN, Infinity or a malformed string.
- `decimalToString(value)`: no exponent, no padding.
- `addDecimals`, `subtractDecimals`, `multiplyDecimals`, `sumDecimals`.
- `divideDecimals(a, b, decimalPlaces)`: applies D3.
- `roundDecimal(value, decimalPlaces)`: applies D6.
- `compareDecimals`, `isZeroDecimal`, `minDecimal`, `maxDecimal`, `absDecimal`, `negateDecimal`.
- Constants: `FX_DECIMAL_PLACES = 50`, `MIN_SIGNIFICANT_DIGITS = 17`, `DEFAULT_AMOUNT_DECIMAL_PLACES = 4`.
- `resolveAmountDecimalPlaces(currencyDecimalPlaces)`: applies D4.
- `decimalStringSchema` (zod): accepts `number | string` and outputs a canonical string. Comes with non-negative and positive variants.
- `resolveExactDecimal(exact, legacy)` - the bridge rule: the exact string wins unless the float was changed on its own.
- `withExactAmounts(parsed, raw, fields)` - adds `<field>Exact` strings from the raw request next to coerced numbers.
- `amountComparisonTolerance(dp)` - half a minor unit at the given precision (0.005 at 4).
- `@open-mercato/shared/lib/currencyPrecision`: `resolveCurrencyDecimalPlaces` (raw currency digits) and `resolveCurrencyAmountDecimalPlaces` (`max(4, dp)`).
- `parseLocaleDecimal(input, locale)` in `lib/number.ts` - exact variant of `parseLocaleNumber` for user-typed money.

### Currency precision source

The currencies module registers a `currencyPrecisionService` DI service with `getDecimalPlaces({ code, tenantId, organizationId })`, cached per request. Consumers resolve it soft-optionally, so modules without currencies fall back to the `Intl` ISO digits and then to 4. The `decimalPlaces` validator cap rises from 8 to 50.

### Sales calculation engine

- Calculators compute exclusively on `Exact` strings through the shared toolkit.
- `number` fields are filled with `Number(exact)` at the end of each step.
- The calculation context gets `amountDecimalPlaces`.
- **Hook bridge.** After every hook `setResult`, any field whose `number` no longer matches `Number(exact)` is treated as modified by a legacy hook, and its `Exact` value is re-derived from the `number`. Untouched fields keep full precision.

### Persistence

Commands write `Exact` strings to entities, never `number.toString()`. Existing `toNumericString` helpers stay as deprecated bridges.

## Data Models

### Exchange rate

| Column | Before | After |
|--------|--------|-------|
| `exchange_rates.rate` | `numeric(18,8)` | `numeric` |
| `exchange_rates.metadata` | - | `jsonb null` |
| `sales_orders.exchange_rate` | `numeric(18,8)` | `numeric` |

### Money columns changed to `numeric`

| Module | Tables (columns) | Before |
|--------|------------------|--------|
| sales | orders, quotes, invoices, credit memos (subtotal/discount/tax/shipping/surcharge/grand totals, paid, refunded, outstanding) | 18,4 |
| sales | order/quote/invoice/credit-memo/return lines (unit prices, discount, tax, totals); adjustments (`amount_net/gross`); shipments (`declared_value_*`); payments (`amount`, `captured_amount`, `refunded_amount`); payment allocations (`amount`) | 18,4 |
| sales | shipping methods (`base_rate_net/gross`) | 16,4 |
| catalog | product variant prices (`unit_price_net/gross`, `tax_amount`) | 16,4 |
| payment_gateways | gateway transactions (`amount`, `captured_amount`), payment operations (`reserved_amount`) | 18,4 |
| warranty_claims | claims (`total_claimed/approved/recovered_amount`), settings (`auto_approve_max_amount`), claim lines (`credit_amount`, `restocking_fee`, `core_charge_amount`, `core_credit_amount`) | 18,4 |
| staff | time entries (`rate_override_amount`), projects (`hourly_rate`, `budget_value`), reports (`total_amount`), report entries (`frozen_rate_amount`, `frozen_amount`) | 14,4 / 14,2 |
| customers | companies (`annual_revenue`), deals (`value_amount`) | 16,2 / 14,2 |
| customer_groups | group terms (`default_credit_limit`, `approval_required_above`, `min_order_value`) | 16,2 |
| checkout | link templates and links (`fixed_price_amount`, `fixed_price_original_amount`, `custom_amount_min`, `custom_amount_max`), transactions (`amount`) | 12,2 |

Existing rows keep their stored scale (`40.0000`). New rows store the value as written (`40`).

## API Contracts

- `GET /api/currencies/exchange-rates` items gain `metadata: Record<string, unknown> | null`. `POST` and `PUT` accept `metadata`. `rate` accepts any number of decimals.
- **Endpoints that return amounts as JSON numbers** keep them and add a `<field>Exact` string sibling: sales document list/detail totals, checkout templates/links/transactions, payment gateway status, customer deal stats/summary.
- **Endpoints that return amounts as strings** keep strings. Their OpenAPI schemas are corrected from `number` to `string`: sales lines, adjustments, payments, catalog prices, warranty claim totals.
- **Write endpoints** accept amounts as `number` or decimal `string`. Strings are recommended for exactness.

## Integration Coverage

| Test | Covers |
|------|--------|
| `currencies/__integration__/TC-CUR-016` | Exchange rate with 30 decimals and `metadata`: create, read back exactly, update metadata, cleanup |
| `sales/__integration__/TC-SALES-PRECISION-001` | 18-dp currency order (create currency, order, line, tax, payment); totals read back as exact strings; cleanup |

## Migration & Backward Compatibility

| Surface | Change | Classification |
|---------|--------|----------------|
| DB schema | `numeric(p,s)` → `numeric` on money/FX columns; new nullable `exchange_rates.metadata` | ✓ ADDITIVE (widening) |
| TS types (`sales/lib/types.ts`, tax service, providers, `shared/modules/payment_gateways/types.ts`, staff `TimeRateResolver`) | `<field>Exact: string` added; `number` fields `@deprecated`; resolvers may return `number | string` | ✓ ADDITIVE + deprecation |
| Calculation hooks | Legacy number-only hooks keep working through the hook bridge | ✓ Behavior-preserving |
| Zod validators | Input widened to `number | string`; parsed output for amount fields changes from `number` to `string` | ⚠ Type change of `z.infer` output - documented in UPGRADE_NOTES |
| API responses | `<field>Exact` siblings added; string amounts no longer scale-padded for new rows | ✓ ADDITIVE; padding change is value-preserving |
| Helpers `toNumericString`, `LINE_AMOUNT_SCALE`, `roundLineAmount` | Kept, `@deprecated` | ✓ Bridge |

## Risks & Impact Review

| Risk | Severity | Area | Mitigation | Residual |
|------|----------|------|------------|----------|
| Fiat totals change because of the new rounding | High | sales | Fiat precision stays 4 dp (D4); regression unit tests compare against current results | Negative half-values round away from zero (D6) |
| A third-party hook writes only `number` and loses precision | Medium | sales hooks | Hook bridge re-derives `Exact` from changed `number` fields | That field is limited to float precision |
| Clients compare padded strings (`"40.0000"`) | Low | API | Values are numerically equal; documented | Exact string equality checks need updating |
| `big.js` adds bundle weight to the client | Low | UI | ~3 KB gzipped | - |
| Postgres `numeric` division in SQL aggregates | Low | analytics | SQL `SUM` is exact; only `AVG`/division uses PG's own scale rules | - |

## Final Compliance Report

- **Tenant scoping:** unchanged. `currencyPrecisionService` filters by tenant and organization.
- **Generated files:** not edited by hand. Migrations come from `yarn db:generate`.
- **Optimistic locking:** `updatedAt` handling is unchanged.
- **i18n:** new user-facing strings use locale files.

## Implementation Notes

- MikroORM maps a bare `type: 'numeric'` to `numeric(10,0)`; entities declare `columnType: 'numeric'` to get an unconstrained column.
- Hook bridge lives in `calculations.ts` (`syncLineResultExactAmounts`, `syncDocumentResultExactAmounts`) and runs after every calculator and event hook.
- Payment capture ledger works on exact decimal strings; `parseAmountUnits`/`formatAmountUnits` are deprecated.
- CrudForm builtin field type `'decimal'` keeps exact decimal strings (used by the exchange rate form).
- Money redaction paths (staff reports without `rates.view`) null the `*Exact` fields together with the floats.

## Changelog

- 2026-10-08: Spec created.
- 2026-10-08: Implemented. D7/D8 refined (float copies instead of `@deprecated`, validators keep `number` output); added D10 (staff rounding) and D11 (central precision resolution).
