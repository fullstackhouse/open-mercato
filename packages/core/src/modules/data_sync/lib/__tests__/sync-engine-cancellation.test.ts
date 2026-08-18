import type { EntityManager } from '@mikro-orm/postgresql'
import type { CredentialsService } from '../../../integrations/lib/credentials-service'
import type { IntegrationLogService } from '../../../integrations/lib/log-service'
import type { ProgressService } from '../../../progress/lib/progressService'
import { STALE_JOB_TIMEOUT_SECONDS } from '../../../progress/lib/progressService'
import type { DataSyncAdapter, ExportBatch, ImportBatch } from '../adapter'
import type { SyncRunService } from '../sync-run-service'

const mockGetDataSyncAdapter = jest.fn()
const mockGetIntegration = jest.fn()
const mockEmitDataSyncEvent = jest.fn(async () => undefined)
const mockRefreshCoverageSnapshot = jest.fn(async () => undefined)

jest.mock('../adapter-registry', () => ({
  getDataSyncAdapter: (...args: unknown[]) => mockGetDataSyncAdapter(...args),
}))

jest.mock('@open-mercato/shared/modules/integrations/types', () => ({
  getIntegration: (...args: unknown[]) => mockGetIntegration(...args),
}))

jest.mock('../../events', () => ({
  emitDataSyncEvent: (...args: unknown[]) => mockEmitDataSyncEvent(...args),
}))

jest.mock('../../../query_index/lib/coverage', () => ({
  refreshCoverageSnapshot: (...args: unknown[]) => mockRefreshCoverageSnapshot(...args),
}))

import { createSyncEngine } from '../sync-engine'

const CANCELLATION_TICK_MS = (STALE_JOB_TIMEOUT_SECONDS * 1000) / 4

const scope = {
  organizationId: 'org-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
}

function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise<void>(() => {})
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeSyncRunService(direction: 'import' | 'export', finalStatus: string): SyncRunService {
  const base = {
    id: 'run-1',
    integrationId: 'sync_akeneo',
    entityType: 'products',
    direction,
    progressJobId: 'job-1',
  }
  return {
    getRun: jest.fn(async () => ({ ...base, status: 'pending', cursor: null })),
    markStatus: jest
      .fn()
      .mockResolvedValueOnce({ ...base, status: 'running' })
      .mockResolvedValueOnce({
        ...base,
        status: finalStatus,
        createdCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        batchesCompleted: 0,
      }),
    commitBatchProgress: jest.fn(async () => undefined),
    updateCounts: jest.fn(async () => undefined),
    updateCursor: jest.fn(async () => undefined),
  } as unknown as SyncRunService
}

function makeProgressService(cancellationAnswers: boolean[]): ProgressService {
  let index = 0
  return {
    startJob: jest.fn(async () => undefined),
    updateProgress: jest.fn(async () => undefined),
    completeJob: jest.fn(async () => undefined),
    failJob: jest.fn(async () => undefined),
    markCancelled: jest.fn(async () => undefined),
    isCancellationRequested: jest.fn(async () => {
      const answer = cancellationAnswers[index] ?? cancellationAnswers[cancellationAnswers.length - 1] ?? false
      index += 1
      return answer
    }),
  } as unknown as ProgressService
}

function makeEngine(syncRunService: SyncRunService, progressService: ProgressService) {
  return createSyncEngine({
    em: {} as EntityManager,
    syncRunService,
    integrationCredentialsService: {
      resolve: jest.fn(async () => ({ apiUrl: 'https://example.test' })),
    } as unknown as CredentialsService,
    integrationLogService: {
      write: jest.fn(async () => undefined),
    } as unknown as IntegrationLogService,
    integrationStateService: { upsert: jest.fn(async () => undefined) } as any,
    progressService,
  })
}

const mapping = {
  entityType: 'products',
  fields: [],
  matchStrategy: 'externalId' as const,
}

function importBatch(index: number): ImportBatch {
  return {
    items: [{ externalId: `product-${index}`, action: 'create', data: {} }],
    cursor: `cursor-${index}`,
    hasMore: true,
    batchIndex: index,
  }
}

