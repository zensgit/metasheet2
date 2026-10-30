/**
 * 人工补充行 B1 — real-Postgres proof of the plugin half of ADR adr-stock-prep-manual-rows-20261030 (§8 「B1 插件」 1 and
 * 10): the pull never touches a `manual:` prefix row, the export carries 来源, and the R-60 boundary holds.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationManualRowsRealDbCases()` registers its `describe`
 * blocks and is called from the already-wired stock-prep real-DB host
 * (tests/integration/stock-preparation-p4-repair-once-realdb.test.ts), so the cases execute in the existing
 * "Run multitable real-DB integration" step of .github/workflows/plugin-tests.yml without a new lane file (precedent:
 * stock-preparation-project-write-lock-realdb.cases.ts). Do NOT also list a standalone file for these cases.
 *
 * Every case drives the PRODUCTION host (MetaSheetServer.createPluginContext: the real records API, the real plugin_kv
 * storage), the real project write lock, the real registry store and the real refresh governance, through the REAL
 * routes (lib/http-routes.cjs registerIntegrationRoutes). A person's row is inserted the way the host's REST create
 * inserts one (record-service.ts: id, data, version 1, created_by, modified_by in one INSERT) — B2's manual-row route
 * does not exist yet; the key it will stamp is `manual:v1:<this row's id>`.
 *
 *   MR-RD-01 THE RAW PAGE on real meta_records: more rows than the page, the manual row on page 1 (the database's own
 *            ORDER BY id puts it there — calibrated), the reader called directly with limit 2 and 3: every PLM row
 *            comes back, both prefix rows ride the array Symbol, neither is planned.
 *   MR-RD-02 a registered, NOT-governed project sheet holding a manual row and an unbound prefix row (no creator):
 *            preview ready with two ADDs and no INACTIVE, `manualSupplement` reports both (the manual row matched by
 *            图号 against an ADD); the apply writes the two PLM rows and leaves both prefix rows byte-identical
 *            (version, data, created_by); the reminder sits in real plugin_kv, values-free, per pull; the export is 200
 *            with 来源 as the 31st column (人工补充 / 人工（非补充） / PLM) and the audit row's columnCount is 31.
 *   MR-RD-03 the R-60 boundary on a PILOT project: settled, the export is 200 with 30 columns; a manual row inserted
 *            => 200 with 来源; the manual row edited through the host (version + 1, two PLM-band cells) => 200 (never
 *            409 SHEET_CHANGED_SINCE_SETTLEMENT), and the next preview stays `ready`; control: a host-side machine write
 *            on a PLM row => 409 SHEET_CHANGED_SINCE_SETTLEMENT.
 * Values-free: every id is synthetic and per-run.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
/* eslint-disable @typescript-eslint/no-explicit-any */
const tableActions = require(path.join(PLUGIN_LIB, 'stock-preparation-table-actions.cjs')) as any
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any
const { createStockPreparationProjectWriteLock, sheetWriteScopeKey, PROJECT_WRITE_LOCK_TABLE } = require(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs')) as any
const continuationStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-continuation-store.cjs')) as any
const refreshGovernanceLib = require(path.join(PLUGIN_LIB, 'stock-preparation-refresh-governance.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const packInstallStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-pack-install-store.cjs')) as any
const auditStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
const confirmationDecisionsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-confirmation-decisions.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const httpRoutesLib = require(path.join(PLUGIN_LIB, 'http-routes.cjs')) as any
const access = require(path.join(PLUGIN_LIB, 'stock-preparation-workbench-access.cjs')) as any
const manualRowsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-manual-rows.cjs')) as any
const harnessLib = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')) as any

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const RT = continuationStoreLib.REFRESH_STORE_TABLES
const SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const ACTION_ID = tableActions.PLM_STOCK_PREPARATION_ACTION_ID
const PATHS = {
  dryRun: '/api/integration/table-actions/:actionId/dry-run',
  apply: '/api/integration/table-actions/:actionId/apply',
  export: '/api/integration/stock-preparation/prep-lines/export',
}
const SHEET_CHANGED = 'STOCK_PREP_EXPORT_SHEET_CHANGED_SINCE_SETTLEMENT'

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'manual-rows-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-manual-rows',
    loadedAt: new Date(),
  }
  return (server as unknown as {
    createPluginContext: (plugin: LoadedPlugin) => PluginContext
  }).createPluginContext(loaded)
}

