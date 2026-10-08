import { decimalToString, parseDecimal } from '@open-mercato/shared/lib/decimal'

/**
 * Format a monetary value with an optional ISO-4217 currency code.
 *
 * Returns `null` for empty input, the original string for non-numeric input,
 * and falls back to a plain number format (optionally suffixed with the code)
 * when the currency code is missing or rejected by `Intl.NumberFormat`.
 *
 * Decimal strings are formatted exactly (no float round-trip). Pass
 * `decimalPlaces` (the currency's precision, e.g. 18 for ETH) to show more than
 * the ISO default digits.
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
  const exact = parseDecimal(value)
  if (!exact) {
    return typeof value === 'string' ? value : null
  }
  const amount = decimalToString(exact) as Intl.StringNumericLiteral
  const digits = resolveFractionDigits(decimalPlaces)
  const code = currency && currency.length === 3 ? currency.toUpperCase() : undefined
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

const MAX_INTL_FRACTION_DIGITS = 20

function resolveFractionDigits(decimalPlaces: number | null | undefined): Intl.NumberFormatOptions {
  if (typeof decimalPlaces !== 'number' || !Number.isInteger(decimalPlaces) || decimalPlaces < 0) return {}
  const maximumFractionDigits = Math.min(decimalPlaces, MAX_INTL_FRACTION_DIGITS)
  return { minimumFractionDigits: Math.min(2, maximumFractionDigits), maximumFractionDigits }
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
