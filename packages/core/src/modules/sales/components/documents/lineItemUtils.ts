"use client"

import {
  DEFAULT_AMOUNT_DECIMAL_PLACES,
  FX_DECIMAL_PLACES,
  addDecimals,
  countDecimalPlaces,
  decimalToString,
  divideDecimals,
  multiplyDecimals,
  parseDecimal,
  resolveIsoCurrencyDecimalPlaces,
  roundDecimal,
  toDecimal,
  type DecimalInput,
  type DecimalValue,
} from '@open-mercato/shared/lib/decimal'
import { formatCurrency } from '@open-mercato/ui/utils/format'

export function normalizeNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length) {
    const parsed = Number(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

/**
 * Pass `locale` to format in the application locale (`useLocale()` in client components).
 * Omitting it keeps the runtime default, which varies per machine and is therefore not
 * assertable in tests.
 */
export function formatMoney(
  value: number | string,
  currency: string | null | undefined,
  locale?: string,
  decimalPlaces?: number | null,
): string {
  const exact = parseDecimal(value)
  if (!exact) return String(value)
  if (!currency) {
    const digits =
      typeof decimalPlaces === 'number' && Number.isInteger(decimalPlaces) && decimalPlaces >= 0 ? decimalPlaces : 2
    return exact.toFixed(digits)
  }
  return formatCurrency(decimalToString(exact), currency, locale, decimalPlaces) ?? decimalToString(exact)
}

export function toExactAmount(value: unknown): string | null {
  const exact = parseDecimal(typeof value === 'string' ? value.trim() : value)
  return exact ? decimalToString(exact) : null
}

export function resolveMoneyDecimalPlaces(...values: Array<DecimalInput | null | undefined>): number {
  return values.reduce<number>((places, value) => {
    if (value === null || value === undefined) return places
    return Math.max(places, countDecimalPlaces(value))
  }, DEFAULT_AMOUNT_DECIMAL_PLACES)
}

export function roundMoney(value: DecimalInput, decimalPlaces: number = DEFAULT_AMOUNT_DECIMAL_PLACES): string {
  return decimalToString(roundDecimal(value, decimalPlaces))
}

function resolveTaxMultiplier(taxRate: DecimalInput | null | undefined): DecimalValue | null {
  const rate = parseDecimal(taxRate)
  const multiplier = addDecimals(1, rate ? divideDecimals(rate, 100) : 0)
  return multiplier.gt(0) ? multiplier : null
}

export function grossFromNet(net: DecimalInput, taxRate: DecimalInput | null | undefined): string {
  const multiplier = resolveTaxMultiplier(taxRate)
  return multiplier ? roundMoney(multiplyDecimals(net, multiplier), resolveMoneyDecimalPlaces(net)) : decimalToString(net)
}

export function netFromGross(gross: DecimalInput, taxRate: DecimalInput | null | undefined): string {
  const multiplier = resolveTaxMultiplier(taxRate)
  return multiplier
    ? roundMoney(divideDecimals(gross, multiplier, FX_DECIMAL_PLACES), resolveMoneyDecimalPlaces(gross))
    : decimalToString(gross)
}

/**
 * Decimal places an amount a dialog fills in for the user is rounded to: the
 * currency's ISO 4217 digits (2 for a code without them), or more when a typed
 * source amount carries more.
 */
export function resolveAutoFillDecimalPlaces(
  currencyCode: string | null | undefined,
  ...sources: Array<DecimalInput | null | undefined>
): number {
  return sources.reduce<number>((places, source) => {
    if (source === null || source === undefined) return places
    return Math.max(places, countDecimalPlaces(source))
  }, resolveIsoCurrencyDecimalPlaces(currencyCode) ?? 2)
}

export function roundAutoFilledAmount(
  value: DecimalInput,
  currencyCode: string | null | undefined,
  ...sources: Array<DecimalInput | null | undefined>
): string {
  const decimalPlaces = resolveAutoFillDecimalPlaces(currencyCode, ...sources)
  return roundDecimal(value, decimalPlaces).toFixed(decimalPlaces)
}

/** The other side of a typed net or gross amount, rounded like `roundAutoFilledAmount`. */
export function autoFillOppositeAmount(
  source: 'net' | 'gross',
  amount: DecimalInput,
  taxRate: DecimalInput | null | undefined,
  currencyCode: string | null | undefined,
): string {
  const multiplier = resolveTaxMultiplier(taxRate)
  const opposite = !multiplier
    ? toDecimal(amount)
    : source === 'net'
      ? multiplyDecimals(amount, multiplier)
      : divideDecimals(amount, multiplier, FX_DECIMAL_PLACES)
  return roundAutoFilledAmount(opposite, currencyCode, amount)
}

export type LineDiscountDisplay = {
  amount: number | null
  percent: number | null
}

type LineDiscountSource = {
  discountAmount?: unknown
  discountPercent?: unknown
  unitPriceNet?: unknown
  quantity?: unknown
}

const DISCOUNT_MATCH_TOLERANCE = 0.01
const DISCOUNT_MATCH_TOLERANCE_PER_UNIT = 0.0001

function percentAccountsForAmount(
  line: LineDiscountSource,
  percent: number,
  amount: number,
): boolean {
  if (percent <= 0) return false
  const quantity = normalizeNumber(line.quantity, 0)
  const netBeforeDiscount = normalizeNumber(line.unitPriceNet, 0) * quantity
  if (netBeforeDiscount <= 0) return false
  const tolerance = Math.max(
    DISCOUNT_MATCH_TOLERANCE,
    quantity * DISCOUNT_MATCH_TOLERANCE_PER_UNIT,
  )
  return Math.abs((percent / 100) * netBeforeDiscount - amount) <= tolerance
}

export function resolveLineDiscountDisplay(
  line: LineDiscountSource,
): LineDiscountDisplay | null {
  const amount = normalizeNumber(line.discountAmount, 0)
  const percent = normalizeNumber(line.discountPercent, 0)
  if (amount > 0) {
    return {
      amount,
      percent: percentAccountsForAmount(line, percent, amount) ? percent : null,
    }
  }
  if (percent > 0) return { amount: null, percent }
  return null
}
