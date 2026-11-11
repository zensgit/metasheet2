import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
async function main(){
const input=JSON.parse(await readFile('/dev/stdin','utf8'))
const root=input.metaCheckout+'/packages/core-backend'
const require=createRequire(root+'/package.json')
const express=require('express'),jwt=require('jsonwebtoken')
const {Pool}=require('pg'),{Kysely,PostgresDialect}=require('kysely')
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED,'0')
assert(new URL(input.pgUrl).searchParams.get('host')?.startsWith('/tmp/plm-bom-paired-'))
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:input.pgUrl,RBAC_TOKEN_TRUST:'true',JWT_SECRET:'paired-test-secret-abcdefghijklmnopqrstuvwxyz',PLM_PERSONAL_BOM_WRITE_ENABLED:'true',ENCRYPTION_KEY:'paired-private-synthetic-key',ENCRYPTION_SALT:'paired-private-synthetic-salt',LOG_LEVEL:'error',PLM_BASE_URL:input.origin,PLM_API_MODE:'yuantus',PLM_API_TOKEN:input.nativeJwt,PLM_TENANT_ID:'default',PLM_ORG_ID:'fixture-org'})
const pool=new Pool({connectionString:input.pgUrl,max:6})
const db=new Kysely({dialect:new PostgresDialect({pool})})
let appServer:any,manager:any,poolManager:any
const recorded:any[]=[];let credentials:string[]=[input.nativeJwt]
try {
 if(input.phase === 'line-unknown' || input.phase === 'browser'){
 await pool.query(`CREATE TABLE users(id text PRIMARY KEY,is_active boolean NOT NULL);
 CREATE TABLE user_orgs(user_id text NOT NULL,org_id text NOT NULL,is_active boolean NOT NULL,created_at timestamptz DEFAULT now(),PRIMARY KEY(user_id,org_id));
 CREATE TABLE data_sources(id text PRIMARY KEY,name text,owner_id text,workspace_id text,tenant_id text,scope_kind text,type text,config jsonb,is_active boolean,deleted_at timestamptz,auto_connect boolean DEFAULT false,status text,last_connected_at timestamptz,last_error text,updated_at timestamptz);
 CREATE TABLE operation_audit_logs(id bigserial PRIMARY KEY,actor_id text,actor_type text,action text,resource_type text,resource_id text,request_id text,ip text,user_agent text,route text,status_code integer,latency_ms integer,meta jsonb,occurred_at timestamptz,created_at timestamptz);`)
 const {up:upBindings}=await import(root+'/src/db/migrations/zzzz20261017010000_create_plm_personal_bom_write_bindings.ts')
 const {up:upIntents}=await import(root+'/src/db/migrations/zzzz20261017020000_create_plm_personal_bom_write_intents.ts')
 await upBindings(db);await upIntents(db)
 const config={connection:{url:input.origin,headers:{'x-tenant-id':'default','x-org-id':'fixture-org'}},options:{apiMode:'yuantus',tenantId:'default',orgId:'fixture-org'}}
 await pool.query("INSERT INTO users VALUES('meta-owner',true); INSERT INTO user_orgs VALUES('meta-owner','meta-a',true,now())")
 await pool.query("INSERT INTO data_sources(id,name,owner_id,workspace_id,tenant_id,scope_kind,type,config,is_active) VALUES('source-1','Paired source','meta-owner','workspace-1','meta-a','private','plm',$1,true)",[config])
 }
 const ds=await import(root+'/src/routes/data-sources.ts');manager=await ds.initializeDataSourceManager(db);await manager.connectDataSource('source-1')
 const adapter=manager.getDataSource('source-1')
 const {PlmPersonalBomWriteBindingService}=await import(root+'/src/services/PlmPersonalBomWriteBindingService.ts')
 const {bindPlmPersonalBomWriteService}=await import(root+'/src/services/plm-personal-bom-write-http.ts')
 const {PLMAdapter}=await import(root+'/src/data-adapters/PLMAdapter.ts')
 const {Logger}=await import(root+'/src/core/logger.ts')
 const provider=new PLMAdapter({get:async()=>undefined} as never,new Logger('PairedStaleProvider') as never,{id:'stale-provider',type:'plm',connection:{url:'https://stale-native.invalid',headers:{Authorization:'Bearer shared-must-not-be-used','x-tenant-id':'wrong-native-tenant','x-org-id':'wrong-native-org'}},options:{apiMode:'yuantus'}} as never)
 const service=new PlmPersonalBomWriteBindingService(pool,()=>provider);bindPlmPersonalBomWriteService(service)
 const {createPlmPersonalBomWriteBindingsRouter}=await import(root+'/src/routes/plm-personal-bom-write-bindings.ts')
 const {jwtAuthMiddleware}=await import(root+'/src/auth/jwt-middleware.ts')
 const workbench=(await import(root+'/src/routes/plm-workbench.ts')).default
 poolManager=(await import(root+'/src/integration/db/connection-pool.ts')).poolManager
 const app=express();app.use(express.json());app.use(jwtAuthMiddleware)
 app.use('/api/me/plm-bom-write-bindings',createPlmPersonalBomWriteBindingsRouter(service));app.use(workbench)
 appServer=await new Promise<any>(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))})
 const base='http://127.0.0.1:'+appServer.address().port
 function login(userId='meta-owner',tenantId='meta-a',role='user'){return jwt.sign({userId,tenantId,email:'paired@example.test',roles:[role],perms:['attendance:read'],role},process.env.JWT_SECRET,{expiresIn:'5m'})}
 const loginJwt=login();credentials.push(loginJwt)
 async function native(path:string,method='POST',body?:unknown){const r=await fetch(input.origin+path,{method,headers:{Authorization:'Bearer '+input.nativeJwt,'X-Tenant-Id':'default','X-Org-Id':'fixture-org',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json().catch(()=>null)}}
 async function meta(path:string,method='GET',body?:unknown,key?:string,bearer=loginJwt){const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+bearer,'x-tenant-id':'forged-header',...(key?{'Idempotency-Key':key}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const result={status:r.status,body:await r.json().catch(()=>null)};recorded.push(result);return result}
 async function issue(){const r=await native('/api/v1/auth/plm-bom-write-grants','POST',{label:'Paired write',connection_id:'personal-fixture'});assert.equal(r.status,201);assert(r.body.token.startsWith('yuw_'));credentials.push(r.body.token);return r.body}
 async function bind(g:any){const r=await meta('/api/me/plm-bom-write-bindings','POST',{dataSourceId:'source-1',connectionId:'personal-fixture',grant:g.token});assert.equal(r.status,201,JSON.stringify(r));assert.equal(r.body.data.ownerId,'meta-owner');assert.equal(r.body.data.subjectId,'42');assert.equal(r.body.data.metaTenantId,'meta-a');assert.equal(r.body.data.yuantusTenantId,'default');return r.body.data}
 const line='/api/plm-workbench/data-sources/source-1/bom-multitable/part/lines/line'
 const eco='/api/plm-workbench/data-sources/source-1/bom-multitable/locked-part/eco-intent'
 async function emit(controls:Record<string,unknown>){
  const intents=(await pool.query('SELECT operation_kind,outcome,saw_unknown,confirmed_response,request_body,provider_idempotency_key FROM plm_personal_bom_write_intents ORDER BY operation_kind')).rows
  const audits=(await pool.query('SELECT action,status_code,meta FROM operation_audit_logs')).rows
  const noSecrets=JSON.stringify({recorded,intents,audits});assert(credentials.every(secret=>!noSecrets.includes(secret)))
  console.log('PAIRED_PROOF '+JSON.stringify({phase:input.phase,meta_pid:process.pid,actual_meta_http:true,actual_native_http:true,fetch_mocked:false,personal_provider_cache:'deliberately stale origin/native tenant/org/shared header; real persisted source authority must win',read_adapter:'explicit ordinary connect with configured native read JWT; only yuw mutations permitted',auth_middleware:'actual signed JWT trusted-claims mode; current users/user_orgs checked by real service',meta_owner:'meta-owner',meta_tenant:'meta-a',native_subject:'42',native_tenant:'default',native_org:'fixture-org',...controls,intents:intents.map((r:any)=>({kind:r.operation_kind,outcome:r.outcome,saw_unknown:r.saw_unknown,key_sha256:createHash('sha256').update(r.provider_idempotency_key).digest('hex')})),audit_rows:audits.length,no_secret_echo:true}))
 }
 if(input.phase==='browser'){
  const nativeContext=await native('/api/v1/bom/multitable/part/context','GET')
  const metaContext=await meta('/api/plm-workbench/data-sources/source-1/bom-multitable/part/context')
  assert(metaContext.body?.context,JSON.stringify({native_status:nativeContext.status,native_entitled:nativeContext.body?.entitled,native_part:nativeContext.body?.context?.part,native_path_labels:nativeContext.body?.context?.lines?.map((r:any)=>r.path_labels),meta_response:metaContext}))
  const {verifyBrowser}=await import('./browser_check.mts')
  const grant=await issue()
  const browserProof=await verifyBrowser({metaCheckout:input.metaCheckout,metaBase:base,jwt:loginJwt,grant:grant.token,customerEntry:input.customerEntry===true,disableWrites:async()=>{
   process.env.PLM_PERSONAL_BOM_WRITE_ENABLED='false'
   assert.equal((await meta(line,'PATCH',{quantity:11},'disabled-negative')).status,404)
   assert.equal((await meta('/api/me/plm-bom-write-bindings')).status,200)
   assert.equal((await meta('/api/me/plm-bom-write-bindings/management-url?dataSourceId=source-1')).status,404)
  }})
  await emit({browser:browserProof})
  return
 }
 if(input.phase==='line-unknown'){
  assert.equal((await meta(line,'PATCH',{quantity:8},'outsider',login('other-owner','meta-a','admin'))).status,404)
  const grant=await issue();await bind(grant)
  const lost=await meta(line,'PATCH',{quantity:8},'line-operation');assert.equal(lost.status,503,JSON.stringify(lost))
  const changed=await meta(line,'PATCH',{quantity:9},'line-operation');assert.equal(changed.status,409);assert.equal(changed.body.reason,'frozen-context')
  await emit({lost_line_status:lost.status,changed_payload_refused:changed.status,nonowner_admin_refused:404})
  return
 }
 const persisted=(await pool.query('SELECT grant_id FROM plm_personal_bom_write_bindings WHERE owner_id=$1 AND data_source_id=$2',['meta-owner','source-1'])).rows
 assert.equal(persisted.length,1)
 const kind=input.phase==='eco-unknown'?'line':'eco-intent'
 const frozen=(await pool.query('SELECT outcome,saw_unknown,confirmed_response FROM plm_personal_bom_write_intents WHERE operation_kind=$1',[kind])).rows
 assert.equal(frozen.length,1);assert.equal(frozen[0].outcome,'unknown');assert.equal(frozen[0].saw_unknown,true);assert.equal(frozen[0].confirmed_response,null)
 assert.equal((await native('/api/v1/auth/plm-bom-write-grants/'+persisted[0].grant_id,'DELETE')).status,204)
 const denied=input.phase==='eco-unknown'
  ? await meta(line,'PATCH',{quantity:8},'line-operation')
  : await meta(eco,'POST',undefined,'eco-operation')
 assert.equal(denied.status,401,JSON.stringify(denied));assert.equal(denied.body.operation_may_have_applied,true);assert.equal(denied.body.retry_policy,'same-operation');assert(!('bom_line_id' in denied.body));assert(!('eco_id' in denied.body))
 const replacement=await issue();const binding=await bind(replacement)
 if(input.phase==='eco-unknown'){
  const recovered=await meta(line,'PATCH',{quantity:8},'line-operation');assert.equal(recovered.status,200,JSON.stringify(recovered));assert.deepEqual(recovered.body,{ok:true,bom_line_id:'line'})
  const lost=await meta(eco,'POST',undefined,'eco-operation');assert.equal(lost.status,503,JSON.stringify(lost))
  await emit({line_retry_denied:denied.status,line_recovered:recovered.status,lost_eco_status:lost.status,binding_rotation_same_person:true})
  return
 }
 assert.equal(input.phase,'complete')
 const recovered=await meta(eco,'POST',undefined,'eco-operation');assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(typeof recovered.body.eco_id,'string')
 const intents=(await pool.query('SELECT outcome,saw_unknown,confirmed_response FROM plm_personal_bom_write_intents')).rows
 assert.equal(intents.length,2);assert(intents.every((r:any)=>r.outcome==='accepted'&&r.saw_unknown&&r.confirmed_response))
 const metadata=await meta('/api/me/plm-bom-write-bindings');assert.equal(metadata.status,200)
 const wrongTenant=await meta(line,'PATCH',{quantity:8},'line-operation',login('meta-owner','wrong-meta'));assert.equal(wrongTenant.status,403)
 const unbound=await meta('/api/me/plm-bom-write-bindings/'+binding.id,'DELETE');assert.equal(unbound.status,200,JSON.stringify(unbound))
 const afterUnbind=await meta(line,'PATCH',{quantity:8},'line-operation');assert([403,404,409].includes(afterUnbind.status))
 const remaining=(await pool.query('SELECT encrypted_grant FROM plm_personal_bom_write_bindings UNION ALL SELECT encrypted_grant FROM plm_personal_bom_write_retired_grants')).rows
 assert(remaining.every((row:any)=>row.encrypted_grant===null))
 await emit({eco_retry_denied:denied.status,eco_recovered:recovered.status,wrong_meta_tenant_refused:wrongTenant.status,after_unbind:afterUnbind.status,binding_rotation_same_person:true,all_binding_secrets_cleared:true})
} finally {
 if(appServer){appServer.closeIdleConnections();await new Promise<void>(resolve=>appServer.close(()=>resolve()))}
 if(manager)await manager.disconnectAll()
 await db.destroy();if(poolManager)await poolManager.close()
}

}
main().then(()=>process.exit(0),(error)=>{console.error(error);process.exit(1)})
