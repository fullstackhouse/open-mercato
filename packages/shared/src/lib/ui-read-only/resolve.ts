/**
 * Server-side resolution of the effective UI read-only policy.
 *
 * Combines the two declaration tiers into one resolved map:
 *   1. Module tier — each registered module's own `uiReadOnly` manifest
 *      declaration (lowest precedence, additive/union).
 *   2. App tier — `modules.ts` inline + programmatic overrides, applied on
 *      top with replace / `null`-to-disable semantics.
 *
 * The resulting map is safe to serialize into the client so the
 * `@open-mercato/ui` provider can rebuild a queryable policy. This module
 * reads the module registry + override stores, so it is server-only; keep
 * `./policy` (pure) for anything shared with the client bundle.
 */

import { getModules } from '../modules/registry'
import { composeUiReadOnlyOverrides } from '../../modules/overrides'
import {
  applyUiReadOnlyOverrideMap,
  createUiReadOnlyPolicy,
  mergeUiReadOnlyMaps,
  type UiReadOnlyMap,
  type UiReadOnlyPolicy,
} from './policy'

/** Merge every registered module's own `uiReadOnly` declaration (module tier). */
export function composeModuleUiReadOnlyMap(): UiReadOnlyMap {
  let modules
  try {
    modules = getModules()
  } catch {
    // Registry not bootstrapped (e.g. isolated unit test) — no module tier.
    return {}
  }
  return mergeUiReadOnlyMaps(...modules.map((m) => m.uiReadOnly))
}

/**
 * Resolve the effective UI read-only map: the module tier with app-level
 * `modules.ts` overrides layered on top.
 */
export function resolveUiReadOnlyMap(): UiReadOnlyMap {
  return applyUiReadOnlyOverrideMap(composeModuleUiReadOnlyMap(), composeUiReadOnlyOverrides())
}

/** Resolve the effective UI read-only policy (built from {@link resolveUiReadOnlyMap}). */
export function resolveUiReadOnlyPolicy(): UiReadOnlyPolicy {
  return createUiReadOnlyPolicy(resolveUiReadOnlyMap())
}
