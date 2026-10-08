import {
  autoFillOppositeAmount,
  formatMoney,
  grossFromNet,
  netFromGross,
  resolveLineDiscountDisplay,
  resolveAutoFillDecimalPlaces,
  resolveMoneyDecimalPlaces,
  roundAutoFilledAmount,
  roundMoney,
  toExactAmount,
} from '../lineItemUtils'

describe('resolveLineDiscountDisplay', () => {
  it('returns null when neither a discount amount nor a percentage is recorded', () => {
    expect(resolveLineDiscountDisplay({ discountAmount: 0, discountPercent: 0, unitPriceNet: 10, quantity: 3 })).toBeNull()
    expect(resolveLineDiscountDisplay({ unitPriceNet: 10, quantity: 3 })).toBeNull()
    expect(resolveLineDiscountDisplay({})).toBeNull()
  })

  it('treats absent and zero alike, and ignores negative values', () => {
    expect(resolveLineDiscountDisplay({ discountAmount: undefined, discountPercent: undefined })).toBeNull()
    expect(resolveLineDiscountDisplay({ discountAmount: null, discountPercent: null })).toBeNull()
    expect(resolveLineDiscountDisplay({ discountAmount: -5, discountPercent: -10 })).toBeNull()
  })

  it('reads numeric strings, which is how the numeric columns arrive on some drivers', () => {
    expect(
      resolveLineDiscountDisplay({
        discountAmount: '4.5000',
        discountPercent: '15.0000',
        unitPriceNet: '10.0000',
        quantity: '3',
      }),
    ).toEqual({ amount: 4.5, percent: 15 })
  })

  it('shows the amount alone when no percentage is recorded', () => {
    expect(
      resolveLineDiscountDisplay({ discountAmount: 4.5, discountPercent: 0, unitPriceNet: 10, quantity: 3 }),
    ).toEqual({ amount: 4.5, percent: null })
  })

  it('shows the percentage alongside the amount when it accounts for that amount', () => {
    expect(
      resolveLineDiscountDisplay({ discountAmount: 4.5, discountPercent: 15, unitPriceNet: 10, quantity: 3 }),
    ).toEqual({ amount: 4.5, percent: 15 })
  })

  it('suppresses the percentage when it does not account for the amount', () => {
    // discountAmount 5 was supplied per unit, so 15.00 is persisted for a 3 × 10.00 line
    // while discount_percent stays the raw 15 — 15% of that line is 4.50, not 15.00.
    expect(
      resolveLineDiscountDisplay({ discountAmount: 15, discountPercent: 15, unitPriceNet: 10, quantity: 3 }),
    ).toEqual({ amount: 15, percent: null })
  })

  it('suppresses the percentage when the line net cannot be reconstructed', () => {
    expect(resolveLineDiscountDisplay({ discountAmount: 4.5, discountPercent: 15 })).toEqual({
      amount: 4.5,
      percent: null,
    })
    expect(
      resolveLineDiscountDisplay({ discountAmount: 4.5, discountPercent: 15, unitPriceNet: 10, quantity: 0 }),
    ).toEqual({ amount: 4.5, percent: null })
  })

  it('absorbs per-unit rounding on large quantities instead of suppressing a valid percentage', () => {
    // 7% of 1000 × 0.4999 (a unit price rounded for storage) is 34.993, not the
    // persisted 35 — a percentage-driven line must not lose its percentage to that.
    expect(
      resolveLineDiscountDisplay({ discountAmount: 35, discountPercent: 7, unitPriceNet: 0.4999, quantity: 1000 }),
    ).toEqual({ amount: 35, percent: 7 })
  })

  it('shows the percentage as the primary value when no amount was resolved', () => {
    expect(
      resolveLineDiscountDisplay({ discountAmount: 0, discountPercent: 10, unitPriceNet: 100, quantity: 2 }),
    ).toEqual({ amount: null, percent: 10 })
  })
})

