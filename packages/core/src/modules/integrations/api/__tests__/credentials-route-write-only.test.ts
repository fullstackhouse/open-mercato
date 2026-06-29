/** @jest-environment node */

import type { IntegrationCredentialsSchema } from '@open-mercato/shared/modules/integrations/types'

import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getIntegration } from '@open-mercato/shared/modules/integrations/types'
import {
  resolveUserFeatures,
  runIntegrationMutationGuardAfterSuccess,
  runIntegrationMutationGuards,
} from '../guards'
import { GET, PUT } from '../[id]/credentials/route'

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(),
}))

jest.mock('@open-mercato/shared/modules/integrations/types', () => ({
  ...jest.requireActual('@open-mercato/shared/modules/integrations/types'),
  getIntegration: jest.fn(),
}))

jest.mock('../../events', () => ({
  emitIntegrationsEvent: jest.fn(),
}))

jest.mock('../guards', () => ({
  resolveUserFeatures: jest.fn(() => []),
  runIntegrationMutationGuards: jest.fn(),
  runIntegrationMutationGuardAfterSuccess: jest.fn(),
}))

// Example schema: host/user are plain text, password is a write-only secret.
const exampleSchema: IntegrationCredentialsSchema = {
  fields: [
    { key: 'host', label: 'Host', type: 'text', required: true },
    { key: 'user', label: 'User', type: 'text' },
    { key: 'password', label: 'Password', type: 'secret', required: true },
  ],
}

function buildPutRequest(credentials: Record<string, unknown>): Request {
  return new Request('http://localhost/api/integrations/example_db/credentials', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credentials }),
  })
}

describe('integrations credentials route — write-only secrets', () => {
  const saveMock = jest.fn()
  // `resolve` resolves through the bundle (non-secret display); `getRaw` is the
  // integration's OWN row only. Secrets are integration-specific, so the route
  // reads `secretsSet` and the blank-secret preserve from `getRaw`, never the
  // bundle-inherited `resolve`.
  const resolveMock = jest.fn()
  const getRawMock = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    saveMock.mockReset()
    resolveMock.mockReset()
    getRawMock.mockReset()
    ;(getAuthFromRequest as jest.Mock).mockResolvedValue({ tenantId: 't1', orgId: 'o1', sub: 'u1' })
    ;(getIntegration as jest.Mock).mockReturnValue({ id: 'example_db', title: 'Example DB' })
    ;(runIntegrationMutationGuards as jest.Mock).mockResolvedValue({ ok: true })
    ;(createRequestContainer as jest.Mock).mockResolvedValue({
      resolve: (key: string) => {
        if (key === 'integrationCredentialsService') {
          return {
            getSchema: () => exampleSchema,
            resolve: resolveMock,
            getRaw: getRawMock,
            resolveUpdatedAt: jest.fn().mockResolvedValue(null),
            save: saveMock,
          }
        }
        throw new Error(`unexpected resolve(${key})`)
      },
    })
  })

  describe('GET', () => {
    it('never returns the secret value and reports its OWN secret as set', async () => {
      resolveMock.mockResolvedValue({ host: 'db.example.com', user: 'u', password: 'stored-pw' })
      getRawMock.mockResolvedValue({ host: 'db.example.com', user: 'u', password: 'stored-pw' })
      const response = await GET(new Request('http://localhost/api/integrations/example_db/credentials'), {
        params: { id: 'example_db' },
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.credentials).toEqual({ host: 'db.example.com', user: 'u' })
      expect(body.credentials).not.toHaveProperty('password')
      expect(body.secretsSet).toEqual(['password'])
    })

    it('reports the secret as not set when there is no stored value', async () => {
      resolveMock.mockResolvedValue({ host: 'db.example.com' })
      getRawMock.mockResolvedValue({ host: 'db.example.com' })
      const response = await GET(new Request('http://localhost/api/integrations/example_db/credentials'), {
        params: { id: 'example_db' },
      })
      const body = await response.json()
      expect(body.secretsSet).toEqual([])
      expect(body.credentials).toEqual({ host: 'db.example.com' })
    })

    it('does not report a bundle-inherited secret as set on the integration', async () => {
      // Bundle-backed: `resolve` falls back to the bundle's secret, but the
      // integration has no own row — `secretsSet` must stay empty.
      resolveMock.mockResolvedValue({ host: 'db.example.com', user: 'u', password: 'bundle-pw' })
      getRawMock.mockResolvedValue(null)
      const response = await GET(new Request('http://localhost/api/integrations/example_db/credentials'), {
        params: { id: 'example_db' },
      })
      const body = await response.json()
      expect(body.secretsSet).toEqual([])
      expect(body.credentials).not.toHaveProperty('password')
    })
  })

  describe('PUT', () => {
    it('preserves the integration\'s own stored secret when the submitted secret is blank', async () => {
      getRawMock.mockResolvedValue({ host: 'old', user: 'u', password: 'stored-pw' })
      const response = await PUT(buildPutRequest({ host: 'db.example.com', user: 'u', password: '' }), {
        params: { id: 'example_db' },
      })
      expect(response.status).toBe(200)
      expect(saveMock).toHaveBeenCalledWith(
        'example_db',
        { host: 'db.example.com', user: 'u', password: 'stored-pw' },
        { organizationId: 'o1', tenantId: 't1' },
      )
      expect(runIntegrationMutationGuardAfterSuccess).toHaveBeenCalled()
    })

    it('writes a newly typed secret through unchanged', async () => {
      getRawMock.mockResolvedValue({ host: 'old', password: 'stored-pw' })
      const response = await PUT(buildPutRequest({ host: 'db.example.com', user: 'u', password: 'new-pw' }), {
        params: { id: 'example_db' },
      })
      expect(response.status).toBe(200)
      expect(saveMock).toHaveBeenCalledWith(
        'example_db',
        { host: 'db.example.com', user: 'u', password: 'new-pw' },
        { organizationId: 'o1', tenantId: 't1' },
      )
    })

    it('does NOT inherit a bundle secret on a blank submit (no own row)', async () => {
      // Bundle has a secret, but the integration has no own row. A blank secret
      // must stay blank — we never copy the bundle's secret into the row.
      getRawMock.mockResolvedValue(null)
      resolveMock.mockResolvedValue({ host: 'old', password: 'bundle-pw' })
      const response = await PUT(buildPutRequest({ host: 'db.example.com', user: 'u', password: '' }), {
        params: { id: 'example_db' },
      })
      expect(response.status).toBe(200)
      const savedCredentials = saveMock.mock.calls[0][1]
      // The bundle's secret is NOT copied in; the submitted blank stays blank.
      expect(savedCredentials.password).not.toBe('bundle-pw')
      expect(savedCredentials).toEqual({ host: 'db.example.com', user: 'u', password: '' })
    })
  })
})
