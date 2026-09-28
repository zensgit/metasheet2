/**
 * 字段类型转换第 3 刀 —— `POST /api/multitable/fields/:fieldId/retype-execute` 的门、错误码与事务次序。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §3（执行 1-9）。
 *
 * DB-free：表感知的内存替身（tests/utils/field-retype-convert-fake-pg.ts）+ pinned server（#4154：不许 `request(app)`）。
 * 凭证**不伪造**：每条用例先走真的预览路由拿凭证，再执行——除非用例要的就是一张别处来的凭证。
 *
 * 每个拒绝都断言三件事：状态码 + 稳定错误码；零写入（替身的表逐张深相等）；以及它停在哪（没开事务 / 没取行锁）。
 * 真库的十三条在 tests/integration/multitable-field-retype-convert-realdb.cases.ts，只在 CI 真跑。
 */
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { emptyWorld, FAKE_LOCK_RE, FAKE_WRITE_RE, FieldRetypeConvertFakePg, type FakePgOptions, type FakeWorld } from '../utils/field-retype-convert-fake-pg'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET = 'sheet_exec_1'
const FIELD = 'fld_exec_1'
const OTHER_FIELD = 'fld_exec_other'
const ACTOR = 'user_exec'
const SECRET = 'retype-execute-secret-0123456789abcdef'
const CONFIRM = 'convert-field-type'
const ADMIN_PERMS = ['multitable:read', 'multitable:write', 'multitable:manage-schema']

const sheet = (over: Partial<FakeWorld['sheets'][number]> = {}): FakeWorld['sheets'][number] => ({
  id: SHEET, base_id: 'base_1', deleted_at: null, row_level_read_permissions_enabled: false, system_kind: null, description: null, recovery_writer_state: null, ...over,
})

function world(records: Array<[string, Record<string, unknown>, number?]> = [['r1', { [FIELD]: '机密-ALPHA' }]], over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    ...emptyWorld(),
    sheets: [sheet()],
    fields: [
      { id: FIELD, sheet_id: SHEET, name: 'Status', type: 'string', property: {}, order: 0 },
      { id: OTHER_FIELD, sheet_id: SHEET, name: 'Other', type: 'string', property: {}, order: 1 },
    ],
    records: records.map(([id, data, version]) => ({ id, sheet_id: SHEET, version: version ?? 1, data })),
    ...over,
  }
}

/** The tables a conversion can write. `fences` and `statements` are not state — they are asserted separately. */
const tables = (w: FakeWorld) => ({
  fields: w.fields, records: w.records, trash: w.trash, tombstones: w.tombstones, conversions: w.conversions,
  recordRevisions: w.recordRevisions, configRevisions: w.configRevisions, audit: w.audit, operations: w.operations,
})
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const state: { pg: FieldRetypeConvertFakePg; perms: string[]; actor: string } = { pg: new FieldRetypeConvertFakePg(emptyWorld()), perms: ADMIN_PERMS, actor: ACTOR }
const yjsInvalidated: string[][] = []
const pinned = usePinnedServer()
let mintConfigRestorePreviewIdentity: typeof import('../../src/multitable/restore-preview-identity').mintConfigRestorePreviewIdentity
let mintFieldRetypeConvertPreviewIdentity: typeof import('../../src/multitable/restore-preview-identity').mintFieldRetypeConvertPreviewIdentity
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
  const identity = await import('../../src/multitable/restore-preview-identity')
  mintConfigRestorePreviewIdentity = identity.mintConfigRestorePreviewIdentity
  mintFieldRetypeConvertPreviewIdentity = identity.mintFieldRetypeConvertPreviewIdentity
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

