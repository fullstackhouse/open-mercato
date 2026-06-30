import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { PUSH_DELIVERIES_QUEUE, type PushDeliveryJob } from '../lib/queue'
import { processPushDeliveryJob } from '../lib/push-delivery'

export const metadata: WorkerMeta = {
  queue: PUSH_DELIVERIES_QUEUE,
  id: 'push_notifications:send-push',
  concurrency: 8,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(
  job: QueuedJob<PushDeliveryJob>,
  ctx: HandlerContext,
): Promise<void> {
  const em = (ctx.resolve('em') as EntityManager).fork()
  try {
    await processPushDeliveryJob(em, job.payload, ctx.resolve)
  } catch (error) {
    console.error('[push_notifications:send-push] Job processing failed', {
      deliveryId: job.payload.deliveryId,
      tenantId: job.payload.tenantId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}
