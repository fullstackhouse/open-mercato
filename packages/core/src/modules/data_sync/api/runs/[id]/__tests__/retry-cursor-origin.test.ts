/** @jest-environment node */

const mockGetAuthFromRequest = jest.fn()
const mockCreateRequestContainer = jest.fn()
const mockGetIntegration = jest.fn()
const mockGetDataSyncAdapter = jest.fn()
const mockStartDataSyncRun = jest.fn()
const mockReadJsonSafe = jest.fn()

const mockSyncRunService = {
  getRun: jest.fn(),
  findRunningOverlap: jest.fn(),
  resolveCursor: jest.fn(),
  resolveResumeCursor: jest.fn(),
  resolveResumeCursorWithSource: jest.fn(),
}

const mockProgressService = {}

const mockCrudMutationGuardService = {
  validateMutation: jest.fn(),
  afterMutationSuccess: jest.fn(),
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn((request: Request) => mockGetAuthFromRequest(request)),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(() => mockCreateRequestContainer()),
}))

jest.mock('@open-mercato/shared/lib/http/readJsonSafe', () => ({
  readJsonSafe: jest.fn(async () => mockReadJsonSafe()),
}))

jest.mock('@open-mercato/shared/modules/integrations/types', () => ({
  getIntegration: jest.fn((id: string) => mockGetIntegration(id)),
}))

jest.mock('../../../../lib/adapter-registry', () => ({
  getDataSyncAdapter: jest.fn((providerKey: string) => mockGetDataSyncAdapter(providerKey)),
}))

// Keep the real `resolveStartCursorWithOrigin` — the fallback branch is exactly what this suite is
// here to pin down — and stub only the adapter lookup it shares with the route.
jest.mock('../../../../lib/start-cursor', () => ({
  ...jest.requireActual('../../../../lib/start-cursor'),
  resolveAdapterForIntegration: jest.fn((integrationId: string) =>
    mockGetDataSyncAdapter(mockGetIntegration(integrationId)?.providerKey ?? integrationId) ?? null),
}))

jest.mock('../../../../lib/start-run', () => ({
  startDataSyncRun: jest.fn((input) => mockStartDataSyncRun(input)),
}))

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const EARLIER_RUN_ID = '55555555-5555-4555-8555-555555555555'

type RouteModule = typeof import('../retry')
let postHandler: RouteModule['POST']

beforeAll(async () => {
  const routeModule = await import('../retry')
  postHandler = routeModule.POST
})

function callRetry() {
  const request = new Request(`http://localhost/api/data_sync/runs/${RUN_ID}/retry`, { method: 'POST' })
  return postHandler(request, { params: { id: RUN_ID } } as never)
}

function startedInput() {
  return mockStartDataSyncRun.mock.calls[0][0].input
}

/**
 * Retry is not uniformly explicit, which is the case the original report of this problem missed.
 * Resuming the previous run's own position is something the operator asked for; falling back
 * because that run never committed a batch inherits exactly like a fresh dashboard start. Labelling
 * all three the same way would make the discriminator a second thing to distrust.
 */
describe('data_sync retry route — cursor provenance', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadJsonSafe.mockReturnValue({})
    mockGetAuthFromRequest.mockResolvedValue({ sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' })
    mockCreateRequestContainer.mockResolvedValue({
      resolve: (token: string) => {
        if (token === 'dataSyncRunService') return mockSyncRunService
        if (token === 'progressService') return mockProgressService
        if (token === 'crudMutationGuardService') return mockCrudMutationGuardService
        throw new Error(`Unexpected token: ${token}`)
      },
    })
    mockCrudMutationGuardService.validateMutation.mockResolvedValue({ ok: true, shouldRunAfterSuccess: false, metadata: null })
    mockCrudMutationGuardService.afterMutationSuccess.mockResolvedValue(undefined)
    mockSyncRunService.findRunningOverlap.mockResolvedValue(null)
    mockSyncRunService.resolveCursor.mockResolvedValue(null)
    mockSyncRunService.resolveResumeCursorWithSource.mockResolvedValue({ cursor: null, runId: null })
    mockGetIntegration.mockReturnValue({ id: 'sync_excel', providerKey: 'excel' })
    mockGetDataSyncAdapter.mockReturnValue({
      providerKey: 'excel',
      direction: 'import',
      supportedEntities: ['customers.person'],
    })
    mockStartDataSyncRun.mockResolvedValue({
      run: { id: '44444444-4444-4444-8444-444444444444' },
      progressJob: { id: '66666666-6666-4666-8666-666666666666' },
    })
  })

  function previousRun(overrides: Record<string, unknown> = {}) {
    mockSyncRunService.getRun.mockResolvedValue({
      id: RUN_ID,
      integrationId: 'sync_excel',
      entityType: 'customers.person',
      direction: 'import',
      status: 'failed',
      cursor: null,
      parameters: null,
      ...overrides,
    })
  }

  it('labels resuming the previous run own position explicit, and names that run', async () => {
    previousRun({ cursor: 'previous-run-cursor' })

    await callRetry()

    expect(startedInput()).toMatchObject({
      cursor: 'previous-run-cursor',
      cursorOrigin: 'explicit',
      cursorSourceRunId: RUN_ID,
    })
  })

  it('labels a fromBeginning retry as none and resolves nothing', async () => {
    previousRun({ cursor: 'previous-run-cursor' })
    mockReadJsonSafe.mockReturnValue({ fromBeginning: true })

    await callRetry()

    expect(startedInput()).toMatchObject({
      cursor: null,
      cursorOrigin: 'none',
      cursorSourceRunId: null,
    })
    expect(mockSyncRunService.resolveCursor).not.toHaveBeenCalled()
    expect(mockSyncRunService.resolveResumeCursorWithSource).not.toHaveBeenCalled()
  })

  /**
   * The fallback. A retry of a run that never committed a batch has no position of its own to
   * resume, so it inherits from the shared row like any other start — and says so.
   */
  it('labels the shared-row fallback inherited when the previous run committed nothing', async () => {
    previousRun({ cursor: null })
    mockSyncRunService.resolveCursor.mockResolvedValue('shared-cursor')

    await callRetry()

    expect(startedInput()).toMatchObject({
      cursor: 'shared-cursor',
      cursorOrigin: 'inherited',
      cursorSourceRunId: null,
    })
  })

  it('names the source run when the fallback resumes an opted-out entity type', async () => {
    previousRun({ cursor: null })
    mockGetDataSyncAdapter.mockReturnValue({
      providerKey: 'excel',
      direction: 'import',
      supportedEntities: ['customers.person'],
      persistsSharedCursor: () => false,
    })
    mockSyncRunService.resolveResumeCursorWithSource.mockResolvedValue({
      cursor: 'interrupted-run-cursor',
      runId: EARLIER_RUN_ID,
    })

    await callRetry()

    expect(startedInput()).toMatchObject({
      cursor: 'interrupted-run-cursor',
      cursorOrigin: 'inherited',
      cursorSourceRunId: EARLIER_RUN_ID,
    })
  })

  it('labels a retry with nothing to resume as none rather than inherited', async () => {
    previousRun({ cursor: null })

    await callRetry()

    expect(startedInput()).toMatchObject({
      cursor: null,
      cursorOrigin: 'none',
      cursorSourceRunId: null,
    })
  })
})
