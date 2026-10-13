import { z } from 'zod'
import {
  engineAbs,
  engineAdd,
  engineCompare,
  engineDivide,
  engineMagnitude,
  engineMultiply,
  engineNegate,
  engineRound,
  engineRoundToSignificantDigits,
  engineSubtract,
  engineToFixed,
  engineToString,
  parseEngineDecimal,
  type EngineDecimal,
} from './decimalEngine'
import { ISO_4217_MINOR_UNITS } from './isoCurrencyMinorUnits'

export type DecimalInput = string | number | DecimalValue

export const FX_DECIMAL_PLACES = 50
export const MIN_SIGNIFICANT_DIGITS = 17
export const DEFAULT_AMOUNT_DECIMAL_PLACES = 4

/**
 * Largest exponent accepted in a decimal string, and the lowest decimal position
 * a digit may sit at (`1e-1000`). Expanding `1e-100000000` to plain notation
 * would allocate a 100M-character string, so anything beyond this bound (far
 * past any real money or FX value) is rejected as invalid input.
 */
export const MAX_DECIMAL_EXPONENT = 1000

/**
 * Most significant digits a decimal input may carry. Arithmetic cost grows with
 * the digit count, so longer inputs are rejected as invalid.
 */
export const MAX_DECIMAL_SIGNIFICANT_DIGITS = 1000

/**
 * Most integer digits a decimal input may carry (`|value| < 1e300`), so the
 * legacy float copy of an accepted value is always finite.
 */
export const MAX_DECIMAL_INTEGER_DIGITS = 300

const DECIMAL_STRING_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)(?:e([+-]?\d+))?$/i
const NON_ZERO_DIGIT_PATTERN = /[1-9]/

function isDecimalString(value: string): boolean {
  const match = DECIMAL_STRING_PATTERN.exec(value)
  if (!match) return false
  const exponent = match[3] === undefined ? 0 : Number(match[3])
  if (Math.abs(exponent) > MAX_DECIMAL_EXPONENT) return false
  const [integerPart, fractionPart = ''] = match[1].split('.')
  const digits = `${integerPart}${fractionPart}`
  const firstSignificant = digits.search(NON_ZERO_DIGIT_PATTERN)
  if (firstSignificant === -1) return true
  let lastSignificant = digits.length - 1
  while (digits[lastSignificant] === '0') lastSignificant -= 1
  const unitsIndex = integerPart.length - 1 + exponent
  return (
    lastSignificant - firstSignificant < MAX_DECIMAL_SIGNIFICANT_DIGITS &&
    unitsIndex - firstSignificant < MAX_DECIMAL_INTEGER_DIGITS &&
    unitsIndex - lastSignificant >= -MAX_DECIMAL_EXPONENT
  )
}

function isDecimalNumber(value: number): boolean {
  return Number.isFinite(value) && isDecimalString(String(value))
}

const DECIMAL_VALUE_BRAND = Symbol.for('@open-mercato/shared/DecimalValue')

function invalidDecimal(value: string | number): Error {
  return new Error(`[internal] Invalid decimal value: ${String(value).slice(0, 50)}`)
}

/**
 * An exact decimal number - money, FX rates, quantities, tax rates. Immutable;
 * the decimal library stays hidden behind `./decimalEngine`. Converts to its
 * canonical plain-notation string (`toString`, `toJSON`, `valueOf`), so
 * `String(x)`, `Number(x)` and `JSON.stringify` see the stored representation.
 */
export class DecimalValue {
  readonly #value: EngineDecimal

  private constructor(value: EngineDecimal) {
    this.#value = value
  }

  static from(input: DecimalInput): DecimalValue {
    return new DecimalValue(DecimalValue.#engineOf(input))
  }

  static fromNullable(input: DecimalInput | null | undefined): DecimalValue | null {
    return input === null || input === undefined ? null : DecimalValue.from(input)
  }

  /** `null` for blank, missing or invalid input. */
  static parse(input: unknown): DecimalValue | null {
    if (input === null || input === undefined || input === '') return null
    if (!isDecimalInput(input)) return null
    return DecimalValue.from(input)
  }

  static zero(): DecimalValue {
    return DecimalValue.from(0)
  }

  /** Brand check that also accepts a value created by another copy of this package. */
  static isDecimalValue(value: unknown): value is DecimalValue {
    return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[DECIMAL_VALUE_BRAND] === true
  }

  static #engineOf(input: DecimalInput): EngineDecimal {
    if (input instanceof DecimalValue) return input.#value
    if (typeof input === 'number') {
      if (!isDecimalNumber(input)) throw invalidDecimal(input)
      return parseEngineDecimal(String(input))
    }
    if (typeof input === 'string') {
      const trimmed = input.trim()
      if (!isDecimalString(trimmed)) throw invalidDecimal(input)
      return parseEngineDecimal(trimmed.startsWith('+') ? trimmed.slice(1) : trimmed)
    }
    if (DecimalValue.isDecimalValue(input)) return DecimalValue.#engineOf(String(input))
    throw new Error('[internal] Invalid decimal value')
  }

