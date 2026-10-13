# Arbitrary-Precision Money and FX Rates

## TLDR

Make every money and FX column an unconstrained Postgres `numeric`. Move all money math from JS floats to exact decimal arithmetic, and add free-form `metadata` to exchange rates.

- Exact values are `DecimalValue` objects from `@open-mercato/shared/lib/decimal`. The underlying library (`big.js`) is hidden behind that class, so swapping it means rewriting one adapter file.
- `MoneyValue` pairs a `DecimalValue` amount with its currency for calculation code.
- Every `numeric` entity property keeps its `string` type and gains a computed `<property>Decimal` accessor that reads and writes it as a `DecimalValue`. Nothing existing changes type.

- Add, subtract and multiply are exact.
- Division is the only operation that is cut. It keeps at least the requested decimals (50 for FX math) and never fewer than 17 significant digits, so it is never less precise than a JS `number`.
- A stored money amount that comes out of a division is then rounded to the amount precision: `max(4, currency.decimalPlaces)`, or the currency's own decimals in staff.

Public TypeScript contracts and API payloads that expose amounts as `number` keep those fields as float copies of the exact value (not `@deprecated`). Each gets a sibling `<field>Exact: string` that carries the exact value.

**Scope:**
- **Columns:** exchange rates (`exchange_rates.rate`, `sales_orders.exchange_rate`) and about 100 money columns in sales, catalog, checkout, customers, customer_groups, payment_gateways, staff and warranty_claims.
- **Math:** the sales calculation engine, tax service, shipping/payment providers, payment gateways, Stripe minor-unit conversion, and the sales UI dialogs.

**Out of scope:** widening non-money columns (quantities, tax-rate percentages `numeric(7,4)`, weights, dimensions, unit conversion factors, coordinates and scores). They keep their precision and scale, but get a `<property>Decimal` accessor like every other `numeric` column.

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
| D3 | Division keeps `max(decimalPlaces, 17 significant digits)` decimals. `decimalPlaces` is a lower bound, not a rounding step | Infinite expansions (`1/3`) must be cut somewhere. 17 significant digits is what an IEEE 754 double needs to round-trip, so the result is never worse than `number`. Only FX values and intermediate results keep the extra digits; stored amounts are rounded afterwards (D4) |
| D4 | Every stored amount derived by division is rounded with `roundDecimal(value, amountDecimalPlaces)`, where `amountDecimalPlaces` is `max(4, currency.decimalPlaces)`, falling back to the `Intl` ISO digits and then to 4 | Fiat keeps today's 4 dp internal precision (currencies AGENTS rule 1): `100 / 1.23` is stored as `81.3008`. Crypto gets its full precision. Entered amounts (catalog prices, unit prices) stay exact; client-supplied sales line discount, tax and gross totals are rounded to this precision, as the old `(18,4)` columns did for fiat |
| D5 | FX division precision is 50 dp | Far beyond any real rate. Combined with D3, tiny rates still keep 17 significant digits |
| D6 | Rounding mode is half-up (away from zero) | Matches `Math.round` for positive values. Negative halves now round away from zero, the accounting convention |
| D7 | Dual fields: keep `number` fields as float copies (documented "prefer the exact field"), add optional `<field>Exact: string` | Additive for TS contracts and API payloads; existing consumers keep compiling |
| D8 | Validator output types stay unchanged (`number`); commands read exact digits from the raw request with `withExactAmounts`. Validators that only accepted JSON numbers (gateway, staff rate override) also accept decimal strings | Changing parsed output types would silently break arithmetic in `@ts-nocheck` command files (`documents.ts`, `payments.ts`, `shipments.ts`) and change exported `z.infer` types |
| D9 | Exchange rate `metadata` is free-form `jsonb`, editable as JSON in the backend form | Providers and operators can attach arbitrary context |
| D10 | Staff amounts round to the currency's own decimals (2 when unknown), not `max(4, dp)` | Staff always billed in minor units (2 for fiat); keeps fiat behaviour unchanged |
| D11 | Precision for amounts is resolved centrally in `salesCalculationService` when the context lacks `amountDecimalPlaces` | Every caller gets currency precision without touching each context builder |
| D12 | Exact values are instances of our own `DecimalValue` class. Only `lib/decimalEngine.ts` imports `big.js`; its value never leaves `DecimalValue` (`#private` field), and `decimal-engine-boundary.test.ts` fails when any other file imports the library or the engine | Swapping the library (e.g. to `decimal.js`) means rewriting one adapter that has explicit semantics (division to N decimal places, half-up rounding) and passing the toolkit tests. Callers never depend on library methods or configuration |
| D13 | `MoneyValue` = `DecimalValue` amount + currency code + rounding precision. Arithmetic across currencies throws; division rounds to the money's precision; `convert(rate, currency)` does FX. It is a calculation type, not a persisted one | An amount passed around keeps its meaning (review feedback on #7324). Entities keep flat amount columns that share one currency column, so the ORM cannot hydrate `MoneyValue` |
| D14 | Every `numeric` entity property (money, FX, quantities, rates, weights, coordinates, scores) gets a computed `<property>Decimal` accessor: the getter returns `DecimalValue` (`DecimalValue \| null` when nullable), the setter writes the canonical string to the stored property. It is not persisted or serialized and is typed `Opt<...>`, so `em.create` does not require it | Exact math on entity values without re-parsing at every call site, for every exact number, not just money. Purely additive: the stored `string` property, queries, API output and existing consumers are unchanged |
| D15 | `DecimalValue.toString()`, `toJSON()` and `valueOf()` return the canonical decimal string | `String(x)`, `Number(x)`, template literals and `JSON.stringify` give the same string the stored property holds. TypeScript still rejects `value + 1` on the object |
| D16 | Stored properties stay `string`; `ExactDecimalType` keeps hydrating strings | Changing the hydrated type would break every module that reads these properties at compile time, with no possible bridge (a property cannot carry two types) |

