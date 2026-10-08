import { Pool, type PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { bindRecoveryArchiveManualCommand } from '../../src/multitable/recovery-archive-manual-command'
import { createOwnedComposerFixture, type OwnedComposerFixture } from '../utils/recovery-archive-owned-composer-fixture'
import { loadRecoveryArchiveAuthorityInternal } from '../../src/multitable/recovery-archive-preview'
import { readRecoveryArchiveCompleteSectionState, readRecoveryArchiveAttachmentBytes } from '../../src/multitable/recovery-archive-reader'
import { usePinnedServer } from '../utils/pinned-server'
import { LocalStorageProvider } from '../../src/services/StorageService'
import { canonicalSheetFenceKey } from '../../src/multitable/canonical-sheet-fence'
import { sealDirectEventOperation, type SealQuery } from '../../src/multitable/recovery-archive-seals'
import { runRecoveryArchiveOwnedTransaction } from '../../src/multitable/recovery-archive-owned-authority'
import { prepareArchiveWriterBlockTransaction } from '../../src/multitable/recovery-archive-writer-block'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = armed && process.env.DATABASE_URL ? describe : describe.skip
const pinned = usePinnedServer()
test('sentinel: owned composer real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('recovery_archive_owned_composer_realdb_harness_missing_database_url')
})
const flags = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE']
let admin: Pool, fixture: OwnedComposerFixture, saved: Array<string | undefined>
const authorize: Parameters<typeof bindRecoveryArchiveManualCommand>[1] = async (query, identity) =>
  (await query('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2', [identity.baseId, identity.actorId])).rows.length === 1
function command(overrides: Partial<NonNullable<Parameters<typeof bindRecoveryArchiveManualCommand>[5]>> = {}, permission = authorize) {
  return bindRecoveryArchiveManualCommand(fixture.transaction, permission, fixture.runtime, fixture.policy,
    fixture.readContentAddressed, { pool: fixture.nativePool, limits: fixture.limits,
      readContentAddressedBounded: fixture.readContentAddressedBounded, ...overrides })
}
async function state() {
  return (await fixture.query(`SELECT a.state,a.build_status,a.coverage_status,a.root_hash,
    s.recovery_writer_state,s.recovery_writer_owner_id,s.recovery_writer_owner_fence::text,
    (SELECT count(*)::int FROM meta_recovery_archive_coverage_items c WHERE c.generation_id=a.generation_id) AS coverage,
    (SELECT count(*)::int FROM meta_recovery_archive_nonce_reservations n WHERE n.generation_id=a.generation_id) AS nonces,
    (SELECT count(*)::int FROM meta_recovery_archive_attachment_refs p WHERE p.generation_id=a.generation_id AND reference_class='source') AS pins
    FROM meta_recovery_archives a JOIN meta_sheets s ON s.id=a.sheet_id WHERE a.sheet_id=$1 ORDER BY a.created_at`, [fixture.sheetId])).rows
}
async function open(generationId: string) {
  const authority = await loadRecoveryArchiveAuthorityInternal(fixture.transaction, { ...fixture.identity, generationId,
    recheckAuthority: (query) => authorize(query, fixture.identity) })
  return readRecoveryArchiveCompleteSectionState({ selectedBinding: authority.selectedBinding,
    manifestObject: authority.manifestObject, sectionObjects: authority.sectionObjects,
    attachmentObjects: authority.attachmentObjects, keyCustody: fixture.runtime.keyCustody,
    objectStore: fixture.runtime.objectStore, transactionDepth: fixture.transactionDepth, query: fixture.query })
}
async function expectAbandoned() {
  expect(await fixture.historyCount()).toBe(fixture.initialHistory)
  const rows = await state()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ state: 'building', build_status: 'abandoned', coverage_status: 'incomplete', root_hash: null,
    recovery_writer_state: null, recovery_writer_owner_id: null, coverage: 0, pins: 2 })
}
async function installRouter() {
  const priorPath = process.env.ATTACHMENT_PATH
  const sourcePath = resolve('../../artifacts/tm-owned-generation-composer-20261007/native-pg/runtime/http-source')
  await mkdir(sourcePath, { mode: 0o700, recursive: true })
  const storage = new LocalStorageProvider(sourcePath)
  for (const attachment of fixture.attachmentKeys) await storage.uploadByKey(attachment.key, attachment.bytes)
  process.env.ATTACHMENT_PATH = sourcePath
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const adapter = { getInternalPool: () => fixture.nativePool, query: fixture.query,
    transaction: <T>(work: (client: { query: SealQuery }) => Promise<T>) => fixture.transaction((query) => work({ query })) }
  vi.spyOn(poolManager, 'get').mockReturnValue(adapter as unknown as ReturnType<typeof poolManager.get>)
  try {
    const { univerMetaRouter } = await import('../../src/routes/univer-meta')
    const app = express(); app.use(express.json())
    app.use((req, _res, next) => { req.user = { id: fixture.identity.actorId, roles: ['admin'], perms: ['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema'] }; next() })
    app.use('/api/multitable', univerMetaRouter({ recoveryArchiveRuntime: fixture.runtime,
      recoveryArchiveDatabaseRuntime: { transaction: fixture.transaction, query: fixture.query,
        transactionDepthProbe: fixture.transactionDepth, nativePool: fixture.nativePool },
      recoveryArchiveManualPolicy: fixture.policy, recoveryArchiveManualCaptureLimits: fixture.limits }))
    pinned.setApp(app)
  } finally { if (priorPath === undefined) delete process.env.ATTACHMENT_PATH; else process.env.ATTACHMENT_PATH = priorPath }
}

