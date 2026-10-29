import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { buildAttendanceTimezoneRuntimeOrgLockKeyV1 } from '../../src/attendance/attendance-timezone-runtime-locks'
import { buildAttendanceW7MembershipTimelineLockKeyV1 } from '../../src/attendance/w7-resolver/w7-composite-lock-order'
import { createRequire } from 'node:module'
import type { AttendanceW4LiveScheduledBoundaryV1 } from '../../src/attendance/w4c2-live-scheduled-boundary'
import { calculateAttendanceSegmentsV1 } from '../../src/attendance/w4c1-segment-calculator'
import { insertShadowCalculationV1, type ShadowCalculationRowInputV1 } from '../../src/attendance/w4c2-shadow-calculation-core'
import { createOnlinePunchDbFixture, punchClock, punchPlugin } from '../utils/attendance-online-punch-db'

// Observe the factory used by actual plugin activation; every call delegates to
// the unchanged production factory with its real pool and production adapters.
const observed = vi.hoisted(() => ({ boundary: null as AttendanceW4LiveScheduledBoundaryV1 | null }))
vi.mock('../../src/attendance/w4c2-live-scheduled-boundary', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/attendance/w4c2-live-scheduled-boundary')>()
  return { ...actual, createAttendanceLiveScheduledBoundaryV1: (...args: Parameters<typeof actual.createAttendanceLiveScheduledBoundaryV1>) => {
    const boundary = actual.createAttendanceLiveScheduledBoundaryV1(...args)
    observed.boundary = boundary
    return boundary
  } }
})

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('ATTENDANCE_TIMEZONE_SCHEDULED_REAL_DATABASE_REQUIRED')
const fixture = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
const requireCjs = createRequire(import.meta.url)
const tripClock = requireCjs('../../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs') as {
  setBusinessTripInstantForTests(value: string | null): void
}
type Actor = Awaited<ReturnType<typeof fixture.user>>
type RunResult = { skipped: boolean; total: number; targetUsers: number; generated: number; reviewRequired: unknown[] }
const plugin = punchPlugin as unknown as {
  __attendanceWorkDateResolverForTests: {
    runAutoAbsenceForOrgDate(db: { query(text: string, values?: unknown[]): Promise<unknown[]> }, options: {
      orgId: string; workDate: string; skipDedup: boolean; initiator: 'cron';
      w4Boundary: AttendanceW4LiveScheduledBoundaryV1; recoveryRunId?: string;
    }): Promise<RunResult>
  }
}
let admin: Actor
const priorAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED

async function policy(enabled: boolean) {
  await fixture.pool.query(`INSERT INTO attendance_timezone_policies(org_id,enabled,version,updated_by)
    VALUES($1,$2,1,$3) ON CONFLICT(org_id) DO UPDATE SET enabled=$2,
    version=attendance_timezone_policies.version+1,updated_by=$3`, [fixture.orgId,enabled,admin.userId])
}
async function employeeZone(actor: Actor, timezone: string) {
  await fixture.pool.query(`INSERT INTO attendance_employee_timezone_overrides
    (org_id,user_id,timezone,effective_from,created_by,updated_by)
    VALUES($1,$2,$3,'2026-01-01T00:00:00Z',$4,$4)`, [fixture.orgId,actor.userId,timezone,admin.userId])
}
async function assignment(actor: Actor, workDate: string, timezone = 'Asia/Tokyo') {
  const shiftId = randomUUID()
  await fixture.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,working_days)
    VALUES($1,$2,'scheduled timezone synthetic',$3,'09:00','18:00','[0,1,2,3,4,5,6]'::jsonb)`, [shiftId,fixture.orgId,timezone])
  await fixture.pool.query(`INSERT INTO attendance_shift_assignments
    (id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status)
    VALUES($1,$2,$3,$4,$5,$5,true,'published')`, [randomUUID(),fixture.orgId,actor.userId,shiftId,workDate])
  return shiftId
}
async function adminRun(workDate: string) {
  return fixture.request('/api/attendance/auto-absence/run',admin.token,{orgId:fixture.orgId,workDate})
}
async function cronRun(workDate: string, recoveryRunId?: string) {
  expect(observed.boundary?.resolvesScheduledTimezone).toBe(true)
  return plugin.__attendanceWorkDateResolverForTests.runAutoAbsenceForOrgDate({
    query: async (text,values) => (await fixture.pool.query(text,values)).rows,
  }, {orgId:fixture.orgId,workDate,skipDedup:true,initiator:'cron',
    w4Boundary:observed.boundary!,...(recoveryRunId === undefined ? {} : {recoveryRunId})})
}
async function records(workDate: string) {
  return (await fixture.pool.query(`SELECT user_id,timezone,status,is_workday FROM attendance_records
    WHERE org_id=$1 AND work_date=$2 ORDER BY user_id`, [fixture.orgId,workDate])).rows
}
async function companions(workDate: string) {
  return (await fixture.pool.query(`SELECT c.* FROM attendance_timezone_context_companions c
    WHERE c.org_id=$1 AND c.work_date=$2 ORDER BY c.user_id`, [fixture.orgId,workDate])).rows
}
async function assertFrozenTarget(actor: Actor, workDate: string, timezone: string) {
  const response = await fixture.request('/api/attendance/timezone-context/me?workDate='+workDate,actor.token,undefined,'GET')
  expect(response.status,response.body.error?.code).toBe(200)
  const row = (await companions(workDate)).find(value => value.user_id === actor.userId)
  expect(row).toBeDefined()
  const frame = row.frame_snapshot
  expect(response.body).toEqual({ok:true,data:{
    orgId:fixture.orgId,userId:actor.userId,workDate,timezone,contextFingerprint:row.context_fingerprint,
    frozen:true,referenceId:row.record_id,provenance:frame.timezoneContext,
    window:{startAt:row.absolute_start_at.toISOString(),endAt:row.absolute_end_at.toISOString()},
    rule:frame.context.rule,isWorkingDay:true,
  }})
}
async function rollout(target: 'shadow' | 'authoritative') {
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
  await fixture.pool.query(`INSERT INTO attendance_calculation_rollout_state
    (org_id,state,engine_version,reason_code,actor_id,version,prior_state)
    VALUES($1,'legacy','scheduled-timezone-test','TEST_FIXTURE',$2,1,NULL)
    ON CONFLICT(org_id) DO NOTHING`, [fixture.orgId,admin.userId])
  const states = ['legacy','shadow','eligible','authoritative']
  const current = (await fixture.pool.query('SELECT state,version FROM attendance_calculation_rollout_state WHERE org_id=$1',[fixture.orgId])).rows[0]
  let version = Number(current.version)
  for (let index=states.indexOf(current.state)+1;index<=states.indexOf(target);index+=1) {
    await fixture.pool.query('UPDATE attendance_calculation_rollout_state SET state=$2,prior_state=$3,version=$4 WHERE org_id=$1',
      [fixture.orgId,states[index],states[index-1],++version])
  }
}


// PIDs and lock metadata are used only inside the probe; failures report codes,
// never the query text, connection identity, or server activity contents.
async function waitForBlockedBackend(blockerPid: number) {
  const deadline = Date.now()+5000
  while (Date.now()<deadline) {
    const result = await fixture.pool.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
        AND $1=ANY(pg_blocking_pids(pid)) ORDER BY pid`,[blockerPid])
    if (result.rows.length === 1) return Number(result.rows[0].pid)
    if (result.rows.length > 1) throw new Error('SCHEDULED_TIMEZONE_CONTENTION_NOT_UNIQUE')
    await new Promise(resolve => setTimeout(resolve,20))
  }
  throw new Error('SCHEDULED_TIMEZONE_EXPECTED_CONTENTION')
}
function snapshotDigest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
async function scheduledRunState(workDate: string) {
  return (await fixture.pool.query(`SELECT run_id,state,expected_user_count,review_count,
    completed_user_count,generated_count,target_set_fingerprint
    FROM attendance_scheduled_runs WHERE org_id=$1 AND work_date=$2 AND initiator='cron'`,
  [fixture.orgId,workDate])).rows
}
async function targetDurableState(runId: string) {
  const values = [fixture.orgId,runId]
  const rows = await fixture.pool.query(`SELECT t.user_id,r.id AS record_id,c.id AS calculation_id,
    o.terminal_outcome,op.state AS operation_state
    FROM attendance_scheduled_run_targets t
    LEFT JOIN attendance_scheduled_run_target_outcomes o ON o.org_id=t.org_id AND o.target_id=t.id
    LEFT JOIN attendance_result_operations op ON op.org_id=t.org_id AND op.operation_id=t.operation_id
    LEFT JOIN attendance_record_calculations c ON c.org_id=t.org_id AND c.operation_id=t.operation_id
    LEFT JOIN attendance_records r ON r.id=c.attendance_record_id AND r.org_id=t.org_id
    WHERE t.org_id=$1 AND t.run_id=$2 ORDER BY t.ordinal`,values)
  return rows.rows
}

