/**
 * 备料 「查看子件」 / 「查看所有使用位置」 — real-Postgres proof of the two host halves (owner question 2026-11-07):
 *   - /context `capabilities.stockPreparationBomRelations`: the five physical column ids, on a sheet the REAL plugin
 *     provisioned (the real field-id derivation, the real template stanza), for a READ-ONLY actor; absent on an
 *     ordinary sheet and when the actor cannot read one of the columns;
 *   - GET /view `viewerFilter` (multitable/viewer-filter.ts): ANDed onto the stored filter for one read, on columns the
 *     view HIDES, never stored — the response's `view.filterInfo` and the meta_views row are unchanged — and refused
 *     (one fixed message) when malformed, blank, or on a column the actor may not read; view-aggregate totals the same set.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationBomRelationsRealDbCases()` registers its `describe`
 * block and is called from the already-wired real-DB file tests/integration/multitable-record-duplicate.test.ts (the
 * "Run multitable real-DB integration" step of .github/workflows/plugin-tests.yml names it). Do NOT also list a
 * standalone file for these cases.
 *
 *   BR-RD-01 /context: block for a read-only actor with the derived ids; no block on an ordinary sheet; no block when a
 *            column is field-permission hidden from the actor.
 *   BR-RD-02 子件 (parentSourceId is P-07's id) on the fill view (有效 only, both id columns hidden in the view): the
 *            active children only; on the unfiltered view (全部记录) the inactive child too.
 *   BR-RD-03 使用位置 (componentSourceId is X's id): every position of X, each with its own parent.
 *   BR-RD-04 never stored: `data.view.filterInfo` equals the stored filter; meta_views row (filter_info, updated_at)
 *            byte-identical after the reads; without the parameter the response rows are the view's own.
 *   BR-RD-05 refusals: malformed / blank value / another operator → 400 Invalid viewer filter; a field-permission
 *            hidden column or an unknown id → 400 with the GET /records message, naming no field.
 *   BR-RD-06 view-aggregate: the footer count equals the filtered row count, and a blank value is refused there too.
 * Values-free: every id and value is synthetic and per-run (S-01 / P-07 / X).
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
const { ensureStockPreparationSandboxTarget } = require(path.join(PLUGIN_LIB, 'stock-preparation-target-provisioning.cjs')) as any
const ownBaseLib = require(path.join(PLUGIN_LIB, 'stock-preparation-own-base.cjs')) as any
/* eslint-enable @typescript-eslint/no-explicit-any */

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'bom-relations-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-bom-relations',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

