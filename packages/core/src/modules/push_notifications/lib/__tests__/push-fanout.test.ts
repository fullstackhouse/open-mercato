import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveNotificationCopy } from '@open-mercato/core/modules/notifications/lib/notificationCopy'
import { enqueuePushDelivery } from '../queue'
import { fanOutPushDeliveries } from '../push-fanout'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: jest.fn(async () => []),
}))

jest.mock('@open-mercato/core/modules/notifications/lib/notificationCopy', () => ({
  resolveNotificationCopy: jest.fn(async () => ({ title: 'translated-title', body: 'translated-body' })),
}))

jest.mock('../queue', () => ({
  enqueuePushDelivery: jest.fn(async () => 'job-id'),
  PUSH_DELIVERIES_QUEUE: 'push-deliveries',
}))

const findWithDecryptionMock = findWithDecryption as jest.MockedFunction<typeof findWithDecryption>
const resolveCopyMock = resolveNotificationCopy as jest.MockedFunction<typeof resolveNotificationCopy>
const enqueueMock = enqueuePushDelivery as jest.MockedFunction<typeof enqueuePushDelivery>

const TENANT = '00000000-0000-0000-0000-000000000001'
const channelRef = { __entity: 'CommunicationChannel' }
const deviceRef = { __entity: 'UserDevice' }

const resolve = (<T,>(name: string): T => (({
  CommunicationChannel: channelRef,
  UserDevice: deviceRef,
} as Record<string, unknown>)[name] as T))

function makeChannel(overrides: Record<string, unknown> = {}) {
  return { id: 'chan-1', providerKey: 'apns', channelType: 'push', isActive: true, deletedAt: null, ...overrides }
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dev-1',
    tenantId: TENANT,
    userId: 'user-1',
    pushProvider: 'apns',
    pushToken: 'super-secret-token-abcd1234',
    locale: null,
    deletedAt: null,
    ...overrides,
  }
}

function makeEm(channels: Array<Record<string, unknown>>) {
  const created: Array<Record<string, unknown>> = []
  let idCounter = 0
  const fork = {
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      const row = { id: `del-${++idCounter}`, ...data }
      created.push(row)
      return row
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => {}),
  }
  const em = {
    find: jest.fn(async () => channels),
    fork: jest.fn(() => fork),
  }
  return { em, fork, created }
}

const baseArgs = {
  scope: { tenantId: TENANT, organizationId: null as string | null },
  userId: 'user-1',
  notificationId: 'notif-1',
  notificationTypeId: 'orders.shipped',
  payload: { title: 'Hi', body: 'There', data: {} as Record<string, string> },
}

beforeEach(() => {
  findWithDecryptionMock.mockReset()
  findWithDecryptionMock.mockResolvedValue([])
  resolveCopyMock.mockClear()
  enqueueMock.mockReset()
  enqueueMock.mockResolvedValue('job-id')
})