describe('scheduled absence uses the production timezone runtime (HTTP/PostgreSQL)', () => {
  beforeAll(async () => {
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    punchClock.setOnlinePunchInstantForTests('2026-01-01T00:00:00Z')
    tripClock.setBusinessTripInstantForTests('2026-01-01T00:00:00Z')
    admin = await fixture.start()
    expect(observed.boundary?.resolvesScheduledTimezone).toBe(true)
  },180_000)
  beforeEach(async () => {
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    // A run visits active org members, so previous cases must not grow this
    // case's target set. Keep the real authenticated administrator active.
    await fixture.pool.query('UPDATE user_orgs SET is_active=(user_id=$2) WHERE org_id=$1',[fixture.orgId,admin.userId])
    await fixture.pool.query('DELETE FROM attendance_timezone_policies WHERE org_id=$1',[fixture.orgId])
    punchClock.setOnlinePunchInstantForTests('2026-01-01T00:00:00Z')
    tripClock.setBusinessTripInstantForTests('2026-01-01T00:00:00Z')
  })
  afterAll(async () => {
    tripClock.setBusinessTripInstantForTests(null)
    if (priorAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlist
    await fixture.stop()
  },60_000)

  it('OFF admin HTTP freezes org default for every user despite employee and published-shift zones', async () => {
    const workDate = '2026-01-12'
    const tokyo = await fixture.user(), newYork = await fixture.user()
    await employeeZone(tokyo,'Asia/Tokyo')
    await employeeZone(newYork,'America/New_York')
    await assignment(tokyo,workDate,'Asia/Tokyo')
    const result = await adminRun(workDate)
    expect({status:result.status,body:result.body}).toEqual({status:200,body:{ok:true,data:{
      skipped:false,total:3,targetUsers:3,generated:3,reviewRequired:[],
    }}})
    expect(await records(workDate)).toEqual([admin,tokyo,newYork].map(actor => ({
      user_id:actor.userId,timezone:'UTC',status:'absent',is_workday:true,
    })).sort((a,b) => a.user_id.localeCompare(b.user_id)))
    for (const actor of [admin,tokyo,newYork]) await assertFrozenTarget(actor,workDate,'UTC')
    expect((await companions(workDate)).map(row => ({timezone:row.timezone,source:row.frame_snapshot.timezoneContext.source,
      mode:row.frame_snapshot.timezoneContext.mode,calculationId:row.original_calculation_id})))
      .toEqual(Array.from({length:3},() => ({timezone:'UTC',source:'system_default',mode:'default_only',calculationId:null})))
  })

  it('ON real cron caller uses each employee zone and an actually approved effective trip', async () => {
    const workDate = '2026-01-21'
    const tokyo = await fixture.user(), newYork = await fixture.user(), traveler = await fixture.user()
    await policy(true)
    await employeeZone(tokyo,'Asia/Tokyo')
    await employeeZone(newYork,'America/New_York')
    // UTC midnight does not cut Tokyo (00–09Z) or Singapore (01–10Z) shifts.
    await employeeZone(traveler,'Asia/Tokyo')
    const flow = await fixture.request('/api/attendance/approval-flows',admin.token,{
      orgId:fixture.orgId,name:'scheduled synthetic trip',requestType:'business_trip',steps:[{approverUserIds:[admin.userId]}],
    })
    expect(flow.status,flow.body.error?.code).toBe(201)
    const made = await fixture.request('/api/attendance/business-trip-requests',traveler.token,{
      destinationTimezone:'Asia/Singapore',startAt:'2026-01-20T00:00:00Z',endAt:'2026-01-23T00:00:00Z',approvalFlowId:flow.body.data.id,
    })
    expect(made.status,made.body.error?.code).toBe(201)
    const requestId = made.body.data.request.id
    const approved = await fixture.request('/api/attendance/requests/'+requestId+'/approve',admin.token,{})
    expect({status:approved.status,statusValue:approved.body.data?.status},approved.body.error?.code).toEqual({status:200,statusValue:'approved'})
    expect((await fixture.pool.query('SELECT request_id,destination_timezone FROM attendance_business_trip_arrangements WHERE org_id=$1 AND request_id=$2',
      [fixture.orgId,requestId])).rows).toEqual([{request_id:requestId,destination_timezone:'Asia/Singapore'}])
    expect(await cronRun(workDate)).toEqual({skipped:false,total:4,targetUsers:4,generated:4,reviewRequired:[]})
    const targets: Array<[Actor,string,string]> = [[admin,'UTC','system_default'],[tokyo,'Asia/Tokyo','employee_override'],
      [newYork,'America/New_York','employee_override'],[traveler,'Asia/Singapore','trip']]
    expect(await records(workDate)).toEqual(targets.map(([actor,timezone]) => ({
      user_id:actor.userId,timezone,status:'absent',is_workday:true,
    })).sort((a,b) => a.user_id.localeCompare(b.user_id)))
    for (const [actor,timezone,source] of targets) {
      await assertFrozenTarget(actor,workDate,timezone)
      const row = (await companions(workDate)).find(value => value.user_id === actor.userId)
      expect({timezone:row.timezone,source:row.frame_snapshot.timezoneContext.source}).toEqual({timezone,source})
    }
  })

  it('an existing legacy row is skipped byte-for-byte without fabricating a companion', async () => {
    const workDate = '2026-02-02'
    const actor = await fixture.user()
    await fixture.pool.query(`INSERT INTO attendance_records(user_id,org_id,work_date,timezone,status,is_workday,work_minutes)
      VALUES($1,$2,$3,'Asia/Tokyo','normal',true,480)`,[actor.userId,fixture.orgId,workDate])
    const before = (await fixture.pool.query('SELECT * FROM attendance_records WHERE org_id=$1 AND user_id=$2 AND work_date=$3',
      [fixture.orgId,actor.userId,workDate])).rows
    const result = await adminRun(workDate)
    expect({status:result.status,body:result.body}).toEqual({status:200,body:{ok:true,data:{
      skipped:false,total:1,targetUsers:2,generated:1,reviewRequired:[],
    }}})
    expect((await fixture.pool.query('SELECT * FROM attendance_records WHERE org_id=$1 AND user_id=$2 AND work_date=$3',
      [fixture.orgId,actor.userId,workDate])).rows).toEqual(before)
    expect((await companions(workDate)).filter(row => row.user_id === actor.userId)).toEqual([])
  })

  it('a real companion INSERT failure rolls the whole legacy batch back; retry then freezes all targets', async () => {
    const workDate = '2026-02-03'
    const actor = await fixture.user()
    const guard = 'scheduled_timezone_bind_'+randomUUID().replaceAll('-','')
    await fixture.pool.query(`CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $guard$
      BEGIN IF NEW.org_id='${fixture.orgId}' AND NEW.user_id='${actor.userId}' THEN
      RAISE EXCEPTION 'SYNTHETIC_COMPANION_FAILURE' USING ERRCODE='23514'; END IF; RETURN NEW; END $guard$`)
    await fixture.pool.query(`CREATE TRIGGER ${guard} BEFORE INSERT ON attendance_timezone_context_companions
      FOR EACH ROW EXECUTE FUNCTION ${guard}()`)
    try {
      const result = await adminRun(workDate)
      expect({status:result.status,body:result.body}).toEqual({status:503,body:{ok:false,error:{
        code:'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',message:'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',
      }}})
      expect(await records(workDate)).toEqual([])
      expect(await companions(workDate)).toEqual([])
      expect((await fixture.pool.query('SELECT count(*)::int AS count FROM attendance_events WHERE org_id=$1 AND work_date=$2',
        [fixture.orgId,workDate])).rows).toEqual([{count:0}])
    } finally {
      await fixture.pool.query(`DROP TRIGGER ${guard} ON attendance_timezone_context_companions`)
      await fixture.pool.query(`DROP FUNCTION ${guard}()`)
    }
    const retry = await adminRun(workDate)
    expect({status:retry.status,body:retry.body}).toEqual({status:200,body:{ok:true,data:{
      skipped:false,total:2,targetUsers:2,generated:2,reviewRequired:[],
    }}})
    await assertFrozenTarget(actor,workDate,'UTC')
  })


  it.each(['policy','group_membership'] as const)('scheduled holds the exclusive org prefix before a real %s writer can proceed', async writerKind => {
    const workDate = writerKind === 'policy' ? '2026-02-10' : '2026-02-11'
    const actor = await fixture.user()
    let groupId: string | undefined
    if (writerKind === 'group_membership') {
      const made = await fixture.request('/api/attendance/groups',admin.token,{
        orgId:fixture.orgId,name:'scheduled contention synthetic',timezone:'UTC',attendanceType:'fixed_shift',
      })
      expect(made.status,made.body.error?.code).toBe(200)
      groupId = made.body.data.id
    }
    const blocker = await fixture.pool.connect()
    let running: Promise<RunResult> | undefined
    let writing: ReturnType<typeof fixture.request> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[
        buildAttendanceW7MembershipTimelineLockKeyV1(fixture.orgId,actor.userId),
      ])
      const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      running = cronRun(workDate)
      void running.catch(() => {})
      const scheduledPid = await waitForBlockedBackend(blockerPid)
      // Shared try-lock fails only if scheduled already owns the EXCLUSIVE org
      // prefix, before reaching the blocked membership timeline or source reads.
      expect((await fixture.pool.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS acquired',[
        buildAttendanceTimezoneRuntimeOrgLockKeyV1(fixture.orgId),
      ])).rows).toEqual([{acquired:false}])
      writing = writerKind === 'policy'
        ? fixture.request('/api/attendance/timezone-policy',admin.token,{enabled:false,expectedVersion:0},'PUT')
        : fixture.request('/api/attendance/groups/'+groupId+'/members',admin.token,{userIds:[actor.userId]})
      void writing.catch(() => {})
      await waitForBlockedBackend(scheduledPid)
      expect(await records(workDate)).toEqual([])
      expect(await companions(workDate)).toEqual([])
      await blocker.query('COMMIT')
      expect(await running).toEqual({skipped:false,total:2,targetUsers:2,generated:2,reviewRequired:[]})
      const written = await writing
      expect(written.status,written.body.error?.code).toBe(200)
      if (writerKind === 'policy') {
        expect(written.body).toEqual({ok:true,data:{enabled:false,version:1}})
      } else {
        expect((await fixture.pool.query(`SELECT count(*)::int AS count FROM attendance_group_members
          WHERE org_id=$1 AND group_id=$2 AND user_id=$3`,[fixture.orgId,groupId,actor.userId])).rows).toEqual([{count:1}])
      }
      for (const subject of [admin,actor]) await assertFrozenTarget(subject,workDate,'UTC')
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await Promise.allSettled([running,writing].filter(value => value !== undefined))
    }
  },20_000)

  it.each(['shadow','authoritative'] as const)('%s binds the real scheduled calculation identity and effective context', async state => {
    const workDate = state === 'shadow' ? '2026-02-04' : '2026-02-05'
    const actor = await fixture.user()
    await policy(true)
    await employeeZone(actor,'Asia/Singapore')
    const shiftId = await assignment(actor,workDate,'America/New_York')
    await assignment(admin,workDate,'UTC')
    await rollout(state)
    const result = await adminRun(workDate)
    expect({status:result.status,body:result.body}).toEqual({status:200,body:{ok:true,data:{
      skipped:false,total:2,targetUsers:2,generated:2,reviewRequired:[],
    }}})
    const joined = (await fixture.pool.query(`SELECT c.original_calculation_id,c.original_freeze_snapshot,
      r.current_calculation_id,r.id::text AS record_id,calc.id,calc.mode,calc.outcome,calc.expected_segment_count,
      calc.context_snapshot,calc.attribution_snapshot,calc.source_definition_fingerprint,
      calc.entrypoint,o.resolved_calculation_id,o.state AS operation_state
      FROM attendance_timezone_context_companions c JOIN attendance_records r ON r.id=c.record_id
      JOIN attendance_record_calculations calc ON calc.id=c.original_calculation_id AND calc.attendance_record_id=c.record_id AND calc.org_id=c.org_id
      JOIN attendance_result_operations o ON o.operation_id=calc.operation_id AND o.org_id=calc.org_id
      WHERE c.org_id=$1 AND c.user_id=$2 AND c.work_date=$3`,[fixture.orgId,actor.userId,workDate])).rows
    expect(joined).toHaveLength(1)
    const row = joined[0]
    expect({calculationId:row.original_calculation_id,resolvedCalculationId:row.resolved_calculation_id,
      pointer:row.current_calculation_id,entrypoint:row.entrypoint,operationState:row.operation_state})
      .toEqual({calculationId:row.id,resolvedCalculationId:row.id,pointer:state === 'authoritative' ? row.id : null,
        entrypoint:'scheduled',operationState:'completed'})
    expect({timezone:row.context_snapshot.timezone,shiftId:row.context_snapshot.shiftId}).toEqual({timezone:'Asia/Singapore',shiftId})
    expect(row.attribution_snapshot.value.absoluteWindow).toEqual({startAt:workDate+'T01:00:00.000Z',endAt:workDate+'T10:00:00.000Z'})
    expect(row.original_freeze_snapshot).toEqual({calculation:{id:row.id,context_snapshot:row.context_snapshot,
      attribution_snapshot:row.attribution_snapshot,source_definition_fingerprint:row.source_definition_fingerprint}})
    await assertFrozenTarget(actor,workDate,'Asia/Singapore')
    if (state === 'shadow') {
      const expected = calculateAttendanceSegmentsV1({
        attribution: row.attribution_snapshot, context: row.context_snapshot, evidence: [], approvedFacts: [],
      })
      expect(expected.outcome).toBe('completed')
      expect(expected.segments).toHaveLength(1)
      expect({ mode: row.mode, outcome: row.outcome, count: row.expected_segment_count })
        .toEqual({ mode: 'shadow', outcome: 'completed', count: 1 })
      const children = (await fixture.pool.query(
        `SELECT org_id,record_id::text,calculation_id::text,segment_index,
          expected_start_at,expected_end_at,actual_in_at,actual_out_at,
          work_minutes,late_minutes,early_leave_minutes,status,status_reasons,
          matched_evidence_refs,unmatched_evidence_refs FROM attendance_record_segments
         WHERE calculation_id=$1::uuid ORDER BY segment_index`, [row.id],
      )).rows
      expect(children.map(child => ({ ...child,
        expected_start_at: child.expected_start_at.toISOString(),
        expected_end_at: child.expected_end_at.toISOString(),
        actual_in_at: child.actual_in_at?.toISOString() ?? null,
        actual_out_at: child.actual_out_at?.toISOString() ?? null,
      })), 'LIVE04_SCHEDULED_PHYSICAL_CHILD_LINEAGE').toEqual(expected.segments.map(segment => ({
        org_id: fixture.orgId, record_id: row.record_id, calculation_id: row.id,
        segment_index: segment.segmentIndex,
        expected_start_at: segment.expectedStartAt, expected_end_at: segment.expectedEndAt,
        actual_in_at: segment.actualInAt, actual_out_at: segment.actualOutAt,
        work_minutes: segment.workedMinutes, late_minutes: segment.lateMinutes,
        early_leave_minutes: segment.earlyLeaveMinutes, status: segment.status,
        status_reasons: segment.reasons, matched_evidence_refs: segment.matchedEvidenceRefs,
        unmatched_evidence_refs: segment.unmatchedEvidenceRefs,
      })))
    }
  })

  it('completed exact recovery skips unavailable mutable policy while a fresh run fails closed', async () => {
    const workDate = '2026-02-06'
    const actor = await fixture.user()
    await assignment(actor,workDate)
    await assignment(admin,workDate,'UTC')
    await rollout('authoritative')
    expect(await cronRun(workDate)).toEqual({skipped:false,total:2,targetUsers:2,generated:2,reviewRequired:[]})
    const runs = (await fixture.pool.query(`SELECT run_id,state FROM attendance_scheduled_runs
      WHERE org_id=$1 AND work_date=$2 AND initiator='cron'`,[fixture.orgId,workDate])).rows
    expect(runs).toHaveLength(1)
    expect(runs[0].state).toBe('completed')
    const beforeRecords = await records(workDate), beforeCompanions = await companions(workDate)
    const renamed = 'scheduled_timezone_policy_fault_'+randomUUID().replaceAll('-','')
    await fixture.pool.query('ALTER TABLE attendance_timezone_policies RENAME TO '+renamed)
    try {
      expect(await cronRun(workDate,runs[0].run_id)).toEqual({skipped:false,total:0,targetUsers:0,generated:0,reviewRequired:[]})
      expect(await records(workDate)).toEqual(beforeRecords)
      expect(await companions(workDate)).toEqual(beforeCompanions)
      await expect(cronRun('2026-02-07')).rejects.toMatchObject({status:503,code:'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE'})
      expect(await records('2026-02-07')).toEqual([])
      expect(await companions('2026-02-07')).toEqual([])
    } finally {
      await fixture.pool.query('ALTER TABLE '+renamed+' RENAME TO attendance_timezone_policies')
    }
  })

  it('partial RUNNING exact recovery refuses membership drift and resumes only the uncommitted target', async () => {
    const workDate = '2026-02-12'
    const actor = await fixture.user()
    await assignment(actor,workDate)
    await assignment(admin,workDate,'UTC')
    await rollout('authoritative')
    // The initial production member query deliberately has no order guarantee.
    // Fail whichever target is second, after the first target has committed.
    const guard = 'scheduled_timezone_partial_'+randomUUID().replaceAll('-','')
    await fixture.pool.query(`CREATE FUNCTION ${guard}() RETURNS trigger LANGUAGE plpgsql AS $guard$
      BEGIN IF NEW.org_id='${fixture.orgId}' AND NEW.work_date='${workDate}'::date AND EXISTS
      (SELECT 1 FROM attendance_timezone_context_companions WHERE org_id=NEW.org_id AND work_date=NEW.work_date) THEN
      RAISE EXCEPTION 'SYNTHETIC_SECOND_COMPANION_FAILURE' USING ERRCODE='23514'; END IF; RETURN NEW; END $guard$`)
    await fixture.pool.query(`CREATE TRIGGER ${guard} BEFORE INSERT ON attendance_timezone_context_companions
      FOR EACH ROW EXECUTE FUNCTION ${guard}()`)
    try {
      await expect(cronRun(workDate)).rejects.toMatchObject({status:503,code:'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE'})
    } finally {
      await fixture.pool.query(`DROP TRIGGER ${guard} ON attendance_timezone_context_companions`)
      await fixture.pool.query(`DROP FUNCTION ${guard}()`)
    }
    const [run] = await scheduledRunState(workDate)
    expect(await scheduledRunState(workDate)).toHaveLength(1)
    expect({state:run.state,expected:run.expected_user_count,review:run.review_count,
      completed:run.completed_user_count,generated:run.generated_count})
      .toEqual({state:'running',expected:2,review:0,completed:null,generated:null})
    const firstCompanions = await companions(workDate)
    expect(await records(workDate)).toHaveLength(1)
    expect(firstCompanions).toHaveLength(1)
    const durableBefore = await targetDurableState(run.run_id)
    expect(durableBefore.map(row => ({record:row.record_id !== null,calculation:row.calculation_id !== null,
      outcome:row.terminal_outcome,operation:row.operation_state})).sort((a,b) => Number(b.record)-Number(a.record)))
      .toEqual([{record:true,calculation:true,outcome:'completed',operation:'completed'},
        {record:false,calculation:false,outcome:null,operation:null}])
    const firstUserId = firstCompanions[0].user_id
    const firstSnapshot = async () => ({
      record:(await fixture.pool.query('SELECT * FROM attendance_records WHERE org_id=$1 AND user_id=$2 AND work_date=$3',
        [fixture.orgId,firstUserId,workDate])).rows,
      companion:(await companions(workDate)).filter(row => row.user_id === firstUserId),
      calculation:(await fixture.pool.query('SELECT * FROM attendance_record_calculations WHERE id=$1',
        [firstCompanions[0].original_calculation_id])).rows,
      outcome:(await fixture.pool.query(`SELECT o.*,op.response_snapshot,op.resolved_calculation_id FROM attendance_scheduled_run_target_outcomes o
        JOIN attendance_scheduled_run_targets t ON t.id=o.target_id AND t.org_id=o.org_id
        JOIN attendance_result_operations op ON op.org_id=t.org_id AND op.operation_id=t.operation_id
        WHERE t.org_id=$1 AND t.run_id=$2 AND t.user_id=$3`,[fixture.orgId,run.run_id,firstUserId])).rows,
    })
    const firstDigest = snapshotDigest(await firstSnapshot())
    const extra = await fixture.user()
    try {
      await expect(cronRun(workDate,run.run_id)).rejects.toMatchObject({code:'W4C2_SCHEDULED_RUN_RESUME_TARGET_SET_DRIFT'})
      expect(await scheduledRunState(workDate)).toEqual([run])
      expect(await targetDurableState(run.run_id)).toEqual(durableBefore)
      expect(snapshotDigest(await firstSnapshot())).toBe(firstDigest)
      expect(await records(workDate)).toHaveLength(1)
      expect(await companions(workDate)).toHaveLength(1)
    } finally {
      await fixture.pool.query('UPDATE user_orgs SET is_active=false WHERE org_id=$1 AND user_id=$2',[fixture.orgId,extra.userId])
    }
    expect(await cronRun(workDate,run.run_id)).toEqual({skipped:false,total:1,targetUsers:2,generated:1,reviewRequired:[]})
    expect(snapshotDigest(await firstSnapshot())).toBe(firstDigest)
    const [completed] = await scheduledRunState(workDate)
    expect(completed).toEqual({...run,state:'completed',completed_user_count:2,generated_count:2})
    const targets = await targetDurableState(run.run_id)
    expect(targets).toHaveLength(2)
    expect(targets.map(row => ({record:row.record_id !== null,calculation:row.calculation_id !== null,
      outcome:row.terminal_outcome,operation:row.operation_state})))
      .toEqual(Array.from({length:2},() => ({record:true,calculation:true,outcome:'completed',operation:'completed'})))
    expect(await records(workDate)).toHaveLength(2)
    expect(await companions(workDate)).toHaveLength(2)
    for (const subject of [admin,actor]) await assertFrozenTarget(subject,workDate,'UTC')
    expect(await cronRun(workDate,run.run_id)).toEqual({skipped:false,total:0,targetUsers:0,generated:0,reviewRequired:[]})
    expect(await scheduledRunState(workDate)).toEqual([completed])
    expect(await targetDurableState(run.run_id)).toEqual(targets)
    expect(snapshotDigest(await firstSnapshot())).toBe(firstDigest)
  })

  it('LIVE04 shared INSERT rejects wrong-org parent after a legal foreign peer commits', async () => {
    const workDate = '2026-03-03'
    const actor = await fixture.user()
    await policy(true)
    await assignment(actor,workDate,'UTC')
    await assignment(admin,workDate,'UTC')
    // Promotion works in selected-only and whole-file order; no illegal downgrade.
    await rollout('authoritative')
    const ownRun = await adminRun(workDate)
    expect(ownRun.status,ownRun.body.error?.code).toBe(200)
    const own = (await fixture.pool.query(
      `SELECT c.*,r.id::text AS record_id,r.status AS parent_status,r.work_minutes AS parent_minutes,
        r.late_minutes AS parent_late,r.early_leave_minutes AS parent_early,
        r.first_in_at AS parent_in,r.last_out_at AS parent_out
       FROM attendance_timezone_context_companions t JOIN attendance_records r ON r.id=t.record_id
       JOIN attendance_record_calculations c ON c.id=t.original_calculation_id
       WHERE t.org_id=$1 AND t.user_id=$2 AND t.work_date=$3`,[fixture.orgId,actor.userId,workDate],
    )).rows[0]
    expect(own.outcome).toBe('completed')
    const foreignOrg = randomUUID(), foreignShift = randomUUID()
    await fixture.pool.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)',[actor.userId,foreignOrg])
    await fixture.pool.query(`INSERT INTO attendance_rules
      (id,org_id,name,timezone,timezone_version,work_start_time,work_end_time,working_days,is_default)
      VALUES($1,$2,'LIVE04 foreign peer','UTC',1,'09:00','18:00','[0,1,2,3,4,5,6]'::jsonb,true)`,[randomUUID(),foreignOrg])
    await fixture.pool.query(`INSERT INTO attendance_shifts
      (id,org_id,name,timezone,work_start_time,work_end_time,working_days)
      VALUES($1,$2,'LIVE04 foreign peer','UTC','09:00','18:00','[0,1,2,3,4,5,6]'::jsonb)`,[foreignShift,foreignOrg])
    await fixture.pool.query(`INSERT INTO attendance_shift_assignments
      (id,org_id,user_id,shift_id,slot_index,start_date,end_date,is_active,publish_status,assignment_kind)
      VALUES($1,$2,$3,$4,0,$5,$5,true,'published','regular')`,[randomUUID(),foreignOrg,actor.userId,foreignShift,workDate])
    await fixture.pool.query(`INSERT INTO attendance_calculation_rollout_state
      (org_id,state,engine_version,reason_code,actor_id,version,prior_state)
      VALUES($1,'shadow','live04-native','TEST_FIXTURE',$2,1,NULL)`,[foreignOrg,admin.userId])
    const priorEnabled = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    try {
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId + ',' + foreignOrg
      expect(observed.boundary?.resolvesScheduledTimezone).toBe(true)
      const foreignRun = await plugin.__attendanceWorkDateResolverForTests.runAutoAbsenceForOrgDate({
        query:async (text,values) => (await fixture.pool.query(text,values)).rows,
      },{orgId:foreignOrg,workDate,skipDedup:true,initiator:'cron',w4Boundary:observed.boundary!})
      expect(foreignRun).toEqual({skipped:false,total:1,targetUsers:1,generated:1,reviewRequired:[]})
      const foreign = (await fixture.pool.query(
        `SELECT c.*,r.id::text AS record_id FROM attendance_record_calculations c
         JOIN attendance_records r ON r.id=c.attendance_record_id AND r.org_id=c.org_id
         WHERE c.org_id=$1 AND r.user_id=$2 AND r.work_date=$3 AND c.operation_id IS NOT NULL`,
        [foreignOrg,actor.userId,workDate],
      )).rows
      expect(foreign).toHaveLength(1)
      const peer = foreign[0]
      expect({mode:peer.mode,outcome:peer.outcome,count:peer.expected_segment_count})
        .toEqual({mode:'shadow',outcome:'completed',count:1})
      expect((await fixture.pool.query(
        'SELECT org_id,record_id::text,calculation_id::text FROM attendance_record_segments WHERE calculation_id=$1::uuid',
        [peer.id],
      )).rows).toEqual([{org_id:foreignOrg,record_id:peer.record_id,calculation_id:peer.id}])
      const peerState = async () => (await fixture.pool.query(`SELECT jsonb_build_object(
        'records',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM attendance_records r WHERE r.org_id=ANY($1::text[]) AND r.user_id=$2),
        'calculations',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM attendance_record_calculations c
          JOIN attendance_records r ON r.id=c.attendance_record_id WHERE c.org_id=ANY($1::text[]) AND r.user_id=$2),
        'children',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM attendance_record_segments s
          JOIN attendance_records r ON r.id=s.record_id WHERE s.org_id=ANY($1::text[]) AND r.user_id=$2)) AS value`,
        [[fixture.orgId,foreignOrg],actor.userId])).rows[0].value
      const before = await peerState()
      const physical = calculateAttendanceSegmentsV1({
        attribution:own.attribution_snapshot,context:own.context_snapshot,evidence:[],approvedFacts:[],
      })
      expect(physical.outcome).toBe('completed')
      const input: ShadowCalculationRowInputV1 = {
        orgId:fixture.orgId,recordId:peer.record_id,version:Number(peer.version)+1,
        entrypoint:'scheduled',operationId:randomUUID(),attribution:own.attribution_snapshot,
        context:own.context_snapshot,segmentSnapshot:own.segment_snapshot,evidence:[],approvedFacts:[],
        inputProvenance:{},provenanceRef:{transport:'scheduled_job',sourceRef:'plugin-attendance:auto-absence:admin-run',
          artifactSha256:null,normalizedCsvSha256:null,convertedSheetName:null},
        mergePolicy:'append',outcome:physical.outcome,outcomeReasonCode:physical.outcomeReasonCode,
        segments:physical.segments,dailyProjection:physical.dailyProjection,actorId:admin.userId,correlationId:randomUUID(),
        legacyProjection:{workDate,status:own.parent_status,firstInAt:own.parent_in,lastOutAt:own.parent_out,
          workMinutes:own.parent_minutes,lateMinutes:own.parent_late,earlyLeaveMinutes:own.parent_early},
      }
      const client = await fixture.pool.connect()
      try {
        await client.query('BEGIN')
        await expect(insertShadowCalculationV1({query:async (text,values) => client.query(text,values)},input))
          .rejects.toMatchObject({code:'23503',constraint:'fk_arc_record'})
      } finally {
        try { await client.query('ROLLBACK') } finally { client.release() }
      }
      expect(await peerState(),'LIVE04_WRONG_ORG_PARENT_INSERT_HAS_NO_DELTA').toEqual(before)
      const childClient = await fixture.pool.connect()
      let childBindingFaults = 0
      try {
        await childClient.query('BEGIN')
        // Execute the helper's real child INSERT unchanged, with a foreign org/record
        // binding fault. Keep its new own calculation id, avoiding a duplicate peer key.
        await expect(insertShadowCalculationV1({query:async (text,values) => {
          if (text.includes('INSERT INTO attendance_record_segments')) {
            if (!values) throw new Error('LIVE04_CHILD_BINDING_PARAMS_REQUIRED')
            expect(values).toHaveLength(15)
            const wrong = [...values]
            wrong[0] = foreignOrg
            wrong[1] = peer.record_id
            childBindingFaults += 1
            return childClient.query(text,wrong)
          }
          return childClient.query(text,values)
        }},{...input,recordId:own.record_id,version:Number(own.version)+1}))
          .rejects.toMatchObject({code:'23503',constraint:'fk_ars_calculation'})
      } finally {
        try { await childClient.query('ROLLBACK') } finally { childClient.release() }
      }
      expect(childBindingFaults).toBe(1)
      expect(await peerState(),'LIVE04_WRONG_ORG_SHARED_INSERT_HAS_NO_DELTA').toEqual(before)
    } finally {
      if (priorEnabled === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorEnabled
    }
  },60000)
})
