import fs from 'node:fs'
import path from 'node:path'
import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'

/**
 * Test-only sink recording the **provider-native** message each push adapter handed its SDK client.
 *
 * The `channel-{fcm,apns,expo}` fakes replace the SDK *client*, not the adapter — so the real adapter
 * builds the native message, but nothing persists it: no adapter returns `metadata` on success, and
 * APNs deliberately reports an empty `externalMessageId` (its value reaches the admin-exposed
 * `provider_response`, which must never carry token material). The message is therefore written here,
 * out of band, where a spec in the Playwright process can read what the worker process produced.
 *
 * Production safety: every entry point is a no-op unless `OM_PUSH_FAKE_PROVIDERS` is set. Mirrors
 * `ensurePushStubAdapterRegistered()` in ./push-stub-adapter.ts.
 */
export const PUSH_FAKE_PROVIDERS_ENV = 'OM_PUSH_FAKE_PROVIDERS'

const LOG_FILE_NAME = 'push-fake-messages.jsonl'

export type FakePushProvider = 'fcm' | 'apns' | 'expo'

export type FakePushEntry = {
  provider: FakePushProvider
  tokenTail: string
  native: Record<string, unknown>
  at: string
}

export function isPushFakeProvidersEnabled(): boolean {
  return parseBooleanToken(process.env[PUSH_FAKE_PROVIDERS_ENV]) === true
}

/**
 * Colocated with the queue's own base dir: the worker process, the drain child, and the spec all
 * already agree on it (`QUEUE_BASE_DIR`, else `<appRoot>/.mercato/queue`).
 */
export function resolveFakePushLogPath(): string {
  const baseDir =
    process.env.QUEUE_BASE_DIR?.trim() ||
    path.resolve(process.env.OM_TEST_APP_ROOT?.trim() || process.cwd(), '.mercato/queue')
  return path.join(baseDir, LOG_FILE_NAME)
}

/** Token tail used to key entries — never the raw token (mirrors `token_snapshot` on the delivery row). */
export function pushTokenTail(token: string): string {
  return token.slice(-8)
}

export function recordFakePush(provider: FakePushProvider, token: string, native: Record<string, unknown>): void {
  if (!isPushFakeProvidersEnabled()) return
  const entry: FakePushEntry = {
    provider,
    tokenTail: pushTokenTail(token),
    native,
    at: new Date().toISOString(),
  }
  const filePath = resolveFakePushLogPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  // A single `O_APPEND` write of one short line — concurrent deliveries interleave by line, not within one.
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export function readFakePushLog(): FakePushEntry[] {
  const filePath = resolveFakePushLogPath()
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakePushEntry)
}

/** Find the message a spec's own device produced, isolating it from any concurrent spec. */
export function findFakePush(provider: FakePushProvider, tokenTail: string): FakePushEntry | undefined {
  return readFakePushLog()
    .filter((entry) => entry.provider === provider && entry.tokenTail === tokenTail)
    .pop()
}

export function clearFakePushLog(): void {
  const filePath = resolveFakePushLogPath()
  if (fs.existsSync(filePath)) fs.rmSync(filePath)
}
