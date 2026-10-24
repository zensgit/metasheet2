import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { clearTimeout as realClearTimeout, setTimeout as realSetTimeout } from 'node:timers'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { resolveAttendanceLocalWallTimeV1, validateAttendanceIanaTimezoneV1 } from '../../src/attendance/w4c1-strict-time'
import { acquireAttendanceTimezoneRuntimeLocksV1 } from '../../src/attendance/attendance-timezone-runtime-locks'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('DAILY_CALENDAR_REAL_POSTGRES_REQUIRED')
const require = createRequire(import.meta.url)
const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
const { loadDailyCalendarDefaultRule, loadDailyCalendarOrgPlans } = require('../../../../plugins/plugin-attendance/lib/attendance-daily-calendar.cjs')
const schema = 'daily_calendar_' + randomUUID().replace(/-/g, '')
const bootstrap = new Pool({ connectionString: process.env.ATTENDANCE_TEST_DATABASE_URL, max: 1 })
const pool = new Pool({ connectionString: process.env.ATTENDANCE_TEST_DATABASE_URL, max: 4,
  options: '-c search_path=' + schema + ',pg_catalog' })
const orgId = 'daily-pg-org', actorId = 'daily-pg-admin'
const strictTime = { validateIanaTimezone: validateAttendanceIanaTimezoneV1, resolveLocalWallTime: resolveAttendanceLocalWallTimeV1 }
interface Db {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>
  transaction(work: (trx: Db) => Promise<unknown>): Promise<unknown>
}
const transactions: string[] = []
const sqlFailures: string[] = []
let onDefaultRead = async (_org: string) => {}
function adapter(client?: PoolClient): Db {
  return {
    query: async (sql, params) => {
      try {
        const rows = (await (client ?? pool).query(sql, params)).rows
        if (sql.includes('SELECT * FROM attendance_rules WHERE org_id = $1 AND is_default = true')) await onDefaultRead(String(params?.[0]))
        return rows
      }
      catch (error) { sqlFailures.push(sql); throw error }
    },
    transaction: async work => {
      const connection = await pool.connect()
      try {
        await connection.query('BEGIN'); transactions.push('BEGIN')
        const result = await work(adapter(connection))
        await connection.query('COMMIT'); transactions.push('COMMIT')
        return result
      } catch (error) {
        await connection.query('ROLLBACK'); transactions.push('ROLLBACK'); throw error
      } finally { connection.release() }
    },
  }
}
const db = adapter()
const now = '2026-09-22T15:30:00Z'
function response() {
  return { statusCode: 200, body: undefined as unknown, headersSent: false,
    status(code: number) { this.statusCode = code; return this },
    json(value: unknown) { this.body = value; this.headersSent = true; return this },
  }
}
type Handler = (req: Record<string, unknown>, res: ReturnType<typeof response>, next: () => void) => Promise<void>
const routes = new Map<string, Handler>()
const boundary = { resolvesScheduledTimezone: true, executeScheduledRun: vi.fn(async (_input: Record<string, unknown>): Promise<{ kind: string; rows: unknown[]; targetCount: number }> => { throw new Error('BUSINESS_EXECUTION_FORBIDDEN') }) }
let expectedBoundaryCalls: unknown[][] = []
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
let timeout: MockInstance<Parameters<typeof setTimeout>, ReturnType<typeof setTimeout>>
let clear: MockInstance<Parameters<typeof clearTimeout>, ReturnType<typeof clearTimeout>>
async function settled(predicate: () => boolean) {
  for (let index = 0; index < 200 && !predicate(); index += 1) await new Promise(resolve => realSetTimeout(resolve, 10))
  expect(predicate(), JSON.stringify({warnings:logger.warn.mock.calls,errors:logger.error.mock.calls,sqlFailures,timers:timeout?.mock.calls.map(c => c[1])})).toBe(true)
}
function timer(delay: number) {
  const index = timeout.mock.calls.findIndex(call => call[1] === delay)
  expect(index).toBeGreaterThanOrEqual(0)
  return timeout.mock.results[index].value
}
async function activate(instant = now, expectedDelay = 45 * 60000) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(instant))
  vi.stubEnv('RBAC_BYPASS', 'false'); vi.stubEnv('RBAC_TOKEN_TRUST', 'false')
  plugin.resetAttendanceSettingsCacheForTests()
  timeout = vi.spyOn(globalThis, 'setTimeout'); clear = vi.spyOn(globalThis, 'clearTimeout')
  await plugin.activate({ api: { database: db, events: { emit: vi.fn() }, http: {
    addRoute: (method: string, path: string, handler: Handler) => routes.set(method + ' ' + path, handler),
  } }, logger, services: { attendanceW4SegmentCalculation: {
    ...strictTime, acquireTimezoneRuntimeLocks: acquireAttendanceTimezoneRuntimeLocksV1,
    resolveTimezoneSegmentReferencePosture: async () => ({ referenceSegments: false }),
    applyMergePolicyPure: vi.fn(), computeOuterSourceDefinitionFingerprintV1: vi.fn(), issueAttendanceFrozenContextV1: vi.fn(),
    createLiveScheduledBoundary: () => boundary,
    resolveOrgSegmentCalculationPosture: async () => ({ effectiveState: 'legacy', referenceSegments: false }),
    createRequestOperationBoundary: () => ({ execute: async () => { throw new Error('BUSINESS_EXECUTION_FORBIDDEN') } }),
  } } })
  await settled(() => timeout.mock.calls.some(call => call[1] === expectedDelay))
}
async function put(body: Record<string, unknown>, path = '/api/attendance/rules/default', targetOrg = orgId) {
  const handler = routes.get('PUT ' + path)
  expect(handler).toBeTypeOf('function')
  const res = response()
  await handler!({ body, params: {}, query: {}, headers: {}, user: { id: actorId, orgId: targetOrg }, get: () => undefined }, res, () => {})
  return res
}
async function insertRule(org: string, timezone: string | null, isDefault = true) {
  await pool.query(`INSERT INTO attendance_rules(id,org_id,name,timezone,work_start_time,work_end_time,working_days,is_default)
    VALUES($1,$2,'daily synthetic',$3,'09:00','18:00','[]'::jsonb,$4)`, [randomUUID(), org, timezone, isDefault])
}

