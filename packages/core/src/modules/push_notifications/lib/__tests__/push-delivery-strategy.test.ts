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
  channel?: Record<string, unknown> | null
  devices?: Array<Record<string, unknown>>
}) {
  const fork = {
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: `del-${Math.round(data.userDeviceId ? 1 : 0)}`, ...data })),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
  }
  const em = {
    fork: jest.fn(() => fork),
    findOne: jest.fn(async (entity: unknown) => (entity === channelRef ? (opts.channel ?? null) : null)),
    find: jest.fn(async (entity: unknown) => (entity === deviceRef ? (opts.devices ?? []) : [])),
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
  }
  const ctx = { notification, title: 'Shipped', body: 'Your order shipped', resolve } as never
  return { ctx, em, fork }
}

beforeEach(() => {
  getTypeMock.mockReset()
  resolvePrefsMock.mockReset()
  enqueueMock.mockClear()
  // Default: known type, push enabled.
  getTypeMock.mockReturnValue({ type: 'orders.shipped' } as never)
  resolvePrefsMock.mockReturnValue({ isChannelEnabled: jest.fn(async () => true) } as never)
})

describe('mobilePushDeliveryStrategy', () => {
  it('skips unknown notification types', async () => {
    getTypeMock.mockReturnValue(undefined)
    const { ctx, em } = makeCtx({})
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(em.findOne).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('skips when the recipient opted out of push for the type', async () => {
    resolvePrefsMock.mockReturnValue({ isChannelEnabled: jest.fn(async () => false) } as never)
    const { ctx, em } = makeCtx({ channel: { providerKey: 'push_stub' }, devices: [{ id: 'dev-1', pushToken: 'tok' }] })
    await mobilePushDeliveryStrategy.deliver(ctx)
    // The cheap per-tenant channel check runs first; on opt-out we never load devices or enqueue.
    expect(em.find).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('skips when no push channel is configured for the tenant', async () => {
    const { ctx, fork } = makeCtx({ channel: null, devices: [{ id: 'dev-1', pushToken: 'tok' }] })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(fork.flush).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('skips when the recipient has no push-capable devices', async () => {
    const { ctx, fork } = makeCtx({ channel: { providerKey: 'push_stub' }, devices: [] })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(fork.flush).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('inserts a pending delivery row per device and enqueues each', async () => {
    const { ctx, fork } = makeCtx({
      channel: { providerKey: 'push_stub' },
      devices: [
        { id: 'dev-1', pushToken: 'token-aaaaaaaa' },
        { id: 'dev-2', pushToken: 'token-bbbbbbbb' },
      ],
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(fork.create).toHaveBeenCalledTimes(2)
    expect(fork.persist).toHaveBeenCalledTimes(1)
    expect(fork.flush).toHaveBeenCalledTimes(1)
    expect(enqueueMock).toHaveBeenCalledTimes(2)
    // provider snapshotted, last-8 token snapshot, never the full token.
    const firstRow = fork.create.mock.calls[0][1] as Record<string, unknown>
    expect(firstRow.provider).toBe('push_stub')
    expect(firstRow.tokenSnapshot).toBe('aaaaaaaa')
    expect(firstRow).not.toHaveProperty('pushToken')
  })
})
