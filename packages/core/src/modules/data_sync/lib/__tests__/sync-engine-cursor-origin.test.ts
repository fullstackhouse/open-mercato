/** @jest-environment node */

import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { CredentialsService } from '../../../integrations/lib/credentials-service'
import type { IntegrationLogService } from '../../../integrations/lib/log-service'
import type { ProgressService } from '../../../progress/lib/progressService'
import { SyncCursor, SyncRun } from '../../data/entities'
import type { CursorOrigin, DataSyncAdapter, StreamImportInput, StreamExportInput } from '../adapter'
import { createSyncRunService } from '../sync-run-service'
import type { SyncRunService } from '../sync-run-service'

const mockGetDataSyncAdapter = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn().mockResolvedValue([]),
  findAndCountWithDecryption: jest.fn().mockResolvedValue([[], 0]),
}))

jest.mock('../adapter-registry', () => ({
  ...jest.requireActual('../adapter-registry'),
  getDataSyncAdapter: (...args: unknown[]) => mockGetDataSyncAdapter(...args),
}))

jest.mock('@open-mercato/shared/modules/integrations/types', () => ({
  getIntegration: () => ({ providerKey: 'origin-probe' }),
}))

jest.mock('../../events', () => ({
  emitDataSyncEvent: jest.fn(async () => undefined),
}))

jest.mock('../../../query_index/lib/coverage', () => ({
  refreshCoverageSnapshot: jest.fn(async () => undefined),
}))

import { createSyncEngine } from '../sync-engine'

const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1', userId: 'user-1' }
const ENTITY = 'catalog.product'

type FakeRun = {
  id: string
  integrationId: string
  entityType: string
  direction: 'import' | 'export'
  status: string
  cursor: string | null
  cursorOrigin: CursorOrigin | null
  progressJobId: string | null
  createdCount: number
  updatedCount: number
  skippedCount: number
  failedCount: number
  batchesCompleted: number
}

function buildRun(overrides: Partial<FakeRun> = {}): FakeRun {
  return {
    id: 'run-1',
    integrationId: 'sync_probe',
    entityType: ENTITY,
    direction: 'import',
    status: 'pending',
    cursor: null,
    cursorOrigin: null,
    progressJobId: null,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    batchesCompleted: 0,
    ...overrides,
  }
}

function buildFakeEm(runs: FakeRun[]) {
  const cursorRows: Record<string, unknown>[] = []
  const em = {
    begin: jest.fn(async () => undefined),
    commit: jest.fn(async () => undefined),
    rollback: jest.fn(async () => undefined),
    flush: jest.fn(async () => undefined),
    create: jest.fn((entity: unknown, data: Record<string, unknown>) => {
      const row = { ...data }
      if (entity === SyncCursor) cursorRows.push(row)
      return row
    }),
    nativeUpdate: jest.fn(async (_entity: unknown, where: { id: string }) => {
      const run = runs.find((candidate) => candidate.id === where.id)
      if (!run) return 0
      run.status = 'running'
      return 1
    }),
  }

  ;(findOneWithDecryption as jest.Mock).mockImplementation((_em: unknown, entity: unknown, where: Record<string, unknown>) => {
    if (entity === SyncRun) return Promise.resolve(runs.find((run) => run.id === where.id) ?? null)
    if (entity === SyncCursor) return Promise.resolve(null)
    return Promise.resolve(null)
  })

  return em
}

function buildEngineDeps(em: unknown, syncRunService: SyncRunService) {
  return {
    em: em as EntityManager,
    syncRunService,
    integrationCredentialsService: { resolve: jest.fn(async () => ({ token: 'secret' })) } as unknown as CredentialsService,
    integrationLogService: { write: jest.fn(async () => undefined) } as unknown as IntegrationLogService,
    integrationStateService: { upsert: jest.fn(async () => undefined) } as never,
    progressService: {
      startJob: jest.fn(async () => undefined),
      isCancellationRequested: jest.fn(async () => false),
      updateProgress: jest.fn(async () => undefined),
      completeJob: jest.fn(async () => undefined),
      failJob: jest.fn(async () => undefined),
      markCancelled: jest.fn(async () => undefined),
    } as unknown as ProgressService,
  }
}

