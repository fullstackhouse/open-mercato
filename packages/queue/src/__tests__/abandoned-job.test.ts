import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createModuleQueue } from '../factory'
import { getRedisUrlOrThrow } from '@open-mercato/shared/lib/redis/connection'
import type { QueuedJob } from '../types'

type WorkerListener = (...args: unknown[]) => void

let capturedProcessor: ((job: { id?: string; data: unknown; attemptsMade: number }) => Promise<void>) | null = null
const capturedListeners = new Map<string, WorkerListener[]>()

function emit(event: string, ...args: unknown[]): void {
  for (const listener of capturedListeners.get(event) ?? []) listener(...args)
}

jest.mock('@open-mercato/shared/lib/redis/connection', () => ({
  getRedisUrlOrThrow: jest.fn(),
}))

jest.mock('bullmq', () => {
  class MockQueue<T> {
    constructor(_name: string, _opts: unknown) {}
    add = jest.fn(async () => ({ id: 'bull-job-id' }))
    close = jest.fn(async () => {})
    obliterate = jest.fn(async () => {})
    getJobCounts = jest.fn(async () => ({ waiting: 0, active: 0, completed: 0, failed: 0 }))
    getJobs = jest.fn(async () => [])
  }

  class MockWorker<T> {
    constructor(
      _name: string,
      processor: (job: { id?: string; data: T; attemptsMade: number }) => Promise<void>,
      _opts: unknown,
    ) {
      capturedProcessor = processor as (job: { id?: string; data: unknown; attemptsMade: number }) => Promise<void>
    }

    on = (event: string, listener: WorkerListener) => {
      const existing = capturedListeners.get(event) ?? []
      existing.push(listener)
      capturedListeners.set(event, existing)
    }

    close = jest.fn(async () => {})
  }

  return { Queue: MockQueue, Worker: MockWorker }
})

type Payload = { runId: string }

function bullJob(id: string, payload: Payload): { id: string; data: QueuedJob<Payload>; attemptsMade: number } {
  return {
    id,
    data: { id, payload, createdAt: new Date(0).toISOString() },
    attemptsMade: 0,
  }
}

describe('onJobAbandoned', () => {
  const getRedisUrlOrThrowMock = getRedisUrlOrThrow as jest.MockedFunction<typeof getRedisUrlOrThrow>
  const originalStrategy = process.env.QUEUE_STRATEGY

  beforeEach(() => {
    jest.clearAllMocks()
    capturedProcessor = null
    capturedListeners.clear()
    getRedisUrlOrThrowMock.mockReturnValue('redis://localhost:6379')
    process.env.QUEUE_STRATEGY = 'async'
  })

  afterEach(() => {
    if (originalStrategy === undefined) delete process.env.QUEUE_STRATEGY
    else process.env.QUEUE_STRATEGY = originalStrategy
  })

  it('fires with the job payload when the queue fails a job it never handed to the handler', async () => {
    const onJobAbandoned = jest.fn(async () => {})
    const queue = createModuleQueue<Payload>('test-queue', { onJobAbandoned })
    await queue.process(async () => {})

    const job = bullJob('job-1', { runId: 'run-1' })
    emit('failed', job, new Error('job stalled more than allowable limit'))
    await Promise.resolve()

    expect(onJobAbandoned).toHaveBeenCalledTimes(1)
    expect(onJobAbandoned).toHaveBeenCalledWith(job.data, {
      jobId: 'job-1',
      reason: 'job stalled more than allowable limit',
    })
  })

  it('does not fire when the handler ran and threw — that failure is the handler\'s own', async () => {
    const onJobAbandoned = jest.fn(async () => {})
    const handlerError = new Error('import batch blew up')
    const queue = createModuleQueue<Payload>('test-queue', { onJobAbandoned })
    await queue.process(async () => {
      throw handlerError
    })

    const job = bullJob('job-1', { runId: 'run-1' })
    await expect(capturedProcessor!(job)).rejects.toThrow(handlerError)
    emit('failed', job, handlerError)
    await Promise.resolve()

    expect(onJobAbandoned).not.toHaveBeenCalled()
  })

  it('fires for a later abandonment of the same job id after an earlier run completed', async () => {
    const onJobAbandoned = jest.fn(async () => {})
    const queue = createModuleQueue<Payload>('test-queue', { onJobAbandoned })
    await queue.process(async () => {})

    const job = bullJob('job-1', { runId: 'run-1' })
    await capturedProcessor!(job)
    emit('completed', job)
    emit('failed', job, new Error('job stalled more than allowable limit'))
    await Promise.resolve()

    expect(onJobAbandoned).toHaveBeenCalledTimes(1)
  })

  it('tracks jobs independently when several run concurrently', async () => {
    const onJobAbandoned = jest.fn(async () => {})
    const queue = createModuleQueue<Payload>('test-queue', { onJobAbandoned, concurrency: 2 })
    await queue.process(async () => {})

    const running = bullJob('job-running', { runId: 'run-1' })
    const abandoned = bullJob('job-abandoned', { runId: 'run-2' })
    await capturedProcessor!(running)
    emit('failed', running, new Error('handler failed'))
    emit('failed', abandoned, new Error('job stalled more than allowable limit'))
    await Promise.resolve()

    expect(onJobAbandoned).toHaveBeenCalledTimes(1)
    expect(onJobAbandoned).toHaveBeenCalledWith(abandoned.data, {
      jobId: 'job-abandoned',
      reason: 'job stalled more than allowable limit',
    })
  })

  it('swallows a throwing hook so the reporting cannot kill the worker', async () => {
    const onJobAbandoned = jest.fn(async () => {
      throw new Error('reporting failed')
    })
    const queue = createModuleQueue<Payload>('test-queue', { onJobAbandoned })
    await queue.process(async () => {})

    const job = bullJob('job-1', { runId: 'run-1' })
    expect(() => emit('failed', job, new Error('job stalled more than allowable limit'))).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(onJobAbandoned).toHaveBeenCalledTimes(1)
  })

  it('is not forwarded to the local strategy, which cannot abandon a job', async () => {
    process.env.QUEUE_STRATEGY = 'local'
    const originalCwd = process.cwd()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-abandoned-'))
    process.chdir(tmp)

    try {
      const onJobAbandoned = jest.fn(async () => {})
      const queue = createModuleQueue<Payload>('test-queue', { onJobAbandoned })
      expect(queue.strategy).toBe('local')

      await queue.enqueue({ runId: 'run-1' })
      const result = await queue.process(
        async () => {
          throw new Error('handler failed')
        },
        { limit: 1 },
      )

      expect(result.failed).toBe(1)
      expect(onJobAbandoned).not.toHaveBeenCalled()
      await queue.close()
    } finally {
      process.chdir(originalCwd)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
