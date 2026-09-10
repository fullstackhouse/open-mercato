import {
  DEFAULT_SEARCH_MAX_FIELD_CHARS,
  DEFAULT_SEARCH_RECHECK_MAX_ROWS,
  resolveSearchConfig,
  resolveSearchFieldLimits,
  resolveSearchMinTokenLength,
  isSearchFieldBlocklisted,
} from '../config'
import { TRIGRAM_LENGTH } from '../normalize'

describe('resolveSearchMinTokenLength', () => {
  it('is the trigram length, not a knob', () => {
    // `OM_SEARCH_MIN_LEN` is gone: a trigram is three characters, so nothing shorter can be
    // indexed or searched however the operator configures the install.
    process.env.OM_SEARCH_MIN_LEN = '5'
    try {
      expect(resolveSearchMinTokenLength()).toBe(TRIGRAM_LENGTH)
    } finally {
      delete process.env.OM_SEARCH_MIN_LEN
    }
  })
})

describe('OM_SEARCH_FIELD_BLOCKLIST parsing', () => {
  const originalValue = process.env.OM_SEARCH_FIELD_BLOCKLIST

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.OM_SEARCH_FIELD_BLOCKLIST
    } else {
      process.env.OM_SEARCH_FIELD_BLOCKLIST = originalValue
    }
  })

  it('always includes the built-in defaults', () => {
    delete process.env.OM_SEARCH_FIELD_BLOCKLIST
    const config = resolveSearchConfig()
    expect(config.blocklistedFields).toEqual(expect.arrayContaining(['password', 'token', 'secret', 'hash']))
    expect(config.entityBlocklistedFields).toEqual({})
  })

  it('treats an unprefixed entry as global and lowercases it', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = ' Body , body '
    const config = resolveSearchConfig()
    expect(config.blocklistedFields.filter((entry) => entry === 'body')).toHaveLength(1)
    expect(config.entityBlocklistedFields).toEqual({})
  })

  it('routes an entityType@field entry into the per-entity map only', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = 'customers:customer_interaction@body'
    const config = resolveSearchConfig()
    expect(config.blocklistedFields).not.toContain('body')
    expect(config.entityBlocklistedFields).toEqual({ 'customers:customer_interaction': ['body'] })
  })

  it('groups several fields under the same entity type', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = 'customers:customer_interaction@body,customers:customer_interaction@subject'
    expect(resolveSearchConfig().entityBlocklistedFields).toEqual({
      'customers:customer_interaction': ['body', 'subject'],
    })
  })

  it('ignores entries whose field part is empty', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = 'customers:customer_interaction@,@,body'
    const config = resolveSearchConfig()
    expect(config.blocklistedFields).toContain('body')
    expect(config.entityBlocklistedFields).toEqual({})
  })

  it('treats a leading separator as a global entry', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = '@body'
    const config = resolveSearchConfig()
    expect(config.blocklistedFields).toContain('body')
    expect(config.entityBlocklistedFields).toEqual({})
  })

  it('stores entity types that collide with inherited object keys as own entries', () => {
    process.env.OM_SEARCH_FIELD_BLOCKLIST = 'constructor@body,toString@summary,__proto__@notes'
    const config = resolveSearchConfig()

    expect(Object.getPrototypeOf(config.entityBlocklistedFields)).toBeNull()
    expect(config.entityBlocklistedFields?.['constructor']).toEqual(['body'])
    expect(config.entityBlocklistedFields?.['tostring']).toEqual(['summary'])
    expect(config.entityBlocklistedFields?.['__proto__']).toEqual(['notes'])
    expect(isSearchFieldBlocklisted('body', 'constructor', config)).toBe(true)
    expect(isSearchFieldBlocklisted('summary', 'toString', config)).toBe(true)
    expect(isSearchFieldBlocklisted('notes', '__proto__', config)).toBe(true)
  })
})

describe('search field limits', () => {
  const variableNames = ['OM_SEARCH_MAX_FIELD_CHARS', 'OM_SEARCH_RECHECK_MAX_ROWS'] as const
  const originalValues = Object.fromEntries(variableNames.map((name) => [name, process.env[name]]))

  afterEach(() => {
    for (const name of variableNames) {
      const original = originalValues[name]
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
  })

  it('uses safe defaults when limits are unset', () => {
    for (const name of variableNames) delete process.env[name]

    const config = resolveSearchConfig()
    expect(resolveSearchFieldLimits(config)).toEqual({ maxFieldChars: DEFAULT_SEARCH_MAX_FIELD_CHARS })
    expect(config.recheckMaxRows).toBe(DEFAULT_SEARCH_RECHECK_MAX_ROWS)
  })

  it('accepts zero to disable the field bound', () => {
    process.env.OM_SEARCH_MAX_FIELD_CHARS = '0'

    expect(resolveSearchFieldLimits(resolveSearchConfig())).toEqual({ maxFieldChars: 0 })
  })

  it('normalizes an invalid custom config value to the default', () => {
    expect(resolveSearchFieldLimits({ ...resolveSearchConfig(), maxFieldChars: -5 }))
      .toEqual({ maxFieldChars: DEFAULT_SEARCH_MAX_FIELD_CHARS })
  })

  it('reads OM_SEARCH_RECHECK_MAX_ROWS', () => {
    process.env.OM_SEARCH_RECHECK_MAX_ROWS = '25'

    expect(resolveSearchConfig().recheckMaxRows).toBe(25)
  })
})

