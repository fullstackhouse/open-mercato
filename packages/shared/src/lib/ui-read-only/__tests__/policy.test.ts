import {
  applyUiReadOnlyOverrideMap,
  createUiReadOnlyPolicy,
  EMPTY_UI_READ_ONLY_POLICY,
  mergeUiReadOnlyMaps,
  normalizeUiReadOnlyMap,
  UI_READ_ONLY_WHOLE_ENTITY,
} from '../policy'

describe('normalizeUiReadOnlyMap', () => {
  it('trims ids, drops empties, dedupes fields', () => {
    expect(
      normalizeUiReadOnlyMap({
        ' customers:customer_entity ': ['first_name', 'first_name', ' '],
        'sales:sales_order': [],
        '': ['x'],
        bad: 'not-an-array' as unknown as string[],
      }),
    ).toEqual({ 'customers:customer_entity': ['first_name'] })
  })

  it('collapses to the wildcard when whole-entity is present', () => {
    expect(normalizeUiReadOnlyMap({ 'sales:sales_order': ['a', '*', 'b'] })).toEqual({
      'sales:sales_order': [UI_READ_ONLY_WHOLE_ENTITY],
    })
  })

  it('returns an empty map for nullish input', () => {
    expect(normalizeUiReadOnlyMap(null)).toEqual({})
    expect(normalizeUiReadOnlyMap(undefined)).toEqual({})
  })
})

describe('mergeUiReadOnlyMaps', () => {
  it('unions fields across tiers and lets the wildcard dominate', () => {
    const merged = mergeUiReadOnlyMaps(
      { 'customers:customer_entity': ['first_name'] },
      { 'customers:customer_entity': ['primary_email'], 'sales:sales_order': ['*'] },
      { 'sales:sales_order': ['total'] },
    )
    expect(new Set(merged['customers:customer_entity'])).toEqual(new Set(['first_name', 'primary_email']))
    expect(merged['sales:sales_order']).toEqual([UI_READ_ONLY_WHOLE_ENTITY])
  })
})

describe('applyUiReadOnlyOverrideMap', () => {
  const base = { 'customers:customer_entity': ['first_name'], 'sales:sales_order': ['total'] }

  it('replaces the field list for an entity', () => {
    const out = applyUiReadOnlyOverrideMap(base, { 'customers:customer_entity': ['primary_email'] })
    expect(out['customers:customer_entity']).toEqual(['primary_email'])
    expect(out['sales:sales_order']).toEqual(['total'])
  })

  it('disables (removes) a declaration when the override is null', () => {
    const out = applyUiReadOnlyOverrideMap(base, { 'sales:sales_order': null })
    expect(out['sales:sales_order']).toBeUndefined()
    expect(out['customers:customer_entity']).toEqual(['first_name'])
  })
})

describe('createUiReadOnlyPolicy', () => {
  const policy = createUiReadOnlyPolicy({
    'sales:sales_order': ['*'],
    'customers:customer_entity': ['first_name', 'primary_email'],
  })

  it('reports whole-entity read-only', () => {
    expect(policy.isEntityReadOnly('sales:sales_order')).toBe(true)
    expect(policy.isFieldReadOnly('sales:sales_order', 'any_field')).toBe(true)
    expect(policy.readOnlyFields('sales:sales_order')).toEqual([UI_READ_ONLY_WHOLE_ENTITY])
  })

  it('reports per-field read-only without whole-entity', () => {
    expect(policy.isEntityReadOnly('customers:customer_entity')).toBe(false)
    expect(policy.hasEntity('customers:customer_entity')).toBe(true)
    expect(policy.isFieldReadOnly('customers:customer_entity', 'first_name')).toBe(true)
    expect(policy.isFieldReadOnly('customers:customer_entity', 'last_name')).toBe(false)
  })

  it('treats unknown entities and nullish input as editable', () => {
    expect(policy.hasEntity('unknown:entity')).toBe(false)
    expect(policy.isFieldReadOnly(null, 'x')).toBe(false)
    expect(policy.isFieldReadOnly('sales:sales_order', null)).toBe(false)
    expect(EMPTY_UI_READ_ONLY_POLICY.hasEntity('sales:sales_order')).toBe(false)
  })
})
