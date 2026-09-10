import crypto from 'crypto'
import { resolveLookupPepper } from '@open-mercato/shared/lib/encryption/aes'
import { normalizeText, TRIGRAM_LENGTH } from './normalize'
import { resolveSearchConfig, resolveSearchFieldLimits, type SearchConfig } from './config'

/**
 * How a searchable value is cleaned before it is cut into trigrams, and therefore how an
 * operator's term has to be typed for it to match.
 *
 * - `text`       word-prefix matching (plus whole-value substring, see {@link buildStoredForms})
 * - `identifier` literal substring, spaces and punctuation included (`ZK 1/2026`)
 * - `email`      literal substring over the lowercased address
 * - `phone`      literal substring over the digit string, country prefix marker removed
 * - `taxId`      whole value only, letters and digits, optional country prefix stripped
 * - `exact`      whole value only, cleaned as text
 */
export type SearchFieldKind = 'text' | 'identifier' | 'phone' | 'taxId' | 'email' | 'exact'

export const SEARCH_FIELD_KINDS: readonly SearchFieldKind[] = [
  'text',
  'identifier',
  'phone',
  'taxId',
  'email',
  'exact',
]

export function isSearchFieldKind(value: unknown): value is SearchFieldKind {
  return typeof value === 'string' && (SEARCH_FIELD_KINDS as readonly string[]).includes(value)
}

export { TRIGRAM_LENGTH }

/**
 * Two leading spaces, the way pg_trgm pads a word, so `  w`/` wa` encode "a word starts here".
 * A padded form therefore answers word-prefix containment with the same `@>` a substring uses.
 */
const WORD_PAD = '  '

/**
 * Control characters that no cleaner can emit, wrapped around a form that must match as a
 * whole value. A tax id delimited this way can never match inside a phone number.
 */
const FORM_START = '\u0001'
const FORM_END = '\u0002'

/** Digits shorter than this are a year or a house number, not a phone fragment. */
const PHONE_MIN_DIGITS = 6

const TAX_ID_MIN_LENGTH = 8
const TAX_ID_MAX_LENGTH = 14

/**
 * A term longer than this may carry a country prefix the stored value does not.
 *
 * Open Mercato has no tenant region setting, so the reader cannot parse the term against a known
 * country. Substring on the full digit string already covers the common direction — a term
 * WITHOUT the code finds a value WITH it. For the reverse the reader tries the term with its
 * first one to three digits dropped as additional readings. It is a heuristic, so it only widens
 * the candidate set; the recheck keeps the answer honest.
 */
const PHONE_PREFIX_DROP_MIN_DIGITS = 8
const PHONE_PREFIX_DROP_MAX = 3

export type StoredForm = {
  /** The cleaned string the trigrams are cut from, before padding or delimiting. */
  value: string
  shape: 'word' | 'raw' | 'whole'
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function digitsOf(text: string): string {
  return text.replace(/\D+/g, '')
}

function alphanumericOf(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '').toUpperCase()
}

/**
 * Strips the "this number carries a country prefix" marker without guessing which country it
 * names: `+` and a leading `00` are notation, every other digit is part of the number.
 */
function cleanPhone(text: string): string {
  const trimmed = text.trim()
  const withoutPlus = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed
  const digits = digitsOf(withoutPlus)
  if (!trimmed.startsWith('+') && digits.startsWith('00')) return digits.slice(2)
  return digits
}

/**
 * A tax id is routinely typed with and without its country prefix (`PL5261040828` /
 * `5261040828`), so both are stored. The prefix is only stripped when two letters are followed
 * by digits, which is the ISO-3166 shape — `NL123456789B01` keeps its trailing suffix.
 */
function taxIdForms(text: string): string[] {
  const compact = alphanumericOf(text)
  if (!compact) return []
  const forms = [compact]
  const prefixed = /^([A-Z]{2})(\d.*)$/.exec(compact)
  if (prefixed) forms.push(prefixed[2])
  return forms
}

function splitWords(text: string): string[] {
  return text.split(/[\s.\-]+/).filter((word) => word.length > 0)
}

/**
 * The cleaned forms a value contributes for a given kind.
 *
 * `text` deliberately contributes two shapes: one padded form per word (word-prefix matching,
 * what a name search wants) plus the whole cleaned string unpadded (literal substring, what a
 * document number typed as `ZK 1/2026` wants). Without the second shape an entity that never
 * declares its field kinds — the drop-in default — could not answer a substring at all, which
 * is one of the two semantics this design exists to provide. The extra cost is roughly one more
 * trigram per character of the value.
 */
