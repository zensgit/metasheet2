import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePluginRuntimeConfig } from '../../src/plugin-runtime-config'

describe('plugin runtime config resolution', () => {
  it('keeps non-integration plugins unconfigured', () => {
    const config = resolvePluginRuntimeConfig('plugin-view-kanban', {
      INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON: '[{"actionId":"plm.stock-preparation.pull-bom.v1"}]',
    })

    expect(config).toEqual({})
  })

  it('does not parse table-action env for unrelated plugins', () => {
    expect(resolvePluginRuntimeConfig('plugin-view-kanban', {
      INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON: '{not-json',
    })).toEqual({})
  })

  it('injects table-action config only into plugin-integration-core', () => {
    const stockAction = {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      source: {
        kind: 'data-source:sql-readonly',
        externalSystemId: 'ext_plm_sql',
      },
      target: {
        sheetId: 'sheet_stock',
      },
    }
    const genericAction = {
      actionId: 'custom.lookup.v1',
      source: { externalSystemId: 'ext_lookup' },
      target: { sheetId: 'sheet_lookup' },
    }

    const config = resolvePluginRuntimeConfig('plugin-integration-core', {
      INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON: JSON.stringify([stockAction]),
      INTEGRATION_CORE_TABLE_ACTIONS_JSON: JSON.stringify({ lookup: genericAction }),
    })

    expect(config).toEqual({
      stockPreparationTableActions: [stockAction],
      tableActions: { lookup: genericAction },
    })
  })

  it('injects C6 test failure injection config only when explicitly deploy-enabled', () => {
    const config = resolvePluginRuntimeConfig('plugin-integration-core', {
      METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED: 'true',
      INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON: JSON.stringify({
        enabled: true,
        pipelineId: 'pipe_c6',
        targetSystemId: 'target_c6',
        targetDataSourceId: 'writable-ds',
        targetObject: 'public.target_items',
        environment: 'sandbox',
        failWriteOrdinal: 2,
      }),
    })

    expect(config).toEqual({
      c6TestFailureInjection: {
        deployEnabled: true,
        enabled: true,
        pipelineId: 'pipe_c6',
        targetSystemId: 'target_c6',
        targetDataSourceId: 'writable-ds',
        targetObject: 'public.target_items',
        environment: 'sandbox',
        failWriteOrdinal: 2,
      },
    })
  })

  it('keeps C6 test failure injection default-off without the deploy flag', () => {
    const config = resolvePluginRuntimeConfig('plugin-integration-core', {
      INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON: JSON.stringify({
        enabled: true,
        pipelineId: 'pipe_c6',
        targetSystemId: 'target_c6',
        targetDataSourceId: 'writable-ds',
        targetObject: 'public.target_items',
        environment: 'sandbox',
      }),
    })

    expect(config).toEqual({
      c6TestFailureInjection: {
        deployEnabled: false,
        enabled: true,
        pipelineId: 'pipe_c6',
        targetSystemId: 'target_c6',
        targetDataSourceId: 'writable-ds',
        targetObject: 'public.target_items',
        environment: 'sandbox',
      },
    })
  })

  it('fails closed on invalid JSON', () => {
    expect(() => resolvePluginRuntimeConfig('plugin-integration-core', {
      INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON: '{not-json',
    })).toThrow('INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON must be valid JSON')
  })

  it('fails closed when table-action env is not an array or object', () => {
    expect(() => resolvePluginRuntimeConfig('plugin-integration-core', {
      INTEGRATION_CORE_TABLE_ACTIONS_JSON: '"not-an-action-list"',
    })).toThrow('INTEGRATION_CORE_TABLE_ACTIONS_JSON must be a JSON array or object')
  })

  it('fails closed when C6 test failure injection config is not an object', () => {
    expect(() => resolvePluginRuntimeConfig('plugin-integration-core', {
      INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON: '["not-an-object"]',
    })).toThrow('INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON must be a JSON object')
  })
  // Customer-pack catalog: the env names a FILE, because a pack is deploy-time DATA (≈20 extension
  // columns plus dictionaries of hundreds of entries) that an environment variable cannot carry —
  // the catalog module says so explicitly and offers no env fallback of its own.
  describe('customer pack catalog', () => {
    const ENV_KEY = 'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH'
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'pack-catalog-'))
    })
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    function writePackFile(contents: string): string {
      const file = join(tmpDir, 'packs.json')
      writeFileSync(file, contents, 'utf8')
      return file
    }

    it('omits the key entirely when unset — an empty catalog refuses every packId', () => {
      const config = resolvePluginRuntimeConfig('plugin-integration-core', {})
      expect('stockPreparationCustomerPacks' in config).toBe(false)
    })

    it('reads the pack map off the named file', () => {
      const file = writePackFile(JSON.stringify({
        'factory-a': { packId: 'factory-a', packVersion: 1, extensionFields: [] },
      }))
      const config = resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file })
      expect(config.stockPreparationCustomerPacks).toEqual({
        'factory-a': { packId: 'factory-a', packVersion: 1, extensionFields: [] },
      })
    })

    it('fails closed — and LOUDLY — when the path is unreadable, rather than degrading to empty', () => {
      // A typo in the path must not look exactly like "no packs configured".
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', {
        [ENV_KEY]: join(tmpDir, 'does-not-exist.json'),
      })).toThrow(`${ENV_KEY} points at a file that could not be read`)
    })

    it('never echoes the configured path in the error (values-free: paths are deployment topology)', () => {
      const secretish = join(tmpDir, 'absent-host-specific-name.json')
      try {
        resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: secretish })
        throw new Error('expected a throw')
      } catch (error) {
        expect((error as Error).message).not.toContain(secretish)
        expect((error as Error).message).toContain(ENV_KEY)
      }
    })

    it('fails closed on malformed JSON', () => {
      const file = writePackFile('{not-json')
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file }))
        .toThrow(`${ENV_KEY} must point at a file containing valid JSON`)
    })

    it('fails closed when the file is not an object keyed by packId', () => {
      const file = writePackFile('[{"packId":"factory-a"}]')
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file }))
        .toThrow(`${ENV_KEY} must point at a JSON object keyed by packId`)
    })

    it('is inert for any other plugin', () => {
      const file = writePackFile(JSON.stringify({ 'factory-a': {} }))
      expect(resolvePluginRuntimeConfig('plugin-after-sales', { [ENV_KEY]: file })).toEqual({})
    })
  })

  // The source->`ext_` field mapping is the OTHER half of the pack line: a pack declares which
  // tenant columns exist, the mapping declares where their values come from. It is the same kind of
  // deploy-time artifact (a tenant's own legacy column names) read by the same file-path posture, so
  // it shares the pack reader rather than growing a parallel one that could drift from it.
  //
  // Before this key existed, the plugin's mapper had NO producer: `computeDryRun` took an
  // `extFieldMapping` parameter that nothing on any route ever passed, so no production path could
  // produce an `ext_` value at all.
  describe('stock preparation ext field mapping', () => {
    const ENV_KEY = 'INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH'
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ext-field-mapping-'))
    })
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    function writeMappingFile(contents: string): string {
      const file = join(tmpDir, 'ext-field-mapping.json')
      writeFileSync(file, contents, 'utf8')
      return file
    }

    const MAPPING = {
      packId: 'factory-a',
      mappingId: 'factory-a-legacy',
      mappingVersion: 1,
      mappings: [{ sourceColumn: 'Designer', target: 'ext_designer' }],
    }

    it('omits the key entirely when unset — the mapper stays dormant and no ext_ value is produced', () => {
      const config = resolvePluginRuntimeConfig('plugin-integration-core', {})
      expect('stockPreparationExtFieldMapping' in config).toBe(false)
    })

    it('reads the mapping off the named file', () => {
      const file = writeMappingFile(JSON.stringify(MAPPING))
      const config = resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file })
      expect(config.stockPreparationExtFieldMapping).toEqual(MAPPING)
    })

    it('fails closed — and LOUDLY — when the path is unreadable, rather than degrading to no mapping', () => {
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', {
        [ENV_KEY]: join(tmpDir, 'does-not-exist.json'),
      })).toThrow(`${ENV_KEY} points at a file that could not be read`)
    })

    it('never echoes the configured path in the error (values-free: paths are deployment topology)', () => {
      const secretish = join(tmpDir, 'absent-host-specific-name.json')
      try {
        resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: secretish })
        throw new Error('expected a throw')
      } catch (error) {
        expect((error as Error).message).not.toContain(secretish)
        expect((error as Error).message).toContain(ENV_KEY)
      }
    })

    it('fails closed on malformed JSON', () => {
      const file = writeMappingFile('{not-json')
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file }))
        .toThrow(`${ENV_KEY} must point at a file containing valid JSON`)
    })

    it('fails closed when the file is not a JSON object', () => {
      const file = writeMappingFile(JSON.stringify([MAPPING]))
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file }))
        .toThrow(`${ENV_KEY} must point at a JSON object`)
    })

    it('is inert for any other plugin', () => {
      const file = writeMappingFile(JSON.stringify(MAPPING))
      expect(resolvePluginRuntimeConfig('plugin-after-sales', { [ENV_KEY]: file })).toEqual({})
    })

    // The pack key keeps its own, more specific shape message: sharing a reader must not blur the
    // diagnosis a deployer gets.
    it('leaves the pack catalog`s shape message unchanged', () => {
      const packFile = join(tmpDir, 'packs.json')
      writeFileSync(packFile, '[{"packId":"factory-a"}]', 'utf8')
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', {
        INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH: packFile,
      })).toThrow('INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH must point at a JSON object keyed by packId')
    })

    // Both keys are independent: configuring one must not require or disturb the other.
    it('carries both keys side by side', () => {
      const packFile = join(tmpDir, 'packs.json')
      writeFileSync(packFile, JSON.stringify({ 'factory-a': { packId: 'factory-a' } }), 'utf8')
      const mappingFile = writeMappingFile(JSON.stringify(MAPPING))
      const config = resolvePluginRuntimeConfig('plugin-integration-core', {
        INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH: packFile,
        [ENV_KEY]: mappingFile,
      })
      expect(config.stockPreparationCustomerPacks).toEqual({ 'factory-a': { packId: 'factory-a' } })
      expect(config.stockPreparationExtFieldMapping).toEqual(MAPPING)
    })
  })

  // B2a TRIAL REGISTRATION — the third artifact on this reader, and the only one that ARMS a gate
  // rather than feeding one.
  //
  // The pack and the mapping are INPUTS to a capability: without them nothing produces an `ext_`
  // value. This key is the reverse. Unset -> omitted -> the plugin's registry is null -> the B2a gate
  // is DORMANT and every stock-prep source read behaves exactly as it did before. SET -> ARMED, and
  // every gated stock-prep read must match a live, in-scope, unexpired registration.
  //
  // Which is why the "unreadable/malformed -> THROW" tests below carry more weight here than for
  // either sibling: a typo in this path must never be indistinguishable from "no registry
  // configured", because that difference is the difference between a gate and no gate.
  //
  // Before this key existed, `B2a` had ZERO occurrences in main's tracked code — the registration /
  // scope / expiry / no-reuse mechanism the v9.1 review asked for lived only in prose.
  describe('b2a trial registry', () => {
    const ENV_KEY = 'INTEGRATION_CORE_B2A_REGISTRY_PATH'
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'b2a-registry-'))
    })
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    function writeRegistryFile(contents: string): string {
      const file = join(tmpDir, 'b2a-registry.json')
      writeFileSync(file, contents, 'utf8')
      return file
    }

    const REGISTRY = {
      registryId: 'b2a-2026-q3',
      registryVersion: 1,
      entries: [{
        entryId: 'b2a-factory-a-plm',
        tenantId: 'tenant_1',
        sourceBinding: { externalSystemId: 'plm_sql_source' },
        projectScope: { projectNos: ['P-001'] },
        purpose: 'stock-preparation.table-action',
        owner: 'owner-a',
        effectiveAt: '2026-08-01T00:00:00Z',
        expiresAt: '2026-09-01T00:00:00Z',
        forbidReuse: true,
        b2bCondition: 'migrate onto the generalized binding before expiry',
        expiryHandling: 'refuse',
      }],
    }

    it('omits the key entirely when unset — the B2a gate stays dormant and nothing is gated', () => {
      const config = resolvePluginRuntimeConfig('plugin-integration-core', {})
      expect('b2aTrialRegistry' in config).toBe(false)
    })

    it('reads the registry off the named file', () => {
      const file = writeRegistryFile(JSON.stringify(REGISTRY))
      const config = resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file })
      expect(config.b2aTrialRegistry).toEqual(REGISTRY)
    })

    // A typo in the path must NOT look exactly like "no registry configured".
    it('fails closed — and LOUDLY — when the path is unreadable, rather than degrading to no gate', () => {
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', {
        [ENV_KEY]: join(tmpDir, 'does-not-exist.json'),
      })).toThrow(`${ENV_KEY} points at a file that could not be read`)
    })

    it('never echoes the configured path in the error (values-free: paths are deployment topology)', () => {
      const secretish = join(tmpDir, 'absent-host-specific-name.json')
      try {
        resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: secretish })
        throw new Error('expected a throw')
      } catch (error) {
        expect((error as Error).message).not.toContain(secretish)
        expect((error as Error).message).toContain(ENV_KEY)
      }
    })

    it('fails closed on malformed JSON', () => {
      const file = writeRegistryFile('{not-json')
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file }))
        .toThrow(`${ENV_KEY} must point at a file containing valid JSON`)
    })

    // The shape message is this key's OWN: sharing a reader must not blur the diagnosis a deployer
    // gets, and an ARRAY of entries with no envelope is the plausible mistake here.
    it('fails closed when the file is not a JSON object, naming the shape this key wants', () => {
      const file = writeRegistryFile(JSON.stringify(REGISTRY.entries))
      expect(() => resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file }))
        .toThrow(`${ENV_KEY} must point at a JSON object with registryId, registryVersion and entries`)
    })

    it('is inert for any other plugin', () => {
      const file = writeRegistryFile(JSON.stringify(REGISTRY))
      expect(resolvePluginRuntimeConfig('plugin-after-sales', { [ENV_KEY]: file })).toEqual({})
    })

    // The host is a READER, not a validator: entry-level rules (strict ISO, the window cap, required
    // owner/b2bCondition/expiryHandling, the closed key set) live in the plugin and fail at plugin
    // activation. Keeping the host dumb here is deliberate — one authority over what a registration
    // may say, not two that could drift.
    it('does not second-guess the entry contents; the plugin owns that validation', () => {
      const file = writeRegistryFile(JSON.stringify({ registryId: 'r', registryVersion: 1, entries: [{ nonsense: true }] }))
      const config = resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: file })
      expect(config.b2aTrialRegistry).toEqual({ registryId: 'r', registryVersion: 1, entries: [{ nonsense: true }] })
    })

    // All three keys are independent: arming the gate must not require or disturb the other two.
    it('carries all three deploy-file keys side by side', () => {
      const packFile = join(tmpDir, 'packs.json')
      writeFileSync(packFile, JSON.stringify({ 'factory-a': { packId: 'factory-a' } }), 'utf8')
      const mappingFile = join(tmpDir, 'ext-field-mapping.json')
      writeFileSync(mappingFile, JSON.stringify({ packId: 'factory-a' }), 'utf8')
      const registryFile = writeRegistryFile(JSON.stringify(REGISTRY))
      const config = resolvePluginRuntimeConfig('plugin-integration-core', {
        INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH: packFile,
        INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH: mappingFile,
        [ENV_KEY]: registryFile,
      })
      expect(config.stockPreparationCustomerPacks).toEqual({ 'factory-a': { packId: 'factory-a' } })
      expect(config.stockPreparationExtFieldMapping).toEqual({ packId: 'factory-a' })
      expect(config.b2aTrialRegistry).toEqual(REGISTRY)
    })

    // Arming the B2a gate must not change what any OTHER key resolves to.
    it('leaves the rest of the resolved config untouched', () => {
      const registryFile = writeRegistryFile(JSON.stringify(REGISTRY))
      const withoutRegistry = resolvePluginRuntimeConfig('plugin-integration-core', {})
      const withRegistry = resolvePluginRuntimeConfig('plugin-integration-core', { [ENV_KEY]: registryFile })
      const { b2aTrialRegistry: _armed, ...rest } = withRegistry
      expect(rest).toEqual(withoutRegistry)
    })
  })

})
