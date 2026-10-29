import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { Kysely,PostgresDialect,sql } from 'kysely'
import { up as applyTripMigration, down as rollbackTripMigration } from '../../src/db/migrations/zzzz20261013090000_create_attendance_business_trips'
import { createOnlinePunchDbFixture,punchClock } from '../utils/attendance-online-punch-db'
if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('ATTENDANCE_TRIP_REAL_DATABASE_REQUIRED')
const require=createRequire(import.meta.url)
const {createAttendanceTimezonePolicyStore}=require('../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs')
const {createAttendanceTimezoneContextLoader}=require('../../../../plugins/plugin-attendance/lib/attendance-timezone-context-loader.cjs')
const {readApprovedTrips,setBusinessTripInstantForTests}=require('../../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs')
const f=createOnlinePunchDbFixture({retainHistoryInIsolatedDatabase:true})
describe('business trip empty migration roundtrip',()=>{
  it('runs actual up, down and up DDL in an isolated schema without sibling business history',async()=>{
    const db=new Kysely<unknown>({dialect:new PostgresDialect({pool:f.pool})})
    const schema='trip_migration_'+randomUUID().replaceAll('-','')
    // Sibling native suites retain immutable history in public. Exercise the
    // real migration against empty copies of its actual prerequisite tables.
    await db.transaction().execute(async trx=>{
      await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(trx)
      await sql`SET LOCAL search_path TO ${sql.id(schema)},public`.execute(trx)
      for (const table of ['users','approval_instances','attendance_requests']) {
        await sql`CREATE TABLE ${sql.id(schema,table)} (LIKE ${sql.id('public',table)} INCLUDING ALL)`.execute(trx)
      }
      await applyTripMigration(trx)
      await rollbackTripMigration(trx)
      expect((await sql<{detail_absent:boolean;arrangement_absent:boolean}>`
        SELECT to_regclass(${schema+'.attendance_business_trip_requests'}) IS NULL AS detail_absent,
          to_regclass(${schema+'.attendance_business_trip_arrangements'}) IS NULL AS arrangement_absent
      `.execute(trx)).rows).toEqual([{detail_absent:true,arrangement_absent:true}])
      await applyTripMigration(trx)
      expect((await sql<{count:number}>`
        SELECT count(*)::int AS count FROM pg_constraint
        WHERE conrelid=${schema+'.attendance_business_trip_arrangements'}::regclass AND contype='x'
      `.execute(trx)).rows).toEqual([{count:1}])
      await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(trx)
    })
    expect((await f.pool.query('SELECT to_regnamespace($1) IS NULL AS removed',[schema])).rows)
      .toEqual([{removed:true}])
  })
})
describe('business trip real request approval and destination arrangement',() => {
  let admin:Awaited<ReturnType<typeof f.user>>, employee:Awaited<ReturnType<typeof f.user>>, approver:Awaited<ReturnType<typeof f.user>>
  let flowId:string, approvedId:string
  const priorCancelEntry=process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED
  const startAt=new Date(Date.now()+7*86400000);startAt.setUTCHours(0,0,0,0)
  const endAt=new Date(startAt.getTime()+2*86400000)
  const body=()=>({destinationTimezone:'Asia/Tokyo',startAt:startAt.toISOString(),endAt:endAt.toISOString(),approvalFlowId:flowId})
  const create=async(extra:Record<string,unknown>={}) => f.request('/api/attendance/business-trip-requests',employee.token,{...body(),...extra})
  const decide=async(id:string,action='approve',token=admin.token)=>f.request(`/api/attendance/requests/${id}/${action}`,token,action==='reject'?{comment:'synthetic reject'}:{})
  const arrangements=async(id:string)=>(await f.pool.query('SELECT * FROM attendance_business_trip_arrangements WHERE request_id=$1',[id])).rows
  const idOf=(response:Awaited<ReturnType<typeof create>>)=>response.body.data.request.id as string
  beforeAll(async()=>{
    process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED='true'
    admin=await f.start();employee=await f.user(false);approver=await f.user()
    expect(process.env.RBAC_BYPASS).toBe('false');expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    await f.pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES($1,'attendance:write')",[employee.userId])
    const flow=await f.request('/api/attendance/approval-flows',admin.token,{orgId:f.orgId,name:'Synthetic trip two-step',requestType:'business_trip',steps:[{approverUserIds:[admin.userId]},{approverUserIds:[approver.userId]}]})
    expect(flow.status).toBe(201);flowId=flow.body.data.id
  },180000)
  // Configuration-positive cases use a legitimate quiet UTC boundary; cases
  // testing started shifts set the actual server clock explicitly below.
  beforeEach(()=>{const safe=new Date();safe.setUTCHours(0,0,0,0);punchClock.setOnlinePunchInstantForTests(safe)})
  afterAll(async()=>{await f.stop();if(priorCancelEntry===undefined)delete process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED;else process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED=priorCancelEntry},60000)
  it('only the dedicated route accepts business_trip; client approval metadata is rejected',async()=>{
    const generic=await f.request('/api/attendance/requests',employee.token,{requestType:'business_trip',workDate:startAt.toISOString().slice(0,10)})
    expect(generic.status).toBe(422);expect(generic.body.error.code).toBe('ATTENDANCE_TRIP_DEDICATED_ROUTE_ONLY')
    const forged=await create({metadata:{approvalStatus:'approved'}})
    expect(forged.status).toBe(422);expect(forged.body).toEqual({ok:false,error:{code:'ATTENDANCE_TRIP_INVALID_INPUT'}})
  })
  it('pending and intermediate approval publish nothing; final approval publishes exactly once without entitlement',async()=>{
    const made=await create();expect(made.status).toBe(201);const id=idOf(made)
    expect(made.body.data.businessTrip.arrangement).toBeNull();expect(await arrangements(id)).toEqual([])
    const first=await decide(id);expect(first.status).toBe(200);expect(first.body.data.status).toBe('pending');expect(await arrangements(id)).toEqual([])
    const final=await decide(id,'approve',approver.token);expect(final.status,final.body.error?.code).toBe(200);expect(final.body.data.status).toBe('approved');approvedId=id
    const rows=await arrangements(id);expect(rows).toHaveLength(1)
    expect({orgId:rows[0].org_id,userId:rows[0].user_id,zone:rows[0].destination_timezone,startAt:rows[0].start_at.toISOString(),endAt:rows[0].effective_end_at.toISOString(),version:rows[0].version})
      .toEqual({orgId:f.orgId,userId:employee.userId,zone:'Asia/Tokyo',startAt:startAt.toISOString(),endAt:endAt.toISOString(),version:1})
    const repeated=await decide(id,'approve',approver.token);expect(repeated.status).toBe(400);expect(await arrangements(id)).toHaveLength(1)
    expect(await f.counts(employee.userId)).toMatchObject({events:0,records:0})
    const cancel=await f.request(`/api/attendance/requests/${id}/cancel`,employee.token,{})
    expect(cancel.status).toBe(409);expect(cancel.body.error.code).toBe('ATTENDANCE_TRIP_CANCEL_ROUND_REQUIRED')
    expect((await arrangements(id))[0].cancelled_at).toBeNull()
  })
  it('rejection creates no arrangement and preserves immutable typed detail',async()=>{
    const made=await create();expect(made.status).toBe(201);const id=idOf(made)
    expect((await decide(id,'reject')).status).toBe(200);expect(await arrangements(id)).toEqual([])
    const detail=await f.request(`/api/attendance/business-trip-requests/${id}`,employee.token,undefined,'GET')
    expect(detail.status).toBe(200);expect(detail.body.data.request.status).toBe('rejected');expect(detail.body.data.businessTrip.arrangement).toBeNull()
    await expect(f.pool.query("UPDATE attendance_business_trip_requests SET destination_timezone='UTC' WHERE request_id=$1",[id])).rejects.toMatchObject({code:'23514'})
  })
  it('rejects overlapping final publication atomically, keeping approval pending',async()=>{
    const made=await create();expect(made.status).toBe(201);const id=idOf(made)
    expect((await decide(id)).status).toBe(200)
    const final=await decide(id,'approve',approver.token);expect(final.status).toBe(409);expect(final.body.error.code).toBe('ATTENDANCE_TRIP_OVERLAP')
    expect(await arrangements(id)).toEqual([])
    expect((await f.pool.query('SELECT r.status AS request_status,a.status AS approval_status FROM attendance_requests r JOIN approval_instances a ON a.id=r.approval_instance_id WHERE r.id=$1',[id])).rows)
      .toEqual([{request_status:'pending',approval_status:'pending'}])
  })
  it('real cancel round retains history and removes only future timezone eligibility atomically',async()=>{
    expect(approvedId).toBeTypeOf('string')
    const launch=await f.request(`/api/attendance/requests/${approvedId}/cancel-round`,employee.token,{reason:'synthetic cancellation'})
    expect(launch.status,launch.body.error?.code).toBe(201)
    expect(launch.body.data.round.outcome).toBe('pending')
    const roundId=launch.body.data.round.roundId
    const outsider=await f.user()
    const refused=await f.request(`/api/attendance/requests/${approvedId}/cancel-round/actions`,outsider.token,{action:'approve',expectedRoundId:roundId})
    expect(refused.status).toBe(403)
    expect((await arrangements(approvedId))[0].cancelled_at).toBeNull()
    for(const actor of [admin,approver]){
      const action=await f.request(`/api/attendance/requests/${approvedId}/cancel-round/actions`,actor.token,{action:'approve',expectedRoundId:roundId})
      expect(action.status,action.body.error?.code).toBe(200)
    }
    const summary=await f.request(`/api/attendance/requests/${approvedId}/cancel-round`,employee.token,undefined,'GET')
    expect(summary.status).toBe(200);expect(summary.body.data.round.status).toBe('business_trip_cancelled')
    const row=(await arrangements(approvedId))[0]
    expect({effective:row.effective_end_at.toISOString(),start:row.start_at.toISOString(),end:row.end_at.toISOString(),version:row.version})
      .toEqual({effective:startAt.toISOString(),start:startAt.toISOString(),end:endAt.toISOString(),version:2})
    expect(row.cancelled_at).toBeInstanceOf(Date)
    expect((await f.pool.query('SELECT r.status AS request_status,a.status AS approval_status FROM attendance_requests r JOIN approval_instances a ON a.id=r.approval_instance_id WHERE r.id=$1',[approvedId])).rows)
      .toEqual([{request_status:'cancelled',approval_status:'cancelled'}])
    expect(await f.counts(employee.userId)).toMatchObject({events:0,records:0})
    const replacement=await create();expect(replacement.status).toBe(201);const next=idOf(replacement)
    expect((await decide(next)).status).toBe(200)
    expect((await decide(next,'approve',approver.token)).status).toBe(200)
  })
  it('two concurrent final approvals cannot publish overlapping arrangements',async()=>{
    const subject=await f.user()
    const make=()=>f.request('/api/attendance/business-trip-requests',subject.token,body())
    const a=await make(),b=await make();expect(a.status).toBe(201);expect(b.status).toBe(201)
    const ids=[idOf(a),idOf(b)]
    for(const id of ids)expect((await decide(id)).status).toBe(200)
    const responses=await Promise.all(ids.map(id=>decide(id,'approve',approver.token)))
    expect(responses.map(response=>response.status).sort()).toEqual([200,409])
    expect(responses.find(response=>response.status===409)?.body.error.code).toBe('ATTENDANCE_TRIP_OVERLAP')
    const rows=await f.pool.query('SELECT request_id FROM attendance_business_trip_arrangements WHERE org_id=$1 AND user_id=$2',[f.orgId,subject.userId])
    expect(rows.rowCount).toBe(1)
  })
  it('default-rule working shift is authoritative without any published assignment',async()=>{
    const subject=await f.user()
    expect((await f.pool.query('SELECT id FROM attendance_shift_assignments WHERE org_id=$1 AND user_id=$2',[f.orgId,subject.userId])).rows).toEqual([])
    const partial=await f.request('/api/attendance/business-trip-requests',subject.token,{...body(),startAt:new Date(startAt.getTime()+10*3600000).toISOString()})
    expect(partial.status).toBe(201);const partialId=idOf(partial);expect((await decide(partialId)).status).toBe(200)
    const refused=await decide(partialId,'approve',approver.token)
    expect(refused.status,refused.body.error?.code).toBe(409)
    expect(refused.body.error.code).toBe('ATTENDANCE_TRIP_PARTIAL_SHIFT')
    expect(await arrangements(partialId)).toEqual([])
    expect((await f.pool.query('SELECT r.status AS request_status,a.status AS approval_status FROM attendance_requests r JOIN approval_instances a ON a.id=r.approval_instance_id WHERE r.id=$1',[partialId])).rows)
      .toEqual([{request_status:'pending',approval_status:'pending'}])
    // Covers both base and destination windows for the same work date, so the
    // half-open exit cannot introduce a second context later on that date.
    const full=await f.request('/api/attendance/business-trip-requests',subject.token,{...body(),endAt:new Date(startAt.getTime()+18*3600000).toISOString()})
    expect(full.status).toBe(201);const fullId=idOf(full);expect((await decide(fullId)).status).toBe(200)
    const approved=await decide(fullId,'approve',approver.token);expect(approved.status,approved.body.error?.code).toBe(200)
    expect(await arrangements(fullId)).toHaveLength(1)
  })
  it('default-rule reverse edits reject a new partial boundary and permit a valid future edit',async()=>{
    // Both UTC 09-18 and proposed Los Angeles 16-23 are idle at 07:00Z.
    const safe=new Date();safe.setUTCHours(7,0,0,0);punchClock.setOnlinePunchInstantForTests(safe)
    const before=(await f.pool.query('SELECT id,timezone FROM attendance_rules WHERE org_id=$1 AND is_default=true',[f.orgId])).rows
    const invalid=await f.request('/api/attendance/rules/default',admin.token,{orgId:f.orgId,timezone:'America/Los_Angeles',workStartTime:'16:00',workEndTime:'23:00',workingDays:[0,1,2,3,4,5,6]},'PUT')
    expect(invalid.status,invalid.body.error?.code).toBe(409)
    expect(['ATTENDANCE_TRIP_PARTIAL_SHIFT','ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT']).toContain(invalid.body.error.code)
    expect((await f.pool.query('SELECT id,timezone FROM attendance_rules WHERE org_id=$1 AND is_default=true',[f.orgId])).rows).toEqual(before)
    const valid=await f.request('/api/attendance/rules/default',admin.token,{orgId:f.orgId,name:'Synthetic valid future rule',timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6]},'PUT')
    expect(valid.status,valid.body.error?.code).toBe(200)
  })
  it('an authoritative default rest day permits a non-shift interval',async()=>{
    const subject=await f.user(),workingDays=[0,1,2,3,4,5,6].filter(day=>day!==startAt.getUTCDay())
    const rule=await f.request('/api/attendance/rules/default',admin.token,{orgId:f.orgId,timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',workingDays},'PUT')
    expect(rule.status,rule.body.error?.code).toBe(200)
    const made=await f.request('/api/attendance/business-trip-requests',subject.token,{...body(),startAt:new Date(startAt.getTime()+10*3600000).toISOString(),endAt:new Date(startAt.getTime()+11*3600000).toISOString()})
    expect(made.status).toBe(201);const id=idOf(made)
    expect((await decide(id)).status).toBe(200)
    const final=await decide(id,'approve',approver.token);expect(final.status,final.body.error?.code).toBe(200)
    expect(await arrangements(id)).toHaveLength(1)
    const launch=await f.request(`/api/attendance/requests/${id}/cancel-round`,subject.token,{})
    expect(launch.status,launch.body.error?.code).toBe(201)
    for(const actor of [admin,approver]){
      const action=await f.request(`/api/attendance/requests/${id}/cancel-round/actions`,actor.token,{action:'approve',expectedRoundId:launch.body.data.round.roundId})
      expect(action.status,action.body.error?.code).toBe(200)
    }
    const restored=await f.request('/api/attendance/rules/default',admin.token,{orgId:f.orgId,timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6]},'PUT')
    expect(restored.status,restored.body.error?.code).toBe(200)
  })
  it('same-key create replay preserves original request and arrangement absence',async()=>{
    const operationId=randomUUID();const first=await create({operationId});expect(first.status).toBe(201)
    const replay=await create({operationId});expect(replay.status).toBe(201);expect(replay.body).toEqual(first.body)
    expect(await arrangements(idOf(first))).toEqual([])
  })
  it('cross-org employee creation/detail and decision are refused',async()=>{
    const foreign=await f.user(false);const other=randomUUID()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=$1',[foreign.userId,other])
    const made=await create();expect(made.status).toBe(201);const id=idOf(made)
    const named=await f.request('/api/attendance/business-trip-requests',admin.token,{...body(),userId:foreign.userId})
    expect(named.status).toBe(403)
    const token=await f.request(`/api/auth/dev-token?userId=${foreign.userId}&tenantId=${other}`,undefined,undefined,'GET')
    await f.pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES($1,'attendance:admin'),($1,'attendance:approve'),($1,'attendance:write')",[foreign.userId])
    expect((await f.request(`/api/attendance/business-trip-requests/${id}`,token.body.token,undefined,'GET')).status).toBe(404)
    expect((await decide(id,'approve',token.body.token)).status).toBe(404)
    expect((await f.request('/api/attendance/requests/'+approvedId+'/cancel-round',token.body.token,undefined,'GET')).status).toBe(404)
    expect((await f.request('/api/attendance/requests/'+approvedId+'/cancel-round',token.body.token,{})).status).toBe(404)

    expect(await arrangements(id)).toEqual([])
  })
  it('inactive actor and target membership refuse creation before typed or terminal writes',async()=>{
    const actor=await f.user(),target=await f.user(false)
    const count=async(userId:string)=>(await f.pool.query('SELECT count(*)::int AS count FROM attendance_requests WHERE user_id=$1',[userId])).rows[0].count
    for(const source of ['users','user_orgs']){
      const key=source==='users'?'id':'user_id'
      await f.pool.query('UPDATE '+source+' SET is_active=false WHERE '+key+'=$1',[actor.userId])
      try{
        const denied=await f.request('/api/attendance/business-trip-requests',actor.token,body())
        expect(denied.status).toBe(source==='users'?401:403);expect(await count(actor.userId)).toBe(0)
      }finally{await f.pool.query('UPDATE '+source+' SET is_active=true WHERE '+key+'=$1',[actor.userId])}
      await f.pool.query('UPDATE '+source+' SET is_active=false WHERE '+key+'=$1',[target.userId])
      try{
        const denied=await f.request('/api/attendance/business-trip-requests',admin.token,{...body(),userId:target.userId})
        expect(denied.status).toBe(403);expect(await count(target.userId)).toBe(0)
      }finally{await f.pool.query('UPDATE '+source+' SET is_active=true WHERE '+key+'=$1',[target.userId])}
    }
  })
  it('an expired historical missed checkout does not prevent a future whole trip',async()=>{
    const subject=await f.user(),recordId=randomUUID(),shiftId=randomUUID()
    const oldStart=new Date(startAt.getTime()-20*86400000);oldStart.setUTCHours(9)
    const oldEnd=new Date(oldStart.getTime()+9*3600000),workDate=oldStart.toISOString().slice(0,10)
    const meta={workDateAttributionV1:{version:1,orgId:f.orgId,userId:subject.userId,workDate,shiftId,segmentIndex:null,
      evidenceSnapshot:{attributionTailMinutes:0,winner:{workDate,shiftId,absoluteWindow:{startAt:oldStart.toISOString(),endAt:oldEnd.toISOString()}}}}}
    await f.pool.query("INSERT INTO attendance_records(id,org_id,user_id,work_date,timezone,first_in_at,meta) VALUES($1,$2,$3,$4,'UTC',$5,$6::jsonb)",
      [recordId,f.orgId,subject.userId,workDate,oldStart,JSON.stringify(meta)])
    const made=await f.request('/api/attendance/business-trip-requests',subject.token,body())
    expect(made.status).toBe(201);const id=idOf(made)
    expect((await decide(id)).status).toBe(200)
    const final=await decide(id,'approve',approver.token)
    expect(final.status,final.body.error?.code).toBe(200)
    expect(await arrangements(id)).toHaveLength(1)
    const retained=(await f.pool.query('SELECT meta,last_out_at FROM attendance_records WHERE id=$1',[recordId])).rows[0]
    expect(retained).toEqual({meta,last_out_at:null})
  })
  it('generic pending edit cannot drift immutable trip detail or convert another type into a trip',async()=>{
    const made=await create();expect(made.status).toBe(201);const id=idOf(made)
    const before=(await f.pool.query('SELECT * FROM attendance_requests WHERE id=$1',[id])).rows
    const edited=await f.request('/api/attendance/requests/'+id,employee.token,{requestType:'time_correction',reason:'changed generic reason'},'PUT')
    expect(edited.status,edited.body.error?.code).toBe(422)
    expect(edited.body.error.code).toBe('ATTENDANCE_TRIP_EDIT_UNSUPPORTED')
    expect((await f.pool.query('SELECT * FROM attendance_requests WHERE id=$1',[id])).rows).toEqual(before)
    const correction=await f.request('/api/attendance/requests',employee.token,{orgId:f.orgId,requestType:'time_correction',workDate:startAt.toISOString().slice(0,10),requestedInAt:startAt.toISOString(),reason:'synthetic correction'})
    expect(correction.status,correction.body.error?.code).toBe(201)
    const correctionId=correction.body.data.request.id
    const normalEdit=await f.request('/api/attendance/requests/'+correctionId,employee.token,{reason:'synthetic correction edited'},'PUT')
    expect(normalEdit.status,normalEdit.body.error?.code).toBe(200)
    const converted=await f.request('/api/attendance/requests/'+correctionId,employee.token,{requestType:'business_trip'},'PUT')
    expect(converted.status,converted.body.error?.code).toBe(422)
    expect(converted.body.error.code).toBe('ATTENDANCE_TRIP_DEDICATED_ROUTE_ONLY')
    expect((await f.pool.query('SELECT request_type FROM attendance_requests WHERE id=$1',[correctionId])).rows).toEqual([{request_type:'time_correction'}])
  })
  it('generic item read cannot use a caller org selector to expose another organization trip',async()=>{
    const actor=await f.user(),orgId=randomUUID()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=$1',[actor.userId,orgId])
    const token=(await f.request('/api/auth/dev-token?userId='+actor.userId+'&tenantId='+orgId,undefined,undefined,'GET')).body.token
    const got=await f.request('/api/attendance/requests/'+approvedId+'?orgId='+f.orgId,token,undefined,'GET')
    expect(got.status).toBe(404)
  })
  it('generic list cannot expose trip rows or counts through a caller organization selector',async()=>{
    const actor=await f.user(),orgId=randomUUID()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=$1',[actor.userId,orgId])
    const token=(await f.request('/api/auth/dev-token?userId='+actor.userId+'&tenantId='+orgId,undefined,undefined,'GET')).body.token
    const got=await f.request('/api/attendance/requests?orgId='+f.orgId+'&userId='+employee.userId+'&from='+startAt.toISOString().slice(0,10)+'&to='+endAt.toISOString().slice(0,10),token,undefined,'GET')
    expect(got.status).toBe(200)
    expect(got.body.data.items.filter((item:{request_type:string})=>item.request_type==='business_trip')).toEqual([])
    expect(got.body.data.total).toBe(got.body.data.items.length)
  })
  it('started published no-punch cancellation retains trip authority through the whole work date',async()=>{
    const orgId=randomUUID(),owner=await f.user(),seat=await f.user(),shiftId=randomUUID(),assignmentId=randomUUID()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=ANY($1::text[])',[[owner.userId,seat.userId],orgId])
    const mint=async(userId:string)=>(await f.request(`/api/auth/dev-token?userId=${userId}&tenantId=${orgId}`,undefined,undefined,'GET')).body.token as string
    const ownerToken=await mint(owner.userId),seatToken=await mint(seat.userId)
    expect((await f.request('/api/attendance/rules/default',ownerToken,{orgId,timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6]},'PUT')).status).toBe(200)
    const query=(sql:string,values:unknown[])=>f.pool.query(sql,values)
    const store=createAttendanceTimezonePolicyStore({query,authorizeManage:async(input:{orgId:string,actorId:string})=>input.orgId===orgId&&input.actorId===owner.userId,
      transaction:async(work:(q:typeof query)=>Promise<unknown>)=>{
        const client=await f.pool.connect();try{await client.query('BEGIN');const value=await work((sql,values)=>client.query(sql,values));await client.query('COMMIT');return value}
        catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
      }})
    await store.setPolicy({orgId,actorId:owner.userId,enabled:true,expectedVersion:0})
    await f.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,working_days)
      VALUES($1,$2,'synthetic trip published','UTC','09:00','18:00',false,'[0,1,2,3,4,5,6]'::jsonb)`,[shiftId,orgId])
    await f.pool.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status,slot_index)
      VALUES($1,$2,$3,$4,$5,$5,true,'published',1)`,[assignmentId,orgId,owner.userId,shiftId,startAt.toISOString().slice(0,10)])
    const flow=await f.request('/api/attendance/approval-flows',ownerToken,{orgId,name:'synthetic started trip',requestType:'business_trip',steps:[{approverUserIds:[seat.userId]}]})
    expect(flow.status).toBe(201)
    const made=await f.request('/api/attendance/business-trip-requests',ownerToken,{...body(),approvalFlowId:flow.body.data.id})
    expect(made.status,made.body.error?.code).toBe(201);const id=idOf(made)
    const approved=await decide(id,'approve',seatToken);expect(approved.status,approved.body.error?.code).toBe(200)
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0})
    const at=new Date(startAt.getTime()+2*3600000),cutoff=new Date(startAt.getTime()+18*3600000)
    // Advance only the trusted trip server clock; JWT/network clocks stay real.
    setBusinessTripInstantForTests(at)
    try{
      const launch=await f.request(`/api/attendance/requests/${id}/cancel-round`,ownerToken,{})
      expect(launch.status,launch.body.error?.code).toBe(201)
      const action=await f.request(`/api/attendance/requests/${id}/cancel-round/actions`,seatToken,{action:'approve',expectedRoundId:launch.body.data.round.roundId})
      expect(action.status,action.body.error?.code).toBe(200);expect(action.body.data.status).toBe('business_trip_cancelled')
      const row=(await arrangements(id))[0]
      expect(row.effective_end_at.toISOString()).toBe(cutoff.toISOString());expect(row.version).toBe(2)
      expect(row.end_at.toISOString()).toBe(endAt.toISOString())
      expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0})
      const load=createAttendanceTimezoneContextLoader({query,policyStore:store,readApprovedTrips})
      const stillTrip=await load({orgId,userId:owner.userId,occurredAt:at,workDate:startAt.toISOString().slice(0,10)})
      expect({source:stillTrip.source,timezone:stillTrip.timezone,version:stillTrip.version,referenceId:stillTrip.referenceId})
        .toEqual({source:'trip',timezone:'Asia/Tokyo',version:2,referenceId:id})
      const after=await load({orgId,userId:owner.userId,occurredAt:cutoff,workDate:startAt.toISOString().slice(0,10)})
      expect({source:after.source,timezone:after.timezone}).toEqual({source:'system_default',timezone:'UTC'})
    }finally{setBusinessTripInstantForTests(null)}
  },60000)
  it('a checked-in trip cancellation keeps the original frozen checkout and exact replay, then new work dates use base',async()=>{
    const startAt=new Date(Date.now()-7*86400000);startAt.setUTCHours(0,0,0,0)
    const endAt=new Date(startAt.getTime()+2*86400000)
    const orgId=randomUUID(),owner=await f.user(),seat=await f.user()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=ANY($1::text[])',[[owner.userId,seat.userId],orgId])
    const mint=async(userId:string)=>(await f.request('/api/auth/dev-token?userId='+userId+'&tenantId='+orgId,undefined,undefined,'GET')).body.token as string
    const ownerToken=await mint(owner.userId),seatToken=await mint(seat.userId)
    expect((await f.request('/api/attendance/rules/default',ownerToken,{orgId,timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6]},'PUT')).status).toBe(200)
    const query=(sql:string,values:unknown[])=>f.pool.query(sql,values)
    const store=createAttendanceTimezonePolicyStore({query,authorizeManage:async(input:{orgId:string,actorId:string})=>input.orgId===orgId&&input.actorId===owner.userId,
      transaction:async(work:(q:typeof query)=>Promise<unknown>)=>{
        const client=await f.pool.connect();try{await client.query('BEGIN');const value=await work((sql,values)=>client.query(sql,values));await client.query('COMMIT');return value}
        catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
      }})
    await store.setPolicy({orgId,actorId:owner.userId,enabled:true,expectedVersion:0})
    const flow=await f.request('/api/attendance/approval-flows',ownerToken,{orgId,name:'synthetic frozen trip',requestType:'business_trip',steps:[{approverUserIds:[seat.userId]}]})
    expect(flow.status).toBe(201)
    const made=await f.request('/api/attendance/business-trip-requests',ownerToken,{...body(),startAt:startAt.toISOString(),endAt:endAt.toISOString(),approvalFlowId:flow.body.data.id})
    expect(made.status,made.body.error?.code).toBe(201);const id=idOf(made)
    setBusinessTripInstantForTests(new Date(startAt.getTime()-86400000))
    try{expect((await decide(id,'approve',seatToken)).status).toBe(200)}finally{setBusinessTripInstantForTests(null)}
    const operationId=randomUUID(),checkInAt=new Date(startAt.getTime()+3600000)
    const punch=async(eventType:'check_in'|'check_out',instant:Date,key=randomUUID())=>{
      punchClock.setOnlinePunchInstantForTests(instant.toISOString())
      return f.request('/api/attendance/punch',ownerToken,{orgId,eventType,operationId:key})
    }
    try{
      const entered=await punch('check_in',checkInAt,operationId)
      expect(entered.status,entered.body.error?.code).toBe(200)
      const frozen=(await f.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[orgId,owner.userId])).rows
      expect(frozen).toHaveLength(1)
      expect(frozen[0].frame_snapshot.timezoneContext).toMatchObject({timezone:'Asia/Tokyo',source:'trip',referenceId:id,version:1})
      expect(frozen[0].original_freeze_fingerprint).toMatch(/^[0-9a-f]{64}$/)
      setBusinessTripInstantForTests(new Date(startAt.getTime()+2*3600000))
      const launch=await f.request('/api/attendance/requests/'+id+'/cancel-round',ownerToken,{})
      expect(launch.status,launch.body.error?.code).toBe(201)
      const cancelled=await f.request('/api/attendance/requests/'+id+'/cancel-round/actions',seatToken,{action:'approve',expectedRoundId:launch.body.data.round.roundId})
      expect(cancelled.status,cancelled.body.error?.code).toBe(200)
      expect(cancelled.body.data.status).toBe('business_trip_cancelled')
      expect((await arrangements(id))[0].version).toBe(2)
      const exited=await punch('check_out',new Date(startAt.getTime()+3*3600000))
      expect(exited.status,exited.body.error?.code).toBe(200)
      expect((await f.pool.query('SELECT * FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2',[orgId,owner.userId])).rows).toEqual(frozen)
      expect((await f.pool.query('SELECT event_type,timezone FROM attendance_events WHERE org_id=$1 AND user_id=$2 ORDER BY occurred_at',[orgId,owner.userId])).rows)
        .toEqual([{event_type:'check_in',timezone:'Asia/Tokyo'},{event_type:'check_out',timezone:'Asia/Tokyo'}])
      expect(await f.counts(owner.userId)).toMatchObject({events:2,records:1})
      const replay=await punch('check_in',new Date(endAt.getTime()+86400000),operationId)
      expect(replay).toEqual(entered)
      expect(await f.counts(owner.userId)).toMatchObject({events:2,records:1})
      const next=await punch('check_in',new Date(startAt.getTime()+86400000+10*3600000))
      expect(next.status,next.body.error?.code).toBe(200)
      const frames=(await f.pool.query('SELECT frame_snapshot FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 ORDER BY work_date',[orgId,owner.userId])).rows
      expect(frames).toHaveLength(2)
      expect(frames[1].frame_snapshot.timezoneContext).toMatchObject({timezone:'UTC',source:'system_default'})
      expect(frames[0].frame_snapshot).toEqual(frozen[0].frame_snapshot)
    }finally{punchClock.setOnlinePunchInstantForTests(null);setBusinessTripInstantForTests(null)}
  },60000)
  it('an interior published multi-context date blocks final approval even when both trip boundaries are legal',async()=>{
    const owner=await f.user(),workDate=new Date(startAt.getTime()+10*86400000).toISOString().slice(0,10)
    for(const [slot,begin,end] of [[1,'09:00','12:00'],[2,'13:00','18:00']] as const){
      const shiftId=randomUUID()
      await f.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,working_days)
        VALUES($1,$2,'synthetic interior trip','UTC',$3,$4,false,'[0,1,2,3,4,5,6]'::jsonb)`,[shiftId,f.orgId,begin,end])
      await f.pool.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status,slot_index)
        VALUES($1,$2,$3,$4,$5,$5,true,'published',$6)`,[randomUUID(),f.orgId,owner.userId,shiftId,workDate,slot])
    }
    const made=await f.request('/api/attendance/business-trip-requests',owner.token,{...body(),endAt:new Date(startAt.getTime()+30*86400000).toISOString()})
    expect(made.status,made.body.error?.code).toBe(201);const id=idOf(made)
    expect((await decide(id)).status).toBe(200)
    const before=(await f.pool.query('SELECT status,metadata FROM attendance_requests WHERE id=$1',[id])).rows
    const rejected=await decide(id,'approve',approver.token)
    expect(rejected.status,rejected.body.error?.code).toBe(409)
    expect(rejected.body.error.code).toBe('ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT')
    expect(await arrangements(id)).toEqual([])
    expect((await f.pool.query('SELECT status,metadata FROM attendance_requests WHERE id=$1',[id])).rows).toEqual(before)
    expect((await f.pool.query('SELECT status FROM approval_instances WHERE id=(SELECT approval_instance_id FROM attendance_requests WHERE id=$1)',[id])).rows).toEqual([{status:'pending'}])
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0})
  },60000)
  it('a legal long trip has no invented duration ceiling',async()=>{
    const owner=await f.user(),end=new Date(startAt.getTime()+400*86400000)
    const made=await f.request('/api/attendance/business-trip-requests',owner.token,{...body(),endAt:end.toISOString()})
    expect(made.status,made.body.error?.code).toBe(201);const id=idOf(made)
    expect((await decide(id)).status).toBe(200)
    const approved=await decide(id,'approve',approver.token)
    expect(approved.status,approved.body.error?.code).toBe(200)
    expect((await arrangements(id))[0].end_at).toEqual(end)
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0})
  },60000)
  it.each(['rule','published'] as const)('an interior spring DST gap from the actual %s source prevents final publication',async(source)=>{
    const orgId=randomUUID(),owner=await f.user(),seat=await f.user()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=ANY($1::text[])',[[owner.userId,seat.userId],orgId])
    const mint=async(userId:string)=>(await f.request('/api/auth/dev-token?userId='+userId+'&tenantId='+orgId,undefined,undefined,'GET')).body.token as string
    const ownerToken=await mint(owner.userId),seatToken=await mint(seat.userId)
    const rules=await f.request('/api/attendance/rules/default',ownerToken,{orgId,timezone:'America/New_York',
      workStartTime:source==='rule'?'02:30':'00:30',workEndTime:source==='rule'?'10:00':'01:00',workingDays:[0,1,2,3,4,5,6]},'PUT')
    expect(rules.status,rules.body.error?.code).toBe(200)
    if(source==='published'){
      const shiftId=randomUUID()
      await f.pool.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,working_days)
        VALUES($1,$2,'synthetic interior DST','America/New_York','02:30','10:00',false,'[0,1,2,3,4,5,6]'::jsonb)`,[shiftId,orgId])
      await f.pool.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,publish_status)
        VALUES($1,$2,$3,$4,'2027-03-01','2027-03-31',true,'published')`,[randomUUID(),orgId,owner.userId,shiftId])
    }
    const flow=await f.request('/api/attendance/approval-flows',ownerToken,{orgId,name:'synthetic interior DST',requestType:'business_trip',steps:[{approverUserIds:[seat.userId]}]})
    expect(flow.status).toBe(201)
    const made=await f.request('/api/attendance/business-trip-requests',ownerToken,{destinationTimezone:'America/New_York',
      startAt:'2027-03-01T05:00:00.000Z',endAt:'2027-04-01T04:00:00.000Z',approvalFlowId:flow.body.data.id})
    expect(made.status,made.body.error?.code).toBe(201);const id=idOf(made)
    const before=(await f.pool.query('SELECT status,metadata FROM attendance_requests WHERE id=$1',[id])).rows
    setBusinessTripInstantForTests('2027-02-28T00:00:00Z')
    try{
      const rejected=await decide(id,'approve',seatToken)
      expect(rejected.status,rejected.body.error?.code).toBe(422)
      expect(rejected.body.error).toEqual({code:'ATTENDANCE_TIMEZONE_WALL_INVALID',message:'ATTENDANCE_TIMEZONE_WALL_INVALID'})
    }finally{setBusinessTripInstantForTests(null)}
    expect(await arrangements(id)).toEqual([])
    expect((await f.pool.query('SELECT status,metadata FROM attendance_requests WHERE id=$1',[id])).rows).toEqual(before)
    expect((await f.pool.query('SELECT status FROM approval_instances WHERE id=(SELECT approval_instance_id FROM attendance_requests WHERE id=$1)',[id])).rows).toEqual([{status:'pending'}])
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0})
    const valid=await f.request('/api/attendance/business-trip-requests',ownerToken,{destinationTimezone:'America/New_York',
      startAt:'2027-03-15T04:00:00.000Z',endAt:'2027-03-17T04:00:00.000Z',approvalFlowId:flow.body.data.id})
    expect(valid.status,valid.body.error?.code).toBe(201)
    setBusinessTripInstantForTests('2027-03-01T00:00:00Z')
    try{
      const accepted=await decide(idOf(valid),'approve',seatToken)
      expect(accepted.status,accepted.body.error?.code).toBe(200)
    }finally{setBusinessTripInstantForTests(null)}
    expect(await arrangements(idOf(valid))).toHaveLength(1)
  },60000)
  it('a date-line destination cannot hide a different base context on the same target work date after exit',async()=>{
    const orgId=randomUUID(),owner=await f.user(),seat=await f.user()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=ANY($1::text[])',[[owner.userId,seat.userId],orgId])
    const mint=async(userId:string)=>(await f.request('/api/auth/dev-token?userId='+userId+'&tenantId='+orgId,undefined,undefined,'GET')).body.token as string
    const ownerToken=await mint(owner.userId),seatToken=await mint(seat.userId)
    const rule=await f.request('/api/attendance/rules/default',ownerToken,{orgId,timezone:'Pacific/Pago_Pago',
      workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6]},'PUT')
    expect(rule.status,rule.body.error?.code).toBe(200)
    const flow=await f.request('/api/attendance/approval-flows',ownerToken,{orgId,name:'synthetic date-line trip',requestType:'business_trip',steps:[{approverUserIds:[seat.userId]}]})
    expect(flow.status).toBe(201)
    // Destination workDate D: 09-18 = D-1 19Z..D 04Z. The base shift
    // for the SAME D is D 20Z..D+1 05Z, wholly after this trip's exit.
    const from=new Date(startAt.getTime()-14*3600000),to=new Date(from.getTime()+86400000)
    const made=await f.request('/api/attendance/business-trip-requests',ownerToken,{destinationTimezone:'Pacific/Kiritimati',
      startAt:from.toISOString(),endAt:to.toISOString(),approvalFlowId:flow.body.data.id})
    expect(made.status,made.body.error?.code).toBe(201);const id=idOf(made)
    const rejected=await decide(id,'approve',seatToken)
    expect(rejected.status,rejected.body.error?.code).toBe(409)
    expect(rejected.body.error).toEqual({code:'ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT',message:'ATTENDANCE_TRIP_WORK_DATE_CONTEXT_CONFLICT'})
    expect(await arrangements(id)).toEqual([])
    expect((await f.pool.query('SELECT status FROM attendance_requests WHERE id=$1',[id])).rows).toEqual([{status:'pending'}])
    expect((await f.pool.query('SELECT status FROM approval_instances WHERE id=(SELECT approval_instance_id FROM attendance_requests WHERE id=$1)',[id])).rows).toEqual([{status:'pending'}])
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0})
  },60000)
  it('a default-rule edit cannot create an interior DST gap in an approved trip, while a valid future edit remains legal',async()=>{
    const orgId=randomUUID(),owner=await f.user(),seat=await f.user()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=ANY($1::text[])',[[owner.userId,seat.userId],orgId])
    const mint=async(userId:string)=>(await f.request('/api/auth/dev-token?userId='+userId+'&tenantId='+orgId,undefined,undefined,'GET')).body.token as string
    const ownerToken=await mint(owner.userId),seatToken=await mint(seat.userId)
    const update=(workStartTime:string)=>f.request('/api/attendance/rules/default',ownerToken,{orgId,timezone:'America/New_York',
      workStartTime,workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6]},'PUT')
    expect((await update('09:00')).status).toBe(200)
    const flow=await f.request('/api/attendance/approval-flows',ownerToken,{orgId,name:'synthetic reverse DST',requestType:'business_trip',steps:[{approverUserIds:[seat.userId]}]})
    expect(flow.status).toBe(201)
    const made=await f.request('/api/attendance/business-trip-requests',ownerToken,{destinationTimezone:'America/New_York',
      startAt:'2027-03-01T05:00:00.000Z',endAt:'2027-04-01T04:00:00.000Z',approvalFlowId:flow.body.data.id})
    expect(made.status,made.body.error?.code).toBe(201);const id=idOf(made)
    setBusinessTripInstantForTests('2027-02-28T00:00:00Z')
    try{expect((await decide(id,'approve',seatToken)).status).toBe(200)}finally{setBusinessTripInstantForTests(null)}
    const originalRule=(await f.pool.query('SELECT * FROM attendance_rules WHERE org_id=$1 AND is_default=true',[orgId])).rows
    const originalArrangement=await arrangements(id)
    const rejected=await update('02:30')
    expect(rejected.status,rejected.body.error?.code).toBe(422)
    expect(rejected.body.error).toEqual({code:'ATTENDANCE_TIMEZONE_WALL_INVALID'})
    expect((await f.pool.query('SELECT * FROM attendance_rules WHERE org_id=$1 AND is_default=true',[orgId])).rows).toEqual(originalRule)
    expect(await arrangements(id)).toEqual(originalArrangement)
    const accepted=await update('08:30')
    expect(accepted.status,accepted.body.error?.code).toBe(200)
    expect(await arrangements(id)).toEqual(originalArrangement)
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0})
  },60000)
  it('an unused interior base-zone gap does not invalidate unique destination shift instants',async()=>{
    const orgId=randomUUID(),owner=await f.user(),seat=await f.user()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=ANY($1::text[])',[[owner.userId,seat.userId],orgId])
    const mint=async(userId:string)=>(await f.request('/api/auth/dev-token?userId='+userId+'&tenantId='+orgId,undefined,undefined,'GET')).body.token as string
    const ownerToken=await mint(owner.userId),seatToken=await mint(seat.userId)
    expect((await f.request('/api/attendance/rules/default',ownerToken,{orgId,timezone:'America/New_York',
      workStartTime:'02:30',workEndTime:'10:00',workingDays:[0,1,2,3,4,5,6]},'PUT')).status).toBe(200)
    // Synthetic persisted ON fixture; this is not admin config HTTP proof.
    await f.pool.query('INSERT INTO attendance_timezone_policies(org_id,enabled,version,updated_by) VALUES($1,true,1,$2)',[orgId,owner.userId])
    const flow=await f.request('/api/attendance/approval-flows',ownerToken,{orgId,name:'synthetic destination unique',requestType:'business_trip',steps:[{approverUserIds:[seat.userId]}]})
    expect(flow.status).toBe(201)
    const made=await f.request('/api/attendance/business-trip-requests',ownerToken,{destinationTimezone:'UTC',
      startAt:'2027-03-01T00:00:00.000Z',endAt:'2027-04-01T00:00:00.000Z',approvalFlowId:flow.body.data.id})
    expect(made.status,made.body.error?.code).toBe(201);const id=idOf(made)
    setBusinessTripInstantForTests('2027-02-28T00:00:00Z')
    try{
      const accepted=await decide(id,'approve',seatToken)
      expect(accepted.status,accepted.body.error?.code).toBe(200)
    }finally{setBusinessTripInstantForTests(null)}
    expect(await arrangements(id)).toHaveLength(1)
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0})
  },60000)
  async function calendarOwner() {
    const orgId=randomUUID(),owner=await f.user()
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=$1',[owner.userId,orgId])
    const token=(await f.request('/api/auth/dev-token?userId='+owner.userId+'&tenantId='+orgId,undefined,undefined,'GET')).body.token as string
    const response=await f.request('/api/attendance/rules/default',token,{orgId,timezone:'UTC',workStartTime:'09:00',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6]},'PUT')
    expect(response.status,response.body.error?.code).toBe(200)
    return {orgId,token,userId:owner.userId}
  }
  it('default-rule and holiday CRUD preserve started fallback shifts without punches or trips',async()=>{
    const owner=await calendarOwner(),date='2026-08-20'
    punchClock.setOnlinePunchInstantForTests(new Date(date+'T10:00:00Z'))
    const before=(await f.pool.query('SELECT * FROM attendance_rules WHERE org_id=$1',[owner.orgId])).rows
    const foreign=await f.request('/api/attendance/rules/default',admin.token,{orgId:owner.orgId,timezone:'UTC'},'PUT')
    expect(foreign.status).toBe(404)
    expect(foreign.body).toEqual({ok:false,error:{code:'NOT_FOUND',message:'Group not found'}})
    const rule=await f.request('/api/attendance/rules/default',owner.token,{orgId:owner.orgId,timezone:'UTC',workStartTime:'08:30',workEndTime:'18:00',workingDays:[0,1,2,3,4,5,6]},'PUT')
    expect(rule.status).toBe(409);expect(rule.body.error).toEqual({code:'ATTENDANCE_TIMEZONE_STARTED_CONTEXT_CONFLICT'})
    expect((await f.pool.query('SELECT * FROM attendance_rules WHERE org_id=$1',[owner.orgId])).rows).toEqual(before)
    const create=(day:string,working=false)=>f.request('/api/attendance/holidays',owner.token,{date:day,name:'synthetic calendar',isWorkingDay:working})
    const blocked=await create(date)
    expect(blocked.status,blocked.body.error?.code).toBe(409)
    expect((await f.pool.query('SELECT * FROM attendance_holidays WHERE org_id=$1',[owner.orgId])).rows).toEqual([])
    const future=await create('2026-08-21');expect(future.status,future.body.error?.code).toBe(201)
    const id=future.body.data.id,prior=(await f.pool.query('SELECT * FROM attendance_holidays WHERE id=$1',[id])).rows
    const edit=await f.request('/api/attendance/holidays/'+id,owner.token,{date},'PUT')
    expect(edit.status,edit.body.error?.code).toBe(409)
    expect((await f.pool.query('SELECT * FROM attendance_holidays WHERE id=$1',[id])).rows).toEqual(prior)
    expect((await f.request('/api/attendance/holidays/'+id,owner.token,undefined,'DELETE')).status).toBe(200)
    punchClock.setOnlinePunchInstantForTests(new Date(date+'T00:00:00Z'))
    const rest=await create(date);expect(rest.status,rest.body.error?.code).toBe(201)
    punchClock.setOnlinePunchInstantForTests(new Date(date+'T10:00:00Z'))
    const deletion=await f.request('/api/attendance/holidays/'+rest.body.data.id,owner.token,undefined,'DELETE')
    expect(deletion.status,deletion.body.error?.code).toBe(409)
    expect((await f.pool.query('SELECT id FROM attendance_holidays WHERE id=$1',[rest.body.data.id])).rowCount).toBe(1)
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0,requests:0})
  })
  it('holiday sync rolls back every fetched year on a started shift conflict and allows future-only sync',async()=>{
    const owner=await calendarOwner(),before=(await f.pool.query("SELECT * FROM system_configs WHERE key='attendance.settings'")).rows
    let conflict=true
    const source=createServer((request,response)=>{
      response.setHeader('Content-Type','application/json')
      response.end(JSON.stringify({days:[{date:conflict&&request.url==='/2026.json'?'2026-08-20':'2027-08-20',name:'synthetic sync',isOffDay:true}]}))
    })
    await new Promise<void>(resolve=>source.listen(0,'127.0.0.1',resolve))
    try {
      const address=source.address();if(!address||typeof address==='string')throw new Error('TRIP_SYNTHETIC_SOURCE_REQUIRED')
      punchClock.setOnlinePunchInstantForTests(new Date('2026-08-20T10:00:00Z'))
      const sync=()=>f.request('/api/attendance/holidays/sync',owner.token,{years:[2027,2026],baseUrl:'http://127.0.0.1:'+address.port,overwrite:true})
      const blocked=await sync();expect(blocked.status,blocked.body.error?.code).toBe(409)
      expect((await f.pool.query('SELECT * FROM attendance_holidays WHERE org_id=$1',[owner.orgId])).rows).toEqual([])
      expect((await f.pool.query("SELECT * FROM system_configs WHERE key='attendance.settings'")).rows).toEqual(before)
      conflict=false
      const accepted=await sync();expect(accepted.status,accepted.body.error?.code).toBe(200)
      expect((await f.pool.query('SELECT holiday_date::text AS date FROM attendance_holidays WHERE org_id=$1',[owner.orgId])).rows).toEqual([{date:'2027-08-20'}])
    } finally {await new Promise<void>((resolve,reject)=>source.close(error=>error?reject(error):resolve()))}
  },60000)
  it('global calendar overrides protect another organization started fallback and commit a future-only patch',async()=>{
    const owner=await calendarOwner(),before=(await f.pool.query("SELECT * FROM system_configs WHERE key='attendance.settings'")).rows
    punchClock.setOnlinePunchInstantForTests(new Date('2026-08-20T10:00:00Z'))
    const update=(date:string)=>f.request('/api/attendance/settings',admin.token,{calendarPolicy:{overrides:[{id:randomUUID(),date,
      filters:{userIds:[owner.userId]},effective:{isWorkingDay:false,source:'user'}}]}},'PUT')
    const blocked=await update('2026-08-20')
    expect(blocked.status,blocked.body.error?.code).toBe(409)
    expect((await f.pool.query("SELECT * FROM system_configs WHERE key='attendance.settings'")).rows).toEqual(before)
    const accepted=await update('2026-08-21')
    expect(accepted.status,accepted.body.error?.code).toBe(200)
    expect(accepted.body.data.calendarPolicy.overrides).toHaveLength(1)
    const stable=accepted.body.data.calendarPolicy
    const status=await f.request('/api/attendance/settings',admin.token,{holidaySync:{lastRun:{success:true}}},'PUT')
    expect(status.status,status.body.error?.code).toBe(200)
    expect(status.body.data.calendarPolicy).toEqual(stable)
    expect(await f.counts(owner.userId)).toMatchObject({events:0,records:0,requests:0})
  },60000)
  it('revoked actor membership refuses all calendar source-management writes without source or audit changes',async()=>{
    const owner=await calendarOwner()
    const holiday=await f.request('/api/attendance/holidays',owner.token,{date:'2028-01-02',name:'synthetic membership',isWorkingDay:false})
    expect(holiday.status).toBe(201)
    const snapshot=async()=>({
      rules:(await f.pool.query('SELECT * FROM attendance_rules WHERE org_id=$1 ORDER BY id',[owner.orgId])).rows,
      holidays:(await f.pool.query('SELECT * FROM attendance_holidays WHERE org_id=$1 ORDER BY id',[owner.orgId])).rows,
      settings:(await f.pool.query("SELECT * FROM system_configs WHERE key='attendance.settings'")).rows,
      audit:(await f.pool.query('SELECT * FROM attendance_timezone_policy_audit WHERE org_id=$1 ORDER BY id',[owner.orgId])).rows,
    })
    const before=await snapshot()
    const source=createServer((_request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({days:[]}))})
    await new Promise<void>(resolve=>source.listen(0,'127.0.0.1',resolve))
    try{
      const address=source.address();if(!address||typeof address==='string')throw new Error('TRIP_SYNTHETIC_SOURCE_REQUIRED')
      const requests=[
        ()=>f.request('/api/attendance/rules/default',owner.token,{orgId:owner.orgId,timezone:'UTC'},'PUT'),
        ()=>f.request('/api/attendance/holidays',owner.token,{date:'2028-01-03',name:'synthetic refused holiday',isWorkingDay:false}),
        ()=>f.request('/api/attendance/holidays/'+holiday.body.data.id,owner.token,{name:'changed'},'PUT'),
        ()=>f.request('/api/attendance/holidays/'+holiday.body.data.id,owner.token,undefined,'DELETE'),
        ()=>f.request('/api/attendance/holidays/sync',owner.token,{years:[2028],baseUrl:'http://127.0.0.1:'+address.port}),
        ()=>f.request('/api/attendance/settings',owner.token,{calendarPolicy:{overrides:[]}},'PUT'),
      ]
      for(const [requestIndex,request] of requests.entries()){
        await f.pool.query('UPDATE user_orgs SET is_active=true WHERE org_id=$1 AND user_id=$2',[owner.orgId,owner.userId])
        const blocker=await f.pool.connect()
        let pending:ReturnType<typeof request>|undefined
        let completed:Awaited<ReturnType<typeof request>>|undefined
        try{
          await blocker.query('BEGIN')
          const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
          await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [JSON.stringify(['attendance-timezone-policy-v1',owner.orgId])])
          pending=request().then(response=>{completed=response;return response})
          let waiting=false
          for(let attempt=0;attempt<250;attempt++){
            const locks=await f.pool.query(`SELECT 1 FROM pg_locks held JOIN pg_locks waiting
              ON held.locktype=waiting.locktype AND held.database=waiting.database
              AND held.classid=waiting.classid AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
              WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted=true AND waiting.granted=false`,[pid])
            if(locks.rowCount){waiting=true;break}
            if(completed)break
            await new Promise(resolve=>setTimeout(resolve,20))
          }
          expect(waiting,'source writer '+requestIndex+' must wait at policy prefix; early status '+completed?.status+' code '+completed?.body.error?.code).toBe(true)
          await blocker.query('UPDATE user_orgs SET is_active=false WHERE org_id=$1 AND user_id=$2',[owner.orgId,owner.userId])
          await blocker.query('COMMIT')
          const refused=await pending
          expect(refused.status,refused.body.error?.code).toBe(403)
          expect(refused.body.error.code).toBe('ATTENDANCE_TIMEZONE_FORBIDDEN')
          expect(await snapshot()).toEqual(before)
        }finally{
          await blocker.query('ROLLBACK')
          blocker.release()
          if(pending)await pending
        }
      }
    }finally{await new Promise<void>((resolve,reject)=>source.close(error=>error?reject(error):resolve()))}
  },60000)
  it('database guards retain immutable trip history and reject direct authority rewrites',async()=>{
    const before=(await f.pool.query('SELECT count(*)::int AS count FROM attendance_business_trip_requests WHERE org_id=$1',[f.orgId])).rows
    const statements=[
      ["UPDATE attendance_requests SET request_type='time_correction' WHERE id=$1",[approvedId]],
      ["UPDATE attendance_requests SET requested_in_at=requested_in_at + interval '1 minute' WHERE id=$1",[approvedId]],
      ["UPDATE attendance_requests SET work_date=work_date + 1 WHERE id=$1",[approvedId]],
      ['DELETE FROM attendance_business_trip_requests WHERE request_id=$1',[approvedId]],
      ['DELETE FROM attendance_business_trip_arrangements WHERE request_id=$1',[approvedId]],
      ["UPDATE attendance_business_trip_arrangements SET destination_timezone='UTC' WHERE request_id=$1",[approvedId]],
      ['TRUNCATE attendance_business_trip_arrangements',[]],
      ['TRUNCATE attendance_business_trip_requests CASCADE',[]],
    ] as Array<[string,string[]]>
    for(const [sql,args] of statements){
      const client=await f.pool.connect()
      try{
        await client.query('BEGIN')
        await expect(client.query(sql,args)).rejects.toMatchObject({code:'23514'})
      }finally{await client.query('ROLLBACK');client.release()}
    }
    expect((await f.pool.query('SELECT count(*)::int AS count FROM attendance_business_trip_requests WHERE org_id=$1',[f.orgId])).rows).toEqual(before)
  })

  it('the actual migration down refuses retained request/arrangement history',async()=>{
    // This wrapper borrows the fixture pool; the fixture alone owns its lifecycle.
    const db=new Kysely<unknown>({dialect:new PostgresDialect({pool:f.pool})})
    await expect(db.transaction().execute(trx=>rollbackTripMigration(trx))).rejects.toThrow('ATTENDANCE_TRIP_ROLLBACK_BLOCKED')
    expect((await f.pool.query("SELECT to_regclass('attendance_business_trip_arrangements') IS NOT NULL AS retained")).rows).toEqual([{retained:true}])
  })

})


