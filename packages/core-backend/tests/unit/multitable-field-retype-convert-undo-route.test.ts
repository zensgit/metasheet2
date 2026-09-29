/**
 * 字段类型转换第 3 刀 —— `POST /api/multitable/fields/:fieldId/retype-undo` 的门、判定顺序与四态回写。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §3「撤销」判定表（0 / 1 / 2 / ① / ② / ②b / ③）。
 *
 * DB-free：表感知的内存替身 + pinned server。每条用例先经**真的**预览 + 执行路由造出一次已提交的转换，再对它撤销——
 * 作业行、前镜像、记录修订都是产品代码自己写的，不是手摆的。
 *
 * 判定顺序是锁定的，所以除了逐条触发，还有一组「两条同时不过，答的是排在前面的那条」。
 */
import { randomUUID } from 'node:crypto'

import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { dbUser, emptyWorld, FAKE_LOCK_RE, FAKE_WRITE_RE, FieldRetypeConvertFakePg, type FakePgOptions, type FakeWorld } from '../utils/field-retype-convert-fake-pg'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET = 'sheet_undo_1'
const FIELD = 'fld_undo_1'
const OTHER_FIELD = 'fld_undo_other'
const ACTOR = 'user_undo'
const SECRET = 'retype-undo-secret-0123456789abcdef'
const CONVERT_CONFIRM = 'convert-field-type'
const CONFIRM = 'undo-field-type-convert'
const ADMIN_PERMS = ['multitable:read', 'multitable:write', 'multitable:manage-schema']

const SEED: Array<[string, Record<string, unknown>]> = [
  ['r1', { [FIELD]: '机密-ALPHA', [OTHER_FIELD]: 'keep' }],
  ['r2', { [FIELD]: '机密-BETA' }],
  ['r3', { [OTHER_FIELD]: 'no key' }],
  ['r4', { [FIELD]: null }],
  ['r5', { [FIELD]: '' }],
]

function world(records: Array<[string, Record<string, unknown>]> = SEED, over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    ...emptyWorld(),
    sheets: [{ id: SHEET, base_id: 'base_1', deleted_at: null, row_level_read_permissions_enabled: false, system_kind: null, description: null, recovery_writer_state: null }],
    fields: [
      { id: FIELD, sheet_id: SHEET, name: 'Status', type: 'string', property: { description: 'original' }, order: 0 },
      { id: OTHER_FIELD, sheet_id: SHEET, name: 'Other', type: 'string', property: {}, order: 1 },
    ],
    records: records.map(([id, data]) => ({ id, sheet_id: SHEET, version: 1, data })),
    // the DATABASE agrees with the token unless a test says otherwise
    dbUsers: { [ACTOR]: dbUser(ADMIN_PERMS) },
    ...over,
  }
}

const tables = (w: FakeWorld) => ({
  fields: w.fields, records: w.records, trash: w.trash, tombstones: w.tombstones, conversions: w.conversions,
  recordRevisions: w.recordRevisions, configRevisions: w.configRevisions, audit: w.audit, operations: w.operations,
})
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const state: { pg: FieldRetypeConvertFakePg; perms: string[]; actor: string; hook: FakePgOptions['beforeStatement'] } = {
  pg: new FieldRetypeConvertFakePg(emptyWorld()), perms: ADMIN_PERMS, actor: ACTOR, hook: undefined,
}
const yjsInvalidated: string[][] = []
const pinned = usePinnedServer()
let setYjsInvalidatorForRoutes: typeof import('../../src/routes/univer-meta').setYjsInvalidatorForRoutes

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn(async () => state.perms),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const routes = await import('../../src/routes/univer-meta')
  setYjsInvalidatorForRoutes = routes.setYjsInvalidatorForRoutes
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query: (sql: string, params?: unknown[]) => state.pg.query(sql, params),
    transaction: (handler: never) => state.pg.transaction(handler),
  } as never)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: state.actor, roles: [], perms: [...state.perms] } as never
    next()
  })
  app.use('/api/multitable', routes.univerMetaRouter())
  pinned.setApp(app)
}, 120_000)

afterAll(() => {
  setYjsInvalidatorForRoutes(null)
  vi.restoreAllMocks()
  vi.doUnmock('../../src/rbac/service')
  vi.resetModules()
})

