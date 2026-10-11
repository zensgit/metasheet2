import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type ServerOptions } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createGuardedRecoveryArchiveAbandonedObjectStore, type RecoveryArchiveAbandonedObjectStore, type RecoveryArchiveDiscardRequest } from './recovery-archive-abandoned-object-store'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import {
  createTransactionGuardedRecoveryArchiveObjectStore, snapshotRecoveryArchiveObjectStoreId,
  validateRecoveryArchiveObjectPutRequest, type RecoveryArchiveObjectExpectedBinding,
  type RecoveryArchiveObjectDeleteExpiredRequest, type RecoveryArchiveObjectStoreProvider,
} from './recovery-archive-object-store'
import { decodeRecoveryResourceBase64, refuseRecoveryResourceIo } from './recovery-resource-https'

export function createRecoveryArchiveObjectServer(options: {
  provider: RecoveryArchiveObjectStoreProvider & RecoveryArchiveAbandonedObjectStore
  token: string
  cert: Uint8Array
  key: Uint8Array
  maxObjectBytes: number
  timeoutMs: number
  transactionDepth: RecoveryArchiveTransactionDepthProbe
}) {
  const { maxObjectBytes, timeoutMs } = options
  const storeId = snapshotRecoveryArchiveObjectStoreId(options.provider)
  if (!storeId || typeof options.token !== 'string' || !/^[!-~]{32,1024}$/.test(options.token)
    || !(options.cert instanceof Uint8Array) || !options.cert.length || options.cert.length > 65536
    || !(options.key instanceof Uint8Array) || !options.key.length || options.key.length > 16384
    || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > 256 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) refuseRecoveryResourceIo()
  const expectedToken = createHash('sha256').update(`Bearer ${options.token}`).digest()
  const object = createTransactionGuardedRecoveryArchiveObjectStore(options.provider, options.transactionDepth)
  const abandoned = createGuardedRecoveryArchiveAbandonedObjectStore(options.provider, options.transactionDepth)
  const wireLimit = Math.ceil(maxObjectBytes / 3) * 4 + 16384
  const active = new Set<Promise<void>>()
  let stopping = false, stopPromise: Promise<void> | undefined
  const verbs = ['put', 'get', 'head', 'pin', 'deleteExpired', 'discard', 'status']
  const error = (res: ServerResponse, status = 422) => {
    if (!res.destroyed && !res.writableEnded) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"code":"RECOVERY_ARCHIVE_RESOURCE_IO_REFUSED"}')
  }
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const timer = setTimeout(() => { req.destroy(); res.destroy() }, timeoutMs)
    try {
      const authorizationCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'authorization').length
      const auth = createHash('sha256').update(req.headers.authorization ?? '').digest()
      if (stopping || authorizationCount !== 1 || !timingSafeEqual(auth, expectedToken)) { error(res, 403); return }
      const verb = req.url?.slice(4)
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/') || !verb || !verbs.includes(verb)) { error(res, 404); return }
      if (req.headers['content-type'] !== 'application/json' || req.headers['content-encoding']) { error(res, 415); return }
      const chunks: Buffer[] = []; let length = 0
      for await (const chunk of req) {
        length += chunk.length
        if (length > wireLimit) { error(res, 413); return }
        chunks.push(Buffer.from(chunk))
      }
      if (req.aborted || res.destroyed) return
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      let result: unknown
      switch (verb) {
        case 'put': {
          if (!input || typeof input !== 'object' || Array.isArray(input) || !('bytes' in input)) refuseRecoveryResourceIo()
          result = await object.put(validateRecoveryArchiveObjectPutRequest({ ...input, bytes: decodeRecoveryResourceBase64(input.bytes, maxObjectBytes) }))
          break
        }
        case 'get': {
          const read = await object.get(input as RecoveryArchiveObjectExpectedBinding)
          result = { ...read, bytes: Buffer.from(read.bytes).toString('base64') }; break
        }
        case 'head': result = await object.head(input as RecoveryArchiveObjectExpectedBinding); break
        case 'pin': result = await object.pin(input as RecoveryArchiveObjectExpectedBinding); break
        case 'deleteExpired': result = await object.deleteExpired(input as RecoveryArchiveObjectDeleteExpiredRequest); break
        case 'discard': result = await abandoned.discard(input as RecoveryArchiveDiscardRequest); break
        case 'status': result = await abandoned.status(input as RecoveryArchiveDiscardRequest); break
      }
      if (res.destroyed) return
      const body = JSON.stringify({ storeId, result })
      if (Buffer.byteLength(body) > wireLimit) refuseRecoveryResourceIo()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body)
    } catch { error(res) }
    finally { clearTimeout(timer) }
  }
  const tls: ServerOptions = { cert: Buffer.from(options.cert), key: Buffer.from(options.key), minVersion: 'TLSv1.2', maxHeaderSize: 8192 }
  let server: ReturnType<typeof createServer>
  try {
    server = createServer(tls, (req, res) => {
      const pending = handle(req, res); active.add(pending)
      void pending.finally(() => active.delete(pending))
    })
  } catch { return refuseRecoveryResourceIo() }
  server.requestTimeout = timeoutMs
  server.headersTimeout = timeoutMs
  return Object.freeze({ server, stop(): Promise<void> {
    if (stopPromise) return stopPromise
    stopping = true
    stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RECOVERY_ARCHIVE_RESOURCE_IO_REFUSED')), 10000)
      server.close(() => {
        void Promise.allSettled([...active]).then(() => { clearTimeout(timer); resolve() })
      })
      server.closeIdleConnections()
    })
    return stopPromise
  } })
}
