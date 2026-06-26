import { getNotificationType } from '../notification-type-registry'
import { createNotificationPreferenceService } from '../notificationPreferenceService'

jest.mock('../notification-type-registry', () => ({
  getNotificationType: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/commands/flush', () => ({
  withAtomicFlush: jest.fn(async (_em: unknown, phases: Array<() => unknown>) => {
    for (const phase of phases) await phase()
  }),
}))

const getTypeMock = getNotificationType as jest.MockedFunction<typeof getNotificationType>

const TENANT = '00000000-0000-0000-0000-000000000001'
const scope = { tenantId: TENANT, userId: 'user-1' }

function makeEm() {
  const fork = {
    find: jest.fn(async () => [] as unknown[]),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data })),
    persist: jest.fn(),
  }
  const em = { fork: jest.fn(() => fork) }
  return { em, fork }
}

describe('notificationPreferenceService.setPreferences', () => {
  beforeEach(() => {
    getTypeMock.mockReset()
    getTypeMock.mockReturnValue(undefined)
  })

  it('persists preferences for ordinary (opt-out-able) types', async () => {
    const { em, fork } = makeEm()
    const service = createNotificationPreferenceService({ em } as never)
    await service.setPreferences(scope, [{ typeId: 'orders.shipped', channel: 'push', enabled: false }])
    expect(fork.create).toHaveBeenCalledTimes(1)
    expect(fork.persist).toHaveBeenCalledTimes(1)
  })

  it('refuses to store an opt-out row for a nonOptOut type', async () => {
    getTypeMock.mockImplementation((type) =>
      type === 'auth.account.locked' ? ({ type, nonOptOut: true } as never) : undefined,
    )
    const { em, fork } = makeEm()
    const service = createNotificationPreferenceService({ em } as never)
    await service.setPreferences(scope, [{ typeId: 'auth.account.locked', channel: 'push', enabled: false }])
    // No writable items ⇒ never forks the EM or creates a row.
    expect(em.fork).not.toHaveBeenCalled()
    expect(fork.create).not.toHaveBeenCalled()
  })

  it('drops only the nonOptOut items from a mixed batch', async () => {
    getTypeMock.mockImplementation((type) =>
      type === 'auth.account.locked' ? ({ type, nonOptOut: true } as never) : undefined,
    )
    const { em, fork } = makeEm()
    const service = createNotificationPreferenceService({ em } as never)
    await service.setPreferences(scope, [
      { typeId: 'auth.account.locked', channel: 'push', enabled: false },
      { typeId: 'orders.shipped', channel: 'push', enabled: false },
    ])
    expect(fork.create).toHaveBeenCalledTimes(1)
    const created = fork.create.mock.calls[0][1] as Record<string, unknown>
    expect(created.notificationTypeId).toBe('orders.shipped')
  })
})
