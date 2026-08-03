import crypto from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'

import {
  claimAttendanceCanonicalImportRegistryV1,
  executeAttendanceCanonicalImportPlanV1,
} from '../../src/attendance/w4c3a-canonical-import-kernel'
import { canonicalAttendanceJsonV1 } from '../../src/attendance/w4c0-fingerprints'
import {
  createVerifiedAttendanceOperationIdentityV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  type AttendanceW4TransactionClientV1,
} from '../../src/attendance/w4c0-identity'
import type { AttendanceLegacyPlanWorkerJobV1, VerifiedAttendanceLegacyPlanV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import { LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1 } from '../../src/attendance/w4c3a-legacy-execution-plan'
import {
  buildAttendanceImportAttributionFreezeV1,
  buildAttendanceImportPolicySourceProofV1,
} from '../../src/attendance/w4c3a-import-proof'
import { parseAttendanceW4ShadowDiff } from '../../src/services/AttendanceW4CalculationDetail'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as addOffStatusUp } from '../../src/db/migrations/zzzz20260731120000_w4c3a_add_off_daily_status'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const hex = (letter: string): string => letter.repeat(64)

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) =>
      client.query(text, values as unknown[]) as unknown as Promise<{
        rows: Array<Record<string, unknown>>
      }>,
  }
}

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', is_workday boolean,
      timezone text, meta jsonb, source_batch_id uuid, org_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
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
      id uuid PRIMARY KEY, org_id text NOT NULL, idempotency_key text, created_by text NOT NULL,
      source text, rule_set_id uuid, mapping jsonb NOT NULL, row_count integer NOT NULL,
      status text NOT NULL, meta jsonb NOT NULL, created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY, batch_id uuid NOT NULL, org_id text NOT NULL, user_id text,
      work_date date, record_id uuid, preview_snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_groups (
      id uuid PRIMARY KEY, org_id text NOT NULL, name text NOT NULL, code text,
      timezone text, rule_set_id uuid, description text, created_at timestamptz,
      updated_at timestamptz, UNIQUE (org_id, name)
    )`)
  await pool.query(`
    CREATE TABLE attendance_group_members (
      id uuid PRIMARY KEY, org_id text NOT NULL, group_id uuid NOT NULL, user_id text NOT NULL,
      created_at timestamptz, updated_at timestamptz, UNIQUE (org_id, group_id, user_id)
    )`)
}

function frozenContext(orgId: string, userId: string, workDate: string) {
  return {
    schemaVersion: 1,
    selector: 'legacy',
    orgId,
    userId,
    workDate,
    timezone: 'Asia/Shanghai',
    shiftId: `shift-${run}`,
    isWorkday: true,
    holidayKind: null,
    calculationGroupId: null,
    roundingMinutes: 1,
    severeLateThresholdMinutes: 60,
    absenceLateThresholdMinutes: 240,
    segments: [{
      index: 0,
      startTime: '09:00',
      endTime: '17:00',
      startDayOffset: 0,
      endDayOffset: 0,
      lateGraceMinutes: 0,
      earlyLeaveGraceMinutes: 0,
    }],
  }
}

function frozenAttribution(orgId: string, userId: string, workDate: string) {
  const result = buildAttendanceImportAttributionFreezeV1({
    orgId,
    userId,
    workDate,
    shiftId: `shift-${run}`,
    reasonCode: 'SINGLE_MATCHING_CANDIDATE',
    resolvedAt: `${workDate}T00:00:00.000Z`,
    timezone: 'Asia/Shanghai',
    workStartTime: '09:00',
    workEndTime: '17:00',
    isOvernight: false,
    candidateAbsoluteWindow: {
      startAt: `${workDate}T01:00:00.000Z`,
      endAt: `${workDate}T09:00:00.000Z`,
    },
    candidateAttributionWindow: {
      startAt: `${workDate}T01:00:00.000Z`,
      endAt: `${workDate}T09:00:00.000Z`,
    },
    attributionTailMinutes: 0,
    approvedOvertimeWindows: [],
  })
  if (result.kind !== 'resolved_v2') {
    throw new Error('expected a resolved canonical import attribution fixture')
  }
  return result
}

function policySourceProof(conflict: boolean) {
  const proof = buildAttendanceImportPolicySourceProofV1({
    ruleVersion: 'w4c3a-test',
    engineVersion: null,
    rule: {
      timezone: 'Asia/Shanghai',
      workStartTime: '09:00',
      workEndTime: '17:00',
      lateGraceMinutes: 0,
      earlyGraceMinutes: 0,
      roundingMinutes: 1,
      severeLateThresholdMinutes: 60,
      absenceLateThresholdMinutes: 240,
      workingDays: [1, 2, 3, 4, 5],
    },
    policy: { appliedRules: [], userGroups: [] },
    engine: null,
  })
  return {
    sourceOrdinal: 0,
    sourceFingerprint: proof.sourceFingerprint,
    sourceDefinition: proof.sourceDefinition,
    output: {
      status: 'normal',
      workMinutes: conflict ? 479 : 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      leaveMinutes: 0,
      overtimeMinutes: 0,
    },
  }
}

function fixture(posture: 'shadow' | 'authoritative', input?: Readonly<{ conflict?: boolean }>) {
  const orgId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const batchId = crypto.randomUUID()
  const recordId = crypto.randomUUID()
  const itemId = crypto.randomUUID()
  const recordWriteId = crypto.randomUUID()
  const workDate = '2026-07-30'
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({
    orgId,
    acceptedWritePosture: posture,
  })
  const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'batch',
    entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: batchId },
  })
  const itemIdentity = createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'item',
    entrypoint: 'import_batch',
    source: {
      sourceKind: 'import_item',
      batchCommandId: batchId,
      ordinal: 0,
      semanticFingerprint: hex('b'),
    },
  })
  const attribution = frozenAttribution(orgId, userId, workDate)
  const context = frozenContext(orgId, userId, workDate)
  const policySource = policySourceProof(input?.conflict === true)
  const rawEvidence = {
    schemaVersion: 1,
    sourceOrdinal: 0,
    punches: [
      { direction: 'check_in', occurredAt: `${workDate}T01:00:00.000Z` },
      { direction: 'check_out', occurredAt: `${workDate}T09:00:00.000Z` },
    ],
    fields: {
      userId: { present: true, value: userId },
      workDate: { present: true, value: workDate },
      timezone: { present: true, value: 'Asia/Shanghai' },
      firstInAt: { present: true, value: `${workDate}T01:00:00.000Z` },
      lastOutAt: { present: true, value: `${workDate}T09:00:00.000Z` },
      status: { present: true, value: 'normal' },
      isWorkday: { present: true, value: true },
    },
    metrics: {
      workMinutes: { present: true, value: input?.conflict ? 479 : 480 },
      lateMinutes: { present: true, value: 0 },
      earlyLeaveMinutes: { present: true, value: 0 },
      leaveMinutes: { present: true, value: 0 },
      overtimeMinutes: { present: true, value: 0 },
    },
    provenance: {
      transport: 'rows',
      sourceRef: `w4c3a-kernel:${run}`,
      artifactSha256: null,
      normalizedCsvSha256: null,
      convertedSheetName: null,
    },
  } as const
  const write = {
    recordWriteId,
    orgId,
    userId,
    workDate,
    sourceOrdinals: [0],
    mergeMode: 'merge',
    firstInAt: `${workDate}T01:00:00.000Z`,
    lastOutAt: `${workDate}T09:00:00.000Z`,
    workMinutes: input?.conflict ? 479 : 480,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    status: 'normal',
    isWorkday: true,
    timezone: 'Asia/Shanghai',
    compatibilityMetadata: {},
    policySnapshot: {
      schemaVersion: 2,
      sources: [policySource],
    },
    profileSnapshot: {},
    multiPunchSnapshot: {},
    attributionSnapshot: {
      schemaVersion: 2,
      sources: [{
        sourceOrdinal: 0,
        attribution: attribution.attribution,
        context,
        importAttributionReconstruction: attribution.reconstruction,
      }],
    },
    sourceBatchId: batchId,
    resultSlots: {},
    recordId,
    targetRevision: 0,
    existingRecordPreconditionFingerprint:
      LEGACY_IMPORT_MISSING_RECORD_PRECONDITION_FINGERPRINT_V1,
    expectedSourceOwnership: null,
  }
  const plan = {
    manifest: {
      orgId,
      batchId,
      createdBy: `admin-${run}`,
      operationalBranch: 'strict_targeted',
      batch: {
        kind: 'normal',
        source: 'manual',
        ruleSetId: null,
        mappingSnapshot: {},
        sourceRowCount: 1,
        status: 'committed',
        idempotencyKey: null,
        engine: 'standard',
        chunkConfig: { size: 100 },
        recordUpsertStrategy: 'unnest',
        itemsInsertStrategy: 'unnest',
        mappingProfileId: null,
        compatibilityMetadata: {},
        groupSync: null,
        itemReturnPolicy: { returnItems: false, itemsLimit: null },
        skippedSamplePolicy: { limit: 50 },
      },
    },
    chunks: [],
    items: [{
      kind: 'apply',
      ordinal: 0,
      semanticOrdinal: 0,
      itemId,
      targetRef: canonicalAttendanceJsonV1([orgId, userId, workDate]),
      previewSnapshot: { status: 'normal' },
      recordWriteRef: recordWriteId,
      rawEvidence,
    }],
    recordWrites: [write],
    groupEffects: [],
  } as unknown as VerifiedAttendanceLegacyPlanV1
  const job = {
    jobId: crypto.randomUUID(),
    orgId,
    status: 'running',
    w4ContractVersion: 1,
    batchId,
    idempotencyKey: null,
    sourceKind: 'import_batch',
    sourceRef: `w4c3a-kernel:${run}`,
    createdBy: `admin-${run}`,
    actorId: `admin-${run}`,
    actorPosture: 'platform_admin',
    tokenSubjectUserId: `admin-${run}`,
    acceptedWritePosture: posture,
    commandFingerprint: hex('d'),
    legacyInputFingerprint: hex('e'),
    operationalBranch: 'strict_targeted',
    identityProofVector: [{
      ordinal: 0,
      semanticFingerprint: hex('b'),
      derivedOperationId: itemIdentity.id,
      commandFingerprint: hex('f'),
    }],
    identityProofVectorDigest: hex('1'),
    itemCount: 1,
    distinctTargetCount: 1,
    itemSequenceFingerprint: hex('2'),
    itemSetFingerprint: hex('3'),
    planDigest: hex('4'),
    executionReasonCode: null,
  } as AttendanceLegacyPlanWorkerJobV1
  return { orgId, recordId, batchId, itemId, job, plan, identities: [batchIdentity, itemIdentity] }
}

function withSecondFoldedSource(input: ReturnType<typeof fixture>): ReturnType<typeof fixture> {
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({
    orgId: input.orgId,
    acceptedWritePosture: input.job.acceptedWritePosture,
  })
  const secondIdentity = createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'item',
    entrypoint: 'import_batch',
    source: {
      sourceKind: 'import_item',
      batchCommandId: input.batchId,
      ordinal: 1,
      semanticFingerprint: hex('6'),
    },
  })
  const firstItem = input.plan.items[0] as Extract<
    VerifiedAttendanceLegacyPlanV1['items'][number],
    { kind: 'apply' }
  >
  const firstWrite = input.plan.recordWrites[0]
  const attributionRoot = firstWrite.attributionSnapshot as {
    schemaVersion: 2
    sources: Array<Record<string, unknown>>
  }
  const policyRoot = firstWrite.policySnapshot as {
    schemaVersion: 2
    sources: Array<Record<string, unknown>>
  }
  const secondRawEvidence = {
    ...firstItem.rawEvidence,
    sourceOrdinal: 1,
    punches: [],
  }
  const secondItem = {
    ...firstItem,
    itemId: crypto.randomUUID(),
    ordinal: 1,
    semanticOrdinal: 1,
    rawEvidence: secondRawEvidence,
  }
  const secondAttribution = {
    ...attributionRoot.sources[0],
    sourceOrdinal: 1,
  }
  const secondPolicy = {
    ...policyRoot.sources[0],
    sourceOrdinal: 1,
  }
  const plan = {
    ...input.plan,
    manifest: {
      ...input.plan.manifest,
      batch: {
        ...input.plan.manifest.batch,
        sourceRowCount: 2,
      },
    },
    items: [firstItem, secondItem],
    recordWrites: [{
      ...firstWrite,
      sourceOrdinals: [0, 1],
      attributionSnapshot: {
        schemaVersion: 2,
        sources: [attributionRoot.sources[0], secondAttribution],
      },
      policySnapshot: {
        schemaVersion: 2,
        sources: [policyRoot.sources[0], secondPolicy],
      },
    }],
  } as unknown as VerifiedAttendanceLegacyPlanV1
  const job = {
    ...input.job,
    itemCount: 2,
    identityProofVector: [
      ...(input.job.identityProofVector as Array<Record<string, unknown>>),
      {
        ordinal: 1,
        semanticFingerprint: hex('6'),
        derivedOperationId: secondIdentity.id,
        commandFingerprint: hex('7'),
      },
    ],
  }
  return {
    ...input,
    job,
    plan,
    identities: [input.identities[0], input.identities[1], secondIdentity],
  }
}

describeIfDatabase('W4C-3a canonical import kernel (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_kernel_${run}`
  let adminPool: Pool
  let pool: Pool
  let migrationPool: Pool
  let db: Kysely<unknown>

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
    await addOffStatusUp(db)
  }, 90000)

  afterAll(async () => {
    await db?.destroy()
    await pool?.end()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end()
  })

  async function execute(input: ReturnType<typeof fixture>): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const claim = await claimAttendanceCanonicalImportRegistryV1(trx(client), {
        job: input.job,
        plan: input.plan,
        identities: input.identities,
      })
      expect(claim).not.toBeNull()
      await executeAttendanceCanonicalImportPlanV1(trx(client), {
        job: input.job,
        plan: input.plan,
        registryClaim: claim,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  it('shadow import persists a parsed diff while preserving the compatibility projection', async () => {
    const input = fixture('shadow')
    await execute(input)
    const rows = await pool.query(
      `SELECT r.projection_owner, r.current_calculation_id,
              c.mode, c.outcome, c.projection_effect,
              c.shadow_diff_code, c.shadow_diff,
              (SELECT count(*)::int FROM attendance_record_segments s WHERE s.calculation_id = c.id) AS segments
         FROM attendance_records r
         JOIN attendance_record_calculations c ON c.attendance_record_id = r.id
        WHERE r.id = $1`,
      [input.recordId],
    )
    expect(rows.rows).toEqual([{
      projection_owner: 'legacy_untracked',
      current_calculation_id: null,
      mode: 'shadow',
      outcome: 'completed',
      projection_effect: 'none',
      shadow_diff_code: 'equal',
      shadow_diff: {
        schemaVersion: 1,
        code: 'equal',
        changedFields: [],
        absoluteMinuteDelta: 0,
        segmentCount: 1,
      },
      segments: 1,
    }])
    expect(parseAttendanceW4ShadowDiff(
      rows.rows[0].shadow_diff_code,
      rows.rows[0].shadow_diff,
    )).toEqual(rows.rows[0].shadow_diff)
  })

  it('creates and selects an authoritative calculation without a legacy writer call', async () => {
    const input = fixture('authoritative')
    await execute(input)
    const rows = await pool.query(
      `SELECT r.projection_owner, r.current_calculation_id::text AS current_calculation_id,
              r.work_minutes, c.id::text AS calculation_id, c.mode, c.outcome,
              c.projection_effect, c.projected_work_minutes
         FROM attendance_records r
         JOIN attendance_record_calculations c ON c.id = r.current_calculation_id
        WHERE r.id = $1`,
      [input.recordId],
    )
    expect(rows.rows).toEqual([expect.objectContaining({
      projection_owner: 'w4',
      work_minutes: 480,
      mode: 'authoritative',
      outcome: 'completed',
      projection_effect: 'set_active',
      projected_work_minutes: 480,
    })])
    expect(rows.rows[0].current_calculation_id).toBe(rows.rows[0].calculation_id)
  })

  it('folds two ordered source items into one calculation and seals both operations', async () => {
    const input = withSecondFoldedSource(fixture('shadow'))
    await execute(input)
    const rows = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE attendance_record_id = $1) AS calculations,
         (SELECT count(*)::int FROM attendance_import_items
           WHERE batch_id = $2) AS source_items,
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE batch_command_id = $2 AND state = 'completed') AS sealed_operations,
         (SELECT count(DISTINCT resolved_calculation_id)::int
            FROM attendance_result_operations
           WHERE batch_command_id = $2) AS result_calculations`,
      [input.recordId, input.batchId],
    )
    expect(rows.rows).toEqual([{
      calculations: 1,
      source_items: 2,
      sealed_operations: 2,
      result_calculations: 1,
    }])
  })

  it('freezes an existing legacy projection before selecting the authoritative calculation', async () => {
    const input = fixture('authoritative')
    await pool.query(
      `INSERT INTO attendance_records (
          id, org_id, user_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          projection_owner, current_calculation_id, visibility_state, visibility_reason
        ) VALUES ($1,$2,$3,'2026-07-30','Asia/Shanghai',$4,$5,420,15,45,'late',true,
                  'legacy_untracked',NULL,'active','active')`,
      [
        input.recordId,
        input.orgId,
        input.plan.recordWrites[0].userId,
        '2026-07-30T01:15:00.000Z',
        '2026-07-30T09:00:00.000Z',
      ],
    )

    await execute(input)

    const rows = await pool.query(
      `SELECT c.version, c.calculation_kind, c.outcome, c.projection_effect,
              c.projected_status, c.projected_work_minutes,
              (r.current_calculation_id = c.id) AS is_current
         FROM attendance_record_calculations c
         JOIN attendance_records r ON r.id = c.attendance_record_id
        WHERE c.attendance_record_id = $1
        ORDER BY c.version`,
      [input.recordId],
    )
    expect(rows.rows).toEqual([
      {
        version: 1,
        calculation_kind: 'legacy_baseline',
        outcome: 'baseline',
        projection_effect: 'none',
        projected_status: 'late',
        projected_work_minutes: 420,
        is_current: false,
      },
      {
        version: 2,
        calculation_kind: 'calculation',
        outcome: 'completed',
        projection_effect: 'set_active',
        projected_status: 'normal',
        projected_work_minutes: 480,
        is_current: true,
      },
    ])
  })

  it('rejects a malformed freeze before claiming any durable operation row', async () => {
    const input = fixture('shadow')
    const write = input.plan.recordWrites[0] as unknown as {
      attributionSnapshot: { schemaVersion: number; sources: Array<Record<string, unknown>> }
    }
    write.attributionSnapshot.sources[0] = {
      ...write.attributionSnapshot.sources[0],
      unexpected: true,
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      await expect(claimAttendanceCanonicalImportRegistryV1(trx(client), {
        job: input.job,
        plan: input.plan,
        identities: input.identities,
      })).rejects.toThrow('W4C3A_IMPORT_FREEZE_INVALID')
      const residue = await client.query(
        `SELECT
           (SELECT count(*)::int FROM attendance_result_operation_batches
             WHERE org_id = $1 AND batch_command_id = $2::uuid) AS batches,
           (SELECT count(*)::int FROM attendance_result_operations
             WHERE org_id = $1 AND batch_command_id = $2::uuid) AS items`,
        [input.orgId, input.batchId],
      )
      expect(residue.rows).toEqual([{ batches: 0, items: 0 }])
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('fails an imported metric conflict closed without projecting or inserting segments', async () => {
    const input = fixture('authoritative', { conflict: true })
    await execute(input)
    const rows = await pool.query(
      `SELECT r.projection_owner, r.current_calculation_id, r.visibility_state,
              c.outcome, c.outcome_reason_code, c.projection_effect,
              (SELECT count(*)::int FROM attendance_record_segments s WHERE s.calculation_id = c.id) AS segments
         FROM attendance_records r
         JOIN attendance_record_calculations c ON c.attendance_record_id = r.id
        WHERE r.id = $1`,
      [input.recordId],
    )
    expect(rows.rows).toEqual([{
      projection_owner: 'legacy_untracked',
      current_calculation_id: null,
      visibility_state: 'retired',
      outcome: 'review_required',
      outcome_reason_code: 'import_metric_conflict',
      projection_effect: 'none',
      segments: 0,
    }])
  })

  it('rolls back every source effect when the final operation seal fails', async () => {
    const input = fixture('shadow')
    const tables = [
      'attendance_records',
      'attendance_record_calculations',
      'attendance_record_segments',
      'attendance_import_batches',
      'attendance_import_items',
      'attendance_result_operation_batches',
      'attendance_result_operations',
    ] as const
    const before = new Map<string, number>()
    for (const table of tables) {
      const count = await pool.query(`SELECT count(*)::int AS value FROM ${table}`)
      before.set(table, Number(count.rows[0].value))
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
      const claim = await claimAttendanceCanonicalImportRegistryV1(trx(client), {
        job: input.job,
        plan: input.plan,
        identities: input.identities,
      })
      expect(claim).not.toBeNull()
      const failAtItemSeal: AttendanceW4TransactionClientV1 = {
        query: (text, values) => {
          if (
            text.includes('UPDATE attendance_result_operations') &&
            text.includes("SET state = 'completed'")
          ) {
            throw new Error('INJECTED_ITEM_SEAL_FAILURE')
          }
          return trx(client).query(text, values)
        },
      }
      await expect(executeAttendanceCanonicalImportPlanV1(failAtItemSeal, {
        job: input.job,
        plan: input.plan,
        registryClaim: claim,
      })).rejects.toThrow('INJECTED_ITEM_SEAL_FAILURE')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    for (const table of tables) {
      const count = await pool.query(`SELECT count(*)::int AS value FROM ${table}`)
      expect(count.rows[0].value).toBe(before.get(table))
    }
  })
})
