import BigConstructor from 'big.js'
import type { Big } from 'big.js'

/**
 * The only module allowed to import the decimal library. Everything else works
 * with `DecimalValue` from `./decimal`, so replacing the library means rewriting
 * this adapter while keeping the semantics below: exact add/subtract/multiply,
 * division cut to a number of decimal places, half-up rounding, and plain
 * notation without an exponent.
 */

declare const engineDecimalBrand: unique symbol

export type EngineDecimal = { readonly [engineDecimalBrand]: true }

const ROUND_HALF_UP = 1

const Engine = BigConstructor()
Engine.RM = ROUND_HALF_UP

function unwrap(value: EngineDecimal): Big {
  return value as unknown as Big
}

function wrap(value: Big): EngineDecimal {
  return value as unknown as EngineDecimal
}

/** Parses a decimal string the caller has already validated. */
export function parseEngineDecimal(text: string): EngineDecimal {
  return wrap(new Engine(text))
}

export function engineToString(value: EngineDecimal): string {
  return unwrap(value).toFixed()
}

/** Rounds half-up to `decimalPlaces` and pads with zeros to exactly that many decimals. */
export function engineToFixed(value: EngineDecimal, decimalPlaces: number): string {
  return unwrap(value).toFixed(decimalPlaces, ROUND_HALF_UP)
}

export function engineAdd(left: EngineDecimal, right: EngineDecimal): EngineDecimal {
  return wrap(unwrap(left).plus(unwrap(right)))
}

export function engineSubtract(left: EngineDecimal, right: EngineDecimal): EngineDecimal {
  return wrap(unwrap(left).minus(unwrap(right)))
}

export function engineMultiply(left: EngineDecimal, right: EngineDecimal): EngineDecimal {
  return wrap(unwrap(left).times(unwrap(right)))
}

/** Quotient cut to `decimalPlaces` decimals, rounded half-up. The divisor must not be zero. */
export function engineDivide(left: EngineDecimal, right: EngineDecimal, decimalPlaces: number): EngineDecimal {
  const previousDecimalPlaces = Engine.DP
  Engine.DP = decimalPlaces
  try {
    return wrap(unwrap(left).div(unwrap(right)))
  } finally {
    Engine.DP = previousDecimalPlaces
  }
}

export function engineRound(value: EngineDecimal, decimalPlaces: number): EngineDecimal {
  return wrap(unwrap(value).round(decimalPlaces, ROUND_HALF_UP))
}

export function engineRoundToSignificantDigits(value: EngineDecimal, significantDigits: number): EngineDecimal {
  return wrap(unwrap(value).prec(significantDigits, ROUND_HALF_UP))
}

export function engineCompare(left: EngineDecimal, right: EngineDecimal): -1 | 0 | 1 {
  return unwrap(left).cmp(unwrap(right)) as -1 | 0 | 1
}

/** Power of ten of the leading digit (`123.4` -> 2, `0.05` -> -2); 0 for zero. */
export function engineMagnitude(value: EngineDecimal): number {
  return unwrap(value).e
}

export function engineAbs(value: EngineDecimal): EngineDecimal {
  return wrap(unwrap(value).abs())
}

export function engineNegate(value: EngineDecimal): EngineDecimal {
  return wrap(unwrap(value).neg())
}
