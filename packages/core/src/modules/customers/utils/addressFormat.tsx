import * as React from 'react'
import type { CustomerAddressFormat } from '../data/entities'

export type AddressFormatStrategy = CustomerAddressFormat

export type AddressValue = {
  addressLine1: string | null | undefined
  addressLine2?: string | null
  buildingNumber?: string | null
  flatNumber?: string | null
  city?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  companyName?: string | null
  /**
   * Contact details that belong to the ADDRESS rather than to the customer: who to call about this
   * delivery, and the tax id this invoice address was billed under. They are deliberately NOT part
   * of the postal lines — see `formatAddressLines` — and render only through `AddressView`, and only
   * when the caller supplies labels for them.
   *
   * Optional and unmodelled by `CustomerAddress` / `SalesDocumentAddress` today: an address snapshot
   * is stored as a free-form JSON record, so integrations already carry these keys and simply had no
   * way to show them.
   */
  phone?: string | null
  email?: string | null
  taxId?: string | null
}

/** Labels for the contact block. A key that is absent hides its field, so this is opt-in per field. */
export type AddressContactLabels = {
  phone?: string
  email?: string
  taxId?: string
}

export type AddressJsonShape = {
  format: AddressFormatStrategy
  companyName: string | null
  addressLine1: string | null
  addressLine2: string | null
  buildingNumber: string | null
  flatNumber: string | null
  postalCode: string | null
  city: string | null
  region: string | null
  country: string | null
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

function mergeStreetLine(address: AddressValue): string | null {
  const street = normalize(address.addressLine1)
  const building = normalize(address.buildingNumber)
  const flat = normalize(address.flatNumber)
  if (!street && !building && !flat) return null
  let line = street ?? ''
  if (building) line = line ? `${line} ${building}` : building
  if (flat) line = line ? `${line}/${flat}` : flat
  return line.length ? line : null
}

export function formatAddressJson(address: AddressValue, format: AddressFormatStrategy): AddressJsonShape {
  return {
    format,
    companyName: normalize(address.companyName),
    addressLine1: normalize(address.addressLine1),
    addressLine2: normalize(address.addressLine2),
    buildingNumber: normalize(address.buildingNumber),
    flatNumber: normalize(address.flatNumber),
    postalCode: normalize(address.postalCode),
    city: normalize(address.city),
    region: normalize(address.region),
    country: normalize(address.country),
  }
}

export function formatAddressLines(address: AddressValue, format: AddressFormatStrategy): string[] {
  const json = formatAddressJson(address, format)
  const lines: string[] = []

  if (json.companyName) lines.push(json.companyName)

  if (format === 'street_first') {
    const streetLine = mergeStreetLine(address)
    if (streetLine) lines.push(streetLine)
    const supplemental = normalize(address.addressLine2)
    if (supplemental) lines.push(supplemental)
    const postalCity = [json.postalCode, json.city].filter(Boolean).join(' ')
    if (postalCity.length) lines.push(postalCity)
    if (json.region) lines.push(json.region)
    if (json.country) lines.push(json.country)
  } else {
    if (json.addressLine1) {
      const baseLine1 = json.addressLine1
      const appended = mergeStreetLine(address)
      if (!json.buildingNumber && !json.flatNumber) {
        lines.push(baseLine1)
      } else {
        const composite = appended ?? baseLine1
        lines.push(composite)
      }
    }
    if (json.addressLine2) lines.push(json.addressLine2)
    const postalCity = [json.postalCode, json.city].filter(Boolean).join(' ')
    if (postalCity.length) lines.push(postalCity)
    if (json.region) lines.push(json.region)
    if (json.country) lines.push(json.country)
  }

  return lines
}

export function formatAddressString(address: AddressValue, format: AddressFormatStrategy, separator = ', '): string {
  return formatAddressLines(address, format).filter(Boolean).join(separator)
}

/**
 * The address's own contact details, as `[label, value]` pairs — only the fields the caller labelled
 * AND the address actually carries. Exported so a caller can ask "is there anything to show?" without
 * rendering.
 *
 * Kept out of `formatAddressLines` on purpose: those lines are the POSTAL address, and
 * `formatAddressString` joins them with ", " into one-line summaries used in pickers and table cells.
 * A tax id or phone number spliced into that string would be wrong in every one of those places.
 */
export function formatAddressContactPairs(
  address: AddressValue,
  labels: AddressContactLabels | undefined,
): Array<[string, string]> {
  if (!labels) return []
  const pairs: Array<[string, string]> = []
  const push = (label: string | undefined, value: string | null | undefined) => {
    if (!label) return
    const normalized = normalize(value)
    if (normalized) pairs.push([label, normalized])
  }
  push(labels.taxId, address.taxId)
  push(labels.phone, address.phone)
  push(labels.email, address.email)
  return pairs
}

type AddressViewProps = {
  address: AddressValue
  format: AddressFormatStrategy
  className?: string
  lineClassName?: string
  /**
   * Opt in to the contact block by supplying labels. Omitted (the default) renders exactly what this
   * component always rendered — no extra element, no wrapper, no class changes.
   *
   * Labels rather than hardcoded strings because this module is i18n-free by design; the calling
   * component already has `useT()`.
   */
  contactLabels?: AddressContactLabels
  contactClassName?: string
}

export function AddressView({
  address,
  format,
  className,
  lineClassName,
  contactLabels,
  contactClassName,
}: AddressViewProps): React.ReactElement | null {
  const lines = formatAddressLines(address, format)
  const contact = formatAddressContactPairs(address, contactLabels)
  if (!lines.length && !contact.length) return null
  return (
    <div className={className}>
      {lines.map((line, index) => (
        <div key={`${index}-${line}`} className={lineClassName}>
          {line}
        </div>
      ))}
      {contact.map(([label, value]) => (
        <div key={`contact-${label}`} className={contactClassName ?? lineClassName}>
          {label}: {value}
        </div>
      ))}
    </div>
  )
}