function exportBatch(index: number): ExportBatch {
  return {
    results: [{ localId: `local-${index}`, status: 'success' }],
    cursor: `cursor-${index}`,
    hasMore: true,
    batchIndex: index,
  }
}

describe('data sync engine cancellation reaches the adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetIntegration.mockReturnValue({ providerKey: 'akeneo' })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('runImport', () => {
    it('finalizes cancelled when a signal-honouring adapter returns without yielding', async () => {
      const entered = makeDeferred()
      const adapter: DataSyncAdapter = {
        providerKey: 'akeneo',
        direction: 'import',
        supportedEntities: ['products'],
        getMapping: jest.fn(async () => mapping),
        streamImport: async function* ({ signal }) {
          entered.resolve()
          await whenAborted(signal)
          if (signal?.aborted) return
          yield importBatch(0)
        },
      }
      mockGetDataSyncAdapter.mockReturnValue(adapter)

      const syncRunService = makeSyncRunService('import', 'cancelled')
      const progressService = makeProgressService([true])
      const engine = makeEngine(syncRunService, progressService)

      jest.useFakeTimers()
      const running = engine.runImport('run-1', 100, scope)
      await entered.promise
      await jest.advanceTimersByTimeAsync(CANCELLATION_TICK_MS)
      await running

      expect((syncRunService as any).markStatus).toHaveBeenLastCalledWith('run-1', 'cancelled', scope, undefined)
      expect((syncRunService as any).commitBatchProgress).not.toHaveBeenCalled()
      expect((progressService as any).markCancelled).toHaveBeenCalledWith('job-1', scope)
      expect((progressService as any).completeJob).not.toHaveBeenCalled()
      expect(mockEmitDataSyncEvent).toHaveBeenCalledWith('data_sync.run.cancelled', expect.objectContaining({ runId: 'run-1' }))
    })

    it('aborts the signal while a batch is still in flight', async () => {
      const entered = makeDeferred()
      let abortedMidBatch = false
      const adapter: DataSyncAdapter = {
        providerKey: 'akeneo',
        direction: 'import',
        supportedEntities: ['products'],
        getMapping: jest.fn(async () => mapping),
        streamImport: async function* ({ signal }) {
          entered.resolve()
          await whenAborted(signal)
          if (signal?.aborted) {
            abortedMidBatch = true
            return
          }
          yield importBatch(0)
        },
      }
      mockGetDataSyncAdapter.mockReturnValue(adapter)

      const syncRunService = makeSyncRunService('import', 'cancelled')
      const progressService = makeProgressService([true])
      const engine = makeEngine(syncRunService, progressService)

      jest.useFakeTimers()
      const running = engine.runImport('run-1', 100, scope)
      await entered.promise
      expect(abortedMidBatch).toBe(false)

      await jest.advanceTimersByTimeAsync(CANCELLATION_TICK_MS)
      await running

      expect(abortedMidBatch).toBe(true)
      expect((progressService as any).isCancellationRequested).toHaveBeenCalledWith('job-1', 'tenant-1', 'org-1')
    })

    it('still cancels between batches when the adapter ignores the signal', async () => {
      const yielded: number[] = []
      const adapter: DataSyncAdapter = {
        providerKey: 'akeneo',
        direction: 'import',
        supportedEntities: ['products'],
        getMapping: jest.fn(async () => mapping),
        streamImport: async function* () {
          for (const index of [0, 1, 2]) {
            yielded.push(index)
            yield importBatch(index)
          }
        },
      }
      mockGetDataSyncAdapter.mockReturnValue(adapter)

      const syncRunService = makeSyncRunService('import', 'cancelled')
      const progressService = makeProgressService([false, true])
      const engine = makeEngine(syncRunService, progressService)

      await engine.runImport('run-1', 100, scope)

      expect(yielded).toEqual([0, 1])
      expect((syncRunService as any).commitBatchProgress).toHaveBeenCalledTimes(1)
      expect((syncRunService as any).commitBatchProgress).toHaveBeenCalledWith('run-1', expect.anything(), 'cursor-0', scope)
      expect((syncRunService as any).markStatus).toHaveBeenLastCalledWith('run-1', 'cancelled', scope, undefined)
      expect((progressService as any).completeJob).not.toHaveBeenCalled()
    })
  })

  describe('runExport', () => {
    it('finalizes cancelled when a signal-honouring adapter returns without yielding', async () => {
      const entered = makeDeferred()
      const adapter: DataSyncAdapter = {
        providerKey: 'akeneo',
        direction: 'export',
        supportedEntities: ['products'],
        getMapping: jest.fn(async () => mapping),
        streamExport: async function* ({ signal }) {
          entered.resolve()
          await whenAborted(signal)
          if (signal?.aborted) return
          yield exportBatch(0)
        },
      }
      mockGetDataSyncAdapter.mockReturnValue(adapter)

      const syncRunService = makeSyncRunService('export', 'cancelled')
      const progressService = makeProgressService([true])
      const engine = makeEngine(syncRunService, progressService)

      jest.useFakeTimers()
      const running = engine.runExport('run-1', 100, scope)
      await entered.promise
      await jest.advanceTimersByTimeAsync(CANCELLATION_TICK_MS)
      await running

      expect((syncRunService as any).markStatus).toHaveBeenLastCalledWith('run-1', 'cancelled', scope, undefined)
      expect((syncRunService as any).commitBatchProgress).not.toHaveBeenCalled()
      expect((progressService as any).markCancelled).toHaveBeenCalledWith('job-1', scope)
      expect((progressService as any).completeJob).not.toHaveBeenCalled()
      expect(mockEmitDataSyncEvent).toHaveBeenCalledWith('data_sync.run.cancelled', expect.objectContaining({ runId: 'run-1' }))
    })

    it('aborts the signal while a batch is still in flight', async () => {
      const entered = makeDeferred()
      let abortedMidBatch = false
      const adapter: DataSyncAdapter = {
        providerKey: 'akeneo',
        direction: 'export',
        supportedEntities: ['products'],
        getMapping: jest.fn(async () => mapping),
        streamExport: async function* ({ signal }) {
          entered.resolve()
          await whenAborted(signal)
          if (signal?.aborted) {
            abortedMidBatch = true
            return
          }
          yield exportBatch(0)
        },
      }
      mockGetDataSyncAdapter.mockReturnValue(adapter)

      const syncRunService = makeSyncRunService('export', 'cancelled')
      const progressService = makeProgressService([true])
      const engine = makeEngine(syncRunService, progressService)

      jest.useFakeTimers()
      const running = engine.runExport('run-1', 100, scope)
      await entered.promise
      expect(abortedMidBatch).toBe(false)

      await jest.advanceTimersByTimeAsync(CANCELLATION_TICK_MS)
      await running

      expect(abortedMidBatch).toBe(true)
      expect((progressService as any).isCancellationRequested).toHaveBeenCalledWith('job-1', 'tenant-1', 'org-1')
    })

    it('still cancels between batches when the adapter ignores the signal', async () => {
      const yielded: number[] = []
      const adapter: DataSyncAdapter = {
        providerKey: 'akeneo',
        direction: 'export',
        supportedEntities: ['products'],
        getMapping: jest.fn(async () => mapping),
        streamExport: async function* () {
          for (const index of [0, 1, 2]) {
            yielded.push(index)
            yield exportBatch(index)
          }
        },
      }
      mockGetDataSyncAdapter.mockReturnValue(adapter)

      const syncRunService = makeSyncRunService('export', 'cancelled')
      const progressService = makeProgressService([false, true])
      const engine = makeEngine(syncRunService, progressService)

      await engine.runExport('run-1', 100, scope)

      expect(yielded).toEqual([0, 1])
      expect((syncRunService as any).commitBatchProgress).toHaveBeenCalledTimes(1)
      expect((syncRunService as any).commitBatchProgress).toHaveBeenCalledWith('run-1', expect.anything(), 'cursor-0', scope)
      expect((syncRunService as any).markStatus).toHaveBeenLastCalledWith('run-1', 'cancelled', scope, undefined)
      expect((progressService as any).completeJob).not.toHaveBeenCalled()
    })
  })
})
