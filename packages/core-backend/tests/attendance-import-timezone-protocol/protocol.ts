import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { AttendanceManagedPgPool, attendanceOwningSessionForClientV1 } from '../../src/attendance/attendance-owning-session'
import type { QueryConfig } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from './fixture'
import { createAttendanceSyncImportHostV1 } from '../../src/attendance/w4c3a-sync-import-host'
import { buildAttendanceImportAttributionFreezeV1, buildAttendanceImportPolicySourceProofV1 } from '../../src/attendance/w4c3a-import-proof'
import { registerAttendanceRequestTimezoneSourceGuardV1 } from '../../src/attendance/attendance-business-trip-locks'
import { validateAttendanceIanaTimezoneV1, resolveAttendanceLocalWallTimeV1 } from '../../src/attendance/w4c1-strict-time'
import { issueAttendanceFrozenContextV1, resolveAttendanceW7GroupArmSelectionV1 } from '../../src/attendance/w7-resolver/w7-frozen-context-issuance-seam'
import { acquireAttendanceCalculationRolloutLock, parseCanonicalAttendanceRolloutOrgKeyV1, resolveSegmentCalculationPosture } from '../../src/attendance/w4c0-identity'
import { listActiveCurrentOpenRecordsForWorkDateResolverV1 } from '../../src/attendance/w4c3c-active-current'

const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
const OWNER = '00000000-0000-4000-8000-000000006032'
const ORG = '00000000-0000-4000-8000-000000016032'
const INSTANT = '2026-09-22T16:30:00.123Z'
const dbUrl = process.env.DATABASE_URL
if (!dbUrl) throw new Error('ATTENDANCE_IMPORT_TIMEZONE_PROTOCOL_REQUIRES_DATABASE_URL')
function connection(databaseName: string) {
  const url = new URL(dbUrl!)
  url.pathname = `/${databaseName}`
  return { connectionString: url.toString(), max: 5 }
}
const database = `ms26032_${randomUUID().replace(/-/g, '').slice(0, 12)}`
const admin = new Pool(connection('postgres'))
let pool: Pool
const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
const errors: unknown[] = []
const providerIO = vi.fn(() => { throw new Error('PROVIDER_IO_FORBIDDEN') })
const events: unknown[] = []
let commits = 0

beforeAll(async () => {
  expect(process.env.RBAC_BYPASS).not.toBe('true')
  vi.stubGlobal('fetch', providerIO)
  await admin.query(`CREATE DATABASE ${database}`)
  pool = new AttendanceManagedPgPool(connection(database))
  await migrate(pool)
  await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic user')", [OWNER])
  await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [OWNER, ORG])
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,'attendance:admin')", [OWNER])
  await pool.query("INSERT INTO attendance_rules(name,org_id,timezone,is_default,work_start_time,work_end_time,working_days) VALUES ('synthetic rule',$1,'Asia/Shanghai',true,'00:00','23:59','[0,1,2,3,4,5,6]')", [ORG])
  const db = {
    query: async (sql: string | QueryConfig, params?: unknown[]) => (await (typeof sql === 'string' ? pool.query(sql, params) : pool.query(sql))).rows,
    transaction: async (work: (trx: unknown) => Promise<unknown>) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work({ __rawClient: client, query: async (sql: string | QueryConfig, params?: unknown[]) => (await (typeof sql === 'string' ? client.query(sql, params) : client.query(sql))).rows })
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    },
  }
  const posture = async (trx: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }, org: string) => {
    const client = { query: async (sql: string, params?: readonly unknown[]) => ({ rows: await trx.query(sql, [...params ?? []]) }) }
    const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(org)
    await acquireAttendanceCalculationRolloutLock(client, orgKey, 'shared')
    return resolveSegmentCalculationPosture(client, orgKey)
  }
  await plugin.activate({
    api: { database: db, events: { emit: async (...args: unknown[]) => events.push(args) }, http: {
      addRoute: (method: string, path: string, handler: (req: unknown, res: unknown) => Promise<void>) => routes.set(`${method} ${path}`, handler),
    } },
    services: { attendanceW4SegmentCalculation: {
      validateIanaTimezone: validateAttendanceIanaTimezoneV1,
      resolveLocalWallTime: resolveAttendanceLocalWallTimeV1,
      resolveTimezoneSegmentReferencePosture: posture,
      resolveOrgSegmentCalculationPosture: posture,
      issueAttendanceFrozenContextV1,
      resolveAttendanceW7GroupArmSelectionV1,
      activeCurrent: { listOpenForWorkDateResolver: listActiveCurrentOpenRecordsForWorkDateResolverV1 },
      buildImportAttributionFreeze: buildAttendanceImportAttributionFreezeV1,
      buildImportPolicySourceProof: buildAttendanceImportPolicySourceProofV1,
      registerTimezoneSourceGuard: (guard: ((trx: unknown, input: unknown) => Promise<() => Promise<void>>) | null) => {
        registerAttendanceRequestTimezoneSourceGuardV1(guard && (async (client, input) => guard({
          query: async (sql: string | QueryConfig, params?: unknown[]) => (await (typeof sql === 'string' ? client.query(sql, params) : client.query(sql))).rows,
        }, input)))
      },
      commitSyncImportPlan: async (input: Parameters<ReturnType<typeof createAttendanceSyncImportHostV1>['commitSyncImportPlanV1']>[0]) => {
        commits++
        const host = createAttendanceSyncImportHostV1({ acquireConnection: async () => {
          const client = await pool.connect()
          return { client: attendanceOwningSessionForClientV1(client), release: (error?: Error) => client.release(error) }
        } })
        return host.commitSyncImportPlanV1(input)
      },
    } },
    logger: { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
  })
}, 120000)

