/**
 * Queue Package Type Definitions
 *
 * Provides type-safe abstractions for multi-strategy job queues.
 */

// ============================================================================
// Core Job Types
// ============================================================================

/**
 * Represents a job stored in the queue.
 * @template T - The payload type for this job
 */
export type QueuedJob<T = unknown> = {
  /** Unique identifier for the job */
  id: string
  /** The job payload data */
  payload: T
  /** ISO timestamp when the job was created */
  createdAt: string
  /** Optional metadata for the job */
  metadata?: Record<string, unknown>
}

/**
 * Context provided to job handlers during processing.
 */
export type JobContext = {
  /** Unique identifier of the current job */
  jobId: string
  /** Current attempt number (1-based) */
  attemptNumber: number
  /** Name of the queue being processed */
  queueName: string
}

/**
 * Handler function that processes jobs from the queue.
 * @template T - The payload type this handler expects
 */
export type JobHandler<T = unknown> = (
  job: QueuedJob<T>,
  ctx: JobContext
) => Promise<void> | void

// ============================================================================
// Strategy Types
// ============================================================================

/** Available queue strategy types */
export type QueueStrategyType = 'local' | 'async'

/**
 * Options for local (file-based) queue strategy.
 */
export type LocalQueueOptions = {
  /** Base directory for queue files. Defaults to QUEUE_BASE_DIR or '.mercato/queue' */
  baseDir?: string
  /** Number of concurrent job processors. Defaults to 1 */
  concurrency?: number
  /** Polling interval in milliseconds for continuous processing. Defaults to 1000 */
  pollInterval?: number
}

/**
 * Redis connection options for async strategy.
 */
export type RedisConnectionOptions = {
  /** Redis connection URL (e.g., redis://localhost:6379) */
  url?: string
  /** Redis host */
  host?: string
  /** Redis port */
  port?: number
  /** Redis username */
  username?: string
  /** Redis password */
  password?: string
  /** Redis database number */
  db?: number
  /** TLS configuration for rediss / encrypted Redis */
  tls?: Record<string, unknown>
}

/**
 * Options for async (BullMQ) queue strategy.
 */
export type AsyncQueueOptions = {
  /** Redis connection configuration */
  connection?: RedisConnectionOptions
  /** Number of concurrent job processors. Defaults to 1 */
  concurrency?: number
  /**
   * Called when the queue ABANDONS a job without ever running its handler.
   *
   * The case this exists for: a job whose worker keeps dying is redelivered, and each redelivery
   * increments a stalled counter that never resets. Past `maxStalledCount` BullMQ writes a deferred
   * failure onto the job and moves it back to `wait`; the next worker reads that marker and fails the
   * job *before* calling the processor. So the handler never runs, never throws, and never learns —
   * and any state it created on enqueue (a run row, a progress record) is orphaned in whatever
   * "in progress" state it was left in, with nothing to correct it.
   *
   * Deliberately NOT a general "job failed" hook. A handler that ran and threw owns its own outcome
   * and has already had the chance to record it; calling this for that case would double-report, and
   * would hide the difference between "the work failed" and "the work never started".
   */
  onJobAbandoned?: (payload: unknown, info: AbandonedJobInfo) => void | Promise<void>
}

/** What the queue can say about a job it gave up on. */
export type AbandonedJobInfo = {
  /** BullMQ's job id, or null when the driver did not supply one. */
  jobId: string | null
  /** The failure the queue recorded, e.g. 'job stalled more than allowable limit'. */
  reason: string
}

/**
 * Conditional options type based on strategy.
 * Local strategy gets file options, async gets Redis options.
 */
export type QueueOptions<S extends QueueStrategyType> = S extends 'async'
  ? AsyncQueueOptions
  : LocalQueueOptions

/**
 * Optional job scheduling options.
 */
export type EnqueueOptions = {
  /**
   * Delay job execution by this many milliseconds.
   */
  delayMs?: number
}