### Alternatives considered

| Alternative | Why rejected |
|-------------|--------------|
| Widen columns to a bigger fixed scale (e.g. `(38,18)`) | Still a limit. Crypto tokens can exceed 18 dp |
| `decimal.js` / `bignumber.js` | `decimal.js` applies significant-digit precision to every op. `bignumber.js` is equivalent to `big.js` but larger. Either can replace `big.js` later by rewriting `decimalEngine.ts` (D12) |
| Expose the library type (`type DecimalValue = Big`) | Callers chained library methods (`plus`, `eq`, `toFixed`), so a swap would touch every call site and silently change semantics (`decimal.js` precision counts significant digits) |
| Hydrate entity columns as `DecimalValue` | Breaks every consumer of the entity properties at compile time without a bridge, so it would need a minor release; the `<property>Decimal` accessor gives the same ergonomics additively |
| `MoneyValue` as a MikroORM embeddable | Documents have about 20 amount columns sharing one currency column; an embeddable would duplicate the currency per amount |
| Rational numbers (numerator/denominator) | Not representable in SQL `numeric` columns. Heavy for every consumer |
| Switch TS contract fields from `number` to `string` | Silently breaks third-party hooks (`a + b` concatenates) |

## Architecture

### Decimal engine - `packages/shared/src/lib/decimalEngine.ts`

The only module that imports `big.js` (enforced by `packages/shared/src/lib/__tests__/decimal-engine-boundary.test.ts`; ESLint only lints the app). It exposes an opaque `EngineDecimal` handle and the operations `DecimalValue` needs, with semantics defined by us rather than by the library:

- `parseEngineDecimal(text)` (input already validated), `engineToString(value)` (plain notation, no exponent, no padding), `engineToFixed(value, dp)`.
- `engineAdd`, `engineSubtract`, `engineMultiply`: exact.
- `engineDivide(left, right, decimalPlaces)`: quotient cut to `decimalPlaces`, half-up.
- `engineRound(value, decimalPlaces)`: half-up (D6).
- `engineCompare`, `engineMagnitude(value)` (power of ten of the leading digit, used for the 17-significant-digit rule), `engineAbs`, `engineNegate`.

