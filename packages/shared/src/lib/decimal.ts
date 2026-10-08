import BigConstructor from 'big.js'
import type { Big, BigSource } from 'big.js'
import { z } from 'zod'

export type DecimalValue = Big
export type DecimalInput = string | number | Big

export const FX_DECIMAL_PLACES = 50
export const MIN_SIGNIFICANT_DIGITS = 17
export const DEFAULT_AMOUNT_DECIMAL_PLACES = 4

const ROUND_HALF_UP = 1

const Decimal = BigConstructor()
Decimal.DP = FX_DECIMAL_PLACES
Decimal.RM = ROUND_HALF_UP

const DECIMAL_STRING_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i

export function isDecimalInput(value: unknown): value is DecimalInput {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return DECIMAL_STRING_PATTERN.test(value.trim())
  return value instanceof BigConstructor
}

export function toDecimal(value: DecimalInput): DecimalValue {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`[internal] Invalid decimal value: ${value}`)
    return new Decimal(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!DECIMAL_STRING_PATTERN.test(trimmed)) throw new Error(`[internal] Invalid decimal value: ${value}`)
    return new Decimal(trimmed.startsWith('+') ? trimmed.slice(1) : trimmed)
  }
  return new Decimal(value as BigSource)
}

export function parseDecimal(value: unknown): DecimalValue | null {
  if (value === null || value === undefined || value === '') return null
  if (!isDecimalInput(value)) return null
  return toDecimal(value)
}

export function decimalToString(value: DecimalInput): string {
  return toDecimal(value).toFixed()
}

export function addDecimals(left: DecimalInput, right: DecimalInput): DecimalValue {
  return toDecimal(left).plus(toDecimal(right))
}

export function subtractDecimals(left: DecimalInput, right: DecimalInput): DecimalValue {
  return toDecimal(left).minus(toDecimal(right))
}

export function multiplyDecimals(left: DecimalInput, right: DecimalInput): DecimalValue {
  return toDecimal(left).times(toDecimal(right))
}

export function sumDecimals(values: DecimalInput[]): DecimalValue {
  return values.reduce<DecimalValue>((total, value) => total.plus(toDecimal(value)), new Decimal(0))
}

/**
 * Divides with at least `decimalPlaces` decimals and never fewer than
 * MIN_SIGNIFICANT_DIGITS significant digits, so a quotient is never less
 * precise than the same division done on a JS `number`.
 */
export function divideDecimals(
  dividend: DecimalInput,
  divisor: DecimalInput,
  decimalPlaces: number = FX_DECIMAL_PLACES,
): DecimalValue {
  const left = toDecimal(dividend)
  const right = toDecimal(divisor)
  if (right.eq(0)) throw new Error('[internal] Division by zero')
  if (left.eq(0)) return new Decimal(0)
  const significantDecimalPlaces = MIN_SIGNIFICANT_DIGITS - (left.e - right.e)
  const previousDecimalPlaces = Decimal.DP
  Decimal.DP = Math.max(decimalPlaces, significantDecimalPlaces, 0)
  try {
    return left.div(right)
  } finally {
    Decimal.DP = previousDecimalPlaces
  }
}

export function roundDecimal(value: DecimalInput, decimalPlaces: number): DecimalValue {
  return toDecimal(value).round(decimalPlaces, ROUND_HALF_UP)
}

export function compareDecimals(left: DecimalInput, right: DecimalInput): -1 | 0 | 1 {
  return toDecimal(left).cmp(toDecimal(right)) as -1 | 0 | 1
}

export function decimalsEqual(left: DecimalInput, right: DecimalInput): boolean {
  return compareDecimals(left, right) === 0
}

export function isZeroDecimal(value: DecimalInput): boolean {
  return toDecimal(value).eq(0)
}

export function isNegativeDecimal(value: DecimalInput): boolean {
  return toDecimal(value).lt(0)
}

export function absDecimal(value: DecimalInput): DecimalValue {
  return toDecimal(value).abs()
}

export function negateDecimal(value: DecimalInput): DecimalValue {
  return toDecimal(value).neg()
}

export function minDecimal(...values: DecimalInput[]): DecimalValue {
  return values.map(toDecimal).reduce((lowest, value) => (value.lt(lowest) ? value : lowest))
}

export function maxDecimal(...values: DecimalInput[]): DecimalValue {
  return values.map(toDecimal).reduce((highest, value) => (value.gt(highest) ? value : highest))
}

export function decimalToNumber(value: DecimalInput): number {
  return Number(decimalToString(value))
}

export function resolveAmountDecimalPlaces(currencyDecimalPlaces?: number | null): number {
  if (typeof currencyDecimalPlaces !== 'number' || !Number.isInteger(currencyDecimalPlaces) || currencyDecimalPlaces < 0) {
    return DEFAULT_AMOUNT_DECIMAL_PLACES
  }
  return Math.max(DEFAULT_AMOUNT_DECIMAL_PLACES, currencyDecimalPlaces)
}

export function resolveIsoCurrencyDecimalPlaces(currencyCode?: string | null): number | null {
  if (!currencyCode) return null
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: currencyCode }).resolvedOptions()
      .maximumFractionDigits ?? null
  } catch {
    return null
  }
}

const decimalInputSchema = z.union([z.string(), z.number()]).refine(isDecimalInput, {
  message: 'invalidDecimal',
})

export const decimalStringSchema = decimalInputSchema.transform((value) => decimalToString(value))

export const nonNegativeDecimalStringSchema = decimalStringSchema.refine(
  (value) => !isNegativeDecimal(value),
  { message: 'decimalMustBeNonNegative' },
)

export const positiveDecimalStringSchema = decimalStringSchema.refine(
  (value) => toDecimal(value).gt(0),
  { message: 'decimalMustBePositive' },
)