describe('POST /fields/:fieldId/retype-undo (ADR §3 撤销)', () => {
  beforeEach(() => {
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', '')
    vi.stubEnv('MULTITABLE_SHEET_REVERT_MAX_RECORDS', '')
    vi.stubEnv('RESTORE_PREVIEW_SECRET', SECRET)
    state.perms = ADMIN_PERMS
    state.actor = ACTOR
    state.hook = undefined
    yjsInvalidated.length = 0
    setYjsInvalidatorForRoutes(async (ids) => { yjsInvalidated.push([...ids]) })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const post = (path: string, body: unknown) => request(pinned.url()).post(`/api/multitable${path}`).send(body as object)
  const undo = (body: unknown, fieldId = FIELD) => post(`/fields/${fieldId}/retype-undo`, body)

  /** A world with ONE committed conversion of FIELD, made by the product's own preview + execute routes. */
  async function converted(targetType: 'select' | 'multiSelect' = 'multiSelect', w: FakeWorld = world(), fieldId = FIELD): Promise<{ pg: FieldRetypeConvertFakePg; id: string }> {
    const pg = new FieldRetypeConvertFakePg(w, { beforeStatement: (statement, current) => state.hook?.(statement, current) })
    state.pg = pg
    const previewed = await post(`/fields/${fieldId}/retype-preview`, { targetType })
    expect(previewed.status).toBe(200)
    expect(previewed.body.data.verdict).toBe('ok')
    const executed = await post(`/fields/${fieldId}/retype-execute`, { previewToken: previewed.body.data.previewToken, confirm: CONVERT_CONFIRM })
    expect(executed.status).toBe(200)
    yjsInvalidated.length = 0
    return { pg, id: String(executed.body.data.convertRevisionId) }
  }

  async function expectRefused(
    arranged: { pg: FieldRetypeConvertFakePg; id: string },
    act: () => Promise<request.Response>,
    expected: { status: number; code: string; details?: unknown; newTransactions?: number },
  ): Promise<{ res: request.Response; issued: string[] }> {
    const { pg } = arranged
    const before = copy(tables(pg.world))
    const transactionsBefore = pg.transactions
    const statementsBefore = pg.statements.length
    const res = await act()
    expect([res.status, res.body?.error?.code]).toEqual([expected.status, expected.code])
    if ('details' in expected) expect(res.body.error.details).toEqual(expected.details)
    expect(tables(pg.world)).toEqual(before)
    expect(JSON.stringify(res.body)).not.toContain('机密')
    const issued = pg.statements.slice(statementsBefore)
    if (expected.newTransactions !== undefined) expect(pg.transactions - transactionsBefore).toBe(expected.newTransactions)
    if (expected.newTransactions === 0) {
      expect(issued.filter((s) => FAKE_WRITE_RE.test(s.sql) || FAKE_LOCK_RE.test(s.sql)).map((s) => s.sql)).toEqual([])
    }
    expect(issued.filter((s) => FAKE_WRITE_RE.test(s.sql)).map((s) => s.sql)).toEqual([])
    expect(yjsInvalidated).toEqual([])
    return { res, issued: issued.filter((s) => s.inTransaction).map((s) => s.sql.replace(/\s+/g, ' ').trim()) }
  }

  // ── gates ────────────────────────────────────────────────────────────────────────────────────────────
  test('① flag off ⇒ 403 before any query; ② legacy flag ⇒ 409; ① wins over ②', async () => {
    const arranged = await converted()
    const n = arranged.pg.statements.length
    for (const v of ['', 'TRUE', '1', ' true']) {
      vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', v)
      const res = await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })
      expect([v, res.status, res.body.error.code]).toEqual([v, 403, 'FIELD_RETYPE_CONVERT_DISABLED'])
    }
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', 'true')
    let res = await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })
    expect([res.status, res.body.error.code]).toEqual([403, 'FIELD_RETYPE_CONVERT_DISABLED'])
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', 'true')
    res = await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([409, 'FIELD_RETYPE_TRUST_REQUIRED', { reason: 'legacy_manage_schema_flag' }])
    expect(arranged.pg.statements.length).toBe(n)
  })

  test('body: convertRevisionId must be a uuid; force / partial / recordIds / override are refused, not ignored', async () => {
    const arranged = await converted()
    const n = arranged.pg.statements.length
    const bodies = [
      {}, { confirm: CONFIRM }, { convertRevisionId: 'not-a-uuid', confirm: CONFIRM }, { convertRevisionId: '', confirm: CONFIRM },
      { convertRevisionId: arranged.id, confirm: CONFIRM, force: true },
      { convertRevisionId: arranged.id, confirm: CONFIRM, override: true },
      { convertRevisionId: arranged.id, confirm: CONFIRM, partial: true },
      { convertRevisionId: arranged.id, confirm: CONFIRM, recordIds: ['r1'] },
    ]
    for (const body of bodies) {
      const res = await undo(body)
      expect([JSON.stringify(body), res.status, res.body.error.code]).toEqual([JSON.stringify(body), 400, 'VALIDATION_ERROR'])
    }
    expect(arranged.pg.statements.length).toBe(n)
    expect(arranged.pg.world.fields[0].type).toBe('multiSelect')
  })

  test('unknown field ⇒ 404; ③ no canManageFields ⇒ 403; ④ dead sheet ⇒ 404; ⑤ no canRead / row-level deny ⇒ 403 — no transaction', async () => {
    const arranged = await converted()
    const body = { convertRevisionId: arranged.id, confirm: CONFIRM }
    await expectRefused(arranged, () => undo(body, 'fld_missing'), { status: 404, code: 'NOT_FOUND', newTransactions: 0 })

    state.perms = ['multitable:read', 'multitable:write']
    await expectRefused(arranged, () => undo(body), { status: 403, code: 'FORBIDDEN', newTransactions: 0 })
    state.perms = ['multitable:manage-schema']
    await expectRefused(arranged, () => undo(body), { status: 403, code: 'FULL_TABLE_READ_REQUIRED', newTransactions: 0 })
    state.perms = ADMIN_PERMS

    arranged.pg.world.sheets[0].row_level_read_permissions_enabled = true
    await expectRefused(arranged, () => undo(body), { status: 403, code: 'FULL_TABLE_READ_REQUIRED', newTransactions: 0 })
    arranged.pg.world.sheets[0].row_level_read_permissions_enabled = false

    arranged.pg.world.sheets[0].deleted_at = '2026-09-01T00:00:00Z'
    await expectRefused(arranged, () => undo(body), { status: 404, code: 'SHEET_DELETED', newTransactions: 0 })
    arranged.pg.world.sheets[0].deleted_at = null
    expect((await undo(body)).status).toBe(200)
  })

  test('gate ORDER ③ → ④ → ⑤: a dead sheet answers 404 to a principal who would also fail ⑤, and 403 to one who fails ③', async () => {
    const arranged = await converted()
    const body = { convertRevisionId: arranged.id, confirm: CONFIRM }
    arranged.pg.world.sheets[0].deleted_at = '2026-09-01T00:00:00Z'
    arranged.pg.world.sheets[0].row_level_read_permissions_enabled = true
    state.perms = ['multitable:manage-schema']
    await expectRefused(arranged, () => undo(body), { status: 404, code: 'SHEET_DELETED', newTransactions: 0 })
    state.perms = ['multitable:read', 'multitable:write']
    await expectRefused(arranged, () => undo(body), { status: 403, code: 'FORBIDDEN', newTransactions: 0 })
  })

  test('⑤ field-mask axis: a field_permissions row hiding a column from this actor ⇒ 403 FULL_TABLE_READ_REQUIRED, no transaction', async () => {
    const arranged = await converted()
    arranged.pg.world.fieldPermissions.push({ sheet_id: SHEET, field_id: OTHER_FIELD, subject_type: 'user', subject_id: ACTOR, visible: false, read_only: false })
    await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 403, code: 'FULL_TABLE_READ_REQUIRED', newTransactions: 0 })
    arranged.pg.world.fieldPermissions = [{ sheet_id: SHEET, field_id: OTHER_FIELD, subject_type: 'user', subject_id: ACTOR, visible: true, read_only: true }]
    expect((await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })).status).toBe(200)
  })

  // ── authority freshness (ADR addendum B): re-read from the DATABASE, in the transaction, after the fence ──
  test('a permission revoked in the database after the conversion ⇒ the undo refuses in the transaction, zero writes, the job row never locked', async () => {
    const revocations: Array<[string, (w: FakeWorld) => void, number, string]> = [
      ['manage-schema revoked', (w) => { w.dbUsers[ACTOR] = dbUser(['multitable:read', 'multitable:write']) }, 403, 'FORBIDDEN'],
      ['read and write revoked, manage-schema kept', (w) => { w.dbUsers[ACTOR] = dbUser(['multitable:manage-schema']) }, 403, 'FULL_TABLE_READ_REQUIRED'],
      ['the account deactivated', (w) => { w.dbUsers[ACTOR] = dbUser(ADMIN_PERMS, { is_active: false }) }, 403, 'FORBIDDEN'],
      ['the account removed', (w) => { delete w.dbUsers[ACTOR] }, 403, 'FORBIDDEN'],
    ]
    for (const [label, revoke, status, code] of revocations) {
      const arranged = await converted()
      revoke(arranged.pg.world)
      const { issued } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status, code, newTransactions: 1 })
      expect(state.perms).toEqual(ADMIN_PERMS)
      expect([label, issued[0]]).toEqual([label, 'SELECT pg_advisory_xact_lock(hashtext($1))'])
      expect([label, issued.filter((sql) => /FOR UPDATE/.test(sql))]).toEqual([label, []])
      // granted again ⇒ the same request undoes
      arranged.pg.world.dbUsers[ACTOR] = dbUser(ADMIN_PERMS)
      expect([label, (await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })).status]).toEqual([label, 200])
      yjsInvalidated.length = 0
    }
  })

  test('revoked, deleted or masked while the request is already past its pool-side gates ⇒ refused under the fence', async () => {
    const changes: Array<[string, (w: FakeWorld) => void, number, string]> = [
      ['manage-schema revoked', (w) => { w.dbUsers[ACTOR] = dbUser(['multitable:read', 'multitable:write']) }, 403, 'FORBIDDEN'],
      ['the sheet was deleted', (w) => { w.sheets[0].deleted_at = '2026-09-28T00:00:00Z' }, 404, 'SHEET_DELETED'],
      ['row-level read deny was switched on', (w) => { w.sheets[0].row_level_read_permissions_enabled = true }, 403, 'FULL_TABLE_READ_REQUIRED'],
    ]
    for (const [label, change, status, code] of changes) {
      const arranged = await converted()
      const from = arranged.pg.statements.length
      state.hook = (statement, w) => {
        if (statement.inTransaction && statement.sql.includes('pg_advisory_xact_lock') && arranged.pg.statements.length >= from) change(w)
      }
      const { issued } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status, code, newTransactions: 1 })
      state.hook = undefined
      expect([label, issued.filter((sql) => /FOR UPDATE/.test(sql))]).toEqual([label, []])
    }
  })

  test('a live row that is no longer a JSON object reads as a changed cell: refused, never restored into', async () => {
    for (const shape of [[], [FIELD], 'text', 7, null]) {
      const arranged = await converted()
      arranged.pg.world.records[2].data = shape
      await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), {
        status: 409, code: 'UNDO_PRECONDITION_FAILED', newTransactions: 1,
        details: { reason: 'cells_changed', recordCount: 1, recordIds: ['r3'] },
      })
    }
  })

  test('managed-sheet union ⇒ 422 before the confirm is looked at, no transaction', async () => {
    const marks: Array<[string, (w: FakeWorld) => () => void]> = [
      ['plugin_managed_sheet', (w) => { w.pluginRegistry.add(SHEET); return () => w.pluginRegistry.delete(SHEET) }],
      ['system_managed_sheet', (w) => { w.sheets[0].system_kind = 'approval_projection'; return () => { w.sheets[0].system_kind = null } }],
      ['plugin_tagged_fields', (w) => { w.fields[1].property = { stockPreparationMvp: {} }; return () => { w.fields[1].property = {} } }],
      ['pipeline_staging_sheet', (w) => { w.pipelineStaging.add(SHEET); return () => w.pipelineStaging.delete(SHEET) }],
      ['approval_projection_sheet', (w) => { w.approvalProjection.add(SHEET); return () => w.approvalProjection.delete(SHEET) }],
    ]
    const arranged = await converted()
    for (const [reason, mark] of marks) {
      const unmark = mark(arranged.pg.world)
      for (const body of [{ convertRevisionId: arranged.id, confirm: CONFIRM }, { convertRevisionId: arranged.id }, { convertRevisionId: randomUUID(), confirm: CONFIRM }]) {
        await expectRefused(arranged, () => undo(body), { status: 422, code: 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED', details: { reason }, newTransactions: 0 })
      }
      unmark()
    }
  })

  test('confirm missing or wrong ⇒ 400 CONFIRM_REQUIRED; the execute confirm does not undo; no transaction', async () => {
    const arranged = await converted()
    for (const confirm of [undefined, '', 'undo', CONVERT_CONFIRM, ' undo-field-type-convert']) {
      const body = confirm === undefined ? { convertRevisionId: arranged.id } : { convertRevisionId: arranged.id, confirm }
      await expectRefused(arranged, () => undo(body), { status: 400, code: 'CONFIRM_REQUIRED', newTransactions: 0 })
    }
  })

  test('trust gate: writer fence off ⇒ 409 FIELD_RETYPE_TRUST_REQUIRED (writer_fence_disabled), no transaction', async () => {
    const arranged = await converted()
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', '')
    await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 409, code: 'FIELD_RETYPE_TRUST_REQUIRED', details: { reason: 'writer_fence_disabled' }, newTransactions: 0 })
  })

  test('recovery holds the sheet ⇒ 409 RECOVERY_IN_PROGRESS after the fence, before the job row is locked', async () => {
    for (const blocked of ['fencing', 'applying', 'paused_retryable', 'archiving']) {
      const arranged = await converted()
      arranged.pg.world.sheets[0].recovery_writer_state = blocked
      const { issued } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 409, code: 'RECOVERY_IN_PROGRESS', newTransactions: 1 })
      expect(issued[0]).toContain('pg_advisory_xact_lock')
      expect(issued.filter((sql) => /FOR UPDATE/.test(sql))).toEqual([])
    }
  })

  // ── the locked order: 0 / 1 / 2 / ① / ② / ②b / ③ ───────────────────────────────────────────────────
  test('0 no such conversion, a conversion of ANOTHER column, of ANOTHER sheet ⇒ 404 NOT_FOUND — one code, no id echoed, nothing else locked', async () => {
    const arranged = await converted('select', world([['r1', { [FIELD]: 'A', [OTHER_FIELD]: 'B' }]]))
    // a second conversion, of the OTHER column of the same sheet
    const previewed = await post(`/fields/${OTHER_FIELD}/retype-preview`, { targetType: 'select' })
    const executed = await post(`/fields/${OTHER_FIELD}/retype-execute`, { previewToken: previewed.body.data.previewToken, confirm: CONVERT_CONFIRM })
    expect(executed.status).toBe(200)
    const otherId = String(executed.body.data.convertRevisionId)
    // and a job row that belongs to another sheet but names THIS field id
    const foreignId = randomUUID()
    arranged.pg.world.conversions.push({ ...arranged.pg.world.conversions[0], convert_revision_id: foreignId, sheet_id: 'sheet_elsewhere' })
    yjsInvalidated.length = 0

    for (const [label, id] of [['does not exist', randomUUID()], ['another column', otherId], ['another sheet', foreignId]] as const) {
      const { res, issued } = await expectRefused(arranged, () => undo({ convertRevisionId: id, confirm: CONFIRM }), { status: 404, code: 'NOT_FOUND', newTransactions: 1 })
      expect([label, res.body.error.details]).toEqual([label, undefined])
      expect(JSON.stringify(res.body)).not.toContain(id)
      // the job row is the only row lock taken
      expect(issued.filter((sql) => /FOR UPDATE/.test(sql)).map((sql) => sql.includes('meta_field_retype_conversions'))).toEqual([true])
    }
    // each id still undoes its own column
    expect((await undo({ convertRevisionId: otherId, confirm: CONFIRM }, OTHER_FIELD)).status).toBe(200)
    expect((await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })).status).toBe(200)
  })

  test('1 already undone ⇒ 409 ALREADY_UNDONE; the undo revision id is not a conversion (404)', async () => {
    const arranged = await converted()
    const first = await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })
    expect(first.status).toBe(200)
    yjsInvalidated.length = 0
    const { issued } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 409, code: 'ALREADY_UNDONE', newTransactions: 1 })
    expect(issued.some((sql) => sql.includes('FROM meta_field_value_tombstones'))).toBe(false)
    await expectRefused(arranged, () => undo({ convertRevisionId: String(first.body.data.undoRevisionId), confirm: CONFIRM }), { status: 404, code: 'NOT_FOUND', newTransactions: 1 })
  })

  test('2 the pre-image was pruned (whole group, or short by one) ⇒ 409 PRE_IMAGE_EXPIRED — never 404, never a partial restore', async () => {
    for (const keep of [0, SEED.length - 1]) {
      const arranged = await converted()
      arranged.pg.world.tombstones = arranged.pg.world.tombstones.slice(0, keep)
      const { res, issued } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 409, code: 'PRE_IMAGE_EXPIRED', newTransactions: 1 })
      expect([keep, res.body.error.details]).toEqual([keep, undefined])
      // decided BEFORE the field row or any record is looked at
      expect(issued.some((sql) => sql.includes('FROM meta_fields WHERE id = $1 FOR UPDATE'))).toBe(false)
      expect(issued.some((sql) => sql.includes('FROM meta_records WHERE sheet_id = $1 FOR UPDATE'))).toBe(false)
      // the pre-image rows were locked (FOR UPDATE) — that is what holds the retention sweep off
      expect(issued.some((sql) => sql.includes('FROM meta_field_value_tombstones') && sql.endsWith('FOR UPDATE'))).toBe(true)
    }
  })

  test('2 more pre-image rows than the conversion recorded ⇒ aborts (500), zero writes', async () => {
    const arranged = await converted()
    arranged.pg.world.tombstones.push({ ...arranged.pg.world.tombstones[0], record_id: 'r_forged' })
    await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 500, code: 'INTERNAL_ERROR', newTransactions: 1 })
  })

  test('① the field configuration moved (type / an option added / a colour / another key) ⇒ 409 field_config_changed; key ORDER alone does not count', async () => {
    const changes: Array<[string, (w: FakeWorld) => void]> = [
      ['type', (w) => { w.fields[0].type = 'select' }],
      ['an option added', (w) => { (w.fields[0].property as { options: unknown[] }).options.push({ value: 'new' }) }],
      ['an option recoloured', (w) => { (w.fields[0].property as { options: Array<Record<string, unknown>> }).options[0].color = 'red' }],
      ['options reordered', (w) => { (w.fields[0].property as { options: unknown[] }).options.reverse() }],
      ['another key changed', (w) => { (w.fields[0].property as Record<string, unknown>).description = 'edited' }],
    ]
    for (const [label, change] of changes) {
      const arranged = await converted()
      change(arranged.pg.world)
      const { res, issued } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 409, code: 'UNDO_PRECONDITION_FAILED', details: { reason: 'field_config_changed' }, newTransactions: 1 })
      expect([label, res.body.error.message]).toEqual([label, expect.not.stringContaining(FIELD)])
      expect(issued.some((sql) => sql.includes('FROM meta_records WHERE sheet_id = $1 FOR UPDATE'))).toBe(false)
    }
    // jsonb equality is key-order independent
    const arranged = await converted()
    const property = arranged.pg.world.fields[0].property as Record<string, unknown>
    arranged.pg.world.fields[0].property = Object.fromEntries(Object.entries(property).reverse())
    expect((await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })).status).toBe(200)
  })

  test('② the record set moved (a row added / a row removed / both) ⇒ 409 record_set_changed with the complete, sorted ids', async () => {
    let arranged = await converted()
    arranged.pg.world.records.push({ id: 'r9', sheet_id: SHEET, version: 1, data: { [FIELD]: ['机密-ALPHA'] } })
    await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), {
      status: 409, code: 'UNDO_PRECONDITION_FAILED', newTransactions: 1,
      details: { reason: 'record_set_changed', recordCount: 1, recordIds: ['r9'], removed: { recordCount: 0, recordIds: [] }, added: { recordCount: 1, recordIds: ['r9'] } },
    })

    arranged = await converted()
    arranged.pg.world.records = arranged.pg.world.records.filter((r) => r.id !== 'r2' && r.id !== 'r4')
    await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), {
      status: 409, code: 'UNDO_PRECONDITION_FAILED', newTransactions: 1,
      details: { reason: 'record_set_changed', recordCount: 2, recordIds: ['r2', 'r4'], removed: { recordCount: 2, recordIds: ['r2', 'r4'] }, added: { recordCount: 0, recordIds: [] } },
    })

    arranged = await converted()
    arranged.pg.world.records = arranged.pg.world.records.filter((r) => r.id !== 'r1')
    arranged.pg.world.records.push({ id: 'B9', sheet_id: SHEET, version: 1, data: {} })
    const { res } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 409, code: 'UNDO_PRECONDITION_FAILED', newTransactions: 1 })
    // code-unit order: uppercase sorts before lowercase
    expect(res.body.error.details).toEqual({ reason: 'record_set_changed', recordCount: 2, recordIds: ['B9', 'r1'], removed: { recordCount: 1, recordIds: ['r1'] }, added: { recordCount: 1, recordIds: ['B9'] } })
    expect(res.body.error.message).not.toMatch(/r1|B9/)
  })

  test('②b a recycle-bin row carrying a non-string post-state ⇒ 409 trashed_rows_with_post_state; empty shapes and strings pass', async () => {
    const blocking: Array<[string, unknown]> = [['array', ['机密-ALPHA']], ['two options', ['a', 'b']], ['number', 7], ['boolean', false], ['object', { a: 1 }]]
    for (const [label, value] of blocking) {
      const arranged = await converted()
      arranged.pg.world.trash.push({ record_id: 't_block', sheet_id: SHEET, data: { [FIELD]: value } }, { record_id: 't_ok', sheet_id: SHEET, data: { [FIELD]: [] } })
      const { res } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), {
        status: 409, code: 'UNDO_PRECONDITION_FAILED', newTransactions: 1,
        details: { reason: 'trashed_rows_with_post_state', recordCount: 1, recordIds: ['t_block'] },
      })
      expect([label, res.status]).toEqual([label, 409])
    }
    const arranged = await converted()
    arranged.pg.world.trash.push(
      { record_id: 't1', sheet_id: SHEET, data: { [FIELD]: [] } },
      { record_id: 't2', sheet_id: SHEET, data: { [FIELD]: '' } },
      { record_id: 't3', sheet_id: SHEET, data: { [FIELD]: null } },
      { record_id: 't4', sheet_id: SHEET, data: {} },
      { record_id: 't5', sheet_id: SHEET, data: { [FIELD]: 'a string' } },
      { record_id: 't6', sheet_id: 'sheet_elsewhere', data: { [FIELD]: ['another sheet'] } },
    )
    const trashBefore = copy(arranged.pg.world.trash)
    expect((await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })).status).toBe(200)
    expect(arranged.pg.world.trash).toEqual(trashBefore)
  })

  test('③ a cell of THIS column was edited after the conversion ⇒ 409 cells_changed; an edit of another column does not block', async () => {
    const edits: Array<[string, (w: FakeWorld) => void, string[]]> = [
      ['another option', (w) => { w.records[0].data = { ...w.records[0].data, [FIELD]: ['机密-BETA'] } }, ['r1']],
      ['an option appended', (w) => { w.records[0].data = { ...w.records[0].data, [FIELD]: ['机密-ALPHA', '机密-BETA'] } }, ['r1']],
      ['emptied', (w) => { w.records[1].data = { ...w.records[1].data, [FIELD]: [] } }, ['r2']],
      ['key removed', (w) => { const { [FIELD]: _gone, ...rest } = w.records[2].data; w.records[2].data = rest }, ['r3']],
      ['two rows', (w) => { w.records[3].data = { [FIELD]: ['x'] }; w.records[0].data = { [FIELD]: ['y'] } }, ['r1', 'r4']],
    ]
    for (const [label, edit, ids] of edits) {
      const arranged = await converted()
      edit(arranged.pg.world)
      const { res } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), {
        status: 409, code: 'UNDO_PRECONDITION_FAILED', newTransactions: 1,
        details: { reason: 'cells_changed', recordCount: ids.length, recordIds: ids },
      })
      expect([label, res.body.error.message]).toEqual([label, expect.not.stringMatching(/r\d/)])
    }
    // the version is NOT compared: another column edited (and the version bumped) leaves the undo available
    const arranged = await converted()
    arranged.pg.world.records[1].data = { ...arranged.pg.world.records[1].data, [OTHER_FIELD]: 'edited after' }
    arranged.pg.world.records[1].version += 3
    expect((await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })).status).toBe(200)
    expect(arranged.pg.world.records[1].data).toEqual({ [FIELD]: '机密-BETA', [OTHER_FIELD]: 'edited after' })
  })

  test('order: when two judgments fail at once, the EARLIER one answers', async () => {
    const fail = {
      undone: (w: FakeWorld) => { w.conversions[0].undone_at = '2026-09-28T00:00:00Z'; w.conversions[0].undo_revision_id = randomUUID() },
      expired: (w: FakeWorld) => { w.tombstones = [] },
      field: (w: FakeWorld) => { w.fields[0].type = 'select' },
      set: (w: FakeWorld) => { w.records.push({ id: 'r9', sheet_id: SHEET, version: 1, data: {} }) },
      trash: (w: FakeWorld) => { w.trash.push({ record_id: 't1', sheet_id: SHEET, data: { [FIELD]: ['x'] } }) },
      cells: (w: FakeWorld) => { w.records[0].data = { [FIELD]: ['edited'] } },
    }
    const pairs: Array<[Array<keyof typeof fail>, string, string | undefined]> = [
      [['undone', 'expired'], 'ALREADY_UNDONE', undefined],
      [['expired', 'field'], 'PRE_IMAGE_EXPIRED', undefined],
      [['expired', 'set'], 'PRE_IMAGE_EXPIRED', undefined],
      [['expired', 'cells'], 'PRE_IMAGE_EXPIRED', undefined],
      [['field', 'set'], 'UNDO_PRECONDITION_FAILED', 'field_config_changed'],
      [['set', 'trash'], 'UNDO_PRECONDITION_FAILED', 'record_set_changed'],
      [['trash', 'cells'], 'UNDO_PRECONDITION_FAILED', 'trashed_rows_with_post_state'],
      [['field', 'cells'], 'UNDO_PRECONDITION_FAILED', 'field_config_changed'],
    ]
    for (const [which, code, reason] of pairs) {
      const arranged = await converted()
      for (const name of which) fail[name](arranged.pg.world)
      const { res } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 409, code, newTransactions: 1 })
      expect([which.join('+'), res.body.error.details?.reason]).toEqual([which.join('+'), reason])
    }
  })

  test('size: live + recycle bin above the record cap ⇒ 413 before any row lock', async () => {
    const arranged = await converted()
    vi.stubEnv('MULTITABLE_SHEET_REVERT_MAX_RECORDS', String(SEED.length))
    arranged.pg.world.trash.push({ record_id: 't1', sheet_id: SHEET, data: {} })
    const { issued } = await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 413, code: 'SHEET_TOO_LARGE', newTransactions: 1 })
    expect(issued.filter((sql) => /FOR UPDATE/.test(sql))).toEqual([])
  })

  // ── the undo itself ──────────────────────────────────────────────────────────────────────────────────
  test('multiSelect → text: the four empty states come back EXACTLY; one revision per restored row; the config revision points at the conversion', async () => {
    const arranged = await converted('multiSelect')
    const { pg, id } = arranged
    const transactionsBefore = pg.transactions
    const statementsBefore = pg.statements.length
    const res = await undo({ convertRevisionId: id, confirm: CONFIRM })
    expect(res.status).toBe(200)
    const undoId = String(res.body.data.undoRevisionId)
    expect(res.body.data).toEqual({ convertRevisionId: id, undoRevisionId: undoId, sheetId: SHEET, fieldId: FIELD, restoredType: 'string', recordCount: 5, cells: { restored: 5, unchanged: 0 } })
    expect(undoId).not.toBe(id)
    expect(JSON.stringify(res.body)).not.toContain('机密')
    expect(pg.transactions - transactionsBefore).toBe(1)

    // the field is exactly what it was
    expect(pg.world.fields[0]).toEqual({ id: FIELD, sheet_id: SHEET, name: 'Status', type: 'string', property: { description: 'original' }, order: 0 })
    // four states
    const data = (recordId: string) => pg.world.records.find((r) => r.id === recordId)!.data
    expect(data('r1')).toEqual({ [FIELD]: '机密-ALPHA', [OTHER_FIELD]: 'keep' })
    expect(data('r2')).toEqual({ [FIELD]: '机密-BETA' })
    expect(data('r3')).toEqual({ [OTHER_FIELD]: 'no key' })
    expect(Object.prototype.hasOwnProperty.call(data('r3'), FIELD)).toBe(false)
    expect(data('r4')).toEqual({ [FIELD]: null })
    expect(data('r5')).toEqual({ [FIELD]: '' })
    expect(pg.world.records.map((r) => r.version)).toEqual([3, 3, 3, 3, 3])

    // the locked order, as issued
    const tx = pg.statements.slice(statementsBefore).filter((s) => s.inTransaction).map((s) => s.sql.replace(/\s+/g, ' ').trim())
    const at = (needle: string) => tx.findIndex((sql) => sql.includes(needle))
    const order = [
      at('pg_advisory_xact_lock'),
      at('FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid AND field_id = $2 AND sheet_id = $3 FOR UPDATE'),
      at('SELECT record_id, value FROM meta_field_value_tombstones'),
      at('AS matches_target FROM meta_fields WHERE id = $1 FOR UPDATE'),
      at('FROM meta_records WHERE sheet_id = $1 FOR UPDATE'),
      at('AS blocking FROM meta_records_trash WHERE sheet_id = $1 FOR UPDATE'),
      at("IS DISTINCT FROM (t.value -> 'post')"),
      at('UPDATE meta_fields SET type'),
      at('UPDATE meta_records AS m'),
      at('INSERT INTO meta_record_revisions'),
      at('INSERT INTO meta_config_revisions'),
      at('UPDATE meta_field_retype_conversions'),
      at('INSERT INTO operation_audit_logs'),
      at('INSERT INTO meta_record_history_operations'),
    ]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(tx.slice(0, order[7]).filter((sql) => FAKE_WRITE_RE.test(sql))).toEqual([])

    // record revisions of the undo: key removed ⇒ null sentinel + no key in the snapshot; JSON null ⇒ null + key present
    const revisions = pg.world.recordRevisions.filter((r) => r.batch_id === undoId)
    expect(revisions.map((r) => r.record_id).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
    const revision = (recordId: string) => revisions.find((r) => r.record_id === recordId)!
    for (const r of revisions) expect(r).toMatchObject({ sheet_id: SHEET, version: 3, action: 'update', source: 'retype-convert-undo', changed_field_ids: [FIELD], actor_id: ACTOR })
    expect(revision('r1')).toMatchObject({ patch: { [FIELD]: '机密-ALPHA' }, snapshot: { [FIELD]: '机密-ALPHA', [OTHER_FIELD]: 'keep' } })
    expect(revision('r3').patch).toEqual({ [FIELD]: null })
    expect(revision('r3').snapshot).toEqual({ [OTHER_FIELD]: 'no key' })
    expect(revision('r4').patch).toEqual({ [FIELD]: null })
    expect(revision('r4').snapshot).toEqual({ [FIELD]: null })
    expect(revision('r5')).toMatchObject({ patch: { [FIELD]: '' }, snapshot: { [FIELD]: '' } })
    expect(new Set(revisions.map((r) => r.operation_id)).size).toBe(1)

    // config revision of the undo
    const config = pg.world.configRevisions.find((r) => r.id === undoId)!
    expect(config).toMatchObject({
      entity_type: 'field', entity_id: FIELD, action: 'update', changed_keys: ['type', 'property'], batch_id: undoId, source: 'restore', restored_from_id: id, operation_id: null,
      before: { type: 'multiSelect' }, after: { type: 'string', property: { description: 'original' } },
    })
    // job row, audit, endpoint
    expect(pg.world.conversions[0]).toMatchObject({ convert_revision_id: id, undo_revision_id: undoId })
    expect(pg.world.conversions[0].undone_at).not.toBeNull()
    expect(pg.world.audit.map((a) => a.action)).toEqual(['multitable.field.retype-convert', 'multitable.field.retype-convert-undo'])
    expect(pg.world.audit[1].metadata).toEqual({ sheetId: SHEET, fieldId: FIELD, convertRevisionId: id, undoRevisionId: undoId, restoredType: 'string', recordCount: 5, restoredRecordCount: 5 })
    expect(JSON.stringify(pg.world.audit)).not.toContain('机密')
    expect(pg.world.operations).toHaveLength(2)
    expect(pg.world.operations[1]).toMatchObject({ event_count: 5 })
    // the pre-image is kept (retention owns its lifetime), and the recycle bin untouched
    expect(pg.world.tombstones).toHaveLength(5)
    expect(yjsInvalidated.map((ids) => [...ids].sort())).toEqual([['r1', 'r2', 'r3', 'r4', 'r5']])
  })

  test('select → text: rows the conversion did not touch are not touched by the undo either', async () => {
    const arranged = await converted('select', world([['r1', { [FIELD]: 'A' }], ['r2', { [FIELD]: '' }], ['r3', {}], ['r4', { [FIELD]: null }]]))
    expect(arranged.pg.world.records.map((r) => r.version)).toEqual([1, 1, 2, 2])
    const res = await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ recordCount: 4, cells: { restored: 2, unchanged: 2 } })
    expect(arranged.pg.world.records.map((r) => [r.id, r.version, r.data])).toEqual([['r1', 1, { [FIELD]: 'A' }], ['r2', 1, { [FIELD]: '' }], ['r3', 3, {}], ['r4', 3, { [FIELD]: null }]])
    expect(arranged.pg.world.recordRevisions.filter((r) => r.source === 'retype-convert-undo').map((r) => r.record_id).sort()).toEqual(['r3', 'r4'])
    // post-commit: the collaborative document of EVERY live record is invalidated — r1 and r2 were not rewritten,
    // but the column they sit in changed type, and an open document still holds the cell as a select
    expect(yjsInvalidated.map((ids) => [...ids].sort())).toEqual([['r1', 'r2', 'r3', 'r4']])
  })

  test('an empty-sheet conversion can be undone: the field comes back, no record revision, no endpoint', async () => {
    const arranged = await converted('multiSelect', world([]))
    const res = await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ recordCount: 0, cells: { restored: 0, unchanged: 0 } })
    expect(arranged.pg.world.fields[0]).toMatchObject({ type: 'string', property: { description: 'original' } })
    expect([arranged.pg.world.recordRevisions.length, arranged.pg.world.operations.length, arranged.pg.world.configRevisions.length]).toEqual([0, 0, 2])
    expect(yjsInvalidated).toEqual([])
  })

  test('a column converted again after an undo has two job rows; each id undoes only its own conversion', async () => {
    const arranged = await converted('select', world([['r1', { [FIELD]: 'A' }], ['r2', {}]]))
    expect((await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })).status).toBe(200)
    const previewed = await post(`/fields/${FIELD}/retype-preview`, { targetType: 'multiSelect' })
    const executed = await post(`/fields/${FIELD}/retype-execute`, { previewToken: previewed.body.data.previewToken, confirm: CONVERT_CONFIRM })
    expect(executed.status).toBe(200)
    const second = String(executed.body.data.convertRevisionId)
    yjsInvalidated.length = 0
    await expectRefused(arranged, () => undo({ convertRevisionId: arranged.id, confirm: CONFIRM }), { status: 409, code: 'ALREADY_UNDONE', newTransactions: 1 })
    expect((await undo({ convertRevisionId: second, confirm: CONFIRM })).status).toBe(200)
    expect(arranged.pg.world.records.map((r) => r.data)).toEqual([{ [FIELD]: 'A' }, {}])
    expect(arranged.pg.world.fields[0].type).toBe('string')
  })

  // ── all-or-nothing ───────────────────────────────────────────────────────────────────────────────────
  test('a failure at ANY write statement rolls the whole undo back, values-free 500', async () => {
    const writes = [
      'UPDATE meta_fields SET type',
      'UPDATE meta_records AS m',
      'INSERT INTO meta_record_revisions',
      'INSERT INTO meta_config_revisions',
      'UPDATE meta_field_retype_conversions',
      'INSERT INTO operation_audit_logs',
      'INSERT INTO meta_record_history_operations',
    ]
    for (const failAt of writes) {
      const arranged = await converted()
      state.hook = (statement) => {
        if (statement.inTransaction && statement.sql.replace(/\s+/g, ' ').includes(failAt)) throw new Error(`injected failure carrying 机密-ALPHA at ${failAt}`)
      }
      const before = copy(tables(arranged.pg.world))
      const res = await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })
      state.hook = undefined
      expect([failAt, res.status, res.body.error.code]).toEqual([failAt, 500, 'INTERNAL_ERROR'])
      expect(JSON.stringify(res.body)).not.toMatch(/机密|injected/)
      expect([failAt, tables(arranged.pg.world)]).toEqual([failAt, before])
      expect(yjsInvalidated).toEqual([])
      // and it is still undoable afterwards
      expect((await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })).status).toBe(200)
      yjsInvalidated.length = 0
    }
  })

  test('a short restore (fewer rows returned than the pre-image says) aborts and rolls back', async () => {
    const arranged = await converted()
    state.hook = (statement, w) => {
      if (statement.inTransaction && statement.sql.includes('UPDATE meta_records AS m')) w.records = w.records.filter((r) => r.id !== 'r2')
    }
    const before = copy(tables(arranged.pg.world))
    const res = await undo({ convertRevisionId: arranged.id, confirm: CONFIRM })
    state.hook = undefined
    expect([res.status, res.body.error.code]).toEqual([500, 'INTERNAL_ERROR'])
    expect(tables(arranged.pg.world)).toEqual(before)
  })
})
