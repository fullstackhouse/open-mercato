import type { Queue, QueuedJob, JobHandler, AsyncQueueOptions, ProcessResult, EnqueueOptions, QueueJobScope } from '../types'
import { getRedisUrlOrThrow } from '@open-mercato/shared/lib/redis/connection'
import { createLogger } from '@open-mercato/shared/lib/logger'

const packageLogger = createLogger('queue')

// BullMQ interface types - we define the shape we use to maintain type safety
// while keeping bullmq as an optional peer dependency
type ConnectionOptions = {
  url?: string
  host?: string
  port?: number
  username?: string
  password?: string
  db?: number
  tls?: Record<string, unknown>
}

interface BullQueueInterface<T> {
  add: (
    name: string,
    data: T,
    opts?: {
      removeOnComplete?: boolean
      removeOnFail?: number
      delay?: number
      attempts?: number
      backoff?: { type: string; delay: number }
    },
  ) => Promise<{ id?: string }>
  obliterate: (opts?: { force?: boolean }) => Promise<void>
  close: () => Promise<void>
  getJobCounts: (...states: string[]) => Promise<Record<string, number>>
  getJobs: (types: string[], start?: number, end?: number) => Promise<Array<{
    data?: T
    remove: () => Promise<void>
  }>>
}

interface BullWorkerInterface {
  on: (event: string, handler: (...args: unknown[]) => void) => void
  close: () => Promise<void>
}

interface BullMQModule {
  Queue: new <T>(name: string, opts: { connection: ConnectionOptions }) => BullQueueInterface<T>
  Worker: new <T>(
    name: string,
    processor: (job: { id?: string; data: T; attemptsMade: number }) => Promise<void>,
    opts: { connection: ConnectionOptions; concurrency: number }
  ) => BullWorkerInterface
}

const REMOVABLE_JOB_STATES = ['waiting', 'delayed', 'prioritized', 'paused', 'waiting-children']

/**
 * The failures BullMQ records when it gives up on a job *before* handing it to the processor.
 *
 * Both are written as a `defa` (deferred failure) marker on the job, after which the next worker
 * short-circuits in `Worker.processJob` via `getUnrecoverableErrorMessage` and fails the job without
 * calling the handler. The first comes from the stalled-job script once a job's cumulative stall
 * count passes `maxStalledCount`; the second from `maxStartedAttempts`.
 *
 * Matching the reason is what tells "the queue abandoned this" from "the handler ran and threw", and
 * it is deliberately stateless: the alternative — tracking which jobs this process has entered — can
 * only answer "did the handler run *here*", which is the wrong question the moment more than one
 * worker is running. `bullmq-abandoned-reasons.test.ts` asserts these strings still exist in the
 * installed BullMQ, so an upgrade that renames them fails loudly instead of silently disabling the
 * hook.
 */
export const ABANDONED_JOB_REASONS = [
  'job stalled more than allowable limit',
  'job started more than allowable limit',
] as const

function isAbandonedJobReason(message: string): boolean {
  return (ABANDONED_JOB_REASONS as readonly string[]).includes(message)
}

function payloadMatchesScope(payload: unknown, scope: QueueJobScope): boolean {
  if (!payload || typeof payload !== 'object') return false
  const scopedPayload = payload as { tenantId?: unknown; organizationId?: unknown; jobType?: unknown }
  if (scopedPayload.tenantId !== scope.tenantId) return false
  if (scope.organizationId !== undefined) {
    if ((scopedPayload.organizationId ?? null) !== scope.organizationId) return false
  }
  if (scope.jobTypes?.length) {
    return typeof scopedPayload.jobType === 'string' && scope.jobTypes.includes(scopedPayload.jobType)
  }
  return true
}

/**
 * Resolves Redis connection options from various sources.
 *
 * BullMQ expects an ioredis-compatible connection object. Preserve the full
 * Redis URL under the `url` key so rediss://, username, database, and query
 * params are not lost in translation.
 */
function resolveConnection(options?: AsyncQueueOptions['connection']): ConnectionOptions {
  if (options?.url) {
    return { url: options.url }
  }

  if (options?.host) {
    return {
      host: options.host,
      port: options.port ?? 6379,
      username: options.username,
      password: options.password,
      db: options.db,
      tls: options.tls,
    }
  }

  return { url: getRedisUrlOrThrow('QUEUE') }
}

/**
 * Creates a BullMQ-based async queue.
 *
 * This strategy provides:
 * - Persistent job storage in Redis
 * - Automatic retries with exponential backoff
 * - Concurrent job processing
 * - Job prioritization and scheduling
 *
 * @template T - The payload type for jobs
 * @param name - Queue name
 * @param options - Async queue options
 */
