import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c3aUp } from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'
import {
  type LegacyImportItemDraftV1,
  type LegacyImportRecordWriteDraftV1,
} from '../../src/attendance/w4c3a-legacy-plan-enqueue'
import { reserveAttendanceLegacyImportPlanJobV1 } from '../../src/attendance/w4c3a-legacy-plan-enqueue'
import {
  ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
  ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'
import {
  computeAttendanceItemSequenceFingerprintV1,
  computeAttendanceItemSetFingerprintV1,
} from '../../src/attendance/w4c0-fingerprints'
import {
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  buildAttendanceOperationalBulkTargetAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOrgIdentityV1,
} from '../../src/attendance/w4c0-identity'
import { createAuthorizedAttendanceWriteContextV1 } from '../../src/attendance/w4c0-authorization'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const ORG = crypto.randomUUID()
const POSTURE_ORG = crypto.randomUUID()
const ADMIN_A = `w4c3a-admin-a-${run}`
const ADMIN_B = `w4c3a-admin-b-${run}`
const TARGET_USER = crypto.randomUUID()
const SOURCE_REF = `w4c3a-source-${run}`
const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const HEX_C = 'c'.repeat(64)
const HEX_D = 'd'.repeat(64)

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) =>
      client.query(text, values as unknown[]) as unknown as Promise<{
        rows: Array<Record<string, unknown>>
      }>,
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code)
  }
  return String((error as Error).message)
}

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true,
      activation_status text NOT NULL DEFAULT 'activated'
    )`)
  await pool.query(`
    CREATE TABLE user_orgs (
      user_id text NOT NULL, org_id text NOT NULL, is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, org_id)
    )`)
  await pool.query(`
    CREATE TABLE user_permissions (
      user_id text NOT NULL, permission_code text NOT NULL,
      PRIMARY KEY (user_id, permission_code)
    )`)
  await pool.query(`
    CREATE TABLE user_roles (
      user_id text NOT NULL, role_id text NOT NULL, PRIMARY KEY (user_id, role_id)
    )`)
  await pool.query(`
    CREATE TABLE role_permissions (
      role_id text NOT NULL, permission_code text NOT NULL,
      PRIMARY KEY (role_id, permission_code)
    )`)
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', is_workday boolean,
      meta jsonb, source_batch_id uuid, org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, batch_id uuid NOT NULL,
      created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, finished_at timestamptz
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, idempotency_key text,
      status text NOT NULL, row_count integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, org_id text NOT NULL,
      record_id uuid
    )`)
  await pool.query(`
    CREATE TABLE attendance_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, name text NOT NULL,
      code text, timezone text NOT NULL DEFAULT 'UTC', rule_set_id text
    )`)
  await pool.query(`
    CREATE TABLE attendance_group_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL,
      group_id uuid NOT NULL, user_id text NOT NULL
    )`)
}

function normalBatch(idempotencyKey: string | null, sourceRowCount: number) {
  return {
    kind: 'normal' as const,
    source: 'manual',
    ruleSetId: null,
    mappingSnapshot: {},
    sourceRowCount,
    status: 'committed',
    idempotencyKey,
    visibilityRule: 'org',
    engine: 'standard',
    chunkConfig: { itemsChunkSize: 100, recordsChunkSize: 100 },
    recordUpsertStrategy: 'unnest',
    itemsInsertStrategy: 'unnest',
    mappingProfileId: null,
    compatibilityMetadata: {},
    groupSync: null,
    itemReturnPolicy: { returnItems: false },
    skippedSamplePolicy: { limit: 50 },
    resultSlots: {},
  }
}

async function loadOrgWitness(pool: Pool, orgId: string): Promise<VerifiedAttendanceOrgIdentityV1> {
  const posture = await resolveSegmentCalculationPosture(trx(pool as unknown as PoolClient), orgId)
  return createVerifiedAttendanceOrgIdentityV1({ orgKey: orgId, posture })
}

function auth(actorId: string, orgId: string) {
  return createAuthorizedAttendanceWriteContextV1({
    actorId,
    actorPosture: 'platform_admin',
    tokenSubjectUserId: actorId,
    orgId,
    subjectScope: { kind: 'self', userId: actorId },
    capability: 'import',
    sourceRef: SOURCE_REF,
  })
}

