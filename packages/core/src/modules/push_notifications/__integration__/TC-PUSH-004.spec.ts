import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenScope, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import {
  connectFakePushChannel,
  deleteChannelIfExists,
  deleteDeliveriesForDevice,
  DEVICES_PATH,
  isDeviceSoftDeleted,
  NOTIFICATIONS_PATH,
  readLatestDelivery,
  registerFakePushDevice,
} from '@open-mercato/core/helpers/integration/pushFake'

/**
 * TC-PUSH-004 — a permanently-invalid token soft-deletes the device.
 *
 * The highest-risk path in the feature and, until now, the only one with no integration coverage:
 * three provider error vocabularies (`messaging/registration-token-not-registered`, APNs
 * `Unregistered`/`BadDeviceToken`, Expo `DeviceNotRegistered`) collapse into one `device_unregistered`
 * sentinel, which the worker turns into a `devices.devices.deactivate` command that soft-deletes a
 * user's device. `push_stub` short-circuits this by returning the sentinel directly; here the REAL FCM
 * adapter maps its own native error code, exactly as it would in production.
 *
 * Provider-agnostic worker behavior, so one provider suffices (the per-provider mappings are covered by
 * each adapter's unit suite; the FCM path is exercised here end-to-end).
 */
const TOKEN_TAIL = 'UNREG004'
const PROVIDER = 'fcm'

test.describe('TC-PUSH-004: unregistered token → delivery failed + device soft-deleted', () => {
  test('the real adapter maps its native permanent-token error to device deactivation', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, userId } = getTokenScope(adminToken)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-PUSH-004 FCM')
      // `unregistered` in the token makes the fake SDK client throw FCM's native
      // `messaging/registration-token-not-registered`, so the adapter's real mapping runs.
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-fcm-unregistered-token-${TOKEN_TAIL}`,
        `qa-tc-push-004-${Date.now()}`,
      )

      const createRes = await apiRequest(request, 'POST', NOTIFICATIONS_PATH, {
        token: adminToken,
        data: {
          recipientUserId: userId,
          type: 'admin.custom_message',
          title: 'TC-PUSH-004',
          body: 'Drives the unregistered branch.',
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
        .toBe('failed')

      const row = await readLatestDelivery(tenantId, userDeviceId as string)
      // Terminal `failed`, not `expired`: an unregistered token is permanent and must not be retried.
      expect(row?.last_error).toBe('device_unregistered')
      expect(row?.sent_at).toBeNull()

      await expect.poll(() => isDeviceSoftDeleted(userDeviceId as string), { timeout: 30_000 }).toBe(true)
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
