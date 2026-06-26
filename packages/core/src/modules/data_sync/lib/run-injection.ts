import type { InjectionSpotId } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Widget-injection spot rendered inside the Data Sync dashboard "Run once now" card, between the
 * built-in batch-size / full-sync controls and the Start button.
 *
 * It lets an integration provider mount its OWN launch controls (e.g. a keyset start id, a dry-run
 * toggle, a "from the beginning" switch) and trigger a provider-specific run — without the core
 * `data_sync` run schema having to learn about any provider's parameters. The generic Start button
 * stays in place for the vanilla cursor-resume run; the injected widget owns whatever extra
 * parameters its adapter understands and how it dispatches them (its own API route / Job).
 *
 * Register a widget for this spot from a provider module's `widgets/injection-table.ts`.
 */
export const DATA_SYNC_RUN_PARAMS_SPOT_ID: InjectionSpotId = 'data_sync.dashboard:run-params'

/**
 * Context passed to widgets mounted at {@link DATA_SYNC_RUN_PARAMS_SPOT_ID}. Mirrors the current
 * selection in the run-now form so a provider widget can scope its controls to the right integration
 * and launch a run consistent with the operator's pick.
 */
export type DataSyncRunParamsContext = {
  integrationId: string
  providerKey: string | null
  entityType: string
  direction: 'import' | 'export'
  fullSync: boolean
  batchSize: number
  isEnabled: boolean
  hasCredentials: boolean
  /** Refresh the runs table below the form after the widget launches its own run. */
  reloadRuns: () => void
}
