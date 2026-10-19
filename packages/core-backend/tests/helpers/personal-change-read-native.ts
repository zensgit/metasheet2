/** Real provider HTTP companion for verify-plm-personal-change-read-native.py. */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
const input=JSON.parse(readFileSync(0,'utf8'))
const client=new PLMAdapter({get:async()=>undefined} as never,{info(){},warn(){},error(){},debug(){}} as never,
  {id:'unused-cache',name:'unused-cache',type:'plm',connection:{url:'https://foreign-cache.invalid',headers:{Authorization:'Bearer shared-account'}},credentials:{password:'shared-secret'},options:{apiMode:'yuantus'}} as never)
const actualFetch=globalThis.fetch
let calls=0
let personalOnly=true
// Observe outgoing requests, but forward every response unchanged from the real provider.
globalThis.fetch=async (url,init)=>{
 calls++;const headers=new Headers(init?.headers)
 personalOnly&&=headers.get('authorization')===`Bearer ${input.grant}`
  &&String(url).startsWith(input.authority.origin+'/api/v1/plm-bom-change-read-grant/')
  &&!JSON.stringify(init).includes('shared-account')&&!JSON.stringify(init).includes('shared-secret')
 return actualFetch(url,init)
}
async function main(){
 if(input.revoke){
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='false'
  assert.equal(await client.personalBomChangeReadRequest({operation:'revoke'},input.grant,input.authority),null)
  process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='true'
  await assert.rejects(()=>client.personalBomChangeReadRequest({operation:'verify'},input.grant,input.authority),(e:any)=>e.status===401)
  console.log('PLM_PERSONAL_CHANGE_READ_PROOF='+JSON.stringify({passed:true,phase:'revoke',calls,personalOnly,redirectOrRetry:false}));return
 }
 process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED='true'
 const verified:any=await client.personalBomChangeReadRequest({operation:'verify'},input.grant,input.authority)
 assert.equal(verified.auth_user_id,'42');assert.equal(verified.target.user_id,'meta-user')
 const baseline:any=await client.personalBomChangeReadRequest({operation:'page'},input.grant,input.authority)
 assert.equal(baseline.events.length,0);assert.equal(baseline.next_sequence,1)
 const page:any=await client.personalBomChangeReadRequest({operation:'page',afterSequence:0},input.grant,input.authority)
 assert.equal(page.events.length,1);assert.equal(page.events[0].event.event_id,input.eventId)
 const fact:any=await client.personalBomChangeReadRequest({operation:'fact',eventId:input.eventId},input.grant,input.authority)
 assert.equal(fact.source.connection_id,input.authority.target.source_id)
 for(const changed of [{authUserId:'43'},{target:{...input.authority.target,user_id:'foreign-meta-user'}}])
  await assert.rejects(()=>client.personalBomChangeReadRequest({operation:'verify'},input.grant,{...input.authority,...changed}),(e:any)=>e.status===502)
 await assert.rejects(()=>client.personalBomChangeReadRequest({operation:'page'},input.grant,{...input.authority,tenantId:'foreign'}),(e:any)=>e.status===403)
 const before=calls
 for(const prefix of ['yua','yuw','yur'])
  await assert.rejects(()=>client.personalBomChangeReadRequest({operation:'verify'},input.grant.replace('yue_',prefix+'_'),input.authority),(e:any)=>e.status===403)
 assert.equal(calls,before);assert.equal(personalOnly,true)
 console.log('PLM_PERSONAL_CHANGE_READ_PROOF='+JSON.stringify({passed:true,phase:'reads',calls,personalOnly,baselineNoHistory:true,committedFact:true,
  frozenNativeIdentity:true,exactMetaTarget:true,noCrossPurposeNetwork:true,interceptedResponses:false}))
}
main().catch(()=>{console.error('PERSONAL_CHANGE_READ_NATIVE_VERIFICATION_FAILED');process.exitCode=1})
