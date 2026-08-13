import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { SyncExternalIdMapping } from '../../integrations/data/entities'

type MappingScope = {
  organizationId: string
  tenantId: string
}

export type StoreExternalIdMappingOptions = {
  /**
   * When the source produced the data being applied — see `SyncExternalIdMapping.sourceReadAt` for
   * the clock requirement. Omit to leave the stored stamp untouched; pass `null` to clear it.
   */
  sourceReadAt?: Date | null
}

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * Whether `incoming` describes an older read of the source than `stored`, i.e. applying it would
 * overwrite newer data with older data and the caller should skip.
 *
 * ```ts
 * const mapping = await service.lookupMapping(integrationId, entityType, externalId, scope)
 * if (isSourceReadStale(mapping?.sourceReadAt, payload.sourceReadAt)) return
 * ```
 *
 * Fails open — an absent or unparseable stamp on either side yields `false`, preserving
 * last-write-wins for writers that do not track source read time. Equal stamps are NOT stale, so a
 * redelivered batch re-applies idempotently instead of being silently dropped.
 */
export function isSourceReadStale(
  stored: Date | string | null | undefined,
  incoming: Date | string | null | undefined,
): boolean {
  const storedMs = toEpochMs(stored)
  const incomingMs = toEpochMs(incoming)
  if (storedMs === null || incomingMs === null) return false
  return incomingMs < storedMs
}

export function createExternalIdMappingService(em: EntityManager) {
  return {
    async lookupLocalId(integrationId: string, entityType: string, externalId: string, scope: MappingScope): Promise<string | null> {
      const row = await findOneWithDecryption(
        em,
        SyncExternalIdMapping,
        {
        integrationId,
        internalEntityType: entityType,
        externalId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
        },
        undefined,
        scope,
      )
      return row?.internalEntityId ?? null
    },

    async lookupExternalId(integrationId: string, entityType: string, localId: string, scope: MappingScope): Promise<string | null> {
      const row = await findOneWithDecryption(
        em,
        SyncExternalIdMapping,
        {
        integrationId,
        internalEntityType: entityType,
        internalEntityId: localId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
        },
        undefined,
        scope,
      )
      return row?.externalId ?? null
    },

    async storeExternalIdMapping(
      integrationId: string,
      entityType: string,
      localId: string,
      externalId: string,
      scope: MappingScope,
      options?: StoreExternalIdMappingOptions,
    ): Promise<SyncExternalIdMapping> {
      const existingByLocalId = await findOneWithDecryption(
        em,
        SyncExternalIdMapping,
        {
        integrationId,
        internalEntityType: entityType,
        internalEntityId: localId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
        },
        undefined,
        scope,
      )

      const existingByExternalId = await findOneWithDecryption(
        em,
        SyncExternalIdMapping,
        {
        integrationId,
        internalEntityType: entityType,
        externalId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
        },
        undefined,
        scope,
      )

      const existing = existingByExternalId ?? existingByLocalId

      if (existing) {
        const now = new Date()
        existing.internalEntityId = localId
        existing.externalId = externalId
        existing.syncStatus = 'synced'
        existing.lastSyncedAt = now
        existing.deletedAt = null
        if (options?.sourceReadAt !== undefined) {
          existing.sourceReadAt = options.sourceReadAt
        }
        if (
          existingByExternalId &&
          existingByLocalId &&
          existingByExternalId.id !== existingByLocalId.id
        ) {
          const duplicate = existing.id === existingByExternalId.id
            ? existingByLocalId
            : existingByExternalId
          duplicate.deletedAt = now
        }
        await em.flush()
        return existing
      }

      const created = em.create(SyncExternalIdMapping, {
        integrationId,
        internalEntityType: entityType,
        internalEntityId: localId,
        externalId,
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
        ...(options?.sourceReadAt !== undefined ? { sourceReadAt: options.sourceReadAt } : {}),
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      })

      await em.persist(created).flush()
      return created
    },

    async deleteExternalIdMapping(
      integrationId: string,
      entityType: string,
      localId: string,
      scope: MappingScope,
    ): Promise<boolean> {
      const row = await findOneWithDecryption(
        em,
        SyncExternalIdMapping,
        {
        integrationId,
        internalEntityType: entityType,
        internalEntityId: localId,
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
        },
        undefined,
        scope,
      )
      if (!row) return false
      row.deletedAt = new Date()
      await em.flush()
      return true
    },

    async deleteExternalIdMappings(
      integrationId: string,
      entityType: string,
      localIds: string[],
      scope: MappingScope,
    ): Promise<number> {
      const uniqueLocalIds = Array.from(new Set(localIds))
      if (uniqueLocalIds.length === 0) return 0
      const rows = await findWithDecryption(
        em,
        SyncExternalIdMapping,
        {
        integrationId,
        internalEntityType: entityType,
        internalEntityId: { $in: uniqueLocalIds },
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        deletedAt: null,
        },
        undefined,
        scope,
      )
      if (rows.length === 0) return 0
      const now = new Date()
      for (const row of rows) {
        row.deletedAt = now
      }
      await em.flush()
      return rows.length
    },
  }
}

export type ExternalIdMappingService = ReturnType<typeof createExternalIdMappingService>
