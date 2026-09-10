import { hasSearchFilter, isSearchFilterOp } from '../availability'

describe('hasSearchFilter / isSearchFilterOp', () => {
  test('recognizes like and ilike only', () => {
    expect(isSearchFilterOp('like')).toBe(true)
    expect(isSearchFilterOp('ilike')).toBe(true)
    expect(isSearchFilterOp('eq')).toBe(false)
    expect(isSearchFilterOp(null)).toBe(false)
    expect(isSearchFilterOp(undefined)).toBe(false)
  })

  test('reports whether a filter set actually searches', () => {
    expect(hasSearchFilter([{ op: 'eq' }, { op: 'in' }])).toBe(false)
    expect(hasSearchFilter([{ op: 'eq' }, { op: 'ilike' }])).toBe(true)
    expect(hasSearchFilter([])).toBe(false)
  })
})