function routeResponse() {
  const res: any = { statusCode: 200, body: null, headers: {} }
  res.status = (code: number) => { res.statusCode = code; return res }
  res.json = (payload: unknown) => { res.body = payload; return res }
  res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res }
  res.send = (payload: unknown) => { res.body = payload; return res }
  res.end = () => res
  return res
}

// Two synthetic parts: assembly A (a root) and its child B, as the PLM source tables answer them.
function plmData(projectNo: string) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: 'MRB1-PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'MRB1-PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'MRB1-ORDER-1', path_id: 'MRB1-PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'MRB1-ORDER-1', part_id: 'MRB1-PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [
      { OBJ_ID: 'MRB1-PART-A', IdentityNo: 'MRB1-A-001', IdentityName: 'Synthetic assembly', Material: 'Synthetic', SysVer: 'V1' },
      { OBJ_ID: 'MRB1-PART-B', IdentityNo: 'MRB1-B-001', IdentityName: 'Synthetic part', Material: 'Synthetic', SysVer: 'V1' },
    ],
    DN_PDM_BomHeadInfo: [{ part_id: 'MRB1-PART-A', bom_id: 'MRB1-BOM-A', SysVer: 'V1', bom_able: true }],
    DN_PDM_BomDetailsInfo: [{ bom_pid: 'MRB1-BOM-A', part_id: 'MRB1-PART-B', Bom_ExAttr1: '3' }],
  }
}

