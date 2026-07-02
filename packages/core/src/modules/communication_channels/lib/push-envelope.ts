import type { MessageContent } from './adapter'

/**
 * The push payload the `push_notifications` worker packs into
 * `SendMessageInput.content.raw` before calling a push adapter's `sendMessage`
 * (see `push_notifications/lib/push-delivery.ts`). Each provider adapter
 * (fcm/apns/expo) reads it the same way via {@link readPushEnvelope} so the
 * title/body/data contract stays uniform.
 */
export interface PushEnvelope {
  title: string
  body: string
  data: Record<string, string>
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw == null) continue
    out[key] = typeof raw === 'string' ? raw : String(raw)
  }
  return out
}

/** Read the normalized push envelope from a hub `MessageContent`. Defensive against missing fields. */
export function readPushEnvelope(content: MessageContent | undefined): PushEnvelope {
  const raw = (content?.raw ?? {}) as { title?: unknown; body?: unknown; data?: unknown }
  const title = typeof raw.title === 'string' ? raw.title : ''
  const body = typeof raw.body === 'string' ? raw.body : content?.text ?? ''
  return { title, body, data: toStringRecord(raw.data) }
}
