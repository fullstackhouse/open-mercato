import { LockMode } from '@mikro-orm/core'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createExternalIdMappingService, isSourceReadStale } from '../id-mapping'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))

describe('createExternalIdMappingService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rebinds an existing external id mapping to a recreated local record', async () => {
    const existingByExternalId = {
      id: 'mapping-1',
      integrationId: 'sync_akeneo',
      internalEntityType: 'catalog_product',
      internalEntityId: 'product-old',
      externalId: 'akeneo-1',
      syncStatus: 'error',
      lastSyncedAt: null,
      deletedAt: null,
    }
    ;(findOneWithDecryption as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingByExternalId)

    const persist = jest.fn((_entity: unknown) => ({ flush: jest.fn().mockResolvedValue(undefined) }))
    const em = {
      flush: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(),
      persist,
    }

    const service = createExternalIdMappingService(em as never)
    const result = await service.storeExternalIdMapping(
      'sync_akeneo',
      'catalog_product',
      'product-new',
      'akeneo-1',
      {
        organizationId: 'org-1',
        tenantId: 'tenant-1',
      },
    )

    expect(result).toBe(existingByExternalId)
    expect(existingByExternalId.internalEntityId).toBe('product-new')
    expect(existingByExternalId.externalId).toBe('akeneo-1')
    expect(existingByExternalId.syncStatus).toBe('synced')
    expect(existingByExternalId.lastSyncedAt).toBeInstanceOf(Date)
    expect(em.flush).toHaveBeenCalledTimes(1)
    // Update path must not call em.persist(created).flush() — it should use em.flush() only.
    expect(persist).not.toHaveBeenCalled()
  })

  it('retires duplicate active rows when both local and external lookups resolve different mappings', async () => {
    const existingByLocalId = {
      id: 'mapping-local',
      integrationId: 'sync_akeneo',
      internalEntityType: 'catalog_product',
      internalEntityId: 'product-new',
      externalId: 'akeneo-old',
      syncStatus: 'synced',
      lastSyncedAt: null,
      deletedAt: null,
    }
    const existingByExternalId = {
      id: 'mapping-external',
      integrationId: 'sync_akeneo',
      internalEntityType: 'catalog_product',
      internalEntityId: 'product-old',
      externalId: 'akeneo-1',
      syncStatus: 'error',
      lastSyncedAt: null,
      deletedAt: null,
    }
    ;(findOneWithDecryption as jest.Mock)
      .mockResolvedValueOnce(existingByLocalId)
      .mockResolvedValueOnce(existingByExternalId)

    const persist = jest.fn((_entity: unknown) => ({ flush: jest.fn().mockResolvedValue(undefined) }))
    const em = {
      flush: jest.fn().mockResolvedValue(undefined),
      create: jest.fn(),
      persist,
    }

    const service = createExternalIdMappingService(em as never)
    await service.storeExternalIdMapping(
      'sync_akeneo',
      'catalog_product',
      'product-new',
      'akeneo-1',
      {
        organizationId: 'org-1',
        tenantId: 'tenant-1',
      },
    )

    expect(existingByExternalId.internalEntityId).toBe('product-new')
    expect(existingByExternalId.syncStatus).toBe('synced')
    expect(existingByLocalId.deletedAt).toBeInstanceOf(Date)
    expect(em.flush).toHaveBeenCalledTimes(1)
    expect(persist).not.toHaveBeenCalled()
  })

  describe('deleteExternalIdMapping', () => {
    it('soft-deletes the matching mapping and returns true', async () => {
      const existing = {
        id: 'mapping-1',
        integrationId: 'sync_magento',
        internalEntityType: 'sales_order',
        internalEntityId: 'order-1',
        externalId: 'magento-1',
        deletedAt: null as Date | null,
      }
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(existing)

      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      const result = await service.deleteExternalIdMapping(
        'sync_magento',
        'sales_order',
        'order-1',
        { organizationId: 'org-1', tenantId: 'tenant-1' },
      )

      expect(result).toBe(true)
      expect(existing.deletedAt).toBeInstanceOf(Date)
      expect(em.flush).toHaveBeenCalledTimes(1)
      const where = (findOneWithDecryption as jest.Mock).mock.calls[0][2]
      expect(where).toMatchObject({
        integrationId: 'sync_magento',
        internalEntityType: 'sales_order',
        internalEntityId: 'order-1',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        deletedAt: null,
      })
    })

    it('returns false and does not flush when no mapping exists', async () => {
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(null)

      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      const result = await service.deleteExternalIdMapping(
        'sync_magento',
        'sales_order',
        'order-missing',
        { organizationId: 'org-1', tenantId: 'tenant-1' },
      )

      expect(result).toBe(false)
      expect(em.flush).not.toHaveBeenCalled()
    })
  })

  describe('deleteExternalIdMappings', () => {
    it('soft-deletes every matching mapping and returns the count', async () => {
      const rows = [
        { id: 'mapping-1', internalEntityId: 'order-1', deletedAt: null as Date | null },
        { id: 'mapping-2', internalEntityId: 'order-2', deletedAt: null as Date | null },
      ]
      ;(findWithDecryption as jest.Mock).mockResolvedValueOnce(rows)

      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      const result = await service.deleteExternalIdMappings(
        'sync_magento',
        'sales_order',
        ['order-1', 'order-2', 'order-1'],
        { organizationId: 'org-1', tenantId: 'tenant-1' },
      )

      expect(result).toBe(2)
      expect(rows[0].deletedAt).toBeInstanceOf(Date)
      expect(rows[1].deletedAt).toBeInstanceOf(Date)
      expect(em.flush).toHaveBeenCalledTimes(1)
      const where = (findWithDecryption as jest.Mock).mock.calls[0][2]
      expect(where.internalEntityId).toEqual({ $in: ['order-1', 'order-2'] })
    })

    it('returns 0 without querying or flushing for an empty id list', async () => {
      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      const result = await service.deleteExternalIdMappings(
        'sync_magento',
        'sales_order',
        [],
        { organizationId: 'org-1', tenantId: 'tenant-1' },
      )

      expect(result).toBe(0)
      expect(findWithDecryption as jest.Mock).not.toHaveBeenCalled()
      expect(em.flush).not.toHaveBeenCalled()
    })

    it('returns 0 and does not flush when nothing matches', async () => {
      ;(findWithDecryption as jest.Mock).mockResolvedValueOnce([])

      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      const result = await service.deleteExternalIdMappings(
        'sync_magento',
        'sales_order',
        ['order-x'],
        { organizationId: 'org-1', tenantId: 'tenant-1' },
      )

      expect(result).toBe(0)
      expect(em.flush).not.toHaveBeenCalled()
    })
  })

  describe('storeExternalIdMapping source read stamp', () => {
    const scope = { organizationId: 'org-1', tenantId: 'tenant-1' }

    function makeEm() {
      const persist = jest.fn((_entity: unknown) => ({ flush: jest.fn().mockResolvedValue(undefined) }))
      return {
        flush: jest.fn().mockResolvedValue(undefined),
        create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data })),
        persist,
      }
    }

    it('leaves the stored stamp untouched when no options are supplied', async () => {
      const storedStamp = new Date('2026-08-01T00:00:00.000Z')
      const existing = {
        id: 'mapping-1',
        internalEntityId: 'order-old',
        externalId: 'magento-1',
        syncStatus: 'error',
        lastSyncedAt: null,
        sourceReadAt: storedStamp,
        deletedAt: null,
      }
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(existing)

      const em = makeEm()
      const service = createExternalIdMappingService(em as never)
      await service.storeExternalIdMapping('sync_magento', 'sales_order', 'order-new', 'magento-1', scope)

      expect(existing.sourceReadAt).toBe(storedStamp)
      expect(existing.lastSyncedAt).toBeInstanceOf(Date)
      expect(em.flush).toHaveBeenCalledTimes(1)
      expect(em.persist).not.toHaveBeenCalled()
    })

    it('stamps a newly created mapping when the option is supplied', async () => {
      const readAt = new Date('2026-08-12T10:00:00.000Z')
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

      const em = makeEm()
      const service = createExternalIdMappingService(em as never)
      await service.storeExternalIdMapping('sync_magento', 'sales_order', 'order-1', 'magento-1', scope, {
        sourceReadAt: readAt,
      })

      expect(em.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceReadAt: readAt }))
      expect(em.persist).toHaveBeenCalledTimes(1)
    })

    it('omits the column from the insert entirely when no option is supplied', async () => {
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

      const em = makeEm()
      const service = createExternalIdMappingService(em as never)
      await service.storeExternalIdMapping('sync_magento', 'sales_order', 'order-1', 'magento-1', scope)

      expect(em.create.mock.calls[0][1]).not.toHaveProperty('sourceReadAt')
    })

    it('updates the stamp on an existing mapping', async () => {
      const newerStamp = new Date('2026-08-12T10:00:00.000Z')
      const existing = {
        id: 'mapping-1',
        internalEntityId: 'order-1',
        externalId: 'magento-1',
        syncStatus: 'synced',
        lastSyncedAt: null,
        sourceReadAt: new Date('2026-08-01T00:00:00.000Z'),
        deletedAt: null,
      }
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(existing)

      const em = makeEm()
      const service = createExternalIdMappingService(em as never)
      await service.storeExternalIdMapping('sync_magento', 'sales_order', 'order-1', 'magento-1', scope, {
        sourceReadAt: newerStamp,
      })

      expect(existing.sourceReadAt).toBe(newerStamp)
    })

    it('clears the stamp when null is passed explicitly', async () => {
      const existing = {
        id: 'mapping-1',
        internalEntityId: 'order-1',
        externalId: 'magento-1',
        syncStatus: 'synced',
        lastSyncedAt: null,
        sourceReadAt: new Date('2026-08-01T00:00:00.000Z') as Date | null,
        deletedAt: null,
      }
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(existing)

      const em = makeEm()
      const service = createExternalIdMappingService(em as never)
      await service.storeExternalIdMapping('sync_magento', 'sales_order', 'order-1', 'magento-1', scope, {
        sourceReadAt: null,
      })

      expect(existing.sourceReadAt).toBeNull()
    })
  })

  describe('lookupMapping', () => {
    const scope = { organizationId: 'org-1', tenantId: 'tenant-1' }

    it('returns null and does not flush when no mapping exists', async () => {
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(null)

      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      const result = await service.lookupMapping('sync_magento', 'sales_order', 'magento-missing', scope)

      expect(result).toBeNull()
      expect(em.flush).not.toHaveBeenCalled()
    })

    it('maps the row to a snapshot and scopes the lookup by external id', async () => {
      const readAt = new Date('2026-08-12T10:00:00.000Z')
      const syncedAt = new Date('2026-08-12T10:00:05.000Z')
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce({
        id: 'mapping-1',
        internalEntityId: 'order-1',
        externalId: 'magento-1',
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
        sourceReadAt: readAt,
        deletedAt: null,
      })

      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      const result = await service.lookupMapping('sync_magento', 'sales_order', 'magento-1', scope)

      expect(result).toEqual({
        localId: 'order-1',
        externalId: 'magento-1',
        syncStatus: 'synced',
        lastSyncedAt: syncedAt,
        sourceReadAt: readAt,
      })
      const where = (findOneWithDecryption as jest.Mock).mock.calls[0][2]
      expect(where).toMatchObject({
        integrationId: 'sync_magento',
        internalEntityType: 'sales_order',
        externalId: 'magento-1',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        deletedAt: null,
      })
    })

    it('normalizes an unstamped legacy row to null rather than undefined', async () => {
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce({
        id: 'mapping-1',
        internalEntityId: 'order-1',
        externalId: 'magento-1',
        syncStatus: 'synced',
        deletedAt: null,
      })

      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      const result = await service.lookupMapping('sync_magento', 'sales_order', 'magento-1', scope)

      expect(result?.sourceReadAt).toBeNull()
      expect(result?.lastSyncedAt).toBeNull()
    })

    it('takes no lock by default and a write lock under forUpdate', async () => {
      ;(findOneWithDecryption as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce(null)

      const em = { flush: jest.fn().mockResolvedValue(undefined) }
      const service = createExternalIdMappingService(em as never)
      await service.lookupMapping('sync_magento', 'sales_order', 'magento-1', scope)
      await service.lookupMapping('sync_magento', 'sales_order', 'magento-1', scope, { forUpdate: true })

      expect((findOneWithDecryption as jest.Mock).mock.calls[0][3]).toBeUndefined()
      expect((findOneWithDecryption as jest.Mock).mock.calls[1][3]).toEqual({
        lockMode: LockMode.PESSIMISTIC_WRITE,
      })
    })
  })
})

