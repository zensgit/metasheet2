/**
 * 人工补充行的父组件 — ADR adr-stock-prep-manual-rows-20261030 §12 (owner-ruled 2026-11-19), slice P1: the routes, over the
 * real univer-meta router and the real record services, on the stateful fake Postgres of the B2 suite
 * (tests/utils/stock-prep-manual-rows-fake-pg.ts). The pure rules and the gate are in
 * stock-preparation-manual-rows-parent.test.ts; the B2 behaviour of the same three routes in
 * stock-preparation-manual-rows-routes.test.ts.
 *
 *   CP  POST /sheets/:sheetId/manual-rows with a parent — P3 / P4 / P5 / P7, stored as submitted, the pair's own gate
 *       (lock_missing / contract_mismatch only for a create that names the pair), re-checked in the create transaction;
 *       the lock exemption does not exist outside the manual-row branch.
 *   YP  POST /records/:recordId/manual-copy — the source's pair is carried whole or not at all (OQ-P1); the copy never
 *       fails because of the pair.
 *   EP  PATCH /records/:recordId/manual-fields — the pair with or without the six; P3 / P4; P5 in both directions,
 *       decided under the row lock; P7 over both columns; P8 (archived / switched off / deployment switch off still
 *       edit); PLM rows refused; /patch and PATCH /records still refuse the pair on a manual row (P2).
 *   XP  GET /context — `parentFieldIds` only for an actor who may write both columns, never in `editableFieldIds`.
 *   O   GET /sheets/:sheetId/manual-rows/parent-options — the gates, the candidates, and that nothing outside the
 *       actor's read sets is listed, matched by `q` or counted (columns travel as NULL, denied rows as ids).
 *   D   GET /records/:recordId/manual-parent-dependents — the gates and the count.
 *
 * Mock pool, no DB; one pinned listener (`request(app)` is banned in tests/unit, #4154). Every value is synthetic.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import {
  MR_ENV_OBJECT,
  MR_PROJECT_NO,
  MR_SWITCH,
  createManualRowsFakePool,
  type FakeRecord,
  type FakeSheet,
} from '../utils/stock-prep-manual-rows-fake-pg'
import { RecordService } from '../../src/multitable/record-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { loadManualRowsVerdict, mintManualRowCreateExtension } from '../../src/multitable/stock-preparation-manual-rows-gate'
import { MANUAL_ROW_PARENT_SQL_TRIM_CHARS } from '../../src/multitable/stock-preparation-manual-row-parent-options'

const fake = createManualRowsFakePool()

const WRITER = { id: 'u_mrp1_writer', roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const ADMIN = { id: 'u_mrp1_admin', roles: ['admin'], perms: [] as string[] }
const READER = { id: 'u_mrp1_reader', roles: ['member'], perms: ['multitable:read'] }
let actor: { id: string; roles: string[]; perms: string[] } = WRITER
let app: Express

const P = (n: number) => `plm_stock_preparation_sandbox_p_${n.toString(16).padStart(24, '0')}`
const PARENT_INVALID = 'STOCK_PREP_MANUAL_PARENT_INVALID'
const UNAVAILABLE = 'STOCK_PREP_MANUAL_ROWS_UNAVAILABLE'

let S: Record<string, FakeSheet>

function seedSheets(): Record<string, FakeSheet> {
  fake.reset()
  return {
    PREG: fake.addSheet('PREG', { objectId: P(1) }),
    DISABLED: fake.addSheet('DISABLED', { objectId: P(2), policy: 'disabled' }),
    ARCHIVED: fake.addSheet('ARCHIVED', { objectId: P(3), target: { status: 'archived' } }),
    NOLOCK: fake.addSheet('NOLOCK', { objectId: P(4), locked: 'none' }),
    // The three stamped columns locked; the parent pair (like every other PLM column) is not.
    PAIRUNLOCKED: fake.addSheet('PAIRUNLOCKED', { objectId: P(5), locked: ['idempotencyKey', 'projectNo', 'active'] }),
    // The stamps and the pair locked; the six fillable columns are not (a generic create can then reach the pair).
    PAIRLOCKEDONLY: fake.addSheet('PAIRLOCKEDONLY', { objectId: P(6), locked: ['idempotencyKey', 'projectNo', 'active', 'parentComponentCode', 'parentComponentName'] }),
    NOPARENTNAME: fake.addSheet('NOPARENTNAME', { objectId: P(7), omit: ['parentComponentName'] }),
    ENV: fake.addSheet('ENV', { objectId: MR_ENV_OBJECT, target: null }),
    PLAIN: fake.addSheet('PLAIN', { objectId: P(8), noStanza: true }),
  }
}

const ph = (sheet: FakeSheet, logical: string) => fake.phys(sheet, logical)
const pairOf = (sheet: FakeSheet) => ({ code: ph(sheet, 'parentComponentCode'), name: ph(sheet, 'parentComponentName') })
const recordsOf = (sheet: FakeSheet) => [...fake.records.values()].filter((r) => r.sheet_id === sheet.sheetId)
const cell = (record: FakeRecord | undefined, sheet: FakeSheet, logical: string) => record?.data[ph(sheet, logical)]
const has = (record: FakeRecord | undefined, sheet: FakeSheet, logical: string) => !!record && ph(sheet, logical) in record.data

async function buildApp(): Promise<Express> {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  vi.spyOn(poolManager, 'get').mockReturnValue(fake.pool as never)
  const built = express()
  built.use(express.json())
  built.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = actor
    next()
  })
  built.use('/api/multitable', univerMetaRouter())
  return built
}

const pinned = usePinnedServer()
const http = () => {
  pinned.setApp(app)
  return request(pinned.url())
}
const TOKEN = { authorization: 'Bearer mst_synthetic_token' }
const createRow = (sheet: FakeSheet, data: Record<string, unknown>) => http().post(`/api/multitable/sheets/${sheet.sheetId}/manual-rows`).send({ data })
const copyRow = (recordId: string) => http().post(`/api/multitable/records/${recordId}/manual-copy`).send({})
const editRow = (recordId: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  http().patch(`/api/multitable/records/${recordId}/manual-fields`).send({ data, ...extra })
const context = (sheet: FakeSheet) => http().get('/api/multitable/context').query({ sheetId: sheet.sheetId })
const options = (sheet: FakeSheet, query: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  http().get(`/api/multitable/sheets/${sheet.sheetId}/manual-rows/parent-options`).query(query).set(headers)
const dependents = (recordId: string, headers: Record<string, string> = {}) =>
  http().get(`/api/multitable/records/${recordId}/manual-parent-dependents`).set(headers)

/** A valid create body for `sheet`: 名称 + 总用量 (the two the create requires). */
const minimal = (sheet: FakeSheet, extra: Record<string, unknown> = {}) => ({
  [ph(sheet, 'componentName')]: 'Synthetic manual part',
  [ph(sheet, 'totalQuantity')]: 3,
  ...extra,
})
/** The pair as a request body fragment. */
const parent = (sheet: FakeSheet, code: unknown, name: unknown) => ({ [pairOf(sheet).code]: code, [pairOf(sheet).name]: name })
/** A stored manual row (M holds: the own key, a creator). */
const manualRow = (sheet: FakeSheet, id: string, cells: Record<string, unknown> = {}, createdBy: string | null = WRITER.id) =>
  fake.addRecord(sheet, id, { projectNo: MR_PROJECT_NO, idempotencyKey: `manual:v1:${id}`, active: true, componentName: 'SYN', totalQuantity: 1, ...cells }, createdBy)
/** A stored PLM row (a JSON key, no creator). */
const plmRow = (sheet: FakeSheet, id: string, cells: Record<string, unknown> = {}) =>
  fake.addRecord(sheet, id, { projectNo: MR_PROJECT_NO, idempotencyKey: JSON.stringify({ projectNo: MR_PROJECT_NO, componentSourceId: id }), componentSourceId: id, active: true, totalQuantity: 1, ...cells }, null)
const deny = (sheet: FakeSheet, fieldLogical: string, rule: { visible?: boolean; readOnly?: boolean }, userId = WRITER.id) =>
  fake.fieldPermissions.push({ sheetId: sheet.sheetId, fieldId: ph(sheet, fieldLogical), userId, visible: rule.visible ?? true, readOnly: rule.readOnly ?? false })
const refusal = (res: { body: { error?: { code?: string; details?: { reason?: string } } } }) => [res.body.error?.code, res.body.error?.details?.reason]

const SWITCH_BEFORE = process.env[MR_SWITCH]

beforeAll(async () => {
  app = await buildApp()
}, 120_000)

beforeEach(() => {
  S = seedSheets()
  actor = WRITER
  process.env[MR_SWITCH] = 'true'
  fake.pool.transaction.mockClear()
})

/** The request was answered by the ROUTE's own checks: no write transaction was ever opened (no fence, no re-read). */
const expectNoTransaction = () => expect(fake.pool.transaction).not.toHaveBeenCalled()

afterEach(() => {
  if (SWITCH_BEFORE === undefined) delete process.env[MR_SWITCH]
  else process.env[MR_SWITCH] = SWITCH_BEFORE
})

// ── CP. 新增 with a parent ───────────────────────────────────────────────────────────────────────────

