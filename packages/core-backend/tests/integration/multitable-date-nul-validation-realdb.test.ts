import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import * as XLSX from 'xlsx'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'
import { usePinnedServer } from '../utils/pinned-server'

if (process.env.EXPECT_DB === '1' && !process.env.DATABASE_URL) {
  throw new Error('Date/NUL native acceptance requires DATABASE_URL in the real-DB lane')
}

const prefix = `dnv_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`
const baseId = `${prefix}_base`
const sheetId = `${prefix}_sheet`
const viewId = `${prefix}_view`
const actorId = `${prefix}_user`
const firstRecord = `${prefix}_first`
const secondRecord = `${prefix}_second`
const restoreRecord = `${prefix}_restore`
const field = (name: string) => `${prefix}_${name}`
const publicToken = `${prefix}_public`
const query = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

async function snapshot() {
  const records = await query('SELECT id, data, version FROM meta_records WHERE sheet_id = $1 ORDER BY id', [sheetId])
  const revisions = await query('SELECT count(*)::int AS count FROM meta_record_revisions WHERE sheet_id = $1', [sheetId])
  const sequences = await query('SELECT field_id, next_value FROM meta_field_auto_number_sequences WHERE sheet_id = $1 ORDER BY field_id', [sheetId])
  return { records: records.rows, revisions: revisions.rows, sequences: sequences.rows }
}

