/**
 * 字段类型转换第 3 刀 —— Time Machine 配置回滚（Tier-2）对**转换修订**与**撤销修订**的拒绝。
 * 设计锁：docs/development/multitable-field-retype-first-batch-adr-20260926.md §3.10。
 *
 * 转换修订在配置历史里与普通 PATCH 改类型长得一样（`update`、changed_keys = type + property、两端都是纯标量），
 * `isSupportedFieldRetypeRevert` 会放行它；而「只回滚 schema、单元格不动」对它不成立。三处守卫各有一条用例：
 *   - 预览：签发凭证之前；
 *   - 执行的通用分支：事务内、`applyConfigRevert` 之前；
 *   - 执行的 4c-1 有损分支：事务内、单元格回写之前（转换修订的 changed_keys 含 type，本来进不了这个分支——
 *     这里用一条人造的作业行指向一条 property-only 修订，证明该守卫本身在岗）。
 * 每条都配一个对照：同一张表上一条**不是**转换留下的修订，照常越过守卫。
 *
 * DB-free：表感知的内存替身 + pinned server。转换与撤销修订由产品自己的预览 / 执行 / 撤销路由写出。
 */
import { randomUUID } from 'node:crypto'

import express from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { dbUser, emptyWorld, FAKE_WRITE_RE, FieldRetypeConvertFakePg, type FakeWorld } from '../utils/field-retype-convert-fake-pg'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET = 'sheet_tier2_1'
const FIELD = 'fld_tier2_1'
const URL_FIELD = 'fld_tier2_url'
const ACTOR = 'user_tier2'
const SECRET = 'retype-tier2-secret-0123456789abcdef'
const PERMS = ['multitable:read', 'multitable:write', 'multitable:manage-schema']
const REFUSAL = { code: 'RESTORE_NOT_SUPPORTED', details: { reason: 'field_retype_conversion' } }

function world(): FakeWorld {
  return {
    ...emptyWorld(),
    sheets: [{ id: SHEET, base_id: 'base_1', deleted_at: null, row_level_read_permissions_enabled: false, system_kind: null, description: null, recovery_writer_state: null }],
    fields: [
      { id: FIELD, sheet_id: SHEET, name: 'Status', type: 'string', property: {}, order: 0 },
      { id: URL_FIELD, sheet_id: SHEET, name: 'Link', type: 'url', property: {}, order: 1 },
    ],
    records: [{ id: 'r1', sheet_id: SHEET, version: 1, data: { [FIELD]: '机密-ALPHA' } }],
    dbUsers: { [ACTOR]: dbUser(PERMS) },
  }
}

const tables = (w: FakeWorld) => ({
  fields: w.fields, records: w.records, tombstones: w.tombstones, conversions: w.conversions,
  recordRevisions: w.recordRevisions, configRevisions: w.configRevisions, audit: w.audit, operations: w.operations,
})
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const state: { pg: FieldRetypeConvertFakePg } = { pg: new FieldRetypeConvertFakePg(emptyWorld()) }
const pinned = usePinnedServer()
let resetProbe: () => void

beforeAll(async () => {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn(async () => PERMS),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const routes = await import('../../src/routes/univer-meta')
  resetProbe = (await import('../../src/multitable/field-retype-convert-execute')).__resetFieldRetypeConversionsTableProbe
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query: (sql: string, params?: unknown[]) => state.pg.query(sql, params),
    transaction: (handler: never) => state.pg.transaction(handler),
  } as never)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: ACTOR, roles: [], perms: [...PERMS] } as never
    next()
  })
  app.use('/api/multitable', routes.univerMetaRouter())
  pinned.setApp(app)
}, 120_000)

afterAll(() => {
  vi.restoreAllMocks()
  vi.doUnmock('../../src/rbac/service')
  vi.resetModules()
})