describe('CP — 新增 with a parent: POST /sheets/:sheetId/manual-rows', () => {
  it('CP-01 both columns: 200, stored EXACTLY as submitted (surrounding whitespace kept), echoed; the stamps as always', async () => {
    const res = await createRow(S.PREG, minimal(S.PREG, { [ph(S.PREG, 'componentCode')]: 'SYN-CHILD', ...parent(S.PREG, ' SYN-PARENT ', 'Synthetic parent  ') }))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const id = res.body.data.record.id as string
    const stored = fake.records.get(id)!
    expect(cell(stored, S.PREG, 'parentComponentCode')).toBe(' SYN-PARENT ')
    expect(cell(stored, S.PREG, 'parentComponentName')).toBe('Synthetic parent  ')
    expect(cell(stored, S.PREG, 'idempotencyKey')).toBe(`manual:v1:${id}`)
    expect(cell(stored, S.PREG, 'projectNo')).toBe(MR_PROJECT_NO)
    expect(stored.created_by).toBe(WRITER.id)
    expect(res.body.data.record.data[pairOf(S.PREG).code]).toBe(' SYN-PARENT ')
    expect(res.body.data.record.data[pairOf(S.PREG).name]).toBe('Synthetic parent  ')
    // the parent need not exist on the sheet (rule P6): no other row was read or written for it
    expect(recordsOf(S.PREG)).toHaveLength(1)
  })

  it.each([
    ['a 图号 without a name', 'SYN-PARENT', null],
    ['a 图号 with an empty name', 'SYN-PARENT', ''],
    ['both null (no parent)', null, null],
    ['both empty (no parent)', '', ''],
    ['both whitespace (no parent; stored as sent, never rewritten)', '  ', ' '],
  ])('CP-02 %s: 200, both cells hold exactly what was sent', async (_label, code, name) => {
    const res = await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, code, name)))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = fake.records.get(res.body.data.record.id)!
    expect(cell(stored, S.PREG, 'parentComponentCode')).toBe(code)
    expect(cell(stored, S.PREG, 'parentComponentName')).toBe(name)
  })

  it('CP-03 no pair in the body: the two cells are not written at all (the row lands in the no-parent group, as before)', async () => {
    const res = await createRow(S.PREG, minimal(S.PREG))
    expect(res.status).toBe(200)
    const stored = fake.records.get(res.body.data.record.id)!
    expect(has(stored, S.PREG, 'parentComponentCode')).toBe(false)
    expect(has(stored, S.PREG, 'parentComponentName')).toBe(false)
  })

  it.each([
    ['only 父组件图号', 'parentComponentCode', 'SYN-PARENT'],
    ['only 父组件名称', 'parentComponentName', 'Synthetic parent'],
    ['only 父组件图号, as null', 'parentComponentCode', null],
  ])('CP-04 P3 %s: 400 pair_incomplete, nothing written', async (_label, logical, value) => {
    const res = await createRow(S.PREG, minimal(S.PREG, { [ph(S.PREG, logical)]: value }))
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(res.body).toEqual({ ok: false, error: { code: PARENT_INVALID, message: '父组件图号和父组件名称要一起提交，不能只改其中一列。', details: { reason: 'pair_incomplete' } } })
    expect(recordsOf(S.PREG)).toEqual([])
    expectNoTransaction()
  })

  it.each([
    ['a number 图号', 42, 'Synthetic parent'],
    ['a number name', 'SYN-PARENT', 7],
    ['a boolean', true, null],
    ['an object', { value: 'SYN-PARENT' }, null],
    ['an array', ['SYN-PARENT'], 'Synthetic parent'],
  ])('CP-05 P4 %s: 400 not_text, nothing written', async (_label, code, name) => {
    const res = await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, code, name)))
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(refusal(res)).toEqual([PARENT_INVALID, 'not_text'])
    expect(recordsOf(S.PREG)).toEqual([])
    expectNoTransaction()
  })

  it.each([
    ['a null 图号', null],
    ['an empty 图号', ''],
    ['a whitespace 图号', ' \t'],
  ])('CP-06 P4 a name with %s: 422 name_without_code, nothing written', async (_label, code) => {
    const res = await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, code, 'Synthetic parent')))
    expect(res.status, JSON.stringify(res.body)).toBe(422)
    expect(refusal(res)).toEqual([PARENT_INVALID, 'name_without_code'])
    expect(recordsOf(S.PREG)).toEqual([])
    expectNoTransaction()
  })

  it('CP-07 P5 the new row as its own parent: 422 self_parent (surrounding whitespace ignored, case kept); nothing written', async () => {
    const own = ph(S.PREG, 'componentCode')
    for (const [ownCode, parentCode] of [['SYN-1', 'SYN-1'], ['SYN-1', ' SYN-1 '], [' SYN-1', 'SYN-1\t']]) {
      const res = await createRow(S.PREG, minimal(S.PREG, { [own]: ownCode, ...parent(S.PREG, parentCode, 'Synthetic parent') }))
      expect(res.status, `${JSON.stringify([ownCode, parentCode])} ${JSON.stringify(res.body)}`).toBe(422)
      expect(refusal(res)).toEqual([PARENT_INVALID, 'self_parent'])
    }
    expect(recordsOf(S.PREG)).toEqual([])
    expectNoTransaction()
    // a different case is a different 图号; a row without its own 图号 can take any parent
    expect((await createRow(S.PREG, minimal(S.PREG, { [own]: 'SYN-1', ...parent(S.PREG, 'syn-1', null) }))).status).toBe(200)
    expect((await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, 'SYN-1', null)))).status).toBe(200)
  })

  describe('CP-08 P7 — the per-subject field gate covers BOTH columns, whichever half was sent', () => {
    it('父组件名称 read-only for the actor: the pair → 403 naming it; the 图号 alone → 403 too (not the 400 of a half pair), naming nothing the caller did not send', async () => {
      deny(S.PREG, 'parentComponentName', { readOnly: true })
      const both = await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, 'SYN-PARENT', 'Synthetic parent')))
      expect(both.status, JSON.stringify(both.body)).toBe(403)
      expect(both.body.error.message).toBe(`Field(s) not writable for this user: ${pairOf(S.PREG).name}`)
      const half = await createRow(S.PREG, minimal(S.PREG, { [pairOf(S.PREG).code]: 'SYN-PARENT' }))
      expect(half.status, JSON.stringify(half.body)).toBe(403)
      expect(half.body.error.message).toBe('Field(s) not writable for this user')
      expect(JSON.stringify(half.body)).not.toContain(pairOf(S.PREG).name)
      expect(recordsOf(S.PREG)).toEqual([])
      // the six are untouched by that rule
      expect((await createRow(S.PREG, minimal(S.PREG))).status).toBe(200)
    })
    it('父组件图号 hidden for the actor: 403, nothing written', async () => {
      deny(S.PREG, 'parentComponentCode', { visible: false })
      const res = await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, 'SYN-PARENT', 'Synthetic parent')))
      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(res.body.error.code).toBe('FORBIDDEN')
      expect(recordsOf(S.PREG)).toEqual([])
    })
    it('the 403 comes before the pair\'s own rules: a forbidden column with a malformed pair is still 403', async () => {
      deny(S.PREG, 'parentComponentName', { readOnly: true })
      const res = await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, '', 'Synthetic parent')))
      expect(res.status).toBe(403)
    })
    it('a reader cannot create at all: 403 before any registry read', async () => {
      actor = READER
      const res = await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, 'SYN-PARENT', null)))
      expect(res.status).toBe(403)
      expect(fake.statements(/integration_stock_prep_project_target/)).toEqual([])
    })
  })

  it('CP-09 the pair\'s columns carry no lock: a create that names the pair → 409 lock_missing, nothing written; the same create without the pair → 200, as before', async () => {
    const sheet = S.PAIRUNLOCKED
    for (const body of [parent(sheet, 'SYN-PARENT', 'Synthetic parent'), { [pairOf(sheet).code]: 'SYN-PARENT' }, parent(sheet, null, null)]) {
      const res = await createRow(sheet, minimal(sheet, body))
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(refusal(res)).toEqual([UNAVAILABLE, 'lock_missing'])
    }
    expect(recordsOf(sheet)).toEqual([])
    expect((await createRow(sheet, minimal(sheet))).status).toBe(200)
  })

  it('CP-10 a sheet without one of the two columns: naming the pair → 409 contract_mismatch; a create without it → 200', async () => {
    const sheet = S.NOPARENTNAME
    const res = await createRow(sheet, minimal(sheet, parent(sheet, 'SYN-PARENT', null)))
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusal(res)).toEqual([UNAVAILABLE, 'contract_mismatch'])
    expect((await createRow(sheet, minimal(sheet, { [ph(sheet, 'parentComponentCode')]: 'SYN-PARENT' }))).status).toBe(409)
    expect(recordsOf(sheet)).toEqual([])
    expect((await createRow(sheet, minimal(sheet))).status).toBe(200)
  })

  it('CP-11 the pair\'s lock is re-checked INSIDE the create transaction: lifted between the route\'s check and the transaction → 409 lock_missing, nothing written', async () => {
    fake.setOnTransactionFieldRead((sheet) => {
      delete sheet.fields.find((f) => f.id === pairOf(sheet).name)!.property.humanWriteLock
    })
    const res = await createRow(S.PREG, minimal(S.PREG, parent(S.PREG, 'SYN-PARENT', 'Synthetic parent')))
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusal(res)).toEqual([UNAVAILABLE, 'lock_missing'])
    expect(recordsOf(S.PREG)).toEqual([])
  })

  it.each([
    ['DISABLED', 'STOCK_PREP_MANUAL_ROWS_DISABLED', 'disabled'],
    ['ARCHIVED', UNAVAILABLE, 'project_archived'],
  ])('CP-12 rule P8 — %s stops a create with a parent like any create (%s / %s)', async (key, code, reason) => {
    const res = await createRow(S[key], minimal(S[key], parent(S[key], 'SYN-PARENT', null)))
    expect(res.status).toBe(409)
    expect(refusal(res)).toEqual([code, reason])
    expect(recordsOf(S[key])).toEqual([])
  })

  describe('CP-13 the exemption lives in the manual-row branch of RecordService.createRecord and nowhere else', () => {
    const fullCaps = { canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true, canSendNotification: false, canSubmitApproval: false }
    const service = () => new RecordService(fake.pool as never, new EventBus())
    const mintFor = async (sheet: FakeSheet) => {
      const verdict = await loadManualRowsVerdict(fake.pool.query as never, sheet.sheetId, sheet.fields, 'create', true)
      if (verdict.kind !== 'allowed') throw new Error(`fixture not allowed: ${verdict.kind}`)
      return mintManualRowCreateExtension(verdict.sheet, 'create')
    }
    it('with a minted extension the branch itself holds the pair to P3 / P4 / P5 — a caller that skipped the route\'s check stores nothing', async () => {
      const manualRowExtension = await mintFor(S.PREG)
      const own = ph(S.PREG, 'componentCode')
      for (const [data, reason] of [
        [minimal(S.PREG, { [pairOf(S.PREG).code]: 'SYN-PARENT' }), 'pair_incomplete'],
        [minimal(S.PREG, parent(S.PREG, 9, null)), 'not_text'],
        [minimal(S.PREG, parent(S.PREG, null, 'Synthetic parent')), 'name_without_code'],
        [minimal(S.PREG, { [own]: 'SYN-1', ...parent(S.PREG, 'SYN-1', null) }), 'self_parent'],
      ] as const) {
        await expect(service().createRecord({ sheetId: S.PREG.sheetId, data, actorId: WRITER.id, capabilities: fullCaps, manualRow: manualRowExtension }))
          .rejects.toMatchObject({ name: 'StockPrepManualRowParentRefusedError', reason })
      }
      expect(recordsOf(S.PREG)).toEqual([])
      const ok = await service().createRecord({ sheetId: S.PREG.sheetId, data: minimal(S.PREG, parent(S.PREG, 'SYN-PARENT', 'Synthetic parent')), actorId: WRITER.id, capabilities: fullCaps, manualRow: manualRowExtension })
      expect(cell(fake.records.get(ok.recordId), S.PREG, 'parentComponentCode')).toBe('SYN-PARENT')
    })
    it('with a minted extension on a sheet whose pair lost its lock: the transaction refuses (lock_missing)', async () => {
      const manualRowExtension = await mintFor(S.PAIRUNLOCKED)
      await expect(service().createRecord({ sheetId: S.PAIRUNLOCKED.sheetId, data: minimal(S.PAIRUNLOCKED, parent(S.PAIRUNLOCKED, 'SYN-PARENT', null)), actorId: WRITER.id, capabilities: fullCaps, manualRow: manualRowExtension }))
        .rejects.toMatchObject({ name: 'StockPrepManualRowsRefusedError', reason: 'lock_missing' })
      expect(recordsOf(S.PAIRUNLOCKED)).toEqual([])
    })
    it('WITHOUT the extension the pair is a locked PLM column like any other: 403 FIELD_READONLY_PLM_SYSTEM naming it', async () => {
      // On this sheet the six are not locked, so the generic create reaches the pair itself.
      const sheet = S.PAIRLOCKEDONLY
      await expect(service().createRecord({ sheetId: sheet.sheetId, data: { [ph(sheet, 'componentName')]: 'SYN', ...parent(sheet, 'SYN-PARENT', 'Synthetic parent') }, actorId: WRITER.id, capabilities: fullCaps }))
        .rejects.toMatchObject({ name: 'RecordFieldForbiddenError', code: 'FIELD_READONLY_PLM_SYSTEM', fieldId: pairOf(sheet).code })
      expect(recordsOf(sheet)).toEqual([])
    })
  })

  it('CP-14 the generic POST /records on the same sheet is refused whatever it carries — the pair included (rule P2)', async () => {
    const res = await http().post('/api/multitable/records').send({ sheetId: S.PREG.sheetId, data: parent(S.PREG, 'SYN-PARENT', 'Synthetic parent') })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW')
    expect(recordsOf(S.PREG)).toEqual([])
  })

  it('CP-15 session requests only', async () => {
    const res = await http().post(`/api/multitable/sheets/${S.PREG.sheetId}/manual-rows`).set(TOKEN).send({ data: minimal(S.PREG, parent(S.PREG, 'SYN-PARENT', null)) })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('SESSION_REQUIRED')
  })
})

