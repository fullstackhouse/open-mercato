import type { IntegrationCredentialsSchema } from '../types'
import {
  preserveUnchangedSecretCredentials,
  redactSecretCredentials,
  secretCredentialFieldKeys,
} from '../secret-fields'

// Example schema: host/port/db/user are plain text, password is the secret.
const SCHEMA: IntegrationCredentialsSchema = {
  fields: [
    { key: 'host', label: 'Host', type: 'text' },
    { key: 'port', label: 'Port', type: 'text' },
    { key: 'database', label: 'Database', type: 'text' },
    { key: 'user', label: 'User', type: 'text' },
    { key: 'password', label: 'Password', type: 'secret' },
  ],
}

describe('secretCredentialFieldKeys', () => {
  it('returns only type:secret field keys', () => {
    expect(secretCredentialFieldKeys(SCHEMA)).toEqual(['password'])
  })
  it('is empty for a schema with no secrets / no schema', () => {
    expect(secretCredentialFieldKeys({ fields: [{ key: 'host', label: 'Host', type: 'text' }] })).toEqual([])
    expect(secretCredentialFieldKeys(undefined)).toEqual([])
    expect(secretCredentialFieldKeys(null)).toEqual([])
  })
})

describe('redactSecretCredentials', () => {
  it('strips secret values, keeps non-secrets, and reports which secrets are set', () => {
    const { credentials, secretsSet } = redactSecretCredentials(
      { host: 'db.example.com', port: '5432', database: 'db', user: 'u', password: 'pw' },
      SCHEMA,
    )
    expect(credentials).toEqual({ host: 'db.example.com', port: '5432', database: 'db', user: 'u' })
    expect(credentials).not.toHaveProperty('password')
    expect(secretsSet).toEqual(['password'])
  })

  it('reports a secret as not-set when the stored value is empty/absent', () => {
    expect(redactSecretCredentials({ host: 'h', password: '' }, SCHEMA).secretsSet).toEqual([])
    expect(redactSecretCredentials({ host: 'h' }, SCHEMA).secretsSet).toEqual([])
  })

  it('does not mutate the input', () => {
    const input = { host: 'h', password: 'pw' }
    redactSecretCredentials(input, SCHEMA)
    expect(input).toEqual({ host: 'h', password: 'pw' })
  })
})

describe('preserveUnchangedSecretCredentials', () => {
  it('keeps the stored secret when the incoming one is empty (blank = unchanged)', () => {
    const merged = preserveUnchangedSecretCredentials(
      { host: 'db.example.com', password: '' },
      { host: 'old', password: 'stored-pw' },
      SCHEMA,
    )
    expect(merged).toEqual({ host: 'db.example.com', password: 'stored-pw' })
  })

  it('keeps the stored secret when the incoming one is omitted entirely', () => {
    const merged = preserveUnchangedSecretCredentials({ host: 'h' }, { password: 'stored-pw' }, SCHEMA)
    expect(merged.password).toBe('stored-pw')
  })

  it('uses the incoming secret when a new non-empty value is provided', () => {
    const merged = preserveUnchangedSecretCredentials({ password: 'new-pw' }, { password: 'stored-pw' }, SCHEMA)
    expect(merged.password).toBe('new-pw')
  })

  it('does not invent a secret when neither incoming nor stored has one', () => {
    expect(preserveUnchangedSecretCredentials({ host: 'h', password: '' }, {}, SCHEMA).password).toBe('')
    expect(preserveUnchangedSecretCredentials({ host: 'h' }, null, SCHEMA).password).toBeUndefined()
  })

  it('does not mutate either input', () => {
    const incoming = { password: '' }
    const existing = { password: 'stored-pw' }
    preserveUnchangedSecretCredentials(incoming, existing, SCHEMA)
    expect(incoming).toEqual({ password: '' })
    expect(existing).toEqual({ password: 'stored-pw' })
  })
})
