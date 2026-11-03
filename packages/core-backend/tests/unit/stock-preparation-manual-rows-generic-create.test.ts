/**
 * 人工补充行 B3 (ADR adr-stock-prep-manual-rows-20261030 §3.1, §8 「B3」 1) — the state-wise refusal of GENERIC create on a
 * registered project sheet (P_reg), over the real univer-meta router and the real record services, on B2's stateful fake
 * Postgres (tests/utils/stock-prep-manual-rows-fake-pg.ts: the plugin's own template, physical ids derived as the host
 * derives them, both registries).
 *
 *   G-01 POST /records on every P_reg state: 409 (503 registry_unreadable) with the §3.1 code / text / details, refused
 *        BEFORE createRecord (no create statement, no row); only `allowed` points at 「新增人工补充行」.
 *   G-02 the same table through POST /sheets/:sheetId/import-xlsx.
 *   G-03 the refusal names the SAME state /context's block reports, sheet by sheet.
 *   G-04 every other sheet keeps its old answer (provisioned without a plugin registry row = PB-05's shape, the env
 *        table, another plugin, a copy, a sheet without the stanza), and a sheet without the stanza costs no registry
 *        statement for it.
 *   G-05 an actor who cannot create keeps createRecord's own 403 (the refusal is asked for creators only).
 *   G-06 a platform administrator whose host registry read fails: 503 registry_unreadable (fail closed).
 *   G-07 the pure pieces: the code / status table, and an id outside the plugin-derived sheet-id shape issues no
 *        statement at all (the R-66 ② prefilter).
 *   G-08 structure: both route handlers call the refusal before their createRecord call (POST /records is ONE handler
 *        for session and `mst_` token requests).
 *
 * Mock pool, no DB; one pinned listener (`request(app)` is banned in tests/unit, #4154). Every value is synthetic.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import {
  MR_ENV_OBJECT,
  MR_SWITCH,
  createManualRowsFakePool,
  type FakeSheet,
} from '../utils/stock-prep-manual-rows-fake-pg'
import {
  GENERIC_CREATE_USE_MANUAL_ROW_MESSAGE,
  MANUAL_ROWS_HOST_REGISTRY_SQL,
  MANUAL_ROWS_REFUSAL_MESSAGES,
  STOCK_PREP_MANUAL_ROWS_DISABLED_CODE,
  STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE,
  STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW_CODE,
  genericCreateRefusalOf,
  resolveGenericCreateRefusal,
  type ManualRowsVerdict,
} from '../../src/multitable/stock-preparation-manual-rows-gate'
import { buildXlsxBuffer, type XlsxModule } from '../../src/multitable/xlsx-service'

const fake = createManualRowsFakePool()
const xlsx = await import('xlsx') as unknown as XlsxModule

const WRITER = { id: 'u_mrb3_writer', roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
const ADMIN = { id: 'u_mrb3_admin', roles: ['admin'], perms: [] as string[] }
const READER = { id: 'u_mrb3_reader', roles: ['member'], perms: ['multitable:read'] }
let actor: { id: string; roles: string[]; perms: string[] } = WRITER
let app: Express

const P = (n: number) => `plm_stock_preparation_sandbox_p_${n.toString(16).padStart(24, '0')}`

function keyMoved(sheet: FakeSheet): FakeSheet {
  const key = sheet.fields.find((field) => field.id === fake.phys(sheet, 'idempotencyKey'))!
  ;(key.property.stockPreparation as Record<string, unknown>).key = false
  return sheet
}

type Sheets = Record<string, FakeSheet>
let S: Sheets

function seedSheets(): Sheets {
  fake.reset()
  return {
    PREG: fake.addSheet('PREG', { objectId: P(1) }),
    ALLOWED: fake.addSheet('ALLOWED', { objectId: P(2), policy: 'allowed' }),
    DISABLED: fake.addSheet('DISABLED', { objectId: P(3), policy: 'disabled' }),
    JUNK: fake.addSheet('JUNK', { objectId: P(4), policy: 'nope' }),
    ARCHIVED: fake.addSheet('ARCHIVED', { objectId: P(6), target: { status: 'archived' } }),
    NOLOCK: fake.addSheet('NOLOCK', { objectId: P(7), locked: 'none' }),
    KEYLOCKONLY: fake.addSheet('KEYLOCKONLY', { objectId: P(8), locked: ['idempotencyKey'] }),
    NO087: fake.addSheet('NO087', { objectId: P(9), target: null }),
    ENV: fake.addSheet('ENV', { objectId: MR_ENV_OBJECT, target: null }),
    OTHERPLUGIN: fake.addSheet('OTHERPLUGIN', { objectId: P(10), plugin: 'plugin-other-synthetic' }),
    MISMATCH: fake.addSheet('MISMATCH', { objectId: P(11), target: { status: 'active', objectId: P(12) } }),
    BADROW: fake.addSheet('BADROW', { objectId: P(13), target: { status: 'active', projectNo: '   ' } }),
    TWOKEYS: fake.addSheet('TWOKEYS', { objectId: P(14), secondKey: true }),
    KEYMOVED: keyMoved(fake.addSheet('KEYMOVED', { objectId: P(18), secondKey: true })),
    COPY: fake.addSheet('COPY', { objectId: P(16), plugin: null, target: null }),
    PLAIN: fake.addSheet('PLAIN', { objectId: P(17), noStanza: true, locked: 'none' }),
  }
}

const ph = (sheet: FakeSheet, logical: string) => fake.phys(sheet, logical)
const recordsOf = (sheet: FakeSheet) => [...fake.records.values()].filter((r) => r.sheet_id === sheet.sheetId)
const createStatements = () => fake.statements(/^INSERT INTO meta_records /)

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
/** A body the generic route would otherwise take: 名称 + 总用量 + a human column. */
const genericBody = (sheet: FakeSheet) => ({
  [ph(sheet, 'componentName')]: 'Synthetic generic part',
  [ph(sheet, 'totalQuantity')]: 3,
  [ph(sheet, 'notes')]: 'synthetic note',
})
const postRecord = (sheet: FakeSheet, data: Record<string, unknown> = genericBody(sheet)) =>
  http().post('/api/multitable/records').send({ sheetId: sheet.sheetId, data })
