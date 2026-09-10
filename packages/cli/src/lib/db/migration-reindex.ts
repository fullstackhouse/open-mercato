import fs from 'node:fs'
import path from 'node:path'
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import {
  formatQueryIndexRebuildCommands,
  readQueryIndexReindexDeclaration,
  QUERY_INDEX_REINDEX_ALL,
  type QueryIndexReindexTarget,
} from '@open-mercato/shared/lib/query/migration-reindex'

const MIGRATION_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
const MIGRATION_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs']

export type AppliedMigration = {
  moduleId: string
  migrationsPath: string
  name: string
  filePath?: string | null
}

export type MigrationReindexDeps = {
  importModule: (filePath: string) => Promise<unknown>
  fileExists?: (filePath: string) => boolean
  onWarn?: (message: string) => void
}

export function isMigrationReindexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBooleanWithDefault(env.OM_MIGRATION_REINDEX, true)
}

export function resolveMigrationFilePath(
  migrationsPath: string,
  migrationName: string,
  knownPath?: string | null,
  fileExists: (filePath: string) => boolean = fs.existsSync,
): string | null {
  if (knownPath && fileExists(knownPath)) return knownPath
  const stem = path.basename(migrationName).replace(/\.(ts|js|mjs|cjs)$/i, '')
  if (!stem || !MIGRATION_FILE_NAME_PATTERN.test(stem)) return null
  for (const extension of MIGRATION_EXTENSIONS) {
    const candidate = path.join(migrationsPath, `${stem}${extension}`)
    if (fileExists(candidate)) return candidate
  }
  return null
}

export type CollectedQueryIndexReindex = {
  entityTypes: string[]
  /** `search` only when EVERY declaration asked for it; a mixed run must rebuild the document. */
  target: QueryIndexReindexTarget
}

export async function collectQueryIndexReindexEntityTypes(
  applied: readonly AppliedMigration[],
  deps: MigrationReindexDeps,
): Promise<CollectedQueryIndexReindex> {
  const fileExists = deps.fileExists ?? fs.existsSync
  const collected: string[] = []
  let sawDeclaration = false
  let allSearchOnly = true
  for (const migration of applied) {
    const filePath = resolveMigrationFilePath(
      migration.migrationsPath,
      migration.name,
      migration.filePath,
      fileExists,
    )
    if (!filePath) continue
    let moduleExports: unknown
    try {
      moduleExports = await deps.importModule(filePath)
    } catch (error) {
      deps.onWarn?.(
        `[query_index] Could not read reindex declarations from ${migration.moduleId}/${migration.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      continue
    }
    const declared = readQueryIndexReindexDeclaration(moduleExports, (rejected: unknown) => {
      deps.onWarn?.(
        `[query_index] Ignoring an invalid reindex declaration in ${migration.moduleId}/${migration.name}: ${
          JSON.stringify(rejected) ?? String(rejected)
        } is not a "module:entity" identifier, so its projection will NOT be rebuilt.`,
      )
    })
    if (!declared.entityTypes.length) continue
    sawDeclaration = true
    if (declared.target !== 'search') allSearchOnly = false
    for (const entityType of declared.entityTypes) {
      if (!collected.includes(entityType)) collected.push(entityType)
    }
  }
  return { entityTypes: collected, target: sawDeclaration && allSearchOnly ? 'search' : 'all' }
}

export function formatManualReindexInstructions(
  entityTypes: readonly string[],
  target: QueryIndexReindexTarget = 'all',
): string {
  const commands = formatQueryIndexRebuildCommands(entityTypes, target)
    .map((command) => `     ${command}`)
    .join('\n')
  return [
    '[query_index] Could not queue the reindex requested by the migrations that just ran.',
    '             Their query-index projections still hold pre-migration values until you run:',
    commands,
  ].join('\n')
}

export type QueryIndexReindexEmitter = {
  emitEvent: (event: string, payload: Record<string, unknown>, options?: { persistent?: boolean }) => Promise<void>
}

export type QueryIndexReindexContainer = {
  resolve: (name: string) => unknown
  dispose?: () => Promise<void> | void
}

export type RequestQueryIndexReindexDeps = {
  createContainer: () => Promise<QueryIndexReindexContainer>
  onInfo?: (message: string) => void
  onWarn?: (message: string) => void
}

/**
 * Queued rather than executed inline: a rebuild of a large entity type must not hold up a
 * deploy's migration step. `force` stays false so the existing `query_index.reindex`
 * subscriber upserts in place — a forced run purges the entity's rows first, which would
 * leave the projection empty for the duration of the rebuild.
 */
export type RequestQueryIndexReindexOptions = {
  target?: QueryIndexReindexTarget
  /**
   * Resolves the `'*'` wildcard to the entity types this install actually has projection rows
   * for. Omitted in tests and when no declaration used the wildcard.
   */
  resolveAllEntityTypes?: () => Promise<readonly string[]>
}

export async function requestQueryIndexReindex(
  entityTypes: readonly string[],
  deps: RequestQueryIndexReindexDeps,
  options?: RequestQueryIndexReindexOptions,
): Promise<{ requested: string[]; queued: boolean }> {
  if (!entityTypes.length) return { requested: [], queued: false }

  const target = options?.target ?? 'all'
  let container: QueryIndexReindexContainer | null = null
  const queued: string[] = []
  let resolved: string[] = []
  try {
    container = await deps.createContainer()
    resolved = await expandWildcard(entityTypes, options?.resolveAllEntityTypes)
    if (!resolved.length) return { requested: [], queued: true }
    const eventBus = container.resolve('eventBus') as QueryIndexReindexEmitter
    for (const entityType of resolved) {
      await eventBus.emitEvent(
        'query_index.reindex',
        { entityType, allowAllTenants: true, force: false, target },
        { persistent: true },
      )
      queued.push(entityType)
    }
    deps.onInfo?.(
      `[query_index] Queued a reindex for ${queued.length} entity type(s) touched by data migrations: ${queued.join(', ')}`,
    )
    return { requested: queued, queued: true }
  } catch (error) {
    const pool = resolved.length ? resolved : entityTypes
    const unqueued = pool.filter((entityType) => !queued.includes(entityType))
    deps.onWarn?.(
      `${formatManualReindexInstructions(unqueued, target)}\n             Reason: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return { requested: queued, queued: false }
  } finally {
    if (container && typeof container.dispose === 'function') {
      try {
        await container.dispose()
      } catch {
        // A container that fails to dispose must not turn a successful migration into a failure.
      }
    }
  }
}

async function expandWildcard(
  entityTypes: readonly string[],
  resolveAllEntityTypes?: () => Promise<readonly string[]>,
): Promise<string[]> {
  if (!entityTypes.includes(QUERY_INDEX_REINDEX_ALL)) return Array.from(entityTypes)
  const explicit = entityTypes.filter((entityType) => entityType !== QUERY_INDEX_REINDEX_ALL)
  const discovered = resolveAllEntityTypes ? Array.from(await resolveAllEntityTypes()) : []
  const merged: string[] = [...explicit]
  for (const entityType of discovered) {
    if (!merged.includes(entityType)) merged.push(entityType)
  }
  return merged
}
