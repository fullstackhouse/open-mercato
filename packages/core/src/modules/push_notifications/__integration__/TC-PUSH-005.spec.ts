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
 * TC-PUSH-005 — a retryable provider error is retried to `MAX_ATTEMPTS` and then expires.
 *
 * `expired` (retries exhausted) is a distinct terminal state from `failed` (permanent error), and the
 * device must survive: a transient provider outage must never soft-delete a user's device.
 *
 * Each attempt re-enqueues with exponential backoff + jitter (~1-2s, then ~2-3s), so a single drain can
 * only ever advance one attempt — the terminal state is unreachable without draining across the delays.
 */
const TOKEN_TAIL = 'FAIL0005'
const PROVIDER = 'fcm'
const MAX_ATTEMPTS = 3

test.describe('TC-PUSH-005: retryable failure → MAX_ATTEMPTS → expired', () => {
  test('retries a transient provider error to exhaustion without deactivating the device', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, userId } = getTokenScope(adminToken)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-PUSH-005 FCM')
      // `fail` in the token makes the fake SDK client throw an error with no `code`, so the adapter
      // classifies it as retryable rather than a permanent token error.
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-fcm-fail-token-${TOKEN_TAIL}`,
        `qa-tc-push-005-${Date.now()}`,
      )

      const createRes = await apiRequest(request, 'POST', NOTIFICATIONS_PATH, {
        token: adminToken,
        data: {
          recipientUserId: userId,
          type: 'admin.custom_message',
          title: 'TC-PUSH-005',
          body: 'Drives the retry branch.',
        },
      })
      expect(createRes.status()).toBe(201)
      expect((await readJsonSafe<{ id?: string }>(createRes))?.id).toBeTruthy()

      await drainIntegrationQueue('events')

      // One drain advances at most one attempt, and each re-enqueue is delayed by backoff. Drain
      // repeatedly until the row goes terminal or we run out of budget.
      await expect
        .poll(
          async () => {
            await drainIntegrationQueue('push-deliveries')
            return (await readLatestDelivery(tenantId, userDeviceId as string))?.status ?? null
          },
          { timeout: 60_000, intervals: [1_000] },
        )
        .toBe('expired')

      const row = await readLatestDelivery(tenantId, userDeviceId as string)
      expect(row?.attempts).toBe(MAX_ATTEMPTS)
      expect(row?.sent_at).toBeNull()
      expect(row?.last_error).toBeTruthy()
      // A transient failure is not a token verdict — the device must remain active.
      expect(await isDeviceSoftDeleted(userDeviceId as string)).toBe(false)
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