const importXlsx = (sheet: FakeSheet) => {
  // Headers name the sheet's own columns (the auto-mapping matches by field name); one data row.
  const names = ['componentName', 'totalQuantity', 'notes'].map((logical) => sheet.fields.find((f) => f.id === ph(sheet, logical))!.name)
  const buffer = buildXlsxBuffer(xlsx, { sheetName: 'Rows', headers: names, rows: [['Synthetic imported part', 2, 'synthetic note']] })
  return http().post(`/api/multitable/sheets/${sheet.sheetId}/import-xlsx`).attach('file', buffer, 'rows.xlsx')
}
const context = (sheet: FakeSheet) => http().get('/api/multitable/context').query({ sheetId: sheet.sheetId })

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

type Expected = { status: number; code: string; details: Record<string, string>; message: string }
const ALLOWED_REFUSAL: Expected = {
  status: 409,
  code: STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW_CODE,
  details: { state: 'allowed' },
  message: GENERIC_CREATE_USE_MANUAL_ROW_MESSAGE,
}
const unavailable = (reason: keyof typeof MANUAL_ROWS_REFUSAL_MESSAGES, status = 409): Expected => ({
  status,
  code: STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE,
  details: { state: 'unavailable', reason },
  message: MANUAL_ROWS_REFUSAL_MESSAGES[reason],
})
const DISABLED_REFUSAL: Expected = {
  status: 409,
  code: STOCK_PREP_MANUAL_ROWS_DISABLED_CODE,
  details: { state: 'disabled', reason: 'disabled' },
  message: MANUAL_ROWS_REFUSAL_MESSAGES.disabled,
}