### `DecimalValue` - `packages/shared/src/lib/decimal.ts`

An immutable class; the engine handle lives in a `#private` field.

- Creation: `DecimalValue.from(input)` (throws on invalid input, see the caps below), `DecimalValue.fromNullable(input)` (`null` for `null`/`undefined`, otherwise `from`), `DecimalValue.parse(unknown)` (`null` for blank or invalid), `DecimalValue.zero()`, `DecimalValue.isDecimalValue(value)`.
- Arithmetic: `plus`, `minus`, `times` (exact), `dividedBy(divisor, decimalPlaces = FX_DECIMAL_PLACES)` (D3), `round(decimalPlaces)` (D6), `abs`, `negate`.
- Comparison: `compare`, `equals`, `lt`, `lte`, `gt`, `gte`, `isZero`, `isNegative`, `isPositive`, `decimalPlaces()`.
- Output: `toString()` / `toJSON()` / `valueOf()` return the canonical string (D15), `toFixed(decimalPlaces)` rounds half-up and pads, `toNumber()` is the float copy.
- Every method accepts `DecimalInput = string | number | DecimalValue`.
- `isDecimalValue` checks a `Symbol.for` brand, not `instanceof`, so a value from a duplicated copy of `@open-mercato/shared` (standalone apps) is still accepted; foreign instances are read through their string form.

### `MoneyValue` - `packages/shared/src/lib/money.ts`

- `MoneyValue.of(amount, currencyCode, decimalPlaces?)`: `decimalPlaces` defaults to `resolveAmountDecimalPlaces(resolveIsoCurrencyDecimalPlaces(code))`; callers with a configured currency pass `resolveAmountDecimalPlaces(currency.decimalPlaces)` (or the staff precision, D10).
- `plus`, `minus`, `compare`, `equals`, `lt`, `gt` take another `MoneyValue` and throw `[internal] Currency mismatch` when the codes differ.
- `times(factor)` is exact; `dividedBy(divisor)` and `round()` round to `decimalPlaces`; `convert(rate, currencyCode, decimalPlaces?)` multiplies by the rate and rounds to the target precision.
- `isZero`, `isNegative`, `abs`, `negate`, `toJSON()` (`{ amount, currencyCode }`).

### Toolkit functions - `packages/shared/src/lib/decimal.ts`

Thin wrappers over `DecimalValue`, kept for call sites that work on mixed inputs:

