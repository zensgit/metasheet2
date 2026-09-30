/** Test-only target process: never opens the source database or source roots. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import type { Pool } from 'pg'
import type { LocalCustodyReceipt } from '../src/multitable/recovery-local-custody-store'
import type { RecoveryArchiveRestoreJobQuery, RecoveryArchiveRestoreJobTransaction } from '../src/multitable/recovery-archive-restore-jobs'

const require = createRequire(import.meta.url)

export interface ManualTargetInput {
  readonly databaseName: string
  readonly local: {
    readonly archivePath: string
    readonly custodyPath: string
    readonly custodyId: string
    readonly storeId: string
    readonly receipt: LocalCustodyReceipt
    readonly recoverySecret: Uint8Array
  }
  readonly identity: { readonly sheetId: string; readonly actorId: string }
  readonly generationId: string
  readonly recordId: string
  readonly fieldId: string
  readonly attachmentFieldId: string
  readonly attachmentId: string
  readonly attachmentBytes: Uint8Array
}

async function send(message: { kind: 'manual-target-done' } | { kind: 'manual-target-error'; code: string; frames: string[] }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_IPC_MISSING'))
    process.send(message, undefined, undefined, (error) => error ? reject(error) : resolve())
  })
}

async function run(input: ManualTargetInput): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED, 'true')
  assert.equal(process.env.MULTITABLE_ENABLE_WRITER_FENCE, 'true')
  assert.equal(typeof process.env.DATABASE_URL, 'string')
  assert.equal(typeof process.env.ATTACHMENT_PATH, 'string')

  const { Pool: PgPool } = require('pg') as typeof import('pg')
  const { createLocalCustodySession } = require('../src/multitable/recovery-local-custody.ts') as typeof import('../src/multitable/recovery-local-custody')
  const { createLocalCustodyStore } = require('../src/multitable/recovery-local-custody-store.ts') as typeof import('../src/multitable/recovery-local-custody-store')
  const { createRecoveryArchiveFileStoreProvider } = require('../src/multitable/recovery-archive-file-store.ts') as typeof import('../src/multitable/recovery-archive-file-store')
  const { restoreImportedManualArchive } = require('./verify-recovery-local-manual-http.ts') as typeof import('./verify-recovery-local-manual-http')
  const { getAttachmentStorageService } = require('../src/routes/univer-meta.ts') as typeof import('../src/routes/univer-meta')
  const { poolManager } = require('../src/integration/db/connection-pool.ts') as typeof import('../src/integration/db/connection-pool')

  const pool: Pool = new PgPool({ connectionString: process.env.DATABASE_URL, max: 4, application_name: 'tm_local_manual_target' })
  let transactionDepth = 0
  const depth = { currentTransactionDepth: () => transactionDepth }
  const query: RecoveryArchiveRestoreJobQuery = (text, values) => pool.query(text, values)
  const transaction: RecoveryArchiveRestoreJobTransaction = async (work) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      transactionDepth += 1
      const result = await work((text, values) => client.query(text, values))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      transactionDepth -= 1
      client.release()
    }
  }
  const session = createLocalCustodySession(depth)
  try {
    const identity = await query('SELECT current_database() AS database_name')
    assert.equal((identity.rows[0] as { database_name?: string } | undefined)?.database_name, input.databaseName)
    const custody = await createLocalCustodyStore({
      archivePath: input.local.archivePath, custodyPath: input.local.custodyPath,
      custodyId: input.local.custodyId, transactionDepth: depth,
    })
    session.unlock({ custodyId: input.local.custodyId, recoverySecret: input.local.recoverySecret,
      backup: await custody.readBackup(input.local.receipt) })
    const admission = session.admitForArchive(input.local.custodyId)
    const objectStore = await createRecoveryArchiveFileStoreProvider({
      basePath: input.local.archivePath, storeId: input.local.storeId,
      maxObjectBytes: 16 * 1024 * 1024, transactionDepth: depth,
    })
    await restoreImportedManualArchive({
      runtime: { query, transaction, depth },
      archive: { keyCustody: admission, objectStore, transactionDepth: depth,
        attachmentStorage: getAttachmentStorageService() },
      identity: input.identity,
      keyId: admission.keyId,
      generationId: input.generationId,
      recordId: input.recordId,
      fieldId: input.fieldId,
      attachmentFieldId: input.attachmentFieldId,
      attachmentId: input.attachmentId,
    })
    const metadata = await query(
      'SELECT storage_path FROM public.multitable_attachments WHERE id=$1 AND sheet_id=$2',
      [input.attachmentId, input.identity.sheetId],
    )
    assert.equal(metadata.rows.length, 1)
    const storagePath = (metadata.rows[0] as { storage_path?: unknown }).storage_path
    assert.equal(typeof storagePath, 'string')
    const recovered = await getAttachmentStorageService().readContentAddressed(storagePath as string)
    assert.deepEqual(Buffer.from(recovered.bytes), Buffer.from(input.attachmentBytes))
  } finally {
    session.lock()
    input.local.recoverySecret.fill(0)
    await pool.end()
    await poolManager.close()
  }
}

process.once('message', (input: ManualTargetInput) => {
  void (async () => {
    try {
      await run(input)
      await send({ kind: 'manual-target-done' })
    } catch (error) {
      const code = error instanceof Error && /^RECOVERY_[A-Z0-9_]+$/.test(error.message)
        ? error.message : 'RECOVERY_LOCAL_BACKUP_MANUAL_TARGET_FAILED'
      const frames = error instanceof Error
        ? [...(error.stack ?? '').matchAll(/\/(verify-recovery-local-manual-(?:http\.ts|target\.mts)):(\d+)/g)]
          .map((match) => `${match[1]}:${match[2]}`) : []
      await send({ kind: 'manual-target-error', code, frames })
      process.exitCode = 1
    } finally {
      process.disconnect()
    }
  })()
})
