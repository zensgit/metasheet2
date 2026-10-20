import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('ATTENDANCE_DEFAULT_RECOVERY_REAL_DATABASE_REQUIRED')
const live = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
const {setBusinessTripInstantForTests} = createRequire(import.meta.url)('../../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs')
type Actor = Awaited<ReturnType<typeof live.user>>
const now = '2026-08-12T10:00:00Z'
const workDate = '2026-08-12'
let admin: Actor
let originalDefaultRuleId: string
const payload = { timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00', workingDays: [0,1,2,3,4,5,6] }
const save = (value: Record<string, unknown> = payload, token = admin.token) =>
  live.request('/api/attendance/rules/default', token, { orgId: live.orgId, ...value }, 'PUT')
const hideDefault = () => live.pool.query('UPDATE attendance_rules SET is_default=false WHERE org_id=$1', [live.orgId])
async function rows(table: string, orgId = live.orgId) {
  return (await live.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [orgId])).rows
}
async function history() {
  return Promise.all(['attendance_records', 'attendance_events', 'attendance_record_calculations',
    'attendance_timezone_context_companions', 'attendance_requests'].map(table => rows(table)))
}
async function shift(actor: Actor, date: string, overnight = false) {
  const shiftId = randomUUID(), assignmentId = randomUUID()
  await live.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,working_days)
    VALUES($1,$2,'default recovery synthetic','UTC',$3,$4,$5,'[0,1,2,3,4,5,6]'::jsonb)`,
  [shiftId, live.orgId, overnight ? '20:00' : '09:00', overnight ? '05:00' : '18:00', overnight])
  await live.pool.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status)
    VALUES($1,$2,$3,$4,$5,$5,true,'published')`, [assignmentId,live.orgId,actor.userId,shiftId,date])
  return { shiftId, assignmentId }
}
async function punch(actor: Actor, eventType: string, instant: string) {
  punchClock.setOnlinePunchInstantForTests(instant)
  return live.request('/api/attendance/punch',actor.token,{orgId:live.orgId,eventType,operationId:randomUUID()})
}

