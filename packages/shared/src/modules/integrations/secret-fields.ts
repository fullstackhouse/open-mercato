import type { IntegrationCredentialsSchema } from './types'

/**
 * Write-only secret credential fields.
 *
 * Integration credential fields of `type: 'secret'` (API passwords, tokens, …)
 * are encrypted at rest, but "encrypted at rest" is not the same as "never
 * readable by an admin". To make secrets genuinely write-only ("1-way visible")
 * the credentials API:
 *
 *   1. READ  — never returns secret VALUES; instead it reports which secret
 *      fields currently have a stored value (`secretsSet`) so the admin UI can
 *      render "•••••• set — type to replace".
 *   2. WRITE — treats a blank/omitted secret as "unchanged" and preserves the
 *      stored value, so re-saving the form (which re-submits every field) never
 *      wipes a secret the operator did not retype.
 *
 * Server-side use (`resolve()` for sync/health) is unaffected — it still returns
 * the real secret. The helpers below are pure and dependency-light so the logic
 * is unit-testable and shared between the GET/PUT route handlers.
 */

export type CredentialsRecord = Record<string, unknown>

/**
 * Credential field types whose values must never be read back. Only `secret`
 * today; kept as a Set so adding another opaque type is a one-line change.
 */
export const SECRET_CREDENTIAL_FIELD_TYPES: ReadonlySet<string> = new Set(['secret'])

/** Keys of the schema's credential fields that are write-only secrets. */
export function secretCredentialFieldKeys(schema: IntegrationCredentialsSchema | null | undefined): string[] {
  return (schema?.fields ?? [])
    .filter((field) => field && typeof field.key === 'string' && SECRET_CREDENTIAL_FIELD_TYPES.has(String(field.type)))
    .map((field) => field.key)
}

function isEmptyCredentialValue(value: unknown): boolean {
  return value == null || String(value).length === 0
}

/**
 * Strip secret field VALUES from a credential record for read-back. Returns the
 * non-secret fields verbatim plus `secretsSet` — the secret keys that currently
 * have a stored value — so the UI can show "set — type to replace" without ever
 * receiving the value. Does not mutate the input.
 */
export function redactSecretCredentials(
  credentials: CredentialsRecord,
  schema: IntegrationCredentialsSchema | null | undefined,
): { credentials: CredentialsRecord; secretsSet: string[] } {
  const secretKeys = secretCredentialFieldKeys(schema)
  const out: CredentialsRecord = { ...credentials }
  const secretsSet: string[] = []
  for (const key of secretKeys) {
    if (!isEmptyCredentialValue(out[key])) secretsSet.push(key)
    delete out[key] // never expose the secret value on read
  }
  return { credentials: out, secretsSet }
}

/**
 * Merge incoming credentials with the stored ones so that an empty/omitted
 * SECRET keeps its stored value (write-only: a blank secret means "unchanged",
 * not "clear"). Non-secret fields and non-empty secrets pass through as
 * provided. Does not mutate either input.
 */
export function preserveUnchangedSecretCredentials<T extends CredentialsRecord>(
  incoming: T,
  existing: CredentialsRecord | null | undefined,
  schema: IntegrationCredentialsSchema | null | undefined,
): T {
  const secretKeys = secretCredentialFieldKeys(schema)
  const out = { ...incoming }
  for (const key of secretKeys) {
    if (isEmptyCredentialValue(out[key]) && !isEmptyCredentialValue(existing?.[key])) {
      ;(out as CredentialsRecord)[key] = existing![key] // preserve the stored secret
    }
  }
  return out
}
