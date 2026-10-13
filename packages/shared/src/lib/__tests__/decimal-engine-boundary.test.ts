import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Only `packages/shared/src/lib/decimalEngine.ts` may import the decimal library
 * or the engine, so swapping the library stays a one-file change. Everything
 * else uses `DecimalValue` from `@open-mercato/shared/lib/decimal`.
 */

const REPO_ROOT = resolve(__dirname, '../../../../..')
const SCAN_ROOTS = ['packages', 'apps']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.mercato', 'build', 'coverage', '.turbo'])
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs']
const ENGINE_FILE = join('packages', 'shared', 'src', 'lib', 'decimalEngine.ts')
const DECIMAL_FILE = join('packages', 'shared', 'src', 'lib', 'decimal.ts')
const LIBRARY_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:big\.js|decimal\.js|bignumber\.js)['"]/
const ENGINE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*decimalEngine['"]/

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const absolute = join(dir, entry)
    const stats = statSync(absolute)
    if (stats.isDirectory()) collectSourceFiles(absolute, found)
    else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(absolute)
  }
  return found
}

describe('decimal engine boundary', () => {
  const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(join(REPO_ROOT, root)))
    .map((absolute) => ({ path: relative(REPO_ROOT, absolute), source: readFileSync(absolute, 'utf8') }))

  it('imports the decimal library only from the engine adapter', () => {
    const offenders = files
      .filter((file) => file.path !== ENGINE_FILE && LIBRARY_IMPORT.test(file.source))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })

  it('imports the engine adapter only from the decimal toolkit', () => {
    const offenders = files
      .filter((file) => file.path !== DECIMAL_FILE && ENGINE_IMPORT.test(file.source))
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })
})
