/**
 * 人工补充行 B4 — real-Postgres proof of the PER-SHEET SWITCH (ADR adr-stock-prep-manual-rows-20261030 §4, §5.3 and
 * §8 「B4」 5: 「真库测试：插件写开关之后，主机拒绝新建」). The PLUGIN's switch routes (lib/http-routes.cjs
 * `stockPreparationProjectManualRowsGet` / `…Set`, registered through `registerIntegrationRoutes` over the PRODUCTION
 * plugin context: the real plugin-scoped provisioning port, the real plugin_kv storage, the real registry store and the
 * real audit store) and the HOST's manual-row create (the real univer-meta router), on a project sheet the real plugin
 * provisioned, locked and registered.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationManualRowsSwitchRealDbCases()` registers its
 * `describe` block and is called from the already-wired real-DB file tests/integration/multitable-record-duplicate.test.ts
 * (vitest.config.ts excludes it from the no-DB job; the "Run multitable real-DB integration" step of
 * .github/workflows/plugin-tests.yml names it) — the same host B2's cases use. Do NOT also list a standalone file.
 *
 *   MR4-RD-01 the plugin SETS disabled (stock-prep:admin, typed confirmation): 200, read back; in meta_fields the key
 *             column carries `stockPreparationManualRows: 'disabled'` and EVERY other key exactly as before (the PLM
 *             lock, the template stanza); ONE values-free audit row (088 `project_fields_update`, manual_rows_disabled)
 *             — then the HOST refuses a manual-row create 409 STOCK_PREP_MANUAL_ROWS_DISABLED with nothing written, and
 *             its /context block reads `disabled`.
 *   MR4-RD-02 the plugin SETS allowed: the host create goes through (the stamped manual row), /context `allowed`, a
 *             second audit row manual_rows_allowed; the same value again writes and audits nothing.
 *   MR4-RD-03 the reminder: no plugin_kv record = all zeros; the record B1's writer persists in the REAL plugin_kv is
 *             answered field for field.
 *   MR4-RD-04 archived (the store's own transition): the plugin SET is 409 ARCHIVED with meta_fields untouched and no
 *             audit row; the GET still answers; the deployment switch not exactly 'true' → the plugin answers 404 and
 *             the host refuses the create `project_sheets_off` — the two sides agree.
 * Values-free: every id is synthetic and per-run.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type { PluginContext } from '../../src/types/plugin'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { usePinnedServer } from '../utils/pinned-server'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
/* eslint-disable @typescript-eslint/no-explicit-any */
const { createDb } = require(path.join(PLUGIN_LIB, 'db.cjs')) as any
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const { syncStockPreparationContractOptionsForObject } = require(path.join(PLUGIN_LIB, 'stock-preparation-option-sync.cjs')) as any
const projectTargetStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-target-store.cjs')) as any
const projectTargetsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-project-targets.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
const auditStoreLib = require(path.join(PLUGIN_LIB, 'stock-preparation-audit-store.cjs')) as any
const { createStockPreparationProjectWriteLock } = require(path.join(PLUGIN_LIB, 'stock-preparation-project-write-lock.cjs')) as any
const httpRoutesLib = require(path.join(PLUGIN_LIB, 'http-routes.cjs')) as any
const access = require(path.join(PLUGIN_LIB, 'stock-preparation-workbench-access.cjs')) as any
const manualRowsLib = require(path.join(PLUGIN_LIB, 'stock-preparation-manual-rows.cjs')) as any
const harnessLib = require(path.join(REPO_ROOT, 'plugins/plugin-integration-core/__tests__/support/stock-preparation-project-sheet-harness.cjs')) as any
/* eslint-enable @typescript-eslint/no-explicit-any */

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const TARGET_TABLE = 'integration_stock_prep_project_target'
const SWITCH_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/manual-rows'

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'manual-rows-switch-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-manual-rows-switch',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

function routeResponse() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { statusCode: 200, body: null, headers: {} }
  res.status = (code: number) => { res.statusCode = code; return res }
  res.json = (payload: unknown) => { res.body = payload; return res }
  res.setHeader = (name: string, value: unknown) => { res.headers[name] = value; return res }
  res.send = (payload: unknown) => { res.body = payload; return res }
  res.end = () => res
  return res
}