afterAll(async () => {
  await plugin.deactivate()
  registerAttendanceRequestTimezoneSourceGuardV1(null)
  await pool?.end()
  await admin.query(`DROP DATABASE IF EXISTS ${database}`)
  await admin.end()
})

async function invoke(path: string, body: Record<string, unknown>, actor = OWNER) {
  const response = { statusCode: 200, body: undefined as unknown, headersSent: false,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; this.headersSent = true; return this },
  }
  const handler = routes.get(`POST /api/attendance/import${path === 'legacy' ? '' : `/${path}`}`)
  expect(handler).toBeTypeOf('function')
  errors.length = 0
  await handler!({ user: { id: actor, orgId: ORG }, headers: {}, query: {}, params: {}, body: { userId: OWNER, ...body } }, response)
  return { status: response.statusCode, body: response.body as { ok: boolean; data: { items: Array<Record<string, unknown>>; commitToken: string; batchId: string }; error?: unknown }, errors: [...errors] }
}

function input(kind: string, instant = INSTANT, subject = OWNER) {
  if (kind === 'entries') return { userId: subject, entries: [{ userId: subject, occurredAt: instant, field: 'firstInAt' }] }
  if (kind === 'DingTalk') return { userId: subject, columns: [{ id: 'in', alias: 'firstInAt' }], data: { userId: subject, column_vals: [
    { column_vo: { id: 'in' }, column_vals: [{ date: instant, value: instant }] },
  ] } }
  const epoch = kind === 'JSON10' ? Math.floor(Date.parse(instant) / 1000) : Date.parse(instant)
  return { userId: subject, rows: [{ workDate: String(epoch), fields: { firstInAt: instant } }] }
}

async function commitAndAssert(payload: Record<string, unknown>, day: string, instant: string, timezone = 'Asia/Shanghai', lastOut: string | null = null, expectedUser = OWNER) {
  const preview = await invoke('preview', payload)
  expect(preview).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
  expect(preview.body.data.items).toHaveLength(1)
  expect(preview.body.data.items[0]).toMatchObject({ workDate: day, firstInAt: instant, lastOutAt: lastOut })
  const prepared = await invoke('prepare', {})
  expect(prepared).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
  const token = prepared.body.data.commitToken
  expect(typeof token).toBe('string')
  expect((await pool.query('SELECT count(*)::int n FROM attendance_import_tokens WHERE token=$1', [token])).rows).toEqual([{ n: 1 }])
  const key = `synthetic-6032-${randomUUID()}`
  const beforeCommits = commits
  const committed = await invoke('commit', { ...payload, commitToken: token, idempotencyKey: key })
  expect(committed).toMatchObject({ status: 200, body: { ok: true, data: { imported: 1, failedRows: 0 } }, errors: [] })
  expect(commits).toBe(beforeCommits + 1)
  const batch = committed.body.data.batchId
  const stored = await pool.query(`SELECT r.work_date::text AS day,r.first_in_at AS instant,r.last_out_at AS last_out,
    r.timezone AS timezone,r.user_id AS subject_id,i.work_date::text AS item_day FROM attendance_records r
    JOIN attendance_import_items i ON i.record_id=r.id WHERE i.batch_id=$1`, [batch])
  expect(stored.rows.map(row => ({ ...row, instant: row.instant.toISOString(), last_out: row.last_out?.toISOString() ?? null }))).toEqual([
    { day, instant, last_out: lastOut, timezone, subject_id: expectedUser, item_day: day },
  ])
  expect((await pool.query('SELECT count(*)::int n FROM attendance_import_tokens WHERE token=$1', [token])).rows).toEqual([{ n: 0 }])
  const replay = await invoke('commit', { ...payload, idempotencyKey: key })
  expect(replay).toMatchObject({ status: 200, body: { ok: true, data: { batchId: batch, idempotent: true } }, errors: [] })
  expect(commits).toBe(beforeCommits + 1)
  expect((await pool.query('SELECT count(*)::int n FROM attendance_import_items WHERE batch_id=$1', [batch])).rows).toEqual([{ n: 1 }])
  expect(providerIO).not.toHaveBeenCalled()
}

