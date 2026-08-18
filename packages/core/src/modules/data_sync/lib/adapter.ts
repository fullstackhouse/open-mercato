export interface TenantScope {
  organizationId: string
  tenantId: string
}

export type FieldMappingKind =
  | 'core'
  | 'relation'
  | 'external_id'
  | 'custom_field'
  | 'metadata'
  | 'ignore'

export type FieldMappingDedupeRole = 'primary' | 'secondary'

export interface FieldMapping {
  externalField: string
  localField: string
  transform?: string
  required?: boolean
  defaultValue?: unknown
  mappingKind?: FieldMappingKind
  dedupeRole?: FieldMappingDedupeRole
}

export interface DataMapping {
  entityType: string
  fields: FieldMapping[]
  matchStrategy: 'externalId' | 'sku' | 'email' | 'custom'
  matchField?: string
}

export interface StreamImportInput {
  entityType: string
  cursor?: string
  batchSize: number
  credentials: Record<string, unknown>
  mapping: DataMapping
  scope: TenantScope
  runId?: string
  /**
   * Aborted when the run is cancelled, so an adapter can stop INSIDE a batch.
   *
   * The engine only gets to look at cancellation between batches — its check sits at the top of the
   * `for await` body, which is reached after the adapter has yielded. An adapter whose batch takes
   * minutes (a whole-table walk over a slow link) therefore keeps working, keeps writing, and keeps
   * its advisory lock for that whole time, however long ago the operator pressed Cancel.
   *
   * Honour it wherever the work is divisible — per page, per record, around a long flush — and just
   * return: the generator's own `finally` runs, which is where a lock or a connection is released.
   * Adapters that ignore it behave exactly as they do today.
   *
   * The `return` MUST sit ABOVE the `yield` for the page you abandoned, never below it. The engine
   * commits `batch.cursor` for every batch it receives, so yielding a half-applied page advances the
   * cursor past records that were never applied and no later run ever walks them again.
   *
   * The signal only reaches work running in THIS process. An adapter that hands part of a batch to
   * other workers must give that work its own cancellation check against the same progress job —
   * aborting here stops the generator, not anything already queued elsewhere.
   */
  signal?: AbortSignal
}

export interface ImportItem {
  externalId: string
  data: Record<string, unknown>
  action: 'create' | 'update' | 'skip' | 'failed'
  hash?: string
}

export interface ImportBatch {
  items: ImportItem[]
  cursor: string
  hasMore: boolean
  totalEstimate?: number
  processedCount?: number
  refreshCoverageEntityTypes?: string[]
  message?: string
  batchIndex: number
}

export interface StreamExportInput {
  entityType: string
  cursor?: string
  batchSize: number
  credentials: Record<string, unknown>
  mapping: DataMapping
  scope: TenantScope
  filter?: Record<string, unknown>
  runId?: string
  /** Aborted when the run is cancelled — see {@link StreamImportInput.signal}. */
  signal?: AbortSignal
}

export interface ExportItemResult {
  localId: string
  externalId?: string
  status: 'success' | 'error' | 'skipped'
  error?: string
}

export interface ExportBatch {
  results: ExportItemResult[]
  cursor: string
  hasMore: boolean
  batchIndex: number
}

export interface ValidationResult {
  ok: boolean
  message?: string
  details?: Record<string, unknown>
}

export interface DataSyncAdapter {
  readonly providerKey: string
  readonly direction: 'import' | 'export' | 'bidirectional'
  readonly supportedEntities: string[]
  /**
   * How a run may be started.
   *
   * - `generic` (default): `/api/data_sync/run` has enough information to
   *   create and enqueue the run.
   * - `provider`: the provider owns a prerequisite flow before a run can be
   *   enqueued, such as uploading a CSV and linking that upload to the run.
   */
  readonly runMode?: 'generic' | 'provider'
  readonly operationalTelemetry?: boolean

  streamImport?(input: StreamImportInput): AsyncIterable<ImportBatch>
  streamExport?(input: StreamExportInput): AsyncIterable<ExportBatch>
  getInitialCursor?(input: { entityType: string; scope: TenantScope }): Promise<string | null>
  getMapping(input: { entityType: string; scope: TenantScope }): Promise<DataMapping>
  validateConnection?(input: {
    entityType: string
    credentials: Record<string, unknown>
    mapping: DataMapping
    scope: TenantScope
  }): Promise<ValidationResult>
}
