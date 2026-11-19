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
 *   MR2-RD-02 the server-written columns: 唯一键 / 项目号 / 有效 / PLM 物料ID → 403 FIELD_READONLY_PLM_SYSTEM.
 *   MR2-RD-03 refused BEFORE any write: the switch disabled (written through the real provisioning port — a junk value
 *             reads back as 'disabled' from meta_fields), a sheet without the PLM lock, an archived project, the
 *             deployment switch off, the plugin registry unreadable (a renamed column: 42703 → 503) — and 42P01 (a renamed
 *             table) = not registered (409 not_project_sheet, /context without the block).
 *   MR2-RD-04 复制为新行 of a PLM row: the six + 备料计划 copied, and its parent pair (ADR §12.5); identity / RUN and
 *             进度与回复 never.
 *   MR2-RD-05 修改: only the eight the route accepts (outside → 400); version + 1; the generic /patch still refuses the
 *             six on that row.
 *   MR2-RD-06 删除 / 恢复: the manual row deletes and restores; a PLM row and a prefix row without a creator stay refused.
 *   MR2-RD-06b the in-transaction re-check runs AFTER the sheet fence: a second connection holds the fence and turns the
 *             switch off; the waiting create sees the committed 'disabled' (409, nothing written).
 *   MR2-RD-07 the person field routes cannot touch the switch: PATCH /fields keeps the stored value.
 *   MR2-RD-08 /context: the block is `allowed` with the six editable ids, the parent pair's ids and the row's own 图号
 *             id beside them, then `disabled` after the switch.
 *
 * ADR §12 (owner-ruled 2026-11-19), slice P1 — 父组件图号 / 父组件名称 of a manual row, on the same real sheets:
 *   MR3-RD-01 新增 with a parent: stored as submitted; the pair's rules P3 / P4 / P5 refuse before any write.
 *   MR3-RD-02 修改 the parent: set, change, remove — a version and a revision each; both columns always together.
 *   MR3-RD-03 a PLM row's parent, and an unbound prefix row's, cannot be changed (409 not_manual_row), the rows intact.
 *   MR3-RD-04 /patch and PATCH /records still refuse the pair on a manual row (403 FIELD_READONLY_PLM_SYSTEM).
 *   MR3-RD-05 a row is never its own parent — both directions, and decided under the REAL row lock: a second connection
 *             holds the row FOR UPDATE with the row's own 图号 changed and commits while the edit waits.
 *   MR3-RD-06 复制为新行: a half pair (a name without a 图号), a per-subject rule on ONE column, and a source that is its
 *             own parent each drop BOTH columns; the copy still succeeds.
 *   MR3-RD-07 the pair's own gate, read from the stored field property: with the lock stripped from the two columns the
 *             routes refuse a request that names the pair (409 lock_missing, with the PARENT's own sentence — the sheet
 *             still takes new rows) and nothing else changes; /context sends no `parentFieldIds`; the candidates route
 *             refuses the same way. A sheet the lock never reached keeps the B2 sentence (MR2-RD-03).
 *   MR3-RD-08 the candidates (GET …/manual-rows/parent-options) on real rows — ONE entry per parent 图号 though its rows
 *             name it differently (the name most rows use, a tie to the byte-smallest, every row counted) — and a column
 *             the actor's field_permissions hide is absent from the items and cannot be matched by `q` (the egress
 *             locking case).
 *   MR3-RD-09 rows the row policy denies the actor are neither listed nor counted (nor do they vote for a parent's
 *             name) — by the candidates statement and by GET …/manual-parent-dependents; a platform admin sees them.
 *   MR3-RD-10 /context `parentFieldIds`: sent to an actor who may write both columns, withheld when a per-subject rule
 *             makes one of them read-only — and `componentCodeFieldId` (the row's own 图号) only beside it, withheld from
 *             an actor whose field_permissions hide 图号.
 *   MR3-RD-11 the search text is folded by the DATABASE, like the columns it is matched against: text that is not ASCII,
 *             typed as the sheet stores it, is found whatever the database's LC_CTYPE (a "C" database folds ASCII only;
 *             a libc locale folds each character on its own and so never writes JavaScript's word-final sigma).
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
    // ADR §12: a locked project sheet whose parent-pair lock MR3-RD-07 strips and restores, and one that holds only the
    // candidate cases' rows (MR3-RD-08 / -09 assert the whole list).
    let pairGate: Stack
    let picker: Stack
    const pickerIds = { asm: '', part1: '', part2: '', manualParent: '', manualChild1: '', manualChild2: '' }
    let registry: any
    const PARENT_INVALID = 'STOCK_PREP_MANUAL_PARENT_INVALID'
    // `lock_missing`, the two sentences: the create path's (B2, unchanged) and the parent pair's own (ADR §12.3).
    const LOCK_MISSING_B2 = '本表的 PLM 列锁还没有补齐，暂时不能新增行；请联系管理员修复本表。'
    const LOCK_MISSING_PARENT = '本表的父组件列还没有加锁，暂时不能指定父组件；请联系管理员修复本表。'

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
    // ADR §12 helpers: the parent pair's physical ids, a request body fragment, the edit route, the two picker reads, and
    // a row inserted the way the host's own INSERT writes one (logical cells → physical ids; `createdBy` null = a PLM row).
    const pair = (stack: Stack) => ({ code: phys(stack, 'parentComponentCode'), name: phys(stack, 'parentComponentName') })
    const parent = (stack: Stack, code: unknown, name: unknown) => ({ [pair(stack).code]: code, [pair(stack).name]: name })
    const edit = (recordId: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      http().patch(`/api/multitable/records/${recordId}/manual-fields`).send({ data, ...extra })
    const options = (stack: Stack, query: Record<string, string> = {}) =>
      http().get(`/api/multitable/sheets/${stack.sheetId}/manual-rows/parent-options`).query(query)
    const insertRow = async (stack: Stack, id: string, cells: Record<string, unknown>, createdBy: string | null) => {
      const data: Record<string, unknown> = {}
      for (const [logical, value] of Object.entries(cells)) data[phys(stack, logical)] = value
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by) VALUES ($1, $2, $3::jsonb, 1, $4, $4)', [id, stack.sheetId, JSON.stringify(data), createdBy])
    }
    /** The candidate cases' rows: a PLM assembly with two children, manual rows hung under a PLM part and under a manual row. */
    async function seedPicker(stack: Stack): Promise<void> {
      const plm = (suffix: string, cells: Record<string, unknown>) => {
        const id = `rec_mrp1_pk_${suffix}_${TOKEN}`
        return [id, { projectNo: stack.projectNo, idempotencyKey: JSON.stringify({ projectNo: stack.projectNo, componentSourceId: `SYN-PK-${suffix}` }), componentSourceId: `SYN-PK-${suffix}`, totalQuantity: 1, active: true, ...cells }, null] as const
      }
      const manual = (suffix: string, cells: Record<string, unknown>) => {
        const id = `rec_mrp1_pk_${suffix}_${TOKEN}`
        return [id, { projectNo: stack.projectNo, idempotencyKey: `manual:v1:${id}`, totalQuantity: 1, active: true, ...cells }, WRITER.id] as const
      }
      const rows = {
        asm: plm('asm', { componentCode: 'ASM-1', componentName: 'Assembly' }),
        part1: plm('p1', { componentCode: 'PRT-1', componentName: 'Part one', parentComponentCode: 'ASM-1', parentComponentName: 'Assembly and spec' }),
        part2: plm('p2', { componentCode: 'PRT-2', componentName: 'Part two', parentComponentCode: 'ASM-1', parentComponentName: 'Assembly and spec' }),
        // the same parent 图号 under ANOTHER name (PLM renamed the assembly between two pulls): still one ASM-1 entry
        part3: plm('p3', { componentCode: 'PRT-3', componentName: 'Part three', parentComponentCode: 'ASM-1', parentComponentName: 'Assembly (renamed)' }),
        // a parent two rows name differently, one row each: the byte-smallest name ('B' 0x42 is before 'a' 0x61)
        tieA: plm('ta', { componentCode: 'TIE-A', componentName: 'Tie a', parentComponentCode: 'TIE-1', parentComponentName: 'a name' }),
        tieB: plm('tb', { componentCode: 'TIE-B', componentName: 'Tie b', parentComponentCode: 'TIE-1', parentComponentName: 'B name' }),
        // text that is not ASCII (MR3-RD-11). Greek on purpose: Φ, Δ and Σ look like no Latin letter.
        axle: plm('ax', { componentCode: 'AXL-1', componentName: '轴 Φ20' }),
        sigma: plm('sg', { componentCode: 'SYN-ΔΣ', componentName: 'Sigma shaft' }),
        manual1: manual('m1', { componentCode: 'MAN-1', componentName: 'Manual one', parentComponentCode: 'PRT-1', parentComponentName: 'Part one' }),
        manualParent: manual('mp', { componentCode: 'MAN-P', componentName: 'Manual parent' }),
        manualChild1: manual('mc1', { componentCode: 'MAN-C1', componentName: 'Manual child one', parentComponentCode: 'MAN-P', parentComponentName: 'Manual parent' }),
        manualChild2: manual('mc2', { componentCode: 'MAN-C2', componentName: 'Manual child two', parentComponentCode: 'MAN-P', parentComponentName: 'Manual parent' }),
        // a PLM row under the same 图号 counts as a child of the candidate, never as a manual dependent
        plmUnderManual: plm('p9', { componentCode: 'PRT-9', componentName: 'Part nine', parentComponentCode: 'MAN-P', parentComponentName: 'Manual parent' }),
        // never candidates: no 图号, inactive, a 图号 that is not text
        noCode: manual('nc', { componentName: 'No drawing number' }),
        inactive: plm('old', { componentCode: 'OLD-1', componentName: 'Old part', active: false }),
        notText: plm('num', { componentCode: 77, componentName: 'Number in the code cell' }),
        // stored with surrounding whitespace: listed exactly as stored
        spaced: plm('sp', { componentCode: ' SP-1 ', componentName: 'Spaced' }),
      }
      for (const [id, cells, createdBy] of Object.values(rows)) await insertRow(stack, id, cells, createdBy)
      pickerIds.asm = rows.asm[0]
      pickerIds.part1 = rows.part1[0]
      pickerIds.part2 = rows.part2[0]
      pickerIds.manualParent = rows.manualParent[0]
      pickerIds.manualChild1 = rows.manualChild1[0]
      pickerIds.manualChild2 = rows.manualChild2[0]
    }

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
      pairGate = await provision('pairgate', { lock: true })
      picker = await provision('picker', { lock: true })
      await seedPicker(picker)
    }, 240_000)

    afterAll(async () => {
      if (switchBefore === undefined) delete process.env[SWITCH]
      else process.env[SWITCH] = switchBefore
      for (const sheetId of sheets) {
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM record_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
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
      // 父组件图号 left this list with ADR §12: the manual-row routes write it, as a pair (MR3-RD-01).
      for (const logical of ['idempotencyKey', 'projectNo', 'active', 'componentSourceId']) {
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
      // A sheet the lock never reached: the B2 sentence, word for word — also for a create that names a parent (the
      // stamped columns' lock is what is missing there, not only the pair's).
      await expectRefused(unlocked, 409, 'lock_missing')
      for (const extra of [{}, parent(unlocked, 'SYN-PARENT-RD', null)]) {
        const refused = await create(unlocked, minimal(unlocked, extra))
        expect(refused.body, JSON.stringify(refused.body)).toEqual({ ok: false, error: { code: 'STOCK_PREP_MANUAL_ROWS_UNAVAILABLE', message: LOCK_MISSING_B2, details: { reason: 'lock_missing' } } })
      }
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

    test('MR2-RD-04 复制为新行 of a PLM row: the six + 备料计划 copied, and its parent pair (ADR §12.5); identity / RUN, 进度与回复 never; fresh stamps', async () => {
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
      // The parent pair is carried as a pair since ADR §12.5 (owner ruling OQ-P1): both columns readable and writable for
      // the actor, a 图号 present, and not the copy's own 图号.
      for (const logical of ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity', 'leadTimeDays', 'demandDate', 'parentComponentCode', 'parentComponentName']) {
        expect(copy.data[phys(main, logical)], logical).toEqual(cells[logical])
      }
      for (const logical of ['componentSourceId', 'parentSourceId', 'path', 'depth', 'sourceVersion', 'lastPlmRefreshRunId', 'notes', 'procurementReply']) {
        expect(phys(main, logical) in copy.data, logical).toBe(false)
      }
      expect(copy.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${copyId}`)
      expect(copy.data[phys(main, 'projectNo')]).toBe(main.projectNo)
      expect(copy.created_by).toBe(WRITER.id)
      expect((await row(sourceId))!.version).toBe(1)
    })

    test('MR2-RD-05 修改: only the eight the route accepts; version + 1; the generic /patch still refuses the six on the same row', async () => {
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

    test('MR2-RD-08 /context: allowed with the six editable ids and the parent pair\'s ids, then disabled after the switch', async () => {
      actor = WRITER
      const allowed = await http().get('/api/multitable/context').query({ sheetId: main.sheetId })
      expect(allowed.status).toBe(200)
      expect(allowed.body.data.capabilities.stockPreparationManualRows).toEqual({
        state: 'allowed',
        editableFieldIds: ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity'].map((l) => phys(main, l)),
        requiredFieldIds: [phys(main, 'componentName'), phys(main, 'totalQuantity')],
        // Slice B3: the 新增人工补充行 dialog's columns (ADR §8 B3.3).
        dialogFieldIds: ['componentName', 'totalQuantity', 'componentCode', 'componentSpec', 'material', 'rawQuantity', 'notes'].map((l) => phys(main, l)),
        // ADR §12.6: the parent pair, for an actor who may write both columns — never among editableFieldIds.
        parentFieldIds: pair(main),
        // …and, only beside it, the row's own 图号 column for an actor who may read it (the web's self-parent pre-check).
        componentCodeFieldId: phys(main, 'componentCode'),
      })
      await setSwitch(main, 'disabled')
      try {
        const disabled = await http().get('/api/multitable/context').query({ sheetId: main.sheetId })
        expect(disabled.body.data.capabilities.stockPreparationManualRows.state).toBe('disabled')
        // Rule P8: a switched-off sheet still lets an existing manual row's parent be changed, so the ids stay.
        expect(disabled.body.data.capabilities.stockPreparationManualRows.parentFieldIds).toEqual(pair(main))
        expect(disabled.body.data.capabilities.stockPreparationManualRows.componentCodeFieldId).toBe(phys(main, 'componentCode'))
      } finally {
        await setSwitch(main, 'allowed')
      }
    })

    // ── ADR §12 (slice P1): the parent pair ────────────────────────────────────────────────────────────────

    test('MR3-RD-01 新增 with a parent: stored as submitted, one create revision; P3 / P4 / P5 refuse before any write', async () => {
      actor = WRITER
      const res = await create(main, minimal(main, { [phys(main, 'componentCode')]: `SYN-CHILD-${TOKEN}`, ...parent(main, ' SYN-PARENT-RD ', 'Synthetic parent ') }))
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      const id = res.body.data.record.id as string
      const stored = (await row(id))!
      // exactly what was sent — surrounding whitespace kept, nothing rewritten
      expect(stored.data[pair(main).code]).toBe(' SYN-PARENT-RD ')
      expect(stored.data[pair(main).name]).toBe('Synthetic parent ')
      expect(stored.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
      expect(stored.created_by).toBe(WRITER.id)
      expect(res.body.data.record.data[pair(main).code]).toBe(' SYN-PARENT-RD ')
      const revisions = (await q('SELECT action FROM meta_record_revisions WHERE record_id = $1', [id])).rows as Array<{ action: string }>
      expect(revisions.map((r) => r.action)).toEqual(['create'])
      // a parent without a name
      const noName = await create(main, minimal(main, parent(main, 'SYN-PARENT-RD', null)))
      expect(noName.status, JSON.stringify(noName.body)).toBe(200)
      const noNameRow = (await row(noName.body.data.record.id))!
      expect(noNameRow.data[pair(main).code]).toBe('SYN-PARENT-RD')
      expect(noNameRow.data[pair(main).name]).toBeNull()

      const before = await rowCount(main)
      const refused: Array<[Record<string, unknown>, number, string]> = [
        [{ [pair(main).code]: 'SYN-PARENT-RD' }, 400, 'pair_incomplete'],
        [{ [pair(main).name]: 'Synthetic parent' }, 400, 'pair_incomplete'],
        [parent(main, 42, 'Synthetic parent'), 400, 'not_text'],
        [parent(main, 'SYN-PARENT-RD', { text: 'x' }), 400, 'not_text'],
        [parent(main, null, 'Synthetic parent'), 422, 'name_without_code'],
        [parent(main, '   ', 'Synthetic parent'), 422, 'name_without_code'],
        [{ [phys(main, 'componentCode')]: 'SYN-SELF', ...parent(main, 'SYN-SELF', null) }, 422, 'self_parent'],
        [{ [phys(main, 'componentCode')]: 'SYN-SELF', ...parent(main, ' SYN-SELF ', 'Synthetic parent') }, 422, 'self_parent'],
      ]
      for (const [extra, status, reason] of refused) {
        const bad = await create(main, minimal(main, extra))
        expect(bad.status, `${reason}: ${JSON.stringify(bad.body)}`).toBe(status)
        expect(bad.body.error).toMatchObject({ code: PARENT_INVALID, details: { reason } })
      }
      expect(await rowCount(main)).toBe(before)
    })

    test('MR3-RD-02 修改 the parent: set, change, remove — version + 1 and one revision each; a half pair is refused', async () => {
      actor = WRITER
      const created = await create(main, minimal(main, { [phys(main, 'componentCode')]: `SYN-EDIT-${TOKEN}` }))
      const id = created.body.data.record.id as string
      expect(pair(main).code in (await row(id))!.data).toBe(false)
      const set = await edit(id, parent(main, 'SYN-PARENT-A', 'Synthetic parent A'), { expectedVersion: 1 })
      expect(set.status, JSON.stringify(set.body)).toBe(200)
      expect(set.body.data.updated).toEqual([{ recordId: id, version: 2 }])
      let stored = (await row(id))!
      expect([stored.data[pair(main).code], stored.data[pair(main).name]]).toEqual(['SYN-PARENT-A', 'Synthetic parent A'])
      // a parent that exists nowhere on the sheet (新建父组件), without a name
      expect((await edit(id, parent(main, 'SYN-PARENT-NEW', null))).status).toBe(200)
      stored = (await row(id))!
      expect([stored.data[pair(main).code], stored.data[pair(main).name]]).toEqual(['SYN-PARENT-NEW', null])
      // a half pair — what a single grid cell would send — changes nothing
      for (const half of [{ [pair(main).code]: 'SYN-HALF' }, { [pair(main).name]: 'Half' }]) {
        const bad = await edit(id, half)
        expect(bad.status, JSON.stringify(bad.body)).toBe(400)
        expect(bad.body.error).toMatchObject({ code: PARENT_INVALID, details: { reason: 'pair_incomplete' } })
      }
      expect((await row(id))!.version).toBe(3)
      // 移出父组件
      expect((await edit(id, parent(main, null, null))).status).toBe(200)
      stored = (await row(id))!
      expect(stored.version).toBe(4)
      expect([stored.data[pair(main).code], stored.data[pair(main).name]]).toEqual([null, null])
      expect(stored.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
      expect(stored.data[phys(main, 'componentCode')]).toBe(`SYN-EDIT-${TOKEN}`)
      const revisions = (await q('SELECT action FROM meta_record_revisions WHERE record_id = $1', [id])).rows as Array<{ action: string }>
      expect(revisions.map((r) => r.action).sort()).toEqual(['create', 'update', 'update', 'update'])
    })

    test('MR3-RD-03 a PLM row\'s parent, and an unbound prefix row\'s, cannot be changed through this route: 409 not_manual_row, the rows intact', async () => {
      actor = ADMIN
      const plmId = `rec_mrp1_plm_${TOKEN}`
      await insertRow(main, plmId, {
        projectNo: main.projectNo, idempotencyKey: JSON.stringify({ projectNo: main.projectNo, componentSourceId: 'SYN-PART-P3' }), componentSourceId: 'SYN-PART-P3',
        componentCode: 'SYN-PLM-CHILD', componentName: 'Synthetic PLM part', totalQuantity: 1, active: true,
        parentComponentCode: 'SYN-PLM-PARENT', parentComponentName: 'Synthetic PLM parent',
      }, null)
      const unboundId = `rec_mrp1_unbound_${TOKEN}`
      await insertRow(main, unboundId, {
        projectNo: main.projectNo, idempotencyKey: 'manual:v1:rec_mrp1_someone_else', componentName: 'SYN', totalQuantity: 1, active: true,
      }, WRITER.id)
      for (const id of [plmId, unboundId]) {
        const before = (await row(id))!
        const res = await edit(id, parent(main, 'SYN-FORGED', 'Forged parent'))
        expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(409)
        expect(res.body.error).toMatchObject({ code: 'STOCK_PREP_MANUAL_ROW_REQUIRED', details: { reason: 'not_manual_row' } })
        expect(await row(id)).toEqual(before)
      }
      actor = WRITER
    })

    test('MR3-RD-04 /patch and PATCH /records still refuse the pair on a manual row: 403 FIELD_READONLY_PLM_SYSTEM, nothing written', async () => {
      actor = WRITER
      const created = await create(main, minimal(main, parent(main, 'SYN-PARENT-RD', 'Synthetic parent')))
      const id = created.body.data.record.id as string
      const before = (await row(id))!
      for (const fieldId of [pair(main).code, pair(main).name]) {
        const bulk = await http().post('/api/multitable/patch').send({ sheetId: main.sheetId, changes: [{ recordId: id, fieldId, value: 'SYN-FORGED' }] })
        expect(bulk.status, JSON.stringify(bulk.body)).toBe(403)
        expect(bulk.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
        const single = await http().patch(`/api/multitable/records/${id}`).send({ sheetId: main.sheetId, data: { [fieldId]: 'SYN-FORGED' } })
        expect(single.status, JSON.stringify(single.body)).toBe(403)
        expect(single.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
      }
      expect(await row(id)).toEqual(before)
    })

    test('MR3-RD-05 a row is never its own parent — both directions, and under the real row lock', async () => {
      actor = WRITER
      const own = phys(main, 'componentCode')
      // direction 1: the parent becomes the row's own 图号
      const first = (await create(main, minimal(main, { [own]: `SYN-D1-${TOKEN}` }))).body.data.record.id as string
      for (const code of [`SYN-D1-${TOKEN}`, ` SYN-D1-${TOKEN} `]) {
        const res = await edit(first, parent(main, code, 'Synthetic parent'))
        expect(res.status, JSON.stringify(res.body)).toBe(422)
        expect(res.body.error).toMatchObject({ code: PARENT_INVALID, details: { reason: 'self_parent' } })
      }
      expect((await row(first))!.version).toBe(1)
      // direction 2: the row's own 图号 becomes the stored parent — a request that names no parent column
      const second = (await create(main, minimal(main, { [own]: `SYN-D2-${TOKEN}`, ...parent(main, `SYN-D2-PARENT-${TOKEN}`, null) }))).body.data.record.id as string
      const d2 = await edit(second, { [own]: `SYN-D2-PARENT-${TOKEN}` })
      expect(d2.status, JSON.stringify(d2.body)).toBe(422)
      expect(d2.body.error).toMatchObject({ code: PARENT_INVALID, details: { reason: 'self_parent' } })
      expect((await row(second))!.version).toBe(1)
      expect((await edit(second, { [own]: `SYN-D2-OTHER-${TOKEN}` })).status).toBe(200)

      // Under the row lock. A second connection locks the row, changes its own 图号 to RACE and holds the transaction
      // open. The edit that sets the PARENT to RACE reads the row first (图号 still the old one — nothing to refuse),
      // then waits on the row lock in its write transaction. The holder commits; only a check made on the row as the
      // lock returns it sees 图号 = RACE and refuses. A check on the first read would have written a self-parent.
      const third = (await create(main, minimal(main, { [own]: `SYN-D3-${TOKEN}` }))).body.data.record.id as string
      const race = `SYN-RACE-${TOKEN}`
      const holder = new Client({ connectionString: process.env.DATABASE_URL })
      await holder.connect()
      let committed = false
      try {
        const holderPid = Number(((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0] as { pid: number }).pid)
        await holder.query('BEGIN')
        await holder.query('SELECT id FROM meta_records WHERE id = $1 FOR UPDATE', [third])
        await holder.query('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], to_jsonb($3::text)), version = version + 1 WHERE id = $1', [third, own, race])
        const pending = edit(third, parent(main, race, null)).then((res) => ({ status: res.status, body: res.body }))
        let waiting = 0
        for (let i = 0; i < 200 && waiting === 0; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          waiting = Number(((await q('SELECT count(*)::int AS c FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holderPid])).rows[0] as { c: number }).c)
        }
        expect(waiting, 'the edit must be waiting on the row lock').toBeGreaterThan(0)
        await holder.query('COMMIT')
        committed = true
        const res = await pending
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(422)
        expect(res.body.error).toMatchObject({ code: PARENT_INVALID, details: { reason: 'self_parent' } })
        const after = (await row(third))!
        expect(after.data[own]).toBe(race)
        expect(pair(main).code in after.data).toBe(false)
        expect(after.version).toBe(2)
      } finally {
        if (!committed) await holder.query('ROLLBACK').catch(() => {})
        await holder.end()
      }
    })

    test('MR3-RD-06 复制为新行: a half pair, a per-subject rule on ONE column, and a self-parented source each drop BOTH columns — the copy still succeeds', async () => {
      actor = WRITER
      const copyOf = async (sourceId: string) => {
        const res = await http().post(`/api/multitable/records/${sourceId}/manual-copy`).send({})
        expect(res.status, `${sourceId}: ${JSON.stringify(res.body)}`).toBe(200)
        return (await row(res.body.data.record.id as string))!
      }
      const base = { projectNo: main.projectNo, componentName: 'Synthetic PLM part', material: 'SYN-MATERIAL', totalQuantity: 2, active: true }
      const plmKey = (suffix: string) => JSON.stringify({ projectNo: main.projectNo, componentSourceId: `SYN-PART-C6-${suffix}` })
      const expectNeither = (copy: { id: string; data: Record<string, unknown> }) => {
        expect(pair(main).code in copy.data, 'parentComponentCode').toBe(false)
        expect(pair(main).name in copy.data, 'parentComponentName').toBe(false)
        expect(copy.data[phys(main, 'material')]).toBe('SYN-MATERIAL')
        expect(copy.data[phys(main, 'idempotencyKey')]).toBe(`manual:v1:${copy.id}`)
      }
      // a name without a 图号 (a PLM child whose parent has no drawing number)
      const halfId = `rec_mrp1_c6_half_${TOKEN}`
      await insertRow(main, halfId, { ...base, idempotencyKey: plmKey('half'), componentCode: 'SYN-C6-HALF', parentComponentName: 'Synthetic PLM parent' }, null)
      expectNeither(await copyOf(halfId))
      // the source is its own parent (same 图号 on both), so the copy would be too
      const selfId = `rec_mrp1_c6_self_${TOKEN}`
      await insertRow(main, selfId, { ...base, idempotencyKey: plmKey('self'), componentCode: 'SYN-C6-SELF', parentComponentCode: 'SYN-C6-SELF', parentComponentName: 'Synthetic PLM parent' }, null)
      expectNeither(await copyOf(selfId))
      // a whole pair — carried; then the same source with 父组件名称 read-only for the actor — neither column
      const wholeId = `rec_mrp1_c6_whole_${TOKEN}`
      await insertRow(main, wholeId, { ...base, idempotencyKey: plmKey('whole'), componentCode: 'SYN-C6-WHOLE', parentComponentCode: 'SYN-C6-PARENT', parentComponentName: 'Synthetic PLM parent' }, null)
      const carried = await copyOf(wholeId)
      expect([carried.data[pair(main).code], carried.data[pair(main).name]]).toEqual(['SYN-C6-PARENT', 'Synthetic PLM parent'])
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [main.sheetId, pair(main).name, 'user', WRITER.id, true, true])
      try {
        expectNeither(await copyOf(wholeId))
      } finally {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [main.sheetId, WRITER.id])
      }
    })

    test('MR3-RD-07 the pair\'s own gate, from the stored field property: with the lock stripped from the two columns only a request that names the pair is refused', async () => {
      actor = WRITER
      const stack = pairGate
      const pairIds = [pair(stack).code, pair(stack).name]
      const before = (await q('SELECT id, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])', [stack.sheetId, pairIds])).rows as Array<{ id: string; property: Record<string, unknown> }>
      expect(before.map((f) => f.property.humanWriteLock)).toEqual(['plm_system', 'plm_system'])
      // locked: the pair is writable through the route
      const ok = await create(stack, minimal(stack, parent(stack, 'SYN-PARENT-G7', 'Synthetic parent')))
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
      const manualId = ok.body.data.record.id as string
      await q(`UPDATE meta_fields SET property = property - 'humanWriteLock' WHERE sheet_id = $1 AND id = ANY($2::text[])`, [stack.sheetId, pairIds])
      try {
        const rows = await rowCount(stack)
        // The refusal is about the PARENT: this sheet still takes new rows (below), so it does not say 「不能新增行」.
        const pairLockMissing = { ok: false, error: { code: 'STOCK_PREP_MANUAL_ROWS_UNAVAILABLE', message: LOCK_MISSING_PARENT, details: { reason: 'lock_missing' } } }
        const createWithPair = await create(stack, minimal(stack, parent(stack, 'SYN-PARENT-G7', null)))
        expect(createWithPair.status, JSON.stringify(createWithPair.body)).toBe(409)
        expect(createWithPair.body).toEqual(pairLockMissing)
        const editPair = await edit(manualId, parent(stack, 'SYN-PARENT-OTHER', null))
        expect(editPair.status, JSON.stringify(editPair.body)).toBe(409)
        expect(editPair.body).toEqual(pairLockMissing)
        expect(await rowCount(stack)).toBe(rows)
        expect((await row(manualId))!.data[pair(stack).code]).toBe('SYN-PARENT-G7')
        // everything that does not name the pair works exactly as before
        expect((await create(stack, minimal(stack))).status).toBe(200)
        expect((await edit(manualId, { [phys(stack, 'componentName')]: 'Renamed' })).status).toBe(200)
        // the copy carries neither column and still succeeds
        const copied = await http().post(`/api/multitable/records/${manualId}/manual-copy`).send({})
        expect(copied.status, JSON.stringify(copied.body)).toBe(200)
        const copy = (await row(copied.body.data.record.id as string))!
        expect(pair(stack).code in copy.data).toBe(false)
        expect(pair(stack).name in copy.data).toBe(false)
        // /context: the block stays `allowed` and sends no parentFieldIds; the candidates route refuses
        const ctx = await http().get('/api/multitable/context').query({ sheetId: stack.sheetId })
        expect(ctx.body.data.capabilities.stockPreparationManualRows.state).toBe('allowed')
        expect('parentFieldIds' in ctx.body.data.capabilities.stockPreparationManualRows).toBe(false)
        const candidates = await options(stack)
        expect(candidates.status).toBe(409)
        expect(candidates.body).toEqual(pairLockMissing)
      } finally {
        for (const field of before) {
          await q('UPDATE meta_fields SET property = $3::jsonb WHERE sheet_id = $1 AND id = $2', [stack.sheetId, field.id, JSON.stringify(field.property)])
        }
      }
      // locked again: the same edit lands
      expect((await edit(manualId, parent(stack, 'SYN-PARENT-OTHER', null))).status).toBe(200)
      const ctx = await http().get('/api/multitable/context').query({ sheetId: stack.sheetId })
      expect(ctx.body.data.capabilities.stockPreparationManualRows.parentFieldIds).toEqual(pair(stack))
    })

    test('MR3-RD-08 the candidates on real rows; a column the actor\'s field_permissions hide is absent from the items and cannot be matched by q', async () => {
      actor = WRITER
      const stack = picker
      const PARENTS = [
        // ONE entry though its three children store two names: the name two of them use, all three counted
        { code: 'ASM-1', name: 'Assembly and spec', kind: 'parent', childCount: 3 },
        // two manual children and one PLM child carry it
        { code: 'MAN-P', name: 'Manual parent', kind: 'parent', childCount: 3 },
        { code: 'PRT-1', name: 'Part one', kind: 'parent', childCount: 1 },
        // one row each for 'a name' and 'B name': the byte-smallest, whatever the database's own collation would say
        { code: 'TIE-1', name: 'B name', kind: 'parent', childCount: 2 },
      ]
      const ALL = [
        ...PARENTS,
        { code: ' SP-1 ', name: 'Spaced', kind: 'component' },
        { code: 'AXL-1', name: '轴 Φ20', kind: 'component' },
        { code: 'MAN-1', name: 'Manual one', kind: 'component' },
        { code: 'MAN-C1', name: 'Manual child one', kind: 'component' },
        { code: 'MAN-C2', name: 'Manual child two', kind: 'component' },
        { code: 'PRT-2', name: 'Part two', kind: 'component' },
        { code: 'PRT-3', name: 'Part three', kind: 'component' },
        { code: 'PRT-9', name: 'Part nine', kind: 'component' },
        { code: 'SYN-ΔΣ', name: 'Sigma shaft', kind: 'component' },
        { code: 'TIE-A', name: 'Tie a', kind: 'component' },
        { code: 'TIE-B', name: 'Tie b', kind: 'component' },
      ]
      const all = await options(stack)
      expect(all.status, JSON.stringify(all.body)).toBe(200)
      // existing parents first (with child counts), then the sheet's own parts in byte order; a part that is already a
      // parent (ASM-1, MAN-P, PRT-1) is listed once, under the PARENT's name; the row without a 图号, the inactive row and
      // the number in the 图号 cell are not candidates; values exactly as stored (' SP-1 ' keeps its spaces)
      expect(all.body).toEqual({ ok: true, data: { items: ALL, truncated: false } })
      // no 图号 is listed twice, and the name only one of ASM-1's children uses is not listed at all
      expect(new Set(ALL.map((item) => item.code)).size).toBe(ALL.length)
      expect(JSON.stringify(all.body)).not.toContain('Assembly (renamed)')
      expect((await options(stack, { limit: '2' })).body.data).toEqual({ items: ALL.slice(0, 2), truncated: true })
      expect((await options(stack, { limit: String(ALL.length - 1) })).body.data).toEqual({ items: ALL.slice(0, -1), truncated: true })
      expect((await options(stack, { limit: String(ALL.length) })).body.data).toEqual({ items: ALL, truncated: false })
      expect((await options(stack, { q: ' PART ' })).body.data.items.map((item: { code: string }) => item.code)).toEqual(['PRT-1', 'PRT-2', 'PRT-3', 'PRT-9'])
      expect((await options(stack, { q: 'and spec' })).body.data.items).toEqual([ALL[0]])
      // the search reads the ENTRY: the name a minority of ASM-1's rows use finds nothing
      expect((await options(stack, { q: 'renamed' })).body.data.items).toEqual([])
      // SQL wildcards are plain characters
      expect((await options(stack, { q: '%' })).body.data.items).toEqual([])
      expect((await options(stack, { q: '_' })).body.data.items).toEqual([])
      // a platform admin gets the same list
      actor = ADMIN
      expect((await options(stack)).body.data.items).toEqual(ALL)
      actor = WRITER

      // THE LOCKING CASE. 父组件名称 hidden for the actor: 'Assembly and spec' lives ONLY in that column.
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [stack.sheetId, pair(stack).name, 'user', WRITER.id, false, false])
      try {
        const masked = await options(stack, { limit: '50' })
        expect(masked.status).toBe(200)
        // still one entry per 图号, each with all of its rows counted — and no name
        expect(masked.body.data.items.slice(0, PARENTS.length)).toEqual(PARENTS.map((item) => ({ ...item, name: null })))
        // the readable columns are untouched by that rule
        expect(masked.body.data.items.slice(PARENTS.length)).toEqual(ALL.slice(PARENTS.length))
        expect(JSON.stringify(masked.body)).not.toContain('Assembly and spec')
        // …and `q` cannot be used to find out what the hidden column holds
        expect((await options(stack, { q: 'and spec' })).body.data).toEqual({ items: [], truncated: false })
        // the stored rows still hold it
        const holders = (await q('SELECT count(*)::int AS n FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3', [stack.sheetId, pair(stack).name, 'Assembly and spec'])).rows[0] as { n: number }
        expect(holders.n).toBe(2)
      } finally {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [stack.sheetId, WRITER.id])
      }
      // 图号 hidden: no 「本项目物料」 entry at all; a search for a part's own number finds nothing
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [stack.sheetId, phys(stack, 'componentCode'), 'user', WRITER.id, false, false])
      try {
        expect((await options(stack)).body.data.items).toEqual(PARENTS)
        expect((await options(stack, { q: 'MAN-1' })).body.data.items).toEqual([])
      } finally {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [stack.sheetId, WRITER.id])
      }
      // 有效 hidden: the active filter is dropped, never applied on a value the actor may not read
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [stack.sheetId, phys(stack, 'active'), 'user', WRITER.id, false, false])
      try {
        expect((await options(stack, { limit: '50' })).body.data.items.map((item: { code: string }) => item.code)).toContain('OLD-1')
      } finally {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [stack.sheetId, WRITER.id])
      }
      expect((await options(stack)).body.data.items).toEqual(ALL)
    })

    test('MR3-RD-09 rows the row policy denies the actor are neither listed nor counted (candidates and dependents); a platform admin sees them', async () => {
      actor = WRITER
      const stack = picker
      const manualParent = pickerIds.manualParent
      // before any deny: two manual rows hang under MAN-P; the PLM row with the same parent 图号 is not a dependent
      const dependents = (id: string) => http().get(`/api/multitable/records/${id}/manual-parent-dependents`)
      const initial = await dependents(manualParent)
      expect(initial.status, JSON.stringify(initial.body)).toBe(200)
      expect(initial.body).toEqual({ ok: true, data: { count: 2 } })
      expect((await dependents(pickerIds.part2)).status).toBe(409) // a PLM row: not_manual_row

      await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = true WHERE id = $1', [stack.sheetId])
      await q(`INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1, $2, 'user', $3, 'none'), ($1, $4, 'user', $3, 'none')`,
        [stack.sheetId, pickerIds.part2, WRITER.id, pickerIds.manualChild1])
      try {
        const res = await options(stack, { limit: '50' })
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        const items = res.body.data.items as Array<{ code: string; kind: string; childCount?: number }>
        // PRT-2's row is denied: its own entry is gone, ASM-1 counts one child less — and its name is voted by the rows
        // this actor may read: one for each text now, so the byte-smallest ('(' 0x28 is before 'a' 0x61)
        expect(items.find((item) => item.code === 'ASM-1')).toEqual({ code: 'ASM-1', name: 'Assembly (renamed)', kind: 'parent', childCount: 2 })
        expect(items.some((item) => item.code === 'PRT-2')).toBe(false)
        expect(JSON.stringify(res.body)).not.toContain('Part two')
        expect((await options(stack, { q: 'part two' })).body.data.items).toEqual([])
        // the denied manual child is not counted
        expect((await dependents(manualParent)).body.data).toEqual({ count: 1 })
        // the row itself denied → the shared record gate refuses
        expect((await dependents(pickerIds.manualChild1)).status).toBe(403)
        actor = ADMIN
        const adminItems = (await options(stack, { limit: '50' })).body.data.items as Array<{ code: string }>
        expect(adminItems.some((item) => item.code === 'PRT-2')).toBe(true)
        // a platform admin reads all three children: the majority name again
        expect(adminItems.find((item) => item.code === 'ASM-1')).toEqual({ code: 'ASM-1', name: 'Assembly and spec', kind: 'parent', childCount: 3 })
        expect((await dependents(manualParent)).body.data).toEqual({ count: 2 })
      } finally {
        actor = WRITER
        await q('DELETE FROM record_permissions WHERE sheet_id = $1', [stack.sheetId])
        await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false WHERE id = $1', [stack.sheetId])
      }
      expect((await dependents(manualParent)).body.data).toEqual({ count: 2 })
    })

    test('MR3-RD-10 /context parentFieldIds: sent to an actor who may write both columns, withheld when a per-subject rule makes one read-only; the routes refuse that actor', async () => {
      actor = WRITER
      const blockOf = async () => (await http().get('/api/multitable/context').query({ sheetId: main.sheetId })).body.data.capabilities.stockPreparationManualRows
      const unrestricted = await blockOf()
      expect(unrestricted.parentFieldIds).toEqual(pair(main))
      expect(unrestricted.componentCodeFieldId).toBe(phys(main, 'componentCode'))
      expect(unrestricted.editableFieldIds).not.toContain(pair(main).code)
      expect(unrestricted.editableFieldIds).not.toContain(pair(main).name)
      const created = await create(main, minimal(main))
      const id = created.body.data.record.id as string
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [main.sheetId, pair(main).name, 'user', WRITER.id, true, true])
      try {
        const restricted = await blockOf()
        expect('parentFieldIds' in restricted).toBe(false)
        // its companion goes with it, though 图号 itself is readable for this actor
        expect('componentCodeFieldId' in restricted).toBe(false)
        expect(Object.keys(restricted)).toEqual(['state', 'editableFieldIds', 'requiredFieldIds', 'dialogFieldIds'])
        expect(restricted.editableFieldIds).toEqual(unrestricted.editableFieldIds)
        // …and the routes agree: the pair is refused whichever half is sent, the six still work
        expect((await edit(id, parent(main, 'SYN-PARENT-RD', 'Synthetic parent'))).status).toBe(403)
        expect((await edit(id, { [pair(main).code]: 'SYN-PARENT-RD' })).status).toBe(403)
        expect((await create(main, minimal(main, parent(main, 'SYN-PARENT-RD', null)))).status).toBe(403)
        expect((await edit(id, { [phys(main, 'material')]: 'SYN-MATERIAL' })).status).toBe(200)
        expect(pair(main).code in (await row(id))!.data).toBe(false)
        // a platform admin is not that subject
        actor = ADMIN
        expect((await blockOf()).parentFieldIds).toEqual(pair(main))
      } finally {
        actor = WRITER
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [main.sheetId, WRITER.id])
      }
      expect((await blockOf()).parentFieldIds).toEqual(pair(main))
      // 图号 hidden for the actor (a stored field_permissions row): the pair is still named, the 图号 id is not
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [main.sheetId, phys(main, 'componentCode'), 'user', WRITER.id, false, false])
      try {
        const hidden = await blockOf()
        expect(hidden.parentFieldIds).toEqual(pair(main))
        expect('componentCodeFieldId' in hidden).toBe(false)
        actor = ADMIN
        expect((await blockOf()).componentCodeFieldId).toBe(phys(main, 'componentCode'))
      } finally {
        actor = WRITER
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [main.sheetId, WRITER.id])
      }
      expect((await blockOf()).componentCodeFieldId).toBe(phys(main, 'componentCode'))
    })

    test('MR3-RD-11 the search text is folded by the database, like the columns: text that is not ASCII, typed as the sheet stores it, is found whatever the database\'s LC_CTYPE', async () => {
      actor = WRITER
      const codes = async (search: string) => {
        const res = await options(picker, { q: search })
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        return (res.body.data.items as Array<{ code: string }>).map((item) => item.code)
      }
      // Typed exactly as stored: found on EVERY database. The application does not fold the text first — JavaScript
      // would make these '轴 φ20' and 'δς', and neither is what a database makes of the column: a LC_CTYPE "C" database
      // leaves Φ alone (a needle folded by JavaScript found nothing there for the first two), and a libc locale folds
      // each character on its own, so it writes σ where JavaScript writes the word-final ς (nothing for the third).
      expect(await codes('轴 Φ20')).toEqual(['AXL-1'])
      expect(await codes('Φ20')).toEqual(['AXL-1'])
      expect(await codes('ΔΣ')).toEqual(['SYN-ΔΣ'])
      expect(await codes(' 轴 Φ20 ')).toEqual(['AXL-1'])
      // ASCII letters fold on every database
      expect(await codes('axl-')).toEqual(['AXL-1'])
      expect(await codes('SIGMA')).toEqual(['SYN-ΔΣ'])
      expect(await codes('syn-ΔΣ')).toEqual(['SYN-ΔΣ'])
      // How far the match ignores case beyond ASCII is the database's own rule — so ask THIS database, and expect the
      // route to answer exactly that (both sides of the match are folded by it).
      const folds = (await q(`SELECT lower('Φ') = 'φ' AS phi, strpos(lower('SYN-ΔΣ'), lower('δσ')) > 0 AS small_sigma, strpos(lower('SYN-ΔΣ'), lower('δς')) > 0 AS final_sigma`)).rows[0] as { phi: boolean; small_sigma: boolean; final_sigma: boolean }
      expect(await codes('φ20')).toEqual(folds.phi ? ['AXL-1'] : [])
      expect(await codes('δσ')).toEqual(folds.small_sigma ? ['SYN-ΔΣ'] : [])
      expect(await codes('δς')).toEqual(folds.final_sigma ? ['SYN-ΔΣ'] : [])
      // a hidden column is still not matched, whatever the text: 名称 hidden → '轴 Φ20' lives only there
      await q('INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only) VALUES ($1,$2,$3,$4,$5,$6)',
        [picker.sheetId, phys(picker, 'componentName'), 'user', WRITER.id, false, false])
      try {
        expect(await codes('轴 Φ20')).toEqual([])
        expect(await codes('ΔΣ')).toEqual(['SYN-ΔΣ'])
      } finally {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1 AND subject_id = $2', [picker.sheetId, WRITER.id])
      }
    })
  })
}