// ── YP. 复制为新行 and the pair ───────────────────────────────────────────────────────────────────────

describe('YP — 复制为新行: the parent pair is carried whole or not at all (OQ-P1)', () => {
  const SOURCE = { componentCode: 'SYN-CHILD', componentName: 'Synthetic part', totalQuantity: 4, material: 'SYN-MATERIAL' }
  const copyOf = async (sourceId: string) => {
    const res = await copyRow(sourceId)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return { res, copy: fake.records.get(res.body.data.record.id as string)! }
  }
  const expectCarried = (copy: FakeRecord, sheet: FakeSheet, code: unknown, name: unknown) => {
    expect(cell(copy, sheet, 'parentComponentCode')).toBe(code)
    expect(cell(copy, sheet, 'parentComponentName')).toBe(name)
  }
  const expectNeither = (copy: FakeRecord, sheet: FakeSheet) => {
    expect(has(copy, sheet, 'parentComponentCode'), 'parentComponentCode').toBe(false)
    expect(has(copy, sheet, 'parentComponentName'), 'parentComponentName').toBe(false)
    // …and the copy is otherwise the copy it always was
    expect(cell(copy, sheet, 'material')).toBe('SYN-MATERIAL')
    expect(cell(copy, sheet, 'idempotencyKey')).toBe(`manual:v1:${copy.id}`)
  }

  it('YP-01 a PLM row and a manual row: both columns carried, exactly as the source stores them; the source untouched', async () => {
    const plm = plmRow(S.PREG, 'rec_mrp1_copy_plm', { ...SOURCE, parentComponentCode: ' SYN-PARENT', parentComponentName: 'Synthetic parent and spec' })
    const before = structuredClone(plm)
    const fromPlm = await copyOf(plm.id)
    expectCarried(fromPlm.copy, S.PREG, ' SYN-PARENT', 'Synthetic parent and spec')
    expect(fake.records.get(plm.id)).toEqual(before)
    const manual = manualRow(S.PREG, 'rec_mrp1_copy_manual', { ...SOURCE, parentComponentCode: 'SYN-NEW-PARENT', parentComponentName: 'Hand typed' })
    const fromManual = await copyOf(manual.id)
    expectCarried(fromManual.copy, S.PREG, 'SYN-NEW-PARENT', 'Hand typed')
    expect(cell(fromManual.copy, S.PREG, 'idempotencyKey')).toBe(`manual:v1:${fromManual.copy.id}`)
  })

  it('YP-02 a parent without a name: the 图号 is carried and the name cell is null (the pair still goes together)', async () => {
    const source = plmRow(S.PREG, 'rec_mrp1_copy_noname', { ...SOURCE, parentComponentCode: 'SYN-PARENT' })
    const { copy } = await copyOf(source.id)
    expectCarried(copy, S.PREG, 'SYN-PARENT', null)
  })

  it.each([
    ['no parent at all', {}],
    ['a name without a 图号 (a PLM child whose parent has no drawing number)', { parentComponentName: 'Synthetic parent' }],
    ['a name with a blank 图号', { parentComponentCode: '  ', parentComponentName: 'Synthetic parent' }],
    ['a 图号 that is not text', { parentComponentCode: 42, parentComponentName: 'Synthetic parent' }],
    ['a name that is not text', { parentComponentCode: 'SYN-PARENT', parentComponentName: 7 }],
    ['the source is its own parent, so the copy would be too (P5 against the new row)', { parentComponentCode: 'SYN-CHILD', parentComponentName: 'Synthetic parent' }],
    ['…also when only whitespace differs', { parentComponentCode: ' SYN-CHILD ', parentComponentName: null }],
  ])('YP-03 %s: NEITHER column is carried, the copy still succeeds', async (_label, cells) => {
    const source = plmRow(S.PREG, 'rec_mrp1_copy_half', { ...SOURCE, ...cells })
    const { copy } = await copyOf(source.id)
    expectNeither(copy, S.PREG)
  })

  it.each([
    ['父组件图号 not readable', 'parentComponentCode', { visible: false }],
    ['父组件名称 not readable', 'parentComponentName', { visible: false }],
    ['父组件图号 not writable', 'parentComponentCode', { readOnly: true }],
    ['父组件名称 not writable', 'parentComponentName', { readOnly: true }],
  ])('YP-04 the actor\'s per-subject rule covers ONE column (%s): NEITHER column is carried, the copy still succeeds', async (_label, logical, rule) => {
    const source = plmRow(S.PREG, 'rec_mrp1_copy_perm', { ...SOURCE, parentComponentCode: 'SYN-PARENT', parentComponentName: 'Synthetic parent' })
    deny(S.PREG, logical, rule)
    const { res, copy } = await copyOf(source.id)
    expectNeither(copy, S.PREG)
    // the echo carries no pair value either
    expect(pairOf(S.PREG).code in res.body.data.record.data).toBe(false)
    expect(pairOf(S.PREG).name in res.body.data.record.data).toBe(false)
  })

  it('YP-05 the copy cannot carry its own 图号 (the actor may not write it): no self-parent is possible, so the pair IS carried', async () => {
    const source = plmRow(S.PREG, 'rec_mrp1_copy_nocode', { ...SOURCE, parentComponentCode: 'SYN-CHILD', parentComponentName: 'Synthetic parent' })
    deny(S.PREG, 'componentCode', { readOnly: true })
    const { copy } = await copyOf(source.id)
    expect(has(copy, S.PREG, 'componentCode')).toBe(false)
    expectCarried(copy, S.PREG, 'SYN-CHILD', 'Synthetic parent')
  })

  it.each(['PAIRUNLOCKED', 'NOPARENTNAME'])('YP-06 %s: the routes do not write the pair on this sheet — neither column is carried, the copy still succeeds', async (key) => {
    const sheet = S[key]
    const cells: Record<string, unknown> = { ...SOURCE, parentComponentCode: 'SYN-PARENT' }
    if (key !== 'NOPARENTNAME') cells.parentComponentName = 'Synthetic parent'
    const source = plmRow(sheet, `rec_mrp1_copy_${key}`, cells)
    const { copy } = await copyOf(source.id)
    expectNeither(copy, sheet)
  })
})

