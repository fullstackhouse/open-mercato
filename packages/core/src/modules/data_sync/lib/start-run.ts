import type { ProgressService } from '../../progress/lib/progressService'
import type { CursorOrigin } from './adapter'
import type { SyncRunService } from './sync-run-service'
import { getSyncQueue } from './queue'
import { DATA_SYNC_EXPORT_QUEUE, DATA_SYNC_IMPORT_QUEUE } from './queue-policy'

export type DataSyncStartScope = {
  organizationId: string
  tenantId: string
  userId?: string | null
}

export type StartDataSyncRunInput = {
  integrationId: string
  entityType: string
  direction: 'import' | 'export'
  cursor?: string | null
  /**
   * Where `cursor` came from. Omitting it means the caller chose the cursor itself, so it defaults to
   * `'explicit'` when a cursor is present and `'none'` when it is not.
   *
   * That default is deliberately the honest one for a direct caller: a provider flow that computed a
   * cursor did name it, and inferring `'inherited'` would put a label on a value the caller never
   * inherited. Callers that resolve a cursor from prior state MUST pass `'inherited'` themselves —
   * `resolveStartCursorWithOrigin` returns exactly what to pass.
   */
  cursorOrigin?: CursorOrigin
  /** The run `cursor` was inherited from, when it came from a run. See {@link StartDataSyncRunInput.cursorOrigin}. */
  cursorSourceRunId?: string | null
  triggeredBy?: string | null
  batchSize?: number
  parameters?: Record<string, unknown> | null
  createProgressJob?: boolean
  progressJob?: {
    jobType?: string
    name?: string
    description?: string
    cancellable?: boolean
    meta?: Record<string, unknown>
  }
}

export async function startDataSyncRun(params: {
  syncRunService: SyncRunService
  progressService: ProgressService
  scope: DataSyncStartScope
  input: StartDataSyncRunInput
}) {
  const { syncRunService, progressService, scope, input } = params
  const createProgressJob = input.createProgressJob !== false

  const progressJob = createProgressJob
    ? await progressService.createJob(
      {
        jobType: input.progressJob?.jobType ?? `data_sync:${input.direction}`,
        name: input.progressJob?.name ?? `Data sync ${input.integrationId} — ${input.entityType}`,
        description: input.progressJob?.description ?? `${input.entityType} ${input.direction}`,
        cancellable: input.progressJob?.cancellable ?? true,
        meta: {
          integrationId: input.integrationId,
          entityType: input.entityType,
          direction: input.direction,
          ...(input.progressJob?.meta ?? {}),
        },
      },
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        userId: scope.userId,
      },
    )
    : null

  const run = await syncRunService.createRun(
    {
      integrationId: input.integrationId,
      entityType: input.entityType,
      direction: input.direction,
      cursor: input.cursor ?? null,
      cursorOrigin: input.cursorOrigin ?? (input.cursor == null ? 'none' : 'explicit'),
      cursorSourceRunId: input.cursorSourceRunId ?? null,
      triggeredBy: input.triggeredBy ?? scope.userId ?? null,
      parameters: input.parameters ?? null,
      progressJobId: progressJob?.id ?? null,
    },
    {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
    },
  )

  const queueName = input.direction === 'import' ? DATA_SYNC_IMPORT_QUEUE : DATA_SYNC_EXPORT_QUEUE
  const queue = getSyncQueue(queueName)
  await queue.enqueue({
    runId: run.id,
    batchSize: input.batchSize ?? 100,
    scope: {
      organizationId: scope.organizationId,
      tenantId: scope.tenantId,
      userId: scope.userId ?? null,
    },
  })

  return {
    run,
    progressJob,
  }
}
