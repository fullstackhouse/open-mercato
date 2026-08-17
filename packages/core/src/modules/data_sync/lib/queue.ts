import { createModuleQueue, type AbandonedJobInfo, type Queue } from '@open-mercato/queue'

const queues = new Map<string, Queue<Record<string, unknown>>>()

/**
 * Queues whose jobs own a `sync_runs` row for their whole lifetime.
 *
 * Only these can leave a run stranded when the queue abandons a job, so only these get the hook.
 * Other callers of `getSyncQueue` (Akeneo's first import, product deletion) track their state with a
 * progress job instead and carry no run id.
 */
const runQueueNames = new Set<string>(['data-sync-import', 'data-sync-export'])

/**
 * Fail the run behind a job the queue gave up on.
 *
 * A data_sync job is ONE long-lived job for a whole run — `runImport` is entered once and stays
 * there for the duration, which for a full backfill is days. Every worker death (a deploy, an OOM)
 * therefore stalls that job, and BullMQ's stalled counter is cumulative for the job's life: past
 * `maxStalledCount` it writes a deferred failure and the next worker fails the job BEFORE calling
 * the processor.
 *
 * So `runImport` never runs, never throws, and never finalizes — and `sync_runs` is left saying
 * `running` for a run nothing is running, forever. The queue reports `failed`, the admin run list
 * reports `running`, and the two never reconcile. That is the state this repairs.
 *
 * It only ever moves a non-terminal run: `markStatus` refuses to overwrite `completed` / `failed` /
 * `cancelled`, so a job abandoned after its run already ended is a no-op.
 */
async function failAbandonedRun(payload: unknown, info: AbandonedJobInfo): Promise<void> {
  const data = payload as { payload?: { runId?: unknown; scope?: { organizationId?: unknown; tenantId?: unknown } } } | undefined
  const runId = data?.payload?.runId
  const scope = data?.payload?.scope
  // Nothing to repair without both: the run row is keyed by id AND tenant scope.
  if (typeof runId !== 'string' || typeof scope?.organizationId !== 'string' || typeof scope?.tenantId !== 'string') return

  const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
  const container = await createRequestContainer()
  const runService = container.resolve('dataSyncRunService') as {
    markStatus(
      runId: string,
      status: string,
      scope: { organizationId: string; tenantId: string },
      error?: string,
    ): Promise<unknown>
  }
  await runService.markStatus(
    runId,
    'failed',
    { organizationId: scope.organizationId, tenantId: scope.tenantId },
    `the queue abandoned this run's job without running it: ${info.reason}`,
  )
}

export function getSyncQueue(queueName: string): Queue<Record<string, unknown>> {
  const existing = queues.get(queueName)
  if (existing) return existing

  const concurrency = Math.max(1, Number.parseInt(process.env.DATA_SYNC_QUEUE_CONCURRENCY ?? '5', 10) || 5)
  const created = createModuleQueue<Record<string, unknown>>(
    queueName,
    runQueueNames.has(queueName)
      ? { concurrency, onJobAbandoned: failAbandonedRun }
      : { concurrency },
  )

  queues.set(queueName, created)
  return created
}