/** ADR §3.1's table, sheet by sheet (the deployment switch and an unreadable registry are set up per case). */
const TABLE: Array<[string, Expected]> = [
  ['PREG', ALLOWED_REFUSAL],
  ['ALLOWED', ALLOWED_REFUSAL],
  ['DISABLED', DISABLED_REFUSAL],
  ['JUNK', DISABLED_REFUSAL],
  ['ARCHIVED', unavailable('project_archived')],
  ['NOLOCK', unavailable('lock_missing')],
  ['KEYLOCKONLY', unavailable('lock_missing')],
  ['MISMATCH', unavailable('contract_mismatch')],
  ['BADROW', unavailable('contract_mismatch')],
  ['TWOKEYS', unavailable('contract_mismatch')],
  ['KEYMOVED', unavailable('contract_mismatch')],
]

function expectRefused(res: request.Response, expected: Expected, label: string): void {
  expect(res.status, `${label}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(expected.status)
  expect(res.body).toEqual({ ok: false, error: { code: expected.code, message: expected.message, details: expected.details } })
}

describe('G-01 POST /records on a P_reg sheet: refused by state, before createRecord', () => {
  it.each(TABLE)('%s', async (key, expected) => {
    const sheet = S[key]
    const before = recordsOf(sheet).length
    const res = await postRecord(sheet)
    expectRefused(res, expected, key)
    expect(recordsOf(sheet)).toHaveLength(before)
    expect(createStatements(), 'createRecord must not be reached').toHaveLength(0)
  })

  it('the deployment switch off (not exactly \'true\'): unavailable / project_sheets_off', async () => {
    process.env[MR_SWITCH] = 'TRUE'
    expectRefused(await postRecord(S.PREG), unavailable('project_sheets_off'), 'switch TRUE')
    delete process.env[MR_SWITCH]
    expectRefused(await postRecord(S.PREG), unavailable('project_sheets_off'), 'switch absent')
    expect(createStatements()).toHaveLength(0)
  })

  it('the plugin registry unreadable (any SQLSTATE but 42P01): 503 registry_unreadable, nothing written', async () => {
    fake.failures.target = { code: '42501', message: 'synthetic: permission denied' }
    expectRefused(await postRecord(S.PREG), unavailable('registry_unreadable', 503), 'target 42501')
    expect(createStatements()).toHaveLength(0)
  })

  it('42P01 (the plugin registry table is not there) = not registered: the old answer, not a refusal', async () => {
    fake.failures.target = { code: '42P01', message: 'synthetic: relation does not exist' }
    const res = await postRecord(S.PREG)
    expect(res.body?.error?.code).not.toBe(STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW_CODE)
    expect(res.body?.error?.code).not.toBe(STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE)
    // The locked 名称 column refuses the generic write, as on every locked sheet before B3.
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(403)
    expect(res.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
  })

  it('the manual-row route keeps working on the same sheet (the refusal only closes the generic door)', async () => {
    expectRefused(await postRecord(S.PREG), ALLOWED_REFUSAL, 'generic')
    const manual = await http().post(`/api/multitable/sheets/${S.PREG.sheetId}/manual-rows`).send({
      data: { [ph(S.PREG, 'componentName')]: 'Synthetic manual part', [ph(S.PREG, 'totalQuantity')]: 3 },
    })
    expect(manual.status, JSON.stringify(manual.body).slice(0, 300)).toBe(200)
  })
})

describe('G-02 POST /sheets/:sheetId/import-xlsx on a P_reg sheet: the same table, before any row is created', () => {
  it.each(TABLE)('%s', async (key, expected) => {
    const sheet = S[key]
    const res = await importXlsx(sheet)
    expectRefused(res, expected, key)
    expect(recordsOf(sheet)).toHaveLength(0)
    expect(createStatements()).toHaveLength(0)
  })

  it('switch off → project_sheets_off; registry unreadable → 503', async () => {
    process.env[MR_SWITCH] = 'false'
    expectRefused(await importXlsx(S.PREG), unavailable('project_sheets_off'), 'switch false')
    process.env[MR_SWITCH] = 'true'
    fake.failures.target = { code: '57014', message: 'synthetic: canceling statement' }
    expectRefused(await importXlsx(S.PREG), unavailable('registry_unreadable', 503), 'target 57014')
    expect(createStatements()).toHaveLength(0)
  })
})

describe('G-03 the refusal and /context agree on every P_reg sheet', () => {
  it.each(TABLE.map(([key]) => key))('%s', async (key) => {
    const ctx = await context(S[key])
    expect(ctx.status).toBe(200)
    const block = ctx.body.data.capabilities.stockPreparationManualRows as { state: string; reason?: string }
    expect(block, 'a P_reg sheet must carry the block').toBeTruthy()
    const refused = await postRecord(S[key])
    const details = refused.body.error.details as { state: string; reason?: string }
    expect(details.state).toBe(block.state)
    if (block.state === 'unavailable') expect(details.reason).toBe(block.reason)
  })
})

describe('G-04 every other sheet keeps its old answer', () => {
  it.each(['NO087', 'ENV', 'OTHERPLUGIN', 'COPY'])('%s (locked, not P_reg): the generic write of a locked column is still 403 FIELD_READONLY_PLM_SYSTEM', async (key) => {
    const res = await postRecord(S[key])
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(403)
    expect(res.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
  })

  it('NO087 (PB-05\'s shape: provisioned, no plugin registry row): a human-only create still fails the template\'s required rule (422)', async () => {
    const res = await postRecord(S.NO087, { [ph(S.NO087, 'notes')]: 'x' })
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('a sheet without the stanza: no refusal, and no registry statement on its behalf', async () => {
    const res = await postRecord(S.PLAIN, { [ph(S.PLAIN, 'notes')]: 'x' })
    expect(res.body?.error?.code).not.toBe(STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW_CODE)
    expect(res.body?.error?.code).not.toBe(STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE)
    expect(fake.statements(new RegExp(`^${MANUAL_ROWS_HOST_REGISTRY_SQL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))).toHaveLength(0)
    expect(fake.statements(/FROM integration_stock_prep_project_target/)).toHaveLength(0)
  })

  it('the import on a sheet that is not P_reg reaches the per-row create path as before (no refusal body)', async () => {
    const res = await importXlsx(S.NO087)
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200)
    expect(res.body.data.attempted).toBe(1)
    expect(res.body.data.imported).toBe(0)
  })
})