async function stored(recordId: string): Promise<Record<string, unknown>> {
  const result = await query('SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
  return (result.rows[0] as { data: Record<string, unknown> }).data
}

function workbook(rows: string[][]): Buffer {
  const document = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(document, XLSX.utils.aoa_to_sheet([['Day', 'Title'], ...rows]), 'Synthetic')
  return XLSX.write(document, { type: 'buffer', bookType: 'xlsx' })
}

const modes = ['create', 'patch', 'batch', 'form-create', 'form-edit'] as const
type Mode = typeof modes[number]

describe.skipIf(!process.env.DATABASE_URL)('date/NUL native PostgreSQL HTTP validation', () => {
  const pinned = usePinnedServer()
  let anonymousClient = 0

  beforeAll(async () => {
    const app = express()
    app.set('trust proxy', 'loopback')
    app.use(express.json())
    app.use((req, _res, next) => {
      if (req.headers['x-date-nul-anonymous'] !== 'true') {
        req.user = { id: actorId, roles: ['member'], perms: ['multitable:read', 'multitable:write', 'multitable:base:read'] }
      }
      next()
    })
    app.use('/api/multitable', univerMetaRouter())
    pinned.setApp(app)
    await query('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [baseId, 'Synthetic date NUL'])
    await query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [sheetId, baseId, 'Synthetic date NUL'])
    await query("INSERT INTO users (id, name, password_hash) VALUES ($1,'Synthetic date NUL','x')", [actorId])
    const fields: Array<[string, string, string, Record<string, unknown>]> = [
      ['day', 'Day', 'date', {}], ['title', 'Title', 'string', {}],
      ['rich', 'Rich', 'longText', { rich: true }], ['location', 'Location', 'location', {}],
      ['when', 'When', 'dateTime', { timezone: 'Asia/Tokyo' }], ['sequence', 'Sequence', 'autoNumber', {}],
    ]
    for (const [order, [name, label, type, property]] of fields.entries()) {
      await query('INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [field(name), sheetId, label, type, JSON.stringify(property), order])
    }
    await query('INSERT INTO meta_views (id,sheet_id,name,type,config) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [viewId, sheetId, 'Synthetic form', 'form', JSON.stringify({ publicForm: { enabled: true, publicToken, accessMode: 'public' } })])
    for (const recordId of [firstRecord, secondRecord]) {
      await query('INSERT INTO meta_records (id,sheet_id,data,version,created_by) VALUES ($1,$2,$3::jsonb,1,$4)',
        [recordId, sheetId, JSON.stringify({ [field('day')]: 'legacy-invalid', [field('title')]: 'before' }), actorId])
    }
  })

  afterAll(async () => {
    await query('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [sheetId])
    await query('DELETE FROM meta_records WHERE sheet_id = $1', [sheetId])
    await query('DELETE FROM meta_views WHERE sheet_id = $1', [sheetId])
    await query('DELETE FROM meta_field_auto_number_sequences WHERE sheet_id = $1', [sheetId])
    await query('DELETE FROM meta_fields WHERE sheet_id = $1', [sheetId])
    await query('DELETE FROM meta_sheets WHERE id = $1', [sheetId])
    await query('DELETE FROM meta_bases WHERE id = $1', [baseId])
    await query('DELETE FROM users WHERE id = $1', [actorId])
    expect((await query('SELECT id FROM meta_sheets WHERE id = $1', [sheetId])).rows).toEqual([])
  })

  function write(mode: Mode, data: Record<string, unknown>) {
    const client = request(pinned.url())
    if (mode === 'create') return client.post('/api/multitable/records').send({ sheetId, data })
    if (mode === 'patch') return client.patch(`/api/multitable/records/${firstRecord}`).send({ sheetId, data })
    if (mode === 'batch') {
      return client.post('/api/multitable/patch').send({ sheetId, changes: [
        { recordId: firstRecord, fieldId: field('title'), value: 'first row must be atomic' },
        ...Object.entries(data).map(([fieldId, value]) => ({ recordId: secondRecord, fieldId, value })),
      ] })
    }
    return mode === 'form-create'
      ? client.post(`/api/multitable/views/${viewId}/submit`).set('x-date-nul-anonymous', 'true')
        .set('X-Forwarded-For', `192.0.2.${++anonymousClient}`).send({ publicToken, data })
      : client.post(`/api/multitable/views/${viewId}/submit`).send({ recordId: firstRecord, data })
  }

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['not a date', { [field('day')]: 'not-a-date' }],
    ['non-leap day', { [field('day')]: '2026-02-29' }],
    ['rollover timestamp', { [field('day')]: '2024-02-30T12:00:00Z' }],
    ['NUL text', { [field('title')]: 'before\u0000after' }],
    ['nested NUL value', { [field('location')]: { address: 'safe', extra: [{ value: '\u0000' }] } }],
    ['nested NUL property key', { [field('location')]: { address: 'safe', extra: [{ ['key\u0000']: 'safe' }] } }],
    ['NUL rich HTML', { [field('rich')]: '<p>before\u0000after</p>' }],
  ]

  test('real-DB lane sentinel', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  describe.each(modes)('%s', (mode) => {
    test.each(invalid)('rejects %s with typed 400 and no persisted changes', async (_label, data) => {
      const before = await snapshot()
      const response = await write(mode, data)
      expect(response.status, JSON.stringify(response.body)).toBe(400)
      expect(response.body.error.code).toBe('VALIDATION_ERROR')
      expect(await snapshot()).toEqual(before)
    })

    test.each(['2024-02-29', '2000-02-29', '', null])('persists supported date %j and safe strings', async (day) => {
      const data = { [field('day')]: day, [field('title')]: '中文\\u0000\n', [field('rich')]: '<p>safe</p>' }
      const before = await snapshot()
      const response = await write(mode, data)
      expect(response.status, JSON.stringify(response.body)).toBe(200)
      expect(response.body.ok).toBe(true)
      const after = await snapshot()
      if (mode === 'create' || mode === 'form-create') {
        const oldIds = new Set((before.records as Array<{ id: string }>).map((row) => row.id))
        const added = (after.records as Array<{ id: string }>).filter((row) => !oldIds.has(row.id))
        expect(added).toHaveLength(1)
        expect(await stored(added[0].id)).toMatchObject(data)
      } else {
        expect(await stored(mode === 'batch' ? secondRecord : firstRecord)).toMatchObject(data)
      }
      expect((after.revisions[0] as { count: number }).count).toBeGreaterThan((before.revisions[0] as { count: number }).count)
    })
  })

  test('the real anonymous rate limiter still refuses request eleven for one fixture client', async () => {
    const before = await snapshot()
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const response = await request(pinned.url()).post(`/api/multitable/views/${viewId}/submit`)
        .set('x-date-nul-anonymous', 'true').set('X-Forwarded-For', '192.0.2.250')
        .send({ publicToken, data: { [field('day')]: '2026-02-29' } })
      expect(response.status).toBe(attempt <= 10 ? 400 : 429)
      expect(response.body.error.code).toBe(attempt <= 10 ? 'VALIDATION_ERROR' : 'RATE_LIMITED')
    }
    expect(await snapshot()).toEqual(before)
  })

  test('XLSX import refuses invalid calendar and NUL rows without persistence', async () => {
    const before = await snapshot()
    const response = await request(pinned.url()).post(`/api/multitable/sheets/${sheetId}/import-xlsx`)
      .attach('file', workbook([['2026-02-29', 'bad date'], ['2024-02-29', 'before\u0000after']]), 'synthetic.xlsx')
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.data).toMatchObject({ attempted: 2, imported: 0, failed: 2 })
    expect(response.body.data.failures.map((failure: { code: string }) => failure.code)).toEqual(['VALIDATION_ERROR', 'VALIDATION_ERROR'])
    expect(await snapshot()).toEqual(before)
  })

  test('XLSX import accepts valid leap and empty dates', async () => {
    const response = await request(pinned.url()).post(`/api/multitable/sheets/${sheetId}/import-xlsx`)
      .attach('file', workbook([['2024-02-29', 'safe\\u0000'], ['', 'safe empty']]), 'synthetic.xlsx')
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.data).toMatchObject({ attempted: 2, imported: 2, failed: 0 })
    const [first, second] = response.body.data.createdRecordIds as string[]
    expect(await stored(first)).toMatchObject({ [field('day')]: '2024-02-29', [field('title')]: 'safe\\u0000' })
    expect(await stored(second)).toMatchObject({ [field('day')]: '', [field('title')]: 'safe empty' })
  })

  test('dateTime create and batch normalization are unchanged', async () => {
    const value = '2026-09-24 09:00'
    const response = await write('create', { [field('when')]: value })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(await stored(response.body.data.record.id)).toMatchObject({ [field('when')]: '2026-09-24T00:00:00.000Z' })
    const patched = await write('batch', { [field('when')]: value })
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)
    expect(await stored(secondRecord)).toMatchObject({ [field('when')]: '2026-09-24T00:00:00.000Z' })
  })

  test('legacy invalid dates remain readable and survive unrelated edits', async () => {
    await query('UPDATE meta_records SET data = data || $1::jsonb WHERE id = $2 AND sheet_id = $3',
      [JSON.stringify({ [field('day')]: 'legacy-invalid' }), firstRecord, sheetId])
    const response = await request(pinned.url()).get(`/api/multitable/records/${firstRecord}`).query({ sheetId })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.data.record.data[field('day')]).toBe('legacy-invalid')
    const edited = await write('patch', { [field('title')]: 'unrelated edit' })
    expect(edited.status, JSON.stringify(edited.body)).toBe(200)
    expect(await stored(firstRecord)).toMatchObject({ [field('day')]: 'legacy-invalid', [field('title')]: 'unrelated edit' })
  })

  test('record-version restore preserves historical invalid dates', async () => {
    const historical = { [field('day')]: '2026-02-30', [field('title')]: 'historic' }
    const current = { [field('day')]: '2024-02-29', [field('title')]: 'current' }
    await query('INSERT INTO meta_records (id,sheet_id,data,version,created_by) VALUES ($1,$2,$3::jsonb,2,$4)',
      [restoreRecord, sheetId, JSON.stringify(current), actorId])
    for (const [version, data] of [[1, historical], [2, current]] as const) {
      await query(`INSERT INTO meta_record_revisions (id,sheet_id,record_id,version,action,source,actor_id,changed_field_ids,patch,snapshot)
        VALUES ($1::uuid,$2,$3,$4,'update','rest',$5,$6::text[],$7::jsonb,$7::jsonb)`,
      [randomUUID(), sheetId, restoreRecord, version, actorId, Object.keys(data), JSON.stringify(data)])
    }
    const response = await request(pinned.url()).post(`/api/multitable/sheets/${sheetId}/records/${restoreRecord}/restore`)
      .send({ targetVersion: 1, expectedVersion: 2 })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(await stored(restoreRecord)).toEqual(historical)
    const revision = await query('SELECT source, snapshot FROM meta_record_revisions WHERE record_id = $1 AND sheet_id = $2 AND version = 3', [restoreRecord, sheetId])
    expect(revision.rows).toEqual([{ source: 'restore', snapshot: historical }])
  })
})
