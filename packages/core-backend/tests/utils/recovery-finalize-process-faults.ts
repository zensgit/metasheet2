import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { createRecoveryArchiveFileStoreProvider, provisionRecoveryArchiveFileRoot } from '../../src/multitable/recovery-archive-file-store'
import { abandonExpiredRecoveryArchiveBuilder } from '../../src/multitable/recovery-archive-expired-builder'
import { claimRecoveryArchiveAbandonedObjectCleanup, cleanupRecoveryArchiveAbandonedObjects } from '../../src/multitable/recovery-archive-abandoned-object-cleanup'
import type { RecoveryArchiveFileStoreOptions } from '../../src/multitable/recovery-archive-file-store'
import type { RecoveryArchiveKeyCustodyAdapter } from '../../src/multitable/recovery-archive-crypto'
import type { RecoveryArchiveManualAdmissionPolicy } from '../../src/multitable/recovery-archive-manual-admission'
import type { RecoveryArchiveManualRequest } from '../../src/multitable/recovery-archive-manual-request'
import type { RecoveryArchivePreparedCaptureOwner } from '../../src/multitable/recovery-archive-prepared-capture'
import type { RecoveryArchivePreparedUploadInput } from '../../src/multitable/recovery-archive-prepared-upload'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'

export interface FinalizeProcessInput {
  action: 'finalize' | 'retry'; identity: RecoveryArchiveManualRequest; owner: RecoveryArchivePreparedCaptureOwner
  policy: RecoveryArchiveManualAdmissionPolicy; options: Omit<RecoveryArchiveFileStoreOptions, 'transactionDepth'>; macKey: string
}
type Row = Record<string, unknown>
const pause = () => new Promise(resolve => setTimeout(resolve, 25))

