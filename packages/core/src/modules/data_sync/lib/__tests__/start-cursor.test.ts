/** @jest-environment node */

import type { DataSyncAdapter } from '../adapter'
import type { SyncRunService } from '../sync-run-service'

const mockGetIntegration = jest.fn()

jest.mock('@open-mercato/shared/modules/integrations/types', () => ({
  getIntegration: (...args: unknown[]) => mockGetIntegration(...args),
}))

import { registerDataSyncAdapter } from '../adapter-registry'
import { resolveAdapterForIntegration, resolveStartCursor, resolveStartCursorWithOrigin } from '../start-cursor'

const REGISTRY_KEY = Symbol.for('@open-mercato/data-sync/adapter-registry')
const SCOPE = { organizationId: 'org-1', tenantId: 'tenant-1' }

function clearGlobalRegistry(): void {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY]
}

function buildSyncRunService() {
  return {
    resolveCursor: jest.fn(async () => 'shared-cursor'),
    resolveResumeCursor: jest.fn(async () => 'interrupted-run-cursor'),
    resolveResumeCursorWithSource: jest.fn(async () => ({ cursor: 'interrupted-run-cursor', runId: 'previous-run-id' })),
  } as unknown as SyncRunService
}

function buildAdapter(overrides: Partial<DataSyncAdapter> = {}): DataSyncAdapter {
  return {
    providerKey: 'backfill-provider',
    direction: 'import',
    supportedEntities: ['catalog.product'],
    getMapping: async ({ entityType }) => ({ entityType, matchStrategy: 'externalId' as const, fields: [] }),
    ...overrides,
  }
}

describe('resolveAdapterForIntegration', () => {
  beforeEach(() => {
    clearGlobalRegistry()
    jest.clearAllMocks()
  })

  afterEach(clearGlobalRegistry)

  it('resolves through the integration registry provider key', () => {
    const adapter = buildAdapter()
    registerDataSyncAdapter(adapter)
    mockGetIntegration.mockReturnValue({ providerKey: 'backfill-provider' })

    expect(resolveAdapterForIntegration('sync_backfill')).toBe(adapter)
  })

  it('falls back to the integration id when the integration declares no provider key', () => {
    const adapter = buildAdapter({ providerKey: 'sync_backfill' })
    registerDataSyncAdapter(adapter)
    mockGetIntegration.mockReturnValue(undefined)

    expect(resolveAdapterForIntegration('sync_backfill')).toBe(adapter)
  })

  it('returns null when no adapter is registered for the integration', () => {
    mockGetIntegration.mockReturnValue(undefined)

    expect(resolveAdapterForIntegration('sync_unregistered')).toBeNull()
  })
})

/**
 * `api/runs/[id]/retry.ts` and `workers/sync-scheduled.ts` reach the start-cursor
 * decision through `resolveAdapterForIntegration` rather than an adapter already
 * in scope, which is a different path from the one `api/run.test.ts` covers.
 */