function noTargetInput(
  org: VerifiedAttendanceOrgIdentityV1,
  batchId: string,
  actorId: string,
  createdBy: string,
  idempotencyKey: string | null = null,
  commandFingerprint = HEX_A,
  legacyInputFingerprint = HEX_B,
) {
  const items: readonly LegacyImportItemDraftV1[] = [
    {
      kind: 'skip', ordinal: 0, semanticOrdinal: null, resolvedUserId: null,
      resolvedWorkDate: null, reasonCode: 'validation', warnings: [], previewSnapshot: {},
    },
    {
      kind: 'skip', ordinal: 1, semanticOrdinal: null, resolvedUserId: null,
      resolvedWorkDate: null, reasonCode: 'duplicate', warnings: [], previewSnapshot: {},
    },
  ]
  const batch = normalBatch(idempotencyKey, items.length)
  const identity = createVerifiedAttendanceOperationIdentityV1({
    org, kind: 'batch', entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: batchId },
  })
  const input = {
    batchIdentity: identity,
    itemIdentities: [],
    job: {
      orgId: org.orgId, batchId, createdBy, idempotencyKey, total: items.length,
      payload: {
        __jobType: 'commit', idempotencyKey, __importEngine: 'standard',
        recordUpsertStrategy: 'unnest', itemsInsertStrategy: 'unnest', __w4ContractVersion: 1,
      },
      w4Entrypoint: 'import_batch' as const, w4BatchCommandId: batchId,
      w4SourceKind: 'import_batch' as const, w4SourceRef: SOURCE_REF,
      w4ActorId: actorId, w4ActorPosture: 'platform_admin', w4TokenSubjectUserId: actorId,
      w4CommandFingerprint: commandFingerprint, w4AcceptedWritePosture: org.acceptedWritePosture,
      w4ItemCount: 0, w4ItemSequenceFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
      w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1, w4IdentityProofVector: [],
      w4DistinctTargetCount: 0, w4OperationalBranch: 'operational_only_no_target' as const,
      w4LegacyInputFingerprint: legacyInputFingerprint,
    },
    manifestSeed: {
      schemaVersion: 1 as const,
      orgId: org.orgId, batchId, sourceKind: 'import_batch' as const, sourceRef: SOURCE_REF,
      createdBy, actorId, actorPosture: 'platform_admin', tokenSubjectUserId: actorId,
      acceptedWritePosture: org.acceptedWritePosture, commandFingerprint, legacyInputFingerprint,
      operationalBranch: 'operational_only_no_target' as const, legacyRowSourceKind: 'direct_rows' as const,
      sourceRowCount: items.length, w4ItemCount: 0, w4DistinctTargetCount: 0,
      w4ItemSequenceFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1,
      w4ItemSetFingerprint: ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1, legacySourceRowLimit: null,
      batch, artifactCleanup: { kind: 'none' as const },
    },
    items, recordWrites: [], groupEffects: [],
  }
  return { input, identity }
}

