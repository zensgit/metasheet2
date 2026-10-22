import path from 'node:path'
import net from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { PoolClient, QueryConfig } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from './fixture'
import { createAttendanceSyncImportHostV1 } from '../../src/attendance/w4c3a-sync-import-host'
import { buildAttendanceImportAttributionFreezeV1, buildAttendanceImportPolicySourceProofV1 } from '../../src/attendance/w4c3a-import-proof'
import { registerAttendanceRequestTimezoneSourceGuardV1 } from '../../src/attendance/attendance-business-trip-locks'
import { validateAttendanceIanaTimezoneV1, resolveAttendanceLocalWallTimeV1 } from '../../src/attendance/w4c1-strict-time'
import { issueAttendanceFrozenContextV1, resolveAttendanceW7GroupArmSelectionV1 } from '../../src/attendance/w7-resolver/w7-frozen-context-issuance-seam'
import { acquireAttendanceCalculationRolloutLock, parseCanonicalAttendanceRolloutOrgKeyV1, resolveSegmentCalculationPosture } from '../../src/attendance/w4c0-identity'
import { listActiveCurrentOpenRecordsForWorkDateResolverV1 } from '../../src/attendance/w4c3c-active-current'

const artifact = process.env.CALENDAR_DENIAL_EVIDENCE_DIR || path.resolve(__dirname, '../../../../artifacts/6032/calendar-denial')
mkdirSync(artifact, { recursive: true })
if (!process.env.DATABASE_URL) throw new Error('ATTENDANCE_IMPORT_TIMEZONE_PROTOCOL_REQUIRES_DATABASE_URL')
const databaseEndpoint = new URL(process.env.DATABASE_URL)
const setupStartedAt = Date.now()
const setupStages: Array<{ phase: string; elapsedMs: number }> = []
function phase(name: string) {
  setupStages.push({ phase: name, elapsedMs: Date.now() - setupStartedAt })
  writeFileSync(path.join(artifact, 'setup-stages.json'), JSON.stringify(setupStages, null, 2))
}
const authorizationSchemaErrors: string[] = []
async function queryRows(client: Pool | PoolClient, sql: string | QueryConfig, params?: unknown[]) {
  try {
    return (await (typeof sql === 'string' ? client.query(sql, params) : client.query(sql))).rows
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? '')
    const text = typeof sql === 'string' ? sql : sql.text
    if (['42703', '42P01'].includes(code) && /\b(users|roles)\b/i.test(text)) authorizationSchemaErrors.push(code)
    throw error
  }
}
const observations: Array<Record<string, unknown>> = []
let setupComplete = false
let blockedNetwork = 0
const realConnect = net.Socket.prototype.connect
vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
  const first = args[0] as number | { host?: string; port?: number }
  const host = typeof first === 'number' ? args[1] : first?.host
  const port = typeof first === 'number' ? first : first?.port
  if (host !== databaseEndpoint.hostname || Number(port) !== Number(databaseEndpoint.port || 5432)) {
    blockedNetwork++
    throw new Error('NON_SYNTHETIC_NETWORK_FORBIDDEN')
  }
  return realConnect.apply(this, args as Parameters<typeof realConnect>)
})
const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
const OWNER = '00000000-0000-4000-8000-000000006032'
const ORG = '00000000-0000-4000-8000-000000016032'
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
  phase('before_all')
  expect(process.env.RBAC_BYPASS).not.toBe('true')
  expect(process.env.ATTENDANCE_IMPORT_COPY_STREAM_MODE ?? 'off').toBe('off')
  vi.stubGlobal('fetch', providerIO)
  phase('create_database_start')
  await admin.query(`CREATE DATABASE ${database}`)
  phase('create_database_complete')
  pool = new Pool(connection(database))
  phase('migrations_start')
  await migrate(pool)
  phase('migrations_complete')
  writeFileSync(path.join(artifact, 'migration-proof.json'), JSON.stringify({ appliedProductionMigrationCount: 28, setupFixture: 'attendance-import-timezone-protocol/fixture.ts', isolatedCluster: true }, null, 2))
  await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic user')", [OWNER])
  await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [OWNER, ORG])
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,'attendance:admin')", [OWNER])
  await pool.query("INSERT INTO attendance_rules(name,org_id,timezone,is_default,work_start_time,work_end_time,working_days) VALUES ('synthetic rule',$1,'Asia/Shanghai',true,'00:00','23:59','[0,1,2,3,4,5,6]')", [ORG])
  const db = {
    query: async (sql: string | QueryConfig, params?: unknown[]) => queryRows(pool, sql, params),
    transaction: async (work: (trx: unknown) => Promise<unknown>) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work({ __rawClient: client, query: async (sql: string | QueryConfig, params?: unknown[]) => queryRows(client, sql, params) })
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
  phase('plugin_activated')
  await setupReviewFixtures()
  phase('scenario_fixture_complete')
  setupComplete = true
  phase('setup_complete')
}, 120000)

