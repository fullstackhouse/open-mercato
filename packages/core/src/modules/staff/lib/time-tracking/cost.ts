/**
 * EP-33 — the rate resolver chain.
 *
 * `applicableRate` is still the single place an hourly rate is chosen, and
 * `entryAmount` still the single place an amount is produced (D-7). What changed
 * is that the override → project-rate chain now lives in the built-in resolver
 * `staff.time_tracking.rate.entry_override_then_project`, registered at module
 * load, instead of being spelled inline. Contributed resolvers are consulted in
 * descending priority ahead of it, but only when the caller supplies a complete
 * tenant + organization scope; with no contribution — or with none of them
 * answering — the built-in decides, so the number is the one this file always
 * produced.
 */

import { extensionPoints } from '@open-mercato/core/modules/staff/extension-points'
import {
  FX_DECIMAL_PLACES,
  decimalToNumber,
  decimalToString,
  divideDecimals,
  parseDecimal,
  roundDecimal,
  sumDecimals,
  toDecimal,
} from '@open-mercato/shared/lib/decimal'
import { createStrategyRegistry, BUILT_IN_STRATEGY_PRIORITY } from './registries/registry'
import { tryStrategy } from './registries/invoke'
import { hasResolverScope, type ScopedResolverContext } from './registries/scope'

export type CostEntry = {
  isBillable: boolean
  roundedMinutes: number
  /** A number, or an exact decimal string for rates beyond float precision. */
  rateOverrideAmount?: number | string | null
}

export type CostProject = {
  /** A number, or an exact decimal string for rates beyond float precision. */
  hourlyRate?: number | string | null
}

/** Amounts round to the currency's decimals; 2 when the currency is unknown. */
export const DEFAULT_STAFF_AMOUNT_DECIMAL_PLACES = 2

/**
 * Everything a rate resolver may reason about. Only `entry` and `project` are
 * populated by the module's own call sites; the remaining fields exist so a
 * contributed resolver can key off seniority, task type, customer contract or an
 * effective date without the call site having to invent its own context shape.
 */
export type TimeRateContext = ScopedResolverContext & {
  entry?: Pick<CostEntry, 'rateOverrideAmount'> | null
  project?: CostProject | null
  task?: { id?: string | null; timeProjectId?: string | null } | null
  staffMember?: { id?: string | null } | null
  role?: { id?: string | null; name?: string | null } | null
  customer?: { id?: string | null } | null
  date?: string | null
}

export type TimeRateResolver = {
  id: string
  priority?: number
  /** A number, or an exact decimal string for rates beyond float precision. */
  resolve(ctx: TimeRateContext): number | string | null
}

export const TIME_RATE_REGISTRY_ID = extensionPoints.hosts.timeRateRegistry.spotId

export const BUILT_IN_TIME_RATE_RESOLVER_ID = 'staff.time_tracking.rate.entry_override_then_project'

const registry = createStrategyRegistry<TimeRateResolver>(TIME_RATE_REGISTRY_ID)

export function registerTimeRateResolver(resolver: TimeRateResolver): () => void {
  return registry.register(resolver)
}

export function listTimeRateResolvers(): TimeRateResolver[] {
  return registry.list()
}

export function getTimeRateResolver(id: string | null | undefined): TimeRateResolver | null {
  return registry.get(id)
}

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  const sign = value < 0 ? -1 : 1
  const magnitude = Math.abs(value)
  const shifted = Number(`${magnitude}e2`)
  if (!Number.isFinite(shifted)) return sign * (Math.round(magnitude * 100) / 100)
  const rounded = Math.round(shifted)
  const restored = Number(`${rounded}e-2`)
  if (!Number.isFinite(restored)) return sign * (rounded / 100)
  return sign * restored
}

function exactRate(value: unknown): string | null {
  const parsed = parseDecimal(value)
  return parsed ? decimalToString(parsed) : null
}

function builtInRate(ctx: TimeRateContext): number | string | null {
  const override = ctx.entry?.rateOverrideAmount
  if (exactRate(override) !== null) return override as number | string
  const projectRate = ctx.project?.hourlyRate
  if (exactRate(projectRate) !== null) return projectRate as number | string
  return null
}

