/**
 * 批次标识 BI-5b — the manual-row band stamp through the REAL univer-meta router and record services, on B2's stateful
 * fake Postgres (tests/utils/stock-prep-manual-rows-fake-pg.ts). Design batch-id §4.1, ADR §5.5, R-65 (C1, C10).
 *
 *   BC-01 a manual row on a sheet that carries the band gets the marker's label in BOTH band cells, in the one INSERT;
 *         the English label too; the pull-batch switch is not consulted.
 *   BC-02 a sheet WITHOUT the band: the INSERT carries exactly today's keys (the inputs + the three stamps), nothing else.
 *   BC-03 a forged band (the marker on two columns WITHOUT the lock): no band cell is written.
 *   BC-04 a submitted band value on a manual row stays refused: 403 FIELD_READONLY_PLM_SYSTEM, nothing written.
 *   BC-05 复制为新行: the source's band cells are not copied, the copy gets the label.
 *   BC-06 the GENERIC create on a sheet with the band (not a manual row) writes no band cell.
 *   BC-07 fail-soft: one band column, or two with different labels ⇒ the row is still created, without band cells.
 *
 * Mock pool, no DB; one pinned listener (`request(app)` is banned in tests/unit, #4154). Every value is synthetic.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'
import {
  MR_PROJECT_ID,
  MR_SWITCH,
  createManualRowsFakePool,
  physicalOf,
  type FakeSheet,
} from '../utils/stock-prep-manual-rows-fake-pg'

const fake = createManualRowsFakePool()
const WRITER = { id: 'u_bim_writer', roles: ['member'], perms: ['multitable:read', 'multitable:write'] }
let app: Express

const KEY = 'stockPreparationPullBatch'
const ZH = '人工补充'
const EN = 'Manual row'
const PULL_SWITCH = 'STOCK_PREP_PULL_BATCH_ENABLED'
const P = (n: number) => `plm_stock_preparation_sandbox_p_${(0xb1 * 0x100 + n).toString(16).padStart(24, '0')}`

type Extra = { id: string; name: string; type: string; property: Record<string, unknown> }
const bandIds = (objectId: string) => [
  physicalOf({ projectId: MR_PROJECT_ID, objectId }, 'firstPullBatch'),
  physicalOf({ projectId: MR_PROJECT_ID, objectId }, 'pullBatch'),
] as const
function band(objectId: string, labels: Array<string | null>, { lock = true }: { lock?: boolean } = {}): Extra[] {
  const ids = bandIds(objectId)
  return labels.map((label, i) => ({
    id: ids[i],
    name: i === 0 ? 'First Pull Batch' : 'Pull Batch',
    type: 'string',
    property: {
      ...(lock ? { humanWriteLock: 'plm_system' } : {}),
      ...(label === null ? {} : { [KEY]: { band: 'v1', manualLabel: label } }),
    },
  }))
}

type Sheets = Record<'BAND' | 'BAND_EN' | 'PREG' | 'FORGED' | 'ONE' | 'MIXED' | 'PLAIN_BAND', FakeSheet>
let S: Sheets
function seedSheets(): Sheets {
  fake.reset()
  return {
    BAND: fake.addSheet('BAND', { objectId: P(1), extra: band(P(1), [ZH, ZH]) }),
    BAND_EN: fake.addSheet('BAND_EN', { objectId: P(2), extra: band(P(2), [EN, EN]) }),
    PREG: fake.addSheet('PREG', { objectId: P(3) }),
    FORGED: fake.addSheet('FORGED', { objectId: P(4), extra: band(P(4), [ZH, ZH], { lock: false }) }),
    ONE: fake.addSheet('ONE', { objectId: P(5), extra: band(P(5), [ZH]) }),
    MIXED: fake.addSheet('MIXED', { objectId: P(6), extra: band(P(6), [ZH, EN]) }),
    // An ordinary sheet (no stock-prep stanza, no lock on the template columns) that still carries a band: the generic
    // create path is open on it.
    PLAIN_BAND: fake.addSheet('PLAIN_BAND', { objectId: P(7), noStanza: true, locked: 'none', extra: band(P(7), [ZH, ZH]) }),
  }
}

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
    ;(req as express.Request & { user?: unknown }).user = WRITER
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
const ph = (sheet: FakeSheet, logical: string) => fake.phys(sheet, logical)
const recordsOf = (sheet: FakeSheet) => [...fake.records.values()].filter((r) => r.sheet_id === sheet.sheetId)
const createRow = (sheet: FakeSheet, data: Record<string, unknown>) =>
  http().post(`/api/multitable/sheets/${sheet.sheetId}/manual-rows`).send({ data })
const minimal = (sheet: FakeSheet, extra: Record<string, unknown> = {}) => ({
  [ph(sheet, 'componentName')]: 'Synthetic manual part',
  [ph(sheet, 'totalQuantity')]: 3,
  ...extra,
})
/** The JSON `data` of the one manual-row INSERT this test issued (what reached Postgres). */
function insertedData(): Record<string, unknown> {
  const inserts = fake.sqlLog.filter((entry) => entry.sql.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO meta_records (id, sheet_id, data'))
  expect(inserts).toHaveLength(1)
  return JSON.parse(String(inserts[0].params[2]))
}

const SWITCH_BEFORE = process.env[MR_SWITCH]
const PULL_SWITCH_BEFORE = process.env[PULL_SWITCH]

beforeAll(async () => {
  app = await buildApp()
}, 120_000)

beforeEach(() => {
  S = seedSheets()
  process.env[MR_SWITCH] = 'true'
  delete process.env[PULL_SWITCH]
})

afterEach(() => {
  if (SWITCH_BEFORE === undefined) delete process.env[MR_SWITCH]
  else process.env[MR_SWITCH] = SWITCH_BEFORE
  if (PULL_SWITCH_BEFORE === undefined) delete process.env[PULL_SWITCH]
  else process.env[PULL_SWITCH] = PULL_SWITCH_BEFORE
})

describe('BC — the manual-row band stamp', () => {
  it.each([
    ['unset', undefined],
    ["'true'", 'true'],
    ["'false'", 'false'],
  ])('BC-01 a band sheet: both band cells = 人工补充 in the one INSERT (pull-batch switch %s)', async (_label, value) => {
    if (value !== undefined) process.env[PULL_SWITCH] = value
    fake.sqlLog.length = 0
    const res = await createRow(S.BAND, minimal(S.BAND))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const id = res.body.data.record.id as string
    const [first, pull] = bandIds(S.BAND.objectId)
    const stored = fake.records.get(id)!
    expect(stored.data[first]).toBe(ZH)
    expect(stored.data[pull]).toBe(ZH)
    expect(stored.data[ph(S.BAND, 'idempotencyKey')]).toBe(`manual:v1:${id}`)
    const inserted = insertedData()
    expect(inserted[first]).toBe(ZH)
    expect(inserted[pull]).toBe(ZH)
  })

  it('BC-01b the English marker label is written as is', async () => {
    const res = await createRow(S.BAND_EN, minimal(S.BAND_EN))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = fake.records.get(res.body.data.record.id)!
    for (const id of bandIds(S.BAND_EN.objectId)) expect(stored.data[id]).toBe(EN)
  })

  it('BC-02 a sheet without the band: the INSERT carries exactly the inputs + the three stamps', async () => {
    fake.sqlLog.length = 0
    const res = await createRow(S.PREG, minimal(S.PREG, { [ph(S.PREG, 'notes')]: 'synthetic note' }))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const id = res.body.data.record.id as string
    expect(insertedData()).toEqual({
      [ph(S.PREG, 'componentName')]: 'Synthetic manual part',
      [ph(S.PREG, 'totalQuantity')]: 3,
      [ph(S.PREG, 'notes')]: 'synthetic note',
      [ph(S.PREG, 'projectNo')]: fake.records.get(id)!.data[ph(S.PREG, 'projectNo')],
      [ph(S.PREG, 'idempotencyKey')]: `manual:v1:${id}`,
      [ph(S.PREG, 'active')]: true,
    })
  })

  it('BC-03 a forged band (the marker on two columns, no lock): no band cell', async () => {
    const res = await createRow(S.FORGED, minimal(S.FORGED))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = fake.records.get(res.body.data.record.id)!
    for (const id of bandIds(S.FORGED.objectId)) expect(id in stored.data).toBe(false)
  })

  it.each([0, 1])('BC-04 a submitted band value (column %i) answers 403 FIELD_READONLY_PLM_SYSTEM; nothing written', async (index) => {
    const fieldId = bandIds(S.BAND.objectId)[index]
    const res = await createRow(S.BAND, minimal(S.BAND, { [fieldId]: '第9批' }))
    expect(res.status, JSON.stringify(res.body)).toBe(403)
    expect(res.body.error.code).toBe('FIELD_READONLY_PLM_SYSTEM')
    expect(res.body.error.fieldIds).toEqual([fieldId])
    expect(recordsOf(S.BAND)).toEqual([])
  })

  it('BC-05 复制为新行: the source band cells are not copied; the copy gets the label', async () => {
    const [first, pull] = bandIds(S.BAND.objectId)
    const source = fake.addRecord(S.BAND, 'rec_bim_copy_source', {
      componentName: 'Synthetic part', totalQuantity: 4, componentCode: 'SYN-DRAWING-X', active: true,
    }, null, { [first]: '第1批（2026-11-01）', [pull]: '第2批（2026-11-05）' })
    const res = await http().post(`/api/multitable/records/${source.id}/manual-copy`).send({})
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const copy = fake.records.get(res.body.data.record.id)!
    expect(copy.data[first]).toBe(ZH)
    expect(copy.data[pull]).toBe(ZH)
    expect(copy.data[ph(S.BAND, 'componentCode')]).toBe('SYN-DRAWING-X')
    expect(fake.records.get(source.id)!.data[first]).toBe('第1批（2026-11-01）')
  })

  it('BC-06 the generic create on a sheet with the band (not a manual row) writes no band cell', async () => {
    // The template's required columns (unlocked on this ordinary sheet), so the generic create can land.
    const data: Record<string, unknown> = {}
    for (const [logical, value] of Object.entries({
      projectNo: 'SYN-P-07', idempotencyKey: 'SYN-KEY-X', componentSourceId: 'SYN-PART-X', path: '["SYN-PART-X"]',
      totalQuantity: 1, active: true, notes: 'synthetic note',
    })) data[ph(S.PLAIN_BAND, logical)] = value
    const res = await http().post('/api/multitable/records').send({ sheetId: S.PLAIN_BAND.sheetId, data })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = recordsOf(S.PLAIN_BAND)
    expect(stored).toHaveLength(1)
    for (const id of bandIds(S.PLAIN_BAND.objectId)) expect(id in stored[0].data).toBe(false)
  })

  it.each([
    ['one band column', 'ONE'],
    ['two band columns with different labels', 'MIXED'],
  ] as const)('BC-07 fail-soft, %s: the manual row is created without band cells', async (_label, key) => {
    const sheet = S[key]
    const res = await createRow(sheet, minimal(sheet))
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const stored = fake.records.get(res.body.data.record.id)!
    for (const id of bandIds(sheet.objectId)) expect(id in stored.data).toBe(false)
  })
})
