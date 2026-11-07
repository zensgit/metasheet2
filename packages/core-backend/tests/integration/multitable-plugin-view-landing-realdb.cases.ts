/**
 * 批次标识 BI-5 — the landing promotion and the values-free layout read against real PostgreSQL, on a project sheet the
 * REAL plugin provisioned (the frozen template, the host default view 全部记录, the plugin's 备料填写视图 / 待填写 views), through
 * the REAL plugin-scope wrappers (namespace, overview refusal, object scope against the plugin registry) and the REAL
 * univer-meta router.
 *
 * This is a CASES MODULE, not a test file: `defineMultitablePluginViewLandingRealDbCases()` registers its `describe` block
 * and is called from the already-wired p4 host tests/integration/stock-preparation-p4-repair-once-realdb.test.ts (named in
 * the "Run multitable real-DB integration" step of .github/workflows/plugin-tests.yml). Do NOT also list a standalone file.
 *
 *   BI5-RD-01 promote: `prep-fill` becomes views[0] of the context route AND of GET /views; only its created_at moved
 *             (every other column of it, and every column of every other view, byte-identical); a repeat answers
 *             alreadyFirst and writes nothing (idempotent).
 *   BI5-RD-02 a later re-ensure of the plugin's views (the real provisioning run again → `ensureView` upserts) keeps the
 *             promotion: created_at unchanged, still first.
 *   BI5-RD-03 template-installed ties: every view of the sheet on ONE created_at (a pre-#6091 template install); the
 *             promotion of a view tied AT the minimum still moves it strictly before all others and the route lists it
 *             first (the design's literal `created_at > min(all)` guard would answer alreadyFirst and move nothing).
 *   BI5-RD-04 refusals and absence on the real host: 'default' (typed code, nothing written), an unprovisioned logical id
 *             (missing, no view created), the overview object, a foreign namespace.
 *   BI5-RD-05 the durable writer block refuses the promotion with the fence flag on (created_at untouched).
 *   BI5-RD-06 describe: viewCount / firstView / the frozen prefix (a frozen first-visible column → counted, lost under a
 *             left insert, kept with leftInsertCount 0) / personal fieldOrder overrides (non-empty only) / the trash count;
 *             exactly the six keys and no view name, physical id or field id in the answer.
 * Values-free: every id is synthetic and per-run; the sheet's rows are deleted at the end.
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
import { __resetRecoveryWriterStateColumnProbe, SheetWriterBlockedError } from '../../src/multitable/canonical-sheet-fence'
import { getObjectViewId } from '../../src/multitable/provisioning'
import { StockPreparationOverviewStructureWriteError } from '../../src/multitable/stock-preparation-overview-contract'
import { DESCRIBE_LAYOUT_RESULT_KEYS, VIEW_LANDING_INPUT_INVALID_CODE } from '../../src/multitable/view-landing'
import { MultitableProjectNamespaceError } from '../../src/multitable/plugin-scope'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { usePinnedServer } from '../utils/pinned-server'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib')
/* eslint-disable @typescript-eslint/no-explicit-any */
const { ensureStockPreparationSandboxTarget, ensureStockPreparationTodoView } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
/* eslint-enable @typescript-eslint/no-explicit-any */

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const FENCE_ENV = 'MULTITABLE_ENABLE_WRITER_FENCE'

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'view-landing-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://multitable-plugin-view-landing',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

type ViewRow = { id: string; created_at: Date | null; updated_at: Date | null; name: string; type: string; filter_info: unknown; sort_info: unknown; group_info: unknown; hidden_field_ids: unknown; config: unknown }