// ── EP. 修改 the parent ──────────────────────────────────────────────────────────────────────────────

describe('EP — 修改 the parent: PATCH /records/:recordId/manual-fields', () => {
  it('EP-01 set, change and remove the parent of a manual row: stored as submitted, the version bumps each time, the key stays', async () => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_ok', { componentCode: 'SYN-CHILD' })
    const set = await editRow(row.id, parent(S.PREG, ' SYN-PARENT ', 'Synthetic parent'), { expectedVersion: 1 })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    expect(set.body.data.updated).toEqual([{ recordId: row.id, version: 2 }])
    let stored = fake.records.get(row.id)!
    expect(cell(stored, S.PREG, 'parentComponentCode')).toBe(' SYN-PARENT ')
    expect(cell(stored, S.PREG, 'parentComponentName')).toBe('Synthetic parent')
    // a parent that exists nowhere on the sheet (新建父组件, rule P6), without a name
    expect((await editRow(row.id, parent(S.PREG, 'SYN-BRAND-NEW', null))).status).toBe(200)
    stored = fake.records.get(row.id)!
    expect(cell(stored, S.PREG, 'parentComponentCode')).toBe('SYN-BRAND-NEW')
    expect(cell(stored, S.PREG, 'parentComponentName')).toBeNull()
    // 移出父组件
    expect((await editRow(row.id, parent(S.PREG, null, null))).status).toBe(200)
    stored = fake.records.get(row.id)!
    expect(cell(stored, S.PREG, 'parentComponentCode')).toBeNull()
    expect(cell(stored, S.PREG, 'parentComponentName')).toBeNull()
    expect(stored.version).toBe(4)
    expect(cell(stored, S.PREG, 'idempotencyKey')).toBe(`manual:v1:${row.id}`)
    expect(cell(stored, S.PREG, 'componentCode')).toBe('SYN-CHILD')
  })

  it('EP-02 the pair together with the six, in one request', async () => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_mixed')
    const res = await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'Renamed', [ph(S.PREG, 'material')]: 'SYN-MATERIAL', ...parent(S.PREG, 'SYN-PARENT', 'Synthetic parent') })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = fake.records.get(row.id)!
    expect(cell(stored, S.PREG, 'componentName')).toBe('Renamed')
    expect(cell(stored, S.PREG, 'material')).toBe('SYN-MATERIAL')
    expect(cell(stored, S.PREG, 'parentComponentCode')).toBe('SYN-PARENT')
    expect(stored.version).toBe(2)
  })

  it.each([
    ['only 父组件图号', 'parentComponentCode', 'SYN-PARENT'],
    ['only 父组件名称', 'parentComponentName', 'Synthetic parent'],
    ['only 父组件名称, cleared', 'parentComponentName', null],
  ])('EP-03 P3 %s: 400 pair_incomplete, nothing written (this is what a single grid cell would send)', async (_label, logical, value) => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_half', { parentComponentCode: 'SYN-OLD', parentComponentName: 'Old parent' })
    const before = structuredClone(row)
    const res = await editRow(row.id, { [ph(S.PREG, logical)]: value })
    expect(res.status, JSON.stringify(res.body)).toBe(400)
    expect(refusal(res)).toEqual([PARENT_INVALID, 'pair_incomplete'])
    expect(fake.records.get(row.id)).toEqual(before)
    expectNoTransaction()
  })

  it('EP-04 P4: a value that is not text → 400 not_text; a name without a 图号 → 422 name_without_code; nothing written', async () => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_p4')
    const before = structuredClone(row)
    for (const [code, name] of [[5, null], ['SYN-PARENT', false], [{ a: 1 }, null]] as const) {
      const res = await editRow(row.id, parent(S.PREG, code, name))
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(refusal(res)).toEqual([PARENT_INVALID, 'not_text'])
    }
    for (const code of [null, '', '   ']) {
      const res = await editRow(row.id, parent(S.PREG, code, 'Synthetic parent'))
      expect(res.status, JSON.stringify(res.body)).toBe(422)
      expect(refusal(res)).toEqual([PARENT_INVALID, 'name_without_code'])
    }
    expect(fake.records.get(row.id)).toEqual(before)
    expectNoTransaction()
  })

  describe('EP-05 P5 — a row is never its own parent, in both directions', () => {
    it('direction 1: changing the parent to the row\'s own 图号 → 422 self_parent, nothing written', async () => {
      const row = manualRow(S.PREG, 'rec_mrp1_edit_self1', { componentCode: 'SYN-1' })
      const before = structuredClone(row)
      for (const code of ['SYN-1', ' SYN-1', 'SYN-1\t ']) {
        const res = await editRow(row.id, parent(S.PREG, code, 'Synthetic parent'))
        expect(res.status, JSON.stringify(res.body)).toBe(422)
        expect(res.body).toEqual({ ok: false, error: { code: PARENT_INVALID, message: '父组件图号不能和这一行自己的图号相同。', details: { reason: 'self_parent' } } })
      }
      expect(fake.records.get(row.id)).toEqual(before)
      // P5 is NOT a pre-check of the route: each of those refusals came out of the write transaction, under the row lock
      expect(fake.pool.transaction).toHaveBeenCalledTimes(3)
      expect(fake.statements(/^SELECT id, data, created_by FROM meta_records WHERE sheet_id = \$1 AND id = \$2 FOR UPDATE$/)).toHaveLength(3)
      expect((await editRow(row.id, parent(S.PREG, 'syn-1', null))).status).toBe(200)
    })
    it('direction 2: changing the row\'s own 图号 to the STORED parent → 422 self_parent, though the request names no parent column', async () => {
      const row = manualRow(S.PREG, 'rec_mrp1_edit_self2', { componentCode: 'SYN-1', parentComponentCode: 'SYN-P', parentComponentName: 'Synthetic parent' })
      const before = structuredClone(row)
      for (const code of ['SYN-P', 'SYN-P ', '\tSYN-P']) {
        const res = await editRow(row.id, { [ph(S.PREG, 'componentCode')]: code })
        expect(res.status, JSON.stringify(res.body)).toBe(422)
        expect(refusal(res)).toEqual([PARENT_INVALID, 'self_parent'])
      }
      expect(fake.records.get(row.id)).toEqual(before)
      expect((await editRow(row.id, { [ph(S.PREG, 'componentCode')]: 'SYN-2' })).status).toBe(200)
    })
    it('one request that moves both: judged on the two NEW values', async () => {
      const row = manualRow(S.PREG, 'rec_mrp1_edit_self3', { componentCode: 'SYN-1', parentComponentCode: 'SYN-P', parentComponentName: null })
      const own = ph(S.PREG, 'componentCode')
      const refused = await editRow(row.id, { [own]: 'SYN-9', ...parent(S.PREG, 'SYN-9', null) })
      expect(refused.status).toBe(422)
      expect(refusal(refused)).toEqual([PARENT_INVALID, 'self_parent'])
      // the new parent is the OLD own 图号, the own 图号 moves away in the same request → fine
      const swapped = await editRow(row.id, { [own]: 'SYN-P', ...parent(S.PREG, 'SYN-1', null) })
      expect(swapped.status, JSON.stringify(swapped.body)).toBe(200)
      const stored = fake.records.get(row.id)!
      expect(cell(stored, S.PREG, 'componentCode')).toBe('SYN-P')
      expect(cell(stored, S.PREG, 'parentComponentCode')).toBe('SYN-1')
    })
    it('decided UNDER THE ROW LOCK, on the row as the lock returns it — not on the route\'s first read (direction 1)', async () => {
      // The route reads the row (own 图号 SYN-1); before this request's transaction locks it, another writer's edit of the
      // 图号 to SYN-P commits. Setting the parent to SYN-P passes any check made on the first read.
      const row = manualRow(S.PREG, 'rec_mrp1_edit_race1', { componentCode: 'SYN-1' })
      fake.setOnRecordLockForUpdate((record) => { record.data[ph(S.PREG, 'componentCode')] = 'SYN-P' })
      const res = await editRow(row.id, parent(S.PREG, 'SYN-P', null))
      expect(res.status, JSON.stringify(res.body)).toBe(422)
      expect(refusal(res)).toEqual([PARENT_INVALID, 'self_parent'])
      const stored = fake.records.get(row.id)!
      expect(has(stored, S.PREG, 'parentComponentCode')).toBe(false)
      expect(stored.version).toBe(1)
    })
    it('…and the mirror race (direction 2): the parent is committed by another writer while this request changes the 图号', async () => {
      const row = manualRow(S.PREG, 'rec_mrp1_edit_race2', { componentCode: 'SYN-1' })
      fake.setOnRecordLockForUpdate((record) => { record.data[pairOf(S.PREG).code] = 'SYN-7' })
      const res = await editRow(row.id, { [ph(S.PREG, 'componentCode')]: 'SYN-7' })
      expect(res.status, JSON.stringify(res.body)).toBe(422)
      expect(refusal(res)).toEqual([PARENT_INVALID, 'self_parent'])
      expect(cell(fake.records.get(row.id), S.PREG, 'componentCode')).toBe('SYN-1')
    })
    it('an edit that names neither 父组件图号 nor the 图号 is not judged: a row already in that state can still be edited elsewhere', async () => {
      const row = manualRow(S.PREG, 'rec_mrp1_edit_legacy', { componentCode: 'SYN-1', parentComponentCode: 'SYN-1', parentComponentName: 'Synthetic parent' })
      expect((await editRow(row.id, { [ph(S.PREG, 'material')]: 'SYN-MATERIAL' })).status).toBe(200)
      // …and it can be repaired through this route
      expect((await editRow(row.id, parent(S.PREG, null, null))).status).toBe(200)
    })
  })

  it.each([
    ['a PLM row', (sheet: FakeSheet) => plmRow(sheet, 'rec_mrp1_edit_plm', { componentCode: 'SYN-1', parentComponentCode: 'SYN-OLD', parentComponentName: 'Old parent' })],
    ['a prefix row whose key names another row', (sheet: FakeSheet) => fake.addRecord(sheet, 'rec_mrp1_edit_unbound', { idempotencyKey: 'manual:v1:rec_someone_else', componentName: 'SYN', parentComponentCode: 'SYN-OLD', parentComponentName: 'Old parent' }, WRITER.id)],
    ['the own key without a creator', (sheet: FakeSheet) => manualRow(sheet, 'rec_mrp1_edit_nocreator', { parentComponentCode: 'SYN-OLD', parentComponentName: 'Old parent' }, null)],
  ])('EP-06 %s: its parent cannot be changed here — 409 not_manual_row, the row untouched', async (_label, seed) => {
    const row = seed(S.PREG)
    const before = structuredClone(row)
    const res = await editRow(row.id, parent(S.PREG, 'SYN-PARENT', 'Synthetic parent'))
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusal(res)).toEqual(['STOCK_PREP_MANUAL_ROW_REQUIRED', 'not_manual_row'])
    expect(fake.records.get(row.id)).toEqual(before)
  })

  it('EP-07 rule P2 — /patch and PATCH /records still refuse the pair on the SAME manual row: 403 FIELD_READONLY_PLM_SYSTEM, nothing written', async () => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_generic', { parentComponentCode: 'SYN-OLD', parentComponentName: 'Old parent' })
    const before = structuredClone(row)
    const { code, name } = pairOf(S.PREG)
    for (const fieldId of [code, name]) {
      const bulk = await http().post('/api/multitable/patch').send({ sheetId: S.PREG.sheetId, changes: [{ recordId: row.id, fieldId, value: 'SYN-FORGED' }] })
      expect(bulk.status, fieldId).toBe(403)
      expect(bulk.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
      const single = await http().patch(`/api/multitable/records/${row.id}`).send({ sheetId: S.PREG.sheetId, data: { [fieldId]: 'SYN-FORGED' } })
      expect(single.status, fieldId).toBe(403)
      expect(single.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
    }
    const both = await http().post('/api/multitable/patch').send({ sheetId: S.PREG.sheetId, changes: [{ recordId: row.id, fieldId: code, value: 'SYN-FORGED' }, { recordId: row.id, fieldId: name, value: 'Forged' }] })
    expect(both.status).toBe(403)
    expect(fake.records.get(row.id)).toEqual(before)
  })

  describe('EP-08 P7 — the per-subject field gate covers BOTH columns', () => {
    it('one column read-only for the actor: the pair → 403; that leaves the six editable', async () => {
      const row = manualRow(S.PREG, 'rec_mrp1_edit_perm')
      deny(S.PREG, 'parentComponentCode', { readOnly: true })
      const res = await editRow(row.id, parent(S.PREG, 'SYN-PARENT', 'Synthetic parent'))
      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(res.body.error.message).toBe(`Field(s) not writable for this user: ${pairOf(S.PREG).code}`)
      expect(has(fake.records.get(row.id), S.PREG, 'parentComponentCode')).toBe(false)
      expect((await editRow(row.id, { [ph(S.PREG, 'material')]: 'SYN' })).status).toBe(200)
    })
    it('the half the actor MAY write, sent alone: still 403 (not the 400 of a half pair), and the other column\'s id is not echoed', async () => {
      const row = manualRow(S.PREG, 'rec_mrp1_edit_perm_half')
      deny(S.PREG, 'parentComponentName', { visible: false })
      const res = await editRow(row.id, { [pairOf(S.PREG).code]: 'SYN-PARENT' })
      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(res.body.error.message).toBe('Field(s) not writable for this user')
      expect(JSON.stringify(res.body)).not.toContain(pairOf(S.PREG).name)
    })
    it('a reader is refused 403', async () => {
      const row = manualRow(S.PREG, 'rec_mrp1_edit_reader')
      actor = READER
      expect((await editRow(row.id, parent(S.PREG, 'SYN-PARENT', null))).status).toBe(403)
    })
  })

  it.each([
    ['ARCHIVED', 'an archived project'],
    ['DISABLED', 'the switch off'],
  ])('EP-09 rule P8 — %s (%s) does not stop changing an existing manual row\'s parent', async (key) => {
    const row = manualRow(S[key], `rec_mrp1_edit_${key}`)
    const res = await editRow(row.id, parent(S[key], 'SYN-PARENT', 'Synthetic parent'))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(cell(fake.records.get(row.id), S[key], 'parentComponentCode')).toBe('SYN-PARENT')
  })

  it('EP-10 rule P8 — the deployment switch off does not stop it either', async () => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_flagoff')
    delete process.env[MR_SWITCH]
    expect((await editRow(row.id, parent(S.PREG, 'SYN-PARENT', null))).status).toBe(200)
  })

  it('EP-11 the pair\'s columns carry no lock: an edit that names the pair → 409 lock_missing; an edit of the six on the same row → 200, as before', async () => {
    const sheet = S.PAIRUNLOCKED
    const row = manualRow(sheet, 'rec_mrp1_edit_unlocked')
    const before = structuredClone(row)
    for (const body of [parent(sheet, 'SYN-PARENT', null), { [pairOf(sheet).name]: 'Synthetic parent' }]) {
      const res = await editRow(row.id, body)
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(refusal(res)).toEqual([UNAVAILABLE, 'lock_missing'])
    }
    expect(fake.records.get(row.id)).toEqual(before)
    expect((await editRow(row.id, { [ph(sheet, 'componentName')]: 'Renamed' })).status).toBe(200)
  })

  it('EP-12 a sheet without one of the two columns: naming the pair → 409 contract_mismatch', async () => {
    const sheet = S.NOPARENTNAME
    const row = manualRow(sheet, 'rec_mrp1_edit_nocolumn')
    const res = await editRow(row.id, parent(sheet, 'SYN-PARENT', null))
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusal(res)).toEqual([UNAVAILABLE, 'contract_mismatch'])
  })

  it('EP-13 the pair\'s lock is re-checked INSIDE the write transaction: lifted in between → 409 lock_missing, nothing written', async () => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_txlock')
    fake.setOnTransactionFieldRead((sheet) => {
      delete sheet.fields.find((f) => f.id === pairOf(sheet).code)!.property.humanWriteLock
    })
    const res = await editRow(row.id, parent(S.PREG, 'SYN-PARENT', null))
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusal(res)).toEqual([UNAVAILABLE, 'lock_missing'])
    expect(has(fake.records.get(row.id), S.PREG, 'parentComponentCode')).toBe(false)
  })

  it('EP-14 M is re-checked in the transaction for a parent edit too: the key changed in between → 409 not_manual_row', async () => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_txm')
    fake.setOnRecordLockForUpdate((record) => { record.data[ph(S.PREG, 'idempotencyKey')] = 'manual:v1:rec_someone_else' })
    const res = await editRow(row.id, parent(S.PREG, 'SYN-PARENT', null))
    expect(res.status).toBe(409)
    expect(refusal(res)).toEqual(['STOCK_PREP_MANUAL_ROW_REQUIRED', 'not_manual_row'])
    expect(has(fake.records.get(row.id), S.PREG, 'parentComponentCode')).toBe(false)
  })

  it('EP-15 a version conflict answers 409 VERSION_CONFLICT, nothing written; session requests only', async () => {
    const row = manualRow(S.PREG, 'rec_mrp1_edit_version')
    const conflict = await editRow(row.id, parent(S.PREG, 'SYN-PARENT', null), { expectedVersion: 7 })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe('VERSION_CONFLICT')
    expect(fake.records.get(row.id)!.version).toBe(1)
    const token = await http().patch(`/api/multitable/records/${row.id}/manual-fields`).set(TOKEN).send({ data: parent(S.PREG, 'SYN-PARENT', null) })
    expect(token.status).toBe(401)
  })
})

