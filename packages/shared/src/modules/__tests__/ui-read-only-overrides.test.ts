import {
  applyModuleOverridesFromEnabledModules,
  applyUiReadOnlyOverrides,
  composeUiReadOnlyOverrides,
  resetModuleContractOverridesForTests,
  resetModuleOverrideAppliersForTests,
  type ModuleEntryWithOverrides,
} from '../overrides'

beforeEach(() => {
  resetModuleOverrideAppliersForTests()
  resetModuleContractOverridesForTests()
})

describe('uiReadOnly override domain', () => {
  it('routes modules.ts inline uiReadOnly overrides into the store', () => {
    const modules: ModuleEntryWithOverrides[] = [
      {
        id: 'example',
        from: '@app',
        overrides: {
          uiReadOnly: {
            'sales:sales_order': ['*'],
            'customers:customer_entity': ['first_name', 'primary_email'],
          },
        },
      },
    ]
    applyModuleOverridesFromEnabledModules(modules)
    expect(composeUiReadOnlyOverrides()).toEqual({
      'sales:sales_order': ['*'],
      'customers:customer_entity': ['first_name', 'primary_email'],
    })
  })

  it('lets programmatic overrides supersede modules.ts inline ones (and null disables)', () => {
    applyModuleOverridesFromEnabledModules([
      { id: 'example', from: '@app', overrides: { uiReadOnly: { 'sales:sales_order': ['total'] } } },
    ])
    applyUiReadOnlyOverrides({ 'sales:sales_order': ['*'], 'catalog:product': null })
    const composed = composeUiReadOnlyOverrides()
    expect(composed['sales:sales_order']).toEqual(['*'])
    expect(composed['catalog:product']).toBeNull()
  })

  it('returns an empty map when nothing is registered', () => {
    expect(composeUiReadOnlyOverrides()).toEqual({})
  })
})
