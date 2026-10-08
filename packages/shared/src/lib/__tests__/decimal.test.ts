import {
  addDecimals,
  compareDecimals,
  decimalStringSchema,
  decimalToString,
  divideDecimals,
  maxDecimal,
  minDecimal,
  multiplyDecimals,
  nonNegativeDecimalStringSchema,
  padDecimalPlaces,
  parseDecimal,
  positiveDecimalStringSchema,
  resolveAmountDecimalPlaces,
  resolveExactDecimal,
  resolveIsoCurrencyDecimalPlaces,
  roundDecimal,
  subtractDecimals,
  sumDecimals,
  toDecimal,
  withExactAmounts,
  withExactListAmounts,
} from '../decimal'

describe('decimal', () => {
  it('adds without float drift', () => {
    expect(decimalToString(addDecimals('0.1', '0.2'))).toBe('0.3')
    expect(decimalToString(addDecimals(0.1, 0.2))).toBe('0.3')
  })

  it('keeps 18+ decimal places exactly', () => {
    const wei = '0.000000000000000001'
    expect(decimalToString(multiplyDecimals(wei, 3))).toBe('0.000000000000000003')
    expect(decimalToString(addDecimals('123456789012345678901234567890', wei))).toBe(
      '123456789012345678901234567890.000000000000000001',
    )
    expect(decimalToString(subtractDecimals('1', '0.0000000000000000000000000001'))).toBe(
      '0.9999999999999999999999999999',
    )
  })

  it('never outputs exponent notation or padding', () => {
    expect(decimalToString('1e-7')).toBe('0.0000001')
    expect(decimalToString(1e21)).toBe('1000000000000000000000')
    expect(decimalToString('40.0000')).toBe('40')
    expect(decimalToString('-0')).toBe('0')
    expect(decimalToString(' +12.50 ')).toBe('12.5')
  })

  it('divides with at least the requested decimal places', () => {
    expect(decimalToString(divideDecimals(1, 3, 20))).toBe('0.33333333333333333333')
    expect(decimalToString(divideDecimals(10, 4, 4))).toBe('2.5')
  })

  it('keeps at least 17 significant digits in a quotient', () => {
    const quotient = decimalToString(divideDecimals('1', '30000000000000000000000000000000000000000000000000000000000', 4))
    const significant = quotient.replace(/^0\.0*/, '')
    expect(significant.length).toBeGreaterThanOrEqual(17)
    expect(divideDecimals('1', '7', 0).toFixed().replace('.', '').length).toBeGreaterThanOrEqual(17)
  })

  it('rejects division by zero', () => {
    expect(() => divideDecimals(1, 0)).toThrow()
  })

  it('rounds half away from zero', () => {
    expect(decimalToString(roundDecimal('2.5', 0))).toBe('3')
    expect(decimalToString(roundDecimal('-2.5', 0))).toBe('-3')
    expect(decimalToString(roundDecimal('1.23455', 4))).toBe('1.2346')
  })

  it('compares, sums and picks extremes', () => {
    expect(compareDecimals('1.10', '1.1')).toBe(0)
    expect(compareDecimals('0.000000000000000002', '0.000000000000000001')).toBe(1)
    expect(decimalToString(sumDecimals(['0.1', '0.2', 0.3]))).toBe('0.6')
    expect(decimalToString(sumDecimals([]))).toBe('0')
    expect(decimalToString(minDecimal('3', '-1', '2'))).toBe('-1')
    expect(decimalToString(maxDecimal('3', '-1', '2'))).toBe('3')
  })

  it('rejects exponents that would expand into huge strings', () => {
    expect(parseDecimal('1e-100000000')).toBeNull()
    expect(parseDecimal('1e100000000')).toBeNull()
    expect(() => toDecimal('1e-1001')).toThrow()
    expect(decimalStringSchema.safeParse('1e-100000000').success).toBe(false)
    expect(decimalToString('1e-20')).toBe('0.00000000000000000001')
  })

  it('parses loosely and validates strictly', () => {
    expect(parseDecimal(null)).toBeNull()
    expect(parseDecimal('')).toBeNull()
    expect(parseDecimal('abc')).toBeNull()
    expect(parseDecimal(Number.NaN)).toBeNull()
    expect(decimalToString(parseDecimal('12.3400')!)).toBe('12.34')
    expect(() => toDecimal('1,5')).toThrow()
    expect(() => toDecimal(Number.POSITIVE_INFINITY)).toThrow()
  })

  it('pads to a minimum number of decimals without cutting digits', () => {
    expect(padDecimalPlaces('12.5', 2)).toBe('12.50')
    expect(padDecimalPlaces('12', 0)).toBe('12')
    expect(padDecimalPlaces('0.000000000000000001', 2)).toBe('0.000000000000000001')
  })

  it('resolves amount precision with a 4 decimal floor', () => {
    expect(resolveAmountDecimalPlaces(2)).toBe(4)
    expect(resolveAmountDecimalPlaces(8)).toBe(8)
    expect(resolveAmountDecimalPlaces(18)).toBe(18)
    expect(resolveAmountDecimalPlaces(null)).toBe(4)
    expect(resolveAmountDecimalPlaces(-1)).toBe(4)
  })

  it('resolves ISO currency digits', () => {
    expect(resolveIsoCurrencyDecimalPlaces('USD')).toBe(2)
    expect(resolveIsoCurrencyDecimalPlaces('JPY')).toBe(0)
    expect(resolveIsoCurrencyDecimalPlaces(null)).toBeNull()
  })

  it('validates decimal strings with zod', () => {
    expect(decimalStringSchema.parse(12.5)).toBe('12.5')
    expect(decimalStringSchema.parse('0.000000000000000000000001')).toBe('0.000000000000000000000001')
    expect(decimalStringSchema.safeParse('abc').success).toBe(false)
    expect(decimalStringSchema.safeParse(Number.NaN).success).toBe(false)
    expect(nonNegativeDecimalStringSchema.safeParse('-1').success).toBe(false)
    expect(nonNegativeDecimalStringSchema.parse('0')).toBe('0')
    expect(positiveDecimalStringSchema.safeParse('0').success).toBe(false)
    expect(positiveDecimalStringSchema.parse('0.1')).toBe('0.1')
  })
})

