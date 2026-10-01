import { createHash, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import * as migration from '../../src/db/migrations/zzzz20261001140000_add_archive_expired_object_claim'
import { claimRecoveryArchiveObjectDeletion, takeOverRecoveryArchiveObjectDeletion,
  type RecoveryArchiveObjectClaimSnapshot } from '../../src/multitable/recovery-archive-object-claims'
import { placeRecoveryArchiveLegalHold } from '../../src/multitable/recovery-archive-legal-holds'
import { prepareRecoveryArchiveObjectDeletion, requestRecoveryArchiveObjectDeletion,
  type RecoveryArchiveObjectDeletionInput } from '../../src/multitable/recovery-archive-object-deletions'

const run = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const suite = run ? describe : describe.skip
test('sentinel: deletion admission real-DB step must supply DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) throw new Error('deletion_admission_database_missing')
})
const prefix = `tm_claim_${randomUUID().replaceAll('-', '')}`
const role = `${prefix}_role`
const attackSchema = `${prefix}_attack`
const admissionSignature = 'public.meta_recovery_archive_object_deletion_command(uuid, uuid, text, uuid, text, text, text, text, uuid, bigint, text, text, bigint)'
const key = `${prefix}_key`
const workspace = `${prefix}_workspace`
const base = `${prefix}_base`
const sheet = `${prefix}_sheet`
const checkpoint = `${prefix}_checkpoint`
const anchor = randomUUID()
const seq = '9007199254753001'
const target = randomUUID()
const replacement = randomUUID()
const sections = ['schema', 'records', 'links', 'field_value_tombstones', 'link_tombstones',
  'auto_number', 'attachments_index', 'permission_evidence', 'views_config', 'coverage_index']
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const objectId = hash('synthetic-section-records')
const storeId = randomUUID()
const commandSignature = 'public.meta_recovery_archive_object_claim_command(uuid, uuid, text, uuid, text, text, text, text, uuid, bigint, text, text, bigint, text, text, bigint, timestamptz)'
let pool: Pool
let db: Kysely<unknown>

function input(): RecoveryArchiveObjectDeletionInput {
  return { id: randomUUID(), generationId: target, objectId, ownerRequestId: randomUUID(),
    providerOperationKey: hash(randomUUID()), workspaceId: workspace, baseId: base, sheetId: sheet,
    anchorOperationId: anchor, anchorSeq: seq, checkpointId: checkpoint }
}
const queryOf = (client: PoolClient) => (text: string, values?: unknown[]) => client.query(text, values)
async function rollback(work: (client: PoolClient) => Promise<void>) {
  const client = await pool.connect()
  try { await client.query('BEGIN'); await work(client) } finally { await client.query('ROLLBACK'); client.release() }
}
async function refused(client: PoolClient, work: () => Promise<unknown>, code: string) {
  await client.query('SAVEPOINT refusal')
  let error: unknown
  try { await work() } catch (cause) { error = cause }
  await client.query('ROLLBACK TO SAVEPOINT refusal')
  expect(error).toMatchObject({ message: code })
  expect(String(error)).not.toContain(prefix)
  return error
}
async function fixtureMutation(client: PoolClient, table: string, text: string, values: unknown[] = []) {
  await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
  await client.query(text, values)
  await client.query('SET CONSTRAINTS ALL IMMEDIATE')
  await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
}
async function state(client: PoolClient, id: string) {
  const r = await client.query(`SELECT state, row_version::text AS row_version,
    provider_operation_key, provider_receipt_sha256, worker_fence::text AS worker_fence
    FROM meta_recovery_archive_object_deletions WHERE id = $1`, [id])
  return r.rows
}
async function waitBlocked(w: number, b: number) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const r = await pool.query('SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked', [w, b])
    if (r.rows[0].blocked === true) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('deletion_admission_lock_wait_missing')
}


