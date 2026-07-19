import { describe, expect, it, vi } from 'vitest'

import {
  MultitableObjectScopeError,
  MultitableProjectNamespaceError,
  MultitableSheetScopeError,
  MultitableUnitOfWorkScopeError,
  MultitableUnitOfWorkUnavailableError,
  assertProjectIdAllowedForPlugin,
  assertPluginOwnsObject,
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
    const ensureObjectInScope = vi.fn(async () => ({
      baseId: 'base_legacy',
      sheet: { id: 'sheet_scoped', baseId: 'base_legacy', name: 'Ticket', description: null },
      fields: [],
    }))
    const assertObjectScope = vi.fn(async () => {})
    const assertSheetScope = vi.fn(async () => {})
    const multitable = {
      provisioning: {
        getObjectSheetId: vi.fn(() => 'sheet_1'),
        getFieldId: vi.fn(() => 'fld_1'),
        findObjectSheet: vi.fn(async () => ({
          id: 'sheet_1',
          baseId: 'base_legacy',
          name: 'Ticket',
          description: null,
        })),
        resolveFieldIds: vi.fn(async () => ({
          status: 'fld_1',
        })),
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
        patchObjectFieldProperty: vi.fn(async () => ({
          id: 'fld_1',
          sheetId: 'sheet_1',
          name: 'Status',
          type: 'select',
          property: { options: [{ value: 'open' }] },
          order: 1,
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
      ensureObjectInScope,
      assertObjectScope,
      assertSheetScope,
    })

    expect(scoped.provisioning.getObjectSheetId('tenant_42:after-sales', 'serviceTicket')).toBe('sheet_1')
    expect(scoped.provisioning.getFieldId('tenant_42:after-sales', 'serviceTicket', 'status')).toBe('fld_1')
    await expect(
      scoped.provisioning.findObjectSheet({
        projectId: 'tenant_42:after-sales',
        objectId: 'serviceTicket',
      }),
    ).resolves.toMatchObject({ id: 'sheet_1' })
    await expect(
      scoped.provisioning.resolveFieldIds({
        projectId: 'tenant_42:after-sales',
        objectId: 'serviceTicket',
        fieldIds: ['status'],
      }),
    ).resolves.toEqual({ status: 'fld_1' })
    await expect(
      scoped.provisioning.ensureObject({
        projectId: 'tenant_42:after-sales',
        descriptor: { id: 'serviceTicket', name: 'Ticket', fields: [] },
      } as any),
    ).resolves.toMatchObject({
      sheet: { id: 'sheet_scoped' },
    })
    await expect(
      scoped.provisioning.patchObjectFieldProperty({
        projectId: 'tenant_42:after-sales',
        objectId: 'serviceTicket',
        fieldId: 'status',
        propertyPatch: { options: [{ value: 'open' }] },
      }),
    ).resolves.toMatchObject({ id: 'fld_1' })

    expect(() =>
      scoped.provisioning.getObjectSheetId('tenant_42:attendance', 'serviceTicket'),
    ).toThrow(MultitableProjectNamespaceError)
    expect(() =>
      scoped.provisioning.getFieldId('tenant_42:attendance', 'serviceTicket', 'status'),
    ).toThrow(MultitableProjectNamespaceError)
    await expect(
      scoped.provisioning.findObjectSheet({
        projectId: 'tenant_42:attendance',
        objectId: 'serviceTicket',
      }),
    ).rejects.toThrow(MultitableProjectNamespaceError)
    await expect(
      scoped.provisioning.resolveFieldIds({
        projectId: 'tenant_42:attendance',
        objectId: 'serviceTicket',
        fieldIds: ['status'],
      }),
    ).rejects.toThrow(MultitableProjectNamespaceError)
    await expect(
      scoped.provisioning.ensureView({
        projectId: 'tenant_42:attendance',
        sheetId: 'sheet_1',
        descriptor: { id: 'view_1', name: 'Grid', type: 'grid' },
      } as any),
    ).rejects.toThrow(MultitableProjectNamespaceError)
    await scoped.records.listRecords({ sheetId: 'sheet_1' })
    expect(ensureObjectInScope).toHaveBeenCalledWith({
      pluginName: 'plugin-after-sales',
      projectId: 'tenant_42:after-sales',
      descriptor: { id: 'serviceTicket', name: 'Ticket', fields: [] },
    })
    expect(multitable.provisioning.ensureObject).not.toHaveBeenCalled()
    expect(assertObjectScope).toHaveBeenCalledWith({
      pluginName: 'plugin-after-sales',
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
    })
    expect(multitable.provisioning.patchObjectFieldProperty).toHaveBeenCalledWith({
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
      fieldId: 'status',
      propertyPatch: { options: [{ value: 'open' }] },
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

  it('blocks provisioning when a registered object belongs to another plugin', async () => {
    const { query, rows } = createScopeQuery()

    rows.push({
      sheet_id: 'sheet_other',
      project_id: 'tenant_42:after-sales',
      object_id: 'serviceTicket',
      plugin_name: 'plugin-attendance',
    })

    await expect(
      assertPluginOwnsObject(query, {
        pluginName: 'plugin-after-sales',
        projectId: 'tenant_42:after-sales',
        objectId: 'serviceTicket',
      }),
    ).rejects.toThrow(MultitableObjectScopeError)
  })

  it('binds the stock-preparation unit-of-work to the plugin and declared four-sheet scope', async () => {
    const transactionRecords = {
      queryRecords: vi.fn(async () => []),
      createRecord: vi.fn(async (input) => ({ id: 'rec_1', version: 1, data: input.data, ...input })),
      patchRecord: vi.fn(async (input) => ({ id: input.recordId, version: 2, data: input.changes, ...input })),
    }
    const hook = vi.fn(async (_input, operation) => operation(transactionRecords as any))
    const multitable = {
      provisioning: {},
      records: {
        listRecords: vi.fn(), queryRecords: vi.fn(), createRecord: vi.fn(),
        getRecord: vi.fn(), patchRecord: vi.fn(), deleteRecord: vi.fn(),
      },
    }
    const scoped = createPluginScopedMultitableApi(multitable as any, 'plugin-integration-core', {
      runStockPreparationPersistUnitOfWork: hook,
    })
    const uowInput = {
      tenantId: 'tenant_1',
      sheetIds: ['sheet_project', 'sheet_batch', 'sheet_line', 'sheet_run'],
      project: { sheetId: 'sheet_project', projectId: 'business_project' },
      batch: { sheetId: 'sheet_batch', snapshotBatchId: 'batch_1' },
    }

    const result = await scoped.records.runStockPreparationPersistUnitOfWork?.(
      uowInput,
      async (records) => records.queryRecords({ sheetId: 'sheet_batch' }),
    )
    expect(result).toEqual([])
    expect(hook.mock.calls[0]?.[0]).toEqual({ ...uowInput, pluginName: 'plugin-integration-core' })
    expect(transactionRecords.queryRecords).toHaveBeenCalledWith({ sheetId: 'sheet_batch' })

    await expect(scoped.records.runStockPreparationPersistUnitOfWork?.(
      uowInput,
      async (records) => records.queryRecords({ sheetId: 'sheet_foreign' }),
    )).rejects.toThrow(MultitableUnitOfWorkScopeError)

    const runUnitOfWork = scoped.records.runStockPreparationPersistUnitOfWork as unknown as (
      input: unknown,
      operation: unknown,
    ) => Promise<unknown>
    const hookCallsBeforeInvalidInput = hook.mock.calls.length
    await expect(runUnitOfWork(uowInput, null)).rejects.toThrow('operation must be a function')
    await expect(runUnitOfWork(null, async () => null)).rejects.toThrow('input must be an object')
    expect(hook).toHaveBeenCalledTimes(hookCallsBeforeInvalidInput)
  })

  it('fails closed when the host does not provide the required unit-of-work hook', async () => {
    const multitable = {
      provisioning: {},
      records: {
        listRecords: vi.fn(), queryRecords: vi.fn(), createRecord: vi.fn(),
        getRecord: vi.fn(), patchRecord: vi.fn(), deleteRecord: vi.fn(),
      },
    }
    const scoped = createPluginScopedMultitableApi(multitable as any, 'plugin-integration-core')
    await expect(scoped.records.runStockPreparationPersistUnitOfWork?.(
      {
        tenantId: 'tenant_1',
        sheetIds: ['sheet_project', 'sheet_batch', 'sheet_line', 'sheet_run'],
        project: { sheetId: 'sheet_project', projectId: 'project_1' },
        batch: { sheetId: 'sheet_batch', snapshotBatchId: 'batch_1' },
      },
      async () => null,
    )).rejects.toThrow(MultitableUnitOfWorkUnavailableError)
  })
})
