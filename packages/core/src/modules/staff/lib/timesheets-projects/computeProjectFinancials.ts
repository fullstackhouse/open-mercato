import type { EntityManager } from '@mikro-orm/postgresql'
import { entryAmountExact, sumAmountsExact } from '../time-tracking/cost'
import { decimalToNumber, decimalToString, multiplyDecimals, parseDecimal } from '@open-mercato/shared/lib/decimal'

/**
 * Per-project hours and cost for the projects list.
 *
 * Cost is derived from the ROUNDED minutes of each entry (spec D-7): the amount is
 * rounded once, at the entry, and every level above is an exact sum of already
 * rounded values. It is therefore not `hours x rate` and may differ from a manual
 * recalculation of the displayed hours (screen 3 note 1).
 *
 * Every value here is scoped to a single project. Projects can be billed in
 * different currencies, so these numbers must never be summed across projects
 * (screen 3 note 2) — totalling belongs to a report, which is scoped to one
 * customer and therefore one currency.
 */
export type ProjectEntryGroup = {
  projectId: string
  isBillable: boolean
  /** A number, or an exact decimal string for rates beyond float precision. */
  rateOverrideAmount: number | string | null
  billingMinutes: number
  rawMinutes: number
  entryCount: number
}

export type ProjectFinancials = {
  totalMinutes: number
  billableMinutes: number
  cost: number | null
  costExact?: string | null
}

export type ProjectFinancialsScope = {
  em: EntityManager
  tenantId: string
  organizationId: string
  projectIds: string[]
  hourlyRateByProjectId: ReadonlyMap<string, number | string | null>
  staffMemberId?: string | null
}

type FinancialsRow = {
  project_id: string
  is_billable: boolean
  rate_override_amount: string | number | null
  billing_minutes: string | number | null
  raw_minutes: string | number | null
  entry_count: string | number
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toNullableExact(value: string | number | null | undefined): string | null {
  const parsed = parseDecimal(value)
  return parsed ? decimalToString(parsed) : null
}

function emptyFinancials(): ProjectFinancials {
  return { totalMinutes: 0, billableMinutes: 0, cost: null, costExact: null }
}

export function summarizeProjectEntryGroups(
  groups: readonly ProjectEntryGroup[],
  hourlyRateByProjectId: ReadonlyMap<string, number | string | null>,
  projectIds: readonly string[],
): Map<string, ProjectFinancials> {
  const result = new Map<string, ProjectFinancials>()
  for (const id of projectIds) result.set(id, emptyFinancials())

  const amountsByProject = new Map<string, string[]>()
  for (const group of groups) {
    const bucket = result.get(group.projectId)
    if (!bucket) continue
    bucket.totalMinutes += group.rawMinutes
    if (group.isBillable) bucket.billableMinutes += group.rawMinutes

    const amount = entryAmountExact(
      {
        isBillable: group.isBillable,
        roundedMinutes: group.billingMinutes,
        rateOverrideAmount: group.rateOverrideAmount,
      },
      { hourlyRate: hourlyRateByProjectId.get(group.projectId) ?? null },
    )
    if (amount === null) continue
    const amounts = amountsByProject.get(group.projectId) ?? []
    amounts.push(decimalToString(multiplyDecimals(amount, group.entryCount)))
    amountsByProject.set(group.projectId, amounts)
  }

  for (const [projectId, amounts] of amountsByProject) {
    const bucket = result.get(projectId)
    if (!bucket) continue
    bucket.costExact = sumAmountsExact(amounts)
    bucket.cost = decimalToNumber(bucket.costExact)
  }

  return result
}

export async function computeProjectFinancials(
  scope: ProjectFinancialsScope,
): Promise<Map<string, ProjectFinancials>> {
  if (scope.projectIds.length === 0) return new Map<string, ProjectFinancials>()

  const memberFilter = scope.staffMemberId ? 'AND staff_member_id = ?' : ''
  const projectPlaceholders = scope.projectIds.map(() => '?').join(', ')
  const params: unknown[] = [scope.organizationId, scope.tenantId, ...scope.projectIds]
  if (scope.staffMemberId) params.push(scope.staffMemberId)

  const sql = `
    SELECT
      time_project_id AS project_id,
      is_billable,
      rate_override_amount,
      COALESCE(rounded_minutes, duration_minutes) AS billing_minutes,
      COALESCE(SUM(duration_minutes), 0)::bigint AS raw_minutes,
      COUNT(*)::bigint AS entry_count
    FROM staff_time_entries
    WHERE organization_id = ?
      AND tenant_id = ?
      AND time_project_id IN (${projectPlaceholders})
      AND deleted_at IS NULL
      ${memberFilter}
    GROUP BY 1, 2, 3, 4
  `

  const rows = (await scope.em.getConnection().execute(sql, params)) as FinancialsRow[]
  const groups: ProjectEntryGroup[] = rows.map((row) => ({
    projectId: row.project_id,
    isBillable: Boolean(row.is_billable),
    rateOverrideAmount: toNullableExact(row.rate_override_amount),
    billingMinutes: toNumber(row.billing_minutes),
    rawMinutes: toNumber(row.raw_minutes),
    entryCount: toNumber(row.entry_count),
  }))

  return summarizeProjectEntryGroups(groups, scope.hourlyRateByProjectId, scope.projectIds)
}
