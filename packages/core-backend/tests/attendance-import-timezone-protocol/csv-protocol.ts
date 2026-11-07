import { mkdirSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { AttendanceManagedPgPool, attendanceOwningSessionForClientV1 } from '../../src/attendance/attendance-owning-session'
import type { QueryConfig } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from './fixture'
import { createAttendanceSyncImportHostV1 } from '../../src/attendance/w4c3a-sync-import-host'
import { createAttendanceLegacyPlanReservationHostV1 } from '../../src/attendance/w4c3a-legacy-plan-reservation-host'
import type { ReserveAttendanceLegacyImportPlanFromHostInputV1 } from '../../src/attendance/w4c3a-legacy-plan-reservation-host'
import { createAttendanceLegacyPlanProcessorV1 } from '../../src/attendance/w4c3a-legacy-plan-processor'
import { createAttendanceLegacyPlanCommitConnectionV1 } from '../../src/attendance/w4c3a-legacy-plan-commit-connection'
import { buildAttendanceImportAttributionFreezeV1, buildAttendanceImportPolicySourceProofV1 } from '../../src/attendance/w4c3a-import-proof'
import { registerAttendanceRequestTimezoneSourceGuardV1 } from '../../src/attendance/attendance-business-trip-locks'
import { validateAttendanceIanaTimezoneV1, resolveAttendanceLocalWallTimeV1 } from '../../src/attendance/w4c1-strict-time'
import { issueAttendanceFrozenContextV1, resolveAttendanceW7GroupArmSelectionV1 } from '../../src/attendance/w7-resolver/w7-frozen-context-issuance-seam'
import { acquireAttendanceCalculationRolloutLock, parseCanonicalAttendanceRolloutOrgKeyV1, resolveSegmentCalculationPosture } from '../../src/attendance/w4c0-identity'
import { listActiveCurrentOpenRecordsForWorkDateResolverV1 } from '../../src/attendance/w4c3c-active-current'

process.env.ATTENDANCE_IMPORT_UPLOAD_DIR = path.resolve('artifacts/csv-calendar/uploads')
const plugin = require('../../../../plugins/plugin-attendance/index.cjs')
const OWNER = '00000000-0000-4000-8000-000000006032'
const ASYNC_IMPORTER = '00000000-0000-4000-8000-000000006033'
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
const sqlReads: string[] = []
const queuedJobs: string[] = []
let queueProcessor: ((job: { data: { jobId: string } }) => Promise<void>) | undefined
let commits = 0
type ImportHostInput = Parameters<ReturnType<typeof createAttendanceSyncImportHostV1>['commitSyncImportPlanV1']>[0]
const hostInputs: ImportHostInput[] = []
const reservationInputs: ReserveAttendanceLegacyImportPlanFromHostInputV1[] = []
const processorCalls: Array<{ jobId: string }> = []
const uploadedCsvSources = new Map<string, string>()

beforeAll(async () => {
  expect(process.env.RBAC_BYPASS).not.toBe('true')
  vi.stubGlobal('fetch', providerIO)
  await admin.query(`CREATE DATABASE ${database}`)
  pool = new AttendanceManagedPgPool(connection(database))
  await migrate(pool)
  await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic user')", [OWNER])
  await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [OWNER, ORG])
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,'attendance:admin')", [OWNER])
  await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic ordinary importer')", [ASYNC_IMPORTER])
  await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [ASYNC_IMPORTER, ORG])
  await pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,'attendance:import')", [ASYNC_IMPORTER])
  await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'attendance_importer')", [ASYNC_IMPORTER])
  await pool.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES ($1,'attendance',true)", [ASYNC_IMPORTER])
  await pool.query("INSERT INTO attendance_rules(name,org_id,timezone,is_default,work_start_time,work_end_time,working_days) VALUES ('synthetic rule',$1,'Asia/Shanghai',true,'00:00','23:59','[0,1,2,3,4,5,6]')", [ORG])
  const db = {
    query: async (sql: string | QueryConfig, params?: unknown[]) => {
      sqlReads.push(typeof sql === 'string' ? sql : sql.text)
      return (await (typeof sql === 'string' ? pool.query(sql, params) : pool.query(sql))).rows
    },
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
    services: { queue: {
      process: (_queue: string, _name: string, process: typeof queueProcessor) => { queueProcessor = process },
      add: async (_queue: string, _name: string, data: { jobId: string }) => { queuedJobs.push(data.jobId) },
    }, attendanceW4SegmentCalculation: {
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
      reserveLegacyImportPlan: async (input: ReserveAttendanceLegacyImportPlanFromHostInputV1) => {
        reservationInputs.push(structuredClone(input))
        const host = createAttendanceLegacyPlanReservationHostV1({ acquireConnection: async () => {
          const client = await pool.connect()
          return { client: createAttendanceLegacyPlanCommitConnectionV1(client), release: (error?: Error) => client.release(error) }
        } })
        return host.reserveLegacyImportPlanV1(input)
      },
      processLegacyImportPlan: async (input: { jobId: string }) => {
        processorCalls.push(structuredClone(input))
        const processor = createAttendanceLegacyPlanProcessorV1({ acquireConnection: async () => {
          const client = await pool.connect()
          return { client: createAttendanceLegacyPlanCommitConnectionV1(client), release: (error?: Error) => client.release(error) }
        } })
        const result = await processor.processLegacyImportPlanV1(input.jobId)
        expect(result.kind).toBe('completed')
        return result
      },
      commitSyncImportPlan: async (input: Parameters<ReturnType<typeof createAttendanceSyncImportHostV1>['commitSyncImportPlanV1']>[0]) => {
        commits++
        hostInputs.push(structuredClone(input))
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
  if (kind === 'CSV') return { userId: subject, csvText: `UserId,日期,上班1打卡时间,下班1打卡时间\n${subject},${Date.parse(instant)},${instant},${instant}\n` }

  throw new Error('CSV_PROTOCOL_UNSUPPORTED_KIND')
}

function assertPlanEvidence(plan: Pick<ImportHostInput, 'batch' | 'legacyRowSourceKind' | 'items' | 'recordWrites'>,
  payload: Record<string, unknown>, batch: string, day: string, instant: string,
  timezone: string, lastOut: string | null, expectedUser: string) {
  const csvFileId = typeof payload.csvFileId === 'string' ? payload.csvFileId : null
  const csvText = typeof payload.csvText === 'string' ? payload.csvText : uploadedCsvSources.get(csvFileId!)
  expect(csvText).toBeTypeOf('string')
  const hash = createHash('sha256').update(csvText!).digest('hex')
  const absent = { present: false, value: null }
  expect(plan.batch.sourceRowCount).toBe(1)
  expect(plan.legacyRowSourceKind).toBe(csvFileId ? 'uploaded_csv' : 'inline_csv')
  expect(plan.items.map(item => ({ kind: item.kind, ordinal: item.ordinal, semanticOrdinal: item.semanticOrdinal }))).toEqual([{ kind: 'apply', ordinal: 0, semanticOrdinal: 0 }])
  expect(plan.items[0].rawEvidence).toEqual({
    schemaVersion: 1, sourceOrdinal: 0,
    punches: [{ direction: 'check_in', occurredAt: instant }, { direction: 'check_out', occurredAt: lastOut }],
    fields: {
      userId: { present: true, value: expectedUser }, workDate: { present: true, value: day },
      timezone: absent, firstInAt: { present: true, value: instant }, lastOutAt: { present: true, value: lastOut },
      status: absent, isWorkday: absent,
    },
    metrics: { workMinutes: absent, lateMinutes: absent, earlyLeaveMinutes: absent, leaveMinutes: absent, overtimeMinutes: absent },
    provenance: {
      transport: csvFileId ? 'csv_upload' : 'csv_text',
      sourceRef: csvFileId ? 'attendance-import:' + batch + ':uploaded_csv:' + csvFileId : 'attendance-import:' + batch + ':inline_csv',
      artifactSha256: csvFileId ? hash : null, normalizedCsvSha256: hash, convertedSheetName: null,
    },
  })
  expect(plan.recordWrites.map(({ userId, workDate, sourceOrdinals, timezone: zone, firstInAt, lastOutAt }) =>
    ({ userId, workDate, sourceOrdinals, timezone: zone, firstInAt, lastOutAt }))).toEqual([
    { userId: expectedUser, workDate: day, sourceOrdinals: [0], timezone, firstInAt: instant, lastOutAt: lastOut },
  ])
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
  const plan = hostInputs[beforeCommits]
  assertPlanEvidence(plan, payload, batch, day, instant, timezone, lastOut, expectedUser)
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

it('valid CSV control reaches punch parsing without missing-field warnings', async () => {
  const payload = input('CSV')
  const control = await invoke('preview', { ...payload, csvText: payload.csvText!.replace(String(Date.parse(INSTANT)), '2026-09-23') })
  expect(control).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
  expect(control.body.data.items[0]).toMatchObject({ workDate: '2026-09-23', firstInAt: INSTANT, lastOutAt: INSTANT, warnings: [] })
})

describe('#6032 real handlers + PostgreSQL + real sync host', () => {
  for (const kind of ['CSV']) {
    it(`${kind}: preview -> prepare token -> commit persists local date and exact instant`, async () => {
      await commitAndAssert(input(kind), '2026-09-23', INSTANT, 'Asia/Shanghai', INSTANT)
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
      for (const kind of ['CSV']) {
        const payload = input(kind, '2026-09-23T02:30:00.000Z', subject)
        await commitAndAssert(payload, '2026-09-22', '2026-09-23T02:30:00.000Z', 'America/Los_Angeles', '2026-09-23T02:30:00.000Z', subject)
        await commitAndAssert({ ...await uploadedPayload(payload), userId: subject }, '2026-09-22', '2026-09-23T02:30:00.000Z', 'America/Los_Angeles', '2026-09-23T02:30:00.000Z', subject)
      }
    })
  }
})



async function createScopeOnlyActor() {
  const actor = randomUUID()
  await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic scoped actor')", [actor])
  await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [actor, ORG])
  await pool.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES ($1,'attendance',true)", [actor])
  await pool.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'attendance_employee')", [actor])
  await pool.query("INSERT INTO role_permissions(role_id,permission_code) VALUES ('attendance_employee','attendance:read'),('attendance_employee','attendance:write') ON CONFLICT DO NOTHING")
  await pool.query("INSERT INTO attendance_scheduler_scopes(org_id,subject_type,subject_ref,actions,scope) VALUES ($1,'user',$2,ARRAY['import'],$3::jsonb)", [ORG, actor, JSON.stringify({ userIds: [actor] })])
  expect((await pool.query('SELECT role FROM users WHERE id=$1', [actor])).rows).toEqual([{ role: 'user' }])
  expect((await pool.query('SELECT count(*)::int n FROM user_permissions WHERE user_id=$1', [actor])).rows).toEqual([{ n: 0 }])
  expect((await pool.query('SELECT role_id FROM user_roles WHERE user_id=$1', [actor])).rows).toEqual([{ role_id: 'attendance_employee' }])
  expect((await pool.query('SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=$1 ORDER BY rp.permission_code', [actor])).rows).toEqual([{ permission_code: 'attendance:read' }, { permission_code: 'attendance:write' }])
  return actor
}

async function uploadedPayload(payload: ReturnType<typeof input>, expectedRowCount = 1, uploader = OWNER) {
  const req = Object.assign(Readable.from([Buffer.from(payload.csvText!)]), { user: { id: uploader, orgId: ORG }, headers: { 'content-type': 'text/csv' }, query: {}, params: {} })
  const res = { statusCode: 200, body: null as unknown, headersSent: false,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; this.headersSent = true; return this },
  }
  await routes.get('POST /api/attendance/import/upload')!(req, res)
  expect(res).toMatchObject({ statusCode: 201, body: { ok: true, data: { rowCount: expectedRowCount } } })
  const fileId = (res.body as { data: { fileId: string } }).data.fileId
  uploadedCsvSources.set(fileId, payload.csvText!)
  return { userId: OWNER, csvFileId: fileId }
}

it('uploaded CSV uses the same effective day through real upload, preview and streamed commit', async () => {
  const instant = '2026-09-23T16:30:00.123Z'
  await commitAndAssert(await uploadedPayload(input('CSV', instant)), '2026-09-24', instant, 'Asia/Shanghai', instant)
})

  it('keeps scope denial ahead of an invisible subject calendar ambiguity', async () => {
    const actor = await createScopeOnlyActor()
    const subject = randomUUID()
    await pool.query("INSERT INTO users(id,name) VALUES ($1,'synthetic invisible subject')", [subject])
    await pool.query('INSERT INTO user_orgs(user_id,org_id) VALUES ($1,$2)', [subject, ORG])
    expect(await invoke('prepare', {}, actor)).toMatchObject({ status: 200, body: { ok: true } })
    await pool.query('DELETE FROM attendance_import_tokens WHERE user_id=$1', [actor])
    const beforeBatches = (await pool.query('SELECT count(*)::int n FROM attendance_import_batches')).rows
    const payload = input('CSV', '2026-09-23T02:30:00Z', subject)
    const denied = { ok: false, error: { code: 'SCHEDULER_SCOPE_FORBIDDEN', message: 'Scheduler scope does not allow this attendance scheduling action' } }
    for (const path of ['preview', 'commit', 'legacy']) {
      const control = await invoke(path, { rows: [{ userId: subject, workDate: '2026-09-22', fields: { firstInAt: '19:30' } }] }, actor)
      expect({ status: control.status, body: control.body }).toEqual({ status: 403, body: denied })
    }
    for (const [day, zone] of [['2026-09-22', 'America/Los_Angeles'], ['2026-09-23', 'Asia/Shanghai']]) {
      const shift = randomUUID()
      await pool.query("INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days) VALUES ($1,$2,'synthetic ambiguous shift',$3,'00:00','23:59','[0,1,2,3,4,5,6]')", [shift, ORG, zone])
      await pool.query("INSERT INTO attendance_shift_assignments(org_id,user_id,shift_id,start_date,end_date,publish_status) VALUES ($1,$2,$3,$4,$4,'published')", [ORG, subject, shift, day])
      await pool.query("INSERT INTO attendance_shift_segments(org_id,shift_id,segment_index,start_time,end_time) VALUES ($1,$2,0,'00:00','12:00'),($1,$2,1,'13:00','23:59')", [ORG, shift])
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


describe('real asynchronous CSV preview admission and processing', () => {
  for (const uploaded of [false, true]) {
    for (const autoAssignMembers of [false, true]) {
      it('normalizes ' + (uploaded ? 'uploaded' : 'inline') + ' CSV with member preflight ' + autoAssignMembers, async () => {
        const csvInput = input('CSV')
        const payload = uploaded ? await uploadedPayload(csvInput) : csvInput
        const response = await invoke('preview-async', { ...payload, groupSync: { autoCreate: false, autoAssignMembers }, previewLimit: 10 })
        expect(response).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
        const jobId = (response.body.data as unknown as { job: { id: string } }).job.id
        expect(queuedJobs.filter(id => id === jobId)).toEqual([jobId])
        expect(queueProcessor).toBeTypeOf('function')
        await queueProcessor!({ data: { jobId } })
        const job = (await pool.query('SELECT status,error,payload,progress,total FROM attendance_import_jobs WHERE id=$1', [jobId])).rows[0]
        expect({ status: job.status, error: job.error, progress: job.progress, total: job.total }).toEqual({ status: 'completed', error: null, progress: 1, total: 1 })
        expect(job.payload.previewResult.items.map(({ userId, workDate, warnings }: { userId: string; workDate: string; warnings: unknown[] }) => ({ userId, workDate, warnings }))).toEqual([{ userId: OWNER, workDate: '2026-09-23', warnings: [] }])
        expect(errors).toEqual([])
        expect(providerIO).not.toHaveBeenCalled()
      })
    }
  }
  it('denies scope-only actors at both async entrypoints before calendar reads or job writes', async () => {
    const actor = await createScopeOnlyActor()
    const beforeJobs = (await pool.query('SELECT count(*)::int n FROM attendance_import_jobs')).rows
    const beforeQueued = queuedJobs.length
    for (const endpoint of ['preview-async', 'commit-async']) {
      sqlReads.length = 0
      const denied = await invoke(endpoint, input('CSV'), actor)
      expect({ status: denied.status, body: denied.body }).toEqual({ status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } } })
      expect(sqlReads.filter(sql => /FROM attendance_(?:rules|rotation_assignments|shift_assignments)/.test(sql))).toEqual([])
    }
    expect((await pool.query('SELECT count(*)::int n FROM attendance_import_jobs')).rows).toEqual(beforeJobs)
    expect(queuedJobs).toHaveLength(beforeQueued)
  })
})


describe('real asynchronous CSV commit reservation and core processor', () => {
  for (const uploaded of [false, true]) {
    it('persists the frozen calendar for ' + (uploaded ? 'uploaded' : 'inline') + ' CSV and replays idempotently', async () => {
      const instant = uploaded ? '2026-09-26T16:30:00.123Z' : '2026-09-25T16:30:00.123Z'
      const day = uploaded ? '2026-09-27' : '2026-09-26'
      const csvInput = input('CSV', instant)
      const payload = uploaded ? await uploadedPayload(csvInput, 1, ASYNC_IMPORTER) : csvInput
      const prepared = await invoke('prepare', {}, ASYNC_IMPORTER)
      expect(prepared).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
      const token = prepared.body.data.commitToken
      const idempotencyKey = 'synthetic-csv-async-' + randomUUID()
      const beforeReservations = reservationInputs.length
      const beforeProcessors = processorCalls.length
      const beforeCommits = commits
      const countEffects = async () => (await pool.query(`SELECT
        (SELECT count(*)::int FROM attendance_records) records,
        (SELECT count(*)::int FROM attendance_import_batches) batches,
        (SELECT count(*)::int FROM attendance_import_items) items`)).rows[0]
      const beforeEffects = await countEffects()
      const response = await invoke('commit-async', { ...payload, commitToken: token, idempotencyKey }, ASYNC_IMPORTER)
      expect(response).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
      const jobId = (response.body.data as unknown as { job: { id: string } }).job.id
      expect(queuedJobs.filter(id => id === jobId)).toEqual([jobId])
      expect(reservationInputs).toHaveLength(beforeReservations + 1)
      expect(processorCalls).toHaveLength(beforeProcessors)
      expect(commits).toBe(beforeCommits)
      expect(await countEffects()).toEqual(beforeEffects)
      expect((await pool.query('SELECT count(*)::int n FROM attendance_import_tokens WHERE token=$1', [token])).rows).toEqual([{ n: 0 }])
      const plan = reservationInputs[beforeReservations]
      expect({ actorId: plan.actorId, actorPosture: plan.actorPosture }).toEqual({ actorId: ASYNC_IMPORTER, actorPosture: 'attendance_admin' })
      expect((await pool.query('SELECT role FROM users WHERE id=$1', [ASYNC_IMPORTER])).rows).toEqual([{ role: 'user' }])
      expect((await pool.query('SELECT role_id FROM user_roles WHERE user_id=$1 ORDER BY role_id', [ASYNC_IMPORTER])).rows).toEqual([{ role_id: 'attendance_importer' }])
      expect((await pool.query('SELECT permission_code FROM user_permissions WHERE user_id=$1 ORDER BY permission_code', [ASYNC_IMPORTER])).rows).toEqual([{ permission_code: 'attendance:import' }])
      expect((await pool.query('SELECT namespace,enabled FROM user_namespace_admissions WHERE user_id=$1', [ASYNC_IMPORTER])).rows).toEqual([{ namespace: 'attendance', enabled: true }])
      assertPlanEvidence(plan, payload, plan.batchId, day, instant, 'Asia/Shanghai', instant, OWNER)
      const queued = (await pool.query('SELECT status,error,w4_contract_version,payload FROM attendance_import_jobs WHERE id=$1', [jobId])).rows[0]
      expect({ status: queued.status, error: queued.error, version: queued.w4_contract_version }).toEqual({ status: 'queued', error: null, version: 1 })
      for (const key of ['csvText', 'rows', 'entries', 'commitToken']) expect(queued.payload).not.toHaveProperty(key)
      await queueProcessor!({ data: { jobId } })
      expect(processorCalls.slice(beforeProcessors)).toEqual([{ jobId }])
      const done = (await pool.query('SELECT status,error,w4_contract_version FROM attendance_import_jobs WHERE id=$1', [jobId])).rows[0]
      expect(done).toEqual({ status: 'completed', error: null, w4_contract_version: 1 })
      const stored = (await pool.query(`SELECT r.work_date::text AS day, r.timezone, r.first_in_at AS instant, r.last_out_at AS last_out,
        i.work_date::text AS item_day FROM attendance_records r JOIN attendance_import_items i ON i.record_id=r.id WHERE i.batch_id=$1`, [plan.batchId])).rows
      expect(stored.map(row => ({ ...row, instant: row.instant.toISOString(), last_out: row.last_out.toISOString() }))).toEqual([
        { day, timezone: 'Asia/Shanghai', instant, last_out: instant, item_day: day },
      ])
      expect(await countEffects()).toEqual({ records: beforeEffects.records + 1, batches: beforeEffects.batches + 1, items: beforeEffects.items + 1 })
      const replay = await invoke('commit-async', { ...payload, idempotencyKey }, ASYNC_IMPORTER)
      expect(replay).toMatchObject({ status: 200, body: { ok: true, data: { idempotent: true, job: { id: jobId } } }, errors: [] })
      await queueProcessor!({ data: { jobId } })
      expect(reservationInputs).toHaveLength(beforeReservations + 1)
      expect(processorCalls.slice(beforeProcessors)).toEqual([{ jobId }])
      expect(queuedJobs.filter(id => id === jobId)).toEqual([jobId])
      expect(commits).toBe(beforeCommits)
      expect(await countEffects()).toEqual({ records: beforeEffects.records + 1, batches: beforeEffects.batches + 1, items: beforeEffects.items + 1 })
      expect(errors).toEqual([])
      expect(providerIO).not.toHaveBeenCalled()
    })
  }
})

it('characterizes real streamed normalization for 1001 distinct subjects without record writes', async () => {
  const subjects = Array.from({ length: 1001 }, () => randomUUID())
  await pool.query("INSERT INTO users(id,name) SELECT id,'synthetic scale subject' FROM unnest($1::text[]) ids(id)", [subjects])
  await pool.query('INSERT INTO user_orgs(user_id,org_id) SELECT id,$2 FROM unnest($1::text[]) ids(id)', [subjects, ORG])
  const csvText = 'UserId,日期,上班1打卡时间,下班1打卡时间\n'
    + subjects.map(id => id + ',' + Date.parse(INSTANT) + ',' + INSTANT + ',' + INSTANT).join('\n') + '\n'
  const payload = await uploadedPayload({ userId: OWNER, csvText }, subjects.length)
  sqlReads.length = 0
  const started = performance.now()
  const response = await invoke('preview-async', { ...payload, previewLimit: 1 })
  expect(response).toMatchObject({ status: 200, body: { ok: true }, errors: [] })
  const jobId = (response.body.data as unknown as { job: { id: string } }).job.id
  await queueProcessor!({ data: { jobId } })
  const job = (await pool.query('SELECT status,error,payload,total FROM attendance_import_jobs WHERE id=$1', [jobId])).rows[0]
  expect({ status: job.status, error: job.error, total: job.total }).toEqual({ status: 'completed', error: null, total: 1001 })
  expect(job.payload.previewResult.items.map(({ userId, workDate }: { userId: string; workDate: string }) => ({ userId, workDate }))).toEqual([{ userId: subjects[0], workDate: '2026-09-23' }])
  const report = {
    subjects: 1001, elapsedMs: Math.round(performance.now() - started), statements: sqlReads.length,
    shiftReads: sqlReads.filter(sql => /FROM attendance_shift_assignments a/.test(sql)).length,
    rotationReads: sqlReads.filter(sql => /FROM attendance_rotation_assignments a/.test(sql)).length,
    holidayReads: sqlReads.filter(sql => /FROM attendance_holidays/.test(sql)).length,
    functionalResult: 'passed', performanceGate: 'characterization_only',
  }
  const file = new URL('../../../../artifacts/csv-calendar/scale-characterization.json', import.meta.url)
  mkdirSync(new URL('./', file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
})

it('accounts for committed CSV rows and forbids provider IO', async () => {
  const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM attendance_records) records,
    (SELECT count(*)::int FROM attendance_import_batches) batches,
    (SELECT count(*)::int FROM attendance_import_items) items,
    (SELECT count(*)::int FROM attendance_import_tokens) tokens,
    (SELECT count(*)::int FROM attendance_import_jobs) jobs`)).rows[0]
  expect({ ...counts, commits, providerIO: providerIO.mock.calls.length }).toEqual({ records: 6, batches: 8, items: 8, tokens: 0, jobs: 7, commits: 6, providerIO: 0 })
})