/** Called by the ordinary required checkpoint after its real source attachments have been populated. */
export async function verifyFinalizeProcessFaults(c: {
  createCommand: typeof import('../../src/routes/univer-meta')['createRecoveryArchiveManualCommand']
  query: SealQuery; transaction: RecoveryArchivePreparedUploadInput['transaction']; env: NodeJS.ProcessEnv; root: string
  request: RecoveryArchiveManualRequest; policy: RecoveryArchiveManualAdmissionPolicy; custody: RecoveryArchiveKeyCustodyAdapter; macKey: Buffer
}): Promise<void> {
  assert.ok(c.env.DATABASE_URL && c.env.DATABASE_URL === c.env.TEST_DATABASE_URL, 'OWNED_DATABASE_PAIR_REQUIRED')
  const contenderPool = new Pool({ connectionString: c.env.DATABASE_URL, max: 1 })
  const children: Array<ReturnType<typeof launch>> = []
  const storeRoot = await mkdtemp(join(c.root, 'finalize-fault-'))
  function launch(input: FinalizeProcessInput) {
    const child = fork(resolve('tests/fixtures/recovery-finalize-process-fault.mts'), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...c.env, TSX_DISABLE_CACHE: '1', MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
        MULTITABLE_ENABLE_WRITER_FENCE: 'true', MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'true' },
    })
    const messages: Row[] = []
    child.on('message', message => messages.push(message as Row))
    child.stdout!.resume(); child.stderr!.resume()
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    const message = async (stage: string) => {
      const deadline = Date.now() + 20000
      while (!messages.some(value => value.stage === stage)) {
        assert.ok(!messages.some(value => value.stage === 'failed') && child.exitCode === null && child.signalCode === null, 'FINALIZE_CHILD_EARLY_EXIT')
        assert.ok(Date.now() < deadline, 'FINALIZE_CHILD_BARRIER_TIMEOUT'); await pause()
      }
      return messages.find(value => value.stage === stage)!
    }
    child.send(input)
    return { child, closed, message }
  }
  const kill = async (child: ReturnType<typeof launch>) => {
    assert.equal(child.child.kill('SIGKILL'), true)
    assert.deepEqual(await child.closed, { code: null, signal: 'SIGKILL' })
  }
  try {
    for (const outcome of ['rollback', 'committed'] as const) {
      const options = { basePath: join(storeRoot, outcome), storeId: randomUUID(), maxObjectBytes: 8 * 1024 * 1024 }
      const transactionDepth = { currentTransactionDepth: () => 0 }
      await mkdir(options.basePath, { mode: 0o700 })
      await provisionRecoveryArchiveFileRoot({ ...options, transactionDepth })
      const provider = await createRecoveryArchiveFileStoreProvider({ ...options, transactionDepth })
      const identity = { ...c.request, requestId: randomUUID() }, policy = { ...c.policy, leaseSeconds: 30 }
      let preparedMac = 0
      const prepare = c.createCommand(c.transaction, { objectStore: provider, transactionDepth,
        keyCustody: { ...c.custody, async verifyManifestRootMac(request) {
          assert.equal(await c.custody.verifyManifestRootMac(request), true); preparedMac++
          throw new Error('SYNTHETIC_FINALIZE_DEFERRED')
        } } }, policy)
      await assert.rejects(prepare.capture(identity), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
      assert.equal(preparedMac, 1)
      const status = await prepare.read(identity), id = status.generationId
      assert.equal(status.state, 'pending')
      const rows = async (table: string, order: string) => (await c.query(`SELECT * FROM ${table} WHERE generation_id=$1::uuid ORDER BY ${order}`, [id])).rows as Row[]
      const generation = async () => (await rows('meta_recovery_archives', 'generation_id'))[0]
      const initial = await generation()
      const owner = { generationId: id, ownerKind: String(initial.owner_kind), ownerId: String(initial.owner_id),
        ownerFence: String(initial.owner_fence), sourceVectorHash: String(initial.source_vector_hash) }
      const publication = async () => ({ objects: await rows('meta_recovery_archive_objects', 'object_id'),
        refs: await rows('meta_recovery_archive_attachment_refs', 'attachment_id,reference_class'),
        coverage: await rows('meta_recovery_archive_coverage_items', 'source_kind,source_id') })
      const stable = async () => ({ prepared: await rows('meta_recovery_archive_prepared_captures', 'generation_id'),
        nonces: await rows('meta_recovery_archive_nonce_reservations', 'section_name'),
        stagingKeyRefs: (await c.query('SELECT staging_object_id,key_id FROM meta_recovery_archive_staging_objects WHERE generation_id=$1::uuid ORDER BY staging_object_id', [id])).rows, bindings: await rows('meta_recovery_archive_abandoned_bindings', 'staging_object_id'),
        key: (await c.query('SELECT * FROM meta_recovery_archive_keys WHERE key_id=$1', [policy.keyId])).rows,
        history: (await c.query('SELECT * FROM meta_record_revisions WHERE sheet_id=$1 ORDER BY id', [identity.sheetId])).rows,
        operations: (await c.query('SELECT * FROM meta_record_history_operations WHERE sheet_id=$1 ORDER BY operation_id', [identity.sheetId])).rows,
        sections: (await c.query('SELECT * FROM meta_sheet_section_revisions WHERE sheet_id=$1 ORDER BY id', [identity.sheetId])).rows })
      const before = await publication(), immutable = await stable()
      const attachments = before.objects.filter(row => row.object_class === 'attachment').length
      assert.ok(attachments > 0); assert.equal(before.objects.length, 11 + attachments)
      assert.ok(before.objects.every(row => row.state === 'uploaded'))
      assert.equal(before.coverage.length, 0); assert.equal(before.refs.length, attachments)
      assert.ok(before.refs.every(row => row.reference_class === 'source' && row.availability === 'available'))
      assert.equal(immutable.nonces.length, 10 + attachments); assert.equal(immutable.bindings.length, before.objects.length)
      const input: FinalizeProcessInput = { action: 'finalize', identity, owner, policy, options, macKey: c.macKey.toString('base64') }
      const child = launch(input); children.push(child)
      const barrier = await child.message('cas-before-commit')
      assert.equal(barrier.depth, 1); assert.equal(barrier.macCalls, 1)
      assert.deepEqual(await publication(), before); assert.deepEqual(await generation(), initial)
      const live = async () => (await c.query('SELECT lease_expires_at>clock_timestamp() AS live FROM meta_recovery_archives WHERE generation_id=$1::uuid', [id])).rows[0]['live'] === true
      assert.equal(await live(), true)
      const expire = async () => { const until = Date.now() + 35000; while (await live()) { assert.ok(Date.now() < until, 'REAL_LEASE_EXPIRY_TIMEOUT'); await pause() } }
      if (outcome === 'rollback') await expire()
      let contenderPid = 0
      const contenderTransaction: typeof c.transaction = async work => {
        const connection = await contenderPool.connect()
        try {
          await connection.query('BEGIN')
          contenderPid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          const result = await work(connection.query.bind(connection)); await connection.query('COMMIT'); return result
        } catch (error) { await connection.query('ROLLBACK'); throw error } finally { connection.release() }
      }
      const pending = abandonExpiredRecoveryArchiveBuilder(contenderTransaction, async () => true, { identity, owner }).then(() => null, error => error as Error)
      let blocked = false
      const until = Date.now() + 5000
      while (!blocked && Date.now() < until) {
        if (contenderPid) blocked = (await c.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked', [barrier.backendPid, contenderPid])).rows[0]['blocked'] === true
        if (!blocked) await pause()
      }
      assert.equal(blocked, true)
      if (outcome === 'rollback') {
        await kill(child); assert.equal(await pending, null)
        assert.deepEqual(await publication(), before)
        const abandoned = await generation()
        assert.deepEqual(abandoned, { ...initial, build_status: 'abandoned', updated_at: abandoned.updated_at })
        const cleanupOwner = await claimRecoveryArchiveAbandonedObjectCleanup(c.transaction, async () => true,
          { identity, owner, cleanupOwnerId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString() })
        let releases = 0
        const cleanupTransaction: typeof c.transaction = work => c.transaction(query => work(async (statement, params) => {
          if (statement.includes('meta_recovery_archive_release_abandoned_source_pin(')) {
            const receipts = (await query('SELECT object_state,terminal_receipt_sha256 FROM meta_recovery_archive_staging_objects WHERE generation_id=$1::uuid', [id])).rows as Row[]
            assert.equal(receipts.length, before.objects.length)
            assert.ok(receipts.every(row => row.object_state === 'absent' && typeof row.terminal_receipt_sha256 === 'string'))
            assert.equal((await query("SELECT count(*)::int AS n FROM meta_recovery_archive_attachment_refs WHERE generation_id=$1::uuid AND reference_class='source'", [id])).rows[0]['n'], attachments - releases)
            releases++
          }
          return query(statement, params)
        }))
        assert.deepEqual(await cleanupRecoveryArchiveAbandonedObjects(cleanupTransaction, async () => true,
          { identity, owner: cleanupOwner, provider, transactionDepth }), { outcome: 'complete', confirmed: before.objects.length })
        assert.equal(releases, attachments); assert.equal((await publication()).refs.length, 0)
      } else {
        assert.equal(await live(), true, 'COMMIT_WINNER_MUST_STILL_HOLD_LIVE_LEASE')
        child.child.send('commit')
        const committed = await child.message('committed-before-response')
        assert.equal(committed.depth, 0); assert.equal(committed.leaseLive, true)
        assert.equal((await pending)?.message, 'RECOVERY_ARCHIVE_EXPIRED_BUILDER_REFUSED')
        const verified = await generation(), complete = await publication()
        assert.deepEqual([verified.state, verified.build_status, verified.coverage_status], ['verified', 'finalized', 'complete'])
        assert.ok(complete.objects.every(row => row.state === 'verified')); assert.equal(complete.objects.length, before.objects.length)
        assert.equal(complete.coverage.length, Number(verified.coverage_row_count)); assert.ok(complete.coverage.length > 0)
        assert.equal(complete.refs.length, attachments); assert.ok(complete.refs.every(row => row.reference_class === 'archive_object' && row.reference_state === 'verified'))
        await kill(child); await expire()
        await assert.rejects(abandonExpiredRecoveryArchiveBuilder(c.transaction, async () => true, { identity, owner }), { message: 'RECOVERY_ARCHIVE_EXPIRED_BUILDER_REFUSED' })
        let cleanupCalls = 0
        await assert.rejects(claimRecoveryArchiveAbandonedObjectCleanup(c.transaction, async () => true,
          { identity, owner, cleanupOwnerId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }), { message: 'RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED' })
        await assert.rejects(cleanupRecoveryArchiveAbandonedObjects(c.transaction, async () => true, { identity, owner, transactionDepth,
          provider: { storeId: provider.storeId, status: async () => { cleanupCalls++; throw new Error('UNEXPECTED_IO') }, discard: async () => { cleanupCalls++; throw new Error('UNEXPECTED_IO') } } }), { message: 'RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED' })
        assert.equal(cleanupCalls, 0)
        const retry = launch({ ...input, action: 'retry' }); children.push(retry)
        await retry.message('retry-complete'); assert.deepEqual(await retry.closed, { code: 0, signal: null })
        assert.deepEqual(await generation(), verified); assert.deepEqual(await publication(), complete)
      }
      assert.deepEqual(await stable(), immutable)
      console.log(JSON.stringify({ code: 'FINALIZE_PROCESS_FAULT_PASS', outcome, attachments, objects: before.objects.length,
        nonces: immutable.nonces.length, blocked: true, postCommitLeaseLive: outcome === 'committed' ? true : null, sigkill: true, childPid: child.child.pid }))
    }
  } finally {
    for (const child of children) { if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL'); await child.closed }
    await contenderPool.end(); await rm(storeRoot, { recursive: true })
  }
}
