import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DecimalValue } from '@open-mercato/shared/lib/decimal'
import { ExchangeRate } from '../modules/currencies/data/entities'
import { SalesOrder } from '../modules/sales/data/entities'
import { InventoryBalance } from '../modules/wms/data/entities'

/**
 * Every `numeric` entity property exposes a computed `<property>Decimal`
 * accessor that reads (and, unless the column is generated, writes) it as a
 * `DecimalValue`. The stored property stays a string.
 */

const REPO_ROOT = resolve(__dirname, '../../../..')
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.mercato', 'build', 'coverage', '.turbo', '__tests__'])
const NUMERIC_TYPE = /\btype:\s*(ExactDecimalType|'numeric'|'decimal')/
const PROPERTY_LINE = /^[ \t]*\n[ \t]*(\w+)[!?]?:/

function collectEntityFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const absolute = join(dir, entry)
    if (statSync(absolute).isDirectory()) collectEntityFiles(absolute, found)
    else if (entry === 'entities.ts' && absolute.includes(`${join('data', 'entities.ts')}`)) found.push(absolute)
  }
  return found
}

function numericPropertyNames(source: string): string[] {
  const names: string[] = []
  let index = source.indexOf('@Property(')
  while (index >= 0) {
    let cursor = index + '@Property('.length
    let depth = 1
    while (depth > 0 && cursor < source.length) {
      if (source[cursor] === '(') depth += 1
      if (source[cursor] === ')') depth -= 1
      cursor += 1
    }
    const property = PROPERTY_LINE.exec(source.slice(cursor))
    if (property && NUMERIC_TYPE.test(source.slice(index, cursor))) names.push(property[1])
    index = source.indexOf('@Property(', cursor)
  }
  return names
}

describe('numeric entity decimal accessors', () => {
  it('declares a <property>Decimal getter for every numeric entity property', () => {
    const properties = collectEntityFiles(join(REPO_ROOT, 'packages')).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return numericPropertyNames(source).map((name) => ({ file: relative(REPO_ROOT, file), name, source }))
    })
    const missing = properties
      .filter(({ name, source }) => !source.includes(`get ${name}Decimal(`))
      .map(({ file, name }) => `${file}: ${name}`)
    expect(properties.map(({ name }) => name)).toEqual(expect.arrayContaining(['rate', 'grandTotalGrossAmount', 'quantityAvailable']))
    expect(missing).toEqual([])
  })

  it('reads and writes the stored string as a DecimalValue', () => {
    const rate = new ExchangeRate()
    rate.rate = '0.1'
    expect(rate.rateDecimal.plus('0.2').toString()).toBe('0.3')
    rate.rateDecimal = DecimalValue.from('1.230000000000000000000000000001')
    expect(rate.rate).toBe('1.230000000000000000000000000001')
  })

  it('maps null to null for nullable columns', () => {
    const order = new SalesOrder()
    expect(order.exchangeRateDecimal).toBeNull()
    order.exchangeRateDecimal = DecimalValue.from('4.25')
    expect(order.exchangeRate).toBe('4.25')
    order.exchangeRateDecimal = null
    expect(order.exchangeRate).toBeNull()
  })

  it('keeps accessors off the instance so serialization is unchanged', () => {
    const order = new SalesOrder()
    expect(Object.keys(order)).not.toContain('grandTotalGrossAmountDecimal')
    expect(JSON.parse(JSON.stringify(order))).not.toHaveProperty('grandTotalGrossAmountDecimal')
    expect(order.grandTotalGrossAmountDecimal.isZero()).toBe(true)
  })

  it('exposes generated columns read-only', () => {
    const balance = new InventoryBalance()
    balance.quantityAvailable = '7.5'
    expect(balance.quantityAvailableDecimal.toString()).toBe('7.5')
    expect(Object.getOwnPropertyDescriptor(InventoryBalance.prototype, 'quantityAvailableDecimal')?.set).toBeUndefined()
  })
})