// ── XP. /context ─────────────────────────────────────────────────────────────────────────────────────

describe('XP — GET /context: stockPreparationManualRows.parentFieldIds', () => {
  const blockOf = async (sheet: FakeSheet) => {
    const res = await context(sheet)
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    return res.body.data.capabilities.stockPreparationManualRows as Record<string, unknown> | undefined
  }
  const SIX = (sheet: FakeSheet) => ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity'].map((l) => ph(sheet, l))

  it.each([
    ['a writer', WRITER],
    ['a platform admin', ADMIN],
  ])('XP-01 %s on a P_reg sheet: both ids, and editableFieldIds is still exactly the six', async (_label, who) => {
    actor = who
    const block = (await blockOf(S.PREG))!
    expect(block.parentFieldIds).toEqual(pairOf(S.PREG))
    expect(block.editableFieldIds).toEqual(SIX(S.PREG))
  })

  it.each([
    ['父组件名称 read-only for the actor', 'parentComponentName', { readOnly: true }],
    ['父组件图号 read-only for the actor', 'parentComponentCode', { readOnly: true }],
    ['父组件名称 hidden for the actor', 'parentComponentName', { visible: false }],
    ['父组件图号 hidden for the actor', 'parentComponentCode', { visible: false }],
  ])('XP-02 rule P7 — %s: the block is sent WITHOUT parentFieldIds (and is otherwise unchanged)', async (_label, logical, rule) => {
    const unrestricted = (await blockOf(S.PREG))!
    deny(S.PREG, logical, rule)
    const block = (await blockOf(S.PREG))!
    expect('parentFieldIds' in block).toBe(false)
    expect(block).toEqual({ state: unrestricted.state, editableFieldIds: unrestricted.editableFieldIds, requiredFieldIds: unrestricted.requiredFieldIds, dialogFieldIds: unrestricted.dialogFieldIds })
  })

  it('XP-03 the rule is per subject: another user\'s restriction does not hide the pair from this actor', async () => {
    deny(S.PREG, 'parentComponentName', { readOnly: true }, 'u_mrp1_someone_else')
    expect((await blockOf(S.PREG))!.parentFieldIds).toEqual(pairOf(S.PREG))
  })

  it.each([
    ['PAIRUNLOCKED', 'allowed'],
    ['NOPARENTNAME', 'allowed'],
    ['NOLOCK', 'unavailable'],
  ])('XP-04 %s: the routes do not accept the pair there — no parentFieldIds (state %s)', async (key, state) => {
    const block = (await blockOf(S[key]))!
    expect(block.state).toBe(state)
    expect('parentFieldIds' in block).toBe(false)
  })

  it.each([
    ['DISABLED', { state: 'disabled' }],
    ['ARCHIVED', { state: 'unavailable', reason: 'project_archived' }],
  ])('XP-05 rule P8 — %s: no create, yet the parent of an existing manual row can be changed, so the ids ARE sent', async (key, expected) => {
    const block = (await blockOf(S[key]))!
    expect(block).toMatchObject(expected)
    expect(block.parentFieldIds).toEqual(pairOf(S[key]))
  })

  it('XP-06 rule P8 — the deployment switch off: unavailable / project_sheets_off, the ids still sent', async () => {
    delete process.env[MR_SWITCH]
    const block = (await blockOf(S.PREG))!
    expect(block).toMatchObject({ state: 'unavailable', reason: 'project_sheets_off' })
    expect(block.parentFieldIds).toEqual(pairOf(S.PREG))
  })

  it('XP-07 a registry that cannot be read: the fail-closed block, no ids', async () => {
    fake.failures.target = { code: '42501', message: 'synthetic: permission denied' }
    expect(await blockOf(S.PREG)).toEqual({ state: 'unavailable', reason: 'registry_unreadable', editableFieldIds: [], requiredFieldIds: [], dialogFieldIds: [] })
  })

  it('XP-08 a reader gets no block; an ordinary sheet and the env table get none — and the pair costs no statement of its own', async () => {
    actor = READER
    expect(await blockOf(S.PREG)).toBeUndefined()
    actor = WRITER
    expect(await blockOf(S.PLAIN)).toBeUndefined()
    expect(await blockOf(S.ENV)).toBeUndefined()
    fake.sqlLog.length = 0
    await blockOf(S.PREG)
    // one plugin registry read for the whole block, as before the pair existed
    expect(fake.statements(/integration_stock_prep_project_target/)).toHaveLength(1)
  })
})

