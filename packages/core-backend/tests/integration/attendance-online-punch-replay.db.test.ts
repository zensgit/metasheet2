import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { createAuthorizedAttendanceWriteContextV1 } from '../../src/attendance/w4c0-authorization'
import { readOnlinePunchReplayV1, runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'
import { buildOnlinePunchRequestV1, ONLINE_PUNCH_SOURCE_REF } from '../../src/attendance/online-punch-request'
import * as liveModule from '../../src/attendance/w4c2-live-scheduled-boundary'
import * as requestModule from '../../src/attendance/w4c3b-request-operation-boundary'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

const fixture = createOnlinePunchDbFixture()
const instant = '2026-08-19T23:59:30.000Z'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
type FailureHook = (sql: string, params: unknown[], error: unknown) => void
type Hook = (sql: string, params: unknown[], client: PoolClient) => Promise<void>
describe('online common receipt replay and real two-connection races', () => {
  let admin: Awaited<ReturnType<typeof fixture.user>>
  let adapters: Parameters<typeof liveModule.createAttendanceLiveScheduledBoundaryV1>[0]['legacyAdapters']
  let requestAdapters: Parameters<typeof requestModule.createAttendanceRequestOperationBoundaryV1>[0]['adapters']
  const liveOriginal = liveModule.createAttendanceLiveScheduledBoundaryV1
  let httpReceiptProbes=0
  const requestOriginal = requestModule.createAttendanceRequestOperationBoundaryV1
  beforeAll(async () => {
    const liveSpy = vi.spyOn(liveModule, 'createAttendanceLiveScheduledBoundaryV1').mockImplementation(config => {
      adapters = config.legacyAdapters
      const b=liveOriginal(config)
      return {...b,probeOnlinePunchReplay: input=>{httpReceiptProbes++;return b.probeOnlinePunchReplay(input)}}
    })
    const requestSpy = vi.spyOn(requestModule, 'createAttendanceRequestOperationBoundaryV1').mockImplementation(config => {
      requestAdapters = config.adapters; return requestOriginal(config)
    })
    try { admin = await fixture.start() } finally { liveSpy.mockRestore(); requestSpy.mockRestore() }
    expect(adapters).toBeDefined(); expect(requestAdapters).toBeDefined()
    await fixture.configure(admin.token, { minPunchIntervalMinutes: 0 })
    const flow = await fixture.request('/api/attendance/approval-flows', admin.token, { orgId: fixture.orgId, name: 'online fixture', requestType: 'outdoor_punch', isActive: true, steps: [] })
    expect(flow.status).toBe(201)
    const rule = await fixture.request('/api/attendance/leave-types',admin.token,{orgId:fixture.orgId,name:'online leave',code:'online-clock-leave',unit:'hour',isActive:true,minMinutes:1,defaultMinutesPerDay:60,requiresApproval:false})
    expect(rule.status).toBe(201)
  }, 180_000)
  afterAll(async () => { await fixture.stop() }, 60_000)

  function connection(after?: Hook, before?: Hook, onFailure?: FailureHook) {
    return async () => {
      const client = await fixture.pool.connect()
      const wrapped: AttendanceW4TransactionClientV1 = { query: async (sql, params = []) => {
        await before?.(sql, params, client)
        let result
        try { result = await client.query(sql, params) } catch (error) { onFailure?.(sql,params,error); throw error }
        await after?.(sql, params, client)
        return { rows: result.rows }
      } }
      return { client: wrapped, release: (error?: Error) => client.release(error) }
    }
  }
  function boundary(after?: Hook, before?: Hook, onFailure?: FailureHook) {
    return liveOriginal({ acquireConnection: connection(after, before, onFailure), legacyAdapters: adapters })
  }
  function frames(actor: Awaited<ReturnType<typeof fixture.user>>, id: string, meta: Record<string, unknown> | null = null) {
    const online = { orgId: fixture.orgId, userId: actor.userId, tokenSubjectUserId: actor.userId, operationId: id,
      client: { eventType: 'check_in' as const, timezone: 'UTC', source: null, location: null, meta, photoFileId: null, requestNamedOrgId: fixture.orgId } }
    const normal: liveModule.AttendanceLivePunchBoundaryInputV1 = { orgId: fixture.orgId, userId: actor.userId, operationId: id,
      eventType: 'check_in', occurredAtRaw: null, occurredAtResolved: instant, timezone: 'UTC', requestTimezone: 'UTC',
      source: 'manual', location: null, meta, photoFileRef: null, workDate: '2026-08-19', shiftId: null,
      outerSourceDefinitionFingerprint: null, isWorkday: true, holidayKind: null }
    const outdoor: requestModule.AttendanceRequestOperationBoundaryInputV1 = { kind: 'request_create', operationId: id,
      correlationId: id, routeVariant: 'outdoor', routeInput: { orgId: fixture.orgId, actorId: actor.userId, tokenSubjectUserId: actor.userId,
        requesterName: 'online fixture', workDate: '2026-08-19', eventType: 'check_in', occurredAt: instant, timezone: 'UTC', source: 'mobile',
        location: null, note: '', photoFileId: null, outsideGeofence: false, requestNamedOrgId: fixture.orgId,
        outdoorPolicy: { requireApproval: true, requireNote: false, requirePhoto: false, approvalFlowId: '' } } }
    return { online, normal, outdoor }
  }
  async function rows(id: string) {
    return (await fixture.pool.query(`SELECT entrypoint,state,source_ref,response_snapshot,normalized_business_input_snapshot
      FROM attendance_result_operations WHERE org_id=$1 AND operation_id=$2 ORDER BY entrypoint`, [fixture.orgId,id])).rows
  }
  async function receiptClone(orgId: string, templateId: string, targetId: string) {
    // Fetch BEFORE the loser transaction. The later winner deliberately uses blind VALUES:
    // two canonical writers' predicate reads may produce 40001 instead of 23505 under SSI.
    const row=(await fixture.pool.query('SELECT * FROM attendance_result_operations WHERE org_id=$1 AND operation_id=$2',[orgId,templateId])).rows[0]
    if(!row || row.state!=='completed')throw new Error('ONLINE_SEALED_RECEIPT_BLUEPRINT_REQUIRED')
    const columns=Object.keys(row)
    if(columns.some(name=>! /^[a-z_]+$/.test(name)))throw new Error('ONLINE_RECEIPT_COLUMN_INVALID')
    const values=columns.map(name=>name==='operation_id'?targetId:row[name])
    return async()=>{
      const winner=await fixture.pool.connect()
      try { await winner.query(`INSERT INTO attendance_result_operations (${columns.map(name=>`"${name}"`).join(',')}) VALUES (${values.map((_,i)=>'$'+(i+1)).join(',')})`,values) }
      finally { winner.release() }
    }
  }
  async function forceStaleSnapshot<T>(runLoser: (after: Hook) => Promise<T>, commitWinner: () => Promise<unknown>) {
    const snapshot = deferred(); const resume = deferred(); let paused = false
    const observed: { snapshots: number; pids: Set<number> } = { snapshots: 0, pids: new Set() }
    const after: Hook = async (sql, _params, client) => {
      if (sql.includes("set_config('statement_timeout'")) {
        observed.snapshots++; observed.pids.add(client.processID)
        if (!paused) { paused = true; snapshot.resolve(); await resume.promise }
      }
    }
    const loser = runLoser(after)
    await snapshot.promise
    try { await commitWinner() } finally { resume.resolve() }
    return { result: await loser, observed }
  }

  it('HTTP replay preserves first status/body/server time through midnight and min-interval policy changes', async () => {
    const actor = await fixture.user(); const id = randomUUID()
    const body = { orgId: fixture.orgId, operationId: id, eventType: 'check_in', timezone: 'UTC' }
    punchClock.setOnlinePunchInstantForTests(instant)
    const first = await fixture.request('/api/attendance/punch', actor.token, body)
    expect(first.status).toBe(200)
    await fixture.configure(admin.token, { minPunchIntervalMinutes: 1440 })
    punchClock.setOnlinePunchInstantForTests('2026-08-20T00:00:01.000Z')
    expect(await fixture.request('/api/attendance/punch', actor.token, body)).toEqual(first)
    const changed = await fixture.request('/api/attendance/punch', actor.token, { ...body, meta: { changed: true } })
    expect(changed.status).toBe(409); expect(changed.body.error.code).toBe('ATTENDANCE_OPERATION_CONFLICT')
    expect(await fixture.counts(actor.userId)).toEqual({ events: 1, records: 1, requests: 0, operations: 1 })
    await fixture.configure(admin.token, { minPunchIntervalMinutes: 0 })
  })
  it.each([['normal','normal'],['outdoor','outdoor'],['normal','outdoor'],['outdoor','normal']] as const)('two physical connections racing %s/%s create one precise common receipt', async (kind, other) => {
    const actor = await fixture.user(); const id = randomUUID(); const f = frames(actor,id)
    const started = deferred(); const resume = deferred(); const pids = new Set<number>(); let acquired = 0
    const operationKeys: bigint[]=[]
    const winner = boundary(async (sql,params,client) => {
      if(sql==='SELECT pg_advisory_xact_lock($1::bigint)') {
        const key=BigInt(String(params[0]))
        if(key>=-(1n<<63n)&&key<-(1n<<62n))operationKeys.push(key)
      }
      if (sql.includes('INSERT INTO attendance_result_operations') && params[1] === 'live_punch') {
        pids.add(client.processID); acquired++; started.resolve(); await resume.promise
      }
    })
    const loser = boundary(async (_sql,_params,client) => { pids.add(client.processID) })
    const input: liveModule.OnlinePunchPreparedV1 = kind === 'normal' ? { kind, input: f.normal } : { kind, input: f.outdoor }
    const first = winner.executeOnlinePunch(f.online,input)
    await started.promise
    const second = loser.executeOnlinePunch(f.online,other==='normal'?{kind:other,input:f.normal}:{kind:other,input:f.outdoor})
    // Observe the actual waiting backend before releasing the winner, without a sleep-shaped assertion.
    for (let attempt=0; attempt<200; attempt++) {
      const waiting = await fixture.pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")
      if (waiting.rows[0].n > 0) break
      if (attempt===199) throw new Error('ONLINE_RACE_WAITER_NOT_OBSERVED')
    }
    resume.resolve()
    const [a,b] = await Promise.all([first,second])
    expect(pids.size).toBeGreaterThanOrEqual(2); expect(acquired).toBe(1)
    expect(operationKeys.length).toBeGreaterThanOrEqual(2)
    expect(operationKeys[0]!<operationKeys[1]!).toBe(true)
    expect(b.receipt).toEqual(a.receipt); expect(a.receipt.status).toBe(kind==='normal'?200:202)
    expect(await fixture.counts(actor.userId)).toEqual(kind==='normal' ? { events:1,records:1,requests:0,operations:1 } : { events:0,records:0,requests:1,operations:2 })
    expect((await rows(id)).every(row=>row.state==='completed')).toBe(true)
  })
  it.each(['normal', 'outdoor'] as const)('new %s winner versus the other branch replays one shared receipt', async kind => {
    const actor = await fixture.user(); const f = frames(actor,randomUUID(),{ outdoor:true })
    const writer=boundary()
    const a=await writer.executeOnlinePunch(f.online,kind==='normal'?{kind,input:f.normal}:{kind,input:f.outdoor})
    const b=await writer.executeOnlinePunch(f.online,kind==='normal'?{kind:'outdoor',input:f.outdoor}:{kind:'normal',input:f.normal})
    expect(b.kind).toBe('replay'); expect(b.receipt).toEqual(a.receipt)
    expect(await fixture.counts(actor.userId)).toEqual(kind==='normal' ? { events:1,records:1,requests:0,operations:1 } : { events:0,records:0,requests:1,operations:2 })
  })
  it('snapshot established before another commit receives an exact-PK fresh-transaction retry, then exact replay', async () => {
    const actor=await fixture.user();const f=frames(actor,randomUUID());const winner=boundary();let exactPk=0;const failures:unknown[]=[]
    const template=frames(actor,randomUUID())
    const first=await winner.executeOnlinePunch(template.online,{kind:'normal',input:template.normal})
    const commitReceipt=await receiptClone(fixture.orgId,template.online.operationId,f.online.operationId)
    const stale=await forceStaleSnapshot(after=> {
      const b=boundary(after,undefined,(sql,params,error)=>{
        const pg=error as {code?:string;constraint?:string}
        failures.push({code:pg.code,constraint:pg.constraint,entrypoint:params[1]})
        if(sql.includes('INSERT INTO attendance_result_operations') && params[1]==='live_punch' && pg.code==='23505' && pg.constraint==='pk_attendance_result_operations') exactPk++
      })
      return b.executeOnlinePunch(f.online,{kind:'normal',input:f.normal})
    },commitReceipt)
    // The fresh snapshot is counted from real set_config queries, not a mocked 23505.
    expect(exactPk,JSON.stringify(failures)).toBe(1)
    expect(stale.observed.snapshots).toBe(2)
    expect(stale.result.kind).toBe('replay')
    expect(stale.result.receipt).toEqual(first.receipt)
    expect(await fixture.counts(actor.userId)).toEqual({events:1,records:1,requests:0,operations:2})
  })
  it('a winner that throws after the claim rolls back before its waiter commits exactly once', async () => {
    const actor=await fixture.user();const f=frames(actor,randomUUID());const claimed=deferred();const resume=deferred()
    const failure=new Error('OWNED_TEST_ROLLBACK')
    const winner=boundary(async(sql)=>{if(sql.includes('INSERT INTO attendance_result_operations')){claimed.resolve();await resume.promise;throw failure}})
    const first=winner.executeOnlinePunch(f.online,{kind:'normal',input:f.normal})
    const caught=first.catch(e=>e)
    await claimed.promise
    const loserSnapshot=deferred()
    const second=boundary(async(sql)=>{if(sql.includes("set_config('statement_timeout'"))loserSnapshot.resolve()}).executeOnlinePunch(f.online,{kind:'normal',input:f.normal})
    await loserSnapshot.promise
    resume.resolve();expect(await caught).toBe(failure)
    expect((await second).receipt.status).toBe(200)
    expect(await fixture.counts(actor.userId)).toEqual({events:1,records:1,requests:0,operations:1})
  })
  it('an exact owned PK collision with failed rollback discards its connection and never starts another transaction', async () => {
    const actor=await fixture.user();const f=frames(actor,randomUUID());const template=frames(actor,randomUUID())
    await boundary().executeOnlinePunch(template.online,{kind:'normal',input:template.normal})
    const commitReceipt=await receiptClone(fixture.orgId,template.online.operationId,f.online.operationId)
    let acquisitions=0;let begins=0;let rollbacks=0;let exactPk=0;let backendPid=0
    const releases:(Error|undefined)[]=[]
    const rollbackFailure=new Error('OWNED_TEST_ROLLBACK_TRANSPORT_FAILURE')
    await expect(forceStaleSnapshot(after=> {
      const acquire=connection(async(sql,params,client)=>{
        backendPid=client.processID
        if(sql==='BEGIN ISOLATION LEVEL SERIALIZABLE') begins++
        await after(sql,params,client)
      },async sql=>{
        if(sql==='ROLLBACK'){rollbacks++;throw rollbackFailure}
      },(sql,params,error)=>{
        const pg=error as {code?:string;constraint?:string}
        if(sql.includes('INSERT INTO attendance_result_operations')&&params[1]==='live_punch'&&pg.code==='23505'&&pg.constraint==='pk_attendance_result_operations')exactPk++
      })
      const writer=liveOriginal({legacyAdapters:adapters,acquireConnection:async()=>{
        acquisitions++;const lease=await acquire()
        return {...lease,release:(error?:Error)=>{releases.push(error);lease.release(error)}}
      }})
      return writer.executeOnlinePunch(f.online,{kind:'normal',input:f.normal})
    },commitReceipt)).rejects.toMatchObject({name:'OnlinePunchConnectionUncertainError',httpStatus:503})
    expect(exactPk).toBe(1);expect(acquisitions).toBe(1);expect(begins).toBe(1);expect(rollbacks).toBe(1)
    expect(releases).toHaveLength(1);expect(releases[0]).toMatchObject({name:'OnlinePunchConnectionUncertainError'})
    const replacement=await fixture.pool.connect()
    try {expect(replacement.processID).not.toBe(backendPid)} finally {replacement.release()}
    expect(await rows(f.online.operationId)).toHaveLength(1)
  })
  it('mutable refusal fence returns a committed winner; a fresh refusal rolls its common claim back', async () => {
    const actor=await fixture.user();const f=frames(actor,randomUUID());const writer=boundary();const refusal=new Error('OWNED_POLICY_REFUSAL')
    const a=await writer.executeOnlinePunch(f.online,{kind:'normal',input:f.normal})
    const b=await writer.executeOnlinePunch(f.online,{kind:'refusal',error:refusal})
    expect(b.receipt).toEqual(a.receipt)
    const g=frames(await fixture.user(),randomUUID())
    await expect(writer.executeOnlinePunch(g.online,{kind:'refusal',error:refusal})).rejects.toBe(refusal)
    expect(await rows(g.online.operationId)).toEqual([])
  })
  it.each(['membership','activation'] as const)('revocation committed after mint before fresh transaction snapshot refuses completed %s replay', async field => {
    const actor=await fixture.user();const f=frames(actor,randomUUID());const writer=boundary()
    await writer.executeOnlinePunch(f.online,{kind:'normal',input:f.normal})
    const request=buildOnlinePunchRequestV1(f.online)
    const auth=createAuthorizedAttendanceWriteContextV1({actorId:actor.userId,actorPosture:'self',tokenSubjectUserId:actor.userId,orgId:fixture.orgId,subjectScope:{kind:'self',userId:actor.userId},capability:'punch',sourceRef:ONLINE_PUNCH_SOURCE_REF})
    if(field==='membership') await fixture.pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2',[actor.userId,fixture.orgId])
    else await fixture.pool.query('UPDATE users SET is_active=false WHERE id=$1',[actor.userId])
    const conn=await fixture.pool.connect()
    try { await expect(runAttendanceResultOperationTransactionV1(conn,trx=>readOnlinePunchReplayV1(trx,auth,request))).rejects.toMatchObject({code:'ATTENDANCE_WRITE_NOT_AUTHORIZED'}) }
    finally { conn.release() }
    expect(await fixture.counts(actor.userId)).toEqual({events:1,records:1,requests:0,operations:1})
  })
  it('old live and old outdoor domain receipts fail closed instead of being reinterpreted', async () => {
    const actor=await fixture.user();const f=frames(actor,randomUUID());const writer=boundary()
    await writer.executeLivePunch({...f.normal,occurredAtRaw:instant})
    await expect(writer.probeOnlinePunchReplay(f.online)).rejects.toMatchObject({code:'ATTENDANCE_OPERATION_CONFLICT'})
    const b=await fixture.user();const g=frames(b,randomUUID())
    const old=requestOriginal({acquireConnection:connection(),adapters:requestAdapters})
    await old.execute(g.outdoor)
    await expect(writer.probeOnlinePunchReplay(g.online)).rejects.toMatchObject({code:'ATTENDANCE_OPERATION_CONFLICT'})
    expect((await rows(g.online.operationId)).map(x=>x.entrypoint)).toEqual(['request_create'])
  })
  it('generic request UUID stays independent from normal punch but conflicts with outdoor inner row', async () => {
    const actor=await fixture.user();const f=frames(actor,randomUUID())
    const generic:requestModule.AttendanceRequestOperationBoundaryInputV1={kind:'request_create',operationId:f.online.operationId,correlationId:f.online.operationId,routeVariant:'generic',routeInput:{orgId:fixture.orgId,actorId:actor.userId,tokenSubjectUserId:actor.userId,requesterName:'online fixture',requestId:null,requestNamedOrgId:fixture.orgId,requestBody:{requestType:'leave',leaveTypeCode:'online-clock-leave',minutes:60,workDate:'2026-08-19',startTime:'18:00',endTime:'19:00',reason:'fixture'}}}
    const requestWriter=requestOriginal({acquireConnection:connection(),adapters:requestAdapters})
    const created=await requestWriter.execute(generic);expect(created.response).toBeDefined()
    const normal=await boundary().executeOnlinePunch(f.online,{kind:'normal',input:f.normal});expect(normal.receipt.status).toBe(200)
    expect((await rows(f.online.operationId)).map(x=>x.entrypoint)).toEqual(['live_punch','request_create'])
    const other=await fixture.user();const g=frames(other,randomUUID());const genericOther={...generic,operationId:g.online.operationId,routeInput:{...generic.routeInput as Record<string,unknown>,actorId:other.userId,tokenSubjectUserId:other.userId}}
    await requestWriter.execute(genericOther)
    await expect(boundary().executeOnlinePunch(g.online,{kind:'outdoor',input:g.outdoor})).rejects.toMatchObject({code:'ATTENDANCE_OPERATION_CONFLICT'})
    expect((await rows(g.online.operationId)).map(x=>x.entrypoint)).toEqual(['request_create'])
  })
  it('an adapter nonclaim error with the same PK metadata is not upgraded or retried', async () => {
    const actor=await fixture.user(); const f=frames(actor,randomUUID())
    const error={code:'23505',constraint:'pk_attendance_result_operations',table:'attendance_result_operations'}
    let calls=0; let claims=0
    const writer=liveOriginal({acquireConnection:connection(async(sql,params)=>{
      if(sql.includes('INSERT INTO attendance_result_operations') && params[1]==='live_punch') claims++
    }),legacyAdapters:{...adapters,executeOnlineOutdoorInTransaction:async()=>{calls++;throw error}}})
    await expect(writer.executeOnlinePunch(f.online,{kind:'outdoor',input:f.outdoor})).rejects.toBe(error)
    expect(calls).toBe(1); expect(claims).toBe(1); expect(await rows(f.online.operationId)).toEqual([])
  })

  it('write permission revoked while read remains effective is checked by HTTP before receipt access and zero DML', async () => {
    const actor=await fixture.user(false)
    await fixture.pool.query("INSERT INTO user_permissions (user_id,permission_code) VALUES ($1,'attendance:write')",[actor.userId])
    punchClock.setOnlinePunchInstantForTests(instant)
    const body={orgId:fixture.orgId,eventType:'check_in',timezone:'UTC',operationId:randomUUID()}
    const first=await fixture.request('/api/attendance/punch',actor.token,body)
    expect(first.status).toBe(200)
    const read=await fixture.request('/api/attendance/rules/me',actor.token,undefined,'GET')
    expect(read.status).toBe(200)
    await fixture.pool.query("DELETE FROM user_permissions WHERE user_id=$1 AND permission_code='attendance:write'",[actor.userId])
    const before=await fixture.counts(actor.userId);const probes=httpReceiptProbes
    const denied=await fixture.request('/api/attendance/punch',actor.token,body)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ok:false,error:{code:'FORBIDDEN',message:'Insufficient permissions'}})
    expect(httpReceiptProbes).toBe(probes)
    expect(await fixture.counts(actor.userId)).toEqual(before)
  })

  it('generic commit after the outdoor snapshot hits only its exact inner claim PK, then a fresh attempt refuses with no common residue', async () => {
    const actor=await fixture.user();const f=frames(actor,randomUUID())
    const generic:requestModule.AttendanceRequestOperationBoundaryInputV1={kind:'request_create',operationId:f.online.operationId,correlationId:f.online.operationId,routeVariant:'generic',routeInput:{orgId:fixture.orgId,actorId:actor.userId,tokenSubjectUserId:actor.userId,requesterName:'online fixture',requestId:null,requestNamedOrgId:fixture.orgId,requestBody:{requestType:'leave',leaveTypeCode:'online-clock-leave',minutes:60,workDate:'2026-08-19',reason:'fixture'}}}
    let innerPk=0;let snapshots=0
    const requestWriter=requestOriginal({acquireConnection:connection(),adapters:requestAdapters})
    const templateId=randomUUID()
    await requestWriter.execute({...generic,operationId:templateId,correlationId:templateId})
    const commitReceipt=await receiptClone(fixture.orgId,templateId,f.online.operationId)
    await expect(forceStaleSnapshot(after=>boundary(async(sql,params,client)=>{
      if(sql.includes("set_config('statement_timeout'"))snapshots++
      await after(sql,params,client)
    },undefined,(sql,params,error)=>{
      const pg=error as {code?:string;constraint?:string}
      if(sql.includes('INSERT INTO attendance_result_operations') && params[1]==='request_create' && pg.code==='23505' && pg.constraint==='pk_attendance_result_operations')innerPk++
    }).executeOnlinePunch(f.online,{kind:'outdoor',input:f.outdoor}),commitReceipt)).rejects.toMatchObject({code:'ATTENDANCE_OPERATION_CONFLICT'})
    expect(innerPk).toBe(1);expect(snapshots).toBe(2)
    expect((await rows(f.online.operationId)).map(x=>x.entrypoint)).toEqual(['request_create'])
    expect(await fixture.counts(actor.userId)).toEqual({events:0,records:0,requests:1,operations:2})
  })

})
