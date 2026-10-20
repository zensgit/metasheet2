/** Real HTTP audit serialization; auth and enrollment are stubbed, not ACL proof. */
import { afterEach, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
vi.mock('../../src/middleware/auth',()=>({authenticate:(req:any,res:any,next:any)=>{
 if(req.headers.authorization==='deny')return res.status(401).json({error:'unauthorized'})
 req.user={id:'owner'};next()
}}))
import { AuditService } from '../../src/audit/AuditService'
import { createPlmBomReviewsRouter } from '../../src/routes/plm-bom-reviews'
import { PlmBomReviewService } from '../../src/multitable/plm-bom-review-service'
const pinned=usePinnedServer()
afterEach(()=>vi.restoreAllMocks())
it.each([false,true])('never audits a raw grant on success or authentication refusal: denied=%s',async denied=>{
 const captured:any[]=[]
 const audit=new AuditService({createAuditLog:async(data:any)=>{captured.push(data)}}as never,{enableMessageBus:false})
 const spy=vi.spyOn(PlmBomReviewService.prototype,'bindPersonalChangeRead').mockResolvedValue({bound:true}as never)
 const app=express();app.use(express.json());app.use(audit.middleware())
 app.use('/api/plm-bom-reviews',createPlmBomReviewsRouter({pool:{query:vi.fn(),transaction:vi.fn()},dataSourceManager:{}as never}))
 pinned.setApp(app)
 const secret=`yue_${'a'.repeat(32)}_${'b'.repeat(43)}`
 const response=await request(pinned.url()).post('/api/plm-bom-reviews/'+crypto.randomUUID()+'/personal-change-read')
  .set('Authorization',denied?'deny':'Bearer meta-session').send({grant:secret,expectedVersion:1})
 expect(response.status).toBe(denied?401:201)
 expect(response.headers['cache-control']).toBe('no-store')
 await vi.waitFor(()=>expect(captured.length).toBe(1))
 expect(JSON.stringify(captured)).not.toContain(secret)
 expect(captured[0].requestBody.grant).toBe('[REDACTED]')
 if(denied)expect(spy).not.toHaveBeenCalled()
 else expect(spy.mock.calls[0][2]).toEqual({grant:secret,expectedVersion:1})
})

it('routes explicit personal start through managed authentication before the normal bearer gate',async()=>{
 const spy=vi.spyOn(PlmBomReviewService.prototype,'startPersonalChangeRead').mockResolvedValue({status:'active'}as never)
 const app=express();app.use(express.json());app.use('/api/plm-bom-reviews',createPlmBomReviewsRouter({pool:{query:vi.fn(),transaction:vi.fn()},dataSourceManager:{}as never}));pinned.setApp(app)
 const id=crypto.randomUUID(),response=await request(pinned.url()).post('/api/plm-bom-reviews/'+id+'/personal-change-read/start').send({expectedVersion:1})
 expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['referrer-policy']).toBe('no-referrer')
 expect(spy).toHaveBeenCalledWith(expect.objectContaining({user:{id:'owner'}}),id,{expectedVersion:1})
})

it('routes personal target discovery before the bearer gate, validates unique source/root and preserves no-store on denial',async()=>{
 const spy=vi.spyOn(PlmBomReviewService.prototype,'personalChangeReadTargets').mockResolvedValue({items:[]}as never)
 const app=express();app.use(express.json());app.use('/api/plm-bom-reviews',createPlmBomReviewsRouter({pool:{query:vi.fn(),transaction:vi.fn()},dataSourceManager:{}as never}));pinned.setApp(app)
 const path='/api/plm-bom-reviews/managed-change-read/targets?dataSourceId=source&partId=P'
 const response=await request(pinned.url()).get(path)
 expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(spy).toHaveBeenCalledWith(expect.objectContaining({user:{id:'owner'}}),'source','P')
 spy.mockClear();await request(pinned.url()).get(path+'&partId=Q').expect(400);expect(spy).not.toHaveBeenCalled()
 const denied=await request(pinned.url()).get(path).set('Authorization','deny');expect(denied.status).toBe(401);expect(denied.headers['cache-control']).toBe('no-store')
})
