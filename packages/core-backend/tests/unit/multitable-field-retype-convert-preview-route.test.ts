/**
 * 字段类型转换第 2 刀 —— `POST /api/multitable/fields/:fieldId/retype-preview` 的路由接线。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §2（五门顺序、范围 422、413、零写入、
 * values-free 响应、凭证）。
 *
 * 假 pool + pinned server（#4154：不许 `request(app)`），DB-free。每条 SQL 都记进 `log`，零写入由日志断言：
 * 无 BEGIN / INSERT / UPDATE / DELETE / 行锁 / 咨询锁，且 `pool.transaction` 从未被调用。门的「停在首个失败、之前不扫描」
 * 同样由日志断言：被拒时日志里不得出现范围判定或扫描语句。
 */
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const SHEET = 'sheet_convert_1'
const FIELD = 'fld_convert_1'
const SECRET = 'retype-preview-secret-0123456789abcdef'

type FieldRow = { id: string; sheet_id: string; name: string; type: string; property: unknown; order: number }
type RecordRow = { id: string; version: number; data: unknown }
/** `sheet_id` defaults to the sheet under test; `data` may be ANY json value (a non-object row must be refused). */
type TrashRow = { record_id: string; data: unknown; sheet_id?: string }

interface World {
  sheet: { deleted_at: string | null; row_level_read_permissions_enabled: boolean; base_id: string; system_kind: string | null; description: string | null } | null
  fields: FieldRow[]
  records: RecordRow[]
  trash: TrashRow[] | 'missing-table'
  pluginRegistry: boolean
  pipelineStaging: boolean
  approvalProjection: boolean
}

const world = (over: Partial<World> = {}): World => ({
  sheet: { deleted_at: null, row_level_read_permissions_enabled: false, base_id: 'base_1', system_kind: null, description: null },
  fields: [{ id: FIELD, sheet_id: SHEET, name: 'Status', type: 'string', property: {}, order: 0 }],
  records: [],
  trash: [],
  pluginRegistry: false,
  pipelineStaging: false,
  approvalProjection: false,
  ...over,
})

/**
 * The three per-row expressions, with POSTGRES semantics rather than JavaScript ones: `data ? k` is a top-level key
 * of an object, an element of an array, or the string scalar itself; `data -> k` is NULL unless `data` is an object
 * holding the key.
 */
const cellOf = (data: unknown, fieldId: string) => {
  const isObject = data !== null && typeof data === 'object' && !Array.isArray(data)
  const hasKey = isObject
    ? Object.prototype.hasOwnProperty.call(data, fieldId)
    : Array.isArray(data) ? data.includes(fieldId) : data === fieldId
  return {
    is_object: isObject,
    has_key: hasKey,
    cell: isObject && hasKey ? (data as Record<string, unknown>)[fieldId] : null,
  }
}

