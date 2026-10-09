const mockApiCall = jest.fn()

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({
  apiCall: (...args: unknown[]) => mockApiCall(...args),
}))

import { loadCurrencyDecimalPlaces } from '../currencyDecimalPlaces'

describe('loadCurrencyDecimalPlaces', () => {
  beforeEach(() => {
    mockApiCall.mockReset()
  })

  it('returns the decimal places configured for the currency code', async () => {
    mockApiCall.mockResolvedValue({ ok: true, result: { items: [{ code: 'ETH', decimalPlaces: 18 }] } })

    await expect(loadCurrencyDecimalPlaces(' eth ')).resolves.toBe(18)
    expect(mockApiCall).toHaveBeenCalledWith(
      '/api/currencies/currencies?code=ETH&pageSize=1',
      { headers: { 'x-om-forbidden-redirect': '0' } },
    )
  })

  it('returns null without a request for an empty code', async () => {
    await expect(loadCurrencyDecimalPlaces(null)).resolves.toBeNull()
    await expect(loadCurrencyDecimalPlaces('  ')).resolves.toBeNull()
    expect(mockApiCall).not.toHaveBeenCalled()
  })

  it('returns null when the currency is missing, invalid or cannot be read', async () => {
    mockApiCall.mockResolvedValueOnce({ ok: true, result: { items: [] } })
    await expect(loadCurrencyDecimalPlaces('ETH')).resolves.toBeNull()

    mockApiCall.mockResolvedValueOnce({ ok: true, result: { items: [{ code: 'ETH', decimalPlaces: -1 }] } })
    await expect(loadCurrencyDecimalPlaces('ETH')).resolves.toBeNull()

    mockApiCall.mockResolvedValueOnce({ ok: false, result: null })
    await expect(loadCurrencyDecimalPlaces('ETH')).resolves.toBeNull()

    mockApiCall.mockRejectedValueOnce(new Error('offline'))
    await expect(loadCurrencyDecimalPlaces('ETH')).resolves.toBeNull()
  })
})
