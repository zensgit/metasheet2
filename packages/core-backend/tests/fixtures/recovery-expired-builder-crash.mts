import { once } from 'node:events'
import { createRequire } from 'node:module'
import { Pool } from 'pg'
import type { RecoveryArchivePreparedCaptureOwner } from '../../src/multitable/recovery-archive-prepared-capture'
import type { RecoveryArchiveScopeIdentity } from '../../src/multitable/recovery-archive-worker-authorization'
import type { RecoveryArchiveFileStoreOptions } from '../../src/multitable/recovery-archive-file-store'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'
const require = createRequire(import.meta.url)
const { createRecoveryArchiveFileStoreProvider } = require('../../src/multitable/recovery-archive-file-store.ts') as typeof import('../../src/multitable/recovery-archive-file-store')
const { bindRecoveryArchiveManualObjectUpload } = require('../../src/multitable/recovery-archive-manual-continuation.ts') as typeof import('../../src/multitable/recovery-archive-manual-continuation')
const { decodeRecoveryArchivePreparedEnvelope } = require('../../src/multitable/recovery-archive-prepared-upload.ts') as typeof import('../../src/multitable/recovery-archive-prepared-upload')
const { abandonExpiredRecoveryArchiveBuilder } = require('../../src/multitable/recovery-archive-expired-builder.ts') as typeof import('../../src/multitable/recovery-archive-expired-builder')
const { claimRecoveryArchiveAbandonedObjectCleanup, cleanupRecoveryArchiveAbandonedObjects } = require('../../src/multitable/recovery-archive-abandoned-object-cleanup.ts') as typeof import('../../src/multitable/recovery-archive-abandoned-object-cleanup')
let pool: Pool | undefined
try {
  if (process.env.NODE_ENV !== 'test' || !process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) throw new Error('HARNESS_REQUIRED')
  const [input] = await once(process, 'message') as [{ action: 'upload-crash' | 'upload-late' | 'cleanup-crash' | 'complete'; terminalize: boolean; crashObjectId?: string;
    identity: RecoveryArchiveScopeIdentity; owner: RecoveryArchivePreparedCaptureOwner;
    options: Omit<RecoveryArchiveFileStoreOptions, 'transactionDepth'> }]
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
  let depth = 0
  const transaction = async <T,>(work: (query: SealQuery) => Promise<T>) => {
    const client = await pool!.connect()
    try { await client.query('BEGIN'); depth++; const result = await work(client.query.bind(client)); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { depth--; client.release() }
  }
  const transactionDepth = { currentTransactionDepth: () => depth }
  const provider = await createRecoveryArchiveFileStoreProvider({ ...input.options, transactionDepth })
  const barrier = async (stage: string, owner: RecoveryArchivePreparedCaptureOwner) => {
    if (depth !== 0) throw new Error('IO_IN_TRANSACTION')
    process.send!({ stage, owner, pid: process.pid, depth })
    // Intentionally stays alive until the parent sends SIGKILL; no application crash hook.
    await once(process, 'message')
    throw new Error('CRASH_BARRIER_RELEASED')
  }
  if (input.action === 'upload-crash' || input.action === 'upload-late') {
    const stored = await pool.query('SELECT payload FROM meta_recovery_archive_prepared_captures WHERE generation_id=$1::uuid', [input.owner.generationId])
    const envelope = decodeRecoveryArchivePreparedEnvelope(stored.rows[0].payload)
    const upload = bindRecoveryArchiveManualObjectUpload(transaction, async () => true, { ...input, transactionDepth,
      provider: { ...provider, put: async request => {
        if (depth !== 0) throw new Error('IO_IN_TRANSACTION')
        const result = await provider.put(request)
        if (input.action === 'upload-crash') return barrier('put-confirmed', input.owner)
        process.send!({ stage: 'put-confirmed', owner: input.owner, pid: process.pid, depth })
        await once(process, 'message')
        return result
      } },
    })
    try { await upload(envelope, envelope.sections[0]); throw new Error('LATE_UPLOAD_ACCEPTED') } catch (error) {
      if (input.action !== 'upload-late' || !(error instanceof Error) || error.message !== 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_OWNER_UNAVAILABLE') throw error
      process.send!({ stage: 'late-put-refused', code: error.message, pid: process.pid, depth })
    }
  } else {
    if (input.terminalize) await abandonExpiredRecoveryArchiveBuilder(transaction, async () => true, input)
    const lease = await pool.query(`SELECT (clock_timestamp()+interval '4 seconds')::text AS expires`)
    const owner = await claimRecoveryArchiveAbandonedObjectCleanup(transaction, async () => true,
      { ...input, cleanupOwnerId: `${input.owner.ownerId}_next`, leaseExpiresAt: input.action === 'complete' ? '2099-01-01T00:00:00Z' : lease.rows[0].expires })
    let reconciled = 0
    const result = await cleanupRecoveryArchiveAbandonedObjects(transaction, async () => true, { ...input, owner, transactionDepth,
      provider: { storeId: provider.storeId, status: async request => {
        if (depth !== 0) throw new Error('IO_IN_TRANSACTION')
        const result = await provider.status(request); if (result.outcome === 'absent') reconciled++; return result
      }, discard: async request => {
        if (depth !== 0) throw new Error('IO_IN_TRANSACTION')
        const result = await provider.discard(request)
        if (input.action === 'cleanup-crash' && request.objectId === input.crashObjectId && result.outcome === 'absent') return barrier('discard-confirmed', owner)
        return result
      } },
    })
    process.send!({ stage: 'complete', result, owner, reconciled, depth, pid: process.pid })
  }
} catch { process.exitCode = 1 }
finally { await pool?.end(); if (process.connected) process.disconnect() }