describe('#6032 real handlers + PostgreSQL + real sync host', () => {
  for (const kind of ['entries', 'DingTalk', 'JSON', 'JSON10']) {
    it(`${kind}: preview -> prepare token -> commit persists local date and exact instant`, async () => {
      await commitAndAssert(input(kind), '2026-09-23', INSTANT)
    })
  }
})

describe('#6032 real published timezone sources', () => {
  for (const source of ['shift', 'rotation']) {
    it(`${source}: preview resolves instant work date in the effective shift zone`, async () => {
      const subject = randomUUID()
      const shift = randomUUID()
      const alias = `synthetic_${subject.replace(/-/g, '')}`
      await pool.query("INSERT INTO users(id,name,username) VALUES ($1,'synthetic subject',$2)", [subject, alias])
      await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [subject, ORG])
      await pool.query("INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days) VALUES ($1,$2,'synthetic shift','America/Los_Angeles','00:00','23:59','[0,1,2,3,4,5,6]')", [shift, ORG])
      if (source === 'shift') {
        await pool.query("INSERT INTO attendance_shift_assignments(org_id,user_id,shift_id,start_date,end_date,publish_status) VALUES ($1,$2,$3,'2026-09-22','2026-09-22','published')", [ORG, subject, shift])
      } else {
        const rotation = randomUUID()
        await pool.query("INSERT INTO attendance_rotation_rules(id,org_id,name,timezone,shift_sequence) VALUES ($1,$2,'synthetic rotation','UTC',$3::jsonb)", [rotation, ORG, JSON.stringify([shift])])
        await pool.query("INSERT INTO attendance_rotation_assignments(org_id,user_id,rotation_rule_id,start_date,end_date,publish_status) VALUES ($1,$2,$3,'2026-09-22','2026-09-22','published')", [ORG, subject, rotation])
      }
      const control = await invoke('preview', { userId: subject, rows: [{ workDate: '2026-09-22', fields: { firstInAt: '19:30' } }] })
      expect(control).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
      expect(control.body.data.items[0]).toMatchObject({ workDate: '2026-09-22', firstInAt: '2026-09-23T02:30:00.000Z' })
      for (const kind of ['entries', 'DingTalk', 'JSON']) {
        const payload = input(kind, '2026-09-23T02:30:00.000Z', subject)
        if (kind === 'JSON') payload.userId = alias
        await commitAndAssert(payload, '2026-09-22', '2026-09-23T02:30:00.000Z', 'America/Los_Angeles', null, subject)
      }
    })
  }
})