/**
 * Captures what the adapter was actually handed, which is the only place the derivation is
 * observable — the run row keeps the start-time label either way.
 */
function buildProbeAdapter(seen: Array<CursorOrigin | undefined>, direction: 'import' | 'export' = 'import'): DataSyncAdapter {
  const stream = async function* (input: StreamImportInput | StreamExportInput) {
    seen.push(input.cursorOrigin)
    yield direction === 'import'
      ? { items: [], cursor: 'committed-cursor', hasMore: false, batchIndex: 0 }
      : { results: [], cursor: 'committed-cursor', hasMore: false, batchIndex: 0 }
  }
  return {
    providerKey: 'origin-probe',
    direction,
    supportedEntities: [ENTITY],
    getMapping: jest.fn(async ({ entityType }) => ({ entityType, matchStrategy: 'externalId' as const, fields: [] })),
    ...(direction === 'import' ? { streamImport: stream } : { streamExport: stream }),
  } as unknown as DataSyncAdapter
}

describe('sync engine reports the provenance of the cursor it is handing over', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('passes the stored origin on a first delivery', async () => {
    const run = buildRun({ cursor: 'inherited-cursor', cursorOrigin: 'inherited' })
    const em = buildFakeEm([run])
    const seen: Array<CursorOrigin | undefined> = []
    mockGetDataSyncAdapter.mockReturnValue(buildProbeAdapter(seen))

    const engine = createSyncEngine(buildEngineDeps(em, createSyncRunService(em as never)))
    await engine.runImport('run-1', 100, SCOPE)

    expect(seen).toEqual(['inherited'])
  })

  /**
   * The redelivery case. The run started from an inherited cursor but has since committed batches,
   * so the position it is being resumed from is its own. An adapter refusing `inherited` must not
   * refuse this.
   */
  it('reports self when the run has already committed batches', async () => {
    const run = buildRun({ cursor: 'advanced-cursor', cursorOrigin: 'inherited', batchesCompleted: 3 })
    const em = buildFakeEm([run])
    const seen: Array<CursorOrigin | undefined> = []
    mockGetDataSyncAdapter.mockReturnValue(buildProbeAdapter(seen))

    const engine = createSyncEngine(buildEngineDeps(em, createSyncRunService(em as never)))
    await engine.runImport('run-1', 100, SCOPE)

    expect(seen).toEqual(['self'])
  })

  it('reports none for a run that starts from no cursor', async () => {
    const run = buildRun({ cursor: null, cursorOrigin: 'none' })
    const em = buildFakeEm([run])
    const seen: Array<CursorOrigin | undefined> = []
    mockGetDataSyncAdapter.mockReturnValue(buildProbeAdapter(seen))

    const engine = createSyncEngine(buildEngineDeps(em, createSyncRunService(em as never)))
    await engine.runImport('run-1', 100, SCOPE)

    expect(seen).toEqual(['none'])
  })

  it('leaves the origin absent for a run written before provenance shipped', async () => {
    const run = buildRun({ cursor: 'legacy-cursor', cursorOrigin: null })
    const em = buildFakeEm([run])
    const seen: Array<CursorOrigin | undefined> = []
    mockGetDataSyncAdapter.mockReturnValue(buildProbeAdapter(seen))

    const engine = createSyncEngine(buildEngineDeps(em, createSyncRunService(em as never)))
    await engine.runImport('run-1', 100, SCOPE)

    expect(seen).toEqual([undefined])
  })

  it('reports provenance on the export path too', async () => {
    const run = buildRun({ id: 'run-export', direction: 'export', cursor: 'inherited-cursor', cursorOrigin: 'inherited' })
    const em = buildFakeEm([run])
    const seen: Array<CursorOrigin | undefined> = []
    mockGetDataSyncAdapter.mockReturnValue(buildProbeAdapter(seen, 'export'))

    const engine = createSyncEngine(buildEngineDeps(em, createSyncRunService(em as never)))
    await engine.runExport('run-export', 100, SCOPE)

    expect(seen).toEqual(['inherited'])
  })
})