function createStore(w: World) {
  const log: string[] = []
  const handler = (sql: string, params: unknown[] = []): { rows: any[]; rowCount?: number } => {
    log.push(sql)
    if (sql.includes('FROM plugin_multitable_object_registry')) return { rows: w.pluginRegistry ? [{ '?column?': 1 }] : [] }
    if (sql.includes('FROM integration_pipelines')) return { rows: w.pipelineStaging ? [{ '?column?': 1 }] : [] }
    if (sql.includes('FROM approval_record_projection')) return { rows: w.approvalProjection ? [{ '?column?': 1 }] : [] }
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      if (!w.sheet || params[0] !== SHEET) return { rows: [] }
      return {
        rows: [{
          id: SHEET, name: 'Sheet', base_id: w.sheet.base_id, description: w.sheet.description, deleted_at: w.sheet.deleted_at,
          enabled: w.sheet.row_level_read_permissions_enabled, system_kind: w.sheet.system_kind,
        }],
      }
    }
    if (sql.includes('SELECT id, sheet_id, type, property FROM meta_fields WHERE id = $1')) {
      const f = w.fields.find((x) => x.id === params[0])
      return { rows: f ? [{ id: f.id, sheet_id: f.sheet_id, type: f.type, property: f.property }] : [] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return { rows: w.fields.filter((f) => f.sheet_id === params[0]).map((f) => ({ ...f })) }
    }
    if (sql.includes('FROM meta_records_trash')) {
      if (w.trash === 'missing-table') {
        const err = Object.assign(new Error('relation "meta_records_trash" does not exist'), { code: '42P01' })
        throw err
      }
      // The recycle bin is answered ONLY to a statement that filters by sheet and binds the sheet id first. A reader
      // that lost its `WHERE sheet_id = $1` — or binds something else there — gets nothing, never another sheet's rows.
      if (!sql.includes('FROM meta_records_trash WHERE sheet_id = $1') || typeof params[0] !== 'string') return { rows: [] }
      const mine = w.trash.filter((t) => (t.sheet_id ?? SHEET) === params[0])
      if (sql.includes('count(*)')) return { rows: [{ c: mine.length }] }
      return { rows: mine.map((t) => ({ record_id: t.record_id, ...cellOf(t.data, String(params[1])) })) }
    }
    if (sql.includes('FROM meta_records WHERE sheet_id = $1')) {
      if (sql.includes('count(*)')) return { rows: [{ c: w.records.length }] }
      if (sql.includes('has_key')) return { rows: w.records.map((r) => ({ id: r.id, version: r.version, ...cellOf(r.data, String(params[1])) })) }
    }
    return { rows: [], rowCount: 0 }
  }
  return { log, handler }
}

const WRITE_RE = /\b(BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|TRUNCATE|FOR\s+UPDATE|FOR\s+SHARE|pg_advisory\w*|LOCK\s+TABLE)\b/i
const SCOPE_OR_SCAN_RE = /plugin_multitable_object_registry|integration_pipelines|approval_record_projection|meta_records|to_jsonb\(meta_sheets\)|SELECT property FROM meta_fields/

const ADMIN_PERMS = ['multitable:read', 'multitable:write', 'multitable:manage-schema']

/**
 * ONE router for the whole file: the module graph behind `univer-meta` is imported once (beforeAll), and each
 * test swaps only the fake pool's handler and the actor's permissions. Re-importing per request made the suite
 * slow enough to time out under load, and a timed-out test's still-running loop could then install ITS app on
 * the shared pinned server underneath the next test.
 */
type Handler = (sql: string, params?: unknown[]) => { rows: any[]; rowCount?: number }
/** `seen` is EVERY statement the route issued (including the permission probes the handler never sees). */
const state: { handler: Handler; perms: string[]; seen: string[]; fieldPermissions: Array<{ sheet_id: string; subject_id: string; field_id: string; visible: boolean; read_only: boolean }> } = {
  handler: () => ({ rows: [] }), perms: ADMIN_PERMS, seen: [], fieldPermissions: [],
}
let transaction: ReturnType<typeof vi.fn>

const pinned = usePinnedServer()

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
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    state.seen.push(sql)
    // per-subject field permissions of the actor on a sheet: `$1` = user id, `$2` = sheet id
    if (sql.includes('FROM field_permissions fp') && sql.includes('WHERE fp.sheet_id = $2')) {
      const rows = state.fieldPermissions
        .filter((fp) => fp.sheet_id === params?.[1] && fp.subject_id === params?.[0])
        .map((fp) => ({ field_id: fp.field_id, visible: fp.visible, read_only: fp.read_only }))
      return { rows, rowCount: rows.length }
    }
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
      || sql.includes('FROM formula_dependencies')
    ) {
      return { rows: [], rowCount: 0 }
    }
    return state.handler(sql, params)
  })
  transaction = vi.fn(async () => {
    throw new Error('retype-preview must never open a transaction')
  })
  vi.spyOn(poolManager, 'get').mockReturnValue({ query, transaction } as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'user_convert', roles: [], perms: [...state.perms] } as any
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  pinned.setApp(app)
}, 120_000)

