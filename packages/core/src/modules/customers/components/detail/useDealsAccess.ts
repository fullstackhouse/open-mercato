"use client"

import * as React from 'react'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { hasFeatureExcluding } from '@open-mercato/shared/security/features'

export type DealsAccess = {
  canViewDeals: boolean
  isReady: boolean
}

export function useDealsAccess(): DealsAccess {
  const { payload, isReady } = useBackendChrome()
  const canViewDeals = React.useMemo(
    () => hasFeatureExcluding(payload?.grantedFeatures ?? [], 'customers.deals.view', payload?.removedFeatures),
    [payload?.grantedFeatures, payload?.removedFeatures],
  )
  return { canViewDeals, isReady }
}
