import { randomBytes, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { expect, test } from 'vitest'
import { abandonExpiredRecoveryArchiveBuilder } from '../../src/multitable/recovery-archive-expired-builder'
import { claimRecoveryArchiveAbandonedObjectCleanup, recoveryArchivePreparedStagingPlan } from '../../src/multitable/recovery-archive-abandoned-object-cleanup'
import { persistRecoveryArchivePreparedCapture } from '../../src/multitable/recovery-archive-prepared-capture'
import { encodeRecoveryArchivePreparedEnvelope } from '../../src/multitable/recovery-archive-prepared-upload'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import { sealRecoveryArchiveSection, recoveryArchivePlaintextSha256 } from '../../src/multitable/recovery-archive-crypto'
import { createRecoveryArchiveFileStoreProvider, provisionRecoveryArchiveFileRoot } from '../../src/multitable/recovery-archive-file-store'
import type { RecoveryArchivePreparedCaptureOwner } from '../../src/multitable/recovery-archive-prepared-capture'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'
import type { RecoveryArchiveScopeIdentity } from '../../src/multitable/recovery-archive-worker-authorization'

type Context = {
  query: SealQuery; transaction: <T>(work: (query: SealQuery) => Promise<T>) => Promise<T>
  identity: RecoveryArchiveScopeIdentity; ownerId: string; keyId: string; sourceVectorHash: string
  anchorOperationId: string; anchorSeq: string; checkpointId: string
  insertArchive: (lease: string) => Promise<string>; waitExpiry: (id: string) => Promise<void>
  sourcePin: (id: string, attachment: string) => Promise<void>; attachment: (id: string) => Promise<void>
  withPreparedLayer: (work: () => Promise<void>) => Promise<void>
}
const refusal = /^RECOVERY_ARCHIVE_EXPIRED_BUILDER_REFUSED$/

/** Collected inside the existing required D2b suite; no independent skip-shaped test entrypoint. */
export function defineExpiredBuilderCases(c: Context): void {
  const ownerFor = (generationId: string): RecoveryArchivePreparedCaptureOwner => ({ generationId, ownerKind: 'archive_builder',
    ownerId: c.ownerId, ownerFence: '1', sourceVectorHash: c.sourceVectorHash })
  const lease = async (seconds: number) => String((await c.query(`SELECT (clock_timestamp()+$1*interval '1 second')::text AS value`, [seconds])).rows[0]['value'])
  const read = async (id: string) => (await c.query('SELECT * FROM meta_recovery_archives WHERE generation_id=$1::uuid', [id])).rows[0] as Record<string, unknown>
  const abandon = (owner: RecoveryArchivePreparedCaptureOwner, identity = c.identity) => abandonExpiredRecoveryArchiveBuilder(c.transaction, async () => true, { identity, owner })

  test('expired-builder CAS refuses live lease, authority, scope, vector and owner mismatches with zero mutation', async () => {
    const owner = ownerFor(await c.insertArchive(await lease(1)))
    const initial = await read(owner.generationId)
    await expect(abandon(owner)).rejects.toThrow(refusal)
    await expect(abandonExpiredRecoveryArchiveBuilder(c.transaction, async () => false, { identity: c.identity, owner })).rejects.toThrow(refusal)
    await c.waitExpiry(owner.generationId)
    for (const field of ['workspaceId', 'baseId', 'sheetId'] as const) {
      await expect(abandon(owner, { ...c.identity, [field]: `${c.identity[field]}_other` })).rejects.toThrow(refusal)
    }
    for (const changed of [{ ownerKind: 'other' }, { ownerId: `${owner.ownerId}_other` }, { ownerFence: '2' },
      { sourceVectorHash: 'f'.repeat(64) }, { generationId: randomUUID() }]) {
      await expect(abandon({ ...owner, ...changed })).rejects.toThrow(refusal)
    }
    expect(await read(owner.generationId)).toEqual(initial)
    const results = await Promise.allSettled([abandon(owner), abandon(owner)])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const terminal = await read(owner.generationId)
    expect(terminal.updated_at).toBeInstanceOf(Date)
    expect((terminal.updated_at as Date).getTime()).toBeGreaterThanOrEqual((initial.updated_at as Date).getTime())
    expect(terminal).toEqual({ ...initial, build_status: 'abandoned', updated_at: terminal.updated_at })
    await expect(abandon(owner)).rejects.toThrow(refusal)
    // Early death without a prepared inventory is terminalizable, never cleanup proof.
    await c.withPreparedLayer(async () => { await expect(claimRecoveryArchiveAbandonedObjectCleanup(c.transaction, async () => true,
      { identity: c.identity, owner, cleanupOwnerId: 'synthetic_cleanup', leaseExpiresAt: '2099-01-01T00:00:00Z' }))
      .rejects.toThrow(/^RECOVERY_ARCHIVE_ABANDONED_OBJECT_REFUSED$/) })
    expect(await read(owner.generationId)).toEqual(terminal)
  })

  test('expired-builder CAS cannot discard a competing live lease extension', async () => {
    const owner = ownerFor(await c.insertArchive(await lease(1)))
    await c.query(`UPDATE meta_recovery_archives SET lease_expires_at=clock_timestamp()+interval '1 minute' WHERE generation_id=$1::uuid`, [owner.generationId])
    const renewed = await read(owner.generationId)
    await new Promise(resolve => setTimeout(resolve, 1100))
    await expect(abandon(owner)).rejects.toThrow(refusal)
    expect(await read(owner.generationId)).toEqual(renewed)
  })

  test.each(['builder', 'cleaner', 'late-builder'] as const)('real process %s resumes exact operation inventory without losing pins, nonces or key references', async crash => {
    await c.withPreparedLayer(async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tm-expired-crash-'))
      const children: ReturnType<typeof spawn>[] = []
      let generationId: string | undefined
      function spawn(input: Record<string, unknown>) {
        const child = fork(path.resolve('tests/fixtures/recovery-expired-builder-crash.mts'), [], {
          execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
            NODE_ENV: 'test', TSX_DISABLE_CACHE: '1', DATABASE_URL: process.env.DATABASE_URL, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL },
        })
        let output = ''
        child.stdout!.on('data', data => { output += String(data) }); child.stderr!.on('data', data => { output += String(data) })
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
        const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) }))
        const message = new Promise<Record<string, unknown>>((resolve, reject) => {
          child.once('message', value => resolve(value as Record<string, unknown>))
          child.once('error', reject); child.once('close', () => reject(new Error('CRASH_CHILD_EARLY_EXIT')))
        })
        child.send(input)
        return { child, closed, message, output: () => output }
      }
      try {
        generationId = await c.insertArchive(await lease(3))
        const owner = ownerFor(generationId)
        const attachmentId = `crash_${randomUUID()}`
        await c.attachment(attachmentId); await c.sourcePin(generationId, attachmentId)
        const binding = { ...c.identity, generationId, formatVersion: 1 as const, anchorOperationId: c.anchorOperationId,
          anchorSeq: c.anchorSeq, checkpointId: c.checkpointId, keyId: c.keyId, aeadAlgorithm: 'aes-256-gcm' as const,
          wrappedDekId: 'synthetic-wrapped', dekFingerprint: randomBytes(32).toString('hex') }
        const dek = randomBytes(32)
        const sealedSections = RECOVERY_ARCHIVE_V1_SECTION_NAMES.map(sectionName => {
          const plaintext = Buffer.from(`synthetic ${sectionName}`)
          return sealRecoveryArchiveSection({ binding: { ...binding, sectionName, plaintextSha256: recoveryArchivePlaintextSha256(plaintext) }, dek, nonce: randomBytes(12), plaintext })
        })
        dek.fill(0)
        for (const section of sealedSections) await c.query(`SELECT meta_recovery_archive_reserve_nonce($1,$2,$3::uuid,$4,'aes-256-gcm',1)`,
          [binding.dekFingerprint, section.nonce.toString('hex'), generationId, section.sectionName])
        const payload = encodeRecoveryArchivePreparedEnvelope({ binding, wrappedDekId: binding.wrappedDekId, dekFingerprint: binding.dekFingerprint,
          wrappedDek: randomBytes(64), reservations: [], sealedSections,
          sealedAttachments: [{ attachmentId, sourceVersion: 'synthetic-v1', plaintextSha256: 'a'.repeat(64), sizeBytes: 3,
            nonce: randomBytes(12), ciphertext: Buffer.from('abc'), authTag: randomBytes(16) }] })
        await c.transaction(query => persistRecoveryArchivePreparedCapture(query, owner, payload))
        const options = { basePath: root, storeId: randomUUID(), maxObjectBytes: 2048 }
        await provisionRecoveryArchiveFileRoot({ ...options, transactionDepth: { currentTransactionDepth: () => 0 } })
        const provider = await createRecoveryArchiveFileStoreProvider({ ...options, transactionDepth: { currentTransactionDepth: () => 0 } })
        const stable = async () => ({
          operations: (await c.query('SELECT * FROM meta_record_history_operations WHERE sheet_id=$1 ORDER BY operation_id', [c.identity.sheetId])).rows,
          history: (await c.query('SELECT * FROM meta_record_revisions WHERE sheet_id=$1 ORDER BY id', [c.identity.sheetId])).rows,
          key: (await c.query('SELECT * FROM meta_recovery_archive_keys WHERE key_id=$1', [c.keyId])).rows,
          nonces: (await c.query('SELECT * FROM meta_recovery_archive_nonce_reservations WHERE generation_id=$1::uuid ORDER BY section_name', [generationId])).rows,
          prepared: (await c.query('SELECT * FROM meta_recovery_archive_prepared_captures WHERE generation_id=$1::uuid', [generationId])).rows,
        })
        const baseline = await stable()
        expect(baseline.nonces).toHaveLength(10); expect(baseline.history.length).toBeGreaterThan(0)
        const pinCount = async () => (await c.query(`SELECT count(*)::int AS n FROM meta_recovery_archive_attachment_refs WHERE generation_id=$1::uuid AND reference_class='source'`, [generationId])).rows
        const receipts = async () => (await c.query(`SELECT count(*)::int AS n FROM meta_recovery_archive_staging_objects WHERE generation_id=$1::uuid AND terminal_receipt_sha256 IS NOT NULL`, [generationId])).rows
        const first = spawn({ action: crash === 'late-builder' ? 'upload-late' : 'upload-crash', terminalize: false, identity: c.identity, owner, options }); children.push(first)
        expect(await first.message).toEqual({ stage: 'put-confirmed', owner, pid: first.child.pid, depth: 0 })
        const archive = await read(generationId)
        expect([archive.state, archive.build_status, archive.coverage_status]).toEqual(['building', 'active', 'incomplete'])
        const plan = recoveryArchivePreparedStagingPlan(payload, (archive.expires_at as Date).toISOString())
        const object = await provider.get(plan[0].binding)
        expect(Buffer.from(object.bytes)).toEqual(Buffer.concat([sealedSections[0].ciphertext, sealedSections[0].authTag]))
        expect((await c.query('SELECT count(*)::int AS n FROM meta_recovery_archive_objects WHERE generation_id=$1::uuid', [generationId])).rows).toEqual([{ n: 0 }])
        const inventory = (await c.query('SELECT * FROM meta_recovery_archive_abandoned_bindings WHERE generation_id=$1::uuid ORDER BY staging_object_id', [generationId])).rows
        expect(inventory).toHaveLength(11)
        expect(new Set(inventory.map(row => row['store_id']))).toEqual(new Set([options.storeId]))
        let prior = owner
        if (crash === 'late-builder') {
          await c.waitExpiry(generationId)
          await abandon(owner)
          prior = await claimRecoveryArchiveAbandonedObjectCleanup(c.transaction, async () => true,
            { identity: c.identity, owner, cleanupOwnerId: `${owner.ownerId}_next`, leaseExpiresAt: await lease(1) })
          const late = new Promise<Record<string, unknown>>(resolve => first.child.once('message', value => resolve(value as Record<string, unknown>)))
          first.child.send({ release: true })
          expect(await late).toEqual({ stage: 'late-put-refused', code: 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_OWNER_UNAVAILABLE', pid: first.child.pid, depth: 0 })
          expect(await first.closed).toEqual({ code: 0, signal: null })
          expect((await c.query('SELECT count(*)::int AS n FROM meta_recovery_archive_objects WHERE generation_id=$1::uuid', [generationId])).rows).toEqual([{ n: 0 }])
        } else {
          first.child.kill('SIGKILL'); expect(await first.closed).toEqual({ code: null, signal: 'SIGKILL' })
        }
        expect(await pinCount()).toEqual([{ n: 1 }]); expect(await receipts()).toEqual([{ n: 0 }])
        await c.waitExpiry(generationId)
        if (crash === 'cleaner') {
          const cleaner = spawn({ action: 'cleanup-crash', terminalize: true, identity: c.identity, owner, options }); children.push(cleaner)
          const barrier = await cleaner.message
          prior = barrier.owner as RecoveryArchivePreparedCaptureOwner
          expect(barrier).toEqual({ stage: 'discard-confirmed', owner: { ...owner, ownerKind: 'archive_cleanup', ownerId: `${owner.ownerId}_next`, ownerFence: '2' }, pid: cleaner.child.pid, depth: 0 })
          cleaner.child.kill('SIGKILL'); expect(await cleaner.closed).toEqual({ code: null, signal: 'SIGKILL' })
          expect(await pinCount()).toEqual([{ n: 1 }]); expect(await receipts()).toEqual([{ n: 0 }])
          await c.waitExpiry(generationId)
        }
        const resumed = spawn({ action: 'complete', terminalize: crash === 'builder', identity: c.identity, owner: prior, options }); children.push(resumed)
        const done = await resumed.message
        expect(done).toEqual({ stage: 'complete', result: { outcome: 'complete', confirmed: 11 },
          owner: { ...prior, ownerKind: 'archive_cleanup', ownerId: `${prior.ownerId}_next`, ownerFence: crash === 'builder' ? '2' : '3' },
          reconciled: crash === 'cleaner' ? 1 : 0, depth: 0, pid: resumed.child.pid })
        expect(await resumed.closed).toEqual({ code: 0, signal: null })
        expect(await pinCount()).toEqual([{ n: 0 }]); expect(await receipts()).toEqual([{ n: 11 }])
        expect((await c.query('SELECT * FROM meta_recovery_archive_abandoned_bindings WHERE generation_id=$1::uuid ORDER BY staging_object_id', [generationId])).rows).toEqual(inventory)
        expect(await stable()).toEqual(baseline)
        expect((await read(generationId)).key_id).toBe(c.keyId)
        expect((await c.query('SELECT key_id,count(*)::int AS n FROM meta_recovery_archive_staging_objects WHERE generation_id=$1::uuid GROUP BY key_id', [generationId])).rows).toEqual([{ key_id: c.keyId, n: 11 }])
        for (const entry of plan) expect(await provider.head(entry.binding)).toBeNull()
        for (const child of children) expect(child.output()).toBe('')
        console.log(JSON.stringify({ code: 'CRASH_CHILD_EXIT_EVIDENCE', scenario: crash, children: children.map(({ child }) => ({ pid: child.pid, exit: child.exitCode, signal: child.signalCode })) }))
        console.log(`PASS: ${crash === 'late-builder' ? 'LATE_PUT' : `SIGKILL_${crash.toUpperCase()}`} real barrier, fresh process, exact inventory, pins and preserved nonce/key/history`)
      } finally {
        for (const child of children) if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill('SIGKILL')
        await Promise.all(children.map(child => child.closed))
        if (generationId) await c.transaction(async query => {
          await query('SET LOCAL session_replication_role=replica')
          await query('DELETE FROM meta_recovery_archive_nonce_reservations WHERE generation_id=$1::uuid', [generationId])
        })
        await fs.rm(root, { recursive: true, force: true })
      }
    })
  }, 30_000)
}