afterAll(async () => {
  await plugin.deactivate()
  registerAttendanceRequestTimezoneSourceGuardV1(null)
  await pool?.end()
  await admin.query(`DROP DATABASE IF EXISTS ${database}`)
  await admin.end()
  writeFileSync(path.join(artifact, 'observations.json'), JSON.stringify({ setupComplete, authorizationSchemaErrors, commits, providerIO: providerIO.mock.calls.length, blockedNetwork, observations }, null, 2))
  vi.restoreAllMocks()
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


const ACTOR = randomUUID()
const subjects = { invisible: randomUUID(), neighbor: randomUUID(), matching: randomUUID() }
const INSTANT_REVIEW = '2026-09-23T02:30:00.000Z'
const MATCH_DAY = '2026-09-22'
const NONMATCH_DAY = '2026-09-24'
const DENIED = { ok: false, error: { code: 'SCHEDULER_SCOPE_FORBIDDEN', message: 'Scheduler scope does not allow this attendance scheduling action' } }
const SEGMENT_DENIED = { ok: false, error: {
  code: 'ATTENDANCE_SHIFT_MULTI_SEGMENT_CALCULATION_DISABLED',
  message: 'Shift has 2 segments; authoritative segment calculation is disabled for this org, so attendance calculation cannot use a multi-segment shift',
  details: [{ field: 'shiftId', message: 'Multi-segment shift is authoring preview-only while segment calculation is disabled' }],
} }

async function publishedShift(subject: string, day: string, zone: string, segmentCount: number) {
  const shift = randomUUID()
  await pool.query("INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days) VALUES ($1,$2,'synthetic review shift',$3,'00:00','23:59','[0,1,2,3,4,5,6]')", [shift, ORG, zone])
  await pool.query("INSERT INTO attendance_shift_assignments(org_id,user_id,shift_id,start_date,end_date,publish_status) VALUES ($1,$2,$3,$4,$4,'published')", [ORG, subject, shift, day])
  for (let index = 0; index < segmentCount; index++) {
    await pool.query('INSERT INTO attendance_shift_segments(org_id,shift_id,segment_index,start_time,end_time) VALUES ($1,$2,$3,$4,$5)',
      [ORG, shift, index, index === 0 ? '00:00' : '13:00', segmentCount === 1 || index === 1 ? '23:59' : '12:00'])
  }
  expect((await pool.query('SELECT count(*)::int n FROM attendance_shift_segments WHERE shift_id=$1 AND org_id=$2', [shift, ORG])).rows).toEqual([{ n: segmentCount }])
}

async function setupReviewFixtures() {
  for (const subject of [ACTOR, ...Object.values(subjects)]) {
    await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic review identity')", [subject])
    await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [subject, ORG])
  }
  await pool.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES ($1,'attendance',true)", [ACTOR])
  await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'attendance_employee')", [ACTOR])
  await pool.query("INSERT INTO role_permissions(role_id,permission_code) VALUES ('attendance_employee','attendance:read'),('attendance_employee','attendance:write') ON CONFLICT DO NOTHING")
  await pool.query("INSERT INTO attendance_scheduler_scopes(org_id,subject_type,subject_ref,actions,scope) VALUES ($1,'user',$2,ARRAY['import'],$3::jsonb)", [ORG, ACTOR, JSON.stringify({ userIds: [ACTOR] })])
  expect((await pool.query('SELECT count(*)::int n FROM user_permissions WHERE user_id=$1', [ACTOR])).rows).toEqual([{ n: 0 }])
  expect((await pool.query('SELECT count(*)::int n FROM user_roles WHERE user_id=ANY($1::text[])', [[OWNER, ...Object.values(subjects)]])).rows).toEqual([{ n: 0 }])
  expect((await pool.query('SELECT role FROM users WHERE id=$1', [OWNER])).rows).toEqual([{ role: 'user' }])
  expect((await pool.query('SELECT role_id FROM user_roles WHERE user_id=$1', [ACTOR])).rows).toEqual([{ role_id: 'attendance_employee' }])
  expect((await pool.query("SELECT enabled FROM user_namespace_admissions WHERE user_id=$1 AND namespace='attendance'", [ACTOR])).rows).toEqual([{ enabled: true }])
  expect((await pool.query('SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=$1 ORDER BY rp.permission_code', [ACTOR])).rows).toEqual([{ permission_code: 'attendance:read' }, { permission_code: 'attendance:write' }])
  expect((await pool.query("SELECT count(*)::int n FROM roles WHERE id='attendance_admin'")).rows).toEqual([{ n: 1 }])
  await publishedShift(subjects.invisible, MATCH_DAY, 'America/Los_Angeles', 2)
  await publishedShift(subjects.neighbor, MATCH_DAY, 'America/Los_Angeles', 1)
  await publishedShift(subjects.neighbor, NONMATCH_DAY, 'Asia/Shanghai', 2)
  await publishedShift(subjects.matching, MATCH_DAY, 'America/Los_Angeles', 2)
  const shanghaiDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(INSTANT_REVIEW))
  expect(shanghaiDay).toBe('2026-09-23')
  expect(shanghaiDay).not.toBe(NONMATCH_DAY)
  expect((await pool.query('SELECT count(*)::int n FROM attendance_calculation_rollout_state')).rows).toEqual([{ n: 0 }])
  writeFileSync(path.join(artifact, 'fixture-proof.json'), JSON.stringify({ realRBAC: true, scopeActorNamespaceEnabled: true, scopeActorRole: 'attendance_employee', scopeActorGlobalImport: false, noRolloutRows: true, singleMatchingPublishedDay: MATCH_DAY, discardedNeighborDay: NONMATCH_DAY, neighborZoneMapsInstantTo: shanghaiDay, sourceMutation: false, providerServices: 'not registered', eventDelivery: 'memory stub' }, null, 2))
}

