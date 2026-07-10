import { createUiReadOnlyPolicy } from '../policy'
import {
  createUiReadOnlyWriteGuard,
  parseUiReadOnlyEnforceEnv,
  type UiReadOnlyEnforcementConfig,
} from '../write-guard'
import type { MutationGuardInput } from '../../crud/mutation-guard-registry'

function input(partial: Partial<MutationGuardInput>): MutationGuardInput {
  return {
    tenantId: 't',
    organizationId: null,
    userId: 'u',
    resourceKind: 'customers:customer_entity',
    resourceId: null,
    operation: 'update',
    requestMethod: 'PUT',
    requestHeaders: new Headers(),
    mutationPayload: null,
    ...partial,
  }
}

const policy = createUiReadOnlyPolicy({
  'sales:sales_order': ['*'],
  'customers:customer_entity': ['first_name'],
})

function guard(config: UiReadOnlyEnforcementConfig) {
  return createUiReadOnlyWriteGuard({ resolvePolicy: () => policy, resolveConfig: () => config })
}

describe('parseUiReadOnlyEnforceEnv', () => {
  it('parses off/all/entity-list forms', () => {
    expect(parseUiReadOnlyEnforceEnv(undefined)).toEqual({ mode: 'off' })
    expect(parseUiReadOnlyEnforceEnv('off')).toEqual({ mode: 'off' })
    expect(parseUiReadOnlyEnforceEnv('all')).toEqual({ mode: 'all' })
    expect(parseUiReadOnlyEnforceEnv('true')).toEqual({ mode: 'all' })
    const parsed = parseUiReadOnlyEnforceEnv('sales:sales_order, customers.customer_entity')
    expect(parsed.mode).toBe('entities')
    if (parsed.mode === 'entities') {
      // both colon and dot spellings are registered
      expect(parsed.entities.has('sales:sales_order')).toBe(true)
      expect(parsed.entities.has('customers:customer_entity')).toBe(true)
    }
  })
})

describe('createUiReadOnlyWriteGuard', () => {
  it('is inert when enforcement is off', async () => {
    const g = guard({ mode: 'off' } as const)
    expect(await g.validate(input({ resourceKind: 'sales:sales_order', operation: 'delete' }))).toEqual({ ok: true })
  })

  it('rejects every mutation on a whole-entity read-only entity when enforced', async () => {
    const g = guard({ mode: 'all' } as const)
    for (const operation of ['create', 'update', 'delete'] as const) {
      const res = await g.validate(input({ resourceKind: 'sales:sales_order', operation }))
      expect(res.ok).toBe(false)
      expect(res.status).toBe(422)
    }
  })

  it('rejects a write that touches a read-only field, allows others', async () => {
    const g = guard({ mode: 'all' } as const)
    const blocked = await g.validate(input({ mutationPayload: { first_name: 'X', last_name: 'Y' } }))
    expect(blocked.ok).toBe(false)
    expect((blocked.body as { fields?: string[] }).fields).toEqual(['first_name'])

    const allowed = await g.validate(input({ mutationPayload: { last_name: 'Y' } }))
    expect(allowed).toEqual({ ok: true })
  })

  it('allows delete for a per-field-only read-only entity', async () => {
    const g = guard({ mode: 'all' } as const)
    expect(await g.validate(input({ operation: 'delete' }))).toEqual({ ok: true })
  })

  it('only enforces listed entities in entities mode', async () => {
    const g = guard({ mode: 'entities', entities: new Set(['catalog:product']) } as const)
    // customers not listed → allowed even though it has a read-only field
    expect(await g.validate(input({ mutationPayload: { first_name: 'X' } }))).toEqual({ ok: true })
  })
})