export function defineStockPreparationManualRowsRealDbCases(): void {
  test('manual rows real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the manual-rows real-DB cases would skip-green')
    }
  })

  const TOKEN = `${process.pid}_${Date.now().toString(36)}`
  const sheets: string[] = []
  const tenants: string[] = []
  const kvKeys: string[] = []

  describeIfDatabase('stock-prep manual supplementary rows B1 (real Postgres, real host, real routes)', () => {
    afterAll(async () => {
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
        await q(`DELETE FROM ${PROJECT_WRITE_LOCK_TABLE} WHERE scope_key = $1`, [sheetWriteScopeKey(sheetId)]).catch(() => {})
      }
      for (const tenantId of tenants) {
        for (const table of [RT.changePlan, RT.member, RT.continuation, RT.hold, RT.execution, RT.state, 'integration_stock_prep_audit', 'integration_stock_prep_project_target']) {
          await q(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
        }
      }
      if (kvKeys.length) await q(`DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = ANY($1::text[])`, [kvKeys]).catch(() => {})
    })

    async function stack(label: string, { pilot }: { pilot: boolean }) {
      const tenantId = `tenant_mrb1_${label}_${TOKEN}`
      tenants.push(tenantId)
      const projectNo = `SYN-MRB1-${label.toUpperCase()}`
      const projectId = `${tenantId}:integration-core`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const pluginContext = createProductionPluginContext()
      const multitable: any = pluginContext.api.multitable
      if (!multitable) throw new Error('production plugin context is missing multitable APIs')
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      // The deployment's env target: its own sandbox sheet in the same tenant project (the sandbox allowlist names it).
      const envObjectId = `plm_stock_preparation_sandbox_mrb1_env_${label}_${TOKEN}`
      const envEnsured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId: envObjectId })
      expect(envEnsured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId: envObjectId })
      sheets.push(envEnsured.target.sheetId)
      const db = createDb({ database: pluginContext.api.database })
      const registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
      await registry.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })
      if (pilot) {
        await q('UPDATE integration_stock_prep_project_target SET pilot_enabled_at = now(), pilot_enabled_by = $3, pilot_readiness_version = 1 WHERE tenant_id = $1 AND project_no = $2', [tenantId, projectNo, 'u_mrb1_admin'])
      }
      const lock = createStockPreparationProjectWriteLock({ db })
      const store = continuationStoreLib.createStockPreparationContinuationStore({ db })
      const governance = refreshGovernanceLib.createStockPreparationRefreshGovernance({ continuationStore: store, projectTargetStore: registry, projectWriteLock: lock })
      const data = plmData(projectNo)
      const sourceAdapter = {
        async read(input: any = {}) {
          const rows = Array.isArray((data as any)[input.object]) ? (data as any)[input.object] : []
          const found = rows.filter((row: any) => Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected))
          return { records: found.map((row: any) => ({ ...row })), done: true, nextCursor: null }
        },
      }
      const actionConfig = {
        actionId: ACTION_ID,
        source: { externalSystemId: `plm_mrb1_${label}_${TOKEN}`, kind: 'data-source:sql-readonly' },
        target: envEnsured.target,
      }
      const routes = new Map<string, any>()
      const routeContext = {
        api: {
          http: { addRoute: (method: string, routePath: string, handler: any) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
          multitable,
          database: pluginContext.api.database,
        },
        storage: pluginContext.storage,
        config: {
          stockPreparationTableActions: [actionConfig],
          stockPrepApplySandbox: { enabled: true, allowedTargetObjectIds: [envObjectId] },
        },
      }
      const base = harnessLib.baseServices(sourceAdapter)
      const services: any = {
        ...base,
        externalSystemRegistry: { ...base.externalSystemRegistry, async listExternalSystems() { return [] } },
        pipelineRegistry: { ...base.pipelineRegistry, async listPipelines() { return [] } },
        stockPreparationProjectWriteLock: lock,
        stockPreparationProjectTargetStore: registry,
        stockPreparationAuditStore: auditStoreLib.createStockPreparationAuditStore({ db }),
        stockPreparationPackInstallStore: packInstallStoreLib.createStockPreparationPackInstallStore({ db }),
        stockPreparationConfirmationDecisionLease: confirmationDecisionsLib.createConfirmationDecisionReconcileLease({ db }),
        tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
        stockPreparationRefreshGovernance: governance,
        stockPreparationContinuationStore: store,
        // The export's workbook builder: a JSON buffer, so a case reads the headers and rows back.
        stockPreparationXlsxExport: { async buildWorkbookBuffer(params: any) { return Buffer.from(JSON.stringify(params), 'utf8') } },
      }
      httpRoutesLib.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
      const puller = { id: `u_mrb1_pull_${label}`, tenantId, permissions: [access.STOCK_PREP_READ, access.STOCK_PREP_OPERATE, access.STOCK_PREP_PULL] }
      const withSwitch = async <T>(fn: () => Promise<T>): Promise<T> => {
        const before = process.env[SWITCH]
        process.env[SWITCH] = 'true'
        try {
          return await fn()
        } finally {
          if (before === undefined) delete process.env[SWITCH]
          else process.env[SWITCH] = before
        }
      }
      const call = (method: string, routePath: string, req: Record<string, unknown>) => withSwitch(async () => {
        const handler = routes.get(`${method} ${routePath}`)
        if (!handler) throw new Error(`route ${method} ${routePath} is not registered`)
        const res = routeResponse()
        await handler({ user: puller, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
        return res
      })
      const lastPullKey = manualRowsLib.manualRowsLastPullKey(sheetId)
      kvKeys.push(lastPullKey)
      const fields = ensured.target.fieldIdMap as Record<string, string>
      const physical = (logical: string) => fields[logical] || logical
      return {
        tenantId, projectNo, sheetId, objectId, multitable, target: ensured.target, physical,
        async dryRun() {
          const res = await call('POST', PATHS.dryRun, { body: { parameters: { projectNo } }, params: { actionId: ACTION_ID } })
          if (res.body && res.body.data && typeof res.body.data.dryRunToken === 'string') kvKeys.push(`integration:table-action:dry-run-token:${res.body.data.dryRunToken}`)
          return res
        },
        apply: (token: string) => call('POST', PATHS.apply, { body: { parameters: { projectNo }, confirm: { dryRunToken: token } }, params: { actionId: ACTION_ID } }),
        exportLines: () => call('GET', PATHS.export, { query: { projectNo } }),
        // A person's row, inserted the way the host's REST create inserts one (record-service.ts): id, data, version 1,
        // created_by and modified_by in ONE statement. `key` defaults to the manual-row key of this id.
        async insertPersonRow(id: string, cells: Record<string, unknown>, { createdBy = `u_mrb1_person_${label}`, key }: { createdBy?: string | null; key?: string } = {}) {
          const logical: Record<string, unknown> = { projectNo, active: true, idempotencyKey: key === undefined ? `manual:v1:${id}` : key, ...cells }
          const rowData: Record<string, unknown> = {}
          for (const [field, value] of Object.entries(logical)) rowData[physical(field)] = value
          await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by) VALUES ($1, $2, $3::jsonb, 1, $4, $4)', [id, sheetId, JSON.stringify(rowData), createdBy])
        },
        recordState: async (id: string) => (await q('SELECT id, version, data, created_by FROM meta_records WHERE id = $1', [id])).rows[0],
        lastPull: async () => ((await q(`SELECT value FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = $1`, [lastPullKey])).rows[0] || {}).value || null,
        plmRecordIds: async () => (await q(`SELECT id FROM meta_records WHERE sheet_id = $1 AND NOT (data ->> $2 LIKE 'manual:%') ORDER BY id`, [sheetId, physical('idempotencyKey')])).rows.map((row: any) => row.id as string),
      }
    }

    const workbookOf = (res: any) => (res.statusCode === 200 && Buffer.isBuffer(res.body) ? JSON.parse(res.body.toString('utf8')) : null)
    const errorOf = (res: any) => (res && res.body && res.body.error ? res.body.error : {})

    test('MR-RD-01 + MR-RD-02 a registered not-governed project sheet: the raw page, the pull never writes a prefix row, the reminder in plugin_kv, the export with 来源', async () => {
      const st = await stack('nogov', { pilot: false })
      // The two prefix rows sort FIRST under the database's own ORDER BY id (any collation: eight zeros after `rec_`).
      const manualId = `rec_00000000_mrb1_m_${TOKEN}`
      const unboundId = `rec_00000000_mrb1_u_${TOKEN}`
      await st.insertPersonRow(manualId, { componentCode: 'MRB1-B-001', componentName: '人工补充件', totalQuantity: 5 })
      await st.insertPersonRow(unboundId, { componentCode: 'MRB1-U-001', componentName: '未绑定行', totalQuantity: 1 }, { createdBy: null })

      const preview = await st.dryRun()
      expect(preview.statusCode, JSON.stringify(preview.body)).toBe(200)
      const data = preview.body.data
      expect(data.status).toBe('ready')
      expect(data.counts).toEqual({ add: 2, update: 0, skip: 0, inactive: 0, manual_confirm: 0 })
      expect(data.manualSupplement).toEqual({ rowCount: 1, unboundKeyCount: 1, matchedManualCount: 1, matchedManualRecordIds: [manualId], unboundRecordIds: [unboundId] })
      expect(JSON.stringify(data.evidence).includes('manual:')).toBe(false)
      const afterPreview = await st.lastPull()
      expect(afterPreview).toMatchObject({ mode: 'dry_run', rowCount: 1, unboundKeyCount: 1, matchedManualCount: 1, matchedManualRecordIds: [manualId], unboundRecordIds: [unboundId] })
      expect(Object.keys(afterPreview).sort()).toEqual(['at', 'matchedManualCount', 'matchedManualRecordIds', 'mode', 'rowCount', 'unboundKeyCount', 'unboundRecordIds'])

      const manualBefore = await st.recordState(manualId)
      const unboundBefore = await st.recordState(unboundId)
      const applied = await st.apply(data.dryRunToken)
      expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
      expect(applied.body.data.status).toBe('succeeded')
      expect(applied.body.data.apply.counts).toEqual({ created: 2, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 })
      expect(applied.body.data.manualSupplement).toEqual(data.manualSupplement)
      // Version, data and created_by of both prefix rows byte-identical: the pull never wrote them.
      expect(await st.recordState(manualId)).toEqual(manualBefore)
      expect(await st.recordState(unboundId)).toEqual(unboundBefore)
      expect(manualBefore.version).toBe(1)
      expect((await st.lastPull()).mode).toBe('apply')
      expect(Object.prototype.hasOwnProperty.call(manualBefore.data, st.physical('componentSourceId'))).toBe(false)

      // MR-RD-01: four rows on a sheet read two (or three) at a time, the prefix rows first in the database's order.
      const firstPage = (await q('SELECT id FROM meta_records WHERE sheet_id = $1 ORDER BY id ASC LIMIT 2', [st.sheetId])).rows.map((row: any) => row.id)
      expect(firstPage.sort()).toEqual([manualId, unboundId].sort())
      const plmIds = await st.plmRecordIds()
      expect(plmIds.length).toBe(2)
      for (const limit of [2, 3]) {
        const rows = await tableActions.__internals.readExistingStockPreparationRows(st.multitable.records, st.target, st.projectNo, { limit })
        expect(rows.map((row: any) => row.componentCode).sort(), `limit ${limit}`).toEqual(['MRB1-A-001', 'MRB1-B-001'])
        const prefix = manualRowsLib.manualPrefixRowsOf(rows)
        expect(prefix.manualRows.map((entry: any) => entry.recordId), `limit ${limit}`).toEqual([manualId])
        expect(prefix.unboundKeyCount, `limit ${limit}`).toBe(1)
      }

      // The second preview: both PLM rows exist (SKIP), the manual row is still out of the plan, no reminder left.
      const second = await st.dryRun()
      expect(second.body.data.status).toBe('ready')
      expect(second.body.data.counts).toEqual({ add: 0, update: 0, skip: 2, inactive: 0, manual_confirm: 0 })
      expect(second.body.data.manualSupplement).toEqual({ rowCount: 1, unboundKeyCount: 1, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [unboundId] })
      expect(await st.lastPull()).toMatchObject({ mode: 'dry_run', matchedManualCount: 0, matchedManualRecordIds: [] })

      // The export: 来源 as the 31st column, the three values, the audit row's columnCount 31.
      const exported = await st.exportLines()
      expect(exported.statusCode, JSON.stringify(exported.body)).toBe(200)
      const workbook = workbookOf(exported)
      expect(workbook.headers.length).toBe(31)
      expect(workbook.headers[30]).toBe('来源')
      const codeAt = workbook.headers.indexOf('图号')
      // The PLM tree first (A, then its child B), then the prefix rows appended in the flat order — the manual copy of
      // B's 图号 is printed beside B, never collapsed into it.
      expect(workbook.rows.map((row: any[]) => [row[codeAt], row[30]])).toEqual([
        ['MRB1-A-001', 'PLM'],
        ['MRB1-B-001', 'PLM'],
        ['MRB1-B-001', '人工补充'],
        ['MRB1-U-001', '人工（非补充）'],
      ])
      const audit = (await q(`SELECT mode, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'prep_line_export' ORDER BY created_at, id`, [st.tenantId])).rows
      expect(audit.map((row: any) => row.detail.columnCount)).toEqual([31])
      expect(Object.keys(audit[0].detail).sort()).toEqual(['activeRowCount', 'columnCount', 'operation', 'totalRowCount'])
    }, 300000)

    test('MR-RD-03 the R-60 boundary on a PILOT project: a manual row added and edited after the settlement never refuses the formal export; a PLM machine write does', async () => {
      const st = await stack('pilot', { pilot: true })
      const first = await st.dryRun()
      expect(first.statusCode, JSON.stringify(first.body)).toBe(200)
      expect(first.body.data.status).toBe('ready')
      const applied = await st.apply(first.body.data.dryRunToken)
      expect(applied.statusCode, JSON.stringify(applied.body)).toBe(200)
      expect(applied.body.data.status).toBe('succeeded')
      const settling = await st.dryRun()
      expect(settling.body.data.status, JSON.stringify(settling.body)).toBe('ready')
      const settled = await st.exportLines()
      expect(settled.statusCode, JSON.stringify(settled.body)).toBe(200)
      expect(workbookOf(settled).headers.length).toBe(30)

      const manualId = `rec_00000000_mrb1_p_${TOKEN}`
      await st.insertPersonRow(manualId, { componentCode: 'MRB1-M-001', componentName: '人工补充件', totalQuantity: 2 })
      const withManual = await st.exportLines()
      expect(withManual.statusCode, JSON.stringify(withManual.body)).toBe(200)
      const workbook = workbookOf(withManual)
      expect(workbook.headers.length).toBe(31)
      expect(workbook.rows[workbook.rows.length - 1][30]).toBe('人工补充')

      // A person edits the manual row's PLM-band cells (图号, 总数量) through the host: version + 1.
      await st.multitable.records.patchRecord({ sheetId: st.sheetId, recordId: manualId, changes: { [st.physical('componentCode')]: 'MRB1-M-002', [st.physical('totalQuantity')]: 9 } })
      expect((await st.recordState(manualId)).version).toBe(2)
      const afterEdit = await st.exportLines()
      expect(afterEdit.statusCode, `${JSON.stringify(errorOf(afterEdit))}`).toBe(200)
      expect(workbookOf(afterEdit).rows.some((row: any[]) => row[workbookOf(afterEdit).headers.indexOf('图号')] === 'MRB1-M-002')).toBe(true)
      // The next preview raises no hold for it (the reader never hands it to the planner).
      const preview = await st.dryRun()
      expect(preview.body.data.status, JSON.stringify(preview.body)).toBe('ready')
      expect((await st.exportLines()).statusCode).toBe(200)

      // Control: a host-side machine write on a PLM row moves the settled digest => 409 SHEET_CHANGED_SINCE_SETTLEMENT.
      const plmIds = await st.plmRecordIds()
      await st.multitable.records.patchRecord({ sheetId: st.sheetId, recordId: plmIds[0], changes: { [st.physical('material')]: 'MRB1-MAT-HOST-EDITED' } })
      const refused = await st.exportLines()
      expect(refused.statusCode).toBe(409)
      expect(errorOf(refused).code).toBe(SHEET_CHANGED)
    }, 300000)
  })
}
