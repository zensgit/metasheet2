import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { PlmBomNotificationWorker } from '../../src/multitable/plm-bom-notification-worker'
const workers: PlmBomNotificationWorker[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('PRODUCT_MODE','plm-workbench')
  vi.stubEnv('PLM_BOM_REVIEW_ENABLED','true')
  vi.stubEnv('AUTOMATION_DURABLE_DELIVERY_ENABLED','true')
  vi.stubEnv('MULTITABLE_ENABLE_WRITER_FENCE','true')
})
afterEach(async () => { await Promise.all(workers.splice(0).map((w) => w.stop())); vi.useRealTimers(); vi.unstubAllEnvs() })
function fixture() {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT b.id') ? [{ id: 'binding' }]
    : sql.includes('meta_plm_bom_review_completion_events') ? [] : [{ id: 'event' }] }))
  const service = { pollChanges: vi.fn(async () => ({ state: 'inactive' })), scanNotifications: vi.fn(async () => ({ created: 0 })),
    prepareNotification: vi.fn(async () => ({ state: 'prepared' })),
    deliverNotification: vi.fn(async () => ({ state: 'delivered',inserted: 1 })),
    prepareCompletion: vi.fn(async (_eventId: string) => ({ state: 'prepared' })),deliverCompletion: vi.fn(async (_eventId: string) => ({ state: 'delivered' })) }
  const warn = vi.fn()
  const worker = new PlmBomNotificationWorker({ query,transaction: vi.fn() },service,warn)
  workers.push(worker)
  return { worker,query,service,warn }
}
describe('BOM notification background lifecycle', () => {
  it('revisits an eligible older retry while every completion page remains full',async () => {
    const { worker,query,service } = fixture()
    let page = 0
    query.mockImplementation(async (sql,params: unknown[] = []) => {
      if (sql.includes('SELECT b.id')) return { rows: [{ id: 'binding' }] }
      if (!sql.includes('meta_plm_bom_review_completion_events')) return { rows: [] }
      const rows = Array.from({ length: 50 },(_,i) => ({ id: `completion-${String(page*50+i).padStart(3,'0')}` }))
      // A cursor hides the now-due low id under sustained later arrivals; due-time paging does not.
      if (page++ && !params[1]) rows[0] = { id: 'completion-000' }
      return { rows }
    })
    service.deliverCompletion.mockResolvedValue({ state: 'prepared' })
    await worker.start(); await worker.tick(); await worker.tick()
    expect(service.deliverCompletion.mock.calls.filter(([id]) => id === 'completion-000')).toHaveLength(3)
  })
  it('does not admit completion HTTP after stop during preparation',async () => {
    const { worker,query,service } = fixture()
    query.mockImplementation(async sql => ({ rows: sql.includes('SELECT b.id') ? [{ id: 'binding' }]
      : sql.includes('meta_plm_bom_review_completion_events') ? [{ id: 'completion' }] : [] }))
    let resolve!: (value: { state: string }) => void
    service.prepareCompletion.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const start = worker.start()
    for (let i=0;i<20;i++) await Promise.resolve()
    expect(service.prepareCompletion).toHaveBeenCalledOnce()
    const stop = worker.stop(); resolve({ state: 'prepared' }); await Promise.all([start,stop])
    expect(service.deliverCompletion).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['false','TRUE','1',''])('BOM gate %s is inert before SQL',async (flag) => {
    vi.stubEnv('PLM_BOM_REVIEW_ENABLED',flag)
    const { worker,query,service } = fixture()
    await worker.start(); await vi.advanceTimersByTimeAsync(120000)
    expect(query).not.toHaveBeenCalled(); expect(service.scanNotifications).not.toHaveBeenCalled()
  })
  it.each([
    ['PRODUCT_MODE','attendance'], ['ENABLE_PLM','false'],
    ['AUTOMATION_DURABLE_DELIVERY_ENABLED','false'], ['MULTITABLE_ENABLE_WRITER_FENCE','false'],
  ])('prerequisite %s=%s is inert before SQL',async (key,value) => {
    vi.stubEnv(key,value)
    const { worker,query } = fixture()
    await worker.start(); await vi.advanceTimersByTimeAsync(60000)
    expect(query).not.toHaveBeenCalled()
  })
  it('advances bounded binding and event pages and wraps for unresolved events',async () => {
    const { worker,query,service } = fixture()
    const first = Array.from({ length: 50 },(_,i) => ({ id: `event-${String(i).padStart(2,'0')}` }))
    const bindingPages: unknown[] = [], eventPages: unknown[] = []
    query.mockImplementation(async (sql,params: unknown[] = []) => {
      if (sql.includes('SELECT b.id')) {
        bindingPages.push(params[0])
        return { rows: params[0] === null ? [{ id: 'binding' }] : [] }
      }
      if (sql.includes('meta_plm_bom_review_completion_events')) return { rows: [] }
      eventPages.push(params[1])
      return { rows: params[1] === null ? first : [{ id: 'event-50' }] }
    })
    service.prepareNotification.mockResolvedValue({ state: 'waiting' })
    await worker.start(); await worker.tick(); await worker.tick()
    expect(bindingPages).toEqual([null,'binding',null,'binding',null])
    expect(eventPages).toEqual([null,'event-49',null])
    expect(service.prepareNotification).toHaveBeenCalledTimes(101)
    expect(service.deliverNotification).not.toHaveBeenCalled()
  })
  it('starts an immediate pass, repeats every minute and stops its timer',async () => {
    const { worker,service } = fixture()
    await worker.start(); expect(service.deliverNotification).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60000); expect(service.deliverNotification).toHaveBeenCalledTimes(2)
    await worker.stop(); await vi.advanceTimersByTimeAsync(120000)
    expect(service.deliverNotification).toHaveBeenCalledTimes(2)
  })
  it('serializes overlapping ticks and drains without admitting another delivery after stop',async () => {
    const { worker,service } = fixture()
    let resolve!: (value: { created: number }) => void
    service.scanNotifications.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const start = worker.start()
    for (let i=0;i<10;i++) await Promise.resolve()
    expect(worker.tick()).toBe(worker.tick())
    expect(service.scanNotifications).toHaveBeenCalledOnce()
    const stopped = worker.stop(); resolve({ created: 0 }); await Promise.all([start,stopped])
    expect(service.prepareNotification).not.toHaveBeenCalled()
  })
  it('does not reopen admissions or leak timers when start races with stop draining initialization',async () => {
    const { worker,service } = fixture()
    let resolve!: (value: { created: number }) => void
    service.scanNotifications.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const initial = worker.start()
    for (let i=0;i<10;i++) await Promise.resolve()
    expect(service.scanNotifications).toHaveBeenCalledOnce()
    const stopping = worker.stop()
    const prematureRestart = worker.start()
    resolve({ created: 0 })
    await Promise.all([initial,stopping,prematureRestart])
    expect(service.prepareNotification).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    await worker.start()
    expect(service.deliverNotification).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    await worker.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retains failed delivery for a later pass and does not send waiting or cancelled intents',async () => {
    const { worker,service,warn } = fixture()
    service.deliverNotification.mockRejectedValueOnce(new Error('synthetic failure'))
    await worker.start(); expect(warn).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60000); expect(service.deliverNotification).toHaveBeenCalledTimes(2)
    service.prepareNotification.mockResolvedValueOnce({ state: 'waiting' })
    await worker.tick(); expect(service.deliverNotification).toHaveBeenCalledTimes(2)
    vi.stubEnv('AUTOMATION_DURABLE_DELIVERY_ENABLED','false')
    await worker.tick(); expect(service.scanNotifications).toHaveBeenCalledTimes(3)
  })
})
