import {
  countDecimalPlaces,
  decimalToString,
  parseDecimal,
  resolveIsoCurrencyDecimalPlaces,
  type DecimalValue,
} from '@open-mercato/shared/lib/decimal'

/**
 * Format a monetary value with an optional ISO-4217 currency code.
 *
 * Returns `null` for empty input, the original string for non-numeric input,
 * and falls back to a plain number format (optionally suffixed with the code)
 * when the currency code is missing or rejected by `Intl.NumberFormat`.
 *
 * Decimal strings are formatted exactly (no float round-trip) and never rounded:
 * a value with more decimals than the currency shows (`0.000000000000000003`
 * ETH, a 4-decimal USD unit price) keeps all its digits. Shorter values are
 * padded to the ISO 4217 digits of the currency (`5.000` KWD, `5` JPY), or 2
 * for codes the runtime does not know. Pass `decimalPlaces` (the currency's
 * configured precision) to pad to fewer digits than that.
 *
 * Pass `locale` to format in the application locale (`useLocale()` in client
 * components). Omitting it keeps the runtime default, which varies per machine
 * and is therefore not assertable in tests.
 */
export function formatCurrency(
  value: string | number | null | undefined,
  currency?: string | null,
  locale?: string,
  decimalPlaces?: number | null,
): string | null {
  if (value === null || value === undefined || value === '') return null
  const exact = parseDisplayDecimal(value)
  if (!exact) {
    return typeof value === 'string' ? value : null
  }
  const amount = decimalToString(exact) as Intl.StringNumericLiteral
  const code = currency && currency.length === 3 ? currency.toUpperCase() : undefined
  const digits = resolveFractionDigits(exact, code, decimalPlaces)
  try {
    if (code) {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: code, ...digits }).format(amount)
    }
  } catch {
    // fall through to plain number formatting
  }
  const formatted = new Intl.NumberFormat(locale, digits).format(amount)
  return code ? `${formatted} ${code}` : formatted
}

const DEFAULT_CURRENCY_FRACTION_DIGITS = 2
const FLOAT_SIGNIFICANT_DIGITS = 15
const LEGACY_MAX_INTL_FRACTION_DIGITS = 20
const EXTENDED_MAX_INTL_FRACTION_DIGITS = 100

let maxIntlFractionDigits: number | null = null

function resolveMaxIntlFractionDigits(): number {
  if (maxIntlFractionDigits !== null) return maxIntlFractionDigits
  try {
    new Intl.NumberFormat('en', { maximumFractionDigits: EXTENDED_MAX_INTL_FRACTION_DIGITS })
    maxIntlFractionDigits = EXTENDED_MAX_INTL_FRACTION_DIGITS
  } catch {
    maxIntlFractionDigits = LEGACY_MAX_INTL_FRACTION_DIGITS
  }
  return maxIntlFractionDigits
}

function parseDisplayDecimal(value: string | number): DecimalValue | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return parseDecimal(value)
  return parseDecimal(Number.parseFloat(value.toPrecision(FLOAT_SIGNIFICANT_DIGITS)))
}

function resolveFractionDigits(
  exact: DecimalValue,
  code: string | undefined,
  decimalPlaces: number | null | undefined,
): Intl.NumberFormatOptions {
  const configured =
    typeof decimalPlaces === 'number' && Number.isInteger(decimalPlaces) && decimalPlaces >= 0 ? decimalPlaces : null
  const currencyDigits = code
    ? resolveIsoCurrencyDecimalPlaces(code) ?? DEFAULT_CURRENCY_FRACTION_DIGITS
    : configured === null ? 0 : DEFAULT_CURRENCY_FRACTION_DIGITS
  const minimum = configured === null ? currencyDigits : Math.min(currencyDigits, configured)
  const maximum = Math.min(Math.max(minimum, countDecimalPlaces(exact)), resolveMaxIntlFractionDigits())
  return { minimumFractionDigits: Math.min(minimum, maximum), maximumFractionDigits: maximum }
}

/**
 * Format an ISO date string as a localized short date (e.g. `Jun 9, 2026`).
 *
 * Returns `null` for empty input and echoes the original value back when it is
 * not a parseable date. Pass `locale` to format in the application locale.
 */
export function formatDate(value: string | null | undefined, locale?: string): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
}
