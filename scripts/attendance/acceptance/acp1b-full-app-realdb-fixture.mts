import * as bcrypt from 'bcryptjs'
import type { Pool } from 'pg'

export type Acp1bFullAppFixture = {
  orgId: string
  userId: string
  recordId: string
  workDate: string
  email: string
  password: string
}

export async function snapshotActorAuthority(pool: Pool, userId: string) {
  const user = await pool.query('SELECT role, permissions, is_admin FROM users WHERE id = $1', [userId])
  const roles = await pool.query('SELECT role_id FROM user_roles WHERE user_id = $1 ORDER BY role_id', [userId])
  const permissions = await pool.query('SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code', [userId])
  const memberships = await pool.query('SELECT org_id, is_active FROM user_orgs WHERE user_id = $1 ORDER BY org_id', [userId])
  const sheets = await pool.query("SELECT sheet_id, perm_code FROM spreadsheet_permissions WHERE subject_type = 'user' AND subject_id = $1 ORDER BY sheet_id, perm_code", [userId])
  return { user: user.rows, roles: roles.rows, permissions: permissions.rows, memberships: memberships.rows, sheets: sheets.rows }
}

/** Configuration actor only: one generated sheet grant, no global permission or role. */
export async function seedSheetSetupActor(pool: Pool, orgId: string, sheetId: string) {
  const { randomUUID } = await import('node:crypto')
  const userId = randomUUID()
  const email = `setup-${userId}@example.test`
  const password = `Setup-${randomUUID()}!`
  const hash = await bcrypt.hash(password, 10)
  await pool.query(`INSERT INTO users
    (id, email, username, name, password_hash, role, permissions, is_active, is_admin,
     must_change_password, activation_status, local_password_set)
    VALUES ($1, $2, $1, 'Synthetic sheet setup', $3, 'user', '[]'::jsonb, true, false, false, 'activated', true)`, [userId, email, hash])
  await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
  await pool.query(`INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
    VALUES ($1, $2, 'user', $2, 'multitable:write')`, [sheetId, userId])
  return { userId, email, password }
}

export type Acp1bFullAppCanonicalSnapshot = {
  id: string
  org_id: string
  user_id: string
  work_date: string
  status: string
  current_calculation_id: string
  projection_owner: string
  work_minutes: number
  late_minutes: number
  early_leave_minutes: number
}

