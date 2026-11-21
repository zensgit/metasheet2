import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import nodePath from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from 'pg'
import { assertAuthorizationOperationSchema } from '../../src/admin/authorization-operation-fence'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env.PERMISSION_COMMAND_FENCE_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname) || !['/permission_command_fence_test','/permission_command_upgrade_test'].includes(parsed.pathname)) throw new Error('isolated migrated loopback fixture required')
}
const suite = url ? describe : describe.skip
suite('real authorization operation on the migrated synthetic schema', () => {
  const actor=randomUUID(), target=randomUUID(), ordinary=randomUUID(), nonce=randomUUID().replaceAll('-','')
  const namespace=`permcmd${nonce}`, roleId=`${namespace}_member`, adminRole=`${namespace}_admin`, code=`${namespace}:read`, adminCode=`${namespace}:admin`, integration=randomUUID(), department=randomUUID()
  let group:string
  const body={ targetUserId:target, action:{ kind:'role.assign',roleId }, admissionChanges:[{namespace,enabled:true}] }
  const path='/api/admin/authorization-operations'
  let control:Client, app:express.Express, hostApp:express.Express, token:string, ordinaryToken:string, closePool:()=>Promise<void>
  beforeAll(async () => {
    control = new Client({ connectionString:url }); await control.connect()
    await control.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'actor','synthetic','admin',true),($3,$4,'target','synthetic','user',false)", [actor,`${actor}@example.test`,target,`${target}@example.test`])
    await control.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'ordinary','synthetic','user',false)", [ordinary,`${ordinary}@example.test`])
    await control.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin')", [actor])
    await control.query('INSERT INTO permissions(code,name) VALUES ($1,$1)', [code])
    await control.query('INSERT INTO roles(id,name) VALUES ($1,$1)', [roleId])
    await control.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2)', [roleId,code])
    await control.query('INSERT INTO permissions(code,name) VALUES ($1,$1)',[adminCode])
    await control.query('INSERT INTO roles(id,name) VALUES ($1,$1)',[adminRole])
    await control.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2)',[adminRole,adminCode])
    await control.query("INSERT INTO directory_integrations(id,org_id,provider,name,corp_id,sync_enabled) VALUES ($1::uuid,'default','dingtalk',$1::uuid::text,$1::uuid::text,false)",[integration])
    await control.query("INSERT INTO directory_departments(id,integration_id,external_department_id,name,is_active,raw) VALUES ($1::uuid,$2::uuid,$1::uuid::text,$1::uuid::text,true,'{}'::jsonb)",[department,integration])
    group=(await control.query('INSERT INTO platform_member_groups(name) VALUES ($1) RETURNING id',[namespace])).rows[0].id
    process.env.DATABASE_URL=url; process.env.JWT_SECRET='synthetic-test-secret-for-permission-command-only'
    process.env.PRODUCT_MODE='attendance'; process.env.RBAC_TOKEN_TRUST='false'; process.env.RBAC_BYPASS='false'
    const [{ adminUsersRouter },{ authService },{ poolManager },{ MetaSheetServer }] = await Promise.all([
      import('../../src/routes/admin-users'), import('../../src/auth/AuthService'), import('../../src/integration/db/connection-pool'), import('../../src/index'),
    ])
    app=express(); app.use(express.json()); app.use(adminUsersRouter())
    const host=new MetaSheetServer({ pluginDirs:[], manageProcessSignals:false })
    hostApp=(host as unknown as {app:express.Express}).app
    ordinaryToken=authService.createToken({ id:ordinary,email:`${ordinary}@example.test`,name:'synthetic',role:'user',permissions:[],created_at:new Date(),updated_at:new Date() })
    token=authService.createToken({ id:actor,email:`${actor}@example.test`,name:'synthetic',role:'user',permissions:[],created_at:new Date(),updated_at:new Date() })
    closePool=()=>poolManager.close()
  },60000)
  beforeEach(async () => {
    await control.query('DELETE FROM authorization_operation_audit WHERE actor_id=$1',[actor])
    await control.query('DELETE FROM authorization_operation_receipts WHERE actor_id=$1',[actor])
    await control.query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id=$1',[target])
    await control.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id=$1',[target])
    await control.query('DELETE FROM user_namespace_admissions WHERE user_id=$1',[target])
    await control.query('DELETE FROM user_roles WHERE user_id=$1',[target])
    await control.query("UPDATE users SET role='admin', is_admin=true, is_active=true, activation_status='activated', deleted_at=NULL, purged_at=NULL WHERE id=$1",[actor])
    await control.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin') ON CONFLICT DO NOTHING",[actor])
  })
  afterAll(async () => {
    if (closePool) await closePool()
    await control.query('DELETE FROM authorization_operation_audit WHERE actor_id=$1',[actor])
    await control.query('DELETE FROM authorization_operation_receipts WHERE actor_id=$1',[actor])
    await control.query('DELETE FROM user_namespace_admissions WHERE user_id=ANY($1::text[])',[[actor,target,ordinary]])
    await control.query('DELETE FROM user_roles WHERE user_id=ANY($1::text[])',[[actor,target,ordinary]])
    await control.query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id=$1',[target])
    await control.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id=$1',[target])
    await control.query('DELETE FROM platform_member_groups WHERE id=$1',[group])
    await control.query('DELETE FROM directory_departments WHERE id=$1',[department])
    await control.query('DELETE FROM directory_integrations WHERE id=$1',[integration])
    await control.query('DELETE FROM role_permissions WHERE role_id=$1',[adminRole])
    await control.query('DELETE FROM roles WHERE id=$1',[adminRole])
    await control.query('DELETE FROM permissions WHERE code=$1',[adminCode])
    await control.query('DELETE FROM role_permissions WHERE role_id=$1',[roleId])
    await control.query('DELETE FROM roles WHERE id=$1',[roleId])
    await control.query('DELETE FROM permissions WHERE code=$1',[code])
    await control.query('DELETE FROM users WHERE id=ANY($1::text[])',[[actor,target,ordinary]])
    await control.end()
  })
  const seedScopes=async()=>{
    await control.query('INSERT INTO user_roles(user_id,role_id) VALUES ($1,$2)',[target,adminRole])
    await control.query('INSERT INTO delegated_role_admin_scopes(admin_user_id,namespace,directory_department_id,created_by) VALUES ($1,$2,$3,$1)',[target,namespace,department])
    await control.query('INSERT INTO delegated_role_admin_member_groups(admin_user_id,namespace,group_id,created_by) VALUES ($1,$2,$3,$1)',[target,namespace,group])
  }
  const preview=()=>request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(body)
  const commit=(version:string,id:string)=>request(app).post(path).auth(token,{type:'bearer'}).send({...body,expectedVersion:version,clientOperationId:id})
  it('refuses changes to either side of the integrated B2 schema profile', async () => {
    const query = (sql: string, params?: unknown[]) => control.query(sql, params)
    await control.query('BEGIN')
    try {
      await control.query('SET LOCAL search_path TO pg_catalog, public, pg_temp')
      await assertAuthorizationOperationSchema(query)
      await control.query('SAVEPOINT original_profile')
      for (const ddl of [
        'ALTER TABLE public.users DISABLE TRIGGER admin_grant_local_credential_version',
        'ALTER TABLE public.roles ADD COLUMN fixture_extra text',
      ]) {
        await control.query(ddl)
        await expect(assertAuthorizationOperationSchema(query)).rejects.toMatchObject({
          code: 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE',
        })
        await control.query('ROLLBACK TO SAVEPOINT original_profile')
        await assertAuthorizationOperationSchema(query)
      }
    } finally {
      await control.query('ROLLBACK')
    }
  })

  it('refuses a changed, disabled or missing D21 subject-version addition', async () => {
    // D21 (Y5a #6786) is hashed as its own catalog addition next to B2; each edit of one of its six
    // fenced-table triggers or two functions must leave no accepted profile, and rolling the edit back restores it.
    const query = (sql: string, params?: unknown[]) => control.query(sql, params)
    await control.query('BEGIN')
    try {
      await control.query('SET LOCAL search_path TO pg_catalog, public, pg_temp')
      await assertAuthorizationOperationSchema(query)
      await control.query('SAVEPOINT original_profile')
      for (const ddl of [
        'ALTER TABLE public.user_roles DISABLE TRIGGER trg_user_roles_zz_authz_subject_version',
        'DROP TRIGGER trg_users_zz_authz_subject_version_update ON public.users',
        `CREATE OR REPLACE FUNCTION public.metasheet_authz_bump_sheet_permission_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
      ]) {
        await control.query(ddl)
        await expect(assertAuthorizationOperationSchema(query), ddl).rejects.toMatchObject({
          code: 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE',
        })
        await control.query('ROLLBACK TO SAVEPOINT original_profile')
        await assertAuthorizationOperationSchema(query)
      }
    } finally {
      await control.query('ROLLBACK')
    }
  })

  it('previews, commits and replays using the real fence and current migrated schema', async () => {
    const p=await preview(); expect(p.status,JSON.stringify(p.body)).toBe(200)
    expect(p.body.impact.effectiveAfter).toEqual([{code,sources:[{kind:'role',id:roleId}],effective:true}])
    const id=randomUUID(), done=await commit(p.body.expectedVersion,id)
    expect(done.status,JSON.stringify(done.body)).toBe(200); expect(done.body.status).toBe('committed')
    expect((await commit(p.body.expectedVersion,id)).body).toEqual(done.body)
    expect((await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'})).body).toEqual(done.body)
    const audit=await control.query('SELECT actor_id,reason_origin FROM authorization_operation_audit WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])
    expect(audit.rows).toEqual([{actor_id:actor,reason_origin:'not_required'}])
  })
  it('refuses preview and commit before any business write when only the D21 version table drifts', async () => {
    // The migration creates subject_authorization_versions IF NOT EXISTS and every D21 trigger upserts it
    // ON CONFLICT (subject_id): a same-named table without that key must be refused on both paths, before
    // any role, admission, receipt or audit row is written. Triggers and functions stay unchanged here.
    const ready=await preview(); expect(ready.status,JSON.stringify(ready.body)).toBe(200)
    const writes=async()=>(await control.query(`SELECT
      (SELECT count(*)::int FROM user_roles WHERE user_id=$1) AS roles,
      (SELECT count(*)::int FROM user_namespace_admissions WHERE user_id=$1) AS admissions,
      (SELECT count(*)::int FROM authorization_operation_receipts WHERE actor_id=$2) AS receipts,
      (SELECT count(*)::int FROM authorization_operation_audit WHERE actor_id=$2) AS audit`,[target,actor])).rows[0]
    const before=await writes()
    await control.query('ALTER TABLE public.subject_authorization_versions DROP CONSTRAINT subject_authorization_versions_pkey')
    try {
      const p=await preview()
      expect(p.status,JSON.stringify(p.body)).toBe(503); expect(p.body.error.code).toBe('AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE')
      const c=await commit(ready.body.expectedVersion,randomUUID())
      expect(c.status,JSON.stringify(c.body)).toBe(503); expect(c.body.error.code).toBe('AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE')
      expect(await writes()).toEqual(before)
    } finally {
      await control.query('ALTER TABLE public.subject_authorization_versions ADD CONSTRAINT subject_authorization_versions_pkey PRIMARY KEY (subject_id)')
    }
    expect((await preview()).status).toBe(200)
  })
  it('fails closed for an unrecognized trigger and returns to readiness after rollback', async () => {
    await control.query(`CREATE FUNCTION permission_command_unknown_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`)
    await control.query('CREATE TRIGGER permission_command_unknown BEFORE INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION permission_command_unknown_trigger()')
    try { const p=await preview(); expect(p.status).toBe(503); expect(p.body.error.code).toBe('AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE') }
    finally { await control.query('DROP TRIGGER permission_command_unknown ON user_roles'); await control.query('DROP FUNCTION permission_command_unknown_trigger()') }
    expect((await preview()).status).toBe(200)
  })
  it('returns busy without writes for a pre-existing ordinary writer then succeeds on explicit retry', async () => {
    const p=await preview(); expect(p.status).toBe(200)
    const holder=new Client({connectionString:url}); await holder.connect(); await holder.query('BEGIN')
    await holder.query('LOCK TABLE public.role_permissions IN ROW EXCLUSIVE MODE')
    const id=randomUUID()
    try { const result=await commit(p.body.expectedVersion,id); expect(result.status).toBe(409); expect(result.body.error.code).toBe('AUTHORIZATION_INPUT_BUSY') }
    finally { await holder.query('ROLLBACK'); await holder.end() }
    const result=await commit(p.body.expectedVersion,id); expect(result.status,JSON.stringify(result.body)).toBe(200)
  })
  ;(process.env.PERMISSION_COMMAND_TEST_SLOW_PLAN === '1' ? it : it.skip)('bounds slow pre-planning reads and never starts a late write', async () => {
    const p=await preview(); expect(p.status).toBe(200)
    const id=randomUUID(), started=Date.now()
    const done=await commit(p.body.expectedVersion,id)
    expect(done.status).toBe(503); expect(done.body.error.code).toBe('AUTHORIZATION_OPERATION_OUTCOME_UNKNOWN')
    expect(Date.now()-started).toBeLessThan(6500)
    await new Promise(resolve => setTimeout(resolve,1800))
    expect((await control.query('SELECT count(*)::int AS n FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])).rows[0].n).toBe(0)
    expect((await control.query('SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1 AND role_id=$2',[target,roleId])).rows[0].n).toBe(0)
  },12000)

  ;(process.env.PERMISSION_COMMAND_TEST_DELAY_COMMIT === '1' ? it : it.skip)('returns unknown while COMMIT is pending, then GET observes the late receipt and released locks', async () => {
    const child=spawn(process.execPath,['--import','tsx',nodePath.resolve(__dirname,'../helpers/authorization-operation-read-probe.ts')], {
      cwd:process.cwd(), env:{...process.env,DATABASE_URL:url,PERMISSION_COMMAND_PROBE_USER:target}, stdio:['pipe','pipe','pipe'],
    })
    const output=createInterface({input:child.stdout})
    const replies: string[][]=[]; const waiting: Array<(codes:string[])=>void>=[]
    output.on('line', line => {
      if (!line.startsWith('PERMISSION_PROBE ')) return
      const codes=JSON.parse(line.slice('PERMISSION_PROBE '.length)) as string[]
      const resolve=waiting.shift(); if(resolve) resolve(codes); else replies.push(codes)
    })
    const readProbe=() => new Promise<string[]>((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('synthetic permission probe timed out')),4000)
      const finish=(codes:string[]) => {clearTimeout(timer);resolve(codes)}
      if(replies.length) finish(replies.shift()!); else waiting.push(finish)
      child.stdin.write('read\n')
    })
    try {
      expect(await readProbe()).not.toContain(code)
      const p=await preview(); expect(p.status,JSON.stringify(p.body)).toBe(200)
      const id=randomUUID(), started=Date.now()
      const done=await commit(p.body.expectedVersion,id)
    expect(done.status).toBe(503); expect(done.body.error.code).toBe('AUTHORIZATION_OPERATION_OUTCOME_UNKNOWN')
    expect(Date.now()-started).toBeGreaterThan(4500)
    expect(Date.now()-started).toBeLessThan(6500)
    const lockProbe=new Client({connectionString:url}); await lockProbe.connect(); await lockProbe.query('BEGIN')
    try { await expect(lockProbe.query('LOCK TABLE public.user_roles IN ROW EXCLUSIVE MODE NOWAIT')).rejects.toMatchObject({code:'55P03'}) }
    finally { await lockProbe.query('ROLLBACK') }
    const first=await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'})
    expect(first.status,JSON.stringify(first.body)).toBe(200); expect(first.body.status).toBe('unknown_or_pending')
    expect(await readProbe()).not.toContain(code)
    const until=Date.now()+6000; let observed=first
    while(Date.now()<until && observed.body.status!=='committed') {
      await new Promise(resolve=>setTimeout(resolve,100))
      observed=await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'})
    }
      expect(observed.status).toBe(200); expect(observed.body.status).toBe('committed')
      expect(await readProbe()).toContain(code)
      await lockProbe.query('BEGIN'); try { await lockProbe.query('LOCK TABLE public.user_roles IN ROW EXCLUSIVE MODE NOWAIT') } finally { await lockProbe.query('ROLLBACK'); await lockProbe.end() }
    } finally { child.stdin.write('quit\n'); child.stdin.end(); output.close() }
  },20000)

  it('rejects stale role contents after busy and explicit retry', async () => {
    const p=await preview(); expect(p.status).toBe(200)
    const holder=new Client({connectionString:url}); await holder.connect(); await holder.query('BEGIN')
    const added=`${namespace}:extra`; await control.query('INSERT INTO permissions(code,name) VALUES ($1,$1)',[added])
    await holder.query('UPDATE roles SET name=name || $2 WHERE id=$1',[roleId,' changed'])
    await holder.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2)',[roleId,added])
    const id=randomUUID()
    try {
      const busy=await commit(p.body.expectedVersion,id)
      expect(busy.status).toBe(409); expect(busy.body.error.code).toBe('AUTHORIZATION_INPUT_BUSY')
      await holder.query('COMMIT')
      const stale=await commit(p.body.expectedVersion,id)
      expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('STALE_PREVIEW')
      expect((await control.query('SELECT count(*)::int n FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])).rows[0].n).toBe(0)
    } finally { await holder.end(); await control.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_code=$2',[roleId,added]); await control.query('DELETE FROM permissions WHERE code=$1',[added]) }
  })
  it('rejects a recreated role even when its visible contents and timestamp are restored', async () => {
    await control.query("UPDATE roles SET updated_at='2020-01-01T00:00:00Z' WHERE id=$1",[roleId])
    const p=await preview(); expect(p.status).toBe(200)
    const role=(await control.query('SELECT id,name,updated_at FROM roles WHERE id=$1',[roleId])).rows[0]
    await control.query('DELETE FROM role_permissions WHERE role_id=$1',[roleId])
    await control.query('DELETE FROM roles WHERE id=$1',[roleId])
    await control.query('INSERT INTO roles(id,name,updated_at) VALUES ($1,$2,$3)',[role.id,role.name,role.updated_at])
    await control.query('INSERT INTO role_permissions(role_id,permission_code) VALUES ($1,$2)',[roleId,code])
    const done=await commit(p.body.expectedVersion,randomUUID())
    expect(done.status).toBe(409); expect(done.body.error.code).toBe('STALE_PREVIEW')
  })
  it('rejects a target recycled after preview before making writes', async () => {
    const p=await preview(); expect(p.status).toBe(200)
    await control.query('UPDATE users SET deleted_at=now() WHERE id=$1',[target])
    try {
      const id=randomUUID(), done=await commit(p.body.expectedVersion,id)
      expect(done.status).toBe(404)
      expect((await control.query('SELECT count(*)::int n FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])).rows[0].n).toBe(0)
    } finally { await control.query('UPDATE users SET deleted_at=NULL WHERE id=$1',[target]) }
  })
  it('rechecks actor authority after a busy response and denies receipt reads after loss', async () => {
    const p=await preview(); expect(p.status).toBe(200)
    const holder=new Client({connectionString:url}); await holder.connect(); await holder.query('BEGIN')
    await holder.query('LOCK TABLE public.user_roles IN ROW EXCLUSIVE MODE')
    const id=randomUUID()
    try {
      expect((await commit(p.body.expectedVersion,id)).body.error.code).toBe('AUTHORIZATION_INPUT_BUSY')
      await holder.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'",[actor])
      await holder.query("UPDATE users SET role='user',is_admin=false WHERE id=$1",[actor])
      await holder.query('COMMIT')
      expect((await commit(p.body.expectedVersion,id)).status).toBe(403)
      expect((await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'})).status).toBe(403)
    } finally { await holder.end() }
  })
  it('rechecks stored receipt target and actor read authority', async () => {
    const p=await preview(); const id=randomUUID(); expect((await commit(p.body.expectedVersion,id)).status).toBe(200)
    await control.query("UPDATE users SET deleted_at=now() WHERE id=$1",[target])
    try { expect((await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'})).status).toBe(404) }
    finally { await control.query('UPDATE users SET deleted_at=NULL WHERE id=$1',[target]) }
    await control.query("DELETE FROM user_roles WHERE user_id=$1 AND role_id='admin'",[actor])
    await control.query("UPDATE users SET role='user',is_admin=false WHERE id=$1",[actor])
    expect((await request(app).get(`${path}/${id}`).auth(token,{type:'bearer'})).status).toBe(403)
  })
  it('prevents removal of the last active sign-in administrator', async () => {
    const disabled=await control.query('UPDATE users SET is_active=false WHERE id<>$1 AND is_active=true RETURNING id',[actor])
    try {
      const input={targetUserId:actor,action:{kind:'role.revoke',roleId:'admin'},admissionChanges:[]}
      const p=await request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(input)
      expect(p.status,JSON.stringify(p.body)).toBe(200)
      const done=await request(app).post(path).auth(token,{type:'bearer'}).send({...input,expectedVersion:p.body.expectedVersion,clientOperationId:randomUUID()})
      expect(done.status).toBe(409); expect(done.body.error.code).toBe('LAST_PLATFORM_ADMIN')
      expect((await control.query("SELECT count(*)::int n FROM user_roles WHERE user_id=$1 AND role_id='admin'",[actor])).rows[0].n).toBe(1)
    } finally { await control.query('UPDATE users SET is_active=true WHERE id=ANY($1::text[])',[disabled.rows.map(row=>row.id)]) }
  })
  it('preserves attendance admission when employee opt-out has another attendance role', async () => {
    await control.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'attendance_employee'),($1,'attendance_approver')",[target])
    await control.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source) VALUES ($1,'attendance',true,'platform_admin')",[target])
    const input={targetUserId:target,action:{kind:'role.revoke',roleId:'attendance_employee'},admissionChanges:[]}
    const p=await request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(input)
    expect(p.status,JSON.stringify(p.body)).toBe(200)
    expect(p.body.impact.warnings).toContain('attendance_employee_opt_out')
    const done=await request(app).post(path).auth(token,{type:'bearer'}).send({...input,expectedVersion:p.body.expectedVersion,clientOperationId:randomUUID()})
    expect(done.status,JSON.stringify(done.body)).toBe(200)
    expect((await control.query("SELECT enabled,source FROM user_namespace_admissions WHERE user_id=$1 AND namespace='attendance'",[target])).rows[0]).toEqual({enabled:true,source:'role_unassigned'})
  })
  it('keeps one administrator during concurrent revocations and refuses the loser on explicit retry', async () => {
    const other=randomUUID()
    await control.query("INSERT INTO users(id,email,name,password_hash,role,is_admin) VALUES ($1,$2,'other','synthetic','admin',true)",[other,`${other}@example.test`])
    await control.query("INSERT INTO user_roles(user_id,role_id) VALUES ($1,'admin')",[other])
    const disabled=await control.query('UPDATE users SET is_active=false WHERE id<>ALL($1::text[]) AND is_active=true RETURNING id',[[actor,other]])
    try {
      const {authService}=await import('../../src/auth/AuthService')
      const otherToken=authService.createToken({id:other,email:`${other}@example.test`,name:'other',role:'user',permissions:[],created_at:new Date(),updated_at:new Date()})
      const left={targetUserId:other,action:{kind:'role.revoke',roleId:'admin'},admissionChanges:[]}
      const right={...left,targetUserId:actor}
      const p=await request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(left)
      const q=await request(app).post(`${path}/preview`).auth(otherToken,{type:'bearer'}).send(right)
      expect(p.status).toBe(200); expect(q.status).toBe(200)
      const leftId=randomUUID(),rightId=randomUUID()
      const [a,b]=await Promise.all([
        request(app).post(path).auth(token,{type:'bearer'}).send({...left,expectedVersion:p.body.expectedVersion,clientOperationId:leftId}),
        request(app).post(path).auth(otherToken,{type:'bearer'}).send({...right,expectedVersion:q.body.expectedVersion,clientOperationId:rightId}),
      ])
      expect([a.status,b.status].filter(status=>status===200)).toHaveLength(1)
      const loser=a.status===200 ? {payload:right,version:q.body.expectedVersion,id:rightId,auth:otherToken} : {payload:left,version:p.body.expectedVersion,id:leftId,auth:token}
      const retry=await request(app).post(path).auth(loser.auth,{type:'bearer'}).send({...loser.payload,expectedVersion:loser.version,clientOperationId:loser.id})
      expect(retry.status).toBe(403)
      expect((await control.query("SELECT count(*)::int n FROM users WHERE id=ANY($1::text[]) AND is_active AND role='admin'",[[actor,other]])).rows[0].n).toBe(1)
    } finally {
      await control.query('UPDATE users SET is_active=true WHERE id=ANY($1::text[])',[disabled.rows.map(row=>row.id)])
      await control.query('DELETE FROM user_roles WHERE user_id=$1',[other]); await control.query('DELETE FROM users WHERE id=$1',[other])
    }
  })
  it('cleans department and group scopes on revoke and does not restore them on reassignment', async () => {
    await seedScopes()
    const input={targetUserId:target,action:{kind:'role.revoke',roleId:adminRole},admissionChanges:[]}
    const p=await request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(input)
    expect(p.status,JSON.stringify(p.body)).toBe(200)
    expect(p.body.impact.scopeCleanup.map((item:{kind:string})=>item.kind).sort()).toEqual(['department','member_group'])
    const done=await request(app).post(path).auth(token,{type:'bearer'}).send({...input,expectedVersion:p.body.expectedVersion,clientOperationId:randomUUID()})
    expect(done.status,JSON.stringify(done.body)).toBe(200)
    const assign={...input,action:{kind:'role.assign',roleId:adminRole}}
    const q=await request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(assign)
    expect(q.status).toBe(200)
    const reassigned=await request(app).post(path).auth(token,{type:'bearer'}).send({...assign,expectedVersion:q.body.expectedVersion,clientOperationId:randomUUID()})
    expect(reassigned.status,JSON.stringify(reassigned.body)).toBe(200)
    expect((await control.query('SELECT count(*)::int n FROM delegated_role_admin_scopes WHERE admin_user_id=$1',[target])).rows[0].n).toBe(0)
    expect((await control.query('SELECT count(*)::int n FROM delegated_role_admin_member_groups WHERE admin_user_id=$1',[target])).rows[0].n).toBe(0)
  })
  it('serializes concurrent same-key calls and rejects a different payload on retry', async () => {
    const p=await preview(); const id=randomUUID()
    const [a,b]=await Promise.all([commit(p.body.expectedVersion,id),commit(p.body.expectedVersion,id)])
    expect([a.status,b.status].filter(status=>status===200).length).toBeGreaterThanOrEqual(1)
    expect([a.status,b.status].every(status=>status===200 || status===409)).toBe(true)
    const replay=await commit(p.body.expectedVersion,id); expect(replay.status).toBe(200)
    const changed=await request(app).post(path).auth(token,{type:'bearer'}).send({...body,reason:'different',expectedVersion:p.body.expectedVersion,clientOperationId:id})
    expect(changed.status).toBe(409); expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
    expect((await control.query('SELECT count(*)::int n FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])).rows[0].n).toBe(1)
  })
  ;(process.env.PERMISSION_COMMAND_TEST_FAULT ? it : it.skip)('rolls back injected post-fence write failure on the same client', async () => {
    const fault=process.env.PERMISSION_COMMAND_TEST_FAULT
    const input=fault==='cleanup' ? {...body,action:{kind:'role.revoke',roleId:adminRole},admissionChanges:[]} : body
    if(fault==='cleanup') await seedScopes()
    const p=await request(app).post(`${path}/preview`).auth(token,{type:'bearer'}).send(input); expect(p.status).toBe(200)
    const seen:Array<{client:unknown,sql:string}>=[]
    const prototype=Client.prototype as unknown as {query:(...args:unknown[])=>unknown}, original=prototype.query
    prototype.query=function(this:unknown,...args:unknown[]) {
      const sql=typeof args[0]==='string' ? args[0] : (args[0] as {text?:unknown} | undefined)?.text
      if(typeof sql==='string') seen.push({client:this,sql})
      return original.apply(this,args)
    }
    const id=randomUUID()
    let done:{status:number}
    try { done=await request(app).post(path).auth(token,{type:'bearer'}).send({...input,expectedVersion:p.body.expectedVersion,clientOperationId:id}) }
    finally { prototype.query=original }
    expect(done.status).toBeGreaterThanOrEqual(500)
    const injection=seen.findIndex(row=>row.sql==='SELECT 1/0')
    expect(injection).toBeGreaterThan(0)
    const client=seen[injection].client, prior=seen.slice(0,injection).filter(row=>row.client===client).map(row=>row.sql).join('\n')
    expect(prior).toMatch(/LOCK TABLE[\s\S]*EXCLUSIVE MODE NOWAIT/i)
    if(fault==='cleanup') expect(prior).toMatch(/DELETE FROM delegated_role_admin_member_groups/i)
    else expect(prior).toMatch(/INSERT INTO user_roles/i)
    if(fault==='audit') expect(prior).toMatch(/INSERT INTO authorization_operation_receipts/i)
    expect((await control.query('SELECT count(*)::int n FROM user_roles WHERE user_id=$1 AND role_id=$2',[target,fault==='cleanup' ? adminRole : roleId])).rows[0].n).toBe(fault==='cleanup' ? 1 : 0)
    if(fault==='cleanup') {
      expect((await control.query('SELECT count(*)::int n FROM delegated_role_admin_scopes WHERE admin_user_id=$1',[target])).rows[0].n).toBe(1)
      expect((await control.query('SELECT count(*)::int n FROM delegated_role_admin_member_groups WHERE admin_user_id=$1',[target])).rows[0].n).toBe(1)
    }
    expect((await control.query('SELECT count(*)::int n FROM user_namespace_admissions WHERE user_id=$1',[target])).rows[0].n).toBe(0)
    expect((await control.query('SELECT count(*)::int n FROM authorization_operation_receipts WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])).rows[0].n).toBe(0)
    expect((await control.query('SELECT count(*)::int n FROM authorization_operation_audit WHERE actor_id=$1 AND client_operation_id=$2',[actor,id])).rows[0].n).toBe(0)
  })

  it('keeps real host HEAD, encoded receipt and ordinary-actor 403 paths read-only across the auth chain', async () => {
    const tables=['users','user_roles','user_permissions','user_namespace_admissions','delegated_role_admin_scopes','delegated_role_admin_member_groups','directory_deprovision_events','directory_deprovision_effects','authorization_operation_receipts','authorization_operation_audit','user_sessions','user_session_revocations']
    const snapshot=async()=>{
      const result:Record<string,string>={}
      for(const table of tables) {
        const rows=await control.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS snapshot FROM public."${table}" t`)
        result[table]=createHash('sha256').update(JSON.stringify(rows.rows[0].snapshot)).digest('hex')
      }
      return result
    }
    const before=await snapshot(), id=randomUUID(), encoded=`%${id.charCodeAt(0).toString(16)}${id.slice(1)}`
    const writes:string[]=[]
    const clientPrototype=Client.prototype as unknown as {query:(...args:unknown[])=>unknown}
    const original=clientPrototype.query
    clientPrototype.query=function(this:unknown,...args:unknown[]) {
      const text=typeof args[0] === 'string' ? args[0] : (args[0] as {text?:unknown} | undefined)?.text
      if (typeof text === 'string') {
        const sql=text.replace(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b/gi, 'FOR_LOCK')
        const match=sql.match(/\b(INSERT\s+INTO|UPDATE\s+[a-z_".]|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE|COPY\s+[a-z_".])/i)
        if(match) writes.push(match[1].split(/\s/)[0].toUpperCase())
      }
      return original.apply(this,args)
    }
    try {
      expect((await request(hostApp).head(`${path}/${id}`).auth(token,{type:'bearer'})).status).toBe(200)
      expect((await request(hostApp).get(`${path.toUpperCase()}/${encoded}/`).auth(token,{type:'bearer'})).body.status).toBe('unknown_or_pending')
      const plain=await request(hostApp).head(`${path}/${id}`).auth(ordinaryToken,{type:'bearer'})
      expect(plain.status).toBe(403)
      const escaped=await request(hostApp).get(`${path.toUpperCase()}/${encoded}/`).auth(ordinaryToken,{type:'bearer'})
      expect(escaped.status).toBe(403)
      const rejected=await request(hostApp).post(`${path}/preview`).auth(ordinaryToken,{type:'bearer'}).send(body)
      expect(rejected.status).toBe(403)
      const deniedCommit=await request(hostApp).post(path).auth(ordinaryToken,{type:'bearer'}).send({ ...body,clientOperationId:id,expectedVersion:`opaque-v1:${'a'.repeat(64)}` })
      expect(deniedCommit.status).toBe(403)
    } finally { clientPrototype.query=original }
    expect(writes).toEqual([])
    expect(await snapshot()).toEqual(before)
  })

})
