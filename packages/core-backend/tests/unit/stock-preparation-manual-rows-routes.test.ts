/**
 * 人工补充行 B2 (ADR adr-stock-prep-manual-rows-20261030 §3.2–§3.4, §3.7, §4; §8 「B2 主机」) — the three host routes and
 * the /context block, over the real univer-meta router and the real record services, on a stateful fake Postgres
 * (tests/utils/stock-prep-manual-rows-fake-pg.ts: the plugin's own template, physical ids derived as the host derives
 * them, both registries, records, per-subject field permissions).
 *
 *   C   POST /sheets/:sheetId/manual-rows — the six ordered conditions (each refused before any write), the switch's
 *       states, the stamps, the lock exemption for the six fillable columns ONLY, the closed-code refusal of the
 *       server-written columns, the per-subject field gate, the required rewrite, conditions 3 / 4 / 6 re-checked
 *       INSIDE the create transaction, session-only, and the extension token (refused unless minted; never a capability).
 *   Y   POST /records/:recordId/manual-copy — the whitelist: the six + 备料计划 copied, the lineage pair (OQ5), 进度与回复,
 *       identity / RUN and the stamps never; read AND write required per column; fresh stamps; same gates.
 *   E   PATCH /records/:recordId/manual-fields — only the six, only on a row satisfying M, 名称 / 总用量 not clearable,
 *       per-subject gate, archived / switch-off / deployment-switch-off do not stop it, M re-checked in the transaction;
 *       /patch and PATCH /records keep refusing the six on the same row.
 *   X   GET /context — the block's state per condition, and who gets it.
 *
 * Mock pool, no DB; one pinned listener (`request(app)` is banned in tests/unit, #4154). Every value is synthetic.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import {
  MR_ENV_OBJECT,
  MR_PLUGIN,
  MR_PROJECT_NO,
  MR_SWITCH,
  createManualRowsFakePool,
  type FakeSheet,
} from '../utils/stock-prep-manual-rows-fake-pg'
import { RecordService } from '../../src/multitable/record-service'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  loadManualRowsVerdict,
  mintManualRowCreateExtension,
  STOCK_PREP_MANUAL_ROWS_DISABLED_CODE,
  STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE,
} from '../../src/multitable/stock-preparation-manual-rows-gate'

const fake = createManualRowsFakePool()

const WRITER = { id: 'u_mrb2_writer', roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const ADMIN = { id: 'u_mrb2_admin', roles: ['admin'], perms: [] as string[] }
const READER = { id: 'u_mrb2_reader', roles: ['member'], perms: ['multitable:read'] }
let actor: { id: string; roles: string[]; perms: string[] } = WRITER
let app: Express

const P = (n: number) => `plm_stock_preparation_sandbox_p_${n.toString(16).padStart(24, '0')}`

type Sheets = Record<string, FakeSheet>
let S: Sheets

/**
 * ADR §8 「B2 主机」 2: the sheet still resolves exactly ONE `key: true` column, but it is NOT the 唯一键 the host
 * registry row derives — the derived idempotencyKey keeps its stanza with `key: false`, the flag sits on another column.
 * Every manual-row path must fail closed (contract_mismatch).
 */
function keyMoved(sheet: FakeSheet): FakeSheet {
  const key = sheet.fields.find((field) => field.id === fake.phys(sheet, 'idempotencyKey'))!
  ;(key.property.stockPreparation as Record<string, unknown>).key = false
  return sheet
}

function seedSheets(): Sheets {
  fake.reset()
  return {
    PREG: fake.addSheet('PREG', { objectId: P(1) }),
    ALLOWED: fake.addSheet('ALLOWED', { objectId: P(2), policy: 'allowed' }),
    DISABLED: fake.addSheet('DISABLED', { objectId: P(3), policy: 'disabled' }),
    JUNK: fake.addSheet('JUNK', { objectId: P(4), policy: 'nope' }),
    NULLPOLICY: fake.addSheet('NULLPOLICY', { objectId: P(5), policy: null }),
    ARCHIVED: fake.addSheet('ARCHIVED', { objectId: P(6), target: { status: 'archived' } }),
    NOLOCK: fake.addSheet('NOLOCK', { objectId: P(7), locked: 'none' }),
    KEYLOCKONLY: fake.addSheet('KEYLOCKONLY', { objectId: P(8), locked: ['idempotencyKey'] }),
    NO087: fake.addSheet('NO087', { objectId: P(9), target: null }),
    ENV: fake.addSheet('ENV', { objectId: MR_ENV_OBJECT, target: null }),
    // The plugin registry claims an env-shaped sheet: (a) fails on the HOST registry row, so it is not P_reg.
    FOREIGN: fake.addSheet('FOREIGN', { objectId: 'plm_stock_preparation_sandbox_mrb2_twin', target: { status: 'active' } }),
    OTHERPLUGIN: fake.addSheet('OTHERPLUGIN', { objectId: P(10), plugin: 'plugin-other-synthetic' }),
    MISMATCH: fake.addSheet('MISMATCH', { objectId: P(11), target: { status: 'active', objectId: P(12) } }),
    BADROW: fake.addSheet('BADROW', { objectId: P(13), target: { status: 'active', projectNo: '   ' } }),
    TWOKEYS: fake.addSheet('TWOKEYS', { objectId: P(14), secondKey: true }),
    KEYMOVED: keyMoved(fake.addSheet('KEYMOVED', { objectId: P(18), secondKey: true })),
    NONAME: fake.addSheet('NONAME', { objectId: P(15), omit: ['componentName'] }),
    COPY: fake.addSheet('COPY', { objectId: P(16), plugin: null, target: null }),
    PLAIN: fake.addSheet('PLAIN', { objectId: P(17), noStanza: true }),
  }
}

const ph = (sheet: FakeSheet, logical: string) => fake.phys(sheet, logical)
const recordsOf = (sheet: FakeSheet) => [...fake.records.values()].filter((r) => r.sheet_id === sheet.sheetId)

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
const createRow = (sheet: FakeSheet, data: Record<string, unknown>, headers: Record<string, string> = {}) =>
  http().post(`/api/multitable/sheets/${sheet.sheetId}/manual-rows`).set(headers).send({ data })
