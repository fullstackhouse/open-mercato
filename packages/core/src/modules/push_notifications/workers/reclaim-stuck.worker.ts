import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { PUSH_STUCK_RECLAIM_QUEUE } from '../lib/queue'
import { reclaimStuckPushDeliveries } from '../lib/push-reaper'

/**
 * Scheduler tick payload. Fired by the `@open-mercato/scheduler` interval entry registered in
 * setup.ts (`push_notifications:reclaim-stuck`). The scheduler adds `tenantId` at the top level of the
 * enqueued payload on top of the configured `targetPayload`, so accept either shape.
 */
export type ReclaimStuckTickPayload = {
  scope?: { tenantId?: string | null }
  tenantId?: string | null
}

export const metadata: WorkerMeta = {
  queue: PUSH_STUCK_RECLAIM_QUEUE,
  id: 'push_notifications:reclaim-stuck',
  concurrency: 1, // single-flight per tenant tick — the atomic claim guards overlaps anyway
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(
  job: QueuedJob<ReclaimStuckTickPayload>,
  ctx: HandlerContext,
): Promise<void> {
  const raw = (job?.payload ?? {}) as ReclaimStuckTickPayload
  const tenantId = raw.scope?.tenantId ?? raw.tenantId ?? null
  if (!tenantId) {
    console.warn('[push_notifications:reclaim-stuck] skipping tick — payload has no tenantId', { payload: raw })
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  try {
    const result = await reclaimStuckPushDeliveries(em, { tenantId })
    if (result.reEnqueued > 0 || result.expired > 0) {
      console.log(
        `[push_notifications:reclaim-stuck] tenant ${tenantId}: re-enqueued ${result.reEnqueued}, expired ${result.expired} stuck delivery row(s)`,
      )
    }
  } catch (error) {
    console.error('[push_notifications:reclaim-stuck] sweep failed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
