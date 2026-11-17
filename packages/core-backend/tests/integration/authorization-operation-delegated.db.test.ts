import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url=process.env.PERMISSION_COMMAND_FENCE_DATABASE_URL
if(url) { const parsed=new URL(url); if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || parsed.pathname!=='/permission_command_fence_test') throw new Error('isolated migrated loopback fixture required') }
const suite=url ? describe : describe.skip
suite('delegated authorization operation on migrated schema and real fence',()=>{
  const actor=randomUUID(),target=randomUUID(),nonce=randomUUID().replaceAll('-','')
  const alpha=`da${nonce}`,beta=`db${nonce}`, other=`dx${nonce}`, role=`${alpha}_member`, actorAlpha=`${alpha}_admin`,actorBeta=`${beta}_admin`,otherRole=`${other}_member`
  const path='/api/admin/authorization-operations'
  let db:Client,app:express.Express,token:string,groupA:string,groupB:string,close:()=>Promise<void>
  const input={targetUserId:target,action:{kind:'role.assign',roleId:role},admissionChanges:[{namespace:alpha,enabled:true}]}
  const preview=(body:unknown=input)=>request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(body)
  const commit=(body:Record<string,unknown>,version:string,id:string)=>request(app).post(path).auth(token,{type:'bearer'}).send({...body,expectedVersion:version,clientOperationId:id})
  beforeAll(async()=>{
    db=new Client({connectionString:url});await db.connect()
    await db.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'delegate','synthetic','user',false),($3,$4,'target','synthetic','user',false)",[actor,`${actor}@example.test`,target,`${target}@example.test`])
    for(const id of [role,actorAlpha,actorBeta,otherRole]) await db.query('INSERT INTO roles(id,name) VALUES ($1,$1)',[id])
    for(const code of [`${alpha}:read`,`${beta}:read`,`${other}:read`]) await db.query('INSERT INTO permissions(code,name) VALUES ($1,$1)',[code])
    await db.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2),($3,$4)',[role,`${alpha}:read`,otherRole,`${other}:read`])
    groupA=(await db.query('INSERT INTO platform_member_groups(name) VALUES ($1) RETURNING id',[`${alpha} group`])).rows[0].id
    groupB=(await db.query('INSERT INTO platform_member_groups(name) VALUES ($1) RETURNING id',[`${beta} group`])).rows[0].id
    process.env.DATABASE_URL=url;process.env.JWT_SECRET='synthetic-test-secret-for-permission-command-only';process.env.PRODUCT_MODE='attendance';process.env.RBAC_TOKEN_TRUST='false';process.env.RBAC_BYPASS='false'
    const [{adminUsersRouter},{authService},{poolManager}]=await Promise.all([import('../../src/routes/admin-users'),import('../../src/auth/AuthService'),import('../../src/integration/db/connection-pool')])
    app=express();app.use(express.json());app.use(adminUsersRouter())
    token=authService.createToken({id:actor,email:`${actor}@example.test`,name:'delegate',role:'user',permissions:[],created_at:new Date(),updated_at:new Date()})
    close=()=>poolManager.close()
  },60000)
  beforeEach(async()=>{
    await db.query('DELETE FROM authorization_operation_audit WHERE actor_id=$1',[actor]);await db.query('DELETE FROM authorization_operation_receipts WHERE actor_id=$1',[actor])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id=$1',[target]);await db.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])',[[actor,target]])
    await db.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id=$1',[actor]);await db.query('DELETE FROM platform_member_group_members WHERE user_id=$1',[target])
    await db.query('DELETE FROM user_permissions WHERE user_id=$1',[target])
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2),($1,$3),($4,$5)',[actor,actorAlpha,actorBeta,target,otherRole])
    await db.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id,created_by) VALUES ($1,$2,$3,$1),($1,$4,$5,$1)',[actor,alpha,groupA,beta,groupB])
    await db.query('INSERT INTO platform_member_group_members(group_id,user_id) VALUES ($1,$2)',[groupA,target])
    await db.query('INSERT INTO user_permissions(user_id,permission_code) VALUES ($1,$2)',[target,`${other}:read`])
  })
  afterAll(async()=>{
    if(close) await close()
    await db.query('DELETE FROM authorization_operation_audit WHERE actor_id=$1',[actor]);await db.query('DELETE FROM authorization_operation_receipts WHERE actor_id=$1',[actor])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id=$1',[target]);await db.query('DELETE FROM user_permissions WHERE user_id=$1',[target])
    await db.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id=$1',[actor]);await db.query('DELETE FROM platform_member_group_members WHERE user_id=$1',[target]);await db.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])',[[actor,target]])
    await db.query('DELETE FROM platform_member_groups WHERE id=ANY($1::uuid[])',[[groupA,groupB]])
    await db.query('DELETE FROM role_permissions WHERE role_id=ANY($1::text[])',[[role,actorAlpha,actorBeta,otherRole]])
    await db.query('DELETE FROM roles WHERE id=ANY($1::text[])',[[role,actorAlpha,actorBeta,otherRole]])
    await db.query('DELETE FROM permissions WHERE code=ANY($1::text[])',[[`${alpha}:read`,`${beta}:read`,`${other}:read`]])
    await db.query('DELETE FROM users WHERE id=ANY($1::text[])',[[actor,target]]);await db.end()
  })
  it('allows an exact audience and redacts all unrelated grant sources from preview and receipt',async()=>{
    const p=await preview();expect(p.status,JSON.stringify(p.body)).toBe(200)
    expect(JSON.stringify(p.body)).not.toContain(other)
    const id=randomUUID(),done=await commit(input,p.body.expectedVersion,id);expect(done.status,JSON.stringify(done.body)).toBe(200)
    expect(JSON.stringify(done.body)).not.toContain(other)
    expect((await db.query('SELECT source FROM user_namespace_admissions WHERE user_id=$1 AND namespace=$2',[target,alpha])).rows[0].source).toBe('delegated_admin')
    expect((await commit(input,p.body.expectedVersion,id)).body).toEqual(done.body)
    expect((await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'})).body).toEqual(done.body)
  })
  it('does not disclose whole-profile warnings to a delegated actor', async () => {
    await db.query('UPDATE users SET permissions=$2::jsonb WHERE id=$1', [target, '["*:*"]'])
    try {
      const p = await preview()
      expect(p.status, JSON.stringify(p.body)).toBe(200)
      expect(p.body.impact.warnings).toEqual([])
      const id = randomUUID()
      const done = await commit(input, p.body.expectedVersion, id)
      expect(done.status).toBe(200)
      expect(done.body.receipt.impact.warnings).toEqual([])
      expect((await request(app).get(`${path}/${id}`).auth(token, { type: 'bearer' })).body).toEqual(done.body)
    } finally {
      await db.query('UPDATE users SET permissions=$2::jsonb WHERE id=$1', [target, '[]'])
    }
  })
  it('supports a standalone exact-namespace admission and role revoke',async()=>{
    const admission={targetUserId:target,action:{kind:'admission.set'},admissionChanges:[{namespace:alpha,enabled:true}]}
    const p=await preview(admission);expect(p.status).toBe(200)
    expect((await commit(admission,p.body.expectedVersion,randomUUID())).status).toBe(200)
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[target,role])
    const revoke={targetUserId:target,action:{kind:'role.revoke',roleId:role},admissionChanges:[]}
    const q=await preview(revoke);expect(q.status,JSON.stringify(q.body)).toBe(200)
    expect((await commit(revoke,q.body.expectedVersion,randomUUID())).status).toBe(200)
    expect((await db.query('SELECT enabled,source FROM user_namespace_admissions WHERE user_id=$1 AND namespace=$2',[target,alpha])).rows[0]).toEqual({enabled:false,source:'role_unassigned'})
  })
  it('requires authority for each implicit admission affected by revocation',async()=>{
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[target,role])
    await db.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2)',[role,`${beta}:read`])
    try {
      const revoke={targetUserId:target,action:{kind:'role.revoke',roleId:role},admissionChanges:[]}
      expect((await preview(revoke)).status).toBe(403)
      await db.query('INSERT INTO platform_member_group_members(group_id,user_id) VALUES ($1,$2)',[groupB,target])
      const p=await preview(revoke);expect(p.status,JSON.stringify(p.body)).toBe(200)
      expect((await commit(revoke,p.body.expectedVersion,randomUUID())).status).toBe(200)
    } finally { await db.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=$2',[role,`${beta}:read`]) }
  })
  it('does not union an A audience with a B admission and rejects platform or delegated admin roles',async()=>{
    const composite={...input,admissionChanges:[...input.admissionChanges,{namespace:beta,enabled:true}]}
    expect((await preview(composite)).status).toBe(403)
    expect((await preview({targetUserId:target,action:{kind:'admission.set'},admissionChanges:[{namespace:beta,enabled:true}]})).status).toBe(403)
    for(const roleId of ['admin',actorAlpha]) expect((await preview({...input,action:{kind:'role.assign',roleId},admissionChanges:[]})).status).toBe(403)
  })
  it('does not combine a longer role namespace with a shorter namespace audience',async()=>{
    const nested=`${alpha}_sub`, nestedAdmin=`${nested}_admin`,nestedRole=`${nested}_reader`,nestedCode=`${nested}:read`
    await db.query('INSERT INTO roles(id,name) VALUES ($1,$1),($2,$2)',[nestedAdmin,nestedRole])
    await db.query('INSERT INTO permissions(code,name) VALUES ($1,$1)',[nestedCode])
    await db.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2)',[nestedRole,nestedCode])
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[actor,nestedAdmin])
    await db.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id,created_by) VALUES ($1,$2,$3,$1)',[actor,nested,groupB])
    try {
      const operation={targetUserId:target,action:{kind:'role.assign',roleId:nestedRole},admissionChanges:[]}
      expect((await preview(operation)).status).toBe(403)
      await db.query('INSERT INTO platform_member_group_members(group_id,user_id) VALUES ($1,$2)',[groupB,target])
      const p=await preview(operation);expect(p.status,JSON.stringify(p.body)).toBe(200)
      expect((await commit(operation,p.body.expectedVersion,randomUUID())).status).toBe(200)
    } finally {
      await db.query('DELETE FROM user_roles WHERE role_id=ANY($1::text[])',[[nestedAdmin,nestedRole]])
      await db.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id=$1 AND namespace=$2',[actor,nested])
      await db.query('DELETE FROM role_permissions WHERE role_id=$1',[nestedRole]);await db.query('DELETE FROM roles WHERE id=ANY($1::text[])',[[nestedAdmin,nestedRole]])
      await db.query('DELETE FROM permissions WHERE code=$1',[nestedCode])
    }
  })
  it('refuses role codes outside the exact role namespace and rejects a disabled actor',async()=>{
    await db.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2)',[role,`${beta}:read`])
    try { expect((await preview()).status).toBe(403) }
    finally { await db.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=$2',[role,`${beta}:read`]) }
    await db.query('UPDATE users SET is_active=false WHERE id=$1',[actor])
    try { expect((await preview()).status).toBe(401) }
    finally { await db.query('UPDATE users SET is_active=true WHERE id=$1',[actor]) }
  })
  it('refuses a disabled actor in the protected decision even if JWT was accepted earlier',async()=>{
    const [{readOperationSnapshot,calculateOperationImpact},{evaluateAuthorizationOperationAccess}]=await Promise.all([import('../../src/admin/authorization-operation-snapshot'),import('../../src/admin/authorization-operation-service')])
    const snapshot=await readOperationSnapshot((sql,params)=>db.query(sql,params),actor,input)
    snapshot.actor!.is_active=false
    expect(()=>evaluateAuthorizationOperationAccess(snapshot,actor,input,calculateOperationImpact(input,snapshot))).toThrow()
  })
  it('invalidates a preview when audience membership changes and rechecks a lost role after busy',async()=>{
    const p=await preview();expect(p.status).toBe(200)
    await db.query('INSERT INTO platform_member_group_members(group_id,user_id) VALUES ($1,$2)',[groupB,target])
    const id=randomUUID(),stale=await commit(input,p.body.expectedVersion,id);expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('STALE_PREVIEW')
    const q=await preview();expect(q.status).toBe(200)
    const holder=new Client({connectionString:url});await holder.connect();await holder.query('BEGIN');await holder.query('LOCK TABLE public.user_roles IN ROW EXCLUSIVE MODE')
    try {
      const busy=await commit(input,q.body.expectedVersion,randomUUID());expect(busy.body.error.code).toBe('AUTHORIZATION_INPUT_BUSY')
      await holder.query('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2',[actor,actorAlpha]);await holder.query('COMMIT')
      expect((await commit(input,q.body.expectedVersion,randomUUID())).status).toBe(403)
    } finally {await holder.end()}
  })
  it('does not reveal missing or recycled targets to an actor without the required audience',async()=>{
    await db.query('DELETE FROM platform_member_group_members WHERE group_id=$1 AND user_id=$2',[groupA,target])
    const missing={...input,targetUserId:randomUUID()}
    const existing=await preview(input), absent=await preview(missing)
    expect(existing.status).toBe(403); expect(absent.status).toBe(403)
    expect(existing.body).toEqual(absent.body)
    await db.query('UPDATE users SET deleted_at=now() WHERE id=$1',[target])
    try { const recycled=await preview(input);expect(recycled.status).toBe(403);expect(recycled.body).toEqual(absent.body) }
    finally { await db.query('UPDATE users SET deleted_at=NULL WHERE id=$1',[target]) }
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[target,role])
    const conflict={...input,action:{kind:'role.revoke',roleId:role}}
    expect((await preview(conflict)).status).toBe(403)
    expect((await preview({...conflict,targetUserId:randomUUID()})).status).toBe(403)
    const fake=`opaque-v1:${'a'.repeat(64)}`
    const one=await commit(input,fake,randomUUID()),two=await commit(missing,fake,randomUUID())
    expect(one.status).toBe(403); expect(two.status).toBe(403);expect(one.body).toEqual(two.body)
  })
  it('honors directory child scope and rechecks the live directory link',async()=>{
    await db.query('DELETE FROM platform_member_group_members WHERE group_id=$1 AND user_id=$2',[groupA,target])
    const integration=(await db.query('INSERT INTO directory_integrations(name,corp_id) VALUES ($1,$1) RETURNING id',[alpha])).rows[0].id
    let account:string | undefined
    try {
      const parent=(await db.query("INSERT INTO directory_departments(integration_id,external_department_id,name,is_active,raw) VALUES ($1,'parent','parent',true,'{}') RETURNING id",[integration])).rows[0].id
      const child=(await db.query("INSERT INTO directory_departments(integration_id,external_department_id,external_parent_department_id,name,is_active,raw) VALUES ($1,'child','parent','child',true,'{}') RETURNING id",[integration])).rows[0].id
      account=(await db.query("INSERT INTO directory_accounts(integration_id,external_user_id,external_key,name,is_active,raw) VALUES ($1,'synthetic','synthetic','synthetic',true,'{}') RETURNING id",[integration])).rows[0].id
      await db.query("INSERT INTO directory_account_links(directory_account_id,local_user_id,link_status,match_strategy) VALUES ($1,$2,'linked','manual')",[account,target])
      await db.query('INSERT INTO directory_account_departments(directory_account_id,directory_department_id,is_primary) VALUES ($1,$2,true)',[account,child])
      await db.query('INSERT INTO delegated_role_admin_scopes(admin_user_id,namespace,directory_department_id,created_by,include_children) VALUES ($1,$2,$3,$1,true)',[actor,alpha,parent])
      const p=await preview();expect(p.status,JSON.stringify(p.body)).toBe(200)
      const holder=new Client({connectionString:url});await holder.connect();await holder.query('BEGIN')
      await holder.query('LOCK TABLE public.directory_account_links IN ROW EXCLUSIVE MODE')
      try {
        const id=randomUUID(),busy=await commit(input,p.body.expectedVersion,id);expect(busy.body.error.code).toBe('AUTHORIZATION_INPUT_BUSY')
        await holder.query("UPDATE directory_account_links SET link_status='unlinked' WHERE directory_account_id=$1",[account])
        await holder.query('COMMIT');expect((await commit(input,p.body.expectedVersion,id)).status).toBe(403)
      } finally { await holder.end() }
    } finally { await db.query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id=$1',[actor]);await db.query('DELETE FROM directory_integrations WHERE id=$1',[integration]) }
  })
  it('rechecks current audience for stored receipt reads and replay',async()=>{
    const p=await preview();const id=randomUUID();expect((await commit(input,p.body.expectedVersion,id)).status).toBe(200)
    await db.query('DELETE FROM platform_member_group_members WHERE group_id=$1 AND user_id=$2',[groupA,target])
    expect((await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'})).status).toBe(403)
    expect((await commit(input,p.body.expectedVersion,id)).status).toBe(403)
  })
})
