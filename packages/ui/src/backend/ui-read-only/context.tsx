'use client'

/**
 * Client-side access to the UI read-only policy.
 *
 * A server component (the backend layout) resolves the effective policy map
 * from RBAC with `resolveRbacReadOnlyMap()`
 * (`@open-mercato/shared/lib/ui-read-only/rbac`) and hands it to
 * {@link UiReadOnlyPolicyProvider}. Editable primitives (`CrudForm`,
 * `DataTable`, the inline detail editors) then read it via {@link useUiReadOnly}
 * to render display-only and hide edit/add/delete affordances for entities the
 * viewer cannot mutate.
 */

import * as React from 'react'
import {
  createUiReadOnlyPolicy,
  EMPTY_UI_READ_ONLY_POLICY,
  UI_READ_ONLY_WHOLE_ENTITY,
  type UiReadOnlyMap,
  type UiReadOnlyPolicy,
} from '@open-mercato/shared/lib/ui-read-only/policy'

const UiReadOnlyPolicyContext = React.createContext<UiReadOnlyPolicy>(EMPTY_UI_READ_ONLY_POLICY)

export type UiReadOnlyPolicyProviderProps = {
  /** Resolved read-only map (`module:entity` → fields / `['*']`). */
  map?: UiReadOnlyMap | null
  /** Pre-built policy; takes precedence over `map` when both are supplied. */
  policy?: UiReadOnlyPolicy
  children: React.ReactNode
}

/**
 * Provides the resolved UI read-only policy to the subtree. Pass either a
 * serialized `map` (typical: from a server layout) or a pre-built `policy`.
 * Nesting a provider replaces the policy for its subtree.
 */
export function UiReadOnlyPolicyProvider({ map, policy, children }: UiReadOnlyPolicyProviderProps) {
  const value = React.useMemo(
    () => policy ?? createUiReadOnlyPolicy(map ?? {}),
    [policy, map],
  )
  return <UiReadOnlyPolicyContext.Provider value={value}>{children}</UiReadOnlyPolicyContext.Provider>
}

/** Access the full resolved policy (empty policy when no provider is mounted). */
export function useUiReadOnlyPolicy(): UiReadOnlyPolicy {
  return React.useContext(UiReadOnlyPolicyContext)
}

export type EntityUiReadOnly = {
  /** The whole entity is read-only (declared `'*'`). */
  entityReadOnly: boolean
  /** The entity has any read-only declaration (field-level or whole). */
  hasEntity: boolean
  /** Whether a specific field is read-only (or the whole entity is). */
  isFieldReadOnly: (field?: string | null) => boolean
  /** Read-only field ids for the entity (`['*']` when whole-entity). */
  readOnlyFields: readonly string[]
}

/**
 * Resolve the read-only view for a single entity id. Safe to call with a
 * missing/undefined entity id (everything resolves to editable).
 */
export function useUiReadOnly(entityId?: string | null): EntityUiReadOnly {
  const policy = useUiReadOnlyPolicy()
  return React.useMemo<EntityUiReadOnly>(
    () => ({
      entityReadOnly: policy.isEntityReadOnly(entityId),
      hasEntity: policy.hasEntity(entityId),
      isFieldReadOnly: (field?: string | null) => policy.isFieldReadOnly(entityId, field),
      readOnlyFields: policy.readOnlyFields(entityId),
    }),
    [policy, entityId],
  )
}

export { UI_READ_ONLY_WHOLE_ENTITY }
export type { UiReadOnlyMap, UiReadOnlyPolicy }
