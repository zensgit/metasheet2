import { createRequire } from 'node:module'
import type { MetaSheetServer as Server } from '../src/index'

const require = createRequire(import.meta.url)
const { MetaSheetServer, resolveRecoveryArchiveMainPoolRuntime } = require('../src/index.ts') as typeof import('../src/index')
const { prepareRecoveryLocalStartup } = require('../src/multitable/recovery-local-startup.ts') as typeof import('../src/multitable/recovery-local-startup')
const { readLocalRecoverySecret } = require('../src/multitable/recovery-local-operator-input.ts') as typeof import('../src/multitable/recovery-local-operator-input')
const { getAttachmentStorageService } = require('../src/routes/univer-meta.ts') as typeof import('../src/routes/univer-meta')

// FD 3 is an inherited local pipe, never a secret argument or environment value.
const cancellation = new AbortController()
let server: Server | undefined
let starting = true
const cancel = () => {
  cancellation.abort()
  if (server && !starting) {
    void server.stop('LOCAL_OPERATOR_STOP').then(() => process.exit(0), () => process.exit(1))
  }
}
process.on('SIGTERM', cancel)
process.on('SIGINT', cancel)
try {
  const local = await prepareRecoveryLocalStartup({
    env: process.env,
    configPath: process.argv[2] ?? '',
    signal: cancellation.signal,
    readSecret: signal => {
      console.info('RECOVERY_LOCAL_CUSTODY_LOCKED')
      return readLocalRecoverySecret(3, signal)
    },
    resolveDatabase: resolveRecoveryArchiveMainPoolRuntime,
    resolveAttachmentStorage: getAttachmentStorageService,
  })
  if (!local || cancellation.signal.aborted) {
    local?.releaseCustody()
    throw new Error('RECOVERY_LOCAL_STARTUP_REFUSED')
  }
  try {
    server = new MetaSheetServer({
      host: '127.0.0.1',
      startupSignal: cancellation.signal,
      manageProcessSignals: false,
      createRecoveryArchiveComposition: () => local.composition,
    })
  } catch {
    // Constructor failure precedes listening and worker admission.
    local?.releaseCustody()
    throw new Error('RECOVERY_LOCAL_STARTUP_REFUSED')
  }
  await server.start()
  starting = false
  if (cancellation.signal.aborted) {
    await server.stop('LOCAL_STARTUP_CANCELLED')
    throw new Error('RECOVERY_LOCAL_STARTUP_REFUSED')
  }
} catch {
  // Underlying filesystem/provider errors may include private paths or values.
  console.error('RECOVERY_LOCAL_STARTUP_REFUSED')
  process.exit(1)
}