- `toDecimal(value)`: accepts `string | number | DecimalValue` and throws on NaN, Infinity or a malformed string. A value is malformed when its exponent exceeds `MAX_DECIMAL_EXPONENT = 1000`, it has more than `MAX_DECIMAL_SIGNIFICANT_DIGITS = 1000` significant digits, more than `MAX_DECIMAL_INTEGER_DIGITS = 300` integer digits (so the float copy stays finite), or a digit below `1e-1000`. Oversized input is a 400, never a slow request or a Postgres overflow.
- `decimalToString(value)`: no exponent, no padding.
- `addDecimals`, `subtractDecimals`, `multiplyDecimals`, `sumDecimals`.
- `divideDecimals(a, b, decimalPlaces)`: applies D3.
- `roundDecimal(value, decimalPlaces)`: applies D6.
- `compareDecimals`, `isZeroDecimal`, `minDecimal`, `maxDecimal`, `absDecimal`, `negateDecimal`.
- Constants: `FX_DECIMAL_PLACES = 50`, `MIN_SIGNIFICANT_DIGITS = 17`, `DEFAULT_AMOUNT_DECIMAL_PLACES = 4`.
- `resolveAmountDecimalPlaces(currencyDecimalPlaces)`: applies D4.
- `decimalStringSchema` (zod): accepts `number | string` and outputs a canonical string. Comes with non-negative and positive variants.
- `resolveExactDecimal(exact, legacy)` - the bridge rule: the exact string wins unless the float was changed on its own.
- `withExactAmounts(parsed, raw, fields)` - adds `<field>Exact` strings from the raw request next to coerced numbers. When the raw field is already a number, it reads the `<field>Exact` string attached to the raw input instead. A parsed `null` (or a schema that outputs strings) is used as-is, so a raw `<field>Exact` can never bypass validation.
- `withExactListAmounts(items, raw, key, fields)` - the same for each item of a nested list (document lines, payment allocations).
- `withDecimalCaps(schema, message?)` - wraps a number-coercing money schema so oversized input is rejected before coercion instead of being stored as `0` or `null`.
- `padDecimalPlaces(value, min)` - plain decimal string with at least `min` decimals, never cut (emails, exports of frozen amounts).
- `amountComparisonTolerance(dp)` - half a minor unit at the given precision (0.005 at 4).
- `@open-mercato/shared/lib/currencyPrecision`: `resolveCurrencyDecimalPlaces` (raw currency digits) and `resolveCurrencyAmountDecimalPlaces` (`max(4, dp)`).
- `resolveIsoCurrencyDecimalPlaces(code)` only trusts `Intl` for codes in `Intl.supportedValuesOf('currency')`, so unknown codes such as ETH return `null` instead of 2.
- `parseLocaleDecimal(input, locale)` in `lib/number.ts` - exact variant of `parseLocaleNumber` for user-typed money.

### Currency precision source

The currencies module registers a `currencyPrecisionService` DI service with `getDecimalPlaces({ code, tenantId, organizationId })`. It reads the currency with `findOneWithDecryption` scoped to the tenant and organization, and returns `null` without an organization. Consumers resolve it soft-optionally, so modules without currencies fall back to the `Intl` ISO digits and then to 4. The `decimalPlaces` validator cap rises from 8 to 50.

### Sales calculation engine

- Calculators compute exclusively on `Exact` strings through the shared toolkit.
- Divisions run at FX precision; each resulting amount is rounded to `amountDecimalPlaces` (D4).
- `number` fields are filled with `Number(exact)` at the end of each step.
- The calculation context and line results carry `amountDecimalPlaces`.
- **Hook bridge.** Every amount pair is compared with its value before each hook, paired by line or adjustment `id`; when no item has an id and the count is unchanged, by position; otherwise the float/exact consistency rule applies. Line snapshots keep their ids. The same change-aware rule applies to the `sales.tax.calculate.*` hooks. If only the `number` changed, the hook is a legacy one and `Exact` is re-derived from the `number`, rounded to `amountDecimalPlaces`. If `Exact` changed, it wins and the `number` is refreshed from it. Untouched fields keep full precision.

### Persistence

- Money and FX properties use `ExactDecimalType` (`@open-mercato/shared/lib/db/exactDecimalType`): it hydrates the canonical string and compares exact decimals for change detection. Fixed-scale properties keep `type: 'numeric'` with their precision and scale.
- Each `numeric` property has a `<property>Decimal` accessor (`DecimalValue.from(this.amount)`, or `DecimalValue.fromNullable(...)` for nullable columns; the setter stores `value.toString()`). Getters live on the prototype, so `wrap(entity).toObject()`, `serialize()` and API output do not include them.
- API routes parse the body before the command runs, which turns amounts into floats. Each route attaches `<field>Exact` strings taken from the raw body (`withExactAmounts`, `withExactListAmounts`, the sales helpers in `sales/lib/exactAmountFields.ts`), and the command reads them. Routes use a passthrough action schema, because `makeCrudRoute` builds `raw` from that schema's output. Commands with strict schemas (warranty claims) strip the `<field>Exact` keys before parsing.
- Commands write `Exact` strings to entities, never `number.toString()`. `toNumericString` accepts strings and never pads or emits exponent notation.
- Checkout configured amounts (fixed price, original price, custom min/max, price-list items) and transactions are rounded to the currency's own decimals, so the shown, validated and charged amounts match. The pay page submits exact strings.
- Catalog prices keep the entered side exact; only the derived side (gross in net mode, net in gross mode) is rounded, and tax is the exact difference.
- Payment gateway session, capture and refund routes, and the public checkout submit route before it reserves a transaction, reject amounts with more decimals than `min(tenant decimals, ISO minor-unit digits)` (400).
- Settlement checks (fully paid, refunded or shipped) use a tolerance of one unit at the currency's amount precision. Float-only resolvers keep the old `1e-4`.
- Closed staff reports sum and export frozen amounts as stored; live amounts round per D10.
- The sales dialogs read the configured currency decimals (`/api/currencies/currencies`) for auto-fill and shipped-line rescaling; `formatCurrency` rounds display to the currency precision when it is known.

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

