/** Synthetic full-schema checkpoint acceptance; never use a customer database. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import type { RecoveryArchiveSnapshotReservationPlan } from '../src/multitable/recovery-archive-section-bootstrap'

const require = createRequire(import.meta.url)
const preparedUpload = require('../src/multitable/recovery-archive-prepared-upload.ts') as typeof import('../src/multitable/recovery-archive-prepared-upload')
const archiveCrypto = require('../src/multitable/recovery-archive-crypto.ts') as typeof import('../src/multitable/recovery-archive-crypto')
const archiveContract = require('../src/multitable/recovery-archive-contract.ts') as typeof import('../src/multitable/recovery-archive-contract')
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
  ]
  for (const args of neighbors) {
    const run = spawnSync('pnpm', ['--filter', '@metasheet/core-backend', 'exec', ...args], {
      cwd: repo, env: { ...env, METASHEET_REAL_DB_TEST_STEP: '1' }, encoding: 'utf8',
      timeout: 240000, maxBuffer: 16 * 1024 * 1024,
    })
    console.log((run.stdout ?? '').slice(-4000))
    if (run.status !== 0) console.error((run.stderr ?? '').slice(-8000))
    assert.equal(run.status, 0, 'MIGRATION_NEIGHBOR_FAILED')
  }
  client = new Client({ ...connection, database })
  await client.connect()
  const query = (text: string, params?: unknown[]) => client!.query(text, params)
  db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ ...connection, database, max: 1 }) }) })
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
