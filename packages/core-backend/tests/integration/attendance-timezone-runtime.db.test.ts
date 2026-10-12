import { acquireAttendanceImportTimezonePrefixV1, prepareAttendanceImportTimezoneSourceV1 } from '../../src/attendance/attendance-business-trip-locks'
import { applyAttendanceLegacyGroupEffectsV1 } from '../../src/attendance/w4c3a-legacy-plan-group-effects'
import type { VerifiedAttendanceLegacyPlanV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { createOnlinePunchDbFixture, punchClock, punchPlugin } from '../utils/attendance-online-punch-db'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('TIMEZONE_RUNTIME_REAL_DATABASE_REQUIRED')
const fixture = createOnlinePunchDbFixture({retainHistoryInIsolatedDatabase:true})
type Actor = Awaited<ReturnType<typeof fixture.user>>
let admin: Actor

async function policy(enabled: boolean) {
  await fixture.pool.query(`INSERT INTO attendance_timezone_policies(org_id,enabled,version,updated_by)
    VALUES($1,$2,1,$3) ON CONFLICT(org_id) DO UPDATE SET enabled=$2,
    version=attendance_timezone_policies.version+1,updated_by=$3`, [fixture.orgId,enabled,admin.userId])
}
async function resetSources() {
  await fixture.pool.query('DELETE FROM attendance_employee_timezone_overrides WHERE org_id=$1',[fixture.orgId])
  await fixture.pool.query('DELETE FROM attendance_timezone_policies WHERE org_id=$1',[fixture.orgId])
  await fixture.pool.query("UPDATE attendance_rules SET timezone='UTC' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
}
async function punch(actor: Actor, eventType: 'check_in' | 'check_out', instant: string, operationId = randomUUID(), timezone?: string) {
  punchClock.setOnlinePunchInstantForTests(instant)
  return fixture.request('/api/attendance/punch',actor.token,{
    orgId: fixture.orgId,eventType,operationId,...(timezone === undefined ? {} : { timezone }),
  })
}
async function eventRows(actor: Actor) {
  return (await fixture.pool.query(`SELECT event_type,timezone,work_date::text,occurred_at
    FROM attendance_events WHERE org_id=$1 AND user_id=$2 ORDER BY occurred_at`,
  [fixture.orgId,actor.userId])).rows
}
async function assignment(actor: Actor, startDate: string, timezone: string, overnight = false) {
  const shiftId = randomUUID()
  const assignmentId = randomUUID()
  await fixture.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,
    is_overnight,working_days) VALUES($1,$2,'timezone runtime synthetic',$3,$4,$5,$6,$7::jsonb)`,
  [shiftId,fixture.orgId,timezone,overnight ? '20:00' : '09:00',overnight ? '05:00' : '18:00',overnight,JSON.stringify([0,1,2,3,4,5,6])])
  await fixture.pool.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status)
    VALUES($1,$2,$3,$4,$5,$5,true,'published')`,[assignmentId,fixture.orgId,actor.userId,shiftId,startDate])
  return { shiftId,assignmentId }
}
async function targetContext(actor: Actor, workDate: string, orgId = fixture.orgId) {
  const client = await fixture.pool.connect()
  try {
    await client.query('BEGIN')
    const trx = {query:async (text: string,values?: unknown[]) => (await client.query(text,values)).rows}
    const result = await punchPlugin.readTargetTimezoneContext(trx,{orgId,userId:actor.userId,workDate})
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
async function policyPreview(enabled: boolean,expectedVersion: number) {
  const client = await fixture.pool.connect()
  const statements: string[] = []
  try {
    await client.query('BEGIN READ ONLY')
    const trx = {query:async (text: string,values?: unknown[]) => {
      statements.push(text)
      return (await client.query(text,values)).rows
    }}
    const result = await punchPlugin.previewTimezonePolicyChange(trx,{orgId:fixture.orgId,enabled,expectedVersion})
    await client.query('COMMIT')
    expect(statements.every(statement => /^\s*SELECT\b/i.test(statement))).toBe(true)
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error }
  finally { client.release() }
}
describe('effective timezone ordinary online punch (real HTTP/PostgreSQL)', () => {
  beforeAll(async () => { admin = await fixture.start() },180_000)
  afterAll(async () => {
    await resetSources()
    await fixture.pool.query('DELETE FROM attendance_shift_assignments WHERE org_id=$1',[fixture.orgId])
    await fixture.pool.query('DELETE FROM attendance_shifts WHERE org_id=$1',[fixture.orgId])
    await fixture.pool.query('DELETE FROM attendance_overtime_rules WHERE org_id=$1',[fixture.orgId])
    await fixture.stop()
  },60_000)
  it('OFF uses the actual strict organization default and rejects a different client zone with zero DML',async () => {
    const actor = await fixture.user()
    const rejected = await punch(actor,'check_in','2026-01-12T23:30:00.000Z',randomUUID(),'Asia/Tokyo')
    expect(rejected.body.error?.code).toBe('ATTENDANCE_TIMEZONE_CLIENT_ZONE_CONFLICT')
    expect(rejected).toMatchObject({ status: 409,body: { ok: false,error: {
      code: 'ATTENDANCE_TIMEZONE_CLIENT_ZONE_CONFLICT',message: 'ATTENDANCE_TIMEZONE_CLIENT_ZONE_CONFLICT',
    } } })
    expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    const accepted = await punch(actor,'check_in','2026-01-12T23:30:00.000Z')
    expect(accepted.status, accepted.body.error?.code).toBe(200)
    expect(await eventRows(actor)).toEqual([{event_type:'check_in',timezone:'UTC',work_date:'2026-01-12',
      occurred_at:new Date('2026-01-12T23:30:00.000Z')}])
    const provenance = (await fixture.pool.query('SELECT frame_snapshot FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows
    expect(provenance[0].frame_snapshot.timezoneContext).toEqual({
      timezone:'UTC',source:'system_default',mode:'default_only',
      referenceId:(await fixture.pool.query('SELECT id FROM attendance_rules WHERE org_id=$1 AND is_default=true',[fixture.orgId])).rows[0].id,
      version:1,policyVersion:0,calculationGroupMembership:null,
    })
  })
  it('ON employee authority determines the timezone day and is frozen in the actual record transaction',async () => {
    await policy(true)
    const actor = await fixture.user()
    await fixture.pool.query(`INSERT INTO attendance_employee_timezone_overrides(org_id,user_id,timezone,effective_from,created_by,updated_by)
      VALUES($1,$2,'Asia/Tokyo','2026-01-01T00:00:00Z',$3,$3)`,[fixture.orgId,actor.userId,admin.userId])
    const result = await punch(actor,'check_in','2026-01-12T23:30:00.000Z')
    expect(result.status, result.body.error?.code).toBe(200)
    expect(await eventRows(actor)).toEqual([{event_type:'check_in',timezone:'Asia/Tokyo',work_date:'2026-01-13',
      occurred_at:new Date('2026-01-12T23:30:00.000Z')}])
    expect(await fixture.counts(actor.userId)).toEqual({events:1,records:1,requests:0,operations:1})
    await resetSources()
  })
  it('a published shift cannot restore its old timezone in prepare, internal derive or frozen context',async () => {
    const actor = await fixture.user()
    const slot = await assignment(actor,'2026-01-15','Asia/Tokyo')
    const result = await punch(actor,'check_in','2026-01-15T09:10:00.000Z')
    expect(result.status, result.body.error?.code).toBe(200)
    expect(await eventRows(actor)).toEqual([{event_type:'check_in',timezone:'UTC',work_date:'2026-01-15',
      occurred_at:new Date('2026-01-15T09:10:00.000Z')}])
    const row = (await fixture.pool.query('SELECT frame_snapshot,absolute_start_at,absolute_end_at FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows[0]
    expect(row.absolute_start_at).toEqual(new Date('2026-01-15T09:00:00.000Z'))
    expect(row.absolute_end_at).toEqual(new Date('2026-01-15T18:00:00.000Z'))
    expect(row.frame_snapshot.resolution.shiftId).toBe(slot.shiftId)
    expect(row.frame_snapshot.issued.context.timezone).toBe('UTC')
    expect(row.frame_snapshot.issued.context.shiftId).toBe(slot.shiftId)
  })
  it('checkout continues the original frozen UTC window across a two-day dateline change',async () => {
    await fixture.pool.query("UPDATE attendance_rules SET timezone='Pacific/Kiritimati' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
    await policy(true)
    const actor = await fixture.user()
    await fixture.pool.query(`INSERT INTO attendance_employee_timezone_overrides(org_id,user_id,timezone,effective_from,created_by,updated_by)
      VALUES($1,$2,'America/Adak','2026-01-01T00:00:00Z',$3,$3)`,[fixture.orgId,actor.userId,admin.userId])
    await assignment(actor,'2026-01-12','UTC',true)
    expect((await punch(actor,'check_in','2026-01-13T06:00:00.000Z')).status).toBe(200)
    await policy(false)
    expect((await punch(actor,'check_out','2026-01-13T15:30:00.000Z')).status).toBe(200)
    expect(await eventRows(actor)).toEqual([
      {event_type:'check_in',timezone:'America/Adak',work_date:'2026-01-12',occurred_at:new Date('2026-01-13T06:00:00.000Z')},
      {event_type:'check_out',timezone:'America/Adak',work_date:'2026-01-12',occurred_at:new Date('2026-01-13T15:30:00.000Z')},
    ])
    expect(await fixture.counts(actor.userId)).toEqual({events:2,records:1,requests:0,operations:2})
    await resetSources()
  })
  it('expired historical missed checkout neither blocks a new shift nor steals its checkout',async () => {
    const actor = await fixture.user()
    expect((await punch(actor,'check_in','2026-01-20T09:00:00.000Z')).status).toBe(200)
    expect((await punch(actor,'check_in','2026-01-22T09:00:00.000Z')).status).toBe(200)
    expect((await punch(actor,'check_out','2026-01-22T18:00:00.000Z')).status).toBe(200)
    expect(await eventRows(actor)).toEqual([
      {event_type:'check_in',timezone:'UTC',work_date:'2026-01-20',occurred_at:new Date('2026-01-20T09:00:00.000Z')},
      {event_type:'check_in',timezone:'UTC',work_date:'2026-01-22',occurred_at:new Date('2026-01-22T09:00:00.000Z')},
      {event_type:'check_out',timezone:'UTC',work_date:'2026-01-22',occurred_at:new Date('2026-01-22T18:00:00.000Z')},
    ])
    expect(await fixture.counts(actor.userId)).toEqual({events:3,records:2,requests:0,operations:3})
  })
  it('same-date changed canonical provenance rejects a new context but permits original frozen checkout',async () => {
    const actor = await fixture.user()
    expect((await punch(actor,'check_in','2026-01-25T09:00:00.000Z')).status).toBe(200)
    await policy(true)
    const result = await punch(actor,'check_in','2026-01-25T10:00:00.000Z')
    expect(result.body).toEqual({ok:false,error:{code:'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',message:'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT'}})
    expect(result.status, result.body.error?.code).toBe(409)
    expect(await fixture.counts(actor.userId)).toEqual({events:1,records:1,requests:0,operations:1})
    expect((await punch(actor,'check_out','2026-01-25T18:00:00.000Z')).status).toBe(200)
    await resetSources()
  })
  it('sealed exact replay precedes mutable policy failure while a fresh command fails closed',async () => {
    const actor = await fixture.user()
    const id = randomUUID()
    const first = await punch(actor,'check_in','2026-01-27T09:00:00.000Z',id)
    expect(first.status, first.body.error?.code).toBe(200)
    await fixture.pool.query('ALTER TABLE attendance_timezone_policies RENAME TO timezone_policy_runtime_fault')
    try {
      const replay = await punch(actor,'check_in','2027-10-27T09:00:00.000Z',id)
      expect(replay).toEqual(first)
      const fresh = await punch(actor,'check_in','2026-01-27T10:00:00.000Z')
      expect(fresh.status).toBe(503)
      expect(fresh.body).toEqual({ok:false,error:{code:'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE',message:'ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE'}})
      expect(await fixture.counts(actor.userId)).toEqual({events:1,records:1,requests:0,operations:1})
    } finally {
      await fixture.pool.query('ALTER TABLE timezone_policy_runtime_fault RENAME TO attendance_timezone_policies')
    }
  })
  it('independent outer/inner authority divergence rejects before event, record or receipt DML',async () => {
    const actor = await fixture.user()
    let calls = 0
    punchPlugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(async () => { calls += 1; await policy(true) })
    try {
      const response = await punch(actor,'check_in','2026-01-29T09:00:00.000Z')
      expect(response.status, response.body.error?.code).toBe(409)
      expect(response.body).toEqual({ok:false,error:{code:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',message:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED'}})
      expect(calls).toBe(1)
      expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    } finally {
      punchPlugin.__setAttendanceW4LivePunchPreBoundarySeamForTests(null)
      await resetSources()
    }
  })
  it('W4 authoritative HTTP keeps the effective zone and binds the first actual calculation immutably',async () => {
    const prior = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    const actor = await fixture.user()
    const slot = await assignment(actor,'2026-01-30','Asia/Tokyo')
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
    await fixture.pool.query(`INSERT INTO attendance_calculation_rollout_state
      (org_id,state,engine_version,reason_code,actor_id,version,prior_state)
      VALUES($1,'legacy','timezone-runtime-test','TEST_FIXTURE',$2,1,NULL)`,[fixture.orgId,admin.userId])
    for (const [state,priorState,version] of [['shadow','legacy',2],['eligible','shadow',3],['authoritative','eligible',4]]) {
      await fixture.pool.query('UPDATE attendance_calculation_rollout_state SET state=$2,prior_state=$3,version=$4 WHERE org_id=$1',[fixture.orgId,state,priorState,version])
    }
    try {
      const incoming = await punch(actor,'check_in','2026-01-30T09:00:00.000Z')
      expect(incoming.status,incoming.body.error?.code).toBe(200)
      const first = (await fixture.pool.query(`SELECT c.original_calculation_id,c.original_freeze_snapshot,
        calc.id,calc.context_snapshot,calc.attribution_snapshot,calc.source_definition_fingerprint
        FROM attendance_timezone_context_companions c JOIN attendance_record_calculations calc
        ON calc.id=c.original_calculation_id AND calc.attendance_record_id=c.record_id AND calc.org_id=c.org_id
        WHERE c.org_id=$1 AND c.user_id=$2`,[fixture.orgId,actor.userId])).rows[0]
      expect(first.context_snapshot.timezone).toBe('UTC')
      expect(first.context_snapshot.shiftId).toBe(slot.shiftId)
      expect(first.attribution_snapshot.value.absoluteWindow).toEqual({startAt:'2026-01-30T09:00:00.000Z',endAt:'2026-01-30T18:00:00.000Z'})
      expect(first.original_calculation_id).toBe(first.id)
      expect(first.original_freeze_snapshot).toEqual({calculation:{
        id:first.id,context_snapshot:first.context_snapshot,attribution_snapshot:first.attribution_snapshot,
        source_definition_fingerprint:first.source_definition_fingerprint,
      }})
      const outgoing = await punch(actor,'check_out','2026-01-30T18:00:00.000Z')
      expect(outgoing.status,outgoing.body.error?.code).toBe(200)
      const calculations = (await fixture.pool.query(`SELECT version,context_snapshot->>'timezone' AS timezone,
        projected_work_minutes AS minutes FROM attendance_record_calculations
        WHERE org_id=$1 AND attendance_record_id=(SELECT id FROM attendance_records WHERE org_id=$1 AND user_id=$2)
        ORDER BY version`,[fixture.orgId,actor.userId])).rows
      expect(calculations).toEqual([{version:1,timezone:'UTC',minutes:0},{version:2,timezone:'UTC',minutes:540}])
      const after = (await fixture.pool.query('SELECT original_calculation_id,original_freeze_snapshot FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows
      expect(after).toEqual([{original_calculation_id:first.id,original_freeze_snapshot:first.original_freeze_snapshot}])
    } finally {
      if (prior === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = prior
    }
  })
  it('the actual frozen companion is append-only and nonempty rollback preserves every row',async () => {
    const before = (await fixture.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 ORDER BY record_id',[fixture.orgId])).rows
    expect(before.length).toBeGreaterThan(0)
    await expect(fixture.pool.query("UPDATE attendance_timezone_context_companions SET timezone='Asia/Tokyo' WHERE record_id=$1",[before[0].record_id])).rejects.toMatchObject({code:'23514'})
    await expect(fixture.pool.query('DELETE FROM attendance_timezone_context_companions WHERE record_id=$1',[before[0].record_id])).rejects.toMatchObject({code:'23514'})
    const { Kysely, PostgresDialect } = await import('kysely')
    const { Pool } = await import('pg')
    const { down } = await import('../../src/db/migrations/zzzz20261012120000_create_attendance_timezone_context_companions')
    const db = new Kysely({dialect:new PostgresDialect({pool:new Pool({connectionString:process.env.ATTENDANCE_TEST_DATABASE_URL})})})
    try { await expect(down(db)).rejects.toMatchObject({code:'23514'}) }
    finally { await db.destroy() }
    expect((await fixture.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 ORDER BY record_id',[fixture.orgId])).rows).toEqual(before)
  })
  it('empty companion rollback is a real positive control in its own complete parent schema',async () => {
    const schema = 'timezone_companion_empty_'+randomUUID().replaceAll('-','')
    await fixture.pool.query('CREATE SCHEMA '+schema)
    const { Kysely, PostgresDialect } = await import('kysely')
    const { Pool } = await import('pg')
    const migration = await import('../../src/db/migrations/zzzz20261012120000_create_attendance_timezone_context_companions')
    const db = new Kysely({dialect:new PostgresDialect({pool:new Pool({
      connectionString:process.env.ATTENDANCE_TEST_DATABASE_URL,options:'-c search_path='+schema+',public',
    })})})
    try {
      await fixture.pool.query('CREATE TABLE '+schema+'.attendance_records (LIKE public.attendance_records INCLUDING ALL)')
      await fixture.pool.query('CREATE TABLE '+schema+'.attendance_record_calculations (LIKE public.attendance_record_calculations INCLUDING ALL)')
      await migration.up(db)
      await migration.up(db)
      const installed = (await fixture.pool.query('SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2',[schema,'attendance_timezone_context_companions'])).rows
      expect(installed).toEqual([{count:1}])
      await migration.down(db)
      expect((await fixture.pool.query('SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2',[schema,'attendance_timezone_context_companions'])).rows).toEqual([{count:0}])
    } finally {
      await db.destroy()
      await fixture.pool.query('DROP SCHEMA '+schema+' CASCADE')
    }
  })
  it('trusted target-date preview returns the actual strict default and complete governed provenance',async () => {
    await resetSources()
    const actor = await fixture.user()
    const row = (await fixture.pool.query('SELECT * FROM attendance_rules WHERE org_id=$1 AND is_default=true',[fixture.orgId])).rows[0]
    const result = await targetContext(actor,'2026-02-10')
    expect(result).toEqual({
      orgId:fixture.orgId,userId:actor.userId,workDate:'2026-02-10',timezone:'UTC',
      contextFingerprint:expect.stringMatching(/^[0-9a-f]{64}$/),frozen:false,referenceId:row.id,
      provenance:{timezone:'UTC',source:'system_default',mode:'default_only',referenceId:row.id,
        version:row.timezone_version,policyVersion:0,calculationGroupMembership:null},
      window:{startAt:new Date('2026-02-10T09:00:00Z'),endAt:new Date('2026-02-10T18:00:00Z')},
      rule:{id:row.id,orgId:fixture.orgId,name:row.name,timezone:'UTC',
        workStartTime:row.work_start_time,workEndTime:row.work_end_time,
        lateGraceMinutes:row.late_grace_minutes,earlyGraceMinutes:row.early_grace_minutes,
        severeLateThresholdMinutes:row.severe_late_threshold_minutes,
        absenceLateThresholdMinutes:row.absence_late_threshold_minutes,
        roundingMinutes:row.rounding_minutes,workingDays:[0,1,2,3,4,5,6],isDefault:true},
      isWorkingDay:true,
    })
    await expect(targetContext(actor,'2026-02-30')).rejects.toMatchObject({status:422,code:'ATTENDANCE_TIMEZONE_TARGET_INVALID'})
    await expect(targetContext(actor,'2026-02-10','timezone_foreign_synthetic')).rejects.toMatchObject({
      status:403,code:'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED',
    })
  })
  it('target preview keeps original frozen context before broken mutable default, without changing any row',async () => {
    const actor = await fixture.user()
    expect((await punch(actor,'check_in','2026-02-11T09:00:00Z')).status).toBe(200)
    const rows = (await fixture.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows
    const frame = rows[0].frame_snapshot
    await fixture.pool.query('UPDATE attendance_rules SET is_default=false WHERE org_id=$1 AND is_default=true',[fixture.orgId])
    try {
      expect(await targetContext(actor,'2026-02-11')).toEqual({
        orgId:fixture.orgId,userId:actor.userId,workDate:'2026-02-11',timezone:'UTC',
        contextFingerprint:frame.fingerprint,frozen:true,referenceId:rows[0].record_id,
        provenance:frame.timezoneContext,window:{
          startAt:new Date(frame.absoluteWindow.startAt),endAt:new Date(frame.absoluteWindow.endAt),
        },rule:frame.context.rule,isWorkingDay:frame.context.isWorkingDay,
      })
      await expect(targetContext(actor,'2026-02-12')).rejects.toMatchObject({code:'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED'})
      expect((await fixture.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows).toEqual(rows)
    } finally { await fixture.pool.query('UPDATE attendance_rules SET is_default=true WHERE id=$1',[frame.context.rule.id]) }
  })
  it('target-date preview rejects two effective contexts even when both use the same timezone',async () => {
    await policy(true)
    const actor = await fixture.user()
    await fixture.pool.query(`INSERT INTO attendance_employee_timezone_overrides(org_id,user_id,timezone,effective_from,created_by,updated_by)
      VALUES($1,$2,'UTC','2026-02-13T12:00:00Z',$3,$3)`,[fixture.orgId,actor.userId,admin.userId])
    try { await expect(targetContext(actor,'2026-02-13')).rejects.toMatchObject({
      status:409,code:'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',
    }) } finally { await resetSources() }
  })
  it('nonoverlapping published shifts on one work date are refused before live freeze', async () => {
    await resetSources()
    const actor = await fixture.user()
    const workDate = '2026-05-06'
    const morning = await assignment(actor,workDate,'UTC')
    const afternoon = await assignment(actor,workDate,'UTC')
    await fixture.pool.query("UPDATE attendance_shifts SET work_start_time='06:00',work_end_time='08:00',working_days='[1]'::jsonb WHERE id=$1",[morning.shiftId])
    await fixture.pool.query("UPDATE attendance_shifts SET work_start_time='14:00',work_end_time='18:00',working_days='[3]'::jsonb WHERE id=$1",[afternoon.shiftId])
    const result = await punch(actor,'check_in',workDate+'T15:00:00Z')
    expect(result).toMatchObject({status:409,body:{ok:false,error:{code:'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT'}}})
    await expect(targetContext(actor,workDate)).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT'})
    expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows).toEqual([{count:0}])
  })
  it('target-date preview rejects actual target DST gaps and multiple published atomic contexts',async () => {
    const actor = await fixture.user()
    await fixture.pool.query("UPDATE attendance_rules SET timezone='America/New_York',work_start_time='02:30',work_end_time='10:00' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
    try { await expect(targetContext(actor,'2027-03-14')).rejects.toMatchObject({
      status:422,code:'ATTENDANCE_TIMEZONE_WALL_INVALID',
    }) } finally {
      await fixture.pool.query("UPDATE attendance_rules SET timezone='UTC',work_start_time='09:00',work_end_time='18:00' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
    }
    await assignment(actor,'2026-02-14','UTC')
    await assignment(actor,'2026-02-14','UTC')
    await expect(targetContext(actor,'2026-02-14')).rejects.toMatchObject({
      status:409,code:'ATTENDANCE_TIMEZONE_WORK_DATE_CONTEXT_CONFLICT',
    })
  })
  it('actual shift writer rejects changing a started published class without any source/event DML',async () => {
    await resetSources()
    const actor = await fixture.user()
    const slot = await assignment(actor,'2026-02-17','Asia/Tokyo')
    punchClock.setOnlinePunchInstantForTests('2026-02-17T10:00:00Z')
    const before = (await fixture.pool.query('SELECT * FROM attendance_shifts WHERE id=$1',[slot.shiftId])).rows
    const counts = await fixture.counts(actor.userId)
    const changed = await fixture.request('/api/attendance/shifts/'+slot.shiftId,admin.token,{workEndTime:'19:00'},'PUT')
    expect(changed).toMatchObject({status:409,body:{ok:false,error:{
      code:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT',message:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT',
    }}})
    expect((await fixture.pool.query('SELECT * FROM attendance_shifts WHERE id=$1',[slot.shiftId])).rows).toEqual(before)
    expect(await fixture.counts(actor.userId)).toEqual(counts)
  })
  it('actual shift writer permits a valid future class edit under the same guard',async () => {
    const actor = await fixture.user()
    const slot = await assignment(actor,'2026-02-19','Asia/Tokyo')
    punchClock.setOnlinePunchInstantForTests('2026-02-18T20:00:00Z')
    const changed = await fixture.request('/api/attendance/shifts/'+slot.shiftId,admin.token,{workEndTime:'19:00'},'PUT')
    expect(changed.status,changed.body.error?.code).toBe(200)
    expect((await fixture.pool.query('SELECT work_end_time FROM attendance_shifts WHERE id=$1',[slot.shiftId])).rows)
      .toEqual([{work_end_time:'19:00:00'}])
    expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
  })
  it('canonical membership fresh writes refuse missing context schema while completed replay remains available', async () => {
    await resetSources()
    await policy(true)
    const actor = await fixture.user()
    const groups = [randomUUID(),randomUUID()]
    for (const groupId of groups) await fixture.pool.query(
      "INSERT INTO attendance_groups(id,org_id,name,timezone) VALUES($1::uuid,$2,$1::text,'Asia/Tokyo')",
      [groupId,fixture.orgId],
    )
    await fixture.pool.query(`INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source)
      VALUES($1,'attendance',true,'test_fixture') ON CONFLICT(user_id,namespace) DO UPDATE SET enabled=true`,[admin.userId])
    punchClock.setOnlinePunchInstantForTests('2026-05-01T20:00:00Z')
    const payload = {orgId:fixture.orgId,userId:actor.userId,targetGroupId:groups[0],effectiveOn:'2026-05-01',
      reason:'synthetic schema guard',correlationId:randomUUID()}
    const path = '/api/attendance-admin/calculation-group-memberships/transition'
    const accepted = await fixture.request(path,admin.token,payload)
    expect(accepted.status,accepted.body.error?.code).toBe(200)
    const members = (await fixture.pool.query('SELECT * FROM attendance_calculation_group_memberships WHERE org_id=$1 AND user_id=$2 ORDER BY id',[fixture.orgId,actor.userId])).rows
    const operations = (await fixture.pool.query('SELECT * FROM attendance_calculation_group_membership_operations WHERE org_id=$1 AND user_id=$2 ORDER BY correlation_id',[fixture.orgId,actor.userId])).rows
    punchClock.setOnlinePunchInstantForTests('2026-05-02T01:00:00Z')
    await fixture.pool.query('ALTER TABLE attendance_timezone_context_companions RENAME TO attendance_timezone_context_companions_membership_probe')
    try {
      const rejected = await fixture.request(path,admin.token,{...payload,targetGroupId:groups[1],effectiveOn:'2026-05-02',correlationId:randomUUID()})
      expect(rejected).toMatchObject({status:503,body:{ok:false,error:{code:'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE'}}})
      const replay = await fixture.request(path,admin.token,payload)
      expect({status:replay.status,body:replay.body}).toEqual({status:accepted.status,body:accepted.body})
      expect((await fixture.pool.query('SELECT * FROM attendance_calculation_group_memberships WHERE org_id=$1 AND user_id=$2 ORDER BY id',[fixture.orgId,actor.userId])).rows).toEqual(members)
      expect((await fixture.pool.query('SELECT * FROM attendance_calculation_group_membership_operations WHERE org_id=$1 AND user_id=$2 ORDER BY correlation_id',[fixture.orgId,actor.userId])).rows).toEqual(operations)
      expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    } finally {
      await fixture.pool.query('ALTER TABLE attendance_timezone_context_companions_membership_probe RENAME TO attendance_timezone_context_companions')
      await resetSources()
    }
  })
  it('canonical core group membership writer refuses a started same-zone provenance change and preserves rows',async () => {
    await resetSources()
    const actor = await fixture.user()
    const groups = [randomUUID(),randomUUID()]
    for (const groupId of groups) {
      await fixture.pool.query(`INSERT INTO attendance_groups(id,org_id,name,timezone)
        VALUES($1::uuid,$2,$1::text,'Asia/Tokyo')`,[groupId,fixture.orgId])
    }
    await policy(true)
    punchClock.setOnlinePunchInstantForTests('2026-02-25T20:00:00Z')
    const transition = (groupId: string,effectiveOn: string,correlationId = randomUUID()) =>
      fixture.request('/api/attendance-admin/calculation-group-memberships/transition',admin.token,{
        orgId:fixture.orgId,userId:actor.userId,targetGroupId:groupId,effectiveOn,
        reason:'synthetic runtime guard',correlationId,
      })
    await fixture.pool.query(`INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source)
      VALUES($1,'attendance',true,'test_fixture') ON CONFLICT(user_id,namespace)
      DO UPDATE SET enabled=true`,[admin.userId])
    const initial = await transition(groups[0],'2026-02-01')
    expect(initial.status,JSON.stringify(initial.body)).toBe(200)
    const before = (await fixture.pool.query('SELECT * FROM attendance_calculation_group_memberships WHERE org_id=$1 AND user_id=$2 ORDER BY id',[fixture.orgId,actor.userId])).rows
    const operations = (await fixture.pool.query('SELECT * FROM attendance_calculation_group_membership_operations WHERE org_id=$1 AND user_id=$2 ORDER BY correlation_id',[fixture.orgId,actor.userId])).rows
    punchClock.setOnlinePunchInstantForTests('2026-02-26T01:00:00Z')
    const rejected = await transition(groups[1],'2026-02-26')
    expect(rejected).toMatchObject({status:409,body:{ok:false,error:{
      code:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT',message:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT',
    }}})
    expect((await fixture.pool.query('SELECT * FROM attendance_calculation_group_memberships WHERE org_id=$1 AND user_id=$2 ORDER BY id',[fixture.orgId,actor.userId])).rows).toEqual(before)
    expect((await fixture.pool.query('SELECT * FROM attendance_calculation_group_membership_operations WHERE org_id=$1 AND user_id=$2 ORDER BY correlation_id',[fixture.orgId,actor.userId])).rows).toEqual(operations)
    expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    punchClock.setOnlinePunchInstantForTests('2026-02-26T20:00:00Z')
    const accepted = await transition(groups[1],'2026-02-27')
    expect(accepted.status,accepted.body.error?.code).toBe(200)
    expect((await punch(actor,'check_in','2026-02-27T00:00:00Z')).status).toBe(200)
    expect(await eventRows(actor)).toEqual([{event_type:'check_in',timezone:'Asia/Tokyo',work_date:'2026-02-27',
      occurred_at:new Date('2026-02-27T00:00:00Z')}])
    const frozen = (await fixture.pool.query('SELECT frame_snapshot FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows[0].frame_snapshot
    expect(frozen.timezoneContext.source).toBe('calculation_group')
    expect(frozen.timezoneContext.referenceId).toBe(groups[1])
    expect(frozen.timezoneContext.calculationGroupMembership).toEqual({
      membershipId:accepted.body.data.membership.id,groupId:groups[1],effectiveFrom:'2026-02-27',effectiveTo:null,
    })
    await resetSources()
  })
  it('complete pre-companion FrozenV2 continues and replays from original UTC evidence before a broken default',async () => {
    await resetSources()
    const actor = await fixture.user()
    // Seed isolated historical storage from an actual core-produced calculation shape;
    // this proves continuation, not a new claim about a past import writer.
    const source = (await fixture.pool.query(`SELECT * FROM attendance_record_calculations
      WHERE org_id=$1 AND mode='authoritative' AND context_snapshot IS NOT NULL
      ORDER BY created_at,id LIMIT 1`,[fixture.orgId])).rows[0]
    const recordId = randomUUID(),calculationId = randomUUID()
    const context = {...source.context_snapshot,userId:actor.userId,workDate:'2026-02-28'}
    const attribution = {...source.attribution_snapshot,value:{
      ...source.attribution_snapshot.value,userId:actor.userId,workDate:'2026-02-28',
      absoluteWindow:{startAt:'2026-02-28T09:00:00.000Z',endAt:'2026-02-28T18:00:00.000Z'},
      attributionWindow:{startAt:'2026-02-28T09:00:00.000Z',endAt:'2026-02-28T20:00:00.000Z'},
    }}
    const historical = {
      ...source,id:calculationId,attendance_record_id:recordId,version:1,
      operation_id:randomUUID(),source_batch_id:null,supersedes_calculation_id:null,restores_calculation_id:null,
      context_snapshot:context,attribution_snapshot:attribution,
      projected_first_in_at:'2026-02-28T09:00:00.000Z',projected_last_out_at:null,
      projected_status:'normal',projected_work_minutes:0,projected_late_minutes:0,projected_early_leave_minutes:0,
      actor_id:admin.userId,correlation_id:randomUUID(),
    }
    await fixture.pool.query(`INSERT INTO attendance_records(id,org_id,user_id,work_date,timezone,first_in_at,
      last_out_at,work_minutes,late_minutes,early_leave_minutes,status,is_workday,meta)
      VALUES($1,$2,$3,'2026-02-28','UTC','2026-02-28T09:00:00Z',NULL,0,0,0,'normal',true,'{}'::jsonb)`,
    [recordId,fixture.orgId,actor.userId])
    await fixture.pool.query(`INSERT INTO attendance_events(id,org_id,user_id,event_type,work_date,timezone,occurred_at)
      VALUES($1,$2,$3,'check_in','2026-02-28','UTC','2026-02-28T09:00:00Z')`,[randomUUID(),fixture.orgId,actor.userId])
    const seedClient = await fixture.pool.connect()
    try {
      await seedClient.query('BEGIN')
      await seedClient.query(`INSERT INTO attendance_record_calculations
        SELECT (jsonb_populate_record(NULL::attendance_record_calculations,$1::jsonb)).*`,[JSON.stringify(historical)])
      const originalSegments = (await seedClient.query('SELECT * FROM attendance_record_segments WHERE calculation_id=$1 ORDER BY segment_index',[source.id])).rows
      for (const segment of originalSegments) {
        await seedClient.query(`INSERT INTO attendance_record_segments
          SELECT (jsonb_populate_record(NULL::attendance_record_segments,$1::jsonb)).*`,
        [JSON.stringify({...segment,id:randomUUID(),record_id:recordId,calculation_id:calculationId,
          expected_start_at:'2026-02-28T09:00:00.000Z',expected_end_at:'2026-02-28T18:00:00.000Z',
          actual_in_at:'2026-02-28T09:00:00.000Z',actual_out_at:null,
          status:'normal',work_minutes:0,late_minutes:0,early_leave_minutes:0})])
      }
      await seedClient.query("UPDATE attendance_records SET current_calculation_id=$2,projection_owner='w4' WHERE id=$1",[recordId,calculationId])
      await seedClient.query('COMMIT')
    } catch (error) { await seedClient.query('ROLLBACK'); throw error }
    finally { seedClient.release() }
    const original = (await fixture.pool.query('SELECT * FROM attendance_record_calculations WHERE id=$1',[calculationId])).rows
    await fixture.pool.query('UPDATE attendance_rules SET is_default=false WHERE org_id=$1 AND is_default=true',[fixture.orgId])
    const prior = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
    try {
      const preview = await targetContext(actor,'2026-02-28')
      expect({...preview,rule:undefined}).toEqual({
        orgId:fixture.orgId,userId:actor.userId,workDate:'2026-02-28',timezone:'UTC',
        contextFingerprint:expect.stringMatching(/^[0-9a-f]{64}$/),frozen:true,referenceId:recordId,
        provenance:null,window:{startAt:new Date('2026-02-28T09:00:00Z'),endAt:new Date('2026-02-28T18:00:00Z')},
        isWorkingDay:true,rule:undefined,
      })
      const operationId = randomUUID()
      const outgoing = await punch(actor,'check_out','2026-02-28T18:00:00Z',operationId)
      expect(outgoing.status,outgoing.body.error?.code).toBe(200)
      expect((await fixture.pool.query('SELECT original_calculation_id,original_freeze_snapshot FROM attendance_timezone_context_companions WHERE record_id=$1',[recordId])).rows)
        .toEqual([{original_calculation_id:calculationId,original_freeze_snapshot:{calculation:{
          id:calculationId,context_snapshot:context,attribution_snapshot:attribution,
          source_definition_fingerprint:source.source_definition_fingerprint,
        }}}])
      expect((await fixture.pool.query('SELECT * FROM attendance_record_calculations WHERE id=$1',[calculationId])).rows).toEqual(original)
      const replay = await punch(actor,'check_out','2026-03-01T18:00:00Z',operationId)
      expect(replay).toEqual(outgoing)
      const freshActor = await fixture.user()
      const fresh = await punch(freshActor,'check_in','2026-03-01T09:00:00Z')
      expect(fresh).toMatchObject({status:422,body:{ok:false,error:{
        code:'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED',message:'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED',
      }}})
      expect(await fixture.counts(freshActor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    } finally {
      if (prior === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = prior
      await fixture.pool.query('UPDATE attendance_rules SET is_default=true WHERE org_id=$1',[fixture.orgId])
    }
  })
  it('policy impact preflight uses real readonly counterfactual sources and reports exact users without creating a revision',async () => {
    await resetSources()
    punchClock.setOnlinePunchInstantForTests('2026-03-05T20:00:00Z')
    const users = (await fixture.pool.query(`SELECT count(*)::int AS count FROM user_orgs uo JOIN users u ON u.id=uo.user_id
      WHERE uo.org_id=$1 AND uo.is_active=true AND u.is_active=true`,[fixture.orgId])).rows[0].count
    const before = (await fixture.pool.query('SELECT * FROM attendance_timezone_policies WHERE org_id=$1',[fixture.orgId])).rows
    const audit = (await fixture.pool.query('SELECT * FROM attendance_timezone_policy_audit WHERE org_id=$1 ORDER BY id',[fixture.orgId])).rows
    expect(await policyPreview(true,0)).toEqual({
      currentVersion:0,proposedEnabled:true,evaluatedUsers:users,affectedUsers:users,conflictingUsers:0,
      conflictCounts:{startedContext:0,tripContext:0,invalidTargetContext:0},
    })
    expect((await fixture.pool.query('SELECT * FROM attendance_timezone_policies WHERE org_id=$1',[fixture.orgId])).rows).toEqual(before)
    expect((await fixture.pool.query('SELECT * FROM attendance_timezone_policy_audit WHERE org_id=$1 ORDER BY id',[fixture.orgId])).rows).toEqual(audit)
    await expect(policyPreview(true,1)).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_CONFIG_CHANGED'})
  })
  it('readonly policy impact preflight counts a no-trip started context conflict using the actual save guard',async () => {
    punchClock.setOnlinePunchInstantForTests('2026-03-06T10:00:00Z')
    const users = (await fixture.pool.query(`SELECT count(*)::int AS count FROM user_orgs uo JOIN users u ON u.id=uo.user_id
      WHERE uo.org_id=$1 AND uo.is_active=true AND u.is_active=true`,[fixture.orgId])).rows[0].count
    expect(await policyPreview(true,0)).toEqual({
      currentVersion:0,proposedEnabled:true,evaluatedUsers:users,affectedUsers:users,conflictingUsers:users,
      conflictCounts:{startedContext:users,tripContext:0,invalidTargetContext:0},
    })
    expect((await fixture.pool.query('SELECT * FROM attendance_timezone_policies WHERE org_id=$1',[fixture.orgId])).rows).toEqual([])
  })
  it.each(['leave','overtime','missed_check_in','time_correction'])('related %s rejects a wrong target fingerprint before any request DML',async requestType => {
    await resetSources()
    const actor = await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-03-08T20:00:00Z')
    const before = await fixture.counts(actor.userId)
    const rejected = await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType,workDate:'2026-03-09',operationId:randomUUID(),
      requestedInAt:'2026-03-09T09:00:00Z',requestedOutAt:'2026-03-09T18:00:00Z',
      expectedTimezoneContextFingerprint:'0'.repeat(64),
    })
    expect({status:rejected.status,body:rejected.body}).toEqual({status:409,body:{ok:false,error:{
      code:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',message:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',
    }}})
    expect(await fixture.counts(actor.userId)).toEqual(before)
  })
  it('a real target preview becomes stale after a legal future source change; a fresh fingerprint creates a frozen request and sealed replay skips broken default',async () => {
    await resetSources()
    const actor = await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-03-10T20:00:00Z')
    const preview = await targetContext(actor,'2026-03-11')
    const changed = await fixture.request('/api/attendance/rules/default',admin.token,{
      name:'Timezone runtime synthetic',timezone:'Asia/Tokyo',workStartTime:'09:00',workEndTime:'18:00',
      workingDays:[0,1,2,3,4,5,6],
    },'PUT')
    expect(changed.status,changed.body.error?.code).toBe(200)
    const body = {orgId:fixture.orgId,requestType:'missed_check_in',workDate:'2026-03-11',operationId:randomUUID(),
      requestedInAt:'2026-03-11T00:00:00Z',expectedTimezoneContextFingerprint:preview.contextFingerprint}
    const stale = await fixture.request('/api/attendance/requests',actor.token,body)
    expect({status:stale.status,body:stale.body}).toEqual({status:409,body:{ok:false,error:{
      code:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',message:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',
    }}})
    expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    const current = await targetContext(actor,'2026-03-11')
    const freshBody = {...body,expectedTimezoneContextFingerprint:current.contextFingerprint}
    const accepted = await fixture.request('/api/attendance/requests',actor.token,freshBody)
    expect(accepted.status,JSON.stringify(accepted.body)).toBe(201)
    const stored = (await fixture.pool.query('SELECT metadata FROM attendance_requests WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows
    expect(stored).toHaveLength(1)
    expect(stored[0].metadata.timezoneContextV1).toEqual(JSON.parse(JSON.stringify(current)))
    await fixture.pool.query('UPDATE attendance_rules SET is_default=false WHERE org_id=$1 AND id=$2',[fixture.orgId,current.rule.id])
    try {
      const replay = await fixture.request('/api/attendance/requests',actor.token,freshBody)
      expect({status:replay.status,body:replay.body}).toEqual({status:accepted.status,body:accepted.body})
    } finally { await fixture.pool.query('UPDATE attendance_rules SET is_default=true WHERE org_id=$1 AND id=$2',[fixture.orgId,current.rule.id]) }
  })

  it.each(['leave','overtime','missed_check_in','time_correction'])('related %s stores the effective target and actual UTC interval across a DST offset change',async requestType => {
    await resetSources()
    const actor = await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-10-31T20:00:00Z')
    const configured = await fixture.request('/api/attendance/rules/default',admin.token,{
      name:'Timezone DST synthetic',timezone:'America/New_York',workStartTime:'00:30',workEndTime:'04:00',
      workingDays:[0,1,2,3,4,5,6],
    },'PUT')
    expect(configured.status,JSON.stringify(configured.body)).toBe(200)
    let options: Record<string,unknown> = {}
    if (requestType === 'leave') {
      const id = randomUUID()
      await fixture.pool.query("INSERT INTO attendance_leave_types(id,org_id,code,name) VALUES($1,$2,$3,'timezone DST synthetic')",
        [id,fixture.orgId,'timezone_'+id])
      options = {leaveTypeId:id}
    }
    if (requestType === 'overtime') {
      const id = randomUUID()
      await fixture.pool.query("INSERT INTO attendance_overtime_rules(id,org_id,name,rounding_minutes) VALUES($1,$2,$3,1)",
        [id,fixture.orgId,'timezone_'+id])
      options = {overtimeRuleId:id}
      const published = await assignment(actor,'2026-11-01','Asia/Tokyo')
      await fixture.pool.query("UPDATE attendance_shifts SET work_start_time='00:30',work_end_time='04:00' WHERE id=$1",[published.shiftId])
    }
    const target = await targetContext(actor,'2026-11-01')
    const accepted = await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType,workDate:'2026-11-01',operationId:randomUUID(),
      requestedInAt:'2026-11-01T00:30:00-04:00',requestedOutAt:'2026-11-01T03:30:00-05:00',
      expectedTimezoneContextFingerprint:target.contextFingerprint,...options,
    })
    expect(accepted.status,JSON.stringify(accepted.body)).toBe(201)
    const stored = (await fixture.pool.query("SELECT work_date::text,request_type,requested_in_at,requested_out_at,metadata FROM attendance_requests WHERE org_id=$1 AND user_id=$2",[fixture.orgId,actor.userId])).rows
    expect(stored).toEqual([{work_date:'2026-11-01',request_type:requestType,
      requested_in_at:new Date('2026-11-01T04:30:00Z'),requested_out_at:new Date('2026-11-01T08:30:00Z'),
      metadata:expect.objectContaining({minutes:240,timezoneContextV1:JSON.parse(JSON.stringify(target))}),
    }])
    if (requestType === 'overtime') expect(stored[0].metadata.overtimeAttributionV1).toEqual({
      version:1,orgId:fixture.orgId,userId:actor.userId,workDate:'2026-11-01',
      shiftId:target.rule.id,source:'shift',assignmentId:target.referenceId,
    })
  })
  it.each(['leave','overtime','missed_check_in','time_correction'])('related %s final approval retains an existing frozen context when the mutable default disappears',async requestType => {
    await resetSources()
    const actor = await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-03-07T20:00:00Z')
    const configured = await fixture.request('/api/attendance/rules/default',admin.token,{
      name:'Timezone terminal synthetic',timezone:'America/New_York',workStartTime:'00:30',workEndTime:'04:00',
      workingDays:[0,1,2,3,4,5,6],
    },'PUT')
    expect(configured.status,JSON.stringify(configured.body)).toBe(200)
    const defaultId = (await fixture.pool.query('SELECT id FROM attendance_rules WHERE org_id=$1 AND is_default=true',[fixture.orgId])).rows[0].id
    const published = await assignment(actor,'2026-03-08','Asia/Tokyo')
    await fixture.pool.query("UPDATE attendance_shifts SET work_start_time='00:30',work_end_time='04:00' WHERE id=$1",[published.shiftId])
    const checkedIn = await punch(actor,'check_in','2026-03-08T05:30:00Z')
    expect(checkedIn.status,JSON.stringify(checkedIn.body)).toBe(200)
    const companionBefore = (await fixture.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows
    let options: Record<string,unknown> = {}
    if (requestType === 'leave') {
      const id = randomUUID()
      await fixture.pool.query("INSERT INTO attendance_leave_types(id,org_id,code,name) VALUES($1,$2,$3,'timezone terminal synthetic')",
        [id,fixture.orgId,'timezone_'+id])
      options = {leaveTypeId:id}
    }
    if (requestType === 'overtime') {
      const id = randomUUID()
      await fixture.pool.query("INSERT INTO attendance_overtime_rules(id,org_id,name,rounding_minutes) VALUES($1,$2,$3,1)",
        [id,fixture.orgId,'timezone_'+id])
      options = {overtimeRuleId:id}
    }
    const target = await targetContext(actor,'2026-03-08')
    expect(target.frozen).toBe(true)
    const made = await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType,workDate:'2026-03-08',operationId:randomUUID(),
      requestedInAt:'2026-03-08T00:30:00-05:00',requestedOutAt:'2026-03-08T03:30:00-04:00',
      expectedTimezoneContextFingerprint:target.contextFingerprint,...options,
    })
    expect(made.status,JSON.stringify(made.body)).toBe(201)
    const requestId = made.body.data.request.id
    await fixture.pool.query('UPDATE attendance_rules SET is_default=false WHERE org_id=$1 AND id=$2',[fixture.orgId,defaultId])
    try {
      const decided = await fixture.request('/api/attendance/requests/'+requestId+'/approve',admin.token,{})
      expect(decided.status,JSON.stringify(decided.body)).toBe(200)
      const request = (await fixture.pool.query('SELECT status,metadata FROM attendance_requests WHERE org_id=$1 AND id=$2',[fixture.orgId,requestId])).rows
      expect(request).toEqual([{status:'approved',metadata:expect.objectContaining({
        minutes:120,timezoneContextV1:JSON.parse(JSON.stringify(target)),
      })}])
      const records = (await fixture.pool.query('SELECT timezone,work_date::text,first_in_at,last_out_at,work_minutes FROM attendance_records WHERE org_id=$1 AND user_id=$2',
        [fixture.orgId,actor.userId])).rows
      expect(records).toEqual([{timezone:'America/New_York',work_date:'2026-03-08',
        first_in_at:new Date('2026-03-08T05:30:00Z'),
        last_out_at:['missed_check_in','time_correction'].includes(requestType) ? new Date('2026-03-08T07:30:00Z') : null,
        work_minutes:['missed_check_in','time_correction'].includes(requestType) ? 120 : 0,
      }])
      expect((await fixture.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows).toEqual(companionBefore)
    } finally { await fixture.pool.query('UPDATE attendance_rules SET is_default=true WHERE org_id=$1 AND id=$2',[fixture.orgId,defaultId]) }
  })
  it.each(['leave','overtime','missed_check_in','time_correction'])('related %s without an original record refuses terminal projection after a legal future context change',async requestType => {
    await resetSources()
    await fixture.pool.query("UPDATE attendance_rules SET work_start_time='09:00',work_end_time='18:00' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
    const actor = await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-03-07T20:00:00Z')
    let options: Record<string,unknown> = {}
    if (requestType==='leave') {
      const id=randomUUID()
      await fixture.pool.query("INSERT INTO attendance_leave_types(id,org_id,code,name) VALUES($1,$2,$3,'timezone stale synthetic')",[id,fixture.orgId,'timezone_'+id])
      options={leaveTypeId:id}
    }
    if (requestType==='overtime') {
      const id=randomUUID()
      await fixture.pool.query("INSERT INTO attendance_overtime_rules(id,org_id,name,rounding_minutes) VALUES($1,$2,$3,1)",[id,fixture.orgId,'timezone_'+id])
      options={overtimeRuleId:id}
      await assignment(actor,'2026-03-09','UTC')
    }
    const target=await targetContext(actor,'2026-03-09')
    const made=await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType,workDate:'2026-03-09',operationId:randomUUID(),
      requestedInAt:'2026-03-09T09:00:00Z',requestedOutAt:'2026-03-09T18:00:00Z',
      expectedTimezoneContextFingerprint:target.contextFingerprint,...options,
    })
    expect(made.status,JSON.stringify(made.body)).toBe(201)
    const changed=await fixture.request('/api/attendance/rules/default',admin.token,{
      name:'Timezone stale synthetic',timezone:'Asia/Tokyo',workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6],
    },'PUT')
    expect(changed.status,JSON.stringify(changed.body)).toBe(200)
    const before=await fixture.counts(actor.userId)
    const requestId=made.body.data.request.id
    const rejected=await fixture.request('/api/attendance/requests/'+requestId+'/approve',admin.token,{})
    expect({status:rejected.status,body:rejected.body}).toEqual({status:409,body:{ok:false,error:{
      code:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',message:'ATTENDANCE_TIMEZONE_CONTEXT_CHANGED',
    }}})
    expect(await fixture.counts(actor.userId)).toEqual(before)
    expect((await fixture.pool.query('SELECT status FROM attendance_requests WHERE org_id=$1 AND id=$2',[fixture.orgId,requestId])).rows).toEqual([{status:'pending'}])
    expect((await fixture.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows).toEqual([])
  })

  it.each([
    ['missed_check_in',false,'UTC','2026-03-09T09:00:00Z','2026-03-09T17:00:00Z'],
    ['time_correction',true,'Asia/Tokyo','2026-03-09T00:00:00Z','2026-03-09T08:00:00Z'],
  ] as const)('a newly approved %s first record binds its actual context in the projection transaction and continues online',async(requestType,published,timezone,firstIn,checkoutAt)=>{
    await resetSources()
    await fixture.pool.query("UPDATE attendance_rules SET work_start_time='09:00',work_end_time='18:00' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
    const actor=await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-03-07T20:00:00Z')
    if (published) {
      await policy(true)
      await fixture.pool.query("INSERT INTO attendance_employee_timezone_overrides(org_id,user_id,timezone,effective_from,created_by,updated_by) VALUES($1,$2,'Asia/Tokyo','2026-01-01T00:00:00Z',$3,$3)",
        [fixture.orgId,actor.userId,admin.userId])
      await assignment(actor,'2026-03-09','UTC')
    }
    const target=await targetContext(actor,'2026-03-09')
    expect(target.frozen).toBe(false);expect(target.timezone).toBe(timezone)
    const made=await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType,workDate:'2026-03-09',operationId:randomUUID(),
      requestedInAt:firstIn,expectedTimezoneContextFingerprint:target.contextFingerprint,
    })
    expect(made.status,JSON.stringify(made.body)).toBe(201)
    const approved=await fixture.request('/api/attendance/requests/'+made.body.data.request.id+'/approve',admin.token,{})
    expect(approved.status,JSON.stringify(approved.body)).toBe(200)
    const record=(await fixture.pool.query('SELECT id,timezone,work_date::text,first_in_at,last_out_at FROM attendance_records WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows
    expect(record).toEqual([{id:expect.any(String),timezone,work_date:'2026-03-09',first_in_at:new Date(firstIn),last_out_at:null}])
    const companions=(await fixture.pool.query('SELECT record_id,context_fingerprint,frame_snapshot FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows
    expect(companions).toEqual([{record_id:record[0].id,context_fingerprint:target.contextFingerprint,frame_snapshot:expect.objectContaining({
      timezone,fingerprint:target.contextFingerprint,timezoneContext:target.provenance,
    })}])
    const frozen=await targetContext(actor,'2026-03-09')
    expect(frozen).toMatchObject({frozen:true,referenceId:record[0].id,contextFingerprint:target.contextFingerprint,timezone})
    const checkedOut=await punch(actor,'check_out',checkoutAt)
    expect(checkedOut.status,JSON.stringify(checkedOut.body)).toBe(200)
    expect((await fixture.pool.query('SELECT id,timezone,first_in_at,last_out_at FROM attendance_records WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows)
      .toEqual([{id:record[0].id,timezone,first_in_at:new Date(firstIn),last_out_at:new Date(checkoutAt)}])
    expect((await fixture.pool.query('SELECT record_id,context_fingerprint,frame_snapshot FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows).toEqual(companions)
  })
  it('a companion write failure rolls final approval and its record/event projection back together',async()=>{
    await resetSources()
    await fixture.pool.query("UPDATE attendance_rules SET work_start_time='09:00',work_end_time='18:00' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
    const actor=await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-03-07T20:00:00Z')
    const target=await targetContext(actor,'2026-03-12')
    const made=await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType:'missed_check_in',workDate:'2026-03-12',operationId:randomUUID(),
      requestedInAt:'2026-03-12T09:00:00Z',expectedTimezoneContextFingerprint:target.contextFingerprint,
    })
    expect(made.status,JSON.stringify(made.body)).toBe(201)
    const requestId=made.body.data.request.id
    const before=await fixture.counts(actor.userId)
    const approvalBefore=(await fixture.pool.query('SELECT a.* FROM approval_instances a JOIN attendance_requests r ON r.approval_instance_id=a.id WHERE r.org_id=$1 AND r.id=$2',[fixture.orgId,requestId])).rows
    const suffix=randomUUID().replace(/-/g,'')
    const fn='timezone_bind_failure_'+suffix
    const trigger='timezone_bind_failure_'+suffix
    await fixture.pool.query('CREATE FUNCTION '+fn+'() RETURNS trigger LANGUAGE plpgsql AS $guard$ BEGIN IF NEW.org_id=\''+fixture.orgId+'\' AND NEW.user_id=\''+actor.userId+'\' THEN RAISE EXCEPTION \'SYNTHETIC_COMPANION_FAILURE\' USING ERRCODE=\'23514\'; END IF; RETURN NEW; END $guard$')
    await fixture.pool.query('CREATE TRIGGER '+trigger+' BEFORE INSERT ON attendance_timezone_context_companions FOR EACH ROW EXECUTE FUNCTION '+fn+'()')
    try {
      const refused=await fixture.request('/api/attendance/requests/'+requestId+'/approve',admin.token,{})
      expect({status:refused.status,body:refused.body}).toEqual({status:503,body:{ok:false,error:{
        code:'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',message:'ATTENDANCE_TIMEZONE_SOURCE_UNAVAILABLE',
      }}})
      expect(await fixture.counts(actor.userId)).toEqual(before)
      expect((await fixture.pool.query('SELECT status FROM attendance_requests WHERE org_id=$1 AND id=$2',[fixture.orgId,requestId])).rows).toEqual([{status:'pending'}])
      expect((await fixture.pool.query('SELECT a.* FROM approval_instances a JOIN attendance_requests r ON r.approval_instance_id=a.id WHERE r.org_id=$1 AND r.id=$2',[fixture.orgId,requestId])).rows).toEqual(approvalBefore)
      expect((await fixture.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows).toEqual([])
    } finally {
      await fixture.pool.query('DROP TRIGGER '+trigger+' ON attendance_timezone_context_companions')
      await fixture.pool.query('DROP FUNCTION '+fn+'()')
    }
    const accepted=await fixture.request('/api/attendance/requests/'+requestId+'/approve',admin.token,{})
    expect(accepted.status,JSON.stringify(accepted.body)).toBe(200)
    expect((await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows)
      .toEqual([{context_fingerprint:target.contextFingerprint}])
  })

  it('an incomplete historical absence record refuses current-zone target and request reinterpretation',async()=>{
    await resetSources()
    const actor=await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    const id=randomUUID()
    await fixture.pool.query("INSERT INTO attendance_records(id,org_id,user_id,work_date,timezone,status,is_workday) VALUES($1,$2,$3,'2026-02-02','America/New_York','absent',true)",
      [id,fixture.orgId,actor.userId])
    const before=(await fixture.pool.query('SELECT * FROM attendance_records WHERE id=$1',[id])).rows
    await expect(targetContext(actor,'2026-02-02')).rejects.toMatchObject({status:409,code:'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED'})
    const refused=await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType:'time_correction',workDate:'2026-02-02',operationId:randomUUID(),
      requestedInAt:'2026-02-02T09:00:00Z',
    })
    expect({status:refused.status,body:refused.body}).toEqual({status:409,body:{ok:false,error:{
      code:'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED',message:'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED',
    }}})
    expect((await fixture.pool.query('SELECT * FROM attendance_records WHERE id=$1',[id])).rows).toEqual(before)
    expect(await fixture.counts(actor.userId)).toEqual({events:0,records:1,requests:0,operations:0})
  })
  it('a real holiday published punch freezes one calculation definition in identity and persisted issuance',async()=>{
    await resetSources()
    const prior = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = fixture.orgId
    expect((await fixture.pool.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1', [fixture.orgId])).rows).toEqual([{ state: 'authoritative' }])
    const actor=await fixture.user()
    await assignment(actor,'2026-02-08','UTC')
    const holidayId=randomUUID()
    await fixture.pool.query("INSERT INTO attendance_holidays(id,org_id,holiday_date,name,is_working_day,origin) VALUES($1,$2,'2026-02-08','timezone holiday synthetic',false,'manual')",
      [holidayId,fixture.orgId])
    try {
      const checked=await punch(actor,'check_in','2026-02-08T09:00:00Z')
      expect(checked.status,JSON.stringify(checked.body)).toBe(200)
      const companions=(await fixture.pool.query('SELECT frame_snapshot FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[fixture.orgId,actor.userId])).rows
      expect(companions).toHaveLength(1)
      const frame=companions[0].frame_snapshot
      expect(frame.identity.calculationDefinition.holidayKind).toBe('holiday')
      expect(frame.identity.calculationDefinition.isWorkday).toBe(false)
      expect(frame.issued.context).toEqual(frame.identity.calculationDefinition)
      const calculations=(await fixture.pool.query('SELECT calc.context_snapshot FROM attendance_record_calculations calc JOIN attendance_records r ON r.id=calc.attendance_record_id AND r.org_id=calc.org_id WHERE r.org_id=$1 AND r.user_id=$2',
        [fixture.orgId,actor.userId])).rows
      expect(calculations).toHaveLength(1)
      for (const calculation of calculations) expect(calculation.context_snapshot).toEqual(frame.identity.calculationDefinition)
    } finally {
      if (prior === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = prior
      await fixture.pool.query('DELETE FROM attendance_holidays WHERE id=$1 AND org_id=$2',[holidayId,fixture.orgId])
    }
  })
  it('approved leave external cancellation holds the actual org prefix before original and round parents',async()=>{
    await resetSources()
    await fixture.pool.query("UPDATE attendance_rules SET work_start_time='09:00',work_end_time='18:00' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
    const actor=await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-03-07T20:00:00Z')
    const leaveTypeId=randomUUID()
    await fixture.pool.query("INSERT INTO attendance_leave_types(id,org_id,code,name) VALUES($1,$2,$3,'timezone cancel synthetic')",[leaveTypeId,fixture.orgId,'timezone_'+leaveTypeId])
    const flow=await fixture.request('/api/attendance/approval-flows',admin.token,{
      orgId:fixture.orgId,name:'Timezone leave cancellation synthetic',requestType:'leave',steps:[{approverUserIds:[admin.userId]}],
    })
    expect(flow.status,JSON.stringify(flow.body)).toBe(201)
    const target=await targetContext(actor,'2026-03-09')
    const made=await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType:'leave',workDate:'2026-03-09',operationId:randomUUID(),leaveTypeId,
      approvalFlowId:flow.body.data.id,requestedInAt:'2026-03-09T09:00:00Z',requestedOutAt:'2026-03-09T11:00:00Z',
      expectedTimezoneContextFingerprint:target.contextFingerprint,
    })
    expect(made.status,JSON.stringify(made.body)).toBe(201)
    const requestId=made.body.data.request.id
    const approved=await fixture.request('/api/attendance/requests/'+requestId+'/approve',admin.token,{})
    expect(approved.status,JSON.stringify(approved.body)).toBe(200)
    const prior=process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED
    process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED='true'
    try {
      const launched=await fixture.request('/api/attendance/requests/'+requestId+'/cancel-round?orgId='+fixture.orgId,actor.token,{reason:'timezone cancellation synthetic'})
      expect(launched.status,JSON.stringify(launched.body)).toBe(201)
      const roundId=launched.body.data.round.roundId
      const originalQuery=Client.prototype.query
      const order:string[]=[]
      const observed:Client['query']=function(this:Client,...args:unknown[]) {
        const text=typeof args[0]==='string' ? args[0] : (args[0] as {text?:string})?.text
        const values=Array.isArray(args[1]) ? args[1] : (args[0] as {values?:unknown[]})?.values
        if (text && values) {
          if (text.includes('pg_advisory_xact_lock') && values.includes(JSON.stringify(['attendance-timezone-policy-v1',fixture.orgId]))) order.push('org_prefix')
          if (/FOR\s+UPDATE/i.test(text) && /FROM\s+(?:attendance_requests|approval_cancel_rounds|approval_instances)/i.test(text)
            && (values.includes(requestId) || values.includes(roundId) || values.includes(made.body.data.request.approval_instance_id))) order.push('parent')
        }
        return Reflect.apply(originalQuery,this,args)
      }
      Client.prototype.query=observed
      try {
        const cancelled=await fixture.request('/api/attendance/requests/'+requestId+'/cancel-round/actions?orgId='+fixture.orgId,admin.token,{action:'approve',expectedRoundId:roundId})
        expect(cancelled.status,JSON.stringify(cancelled.body)).toBe(200)
      } finally {Client.prototype.query=originalQuery}
      expect(order).toContain('org_prefix');expect(order).toContain('parent')
      expect(order.indexOf('org_prefix')).toBeLessThan(order.indexOf('parent'))
      expect((await fixture.pool.query('SELECT status FROM attendance_requests WHERE org_id=$1 AND id=$2',[fixture.orgId,requestId])).rows).toEqual([{status:'cancelled'}])
    } finally {if(prior===undefined) delete process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED;else process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED=prior}
  })

  it.each([
    ['2027-03-14','02:30','ATTENDANCE_TIMEZONE_WALL_INVALID'],
    ['2026-11-01','01:30','ATTENDANCE_TIMEZONE_WALL_AMBIGUOUS'],
  ])('related target %s refuses a real gap or fold before request DML',async (workDate,start,code) => {
    await resetSources()
    const actor = await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-10-31T20:00:00Z')
    // Owned synthetic setup avoids policy writer guard: the admission under test
    // is the actual fresh request boundary's strict target wall-time resolver.
    await fixture.pool.query("UPDATE attendance_rules SET timezone='America/New_York',work_start_time=$2,work_end_time='10:00' WHERE org_id=$1 AND is_default=true",[fixture.orgId,start])
    const rejected = await fixture.request('/api/attendance/requests',actor.token,{
      orgId:fixture.orgId,requestType:'time_correction',workDate,operationId:randomUUID(),
      requestedInAt:workDate+'T09:00:00Z',expectedTimezoneContextFingerprint:'0'.repeat(64),
    })
    expect({status:rejected.status,body:rejected.body}).toEqual({status:422,body:{ok:false,error:{code,message:code}}})
    expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
  })

  it.each(['leave','overtime','missed_check_in','time_correction'])('fresh related %s refuses implicit server timezone input with and without a fingerprint',async requestType => {
    await resetSources()
    await fixture.pool.query("UPDATE attendance_rules SET work_start_time='09:00',work_end_time='18:00' WHERE org_id=$1 AND is_default=true",[fixture.orgId])
    const actor = await fixture.user()
    await fixture.pool.query("UPDATE users SET activation_status='activated' WHERE id=$1",[actor.userId])
    punchClock.setOnlinePunchInstantForTests('2026-10-31T20:00:00Z')
    const target = await targetContext(actor,'2026-11-02')
    for (const withFingerprint of [false,true]) {
      const rejected = await fixture.request('/api/attendance/requests',actor.token,{
        orgId:fixture.orgId,requestType,workDate:'2026-11-02',operationId:randomUUID(),
        requestedInAt:'2026-11-02T09:00',requestedOutAt:'2026-11-02T18:00',
        ...(withFingerprint ? {expectedTimezoneContextFingerprint:target.contextFingerprint} : {}),
      })
      expect({status:rejected.status,body:rejected.body}).toEqual({status:422,body:{ok:false,error:{
        code:'ATTENDANCE_TIMEZONE_INSTANT_INVALID',message:'ATTENDANCE_TIMEZONE_INSTANT_INVALID',
      }}})
      expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    }
  })

  it('import group effects use the actual enabled runtime guard and roll back a started source change', async () => {
    await resetSources()
    const actor = await fixture.user()
    const groupId = randomUUID()
    await fixture.pool.query("INSERT INTO attendance_groups(id,org_id,name,timezone) VALUES($1::uuid,$2,$1::text,'Asia/Tokyo')", [groupId,fixture.orgId])
    await fixture.pool.query(`INSERT INTO attendance_calculation_group_memberships(
      id,org_id,user_id,group_id,effective_from,assigned_by,assigned_reason,assigned_correlation_id)
      VALUES($1,$2,$3,$4,'2026-04-01',$5,'synthetic import guard',$6)`,
    [randomUUID(),fixture.orgId,actor.userId,groupId,admin.userId,randomUUID()])
    await policy(true)
    punchClock.setOnlinePunchInstantForTests('2026-04-01T01:00:00Z')
    const beforeContext = await targetContext(actor,'2026-04-01')
    expect(beforeContext).toMatchObject({ timezone:'Asia/Tokyo',frozen:false })
    const before = (await fixture.pool.query('SELECT * FROM attendance_groups WHERE id=$1',[groupId])).rows
    const client = await fixture.pool.connect()
    const trx: AttendanceW4TransactionClientV1 = {
      query: async (text,values) => ({rows:(await client.query<Record<string,unknown>>(text,values)).rows}),
    }
    try {
      await client.query('BEGIN')
      await acquireAttendanceImportTimezonePrefixV1(trx,fixture.orgId)
      await prepareAttendanceImportTimezoneSourceV1(trx,fixture.orgId)
      // Inject a source change inside the transaction to exercise the real
      // registered resolver; no test callback substitutes its verifier.
      await client.query("UPDATE attendance_groups SET timezone='Asia/Singapore' WHERE id=$1",[groupId])
      const plan = {
        manifest:{orgId:fixture.orgId},
        groupEffects:[{kind:'ensure_member',memberId:randomUUID(),groupRef:groupId,userId:actor.userId,membershipExistedAtPrepare:false}],
      } as unknown as VerifiedAttendanceLegacyPlanV1
      await expect(applyAttendanceLegacyGroupEffectsV1(trx,plan)).rejects.toMatchObject({
        code:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT',
      })
      await client.query('ROLLBACK')
      expect((await fixture.pool.query('SELECT * FROM attendance_groups WHERE id=$1',[groupId])).rows).toEqual(before)
      expect((await fixture.pool.query('SELECT COUNT(*)::int AS count FROM attendance_group_members WHERE group_id=$1',[groupId])).rows).toEqual([{count:0}])
      expect(await targetContext(actor,'2026-04-01')).toEqual(beforeContext)
      expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('import preparation refuses a missing policy table rather than treating it as OFF', async () => {
    const client = await fixture.pool.connect()
    const trx: AttendanceW4TransactionClientV1 = {
      query: async (text,values) => ({rows:(await client.query<Record<string,unknown>>(text,values)).rows}),
    }
    try {
      await client.query('BEGIN')
      await acquireAttendanceImportTimezonePrefixV1(trx,fixture.orgId)
      await client.query('ALTER TABLE attendance_timezone_policies RENAME TO attendance_timezone_policies_import_schema_probe')
      await expect(prepareAttendanceImportTimezoneSourceV1(trx,fixture.orgId)).rejects.toThrow('ATTENDANCE_TIMEZONE_SCHEMA_UNAVAILABLE')
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('OFF import membership protects a started group calendar change and allows it before start', async () => {
    await resetSources()
    await policy(false)
    const actor = await fixture.user()
    const groupId = randomUUID()
    const groupName = 'synthetic-off-import-' + groupId
    const workDate = '2026-04-03'
    await fixture.pool.query("INSERT INTO attendance_groups(id,org_id,name,timezone) VALUES($1,$2,$3,'UTC')",[groupId,fixture.orgId,groupName])
    punchClock.setOnlinePunchInstantForTests(workDate + 'T00:00:00Z')
    const configured = await fixture.request('/api/attendance/rules/default',admin.token,{
      orgId:fixture.orgId,timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6],
    },'PUT')
    expect(configured.status,configured.body.error?.code).toBe(200)
    const settings = await fixture.request('/api/attendance/settings',admin.token,undefined,'GET')
    expect(settings.status).toBe(200)
    const previous = settings.body.data.calendarPolicy.overrides
    const override = {id:randomUUID(),date:workDate,filters:{attendanceGroups:[groupName]},effective:{isWorkingDay:false,source:'group'}}
    const saved = await fixture.request('/api/attendance/settings',admin.token,{calendarPolicy:{overrides:[...previous,override]}},'PUT')
    expect(saved.status,saved.body.error?.code).toBe(200)
    const read = async () => {
      const response = await fixture.request('/api/attendance/timezone-context/me?workDate='+workDate,actor.token,undefined,'GET')
      expect(response.status,response.body.error?.code).toBe(200)
      return response.body.data
    }
    const memberPlan = {
      manifest:{orgId:fixture.orgId},
      groupEffects:[{kind:'ensure_member',memberId:randomUUID(),groupRef:groupId,userId:actor.userId,membershipExistedAtPrepare:false}],
    } as unknown as VerifiedAttendanceLegacyPlanV1
    const client = await fixture.pool.connect()
    const trx: AttendanceW4TransactionClientV1 = {
      query: async (text,values) => ({rows:(await client.query<Record<string,unknown>>(text,values)).rows}),
    }
    try {
      punchClock.setOnlinePunchInstantForTests(workDate+'T08:00:00Z')
      expect(await read()).toMatchObject({timezone:'UTC',isWorkingDay:true})
      await client.query('BEGIN')
      await acquireAttendanceImportTimezonePrefixV1(trx,fixture.orgId)
      await prepareAttendanceImportTimezoneSourceV1(trx,fixture.orgId)
      expect(await applyAttendanceLegacyGroupEffectsV1(trx,memberPlan)).toEqual({groupCreated:0,groupMembersAdded:1})
      await client.query('COMMIT')
      expect(await read()).toMatchObject({timezone:'UTC',isWorkingDay:false})
      await fixture.pool.query('DELETE FROM attendance_group_members WHERE org_id=$1 AND group_id=$2 AND user_id=$3',[fixture.orgId,groupId,actor.userId])
      punchClock.setOnlinePunchInstantForTests(workDate+'T10:00:00Z')
      const before = await read()
      expect(before).toMatchObject({timezone:'UTC',isWorkingDay:true})
      await client.query('BEGIN')
      await acquireAttendanceImportTimezonePrefixV1(trx,fixture.orgId)
      await prepareAttendanceImportTimezoneSourceV1(trx,fixture.orgId)
      await expect(applyAttendanceLegacyGroupEffectsV1(trx,memberPlan)).rejects.toMatchObject({code:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT'})
      await client.query('ROLLBACK')
      expect((await fixture.pool.query('SELECT COUNT(*)::int AS count FROM attendance_group_members WHERE group_id=$1',[groupId])).rows).toEqual([{count:0}])
      expect(await read()).toEqual(before)
      expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:0,operations:0})
    } finally {
      await client.query('ROLLBACK')
      client.release()
      punchClock.setOnlinePunchInstantForTests(workDate+'T20:00:00Z')
      const restored = await fixture.request('/api/attendance/settings',admin.token,{calendarPolicy:{overrides:previous}},'PUT')
      expect(restored.status,restored.body.error?.code).toBe(200)
    }
  })

})
