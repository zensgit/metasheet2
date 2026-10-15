import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Disposable cross-process integration controller. Never use against an existing database.
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { createHmac, randomUUID } from 'node:crypto'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { PlmPersonalApprovalBindingService } from '../../src/services/PlmPersonalApprovalBindingService'
import { PlmPersonalApprovalError } from '../../src/services/plm-personal-approval-wire'
import { AutomationService } from '../../src/multitable/automation-service'
import { buildDurableConsumerHandlers } from '../../src/multitable/automation-durable-consumer-handlers'
import { eventBus } from '../../src/integration/events/event-bus'
import { executeDingTalkApprovalCardCallback } from '../../src/integrations/dingtalk/interactive-card-callback'
import { up as cards } from '../../src/db/migrations/zzzz20260705120000_create_dingtalk_approval_card_deliveries'
import { up as cardSend } from '../../src/db/migrations/zzzz20260705150100_add_send_columns_to_dingtalk_approval_card_deliveries'
import { up as cardIntegration } from '../../src/db/migrations/zzzz20260709133000_add_integration_id_to_dingtalk_approval_card_deliveries'
import { up as cardOutcome } from '../../src/db/migrations/zzzz20260710150000_add_outcome_unknown_delivery_status'
import { up as cardTaskIndex } from '../../src/db/migrations/zzzz20260710160000_add_task_id_index_to_dingtalk_approval_card_deliveries'
import { up as cardEpoch } from '../../src/db/migrations/zzzz20260711120000_add_entry_epoch_to_dingtalk_approval_card_deliveries'
import { up as outbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as personalCards } from '../../src/db/migrations/zzzz20261015040000_create_plm_personal_approval_cards'
const requireBackend = createRequire(new URL('../../package.json', import.meta.url))
const { Pool } = requireBackend('pg')
const { Kysely, PostgresDialect } = requireBackend('kysely')
if (!process.env.DATABASE_URL || !process.env.Y_BASE_URL || process.env.NODE_ENV !== 'test') throw new Error('disposable DATABASE_URL, Y_BASE_URL and NODE_ENV=test required')
const disposableUrl = new URL(process.env.DATABASE_URL)
const socketDirectory = disposableUrl.searchParams.get('host') || ''
if (disposableUrl.pathname !== '/w22_metasheet' || !/^\/tmp\/w22-crossstack-[^/]+\/s$/.test(socketDirectory)
  || !process.env.W22_DISPOSABLE_MARKER || readFileSync(join(socketDirectory, '..', '.owner'), 'utf8') !== process.env.W22_DISPOSABLE_MARKER) throw new Error('owned disposable database required')
