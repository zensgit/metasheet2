/**
 * 人工补充行 B2 — real-Postgres proof of the HOST half of ADR adr-stock-prep-manual-rows-20261030 (§8 「B2 主机」 8 and
 * 11): the three manual-row routes, the amended R-66 ① delete exemption, the switch and /context, on a project sheet the
 * REAL plugin provisioned (the frozen template, the real field-id derivation, the real PLM column lock, the real plugin
 * registry row of migration 087) and the real univer-meta router.
 *
 * This is a CASES MODULE, not a test file: `defineStockPreparationManualRowsHostRealDbCases()` registers its `describe`
 * block and is called from the already-wired real-DB file tests/integration/multitable-record-duplicate.test.ts (the
 * file ADR §8 names; vitest.config.ts excludes it from the no-DB job, and the "Run multitable real-DB integration" step
 * of .github/workflows/plugin-tests.yml names it). Do NOT also list a standalone file for these cases.
 *
 *   MR2-RD-01 新增: 200; the stamps in the stored row (项目号 from the 087 row, `manual:v1:<own id>`, 有效 = true),
 *             created_by = the actor, no identity / RUN column, one create revision; the create echo masks a column the
 *             actor's field_permissions hide while the stored row keeps it (the egress locking case).
 *   MR2-RD-02 the server-written columns: 唯一键 / 项目号 / 有效 / PLM 物料ID / 父组件图号 → 403 FIELD_READONLY_PLM_SYSTEM.
 *   MR2-RD-03 refused BEFORE any write: the switch disabled (written through the real provisioning port — a junk value
 *             reads back as 'disabled' from meta_fields), a sheet without the PLM lock, an archived project, the
 *             deployment switch off, the plugin registry unreadable (a renamed column: 42703 → 503) — and 42P01 (a renamed
 *             table) = not registered (409 not_project_sheet, /context without the block).
 *   MR2-RD-04 复制为新行 of a PLM row: the six + 备料计划 copied; identity / RUN, the lineage pair, 进度与回复 never.
 *   MR2-RD-05 修改: only the six (outside → 400); version + 1; the generic /patch still refuses the six on that row.
 *   MR2-RD-06 删除 / 恢复: the manual row deletes and restores; a PLM row and a prefix row without a creator stay refused.
 *   MR2-RD-06b the in-transaction re-check runs AFTER the sheet fence: a second connection holds the fence and turns the
 *             switch off; the waiting create sees the committed 'disabled' (409, nothing written).
 *   MR2-RD-07 the person field routes cannot touch the switch: PATCH /fields keeps the stored value.
 *   MR2-RD-08 /context: the block is `allowed` with the six editable ids, then `disabled` after the switch.
 * Values-free: every id is synthetic and per-run.
 */
import { createRequire } from 'module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import { Client } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
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
/* eslint-enable @typescript-eslint/no-explicit-any */

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
const TARGET_TABLE = 'integration_stock_prep_project_target'

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'manual-rows-host-realdb' },
    plugin: { activate: async () => {} },
    path: 'realdb://stock-preparation-manual-rows-host',
    loadedAt: new Date(),
  }
  return (server as unknown as { createPluginContext: (plugin: LoadedPlugin) => PluginContext }).createPluginContext(loaded)
}