// ============================================================================
// Process Types
// ============================================================================

/**
 * Options for the process operation.
 */
export type ProcessOptions = {
  /** Maximum number of jobs to process (local strategy only) */
  limit?: number
}

/**
 * Result returned after processing jobs.
 */
export type ProcessResult = {
  /** Number of jobs successfully processed */
  processed: number
  /** Number of jobs that failed */
  failed: number
  /** ID of the last processed job */
  lastJobId?: string
}

export type QueueJobScope = {
  tenantId: string
  organizationId?: string | null
  jobTypes?: readonly string[]
}

// ============================================================================
// Queue Interface
// ============================================================================

/**
 * Main queue interface that all strategies must implement.
 * @template T - The payload type for jobs in this queue
 */
export interface Queue<T = unknown> {
  /** Name of this queue */
  readonly name: string
  /** Strategy type used by this queue */
  readonly strategy: QueueStrategyType

  /**
   * Add a job to the queue.
   * @param data - The job payload
   * @param options - Optional scheduling options
   * @returns Promise resolving to the job ID
   */
  enqueue(data: T, options?: EnqueueOptions): Promise<string>

  /**
   * Process jobs from the queue.
   *
   * For local strategy: processes jobs synchronously and returns result with counts.
   * For async strategy: starts a worker and returns sentinel result (processed=-1).
   *
   * @param handler - Function to handle each job
   * @param options - Processing options
   * @returns ProcessResult with counts (or sentinel for async worker mode)
   */
  process(handler: JobHandler<T>, options?: ProcessOptions): Promise<ProcessResult>

  /**
   * Remove all jobs from the queue.
   * @returns Promise with count of removed jobs
   */
  clear(): Promise<{ removed: number }>

  /**
   * Remove queued jobs whose payload belongs to the provided tenant/org scope.
   * Active jobs are not forcibly terminated; callers should rely on their own
   * cancellation/heartbeat contracts for in-flight work.
   */
  removeQueuedJobsByScope?(scope: QueueJobScope): Promise<{ removed: number }>

  /**
   * Close the queue and release resources.
   */
  close(): Promise<void>

  /**
   * Get current job counts by status.
   * For async strategy: returns counts from BullMQ.
   * For local strategy: waiting/completed based on last processed ID.
   */
  getJobCounts(): Promise<{
    waiting: number
    active: number
    completed: number
    failed: number
  }>
}

// ============================================================================
// Factory Types
// ============================================================================

/**
 * Discriminated union for queue creation options.
 */
export type CreateQueueConfig<S extends QueueStrategyType = QueueStrategyType> =
  S extends 'async'
    ? { strategy: 'async' } & AsyncQueueOptions
    : { strategy: 'local' } & LocalQueueOptions

/**
 * Factory function signature for creating queues.
 */
export type CreateQueueFn = <T = unknown>(
  name: string,
  strategy: QueueStrategyType,
  options?: QueueOptions<QueueStrategyType>
) => Queue<T>

// ============================================================================
// Worker Discovery Types
// ============================================================================

/**
 * Metadata exported by worker files for auto-discovery.
 *
 * @example
 * ```typescript
 * // src/modules/example/workers/my-queue.ts
 * export const metadata: WorkerMeta = {
 *   queue: 'my-queue',
 *   concurrency: 5,
 * }
 * ```
 */
export type WorkerMeta = {
  /** Queue name this worker processes */
  queue: string
  /** Optional unique identifier (defaults to <module>:workers:<filename>) */
  id?: string
  /** Worker concurrency (default: 1) */
  concurrency?: number
}

/**
 * Descriptor for a discovered and registered worker.
 * @template T - The job payload type this worker handles
 */
export type WorkerDescriptor<T = unknown> = {
  /** Unique identifier for this worker */
  id: string
  /** Queue name to process */
  queue: string
  /** Handler function */
  handler: JobHandler<T>
  /** Concurrency level */
  concurrency: number
}
