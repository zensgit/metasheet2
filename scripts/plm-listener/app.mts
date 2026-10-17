import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import net from 'node:net'
import { createHook } from 'node:async_hooks'
const timers = new Map<number,{ resource: any; stack: string }>()
const hook = createHook({ init(id,type,_trigger,resource) { if (type === 'Timeout') timers.set(id,{ resource,stack: new Error().stack || '' }) },destroy(id) { timers.delete(id) } }).enable()
const require = createRequire(import.meta.url)
const { MetaSheetServer } = require(process.env.W20_META_ROOT + '/packages/core-backend/src/index.ts')
const server = new MetaSheetServer({ port: 0,host: '127.0.0.1',pluginDirs: [] })
let address: { port: number; address: string } | undefined
let worker: any
let observer: any
const replayKey = 'w20-core-shutdown:synthetic-once'
const replayBody = { id: 'must-survive-stop' }
const result: Record<string,unknown> = { fullEntry: 'MetaSheetServer',mocked: false,success: false }
try {
  await server.start()
  address = server.getAddress()
  if (!address || !address.port) throw new Error('listener missing')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/plugins`)
  if (response.status !== 200) throw new Error('plugin endpoint status='+response.status)
  worker = (server as any).plmBomNotificationWorker
  if (!worker || worker.stopped || !worker.timer) throw new Error('real BOM worker was not running')
  const Redis = require(process.env.W20_META_ROOT + '/packages/core-backend/node_modules/ioredis').default
  observer = new Redis(process.env.REDIS_URL)
  await observer.ping()
  await new Promise(resolve => setTimeout(resolve,200))
  const { getActiveStore } = require(process.env.W20_META_ROOT + '/packages/core-backend/src/guards/idempotency.ts')
  await getActiveStore().set(replayKey,{ response: { statusCode: 201,body: replayBody },createdAt: new Date(),expiresAt: new Date(Date.now()+60000) },60)
  const before = await observer.get('idem:'+replayKey)
  if (!before || JSON.parse(before).response.body.id !== replayBody.id) throw new Error('real Redis replay entry missing before stop')
  result.redisReplayBefore = true
  result.workerRunning = true
  result.endpointStatus = response.status
} finally {
  await server.stop()
  if (observer) {
    const { getActiveStore } = require(process.env.W20_META_ROOT + '/packages/core-backend/src/guards/idempotency.ts')
    const replay = await getActiveStore().get(replayKey)
    result.postStopStoreRead = replay?.response?.body?.id === replayBody.id
    const after = await observer.get('idem:'+replayKey)
    result.redisReplayAfter = Boolean(after && JSON.parse(after).response.body.id === replayBody.id)
    await observer.quit()
  }
  result.workerStopped = Boolean(worker?.stopped && !worker?.timer)
  if (address) result.listenerClosed = await new Promise<boolean>(resolve => {
    const socket = net.connect(address!.port,'127.0.0.1')
    socket.once('connect',() => { socket.destroy(); resolve(false) })
    socket.once('error',() => resolve(true))
  })
  result.success = Boolean(result.workerRunning && result.workerStopped && result.listenerClosed)
  await new Promise(resolve => setTimeout(resolve,100))
  result.activeResources = process.getActiveResourcesInfo()
  result.referencedTimers = [...timers.values()].filter(t => !t.resource._destroyed && t.resource.hasRef()).map(t => ({ intervalMs: t.resource._repeat,timeoutMs: t.resource._idleTimeout,stack: t.stack }))
  result.activeSockets = (process as any)._getActiveHandles().filter((h: any) => h.remoteAddress).map((h: any) => ({ type: h.constructor.name,remoteAddress: h.remoteAddress,remotePort: h.remotePort }))
  hook.disable()
  await writeFile(process.env.W20_APP_RESULT!,JSON.stringify(result,null,2)+'\n')
}
if (!result.postStopStoreRead || !result.redisReplayBefore || !result.redisReplayAfter || (result.activeSockets as unknown[]).length || !result.success || (result.referencedTimers as unknown[]).length) throw new Error('application lifecycle not proven')
