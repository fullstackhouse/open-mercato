import {
  UI_READ_ONLY_WHOLE_ENTITY,
  createUiReadOnlyPolicy,
  mergeUiReadOnlyMaps,
  normalizeUiReadOnlyMap,
} from '../policy'

describe('ui-read-only policy engine', () => {
  it('normalizes and dedupes field ids, dropping malformed entries', () => {
    const map = normalizeUiReadOnlyMap({
      'sales:sales_order': ['status', ' status ', 42 as unknown as string, ''],
      '  ': ['x'],
      'customers:customer_entity': [],
    })
    expect(map).toEqual({ 'sales:sales_order': ['status'] })
  })

  it("collapses to the whole-entity wildcard when '*' is present", () => {
    const map = normalizeUiReadOnlyMap({ 'sales:sales_order': ['status', UI_READ_ONLY_WHOLE_ENTITY] })
    expect(map['sales:sales_order']).toEqual([UI_READ_ONLY_WHOLE_ENTITY])
  })

  it('unions fields across tiers, wildcard dominating', () => {
    const merged = mergeUiReadOnlyMaps(
      { 'sales:sales_order': ['a'] },
      { 'sales:sales_order': ['b'] },
      { 'customers:customer_entity': [UI_READ_ONLY_WHOLE_ENTITY] },
    )
    expect(new Set(merged['sales:sales_order'])).toEqual(new Set(['a', 'b']))
    expect(merged['customers:customer_entity']).toEqual([UI_READ_ONLY_WHOLE_ENTITY])
  })

  it('answers whole-entity and field queries', () => {
    const policy = createUiReadOnlyPolicy({
      'sales:sales_order': [UI_READ_ONLY_WHOLE_ENTITY],
      'customers:customer_entity': ['primary_email'],
    })
    expect(policy.isEntityReadOnly('sales:sales_order')).toBe(true)
    expect(policy.isFieldReadOnly('sales:sales_order', 'anything')).toBe(true)
    expect(policy.isEntityReadOnly('customers:customer_entity')).toBe(false)
    expect(policy.isFieldReadOnly('customers:customer_entity', 'primary_email')).toBe(true)
    expect(policy.isFieldReadOnly('customers:customer_entity', 'first_name')).toBe(false)
    expect(policy.hasEntity('unknown:entity')).toBe(false)
  })
})
