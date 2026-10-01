import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { abandonExpiredRecoveryArchiveBuilder } from '../../src/multitable/recovery-archive-expired-builder'
import { claimRecoveryArchiveAbandonedObjectCleanup } from '../../src/multitable/recovery-archive-abandoned-object-cleanup'
import type { RecoveryArchiveKeyCustodyAdapter } from '../../src/multitable/recovery-archive-crypto'
import type { RecoveryArchiveManualFinalizationInput } from '../../src/multitable/recovery-archive-manual-finalization'
import type { RecoveryArchivePreparedUploadInput } from '../../src/multitable/recovery-archive-prepared-upload'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'

type Transaction = RecoveryArchivePreparedUploadInput['transaction']

/** Required ordinary checkpoint calls this with its real admission, upload and authorized finalizer factories. */
export async function verifyLateManualFinalizer(c: {
  query: SealQuery; transaction: Transaction; custody: RecoveryArchiveKeyCustodyAdapter
  createFixture: () => Promise<RecoveryArchiveManualFinalizationInput>
  createFinalize: (transaction: Transaction) => (input: RecoveryArchiveManualFinalizationInput) => Promise<void>
}): Promise<void> {
  const input = await c.createFixture(), id = input.owner.generationId
  const generation = async () => (await c.query('SELECT * FROM meta_recovery_archives WHERE generation_id=$1::uuid', [id])).rows[0] as Record<string, unknown>
  const stable = async () => {
    const rows: Record<string, unknown[]> = {}
    for (const [name, table, order] of [
      ['objects', 'meta_recovery_archive_objects', 'object_id'],
      ['coverage', 'meta_recovery_archive_coverage_items', 'source_kind,source_id'],
      ['refs', 'meta_recovery_archive_attachment_refs', 'attachment_id,reference_class'],
      ['staging', 'meta_recovery_archive_staging_objects', 'staging_object_id'],
      ['bindings', 'meta_recovery_archive_abandoned_bindings', 'staging_object_id'],
      ['nonces', 'meta_recovery_archive_nonce_reservations', 'section_name'],
      ['prepared', 'meta_recovery_archive_prepared_captures', 'generation_id'],
    ]) rows[name] = (await c.query(`SELECT * FROM ${table} WHERE generation_id=$1::uuid ORDER BY ${order}`, [id])).rows
    rows.key = (await c.query('SELECT * FROM meta_recovery_archive_keys WHERE key_id=$1', [input.key.keyId])).rows
    return rows
  }
  const before = await stable(), initial = await generation()
  assert.equal(before.objects.length, 11)
  assert.ok(before.objects.every(row => (row as { state: string }).state === 'uploaded'))
  assert.equal(before.coverage.length, 0)
  assert.equal(before.refs.length, 0, 'This fixture has no source attachment pins; the D2b crash cases cover real retained pins.')
  assert.equal(before.staging.length, 11); assert.equal(before.bindings.length, 11)
  assert.equal(before.nonces.length, 10); assert.equal(before.prepared.length, 1); assert.equal(before.key.length, 1)
  assert.deepEqual([initial.state, initial.build_status, initial.coverage_status], ['building', 'active', 'incomplete'])
  let entered!: () => void, release!: () => void
  const barrier = new Promise<void>(resolve => { entered = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  let depth = 0, committed = 0, calls = 0
  const finalize = c.createFinalize(work => c.transaction(async query => {
    depth++
    try { const result = await work(query); committed++; return result } finally { depth-- }
  }))
  const pending = finalize({ ...input, transactionDepth: { currentTransactionDepth: () => depth },
    keyCustody: { ...c.custody, async verifyManifestRootMac(request) {
      calls++
      assert.equal(depth, 0); assert.equal(committed, 1)
      assert.equal(await c.custody.verifyManifestRootMac(request), true, 'Real manifest MAC must verify before pausing')
      entered(); await hold
      return true
    } } }).then(() => null, error => error as Error)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([barrier, pending.then(() => { throw new Error('LATE_MAC_BARRIER_NOT_REACHED') }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('LATE_MAC_BARRIER_TIMEOUT')), 5000) })])
    clearTimeout(timer)
    const live = () => c.query('SELECT lease_expires_at>clock_timestamp() AS live FROM meta_recovery_archives WHERE generation_id=$1::uuid', [id])
    assert.equal((await live()).rows[0]['live'], true)
    const deadline = Date.now() + 15000
    while ((await live()).rows[0]['live'] === true) {
      assert.ok(Date.now() < deadline, 'LATE_MAC_REAL_LEASE_EXPIRY_TIMEOUT')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.deepEqual(await generation(), initial, 'Expiry is elapsed database time, never a fixture lease update')
    await abandonExpiredRecoveryArchiveBuilder(c.transaction, async () => true, input)
    const abandoned = await generation()
    assert.deepEqual(abandoned, { ...initial, build_status: 'abandoned', updated_at: abandoned.updated_at })
    assert.deepEqual(await stable(), before)
    const lease = (await c.query("SELECT (clock_timestamp()+interval '30 seconds')::text AS value")).rows[0]['value'] as string
    const owner = await claimRecoveryArchiveAbandonedObjectCleanup(c.transaction, async () => true,
      { ...input, cleanupOwnerId: randomUUID(), leaseExpiresAt: lease })
    assert.equal(owner.ownerKind, 'archive_cleanup')
    assert.equal(BigInt(owner.ownerFence), BigInt(input.owner.ownerFence) + 1n)
    const takeover = await generation()
    assert.equal(takeover.owner_id, owner.ownerId); assert.equal(String(takeover.owner_fence), owner.ownerFence)
    assert.deepEqual(await stable(), before, 'Explicit takeover changes ownership only')
    release()
    assert.equal((await pending)?.message, 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED')
    assert.equal(calls, 1); assert.equal(committed, 1)
    assert.deepEqual(await generation(), takeover, 'Late finalizer cannot write against cleanup ownership')
    assert.deepEqual(await stable(), before)
    console.log('PASS: genuine MAC outside first committed transaction; observed live lease, actual expiry, explicit abandonment and newer cleanup fence; late finalizer refused; uploaded=11 verified=0 coverage=0 pins=0; nonce/prepared/key/staging/bindings unchanged')
  } finally { clearTimeout(timer); release(); await pending }
}
