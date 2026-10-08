import { coversGrandTotal } from '../shipments'

describe('coversGrandTotal', () => {
  it('treats a legacy total one 4th-decimal unit short as settled', () => {
    expect(coversGrandTotal('99.9999', '100.0000')).toBe(true)
    expect(coversGrandTotal('99.9998', '100.0000')).toBe(false)
  })

  it('narrows the tolerance for totals with more decimals', () => {
    expect(coversGrandTotal('0.999999999999999999', '1.000000000000000000')).toBe(true)
    expect(coversGrandTotal('0.999999999999999998', '1.000000000000000000')).toBe(false)
    expect(coversGrandTotal('0.9999', '1')).toBe(true)
    expect(coversGrandTotal('0.999999999999999999', '1.000000000000000001')).toBe(false)
    expect(coversGrandTotal('1.000000000000000000', '1.000000000000000001')).toBe(true)
  })
})