describe('resolveStartCursor for callers that resolve the adapter by integration id', () => {
  beforeEach(() => {
    clearGlobalRegistry()
    jest.clearAllMocks()
    mockGetIntegration.mockReturnValue({ providerKey: 'backfill-provider' })
  })

  afterEach(clearGlobalRegistry)

  it('reads the shared row for an entity type that persists it', async () => {
    const syncRunService = buildSyncRunService()
    registerDataSyncAdapter(buildAdapter({ persistsSharedCursor: () => true }))

    const cursor = await resolveStartCursor({
      syncRunService,
      adapter: resolveAdapterForIntegration('sync_backfill'),
      integrationId: 'sync_backfill',
      entityType: 'catalog.product',
      direction: 'import',
      scope: SCOPE,
    })

    expect(cursor).toBe('shared-cursor')
    expect(syncRunService.resolveResumeCursorWithSource).not.toHaveBeenCalled()
  })

  it('resumes from the run row for an entity type that opted out', async () => {
    const syncRunService = buildSyncRunService()
    registerDataSyncAdapter(buildAdapter({
      persistsSharedCursor: (entityType: string) => entityType !== 'catalog.product',
    }))

    const cursor = await resolveStartCursor({
      syncRunService,
      adapter: resolveAdapterForIntegration('sync_backfill'),
      integrationId: 'sync_backfill',
      entityType: 'catalog.product',
      direction: 'import',
      scope: SCOPE,
    })

    expect(cursor).toBe('interrupted-run-cursor')
    expect(syncRunService.resolveCursor).not.toHaveBeenCalled()
  })

  it('reads the shared row when the integration resolves to no adapter at all', async () => {
    const syncRunService = buildSyncRunService()

    const cursor = await resolveStartCursor({
      syncRunService,
      adapter: resolveAdapterForIntegration('sync_unregistered'),
      integrationId: 'sync_unregistered',
      entityType: 'catalog.product',
      direction: 'import',
      scope: SCOPE,
    })

    expect(cursor).toBe('shared-cursor')
    expect(syncRunService.resolveResumeCursorWithSource).not.toHaveBeenCalled()
  })
})

/**
 * Provenance is the reason this resolver exists in the shape it does. Both branches inherit a
 * position the caller never named, so both report `inherited` — but only the previous-run branch can
 * name a run, and that asymmetry is what the run detail page and a scope-encoding adapter read.
 */
describe('resolveStartCursorWithOrigin', () => {
  beforeEach(() => {
    clearGlobalRegistry()
    jest.clearAllMocks()
    mockGetIntegration.mockReturnValue({ providerKey: 'backfill-provider' })
  })

  afterEach(clearGlobalRegistry)

  it('reports a shared-row cursor as inherited with no source run', async () => {
    const syncRunService = buildSyncRunService()
    registerDataSyncAdapter(buildAdapter({ persistsSharedCursor: () => true }))

    const resolved = await resolveStartCursorWithOrigin({
      syncRunService,
      adapter: resolveAdapterForIntegration('sync_backfill'),
      integrationId: 'sync_backfill',
      entityType: 'catalog.product',
      direction: 'import',
      scope: SCOPE,
    })

    expect(resolved).toEqual({ cursor: 'shared-cursor', origin: 'inherited', sourceRunId: null })
  })

  it('reports a resumed cursor as inherited and names the run it came from', async () => {
    const syncRunService = buildSyncRunService()
    registerDataSyncAdapter(buildAdapter({
      persistsSharedCursor: (entityType: string) => entityType !== 'catalog.product',
    }))

    const resolved = await resolveStartCursorWithOrigin({
      syncRunService,
      adapter: resolveAdapterForIntegration('sync_backfill'),
      integrationId: 'sync_backfill',
      entityType: 'catalog.product',
      direction: 'import',
      scope: SCOPE,
    })

    expect(resolved).toEqual({
      cursor: 'interrupted-run-cursor',
      origin: 'inherited',
      sourceRunId: 'previous-run-id',
    })
  })

  it('reports no cursor as none rather than inherited', async () => {
    const syncRunService = {
      resolveCursor: jest.fn(async () => null),
      resolveResumeCursor: jest.fn(async () => null),
      resolveResumeCursorWithSource: jest.fn(async () => ({ cursor: null, runId: null })),
    } as unknown as SyncRunService
    registerDataSyncAdapter(buildAdapter({ persistsSharedCursor: () => true }))

    const resolved = await resolveStartCursorWithOrigin({
      syncRunService,
      adapter: resolveAdapterForIntegration('sync_backfill'),
      integrationId: 'sync_backfill',
      entityType: 'catalog.product',
      direction: 'import',
      scope: SCOPE,
    })

    expect(resolved).toEqual({ cursor: null, origin: 'none', sourceRunId: null })
  })
})
