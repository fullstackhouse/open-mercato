/** A trigram is three characters; nothing shorter can be indexed or searched. */
export const TRIGRAM_LENGTH = 3

/**
 * Latin letters that NFKD leaves intact because they are atomic codepoints rather than a
 * base letter plus a combining mark. Stripping combining marks therefore never folds them
 * to ASCII, and word splitting then consumes them as separators \u2014 truncating `\u0141ukasz` to
 * `ukasz` and cutting `Za\u017c\u00f3\u0142\u0107` down to `zazo`. Because the same normalizer runs at index
 * time and at query time, such a record becomes unreachable from every spelling. Only
 * characters with a single unambiguous ASCII fold belong here; anything language-dependent
 * must stay out.
 *
 * `normalizeText` applies this fold AFTER NFKD and mark stripping, and the order is
 * load-bearing: folding first would miss the characters that decompose *into* one of these
 * letters, such as `\u01ff` (U+01FF \u2192 `\u00f8` + U+0301), `\u01fd` (U+01FD), `\u01e3` (U+01E3) and `\u210f` (U+210F).
 * The letters below have no decomposition of their own, so NFKD passes them through
 * untouched and they still fold correctly in this position.
 *
 * The table covers every letter in Latin-1 Supplement (U+00C0-U+00FF) and Latin Extended-A
 * (U+0100-U+017F) that NFKD leaves un-folded; `normalize.test.ts` pins that range so a gap
 * cannot silently reopen. Two entries look redundant and are not: `\u0110` (U+0110, D with
 * stroke) and `\u00d0` (U+00D0, Eth) are visually indistinguishable in uppercase and are
 * routinely substituted for one another in Croatian, Serbian and Vietnamese text, so both
 * must fold to `D` or the same rendered name yields two disjoint token sets. Do not delete
 * either as a duplicate of the other.
 *
 * Letters outside those two blocks are deliberately out of scope \u2014 `\u0259`/`\u018f` (U+0259/U+018F,
 * common in Azerbaijani names such as `\u018fliyev`) fold to `e` under ICU and belong here on
 * the same reasoning, but each addition forces operators through another trigram
 * reindex, so extending the range is tracked separately rather than done piecemeal.
 */
const NON_DECOMPOSING_FOLDS: Record<string, string> = {
  '\u0142': 'l',
  '\u0141': 'L',
  '\u00f8': 'o',
  '\u00d8': 'O',
  '\u0111': 'd',
  '\u0110': 'D',
  '\u00f0': 'd',
  '\u00d0': 'D',
  '\u0127': 'h',
  '\u0126': 'H',
  '\u0131': 'i',
  '\u0138': 'k',
  '\u014b': 'n',
  '\u014a': 'N',
  '\u0167': 't',
  '\u0166': 'T',
  '\u00e6': 'ae',
  '\u00c6': 'AE',
  '\u0153': 'oe',
  '\u0152': 'OE',
  '\u00fe': 'th',
  '\u00de': 'TH',
  '\u00df': 'ss',
  '\u1e9e': 'SS',
}

const NON_DECOMPOSING_PATTERN = new RegExp(
  `[${Object.keys(NON_DECOMPOSING_FOLDS)
    .join('')
    .replace(/[\\\]^-]/g, '\\$&')}]`,
  'g',
)

function foldNonDecomposingLetters(text: string): string {
  return text.replace(NON_DECOMPOSING_PATTERN, (char) => NON_DECOMPOSING_FOLDS[char])
}

export function normalizeText(text: string): string {
  return foldNonDecomposingLetters(text.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))
    .replace(/[%_]/g, ' ')
    .toLowerCase()
}