describe('G-05 an actor who cannot create keeps createRecord\'s own 403', () => {
  it('a reader on the P_reg sheet: 403, never the manual-rows refusal, and no plugin registry statement', async () => {
    actor = READER
    const res = await postRecord(S.PREG)
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(403)
    expect(res.body?.error?.code).not.toBe(STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW_CODE)
    expect(fake.statements(/FROM integration_stock_prep_project_target/)).toHaveLength(0)
  })
})

describe('G-06 a platform administrator whose host registry read fails', () => {
  it('503 registry_unreadable (the administrator is not clamped, so the gate\'s own mapping answers)', async () => {
    actor = ADMIN
    fake.failures.hostRegistry = { code: '08006', message: 'synthetic: connection failure' }
    expectRefused(await postRecord(S.PREG), unavailable('registry_unreadable', 503), 'host registry 08006')
    expect(createStatements()).toHaveLength(0)
  })
})

describe('G-07 the pure pieces', () => {
  const sheetStub = {} as never
  it.each([
    [{ kind: 'not_project_sheet' }, null],
    [{ kind: 'allowed', sheet: sheetStub }, [409, STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW_CODE, { state: 'allowed' }]],
    [{ kind: 'disabled', sheet: sheetStub }, [409, STOCK_PREP_MANUAL_ROWS_DISABLED_CODE, { state: 'disabled', reason: 'disabled' }]],
    [{ kind: 'unavailable', reason: 'lock_missing', sheet: null }, [409, STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE, { state: 'unavailable', reason: 'lock_missing' }]],
    [{ kind: 'unavailable', reason: 'project_archived', sheet: null }, [409, STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE, { state: 'unavailable', reason: 'project_archived' }]],
    [{ kind: 'unavailable', reason: 'project_sheets_off', sheet: null }, [409, STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE, { state: 'unavailable', reason: 'project_sheets_off' }]],
    [{ kind: 'unavailable', reason: 'contract_mismatch', sheet: null }, [409, STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE, { state: 'unavailable', reason: 'contract_mismatch' }]],
    [{ kind: 'unavailable', reason: 'registry_unreadable', sheet: null }, [503, STOCK_PREP_MANUAL_ROWS_UNAVAILABLE_CODE, { state: 'unavailable', reason: 'registry_unreadable' }]],
  ])('%j', (verdict, expected) => {
    const refusal = genericCreateRefusalOf(verdict as ManualRowsVerdict)
    if (expected === null) {
      expect(refusal).toBeNull()
      return
    }
    const [status, code, details] = expected as [number, string, Record<string, string>]
    expect(refusal!.status).toBe(status)
    expect(refusal!.code).toBe(code)
    expect(refusal!.body().error.details).toEqual(details)
    // Only `allowed` points at the 新增人工补充行 entry (ADR §3.1).
    expect(refusal!.message.includes('新增人工补充行')).toBe((details as { state: string }).state === 'allowed')
  })

  it('an id outside the plugin-derived shape (every sheet a person creates) issues no statement and loads no field', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const loader = vi.fn(async () => [])
    expect(await resolveGenericCreateRefusal(query, `sheet_${randomUUID()}`, loader)).toBeNull()
    expect(query).not.toHaveBeenCalled()
    expect(loader).not.toHaveBeenCalled()
  })

  it('a derived-shape id whose fields carry no stanza: the field read only, no registry statement', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const loader = vi.fn(async () => [{ id: 'fld_synthetic', property: {} }])
    expect(await resolveGenericCreateRefusal(query, `sheet_${'a'.repeat(24)}`, loader)).toBeNull()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('G-08 structure: the refusal sits in the shared handlers, before their createRecord call', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/routes/univer-meta.ts'), 'utf8')
  const handlerBody = (header: string, next: string): string => {
    const start = source.indexOf(header)
    expect(start, `route header not found: ${header}`).toBeGreaterThan(-1)
    const end = source.indexOf(next, start + header.length)
    expect(end, `next route not found after ${header}`).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it('POST /records: one handler behind apiTokenAuth (session and mst_ tokens), the refusal before recordService.createRecord', () => {
    const body = handlerBody("router.post('/records', apiTokenAuth,", "router.post('/records/:recordId/duplicate'")
    const refusalAt = body.indexOf('resolveGenericCreateRefusal(')
    const createAt = body.indexOf('recordService.createRecord(')
    expect(refusalAt).toBeGreaterThan(-1)
    expect(createAt).toBeGreaterThan(refusalAt)
    expect(source.match(/router\.post\('\/records',/g) ?? []).toHaveLength(1)
  })

  it('POST /sheets/:sheetId/import-xlsx: the refusal before the per-row recordService.createRecord loop', () => {
    const body = handlerBody("router.post('/sheets/:sheetId/import-xlsx'", "router.get('/sheets/:sheetId/export-xlsx'")
    const refusalAt = body.indexOf('resolveGenericCreateRefusal(')
    const createAt = body.indexOf('recordService.createRecord(')
    expect(refusalAt).toBeGreaterThan(-1)
    expect(createAt).toBeGreaterThan(refusalAt)
  })
})
