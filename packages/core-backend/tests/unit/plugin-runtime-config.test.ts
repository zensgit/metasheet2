import { describe, expect, it } from 'vitest'
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
})
