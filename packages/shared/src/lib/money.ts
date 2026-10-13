import {
  DecimalValue,
  resolveAmountDecimalPlaces,
  resolveIsoCurrencyDecimalPlaces,
  type DecimalInput,
} from './decimal'

export type MoneyJson = {
  amount: string
  currencyCode: string
}

function normalizeCurrencyCode(currencyCode: string): string {
  const code = currencyCode.trim().toUpperCase()
  if (!code) throw new Error('[internal] Money requires a currency code')
  return code
}

function normalizeDecimalPlaces(decimalPlaces: number | null | undefined, currencyCode: string): number {
  if (decimalPlaces === null || decimalPlaces === undefined) {
    return resolveAmountDecimalPlaces(resolveIsoCurrencyDecimalPlaces(currencyCode))
  }
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
    throw new Error(`[internal] Invalid money precision: ${decimalPlaces}`)
  }
  return decimalPlaces
}

/**
 * An exact amount in one currency. `decimalPlaces` is the precision `dividedBy`
 * and `round()` round to; addition, subtraction, multiplication and conversion
 * stay exact. Arithmetic across currencies throws.
 */
export class MoneyValue {
  readonly amount: DecimalValue
  readonly currencyCode: string
  readonly decimalPlaces: number

  private constructor(amount: DecimalValue, currencyCode: string, decimalPlaces: number) {
    this.amount = amount
    this.currencyCode = currencyCode
    this.decimalPlaces = decimalPlaces
  }

  /**
   * `decimalPlaces` defaults to `max(4, ISO 4217 minor units)`. Pass
   * `resolveAmountDecimalPlaces(currency.decimalPlaces)` for a configured currency.
   */
  static of(amount: DecimalInput, currencyCode: string, decimalPlaces?: number | null): MoneyValue {
    const code = normalizeCurrencyCode(currencyCode)
    return new MoneyValue(DecimalValue.from(amount), code, normalizeDecimalPlaces(decimalPlaces, code))
  }

  static zero(currencyCode: string, decimalPlaces?: number | null): MoneyValue {
    return MoneyValue.of(0, currencyCode, decimalPlaces)
  }

  static sum(values: readonly MoneyValue[], currencyCode: string, decimalPlaces?: number | null): MoneyValue {
    return values.reduce((total, value) => total.plus(value), MoneyValue.zero(currencyCode, decimalPlaces))
  }

  #with(amount: DecimalValue, decimalPlaces: number = this.decimalPlaces): MoneyValue {
    return new MoneyValue(amount, this.currencyCode, decimalPlaces)
  }

  #assertSameCurrency(other: MoneyValue): void {
    if (other.currencyCode !== this.currencyCode) {
      throw new Error(`[internal] Currency mismatch: ${this.currencyCode} and ${other.currencyCode}`)
    }
  }

  isSameCurrency(other: MoneyValue): boolean {
    return other.currencyCode === this.currencyCode
  }

  plus(other: MoneyValue): MoneyValue {
    this.#assertSameCurrency(other)
    return this.#with(this.amount.plus(other.amount), Math.max(this.decimalPlaces, other.decimalPlaces))
  }

  minus(other: MoneyValue): MoneyValue {
    this.#assertSameCurrency(other)
    return this.#with(this.amount.minus(other.amount), Math.max(this.decimalPlaces, other.decimalPlaces))
  }

  times(factor: DecimalInput): MoneyValue {
    return this.#with(this.amount.times(factor))
  }

  dividedBy(divisor: DecimalInput): MoneyValue {
    return this.#with(this.amount.dividedBy(divisor, this.decimalPlaces).round(this.decimalPlaces))
  }

  round(): MoneyValue {
    return this.#with(this.amount.round(this.decimalPlaces))
  }

  /** Converts with `rate` (units of `currencyCode` per unit of this currency). Exact; `round()` before storing. */
  convert(rate: DecimalInput, currencyCode: string, decimalPlaces?: number | null): MoneyValue {
    return MoneyValue.of(this.amount.times(rate), currencyCode, decimalPlaces)
  }

  compare(other: MoneyValue): -1 | 0 | 1 {
    this.#assertSameCurrency(other)
    return this.amount.compare(other.amount)
  }

  equals(other: MoneyValue): boolean {
    return this.compare(other) === 0
  }

  lt(other: MoneyValue): boolean {
    return this.compare(other) < 0
  }

  lte(other: MoneyValue): boolean {
    return this.compare(other) <= 0
  }

  gt(other: MoneyValue): boolean {
    return this.compare(other) > 0
  }

  gte(other: MoneyValue): boolean {
    return this.compare(other) >= 0
  }

  isZero(): boolean {
    return this.amount.isZero()
  }

  isNegative(): boolean {
    return this.amount.isNegative()
  }

  isPositive(): boolean {
    return this.amount.isPositive()
  }

  abs(): MoneyValue {
    return this.#with(this.amount.abs())
  }

  negate(): MoneyValue {
    return this.#with(this.amount.negate())
  }

  toJSON(): MoneyJson {
    return { amount: this.amount.toString(), currencyCode: this.currencyCode }
  }

  toString(): string {
    return `${this.amount.toString()} ${this.currencyCode}`
  }
}
