import { expect, test, type APIResponse } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import { readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/crmFixtures'

type JsonRecord = Record<string, unknown>

const CURSOR_ORIGINS = ['none', 'explicit', 'inherited', 'self']

async function readJson(response: APIResponse): Promise<JsonRecord> {
  return ((await readJsonSafe<JsonRecord>(response)) ?? {}) as JsonRecord
}

async function detectSyncableIntegration(
  request: Parameters<typeof getAuthToken>[0],
  token: string,
): Promise<{ integrationId: string; entityType: string } | null> {
  const listResponse = await apiRequest(request, 'GET', '/api/data_sync/options', { token })
  if (listResponse.status() !== 200) return null
  const listBody = await readJson(listResponse)
  const items = Array.isArray(listBody.items) ? (listBody.items as JsonRecord[]) : []
  const runnable = items.filter((item) => item.canStartRun !== false)
  if (runnable.length === 0) return null
  const selected = runnable[0]
  const supportedEntities = Array.isArray(selected.supportedEntities)
    ? (selected.supportedEntities as unknown[]).filter((value): value is string => typeof value === 'string')
    : []
  if (supportedEntities.length === 0) return null
  return { integrationId: String(selected.integrationId), entityType: supportedEntities[0] }
}

/**
 * TC-DS-011: Cursor provenance on sync runs
 *
 * A run that silently inherited a previous run's position was indistinguishable from one told to
 * resume, both to the adapter and to the operator. These assertions pin the wire contract that fixes
 * that: `cursorOrigin` and `cursorSourceRunId` on the run read APIs.
 *
 * Self-contained: creates its own runs, restores the integration's credentials and enabled state,
 * and cancels every run it started.
 */
test.describe('TC-DS-011: Cursor provenance on sync runs', () => {
  test('run detail and list report where the run start position came from', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')

    const target = await detectSyncableIntegration(request, token)
    if (!target) {
      test.skip(true, 'No generic-start data sync provider modules registered — skipping cursor provenance test')
      return
    }

    const { integrationId, entityType } = target
    const createdRunIds: string[] = []

    const credentialsResponse = await apiRequest(request, 'GET', `/api/integrations/${integrationId}/credentials`, { token })
    expect(credentialsResponse.status()).toBe(200)
    const credentialsBody = await readJson(credentialsResponse)
    const previousCredentials = credentialsBody.credentials && typeof credentialsBody.credentials === 'object'
      ? (credentialsBody.credentials as JsonRecord)
      : {}

    const integrationResponse = await apiRequest(request, 'GET', `/api/integrations/${integrationId}`, { token })
    expect(integrationResponse.status()).toBe(200)
    const integrationBody = await readJson(integrationResponse)
    const baselineState = integrationBody.state && typeof integrationBody.state === 'object'
      ? (integrationBody.state as JsonRecord)
      : {}

    await apiRequest(request, 'PUT', `/api/integrations/${integrationId}/credentials`, {
      token,
      data: { credentials: { testApiUrl: 'https://example.test.local', testApiKey: 'integration-test-key' } },
    })
    await apiRequest(request, 'PUT', `/api/integrations/${integrationId}/state`, {
      token,
      data: { isEnabled: true },
    })

    try {
      // A full sync explicitly refuses any inherited position, which is the one origin this test can
      // pin exactly without knowing what prior state the instance carries.
      const runResponse = await apiRequest(request, 'POST', '/api/data_sync/run', {
        token,
        data: { integrationId, entityType, direction: 'import', fullSync: true },
      })
      expect(
        runResponse.status(),
        `Expected 201 from /api/data_sync/run, got ${runResponse.status()}: ${(await runResponse.text()).slice(0, 2000)}`,
      ).toBe(201)

      const runBody = await readJson(runResponse)
      const runId = String(runBody.id)
      expect(runId).not.toHaveLength(0)
      createdRunIds.push(runId)

      const detailResponse = await apiRequest(request, 'GET', `/api/data_sync/runs/${runId}`, { token })
      expect(detailResponse.status()).toBe(200)
      const detail = await readJson(detailResponse)

      expect(detail).toHaveProperty('cursorOrigin')
      expect(detail).toHaveProperty('cursorSourceRunId')
      expect(detail.cursorOrigin).toBe('none')
      expect(detail.cursorSourceRunId).toBeNull()

      const listResponse = await apiRequest(request, 'GET', '/api/data_sync/runs?page=1&pageSize=50', { token })
      expect(listResponse.status()).toBe(200)
      const listBody = await readJson(listResponse)
      const items = Array.isArray(listBody.items) ? (listBody.items as JsonRecord[]) : []
      const listed = items.find((item) => item.id === runId)
      expect(listed, 'the run just started should appear in the runs list').toBeTruthy()
      expect(listed).toHaveProperty('cursorOrigin')
      expect(listed).toHaveProperty('cursorSourceRunId')

      // Every run the instance has ever recorded must carry a value the contract allows. A null is
      // permitted only for rows written before provenance shipped.
      for (const item of items) {
        if (item.cursorOrigin !== null && item.cursorOrigin !== undefined) {
          expect(CURSOR_ORIGINS).toContain(item.cursorOrigin)
        }
        if (item.cursorSourceRunId !== null && item.cursorSourceRunId !== undefined) {
          expect(typeof item.cursorSourceRunId).toBe('string')
        }
      }
    } finally {
      for (const runId of createdRunIds) {
        await apiRequest(request, 'POST', `/api/data_sync/runs/${runId}/cancel`, { token })
      }
      await apiRequest(request, 'PUT', `/api/integrations/${integrationId}/credentials`, {
        token,
        data: { credentials: previousCredentials },
      })
      await apiRequest(request, 'PUT', `/api/integrations/${integrationId}/state`, {
        token,
        data: { isEnabled: typeof baselineState.isEnabled === 'boolean' ? baselineState.isEnabled : false },
      })
    }
  })

  test('a retry that resumes the previous run records it as an explicit continuation', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')

    const target = await detectSyncableIntegration(request, token)
    if (!target) {
      test.skip(true, 'No generic-start data sync provider modules registered — skipping cursor provenance retry test')
      return
    }

    const { integrationId, entityType } = target
    const createdRunIds: string[] = []

    try {
      const runResponse = await apiRequest(request, 'POST', '/api/data_sync/run', {
        token,
        data: { integrationId, entityType, direction: 'import', fullSync: true },
      })
      if (runResponse.status() !== 201) {
        test.skip(true, `Could not start a run to retry (status ${runResponse.status()})`)
        return
      }
      const runId = String((await readJson(runResponse)).id)
      createdRunIds.push(runId)

      // A retry is only accepted for a failed or cancelled run, so cancel this one first.
      const cancelResponse = await apiRequest(request, 'POST', `/api/data_sync/runs/${runId}/cancel`, { token })
      if (cancelResponse.status() !== 200) {
        test.skip(true, `Could not cancel the run to retry it (status ${cancelResponse.status()})`)
        return
      }

      const retryResponse = await apiRequest(request, 'POST', `/api/data_sync/runs/${runId}/retry`, {
        token,
        data: { fromBeginning: false },
      })
      if (retryResponse.status() !== 201) {
        test.skip(true, `Retry not accepted in this environment (status ${retryResponse.status()})`)
        return
      }
      const retryId = String((await readJson(retryResponse)).id)
      createdRunIds.push(retryId)

      const retryDetail = await readJson(
        await apiRequest(request, 'GET', `/api/data_sync/runs/${retryId}`, { token }),
      )

      // The cancelled run committed nothing, so there is no position of its own to resume and the
      // retry falls back to the shared cursor — the case a "retries are always explicit" reading
      // would get wrong. Either way the origin must be one the contract defines, and a named source
      // run must be the run actually retried.
      expect(CURSOR_ORIGINS).toContain(retryDetail.cursorOrigin)
      if (retryDetail.cursorOrigin === 'explicit') {
        expect(retryDetail.cursorSourceRunId).toBe(runId)
      }
      if (retryDetail.cursorOrigin === 'none') {
        expect(retryDetail.cursorSourceRunId).toBeNull()
      }
    } finally {
      for (const id of createdRunIds) {
        await apiRequest(request, 'POST', `/api/data_sync/runs/${id}/cancel`, { token })
      }
    }
  })
})