export function defineStockPreparationManualRowsHostRealDbCases(): void {
  test('manual rows B2 real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the manual-rows B2 real-DB cases would skip-green')
    }
  })

  describeIfDatabase('stock-prep manual supplementary rows B2 (real Postgres, real provisioning, real host routes)', () => {
    const TOKEN = `${process.pid}_${Date.now().toString(36)}`
    const tenantId = `tenant_mrb2_${TOKEN}`
    const projectId = `${tenantId}:integration-core`
    const WRITER = { id: `u_mrb2_writer_${TOKEN}`, roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
    const ADMIN = { id: `u_mrb2_admin_${TOKEN}`, roles: ['admin'], perms: [] as string[] }
    let actor: { id: string; roles: string[]; perms: string[] } = WRITER
    const sheets: string[] = []
    const switchBefore = process.env[SWITCH]

    type Stack = { projectNo: string; sheetId: string; objectId: string; fields: Record<string, string>; multitable: any }
    let main: Stack
    let unlocked: Stack
    let registry: any

    const pinned = usePinnedServer()
    const http = () => request(pinned.url())
    const phys = (stack: Stack, logical: string) => {
      const id = stack.fields[logical]
      if (!id) throw new Error(`no physical id for ${logical}`)
      return id
    }
    const row = async (id: string) => (await q('SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1', [id])).rows[0] as
      | { id: string; sheet_id: string; version: number; data: Record<string, unknown>; created_by: string | null }
      | undefined
    const rowCount = async (stack: Stack) => Number(((await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1', [stack.sheetId])).rows[0] as { n: number }).n)
    const keyProperty = async (stack: Stack) => ((await q('SELECT property FROM meta_fields WHERE sheet_id = $1 AND id = $2', [stack.sheetId, phys(stack, 'idempotencyKey')])).rows[0] as { property: Record<string, unknown> }).property
    const create = (stack: Stack, data: Record<string, unknown>) => http().post(`/api/multitable/sheets/${stack.sheetId}/manual-rows`).send({ data })
    const minimal = (stack: Stack, extra: Record<string, unknown> = {}) => ({ [phys(stack, 'componentName')]: 'Synthetic manual part', [phys(stack, 'totalQuantity')]: 3, ...extra })
    const setSwitch = (stack: Stack, value: unknown) =>
      stack.multitable.provisioning.patchObjectFieldProperty({ projectId, objectId: stack.objectId, fieldId: 'idempotencyKey', propertyPatch: { stockPreparationManualRows: value } })

    async function provision(label: string, { lock }: { lock: boolean }): Promise<Stack> {
      const projectNo = `SYN-MRB2-${label.toUpperCase()}-${TOKEN}`
      const objectId: string = ownBaseLib.deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
      const pluginContext = createProductionPluginContext()
      const multitable: any = pluginContext.api.multitable
      const ensured = await ensureStockPreparationSandboxTarget({ context: { api: { multitable } }, projectId, permission: 'admin', objectId })
      expect(ensured.ready).toBe(true)
      await syncStockPreparationContractOptionsForObject({ provisioning: multitable.provisioning, projectId, objectId })
      if (lock) await projectTargetsLib.markProjectSheetPlmSystemColumns({ provisioning: multitable.provisioning, projectId, objectId })
      const sheetId: string = ensured.target.sheetId
      sheets.push(sheetId)
      registry = projectTargetStoreLib.createStockPreparationProjectTargetStore({ db: createDb({ database: pluginContext.api.database }) })
      await registry.create({ tenantId, projectNo, sheetId, objectId, createdBy: 'syn' })
      return { projectNo, sheetId, objectId, fields: { ...ensured.target.fieldIdMap }, multitable }
    }

    beforeAll(async () => {
      process.env[SWITCH] = 'true'
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => { ;(req as any).user = actor; next() })
      app.use('/api/multitable', univerMetaRouter())
      pinned.setApp(app)
      main = await provision('main', { lock: true })
      unlocked = await provision('unlocked', { lock: false })
    }, 120_000)

    afterAll(async () => {
      if (switchBefore === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = switchBefore
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM field_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
      await q(`DELETE FROM ${TARGET_TABLE} WHERE tenant_id = $1`, [tenantId]).catch(() => {})
      await q('DELETE FROM integration_stock_prep_audit WHERE tenant_id = $1', [tenantId]).catch(() => {})
    })

    test('MR2-RD-01 新增: the stamps, the creator, no identity column, one create revision; the echo masks a hidden column the row keeps', async () => {
      actor = WRITER
      // The actor may not SEE 项目号: the server still stamps it, and the create echo must not hand it back (a hidden column
      // is never writable for the actor either — the shared isFieldWriteForbidden rule — so the stamp is the only way such
      // a value reaches this row).
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [main.sheetId, phys(main, 'projectNo'), 'user', WRITER.id, false, false])
      try {
        const res = await create(main, minimal(main, { [phys(main, 'componentCode')]: 'SYN-DRAWING-RD1', [phys(main, 'notes')]: 'synthetic note' }))
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const id = res.body.data.record.id as string
        const stored = (await row(id))!
        expect(stored.created_by).toBe(WRITER.id)
        expect(stored.data[phys(main, 'projectNo')]).toBe(main.projectNo)
        expect(stored.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
        expect(stored.data[phys(main, 'active')]).toBe(true)
        expect(stored.data[phys(main, 'componentCode')]).toBe('SYN-DRAWING-RD1')
        expect(stored.data[phys(main, 'notes')]).toBe('synthetic note')
        for (const logical of ['componentSourceId', 'parentSourceId', 'path', 'depth', 'sourceVersion', 'lastPlmRefreshRunId', 'parentComponentCode', 'parentComponentName']) {
          expect(phys(main, logical) in stored.data, logical).toBe(false)
        }
        expect(phys(main, 'projectNo') in res.body.data.record.data).toBe(false)
        expect(res.body.data.record.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
        const revisions = (await q("SELECT action FROM meta_record_revisions WHERE record_id = $1", [id])).rows as Array<{ action: string }>
        expect(revisions.map((r) => r.action)).toEqual(['create'])
      } finally {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [main.sheetId, WRITER.id])
      }
    })

    test('MR2-RD-02 the server-written columns answer 403 FIELD_READONLY_PLM_SYSTEM; nothing written', async () => {
      actor = WRITER
      const before = await rowCount(main)
      for (const logical of ['idempotencyKey', 'projectNo', 'active', 'componentSourceId', 'parentComponentCode']) {
        const res = await create(main, minimal(main, { [phys(main, logical)]: logical === 'active' ? false : 'SYN-FORGED' }))
        expect(res.status, `${logical}: ${JSON.stringify(res.body)}`).toBe(403)
        expect(res.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
        expect(res.body.error.fieldIds).toEqual([phys(main, logical)])
      }
      expect(await rowCount(main)).toBe(before)
    })

    test('MR2-RD-03 refused before any write: disabled (real provisioning write, junk → disabled), no lock, archived, deployment switch off, registry unreadable; 42P01 = not registered', async () => {
      actor = WRITER
      const expectRefused = async (stack: Stack, status: number, reason: string) => {
        const before = await rowCount(stack)
        const res = await create(stack, minimal(stack))
        expect(res.status, `${reason}: ${JSON.stringify(res.body)}`).toBe(status)
        expect(res.body.error.details).toEqual({ reason })
        expect(await rowCount(stack)).toBe(before)
      }
      // The switch, through the plugin's own write port: a junk value is stored NORMALIZED.
      await setSwitch(main, 'nope')
      expect((await keyProperty(main)).stockPreparationManualRows).toBe('disabled')
      await expectRefused(main, 409, 'disabled')
      await setSwitch(main, 'allowed')
      expect((await keyProperty(main)).stockPreparationManualRows).toBe('allowed')
      // A sheet the lock never reached.
      await expectRefused(unlocked, 409, 'lock_missing')
      // An archived project (the store's own transition), then restored.
      await registry.archive({ tenantId, projectNo: main.projectNo, actorId: 'syn' })
      try {
        await expectRefused(main, 409, 'project_archived')
      } finally {
        await registry.restore({ tenantId, projectNo: main.projectNo, actorId: 'syn' })
      }
      // The deployment switch.
      process.env[SWITCH] = 'TRUE'
      try {
        await expectRefused(main, 409, 'project_sheets_off')
      } finally {
        process.env[SWITCH] = 'true'
      }
      // The plugin registry unreadable: a column the fixed statement reads is missing → 42703 → 503 (fail closed).
      await q(`ALTER TABLE ${TARGET_TABLE} RENAME COLUMN tenant_id TO tenant_id_mrb2_probe`)
      try {
        await expectRefused(main, 503, 'registry_unreadable')
        const ctx = await http().get('/api/multitable/context').query({ sheetId: main.sheetId })
        expect(ctx.body.data.capabilities.stockPreparationManualRows).toMatchObject({ state: 'unavailable', reason: 'registry_unreadable' })
      } finally {
        await q(`ALTER TABLE ${TARGET_TABLE} RENAME COLUMN tenant_id_mrb2_probe TO tenant_id`)
      }
      // 42P01: the table is not there → not registered → the old behaviour (no block; the route refuses as not P_reg).
      await q(`ALTER TABLE ${TARGET_TABLE} RENAME TO ${TARGET_TABLE}_mrb2_probe`)
      try {
        await expectRefused(main, 409, 'not_project_sheet')
        const ctx = await http().get('/api/multitable/context').query({ sheetId: main.sheetId })
        expect(ctx.status).toBe(200)
        expect('stockPreparationManualRows' in ctx.body.data.capabilities).toBe(false)
      } finally {
        await q(`ALTER TABLE ${TARGET_TABLE}_mrb2_probe RENAME TO ${TARGET_TABLE}`)
      }
      // And it works again.
      expect((await create(main, minimal(main))).status).toBe(200)
    })

    test('MR2-RD-04 复制为新行 of a PLM row: the six + 备料计划 copied; identity / RUN, the lineage pair, 进度与回复 never; fresh stamps', async () => {
      actor = WRITER
      const sourceId = `rec_mrb2_plm_${TOKEN}`
      const cells: Record<string, unknown> = {
        projectNo: main.projectNo,
        idempotencyKey: JSON.stringify({ projectNo: main.projectNo, componentSourceId: 'SYN-PART-RD4', parentSourceId: 'SYN-PART-RD0', path: '["SYN-PART-RD0","SYN-PART-RD4"]' }),
        componentSourceId: 'SYN-PART-RD4', parentSourceId: 'SYN-PART-RD0', path: '["SYN-PART-RD0","SYN-PART-RD4"]', depth: 2,
        parentComponentCode: 'SYN-PARENT', parentComponentName: 'Synthetic parent', sourceVersion: 'V1', lastPlmRefreshRunId: 'run_synthetic',
        componentCode: 'SYN-DRAWING-RD4', componentName: 'Synthetic part', componentSpec: 'SYN-SPEC', material: 'SYN-MATERIAL', rawQuantity: 2, totalQuantity: 4,
        active: true, leadTimeDays: 5, demandDate: '2026-11-01', notes: 'synthetic note', procurementReply: 'synthetic reply',
      }
      const data: Record<string, unknown> = {}
      for (const [logical, value] of Object.entries(cells)) data[phys(main, logical)] = value
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)', [sourceId, main.sheetId, JSON.stringify(data)])
      const res = await http().post(`/api/multitable/records/${sourceId}/manual-copy`).send({})
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const copyId = res.body.data.record.id as string
      const copy = (await row(copyId))!
      for (const logical of ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity', 'leadTimeDays', 'demandDate']) {
        expect(copy.data[phys(main, logical)], logical).toEqual(cells[logical])
      }
      for (const logical of ['componentSourceId', 'parentSourceId', 'path', 'depth', 'sourceVersion', 'lastPlmRefreshRunId', 'parentComponentCode', 'parentComponentName', 'notes', 'procurementReply']) {
        expect(phys(main, logical) in copy.data, logical).toBe(false)
      }
      expect(copy.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${copyId}`)
      expect(copy.data[phys(main, 'projectNo')]).toBe(main.projectNo)
      expect(copy.created_by).toBe(WRITER.id)
      expect((await row(sourceId))!.version).toBe(1)
    })

    test('MR2-RD-05 修改: only the six; version + 1; the generic /patch still refuses the six on the same row', async () => {
      actor = WRITER
      const created = await create(main, minimal(main))
      const id = created.body.data.record.id as string
      const ok = await http().patch(`/api/multitable/records/${id}/manual-fields`).send({ data: { [phys(main, 'componentName')]: 'Renamed', [phys(main, 'rawQuantity')]: 7 }, expectedVersion: 1 })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      const after = (await row(id))!
      expect(after.version).toBe(2)
      expect(after.data[phys(main, 'componentName')]).toBe('Renamed')
      expect(after.data[phys(main, 'rawQuantity')]).toBe(7)
      expect(after.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
      const outside = await http().patch(`/api/multitable/records/${id}/manual-fields`).send({ data: { [phys(main, 'notes')]: 'x' } })
      expect(outside.status).toBe(400)
      expect(outside.body.error.code).toBe('STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE')
      const generic = await http().post('/api/multitable/patch').send({ sheetId: main.sheetId, changes: [{ recordId: id, fieldId: phys(main, 'componentName'), value: 'X' }] })
      expect(generic.status).toBe(403)
      expect(generic.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
      expect((await row(id))!.data[phys(main, 'componentName')]).toBe('Renamed')
    })

    test('MR2-RD-06 删除 / 恢复 (the amended R-66 ①): the manual row deletes for a writer and restores; a PLM row and a prefix row without a creator stay refused for an admin', async () => {
      actor = WRITER
      const created = await create(main, minimal(main))
      const id = created.body.data.record.id as string
      const del = await http().delete(`/api/multitable/records/${id}`)
      expect(del.status, JSON.stringify(del.body)).toBe(200)
      expect(await row(id)).toBeUndefined()
      const restored = await http().post(`/api/multitable/records/${id}/restore`).send({})
      expect(restored.status, JSON.stringify(restored.body)).toBe(200)
      const back = (await row(id))!
      expect(back.created_by).toBe(WRITER.id)
      expect(back.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${id}`)

      actor = ADMIN
      const noCreatorId = `rec_mrb2_nocreator_${TOKEN}`
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1, $2, $3::jsonb, 1)',
        [noCreatorId, main.sheetId, JSON.stringify({ [phys(main, 'idempotencyKey')]: `manual:v1:${noCreatorId}`, [phys(main, 'componentName')]: 'SYN' })])
      for (const refusedId of [noCreatorId, `rec_mrb2_plm_${TOKEN}`]) {
        const res = await http().delete(`/api/multitable/records/${refusedId}`)
        expect(res.status, refusedId).toBe(409)
        expect(res.body.error.code).toBe('RECORD_DELETE_REFUSED_PLM_ROW')
        expect(await row(refusedId)).toBeDefined()
      }
      actor = WRITER
    })

    test('MR2-RD-06b conditions 3, 4 and 6 run AFTER the sheet fence: a switch flip committed by the fence holder is seen by the waiting create', async () => {
      // ADR §8 「B2 主机」 4. A second connection holds the sheet's canonical fence (the advisory lock createRecord takes
      // first) and, inside that transaction, turns the switch off. The create's route pre-check still reads 'allowed'
      // (the flip is not committed yet); the create then WAITS on the fence. Only a re-check that runs after the fence,
      // on the transaction's own re-read, sees the committed 'disabled' — before the fence it would read 'allowed' too.
      actor = WRITER
      const keyId = phys(main, 'idempotencyKey')
      const before = await keyProperty(main)
      const rowsBefore = await rowCount(main)
      const holder = new Client({ connectionString: process.env.DATABASE_URL })
      await holder.connect()
      let committed = false
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(main.sheetId)])
        await holder.query(
          `UPDATE meta_fields SET property = jsonb_set(COALESCE(property, '{}'::jsonb), '{stockPreparationManualRows}', '"disabled"'::jsonb) WHERE sheet_id = $1 AND id = $2`,
          [main.sheetId, keyId],
        )
        const pending = create(main, minimal(main)).then((res) => ({ status: res.status, body: res.body }))
        let waiting = 0
        for (let i = 0; i < 200 && waiting === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          waiting = Number(((await q("SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rows[0] as { c: number }).c)
        }
        expect(waiting, 'the create must be waiting on the sheet fence').toBeGreaterThan(0)
        await holder.query('COMMIT')
        committed = true
        const res = await pending
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(409)
        expect(res.body.error.details).toEqual({ reason: 'disabled' })
        expect(await rowCount(main)).toBe(rowsBefore)
      } finally {
        if (!committed) await holder.query('ROLLBACK').catch(() => {})
        await holder.end()
        await q('UPDATE meta_fields SET property = $3::jsonb WHERE sheet_id = $1 AND id = $2', [main.sheetId, keyId, JSON.stringify(before)])
      }
    })

    test('MR2-RD-07 the person field routes cannot change the switch: PATCH /fields keeps the stored value', async () => {
      actor = ADMIN
      await setSwitch(main, 'disabled')
      try {
        // A platform admin may manage fields (R-66 ② clamps everyone else): the PATCH lands — and the switch keeps the
        // STORED value whatever the body says, like the lock.
        const res = await http().patch(`/api/multitable/fields/${phys(main, 'idempotencyKey')}`).send({ property: { ...(await keyProperty(main)), stockPreparationManualRows: 'allowed' } })
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
        const after = await keyProperty(main)
        expect(after.stockPreparationManualRows).toBe('disabled')
        expect(after.humanWriteLock).toBe('plm_system')
      } finally {
        await setSwitch(main, 'allowed')
        actor = WRITER
      }
    })

    test('MR2-RD-08 /context: allowed with the six editable ids, then disabled after the switch', async () => {
      actor = WRITER
      const allowed = await http().get('/api/multitable/context').query({ sheetId: main.sheetId })
      expect(allowed.status).toBe(200)
      expect(allowed.body.data.capabilities.stockPreparationManualRows).toEqual({
        state: 'allowed',
        editableFieldIds: ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity'].map((l) => phys(main, l)),
        requiredFieldIds: [phys(main, 'componentName'), phys(main, 'totalQuantity')],
      })
      await setSwitch(main, 'disabled')
      try {
        const disabled = await http().get('/api/multitable/context').query({ sheetId: main.sheetId })
        expect(disabled.body.data.capabilities.stockPreparationManualRows.state).toBe('disabled')
      } finally {
        await setSwitch(main, 'allowed')
      }
    })
  })
}
