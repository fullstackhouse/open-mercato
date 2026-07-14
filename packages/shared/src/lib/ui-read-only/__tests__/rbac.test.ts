import {
  registerCrudWriteFeatures,
  getCrudWriteFeatureRegistry,
  clearCrudWriteFeatureRegistry,
  resolveRbacReadOnlyMap,
  type CrudWriteFeatureRegistry,
} from '../rbac'

describe('crud write-feature registry', () => {
  beforeEach(() => clearCrudWriteFeatureRegistry())

  it('records write features per entity, deduped and trimmed', () => {
    registerCrudWriteFeatures('catalog:catalog_product', ['  catalog.products.manage ', 'catalog.products.manage'])
    expect(getCrudWriteFeatureRegistry()).toEqual({
      'catalog:catalog_product': ['catalog.products.manage'],
    })
  })

  it('merges features on re-registration (additive)', () => {
    registerCrudWriteFeatures('sales:sales_order', ['sales.orders.manage'])
    registerCrudWriteFeatures('sales:sales_order', ['sales.orders.export'])
    expect(getCrudWriteFeatureRegistry()['sales:sales_order']).toEqual([
      'sales.orders.manage',
      'sales.orders.export',
    ])
  })

  it('is a no-op for empty entity id or empty/invalid features', () => {
    registerCrudWriteFeatures('', ['x.manage'])
    registerCrudWriteFeatures('catalog:catalog_product', [])
    registerCrudWriteFeatures(undefined, ['x.manage'])
    expect(getCrudWriteFeatureRegistry()).toEqual({})
  })
})

describe('resolveRbacReadOnlyMap', () => {
  const registry: CrudWriteFeatureRegistry = {
    'catalog:catalog_product': ['catalog.products.manage'],
    'customers:customer_entity': ['customers.people.manage'],
    'sales:sales_order': ['sales.orders.manage'],
  }

  it('marks entities the principal cannot manage as whole-entity read-only', () => {
    const map = resolveRbacReadOnlyMap(
      { features: ['catalog.products.view', 'customers.people.view', 'sales.orders.view'] },
      { registry },
    )
    expect(map).toEqual({
      'catalog:catalog_product': ['*'],
      'customers:customer_entity': ['*'],
      'sales:sales_order': ['*'],
    })
  })

  it('leaves entities the principal can manage editable (exact grant)', () => {
    const map = resolveRbacReadOnlyMap(
      { features: ['catalog.products.manage', 'customers.people.view'] },
      { registry },
    )
    expect(map['catalog:catalog_product']).toBeUndefined()
    expect(map['customers:customer_entity']).toEqual(['*'])
  })

  it('honours wildcard grants', () => {
    const map = resolveRbacReadOnlyMap({ features: ['catalog.*', 'sales.*'] }, { registry })
    expect(map['catalog:catalog_product']).toBeUndefined()
    expect(map['sales:sales_order']).toBeUndefined()
    expect(map['customers:customer_entity']).toEqual(['*'])
  })

  it('lets a superadmin edit everything (empty map) by default', () => {
    expect(resolveRbacReadOnlyMap({ isSuperAdmin: true, features: [] }, { registry })).toEqual({})
  })

  it('subjects a superadmin to the map when enforceForSuperAdmin is set', () => {
    const map = resolveRbacReadOnlyMap(
      { isSuperAdmin: true, features: [] },
      { registry, enforceForSuperAdmin: true },
    )
    expect(map['catalog:catalog_product']).toEqual(['*'])
  })

  it('treats a principal with no features as unable to manage anything', () => {
    const map = resolveRbacReadOnlyMap(null, { registry })
    expect(Object.keys(map).sort()).toEqual([
      'catalog:catalog_product',
      'customers:customer_entity',
      'sales:sales_order',
    ])
  })
})
