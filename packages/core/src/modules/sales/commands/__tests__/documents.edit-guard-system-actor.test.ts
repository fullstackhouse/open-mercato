/** @jest-environment node */

/**
 * Order customer/address editable-status guard — system-actor bypass.
 *
 * The `sales.orders.update` command guards customer and address edits behind the
 * per-tenant `orderCustomerEditableStatuses` / `orderAddressEditableStatuses`
 * settings: with an empty list every status is frozen, so an interactive edit is
 * rejected with a 400 (`edit_customer_blocked` / `edit_addresses_blocked`). That
 * guard is a human-UI concern.
 *
 * A trusted server-side caller (`ctx.systemActor === true`, e.g. an ERP sync
 * writing the source-of-record truth) is not an operator and must bypass the
 * guard natively — the sync no longer needs a bespoke flag + a core patch. This
 * proves both directions against the same locked settings:
 *   - no `systemActor` (interactive): the guard fires and blocks the write.
 *   - `systemActor: true` (system): the guard is skipped, the settings are not
 *     even loaded, and the update completes.
 */

import { createContainer, asValue, InjectionMode } from 'awilix'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { SalesOrder, SalesSettings } from '../../data/entities'

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    locale: 'en',
    dict: {},
    t: (key: string, fallback?: string) => fallback ?? key,
    translate: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

jest.mock('@open-mercato/shared/lib/crud/cache', () => ({
  invalidateCrudCache: jest.fn(),
  deriveResourceFromCommandId: (id: string) => id,
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(async () => []),
  findOneWithDecryption: jest.fn(
    async (em: { findOne: (entityClass: unknown, where: unknown) => Promise<unknown> }, entityClass: unknown, where: unknown) =>
      em.findOne(entityClass, where),
  ),
}))

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORDER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

/** Order frozen in a status that no editable-status list allows. */
function makeOrder() {
  return {
    id: ORDER_ID,
    organizationId: ORG_ID,
    tenantId: TENANT_ID,
    orderNumber: 'O-1',
    status: 'confirmed',
    statusEntryId: null,
    customerEntityId: null,
    customerContactId: null,
    customerSnapshot: null,
    billingAddressId: null,
    shippingAddressId: null,
    billingAddressSnapshot: null,
    shippingAddressSnapshot: null,
    currencyCode: 'USD',
    metadata: null,
    updatedAt: new Date('2026-07-08T09:21:29.000Z'),
    deletedAt: null,
  }
}

/**
 * Locked settings: both editable-status lists are empty, so every status is
 * frozen for interactive edits — the GSM-162 shape the sync must bypass.
 */
function makeLockedSettings() {
  return {
    id: 'ssssssss-ssss-4sss-8sss-ssssssssssss',
    organizationId: ORG_ID,
    tenantId: TENANT_ID,
    orderCustomerEditableStatuses: [] as string[],
    orderAddressEditableStatuses: [] as string[],
  }
}

function makeEm(order: ReturnType<typeof makeOrder>, settings: ReturnType<typeof makeLockedSettings>) {
  const settingsFindOne = jest.fn(async () => settings)
  const em: any = {
    findOne: jest.fn(async (entityClass: unknown) => {
      if (entityClass === SalesOrder) return order
      if (entityClass === SalesSettings) return settingsFindOne()
      return null
    }),
    find: jest.fn(async () => []),
    create: jest.fn((_entity: unknown, data: unknown) => data),
    persist: jest.fn(),
    remove: jest.fn(),
    flush: jest.fn(async () => {}),
    begin: jest.fn(async () => {}),
    commit: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}),
    fork: function () {
      return this
    },
  }
  return { em, settingsFindOne }
}

function makeCtx(em: unknown, options?: { systemActor?: boolean }) {
  const container = createContainer({ injectionMode: InjectionMode.CLASSIC })
  container.register({
    em: asValue(em),
    dataEngine: asValue({ markOrmEntityChange: jest.fn() }),
  })
  return {
    container,
    auth: options?.systemActor ? null : { tenantId: TENANT_ID, orgId: ORG_ID, sub: 'user-1' },
    selectedOrganizationId: ORG_ID,
    organizationScope: null,
    organizationIds: null,
    systemActor: options?.systemActor,
  }
}

async function runUpdate(
  input: Record<string, unknown>,
  ctxOptions?: { systemActor?: boolean },
) {
  const handler = commandRegistry.get('sales.orders.update')!
  const { em, settingsFindOne } = makeEm(makeOrder(), makeLockedSettings())
  let caught: unknown
  try {
    await handler.execute({ id: ORDER_ID, ...input } as never, makeCtx(em, ctxOptions) as never)
  } catch (err) {
    caught = err
  }
  return { caught, em, settingsFindOne }
}

describe('sales.orders.update editable-status guard — systemActor bypass', () => {
  beforeAll(async () => {
    commandRegistry.clear?.()
    await import('../documents')
  })

  describe('interactive write (no systemActor) stays blocked', () => {
    it('rejects a customer change with 400 edit_customer_blocked', async () => {
      const { caught, em } = await runUpdate({ customerSnapshot: { name: 'Acme' } })
      expect(isCrudHttpError(caught)).toBe(true)
      expect((caught as CrudHttpError).status).toBe(400)
      expect(String((caught as CrudHttpError).body?.error)).toMatch(/customer is blocked/i)
      expect(em.flush).not.toHaveBeenCalled()
    })

    it('rejects an address change with 400 edit_addresses_blocked', async () => {
      const { caught, em } = await runUpdate({ shippingAddressSnapshot: { city: 'Warsaw' } })
      expect(isCrudHttpError(caught)).toBe(true)
      expect((caught as CrudHttpError).status).toBe(400)
      expect(String((caught as CrudHttpError).body?.error)).toMatch(/addresses is blocked/i)
      expect(em.flush).not.toHaveBeenCalled()
    })
  })

  describe('system write (systemActor: true) bypasses the guard', () => {
    it('applies a customer change without loading the settings', async () => {
      const { caught, em, settingsFindOne } = await runUpdate(
        { customerSnapshot: { name: 'Acme' } },
        { systemActor: true },
      )
      expect(caught).toBeUndefined()
      // The guard is skipped, so the settings that enforce it are never read.
      expect(settingsFindOne).not.toHaveBeenCalled()
      expect(em.flush).toHaveBeenCalled()
    })

    it('applies an address change without loading the settings', async () => {
      const { caught, em, settingsFindOne } = await runUpdate(
        { shippingAddressSnapshot: { city: 'Warsaw' } },
        { systemActor: true },
      )
      expect(caught).toBeUndefined()
      expect(settingsFindOne).not.toHaveBeenCalled()
      expect(em.flush).toHaveBeenCalled()
    })
  })
})