export function buildStoredForms(kind: SearchFieldKind, rawValue: string): StoredForm[] {
  if (typeof rawValue !== 'string') return []
  switch (kind) {
    case 'text': {
      const cleaned = collapseWhitespace(normalizeText(rawValue))
      if (!cleaned) return []
      const forms: StoredForm[] = splitWords(cleaned).map((word) => ({ value: word, shape: 'word' as const }))
      forms.push({ value: cleaned, shape: 'raw' })
      return forms
    }
    case 'identifier': {
      const cleaned = collapseWhitespace(normalizeText(rawValue))
      return cleaned ? [{ value: cleaned, shape: 'raw' }] : []
    }
    case 'email': {
      const cleaned = rawValue.trim().toLowerCase()
      return cleaned ? [{ value: cleaned, shape: 'raw' }] : []
    }
    case 'phone': {
      const digits = cleanPhone(rawValue)
      return digits.length >= PHONE_MIN_DIGITS ? [{ value: digits, shape: 'raw' }] : []
    }
    case 'taxId':
      return taxIdForms(rawValue).map((value) => ({ value, shape: 'whole' as const }))
    case 'exact': {
      const cleaned = collapseWhitespace(normalizeText(rawValue))
      return cleaned ? [{ value: cleaned, shape: 'whole' }] : []
    }
    default:
      return []
  }
}

function decorateForm(form: StoredForm): string {
  if (form.shape === 'word') return `${WORD_PAD}${form.value}`
  if (form.shape === 'whole') return `${FORM_START}${form.value}${FORM_END}`
  return form.value
}

/**
 * Every three-character window of a decorated form.
 *
 * The minimum is checked on the UNDECORATED value: padding would otherwise let a one-character
 * value or term produce a trigram, and the two sides must agree on what is indexable. A form
 * shorter than three characters is therefore unsearchable — the same floor `OM_SEARCH_MIN_LEN`
 * used to set, now a constant because a trigram is three characters by definition.
 */
export function trigramsOfForm(form: StoredForm): string[] {
  if (form.value.length < TRIGRAM_LENGTH) return []
  const decorated = decorateForm(form)
  if (decorated.length < TRIGRAM_LENGTH) return []
  const out: string[] = []
  for (let index = 0; index + TRIGRAM_LENGTH <= decorated.length; index += 1) {
    out.push(decorated.slice(index, index + TRIGRAM_LENGTH))
  }
  return out
}

export function trigramsOfValue(kind: SearchFieldKind, rawValue: string): string[] {
  const seen = new Set<string>()
  for (const form of buildStoredForms(kind, rawValue)) {
    for (const trigram of trigramsOfForm(form)) seen.add(trigram)
  }
  return Array.from(seen)
}

/**
 * `int4(HMAC-SHA256(pepper, tenantId + ':' + trigram))`, truncated to 32 bits.
 *
 * Per tenant, so the same plaintext hashes differently in different tenants and a cross-tenant
 * dump join learns nothing. With no pepper configured (a `TENANT_DATA_ENCRYPTION=no` install)
 * this degrades to an unkeyed SHA-256 over the same message — the strength the token index had,
 * never weaker.
 *
 * Truncation to 32 bits leaves ~4e9 buckets for the ~40k plausible trigrams of a language, and a
 * collision can only add a false candidate, which the recheck removes.
 */
export function hashTrigram(trigram: string, tenantId: string | null | undefined): number {
  const pepper = resolveLookupPepper()
  const message = `${tenantId ?? ''}:${trigram}`
  const digest = pepper
    ? crypto.createHmac('sha256', pepper).update(message).digest()
    : crypto.createHash('sha256').update(message).digest()
  // Signed, because the column is `int4` and Postgres has no unsigned integer.
  return digest.readInt32BE(0)
}

function hashTrigrams(trigrams: readonly string[], tenantId: string | null | undefined): number[] {
  const seen = new Set<number>()
  for (const trigram of trigrams) seen.add(hashTrigram(trigram, tenantId))
  return Array.from(seen)
}

