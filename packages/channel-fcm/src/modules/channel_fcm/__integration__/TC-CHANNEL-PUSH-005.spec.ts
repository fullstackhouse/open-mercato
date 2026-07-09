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
 * TC-CHANNEL-PUSH-005 — the REAL FCM adapter, end-to-end, without live credentials.
 *
 * `push_stub` replaces the whole adapter, so TC-PUSH-003 never executes a line of `channel-fcm`. Here
 * only the `firebase-admin` client is faked (`OM_PUSH_FAKE_PROVIDERS`), so the adapter's own credential
 * parsing, client caching, and `buildFcmMessage` all run: connect a tenant channel through the real
 * credential-connect route → register a device routed to `fcm` → `POST /api/notifications` → drain
 * `events` (fan-out) then `push-deliveries` (worker) → the delivery row reaches `sent` AND the
 * provider-native message the adapter handed the SDK is asserted.
 */
const TOKEN_TAIL = 'FCM00005'
const PROVIDER = 'fcm'

test.describe('TC-CHANNEL-PUSH-005: real FCM adapter reaches sent with a correct native message', () => {
  test('delivers a visible notification and maps pushOptions onto the FCM message', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, organizationId, userId } = getTokenScope(adminToken)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-CHANNEL-PUSH-005 FCM')
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-fcm-token-${TOKEN_TAIL}`,
        `qa-tc-channel-push-005-${Date.now()}`,
      )

      const createRes = await apiRequest(request, 'POST', NOTIFICATIONS_PATH, {
        token: adminToken,
        data: {
          recipientUserId: userId,
          type: 'admin.custom_message',
          title: 'Order shipped',
          body: 'Your order is on its way',
          data: { probe: 'tc-channel-push-005' },
          pushOptions: { channelId: 'orders', badge: 3, sound: 'chime.caf' },
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
      expect(row?.organization_id).toBe(organizationId ?? null)

      // The message firebase-admin would have transmitted — proof the real adapter, not a stub, ran.
      const native = await expectNativeMessage(PROVIDER, TOKEN_TAIL)
      expect(native.token).toBe(`qa-fcm-token-${TOKEN_TAIL}`)
      expect(native.notification).toMatchObject({ title: 'Order shipped', body: 'Your order is on its way' })
      expect(native.android).toMatchObject({ notification: { channelId: 'orders', sound: 'chime.caf' } })
      expect(native.apns).toMatchObject({ payload: { aps: { badge: 3, sound: 'chime.caf' } } })
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