describe('isSourceReadStale', () => {
  const stamp = new Date('2026-08-12T10:00:00.000Z')

  it('treats a missing stored stamp as older than any incoming stamp', () => {
    expect(isSourceReadStale(null, stamp)).toBe(false)
    expect(isSourceReadStale(undefined, stamp)).toBe(false)
  })

  it('cannot fence a writer that supplies no stamp', () => {
    expect(isSourceReadStale(stamp, null)).toBe(false)
    expect(isSourceReadStale(stamp, undefined)).toBe(false)
  })

  it('treats equal stamps as not stale so redelivered batches re-apply', () => {
    expect(isSourceReadStale(stamp, new Date(stamp.getTime()))).toBe(false)
  })

  it('reports an older incoming read as stale', () => {
    expect(isSourceReadStale(stamp, new Date(stamp.getTime() - 1))).toBe(true)
  })

  it('reports a newer incoming read as not stale', () => {
    expect(isSourceReadStale(stamp, new Date(stamp.getTime() + 1))).toBe(false)
  })

  it('accepts ISO strings on either side', () => {
    expect(isSourceReadStale(stamp.toISOString(), '2026-08-12T09:59:59.999Z')).toBe(true)
    expect(isSourceReadStale(stamp.toISOString(), '2026-08-12T10:00:00.000Z')).toBe(false)
    expect(isSourceReadStale('2026-08-12T09:59:59.999Z', stamp)).toBe(false)
  })

  it('fails open on an unparseable stamp', () => {
    expect(isSourceReadStale(stamp, 'not-a-date')).toBe(false)
    expect(isSourceReadStale('not-a-date', stamp)).toBe(false)
  })
})
