import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import * as migration from '../../src/db/migrations/zzzz20261007120000_amend_recovery_archive_cleanup_anchor'
import { bindRecoveryArchiveOwnedClaim, readRecoveryArchiveCommittedClaim } from '../../src/multitable/recovery-archive-owned-claim'
import { bindRecoveryArchiveManualCommand } from '../../src/multitable/recovery-archive-manual-command'
import { runRecoveryArchiveOwnedTransaction } from '../../src/multitable/recovery-archive-owned-authority'
import type { SealQuery } from '../../src/multitable/recovery-archive-seals'
import { prepareArchiveWriterBlockCleanupTransaction } from '../../src/multitable/recovery-archive-writer-block'
import { createRecoveryArchiveOwnedCleanup } from '../../src/routes/univer-meta'
import { createOwnedComposerFixture, type OwnedComposerFixture } from '../utils/recovery-archive-owned-composer-fixture'

const armed = process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeRealDb = armed && process.env.DATABASE_URL ? describe : describe.skip
test('sentinel: owned-cleanup real-DB lane requires DATABASE_URL', () => {
  if (armed && !process.env.DATABASE_URL) throw new Error('recovery_archive_owned_cleanup_realdb_harness_missing_database_url')
})
let admin: Pool, fixture: OwnedComposerFixture, saved: (string | undefined)[]
const flags = ['MULTITABLE_RECOVERY_ARCHIVE_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE']
// Valid finite component policy: real three-second lease and one-second command budget.
// No fake clock, timestamp update or lease revival. Genuine process faults remain a separate gate.
const limits = { maxBytes: 8 * 1024 * 1024, timeoutMs: 1000 }
const policy = () => ({ ...fixture.policy, leaseSeconds: 3 })
const scope = () => { const { actorId, workspaceId, baseId, sheetId } = fixture.identity; return { actorId, workspaceId, baseId, sheetId } }
const authorize = async (query: SealQuery) =>
  (await query('SELECT 1 FROM meta_bases WHERE id=$1 AND owner_id=$2 AND workspace_id=$3',
    [fixture.identity.baseId, fixture.identity.actorId, fixture.identity.workspaceId])).rows.length === 1
