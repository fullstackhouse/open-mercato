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
 * TC-CHANNEL-PUSH-006 — the REAL APNs adapter, end-to-end, without live credentials.
 *
 * Only the `@parse/node-apn` sender is faked (`OM_PUSH_FAKE_PROVIDERS`), so the adapter's credential
 * resolution and `buildApnsNotification` run for real. The `.p8` key is never parsed because parsing
 * lives inside the sender factory the fake replaces — the connect route only schema-validates it.
 *
 * Asserted field names are node-apn's (`pushType`, `contentAvailable`), which the SDK serializes to the
 * wire `apns-push-type` header and `aps.content-available`.
 */
const VISIBLE_TAIL = 'APNS0006'
const SILENT_TAIL = 'APNSSIL6'
const PROVIDER = 'apns'

test.describe('TC-CHANNEL-PUSH-006: real APNs adapter reaches sent with a correct native notification', () => {
  test('maps pushOptions onto the aps payload for a visible notification', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, userId } = getTokenScope(adminToken)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-CHANNEL-PUSH-006 APNs')
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-apns-token-${VISIBLE_TAIL}`,
        `qa-tc-channel-push-006-${Date.now()}`,
      )

      const createRes = await apiRequest(request, 'POST', NOTIFICATIONS_PATH, {
        token: adminToken,
        data: {
          recipientUserId: userId,
          type: 'admin.custom_message',
          title: 'Order shipped',
          body: 'Your order is on its way',
          pushOptions: { badge: 5, sound: 'chime.caf' },
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

      const native = await expectNativeMessage(PROVIDER, VISIBLE_TAIL)
      expect(native.topic).toBe('com.openmercato.fake')
      expect(native.alert).toMatchObject({ title: 'Order shipped', body: 'Your order is on its way' })
      expect(native.badge).toBe(5)
      expect(native.sound).toBe('chime.caf')
      expect(native.contentAvailable).toBeUndefined()
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

  test('a silent type produces a background content-available push with no user-facing copy', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, userId } = getTokenScope(adminToken)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-CHANNEL-PUSH-006 APNs silent')
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-apns-token-${SILENT_TAIL}`,
        `qa-tc-channel-push-006-silent-${Date.now()}`,
      )

      // Silent-ness is a property of the registered type, never a per-call flag.
      const createRes = await apiRequest(request, 'POST', NOTIFICATIONS_PATH, {
        token: adminToken,
        data: {
          recipientUserId: userId,
          type: 'admin.custom_silent',
          title: 'Should not be delivered as copy',
          body: 'Should not be delivered as copy',
          data: { sync: 'orders' },
        },
      })
      expect(createRes.status()).toBe(201)

      await drainIntegrationQueue('events')
      await drainIntegrationQueue('push-deliveries')

      await expect
        .poll(async () => (await readLatestDelivery(tenantId, userDeviceId as string))?.status ?? null, {
          timeout: 30_000,
        })
        .toBe('sent')

      const row = await readLatestDelivery(tenantId, userDeviceId as string)
      expect(row?.silent).toBe(true)

      const native = await expectNativeMessage(PROVIDER, SILENT_TAIL)
      expect(native.contentAvailable).toBe(1)
      expect(native.pushType).toBe('background')
      expect(native.priority).toBe(5)
      expect(native.payload).toMatchObject({ sync: 'orders' })
      // A silent push must carry no visible copy.
      expect(native.alert).toBeUndefined()
      expect(native.sound).toBeUndefined()
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