function reviewPayload(kind: string, subject: string, explicitDate = false) {
  if (explicitDate) return { userId: subject, rows: [{ userId: subject, workDate: MATCH_DAY, fields: { firstInAt: INSTANT_REVIEW } }] }
  if (kind === 'entries') return { userId: subject, entries: [{ userId: subject, occurredAt: INSTANT_REVIEW, field: 'firstInAt' }] }
  return { userId: subject, rows: [{ userId: subject, workDate: String(Date.parse(INSTANT_REVIEW) / (kind === 'JSON10' ? 1000 : 1)), fields: { firstInAt: INSTANT_REVIEW } }] }
}

async function state() {
  const counts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM attendance_records) records,
    (SELECT count(*)::int FROM attendance_import_batches) batches,
    (SELECT count(*)::int FROM attendance_import_items) items,
    (SELECT count(*)::int FROM attendance_import_jobs) jobs,
    (SELECT count(*)::int FROM attendance_import_tokens) tokens`)).rows[0]
  return { ...counts, commits, events: events.length }
}

async function runCase(name: string, route: string, payload: Record<string, unknown>, actor: string, expected: '403' | '422' | '200') {
  const prepared = await invoke('prepare', {}, actor)
  expect(prepared).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
  const token = prepared.body.data.commitToken
  expect(token).toBeTypeOf('string')
  const before = await state()
  try {
    const result = await invoke(route, { ...payload, commitToken: token }, actor)
    const after = await state()
    observations.push({ name, route, expected, actualStatus: result.status, error: result.body.error ?? null, loggerErrorCount: result.errors.length, before, after })
    expect(result.errors, `${name}: runtime logger must be empty`).toEqual([])
    expect(authorizationSchemaErrors, `${name}: auth readers must not use schema-error fallback`).toEqual([])
    expect(providerIO, `${name}: provider IO forbidden`).not.toHaveBeenCalled()
    expect(blockedNetwork, `${name}: outside network forbidden`).toBe(0)
    // Scope denials precede token consumption. Authorized calculation failures
    // retain the existing route order and configured token requirement.
    if (expected !== '200' || result.status !== 200) {
      const consumesToken = route === 'commit' || process.env.ATTENDANCE_IMPORT_REQUIRE_TOKEN === '1'
      const expectedState = expected === '422' && consumesToken ? { ...before, tokens: before.tokens - 1 } : before
      expect(after, `${name}: denied inputs must not write records, batches or jobs`).toEqual(expectedState)
    }
    if (expected === '403') {
      expect({ status: result.status, body: result.body }, `${name}: scope denial must precede segment gate`).toEqual({ status: 403, body: DENIED })
    } else if (expected === '422') {
      expect({ status: result.status, body: result.body }, `${name}: actual matching multi-segment shift must remain gated`).toEqual({ status: 422, body: SEGMENT_DENIED })
    } else {
      expect(result.status, `${name}: discarded neighbor must not block the matching day`).toBe(200)
      expect(result.body.ok).toBe(true)
      if (route === 'preview') {
        expect(result.body.data.items).toHaveLength(1)
        expect(result.body.data.items[0]).toMatchObject({ userId: subjects.neighbor, workDate: MATCH_DAY, firstInAt: INSTANT_REVIEW })
      } else {
        expect(result.body.data).toMatchObject({ imported: 1, failedRows: 0 })
        expect(commits).toBe(before.commits + 1)
        const stored = (await pool.query('SELECT user_id,work_date::text AS day,timezone,first_in_at FROM attendance_records WHERE user_id=$1 AND org_id=$2', [subjects.neighbor, ORG])).rows
        expect(stored.map(row => ({ ...row, first_in_at: row.first_in_at.toISOString() }))).toEqual([{ user_id: subjects.neighbor, day: MATCH_DAY, timezone: 'America/Los_Angeles', first_in_at: INSTANT_REVIEW }])
      }
    }
  } finally {
    await pool.query('DELETE FROM attendance_import_tokens WHERE token=$1', [token])
  }
}

for (const route of ['preview', 'commit', 'legacy']) {
  it(`CONTROL selected date-only ${route}: retain exact 422 and configured token order`, () => runCase(`control-selected-${route}`, route, reviewPayload('JSON13', subjects.matching, true), OWNER, '422'))
}

for (const kind of ['JSON10', 'JSON13', 'entries']) {
  for (const route of ['preview', 'commit', 'legacy']) {
    it(`CONTROL invisible date-only ${kind} ${route}: exact 403`, () => runCase(`control-invisible-${kind}-${route}`, route, reviewPayload(kind, subjects.invisible, true), ACTOR, '403'))
    it(`CONTROL legal date-only ${kind} ${route}: real host 200`, () => runCase(`control-legal-${kind}-${route}`, route, reviewPayload(kind, subjects.neighbor, true), OWNER, '200'))
    it(`R1 invisible multi-segment ${kind} ${route}: require 403 before segment 422`, () => runCase(`R1-${kind}-${route}`, route, reviewPayload(kind, subjects.invisible), ACTOR, '403'))
    it(`R2 discarded neighbor multi-segment ${kind} ${route}: require legal 200`, () => runCase(`R2-${kind}-${route}`, route, reviewPayload(kind, subjects.neighbor), OWNER, '200'))
    it(`R3 visible matching multi-segment ${kind} ${route}: preserve exact gate 422`, () => runCase(`R3-${kind}-${route}`, route, reviewPayload(kind, subjects.matching), OWNER, '422'))
  }
}
it('INVARIANTS real host exercised, no provider/outside-network IO, no job or rollout activation', async () => {
  expect(commits).toBe(12)
  expect(authorizationSchemaErrors).toEqual([])
  expect(providerIO).not.toHaveBeenCalled()
  expect(blockedNetwork).toBe(0)
  expect((await pool.query('SELECT count(*)::int n FROM attendance_import_jobs')).rows).toEqual([{ n: 0 }])
  expect((await pool.query('SELECT count(*)::int n FROM attendance_import_tokens')).rows).toEqual([{ n: 0 }])
  expect((await pool.query('SELECT count(*)::int n FROM attendance_calculation_rollout_state')).rows).toEqual([{ n: 0 }])
})