describe('config-restore refuses field retype CONVERSION revisions (ADR §3.10)', () => {
  beforeEach(() => {
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE', 'true')
    vi.stubEnv('MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', '')
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_REVERT', 'true')
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY', '')
    vi.stubEnv('RESTORE_PREVIEW_SECRET', SECRET)
    resetProbe()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const post = (path: string, body: unknown) => request(pinned.url()).post(`/api/multitable${path}`).send(body as object)
  const restorePreview = (revisionId: string) => post(`/sheets/${SHEET}/config-restore-preview`, { revisionId })
  const restoreExecute = (revisionId: string, extra: Record<string, unknown> = {}) => post(`/sheets/${SHEET}/config-restore-execute`, { revisionId, previewToken: 'not-a-token', ...extra })

  /** Convert FIELD, then undo it, through the product's own routes. Returns both revision ids. */
  async function convertedAndUndone(): Promise<{ pg: FieldRetypeConvertFakePg; convertId: string; undoId: string }> {
    const pg = new FieldRetypeConvertFakePg(world(), { permissiveTransaction: true })
    state.pg = pg
    const previewed = await post(`/fields/${FIELD}/retype-preview`, { targetType: 'select' })
    expect(previewed.status).toBe(200)
    const executed = await post(`/fields/${FIELD}/retype-execute`, { previewToken: previewed.body.data.previewToken, confirm: 'convert-field-type' })
    expect(executed.status).toBe(200)
    const convertId = String(executed.body.data.convertRevisionId)
    const undone = await post(`/fields/${FIELD}/retype-undo`, { convertRevisionId: convertId, confirm: 'undo-field-type-convert' })
    expect(undone.status).toBe(200)
    return { pg, convertId, undoId: String(undone.body.data.undoRevisionId) }
  }

  /** An ordinary retype revision — the kind a plain PATCH leaves behind. */
  function ordinaryRevision(pg: FieldRetypeConvertFakePg, over: Record<string, unknown> = {}): string {
    const id = randomUUID()
    pg.world.configRevisions.push({
      id, sheet_id: SHEET, entity_type: 'field', entity_id: FIELD, action: 'update',
      before: { type: 'longText' }, after: { type: 'string' }, changed_keys: ['type'], batch_id: id, actor_id: ACTOR,
      source: 'mutation', restored_from_id: null, operation_id: null, ...over,
    })
    return id
  }

  const isConversionRefusal = (res: request.Response): boolean =>
    res.status === 422 && res.body?.error?.code === REFUSAL.code && res.body?.error?.details?.reason === REFUSAL.details.reason

  test('the revisions under test have the shape Tier-2 would otherwise open', async () => {
    const { isSupportedFieldRetypeRevert } = await import('../../src/multitable/config-restore')
    const { pg, convertId, undoId } = await convertedAndUndone()
    for (const id of [convertId, undoId]) {
      const rev = pg.world.configRevisions.find((r) => r.id === id)
      expect(rev).toMatchObject({ entity_type: 'field', action: 'update', changed_keys: ['type', 'property'] })
      expect(isSupportedFieldRetypeRevert(rev as never)).toBe(true)
    }
  })

  test('preview: a conversion revision and its undo revision ⇒ 422, NO token minted, nothing written; an ordinary revision passes the guard', async () => {
    const { pg, convertId, undoId } = await convertedAndUndone()
    for (const id of [convertId, undoId]) {
      const before = copy(tables(pg.world))
      const n = pg.statements.length
      const res = await restorePreview(id)
      expect([res.status, res.body.error.code, res.body.error.details]).toEqual([422, REFUSAL.code, REFUSAL.details])
      expect(res.body.data).toBeUndefined()
      expect(JSON.stringify(res.body)).not.toMatch(/previewToken|机密/)
      expect(tables(pg.world)).toEqual(before)
      expect(pg.statements.slice(n).filter((s) => FAKE_WRITE_RE.test(s.sql))).toEqual([])
      expect(pg.statements.slice(n).some((s) => s.inTransaction)).toBe(false)
    }
    const control = await restorePreview(ordinaryRevision(pg))
    expect(isConversionRefusal(control)).toBe(false)
  })

  test('preview: with the Tier-2 flag OFF the whole surface is 403 first — for a conversion revision too', async () => {
    const { convertId } = await convertedAndUndone()
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_REVERT', '')
    const res = await restorePreview(convertId)
    expect([res.status, res.body.error.code]).toEqual([403, 'FIELD_RETYPE_REVERT_DISABLED'])
  })

  test('execute (generic branch): refused INSIDE the transaction, after the fence, before applyConfigRevert — zero writes', async () => {
    const { pg, convertId, undoId } = await convertedAndUndone()
    for (const id of [convertId, undoId]) {
      const before = copy(tables(pg.world))
      const n = pg.statements.length
      const res = await restoreExecute(id)
      expect([res.status, res.body.error.code, res.body.error.details]).toEqual([422, REFUSAL.code, REFUSAL.details])
      expect(tables(pg.world)).toEqual(before)
      const tx = pg.statements.slice(n).filter((s) => s.inTransaction).map((s) => s.sql.replace(/\s+/g, ' ').trim())
      expect(tx[0]).toContain('pg_advisory_xact_lock')
      expect(tx.some((sql) => sql.includes('FROM meta_field_retype_conversions WHERE convert_revision_id = $1::uuid OR undo_revision_id = $1::uuid'))).toBe(true)
      expect(tx.filter((sql) => FAKE_WRITE_RE.test(sql))).toEqual([])
    }
    const control = await restoreExecute(ordinaryRevision(pg))
    expect(isConversionRefusal(control)).toBe(false)
  })

  test('execute (4c-1 lossy branch): a job row naming a property-only revision is refused inside that transaction too', async () => {
    vi.stubEnv('MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY', 'true')
    const pg = new FieldRetypeConvertFakePg(world(), { permissiveTransaction: true })
    state.pg = pg
    const flagged = ordinaryRevision(pg, { entity_id: URL_FIELD, before: { property: { a: 1 } }, after: { property: {} }, changed_keys: ['property'] })
    const plain = ordinaryRevision(pg, { entity_id: URL_FIELD, before: { property: { a: 1 } }, after: { property: {} }, changed_keys: ['property'] })
    pg.world.conversions.push({
      convert_revision_id: flagged, sheet_id: SHEET, field_id: URL_FIELD, source_type: 'string', source_property: {},
      target_type: 'select', target_property: { options: [] }, record_count: 0, actor_id: ACTOR, undone_at: null, undo_revision_id: null,
    })
    const before = copy(tables(pg.world))
    const n = pg.statements.length
    const res = await restoreExecute(flagged, { confirm: 'revert-retype-lossy' })
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([422, REFUSAL.code, REFUSAL.details])
    expect(tables(pg.world)).toEqual(before)
    const tx = pg.statements.slice(n).filter((s) => s.inTransaction).map((s) => s.sql.replace(/\s+/g, ' ').trim())
    expect(tx[0]).toContain('pg_advisory_xact_lock')
    // refused before the lossy branch locks its field row
    expect(tx.some((sql) => sql.startsWith('SELECT id, sheet_id, type FROM meta_fields WHERE id = $1 FOR UPDATE'))).toBe(false)

    // control: the twin revision with no job row goes on into the lossy branch (and is stopped later, by its token)
    const m = pg.statements.length
    const control = await restoreExecute(plain, { confirm: 'revert-retype-lossy' })
    expect(isConversionRefusal(control)).toBe(false)
    const controlTx = pg.statements.slice(m).filter((s) => s.inTransaction).map((s) => s.sql.replace(/\s+/g, ' ').trim())
    expect(controlTx.some((sql) => sql.startsWith('SELECT id, sheet_id, type FROM meta_fields WHERE id = $1 FOR UPDATE'))).toBe(true)
  })

  test('only FIELD revisions are looked up: a view / sheet_config revision never asks the conversions table', async () => {
    const pg = new FieldRetypeConvertFakePg(world(), { permissiveTransaction: true })
    state.pg = pg
    const id = ordinaryRevision(pg, { entity_type: 'view', entity_id: 'view_1', before: { name: 'a' }, after: { name: 'b' }, changed_keys: ['name'] })
    pg.world.conversions.push({
      convert_revision_id: id, sheet_id: SHEET, field_id: FIELD, source_type: 'string', source_property: {},
      target_type: 'select', target_property: {}, record_count: 0, actor_id: ACTOR, undone_at: null, undo_revision_id: null,
    })
    for (const res of [await restorePreview(id), await restoreExecute(id)]) expect(isConversionRefusal(res)).toBe(false)
    expect(pg.statements.some((s) => s.sql.includes('meta_field_retype_conversions'))).toBe(false)
  })

  test('a field revision whose revert writes neither type nor property (rename / reorder) issues NO extra statement — and is not refused even if a job row names it', async () => {
    const pg = new FieldRetypeConvertFakePg(world(), { permissiveTransaction: true })
    state.pg = pg
    for (const changedKeys of [['name'], ['order'], ['name', 'order']]) {
      const id = ordinaryRevision(pg, { before: { name: 'Old', order: 0 }, after: { name: 'Status', order: 0 }, changed_keys: changedKeys })
      pg.world.conversions.push({
        convert_revision_id: id, sheet_id: SHEET, field_id: FIELD, source_type: 'string', source_property: {},
        target_type: 'select', target_property: {}, record_count: 0, actor_id: ACTOR, undone_at: null, undo_revision_id: null,
      })
      for (const res of [await restorePreview(id), await restoreExecute(id)]) expect([changedKeys.join('+'), isConversionRefusal(res)]).toEqual([changedKeys.join('+'), false])
    }
    expect(pg.statements.filter((s) => s.sql.includes('meta_field_retype_conversions'))).toEqual([])
  })

  test('a database without the conversions table (migration not applied) refuses nothing and does not error', async () => {
    const pg = new FieldRetypeConvertFakePg(world(), { permissiveTransaction: true })
    state.pg = pg
    pg.world.conversionsTable = false
    const id = ordinaryRevision(pg)
    for (const res of [await restorePreview(id), await restoreExecute(id)]) {
      expect(isConversionRefusal(res)).toBe(false)
      expect(res.status).not.toBe(500)
    }
    // the table was probed, never read
    expect(pg.statements.some((s) => s.sql.includes("to_regclass('meta_field_retype_conversions')"))).toBe(true)
    expect(pg.statements.some((s) => s.sql.includes('FROM meta_field_retype_conversions'))).toBe(false)
  })
})