export type BuildRecordTrigramsInput = {
  entityType: string
  tenantId: string | null | undefined
  /** Decrypted index document. */
  doc: Record<string, unknown> | null | undefined
  /** Per-field kinds from the module's declaration; every other field defaults to `text`. */
  fieldKinds?: Record<string, SearchFieldKind> | null
  /** When the declaration replaces the default field selection instead of refining it. */
  onlyDeclaredFields?: boolean
  config?: SearchConfig
  /** Decides whether a field is eligible at all (blocklist, id/timestamp columns, …). */
  isFieldEligible: (field: string, value: unknown) => boolean
}

function collectTextValues(value: unknown): string[] {
  if (typeof value === 'string') return value.length ? [value] : []
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length) out.push(entry)
  }
  return out
}

/**
 * The full hash set stored on one projection row.
 *
 * Order is not meaningful and duplicates are collapsed: the column is a set, queried with `@>`.
 */
export function buildRecordTrigramHashes(input: BuildRecordTrigramsInput): number[] {
  const config = input.config ?? resolveSearchConfig()
  if (!config.enabled) return []
  if (!input.doc) return []
  const limits = resolveSearchFieldLimits(config)
  const declared = input.fieldKinds ?? null
  const hashes = new Set<number>()

  for (const [field, rawValue] of Object.entries(input.doc)) {
    const declaredKind = declared?.[field]
    if (input.onlyDeclaredFields && !declaredKind) continue
    if (!declaredKind && !input.isFieldEligible(field, rawValue)) continue
    if (declaredKind && !input.isFieldEligible(field, rawValue)) {
      // A declaration names the field but the blocklist still owns the veto — an operator who
      // blocks a column must not have it re-enter search through a module's declaration.
      continue
    }
    const kind = declaredKind ?? 'text'
    for (const text of collectTextValues(rawValue)) {
      const bounded = limits.maxFieldChars > 0 ? text.slice(0, limits.maxFieldChars) : text
      for (const trigram of trigramsOfValue(kind, bounded)) {
        hashes.add(hashTrigram(trigram, input.tenantId))
      }
    }
  }

  return Array.from(hashes)
}

// ---------------------------------------------------------------------------
// Query side
// ---------------------------------------------------------------------------

/**
 * One way of reading the operator's term. `groups` all have to be contained by the row's hash
 * set (AND); a query ORs its alternatives together.
 */
export type TrigramShaping = {
  kind: SearchFieldKind
  /** Cleaned forms, kept for the recheck. */
  forms: StoredForm[]
  /** Hashed trigram groups; every group must be contained. */
  groups: number[][]
}

export type TrigramQuery = {
  term: string
  shapings: TrigramShaping[]
}

export type BuildTrigramQueryInput = {
  term: string
  tenantId: string | null | undefined
  /**
   * Kinds to try. Without a declaration every shaping the term's shape allows is tried, which
   * is the "match wherever it can" behaviour a list search box wants.
   */
  kinds?: readonly SearchFieldKind[] | null
}

/**
 * Which readings a term's own shape allows. A term with `@` is worth trying as an e-mail; a
 * digit run of six or more as a phone; an 8–14 character alphanumeric as a tax id.
 */
export function candidateKindsForTerm(term: string): SearchFieldKind[] {
  const kinds: SearchFieldKind[] = ['text', 'identifier']
  if (term.includes('@')) kinds.push('email')
  if (cleanPhone(term).length >= PHONE_MIN_DIGITS) kinds.push('phone')
  const compact = alphanumericOf(term)
  if (compact.length >= TAX_ID_MIN_LENGTH && compact.length <= TAX_ID_MAX_LENGTH) kinds.push('taxId')
  return kinds
}

function shapingFrom(
  kind: SearchFieldKind,
  forms: StoredForm[],
  tenantId: string | null | undefined,
): TrigramShaping | null {
  if (!forms.length) return null
  const groups: number[][] = []
  for (const form of forms) {
    // A `text` term contributes one group per word plus its whole-string form. On a single-word
    // term the whole-string group repeats that word's unpadded trigrams, so ANDing it changes
    // nothing; on a multi-word term it additionally requires the words to appear together.
    const trigrams = trigramsOfForm(form)
    if (!trigrams.length) continue
    groups.push(hashTrigrams(trigrams, tenantId))
  }
  if (!groups.length) return null
  return { kind, forms, groups }
}

