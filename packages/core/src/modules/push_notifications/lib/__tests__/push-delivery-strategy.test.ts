import { getNotificationType } from '@open-mercato/core/modules/notifications/lib/notification-type-registry'
import { resolveNotificationPreferenceService } from '@open-mercato/core/modules/notifications/lib/notificationPreferenceService'
import { enqueuePushDelivery } from '../queue'
import { mobilePushDeliveryStrategy } from '../push-delivery-strategy'

jest.mock('@open-mercato/core/modules/notifications/lib/notification-type-registry', () => ({
  getNotificationType: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/notifications/lib/notificationPreferenceService', () => ({
  resolveNotificationPreferenceService: jest.fn(),
}))

jest.mock('../queue', () => ({
  enqueuePushDelivery: jest.fn(async () => 'job-id'),
  PUSH_DELIVERIES_QUEUE: 'push-deliveries',
}))

const getTypeMock = getNotificationType as jest.MockedFunction<typeof getNotificationType>
const resolvePrefsMock = resolveNotificationPreferenceService as jest.MockedFunction<typeof resolveNotificationPreferenceService>
const enqueueMock = enqueuePushDelivery as jest.MockedFunction<typeof enqueuePushDelivery>

const TENANT = '00000000-0000-0000-0000-000000000001'
const deviceRef = { __entity: 'UserDevice' }
const channelRef = { __entity: 'CommunicationChannel' }

function makeCtx(opts: {
  channels?: Array<Record<string, unknown>>
  devices?: Array<Record<string, unknown>>
  notification?: Record<string, unknown>
}) {
  const fork = {
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: `del-${data.userDeviceId}`, ...data })),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
  }
  const em = {
    fork: jest.fn(() => fork),
    find: jest.fn(async (entity: unknown) =>
      entity === channelRef ? (opts.channels ?? []) : entity === deviceRef ? (opts.devices ?? []) : [],
    ),
  }
  const resolve = (<T,>(name: string): T => {
    const map: Record<string, unknown> = { em, UserDevice: deviceRef, CommunicationChannel: channelRef }
    return map[name] as T
  })
  const notification = {
    id: 'notif-1',
    type: 'orders.shipped',
    recipientUserId: 'user-1',
    tenantId: TENANT,
    organizationId: null,
    linkHref: '/orders/1',
    ...(opts.notification ?? {}),
  }
  const ctx = { notification, title: 'Shipped', body: 'Your order shipped', resolve } as never
  return { ctx, em, fork }
}

const isChannelEnabledMock = jest.fn(async () => true)

beforeEach(() => {
  getTypeMock.mockReset()
  resolvePrefsMock.mockReset()
  enqueueMock.mockClear()
  isChannelEnabledMock.mockClear()
  isChannelEnabledMock.mockResolvedValue(true)
  // Default: known type, push enabled.
  getTypeMock.mockReturnValue({ type: 'orders.shipped' } as never)
  resolvePrefsMock.mockReturnValue({ isChannelEnabled: isChannelEnabledMock } as never)
})

