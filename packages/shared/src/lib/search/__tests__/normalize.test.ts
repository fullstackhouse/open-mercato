import type { SearchConfig } from '../config'
import { DEFAULT_SEARCH_MAX_FIELD_CHARS } from '../config'
import { buildStoredForms, buildRecordTrigramHashes, trigramsOfValue } from '../trigram'

const baseConfig: SearchConfig = {
  enabled: true,
  blocklistedFields: [],
  recheckMaxRows: 1_000,
}

/** The word forms a `text` value contributes — what the tokenizer used to call its tokens. */
const words = (input: string): string[] =>
  buildStoredForms('text', input).filter((form) => form.shape === 'word').map((form) => form.value)

describe('normalizeText diacritic folding', () => {

  test.each([
    ['Łukasz', ['lukasz']],
    ['lukasz', ['lukasz']],
    ['Zażółć', ['zazolc']],
    ['Łódź', ['lodz']],
    ['Lodz', ['lodz']],
  ])('folds non-decomposing Polish letters in %s', (input, expected) => {
    expect(words(input)).toEqual(expected)
  })

  test.each([
    ['Bąk', ['bak']],
    ['Wróbel', ['wrobel']],
    ['Piotr Świątek', ['piotr', 'swiatek']],
  ])('keeps folding NFKD-decomposable diacritics in %s', (input, expected) => {
    expect(words(input)).toEqual(expected)
  })

  test.each([
    ['Jørgensen', ['jorgensen']],
    ['Đurić', ['duric']],
    ['Ħamrun', ['hamrun']],
    ['Işık', ['isik']],
    ['Æther', ['aether']],
    ['Œuvre', ['oeuvre']],
    ['Straße', ['strasse']],
    ['Þórsdóttir', ['thorsdottir']],
    ['Guðmundsdóttir', ['gudmundsdottir']],
    ['Sæþór', ['saethor']],
    ['Ŋoma', ['noma']],
    ['Ŧorvald', ['torvald']],
  ])('folds non-decomposing letters beyond Polish in %s', (input, expected) => {
    expect(words(input)).toEqual(expected)
  })

  test('folds Eth and D-with-stroke identically, since the two are visually indistinguishable', () => {
    expect(words('Đurić')).toEqual(['duric'])
    expect(words('Ðurić')).toEqual(['duric'])
    expect(trigramsOfValue('text', 'Ðurić')).toEqual(trigramsOfValue('text', 'Đurić'))
  })

  test.each([
    ['Ǿrnulf', ['ornulf']],
    ['Ǽlfric', ['aelfric']],
    ['ǣrest', ['aerest']],
    ['ℏbar', ['hbar']],
  ])('folds %s, which NFKD decomposes into a non-decomposing letter', (input, expected) => {
    expect(words(input)).toEqual(expected)
  })

  test('produces identical trigrams for the diacritic and ASCII spellings of a name', () => {
    expect(words('Łukasz Wałęsa')).toEqual(words('lukasz walesa'))
    expect(trigramsOfValue('text', 'Łukasz Wałęsa')).toEqual(trigramsOfValue('text', 'lukasz walesa'))
  })

  test('cuts trigrams from the folded word rather than the truncated one', () => {
    // Boundary-padded, so the set encodes "a word starts with `lod`" as well as the substring.
    expect(trigramsOfValue('text', 'Łódź')).toEqual(['  l', ' lo', 'lod', 'odz'])
  })

  // The property NON_DECOMPOSING_FOLDS actually exists to guarantee: no letter in the two
  // blocks it draws from may split or truncate the word it sits in. Asserting the range
  // directly is what catches a gap; enumerating characters by hand is what let nine of them
  // through in the first place.
  //
  // The three letters this list used to exempt — U+013F/U+0140 (L with middle dot) and U+0149 —
  // NFKD-decompose into a base letter plus a NON-combining separator (U+00B7, U+02BC), which the
  // token path's `[^a-z0-9]+` split then cut the word at. Trigram `text` cleaning splits on
  // whitespace, `-` and `.` only, so the residue stays inside the word and the exemption is gone.

  test('keeps every Latin-1 Supplement and Latin Extended-A letter inside a single word', () => {
    const lost: string[] = []

    for (let codePoint = 0xc0; codePoint <= 0x17f; codePoint += 1) {
      const char = String.fromCodePoint(codePoint)
      if (!/\p{L}/u.test(char)) continue
      if (words(`a${char}b`).length !== 1) {
        lost.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ${char}`)
      }
    }

    expect(lost).toEqual([])
  })
})

describe('search field limits', () => {
  const hashesFor = (doc: Record<string, unknown>, config: SearchConfig = baseConfig): number[] =>
    buildRecordTrigramHashes({
      entityType: 'demo:item',
      tenantId: 'tenant-1',
      doc,
      config,
      isFieldEligible: () => true,
    })

  test('truncates oversized field text before cutting trigrams', () => {
    const config: SearchConfig = { ...baseConfig, maxFieldChars: 10 }

    // Only the first ten characters are indexed, so a fragment past the bound cannot match.
    expect(hashesFor({ title: 'aaaa bbbb cccc' }, config))
      .toEqual(hashesFor({ title: 'aaaa bbbb' }, config))
  })

  test('applies the default field bound to a config that omits it', () => {
    const long = 'a'.repeat(DEFAULT_SEARCH_MAX_FIELD_CHARS + 5_000)

    expect(hashesFor({ title: long })).toEqual(hashesFor({ title: 'a'.repeat(DEFAULT_SEARCH_MAX_FIELD_CHARS) }))
  })

  test('allows the field bound to be disabled explicitly', () => {
    const config: SearchConfig = { ...baseConfig, maxFieldChars: 0 }

    expect(hashesFor({ title: 'alpha beta gamma delta' }, config).length).toBeGreaterThan(0)
  })
})
