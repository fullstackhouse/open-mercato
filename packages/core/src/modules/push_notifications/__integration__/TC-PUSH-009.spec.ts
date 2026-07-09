import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import {
  connectFakePushChannel,
  deleteChannelIfExists,
  deleteDeliveriesForDevice,
  DEVICES_PATH,
  registerFakePushDevice,
} from '@open-mercato/core/helpers/integration/pushFake'

/**
 * TC-PUSH-009 — the admin UI path: send a push from the admin page, then see it `sent` in the log.
 *
 * The only UI spec in Phase 8. It drives the real send form (recipient combobox → title → submit) and
 * then asserts the delivery detail page renders `Sent` with the last-8 token snapshot — proving the
 * REAL FCM adapter delivered and the admin observability surface reflects it.
 */
const TOKEN_TAIL = 'ADMINUI9'
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

    let channelId: string | null = null
    let userDeviceId: string | null = null
    try {
      channelId = await connectFakePushChannel(request, adminToken, PROVIDER, 'TC-PUSH-009 FCM')
      userDeviceId = await registerFakePushDevice(
        request,
        adminToken,
        PROVIDER,
        `qa-fcm-adminui-token-${TOKEN_TAIL}`,
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
      await page.getByRole('button', { name: 'Send push' }).click()

      await drainIntegrationQueue('events')
      await drainIntegrationQueue('push-deliveries')

      await expect.poll(() => readLatestDeliveryId(tenantId, userDeviceId as string), { timeout: 30_000 }).toBeTruthy()
      const deliveryId = await readLatestDeliveryId(tenantId, userDeviceId as string)

      await page.goto(`/backend/push_notifications/${deliveryId}`)
      await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(TOKEN_TAIL, { exact: false }).first()).toBeVisible()
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