describe('settings native persisted authorization (real HTTP/PostgreSQL)', () => {
  const live = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
  let owner: Awaited<ReturnType<typeof live.user>>
  const send = (token?: string) => live.request('/api/attendance/settings', token,
    { workDateAttribution: { postShiftTailMinutes: 31 } }, 'PUT')
  async function state() {
    const durable: Record<string,unknown> = {}
    for (const table of ['attendance_events','attendance_records','attendance_requests',
      'attendance_result_operations','attendance_result_event_outbox','attendance_record_calculations',
      'attendance_timezone_context_companions','attendance_timezone_policy_audit']) {
      const row = table === 'attendance_result_event_outbox'
        ? "to_jsonb(t) - ARRAY['delivery_state','attempts','next_attempt_at','delivered_at']::text[]" : 'to_jsonb(t)'
      durable[table] = (await live.pool.query(`SELECT coalesce(jsonb_agg(v ORDER BY v::text),'[]'::jsonb) AS value
        FROM (SELECT ${row} AS v FROM ${table} t WHERE org_id=$1) scoped`, [live.orgId])).rows[0].value
    }
    return { settings: (await live.pool.query("SELECT * FROM system_configs WHERE key='attendance.settings'")).rows, durable }
  }
  beforeAll(async () => {
    punchClock.setOnlinePunchInstantForTests('2029-04-10T20:00:00.000Z')
    owner = await live.start()
    const saved = await live.configure(owner.token, { workDateAttribution: { postShiftTailMinutes: 17 } })
    expect(saved.body.data.workDateAttribution).toEqual({ postShiftTailMinutes: 17 })
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
  }, 180_000)
  afterAll(async () => { await live.stop() }, 60_000)

  it.each(['anonymous','reader','forged-claims'] as const)('SETTINGS_AUTH_REFUSAL %s leaves settings, cache and durable business rows unchanged', async mode => {
    let token: string | undefined
    if (mode !== 'anonymous') {
      const actor = await live.user(false)
      token = actor.token
      if (mode === 'forged-claims') {
        const minted = await live.request('/api/auth/dev-token?userId=' + actor.userId + '&tenantId=' + live.orgId
          + '&roles=admin&perms=attendance:read,attendance:write,attendance:admin', undefined, undefined, 'GET')
        expect(minted.status).toBe(200)
        expect(typeof minted.body.token).toBe('string')
        token = minted.body.token
        const claims = JSON.parse(Buffer.from(token!.split('.')[1], 'base64url').toString())
        expect(claims.roles).toContain('admin')
      }
      // Prepare the ordinary first-authentication self-service admission before
      // the exact refusal snapshot; token claims still confer no admin DB grant.
      expect((await live.request('/api/attendance/records?from=2029-04-10&to=2029-04-10', token, undefined, 'GET')).status).toBe(200)
      expect((await live.pool.query("SELECT count(*)::int AS count FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:admin'",
        [actor.userId])).rows).toEqual([{ count: 0 }])
      expect((await live.pool.query("SELECT count(*)::int AS count FROM user_roles WHERE user_id=$1 AND role_id='admin'",
        [actor.userId])).rows).toEqual([{ count: 0 }])
    }
    const before = await state()
    const refused = await send(token)
    expect({ status: refused.status, body: refused.body }).toEqual(mode === 'anonymous'
      ? { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } } }
      : { status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } } })
    expect(await state(), 'SETTINGS_AUTH_REFUSAL_NATIVE_ZERO_DELTA').toEqual(before)
    const cached = await live.request('/api/attendance/settings', owner.token, undefined, 'GET')
    expect(cached.status).toBe(200)
    expect(cached.body.data.workDateAttribution).toEqual({ postShiftTailMinutes: 17 })
  })

  it('SETTINGS_PERMISSION_REVOKED checks persisted admin permission after the real prefix wait while membership stays active', async () => {
    const actor = await live.user(false)
    await live.pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES($1,'attendance:admin')", [actor.userId])
    expect((await live.configure(actor.token, { workDateAttribution: { postShiftTailMinutes: 17 } })).status).toBe(200)
    const before = await state()
    const blocker = await live.pool.connect()
    let pending: ReturnType<typeof send> | undefined
    let completed: Awaited<ReturnType<typeof send>> | undefined
    try {
      await blocker.query('BEGIN')
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['attendance-timezone-policy-v1',live.orgId])])
      pending = send(actor.token).then(response => { completed = response; return response })
      let waiting = false
      for (let attempt = 0; attempt < 250; attempt++) {
        const locks = await live.pool.query(`SELECT 1 FROM pg_locks held JOIN pg_locks waiting
          ON held.locktype=waiting.locktype AND held.database=waiting.database
          AND held.classid=waiting.classid AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
          WHERE held.pid=$1 AND held.locktype='advisory' AND held.granted=true AND waiting.granted=false`, [pid])
        if (locks.rowCount) { waiting = true; break }
        if (completed) break
        await new Promise(resolve => setTimeout(resolve,20))
      }
      expect(waiting, 'SETTINGS_PERMISSION_REAL_PREFIX_WAIT').toBe(true)
      await blocker.query("DELETE FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:admin'", [actor.userId])
      await blocker.query('COMMIT')
      const refused = await pending
      expect({ status: refused.status, body: refused.body }, 'SETTINGS_PERMISSION_FRESH_REFUSAL').toEqual({
        status: 403, body: { ok: false, error: { code: 'ATTENDANCE_TIMEZONE_FORBIDDEN', message: 'ATTENDANCE_TIMEZONE_FORBIDDEN' } },
      })
      expect((await live.pool.query('SELECT is_active FROM user_orgs WHERE user_id=$1 AND org_id=$2',
        [actor.userId,live.orgId])).rows).toEqual([{ is_active: true }])
      expect((await live.pool.query("SELECT count(*)::int AS count FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:admin'",
        [actor.userId])).rows).toEqual([{ count: 0 }])
      expect(await state(), 'SETTINGS_PERMISSION_REVOKED_NATIVE_ZERO_DELTA').toEqual(before)
      expect((await live.request('/api/attendance/settings', owner.token, undefined, 'GET')).body.data.workDateAttribution)
        .toEqual({ postShiftTailMinutes: 17 })
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      if (pending) await pending
    }
    await live.pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES($1,'attendance:admin')", [actor.userId])
    const restored = await send(actor.token)
    expect(restored.status, restored.body.error?.code).toBe(200)
    expect(restored.body.data.workDateAttribution).toEqual({ postShiftTailMinutes: 31 })
  }, 60_000)
})
