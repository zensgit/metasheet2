/**
 * 一个项目一张备料表 — S3 fix round 2 (F3; register R-37): integration PIPELINES cannot write the
 * stock-preparation project overview; only the overview's own port can.
 *
 * The finding: the multitable target adapter (plugins/plugin-integration-core/lib/adapters/
 * metasheet-multitable-target-adapter.cjs) takes `sheetId` from external-system config, and the plugin-scope
 * generic record writes checked only plugin OWNERSHIP — the overview IS owned by plugin-integration-core, so a
 * pipeline naming its id wrote `{written: 1}`. Pinned here with the REAL `createPluginScopedMultitableApi` and the
 * REAL adapter / write source / overview module (required from the plugin), over a fake raw host whose
 * ownership hook says "owned":
 *   A-01 the REAL adapter's upsert at the overview id → refused by its own typed check (the host probe), ZERO
 *        host createRecord calls; A-02 with the probe gone (an adapter on an older host shape) the HOST refuses
 *        every row — still zero host writes; A-03 the C6 write source's insertRows / updateRows likewise;
 *        A-04 control: the same adapter at an ordinary sheet of the same id shape writes once.
 *   G-01 every GENERIC write (create / patch / delete / persist unit of work) refuses the overview, for
 *        plugin-integration-core and any other plugin; G-02 a host that cannot answer refuses derived-shape ids
 *        (`unverifiable`) and passes other ids with no hook call; G-03 ordinary ids pass untouched.
 *   P-01 the PORT (plugin-integration-core only) writes the overview the host DERIVES for the named project,
 *        re-checking ownership and the stamp each time; P-02 it refuses an unstamped derived sheet, a missing
 *        hook, an ownership refusal and a foreign namespace — no host write.
 *   M-01 the overview MODULE's refresh and per-event update, through the real wrapper, still write (create,
 *        then patch) — only via the port.
 */
import { createRequire } from 'node:module'

import { describe, expect, it, vi } from 'vitest'

import { createPluginScopedMultitableApi, MultitableProjectNamespaceError } from '../../src/multitable/plugin-scope'
import { getObjectSheetId } from '../../src/multitable/provisioning'
import {
  STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
  StockPreparationOverviewRecordsWriteError,
} from '../../src/multitable/stock-preparation-overview-contract'

const require = createRequire(import.meta.url)
const PLUGIN_LIB = '../../../../plugins/plugin-integration-core/lib'
const adapterLib = require(`${PLUGIN_LIB}/adapters/metasheet-multitable-target-adapter.cjs`) as {
  createMetaSheetMultitableTargetAdapter: (input: { system: unknown; context: unknown }) => {
    upsert: (input: unknown) => Promise<{ written: number; failed: number; errors: Array<{ code: string }> }>
  }
  createMetaSheetMultitableWriteSource: (input: { system: unknown; context: unknown }) => {
    insertRows: (...args: unknown[]) => Promise<unknown>
    updateRows: (...args: unknown[]) => Promise<unknown>
  }
  METASHEET_MULTITABLE_SYSTEM_SHEET_READ_ONLY: string
}
const overviewLib = require(`${PLUGIN_LIB}/stock-preparation-project-overview.cjs`) as {
  refreshProjectOverview: (input: Record<string, unknown>) => Promise<Record<string, number | string | boolean | null>>
  updateProjectOverviewRow: (input: Record<string, unknown>) => Promise<{ outcome: string }>
  STOCK_PREPARATION_PROJECT_OVERVIEW_FIELD_IDS: readonly string[]
}
const storeLib = require(`${PLUGIN_LIB}/stock-preparation-project-target-store.cjs`) as {
  createStockPreparationProjectTargetStore: (input: Record<string, unknown>) => Record<string, unknown>
}
const harness = require('../../../../plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs') as {
  makeMemoryDb: () => { rowsOf: (table: string) => Array<Record<string, unknown>> }
}

const PLUGIN = 'plugin-integration-core'
const PROJECT_ID = 'tenant_f3:integration-core'
const OVERVIEW = getObjectSheetId(PROJECT_ID, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)
const ORDINARY = getObjectSheetId(PROJECT_ID, 'plm_f3_ordinary_target')
const PROJECT_SHEET_OBJECT = 'plm_stock_preparation_sandbox_p_f3f3f3f3f3f3f3f3f3f3f3f3'
const PROJECT_SHEET = getObjectSheetId(PROJECT_ID, PROJECT_SHEET_OBJECT)

