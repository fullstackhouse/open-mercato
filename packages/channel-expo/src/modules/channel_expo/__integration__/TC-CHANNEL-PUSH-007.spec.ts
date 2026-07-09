import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenScope, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import {
  connectFakePushChannel,
  deleteChannelIfExists,
  deleteDeliveriesForDevice,
  DEVICES_PATH,
  expectNativeMessage,
  NOTIFICATIONS_PATH,
  readLatestDelivery,
  registerFakePushDevice,
} from '@open-mercato/core/helpers/integration/pushFake'

/**
 * TC-CHANNEL-PUSH-007 — the REAL Expo adapter, end-to-end, without live credentials.
 *
 * Only the `expo-server-sdk` client is faked (`OM_PUSH_FAKE_PROVIDERS`), so the adapter's token
 * validation, chunking, and `buildExpoMessage` run for real.
 */
const TOKEN_TAIL = 'EXPO0007'
const PROVIDER = 'expo'

test.describe('TC-CHANNEL-PUSH-007: real Expo adapter reaches sent with a correct native message', () => {
  test('maps sound and priority onto the Expo message', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, userId } = getTokenScope(adminToken)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-CHANNEL-PUSH-007 Expo')
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-expo-token-${TOKEN_TAIL}`,
        `qa-tc-channel-push-007-${Date.now()}`,
      )

      const createRes = await apiRequest(request, 'POST', NOTIFICATIONS_PATH, {
        token: adminToken,
        data: {
          recipientUserId: userId,
          type: 'admin.custom_message',
          title: 'Order shipped',
          body: 'Your order is on its way',
          data: { probe: 'tc-channel-push-007' },
          pushOptions: { sound: 'chime.caf', priority: 'high', channelId: 'orders' },
        },
      })
      expect(createRes.status()).toBe(201)
      expect((await readJsonSafe<{ id?: string }>(createRes))?.id).toBeTruthy()

      await drainIntegrationQueue('events')
      await drainIntegrationQueue('push-deliveries')

      await expect
        .poll(async () => (await readLatestDelivery(tenantId, userDeviceId as string))?.status ?? null, {
          timeout: 30_000,
        })
        .toBe('sent')

      const row = await readLatestDelivery(tenantId, userDeviceId as string)
      expect(row?.provider).toBe(PROVIDER)
      expect(row?.token_snapshot).toBe(TOKEN_TAIL)

      const native = await expectNativeMessage(PROVIDER, TOKEN_TAIL)
      expect(native.to).toBe(`qa-expo-token-${TOKEN_TAIL}`)
      expect(native.title).toBe('Order shipped')
      expect(native.body).toBe('Your order is on its way')
      expect(native.sound).toBe('chime.caf')
      expect(native.priority).toBe('high')
      expect(native.channelId).toBe('orders')
    } finally {
      await deleteDeliveriesForDevice(userDeviceId)
      if (userDeviceId) {
        await apiRequest(request, 'DELETE', `${DEVICES_PATH}/${userDeviceId}`, { token: adminToken }).catch(
          () => undefined,
        )
      }
      await deleteChannelIfExists(channelId)
    }
  })
})
