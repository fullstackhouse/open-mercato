import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import {
  connectFakePushChannel,
  deleteChannelIfExists,
  deleteDeliveriesForDevice,
  deleteFakePushDevice,
  makeFakePushToken,
  registerFakePushDevice,
} from '@open-mercato/core/helpers/integration/pushFake'

/**
 * TC-PUSH-009 — the admin UI path: send a push from the admin page, then see it `sent` in the log.
 *
 * The only UI spec in Phase 8. It drives the real send form (recipient combobox → title → submit) and
 * then asserts the delivery detail page renders `Sent` with the last-8 token snapshot — proving the
 * REAL FCM adapter delivered and the admin observability surface reflects it.
 */
const PROVIDER = 'fcm'
const PUSH_TITLE = 'TC-PUSH-009 admin send'

async function readLatestDeliveryId(tenantId: string, userDeviceId: string): Promise<string | null> {
  return withClient(async (client) => {
    const res = await client.query(
      `select id from push_notification_deliveries
        where tenant_id = $1 and user_device_id = $2
        order by created_at desc limit 1`,
      [tenantId, userDeviceId],
    )
    return (res.rows[0]?.id as string | undefined) ?? null
  })
}

test.describe('TC-PUSH-009: admin send page → delivery log shows sent', () => {
  test('an admin-composed push reaches sent and is visible in the delivery log', async ({ page, request }) => {
    test.slow()
    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenScope(adminToken)
    const { pushToken, tokenTail } = makeFakePushToken(PROVIDER)

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-PUSH-009 FCM')
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        pushToken,
        `qa-tc-push-009-${Date.now()}`,
      )

      await login(page, 'admin')
      await page.goto('/backend/push_notifications/send')

      // The recipient is the admin itself — the device registered above belongs to them.
      const recipient = page.getByLabel('Recipient')
      await recipient.click()
      await recipient.fill('admin')
      await page.getByRole('option').first().click()

      await page.getByLabel('Title', { exact: true }).fill(PUSH_TITLE)

      // Wait for the send to actually land before draining. `.click()` only dispatches the event; draining
      // straight after would run the queues before the row that feeds them exists.
      const sendResponse = page.waitForResponse(
        (response) => response.url().includes('/api/push_notifications/custom-send') && response.request().method() === 'POST',
      )
      await page.getByRole('button', { name: 'Send push' }).click()
      expect((await sendResponse).status()).toBe(201)

      await drainIntegrationQueue('events')
      await drainIntegrationQueue('push-deliveries')

      await expect.poll(() => readLatestDeliveryId(tenantId, userDeviceId as string), { timeout: 30_000 }).toBeTruthy()
      const deliveryId = await readLatestDeliveryId(tenantId, userDeviceId as string)

      await page.goto(`/backend/push_notifications/${deliveryId}`)
      await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(tokenTail, { exact: false }).first()).toBeVisible()
    } finally {
      await deleteDeliveriesForDevice(userDeviceId)
      await deleteFakePushDevice(request, adminToken, userDeviceId)
      await deleteChannelIfExists(request, adminToken, channelId)
    }
  })
})