function strictInput(org: VerifiedAttendanceOrgIdentityV1, batchId: string, actorId: string) {
  const semanticFingerprint = HEX_C
  const commandFingerprint = HEX_D
  const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
    org, kind: 'batch', entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: batchId },
  })
  const itemIdentity = createVerifiedAttendanceOperationIdentityV1({
    org, kind: 'item', entrypoint: 'import_batch',
    source: { sourceKind: 'import_item', batchCommandId: batchId, ordinal: 0, semanticFingerprint },
  })
  const fingerprints = [{ ordinal: '0', operationId: itemIdentity.id, commandFingerprint }]
  const recordWrite: LegacyImportRecordWriteDraftV1 = {
    orgId: org.orgId, userId: TARGET_USER, workDate: '2026-07-30', sourceOrdinals: [0],
    mergeMode: 'merge', firstInAt: '2026-07-30T01:00:00.000Z', lastOutAt: '2026-07-30T09:00:00.000Z',
    workMinutes: 480, lateMinutes: 0, earlyLeaveMinutes: 0, status: 'normal', isWorkday: true,
    compatibilityMetadata: {}, policySnapshot: {}, profileSnapshot: {}, multiPunchSnapshot: {},
    attributionSnapshot: {}, sourceBatchId: batchId, resultSlots: {},
  }
  const item: LegacyImportItemDraftV1 = {
    kind: 'apply', ordinal: 0, semanticOrdinal: 0,
    targetRef: JSON.stringify([org.orgId, TARGET_USER, '2026-07-30']),
    previewSnapshot: { status: 'normal' },
  }
  const batch = normalBatch(null, 1)
  const proofVector = [{ ordinal: 0, semanticFingerprint, derivedOperationId: itemIdentity.id, commandFingerprint }]
  const input = {
    batchIdentity, itemIdentities: [{ identity: itemIdentity, commandFingerprint }],
    job: {
      orgId: org.orgId, batchId, createdBy: actorId, idempotencyKey: null, total: 1,
      payload: { __jobType: 'commit', idempotencyKey: null, __importEngine: 'standard', recordUpsertStrategy: 'unnest', itemsInsertStrategy: 'unnest', __w4ContractVersion: 1 },
      w4Entrypoint: 'import_batch' as const, w4BatchCommandId: batchId, w4SourceKind: 'import_batch' as const,
      w4SourceRef: SOURCE_REF, w4ActorId: actorId, w4ActorPosture: 'platform_admin', w4TokenSubjectUserId: actorId,
      w4CommandFingerprint: commandFingerprint, w4AcceptedWritePosture: org.acceptedWritePosture,
      w4ItemCount: 1, w4ItemSequenceFingerprint: computeAttendanceItemSequenceFingerprintV1(fingerprints),
      w4ItemSetFingerprint: computeAttendanceItemSetFingerprintV1(fingerprints), w4IdentityProofVector: proofVector,
      w4DistinctTargetCount: 1, w4OperationalBranch: 'strict_targeted' as const, w4LegacyInputFingerprint: HEX_A,
    },
    manifestSeed: {
      schemaVersion: 1 as const,
      orgId: org.orgId, batchId, sourceKind: 'import_batch' as const, sourceRef: SOURCE_REF, createdBy: actorId,
      actorId, actorPosture: 'platform_admin', tokenSubjectUserId: actorId, acceptedWritePosture: org.acceptedWritePosture,
      commandFingerprint, legacyInputFingerprint: HEX_A, operationalBranch: 'strict_targeted' as const,
      legacyRowSourceKind: 'direct_rows' as const, sourceRowCount: 1, w4ItemCount: 1, w4DistinctTargetCount: 1,
      w4ItemSequenceFingerprint: computeAttendanceItemSequenceFingerprintV1(fingerprints),
      w4ItemSetFingerprint: computeAttendanceItemSetFingerprintV1(fingerprints), legacySourceRowLimit: null,
      batch, artifactCleanup: { kind: 'none' as const },
    },
    items: [item], recordWrites: [recordWrite], groupEffects: [],
  }
  return { input, batchIdentity }
}

async function runSerializable<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function residue(pool: Pool, batchId: string): Promise<{ jobs: number; manifests: number; chunks: number }> {
  const jobs = await pool.query('SELECT count(*)::int AS n FROM attendance_import_jobs WHERE batch_id = $1', [batchId])
  const manifests = await pool.query(`
    SELECT count(*)::int AS n FROM attendance_import_legacy_execution_plans p
    WHERE p.batch_id = $1`, [batchId])
  const chunks = await pool.query(`
    SELECT count(*)::int AS n FROM attendance_import_legacy_execution_plan_chunks c
    JOIN attendance_import_legacy_execution_plans p ON p.job_id = c.job_id
    WHERE p.batch_id = $1`, [batchId])
  return { jobs: jobs.rows[0].n, manifests: manifests.rows[0].n, chunks: chunks.rows[0].n }
}