type Row = { id: string; sheetId: string; version: number; data: Record<string, unknown> }

/** The raw host the wrapper wraps: records in memory, every call counted. */
function makeRawHost() {
  const rows: Row[] = []
  let seq = 0
  const records = {
    listRecords: vi.fn(async (input: { sheetId: string }) => rows.filter((r) => r.sheetId === input.sheetId)),
    queryRecords: vi.fn(async (input: { sheetId: string; filters?: Record<string, unknown> }) =>
      rows.filter((r) => r.sheetId === input.sheetId && Object.entries(input.filters ?? {}).every(([k, v]) => r.data[k] === v))
        .map((r) => ({ ...r, data: { ...r.data } }))),
    createRecord: vi.fn(async (input: { sheetId: string; data: Record<string, unknown> }) => {
      seq += 1
      const row = { id: `rec_${seq}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }
      rows.push(row)
      return { ...row, data: { ...row.data } }
    }),
    getRecord: vi.fn(async () => { throw new Error('unused') }),
    patchRecord: vi.fn(async (input: { sheetId: string; recordId: string; changes: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === input.recordId && r.sheetId === input.sheetId)
      if (!row) throw new Error('no such row')
      Object.assign(row.data, input.changes)
      row.version += 1
      return { ...row, data: { ...row.data } }
    }),
    deleteRecord: vi.fn(async (input: { sheetId: string; recordId: string }) => {
      const index = rows.findIndex((r) => r.id === input.recordId && r.sheetId === input.sheetId)
      if (index >= 0) rows.splice(index, 1)
      return { id: input.recordId, sheetId: input.sheetId, version: 1 }
    }),
  }
  const provisioning = {
    supportsSystemKindStamp: true,
    getObjectSheetId,
    getFieldId: (_p: string, _o: string, fieldId: string) => `fld_${fieldId}`,
    getObjectViewId: (_p: string, objectId: string, viewId: string) => `view_${objectId.slice(-6)}_${viewId}`,
    findObjectSheet: vi.fn(async ({ projectId, objectId }: { projectId: string; objectId: string }) =>
      objectId === STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID
        ? { id: getObjectSheetId(projectId, objectId), baseId: null, name: 'Overview', description: null, systemKind: 'stock_prep_overview' }
        : null),
    resolveFieldIds: vi.fn(async ({ fieldIds }: { fieldIds: string[] }) => Object.fromEntries(fieldIds.map((id) => [id, `fld_${id}`]))),
    ensureObject: vi.fn(async () => { throw new Error('unused') }),
    isSheetOwnedByProject: vi.fn(async () => true),
  }
  return { rows, records, provisioning }
}

/** The plugin-scoped API as index.ts builds it; the ownership hooks say "owned"; the stamp hook knows OVERVIEW. */
function scopedFor(pluginName: string, raw = makeRawHost(), hookOverrides: Record<string, unknown> = {}) {
  const hooks = {
    assertSheetScope: vi.fn(async () => ({ registered: true })),
    assertSheetOwnedByPlugin: vi.fn(async () => {}),
    isStockPreparationOverviewSheet: vi.fn(async ({ sheetId }: { sheetId: string }) => sheetId === OVERVIEW),
    ...hookOverrides,
  }
  const scoped = createPluginScopedMultitableApi(raw as never, pluginName, hooks as never)
  return { scoped, raw, hooks }
}

const targetSystem = (sheetId: string) => ({
  id: 'sys_f3_target',
  name: 'F3 multitable target',
  kind: 'metasheet:multitable',
  role: 'target',
  status: 'active',
  config: { objects: { ov: { sheetId, fields: ['projectNo', 'status'], keyFields: ['projectNo'], mode: 'upsert' } } },
})

describe('S3 fix round 2 F3 — a pipeline cannot write the overview (real adapter, real plugin-scope wrapper)', () => {
  it('A-01 the REAL adapter at the overview id refuses with its typed error before any write — zero host createRecord calls', async () => {
    const { scoped, raw } = scopedFor(PLUGIN)
    const adapter = adapterLib.createMetaSheetMultitableTargetAdapter({ system: targetSystem(OVERVIEW), context: { api: { multitable: scoped } } })
    const error = await adapter.upsert({ object: 'ov', records: [{ projectNo: 'P-F3', status: 'active' }] }).then(() => null, (e: unknown) => e)
    expect(error).toMatchObject({ name: 'MultitableSystemSheetWriteError', code: adapterLib.METASHEET_MULTITABLE_SYSTEM_SHEET_READ_ONLY })
    expect(JSON.stringify((error as { details?: unknown }).details)).not.toContain(OVERVIEW)
    expect(raw.records.createRecord).not.toHaveBeenCalled()
    expect(raw.records.patchRecord).not.toHaveBeenCalled()
  })

  it('A-02 the HOST refuses on its own: the adapter without the probe (older host shape) gets every row refused — still zero host writes', async () => {
    const { scoped, raw } = scopedFor(PLUGIN)
    const withoutProbe = { ...scoped, records: { ...scoped.records } }
    delete (withoutProbe.records as { isReadOnlySystemSheet?: unknown }).isReadOnlySystemSheet
    const adapter = adapterLib.createMetaSheetMultitableTargetAdapter({ system: targetSystem(OVERVIEW), context: { api: { multitable: withoutProbe } } })
    const result = await adapter.upsert({ object: 'ov', records: [{ projectNo: 'P-F3', status: 'active' }, { projectNo: 'P-F3B', status: 'active' }] })
    expect(result.written).toBe(0)
    expect(result.failed).toBe(2)
    expect(raw.records.createRecord).not.toHaveBeenCalled()
    expect(raw.records.patchRecord).not.toHaveBeenCalled()
  })

  it('A-03 the C6 write source (insertRows / updateRows) at the overview id is refused before any write', async () => {
    const { scoped, raw } = scopedFor(PLUGIN)
    const source = adapterLib.createMetaSheetMultitableWriteSource({ system: targetSystem(OVERVIEW), context: { api: { multitable: scoped } } })
    await expect(source.insertRows('ds', 'ov', [{ projectNo: 'P-F3', status: 'active' }], { keyFields: ['projectNo'] })).rejects.toMatchObject({ code: adapterLib.METASHEET_MULTITABLE_SYSTEM_SHEET_READ_ONLY })
    await expect(source.updateRows('ds', 'ov', [{ projectNo: 'P-F3', status: 'active' }], { keyFields: ['projectNo'] })).rejects.toMatchObject({ code: adapterLib.METASHEET_MULTITABLE_SYSTEM_SHEET_READ_ONLY })
    expect(raw.records.createRecord).not.toHaveBeenCalled()
    expect(raw.records.patchRecord).not.toHaveBeenCalled()
  })

  it('A-04 control: the same adapter at an ordinary sheet of the same id shape writes once', async () => {
    const { scoped, raw } = scopedFor(PLUGIN)
    const adapter = adapterLib.createMetaSheetMultitableTargetAdapter({ system: targetSystem(ORDINARY), context: { api: { multitable: scoped } } })
    const result = await adapter.upsert({ object: 'ov', records: [{ projectNo: 'P-F3', status: 'active' }] })
    expect(result.written).toBe(1)
    expect(raw.records.createRecord).toHaveBeenCalledTimes(1)
    expect(raw.records.createRecord.mock.calls[0]?.[0]).toMatchObject({ sheetId: ORDINARY })
  })
})

describe('S3 fix round 2 F3 — the generic plugin record writes refuse the overview (every plugin)', () => {
  it('G-01 create / patch / delete / persist unit of work on the overview → StockPreparationOverviewRecordsWriteError (generic_write), no host call', async () => {
    for (const pluginName of [PLUGIN, 'plugin-after-sales']) {
      const runUnitOfWork = vi.fn(async () => 'ran')
      const { scoped, raw } = scopedFor(pluginName, makeRawHost(), { runStockPreparationPersistUnitOfWork: runUnitOfWork })
      const refusals = [
        scoped.records.createRecord({ sheetId: OVERVIEW, data: { a: 1 } }),
        scoped.records.patchRecord({ sheetId: OVERVIEW, recordId: 'rec_1', changes: { a: 2 } }),
        scoped.records.deleteRecord({ sheetId: OVERVIEW, recordId: 'rec_1' }),
        scoped.records.runStockPreparationPersistUnitOfWork!({
          tenantId: 'tenant_f3',
          sheetIds: [OVERVIEW, ORDINARY, 'sheet_line', 'sheet_run'],
          project: { sheetId: OVERVIEW, projectId: PROJECT_ID },
          batch: { sheetId: ORDINARY, snapshotBatchId: 'batch_1' },
        }, async () => 'never'),
      ]
      for (const refusal of refusals) {
        const error = await refusal.then(() => null, (e: unknown) => e)
        expect(error, pluginName).toBeInstanceOf(StockPreparationOverviewRecordsWriteError)
        expect(error).toMatchObject({ status: 403, code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason: 'generic_write' } })
        expect((error as Error).message).not.toContain(OVERVIEW)
      }
      expect(raw.records.createRecord).not.toHaveBeenCalled()
      expect(raw.records.patchRecord).not.toHaveBeenCalled()
      expect(raw.records.deleteRecord).not.toHaveBeenCalled()
      expect(runUnitOfWork).not.toHaveBeenCalled()
      // Reading the overview is not refused.
      await expect(scoped.records.queryRecords({ sheetId: OVERVIEW })).resolves.toEqual([])
      await expect(scoped.records.isReadOnlySystemSheet!({ sheetId: OVERVIEW })).resolves.toBe(true)
    }
  })

  it('G-02 a host that cannot say (no stamp hook) refuses every derived-shape id as unverifiable, and passes other ids without asking', async () => {
    const { scoped, raw } = scopedFor(PLUGIN, makeRawHost(), { isStockPreparationOverviewSheet: undefined })
    for (const sheetId of [OVERVIEW, ORDINARY]) {
      await expect(scoped.records.createRecord({ sheetId, data: {} })).rejects.toMatchObject({ details: { reason: 'unverifiable' } })
    }
    expect(raw.records.createRecord).not.toHaveBeenCalled()
    await expect(scoped.records.createRecord({ sheetId: 'sheet_plain_f3', data: { a: 1 } })).resolves.toMatchObject({ sheetId: 'sheet_plain_f3' })
    expect(raw.records.createRecord).toHaveBeenCalledTimes(1)
  })

  it('G-03 control: an ordinary derived-shape sheet (one stamp lookup) and a non-derived sheet (none) write as before', async () => {
    const { scoped, raw, hooks } = scopedFor('plugin-after-sales')
    await scoped.records.createRecord({ sheetId: ORDINARY, data: { a: 1 } })
    await scoped.records.createRecord({ sheetId: 'sheet_plain_f3', data: { a: 1 } })
    expect(raw.records.createRecord).toHaveBeenCalledTimes(2)
    expect(hooks.isStockPreparationOverviewSheet).toHaveBeenCalledTimes(1)
    expect(hooks.isStockPreparationOverviewSheet).toHaveBeenCalledWith({ sheetId: ORDINARY })
    expect('stockPreparationOverview' in scoped.records).toBe(false)
  })
})

describe('S3 fix round 2 F3 — the overview port is the only writer, and a narrow one', () => {
  it('P-01 plugin-integration-core only; the host derives the sheet for the named project and re-checks owner + stamp per write', async () => {
    const { scoped, raw, hooks } = scopedFor(PLUGIN)
    const port = scoped.records.stockPreparationOverview!
    expect(port).toBeTruthy()
    const created = await port.createRecord({ projectId: PROJECT_ID, data: { fld_projectNo: 'P-F3' } })
    expect(created.sheetId).toBe(OVERVIEW)
    await port.patchRecord({ projectId: PROJECT_ID, recordId: created.id, changes: { fld_projectNo: 'P-F3-X' } })
    await port.deleteRecord({ projectId: PROJECT_ID, recordId: created.id })
    expect(raw.records.createRecord).toHaveBeenCalledWith({ sheetId: OVERVIEW, data: { fld_projectNo: 'P-F3' } })
    expect(raw.records.patchRecord.mock.calls[0]?.[0]).toMatchObject({ sheetId: OVERVIEW, recordId: created.id })
    expect(raw.records.deleteRecord).toHaveBeenCalledWith({ sheetId: OVERVIEW, recordId: created.id })
    expect(hooks.assertSheetOwnedByPlugin).toHaveBeenCalledTimes(3)
    expect(hooks.isStockPreparationOverviewSheet).toHaveBeenCalledTimes(3)
    // A caller-supplied sheet id is not an input of the port at all.
    await port.createRecord({ projectId: PROJECT_ID, sheetId: ORDINARY, data: {} } as never)
    expect(raw.records.createRecord.mock.calls.at(-1)?.[0]).toMatchObject({ sheetId: OVERVIEW })
    for (const other of ['plugin-after-sales', 'integration-core', 'plugin-integration-core-fork']) {
      expect(scopedFor(other).scoped.records.stockPreparationOverview, other).toBeUndefined()
    }
  })

  it('P-02 refuses an unstamped derived sheet, a missing hook, an ownership refusal and a foreign namespace — no host write', async () => {
    const unstamped = scopedFor(PLUGIN, makeRawHost(), { isStockPreparationOverviewSheet: vi.fn(async () => false) })
    await expect(unstamped.scoped.records.stockPreparationOverview!.createRecord({ projectId: PROJECT_ID, data: {} })).rejects.toMatchObject({ details: { reason: 'not_overview' } })
    expect(unstamped.raw.records.createRecord).not.toHaveBeenCalled()

    for (const missing of ['isStockPreparationOverviewSheet', 'assertSheetOwnedByPlugin']) {
      const s = scopedFor(PLUGIN, makeRawHost(), { [missing]: undefined })
      await expect(s.scoped.records.stockPreparationOverview!.patchRecord({ projectId: PROJECT_ID, recordId: 'rec_1', changes: {} })).rejects.toMatchObject({ details: { reason: 'unverifiable' } })
      expect(s.raw.records.patchRecord).not.toHaveBeenCalled()
    }

    const foreign = scopedFor(PLUGIN, makeRawHost(), { assertSheetOwnedByPlugin: vi.fn(async () => { throw new Error('owned by another plugin') }) })
    await expect(foreign.scoped.records.stockPreparationOverview!.deleteRecord({ projectId: PROJECT_ID, recordId: 'rec_1' })).rejects.toThrow('owned by another plugin')
    expect(foreign.raw.records.deleteRecord).not.toHaveBeenCalled()

    const namespace = scopedFor(PLUGIN)
    await expect(namespace.scoped.records.stockPreparationOverview!.createRecord({ projectId: 'tenant_f3:after-sales', data: {} })).rejects.toBeInstanceOf(MultitableProjectNamespaceError)
    expect(namespace.raw.records.createRecord).not.toHaveBeenCalled()
  })
})

describe('S3 fix round 2 F3 — the overview module still writes, through the real wrapper, only via the port', () => {
  it('M-01 refresh creates the project row and the per-event update patches it; every overview write reached the host as the derived overview sheet', async () => {
    const raw = makeRawHost()
    const { scoped } = scopedFor(PLUGIN, raw)
    const db = harness.makeMemoryDb()
    const store = storeLib.createStockPreparationProjectTargetStore({ db, idGenerator: () => 'pt-f3' })
    db.rowsOf('integration_stock_prep_project_target').push({
      id: 'seed-f3', tenant_id: 'tenant_f3', project_no: 'P-F3', sheet_id: PROJECT_SHEET, object_id: PROJECT_SHEET_OBJECT,
      status: 'active', created_by: 'seed', created_at: new Date('2026-10-09T00:00:00Z'), archived_at: null, updated_at: new Date('2026-10-09T00:00:00Z'),
    })
    const common = { provisioning: scoped.provisioning, recordsApi: scoped.records, store, tenantId: 'tenant_f3', projectId: PROJECT_ID, locale: 'en' }
    const refreshed = await overviewLib.refreshProjectOverview(common)
    expect(refreshed.rowsCreated).toBe(1)
    const overviewRows = raw.rows.filter((row) => row.sheetId === OVERVIEW)
    expect(overviewRows).toHaveLength(1)
    expect(overviewRows[0]?.data.fld_status).toBe('active')

    db.rowsOf('integration_stock_prep_project_target')[0]!.status = 'archived'
    db.rowsOf('integration_stock_prep_project_target')[0]!.archived_at = new Date('2026-10-09T01:00:00Z')
    const updated = await overviewLib.updateProjectOverviewRow({ ...common, projectNo: 'P-F3' })
    expect(updated.outcome).toBe('updated')
    expect(raw.rows.filter((row) => row.sheetId === OVERVIEW)[0]?.data.fld_status).toBe('archived')
    // Only the overview sheet was written, and only through the port (the generic path would have refused).
    expect(raw.records.createRecord.mock.calls.map((call) => call[0].sheetId)).toEqual([OVERVIEW])
    expect(raw.records.patchRecord.mock.calls.map((call) => call[0].sheetId)).toEqual([OVERVIEW])
  })
})
