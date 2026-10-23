/** Actual Meta PostgreSQL permissions/persistence/locks. Native verification is controlled here;
 * separate paired Native HTTP proof must qualify end-to-end enrollment/listening. */
import { beforeAll, afterAll, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import type { Request } from 'express'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { bootstrapPlmBomReviewTestDb } from '../plm-bom-review/bootstrap'
import { shareSnapshot } from '../plm-bom-review/fixture'
import { up as managedUp } from '../../src/db/migrations/zzzz20261018010000_create_plm_managed_companion'
import { up as workerUp, down as workerDown } from '../../src/db/migrations/zzzz20261020020000_stop_personal_reads_on_unlink'
import { up, down } from '../../src/db/migrations/zzzz20261020010000_add_plm_listener_personal_reads'
import { PlmBomReviewService, type BomReviewPool } from '../../src/multitable/plm-bom-review-service'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import { sourceFingerprint } from '../../src/services/plm-managed-companion'
import { personalChangeReadManagementUrl, PlmPersonalChangeReadError, type PersonalChangeReadAuthority } from '../../src/services/plm-personal-bom-change-read-wire'
const url=process.env.PLM_CHANGE_READ_TEST_PG_URL
if(!url||url!==process.env.DATABASE_URL||!new URL(url).searchParams.get('host')?.startsWith('/tmp/plm-crpg-s-'))throw new Error('Explicit owned Unix-socket PostgreSQL URL required; no skip-green')
const pool=new Pool({connectionString:url,max:8})
const tx:BomReviewPool={query:pool.query.bind(pool),async transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn({query:c.query.bind(c)});await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}}
const db=new Kysely({dialect:new PostgresDialect({pool})})
const origin='http://127.0.0.1:9'
const reg={issuer:origin+'/installation',clientId:'listener-client',clientSecret:'owned-synthetic-client-secret',callback:origin+'/api/plm/managed-login/callback',origin,nativeTenantId:'t',nativeOrgId:'o',nativeBaseUrl:origin}
let onVerify:(()=>Promise<void>)|undefined,replyChange:Record<string,unknown>|undefined,revokeFailure=false,invalidRevokeAck=false,localRevokeRefusal=false,remoteRevokeRefusal=false
let readReply:((call:any,authority:PersonalChangeReadAuthority)=>Promise<unknown>)|undefined
const calls:{operation:string;authority:PersonalChangeReadAuthority}[]=[]
const provider={personalBomChangeReadManagementUrl:personalChangeReadManagementUrl,
 async personalBomChangeReadRequest(call:any,grant:string,authority:PersonalChangeReadAuthority){
  calls.push({operation:call.operation,authority:structuredClone(authority)})
  if(call.operation==='revoke'){if(remoteRevokeRefusal)throw new PlmPersonalChangeReadError(401,'REMOTE_REFUSAL',true);if(localRevokeRefusal)throw new PlmPersonalChangeReadError(403,'LOCAL_PREFLIGHT');if(revokeFailure)throw new Error('owned network loss');return invalidRevokeAck?{}:null}
  if(call.operation!=='verify' && readReply)return readReply(call,authority)
  if(onVerify)await onVerify()
  return{schema:'yuantus.plm-bom-change-read-binding.v1',grant_id:grant.split('_')[1],connection_id:authority.connectionId,
   tenant_id:authority.tenantId,org_id:authority.orgId,auth_user_id:authority.authUserId,expires_at:new Date(Date.now()+86400000).toISOString(),purpose:'bom_change_read',
   root_part_id:authority.rootPartId,target:authority.target,review_binding_id:authority.reviewBindingId,review_binding_version:authority.reviewBindingVersion,confirmed_scope:'bom_change_read.v1',...replyChange}
 }}