describeIfDatabase('W4C-3a enqueue foundation (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_enqueue_${run}`
  let adminPool: Pool
  let pool: Pool
  let migrationPool: Pool
  let db: Kysely<unknown>
  let legacyOrgWitness: VerifiedAttendanceOrgIdentityV1
  const priorAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString() })
    migrationPool = new Pool({ connectionString: scratchUrl.toString() })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
    await createBase(pool)
    await w4c0Up(db)
    await w4c3aUp(db)
    await pool.query(
      `INSERT INTO users (id) VALUES ($1), ($2), ($3)`,
      [ADMIN_A, ADMIN_B, TARGET_USER],
    )
    for (const orgId of [ORG, POSTURE_ORG]) {
      await pool.query(
        `INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2), ($3, $2), ($4, $2)`,
        [ADMIN_A, orgId, ADMIN_B, TARGET_USER],
      )
    }
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES
       ($1, 'attendance:import'), ($2, 'attendance:import')`,
      [ADMIN_A, ADMIN_B],
    )
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = POSTURE_ORG
    legacyOrgWitness = await loadOrgWitness(pool, ORG)
  }, 90000)

  afterAll(async () => {
    if (priorAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlist
    await db?.destroy()
    await pool?.end()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end()
  })

  it('commits a valid no-target all-skip job, manifest, and chunk atomically', async () => {
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    const result = await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), input),
    )
    expect(result.kind).toBe('created')
    const rows = await pool.query(
      `SELECT j.status, j.total, j.w4_operational_branch, j.w4_item_count,
              p.chunk_count, count(c.job_id)::int AS chunks,
              jsonb_array_length(c.chunk->'items')::int AS source_items
         FROM attendance_import_jobs j
         JOIN attendance_import_legacy_execution_plans p ON p.job_id = j.id
         JOIN attendance_import_legacy_execution_plan_chunks c ON c.job_id = j.id
        WHERE j.batch_id = $1
        GROUP BY j.status, j.total, j.w4_operational_branch, j.w4_item_count, p.chunk_count, c.chunk` ,
      [batchId],
    )
    expect(rows.rows).toEqual([{ status: 'queued', total: 2, w4_operational_branch: 'operational_only_no_target', w4_item_count: 0, chunk_count: 1, chunks: 1, source_items: 2 }])
  })

  it('persists exact transient fingerprints for a 5001-item operational batch and rejects one-hex mutations before persistence', async () => {
    const buildInput = (batchId: string) => {
      const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
        org: legacyOrgWitness,
        kind: 'batch',
        entrypoint: 'import_batch',
        source: { sourceKind: 'import_batch', batchCommandId: batchId },
      })
      const itemIdentities: Array<{ identity: unknown; commandFingerprint: string }> = []
      const items: LegacyImportItemDraftV1[] = []
      const recordWrites: LegacyImportRecordWriteDraftV1[] = []
      const fingerprintEntries: Array<{ ordinal: string; operationId: string; commandFingerprint: string }> = []
      for (let ordinal = 0; ordinal < 5001; ordinal += 1) {
        const userId = crypto.randomUUID()
        const workDate = `2027-01-${String((ordinal % 28) + 1).padStart(2, '0')}`
        const semanticFingerprint = crypto
          .createHash('sha256')
          .update(`w4c3a-operational-semantic:${ordinal}`, 'utf8')
          .digest('hex')
        const identity = createVerifiedAttendanceOperationIdentityV1({
          org: legacyOrgWitness,
          kind: 'item',
          entrypoint: 'import_batch',
          source: {
            sourceKind: 'import_item',
            batchCommandId: batchId,
            ordinal,
            semanticFingerprint,
          },
        })
        itemIdentities.push({ identity, commandFingerprint: HEX_C })
        fingerprintEntries.push({
          ordinal: String(ordinal),
          operationId: identity.id,
          commandFingerprint: HEX_C,
        })
        const targetRef = JSON.stringify([legacyOrgWitness.orgId, userId, workDate])
        items.push({ kind: 'apply', ordinal, semanticOrdinal: ordinal, targetRef, previewSnapshot: {} })
        recordWrites.push({
          orgId: legacyOrgWitness.orgId,
          userId,
          workDate,
          sourceOrdinals: [ordinal],
          mergeMode: 'merge',
          firstInAt: null,
          lastOutAt: null,
          workMinutes: 0,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          status: 'normal',
          isWorkday: true,
          compatibilityMetadata: {},
          policySnapshot: {},
          profileSnapshot: {},
          multiPunchSnapshot: {},
          attributionSnapshot: {},
          sourceBatchId: batchId,
          resultSlots: {},
        })
      }
      const sequenceFingerprint = computeAttendanceItemSequenceFingerprintV1(fingerprintEntries)
      const setFingerprint = computeAttendanceItemSetFingerprintV1(fingerprintEntries)
      const batch = normalBatch(null, 5001)
      return {
        input: {
          batchIdentity,
          itemIdentities,
          job: {
            orgId: ORG, batchId, createdBy: ADMIN_A, idempotencyKey: null, total: 5001,
            payload: {
              __jobType: 'commit', idempotencyKey: null, __importEngine: 'standard',
              recordUpsertStrategy: 'unnest', itemsInsertStrategy: 'unnest', __w4ContractVersion: 1,
            },
            w4Entrypoint: 'import_batch' as const, w4BatchCommandId: batchId, w4SourceKind: 'import_batch' as const,
            w4SourceRef: SOURCE_REF, w4ActorId: ADMIN_A, w4ActorPosture: 'platform_admin', w4TokenSubjectUserId: ADMIN_A,
            w4CommandFingerprint: HEX_A, w4AcceptedWritePosture: legacyOrgWitness.acceptedWritePosture,
            w4ItemCount: 5001, w4ItemSequenceFingerprint: sequenceFingerprint, w4ItemSetFingerprint: setFingerprint,
            w4IdentityProofVector: [], w4DistinctTargetCount: 5001,
            w4OperationalBranch: 'operational_only_batch_limit' as const, w4LegacyInputFingerprint: HEX_B,
          },
          manifestSeed: {
            schemaVersion: 1 as const, orgId: ORG, batchId, sourceKind: 'import_batch' as const, sourceRef: SOURCE_REF,
            createdBy: ADMIN_A, actorId: ADMIN_A, actorPosture: 'platform_admin', tokenSubjectUserId: ADMIN_A,
            acceptedWritePosture: legacyOrgWitness.acceptedWritePosture, commandFingerprint: HEX_A,
            legacyInputFingerprint: HEX_B, operationalBranch: 'operational_only_batch_limit' as const,
            legacyRowSourceKind: 'direct_rows' as const, sourceRowCount: 5001, w4ItemCount: 5001,
            w4DistinctTargetCount: 5001, w4ItemSequenceFingerprint: sequenceFingerprint,
            w4ItemSetFingerprint: setFingerprint, legacySourceRowLimit: null, batch,
            artifactCleanup: { kind: 'none' as const },
          },
          items,
          recordWrites,
          groupEffects: [],
        },
        sequenceFingerprint,
        setFingerprint,
      }
    }

    const invalidBatchId = crypto.randomUUID()
    const invalid = buildInput(invalidBatchId)
    const mutatedSequence = `${invalid.sequenceFingerprint[0] === 'a' ? 'b' : 'a'}${invalid.sequenceFingerprint.slice(1)}`
    const invalidInput = {
      ...invalid.input,
      job: { ...invalid.input.job, w4ItemSequenceFingerprint: mutatedSequence },
      manifestSeed: { ...invalid.input.manifestSeed, w4ItemSequenceFingerprint: mutatedSequence },
    }
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), invalidInput),
    )).rejects.toMatchObject({ code: 'W4C3A_ENQUEUE_ITEM_PROOF_MISMATCH' })
    expect(await residue(pool, invalidBatchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })

    const validBatchId = crypto.randomUUID()
    const valid = buildInput(validBatchId)
    const bulkKey = buildAttendanceOperationalBulkTargetAdvisoryKey(
      parseCanonicalAttendanceRolloutOrgKeyV1(ORG),
    )
    const keyParts = (key: bigint) => {
      const unsigned = BigInt.asUintN(64, key)
      return {
        classid: (unsigned >> 32n).toString(),
        objid: (unsigned & 0xffffffffn).toString(),
      }
    }
    const expectedBulkKey = keyParts(bulkKey)
    const created = await runSerializable(pool, async (client) => {
      const before = await client.query(
        `SELECT classid::text, objid::text, mode, granted
           FROM pg_locks
          WHERE pid = pg_backend_pid() AND locktype = 'advisory'`,
      )
      const result = await reserveAttendanceLegacyImportPlanJobV1(
        trx(client), auth(ADMIN_A, ORG), valid.input,
      )
      const after = await client.query(
        `SELECT classid::text, objid::text, mode, granted
           FROM pg_locks
          WHERE pid = pg_backend_pid() AND locktype = 'advisory'`,
      )
      const matchingBefore = before.rows.filter(
        (row) => row.classid === expectedBulkKey.classid && row.objid === expectedBulkKey.objid,
      )
      const matchingAfter = after.rows.filter(
        (row) => row.classid === expectedBulkKey.classid && row.objid === expectedBulkKey.objid,
      )
      expect(matchingBefore).toHaveLength(0)
      expect(matchingAfter).toHaveLength(1)
      expect(matchingAfter[0]).toMatchObject({ mode: 'ExclusiveLock', granted: true })
      return result
    })
    expect(created.kind).toBe('created')
    const persisted = await pool.query(
      `SELECT j.w4_item_count, j.w4_distinct_target_count, j.w4_operational_branch,
              j.w4_item_sequence_fingerprint AS job_sequence,
              j.w4_item_set_fingerprint AS job_set,
              j.w4_identity_proof_vector,
              p.source_row_count, p.chunk_count,
              p.w4_item_sequence_fingerprint AS manifest_sequence,
              p.w4_item_set_fingerprint AS manifest_set,
              count(c.chunk_index)::int AS persisted_chunks,
              coalesce(sum(jsonb_array_length(c.chunk->'items')), 0)::int AS persisted_items
         FROM attendance_import_jobs j
         JOIN attendance_import_legacy_execution_plans p ON p.job_id = j.id
         JOIN attendance_import_legacy_execution_plan_chunks c ON c.job_id = j.id
        WHERE j.batch_id = $1
        GROUP BY j.w4_item_count, j.w4_distinct_target_count, j.w4_operational_branch,
                 j.w4_item_sequence_fingerprint, j.w4_item_set_fingerprint,
                 j.w4_identity_proof_vector, p.source_row_count, p.chunk_count,
                 p.w4_item_sequence_fingerprint, p.w4_item_set_fingerprint`,
      [validBatchId],
    )
    expect(persisted.rows).toEqual([{
      w4_item_count: 5001,
      w4_distinct_target_count: 5001,
      w4_operational_branch: 'operational_only_batch_limit',
      job_sequence: valid.sequenceFingerprint,
      job_set: valid.setFingerprint,
      w4_identity_proof_vector: [],
      source_row_count: 5001,
      chunk_count: 11,
      manifest_sequence: valid.sequenceFingerprint,
      manifest_set: valid.setFingerprint,
      persisted_chunks: 11,
      persisted_items: 5001,
    }])
  })

  it('fails closed after authorization loss with zero job, manifest, or chunk rows', async () => {
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [ADMIN_A])
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), input),
    )).rejects.toMatchObject({ code: 'ATTENDANCE_WRITE_NOT_AUTHORIZED' })
    expect(await residue(pool, batchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })
    await pool.query(`UPDATE users SET is_active = true WHERE id = $1`, [ADMIN_A])
  })

  it('replays a completed route-idempotency job for a second authorized admin without createdBy equality', async () => {
    const batchId = crypto.randomUUID()
    const idempotencyKey = `idem-${run}`
    const first = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A, idempotencyKey)
    const created = await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), first.input),
    )
    if (created.kind !== 'created') throw new Error('expected first enqueue to create a job')
    await runSerializable(pool, async (client) => {
      await client.query(`UPDATE attendance_import_jobs SET status = 'completed', progress = total, finished_at = now() WHERE id = $1`, [created.jobId])
      await client.query(
        `INSERT INTO attendance_import_legacy_terminal_responses (job_id, org_id, response_variant, response_digest, response)
         VALUES ($1, $2, 'first_execution', $3, '{}'::jsonb)`,
        [created.jobId, ORG, HEX_C],
      )
    })
    const second = noTargetInput(legacyOrgWitness, batchId, ADMIN_B, ADMIN_B, idempotencyKey)
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_B, ORG), second.input),
    )).resolves.toMatchObject({ kind: 'existing', jobId: created.jobId, status: 'completed' })
    expect(await residue(pool, batchId)).toEqual({ jobs: 1, manifests: 1, chunks: 1 })
  })

  it('rejects conflicting private executor fields without adding a second job', async () => {
    const batchId = crypto.randomUUID()
    const first = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    await runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), first.input),
    )
    const conflicting = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A, null, HEX_D, HEX_B)
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), conflicting.input),
    )).rejects.toMatchObject({ code: 'W4C3A_ENQUEUE_JOB_RESERVATION_CONFLICT' })
    expect((await pool.query(`SELECT count(*)::int AS n FROM attendance_import_jobs WHERE batch_id = $1`, [batchId])).rows[0].n).toBe(1)
  })

  it('does not persist a strict plan from a stale snapshot after an intervening committed record change', async () => {
    const batchId = crypto.randomUUID()
    const recordId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_records (id, org_id, user_id, work_date, work_minutes, status, is_workday, meta)
       VALUES ($1, $2, $3, '2026-07-30', 480, 'normal', true, '{}'::jsonb)`,
      [recordId, ORG, TARGET_USER],
    )
    const { input } = strictInput(legacyOrgWitness, batchId, ADMIN_A)
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await client.query(`SELECT current_setting('transaction_isolation')`)
      await pool.query(`UPDATE attendance_records SET work_minutes = 481 WHERE id = $1`, [recordId])
      let failure: unknown
      try {
        await reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), input)
      } catch (error) {
        failure = error
      }
      expect(['40001', '40P01', 'W4C3A_ENQUEUE_RECORD_PRECONDITION_CHANGED']).toContain(errorCode(failure))
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    expect(await residue(pool, batchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })
    const revision = await pool.query(
      `SELECT revision::int FROM attendance_record_target_revisions WHERE org_id = $1 AND user_id = $2 AND work_date = '2026-07-30'`,
      [ORG, TARGET_USER],
    )
    expect(revision.rows[0].revision).toBe(2)
  })

  it('rolls back all enqueue residue when the caller rolls back after the three inserts', async () => {
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(legacyOrgWitness, batchId, ADMIN_A, ADMIN_A)
    await expect(runSerializable(pool, async (client) => {
      await reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, ORG), input)
      throw new Error('ROLLBACK_AFTER_ENQUEUE')
    })).rejects.toThrow('ROLLBACK_AFTER_ENQUEUE')
    expect(await residue(pool, batchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })
  })

  it('fails closed when the current rollout posture changes after the org witness was captured', async () => {
    const legacyPosture = await loadOrgWitness(pool, POSTURE_ORG)
    const batchId = crypto.randomUUID()
    const { input } = noTargetInput(legacyPosture, batchId, ADMIN_A, ADMIN_A)
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3a-test', 'TEST', $2, 1, NULL, 'synthetic_staging')`,
      [POSTURE_ORG, ADMIN_A],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = 'shadow', prior_state = 'legacy', version = 2 WHERE org_id = $1`,
      [POSTURE_ORG],
    )
    await expect(runSerializable(pool, (client) =>
      reserveAttendanceLegacyImportPlanJobV1(trx(client), auth(ADMIN_A, POSTURE_ORG), input),
    )).rejects.toMatchObject({ code: 'W4C3A_ENQUEUE_POSTURE_CHANGED' })
    expect(await residue(pool, batchId)).toEqual({ jobs: 0, manifests: 0, chunks: 0 })
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = 'legacy', prior_state = 'shadow', version = 3 WHERE org_id = $1`,
      [POSTURE_ORG],
    )
  })
})