describe('POST /fields/:fieldId/retype-execute (ADR §3)', () => {
  beforeEach(() => {
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', '')
    vi.stubEnv('MULTITABLE_SHEET_REVERT_MAX_RECORDS', '')
    vi.stubEnv('MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS', '')
    vi.stubEnv('MULTITABLE_TOMBSTONE_CAPTURE_ENABLED', '')
    vi.stubEnv('RESTORE_PREVIEW_SECRET', SECRET)
    state.perms = ADMIN_PERMS
    state.actor = ACTOR
    yjsInvalidated.length = 0
    setYjsInvalidatorForRoutes(async (ids) => { yjsInvalidated.push([...ids]) })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const use = (w: FakeWorld, options: FakePgOptions = {}) => {
    state.pg = new FieldRetypeConvertFakePg(w, options)
    return state.pg
  }
  const post = (path: string, body: unknown) => request(pinned.url()).post(`/api/multitable${path}`).send(body as object)
  const preview = (fieldId = FIELD, targetType = 'select') => post(`/fields/${fieldId}/retype-preview`, { targetType })
  const execute = (body: unknown, fieldId = FIELD) => post(`/fields/${fieldId}/retype-execute`, body)
  const tokenFor = async (fieldId = FIELD, targetType = 'select'): Promise<string> => {
    const res = await preview(fieldId, targetType)
    expect(res.status).toBe(200)
    expect(res.body.data.verdict).toBe('ok')
    return String(res.body.data.previewToken)
  }

  /** Arrange a world, take a real token, then hand the SAME double to `act`; assert the refusal wrote nothing. */
  async function expectRefused(
    w: FakeWorld,
    act: (token: string, pg: FieldRetypeConvertFakePg) => Promise<request.Response>,
    expected: { status: number; code: string; details?: unknown; transactions?: number },
    options: { between?: (pg: FieldRetypeConvertFakePg) => void; pgOptions?: FakePgOptions; targetType?: string } = {},
  ): Promise<{ res: request.Response; pg: FieldRetypeConvertFakePg }> {
    const pg = use(w, options.pgOptions)
    const token = await tokenFor(FIELD, options.targetType ?? 'select')
    options.between?.(pg)
    const before = copy(tables(pg.world))
    const statementsBefore = pg.statements.length
    const res = await act(token, pg)
    expect([res.status, res.body?.error?.code]).toEqual([expected.status, expected.code])
    if ('details' in expected) expect(res.body.error.details).toEqual(expected.details)
    expect(tables(pg.world)).toEqual(before)
    expect(JSON.stringify(res.body)).not.toContain('机密')
    if (expected.transactions !== undefined) expect(pg.transactions).toBe(expected.transactions)
    const issued = pg.statements.slice(statementsBefore)
    if (expected.transactions === 0) {
      expect(issued.filter((s) => FAKE_WRITE_RE.test(s.sql) || FAKE_LOCK_RE.test(s.sql)).map((s) => s.sql)).toEqual([])
    }
    expect(yjsInvalidated).toEqual([])
    return { res, pg }
  }

  // ── the five gates ───────────────────────────────────────────────────────────────────────────────────
  test('① flag off ⇒ 403 FIELD_RETYPE_CONVERT_DISABLED before ANY query; only the exact literal "true" opens it', async () => {
    for (const v of ['', 'TRUE', '1', ' true', 'true ', 'yes']) {
      const pg = use(world())
      vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', v)
      const res = await execute({ previewToken: 'x', confirm: CONFIRM })
      expect([v, res.status, res.body.error.code]).toEqual([v, 403, 'FIELD_RETYPE_CONVERT_DISABLED'])
      expect(pg.statements).toEqual([])
    }
  })

  test('① before ②: flag off + legacy flag on is 403, not 409', async () => {
    const pg = use(world())
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', '')
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', 'true')
    const res = await execute({ previewToken: 'x', confirm: CONFIRM })
    expect([res.status, res.body.error.code]).toEqual([403, 'FIELD_RETYPE_CONVERT_DISABLED'])
    expect(pg.statements).toEqual([])
  })

  test('② legacy manage-schema flag on ⇒ 409 FIELD_RETYPE_TRUST_REQUIRED (legacy_manage_schema_flag), zero queries', async () => {
    for (const v of ['true', 'TRUE', ' true ']) {
      const pg = use(world())
      vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', v)
      const res = await execute({ previewToken: 'x', confirm: CONFIRM })
      expect([res.status, res.body.error.code, res.body.error.details]).toEqual([409, 'FIELD_RETYPE_TRUST_REQUIRED', { reason: 'legacy_manage_schema_flag' }])
      expect(pg.statements).toEqual([])
    }
  })

  test('body: previewToken is required; targetType / property / force are refused, not ignored', async () => {
    for (const body of [{}, { confirm: CONFIRM }, { previewToken: '' }, { previewToken: 'x', confirm: CONFIRM, targetType: 'select' }, { previewToken: 'x', confirm: CONFIRM, property: {} }, { previewToken: 'x', confirm: CONFIRM, force: true }]) {
      const pg = use(world())
      const res = await execute(body)
      expect([JSON.stringify(body), res.status, res.body.error.code]).toEqual([JSON.stringify(body), 400, 'VALIDATION_ERROR'])
      expect(pg.statements).toEqual([])
    }
  })

  test('unknown field ⇒ 404, the requested id is not echoed, nothing opened', async () => {
    const pg = use(world([], { fields: [] }))
    const res = await execute({ previewToken: 'x', confirm: CONFIRM })
    expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND'])
    expect(JSON.stringify(res.body)).not.toContain(FIELD)
    expect(pg.transactions).toBe(0)
  })

  test('③ without canManageFields ⇒ 403 FORBIDDEN, no transaction', async () => {
    await expectRefused(world(), async (token) => {
      state.perms = ['multitable:read', 'multitable:write']
      return execute({ previewToken: token, confirm: CONFIRM })
    }, { status: 403, code: 'FORBIDDEN', transactions: 0 })
  })

  test('④ dead sheet ⇒ 404 SHEET_DELETED; absent sheet ⇒ 404 NOT_FOUND; no transaction', async () => {
    await expectRefused(world(), (token) => execute({ previewToken: token, confirm: CONFIRM }), { status: 404, code: 'SHEET_DELETED', transactions: 0 }, {
      between: (pg) => { pg.world.sheets[0].deleted_at = '2026-09-01T00:00:00Z' },
    })
    await expectRefused(world(), (token) => execute({ previewToken: token, confirm: CONFIRM }), { status: 404, code: 'NOT_FOUND', transactions: 0 }, {
      between: (pg) => { pg.world.sheets = [] },
    })
  })

  test('⑤ checks canRead itself: multitable:manage-schema alone ⇒ 403 FULL_TABLE_READ_REQUIRED, no transaction', async () => {
    await expectRefused(world(), async (token) => {
      state.perms = ['multitable:manage-schema']
      return execute({ previewToken: token, confirm: CONFIRM })
    }, { status: 403, code: 'FULL_TABLE_READ_REQUIRED', transactions: 0 })
  })

  test('⑤ row-level read deny on ⇒ 403 FULL_TABLE_READ_REQUIRED, no transaction', async () => {
    await expectRefused(world(), (token) => execute({ previewToken: token, confirm: CONFIRM }), { status: 403, code: 'FULL_TABLE_READ_REQUIRED', transactions: 0 }, {
      between: (pg) => { pg.world.sheets[0].row_level_read_permissions_enabled = true },
    })
  })

  // ── scope: the managed-sheet union is answered BEFORE the token is looked at ───────────────────────
  test('managed-sheet union (a)-(e) ⇒ 422 with the first reason — with a valid token, with a garbage token, without a confirm', async () => {
    const cases: Array<[string, (w: FakeWorld) => void]> = [
      ['plugin_managed_sheet', (w) => { w.pluginRegistry.add(SHEET); w.pipelineStaging.add(SHEET) }],
      ['system_managed_sheet', (w) => { w.sheets[0].system_kind = 'people_directory' }],
      ['plugin_tagged_fields', (w) => { w.fields[1].property = { stockPreparation: { ownership: 'plm_system' } } }],
      ['pipeline_staging_sheet', (w) => { w.pipelineStaging.add(SHEET); w.approvalProjection.add(SHEET) }],
      ['approval_projection_sheet', (w) => { w.approvalProjection.add(SHEET) }],
    ]
    for (const [reason, mark] of cases) {
      const expected = { status: 422, code: 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED', details: { reason }, transactions: 0 }
      await expectRefused(world(), (token) => execute({ previewToken: token, confirm: CONFIRM }), expected, { between: (pg) => mark(pg.world) })
      await expectRefused(world(), () => execute({ previewToken: 'not.a.token', confirm: CONFIRM }), expected, { between: (pg) => mark(pg.world) })
      await expectRefused(world(), (token) => execute({ previewToken: token }), expected, { between: (pg) => mark(pg.world) })
    }
  })

  // ── hard gates 1-3 ───────────────────────────────────────────────────────────────────────────────────
  test('1 confirm missing or wrong ⇒ 400 CONFIRM_REQUIRED, no transaction', async () => {
    for (const confirm of [undefined, '', 'convert', 'Convert-Field-Type', ' convert-field-type', 'undo-field-type-convert']) {
      await expectRefused(world(), (token) => execute(confirm === undefined ? { previewToken: token } : { previewToken: token, confirm }), { status: 400, code: 'CONFIRM_REQUIRED', transactions: 0 })
    }
  })

  test('1 before 2 and 3: a wrong confirm is 400 even with the fence off and a garbage token', async () => {
    await expectRefused(world(), async () => {
      vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', '')
      return execute({ previewToken: 'not.a.token', confirm: 'nope' })
    }, { status: 400, code: 'CONFIRM_REQUIRED', transactions: 0 })
  })

  test('2 trust gate: writer fence off ⇒ 409 FIELD_RETYPE_TRUST_REQUIRED (writer_fence_disabled), no transaction — while the preview still answers', async () => {
    for (const v of ['', 'false', '0', 'off']) {
      await expectRefused(world(), async (token) => {
        vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', v)
        expect((await preview()).status).toBe(200)
        return execute({ previewToken: token, confirm: CONFIRM })
      }, { status: 409, code: 'FIELD_RETYPE_TRUST_REQUIRED', details: { reason: 'writer_fence_disabled' }, transactions: 0 })
    }
  })

  test('2 before 3: fence off + garbage token is 409, not 401', async () => {
    await expectRefused(world(), async () => {
      vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', '')
      return execute({ previewToken: 'not.a.token', confirm: CONFIRM })
    }, { status: 409, code: 'FIELD_RETYPE_TRUST_REQUIRED', transactions: 0 })
  })

  test('3 token: not a token / signed with another key / another identity type ⇒ 401 PREVIEW_IDENTITY_INVALID, no transaction, no reason disclosed', async () => {
    const foreign = jwt.sign({ type: 'field-retype-convert-preview', sheetId: SHEET, fieldId: FIELD, actorId: ACTOR, sourceType: 'string', targetType: 'select', planHash: 'a'.repeat(64) }, 'another-key-another-key-another-key', { algorithm: 'HS256', expiresIn: '10m' })
    const otherType = () => mintConfigRestorePreviewIdentity({ sheetId: SHEET, revisionId: 'rev', entityType: 'field', entityId: FIELD, baselineHash: 'h', actorId: ACTOR })
    const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ type: 'field-retype-convert-preview', sheetId: SHEET, fieldId: FIELD, actorId: ACTOR, sourceType: 'string', targetType: 'select', planHash: 'a'.repeat(64) })).toString('base64url')}.`
    for (const make of [() => 'not.a.token', () => foreign, otherType, () => unsigned]) {
      const { res } = await expectRefused(world(), () => execute({ previewToken: make(), confirm: CONFIRM }), { status: 401, code: 'PREVIEW_IDENTITY_INVALID', transactions: 0 })
      expect(res.body.error.details).toBeUndefined()
    }
  })

  test('3 token expired ⇒ 401 PREVIEW_IDENTITY_INVALID with details.reason "expired", no transaction', async () => {
    await expectRefused(world(), (token) => {
      const { iat: _iat, exp: _exp, ...claims } = jwt.decode(token) as Record<string, unknown>
      const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 5 }, SECRET, { algorithm: 'HS256' })
      return execute({ previewToken: expired, confirm: CONFIRM })
    }, { status: 401, code: 'PREVIEW_IDENTITY_INVALID', details: { reason: 'expired' }, transactions: 0 })
  })

  test('3 claim by claim: fieldId / sheetId / actorId / sourceType / targetType — each mismatch alone ⇒ 401, no transaction', async () => {
    const forge = (token: string, over: Record<string, unknown>) => {
      const { iat: _iat, exp: _exp, ...claims } = jwt.decode(token) as Record<string, unknown>
      return jwt.sign({ ...claims, ...over }, SECRET, { algorithm: 'HS256', expiresIn: '10m' })
    }
    const mismatches: Array<[string, Record<string, unknown>]> = [
      ['fieldId', { fieldId: OTHER_FIELD }],
      ['sheetId', { sheetId: 'sheet_other' }],
      ['actorId', { actorId: 'user_other' }],
      ['sourceType', { sourceType: 'longText' }],
      ['targetType', { targetType: 'number' }],
      ['targetType (excluded)', { targetType: 'attachment' }],
    ]
    for (const [label, over] of mismatches) {
      const { res } = await expectRefused(world(), (token) => execute({ previewToken: forge(token, over), confirm: CONFIRM }), { status: 401, code: 'PREVIEW_IDENTITY_INVALID', transactions: 0 })
      expect([label, res.body.error.details]).toEqual([label, undefined])
    }
    // control: the same forge with no override is accepted — the 401s above are the claims, not the re-signing
    const pg = use(world())
    const ok = await execute({ previewToken: forge(await tokenFor(), {}), confirm: CONFIRM })
    expect(ok.status).toBe(200)
    expect(pg.world.fields[0].type).toBe('select')
  })

  test('3 a token minted for ANOTHER field of the same sheet, and for another actor, cannot execute here', async () => {
    const records: Array<[string, Record<string, unknown>]> = [['r1', { [FIELD]: 'A', [OTHER_FIELD]: 'B' }]]
    await expectRefused(world(records), async () => execute({ previewToken: await tokenFor(OTHER_FIELD), confirm: CONFIRM }), { status: 401, code: 'PREVIEW_IDENTITY_INVALID', transactions: 0 })
    await expectRefused(world(records), async (token) => {
      state.actor = 'user_other'
      return execute({ previewToken: token, confirm: CONFIRM })
    }, { status: 401, code: 'PREVIEW_IDENTITY_INVALID', transactions: 0 })
  })

  test('3 a claim that is missing or not a string reads as invalid', async () => {
    for (const drop of ['planHash', 'actorId', 'targetType']) {
      await expectRefused(world(), (token) => {
        const { iat: _iat, exp: _exp, ...claims } = jwt.decode(token) as Record<string, unknown>
        delete claims[drop]
        return execute({ previewToken: jwt.sign(claims, SECRET, { algorithm: 'HS256', expiresIn: '10m' }), confirm: CONFIRM })
      }, { status: 401, code: 'PREVIEW_IDENTITY_INVALID', transactions: 0 })
    }
  })

  // ── inside the transaction, before the first write ──────────────────────────────────────────────────
  test('4 recovery holds the sheet (every writer-block state, archiving included) ⇒ 409 RECOVERY_IN_PROGRESS after the fence, no row lock, zero writes', async () => {
    for (const blocked of ['fencing', 'applying', 'paused_retryable', 'archiving']) {
      const { pg } = await expectRefused(world(), (token) => execute({ previewToken: token, confirm: CONFIRM }), { status: 409, code: 'RECOVERY_IN_PROGRESS', transactions: 1 }, {
        between: (p) => { p.world.sheets[0].recovery_writer_state = blocked },
      })
      expect(pg.fences).toEqual([`meta:auto-number:sheet:${SHEET}`])
      expect(pg.rolledBack).toBe(1)
      expect(pg.transactionStatements.filter((sql) => /FOR UPDATE/.test(sql))).toEqual([])
    }
  })

  test('4 PLAN_DRIFT: a cell edited / a version bumped / a row added / a row removed / a recycle-bin row added or removed / the property changed ⇒ 409, zero writes', async () => {
    const base = (): FakeWorld => world(
      [['r1', { [FIELD]: '机密-ALPHA' }], ['r2', { [FIELD]: '机密-BETA' }]],
      { trash: [{ record_id: 't1', sheet_id: SHEET, data: { [FIELD]: '' } }] },
    )
    const drifts: Array<[string, (w: FakeWorld) => void]> = [
      ['a cell edited', (w) => { w.records[0].data = { [FIELD]: '机密-GAMMA' } }],
      ['the same text, version bumped', (w) => { w.records[0].version += 1 }],
      ['two cells swapped (same counts, same options)', (w) => { const a = w.records[0].data; w.records[0].data = w.records[1].data; w.records[1].data = a }],
      ['a row added', (w) => { w.records.push({ id: 'r3', sheet_id: SHEET, version: 1, data: { [FIELD]: '机密-ALPHA' } }) }],
      ['a row removed', (w) => { w.records.pop() }],
      ['a recycle-bin row added', (w) => { w.trash.push({ record_id: 't2', sheet_id: SHEET, data: {} }) }],
      ['a recycle-bin row removed', (w) => { w.trash = [] }],
      ['a recycle-bin row changed its empty shape', (w) => { w.trash[0].data = { [FIELD]: null } }],
      ['the field property changed', (w) => { w.fields[0].property = { description: 'changed' } }],
    ]
    for (const [label, drift] of drifts) {
      const { res, pg } = await expectRefused(base(), (token) => execute({ previewToken: token, confirm: CONFIRM }), { status: 409, code: 'PLAN_DRIFT', transactions: 1 }, {
        targetType: 'multiSelect',
        between: (p) => drift(p.world),
      })
      expect([label, res.body.error.details]).toEqual([label, undefined])
      // the plan was re-computed UNDER the fence and the row locks
      const tx = pg.transactionStatements
      expect(tx[0]).toContain('pg_advisory_xact_lock')
      expect(tx.some((sql) => sql.includes('FROM meta_records WHERE sheet_id = $1 FOR UPDATE'))).toBe(true)
      expect(tx.some((sql) => sql.includes('FROM meta_records_trash WHERE sheet_id = $1 FOR UPDATE'))).toBe(true)
    }
  })

  test('4 a token that binds a REJECTED plan cannot execute, even though its planHash matches', async () => {
    // Build the plan hash of the current (rejected: trailing whitespace) column by hand and sign it — the preview
    // route would never mint this token.
    const { canonicalFieldRetypeConvertPlanInput, planFieldRetypeConvert } = await import('../../src/multitable/field-retype-convert')
    const { hashFieldRetypeConvertPlan } = await import('../../src/multitable/restore-preview-identity')
    const pg = use(world([['r1', { [FIELD]: 'trailing ' }]]))
    const plan = planFieldRetypeConvert({ sourceProperty: {}, targetType: 'select', live: [{ recordId: 'r1', version: 1, hasKey: true, value: 'trailing ' }], trash: [] })
    expect(plan.verdict).toBe('rejected')
    const planHash = hashFieldRetypeConvertPlan(canonicalFieldRetypeConvertPlanInput({ sheetId: SHEET, fieldId: FIELD, sourceType: 'string', sourceProperty: {}, plan }))
    const token = mintFieldRetypeConvertPreviewIdentity({ sheetId: SHEET, fieldId: FIELD, actorId: ACTOR, sourceType: 'string', targetType: 'select', planHash })
    const before = copy(tables(pg.world))
    const res = await execute({ previewToken: token, confirm: CONFIRM })
    expect([res.status, res.body.error.code]).toEqual([409, 'PLAN_DRIFT'])
    expect(tables(pg.world)).toEqual(before)
  })

  test('4 in the transaction: the field was deleted ⇒ 404; retyped ⇒ 422 pair_not_in_first_batch; the sheet became managed ⇒ 422 — zero writes', async () => {
    // Each change lands AFTER the pool-side gates passed: it is applied when the transaction takes the fence.
    const afterFence = (mutate: (w: FakeWorld) => void): FakePgOptions => ({
      beforeStatement: (statement, w) => {
        if (statement.inTransaction && statement.sql.includes('pg_advisory_xact_lock')) mutate(w)
      },
    })
    const run = async (mutate: (w: FakeWorld) => void) => {
      const pg = use(world(), afterFence(mutate))
      const token = await tokenFor()
      const res = await execute({ previewToken: token, confirm: CONFIRM })
      return { res, pg }
    }
    let { res, pg } = await run((w) => { w.fields = w.fields.filter((f) => f.id !== FIELD) })
    expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND'])
    expect(pg.world.tombstones).toEqual([])

    ;({ res, pg } = await run((w) => { w.fields[0].type = 'longText' }))
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([422, 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED', { reason: 'pair_not_in_first_batch' }])
    expect([pg.world.tombstones, pg.world.records[0].version]).toEqual([[], 1])

    ;({ res, pg } = await run((w) => { w.pluginRegistry.add(SHEET) }))
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([422, 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED', { reason: 'plugin_managed_sheet' }])
    expect([pg.world.tombstones, pg.world.fields[0].type]).toEqual([[], 'string'])

    ;({ res, pg } = await run((w) => { w.fields[0].sheet_id = 'sheet_moved' }))
    expect([res.status, res.body.error.code]).toEqual([401, 'PREVIEW_IDENTITY_INVALID'])
    expect(pg.world.tombstones).toEqual([])
  })

  test('4 size: live + recycle bin above the record cap ⇒ 413 SHEET_TOO_LARGE before any row lock; at the cap it converts', async () => {
    const records: Array<[string, Record<string, unknown>]> = [['r1', { [FIELD]: 'A' }], ['r2', { [FIELD]: 'B' }]]
    vi.stubEnv('MULTITABLE_SHEET_REVERT_MAX_RECORDS', '3')
    const { pg } = await expectRefused(world(records, { trash: [{ record_id: 't1', sheet_id: SHEET, data: {} }] }), (token) => execute({ previewToken: token, confirm: CONFIRM }), { status: 413, code: 'SHEET_TOO_LARGE', transactions: 1 }, {
      between: (p) => { p.world.trash.push({ record_id: 't2', sheet_id: SHEET, data: {} }) },
    })
    expect(pg.transactionStatements.filter((sql) => /FROM meta_records(_trash)? WHERE sheet_id = \$1 FOR UPDATE/.test(sql))).toEqual([])

    const ok = use(world(records, { trash: [{ record_id: 't1', sheet_id: SHEET, data: {} }] }))
    expect((await execute({ previewToken: await tokenFor(), confirm: CONFIRM })).status).toBe(200)
    expect(ok.world.fields[0].type).toBe('select')
  })

  test('2 pre-image cap: more live rows than MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS ⇒ 422 TOMBSTONE_CAPTURE_CAP_EXCEEDED, rolled back, zero writes', async () => {
    const records: Array<[string, Record<string, unknown>]> = [['r1', { [FIELD]: 'A' }], ['r2', { [FIELD]: 'B' }], ['r3', {}]]
    const { pg } = await expectRefused(world(records), async (token) => {
      vi.stubEnv('MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS', '2')
      return execute({ previewToken: token, confirm: CONFIRM })
    }, { status: 422, code: 'TOMBSTONE_CAPTURE_CAP_EXCEEDED', transactions: 1 })
    expect(pg.rolledBack).toBe(1)
    expect(pg.transactionStatements.filter((sql) => FAKE_WRITE_RE.test(sql))).toEqual([])
  })

  // ── the conversion itself ────────────────────────────────────────────────────────────────────────────
  test('string → multiSelect: every live row gets a pre-image BEFORE the field or any cell is rewritten; one transaction; values-free response', async () => {
    const pg = use(world([
      ['r2', { [FIELD]: '机密-BETA,含逗号', other: 'x' }, 5],
      ['r1', { [FIELD]: '机密-ALPHA' }, 2],
      ['r3', { other: 'no key' }],
      ['r4', { [FIELD]: null }],
      ['r5', { [FIELD]: '' }],
      ['r6', { [FIELD]: '机密-ALPHA' }],
    ], { trash: [{ record_id: 't1', sheet_id: SHEET, data: { [FIELD]: null } }] }))
    const token = await tokenFor(FIELD, 'multiSelect')
    const res = await execute({ previewToken: token, confirm: CONFIRM })
    expect(res.status).toBe(200)
    const id = String(res.body.data.convertRevisionId)
    expect(res.body.data).toEqual({
      convertRevisionId: id, sheetId: SHEET, fieldId: FIELD, sourceType: 'string', targetType: 'multiSelect', recordCount: 6,
      cells: { rewritten: 6, unchanged: 0 }, options: { final: 2, droppedValidationRuleCount: 0 }, undo: { confirm: 'undo-field-type-convert' },
    })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(res.body)).not.toContain('机密')

    // one transaction, committed, the fence first
    expect([pg.transactions, pg.committed, pg.rolledBack]).toEqual([1, 1, 0])
    const tx = pg.transactionStatements
    expect(tx[0]).toContain('pg_advisory_xact_lock')
    expect(pg.fences).toEqual([`meta:auto-number:sheet:${SHEET}`])

    // ORDER: field lock → row locks → pre-image → field update → cell rewrite → revisions → config → job → audit → seal
    const at = (needle: string) => tx.findIndex((sql) => sql.includes(needle))
    const order = [
      at('FROM meta_fields WHERE id = $1 FOR UPDATE'),
      at('FROM meta_records WHERE sheet_id = $1 FOR UPDATE'),
      at('FROM meta_records_trash WHERE sheet_id = $1 FOR UPDATE'),
      at('INSERT INTO meta_field_value_tombstones'),
      at('UPDATE meta_fields SET type'),
      at('UPDATE meta_records AS m'),
      at('INSERT INTO meta_record_revisions'),
      at('INSERT INTO meta_config_revisions'),
      at('INSERT INTO meta_field_retype_conversions'),
      at('INSERT INTO operation_audit_logs'),
      at('INSERT INTO meta_record_history_operations'),
    ]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // no write precedes the pre-image
    expect(tx.slice(0, order[3]).filter((sql) => FAKE_WRITE_RE.test(sql))).toEqual([])

    // the field: options in first-appearance order over the code-unit-sorted record ids, no color
    expect(pg.world.fields[0]).toMatchObject({ type: 'multiSelect', property: { options: [{ value: '机密-ALPHA' }, { value: '机密-BETA,含逗号' }] } })
    // the cells: whole text = ONE option; empties ⇒ []
    const cell = (id2: string) => pg.world.records.find((r) => r.id === id2)!
    expect(cell('r1').data[FIELD]).toEqual(['机密-ALPHA'])
    expect(cell('r2').data).toEqual({ [FIELD]: ['机密-BETA,含逗号'], other: 'x' })
    for (const empty of ['r3', 'r4', 'r5']) expect(cell(empty).data[FIELD]).toEqual([])
    expect(pg.world.records.map((r) => [r.id, r.version]).sort()).toEqual([['r1', 3], ['r2', 6], ['r3', 2], ['r4', 2], ['r5', 2], ['r6', 2]])
    // the recycle bin is never rewritten
    expect(pg.world.trash).toEqual([{ record_id: 't1', sheet_id: SHEET, data: { [FIELD]: null } }])

    // pre-image: one row per live record, the envelope, operation_id NULL, anchored to the conversion id
    expect(pg.world.tombstones.map((t) => [t.record_id, t.reason, t.config_revision_id, t.operation_id, t.value]).sort()).toEqual([
      ['r1', 'retype_convert', id, null, { k: true, v: '机密-ALPHA', post: ['机密-ALPHA'] }],
      ['r2', 'retype_convert', id, null, { k: true, v: '机密-BETA,含逗号', post: ['机密-BETA,含逗号'] }],
      ['r3', 'retype_convert', id, null, { k: false, v: null, post: [] }],
      ['r4', 'retype_convert', id, null, { k: true, v: null, post: [] }],
      ['r5', 'retype_convert', id, null, { k: true, v: '', post: [] }],
      ['r6', 'retype_convert', id, null, { k: true, v: '机密-ALPHA', post: ['机密-ALPHA'] }],
    ])

    // record half: one revision per rewritten row, at the NEW version, batch = the conversion id, one operation
    expect(pg.world.recordRevisions).toHaveLength(6)
    const operationIds = new Set(pg.world.recordRevisions.map((r) => r.operation_id))
    expect(operationIds.size).toBe(1)
    for (const revision of pg.world.recordRevisions) {
      const record = cell(String(revision.record_id))
      expect(revision).toMatchObject({
        sheet_id: SHEET, version: record.version, action: 'update', source: 'retype-convert', actor_id: ACTOR,
        changed_field_ids: [FIELD], patch: { [FIELD]: record.data[FIELD] }, snapshot: record.data, batch_id: id,
      })
    }
    // config half
    expect(pg.world.configRevisions).toEqual([{
      id, sheet_id: SHEET, entity_type: 'field', entity_id: FIELD, action: 'update',
      before: { type: 'string', property: {} }, after: { type: 'multiSelect', property: pg.world.fields[0].property },
      changed_keys: ['type', 'property'], batch_id: id, actor_id: ACTOR, source: 'mutation', restored_from_id: null, operation_id: null,
    }])
    // job row
    expect(pg.world.conversions).toEqual([{
      convert_revision_id: id, sheet_id: SHEET, field_id: FIELD, source_type: 'string', source_property: {},
      target_type: 'multiSelect', target_property: pg.world.fields[0].property, record_count: 6, actor_id: ACTOR, undone_at: null, undo_revision_id: null,
    }])
    // endpoint: count and max of the tracked events
    const seqs = pg.world.recordRevisions.map((r) => BigInt(String(r.seq)))
    expect(pg.world.operations).toEqual([{ sheet_id: SHEET, operation_id: [...operationIds][0], endpoint_seq: seqs.reduce((a, b) => (a > b ? a : b)).toString(), event_count: 6 }])
    // audit: ids and counts only
    expect(pg.world.audit).toEqual([{
      actor_id: ACTOR, action: 'multitable.field.retype-convert', resource_type: 'meta_field', resource_id: FIELD,
      metadata: { sheetId: SHEET, fieldId: FIELD, convertRevisionId: id, sourceType: 'string', targetType: 'multiSelect', recordCount: 6, rewrittenRecordCount: 6, optionCount: 2, droppedValidationRuleCount: 0 },
    }])
    // post-commit: the rewritten records' collaborative documents are invalidated
    expect(yjsInvalidated.map((ids) => [...ids].sort())).toEqual([['r1', 'r2', 'r3', 'r4', 'r5', 'r6']])
  })

  test('string → select: a cell already holding its target value is not touched, not bumped, gets no revision — but IS in the pre-image', async () => {
    const pg = use(world([['r1', { [FIELD]: 'A' }], ['r2', { [FIELD]: '' }], ['r3', {}], ['r4', { [FIELD]: null }]]))
    const res = await execute({ previewToken: await tokenFor(), confirm: CONFIRM })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ recordCount: 4, cells: { rewritten: 2, unchanged: 2 } })
    expect(pg.world.records.map((r) => [r.id, r.version, r.data[FIELD]])).toEqual([['r1', 1, 'A'], ['r2', 1, ''], ['r3', 2, ''], ['r4', 2, '']])
    expect(pg.world.recordRevisions.map((r) => r.record_id).sort()).toEqual(['r3', 'r4'])
    expect(pg.world.tombstones.map((t) => [t.record_id, t.value]).sort()).toEqual([
      ['r1', { k: true, v: 'A', post: 'A' }],
      ['r2', { k: true, v: '', post: '' }],
      ['r3', { k: false, v: null, post: '' }],
      ['r4', { k: true, v: null, post: '' }],
    ])
    expect(pg.world.operations).toHaveLength(1)
    expect(pg.world.operations[0]).toMatchObject({ event_count: 2 })
  })

  test('an empty sheet converts: job row and config revision, no pre-image, no record revision, NO endpoint', async () => {
    const pg = use(world([]))
    const res = await execute({ previewToken: await tokenFor(), confirm: CONFIRM })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ recordCount: 0, cells: { rewritten: 0, unchanged: 0 }, options: { final: 0 } })
    expect(pg.world.fields[0]).toMatchObject({ type: 'select', property: { options: [] } })
    expect([pg.world.conversions.length, pg.world.configRevisions.length, pg.world.tombstones.length, pg.world.recordRevisions.length, pg.world.operations.length]).toEqual([1, 1, 0, 0, 0])
    expect(pg.transactionStatements.filter((sql) => sql.startsWith('UPDATE meta_records'))).toEqual([])
    expect(yjsInvalidated).toEqual([])
  })

  test('the target property keeps every other key and drops validation rules a select cannot hold', async () => {
    const property = { description: 'keep me', validation: [{ type: 'required' }, { type: 'maxLength', value: 10 }, { type: 'enum', values: ['A'] }], custom: { nested: true } }
    const pg = use(world([['r1', { [FIELD]: 'A' }]]))
    pg.world.fields[0].property = property
    const res = await execute({ previewToken: await tokenFor(), confirm: CONFIRM })
    expect(res.status).toBe(200)
    expect(res.body.data.options).toEqual({ final: 1, droppedValidationRuleCount: 1 })
    expect(pg.world.fields[0].property).toEqual({ description: 'keep me', custom: { nested: true }, options: [{ value: 'A' }], validation: [{ type: 'required' }, { type: 'enum', values: ['A'] }] })
    // the job row keeps the source property exactly as it was stored
    expect(pg.world.conversions[0].source_property).toEqual(property)
  })

  test('the pre-image is written with MULTITABLE_TOMBSTONE_CAPTURE_ENABLED off, and identically with it on', async () => {
    for (const flag of ['', 'true']) {
      vi.stubEnv('MULTITABLE_TOMBSTONE_CAPTURE_ENABLED', flag)
      const pg = use(world([['r1', { [FIELD]: 'A' }]]))
      expect((await execute({ previewToken: await tokenFor(), confirm: CONFIRM })).status).toBe(200)
      expect([flag, pg.world.tombstones.map((t) => [t.record_id, t.reason])]).toEqual([flag, [['r1', 'retype_convert']]])
    }
  })

  // ── all-or-nothing ───────────────────────────────────────────────────────────────────────────────────
  test('a failure at ANY write statement rolls the whole conversion back: every table is as before, the response is a values-free 500', async () => {
    const writes = [
      'INSERT INTO meta_field_value_tombstones',
      'UPDATE meta_fields SET type',
      'UPDATE meta_records AS m',
      'INSERT INTO meta_record_revisions',
      'INSERT INTO meta_config_revisions',
      'INSERT INTO meta_field_retype_conversions',
      'INSERT INTO operation_audit_logs',
      'INSERT INTO meta_record_history_operations',
    ]
    for (const failAt of writes) {
      const pg = use(world([['r1', { [FIELD]: '机密-ALPHA' }], ['r2', {}]]), {
        beforeStatement: (statement) => {
          if (statement.inTransaction && statement.sql.replace(/\s+/g, ' ').includes(failAt)) throw new Error(`injected failure carrying 机密-ALPHA at ${failAt}`)
        },
      })
      const token = await tokenFor(FIELD, 'multiSelect')
      const before = copy(tables(pg.world))
      const res = await execute({ previewToken: token, confirm: CONFIRM })
      expect([failAt, res.status, res.body.error.code]).toEqual([failAt, 500, 'INTERNAL_ERROR'])
      expect(JSON.stringify(res.body)).not.toMatch(/机密|injected/)
      expect([failAt, tables(pg.world)]).toEqual([failAt, before])
      expect([pg.committed, pg.rolledBack]).toEqual([0, 1])
      expect(yjsInvalidated).toEqual([])
    }
  })

  test('a short rewrite (fewer rows returned than planned) aborts and rolls back', async () => {
    // A concurrent writer cannot exist under the fence and the row locks; if the count is ever short, nothing may commit.
    const pg = use(world([['r1', { [FIELD]: 'A' }], ['r2', { [FIELD]: 'B' }]]), {
      beforeStatement: (statement, w) => {
        if (statement.inTransaction && statement.sql.includes('UPDATE meta_records AS m')) w.records = w.records.filter((r) => r.id !== 'r2')
      },
    })
    const token = await tokenFor(FIELD, 'multiSelect')
    const before = copy(tables(pg.world))
    const res = await execute({ previewToken: token, confirm: CONFIRM })
    expect([res.status, res.body.error.code]).toEqual([500, 'INTERNAL_ERROR'])
    expect(tables(pg.world)).toEqual(before)
  })

  test('a lock-class SQLSTATE ⇒ 409 CONFLICT (retryable), rolled back', async () => {
    for (const code of ['40P01', '55P03', '40001']) {
      const pg = use(world(), {
        beforeStatement: (statement) => {
          if (statement.inTransaction && statement.sql.includes('FROM meta_records WHERE sheet_id = $1 FOR UPDATE')) throw Object.assign(new Error('lock'), { code })
        },
      })
      const token = await tokenFor()
      const before = copy(tables(pg.world))
      const res = await execute({ previewToken: token, confirm: CONFIRM })
      expect([code, res.status, res.body.error.code]).toEqual([code, 409, 'CONFLICT'])
      expect(tables(pg.world)).toEqual(before)
    }
  })

  test('replay: the same token after a successful conversion is refused (the column is no longer text), zero writes', async () => {
    const pg = use(world())
    const token = await tokenFor()
    expect((await execute({ previewToken: token, confirm: CONFIRM })).status).toBe(200)
    const before = copy(tables(pg.world))
    const res = await execute({ previewToken: token, confirm: CONFIRM })
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([422, 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED', { reason: 'pair_not_in_first_batch' }])
    expect(tables(pg.world)).toEqual(before)
  })
})
