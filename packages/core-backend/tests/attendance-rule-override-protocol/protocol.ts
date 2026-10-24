import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
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
const OWNER = '00000000-0000-4000-8000-000000008562'
const ORG = '00000000-0000-4000-8000-000000018562'
const dbUrl = process.env.DATABASE_URL
if (!dbUrl) throw new Error('ATTENDANCE_RULE_OVERRIDE_PROTOCOL_REQUIRES_DATABASE_URL')
function connection(databaseName: string) {
  const url = new URL(dbUrl!)
  url.pathname = `/${databaseName}`
  return { connectionString: url.toString(), max: 5 }
}
const database = `ms_rule_override_${randomUUID().replace(/-/g, '').slice(0, 12)}`
const admin = new Pool(connection('postgres'))
let pool: Pool
const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
const errors: unknown[] = []
const providerIO = vi.fn(() => { throw new Error('PROVIDER_IO_FORBIDDEN') })
const events: unknown[] = []
let commits = 0

beforeAll(async () => {
  for (const flag of ['RBAC_BYPASS', 'DINGTALK_STREAM_ENABLED', 'DINGTALK_TODO_MIRROR_ENABLED',
    'DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED', 'DINGTALK_DIRECTORY_SYNC_SCHEDULER_ENABLED', 'ATTENDANCE_SCHEDULER_ENABLED',
    'ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED']) expect(process.env[flag]).not.toBe('true')
  vi.stubGlobal('fetch', providerIO)
  await admin.query(`CREATE DATABASE ${database}`)
  pool = new Pool(connection(database))
  await migrate(pool)
  await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic user')", [OWNER])
  await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [OWNER, ORG])
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,'attendance:admin')", [OWNER])
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,'attendance:read')", [OWNER])
  await pool.query(`INSERT INTO attendance_rules(name,org_id,timezone,is_default,work_start_time,work_end_time,
    late_grace_minutes,early_grace_minutes,rounding_minutes,working_days)
    VALUES ('synthetic rule',$1,'Asia/Shanghai',true,'08:15','17:45',7,11,15,'[0,1,2,3,4,5,6]')`, [ORG])
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
          return { client, release: (error?: Error) => client.release(error) }
        } })
        return host.commitSyncImportPlanV1(input)
      },
    } },
    logger: { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args) },
  })
}, 120000)

afterAll(async () => {
  try { await plugin.deactivate() }
  finally {
    registerAttendanceRequestTimezoneSourceGuardV1(null)
    vi.unstubAllGlobals()
    await pool?.end()
    try { await admin.query(`DROP DATABASE IF EXISTS ${database}`) }
    finally { await admin.end() }
  }
})


type Metrics = { workMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; status: string }
type Reply = {
  ok: boolean
  data: { items: Array<Record<string, unknown>>; preview: Array<Record<string, unknown>>;
    commitToken: string; batchId: string; imported: number; failedRows: number }
  error?: unknown
}
const DAY = '2026-09-22'
const FIRST = '2026-09-22T00:45:00.000Z'
const LAST = '2026-09-22T09:13:00.000Z'
const BASE = { workMinutes: 495, lateMinutes: 23, earlyLeaveMinutes: 21, status: 'late_early' }

async function invoke(path: string, body: Record<string, unknown>, actor = OWNER) {
  const response = { statusCode: 200, body: undefined as unknown, headersSent: false,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; this.headersSent = true; return this },
  }
  const route = path === 'calendar' ? '/api/attendance/effective-calendar' : path === 'rule-preview' ? '/api/attendance/rule-sets/preview'
    : `/api/attendance/import${path === 'legacy' ? '' : `/${path}`}`
  const handler = routes.get(`${path === 'calendar' ? 'GET' : 'POST'} ${route}`)
  expect(handler).toBeTypeOf('function')
  errors.length = 0
  await handler!({ user: { id: actor, orgId: ORG }, headers: {}, query: path === 'calendar' ? body : {}, params: {},
    body: { userId: OWNER, ...body } }, response)
  return { status: response.statusCode, body: response.body as Reply, errors: [...errors] }
}

function metrics(item: Record<string, unknown>): Metrics {
  const result = { workMinutes: item.workMinutes as number, lateMinutes: item.lateMinutes as number,
    earlyLeaveMinutes: item.earlyLeaveMinutes as number, status: item.status as string }
  for (const value of [result.workMinutes, result.lateMinutes, result.earlyLeaveMinutes]) {
    expect(Number.isFinite(value)).toBe(true)
  }
  return result
}