function command() {
  return createRecoveryArchiveOwnedCleanup({ pool: fixture.nativePool, limits, policy: policy(),
    provider: fixture.provider, transactionDepth: fixture.transactionDepth })
}
function database() { return new Kysely<unknown>({ dialect: new PostgresDialect({ pool: fixture.pool }) }) }
async function claim() {
  const result = await bindRecoveryArchiveOwnedClaim(fixture.nativePool, authorize, policy(), limits)(fixture.identity)
  if (!result.claim) throw new Error('OWNED_CLEANUP_NATIVE_CLAIM_MISSING')
  return readRecoveryArchiveCommittedClaim(result.claim).generationOwner.generationId
}
async function expiry(generationId: string) {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    if ((await fixture.query('SELECT lease_expires_at<=clock_timestamp() AS expired FROM meta_recovery_archives WHERE generation_id=$1::uuid', [generationId])).rows[0]?.expired === true) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('OWNED_CLEANUP_NATIVE_REAL_EXPIRY_MISSING')
}
async function durable(generationId: string) {
  return (await fixture.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY ordinal) FROM meta_recovery_archive_snapshot_reservations r WHERE generation_id=$1::uuid) AS reservations,
    (SELECT jsonb_agg(to_jsonb(n) ORDER BY nonce) FROM meta_recovery_archive_nonce_reservations n WHERE generation_id=$1::uuid) AS nonces,
    (SELECT key_id FROM meta_recovery_archives WHERE generation_id=$1::uuid) AS key,
    (SELECT count(*)::int FROM meta_recovery_archives a JOIN meta_recovery_archives b ON a.key_id=b.key_id WHERE a.generation_id=$1::uuid) AS key_references,
    (SELECT count(*)::int FROM meta_record_history_operations WHERE sheet_id=$2) AS history`, [generationId, fixture.sheetId])).rows[0]
}
async function posture(generationId: string) {
  return (await fixture.query(`SELECT owner_kind,owner_fence::text,state,build_status,coverage_status,
    (SELECT count(*)::int FROM meta_recovery_archive_attachment_refs WHERE generation_id=a.generation_id) AS pins,
    (SELECT count(*)::int FROM meta_recovery_archive_staging_objects WHERE generation_id=a.generation_id AND object_state NOT IN ('absent','deleted')) AS outstanding,
    (SELECT count(*)::int FROM meta_recovery_archive_staging_objects WHERE generation_id=a.generation_id AND terminal_receipt_sha256 IS NULL) AS missing_receipts
    FROM meta_recovery_archives a WHERE generation_id=$1::uuid`, [generationId])).rows[0]
}
function watchRelease(generationId: string) {
  const release: Array<{ xid: string; outstanding: number; missing_receipts: number }> = []
  fixture.control.query = async (sql, params, client, execute) => {
    if (sql.includes('meta_recovery_archive_release_abandoned_source_pin(')) {
      release.push((await client.query(`SELECT pg_current_xact_id()::text AS xid,
        count(*) FILTER (WHERE object_state NOT IN ('absent','deleted'))::int AS outstanding,
        count(*) FILTER (WHERE terminal_receipt_sha256 IS NULL)::int AS missing_receipts
        FROM meta_recovery_archive_staging_objects WHERE generation_id=$1::uuid`, [generationId])).rows[0])
    }
    return execute()
  }
  return release
}
function observeCommitRefusal() {
  const states: string[] = []
  fixture.control.query = async (sql, _params, _client, execute) => {
    try { return await execute() } catch (error) {
      if (sql === 'COMMIT') states.push((error as { code: string }).code)
      throw error
    }
  }
  return states
}
async function assertOrigin() {
  expect((await fixture.query('SHOW session_replication_role')).rows).toEqual([{ session_replication_role: 'origin' }])
  const result = await fixture.query(`SELECT count(*)::int AS guards,bool_and(tgenabled='O') AS enabled
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('meta_recovery_archives'::regclass,
      'meta_recovery_archive_snapshot_reservations'::regclass,'meta_recovery_archive_attachment_refs'::regclass,
      'meta_recovery_archive_staging_objects'::regclass,'meta_record_history_operations'::regclass)`)
  expect(result.rows[0].guards).toBeGreaterThan(8); expect(result.rows[0].enabled).toBe(true)
}
async function abandon(generationId: string) {
  await fixture.transaction(async query => {
    await prepareArchiveWriterBlockCleanupTransaction(query, fixture.sheetId)
    await query('SELECT key_id FROM meta_recovery_archive_keys WHERE key_id=$1 FOR UPDATE', [fixture.policy.keyId])
    await query('SELECT id FROM meta_sheets WHERE id=$1 FOR UPDATE', [fixture.sheetId])
    await query('SELECT generation_id FROM meta_recovery_archives WHERE generation_id=$1::uuid FOR UPDATE', [generationId])
    await query("UPDATE meta_recovery_archives SET build_status='abandoned' WHERE generation_id=$1::uuid AND build_status='active' AND lease_expires_at<=clock_timestamp()", [generationId])
  })
}
async function lowerTransition(generationId: string) {
  await runRecoveryArchiveOwnedTransaction(fixture.nativePool, limits.timeoutMs, { value: 0 }, async query => {
    await prepareArchiveWriterBlockCleanupTransaction(query, fixture.sheetId)
    await query('SELECT key_id FROM meta_recovery_archive_keys WHERE key_id=$1 FOR UPDATE', [fixture.policy.keyId])
    await query('SELECT id FROM meta_sheets WHERE id=$1 FOR UPDATE', [fixture.sheetId])
    await query('SELECT generation_id FROM meta_recovery_archives WHERE generation_id=$1::uuid FOR UPDATE', [generationId])
    await query(`SELECT meta_recovery_archive_claim_abandoned_cleanup($1::uuid,'archive_builder',$2,1,
      'archive_cleanup',$3,clock_timestamp()+interval '3 seconds')`, [generationId, generationId, randomUUID()])
  })
}
const corruptions = {
  missing: "DELETE FROM meta_recovery_archive_snapshot_reservations WHERE generation_id=$1::uuid AND ordinal=1",
  owner: "UPDATE meta_recovery_archive_snapshot_reservations SET owner_id='synthetic-wrong-owner' WHERE generation_id=$1::uuid AND ordinal=1",
  fence: "UPDATE meta_recovery_archive_snapshot_reservations SET owner_fence=2 WHERE generation_id=$1::uuid AND ordinal=1",
  scope: "UPDATE meta_recovery_archive_snapshot_reservations SET sheet_id='synthetic-wrong-sheet' WHERE generation_id=$1::uuid AND ordinal=1",
  vector: "UPDATE meta_recovery_archive_snapshot_reservations SET source_vector_hash=repeat('0',64) WHERE generation_id=$1::uuid AND ordinal=1",
  creation: "UPDATE meta_recovery_archive_snapshot_reservations SET created_at=created_at+interval '1 microsecond' WHERE generation_id=$1::uuid AND ordinal=1",
  coherence: "UPDATE meta_recovery_archive_snapshot_reservations SET reservation_kind='section_checkpoint' WHERE generation_id=$1::uuid AND ordinal=1",
  anchor: "UPDATE meta_recovery_archive_snapshot_reservations SET operation_id=gen_random_uuid() WHERE generation_id=$1::uuid AND ordinal=10",
} as const

describeRealDb('native immutable cleanup-anchor handoff', () => {
  beforeAll(() => { admin = new Pool({ connectionString: process.env.DATABASE_URL }); saved = flags.map(name => process.env[name]); flags.forEach(name => { process.env[name] = 'true' }) })
  beforeEach(async () => { fixture = await createOwnedComposerFixture(admin); await assertOrigin() }, 60000)
  afterEach(async context => {
    if (fixture) {
      await fixture.persistFailureDiagnostics(context.task.result?.state, context.task.result?.errors)
      await fixture.dispose()
    }
  }, 60000)
  afterAll(async () => { flags.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] }); await admin.end() })

  test('predecessor naturally fails at first cleanup COMMIT; amended canonical command completes without publishing its future anchor', async () => {
    await database().transaction().execute(migration.down)
    const generationId = await claim(), before = await durable(generationId)
    await expiry(generationId)
    const commitStates = observeCommitRefusal()
    await expect(command()({ identity: scope(), generationId })).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED')
    expect(commitStates).toEqual(['23514']); fixture.control.query = undefined
    expect(await posture(generationId)).toMatchObject({ owner_kind: 'archive_builder', owner_fence: '1', build_status: 'active', pins: 2, outstanding: 2 })
    expect(await durable(generationId)).toEqual(before)
    await database().transaction().execute(migration.up)
    fixture.diagnostics.start('canonical-cleanup', limits.timeoutMs)
    const release = watchRelease(generationId)
    expect(await command()({ identity: scope(), generationId })).toEqual({ outcome: 'complete', confirmed: 2 })
    expect(await posture(generationId)).toEqual({ owner_kind: 'archive_cleanup', owner_fence: '2', state: 'building', build_status: 'abandoned', coverage_status: 'incomplete', pins: 0, outstanding: 0, missing_receipts: 0 })
    expect(await durable(generationId)).toEqual(before)
    expect(release).toHaveLength(2); expect(new Set(release.map(row => row.xid)).size).toBe(1)
    release.forEach(row => expect(row.xid).toMatch(/^[1-9][0-9]*$/))
    expect(release.map(({ outstanding, missing_receipts }) => ({ outstanding, missing_receipts }))).toEqual([{ outstanding: 0, missing_receipts: 0 }, { outstanding: 0, missing_receipts: 0 }])
    await expect(database().transaction().execute(migration.down)).rejects.toThrow('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_IN_USE')
    expect(await durable(generationId)).toEqual(before)
  }, 30000)

  test('prepared upload failure retains nonce tombstones and immutable namespace inventory through actual cleanup', async () => {
    let uploaded = false
    fixture.control.external = async phase => {
      if (phase === 'head') { uploaded = true; throw new Error('SYNTHETIC_POST_PUT_HEAD_RESPONSE_LOST') }
    }
    await expect(bindRecoveryArchiveManualCommand(fixture.transaction, authorize, fixture.runtime, policy(),
      fixture.readContentAddressed, { pool: fixture.nativePool, limits,
        readContentAddressedBounded: fixture.readContentAddressedBounded }).capture(fixture.identity)).rejects.toThrow()
    fixture.control.external = undefined
    expect(uploaded).toBe(true)
    const generationId = (await fixture.query("SELECT generation_id::text FROM meta_recovery_archives WHERE state='building'")).rows[0].generation_id
    const inventory = async () => (await fixture.query(`SELECT jsonb_agg(to_jsonb(b) ORDER BY object_id) AS bindings
      FROM meta_recovery_archive_abandoned_bindings b WHERE generation_id=$1::uuid`, [generationId])).rows[0].bindings
    const before = await durable(generationId), bindings = await inventory()
    expect(before.nonces).toHaveLength(12); expect(bindings).toHaveLength(13)
    expect(new Set(bindings.map((binding: { store_id: string }) => binding.store_id))).toEqual(new Set([fixture.provider.storeId]))
    expect(await posture(generationId)).toMatchObject({ build_status: 'abandoned', pins: 2, outstanding: 13 })
    await expiry(generationId)
    const release = watchRelease(generationId)
    const cleanup = createRecoveryArchiveOwnedCleanup({ pool: fixture.nativePool, limits: fixture.limits, policy: fixture.policy,
      provider: fixture.provider, transactionDepth: fixture.transactionDepth })
    fixture.diagnostics.start('prepared-upload-cleanup', fixture.limits.timeoutMs)
    expect(await cleanup({ identity: scope(), generationId })).toEqual({ outcome: 'complete', confirmed: 13 })
    expect(await posture(generationId)).toMatchObject({ owner_fence: '2', pins: 0, outstanding: 0, missing_receipts: 0 })
    expect(await durable(generationId)).toEqual(before); expect(await inventory()).toEqual(bindings)
    expect(release).toHaveLength(2); expect(new Set(release.map(row => row.xid)).size).toBe(1)
    release.forEach(row => expect(row).toMatchObject({ outstanding: 0, missing_receipts: 0 }))
  }, 30000)

  test('a genuine committed higher owner with lost COMMIT response expires and completes under fence3', async () => {
    const generationId = await claim(), before = await durable(generationId)
    await expiry(generationId)
    let release!: () => void, stopped = false
    const pause = new Promise<void>(resolve => { release = resolve })
    fixture.control.query = async (sql, _params, _client, execute) => {
      const result = await execute()
      if (sql === 'COMMIT' && !stopped) { stopped = true; await pause }
      return result
    }
    const cleanup = command()
    try {
      await expect(cleanup({ identity: scope(), generationId })).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED')
      expect(stopped).toBe(true)
      expect(await posture(generationId)).toMatchObject({ owner_kind: 'archive_cleanup', owner_fence: '2', pins: 2, outstanding: 2 })
      await expiry(generationId)
    } finally { release(); fixture.control.query = undefined; await cleanup.drain() }
    expect(await command()({ identity: scope(), generationId })).toEqual({ outcome: 'complete', confirmed: 2 })
    expect(await posture(generationId)).toMatchObject({ owner_fence: '3', pins: 0, outstanding: 0, missing_receipts: 0 })
    expect(await durable(generationId)).toEqual(before)
  }, 30000)

  test.each(Object.keys(corruptions) as Array<keyof typeof corruptions>)('isolated deferred RI refuses %s original roster at natural COMMIT', async kind => {
    const generationId = await claim()
    await expiry(generationId); await abandon(generationId)
    // Deliberate corruption setup ONLY, in this namespaced disposable fixture. The tested
    // transition is a separate genuine canonical TX under origin and every enabled guard.
    await fixture.transaction(async query => {
      await prepareArchiveWriterBlockCleanupTransaction(query, fixture.sheetId)
      await query("SET LOCAL session_replication_role='replica'")
      await query(corruptions[kind], [generationId])
    })
    await assertOrigin()
    const commitStates = observeCommitRefusal()
    await expect(lowerTransition(generationId)).rejects.toMatchObject({ code: '23514', message: 'recovery_archive_binding_invalid' })
    expect(commitStates).toEqual(['23514']); fixture.control.query = undefined
    expect(await posture(generationId)).toMatchObject({ owner_kind: 'archive_builder', owner_fence: '1', pins: 2, outstanding: 2 })
    await assertOrigin()
  })

  test('canonical command refuses live lease, foreign scope and actor without changing durable evidence', async () => {
    const generationId = await claim(), before = await durable(generationId)
    for (const identity of [scope(), { ...scope(), sheetId: 'synthetic-foreign-sheet' }, { ...scope(), actorId: randomUUID() }]) {
      await expect(command()({ identity, generationId })).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED')
      expect(await durable(generationId)).toEqual(before)
    }
  })

  test('actual verified publication cannot enter cleanup posture', async () => {
    const result = await bindRecoveryArchiveManualCommand(fixture.transaction, authorize, fixture.runtime, fixture.policy,
      fixture.readContentAddressed, { pool: fixture.nativePool, limits: fixture.limits, readContentAddressedBounded: fixture.readContentAddressedBounded }).capture(fixture.identity)
    const generationId = (await fixture.query("SELECT generation_id::text FROM meta_recovery_archives WHERE state='verified'")).rows[0]?.generation_id
    expect(result.state).toBe('recoverable'); expect(typeof generationId).toBe('string')
    const before = await durable(generationId)
    await expect(command()({ identity: scope(), generationId })).rejects.toThrow('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED')
    expect(await durable(generationId)).toEqual(before)
  })

  test.each(['function', 'trigger'] as const)('delete-guard %s drift refuses up without replacing predecessor; fixture rollback restores protection', async kind => {
    await database().transaction().execute(migration.down)
    const read = async () => (await fixture.query("SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid='meta_recovery_archives_claim_anchor_reservation_guard()'::regprocedure")).rows[0].hash
    expect(await read()).toBe('9d0e0a0832d262412b4464ba103ace82')
    // Transactional deliberate drift ONLY in the disposable synthetic fixture. No
    // lifecycle command runs with this drift; rejection rolls back the entire setup.
    await expect(database().transaction().execute(async db => {
      if (kind === 'function') await sql.raw(`CREATE OR REPLACE FUNCTION public.meta_recovery_archives_claim_anchor_operation_delete_guard()
        RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog, public AS $$ BEGIN RETURN OLD; END $$`).execute(db)
      else await sql.raw('ALTER TABLE public.meta_record_history_operations DISABLE TRIGGER trg_mrho_claim_anchor_delete_guard').execute(db)
      try { await migration.up(db) } catch (error) {
        const observed = await sql<{ hash: string }>`SELECT md5(prosrc) AS hash FROM pg_proc
          WHERE oid='meta_recovery_archives_claim_anchor_reservation_guard()'::regprocedure`.execute(db)
        expect(observed.rows[0].hash).toBe('9d0e0a0832d262412b4464ba103ace82')
        throw error
      }
    })).rejects.toThrow('RECOVERY_ARCHIVE_CLEANUP_ANCHOR_SCHEMA_DRIFT')
    expect(await read()).toBe('9d0e0a0832d262412b4464ba103ace82')
    await assertOrigin()
    await database().transaction().execute(migration.up)
  })

  test('safe empty rollback restores exact predecessor and reapply preserves the replacement', async () => {
    const read = async () => (await fixture.query("SELECT md5(prosrc) AS hash FROM pg_proc WHERE oid='meta_recovery_archives_claim_anchor_reservation_guard()'::regprocedure")).rows[0].hash
    const replacement = await read()
    await database().transaction().execute(migration.down)
    expect(await read()).toBe('9d0e0a0832d262412b4464ba103ace82')
    await database().transaction().execute(migration.up)
    expect(await read()).toBe(replacement); await assertOrigin()
  })
})
