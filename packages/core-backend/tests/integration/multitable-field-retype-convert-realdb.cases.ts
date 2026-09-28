/**
 * 字段类型转换（带值迁移）第 3 刀 —— 执行 + 整列撤销的**真库**验收。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §6 第 3 刀（十三条，均在 fence = ON）。
 *
 * 这是一个 CASES MODULE，不是测试文件：`defineFieldRetypeConvertRealDbCases()` 注册一个 `describe`，由已经接进
 * .github/workflows/plugin-tests.yml「Run multitable real-DB integration」那一步的宿主文件
 * tests/integration/multitable-lossy-retype-revert-realdb.test.ts 调用，所以不需要新泳道、不改 workflow 文件。
 * 不要再为这些用例单独登记文件，否则它们跑两遍。
 *
 * ── 十三条的去向 ───────────────────────────────────────────────────────────────────────────────────────
 *   ① ② ③ ④ ⑤ ⑥ ⑧ ⑨ ⑩ ⑬  —— 本文件，真跑。
 *   ⑦ ⑪ ⑫                —— `test.skip`，等 A 线（分支 feat/multitable-retype-fenced-writer-recheck：写入者栅栏后
 *                            复核助手 `assertFieldSchemaUnchangedAfterFence`、行 13 派生型复核、§3.12 自动化选项校验）。
 *                            本分支没有这些代码，这三条在这里写不出真断言——不伪造，A 线合入后补。
 * 另有两条不在十三条之内、但与迁移直接相关：CHECK 放宽的取值面、审批投影 `system_kind` 窄回填的证据绑定。
 *
 * ── 夹具 ───────────────────────────────────────────────────────────────────────────────────────────────
 * 每条用例自建一张表（id 带本次运行的唯一后缀），互不共享状态；`afterAll` 尽力清理本文件建的行（带 operation_id 的
 * 记录修订与 endpoint 行受库内不可变触发器保护，删不掉是预期的，id 唯一，留着无害）。
 * 「零写入」= 对该表的九个面各取一次快照、前后深相等：字段行、live 行、回收站行、记录修订、配置修订、前镜像、
 * 作业行、endpoint、审计行。
 *
 * fail-not-skip：哨兵在 DB 门控的 describe **外面**；真库步骤（METASHEET_REAL_DB_TEST_STEP=1）里没有 DATABASE_URL 就抛。
 */
import { randomUUID } from 'node:crypto'

import express, { type Express } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { db } from '../../src/db/db'
import { up as relaxTombstoneReason } from '../../src/db/migrations/zzzz20260928150000_relax_field_value_tombstone_reason_for_retype_convert'
import { up as createConversionsTable } from '../../src/db/migrations/zzzz20260928150100_create_meta_field_retype_conversions'
import { up as backfillApprovalProjectionKind } from '../../src/db/migrations/zzzz20260928150200_backfill_approval_projection_system_kind'
import { poolManager } from '../../src/integration/db/connection-pool'
import { APPROVAL_PROJECTION_BASE_ID } from '../../src/multitable/approval-projection-constants'
import { WRITER_BLOCK_STATES } from '../../src/multitable/canonical-sheet-fence'
import { __resetFieldRetypeConversionsTableProbe } from '../../src/multitable/field-retype-convert-execute'
import { sweepFieldValueTombstoneRetention } from '../../src/multitable/meta-revision-retention'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const CONVERT_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT'
const FENCE_FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const LEGACY_FLAG = 'MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA'
const TIER2_FLAG = 'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT'
const CONVERT_CONFIRM = 'convert-field-type'
const UNDO_CONFIRM = 'undo-field-type-convert'

