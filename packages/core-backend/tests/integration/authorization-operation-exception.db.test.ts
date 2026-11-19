import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
const url=process.env.PERMISSION_COMMAND_FENCE_DATABASE_URL
if(url) { const parsed=new URL(url); if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || parsed.pathname!=='/permission_command_fence_test') throw new Error('isolated migrated loopback fixture required') }
const suite=url ? describe : describe.skip
suite('permission exceptions through the fenced command',()=>{
  const actor=randomUUID(), raw=randomUUID(),target=randomUUID(),nonce=randomUUID().replaceAll('-','')
  const ns=`ex${nonce}`, code=`${ns}:read`, role=`${ns}_member`, path='/api/admin/authorization-operations'
  let db:Client,app:express.Express,token:string,rawToken:string,close:()=>Promise<void>
  const body={targetUserId:target,action:{kind:'direct.grant',code},admissionChanges:[],reason:'synthetic review'}
  const preview=(value:unknown=body,auth=token)=>request(app).post(`${path}/preview`).auth(auth,{type:'bearer'}).send(value)
  const commit=(value:Record<string,unknown>,version:string,id:string,auth=token)=>request(app).post(path).auth(auth,{type:'bearer'}).send({...value,expectedVersion:version,clientOperationId:id})
  beforeAll(async()=>{
    db=new Client({connectionString:url});await db.connect()
    await db.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'actor','synthetic','admin',true),($3,$4,'raw','synthetic','admin',true),($5,$6,'target','synthetic','user',false)",[actor,`${actor}@example.test`,raw,`${raw}@example.test`,target,`${target}@example.test`])
    await db.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin')",[actor]);await db.query('INSERT INTO permissions(code,name) VALUES ($1,$1)',[code]);await db.query('INSERT INTO roles(id,name) VALUES ($1,$1)',[role]);await db.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2)',[role,code])
    process.env.DATABASE_URL=url;process.env.JWT_SECRET='synthetic-test-secret-for-permission-command-only';process.env.PRODUCT_MODE='attendance';process.env.RBAC_TOKEN_TRUST='false';process.env.RBAC_BYPASS='false'
    const [{adminUsersRouter},{authService},{poolManager}]=await Promise.all([import('../../src/routes/admin-users'),import('../../src/auth/AuthService'),import('../../src/integration/db/connection-pool')])
    app=express();app.use(express.json());app.use(adminUsersRouter())
    const jwt=(id:string)=>authService.createToken({id,email:`${id}@example.test`,name:'synthetic',role:'user',permissions:[],created_at:new Date(),updated_at:new Date()})
    token=jwt(actor);rawToken=jwt(raw);close=()=>poolManager.close()
  })
  beforeEach(async()=>{
    await db.query('DELETE FROM authorization_operation_audit WHERE actor_id=ANY($1::text[])',[[actor,raw]])
    await db.query('DELETE FROM authorization_operation_receipts WHERE actor_id=ANY($1::text[])',[[actor,raw]])
    await db.query('DELETE FROM user_permissions WHERE user_id=$1',[target]);await db.query('DELETE FROM user_roles WHERE user_id=$1',[target]);await db.query('DELETE FROM user_namespace_admissions WHERE user_id=$1',[target]);await db.query("UPDATE users SET permissions='[]'::jsonb WHERE id=$1",[target])
  })
  afterAll(async()=>{
    if(close) await close()
    await db.query('DELETE FROM authorization_operation_audit WHERE actor_id=ANY($1::text[])',[[actor,raw]]);await db.query('DELETE FROM authorization_operation_receipts WHERE actor_id=ANY($1::text[])',[[actor,raw]])
    await db.query('DELETE FROM user_permissions WHERE user_id=$1',[target]);await db.query('DELETE FROM user_namespace_admissions WHERE user_id=$1',[target]);await db.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])',[[actor,raw,target]])
    await db.query('DELETE FROM role_permissions WHERE role_id=$1',[role]);await db.query('DELETE FROM roles WHERE id=$1',[role]);await db.query('DELETE FROM permissions WHERE code=$1',[code]);await db.query('DELETE FROM users WHERE id=ANY($1::text[])',[[actor,raw,target]]);await db.end()
  })
  it('requires live RBAC admin before disclosing target existence',async()=>{
    const a=await preview(body,rawToken),b=await preview({...body,targetUserId:randomUUID()},rawToken)
    expect(a.status).toBe(403);expect(b.status).toBe(403);expect(a.body).toEqual(b.body)
  })
  it('grants and revokes direct source while retaining role and legacy sources',async()=>{
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[target,role]);await db.query('UPDATE users SET permissions=$2::jsonb WHERE id=$1',[target,JSON.stringify([code])])
    const p=await preview();expect(p.status,JSON.stringify(p.body)).toBe(200)
    expect(p.body.impact.sourceChanges).toEqual([{source:'direct',id:code,operation:'assign',changed:true}])
    const done=await commit(body,p.body.expectedVersion,randomUUID());expect(done.status,JSON.stringify(done.body)).toBe(200)
    const revoke={targetUserId:target,action:{kind:'direct.revoke',code},admissionChanges:[]}
    const q=await preview(revoke);expect(q.status).toBe(200)
    expect(q.body.impact.retainedOtherGrants[0].sources.map((s:{kind:string})=>s.kind).sort()).toEqual(['legacy','role'])
    const removed=await commit(revoke,q.body.expectedVersion,randomUUID());expect(removed.status,JSON.stringify(removed.body)).toBe(200)
    expect((await db.query('SELECT count(*)::int n FROM user_permissions WHERE user_id=$1',[target])).rows[0].n).toBe(0)
  })
  it('revokes legacy source only and preserves direct and role grants',async()=>{
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[target,role]);await db.query('INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,$2)',[target,code]);await db.query('UPDATE users SET permissions=$2::jsonb WHERE id=$1',[target,JSON.stringify([code,` ${code} `,'other'])])
    const input={targetUserId:target,action:{kind:'legacy.revoke',code},admissionChanges:[]}
    const p=await preview(input);expect(p.status).toBe(200);expect(p.body.impact.sourceChanges[0]).toMatchObject({source:'legacy',changed:true})
    expect((await commit(input,p.body.expectedVersion,randomUUID())).status).toBe(200)
    expect((await db.query('SELECT permissions FROM users WHERE id=$1',[target])).rows[0].permissions).toEqual(['other'])
    expect((await db.query('SELECT count(*)::int n FROM user_permissions WHERE user_id=$1',[target])).rows[0].n).toBe(1)
  })
  it('rejects self-widening and unknown permission catalog entries',async()=>{
    expect((await preview({...body,targetUserId:actor})).body.error.code).toBe('SELF_WIDENING_FORBIDDEN')
    const unknown=await preview({...body,action:{kind:'direct.grant',code:`${ns}:not_in_catalog`}})
    expect(unknown.status).toBe(400);expect(unknown.body.error.code).toBe('UNKNOWN_PERMISSION')
  })
  it('checks required reason in the parser and again at the service boundary',async()=>{
    const [{parseAuthorizationOperation},{previewAuthorizationOperation}]=await Promise.all([import('../../src/admin/authorization-operation-validation'),import('../../src/admin/authorization-operation-service')])
    const missing={...body,reason:undefined}
    expect(()=>parseAuthorizationOperation(missing,false)).toThrow()
    await expect(previewAuthorizationOperation(actor,missing)).rejects.toMatchObject({code:'REASON_REQUIRED'})
  })
  it('invalidates preview if the requested permission catalog row changes',async()=>{
    const p=await preview();expect(p.status).toBe(200)
    await db.query('UPDATE permissions SET name=name || $2 WHERE code=$1',[code,' changed'])
    const done=await commit(body,p.body.expectedVersion,randomUUID());expect(done.status).toBe(409);expect(done.body.error.code).toBe('STALE_PREVIEW')
  })
  it('requires reason for grant and template and rejects a stale template before any writes',async()=>{
    expect((await preview({...body,reason:undefined})).body.error.code).toBe('REASON_REQUIRED')
    const input={targetUserId:target,action:{kind:'template.apply',templateId:'attendance-employee'},admissionChanges:[],reason:'approved'}
    expect((await preview({...input,reason:undefined})).body.error.code).toBe('REASON_REQUIRED')
    const p=await preview(input);expect(p.status,JSON.stringify(p.body)).toBe(200)
    await db.query('INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,$2)',[target,code])
    const stale=await commit(input,p.body.expectedVersion,randomUUID());expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('STALE_PREVIEW')
    expect((await db.query('SELECT permission_code FROM user_permissions WHERE user_id=$1 ORDER BY permission_code',[target])).rows.map(row=>row.permission_code)).toEqual([code])
    const q=await preview(input);expect(q.status,JSON.stringify(q.body)).toBe(200)
    const done=await commit(input,q.body.expectedVersion,randomUUID());expect(done.status,JSON.stringify(done.body)).toBe(200)
    expect((await db.query('SELECT permission_code FROM user_permissions WHERE user_id=$1 ORDER BY permission_code',[target])).rows.map(row=>row.permission_code)).toEqual(['attendance:read','attendance:write',code].sort())
  })
  it('hides compatibility receipts and does not let a colliding key create a new receipt',async()=>{
    const id=randomUUID()
    await db.query("INSERT INTO authorization_operation_receipts(actor_id,client_operation_id,request_digest,expected_version,target_user_id,action,receipt) VALUES ($1,$2,'legacy','legacy',$3,'{}','{}')",[actor,id,target])
    const get=await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'});expect(get.status).toBe(200);expect(get.body.status).toBe('unknown_or_pending')
    const p=await preview();expect(p.status).toBe(200);const done=await commit(body,p.body.expectedVersion,id);expect(done.status).toBe(409)
    expect((await db.query('SELECT count(*)::int n FROM user_permissions WHERE user_id=$1',[target])).rows[0].n).toBe(0)
  })
  ;(process.env.PERMISSION_COMMAND_TEST_FAULT==='legacy_corrupt' ? it : it.skip)('rejects a post-write legacy non-string mutation and rolls back',async()=>{
    await db.query('UPDATE users SET permissions=$2::jsonb WHERE id=$1',[target,JSON.stringify([code,'other'])])
    const input={targetUserId:target,action:{kind:'legacy.revoke',code},admissionChanges:[]}
    const p=await preview(input);expect(p.status).toBe(200)
    const done=await commit(input,p.body.expectedVersion,randomUUID());expect(done.status).toBe(409)
    expect((await db.query('SELECT permissions FROM users WHERE id=$1',[target])).rows[0].permissions).toEqual([code,'other'])
  })
  ;(process.env.PERMISSION_COMMAND_TEST_FAULT==='audit' ? it : it.skip)('rolls back a direct write and receipt after post-fence audit failure',async()=>{
    const p=await preview();expect(p.status).toBe(200);const id=randomUUID()
    const seen:Array<{client:unknown,sql:string}>=[], prototype=Client.prototype as unknown as {query:(...args:unknown[])=>unknown},original=prototype.query
    prototype.query=function(this:unknown,...args:unknown[]) {const sql=typeof args[0]==='string'?args[0]:(args[0] as {text?:unknown}|undefined)?.text;if(typeof sql==='string')seen.push({client:this,sql});return original.apply(this,args)}
    let done:{status:number}
    try {done=await commit(body,p.body.expectedVersion,id)} finally {prototype.query=original}
    const index=seen.findIndex(row=>row.sql==='SELECT 1/0');expect(index).toBeGreaterThan(0)
    const prior=seen.slice(0,index).filter(row=>row.client===seen[index].client).map(row=>row.sql).join('\n')
    expect(prior).toMatch(/LOCK TABLE[\s\S]*EXCLUSIVE MODE NOWAIT/i);expect(prior).toMatch(/INSERT INTO user_permissions/i);expect(prior).toMatch(/INSERT INTO authorization_operation_receipts/i)
    expect(process.env.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED).toBe('false')
    expect(done.status).toBeGreaterThanOrEqual(500)
    expect((await db.query('SELECT count(*)::int n FROM user_permissions WHERE user_id=$1',[target])).rows[0].n).toBe(0)
    expect((await db.query('SELECT count(*)::int n FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])).rows[0].n).toBe(0)
  })
})
