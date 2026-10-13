import { DecimalValue } from '../decimal'
import { MoneyValue } from '../money'

describe('MoneyValue', () => {
  it('defaults the precision to max(4, ISO minor units)', () => {
    expect(MoneyValue.of('1', 'usd').decimalPlaces).toBe(4)
    expect(MoneyValue.of('1', 'USD').currencyCode).toBe('USD')
    expect(MoneyValue.of('1', 'ETH').decimalPlaces).toBe(4)
    expect(MoneyValue.of('1', 'ETH', 18).decimalPlaces).toBe(18)
  })

  it('adds, subtracts and multiplies exactly', () => {
    const price = MoneyValue.of('0.000000000000000001', 'ETH', 18)
    const total = price.times(3).plus(price).minus(MoneyValue.of('0.000000000000000002', 'ETH', 18))
    expect(total.amount.toString()).toBe('0.000000000000000002')
    expect(MoneyValue.of('0.1', 'USD').plus(MoneyValue.of('0.2', 'USD')).amount.toString()).toBe('0.3')
  })

  it('rounds division and conversion to the money precision', () => {
    expect(MoneyValue.of('100', 'USD').dividedBy('3').amount.toString()).toBe('33.3333')
    expect(MoneyValue.of('100', 'USD', 2).dividedBy('3').amount.toString()).toBe('33.33')
    const converted = MoneyValue.of('10', 'USD').convert('3.987654321', 'PLN', 2)
    expect(converted.currencyCode).toBe('PLN')
    expect(converted.amount.toString()).toBe('39.88')
    expect(MoneyValue.of('2.345', 'USD', 2).round().amount.toString()).toBe('2.35')
  })

  it('refuses arithmetic and comparison across currencies', () => {
    const usd = MoneyValue.of('1', 'USD')
    const eur = MoneyValue.of('1', 'EUR')
    expect(() => usd.plus(eur)).toThrow('[internal] Currency mismatch: USD and EUR')
    expect(() => usd.minus(eur)).toThrow('[internal] Currency mismatch')
    expect(() => usd.compare(eur)).toThrow('[internal] Currency mismatch')
    expect(usd.isSameCurrency(eur)).toBe(false)
  })

  it('compares and inspects amounts', () => {
    const small = MoneyValue.of('1.5', 'USD')
    const large = MoneyValue.of('2', 'USD')
    expect(small.lt(large)).toBe(true)
    expect(small.lte(small)).toBe(true)
    expect(large.gt(small)).toBe(true)
    expect(large.gte(large)).toBe(true)
    expect(small.equals(MoneyValue.of('1.50', 'USD'))).toBe(true)
    expect(MoneyValue.zero('USD').isZero()).toBe(true)
    expect(small.negate().isNegative()).toBe(true)
    expect(small.negate().abs().isPositive()).toBe(true)
  })

  it('sums a list in one currency', () => {
    const values = ['1.1', '2.2', '3.3'].map((amount) => MoneyValue.of(amount, 'USD'))
    expect(MoneyValue.sum(values, 'USD').amount.toString()).toBe('6.6')
    expect(MoneyValue.sum([], 'USD').isZero()).toBe(true)
  })

  it('serializes to its amount string and currency', () => {
    const money = MoneyValue.of(DecimalValue.from('12.50'), 'USD')
    expect(money.toJSON()).toEqual({ amount: '12.5', currencyCode: 'USD' })
    expect(JSON.stringify(money)).toBe('{"amount":"12.5","currencyCode":"USD"}')
    expect(String(money)).toBe('12.5 USD')
  })

  it('validates the currency and precision', () => {
    expect(() => MoneyValue.of('1', ' ')).toThrow('[internal] Money requires a currency code')
    expect(() => MoneyValue.of('1', 'USD', -1)).toThrow('[internal] Invalid money precision')
    expect(() => MoneyValue.of('1', 'USD', 1.5)).toThrow('[internal] Invalid money precision')
  })
})
