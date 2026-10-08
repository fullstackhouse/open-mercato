import { ExactDecimalType } from '../exactDecimalType'

describe('ExactDecimalType', () => {
  const type = new ExactDecimalType()

  it('detects changes beyond float precision', () => {
    expect(Number('1.123456789012345678')).toBe(Number('1.123456789012345679'))
    expect(type.compareValues('1.123456789012345678', '1.123456789012345679')).toBe(false)
  })

  it('treats the same value with different scale as unchanged', () => {
    expect(type.compareValues('40.0000', '40')).toBe(true)
    expect(type.compareValues('0.000000000000000001', '1e-18')).toBe(true)
  })

  it('compares missing values strictly', () => {
    expect(type.compareValues(null, null)).toBe(true)
    expect(type.compareValues(null, '0')).toBe(false)
  })

  it('maps to a string runtime type', () => {
    expect(type.compareAsType()).toBe('string')
  })
})