// Narrow SQL-shape fixture, not a production migration/HTTP-auth/W4 writer gate.
// Empty published/frozen/trip sources + OFF timezone policy keep this registered PUT
// on its real configuration transaction and real source-guard SQL without app boot.
beforeAll(async () => {
  await bootstrap.query('CREATE SCHEMA ' + schema)
  await pool.query(`
    CREATE TABLE users(id text PRIMARY KEY,is_active boolean NOT NULL);
    CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean);
    CREATE TABLE user_roles(user_id text,role_id text);
    CREATE TABLE user_permissions(user_id text,permission_code text);
    CREATE TABLE role_permissions(role_id text,permission_code text);
    CREATE TABLE system_configs(key text PRIMARY KEY,value text,is_encrypted boolean DEFAULT false,updated_at timestamptz DEFAULT now(),description text);
    CREATE TABLE attendance_rules(id text PRIMARY KEY,org_id text,name text,timezone text,timezone_version integer DEFAULT 1,
      work_start_time text,work_end_time text,working_days jsonb,is_default boolean,
      late_grace_minutes integer DEFAULT 10,early_grace_minutes integer DEFAULT 10,
      severe_late_threshold_minutes integer DEFAULT 30,absence_late_threshold_minutes integer DEFAULT 60,rounding_minutes integer DEFAULT 5);
    CREATE TABLE attendance_calculation_group_memberships(org_id text,effective_from date,effective_to date);
    CREATE TABLE attendance_timezone_policies(org_id text,enabled boolean,version integer);
    CREATE TABLE attendance_shifts(id text,org_id text,name text,timezone text,work_start_time text,work_end_time text,
      is_overnight boolean,late_grace_minutes integer,early_grace_minutes integer,rounding_minutes integer,working_days jsonb);
    CREATE TABLE attendance_shift_segments(org_id text,shift_id text);
    CREATE TABLE attendance_shift_assignments(id text,org_id text,user_id text,shift_id text,slot_index integer,start_date date,end_date date,
      is_active boolean,publish_status text,publish_batch_id text,publish_requested_at timestamptz,publish_requested_by text,
      published_at timestamptz,published_by text,locked_at timestamptz,reopened_from_assignment_id text,assignment_kind text,
      temporary_mode text,temporary_replaces_kind text,temporary_replaces_assignment_id text,temporary_reason text,
      temporary_created_by text,temporary_created_at timestamptz,created_at timestamptz);
    CREATE TABLE attendance_rotation_rules(id text,org_id text,name text,timezone text,shift_sequence jsonb,is_active boolean);
    CREATE TABLE attendance_rotation_assignments(id text,org_id text,user_id text,rotation_rule_id text,start_date date,end_date date,
      is_active boolean,publish_status text,publish_batch_id text,publish_requested_at timestamptz,publish_requested_by text,
      published_at timestamptz,published_by text,locked_at timestamptz,reopened_from_assignment_id text,created_at timestamptz);
    CREATE TABLE attendance_holidays(id text,org_id text,holiday_date date,name text,is_working_day boolean,origin text);
    CREATE TABLE attendance_records(id text,org_id text,user_id text,work_date date,timezone text,meta jsonb,
      current_calculation_id text,first_in_at timestamptz,last_out_at timestamptz,visibility_state text);
    CREATE TABLE attendance_timezone_context_companions(record_id text,org_id text,frame_snapshot jsonb,context_fingerprint text);
    CREATE TABLE attendance_record_calculations(id text,attendance_record_id text,org_id text,attribution_snapshot jsonb,context_snapshot jsonb);
    CREATE TABLE attendance_business_trip_arrangements(request_id text,org_id text,user_id text,start_at timestamptz,effective_end_at timestamptz);
    CREATE TABLE attendance_import_jobs(id uuid,org_id text,w4_contract_version integer,created_at timestamptz,status text);
    CREATE TABLE attendance_import_upload_cleanup_commands(job_id uuid,org_id text,created_at timestamptz,status text,lease_expires_at timestamptz);
    CREATE TABLE reject_rule_commit(enabled boolean NOT NULL);
    INSERT INTO reject_rule_commit VALUES(false);
    CREATE FUNCTION reject_daily_rule_commit() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF (SELECT enabled FROM reject_rule_commit) THEN
          RAISE EXCEPTION 'DAILY_SYNTHETIC_DEFERRED_CONSTRAINT' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END $fn$;
    CREATE CONSTRAINT TRIGGER daily_rule_deferred_check AFTER INSERT ON attendance_rules
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_daily_rule_commit();
    CREATE CONSTRAINT TRIGGER daily_settings_deferred_check AFTER UPDATE ON system_configs
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_daily_rule_commit();
  `)
}, 30000)
beforeEach(async () => {
  await pool.query('UPDATE reject_rule_commit SET enabled=false')
  await pool.query('TRUNCATE attendance_rules,users,user_orgs,user_permissions,user_roles,role_permissions,system_configs')
  await pool.query('INSERT INTO users VALUES($1,true)', [actorId])
  await pool.query('INSERT INTO user_orgs VALUES($1,$2,true)', [actorId,orgId])
  await pool.query("INSERT INTO user_permissions VALUES($1,'attendance:admin')", [actorId])
  await pool.query('INSERT INTO system_configs(key,value) VALUES($1,$2)', ['attendance.settings',JSON.stringify({ autoAbsence: { enabled: true, runAt: '00:15', lookbackDays: 1 } })])
  await insertRule(orgId,'Asia/Shanghai')
  routes.clear(); transactions.length = 0; sqlFailures.length = 0
  onDefaultRead = async (_org: string) => {}; expectedBoundaryCalls = []
  boundary.executeScheduledRun.mockImplementation(async () => { throw new Error('BUSINESS_EXECUTION_FORBIDDEN') })
})
afterEach(async () => {
  await plugin.deactivate(); plugin.resetAttendanceSettingsCacheForTests()
  if (expectedBoundaryCalls.length === 0) expect(boundary.executeScheduledRun).not.toHaveBeenCalled()
  else expect(boundary.executeScheduledRun.mock.calls).toEqual(expectedBoundaryCalls)
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks()
})
afterAll(async () => { await pool.end(); await bootstrap.query('DROP SCHEMA ' + schema + ' CASCADE'); await bootstrap.end() })

