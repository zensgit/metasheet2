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

})