describe('#6032 real protocol neighbors', () => {
  it('preserves date-only rows and naive wall clocks through commit', async () => {
    await commitAndAssert({ rows: [{ workDate: '2026-09-24', fields: { firstInAt: '00:30' } }] }, '2026-09-24', '2026-09-23T16:30:00.000Z')
  })
  it('preserves time-only overnight rollover through commit', async () => {
    await pool.query("UPDATE attendance_rules SET work_start_time='22:00',work_end_time='06:00' WHERE org_id=$1 AND is_default=true", [ORG])
    try {
      await commitAndAssert({ rows: [{ workDate: '2026-09-25', fields: { firstInAt: '22:00', lastOutAt: '06:00' } }] },
        '2026-09-25', '2026-09-25T14:00:00.000Z', 'Asia/Shanghai', '2026-09-25T22:00:00.000Z')
    } finally {
      await pool.query("UPDATE attendance_rules SET work_start_time='00:00',work_end_time='23:59' WHERE org_id=$1 AND is_default=true", [ORG])
    }
  })
  it('rejects a conflicting organization selector before token or batch writes', async () => {
    const before = await pool.query('SELECT count(*)::int n FROM attendance_import_batches')
    const denied = await invoke('commit', { ...input('entries'), orgId: randomUUID() })
    expect(denied.status).toBe(404)
    expect(denied.body.ok).toBe(false)
    expect((await pool.query('SELECT count(*)::int n FROM attendance_import_batches')).rows).toEqual(before.rows)
    expect(providerIO).not.toHaveBeenCalled()
  })
})