async function ready(client: PoolClient, value = input()) {
  await requestRecoveryArchiveObjectDeletion(queryOf(client), value)
  await prepareRecoveryArchiveObjectDeletion(queryOf(client), { ...value, expectedRowVersion: '1' })
  return { ...value, expectedRowVersion: '2', workerOwnerId: `${prefix}_worker` }
}
async function expired(client: PoolClient, claim: RecoveryArchiveObjectClaimSnapshot) {
  const lease = '2000-01-01T00:00:00.000Z'
  await fixtureMutation(client, 'meta_recovery_archive_object_deletions',
    'UPDATE meta_recovery_archive_object_deletions SET lease_until=$2 WHERE id=$1', [claim.id, lease])
  return { ...claim, expectedRowVersion: claim.rowVersion, previousWorkerOwnerId: claim.workerOwnerId,
    previousWorkerFence: claim.workerFence, previousLeaseUntil: lease, workerOwnerId: `${prefix}_successor` }
}
async function removeIntent(client: PoolClient, id: string) {
  await fixtureMutation(client, 'meta_recovery_archive_object_deletions', 'DELETE FROM meta_recovery_archive_object_deletions WHERE id=$1', [id])
}

suite('expired archive object claim and takeover (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOINHERIT`)
    await pool.query(`CREATE SCHEMA ${attackSchema} AUTHORIZATION ${role}`)
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
    await pool.query(`GRANT EXECUTE ON FUNCTION ${commandSignature}, ${admissionSignature} TO ${role}`)
    await pool.query('INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)', [key])
    await pool.query('INSERT INTO meta_bases (id, name, workspace_id) VALUES ($1, $2, $3)', [base, 'synthetic', workspace])
    await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [sheet, base, 'synthetic'])
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action,
        source, changed_field_ids, patch, snapshot, seq, operation_id)
        VALUES ($1, $2, $3, 1, 'create', 'rest', ARRAY[]::text[], '{}', '{}', $4, $5)`,
      [randomUUID(), sheet, `${prefix}_record`, seq, anchor])
      await client.query(`INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
        VALUES ($1, $2, $3, 1)`, [sheet, anchor, seq])
      await client.query('COMMIT')
      await client.query('BEGIN')
      await client.query(`INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
        VALUES ($1, $2, 'active', $3)`, [checkpoint, sheet, seq])
      await client.query('ALTER TABLE meta_recovery_archives DISABLE TRIGGER USER')
      await client.query('ALTER TABLE meta_recovery_archive_objects DISABLE TRIGGER USER')
      await client.query('ALTER TABLE meta_recovery_archive_staging_objects DISABLE TRIGGER USER')
      await client.query('ALTER TABLE meta_recovery_archive_abandoned_bindings DISABLE TRIGGER USER')
      for (const generation of [target, replacement]) {
        await client.query(`INSERT INTO meta_recovery_archives (generation_id, workspace_id, base_id, sheet_id,
          anchor_operation_id, anchor_seq, checkpoint_id, state, build_status, coverage_status,
          source_vector_hash, key_id, root_hash, coverage_section_hash, coverage_row_count, manifest_mac,
          owner_kind, owner_id, owner_fence, lease_expires_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalized', 'complete', $9, $10, $11, $12, 0,
                  $13, 'archive_builder', $14, 1, '2099-01-01', $15)`,
        [generation, workspace, base, sheet, anchor, seq, checkpoint,
          generation === target ? 'expired' : 'verified', hash('source'), key, hash('root'), hash('coverage'),
          Buffer.from('synthetic_mac'), `${prefix}_owner`, generation === target ? '2000-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z'])
        for (const section of [...sections, null]) {
          await client.query(`INSERT INTO meta_recovery_archive_objects (generation_id, object_id, object_class,
            section_name, key_id, provider_version, plaintext_sha256, ciphertext_sha256, size_bytes,
            idempotency_key, put_receipt_sha256, head_receipt_sha256, owner_kind, owner_id, owner_fence,
            state, verified_at) VALUES ($1, $2, $3, $4, $5, 'synthetic', $6, $7, 0, $8, $9, $10,
              'archive_builder', $11, 1, 'verified', clock_timestamp())`,
          [generation, section ? hash(`synthetic-section-${section}`) : hash('synthetic-manifest'),
            section ? 'section' : 'manifest', section, key, hash('plain'), hash('cipher'),
            hash(`put-${generation}-${section}`), hash('put'), hash('head'), `${prefix}_owner`])
          // Privileged synthetic baseline only: finalized manual inventory remains sealed.
          if (generation === target) {
            const stagingId = randomUUID()
            const logicalId = section ? hash(`synthetic-section-${section}`) : hash('synthetic-manifest')
            await client.query(`INSERT INTO meta_recovery_archive_staging_objects
              (generation_id,staging_object_id,object_class,attachment_id,key_id,object_state)
              VALUES ($1,$2,$3,NULL,$4,'sealed')`, [generation, stagingId, section ? 'section' : 'manifest', key])
            await client.query(`INSERT INTO meta_recovery_archive_abandoned_bindings
              (generation_id,staging_object_id,object_id,provider_version,ciphertext_sha256,size_bytes,expires_at,
                operation_id,store_id,owner_kind,owner_id,owner_fence)
              VALUES ($1,$2,$3,'synthetic',$4,0,'2000-01-01T00:00:00.000Z',$5,$6,'archive_builder',$7,1)`,
            [generation, stagingId, logicalId, hash('cipher'), randomUUID(), storeId, `${prefix}_owner`])
          }
        }
      }
      await client.query('ALTER TABLE meta_recovery_archive_staging_objects ENABLE TRIGGER USER')
      await client.query('ALTER TABLE meta_recovery_archive_abandoned_bindings ENABLE TRIGGER USER')
      await client.query('ALTER TABLE meta_recovery_archive_objects ENABLE TRIGGER USER')
      await client.query('ALTER TABLE meta_recovery_archives ENABLE TRIGGER USER')
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  afterAll(async () => {
    try {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const table of ['meta_recovery_archive_object_deletions', 'meta_recovery_archive_legal_holds',
          'meta_recovery_archive_objects', 'meta_recovery_archive_abandoned_bindings',
          'meta_recovery_archive_staging_objects', 'meta_recovery_archives']) {
          await fixtureMutation(client, table, `DELETE FROM ${table} WHERE generation_id = ANY($1::uuid[])`, [[target, replacement]])
        }
        await client.query('SELECT meta_record_history_operations_prune($1, $2)', [sheet, anchor])
        await client.query('DELETE FROM meta_history_trust_checkpoints WHERE id = $1', [checkpoint])
        await client.query('DELETE FROM meta_sheets WHERE id = $1', [sheet])
        await client.query('DELETE FROM meta_bases WHERE id = $1', [base])
        await fixtureMutation(client, 'meta_recovery_archive_keys', 'DELETE FROM meta_recovery_archive_keys WHERE key_id = $1', [key])
        await client.query('COMMIT')
      } finally { await client.query('ROLLBACK'); client.release() }
      await pool.query(`DROP SCHEMA ${attackSchema} CASCADE`)
      await pool.query(`DROP OWNED BY ${role}`)
      await pool.query(`DROP ROLE ${role}`)
      expect((await pool.query('SELECT count(*)::int AS count FROM pg_roles WHERE rolname=$1', [role])).rows).toEqual([{ count: 0 }])
    } finally { await db.destroy() }
  })

  test('restricted definer and split guards have the exact closed execution posture', async () => {
    const authority = await pool.query(`SELECT prosecdef,proconfig,
      coalesce((SELECT bool_or(grantee=0 AND privilege_type='EXECUTE')
        FROM aclexplode(coalesce(proacl,acldefault('f',proowner)))),false) AS public_execute
      FROM pg_proc WHERE oid=$1::regprocedure`, [commandSignature])
    expect(authority.rows).toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], public_execute: false }])
    const triggers = await pool.query(`SELECT tgname,tgtype,pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid='meta_recovery_archive_object_deletions'::regclass AND NOT tgisinternal ORDER BY tgname`)
    expect(triggers.rows.map(r => [r.tgname, r.tgtype])).toEqual([
      ['trg_archive_object_claim_guard', 23], ['trg_archive_object_deletion_admission_update_guard', 19],
      ['trg_archive_object_deletion_guard', 15], ['trg_archive_object_deletion_truncate_guard', 34],
    ])
    expect(triggers.rows[1].definition).toContain("WHEN ((new.state IS DISTINCT FROM 'deleting'::text))")
  })

  test('claim freezes exact durable store/version/digest/staging/key binding and a DB-derived lease', async () => rollback(async client => {
    const value = await ready(client)
    const before = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date
    const claim = await claimRecoveryArchiveObjectDeletion(queryOf(client), value)
    const mapping = (await client.query('SELECT staging_object_id::text FROM meta_recovery_archive_abandoned_bindings WHERE generation_id=$1 AND object_id=$2', [target, objectId])).rows[0]
    const { expectedRowVersion: _version, workerOwnerId: _worker, ...identity } = value
    expect(claim).toEqual({ ...identity, state: 'deleting', rowVersion: '3', workerOwnerId: value.workerOwnerId,
      workerFence: '1', attemptCount: '1', leaseUntil: claim.leaseUntil, storeId,
      stagingObjectId: mapping.staging_object_id, keyId: key, providerVersion: 'synthetic', ciphertextSha256: hash('cipher'),
      sizeBytes: '0', objectExpiresAt: '2000-01-01T00:00:00.000Z' })
    expect(new Date(claim.leaseUntil).getTime() - before.getTime()).toBeGreaterThan(59000)
    expect(new Date(claim.leaseUntil).getTime() - before.getTime()).toBeLessThanOrEqual(61000)
    expect((await client.query('SELECT provider_receipt_sha256 FROM meta_recovery_archive_object_deletions WHERE id=$1', [value.id])).rows).toEqual([{ provider_receipt_sha256: null }])
    expect((await client.query('SELECT count(*)::int AS count FROM meta_recovery_archive_objects WHERE generation_id=$1', [target])).rows).toEqual([{ count: 11 }])
    expect((await client.query('SELECT state FROM meta_recovery_archive_keys WHERE key_id=$1', [key])).rows).toEqual([{ state: 'active' }])
  }))

  test('expired exact lease takeover increments fence/attempt and keeps all operation/provider bindings', async () => rollback(async client => {
    const claim = await claimRecoveryArchiveObjectDeletion(queryOf(client), await ready(client))
    const value = await expired(client, claim)
    const successor = await takeOverRecoveryArchiveObjectDeletion(queryOf(client), value)
    expect(successor).toEqual({ ...claim, rowVersion: '4', workerOwnerId: value.workerOwnerId,
      workerFence: '2', attemptCount: '2', leaseUntil: successor.leaseUntil })
    const roundTrip = (await client.query('SELECT lease_until FROM meta_recovery_archive_object_deletions WHERE id=$1', [claim.id])).rows[0].lease_until as Date
    expect(roundTrip.toISOString()).toBe(successor.leaseUntil)
  }))

  test('active lease refuses takeover before any mutation', async () => rollback(async client => {
    const claim = await claimRecoveryArchiveObjectDeletion(queryOf(client), await ready(client))
    await refused(client, () => takeOverRecoveryArchiveObjectDeletion(queryOf(client), { ...claim,
      expectedRowVersion: claim.rowVersion, workerOwnerId: `${prefix}_successor`, previousWorkerOwnerId: claim.workerOwnerId,
      previousWorkerFence: claim.workerFence, previousLeaseUntil: claim.leaseUntil }), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
    expect((await state(client, claim.id))[0]).toMatchObject({ state: 'deleting', row_version: '3', worker_fence: '1' })
  }))

  test.each(['previousWorkerOwnerId', 'previousWorkerFence', 'previousLeaseUntil', 'expectedRowVersion', 'providerOperationKey'] as const)
  ('takeover exact stale %s refuses', async field => rollback(async client => {
    const claim = await claimRecoveryArchiveObjectDeletion(queryOf(client), await ready(client))
    const value = await expired(client, claim)
    const changed = { ...value, [field]: field === 'previousWorkerOwnerId' ? 'different_worker'
      : field === 'previousLeaseUntil' ? '2000-01-02T00:00:00.000Z'
        : field === 'providerOperationKey' ? hash('different_operation') : '9' }
    await refused(client, () => takeOverRecoveryArchiveObjectDeletion(queryOf(client), changed), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
  }))

  test.each(['provider_version', 'ciphertext_sha256', 'size_bytes', 'expires_at'])('drifted durable %s refuses first claim', async field => rollback(async client => {
    const value = await ready(client)
    const changed = field === 'provider_version' ? 'different' : field === 'ciphertext_sha256' ? hash('different')
      : field === 'size_bytes' ? '1' : '2000-01-02'
    await fixtureMutation(client, 'meta_recovery_archive_abandoned_bindings',
      `UPDATE meta_recovery_archive_abandoned_bindings SET ${field}=$3 WHERE generation_id=$1 AND object_id=$2`, [target, objectId, changed])
    await refused(client, () => claimRecoveryArchiveObjectDeletion(queryOf(client), value), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
  }))

  test('missing legacy namespace binding refuses; sealed staging/key/class correspondence is required', async () => rollback(async client => {
    const value = await ready(client)
    await client.query('SAVEPOINT legacy')
    await fixtureMutation(client, 'meta_recovery_archive_abandoned_bindings', 'DELETE FROM meta_recovery_archive_abandoned_bindings WHERE generation_id=$1 AND object_id=$2', [target, objectId])
    await refused(client, () => claimRecoveryArchiveObjectDeletion(queryOf(client), value), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
    await client.query('ROLLBACK TO SAVEPOINT legacy')
    await fixtureMutation(client, 'meta_recovery_archive_staging_objects', `UPDATE meta_recovery_archive_staging_objects SET object_state='pending'
      WHERE staging_object_id=(SELECT staging_object_id FROM meta_recovery_archive_abandoned_bindings WHERE generation_id=$1 AND object_id=$2)`, [target, objectId])
    await refused(client, () => claimRecoveryArchiveObjectDeletion(queryOf(client), value), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
  }))

  test('frozen store namespace cannot change during takeover', async () => rollback(async client => {
    const claim = await claimRecoveryArchiveObjectDeletion(queryOf(client), await ready(client))
    const value = await expired(client, claim)
    await fixtureMutation(client, 'meta_recovery_archive_abandoned_bindings', 'UPDATE meta_recovery_archive_abandoned_bindings SET store_id=$3 WHERE generation_id=$1 AND object_id=$2', [target, objectId, randomUUID()])
    await refused(client, () => takeOverRecoveryArchiveObjectDeletion(queryOf(client), value), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
  }))

  test.each(['key_id', 'object_class'])('staging %s mismatch refuses claim', async field => rollback(async client => {
    const value = await ready(client)
    await fixtureMutation(client, 'meta_recovery_archive_staging_objects', `UPDATE meta_recovery_archive_staging_objects
      SET ${field}=$3 WHERE staging_object_id=(SELECT staging_object_id FROM meta_recovery_archive_abandoned_bindings
        WHERE generation_id=$1 AND object_id=$2)`, [target, objectId, field === 'key_id' ? 'different_key' : 'manifest'])
    await refused(client, () => claimRecoveryArchiveObjectDeletion(queryOf(client), value), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
  }))

  test('claim repeats sole-cover refusal after READY; provider expiry preserves catalog millisecond mapping', async () => rollback(async client => {
    const value = await ready(client)
    await client.query('SAVEPOINT replacement')
    await fixtureMutation(client, 'meta_recovery_archives', "UPDATE meta_recovery_archives SET state='building',build_status='active',coverage_status='incomplete' WHERE generation_id=$1", [replacement])
    await refused(client, () => claimRecoveryArchiveObjectDeletion(queryOf(client), value), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
    await client.query('ROLLBACK TO SAVEPOINT replacement')
    await fixtureMutation(client, 'meta_recovery_archives', "UPDATE meta_recovery_archives SET expires_at='2000-01-01T00:00:00.000999Z' WHERE generation_id=$1", [target])
    expect(await claimRecoveryArchiveObjectDeletion(queryOf(client), value)).toMatchObject({ objectExpiresAt: '2000-01-01T00:00:00.000Z' })
  }))

  test('synthetic failed_retryable claim rechecks admission without adding an organic failure transition', async () => rollback(async client => {
    const value = await ready(client)
    await fixtureMutation(client, 'meta_recovery_archive_object_deletions', `UPDATE meta_recovery_archive_object_deletions
      SET state='failed_retryable',worker_fence=1,attempt_count=1 WHERE id=$1`, [value.id])
    const claim = await claimRecoveryArchiveObjectDeletion(queryOf(client), value)
    expect(claim).toMatchObject({ state: 'deleting', workerFence: '2', attemptCount: '2', rowVersion: '3' })
  }))

  test('RR command refuses without worker transition', async () => {
    const client = await pool.connect()
    const value = { ...input(), objectId: hash('synthetic-section-field_value_tombstones') }
    try {
      await client.query('BEGIN'); const prepared = await ready(client, value); await client.query('COMMIT')
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await client.query('SELECT count(*) FROM meta_recovery_archive_legal_holds')
      await refused(client, () => claimRecoveryArchiveObjectDeletion(queryOf(client), prepared), 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED')
    } finally {
      await client.query('ROLLBACK'); await client.query('BEGIN'); await removeIntent(client, value.id)
      await client.query('COMMIT'); client.release()
    }
  })

  test('unknown command refuses in SQL without a worker transition', async () => rollback(async client => {
    const value = await ready(client)
    await refused(client, () => client.query(`SELECT * FROM public.meta_recovery_archive_object_claim_command(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unknown',2,'synthetic_worker',NULL,NULL,NULL)`,
    [value.id, target, objectId, value.ownerRequestId, value.providerOperationKey, workspace, base, sheet, anchor, seq, checkpoint]), 'recovery_archive_object_claim_input_invalid')
  }))

  test('restricted role cannot raw DML, forge GUC/nested trigger, invoke guard or alter authority', async () => rollback(async client => {
    const value = await ready(client)
    await client.query(`SET LOCAL ROLE ${role}`)
    const privileges = await client.query(`SELECT current_user AS role, rolsuper,
      has_table_privilege(current_user,'meta_recovery_archive_object_deletions','INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER') AS mutation,
      pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='meta_recovery_archive_object_deletions'::regclass),'MEMBER') AS owner_member
      FROM pg_roles WHERE rolname=current_user`)
    expect(privileges.rows).toEqual([{ role, rolsuper: false, mutation: false, owner_member: false }])
    const denied = async (text: string, values: unknown[] = []) => {
      await client.query('SAVEPOINT denied'); let error: unknown
      try { await client.query(text, values) } catch (cause) { error = cause }
      await client.query('ROLLBACK TO SAVEPOINT denied'); expect(error).toMatchObject({ code: '42501' })
    }
    await client.query("SELECT set_config('metasheet.recovery_archive_object_claim_authorized','true',true)")
    await denied("UPDATE meta_recovery_archive_object_deletions SET state='deleting' WHERE id=$1", [value.id])
    await denied('SELECT 1 FROM meta_recovery_archive_object_deletions FOR UPDATE')
    await denied('SELECT public.meta_recovery_archive_object_claim_guard()')
    await denied(`ALTER FUNCTION ${commandSignature} SECURITY INVOKER`)
    await client.query(`CREATE TABLE ${attackSchema}.attack(id uuid)`)
    await client.query(`CREATE FUNCTION ${attackSchema}.forge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE public.meta_recovery_archive_object_deletions SET state='deleting' WHERE id=NEW.id; RETURN NEW; END $$`)
    await client.query(`CREATE TRIGGER forge BEFORE INSERT ON ${attackSchema}.attack FOR EACH ROW EXECUTE FUNCTION ${attackSchema}.forge()`)
    await denied(`INSERT INTO ${attackSchema}.attack VALUES($1)`, [value.id])
    expect(await claimRecoveryArchiveObjectDeletion(queryOf(client), value)).toMatchObject({ state: 'deleting', storeId })
  }))

  test('deleting invariant guard rejects operation/identity/receipt forgery even in privileged synthetic SQL', async () => rollback(async client => {
    const claim = await claimRecoveryArchiveObjectDeletion(queryOf(client), await ready(client))
    await expired(client, claim)
    for (const set of ["provider_operation_key=repeat('d',64)", 'owner_request_id=gen_random_uuid()',
      "provider_receipt_sha256=repeat('d',64)", "requested_at='2000-01-01'", 'row_version=row_version+2']) {
      await refused(client, () => client.query(`UPDATE meta_recovery_archive_object_deletions SET ${set},
        worker_fence=worker_fence+1,attempt_count=attempt_count+1,lease_until=date_trunc('milliseconds',clock_timestamp())+interval '60 seconds',
        ${set.startsWith('row_version=') ? "updated_at=clock_timestamp()" : 'row_version=row_version+1'} WHERE id=$1`, [claim.id]), 'recovery_archive_object_claim_transition_invalid')
    }
    await refused(client, () => client.query("UPDATE meta_recovery_archive_object_deletions SET state='deleted',provider_receipt_sha256=repeat('d',64),row_version=row_version+1 WHERE id=$1", [claim.id]), 'recovery_archive_object_deletion_worker_unavailable')
  }))

  test.each([true, false])('actual blocked hold versus deleting claim with hold first=%s has one winner', async holdFirst => {
    const first = await pool.connect(); const second = await pool.connect()
    const value = { ...input(), objectId: hash(`synthetic-section-${holdFirst ? 'schema' : 'links'}`) }
    let pending: Promise<{ ok: boolean }> | undefined
    try {
      await first.query('BEGIN'); const prepared = await ready(first, value); await first.query('COMMIT')
      await first.query('BEGIN'); await second.query('BEGIN')
      const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const hold = () => placeRecoveryArchiveLegalHold(queryOf(holdFirst ? first : second), { holdId: randomUUID(),
        workspaceId: workspace, baseId: base, sheetId: sheet, generationId: target, reasonCode: 'LEGAL_RACE', placedByActorId: `${prefix}_actor` })
      if (holdFirst) await hold()
      else await claimRecoveryArchiveObjectDeletion(queryOf(first), prepared)
      pending = (holdFirst ? claimRecoveryArchiveObjectDeletion(queryOf(second), prepared) : hold()).then(() => ({ ok: true }), () => ({ ok: false }))
      await waitBlocked(secondPid, firstPid); await first.query('COMMIT')
      expect((await pending).ok).toBe(false); await second.query('ROLLBACK')
      expect((await state(first, value.id))[0].state).toBe(holdFirst ? 'cancelled' : 'deleting')
      expect((await first.query("SELECT count(*)::int AS count FROM meta_recovery_archive_legal_holds WHERE generation_id=$1 AND state='active'", [target])).rows).toEqual([{ count: holdFirst ? 1 : 0 }])
      expect((await first.query('SELECT count(*)::int AS count FROM meta_recovery_archive_objects WHERE generation_id=$1', [target])).rows).toEqual([{ count: 11 }])
      await first.query('BEGIN'); await removeIntent(first, value.id)
      await fixtureMutation(first, 'meta_recovery_archive_legal_holds', 'DELETE FROM meta_recovery_archive_legal_holds WHERE generation_id=$1', [target]); await first.query('COMMIT')
    } finally { await first.query('ROLLBACK'); await second.query('ROLLBACK'); if (pending) await pending; first.release(); second.release() }
  })

  test('two workers contend on actual claim and only one fence commits', async () => {
    const first = await pool.connect(); const second = await pool.connect(); let pending: Promise<boolean> | undefined
    const value = { ...input(), objectId: hash('synthetic-section-auto_number') }
    try {
      await first.query('BEGIN'); const prepared = await ready(first, value); await first.query('COMMIT')
      await first.query('BEGIN'); await second.query('BEGIN')
      const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await claimRecoveryArchiveObjectDeletion(queryOf(first), prepared)
      pending = claimRecoveryArchiveObjectDeletion(queryOf(second), { ...prepared, workerOwnerId: 'other_worker' }).then(() => true, () => false)
      await waitBlocked(secondPid, firstPid); await first.query('COMMIT'); expect(await pending).toBe(false); await second.query('ROLLBACK')
      expect((await state(first, value.id))[0]).toMatchObject({ state: 'deleting', worker_fence: '1', row_version: '3' })
      await first.query('BEGIN'); await removeIntent(first, value.id); await first.query('COMMIT')
    } finally { await first.query('ROLLBACK'); await second.query('ROLLBACK'); if (pending) await pending; first.release(); second.release() }
  })

  test('claim takes key and durable staging before the intent tuple', async () => {
    const owner = await pool.connect(); const worker = await pool.connect(); const probe = await pool.connect()
    const value = { ...input(), objectId: hash('synthetic-section-coverage_index') }; let pending: Promise<unknown> | undefined
    try {
      await owner.query('BEGIN'); const prepared = await ready(owner, value); await owner.query('COMMIT')
      for (const held of ["SELECT 1 FROM meta_recovery_archive_keys WHERE key_id=$1 FOR UPDATE",
        'SELECT 1 FROM meta_recovery_archive_staging_objects WHERE staging_object_id=(SELECT staging_object_id FROM meta_recovery_archive_abandoned_bindings WHERE generation_id=$1 AND object_id=$2) FOR UPDATE']) {
        await owner.query('BEGIN'); await owner.query(held, held.includes('key_id') ? [key] : [target, value.objectId])
        await worker.query('BEGIN'); const wpid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        const opid = (await owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        pending = claimRecoveryArchiveObjectDeletion(queryOf(worker), prepared)
        await waitBlocked(wpid, opid); await probe.query('BEGIN')
        await probe.query('SELECT 1 FROM meta_recovery_archive_object_deletions WHERE id=$1 FOR UPDATE NOWAIT', [value.id]); await probe.query('ROLLBACK')
        await owner.query('ROLLBACK'); await pending; await worker.query('ROLLBACK')
      }
      await owner.query('BEGIN'); await removeIntent(owner, value.id); await owner.query('COMMIT')
    } finally { await owner.query('ROLLBACK'); await worker.query('ROLLBACK'); await probe.query('ROLLBACK'); if (pending) await pending.catch(() => {}); owner.release(); worker.release(); probe.release() }
  })

  test('empty rollback restores original trigger precisely and apply restores claim guard', async () => {
    await db.transaction().execute(async tx => {
      await migration.down(tx)
      const original = await sql<{ tgtype: number }>`SELECT tgtype FROM pg_trigger
        WHERE tgname='trg_archive_object_deletion_guard'`.execute(tx)
      expect(original.rows).toEqual([{ tgtype: 31 }])
      const absent = await sql<{ absent: boolean }>`SELECT
        to_regprocedure(${commandSignature}) IS NULL AND NOT EXISTS (
          SELECT 1 FROM pg_attribute WHERE attrelid='meta_recovery_archive_object_deletions'::regclass
            AND attname='store_id' AND NOT attisdropped) AS absent`.execute(tx)
      expect(absent.rows).toEqual([{ absent: true }])
      await migration.up(tx)
    })
    await pool.query(`GRANT EXECUTE ON FUNCTION ${commandSignature} TO ${role}`)
    expect((await pool.query(`SELECT tgtype FROM pg_trigger WHERE tgname='trg_archive_object_deletion_guard'`)).rows).toEqual([{ tgtype: 15 }])
  })

  test('any frozen claim history makes rollback refuse without changing authority', async () => {
    const client = await pool.connect()
    const value = { ...input(), objectId: hash('synthetic-section-views_config') }
    try {
      await client.query('BEGIN')
      await claimRecoveryArchiveObjectDeletion(queryOf(client), await ready(client, value))
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    let error: unknown
    try { await db.transaction().execute(migration.down) } catch (cause) { error = cause }
    expect(error).toMatchObject({ message: 'recovery_archive_object_claim_retained' })
    expect((await pool.query('SELECT count(*)::int AS count FROM pg_proc WHERE oid=$1::regprocedure', [commandSignature])).rows).toEqual([{ count: 1 }])
    // Synthetic retained terminal history: even clearing worker posture cannot erase its binding.
    const owner = await pool.connect()
    try {
      await owner.query('BEGIN')
      await fixtureMutation(owner, 'meta_recovery_archive_object_deletions', `UPDATE meta_recovery_archive_object_deletions
        SET state='cancelled',cancelled_at=clock_timestamp(),worker_owner_id=NULL,worker_fence=0,attempt_count=0,lease_until=NULL
        WHERE id=$1`, [value.id]); await owner.query('COMMIT')
    } finally { await owner.query('ROLLBACK'); owner.release() }
    error = undefined
    try { await db.transaction().execute(migration.down) } catch (cause) { error = cause }
    expect(error).toMatchObject({ message: 'recovery_archive_object_claim_retained' })
  })
})
