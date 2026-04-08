import { describe, expect, it, vi } from 'vitest'

import {
  MultitableObjectScopeError,
  MultitableProjectNamespaceError,
  MultitableSheetScopeError,
  assertProjectIdAllowedForPlugin,
  assertPluginOwnsSheet,
  claimPluginObjectScope,
  createPluginScopedMultitableApi,
  getPluginProjectNamespaces,
} from '../../src/multitable/plugin-scope'

function createScopeQuery() {
  const rows: Array<{
    sheet_id: string
    project_id: string
    object_id: string
    plugin_name: string
  }> = []

  return {
    rows,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('INSERT INTO plugin_multitable_object_registry')) {
        const [sheetId, projectId, objectId, pluginName] = params as [string, string, string, string]
        const existing = rows.find((row) => row.project_id === projectId && row.object_id === objectId)
        if (!existing) {
          rows.push({
            sheet_id: sheetId,
            project_id: projectId,
            object_id: objectId,
            plugin_name: pluginName,
          })
        }
        return { rows: [], rowCount: 1 }
      }
      if (normalized.includes('FROM plugin_multitable_object_registry') && normalized.includes('WHERE project_id = $1')) {
        const [projectId, objectId] = params as [string, string]
        return {
          rows: rows.filter((row) => row.project_id === projectId && row.object_id === objectId),
        }
      }
      if (normalized.includes('FROM plugin_multitable_object_registry') && normalized.includes('WHERE sheet_id = $1')) {
        const [sheetId] = params as [string]
        return {
          rows: rows.filter((row) => row.sheet_id === sheetId),
        }
      }
      throw new Error(`Unhandled SQL in test: ${normalized}`)
    }),
  }
}

describe('multitable plugin scope helper', () => {
  it('derives plugin namespaces from both raw and plugin-stripped names', () => {
    expect(getPluginProjectNamespaces('plugin-after-sales')).toEqual([
      'plugin-after-sales',
      'after-sales',
    ])
    expect(getPluginProjectNamespaces('attendance')).toEqual(['attendance'])
  })

  it('allows project ids within the plugin namespace convention', () => {
    expect(() =>
      assertProjectIdAllowedForPlugin('plugin-after-sales', 'tenant_42:after-sales'),
    ).not.toThrow()
    expect(() =>
      assertProjectIdAllowedForPlugin('plugin-after-sales', 'tenant_42:plugin-after-sales'),
    ).not.toThrow()
  })

  it('rejects project ids owned by another plugin namespace', () => {
    expect(() =>
      assertProjectIdAllowedForPlugin('plugin-attendance', 'tenant_42:after-sales'),
    ).toThrow(MultitableProjectNamespaceError)
  })

  it('wraps provisioning methods with namespace checks', async () => {
    const claimObjectScope = vi.fn(async () => {})
    const assertSheetScope = vi.fn(async () => {})
    const multitable = {
      provisioning: {
        getObjectSheetId: vi.fn(() => 'sheet_1'),
        getFieldId: vi.fn(() => 'fld_1'),
        ensureObject: vi.fn(async () => ({
          baseId: 'base_legacy',
          sheet: { id: 'sheet_1', baseId: 'base_legacy', name: 'Ticket', description: null },
          fields: [],
        })),
        ensureView: vi.fn(async () => ({
          id: 'view_1',
          sheetId: 'sheet_1',
          name: 'Grid',
          type: 'grid',
          filterInfo: {},
          sortInfo: {},
          groupInfo: {},
          hiddenFieldIds: [],
          config: {},
        })),
      },
      records: {
        listRecords: vi.fn(),
        queryRecords: vi.fn(),
        createRecord: vi.fn(),
        getRecord: vi.fn(),
        patchRecord: vi.fn(),
        deleteRecord: vi.fn(),
      },
    }

    const scoped = createPluginScopedMultitableApi(multitable as any, 'plugin-after-sales', {
      claimObjectScope,
      assertSheetScope,
    })

    expect(scoped.provisioning.getObjectSheetId('tenant_42:after-sales', 'serviceTicket')).toBe('sheet_1')
    expect(scoped.provisioning.getFieldId('tenant_42:after-sales', 'serviceTicket', 'status')).toBe('fld_1')
    await expect(
      scoped.provisioning.ensureObject({
        projectId: 'tenant_42:after-sales',
        descriptor: { id: 'serviceTicket', name: 'Ticket', fields: [] },
      } as any),
    ).resolves.toMatchObject({
      sheet: { id: 'sheet_1' },
    })

    expect(() =>
      scoped.provisioning.getObjectSheetId('tenant_42:attendance', 'serviceTicket'),
    ).toThrow(MultitableProjectNamespaceError)
    expect(() =>
      scoped.provisioning.getFieldId('tenant_42:attendance', 'serviceTicket', 'status'),
    ).toThrow(MultitableProjectNamespaceError)
    await expect(
      scoped.provisioning.ensureView({
        projectId: 'tenant_42:attendance',
        sheetId: 'sheet_1',
        descriptor: { id: 'view_1', name: 'Grid', type: 'grid' },
      } as any),
    ).rejects.toThrow(MultitableProjectNamespaceError)
    await scoped.records.listRecords({ sheetId: 'sheet_1' })
    expect(claimObjectScope).toHaveBeenCalledWith({
      pluginName: 'plugin-after-sales',
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
      sheetId: 'sheet_1',
    })
    expect(assertSheetScope).toHaveBeenCalledWith({
      pluginName: 'plugin-after-sales',
      sheetId: 'sheet_1',
    })
  })

  it('claims object ownership and rejects conflicting plugins', async () => {
    const { query, rows } = createScopeQuery()

    await claimPluginObjectScope(query, {
      pluginName: 'plugin-after-sales',
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
      sheetId: 'sheet_1',
    })

    expect(rows).toEqual([
      {
        sheet_id: 'sheet_1',
        project_id: 'tenant_42:after-sales',
        object_id: 'serviceTicket',
        plugin_name: 'plugin-after-sales',
      },
    ])

    rows[0]!.plugin_name = 'plugin-attendance'

    await expect(
      claimPluginObjectScope(query, {
        pluginName: 'plugin-after-sales',
        projectId: 'tenant_42:after-sales',
        objectId: 'serviceTicket',
        sheetId: 'sheet_1',
      }),
    ).rejects.toThrow(MultitableObjectScopeError)
  })

  it('allows legacy sheets without registry rows but blocks registered foreign owners', async () => {
    const { query, rows } = createScopeQuery()

    await expect(
      assertPluginOwnsSheet(query, {
        pluginName: 'plugin-after-sales',
        sheetId: 'sheet_legacy',
      }),
    ).resolves.toBe(false)

    rows.push({
      sheet_id: 'sheet_other',
      project_id: 'tenant_42:attendance',
      object_id: 'attendanceRecord',
      plugin_name: 'plugin-attendance',
    })

    await expect(
      assertPluginOwnsSheet(query, {
        pluginName: 'plugin-after-sales',
        sheetId: 'sheet_other',
      }),
    ).rejects.toThrow(MultitableSheetScopeError)
  })
})
