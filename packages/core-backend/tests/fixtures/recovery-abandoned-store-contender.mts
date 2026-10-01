import { once } from 'node:events'
import { createRequire } from 'node:module'
import type { RecoveryArchiveFileStoreOptions } from '../../src/multitable/recovery-archive-file-store'
import type { RecoveryArchiveDiscardRequest } from '../../src/multitable/recovery-archive-abandoned-object-store'

const require = createRequire(import.meta.url)
const { createRecoveryArchiveFileStoreProvider } = require('../../src/multitable/recovery-archive-file-store.ts') as typeof import('../../src/multitable/recovery-archive-file-store')

// Each contender owns its provider; only the parent provisions/removes the shared root.
try {
  const [input] = await once(process, 'message') as [{
    action: 'pin' | 'discard'
    options: Omit<RecoveryArchiveFileStoreOptions, 'transactionDepth'>
    request: RecoveryArchiveDiscardRequest
  }]
  const provider = await createRecoveryArchiveFileStoreProvider({
    ...input.options, transactionDepth: { currentTransactionDepth: () => 0 },
  })
  const start = once(process, 'message')
  process.send!({ ready: true, pid: process.pid })
  await start
  if (input.action === 'pin') {
    const { operationId: _operationId, storeId: _storeId, ...binding } = input.request
    try {
      process.send!({ pin: 'succeeded', object: await provider.pin(binding) })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED') throw error
      process.send!({ pin: 'refused', code: error.message })
    }
  } else {
    process.send!({ discard: await provider.discard(input.request) })
  }
  process.disconnect()
} catch {
  process.exitCode = 1
  if (process.connected) process.disconnect()
}
