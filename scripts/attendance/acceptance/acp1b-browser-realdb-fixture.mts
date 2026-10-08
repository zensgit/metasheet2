import type { Pool } from 'pg'

export type Acp1bBrowserFixture = {
  orgId: string
  userId: string
  token: string
  recordId: string
  projectionId: string
  sheetId: string
  physical: (code: string) => string
  data: Record<string, unknown>
}

export type Acp1bBrowserSnapshot = {
  canonical: Record<string, unknown>
  projection: { data: Record<string, unknown>; version: number }
  edits: number
  operations: number
  completedOperations: number
  manualOverrideCalculations: number
  events: number
  notified: number
  proposalRevisions: number
  proposalMarkers: number
}

export async function seedProposal(
  pool: Pool,
  baseUrl: string,
  nonce: string,
): Promise<Acp1bBrowserFixture> {
  if (!/^[a-z0-9]{1,32}$/.test(nonce)) throw new Error('ACP_BROWSER_FIXTURE_UNSAFE_NONCE')
  if (process.env.RBAC_BYPASS !== 'false') throw new Error('ACP_BROWSER_FIXTURE_RBAC_NOT_STRICT')

  const { randomUUID } = await import('node:crypto')
  const { createRequire } = await import('node:module')
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
  const { refreshAttendanceReportProjectionAnchor } = await import(
    '../../../packages/core-backend/src/attendance/attendance-multitable-cleaning-authority.ts'
  )
  const { getObjectFieldId, getObjectSheetId } = await import(
    '../../../packages/core-backend/src/multitable/provisioning.ts'
  )
  const plugin = createRequire(import.meta.url)('../../../plugins/plugin-attendance/index.cjs')
  const helpers = plugin.__attendanceReportFieldCatalogForTests as {
    mergeAttendanceReportFieldDefinitions: (
      records: unknown[],
      fieldIds: Record<string, string>,
      options: { rawAliasesAllowed: boolean },
    ) => Array<{ code: string }>
    buildAttendanceReportRecordsValueColumns: (items: Array<{ code: string }>) => Array<{ id: string }>
    buildAttendanceReportRecordSourceFingerprint: (
      logical: Record<string, unknown>,
      extras: { overtimeSegmentation: null },
    ) => string
  }
  if (!helpers) throw new Error('ACP_BROWSER_FIXTURE_PLUGIN_HELPERS_UNAVAILABLE')

  const orgId = randomUUID()
  const userId = randomUUID()
  const recordId = randomUUID()
  const calculationId = randomUUID()
  const operationId = randomUUID()
  const shiftId = randomUUID()
  const projectionId = `rec_${randomUUID()}`
  const catalogId = `acp_catalog_${nonce}`
  const projectId = `${orgId}:attendance`
  const sheetId = getObjectSheetId(projectId, 'attendance_report_records')
  const physical = (code: string) => getObjectFieldId(projectId, 'attendance_report_records', code)
  const workDate = '2026-08-01'

  const existingOrg = await pool.query('SELECT count(*)::int AS n FROM user_orgs WHERE org_id = $1', [orgId])
  if (existingOrg.rows[0].n !== 0) throw new Error('ACP_BROWSER_FIXTURE_ORG_ALREADY_EXISTS')

  await pool.query(
    `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin,
        activation_status, created_at, updated_at)
     VALUES ($1, $2, $1, 'ACP browser fixture', 'x', 'user', '["attendance:admin"]'::jsonb,
             true, false, 'activated', now(), now())`,
    [userId, `acp-browser-${nonce}@example.test`],
  )
  await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
  await pool.query(
    "INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'attendance:admin'), ($1, 'multitable:write') ON CONFLICT DO NOTHING",
    [userId],
  )
  await pool.query(
    "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'attendance_admin') ON CONFLICT DO NOTHING",
    [userId],
  )
  await pool.query(
    "INSERT INTO user_namespace_admissions (user_id, namespace, enabled) VALUES ($1, 'attendance', true) ON CONFLICT DO NOTHING",
    [userId],
  )

  await pool.query(
    `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
     VALUES ($1, 'legacy', 'acp-browser-realdb', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
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
  process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId

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
  if (!sourceDefinitionFingerprint) throw new Error('ACP_BROWSER_FIXTURE_SOURCE_DEFINITION_MISSING')
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
      `UPDATE attendance_records SET current_calculation_id = $1::uuid, projection_owner = 'w4'
      WHERE id = $2::uuid AND org_id = $3`,
      [calculationId, recordId, orgId],
    )
    await priorClient.query('COMMIT')
  } catch {
    await priorClient.query('ROLLBACK').catch(() => undefined)
    throw new Error('ACP_BROWSER_FIXTURE_PRIOR_FAILED')
  } finally {
    priorClient.release()
  }

  const items = helpers.mergeAttendanceReportFieldDefinitions([], {}, { rawAliasesAllowed: false })
  const logical: Record<string, unknown> = Object.fromEntries(
    helpers.buildAttendanceReportRecordsValueColumns(items).map(column => [column.id, null]),
  )
  Object.assign(logical, {
    row_key: `${orgId}:${userId}:${workDate}`,
    org_id: orgId,
    user_id: userId,
    employee_name: 'Synthetic employee',
    department: '',
    attendance_group: '',
    work_date: workDate,
  })
  const fingerprint = helpers.buildAttendanceReportRecordSourceFingerprint(logical, { overtimeSegmentation: null })
  const data = Object.fromEntries(Object.entries(logical).map(([code, value]) => [physical(code), value]))
  Object.assign(data, {
    [physical('source_fingerprint')]: fingerprint,
    [physical('cleaning_requested')]: true,
    [physical('cleaning_reason')]: 'synthetic verified correction',
    custom_keep: nonce,
  })
  await pool.query('INSERT INTO meta_sheets (id, name) VALUES ($1, $1), ($2, $2)', [sheetId, catalogId])
  await pool.query(
    `INSERT INTO plugin_multitable_object_registry (sheet_id, project_id, plugin_name, object_id)
     VALUES ($1, $3, 'plugin-attendance', 'attendance_report_records'),
            ($2, $3, 'plugin-attendance', 'attendance_report_field_catalog')`,
    [sheetId, catalogId, projectId],
  )
  const codes = [...Object.keys(logical), 'source_fingerprint', 'cleaning_requested', 'cleaning_reason']
  for (const code of codes) {
    await pool.query(
      'INSERT INTO meta_fields (id, sheet_id, name, type) VALUES ($1, $2, $3, $4)',
      [physical(code), sheetId, code, code === 'cleaning_requested' ? 'boolean' : 'string'],
    )
  }
  await pool.query(
    'INSERT INTO meta_records (id, sheet_id, data) VALUES ($1, $2, $3::jsonb)',
    [projectionId, sheetId, JSON.stringify(data)],
  )
  const anchorClient = await pool.connect()
  try {
    await anchorClient.query('BEGIN')
    await refreshAttendanceReportProjectionAnchor(
      (statement, params) => anchorClient.query(statement, params),
      { projectionRecordId: projectionId, canonicalRecordId: recordId, sourceFingerprint: fingerprint },
    )
    await anchorClient.query('COMMIT')
  } catch (error) {
    await anchorClient.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    anchorClient.release()
  }
  await pool.query(
    `INSERT INTO system_configs (key, value) VALUES ('attendance.settings', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ attendanceMultitableCleaningPolicy: { enabled: true } })],
  )

  const tokenResponse = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&tenantId=${encodeURIComponent(orgId)}`
      + `&roles=${encodeURIComponent('attendance_admin')}`
      + `&perms=${encodeURIComponent('attendance:admin,multitable:write')}`,
    { signal: AbortSignal.timeout(5_000) },
  )
  if (!tokenResponse.ok) throw new Error('ACP_BROWSER_FIXTURE_TOKEN_MINT_FAILED')
  const tokenBody = await tokenResponse.json() as { token?: unknown }
  if (typeof tokenBody.token !== 'string' || !tokenBody.token) {
    throw new Error('ACP_BROWSER_FIXTURE_TOKEN_MISSING')
  }
  const tokenClaims = JSON.parse(Buffer.from(tokenBody.token.split('.')[1], 'base64url').toString('utf8'))
  if (tokenClaims.tenantId !== orgId || tokenClaims.id !== userId) throw new Error('ACP_BROWSER_FIXTURE_TOKEN_BINDING')
  return { orgId, userId, token: tokenBody.token, recordId, projectionId, sheetId, physical, data }
}

export async function snapshot(
  pool: Pool,
  fixture: Acp1bBrowserFixture,
): Promise<Acp1bBrowserSnapshot> {
  const canonicalResult = await pool.query(
    `SELECT id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
            work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta,
            current_calculation_id, projection_owner, visibility_state, visibility_reason, updated_at
       FROM attendance_records WHERE id = $1::uuid AND org_id = $2`,
    [fixture.recordId, fixture.orgId],
  )
  const projectionResult = await pool.query(
    'SELECT data, version FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [fixture.projectionId, fixture.sheetId],
  )
  if (canonicalResult.rows.length !== 1 || projectionResult.rows.length !== 1) {
    throw new Error('ACP_BROWSER_FIXTURE_SNAPSHOT_MISSING')
  }
  const counts = (await pool.query(
    `SELECT
       (SELECT count(*)::int FROM attendance_record_result_edits
         WHERE org_id = $2 AND record_id = $1::uuid) AS edits,
       (SELECT count(*)::int FROM attendance_result_operations
         WHERE org_id = $2) AS operations,
       (SELECT count(*)::int FROM attendance_result_operations
         WHERE org_id = $2 AND resolved_record_id = $1::uuid
           AND source_ref LIKE 'attendance-cleaning-source-v1:%'
           AND state = 'completed') AS completed_operations,
       (SELECT count(*)::int FROM attendance_record_calculations
         WHERE org_id = $2 AND attendance_record_id = $1::uuid
           AND entrypoint = 'manual_override') AS manual_override_calculations,
       (SELECT count(*)::int FROM attendance_result_event_outbox outbox
         JOIN attendance_result_operations operation
           ON operation.org_id = outbox.org_id AND operation.entrypoint = outbox.entrypoint
          AND operation.operation_id = outbox.operation_id
         WHERE operation.org_id = $2 AND operation.resolved_record_id = $1::uuid
           AND operation.source_ref LIKE 'attendance-cleaning-source-v1:%') AS events,
       (SELECT count(*)::int FROM attendance_record_result_edits
         WHERE org_id = $2 AND record_id = $1::uuid
           AND notification_delivery_id IS NOT NULL) AS notified,
       (SELECT count(*)::int FROM meta_record_revisions WHERE sheet_id = $3 AND record_id = $4) AS proposal_revisions,
       (SELECT count(*)::int FROM meta_record_version_markers WHERE sheet_id = $3 AND record_id = $4) AS proposal_markers`,
    [fixture.recordId, fixture.orgId, fixture.sheetId, fixture.projectionId],
  )).rows[0]
  return {
    canonical: canonicalResult.rows[0],
    projection: projectionResult.rows[0],
    edits: counts.edits,
    operations: counts.operations,
    completedOperations: counts.completed_operations,
    manualOverrideCalculations: counts.manual_override_calculations,
    events: counts.events,
    notified: counts.notified,
    proposalRevisions: counts.proposal_revisions,
    proposalMarkers: counts.proposal_markers,
  }
}

export async function revoke(pool: Pool, fixture: Acp1bBrowserFixture): Promise<void> {
  const result = await pool.query(
    'UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2 AND is_active = true',
    [fixture.userId, fixture.orgId],
  )
  if (result.rowCount !== 1) throw new Error('ACP_BROWSER_FIXTURE_REVOKE_FAILED')
}