  plus(other: DecimalInput): DecimalValue {
    return new DecimalValue(engineAdd(this.#value, DecimalValue.#engineOf(other)))
  }

  minus(other: DecimalInput): DecimalValue {
    return new DecimalValue(engineSubtract(this.#value, DecimalValue.#engineOf(other)))
  }

  times(other: DecimalInput): DecimalValue {
    return new DecimalValue(engineMultiply(this.#value, DecimalValue.#engineOf(other)))
  }

  /**
   * Divides with at least `decimalPlaces` decimals and never fewer than
   * MIN_SIGNIFICANT_DIGITS significant digits, so a quotient is never less
   * precise than the same division done on a JS `number`.
   */
  dividedBy(divisor: DecimalInput, decimalPlaces: number = FX_DECIMAL_PLACES): DecimalValue {
    const right = DecimalValue.#engineOf(divisor)
    if (engineCompare(right, ZERO) === 0) throw new Error('[internal] Division by zero')
    if (this.isZero()) return DecimalValue.zero()
    const significantDecimalPlaces = MIN_SIGNIFICANT_DIGITS - (engineMagnitude(this.#value) - engineMagnitude(right))
    return new DecimalValue(engineDivide(this.#value, right, Math.max(decimalPlaces, significantDecimalPlaces, 0)))
  }

  /** Rounds half-up (away from zero) to `decimalPlaces`. */
  round(decimalPlaces: number): DecimalValue {
    return new DecimalValue(engineRound(this.#value, decimalPlaces))
  }

  toSignificantDigits(significantDigits: number): DecimalValue {
    return new DecimalValue(engineRoundToSignificantDigits(this.#value, significantDigits))
  }

  abs(): DecimalValue {
    return new DecimalValue(engineAbs(this.#value))
  }

  negate(): DecimalValue {
    return new DecimalValue(engineNegate(this.#value))
  }

  compare(other: DecimalInput): -1 | 0 | 1 {
    return engineCompare(this.#value, DecimalValue.#engineOf(other))
  }

  equals(other: DecimalInput): boolean {
    return this.compare(other) === 0
  }

  lt(other: DecimalInput): boolean {
    return this.compare(other) < 0
  }

  lte(other: DecimalInput): boolean {
    return this.compare(other) <= 0
  }

  gt(other: DecimalInput): boolean {
    return this.compare(other) > 0
  }

  gte(other: DecimalInput): boolean {
    return this.compare(other) >= 0
  }

  isZero(): boolean {
    return engineCompare(this.#value, ZERO) === 0
  }

  isNegative(): boolean {
    return engineCompare(this.#value, ZERO) < 0
  }

  isPositive(): boolean {
    return engineCompare(this.#value, ZERO) > 0
  }

  decimalPlaces(): number {
    const fraction = this.toString().split('.')[1]
    return fraction ? fraction.length : 0
  }

  /** Rounds half-up to `decimalPlaces` and pads with zeros to exactly that many decimals. */
  toFixed(decimalPlaces: number): string {
    return engineToFixed(this.#value, decimalPlaces)
  }

  toNumber(): number {
    return Number(this.toString())
  }

  toString(): string {
    return engineToString(this.#value)
  }

  toJSON(): string {
    return this.toString()
  }

  valueOf(): string {
    return this.toString()
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `DecimalValue(${this.toString()})`
  }
}

Object.defineProperty(DecimalValue.prototype, DECIMAL_VALUE_BRAND, { value: true })

const ZERO = parseEngineDecimal('0')

export function isDecimalInput(value: unknown): value is DecimalInput {
  if (typeof value === 'number') return isDecimalNumber(value)
  if (typeof value === 'string') return isDecimalString(value.trim())
  return DecimalValue.isDecimalValue(value)
}

export function toDecimal(value: DecimalInput): DecimalValue {
  return DecimalValue.from(value)
}

export function parseDecimal(value: unknown): DecimalValue | null {
  return DecimalValue.parse(value)
}

export function decimalToString(value: DecimalInput): string {
  return toDecimal(value).toString()
}

export function addDecimals(left: DecimalInput, right: DecimalInput): DecimalValue {
  return toDecimal(left).plus(right)
}

export function subtractDecimals(left: DecimalInput, right: DecimalInput): DecimalValue {
  return toDecimal(left).minus(right)
}

export function multiplyDecimals(left: DecimalInput, right: DecimalInput): DecimalValue {
  return toDecimal(left).times(right)
}

export function sumDecimals(values: DecimalInput[]): DecimalValue {
  return values.reduce<DecimalValue>((total, value) => total.plus(value), DecimalValue.zero())
}

/** See `DecimalValue.dividedBy`. */
export function divideDecimals(
  dividend: DecimalInput,
  divisor: DecimalInput,
  decimalPlaces: number = FX_DECIMAL_PLACES,
): DecimalValue {
  return toDecimal(dividend).dividedBy(divisor, decimalPlaces)
}

export function roundDecimal(value: DecimalInput, decimalPlaces: number): DecimalValue {
  return toDecimal(value).round(decimalPlaces)
}

export function compareDecimals(left: DecimalInput, right: DecimalInput): -1 | 0 | 1 {
  return toDecimal(left).compare(right)
}

export function decimalsEqual(left: DecimalInput, right: DecimalInput): boolean {
  return compareDecimals(left, right) === 0
}

export function isZeroDecimal(value: DecimalInput): boolean {
  return toDecimal(value).isZero()
}

export function isNegativeDecimal(value: DecimalInput): boolean {
  return toDecimal(value).isNegative()
}

export function absDecimal(value: DecimalInput): DecimalValue {
  return toDecimal(value).abs()
}

export function negateDecimal(value: DecimalInput): DecimalValue {
  return toDecimal(value).negate()
}

export function minDecimal(...values: DecimalInput[]): DecimalValue {
  return values.map(toDecimal).reduce((lowest, value) => (value.lt(lowest) ? value : lowest))
}

export function maxDecimal(...values: DecimalInput[]): DecimalValue {
  return values.map(toDecimal).reduce((highest, value) => (value.gt(highest) ? value : highest))
}

export function countDecimalPlaces(value: DecimalInput): number {
  return toDecimal(value).decimalPlaces()
}

/** Plain decimal string with at least `minDecimalPlaces` decimals (`12.5` -> `12.50`), never cut. */
export function padDecimalPlaces(value: DecimalInput, minDecimalPlaces: number): string {
  const decimal = toDecimal(value)
  return decimal.toFixed(Math.max(minDecimalPlaces, decimal.decimalPlaces()))
}

export function decimalToNumber(value: DecimalInput): number {
  return toDecimal(value).toNumber()
}

/**
 * Whether `exact` is the decimal the validated `legacy` number stands for. A value
 * that underflows to zero (`-1e-400`) must itself be zero, so it cannot slip past
 * a sign or range check made on the number.
 */
function matchesLegacyNumber(exact: DecimalValue, legacy: number): boolean {
  if (decimalToNumber(exact) !== legacy) return false
  return legacy !== 0 || exact.isZero()
}

/**
 * Picks the exact decimal string for a dual `number` + `<field>Exact` pair.
 * The exact value wins unless the legacy `number` was changed on its own
 * (e.g. by a hook unaware of the exact field) - then the number is used.
 */
export function resolveExactDecimal(exact: unknown, legacy: unknown): string | null {
  const exactDecimal = parseDecimal(exact)
  const legacyDecimal = parseDecimal(legacy)
  if (exactDecimal && (typeof legacy !== 'number' || matchesLegacyNumber(exactDecimal, legacy))) {
    return decimalToString(exactDecimal)
  }
  return legacyDecimal ? decimalToString(legacyDecimal) : null
}

export type WithExactAmounts<T, K extends string> = T & { [P in K as `${P}Exact`]?: string | null }

function exactCandidate(source: Record<string, unknown>, field: string, value: unknown): unknown {
  if (typeof value !== 'number') return value
  const rawValue = source[field]
  return typeof rawValue === 'number' ? source[`${field}Exact`] ?? rawValue : rawValue
}

/**
 * Adds `<field>Exact` strings next to number fields a zod schema coerced, taken
 * from the raw input so digits beyond float precision survive the parse. When the
 * raw field is already a number (an API route parsed the body before the command),
 * the `<field>Exact` string that route attached is used instead, and only while it
 * matches that number. A parsed `null` (or a parsed non-number) is never paired
 * with a raw value, so it cannot smuggle unvalidated input past the schema.
 */
export function withExactAmounts<T extends object, K extends string>(
  parsed: T,
  raw: unknown,
  fields: readonly K[],
): WithExactAmounts<T, K> {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const values = parsed as Record<string, unknown>
  const exact: Record<string, string | null> = {}
  for (const field of fields) {
    const value = values[field]
    if (value === undefined) continue
    exact[`${field}Exact`] = resolveExactDecimal(exactCandidate(source, field, value), value)
  }
  return { ...parsed, ...exact } as WithExactAmounts<T, K>
}

/**
 * Applies `withExactAmounts` to each item of the `key` list, pairing parsed and raw
 * items by index. Lets an API route keep exact digits for nested lines.
 */
export function withExactListAmounts<T extends object, K extends string>(
  parsedItems: readonly T[] | null | undefined,
  raw: unknown,
  key: string,
  fields: readonly K[],
): WithExactAmounts<T, K>[] | undefined {
  if (!parsedItems) return undefined
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined
  const rawItems = Array.isArray(source) ? source : []
  return parsedItems.map((item, index) => withExactAmounts(item, rawItems[index], fields))
}

/**
 * Tolerance for comparing money amounts rounded to `decimalPlaces`: half a
 * minor unit of a 2-decimal currency at the default 4 places (0.005), scaled
 * down with higher precision and never wider than that default.
 */
export function amountComparisonTolerance(decimalPlaces: number = DEFAULT_AMOUNT_DECIMAL_PLACES): DecimalValue {
  return toDecimal(`5e-${Math.max(decimalPlaces, DEFAULT_AMOUNT_DECIMAL_PLACES) - 1}`)
}

export function resolveAmountDecimalPlaces(currencyDecimalPlaces?: number | null): number {
  if (typeof currencyDecimalPlaces !== 'number' || !Number.isInteger(currencyDecimalPlaces) || currencyDecimalPlaces < 0) {
    return DEFAULT_AMOUNT_DECIMAL_PLACES
  }
  return Math.max(DEFAULT_AMOUNT_DECIMAL_PLACES, currencyDecimalPlaces)
}

let isoCurrencyCodes: Set<string> | null | undefined

function resolveIsoCurrencyCodes(): Set<string> | null {
  if (isoCurrencyCodes !== undefined) return isoCurrencyCodes
  try {
    isoCurrencyCodes = typeof Intl.supportedValuesOf === 'function' ? new Set(Intl.supportedValuesOf('currency')) : null
  } catch {
    isoCurrencyCodes = null
  }
  return isoCurrencyCodes
}

/**
 * Decimal places `Intl.NumberFormat` displays for `currencyCode`, or `null` when
 * the runtime does not know the code. These are CLDR display digits, not ISO 4217
 * minor units (HUF, COP and IDR display 0 digits but have 2 minor units), and may
 * change with the ICU version, so use them to format amounts, never to validate
 * or round stored ones. `Intl.NumberFormat` accepts any well-formed code (ETH,
 * XYZ) and reports 2 digits for it, so only codes listed by
 * `Intl.supportedValuesOf` count.
 */
export function resolveCurrencyDisplayDecimalPlaces(currencyCode?: string | null): number | null {
  if (!currencyCode) return null
  const code = currencyCode.toUpperCase()
  const knownCodes = resolveIsoCurrencyCodes()
  if (knownCodes && !knownCodes.has(code)) return null
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits ?? null
  } catch {
    return null
  }
}

/**
 * ISO 4217 minor units (decimal places) of `currencyCode`, read from a static table
 * of every ISO 4217 code so the result does not depend on the ICU version. `null`
 * when ISO defines no minor unit (N.A. or withdrawn codes) or the code is not ISO
 * 4217; a non-ISO code the runtime supports falls back to its `Intl` digits.
 */
export function resolveIsoCurrencyDecimalPlaces(currencyCode?: string | null): number | null {
  if (!currencyCode) return null
  const code = currencyCode.toUpperCase()
  if (Object.hasOwn(ISO_4217_MINOR_UNITS, code)) return ISO_4217_MINOR_UNITS[code]
  return resolveCurrencyDisplayDecimalPlaces(code)
}

/**
 * Whether a raw money input may reach a number-coercing schema: blank strings and
 * non-numeric values are left to that schema, numbers and strings must be decimals
 * within the size caps, so an oversized value is rejected instead of turning into 0.
 */
export function isWithinDecimalCaps(value: unknown): boolean {
  if (typeof value === 'string' && value.trim().length === 0) return true
  if (typeof value !== 'string' && typeof value !== 'number') return true
  return isDecimalInput(value)
}

export function withDecimalCaps<T extends z.ZodType>(schema: T, message?: string) {
  return z.unknown().refine(isWithinDecimalCaps, message === undefined ? undefined : { message }).pipe(schema)
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
  (value) => toDecimal(value).isPositive(),
  { message: 'decimalMustBePositive' },
)