export function createAsyncQueue<T = unknown>(
  name: string,
  options?: AsyncQueueOptions
): Queue<T> {
  const connection = resolveConnection(options?.connection)
  const concurrency = options?.concurrency ?? 1
  const onJobAbandoned = options?.onJobAbandoned
  const logger = packageLogger.child({ queue: name })

  let bullQueue: BullQueueInterface<QueuedJob<T>> | null = null
  let bullWorker: BullWorkerInterface | null = null
  let bullmqModule: BullMQModule | null = null

  // In-flight `onJobAbandoned` calls. Detached from the event listener that started them (see
  // below), so `close()` drains them rather than letting a deploy truncate a repair mid-write.
  const pendingAbandonedReports = new Set<Promise<void>>()

  // -------------------------------------------------------------------------
  // Lazy BullMQ initialization
  // -------------------------------------------------------------------------

  async function getBullMQ(): Promise<BullMQModule> {
    if (!bullmqModule) {
      try {
        bullmqModule = await import('bullmq') as unknown as BullMQModule
      } catch {
        throw new Error(
          'BullMQ is required for async queue strategy. Install it with: npm install bullmq'
        )
      }
    }
    return bullmqModule
  }

  async function getQueue(): Promise<BullQueueInterface<QueuedJob<T>>> {
    if (!bullQueue) {
      const { Queue: BullQueueClass } = await getBullMQ()
      bullQueue = new BullQueueClass<QueuedJob<T>>(name, { connection })
    }
    return bullQueue
  }

  // -------------------------------------------------------------------------
  // Queue Implementation
  // -------------------------------------------------------------------------

  async function enqueue(data: T, options?: EnqueueOptions): Promise<string> {
    const queue = await getQueue()
    const jobData: QueuedJob<T> = {
      id: crypto.randomUUID(),
      payload: data,
      createdAt: new Date().toISOString(),
    }

    const job = await queue.add(jobData.id, jobData, {
      delay: options?.delayMs && options.delayMs > 0 ? options.delayMs : undefined,
      removeOnComplete: true,
      removeOnFail: 1000,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    })

    return job.id ?? jobData.id
  }

  async function process(handler: JobHandler<T>): Promise<ProcessResult> {
    const { Worker } = await getBullMQ()

    // Create worker that processes jobs
    bullWorker = new Worker<QueuedJob<T>>(
      name,
      async (job) => {
        const jobData = job.data
        await handler(jobData, {
          jobId: job.id ?? jobData.id,
          attemptNumber: job.attemptsMade + 1,
          queueName: name,
        })
      },
      {
        connection,
        concurrency,
      }
    )

    // Set up event handlers
    bullWorker.on('completed', (job) => {
      const jobWithId = job as { id?: string }
      logger.info('Job completed', { jobId: jobWithId.id })
    })

    bullWorker.on('failed', (job, err) => {
      const failedJob = job as { id?: string; data?: QueuedJob<T> } | undefined
      const error = err as Error
      logger.error('Job failed', { jobId: failedJob?.id, err: error })

      if (!onJobAbandoned) return
      // Any other reason means a handler ran and threw. That failure is the handler's own and it has
      // already had its chance to record it.
      if (!isAbandonedJobReason(error?.message ?? '')) return
      // No payload means the queue could not give us the job at all. There is nothing to hand the
      // hook and nothing it could repair, so reporting could only ever be a false alarm — the
      // 'Job failed' line above still records it.
      if (!failedJob?.data) return

      const jobId = failedJob.id ?? null
      const payload = failedJob.data

      // The handler was never called on this delivery, so nothing downstream knows the job is dead.
      // Report it, and never let the report take the worker down with it: this runs on an
      // EventEmitter, where an unhandled rejection is fatal to the process.
      logger.warn('Job abandoned by the queue without running its handler', { jobId, err: error })
      const report = (async () => {
        try {
          await onJobAbandoned(payload, { jobId, reason: error?.message ?? 'unknown' })
        } catch (hookError) {
          logger.error('onJobAbandoned handler threw', { jobId, err: hookError as Error })
        }
      })()
      pendingAbandonedReports.add(report)
      void report.then(() => pendingAbandonedReports.delete(report))
    })

    bullWorker.on('error', (err) => {
      const error = err as Error
      logger.error('Worker error', { err: error })
    })

    logger.info('Worker started', { concurrency })

    // For async strategy, return a sentinel result indicating worker mode
    // processed=-1 signals that this is a continuous worker, not a batch process
    return { processed: -1, failed: -1, lastJobId: undefined }
  }

  async function clear(): Promise<{ removed: number }> {
    const queue = await getQueue()

    // Obliterate removes all jobs from the queue
    await queue.obliterate({ force: true })

    return { removed: -1 } // BullMQ obliterate doesn't return count
  }

  async function removeQueuedJobsByScope(scope: QueueJobScope): Promise<{ removed: number }> {
    const queue = await getQueue()
    const jobs = await queue.getJobs(REMOVABLE_JOB_STATES, 0, -1)
    let removed = 0

    for (const job of jobs) {
      if (!payloadMatchesScope(job.data?.payload, scope)) continue
      try {
        await job.remove()
        removed++
      } catch {
        // The job may have started between enumeration and removal. In-flight
        // cancellation is handled by the caller's lock/heartbeat contract.
      }
    }

    return { removed }
  }

  async function close(): Promise<void> {
    if (bullWorker) {
      await bullWorker.close()
      bullWorker = null
    }
    // Drain any abandonment report still in flight. Without this a deploy-time shutdown can cut off
    // the very repair the hook exists to perform — and these never reject, so awaiting is safe.
    if (pendingAbandonedReports.size) {
      await Promise.all([...pendingAbandonedReports])
    }
    if (bullQueue) {
      await bullQueue.close()
      bullQueue = null
    }
  }

  async function getJobCounts(): Promise<{
    waiting: number
    active: number
    completed: number
    failed: number
  }> {
    const queue = await getQueue()
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed')
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    }
  }

  return {
    name,
    strategy: 'async',
    enqueue,
    process,
    clear,
    removeQueuedJobsByScope,
    close,
    getJobCounts,
  }
}