export function defineFieldRetypeConvertRealDbCases(): void {
  test('field retype convert real-DB sentinel: the real-DB step must have DATABASE_URL (fail-not-skip)', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('METASHEET_REAL_DB_TEST_STEP=1 but DATABASE_URL is unset — the field retype convert real-DB cases would skip-green')
    }
  })

  // unique per module evaluation so two hosts in one process can never collide on ids
  const TS = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
  const BASE = `base_frc_${TS}`
  const ACTOR = `u_frc_actor_${TS}`
  const OTHER_ACTOR = `u_frc_other_${TS}`
  const PERMS = ['multitable:read', 'multitable:write', 'multitable:manage-schema']

  const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

  let app: Express
  let currentActor = ACTOR
  const as = (actorId: string) => { currentActor = actorId }

  const createdSheets: string[] = []
  const createdProjectionInstances: string[] = []
  let sheetCounter = 0

  interface Column {
    sheetId: string
    fieldId: string
    otherFieldId: string
    rec: (n: number) => string
  }

  /** A fresh sheet with a text column F, a second text column G, and the given rows (`n` → data). */
  async function seedColumn(rows: Array<[number, Record<string, unknown>]>, opts: { baseId?: string; property?: Record<string, unknown> } = {}): Promise<Column> {
    sheetCounter += 1
    const tag = `${TS}_${sheetCounter}`
    const column: Column = {
      sheetId: `sheet_frc_${tag}`,
      fieldId: `fld_frc_f_${tag}`,
      otherFieldId: `fld_frc_g_${tag}`,
      rec: (n: number) => `rec_frc_${tag}_${String(n).padStart(3, '0')}`,
    }
    createdSheets.push(column.sheetId)
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [column.sheetId, opts.baseId ?? BASE, column.sheetId])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [column.fieldId, column.sheetId, 'F', 'string', JSON.stringify(opts.property ?? {}), 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [column.otherFieldId, column.sheetId, 'G', 'string', '{}', 2])
    for (const [n, data] of rows) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [column.rec(n), column.sheetId, JSON.stringify(data), ACTOR])
    }
    return column
  }

  /** Database-side grants (user_permissions). The request's own `perms` are a separate thing and stay as they are. */
  const grant = async (userId: string, codes: string[]) => {
    for (const code of codes) await q('INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, code])
  }
  const revoke = (userId: string, codes: string[]) => q('DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = ANY($2::text[])', [userId, codes])

  const preview = (fieldId: string, targetType: string) => request(app).post(`/api/multitable/fields/${fieldId}/retype-preview`).send({ targetType })
  const execute = (fieldId: string, body: Record<string, unknown>) => request(app).post(`/api/multitable/fields/${fieldId}/retype-execute`).send(body)
  const undo = (fieldId: string, body: Record<string, unknown>) => request(app).post(`/api/multitable/fields/${fieldId}/retype-undo`).send(body)

  async function previewToken(fieldId: string, targetType: string): Promise<string> {
    const res = await preview(fieldId, targetType)
    expect(res.status).toBe(200)
    expect(res.body.data.verdict).toBe('ok')
    return String(res.body.data.previewToken)
  }

  /** preview → execute, both asserted; returns the conversion's anchor id. */
  async function convert(column: Column, targetType: string): Promise<string> {
    const token = await previewToken(column.fieldId, targetType)
    const res = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ fieldId: column.fieldId, sheetId: column.sheetId, sourceType: 'string', targetType, undo: { confirm: UNDO_CONFIRM } })
    return String(res.body.data.convertRevisionId)
  }

  /** Every surface a conversion or an undo can write, for one sheet. Compared before / after for "zero writes". */
  async function snapshot(column: Pick<Column, 'sheetId' | 'fieldId'>): Promise<Record<string, unknown>> {
    const { sheetId, fieldId } = column
    const rows = async (sql: string, params: unknown[]) => (await q(sql, params)).rows
    return {
      fields: await rows('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY id', [sheetId]),
      records: await rows('SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId]),
      trash: await rows('SELECT record_id, data FROM meta_records_trash WHERE sheet_id = $1 ORDER BY record_id', [sheetId]),
      recordRevisions: await rows('SELECT id::text AS id FROM meta_record_revisions WHERE sheet_id = $1 ORDER BY 1', [sheetId]),
      configRevisions: await rows('SELECT id::text AS id FROM meta_config_revisions WHERE sheet_id = $1 ORDER BY 1', [sheetId]),
      preImages: await rows('SELECT id::text AS id FROM meta_field_value_tombstones WHERE sheet_id = $1 ORDER BY 1', [sheetId]),
      conversions: await rows('SELECT convert_revision_id::text AS id, undone_at, undo_revision_id::text AS undo_id FROM meta_field_retype_conversions WHERE sheet_id = $1 ORDER BY 1', [sheetId]),
      endpoints: await rows('SELECT operation_id::text AS id FROM meta_record_history_operations WHERE sheet_id = $1 ORDER BY 1', [sheetId]),
      audit: await rows(`SELECT id::text AS id FROM operation_audit_logs WHERE resource_type = 'meta_field' AND resource_id = $1 ORDER BY 1`, [fieldId]),
    }
  }

  const fieldRow = async (fieldId: string) => (await q('SELECT type, property FROM meta_fields WHERE id = $1', [fieldId])).rows[0] as { type: string; property: Record<string, unknown> }
  const cellState = async (recordId: string, fieldId: string) =>
    (await q(`SELECT (data ? $2::text) AS has_key, jsonb_typeof(data -> $2::text) AS kind, data -> $2::text AS value, version FROM meta_records WHERE id = $1`, [recordId, fieldId])).rows[0] as { has_key: boolean; kind: string | null; value: unknown; version: number }

  const setBlock = async (sheetId: string, state: string | null) => {
    if (state === 'archiving') {
      await q(
        `UPDATE meta_sheets
            SET recovery_writer_state = 'archiving', recovery_writer_owner_kind = 'restore_job', recovery_writer_owner_id = $2,
                recovery_writer_owner_fence = 1, recovery_writer_lease_until = now() + interval '1 hour', recovery_writer_updated_at = now()
          WHERE id = $1`,
        [sheetId, `frc-${TS}`],
      )
      return
    }
    await q(
      `UPDATE meta_sheets
          SET recovery_writer_state = $2, recovery_writer_owner_kind = NULL, recovery_writer_owner_id = NULL,
              recovery_writer_owner_fence = NULL, recovery_writer_lease_until = NULL, recovery_writer_updated_at = NULL
        WHERE id = $1`,
      [sheetId, state],
    )
  }

  const SAVED_ENV: Record<string, string | undefined> = {}
  const FLAGS = [CONVERT_FLAG, FENCE_FLAG, LEGACY_FLAG, TIER2_FLAG, 'MULTITABLE_SHEET_REVERT_MAX_RECORDS', 'MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS', 'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED']

  describeIfDatabase('field retype convert — execute + whole-column undo (real DB, fence ON)', () => {
    beforeAll(async () => {
      // The feature's own migrations, applied again on top of whatever `db:migrate` already did: proves each one
      // runs on a real server AND is safe to apply twice.
      await relaxTombstoneReason(db as never)
      await createConversionsTable(db as never)
      await backfillApprovalProjectionKind(db as never)
      __resetFieldRetypeConversionsTableProbe()

      app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        ;(req as { user?: unknown }).user = { id: currentActor, roles: ['member'], perms: PERMS, permissions: PERMS }
        next()
      })
      app.use('/api/multitable', univerMetaRouter())

      // Execute and undo re-read the caller's authority FROM THE DATABASE inside their transaction (ADR addendum B),
      // so the actors need real rows: an active user and its permission grants. The request carries the same codes.
      for (const code of PERMS) {
        await q(`INSERT INTO permissions (code, name, description) VALUES ($1, $1, 'FRC test') ON CONFLICT (code) DO NOTHING`, [code])
      }
      for (const id of [ACTOR, OTHER_ACTOR]) {
        await q(
          `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
           VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
           ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = FALSE, role = 'user'`,
          [id, `${id}@example.test`],
        )
        await grant(id, PERMS)
      }
      await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'FRC Base'])
    })

    afterAll(async () => {
      for (const id of createdProjectionInstances) await q('DELETE FROM approval_record_projection WHERE instance_id = $1', [id]).catch(() => {})
      for (const sheetId of createdSheets) {
        await q('DELETE FROM meta_field_retype_conversions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records_trash WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId]).catch(() => {})
        await q('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
      }
      await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
      for (const id of [ACTOR, OTHER_ACTOR]) {
        await q('DELETE FROM user_permissions WHERE user_id = $1', [id]).catch(() => {})
        await q('DELETE FROM users WHERE id = $1', [id]).catch(() => {})
      }
    })

    beforeEach(() => {
      for (const name of FLAGS) SAVED_ENV[name] = process.env[name]
      process.env[CONVERT_FLAG] = 'true'
      process.env[FENCE_FLAG] = 'true'
      delete process.env[LEGACY_FLAG]
      delete process.env[TIER2_FLAG]
      delete process.env.MULTITABLE_SHEET_REVERT_MAX_RECORDS
      delete process.env.MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS
      // The conversion's pre-image is unconditional: leave the capture flag OFF on purpose.
      delete process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED
      as(ACTOR)
    })

    afterEach(() => {
      for (const name of FLAGS) {
        if (SAVED_ENV[name] === undefined) delete process.env[name]
        else process.env[name] = SAVED_ENV[name]
      }
    })

    test('sentinel: DATABASE_URL set', () => {
      expect(process.env.DATABASE_URL).toBeTruthy()
    })

    // ── migrations ─────────────────────────────────────────────────────────────────────────────────────
    test('migration: the tombstone reason CHECK accepts retype_convert and the two old values, and nothing else', async () => {
      const sheetId = `sheet_frc_chk_${TS}`
      const insert = (reason: string) => q(
        `INSERT INTO meta_field_value_tombstones (sheet_id, field_id, record_id, value, reason) VALUES ($1, 'f', 'r', '{"k":false,"v":null,"post":""}'::jsonb, $2)`,
        [sheetId, reason],
      )
      try {
        for (const reason of ['field_delete', 'lossy_retype', 'retype_convert']) await insert(reason)
        await expect(insert('retype_convert_v2')).rejects.toMatchObject({ code: '23514' })
        await expect(insert('')).rejects.toMatchObject({ code: '23514' })
        const n = (await q('SELECT count(*)::int AS c FROM meta_field_value_tombstones WHERE sheet_id = $1', [sheetId])).rows[0] as { c: number }
        expect(n.c).toBe(3)
        const checks = (await q(
          `SELECT conname, convalidated FROM pg_constraint con JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attname = 'reason' AND att.attnum = ANY (con.conkey)
            WHERE con.conrelid = 'meta_field_value_tombstones'::regclass AND con.contype = 'c'`,
        )).rows as Array<{ conname: string; convalidated: boolean }>
        expect(checks).toEqual([{ conname: 'meta_field_value_tombstones_reason_check', convalidated: true }])
      } finally {
        await q('DELETE FROM meta_field_value_tombstones WHERE sheet_id = $1', [sheetId]).catch(() => {})
      }
    })

    test('migration: the system_kind backfill is evidence-bound — only a NULL-kind sheet in the approval base WITH projection rows', async () => {
      const tag = `${TS}_bf`
      const inApprovalWithRows = `sheet_frc_bf_a_${tag}`
      const inApprovalNoRows = `sheet_frc_bf_b_${tag}`
      const elsewhereWithRows = `sheet_frc_bf_c_${tag}`
      const otherKindWithRows = `sheet_frc_bf_d_${tag}`
      const all = [inApprovalWithRows, inApprovalNoRows, elsewhereWithRows, otherKindWithRows]
      const project = async (sheetId: string) => {
        const instanceId = `apr_frc_${sheetId}`
        createdProjectionInstances.push(instanceId)
        await q(
          'INSERT INTO approval_record_projection (instance_id, base_id, sheet_id, record_id, projected_version) VALUES ($1,$2,$3,$4,1)',
          [instanceId, APPROVAL_PROJECTION_BASE_ID, sheetId, `rec_${sheetId}`],
        )
      }
      try {
        await q(`INSERT INTO meta_bases (id, name) VALUES ($1, 'Approval Records (system)') ON CONFLICT (id) DO NOTHING`, [APPROVAL_PROJECTION_BASE_ID])
        await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [inApprovalWithRows, APPROVAL_PROJECTION_BASE_ID, 'a'])
        await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [inApprovalNoRows, APPROVAL_PROJECTION_BASE_ID, 'b'])
        await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [elsewhereWithRows, BASE, 'c'])
        await q(`INSERT INTO meta_sheets (id, base_id, name, system_kind) VALUES ($1,$2,$3,'elearning_projection')`, [otherKindWithRows, APPROVAL_PROJECTION_BASE_ID, 'd'])
        await project(inApprovalWithRows)
        await project(elsewhereWithRows)
        await project(otherKindWithRows)
        const stamps = async () => (await q('SELECT id, system_kind, updated_at FROM meta_sheets WHERE id = ANY($1::text[]) ORDER BY id', [all])).rows as Array<{ id: string; system_kind: string | null; updated_at: unknown }>
        const before = await stamps()

        await backfillApprovalProjectionKind(db as never)
        const after = await stamps()
        const kindOf = (rows: typeof after, id: string) => rows.find((r) => r.id === id)?.system_kind ?? null
        expect(kindOf(after, inApprovalWithRows)).toBe('approval_projection')
        expect(kindOf(after, inApprovalNoRows)).toBeNull()
        expect(kindOf(after, elsewhereWithRows)).toBeNull()
        expect(kindOf(after, otherKindWithRows)).toBe('elearning_projection')
        // one column, nothing else: `updated_at` is not bumped on any of the four
        expect(after.map((r) => String(r.updated_at))).toEqual(before.map((r) => String(r.updated_at)))

        // applying it again changes nothing
        await backfillApprovalProjectionKind(db as never)
        expect(await stamps()).toEqual(after)
      } finally {
        for (const id of all) await q('DELETE FROM meta_sheets WHERE id = $1', [id]).catch(() => {})
      }
    })

    // ── ① ──────────────────────────────────────────────────────────────────────────────────────────────
    test('① retype-convert-execute-failure-rolls-back: a failure injected AFTER the rewrite leaves all nine surfaces unchanged', async () => {
      const column = await seedColumn([])
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA', [column.otherFieldId]: 'keep' }), ACTOR])
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [column.rec(2), column.sheetId, JSON.stringify({ [column.otherFieldId]: 'no key' }), ACTOR])
      const token = await previewToken(column.fieldId, 'multiSelect')
      const before = await snapshot(column)

      const fn = `ms_frc_boom_${TS}`
      // The job row is written after the pre-image, the field update, the cell rewrite, the record revisions and
      // the config revision — so a failure here is a failure "after the rewrite".
      await q(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $fn$ BEGIN IF NEW.sheet_id = '${column.sheetId}' THEN RAISE EXCEPTION 'ms-frc injected failure'; END IF; RETURN NEW; END; $fn$ LANGUAGE plpgsql`)
      await q(`CREATE TRIGGER ${fn}_trg BEFORE INSERT ON meta_field_retype_conversions FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
      try {
        const res = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
        expect(res.status).toBe(500)
        expect(res.body.error.code).toBe('INTERNAL_ERROR')
        expect(JSON.stringify(res.body)).not.toContain('VAL-ALPHA')
        expect(JSON.stringify(res.body)).not.toContain('injected')
      } finally {
        await q(`DROP TRIGGER IF EXISTS ${fn}_trg ON meta_field_retype_conversions`)
        await q(`DROP FUNCTION IF EXISTS ${fn}()`)
      }
      expect(await snapshot(column)).toEqual(before)

      // and the very same token still converts once the failure is gone — the rollback left no residue
      const again = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
      expect(again.status).toBe(200)
    })

    // ── ② ──────────────────────────────────────────────────────────────────────────────────────────────
    test('② retype-convert-refuses-during-recovery: every writer-block state (incl. archiving) ⇒ 409 RECOVERY_IN_PROGRESS, zero writes — execute and undo', async () => {
      expect([...WRITER_BLOCK_STATES].sort()).toEqual(['applying', 'archiving', 'fencing', 'paused_retryable'])
      const column = await seedColumn([[1, {}]])
      await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [column.rec(1), JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
      const token = await previewToken(column.fieldId, 'select')
      for (const state of WRITER_BLOCK_STATES) {
        await setBlock(column.sheetId, state)
        const before = await snapshot(column)
        const res = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
        expect([state, res.status, res.body.error?.code]).toEqual([state, 409, 'RECOVERY_IN_PROGRESS'])
        expect(await snapshot(column)).toEqual(before)
      }
      await setBlock(column.sheetId, null)
      const convertRevisionId = await convert(column, 'select')
      for (const state of WRITER_BLOCK_STATES) {
        await setBlock(column.sheetId, state)
        const before = await snapshot(column)
        const res = await undo(column.fieldId, { convertRevisionId, confirm: UNDO_CONFIRM })
        expect([state, res.status, res.body.error?.code]).toEqual([state, 409, 'RECOVERY_IN_PROGRESS'])
        expect(await snapshot(column)).toEqual(before)
      }
      await setBlock(column.sheetId, null)
      expect((await undo(column.fieldId, { convertRevisionId, confirm: UNDO_CONFIRM })).status).toBe(200)
    })

    // ── ③ ──────────────────────────────────────────────────────────────────────────────────────────────
    test('③ retype-convert-plan-drift: a cell / a row added / a row removed / a recycle-bin row added or removed after preview ⇒ 409 PLAN_DRIFT, zero writes', async () => {
      const drifts: Array<[string, (c: Column) => Promise<void>]> = [
        ['a cell edited', (c) => q('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], $3::jsonb, true) WHERE id = $1', [c.rec(1), c.fieldId, JSON.stringify('VAL-EDITED')]).then(() => undefined)],
        ['a cell edited to the same text, version bumped', (c) => q('UPDATE meta_records SET version = version + 1 WHERE id = $1', [c.rec(1)]).then(() => undefined)],
        ['a row added', (c) => q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [c.rec(9), c.sheetId, JSON.stringify({ [c.fieldId]: 'VAL-NEW' })]).then(() => undefined)],
        ['a row removed', (c) => q('DELETE FROM meta_records WHERE id = $1', [c.rec(2)]).then(() => undefined)],
        ['a recycle-bin row added', (c) => q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [c.rec(8), c.sheetId, JSON.stringify({ [c.otherFieldId]: 'trashed' })]).then(() => undefined)],
        ['a recycle-bin row removed', (c) => q('DELETE FROM meta_records_trash WHERE record_id = $1', [c.rec(7)]).then(() => undefined)],
        ['the field property changed', (c) => q(`UPDATE meta_fields SET property = '{"description":"changed"}'::jsonb WHERE id = $1`, [c.fieldId]).then(() => undefined)],
      ]
      for (const [label, drift] of drifts) {
        const column = await seedColumn([])
        await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
        await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(2), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-BETA' })])
        await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [column.rec(7), column.sheetId, JSON.stringify({ [column.fieldId]: '' })])
        const token = await previewToken(column.fieldId, 'multiSelect')
        await drift(column)
        const before = await snapshot(column)
        const res = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
        expect([label, res.status, res.body.error?.code]).toEqual([label, 409, 'PLAN_DRIFT'])
        expect(JSON.stringify(res.body)).not.toMatch(/VAL-/)
        expect([label, await snapshot(column)]).toEqual([label, before])
      }
    })

    // ── ④ ──────────────────────────────────────────────────────────────────────────────────────────────
    test('④ retype-convert-anchor-resolves-and-undo-exact: one id resolves all three halves; the undo restores the four empty states exactly', async () => {
      const column = await seedColumn([])
      const F = column.fieldId
      const G = column.otherFieldId
      const seed: Array<[number, Record<string, unknown>]> = [
        [1, { [F]: 'VAL-ALPHA', [G]: 'keep-1' }],
        [2, { [F]: 'VAL-BETA, with a comma' }],
        [3, { [G]: 'no key at all' }],
        [4, { [F]: null }],
        [5, { [F]: '' }],
        [6, { [F]: 'VAL-ALPHA' }],
      ]
      for (const [n, data] of seed) await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [column.rec(n), column.sheetId, JSON.stringify(data), ACTOR])
      const original = await fieldRow(F)

      const token = await previewToken(F, 'multiSelect')
      const res = await execute(F, { previewToken: token, confirm: CONVERT_CONFIRM })
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ recordCount: 6, cells: { rewritten: 6, unchanged: 0 }, options: { final: 2, droppedValidationRuleCount: 0 } })
      expect(JSON.stringify(res.body)).not.toMatch(/VAL-/)
      const id = String(res.body.data.convertRevisionId)

      // the field
      const converted = await fieldRow(F)
      expect(converted.type).toBe('multiSelect')
      expect(converted.property.options).toEqual([{ value: 'VAL-ALPHA' }, { value: 'VAL-BETA, with a comma' }])

      // the cells — "A,B" is ONE option of length 1
      expect((await cellState(column.rec(1), F)).value).toEqual(['VAL-ALPHA'])
      expect((await cellState(column.rec(2), F)).value).toEqual(['VAL-BETA, with a comma'])
      for (const n of [3, 4, 5]) expect([n, (await cellState(column.rec(n), F)).value]).toEqual([n, []])
      expect((await q('SELECT data -> $2::text AS g FROM meta_records WHERE id = $1', [column.rec(1), G])).rows[0]).toEqual({ g: 'keep-1' })

      // config half
      const config = (await q('SELECT id::text AS id, entity_type, entity_id, action, changed_keys, source, batch_id, operation_id, before, after FROM meta_config_revisions WHERE id = $1::uuid', [id])).rows
      expect(config).toHaveLength(1)
      expect(config[0]).toMatchObject({ entity_type: 'field', entity_id: F, action: 'update', changed_keys: ['type', 'property'], source: 'mutation', batch_id: id, operation_id: null })
      expect((config[0] as { before: { type: string } }).before.type).toBe('string')
      expect((config[0] as { after: { type: string } }).after.type).toBe('multiSelect')

      // pre-image: one row per LIVE record (empty and unchanged included), the envelope, never tagged
      const preImages = (await q(`SELECT record_id, value, reason, operation_id FROM meta_field_value_tombstones WHERE config_revision_id = $1::uuid ORDER BY record_id`, [id])).rows as Array<{ record_id: string; value: unknown; reason: string; operation_id: string | null }>
      expect(preImages.map((p) => [p.record_id, p.reason, p.operation_id])).toEqual(seed.map(([n]) => [column.rec(n), 'retype_convert', null]))
      expect(preImages.map((p) => p.value)).toEqual([
        { k: true, v: 'VAL-ALPHA', post: ['VAL-ALPHA'] },
        { k: true, v: 'VAL-BETA, with a comma', post: ['VAL-BETA, with a comma'] },
        { k: false, v: null, post: [] },
        { k: true, v: null, post: [] },
        { k: true, v: '', post: [] },
        { k: true, v: 'VAL-ALPHA', post: ['VAL-ALPHA'] },
      ])

      // record half: exactly one revision per bumped row, at the new version, with the post-write snapshot
      const revisions = (await q(`SELECT record_id, version, action, source, changed_field_ids, patch, snapshot, operation_id::text AS operation_id, seq::text AS seq FROM meta_record_revisions WHERE sheet_id = $1 AND batch_id = $2 ORDER BY record_id`, [column.sheetId, id])).rows as Array<Record<string, unknown>>
      expect(revisions.map((r) => [r.record_id, r.version, r.action, r.source, r.changed_field_ids])).toEqual(seed.map(([n]) => [column.rec(n), 2, 'update', 'retype-convert', [F]]))
      expect(revisions[0]).toMatchObject({ patch: { [F]: ['VAL-ALPHA'] }, snapshot: { [F]: ['VAL-ALPHA'], [G]: 'keep-1' } })
      expect(revisions[2]).toMatchObject({ patch: { [F]: [] }, snapshot: { [F]: [], [G]: 'no key at all' } })
      const operationIds = [...new Set(revisions.map((r) => r.operation_id))]
      expect(operationIds).toHaveLength(1)
      expect(operationIds[0]).toBeTruthy()
      for (const [n] of seed) {
        expect((await cellState(column.rec(n), F)).version).toBe(2)
        const occupants = (await q('SELECT count(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND version = 2', [column.sheetId, column.rec(n)])).rows[0] as { c: number }
        expect([n, occupants.c]).toEqual([n, 1])
      }

      // the sealed endpoint agrees with the events
      const endpoint = (await q('SELECT event_count, endpoint_seq::text AS endpoint_seq FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid', [column.sheetId, operationIds[0]])).rows[0] as { event_count: number; endpoint_seq: string }
      const maxSeq = revisions.map((r) => BigInt(String(r.seq))).reduce((a, b) => (a > b ? a : b))
      expect(endpoint).toEqual({ event_count: 6, endpoint_seq: maxSeq.toString() })

      // the job row and the audit row
      const job = (await q('SELECT source_type, target_type, record_count, undone_at, undo_revision_id FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid', [id])).rows[0]
      expect(job).toEqual({ source_type: 'string', target_type: 'multiSelect', record_count: 6, undone_at: null, undo_revision_id: null })
      const audit = (await q(`SELECT action, metadata FROM operation_audit_logs WHERE resource_type = 'meta_field' AND resource_id = $1`, [F])).rows as Array<{ action: string; metadata: Record<string, unknown> }>
      expect(audit.map((a) => a.action)).toEqual(['multitable.field.retype-convert'])
      expect(audit[0].metadata).toMatchObject({ convertRevisionId: id, recordCount: 6, rewrittenRecordCount: 6, optionCount: 2 })
      expect(JSON.stringify(audit)).not.toMatch(/VAL-/)

      // ── after the conversion: each of these refuses the undo, with zero writes ──────────────────────
      const refused = async (label: string, reason: string, mutate: () => Promise<unknown>, revert: () => Promise<unknown>, details?: Record<string, unknown>) => {
        await mutate()
        const before = await snapshot(column)
        const r = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })
        expect([label, r.status, r.body.error?.code, r.body.error?.details?.reason]).toEqual([label, 409, 'UNDO_PRECONDITION_FAILED', reason])
        if (details) expect(r.body.error.details).toMatchObject(details)
        expect(r.body.error.message).not.toContain('rec_frc_')
        expect(JSON.stringify(r.body)).not.toMatch(/VAL-/)
        expect([label, await snapshot(column)]).toEqual([label, before])
        await revert()
      }
      await refused('a record added', 'record_set_changed',
        () => q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(9), column.sheetId, JSON.stringify({ [F]: ['VAL-ALPHA'] })]),
        () => q('DELETE FROM meta_records WHERE id = $1', [column.rec(9)]),
        { recordCount: 1, recordIds: [column.rec(9)], added: { recordCount: 1, recordIds: [column.rec(9)] }, removed: { recordCount: 0, recordIds: [] } })
      const kept = (await q('SELECT id, sheet_id, data, version, created_by FROM meta_records WHERE id = $1', [column.rec(6)])).rows[0] as { data: unknown; version: number; created_by: string }
      await refused('a record deleted', 'record_set_changed',
        () => q('DELETE FROM meta_records WHERE id = $1', [column.rec(6)]),
        () => q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,$4,$5)', [column.rec(6), column.sheetId, JSON.stringify(kept.data), kept.version, kept.created_by]),
        { recordCount: 1, recordIds: [column.rec(6)], removed: { recordCount: 1, recordIds: [column.rec(6)] } })
      await refused('a cell of this column edited', 'cells_changed',
        () => q('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], $3::jsonb, true) WHERE id = $1', [column.rec(1), F, JSON.stringify(['VAL-ALPHA', 'VAL-BETA, with a comma'])]),
        () => q('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], $3::jsonb, true) WHERE id = $1', [column.rec(1), F, JSON.stringify(['VAL-ALPHA'])]),
        { recordCount: 1, recordIds: [column.rec(1)] })
      await refused('the field configuration changed', 'field_config_changed',
        () => q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [F, JSON.stringify({ ...converted.property, options: [{ value: 'VAL-ALPHA', color: 'red' }, { value: 'VAL-BETA, with a comma' }] })]),
        () => q('UPDATE meta_fields SET property = $2::jsonb WHERE id = $1', [F, JSON.stringify(converted.property)]))

      // no force-override path exists: an extra key is a 400, not a way through
      for (const extra of [{ force: true }, { override: true }, { recordIds: [column.rec(1)] }, { partial: true }]) {
        await q('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], $3::jsonb, true) WHERE id = $1', [column.rec(1), F, JSON.stringify(['VAL-BETA, with a comma'])])
        const before = await snapshot(column)
        const r = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM, ...extra })
        expect([Object.keys(extra)[0], r.status, r.body.error?.code]).toEqual([Object.keys(extra)[0], 400, 'VALIDATION_ERROR'])
        expect(await snapshot(column)).toEqual(before)
        await q('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], $3::jsonb, true) WHERE id = $1', [column.rec(1), F, JSON.stringify(['VAL-ALPHA'])])
      }

      // an edit of ANOTHER column does not block the undo (③ compares the value, not the version)
      await q('UPDATE meta_records SET data = jsonb_set(data, ARRAY[$2::text], $3::jsonb, true), version = version + 1 WHERE id = $1', [column.rec(2), G, JSON.stringify('edited-after')])

      const undone = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })
      expect(undone.status).toBe(200)
      expect(undone.body.data).toMatchObject({ convertRevisionId: id, fieldId: F, restoredType: 'string', recordCount: 6, cells: { restored: 6, unchanged: 0 } })
      expect(JSON.stringify(undone.body)).not.toMatch(/VAL-/)
      const undoId = String(undone.body.data.undoRevisionId)

      expect(await fieldRow(F)).toEqual(original)
      // four states, exactly
      expect(await cellState(column.rec(1), F)).toMatchObject({ has_key: true, kind: 'string', value: 'VAL-ALPHA' })
      expect(await cellState(column.rec(3), F)).toMatchObject({ has_key: false, kind: null })
      expect(await cellState(column.rec(4), F)).toMatchObject({ has_key: true, kind: 'null' })
      expect(await cellState(column.rec(5), F)).toMatchObject({ has_key: true, kind: 'string', value: '' })
      expect((await q(`SELECT (data -> $2::text) = '""'::jsonb AS is_empty_string FROM meta_records WHERE id = $1`, [column.rec(5), F])).rows[0]).toEqual({ is_empty_string: true })
      // the other column's later edit survived
      expect((await q('SELECT data -> $2::text AS g, version FROM meta_records WHERE id = $1', [column.rec(2), G])).rows[0]).toEqual({ g: 'edited-after', version: 4 })

      const undoRevisions = (await q('SELECT record_id, version, source, patch, snapshot FROM meta_record_revisions WHERE sheet_id = $1 AND batch_id = $2 ORDER BY record_id', [column.sheetId, undoId])).rows as Array<{ record_id: string; version: number; source: string; patch: Record<string, unknown>; snapshot: Record<string, unknown> }>
      expect(undoRevisions.map((r) => [r.record_id, r.source])).toEqual(seed.map(([n]) => [column.rec(n), 'retype-convert-undo']))
      // key removed ⇒ the null sentinel in the patch and NO key in the snapshot
      expect(undoRevisions[2].patch).toEqual({ [F]: null })
      expect(Object.prototype.hasOwnProperty.call(undoRevisions[2].snapshot, F)).toBe(false)
      // JSON null restored ⇒ the same patch, but the key is present in the snapshot
      expect(undoRevisions[3].patch).toEqual({ [F]: null })
      expect(Object.prototype.hasOwnProperty.call(undoRevisions[3].snapshot, F)).toBe(true)
      expect(undoRevisions[3].snapshot[F]).toBeNull()

      const undoConfig = (await q('SELECT source, restored_from_id::text AS restored_from_id, changed_keys, batch_id, operation_id FROM meta_config_revisions WHERE id = $1::uuid', [undoId])).rows[0]
      expect(undoConfig).toEqual({ source: 'restore', restored_from_id: id, changed_keys: ['type', 'property'], batch_id: undoId, operation_id: null })
      const jobAfter = (await q('SELECT undone_at IS NOT NULL AS undone, undo_revision_id::text AS undo_id FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid', [id])).rows[0]
      expect(jobAfter).toEqual({ undone: true, undo_id: undoId })

      // there is no undo of the undo, and no second undo
      const beforeSecond = await snapshot(column)
      const second = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })
      expect([second.status, second.body.error?.code]).toEqual([409, 'ALREADY_UNDONE'])
      const undoOfUndo = await undo(F, { convertRevisionId: undoId, confirm: UNDO_CONFIRM })
      expect([undoOfUndo.status, undoOfUndo.body.error?.code]).toEqual([404, 'NOT_FOUND'])
      expect(await snapshot(column)).toEqual(beforeSecond)
    })

    test('④ string → select: a cell that already holds its target value is not touched, not bumped, and gets no revision — in either direction', async () => {
      const column = await seedColumn([])
      const F = column.fieldId
      const seed: Array<[number, Record<string, unknown>]> = [
        [1, { [F]: 'VAL-ALPHA' }],
        [2, { [F]: '' }],
        [3, {}],
        [4, { [F]: null }],
      ]
      for (const [n, data] of seed) await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(n), column.sheetId, JSON.stringify(data)])
      const id = await convert(column, 'select')
      expect((await q('SELECT count(*)::int AS c FROM meta_field_value_tombstones WHERE config_revision_id = $1::uuid', [id])).rows[0]).toEqual({ c: 4 })
      expect((await q('SELECT record_id FROM meta_record_revisions WHERE sheet_id = $1 AND batch_id = $2 ORDER BY record_id', [column.sheetId, id])).rows).toEqual([{ record_id: column.rec(3) }, { record_id: column.rec(4) }])
      expect(await Promise.all([1, 2, 3, 4].map(async (n) => (await cellState(column.rec(n), F)).version))).toEqual([1, 1, 2, 2])
      expect(await Promise.all([3, 4].map(async (n) => (await cellState(column.rec(n), F)).value))).toEqual(['', ''])

      const undone = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })
      expect(undone.status).toBe(200)
      expect(undone.body.data.cells).toEqual({ restored: 2, unchanged: 2 })
      expect(await Promise.all([1, 2, 3, 4].map(async (n) => (await cellState(column.rec(n), F)).version))).toEqual([1, 1, 3, 3])
      expect(await cellState(column.rec(3), F)).toMatchObject({ has_key: false })
      expect(await cellState(column.rec(4), F)).toMatchObject({ has_key: true, kind: 'null' })
      expect((await fieldRow(F)).type).toBe('string')
    })

    test('④ an empty sheet converts: a job row, no endpoint, and the conversion can be undone', async () => {
      const column = await seedColumn([])
      const id = await convert(column, 'multiSelect')
      expect((await q('SELECT record_count FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid', [id])).rows).toEqual([{ record_count: 0 }])
      expect((await q('SELECT count(*)::int AS c FROM meta_record_history_operations WHERE sheet_id = $1', [column.sheetId])).rows[0]).toEqual({ c: 0 })
      expect((await q('SELECT count(*)::int AS c FROM meta_field_value_tombstones WHERE config_revision_id = $1::uuid', [id])).rows[0]).toEqual({ c: 0 })
      expect((await fieldRow(column.fieldId)).type).toBe('multiSelect')
      const undone = await undo(column.fieldId, { convertRevisionId: id, confirm: UNDO_CONFIRM })
      expect(undone.status).toBe(200)
      expect((await fieldRow(column.fieldId)).type).toBe('string')
      expect((await q('SELECT count(*)::int AS c FROM meta_record_history_operations WHERE sheet_id = $1', [column.sheetId])).rows[0]).toEqual({ c: 0 })
    })

    // ── ⑤ ──────────────────────────────────────────────────────────────────────────────────────────────
    test('⑤ retype-convert-pre-image-expired: after the REAL retention sweep removed the pre-image, the undo answers 409 PRE_IMAGE_EXPIRED, zero writes', async () => {
      const column = await seedColumn([])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(2), column.sheetId, JSON.stringify({})])
      const id = await convert(column, 'multiSelect')
      // age this conversion's pre-image past the (minimum, 30-day) window, then run the production sweep
      await q(`UPDATE meta_field_value_tombstones SET created_at = now() - interval '400 days' WHERE config_revision_id = $1::uuid`, [id])
      const pruned = await sweepFieldValueTombstoneRetention(
        (sql, params) => q(sql, params) as never,
        { enabled: true, policy: 'keep-days', keepN: 200, retentionDays: 30, batchSize: 5000 },
      )
      expect(pruned).toBeGreaterThanOrEqual(2)
      expect((await q('SELECT count(*)::int AS c FROM meta_field_value_tombstones WHERE config_revision_id = $1::uuid', [id])).rows[0]).toEqual({ c: 0 })

      const before = await snapshot(column)
      const res = await undo(column.fieldId, { convertRevisionId: id, confirm: UNDO_CONFIRM })
      expect([res.status, res.body.error?.code]).toEqual([409, 'PRE_IMAGE_EXPIRED'])
      expect(res.body.error.details).toBeUndefined()
      expect(await snapshot(column)).toEqual(before)
      // the job row outlives its pre-image: the answer is "expired", never "not found"
      expect((await q('SELECT undone_at FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid', [id])).rows).toEqual([{ undone_at: null }])
    })

    // ── ⑥ ──────────────────────────────────────────────────────────────────────────────────────────────
    test('⑥ retype-convert-blocks-tier2-config-restore: the conversion revision and the undo revision are both 422 on config-restore preview and execute, zero writes', async () => {
      process.env[TIER2_FLAG] = 'true'
      const column = await seedColumn([])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
      const convertId = await convert(column, 'select')

      const restorePreview = (revisionId: string) => request(app).post(`/api/multitable/sheets/${column.sheetId}/config-restore-preview`).send({ revisionId })
      const restoreExecute = (revisionId: string) => request(app).post(`/api/multitable/sheets/${column.sheetId}/config-restore-execute`).send({ revisionId, previewToken: 'not-a-token' })
      const expectRefused = async (label: string, revisionId: string) => {
        const before = await snapshot(column)
        for (const [kind, call] of [['preview', restorePreview], ['execute', restoreExecute]] as const) {
          const res = await call(revisionId)
          expect([label, kind, res.status, res.body.error?.code, res.body.error?.details?.reason]).toEqual([label, kind, 422, 'RESTORE_NOT_SUPPORTED', 'field_retype_conversion'])
          expect(res.body.data?.previewToken).toBeUndefined()
          expect(JSON.stringify(res.body)).not.toMatch(/VAL-/)
        }
        expect([label, await snapshot(column)]).toEqual([label, before])
      }
      await expectRefused('conversion revision, before the undo', convertId)

      const undone = await undo(column.fieldId, { convertRevisionId: convertId, confirm: UNDO_CONFIRM })
      expect(undone.status).toBe(200)
      const undoId = String(undone.body.data.undoRevisionId)
      await expectRefused('conversion revision, after the undo', convertId)
      await expectRefused('undo revision', undoId)

      // control: an ORDINARY retype revision on the same sheet is still previewable — the refusal is keyed on the job table
      const ordinary = ((await q(
        `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, before, after, changed_keys, actor_id)
         VALUES ($1,'field',$2,'update',$3::jsonb,$4::jsonb,$5,$6) RETURNING id::text AS id`,
        [column.sheetId, column.otherFieldId, JSON.stringify({ type: 'longText' }), JSON.stringify({ type: 'string' }), ['type'], ACTOR],
      )).rows[0] as { id: string }).id
      const control = await restorePreview(ordinary)
      expect(control.status).toBe(200)
      expect(typeof control.body.data.previewToken).toBe('string')
    })

    // ── ⑦ ── depends on track A ─────────────────────────────────────────────────────────────────────────
    // TODO(track A — branch feat/multitable-retype-fenced-writer-recheck): un-skip when the fenced-writer re-check
    // helper `assertFieldSchemaUnchangedAfterFence` is merged. Needs the seven 必接 fence holders of ADR §3.11 rows
    // 1-7 (bulk patch / plugin patch / plugin create / REST + OAPI single patch / form EDIT + CREATE / automation
    // update + create / approval resultWriteback) each parked behind the conversion's fence and answering 409
    // FIELD_SCHEMA_CHANGED after it commits. This branch carries none of that wiring, so nothing here could be asserted.
    test.skip('⑦ retype-convert-concurrent-writer: the seven 必接 fence holders re-check the field after the fence (track A)', () => {})

    // ── ⑧ ──────────────────────────────────────────────────────────────────────────────────────────────
    test('⑧ retype-convert-foreign-id: another sheet\'s convertRevisionId ⇒ 404, another field\'s or another actor\'s token ⇒ 401, zero writes', async () => {
      const a = await seedColumn([])
      const b = await seedColumn([])
      for (const c of [a, b]) await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [c.rec(1), c.sheetId, JSON.stringify({ [c.fieldId]: 'VAL-ALPHA', [c.otherFieldId]: 'VAL-OTHER' })])

      // tokens: for a's OTHER text column, for b's column, and for a's column but minted for another actor
      const tokenOtherField = await previewToken(a.otherFieldId, 'select')
      const tokenOtherSheet = await previewToken(b.fieldId, 'select')
      as(OTHER_ACTOR)
      const tokenOtherActor = await previewToken(a.fieldId, 'select')
      as(ACTOR)
      const beforeA = await snapshot(a)
      const beforeB = await snapshot(b)
      for (const [label, token] of [['another field', tokenOtherField], ['another sheet', tokenOtherSheet], ['another actor', tokenOtherActor], ['not a token', 'x.y.z']] as const) {
        const res = await execute(a.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
        expect([label, res.status, res.body.error?.code]).toEqual([label, 401, 'PREVIEW_IDENTITY_INVALID'])
        expect(res.body.error.details).toBeUndefined()
      }
      expect(await snapshot(a)).toEqual(beforeA)
      expect(await snapshot(b)).toEqual(beforeB)

      // undo: B's conversion presented on A's column, and on A's OTHER column
      const idB = await convert(b, 'select')
      const idA = await convert(a, 'select')
      const beforeUndoA = await snapshot(a)
      const beforeUndoB = await snapshot(b)
      for (const [label, fieldId, id] of [
        ['B\'s id on A\'s column', a.fieldId, idB],
        ['A\'s id on A\'s other column', a.otherFieldId, idA],
        ['an id that does not exist', a.fieldId, randomUUID()],
      ] as const) {
        const res = await undo(fieldId, { convertRevisionId: id, confirm: UNDO_CONFIRM })
        expect([label, res.status, res.body.error?.code]).toEqual([label, 404, 'NOT_FOUND'])
        expect(JSON.stringify(res.body)).not.toContain(id)
      }
      expect(await snapshot(a)).toEqual(beforeUndoA)
      expect(await snapshot(b)).toEqual(beforeUndoB)
      // and each id still undoes its own column
      expect((await undo(a.fieldId, { convertRevisionId: idA, confirm: UNDO_CONFIRM })).status).toBe(200)
      expect((await undo(b.fieldId, { convertRevisionId: idB, confirm: UNDO_CONFIRM })).status).toBe(200)
    })

    // ── ⑨ ──────────────────────────────────────────────────────────────────────────────────────────────
    test('⑨ a dead sheet ⇒ 404 on all three endpoints; fence OFF ⇒ 409 on execute and undo (preview still answers); legacy flag ON ⇒ 409 on all three — zero writes', async () => {
      const column = await seedColumn([])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
      const token = await previewToken(column.fieldId, 'select')
      const probe = randomUUID()
      const three = async () => [
        await preview(column.fieldId, 'select'),
        await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM }),
        await undo(column.fieldId, { convertRevisionId: probe, confirm: UNDO_CONFIRM }),
      ]

      // fence OFF
      delete process.env[FENCE_FLAG]
      let before = await snapshot(column)
      let [p, e, u] = await three()
      expect(p.status).toBe(200)
      for (const res of [e, u]) expect([res.status, res.body.error?.code, res.body.error?.details?.reason]).toEqual([409, 'FIELD_RETYPE_TRUST_REQUIRED', 'writer_fence_disabled'])
      expect(await snapshot(column)).toEqual(before)
      process.env[FENCE_FLAG] = 'true'

      // legacy manage-schema flag ON
      process.env[LEGACY_FLAG] = 'true'
      before = await snapshot(column)
      ;[p, e, u] = await three()
      for (const res of [p, e, u]) expect([res.status, res.body.error?.code, res.body.error?.details?.reason]).toEqual([409, 'FIELD_RETYPE_TRUST_REQUIRED', 'legacy_manage_schema_flag'])
      expect(await snapshot(column)).toEqual(before)
      delete process.env[LEGACY_FLAG]

      // the conversion flag itself OFF
      delete process.env[CONVERT_FLAG]
      before = await snapshot(column)
      ;[p, e, u] = await three()
      for (const res of [p, e, u]) expect([res.status, res.body.error?.code]).toEqual([403, 'FIELD_RETYPE_CONVERT_DISABLED'])
      expect(await snapshot(column)).toEqual(before)
      process.env[CONVERT_FLAG] = 'true'

      // dead sheet (soft-deleted), then absent
      await q('UPDATE meta_sheets SET deleted_at = now() WHERE id = $1', [column.sheetId])
      before = await snapshot(column)
      ;[p, e, u] = await three()
      for (const res of [p, e, u]) expect([res.status, res.body.error?.code]).toEqual([404, 'SHEET_DELETED'])
      expect(await snapshot(column)).toEqual(before)
      await q('UPDATE meta_sheets SET deleted_at = NULL WHERE id = $1', [column.sheetId])
      expect((await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })).status).toBe(200)
    })

    // ── ⑩ ──────────────────────────────────────────────────────────────────────────────────────────────
    test('⑩ retype-convert-undo-refuses-trashed-post-state: a recycle-bin row carrying ["X"] blocks the undo; [] / \'\' / a string do not; restoring the row breaks the record set', async () => {
      const column = await seedColumn([])
      const F = column.fieldId
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [column.rec(1), column.sheetId, JSON.stringify({ [F]: 'VAL-X' }), ACTOR])
      const id = await convert(column, 'multiSelect')

      // through the product: create a row holding ["VAL-X"], then delete it into the recycle bin
      const created = await request(app).post('/api/multitable/records').send({ sheetId: column.sheetId, data: { [F]: ['VAL-X'] } })
      expect(created.status).toBe(200)
      const newId = String(created.body.data.record.id)
      expect((await request(app).delete(`/api/multitable/records/${newId}`)).status).toBe(200)
      expect((await q('SELECT data -> $2::text AS v FROM meta_records_trash WHERE record_id = $1', [newId, F])).rows).toEqual([{ v: ['VAL-X'] }])

      let before = await snapshot(column)
      let res = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })
      expect([res.status, res.body.error?.code, res.body.error?.details]).toEqual([409, 'UNDO_PRECONDITION_FAILED', { reason: 'trashed_rows_with_post_state', recordCount: 1, recordIds: [newId] }])
      expect(JSON.stringify(res.body)).not.toMatch(/VAL-/)
      expect(await snapshot(column)).toEqual(before)

      // restoring that row puts it back among the live rows ⇒ the record set no longer equals the pre-image set
      expect((await request(app).post(`/api/multitable/records/${newId}/restore`)).status).toBe(200)
      before = await snapshot(column)
      res = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })
      expect([res.status, res.body.error?.code, res.body.error?.details?.reason, res.body.error?.details?.added]).toEqual([409, 'UNDO_PRECONDITION_FAILED', 'record_set_changed', { recordCount: 1, recordIds: [newId] }])
      expect(await snapshot(column)).toEqual(before)
      await q('DELETE FROM meta_records WHERE id = $1', [newId])

      // shapes a text column can hold are let through: [] / '' / JSON null / no key / a string
      const shapes: Array<[string, Record<string, unknown>]> = [['empty-array', { [F]: [] }], ['empty-string', { [F]: '' }], ['json-null', { [F]: null }], ['no-key', {}], ['string', { [F]: 'VAL-TEXT' }]]
      for (const [label, data] of shapes) await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [`rec_frc_trash_${label}_${TS}`, column.sheetId, JSON.stringify(data)])
      // …and every other non-string shape blocks
      const blocking: Array<[string, unknown]> = [['number', 7], ['boolean', true], ['object', { a: 1 }], ['array-of-two', ['VAL-X', 'VAL-Y']]]
      for (const [label, value] of blocking) {
        const recordId = `rec_frc_trash_${label}_${TS}`
        await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [recordId, column.sheetId, JSON.stringify({ [F]: value })])
        const r = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })
        expect([label, r.status, r.body.error?.details]).toEqual([label, 409, { reason: 'trashed_rows_with_post_state', recordCount: 1, recordIds: [recordId] }])
        await q('DELETE FROM meta_records_trash WHERE record_id = $1', [recordId])
      }
      const passed = await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })
      expect(passed.status).toBe(200)
      expect(await cellState(column.rec(1), F)).toMatchObject({ has_key: true, kind: 'string', value: 'VAL-X' })
    })

    test('⑩ select target: a recycle-bin row holding the string post-state does not block the undo', async () => {
      const column = await seedColumn([])
      const F = column.fieldId
      await q('INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)', [column.rec(1), column.sheetId, JSON.stringify({ [F]: 'VAL-X' }), ACTOR])
      const id = await convert(column, 'select')
      const created = await request(app).post('/api/multitable/records').send({ sheetId: column.sheetId, data: { [F]: 'VAL-X' } })
      expect(created.status).toBe(200)
      const newId = String(created.body.data.record.id)
      expect((await request(app).delete(`/api/multitable/records/${newId}`)).status).toBe(200)
      expect((await q('SELECT data -> $2::text AS v FROM meta_records_trash WHERE record_id = $1', [newId, F])).rows).toEqual([{ v: 'VAL-X' }])
      expect((await undo(F, { convertRevisionId: id, confirm: UNDO_CONFIRM })).status).toBe(200)
      expect((await fieldRow(F)).type).toBe('string')
    })

    // ── ⑪ ⑫ ── depend on track A ────────────────────────────────────────────────────────────────────────
    // TODO(track A — branch feat/multitable-retype-fenced-writer-recheck, ADR §3.12): un-skip when the automation
    // `update_record` / `create_record` option validation is merged. On this branch those two writers still bypass
    // every record-write validator, so "a non-option string is refused" would assert behaviour that does not exist.
    test.skip('⑪ retype-convert-unvalidated-writers-refused: automation update_record / create_record refuse a non-option value (track A, §3.12)', () => {})
    // TODO(track A — branch feat/multitable-retype-fenced-writer-recheck, ADR §3.11 row 13): un-skip when the
    // non-scoped derived merge re-reads the key types after the fence. Needs a second session parked on the fence.
    test.skip('⑫ retype-convert-derived-merge-refused: a queued non-scoped derived merge refuses a field that is no longer derived (track A, row 13)', () => {})

    // ── ⑬ ──────────────────────────────────────────────────────────────────────────────────────────────
    test('⑬ retype-convert-refuses-approval-projection-sheet: system_kind NULL but approval_record_projection rows ⇒ 422 on all three endpoints, zero writes', async () => {
      const column = await seedColumn([])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
      // a token minted while the sheet was still ordinary — it must not get the conversion through afterwards
      const token = await previewToken(column.fieldId, 'select')

      const instanceId = `apr_frc_13_${TS}`
      createdProjectionInstances.push(instanceId)
      await q('INSERT INTO approval_record_projection (instance_id, base_id, sheet_id, record_id, projected_version) VALUES ($1,$2,$3,$4,1)', [instanceId, APPROVAL_PROJECTION_BASE_ID, column.sheetId, column.rec(1)])
      expect((await q(`SELECT (to_jsonb(meta_sheets) ->> 'system_kind') AS system_kind FROM meta_sheets WHERE id = $1`, [column.sheetId])).rows).toEqual([{ system_kind: null }])

      const before = await snapshot(column)
      const responses = [
        await preview(column.fieldId, 'select'),
        await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM }),
        await execute(column.fieldId, { previewToken: 'not-a-token', confirm: CONVERT_CONFIRM }),
        await undo(column.fieldId, { convertRevisionId: randomUUID(), confirm: UNDO_CONFIRM }),
      ]
      for (const res of responses) {
        expect([res.status, res.body.error?.code, res.body.error?.details]).toEqual([422, 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED', { reason: 'approval_projection_sheet' }])
        expect(JSON.stringify(res.body)).not.toMatch(/VAL-|recordIds|previewToken/)
      }
      expect(await snapshot(column)).toEqual(before)
    })

    // ── review entry conditions (ADR addendum B) ───────────────────────────────────────────────────────
    test('authority freshness: a permission revoked IN THE DATABASE after the preview ⇒ execute and undo refuse, zero writes — the request still claims it', async () => {
      const column = await seedColumn([])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
      const token = await previewToken(column.fieldId, 'select')
      const cases: Array<[string, string[], number, string]> = [
        ['manage-schema revoked', ['multitable:manage-schema'], 403, 'FORBIDDEN'],
        ['read and write revoked', ['multitable:read', 'multitable:write'], 403, 'FULL_TABLE_READ_REQUIRED'],
        ['everything revoked', PERMS, 403, 'FORBIDDEN'],
      ]
      try {
        for (const [label, codes, status, code] of cases) {
          await revoke(ACTOR, codes)
          const before = await snapshot(column)
          const res = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
          expect([label, res.status, res.body.error?.code]).toEqual([label, status, code])
          expect([label, await snapshot(column)]).toEqual([label, before])
          // the preview is a read: it keeps answering from the request's claims
          expect([label, (await preview(column.fieldId, 'select')).status]).toEqual([label, 200])
          await grant(ACTOR, PERMS)
        }
        // an account deactivated in the database
        await q('UPDATE users SET is_active = FALSE WHERE id = $1', [ACTOR])
        const before = await snapshot(column)
        const deactivated = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
        expect([deactivated.status, deactivated.body.error?.code]).toEqual([403, 'FORBIDDEN'])
        expect(await snapshot(column)).toEqual(before)
        await q('UPDATE users SET is_active = TRUE WHERE id = $1', [ACTOR])

        // granted again: the SAME token converts, and the undo is refused the same way once revoked
        const converted = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
        expect(converted.status).toBe(200)
        const id = String(converted.body.data.convertRevisionId)
        await revoke(ACTOR, ['multitable:manage-schema'])
        const beforeUndo = await snapshot(column)
        const refused = await undo(column.fieldId, { convertRevisionId: id, confirm: UNDO_CONFIRM })
        expect([refused.status, refused.body.error?.code]).toEqual([403, 'FORBIDDEN'])
        expect(await snapshot(column)).toEqual(beforeUndo)
        await grant(ACTOR, PERMS)
        expect((await undo(column.fieldId, { convertRevisionId: id, confirm: UNDO_CONFIRM })).status).toBe(200)
      } finally {
        await q('UPDATE users SET is_active = TRUE WHERE id = $1', [ACTOR]).catch(() => {})
        await grant(ACTOR, PERMS)
      }
    })

    test('the preview SQL on a real server: four cell states, a recycle-bin row of ANOTHER sheet left out, and a plan hash the execute agrees with', async () => {
      const column = await seedColumn([])
      const other = await seedColumn([])
      const F = column.fieldId
      const seed: Array<[number, Record<string, unknown>]> = [[1, {}], [2, { [F]: null }], [3, { [F]: '' }], [4, { [F]: 'VAL-ALPHA' }]]
      for (const [n, data] of seed) await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(n), column.sheetId, JSON.stringify(data)])
      // what the preview's own expressions read for each state
      const read = (await q(
        `SELECT id, (jsonb_typeof(data) = 'object') AS is_object, (data ? $2::text) AS has_key, data -> $2::text AS cell FROM meta_records WHERE sheet_id = $1 ORDER BY id`,
        [column.sheetId, F],
      )).rows
      expect(read).toEqual([
        { id: column.rec(1), is_object: true, has_key: false, cell: null },
        { id: column.rec(2), is_object: true, has_key: true, cell: null },
        { id: column.rec(3), is_object: true, has_key: true, cell: '' },
        { id: column.rec(4), is_object: true, has_key: true, cell: 'VAL-ALPHA' },
      ])

      // recycle-bin rows of ANOTHER sheet — one of them naming THIS sheet's field id with a value that would block
      await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [other.rec(1), other.sheetId, JSON.stringify({ [F]: 'VAL-FOREIGN' })])
      await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [other.rec(2), other.sheetId, JSON.stringify({ [other.fieldId]: 'VAL-FOREIGN' })])
      // …and one empty-shaped row of THIS sheet
      await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [column.rec(9), column.sheetId, JSON.stringify({ [F]: null })])

      const first = await preview(F, 'multiSelect')
      expect(first.status).toBe(200)
      expect(first.body.data).toMatchObject({
        verdict: 'ok', scannedRecordCount: 4, trash: { scanned: 1, blocking: 0 }, cells: { empty: 3, converted: 1, rejected: 0 },
        options: { new: 1, final: 1 }, rejections: [],
      })
      expect(JSON.stringify(first.body)).not.toMatch(/VAL-/)
      const hashOf = (token: string) => String((jwt.decode(token) as Record<string, unknown>).planHash)
      const planHash = hashOf(String(first.body.data.previewToken))
      expect(planHash).toMatch(/^[0-9a-f]{64}$/)

      // the hash is a function of THIS sheet's rows only: more recycle-bin rows elsewhere do not move it
      await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [other.rec(3), other.sheetId, JSON.stringify({ [F]: ['VAL-FOREIGN'] })])
      const second = await preview(F, 'multiSelect')
      expect(hashOf(String(second.body.data.previewToken))).toBe(planHash)

      // the execute re-computes the hash from rows it locks itself, and accepts the FIRST token
      const executed = await execute(F, { previewToken: String(first.body.data.previewToken), confirm: CONVERT_CONFIRM })
      expect(executed.status).toBe(200)
      expect(executed.body.data).toMatchObject({ recordCount: 4, cells: { rewritten: 4, unchanged: 0 }, options: { final: 1 } })
      // the other sheet's recycle bin was not read into the plan and was not written
      expect((await q('SELECT record_id, data FROM meta_records_trash WHERE sheet_id = $1 ORDER BY record_id', [other.sheetId])).rows).toEqual([
        { record_id: other.rec(1), data: { [F]: 'VAL-FOREIGN' } },
        { record_id: other.rec(2), data: { [other.fieldId]: 'VAL-FOREIGN' } },
        { record_id: other.rec(3), data: { [F]: ['VAL-FOREIGN'] } },
      ])

      // undo: the other sheet's ["VAL-FOREIGN"] row is not this sheet's recycle bin either
      const undone = await undo(F, { convertRevisionId: String(executed.body.data.convertRevisionId), confirm: UNDO_CONFIRM })
      expect(undone.status).toBe(200)
      expect(await cellState(column.rec(1), F)).toMatchObject({ has_key: false })
      expect(await cellState(column.rec(2), F)).toMatchObject({ has_key: true, kind: 'null' })
      expect(await cellState(column.rec(3), F)).toMatchObject({ has_key: true, kind: 'string', value: '' })
      expect(await cellState(column.rec(4), F)).toMatchObject({ has_key: true, kind: 'string', value: 'VAL-ALPHA' })
    })

    test('a row whose data is not a JSON object: the preview rejects the whole run by id; the execute refuses 409 when a row stopped being one — zero writes', async () => {
      const shapes: Array<[string, unknown]> = [['array', []], ['array naming the field', ['placeholder']], ['string', 'VAL-SCALAR'], ['number', 7], ['json null', null]]
      for (const [label, raw] of shapes) {
        const column = await seedColumn([])
        const shape = label === 'array naming the field' ? [column.fieldId] : raw
        await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
        await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(2), column.sheetId, JSON.stringify({})])
        await q('INSERT INTO meta_records_trash (record_id, sheet_id, data) VALUES ($1,$2,$3::jsonb)', [column.rec(8), column.sheetId, JSON.stringify({})])
        const token = await previewToken(column.fieldId, 'select')

        for (const where of ['live', 'trash'] as const) {
          if (where === 'live') await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [column.rec(2), JSON.stringify(shape)])
          else await q('UPDATE meta_records_trash SET data = $2::jsonb WHERE record_id = $1', [column.rec(8), JSON.stringify(shape)])
          const rejected = await preview(column.fieldId, 'select')
          expect([label, where, rejected.status]).toEqual([label, where, 200])
          expect([label, where, rejected.body.data.verdict, rejected.body.data.rejections]).toEqual([
            label, where, 'rejected', [{ reason: 'record_data_not_object', recordCount: 1, recordIds: [where === 'live' ? column.rec(2) : column.rec(8)] }],
          ])
          expect(rejected.body.data.previewToken).toBeUndefined()
          expect(JSON.stringify(rejected.body)).not.toMatch(/VAL-/)

          const before = await snapshot(column)
          const res = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
          expect([label, where, res.status, res.body.error?.code]).toEqual([label, where, 409, 'PLAN_DRIFT'])
          expect([label, where, await snapshot(column)]).toEqual([label, where, before])

          if (where === 'live') await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [column.rec(2), JSON.stringify({})])
          else await q('UPDATE meta_records_trash SET data = $2::jsonb WHERE record_id = $1', [column.rec(8), JSON.stringify({})])
        }
        // back to objects: the token minted before is good again
        expect([label, (await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })).status]).toEqual([label, 200])
      }
    })

    // ── the pre-image is unconditional, and capped ─────────────────────────────────────────────────────
    test('the pre-image is written with the capture flag OFF, and above the capture cap the conversion is refused 422 with zero writes', async () => {
      const column = await seedColumn([])
      for (const n of [1, 2, 3]) await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(n), column.sheetId, JSON.stringify({ [column.fieldId]: `VAL-${n}` })])
      expect(process.env.MULTITABLE_TOMBSTONE_CAPTURE_ENABLED).toBeUndefined()
      const token = await previewToken(column.fieldId, 'select')

      process.env.MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS = '2'
      const before = await snapshot(column)
      const refused = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
      expect([refused.status, refused.body.error?.code]).toEqual([422, 'TOMBSTONE_CAPTURE_CAP_EXCEEDED'])
      expect(await snapshot(column)).toEqual(before)

      delete process.env.MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS
      const ok = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
      expect(ok.status).toBe(200)
      expect((await q('SELECT count(*)::int AS c FROM meta_field_value_tombstones WHERE config_revision_id = $1::uuid', [String(ok.body.data.convertRevisionId)])).rows[0]).toEqual({ c: 3 })
    })

    test('the token is single-purpose: a wrong or missing confirm is 400, an expired token is 401 (reason expired), a replay after the conversion is 422', async () => {
      const column = await seedColumn([])
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [column.rec(1), column.sheetId, JSON.stringify({ [column.fieldId]: 'VAL-ALPHA' })])
      const token = await previewToken(column.fieldId, 'select')
      const before = await snapshot(column)
      for (const body of [{ previewToken: token }, { previewToken: token, confirm: 'convert' }, { previewToken: token, confirm: UNDO_CONFIRM }]) {
        const res = await execute(column.fieldId, body)
        expect([res.status, res.body.error?.code]).toEqual([400, 'CONFIRM_REQUIRED'])
      }
      const claims = jwt.decode(token) as Record<string, unknown>
      const secret = process.env.RESTORE_PREVIEW_SECRET || process.env.JWT_SECRET
      if (secret) {
        const { iat: _iat, exp: _exp, ...rest } = claims
        const expired = jwt.sign({ ...rest, exp: Math.floor(Date.now() / 1000) - 60 }, secret, { algorithm: 'HS256' })
        const res = await execute(column.fieldId, { previewToken: expired, confirm: CONVERT_CONFIRM })
        expect([res.status, res.body.error?.code, res.body.error?.details]).toEqual([401, 'PREVIEW_IDENTITY_INVALID', { reason: 'expired' }])
      }
      expect(await snapshot(column)).toEqual(before)

      expect((await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })).status).toBe(200)
      const after = await snapshot(column)
      const replay = await execute(column.fieldId, { previewToken: token, confirm: CONVERT_CONFIRM })
      // the column is a select now: the pair is no longer in the first batch
      expect([replay.status, replay.body.error?.code, replay.body.error?.details]).toEqual([422, 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED', { reason: 'pair_not_in_first_batch' }])
      expect(await snapshot(column)).toEqual(after)
    })
  })
}