describe('resolveExactDecimal', () => {
  it('prefers the exact string while the legacy number still matches it', () => {
    expect(resolveExactDecimal('0.000000000000000000123', 1.23e-19)).toBe('0.000000000000000000123')
    expect(resolveExactDecimal('12345678901234567890.1', Number('12345678901234567890.1'))).toBe('12345678901234567890.1')
  })

  it('falls back to the legacy number once it was changed on its own', () => {
    expect(resolveExactDecimal('10.123456789', 12)).toBe('12')
  })

  it('rejects exact values that underflow to zero', () => {
    expect(resolveExactDecimal('-1e-400', -0)).toBe('0')
    expect(resolveExactDecimal('1e-400', 0)).toBe('0')
    expect(resolveExactDecimal('0.000', 0)).toBe('0')
  })

  it('handles missing values', () => {
    expect(resolveExactDecimal(null, 5)).toBe('5')
    expect(resolveExactDecimal('7.5', undefined)).toBe('7.5')
    expect(resolveExactDecimal(undefined, null)).toBeNull()
    expect(resolveExactDecimal('abc', 'def')).toBeNull()
  })
})

describe('withExactAmounts', () => {
  it('keeps raw string digits next to the coerced numbers', () => {
    const raw = { amount: '0.123456789012345678901', other: 'x', fee: 5 }
    const parsed = { amount: Number(raw.amount), other: 'x', fee: 5, missing: undefined as number | undefined }
    const result = withExactAmounts(parsed, raw, ['amount', 'fee', 'missing'] as const)
    expect(result.amountExact).toBe('0.123456789012345678901')
    expect(result.feeExact).toBe('5')
    expect('missingExact' in result).toBe(false)
    expect(result.amount).toBe(parsed.amount)
  })

  it('reads the exact string a route attached once the raw field is a number', () => {
    const exactValue = '0.123456789012345678901'
    const routeOutput = { amount: Number(exactValue), amountExact: exactValue }
    const result = withExactAmounts({ amount: Number(exactValue) }, routeOutput, ['amount'] as const)
    expect(result.amountExact).toBe(exactValue)
  })

  it('ignores an attached exact string that does not match the number', () => {
    const result = withExactAmounts({ amount: 12 }, { amount: 12, amountExact: '99.5' }, ['amount'] as const)
    expect(result.amountExact).toBe('12')
  })
})

describe('withExactListAmounts', () => {
  it('pairs parsed and raw list items by index', () => {
    const raw = { lines: [{ price: '1.000000000000000001' }, { price: 2 }] }
    const parsed = [{ price: Number('1.000000000000000001') }, { price: 2 }]
    const result = withExactListAmounts(parsed, raw, 'lines', ['price'] as const)
    expect(result?.map((line) => line.priceExact)).toEqual(['1.000000000000000001', '2'])
    expect(withExactListAmounts(undefined, raw, 'lines', ['price'] as const)).toBeUndefined()
  })
})
