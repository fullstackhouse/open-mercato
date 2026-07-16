import { getNotificationType, getNotificationTypeChannelOverrides } from '../notification-type-registry'
import { createNotificationPreferenceService } from '../notificationPreferenceService'

jest.mock('../notification-type-registry', () => ({
  getNotificationType: jest.fn(),
  getNotificationTypeChannelOverrides: jest.fn(async () => new Map()),
}))

jest.mock('@open-mercato/shared/lib/commands/flush', () => ({
  withAtomicFlush: jest.fn(async (_em: unknown, phases: Array<() => unknown>) => {
    for (const phase of phases) await phase()
  }),
}))

const getTypeMock = getNotificationType as jest.MockedFunction<typeof getNotificationType>
const getStoredOverridesMock = getNotificationTypeChannelOverrides as jest.MockedFunction<
  typeof getNotificationTypeChannelOverrides
>

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
    getStoredOverridesMock.mockReset()
    getStoredOverridesMock.mockResolvedValue(new Map())
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

  it('allows an enabled: true row for a nonOptOut type (matches the forced-on state)', async () => {
    getTypeMock.mockImplementation((type) =>
      type === 'auth.account.locked' ? ({ type, nonOptOut: true } as never) : undefined,
    )
    const { em, fork } = makeEm()
    const service = createNotificationPreferenceService({ em } as never)
    await service.setPreferences(scope, [{ typeId: 'auth.account.locked', channel: 'push', enabled: true }])
    expect(fork.create).toHaveBeenCalledTimes(1)
    const created = fork.create.mock.calls[0][1] as Record<string, unknown>
    expect(created.notificationTypeId).toBe('auth.account.locked')
    expect(created.enabled).toBe(true)
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

  it('drops writes for a channel outside the stored eligibility override', async () => {
    getStoredOverridesMock.mockResolvedValue(new Map([['orders.shipped', ['in_app', 'email']]]))
    const { em, fork } = makeEm()
    const service = createNotificationPreferenceService({ em } as never)
    const changed = await service.setPreferences(scope, [
      { typeId: 'orders.shipped', channel: 'push', enabled: true },
      { typeId: 'orders.shipped', channel: 'email', enabled: false },
    ])
    expect(changed).toBe(1)
    expect(fork.create).toHaveBeenCalledTimes(1)
    const created = fork.create.mock.calls[0][1] as Record<string, unknown>
    expect(created.channel).toBe('email')
  })

  it('drops writes for a channel outside the code-declared eligibility (no override)', async () => {
    getTypeMock.mockImplementation((type) =>
      type === 'orders.shipped' ? ({ type, channels: ['in_app', 'email'] } as never) : undefined,
    )
    const { em, fork } = makeEm()
    const service = createNotificationPreferenceService({ em } as never)
    const changed = await service.setPreferences(scope, [
      { typeId: 'orders.shipped', channel: 'push', enabled: true },
    ])
    expect(changed).toBe(0)
    expect(fork.create).not.toHaveBeenCalled()
  })

  it('a stored override re-opening a channel lets the write through despite the code set', async () => {
    getTypeMock.mockImplementation((type) =>
      type === 'orders.shipped' ? ({ type, channels: ['in_app', 'email'] } as never) : undefined,
    )
    getStoredOverridesMock.mockResolvedValue(new Map([['orders.shipped', ['in_app', 'email', 'push']]]))
    const { em, fork } = makeEm()
    const service = createNotificationPreferenceService({ em } as never)
    const changed = await service.setPreferences(scope, [
      { typeId: 'orders.shipped', channel: 'push', enabled: false },
    ])
    expect(changed).toBe(1)
    expect(fork.create).toHaveBeenCalledTimes(1)
  })
})
