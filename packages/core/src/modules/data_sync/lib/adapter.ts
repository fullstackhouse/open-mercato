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
  /**
   * The sync mode this run executes (e.g. `'backfill'` | `'feed'`). Adapters that
   * declare `syncModes` for the entity dispatch on this alongside `entityType`;
   * defaults to `'backfill'` for single-mode adapters.
   */
  mode: SyncMode
  cursor?: string
  batchSize: number
  credentials: Record<string, unknown>
  mapping: DataMapping
  scope: TenantScope
  runId?: string
  /**
   * Operator-supplied run parameters, normalized against the adapter's
   * declared `runParameters`. Only declared keys are present; values are
   * already coerced to the declared types. Empty object when the adapter
   * declares no parameters.
   */
  parameters?: Record<string, RunParameterValue>
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
  /** See {@link StreamImportInput.mode}. */
  mode: SyncMode
  cursor?: string
  batchSize: number
  credentials: Record<string, unknown>
  mapping: DataMapping
  scope: TenantScope
  filter?: Record<string, unknown>
  runId?: string
  /** See {@link StreamImportInput.parameters}. */
  parameters?: Record<string, RunParameterValue>
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

export type RunParameterType = 'boolean' | 'string' | 'number' | 'select'

export type RunParameterValue = boolean | string | number

/**
 * A run's sync mode. `'backfill'` (bulk historical load) and `'feed'` (incremental
 * change-feed tail) are the built-in modes; adapters may use their own string. The
 * `(string & {})` member keeps autocomplete for the known modes while allowing any
 * adapter-defined value.
 */
export type SyncMode = 'backfill' | 'feed' | (string & {})

/** The mode a run defaults to when none is specified. */
export const DEFAULT_SYNC_MODE = 'backfill'

export interface RunParameterOption {
  value: string
  label?: string
}

/**
 * A single operator-facing parameter an adapter accepts when a run is started.
 *
 * The `data_sync` UI renders an input per declared parameter, the run API
 * validates and coerces the submitted values against this declaration, and the
 * normalized values are handed back to the adapter on `StreamImportInput` /
 * `StreamExportInput`. Keep declarations generic — this contract is provider
 * agnostic.
 */
export interface RunParameter {
  /** Stable identifier used as the key in the normalized parameters object. */
  key: string
  /** Human-readable label shown next to the input. */
  label: string
  type: RunParameterType
  /** Optional helper text rendered under the input. */
  description?: string
  /** When true, the run cannot start unless a non-empty value is provided. */
  required?: boolean
  /** Pre-filled value; also the value used when the field is left blank. */
  defaultValue?: RunParameterValue
  /** Placeholder for `string` / `number` inputs. */
  placeholder?: string
  /** Allowed choices for `select` parameters. */
  options?: RunParameterOption[]
  /** Inclusive bounds for `number` parameters. */
  min?: number
  max?: number
  /**
   * Restrict the parameter to a single run direction. When omitted the
   * parameter applies to both import and export runs.
   */
  direction?: 'import' | 'export'
  /**
   * Restrict the parameter to one or more entity types (matched against the
   * run's `entityType`, i.e. a value from `supportedEntities`). When omitted
   * the parameter applies to every entity the adapter supports. Use this when
   * a knob only makes sense for a specific entity's run — e.g. a bulk-reindex
   * toggle that only applies to the orders backfill.
   */
  entityType?: string | string[]
  /**
   * Restrict the parameter to one or more sync modes (matched against the run's
   * `mode`). When omitted the parameter applies to every mode. Use this to offer
   * backfill-only knobs (e.g. `from-beginning`, bulk reindex) separately from
   * feed-only knobs (e.g. replay-from-change-id).
   */
  mode?: SyncMode | SyncMode[]
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
  /**
   * Optional operator-facing parameters accepted when a run is started. The
   * `data_sync` dashboard renders an input per entry, and the normalized values
   * are passed back on `StreamImportInput` / `StreamExportInput`.
   */
  readonly runParameters?: RunParameter[]
  /**
   * The sync modes each entity supports, e.g. `{ sales_orders: ['backfill', 'feed'] }`.
   * The dashboard renders a mode selector when an entity supports more than one, and
   * the run API validates the requested `mode` against this. An entity absent from
   * the map (or an adapter that omits `syncModes` entirely) supports only the default
   * `'backfill'` mode — preserving single-mode adapter behaviour.
   */
  readonly syncModes?: Record<string, SyncMode[]>

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
