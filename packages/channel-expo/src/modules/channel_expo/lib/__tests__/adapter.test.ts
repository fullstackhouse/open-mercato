import {
  getExpoChannelAdapter,
  setExpoClientFactory,
  type ExpoClientLike,
  type ExpoPushTicket,
} from '../adapter'
import type { SendMessageInput } from '@open-mercato/core/modules/communication_channels/lib/adapter'

function buildInput(overrides?: Partial<SendMessageInput>): SendMessageInput {
  return {
    content: {
      text: 'Body text',
      bodyFormat: 'text',
      raw: { title: 'Hello', body: 'Body text', data: { type: 'orders.shipped', notificationId: 'n1' } },
    },
    credentials: {},
    scope: { tenantId: 't1', organizationId: 'o1' },
    metadata: { pushToken: 'ExponentPushToken[abc]', platform: 'ios' },
    ...overrides,
  }
}

function buildClient(ticket: ExpoPushTicket, validToken = true): { client: ExpoClientLike; send: jest.Mock } {
  const send = jest.fn(async () => [ticket])
  const client: ExpoClientLike = { isExpoPushToken: () => validToken, send }
  return { client, send }
}

afterEach(() => setExpoClientFactory(null))

describe('ExpoChannelAdapter', () => {
  it('sends a push and returns the ticket id', async () => {
    const { client, send } = buildClient({ status: 'ok', id: 'ticket-1' })
    setExpoClientFactory(() => client)

    const result = await getExpoChannelAdapter().sendMessage(buildInput())

    expect(result.status).toBe('sent')
    expect(result.externalMessageId).toBe('ticket-1')
    const messages = send.mock.calls[0][0]
    expect(messages[0]).toMatchObject({
      to: 'ExponentPushToken[abc]',
      title: 'Hello',
      body: 'Body text',
      sound: 'default',
    })
    expect(messages[0].data).toEqual({ type: 'orders.shipped', notificationId: 'n1' })
  })

  it('sends a data-only content-available message when silent', async () => {
    const { client, send } = buildClient({ status: 'ok', id: 'ticket-silent' })
    setExpoClientFactory(() => client)

    const result = await getExpoChannelAdapter().sendMessage(
      buildInput({
        content: { raw: { title: '', body: '', data: { type: 'esim.installation_data' }, silent: true } },
      }),
    )

    expect(result.status).toBe('sent')
    const message = send.mock.calls[0][0][0]
    expect(message).toEqual({ to: 'ExponentPushToken[abc]', data: { type: 'esim.installation_data' }, _contentAvailable: true })
    expect(message.title).toBeUndefined()
    expect(message.body).toBeUndefined()
  })

  it('applies push options (sound/badge/priority/channel/image/body)', async () => {
    const { client, send } = buildClient({ status: 'ok', id: 'ticket-opts' })
    setExpoClientFactory(() => client)

    await getExpoChannelAdapter().sendMessage(
      buildInput({
        content: {
          raw: {
            title: 'Hello',
            body: 'Body text',
            data: {},
            options: {
              sound: 'chime.caf',
              badge: 5,
              priority: 'high',
              channelId: 'orders',
              image: 'https://cdn/x.png',
              body: 'override body',
            },
          },
        },
      }),
    )

    expect(send.mock.calls[0][0][0]).toMatchObject({
      to: 'ExponentPushToken[abc]',
      title: 'Hello',
      body: 'override body',
      sound: 'chime.caf',
      badge: 5,
      priority: 'high',
      channelId: 'orders',
      richContent: { image: 'https://cdn/x.png' },
    })
  })

  it('fails fast when the push token is missing', async () => {
    const result = await getExpoChannelAdapter().sendMessage(buildInput({ metadata: { platform: 'ios' } }))
    expect(result.status).toBe('failed')
    expect(result.error).toBe('missing_push_token')
  })

  it('maps a malformed Expo token to the device_unregistered sentinel', async () => {
    const { client, send } = buildClient({ status: 'ok' }, false)
    setExpoClientFactory(() => client)

    const result = await getExpoChannelAdapter().sendMessage(buildInput())

    expect(result.status).toBe('failed')
    expect(result.error).toBe('device_unregistered')
    expect(result.metadata?.unregistered).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('maps a DeviceNotRegistered ticket to the device_unregistered sentinel', async () => {
    const { client } = buildClient({ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } })
    setExpoClientFactory(() => client)

    const result = await getExpoChannelAdapter().sendMessage(buildInput())

    expect(result.status).toBe('failed')
    expect(result.error).toBe('device_unregistered')
    expect(result.metadata?.unregistered).toBe(true)
  })

  it('treats other ticket errors as transient failures', async () => {
    const { client } = buildClient({ status: 'error', message: 'MessageRateExceeded', details: { error: 'MessageRateExceeded' } })
    setExpoClientFactory(() => client)

    const result = await getExpoChannelAdapter().sendMessage(buildInput())

    expect(result.status).toBe('failed')
    expect(result.error).toBe('MessageRateExceeded')
    expect(result.metadata?.unregistered).toBeUndefined()
  })
})
