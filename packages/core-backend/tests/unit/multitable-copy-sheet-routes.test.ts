/**
 * `POST /api/multitable/sheets/:sheetId/copy` + `/copy/dry-run` (ADR #6094 S1) — the REAL router on the table-aware fake
 * Postgres (tests/utils/copy-sheet-fake-pg.ts), served by usePinnedServer() (tests/unit forbids `request(app)`, #4154).
 * Harness mirrors multitable-template-install-dedupe.test.ts: real express + real routes, `poolManager.get()` stubbed
 * onto the fake, rbac/service mocked so `rbacGuard` reads the session's own permission list.
 *
 *   H1  rbacGuard: no `multitable:write` → 403 before the handler (no sheet query issued).
 *   H2  400s: bad body (missing withData / permissionMode ≠ inherit) and a display-name hygiene refusal — both
 *       BEFORE any capability query (the body is validated first, synchronously).
 *   H3  the copy gate is REAL: a non-admin writer on a sheet whose row-level read switch is ON gets 403
 *       COPY_SOURCE_NOT_FULLY_READABLE from `hasFullTableReadAccess` axis 1; the body carries no count, and ONE
 *       refusal audit row is written outside any transaction (CS-17). Dry-run answers the same 403 before any COUNT.
 *   H4  a soft-deleted source → the shared SHEET_DELETED 404 (after the capability gate), for both routes.
 *   H5  dry-run 200: `data.summary` with counts + disclosures, and NOT ONE write statement.
 *   H6  copy 201: response shape `{ sheet: { id, baseId, name, copiedFrom }, summary, batchId, formulaRecompute? }`;
 *       exactly one `multitable.sheet.copied` bus event, ZERO `multitable.record.created`; the second identical call
 *       replays with `Idempotent-Replayed: true`, a byte-identical body, and no second sheet.
 *   H7  a row failure answers 422 COPY_ROW_VALIDATION_FAILED with `{ rowIndex, fieldId, code }` only — the response
 *       bytes contain no cell value and no missing-link id — and nothing was written.
 *   H8  session only: the two routes are registered without the token-auth / OAPI-scope middleware (source pin, CS-1).
 *   H9  over the row cap: dry-run 200 + `summary.overLimit: true` (records not read), copy 413 COPY_TOO_LARGE (FE-2).
 *   H10 a PG lock SQLSTATE (40P01 / 55P03 / 40001) surfacing from the transaction → 409 CONFLICT, nothing written (TX-2).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DISPLAY_NAME_INVALID_CHARACTERS_CODE } from '../../src/multitable/display-name-hygiene'
import { FakePg } from '../utils/copy-sheet-fake-pg'
import { usePinnedServer } from '../utils/pinned-server'

const BASE = 'base_rt'
const SRC = 'sheet_rt_src'
const DELETED = 'sheet_rt_deleted'
const FOREIGN = 'sheet_rt_foreign'
const ADMIN = 'u_rt_admin'
const WRITER = 'u_rt_writer'
const OUTSIDER = 'u_rt_outsider'
const F = { title: 'fld_rt_title', num: 'fld_rt_num', link: 'fld_rt_link', att: 'fld_rt_att', formula: 'fld_rt_formula' }

function seed(pg: FakePg, opts: { rowLevel?: boolean; brokenLink?: boolean } = {}) {
  pg.seedBase(BASE, ADMIN)
  pg.seedSheet({ id: FOREIGN, baseId: BASE, name: 'Foreign' })
  pg.seedField({ id: 'fld_rt_fname', sheetId: FOREIGN, type: 'string' })
  pg.seedRecord({ id: 'rec_rt_f1', sheetId: FOREIGN, data: { fld_rt_fname: 'F1' } })
  pg.seedSheet({ id: SRC, baseId: BASE, name: '订单表', rowLevel: opts.rowLevel === true })
  pg.seedSheet({ id: DELETED, baseId: BASE, name: 'Gone', deletedAt: '2026-09-01T00:00:00.000Z' })
  pg.seedField({ id: F.title, sheetId: SRC, type: 'string', order: 0 })
  pg.seedField({ id: F.num, sheetId: SRC, type: 'number', order: 1 })
  pg.seedField({ id: F.link, sheetId: SRC, type: 'link', property: { foreignSheetId: FOREIGN, limitSingleRecord: true }, order: 2 })
  pg.seedField({ id: F.att, sheetId: SRC, type: 'attachment', order: 3 })
  pg.seedField({ id: F.formula, sheetId: SRC, type: 'formula', property: { expression: `={${F.num}} + 1` }, order: 4 })
  pg.seedView({ id: 'view_rt_1', sheetId: SRC, name: '默认视图' })
  const base = Date.parse('2026-09-01T00:00:00.000Z')
  pg.seedRecord({ id: 'rec_rt_1', sheetId: SRC, data: { [F.title]: 'secret-cell-alpha', [F.num]: 1, [F.att]: ['att_rt_1'] }, createdBy: WRITER, createdAtMs: base })
  pg.seedRecord({ id: 'rec_rt_2', sheetId: SRC, data: { [F.title]: 'secret-cell-beta', [F.num]: 2 }, createdBy: ADMIN, createdAtMs: base + 1000 })
  pg.seedLink(F.link, 'rec_rt_1', 'rec_rt_f1')
  if (opts.brokenLink) pg.seedLink(F.link, 'rec_rt_2', 'rec_rt_missing')
  pg.rows('spreadsheet_permissions').push({ sheet_id: SRC, user_id: WRITER, subject_type: 'user', subject_id: WRITER, perm_code: 'spreadsheet:write' })
}

type Identity = { userId: string; roles?: string[]; perms: string[] }
const ADMIN_ID: Identity = { userId: ADMIN, roles: ['admin'], perms: ['multitable:read', 'multitable:write'] }
const WRITER_ID: Identity = { userId: WRITER, roles: [], perms: ['multitable:read', 'multitable:write'] }
const OUTSIDER_ID: Identity = { userId: OUTSIDER, roles: [], perms: ['comments:read'] }

async function createApp(pg: FakePg, identity: Identity) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(identity.roles?.includes('admin') === true),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(identity.perms),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { createMultitableCopySheetRoutes } = await import('../../src/routes/multitable-copy-sheet')
  const { eventBus } = await import('../../src/integration/events/event-bus')
  vi.spyOn(poolManager, 'get').mockReturnValue(pg.asPool() as never)
  const emit = vi.spyOn(eventBus, 'emit').mockImplementation(() => {})
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: identity.userId, roles: identity.roles ?? [], permissions: identity.perms, perms: identity.perms } as Express.Request['user']
    next()
  })
  app.use('/api/multitable', createMultitableCopySheetRoutes())
  return { app, emit }
}

const pinned = usePinnedServer()
const post = (path: string, body: unknown = { withData: true, permissionMode: 'inherit' }) => request(pinned.url()).post(`/api/multitable${path}`).send(body as object)
const writes = (pg: FakePg, from = 0) => pg.statements.slice(from).filter((s) => /^(INSERT|UPDATE|DELETE)\b/i.test(s.sql))

describe('copy-sheet routes (ADR #6094 S1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('H1: no multitable:write → rbacGuard 403 before the handler; no sheet is queried', async () => {
    const pg = new FakePg()
    seed(pg)
    const { app } = await createApp(pg, OUTSIDER_ID)
    pinned.setApp(app)
    for (const path of [`/sheets/${SRC}/copy`, `/sheets/${SRC}/copy/dry-run`]) {
      const res = await post(path)
      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(pg.statements.filter((s) => s.sql.includes('meta_sheets')).map((s) => s.sql)).toEqual([])
    }
  })

  it('H2: body validation and name hygiene refuse before any capability query', async () => {
    const pg = new FakePg()
    seed(pg)
    const { app } = await createApp(pg, ADMIN_ID)
    pinned.setApp(app)
    const bad = await post(`/sheets/${SRC}/copy`, { permissionMode: 'inherit' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('VALIDATION_ERROR')
    const mode = await post(`/sheets/${SRC}/copy`, { withData: true, permissionMode: 'private' })
    expect(mode.status).toBe(400)
    // U+FFFD is the checker's mojibake signature (display-name-hygiene.ts: replacement-character / C0-C1 controls)
    const mojibake = await post(`/sheets/${SRC}/copy/dry-run`, { withData: true, permissionMode: 'inherit', name: '订单�表' })
    expect(mojibake.status).toBe(400)
    expect(mojibake.body.error.code).toBe(DISPLAY_NAME_INVALID_CHARACTERS_CODE)
    expect(pg.statements).toHaveLength(0)
  })

  it('H3: the REAL full-read gate refuses a non-admin writer on a row-level sheet — 403, no count, one refusal audit row', async () => {
    const pg = new FakePg()
    seed(pg, { rowLevel: true })
    const { app } = await createApp(pg, WRITER_ID)
    pinned.setApp(app)
    for (const [path, mode] of [[`/sheets/${SRC}/copy/dry-run`, 'dry-run'], [`/sheets/${SRC}/copy`, 'copy']] as const) {
      const before = pg.rows('operation_audit_logs').length
      const res = await post(path)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ ok: false, error: { code: 'COPY_SOURCE_NOT_FULLY_READABLE', message: expect.any(String) } })
      expect(JSON.stringify(res.body)).not.toMatch(/count|rows|hidden/i)
      const audit = pg.rows('operation_audit_logs').slice(before)
      expect(audit).toHaveLength(1)
      expect(audit[0]!.metadata).toMatchObject({ ok: false, statusCode: 403, errorCode: 'COPY_SOURCE_NOT_FULLY_READABLE', mode })
      // no COUNT / record read happened for the refused caller
      expect(pg.statements.some((s) => s.sql.startsWith('SELECT COUNT(*)') || s.sql.startsWith('SELECT id, data, created_by'))).toBe(false)
    }
    // POSITIVE CONTROL: the same writer, row-level OFF, and owning the base (the fake answers no global codes, so
    // resolveBaseWritable's owner arm is the one that admits him) → passes both gates.
    const open = new FakePg()
    seed(open, { rowLevel: false })
    open.rows('meta_bases')[0]!.owner_id = WRITER
    const ctl = await createApp(open, WRITER_ID)
    pinned.setApp(ctl.app)
    const res = await post(`/sheets/${SRC}/copy/dry-run`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // …and a writer who passes the read gate but neither owns the base nor holds a base-write code → 403 FORBIDDEN
    // (target gate, CS-3 / §4.2), distinct from the source gate's code.
    const notOwner = new FakePg()
    seed(notOwner, { rowLevel: false })
    const ctl2 = await createApp(notOwner, WRITER_ID)
    pinned.setApp(ctl2.app)
    const denied = await post(`/sheets/${SRC}/copy/dry-run`)
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('FORBIDDEN')
  })

  it('H4: a soft-deleted source answers the shared SHEET_DELETED 404 on both routes', async () => {
    const pg = new FakePg()
    seed(pg)
    const { app } = await createApp(pg, ADMIN_ID)
    pinned.setApp(app)
    for (const path of [`/sheets/${DELETED}/copy`, `/sheets/${DELETED}/copy/dry-run`]) {
      const res = await post(path)
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('SHEET_DELETED')
      expect(JSON.stringify(res.body)).not.toContain(DELETED)
    }
    expect(writes(pg)).toHaveLength(0)
  })

  it('H5: dry-run answers the summary and writes nothing', async () => {
    const pg = new FakePg()
    seed(pg)
    const { app } = await createApp(pg, ADMIN_ID)
    pinned.setApp(app)
    const res = await post(`/sheets/${SRC}/copy/dry-run`, { withData: true, permissionMode: 'inherit', name: '订单表-分析' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.summary).toMatchObject({
      sourceSheetId: SRC, baseId: BASE, targetName: '订单表-分析', copiedFromKind: 'user',
      rowCount: 2, fieldCount: 5, builtFieldCount: 5, viewCount: 1, permissionRowCount: 1, rowLevelReadEnabled: false,
      disclosures: [{ fieldId: F.att, code: 'ATTACHMENT_BLANKED' }],
      limits: { maxRows: 2000, maxFields: 500 },
    })
    expect(res.body.data.summary.notCopied).toContain('automations')
    expect(writes(pg)).toHaveLength(0)
    expect(JSON.stringify(res.body)).not.toContain('secret-cell')
  })

  it('H6: copy 201 shape, one sheet.copied event and zero record.created; the second call replays', async () => {
    const pg = new FakePg()
    seed(pg)
    const { app, emit } = await createApp(pg, ADMIN_ID)
    pinned.setApp(app)
    const first = await post(`/sheets/${SRC}/copy`)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    expect(first.headers['idempotent-replayed']).toBeUndefined()
    const data = first.body.data
    expect(data.sheet).toEqual({ id: expect.stringMatching(/^sheet_/), baseId: BASE, name: '订单表 副本', copiedFrom: { kind: 'user', at: null, sheetId: SRC } })
    expect(data.batchId).toEqual(expect.any(String))
    expect(data.summary).toMatchObject({ rowCount: 2, fieldCount: 5, viewCount: 1, permissionRowCount: 1 })
    // post-commit chunked recompute ran over both rows and did not fail (the fake answers the engine's reads)
    expect(data.formulaRecompute).toMatchObject({ attempted: 2, failed: false })
    expect(JSON.stringify(first.body)).not.toContain('secret-cell')
    // events: exactly one values-free sheet-level event, never a per-row one
    const events = emit.mock.calls.map((c) => c[0])
    expect(events.filter((e) => e === 'multitable.sheet.copied')).toHaveLength(1)
    expect(events.filter((e) => e === 'multitable.record.created')).toHaveLength(0)
    const payload = emit.mock.calls.find((c) => c[0] === 'multitable.sheet.copied')![1] as Record<string, unknown>
    expect(payload).toEqual({ sourceSheetId: SRC, targetSheetId: data.sheet.id, targetBaseId: BASE, actorId: ADMIN, rowCount: 2, fieldCount: 5, permissionMode: 'inherit', withData: true })
    expect(pg.rows('meta_records').filter((r) => r.sheet_id === data.sheet.id)).toHaveLength(2)

    emit.mockClear()
    const second = await post(`/sheets/${SRC}/copy`)
    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    const { formulaRecompute: _omit, ...firstSansRecompute } = data
    expect(second.body).toEqual({ ok: true, data: firstSansRecompute })
    expect(pg.rows('meta_sheets').filter((r) => r.copied_from_sheet_id === SRC)).toHaveLength(1)
    expect(emit).not.toHaveBeenCalledWith('multitable.sheet.copied', expect.anything())
  })

  it('H7: a row failure answers 422 { rowIndex, fieldId, code } with no cell value or link id in the bytes, and writes nothing', async () => {
    const pg = new FakePg()
    seed(pg, { brokenLink: true })
    const { app, emit } = await createApp(pg, ADMIN_ID)
    pinned.setApp(app)
    const before = pg.rows('meta_sheets').length
    const res = await post(`/sheets/${SRC}/copy`)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('COPY_ROW_VALIDATION_FAILED')
    expect(res.body.error.details).toEqual({ rowIndex: 1, fieldId: F.link, code: 'LINK_TARGET_NOT_FOUND' })
    const bytes = JSON.stringify(res.body)
    expect(bytes).not.toContain('secret-cell')
    expect(bytes).not.toContain('rec_rt_missing')
    expect(pg.rows('meta_sheets')).toHaveLength(before)
    expect(pg.rows('meta_records').filter((r) => r.sheet_id !== SRC && r.sheet_id !== FOREIGN)).toHaveLength(0)
    expect(emit).not.toHaveBeenCalledWith('multitable.sheet.copied', expect.anything())
    // the refusal is audited once (outside any transaction)
    expect(pg.rows('operation_audit_logs').filter((a) => (a.metadata as { errorCode?: string }).errorCode === 'COPY_ROW_VALIDATION_FAILED')).toHaveLength(1)
  })

  it('H9: over the row cap — dry-run answers 200 with summary.overLimit=true (records not read, structure disclosed); copy answers 413 COPY_TOO_LARGE', async () => {
    process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS = '1'
    try {
      const pg = new FakePg()
      seed(pg)
      const { app } = await createApp(pg, ADMIN_ID)
      pinned.setApp(app)
      const mark = pg.statements.length
      const dry = await post(`/sheets/${SRC}/copy/dry-run`)
      expect(dry.status, JSON.stringify(dry.body)).toBe(200)
      expect(dry.body.data.summary).toMatchObject({ overLimit: true, rowCount: 2, fieldCount: 5, limits: { maxRows: 1, maxFields: 500 }, disclosures: [{ fieldId: F.att, code: 'ATTACHMENT_BLANKED' }] })
      expect(pg.statements.slice(mark).some((s) => s.sql.startsWith('SELECT id, data, created_by FROM meta_records'))).toBe(false)
      expect(writes(pg, mark)).toHaveLength(0)
      const res = await post(`/sheets/${SRC}/copy`)
      expect(res.status).toBe(413)
      expect(res.body.error.code).toBe('COPY_TOO_LARGE')
      expect(res.body.error.details).toEqual({ rowCount: 2, limit: 1 })
      expect(pg.rows('meta_sheets').filter((r) => r.copied_from_sheet_id === SRC)).toHaveLength(0)
    } finally {
      delete process.env.MULTITABLE_COPY_SHEET_SYNC_MAX_ROWS
    }
  })

  it('H10: a Postgres lock SQLSTATE (40P01 / 55P03 / 40001) out of the copy transaction answers 409 CONFLICT, never 500, and nothing is written', async () => {
    for (const code of ['40P01', '55P03', '40001']) {
      const pg = new FakePg({
        beforeStatement: (statement) => {
          if (statement.sql.startsWith('SELECT pg_advisory_xact_lock(hashtext($1))')) {
            const err = new Error('deadlock detected') as Error & { code: string }
            err.code = code
            throw err
          }
        },
      })
      seed(pg)
      const { app } = await createApp(pg, ADMIN_ID)
      pinned.setApp(app)
      const res = await post(`/sheets/${SRC}/copy`)
      expect(res.status, code).toBe(409)
      expect(res.body.error.code).toBe('CONFLICT')
      expect(JSON.stringify(res.body)).not.toContain('deadlock')
      expect(pg.rows('meta_sheets').filter((r) => r.copied_from_sheet_id === SRC)).toHaveLength(0)
    }
  })

  it('H8: session-only registration — no apiTokenAuth / oapiScopeGuard on either route (CS-1)', () => {
    const source = readFileSync(join(__dirname, '../../src/routes/multitable-copy-sheet.ts'), 'utf8')
    // WHOLE file, comments included: the #3365 OAPI tripwire (multitable-oapi-allowlist-guard-tripwire.test.ts)
    // scans every route source for the token-auth identifier and demands a ROUTE_FILES entry for any hit — a
    // header comment that merely NAMED the middleware it does not mount turned CI red on 2b95e1f70. The
    // posture is therefore pinned as "the identifiers do not appear in this file at all".
    expect(source).not.toMatch(/apiTokenAuth|oapiScopeGuard|requireScope|apiTokenWriteRateLimit/)
    expect(source.match(/router\.post\('\/sheets\/:sheetId\/copy(\/dry-run)?', rbacGuard\('multitable', 'write'\)/g)).toHaveLength(2)
  })
})
