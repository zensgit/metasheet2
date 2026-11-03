/**
 * PR #6271: pure frontend planners -> authenticated production /patch -> real PostgreSQL.
 * Contracts: docs/development/multitable-range-fill-design-lock-20261008.md, §8;
 * docs/development/multitable-range-fill-editable-fields-design-lock-20261009.md, E4.
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
import { parseClipboardMatrix, planRangeFill, planRangePaste, serializeClipboardMatrix, type RangeChange } from '../../../../apps/web/src/multitable/utils/grid-range-fill'
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
const F_NUMBER = `fld_${NS}_number`
const F_DATE = `${NS}_date`
const F_TIME = `${NS}_dateTime`
const F_SELECT = `${NS}_select`
// Native person/link codecs cap IDs at 50 characters; the existing actor namespace exceeds it.
const PEOPLE = { inGroup: randomUUID(), member: randomUUID(), nonmember: randomUUID(), otherSheet: randomUUID() }
const PERSON_USERS = Object.values(PEOPLE)
const PERSON_NAMES = Object.fromEntries(PERSON_USERS.map((id, index) => [id, `Synthetic member ${index + 1}`]))
const GROUP = randomUUID()
const OTHER_SHEET = `${NS}_other_sheet`
const LINK_RECORD = randomUUID()
const ATTACHMENT = randomUUID()
const F_MULTI = `${NS}_multiSelect`
const F_PERSON_ONE = `${NS}_person_one`
const F_PERSON_MANY = `${NS}_person_many`
const F_PERSON_GROUP = `${NS}_person_group`
const F_LOCATION = `${NS}_location`
const F_CURRENCY = `${NS}_currency`
const F_LONG_TEXT = `${NS}_longText`
const F_LINK = `${NS}_link`
const F_ATTACHMENT = `${NS}_attachment`
const F_FOREIGN_NUMBER = `${NS}_foreign_number`
const F_FORMULA = `${NS}_formula`
const F_ROLLUP = `fld_${NS}_rollup`
const F_AUTO_NUMBER = `${NS}_autoNumber`
const F_LOOKUP = `${NS}_lookup`
const COMPUTED_IDS = [F_FORMULA, F_ROLLUP, F_AUTO_NUMBER, F_LOOKUP]
const FIELDS: MetaField[] = [
  { id: F_NUMBER, name: 'Number', type: 'number' },
  { id: F_DATE, name: 'Date', type: 'date' },
  { id: F_TIME, name: 'Time', type: 'dateTime', property: { timezone: 'UTC' } },
  { id: F_SELECT, name: 'Choice', type: 'select', options: [{ value: 'one' }, { value: 'two' }] },
]
const EXTENDED_FIELDS: MetaField[] = [
  { id: F_MULTI, name: 'Choices', type: 'multiSelect', options: [{ value: 'one' }, { value: 'two' }, { value: 'comma, newline\noption' }] },
  { id: F_PERSON_ONE, name: 'Owner', type: 'person', property: { limitSingleRecord: true } },
  { id: F_PERSON_MANY, name: 'People', type: 'person', property: { limitSingleRecord: false } },
  { id: F_PERSON_GROUP, name: 'Group owner', type: 'person', property: { limitSingleRecord: true, restrictToMemberGroupIds: [GROUP] } },
  { id: F_LOCATION, name: 'Location', type: 'location' },
  { id: F_CURRENCY, name: 'Amount', type: 'currency' },
  { id: F_LONG_TEXT, name: 'Notes', type: 'longText' },
  { id: F_LINK, name: 'Related', type: 'link', property: { foreignSheetId: OTHER_SHEET, limitSingleRecord: false } },
  { id: F_ATTACHMENT, name: 'Files', type: 'attachment' },
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
const storedLinks = async () => (await q(
  'SELECT field_id, record_id, foreign_record_id FROM meta_links WHERE field_id = $1 ORDER BY record_id, foreign_record_id', [F_LINK],
)).rows
const storedAttachments = async () => (await q(
  'SELECT id, sheet_id, record_id, field_id, storage_file_id, deleted_at FROM multitable_attachments WHERE sheet_id = $1 ORDER BY id', [SHEET],
)).rows
const snapshot = async () => ({ rows: await storedRows(), revisions: await revisions(), links: await storedLinks(), attachments: await storedAttachments() })

const planCopy = (rows: MetaRecord[], fields: MetaField[]) => planRangeFill({
  rows, fields, source: { top: 0, left: 0, bottom: 0, right: fields.length - 1 },
  target: { top: 0, left: 0, bottom: 1, right: fields.length - 1 }, mode: 'copy', canWrite: () => true,
})
const planExtendedPaste = (fields: MetaField[], values: unknown[]) => planRangePaste({
  rows: SEED, fields, target: { top: 0, left: 0, bottom: 1, right: fields.length - 1 },
  matrix: parseClipboardMatrix(serializeClipboardMatrix([values])), canWrite: () => true,
})
async function seedCopy(values: Record<string, unknown>, destination: Record<string, unknown> = {}) {
  const rows = SEED.map((row, index) => ({ ...row, data: { ...row.data, ...(index ? destination : values) } }))
  for (const row of rows) {
    await q('UPDATE meta_records SET data = $2::jsonb WHERE id = $1', [row.id, JSON.stringify(row.data)])
  }
  if (values[F_LINK]) {
    await q('INSERT INTO meta_links (id, field_id, record_id, foreign_record_id) VALUES ($1,$2,$3,$4)',
      [randomUUID(), F_LINK, RECORDS[0], LINK_RECORD])
  }
  return rows
}
async function addComputedField(id: string, type: MetaField['type'], property: Record<string, unknown>) {
  await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,20)',
    [id, SHEET, 'Synthetic derived field', type, JSON.stringify(property)])
}

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
    // Relational links hydrate to [] even when the JSON data key is absent.
    expect(read.body.data.record.data).toEqual({ [F_LINK]: [], ...expectedData[index] })
    for (const field of EXTENDED_FIELDS.filter(field => field.type === 'person')) {
      const ids = expectedData[index][field.id]
      if (Array.isArray(ids)) {
        expect(read.body.data.personSummaries[field.id]).toEqual(ids.map(id => ({ id, display: PERSON_NAMES[id] })))
      }
    }
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

    for (const userId of [WRITER, RESTRICTED, READER, ...PERSON_USERS]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin,
          activation_status, local_password_set, must_change_password)
         VALUES ($1,$2,$4,'synthetic-unused','member',$3::jsonb,true,false,'activated',true,false)`,
        [userId, `${userId}@example.invalid`, JSON.stringify(PERSON_USERS.includes(userId) ? [] : userId === READER
          ? ['multitable:read'] : ['multitable:read', 'multitable:write']), PERSON_NAMES[userId] ?? userId],
      )
    }
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'Synthetic range regression'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'Synthetic sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [OTHER_SHEET, BASE, 'Synthetic other sheet'])
    await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)',
      [LINK_RECORD, OTHER_SHEET, JSON.stringify({ [F_FOREIGN_NUMBER]: 9 })])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,0)',
      [F_FOREIGN_NUMBER, OTHER_SHEET, 'Synthetic number', 'number', '{}'])
    // The canonical directory requires active multitable eligibility as well as real sheet grants.
    // The other-sheet-only user deliberately has no platform multitable permission.
    for (const userId of [PEOPLE.inGroup, PEOPLE.member]) {
      await q("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'multitable:read')", [userId])
      await q("INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,'spreadsheet:read')",
        [SHEET, userId])
    }
    await q("INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,'user',$2,'spreadsheet:read')",
      [OTHER_SHEET, PEOPLE.otherSheet])
    await q('INSERT INTO platform_member_groups (id, name) VALUES ($1,$2)', [GROUP, `${NS}_allowed_group`])
    await q('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1,$2)', [GROUP, PEOPLE.inGroup])
    for (const [index, field] of [...FIELDS, ...EXTENDED_FIELDS].entries()) {
      const property = { ...field.property, ...(field.options ? { options: field.options } : {}) }
      await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [field.id, SHEET, field.name, field.type, JSON.stringify(property), index])
    }
    await q(`INSERT INTO multitable_attachments
      (id, sheet_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path)
      VALUES ($1,$2,$3,$4,'synthetic.txt','synthetic.txt','text/plain',11,$5)`,
    [ATTACHMENT, SHEET, F_ATTACHMENT, `${NS}_storage`, `${NS}/synthetic.txt`])
    await q(`INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
      VALUES ($1,$2,'user',$3,true,true)`, [SHEET, F_TIME, RESTRICTED])
  })

  afterAll(async () => {
    try {
      if (databaseReady) {
        await q('DELETE FROM field_permissions WHERE sheet_id = $1', [SHEET])
        await q('DELETE FROM meta_links WHERE field_id = $1', [F_LINK])
        await q('DELETE FROM multitable_attachments WHERE sheet_id = $1', [SHEET])
        await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
        await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET, OTHER_SHEET]])
        await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET, OTHER_SHEET]])
        await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [[SHEET, OTHER_SHEET]])
        await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET, OTHER_SHEET]])
        await q('DELETE FROM meta_bases WHERE id = $1', [BASE])
        await q('DELETE FROM platform_member_group_members WHERE group_id = $1', [GROUP])
        await q('DELETE FROM platform_member_groups WHERE id = $1', [GROUP])
        await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [PERSON_USERS])
        await q('DELETE FROM users WHERE id = ANY($1::text[])', [[WRITER, RESTRICTED, READER, ...PERSON_USERS]])
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  beforeEach(async () => {
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    await q('DELETE FROM meta_fields WHERE id = ANY($1::text[])', [COMPUTED_IDS])
    await q('DELETE FROM meta_links WHERE field_id = $1', [F_LINK])
    await q('UPDATE multitable_attachments SET record_id = NULL WHERE id = $1', [ATTACHMENT])
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET])
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET])
    for (const row of SEED) {
      await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,$4)',
        [row.id, SHEET, JSON.stringify(row.data), row.version])
    }
    await q('UPDATE multitable_attachments SET record_id = $2 WHERE id = $1', [ATTACHMENT, RECORDS[0]])
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

  test('planner drag-copy replaces the entire multiSelect array, preserving commas and newlines in options', async () => {
    const values = { [F_MULTI]: ['two', 'comma, newline\noption'] }
    const rows = await seedCopy(values, { [F_MULTI]: ['one'] })
    const changes = planCopy(rows, [EXTENDED_FIELDS[0]])
    expect(changes).toEqual([{ recordId: RECORDS[1], fieldId: F_MULTI, value: values[F_MULTI], expectedVersion: 1 }])
    await expectCommitted(changes, [rows[0].data, { ...rows[1].data, ...values }])
  })

  test('planner structured TSV roundtrip persists multiSelect and native single/multi-person IDs', async () => {
    const fields = EXTENDED_FIELDS.slice(0, 3)
    const values = [['two', 'comma, newline\noption'], [PEOPLE.inGroup], [PEOPLE.inGroup, PEOPLE.member]]
    const changes = planExtendedPaste(fields, values)
    expect(changes).toEqual(RECORDS.flatMap(recordId => fields.map((field, index) => ({
      recordId, fieldId: field.id, value: values[index], expectedVersion: 1,
    }))))
    const data = Object.fromEntries(fields.map((field, index) => [field.id, values[index]]))
    await expectCommitted(changes, SEED.map(row => ({ ...row.data, ...data })))
  })

  test('planner drag-copy persists single and multiple native people, replacing destination people', async () => {
    const values = { [F_PERSON_ONE]: [PEOPLE.inGroup], [F_PERSON_MANY]: [PEOPLE.inGroup, PEOPLE.member] }
    const rows = await seedCopy(values, { [F_PERSON_ONE]: [PEOPLE.member], [F_PERSON_MANY]: [PEOPLE.member] })
    const changes = planCopy(rows, EXTENDED_FIELDS.slice(1, 3))
    expect(changes).toHaveLength(2)
    await expectCommitted(changes, [rows[0].data, { ...rows[1].data, ...values }])
  })

  test('planner drag-copy persists structured location, currency and multiline longText', async () => {
    const values = {
      [F_LOCATION]: { address: 'Synthetic room', latitude: 12.5, longitude: 25.25 },
      [F_CURRENCY]: 1234.56, [F_LONG_TEXT]: 'Synthetic notes\nsecond line',
    }
    const rows = await seedCopy(values)
    const changes = planCopy(rows, EXTENDED_FIELDS.slice(4, 7))
    expect(changes).toHaveLength(3)
    await expectCommitted(changes, [rows[0].data, { ...rows[1].data, ...values }])
  })

  test('planner drag-copy retains existing link and attachment IDs and persists the destination link edge', async () => {
    const values = { [F_LINK]: [LINK_RECORD], [F_ATTACHMENT]: [ATTACHMENT] }
    const rows = await seedCopy(values, { [F_LINK]: [], [F_ATTACHMENT]: [] })
    const beforeAttachments = await storedAttachments()
    const changes = planCopy(rows, EXTENDED_FIELDS.slice(7, 9))
    expect(changes).toHaveLength(2)
    await expectCommitted(changes, [rows[0].data, { ...rows[1].data, ...values }])
    expect(await storedLinks()).toEqual(RECORDS.map(record_id => ({ field_id: F_LINK, record_id, foreign_record_id: LINK_RECORD })))
    expect(await storedAttachments()).toEqual(beforeAttachments)
  })

  test('an invalid multiSelect option after planner-valid cells rejects data, versions and history atomically', async () => {
    // Client metadata can be stale: planner accepts a formerly valid option, server options remain authoritative.
    const field = { ...EXTENDED_FIELDS[0], options: [...EXTENDED_FIELDS[0].options!, { value: 'removed-option' }] }
    const invalid = planExtendedPaste([field], [['removed-option']])
    await expectRejected([...paste(), invalid[1]], 400, 'VALIDATION_ERROR')
  })

  test.each([
    ['nonmember', PEOPLE.nonmember],
    ['other-sheet-only member', PEOPLE.otherSheet],
  ])('planner person assignment of a %s rolls back earlier valid cells; an eligible sheet member commits', async (_label, personId) => {
    const field = EXTENDED_FIELDS[2]
    const invalid = planExtendedPaste([field], [[personId]])
    await expectRejected([...paste(), invalid[1]], 400, 'VALIDATION_ERROR')
    const valid = planExtendedPaste([field], [[PEOPLE.member]])
    await expectCommitted(valid, SEED.map(row => ({ ...row.data, [F_PERSON_MANY]: [PEOPLE.member] })))
  })

  test('out-of-group eligible sheet member rejects atomically; in-group person commits to the same restricted field', async () => {
    const field = EXTENDED_FIELDS[3]
    const invalid = planExtendedPaste([field], [[PEOPLE.member]])
    await expectRejected([...paste(), invalid[1]], 400, 'VALIDATION_ERROR')
    const valid = planExtendedPaste([field], [[PEOPLE.inGroup]])
    await expectCommitted(valid, SEED.map(row => ({ ...row.data, [F_PERSON_GROUP]: [PEOPLE.inGroup] })))
  })

  test('target single-person field rejects multiple eligible IDs when client cardinality metadata is stale', async () => {
    const field = { ...EXTENDED_FIELDS[1], property: { limitSingleRecord: false } }
    const invalid = planExtendedPaste([field], [[PEOPLE.inGroup, PEOPLE.member]])
    await expectRejected([...paste(), invalid[1]], 400, 'VALIDATION_ERROR')
    const valid = planExtendedPaste([EXTENDED_FIELDS[1]], [[PEOPLE.inGroup]])
    await expectCommitted(valid, SEED.map(row => ({ ...row.data, [F_PERSON_ONE]: [PEOPLE.inGroup] })))
  })

  test('drag-copy of an editable numeric input recalculates the existing formula without copying its expression', async () => {
    await addComputedField(F_FORMULA, 'formula', { expression: `={${F_NUMBER}}*2` })
    const rows = await seedCopy({ [F_FORMULA]: 2 }, { [F_FORMULA]: 4 })
    const changes = planCopy(rows, [FIELDS[0]])
    expect(changes).toEqual([{ recordId: RECORDS[1], fieldId: F_NUMBER, value: 1, expectedVersion: 1 }])
    const res = await patch(changes)
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toEqual([{ recordId: RECORDS[1], version: 2 }])
    expect(res.body.data.records).toEqual([{ recordId: RECORDS[1], data: { [F_FORMULA]: 2 } }])
    expect(await storedRows()).toEqual([
      { id: RECORDS[0], data: rows[0].data, version: 1, modified_by: null },
      { id: RECORDS[1], data: { ...rows[1].data, [F_NUMBER]: 1, [F_FORMULA]: 2 }, version: 2, modified_by: WRITER },
    ])
    const history = await revisions()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ record_id: RECORDS[1], version: 2, changed_field_ids: [F_NUMBER], patch: { [F_NUMBER]: 1 } })
  })

  test('drag-copy of a link recalculates its rollup and existing formula over the hydrated rollup', async () => {
    await addComputedField(F_ROLLUP, 'rollup', { linkFieldId: F_LINK, targetFieldId: F_FOREIGN_NUMBER, aggregation: 'sum' })
    await addComputedField(F_FORMULA, 'formula', { expression: `={${F_ROLLUP}}+1` })
    const rows = await seedCopy({ [F_LINK]: [LINK_RECORD], [F_FORMULA]: 10 }, { [F_LINK]: [], [F_FORMULA]: 1 })
    const changes = planCopy(rows, [EXTENDED_FIELDS[7]])
    expect(changes).toEqual([{ recordId: RECORDS[1], fieldId: F_LINK, value: [LINK_RECORD], expectedVersion: 1 }])
    const res = await patch(changes)
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toEqual([{ recordId: RECORDS[1], version: 2 }])
    expect(res.body.data.records).toEqual([{ recordId: RECORDS[1], data: { [F_ROLLUP]: 9, [F_FORMULA]: 10 } }])
    expect(await storedRows()).toEqual([
      { id: RECORDS[0], data: rows[0].data, version: 1, modified_by: null },
      { id: RECORDS[1], data: { ...rows[1].data, [F_LINK]: [LINK_RECORD], [F_FORMULA]: 10 }, version: 2, modified_by: WRITER },
    ])
    expect(await storedLinks()).toEqual(RECORDS.map(record_id => ({ field_id: F_LINK, record_id, foreign_record_id: LINK_RECORD })))
    const history = await revisions()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ record_id: RECORDS[1], version: 2, changed_field_ids: [F_LINK], patch: { [F_LINK]: [LINK_RECORD] } })
  })

  test.each([
    { fieldId: F_FORMULA, type: 'formula' }, { fieldId: F_LOOKUP, type: 'lookup' },
    { fieldId: F_ROLLUP, type: 'rollup' }, { fieldId: F_AUTO_NUMBER, type: 'autoNumber' },
  ] as const)('server rejects direct writes to $type, preserving earlier planned cells and history', async ({ fieldId, type }) => {
    await addComputedField(fieldId, type, type === 'formula' ? { expression: `={${F_NUMBER}}*2` } : {})
    // Deliberately bypass planner READ_ONLY to exercise the authoritative server backstop.
    await expectRejected([...paste(), { recordId: RECORDS[1], fieldId, value: 123, expectedVersion: 1 }], 403, 'FORBIDDEN')
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
