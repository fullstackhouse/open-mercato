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
 * TC-PUSH-007 — `pushOptions` round-trips from the create API into the provider-native message.
 *
 * Covers the one option with cross-surface meaning: `pushOptions.body` overrides the *push* copy while
 * leaving the in-app notification body untouched. `TC-NOTIF-013` asserts the API round-trip; this
 * asserts the mapping onto the wire message built by the REAL adapter.
 */
const TOKEN_TAIL = 'OPTS0007'
const PROVIDER = 'fcm'
const IN_APP_BODY = 'In-app body stays as written'
const PUSH_BODY = 'Shortened push body'

test.describe('TC-PUSH-007: pushOptions round-trip into the native message', () => {
  test('body override applies to the push only, and image/badge/sound map per platform', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, userId } = getTokenScope(adminToken)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    let notificationId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-PUSH-007 FCM')
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-fcm-options-token-${TOKEN_TAIL}`,
        `qa-tc-push-007-${Date.now()}`,
      )

      const createRes = await apiRequest(request, 'POST', NOTIFICATIONS_PATH, {
        token: adminToken,
        data: {
          recipientUserId: userId,
          type: 'admin.custom_message',
          title: 'Order shipped',
          body: IN_APP_BODY,
          pushOptions: {
            body: PUSH_BODY,
            badge: 9,
            sound: 'chime.caf',
            image: 'https://cdn.example.com/hero.png',
            priority: 'normal',
          },
        },
      })
      expect(createRes.status()).toBe(201)
      const created = await readJsonSafe<{ id?: string }>(createRes)
      notificationId = created?.id ?? null
      expect(notificationId).toBeTruthy()

      await drainIntegrationQueue('events')
      await drainIntegrationQueue('push-deliveries')

      await expect
        .poll(async () => (await readLatestDelivery(tenantId, userDeviceId as string))?.status ?? null, {
          timeout: 30_000,
        })
        .toBe('sent')

      const native = await expectNativeMessage(PROVIDER, TOKEN_TAIL)
      // The push carries the override; the in-app notification body is unchanged (asserted below).
      expect(native.notification).toMatchObject({
        title: 'Order shipped',
        body: PUSH_BODY,
        imageUrl: 'https://cdn.example.com/hero.png',
      })
      expect(native.android).toMatchObject({
        priority: 'normal',
        notification: { sound: 'chime.caf', imageUrl: 'https://cdn.example.com/hero.png' },
      })
      expect(native.apns).toMatchObject({
        headers: { 'apns-priority': '5' },
        payload: { aps: { badge: 9, sound: 'chime.caf' } },
      })

      const listRes = await apiRequest(request, 'GET', NOTIFICATIONS_PATH, { token: adminToken })
      expect(listRes.status()).toBe(200)
      const list = await readJsonSafe<{ items?: Array<{ id: string; body?: string }> }>(listRes)
      const persisted = list?.items?.find((item) => item.id === notificationId)
      expect(persisted?.body).toBe(IN_APP_BODY)
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