describe('mobilePushDeliveryStrategy', () => {
  it('skips unknown notification types', async () => {
    getTypeMock.mockReturnValue(undefined)
    const { ctx, em } = makeCtx({})
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(em.find).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('skips when the recipient opted out of push for the type', async () => {
    isChannelEnabledMock.mockResolvedValue(false)
    const { ctx, fork } = makeCtx({
      channels: [{ providerKey: 'fcm' }],
      devices: [{ id: 'dev-1', pushToken: 'tok', pushProvider: 'fcm' }],
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    // The cheap per-tenant channel check runs first; on opt-out we never create rows or enqueue.
    expect(fork.create).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('skips when no push channel is configured for the tenant', async () => {
    const { ctx, fork } = makeCtx({ channels: [], devices: [{ id: 'dev-1', pushToken: 'tok', pushProvider: 'fcm' }] })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(fork.flush).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('skips when the recipient has no push-capable devices', async () => {
    const { ctx, fork } = makeCtx({ channels: [{ providerKey: 'fcm' }], devices: [] })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(fork.flush).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('inserts a pending delivery row per device and enqueues each', async () => {
    const { ctx, fork } = makeCtx({
      channels: [{ providerKey: 'fcm' }],
      devices: [
        { id: 'dev-1', pushToken: 'token-aaaaaaaa', pushProvider: 'fcm' },
        { id: 'dev-2', pushToken: 'token-bbbbbbbb', pushProvider: 'fcm' },
      ],
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(fork.create).toHaveBeenCalledTimes(2)
    expect(fork.persist).toHaveBeenCalledTimes(1)
    expect(fork.flush).toHaveBeenCalledTimes(1)
    expect(enqueueMock).toHaveBeenCalledTimes(2)
    // provider snapshotted, last-8 token snapshot, never the full token.
    const firstRow = fork.create.mock.calls[0][1] as Record<string, unknown>
    expect(firstRow.provider).toBe('fcm')
    expect(firstRow.tokenSnapshot).toBe('aaaaaaaa')
    expect(firstRow).not.toHaveProperty('pushToken')
  })

  it('routes each device to the push channel matching its provider', async () => {
    const { ctx, fork } = makeCtx({
      channels: [{ providerKey: 'apns' }, { providerKey: 'fcm' }],
      devices: [
        { id: 'ios-1', pushToken: 'ios-token-1', pushProvider: 'apns' },
        { id: 'android-1', pushToken: 'android-token-1', pushProvider: 'fcm' },
        // No expo channel configured ⇒ this device is skipped.
        { id: 'expo-1', pushToken: 'expo-token-1', pushProvider: 'expo' },
        // No provider on the device ⇒ skipped.
        { id: 'unknown-1', pushToken: 'unknown-token-1', pushProvider: null },
      ],
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(fork.create).toHaveBeenCalledTimes(2)
    expect(enqueueMock).toHaveBeenCalledTimes(2)
    const providersByDevice = Object.fromEntries(
      fork.create.mock.calls.map((call) => {
        const row = call[1] as Record<string, unknown>
        return [row.userDeviceId, row.provider]
      }),
    )
    expect(providersByDevice).toEqual({ 'ios-1': 'apns', 'android-1': 'fcm' })
  })

  it('threads caller data + pushOptions into the delivery payload', async () => {
    const { ctx, fork } = makeCtx({
      channels: [{ providerKey: 'fcm' }],
      devices: [{ id: 'dev-1', pushToken: 'token-aaaaaaaa', pushProvider: 'fcm' }],
      notification: { data: { orderId: 'o-1' }, pushOptions: { sound: 'chime.caf', badge: 3 } },
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    const row = fork.create.mock.calls[0][1] as { payload: Record<string, unknown>; silent: boolean }
    const payload = row.payload as { data: Record<string, string>; options: Record<string, unknown>; silent: boolean }
    expect(payload.data).toMatchObject({ orderId: 'o-1', notificationId: 'notif-1', type: 'orders.shipped' })
    expect(payload.options).toEqual({ sound: 'chime.caf', badge: 3 })
    expect(payload.silent).toBe(false)
    expect(row.silent).toBe(false)
  })

  it('delivers a nonOptOut-typed notification even when the recipient opted out', async () => {
    getTypeMock.mockReturnValue({ type: 'auth.account.locked', nonOptOut: true } as never)
    isChannelEnabledMock.mockResolvedValue(false)
    const { ctx, fork } = makeCtx({
      channels: [{ providerKey: 'fcm' }],
      devices: [{ id: 'dev-1', pushToken: 'token-aaaaaaaa', pushProvider: 'fcm' }],
      notification: { type: 'auth.account.locked' },
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    // Forced types never consult the opt-out gate and always fan out.
    expect(isChannelEnabledMock).not.toHaveBeenCalled()
    expect(fork.create).toHaveBeenCalledTimes(1)
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    // A forced visible notification is not silent.
    const row = fork.create.mock.calls[0][1] as { silent: boolean }
    expect(row.silent).toBe(false)
  })

  it('delivers a silent-typed notification without consulting preferences', async () => {
    getTypeMock.mockReturnValue({ type: 'orders.shipped', silent: true } as never)
    const { ctx, fork } = makeCtx({
      channels: [{ providerKey: 'fcm' }],
      devices: [{ id: 'dev-1', pushToken: 'token-aaaaaaaa', pushProvider: 'fcm' }],
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    // Silent (background) pushes are type-derived and bypass the user opt-out gate.
    expect(isChannelEnabledMock).not.toHaveBeenCalled()
    expect(enqueueMock).toHaveBeenCalledTimes(1)
    const row = fork.create.mock.calls[0][1] as { payload: { silent: boolean }; silent: boolean }
    expect(row.silent).toBe(true)
    expect(row.payload.silent).toBe(true)
  })
})