- `GET /api/currencies/exchange-rates` items gain `metadata: Record<string, unknown> | null`. `POST` and `PUT` accept `metadata` up to 16 KB of JSON. `rate` accepts any number of decimals.
- **Endpoints that return amounts as JSON numbers** keep them and add a `<field>Exact` string sibling: sales document list/detail totals, checkout templates/links/transactions, payment gateway status (`amountExact`, `amountReceivedExact`), capture (`capturedAmountExact`) and refund (`refundedAmountExact`), customer deal stats (`dealValueExact`), summary (`valueExact`, `avgDealExact`) and aggregate (`totalInBaseCurrencyExact`, `byCurrency[].totalExact`; the number fields stay rounded to whole units), customer group terms, warranty claim settings (`autoApproveMaxAmountExact`), staff report totals, staff project list and time entries (`costExact`, `hourlyRateExact`).
- **Endpoints that return amounts as strings** keep strings. Their OpenAPI schemas are corrected from `number` to `string`: sales lines, adjustments, payments, shipments, catalog prices, warranty claim totals.
- **Write endpoints** accept amounts as `number` or decimal `string`. Strings are recommended for exactness.

## Integration Coverage

Every module whose API gains `<field>Exact` fields or wider money columns gets an exact round-trip test. Each one creates an amount beyond float and old-column precision, reads it back as an exact string, and cleans up.

| Test | Covers |
|------|--------|
| `currencies/__integration__/TC-CUR-016` | Exchange rate with 30 decimals and `metadata`: create, read back exactly, update metadata |
| `sales/__integration__/TC-SALES-PRECISION-001` | 18-dp currency order (currency, order, line, tax, payment, 25-digit exchange rate); totals read back as exact strings |
| `sales/__integration__/TC-SALES-PRECISION-002` | Shipping method base rates and invoice totals and lines beyond float precision |
| `catalog/__integration__/TC-CAT-PRECISION-001` | Variant price with 18 decimals through the prices API: create and update |
| `checkout/__integration__/TC-CHKT-PRECISION-001` | Link template and link fixed/custom amounts read back with `*Exact`; template amount changes reach linked links; transaction amount rounded to the currency decimals |
| `payment_gateways/__integration__/TC-PGWY-PRECISION-001` | 18-dp order: session, status (`amountExact`, `amountReceivedExact`), partial capture, capture ceiling and refund keep exact amounts |
| `customers/__integration__/TC-CRM-PRECISION-001` | Deal `valueAmount` and company `annualRevenue` beyond 2 decimals; deal stats `dealValueExact`; summary exact fields |
| `customer_groups/__integration__/TC-CGRP-PRECISION-001` | Group terms (`defaultCreditLimit`, `approvalRequiredAbove`, `minOrderValue`) beyond 2 decimals |
| `staff/__integration__/TC-STAFF-PRECISION-001` | Project hourly rate and time entry rate override beyond 4 decimals; preview and report totals `*Exact` |
| `warranty_claims/__integration__/TC-WC-PRECISION-001` | Claim line amounts beyond 4 decimals; claim totals read back exactly |
| `warranty_claims/__integration__/TC-WC-PRECISION-002` | Settings `autoApproveMaxAmount` beyond float precision |