export function defineStockPreparationBomRelationsRealDbCases(): void {
  test('bom relations real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the bom-relations real-DB cases would skip-green')
    }
  })

  describeIfDatabase('stock-prep drawer BOM relations (real Postgres, real provisioning, real host routes)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const tenantId = `tenant_bomrel_${TOKEN}`
    const projectId = `${tenantId}:integration-core`
    const READER = { id: `u_bomrel_reader_${TOKEN}`, roles: ['member'], perms: ['multitable:read'] }
    let actor: { id: string; roles: string[]; perms: string[] } = READER
    const pinned = usePinnedServer()
    const http = () => request(pinned.url())

    let sheetId = ''
    let fields: Record<string, string> = {}
    const ORDINARY_SHEET = `sheet_bomrel_plain_${TOKEN}`
    const ORDINARY_BASE = `base_bomrel_plain_${TOKEN}`
    const V_FILL = `view_bomrel_fill_${TOKEN}`
    const V_ALL = `view_bomrel_all_${TOKEN}`
    const rec = (label: string) => `rec_bomrel_${label}_${TOKEN}`
    const phys = (logical: string) => {
      const id = fields[logical]
      if (!id) throw new Error(`no physical id for ${logical}`)
      return id
    }
    // Synthetic BOM: P-07 has children S-01 (active), S-02 (inactive) and X; X is ALSO used under S-01.
    const SRC = { p07: `SRC-P07-${TOKEN}`, s01: `SRC-S01-${TOKEN}`, s02: `SRC-S02-${TOKEN}`, x: `SRC-X-${TOKEN}` }
    const rows: Array<{ label: string; source: string; parent: string | null; code: string; active: boolean }> = [
      { label: 'p07', source: SRC.p07, parent: null, code: 'P-07', active: true },
      { label: 's01', source: SRC.s01, parent: SRC.p07, code: 'S-01', active: true },
      { label: 's02', source: SRC.s02, parent: SRC.p07, code: 'S-02', active: false },
      { label: 'x_under_p07', source: SRC.x, parent: SRC.p07, code: 'X', active: true },
      { label: 'x_under_s01', source: SRC.x, parent: SRC.s01, code: 'X', active: true },
    ]
    let fillFilterInfo: Record<string, unknown> = {}

    const viewerFilter = (conditions: unknown[]) => JSON.stringify({ conditions })
    const childrenOf = (source: string) => viewerFilter([{ fieldId: phys('parentSourceId'), operator: 'is', value: source }])
    const positionsOf = (source: string) => viewerFilter([{ fieldId: phys('componentSourceId'), operator: 'is', value: source }])
    const view = (viewId: string, extra: Record<string, string> = {}) =>
      http().get('/api/multitable/view').query({ sheetId, viewId, limit: 50, offset: 0, ...extra })
    const ids = (res: request.Response) => ((res.body?.data?.rows ?? []) as Array<{ id: string }>).map((r) => r.id).sort()
    const viewRow = async (id: string) => (await q('SELECT filter_info, hidden_field_ids, updated_at FROM meta_views WHERE id = $1', [id])).rows[0]

    beforeAll(async () => {
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => { ;(req as any).user = actor; next() })
      app.use('/api/multitable', univerMetaRouter())
      pinned.setApp(app)

      const projectNo = `SYN-BOMREL-${TOKEN}`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const multitable: any = createProductionPluginContext().api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      sheetId = ensured.target.sheetId
      fields = { ...ensured.target.fieldIdMap }

      for (const row of rows) {
        const data: Record<string, unknown> = {
          [phys('componentSourceId')]: row.source,
          [phys('componentCode')]: row.code,
          [phys('componentName')]: `Synthetic ${row.code}`,
          [phys('active')]: row.active,
        }
        if (row.parent) data[phys('parentSourceId')] = row.parent
        await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [rec(row.label), sheetId, JSON.stringify(data)])
      }
      fillFilterInfo = { conjunction: 'and', conditions: [{ fieldId: phys('active'), operator: 'is', value: true }] }
      await q(
        'INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, sort_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
        [V_FILL, sheetId, 'fill', 'grid', JSON.stringify([phys('componentSourceId'), phys('parentSourceId')]), JSON.stringify(fillFilterInfo), JSON.stringify({ rules: [] }), '{}'],
      )
      await q(
        'INSERT INTO meta_views (id, sheet_id, name, type, hidden_field_ids, filter_info, sort_info, config) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
        [V_ALL, sheetId, 'all', 'grid', '[]', '{}', JSON.stringify({ rules: [] }), '{}'],
      )

      await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [ORDINARY_BASE, 'BOMREL plain'])
      await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [ORDINARY_SHEET, ORDINARY_BASE, 'BOMREL plain'])
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [`fld_bomrel_plain_${TOKEN}`, ORDINARY_SHEET, 'PLM 物料ID', 'string', '{}', 1])
    }, 120_000)

    afterAll(async () => {
      for (const id of [sheetId, ORDINARY_SHEET].filter(Boolean)) {
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [id]).catch(() => {})
        await q('DELETE FROM field_permissions WHERE sheet_id = $1', [id]).catch(() => {})
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [id]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [id]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [id]).catch(() => {})
        await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [id]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [id]).catch(() => {})
      }
      await q('DELETE FROM meta_bases WHERE id = $1', [ORDINARY_BASE]).catch(() => {})
    })

    test('BR-RD-01 /context: the derived ids for a read-only actor; none on an ordinary sheet or when a column is hidden from the actor', async () => {
      actor = READER
      const res = await http().get('/api/multitable/context').query({ sheetId })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(res.body.data.capabilities.canEditRecord).not.toBe(true)
      expect(res.body.data.capabilities.stockPreparationBomRelations).toEqual({
        componentSourceFieldId: phys('componentSourceId'),
        parentSourceFieldId: phys('parentSourceId'),
        activeFieldId: phys('active'),
        componentCodeFieldId: phys('componentCode'),
        componentNameFieldId: phys('componentName'),
      })

      const plain = await http().get('/api/multitable/context').query({ sheetId: ORDINARY_SHEET })
      expect(plain.status).toBe(200)
      expect('stockPreparationBomRelations' in plain.body.data.capabilities).toBe(false)

      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [sheetId, phys('parentSourceId'), 'user', READER.id, false, true])
      try {
        const hidden = await http().get('/api/multitable/context').query({ sheetId })
        expect(hidden.status).toBe(200)
        expect('stockPreparationBomRelations' in hidden.body.data.capabilities).toBe(false)
      } finally {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [sheetId, READER.id])
      }
    })

    test('BR-RD-02 子件 on the fill view: active children only, through columns the view hides; the unfiltered view adds the inactive one', async () => {
      actor = READER
      const fill = await view(V_FILL, { viewerFilter: childrenOf(SRC.p07) })
      expect(fill.status, JSON.stringify(fill.body)).toBe(200)
      expect(ids(fill)).toEqual([rec('s01'), rec('x_under_p07')].sort())
      expect(fill.body.data.page.total).toBe(2)

      const all = await view(V_ALL, { viewerFilter: childrenOf(SRC.p07) })
      expect(all.status).toBe(200)
      expect(ids(all)).toEqual([rec('s01'), rec('s02'), rec('x_under_p07')].sort())

      // A leaf part has no children: an empty result, not an error.
      const leaf = await view(V_ALL, { viewerFilter: childrenOf(SRC.s02) })
      expect(leaf.status).toBe(200)
      expect(ids(leaf)).toEqual([])
    })

    test('BR-RD-03 使用位置: every position of X in this sheet, each with its own parent', async () => {
      actor = READER
      const res = await view(V_FILL, { viewerFilter: positionsOf(SRC.x) })
      expect(res.status).toBe(200)
      expect(ids(res)).toEqual([rec('x_under_p07'), rec('x_under_s01')].sort())
      const parents = (res.body.data.rows as Array<{ data: Record<string, unknown> }>).map((r) => r.data[phys('parentSourceId')]).sort()
      expect(parents).toEqual([SRC.p07, SRC.s01].sort())
    })

    test('BR-RD-04 never stored: the response view keeps the stored filter and the meta_views row is untouched', async () => {
      actor = READER
      const before = await viewRow(V_FILL)
      const plain = await view(V_FILL)
      const filtered = await view(V_FILL, { viewerFilter: childrenOf(SRC.p07) })
      expect(filtered.status).toBe(200)
      expect(filtered.body.data.view.filterInfo).toEqual(plain.body.data.view.filterInfo)
      expect(filtered.body.data.view.filterInfo).toEqual(fillFilterInfo)
      expect(filtered.body.data.view.hiddenFieldIds).toEqual(plain.body.data.view.hiddenFieldIds)
      const after = await viewRow(V_FILL)
      expect(after).toEqual(before)
      // Without the parameter the view's own rows (every active row) come back — the narrowing did not stick.
      expect(ids(await view(V_FILL))).toEqual([rec('p07'), rec('s01'), rec('x_under_p07'), rec('x_under_s01')].sort())
    })

    test('BR-RD-05 refusals: malformed, blank, another operator, a hidden-from-actor column, an unknown id', async () => {
      actor = READER
      for (const bad of [
        '{nope',
        viewerFilter([{ fieldId: phys('parentSourceId'), operator: 'is', value: '' }]),
        viewerFilter([{ fieldId: phys('parentSourceId'), operator: 'is', value: '  ' }]),
        viewerFilter([{ fieldId: phys('parentSourceId'), operator: 'contains', value: SRC.p07 }]),
      ]) {
        const res = await view(V_ALL, { viewerFilter: bad })
        expect(res.status, bad).toBe(400)
        expect(res.body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'Invalid viewer filter' })
      }
      const unknown = await view(V_ALL, { viewerFilter: viewerFilter([{ fieldId: `fld_missing_${TOKEN}`, operator: 'is', value: 'x' }]) })
      expect(unknown.status).toBe(400)
      expect(unknown.body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'Field not permitted for filter/sort' })

      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [sheetId, phys('parentSourceId'), 'user', READER.id, false, true])
      try {
        const denied = await view(V_ALL, { viewerFilter: childrenOf(SRC.p07) })
        expect(denied.status).toBe(400)
        expect(denied.body.error).toEqual(unknown.body.error)
      } finally {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [sheetId, READER.id])
      }
    })

    test('BR-RD-06 view-aggregate totals the same narrowed set, and refuses the same way', async () => {
      actor = READER
      const agg = await http().get(`/api/multitable/sheets/${sheetId}/view-aggregate`).query({ viewId: V_FILL, viewerFilter: childrenOf(SRC.p07) })
      expect(agg.status, JSON.stringify(agg.body)).toBe(200)
      expect(agg.body.data.total).toBe(2)
      const plain = await http().get(`/api/multitable/sheets/${sheetId}/view-aggregate`).query({ viewId: V_FILL })
      expect(plain.status).toBe(200)
      expect(plain.body.data.total).toBe(4)
      const blank = await http().get(`/api/multitable/sheets/${sheetId}/view-aggregate`)
        .query({ viewId: V_FILL, viewerFilter: viewerFilter([{ fieldId: phys('parentSourceId'), operator: 'is', value: ' ' }]) })
      expect(blank.status).toBe(400)
    })
  })
}
