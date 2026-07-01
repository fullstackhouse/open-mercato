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

// Minimal chainable stub for the `em.getKysely()` builder used by the fan-out insert.
// `insertResult` controls which rows the INSERT ... ON CONFLICT DO NOTHING reports as actually
// inserted (undefined ⇒ one row per input row, i.e. no conflict).
function makeKysely(insertResult?: Array<{ id: string }>) {
  const captured: {
    insertRows: Array<Record<string, unknown>> | null
    conflictColumns: string[] | null
    conflictWhere: unknown[] | null
    updates: Array<{ set: Record<string, unknown>; where: unknown[] }>
  } = { insertRows: null, conflictColumns: null, conflictWhere: null, updates: [] }

  const insertBuilder: Record<string, unknown> = {
    values: (rows: Array<Record<string, unknown>>) => {
      captured.insertRows = rows
      return insertBuilder
    },
    onConflict: (cb: (oc: unknown) => unknown) => {
      const oc: Record<string, unknown> = {
        columns: (cols: string[]) => {
          captured.conflictColumns = cols
          return oc
        },
        where: (...args: unknown[]) => {
          captured.conflictWhere = args
          return oc
        },
        doNothing: () => oc,
      }
      cb(oc)
      return insertBuilder
    },
    returning: () => insertBuilder,
    execute: async () => insertResult ?? (captured.insertRows ?? []).map((_, i) => ({ id: `del-${i + 1}` })),
  }

  const db = {
    insertInto: () => insertBuilder,
    updateTable: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (...where: unknown[]) => {
          captured.updates.push({ set, where })
          return { execute: async () => undefined }
        },
      }),
    }),
  }
  return { db, captured }
}

function makeCtx(opts: {
  channel?: Record<string, unknown> | null
  devices?: Array<Record<string, unknown>>
  insertResult?: Array<{ id: string }>
}) {
  const { db, captured } = makeKysely(opts.insertResult)
  const em = {
    getKysely: jest.fn(() => db),
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
  return { ctx, em, captured }
}

beforeEach(() => {
  getTypeMock.mockReset()
  resolvePrefsMock.mockReset()
  enqueueMock.mockClear()
  enqueueMock.mockResolvedValue('job-id')
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
    const { ctx, em } = makeCtx({ channel: null, devices: [{ id: 'dev-1', pushToken: 'tok' }] })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(em.getKysely).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('skips when the recipient has no push-capable devices', async () => {
    const { ctx, em } = makeCtx({ channel: { providerKey: 'push_stub' }, devices: [] })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(em.getKysely).not.toHaveBeenCalled()
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('inserts a pending delivery row per device and enqueues each', async () => {
    const { ctx, em, captured } = makeCtx({
      channel: { providerKey: 'push_stub' },
      devices: [
        { id: 'dev-1', pushToken: 'token-aaaaaaaa' },
        { id: 'dev-2', pushToken: 'token-bbbbbbbb' },
      ],
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(captured.insertRows).toHaveLength(2)
    expect(enqueueMock).toHaveBeenCalledTimes(2)
    // Devices are loaded scoped to the notification's organization (null here), never tenant-wide,
    // so an org-scoped notification cannot fan out to a device registered under a different org.
    expect(em.find).toHaveBeenCalledWith(deviceRef, expect.objectContaining({ organizationId: null }))
    // provider snapshotted, last-8 token snapshot, never the full token.
    const firstRow = captured.insertRows![0]
    expect(firstRow.provider).toBe('push_stub')
    expect(firstRow.token_snapshot).toBe('aaaaaaaa')
    expect(firstRow).not.toHaveProperty('pushToken')
    expect(firstRow.notification_id).toBe('notif-1')
    expect(firstRow.organization_id).toBeNull()
  })

  it('is idempotent on re-fan-out: enqueues only the rows ON CONFLICT actually inserted', async () => {
    // Simulate a redelivered subscriber event: the second run's INSERT ... ON CONFLICT DO NOTHING
    // finds both (notification, device) rows already present, so nothing is inserted → nothing enqueued.
    const { ctx, captured } = makeCtx({
      channel: { providerKey: 'push_stub' },
      devices: [
        { id: 'dev-1', pushToken: 'token-aaaaaaaa' },
        { id: 'dev-2', pushToken: 'token-bbbbbbbb' },
      ],
      insertResult: [],
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(captured.conflictColumns).toEqual(['notification_id', 'user_device_id'])
    expect(captured.conflictWhere).toEqual(['notification_id', 'is not', null])
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('marks a row failed when its enqueue throws (no orphan pending row)', async () => {
    enqueueMock.mockRejectedValueOnce(new Error('queue down'))
    const { ctx, captured } = makeCtx({
      channel: { providerKey: 'push_stub' },
      devices: [{ id: 'dev-1', pushToken: 'token-aaaaaaaa' }],
      insertResult: [{ id: 'del-1' }],
    })
    await mobilePushDeliveryStrategy.deliver(ctx)
    expect(captured.updates).toHaveLength(1)
    expect(captured.updates[0].set).toMatchObject({ status: 'failed' })
    expect(String((captured.updates[0].set as Record<string, unknown>).last_error)).toContain('enqueue_failed')
    expect(captured.updates[0].where).toEqual(['id', '=', 'del-1'])
  })
})
