/**
 * W4C-0 (#4556) Stage E2 — amendment section 2 identity gates, real-DB legs.
 *
 * The eight amendment gates, one describe-block family each (the pure-unit legs of
 * gates 1-4/6/8 live in src/attendance/__tests__/w4c0-identity.test.ts — this file
 * carries the DB-boundary and reload legs):
 *  1. `default` accepted only under legacy_projection_only, rejected for
 *     shadow|authoritative INCLUDING after serialization and DB reload, with the
 *     eligible->shadow normalization proven on a real persisted `eligible` rollout row,
 *     and the Stage E2 DB CHECKs rejecting a raw default+W4-posture row on all three
 *     write surfaces;
 *  2. cross-source UUIDv5 symmetric matrix at the DB boundary: all six ordered pairs of
 *     {import_item, integration_item, scheduled} masquerades fail the derived-ID CHECK,
 *     with correct-namespace positive controls;
 *  3. no final-UUID submission: SQL tuple mutations (root/ordinal/fingerprint/user/date)
 *     each change the derived UUID; the NUL separator is load-bearing; a correctly
 *     derived UUID attached to a mismatched proof tuple is rejected;
 *  4. JSON clone/spread/prototype/plain-object forgeries are rejected by the key builder
 *     AND by the acquisition helper BEFORE any SQL is issued;
 *  5. queue/DB reload re-runs the factory from the immutable durable proof and rejects
 *     operation-ID or proof-field drift; the P07 proof vector re-derives through the
 *     factory entry by entry;
 *  6. the three pinned namespace UUIDv5 goldens through the SQL boundary function
 *     (signed-bigint key goldens are pinned in the Stage B parity + unit files);
 *  7. the migration rejects unknown source kinds and every illegal scalar proof-field
 *     combination (fresh/upgrade/replay/down legs live in the Stage E1 file);
 *  8. pre-lock/post-lock isolation: the rollout helper re-validates the lexical parser
 *     contract, operation/target helpers accept only factory witnesses (a pre-lock
 *     candidate has no authority), the post-lock factory demands the resolver's posture
 *     witness bound to the SAME org key, and uppercase UUID input canonicalizes to the
 *     identical identity and advisory key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceResultOperationLocks,
  buildAttendanceCalculationRolloutAdvisoryKey,
  buildAttendanceResultOperationAdvisoryKey,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  deriveAttendanceOperationCandidateIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  rehydrateVerifiedAttendanceOperationIdentityV1,
  resolveSegmentCalculationPosture,
  AttendanceW4IdentityError,
  type AttendanceOperationIdentityDurableRowV1,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOperationIdentityV1,
  type VerifiedAttendanceOrgIdentityV1,
} from '../../src/attendance/w4c0-identity'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const ENV_KEY = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)

const IMPORT_NS = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'
const INTEGRATION_NS = '46501375-c273-459f-a5af-f926859f6411'
const SCHEDULED_NS = 'e4363171-f53f-47d7-a074-607ef3fad391'

// Same pinned tuples/goldens as the Stage B parity + unit files.
const GOLDEN_IMPORT_ITEM_UUID = 'e22b42e2-c607-50b4-8bcf-dcc383d15bc3'
const GOLDEN_INTEGRATION_ITEM_UUID = 'c3bf2b78-8f9e-5b45-a441-772905c30e4e'
const GOLDEN_SCHEDULED_UUID = '3e1fa29a-f411-5840-bed0-4c0f92c9f140'
const IMPORT_ROOT = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_ROOT = '22222222-2222-4222-8222-222222222222'
const SCHED_RUN = '33333333-3333-4333-8333-333333333333'
const SCHED_USER = '44444444-4444-4444-8444-444444444444'
const SCHED_DATE = '2026-03-01'
const FP_A = HEX64_A
const FP_B = 'b'.repeat(64)

function uuid(): string {
  return crypto.randomUUID()
}

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (sqlText, params) =>
      client.query(sqlText, params as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>,
  }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof AttendanceW4IdentityError) return error.code
    return String((error as Error).message)
  }
  return 'NO_ERROR'
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (error) {
    if (error instanceof AttendanceW4IdentityError) return error.code
    return String((error as Error).message)
  }
  return 'NO_ERROR'
}

describeIfDatabase('W4C-0 Stage E2 — amendment section 2 identity gates (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const ORG_SHADOW = uuid()
  const ORG_ELIGIBLE = uuid()
  let migrationDb: Kysely<unknown> | undefined
  let priorEnv: string | undefined

  beforeAll(async () => {
    priorEnv = process.env[ENV_KEY]
    process.env[ENV_KEY] = `${ORG_SHADOW},${ORG_ELIGIBLE}`
    // Idempotent replay so a locally stale database also carries the Stage E boundary
    // constraints (CI migrates fresh before this file runs).
    migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
    })
    await up(migrationDb)
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'shadow', 'w4c0-e2', 'TEST_FIXTURE', 'actor-e2', 1, 'legacy', 'synthetic_staging'),
              ($2, 'shadow', 'w4c0-e2', 'TEST_FIXTURE', 'actor-e2', 1, 'legacy', 'synthetic_staging')`,
      [ORG_SHADOW, ORG_ELIGIBLE],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'eligible', prior_state = 'shadow', version = 2 WHERE org_id = $1`,
      [ORG_ELIGIBLE],
    )
  }, 60000)

  afterAll(async () => {
    if (priorEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = priorEnv
    await migrationDb?.destroy()
    await pool.end()
  })

  async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('ROLLBACK')
      return result
    } finally {
      client.release()
    }
  }

  async function mintOrg(client: PoolClient, org: string): Promise<VerifiedAttendanceOrgIdentityV1> {
    const posture = await resolveSegmentCalculationPosture(trx(client), org)
    return createVerifiedAttendanceOrgIdentityV1({ orgKey: org, posture })
  }

  // =========================================================================
  // Gate 1 — default org x posture matrix, including serialization + DB reload.
  // =========================================================================

  it('gate 1: default accepted only under legacy_projection_only — rehydration (DB reload) rejects default+shadow|authoritative; real persisted eligible normalizes to shadow', async () => {
    const directRow = (posture: string): AttendanceOperationIdentityDurableRowV1 => ({
      orgId: 'default',
      entrypoint: 'live_punch',
      kind: 'item',
      operationId: '66666666-6666-4666-8666-666666666666',
      acceptedWritePosture: posture,
      identitySourceKind: 'direct_live_punch',
      sourceRootId: null,
      inputOrdinal: null,
      proofSemanticFingerprint: null,
      proofUserId: null,
      proofWorkDate: null,
    })
    // Positive: default + legacy compatibility command rehydrates and the builder
    // accepts the witness.
    const legacyIdentity = rehydrateVerifiedAttendanceOperationIdentityV1(directRow('legacy_projection_only'))
    expect(typeof buildAttendanceResultOperationAdvisoryKey(legacyIdentity)).toBe('bigint')
    expect(legacyIdentity.org.acceptedWritePosture).toBe('legacy_projection_only')
    // default + every W4-enabled posture rejected on reload.
    expect(codeOf(() => rehydrateVerifiedAttendanceOperationIdentityV1(directRow('shadow')))).toBe(
      'W4C0_DEFAULT_ORG_POSTURE_REJECTED',
    )
    expect(codeOf(() => rehydrateVerifiedAttendanceOperationIdentityV1(directRow('authoritative')))).toBe(
      'W4C0_DEFAULT_ORG_POSTURE_REJECTED',
    )
    // `eligible` is a rollout state, never an accepted write posture — a durable row
    // claiming it is rejected before the default/posture door even matters.
    expect(codeOf(() => rehydrateVerifiedAttendanceOperationIdentityV1(directRow('eligible')))).toBe(
      'W4C0_WRITE_POSTURE_INVALID',
    )

    // Real persisted `eligible` rollout row: the resolver normalizes to accepted
    // write posture `shadow` (the ONE conversion point), so a hypothetical default
    // org in that state fails through the same shadow door.
    await withClient(async (client) => {
      const posture = await resolveSegmentCalculationPosture(trx(client), ORG_ELIGIBLE)
      expect(posture.effectiveState).toBe('eligible')
      expect(posture.writePosture).toBe('shadow')
      const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_ELIGIBLE, posture })
      expect(org.acceptedWritePosture).toBe('shadow')
    })

    // Serialization destroys the witness: a JSON round trip of a real verified
    // identity is no longer accepted by the builder (gate 1 "after serialization").
    await withClient(async (client) => {
      const org = await mintOrg(client, ORG_SHADOW)
      const identity = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'live_punch',
        source: { sourceKind: 'direct_live_punch', clientOperationId: uuid() },
      })
      const serialized = JSON.parse(JSON.stringify(identity)) as VerifiedAttendanceOperationIdentityV1
      expect(codeOf(() => buildAttendanceResultOperationAdvisoryKey(serialized))).toBe(
        'W4C0_OPERATION_WITNESS_REQUIRED',
      )
    })
  })

  it('gate 1 (DB boundary): a raw default+W4-posture row is rejected on all three write surfaces; default+legacy persists', async () => {
    // operations
    await expect(
      pool.query(
        `INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
            capability, subject_scope, command_fingerprint, accepted_write_posture, state, response_snapshot)
         VALUES ('default', 'live_punch', $1, 'direct_live_punch', 'live:e2', 'actor-e2', 'self',
                 'punch', '{}'::jsonb, $2, 'shadow', 'completed', '{"ok":true}'::jsonb)`,
        [uuid(), HEX64_A],
      ),
    ).rejects.toThrow(/chk_aro_default_org_posture/)
    // batches
    await expect(
      pool.query(
        `INSERT INTO attendance_result_operation_batches
           (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
            actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
            command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot)
         SELECT 'default', 'import_batch', b.id, 'import_batch', b.id, 'b:e2', 'actor-e2', 'delegated_import',
                'import', '{}'::jsonb, 'authoritative', $1, 1, $1, $1, 'completed', '{"order":[],"byId":{}}'::jsonb
           FROM (SELECT $2::uuid AS id) b`,
        [HEX64_A, uuid()],
      ),
    ).rejects.toThrow(/chk_arob_default_org_posture/)
    // jobs
    await expect(
      pool.query(
        `INSERT INTO attendance_import_jobs
           (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
            w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
            w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
            w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
         SELECT 'default', $1::uuid, 'actor-e2', 'queued', '{}'::jsonb, 1, 'import_batch', $1::uuid, 'import_batch',
                'b:e2', 'actor-e2', 'delegated_import', $2, 'shadow', 1, $2, $2,
                jsonb_build_array(jsonb_build_object(
                  'ordinal', 0, 'semanticFingerprint', $3::text,
                  'derivedOperationId', attendance_w4_uuidv5($4::uuid, attendance_w4_item_name_bytes($1::uuid, 0, $3))::text,
                  'commandFingerprint', $2::text))`,
        [uuid(), HEX64_B, HEX64_A, IMPORT_NS],
      ),
    ).rejects.toThrow(/chk_aij_w4_default_org_posture/)

    // Positive: default + legacy_projection_only persists (the compatibility path).
    const okId = uuid()
    await pool.query(
      `INSERT INTO attendance_result_operations
         (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
          capability, subject_scope, command_fingerprint, accepted_write_posture, state, response_snapshot)
       VALUES ('default', 'live_punch', $1, 'direct_live_punch', 'live:e2', 'actor-e2', 'self',
               'punch', '{}'::jsonb, $2, 'legacy_projection_only', 'completed', '{"ok":true}'::jsonb)`,
      [okId, HEX64_A],
    )
    const persisted = await pool.query(
      `SELECT accepted_write_posture FROM attendance_result_operations WHERE org_id = 'default' AND operation_id = $1::uuid`,
      [okId],
    )
    expect(persisted.rows).toEqual([{ accepted_write_posture: 'legacy_projection_only' }])
  })

  // =========================================================================
  // Gate 2 — cross-source UUIDv5 symmetric matrix at the DB boundary.
  // =========================================================================

  it('gate 2: all six ordered cross-namespace masquerades fail the derived-ID CHECK; correct namespaces persist', async () => {
    const org = uuid()
    const root = uuid()
    const user = uuid()
    const derive = async (ns: string, kind: 'item' | 'sched'): Promise<string> => {
      const { rows } =
        kind === 'item'
          ? await pool.query(
              'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
              [ns, root, HEX64_A],
            )
          : await pool.query(
              "SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, '2026-03-05'::date))::text AS v",
              [ns, root, user],
            )
      return rows[0].v as string
    }
    const importId = await derive(IMPORT_NS, 'item')
    const integrationId = await derive(INTEGRATION_NS, 'item')
    const scheduledId = await derive(SCHEDULED_NS, 'sched')

    const insertItem = (sourceKind: 'import_item' | 'integration_item', operationId: string) => {
      const entrypoint = sourceKind === 'import_item' ? 'import_batch' : 'integration_batch'
      return pool.query(
        `WITH b AS (
           INSERT INTO attendance_result_operation_batches
             (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
              actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
              command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot)
           VALUES ($1, $2, $3::uuid, $2, $3::uuid, 'b:e2', 'actor-e2', 'delegated_import',
                   'import', '{}'::jsonb, 'shadow', $4, 1, $4, $4, 'completed', '{"order":[],"byId":{}}'::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING 1
         )
         INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, batch_command_id, input_ordinal, identity_source_kind,
            source_root_id, proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability,
            subject_scope, command_fingerprint, accepted_write_posture, state,
            normalized_business_input_snapshot, response_snapshot)
         VALUES ($1, $2, $5::uuid, $3::uuid, 0, $6, $3::uuid, $7, 'i:e2', 'actor-e2',
                 'delegated_import', 'import', '{}'::jsonb, $4, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
        [org, entrypoint, root, HEX64_B, operationId, sourceKind, HEX64_A],
      )
    }
    const insertScheduled = (operationId: string) =>
      pool.query(
        `INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, identity_source_kind, source_root_id, proof_user_id,
            proof_work_date, source_ref, actor_id, actor_posture, capability, subject_scope,
            command_fingerprint, accepted_write_posture, state, response_snapshot)
         VALUES ($1, 'scheduled', $2::uuid, 'scheduled', $3::uuid, $4::uuid, '2026-03-05', 's:e2', 'actor-e2',
                 'scheduler', 'scheduled', '{}'::jsonb, $5, 'shadow', 'completed', '{"ok":true}'::jsonb)`,
        [org, operationId, root, user, HEX64_B],
      )

    // The six ordered masquerades (identity derived under NS-A presented as source B).
    await expect(insertItem('import_item', integrationId)).rejects.toThrow(/chk_aro_derived_identity/)
    await expect(insertItem('import_item', scheduledId)).rejects.toThrow(/chk_aro_derived_identity/)
    await expect(insertItem('integration_item', importId)).rejects.toThrow(/chk_aro_derived_identity/)
    await expect(insertItem('integration_item', scheduledId)).rejects.toThrow(/chk_aro_derived_identity/)
    await expect(insertScheduled(importId)).rejects.toThrow(/chk_aro_derived_identity/)
    await expect(insertScheduled(integrationId)).rejects.toThrow(/chk_aro_derived_identity/)

    // Positive controls: the correct namespace persists for every derived family
    // (import positive already lives in the Stage A smoke; integration + scheduled here).
    await insertItem('integration_item', integrationId)
    await insertScheduled(scheduledId)
    const persisted = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1',
      [org],
    )
    expect(persisted.rows[0].n).toBe(2)
  })

  // =========================================================================
  // Gate 3 — no final-UUID submission; every tuple field is load-bearing.
  // =========================================================================

  it('gate 3: every SQL tuple mutation (root/ordinal/fingerprint/user/date) and the NUL separator change the derived UUID; a correct UUID with a mismatched tuple is rejected', async () => {
    const root = uuid()
    const otherRoot = uuid()
    const user = uuid()
    const derived = async (sqlText: string, params: unknown[]): Promise<string> => {
      const { rows } = await pool.query(sqlText, params)
      return rows[0].v as string
    }
    const base = await derived(
      'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
      [IMPORT_NS, root, HEX64_A],
    )
    const mutations = await Promise.all([
      derived('SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v', [IMPORT_NS, otherRoot, HEX64_A]),
      derived('SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 1, $3))::text AS v', [IMPORT_NS, root, HEX64_A]),
      derived('SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v', [IMPORT_NS, root, HEX64_B]),
      derived('SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v', [INTEGRATION_NS, root, HEX64_A]),
    ])
    expect(new Set([base, ...mutations]).size).toBe(5)

    const schedBase = await derived(
      "SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, '2026-03-05'::date))::text AS v",
      [SCHEDULED_NS, root, user],
    )
    const schedMutations = await Promise.all([
      derived("SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, '2026-03-06'::date))::text AS v", [SCHEDULED_NS, root, user]),
      derived("SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, '2026-03-05'::date))::text AS v", [SCHEDULED_NS, root, uuid()]),
    ])
    expect(new Set([schedBase, ...schedMutations]).size).toBe(3)

    // NUL separators are load-bearing: the same scalar bytes joined WITHOUT the NUL
    // separator produce a different identity.
    const noNul = await derived(
      "SELECT attendance_w4_uuidv5($1::uuid, convert_to($2::uuid::text || '0' || $3, 'UTF8'))::text AS v",
      [IMPORT_NS, root, HEX64_A],
    )
    expect(noNul).not.toBe(base)

    // A CORRECT derived UUID cannot be attached to a different proof tuple: `base`
    // was derived for ordinal 0, presenting it with ordinal 1 fails the CHECK.
    const org = uuid()
    await expect(
      pool.query(
        `WITH b AS (
           INSERT INTO attendance_result_operation_batches
             (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
              actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
              command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot)
           VALUES ($1, 'import_batch', $2::uuid, 'import_batch', $2::uuid, 'b:e2', 'actor-e2', 'delegated_import',
                   'import', '{}'::jsonb, 'shadow', $3, 1, $3, $3, 'completed', '{"order":[],"byId":{}}'::jsonb)
           RETURNING 1
         )
         INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, batch_command_id, input_ordinal, identity_source_kind,
            source_root_id, proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability,
            subject_scope, command_fingerprint, accepted_write_posture, state,
            normalized_business_input_snapshot, response_snapshot)
         VALUES ($1, 'import_batch', $4::uuid, $2::uuid, 1, 'import_item', $2::uuid, $5, 'i:e2', 'actor-e2',
                 'delegated_import', 'import', '{}'::jsonb, $3, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
        [org, root, HEX64_B, base, HEX64_A],
      ),
    ).rejects.toThrow(/chk_aro_derived_identity/)
  })

  // =========================================================================
  // Gate 4 — forged witnesses rejected by builder AND helper before any SQL.
  // =========================================================================

  it('gate 4: JSON clone/spread/prototype/plain-object forgeries fail the key builder and the acquisition helper issues ZERO SQL for them', async () => {
    await withClient(async (client) => {
      const org = await mintOrg(client, ORG_SHADOW)
      const identity = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'live_punch',
        source: { sourceKind: 'direct_live_punch', clientOperationId: uuid() },
      })
      const forgeries: Array<[string, unknown]> = [
        ['json-clone', JSON.parse(JSON.stringify(identity))],
        ['spread', { ...(identity as object) }],
        [
          'prototype-lookalike',
          Object.create(
            Object.getPrototypeOf(identity) as object | null,
            Object.getOwnPropertyDescriptors(identity),
          ),
        ],
        [
          'plain-object',
          {
            kind: 'item',
            org: { orgId: ORG_SHADOW, acceptedWritePosture: 'shadow' },
            entrypoint: 'live_punch',
            id: identity.id,
            sourceProof: { ...identity.sourceProof },
          },
        ],
      ]
      for (const [label, forged] of forgeries) {
        expect(
          codeOf(() => buildAttendanceResultOperationAdvisoryKey(forged as VerifiedAttendanceOperationIdentityV1)),
          label,
        ).toBe('W4C0_OPERATION_WITNESS_REQUIRED')
        // The helper must reject BEFORE issuing any SQL.
        let issued = 0
        const countingTrx: AttendanceW4TransactionClientV1 = {
          query: (sqlText, params) => {
            issued += 1
            return trx(client).query(sqlText, params)
          },
        }
        const code = await codeOfAsync(() =>
          acquireAttendanceResultOperationLocks(countingTrx, [forged as VerifiedAttendanceOperationIdentityV1]),
        )
        expect(code, label).toBe('W4C0_OPERATION_WITNESS_REQUIRED')
        expect(issued, label).toBe(0)
      }
      // Positive control: the true witness passes the same helper on the same client.
      await acquireAttendanceResultOperationLocks(trx(client), [identity])
    })
  })

  // =========================================================================
  // Gate 5 — queue/DB reload re-runs the factory; drift fails.
  // =========================================================================

  it('gate 5: durable rows reload through the factory; operation-ID/proof drift, shape violations, and non-canonical dates are rejected; the P07 vector re-derives entry by entry', async () => {
    const org = uuid()
    const root = uuid()
    const user = uuid()
    // Persist one real row per derived/ledger family.
    const importId = (
      await pool.query(
        'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
        [IMPORT_NS, root, HEX64_A],
      )
    ).rows[0].v as string
    await pool.query(
      `WITH b AS (
         INSERT INTO attendance_result_operation_batches
           (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
            actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
            command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot)
         VALUES ($1, 'import_batch', $2::uuid, 'import_batch', $2::uuid, 'b:e2', 'actor-e2', 'delegated_import',
                 'import', '{}'::jsonb, 'shadow', $3, 1, $3, $3, 'completed', '{"order":[],"byId":{}}'::jsonb)
         RETURNING 1
       )
       INSERT INTO attendance_result_operations
         (org_id, entrypoint, operation_id, batch_command_id, input_ordinal, identity_source_kind,
          source_root_id, proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability,
          subject_scope, command_fingerprint, accepted_write_posture, state,
          normalized_business_input_snapshot, response_snapshot)
       VALUES ($1, 'import_batch', $4::uuid, $2::uuid, 0, 'import_item', $2::uuid, $5, 'i:e2', 'actor-e2',
               'delegated_import', 'import', '{}'::jsonb, $3, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
      [org, root, HEX64_B, importId, HEX64_A],
    )
    const scheduledId = (
      await pool.query(
        "SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, '2026-03-05'::date))::text AS v",
        [SCHEDULED_NS, root, user],
      )
    ).rows[0].v as string
    await pool.query(
      `INSERT INTO attendance_result_operations
         (org_id, entrypoint, operation_id, identity_source_kind, source_root_id, proof_user_id,
          proof_work_date, source_ref, actor_id, actor_posture, capability, subject_scope,
          command_fingerprint, accepted_write_posture, state, response_snapshot)
       VALUES ($1, 'scheduled', $2::uuid, 'scheduled', $3::uuid, $4::uuid, '2026-03-05', 's:e2', 'actor-e2',
               'scheduler', 'scheduled', '{}'::jsonb, $5, 'shadow', 'completed', '{"ok":true}'::jsonb)`,
      [org, scheduledId, root, user, HEX64_B],
    )
    const ledgerId = uuid()
    await pool.query(
      `INSERT INTO attendance_result_operations
         (org_id, entrypoint, operation_id, identity_source_kind, source_root_id, source_ref, actor_id,
          actor_posture, capability, subject_scope, command_fingerprint, accepted_write_posture, state, response_snapshot)
       VALUES ($1, 'request_decision', $2::uuid, 'verified_delivery', $2::uuid, 'v:e2', 'actor-e2',
               'approval_system', 'approval_apply', '{}'::jsonb, $3, 'shadow', 'completed', '{"ok":true}'::jsonb)`,
      [org, ledgerId, HEX64_B],
    )

    // Reload EXACTLY as a worker would (`proof_work_date::text` — never a JS Date).
    const reload = await pool.query(
      `SELECT org_id AS "orgId", entrypoint,
              CASE WHEN batch_command_id IS NULL AND identity_source_kind IN ('import_batch','integration_batch')
                   THEN 'batch' ELSE 'item' END AS kind,
              operation_id::text AS "operationId", accepted_write_posture AS "acceptedWritePosture",
              identity_source_kind AS "identitySourceKind", source_root_id::text AS "sourceRootId",
              input_ordinal AS "inputOrdinal", proof_semantic_fingerprint AS "proofSemanticFingerprint",
              proof_user_id::text AS "proofUserId", proof_work_date::text AS "proofWorkDate"
         FROM attendance_result_operations WHERE org_id = $1 ORDER BY created_at`,
      [org],
    )
    expect(reload.rows).toHaveLength(3)
    for (const row of reload.rows) {
      const identity = rehydrateVerifiedAttendanceOperationIdentityV1(row)
      expect(identity.id).toBe((row as { operationId: string }).operationId)
      // The rehydrated witness is builder-grade (real advisory key on a real txn).
      await withClient(async (client) => {
        await acquireAttendanceResultOperationLocks(trx(client), [identity])
      })
    }

    // Queue-corruption drift matrix: each mutated reload fails BEFORE any builder use.
    const importRow = reload.rows.find(
      (row: { identitySourceKind: string }) => row.identitySourceKind === 'import_item',
    ) as unknown as AttendanceOperationIdentityDurableRowV1
    const scheduledRow = reload.rows.find(
      (row: { identitySourceKind: string }) => row.identitySourceKind === 'scheduled',
    ) as unknown as AttendanceOperationIdentityDurableRowV1
    const ledgerRow = reload.rows.find(
      (row: { identitySourceKind: string }) => row.identitySourceKind === 'verified_delivery',
    ) as unknown as AttendanceOperationIdentityDurableRowV1

    const drifted: Array<[string, AttendanceOperationIdentityDurableRowV1, string]> = [
      ['operation-ID swap', { ...importRow, operationId: uuid() }, 'W4C0_IDENTITY_PROOF_DRIFT'],
      ['ordinal drift', { ...importRow, inputOrdinal: 1 }, 'W4C0_IDENTITY_PROOF_DRIFT'],
      ['fingerprint drift', { ...importRow, proofSemanticFingerprint: HEX64_B }, 'W4C0_IDENTITY_PROOF_DRIFT'],
      ['root drift', { ...importRow, sourceRootId: uuid() }, 'W4C0_IDENTITY_PROOF_DRIFT'],
      ['work-date drift', { ...scheduledRow, proofWorkDate: '2026-03-06' }, 'W4C0_IDENTITY_PROOF_DRIFT'],
      ['user drift', { ...scheduledRow, proofUserId: uuid() }, 'W4C0_IDENTITY_PROOF_DRIFT'],
      ['ledger root != id', { ...ledgerRow, sourceRootId: uuid() }, 'W4C0_IDENTITY_PROOF_DRIFT'],
      ['extra proof field', { ...importRow, proofUserId: uuid() }, 'W4C0_PROOF_SHAPE_INVALID'],
      ['missing proof field', { ...importRow, proofSemanticFingerprint: null }, 'W4C0_PROOF_SHAPE_INVALID'],
      [
        'JS Date instead of canonical date text',
        { ...scheduledRow, proofWorkDate: new Date('2026-03-05') as unknown as string },
        'W4C0_WORK_DATE_INVALID',
      ],
    ]
    for (const [label, row, expected] of drifted) {
      expect(codeOf(() => rehydrateVerifiedAttendanceOperationIdentityV1(row)), label).toBe(expected)
    }
    // Missing/extra KEY (not just null value) also fails the exact-key row contract.
    const missingKey = { ...importRow } as Record<string, unknown>
    delete missingKey.proofWorkDate
    expect(codeOf(() => rehydrateVerifiedAttendanceOperationIdentityV1(missingKey))).toBe('W4C0_DURABLE_ROW_INVALID')
    expect(
      codeOf(() => rehydrateVerifiedAttendanceOperationIdentityV1({ ...importRow, verified: true })),
    ).toBe('W4C0_DURABLE_ROW_INVALID')

    // P07 vector reload: every entry re-derives through the factory from the job's
    // canonical root (amendment 1.3 worker-reload obligation).
    const jobBatch = uuid()
    await pool.query(
      `INSERT INTO attendance_import_jobs
         (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
          w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
          w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
          w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
       SELECT $1, $2::uuid, 'actor-e2', 'queued', '{}'::jsonb, 1, 'import_batch', $2::uuid, 'import_batch',
              'b:e2', 'actor-e2', 'delegated_import', $3, 'shadow', 2, $3, $3,
              jsonb_build_array(
                jsonb_build_object('ordinal', 0, 'semanticFingerprint', $4::text,
                  'derivedOperationId', attendance_w4_uuidv5($6::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $4))::text,
                  'commandFingerprint', $3::text),
                jsonb_build_object('ordinal', 1, 'semanticFingerprint', $5::text,
                  'derivedOperationId', attendance_w4_uuidv5($6::uuid, attendance_w4_item_name_bytes($2::uuid, 1, $5))::text,
                  'commandFingerprint', $3::text))`,
      [org, jobBatch, HEX64_B, HEX64_A, HEX64_B, IMPORT_NS],
    )
    const jobReload = await pool.query(
      `SELECT w4_batch_command_id::text AS root, w4_accepted_write_posture AS posture,
              w4_identity_proof_vector AS vector
         FROM attendance_import_jobs WHERE org_id = $1 AND w4_batch_command_id = $2::uuid`,
      [org, jobBatch],
    )
    const vector = jobReload.rows[0].vector as Array<{
      ordinal: number
      semanticFingerprint: string
      derivedOperationId: string
      commandFingerprint: string
    }>
    expect(vector).toHaveLength(2)
    vector.forEach((entry, index) => {
      expect(entry.ordinal).toBe(index)
      const identity = rehydrateVerifiedAttendanceOperationIdentityV1({
        orgId: org,
        entrypoint: 'import_batch',
        kind: 'item',
        operationId: entry.derivedOperationId,
        acceptedWritePosture: jobReload.rows[0].posture as string,
        identitySourceKind: 'import_item',
        sourceRootId: jobReload.rows[0].root as string,
        inputOrdinal: entry.ordinal,
        proofSemanticFingerprint: entry.semanticFingerprint,
        proofUserId: null,
        proofWorkDate: null,
      })
      expect(identity.id).toBe(entry.derivedOperationId)
    })
    // A tampered vector entry cannot re-derive: swapping the two fingerprints flips
    // the factory result away from the stored derivedOperationId.
    expect(
      codeOf(() =>
        rehydrateVerifiedAttendanceOperationIdentityV1({
          orgId: org,
          entrypoint: 'import_batch',
          kind: 'item',
          operationId: vector[0].derivedOperationId,
          acceptedWritePosture: 'shadow',
          identitySourceKind: 'import_item',
          sourceRootId: jobReload.rows[0].root as string,
          inputOrdinal: 0,
          proofSemanticFingerprint: vector[1].semanticFingerprint,
          proofUserId: null,
          proofWorkDate: null,
        }),
      ),
    ).toBe('W4C0_IDENTITY_PROOF_DRIFT')
  })

  // =========================================================================
  // Gate 6 — pinned SQL namespace goldens (TS goldens live in the unit file).
  // =========================================================================

  it('gate 6: the three pinned namespace UUIDv5 goldens reproduce through the SQL boundary function', async () => {
    const legs: Array<[string, string, unknown[], string]> = [
      [
        'import',
        'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
        [IMPORT_NS, IMPORT_ROOT, FP_A],
        GOLDEN_IMPORT_ITEM_UUID,
      ],
      [
        'integration',
        'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 7, $3))::text AS v',
        [INTEGRATION_NS, INTEGRATION_ROOT, FP_B],
        GOLDEN_INTEGRATION_ITEM_UUID,
      ],
      [
        'scheduled',
        'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, $4::date))::text AS v',
        [SCHEDULED_NS, SCHED_RUN, SCHED_USER, SCHED_DATE],
        GOLDEN_SCHEDULED_UUID,
      ],
    ]
    for (const [label, sqlText, params, golden] of legs) {
      const { rows } = await pool.query(sqlText, params)
      expect(rows[0].v, label).toBe(golden)
    }
  })

  // =========================================================================
  // Gate 7 — migration rejects unknown kinds / illegal scalar combinations.
  // =========================================================================

  it('gate 7: unknown source kinds and every illegal scalar proof-field combination fail at the DB boundary', async () => {
    const org = uuid()
    const insertOp = (columnsSql: string, params: unknown[]) =>
      pool.query(
        `INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, identity_source_kind, source_root_id, input_ordinal,
            proof_semantic_fingerprint, proof_user_id, proof_work_date, source_ref, actor_id, actor_posture,
            capability, subject_scope, command_fingerprint, accepted_write_posture, state, response_snapshot)
         VALUES (${columnsSql})`,
        params,
      )
    const tail = `'x:e2', 'actor-e2', 'self', 'punch', '{}'::jsonb, $1, 'shadow', 'completed', '{"ok":true}'::jsonb`

    // Unknown source kind. An unlisted kind violates BOTH the closed source-kind enum
    // and the closed pairing CHECK by construction; Postgres reports whichever it
    // evaluates first, so both names are accepted here.
    await expect(
      insertOp(`$2, 'live_punch', $3::uuid, 'unknown_source', NULL, NULL, NULL, NULL, NULL, ${tail}`, [HEX64_A, org, uuid()]),
    ).rejects.toThrow(/chk_aro_source_kind|chk_aro_entrypoint_source_pair/)
    // Wrong entrypoint for the source kind.
    await expect(
      insertOp(`$2, 'scheduled', $3::uuid, 'direct_live_punch', NULL, NULL, NULL, NULL, NULL, ${tail}`, [HEX64_A, org, uuid()]),
    ).rejects.toThrow(/chk_aro_entrypoint_source_pair/)
    // Direct source with an extra proof scalar.
    await expect(
      insertOp(`$2, 'live_punch', $3::uuid, 'direct_live_punch', $4::uuid, NULL, NULL, NULL, NULL, ${tail}`, [HEX64_A, org, uuid(), uuid()]),
    ).rejects.toThrow(/chk_aro_proof_shape/)
    // Scheduled missing its user scalar.
    await expect(
      insertOp(`$2, 'scheduled', $3::uuid, 'scheduled', $4::uuid, NULL, NULL, NULL, '2026-03-05', ${tail}`, [HEX64_A, org, uuid(), uuid()]),
    ).rejects.toThrow(/chk_aro_proof_shape/)
    // Import item missing its ordinal (batchless variant also violates the shape).
    // Bespoke insert carrying the business snapshot so ONLY the proof shape can fail.
    await expect(
      pool.query(
        `INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, identity_source_kind, source_root_id, input_ordinal,
            proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability, subject_scope,
            command_fingerprint, accepted_write_posture, state, normalized_business_input_snapshot, response_snapshot)
         VALUES ($2, 'import_batch', $3::uuid, 'import_item', $4::uuid, NULL, $5, 'x:e2', 'actor-e2', 'self',
                 'punch', '{}'::jsonb, $1, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
        [HEX64_A, org, uuid(), uuid(), HEX64_A],
      ),
    ).rejects.toThrow(/chk_aro_proof_shape/)
    // Scheduled with a smuggled ordinal — the operation ID is CORRECTLY derived so
    // the derived-identity CHECK passes and only the exact proof shape can fail.
    const smuggleRoot = uuid()
    const smuggleUser = uuid()
    const smuggleId = (
      await pool.query(
        "SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_scheduled_name_bytes($2::uuid, $3::uuid, '2026-03-05'::date))::text AS v",
        [SCHEDULED_NS, smuggleRoot, smuggleUser],
      )
    ).rows[0].v as string
    await expect(
      insertOp(`$2, 'scheduled', $3::uuid, 'scheduled', $4::uuid, 3, NULL, $5::uuid, '2026-03-05', ${tail}`, [
        HEX64_A,
        org,
        smuggleId,
        smuggleRoot,
        smuggleUser,
      ]),
    ).rejects.toThrow(/chk_aro_proof_shape/)
    // Verified delivery whose root differs from the operation ID.
    await expect(
      insertOp(`$2, 'request_decision', $3::uuid, 'verified_delivery', $4::uuid, NULL, NULL, NULL, NULL, ${tail}`, [HEX64_A, org, uuid(), uuid()]),
    ).rejects.toThrow(/chk_aro_proof_shape/)
    // Nothing persisted.
    const rows = await pool.query('SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1', [org])
    expect(rows.rows[0].n).toBe(0)
  })

  // =========================================================================
  // Gate 8 — pre-lock/post-lock input isolation.
  // =========================================================================

  it('gate 8: rollout helper re-validates the lexical parser; operation helper rejects pre-lock candidates; post-lock factory demands the resolver witness bound to the SAME org key; uppercase UUIDs canonicalize', async () => {
    // Rollout helper: raw non-canonical strings never reach SQL.
    await withClient(async (client) => {
      let issued = 0
      const countingTrx: AttendanceW4TransactionClientV1 = {
        query: (sqlText, params) => {
          issued += 1
          return trx(client).query(sqlText, params)
        },
      }
      for (const bad of ['Default', ' default', 'default\n', '{55555555-5555-4555-8555-555555555555}', 'urn:uuid:' + ORG_SHADOW]) {
        const code = await codeOfAsync(() =>
          acquireAttendanceCalculationRolloutLock(
            countingTrx,
            bad as unknown as ReturnType<typeof parseCanonicalAttendanceRolloutOrgKeyV1>,
            'shared',
          ),
        )
        expect(code, bad).toBe('W4C0_ROLLOUT_ORG_KEY_INVALID')
        expect(issued, bad).toBe(0)
      }
      // Uppercase UUID canonicalizes to the SAME advisory key as lowercase.
      const lower = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_SHADOW)
      const upper = parseCanonicalAttendanceRolloutOrgKeyV1(ORG_SHADOW.toUpperCase())
      expect(upper).toBe(lower)
      expect(buildAttendanceCalculationRolloutAdvisoryKey(upper)).toBe(
        buildAttendanceCalculationRolloutAdvisoryKey(lower),
      )
    })

    await withClient(async (client) => {
      const posture = await resolveSegmentCalculationPosture(trx(client), ORG_SHADOW)
      // Post-lock factory: a plain object shaped like the posture witness is refused.
      expect(
        codeOf(() =>
          createVerifiedAttendanceOrgIdentityV1({
            orgKey: ORG_SHADOW,
            posture: { ...(posture as object) },
          }),
        ),
      ).toBe('W4C0_POSTURE_WITNESS_REQUIRED')
      // The SAME org key must accompany the witness (changed key rejected).
      expect(codeOf(() => createVerifiedAttendanceOrgIdentityV1({ orgKey: uuid(), posture }))).toBe(
        'W4C0_ORG_KEY_CHANGED',
      )
      // The literal `default` never infers a legacy posture from its bytes: with a
      // SHADOW resolver witness it is the changed-key door that fires — posture always
      // comes from resolution, never from the org-key literal.
      expect(codeOf(() => createVerifiedAttendanceOrgIdentityV1({ orgKey: 'default', posture }))).toBe(
        'W4C0_ORG_KEY_CHANGED',
      )

      const org = createVerifiedAttendanceOrgIdentityV1({ orgKey: ORG_SHADOW, posture })
      // Pre-lock candidate output confers NO authority: the acquisition helper and the
      // key builder both reject it (only the factory witness is admitted).
      const candidate = deriveAttendanceOperationCandidateIdentityV1({
        sourceKind: 'direct_live_punch',
        clientOperationId: uuid(),
      })
      expect(codeOf(() => buildAttendanceResultOperationAdvisoryKey(candidate as never))).toBe(
        'W4C0_OPERATION_WITNESS_REQUIRED',
      )
      let issued = 0
      const countingTrx: AttendanceW4TransactionClientV1 = {
        query: (sqlText, params) => {
          issued += 1
          return trx(client).query(sqlText, params)
        },
      }
      const code = await codeOfAsync(() => acquireAttendanceResultOperationLocks(countingTrx, [candidate as never]))
      expect(code).toBe('W4C0_OPERATION_WITNESS_REQUIRED')
      expect(issued).toBe(0)

      // Uppercase direct UUID input canonicalizes to the identical identity + key.
      const clientId = uuid()
      const lowerIdentity = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'live_punch',
        source: { sourceKind: 'direct_live_punch', clientOperationId: clientId },
      })
      const upperIdentity = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'live_punch',
        source: { sourceKind: 'direct_live_punch', clientOperationId: clientId.toUpperCase() },
      })
      expect(upperIdentity.id).toBe(lowerIdentity.id)
      expect(buildAttendanceResultOperationAdvisoryKey(upperIdentity)).toBe(
        buildAttendanceResultOperationAdvisoryKey(lowerIdentity),
      )
    })
  })

  it('this suite is DB-excluded from the no-DB run and explicitly named in CI (two-point wiring)', () => {
    const repoRoot = path.resolve(__dirname, '../../../..')
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    const vitestConfig = fs.readFileSync(path.join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
    expect(workflow).toContain('tests/integration/attendance-w4c0-identity-gates-e2.db.test.ts')
    expect(vitestConfig).toContain('tests/integration/attendance-w4c0-identity-gates-e2.db.test.ts')
  })
})
