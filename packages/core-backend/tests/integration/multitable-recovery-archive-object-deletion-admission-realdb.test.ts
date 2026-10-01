import { createHash, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import * as migration from '../../src/db/migrations/zzzz20261001130000_add_archive_expired_object_admission'
import { placeRecoveryArchiveLegalHold } from '../../src/multitable/recovery-archive-legal-holds'
import { prepareRecoveryArchiveObjectDeletion, requestRecoveryArchiveObjectDeletion,
  type RecoveryArchiveObjectDeletionInput } from '../../src/multitable/recovery-archive-object-deletions'

const run = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const suite = run ? describe : describe.skip
test('sentinel: deletion admission real-DB step must supply DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) throw new Error('deletion_admission_database_missing')
})
const prefix = `tm_dl_${randomUUID().replaceAll('-', '')}`
const role = `${prefix}_role`
const attackSchema = `${prefix}_attack`
const commandSignature = 'public.meta_recovery_archive_object_deletion_command(uuid, uuid, text, uuid, text, text, text, text, uuid, bigint, text, text, bigint)'
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

suite('expired archive object admission (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOINHERIT`)
    await pool.query(`CREATE SCHEMA ${attackSchema} AUTHORIZATION ${role}`)
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
    await pool.query(`GRANT EXECUTE ON FUNCTION ${commandSignature} TO ${role}`)
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
      for (const generation of [target, replacement]) {
        await client.query(`INSERT INTO meta_recovery_archives (generation_id, workspace_id, base_id, sheet_id,
          anchor_operation_id, anchor_seq, checkpoint_id, state, build_status, coverage_status,
          source_vector_hash, key_id, root_hash, coverage_section_hash, coverage_row_count, manifest_mac,
          owner_kind, owner_id, owner_fence, lease_expires_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'finalized', 'complete', $9, $10, $11, $12, 0,
                  $13, 'archive_builder', $14, 1, '2099-01-01', $15)`,
        [generation, workspace, base, sheet, anchor, seq, checkpoint,
          generation === target ? 'expired' : 'verified', hash('source'), key, hash('root'), hash('coverage'),
          Buffer.from('synthetic_mac'), `${prefix}_owner`, generation === target ? '2000-01-01' : '2099-01-01'])
        for (const section of [...sections, null]) {
          await client.query(`INSERT INTO meta_recovery_archive_objects (generation_id, object_id, object_class,
            section_name, key_id, provider_version, plaintext_sha256, ciphertext_sha256, size_bytes,
            idempotency_key, put_receipt_sha256, head_receipt_sha256, owner_kind, owner_id, owner_fence,
            state, verified_at) VALUES ($1, $2, $3, $4, $5, 'synthetic', $6, $7, 0, $8, $9, $10,
              'archive_builder', $11, 1, 'verified', clock_timestamp())`,
          [generation, section ? hash(`synthetic-section-${section}`) : hash('synthetic-manifest'),
            section ? 'section' : 'manifest', section, key, hash('plain'), hash('cipher'),
            hash(`put-${generation}-${section}`), hash('put'), hash('head'), `${prefix}_owner`])
        }
      }
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
          'meta_recovery_archive_objects', 'meta_recovery_archives']) {
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

  test('definer authority has fixed search path and no public execution or implicit table grants', async () => {
    const functions = await pool.query(`SELECT proname, prosecdef, proconfig,
      coalesce((SELECT bool_or(acl.grantee=0 AND acl.privilege_type='EXECUTE') FROM aclexplode(coalesce(proacl, acldefault('f', proowner))) acl), false) AS public_execute
      FROM pg_proc WHERE proname IN ('meta_recovery_archive_object_deletion_command', 'meta_recovery_archive_object_deletion_hold_cancel') ORDER BY proname`)
    expect(functions.rows).toEqual([
      { proname: 'meta_recovery_archive_object_deletion_command', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], public_execute: false },
      { proname: 'meta_recovery_archive_object_deletion_hold_cancel', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], public_execute: false },
    ])
  })

  test('request then exact CAS ready retain immutable key and every object/key reference', async () => rollback(async client => {
    const value = input()
    const request = await requestRecoveryArchiveObjectDeletion(queryOf(client), value)
    expect(request).toEqual({ ...value, state: 'requested', rowVersion: '1' })
    expect(await prepareRecoveryArchiveObjectDeletion(queryOf(client), { ...value, expectedRowVersion: '1' }))
      .toEqual({ ...value, state: 'ready', rowVersion: '2' })
    expect(await state(client, value.id)).toEqual([{ state: 'ready', row_version: '2', provider_operation_key: value.providerOperationKey,
      provider_receipt_sha256: null, worker_fence: '0' }])
    expect((await client.query('SELECT count(*)::int AS count FROM meta_recovery_archive_objects WHERE generation_id = $1', [target])).rows).toEqual([{ count: 11 }])
    expect((await client.query('SELECT state FROM meta_recovery_archive_keys WHERE key_id = $1', [key])).rows).toEqual([{ state: 'active' }])

  }))

  test('stale CAS, operation-key substitution, identity mismatch and duplicate intent refuse', async () => rollback(async client => {
    const value = input()
    await requestRecoveryArchiveObjectDeletion(queryOf(client), value)
    for (const patch of [{ expectedRowVersion: '2' }, { providerOperationKey: hash('forged') }, { anchorSeq: '9007199254753002' }, { workspaceId: 'wrong' }]) {
      await refused(client, () => prepareRecoveryArchiveObjectDeletion(queryOf(client), { ...value, expectedRowVersion: '1', ...patch }), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
    }
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), { ...value, id: randomUUID() }), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
    expect((await state(client, value.id))[0].state).toBe('requested')
  }))

  test('nonexpired archive, active hold and missing exact object refuse', async () => rollback(async client => {
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), { ...input(), generationId: replacement }), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
    await fixtureMutation(client, 'meta_recovery_archives', "UPDATE meta_recovery_archives SET state='verified' WHERE generation_id=$1", [target])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
    await fixtureMutation(client, 'meta_recovery_archives', "UPDATE meta_recovery_archives SET state='expired' WHERE generation_id=$1", [target])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), { ...input(), objectId: hash('missing') }), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
    await placeRecoveryArchiveLegalHold(queryOf(client), { holdId: randomUUID(), workspaceId: workspace, baseId: base,
      sheetId: sheet, generationId: target, reasonCode: 'LEGAL_SYNTHETIC', placedByActorId: `${prefix}_actor` })
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test('a building future point leaves the expired target as sole complete cover', async () => rollback(async client => {
    await fixtureMutation(client, 'meta_recovery_archives', `UPDATE meta_recovery_archives
      SET state = 'building', build_status = 'active', coverage_status = 'incomplete' WHERE generation_id = $1`, [replacement])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test.each(['section', 'manifest'])('replacement missing %s availability refuses sole-cover admission', async objectClass => rollback(async client => {
    await fixtureMutation(client, 'meta_recovery_archive_objects', `DELETE FROM meta_recovery_archive_objects
      WHERE generation_id = $1 AND object_class = $2`, [replacement, objectClass])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test('a supersession hint to a later identity does not authorize deletion', async () => rollback(async client => {
    await fixtureMutation(client, 'meta_recovery_archives', `UPDATE meta_recovery_archives SET anchor_seq = anchor_seq + 1 WHERE generation_id = $1`, [replacement])
    await fixtureMutation(client, 'meta_recovery_archives', `UPDATE meta_recovery_archives SET superseded_by_generation_id = $2 WHERE generation_id = $1`, [target, replacement])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test('nonterminal exact-generation job binding refuses even with a complete replacement', async () => rollback(async client => {
    await fixtureMutation(client, 'meta_recovery_archive_jobs', `INSERT INTO meta_recovery_archive_jobs (
      id, workspace_id, base_id, sheet_id, actor_id, token_sha256, recovery_mode, scope_kind,
      scope_hash, archive_generation_id, archive_root_hash, source_vector_hash, key_id, plan_hash,
      plan_object_id, plan_object_version, plan_object_sha256, plan_object_size, plan_object_expires_at,
      total_count, block_fence, resume_deadline
    ) VALUES ($1, $2, $3, $4, 'synthetic_actor', $5, 'revert', 'whole_sheet', $5, $6, $5, $5, $7,
      $5, 'synthetic_plan', 'synthetic_version', $5, 1, '2099-01-02', 5001, 1, '2099-01-01')`,
    [randomUUID(), workspace, base, sheet, hash('synthetic_job'), target, key])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test('replacement attachment reference without exact available receipt refuses', async () => rollback(async client => {
    await fixtureMutation(client, 'meta_recovery_archive_attachment_refs', `INSERT INTO meta_recovery_archive_attachment_refs
      (generation_id, attachment_id, reference_class, reference_state, availability, content_sha256, immutable_version, content_size_bytes)
      VALUES ($1, 'synthetic_attachment', 'archive_object', 'verified', 'available', $2, 'synthetic_version', 1)`, [replacement, hash('attachment')])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test('replacement attachment same digest with a different provider version refuses', async () => rollback(async client => {
    await fixtureMutation(client, 'meta_recovery_archive_attachment_refs', `INSERT INTO meta_recovery_archive_attachment_refs
      (generation_id, attachment_id, reference_class, reference_state, availability, content_sha256, immutable_version, content_size_bytes)
      VALUES ($1, 'synthetic_attachment', 'archive_object', 'verified', 'available', $2, 'different_version', 1)`, [replacement, hash('plain')])
    await fixtureMutation(client, 'meta_recovery_archive_objects', `INSERT INTO meta_recovery_archive_objects (
      generation_id, object_id, object_class, section_name, attachment_id, key_id, provider_version,
      plaintext_sha256, ciphertext_sha256, size_bytes, idempotency_key, put_receipt_sha256, head_receipt_sha256,
      owner_kind, owner_id, owner_fence, state, verified_at
    ) SELECT generation_id, $2, 'attachment', NULL, 'synthetic_attachment', key_id, provider_version,
      plaintext_sha256, ciphertext_sha256, size_bytes, $3, put_receipt_sha256, head_receipt_sha256,
      owner_kind, owner_id, owner_fence, state, verified_at FROM meta_recovery_archive_objects
      WHERE generation_id=$1 AND object_class='manifest'`, [replacement, hash('synthetic_attachment'), hash('synthetic_attachment_put')])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test('RR snapshot predating committed hold is refused before admission', async () => {
    const oldSnapshot = await pool.connect(); const holder = await pool.connect(); const value = input()
    try {
      await oldSnapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      await oldSnapshot.query('SELECT count(*) FROM meta_recovery_archive_legal_holds')
      await holder.query('BEGIN')
      await placeRecoveryArchiveLegalHold(queryOf(holder), { holdId: randomUUID(), workspaceId: workspace, baseId: base,
        sheetId: sheet, generationId: target, reasonCode: 'LEGAL_RR', placedByActorId: `${prefix}_actor` })
      await holder.query('COMMIT')
      await refused(oldSnapshot, () => oldSnapshot.query(`SELECT * FROM public.meta_recovery_archive_object_deletion_command($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'request',NULL)`,
        [value.id, target, objectId, value.ownerRequestId, value.providerOperationKey, workspace, base, sheet, anchor, seq, checkpoint]), 'recovery_archive_object_deletion_isolation_refused')
      await oldSnapshot.query('ROLLBACK')
      expect((await holder.query('SELECT count(*)::int AS count FROM meta_recovery_archive_object_deletions WHERE id=$1', [value.id])).rows).toEqual([{ count: 0 }])
      await holder.query('BEGIN')
      await fixtureMutation(holder, 'meta_recovery_archive_legal_holds', 'DELETE FROM meta_recovery_archive_legal_holds WHERE generation_id=$1', [target])
      await holder.query('COMMIT')
    } finally { await oldSnapshot.query('ROLLBACK'); await holder.query('ROLLBACK'); oldSnapshot.release(); holder.release() }
  })

  test('an expired key or incomplete target roster refuses', async () => rollback(async client => {
    await fixtureMutation(client, 'meta_recovery_archive_keys', "UPDATE meta_recovery_archive_keys SET state='retiring' WHERE key_id=$1", [key])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
    await fixtureMutation(client, 'meta_recovery_archive_keys', "UPDATE meta_recovery_archive_keys SET state='active' WHERE key_id=$1", [key])
    await fixtureMutation(client, 'meta_recovery_archive_objects', "DELETE FROM meta_recovery_archive_objects WHERE generation_id=$1 AND object_class='manifest'", [target])
    await refused(client, () => requestRecoveryArchiveObjectDeletion(queryOf(client), input()), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test('hold placement atomically cancels requested and ready; further prepare refuses', async () => rollback(async client => {
    const first = input()
    const second = { ...input(), objectId: hash('synthetic-manifest') }
    const failed = { ...input(), objectId: hash('synthetic-section-auto_number') }
    await requestRecoveryArchiveObjectDeletion(queryOf(client), first)
    await requestRecoveryArchiveObjectDeletion(queryOf(client), second)
    await requestRecoveryArchiveObjectDeletion(queryOf(client), failed)
    await fixtureMutation(client, 'meta_recovery_archive_object_deletions', "UPDATE meta_recovery_archive_object_deletions SET state='failed_retryable', attempt_count=1, worker_fence=1 WHERE id=$1", [failed.id])
    await prepareRecoveryArchiveObjectDeletion(queryOf(client), { ...first, expectedRowVersion: '1' })
    await placeRecoveryArchiveLegalHold(queryOf(client), { holdId: randomUUID(), workspaceId: workspace, baseId: base,
      sheetId: sheet, generationId: target, reasonCode: 'LEGAL_CANCEL', placedByActorId: `${prefix}_actor` })
    expect((await state(client, first.id))[0]).toMatchObject({ state: 'cancelled', row_version: '3' })
    expect((await state(client, second.id))[0]).toMatchObject({ state: 'cancelled', row_version: '2' })
    expect((await state(client, failed.id))[0]).toMatchObject({ state: 'cancelled', row_version: '2', worker_fence: '1' })
    await refused(client, () => prepareRecoveryArchiveObjectDeletion(queryOf(client), { ...second, expectedRowVersion: '1' }), 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }))

  test('restricted role cannot DML, lock intent, forge nested trigger/GUC or replace authority', async () => rollback(async client => {
    const value = input()
    await client.query(`SET LOCAL ROLE ${role}`)
    const privileges = await client.query(`SELECT current_user AS role,
      has_table_privilege(current_user, 'public.meta_recovery_archive_object_deletions', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER') AS table_write,
      pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid='public.meta_recovery_archive_object_deletions'::regclass), 'MEMBER') AS owner_member`)
    expect(privileges.rows).toEqual([{ role, table_write: false, owner_member: false }])
    await requestRecoveryArchiveObjectDeletion(queryOf(client), value)
    await refused(client, () => client.query('SELECT * FROM public.meta_recovery_archive_object_deletion_command($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [value.id, target, objectId, value.ownerRequestId, value.providerOperationKey, workspace, base, sheet, anchor, seq, checkpoint, 'deleting', 1]), 'recovery_archive_object_deletion_input_invalid')
    await client.query("SELECT set_config('metasheet.recovery_archive_object_deletion_authorized', 'true', true)")
    const denied = async (text: string, values: unknown[] = []) => {
      await client.query('SAVEPOINT denied')
      let error: unknown
      try { await client.query(text, values) } catch (cause) { error = cause }
      await client.query('ROLLBACK TO SAVEPOINT denied')
      expect(error).toMatchObject({ code: '42501' })
    }
    await denied(`UPDATE public.meta_recovery_archive_object_deletions SET state='ready', ready_at=clock_timestamp(), row_version=row_version+1 WHERE id=$1`, [value.id])
    await denied('SELECT 1 FROM public.meta_recovery_archive_object_deletions FOR UPDATE')
    await denied('TRUNCATE public.meta_recovery_archive_object_deletions')
    await denied('SELECT public.meta_recovery_archive_deletion_complete($1)', [target])
    await denied(`ALTER FUNCTION ${commandSignature} SECURITY INVOKER`)
    await client.query(`CREATE TABLE ${attackSchema}.attack (id uuid)`)
    await client.query(`CREATE FUNCTION ${attackSchema}.forge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE public.meta_recovery_archive_object_deletions SET state='ready', ready_at=clock_timestamp(), row_version=row_version+1 WHERE id=NEW.id;
      RETURN NEW; END $$`)
    await client.query(`CREATE TRIGGER forge BEFORE INSERT ON ${attackSchema}.attack FOR EACH ROW EXECUTE FUNCTION ${attackSchema}.forge()`)
    await denied(`INSERT INTO ${attackSchema}.attack VALUES ($1)`, [value.id])
    await expect(prepareRecoveryArchiveObjectDeletion(queryOf(client), { ...value, expectedRowVersion: '1' })).resolves.toMatchObject({ state: 'ready', rowVersion: '2' })
    await client.query('RESET ROLE')
    expect((await state(client, value.id))[0].state).toBe('ready')
  }))

  test.each(['deleting', 'deleted'])('late %s hold refusal rolls back every cancellation and hold row', async lateState => rollback(async client => {
    const first = input(); const late = { ...input(), objectId: hash('synthetic-manifest') }
    await requestRecoveryArchiveObjectDeletion(queryOf(client), first)
    await requestRecoveryArchiveObjectDeletion(queryOf(client), late)
    await fixtureMutation(client, 'meta_recovery_archive_object_deletions', 'UPDATE meta_recovery_archive_object_deletions SET state=$2 WHERE id=$1', [late.id, lateState])
    await refused(client, () => placeRecoveryArchiveLegalHold(queryOf(client), {
      holdId: randomUUID(), workspaceId: workspace, baseId: base, sheetId: sheet,
      generationId: target, reasonCode: 'LEGAL_TOO_LATE', placedByActorId: `${prefix}_actor`,
    }), 'RECOVERY_ARCHIVE_LEGAL_HOLD_PLACE_CONFLICT')
    expect((await state(client, first.id))[0].state).toBe('requested')
    expect((await client.query("SELECT count(*)::int AS count FROM meta_recovery_archive_legal_holds WHERE generation_id=$1 AND state='active'", [target])).rows).toEqual([{ count: 0 }])
  }))

  test.each([true, false])('hold/READY race with hold first=%s converges to cancelled without reference removal', async holdFirst => {
    const first = await pool.connect(); const second = await pool.connect()
    const value = { ...input(), objectId: hash(`synthetic-section-${holdFirst ? 'schema' : 'links'}`) }
    const hold = () => placeRecoveryArchiveLegalHold(queryOf(holdFirst ? first : second), {
      holdId: randomUUID(), workspaceId: workspace, baseId: base, sheetId: sheet,
      generationId: target, reasonCode: 'LEGAL_RACE', placedByActorId: `${prefix}_actor`,
    })
    let pending: Promise<{ ok: boolean }> | undefined
    try {
      await first.query('BEGIN'); await requestRecoveryArchiveObjectDeletion(queryOf(first), value); await first.query('COMMIT')
      await first.query('BEGIN'); await second.query('BEGIN')
      const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      if (holdFirst) await hold()
      else await prepareRecoveryArchiveObjectDeletion(queryOf(first), { ...value, expectedRowVersion: '1' })
      pending = (holdFirst
        ? prepareRecoveryArchiveObjectDeletion(queryOf(second), { ...value, expectedRowVersion: '1' })
        : hold()).then(() => ({ ok: true }), () => ({ ok: false }))
      await waitBlocked(secondPid, firstPid)
      await first.query('COMMIT')
      const result = await pending
      expect(result.ok).toBe(!holdFirst)
      await second.query(holdFirst ? 'ROLLBACK' : 'COMMIT')
      expect((await state(first, value.id))[0].state).toBe('cancelled')
      expect((await first.query('SELECT count(*)::int AS count FROM meta_recovery_archive_objects WHERE generation_id=$1', [target])).rows).toEqual([{ count: 11 }])
      await first.query('BEGIN')
      await fixtureMutation(first, 'meta_recovery_archive_legal_holds', 'DELETE FROM meta_recovery_archive_legal_holds WHERE generation_id=$1', [target])
      await first.query('COMMIT')
    } finally {
      await first.query('ROLLBACK'); await second.query('ROLLBACK');
      if (pending) await pending
      first.release(); second.release()
    }
  })

  test('retained intent makes development down refuse', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await requestRecoveryArchiveObjectDeletion(queryOf(client), { ...input(), objectId: hash('synthetic-section-views_config') })
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    let error: unknown
    try { await db.transaction().execute(migration.down) } catch (cause) { error = cause }
    expect(error).toMatchObject({ message: 'recovery_archive_object_deletion_nonempty', code: '55000' })
  })

  test('prepare parks on active key before any intent tuple is acquired', async () => {
    const owner = await pool.connect(); const worker = await pool.connect(); const probe = await pool.connect()
    const value = input()
    let pending: Promise<unknown> | undefined
    try {
      await owner.query('BEGIN'); await requestRecoveryArchiveObjectDeletion(queryOf(owner), value); await owner.query('COMMIT')
      await owner.query('BEGIN'); await owner.query('SELECT 1 FROM meta_recovery_archive_keys WHERE key_id=$1 FOR UPDATE', [key])
      await worker.query('BEGIN');
      const workerPid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const ownerPid = (await owner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = prepareRecoveryArchiveObjectDeletion(queryOf(worker), { ...value, expectedRowVersion: '1' })
      await waitBlocked(workerPid, ownerPid)
      await probe.query('BEGIN'); await probe.query('SELECT 1 FROM meta_recovery_archive_object_deletions WHERE id=$1 FOR UPDATE NOWAIT', [value.id]); await probe.query('ROLLBACK')
      await owner.query('ROLLBACK'); await pending; await worker.query('ROLLBACK')
    } finally {
      await owner.query('ROLLBACK'); await worker.query('ROLLBACK'); await probe.query('ROLLBACK');
      if (pending) await pending.catch(() => {})
      owner.release(); worker.release(); probe.release()
    }
  })
})