## Migration & Backward Compatibility

| Surface | Change | Classification |
|---------|--------|----------------|
| DB schema | `numeric(p,s)` → `numeric` on money/FX columns; new nullable `exchange_rates.metadata` | ✓ ADDITIVE (widening) |
| TS types (`sales/lib/types.ts`, tax service, providers, `shared/modules/payment_gateways/types.ts`) | Optional `<field>Exact: string` added; `number` fields stay as float copies (not `@deprecated`) | ✓ ADDITIVE |
| Staff rate types (`TimeRateResolver`, `TimeRateContext`, `CostEntry.rateOverrideAmount`, `CostProject.hourlyRate`) | `resolve` still returns `number | null` and the context keeps `number | null` rate fields; optional `resolveExact` and `rateOverrideAmountExact` / `hourlyRateExact` siblings carry exact decimals; `CostEntry` / `CostProject` (helper inputs) also accept a decimal string | ✓ ADDITIVE |
| Calculation hooks | Number-only hooks keep working through the hook bridge; their float results are rounded to the amount precision; exact-only changes are kept | ✓ Behavior-preserving, except that negative halves now round away from zero (D6) |
| Zod validators | Parsed output unchanged (`number`), except the built-in provider settings schemas in `sales/lib/providers/defaultProviders.ts`, which now parse amounts to decimal strings. Inputs that only accepted JSON numbers (gateway amounts, staff rate override) also accept decimal strings; bounds that mirrored the old column precision are removed; oversized decimals are rejected | ✓ ADDITIVE (inputs widened); provider settings output ⚠ |
| API responses | `<field>Exact` siblings added; string amounts no longer scale-padded for new rows | ✓ ADDITIVE; padding change is value-preserving |
| Helpers | `toNumericString` accepts strings. Capture ledger `parseAmountUnits` / `formatAmountUnits` are `@deprecated`; `reserveCaptureAmount`, `settleCapturedAmount`, `releaseCaptureAmount` work on decimal strings | ⚠ Module-internal ledger signatures changed without a bridge (no known external consumers); rest ✓ ADDITIVE |
| Migrations `down()` | Narrows the columns back to their old precision | ⚠ Lossy: extra decimals are rounded away, and values beyond the old integer digits fail with "numeric field overflow" |
| Entity classes | Every `numeric` property gains a `<property>Decimal` accessor; the stored property stays `string` | ✓ ADDITIVE. A downstream subclass that already declares a member with the same name would conflict (none known) |
| `DecimalValue` / `DecimalInput` | Was `type DecimalValue = Big` (unreleased); now a class. `DecimalInput` no longer accepts `Big` | Unreleased surface, no bridge needed |
| Dependencies | `big.js` (and `@types/big.js`) become production dependencies of `@open-mercato/shared`, imported only by `decimalEngine.ts` | Approved by the maintainer during planning |

## Risks & Impact Review

| Risk | Severity | Area | Mitigation | Residual |
|------|----------|------|------------|----------|
| Fiat totals change because of the new rounding | High | sales | Fiat precision stays 4 dp (D4); regression unit tests compare against current results | Negative half-values round away from zero (D6) |
| A third-party hook writes only `number` and loses precision | Medium | sales hooks | Hook bridge re-derives `Exact` from changed `number` fields | That field is limited to float precision |
| Clients compare padded strings (`"40.0000"`) | Low | API | Values are numerically equal; documented | Exact string equality checks need updating |
| `big.js` adds bundle weight to the client | Low | UI | ~3 KB gzipped | - |
| Oversized input (`1e-100000000`, 100k-digit strings, values past Postgres or float limits) costs CPU or fails in the database | Medium | write APIs | Exponent, significant-digit, integer-digit and smallest-digit caps reject it as invalid input (400) | A valid price just under 1e300 times a large quantity can still overflow the float copy |
| Postgres `numeric` division in SQL aggregates | Low | analytics | SQL `SUM` is exact; only `AVG`/division uses PG's own scale rules | - |
| An accessor reads an invalid stored value | Low | entities | Stored values come from `numeric` columns or validated input; the getter throws `[internal] Invalid decimal value` instead of returning a wrong number | - |
| A swap of the decimal library changes results | Medium | shared | Engine semantics are explicit (decimal places, half-up) and covered by the toolkit tests | - |

