export { matchFeature } from '../lib/auth/featureMatch'
import { matchFeature } from '../lib/auth/featureMatch'

export function hasFeature(granted: readonly string[] | undefined, required: string): boolean {
  if (!Array.isArray(granted) || !granted.length) return false
  return granted.some((feature) => matchFeature(required, feature))
}

export function hasAllFeatures(
  granted: readonly string[] | undefined,
  required: readonly string[] | undefined
): boolean {
  if (!required || required.length === 0) return true
  if (!Array.isArray(granted) || !granted.length) return false
  return required.every((feature) => hasFeature(granted, feature))
}

/**
 * Pure variants that additionally deny required features present in an
 * explicit exclusion list (e.g. `BackendChromePayload.removedFeatures`, the
 * ids removed from the ACL contract via `null` overrides). A wildcard grant
 * cannot express a deny, so callers holding a client-hydrated grant list must
 * pass the removed ids alongside it. Server code should prefer the
 * registry-backed helpers in `security/enabledModulesRegistry`.
 */
export function hasFeatureExcluding(
  granted: readonly string[] | undefined,
  required: string,
  removed: readonly string[] | undefined,
): boolean {
  if (Array.isArray(removed) && removed.includes(required)) return false
  return hasFeature(granted, required)
}

export function hasAllFeaturesExcluding(
  granted: readonly string[] | undefined,
  required: readonly string[] | undefined,
  removed: readonly string[] | undefined,
): boolean {
  if (!required || required.length === 0) return true
  if (Array.isArray(removed) && removed.length && required.some((feature) => removed.includes(feature))) return false
  return hasAllFeatures(granted, required)
}
