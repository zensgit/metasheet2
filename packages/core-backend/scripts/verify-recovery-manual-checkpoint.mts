/** Synthetic full-schema checkpoint acceptance; never use a customer database. */
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import type { RecoveryArchiveSnapshotReservationPlan } from '../src/multitable/recovery-archive-section-bootstrap'

const require = createRequire(import.meta.url)
const manualAdmission = require('../src/multitable/recovery-archive-manual-admission.ts') as typeof import('../src/multitable/recovery-archive-manual-admission')
const manualRequests = require('../src/multitable/recovery-archive-manual-request.ts') as typeof import('../src/multitable/recovery-archive-manual-request')
const manualRequestMigration = require('../src/db/migrations/zzzz20260918140000_create_recovery_archive_manual_requests.ts') as typeof import('../src/db/migrations/zzzz20260918140000_create_recovery_archive_manual_requests')
const preparedUpload = require('../src/multitable/recovery-archive-prepared-upload.ts') as typeof import('../src/multitable/recovery-archive-prepared-upload')
const archiveCrypto = require('../src/multitable/recovery-archive-crypto.ts') as typeof import('../src/multitable/recovery-archive-crypto')
const archiveContract = require('../src/multitable/recovery-archive-contract.ts') as typeof import('../src/multitable/recovery-archive-contract')
const sectionRows = require('../src/multitable/recovery-archive-section-rows.ts') as typeof import('../src/multitable/recovery-archive-section-rows')
const manifest = require('../src/multitable/recovery-archive-manifest.ts') as typeof import('../src/multitable/recovery-archive-manifest')
const prepared = require('../src/multitable/recovery-archive-prepared-capture.ts') as typeof import('../src/multitable/recovery-archive-prepared-capture')
const preparedMigration = require('../src/db/migrations/zzzz20260918130000_create_recovery_archive_prepared_captures.ts') as typeof import('../src/db/migrations/zzzz20260918130000_create_recovery_archive_prepared_captures')
const bootstrap = require('../src/multitable/recovery-archive-section-bootstrap.ts') as typeof import('../src/multitable/recovery-archive-section-bootstrap')
const vectors = require('../src/multitable/recovery-archive-source-vector.ts') as typeof import('../src/multitable/recovery-archive-source-vector')
const checkpoints = require('../src/multitable/recovery-archive-section-checkpoint.ts') as typeof import('../src/multitable/recovery-archive-section-checkpoint')
const migration = require('../src/db/migrations/zzzz20260918120000_add_recovery_archive_section_checkpoints.ts') as typeof import('../src/db/migrations/zzzz20260918120000_add_recovery_archive_section_checkpoints')
assert.equal(process.env.NODE_ENV, 'test', 'SYNTHETIC_TEST_MODE_REQUIRED')
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const adminUrl = new URL(process.env.TM_MANUAL_TEST_ADMIN_URL ?? 'http://invalid')
assert.equal(adminUrl.protocol, 'postgresql:')
assert.equal(adminUrl.hostname, '127.0.0.1')
assert.equal(adminUrl.username, 'tm_manual')
assert.equal(adminUrl.pathname, '/postgres')
assert.equal(adminUrl.password, '')
assert.equal(adminUrl.search, '')
assert.equal(adminUrl.hash, '')
assert.ok(Number(adminUrl.port) >= 1024 && !['5432', '5433', '5435'].includes(adminUrl.port))
const pgdata = await realpath(process.env.TM_MANUAL_TEST_PGDATA ?? '/invalid')
assert.equal(basename(pgdata), 'pgdata')
assert.match(basename(dirname(pgdata)), /^tm-manual-checkpoint-cluster-[a-zA-Z0-9]+$/)
assert.equal(dirname(dirname(pgdata)), await realpath(tmpdir()))
const connection = { host: '127.0.0.1', port: Number(adminUrl.port), user: 'tm_manual' }
const admin = new Client({ ...connection, database: 'postgres', connectionTimeoutMillis: 5000 })
const database = `tm_manual_checkpoint_${randomUUID().replaceAll('-', '')}`
const root = await mkdtemp(join(tmpdir(), 'tm-manual-checkpoint-run-'))
let created = false
let client: Client | undefined
let db: Kysely<unknown> | undefined
try {
  await admin.connect()
  assert.equal(await realpath((await admin.query('SHOW data_directory')).rows[0].data_directory), pgdata)
  assert.equal((await admin.query('SELECT current_user AS owner')).rows[0].owner, 'tm_manual')
  await admin.query(`CREATE DATABASE "${database}"`)
  created = true
  await writeFile(`${root}/config.json`, '{}', { mode: 0o600 })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: root,
    NODE_ENV: 'test', METASHEET_ENV_DIR: root, CONFIG_FILE: `${root}/config.json`,
    DATABASE_URL: `postgresql://tm_manual@127.0.0.1:${connection.port}/${database}`,
    SECRET_PROVIDER: 'env', JWT_SECRET: randomUUID(),
  }
  for (const phase of ['fresh', 'replay']) {
    const run = spawnSync('pnpm', ['--filter', '@metasheet/core-backend', 'migrate'], {
      cwd: repo, env, encoding: 'utf8', timeout: 240000, maxBuffer: 16 * 1024 * 1024,
    })
    // Only failed synthetic migration output is printed; the temporary file is removed below.
    await writeFile(`${root}/${phase}.log`, `${run.stdout ?? ''}${run.stderr ?? ''}`, { mode: 0o600 })
    if (run.status !== 0) console.error((run.stderr ?? '').slice(-8000))
    assert.equal(run.status, 0, `MIGRATION_${phase.toUpperCase()}_FAILED`)
  }
  // Historical migration tests must unwind newer layers and restore them. Run
  // the actual CI replay/neighbor entrypoints before the new protocol tests.
  const neighbors = [
    ['tsx', 'tests/integration/multitable-timemachine-migration-replay-realdb.verify.ts'],
    ['vitest', '--config', 'vitest.integration.config.ts', 'run',
      'tests/integration/multitable-recovery-archive-section-causality-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-claim-anchor-realdb.test.ts', '--reporter=dot'],
    ['vitest', '--config', 'vitest.integration.config.ts', 'run',
      'tests/integration/multitable-recovery-archive-catalog-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-coverage-binding-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-source-pin-authority-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-object-receipt-authority-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-stale-pin-cleanup-realdb.test.ts',
      'tests/integration/multitable-recovery-archive-legal-hold-authority-realdb.test.ts', '--reporter=dot'],
    // Prove old migration suites restored the complete current catalog, not just their own layer.
    ['tsx', 'tests/integration/multitable-timemachine-migration-replay-realdb.verify.ts'],
  ]
  for (const args of neighbors) {
    const run = spawnSync('pnpm', ['--filter', '@metasheet/core-backend', 'exec', ...args], {
      cwd: repo, env: { ...env, METASHEET_REAL_DB_TEST_STEP: '1' }, encoding: 'utf8',
      timeout: 240000, maxBuffer: 16 * 1024 * 1024,
    })
    console.log(run.status === 0 ? (run.stdout ?? '').slice(-4000) : (run.stdout ?? ''))
    if (run.status !== 0) console.error(run.stderr ?? '')
    assert.equal(run.status, 0, 'MIGRATION_NEIGHBOR_FAILED')
  }
  client = new Client({ ...connection, database })
  await client.connect()
  const query = (text: string, params?: unknown[]) => client!.query(text, params)
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ ...connection, database, max: 1 }) }) })
  const nonceObjects = require('../src/db/migrations/zzzz20260919130000_extend_archive_nonce_object_identity.ts') as typeof import('../src/db/migrations/zzzz20260919130000_extend_archive_nonce_object_identity')
  for (const operation of [nonceObjects.up, nonceObjects.down, nonceObjects.down, nonceObjects.up, nonceObjects.up]) {
    await db.transaction().execute(operation)
  }
  for (const tamper of [
    `ALTER TABLE meta_recovery_archive_nonce_reservations DROP CONSTRAINT chk_meta_recovery_archive_nonce_reservation_object_name,
      ADD CONSTRAINT chk_meta_recovery_archive_nonce_reservation_object_name CHECK (true)`,
    `ALTER TABLE meta_recovery_archive_nonce_reservations DROP CONSTRAINT uq_meta_recovery_archive_nonce_reservation_generation_section,
      ADD CONSTRAINT uq_meta_recovery_archive_nonce_reservation_generation_section UNIQUE(generation_id,section_name) DEFERRABLE`,
    `ALTER TABLE meta_recovery_archive_nonce_reservations DISABLE TRIGGER trg_meta_recovery_archive_nonce_reservation_guard_row`,
    `ALTER TABLE meta_recovery_archive_nonce_reservations DISABLE TRIGGER trg_meta_recovery_archive_nonce_reservation_guard_truncate`,
    `ALTER TABLE meta_recovery_archive_nonce_reservations ADD CONSTRAINT chk_meta_recovery_archive_nonce_reservation_section_name
      CHECK (section_name NOT LIKE 'attachment:%')`,
    `CREATE OR REPLACE FUNCTION public.meta_recovery_archive_reserve_nonce(p_dek_fingerprint text,p_nonce text,
      p_generation_id uuid,p_section_name text,p_aead_algorithm text,p_format_version integer)
      RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RETURN; END $$`,
    `CREATE OR REPLACE FUNCTION public.meta_recovery_archive_nonce_reservation_guard_row()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$`,
  ]) {
    await assert.rejects(db.transaction().execute(async (tx) => {
      await sql.raw(tamper).execute(tx)
      await nonceObjects.up(tx)
    }), { message: 'RECOVERY_ARCHIVE_NONCE_OBJECT_SCHEMA_DRIFT' })
  }
  const objectGeneration = randomUUID()
  const objectIdentity = `attachment:${createHash('sha256').update(`att_${randomUUID()}`).digest('hex')}`
  const nonceFingerprint = randomBytes(32).toString('hex')
  const indexNonce = randomBytes(12).toString('hex')
  const attachmentNonce = randomBytes(12).toString('hex')
  const reserveNonce = (nonce: string, object: string, fingerprint = nonceFingerprint) => query(
    `SELECT public.meta_recovery_archive_reserve_nonce($1,$2,$3::uuid,$4,'aes-256-gcm',1)`,
    [fingerprint, nonce, objectGeneration, object])
  await reserveNonce(indexNonce, 'attachments_index')
  await reserveNonce(attachmentNonce, objectIdentity)
  await assert.rejects(reserveNonce(indexNonce, `attachment:${randomBytes(32).toString('hex')}`),
    { message: 'recovery_archive_nonce_reservation_conflict' })
  await assert.rejects(reserveNonce(randomBytes(12).toString('hex'), objectIdentity),
    { message: 'recovery_archive_nonce_reservation_conflict' })
  await assert.rejects(reserveNonce(attachmentNonce, 'records'),
    { message: 'recovery_archive_nonce_reservation_conflict' })
  for (const invalid of ['attachment:', 'attachment:not-a-uuid', `attachment:${randomUUID().toUpperCase()}`, 'unknown']) {
    await assert.rejects(reserveNonce(randomBytes(12).toString('hex'), invalid),
      { message: 'recovery_archive_nonce_reservation_shape_invalid' })
  }
  await assert.rejects(db.transaction().execute(nonceObjects.down),
    { message: 'RECOVERY_ARCHIVE_NONCE_OBJECT_DOWN_IN_USE' })
  for (const text of [
    `UPDATE meta_recovery_archive_nonce_reservations SET section_name=section_name WHERE generation_id=$1`,
    `DELETE FROM meta_recovery_archive_nonce_reservations WHERE generation_id=$1`,
  ]) await assert.rejects(query(text, [objectGeneration]), { message: 'recovery_archive_nonce_reservation_immutable' })
  await assert.rejects(query('TRUNCATE meta_recovery_archive_nonce_reservations'),
    { message: 'recovery_archive_nonce_reservation_immutable' })
  for (const mutation of [
    { constraint: 'pk_meta_recovery_archive_nonce_reservations', nonce: indexNonce, identity: `attachment:${randomBytes(32).toString('hex')}` },
    { constraint: 'uq_meta_recovery_archive_nonce_reservation_generation_section', nonce: randomBytes(12).toString('hex'), identity: objectIdentity },
  ]) {
    // Removing either arbiter must make the real refusal assertion fail; rollback restores it.
    await assert.rejects(db.transaction().execute(async (tx) => {
      await sql.raw(`ALTER TABLE meta_recovery_archive_nonce_reservations DROP CONSTRAINT ${mutation.constraint}`).execute(tx)
      await assert.rejects(sql`SELECT public.meta_recovery_archive_reserve_nonce(
        ${nonceFingerprint},${mutation.nonce},${objectGeneration}::uuid,${mutation.identity},'aes-256-gcm',1)`.execute(tx),
      { message: 'recovery_archive_nonce_reservation_conflict' })
    }), { code: 'ERR_ASSERTION' })
  }
  await db.transaction().execute(nonceObjects.up)
  console.log('PASS: attachment/index nonce identities coexist; cross-object nonce reuse and second object ciphertext refuse; drift and populated rollback refuse')
  for (const operation of [manualRequestMigration.up, manualRequestMigration.down,
    manualRequestMigration.down, manualRequestMigration.up, manualRequestMigration.up]) {
    await db.transaction().execute(operation)
  }
  for (const tamper of [
    'ALTER TABLE public.meta_recovery_archive_manual_requests ALTER COLUMN workspace_id DROP NOT NULL',
    'ALTER TABLE public.meta_recovery_archive_manual_requests DISABLE TRIGGER trg_mramr_row',
    `ALTER TABLE public.meta_recovery_archive_manual_requests
      DROP CONSTRAINT meta_recovery_archive_manual_requests_generation_id_key,
      ADD UNIQUE(generation_id) DEFERRABLE INITIALLY IMMEDIATE`,
    `CREATE OR REPLACE FUNCTION public.meta_recovery_archive_manual_request_guard()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$`,
  ]) {
    await assert.rejects(db.transaction().execute(async (tx) => {
      await sql.raw(tamper).execute(tx)
      await manualRequestMigration.up(tx)
    }), { message: 'RECOVERY_ARCHIVE_MANUAL_REQUEST_SCHEMA_DRIFT' })
  }
  for (const operation of [migration.up, migration.down, migration.down, migration.up, migration.up]) {
    await db.transaction().execute(operation)
  }
  const drift = { message: 'RECOVERY_ARCHIVE_CHECKPOINT_SCHEMA_DRIFT' }
  await assert.rejects(db.transaction().execute(async (tx) => {
    await sql.raw(`ALTER TABLE public.meta_sheet_section_revisions
      DROP CONSTRAINT chk_mssr_payload_or_tombstone,
      ADD CONSTRAINT chk_mssr_payload_or_tombstone CHECK (true)`).execute(tx)
    await migration.up(tx)
  }), drift)
  await assert.rejects(db.transaction().execute(async (tx) => {
    await sql.raw('ALTER TABLE public.meta_sheet_section_revisions DISABLE TRIGGER trg_mssr_guard_row').execute(tx)
    await migration.up(tx)
  }), drift)
  await assert.rejects(db.transaction().execute(async (tx) => {
    await sql.raw(`CREATE OR REPLACE FUNCTION public.meta_sheet_section_revisions_guard_row()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public
      AS $$ BEGIN RETURN NEW; END $$`).execute(tx)
    await migration.up(tx)
  }), drift)
  await assert.rejects(db.transaction().execute(async (tx) => {
    await sql.raw(`CREATE OR REPLACE FUNCTION public.meta_recovery_archive_section_bootstrap_marker_guard_row()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public
      AS $$ BEGIN RETURN NEW; END $$`).execute(tx)
    await migration.up(tx)
  }), drift)
  await assert.rejects(db.transaction().execute(async (tx) => {
    await sql.raw('ALTER TABLE public.meta_recovery_archive_section_bootstrap_markers DISABLE TRIGGER trg_mrasbm_guard_row').execute(tx)
    await migration.up(tx)
  }), drift)
  await db.transaction().execute(migration.up)
  await query(`
    INSERT INTO meta_bases(id,name,workspace_id) VALUES ('b','Synthetic','w');
    INSERT INTO meta_sheets(id,name,base_id) VALUES ('s','Synthetic','b'),('no-genesis','Synthetic','b');
    INSERT INTO meta_history_trust_checkpoints(id,sheet_id,state,trusted_since_seq)
      VALUES ('trust','s','active',1),('no-genesis-trust','no-genesis','active',1);
    INSERT INTO meta_recovery_archive_keys(key_id) VALUES ('synthetic-key');
  `)

  type Plan = RecoveryArchiveSnapshotReservationPlan
  async function claim(kind: 'section_bootstrap' | 'section_checkpoint', sheetId = 's', useHelper = false,
    shortLifetime?: 'lease' | 'expiry'): Promise<Plan> {
    const allocated = useHelper
      ? await checkpoints.allocateRecoveryArchiveCheckpointIdentities(query)
      : await bootstrap.allocateRecoveryArchiveSnapshotIdentities(query)
    const heads = allocated.sections.map((section) => ({
      sourceHeadKind: kind, sectionKind: section.sectionKind,
      operationId: section.operationId, headSeq: section.endpointSeq,
    }))
    const sourceVectorHash = (kind === 'section_bootstrap'
      ? vectors.computeRecoveryArchiveSourceVectorHash(heads)
      : vectors.computeRecoveryArchiveCheckpointVectorHash(heads)).hash
    const plan: Plan = {
      ...allocated, generationId: randomUUID(), sheetId, sourceVectorHash,
      ownerKind: 'archive_builder', ownerId: 'synthetic-builder', ownerFence: '1',
    }
    await query(`INSERT INTO meta_recovery_archives (
      generation_id,workspace_id,base_id,sheet_id,anchor_operation_id,anchor_seq,
      checkpoint_id,source_vector_hash,key_id,owner_kind,owner_id,owner_fence,
      lease_expires_at,expires_at
    ) VALUES ($1::uuid,'w','b',$2,$3::uuid,$4::bigint,$5,$6,'synthetic-key',
      $7,$8,1,clock_timestamp()+CASE WHEN $9::text='lease' THEN interval '1 second' ELSE interval '1 hour' END,
      clock_timestamp()+CASE WHEN $9::text='expiry' THEN interval '1 second' ELSE interval '2 hours' END)`,
    [plan.generationId,sheetId,plan.snapshotOperationId,plan.snapshotSeq,
      sheetId === 's' ? 'trust' : 'no-genesis-trust',sourceVectorHash,plan.ownerKind,plan.ownerId,shortLifetime ?? null])
    if (kind === 'section_bootstrap') {
      return bootstrap.persistRecoveryArchiveSnapshotReservations(query, plan, allocated)
    }
    if (useHelper) return checkpoints.persistRecoveryArchiveCheckpointReservations(query, plan, allocated)
    for (const section of plan.sections) {
      await query(`INSERT INTO meta_recovery_archive_snapshot_reservations (
        generation_id,sheet_id,source_vector_hash,owner_kind,owner_id,owner_fence,
        ordinal,reservation_kind,section_kind,operation_id,endpoint_seq
      ) VALUES ($1::uuid,$2,$3,$4,$5,1,$6,'section_checkpoint',$7,$8::uuid,$9::bigint)`,
      [plan.generationId,sheetId,sourceVectorHash,plan.ownerKind,plan.ownerId,
        section.ordinal,section.sectionKind,section.operationId,section.endpointSeq])
    }
    await query(`INSERT INTO meta_recovery_archive_snapshot_reservations (
      generation_id,sheet_id,source_vector_hash,owner_kind,owner_id,owner_fence,
      ordinal,reservation_kind,section_kind,operation_id,endpoint_seq
    ) VALUES ($1::uuid,$2,$3,$4,$5,1,10,'archive_snapshot',NULL,$6::uuid,$7::bigint)`,
    [plan.generationId,sheetId,sourceVectorHash,plan.ownerKind,plan.ownerId,plan.snapshotOperationId,plan.snapshotSeq])
    return plan
  }

  async function transaction<T>(work: () => Promise<T>): Promise<T> {
    await query('BEGIN')
    try {
      const result = await work()
      await query('COMMIT')
      return result
    } catch (error) {
      await query('ROLLBACK')
      throw error
    }
  }

  const genesis = await transaction(async () => {
    const plan = await claim('section_bootstrap')
    await bootstrap.consumeRecoveryArchiveBootstrapReservations(query, {
      ...plan, sections: plan.sections.map((section) => ({
        sectionKind: section.sectionKind, rowCount: '0', sourceHash: 'a'.repeat(64),
      })),
    })
    return plan
  })
  const markerBefore = (await query('SELECT * FROM meta_recovery_archive_section_bootstrap_markers')).rows

  async function checkpoint(plan: Plan, operationKind = 'section_checkpoint', extraPayload = false): Promise<void> {
    for (const section of plan.sections) {
      await query(`INSERT INTO meta_sheet_section_revisions (
        sheet_id,section_kind,entity_key,action,payload,seq,operation_id
      ) VALUES ($1,$2,$3,'checkpoint_snapshot',$4::jsonb,$5::bigint,$6::uuid)`,
      [plan.sheetId,section.sectionKind,`section/${section.sectionKind}`,
        JSON.stringify({ row_count: '1', source_hash: 'b'.repeat(64), ...(extraPayload ? { forged: true } : {}) }),
        section.endpointSeq,section.operationId])
      await query(`INSERT INTO meta_record_history_operations (
        sheet_id,operation_id,endpoint_seq,event_count,operation_kind,event_contract_version,component_count
      ) VALUES ($1,$2::uuid,$3::bigint,1,$4,2,NULL)`,
      [plan.sheetId,section.operationId,section.endpointSeq,operationKind])
      await query(`INSERT INTO meta_record_history_snapshot_members (
        sheet_id,parent_operation_id,ordinal,section_kind,source_head_kind,source_operation_id,
        source_head_seq,row_count,source_hash
      ) VALUES ($1,$2::uuid,$3,$4,'section_checkpoint',$5::uuid,$6::bigint,1,$7)`,
      [plan.sheetId,plan.snapshotOperationId,section.ordinal,section.sectionKind,section.operationId,section.endpointSeq,'b'.repeat(64)])
    }
    await query(`INSERT INTO meta_record_history_operations (
      sheet_id,operation_id,endpoint_seq,event_count,operation_kind,event_contract_version,component_count
    ) VALUES ($1,$2::uuid,$3::bigint,0,'archive_snapshot',2,9)`,
    [plan.sheetId,plan.snapshotOperationId,plan.snapshotSeq])
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await transaction(async () => {
      const plan = await claim('section_checkpoint', 's', true)
      assert.ok(BigInt(plan.sections[0].endpointSeq) > BigInt(genesis.snapshotSeq))
      const input = { ...plan, sections: plan.sections.map((section) => ({
        sectionKind: section.sectionKind, rowCount: '1', sourceHash: 'b'.repeat(64),
      })) }
      await checkpoints.consumeRecoveryArchiveCheckpointReservations(query, input)
      assert.deepEqual(await checkpoints.consumeRecoveryArchiveCheckpointReservations(query, input), plan)
      await assert.rejects(checkpoints.consumeRecoveryArchiveCheckpointReservations(query, {
        ...input, sections: input.sections.map((section) => ({ ...section, sourceHash: 'c'.repeat(64) })),
      }), { code: 'RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE' })
    })
  }
  const concurrentPlan = await transaction(() => claim('section_checkpoint', 's', true))
  const concurrentInput = { ...concurrentPlan, sections: concurrentPlan.sections.map((section) => ({
    sectionKind: section.sectionKind, rowCount: '1', sourceHash: 'b'.repeat(64),
  })) }
  const retryClient = new Client({ ...connection, database })
  await retryClient.connect()
  let retry: Promise<unknown> | undefined
  try {
    const firstPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const secondPid = (await retryClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await query('BEGIN')
    await checkpoints.consumeRecoveryArchiveCheckpointReservations(query, concurrentInput)
    await retryClient.query('BEGIN')
    await retryClient.query("SET LOCAL statement_timeout='5s'")
    // Capture rejection immediately; no unhandled rejection if the barrier fails.
    retry = checkpoints.consumeRecoveryArchiveCheckpointReservations(
      (text, params) => retryClient.query(text, params), concurrentInput,
    ).then((result) => ({ result }), (error: unknown) => ({ error }))
    let waitingAtGeneration = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const activity = (await admin.query(`SELECT query, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [secondPid])).rows[0]
      if (activity?.blockers.includes(firstPid)) {
        assert.match(activity.query, /FROM meta_recovery_archives[\s\S]*FOR UPDATE/)
        waitingAtGeneration = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(waitingAtGeneration, true, 'CHECKPOINT_RETRY_MUST_WAIT_AT_GENERATION')
    await query('COMMIT')
    assert.deepEqual(await retry, { result: concurrentPlan })
    await retryClient.query('COMMIT')
    assert.equal((await query(`SELECT count(*)::int AS n FROM meta_sheet_section_revisions
      WHERE operation_id=ANY($1::uuid[])`, [concurrentPlan.sections.map((section) => section.operationId)])).rows[0].n, 9)
  } finally {
    await query('ROLLBACK')
    await retry
    await retryClient.query('ROLLBACK')
    await retryClient.end()
  }
  for (const invalidation of ['lease', 'expiry', 'fence'] as const) {
    await query('BEGIN')
    try {
      const plan = await claim('section_checkpoint', 's', true,
        invalidation === 'fence' ? undefined : invalidation)
      // Let the short synthetic lifetime elapse; never bypass catalog ownership guards.
      if (invalidation !== 'fence') await query('SELECT pg_sleep(1.1)')
      await assert.rejects(checkpoints.consumeRecoveryArchiveCheckpointReservations(query, {
        ...plan, ownerFence: invalidation === 'fence' ? '2' : plan.ownerFence,
        sections: plan.sections.map((section) => ({
          sectionKind: section.sectionKind, rowCount: '1', sourceHash: 'b'.repeat(64),
        })),
      }), { code: 'RECOVERY_ARCHIVE_CHECKPOINT_GENERATION_UNAVAILABLE' })
      assert.equal((await query(`SELECT count(*)::int AS n FROM meta_sheet_section_revisions
        WHERE operation_id=ANY($1::uuid[])`, [plan.sections.map((section) => section.operationId)])).rows[0].n, 0)
    } finally {
      await query('ROLLBACK')
    }
  }
  await assert.rejects(transaction(async () => { await claim('section_checkpoint', 'no-genesis') }),
    { code: '23514', message: 'recovery_archive_checkpoint_genesis_required' })
  await assert.rejects(transaction(async () => { await checkpoint(await claim('section_checkpoint'), 'ordinary') }),
    { code: '23514', message: 'recovery_archive_checkpoint_dedicated_seal_required' })
  await assert.rejects(transaction(async () => { await checkpoint(await claim('section_checkpoint'), 'section_checkpoint', true) }),
    { code: '23514', constraint: 'chk_mssr_payload_or_tombstone' })
  // No snapshot parent exists here: rejection must belong to the event/seal authority,
  // not merely to a later membership check on an archive parent.
  await assert.rejects(transaction(async () => {
    const operationId = randomUUID()
    const seq = (await query("SELECT nextval('meta_record_chain_seq')::text AS seq")).rows[0].seq
    await query(`INSERT INTO meta_sheet_section_revisions (
      sheet_id,section_kind,entity_key,action,payload,seq,operation_id
    ) VALUES ('s','schema','section/schema','checkpoint_snapshot',$1::jsonb,$2::bigint,$3::uuid)`,
    [JSON.stringify({ row_count: '1', source_hash: 'b'.repeat(64) }),seq,operationId])
    await query(`INSERT INTO meta_record_history_operations (
      sheet_id,operation_id,endpoint_seq,event_count,operation_kind,event_contract_version,component_count
    ) VALUES ('s',$1::uuid,$2::bigint,1,'ordinary',2,NULL)`, [operationId,seq])
  }), { code: '23514', message: 'recovery_archive_checkpoint_reservation_required' })
  // Mutation stays inside a rolled-back synthetic transaction: removing the dedicated
  // seal guard permits a reserved full-section event to masquerade as ordinary.
  const functionSql = (await query("SELECT pg_get_functiondef('public.meta_record_history_operations_validate_endpoint()'::regprocedure) AS definition")).rows[0].definition as string
  const weakened = functionSql.replace("IF NEW.operation_kind IS DISTINCT FROM 'section_checkpoint' AND EXISTS (",
    "IF false AND NEW.operation_kind IS DISTINCT FROM 'section_checkpoint' AND EXISTS (")
  assert.notEqual(weakened, functionSql)
  await query('BEGIN')
  try {
    await query(weakened)
    const plan = await claim('section_checkpoint')
    const section = plan.sections[0]
    await query(`INSERT INTO meta_sheet_section_revisions (
      sheet_id,section_kind,entity_key,action,payload,seq,operation_id
    ) VALUES ('s',$1,$2,'checkpoint_snapshot',$3::jsonb,$4::bigint,$5::uuid)`,
    [section.sectionKind,`section/${section.sectionKind}`,JSON.stringify({ row_count: '1', source_hash: 'b'.repeat(64) }),section.endpointSeq,section.operationId])
    await query(`INSERT INTO meta_record_history_operations (
      sheet_id,operation_id,endpoint_seq,event_count,operation_kind,event_contract_version,component_count
    ) VALUES ('s',$1::uuid,$2::bigint,1,'ordinary',2,NULL)`, [section.operationId,section.endpointSeq])
    assert.equal((await query('SELECT operation_kind FROM meta_record_history_operations WHERE operation_id=$1::uuid', [section.operationId])).rows[0].operation_kind, 'ordinary')
  } finally {
    await query('ROLLBACK')
  }
  assert.equal((await query("SELECT pg_get_functiondef('public.meta_record_history_operations_validate_endpoint()'::regprocedure) AS definition")).rows[0].definition, functionSql)
  assert.deepEqual((await query('SELECT * FROM meta_recovery_archive_section_bootstrap_markers')).rows, markerBefore)
  assert.equal((await query("SELECT count(*)::int AS n FROM meta_record_history_operations WHERE operation_kind='section_checkpoint'")).rows[0].n, 27)
  await assert.rejects(db.transaction().execute(migration.down), { message: 'RECOVERY_ARCHIVE_CHECKPOINT_DOWN_IN_USE' })
  await db.transaction().execute(migration.up)
  console.log('PASS: fresh/replay; direct up/down/down/up/up; CHECK/function/trigger drift refused; populated down refused')
  for (const operation of [preparedMigration.up, preparedMigration.down, preparedMigration.down,
    preparedMigration.up, preparedMigration.up]) await db.transaction().execute(operation)
  for (const tamper of [
    'ALTER TABLE public.meta_recovery_archive_prepared_captures ALTER COLUMN owner_id DROP NOT NULL',
    `ALTER TABLE public.meta_recovery_archive_prepared_captures DROP CONSTRAINT chk_mrapc_shape,
      ADD CONSTRAINT chk_mrapc_shape CHECK (true)`,
    'ALTER TABLE public.meta_recovery_archive_prepared_captures DISABLE TRIGGER trg_mrapc_row',
    `CREATE OR REPLACE FUNCTION public.meta_recovery_archive_prepared_capture_guard()
      RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN RETURN NEW; END $$`,
  ]) {
    await assert.rejects(db.transaction().execute(async (tx) => {
      await sql.raw(tamper).execute(tx)
      await preparedMigration.up(tx)
    }), { message: 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_SCHEMA_DRIFT' })
  }
  const preparedPlan = await transaction(() => claim('section_checkpoint', 's', true))
  const key = randomBytes(32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const bytes = Buffer.concat([nonce, cipher.update('synthetic immutable capture'), cipher.final(), cipher.getAuthTag()])
  key.fill(0)
  assert.deepEqual(await transaction(() => prepared.persistRecoveryArchivePreparedCapture(query, preparedPlan, bytes)), bytes)
  assert.deepEqual(await transaction(() => prepared.persistRecoveryArchivePreparedCapture(query, preparedPlan, bytes)), bytes)
  await assert.rejects(transaction(() => prepared.persistRecoveryArchivePreparedCapture(query, preparedPlan, Buffer.from('changed'))),
    { message: 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_CONFLICT' })
  await assert.rejects(prepared.readRecoveryArchivePreparedCapture(query, preparedPlan),
    { message: 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_TRANSACTION_REQUIRED' })
  const resumed = new Client({ ...connection, database })
  await resumed.connect()
  try {
    await resumed.query('BEGIN')
    assert.deepEqual(await prepared.readRecoveryArchivePreparedCapture(
      (text, params) => resumed.query(text, params), preparedPlan), bytes)
    await resumed.query('COMMIT')
  } finally { await resumed.end() }
  await assert.rejects(transaction(() => prepared.readRecoveryArchivePreparedCapture(query, { ...preparedPlan, ownerFence: '2' })),
    { message: 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_OWNER_UNAVAILABLE' })
  for (const statement of [
    'UPDATE meta_recovery_archive_prepared_captures SET payload=payload',
    'DELETE FROM meta_recovery_archive_prepared_captures',
    'TRUNCATE meta_recovery_archive_prepared_captures',
  ]) await assert.rejects(transaction(() => query(statement)),
    { code: '55000', message: 'recovery_archive_prepared_capture_immutable' })
  await assert.rejects(db.transaction().execute(preparedMigration.down),
    { message: 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_DOWN_IN_USE' })
  for (const lifetime of ['lease', 'expiry'] as const) {
    const expired = await transaction(() => claim('section_checkpoint', 's', true, lifetime))
    await transaction(() => prepared.persistRecoveryArchivePreparedCapture(query, expired, bytes))
    await query('SELECT pg_sleep(1.1)')
    await assert.rejects(transaction(() => prepared.readRecoveryArchivePreparedCapture(query, expired)),
      { message: 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_OWNER_UNAVAILABLE' })
  }
  await db.transaction().execute(preparedMigration.up)
  console.log('PASS: immutable prepared bytes persist across connections; exact retry/conflict; expired owner/fence/transaction guards; drift and nonempty down refused')
  // A presealed fixture exercises continuation, not custody/nonce issuance or source capture.
  const uploadPlan = await transaction(() => claim('section_checkpoint', 's', true))
  const binding = { formatVersion: 1, generationId: uploadPlan.generationId, workspaceId: 'w', baseId: 'b',
    sheetId: 's', anchorOperationId: uploadPlan.snapshotOperationId, anchorSeq: uploadPlan.snapshotSeq,
    checkpointId: 'trust', keyId: 'synthetic-key', aeadAlgorithm: 'aes-256-gcm' as const }
  const fullBinding = { ...binding, wrappedDekId: 'synthetic-wrapped', dekFingerprint: 'a'.repeat(64) }
  const syntheticKey = randomBytes(32)
  let fixture: Buffer
  try {
    fixture = preparedUpload.encodeRecoveryArchivePreparedEnvelope({
      binding: fullBinding, wrappedDekId: fullBinding.wrappedDekId, dekFingerprint: fullBinding.dekFingerprint,
      wrappedDek: randomBytes(64), reservations: [],
      sealedSections: archiveContract.RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => {
        const plaintext = Buffer.from(`synthetic ${sectionName}`)
        return archiveCrypto.sealRecoveryArchiveSection({ binding: { ...fullBinding, sectionName,
          plaintextSha256: archiveCrypto.recoveryArchivePlaintextSha256(plaintext) },
        dek: syntheticKey, nonce: randomBytes(12), plaintext })
      }),
    })
  } finally { syntheticKey.fill(0) }
  await transaction(() => prepared.persistRecoveryArchivePreparedCapture(query, uploadPlan, fixture))
  const delivered: Buffer[] = []
  let revoked = false
  const uploadInput = {
    owner: uploadPlan, binding,
    transaction: <T,>(work: (q: typeof query) => Promise<T>) => transaction(() => work(query)),
    transactionDepth: { currentTransactionDepth: () => 0 },
    checkAuthority: async () => { if (revoked) throw new Error('SYNTHETIC_AUTHORITY_REVOKED') },
    capture: async (): Promise<never> => { throw new Error('SYNTHETIC_RECAPTURE_FORBIDDEN') },
    upload: async (_envelope: unknown, section: { ciphertext: Buffer }) => {
      delivered.push(Buffer.from(section.ciphertext))
      throw new Error('SYNTHETIC_INTERRUPTION')
    },
  }
  await assert.rejects(preparedUpload.uploadRecoveryArchivePreparedCapture(uploadInput), { message: 'SYNTHETIC_INTERRUPTION' })
  await client.end()
  client = new Client({ ...connection, database })
  await client.connect()
  await preparedUpload.uploadRecoveryArchivePreparedCapture({ ...uploadInput,
    upload: async (_envelope, section) => { delivered.push(Buffer.from(section.ciphertext)) },
  })
  assert.equal(delivered.length, 11)
  assert.deepEqual(delivered[0], delivered[1])
  assert.deepEqual(await transaction(() => prepared.readRecoveryArchivePreparedCapture(query, uploadPlan)), fixture)
  revoked = true
  await assert.rejects(preparedUpload.uploadRecoveryArchivePreparedCapture(uploadInput), { message: 'SYNTHETIC_AUTHORITY_REVOKED' })
  assert.equal(delivered.length, 11)
  console.log('PASS: presealed-envelope upload interruption/new connection resumes original ten sections without capture; injected authority revocation refuses')
  // Independently prepared binary fixtures prove persistence/continuation, not source admission or publication.
  const attachmentCrypto = require('../src/multitable/recovery-archive-attachment-crypto.ts') as typeof import('../src/multitable/recovery-archive-attachment-crypto')
  const binaryOwner = await transaction(() => claim('section_checkpoint', 's', true))
  const binaryBinding = { ...binding, generationId: binaryOwner.generationId,
    anchorOperationId: binaryOwner.snapshotOperationId, anchorSeq: binaryOwner.snapshotSeq }
  const binaryFullBinding = { ...fullBinding, ...binaryBinding }
  const binaryKey = randomBytes(32)
  const binaryPlaintext = Buffer.from([0, 255, 17, 128, 0, 13, 10])
  const binaryId = `att_${randomUUID()}`
  const binaryHash = archiveCrypto.recoveryArchivePlaintextSha256(binaryPlaintext)
  let binaryPayload: Buffer
  try {
    binaryPayload = preparedUpload.encodeRecoveryArchivePreparedEnvelope({
      binding: binaryFullBinding, wrappedDekId: binaryFullBinding.wrappedDekId,
      dekFingerprint: binaryFullBinding.dekFingerprint, wrappedDek: randomBytes(64), reservations: [],
      sealedSections: archiveContract.RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => {
        const plaintext = Buffer.from(`synthetic ${sectionName}`)
        return archiveCrypto.sealRecoveryArchiveSection({ binding: { ...binaryFullBinding, sectionName,
          plaintextSha256: archiveCrypto.recoveryArchivePlaintextSha256(plaintext) },
        dek: binaryKey, nonce: randomBytes(12), plaintext })
      }),
      sealedAttachments: [{ attachmentId: binaryId, sourceVersion: `sha256:${binaryHash}`,
        plaintextSha256: binaryHash, sizeBytes: binaryPlaintext.length,
        ...attachmentCrypto.sealRecoveryArchiveAttachment({ binding: { generation: binaryFullBinding,
          attachmentId: binaryId, sourceVersion: `sha256:${binaryHash}`, plaintextSha256: binaryHash },
        dek: binaryKey, nonce: randomBytes(12), plaintext: binaryPlaintext }) }],
    })
    await transaction(() => prepared.persistRecoveryArchivePreparedCapture(query, binaryOwner, binaryPayload))
    let binarySectionUploads = 0
    const binaryDelivered: Buffer[] = []
    const binaryInput = { ...uploadInput, owner: binaryOwner, binding: binaryBinding,
      checkAuthority: async () => {}, upload: async () => { binarySectionUploads++ },
      uploadAttachment: async (_envelope: unknown, object: { ciphertext: Buffer }) => {
        binaryDelivered.push(Buffer.from(object.ciphertext)); throw new Error('SYNTHETIC_BINARY_INTERRUPTION')
      },
    }
    await assert.rejects(preparedUpload.uploadRecoveryArchivePreparedCapture({ ...binaryInput, uploadAttachment: undefined }),
      { message: 'RECOVERY_ARCHIVE_ATTACHMENT_UPLOAD_REQUIRED' })
    assert.equal(binarySectionUploads, 0)
    await assert.rejects(preparedUpload.uploadRecoveryArchivePreparedCapture(binaryInput),
      { message: 'SYNTHETIC_BINARY_INTERRUPTION' })
    await client.end()
    client = new Client({ ...connection, database })
    await client.connect()
    await preparedUpload.uploadRecoveryArchivePreparedCapture({ ...binaryInput,
      uploadAttachment: async (envelope, object) => {
        assert.deepEqual(attachmentCrypto.openRecoveryArchiveAttachment({ binding: { generation: envelope.binding,
          attachmentId: object.attachmentId, sourceVersion: object.sourceVersion, plaintextSha256: object.plaintextSha256 },
        dek: binaryKey, sealed: object }), binaryPlaintext)
        binaryDelivered.push(Buffer.from(object.ciphertext)); object.ciphertext.fill(0)
      },
    })
    assert.equal(binaryDelivered.length, 2)
    assert.deepEqual(binaryDelivered[0], binaryDelivered[1])
    assert.deepEqual(await transaction(() => prepared.readRecoveryArchivePreparedCapture(query, binaryOwner)), binaryPayload)
    await assert.rejects(preparedUpload.uploadRecoveryArchivePreparedCapture({ ...binaryInput,
      checkAuthority: async () => { throw new Error('SYNTHETIC_AUTHORITY_REVOKED') },
    }), { message: 'SYNTHETIC_AUTHORITY_REVOKED' })
    assert.equal(binaryDelivered.length, 2)
    const continuationBindings = require('../src/multitable/recovery-archive-manual-continuation.ts') as typeof import('../src/multitable/recovery-archive-manual-continuation')
    const binaryStores = require('../src/multitable/recovery-archive-object-store.ts') as typeof import('../src/multitable/recovery-archive-object-store')
    const binaryProvider = binaryStores.createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: join(root, 'binary-objects') })
    let binaryAllowed = true
    let revokeAfterHead = false
    let binaryPuts = 0
    const ownedBinaryUpload = continuationBindings.bindRecoveryArchiveManualAttachmentUpload(uploadInput.transaction,
      async () => binaryAllowed, { identity: { actorId: 'synthetic', workspaceId: 'w', baseId: 'b', sheetId: 's' },
        owner: binaryOwner, transactionDepth: binaryInput.transactionDepth,
        provider: { ...binaryProvider,
          put: async (input) => { binaryPuts++; return binaryProvider.put(input) },
          head: async (input) => { const result = await binaryProvider.head(input); if (revokeAfterHead) binaryAllowed = false; return result },
        } })
    const binaryEnvelope = preparedUpload.decodeRecoveryArchivePreparedEnvelope(binaryPayload)
    const binaryObject = binaryEnvelope.attachments![0]!
    const untrustedBinaryObject = { ...binaryObject, ciphertext: Buffer.from('UNTRUSTED_CALLBACK_BYTES') }
    await assert.rejects(ownedBinaryUpload(binaryEnvelope, { ...untrustedBinaryObject, attachmentId: 'unknown' }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_PLAN_MISMATCH' })
    assert.equal(binaryPuts, 0)
    revokeAfterHead = true
    await assert.rejects(ownedBinaryUpload(binaryEnvelope, untrustedBinaryObject),
      { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
    assert.equal((await query('SELECT count(*)::int AS n FROM meta_recovery_archive_objects WHERE generation_id=$1', [binaryOwner.generationId])).rows[0].n, 0)
    revokeAfterHead = false
    binaryAllowed = true
    await assert.rejects(ownedBinaryUpload(binaryEnvelope, untrustedBinaryObject),
      { message: 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED' })
    const binaryPinAuthority = require('../src/multitable/recovery-archive-source-pin.ts') as typeof import('../src/multitable/recovery-archive-source-pin')
    await transaction(async () => {
      const leaseUntil = (await query('SELECT lease_expires_at::text AS lease FROM meta_recovery_archives WHERE generation_id=$1', [binaryOwner.generationId])).rows[0].lease
      const pinOwner = { ...binaryOwner, keyId: binaryBinding.keyId, attachmentId: binaryId, leaseUntil }
      await binaryPinAuthority.claimRecoveryArchiveSourcePinIntent(query, pinOwner)
      await binaryPinAuthority.verifyRecoveryArchiveSourcePin(query, { ...pinOwner,
        immutableVersion: binaryObject.sourceVersion, contentSha256: binaryHash, contentSizeBytes: String(binaryPlaintext.length) })
    })
    await ownedBinaryUpload(binaryEnvelope, untrustedBinaryObject)
    await ownedBinaryUpload(binaryEnvelope, untrustedBinaryObject)
    const binaryReceipts = (await query(`SELECT object_class,section_name,attachment_id,state,object_id,provider_version,
      ciphertext_sha256,plaintext_sha256,size_bytes::text FROM meta_recovery_archive_objects WHERE generation_id=$1`, [binaryOwner.generationId])).rows
    const binaryObjectBytes = Buffer.concat([binaryObject.nonce, binaryObject.ciphertext, binaryObject.authTag])
    const binaryObjectHash = createHash('sha256').update(binaryObjectBytes).digest('hex')
    assert.deepEqual(binaryReceipts, [{ object_class: 'attachment', section_name: null, attachment_id: binaryId,
      state: 'uploaded', object_id: binaryObjectHash, provider_version: binaryObjectHash,
      ciphertext_sha256: binaryObjectHash, plaintext_sha256: binaryHash, size_bytes: String(binaryObjectBytes.length) }])
    const binaryExpiry = (await query('SELECT expires_at FROM meta_recovery_archives WHERE generation_id=$1', [binaryOwner.generationId])).rows[0].expires_at.toISOString()
    const storedBinary = await binaryProvider.get({ generationId: binaryOwner.generationId, objectId: binaryObjectHash,
      expectedVersion: binaryObjectHash, expectedSha256: binaryObjectHash,
      expectedSize: String(binaryObjectBytes.length), expectedExpiresAt: binaryExpiry })
    const restoredBinary = Buffer.from(storedBinary.bytes)
    assert.deepEqual(restoredBinary, binaryObjectBytes)
    assert.deepEqual(attachmentCrypto.openRecoveryArchiveAttachment({ binding: { generation: binaryEnvelope.binding,
      attachmentId: binaryId, sourceVersion: binaryObject.sourceVersion, plaintextSha256: binaryHash }, dek: binaryKey,
      sealed: { nonce: restoredBinary.subarray(0, 12), ciphertext: restoredBinary.subarray(12, -16), authTag: restoredBinary.subarray(-16) } }), binaryPlaintext)
    console.log('PASS: real attachment PUT/HEAD/GET uses durable nonce+ciphertext+tag, ignores callback bytes, records one uploaded receipt; unknown ID and post-IO revocation refuse')
  } finally { binaryKey.fill(0); binaryPlaintext.fill(0) }
  console.log('PASS: binary attachment envelope persists exact bytes; interruption/new connection resumes without recapture; missing uploader and revoked authority refuse')
  const actorId = randomUUID()
  await query(`INSERT INTO users(id,password_hash,role,is_active) VALUES ($1,'synthetic-only','admin',true)`, [actorId])
  const { createRecoveryArchiveManualContinuation, createRecoveryArchiveManualAdmission, createRecoveryArchiveManualSourceRecheck,
    createRecoveryArchiveManualObjectUpload, createRecoveryArchiveManualManifestUpload,
    createRecoveryArchiveManualFinalization } = require('../src/routes/univer-meta.ts') as typeof import('../src/routes/univer-meta')
  const manual = createRecoveryArchiveManualContinuation(uploadInput.transaction)
  const manualInput = { ...uploadInput, identity: { actorId, workspaceId: 'w', baseId: 'b', sheetId: 's' } }
  let manualUploads = 0
  const revoker = new Client({ ...connection, database })
  await revoker.connect()
  try {
    await assert.rejects(manual({ ...manualInput, upload: async () => { manualUploads++ } }),
      { message: 'RECOVERY_ARCHIVE_PREPARED_MANIFEST_REQUIRED' })
    assert.equal(manualUploads, 0)
    await revoker.query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
    await assert.rejects(manual({ ...manualInput, upload: async () => { manualUploads++ } }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
    assert.equal(manualUploads, 0)
    await revoker.query('UPDATE users SET is_active=true WHERE id=$1', [actorId])
    await assert.rejects(manual({ ...manualInput, identity: { ...manualInput.identity, baseId: 'other' } }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_SCOPE_MISMATCH' })
  } finally { await revoker.end() }
  console.log('PASS: unsigned legacy package cannot resume manual publication; canonical authority and scope refuse')
  const request = { actorId, requestId: randomUUID(), workspaceId: 'w', baseId: 'b', sheetId: 's' }
  await assert.rejects(manualRequests.bindRecoveryArchiveManualRequest(query, request, uploadInput.owner.generationId),
    { message: 'RECOVERY_ARCHIVE_MANUAL_REQUEST_TRANSACTION_REQUIRED' })
  await transaction(async () => {
    assert.equal(await manualRequests.bindRecoveryArchiveManualRequest(query, request, uploadInput.owner.generationId),
      uploadInput.owner.generationId)
  })
  await transaction(async () => {
    assert.equal(await manualRequests.bindRecoveryArchiveManualRequest(query, request, uploadInput.owner.generationId),
      uploadInput.owner.generationId)
  })
  await assert.rejects(transaction(() => manualRequests.bindRecoveryArchiveManualRequest(query,
    { ...request, sheetId: 'no-genesis' }, uploadInput.owner.generationId)),
  { message: 'RECOVERY_ARCHIVE_MANUAL_REQUEST_CONFLICT' })
  await assert.rejects(transaction(() => manualRequests.bindRecoveryArchiveManualRequest(query, request, randomUUID())),
    { message: 'RECOVERY_ARCHIVE_MANUAL_REQUEST_CONFLICT' })
  await client.end()
  client = new Client({ ...connection, database })
  await client.connect()
  assert.equal(await transaction(() => manualRequests.readRecoveryArchiveManualRequest(query, request)),
    uploadInput.owner.generationId)
  assert.equal(await transaction(() => manualRequests.readRecoveryArchiveManualRequest(query,
    { ...request, actorId: randomUUID() })), null)
  const requestCount = await query('SELECT count(*)::int AS count FROM meta_recovery_archive_manual_requests')
  assert.equal(requestCount.rows[0].count, 1)
  await query('BEGIN')
  try {
    await query('ALTER TABLE meta_recovery_archive_manual_requests DISABLE TRIGGER trg_mramr_row')
    await query("UPDATE meta_recovery_archive_manual_requests SET request_hash=repeat('0',64)")
    await assert.rejects(manualRequests.readRecoveryArchiveManualRequest(query, request),
      { message: 'RECOVERY_ARCHIVE_MANUAL_REQUEST_CONFLICT' })
  } finally { await query('ROLLBACK') }
  for (const mutation of [
    'UPDATE meta_recovery_archive_manual_requests SET request_hash=request_hash',
    'DELETE FROM meta_recovery_archive_manual_requests',
    'TRUNCATE meta_recovery_archive_manual_requests',
  ]) await assert.rejects(transaction(() => query(mutation)), { code: '55000' })
  const concurrentRequest = { ...request, requestId: randomUUID() }
  const requestPlan = await transaction(() => claim('section_checkpoint', 's', true))
  const requestClient = new Client({ ...connection, database })
  await requestClient.connect()
  let pendingRequest: Promise<{ result: string } | { error: unknown }> | undefined
  try {
    const firstPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const secondPid = (await requestClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await query('BEGIN')
    await manualRequests.bindRecoveryArchiveManualRequest(query, concurrentRequest, requestPlan.generationId)
    await requestClient.query('BEGIN')
    await requestClient.query("SET LOCAL statement_timeout='5s'")
    pendingRequest = manualRequests.bindRecoveryArchiveManualRequest(
      (text, params) => requestClient.query(text, params), concurrentRequest, requestPlan.generationId,
    ).then((result) => ({ result }), (error: unknown) => ({ error }))
    let blocked = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const activity = (await admin.query(`SELECT pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [secondPid])).rows[0]
      if (activity?.blockers.includes(firstPid)) { blocked = true; break }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(blocked, true, 'MANUAL_REQUEST_RETRY_MUST_WAIT')
    await query('COMMIT')
    assert.deepEqual(await pendingRequest, { result: requestPlan.generationId })
    await requestClient.query('COMMIT')
    assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_manual_requests
      WHERE actor_id=$1::uuid AND request_id=$2::uuid`, [actorId, concurrentRequest.requestId])).rows[0].n, 1)
  } finally {
    await query('ROLLBACK')
    await pendingRequest
    await requestClient.query('ROLLBACK')
    await requestClient.end()
  }
  await assert.rejects(db.transaction().execute(manualRequestMigration.down),
    { message: 'RECOVERY_ARCHIVE_MANUAL_REQUEST_DOWN_IN_USE' })
  await db.transaction().execute(manualRequestMigration.up)
  console.log('PASS: immutable manual request binding; new-connection lookup; two-connection retry; actor isolation and scope/generation conflict; transaction and nonempty-down guards')
  const admissionPolicy = { keyId: 'synthetic-key', keyRowVersion: '1', leaseSeconds: 3600, expiresAfterSeconds: 7200 }
  const admit = createRecoveryArchiveManualAdmission(uploadInput.transaction, admissionPolicy)
  const admissionRequest = { ...request, requestId: randomUUID(), sheetId: 'no-genesis' }
  const generationCount = async () => (await query('SELECT count(*)::int AS n FROM meta_recovery_archives')).rows[0].n as number
  const beforeAdmission = await generationCount()
  const admitted = await admit(admissionRequest)
  assert.equal(admitted.replayed, false)
  assert.equal(await generationCount(), beforeAdmission + 1)
  const kinds = (await query(`SELECT reservation_kind,count(*)::int AS n
    FROM meta_recovery_archive_snapshot_reservations WHERE generation_id=$1::uuid GROUP BY reservation_kind`,
  [admitted.generationId])).rows
  assert.deepEqual(kinds.sort((a, b) => a.reservation_kind.localeCompare(b.reservation_kind)),
    [{ reservation_kind: 'archive_snapshot', n: 1 }, { reservation_kind: 'section_bootstrap', n: 9 }])
  assert.deepEqual(await admit(admissionRequest), { generationId: admitted.generationId, replayed: true, source: null })
  assert.equal(await generationCount(), beforeAdmission + 1)
  await assert.rejects(admit({ ...admissionRequest, baseId: 'other' }),
    { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
  await query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
  try {
    await assert.rejects(admit(admissionRequest), { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
  } finally { await query('UPDATE users SET is_active=true WHERE id=$1', [actorId]) }
  const failedRequest = { ...request, requestId: randomUUID() }
  const failingAdmission = createRecoveryArchiveManualAdmission(
    (work) => transaction(() => work(async (text, params) => {
      if (text.includes('INSERT INTO public.meta_recovery_archive_manual_requests')) throw new Error('SYNTHETIC_BIND_FAILURE')
      return query(text, params)
    })), admissionPolicy,
  )
  await assert.rejects(failingAdmission(failedRequest), { message: 'SYNTHETIC_BIND_FAILURE' })
  assert.equal(await generationCount(), beforeAdmission + 1)
  assert.equal(await transaction(() => manualRequests.readRecoveryArchiveManualRequest(query, failedRequest)), null)
  await assert.rejects(createRecoveryArchiveManualAdmission(uploadInput.transaction,
    { ...admissionPolicy, keyRowVersion: '2' })(failedRequest),
  { message: 'RECOVERY_ARCHIVE_KEY_REFERENCE_UNAVAILABLE' })
  await query("INSERT INTO meta_sheets(id,name,base_id) VALUES ('manual-no-trust','Synthetic','b')")
  await assert.rejects(admit({ ...failedRequest, sheetId: 'manual-no-trust' }),
    { message: 'RECOVERY_ARCHIVE_MANUAL_TRUST_UNAVAILABLE' })
  assert.equal(await generationCount(), beforeAdmission + 1)
  const repeatedCapture = await admit({ ...request, requestId: randomUUID() })
  assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_snapshot_reservations
    WHERE generation_id=$1::uuid AND reservation_kind='section_checkpoint'`, [repeatedCapture.generationId])).rows[0].n, 9)
  const admissionClient = new Client({ ...connection, database })
  await admissionClient.connect()
  let competingAdmission: Promise<{ result: { generationId: string; replayed: boolean } } | { error: unknown }> | undefined
  try {
    const simultaneous = { ...request, requestId: randomUUID() }
    const firstPid = (await query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const secondPid = (await admissionClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const countBeforeRace = await generationCount()
    await query('BEGIN')
    const first = await createRecoveryArchiveManualAdmission((work) => work(query), admissionPolicy)(simultaneous)
    await admissionClient.query('BEGIN')
    await admissionClient.query("SET LOCAL statement_timeout='5s'")
    competingAdmission = createRecoveryArchiveManualAdmission(
      (work) => work((text, params) => admissionClient.query(text, params)), admissionPolicy,
    )(simultaneous).then((result) => ({ result }), (error: unknown) => ({ error }))
    let blocked = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const activity = (await admin.query(`SELECT pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'`, [secondPid])).rows[0]
      if (activity?.blockers.includes(firstPid)) { blocked = true; break }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(blocked, true, 'MANUAL_ADMISSION_MUST_WAIT_AT_FENCE')
    await query('COMMIT')
    assert.deepEqual(await competingAdmission, { result: { generationId: first.generationId, replayed: true, source: null } })
    await admissionClient.query('COMMIT')
    assert.equal(await generationCount(), countBeforeRace + 1)
  } finally {
    await query('ROLLBACK')
    await competingAdmission
    await admissionClient.query('ROLLBACK')
    await admissionClient.end()
  }
  console.log('PASS: canonical manual admission atomically binds bootstrap/checkpoint generations; exact replay, revoked actor and scope refusal; failed binding rolls back generation')
  assert.ok(admitted.source)
  const recheckSource = createRecoveryArchiveManualSourceRecheck(uploadInput.transaction)
  const emptySource = manualAdmission.readRecoveryArchiveManualSource(admitted.source)
  assert.deepEqual(emptySource.sections.records, [])
  await recheckSource(admitted.source)
  const sourceWriter = new Client({ ...connection, database })
  await sourceWriter.connect()
  try {
    await sourceWriter.query(`INSERT INTO meta_fields(id,sheet_id,name,type,property,"order")
      VALUES ('manual-source-field','no-genesis','Synthetic','string','{}',1)`)
    await sourceWriter.query(`INSERT INTO meta_records(id,sheet_id,data)
      VALUES ('manual-source-record','no-genesis','{"manual-source-field":"before"}')`)
    await assert.rejects(recheckSource(admitted.source), { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_CHANGED' })
    assert.deepEqual(manualAdmission.readRecoveryArchiveManualSource(admitted.source).sections.records, [])
    assert.deepEqual(await admit(admissionRequest), { generationId: admitted.generationId, replayed: true, source: null })
    const freshSource = await admit({ ...admissionRequest, requestId: randomUUID() })
    assert.ok(freshSource.source)
    const original = manualAdmission.readRecoveryArchiveManualSource(freshSource.source)
    assert.equal(original.sections.records.length, 1)
    assert.deepEqual((original.sections.records[0] as { data: unknown }).data, { 'manual-source-field': 'before' })
    const mutableRecord = original.sections.records[0] as { data: unknown }
    mutableRecord.data = { 'manual-source-field': 'caller-mutated' }
    assert.deepEqual((manualAdmission.readRecoveryArchiveManualSource(freshSource.source).sections.records[0] as { data: unknown }).data,
      { 'manual-source-field': 'before' })
    await recheckSource(freshSource.source)
    await sourceWriter.query(`UPDATE meta_records SET data='{"manual-source-field":"after"}',version=version+1
      WHERE id='manual-source-record'`)
    await assert.rejects(recheckSource(freshSource.source), { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_CHANGED' })
    await sourceWriter.query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
    await assert.rejects(recheckSource(freshSource.source), { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
  } finally {
    await sourceWriter.query('UPDATE users SET is_active=true WHERE id=$1', [actorId])
    await sourceWriter.end()
  }
  await assert.rejects(recheckSource({} as Parameters<typeof recheckSource>[0]),
    { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE' })
  const shortSource = await createRecoveryArchiveManualAdmission(uploadInput.transaction,
    { ...admissionPolicy, leaseSeconds: 1, expiresAfterSeconds: 30 })({ ...request, requestId: randomUUID() })
  assert.ok(shortSource.source)
  await query('SELECT pg_sleep(1.1)')
  await assert.rejects(recheckSource(shortSource.source),
    { message: 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_OWNER_UNAVAILABLE' })
  console.log('PASS: in-fence live source snapshots; empty/nonempty; detached copies; schema/record drift and revocation refuse; replay never recaptures; forged source refused')
  const continuation = async (admitter = admit) => {
    const identity = { ...admissionRequest, requestId: randomUUID() }
    const result = await admitter(identity)
    assert.ok(result.source)
    const row = (await query(`SELECT owner_kind,owner_id,owner_fence::text,source_vector_hash,
      anchor_operation_id::text,anchor_seq::text,checkpoint_id,key_id
      FROM meta_recovery_archives WHERE generation_id=$1::uuid`, [result.generationId])).rows[0]
    return { identity, source: result.source,
      owner: { generationId: result.generationId, ownerKind: row.owner_kind, ownerId: row.owner_id,
        ownerFence: row.owner_fence, sourceVectorHash: row.source_vector_hash },
      binding: { formatVersion: 1, generationId: result.generationId, workspaceId: identity.workspaceId,
        baseId: identity.baseId, sheetId: identity.sheetId, anchorOperationId: row.anchor_operation_id,
        anchorSeq: row.anchor_seq, checkpointId: row.checkpoint_id, keyId: row.key_id,
        aeadAlgorithm: 'aes-256-gcm' as const },
      transactionDepth: { currentTransactionDepth: () => 0 } }
  }
  const first = await continuation()
  const other = await continuation()
  let captures = 0
  let produced = 0
  let reserved = 0
  let authenticated = 0
  const sourceKey = randomBytes(32)
  const custody: import('../src/multitable/recovery-archive-crypto').RecoveryArchiveKeyCustodyAdapter = {
    async produceGenerationDek() {
      produced++
      return { dek: Buffer.from(sourceKey), wrappedDekId: 'synthetic-source-wrapped', wrappedDek: randomBytes(64) }
    },
    async unwrapGenerationDek() { throw new Error('SYNTHETIC_UNWRAP_FORBIDDEN') },
    async deriveDekFingerprint({ dek }) {
      return createHmac('sha256', Buffer.from(dek)).update(archiveCrypto.RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN).digest('hex')
    },
    async macManifestRoot({ preimage }) {
      authenticated++
      return createHmac('sha256', sourceKey).update(preimage).digest()
    },
    async verifyManifestRootMac({ preimage, mac }) {
      return createHmac('sha256', sourceKey).update(preimage).digest().equals(Buffer.from(mac))
    },
  }
  const capture = async (source: import('../src/multitable/recovery-archive-relational-source').RecoveryArchiveCaptureSource) => {
    captures++
    return { binding: first.binding, transactionDepth: first.transactionDepth, keyCustody: custody,
      dekSource: { kind: 'produce' as const },
      // Coverage input is deliberately bogus: the server must replace it with real sealed-row coverage.
      sections: archiveContract.RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => {
        const rows = source.sections[sectionName as keyof typeof source.sections]
        const plaintext = sectionName === 'coverage_index' ? '[{"untrusted":true}]' : rows === undefined ? '[]' : manifest.canonicalizeRecoveryArchiveSectionRows(
          sectionName, sectionRows.buildRecoveryArchiveSectionRows(sectionName, rows)).canonicalJson
        return { sectionName, plaintext: Buffer.from(plaintext), nonce: randomBytes(12) }
      }),
      reserveNonces: async (rows: readonly unknown[]) => { reserved += rows.length },
    }
  }
  const upload = async () => {
    const nonceObserver = new Client({ ...connection, database })
    await nonceObserver.connect()
    try {
      assert.equal((await nonceObserver.query(`SELECT count(*)::int AS n
        FROM meta_recovery_archive_nonce_reservations WHERE generation_id=$1::uuid`,
      [first.owner.generationId])).rows[0].n, 10, 'reservations must be committed before upload')
    } finally { await nonceObserver.end() }
    throw new Error('SYNTHETIC_SOURCE_UPLOAD_INTERRUPTION')
  }
  const nonceCount = async (generationId: string) => (await query(`SELECT count(*)::int AS n
    FROM meta_recovery_archive_nonce_reservations WHERE generation_id=$1::uuid`, [generationId])).rows[0].n
  const sealedMembers = async (operationId: string) => (await query(`SELECT section_kind,
    row_count::text,source_hash,source_head_kind FROM meta_record_history_snapshot_members
    WHERE sheet_id='no-genesis' AND parent_operation_id=$1::uuid ORDER BY ordinal`, [operationId])).rows
  const expectedMembers = (input: Awaited<ReturnType<typeof continuation>>, kind: string) => {
    const snapshot = manualAdmission.readRecoveryArchiveManualSource(input.source)
    return sectionRows.RECOVERY_ARCHIVE_DATA_SECTION_NAMES.map((section_kind) => {
      const raw = section_kind === 'attachments_index' || section_kind === 'permission_evidence'
        ? [] : snapshot.sections[section_kind]
      const canonical = manifest.canonicalizeRecoveryArchiveSectionRows(section_kind,
        sectionRows.buildRecoveryArchiveSectionRows(section_kind, raw))
      return { section_kind, row_count: canonical.rowCount, source_hash: canonical.plaintextSha256, source_head_kind: kind }
    })
  }
  try {
    await assert.rejects(manual({ ...first, source: null, capture, upload }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE' })
    await assert.rejects(manual({ ...first, source: other.source, capture, upload }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_BINDING_MISMATCH' })
    assert.throws(() => manualAdmission.takeRecoveryArchiveManualSource(first.source,
      { ...first.identity, actorId: randomUUID() }, first.owner, first.binding),
    { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_BINDING_MISMATCH' })
    assert.throws(() => manualAdmission.takeRecoveryArchiveManualSource(first.source,
      first.identity, first.owner, { ...first.binding, anchorSeq: '999999' }),
    { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_BINDING_MISMATCH' })
    assert.equal(captures, 0)
    await assert.rejects(manual({ ...other, capture: async (source) => {
      const plan = await capture(source)
      plan.binding = other.binding
      plan.sections.find((section) => section.sectionName === 'records')!.plaintext = Buffer.from('[]')
      return plan
    }, upload }), { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_PLAN_MISMATCH' })
    assert.equal(produced, 0)
    await assert.rejects(manual({ ...other, capture, upload }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE' })
    await assert.rejects(manual({ ...first, capture, upload }), { message: 'SYNTHETIC_SOURCE_UPLOAD_INTERRUPTION' })
    assert.equal(produced, 1)
    assert.equal(reserved, 0, 'caller-owned reservation callback must never run')
    assert.equal(authenticated, 1, 'manifest authentication must precede first upload')
    assert.equal(await nonceCount(first.owner.generationId), 10)
    assert.deepEqual(await sealedMembers(first.binding.anchorOperationId), expectedMembers(first, 'section_bootstrap'))
    const captureCount = captures
    const signedPayload = await uploadInput.transaction((q) => prepared.readRecoveryArchivePreparedCapture(q, first.owner))
    assert.ok(signedPayload)
    const signedEnvelope = preparedUpload.decodeRecoveryArchivePreparedEnvelope(signedPayload)
    assert.ok(signedEnvelope.manifestEnvelope)
    const manifestObjects = require('../src/multitable/recovery-archive-manifest-object-envelope.ts') as typeof import('../src/multitable/recovery-archive-manifest-object-envelope')
    const signedManifest = manifestObjects.parseRecoveryArchiveManifestObjectEnvelope(signedEnvelope.manifestEnvelope).manifest
    assert.equal(signedManifest.source_vector_hash, first.owner.sourceVectorHash)
    assert.equal(signedManifest.sections.length, 10)
    const preimage = archiveCrypto.buildRecoveryArchiveManifestMacPreimage({ ...signedEnvelope.binding,
      rootHash: signedManifest.root_hash, createdAt: signedManifest.created_at, expiresAt: signedManifest.expires_at,
      sourceVectorHash: signedManifest.source_vector_hash })
    assert.equal(signedManifest.manifest_mac, createHmac('sha256', sourceKey).update(preimage).digest('hex'))
    const altered = JSON.parse(signedPayload.toString('utf8'))
    altered.binding.anchorSeq = String(BigInt(first.binding.anchorSeq) + 1n)
    assert.throws(() => preparedUpload.decodeRecoveryArchivePreparedEnvelope(Buffer.from(JSON.stringify(altered))),
      { message: 'RECOVERY_ARCHIVE_PREPARED_ENVELOPE_INVALID' })
    let resumedSections = 0
    await manual({ ...first, source: null, capture: async () => { throw new Error('SYNTHETIC_RECAPTURE_FORBIDDEN') },
      upload: async (envelope, section) => {
        const plaintext = archiveCrypto.openRecoveryArchiveSection({ binding: { ...envelope.binding,
          sectionName: section.sectionName, plaintextSha256: section.plaintextSha256 },
        dek: sourceKey, nonce: section.nonce, ciphertext: section.ciphertext, authTag: section.authTag })
        const original = manualAdmission.readRecoveryArchiveManualSource(first.source).sections
        const rows = original[section.sectionName as keyof typeof original]
        if (rows !== undefined) assert.equal(Buffer.from(plaintext).toString('utf8'),
          manifest.canonicalizeRecoveryArchiveSectionRows(section.sectionName,
            sectionRows.buildRecoveryArchiveSectionRows(section.sectionName, rows)).canonicalJson)
        if (section.sectionName === 'coverage_index') {
          const coverage = JSON.parse(Buffer.from(plaintext).toString('utf8')) as { payload: { source_kind: string; source_id: string; source_sha256: string } }[]
          assert.equal(coverage.length, 28)
          assert.equal(coverage.filter((row) => row.payload.source_kind === 'section_revision').length, 9)
          assert.equal(coverage.filter((row) => row.payload.source_kind === 'snapshot_membership').length, 9)
          assert.equal(coverage.filter((row) => row.payload.source_kind === 'sealed_operation_endpoint').length, 10)
          const endpoint = (await query(`SELECT sheet_id,operation_id::text,endpoint_seq::text,event_count,
            created_at,operation_kind,event_contract_version,component_count FROM meta_record_history_operations
            WHERE sheet_id=$1 AND operation_id=$2::uuid`, [first.binding.sheetId, first.binding.anchorOperationId])).rows[0]
          endpoint.created_at = endpoint.created_at.toISOString()
          const hashing = require('../src/multitable/recovery-archive-source-hash.ts') as typeof import('../src/multitable/recovery-archive-source-hash')
          const hashed = hashing.computeRecoveryArchiveSourceHash('sealed_operation_endpoint', endpoint, endpoint.endpoint_seq)
          assert.equal(coverage.find((row) => row.payload.source_kind === 'sealed_operation_endpoint'
            && row.payload.source_id === hashed.sourceId)?.payload.source_sha256, hashed.hash)
        }
        resumedSections++
      } })
    assert.equal(resumedSections, 10)
    const signedRevoker = new Client({ ...connection, database })
    await signedRevoker.connect()
    try {
      let authorizedUploads = 0
      await assert.rejects(manual({ ...first, source: null, capture,
        upload: async () => {
          authorizedUploads++
          await signedRevoker.query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
        } }), { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
      assert.equal(authorizedUploads, 1)
    } finally {
      await signedRevoker.query('UPDATE users SET is_active=true WHERE id=$1', [actorId])
      await signedRevoker.end()
    }
    assert.equal(captures, captureCount)
    assert.equal(authenticated, 1, 'durable resume must not sign again')
    assert.equal(produced, 1)
    assert.equal(reserved, 0)
    assert.equal(await nonceCount(first.owner.generationId), 10)
    const unsigned = await continuation()
    let unsignedUploads = 0
    await assert.rejects(manual({ ...unsigned, capture: async (source) => ({ ...await capture(source),
      binding: unsigned.binding, keyCustody: { ...custody,
        async macManifestRoot() { throw new Error('SYNTHETIC_MAC_UNAVAILABLE') } } }),
    upload: async () => { unsignedUploads++ } }),
    { message: 'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED' })
    assert.equal(unsignedUploads, 0)
    assert.equal(await uploadInput.transaction((q) => prepared.readRecoveryArchivePreparedCapture(q, unsigned.owner)), null)
    console.log('PASS: authenticated canonical manifest persisted before upload; root MAC, binding refusal, no-resign resume and MAC failure atomicity')
    const conflict = await continuation()
    const conflictPlan = await capture(manualAdmission.readRecoveryArchiveManualSource(conflict.source))
    conflictPlan.binding = conflict.binding
    const last = conflictPlan.sections.at(-1)!
    const fingerprint = createHmac('sha256', sourceKey).update(archiveCrypto.RECOVERY_ARCHIVE_DEK_FINGERPRINT_DOMAIN).digest('hex')
    await query(`SELECT meta_recovery_archive_reserve_nonce($1,$2,$3::uuid,$4,$5,1)`,
      [fingerprint, last.nonce.toString('hex'), conflict.owner.generationId, last.sectionName, 'aes-256-gcm'])
    let conflictUploads = 0
    await assert.rejects(manual({ ...conflict, capture: async () => conflictPlan,
      upload: async () => { conflictUploads++ } }), { message: 'RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED' })
    assert.equal(conflictUploads, 0)
    assert.equal(await nonceCount(conflict.owner.generationId), 1, 'earlier nine reservations must roll back')
    assert.equal(await transaction(() => prepared.readRecoveryArchivePreparedCapture(query, conflict.owner)), null)
    assert.deepEqual(await sealedMembers(conflict.binding.anchorOperationId), expectedMembers(conflict, 'section_checkpoint'),
      'historical seals precede custody; nonce failure must not publish or persist ciphertext')
    const repeated = await continuation()
    let repeatedUploads = 0
    await manual({ ...repeated, capture: async (snapshot) => ({ ...await capture(snapshot), binding: repeated.binding }),
      upload: async () => { repeatedUploads++ } })
    assert.equal(repeatedUploads, 10)
    assert.deepEqual(await sealedMembers(repeated.binding.anchorOperationId), expectedMembers(repeated, 'section_checkpoint'))
    const stores = require('../src/multitable/recovery-archive-object-store.ts') as typeof import('../src/multitable/recovery-archive-object-store')
    const provider = stores.createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: join(root, 'sealed-objects') })
    const objectUpload = createRecoveryArchiveManualObjectUpload(uploadInput.transaction, { ...repeated, provider })
    const objectExpiry = (await query('SELECT expires_at FROM meta_recovery_archives WHERE generation_id=$1::uuid',
      [repeated.owner.generationId])).rows[0].expires_at.toISOString()
    const resumeWithObjects = () => manual({ ...repeated, source: null,
      capture: async () => { throw new Error('SYNTHETIC_RECAPTURE_FORBIDDEN') }, upload: async (envelope, section) => {
        await objectUpload(envelope, { ...section, ciphertext: Buffer.from('SYNTHETIC_UNTRUSTED_PLAINTEXT') })
        const objectBytes = Buffer.concat([section.ciphertext, section.authTag])
        const digest = createHash('sha256').update(objectBytes).digest('hex')
        const stored = await provider.get({ generationId: repeated.owner.generationId, objectId: digest,
          expectedVersion: digest, expectedSha256: digest, expectedSize: String(objectBytes.length), expectedExpiresAt: objectExpiry })
        assert.ok(Buffer.from(stored.bytes).equals(objectBytes))
        const downloaded = Buffer.from(stored.bytes)
        const recovered = archiveCrypto.openRecoveryArchiveSection({ binding: { ...envelope.binding,
          sectionName: section.sectionName, plaintextSha256: section.plaintextSha256 }, dek: sourceKey,
        nonce: section.nonce, ciphertext: downloaded.subarray(0, -16), authTag: downloaded.subarray(-16) })
        assert.equal(createHash('sha256').update(recovered).digest('hex'), section.plaintextSha256)
      } })
    await resumeWithObjects()
    await resumeWithObjects()
    const receipts = (await query(`SELECT object_class,section_name,state FROM meta_recovery_archive_objects
      WHERE generation_id=$1::uuid ORDER BY section_name`, [repeated.owner.generationId])).rows
    assert.equal(receipts.length, 10)
    assert.deepEqual(receipts.map((row) => row.section_name).sort(), [...archiveContract.RECOVERY_ARCHIVE_V1_SECTION_NAMES].sort())
    assert.ok(receipts.every((row) => row.object_class === 'section' && row.state === 'uploaded'))
    const uploadManifest = createRecoveryArchiveManualManifestUpload(uploadInput.transaction, { ...repeated, provider })
    const finalize = createRecoveryArchiveManualFinalization(uploadInput.transaction)
    const finalInput = { identity: repeated.identity, owner: repeated.owner,
      keyCustody: custody, transactionDepth: repeated.transactionDepth,
      key: { keyId: repeated.binding.keyId, expectedRowVersion: admissionPolicy.keyRowVersion } }
    await assert.rejects(finalize(finalInput), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    await uploadManifest()
    await uploadManifest()
    const manifestReceipt = (await query(`SELECT object_id,provider_version,plaintext_sha256,ciphertext_sha256,
      size_bytes::text,state,section_name,attachment_id FROM meta_recovery_archive_objects
      WHERE generation_id=$1::uuid AND object_class='manifest'`, [repeated.owner.generationId])).rows
    assert.equal(manifestReceipt.length, 1)
    assert.equal(manifestReceipt[0].state, 'uploaded')
    assert.equal(manifestReceipt[0].section_name, null)
    assert.equal(manifestReceipt[0].attachment_id, null)
    const durable = await uploadInput.transaction((q) => prepared.readRecoveryArchivePreparedCapture(q, repeated.owner))
    assert.ok(durable)
    const expectedManifest = preparedUpload.decodeRecoveryArchivePreparedEnvelope(durable).manifestEnvelope!
    const manifestDigest = createHash('sha256').update(expectedManifest).digest('hex')
    assert.equal(manifestReceipt[0].plaintext_sha256, manifestDigest)
    assert.equal(manifestReceipt[0].ciphertext_sha256, manifestDigest)
    const storedManifest = await provider.get({ generationId: repeated.owner.generationId, objectId: manifestDigest,
      expectedVersion: manifestDigest, expectedSha256: manifestDigest, expectedSize: String(expectedManifest.length),
      expectedExpiresAt: objectExpiry })
    assert.ok(Buffer.from(storedManifest.bytes).equals(expectedManifest))
    assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_objects
      WHERE generation_id=$1::uuid AND state='verified'`, [repeated.owner.generationId])).rows[0].n, 0)
    await assert.rejects(finalize({ ...finalInput, identity: { ...finalInput.identity, requestId: randomUUID() } }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    await assert.rejects(finalize({ ...finalInput, key: { ...finalInput.key, expectedRowVersion: '999' } }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    await assert.rejects(finalize({ ...finalInput, keyCustody: { ...custody, async verifyManifestRootMac() { return false } } }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    try {
      await assert.rejects(finalize({ ...finalInput, keyCustody: { ...custody, async verifyManifestRootMac() {
        await query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
        return true
      } } }), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    } finally { await query('UPDATE users SET is_active=true WHERE id=$1', [actorId]) }
    const revokedFinalize = createRecoveryArchiveManualFinalization((work) => uploadInput.transaction(async (q) => {
      await q('UPDATE users SET is_active=false WHERE id=$1', [actorId])
      return work(q)
    }))
    await assert.rejects(revokedFinalize(finalInput), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    let finalizeTransactions = 0
    const driftFinalize = createRecoveryArchiveManualFinalization((work) => uploadInput.transaction(async (q) => {
      if (++finalizeTransactions === 2) await q(`UPDATE meta_records SET data='{"manual-source-field":"before-finalize"}' WHERE id='manual-source-record'`)
      return work(q)
    }))
    await assert.rejects(driftFinalize(finalInput), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    const faultFinalize = createRecoveryArchiveManualFinalization((work) => uploadInput.transaction((q) => work(async (sql, params) => {
      if (sql.startsWith('UPDATE meta_recovery_archives SET state=')) throw new Error('SYNTHETIC_FINAL_WRITE_FAILURE')
      return q(sql, params)
    })))
    await assert.rejects(faultFinalize(finalInput), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_objects
      WHERE generation_id=$1::uuid AND state='verified'`, [repeated.owner.generationId])).rows[0].n, 0)
    assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_coverage_items
      WHERE generation_id=$1::uuid`, [repeated.owner.generationId])).rows[0].n, 0)
    await finalize(finalInput)
    assert.deepEqual((await query(`SELECT state,build_status,coverage_status,coverage_row_count::text
      FROM meta_recovery_archives WHERE generation_id=$1::uuid`, [repeated.owner.generationId])).rows,
    [{ state: 'verified', build_status: 'finalized', coverage_status: 'complete', coverage_row_count: '28' }])
    assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_objects
      WHERE generation_id=$1::uuid AND state='verified'`, [repeated.owner.generationId])).rows[0].n, 11)
    console.log('PASS: atomic manual archive publication with authentic 28-row coverage and eleven verified receipts')
    const revokedUpload = await continuation()
    const revoker = new Client({ ...connection, database })
    await revoker.connect()
    try {
      const revokingProvider = { ...provider, async head(request: Parameters<typeof provider.head>[0]) {
        const result = await provider.head(request)
        await revoker.query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
        return result
      } }
      await assert.rejects(manual({ ...revokedUpload,
        capture: async (snapshot) => ({ ...await capture(snapshot), binding: revokedUpload.binding }),
        upload: createRecoveryArchiveManualObjectUpload(uploadInput.transaction, { ...revokedUpload, provider: revokingProvider }) }),
      { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
      assert.equal((await query('SELECT count(*)::int AS n FROM meta_recovery_archive_objects WHERE generation_id=$1::uuid',
        [revokedUpload.owner.generationId])).rows[0].n, 0)
      await revoker.query('UPDATE users SET is_active=true WHERE id=$1', [actorId])
      await assert.rejects(createRecoveryArchiveManualManifestUpload(uploadInput.transaction,
        { ...revokedUpload, provider: { ...provider, async head() { throw new Error('SYNTHETIC_HEAD_UNAVAILABLE') } } })(),
      { message: 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_PROVIDER_FAILED' })
      await assert.rejects(createRecoveryArchiveManualManifestUpload(uploadInput.transaction,
        { ...revokedUpload, provider: revokingProvider })(),
      { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
      assert.equal((await query('SELECT count(*)::int AS n FROM meta_recovery_archive_objects WHERE generation_id=$1::uuid',
        [revokedUpload.owner.generationId])).rows[0].n, 0)
    } finally {
      await revoker.query('UPDATE users SET is_active=true WHERE id=$1', [actorId])
      await revoker.end()
    }
    console.log('PASS: real local PUT/HEAD records ten sections and one durable signed manifest; idempotent replay, HEAD failure and post-IO revocation guards; uploader alone does not publish')
    const local = require('../src/multitable/recovery-local-custody.ts') as typeof import('../src/multitable/recovery-local-custody')
    const localStores = require('../src/multitable/recovery-local-custody-store.ts') as typeof import('../src/multitable/recovery-local-custody-store')
    const custodyId = randomUUID()
    const recoverySecret = randomBytes(32)
    const localSession = local.createLocalCustodySession(first.transactionDepth)
    const restoredSession = local.createLocalCustodySession(first.transactionDepth)
    const archivePath = join(root, 'local-custody-archive')
    const custodyPath = join(root, 'local-custody-keys')
    await mkdir(archivePath, { mode: 0o700 })
    await mkdir(custodyPath, { mode: 0o700 })
    const backup = local.createLocalCustodyBackup({ custodyId, recoverySecret, transactionDepth: first.transactionDepth })
    try {
      const custodyStore = await localStores.createLocalCustodyStore({ custodyId, archivePath, custodyPath,
        transactionDepth: first.transactionDepth })
      const receipt = await custodyStore.putBackup(randomUUID(), backup)
      localSession.unlock({ custodyId, backup, recoverySecret })
      const capability = localSession.admitForArchive(custodyId)
      await query('INSERT INTO meta_recovery_archive_keys(key_id) VALUES ($1)', [capability.keyId])
      const localInput = await continuation(createRecoveryArchiveManualAdmission(uploadInput.transaction,
        { ...admissionPolicy, keyId: capability.keyId }))
      const localProvider = stores.createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: archivePath })
      await manual({ ...localInput, capture: async (snapshot) => ({ ...await capture(snapshot),
        binding: localInput.binding, keyCustody: capability }),
      upload: createRecoveryArchiveManualObjectUpload(uploadInput.transaction, { ...localInput, provider: localProvider }) })
      localSession.lock()
      const persisted = await transaction(() => prepared.readRecoveryArchivePreparedCapture(query, localInput.owner))
      assert.ok(persisted)
      const uploadModule = require('../src/multitable/recovery-archive-prepared-upload.ts') as typeof import('../src/multitable/recovery-archive-prepared-upload')
      const envelope = uploadModule.decodeRecoveryArchivePreparedEnvelope(persisted)
      const savedBackup = await custodyStore.readBackup(receipt)
      try {
        assert.throws(() => restoredSession.unlock({ custodyId, backup: savedBackup, recoverySecret: randomBytes(32) }),
          { message: 'RECOVERY_LOCAL_CUSTODY_REFUSED' })
        restoredSession.unlock({ custodyId, backup: savedBackup, recoverySecret })
      } finally { savedBackup.fill(0) }
      assert.throws(() => restoredSession.openLocalDek({ generationId: randomUUID(),
        keyId: capability.keyId.split(':')[2]!, wrappedId: envelope.binding.wrappedDekId, wrapped: envelope.wrappedDek }),
      { message: 'RECOVERY_LOCAL_CUSTODY_REFUSED' })
      const tamperedWrapped = Buffer.from(envelope.wrappedDek)
      tamperedWrapped[0] = tamperedWrapped[0]! ^ 1
      assert.throws(() => restoredSession.openLocalDek({ generationId: localInput.owner.generationId,
        keyId: capability.keyId.split(':')[2]!, wrappedId: envelope.binding.wrappedDekId, wrapped: tamperedWrapped }),
      { message: 'RECOVERY_LOCAL_CUSTODY_REFUSED' })
      tamperedWrapped.fill(0)
      const dek = restoredSession.openLocalDek({ generationId: localInput.owner.generationId,
        keyId: capability.keyId.split(':')[2]!, wrappedId: envelope.binding.wrappedDekId, wrapped: envelope.wrappedDek })
      try {
        for (const section of envelope.sections) {
          const plaintext = archiveCrypto.openRecoveryArchiveSection({ binding: { ...envelope.binding,
            sectionName: section.sectionName, plaintextSha256: section.plaintextSha256 },
          dek, nonce: section.nonce, ciphertext: section.ciphertext, authTag: section.authTag })
          assert.equal(createHash('sha256').update(plaintext).digest('hex'), section.plaintextSha256)
        }
      } finally { dek.fill(0) }
      await manual({ ...localInput, source: null, capture: async () => { throw new Error('SYNTHETIC_RECAPTURE_FORBIDDEN') },
        upload: createRecoveryArchiveManualObjectUpload(uploadInput.transaction, { ...localInput, provider: localProvider }) })
      assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_objects
        WHERE generation_id=$1::uuid AND state='uploaded'`, [localInput.owner.generationId])).rows[0].n, 10)
      await createRecoveryArchiveManualManifestUpload(uploadInput.transaction, { ...localInput, provider: localProvider })()
      await finalize({ identity: localInput.identity, owner: localInput.owner,
        key: { keyId: capability.keyId, expectedRowVersion: '1' },
        keyCustody: restoredSession.admitForArchive(custodyId), transactionDepth: first.transactionDepth })
      assert.equal((await query(`SELECT state FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
        [localInput.owner.generationId])).rows[0].state, 'verified')
      const reader = require('../src/multitable/recovery-archive-reader.ts') as typeof import('../src/multitable/recovery-archive-reader')
      const localManifest = manifestObjects.parseRecoveryArchiveManifestObjectEnvelope(envelope.manifestEnvelope!).manifest
      const storedObjects = (await query(`SELECT object_class,section_name,object_id,provider_version,ciphertext_sha256,size_bytes::text
        FROM meta_recovery_archive_objects WHERE generation_id=$1::uuid AND state='verified'`,
      [localInput.owner.generationId])).rows
      const objectBinding = (sectionName: string | null) => {
        const object = storedObjects.find((row) => row.section_name === sectionName)!
        return { generationId: localInput.owner.generationId, objectId: object.object_id,
          expectedVersion: object.provider_version, expectedSha256: object.ciphertext_sha256,
          expectedSize: object.size_bytes, expectedExpiresAt: localManifest.expires_at }
      }
      const opened = await reader.readRecoveryArchiveCompleteSectionState({
        query,
        selectedBinding: { generationId: localInput.owner.generationId, workspaceId: localInput.identity.workspaceId,
          baseId: localInput.identity.baseId, sheetId: localInput.identity.sheetId,
          anchorOperationId: localInput.binding.anchorOperationId, anchorSeq: localInput.binding.anchorSeq,
          checkpointId: localInput.binding.checkpointId, rootHash: localManifest.root_hash,
          sourceVectorHash: localInput.owner.sourceVectorHash },
        keyCustody: restoredSession.admitForArchive(custodyId), transactionDepth: first.transactionDepth,
        objectStore: localProvider, manifestObject: objectBinding(null),
        sectionObjects: archiveContract.RECOVERY_ARCHIVE_V1_SECTION_NAMES.map(objectBinding) })
      assert.equal(opened.records.size, 1)
      assert.equal(opened.coverage_index.length, 28)
      console.log('PASS: real local custody backup; locked-session upload resume, fresh-session authenticated publication and public archive reader reconciles all ten stored sections')
      const { createRecoveryArchiveManualCommand } = require('../src/routes/univer-meta.ts') as typeof import('../src/routes/univer-meta')
      let refusePreviewObjectRead = false
      let corruptPreviewObjectRead = false
      const runtime = { keyCustody: restoredSession.admitForArchive(custodyId),
        objectStore: { ...localProvider, async get(...args: Parameters<typeof localProvider.get>) {
          if (refusePreviewObjectRead) throw new Error('SYNTHETIC_PREVIEW_OBJECT_UNAVAILABLE')
          const stored = await localProvider.get(...args)
          if (!corruptPreviewObjectRead) return stored
          const bytes = Uint8Array.from(stored.bytes)
          bytes[0] = bytes[0]! ^ 1
          return { ...stored, bytes }
        } }, transactionDepth: first.transactionDepth }
      const command = createRecoveryArchiveManualCommand(uploadInput.transaction, runtime,
        { ...admissionPolicy, keyId: capability.keyId })
      const commandIdentity = { ...localInput.identity, requestId: randomUUID() }
      const archiveFlag = process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
      const fenceFlag = process.env.MULTITABLE_ENABLE_WRITER_FENCE
      const strictFlag = process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
      try {
        process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
        process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
        await assert.rejects(createRecoveryArchiveManualCommand(uploadInput.transaction, runtime).capture(commandIdentity),
          { message: 'RECOVERY_ARCHIVE_MANUAL_POLICY_UNAVAILABLE' })
        await assert.rejects(command.read(commandIdentity), { message: 'RECOVERY_ARCHIVE_MANUAL_NOT_FOUND' })
        const completed = await command.capture(commandIdentity)
        assert.deepEqual(completed, { requestId: commandIdentity.requestId, generationId: completed.generationId, state: 'recoverable' })
        assert.deepEqual(await command.read(commandIdentity), completed)
        assert.deepEqual(await command.capture(commandIdentity), completed)
        assert.equal((await query('SELECT count(*)::int AS n FROM meta_recovery_archive_objects WHERE generation_id=$1::uuid',
          [completed.generationId])).rows[0].n, 11)
        const interruptedIdentity = { ...commandIdentity, requestId: randomUUID() }
        const interruptedCommand = createRecoveryArchiveManualCommand(uploadInput.transaction,
          { ...runtime, objectStore: { ...localProvider, async put() { throw new Error('SYNTHETIC_COMMAND_UPLOAD_INTERRUPTION') } } },
          { ...admissionPolicy, keyId: capability.keyId })
        await assert.rejects(interruptedCommand.capture(interruptedIdentity))
        const interruptedStatus = await command.read(interruptedIdentity)
        assert.equal(interruptedStatus.state, 'pending')
        const payloadBefore = (await query('SELECT payload_sha256 FROM meta_recovery_archive_prepared_captures WHERE generation_id=$1::uuid',
          [interruptedStatus.generationId])).rows[0].payload_sha256
        assert.deepEqual(await command.capture(interruptedIdentity), { ...interruptedStatus, state: 'recoverable' })
        assert.equal((await query('SELECT payload_sha256 FROM meta_recovery_archive_prepared_captures WHERE generation_id=$1::uuid',
          [interruptedStatus.generationId])).rows[0].payload_sha256, payloadBefore)
        assert.equal(await nonceCount(interruptedStatus.generationId), 10)
        await assert.rejects(command.read({ ...commandIdentity, sheetId: 's' }), { message: 'RECOVERY_ARCHIVE_MANUAL_REQUEST_CONFLICT' })
        await query('UPDATE users SET is_active=false WHERE id=$1', [actorId])
        await assert.rejects(command.read(commandIdentity), { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
        await query('UPDATE users SET is_active=true WHERE id=$1', [actorId])
        const lostIdentity = { ...commandIdentity, requestId: randomUUID() }
        const lost = await createRecoveryArchiveManualAdmission(uploadInput.transaction,
          { ...admissionPolicy, keyId: capability.keyId, leaseSeconds: 2 })(lostIdentity)
        const sourceMissing = { requestId: lostIdentity.requestId, generationId: lost.generationId, state: 'pending' }
        assert.deepEqual(await command.capture(lostIdentity), sourceMissing)
        assert.equal((await query('SELECT count(*)::int AS n FROM meta_recovery_archive_prepared_captures WHERE generation_id=$1::uuid',
          [lost.generationId])).rows[0].n, 0, 'retry must not recapture after opaque source was lost')
        await query('SELECT pg_sleep(2.1)')
        assert.deepEqual(await command.capture(lostIdentity), { ...sourceMissing, state: 'incomplete' })
        // Real HTTP registrar + canonical database authority, with synthetic authentication only.
        const { RECOVERY_AUTHORITY_TRIGGERS } = require('../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts') as typeof import('../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks')
        for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
          await query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
        }
        const express = require('express') as typeof import('express')
        const { univerMetaRouter } = require('../src/routes/univer-meta.ts') as typeof import('../src/routes/univer-meta')
        const httpApp = express()
        httpApp.use(express.json())
        httpApp.use((req, _res, next) => {
          if (req.headers.authorization === 'Bearer synthetic-manual-owner') req.user = { id: actorId, role: 'admin' }
          next()
        })
        // Browser status/catalog requests overlap: each transaction owns its connection.
        const httpPool = new Pool({ ...connection, database, max: 4 })
        const httpDepth = new AsyncLocalStorage<number>()
        const httpProbe = { currentTransactionDepth: () => httpDepth.getStore() ?? 0 }
        const httpDatabase: import('../src/routes/univer-meta').RecoveryArchiveRouterDatabaseRuntime = {
          query: (text, params) => httpPool.query(text, params),
          transactionDepthProbe: httpProbe,
          async transaction(work) {
            const owned = await httpPool.connect()
            try {
              await owned.query('BEGIN')
              const result = await httpDepth.run(1, () => work((text, params) => owned.query(text, params)))
              await owned.query('COMMIT')
              return result
            } catch (error) {
              await owned.query('ROLLBACK')
              throw error
            } finally { owned.release() }
          },
        }
        httpApp.use('/api/multitable', univerMetaRouter({ recoveryArchiveRuntime: { ...runtime, transactionDepth: httpProbe },
          recoveryArchiveDatabaseRuntime: httpDatabase,
          recoveryArchiveAuditedReplayHorizonMs: 60000, // Synthetic fixture policy, never a runtime default.
          recoveryArchiveManualPolicy: { ...admissionPolicy, keyId: capability.keyId } }))
        const httpServer = httpApp.listen(0, '127.0.0.1')
        try {
          await new Promise<void>((resolve, reject) => { httpServer.once('listening', resolve); httpServer.once('error', reject) })
          const address = httpServer.address()
          assert.ok(address && typeof address !== 'string')
          const captureUrl = `http://127.0.0.1:${address.port}/api/multitable/sheets/no-genesis/recovery-archive/captures`
          const headers = { 'content-type': 'application/json', authorization: 'Bearer synthetic-manual-owner' }
          const httpRequestId = randomUUID()
          assert.equal((await fetch(captureUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: httpRequestId }) })).status, 401)
          assert.equal((await fetch(captureUrl, { method: 'POST', headers,
            body: JSON.stringify({ requestId: httpRequestId, actorId }) })).status, 400)
          const submitted = await fetch(captureUrl, { method: 'POST', headers, body: JSON.stringify({ requestId: httpRequestId }) })
          assert.equal(submitted.status, 200)
          const publicResult = await submitted.json() as { ok: boolean; data: { requestId: string; generationId: string; state: string } }
          assert.deepEqual(publicResult, { ok: true, data: { requestId: httpRequestId,
            generationId: publicResult.data.generationId, state: 'recoverable' } })
          const statusResponse = await fetch(`${captureUrl}/${httpRequestId}`, { headers })
          assert.equal(statusResponse.status, 200)
          assert.deepEqual(await statusResponse.json(), publicResult)
          const replayResponse = await fetch(captureUrl, { method: 'POST', headers, body: JSON.stringify({ requestId: httpRequestId }) })
          assert.equal(replayResponse.status, 200)
          assert.deepEqual(await replayResponse.json(), publicResult)
          const catalogUrl = captureUrl.replace('/captures', `/catalog/${publicResult.data.generationId}`)
          const catalogResponse = await fetch(catalogUrl, { headers })
          assert.equal(catalogResponse.status, 200)
          const catalog = await catalogResponse.json() as { ok: boolean; data: { generationId: string } }
          assert.equal(catalog.ok, true)
          assert.equal(catalog.data.generationId, publicResult.data.generationId)
          const previewUrl = captureUrl.replace('/captures', '/preview')
          const previewBody = JSON.stringify({ generationId: publicResult.data.generationId,
            mode: 'revert', scope: { kind: 'whole_sheet' } })
          const previewResponse = await fetch(previewUrl, { method: 'POST', headers, body: previewBody })
          assert.equal(previewResponse.status, 200)
          const previewResult = await previewResponse.json() as { ok: boolean; data: {
            generationId: string; executable: boolean; blockedReason: string; previewIdentity: null;
            summary: { effectiveWriteCount: number } } }
          assert.equal(previewResult.ok, true)
          assert.equal(previewResult.data.generationId, publicResult.data.generationId)
          assert.equal(previewResult.data.blockedReason, 'no_changes')
          assert.equal(previewResult.data.executable, false)
          assert.equal(previewResult.data.previewIdentity, null)
          assert.equal(previewResult.data.summary.effectiveWriteCount, 0)
          refusePreviewObjectRead = true
          try {
            const refused = await fetch(previewUrl, { method: 'POST', headers, body: previewBody })
            assert.equal(refused.status, 503)
            const refusedBody = await refused.text()
            assert.ok(!refusedBody.includes('SYNTHETIC_PREVIEW_OBJECT_UNAVAILABLE'))
          } finally { refusePreviewObjectRead = false }
          corruptPreviewObjectRead = true
          try {
            const corrupted = await fetch(previewUrl, { method: 'POST', headers, body: previewBody })
            assert.equal(corrupted.status, 503)
          } finally { corruptPreviewObjectRead = false }
          assert.equal((await fetch(previewUrl, { method: 'POST', headers, body: previewBody })).status, 200)
          const originalLive = (await query(`SELECT data,version,updated_at FROM meta_records
            WHERE id='manual-source-record'`)).rows[0]
          let restoredThroughHttp = false
          try {
            await query(`UPDATE meta_records SET data='{"manual-source-field":"synthetic-post-archive-edit"}',
              version=version+1 WHERE id='manual-source-record'`)
            const changedResponse = await fetch(previewUrl, { method: 'POST', headers, body: previewBody })
            assert.equal(changedResponse.status, 200)
            const changed = await changedResponse.json() as { ok: boolean; data: {
              executable: boolean; blockedReason: null; previewIdentity: string;
              summary: { effectiveWriteCount: number; reverts: { recordId: string; fieldIds: string[] }[] } } }
            assert.equal(changed.ok, true)
            assert.equal(changed.data.executable, true)
            assert.equal(changed.data.blockedReason, null)
            assert.equal(typeof changed.data.previewIdentity, 'string')
            assert.ok(changed.data.previewIdentity.length > 0)
            assert.equal(changed.data.summary.effectiveWriteCount, 1)
            assert.deepEqual(changed.data.summary.reverts, [{ recordId: 'manual-source-record', fieldIds: ['manual-source-field'] }])
            assert.deepEqual((await query(`SELECT data FROM meta_records WHERE id='manual-source-record'`)).rows[0].data,
              { 'manual-source-field': 'synthetic-post-archive-edit' }, 'preview must not apply the recovery')
            const executeUrl = captureUrl.replace('/captures', '/execute')
            const executeBody = JSON.stringify({ previewIdentity: changed.data.previewIdentity, scope: { kind: 'whole_sheet' } })
            const restoreHistory = async () => (await query(`SELECT revision.actor_id,revision.source,
              revision.changed_field_ids,revision.patch,revision.snapshot,operation.event_count,
              (operation.endpoint_seq IS NOT NULL) AS sealed
              FROM meta_record_revisions revision
              JOIN meta_record_history_operations operation ON operation.operation_id=revision.operation_id
              WHERE revision.record_id='manual-source-record' AND revision.source='restore'
              ORDER BY revision.seq`)).rows
            const beforeRestoreHistory = await restoreHistory()
            process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'false'
            const disabledExecute = await fetch(executeUrl, { method: 'POST', headers, body: executeBody })
            assert.equal(disabledExecute.status, 409)
            assert.equal((await disabledExecute.json()).error.code, 'RECOVERY_TRUST_REQUIRED')
            assert.deepEqual(await restoreHistory(), beforeRestoreHistory)
            process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = 'true'
            const appliedResponse = await fetch(executeUrl, { method: 'POST', headers, body: executeBody })
            const applied = await appliedResponse.json()
            assert.equal(appliedResponse.status, 200, JSON.stringify(applied))
            assert.equal(applied.ok, true)
            assert.equal(applied.data.revertedCount, 1)
            assert.equal(applied.data.resurrectedCount, 0)
            assert.equal(applied.data.deletedCount, 0)
            assert.deepEqual((await query(`SELECT data FROM meta_records WHERE id='manual-source-record'`)).rows[0].data,
              originalLive.data, 'real HTTP execution must restore the archived field value')
            restoredThroughHttp = true
            const restoredHistory = await restoreHistory()
            assert.equal(restoredHistory.length, beforeRestoreHistory.length + 1)
            assert.deepEqual(restoredHistory.at(-1), { actor_id: actorId, source: 'restore',
              changed_field_ids: ['manual-source-field'], patch: originalLive.data,
              snapshot: originalLive.data, event_count: 1, sealed: true })
            const afterApply = (await query(`SELECT data,version FROM meta_records WHERE id='manual-source-record'`)).rows[0]
            const replayedResponse = await fetch(executeUrl, { method: 'POST', headers, body: executeBody })
            assert.equal(replayedResponse.status, 409)
            assert.deepEqual((await query(`SELECT data,version FROM meta_records WHERE id='manual-source-record'`)).rows[0], afterApply)
            assert.deepEqual(await restoreHistory(), restoredHistory)
            console.log('PASS: real HTTP archive execution restores synthetic field and sealed restore history; consumed preview replay refuses without another write/history event')
          } finally {
            if (!restoredThroughHttp) {
              await query(`UPDATE meta_records SET data=$1::jsonb,version=$2,updated_at=$3 WHERE id='manual-source-record'`,
                [JSON.stringify(originalLive.data), originalLive.version, originalLive.updated_at])
            }
          }
          console.log('PASS: public HTTP capture/catalog/preview; unchanged no_changes; edited field exact executable plan without apply; missing/corrupt object refuses; restored reads recover')
          if (process.env.TM_MANUAL_TEST_BROWSER === 'true') {
            const { verifyManualArchiveBrowser } = await import('./verify-recovery-manual-browser.mjs')
            await verifyManualArchiveBrowser(`http://127.0.0.1:${address.port}`, async () => {
              const before = (await query(`SELECT data,version FROM meta_records WHERE id='manual-source-record'`)).rows[0]
              const historyCount = async () => (await query(`SELECT count(*)::int AS n FROM meta_record_revisions
                WHERE record_id='manual-source-record' AND source='restore'`)).rows[0].n
              const beforeHistory = await historyCount()
              await query(`UPDATE meta_records SET data='{"manual-source-field":"synthetic-browser-edit"}',
                version=version+1 WHERE id='manual-source-record'`)
              return async () => {
                const after = (await query(`SELECT data,version FROM meta_records WHERE id='manual-source-record'`)).rows[0]
                assert.deepEqual(after.data, before.data)
                assert.equal(Number(after.version), Number(before.version) + 2)
                assert.equal(await historyCount(), beforeHistory + 1)
              }
            })
          }
        } finally {
          try {
            httpServer.closeIdleConnections()
            await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()))
            assert.equal(httpServer.address(), null)
          } finally { await httpPool.end() }
        }
        process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'false'
        await assert.rejects(command.capture({ ...commandIdentity, requestId: randomUUID() }),
          { message: 'RECOVERY_ARCHIVE_MANUAL_UNAVAILABLE' })
        await assert.rejects(command.read(commandIdentity), { message: 'RECOVERY_ARCHIVE_MANUAL_UNAVAILABLE' })
      } finally {
        await query('UPDATE users SET is_active=true WHERE id=$1', [actorId])
        if (archiveFlag === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
        else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = archiveFlag
        if (fenceFlag === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
        else process.env.MULTITABLE_ENABLE_WRITER_FENCE = fenceFlag
        if (strictFlag === undefined) delete process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT
        else process.env.MULTITABLE_HISTORY_CONTIGUITY_STRICT = strictFlag
      }
      console.log('PASS: real HTTP manual command/status through canonical authority with synthetic authentication; exact retry, lost-source no-recapture, expired lease, revoked identity and default-OFF gates; listener closed')
    } finally {
      localSession.lock()
      restoredSession.lock()
      backup.fill(0)
      recoverySecret.fill(0)
    }
    console.log('PASS: manual bootstrap/repeat seal exact nine data hashes; real 28-row coverage replaces callback input; nonce failure leaves only historical seals')
    const drift = await continuation()
    const driftWriter = new Client({ ...connection, database })
    await driftWriter.connect()
    let driftUploads = 0
    try {
      await assert.rejects(manual({ ...drift, capture: async (snapshot) => ({
        ...await capture(snapshot), binding: drift.binding,
        keyCustody: { ...custody, async produceGenerationDek(input) {
          await driftWriter.query(`UPDATE meta_records SET data='{"manual-source-field":"during-custody"}',
            version=version+1 WHERE id='manual-source-record'`)
          return custody.produceGenerationDek(input)
        } },
      }), upload: async () => { driftUploads++ } }),
      { message: 'RECOVERY_ARCHIVE_CRYPTO_RESERVATION_FAILED' })
      assert.equal(driftUploads, 0)
      assert.equal(await nonceCount(drift.owner.generationId), 0)
      assert.equal(await transaction(() => prepared.readRecoveryArchivePreparedCapture(query, drift.owner)), null)
    } finally { await driftWriter.end() }
    console.log('PASS: separate-connection source change during custody refuses reservation, prepared persistence and upload')
    console.log('PASS: server-owned ten-row nonce transaction; caller sink ignored; last-row conflict rolls back earlier nine, no prepared ciphertext/upload; resume keeps original reservations')
  } finally { sourceKey.fill(0) }
  console.log('PASS: source generation binding and single use; tampered relational plaintext refused before custody; interrupted first seal resumes ten authenticated original sections without source or recapture')
  const purgeMigration = require('../src/db/migrations/zzzz20260919120000_add_attachment_blob_purge_claim.ts') as typeof import('../src/db/migrations/zzzz20260919120000_add_attachment_blob_purge_claim')
  for (const step of [purgeMigration.down, purgeMigration.down, purgeMigration.up, purgeMigration.up]) await step(db)
  await query('ALTER TABLE multitable_attachments ALTER COLUMN blob_purge_claimed_at SET DEFAULT now()')
  try {
    await assert.rejects(purgeMigration.up(db), { message: 'ATTACHMENT_PURGE_CLAIM_SCHEMA_DRIFT' })
  } finally { await query('ALTER TABLE multitable_attachments ALTER COLUMN blob_purge_claimed_at DROP DEFAULT') }
  await purgeMigration.up(db)
  await query(`INSERT INTO multitable_attachments
    (id,sheet_id,storage_file_id,filename,mime_type,size,storage_path,deleted_at,blob_purged_at)
    VALUES ('manual-live-attachment','no-genesis','manual-live-file','synthetic','text/plain',3,'synthetic/live',NULL,NULL),
    ('manual-deleted-attachment','no-genesis','manual-deleted-file','synthetic','text/plain',3,'synthetic/deleted',now(),NULL)`)
  const pinnedRequest = { ...admissionRequest, requestId: randomUUID() }
  const pinned = await admit(pinnedRequest)
  const pins = async (generationId: string) => (await query(`SELECT attachment_id,reference_class,reference_state,
    availability,immutable_version,content_sha256,content_size_bytes::text,
    source_owner_id,source_owner_fence::text,
    source_lease_until = (SELECT lease_expires_at FROM meta_recovery_archives WHERE generation_id=$1) AS exact_lease
    FROM meta_recovery_archive_attachment_refs WHERE generation_id=$1 ORDER BY attachment_id`, [generationId])).rows
  assert.deepEqual(await pins(pinned.generationId), ['manual-deleted-attachment', 'manual-live-attachment'].map((id) => ({
    attachment_id: id, reference_class: 'source', reference_state: 'building', availability: 'mutable',
    immutable_version: null, content_sha256: null, content_size_bytes: null,
    source_owner_id: pinned.generationId, source_owner_fence: '1', exact_lease: true,
  })))
  assert.deepEqual(await admit(pinnedRequest), { generationId: pinned.generationId, replayed: true, source: null })
  assert.equal((await pins(pinned.generationId)).length, 2)
  const beforePinFailure = await generationCount()
  const failedPinRequest = { ...admissionRequest, requestId: randomUUID() }
  const failingPinAdmission = createRecoveryArchiveManualAdmission(<T,>(work: (q: typeof query) => Promise<T>) =>
    transaction(() => work(async (text, params) => {
      if (text.includes('INSERT INTO public.meta_recovery_archive_attachment_refs')
        && params?.[1] === 'manual-live-attachment') throw new Error('SYNTHETIC_PRIVATE_PIN_FAILURE')
      return query(text, params)
    })), admissionPolicy)
  await assert.rejects(failingPinAdmission(failedPinRequest), { message: 'RECOVERY_ARCHIVE_SOURCE_PIN_CLAIM_REFUSED' })
  assert.equal(await generationCount(), beforePinFailure)
  assert.equal(await transaction(() => manualRequests.readRecoveryArchiveManualRequest(query, failedPinRequest)), null)
  assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_attachment_refs
    WHERE attachment_id IN ('manual-live-attachment','manual-deleted-attachment')`)).rows[0].n, 2)
  console.log('PASS: all live/deleted attachment candidates atomically receive mutable source intents with exact lease/owner; retry unchanged; second pin failure rolls back generation/request/first pin without leaking provider values')
  const { deleteAttachmentBinary } = require('../src/multitable/attachment-service.ts') as typeof import('../src/multitable/attachment-service')
  let pinnedSourceDeletes = 0
  const oldArchiveFlag = process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
  const oldFenceFlag = process.env.MULTITABLE_ENABLE_WRITER_FENCE
  const purgeClient = new Client({ ...connection, database })
  try {
    await purgeClient.connect()
    process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = 'true'
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    await deleteAttachmentBinary({
      storage: { deleteByKey: async () => { pinnedSourceDeletes += 1 },
        delete: async () => { throw new Error('UNEXPECTED_LEGACY_DELETE') } },
      storageFileId: 'manual-deleted-file', storagePath: 'synthetic/deleted',
      query, attachmentId: 'manual-deleted-attachment',
      transaction: <T,>(work: (client: { query: typeof query }) => Promise<T>) => transaction(() => work({ query })),
    })
    assert.equal(pinnedSourceDeletes, 0, 'PINNED_SOURCE_MUST_NOT_REACH_PHYSICAL_DELETE')
    assert.equal((await query(`SELECT blob_purged_at FROM multitable_attachments
      WHERE id='manual-deleted-attachment'`)).rows[0].blob_purged_at, null)
    await query(`INSERT INTO multitable_attachments
      (id,sheet_id,storage_file_id,filename,mime_type,size,storage_path,deleted_at)
      VALUES ('manual-purge-claim','no-genesis','manual-purge-file','synthetic','text/plain',3,'synthetic/purge',now())`)
    const purgeTransaction = async <T,>(work: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
      await purgeClient.query('BEGIN')
      try {
        const result = await work({ query: purgeClient.query.bind(purgeClient) })
        await purgeClient.query('COMMIT')
        return result
      } catch (error) { await purgeClient.query('ROLLBACK'); throw error }
    }
    const refusedDuringDelete = { ...admissionRequest, requestId: randomUUID() }
    const beforePurgeAdmission = await generationCount()
    let providerAttempts = 0
    const purgeInput = {
      storageFileId: 'manual-purge-file', storagePath: 'synthetic/purge',
      attachmentId: 'manual-purge-claim', query, transaction: purgeTransaction,
      storage: {
        delete: async () => { throw new Error('UNEXPECTED_LEGACY_DELETE') },
        deleteByKey: async () => {
          providerAttempts += 1
          // The separate claim connection has committed before this provider barrier.
          assert.equal((await query(`SELECT blob_purge_claimed_at IS NOT NULL AS claimed,
            blob_purged_at IS NULL AS unconfirmed FROM multitable_attachments
            WHERE id='manual-purge-claim'`)).rows[0].claimed, true)
          await assert.rejects(admit(refusedDuringDelete), { message: 'RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE' })
          throw new Error('SYNTHETIC_PROVIDER_DELETE_FAILED')
        },
      },
    }
    await deleteAttachmentBinary(purgeInput)
    assert.equal(providerAttempts, 1)
    assert.equal(await generationCount(), beforePurgeAdmission)
    assert.equal(await transaction(() => manualRequests.readRecoveryArchiveManualRequest(query, refusedDuringDelete)), null)
    assert.deepEqual((await query(`SELECT blob_purge_claimed_at IS NOT NULL AS claimed,
      blob_purged_at IS NULL AS unconfirmed FROM multitable_attachments
      WHERE id='manual-purge-claim'`)).rows, [{ claimed: true, unconfirmed: true }])
    await deleteAttachmentBinary({ ...purgeInput, storage: { ...purgeInput.storage,
      deleteByKey: async () => { providerAttempts += 1 } } })
    assert.equal(providerAttempts, 2)
    assert.equal((await query(`SELECT blob_purged_at IS NOT NULL AS purged FROM multitable_attachments
      WHERE id='manual-purge-claim'`)).rows[0].purged, true)
    await purgeMigration.up(db)
    await assert.rejects(purgeMigration.down(db), { message: 'ATTACHMENT_PURGE_CLAIM_DOWN_IN_USE' })
    console.log('PASS: pin-first refuses direct physical delete; separate-connection purge-first blocks admission; provider failure retains claim without purge stamp; retry confirms purge; nonempty rollback refused')
  } finally {
    await purgeClient.end()
    if (oldArchiveFlag === undefined) delete process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED
    else process.env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED = oldArchiveFlag
    if (oldFenceFlag === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    else process.env.MULTITABLE_ENABLE_WRITER_FENCE = oldFenceFlag
  }
  const purgedRequest = { ...admissionRequest, requestId: randomUUID() }
  const beforePurged = await generationCount()
  await query(`UPDATE multitable_attachments SET blob_purged_at=now() WHERE id='manual-deleted-attachment'`)
  await assert.rejects(admit(purgedRequest), { message: 'RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE' })
  assert.equal(await generationCount(), beforePurged)
  assert.equal(await transaction(() => manualRequests.readRecoveryArchiveManualRequest(query, purgedRequest)), null)
  assert.equal((await query(`SELECT count(*)::int AS n FROM meta_recovery_archive_attachment_refs
    WHERE attachment_id IN ('manual-live-attachment','manual-deleted-attachment')`)).rows[0].n, 2)
  console.log('PASS: physically purged in-scope attachment refuses fresh admission with zero generation/request/pin side effects')
  const { LocalStorageProvider } = require('../src/services/StorageService.ts') as typeof import('../src/services/StorageService')
  const sourceStorage = new LocalStorageProvider(join(root, 'attachment-source'))
  const syntheticAttachments = (await query(`SELECT id FROM multitable_attachments WHERE sheet_id='no-genesis' ORDER BY id`)).rows
  for (const row of syntheticAttachments) {
    const bytes = Buffer.from(`synthetic-${row.id}`)
    const file = await sourceStorage.uploadContentAddressed(bytes, { filename: 'source.bin', contentType: 'application/octet-stream' })
    await query(`UPDATE multitable_attachments SET storage_path=$2,size=$3,storage_provider='local',
      blob_purged_at=NULL,blob_purge_claimed_at=NULL WHERE id=$1`, [row.id, file.path, bytes.length])
  }
  let attachmentTransaction = false
  const attachmentReadTransaction: Parameters<typeof manualAdmission.bindRecoveryArchiveManualAttachmentRead>[0] =
    (work) => transaction(async () => {
      attachmentTransaction = true
      try { return await work(query) } finally { attachmentTransaction = false }
    })
  const newAttachmentSource = async () => {
    const result = await admit({ ...admissionRequest, requestId: randomUUID() })
    assert.ok(result.source)
    return result
  }
  const verifiedSource = await newAttachmentSource()
  let reads = 0
  const readAttachments = manualAdmission.bindRecoveryArchiveManualAttachmentRead(attachmentReadTransaction,
    async () => true, async (key) => {
      assert.equal(attachmentTransaction, false, 'SOURCE_FILE_IO_MUST_BE_OUTSIDE_TRANSACTION')
      reads += 1
      return sourceStorage.readContentAddressed(key)
    })
  const verifiedAttachments = await readAttachments(verifiedSource.source!)
  assert.equal(reads, syntheticAttachments.length)
  for (const attachment of verifiedAttachments) {
    assert.deepEqual(attachment.plaintext, Buffer.from(`synthetic-${attachment.attachmentId}`))
    const pin = (await pins(verifiedSource.generationId)).find((row) => row.attachment_id === attachment.attachmentId)
    assert.equal(pin.availability, 'available')
    assert.equal(pin.content_sha256, attachment.plaintextSha256)
    assert.equal(pin.immutable_version, attachment.sourceVersion)
    assert.equal(pin.content_size_bytes, String(attachment.sizeBytes))
    attachment.plaintext.fill(0)
  }
  const deniedRead = manualAdmission.bindRecoveryArchiveManualAttachmentRead(attachmentReadTransaction,
    async () => false, async () => { throw new Error('UNAUTHORIZED_SOURCE_IO') })
  await assert.rejects(deniedRead(verifiedSource.source!), { message: 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' })
  for (const failure of ['digest', 'version', 'size', 'revocation', 'source-change', 'lease'] as const) {
    const attempt = failure === 'lease'
      ? await createRecoveryArchiveManualAdmission(uploadInput.transaction, { ...admissionPolicy, leaseSeconds: 1 })(
        { ...admissionRequest, requestId: randomUUID() }) : await newAttachmentSource()
    let allowed = true
    const read = manualAdmission.bindRecoveryArchiveManualAttachmentRead(attachmentReadTransaction,
      async () => allowed, async (key) => {
        const result = await sourceStorage.readContentAddressed(key)
        if (failure === 'digest') result.bytes[0] ^= 1
        if (failure === 'version') result.immutableVersion = 'sha256:' + '0'.repeat(64)
        if (failure === 'size') result.sizeBytes += 1
        if (failure === 'revocation') allowed = false
        if (failure === 'lease') await query('SELECT pg_sleep(1.1)')
        if (failure === 'source-change') await query(`UPDATE multitable_attachments SET size=size+1 WHERE storage_path=$1`, [key])
        return result
      })
    try {
      await assert.rejects(read(attempt.source!), { message: failure === 'revocation'
        ? 'RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE' : failure === 'source-change'
          ? 'RECOVERY_ARCHIVE_MANUAL_SOURCE_CHANGED' : failure === 'lease'
            ? 'RECOVERY_ARCHIVE_PREPARED_CAPTURE_OWNER_UNAVAILABLE' : 'RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_CHANGED' })
      assert.ok((await pins(attempt.generationId)).every((row) => row.availability === 'mutable'))
    } finally {
      if (failure === 'source-change') for (const row of syntheticAttachments) {
        await query('UPDATE multitable_attachments SET size=$2 WHERE id=$1', [row.id, Buffer.byteLength(`synthetic-${row.id}`)])
      }
    }
  }
  const rollbackSource = await newAttachmentSource()
  let transitions = 0
  const failSecondTransition = manualAdmission.bindRecoveryArchiveManualAttachmentRead(
    (work) => transaction(() => work(async (text, params) => {
      if (text.includes('UPDATE public.meta_recovery_archive_attachment_refs source_pin') && ++transitions === 2) {
        throw new Error('SYNTHETIC_PRIVATE_TRANSITION_FAILURE')
      }
      return query(text, params)
    })), async () => true, (key) => sourceStorage.readContentAddressed(key))
  await assert.rejects(failSecondTransition(rollbackSource.source!), { message: 'RECOVERY_ARCHIVE_SOURCE_PIN_VERIFICATION_REFUSED' })
  assert.equal(transitions, 2)
  assert.ok((await pins(rollbackSource.generationId)).every((row) => row.availability === 'mutable'))
  console.log('PASS: real local attachment reads outside transactions atomically verify source pins; digest/version/size/revocation/source movement and second-pin failure refuse without partial available pins')
  const attachmentCapture = await continuation()
  const attachmentKey = randomBytes(32)
  const attachmentCustody = { ...custody,
    async produceGenerationDek() { return { dek: Buffer.from(attachmentKey), wrappedDekId: 'synthetic-attachment-wrapped', wrappedDek: randomBytes(64) } },
    async macManifestRoot({ preimage }: { preimage: Uint8Array }) { return createHmac('sha256', attachmentKey).update(preimage).digest() },
    async verifyManifestRootMac({ preimage, mac }: { preimage: Uint8Array; mac: Uint8Array }) {
      return createHmac('sha256', attachmentKey).update(preimage).digest().equals(Buffer.from(mac))
    },
  }
  const attachmentContinuationBindings = require('../src/multitable/recovery-archive-manual-continuation.ts') as typeof import('../src/multitable/recovery-archive-manual-continuation')
  const attachmentStores = require('../src/multitable/recovery-archive-object-store.ts') as typeof import('../src/multitable/recovery-archive-object-store')
  const attachmentProvider = attachmentStores.createLocalRecoveryArchiveObjectStoreProvider({ environment: 'test', basePath: join(root, 'full-attachment-capture') })
  const attachmentShared = { ...attachmentCapture, provider: attachmentProvider }
  let captureSourceReads = 0
  const withAttachments = attachmentContinuationBindings.bindRecoveryArchiveManualContinuation(uploadInput.transaction,
    async () => true, async (key) => { captureSourceReads++; return sourceStorage.readContentAddressed(key) })
  const persistAttachment = attachmentContinuationBindings.bindRecoveryArchiveManualAttachmentUpload(uploadInput.transaction, async () => true, attachmentShared)
  const attachmentCaptureInput = { ...attachmentCapture,
    capture: async (source: Parameters<typeof capture>[0]) => ({ ...await capture(source), binding: attachmentCapture.binding,
      keyCustody: attachmentCustody,
      attachments: [{ attachmentId: 'UNTRUSTED', sourceVersion: 'UNTRUSTED', plaintext: Buffer.from('UNTRUSTED'), nonce: randomBytes(12) }] }),
    upload: attachmentContinuationBindings.bindRecoveryArchiveManualObjectUpload(uploadInput.transaction, async () => true, attachmentShared),
    uploadAttachment: async (...args: Parameters<typeof persistAttachment>) => {
      await persistAttachment(...args)
      throw new Error('SYNTHETIC_ATTACHMENT_CAPTURE_INTERRUPTION')
    },
  }
  try {
    await assert.rejects(withAttachments(attachmentCaptureInput), { message: 'SYNTHETIC_ATTACHMENT_CAPTURE_INTERRUPTION' })
    const encryptedCapture = await transaction(() => prepared.readRecoveryArchivePreparedCapture(query, attachmentCapture.owner))
    assert.ok(encryptedCapture)
    const sealedCapture = preparedUpload.decodeRecoveryArchivePreparedEnvelope(encryptedCapture)
    assert.ok(sealedCapture.manifestEnvelope)
    assert.equal(sealedCapture.attachments!.length, syntheticAttachments.length)
    assert.equal(captureSourceReads, syntheticAttachments.length)
    const indexSection = sealedCapture.sections.find((section) => section.sectionName === 'attachments_index')!
    const indexRows = JSON.parse(Buffer.from(archiveCrypto.openRecoveryArchiveSection({ binding: { ...sealedCapture.binding,
      sectionName: 'attachments_index', plaintextSha256: indexSection.plaintextSha256 }, dek: attachmentKey,
      nonce: indexSection.nonce, ciphertext: indexSection.ciphertext, authTag: indexSection.authTag })).toString('utf8'))
    assert.deepEqual(indexRows.map((row: { payload: { attachment_id: string } }) => row.payload.attachment_id).sort(), syntheticAttachments.map((row) => row.id).sort())
    assert.ok(indexRows.some((row: { payload: { deleted: boolean } }) => row.payload.deleted))
    const nonceRows = (await query('SELECT section_name FROM meta_recovery_archive_nonce_reservations WHERE generation_id=$1', [attachmentCapture.owner.generationId])).rows
    assert.equal(nonceRows.length, 10 + syntheticAttachments.length)
    assert.deepEqual(nonceRows.filter((row) => row.section_name.startsWith('attachment:')).map((row) => row.section_name).sort(),
      syntheticAttachments.map((row) => attachmentCrypto.recoveryArchiveAttachmentNonceIdentity(row.id)).sort())
    await withAttachments({ ...attachmentCaptureInput, source: null,
      capture: async () => { throw new Error('SYNTHETIC_ATTACHMENT_RECAPTURE_FORBIDDEN') }, uploadAttachment: persistAttachment })
    assert.equal(captureSourceReads, syntheticAttachments.length)
    assert.deepEqual(await transaction(() => prepared.readRecoveryArchivePreparedCapture(query, attachmentCapture.owner)), encryptedCapture)
    assert.equal((await query('SELECT count(*)::int AS n FROM meta_recovery_archive_objects WHERE generation_id=$1', [attachmentCapture.owner.generationId])).rows[0].n, 10 + syntheticAttachments.length)
    const finalizeAttachments = require('../src/multitable/recovery-archive-manual-finalization.ts') as typeof import('../src/multitable/recovery-archive-manual-finalization')
    const finalizer = finalizeAttachments.bindRecoveryArchiveManualFinalization(uploadInput.transaction, async () => true)
    const finalizationInput = { ...attachmentCapture, key: { keyId: admissionPolicy.keyId, expectedRowVersion: admissionPolicy.keyRowVersion }, keyCustody: attachmentCustody }
    await assert.rejects(finalizer(finalizationInput), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    assert.ok((await pins(attachmentCapture.owner.generationId)).every((row) => row.reference_class === 'source'))
    await attachmentContinuationBindings.bindRecoveryArchiveManualManifestUpload(uploadInput.transaction, async () => true, attachmentShared)()
    const movedAttachmentId = syntheticAttachments[0].id
    const originalPath = (await query('SELECT storage_path FROM multitable_attachments WHERE id=$1', [movedAttachmentId])).rows[0].storage_path
    try {
      await query('UPDATE multitable_attachments SET storage_path=$2 WHERE id=$1', [movedAttachmentId, `${randomUUID()}/sha256-${'0'.repeat(64)}`])
      await assert.rejects(finalizer(finalizationInput), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    } finally { await query('UPDATE multitable_attachments SET storage_path=$2 WHERE id=$1', [movedAttachmentId, originalPath]) }
    let sourceReleases = 0
    const failingFinalize = finalizeAttachments.bindRecoveryArchiveManualFinalization(
      (work) => transaction(() => work(async (text, params) => {
        if (text.includes('DELETE FROM meta_recovery_archive_attachment_refs') && ++sourceReleases === 2) {
          throw new Error('SYNTHETIC_PRIVATE_PUBLICATION_FAILURE')
        }
        return query(text, params)
      })), async () => true)
    await assert.rejects(failingFinalize(finalizationInput), { message: 'RECOVERY_ARCHIVE_MANUAL_FINALIZATION_REFUSED' })
    assert.equal(sourceReleases, 2)
    assert.ok((await pins(attachmentCapture.owner.generationId)).every((row) => row.reference_class === 'source'))
    assert.ok((await query('SELECT state FROM meta_recovery_archive_objects WHERE generation_id=$1', [attachmentCapture.owner.generationId])).rows.every((row) => row.state === 'uploaded'))
    await finalizer(finalizationInput)
    assert.deepEqual((await query('SELECT state,build_status,coverage_status FROM meta_recovery_archives WHERE generation_id=$1', [attachmentCapture.owner.generationId])).rows,
      [{ state: 'verified', build_status: 'finalized', coverage_status: 'complete' }])
    const archiveReferences = await pins(attachmentCapture.owner.generationId)
    assert.equal(archiveReferences.length, syntheticAttachments.length)
    assert.ok(archiveReferences.every((row) => row.reference_class === 'archive_object' && row.reference_state === 'verified' && row.availability === 'available'))
    const finalObjects = (await query('SELECT state,attachment_id,provider_version FROM meta_recovery_archive_objects WHERE generation_id=$1', [attachmentCapture.owner.generationId])).rows
    assert.equal(finalObjects.length, 11 + syntheticAttachments.length)
    assert.ok(finalObjects.every((row) => row.state === 'verified'))
    for (const ref of archiveReferences) assert.equal(ref.immutable_version, finalObjects.find((row) => row.attachment_id === ref.attachment_id).provider_version)
    console.log('PASS: live/deleted source files form authenticated attachment index and exact 10+N nonce reservations; caller attachment substitution ignored; durable interrupted capture resumes without reread/reseal')
    console.log('PASS: missing manifest refuses publication and retains source pins; complete attachment roster atomically verifies catalog/receipts/archive refs and releases only its own source pins')
  } finally { attachmentKey.fill(0) }
  console.log('PASS: bootstrap unchanged; two checkpoint generations and exact retries; changed content, missing genesis, ordinary forgery and extra payload refused')
  console.log('PASS: two-client retry waits at generation lock; one revision set; expired lease/expiry and mismatched fence reject with zero revisions')
  console.log('MUTATION: removing dedicated seal guard admits ordinary forgery; transaction rolled back, canonical function restored')
} finally {
  await db?.destroy()
  await client?.end()
  if (created) {
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n, 0)
    await admin.query(`DROP DATABASE "${database}"`)
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1', [database])).rows[0].n, 0)
    console.log('CLEAN: owned database and connections = 0')
  }
  await admin.end()
  await rm(root, { recursive: true })
}