afterAll(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../../src/rbac/service')
  vi.resetModules()
})

describe('POST /fields/:fieldId/retype-preview (ADR §2)', () => {
  beforeEach(() => {
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', 'true')
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', '')
    vi.stubEnv('MULTITABLE_SHEET_REVERT_MAX_RECORDS', '')
    vi.stubEnv('RESTORE_PREVIEW_SECRET', SECRET)
    transaction.mockClear()
    state.handler = () => ({ rows: [] })
    state.perms = ADMIN_PERMS
    state.seen = []
    state.fieldPermissions = []
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const preview = async (w: World, body: unknown = { targetType: 'select' }, perms: string[] = ADMIN_PERMS) => {
    const store = createStore(w)
    state.handler = store.handler
    state.perms = perms
    state.seen = []
    const res = await request(pinned.url()).post(`/api/multitable/fields/${FIELD}/retype-preview`).send(body as object)
    return { res, log: store.log, seen: [...state.seen], transaction }
  }

  const expectNoWrites = (log: string[], transaction: ReturnType<typeof vi.fn>) => {
    expect(log.filter((sql) => WRITE_RE.test(sql))).toEqual([])
    expect(state.seen.filter((sql) => WRITE_RE.test(sql))).toEqual([])
    expect(transaction).not.toHaveBeenCalled()
  }

  // ── the five gates, in order ─────────────────────────────────────────────────────────────────────────
  test('① flag off ⇒ 403 FIELD_RETYPE_CONVERT_DISABLED before ANY query', async () => {
    for (const v of ['', 'TRUE', '1', ' true']) {
      vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', v)
      const { res, seen } = await preview(world({ records: [{ id: 'r1', version: 1, data: { [FIELD]: 'A' } }] }))
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('FIELD_RETYPE_CONVERT_DISABLED')
      expect(seen).toEqual([])
    }
  })

  test('① is checked before ②: flag off + legacy flag on is still 403, not 409', async () => {
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', '')
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', 'true')
    const { res } = await preview(world())
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FIELD_RETYPE_CONVERT_DISABLED')
  })

  test('② legacy manage-schema flag on ⇒ 409 FIELD_RETYPE_TRUST_REQUIRED (reason legacy_manage_schema_flag), zero queries', async () => {
    for (const v of ['true', 'TRUE', ' true ']) {
      vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', v)
      const { res, seen } = await preview(world())
      expect(res.status).toBe(409)
      expect(res.body.error).toMatchObject({ code: 'FIELD_RETYPE_TRUST_REQUIRED', details: { reason: 'legacy_manage_schema_flag' } })
      expect(seen).toEqual([])
    }
  })

  test('③ without canManageFields ⇒ 403 FORBIDDEN, no scope/scan query', async () => {
    const { res, log, transaction } = await preview(world({ records: [{ id: 'r1', version: 1, data: { [FIELD]: 'A' } }] }), undefined, ['multitable:read', 'multitable:write'])
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(log.filter((sql) => SCOPE_OR_SCAN_RE.test(sql))).toEqual([])
    expectNoWrites(log, transaction)
  })

  test('④ dead sheet ⇒ 404 via sendSheetNotLive, no scope/scan query', async () => {
    const { res, log } = await preview(world({ sheet: { deleted_at: '2026-09-01T00:00:00Z', row_level_read_permissions_enabled: false, base_id: 'base_1', system_kind: null, description: null } }))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('SHEET_DELETED')
    expect(log.filter((sql) => SCOPE_OR_SCAN_RE.test(sql))).toEqual([])
  })

  test('④ absent sheet ⇒ 404 NOT_FOUND', async () => {
    const { res } = await preview(world({ sheet: null }))
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  test('⑤ no full-table read ⇒ whole-surface 403 FULL_TABLE_READ_REQUIRED, no scope/scan query', async () => {
    const { res, log } = await preview(world({ sheet: { deleted_at: null, row_level_read_permissions_enabled: true, base_id: 'base_1', system_kind: null, description: null } }))
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FULL_TABLE_READ_REQUIRED')
    expect(JSON.stringify(res.body)).not.toMatch(/recordIds|cells|scanned/)
    expect(log.filter((sql) => SCOPE_OR_SCAN_RE.test(sql))).toEqual([])
  })

  test('⑤ checks canRead itself: multitable:manage-schema alone (canManageFields without canRead) ⇒ 403, no scope/scan query, no recordId', async () => {
    // canManageFields holds on manage-schema alone (access.ts deriveCapabilities / manage-schema-permission.ts
    // deriveCanManageFields); without a canRead check this principal passes all five gates and is handed every
    // rejected recordId of a sheet it cannot read. NOTE: since #6147 the real hasFullTableReadAccess checks canRead
    // too, so THIS route-level test would stay green if the gate's own check were removed — the gate's line is
    // pinned where the callback can be stubbed: tests/unit/multitable-field-retype-convert-gates.test.ts.
    const w = () => world({ records: [{ id: 'rec_ok', version: 1, data: { [FIELD]: 'A' } }, { id: 'rec_trail', version: 1, data: { [FIELD]: 'B ' } }] })
    const { res, log, transaction } = await preview(w(), undefined, ['multitable:manage-schema'])
    expect(res.status).toBe(403)
    // past ③ (not FORBIDDEN) and ④ (not 404): the refusal is the full-table read gate
    expect(res.body.error.code).toBe('FULL_TABLE_READ_REQUIRED')
    expect(JSON.stringify(res.body)).not.toMatch(/recordIds|cells|scanned|rec_ok|rec_trail/)
    expect(log.filter((sql) => SCOPE_OR_SCAN_RE.test(sql))).toEqual([])
    expectNoWrites(log, transaction)
    // control: the read code alone is what opens the gate on the very same sheet
    const withRead = await preview(w(), undefined, ['multitable:manage-schema', 'multitable:read'])
    expect(withRead.res.status).toBe(200)
    expect(withRead.res.body.data.rejections).toEqual([{ reason: 'leading_trailing_whitespace', recordCount: 1, recordIds: ['rec_trail'] }])
  })

  test('gate ORDER ③ → ④ → ⑤: a dead sheet answers 404 to a principal who would also fail ⑤, and 403 to one who fails ③', async () => {
    const dead = () => world({
      sheet: { deleted_at: '2026-09-01T00:00:00Z', row_level_read_permissions_enabled: true, base_id: 'base_1', system_kind: null, description: null },
      records: [{ id: 'rec_1', version: 1, data: { [FIELD]: 'A' } }],
    })
    // fails ⑤ twice over (no canRead, row-level deny on) but holds ③: the answer is ④
    const fourth = await preview(dead(), undefined, ['multitable:manage-schema'])
    expect([fourth.res.status, fourth.res.body.error.code]).toEqual([404, 'SHEET_DELETED'])
    // a full-permission principal on the same dead sheet: ④ as well
    const full = await preview(dead())
    expect([full.res.status, full.res.body.error.code]).toEqual([404, 'SHEET_DELETED'])
    // fails ③: told nothing about the sheet being gone
    const third = await preview(dead(), undefined, ['multitable:read', 'multitable:write'])
    expect([third.res.status, third.res.body.error.code]).toEqual([403, 'FORBIDDEN'])
    for (const { log, transaction } of [fourth, full, third]) {
      expect(log.filter((sql) => SCOPE_OR_SCAN_RE.test(sql))).toEqual([])
      expectNoWrites(log, transaction)
    }
  })

  test('⑤ field-mask axis: a field_permissions row with visible=false for this actor ⇒ 403 FULL_TABLE_READ_REQUIRED, no scope/scan query', async () => {
    const w = () => world({ records: [{ id: 'rec_1', version: 1, data: { [FIELD]: 'A' } }] })
    const masked = async (fieldPermissions: typeof state.fieldPermissions) => {
      const store = createStore(w())
      state.handler = store.handler
      state.perms = ADMIN_PERMS
      state.seen = []
      state.fieldPermissions = fieldPermissions
      const res = await request(pinned.url()).post(`/api/multitable/fields/${FIELD}/retype-preview`).send({ targetType: 'select' })
      return { res, log: store.log }
    }
    // the converted column itself is hidden from the actor
    let { res, log } = await masked([{ sheet_id: SHEET, subject_id: 'user_convert', field_id: FIELD, visible: false, read_only: false }])
    expect([res.status, res.body.error.code]).toEqual([403, 'FULL_TABLE_READ_REQUIRED'])
    expect(JSON.stringify(res.body)).not.toMatch(/recordIds|cells|scanned|rec_1/)
    expect(log.filter((sql) => SCOPE_OR_SCAN_RE.test(sql))).toEqual([])
    expectNoWrites(log, transaction)
    // controls: a read-only (still visible) row, a row for ANOTHER actor, a row on ANOTHER sheet — none of them masks
    for (const row of [
      { sheet_id: SHEET, subject_id: 'user_convert', field_id: FIELD, visible: true, read_only: true },
      { sheet_id: SHEET, subject_id: 'user_someone_else', field_id: FIELD, visible: false, read_only: false },
      { sheet_id: 'sheet_elsewhere', subject_id: 'user_convert', field_id: FIELD, visible: false, read_only: false },
    ]) {
      ;({ res, log } = await masked([row]))
      expect([JSON.stringify(row), res.status]).toEqual([JSON.stringify(row), 200])
    }
  })

  test('a recycle-bin row of ANOTHER sheet is not part of this sheet\'s scan: not counted, not blocking, not in the plan hash', async () => {
    const records: RecordRow[] = [{ id: 'r1', version: 1, data: { [FIELD]: 'A' } }]
    const hashOf = (res: request.Response) => String((jwt.verify(res.body.data.previewToken, SECRET) as Record<string, unknown>).planHash)
    const alone = await preview(world({ records }))
    const withForeign = await preview(world({ records, trash: [{ record_id: 't_foreign', sheet_id: 'sheet_elsewhere', data: { [FIELD]: 'a value that would block' } }] }))
    for (const { res } of [alone, withForeign]) {
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ verdict: 'ok', trash: { scanned: 0, blocking: 0 }, rejections: [] })
    }
    expect(hashOf(withForeign.res)).toBe(hashOf(alone.res))
    expect(JSON.stringify(withForeign.res.body)).not.toContain('t_foreign')
    // control: the same row on THIS sheet blocks
    const own = await preview(world({ records, trash: [{ record_id: 't_own', data: { [FIELD]: 'a value that would block' } }] }))
    expect(own.res.body.data).toMatchObject({ verdict: 'rejected', trash: { scanned: 1, blocking: 1 } })
  })

  test('a row whose data is not a JSON object rejects the whole run (record_data_not_object): listed by id, no token, values-free', async () => {
    const shapes: unknown[] = [[], [FIELD], ["VAL-IN-ARRAY"], "VAL-SCALAR", FIELD, 7, true, null]
    for (const shape of shapes) {
      const { res, log, transaction } = await preview(world({
        records: [{ id: 'r_ok', version: 1, data: { [FIELD]: 'VAL-OK' } }, { id: 'r_bad', version: 1, data: shape }],
        trash: [{ record_id: 't_bad', data: shape }, { record_id: 't_ok', data: {} }],
      }))
      expect([JSON.stringify(shape), res.status]).toEqual([JSON.stringify(shape), 200])
      expect(res.body.data).toMatchObject({
        verdict: 'rejected', scannedRecordCount: 2, cells: { empty: 0, converted: 1, rejected: 1 }, trash: { scanned: 2, blocking: 1 },
        rejections: [{ reason: 'record_data_not_object', recordCount: 2, recordIds: ['r_bad', 't_bad'] }],
      })
      expect(res.body.data.previewToken).toBeUndefined()
      expect(JSON.stringify(res.body)).not.toMatch(/VAL-/)
      expectNoWrites(log, transaction)
    }
  })

  test('the fake answers the recycle bin only to a sheet-filtered statement that binds the sheet id first', () => {
    const store = createStore(world({ trash: [{ record_id: 't1', data: { [FIELD]: 'A' } }] }))
    const cells = 'SELECT record_id, (data ? $2::text) AS has_key FROM meta_records_trash'
    expect(store.handler(`${cells} WHERE sheet_id = $1`, [SHEET, FIELD]).rows).toHaveLength(1)
    expect(store.handler('SELECT count(*)::int AS c FROM meta_records_trash WHERE sheet_id = $1', [SHEET]).rows).toEqual([{ c: 1 }])
    // no sheet filter, another sheet, the field id bound first, nothing bound
    expect(store.handler(cells, [SHEET, FIELD]).rows).toEqual([])
    expect(store.handler(`${cells} WHERE sheet_id = $1`, ['sheet_elsewhere', FIELD]).rows).toEqual([])
    expect(store.handler(`${cells} WHERE sheet_id = $1`, [FIELD, SHEET]).rows).toEqual([])
    expect(store.handler(`${cells} WHERE sheet_id = $1`, []).rows).toEqual([])
    expect(store.handler('SELECT count(*)::int AS c FROM meta_records_trash', [SHEET]).rows).toEqual([])
  })

  test('unknown field ⇒ 404, values-free (the requested id is not echoed)', async () => {
    const { res } = await preview(world({ fields: [] }))
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain(FIELD)
  })

  test('body: property is refused (options are server-derived), missing targetType ⇒ 400', async () => {
    expect((await preview(world(), { targetType: 'select', property: { options: [] } })).res.status).toBe(400)
    expect((await preview(world(), {})).res.status).toBe(400)
  })

  // ── scope: 422 FIELD_RETYPE_CONVERT_NOT_SUPPORTED, first hit ────────────────────────────────────────
  const expect422 = async (w: World, reason: string, body: unknown = { targetType: 'select' }) => {
    const { res, log, transaction } = await preview(w, body)
    expect(res.status).toBe(422)
    expect(res.body.error).toMatchObject({ code: 'FIELD_RETYPE_CONVERT_NOT_SUPPORTED', details: { reason } })
    // refused before the scan
    expect(log.filter((sql) => /FROM meta_records/.test(sql))).toEqual([])
    expectNoWrites(log, transaction)
    return log
  }

  test('pair_not_in_first_batch: string → number, longText → select', async () => {
    await expect422(world(), 'pair_not_in_first_batch', { targetType: 'number' })
    await expect422(world({ fields: [{ id: FIELD, sheet_id: SHEET, name: 'Notes', type: 'longText', property: {}, order: 0 }] }), 'pair_not_in_first_batch')
  })

  test('excluded_type: formula source / attachment target', async () => {
    await expect422(world({ fields: [{ id: FIELD, sheet_id: SHEET, name: 'F', type: 'formula', property: { expression: '=1' }, order: 0 }] }), 'excluded_type')
    await expect422(world(), 'excluded_type', { targetType: 'attachment' })
  })

  test('(a) plugin_managed_sheet', async () => {
    await expect422(world({ pluginRegistry: true, pipelineStaging: true, approvalProjection: true }), 'plugin_managed_sheet')
  })

  test('(b) system_managed_sheet — by system_kind and by the People sentinel', async () => {
    await expect422(world({ sheet: { deleted_at: null, row_level_read_permissions_enabled: false, base_id: 'base_1', system_kind: 'people_directory', description: null } }), 'system_managed_sheet')
    await expect422(world({ sheet: { deleted_at: null, row_level_read_permissions_enabled: false, base_id: 'base_1', system_kind: null, description: '__metasheet_system:people__' } }), 'system_managed_sheet')
  })

  test('(c) plugin_tagged_fields — any field carrying either namespace, object or JSON-string property', async () => {
    const other = (property: unknown): FieldRow => ({ id: 'fld_other', sheet_id: SHEET, name: 'Other', type: 'number', property, order: 1 })
    const base = world().fields
    await expect422(world({ fields: [...base, other({ stockPreparation: { ownership: 'plm_system' } })] }), 'plugin_tagged_fields')
    await expect422(world({ fields: [...base, other({ stockPreparationMvp: null })] }), 'plugin_tagged_fields')
    await expect422(world({ fields: [...base, other(JSON.stringify({ stockPreparation: {} }))] }), 'plugin_tagged_fields')
  })

  test('(d) pipeline_staging_sheet', async () => {
    await expect422(world({ pipelineStaging: true, approvalProjection: true }), 'pipeline_staging_sheet')
  })

  test('(e) approval_projection_sheet — with system_kind NULL (the deploy-window residue)', async () => {
    const log = await expect422(world({ approvalProjection: true }), 'approval_projection_sheet')
    expect(log.some((sql) => sql.includes('FROM approval_record_projection WHERE sheet_id = $1'))).toBe(true)
  })

  test('first hit wins and stops: (a) refuses without asking (b)-(e)', async () => {
    const log = await expect422(world({ pluginRegistry: true, approvalProjection: true }), 'plugin_managed_sheet')
    expect(log.filter((sql) => /integration_pipelines|approval_record_projection|to_jsonb\(meta_sheets\)/.test(sql))).toEqual([])
  })

  // ── size ────────────────────────────────────────────────────────────────────────────────────────────
  test('live + trash above the record cap ⇒ 413 SHEET_TOO_LARGE, no row read', async () => {
    vi.stubEnv('MULTITABLE_SHEET_REVERT_MAX_RECORDS', '3')
    const records = [1, 2, 3].map((i) => ({ id: `r${i}`, version: 1, data: { [FIELD]: 'A' } }))
    const { res, log } = await preview(world({ records, trash: [{ record_id: 't1', data: {} }] }))
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('SHEET_TOO_LARGE')
    expect(log.filter((sql) => sql.includes('has_key'))).toEqual([])
    // at the cap exactly: allowed
    const ok = await preview(world({ records }))
    expect(ok.res.status).toBe(200)
  })

  // ── the scan ────────────────────────────────────────────────────────────────────────────────────────
  test('ok verdict: counts, recordCap, token with the locked claims — zero writes, values-free', async () => {
    const records: RecordRow[] = [
      { id: 'r2', version: 5, data: { [FIELD]: '机密-BETA', other: 'x' } },
      { id: 'r1', version: 2, data: { [FIELD]: '机密-ALPHA' } },
      { id: 'r3', version: 1, data: { other: 'no key' } },
      { id: 'r4', version: 1, data: { [FIELD]: '' } },
      { id: 'r5', version: 1, data: { [FIELD]: '机密-ALPHA' } },
    ]
    const { res, log, transaction } = await preview(world({ records, trash: [{ record_id: 't1', data: { [FIELD]: null } }] }), { targetType: 'multiSelect' })
    expect(res.status).toBe(200)
    const data = res.body.data
    expect(data).toMatchObject({
      verdict: 'ok', sourceType: 'string', targetType: 'multiSelect', scannedRecordCount: 5, recordCap: 5000,
      trash: { scanned: 1, blocking: 0 }, cells: { empty: 2, converted: 3, rejected: 0 },
      options: { new: 2, final: 2, limit: 5000, droppedValidationRuleCount: 0 }, rejections: [], confirm: 'convert-field-type',
    })
    const payload = jwt.verify(data.previewToken, SECRET) as Record<string, unknown>
    expect(payload).toMatchObject({ type: 'field-retype-convert-preview', sheetId: SHEET, fieldId: FIELD, actorId: 'user_convert', sourceType: 'string', targetType: 'multiSelect' })
    expect(String(payload.planHash)).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(res.body)).not.toContain('机密')
    expectNoWrites(log, transaction)
  })

  test('planHash is stable across previews and independent of the DB row order; moves when a cell moves', async () => {
    const records: RecordRow[] = [
      { id: 'a', version: 1, data: { [FIELD]: 'X' } },
      { id: 'B', version: 1, data: { [FIELD]: 'Y' } },
    ]
    const hashOf = async (rows: RecordRow[]) => {
      const { res } = await preview(world({ records: rows }))
      expect(res.status).toBe(200)
      return String((jwt.verify(res.body.data.previewToken, SECRET) as Record<string, unknown>).planHash)
    }
    const h1 = await hashOf(records)
    expect(await hashOf(records)).toBe(h1)
    expect(await hashOf([...records].reverse())).toBe(h1)
    expect(await hashOf([records[0]!, { id: 'B', version: 1, data: { [FIELD]: 'Z' } }])).not.toBe(h1)
    expect(await hashOf([records[0]!, { id: 'B', version: 2, data: { [FIELD]: 'Y' } }])).not.toBe(h1)
  })

  test('rule A through the route: rejected verdict is a 200 report, lists every id, no token', async () => {
    const records: RecordRow[] = [
      { id: 'r1', version: 1, data: { [FIELD]: 'VAL-OK' } },
      { id: 'r2', version: 1, data: { [FIELD]: 'VAL-TRAIL ' } },
      { id: 'r3', version: 1, data: { [FIELD]: '   ' } },
      { id: 'r4', version: 1, data: { [FIELD]: 12 } },
      { id: 'r5', version: 1, data: { [FIELD]: ' VAL-LEAD' } },
    ]
    const { res, log, transaction } = await preview(world({ records }))
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      verdict: 'rejected',
      cells: { empty: 0, converted: 1, rejected: 4 },
      rejections: [
        { reason: 'leading_trailing_whitespace', recordCount: 2, recordIds: ['r2', 'r5'] },
        { reason: 'whitespace_only', recordCount: 1, recordIds: ['r3'] },
        { reason: 'non_string_value', recordCount: 1, recordIds: ['r4'] },
      ],
    })
    expect(res.body.data.previewToken).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toMatch(/VAL-/)
    expectNoWrites(log, transaction)
  })

  test('trash blocking: a clean column with one valued recycle-bin row is rejected (trashed_rows_with_value)', async () => {
    const { res } = await preview(world({
      records: [{ id: 'r1', version: 1, data: { [FIELD]: 'A' } }],
      trash: [{ record_id: 't1', data: { [FIELD]: 'A' } }, { record_id: 't2', data: { [FIELD]: '' } }],
    }))
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      verdict: 'rejected', trash: { scanned: 2, blocking: 1 },
      rejections: [{ reason: 'trashed_rows_with_value', recordCount: 1, recordIds: ['t1'] }],
    })
    expect(res.body.data.previewToken).toBeUndefined()
  })

  test('a pre-migration database without the recycle-bin table scans live rows only', async () => {
    const { res } = await preview(world({ records: [{ id: 'r1', version: 1, data: { [FIELD]: 'A' } }], trash: 'missing-table' }))
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ verdict: 'ok', trash: { scanned: 0, blocking: 0 } })
  })

  test('option cap through the route (cap raised above 5000): 5001 distinct ⇒ option_limit_exceeded', async () => {
    vi.stubEnv('MULTITABLE_SHEET_REVERT_MAX_RECORDS', '6000')
    const records = Array.from({ length: 5001 }, (_, i) => ({ id: `r${String(i).padStart(5, '0')}`, version: 1, data: { [FIELD]: `v${i}` } }))
    const { res } = await preview(world({ records }))
    expect(res.status).toBe(200)
    expect(res.body.data.verdict).toBe('rejected')
    expect(res.body.data.options).toEqual({ new: 5001, final: 5001, limit: 5000, droppedValidationRuleCount: 0 })
    expect(res.body.data.rejections).toEqual([{ reason: 'option_limit_exceeded', recordCount: 0, recordIds: [] }])
  })
})
