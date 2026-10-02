import { createContainer, asValue, InjectionMode } from 'awilix'
import { CommandBus, registerCommand, unregisterCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler, CommandLogMetadata } from '@open-mercato/shared/lib/commands'

type LogRecord = {
  changes?: Record<string, unknown> | null
  snapshotBefore?: unknown
  snapshotAfter?: unknown
}

const COMMAND_ID = 'test.records.reapply'

type Snapshot = Record<string, unknown>

function registerReapplyCommand(options: {
  before?: Snapshot
  after?: Snapshot
  buildLog?: CommandHandler['buildLog']
}) {
  registerCommand({
    id: COMMAND_ID,
    execute: jest.fn(async () => ({ id: 'rec-1' })),
    prepare: jest.fn(async () => (options.before ? { before: options.before } : {})),
    captureAfter: jest.fn(async () => options.after),
    buildLog: options.buildLog,
  })
}

function createBus() {
  const logMock = jest.fn(async (payload: LogRecord) => ({ id: 'log-1', ...payload }))
  const container = createContainer({ injectionMode: InjectionMode.CLASSIC })
  container.register({
    actionLogService: asValue({ log: logMock }),
    dataEngine: asValue({ flushOrmEntityChanges: jest.fn() }),
  })
  const ctx = {
    container,
    auth: { sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' },
    organizationScope: null,
    selectedOrganizationId: 'org-1',
    organizationIds: null,
  }
  const bus = new CommandBus()
  const execute = (metadata?: CommandLogMetadata) =>
    bus.execute(COMMAND_ID, {
      input: {},
      ctx,
      metadata: { resourceKind: 'test.record', resourceId: 'rec-1', ...metadata },
    })
  return { execute, logMock }
}

describe('CommandBus skipLogWhenUnchanged', () => {
  afterEach(() => {
    unregisterCommand(COMMAND_ID)
  })

  it('writes no action-log row when the flag is on and the snapshots are equal', async () => {
    registerReapplyCommand({
      before: { id: 'rec-1', name: 'Same', custom: { priority: 1 } },
      after: { id: 'rec-1', name: 'Same', custom: { priority: 1 } },
    })
    const { execute, logMock } = createBus()

    const { logEntry } = await execute({ skipLogWhenUnchanged: true })

    expect(logMock).not.toHaveBeenCalled()
    expect(logEntry).toBeNull()
  })

  it('treats a moved updatedAt alone as unchanged', async () => {
    registerReapplyCommand({
      before: { id: 'rec-1', name: 'Same', updatedAt: '2026-01-01T00:00:00.000Z' },
      after: { id: 'rec-1', name: 'Same', updatedAt: '2026-01-02T00:00:00.000Z' },
    })
    const { execute, logMock } = createBus()

    await execute({ skipLogWhenUnchanged: true })

    expect(logMock).not.toHaveBeenCalled()
  })

  it('writes the row with its changes when the flag is on and the snapshots differ', async () => {
    registerReapplyCommand({
      before: { id: 'rec-1', name: 'Old' },
      after: { id: 'rec-1', name: 'New' },
    })
    const { execute, logMock } = createBus()

    const { logEntry } = await execute({ skipLogWhenUnchanged: true })

    expect(logMock).toHaveBeenCalledTimes(1)
    expect(logMock.mock.calls[0]?.[0]?.changes).toEqual({ name: { from: 'Old', to: 'New' } })
    expect(logEntry).not.toBeNull()
  })

  it('writes the row when the handler reports changes the snapshots do not show', async () => {
    registerReapplyCommand({
      before: { id: 'rec-1', name: 'Same' },
      after: { id: 'rec-1', name: 'Same' },
      buildLog: async () => ({ changes: { externalRef: { from: 'a', to: 'b' } } }),
    })
    const { execute, logMock } = createBus()

    await execute({ skipLogWhenUnchanged: true })

    expect(logMock).toHaveBeenCalledTimes(1)
    expect(logMock.mock.calls[0]?.[0]?.changes).toEqual({ externalRef: { from: 'a', to: 'b' } })
  })

  it.each([
    ['before', { after: { id: 'rec-1', name: 'Same' } }],
    ['after', { before: { id: 'rec-1', name: 'Same' } }],
  ])('writes the row when the %s snapshot is missing', async (_missing, snapshots) => {
    registerReapplyCommand(snapshots)
    const { execute, logMock } = createBus()

    await execute({ skipLogWhenUnchanged: true })

    expect(logMock).toHaveBeenCalledTimes(1)
  })

  it('still writes the row for equal snapshots when the flag is off', async () => {
    registerReapplyCommand({
      before: { id: 'rec-1', name: 'Same' },
      after: { id: 'rec-1', name: 'Same' },
    })
    const { execute, logMock } = createBus()

    await execute()

    expect(logMock).toHaveBeenCalledTimes(1)
  })

  it("takes the flag from the handler's buildLog", async () => {
    registerReapplyCommand({
      before: { id: 'rec-1', name: 'Same' },
      after: { id: 'rec-1', name: 'Same' },
      buildLog: async () => ({ skipLogWhenUnchanged: true }),
    })
    const { execute, logMock } = createBus()

    await execute()

    expect(logMock).not.toHaveBeenCalled()
  })

  it("lets the handler's buildLog turn off a flag set on the execute call", async () => {
    registerReapplyCommand({
      before: { id: 'rec-1', name: 'Same' },
      after: { id: 'rec-1', name: 'Same' },
      buildLog: async () => ({ skipLogWhenUnchanged: false }),
    })
    const { execute, logMock } = createBus()

    await execute({ skipLogWhenUnchanged: true })

    expect(logMock).toHaveBeenCalledTimes(1)
  })
})
