import { getApnsChannelAdapter, setApnsSenderFactory, type ApnsSender } from '../adapter'
import type { SendMessageInput } from '@open-mercato/core/modules/communication_channels/lib/adapter'

const credentials = {
  p8Key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
  keyId: 'ABC123KEYID',
  teamId: 'TEAM123456',
  bundleId: 'com.example.app',
  production: false,
}

function buildInput(overrides?: Partial<SendMessageInput>): SendMessageInput {
  return {
    content: {
      text: 'Body text',
      bodyFormat: 'text',
      raw: { title: 'Hello', body: 'Body text', data: { type: 'orders.shipped', notificationId: 'n1' } },
    },
    credentials,
    scope: { tenantId: 't1', organizationId: 'o1' },
    metadata: { pushToken: 'apns-device-token-abc', platform: 'ios' },
    ...overrides,
  }
}

afterEach(() => setApnsSenderFactory(null))

describe('ApnsChannelAdapter', () => {
  it('sends a notification with the bundle id as topic', async () => {
    const send: ApnsSender = jest.fn(async () => ({ ok: true }))
    setApnsSenderFactory(() => send)

    const result = await getApnsChannelAdapter().sendMessage(buildInput())

    expect(result.status).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
    const [payload, token] = (send as jest.Mock).mock.calls[0]
    expect(token).toBe('apns-device-token-abc')
    expect(payload).toMatchObject({ title: 'Hello', body: 'Body text', topic: 'com.example.app' })
    expect(payload.data).toEqual({ type: 'orders.shipped', notificationId: 'n1' })
  })

  it('fails fast when the push token is missing', async () => {
    const result = await getApnsChannelAdapter().sendMessage(buildInput({ metadata: { platform: 'ios' } }))
    expect(result.status).toBe('failed')
    expect(result.error).toBe('missing_push_token')
  })

  it('rejects invalid credentials without sending', async () => {
    const send = jest.fn()
    setApnsSenderFactory(() => send as unknown as ApnsSender)
    const result = await getApnsChannelAdapter().sendMessage(buildInput({ credentials: { p8Key: 'x' } }))
    expect(result.status).toBe('failed')
    expect(result.error).toBe('invalid_apns_credentials')
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['Unregistered', 'BadDeviceToken'])(
    'maps the %s rejection to the device_unregistered sentinel',
    async (reason) => {
      setApnsSenderFactory(() => async () => ({ ok: false, reason }))
      const result = await getApnsChannelAdapter().sendMessage(buildInput())
      expect(result.status).toBe('failed')
      expect(result.error).toBe('device_unregistered')
      expect(result.metadata?.unregistered).toBe(true)
    },
  )

  it('treats other rejections as transient failures', async () => {
    setApnsSenderFactory(() => async () => ({ ok: false, reason: 'TooManyRequests' }))
    const result = await getApnsChannelAdapter().sendMessage(buildInput())
    expect(result.status).toBe('failed')
    expect(result.error).toBe('TooManyRequests')
    expect(result.metadata?.unregistered).toBeUndefined()
  })

  it('reports transport errors as transient failures', async () => {
    setApnsSenderFactory(() => async () => ({ ok: false, error: 'socket hang up' }))
    const result = await getApnsChannelAdapter().sendMessage(buildInput())
    expect(result.status).toBe('failed')
    expect(result.error).toBe('socket hang up')
    expect(result.metadata?.unregistered).toBeUndefined()
  })
})
