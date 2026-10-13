import { ExchangeRate } from '../../../currencies/data/entities'
import type { RateResult } from '../../../currencies/services/exchangeRateService'
import { convertSumsToBase, sumsByCurrency } from '../dealsMetrics'

function rates(entries: Record<string, string>): ReadonlyMap<string, RateResult> {
  return new Map(Object.entries(entries).map(([pair, rate]) => {
    const [fromCurrencyCode, toCurrencyCode] = pair.split('/')
    const exchangeRate = new ExchangeRate()
    exchangeRate.rate = rate
    const date = new Date('2026-10-13T00:00:00Z')
    return [pair, { rates: [exchangeRate], fromCurrencyCode, toCurrencyCode, requestedDate: date, actualDate: date }]
  }))
}

describe('deal metrics money math', () => {
  it('sums per currency exactly, case-insensitively, in first-seen order', () => {
    const sums = sumsByCurrency([
      { currency: 'usd', amount: '0.1' },
      { currency: 'EUR', amount: '5' },
      { currency: 'USD', amount: '0.2' },
      { currency: null, amount: '99' },
    ])
    expect(sums).toEqual([
      { currency: 'USD', total: 0.3, totalExact: '0.3' },
      { currency: 'EUR', total: 5, totalExact: '5' },
    ])
  })

  it('converts to the base currency without rounding the exact total', () => {
    const converted = convertSumsToBase(
      [
        { currency: 'USD', total: 10, totalExact: '10.5' },
        { currency: 'EUR', total: 3, totalExact: '3' },
        { currency: 'GBP', total: 1, totalExact: '1' },
      ],
      'USD',
      rates({ 'EUR/USD': '1.123456789012345678' }),
    )
    expect(converted).toEqual({
      total: 14,
      totalExact: '13.870370367037037034',
      convertedAll: false,
      missingRateCurrencies: ['GBP'],
    })
  })
})