describe('exact money helpers', () => {
  it('formats a decimal string without passing it through a float', () => {
    expect(formatMoney('12345678901234567.89', 'USD', 'en-US')).toBe('$12,345,678,901,234,567.89')
    expect(formatMoney(110.7, 'USD', 'en-US')).toBe('$110.70')
    expect(formatMoney('0.123456789012345678', 'USD', 'en-US', 18)).toBe('$0.123456789012345678')
  })

  it('keeps two decimals without a currency, like before', () => {
    expect(formatMoney(110.7, null)).toBe('110.70')
    expect(formatMoney('1.005', undefined)).toBe('1.01')
  })

  it('reads amounts as exact decimal strings', () => {
    expect(toExactAmount('110.7000')).toBe('110.7')
    expect(toExactAmount(' 0.000000000000000001 ')).toBe('0.000000000000000001')
    expect(toExactAmount(12.5)).toBe('12.5')
    expect(toExactAmount('abc')).toBeNull()
    expect(toExactAmount(Number.NaN)).toBeNull()
    expect(toExactAmount(null)).toBeNull()
  })

  it('rounds to 4 decimals unless the source carries more', () => {
    expect(resolveMoneyDecimalPlaces('12.5')).toBe(4)
    expect(resolveMoneyDecimalPlaces('0.000000000000000001')).toBe(18)
    expect(roundMoney('81.30081300813')).toBe('81.3008')
    expect(roundMoney('0.00005')).toBe('0.0001')
  })

  it('converts between net and gross with exact decimal math', () => {
    expect(grossFromNet('90', 23)).toBe('110.7')
    expect(netFromGross('110.7', 23)).toBe('90')
    expect(grossFromNet('0.000000000000000001', 0)).toBe('0.000000000000000001')
    expect(netFromGross('100', 23)).toBe('81.3008')
    expect(grossFromNet('10.1234', 23)).toBe('12.4518')
    expect(netFromGross('1.230000000000000001', 23)).toBe('1.000000000000000001')
    expect(netFromGross('100', null)).toBe('100')
  })
})

describe('auto-filled dialog amounts', () => {
  it('rounds to the currency digits unless the typed source carries more', () => {
    expect(resolveAutoFillDecimalPlaces('USD', '10.01')).toBe(2)
    expect(resolveAutoFillDecimalPlaces('USD', '10.0001')).toBe(4)
    expect(resolveAutoFillDecimalPlaces('JPY', '100')).toBe(0)
    expect(resolveAutoFillDecimalPlaces('ETH', '1.5')).toBe(2)
    expect(resolveAutoFillDecimalPlaces('ETH', '0.000000000000000001')).toBe(18)
    expect(resolveAutoFillDecimalPlaces(null, '7')).toBe(2)
  })

  it('fills the opposite of a typed net or gross amount at the currency precision', () => {
    expect(autoFillOppositeAmount('net', '10.01', 23, 'USD')).toBe('12.31')
    expect(autoFillOppositeAmount('gross', '12.31', 23, 'USD')).toBe('10.01')
    expect(autoFillOppositeAmount('net', '10', 23, 'USD')).toBe('12.30')
    expect(autoFillOppositeAmount('net', '1000', 23, 'JPY')).toBe('1230')
    expect(autoFillOppositeAmount('net', '10.0001', 23, 'USD')).toBe('12.3001')
    expect(autoFillOppositeAmount('net', '0.000000000000000001', 23, 'ETH')).toBe('0.000000000000000001')
    expect(autoFillOppositeAmount('net', '10.01', null, 'USD')).toBe('10.01')
  })

  it('rounds the exact value once instead of rounding a 4 decimal intermediate', () => {
    expect(grossFromNet('0.09', 5.5)).toBe('0.095')
    expect(autoFillOppositeAmount('net', '0.09', 5.5, 'USD')).toBe('0.09')
  })

  it('rounds a shipping amount from a fractional quantity to cents', () => {
    expect(roundAutoFilledAmount('15.015', 'USD', '10.01')).toBe('15.02')
    expect(roundAutoFilledAmount('20.02', 'USD', '10.01')).toBe('20.02')
  })
})
