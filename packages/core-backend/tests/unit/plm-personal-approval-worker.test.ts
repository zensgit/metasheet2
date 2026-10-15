import { afterEach,describe,it,expect,vi } from 'vitest'
import { PlmPersonalApprovalWorker } from '../../src/services/PlmPersonalApprovalWorker'
afterEach(()=>vi.unstubAllEnvs())
describe('bounded personal PLM polling lifecycle',()=>{
 it('shares one in-flight tick and drains it without starting another binding after stop',async()=>{
  vi.stubEnv('PLM_APPROVAL_CARD_ENABLED','true')
  let unblock!:()=>void,entered!:()=>void
  const enteredPromise=new Promise<void>(r=>{entered=r}),barrier=new Promise<void>(r=>{unblock=r})
  const service={pool:{query:vi.fn().mockResolvedValue({rows:[{id:'a',owner_id:'owner-a'},{id:'b',owner_id:'owner-b'}]})},reconcile:vi.fn(async()=>{entered();await barrier;return{pending:0}}),sync:vi.fn()}
  const worker=new PlmPersonalApprovalWorker(service as never),tick=worker.tick();expect(worker.tick()).toBe(tick);await enteredPromise
  let stopped=false;const stopping=worker.stop().then(()=>{stopped=true});await Promise.resolve();expect(stopped).toBe(false);unblock();await stopping;await tick
  expect(service.reconcile).toHaveBeenCalledTimes(1);expect(service.sync).not.toHaveBeenCalled();expect(await worker.tick()).toBe(0)
 })
 it('advances finite pages fairly after a binding failure and resets at the end',async()=>{
  vi.stubEnv('PLM_APPROVAL_CARD_ENABLED','true')
  const rows=Array.from({length:25},(_,i)=>({id:`id-${String(i).padStart(2,'0')}`,owner_id:`owner-${i}`}))
  const service={pool:{query:vi.fn().mockResolvedValueOnce({rows}).mockResolvedValue({rows:[]})},reconcile:vi.fn().mockRejectedValueOnce(new Error('sensitive-token-must-not-be-logged')).mockResolvedValue({pending:0}),sync:vi.fn()}
  const worker=new PlmPersonalApprovalWorker(service as never);expect(await worker.tick()).toBe(24);await worker.tick();expect(service.pool.query.mock.calls[1][1]).toEqual(['id-24']);await worker.tick();expect(service.pool.query.mock.calls[2][1]).toEqual(['']);await worker.stop()
 })
})
