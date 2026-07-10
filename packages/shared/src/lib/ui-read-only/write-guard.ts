/**
 * Optional server-side enforcement for the declarative UI read-only policy.
 *
 * The same `uiReadOnly` declaration that renders fields display-only can also
 * *reject the write* server-side — defense-in-depth so a read-only field/entity
 * cannot be mutated even outside the admin UI. Enforcement is **opt-in and
 * configurable** (default off), because the primary contract is a UI display
 * policy; some deployments want the UI hidden but the API still writable (e.g.
 * a background sync that writes via the command bus, not HTTP).
 *
 * Configured via `OM_UI_READ_ONLY_ENFORCE_WRITES`:
 *   - unset / `off` / `false` / `0` → disabled (default)
 *   - `all` / `true` / `1`        → enforce for every read-only entity
 *   - `a:b, c:d`                   → enforce only for the listed entity ids
 *
 * Mirrors the env-gated shape of the optimistic-lock guard.
 */

import type { MutationGuard } from '../crud/mutation-guard-registry'
import type { UiReadOnlyPolicy } from './policy'
import { resolveUiReadOnlyPolicy } from './resolve'

export const UI_READ_ONLY_ENFORCE_ENV_VAR = 'OM_UI_READ_ONLY_ENFORCE_WRITES'

export type UiReadOnlyEnforcementConfig =
  | { mode: 'off' }
  | { mode: 'all' }
  | { mode: 'entities'; entities: Set<string> }

/** Both canonical spellings of an entity id (`module:entity` / `module.entity`). */
function entityIdCandidates(id: string): string[] {
  const trimmed = id.trim()
  if (!trimmed) return []
  const colon = trimmed.replace(/\./g, ':')
  const dot = trimmed.replace(/:/g, '.')
  return colon === dot ? [colon] : [colon, dot]
}

/** Parse the `OM_UI_READ_ONLY_ENFORCE_WRITES` env value. */
export function parseUiReadOnlyEnforceEnv(raw: string | undefined | null): UiReadOnlyEnforcementConfig {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value || value === 'off' || value === 'false' || value === '0' || value === 'no') return { mode: 'off' }
  if (value === 'all' || value === 'true' || value === '1' || value === 'yes') return { mode: 'all' }
  const entities = new Set<string>()
  for (const token of value.split(',')) {
    for (const candidate of entityIdCandidates(token)) entities.add(candidate)
  }
  return entities.size ? { mode: 'entities', entities } : { mode: 'off' }
}

function isEntityEnforced(config: UiReadOnlyEnforcementConfig, entityId: string): boolean {
  if (config.mode === 'off') return false
  if (config.mode === 'all') return true
  return entityIdCandidates(entityId).some((c) => config.entities.has(c))
}

export type CreateUiReadOnlyWriteGuardOptions = {
  /** Resolve the effective policy (defaults to the module+app resolver). */
  resolvePolicy?: () => UiReadOnlyPolicy
  /** Resolve enforcement config (defaults to reading the env var). */
  resolveConfig?: () => UiReadOnlyEnforcementConfig
}

/**
 * Build the built-in UI-read-only write guard. Registered by the bootstrap
 * factory for every app but **inert unless enabled** via the env var, so it is
 * safe to ship on by default.
 */
export function createUiReadOnlyWriteGuard(options: CreateUiReadOnlyWriteGuardOptions = {}): MutationGuard {
  const resolvePolicy = options.resolvePolicy ?? resolveUiReadOnlyPolicy
  const resolveConfig = options.resolveConfig
    ?? (() => parseUiReadOnlyEnforceEnv(process.env[UI_READ_ONLY_ENFORCE_ENV_VAR]))

  return {
    id: 'core.ui-read-only-write-guard',
    targetEntity: '*',
    operations: ['create', 'update', 'delete'],
    // Run early — a read-only write should be rejected before heavier guards.
    priority: 10,
    async validate(input) {
      const config = resolveConfig()
      if (config.mode === 'off') return { ok: true }
      const entityId = input.resourceKind
      if (!entityId || !isEntityEnforced(config, entityId)) return { ok: true }

      const policy = resolvePolicy()
      const candidates = entityIdCandidates(entityId)

      // Whole-entity read-only → reject every mutation (create/update/delete).
      if (candidates.some((c) => policy.isEntityReadOnly(c))) {
        return {
          ok: false,
          status: 422,
          body: {
            error: 'ui_read_only',
            message: `Entity "${entityId}" is read-only in this deployment and cannot be modified.`,
          },
        }
      }

      // Per-field read-only only constrains writes that touch those fields.
      if (input.operation === 'delete') return { ok: true }
      const payload = input.mutationPayload
      if (!payload || typeof payload !== 'object') return { ok: true }
      const blocked = Object.keys(payload).filter((field) =>
        candidates.some((c) => policy.isFieldReadOnly(c, field)),
      )
      if (blocked.length) {
        return {
          ok: false,
          status: 422,
          body: {
            error: 'ui_read_only',
            message: `Fields are read-only and cannot be modified: ${blocked.join(', ')}.`,
            fields: blocked,
          },
        }
      }
      return { ok: true }
    },
  }
}
