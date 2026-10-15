// Real Node/tsx loader regression: synthetic 404 fetch + minimal transaction port, no live DB.
import { createRequire } from 'node:module'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { PlmPersonalApprovalBindingService } from '../../src/services/PlmPersonalApprovalBindingService'
import { PlmPersonalApprovalError } from '../../src/services/plm-personal-approval-wire'
import { encryptStoredSecretValue } from '../../src/security/encrypted-secrets'
const req=createRequire(new URL('../../package.json',import.meta.url))
const common=req('./src/services/plm-personal-approval-wire.ts')
Object.assign(process.env,{NODE_ENV:'test',PLM_APPROVAL_CARD_ENABLED:'true',PLM_APPROVAL_CARD_CONNECTION_ID:'fixed',ENCRYPTION_KEY:'synthetic-family-key',ENCRYPTION_SALT:'synthetic-salt'})
const conf={'plm.url':'https://synthetic.invalid','plm.apiMode':'yuantus','plm.tenantId':'t','plm.orgId':'o'}
const a=new PLMAdapter({get:async(k:string)=>conf[k as keyof typeof conf]} as never,{info(){},warn(){},error(){},debug(){}} as never)
await a.initializePersonalApproval()
const raw=a.personalApprovalRequest.bind(a)
let wireError:unknown
let calls=0
globalThis.fetch=async()=>{calls++;return new Response('{}',{status:404})}
a.personalApprovalRequest=async(...args)=>{try{return await raw(...args)}catch(e){wireError=e;throw e}}
const intent={id:'cmd',binding_id:'b',delivery_id:'d',subject_id:'42',tenant_id:'t',org_id:'o',connection_id:'fixed'}
const query=async(sql:string)=>{
 if(sql.includes('FROM plm_personal_approval_commands'))return{rows:[intent]}
 if(sql.includes('FROM users'))return{rows:[{id:'owner'}],rowCount:1}
 if(sql.includes('FROM plm_personal_approval_bindings'))return{rows:[{id:'b',owner_id:'owner',connection_id:'fixed',subject_id:'42',tenant_id:'t',org_id:'o',expires_at:'2099-01-01',encrypted_grant:encryptStoredSecretValue(`yua_${'a'.repeat(32)}_${'b'.repeat(43)}`)}]}
 if(sql.includes('FROM dingtalk_approval_card_deliveries'))return{rows:[{id:'d',plm_task_id:'task',instance_id:null,recipient_user_id:'owner'}]}
 if(sql.includes('FROM plm_personal_approval_tasks'))return{rows:[{id:'task'}]}
 return{rows:[]}
}
const service=new PlmPersonalApprovalBindingService({connect:async()=>({query,release(){}}),query} as never,()=>a)
let result:unknown
try{result={ok:true,value:await (service as any).resolveIntent('owner','cmd',false)}}catch(e){result={ok:false,status:(e as any)?.status,code:(e as any)?.code}}
console.log(JSON.stringify({result,calls,esmInstance:wireError instanceof PlmPersonalApprovalError,cjsInstance:wireError instanceof common.PlmPersonalApprovalError,classSame:PlmPersonalApprovalError===common.PlmPersonalApprovalError}))
process.exitCode=(result as any)?.value==='admissionRequired'?0:1