const copyRow = (recordId: string) => http().post(`/api/multitable/records/${recordId}/manual-copy`).send({})
const editRow = (recordId: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  http().patch(`/api/multitable/records/${recordId}/manual-fields`).send({ data, ...extra })
const context = (sheet: FakeSheet) => http().get('/api/multitable/context').query({ sheetId: sheet.sheetId })

/** A valid create body for `sheet`: 名称 + 总用量 (the two the create requires). */
const minimal = (sheet: FakeSheet, extra: Record<string, unknown> = {}) => ({
  [ph(sheet, 'componentName')]: 'Synthetic manual part',
  [ph(sheet, 'totalQuantity')]: 3,
  ...extra,
})

const SWITCH_BEFORE = process.env[MR_SWITCH]

beforeAll(async () => {
  app = await buildApp()
}, 120_000)

beforeEach(() => {
  S = seedSheets()
  actor = WRITER
  process.env[MR_SWITCH] = 'true'
})

afterEach(() => {
  if (SWITCH_BEFORE === undefined) delete process.env[MR_SWITCH]
  else process.env[MR_SWITCH] = SWITCH_BEFORE
})

// ── C. POST /sheets/:sheetId/manual-rows ─────────────────────────────────────────────────────────────────

describe('C — 新增: POST /sheets/:sheetId/manual-rows', () => {
  it.each([
    ['a writer', WRITER],
    ['a platform admin', ADMIN],
  ])('C-01 %s: 200, the stamps (项目号 from the registry, manual:v1:<own id>, 有效), created_by, no identity column', async (_label, who) => {
    actor = who
    const res = await createRow(S.PREG, minimal(S.PREG, { [ph(S.PREG, 'componentCode')]: 'SYN-DRAWING-1', [ph(S.PREG, 'notes')]: 'synthetic note' }))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const id = res.body.data.record.id as string
    const stored = fake.records.get(id)!
    expect(stored.sheet_id).toBe(S.PREG.sheetId)
    expect(stored.created_by).toBe(who.id)
    expect(stored.data[ph(S.PREG, 'projectNo')]).toBe(MR_PROJECT_NO)
    expect(stored.data[ph(S.PREG, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
    expect(stored.data[ph(S.PREG, 'active')]).toBe(true)
    expect(stored.data[ph(S.PREG, 'componentCode')]).toBe('SYN-DRAWING-1')
    expect(stored.data[ph(S.PREG, 'notes')]).toBe('synthetic note')
    for (const logical of ['componentSourceId', 'parentSourceId', 'path', 'depth', 'sourceVersion', 'lastPlmRefreshRunId', 'lastPlmRefreshAt', 'lastPlmRefreshDecision', 'lastPlmConflictSummary', 'parentComponentCode', 'parentComponentName']) {
      expect(ph(S.PREG, logical) in stored.data, logical).toBe(false)
    }
    // The echo is the masked create echo; it names the server-minted id and the stamped key.
    expect(res.body.data.record.data[ph(S.PREG, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
    expect(res.body.data.record.version).toBe(1)
  })

  it('C-02 all six fillable columns are written (the lock exemption) — and only those six locked columns', async () => {
    const six = {
      [ph(S.PREG, 'componentCode')]: 'SYN-DRAWING-6',
      [ph(S.PREG, 'componentName')]: 'Synthetic six',
      [ph(S.PREG, 'componentSpec')]: 'SYN-SPEC',
      [ph(S.PREG, 'material')]: 'SYN-MATERIAL',
      [ph(S.PREG, 'rawQuantity')]: 2,
      [ph(S.PREG, 'totalQuantity')]: 4,
    }
    const res = await createRow(S.PREG, six)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = fake.records.get(res.body.data.record.id)!
    for (const [fieldId, value] of Object.entries(six)) expect(stored.data[fieldId]).toBe(value)
  })

  it.each([
    ['唯一键 (stamp)', 'idempotencyKey'],
    ['项目号 (stamp)', 'projectNo'],
    ['有效 (stamp)', 'active'],
    ['PLM 物料ID (identity)', 'componentSourceId'],
    ['BOM 路径 (identity)', 'path'],
    ['RUN', 'lastPlmRefreshRunId'],
    ['父组件图号 (lineage)', 'parentComponentCode'],
    ['父组件名称 (lineage)', 'parentComponentName'],
  ])('C-03 a submitted %s column answers 403 FIELD_READONLY_PLM_SYSTEM with the id, nothing written', async (_label, logical) => {
    const fieldId = ph(S.PREG, logical)
    const res = await createRow(S.PREG, minimal(S.PREG, { [fieldId]: logical === 'active' ? false : 'SYN-FORGED' }))
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
    expect(res.body.error.fieldIds).toEqual([fieldId])
    expect(recordsOf(S.PREG)).toEqual([])
  })

  it('C-04 an identity column WITHOUT its lock is refused all the same (manual rows never carry componentSourceId)', async () => {
    // Only the three stamped columns locked: componentSourceId is writable for people on this sheet, never on a manual row.
    const sheet = fake.addSheet('THREELOCKS', { objectId: P(40), locked: ['idempotencyKey', 'projectNo', 'active'] })
    const res = await createRow(sheet, minimal(sheet, { [ph(sheet, 'componentSourceId')]: 'SYN-FORGED' }))
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
    expect(recordsOf(sheet)).toEqual([])
  })

  it('C-05 a reader (canCreateRecord=false on the actor\'s OWN capabilities) is refused 403 before any registry read; nothing written', async () => {
    actor = READER
    const res = await createRow(S.PREG, minimal(S.PREG))
    expect(res.status).toBe(403)
    expect(recordsOf(S.PREG)).toEqual([])
    expect(fake.statements(/integration_stock_prep_project_target/)).toEqual([])
  })

  it('C-06 session requests only: an mst_ bearer is refused 401 before any read', async () => {
    const res = await createRow(S.PREG, minimal(S.PREG), { authorization: 'Bearer mst_synthetic_token' })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('SESSION_REQUIRED')
    expect(recordsOf(S.PREG)).toEqual([])
  })

  it.each([
    ['NO087', 'provisioned only — no plugin registry row (the PB-05 shape)'],
    ['ENV', 'the env main table'],
    ['FOREIGN', 'a plugin registry row on a sheet whose HOST registry row is not a project sheet\'s ((a) fails)'],
    ['OTHERPLUGIN', 'a project-shaped object registered by another plugin'],
    ['COPY', 'the stanza without any host registry row (a copy)'],
    ['PLAIN', 'an ordinary sheet'],
  ])('C-07 not P_reg (%s — %s): 409 STOCK_PREP_MANUAL_ROWS_UNAVAILABLE / not_project_sheet, nothing written', async (key) => {
    const sheet = S[key]
    const res = await createRow(sheet, minimal(sheet))
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error.code).toBe(STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE)
    expect(res.body.error.details).toEqual({ reason: 'not_project_sheet' })
    expect(recordsOf(sheet)).toEqual([])
  })

  it('C-08 an ordinary sheet issues neither of the gate\'s registry statements (the resolver\'s own clamp lookup is not the gate\'s)', async () => {
    await createRow(S.PLAIN, minimal(S.PLAIN))
    expect(fake.statements(/^SELECT project_id, object_id, plugin_name FROM plugin_multitable_object_registry/)).toEqual([])
    expect(fake.statements(/integration_stock_prep_project_target/)).toEqual([])
  })

  it.each([
    ['NOLOCK', 'lock_missing'],
    ['KEYLOCKONLY', 'lock_missing'],
    ['ARCHIVED', 'project_archived'],
    ['MISMATCH', 'contract_mismatch'],
    ['BADROW', 'contract_mismatch'],
    ['TWOKEYS', 'contract_mismatch'],
    ['KEYMOVED', 'contract_mismatch'],
    ['NONAME', 'contract_mismatch'],
  ])('C-09 %s: 409 STOCK_PREP_MANUAL_ROWS_UNAVAILABLE / %s, nothing written', async (key, reason) => {
    const sheet = S[key]
    const res = await createRow(sheet, minimal(sheet))
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error.code).toBe(STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE)
    expect(res.body.error.details).toEqual({ reason })
    expect(recordsOf(sheet)).toEqual([])
  })

  it('C-10 the plugin registry cannot be read (any SQLSTATE but 42P01): 503 registry_unreadable, nothing written; classified by SQLSTATE, not message', async () => {
    fake.failures.target = { code: '42703', message: 'synthetic: column does not exist' }
    const res = await createRow(S.PREG, minimal(S.PREG))
    expect(res.status).toBe(503)
    expect(res.body.error).toMatchObject({ code: STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE, details: { reason: 'registry_unreadable' } })
    // A message that NAMES a missing relation but carries no SQLSTATE is still unreadable (the message is never read).
    fake.failures.target = { message: 'relation "integration_stock_prep_project_target" does not exist' }
    expect((await createRow(S.PREG, minimal(S.PREG))).status).toBe(503)
    fake.failures.target = null
    // A HOST registry that cannot be read fails the request before the gate is reached (the capability resolver's own
    // project-sheet clamp reads it first and propagates — its posture); either way nothing is written. The gate's own
    // mapping of that read (registry_unreadable) is pinned on the pure functions in the contract suite.
    fake.failures.hostRegistry = { code: '57014', message: 'synthetic: statement timeout' }
    expect((await createRow(S.PREG, minimal(S.PREG))).status).toBeGreaterThanOrEqual(500)
    expect(recordsOf(S.PREG)).toEqual([])
  })

  it('C-11 42P01 on the plugin registry = not registered: the old behaviour (not_project_sheet, 409), never 503', async () => {
    fake.failures.target = { code: '42P01', message: 'synthetic: some text' }
    const res = await createRow(S.PREG, minimal(S.PREG))
    expect(res.status).toBe(409)
    expect(res.body.error.details).toEqual({ reason: 'not_project_sheet' })
  })

  it.each([
    ['unset', undefined],
    ['TRUE', 'TRUE'],
    [' true', ' true'],
    ['1', '1'],
    ['yes', 'yes'],
  ])('C-12 MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED %s: 409 project_sheets_off (the plugin\'s exact-literal rule), nothing written', async (_label, value) => {
    if (value === undefined) delete process.env[MR_SWITCH]
    else process.env[MR_SWITCH] = value
    const res = await createRow(S.PREG, minimal(S.PREG))
    expect(res.status).toBe(409)
    expect(res.body.error.details).toEqual({ reason: 'project_sheets_off' })
    expect(recordsOf(S.PREG)).toEqual([])
  })

  it.each([
    ['PREG', 'absent', 200],
    ['ALLOWED', "'allowed'", 200],
    ['DISABLED', "'disabled'", 409],
    ['JUNK', 'a junk string', 409],
    ['NULLPOLICY', 'null', 409],
  ])('C-13 the switch on %s (%s): %s', async (key, _label, status) => {
    const sheet = S[key]
    const res = await createRow(sheet, minimal(sheet))
    expect(res.status, JSON.stringify(res.body)).toBe(status)
    if (status === 409) {
      expect(res.body.error.code).toBe(STOCK_PREP_MANUAL_ROWS_DISABLED_CODE)
      expect(res.body.error.details).toEqual({ reason: 'disabled' })
      expect(recordsOf(sheet)).toEqual([])
    }
  })

  it('C-14 the per-subject field gate: a column the actor\'s field_permissions make read-only is refused 403 — on a fillable column and on a human column', async () => {
    fake.fieldPermissions.push({ sheetId: S.PREG.sheetId, fieldId: ph(S.PREG, 'componentSpec'), userId: WRITER.id, visible: true, readOnly: true })
    fake.fieldPermissions.push({ sheetId: S.PREG.sheetId, fieldId: ph(S.PREG, 'notes'), userId: WRITER.id, visible: true, readOnly: true })
    const spec = await createRow(S.PREG, minimal(S.PREG, { [ph(S.PREG, 'componentSpec')]: 'SYN' }))
    expect(spec.status).toBe(403)
    expect(spec.body.error.message).toContain(ph(S.PREG, 'componentSpec'))
    const notes = await createRow(S.PREG, minimal(S.PREG, { [ph(S.PREG, 'notes')]: 'SYN' }))
    expect(notes.status).toBe(403)
    expect(recordsOf(S.PREG)).toEqual([])
    // A column the actor may write still lands.
    expect((await createRow(S.PREG, minimal(S.PREG, { [ph(S.PREG, 'material')]: 'SYN' }))).status).toBe(200)
  })

  it('C-14b the create echo is masked: a stamped column the actor may not SEE is stored but not echoed', async () => {
    fake.fieldPermissions.push({ sheetId: S.PREG.sheetId, fieldId: ph(S.PREG, 'projectNo'), userId: WRITER.id, visible: false, readOnly: false })
    const res = await createRow(S.PREG, minimal(S.PREG))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const id = res.body.data.record.id as string
    expect(fake.records.get(id)!.data[ph(S.PREG, 'projectNo')]).toBe(MR_PROJECT_NO)
    expect(ph(S.PREG, 'projectNo') in res.body.data.record.data).toBe(false)
    expect(res.body.data.record.data[ph(S.PREG, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
  })

  it('C-15 the required rewrite: 名称 is required on this create, 总用量 stays required, PLM 物料ID / BOM 路径 are not', async () => {
    const noName = await createRow(S.PREG, { [ph(S.PREG, 'totalQuantity')]: 1 })
    expect(noName.status).toBe(422)
    expect(Object.keys(noName.body.error.fieldErrors)).toContain(ph(S.PREG, 'componentName'))
    const noTotal = await createRow(S.PREG, { [ph(S.PREG, 'componentName')]: 'SYN' })
    expect(noTotal.status).toBe(422)
    expect(Object.keys(noTotal.body.error.fieldErrors)).toContain(ph(S.PREG, 'totalQuantity'))
    expect(Object.keys(noTotal.body.error.fieldErrors)).not.toContain(ph(S.PREG, 'componentSourceId'))
    expect(Object.keys(noTotal.body.error.fieldErrors)).not.toContain(ph(S.PREG, 'path'))
    expect(recordsOf(S.PREG)).toEqual([])
  })

  it('C-16 generic POST /records on the same P_reg sheet is refused BY STATE since B3 (ADR §3.1): 409 STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW, whatever the body — the full table lives in stock-preparation-manual-rows-generic-create.test.ts', async () => {
    const locked = await http().post('/api/multitable/records').send({ sheetId: S.PREG.sheetId, data: { [ph(S.PREG, 'componentName')]: 'SYN' } })
    expect(locked.status).toBe(409)
    expect(locked.body.error.code).toBe('STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW')
    const human = await http().post('/api/multitable/records').send({ sheetId: S.PREG.sheetId, data: { [ph(S.PREG, 'notes')]: 'SYN' } })
    expect(human.status).toBe(409)
    expect(human.body.error.details).toEqual({ state: 'allowed' })
    expect(recordsOf(S.PREG)).toEqual([])
  })

  describe('C-17 conditions 3, 4 and 6 run AGAIN inside the create transaction, on the re-read fields and registry', () => {
    it('the switch turned off between the route\'s check and the transaction: 409 disabled, nothing written', async () => {
      fake.setOnTransactionFieldRead((sheet) => {
        const key = sheet.fields.find((f) => f.id === ph(sheet, 'idempotencyKey'))!
        key.property.stockPreparationManualRows = 'disabled'
      })
      const res = await createRow(S.PREG, minimal(S.PREG))
      expect(res.status).toBe(409)
      expect(res.body.error.details).toEqual({ reason: 'disabled' })
      expect(recordsOf(S.PREG)).toEqual([])
    })
    it('the project archived in between: 409 project_archived', async () => {
      fake.setOnTransactionFieldRead((sheet) => { sheet.target = { status: 'archived' } })
      const res = await createRow(S.PREG, minimal(S.PREG))
      expect(res.status).toBe(409)
      expect(res.body.error.details).toEqual({ reason: 'project_archived' })
      expect(recordsOf(S.PREG)).toEqual([])
    })
    it('a lock lifted in between: 409 lock_missing', async () => {
      fake.setOnTransactionFieldRead((sheet) => {
        const projectNo = sheet.fields.find((f) => f.id === ph(sheet, 'projectNo'))!
        delete projectNo.property.humanWriteLock
      })
      const res = await createRow(S.PREG, minimal(S.PREG))
      expect(res.status).toBe(409)
      expect(res.body.error.details).toEqual({ reason: 'lock_missing' })
      expect(recordsOf(S.PREG)).toEqual([])
    })
    it('the plugin registry unreadable in between: 503', async () => {
      fake.setOnTransactionFieldRead(() => { fake.failures.target = { code: '08006', message: 'synthetic: connection failure' } })
      const res = await createRow(S.PREG, minimal(S.PREG))
      expect(res.status).toBe(503)
      expect(recordsOf(S.PREG)).toEqual([])
    })
  })

  describe('C-18 the extension token: the manual-row branch runs only for a minted extension, and it is never a capability', () => {
    const fullCaps = { canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false, canManageSheetAccess: false, canManageViews: false, canComment: true, canManageAutomation: false, canExport: true, canSendNotification: false, canSubmitApproval: false }
    const service = () => new RecordService(fake.pool as never, new EventBus())
    const sheetFor = async (sheet: FakeSheet) => {
      const verdict = await loadManualRowsVerdict(fake.pool.query as never, sheet.sheetId, sheet.fields, 'create', true)
      if (verdict.kind !== 'allowed') throw new Error(`fixture not allowed: ${verdict.kind}`)
      return verdict.sheet
    }
    it('a forged (unminted) extension of the same shape is refused before any read', async () => {
      const forged = Object.freeze({ sheetId: S.PREG.sheetId, hostProjectId: S.PREG.projectId, hostObjectId: S.PREG.objectId, origin: 'create' as const })
      fake.sqlLog.length = 0
      await expect(service().createRecord({ sheetId: S.PREG.sheetId, data: minimal(S.PREG), actorId: WRITER.id, capabilities: fullCaps, manualRow: forged }))
        .rejects.toMatchObject({ name: 'RecordPermissionError' })
      expect(fake.sqlLog).toEqual([])
      expect(recordsOf(S.PREG)).toEqual([])
    })
    it('a minted extension for ANOTHER sheet is refused', async () => {
      const minted = mintManualRowCreateExtension(await sheetFor(S.ALLOWED), 'create')
      await expect(service().createRecord({ sheetId: S.PREG.sheetId, data: minimal(S.PREG), actorId: WRITER.id, capabilities: fullCaps, manualRow: minted }))
        .rejects.toMatchObject({ name: 'RecordPermissionError' })
    })
    it('a minted extension does not stand in for canCreateRecord: the actor\'s capabilities still decide', async () => {
      const minted = mintManualRowCreateExtension(await sheetFor(S.PREG), 'create')
      await expect(service().createRecord({ sheetId: S.PREG.sheetId, data: minimal(S.PREG), actorId: READER.id, capabilities: { ...fullCaps, canCreateRecord: false }, manualRow: minted }))
        .rejects.toMatchObject({ name: 'RecordPermissionError' })
      expect(recordsOf(S.PREG)).toEqual([])
    })
    it('without the extension, the same create is the generic one: the six fillable columns stay locked (403)', async () => {
      await expect(service().createRecord({ sheetId: S.PREG.sheetId, data: minimal(S.PREG), actorId: WRITER.id, capabilities: fullCaps }))
        .rejects.toMatchObject({ code: 'FIELD_READONLY_PLM_SYSTEM' })
    })
  })
})

// ── Y. POST /records/:recordId/manual-copy ───────────────────────────────────────────────────────────────

describe('Y — 复制为新行: POST /records/:recordId/manual-copy', () => {
  const PLM_KEY = JSON.stringify({ projectNo: MR_PROJECT_NO, componentSourceId: 'SYN-PART-1', parentSourceId: 'SYN-PART-0', path: '["SYN-PART-0","SYN-PART-1"]' })
  const SOURCE_CELLS: Record<string, unknown> = {
    projectNo: MR_PROJECT_NO,
    idempotencyKey: PLM_KEY,
    componentSourceId: 'SYN-PART-1',
    parentSourceId: 'SYN-PART-0',
    parentComponentCode: 'SYN-PARENT-DRAWING',
    parentComponentName: 'Synthetic parent',
    path: '["SYN-PART-0","SYN-PART-1"]',
    depth: 2,
    componentCode: 'SYN-DRAWING-1',
    componentName: 'Synthetic part',
    componentSpec: 'SYN-SPEC',
    material: 'SYN-MATERIAL',
    sourceVersion: 'V1',
    rawQuantity: 2,
    totalQuantity: 4,
    active: true,
    lastPlmRefreshRunId: 'run_synthetic',
    lastPlmRefreshAt: '2026-10-30',
    lastPlmRefreshDecision: 'SYN-A',
    lastPlmConflictSummary: 'synthetic',
    materialType: 'SYN-A',
    blankType: 'SYN-B',
    demandDate: '2026-11-01',
    leadTimeDays: 5,
    makeOrBuy: 'SYN-A',
    stockPreparationStatus: 'SYN-A',
    notes: 'synthetic note',
    procurementReply: 'synthetic reply',
    warehouseConfirmation: 'synthetic confirmation',
    procurementDone: true,
    procurementReplyDate: '2026-10-31',
    warehouseDone: false,
    actualArrivalDate: '2026-11-02',
  }
  const COPIED = ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity', 'materialType', 'blankType', 'demandDate', 'leadTimeDays', 'makeOrBuy']
  const NOT_COPIED = [
    'parentComponentCode', 'parentComponentName',
    'stockPreparationStatus', 'notes', 'procurementReply', 'warehouseConfirmation', 'procurementDone', 'procurementReplyDate', 'warehouseDone', 'actualArrivalDate',
    'componentSourceId', 'parentSourceId', 'path', 'depth', 'sourceVersion', 'lastPlmRefreshRunId', 'lastPlmRefreshAt', 'lastPlmRefreshDecision', 'lastPlmConflictSummary',
  ]

  it('Y-01 a PLM row copied: the six + 备料计划 copied; the lineage pair (OQ5), 进度与回复, identity / RUN never; fresh stamps; the source untouched', async () => {
    const source = fake.addRecord(S.PREG, 'rec_mrb2_copy_source', SOURCE_CELLS, null)
    const sourceBefore = structuredClone(source)
    const res = await copyRow(source.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const id = res.body.data.record.id as string
    expect(id).not.toBe(source.id)
    const copy = fake.records.get(id)!
    for (const logical of COPIED) expect(copy.data[ph(S.PREG, logical)], logical).toEqual(SOURCE_CELLS[logical])
    for (const logical of NOT_COPIED) expect(ph(S.PREG, logical) in copy.data, logical).toBe(false)
    expect(copy.data[ph(S.PREG, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
    expect(copy.data[ph(S.PREG, 'projectNo')]).toBe(MR_PROJECT_NO)
    expect(copy.data[ph(S.PREG, 'active')]).toBe(true)
    expect(copy.created_by).toBe(WRITER.id)
    expect(fake.records.get(source.id)).toEqual(sourceBefore)
  })

  it('Y-02 per column: READ on the source column and WRITE for every copied column — a read-denied fillable column and a write-denied plan column are not copied', async () => {
    const source = fake.addRecord(S.PREG, 'rec_mrb2_copy_masked', SOURCE_CELLS, null)
    fake.fieldPermissions.push({ sheetId: S.PREG.sheetId, fieldId: ph(S.PREG, 'componentSpec'), userId: WRITER.id, visible: false, readOnly: false })
    fake.fieldPermissions.push({ sheetId: S.PREG.sheetId, fieldId: ph(S.PREG, 'materialType'), userId: WRITER.id, visible: true, readOnly: true })
    const res = await copyRow(source.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const copy = fake.records.get(res.body.data.record.id)!
    expect(ph(S.PREG, 'componentSpec') in copy.data).toBe(false)
    expect(ph(S.PREG, 'materialType') in copy.data).toBe(false)
    expect(copy.data[ph(S.PREG, 'material')]).toBe('SYN-MATERIAL')
    // The masked create echo never carries the read-denied column either.
    expect(ph(S.PREG, 'componentSpec') in res.body.data.record.data).toBe(false)
  })

  it('Y-03 columns outside the template: an ext_ human_preserved column copies, an ext_ plm_system one does not, a column without the stanza copies', async () => {
    const extHuman = 'fld_mrb2_ext_human'
    const extPlm = 'fld_mrb2_ext_plm'
    const plain = 'fld_mrb2_plain'
    const sheet = fake.addSheet('EXT', {
      objectId: P(41),
      extra: [
        { id: extHuman, name: 'Ext human', type: 'string', property: { stockPreparation: { ownership: 'human_preserved', preserveOnRefresh: true, required: false, key: false } } },
        { id: extPlm, name: 'Ext plm', type: 'string', property: { stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false, required: false, key: false } } },
        { id: plain, name: 'Plain', type: 'string', property: {} },
      ],
    })
    const source = fake.addRecord(sheet, 'rec_mrb2_copy_ext', { componentName: 'SYN', totalQuantity: 1 }, null, { [extHuman]: 'h', [extPlm]: 'p', [plain]: 'x' })
    const res = await copyRow(source.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const copy = fake.records.get(res.body.data.record.id)!
    expect(copy.data[extHuman]).toBe('h')
    expect(extPlm in copy.data).toBe(false)
    expect(copy.data[plain]).toBe('x')
  })

  it('Y-04 a manual row copied: a NEW key (manual:v1:<new id>), never the source\'s', async () => {
    const created = await createRow(S.PREG, minimal(S.PREG, { [ph(S.PREG, 'componentCode')]: 'SYN-M' }))
    const sourceId = created.body.data.record.id as string
    const res = await copyRow(sourceId)
    expect(res.status).toBe(200)
    const copy = fake.records.get(res.body.data.record.id)!
    expect(copy.data[ph(S.PREG, 'idempotencyKey')]).toBe(`manual:v1:${res.body.data.record.id}`)
    expect(copy.data[ph(S.PREG, 'idempotencyKey')]).not.toBe(`manual:v1:${sourceId}`)
  })

  it.each([
    ['DISABLED', 409, 'disabled'],
    ['ARCHIVED', 409, 'project_archived'],
    ['NO087', 409, 'not_project_sheet'],
    ['NOLOCK', 409, 'lock_missing'],
    ['KEYMOVED', 409, 'contract_mismatch'],
  ])('Y-05 the same gates as 新增 (%s): %s %s, nothing written', async (key, status, reason) => {
    const sheet = S[key]
    const source = fake.addRecord(sheet, `rec_mrb2_copy_gate_${key}`, { componentName: 'SYN', totalQuantity: 1 }, null)
    const res = await copyRow(source.id)
    expect(res.status, JSON.stringify(res.body)).toBe(status)
    expect(res.body.error.details).toEqual({ reason })
    expect(recordsOf(sheet).map((r) => r.id)).toEqual([source.id])
  })

  it('Y-06 a reader can read the source but cannot create: 403, nothing written', async () => {
    const source = fake.addRecord(S.PREG, 'rec_mrb2_copy_reader', SOURCE_CELLS, null)
    actor = READER
    const res = await copyRow(source.id)
    expect(res.status).toBe(403)
    expect(recordsOf(S.PREG).map((r) => r.id)).toEqual([source.id])
  })

  it('Y-08 the WHITELIST itself keeps the lineage pair, identity / RUN and 进度与回复 out — on a sheet where only the three stamped columns are locked, so no lock does it', async () => {
    // On a fully locked sheet the copy's per-column WRITE check already drops every locked column but the six (their lock
    // is lifted), which would hide a whitelist fault; here the lineage / identity / RUN columns are writable for people.
    const sheet = fake.addSheet('THREELOCKS_COPY', { objectId: P(42), locked: ['idempotencyKey', 'projectNo', 'active'] })
    const source = fake.addRecord(sheet, 'rec_mrb2_copy_unlocked', SOURCE_CELLS, null)
    const res = await copyRow(source.id)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const copy = fake.records.get(res.body.data.record.id)!
    for (const logical of COPIED) expect(copy.data[ph(sheet, logical)], logical).toEqual(SOURCE_CELLS[logical])
    for (const logical of NOT_COPIED) expect(ph(sheet, logical) in copy.data, logical).toBe(false)
    expect(copy.data[ph(sheet, 'idempotencyKey')]).toBe(`manual:v1:${res.body.data.record.id}`)
  })

  it('Y-07 deployment switch off: 409 project_sheets_off', async () => {
    const source = fake.addRecord(S.PREG, 'rec_mrb2_copy_off', SOURCE_CELLS, null)
    delete process.env[MR_SWITCH]
    const res = await copyRow(source.id)
    expect(res.status).toBe(409)
    expect(res.body.error.details).toEqual({ reason: 'project_sheets_off' })
  })
})

// ── E. PATCH /records/:recordId/manual-fields ────────────────────────────────────────────────────────────

describe('E — 修改: PATCH /records/:recordId/manual-fields', () => {
  const manualRow = (sheet: FakeSheet, id: string, createdBy: string | null = WRITER.id, key = `manual:v1:${id}`) =>
    fake.addRecord(sheet, id, { projectNo: MR_PROJECT_NO, idempotencyKey: key, active: true, componentName: 'SYN', totalQuantity: 1 }, createdBy)

  it('E-01 a manual row: the six fillable columns are updated, the version bumps, the key stays', async () => {
    const row = manualRow(S.PREG, 'rec_mrb2_edit_ok')
    const res = await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'Renamed', [ph(S.PREG, 'totalQuantity')]: 9, [ph(S.PREG, 'componentSpec')]: 'SYN-SPEC' }, { expectedVersion: 1 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = fake.records.get(row.id)!
    expect(stored.data[ph(S.PREG, 'componentName')]).toBe('Renamed')
    expect(stored.data[ph(S.PREG, 'totalQuantity')]).toBe(9)
    expect(stored.data[ph(S.PREG, 'componentSpec')]).toBe('SYN-SPEC')
    expect(stored.data[ph(S.PREG, 'idempotencyKey')]).toBe(`manual:v1:${row.id}`)
    expect(stored.version).toBe(2)
    expect(res.body.data.updated).toEqual([{ recordId: row.id, version: 2 }])
  })

  it.each([
    ['a human column', 'notes'],
    ['the key', 'idempotencyKey'],
    ['项目号', 'projectNo'],
    ['an identity column', 'componentSourceId'],
    ['the lineage pair', 'parentComponentCode'],
  ])('E-02 %s is outside the six: 400 STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE naming it, nothing written', async (_label, logical) => {
    const row = manualRow(S.PREG, `rec_mrb2_edit_outside_${logical}`)
    const before = structuredClone(row)
    const res = await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'X', [ph(S.PREG, logical)]: 'SYN' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE')
    expect(res.body.error.fieldIds).toEqual([ph(S.PREG, logical)])
    expect(fake.records.get(row.id)).toEqual(before)
  })

  it.each([
    ['a PLM row', 'rec_mrb2_edit_plm', null, JSON.stringify({ projectNo: MR_PROJECT_NO, componentSourceId: 'SYN', parentSourceId: null, path: '["SYN"]' })],
    ['a prefix row whose key names another row', 'rec_mrb2_edit_other', WRITER.id, 'manual:v1:rec_mrb2_someone_else'],
    ['the own key without a creator', 'rec_mrb2_edit_nocreator', null, undefined],
    ['the own key with a whitespace-only creator', 'rec_mrb2_edit_wscreator', '   ', undefined],
  ])('E-03 %s is not a manual row: 409 STOCK_PREP_MANUAL_ROW_REQUIRED / not_manual_row', async (_label, id, createdBy, key) => {
    const row = manualRow(S.PREG, id as string, createdBy as string | null, (key as string | undefined) ?? `manual:v1:${id}`)
    const before = structuredClone(row)
    const res = await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'X' })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error).toMatchObject({ code: 'STOCK_PREP_MANUAL_ROW_REQUIRED', details: { reason: 'not_manual_row' } })
    expect(fake.records.get(row.id)).toEqual(before)
  })

  it.each([
    ['名称 to empty', 'componentName', ''],
    ['名称 to blank', 'componentName', '   '],
    ['名称 to null', 'componentName', null],
    ['总用量 to null', 'totalQuantity', null],
  ])('E-04 clearing %s: 422, nothing written', async (_label, logical, value) => {
    const row = manualRow(S.PREG, `rec_mrb2_edit_clear_${logical}_${String(value).length}`)
    const before = structuredClone(row)
    const res = await editRow(row.id, { [ph(S.PREG, logical)]: value })
    expect(res.status).toBe(422)
    expect(Object.keys(res.body.error.fieldErrors)).toEqual([ph(S.PREG, logical)])
    expect(fake.records.get(row.id)).toEqual(before)
  })

  it('E-05 clearing a clearable fillable column (规格) is fine', async () => {
    const row = manualRow(S.PREG, 'rec_mrb2_edit_clear_spec')
    expect((await editRow(row.id, { [ph(S.PREG, 'componentSpec')]: '' })).status).toBe(200)
  })

  it.each([
    ['ARCHIVED', 'an archived project'],
    ['DISABLED', 'the switch off'],
    ['JUNK', 'a junk switch value'],
  ])('E-06 %s (%s) does not stop an edit of an existing manual row (§4, §6)', async (key) => {
    const row = manualRow(S[key], `rec_mrb2_edit_${key}`)
    expect((await editRow(row.id, { [ph(S[key], 'componentName')]: 'Edited' })).status).toBe(200)
  })

  it('E-07 the deployment switch off does not stop an edit either', async () => {
    const row = manualRow(S.PREG, 'rec_mrb2_edit_flagoff')
    delete process.env[MR_SWITCH]
    expect((await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'Edited' })).status).toBe(200)
  })

  it.each([
    ['OTHERPLUGIN', 'not_project_sheet'],
    ['ENV', 'not_project_sheet'],
    ['NO087', 'not_project_sheet'],
    ['NOLOCK', 'lock_missing'],
    ['TWOKEYS', 'contract_mismatch'],
    ['KEYMOVED', 'contract_mismatch'],
  ])('E-08 %s: 409 %s, nothing written (a manual-shaped row there is not editable through this route)', async (key, reason) => {
    const row = manualRow(S[key], `rec_mrb2_edit_gate_${key}`)
    const before = structuredClone(row)
    const res = await editRow(row.id, { [ph(S[key], 'componentName')]: 'X' })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error.details).toEqual({ reason })
    expect(fake.records.get(row.id)).toEqual(before)
  })

  it('E-09 a reader is refused 403; a writer whose field_permissions make 名称 read-only is refused 403', async () => {
    const row = manualRow(S.PREG, 'rec_mrb2_edit_perm')
    actor = READER
    expect((await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'X' })).status).toBe(403)
    actor = WRITER
    fake.fieldPermissions.push({ sheetId: S.PREG.sheetId, fieldId: ph(S.PREG, 'componentName'), userId: WRITER.id, visible: true, readOnly: true })
    expect((await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'X' })).status).toBe(403)
    expect(fake.records.get(row.id)!.data[ph(S.PREG, 'componentName')]).toBe('SYN')
  })

  it('E-10 M is re-checked inside the write transaction: the key changed in between → 409 not_manual_row, nothing written', async () => {
    const row = manualRow(S.PREG, 'rec_mrb2_edit_race')
    fake.setOnRecordLockForUpdate((record) => { record.data[ph(S.PREG, 'idempotencyKey')] = 'manual:v1:rec_mrb2_someone_else' })
    const res = await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'X' })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error.details).toEqual({ reason: 'not_manual_row' })
    expect(fake.records.get(row.id)!.data[ph(S.PREG, 'componentName')]).toBe('SYN')
  })

  it('E-11 a version conflict answers 409 VERSION_CONFLICT (the drawer reloads), nothing written', async () => {
    const row = manualRow(S.PREG, 'rec_mrb2_edit_version')
    const res = await editRow(row.id, { [ph(S.PREG, 'componentName')]: 'X' }, { expectedVersion: 7 })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('VERSION_CONFLICT')
    expect(fake.records.get(row.id)!.version).toBe(1)
  })

  it('E-12 /patch and PATCH /records are NOT changed: on the same manual row the six stay locked there (403 FIELD_READONLY_PLM_SYSTEM)', async () => {
    const row = manualRow(S.PREG, 'rec_mrb2_edit_generic')
    const bulk = await http().post('/api/multitable/patch').send({ sheetId: S.PREG.sheetId, changes: [{ recordId: row.id, fieldId: ph(S.PREG, 'componentName'), value: 'X' }] })
    expect(bulk.status).toBe(403)
    expect(bulk.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
    const single = await http().patch(`/api/multitable/records/${row.id}`).send({ sheetId: S.PREG.sheetId, data: { [ph(S.PREG, 'componentName')]: 'X' } })
    expect(single.status).toBe(403)
    expect(single.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
    expect(fake.records.get(row.id)!.data[ph(S.PREG, 'componentName')]).toBe('SYN')
  })

  it('E-13 session requests only', async () => {
    const row = manualRow(S.PREG, 'rec_mrb2_edit_token')
    const res = await http().patch(`/api/multitable/records/${row.id}/manual-fields`).set({ authorization: 'Bearer mst_synthetic_token' }).send({ data: { [ph(S.PREG, 'componentName')]: 'X' } })
    expect(res.status).toBe(401)
  })
})

// ── X. GET /context ──────────────────────────────────────────────────────────────────────────────────────

describe('X — GET /context: capabilities.stockPreparationManualRows', () => {
  const block = async (sheet: FakeSheet) => {
    const res = await context(sheet)
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    return res.body.data.capabilities.stockPreparationManualRows
  }

  it('X-01 allowed on a P_reg sheet: the six fillable ids (template order), the create\'s required ids (名称, 总用量) and (B3) the dialog\'s columns', async () => {
    expect(await block(S.PREG)).toEqual({
      state: 'allowed',
      editableFieldIds: ['componentCode', 'componentName', 'componentSpec', 'material', 'rawQuantity', 'totalQuantity'].map((l) => ph(S.PREG, l)),
      requiredFieldIds: [ph(S.PREG, 'componentName'), ph(S.PREG, 'totalQuantity')],
      // ADR §8 B3.3: 名称*、总用量*、图号、规格、材质、用量、备注.
      dialogFieldIds: ['componentName', 'totalQuantity', 'componentCode', 'componentSpec', 'material', 'rawQuantity', 'notes'].map((l) => ph(S.PREG, l)),
    })
  })

  it.each([
    ['ALLOWED', { state: 'allowed' }],
    ['DISABLED', { state: 'disabled' }],
    ['JUNK', { state: 'disabled' }],
    ['NULLPOLICY', { state: 'disabled' }],
    ['ARCHIVED', { state: 'unavailable', reason: 'project_archived' }],
    ['NOLOCK', { state: 'unavailable', reason: 'lock_missing' }],
    ['KEYLOCKONLY', { state: 'unavailable', reason: 'lock_missing' }],
    ['MISMATCH', { state: 'unavailable', reason: 'contract_mismatch' }],
    ['TWOKEYS', { state: 'unavailable', reason: 'contract_mismatch' }],
    ['KEYMOVED', { state: 'unavailable', reason: 'contract_mismatch' }],
  ])('X-02 %s: %j', async (key, expected) => {
    expect(await block(S[key])).toMatchObject(expected)
  })

  it('X-03 deployment switch off: unavailable / project_sheets_off', async () => {
    delete process.env[MR_SWITCH]
    expect(await block(S.PREG)).toMatchObject({ state: 'unavailable', reason: 'project_sheets_off' })
  })

  it('X-04 a registry that cannot be read: unavailable / registry_unreadable (fail closed — the load itself still answers 200)', async () => {
    fake.failures.target = { code: '42501', message: 'synthetic: permission denied' }
    expect(await block(S.PREG)).toEqual({ state: 'unavailable', reason: 'registry_unreadable', editableFieldIds: [], requiredFieldIds: [], dialogFieldIds: [] })
    fake.failures.target = null
    fake.failures.hostRegistry = { code: '08006', message: 'synthetic: connection failure' }
    const res = await context(S.PREG)
    // The host registry also feeds the resolver's own clamp; whatever it answers, it never answers a block that allows.
    if (res.status === 200) expect(res.body.data.capabilities.stockPreparationManualRows?.state ?? 'absent').not.toBe('allowed')
  })

  it.each(['NO087', 'ENV', 'FOREIGN', 'OTHERPLUGIN', 'COPY', 'PLAIN'])('X-05 %s is not P_reg: no key at all', async (key) => {
    const res = await context(S[key])
    expect(res.status).toBe(200)
    expect('stockPreparationManualRows' in res.body.data.capabilities).toBe(false)
  })

  it('X-06 a reader (no create / edit / delete) gets no key and costs no plugin registry statement', async () => {
    actor = READER
    const res = await context(S.PREG)
    expect(res.status).toBe(200)
    expect('stockPreparationManualRows' in res.body.data.capabilities).toBe(false)
    expect(fake.statements(/integration_stock_prep_project_target/)).toEqual([])
  })

  it('X-07 an ordinary sheet issues neither registry statement for the block', async () => {
    await context(S.PLAIN)
    expect(fake.statements(/integration_stock_prep_project_target/)).toEqual([])
  })

  it('X-08 the block sits right after canCopySheet in the capabilities object', async () => {
    const res = await context(S.PREG)
    const keys = Object.keys(res.body.data.capabilities)
    expect(keys.indexOf('stockPreparationManualRows')).toBe(keys.indexOf('canCopySheet') + 1)
  })

  it('X-09 the plugin name of the host registry row matters: the same sheet re-registered by another plugin gets no key', async () => {
    S.PREG.plugin = 'plugin-other-synthetic'
    const res = await context(S.PREG)
    expect('stockPreparationManualRows' in res.body.data.capabilities).toBe(false)
    S.PREG.plugin = MR_PLUGIN
  })
})
