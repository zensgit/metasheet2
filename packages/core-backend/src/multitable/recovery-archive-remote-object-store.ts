import { createGuardedRecoveryArchiveAbandonedObjectStore, type RecoveryArchiveAbandonedObjectStore } from './recovery-archive-abandoned-object-store'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import {
  createTransactionGuardedRecoveryArchiveObjectStore,
  snapshotRecoveryArchiveObjectStoreId,
  type RecoveryArchiveObjectReadResult,
  type RecoveryArchiveObjectStoreProvider,
} from './recovery-archive-object-store'
import { createRecoveryResourceHttps, decodeRecoveryResourceBase64, refuseRecoveryResourceIo, type RecoveryResourceHttpsOptions } from './recovery-resource-https'

export interface RecoveryArchiveRemoteObjectOptions extends RecoveryResourceHttpsOptions {
  storeId: string
  maxObjectBytes: number
  transactionDepth: RecoveryArchiveTransactionDepthProbe
}
export function createRecoveryArchiveRemoteObjectStore(options: RecoveryArchiveRemoteObjectOptions): RecoveryArchiveObjectStoreProvider & RecoveryArchiveAbandonedObjectStore {
  const { storeId, maxObjectBytes, transactionDepth } = options
  if (snapshotRecoveryArchiveObjectStoreId({ storeId }) !== storeId || !storeId
    || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > 256 * 1024 * 1024) refuseRecoveryResourceIo()
  const limit = Math.ceil(maxObjectBytes / 3) * 4 + 16384
  const post = createRecoveryResourceHttps({ ...options, maxRequestBytes: limit, maxResponseBytes: limit }, 'authorization')
  const call = async (verb: string, input: unknown): Promise<unknown> => {
    const envelope = await post(`/v1/${verb}`, input)
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || Object.keys(envelope).sort().join(',') !== 'result,storeId'
      || !('storeId' in envelope) || envelope.storeId !== storeId || !('result' in envelope)) refuseRecoveryResourceIo()
    return envelope.result
  }
  const raw: RecoveryArchiveObjectStoreProvider & RecoveryArchiveAbandonedObjectStore = {
    async put(request) {
      if (request.bytes.byteLength > maxObjectBytes) refuseRecoveryResourceIo()
      return await call('put', { ...request, bytes: Buffer.from(request.bytes).toString('base64') }) as Awaited<ReturnType<RecoveryArchiveObjectStoreProvider['put']>>
    },
    async get(request) {
      const result = await call('get', request)
      if (!result || typeof result !== 'object' || Array.isArray(result) || !('bytes' in result)) refuseRecoveryResourceIo()
      return { ...result, bytes: new Uint8Array(decodeRecoveryResourceBase64(result.bytes, maxObjectBytes)) } as RecoveryArchiveObjectReadResult
    },
    async head(request) { return await call('head', request) as Awaited<ReturnType<RecoveryArchiveObjectStoreProvider['head']>> },
    async pin(request) { return await call('pin', request) as Awaited<ReturnType<RecoveryArchiveObjectStoreProvider['pin']>> },
    async deleteExpired(request) { return await call('deleteExpired', request) as Awaited<ReturnType<RecoveryArchiveObjectStoreProvider['deleteExpired']>> },
    async discard(request) { return await call('discard', request) as Awaited<ReturnType<RecoveryArchiveAbandonedObjectStore['discard']>> },
    async status(request) { return await call('status', request) as Awaited<ReturnType<RecoveryArchiveAbandonedObjectStore['status']>> },
  }
  Object.defineProperty(raw, 'storeId', { value: storeId, enumerable: true })
  const ordinary = createTransactionGuardedRecoveryArchiveObjectStore(raw, transactionDepth)
  const abandoned = createGuardedRecoveryArchiveAbandonedObjectStore(raw, transactionDepth)
  return Object.freeze(Object.defineProperty({
    put: ordinary.put, get: ordinary.get, head: ordinary.head, pin: ordinary.pin, deleteExpired: ordinary.deleteExpired,
    discard: abandoned.discard, status: abandoned.status,
  }, 'storeId', { value: storeId, enumerable: true }))
}
