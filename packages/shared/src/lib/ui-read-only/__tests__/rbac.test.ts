import { UI_READ_ONLY_WHOLE_ENTITY } from '../policy'
import {
  clearCrudWriteFeatureRegistry,
  getCrudWriteFeatureRegistry,
  registerCrudWriteFeatures,
  resolveRbacReadOnlyMap,
  seedCrudWriteFeatureRegistry,
} from '../rbac'

const ORDER = 'sales:sales_order'
const MANAGE = 'sales.orders.manage'

describe('RBAC-driven UI read-only (whole-entity)', () => {
  afterEach(() => clearCrudWriteFeatureRegistry())

  it('registers write features additively and idempotently', () => {
    registerCrudWriteFeatures(ORDER, [MANAGE])
    registerCrudWriteFeatures(ORDER, [MANAGE, 'sales.orders.approve'])
    registerCrudWriteFeatures('', ['x']) // ignored — empty id
    registerCrudWriteFeatures(ORDER, []) // ignored — empty features
    expect(getCrudWriteFeatureRegistry()).toEqual({
      [ORDER]: [MANAGE, 'sales.orders.approve'],
    })
  })

  it('marks an entity read-only when the principal lacks its write feature', () => {
    seedCrudWriteFeatureRegistry({ [ORDER]: [MANAGE] })
    const map = resolveRbacReadOnlyMap({ features: ['sales.orders.view'] })
    expect(map[ORDER]).toEqual([UI_READ_ONLY_WHOLE_ENTITY])
  })

  it('leaves an entity editable when the principal holds the write feature', () => {
    seedCrudWriteFeatureRegistry({ [ORDER]: [MANAGE] })
    expect(resolveRbacReadOnlyMap({ features: [MANAGE] })).toEqual({})
  })

  it('honors module wildcard grants (sales.* covers sales.orders.manage)', () => {
    seedCrudWriteFeatureRegistry({ [ORDER]: [MANAGE] })
    expect(resolveRbacReadOnlyMap({ features: ['sales.*'] })).toEqual({})
  })

  it('a superadmin bypasses the read-only map by default', () => {
    seedCrudWriteFeatureRegistry({ [ORDER]: [MANAGE] })
    expect(resolveRbacReadOnlyMap({ features: [], isSuperAdmin: true })).toEqual({})
  })

  it('enforceForSuperAdmin makes even a superadmin read-only', () => {
    seedCrudWriteFeatureRegistry({ [ORDER]: [MANAGE] })
    const map = resolveRbacReadOnlyMap({ features: [], isSuperAdmin: true }, { enforceForSuperAdmin: true })
    expect(map[ORDER]).toEqual([UI_READ_ONLY_WHOLE_ENTITY])
  })

  it('a read-only route (no write features) never marks its entity read-only', () => {
    // nothing registered for ORDER
    expect(resolveRbacReadOnlyMap({ features: [] })).toEqual({})
  })
})
