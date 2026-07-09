import path from 'node:path'
import { expect, test } from '@playwright/test'
import { createQueue } from '@open-mercato/queue'
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
 * TC-PUSH-008 — Expo's ASYNC receipt path prunes an uninstalled device.
 *
 * Expo delivery is two-phase, and this is the only provider where the common "app uninstalled" case is
 * invisible at send time: the ticket comes back `ok`, and `DeviceNotRegistered` only surfaces later in
 * the receipt. FCM and APNs report it synchronously (TC-PUSH-004). So the delivery row legitimately
 * reaches `sent` here, and the device is soft-deleted afterwards by the receipt reaper.
 *
 * The reaper rides the `push-stuck-reclaim` scheduler tick, which does not run under Playwright — the
 * spec enqueues one itself. It also skips rows younger than `OM_PUSH_RECEIPT_MIN_AGE_MINUTES`
 * (defaulted to 0 by the integration harness; 15 minutes in production).
 */
const TOKEN_TAIL = 'UNREG008'
const PROVIDER = 'expo'
const RECLAIM_QUEUE = 'push-stuck-reclaim'

const TEST_APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
const APP_ROOT = TEST_APP_ROOT ? path.resolve(TEST_APP_ROOT) : path.resolve(process.cwd(), 'apps/mercato')
const APP_QUEUE_BASE_DIR = path.resolve(APP_ROOT, '.mercato/queue')

async function enqueueReclaimTick(tenantId: string): Promise<void> {
  const queue = createQueue<{ tenantId: string }>(RECLAIM_QUEUE, 'local', { baseDir: APP_QUEUE_BASE_DIR })
  try {
    await queue.enqueue({ tenantId })
  } finally {
    await queue.close()
  }
}

test.describe('TC-PUSH-008: Expo async receipt reports DeviceNotRegistered → device pruned', () => {
  test('a sent delivery is later pruned when its receipt reports the device is gone', async ({ request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId, userId } = getTokenScope(adminToken)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-PUSH-008 Expo')
      // `unregistered` in the token makes the fake return an ACCEPTED ticket whose receipt later
      // reports `DeviceNotRegistered` — Expo's real two-phase behavior for an uninstalled app.
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-expo-unregistered-token-${TOKEN_TAIL}`,
        `qa-tc-push-008-${Date.now()}`,
      )

      const createRes = await apiRequest(request, 'POST', NOTIFICATIONS_PATH, {
        token: adminToken,
        data: {
          recipientUserId: userId,
          type: 'admin.custom_message',
          title: 'TC-PUSH-008',
          body: 'Drives the Expo receipt branch.',
        },
      })
      expect(createRes.status()).toBe(201)
      expect((await readJsonSafe<{ id?: string }>(createRes))?.id).toBeTruthy()

      await drainIntegrationQueue('events')
      await drainIntegrationQueue('push-deliveries')

      // The send itself succeeds: Expo accepted the message, so nothing yet says the token is dead.
      await expect
        .poll(async () => (await readLatestDelivery(tenantId, userDeviceId as string))?.status ?? null, {
          timeout: 30_000,
        })
        .toBe('sent')
      expect(await isDeviceSoftDeleted(userDeviceId as string)).toBe(false)

      await enqueueReclaimTick(tenantId)
      await drainIntegrationQueue(RECLAIM_QUEUE)

      // The receipt sweep is what discovers the dead token and prunes the device.
      await expect.poll(() => isDeviceSoftDeleted(userDeviceId as string), { timeout: 30_000 }).toBe(true)

      const row = await readLatestDelivery(tenantId, userDeviceId as string)
      expect(row?.last_error).toBe('device_unregistered')
      // The delivery stays `sent` — the send really did succeed; only the receipt failed later.
      expect(row?.status).toBe('sent')
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
