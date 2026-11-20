import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url=process.env.PERMISSION_COMMAND_FENCE_DATABASE_URL
if(url) { const parsed=new URL(url); if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || parsed.pathname!=='/permission_command_fence_test') throw new Error('isolated migrated synthetic fixture required') }
const suite=url ? describe : describe.skip
suite('role assignment provenance with actual PostgreSQL and HTTP',()=>{
  const actor=randomUUID(), target=randomUUID(), nonce=randomUUID().replaceAll('-',''),namespace=`prov${nonce}`,role=`${namespace}_member`, other=`${namespace}_other`
  const createdUsers:string[]=[]
  let db:Client,app:express.Express,token:string,close:()=>Promise<void>
  let assignUserRoles: typeof import('../../src/rbac/role-assignment').assignUserRoles
  let unassignUserRoles: typeof import('../../src/rbac/role-assignment').unassignUserRoles
  const executor={query:async(sql:string,params?:unknown[])=>db.query(sql,params)}
  beforeAll(async()=>{
    db=new Client({connectionString:url});await db.connect()
    await db.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'actor','synthetic','admin',true),($3,$4,'target','synthetic','user',false)",[actor,`${actor}@example.test`,target,`${target}@example.test`])
    await db.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin')",[actor])
    await db.query('INSERT INTO roles(id,name) VALUES ($1,$1),($2,$2)',[role,other])
    process.env.DATABASE_URL=url;process.env.JWT_SECRET='synthetic-provenance-jwt-secret-only';process.env.PRODUCT_MODE='attendance';process.env.RBAC_TOKEN_TRUST='false';process.env.RBAC_BYPASS='false'
    const [{adminUsersRouter},{authService},{poolManager},roleWriters]=await Promise.all([import('../../src/routes/admin-users'),import('../../src/auth/AuthService'),import('../../src/integration/db/connection-pool'),import('../../src/rbac/role-assignment')])
    assignUserRoles=roleWriters.assignUserRoles;unassignUserRoles=roleWriters.unassignUserRoles
    app=express();app.use(express.json());app.use(adminUsersRouter())
    token=authService.createToken({id:actor,email:`${actor}@example.test`,name:'actor',role:'user',permissions:[],created_at:new Date(),updated_at:new Date()})
    close=()=>poolManager.close()
  },60000)
  afterAll(async()=>{
    if(close)await close()
    const ids=[actor,target,...createdUsers]
    await db.query('DELETE FROM authorization_operation_audit WHERE actor_id=$1',[actor]);await db.query('DELETE FROM authorization_operation_receipts WHERE actor_id=$1',[actor])
    await db.query('DELETE FROM user_namespace_admissions WHERE user_id=ANY($1::text[])',[ids]);await db.query('DELETE FROM user_permissions WHERE user_id=ANY($1::text[])',[ids]);await db.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])',[ids])
    await db.query('DELETE FROM user_login_aliases WHERE user_id=ANY($1::text[])',[ids]);await db.query('DELETE FROM users WHERE id=ANY($1::text[])',[ids]);await db.query('DELETE FROM roles WHERE id=ANY($1::text[])',[[role,other]])
    await db.end()
  })
  it('preserves unknown and original source on conflicts; revoke and reassign writes a new source',async()=>{
    await db.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[target,role])
    const assign=(source?:'manual'|'creation')=>assignUserRoles({userIds:[target],roleId:role,scope:{kind:'platform-admin'},assignmentSource:source,executor})
    const source=async()=>(await db.query('SELECT assignment_source FROM user_roles WHERE user_id=$1 AND role_id=$2',[target,role])).rows[0]?.assignment_source
    expect(await source()).toBeNull();expect((await assign('manual')).rowCount).toBe(0);expect(await source()).toBeNull()
    await unassignUserRoles({userIds:[target],roleId:role,scope:{kind:'platform-admin'},executor})
    expect((await assign('creation')).rowCount).toBe(1);expect(await source()).toBe('creation')
    expect((await assign('manual')).rowCount).toBe(0);expect(await source()).toBe('creation')
    await unassignUserRoles({userIds:[target],roleId:role,scope:{kind:'platform-admin'},executor})
    await assign('manual');expect(await source()).toBe('manual')
    await unassignUserRoles({userIds:[target],roleId:role,scope:{kind:'platform-admin'},executor})
    await assign();expect(await source()).toBeNull()
    await expect(db.query("UPDATE user_roles SET assignment_source='guessed' WHERE user_id=$1 AND role_id=$2",[target,role])).rejects.toMatchObject({code:'23514'})
  })
  it('shows unknown for historical rows and records explicit admin role assignment as manual',async()=>{
    const get=()=>request(app).get(`/api/admin/users/${target}/access`).auth(token,{type:'bearer'})
    const initial=await get();expect(initial.status,JSON.stringify(initial.body)).toBe(200)
    expect(initial.body.data.roles).toContain(role);expect(initial.body.data.roleAssignments).toContainEqual({roleId:role,source:'unknown'})
    const assign=await request(app).post(`/api/admin/users/${target}/roles/assign`).auth(token,{type:'bearer'}).send({roleId:other})
    expect(assign.status,JSON.stringify(assign.body)).toBe(200)
    const after=await get();expect(after.body.data.roles).toContain(other);expect(after.body.data.roleAssignments).toContainEqual({roleId:other,source:'manual'})
    const repeat=await request(app).post(`/api/admin/users/${target}/roles/assign`).auth(token,{type:'bearer'}).send({roleId:role})
    expect(repeat.status,JSON.stringify(repeat.body)).toBe(200);expect((await get()).body.data.roleAssignments).toContainEqual({roleId:role,source:'unknown'})
  })
  it('records admin user creation role as creation rather than manual',async()=>{
    const res=await request(app).post('/api/admin/users').auth(token,{type:'bearer'}).send({name:'Synthetic Member',username:`u${nonce}`,roleId:role,password:'Synthetic-Role123!',admissionNamespaces:[]})
    expect(res.status,JSON.stringify(res.body)).toBe(200);const userId=res.body.data.user.id;createdUsers.push(userId)
    expect(res.body.data.roles).toContain(role);expect(res.body.data.roleAssignments).toContainEqual({roleId:role,source:'creation'})
    const read=await request(app).get(`/api/admin/users/${userId}/access`).auth(token,{type:'bearer'})
    expect(read.status).toBe(200);expect(read.body.data.roleAssignments).toContainEqual({roleId:role,source:'creation'})
  })
  it('marks self-service registration as creation while later login bootstrap stays unknown',async()=>{
    const {authService}=await import('../../src/auth/AuthService')
    const registered=await authService.register(`${nonce}@example.test`,'Synthetic-Role123!','Synthetic Register')
    expect(registered).not.toBeNull();createdUsers.push(registered!.id)
    expect((await db.query("SELECT assignment_source FROM user_roles WHERE user_id=$1 AND role_id='attendance_employee'",[registered!.id])).rows[0]?.assignment_source).toBe('creation')
    const old=randomUUID();createdUsers.push(old)
    await db.query("INSERT INTO users(id,email,name,password_hash,role,is_admin,permissions) VALUES ($1,$2,'old','synthetic','user',false,'[]')",[old,`${old}@example.test`])
    const session=authService.createToken({id:old,email:`${old}@example.test`,name:'old',role:'user',permissions:[],created_at:new Date(),updated_at:new Date()})
    const verified=await authService.verifyToken(session)
    expect(verified?.id).toBe(old)
    expect(verified?.permissions).toEqual(expect.arrayContaining(['attendance:read','attendance:write']))
    const row=(await db.query("SELECT assignment_source FROM user_roles WHERE user_id=$1 AND role_id='attendance_employee'",[old])).rows[0]
    expect(row).toBeDefined();expect(row.assignment_source).toBeNull()
  })
  it('does not expose provenance of roles outside a delegate revocable catalog',async()=>{
    const delegated=randomUUID(),delegatedRole=`${namespace}_admin`,outside=`outside${nonce}_reader`
    await db.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'delegate','synthetic','user',false)",[delegated,`${delegated}@example.test`])
    await db.query('INSERT INTO roles(id,name) VALUES ($1,$1),($2,$2)',[delegatedRole,outside])
    await db.query("INSERT INTO user_roles(user_id,role_id,assignment_source) VALUES ($1,$2,'creation'),($3,$4,'manual')",[delegated,delegatedRole,target,outside])
    const group=(await db.query('INSERT INTO platform_member_groups(name) VALUES ($1) RETURNING id',[namespace])).rows[0].id
    try {
      await db.query('INSERT INTO platform_member_group_members(group_id,user_id) VALUES ($1,$2)',[group,target])
      await db.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id,created_by) VALUES ($1,$2,$3,$1)',[delegated,namespace,group])
      const {authService}=await import('../../src/auth/AuthService')
      const delegatedToken=authService.createToken({id:delegated,email:`${delegated}@example.test`,name:'delegate',role:'user',permissions:[],created_at:new Date(),updated_at:new Date()})
      const result=await request(app).get(`/api/admin/role-delegation/users/${target}/access`).auth(delegatedToken,{type:'bearer'})
      expect(result.status,JSON.stringify(result.body)).toBe(200)
      expect(result.body.data.roles).toContain(outside)
      expect(result.body.data.roleAssignments).not.toContainEqual({roleId:outside,source:'manual'})
      expect(result.body.data.roleAssignments).toContainEqual({roleId:other,source:'manual'})
      await db.query('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2',[target,other])
      const assigned=await request(app).post(`/api/admin/role-delegation/users/${target}/roles/assign`).auth(delegatedToken,{type:'bearer'}).send({roleId:other})
      expect(assigned.status,JSON.stringify(assigned.body)).toBe(200)
      expect((await db.query('SELECT assignment_source FROM user_roles WHERE user_id=$1 AND role_id=$2',[target,other])).rows[0].assignment_source).toBe('manual')
    } finally {
      await db.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id=$1',[delegated]);await db.query('DELETE FROM platform_member_group_members WHERE group_id=$1',[group]);await db.query('DELETE FROM platform_member_groups WHERE id=$1',[group])
      await db.query('DELETE FROM user_roles WHERE user_id=$1 OR role_id=$2',[delegated,outside]);await db.query('DELETE FROM users WHERE id=$1',[delegated]);await db.query('DELETE FROM roles WHERE id=ANY($1::text[])',[[delegatedRole,outside]])
    }
  })
  it('records both attendance single and batch role assignments as manual',async()=>{
    const [{attendanceAdminRouter},{authenticate}]=await Promise.all([import('../../src/routes/attendance-admin'),import('../../src/middleware/auth')])
    const attendance=express();attendance.use(express.json());attendance.use(authenticate,attendanceAdminRouter())
    const single=await request(attendance).post(`/api/attendance-admin/users/${target}/roles/assign`).auth(token,{type:'bearer'}).send({scope:'global',roleId:'attendance_approver'})
    expect(single.status,JSON.stringify(single.body)).toBe(200)
    const batch=await request(attendance).post('/api/attendance-admin/users/batch/roles/assign').auth(token,{type:'bearer'}).send({scope:'global',roleId:'attendance_importer',userIds:[target]})
    expect(batch.status,JSON.stringify(batch.body)).toBe(200)
    expect((await db.query("SELECT role_id,assignment_source FROM user_roles WHERE user_id=$1 AND role_id=ANY($2::text[]) ORDER BY role_id",[target,['attendance_approver','attendance_importer']])).rows).toEqual([{role_id:'attendance_approver',assignment_source:'manual'},{role_id:'attendance_importer',assignment_source:'manual'}])
  })
  it('records batch creation as creation and a later batch role change as manual',async()=>{
    const email=`batch${nonce}@example.test`
    const made=await request(app).post('/api/admin/users/batch/create').auth(token,{type:'bearer'}).send({items:[{email,name:'Batch Synthetic',roleId:role}]})
    expect(made.status,JSON.stringify(made.body)).toBe(200)
    const found=(await db.query('SELECT id FROM users WHERE email=$1',[email])).rows[0];expect(found).toBeDefined();createdUsers.push(found.id)
    expect((await db.query('SELECT assignment_source FROM user_roles WHERE user_id=$1 AND role_id=$2',[found.id,role])).rows[0].assignment_source).toBe('creation')
    const changed=await request(app).post('/api/admin/users/batch/update').auth(token,{type:'bearer'}).send({items:[{userId:found.id,roleId:other}]})
    expect(changed.status,JSON.stringify(changed.body)).toBe(200)
    expect((await db.query('SELECT assignment_source FROM user_roles WHERE user_id=$1 AND role_id=$2',[found.id,other])).rows[0].assignment_source).toBe('manual')
  })
  it('records command role assignment as manual and does not relabel an existing role',async()=>{
    const path='/api/admin/authorization-operations', payload={targetUserId:target,action:{kind:'role.assign',roleId:role},admissionChanges:[]}
    await db.query('DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2',[target,role])
    const p=await request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(payload);expect(p.status,JSON.stringify(p.body)).toBe(200)
    const result=await request(app).post(path).auth(token,{type:'bearer'}).send({...payload,expectedVersion:p.body.expectedVersion,clientOperationId:randomUUID()})
    expect(result.status,JSON.stringify(result.body)).toBe(200)
    expect((await db.query('SELECT assignment_source FROM user_roles WHERE user_id=$1 AND role_id=$2',[target,role])).rows[0].assignment_source).toBe('manual')

    await db.query("UPDATE user_roles SET assignment_source='creation' WHERE user_id=$1 AND role_id=$2",[target,role])
    const repeatedPreview=await request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(payload)
    expect(repeatedPreview.status,JSON.stringify(repeatedPreview.body)).toBe(200)
    const repeated=await request(app).post(path).auth(token,{type:'bearer'}).send({
      ...payload,
      expectedVersion:repeatedPreview.body.expectedVersion,
      clientOperationId:randomUUID(),
    })
    expect(repeated.status,JSON.stringify(repeated.body)).toBe(200)
    expect(repeated.body.receipt.impact.sourceChanges).toEqual([{source:'role',id:role,operation:'assign',changed:false}])
    expect((await db.query('SELECT assignment_source FROM user_roles WHERE user_id=$1 AND role_id=$2',[target,role])).rows[0].assignment_source).toBe('creation')
  })
})