describe('#6032 review regressions', () => {
  it('keeps scope denial ahead of an invisible subject calendar ambiguity', async () => {
    const actor = randomUUID()
    const subject = randomUUID()
    await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic actor'),($2,'synthetic invisible subject')", [actor, subject])
    await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$3),($2,$3)', [actor, subject, ORG])
    // Real RBAC: no global import grant, only self import scope.
    await pool.query("INSERT INTO attendance_scheduler_scopes(org_id,subject_type,subject_ref,actions,scope) VALUES ($1,'user',$2,ARRAY['import'],$3::jsonb)", [ORG, actor, JSON.stringify({ userIds: [actor] })])
    expect(await invoke('prepare', {}, actor)).toMatchObject({ status: 200, body: { ok: true } })
    await pool.query('DELETE FROM attendance_import_tokens WHERE user_id=$1', [actor])
    const beforeBatches = (await pool.query('SELECT count(*)::int n FROM attendance_import_batches')).rows
    const payload = input('entries', '2026-09-23T02:30:00Z', subject)
    const denied = { ok: false, error: { code: 'SCHEDULER_SCOPE_FORBIDDEN', message: 'Scheduler scope does not allow this attendance scheduling action' } }
    for (const path of ['preview', 'commit', 'legacy']) {
      const control = await invoke(path, { rows: [{ userId: subject, workDate: '2026-09-22', fields: { firstInAt: '19:30' } }] }, actor)
      expect({ status: control.status, body: control.body }).toEqual({ status: 403, body: denied })
    }
    for (const [day, zone] of [['2026-09-22', 'America/Los_Angeles'], ['2026-09-23', 'Asia/Shanghai']]) {
      const shift = randomUUID()
      await pool.query("INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days) VALUES ($1,$2,'synthetic ambiguous shift',$3,'00:00','23:59','[0,1,2,3,4,5,6]')", [shift, ORG, zone])
      await pool.query("INSERT INTO attendance_shift_assignments(org_id,user_id,shift_id,start_date,end_date,publish_status) VALUES ($1,$2,$3,$4,$4,'published')", [ORG, subject, shift, day])
    }
    for (const path of ['preview', 'commit', 'legacy']) {
      const response = await invoke(path, payload, actor)
      expect({ status: response.status, body: response.body }).toEqual({ status: 403, body: denied })
    }
    expect((await pool.query('SELECT count(*)::int n FROM attendance_import_batches')).rows).toEqual(beforeBatches)
    for (const path of ['preview', 'commit', 'legacy']) {
      const allowed = await invoke(path, payload)
      expect({ status: allowed.status, body: allowed.body }).toEqual({ status: 422, body: { ok: false, error: { code: 'IMPORT_CALENDAR_DATE_UNRESOLVED', message: 'Import calendar date could not be resolved uniquely' } } })
    }
  })

  it('provider route keeps direct subject precedence over conflicting userMap without network IO', async () => {
    const subject = randomUUID()
    const other = randomUUID()
    const integration = randomUUID()
    const shift = randomUUID()
    const alias = `synthetic_provider_${subject.replace(/-/g, '')}`
    await pool.query("INSERT INTO users(id,name,username) VALUES ($1,'synthetic provider subject',$3),($2,'synthetic map subject',null)", [subject, other, alias])
    await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$3),($2,$3)', [subject, other, ORG])
    await pool.query("INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days) VALUES ($1,$2,'synthetic provider shift','America/Los_Angeles','00:00','23:59','[0,1,2,3,4,5,6]')", [shift, ORG])
    await pool.query("INSERT INTO attendance_shift_assignments(org_id,user_id,shift_id,start_date,end_date,publish_status) VALUES ($1,$2,$3,'2026-09-22','2026-09-22','published')", [ORG, subject, shift])
    const config = { appKey: 'synthetic-key', appSecret: 'synthetic-secret', baseUrl: 'https://synthetic.invalid',
      userIds: [subject], columnIds: ['in', 'key'], columns: [{ id: 'in', alias: 'firstInAt' }, { id: 'key', alias: 'userKey' }],
      userMap: { [subject]: other, 'synthetic-external': other }, userMapKeyField: 'userKey', userMapSourceFields: ['userKey'] }
    await pool.query("INSERT INTO attendance_integrations(id,org_id,name,type,status,config) VALUES ($1,$2,'synthetic provider','dingtalk','active',$3::jsonb)", [integration, ORG, JSON.stringify(config)])
    const mockFetch = vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('/gettoken')
      ? { errcode: 0, access_token: 'synthetic-token', expires_in: 0 }
      : { errcode: 0, result: { column_vals: [
        { column_vo: { id: 'in' }, column_vals: [{ date: '2026-09-23T02:30:00Z', value: '2026-09-23T02:30:00Z' }] },
        { column_vo: { id: 'key' }, column_vals: [{ date: '2026-09-23T02:30:00Z', value: 'synthetic-external' }] },
      ] } } }))
    await commitAndAssert({ userMap: { 'synthetic-external': subject }, userMapKeyField: 'userKey', userMapSourceFields: ['userKey'],
      rows: [{ workDate: '2026-09-23T02:30:00Z', fields: { userKey: 'synthetic-external', firstInAt: '2026-09-23T02:30:00Z' } }],
    }, '2026-09-22', '2026-09-23T02:30:00.000Z', 'America/Los_Angeles', null, subject)
    for (const providerUser of [subject, alias]) {
      vi.stubGlobal('fetch', mockFetch)
      await pool.query('UPDATE attendance_integrations SET config=$2::jsonb WHERE id=$1', [integration, JSON.stringify({ ...config, userIds: [providerUser] })])
      const response = { statusCode: 200, body: undefined as unknown, headersSent: false,
        status(code: number) { this.statusCode = code; return this }, json(body: unknown) { this.body = body; this.headersSent = true; return this } }
      try {
        await routes.get('POST /api/attendance/integrations/:id/sync')!({ user: { id: OWNER, orgId: ORG }, headers: {}, query: {}, params: { id: integration }, body: { from: '2026-09-22', to: '2026-09-23' } }, response)
        expect({ status: response.statusCode, body: response.body, errors }).toMatchObject({ status: 200, body: { ok: true, data: { imported: 1 } }, errors: [] })
        const batch = (response.body as { data: { batchId: string } }).data.batchId
        expect((await pool.query('SELECT r.user_id,r.work_date::text AS day,r.timezone,r.first_in_at FROM attendance_records r JOIN attendance_import_items i ON i.record_id=r.id WHERE i.batch_id=$1', [batch])).rows.map(row => ({ ...row, first_in_at: row.first_in_at.toISOString() }))).toEqual([{ user_id: subject, day: '2026-09-22', timezone: 'America/Los_Angeles', first_in_at: '2026-09-23T02:30:00.000Z' }])
      } finally { vi.stubGlobal('fetch', providerIO) }
    }
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })
})

it('accounts for all real protocol effects without asynchronous jobs or provider IO', async () => {
  const counts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM attendance_records) AS records,
    (SELECT count(*)::int FROM attendance_import_batches) AS batches,
    (SELECT count(*)::int FROM attendance_import_items) AS items,
    (SELECT count(*)::int FROM attendance_import_tokens) AS tokens,
    (SELECT count(*)::int FROM attendance_import_jobs) AS jobs`)).rows[0]
  expect({ ...counts, coreHostCalls: commits, providerIO: providerIO.mock.calls.length }).toEqual({
    records: 6, batches: 15, items: 15, tokens: 0, jobs: 0, coreHostCalls: 15, providerIO: 0,
  })
  mkdirSync(new URL('../../../../artifacts/6032/', import.meta.url), { recursive: true })
  writeFileSync(new URL('../../../../artifacts/6032/protocol-counts.json', import.meta.url),
    JSON.stringify({ ...counts, coreHostCalls: commits, providerIO: providerIO.mock.calls.length }, null, 2) + '\n')
})
