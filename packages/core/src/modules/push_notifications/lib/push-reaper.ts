import type { EntityManager } from '@mikro-orm/postgresql'
import { PushNotificationDelivery } from '../data/entities'
import { emitPushNotificationsEvent } from '../events'
import { MAX_ATTEMPTS } from './push-delivery'
import { enqueuePushDelivery } from './queue'

// Minutes a row may sit in `sending` before it is treated as abandoned by a dead worker. Tunable via
// OM_PUSH_STUCK_RECLAIM_MINUTES (0 means "reclaim on the next tick"; negative/non-numeric → default).
//
// INVARIANT: this window MUST exceed the worst-case single provider send time. `updated_at` is stamped
// once when the row is claimed (`pending` → `sending`) and is NOT refreshed mid-send (no heartbeat), so
// a legitimate send that runs longer than the window would be reclaimed and re-enqueued → a duplicate
// push. The default (5m) is comfortably above any adapter's send/HTTP timeout; if you lower it, keep it
// above the adapter timeout. Duplicates are otherwise bounded by MAX_ATTEMPTS and inherent to
// at-least-once delivery.
const DEFAULT_STUCK_MINUTES = 5

export type ReclaimStuckResult = { reEnqueued: number; expired: number }

function resolveStuckThresholdMs(): number {
  const raw = Number.parseInt(process.env.OM_PUSH_STUCK_RECLAIM_MINUTES ?? '', 10)
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_STUCK_MINUTES
  return minutes * 60 * 1000
}

async function emitFailed(delivery: PushNotificationDelivery, willRetry: boolean): Promise<void> {
  await emitPushNotificationsEvent(
    'push_notifications.delivery.failed',
    {
      deliveryId: delivery.id,
      tenantId: delivery.tenantId,
      organizationId: delivery.organizationId ?? null,
      userId: delivery.userId,
      provider: delivery.provider,
      status: delivery.status,
      ...(willRetry ? { willRetry: true } : {}),
    },
    { persistent: true },
  )
}

/**
 * Recover push delivery rows stranded in `sending` by a worker that crashed between claiming the row
 * (`pending` → `sending`) and finalizing it. Such a row has no outstanding job — the send-path claim
 * only ever matches `status = 'pending'` — so without this sweep it would never reach a terminal state
 * nor surface as failed in the admin log. Driven by the `push_notifications:reclaim-stuck` scheduler
 * tick (one per tenant), so the query is scoped to the tenant only (covers org-bound and tenant-level
 * rows alike); there is no cross-tenant read.
 *
 * A stuck row with retry budget left is re-opened to `pending` and re-enqueued: a crash almost always
 * means the send never reached the provider, and a rare duplicate is bounded by MAX_ATTEMPTS and
 * inherent to at-least-once delivery. A row that already spent its attempts is finalized `expired`.
 *
 * Each transition is an atomic `nativeUpdate` guarded on `status = 'sending'` AND still-stale
 * `updated_at < cutoff`, so overlapping ticks (or a worker that re-claimed the row in the meantime)
 * can never re-open an actively-processing delivery — exactly one actor wins each row.
 */
export async function reclaimStuckPushDeliveries(
  em: EntityManager,
  scope: { tenantId: string },
  now: Date = new Date(),
): Promise<ReclaimStuckResult> {
  const cutoff = new Date(now.getTime() - resolveStuckThresholdMs())
  const stuck = await em.find(PushNotificationDelivery, {
    tenantId: scope.tenantId,
    status: 'sending',
    updatedAt: { $lt: cutoff },
  })

  let reEnqueued = 0
  let expired = 0
  for (const delivery of stuck) {
    const claimGuard = { id: delivery.id, tenantId: scope.tenantId, status: 'sending' as const, updatedAt: { $lt: cutoff } }

    if (delivery.attempts >= MAX_ATTEMPTS) {
      const claimed = await em.nativeUpdate(PushNotificationDelivery, claimGuard, {
        status: 'expired',
        lastError: 'stuck_reclaimed',
        nextRetryAt: null,
        updatedAt: new Date(),
      })
      if (claimed === 0) continue
      delivery.status = 'expired'
      delivery.lastError = 'stuck_reclaimed'
      await emitFailed(delivery, false)
      expired += 1
      continue
    }

    const claimed = await em.nativeUpdate(PushNotificationDelivery, claimGuard, {
      status: 'pending',
      nextRetryAt: null,
      updatedAt: new Date(),
    })
    if (claimed === 0) continue
    delivery.status = 'pending'

    try {
      await enqueuePushDelivery({
        deliveryId: delivery.id,
        tenantId: scope.tenantId,
        organizationId: delivery.organizationId ?? null,
      })
      reEnqueued += 1
    } catch (error) {
      // Re-enqueue failed: don't leave the row pending with no job. Fail it terminally instead.
      const reason = error instanceof Error ? `reclaim_enqueue_failed: ${error.message}` : 'reclaim_enqueue_failed'
      await em.nativeUpdate(
        PushNotificationDelivery,
        { id: delivery.id, tenantId: scope.tenantId, status: 'pending' },
        { status: 'failed', lastError: reason, nextRetryAt: null, updatedAt: new Date() },
      )
      delivery.status = 'failed'
      delivery.lastError = reason
      await emitFailed(delivery, false)
    }
  }

  return { reEnqueued, expired }
}