function shapingFor(
  kind: SearchFieldKind,
  term: string,
  tenantId: string | null | undefined,
): TrigramShaping | null {
  return shapingFrom(kind, buildStoredForms(kind, term), tenantId)
}

/** The prefix-drop readings of a phone term; empty unless the term is long enough to carry one. */
function phonePrefixDropShapings(
  term: string,
  tenantId: string | null | undefined,
): TrigramShaping[] {
  const digits = cleanPhone(term)
  if (digits.length <= PHONE_PREFIX_DROP_MIN_DIGITS) return []
  const out: TrigramShaping[] = []
  for (let drop = 1; drop <= PHONE_PREFIX_DROP_MAX; drop += 1) {
    const candidate = digits.slice(drop)
    if (candidate.length < PHONE_MIN_DIGITS) break
    const shaping = shapingFrom('phone', [{ value: candidate, shape: 'raw' }], tenantId)
    if (shaping) out.push(shaping)
  }
  return out
}

/**
 * Shape a term into the containment predicates that can answer it.
 *
 * Returns `null` when no reading of the term produces a trigram — a term under three characters
 * once cleaned. Callers MUST reject such a term rather than drop the predicate: dropping it
 * silently returns the unfiltered list, which is what the token path did.
 */
export function buildTrigramQuery(input: BuildTrigramQueryInput): TrigramQuery | null {
  const term = input.term.trim()
  if (!term) return null
  const kinds = input.kinds?.length ? input.kinds : candidateKindsForTerm(term)
  const shapings: TrigramShaping[] = []
  const seen = new Set<SearchFieldKind>()
  for (const kind of kinds) {
    if (seen.has(kind)) continue
    seen.add(kind)
    const shaping = shapingFor(kind, term, input.tenantId)
    if (shaping) shapings.push(shaping)
    // Ordered after the exact digit string deliberately: the exact reading is the one that should
    // win, and a prefix-drop reading only ever adds candidates the recheck can still reject.
    if (kind === 'phone') shapings.push(...phonePrefixDropShapings(term, input.tenantId))
  }
  if (!shapings.length) return null
  return { term, shapings }
}

// ---------------------------------------------------------------------------
// Recheck
// ---------------------------------------------------------------------------

/**
 * Containment proves every fragment is present, not that they are contiguous, so a candidate row
 * can be a false positive. The recheck is a substring/prefix test of the cleaned term against the
 * cleaned values the engine already decrypted.
 */
function shapingMatchesValue(shaping: TrigramShaping, kind: SearchFieldKind, value: string): boolean {
  const valueForms = buildStoredForms(kind, value)
  if (!valueForms.length) return false
  switch (shaping.kind) {
    case 'text': {
      const words = valueForms.filter((form) => form.shape === 'word').map((form) => form.value)
      const termWords = shaping.forms.filter((form) => form.shape === 'word').map((form) => form.value)
      if (!termWords.length) return false
      return termWords.every((termWord) => words.some((word) => word.startsWith(termWord)))
    }
    case 'identifier':
    case 'email':
    case 'phone': {
      const needle = shaping.forms[0]?.value
      if (!needle) return false
      return valueForms.some((form) => form.value.includes(needle))
    }
    case 'taxId':
    case 'exact':
      return shaping.forms.some((termForm) => valueForms.some((form) => form.value === termForm.value))
    default:
      return false
  }
}

export type RecheckValue = { field: string; value: string }

/**
 * True when at least one shaping of the term genuinely matches at least one of the row's values.
 *
 * `fieldKinds` names how each value was indexed; a value whose field carries no declaration is
 * rechecked as `text`, matching how it was written. A shaping is compared against a value under
 * BOTH kinds — the shaping's own and the value's — because a `text`-indexed value also carries an
 * unpadded whole-string form, so an `identifier` term can legitimately match it.
 */
export function recheckMatches(
  query: TrigramQuery,
  values: readonly RecheckValue[],
  fieldKinds?: Record<string, SearchFieldKind> | null,
): boolean {
  for (const shaping of query.shapings) {
    for (const entry of values) {
      const valueKind = fieldKinds?.[entry.field] ?? 'text'
      if (shapingMatchesValue(shaping, valueKind, entry.value)) return true
      if (valueKind !== shaping.kind && shapingMatchesValue(shaping, shaping.kind, entry.value)) return true
    }
  }
  return false
}