describe('fanOutPushDeliveries', () => {
  it('skips entirely (no device load) when the tenant has no active push channel', async () => {
    const { em } = makeEm([])
    const result = await fanOutPushDeliveries({ em: em as never, resolve, ...baseArgs })
    expect(result).toEqual({ enqueued: 0 })
    expect(findWithDecryptionMock).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('skips when the recipient has no push-capable devices', async () => {
    const { em } = makeEm([makeChannel()])
    findWithDecryptionMock.mockResolvedValue([])
    const result = await fanOutPushDeliveries({ em: em as never, resolve, ...baseArgs })
    expect(result).toEqual({ enqueued: 0 })
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('decrypts devices scoped to the tenant + organization', async () => {
    const { em } = makeEm([makeChannel()])
    findWithDecryptionMock.mockResolvedValue([makeDevice()] as never)
    await fanOutPushDeliveries({
      em: em as never,
      resolve,
      ...baseArgs,
      scope: { tenantId: TENANT, organizationId: 'org-9' },
    })
    const call = findWithDecryptionMock.mock.calls[0]
    expect(call[2]).toMatchObject({ tenantId: TENANT, userId: 'user-1', deletedAt: null })
    expect(call[4]).toEqual({ tenantId: TENANT, organizationId: 'org-9' })
  })

  it('persists only the truncated token snapshot, never the full secret', async () => {
    const { em, created } = makeEm([makeChannel()])
    findWithDecryptionMock.mockResolvedValue([makeDevice()] as never)
    await fanOutPushDeliveries({ em: em as never, resolve, ...baseArgs })
    expect(created).toHaveLength(1)
    expect(created[0].tokenSnapshot).toBe('abcd1234')
    expect(JSON.stringify(created)).not.toContain('super-secret-token')
  })

  it('routes each device to its provider channel and skips devices with no/unknown provider', async () => {
    const { em, created } = makeEm([makeChannel({ providerKey: 'apns' }), makeChannel({ id: 'chan-2', providerKey: 'fcm' })])
    findWithDecryptionMock.mockResolvedValue([
      makeDevice({ id: 'dev-apns', pushProvider: 'apns' }),
      makeDevice({ id: 'dev-fcm', pushProvider: 'fcm' }),
      makeDevice({ id: 'dev-none', pushProvider: null }),
      makeDevice({ id: 'dev-expo', pushProvider: 'expo' }),
    ] as never)
    const result = await fanOutPushDeliveries({ em: em as never, resolve, ...baseArgs })
    expect(result).toEqual({ enqueued: 2 })
    expect(created.map((row) => row.userDeviceId)).toEqual(['dev-apns', 'dev-fcm'])
    expect(created.map((row) => row.provider)).toEqual(['apns', 'fcm'])
  })

  it('deduplicates channels by provider (first active channel wins)', async () => {
    const { em, created } = makeEm([
      makeChannel({ id: 'chan-primary', providerKey: 'apns' }),
      makeChannel({ id: 'chan-secondary', providerKey: 'apns' }),
    ])
    findWithDecryptionMock.mockResolvedValue([makeDevice({ pushProvider: 'apns' })] as never)
    await fanOutPushDeliveries({ em: em as never, resolve, ...baseArgs })
    expect(created).toHaveLength(1)
    expect(created[0].provider).toBe('apns')
  })

  it('marks the row failed and excludes it from the count when enqueue throws', async () => {
    const { em, created, fork } = makeEm([makeChannel()])
    findWithDecryptionMock.mockResolvedValue([
      makeDevice({ id: 'dev-1' }),
      makeDevice({ id: 'dev-2' }),
    ] as never)
    enqueueMock.mockResolvedValueOnce('job-1').mockRejectedValueOnce(new Error('broker down'))
    const result = await fanOutPushDeliveries({ em: em as never, resolve, ...baseArgs })
    expect(result).toEqual({ enqueued: 1 })
    expect(created[0].status).toBe('pending')
    expect(created[1].status).toBe('failed')
    expect(created[1].lastError).toBe('enqueue_failed: broker down')
    // initial insert flush + a second flush to persist the failure transition
    expect(fork.flush).toHaveBeenCalledTimes(2)
  })

  it('reuses the upstream copy for default-locale devices and translates for other locales', async () => {
    const { em, created } = makeEm([makeChannel()])
    findWithDecryptionMock.mockResolvedValue([
      makeDevice({ id: 'dev-en', locale: 'en' }),
      makeDevice({ id: 'dev-null', locale: null }),
      makeDevice({ id: 'dev-de', locale: 'de' }),
    ] as never)
    await fanOutPushDeliveries({
      em: em as never,
      resolve,
      ...baseArgs,
      copy: { title: 'Order shipped', body: 'It is on the way', titleKey: 'orders.shipped.title' } as never,
    })
    expect(created[0].payload).toMatchObject({ title: 'Order shipped', body: 'It is on the way' })
    expect(created[1].payload).toMatchObject({ title: 'Order shipped', body: 'It is on the way' })
    expect(created[2].payload).toMatchObject({ title: 'translated-title', body: 'translated-body' })
    // Only the non-default locale triggers a dictionary translation.
    expect(resolveCopyMock).toHaveBeenCalledTimes(1)
    expect(resolveCopyMock.mock.calls[0][1]).toBe('de')
  })

  it('fans out a silent payload without resolving any copy', async () => {
    const { em, created } = makeEm([makeChannel()])
    findWithDecryptionMock.mockResolvedValue([makeDevice()] as never)
    const result = await fanOutPushDeliveries({
      em: em as never,
      resolve,
      ...baseArgs,
      notificationId: null,
      payload: { data: { type: 'esim.installation_data' }, silent: true },
    })
    expect(result).toEqual({ enqueued: 1 })
    expect(created[0].silent).toBe(true)
    expect(created[0].notificationId).toBeNull()
    expect(resolveCopyMock).not.toHaveBeenCalled()
  })
})