export function defineMultitablePluginViewLandingRealDbCases(): void {
  test('view landing BI-5 real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the BI-5 view landing real-DB cases would skip-green')
    }
  })

  describeIfDatabase('plugin view landing promotion and values-free layout read BI-5 (real Postgres, real provisioning, real routes)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const tenantId = `tenant_bi5_${TOKEN}`
    const projectId = `${tenantId}:integration-core`
    const ADMIN = { id: `u_bi5_admin_${TOKEN}`, roles: ['admin'], perms: [] as string[] }
    const projectNo = `SYN-BI5-${TOKEN}`
    const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
    const FILL = getObjectViewId(projectId, objectId, 'prep-fill')
    const TODO = getObjectViewId(projectId, objectId, 'prep-todo')
    const DEFAULT = getObjectViewId(projectId, objectId, 'default')
    let sheetId = ''
    let multitable: any
    const fenceBefore = process.env[FENCE_ENV]

    const pinned = usePinnedServer()
    const http = () => request(pinned.url())
    const viewRows = async (): Promise<ViewRow[]> =>
      (await q('SELECT id, created_at, updated_at, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY id', [sheetId])).rows as ViewRow[]
    const byId = (rows: ViewRow[]) => new Map(rows.map((row) => [row.id, row]))
    const contextFirst = async () => {
      const res = await http().get('/api/multitable/context').query({ sheetId })
      expect(res.status).toBe(200)
      return (res.body.data.views as Array<{ id: string }>).map((view) => view.id)
    }
    const listFirst = async () => {
      const res = await http().get('/api/multitable/views').query({ sheetId })
      expect(res.status).toBe(200)
      return (res.body.data.views as Array<{ id: string }>).map((view) => view.id)
    }
    const provision = async () => {
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      // The to-fill view (待填写) is the plugin's second view on project sheets; ensured through the same scoped port.
      const todo = await ensureStockPreparationTodoView({ provisioning: multitable.provisioning, projectId, objectId, sheetId: ensured.target.sheetId })
      expect(todo.created).toBe(true)
      return ensured
    }
    const promote = (viewLogicalId: string, overrides: Record<string, unknown> = {}) =>
      multitable.provisioning.promoteObjectViewToFirst({ projectId, objectId, viewLogicalId, ...overrides })

    beforeAll(async () => {
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => { ;(req as any).user = ADMIN; next() })
      app.use('/api/multitable', univerMetaRouter())
      pinned.setApp(app)
      multitable = createProductionPluginContext().api.multitable
      expect(typeof multitable.provisioning.promoteObjectViewToFirst).toBe('function')
      expect(typeof multitable.provisioning.describeObjectSheetLayout).toBe('function')
      const ensured = await provision()
      sheetId = ensured.target.sheetId
      const ids = (await viewRows()).map((row) => row.id)
      for (const id of [DEFAULT, FILL, TODO]) expect(ids).toContain(id)
    }, 120_000)

    afterAll(async () => {
      if (fenceBefore === undefined) delete process.env[FENCE_ENV]
      else process.env[FENCE_ENV] = fenceBefore
      __resetRecoveryWriterStateColumnProbe()
      if (!sheetId) return
      await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_view_personal_configs WHERE view_id IN (SELECT id FROM meta_views WHERE sheet_id = $1)', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM field_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
    })

    test('BI5-RD-01 prep-fill becomes views[0] of /context and GET /views; only its created_at moved; the repeat is alreadyFirst', async () => {
      // Distinct timestamps, the default view first (the state of a sheet the plugin provisioned in separate transactions).
      await q(`UPDATE meta_views SET created_at = CASE id WHEN $2 THEN timestamptz '2026-01-01 00:00:00+00' WHEN $3 THEN timestamptz '2026-01-01 00:00:01+00' ELSE timestamptz '2026-01-01 00:00:02+00' END WHERE sheet_id = $1`, [sheetId, DEFAULT, FILL])
      expect((await contextFirst())[0]).toBe(DEFAULT)
      const before = byId(await viewRows())

      expect(await promote('prep-fill')).toEqual({ promoted: true, alreadyFirst: false, missing: false })

      expect((await contextFirst())[0]).toBe(FILL)
      expect((await listFirst())[0]).toBe(FILL)
      const after = byId(await viewRows())
      expect([...after.keys()]).toEqual([...before.keys()])
      for (const [id, row] of after) {
        const was = before.get(id)!
        if (id === FILL) {
          const min = Math.min(...[...before.values()].map((v) => v.created_at!.getTime()))
          expect(row.created_at!.getTime()).toBeLessThan(min)
          const { created_at: _a, ...rest } = row
          const { created_at: _b, ...restWas } = was
          expect(rest).toEqual(restWas)
        } else {
          expect(row).toEqual(was)
        }
      }

      expect(await promote('prep-fill')).toEqual({ promoted: false, alreadyFirst: true, missing: false })
      expect(byId(await viewRows())).toEqual(after)
    })

    test('BI5-RD-02 a re-ensure of the plugin views keeps the promotion (ensureView never touches created_at)', async () => {
      const before = byId(await viewRows()).get(FILL)!.created_at!.getTime()
      await provision()
      const rows = byId(await viewRows())
      expect(rows.get(FILL)!.created_at!.getTime()).toBe(before)
      expect((await contextFirst())[0]).toBe(FILL)
      expect(await promote('prep-fill')).toEqual({ promoted: false, alreadyFirst: true, missing: false })
    })

    test('BI5-RD-03 template-installed ties: a view tied AT the minimum is still moved strictly first', async () => {
      await q(`UPDATE meta_views SET created_at = timestamptz '2026-06-01 08:00:00+00' WHERE sheet_id = $1`, [sheetId])
      expect(await promote('prep-todo')).toEqual({ promoted: true, alreadyFirst: false, missing: false })
      const rows = await viewRows()
      const todo = rows.find((row) => row.id === TODO)!
      for (const row of rows) if (row.id !== TODO) expect(todo.created_at!.getTime()).toBeLessThan(row.created_at!.getTime())
      expect((await contextFirst())[0]).toBe(TODO)
      expect((await listFirst())[0]).toBe(TODO)
      // And back to prep-fill: strictly before the promoted prep-todo.
      expect(await promote('prep-fill')).toEqual({ promoted: true, alreadyFirst: false, missing: false })
      expect((await contextFirst())[0]).toBe(FILL)
    })

    test('BI5-RD-04 refusals and absence: default, an unprovisioned id, the overview object, a foreign namespace — nothing written', async () => {
      const before = await viewRows()
      const refused = await promote('default').then(() => null, (e: unknown) => e)
      expect((refused as { code?: string }).code).toBe(VIEW_LANDING_INPUT_INVALID_CODE)
      expect(await promote('not-provisioned')).toEqual({ promoted: false, alreadyFirst: false, missing: true })
      await expect(multitable.provisioning.promoteObjectViewToFirst({ projectId, objectId: 'plm_stock_preparation_project_overview', viewLogicalId: 'prep-fill' }))
        .rejects.toBeInstanceOf(StockPreparationOverviewStructureWriteError)
      await expect(multitable.provisioning.promoteObjectViewToFirst({ projectId: `${tenantId}:after-sales`, objectId, viewLogicalId: 'prep-fill' }))
        .rejects.toBeInstanceOf(MultitableProjectNamespaceError)
      await expect(multitable.provisioning.describeObjectSheetLayout({ projectId, objectId: 'plm_stock_preparation_project_overview', candidateViewLogicalIds: [], leftInsertCount: 0 }))
        .rejects.toBeInstanceOf(StockPreparationOverviewStructureWriteError)
      expect(await viewRows()).toEqual(before)
    })

    test('BI5-RD-05 the durable writer block refuses the promotion with the fence flag on; created_at untouched', async () => {
      await q(`UPDATE meta_views SET created_at = timestamptz '2026-06-01 08:00:00+00' WHERE sheet_id = $1`, [sheetId])
      const before = await viewRows()
      process.env[FENCE_ENV] = 'true'
      __resetRecoveryWriterStateColumnProbe()
      // 'applying' (a recovery in flight) — the durable block state that carries no owner tuple.
      await q(`UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1`, [sheetId])
      try {
        await expect(promote('prep-fill')).rejects.toBeInstanceOf(SheetWriterBlockedError)
        expect(await viewRows()).toEqual(before)
      } finally {
        await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = $1', [sheetId])
      }
      try {
        // Unblocked, the same call with the fence on goes through.
        expect(await promote('prep-fill')).toEqual({ promoted: true, alreadyFirst: false, missing: false })
      } finally {
        if (fenceBefore === undefined) delete process.env[FENCE_ENV]
        else process.env[FENCE_ENV] = fenceBefore
      }
    })

    test('BI5-RD-06 describe: counts over the real sheet (frozen prefix, personal orders, trash), values-free', async () => {
      // Self-contained: distinct timestamps with the default view first, then prep-fill promoted.
      await q(`UPDATE meta_views SET created_at = CASE id WHEN $2 THEN timestamptz '2026-01-01 00:00:00+00' ELSE timestamptz '2026-01-01 00:00:05+00' END WHERE sheet_id = $1`, [sheetId, DEFAULT])
      expect((await multitable.provisioning.describeObjectSheetLayout({ projectId, objectId, candidateViewLogicalIds: ['prep-fill'], leftInsertCount: 0 })).firstView).toBe('default')
      expect((await promote('prep-fill')).promoted).toBe(true)
      const views = await viewRows()
      const viewCount = views.length
      // The default view's first visible column, in the shared order the grid renders.
      const defaultView = views.find((row) => row.id === DEFAULT)!
      const hidden = new Set(Array.isArray(defaultView.hidden_field_ids) ? (defaultView.hidden_field_ids as string[]) : [])
      const fields = (await q('SELECT id, property FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC', [sheetId])).rows as Array<{ id: string; property: Record<string, unknown> | null }>
      const visible = fields.filter((f) => !hidden.has(f.id) && f.property?.hidden !== true && f.property?.visible !== false)
      expect(visible.length).toBeGreaterThan(1)
      // Freeze the first visible column of the default view; on prep-todo freeze a column that is NOT its left prefix.
      await q(`UPDATE meta_views SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{frozenLeftColumnIds}', $2::jsonb) WHERE id = $1`, [DEFAULT, JSON.stringify([visible[0].id])])
      await q(`UPDATE meta_views SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{frozenLeftColumnIds}', $2::jsonb) WHERE id = $1`, [TODO, JSON.stringify(['fld_not_on_this_sheet'])])
      // Personal configs: one with a non-empty fieldOrder (counted), one empty, one without fieldOrder.
      await q('INSERT INTO meta_view_personal_configs (view_id, user_id, config) VALUES ($1, $2, $3::jsonb), ($1, $4, $5::jsonb), ($6, $2, $7::jsonb)', [
        DEFAULT, `u_bi5_a_${TOKEN}`, JSON.stringify({ fieldOrder: [visible[1].id, visible[0].id] }),
        `u_bi5_b_${TOKEN}`, JSON.stringify({ fieldOrder: [] }),
        FILL, JSON.stringify({ filterInfo: {} }),
      ])
      await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1, $2, $3::jsonb)', [`rec_bi5_${TOKEN}`, sheetId, '{}'])

      const got = await multitable.provisioning.describeObjectSheetLayout({ projectId, objectId, candidateViewLogicalIds: ['prep-fill', 'prep-todo'], leftInsertCount: 2 })
      expect(got).toEqual({
        viewCount,
        firstView: 'prep-fill',
        viewsWithFrozenColumns: 1,
        viewsLosingFrozen: 1,
        personalOrderOverrides: 1,
        trashedRecordCount: 1,
      })
      expect(Object.keys(got).sort()).toEqual([...DESCRIBE_LAYOUT_RESULT_KEYS])
      const text = JSON.stringify(got)
      for (const row of views) {
        expect(text).not.toContain(row.id)
        expect(text).not.toContain(row.name)
      }
      for (const field of fields) expect(text).not.toContain(field.id)

      const noInsert = await multitable.provisioning.describeObjectSheetLayout({ projectId, objectId, candidateViewLogicalIds: [], leftInsertCount: 0 })
      expect(noInsert.viewsWithFrozenColumns).toBe(1)
      expect(noInsert.viewsLosingFrozen).toBe(0)
      expect(noInsert.firstView).toBe('other')
    })
  })
}
