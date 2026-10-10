import { isIP } from 'node:net'
import { createRecoveryArchiveFileStoreProvider, provisionRecoveryArchiveFileRoot } from '../src/multitable/recovery-archive-file-store'
import { createRecoveryArchiveObjectServer } from '../src/multitable/recovery-archive-object-server'
import { exactRecoveryResourceConfig, readRecoveryResourceJson, readRecoveryResourcePrivateFile } from '../src/multitable/recovery-resource-config'

// Explicit resource command; never imported or started by the default application.
let service: ReturnType<typeof createRecoveryArchiveObjectServer> | undefined
const cancellation = new AbortController()
let starting = true
const stop = () => {
  cancellation.abort()
  if (service && !starting) void service.stop().then(() => process.exit(0), () => process.exit(1))
}
process.once('SIGTERM', stop); process.once('SIGINT', stop)
try {
  const config = exactRecoveryResourceConfig(await readRecoveryResourceJson(process.argv[2] ?? ''),
    ['host', 'port', 'archivePath', 'storeId', 'maxObjectBytes', 'timeoutMs', 'tokenPath', 'certPath', 'keyPath'])
  if (typeof config.host !== 'string' || !isIP(config.host) || !Number.isSafeInteger(config.port)
    || Number(config.port) < 1024 || Number(config.port) > 65535) throw new Error('CONFIG_REFUSED')
  const token = await readRecoveryResourcePrivateFile(config.tokenPath as string, 1024)
  const key = await readRecoveryResourcePrivateFile(config.keyPath as string, 16384)
  try {
    const cert = await readRecoveryResourcePrivateFile(config.certPath as string, 65536)
    const options = { basePath: config.archivePath as string, storeId: config.storeId as string,
      maxObjectBytes: config.maxObjectBytes as number, transactionDepth: { currentTransactionDepth: () => 0 } }
    if (cancellation.signal.aborted) throw new Error('START_CANCELLED')
    await provisionRecoveryArchiveFileRoot(options)
    const provider = await createRecoveryArchiveFileStoreProvider(options)
    service = createRecoveryArchiveObjectServer({ ...options, provider, token: token.toString('utf8').trim(), cert, key, timeoutMs: config.timeoutMs as number })
    if (cancellation.signal.aborted) { await service.stop(); throw new Error('START_CANCELLED') }
    await new Promise<void>((done, reject) => {
      service!.server.once('error', reject)
      service!.server.once('close', () => { if (cancellation.signal.aborted) reject(new Error('START_CANCELLED')) })
      service!.server.listen({ port: config.port as number, host: config.host as string, signal: cancellation.signal }, done)
    })
    starting = false
    if (cancellation.signal.aborted) { await service.stop(); throw new Error('START_CANCELLED') }
    console.info('RECOVERY_ARCHIVE_OBJECT_SERVICE_READY')
  } finally { token.fill(0); key.fill(0) }
} catch {
  try { await service?.stop() } catch { /* The fixed failure is retained. */ }
  console.error('RECOVERY_ARCHIVE_OBJECT_SERVICE_REFUSED'); process.exit(1)
}