export function defineStockPreparationManualRowsSwitchRealDbCases(): void {
  test('manual rows B4 real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the manual-rows B4 real-DB cases would skip-green')
    }
  })

  describeIfDatabase('stock-prep manual supplementary rows B4 — the per-sheet switch (real Postgres, real provisioning, the plugin routes and the host create)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const tenantId = `tenant_mrb4_${TOKEN}`
    const projectId = `${tenantId}:integration-core`
    const projectNo = `SYN-MRB4-${TOKEN}`
    // The host actor (the multitable writer who adds a manual row) and the plugin actor (the 备料主管理员, OQ6).
    const WRITER = { id: `u_mrb4_writer_${TOKEN}`, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const STOCK_PREP_ADMIN_USER = { id: `u_mrb4_admin_${TOKEN}`, tenantId, permissions: [access.STOCK_PREP_ADMIN] }
    const switchBefore = process.env[SWITCH]
    const pinned = usePinnedServer()
    const http = () => request(pinned.url())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes = new Map<string, any>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let registry: any
    let sheetId = ''
    let objectId = ''
    let fields: Record<string, string> = {}
    let lastPullKey = ''

    const phys = (logical: string) => {
      const id = fields[logical]
      if (!id) throw new Error(`no physical id for ${logical}`)
      return id
    }
    const keyProperty = async () => ((await q('SELECT property FROM meta_fields WHERE sheet_id = $1 AND id = $2', [sheetId, phys('idempotencyKey')])).rows[0] as { property: Record<string, unknown> }).property
    const rowCount = async () => Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])).rows[0] as { n: number }).n)
    const auditRows = async () => (await q(
      "SELECT action, mode, subject_id, project_id, actor, detail FROM integration_stock_prep_audit WHERE tenant_id = $1 AND action = 'project_fields_update' ORDER BY created_at, id",
      [tenantId],
    )).rows as Array<{ action: string; mode: string; subject_id: string; project_id: string; actor: string; detail: Record<string, unknown> }>
    const hostCreate = () => http().post(`/api/multitable/sheets/${sheetId}/manual-rows`).send({ data: { [phys('componentName')]: 'Synthetic manual part', [phys('totalQuantity')]: 2 } })
    const hostContextBlock = async () => (await http().get('/api/multitable/context').query({ sheetId })).body?.data?.capabilities?.stockPreparationManualRows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callPlugin = async (method: 'GET' | 'POST', req: Record<string, unknown>): Promise<any> => {
      const handler = routes.get(`${method} ${SWITCH_PATH}`)
      if (!handler) throw new Error(`plugin route ${method} ${SWITCH_PATH} is not registered`)
      const res = routeResponse()
      await handler({ user: STOCK_PREP_ADMIN_USER, body: req.body || {}, query: req.query || {}, params: { projectNo } }, res)
      return res
    }
    const readSwitch = () => callPlugin('GET', { query: { tenantId } })
    const setSwitch = (policy: string) => callPlugin('POST', { body: { confirmProjectNo: projectNo, policy } })
    const withoutSwitch = (property: Record<string, unknown>) => {
      const { stockPreparationManualRows: _switch, ...rest } = property
      return rest
    }

    beforeAll(async () => {
      process.env[SWITCH] = 'true'
      const app = express()
      app.use(express.json())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app.use((req, _res, next) => { ;(req as any).user = WRITER; next() })
      app.use('/api/multitable', univerMetaRouter())
      pinned.setApp(app)

      // The project sheet, as the plugin provisions one: the frozen template, the contract option sets, the PLM lock,
      // the plugin registry row (087).
      objectId = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const pluginContext = createProductionPluginContext()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const multitable: any = pluginContext.api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      sheetId = ensured.target.sheetId
      fields = { ...ensured.target.fieldIdMap }
      lastPullKey = manualRowsLib.manualRowsLastPullKey(sheetId)
      const db = createDb({ database: pluginContext.api.database })
      registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db })
      await registry.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })

      // The plugin's routes over the PRODUCTION plugin context: the plugin-scoped provisioning port and plugin_kv.
      const routeContext = {
        api: {
          http: { addRoute: (method: string, routePath: string, handler: unknown) => routes.set(`${method.toUpperCase()} ${routePath}`, handler) },
          multitable,
          database: pluginContext.api.database,
        },
        storage: pluginContext.storage,
        config: {},
      }
      const services = {
        ...harnessLib.baseServices(null),
        stockPreparationProjectWriteLock: createStockPreparationProjectWriteLock({ db }),
        stockPreparationProjectTargetStore: registry,
        stockPreparationAuditStore: auditStoreLib.createStockPreparationAuditStore({ db }),
        tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
      }
      httpRoutesLib.registerIntegrationRoutes({ context: routeContext, services, logger: { info() {}, warn() {}, error() {} } })
    }, 120_000)

    afterAll(async () => {
      if (switchBefore === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = switchBefore
      if (sheetId) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
      await q(`DELETE FROM ${TARGET_TABLE} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
      await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [tenantId]).catch(() => {})
      if (lastPullKey) await q("DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = $1", [lastPullKey]).catch(() => {})
    })

    test('MR4-RD-01 the plugin sets disabled: read back, only the switch key changed, one values-free audit row — then the host refuses the create and /context reads disabled', async () => {
      const before = await keyProperty()
      expect(before.humanWriteLock).toBe('plm_system')
      expect(manualRowsLib.manualRowsPolicyValueOf(before)).toBe(null)
      expect(await hostContextBlock()).toMatchObject({ state: 'allowed' })

      const set = await setSwitch('disabled')
      expect(set.statusCode, JSON.stringify(set.body)).toBe(200)
      expect(set.body.data).toMatchObject({ status: 'active', sheetId, keyColumn: 'present', policy: 'disabled', policySource: 'set', keyLocked: true, written: true, changed: true })
      const after = await keyProperty()
      expect(after.stockPreparationManualRows).toBe('disabled')
      expect(withoutSwitch(after), 'the lock, the stanza and every other key are exactly as before').toEqual(withoutSwitch(before))
      const rows = await auditRows()
      expect(rows.map((row) => [row.action, row.mode, row.subject_id, row.project_id, row.actor])).toEqual([
        ['project_fields_update', 'manual_rows_disabled', sheetId, projectNo, STOCK_PREP_ADMIN_USER.id],
      ])
      expect(rows[0].detail).toEqual({ objectId, fromPolicy: 'allowed', fromSource: 'default', toPolicy: 'disabled', confirmed: true })

      // The host, on the same sheet, the same database: the create is refused BEFORE any write.
      const rowsBefore = await rowCount()
      const refused = await hostCreate()
      expect(refused.status, JSON.stringify(refused.body).slice(0, 300)).toBe(409)
      expect(refused.body.error.code).toBe('STOCK_PREP_MANUAL_ROWS_DISABLED')
      expect(await rowCount()).toBe(rowsBefore)
      expect(await hostContextBlock()).toMatchObject({ state: 'disabled' })

      // The plugin GET reads back what was set.
      const got = await readSwitch()
      expect(got.statusCode, JSON.stringify(got.body)).toBe(200)
      expect(got.body.data).toMatchObject({ policy: 'disabled', policySource: 'set', may: { set: true } })
    })

    test('MR4-RD-02 the plugin sets allowed: the host create goes through; a second audit row; the same value again writes and audits nothing', async () => {
      const set = await setSwitch('allowed')
      expect(set.statusCode, JSON.stringify(set.body)).toBe(200)
      expect(set.body.data).toMatchObject({ policy: 'allowed', policySource: 'set', written: true, changed: true })
      expect((await keyProperty()).stockPreparationManualRows).toBe('allowed')
      expect(await hostContextBlock()).toMatchObject({ state: 'allowed' })
      const created = await hostCreate()
      expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(200)
      const id = created.body.data.record.id as string
      const stored = (await q('SELECT data, created_by FROM meta_records WHERE id = $1', [id])).rows[0] as { data: Record<string, unknown>; created_by: string }
      expect(stored.data[phys('idempotencyKey')]).toBe(`manual:v1:${id}`)
      expect(stored.created_by).toBe(WRITER.id)
      expect((await auditRows()).map((row) => [row.mode, row.detail.fromPolicy, row.detail.toPolicy])).toEqual([
        ['manual_rows_disabled', 'allowed', 'disabled'],
        ['manual_rows_allowed', 'disabled', 'allowed'],
      ])
      const again = await setSwitch('allowed')
      expect(again.statusCode, JSON.stringify(again.body)).toBe(200)
      expect(again.body.data).toMatchObject({ written: false, changed: false })
      expect((await auditRows()).length).toBe(2)
    })

    test('MR4-RD-03 the reminder: no plugin_kv record = all zeros; B1\'s persisted record in the real plugin_kv is answered field for field', async () => {
      await q("DELETE FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = $1", [lastPullKey])
      const none = await readSwitch()
      expect(none.statusCode, JSON.stringify(none.body)).toBe(200)
      expect(none.body.data.lastPull).toEqual({ status: 'none', at: null, mode: null, rowCount: 0, unboundKeyCount: 0, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [] })
      const summary = { rowCount: 2, unboundKeyCount: 1, matchedManualCount: 1, matchedManualRecordIds: [`rec_mrb4_m_${TOKEN}`], unboundRecordIds: [`rec_mrb4_u_${TOKEN}`] }
      const pluginContext = createProductionPluginContext()
      expect(await manualRowsLib.persistManualRowsLastPull({ store: pluginContext.storage, sheetId, mode: 'dry_run', at: '2026-10-31T01:02:03.000Z', summary })).toBe(true)
      const stored = ((await q("SELECT value FROM plugin_kv WHERE plugin = 'plugin-integration-core' AND key = $1", [lastPullKey])).rows[0] || {}).value
      expect(stored, 'the record is in the real plugin_kv').toBeTruthy()
      const recorded = await readSwitch()
      expect(recorded.body.data.lastPull).toEqual({ status: 'recorded', at: '2026-10-31T01:02:03.000Z', mode: 'dry_run', ...summary })
    })

    test('MR4-RD-04 archived: the plugin SET is 409 with meta_fields untouched; the GET answers; the deployment switch not exactly true → plugin 404 and host project_sheets_off', async () => {
      const before = await keyProperty()
      const auditBefore = (await auditRows()).length
      await registry.archive({ tenantId, projectNo, actorId: 'syn' })
      try {
        const refused = await setSwitch('disabled')
        expect(refused.statusCode, JSON.stringify(refused.body)).toBe(409)
        expect(refused.body.error.code).toBe('STOCK_PREPARATION_PROJECT_ARCHIVED')
        expect(await keyProperty()).toEqual(before)
        expect((await auditRows()).length).toBe(auditBefore)
        const got = await readSwitch()
        expect(got.statusCode, JSON.stringify(got.body)).toBe(200)
        expect(got.body.data).toMatchObject({ status: 'archived', policy: 'allowed', may: { set: false } })
      } finally {
        await registry.restore({ tenantId, projectNo, actorId: 'syn' })
      }
      process.env[SWITCH] = 'TRUE'
      try {
        for (const res of [await readSwitch(), await setSwitch('disabled')]) {
          expect(res.statusCode, JSON.stringify(res.body)).toBe(404)
          expect(res.body.error.code).toBe('STOCK_PREPARATION_PROJECT_SHEETS_DISABLED')
        }
        const rowsBefore = await rowCount()
        const hostRefused = await hostCreate()
        expect(hostRefused.status, JSON.stringify(hostRefused.body).slice(0, 300)).toBe(409)
        expect(hostRefused.body.error.details).toEqual({ reason: 'project_sheets_off' })
        expect(await rowCount()).toBe(rowsBefore)
        expect(await keyProperty()).toEqual(before)
      } finally {
        process.env[SWITCH] = 'true'
      }
    })
  })
}
