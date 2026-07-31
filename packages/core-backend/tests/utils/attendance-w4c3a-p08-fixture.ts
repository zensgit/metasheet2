/**
 * Test-only shared fixture for W4C-3a P08 candidate A/B.
 * Imported by the parent suite and by child processes (enqueue / execute).
 * Not a production module.
 */
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c3aUp } from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'
import {
  reserveAttendanceLegacyImportPlanJobV1,
  type LegacyImportGroupEffectDraftV1,
  type LegacyImportItemDraftV1,
  type LegacyImportRecordWriteDraftV1,
  type ReserveAttendanceLegacyImportPlanJobInputV1,
} from '../../src/attendance/w4c3a-legacy-plan-enqueue'
import {
  computeAttendanceItemSequenceFingerprintV1,
  computeAttendanceItemSetFingerprintV1,
} from '../../src/attendance/w4c0-fingerprints'
import {
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
  type VerifiedAttendanceOrgIdentityV1,
} from '../../src/attendance/w4c0-identity'
import { createAuthorizedAttendanceWriteContextV1 } from '../../src/attendance/w4c0-authorization'
import { createAttendanceLegacyPlanProcessorV1 } from '../../src/attendance/w4c3a-legacy-plan-processor'
import { rawImportEvidenceV1 } from './attendance-w4c3a-raw-evidence'

export const P08_HEX_A = 'a'.repeat(64)
export const P08_HEX_C = 'c'.repeat(64)
export const P08_HEX_D = 'd'.repeat(64)
export const P08_WORK_DATE = '2026-07-30'
export const P08_GROUP_NORMALIZED = 'p08 engineering'
export const P08_GROUP_DISPLAY = 'P08 Engineering'
export const P08_RECORD_TIMEZONE = 'Asia/Shanghai'
export const P08_WORK_MINUTES = 480

export type P08FixtureIds = Readonly<{
  orgId: string
  orgBId: string
  adminId: string
  targetUserId: string
  sourceRef: string
  batchId: string
}>

export type P08DeterministicProjection = Readonly<{
  status: string
  terminals: number
  batches: number
  items: number
  records: number
  groups: number
  members: number
  processedRows: number
  failedRows: number
  groupCreated: number
  groupMembersAdded: number
  recordTimezone: string
  workMinutes: number
  recordStatus: string
  itemUserId: string
  itemWorkDate: string
  groupNormalizedName: string
  batchEngine: string
  resultKind: string
}>

export function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) =>
      client.query(text, values as unknown[]) as unknown as Promise<{
        rows: Array<Record<string, unknown>>
      }>,
  }
}

export async function runSerializable<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

export async function createP08BaseSchema(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true,
      activation_status text NOT NULL DEFAULT 'activated',
      permissions jsonb NOT NULL DEFAULT '[]'::jsonb
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
    CREATE TABLE user_namespace_admissions (
      user_id text NOT NULL, namespace text NOT NULL, enabled boolean NOT NULL DEFAULT false,
      PRIMARY KEY (user_id, namespace)
    )`)
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', is_workday boolean,
      meta jsonb, source_batch_id uuid, org_id text NOT NULL, timezone text DEFAULT 'UTC',
      updated_at timestamptz DEFAULT now()
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
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, idempotency_key text,
      created_by text, source text, rule_set_id uuid, mapping jsonb DEFAULT '{}'::jsonb,
      status text NOT NULL, row_count integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, org_id text NOT NULL,
      user_id text, work_date date, record_id uuid, preview_snapshot jsonb, created_at timestamptz DEFAULT now(),
      FOREIGN KEY (batch_id) REFERENCES attendance_import_batches(id) ON DELETE CASCADE
    )`)
  await pool.query(`
    CREATE TABLE attendance_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, name text NOT NULL,
      code text, timezone text NOT NULL DEFAULT 'UTC', rule_set_id uuid, description text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      UNIQUE (org_id, name)
    )`)
  await pool.query(`
    CREATE TABLE attendance_group_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL,
      group_id uuid NOT NULL, user_id text NOT NULL,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      UNIQUE (org_id, group_id, user_id)
    )`)
  await pool.query(`
    CREATE TABLE attendance_rule_sets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE attendance_mapping_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL,
      mapping jsonb NOT NULL DEFAULT '{}'::jsonb
    )`)
}