export async function seedCanonical(
  pool: Pool,
  nonce: string,
): Promise<Acp1bFullAppFixture> {
  if (!/^[a-z0-9]{1,32}$/.test(nonce)) throw new Error('ACP_FULL_APP_FIXTURE_UNSAFE_NONCE')
  if (process.env.RBAC_BYPASS !== 'false') throw new Error('ACP_FULL_APP_FIXTURE_RBAC_NOT_STRICT')

  const { randomUUID } = await import('node:crypto')
  const {
    computeAttendanceProvenanceFingerprintV1,
    computeAttendanceSemanticInputFingerprintV1,
  } = await import('../../../packages/core-backend/src/attendance/w4c0-fingerprints.ts')
  const { computeAttendanceSourceDefinitionFingerprintV1 } = await import(
    '../../../packages/core-backend/src/attendance/w4c1-fingerprints.ts'
  )
  const { ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 } = await import(
    '../../../packages/core-backend/src/attendance/w4c1-segment-calculator.ts'
  )

  const orgId = randomUUID()
  const userId = randomUUID()
  const recordId = randomUUID()
  const calculationId = randomUUID()
  const operationId = randomUUID()
  const shiftId = randomUUID()
  const workDate = '2026-08-01'
  const email = `acp-full-app-${nonce}@example.test`
  const password = `Acp-${nonce}-Login!2026`
  const passwordHash = await bcrypt.hash(password, 10)

  const existingOrg = await pool.query('SELECT count(*)::int AS n FROM user_orgs WHERE org_id = $1', [orgId])
  if (existingOrg.rows[0]?.n !== 0) throw new Error('ACP_FULL_APP_FIXTURE_ORG_ALREADY_EXISTS')

  await pool.query(
    `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin,
        must_change_password, activation_status, local_password_set, created_at, updated_at)
     VALUES ($1, $2, $1, 'ACP full app fixture', $3, 'user', '[]'::jsonb, true, false,
             false, 'activated', true, now(), now())`,
    [userId, email, passwordHash],
  )
  await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
  await pool.query(
    "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'attendance_admin') ON CONFLICT DO NOTHING",
    [userId],
  )
  await pool.query(
    "INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:write') ON CONFLICT DO NOTHING",
    [userId],
  )
  await pool.query(
    `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source)
     VALUES ($1, 'attendance', true, 'synthetic_acceptance')
     ON CONFLICT (user_id, namespace) DO UPDATE SET enabled = true, source = EXCLUDED.source`,
    [userId],
  )

  await pool.query(
    `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
     VALUES ($1, 'legacy', 'acp-full-app-realdb', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
    [orgId, userId],
  )
  for (const [state, priorState, version] of [
    ['shadow', 'legacy', 2],
    ['eligible', 'shadow', 3],
    ['authoritative', 'eligible', 4],
  ] as const) {
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = $2, prior_state = $3, version = $4
        WHERE org_id = $1`,
      [orgId, state, priorState, version],
    )
  }

  await pool.query(
    `INSERT INTO attendance_records
       (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
        work_minutes, late_minutes, early_leave_minutes, status, is_workday,
        meta, projection_owner, visibility_state, visibility_reason, updated_at)
     VALUES ($1::uuid, $2, $3, $4::date, 'UTC', $5::timestamptz, $6::timestamptz,
             400, 15, 0, 'late', true, '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
    [recordId, userId, orgId, workDate, `${workDate}T01:10:00.000Z`, `${workDate}T10:00:00.000Z`],
  )

  const attribution = {
    posture: 'resolved_v2',
    value: {
      schemaVersion: 2,
      resolverVersion: 'w2-resolver@3',
      orgId,
      userId,
      workDate,
      shiftId,
      reasonCode: 'assignment_match',
      resolvedAt: `${workDate}T00:05:00.000Z`,
      absoluteWindow: { startAt: `${workDate}T00:00:00.000Z`, endAt: `${workDate}T23:59:59.000Z` },
      attributionWindow: { startAt: `${workDate}T00:00:00.000Z`, endAt: `${workDate}T23:59:59.000Z` },
      attributionTailMinutes: 0,
      extendedByApprovedOvertime: false,
      windowEvidenceFingerprint: 'a'.repeat(64),
      source: 'live_resolution',
    },
  }
  const segments = [{
    index: 0,
    startTime: '01:00',
    endTime: '10:00',
    startDayOffset: 0,
    endDayOffset: 0,
    lateGraceMinutes: 0,
    earlyLeaveGraceMinutes: 0,
  }]
  const context = {
    schemaVersion: 1,
    selector: 'legacy',
    orgId,
    userId,
    workDate,
    timezone: 'UTC',
    shiftId,
    isWorkday: true,
    holidayKind: null,
    calculationGroupId: null,
    roundingMinutes: 5,
    severeLateThresholdMinutes: 30,
    absenceLateThresholdMinutes: 60,
    segments,
  }
  const evidence = [
    { kind: 'punch', ref: 'ev-in-0', direction: 'check_in', occurredAt: `${workDate}T01:10:00.000Z`, source: 'attendance_event' },
    { kind: 'punch', ref: 'ev-out-0', direction: 'check_out', occurredAt: `${workDate}T10:00:00.000Z`, source: 'attendance_event' },
  ]
  const provenance = {
    transport: 'live_event',
    sourceRef: `route-prior:${calculationId}`,
    artifactSha256: null,
    normalizedCsvSha256: null,
    convertedSheetName: null,
  }
  const semanticFingerprint = computeAttendanceSemanticInputFingerprintV1({
    attribution,
    context,
    evidence,
    approvedFacts: [],
    manualOverride: null,
    mergePolicy: 'append',
    calculationTier: 'segment_authoritative',
    engineVersion: ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
    snapshotSchemaVersion: 1,
  })
  const sourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({ attribution, context })
  if (!sourceDefinitionFingerprint) throw new Error('ACP_FULL_APP_FIXTURE_SOURCE_DEFINITION_MISSING')
  const provenanceFingerprint = computeAttendanceProvenanceFingerprintV1(provenance)

  const priorClient = await pool.connect()
  try {
    await priorClient.query('BEGIN')
    await priorClient.query(
      `INSERT INTO attendance_record_calculations (
        id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
        engine_version, snapshot_schema_version, operation_id,
        semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
        attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
        approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
        outcome, outcome_reason_code, projection_effect, expected_segment_count,
        projected_status, projected_first_in_at, projected_last_out_at,
        projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
        projected_daily_fingerprint, actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, 1, 'calculation', 'authoritative', 'live',
        $4, 1, $5::uuid, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
        '[]'::jsonb, $13::jsonb, 'append', 'segment_authoritative',
        'completed', 'calculated', 'set_active', 1, 'late', $14::timestamptz, $15::timestamptz,
        400, 15, 0, $16, $17, $18)`,
      [
        calculationId, orgId, recordId, ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1, operationId,
        semanticFingerprint, provenanceFingerprint, sourceDefinitionFingerprint,
        JSON.stringify(attribution), JSON.stringify(context), JSON.stringify(segments), JSON.stringify(evidence),
        JSON.stringify(provenance), `${workDate}T01:10:00.000Z`, `${workDate}T10:00:00.000Z`,
        'e'.repeat(64), userId, `route-prior:${calculationId}`,
      ],
    )
    await priorClient.query(
      `INSERT INTO attendance_record_segments (
       org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
       actual_in_at, actual_out_at, work_minutes, late_minutes, early_leave_minutes, status,
       status_reasons, matched_evidence_refs, unmatched_evidence_refs)
       VALUES ($1, $2::uuid, $3::uuid, 0, $4::timestamptz, $5::timestamptz,
       $4::timestamptz, $5::timestamptz, 400, 15, 0, 'late',
       '["late_check_in"]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [orgId, recordId, calculationId, `${workDate}T01:10:00.000Z`, `${workDate}T10:00:00.000Z`],
    )
    await priorClient.query(
      `UPDATE attendance_records
          SET current_calculation_id = $1::uuid, projection_owner = 'w4'
        WHERE id = $2::uuid AND org_id = $3`,
      [calculationId, recordId, orgId],
    )
    await priorClient.query('COMMIT')
  } catch {
    await priorClient.query('ROLLBACK').catch(() => undefined)
    throw new Error('ACP_FULL_APP_FIXTURE_PRIOR_FAILED')
  } finally {
    priorClient.release()
  }

  const settingsResult = await pool.query("SELECT value FROM system_configs WHERE key = 'attendance.settings'")
  const previousSettings = settingsResult.rows[0]?.value
  const settings = previousSettings && typeof previousSettings === 'object' ? previousSettings : {}
  await pool.query(
    `INSERT INTO system_configs (key, value) VALUES ('attendance.settings', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ ...settings, attendanceMultitableCleaningPolicy: { enabled: true } })],
  )

  return { orgId, userId, recordId, workDate, email, password }
}

export async function snapshotCanonical(
  pool: Pool,
  fixture: Acp1bFullAppFixture,
): Promise<Acp1bFullAppCanonicalSnapshot> {
  const result = await pool.query(
    `SELECT id, org_id, user_id, work_date::text, status, current_calculation_id,
            projection_owner, work_minutes, late_minutes, early_leave_minutes
       FROM attendance_records
      WHERE id = $1::uuid AND org_id = $2`,
    [fixture.recordId, fixture.orgId],
  )
  if (result.rows.length !== 1) throw new Error('ACP_FULL_APP_FIXTURE_CANONICAL_MISSING')
  return result.rows[0] as Acp1bFullAppCanonicalSnapshot
}

export async function revoke(
  pool: Pool,
  fixture: Acp1bFullAppFixture,
): Promise<void> {
  const result = await pool.query(
    'UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2 AND is_active = true',
    [fixture.userId, fixture.orgId],
  )
  if (result.rowCount !== 1) throw new Error('ACP_FULL_APP_FIXTURE_REVOKE_FAILED')
}

/** Owned scratch-only foreign organization; grants nothing to the login actor. */
export async function seedForeignCanary(pool: Pool, orgId: string) {
  const { randomUUID } = await import('node:crypto')
  if (!/^[0-9a-f-]{36}$/.test(orgId)) throw new Error('CANARY_ORG_INVALID')
  const existing = await pool.query('SELECT count(*)::int AS n FROM user_orgs WHERE org_id = $1', [orgId])
  if (existing.rows[0].n !== 0) throw new Error('CANARY_ORG_ALREADY_EXISTS')
  const userId = randomUUID()
  const recordId = randomUUID()
  const workDate = '2026-08-01'
  await pool.query(`INSERT INTO users (id, email, name, password_hash, role, is_active, activation_status)
    VALUES ($1, $2, 'Synthetic foreign canary', 'disabled', 'user', true, 'activated')`,
  [userId, `canary-${userId}@example.test`])
  await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
  await pool.query(`INSERT INTO attendance_records
    (id, user_id, org_id, work_date, timezone, status, is_workday, meta, projection_owner, visibility_state, visibility_reason)
    VALUES ($1::uuid, $2, $3, $4::date, 'UTC', 'normal', true, '{}'::jsonb, 'legacy_untracked', 'active', 'active')`,
  [recordId, userId, orgId, workDate])
  return { orgId, userId, recordId, workDate }
}
