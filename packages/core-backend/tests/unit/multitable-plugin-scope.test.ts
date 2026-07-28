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
        resolveExistingObjectFieldIds: vi.fn(async () => ({ status: 'fld_1' })),
        ensureMissingObjectFields: vi.fn(async () => ({ addedFieldIds: ['fld_2'], skippedExistingFieldIds: ['fld_1'] })),
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

    // W2: the two new provisioning methods MUST forward through the scoped wrapper
    // AND pass the object-scope check (a write capability is never bare-forwarded).
    assertObjectScope.mockClear()
    await expect(
      scoped.provisioning.resolveExistingObjectFieldIds({
        projectId: 'tenant_42:after-sales',
        objectId: 'serviceTicket',
        fieldIds: ['status'],
      }),
    ).resolves.toEqual({ status: 'fld_1' })
    expect(assertObjectScope).toHaveBeenCalledWith({
      pluginName: 'plugin-after-sales',
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
    })
    assertObjectScope.mockClear()
    await expect(
      scoped.provisioning.ensureMissingObjectFields({
        projectId: 'tenant_42:after-sales',
        objectId: 'serviceTicket',
        fields: [{ id: 'newField', name: 'New', type: 'date' }],
      } as any),
    ).resolves.toMatchObject({ addedFieldIds: ['fld_2'] })
    // Load-bearing: removing this assertObjectScope forwarding must fail the suite.
    expect(assertObjectScope).toHaveBeenCalledWith({
      pluginName: 'plugin-after-sales',
      projectId: 'tenant_42:after-sales',
      objectId: 'serviceTicket',
    })
    // A cross-namespace project id is rejected before any forward.
    await expect(
      scoped.provisioning.ensureMissingObjectFields({
        projectId: 'tenant_42:attendance',
        objectId: 'serviceTicket',
        fields: [],
      } as any),
    ).rejects.toThrow(MultitableProjectNamespaceError)

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

  it('normalizes UOW sheet ids before allowlist and host handoff; whitespace variants stay out of scope', async () => {
    const transactionRecords = {
      queryRecords: vi.fn(async (input: { sheetId: string }) => [{ sheetId: input.sheetId }]),
      createRecord: vi.fn(async (input: { sheetId: string }) => ({ id: 'rec_1', version: 1, sheetId: input.sheetId })),
      patchRecord: vi.fn(async (input: { sheetId: string; recordId: string }) => ({
        id: input.recordId,
        version: 2,
        sheetId: input.sheetId,
      })),
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

    const paddedProjectSheetId = ' sheet_project '
    const rawInput = {
      tenantId: ' tenant_1 ',
      sheetIds: [paddedProjectSheetId, ' sheet_batch ', 'sheet_line', 'sheet_run'],
      project: { sheetId: paddedProjectSheetId, projectId: ' project_1 ' },
      batch: { sheetId: ' sheet_batch ', snapshotBatchId: ' batch_1 ' },
    }
    const normalized = {
      tenantId: 'tenant_1',
      sheetIds: ['sheet_project', 'sheet_batch', 'sheet_line', 'sheet_run'],
      project: { sheetId: 'sheet_project', projectId: 'project_1' },
      batch: { sheetId: 'sheet_batch', snapshotBatchId: 'batch_1' },
    }

    const result = await scoped.records.runStockPreparationPersistUnitOfWork?.(
      rawInput,
      async (records) => {
        // Declared (trimmed) id is in scope and reaches the host records API.
        const rows = await records.queryRecords({ sheetId: 'sheet_project' })
        // Negative leg / mutation proof: the raw padded string was on the pre-normalization
        // sheetIds array. If the allowlist were still built from raw input.sheetIds, this call
        // would succeed and the assertion below would fail. Fail closed requires the throw.
        await expect(
          records.queryRecords({ sheetId: paddedProjectSheetId }),
        ).rejects.toThrow(MultitableUnitOfWorkScopeError)
        await expect(
          records.createRecord({ sheetId: paddedProjectSheetId, data: { k: 1 } }),
        ).rejects.toThrow(MultitableUnitOfWorkScopeError)
        await expect(
          records.patchRecord({ sheetId: paddedProjectSheetId, recordId: 'rec_x', changes: { k: 2 } }),
        ).rejects.toThrow(MultitableUnitOfWorkScopeError)
        return rows
      },
    )

    expect(result).toEqual([{ sheetId: 'sheet_project' }])
    expect(hook.mock.calls[0]?.[0]).toEqual({ ...normalized, pluginName: 'plugin-integration-core' })
    expect(transactionRecords.queryRecords).toHaveBeenCalledWith({ sheetId: 'sheet_project' })
    expect(transactionRecords.queryRecords).not.toHaveBeenCalledWith({ sheetId: paddedProjectSheetId })
    expect(transactionRecords.createRecord).not.toHaveBeenCalled()
    expect(transactionRecords.patchRecord).not.toHaveBeenCalled()
  })

  it('W2: object-scope check PRECEDES the delegate for the new provisioning methods', async () => {
    // A rejecting hook must abort BEFORE the underlying read/write delegate runs —
    // a write-then-check ordering (the mutation the review flagged) must fail this test.
    const denied = new Error('scope denied')
    const assertObjectScope = vi.fn(async () => {
      throw denied
    })
    const delegate = {
      resolveExistingObjectFieldIds: vi.fn(async () => ({ status: 'fld_1' })),
      readObjectFieldsContent: vi.fn(async () => ({ status: { name: 'Status', type: 'select', property: {} } })),
      ensureMissingObjectFields: vi.fn(async () => ({ addedFieldIds: ['fld_2'], skippedExistingFieldIds: [] })),
    }
    const multitable = { provisioning: { ...delegate }, records: {} }
    const scoped = createPluginScopedMultitableApi(multitable as any, 'plugin-after-sales', { assertObjectScope })

    for (const method of ['resolveExistingObjectFieldIds', 'readObjectFieldsContent', 'ensureMissingObjectFields'] as const) {
      assertObjectScope.mockClear()
      await expect(
        (scoped.provisioning as any)[method]({
          projectId: 'tenant_42:after-sales',
          objectId: 'serviceTicket',
          fieldIds: ['status'],
          fields: [],
        }),
      ).rejects.toBe(denied)
      // The hook ran; the underlying delegate did NOT (check strictly precedes delegate).
      expect(assertObjectScope).toHaveBeenCalledTimes(1)
      expect(delegate[method]).not.toHaveBeenCalled()
    }
  })

  it('W2/P2-3: runObjectFieldsRepairTransaction object-scopes every READ/WRITE surface call INSIDE the tx (findObjectSheet is discovery-only)', async () => {
    // The atomic repair runner hands the plugin a tx-bound surface. Every read/write the
    // repair makes THROUGH that surface must STILL pass assertObjectScope — scope cannot be
    // dropped just because we are inside a host transaction (never bare-forward a write).
    // findObjectSheet is discovery-only: project-namespace check, no object-scope (case c).
    const assertObjectScope = vi.fn(async () => {})
    const innerSurface = {
      findObjectSheet: vi.fn(async () => ({ id: 's', baseId: null, name: 'n', description: null })),
      resolveExistingObjectFieldIds: vi.fn(async () => ({ status: 'fld_1' })),
      readObjectFieldsContent: vi.fn(async () => ({ status: { name: 'Status', type: 'select', property: {}, order: 0 } })),
      ensureMissingObjectFields: vi.fn(async () => ({ addedFieldIds: ['fld_2'], skippedExistingFieldIds: [] })),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const delegateRunner = vi.fn(async (fn: any) => fn(innerSurface))
    const multitable = { provisioning: { runObjectFieldsRepairTransaction: delegateRunner }, records: {} }
    const scoped = createPluginScopedMultitableApi(multitable as any, 'plugin-after-sales', { assertObjectScope })
    const SCOPE = { projectId: 'tenant_42:after-sales', objectId: 'serviceTicket' }

    // (a) happy path: the surface's write + reads all pass assertObjectScope.
    const out = await scoped.provisioning.runObjectFieldsRepairTransaction(async (tx: any) => {
      await tx.resolveExistingObjectFieldIds({ ...SCOPE, fieldIds: ['status'] })
      await tx.readObjectFieldsContent({ ...SCOPE, fieldIds: ['status'] })
      return tx.ensureMissingObjectFields({ ...SCOPE, fields: [] })
    })
    expect(out).toEqual({ addedFieldIds: ['fld_2'], skippedExistingFieldIds: [] })
    expect(delegateRunner).toHaveBeenCalledTimes(1)
    // write + two reads = 3 scoped surface calls, each via assertObjectScope.
    expect(assertObjectScope.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(assertObjectScope).toHaveBeenCalledWith({ pluginName: 'plugin-after-sales', ...SCOPE })

    // (b) a rejecting hook aborts the surface write BEFORE the inner delegate write runs.
    const denied = new Error('scope denied')
    assertObjectScope.mockImplementation(async () => {
      throw denied
    })
    innerSurface.ensureMissingObjectFields.mockClear()
    await expect(
      scoped.provisioning.runObjectFieldsRepairTransaction(async (tx: any) => tx.ensureMissingObjectFields({ ...SCOPE, fields: [] })),
    ).rejects.toBe(denied)
    expect(innerSurface.ensureMissingObjectFields).not.toHaveBeenCalled()

    // (c) a foreign-namespace project id is rejected by the surface before it delegates.
    assertObjectScope.mockImplementation(async () => {})
    await expect(
      scoped.provisioning.runObjectFieldsRepairTransaction(async (tx: any) => tx.findObjectSheet({ projectId: 'tenant_42:other-plugin', objectId: 'x' })),
    ).rejects.toThrow()
  })
})