const builtInRateResolver: TimeRateResolver = registry.registerBuiltIn({
  id: BUILT_IN_TIME_RATE_RESOLVER_ID,
  priority: BUILT_IN_STRATEGY_PRIORITY,
  resolve: builtInRate,
})

/**
 * Walks the registry in priority order and takes the first non-null answer.
 * Contributed resolvers are skipped entirely when the context carries no
 * complete scope, which leaves the built-in as the only candidate.
 */
/** Exact-decimal variant of {@link resolveTimeRate}. */
export function resolveTimeRateExact(ctx: TimeRateContext): string | null {
  const scoped = hasResolverScope(ctx)
  for (const resolver of registry.list()) {
    if (!scoped && resolver.id !== BUILT_IN_TIME_RATE_RESOLVER_ID) continue
    // A chain asks the next candidate anyway, so a thrower is skipped rather than
    // replaced — and the built-in is always the last candidate.
    const rate = exactRate(tryStrategy(TIME_RATE_REGISTRY_ID, resolver.id, () => resolver.resolve(ctx)))
    if (rate !== null) return rate
  }
  return null
}

export function resolveTimeRate(ctx: TimeRateContext): number | null {
  const rate = resolveTimeRateExact(ctx)
  return rate === null ? null : decimalToNumber(rate)
}

/** Exact-decimal variant of {@link applicableRate}. */
export function applicableRateExact(
  entry: Pick<CostEntry, 'rateOverrideAmount'> | null | undefined,
  project: CostProject | null | undefined,
  ctx?: Omit<TimeRateContext, 'entry' | 'project'> | null,
): string | null {
  return resolveTimeRateExact({ ...(ctx ?? {}), entry: entry ?? null, project: project ?? null })
}

export function applicableRate(
  entry: Pick<CostEntry, 'rateOverrideAmount'> | null | undefined,
  project: CostProject | null | undefined,
  ctx?: Omit<TimeRateContext, 'entry' | 'project'> | null,
): number | null {
  const rate = applicableRateExact(entry, project, ctx)
  return rate === null ? null : decimalToNumber(rate)
}

/**
 * Exact-decimal variant of {@link entryAmount}: rate x minutes / 60, rounded
 * half-up to `decimalPlaces` (the currency's decimals).
 */
export function entryAmountExact(
  entry: CostEntry,
  project: CostProject | null | undefined,
  ctx?: Omit<TimeRateContext, 'entry' | 'project'> | null,
  decimalPlaces: number = DEFAULT_STAFF_AMOUNT_DECIMAL_PLACES,
): string | null {
  if (!entry?.isBillable) return null
  const rate = applicableRateExact(entry, project, ctx)
  if (rate === null) return null
  const minutes = Number.isFinite(entry.roundedMinutes) ? entry.roundedMinutes : 0
  const amount = divideDecimals(toDecimal(rate).times(minutes), 60, FX_DECIMAL_PLACES)
  return decimalToString(roundDecimal(amount, decimalPlaces))
}

export function entryAmount(
  entry: CostEntry,
  project: CostProject | null | undefined,
  ctx?: Omit<TimeRateContext, 'entry' | 'project'> | null,
): number | null {
  const amount = entryAmountExact(entry, project, ctx)
  return amount === null ? null : decimalToNumber(amount)
}

/**
 * Exact-decimal variant of {@link sumAmounts}: each amount is rounded to
 * `decimalPlaces` first, so the sum equals adding up the printed values.
 */
export function sumAmountsExact(
  amounts: readonly (number | string | null | undefined)[],
  decimalPlaces: number = DEFAULT_STAFF_AMOUNT_DECIMAL_PLACES,
): string {
  const rounded = amounts.flatMap((amount) => {
    const parsed = parseDecimal(amount)
    return parsed ? [roundDecimal(parsed, decimalPlaces)] : []
  })
  return decimalToString(sumDecimals(rounded))
}

export function sumAmounts(amounts: readonly (number | null | undefined)[]): number {
  return decimalToNumber(sumAmountsExact(amounts))
}
