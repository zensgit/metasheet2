/**
 * PR #6271: pure frontend planners -> authenticated production /patch -> real PostgreSQL.
 * Contract: docs/development/multitable-range-fill-design-lock-20261008.md, §8.
 * Parent supplies a disposable DATABASE_URL and current migrations (users/activation/RBAC,
 * multitable permissions, record revisions/batch_id and operation ledger). No DDL/bootstrap here.
 * CI: vitest.integration.config.ts collects this file; the parent registered it in the explicit
 * post-migrate plugin-tests.yml allowlist and excluded it from no-DB vitest.config.ts.
 * Both METASHEET_REAL_DB_TEST_STEP=1 (that lane) and EXPECT_DB=1 arm the missing-DB sentinel.
 * Run: EXPECT_DB=1 pnpm --filter @metasheet/core-backend exec vitest run
 *   --config vitest.integration.config.ts tests/integration/multitable-range-fill-realdb.test.ts
 * This verifies the planner/API boundary, not Vue selection or local response projection.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import express, { type Express } from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import type { MetaField, MetaRecord } from '../../../../apps/web/src/multitable/types'
import { planRangeFill, planRangePaste, type RangeChange } from '../../../../apps/web/src/multitable/utils/grid-range-fill'
import type { poolManager as PoolManager } from '../../src/integration/db/connection-pool'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const testIfExpectDb = process.env.EXPECT_DB === '1' || process.env.METASHEET_REAL_DB_TEST_STEP === '1'
  ? test : test.skip
testIfExpectDb('sentinel: opted-in realdb gate requires DATABASE_URL, never skip-green', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const NS = `range_fill_realdb_${randomUUID()}`
const BASE = `${NS}_base`
const SHEET = `${NS}_sheet`
const WRITER = `${NS}_writer`
const RESTRICTED = `${NS}_restricted`
const READER = `${NS}_reader`
const RECORDS = [`${NS}_a`, `${NS}_b`]
const F_NUMBER = `${NS}_number`
const F_DATE = `${NS}_date`
const F_TIME = `${NS}_dateTime`
const F_SELECT = `${NS}_select`
const FIELDS: MetaField[] = [
  { id: F_NUMBER, name: 'Number', type: 'number' },
  { id: F_DATE, name: 'Date', type: 'date' },
  { id: F_TIME, name: 'Time', type: 'dateTime', property: { timezone: 'UTC' } },
  { id: F_SELECT, name: 'Choice', type: 'select', options: [{ value: 'one' }, { value: 'two' }] },
]
const SEED: MetaRecord[] = RECORDS.map((id, index) => ({
  id,
  version: 1,
  data: { [F_NUMBER]: index + 1, [F_DATE]: '2024-02-28', [F_TIME]: '2024-02-28T00:00:00.000Z', [F_SELECT]: 'one' },
}))

let poolManager: typeof PoolManager
let app: Express
let signingKey: string
let databaseReady = false
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)
const tokenFor = (userId: string) => jwt.sign({ userId }, signingKey, { algorithm: 'HS256', expiresIn: '5m' })
const patch = (changes: RangeChange[], token: string | null = tokenFor(WRITER)) => {
  const req = request(app).post('/api/multitable/patch')
  if (token !== null) req.set('Authorization', `Bearer ${token}`)
  return req.send({ sheetId: SHEET, partialSuccess: false, changes })
}
const paste = () => planRangePaste({
  rows: SEED,
  fields: FIELDS.slice(0, 3),
  target: { top: 0, left: 0, bottom: 1, right: 2 },
  matrix: [
    ['10', '2024-02-29', '2024-02-29T08:00:00+08:00'],
    ['20', '2024-03-01', '2024-03-01T08:00:00+08:00'],
  ],
  canWrite: () => true,
})
const storedRows = async () => (await q(
  'SELECT id, data, version, modified_by FROM meta_records WHERE sheet_id = $1 ORDER BY id', [SHEET],
)).rows
const revisions = async () => (await q(
  `SELECT record_id, version, action, source, actor_id, changed_field_ids, patch, snapshot, batch_id
   FROM meta_record_revisions WHERE sheet_id = $1 ORDER BY record_id, version`, [SHEET],
)).rows
const snapshot = async () => ({ rows: await storedRows(), revisions: await revisions() })

async function expectRejected(changes: RangeChange[], status: number, code: string, token?: string | null) {
  const before = await snapshot()
  const res = await patch(changes, token)
  expect(res.status).toBe(status)
  expect(res.body.ok).toBe(false)
  expect(res.body.error.code).toBe(code)
  expect(await snapshot()).toEqual(before)
}

async function expectCommitted(changes: RangeChange[], expectedData: Record<string, unknown>[]) {
  const res = await patch(changes)
  expect(res.status).toBe(200)
  const affected = RECORDS.filter(id => changes.some(change => change.recordId === id))
  const updated = affected.map(recordId => ({ recordId, version: 2 }))
  expect(res.body.ok).toBe(true)
  expect(res.body.data.updated).toEqual(updated)
  expect(res.body.data.failed).toBeUndefined()
  expect(res.body.data.batchId).toEqual(expect.any(String))
  expect(res.body.data.batchId.length).toBeGreaterThan(0)
  expect(await storedRows()).toEqual(RECORDS.map((id, index) => ({
    id, data: expectedData[index], version: affected.includes(id) ? 2 : 1,
    modified_by: affected.includes(id) ? WRITER : null,
  })))
  expect(await revisions()).toEqual(affected.map(recordId => {
    const data = expectedData[RECORDS.indexOf(recordId)]
    const fieldIds = changes.filter(change => change.recordId === recordId).map(change => change.fieldId)
    return {
      record_id: recordId, version: 2, action: 'update', source: 'rest', actor_id: WRITER,
      changed_field_ids: fieldIds, patch: Object.fromEntries(fieldIds.map(id => [id, data[id]])),
      snapshot: data, batch_id: res.body.data.batchId,
    }
  }))
  for (const [index, recordId] of RECORDS.entries()) {
    const read = await request(app).get(`/api/multitable/records/${recordId}`)
      .query({ sheetId: SHEET }).set('Authorization', `Bearer ${tokenFor(WRITER)}`)
    expect(read.status).toBe(200)
    expect(read.body.data.record).toMatchObject({
      id: recordId, version: affected.includes(recordId) ? 2 : 1, data: expectedData[index],
    })
    expect(read.body.data.record.data).toEqual(expectedData[index])
  }
  return res.body.data.batchId as string
}

describeIfDatabase('range fill/copy — authenticated HTTP and real PostgreSQL', () => {
  beforeAll(async () => {
    // setup.integration.ts enables both shortcuts. Override BEFORE importing any auth/DB/router
    // singleton. Production mode also disables AuthService's development mock-user fallback.
    signingKey = randomBytes(32).toString('hex')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('SECRET_PROVIDER', 'env')
    vi.stubEnv('JWT_SECRET', signingKey)
    vi.stubEnv('RBAC_BYPASS', 'false')
    vi.stubEnv('RBAC_TOKEN_TRUST', 'false')
    vi.stubEnv('RBAC_OPTIONAL', '0')
    vi.stubEnv('DB_SSL', 'false')
    vi.stubEnv('DB_CONNECT_TIMEOUT', '2000')
    ;({ poolManager } = await import('../../src/integration/db/connection-pool'))
    try {
      await q('SELECT 1')
    } catch {
      throw new Error('Range-fill realdb requires a reachable, migrated disposable DATABASE_URL')
    }
    databaseReady = true
    const { jwtAuthMiddleware } = await import('../../src/auth/jwt-middleware')
    const { univerMetaRouter } = await import('../../src/routes/univer-meta')
    app = express()
    app.use(express.json())
    app.use(jwtAuthMiddleware)
    app.use('/api/multitable', univerMetaRouter())

    for (const userId of [WRITER, RESTRICTED, READER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin,
          activation_status, local_password_set, must_change_password)
         VALUES ($1,$2,$1,'synthetic-unused','member',$3::jsonb,true,false,'activated',true,false)`,
        [userId, `${userId}@example.invalid`, JSON.stringify(userId === READER
          ? ['multitable:read'] : ['multitable:read', 'multitable:write'])],
      )
    }
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'Synthetic range regression'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'Synthetic sheet'])
    for (const [index, field] of FIELDS.entries()) {
      const property = { ...field.property, ...(field.options ? { options: field.options } : {}) }
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [field.id, SHEET, field.name, field.type, JSON.stringify(property), index])
    }
    await q(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
      VALUES ($1,$2,'user',$3,true,true)`, [SHEET, F_TIME, RESTRICTED])
  })

  afterAll(async () => {
    try {
      if (databaseReady) {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET])
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
        await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
        await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET])
        await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET])
        await q('DELETE FROM meta_bases WHERE id = $1', [BASE])
        await q('DELETE FROM users WHERE id = ANY($1::text[])', [[WRITER, RESTRICTED, READER]])
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  beforeEach(async () => {
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    for (const row of SEED) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)',
        [row.id, SHEET, JSON.stringify(row.data), row.version])
    }
  })

  test('planner paste persists six cells, one version per record, canonical UTC and one history batch', async () => {
    const changes = paste()
    expect(changes).toHaveLength(6)
    expect(changes.every(change => change.expectedVersion === 1)).toBe(true)
    const expected = SEED.map((row, index) => ({ ...row.data,
      [F_NUMBER]: (index + 1) * 10, [F_DATE]: index ? '2024-03-01' : '2024-02-29',
      [F_TIME]: index ? '2024-03-01T00:00:00.000Z' : '2024-02-29T00:00:00.000Z',
    }))
    const batchId = await expectCommitted(changes, expected)
    const history = await request(app).get(`/api/multitable/bases/${BASE}/history/events/${batchId}`)
      .set('Authorization', `Bearer ${tokenFor(WRITER)}`)
    expect(history.status).toBe(200)
    expect(history.body.data.changes.map((change: { recordId: string }) => change.recordId).sort()).toEqual(RECORDS)
  })

  test('planner numeric/civil-date series persists leap-day values without rewriting the source', async () => {
    const changes = planRangeFill({ rows: SEED, fields: FIELDS.slice(0, 2),
      source: { top: 0, left: 0, bottom: 0, right: 1 }, target: { top: 0, left: 0, bottom: 1, right: 1 },
      mode: 'series', canWrite: () => true,
    })
    expect(changes).toEqual([
      { recordId: RECORDS[1], fieldId: F_NUMBER, value: 2, expectedVersion: 1 },
      { recordId: RECORDS[1], fieldId: F_DATE, value: '2024-02-29', expectedVersion: 1 },
    ])
    await expectCommitted(changes, [SEED[0].data, { ...SEED[1].data, [F_DATE]: '2024-02-29' }])
  })

  test('planner copy persists typed source values across fields and leaves the source version intact', async () => {
    const changes = planRangeFill({ rows: SEED, fields: FIELDS.slice(0, 2),
      source: { top: 0, left: 0, bottom: 0, right: 1 }, target: { top: 0, left: 0, bottom: 1, right: 1 },
      mode: 'copy', canWrite: () => true,
    })
    await expectCommitted(changes, [SEED[0].data, { ...SEED[1].data, [F_NUMBER]: 1 }])
  })

  test('a stale second record rejects and rolls back the earlier valid record and history', async () => {
    await q('UPDATE meta_records SET version = 2 WHERE id = $1', [RECORDS[1]])
    await expectRejected(paste(), 409, 'VERSION_CONFLICT')
  })

  test('per-subject readonly rejects the whole rectangle; an unrestricted subject can commit it', async () => {
    await expectRejected(paste(), 403, 'FORBIDDEN', tokenFor(RESTRICTED))
    // Same fields/payload succeed for another non-admin: the negative is subject-specific.
    const res = await patch(paste())
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toEqual(RECORDS.map(recordId => ({ recordId, version: 2 })))
  })

  test('a real read-only user cannot submit the same atomic patch', async () => {
    await expectRejected(paste(), 403, 'FORBIDDEN', tokenFor(READER))
  })

  test('an invalid select value after valid record changes rejects the entire batch', async () => {
    // Deliberately bypass the planner's validation to test server authority at the frozen API boundary.
    await expectRejected([...paste(),
      { recordId: RECORDS[1], fieldId: F_SELECT, value: 'not-an-option', expectedVersion: 1 },
    ], 400, 'VALIDATION_ERROR')
  })

  test('an unauthenticated request writes no values, versions or history', async () => {
    await expectRejected(paste(), 401, 'UNAUTHORIZED', null)
  })

  test('a JWT signed by a different key is rejected by real signature verification', async () => {
    const wrongSignature = jwt.sign({ userId: WRITER }, randomBytes(32).toString('hex'), { expiresIn: '5m' })
    await expectRejected(paste(), 401, 'UNAUTHORIZED', wrongSignature)
  })
})