// ── O. the parent picker's candidates ────────────────────────────────────────────────────────────────

describe('O — GET /sheets/:sheetId/manual-rows/parent-options', () => {
  const statement = () => fake.statements(/^WITH picked AS MATERIALIZED/)
  type Seeded = Record<'asm' | 'part1' | 'part2' | 'manual1' | 'nocode' | 'inactive' | 'spaced', FakeRecord>
  const seed = (sheet: FakeSheet): Seeded => ({
    asm: plmRow(sheet, 'rec_mrp1_o_asm', { componentCode: 'ASM-1', componentName: 'Assembly' }),
    part1: plmRow(sheet, 'rec_mrp1_o_part1', { componentCode: 'PRT-1', componentName: 'Part one', parentComponentCode: 'ASM-1', parentComponentName: 'Assembly and spec' }),
    part2: plmRow(sheet, 'rec_mrp1_o_part2', { componentCode: 'PRT-2', componentName: 'Part two', parentComponentCode: 'ASM-1', parentComponentName: 'Assembly and spec' }),
    manual1: manualRow(sheet, 'rec_mrp1_o_manual1', { componentCode: 'MAN-1', componentName: 'Manual one', parentComponentCode: 'PRT-1', parentComponentName: 'Part one' }),
    nocode: manualRow(sheet, 'rec_mrp1_o_nocode', { componentName: 'No drawing number' }),
    inactive: plmRow(sheet, 'rec_mrp1_o_inactive', { componentCode: 'OLD-1', componentName: 'Old part', active: false }),
    spaced: plmRow(sheet, 'rec_mrp1_o_spaced', { componentCode: ' SP-1 ', componentName: 'Spaced' }),
  })
  const ALL = [
    { code: 'ASM-1', name: 'Assembly and spec', kind: 'parent', childCount: 2 },
    { code: 'PRT-1', name: 'Part one', kind: 'parent', childCount: 1 },
    { code: ' SP-1 ', name: 'Spaced', kind: 'component' },
    { code: 'MAN-1', name: 'Manual one', kind: 'component' },
    { code: 'PRT-2', name: 'Part two', kind: 'component' },
  ]

  it('O-01 the candidates: existing parents first (with child counts), then the sheet\'s own parts; a part that is already a parent is listed once, under the parent\'s name; blank and inactive rows out; values as stored', async () => {
    seed(S.PREG)
    const res = await options(S.PREG)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { items: ALL, truncated: false } })
  })

  it('O-02 session requests only: an mst_ bearer is refused 401 before any read', async () => {
    seed(S.PREG)
    fake.sqlLog.length = 0
    const res = await options(S.PREG, {}, TOKEN)
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('SESSION_REQUIRED')
    expect(fake.sqlLog).toEqual([])
  })

  it('O-03 a reader (canRead, neither create nor edit) is refused 403 and no row is read on their behalf', async () => {
    seed(S.PREG)
    actor = READER
    const res = await options(S.PREG)
    expect(res.status).toBe(403)
    expect(statement()).toEqual([])
    expect(fake.statements(/integration_stock_prep_project_target/)).toEqual([])
  })

  it.each([
    ['ENV', 409, 'not_project_sheet'],
    ['PLAIN', 409, 'not_project_sheet'],
    ['NOLOCK', 409, 'lock_missing'],
    ['PAIRUNLOCKED', 409, 'lock_missing'],
    ['NOPARENTNAME', 409, 'contract_mismatch'],
  ])('O-04 %s: %s %s, nothing listed', async (key, status, reason) => {
    plmRow(S[key], `rec_mrp1_o_gate_${key}`, { componentCode: 'ASM-1', componentName: 'Assembly' })
    const res = await options(S[key])
    expect(res.status, JSON.stringify(res.body)).toBe(status)
    expect(refusal(res)).toEqual([UNAVAILABLE, reason])
    expect(statement()).toEqual([])
  })

  it('O-05 a registry that cannot be read: 503 registry_unreadable; an absent sheet: 404', async () => {
    seed(S.PREG)
    fake.failures.target = { code: '42501', message: 'synthetic: permission denied' }
    const unreadable = await options(S.PREG)
    expect(unreadable.status).toBe(503)
    expect(refusal(unreadable)).toEqual([UNAVAILABLE, 'registry_unreadable'])
    fake.failures.target = null
    const absent = await http().get('/api/multitable/sheets/sheet_mrp1_absent/manual-rows/parent-options')
    expect(absent.status).toBe(404)
    expect(statement()).toEqual([])
  })

  it.each(['DISABLED', 'ARCHIVED'])('O-06 rule P8 — %s still answers (the picker serves 「修改父组件」 there)', async (key) => {
    seed(S[key])
    const res = await options(S[key])
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.items).toEqual(ALL)
  })

  it('O-06b rule P8 — the deployment switch off still answers', async () => {
    seed(S.PREG)
    delete process.env[MR_SWITCH]
    expect((await options(S.PREG)).status).toBe(200)
  })

  it('O-07 q: a case-insensitive substring of an entry\'s 图号 or 名称; the search text travels lower-cased as a parameter', async () => {
    seed(S.PREG)
    const byName = await options(S.PREG, { q: ' PART ' })
    expect(byName.body.data.items.map((item: { code: string }) => item.code)).toEqual(['PRT-1', 'PRT-2'])
    expect(statement().at(-1)!.params[8]).toBe('part')
    const byCode = await options(S.PREG, { q: 'asm' })
    expect(byCode.body.data.items).toEqual([ALL[0]])
    // a part listed under its parent entry is found by the ENTRY's text
    expect((await options(S.PREG, { q: 'and spec' })).body.data.items).toEqual([ALL[0]])
    expect((await options(S.PREG, { q: 'no such text' })).body.data).toEqual({ items: [], truncated: false })
    // SQL wildcards are plain characters
    expect((await options(S.PREG, { q: '%' })).body.data.items).toEqual([])
    expect((await options(S.PREG, { q: '_' })).body.data.items).toEqual([])
  })

  it('O-08 limit: default 20, 1 – 50, `truncated` when more entries exist; the statement is asked for limit + 1', async () => {
    seed(S.PREG)
    const two = await options(S.PREG, { limit: '2' })
    expect(two.body.data).toEqual({ items: ALL.slice(0, 2), truncated: true })
    expect(statement().at(-1)!.params[9]).toBe(3)
    const five = await options(S.PREG, { limit: '5' })
    expect(five.body.data).toEqual({ items: ALL, truncated: false })
    await options(S.PREG)
    expect(statement().at(-1)!.params[9]).toBe(21)
    await options(S.PREG, { limit: '500' })
    expect(statement().at(-1)!.params[9]).toBe(51)
    await options(S.PREG, { limit: 'abc' })
    expect(statement().at(-1)!.params[9]).toBe(21)
    const tooLong = await options(S.PREG, { q: 'x'.repeat(201) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('O-09 the statement is the fixed one, and every column id, the trim set and the deny list are parameters', async () => {
    seed(S.PREG)
    await options(S.PREG, { q: 'x' })
    const { params } = statement().at(-1)!
    expect(params).toEqual([
      S.PREG.sheetId,
      ph(S.PREG, 'componentCode'), ph(S.PREG, 'componentName'), ph(S.PREG, 'parentComponentCode'), ph(S.PREG, 'parentComponentName'),
      ph(S.PREG, 'active'),
      [],
      MANUAL_ROW_PARENT_SQL_TRIM_CHARS,
      'x',
      21,
    ])
    expect(statement()).toHaveLength(1)
  })

  describe('O-10 columns outside the actor\'s read set are not projected, not matched and not counted', () => {
    it('父组件名称 hidden: its id travels as NULL, the parent entries have no name, and `q` cannot find a text that only that column holds', async () => {
      seed(S.PREG)
      deny(S.PREG, 'parentComponentName', { visible: false })
      const res = await options(S.PREG)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(statement().at(-1)!.params[4]).toBeNull()
      expect(res.body.data.items.slice(0, 2)).toEqual([
        { code: 'ASM-1', name: null, kind: 'parent', childCount: 2 },
        { code: 'PRT-1', name: null, kind: 'parent', childCount: 1 },
      ])
      // 'and spec' exists ONLY in the hidden column — it must match nothing (a hit would be an oracle for the column)
      const probe = await options(S.PREG, { q: 'and spec' })
      expect(probe.body.data).toEqual({ items: [], truncated: false })
      expect(JSON.stringify((await options(S.PREG, { limit: '50' })).body)).not.toContain('Assembly and spec')
    })
    it('父组件图号 hidden: no 「已有父组件」 entry at all — every part is listed as a plain component, no child count leaks', async () => {
      seed(S.PREG)
      deny(S.PREG, 'parentComponentCode', { visible: false })
      const res = await options(S.PREG, { limit: '50' })
      expect(statement().at(-1)!.params[3]).toBeNull()
      expect(res.body.data.items.every((item: { kind: string }) => item.kind === 'component')).toBe(true)
      expect(res.body.data.items.map((item: { code: string }) => item.code)).toEqual([' SP-1 ', 'ASM-1', 'MAN-1', 'PRT-1', 'PRT-2'])
      expect(JSON.stringify(res.body)).not.toContain('childCount')
    })
    it('图号 hidden: no 「本项目物料」 entry; 名称 hidden: the components carry no name and cannot be searched by it', async () => {
      seed(S.PREG)
      deny(S.PREG, 'componentCode', { visible: false })
      const noCode = await options(S.PREG)
      expect(statement().at(-1)!.params[1]).toBeNull()
      expect(noCode.body.data.items).toEqual(ALL.slice(0, 2))
      fake.fieldPermissions.length = 0
      deny(S.PREG, 'componentName', { visible: false })
      const noName = await options(S.PREG)
      expect(statement().at(-1)!.params[2]).toBeNull()
      expect(noName.body.data.items.filter((item: { kind: string }) => item.kind === 'component')).toEqual([
        { code: ' SP-1 ', name: null, kind: 'component' },
        { code: 'MAN-1', name: null, kind: 'component' },
        { code: 'PRT-2', name: null, kind: 'component' },
      ])
      expect((await options(S.PREG, { q: 'manual one' })).body.data.items).toEqual([])
    })
    it('both 图号 columns hidden: an empty list, and NO statement is issued', async () => {
      seed(S.PREG)
      deny(S.PREG, 'componentCode', { visible: false })
      deny(S.PREG, 'parentComponentCode', { visible: false })
      const res = await options(S.PREG, { q: 'asm' })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual({ items: [], truncated: false })
      expect(statement()).toEqual([])
    })
    it('有效 hidden: the active filter is dropped (its id travels as NULL) instead of filtering on a value the actor may not read', async () => {
      seed(S.PREG)
      deny(S.PREG, 'active', { visible: false })
      const res = await options(S.PREG, { limit: '50' })
      expect(statement().at(-1)!.params[5]).toBeNull()
      expect(res.body.data.items.map((item: { code: string }) => item.code)).toContain('OLD-1')
    })
    it('a read-only column is still readable: nothing changes for the list', async () => {
      seed(S.PREG)
      deny(S.PREG, 'parentComponentName', { readOnly: true })
      expect((await options(S.PREG)).body.data.items).toEqual(ALL)
    })
    it('the response is masked AGAIN with the same read set: an entry the statement should not have returned yields no item', async () => {
      seed(S.PREG)
      deny(S.PREG, 'componentCode', { visible: false })
      // The statement misbehaves: it returns a component although 图号 was passed as NULL.
      fake.overrideParentOptionsRows([
        { code: 'ASM-1', name: 'Assembly and spec', kind: 'parent', child_count: 2 },
        { code: 'LEAK-1', name: 'Leaked part', kind: 'component', child_count: null },
      ])
      const res = await options(S.PREG)
      expect(res.body.data.items).toEqual([{ code: 'ASM-1', name: 'Assembly and spec', kind: 'parent', childCount: 2 }])
      expect(JSON.stringify(res.body)).not.toContain('LEAK-1')
    })
  })

  describe('O-11 rows the row policy denies the actor are not listed and not counted', () => {
    it('the denied row\'s id travels in the deny parameter: its own entry disappears and its parent\'s child count drops', async () => {
      const seeded = seed(S.PREG)
      S.PREG.rowLevelReadDeny = true
      fake.recordDenies.push({ sheetId: S.PREG.sheetId, recordId: seeded.part2.id, userId: WRITER.id })
      const res = await options(S.PREG)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(statement().at(-1)!.params[6]).toEqual([seeded.part2.id])
      expect(res.body.data.items).toEqual([
        { code: 'ASM-1', name: 'Assembly and spec', kind: 'parent', childCount: 1 },
        { code: 'PRT-1', name: 'Part one', kind: 'parent', childCount: 1 },
        { code: ' SP-1 ', name: 'Spaced', kind: 'component' },
        { code: 'MAN-1', name: 'Manual one', kind: 'component' },
      ])
      expect(JSON.stringify(res.body)).not.toContain('PRT-2')
      expect((await options(S.PREG, { q: 'part two' })).body.data.items).toEqual([])
    })
    it('a parent only denied rows carry is not a parent for this actor', async () => {
      const seeded = seed(S.PREG)
      S.PREG.rowLevelReadDeny = true
      fake.recordDenies.push({ sheetId: S.PREG.sheetId, recordId: seeded.part1.id, userId: WRITER.id }, { sheetId: S.PREG.sheetId, recordId: seeded.part2.id, userId: WRITER.id })
      const res = await options(S.PREG)
      // ASM-1 falls back to the component it also is (its own row is readable), with ITS name and no child count
      expect(res.body.data.items).toEqual([
        { code: 'PRT-1', name: 'Part one', kind: 'parent', childCount: 1 },
        { code: ' SP-1 ', name: 'Spaced', kind: 'component' },
        { code: 'ASM-1', name: 'Assembly', kind: 'component' },
        { code: 'MAN-1', name: 'Manual one', kind: 'component' },
      ])
    })
    it('a platform admin bypasses the row policy, another user\'s deny does not apply, and a deny on a sheet whose flag is off is inert', async () => {
      const seeded = seed(S.PREG)
      fake.recordDenies.push({ sheetId: S.PREG.sheetId, recordId: seeded.part2.id, userId: WRITER.id })
      // flag off: read stays grant-additive
      expect((await options(S.PREG)).body.data.items).toEqual(ALL)
      expect(statement().at(-1)!.params[6]).toEqual([])
      S.PREG.rowLevelReadDeny = true
      actor = ADMIN
      expect((await options(S.PREG)).body.data.items).toEqual(ALL)
      expect(statement().at(-1)!.params[6]).toEqual([])
      actor = WRITER
      fake.recordDenies.length = 0
      fake.recordDenies.push({ sheetId: S.PREG.sheetId, recordId: seeded.part2.id, userId: 'u_mrp1_someone_else' })
      expect((await options(S.PREG)).body.data.items).toEqual(ALL)
    })
  })

  it('O-12 the answer never names a record, a field or the sheet — entries are text the actor can already read', async () => {
    const seeded = seed(S.PREG)
    const body = JSON.stringify((await options(S.PREG, { limit: '50' })).body)
    for (const record of Object.values(seeded)) expect(body).not.toContain(record.id)
    expect(body).not.toContain(S.PREG.sheetId)
    expect(body).not.toContain(ph(S.PREG, 'componentCode'))
    expect(body).not.toContain('manual:v1:')
  })
})

// ── D. 被当作父组件的行数 ─────────────────────────────────────────────────────────────────────────────

describe('D — GET /records/:recordId/manual-parent-dependents', () => {
  const statement = () => fake.statements(/^SELECT COUNT\(\*\)::int AS dependents/)
  const seed = (sheet: FakeSheet) => ({
    self: manualRow(sheet, 'rec_mrp1_d_self', { componentCode: 'MAN-P' }),
    child1: manualRow(sheet, 'rec_mrp1_d_child1', { componentCode: 'MAN-C1', parentComponentCode: 'MAN-P', parentComponentName: 'SYN' }),
    child2: manualRow(sheet, 'rec_mrp1_d_child2', { componentCode: 'MAN-C2', parentComponentCode: ' MAN-P ', parentComponentName: null }),
    other: manualRow(sheet, 'rec_mrp1_d_other', { componentCode: 'MAN-C3', parentComponentCode: 'MAN-Q', parentComponentName: null }),
    // a PLM row whose parent has the same 图号 is not this manual row's child
    plmChild: plmRow(sheet, 'rec_mrp1_d_plm', { componentCode: 'PRT-9', parentComponentCode: 'MAN-P', parentComponentName: 'SYN' }),
    // a prefix row without a creator is not a manual row
    noCreator: manualRow(sheet, 'rec_mrp1_d_nocreator', { componentCode: 'MAN-C4', parentComponentCode: 'MAN-P' }, null),
  })

  it('D-01 the count: other manual rows naming this row\'s 图号 as their parent (surrounding whitespace ignored) — a number, nothing else', async () => {
    const seeded = seed(S.PREG)
    const res = await dependents(seeded.self.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toEqual({ ok: true, data: { count: 2 } })
    expect(statement().at(-1)!.params).toEqual([
      S.PREG.sheetId, seeded.self.id, ph(S.PREG, 'parentComponentCode'), 'MAN-P', ph(S.PREG, 'idempotencyKey'), 'manual:v1:', MANUAL_ROW_PARENT_SQL_TRIM_CHARS, [],
    ])
    // a row nobody hangs under
    expect((await dependents(seeded.child1.id)).body.data).toEqual({ count: 0 })
  })

  it('D-02 the row\'s own 图号 is read by the server (trimmed for the comparison); a row without a 图号 has no dependents and costs no statement', async () => {
    const spaced = manualRow(S.PREG, 'rec_mrp1_d_spaced', { componentCode: '  MAN-P ' })
    manualRow(S.PREG, 'rec_mrp1_d_child', { parentComponentCode: 'MAN-P', parentComponentName: null })
    expect((await dependents(spaced.id)).body.data).toEqual({ count: 1 })
    expect(statement().at(-1)!.params[3]).toBe('MAN-P')
    const blank = manualRow(S.PREG, 'rec_mrp1_d_blank', { componentCode: '   ' })
    const none = manualRow(S.PREG, 'rec_mrp1_d_none')
    fake.sqlLog.length = 0
    expect((await dependents(blank.id)).body.data).toEqual({ count: 0 })
    expect((await dependents(none.id)).body.data).toEqual({ count: 0 })
    expect(statement()).toEqual([])
  })

  it('D-03 session requests only; an unknown record is 404', async () => {
    const seeded = seed(S.PREG)
    expect((await dependents(seeded.self.id, TOKEN)).status).toBe(401)
    expect((await dependents('rec_mrp1_d_absent')).status).toBe(404)
  })

  it('D-04 a reader (neither edit nor delete) is refused 403 and nothing is counted', async () => {
    const seeded = seed(S.PREG)
    actor = READER
    expect((await dependents(seeded.self.id)).status).toBe(403)
    expect(statement()).toEqual([])
  })

  it('D-05 a row that is not a manual row: 409 not_manual_row', async () => {
    const seeded = seed(S.PREG)
    for (const id of [seeded.plmChild.id, seeded.noCreator.id]) {
      const res = await dependents(id)
      expect(res.status, id).toBe(409)
      expect(refusal(res)).toEqual(['STOCK_PREP_MANUAL_ROW_REQUIRED', 'not_manual_row'])
    }
    expect(statement()).toEqual([])
  })

  it.each([
    ['ENV', 'not_project_sheet'],
    ['NOLOCK', 'lock_missing'],
  ])('D-06 %s: 409 %s', async (key, reason) => {
    const row = manualRow(S[key], `rec_mrp1_d_gate_${key}`, { componentCode: 'MAN-P' })
    const res = await dependents(row.id)
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(refusal(res)).toEqual([UNAVAILABLE, reason])
  })

  it.each(['DISABLED', 'ARCHIVED', 'PAIRUNLOCKED'])('D-07 %s still answers (the hint serves editing a 图号 and deleting, which work there)', async (key) => {
    const seeded = seed(S[key])
    const res = await dependents(seeded.self.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toEqual({ count: 2 })
  })

  it.each([
    ['父组件图号', 'parentComponentCode'],
    ['图号', 'componentCode'],
  ])('D-08 the actor may not read %s: the count is 0 and no statement is issued (a count over it would be an oracle)', async (_label, logical) => {
    const seeded = seed(S.PREG)
    deny(S.PREG, logical, { visible: false })
    const res = await dependents(seeded.self.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toEqual({ count: 0 })
    expect(statement()).toEqual([])
  })

  it('D-09 the row policy: a child the actor may not read is not counted; the row itself denied → 403', async () => {
    const seeded = seed(S.PREG)
    S.PREG.rowLevelReadDeny = true
    fake.recordDenies.push({ sheetId: S.PREG.sheetId, recordId: seeded.child1.id, userId: WRITER.id })
    const res = await dependents(seeded.self.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toEqual({ count: 1 })
    expect(statement().at(-1)!.params[7]).toEqual([seeded.child1.id])
    actor = ADMIN
    expect((await dependents(seeded.self.id)).body.data).toEqual({ count: 2 })
    actor = WRITER
    fake.recordDenies.push({ sheetId: S.PREG.sheetId, recordId: seeded.self.id, userId: WRITER.id })
    expect((await dependents(seeded.self.id)).status).toBe(403)
  })

  it('D-10 rows on another sheet are never counted', async () => {
    const seeded = seed(S.PREG)
    manualRow(S.DISABLED, 'rec_mrp1_d_foreign', { parentComponentCode: 'MAN-P', parentComponentName: null })
    expect((await dependents(seeded.self.id)).body.data).toEqual({ count: 2 })
  })
})