const snapshotAdapter={getBomShareContext:async()=>shareSnapshot()}
const service=new PlmBomReviewService({pool:tx,dataSourceManager:{getDataSource:()=>snapshotAdapter as never},personalChangeReadProvider:()=>provider})
beforeAll(async()=>{
 Object.assign(process.env,{PLM_MANAGED_COMPANION_ENABLED:'true',PLM_MANAGED_SNAPSHOT_SHARE_ENABLED:'false',PLM_PERSONAL_BOM_CHANGE_READ_ENABLED:'true',PLM_BOM_REVIEW_ENABLED:'true',AUTOMATION_DURABLE_DELIVERY_ENABLED:'true',MULTITABLE_ENABLE_WRITER_FENCE:'true',PLM_MANAGED_COMPANION_CLIENTS_JSON:JSON.stringify([reg]),ENCRYPTION_KEY:'owned-change-read-key-'+randomUUID(),ENCRYPTION_SALT:'owned-change-read-salt'})
 if(!(await pool.query("SELECT to_regclass('users') AS ready")).rows[0].ready){
  await bootstrapPlmBomReviewTestDb(pool)
  await pool.query('CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean);ALTER TABLE users ADD COLUMN must_change_password boolean DEFAULT false')
  await managedUp(db);await up(db)
 }
})
afterAll(async()=>{await pool.end()})
function grant(){return'yue_'+randomUUID().replaceAll('-','')+'_'+'s'.repeat(43)}
async function fixture(sessionSeconds=300){
 readReply=undefined;onVerify=undefined;replyChange=undefined;revokeFailure=false;invalidRevokeAck=false;localRevokeRefusal=false;remoteRevokeRefusal=false
 process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='true'
 const actor='owner-'+randomUUID(),source='source-'+randomUUID(),base='base-'+randomUUID(),link=randomUUID(),session=randomUUID(),intent=randomUUID()
 const config={connection:{url:origin,headers:{'x-tenant-id':'t','x-org-id':'o'}},options:{apiMode:'yuantus',tenantId:'t',orgId:'o',personalChangeReadConnectionId:'native-grant-connection'}}
 await pool.query("INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions)VALUES($1,true,'user','activated',true,'{}')",[actor])
 await pool.query("INSERT INTO user_orgs VALUES($1,'meta-tenant',true),($1,'meta-org',true);",[actor])
 await pool.query('INSERT INTO meta_bases(id,name,owner_id)VALUES($1,$2,$3)',[base,'Real target',actor])
 await pool.query("INSERT INTO data_sources(id,name,type,config,owner_id,is_active,tenant_id,workspace_id,scope_kind)VALUES($1,'Source','plm',$2::jsonb,$3,true,'meta-tenant','meta-org','user')",[source,JSON.stringify(config),actor])
 const preview=await service.preview(actor,{dataSourceId:source,partId:'P',baseId:base,name:'Review'})
 const binding=await service.create(actor,{previewId:preview.previewId,requestId:randomUUID()})
 const webhook=randomUUID();await pool.query("INSERT INTO user_permissions VALUES($1,'multitable:send_webhook');",[actor])
 await pool.query("INSERT INTO multitable_webhooks(id,name,url,created_by)VALUES($1,'Owned receiver','https://fixture.invalid/hook',$2)",[webhook,actor])
 await service.completionWebhooks(actor,binding.id,{expectedVersion:0,webhooks:{reviewCompleted:{enabled:false,webhookId:null,granularity:'bom'},plmChangeApplied:{enabled:true,webhookId:webhook,source:'bom_line_writeback'}}})
 const fp=sourceFingerprint({type:'plm',origin,ownerId:actor,rootPartId:'P',tenantId:'meta-tenant',workspaceId:'meta-org',scopeKind:'user'})
 await pool.query(`INSERT INTO plm_managed_identity_links(id,installation_issuer,native_auth_user_id,native_tenant_id,native_org_id,client_id,callback,meta_user_id,meta_tenant_id,meta_org_id,data_source_id,root_part_id,client_origin,generation,status,owner_user_id,created_by,source_fingerprint)
 VALUES($1,$2,'42','t','o',$3,$4,$5,'meta-tenant','meta-org',$6,'P',$7,1,'active',$5,$5,$8)`,[link,reg.issuer,reg.clientId,reg.callback,actor,source,origin,fp])
 await pool.query(`INSERT INTO plm_managed_browser_intents(id,link_id,generation,meta_user_id,meta_tenant_id,meta_org_id,data_source_id,root_part_id,client_origin,installation_issuer,native_tenant_id,native_org_id,callback,client_id,state_hash,nonce_hash,code_challenge,code_verifier_ciphertext,return_path,status,expires_at,consumed_at,delegation_id,credential_ciphertext)
 VALUES($1,$2,1,$3,'meta-tenant','meta-org',$4,'P',$5,$6,'t','o',$7,$8,$9,$9,$10,'enc:fixture','/plm/bom-review','consumed',now()+interval '5 minutes',now(),$11,'enc:read-fixture')`,[intent,link,actor,source,origin,reg.issuer,reg.callback,reg.clientId,'a'.repeat(64),'a'.repeat(43),'delegation-'+session])
 await pool.query("INSERT INTO plm_managed_source_bindings(data_source_id,link_id,generation,source_fingerprint,status,frozen_origin,frozen_root_part_id)VALUES($1,$2,1,$3,'active',$4,'P')",[source,link,fp,origin])
 await pool.query(`INSERT INTO plm_managed_sessions(id,intent_id,link_id,data_source_id,generation,delegation_id,credential_ciphertext,expires_at,scope,native_subject,native_tenant_id,native_org_id,meta_user_id,meta_tenant_id,meta_org_id,root_part_id,client_origin,installation_issuer,client_id)
 VALUES($1,$2,$3,$4,1,$5,'enc:read-fixture',now()+make_interval(secs => $10),'bom_review_read','42','t','o',$6,'meta-tenant','meta-org','P',$7,$8,$9)`,[session,intent,link,source,'delegation-'+session,actor,origin,reg.issuer,reg.clientId,sessionSeconds])
 const headers:Record<string,string>={origin,'content-type':'application/json','x-plm-change-read':'bind'}
 const req={user:{id:actor},authenticatedTenantId:'meta-tenant',get:(key:string)=>headers[key.toLowerCase()]}as unknown as Request
 const run=<T>(fn:()=>Promise<T>)=>managedRequestContext.run({userId:actor,sessionId:session,conflict:false},fn)
 const bind=(value=grant())=>run(()=>service.bindPersonalChangeRead(req,binding.id,{grant:value,expectedVersion:binding.version}))
 return{actor,source,base,binding,session,link,headers,req,run,bind}
}
it('reverses empty new migration without losing legacy listener columns',async()=>{
 await down(db);expect((await pool.query("SELECT to_regclass('meta_plm_bom_change_listeners') AS ready")).rows[0].ready).toBeTruthy();await up(db)
})
it('binds real target-owner ACL, encrypts independently and replays without resetting listener',async()=>{
 const f=await fixture(),secret=grant();const management:any=await f.run(()=>service.personalChangeReadManagement(f.req,f.binding.id))
 expect(management.url).toContain('#bom-change-read?request=')
 const first:any=await f.bind(secret);expect(first.bound).toBe(true)
 const row=(await pool.query('SELECT * FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0]
 expect(row.status).toBe('stopped');expect(row.encrypted_personal_read_grant).toMatch(/^enc:/);expect(JSON.stringify(row)).not.toContain(secret)
 expect(row.personal_read_authority.authority.authUserId).toBe('42');expect(row.personal_read_authority.authority.target.user_id).toBe(f.actor)
 const again:any=await f.bind(secret);expect(again.revision).toBe(first.revision)
})
it('refuses real target permission loss before network and after Native verification',async()=>{
 const f=await fixture(),before=calls.length
 await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:read' WHERE sheet_id=$1 AND subject_id=$2",[f.binding.sheetId,f.actor])
 await expect(f.bind()).rejects.toMatchObject({status:403});expect(calls.length).toBe(before)
 await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:admin' WHERE sheet_id=$1 AND subject_id=$2",[f.binding.sheetId,f.actor])
 onVerify=async()=>{await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:read' WHERE sheet_id=$1 AND subject_id=$2",[f.binding.sheetId,f.actor])}
 await expect(f.bind()).rejects.toMatchObject({status:403})
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(0)
})
it.each(['meta-tenant','meta-org'])('checks separate current Meta organization %s',async org=>{
 const f=await fixture(),before=calls.length;await pool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id=$2',[f.actor,org])
 await expect(f.bind()).rejects.toMatchObject({status:403});expect(calls.length).toBe(before)
})
it('refuses another Native subject and API-key enrollment without persisting',async()=>{
 const f=await fixture();replyChange={auth_user_id:f.actor}
 await expect(f.bind()).rejects.toMatchObject({status:502})
 ;(f.req as any).apiTokenId='api-key';const before=calls.length
 await expect(f.bind()).rejects.toMatchObject({status:401});expect(calls.length).toBe(before)
})
it('serializes concurrent enrollment and keeps one consented credential',async()=>{
 const f=await fixture();let release!:()=>void,seen=0;const ready=new Promise<void>(r=>release=r)
 onVerify=async()=>{if(++seen===2)release();await ready}
 const results=await Promise.allSettled([f.bind(),f.bind()])
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
 const rejected=results.find(r=>r.status==='rejected')as PromiseRejectedResult;expect(rejected.reason.status).toBe(409)
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(1)
})
it('freezes retired identity and clears local access even with remote revoke unavailable',async()=>{
 const f=await fixture();await f.bind();revokeFailure=true;await f.bind()
 f.headers['x-plm-change-read']='unbind';process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='false'
 expect(await service.unbindPersonalChangeRead(f.req,f.binding.id)).toMatchObject({pending:2})
 expect(await service.personalChangeReadState(f.req,f.binding.id)).toMatchObject({bound:false})
 const row=(await pool.query('SELECT * FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1 LIMIT 1',[f.binding.id])).rows[0]
 await expect(pool.query('UPDATE meta_plm_bom_change_read_retired_grants SET authority=$2::jsonb WHERE id=$1',[row.id,JSON.stringify({different:true})])).rejects.toThrow('identity_immutable')
 // Existing source may disappear or change; cleanup still uses only frozen Native authority.
 await pool.query("UPDATE data_sources SET owner_id='other',config='{}'::jsonb WHERE id=$1",[f.source])
 revokeFailure=false;expect(await service.retryPersonalReadRevocations(f.actor,f.binding.id)).toEqual({pending:0,rejected:0})
 const retired=(await pool.query('SELECT * FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1',[f.binding.id])).rows
 expect(retired.every(r=>r.state==='revoked'&&r.encrypted_grant===null)).toBe(true)
 expect(calls.filter(c=>c.operation==='revoke').every(c=>c.authority.authUserId==='42'&&c.authority.origin===origin)).toBe(true)
 await expect(down(db)).rejects.toThrow('authority_evidence_present')
})

it('does not decrypt or fall back to an unusable stored shared credential',async()=>{
 const f=await fixture()
 await pool.query(`UPDATE data_sources SET config=jsonb_set(config,'{credentials}','{"token":"enc:owned-invalid-shared-secret"}'::jsonb) WHERE id=$1`,[f.source])
 expect(await f.bind()).toMatchObject({bound:true})
})

function child(input:unknown){
 const root=mkdtempSync('/tmp/plm-read-enroll-child-'),config=root+'/input.json'
 writeFileSync(config,JSON.stringify(input),{mode:0o600})
 const require=createRequire(process.cwd()+'/package.json')
 const processChild=spawn(process.execPath,['--require',require.resolve('tsx/cjs'),'tests/plm-bom-review/change-read-enroll-worker.ts',config],{env:process.env,stdio:['pipe','pipe','pipe']})
 let resolveReady!:()=>void,result:any,stderr=''
 const ready=new Promise<void>(resolve=>{resolveReady=resolve})
 const lines=createInterface({input:processChild.stdout})
 lines.on('line',line=>{if(line==='PLM_READ_CHILD_READY')resolveReady();if(line.startsWith('PLM_READ_CHILD_RESULT='))result=JSON.parse(line.slice('PLM_READ_CHILD_RESULT='.length))})
 processChild.stderr.on('data',data=>{stderr+=data})
 const done=new Promise<any>((resolve,reject)=>{processChild.on('error',reject);processChild.on('close',code=>{
  lines.close();if(code===0&&result){rmSync(root,{recursive:true});resolve(result)}else{writeFileSync(root+'/stderr.log',stderr,{mode:0o600});reject(new Error('Owned child failed; retained '+root))}})})
 return{ready:Promise.race([ready,new Promise<void>((_,reject)=>setTimeout(()=>reject(new Error('Owned child readiness timeout')),10000).unref())]),
  release(){processChild.stdin.end('GO')},done,dispose(){if(processChild.exitCode===null){processChild.stdin.end('GO');setTimeout(()=>{if(processChild.exitCode===null)processChild.kill('SIGTERM')},5000).unref()}}}
}
it('uses two independent Node processes for enrollment CAS',async()=>{
 const f=await fixture(),input={actor:f.actor,session:f.session,id:f.binding.id,version:f.binding.version,origin}
 const a=child({...input,grant:grant()}),b=child({...input,grant:grant()})
 try{await Promise.all([a.ready,b.ready]);a.release();b.release();const results=await Promise.all([a.done,b.done]);expect(results.map(r=>r.status).sort()).toEqual([201,409]);expect(results[0].pid).not.toBe(results[1].pid)}finally{a.dispose();b.dispose()}
})
it('refuses downgrade while a separate process holds a retired-evidence reader',async()=>{
 const worker=child({hold:true})
 try{await worker.ready;await expect(down(db)).rejects.toMatchObject({code:'55P03'});worker.release();expect((await worker.done).status).toBe(200)}finally{worker.dispose()}
})
it('keeps uncertain revoke keys until the exact revoke acknowledgement and pins management URL',async()=>{
 const f=await fixture(),builder=provider.personalBomChangeReadManagementUrl
 provider.personalBomChangeReadManagementUrl=()=> 'https://foreign.invalid/'
 try{expect(new URL((await f.run(()=>service.personalChangeReadManagement(f.req,f.binding.id))).url).origin).toBe(origin)}finally{provider.personalBomChangeReadManagementUrl=builder}
 await f.bind();invalidRevokeAck=true;f.headers['x-plm-change-read']='unbind'
 expect(await service.unbindPersonalChangeRead(f.req,f.binding.id)).toMatchObject({pending:1})
 const retired=(await pool.query('SELECT * FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1',[f.binding.id])).rows[0]
 expect(retired.state).toBe('unknown');expect(retired.encrypted_grant).toMatch(/^enc:/)
 invalidRevokeAck=false;expect(await service.retryPersonalReadRevocations(f.actor,f.binding.id)).toEqual({pending:0,rejected:0})
})
it.each([{auth_user_id:'43'},{tenant_id:'meta-tenant'},{org_id:'meta-org'},{connection_id:'meta-source-id'}])('refuses structurally valid but wrong Native identity fields %j',async mismatch=>{
 const f=await fixture();replyChange=mismatch;await expect(f.bind()).rejects.toMatchObject({status:502})
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(0)
})
it('does not treat the Native tenant as an authenticated Meta tenant',async()=>{
 const f=await fixture(),before=calls.length;f.req.authenticatedTenantId='t'
 await expect(f.bind()).rejects.toMatchObject({status:403});expect(calls.length).toBe(before)
})

it('retains the frozen key after a local403 instead of declaring a remote rejection',async()=>{
 const f=await fixture();await f.bind();localRevokeRefusal=true;f.headers['x-plm-change-read']='unbind'
 expect(await service.unbindPersonalChangeRead(f.req,f.binding.id)).toMatchObject({pending:1})
 const row=(await pool.query('SELECT * FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1',[f.binding.id])).rows[0]
 expect(row.state).toBe('unknown');expect(row.encrypted_grant).toMatch(/^enc:/)
 localRevokeRefusal=false;expect(await service.retryPersonalReadRevocations(f.actor,f.binding.id)).toEqual({pending:0,rejected:0})
})

it('reports a received hard refusal as rejected without claiming remote revocation',async()=>{
 const f=await fixture();await f.bind();remoteRevokeRefusal=true;f.headers['x-plm-change-read']='unbind'
 expect(await service.unbindPersonalChangeRead(f.req,f.binding.id)).toEqual({pending:0,rejected:1})
 const row=(await pool.query('SELECT * FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1',[f.binding.id])).rows[0]
 expect(row.state).toBe('rejected');expect(row.encrypted_grant).toBeNull();expect(row.authority.authority.authUserId).toBe('42')
})
it('does not retire the current credential when only authority provenance changes',async()=>{
 const f=await fixture(),secret=grant();await f.bind(secret)
 await pool.query('UPDATE data_sources SET is_active=false WHERE id=$1',[f.source])
 await pool.query('UPDATE data_sources SET is_active=true WHERE id=$1',[f.source])
 const before=calls.filter(c=>c.operation==='revoke').length
 expect(await f.bind(secret)).toMatchObject({bound:true})
 expect(calls.filter(c=>c.operation==='revoke').length).toBe(before)
 expect((await pool.query('SELECT id FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(0)
})
it('rejects a retired replay while permitting a distinct fresh credential',async()=>{
 const f=await fixture(),old=grant();await f.bind(old);revokeFailure=true;f.headers['x-plm-change-read']='unbind'
 await service.unbindPersonalChangeRead(f.req,f.binding.id);f.headers['x-plm-change-read']='bind'
 await expect(f.bind(old)).rejects.toMatchObject({status:409,code:'PLM_CHANGE_READ_RETIRED_GRANT'})
 expect(await f.bind(grant())).toMatchObject({bound:true,pending:1})
})


async function personalListenerFixture(sessionSeconds=300){
 if (!(await pool.query("SELECT to_regprocedure('meta_plm_change_read_link_stopped()') IS NOT NULL AS ready")).rows[0].ready) await workerUp(db)
 const f=await fixture(sessionSeconds),yue=grant();await f.bind(yue)
 const event={schema:'yuantus.plm-change-event.v1',event_type:'bom.plm_change.applied',event_id:randomUUID(),
  binding_id:f.binding.id,binding_version:f.binding.version,source:{connection_id:f.source,tenant_id:'t',org_id:'o',part_id:'P'},
  change:{kind:'bom_line_writeback',audit_id:randomUUID(),bom_line_id:'RA1'},occurred_at:'2026-10-20T00:00:00.000000Z'}
 let head=5,include=false,awaitRead:(()=>Promise<void>)|undefined
 readReply=async(call,a)=>{
  if(awaitRead)await awaitRead()
  if(call.operation==='fact')return event
  return{schema:'yuantus.plm-change-page.v1',source:event.source,head_sequence:head,next_sequence:head,
   events:call.afterSequence===undefined||!include?[]:[{sequence:6,event}]}
 }
 return{...f,yue,event,setRead:(options:{head?:number;include?:boolean;awaitRead?:()=>Promise<void>})=>{head=options.head??head;include=options.include??include;awaitRead=options.awaitRead},
  start:()=>service.changeListener(f.actor,f.binding.id,{expectedVersion:f.binding.version},'meta-tenant')}
}
it('personal listener uses standing consent after browser expiry and skips all historical events',async()=>{
 const f=await personalListenerFixture(2)
 await new Promise(resolve=>setTimeout(resolve,2100))
 expect((await pool.query('SELECT expires_at<clock_timestamp() AS expired FROM plm_managed_sessions WHERE id=$1',[f.session])).rows[0].expired).toBe(true)
 expect(await f.start()).toMatchObject({status:'active',cursor:5})
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'active',cursor:5})
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(0)
 f.setRead({head:6,include:true})
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'active',cursor:6})
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(1)
 expect((await pool.query('SELECT * FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(1)
 f.setRead({include:false});expect(await service.pollChanges(f.binding.id)).toEqual({state:'active',cursor:6})
})
it.each(['false','TRUE','1',''])('personal listener read flag %s has no shared transport fallback',async flag=>{
 const f=await personalListenerFixture();await f.start();const before=calls.length
 process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED=flag
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'stopped'});expect(calls.length).toBe(before)
})
it('personal listener checks target permission after an empty page await',async()=>{
 const f=await personalListenerFixture();await f.start()
 f.setRead({awaitRead:async()=>{await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:read' WHERE sheet_id=$1 AND subject_id=$2",[f.binding.sheetId,f.actor])}})
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'stopped'})
 expect((await pool.query('SELECT cursor FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0].cursor).toBe('5')
})
it('personal listener refuses a revoked immutable Native identity link before any read',async()=>{
 const f=await personalListenerFixture();await f.start();const before=calls.length
 await expect(pool.query("UPDATE plm_managed_identity_links SET native_auth_user_id='777' WHERE id=$1",[f.link])).rejects.toThrow('link_immutable')
 await pool.query("UPDATE plm_managed_identity_links SET status='revoked',stopped_at=clock_timestamp(),stop_reason='revoked' WHERE id=$1",[f.link])
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'inactive'});expect(calls.length).toBe(before)
})
it('personal listener checks membership loss after fact verification without advancing inbox or cursor',async()=>{
 const f=await personalListenerFixture();await f.start();f.setRead({head:6,include:true})
 readReply=async(call,a)=>{
  if(call.operation==='fact'){await pool.query("UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id='meta-org'",[f.actor]);return f.event}
  return{schema:'yuantus.plm-change-page.v1',source:f.event.source,head_sequence:6,next_sequence:6,events:[{sequence:6,event:f.event}]}
 }
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'stopped'})
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(0)
 expect((await pool.query('SELECT cursor FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0].cursor).toBe('5')
})
it('personal listener start refuses source epoch change during fresh baseline',async()=>{
 const f=await personalListenerFixture()
 f.setRead({awaitRead:async()=>{await pool.query('UPDATE data_sources SET is_active=false WHERE id=$1',[f.source]);await pool.query('UPDATE data_sources SET is_active=true WHERE id=$1',[f.source])}})
 await expect(f.start()).rejects.toMatchObject({status:403})
 expect((await pool.query('SELECT status FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0].status).toBe('stopped')
})
it('personal listener refuses an expired standing grant before transport',async()=>{
 const f=await personalListenerFixture();await pool.query("UPDATE meta_plm_bom_change_listeners SET personal_read_expires_at=clock_timestamp()-interval '1 second' WHERE binding_id=$1",[f.binding.id])
 const before=calls.length;await expect(f.start()).rejects.toMatchObject({status:403});expect(calls.length).toBe(before)
})
it('personal stopped listener refuses a direct intake before any Native fact read',async()=>{
 const f=await personalListenerFixture(),before=calls.length
 await expect(service.receiveChange(f.actor,f.event)).rejects.toMatchObject({code:'LISTENER_STOPPED'});expect(calls.length).toBe(before)
})

it('personal listener unlink archives and clears credentials atomically before any worker tick',async()=>{
 const f=await personalListenerFixture();await f.start();const before=calls.length
 const client=await pool.connect()
 try{await client.query('BEGIN');await client.query("UPDATE plm_managed_identity_links SET status='revoked',stopped_at=clock_timestamp(),stop_reason='revoked' WHERE id=$1",[f.link]);await client.query('ROLLBACK')}finally{client.release()}
 expect((await pool.query('SELECT encrypted_personal_read_grant,status FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0]).toMatchObject({status:'active',encrypted_personal_read_grant:expect.stringMatching(/^enc:/)})
 await pool.query("UPDATE plm_managed_identity_links SET status='revoked',stopped_at=clock_timestamp(),stop_reason='revoked' WHERE id=$1",[f.link])
 expect((await pool.query('SELECT encrypted_personal_read_grant,status,stop_reason FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0]).toEqual({status:'stopped',encrypted_personal_read_grant:null,stop_reason:'LINK_REVOKED'})
 expect((await pool.query('SELECT state,encrypted_grant FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1',[f.binding.id])).rows).toMatchObject([{state:'pending',encrypted_grant:expect.stringMatching(/^enc:/)}])
 expect(calls.length).toBe(before)
 process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='false';revokeFailure=true
 expect(await service.retryPersonalReadRevocations(f.actor,f.binding.id)).toEqual({pending:1,rejected:0})
 revokeFailure=false;expect(await service.retryPersonalReadRevocations(f.actor,f.binding.id)).toEqual({pending:0,rejected:0})
 await expect(workerDown(db)).rejects.toThrow('authority_evidence_present')
})
it('personal listener concurrent starts preserve one fresh baseline generation',async()=>{
 const f=await personalListenerFixture();let release!:()=>void,seen=0;const gate=new Promise<void>(resolve=>{release=resolve})
 f.setRead({awaitRead:async()=>{if(++seen===2)release();await gate}})
 const results=await Promise.allSettled([f.start(),f.start()]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
 expect((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({status:409})
})
it('personal listener old empty-page completion cannot revive a replaced grant generation',async()=>{
 const f=await personalListenerFixture();await f.start();let replaced=false
 f.setRead({awaitRead:async()=>{if(!replaced){replaced=true;await f.bind()}}})
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'superseded'})
 expect((await pool.query('SELECT cursor,status FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0]).toEqual({cursor:'5',status:'stopped'})
})
it('personal listener in another Node process commits inbox cursor and existing completion event together',async()=>{
 const f=await personalListenerFixture();await f.start()
 const worker=child({poll:true,id:f.binding.id,event:f.event,page:{schema:'yuantus.plm-change-page.v1',source:f.event.source,head_sequence:6,next_sequence:6,events:[{sequence:6,event:f.event}]}})
 const result=await worker.done;expect(result).toMatchObject({status:200,state:'active',cursor:6});expect(result.pid).not.toBe(process.pid)
 expect((await pool.query('SELECT cursor FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0].cursor).toBe('6')
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(1)
 expect((await pool.query('SELECT * FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(1)
})

it('personal listener concurrent independent poll processes commit one fact and one completion',async()=>{
 const f=await personalListenerFixture();await f.start()
 const input={poll:true,barrier:true,id:f.binding.id,event:f.event,page:{schema:'yuantus.plm-change-page.v1',source:f.event.source,head_sequence:6,next_sequence:6,events:[{sequence:6,event:f.event}]}}
 const a=child(input),b=child(input);await Promise.all([a.ready,b.ready]);a.release();b.release()
 const results=await Promise.all([a.done,b.done]);expect(results[0].pid).not.toBe(results[1].pid)
 expect(results.filter(r=>r.state==='active')).toHaveLength(1)
 expect(results.filter(r=>r.state==='superseded')).toHaveLength(1)
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(1)
 expect((await pool.query('SELECT * FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(1)
})
it('personal listener rolls back inbox completion and cursor together after a cursor commit failure',async()=>{
 const f=await personalListenerFixture();await f.start();f.setRead({head:6,include:true})
 const failingPool:BomReviewPool={query:tx.query,transaction:fn=>tx.transaction(({query})=>fn({query:async(sql,params)=>{
  if(sql.includes('UPDATE meta_plm_bom_change_listeners SET cursor='))throw new Error('owned cursor fault')
  return query(sql,params)
 }}))}
 const failing=new PlmBomReviewService({pool:failingPool,dataSourceManager:{getDataSource(){throw new Error('shared source adapter forbidden')}},personalChangeReadProvider:()=>provider})
 expect(await failing.pollChanges(f.binding.id)).toEqual({state:'waiting'})
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(0)
 expect((await pool.query('SELECT * FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(0)
 expect((await pool.query('SELECT cursor FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0].cursor).toBe('5')
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'active',cursor:6})
})
it('personal listener stops after a received Native-revocation response without shared retry',async()=>{
 const f=await personalListenerFixture();await f.start();const before=calls.length
 readReply=async()=>{throw new PlmPersonalChangeReadError(401,'REMOTE_REVOKED',true)}
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'stopped'});expect(calls.length).toBe(before+1)
})
it('personal listener prepares existing completion delivery without a cached shared adapter',async()=>{
 const f=await personalListenerFixture();await f.start();f.setRead({head:6,include:true});await service.pollChanges(f.binding.id)
 const completion=(await pool.query('SELECT id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[f.binding.id])).rows[0]
 const isolated=new PlmBomReviewService({pool:tx,dataSourceManager:{getDataSource(){throw new Error('shared source adapter forbidden')}},personalChangeReadProvider:()=>provider})
 expect(await isolated.prepareCompletion(completion.id)).toMatchObject({state:'prepared'})
 await pool.query("UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id='meta-org'",[f.actor])
 expect(await isolated.deliverCompletion(completion.id)).toMatchObject({state:'cancelled'})
})

it('personal listener late page from a different process cannot commit after unlink',async()=>{
 const f=await personalListenerFixture();await f.start()
 const worker=child({poll:true,barrier:true,id:f.binding.id,event:f.event,page:{schema:'yuantus.plm-change-page.v1',source:f.event.source,head_sequence:6,next_sequence:6,events:[{sequence:6,event:f.event}]}})
 await worker.ready
 await pool.query("UPDATE plm_managed_identity_links SET status='revoked',stopped_at=clock_timestamp(),stop_reason='revoked' WHERE id=$1",[f.link])
 worker.release();expect(await worker.done).toMatchObject({state:'stopped'})
 expect((await pool.query('SELECT cursor,status,stop_reason,encrypted_personal_read_grant FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0]).toEqual({cursor:'5',status:'stopped',stop_reason:'LINK_REVOKED',encrypted_personal_read_grant:null})
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(0)
})
it('personal listener requires the unlink retirement migration before admitting a read',async()=>{
 const f=await personalListenerFixture(),before=calls.length
 const missing:BomReviewPool={query:tx.query,transaction:fn=>tx.transaction(({query})=>fn({query:async(sql,params)=>sql.includes("to_regprocedure('meta_plm_change_read_link_stopped()')")?{rows:[{ready:false}],rowCount:1}:query(sql,params)}))}
 const guarded=new PlmBomReviewService({pool:missing,dataSourceManager:{getDataSource(){throw new Error('shared source adapter forbidden')}},personalChangeReadProvider:()=>provider})
 await expect(guarded.changeListener(f.actor,f.binding.id,{expectedVersion:f.binding.version},'meta-tenant')).rejects.toMatchObject({code:'RUNTIME_UNAVAILABLE'});expect(calls.length).toBe(before)
})

it('personal listener activation refuses the wrong authenticated Meta tenant before Native baseline',async()=>{
 const f=await personalListenerFixture(),before=calls.length
 await expect(service.changeListener(f.actor,f.binding.id,{expectedVersion:f.binding.version},'foreign-meta-tenant')).rejects.toMatchObject({status:403})
 expect(calls.length).toBe(before)
})

it('personal listener browser start requires explicit Origin action and current target tenant',async()=>{
 const f=await personalListenerFixture(),before=calls.length
 await expect(f.run(()=>service.startPersonalChangeRead(f.req,f.binding.id,{expectedVersion:f.binding.version}))).rejects.toMatchObject({status:403})
 expect(calls.length).toBe(before)
 f.headers['x-plm-change-read']='start'
 expect(await f.run(()=>service.startPersonalChangeRead(f.req,f.binding.id,{expectedVersion:f.binding.version}))).toMatchObject({status:'active',cursor:5})
 await expect(service.changeListener(f.actor,f.binding.id,undefined,'foreign-meta-tenant')).rejects.toMatchObject({status:403})
 const status=await service.changeListener(f.actor,f.binding.id,undefined,'meta-tenant');expect(JSON.stringify(status)).not.toContain('personal_read_authority')
 await expect(service.receiveChange(f.actor,f.event,undefined,'foreign-meta-tenant')).rejects.toMatchObject({status:403})
})

it('personal listener drains the durable retired queue through the existing worker service with reads off',async()=>{
 const f=await personalListenerFixture();f.headers['x-plm-change-read']='unbind';revokeFailure=true
 expect(await service.unbindPersonalChangeRead(f.req,f.binding.id)).toEqual({pending:1,rejected:0})
 revokeFailure=false;process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='false'
 const groups=Number((await pool.query("SELECT count(DISTINCT binding_id) AS n FROM meta_plm_bom_change_read_retired_grants WHERE state IN ('pending','unknown')")).rows[0].n)
 for(let i=0;i<Math.ceil(groups/50)+1;i++)await service.drainPersonalReadRevocations()
 expect((await pool.query('SELECT state,encrypted_grant FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1',[f.binding.id])).rows).toEqual([{state:'revoked',encrypted_grant:null}])
})

it('personal read UI discovery uses current Meta target ACL without granting Native access',async()=>{
 const f=await fixture(),before=calls.length
 process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='false'
 expect(await f.run(()=>service.personalChangeReadTargets(f.req,f.source,'P'))).toEqual({items:[{id:f.binding.id,name:f.binding.name,version:f.binding.version,baseId:f.base,sheetId:f.binding.sheetId}]})
 expect(calls.length).toBe(before)
 await pool.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:read' WHERE sheet_id=$1 AND subject_id=$2",[f.binding.sheetId,f.actor])
 expect(await f.run(()=>service.personalChangeReadTargets(f.req,f.source,'P'))).toEqual({items:[]})
 ;(f.req as any).authenticatedTenantId='foreign-meta-tenant'
 await expect(f.run(()=>service.personalChangeReadTargets(f.req,f.source,'P'))).rejects.toMatchObject({status:403})
 ;(f.req as any).apiTokenId='api-key'
 await expect(f.run(()=>service.personalChangeReadTargets(f.req,f.source,'P'))).rejects.toMatchObject({status:401})
 expect(calls.length).toBe(before)
})
it('personal read UI discovery does not decrypt shared credentials or bypass separate Meta memberships',async()=>{
 const f=await fixture()
 await pool.query(`UPDATE data_sources SET config=jsonb_set(config,'{credentials}','{"token":"enc:owned-unusable-shared-credential"}'::jsonb) WHERE id=$1`,[f.source])
 expect((await f.run(()=>service.personalChangeReadTargets(f.req,f.source,'P'))).items).toHaveLength(1)
 await pool.query("UPDATE user_orgs SET is_active=false WHERE user_id=$1 AND org_id='meta-org'",[f.actor])
 await expect(f.run(()=>service.personalChangeReadTargets(f.req,f.source,'P'))).rejects.toMatchObject({status:403})
})

it('personal listener active start retry is idempotent and cannot skip newly unread changes',async()=>{
 const f=await personalListenerFixture();const first:any=await f.start();const before=calls.length
 f.setRead({head:6,include:true})
 expect(await f.start()).toEqual(first)
 expect(calls.length).toBe(before)
 expect(await service.pollChanges(f.binding.id)).toEqual({state:'active',cursor:6})
 expect((await pool.query('SELECT * FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toHaveLength(1)
})
// Controlled provider only. This is not end-to-end Native enrollment or listening proof.
it.each(['empty','nonempty'])('personal listener late %s page from a different process cannot commit after owner ABA before same-grant readmission',async shape=>{
 const f=await personalListenerFixture();await f.start()
 const epoch=async()=>(await pool.query('SELECT plm_bom_listener_authority_version AS v FROM data_sources WHERE id=$1',[f.source])).rows[0].v as string
 const ownerEpoch=(await pool.query('SELECT plm_bom_listener_authority_version AS v FROM users WHERE id=$1',[f.actor])).rows[0].v as string
 const opened=await epoch()
 const listener=async()=>(await pool.query('SELECT generation,cursor,status,stop_reason,personal_read_grant_id,personal_read_authority,encrypted_personal_read_grant FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0]
 const before=await listener()
 const records=async()=>(await pool.query('SELECT id,version,data FROM meta_records WHERE sheet_id=$1 ORDER BY id',[f.binding.sheetId])).rows
 const anchored=await records();expect(anchored.length).toBeGreaterThan(0)
 const target=async()=>(await pool.query('SELECT version,snapshot_hash FROM meta_plm_bom_review_bindings WHERE id=$1',[f.binding.id])).rows[0]
 const anchoredTarget=await target()
 const page=shape==='nonempty'
  ?{schema:'yuantus.plm-change-page.v1',source:f.event.source,head_sequence:6,next_sequence:6,events:[{sequence:6,event:f.event}]}
  :{schema:'yuantus.plm-change-page.v1',source:f.event.source,head_sequence:5,next_sequence:5,events:[]}
 const worker=child({poll:true,barrier:true,id:f.binding.id,event:f.event,page})
 const other='aba-'+randomUUID()
 try{
  await worker.ready
  await pool.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1',[f.source,other])
  const transferred=await epoch();expect(transferred).not.toBe(opened)
  expect(await listener()).toMatchObject({generation:before.generation,cursor:'5',status:'stopped',stop_reason:'SOURCE_CHANGED'})
  await pool.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1',[f.source,f.actor])
  const restored=await epoch();expect(restored).not.toBe(opened);expect(restored).not.toBe(transferred)
  expect((await pool.query('SELECT plm_bom_listener_authority_version AS v FROM users WHERE id=$1',[f.actor])).rows[0].v).toBe(ownerEpoch)
  worker.release();const result=await worker.done
  expect(result.pid).not.toBe(process.pid);expect(result).toMatchObject({status:200,state:'stopped',operations:['page']});expect(JSON.stringify(result)).not.toContain(f.yue)
  const stopped=await listener()
  expect(stopped).toMatchObject({generation:before.generation,cursor:'5',status:'stopped',stop_reason:'SOURCE_CHANGED',personal_read_grant_id:f.yue.split('_')[1]})
  expect(stopped.personal_read_authority.provenance.sourceAuthority).toBe(opened)
  expect(stopped.personal_read_authority.provenance.ownerAuthority).toBe(ownerEpoch)
  expect(stopped.encrypted_personal_read_grant).toMatch(/^enc:/);expect(JSON.stringify(stopped)).not.toContain(f.yue)
  expect((await pool.query('SELECT event_id FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toEqual([])
  expect((await pool.query('SELECT plm_event_id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[f.binding.id])).rows).toEqual([])
  expect(await records()).toEqual(anchored);expect(await target()).toEqual(anchoredTarget)
  const marked=calls.length
  expect(await service.pollChanges(f.binding.id)).toEqual({state:'inactive'})
  f.headers['x-plm-change-read']='start'
  await expect(f.run(()=>service.startPersonalChangeRead(f.req,f.binding.id,{expectedVersion:f.binding.version}))).rejects.toMatchObject({status:403,code:'PLM_CHANGE_READ_AUTHORITY_CHANGED'})
  expect(calls.length).toBe(marked);expect(await listener()).toMatchObject({generation:before.generation,cursor:'5',status:'stopped'})
  f.headers['x-plm-change-read']='bind'
  expect(await f.bind(f.yue)).toMatchObject({bound:true})
  const enrolled=await listener()
  expect(enrolled.generation).not.toBe(before.generation)
  expect(enrolled).toMatchObject({cursor:'5',status:'stopped',stop_reason:'GRANT_ENROLLED',personal_read_grant_id:f.yue.split('_')[1]})
  expect(enrolled.personal_read_authority.provenance.sourceAuthority).toBe(restored)
  expect(enrolled.personal_read_authority.provenance.ownerAuthority).toBe(ownerEpoch)
  expect(enrolled.encrypted_personal_read_grant).toMatch(/^enc:/);expect(JSON.stringify(enrolled)).not.toContain(f.yue)
  expect((await pool.query('SELECT id FROM meta_plm_bom_change_read_retired_grants WHERE binding_id=$1',[f.binding.id])).rows).toEqual([])
  f.setRead({head:8,include:true});f.headers['x-plm-change-read']='start';const atStart=calls.length
  const started:any=await f.run(()=>service.startPersonalChangeRead(f.req,f.binding.id,{expectedVersion:f.binding.version}))
  expect(calls.slice(atStart).map(call=>call.operation)).toEqual(['page'])
  expect(calls.at(-1)?.authority.authUserId).toBe('42');expect(calls.at(-1)?.authority.target.user_id).toBe(f.actor)
  expect(started).toMatchObject({status:'active',cursor:8,bindingVersion:f.binding.version})
  expect(started.generation).not.toBe(enrolled.generation)
  expect(await listener()).toMatchObject({generation:started.generation,cursor:'8',status:'active',stop_reason:null})
  expect((await pool.query('SELECT event_id FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toEqual([])
  const later={...f.event,event_id:randomUUID(),change:{...f.event.change,audit_id:randomUUID()}}
  const fact=child({poll:true,id:f.binding.id,event:later,page:{schema:'yuantus.plm-change-page.v1',source:f.event.source,head_sequence:9,next_sequence:9,events:[{sequence:9,event:later}]}})
  try{
   const committed=await fact.done
   expect(committed.pid).not.toBe(process.pid);expect(committed.pid).not.toBe(result.pid)
   expect(committed).toMatchObject({status:200,state:'active',cursor:9,operations:['page','fact']});expect(JSON.stringify(committed)).not.toContain(f.yue)
  }finally{fact.dispose()}
  expect((await pool.query('SELECT event_id FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toEqual([{event_id:later.event_id}])
  expect((await pool.query('SELECT plm_event_id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[f.binding.id])).rows).toEqual([{plm_event_id:later.event_id}])
  expect(await listener()).toMatchObject({generation:started.generation,cursor:'9',status:'active'})
  expect(await epoch()).toBe(restored);expect((await pool.query('SELECT plm_bom_listener_authority_version AS v FROM users WHERE id=$1',[f.actor])).rows[0].v).toBe(ownerEpoch)
  expect(await records()).toEqual(anchored);expect(await target()).toEqual(anchoredTarget)
 }finally{worker.dispose()}
})
it('personal listener current owner with a mismatched immutable Native and Meta link cannot reuse the prior authority',async()=>{
 const f=await personalListenerFixture();await f.start()
 const other='aba-'+randomUUID(),opened=(await pool.query('SELECT plm_bom_listener_authority_version AS v FROM data_sources WHERE id=$1',[f.source])).rows[0].v
 await pool.query("INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions)VALUES($1,true,'user','activated',true,'{}')",[other])
 await pool.query("INSERT INTO user_orgs VALUES($1,'meta-tenant',true),($1,'meta-org',true)",[other])
 await pool.query("INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code)VALUES($1,'user',$2,'spreadsheet:admin')",[f.binding.sheetId,other])
 await pool.query('UPDATE data_sources SET owner_id=$2 WHERE id=$1',[f.source,other])
 const moved=(await pool.query('SELECT owner_id,plm_bom_listener_authority_version AS v FROM data_sources WHERE id=$1',[f.source])).rows[0]
 expect(moved).toMatchObject({owner_id:other});expect(moved.v).not.toBe(opened)
 await expect(pool.query('UPDATE plm_managed_identity_links SET meta_user_id=$2 WHERE id=$1',[f.link,other])).rejects.toThrow('plm_managed_link_immutable')
 await expect(pool.query("UPDATE plm_managed_identity_links SET native_auth_user_id='777' WHERE id=$1",[f.link])).rejects.toThrow('plm_managed_link_immutable')
 expect((await pool.query('SELECT meta_user_id,native_auth_user_id,status FROM plm_managed_identity_links WHERE id=$1',[f.link])).rows[0]).toEqual({meta_user_id:f.actor,native_auth_user_id:'42',status:'active'})
 const marked=calls.length
 await expect(service.changeListener(other,f.binding.id,{expectedVersion:f.binding.version},'meta-tenant')).rejects.toMatchObject({status:403,code:'PLM_CHANGE_READ_IDENTITY_CHANGED'})
 expect(calls.length).toBe(marked)
 const row=(await pool.query('SELECT generation,cursor,status,stop_reason,encrypted_personal_read_grant,personal_read_authority FROM meta_plm_bom_change_listeners WHERE binding_id=$1',[f.binding.id])).rows[0]
 expect(row).toMatchObject({cursor:'5',status:'stopped',stop_reason:'SOURCE_CHANGED'})
 expect(row.encrypted_personal_read_grant).toMatch(/^enc:/)
 expect(row.personal_read_authority.authority.authUserId).toBe('42')
 expect(row.personal_read_authority.authority.target.user_id).toBe(f.actor)
 expect(JSON.stringify(row)).not.toContain(f.yue)
 expect((await pool.query('SELECT event_id FROM meta_plm_bom_change_inbox WHERE binding_id=$1',[f.binding.id])).rows).toEqual([])
 expect((await pool.query('SELECT plm_event_id FROM meta_plm_bom_review_completion_events WHERE binding_id=$1',[f.binding.id])).rows).toEqual([])
})