const owner = 'm-personal-owner', corp = 'synthetic-corp', dingUser = 'synthetic-ding'
const connectionId = 'personal-fixture', linkSecret = 'synthetic-w22-card-link-secret'
Object.assign(process.env, {
  JWT_SECRET: 'synthetic-w22-crossstack-login-secret', RBAC_TOKEN_TRUST: 'false', DB_SSL: 'false',
  PLM_APPROVAL_CARD_ENABLED: 'true', PLM_APPROVAL_CARD_CONNECTION_ID: connectionId,
  AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true',
  ENCRYPTION_KEY: 'synthetic-w22-encryption-material', ENCRYPTION_SALT: 'synthetic-w22-salt',
  PUBLIC_APP_URL: 'https://synthetic.invalid', APPROVAL_CARD_LINK_SECRET: linkSecret,
  DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED: 'true', DINGTALK_INTERACTIVE_CARD_CLIENT_ID: 'synthetic-client',
  DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET: 'synthetic-secret', DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID: 'synthetic-template',
})
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
let integrationId = ''
if (process.env.W22_REUSE_DATABASE === 'true') {
  integrationId = (await pool.query("SELECT id FROM directory_integrations WHERE provider='dingtalk' AND corp_id=$1", [corp])).rows[0].id
} else {
  integrationId = randomUUID()
  const accountId = randomUUID()
// Synthetic predecessor identity/directory catalog; all relevant card and outbox DDL is real.
await pool.query(`CREATE TABLE users(id text PRIMARY KEY,is_active boolean,role text,activation_status text,local_password_set boolean,permissions text[]);
 CREATE TABLE roles(id text PRIMARY KEY,name text);
 CREATE TABLE user_roles(user_id text,role_id text);
 CREATE TABLE role_permissions(role_id text,permission_code text);
 CREATE TABLE user_permissions(user_id text,permission_code text);
 CREATE TABLE approval_instances(id text PRIMARY KEY);
 CREATE TABLE directory_integrations(id uuid PRIMARY KEY,provider text,corp_id text);
 CREATE TABLE directory_accounts(id uuid PRIMARY KEY,integration_id uuid,provider text,external_user_id text,is_active boolean,updated_at timestamptz,corp_id text);
 CREATE TABLE directory_account_links(directory_account_id uuid,local_user_id text,link_status text);`)
const { bootstrapPlmBomReviewAuthTestDb } = await import('../plm-bom-review/auth-bootstrap')
await bootstrapPlmBomReviewAuthTestDb(pool)
await pool.query("INSERT INTO users(id,is_active,role,activation_status,local_password_set,permissions,name,email) VALUES($1,true,'user','activated',true,'{}',$2,'owner@synthetic.invalid')",[owner,'Synthetic M owner'])
await pool.query("INSERT INTO user_permissions VALUES($1,'approvals:act')",[owner])
for (const migration of [cards, cardSend, cardIntegration, cardOutcome, cardTaskIndex, cardEpoch, outbox, personalCards]) await migration(db)
await pool.query("INSERT INTO directory_integrations VALUES($1,'dingtalk',$2)", [integrationId,corp])
await pool.query("INSERT INTO directory_accounts VALUES($1,$2,'dingtalk',$3,true,now(),$4)", [accountId,integrationId,dingUser,corp])
await pool.query("INSERT INTO directory_account_links VALUES($1,$2,'linked')", [accountId,owner])
}
process.env.DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID = integrationId
const config: Record<string,unknown> = {'plm.url':process.env.Y_BASE_URL,'plm.apiMode':'yuantus','plm.tenantId':'default','plm.orgId':'fixture-org'}
const silentLogger = {info(){},warn(){},error(){},debug(){}}
const adapter = new PLMAdapter({get:async(k:string)=>config[k]} as never, silentLogger as never)
await adapter.initializePersonalApproval()
let loseAck = false, platformDispatches = 0, bindingId = ''
const sourceCalls: Record<string,number> = {}, dingWire: unknown[] = [], cardUpdates: unknown[] = []
const raw = adapter.personalApprovalRequest.bind(adapter)
adapter.personalApprovalRequest = async (op, ...args) => {
  sourceCalls[op] = (sourceCalls[op] || 0) + 1
  const result = await raw(op,...args)
  if(op === 'command' && loseAck) { loseAck=false; throw new PlmPersonalApprovalError(503,'PLM_PROVIDER_UNAVAILABLE') }
  return result
}
const service = new PlmPersonalApprovalBindingService(pool,()=>adapter)
if (process.env.W22_REUSE_DATABASE === 'true') bindingId = (await pool.query('SELECT id FROM plm_personal_approval_bindings WHERE owner_id=$1 AND connection_id=$2',[owner,connectionId])).rows[0].id
const dingFetch: typeof globalThis.fetch = async (url,options) => {
 const parsed = new URL(String(url)), token = parsed.pathname.includes('gettoken')
 dingWire.push({path:parsed.pathname,method:options?.method??'GET',...(!token?{body:options?.body?JSON.parse(String(options.body)):null}:{})})
 return new Response(JSON.stringify(token?{errcode:0,access_token:'synthetic-access',expires_in:7200}:{success:true,result:{taskId:'synthetic-card-task',deliverResults:[{success:true}]}}),{status:200})
}
const automation = new AutomationService(eventBus,db,pool.query.bind(pool),dingFetch,null,{},undefined,service)
const noop=async()=>{}
const handlers=buildDurableConsumerHandlers({automationService:automation,projectionService:{reconcile:noop},webhookService:{deliverEvent:noop},recordApprovalService:{handleApprovalCompletion:noop},todoMirrorService:{handleApprovalTaskCreated:noop,handleApprovalCompletion:noop}})
const callbacks={query:pool.query.bind(pool),approvals:{dispatchAction:async()=>{platformDispatches++;throw new Error('platform dispatch forbidden')}},plmPersonalCards:service,cardUpdateSender:async (input: unknown)=>{cardUpdates.push(input)}}
const express = requireBackend('express')
const { authService } = requireBackend('./src/auth/AuthService.ts')
const { createPlmApprovalBindingsRouter } = requireBackend('./src/routes/plm-approval-bindings.ts')
const { approvalsRouter } = requireBackend('./src/routes/approvals.ts')
const loginToken = authService.createToken((await pool.query('SELECT * FROM users WHERE id=$1',[owner])).rows[0])
const app = express()
app.use(express.json())
app.use('/api/me/plm-approval-bindings', createPlmApprovalBindingsRouter(service))
app.use(approvalsRouter({ plmPersonalCards: service }))
const httpServer = app.listen(0, '127.0.0.1')
await new Promise<void>(resolve => httpServer.once('listening',resolve))
const base = `http://127.0.0.1:${httpServer.address().port}`
const receiverHttp: { method:string;path:string;status:number }[] = []
async function http(path: string, method: string, body?: unknown) {
 const response = await fetch(base+path,{method,headers:{Authorization:`Bearer ${loginToken}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
 receiverHttp.push({method,path,status:response.status})
 if(response.status===204)return null
 const payload=await response.json()
 if(!response.ok)throw Object.assign(new Error('receiver_http_refused'),{code:payload.error?.code,status:response.status})
 return payload.data
}
async function snapshot() {
 return {
  bindingId,sourceCalls:{...sourceCalls},platformDispatches,dingWire,cardUpdates,receiverHttp,
  bindings:(await pool.query('SELECT id,owner_id,connection_id,subject_id,tenant_id,org_id,grant_id,expires_at,encrypted_grant IS NOT NULL AS secret_present,generation FROM plm_personal_approval_bindings ORDER BY created_at,id')).rows,
  tasks:(await pool.query('SELECT id,binding_id,source_task_id,source_round_id,source_eco_id,source_stage_id,entry_epoch,active,seat_status FROM plm_personal_approval_tasks ORDER BY created_at,id')).rows,
  deliveries:(await pool.query('SELECT id,instance_id,plm_task_id,entry_epoch,recipient_user_id,send_status,card_state,acted_action,acted_by FROM dingtalk_approval_card_deliveries ORDER BY created_at,id')).rows,
  commands:(await pool.query('SELECT id,delivery_id,task_id,subject_id,connection_id,state,request_hash,receipt FROM plm_personal_approval_commands ORDER BY created_at,id')).rows,
  outbox:(await pool.query('SELECT event_id,event_type,payload FROM meta_automation_outbox ORDER BY created_at,event_id')).rows,
 }
}
async function operation(message: Record<string,any>) {
 const id = message.bindingId || bindingId
 switch(message.op) {
  case 'bind': { const result=await http('/api/me/plm-approval-bindings','POST',{connectionId,grant:message.grant});bindingId=result.id;return result }
  case 'sync': return http(`/api/me/plm-approval-bindings/${id}/sync`,'POST',{})
  case 'reconcile': return http(`/api/me/plm-approval-bindings/${id}/reconcile`,'POST',{})
  case 'unbind': await http(`/api/me/plm-approval-bindings/${id}`,'DELETE');return {unbound:true}
  case 'setLoseAck': loseAck=message.enabled===true;return {enabled:loseAck}
  case 'send': {
    const rows=(await pool.query(`SELECT o.* FROM meta_automation_outbox o JOIN plm_personal_approval_tasks t ON t.id::text=o.payload->'task'->>'plmTaskId'
      WHERE ($1::uuid IS NULL OR t.source_task_id=$1) AND ($2::text IS NULL OR o.event_id=$2) ORDER BY o.created_at,o.event_id`,[message.sourceTaskId??null,message.eventId??null])).rows
    const results=[]
    for(const row of rows) {
      try {await handlers['approval-task-trigger']({eventType:row.event_type,eventId:row.event_id,payload:row.payload,automationDepth:0} as never);results.push({eventId:row.event_id,ok:true})}
      catch(error){results.push({eventId:row.event_id,ok:false,code:(error as any)?.code||'DELIVERY_REFUSED'})}
    }
    return {results,dingFetchCount:dingWire.length}
  }
  case 'callback': return executeDingTalkApprovalCardCallback(callbacks,{outTrackId:message.deliveryId,action:'approve',operatorDingTalkUserId:message.operator||dingUser,eventCorpId:message.corp||corp})
  case 'decision': return {status:'ok',summary:await http(`/api/approval-card-deliveries/${message.deliveryId}/actions`,'POST',{t:createHmac('sha256',linkSecret).update(message.deliveryId).digest('hex').slice(0,32),decision:message.decision,comment:message.comment})}
  case 'authProbe': return {anonymous:(await fetch(base+'/api/me/plm-approval-bindings')).status,sourcePurpose:(await fetch(base+'/api/me/plm-approval-bindings',{headers:{Authorization:`Bearer ${message.grant}`}})).status}
  case 'snapshot': return snapshot()
  default: throw new Error('unknown_operation')
 }
}
console.log('W22_READY '+JSON.stringify({owner,connectionId,tenantId:'default',orgId:'fixture-org',integrationId}))
const lines=createInterface({input:process.stdin,crlfDelay:Infinity})
try {
 for await (const line of lines) {
  let message:Record<string,any>={}
  try {
   message=JSON.parse(line)
   if(message.op==='close'){console.log('W22_RESULT '+JSON.stringify({id:message.id,op:'close',ok:true}));break}
   const result=await operation(message)
   console.log('W22_RESULT '+JSON.stringify({id:message.id,op:message.op,ok:true,result}))
  } catch(error) {
   const e=error as {code?:string;status?:number}
   console.log('W22_RESULT '+JSON.stringify({id:message.id,op:message.op,ok:false,error:{code:e.code||'HARNESS_OPERATION_FAILED',status:e.status??null}}))
  }
 }
} finally {lines.close();httpServer.closeAllConnections();await new Promise<void>(resolve=>httpServer.close(()=>resolve()));await requireBackend('./src/integration/db/connection-pool.ts').poolManager.close();await requireBackend('./src/integration/messaging/message-bus.ts').messageBus.shutdown();await pool.end()}
