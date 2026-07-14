import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModuleEntry, PackageResolver } from '../../resolver'
import {
  renderCrudWriteFeaturesModule,
  writeCrudWriteFeaturesManifest,
  CRUD_WRITE_FEATURES_OUTPUT_FILENAME,
} from '../ui-read-only'

describe('renderCrudWriteFeaturesModule', () => {
  it('renders entities and features deterministically (sorted + deduped)', () => {
    const out = renderCrudWriteFeaturesModule({
      'sales:sales_order': ['sales.orders.manage'],
      'catalog:catalog_product': ['catalog.products.manage', ' catalog.products.manage ', 'catalog.products.export'],
    })
    expect(out).toContain('export const crudWriteFeatures: Record<string, string[]> = {')
    // Keys sorted: catalog before sales
    expect(out.indexOf('"catalog:catalog_product"')).toBeLessThan(out.indexOf('"sales:sales_order"'))
    // Features sorted + deduped/trimmed
    expect(out).toContain('"catalog:catalog_product": ["catalog.products.export", "catalog.products.manage"],')
    expect(out).toContain('"sales:sales_order": ["sales.orders.manage"],')
  })

  it('drops entities whose features are all empty/invalid', () => {
    const out = renderCrudWriteFeaturesModule({
      'x:y': [],
      'a:b': ['   ', ''],
    } as any)
    expect(out).toContain('export const crudWriteFeatures: Record<string, string[]> = {}')
  })

  it('renders an empty manifest for null/undefined', () => {
    expect(renderCrudWriteFeaturesModule(null)).toContain('crudWriteFeatures: Record<string, string[]> = {}')
    expect(renderCrudWriteFeaturesModule(undefined)).toContain('crudWriteFeatures: Record<string, string[]> = {}')
  })

  it('produces stable output regardless of input key order', () => {
    const a = renderCrudWriteFeaturesModule({ 'b:b': ['f'], 'a:a': ['g'] })
    const b = renderCrudWriteFeaturesModule({ 'a:a': ['g'], 'b:b': ['f'] })
    expect(a).toBe(b)
  })
})

describe('writeCrudWriteFeaturesManifest', () => {
  let tmpDir: string

  function createMockResolver(): PackageResolver {
    const outputDir = path.join(tmpDir, 'output', 'generated')
    fs.mkdirSync(outputDir, { recursive: true })
    return {
      isMonorepo: () => true,
      getRootDir: () => tmpDir,
      getAppDir: () => path.join(tmpDir, 'app'),
      getOutputDir: () => outputDir,
      getModulesConfigPath: () => path.join(tmpDir, 'app', 'src', 'modules.ts'),
      discoverPackages: () => [],
      loadEnabledModules: () => [] as ModuleEntry[],
      getModulePaths: (entry: ModuleEntry) => ({
        appBase: path.join(tmpDir, 'app', 'src', 'modules', entry.id),
        pkgBase: path.join(tmpDir, 'packages', 'core', 'src', 'modules', entry.id),
      }),
      getModuleImportBase: (entry: ModuleEntry) => ({
        appBase: `@/modules/${entry.id}`,
        pkgBase: `@open-mercato/core/modules/${entry.id}`,
      }),
      getPackageOutputDir: () => path.join(tmpDir, 'output', 'generated'),
      getPackageRoot: () => path.join(tmpDir, 'packages', 'core'),
    } as unknown as PackageResolver
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-read-only-generator-test-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes the manifest module to the output dir', () => {
    const resolver = createMockResolver()
    const result = writeCrudWriteFeaturesManifest({
      resolver,
      registry: { 'catalog:catalog_product': ['catalog.products.manage'] },
      quiet: true,
    })
    const outFile = path.join(tmpDir, 'output', 'generated', CRUD_WRITE_FEATURES_OUTPUT_FILENAME)
    expect(result.errors).toEqual([])
    expect(fs.existsSync(outFile)).toBe(true)
    expect(fs.readFileSync(outFile, 'utf8')).toContain('"catalog:catalog_product": ["catalog.products.manage"],')
  })

  it('always writes a (possibly empty) manifest so bootstrap can import it', () => {
    const resolver = createMockResolver()
    writeCrudWriteFeaturesManifest({ resolver, registry: null, quiet: true })
    const outFile = path.join(tmpDir, 'output', 'generated', CRUD_WRITE_FEATURES_OUTPUT_FILENAME)
    expect(fs.existsSync(outFile)).toBe(true)
    expect(fs.readFileSync(outFile, 'utf8')).toContain('crudWriteFeatures: Record<string, string[]> = {}')
  })

  it('is idempotent — a second identical write reports the file unchanged', () => {
    const resolver = createMockResolver()
    const registry = { 'sales:sales_order': ['sales.orders.manage'] }
    writeCrudWriteFeaturesManifest({ resolver, registry, quiet: true })
    const second = writeCrudWriteFeaturesManifest({ resolver, registry, quiet: true })
    const outFile = path.join(tmpDir, 'output', 'generated', CRUD_WRITE_FEATURES_OUTPUT_FILENAME)
    expect(second.filesUnchanged).toContain(outFile)
  })
})
