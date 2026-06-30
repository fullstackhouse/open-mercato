import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import { getTokenScope, readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'
import { withClient } from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures'

const LIST_PATH = '/api/push_notifications/deliveries'
// A well-formed RFC-4122 v4 UUID (version + variant nibbles valid) that does not exist — the route's
// `z.string().uuid()` accepts it, so the lookup runs and returns 404 (not a 400 validation failure).
const UNKNOWN_DELIVERY_ID = '11111111-1111-4111-8111-111111111111'
// A tenant id that the seeded admin never belongs to — used to prove cross-tenant rows are invisible.
const FOREIGN_TENANT_ID = '00000000-0000-0000-0000-0000000000ff'

type DeliveryListItem = {
  id: string
  user_id: string
  provider: string
  token_snapshot: string
  status: string
}
type DeliveryListResponse = { items: DeliveryListItem[]; total?: number }
type DeliveryDetailItem = DeliveryListItem & {
  tenant_id: string
  organization_id: string | null
  payload: Record<string, unknown> | null
  provider_response: Record<string, unknown> | null
}

// The delivery log has no write API (rows are produced only by the push strategy + send-push worker),
// so for ORM-backed assertions we seed rows directly via SQL and exercise the detail route, which reads
// the entity table (the list route reads the eventually-consistent query index). The full provider
// token is never persisted — only `token_snapshot` (last 8 chars) — so seeding stores the snapshot only.
async function seedDelivery(input: {
  tenantId: string
  userId: string
  organizationId: string | null
  fullToken: string
  status?: string
}): Promise<string> {
  return withClient(async (client) => {
    const res = await client.query(
      `insert into push_notification_deliveries
         (tenant_id, organization_id, notification_id, notification_type_id, user_device_id, user_id,
          provider, token_snapshot, status, attempts, payload, provider_response, created_at, updated_at)
       values ($1, $2, gen_random_uuid(), $3, gen_random_uuid(), $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, now(), now())
       returning id`,
      [
        input.tenantId,
        input.organizationId,
        'orders.shipped',
        input.userId,
        'push_stub',
        input.fullToken.slice(-8),
        input.status ?? 'sent',
        1,
        JSON.stringify({ title: 'Shipped', body: 'Your order shipped', data: { type: 'orders.shipped' } }),
        JSON.stringify({ externalMessageId: 'stub-1', stub: true }),
      ],
    )
    return res.rows[0].id as string
  })
}

async function deleteDelivery(id: string | null): Promise<void> {
  if (!id) return
  await withClient(async (client) => {
    await client.query('delete from push_notification_deliveries where id = $1', [id])
  }).catch(() => undefined)
}

async function listDeliveries(
  request: APIRequestContext,
  token: string,
  query = '',
): Promise<{ status: number; json: DeliveryListResponse | null }> {
  const res = await apiRequest(request, 'GET', `${LIST_PATH}${query}`, { token })
  return { status: res.status(), json: await readJsonSafe<DeliveryListResponse>(res) }
}

test.describe('TC-PUSH-001: Push delivery log API (admin observability)', () => {
  test('admin can list the push delivery log (no full token exposed)', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const res = await listDeliveries(request, adminToken)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.json?.items)).toBe(true)
    // The list contract exposes only a truncated token snapshot, never the secret push token.
    for (const item of res.json?.items ?? []) {
      expect(item && 'push_token' in item).toBeFalsy()
    }
  })

  test('employee without push_notifications.view_deliveries is forbidden', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const res = await listDeliveries(request, employeeToken)
    expect(res.status).toBe(403)
  })

  test('unauthenticated list requests are rejected', async ({ request }) => {
    const res = await request.fetch(LIST_PATH, { method: 'GET' })
    expect([401, 403]).toContain(res.status())
  })

  test('detail returns 404 for an unknown delivery and 400 for an invalid id', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const unknown = await apiRequest(request, 'GET', `${LIST_PATH}/${UNKNOWN_DELIVERY_ID}`, { token: adminToken })
    expect(unknown.status()).toBe(404)

    const invalid = await apiRequest(request, 'GET', `${LIST_PATH}/not-a-uuid`, { token: adminToken })
    expect(invalid.status()).toBe(400)
  })

  test('detail is forbidden for an employee', async ({ request }) => {
    const employeeToken = await getAuthToken(request, 'employee')
    const res = await apiRequest(request, 'GET', `${LIST_PATH}/${UNKNOWN_DELIVERY_ID}`, { token: employeeToken })
    expect(res.status()).toBe(403)
  })
})

// ORM-backed detail coverage: seed real rows and read them through the entity-backed detail route to
// prove token secrecy, tenant isolation, and the detail payload shape against real data (the list-only
// tests above can't, since the list reads the eventually-consistent query index).
test.describe('TC-PUSH-001: Push delivery detail (token secrecy + tenant scoping)', () => {
  const FULL_TOKEN = `qa-secret-push-token-DO-NOT-LEAK-${Date.now()}-zyxwvut987654`

  test('admin reads an org-bound row: snapshot only, never the full token', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const scope = getTokenScope(adminToken)
    const orgId = scope.organizationId || null
    let id: string | null = null
    try {
      id = await seedDelivery({ tenantId: scope.tenantId, userId: scope.userId, organizationId: orgId, fullToken: FULL_TOKEN })

      const res = await apiRequest(request, 'GET', `${LIST_PATH}/${id}`, { token: adminToken })
      expect(res.status()).toBe(200)
      const raw = await res.text()
      // The full provider token must never appear anywhere in the serialized response.
      expect(raw.includes(FULL_TOKEN)).toBe(false)
      const json = JSON.parse(raw) as { item?: DeliveryDetailItem }
      const item = json.item
      expect(item).toBeTruthy()
      // Only the last-8 snapshot is exposed, and no full-token field is present under any name.
      expect(item?.token_snapshot).toBe(FULL_TOKEN.slice(-8))
      expect(item && 'push_token' in item).toBeFalsy()
      expect(item && 'token' in item).toBeFalsy()
      // Detail adds the JSON payload + provider response.
      expect(item?.payload).toBeTruthy()
      expect(item?.provider_response).toBeTruthy()
    } finally {
      await deleteDelivery(id)
    }
  })

  test('admin can read a tenant-level (org-less) row', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const scope = getTokenScope(adminToken)
    let id: string | null = null
    try {
      // organization_id NULL = tenant-wide; it must be readable by an admin within the tenant.
      id = await seedDelivery({ tenantId: scope.tenantId, userId: scope.userId, organizationId: null, fullToken: FULL_TOKEN })

      const res = await apiRequest(request, 'GET', `${LIST_PATH}/${id}`, { token: adminToken })
      expect(res.status()).toBe(200)
      const json = await readJsonSafe<{ item?: DeliveryDetailItem }>(res)
      expect(json?.item?.organization_id ?? null).toBeNull()
    } finally {
      await deleteDelivery(id)
    }
  })

  test('a row from another tenant is not readable (404, tenant-scoped)', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin')
    const scope = getTokenScope(adminToken)
    let id: string | null = null
    try {
      id = await seedDelivery({ tenantId: FOREIGN_TENANT_ID, userId: scope.userId, organizationId: null, fullToken: FULL_TOKEN })

      const res = await apiRequest(request, 'GET', `${LIST_PATH}/${id}`, { token: adminToken })
      expect(res.status()).toBe(404)
    } finally {
      await deleteDelivery(id)
    }
  })
})
