/** Disposable PG process helper; controlled Native reply, real Meta ACL and transactions. */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { PlmBomReviewService } from '../../src/multitable/plm-bom-review-service'
import { managedRequestContext } from '../../src/services/plm-managed-request-context'
import { poolManager } from '../../src/integration/db/connection-pool'
const c=JSON.parse(readFileSync(process.argv[2],'utf8'))
const pool=new Pool({connectionString:process.env.PLM_CHANGE_READ_TEST_PG_URL,max:3})
async function barrier(){await new Promise<void>(resolve=>{process.stdin.once('data',()=>resolve());console.log('PLM_READ_CHILD_READY')})}
async function main(){
 try{
  if(c.hold){await pool.query('BEGIN');await pool.query('SELECT id FROM meta_plm_bom_change_read_retired_grants LIMIT 1');await barrier();await pool.query('COMMIT');console.log('PLM_READ_CHILD_RESULT='+JSON.stringify({status:200,pid:process.pid}));return}
  const tx={query:pool.query.bind(pool),async transaction(fn:any){const client=await pool.connect();try{await client.query('BEGIN');const value=await fn({query:client.query.bind(client)});await client.query('COMMIT');return value}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}}}
  const operations:string[]=[]
  const provider={async personalBomChangeReadRequest(_call:any,grant:string,a:any){if(c.poll){operations.push(_call.operation);if(c.barrier&&_call.operation==='page')await barrier();return _call.operation==='fact'?c.event:c.page;}await barrier();return{schema:'yuantus.plm-bom-change-read-binding.v1',grant_id:grant.split('_')[1],connection_id:a.connectionId,tenant_id:a.tenantId,org_id:a.orgId,auth_user_id:a.authUserId,expires_at:new Date(Date.now()+86400000).toISOString(),purpose:'bom_change_read',root_part_id:a.rootPartId,target:a.target,review_binding_id:a.reviewBindingId,review_binding_version:a.reviewBindingVersion,confirmed_scope:'bom_change_read.v1'}}}
  const service=new PlmBomReviewService({pool:tx,dataSourceManager:{getDataSource(){throw new Error('shared adapter forbidden')}},personalChangeReadProvider:()=>provider})
  if(c.poll){const result=await service.pollChanges(c.id);console.log('PLM_READ_CHILD_RESULT='+JSON.stringify({status:200,...result,operations,pid:process.pid}));return}
  const headers={origin:c.origin,'content-type':'application/json','x-plm-change-read':'bind'}
  const req={user:{id:c.actor},authenticatedTenantId:'meta-tenant',get:(name:string)=>(headers as any)[name.toLowerCase()]}as any
  try{await managedRequestContext.run({userId:c.actor,sessionId:c.session,conflict:false},()=>service.bindPersonalChangeRead(req,c.id,{grant:c.grant,expectedVersion:c.version}));console.log('PLM_READ_CHILD_RESULT='+JSON.stringify({status:201,pid:process.pid}))}
  catch(e:any){console.log('PLM_READ_CHILD_RESULT='+JSON.stringify({status:e.status??503,code:e.code??'UNEXPECTED',pid:process.pid}))}
 }finally{await pool.end();await poolManager.close()}
}
main().catch(()=>{console.error('OWNED_READ_CHILD_FAILED');process.exitCode=1})