## Final Compliance Report

- **Tenant scoping:** unchanged. `currencyPrecisionService` filters by tenant and organization.
- **Generated files:** not edited by hand. Migrations come from `yarn db:generate`.
- **Optimistic locking:** `updatedAt` handling is unchanged.
- **i18n:** new user-facing strings use locale files.

## Implementation Notes

- MikroORM maps a bare `type: 'numeric'` to `numeric(10,0)`; entities declare `columnType: 'numeric'` to get an unconstrained column.
- MikroORM's `DecimalType` detects changes by comparing `+value`, so an edit beyond float precision was never flushed. Money and FX columns use `ExactDecimalType` (`@open-mercato/shared/lib/db/exactDecimalType`), which compares exact decimal values. The schema is unchanged.
- MikroORM's `RequiredEntityData` treats a plain getter as a required `em.create` key; typing the getter as `Opt<DecimalValue>` makes it optional.
- Hook bridge lives in `calculations.ts` (`syncLineResultExactAmounts`, `syncDocumentResultExactAmounts`) and runs after every calculator and event hook.
- Payment capture ledger works on exact decimal strings; `parseAmountUnits`/`formatAmountUnits` are deprecated.
- CrudForm builtin field type `'decimal'` keeps exact decimal strings (used by the exchange rate form).
- Money redaction paths (staff reports without `rates.view`) null the `*Exact` fields together with the floats.

## Changelog

- 2026-10-08: Spec created.
- 2026-10-08: Implementation in progress on `pb/exchange-rate-metadata`. D7/D8 refined (float copies instead of `@deprecated`, validators keep `number` output); added D10 (staff rounding) and D11 (central precision resolution).
- 2026-10-08: Review fixes. D3/D4 state that stored amounts are rounded after division; TLDR and BC table match D7/D8; integration coverage lists every module that gains exact fields; exponent cap and hook bridge rules documented.
- 2026-10-08: API routes attach `<field>Exact` strings before the command parses the body (`withExactListAmounts` added). Coverage table lists the shipped tests; D4 notes that catalog prices and client-supplied line amounts round to the amount precision.
- 2026-10-08: Money and FX columns use `ExactDecimalType`, so updates beyond float precision are flushed.
- 2026-10-08: PR review fixes. Exact values cannot bypass validation on `null`; oversized decimals rejected; unknown currency codes no longer default to 2 decimals; hook bridge pairs by id and rounds legacy floats; catalog prices keep the entered side exact; checkout configured amounts round to the currency decimals and the pay page submits exact strings; gateway routes reject sub-minor amounts; frozen staff totals sum as stored; BC table corrected.
- 2026-10-09: Second re-review fixes. Oversized money input is a 400 on every number-coercing schema (`withDecimalCaps`); `formatCurrency` rounds to known currency precision; frozen staff exports keep stored values; hook bridge pairs id-less items by position; Stripe sub-minor check uses the ISO minor unit; staff cost gains exact siblings.
- 2026-10-12: Third re-review fixes. Exact siblings on the exported staff report types are optional again (D7), with `Exact*` result types for internal use; checkout submit enforces payment precision before reserving and the pay page displays exact amounts; staff project and time-entry editors preserve exact rates; the sales line dialog derives prices at the configured currency precision; command snapshots keep line ids, id-less hook results pair by identity, then by position; tax hooks keep exact-only edits.
- 2026-10-13: Exact values become the `DecimalValue` class with `big.js` behind a single engine adapter (D12), `MoneyValue` added for calculation code (D13), and every `numeric` entity property gains a `<property>Decimal` accessor while the stored property stays `string` (D14-D16), so the change stays additive.
