import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelNativeContent,
  ConvertOutboundInput,
  GetMessageStatusInput,
  InboundMessage,
  MessageStatus,
  NormalizedInboundMessage,
  SendMessageInput,
  SendMessageResult,
  ValidateCredentialsInput,
  ValidateCredentialsResult,
  VerifyWebhookInput,
} from '@open-mercato/core/modules/communication_channels/lib/adapter'
import {
  hasChannelAdapter,
  registerChannelAdapter,
} from '@open-mercato/core/modules/communication_channels/lib/adapter-registry-singleton'

/**
 * In-process, network-free `push` channel adapter used ONLY by tests.
 *
 * Real provider adapters (FCM/APNs/Expo) land in Phase 4 as separate channel packages. Phase 3 ships
 * this stub so the strategy → delivery-row → worker → `sendMessage` chain is exercisable end-to-end.
 *
 * Token sentinels let a test drive each worker branch deterministically:
 *   - a token containing `unregistered` → the uniform `unregistered` shape (worker soft-deletes the device)
 *   - a token containing `fail`         → a retryable failure (worker retries then marks `failed`)
 *   - otherwise                          → `sent`
 *
 * Production safety: never registered at module import. The integration harness calls
 * {@link ensurePushStubAdapterRegistered}, gated by `OM_ENABLE_PUSH_STUB_ADAPTER`.
 */
export const PUSH_STUB_PROVIDER_KEY = 'push_stub'
export const PUSH_STUB_ENV = 'OM_ENABLE_PUSH_STUB_ADAPTER'

export function isPushStubEnabled(): boolean {
  const raw = process.env[PUSH_STUB_ENV]
  if (typeof raw !== 'string') return false
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
}

const pushStubCapabilities: ChannelCapabilities = {
  threading: false,
  richText: false,
  fileSharing: false,
  readReceipts: false,
  deliveryReceipts: false,
  typingIndicators: false,
  reactions: false,
  multiReactionPerUser: false,
  editMessage: false,
  deleteMessage: false,
  presence: false,
  richBlocks: false,
  interactiveComponents: false,
  inlineImages: false,
  conversationHistory: false,
  contactCards: false,
  locationSharing: false,
  voiceNotes: false,
  stickers: false,
  supportedBodyFormats: ['text'],
  // Push is real-time; no polling.
  realtimePush: true,
}

class PushStubChannelAdapter implements ChannelAdapter {
  readonly providerKey = PUSH_STUB_PROVIDER_KEY
  readonly channelType = 'push'
  readonly capabilities = pushStubCapabilities

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const token = typeof input.metadata?.pushToken === 'string' ? input.metadata.pushToken : ''
    if (token.includes('unregistered')) {
      return {
        externalMessageId: '',
        status: 'failed',
        error: 'device_unregistered',
        metadata: { unregistered: true, stub: true },
      }
    }
    if (token.includes('fail')) {
      return { externalMessageId: '', status: 'failed', error: 'push_stub_forced_failure', metadata: { stub: true } }
    }
    return {
      externalMessageId: `push-stub-${token.slice(-8) || 'token'}`,
      status: 'sent',
      metadata: { stub: true },
    }
  }

  async verifyWebhook(_input: VerifyWebhookInput): Promise<InboundMessage> {
    return { raw: {}, eventType: 'other', metadata: { reason: 'push-stub-no-webhook' } }
  }

  async getStatus(_input: GetMessageStatusInput): Promise<MessageStatus> {
    return { status: 'sent' }
  }

  async convertOutbound(input: ConvertOutboundInput): Promise<ChannelNativeContent> {
    return { content: { text: input.body, bodyFormat: input.bodyFormat }, metadata: input.channelMetadata ?? {} }
  }

  async normalizeInbound(_raw: InboundMessage): Promise<NormalizedInboundMessage> {
    throw new Error('[internal] PushStubChannelAdapter.normalizeInbound is not used')
  }

  async validateCredentials(_input: ValidateCredentialsInput): Promise<ValidateCredentialsResult> {
    return { ok: true }
  }
}

let cachedPushStubAdapter: PushStubChannelAdapter | null = null

export function getPushStubAdapter(): PushStubChannelAdapter {
  if (!cachedPushStubAdapter) cachedPushStubAdapter = new PushStubChannelAdapter()
  return cachedPushStubAdapter
}

/** Register the push stub adapter once, ONLY when the test env flag is set. No-op otherwise. */
export function ensurePushStubAdapterRegistered(): void {
  if (!isPushStubEnabled()) return
  if (hasChannelAdapter(PUSH_STUB_PROVIDER_KEY)) return
  registerChannelAdapter(getPushStubAdapter())
}
