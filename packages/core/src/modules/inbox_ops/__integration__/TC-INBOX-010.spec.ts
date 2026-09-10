import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/modules/core/__integration__/helpers/api'
import { withClient } from '@open-mercato/core/modules/core/__integration__/helpers/dbFixtures'
import { readJsonSafe } from '@open-mercato/core/modules/core/__integration__/helpers/generalFixtures'
import { buildTrigramQuery } from '@open-mercato/shared/lib/search/trigram'

function decodeScope(token: string): { tenantId: string; organizationId: string } {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
    tenantId?: unknown
    orgId?: unknown
  }
  if (typeof payload.tenantId !== 'string' || typeof payload.orgId !== 'string') {
    throw new Error('[internal] Integration token does not contain a tenant and organization scope')
  }
  return { tenantId: payload.tenantId, organizationId: payload.orgId }
}

test.describe('TC-INBOX-010: Proposal trigram search', () => {
  test('returns a scoped proposal whose summary trigrams match', async ({ request }) => {
    const token = await getAuthToken(request)
    const scope = decodeScope(token)
    const emailId = randomUUID()
    const proposalId = randomUUID()
    const summary = `Searchable proposal ${Date.now()}`
    const query = summary.split(' ').at(-1)!

    try {
      await withClient(async (client) => {
        await client.query(
          `insert into inbox_emails
             (id, forwarded_by_address, to_address, subject, received_at, status, is_active, organization_id, tenant_id, created_at, updated_at)
           values ($1, 'sender@example.test', 'inbox@example.test', 'Token search fixture', now(), 'processed', true, $2, $3, now(), now())`,
          [emailId, scope.organizationId, scope.tenantId],
        )
        await client.query(
          `insert into inbox_proposals
             (id, inbox_email_id, summary, participants, confidence, status, possibly_incomplete, is_active, organization_id, tenant_id, created_at, updated_at)
           values ($1, $2, $3, '[]'::jsonb, 0.95, 'pending', false, true, $4, $5, now(), now())`,
          [proposalId, emailId, summary, scope.organizationId, scope.tenantId],
        )
        // The projection row is what list search reads, so the fixture seeds it directly with the
        // same keyed hashes the writer would have produced for this tenant.
        const trigramQuery = buildTrigramQuery({ term: query, tenantId: scope.tenantId })
        expect(trigramQuery, 'query should shape into trigrams').not.toBeNull()
        const hashes = Array.from(new Set(trigramQuery!.shapings.flatMap((shaping) => shaping.groups.flat())))
        await client.query(
          `insert into entity_indexes
             (id, entity_type, entity_id, organization_id, tenant_id, doc, search_trgm, index_version, created_at, updated_at)
           values (gen_random_uuid(), 'inbox_ops:inbox_proposal', $1, $2, $3, $4::jsonb, $5::int4[], 1, now(), now())
           on conflict (entity_type, entity_id, organization_id_coalesced)
           do update set search_trgm = excluded.search_trgm, doc = excluded.doc`,
          [proposalId, scope.organizationId, scope.tenantId, JSON.stringify({ summary }), hashes],
        )
      })

      const response = await apiRequest(
        request,
        'GET',
        `/api/inbox_ops/proposals?search=${encodeURIComponent(query)}&page=1&pageSize=10`,
        { token },
      )
      expect(response.status()).toBe(200)
      const body = await readJsonSafe<{ items?: Array<{ id?: string }> }>(response)
      expect(body?.items?.some((item) => item.id === proposalId)).toBeTruthy()
    } finally {
      await withClient(async (client) => {
        await client.query('delete from entity_indexes where entity_id = $1', [proposalId])
        await client.query('delete from inbox_proposals where id = $1', [proposalId])
        await client.query('delete from inbox_emails where id = $1', [emailId])
      })
    }
  })
})