describe('authorized missing organization default recovery (actual HTTP/PostgreSQL)', () => {
  beforeAll(async () => {
    punchClock.setOnlinePunchInstantForTests(now)
    admin = await live.start()
    const defaults = (await live.pool.query('SELECT id FROM attendance_rules WHERE org_id=$1 AND is_default=true',[live.orgId])).rows
    expect(defaults).toHaveLength(1)
    originalDefaultRuleId = defaults[0].id
  },180_000)
  beforeEach(async () => {
    punchClock.setOnlinePunchInstantForTests(now)
    await live.pool.query('DELETE FROM attendance_shift_assignments WHERE org_id=$1',[live.orgId])
    await live.pool.query('DELETE FROM attendance_rotation_assignments WHERE org_id=$1',[live.orgId])
    await live.pool.query('DELETE FROM attendance_calculation_group_memberships WHERE org_id=$1',[live.orgId])
    await live.pool.query('DELETE FROM attendance_timezone_policies WHERE org_id=$1',[live.orgId])
    await hideDefault()
    await live.pool.query(`INSERT INTO attendance_rules(id,org_id,name,timezone,work_start_time,work_end_time,working_days,is_default)
      VALUES($1,$2,'default recovery synthetic','UTC','09:00','18:00','[0,1,2,3,4,5,6]'::jsonb,true)`,[randomUUID(),live.orgId])
  })
  afterAll(async () => {
    setBusinessTripInstantForTests(null)
    try {
      // Global settings writers enumerate retained fixture orgs. Restore only
      // our original configuration after the deliberate missing-source cases.
      if (originalDefaultRuleId) {
        await live.pool.query('UPDATE attendance_rules SET is_default=(id=$1) WHERE org_id=$2',[originalDefaultRuleId,live.orgId])
      }
    } finally { await live.stop() }
  },60_000)

  it('restores an OFF org with future published shift and rotation, without changing schedules or history',async () => {
    const actor = await live.user()
    const scheduled = await shift(actor,'2026-08-15')
    const rotationId = randomUUID()
    await live.pool.query(`INSERT INTO attendance_rotation_rules(id,org_id,name,timezone,shift_sequence)
      VALUES($1,$2,'default recovery synthetic','UTC',$3::jsonb)`,[rotationId,live.orgId,JSON.stringify([scheduled.shiftId])])
    await live.pool.query(`INSERT INTO attendance_rotation_assignments(id,org_id,user_id,rotation_rule_id,start_date,end_date,is_active,publish_status)
      VALUES($1,$2,$3,$4,'2026-08-16','2026-08-16',true,'published')`,[randomUUID(),live.orgId,actor.userId,rotationId])
    await hideDefault()
    const before = await history()
    const schedules = await Promise.all(['attendance_shift_assignments','attendance_rotation_assignments'].map(table => rows(table)))
    const rules = await rows('attendance_rules')
    const missing = await live.request('/api/attendance/timezone-context/me?workDate='+workDate,actor.token,undefined,'GET')
    expect(missing.status).toBe(422)
    expect(missing.body.error.code).toBe('ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED')
    expect(await rows('attendance_rules')).toEqual(rules)
    const saved = await save({...payload,timezone:'Asia/Tokyo'})
    expect(saved.status,saved.body.error?.code).toBe(200)
    expect(saved.body.data).toMatchObject({orgId:live.orgId,timezone:'Asia/Tokyo',isDefault:true})
    expect((await live.pool.query('SELECT timezone FROM attendance_rules WHERE org_id=$1 AND is_default=true',[live.orgId])).rows)
      .toEqual([{timezone:'Asia/Tokyo'}])
    expect(await history()).toEqual(before)
    expect(await Promise.all(['attendance_shift_assignments','attendance_rotation_assignments'].map(table => rows(table)))).toEqual(schedules)
    const current = await live.request('/api/attendance/timezone-context/me?workDate='+workDate,actor.token,undefined,'GET')
    expect(current.status,current.body.error?.code).toBe(200)
    expect(current.body.data).toMatchObject({timezone:'Asia/Tokyo',frozen:false})
  })

  it.each(['shift','rotation'])('restores with a near-date %s that has no frozen parent, leaving schedules and history unchanged',async kind => {
    const actor = await live.user()
    const scheduled = await shift(actor,workDate)
    if (kind === 'rotation') {
      await live.pool.query('DELETE FROM attendance_shift_assignments WHERE id=$1',[scheduled.assignmentId])
      const id = randomUUID()
      await live.pool.query(`INSERT INTO attendance_rotation_rules(id,org_id,name,timezone,shift_sequence)
        VALUES($1,$2,'default recovery synthetic','UTC',$3::jsonb)`,[id,live.orgId,JSON.stringify([scheduled.shiftId])])
      await live.pool.query(`INSERT INTO attendance_rotation_assignments(id,org_id,user_id,rotation_rule_id,start_date,end_date,is_active,publish_status)
        VALUES($1,$2,$3,$4,$5,$5,true,'published')`,[randomUUID(),live.orgId,actor.userId,id,workDate])
    }
    await hideDefault()
    const before = await history()
    const schedules = await Promise.all(['attendance_shift_assignments','attendance_rotation_assignments'].map(table => rows(table)))
    const saved = await save()
    expect(saved.status,saved.body.error?.code).toBe(200)
    expect((await live.pool.query('SELECT count(*)::int AS n FROM attendance_rules WHERE org_id=$1 AND is_default=true',[live.orgId])).rows).toEqual([{n:1}])
    expect(await history()).toEqual(before)
    expect(await Promise.all(['attendance_shift_assignments','attendance_rotation_assignments'].map(table => rows(table)))).toEqual(schedules)
  })

  it.each(['2026-08-10','2026-08-13'])('a nearby unfrozen date (%s) no longer blocks recovery',async date => {
    await shift(await live.user(),date)
    await hideDefault()
    const before = await history()
    const saved = await save()
    expect(saved.status,saved.body.error?.code).toBe(200)
    expect(await history()).toEqual(before)
  })

  it('permits a matching overnight frozen assignment and closes the original date without rewriting its freeze',async () => {
    const actor = await live.user()
    await shift(actor,'2026-08-11',true)
    const started = await punch(actor,'check_in','2026-08-11T20:00:00Z')
    expect(started.status,started.body.error?.code).toBe(200)
    punchClock.setOnlinePunchInstantForTests('2026-08-12T02:00:00Z')
    await hideDefault()
    const before = await history()
    const freeze = await rows('attendance_timezone_context_companions')
    const saved = await save()
    expect(saved.status,saved.body.error?.code).toBe(200)
    expect(await history()).toEqual(before)
    const closed = await punch(actor,'check_out','2026-08-12T05:00:00Z')
    expect(closed.status,closed.body.error?.code).toBe(200)
    expect(await rows('attendance_timezone_context_companions')).toEqual(freeze)
    expect((await live.pool.query('SELECT work_date::text,timezone,first_in_at,last_out_at FROM attendance_records WHERE org_id=$1 AND user_id=$2',
      [live.orgId,actor.userId])).rows).toEqual([{work_date:'2026-08-11',timezone:'UTC',first_in_at:new Date('2026-08-11T20:00:00Z'),last_out_at:new Date('2026-08-12T05:00:00Z')}])
    expect(await live.counts(actor.userId)).toMatchObject({records:1,events:2})
  })

  it('refuses a new zone that changes a frozen started published assignment and rolls back',async () => {
    const actor = await live.user()
    await shift(actor,workDate)
    expect((await punch(actor,'check_in','2026-08-12T09:00:00Z')).status).toBe(200)
    punchClock.setOnlinePunchInstantForTests(now)
    await hideDefault()
    const before = await rows('attendance_rules'), frozen = await history()
    expect(await save({...payload,timezone:'Asia/Tokyo'})).toMatchObject({status:409,body:{ok:false,error:{code:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT'}}})
    expect(await rows('attendance_rules')).toEqual(before)
    expect(await history()).toEqual(frozen)
  })

  it('a pre-companion open record (here of a departed member) no longer blocks recovery and is left unfrozen',async () => {
    const actor = await live.user()
    const id = randomUUID()
    await live.pool.query(`INSERT INTO attendance_records(id,org_id,user_id,work_date,timezone,first_in_at)
      VALUES($1,$2,$3,'2026-08-01','UTC','2026-08-01T09:00:00Z')`,[id,live.orgId,actor.userId])
    await live.pool.query('UPDATE user_orgs SET is_active=false WHERE org_id=$1 AND user_id=$2',[live.orgId,actor.userId])
    try {
      await hideDefault()
      const frozen = await history()
      const saved = await save()
      expect(saved.status,saved.body.error?.code).toBe(200)
      expect(await history()).toEqual(frozen)
      expect((await live.pool.query('SELECT count(*)::int AS n FROM attendance_timezone_context_companions WHERE record_id=$1',[id])).rows).toEqual([{n:0}])
    } finally {
      await live.pool.query("UPDATE attendance_records SET last_out_at='2026-08-01T18:00:00Z' WHERE id=$1",[id])
    }
  })

  it('preserves a frozen default-only open record when creating a different future default',async () => {
    const actor = await live.user()
    const started = await punch(actor,'check_in','2026-08-12T09:00:00Z')
    expect(started.status,started.body.error?.code).toBe(200)
    punchClock.setOnlinePunchInstantForTests(now)
    await hideDefault()
    const before = await history(), freeze = await rows('attendance_timezone_context_companions')
    const saved = await save({...payload,timezone:'Asia/Tokyo'})
    expect(saved.status,saved.body.error?.code).toBe(200)
    expect(await history()).toEqual(before)
    const closed = await punch(actor,'check_out','2026-08-12T18:00:00Z')
    expect(closed.status,closed.body.error?.code).toBe(200)
    expect(await rows('attendance_timezone_context_companions')).toEqual(freeze)
    expect((await live.pool.query('SELECT work_date::text,timezone,last_out_at FROM attendance_records WHERE org_id=$1 AND user_id=$2',
      [live.orgId,actor.userId])).rows).toEqual([{work_date:workDate,timezone:'UTC',last_out_at:new Date('2026-08-12T18:00:00Z')}])
  })

  it('requires explicit valid IANA input and refuses non-admin writes with zero rule DML',async () => {
    await hideDefault()
    const reader = await live.user(false)
    const before = await rows('attendance_rules')
    expect(await save({workStartTime:'09:00'})).toMatchObject({status:422,body:{ok:false,error:{code:'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED'}}})
    expect(await save({...payload,timezone:'Invalid/Zone'})).toMatchObject({status:400,body:{ok:false,error:{
      code:'VALIDATION_ERROR',message:'timezone must be a valid IANA time zone',
    }}})
    expect((await save(payload,reader.token)).status).toBe(403)
    expect(await rows('attendance_rules')).toEqual(before)
  })

  it('keeps ON fail-closed, then permits the explicit OFF recovery sequence',async () => {
    await live.pool.query('INSERT INTO attendance_timezone_policies(org_id,enabled,version,updated_by) VALUES($1,true,1,$2)',[live.orgId,admin.userId])
    await hideDefault()
    const before = await rows('attendance_rules')
    expect(await save()).toMatchObject({status:503,body:{ok:false,error:{code:'ATTENDANCE_TIMEZONE_DEFAULT_MISSING'}}})
    expect(await rows('attendance_rules')).toEqual(before)
    expect(await live.request('/api/attendance/timezone-policy',admin.token,{enabled:false,expectedVersion:1},'PUT'))
      .toEqual(expect.objectContaining({status:200,body:{ok:true,data:{enabled:false,version:2}}}))
    expect((await save()).status).toBe(200)
    expect((await live.pool.query('SELECT enabled,version FROM attendance_timezone_policies WHERE org_id=$1',[live.orgId])).rows)
      .toEqual([{enabled:false,version:2}])
  })

  it('rejects a second organization administrator selecting this org before recovery or default insertion',async () => {
    const otherOrg = randomUUID(), actor = await live.user()
    await live.pool.query('UPDATE user_orgs SET org_id=$1 WHERE user_id=$2 AND org_id=$3',[otherOrg,actor.userId,live.orgId])
    const minted = await live.request('/api/auth/dev-token?userId='+actor.userId+'&tenantId='+otherOrg+'&roles=viewer&perms=attendance:read,attendance:write,attendance:admin',undefined,undefined,'GET')
    expect(minted.status).toBe(200)
    await hideDefault()
    const before = await rows('attendance_rules'), otherBefore = await rows('attendance_rules',otherOrg)
    expect(await save(payload,minted.body.token)).toMatchObject({status:404,body:{ok:false,error:{code:'NOT_FOUND',message:'Group not found'}}})
    // The previous A-scoped token no longer grants A membership after the move.
    expect(await save(payload,actor.token)).toMatchObject({status:403,body:{ok:false,error:{code:'FORBIDDEN'}}})
    expect(await rows('attendance_rules')).toEqual(before)
    expect(await rows('attendance_rules',otherOrg)).toEqual(otherBefore)
  })

  it('guards effective calculation group dates while permitting future-only memberships',async () => {
    const actor = await live.user(), groupId = randomUUID(), membershipId = randomUUID()
    await live.pool.query("INSERT INTO attendance_groups(id,org_id,name,timezone) VALUES($1,$2,'default recovery synthetic','UTC')",[groupId,live.orgId])
    await live.pool.query(`INSERT INTO attendance_calculation_group_memberships(id,org_id,user_id,group_id,effective_from,assigned_by,assigned_reason,assigned_correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,'synthetic default recovery',$7)`,[membershipId,live.orgId,actor.userId,groupId,workDate,admin.userId,randomUUID()])
    await hideDefault()
    const before = await rows('attendance_rules')
    expect(await save()).toMatchObject({status:409,body:{ok:false,error:{code:'ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS'}}})
    expect(await rows('attendance_rules')).toEqual(before)
    await live.pool.query("UPDATE attendance_calculation_group_memberships SET effective_from='2026-08-15' WHERE id=$1",[membershipId])
    const membership = await rows('attendance_calculation_group_memberships')
    expect((await save()).status).toBe(200)
    expect(await rows('attendance_calculation_group_memberships')).toEqual(membership)
  })

  it('preserves the approved future trip source guard when the default is missing on OFF',async () => {
    setBusinessTripInstantForTests(now)
    const actor = await live.user()
    const flow = await live.request('/api/attendance/approval-flows',admin.token,{
      orgId:live.orgId,name:'default recovery trip synthetic',requestType:'business_trip',steps:[{approverUserIds:[admin.userId]}],
    })
    expect(flow.status,flow.body.error?.code).toBe(201)
    const made = await live.request('/api/attendance/business-trip-requests',actor.token,{
      destinationTimezone:'Asia/Singapore',startAt:'2026-08-15T00:00:00Z',endAt:'2026-08-18T00:00:00Z',
      approvalFlowId:flow.body.data.id,operationId:randomUUID(),
    })
    expect(made.status,made.body.error?.code).toBe(201)
    const requestId = made.body.data.request.id
    const cursor = (await live.pool.query(`SELECT ai.version,ai.current_node_key FROM attendance_requests r
      JOIN approval_instances ai ON ai.id=r.approval_instance_id AND ai.org_id=r.org_id WHERE r.id=$1 AND r.org_id=$2`,
    [requestId,live.orgId])).rows
    expect(cursor).toHaveLength(1)
    const approved = await live.request('/api/attendance/requests/'+requestId+'/approve',admin.token,{
      operationId:randomUUID(),expectedApprovalVersion:Number(cursor[0].version),expectedApprovalNode:String(cursor[0].current_node_key),
    })
    expect(approved).toMatchObject({status:200,body:{data:{status:'approved'}}})
    expect((await live.pool.query('SELECT enabled FROM attendance_timezone_policies WHERE org_id=$1',[live.orgId])).rows).toEqual([])
    await hideDefault()
    const before = await rows('attendance_rules'), arrangements = await rows('attendance_business_trip_arrangements'), frozen = await history()
    expect(arrangements).toHaveLength(1)
    expect(await save({...payload,timezone:'Asia/Tokyo'})).toMatchObject({status:409,body:{ok:false,error:{code:'ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS'}}})
    expect(await rows('attendance_rules')).toEqual(before)
    expect(await rows('attendance_business_trip_arrangements')).toEqual(arrangements)
    expect(await history()).toEqual(frozen)
  })
})