describeRealDb('owned generation composer actual manual command (real DB)', () => {
  beforeAll(() => { saved = flags.map((flag) => process.env[flag]); admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 500 }) })
  beforeEach(async () => { for (const flag of flags) process.env[flag] = 'true'; fixture = await createOwnedComposerFixture(admin) })
  afterEach(async context => {
    vi.restoreAllMocks()
    await fixture?.persistFailureDiagnostics(context.task.result?.state, context.task.result?.errors)
    await fixture?.dispose()
  })
  afterAll(async () => { flags.forEach((flag, index) => { if (saved[index] === undefined) delete process.env[flag]; else process.env[flag] = saved[index] }); await admin?.end() })

  test('baseline actual manual command keeps durable owned block and future history uncommitted through external callbacks', async () => {
    expect(fixture.guards).toHaveLength(9)
    expect(fixture.guards.every((guard) => guard.tgenabled === 'O')).toBe(true)
    const selected = command()
    let result: Awaited<ReturnType<typeof selected.capture>> | undefined
    let commandError: unknown
    try { result = await selected.capture(fixture.identity) } catch (error) { commandError = error }
    expect(fixture.observations.some((entry) => entry.phase === 'attachment-read')).toBe(true)
    expect(fixture.observations.some((entry) => entry.phase === 'put')).toBe(true)
    console.log('owned_composer_actual_baseline', JSON.stringify({ state: result?.state,
      commandError: commandError instanceof Error ? commandError.message : null, initialHistory: fixture.initialHistory,
      callbackCount: fixture.observations.length, observations: fixture.observations }))
    expect(fixture.observations.every((entry) => entry.depth === 0)).toBe(true)
    expect(fixture.observations.every((entry) => entry.block !== null), 'actual manual command lacks committed owned writer block during external I/O').toBe(true)
    expect(fixture.observations.every((entry) => entry.block === 'archiving' && entry.exactOwner), 'external callback must observe exact generation-owned durable archiving tuple').toBe(true)
    expect(fixture.claimCommitBeforeRR).toEqual([true])
    expect(fixture.observations.every((entry) => entry.history === fixture.initialHistory), 'actual manual command committed future history before final publication').toBe(true)
    expect(commandError).toBeUndefined()
    expect(result?.state).toBe('recoverable')
    expect(fixture.stagedPlaintexts).toHaveLength(2)
    expect(fixture.stagedPlaintexts.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  test('populated bootstrap and repeat after real ordinary write authenticate exact 28 coverage and retained live/deleted attachment bytes', async () => {
    const first = await command().capture(fixture.identity)
    expect(first.state).toBe('recoverable')
    const opened = await open(first.generationId)
    for (const attachment of fixture.attachments) expect(readRecoveryArchiveAttachmentBytes(opened, attachment.id).bytes).toEqual(attachment.bytes)
    expect((await state())[0]).toMatchObject({ state: 'verified', build_status: 'finalized', coverage_status: 'complete', coverage: 28, nonces: 12, pins: 0, recovery_writer_state: null })
    const raw = (await fixture.query(`SELECT
      (SELECT count(*)::int FROM meta_sheet_section_revisions r JOIN meta_recovery_archive_snapshot_reservations p ON p.operation_id=r.operation_id AND p.created_at=r.created_at WHERE p.generation_id=$1::uuid AND r.id=p.operation_id) AS revisions,
      (SELECT count(*)::int FROM meta_record_history_operations o JOIN meta_recovery_archive_snapshot_reservations p ON p.operation_id=o.operation_id AND p.created_at=o.created_at WHERE p.generation_id=$1::uuid) AS endpoints,
      (SELECT count(*)::int FROM meta_record_history_snapshot_members m JOIN meta_recovery_archive_snapshot_reservations p ON p.operation_id=m.parent_operation_id AND p.created_at=m.created_at WHERE p.generation_id=$1::uuid) AS memberships`, [first.generationId])).rows
    expect(raw).toEqual([{ revisions: 9, endpoints: 10, memberships: 9 }])
    await installRouter()
    const write = await request(pinned.url()).patch(`/api/multitable/views/${fixture.viewId}`).set('Host', 'synthetic.invalid').send({ name: 'Synthetic after ordinary write' })
    expect(write.status, write.body.error?.code).toBe(200)
    expect((await fixture.query('SELECT count(*)::int AS n FROM meta_config_revisions WHERE entity_id=$1', [fixture.viewId])).rows).toEqual([{ n: 1 }])
    fixture.observations.length = 0
    const second = await command().capture({ ...fixture.identity, requestId: randomUUID() })
    expect(second.state).toBe('recoverable'); expect(second.generationId).not.toBe(first.generationId)
    const repeat = await open(second.generationId)
    expect(repeat.views_config).toHaveLength(1)
    expect(repeat.views_config[0].payload).toMatchObject({ name: 'Synthetic after ordinary write' })
    for (const attachment of fixture.attachments) expect(readRecoveryArchiveAttachmentBytes(repeat, attachment.id).bytes).toEqual(attachment.bytes)
    expect((await state()).map((row) => row.coverage)).toEqual([28, 28])
    expect(await fixture.historyCount()).toBe(56)
  })

  test('actual pinned HTTP capture factory carries native pool and server-owned limits into complete recoverable generation', async () => {
    await installRouter()
    const response = await request(pinned.url()).post(`/api/multitable/sheets/${fixture.sheetId}/recovery-archive/captures`)
      .set('Host', 'synthetic.invalid').send({ requestId: fixture.identity.requestId })
    expect(response.status, response.body.error?.code).toBe(200)
    expect(response.body).toEqual({ ok: true, data: { requestId: fixture.identity.requestId,
      generationId: expect.any(String), state: 'recoverable' } })
    expect((await state())[0]).toMatchObject({ state: 'verified', build_status: 'finalized', coverage: 28, nonces: 12, recovery_writer_state: null })
    const opened = await open(response.body.data.generationId)
    for (const attachment of fixture.attachments) expect(readRecoveryArchiveAttachmentBytes(opened, attachment.id).bytes).toEqual(attachment.bytes)
    expect(fixture.claimCommitBeforeRR).toEqual([true])
  })

  test('duplicate POST reads durable status only with no second plaintext or provider attempt', async () => {
    const selected = command(), first = await selected.capture(fixture.identity)
    const before = JSON.stringify(await state()), callbacks = fixture.observations.length, history = await fixture.historyCount()
    expect(await selected.capture(fixture.identity)).toEqual(first)
    expect(JSON.stringify(await state())).toBe(before); expect(await fixture.historyCount()).toBe(history)
    expect(fixture.observations.length).toBe(callbacks)
  })

  test.each(['missing-pool', 'missing-limits', 'zero-bytes', 'zero-timeout'] as const)('invalid selected runtime %s refuses before durable claim', async (kind) => {
    const owned = { pool: fixture.nativePool, limits: fixture.limits, readContentAddressedBounded: fixture.readContentAddressedBounded }
    const invalid = kind === 'missing-pool' ? { ...owned, pool: undefined } : kind === 'missing-limits' ? { ...owned, limits: undefined }
      : { ...owned, limits: { ...owned.limits, [kind === 'zero-bytes' ? 'maxBytes' : 'timeoutMs']: 0 } }
    const selected = bindRecoveryArchiveManualCommand(fixture.transaction, authorize, fixture.runtime, fixture.policy,
      fixture.readContentAddressed, invalid as NonNullable<Parameters<typeof bindRecoveryArchiveManualCommand>[5]>)
    await expect(selected.capture(fixture.identity)).rejects.toThrow('RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID')
    expect(await state()).toEqual([]); expect(fixture.observations).toEqual([]); expect(await fixture.historyCount()).toBe(0)
  })

  test('permission loss after released RR abandons exact builder while preserving pins and all unconsumed history', async () => {
    let allowed = true
    fixture.control.external = async (phase) => { if (phase === 'attachment-read') allowed = false }
    await expect(command({}, async (query, identity) => allowed && await authorize(query, identity)).capture(fixture.identity)).rejects.toThrow()
    await expectAbandoned(); expect(fixture.observations.filter((entry) => entry.phase === 'put')).toEqual([])
  })

  test('key retirement between fresh capture and pin transition refuses publication and keeps exact-owner cleanup available', async () => {
    let changed = false
    fixture.control.external = async (phase) => {
      if (phase !== 'attachment-read' || changed) return
      changed = true
      await fixture.query("UPDATE meta_recovery_archive_keys SET state='retiring',row_version=row_version+1 WHERE key_id=$1", [fixture.policy.keyId])
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    await expectAbandoned(); expect(fixture.observations.some((entry) => entry.phase === 'put')).toBe(false)
  })

  test('trust checkpoint retirement during local bytes acquisition refuses with no committed future history', async () => {
    fixture.control.external = async (phase) => {
      if (phase === 'attachment-read') await fixture.query("UPDATE meta_history_trust_checkpoints SET state='superseded' WHERE sheet_id=$1", [fixture.sheetId])
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    await expectAbandoned()
  })

  test('one microsecond owned block timestamp drift refuses and abandonment cannot clear changed exact tuple', async () => {
    let changed = false
    fixture.control.external = async (phase) => {
      if (phase !== 'attachment-read' || changed) return
      changed = true
      await fixture.query("UPDATE meta_sheets SET recovery_writer_updated_at=recovery_writer_updated_at+interval '1 microsecond' WHERE id=$1", [fixture.sheetId])
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    expect(await fixture.historyCount()).toBe(0)
    expect((await state())[0]).toMatchObject({ state: 'building', build_status: 'abandoned', coverage: 0, recovery_writer_state: 'archiving', pins: 2 })
  })

  test('successor owned block survives handled attachment failure while previous builder is abandoned', async () => {
    const successor = randomUUID()
    fixture.control.external = async (phase) => {
      if (phase !== 'attachment-read') return
      await fixture.query("UPDATE meta_sheets SET recovery_writer_owner_id=$2,recovery_writer_owner_fence=recovery_writer_owner_fence+1,recovery_writer_updated_at=clock_timestamp() WHERE id=$1", [fixture.sheetId, successor])
      throw new Error('synthetic_attachment_failure')
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    expect((await state())[0]).toMatchObject({ build_status: 'abandoned', coverage: 0, recovery_writer_state: 'archiving', recovery_writer_owner_id: successor, pins: 2 })
    expect(await fixture.historyCount()).toBe(0)
  })

  test('provider failure retains prepared ciphertext and permanent nonces but rolls back all future history and publication', async () => {
    fixture.control.external = async (phase) => { if (phase === 'put') throw new Error('synthetic_provider_failure') }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    await expectAbandoned()
    expect((await state())[0].nonces).toBe(12)
    expect((await fixture.query('SELECT count(*)::int AS n FROM meta_recovery_archive_prepared_captures')).rows).toEqual([{ n: 1 }])
    expect(fixture.stagedPlaintexts).toHaveLength(2)
    expect(fixture.stagedPlaintexts.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  test('native final history insertion failure rolls back every inserted history row and leaves nonce/pin evidence for exact abandonment', async () => {
    let injected = false
    fixture.control.query = async (sql, _params, _client, execute) => {
      const result = await execute()
      if (!injected && /INSERT INTO\s+(?:public\.)?meta_record_history_snapshot_members/i.test(sql.replace(/\s+/g, ' '))) {
        injected = true; throw new Error('synthetic_final_history_failure')
      }
      return result
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    expect(injected).toBe(true)
    await expectAbandoned(); expect((await state())[0].nonces).toBe(12)
    expect(fixture.observations.filter((entry) => entry.phase === 'put')).toHaveLength(13)
  })

  test('real permanent nonce collision rolls back entire nonce batch before any AEAD payload or PUT', async () => {
    let injected = false
    fixture.control.query = async (sql, params, _client, execute) => {
      if (!injected && sql.includes('meta_recovery_archive_reserve_nonce(')) {
        injected = true
        // No nonce FK exists: a separate real connection commits this permanent tombstone.
        await fixture.query(sql, params)
      }
      return execute()
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    expect(injected).toBe(true); await expectAbandoned()
    expect(fixture.observations.some((entry) => entry.phase === 'put')).toBe(false)
    expect((await fixture.query('SELECT count(*)::int AS n FROM meta_recovery_archive_prepared_captures')).rows).toEqual([{ n: 0 }])
    expect((await state())[0].nonces).toBe(1)
    await expect(fixture.query('DELETE FROM meta_recovery_archive_nonce_reservations')).rejects.toThrow('recovery_archive_nonce_reservation_immutable')
    expect((await state())[0].nonces).toBe(1)
  })

  test('native deferred posture guard refuses source pin omission and the unchanged complete pin set still finalizes', async () => {
    let changed = false
    let changeError: unknown
    let removed = 0
    fixture.control.external = async (phase) => {
      if (phase !== 'attachment-read' || changed) return
      changed = true
      try { removed = (await fixture.query("DELETE FROM meta_recovery_archive_attachment_refs WHERE attachment_id=$1 AND reference_class='source'", [fixture.attachmentId])).rowCount ?? 0 }
      catch (error) { changeError = error }
    }
    const result = await command().capture(fixture.identity)
    console.log('owned_pin_drift_control', JSON.stringify({ removed, error: changeError instanceof Error ? changeError.message : null }))
    expect(changeError).toBeInstanceOf(Error); expect((changeError as Error).message).toBe('recovery_archive_attachment_posture_invalid'); expect(removed).toBe(0)
    expect(result.state).toBe('recoverable')
    expect(await fixture.historyCount()).toBe(28)
    expect((await state())[0]).toMatchObject({ build_status: 'finalized', coverage: 28, pins: 0, nonces: 12, recovery_writer_state: null })
  })

  test('actual sealed ordinary head drift after released RR refuses the generation without consuming its 28 reserved history candidates', async () => {
    let changed = false
    fixture.control.external = async (phase) => {
      if (phase !== 'attachment-read' || changed) return
      changed = true
      await fixture.transaction(async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(fixture.sheetId)])
        const operationId = randomUUID()
        const result = await query("INSERT INTO meta_record_revisions(sheet_id,record_id,version,action,operation_id,snapshot) VALUES($1,$2,1,'create',$3::uuid,'{}') RETURNING seq::text", [fixture.sheetId, `${fixture.sheetId}_ordinary_head`, operationId])
        await sealDirectEventOperation(query, { sheetId: fixture.sheetId, operationId, endpointSeq: (result.rows[0] as { seq: string }).seq, eventCount: 1, operationKind: 'ordinary' })
      })
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    expect(await fixture.historyCount()).toBe(1)
    expect((await fixture.query('SELECT count(*)::int AS n FROM meta_sheet_section_revisions')).rows).toEqual([{ n: 0 }])
    expect((await state())[0]).toMatchObject({ build_status: 'abandoned', coverage: 0, nonces: 0, recovery_writer_state: null })
  })

  test('emergency flags OFF cannot disable owner-safe abandonment after a genuine committed claim', async () => {
    fixture.control.external = async (phase) => {
      if (phase !== 'attachment-read') return
      for (const flag of flags) process.env[flag] = 'false'
      throw new Error('synthetic_external_failure_after_emergency_off')
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    await expectAbandoned()
  })

  test('aggregate metadata byte cap refuses with zero ciphertext and provider writes', async () => {
    await expect(command({ limits: { maxBytes: 16, timeoutMs: 10000 } }).capture(fixture.identity)).rejects.toThrow()
    expect(fixture.observations.some((entry) => entry.phase === 'put')).toBe(false)
    expect(await fixture.historyCount()).toBe(0)
    expect((await fixture.query('SELECT count(*)::int AS n FROM meta_recovery_archive_nonce_reservations')).rows).toEqual([{ n: 0 }])
  })

  test('native inherited RR transaction refuses before generation claim or source I/O', async () => {
    fixture.control.inheritedRR = true
    await expect(command().capture(fixture.identity)).rejects.toThrow()
    expect(await state()).toEqual([]); expect(fixture.observations).toEqual([])
    expect(await fixture.historyCount()).toBe(0)
  })

  test('claim COMMIT acknowledgement loss leaves durable lease-bound pending attempt without downstream capability or plaintext work', async () => {
    let injected = false
    fixture.control.query = async (sql, _params, _client, execute) => {
      const result = await execute()
      if (sql === 'COMMIT' && !injected) { injected = true; throw new Error('synthetic_claim_commit_ack_unknown') }
      return result
    }
    await expect(command().capture(fixture.identity)).rejects.toThrow('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
    expect(injected).toBe(true); expect(fixture.observations).toEqual([]); expect(await fixture.historyCount()).toBe(0)
    expect((await state())[0]).toMatchObject({ state: 'building', build_status: 'active', coverage_status: 'incomplete',
      recovery_writer_state: 'archiving', coverage: 0, nonces: 0, pins: 2 })
    const before = JSON.stringify(await state())
    expect((await command().capture(fixture.identity)).state).toBe('pending')
    expect(JSON.stringify(await state())).toBe(before); expect(fixture.observations).toEqual([])
  })

  test('uncertain final COMMIT reports success only through authoritative durable recoverable status readback', async () => {
    let injected = false
    fixture.control.query = async (sql, _params, client, execute) => {
      const finalized = sql === 'COMMIT' && !injected
        && (await client.query("SELECT count(*)::int AS n FROM meta_recovery_archives WHERE state='verified' AND build_status='finalized' AND sheet_id=$1", [fixture.sheetId])).rows[0].n === 1
      const result = await execute()
      if (finalized) { injected = true; throw new Error('synthetic_final_commit_ack_unknown') }
      return result
    }
    const result = await command().capture(fixture.identity)
    expect(injected).toBe(true); expect(result.state).toBe('recoverable')
    expect((await state())[0]).toMatchObject({ state: 'verified', build_status: 'finalized', coverage: 28, nonces: 12, recovery_writer_state: null })
  })

  test('uncertain final COMMIT with failed authority readback never guesses success even when durable transaction committed', async () => {
    let injected = false, allowed = true
    fixture.control.query = async (sql, _params, client, execute) => {
      const finalized = sql === 'COMMIT' && !injected
        && (await client.query("SELECT count(*)::int AS n FROM meta_recovery_archives WHERE state='verified' AND build_status='finalized' AND sheet_id=$1", [fixture.sheetId])).rows[0].n === 1
      const result = await execute()
      if (finalized) { injected = true; allowed = false; throw new Error('synthetic_final_commit_ack_unknown') }
      return result
    }
    await expect(command({}, async (query, identity) => allowed && await authorize(query, identity)).capture(fixture.identity)).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_GENERATION_REFUSED')
    expect(injected).toBe(true)
    expect((await state())[0]).toMatchObject({ state: 'verified', build_status: 'finalized', coverage: 28, recovery_writer_state: null })
  })

  test('late local attachment completion after whole attempt timeout cannot publish or begin another provider call', async () => {
    const privatePool = new Pool({ ...fixture.pool.options, connectionTimeoutMillis: 50 })
    try {
      fixture.control.external = async (phase) => { if (phase === 'attachment-read') await new Promise((done) => setTimeout(done, 700)) }
      await expect(command({ pool: privatePool, limits: { maxBytes: 8 * 1024 * 1024, timeoutMs: 500 } }).capture(fixture.identity)).rejects.toThrow('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
      await new Promise((done) => setTimeout(done, 800))
      expect(fixture.observations.some((entry) => entry.phase === 'attachment-read')).toBe(true)
      expect(await fixture.historyCount()).toBe(0)
      expect(fixture.observations.some((entry) => entry.phase === 'put')).toBe(false)
      expect((await state()).every((row) => row.state !== 'verified' && row.coverage === 0)).toBe(true)
    } finally { await privatePool.end() }
  })

  test('real oversized content-addressed file is bounded before allocation by remaining aggregate attachment budget', async () => {
    const bytes = Buffer.alloc(256 * 1024, 7)
    const uploaded = await fixture.storage.uploadContentAddressed(bytes, { filename: 'synthetic' })
    await fixture.query('UPDATE multitable_attachments SET storage_file_id=$2,size=$3,storage_path=$4 WHERE id=$1', [fixture.attachmentId, uploaded.id, bytes.length, uploaded.path])
    await expect(command({ limits: { maxBytes: 64 * 1024, timeoutMs: 10000 } }).capture(fixture.identity)).rejects.toThrow()
    expect(fixture.observations.some((entry) => entry.phase === 'attachment-read')).toBe(true)
    expect(fixture.observations.some((entry) => entry.phase === 'put')).toBe(false)
    await expectAbandoned(); expect((await state())[0].nonces).toBe(0)
  })

  test('audit: native query capability refuses after release when its genuine client has been borrowed again', async () => {
    let retained: SealQuery | undefined
    const originalPid = await runRecoveryArchiveOwnedTransaction(fixture.nativePool, 10000, { value: 0 }, async (query) => {
      await prepareArchiveWriterBlockTransaction(query, fixture.sheetId)
      retained = query
      return (await query('SELECT pg_backend_pid()::int AS pid')).rows[0] as { pid: number }
    })
    const borrower = await fixture.pool.connect()
    let lateError: unknown, lateResult: unknown
    try {
      expect((await borrower.query('SELECT pg_backend_pid()::int AS pid')).rows).toEqual([originalPid])
      const before = fixture.nativeCalls.length
      try { lateResult = await retained!('SELECT 771 AS borrowed_marker') } catch (error) { lateError = error }
      const lateSql = fixture.nativeCalls.slice(before).filter((entry) => entry.sql === 'SELECT 771 AS borrowed_marker').length
      console.log('owned_late_query_capability', JSON.stringify({ borrowedSameClient: true, lateSql, coarseRefusal: lateError instanceof Error, lateResultPresent: lateResult !== undefined }))
      expect(lateSql, 'released owned query capability executed SQL on a subsequently borrowed native client').toBe(0)
      expect(lateError).toBeInstanceOf(Error)
      expect(lateResult).toBeUndefined()
    } finally { borrower.release() }
  })

  test('audit: same-ID immutable attachment metadata drift after available pins refuses complete publication', async () => {
    let changed = 0
    fixture.control.external = async (phase) => {
      if (phase !== 'put' || changed) return
      const replacement = await fixture.storage.uploadContentAddressed(fixture.attachments[0].bytes, { filename: 'synthetic-replacement' })
      await fixture.transaction(async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(fixture.sheetId)])
        changed = (await query('UPDATE multitable_attachments SET storage_path=$2 WHERE id=$1', [fixture.attachmentId, replacement.path])).rowCount ?? 0
      })
    }
    let result: Awaited<ReturnType<ReturnType<typeof command>['capture']>> | undefined
    let error: unknown
    try { result = await command().capture(fixture.identity) } catch (caught) { error = caught }
    const rows = await state()
    console.log('owned_available_metadata_drift', JSON.stringify({ changed, recoverable: result?.state === 'recoverable', verified: rows[0]?.state === 'verified', refused: error instanceof Error }))
    expect(changed).toBe(1)
    expect(rows.every((row) => row.state !== 'verified'), 'available-pin authority accepted changed current immutable attachment metadata').toBe(true)
    expect(error).toBeInstanceOf(Error)
    await expectAbandoned()
  })

  test.each(['storage_provider', 'size', 'record_id', 'field_id', 'mime_type', 'deleted_at', 'equal-count-id-substitution'] as const)('audit: available current attachment candidate drift %s refuses complete publication', async (kind) => {
    let changed = 0
    fixture.control.external = async (phase) => {
      if (phase !== 'put' || changed) return
      await fixture.transaction(async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(fixture.sheetId)])
        if (kind === 'equal-count-id-substitution') {
          const result = await query(`WITH previous AS (DELETE FROM multitable_attachments WHERE id=$1 RETURNING *)
            INSERT INTO multitable_attachments(id,sheet_id,record_id,field_id,storage_file_id,filename,original_name,mime_type,size,storage_path,storage_provider,metadata,created_by,created_at,updated_at,deleted_at,blob_purged_at,blob_purge_claimed_at)
            SELECT $2,sheet_id,record_id,field_id,storage_file_id,filename,original_name,mime_type,size,storage_path,storage_provider,metadata,created_by,created_at,updated_at,deleted_at,blob_purged_at,blob_purge_claimed_at FROM previous`, [fixture.attachmentId, `${fixture.sheetId}_substitute_attachment`])
          changed = result.rowCount ?? 0
        } else {
          const assignments = { storage_provider: "storage_provider='s3'", size: 'size=size+1', record_id: 'record_id=$2',
            field_id: 'field_id=$2', mime_type: "mime_type='application/pdf'", deleted_at: 'deleted_at=clock_timestamp()' }
          changed = (await query(`UPDATE multitable_attachments SET ${assignments[kind]} WHERE id=$1`,
            kind === 'record_id' ? [fixture.attachmentId, fixture.recordId] : kind === 'field_id' ? [fixture.attachmentId, fixture.fieldId] : [fixture.attachmentId])).rowCount ?? 0
        }
      })
    }
    let result: Awaited<ReturnType<ReturnType<typeof command>['capture']>> | undefined, error: unknown
    try { result = await command().capture(fixture.identity) } catch (caught) { error = caught }
    expect(changed, 'native current-candidate drift fixture did not perform its genuine guarded SQL mutation').toBe(1)
    expect((await state()).every((row) => row.state !== 'verified'), 'available candidate authority accepted current attachment drift').toBe(true)
    expect(result?.state).not.toBe('recoverable'); expect(error).toBeInstanceOf(Error)
    await expectAbandoned()
  })

  test('audit: public timeout abandons exact owned builder before a never-resolving attachment callback is released', async () => {
    const privatePool = new Pool({ ...fixture.pool.options, connectionTimeoutMillis: 50 })
    let release!: () => void
    const latch = new Promise<void>((done) => { release = done })
    fixture.control.external = async (phase) => { if (phase === 'attachment-read') await latch }
    let error: unknown
    try {
      try { await command({ pool: privatePool, limits: { maxBytes: 8 * 1024 * 1024, timeoutMs: 500 } }).capture(fixture.identity) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(Error)
      expect(fixture.observations.some((entry) => entry.phase === 'attachment-read')).toBe(true)
      const rows = await state()
      console.log('owned_public_timeout_before_callback_release', JSON.stringify({ buildStatus: rows[0]?.build_status,
        blockHeld: rows[0]?.recovery_writer_state === 'archiving', pins: rows[0]?.pins, nonces: rows[0]?.nonces }))
      expect(rows[0]?.build_status, 'public timeout left the confirmed exact builder active while external callback remained pending').toBe('abandoned')
      expect(rows[0]?.recovery_writer_state).toBeNull(); expect(rows[0]?.pins).toBe(2); expect(rows[0]?.nonces).toBe(0)
    } finally { release(); await new Promise((done) => setTimeout(done, 100)); await privatePool.end() }
  })

  test('audit: public timeout abandons prepared builder before pending genuine PUT returns and forbids a later HEAD call', async () => {
    const privatePool = new Pool({ ...fixture.pool.options, connectionTimeoutMillis: 50 })
    let release!: () => void
    const latch = new Promise<void>((done) => { release = done })
    fixture.control.external = async (phase) => { if (phase === 'put') await latch }
    try {
      await expect(command({ pool: privatePool, limits: { maxBytes: 8 * 1024 * 1024, timeoutMs: 1000 } }).capture(fixture.identity)).rejects.toThrow('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
      expect(fixture.observations.filter((entry) => entry.phase === 'put')).toHaveLength(1)
      await expectAbandoned(); expect((await state())[0].nonces).toBe(12)
      expect((await fixture.query('SELECT count(*)::int AS n FROM meta_recovery_archive_prepared_captures')).rows).toEqual([{ n: 1 }])
    } finally { release(); await new Promise((done) => setTimeout(done, 100)); await privatePool.end() }
    expect(fixture.observations.filter((entry) => entry.phase === 'head')).toHaveLength(0)
    expect((await state())[0]).toMatchObject({ build_status: 'abandoned', coverage: 0, nonces: 12, pins: 2 })
    expect(fixture.stagedPlaintexts.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  test('audit: unexpected attachment reader error remains values-free at the direct command boundary', async () => {
    fixture.control.external = async (phase) => { if (phase === 'attachment-read') throw new Error('synthetic_secret') }
    let error: unknown
    try { await command().capture(fixture.identity) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message.includes('synthetic_secret'), 'owned command exposed unexpected adapter error text').toBe(false)
    await expectAbandoned()
  })

  test('audit: controlled native process transport delay cannot commit catalog publication after the whole attempt deadline', async () => {
    const timeoutMs = 1500, started = Date.now(), deadline = started + timeoutMs
    fixture.diagnostics.start('controlled-delayed-commit', timeoutMs)
    let spent = false, injected = false
    const proof: Record<string, unknown> = { faultKind: 'controlled_native_process_transport_delay', originalSQL: 'COMMIT',
      replacementSQL: 'SELECT pg_sleep(0.5); COMMIT', fakeDDL: false, fakeQueryResults: false, disabledGuards: false }
    fixture.control.query = async (sql, _params, client, execute) => {
      if (!spent && /INSERT INTO\s+(?:public\.)?meta_recovery_archive_coverage_items/i.test(sql)) {
        spent = true
        const seconds = Math.max(0, deadline - Date.now() - 250) / 1000
        proof.earlierSQL = 'SELECT pg_sleep($1::double precision)'; proof.earlierSeconds = seconds
        await client.query('SELECT pg_sleep($1::double precision)', [seconds])
      }
      const finalizing = spent && !injected && sql === 'COMMIT'
        && (await client.query("SELECT count(*)::int AS n FROM meta_recovery_archives WHERE state='verified' AND build_status='finalized' AND sheet_id=$1", [fixture.sheetId])).rows[0].n === 1
      if (!finalizing) return execute()
      injected = true
      Object.assign(proof, (await client.query("SELECT current_setting('statement_timeout') AS statement_timeout,pg_current_xact_id()::text AS xid,pg_backend_pid()::int AS pid")).rows[0],
        { remainingAtDelayedCommitMs: deadline - Date.now(), elapsedAtDelayedCommitMs: Date.now() - started })
      const result = await client.query('SELECT pg_sleep(0.5); COMMIT')
      return Array.isArray(result) ? result[result.length - 1] : result
    }
    let settled = false, result: Awaited<ReturnType<ReturnType<typeof command>['capture']>> | undefined, error: unknown
    const pending = command({ limits: { maxBytes: 8 * 1024 * 1024, timeoutMs } }).capture(fixture.identity)
      .then((value) => { settled = true; result = value }, (caught) => { settled = true; error = caught; fixture.diagnostics.commandError(caught) })
    await new Promise((done) => setTimeout(done, Math.max(0, deadline - Date.now() + 20)))
    const atPublicDeadline = await state()
    proof.publicSettledAtDeadline = settled; proof.durableStateAtDeadline = atPublicDeadline[0]?.state
    await pending
    await new Promise((done) => setTimeout(done, 100))
    const after = await state()
    Object.assign(proof, { elapsedAtSettlementMs: Date.now() - started, injected, spent,
      returnedRecoverable: result?.state === 'recoverable', coarseError: error instanceof Error,
      durableStateAfterDelayedCommit: after[0]?.state, coverageAfterDelayedCommit: after[0]?.coverage })
    await writeFile(`${fixture.root}/controlled-delayed-commit-proof.json`, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
    console.log('owned_controlled_delayed_commit', JSON.stringify({ injected, spent,
      publicSettledAtDeadline: proof.publicSettledAtDeadline, durableStateAtDeadline: proof.durableStateAtDeadline,
      durableStateAfterDelayedCommit: after[0]?.state, elapsedAtSettlementMs: proof.elapsedAtSettlementMs }))
    expect(spent).toBe(true); expect(injected).toBe(true)
    expect(fixture.guards).toHaveLength(9); expect(fixture.guards.every((guard) => guard.tgenabled === 'O')).toBe(true)
    expect(after.every((row) => row.state !== 'verified'), 'controlled native delayed COMMIT published verified catalog after absolute attempt deadline').toBe(true)
    expect(result?.state).not.toBe('recoverable')
  })

  test('audit: natural native late coverage row lock is cancelled within absolute remaining budget before publication', async () => {
    const timeoutMs = 1500, deadline = Date.now() + timeoutMs
    fixture.diagnostics.start('natural-late-query', timeoutMs)
    let blocker: PoolClient | undefined
    let headCount = 0, spent = false, waiterPid = 0, statementTimeoutMs = 0, remainingMs = 0
    fixture.control.external = async (phase) => {
      if (phase !== 'head' || ++headCount !== 13) return
      blocker = await fixture.pool.connect()
      await blocker.query('BEGIN')
      await blocker.query('LOCK TABLE meta_recovery_archive_coverage_items IN ACCESS EXCLUSIVE MODE')
    }
    fixture.control.query = async (sql, _params, client, execute) => {
      if (!spent && /INSERT INTO\s+(?:public\.)?meta_sheet_section_revisions/i.test(sql)) {
        spent = true
        await client.query('SELECT pg_sleep($1::double precision)', [Math.max(0, deadline - Date.now() - 300) / 1000])
      }
      if (/INSERT INTO\s+(?:public\.)?meta_recovery_archive_coverage_items/i.test(sql)) {
        const row = (await client.query("SELECT pg_backend_pid()::int AS pid,current_setting('statement_timeout') AS statement_timeout")).rows[0]
        waiterPid = row.pid; remainingMs = deadline - Date.now()
        statementTimeoutMs = Number.parseFloat(row.statement_timeout) * (row.statement_timeout.endsWith('ms') ? 1 : 1000)
      }
      return execute()
    }
    let error: unknown, sawBlocked = false
    const pending = command({ limits: { maxBytes: 8 * 1024 * 1024, timeoutMs } }).capture(fixture.identity).catch((caught) => { error = caught; fixture.diagnostics.commandError(caught) })
    try {
      while (Date.now() < deadline - 20) {
        if (waiterPid && (await fixture.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [waiterPid])).rows[0].n === 1) { sawBlocked = true; break }
        await new Promise((done) => setTimeout(done, 10))
      }
      await new Promise((done) => setTimeout(done, Math.max(0, deadline - Date.now() + 60)))
      const stillWaiting = (await fixture.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [waiterPid])).rows[0].n
      const proof = { faultKind: 'native_natural_table_lock_query_barrier', sawBlocked, stillWaiting,
        statementTimeoutMs, remainingMs, waiterPid, actualLockSQL: 'LOCK TABLE meta_recovery_archive_coverage_items IN ACCESS EXCLUSIVE MODE',
        actualEarlierSQL: 'SELECT pg_sleep($1::double precision)', fakeDDL: false, disabledGuards: false }
      await writeFile(`${fixture.root}/natural-late-query-proof.json`, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
      console.log('owned_natural_late_query', JSON.stringify({ sawBlocked, stillWaiting, statementTimeoutWithinRemaining: statementTimeoutMs <= remainingMs + 50 }))
      expect(spent).toBe(true); expect(sawBlocked).toBe(true)
      expect(statementTimeoutMs).toBeLessThanOrEqual(remainingMs + 50)
      expect(stillWaiting, 'late native source query remained blocked after absolute attempt deadline').toBe(0)
    } finally {
      await new Promise((done) => setTimeout(done, Math.max(0, deadline - Date.now() + 200)))
      if (blocker) { await blocker.query('ROLLBACK'); blocker.release() }
      await pending
    }
    expect(error).toBeInstanceOf(Error)
    await expectAbandoned()
  })

  test('audit: active checkpoint trust floor advancing past the claimed anchor refuses publication after released RR capture', async () => {
    let changed = false
    let control: { sameCheckpoint: boolean; active: boolean; unpruned: boolean; floorAboveAnchor: boolean; changedRows: number; floor: string; anchor: string } | undefined
    fixture.control.external = async (phase) => {
      if (phase !== 'attachment-read' || changed) return
      changed = true
      await fixture.transaction(async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtext($1))', [canonicalSheetFenceKey(fixture.sheetId)])
        const before = (await query(`SELECT a.checkpoint_id,a.anchor_seq::text AS anchor
          FROM meta_recovery_archives a WHERE a.sheet_id=$1 AND a.state='building' AND a.build_status='active'`, [fixture.sheetId])).rows[0] as { checkpoint_id: string; anchor: string }
        const update = await query(`UPDATE meta_history_trust_checkpoints SET trusted_since_seq=$3::bigint+1
          WHERE id=$1 AND sheet_id=$2 AND state='active' AND pruned_at IS NULL`, [before.checkpoint_id, fixture.sheetId, before.anchor])
        const after = (await query(`SELECT t.id=$1 AS same_checkpoint,t.state='active' AS active,t.pruned_at IS NULL AS unpruned,
          t.trusted_since_seq>$3::bigint AS floor_above_anchor,t.trusted_since_seq::text AS floor
          FROM meta_history_trust_checkpoints t WHERE t.id=$1 AND t.sheet_id=$2`, [before.checkpoint_id, fixture.sheetId, before.anchor])).rows[0] as Record<string, unknown>
        control = { sameCheckpoint: after.same_checkpoint === true, active: after.active === true, unpruned: after.unpruned === true,
          floorAboveAnchor: after.floor_above_anchor === true, changedRows: update.rowCount ?? 0, floor: String(after.floor), anchor: before.anchor }
      })
    }
    let result: Awaited<ReturnType<ReturnType<typeof command>['capture']>> | undefined, error: unknown
    try { result = await command().capture(fixture.identity) } catch (caught) { error = caught }
    const rows = await state()
    console.log('owned_active_checkpoint_floor_drift', JSON.stringify({ ...control, claimCommitBeforeRR: fixture.claimCommitBeforeRR,
      callbackReached: fixture.observations.some((entry) => entry.phase === 'attachment-read'), recoverable: result?.state === 'recoverable',
      verified: rows[0]?.state === 'verified', history: await fixture.historyCount(), refused: error instanceof Error }))
    expect(fixture.guards).toHaveLength(9); expect(fixture.guards.every((guard) => guard.tgenabled === 'O')).toBe(true)
    expect(control).toMatchObject({ sameCheckpoint: true, active: true, unpruned: true, floorAboveAnchor: true, changedRows: 1 })
    expect(fixture.claimCommitBeforeRR).toEqual([true])
    expect(fixture.observations.some((entry) => entry.phase === 'attachment-read')).toBe(true)
    expect(rows.every((row) => row.state !== 'verified'), 'owned authority accepted an active checkpoint trust floor above its claimed archive anchor').toBe(true)
    expect(error).toBeInstanceOf(Error)
    await expectAbandoned(); expect((await state())[0].nonces).toBe(0)
  })
})