async function payload(rule: Record<string, unknown> | null) {
  const ruleSetId = randomUUID()
  if (rule !== null) {
    await pool.query("INSERT INTO attendance_rule_sets(id,org_id,name,config) VALUES ($1,$2,$4,$3::jsonb)",
      [ruleSetId, ORG, JSON.stringify({ rule }), `synthetic-${ruleSetId}`])
  }
  const userId = randomUUID()
  await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic subject')", [userId])
  await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [userId, ORG])
  return { userId, ...(rule === null ? {} : { ruleSetId }),
    rows: [{ userId, workDate: DAY, fields: { firstInAt: '08:45', lastOutAt: '17:13' } }] }
}

async function counts() {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM attendance_records) AS records,
    (SELECT count(*)::int FROM attendance_events) AS events,
    (SELECT count(*)::int FROM attendance_import_batches) AS batches,
    (SELECT count(*)::int FROM attendance_import_items) AS items,
    (SELECT count(*)::int FROM attendance_import_tokens) AS tokens,
    (SELECT count(*)::int FROM attendance_import_jobs) AS jobs`)).rows[0]
}

const cases: Array<{ name: string; rule: Record<string, unknown> | null; expected: Metrics }> = [
  { name: 'no override control', rule: null, expected: BASE },
  { name: 'timezone only retains base hours and nonzero grace', rule: { timezone: 'Asia/Shanghai' }, expected: BASE },
  { name: 'shift hours only retain base timezone and nonzero grace',
    rule: { workStartTime: '08:30', workEndTime: '17:30' },
    expected: { ...BASE, lateMinutes: 8, earlyLeaveMinutes: 6 } },
  { name: 'explicit zero grace replaces nonzero base',
    rule: { lateGraceMinutes: 0, earlyGraceMinutes: 0 },
    expected: { ...BASE, lateMinutes: 30, earlyLeaveMinutes: 32 } },
  { name: 'custom nonzero grace and rounding override base',
    rule: { lateGraceMinutes: 3, earlyGraceMinutes: 5, roundingMinutes: 20 },
    expected: { ...BASE, workMinutes: 500, lateMinutes: 27, earlyLeaveMinutes: 27 } },
  { name: 'empty override is equivalent to base', rule: {}, expected: BASE },
]

describe('partial rule overrides: registered handlers + real PostgreSQL + real sync host', () => {
  for (const testCase of cases) {
    for (const entry of ['preview', 'commit', 'legacy', 'rule-preview']) {
      it(`${entry}: ${testCase.name}`, async () => {
        const input = await payload(testCase.rule)
        const before = await counts()
        const beforeCommits = commits
        if (entry === 'rule-preview') {
          const result = await invoke(entry, {
            ...(testCase.rule === null ? {} : { ruleSetId: input.ruleSetId }),
            events: [
              { userId: input.userId, eventType: 'check_in', occurredAt: FIRST, workDate: DAY },
              { userId: input.userId, eventType: 'check_out', occurredAt: LAST, workDate: DAY },
            ],
          })
          expect(result).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
          expect(result.body.data.preview).toHaveLength(1)
          expect(metrics(result.body.data.preview[0])).toEqual(testCase.expected)
          expect(await counts()).toEqual(before)
          expect(commits).toBe(beforeCommits)
          return
        }
        if (entry === 'preview') {
          const result = await invoke(entry, input)
          expect(result).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
          expect(result.body.data.items).toHaveLength(1)
          expect(metrics(result.body.data.items[0])).toEqual(testCase.expected)
          expect(result.body.data.items[0]).toMatchObject({ workDate: DAY, firstInAt: FIRST, lastOutAt: LAST })
          expect(await counts()).toEqual(before)
          expect(commits).toBe(beforeCommits)
          return
        }
        const idempotencyKey = `synthetic-rule-override-${randomUUID()}`
        let commitToken: string | undefined
        if (entry === 'commit') {
          const prepared = await invoke('prepare', {})
          expect(prepared).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
          commitToken = prepared.body.data.commitToken
          expect(typeof commitToken).toBe('string')
          expect((await pool.query('SELECT count(*)::int n FROM attendance_import_tokens WHERE token=$1',
            [commitToken])).rows).toEqual([{ n: 1 }])
        }
        const result = await invoke(entry, { ...input, idempotencyKey, ...(commitToken ? { commitToken } : {}) })
        expect(result).toMatchObject({ status: 200, body: { ok: true, data: { imported: 1, failedRows: 0 } }, errors: [] })
        expect(commits).toBe(beforeCommits + 1)
        // Legacy deliberately returns batchId=null; each case has a unique synthetic subject.
        if (entry === 'legacy') expect(result.body.data.batchId).toBe(null)
        const stored = await pool.query(`SELECT r.work_minutes AS "workMinutes",r.late_minutes AS "lateMinutes",
          r.early_leave_minutes AS "earlyLeaveMinutes",r.status,r.timezone,r.first_in_at,r.last_out_at,
          r.work_date::text AS day,r.user_id,i.work_date::text AS item_day
          FROM attendance_records r JOIN attendance_import_items i ON i.record_id=r.id
          WHERE r.user_id=$1 AND r.org_id=$2`, [input.userId, ORG])
        expect(stored.rows).toHaveLength(1)
        expect(metrics(stored.rows[0])).toEqual(testCase.expected)
        expect({ ...stored.rows[0], first_in_at: stored.rows[0].first_in_at.toISOString(),
          last_out_at: stored.rows[0].last_out_at.toISOString() }).toEqual({
          ...testCase.expected, timezone: 'Asia/Shanghai', first_in_at: FIRST, last_out_at: LAST,
          day: DAY, user_id: input.userId, item_day: DAY,
        })
        if (commitToken) expect((await pool.query(
          'SELECT count(*)::int n FROM attendance_import_tokens WHERE token=$1', [commitToken],
        )).rows).toEqual([{ n: 0 }])
        expect(providerIO).not.toHaveBeenCalled()
      })
    }
  }

  it('group effective-calendar retains the default timezone with an empty stored override', async () => {
    const input = await payload({})
    const group = randomUUID()
    await pool.query(`INSERT INTO attendance_groups(id,org_id,name,timezone,rule_set_id)
      VALUES ($1,$2,$4,'UTC',$3)`, [group, ORG, input.ruleSetId, `synthetic-${group}`])
    const before = await counts()
    const result = await invoke('calendar', { groupId: group, from: DAY, to: DAY })
    expect(result).toMatchObject({ status: 200, body: { ok: true, data: {
      mode: 'groupId', from: DAY, to: DAY, timezone: 'Asia/Shanghai',
      items: [{ date: DAY, base: { isWorkingDay: true, source: 'rule' },
        effective: { isWorkingDay: true, source: 'rule' } }],
    } }, errors: [] })
    expect(result.body.data.items).toHaveLength(1)
    expect(await counts()).toEqual(before)
  })

  it('scope-denied actor gets exact 403 with no record, token, batch, item, event or job writes', async () => {
    const actor = randomUUID()
    await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic scoped actor')", [actor])
    await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [actor, ORG])
    await pool.query(`INSERT INTO attendance_scheduler_scopes(org_id,subject_type,subject_ref,actions,scope)
      VALUES ($1,'user',$2,ARRAY['import'],$3::jsonb)`, [ORG, actor, JSON.stringify({ userIds: [actor] })])
    const prepared = await invoke('prepare', {}, actor)
    expect(prepared).toMatchObject({ status: 200, body: { ok: true } })
    const before = await counts()
    const beforeCommits = commits
    const input = await payload({ timezone: 'Asia/Shanghai' })
    for (const entry of ['preview', 'commit', 'legacy']) {
      const result = await invoke(entry, { ...input, commitToken: prepared.body.data.commitToken,
        idempotencyKey: `synthetic-denied-${randomUUID()}` }, actor)
      expect({ status: result.status, body: result.body }).toEqual({
        status: 403, body: { ok: false, error: { code: 'SCHEDULER_SCOPE_FORBIDDEN',
          message: 'Scheduler scope does not allow this attendance scheduling action' } },
      })
      expect(await counts()).toEqual(before)
      expect(commits).toBe(beforeCommits)
    }
    await pool.query('DELETE FROM attendance_import_tokens WHERE user_id=$1', [actor])
    expect(providerIO).not.toHaveBeenCalled()
  })

  it('accounts for all persisted effects and proves no provider IO or async jobs', async () => {
    const result = { ...await counts(), coreHostCalls: commits, providerIO: providerIO.mock.calls.length }
    expect(result).toEqual({ records: 12, events: 0, batches: 12, items: 12, tokens: 0, jobs: 0,
      coreHostCalls: 12, providerIO: 0 })
    mkdirSync(new URL('../../../../artifacts/rule-overrides/', import.meta.url), { recursive: true })
    writeFileSync(new URL('../../../../artifacts/rule-overrides/pg-counts.json', import.meta.url),
      JSON.stringify(result, null, 2) + '\n')
  })
})