describe('daily calendar actual PostgreSQL SQL and registered default-rule PUT', () => {
  it.each([false, true])('PG_ORG_SCOPED_REARM: A COMMIT rejection=%s preserves B due refresh and its pending timer', async reject => {
    const sibling = reject ? 'daily-pg-due-b-rollback' : 'daily-pg-due-b-commit'
    await insertRule(sibling, 'UTC')
    await activate('2026-09-23T00:14:00Z', 60000)
    await settled(() => timeout.mock.calls.some(call => call[1] === 16 * 3600000 + 60000))
    const aTimer = timer(16 * 3600000 + 60000), bTimer = timer(60000)
    const oldRows = (await pool.query('SELECT * FROM attendance_rules ORDER BY id')).rows
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    onDefaultRead = async org => { if (org === sibling) { entered(); await gate } }
    boundary.executeScheduledRun.mockResolvedValue({ kind: 'w4', rows: [], targetCount: 0 })
    vi.setSystemTime(new Date('2026-09-23T00:15:00Z'))
    realClearTimeout(bTimer) // Invoke the captured due callback without leaving its real handle queued.
    const due = (timeout.mock.calls[timeout.mock.results.findIndex(result => result.value === bTimer)][0] as () => Promise<void>)()
    try {
      await started
      await pool.query('UPDATE reject_rule_commit SET enabled=$1', [reject])
      const res = await put({ timezone: 'Pacific/Kiritimati', workingDays: [] })
      expect(res.statusCode, JSON.stringify({body:res.body,sqlFailures})).toBe(reject ? 500 : 200)
      expect(transactions).toEqual(['BEGIN', reject ? 'ROLLBACK' : 'COMMIT'])
      if (reject) {
        expect((await pool.query('SELECT * FROM attendance_rules ORDER BY id')).rows).toEqual(oldRows)
        expect(clear).not.toHaveBeenCalledWith(aTimer)
      } else {
        await settled(() => clear.mock.calls.some(call => call[0] === aTimer))
        expect((await pool.query('SELECT timezone FROM attendance_rules WHERE org_id=$1 AND is_default=true', [orgId])).rows).toEqual([{timezone:'Pacific/Kiritimati'}])
      }
      expectedBoundaryCalls = [[{ orgId: sibling, workDate: '2026-09-22', targetUserIds: [], reviewTargets: [], initiator: 'cron', legacyDedupHit: false, adminActorId: null }]]
      release(); await due
      expect(boundary.executeScheduledRun.mock.calls).toEqual(expectedBoundaryCalls)
      expect(clear).not.toHaveBeenCalledWith(bTimer)
      expect(timeout.mock.calls.filter(call => call[1] === 86400000)).toHaveLength(1)
      if (!reject) await settled(() => timeout.mock.calls.some(call => call[1] === 10 * 3600000))
      expect(sqlFailures).toEqual([])
    } finally { release(); await due }
  })
  it('PG_SAME_ORG_REARM: committed A invalidates only A pending refresh and B still runs', async () => {
    const sibling = 'daily-pg-same-clock-b'
    await pool.query('UPDATE attendance_rules SET timezone=$1 WHERE org_id=$2', ['UTC', orgId])
    await insertRule(sibling, 'UTC')
    await activate('2026-09-23T00:14:00Z', 60000)
    await settled(() => timeout.mock.calls.filter(call => call[1] === 60000).length === 2)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const initial = timeout.mock.calls.map((call,index) => ({call,handle:timeout.mock.results[index].value})).filter(item => item.call[1] === 60000)
    // Resolve order of the actual DISTINCT result by observing the scoped default reads.
    const seen: string[] = []
    let held = false
    onDefaultRead = async org => { seen.push(org); if (org === orgId && !held) { held = true; entered(); await gate } }
    boundary.executeScheduledRun.mockResolvedValue({ kind: 'w4', rows: [], targetCount: 0 })
    vi.setSystemTime(new Date('2026-09-23T00:15:00Z'))
    for (const item of initial) realClearTimeout(item.handle)
    const pending = initial.map(item => (item.call[0] as () => Promise<void>)())
    try {
      await started
      await settled(() => boundary.executeScheduledRun.mock.calls.length === 1)
      expect(seen.slice(0, 2).sort()).toEqual([orgId, sibling].sort())
      const res = await put({ timezone: 'Pacific/Kiritimati', workingDays: [] })
      expect(res.statusCode).toBe(200)
      expect(transactions).toEqual(['BEGIN','COMMIT'])
      expectedBoundaryCalls = [[{ orgId: sibling, workDate: '2026-09-22', targetUserIds: [], reviewTargets: [], initiator: 'cron', legacyDedupHit: false, adminActorId: null }]]
      release(); await Promise.all(pending)
      expect(boundary.executeScheduledRun.mock.calls).toEqual(expectedBoundaryCalls)
      await settled(() => timeout.mock.calls.some(call => call[1] === 10 * 3600000))
      expect(timeout.mock.calls.filter(call => call[1] === 86400000)).toHaveLength(1)
      expect(sqlFailures).toEqual([])
    } finally { release(); await Promise.all(pending) }
  })
  it.each([false,true])('PG_NEW_ORG_REARM: new organization COMMIT rejection=%s changes only its plan', async reject => {
    const created = 'daily-pg-new-org'
    await pool.query('INSERT INTO user_orgs VALUES($1,$2,true)', [actorId, created])
    await activate()
    const old = timer(45 * 60000)
    const count = timeout.mock.calls.filter(call => Number(call[1]) >= 60000).length
    await pool.query('UPDATE reject_rule_commit SET enabled=$1', [reject])
    const res = await put({ timezone: 'UTC', workingDays: [] }, '/api/attendance/rules/default', created)
    expect(res.statusCode, JSON.stringify({body:res.body,errors:logger.error.mock.calls,sqlFailures})).toBe(reject ? 500 : 200)
    expect(transactions).toEqual(['BEGIN',reject ? 'ROLLBACK' : 'COMMIT'])
    expect(clear).not.toHaveBeenCalledWith(old)
    const rows = (await pool.query('SELECT org_id FROM attendance_rules WHERE org_id=$1', [created])).rows
    expect(rows).toHaveLength(reject ? 0 : 1)
    if (reject) expect(timeout.mock.calls.filter(call => Number(call[1]) >= 60000)).toHaveLength(count)
    else await settled(() => timeout.mock.calls.some(call => call[1] === 8 * 3600000 + 45 * 60000))
    expect(sqlFailures).toEqual([])
  })
  it('loads DISTINCT real organization rows without inventing a default org', async () => {
    await insertRule('daily-pg-foreign','Pacific/Kiritimati')
    await insertRule('daily-pg-foreign','UTC',false)
    await insertRule('','UTC'); await insertRule(' padded ','UTC')
    const warn = vi.fn()
    expect((await loadDailyCalendarOrgPlans(db,warn)).map((p: {orgId: string}) => p.orgId).sort()).toEqual(['daily-pg-foreign',orgId].sort())
    expect(warn.mock.calls).toEqual([['DAILY_CALENDAR_ORG_INVALID'],['DAILY_CALENDAR_ORG_INVALID']])
    await pool.query('TRUNCATE attendance_rules')
    expect(await loadDailyCalendarOrgPlans(db,warn)).toEqual([])
  })
  it('reads the actual org-scoped default and validates raw timezone before mapping', async () => {
    await insertRule('daily-pg-foreign','UTC')
    const map = vi.fn((row: Record<string, unknown>) => ({ orgId: row.org_id, timezone: row.timezone }))
    expect(await loadDailyCalendarDefaultRule(db,orgId,strictTime,map)).toEqual({orgId,timezone:'Asia/Shanghai'})
    expect(map).toHaveBeenCalledTimes(1)
  })
  it.each(['missing','conflict','null','invalid'])('real SQL %s default fails closed before the mapper', async kind => {
    if (kind === 'missing') await pool.query('DELETE FROM attendance_rules WHERE org_id=$1',[orgId])
    else if (kind === 'conflict') await insertRule(orgId,'UTC')
    else await pool.query('UPDATE attendance_rules SET timezone=$1 WHERE org_id=$2',[kind === 'null' ? null : 'Invalid/Zone',orgId])
    const map = vi.fn()
    await expect(loadDailyCalendarDefaultRule(db,orgId,strictTime,map)).rejects.toThrow()
    expect(map).not.toHaveBeenCalled()
  })
  it('the real registered PUT commits its SQL and only then rearms the real planner', async () => {
    await activate()
    const old = timer(45 * 60000)
    const res = await put({timezone:'UTC',workingDays:[]})
    expect({status:res.statusCode,body:res.body}, JSON.stringify({errors:logger.error.mock.calls,sqlFailures})).toMatchObject({status:200,body:{ok:true,data:{orgId,timezone:'UTC',isDefault:true}}})
    expect(transactions).toEqual(['BEGIN','COMMIT'])
    await settled(() => timeout.mock.calls.some(call => call[1] === 8 * 3600000 + 45 * 60000))
    expect(clear).toHaveBeenCalledWith(old)
    expect((await pool.query('SELECT timezone FROM attendance_rules WHERE org_id=$1 AND is_default=true',[orgId])).rows).toEqual([{timezone:'UTC'}])
    expect(sqlFailures).toEqual([])
  })
  it('a PostgreSQL deferred COMMIT failure rolls back rules and preserves the exact old timer', async () => {
    await activate()
    const old = timer(45 * 60000), count = timeout.mock.calls.filter(call => Number(call[1]) >= 60000).length
    const before = (await pool.query('SELECT * FROM attendance_rules ORDER BY id')).rows
    await pool.query('UPDATE reject_rule_commit SET enabled=true')
    const res = await put({timezone:'UTC',workingDays:[]})
    expect(res).toMatchObject({statusCode:500,body:{ok:false,error:{code:'INTERNAL_ERROR'}}})
    expect(transactions).toEqual(['BEGIN','ROLLBACK'])
    expect((await pool.query('SELECT * FROM attendance_rules ORDER BY id')).rows).toEqual(before)
    expect(clear).not.toHaveBeenCalledWith(old)
    expect(timeout.mock.calls.filter(call => Number(call[1]) >= 60000)).toHaveLength(count)
    expect(logger.error.mock.calls[0][1]).toMatchObject({code:'23514'})
    expect(sqlFailures).toEqual([])
  })
  it.each([false,true])('registered settings PUT with real PG commit rejection=%s changes timers only on success', async reject => {
    await activate()
    const old = timer(45 * 60000), count = timeout.mock.calls.filter(call => Number(call[1]) >= 60000).length
    const before = (await pool.query('SELECT value FROM system_configs')).rows
    await pool.query('UPDATE reject_rule_commit SET enabled=$1',[reject])
    const res = await put({autoAbsence:{runAt:'01:15'}},'/api/attendance/settings')
    expect(res.statusCode,JSON.stringify({body:res.body,sqlFailures})).toBe(reject ? 500 : 200)
    expect(transactions).toEqual(['BEGIN',reject ? 'ROLLBACK' : 'COMMIT'])
    if (reject) {
      expect((await pool.query('SELECT value FROM system_configs')).rows).toEqual(before)
      expect(clear).not.toHaveBeenCalledWith(old)
      expect(timeout.mock.calls.filter(call => Number(call[1]) >= 60000)).toHaveLength(count)
      expect(logger.error.mock.calls[0][1]).toMatchObject({code:'23514'})
    } else {
      await settled(() => timeout.mock.calls.some(call => call[1] === 105 * 60000))
      expect(clear).toHaveBeenCalledWith(old)
      expect(JSON.parse((await pool.query('SELECT value FROM system_configs')).rows[0].value).autoAbsence.runAt).toBe('01:15')
    }
    expect(sqlFailures).toEqual([])
  })

})