export async function migrateP08Schema(connectionString: string): Promise<void> {
  const kyselyPool = new Pool({ connectionString })
  const db = new Kysely({ dialect: new PostgresDialect({ pool: kyselyPool }) })
  try {
    await w4c0Up(db)
    await w4c3aUp(db)
  } finally {
    // db.destroy() ends the underlying pool; do not call kyselyPool.end() again.
    await db.destroy()
  }
}

export async function seedP08ActorsAndConfig(
  pool: Pool,
  ids: P08FixtureIds,
): Promise<void> {
  for (const orgId of [ids.orgId, ids.orgBId]) {
    await pool.query(
      `INSERT INTO users (id, permissions) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [ids.adminId, JSON.stringify(['attendance:import', 'attendance:admin'])],
    )
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [ids.adminId, orgId],
    )
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [ids.adminId],
    )
    await pool.query(
      `INSERT INTO user_namespace_admissions (user_id, namespace, enabled)
       VALUES ($1, 'attendance', true) ON CONFLICT DO NOTHING`,
      [ids.adminId],
    )
    await pool.query(
      `INSERT INTO attendance_rule_sets (org_id, config) VALUES ($1, $2::jsonb)`,
      [orgId, JSON.stringify({ timezone: 'UTC', poisoned: false })],
    )
    await pool.query(
      `INSERT INTO attendance_mapping_profiles (org_id, mapping) VALUES ($1, $2::jsonb)`,
      [orgId, JSON.stringify({ profile: 'original' })],
    )
  }
}

export async function loadP08Org(
  pool: Pool,
  orgId: string,
): Promise<VerifiedAttendanceOrgIdentityV1> {
  const client = await pool.connect()
  try {
    const posture = await resolveSegmentCalculationPosture(trx(client), orgId)
    return createVerifiedAttendanceOrgIdentityV1({ orgKey: orgId, posture })
  } finally {
    client.release()
  }
}

/** Deterministic full first-execution plan input (apply+record+group+member). */
export function buildP08FullPlanInput(
  org: VerifiedAttendanceOrgIdentityV1,
  ids: P08FixtureIds,
): ReserveAttendanceLegacyImportPlanJobInputV1 {
  const semanticFingerprint = P08_HEX_C
  const commandFingerprint = P08_HEX_D
  const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'batch',
    entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: ids.batchId },
  })
  const itemIdentity = createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'item',
    entrypoint: 'import_batch',
    source: {
      sourceKind: 'import_item',
      batchCommandId: ids.batchId,
      ordinal: 0,
      semanticFingerprint,
    },
  })
  const fingerprints = [
    { ordinal: '0', operationId: itemIdentity.id, commandFingerprint },
  ]
  const recordWrite: LegacyImportRecordWriteDraftV1 = {
    orgId: org.orgId,
    userId: ids.targetUserId,
    workDate: P08_WORK_DATE,
    sourceOrdinals: [0],
    mergeMode: 'merge',
    firstInAt: '2026-07-30T01:00:00.000Z',
    lastOutAt: '2026-07-30T09:00:00.000Z',
    workMinutes: P08_WORK_MINUTES,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    status: 'normal',
    isWorkday: true,
    timezone: P08_RECORD_TIMEZONE,
    compatibilityMetadata: {},
    policySnapshot: {},
    profileSnapshot: {},
    multiPunchSnapshot: {},
    attributionSnapshot: {},
    sourceBatchId: ids.batchId,
    resultSlots: {},
  }
  const item: LegacyImportItemDraftV1 = {
    kind: 'apply',
    ordinal: 0,
    semanticOrdinal: 0,
    targetRef: JSON.stringify([org.orgId, ids.targetUserId, P08_WORK_DATE]),
    previewSnapshot: { status: 'normal' },
    rawEvidence: rawImportEvidenceV1(0, {
      userId: ids.targetUserId,
      workDate: P08_WORK_DATE,
      timezone: P08_RECORD_TIMEZONE,
      firstInAt: '2026-07-30T01:00:00.000Z',
      lastOutAt: '2026-07-30T09:00:00.000Z',
      status: 'normal',
      isWorkday: true,
      workMinutes: P08_WORK_MINUTES,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      sourceRef: ids.sourceRef,
    }),
  }
  const groupEffects: readonly LegacyImportGroupEffectDraftV1[] = [
    {
      kind: 'ensure_group',
      normalizedName: P08_GROUP_NORMALIZED,
      displayName: P08_GROUP_DISPLAY,
      code: null,
      timezone: P08_RECORD_TIMEZONE,
      ruleSetId: null,
      firstSourceOrdinal: 0,
    },
    {
      kind: 'ensure_member',
      groupRef: P08_GROUP_NORMALIZED,
      userId: ids.targetUserId,
      firstSourceOrdinal: 0,
    },
  ]
  const batch = {
    kind: 'normal' as const,
    source: 'manual' as const,
    ruleSetId: null,
    mappingSnapshot: { frozen: true },
    sourceRowCount: 1,
    status: 'committed',
    idempotencyKey: null,
    visibilityRule: 'org',
    engine: 'standard' as const,
    chunkConfig: { itemsChunkSize: 100 },
    recordUpsertStrategy: 'unnest' as const,
    itemsInsertStrategy: 'unnest' as const,
    mappingProfileId: null,
    compatibilityMetadata: {},
    groupSync: null,
    itemReturnPolicy: { returnItems: false as const, itemsLimit: null },
    skippedSamplePolicy: { limit: 50 },
    resultSlots: {
      groupCreated: 'ensure_group_returned_row_count' as const,
      groupMembersAdded: 'ensure_member_inserted_row_count' as const,
    },
  }
  return {
    batchIdentity,
    itemIdentities: [{ identity: itemIdentity, commandFingerprint }],
    job: {
      orgId: org.orgId,
      batchId: ids.batchId,
      createdBy: ids.adminId,
      idempotencyKey: null,
      total: 1,
      payload: {
        __jobType: 'commit',
        idempotencyKey: null,
        __importEngine: 'standard',
        recordUpsertStrategy: 'unnest',
        itemsInsertStrategy: 'unnest',
        __w4ContractVersion: 1,
      },
      w4Entrypoint: 'import_batch',
      w4BatchCommandId: ids.batchId,
      w4SourceKind: 'import_batch',
      w4SourceRef: ids.sourceRef,
      w4ActorId: ids.adminId,
      w4ActorPosture: 'platform_admin',
      w4TokenSubjectUserId: ids.adminId,
      w4CommandFingerprint: commandFingerprint,
      w4AcceptedWritePosture: org.acceptedWritePosture,
      w4ItemCount: 1,
      w4ItemSequenceFingerprint:
        computeAttendanceItemSequenceFingerprintV1(fingerprints),
      w4ItemSetFingerprint: computeAttendanceItemSetFingerprintV1(fingerprints),
      w4IdentityProofVector: [
        {
          ordinal: 0,
          semanticFingerprint,
          derivedOperationId: itemIdentity.id,
          commandFingerprint,
        },
      ],
      w4DistinctTargetCount: 1,
      w4OperationalBranch: 'strict_targeted',
      w4LegacyInputFingerprint: P08_HEX_A,
    },
    manifestSeed: {
      schemaVersion: 1,
      orgId: org.orgId,
      batchId: ids.batchId,
      sourceKind: 'import_batch',
      sourceRef: ids.sourceRef,
      createdBy: ids.adminId,
      actorId: ids.adminId,
      actorPosture: 'platform_admin',
      tokenSubjectUserId: ids.adminId,
      acceptedWritePosture: org.acceptedWritePosture,
      commandFingerprint,
      legacyInputFingerprint: P08_HEX_A,
      operationalBranch: 'strict_targeted',
      legacyRowSourceKind: 'direct_rows',
      sourceRowCount: 1,
      w4ItemCount: 1,
      w4DistinctTargetCount: 1,
      w4ItemSequenceFingerprint:
        computeAttendanceItemSequenceFingerprintV1(fingerprints),
      w4ItemSetFingerprint: computeAttendanceItemSetFingerprintV1(fingerprints),
      legacySourceRowLimit: null,
      batch,
      artifactCleanup: { kind: 'none' },
    },
    items: [item],
    recordWrites: [recordWrite],
    groupEffects,
  }
}

/** Production enqueue surface — used by parent (DB A) and child process A (DB B). */
export async function enqueueP08FullPlanV1(
  pool: Pool,
  ids: P08FixtureIds,
): Promise<string> {
  const org = await loadP08Org(pool, ids.orgId)
  const auth = createAuthorizedAttendanceWriteContextV1({
    actorId: ids.adminId,
    actorPosture: 'platform_admin',
    tokenSubjectUserId: ids.adminId,
    orgId: ids.orgId,
    subjectScope: { kind: 'self', userId: ids.adminId },
    capability: 'import',
    sourceRef: ids.sourceRef,
  })
  const input = buildP08FullPlanInput(org, ids)
  const result = await runSerializable(pool, (client) =>
    reserveAttendanceLegacyImportPlanJobV1(trx(client), auth, input),
  )
  if (result.kind !== 'created') {
    throw new Error(`P08 enqueue failed: ${JSON.stringify(result)}`)
  }
  return result.jobId
}

export async function processP08JobId(
  connectionString: string,
  jobId: string,
): Promise<{ kind: string }> {
  const pool = new Pool({ connectionString })
  try {
    const processor = createAttendanceLegacyPlanProcessorV1({
      acquireConnection: async () => {
        const client = await pool.connect()
        return { client, release: () => client.release() }
      },
    })
    const result = await processor.processLegacyImportPlanV1(jobId)
    return { kind: result.kind }
  } finally {
    await pool.end()
  }
}

/**
 * Read governed deterministic projection after first execution.
 * Excludes elapsedMs and non-shared minted UUIDs.
 */
export async function readP08DeterministicProjection(
  pool: Pool,
  jobId: string,
): Promise<P08DeterministicProjection> {
  const job = await pool.query(
    `SELECT status, org_id, batch_id::text AS batch_id
       FROM attendance_import_jobs WHERE id = $1::uuid`,
    [jobId],
  )
  if (job.rows.length !== 1) {
    throw new Error(`job missing: ${jobId}`)
  }
  const orgId = String(job.rows[0].org_id)
  const batchId = String(job.rows[0].batch_id)
  const terminals = await pool.query(
    `SELECT count(*)::int AS n, max(response::text) AS response
       FROM attendance_import_legacy_terminal_responses WHERE job_id = $1::uuid`,
    [jobId],
  )
  const batches = await pool.query(
    `SELECT count(*)::int AS n, max(meta::text) AS meta, max(status) AS status
       FROM attendance_import_batches WHERE id = $1::uuid`,
    [batchId],
  )
  const items = await pool.query(
    `SELECT count(*)::int AS n,
            max(user_id) AS user_id,
            max(work_date::text) AS work_date
       FROM attendance_import_items WHERE batch_id = $1::uuid`,
    [batchId],
  )
  const records = await pool.query(
    `SELECT count(*)::int AS n,
            max(timezone) AS timezone,
            max(work_minutes)::int AS work_minutes,
            max(status) AS status
       FROM attendance_records
      WHERE org_id = $1 AND source_batch_id = $2::uuid`,
    [orgId, batchId],
  )
  const groups = await pool.query(
    `SELECT count(*)::int AS n, max(lower(btrim(name))) AS normalized
       FROM attendance_groups
      WHERE org_id = $1 AND lower(btrim(name)) = $2`,
    [orgId, P08_GROUP_NORMALIZED],
  )
  const members = await pool.query(
    `SELECT count(*)::int AS n
       FROM attendance_group_members m
       JOIN attendance_groups g ON g.id = m.group_id
      WHERE m.org_id = $1 AND lower(btrim(g.name)) = $2`,
    [orgId, P08_GROUP_NORMALIZED],
  )
  const responseRaw = terminals.rows[0]?.response
  const response =
    typeof responseRaw === 'string' ? JSON.parse(responseRaw) : responseRaw
  const metaRaw = batches.rows[0]?.meta
  const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw
  return Object.freeze({
    status: String(job.rows[0].status),
    terminals: Number(terminals.rows[0].n),
    batches: Number(batches.rows[0].n),
    items: Number(items.rows[0].n),
    records: Number(records.rows[0].n),
    groups: Number(groups.rows[0].n),
    members: Number(members.rows[0].n),
    processedRows: Number(response?.summary?.processedRows ?? -1),
    failedRows: Number(response?.summary?.failedRows ?? -1),
    groupCreated: Number(meta?.groupCreated ?? -1),
    groupMembersAdded: Number(meta?.groupMembersAdded ?? -1),
    recordTimezone: String(records.rows[0].timezone ?? ''),
    workMinutes: Number(records.rows[0].work_minutes ?? -1),
    recordStatus: String(records.rows[0].status ?? ''),
    itemUserId: String(items.rows[0].user_id ?? ''),
    itemWorkDate: String(items.rows[0].work_date ?? '').slice(0, 10),
    groupNormalizedName: String(groups.rows[0].normalized ?? ''),
    batchEngine: String(meta?.engine ?? ''),
    resultKind: 'completed',
  })
}

export async function poisonP08CurrentConfig(
  pool: Pool,
  orgId: string,
): Promise<void> {
  // Mutate rule/settings/profile/group mapping only — not attendance_groups
  // (revision trigger would invalidate frozen plans).
  await pool.query(
    `UPDATE attendance_rule_sets SET config = $2::jsonb WHERE org_id = $1`,
    [orgId, JSON.stringify({ timezone: 'America/New_York', poisoned: true })],
  )
  await pool.query(
    `UPDATE attendance_mapping_profiles SET mapping = $2::jsonb WHERE org_id = $1`,
    [
      orgId,
      JSON.stringify({
        profile: 'poisoned',
        groupCodeMap: { night: 'other' },
      }),
    ],
  )
}

export async function countOrgInfluence(
  pool: Pool,
  orgId: string,
): Promise<{
  jobs: number
  batches: number
  records: number
  groups: number
  members: number
}> {
  const r = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM attendance_import_jobs WHERE org_id = $1) AS jobs,
       (SELECT count(*)::int FROM attendance_import_batches WHERE org_id = $1) AS batches,
       (SELECT count(*)::int FROM attendance_records WHERE org_id = $1) AS records,
       (SELECT count(*)::int FROM attendance_groups
         WHERE org_id = $1 AND lower(btrim(name)) = $2) AS groups,
       (SELECT count(*)::int FROM attendance_group_members WHERE org_id = $1) AS members`,
    [orgId, P08_GROUP_NORMALIZED],
  )
  return {
    jobs: Number(r.rows[0].jobs),
    batches: Number(r.rows[0].batches),
    records: Number(r.rows[0].records),
    groups: Number(r.rows[0].groups),
    members: Number(r.rows[0].members),
  }
}
