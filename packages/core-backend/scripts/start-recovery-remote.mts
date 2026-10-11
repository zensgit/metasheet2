import { createRequire } from 'node:module'
import type { MetaSheetServer as Server } from '../src/index'
import { readRecoveryRemoteResourceConfig } from '../src/multitable/recovery-resource-config'
import { isRecoveryArchiveRestoreWorkerEnabled } from '../src/multitable/recovery-archive-restore-worker'

const require = createRequire(import.meta.url)
const cancellation = new AbortController()
let server: Server | undefined
let starting = true
const stop = () => {
  cancellation.abort()
  if (server && !starting) void server.stop('REMOTE_OPERATOR_STOP').then(() => process.exit(0), () => process.exit(1))
}
process.once('SIGTERM', stop); process.once('SIGINT', stop); process.once('disconnect', stop)
try {
  if (!isRecoveryArchiveRestoreWorkerEnabled(process.env)) throw new Error('ACTIVATION_REFUSED')
  const config = await readRecoveryRemoteResourceConfig(process.argv[2] ?? '')
  if (cancellation.signal.aborted) throw new Error('START_CANCELLED')
  const { prepareRecoveryRemoteComposition } = require('../src/multitable/recovery-remote-composition.ts') as typeof import('../src/multitable/recovery-remote-composition')
  const { MetaSheetServer, resolveRecoveryArchiveMainPoolRuntime } = require('../src/index.ts') as typeof import('../src/index')
  const { getAttachmentStorageService } = require('../src/routes/univer-meta.ts') as typeof import('../src/routes/univer-meta')
  const { StorageServiceImpl } = require('../src/services/StorageService.ts') as typeof import('../src/services/StorageService')
  const composition = prepareRecoveryRemoteComposition({ env: process.env, resolveResources: () => config,
    resolveDatabase: resolveRecoveryArchiveMainPoolRuntime, resolveAttachmentStorage: getAttachmentStorageService,
    resolveAttachmentCleanupStorage: storage => storage instanceof StorageServiceImpl ? StorageServiceImpl.resolveLocalRecoveryCleanup(storage) : undefined })
  if (!composition || cancellation.signal.aborted) throw new Error('START_CANCELLED')
  server = new MetaSheetServer({ host: '127.0.0.1', startupSignal: cancellation.signal, manageProcessSignals: false, createRecoveryArchiveComposition: () => composition })
  await server.start(); starting = false
  if (cancellation.signal.aborted) { await server.stop('REMOTE_STARTUP_CANCELLED'); throw new Error('START_CANCELLED') }
} catch {
  try { await server?.stop('REMOTE_STARTUP_REFUSED') } catch { /* The fixed failure is retained. */ }
  console.error('RECOVERY_ARCHIVE_REMOTE_STARTUP_REFUSED'); process.exit(1)
}
