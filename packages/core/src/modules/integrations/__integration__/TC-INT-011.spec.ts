import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setUserAclVisibility,
} from '@open-mercato/core/modules/core/__integration__/helpers/authFixtures'
import {
  createOrganizationInDb,
  deleteIntegrationCredentialsInDb,
  deleteOrganizationInDb,
  deleteUserAclInDb,
} from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures'
import { getTokenScope, readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'

type JsonRecord = Record<string, unknown>

async function readJson(response: APIResponse): Promise<JsonRecord> {
  return ((await readJsonSafe<JsonRecord>(response)) ?? {}) as JsonRecord
}

type CredentialsRead = {
  status: number
  credentials: JsonRecord
  secretsSet: string[]
}

async function readCredentials(
  request: APIRequestContext,
  token: string,
  integrationId: string,
): Promise<CredentialsRead> {
  const response = await apiRequest(request, 'GET', `/api/integrations/${integrationId}/credentials`, { token })
  const body = await readJson(response)
  const credentials = body.credentials && typeof body.credentials === 'object' ? (body.credentials as JsonRecord) : {}
  const secretsSet = Array.isArray(body.secretsSet) ? (body.secretsSet as string[]) : []
  return { status: response.status(), credentials, secretsSet }
}

/**
 * Find the first registered integration whose credential schema declares a
 * `type:'secret'` field, returning both ids. Returns null when no provider with
 * a secret field is registered (e.g. a trimmed app) so the test can skip.
 */
async function pickSecretIntegration(
  request: APIRequestContext,
  token: string,
): Promise<{ integrationId: string; secretKey: string } | null> {
  const listResponse = await apiRequest(request, 'GET', '/api/integrations', { token })
  if (listResponse.status() !== 200) return null
  const body = await readJson(listResponse)
  const items = Array.isArray(body.items) ? (body.items as JsonRecord[]) : []
  for (const item of items) {
    const integrationId = String(item.id)
    const response = await apiRequest(request, 'GET', `/api/integrations/${integrationId}/credentials`, { token })
    if (response.status() !== 200) continue
    const detail = await readJson(response)
    const schema = detail.schema && typeof detail.schema === 'object' ? (detail.schema as JsonRecord) : {}
    const fields = Array.isArray(schema.fields) ? (schema.fields as JsonRecord[]) : []
    const secretField = fields.find((field) => field && field.type === 'secret' && typeof field.key === 'string')
    if (secretField) return { integrationId, secretKey: String(secretField.key) }
  }
  return null
}

/**
 * TC-INT-011: Write-only integration credential secrets [P0]
 *
 * Surfaces: GET/PUT /api/integrations/:id/credentials
 *
 * `type:'secret'` credential fields are write-only ("1-way visible"):
 *  - READ never returns the secret VALUE; it reports the key in `secretsSet`
 *    when a value is stored, so the UI can render "set — type to replace".
 *  - WRITE treats a blank/omitted secret as "unchanged" — re-saving the form
 *    (which re-submits every field) must never wipe a stored secret the
 *    operator did not retype. A newly typed secret replaces the stored one.
 *
 * Runs in a dedicated second org (created in the admin's tenant directly in the
 * DB, like TC-INT-008) so the choreography never mutates shared admin state and
 * tears everything down in `finally`. Requires the coherent app+DB stack from
 * the standard yarn test:integration / ephemeral harness.
 */
test.describe('TC-INT-011: Write-only integration credential secrets', () => {
  test('secret values are never read back and a blank submit preserves them', async ({ request }) => {
    test.slow()

    const stamp = Date.now()
    const password = 'Secret123!'
    const userEmail = `tc-int-011-${stamp}@example.com`
    const markerKey = `tcInt011Marker`

    const adminToken = await getAuthToken(request, 'admin')
    const { tenantId } = getTokenScope(adminToken)
    expect(tenantId, 'admin token should carry a tenant id').toBeTruthy()

    const secretIntegration = await pickSecretIntegration(request, adminToken)
    if (!secretIntegration) {
      test.skip(true, 'No integration provider with a type:secret credential field is registered')
      return
    }
    const { integrationId, secretKey } = secretIntegration

    // Probe encryption once up front so a misconfigured env skips rather than fails.
    const probe = await readCredentials(request, adminToken, integrationId)
    if (probe.status === 503) {
      test.skip(true, 'Integration credentials encryption is unavailable in this environment')
      return
    }
    expect(probe.status).toBe(200)

    const credentialsPath = `/api/integrations/${integrationId}/credentials`

    let orgId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null
    let userToken: string | null = null

    try {
      orgId = await createOrganizationInDb({ name: `TC-INT-011 Org ${stamp}`, tenantId: tenantId as string })
      roleId = await createRoleFixture(request, adminToken, { name: `TC-INT-011 Role ${stamp}` })
      userId = await createUserFixture(request, adminToken, {
        email: userEmail,
        password,
        organizationId: orgId,
        roles: [roleId],
      })
      await setUserAclVisibility(request, adminToken, {
        userId,
        features: ['integrations.view', 'integrations.manage', 'integrations.credentials.manage'],
        organizations: [orgId],
      })
      userToken = await getAuthToken(request, userEmail, password)

      // Fresh org: no secret stored yet.
      const initial = await readCredentials(request, userToken, integrationId)
      expect(initial.status, 'fresh org reads its own credentials').toBe(200)
      expect(initial.secretsSet, 'no secret is set yet').not.toContain(secretKey)

      // 1) Store a secret plus a non-secret marker.
      const firstSecret = `wo-secret-${stamp}`
      const save1 = await apiRequest(request, 'PUT', credentialsPath, {
        token: userToken,
        data: { credentials: { [secretKey]: firstSecret, [markerKey]: 'm1' } },
      })
      expect(save1.status(), 'storing a secret succeeds').toBe(200)

      // READ: the secret VALUE is never returned, but it is reported as set.
      const afterStore = await readCredentials(request, userToken, integrationId)
      expect(afterStore.credentials, 'secret value is never read back').not.toHaveProperty(secretKey)
      expect(afterStore.secretsSet, 'secret is reported as set').toContain(secretKey)
      expect(afterStore.credentials[markerKey], 'non-secret fields are returned verbatim').toBe('m1')

      // 2) Re-save with the secret BLANK and a changed non-secret field.
      //    The blank secret must be preserved (unchanged), not wiped.
      const save2 = await apiRequest(request, 'PUT', credentialsPath, {
        token: userToken,
        data: { credentials: { [secretKey]: '', [markerKey]: 'm2' } },
      })
      expect(save2.status(), 'a blank secret re-save succeeds').toBe(200)

      const afterBlank = await readCredentials(request, userToken, integrationId)
      expect(afterBlank.secretsSet, 'blank submit preserves the stored secret').toContain(secretKey)
      expect(afterBlank.credentials[markerKey], 'the non-secret field was updated').toBe('m2')

      // 3) Re-save OMITTING the secret entirely — still preserved.
      const save3 = await apiRequest(request, 'PUT', credentialsPath, {
        token: userToken,
        data: { credentials: { [markerKey]: 'm3' } },
      })
      expect(save3.status(), 'omitting the secret succeeds').toBe(200)

      const afterOmit = await readCredentials(request, userToken, integrationId)
      expect(afterOmit.secretsSet, 'omitting the secret preserves it').toContain(secretKey)
      expect(afterOmit.credentials[markerKey], 'the non-secret field was updated again').toBe('m3')

      // 4) A newly typed secret replaces the stored one (still never read back).
      const save4 = await apiRequest(request, 'PUT', credentialsPath, {
        token: userToken,
        data: { credentials: { [secretKey]: `wo-secret-${stamp}-rotated` } },
      })
      expect(save4.status(), 'rotating the secret succeeds').toBe(200)

      const afterRotate = await readCredentials(request, userToken, integrationId)
      expect(afterRotate.credentials, 'rotated secret value is still never read back').not.toHaveProperty(secretKey)
      expect(afterRotate.secretsSet, 'rotated secret is reported as set').toContain(secretKey)
    } finally {
      await deleteUserIfExists(request, adminToken, userId)
      await deleteUserAclInDb(userId ?? '').catch(() => undefined)
      await deleteRoleIfExists(request, adminToken, roleId)
      await deleteIntegrationCredentialsInDb(orgId).catch(() => undefined)
      await deleteOrganizationInDb(orgId).catch(() => undefined)
    }
  })
})
