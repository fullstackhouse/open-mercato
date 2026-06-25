import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import { readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'
import { login } from '@open-mercato/core/modules/core/__integration__/helpers/auth'

const PREFERENCES_PAGE = '/backend/config/notification-preferences'

type NotificationTypeItem = { id: string; labelKey: string; descriptionKey?: string | null }
type TypesResponse = { items: NotificationTypeItem[] }

type PreferenceItem = { notificationTypeId: string; channel: string; enabled: boolean }
type PreferencesResponse = { items: PreferenceItem[] }

const TYPES_PATH = '/api/notifications/types'
const PREFERENCES_PATH = '/api/notifications/preferences'

let typeCounter = 0
function uniqueTypeId(): string {
  typeCounter += 1
  return `qa.notif.pref.${Date.now()}.${typeCounter}`
}

async function getTypes(request: APIRequestContext, token: string): Promise<TypesResponse> {
  const res = await apiRequest(request, 'GET', TYPES_PATH, { token })
  expect(res.status()).toBe(200)
  const json = await readJsonSafe<TypesResponse>(res)
  return json ?? { items: [] }
}

async function getPreferences(request: APIRequestContext, token: string): Promise<PreferenceItem[]> {
  const res = await apiRequest(request, 'GET', PREFERENCES_PATH, { token })
  expect(res.status()).toBe(200)
  const json = await readJsonSafe<PreferencesResponse>(res)
  return json?.items ?? []
}

async function putPreferences(
  request: APIRequestContext,
  token: string,
  preferences: PreferenceItem[],
): Promise<number> {
  const res = await apiRequest(request, 'PUT', PREFERENCES_PATH, {
    token,
    data: { preferences },
  })
  return res.status()
}

test.describe('TC-NOTIF-011: Notification type catalogue + channel preferences', () => {
  test('GET /types returns the code-registered catalogue mirrored to the DB', async ({ request }) => {
    const token = await getAuthToken(request, 'employee')
    const { items } = await getTypes(request, token)

    // The catalogue is the union of every module's notifications.ts; at least
    // one type is always registered (e.g. auth/customers). Validate shape.
    expect(Array.isArray(items)).toBe(true)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(typeof item.id).toBe('string')
      expect(item.id.length).toBeGreaterThan(0)
      expect(typeof item.labelKey).toBe('string')
      expect(item.labelKey.length).toBeGreaterThan(0)
    }
  })

  test('preferences default to enabled, round-trip on opt-out, and upsert idempotently', async ({ request }) => {
    const token = await getAuthToken(request, 'employee')
    const typeId = uniqueTypeId()
    const channel = 'push'

    // No row yet ⇒ not present in the stored list (treated as enabled by default).
    const before = await getPreferences(request, token)
    expect(before.some((p) => p.notificationTypeId === typeId)).toBe(false)

    // Opt out of push for this type.
    expect(await putPreferences(request, token, [{ notificationTypeId: typeId, channel, enabled: false }])).toBe(200)
    let rows = await getPreferences(request, token)
    let mine = rows.filter((p) => p.notificationTypeId === typeId && p.channel === channel)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.enabled).toBe(false)

    // Re-enable.
    expect(await putPreferences(request, token, [{ notificationTypeId: typeId, channel, enabled: true }])).toBe(200)
    rows = await getPreferences(request, token)
    mine = rows.filter((p) => p.notificationTypeId === typeId && p.channel === channel)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.enabled).toBe(true)

    // Idempotent upsert: applying the same preference again does not duplicate the row.
    expect(await putPreferences(request, token, [{ notificationTypeId: typeId, channel, enabled: true }])).toBe(200)
    rows = await getPreferences(request, token)
    mine = rows.filter((p) => p.notificationTypeId === typeId && p.channel === channel)
    expect(mine).toHaveLength(1)
  })

  test('rejects unauthenticated preference writes', async ({ request }) => {
    const res = await apiRequest(request, 'PUT', PREFERENCES_PATH, {
      token: '',
      data: { preferences: [{ notificationTypeId: uniqueTypeId(), channel: 'push', enabled: false }] },
    })
    // No valid principal ⇒ rejected by the auth guard (401) or the feature gate (403).
    expect([401, 403]).toContain(res.status())
  })

  test('preferences settings page renders and persists a toggle', async ({ page }) => {
    await login(page, 'employee')
    await page.goto(PREFERENCES_PAGE)

    await expect(page.getByRole('heading', { name: /Notification Preferences/i })).toBeVisible()

    const firstSwitch = page.getByRole('switch').first()
    await expect(firstSwitch).toBeVisible()

    const before = await firstSwitch.getAttribute('aria-checked')
    await firstSwitch.click()

    const savePromise = page.waitForResponse(
      (res) => res.url().includes('/api/notifications/preferences') && res.request().method() === 'PUT',
    )
    await page.getByRole('button', { name: /Save preferences/i }).click()
    const saveRes = await savePromise
    expect(saveRes.status()).toBe(200)

    await page.reload()
    const reloaded = page.getByRole('switch').first()
    await expect(reloaded).toBeVisible()
    await expect(reloaded).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')
  })
})
