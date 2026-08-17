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

    // Job ids this worker has actually handed to the handler. A job BullMQ abandons past
    // `maxStalledCount` is failed before the processor is called, so its id never lands here — which
    // is exactly what distinguishes it from a handler that ran and threw.
    const startedJobIds = new Set<string>()

    // Create worker that processes jobs
    bullWorker = new Worker<QueuedJob<T>>(
      name,
      async (job) => {
        const jobData = job.data
        // Recorded so the 'failed' handler below can tell "the work failed" from "the work never
        // started". Set membership rather than a flag because concurrency > 1 runs several at once.
        if (job.id) startedJobIds.add(job.id)
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
      if (jobWithId.id) startedJobIds.delete(jobWithId.id)
      logger.info('Job completed', { jobId: jobWithId.id })
    })

    bullWorker.on('failed', (job, err) => {
      const failedJob = job as { id?: string; data?: QueuedJob<T> } | undefined
      const error = err as Error
      logger.error('Job failed', { jobId: failedJob?.id, err: error })

      const jobId = failedJob?.id ?? null
      if (jobId && startedJobIds.delete(jobId)) return // the handler ran; the failure is its own
      if (!onJobAbandoned) return

      // The handler was never called, so nothing downstream knows this job is dead. Report it, and
      // never let the report take the worker down with it: this runs on an EventEmitter, where an
      // unhandled rejection is fatal to the process.
      logger.warn('Job abandoned by the queue without running its handler', { jobId, err: error })
      void (async () => {
        try {
          await onJobAbandoned(failedJob?.data, { jobId, reason: error?.message ?? 'unknown' })
        } catch (hookError) {
          logger.error('onJobAbandoned handler threw', { jobId, err: hookError as Error })
        }
      })()
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
