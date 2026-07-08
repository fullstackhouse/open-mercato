import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { getIntegration } from '@open-mercato/shared/modules/integrations/types'
import type { ProgressService } from '../../progress/lib/progressService'
import type { IntegrationStateService } from '../../integrations/lib/state-service'
import type { SyncRunService } from '../lib/sync-run-service'
import { runSyncSchema } from '../data/validators'
import { startDataSyncRun } from '../lib/start-run'
import { getDataSyncAdapter } from '../lib/adapter-registry'
import { normalizeRunParameters } from '../lib/run-parameters'
import {
  runCrudMutationGuardAfterSuccess,
  validateCrudMutationGuard,
} from '@open-mercato/shared/lib/crud/mutation-guard'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['data_sync.run'] },
}

export const openApi = {
  tags: ['DataSync'],
  summary: 'Start a data sync run',
}

export async function POST(req: Request) {
  try {
    const auth = await getAuthFromRequest(req)
    if (!auth?.tenantId || !auth.orgId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const payload = await readJsonSafe(req)
    const parsed = runSyncSchema.safeParse(payload)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 422 })
    }

    const container = await createRequestContainer()
    const syncRunService = container.resolve('dataSyncRunService') as SyncRunService
    const progressService = container.resolve('progressService') as ProgressService
    const integrationStateService = container.resolve('integrationStateService') as IntegrationStateService

    const scope = {
      organizationId: auth.orgId as string,
      tenantId: auth.tenantId,
    }

    const integration = getIntegration(parsed.data.integrationId)
    if (!integration?.providerKey) {
      return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
    }

    const adapter = getDataSyncAdapter(integration.providerKey)
    if (!adapter) {
      return NextResponse.json({ error: 'No registered sync adapter for provider' }, { status: 404 })
    }
    if (adapter.runMode === 'provider') {
      return NextResponse.json(
        {
          error: 'This integration must be started from its provider-specific import flow.',
          settingsPath: `/backend/integrations/${encodeURIComponent(parsed.data.integrationId)}`,
        },
        { status: 422 },
      )
    }

    if (!adapter.supportedEntities.includes(parsed.data.entityType)) {
      return NextResponse.json({ error: 'Unsupported entity type for this integration' }, { status: 422 })
    }

    // Validate the requested sync mode against what the adapter declares for this
    // entity. An entity with no declared modes supports only the default 'backfill'.
    const allowedModes = adapter.syncModes?.[parsed.data.entityType] ?? ['backfill']
    if (!allowedModes.includes(parsed.data.mode)) {
      return NextResponse.json(
        { error: `Unsupported sync mode '${parsed.data.mode}' for this entity`, details: { allowedModes } },
        { status: 422 },
      )
    }

    const normalizedParameters = normalizeRunParameters(
      adapter.runParameters,
      parsed.data.direction,
      parsed.data.parameters,
      parsed.data.entityType,
      parsed.data.mode,
    )
    if (!normalizedParameters.ok) {
      return NextResponse.json(
        { error: 'Invalid run parameters', details: { parameters: normalizedParameters.errors } },
        { status: 422 },
      )
    }

    const integrationEnabled = await integrationStateService.isEnabled(parsed.data.integrationId, scope)
    if (!integrationEnabled) {
      return NextResponse.json({ error: 'Integration is disabled' }, { status: 409 })
    }

    const overlap = await syncRunService.findRunningOverlap(
      parsed.data.integrationId,
      parsed.data.entityType,
      parsed.data.direction,
      scope,
    )
    if (overlap) {
      return NextResponse.json({ error: 'A sync run is already in progress for this integration and entity direction' }, { status: 409 })
    }

    const guardResult = await validateCrudMutationGuard(container, {
      tenantId: auth.tenantId,
      organizationId: scope.organizationId,
      userId: auth.sub,
      resourceKind: 'data_sync.run',
      resourceId: parsed.data.integrationId,
      operation: 'custom',
      requestMethod: req.method,
      requestHeaders: req.headers,
      mutationPayload: parsed.data,
    })
    if (guardResult && !guardResult.ok) {
      return NextResponse.json(guardResult.body, { status: guardResult.status })
    }

    const cursor = parsed.data.fullSync
      ? null
      : await syncRunService.resolveCursor(parsed.data.integrationId, parsed.data.entityType, parsed.data.direction, parsed.data.mode, scope)

    const { run, progressJob } = await startDataSyncRun({
      syncRunService,
      progressService,
      scope: {
        ...scope,
        userId: auth.sub,
      },
      input: {
        integrationId: parsed.data.integrationId,
        entityType: parsed.data.entityType,
        direction: parsed.data.direction,
        mode: parsed.data.mode,
        cursor,
        triggeredBy: parsed.data.triggeredBy ?? auth.sub,
        batchSize: parsed.data.batchSize,
        parameters: Object.keys(normalizedParameters.values).length > 0
          ? normalizedParameters.values
          : null,
      },
    })

    if (guardResult?.ok && guardResult.shouldRunAfterSuccess) {
      await runCrudMutationGuardAfterSuccess(container, {
        tenantId: auth.tenantId,
        organizationId: scope.organizationId,
        userId: auth.sub,
        resourceKind: 'data_sync.run',
        resourceId: run.id,
        operation: 'custom',
        requestMethod: req.method,
        requestHeaders: req.headers,
        metadata: guardResult.metadata ?? null,
      })
    }

    return NextResponse.json({ id: run.id, progressJobId: progressJob?.id ?? null }, { status: 201 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    console.error('[data_sync.run] unhandled error', { message, stack })
    return NextResponse.json(
      { error: 'Failed to start data sync run.' },
      { status: 500 },
    )
  }
}
