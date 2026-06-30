import { getNotificationType } from '@open-mercato/core/modules/notifications/lib/notification-type-registry'
import { fanOutPushDeliveries } from '../push-fanout'
import { sendSilentPush } from '../send-silent-push'

jest.mock('@open-mercato/core/modules/notifications/lib/notification-type-registry', () => ({
  getNotificationType: jest.fn(),
}))

jest.mock('../push-fanout', () => ({
  fanOutPushDeliveries: jest.fn(async () => ({ enqueued: 2 })),
}))

const getTypeMock = getNotificationType as jest.MockedFunction<typeof getNotificationType>
const fanOutMock = fanOutPushDeliveries as jest.MockedFunction<typeof fanOutPushDeliveries>

const TENANT = '00000000-0000-0000-0000-000000000001'
const resolve = (<T,>(name: string): T => ({ em: { __em: true } }[name] as T))

beforeEach(() => {
  getTypeMock.mockReset()
  fanOutMock.mockClear()
  fanOutMock.mockResolvedValue({ enqueued: 2 })
})

describe('sendSilentPush', () => {
  it('throws when the type is not registered', async () => {
    getTypeMock.mockReturnValue(undefined)
    await expect(
      sendSilentPush({ resolve, tenantId: TENANT, userId: 'u-1', type: 'unknown.type' }),
    ).rejects.toThrow(/not registered/)
    expect(fanOutMock).not.toHaveBeenCalled()
  })

  it('throws when the type is not declared silent', async () => {
    getTypeMock.mockReturnValue({ type: 'orders.shipped' } as never)
    await expect(
      sendSilentPush({ resolve, tenantId: TENANT, userId: 'u-1', type: 'orders.shipped' }),
    ).rejects.toThrow(/not declared silent/)
    expect(fanOutMock).not.toHaveBeenCalled()
  })

  it('fans out a silent payload with no notification id and the type folded into data', async () => {
    getTypeMock.mockReturnValue({ type: 'esim.installation_data', silent: true } as never)
    const result = await sendSilentPush({
      resolve,
      tenantId: TENANT,
      userId: 'u-1',
      organizationId: 'org-1',
      type: 'esim.installation_data',
      data: { subscriptionId: 's-1' },
      pushOptions: { priority: 'high' },
    })
    expect(result).toEqual({ enqueued: 2 })
    expect(fanOutMock).toHaveBeenCalledTimes(1)
    const args = fanOutMock.mock.calls[0][0]
    expect(args.notificationId).toBeNull()
    expect(args.notificationTypeId).toBe('esim.installation_data')
    expect(args.scope).toEqual({ tenantId: TENANT, organizationId: 'org-1' })
    expect(args.payload.silent).toBe(true)
    expect(args.payload.data).toEqual({ subscriptionId: 's-1', type: 'esim.installation_data' })
    expect(args.payload.options).toEqual({ priority: 'high' })
  })
})
