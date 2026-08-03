/**
 * W4C-3c P05/P15/P16 plugin HTTP route tests through the actual plugin loader.
 * Covers auth, capability mismatch, org boundary, stable operationId requirement,
 * conflict/zero-write failures for manual_edit / recompute / ops_retirement.
 *
 * Uses a dynamic free port (MetaSheetServer port: 0) — never hard-collides on 7778.
 * Tests fail closed when database/loopback is unavailable (no silent skip-after-start).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'
import { appendOperatorRetirementCalculationV1 } from '../../src/attendance/w4c3c-ops-retirement'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import {
  computeAttendanceProvenanceFingerprintV1,
  computeAttendanceSemanticInputFingerprintV1,
} from '../../src/attendance/w4c0-fingerprints'
import { computeAttendanceSourceDefinitionFingerprintV1 } from '../../src/attendance/w4c1-fingerprints'
import { ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1 } from '../../src/attendance/w4c1-segment-calculator'
import { parseAttendanceW4ShadowDiff } from '../../src/services/AttendanceW4CalculationDetail'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

type JsonResponse = { status: number; body: Record<string, any> | null; raw: string }

function canListen(): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = options.body ? JSON.stringify(options.body) : null
    const request = http.request({
      method: options.method ?? 'GET',
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...options.headers,
      },
    }, (response) => {
      let raw = ''
      response.on('data', (chunk) => { raw += String(chunk) })
      response.on('end', () => {
        let body: Record<string, any> | null = null
        try { body = raw ? JSON.parse(raw) as Record<string, any> : null } catch { body = null }
        resolve({ status: response.statusCode ?? 0, body, raw })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

describeIfDatabase('W4C-3c record operation routes (real plugin, real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  let serverReady = false
  const pluginRequire = createRequire(import.meta.url)
  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    skipPlugins: process.env.SKIP_PLUGINS,
    port: process.env.PORT,
    rollout: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
  }

  function requireServer() {
    if (!serverReady || !baseUrl) {
      throw new Error('W4C3C_ROUTE_TEST_SERVER_NOT_READY')
    }
  }

  async function mintToken(userId: string, perms = '*:*'): Promise<string> {
    requireServer()
    const response = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`,
    )
    const token = response.body?.token
    if (typeof token !== 'string' || !token) throw new Error(`failed to mint token: ${response.raw}`)
    return token
  }

  async function seedOrgRollout(
    orgId: string,
    actorId: string,
    target: 'legacy' | 'shadow' | 'authoritative' = 'authoritative',
  ) {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3c-route-test', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
      [orgId, actorId],
    )
    if (target === 'legacy') {
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
      return
    }
    // Legal rollout progression only (guard forbids direct insert as authoritative).
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'shadow', prior_state = 'legacy', version = 2
        WHERE org_id = $1`,
      [orgId],
    )
    if (target === 'shadow') {
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
      return
    }
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'eligible', prior_state = 'shadow', version = 3
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'authoritative', prior_state = 'eligible', version = 4
        WHERE org_id = $1`,
      [orgId],
    )
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
  }

  async function seedUser(options: {
    orgId?: string
    permission?: string | null
    isActive?: boolean
    activationStatus?: string
    membershipActive?: boolean
    platformAdmin?: boolean
    emptyPermissions?: boolean
  } = {}) {
    requireServer()
    const orgId = options.orgId ?? randomUUID()
    const userId = randomUUID()
    const permissions = options.emptyPermissions
      ? []
      : options.permission === null
        ? []
        : [options.permission ?? 'attendance:admin']
    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-3c fixture', 'x', 'user', $3::jsonb,
               $4, false, $5, now(), now())`,
      [
        userId,
        `w4c3c-route-${userId}@example.test`,
        JSON.stringify(permissions),
        options.isActive !== false,
        options.activationStatus ?? 'activated',
      ],
    )
    if (options.membershipActive !== false || options.orgId) {
      await pool.query(
        'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)',
        [userId, orgId, options.membershipActive !== false],
      )
    }
    if (options.platformAdmin) {
      await pool.query(
        "INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING",
        [userId],
      )
    }
    return {
      orgId,
      userId,
      token: await mintToken(userId, permissions[0] ?? 'attendance:read'),
    }
  }

  async function seedAdmin(permission = 'attendance:admin') {
    const fixture = await seedUser({ permission })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'authoritative')
    return fixture
  }

  async function seedRecord(
    orgId: string,
    userId: string,
    status = 'late',
    workDate = '2026-08-01',
  ) {
    const recordId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at,
          work_minutes, late_minutes, early_leave_minutes, status, is_workday,
          meta, projection_owner, visibility_state, visibility_reason, updated_at)
       VALUES ($1::uuid, $2, $3, $4::date, 'UTC', $5::timestamptz, $6::timestamptz, 400, 15, 0, $7, true,
               '{}'::jsonb, 'legacy_untracked', 'active', 'active', now())`,
      [recordId, userId, orgId, workDate, `${workDate}T01:10:00.000Z`, `${workDate}T10:00:00.000Z`, status],
    )
    return { recordId, workDate }
  }

  async function seedAuthoritativePrior(
    orgId: string,
    userId: string,
    recordId: string,
    workDate: string,
    mode: 'shadow' | 'authoritative' = 'authoritative',
  ) {
    const calculationId = randomUUID()
    const operationId = randomUUID()
    const shiftId = randomUUID()
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
    const provenanceFingerprint = computeAttendanceProvenanceFingerprintV1(provenance)
    const sourceDefinitionFingerprint = computeAttendanceSourceDefinitionFingerprintV1({ attribution, context })
    if (!sourceDefinitionFingerprint) throw new Error('W4C3C_ROUTE_TEST_SOURCE_DEFINITION_MISSING')

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_record_calculations (
            id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
            engine_version, snapshot_schema_version, operation_id,
            semantic_input_fingerprint, provenance_fingerprint, source_definition_fingerprint,
            attribution_snapshot, context_snapshot, segment_snapshot, evidence_snapshot,
            approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
            outcome, outcome_reason_code, projection_effect, expected_segment_count,
            projected_status, projected_first_in_at, projected_last_out_at,
            projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
            projected_daily_fingerprint, actor_id, correlation_id
          ) VALUES (
            $1::uuid, $2, $3::uuid, 1, 'calculation', $19, 'live',
            $4, 1, $5::uuid, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
            '[]'::jsonb, $13::jsonb, 'append', $20,
            'completed', 'calculated', $21, 1,
            'late', $14::timestamptz, $15::timestamptz, 400, 15, 0,
            $16, $17, $18
          )`,
        [
          calculationId,
          orgId,
          recordId,
          ATTENDANCE_W4_SEGMENT_ENGINE_VERSION_V1,
          operationId,
          semanticFingerprint,
          provenanceFingerprint,
          sourceDefinitionFingerprint,
          JSON.stringify(attribution),
          JSON.stringify(context),
          JSON.stringify(segments),
          JSON.stringify(evidence),
          JSON.stringify(provenance),
          `${workDate}T01:10:00.000Z`,
          `${workDate}T10:00:00.000Z`,
          'e'.repeat(64),
          userId,
          `route-prior:${calculationId}`,
          mode,
          mode === 'authoritative' ? 'segment_authoritative' : 'legacy_shadow',
          mode === 'authoritative' ? 'set_active' : 'none',
        ],
      )
      await client.query(
        `INSERT INTO attendance_record_segments (
            org_id, record_id, calculation_id, segment_index,
            expected_start_at, expected_end_at, actual_in_at, actual_out_at,
            work_minutes, late_minutes, early_leave_minutes, status,
            status_reasons, matched_evidence_refs, unmatched_evidence_refs
          ) VALUES (
            $1, $2::uuid, $3::uuid, 0,
            $4::timestamptz, $5::timestamptz, $4::timestamptz, $5::timestamptz,
            400, 15, 0, 'late', '["late_check_in"]'::jsonb, '[]'::jsonb, '[]'::jsonb
          )`,
        [orgId, recordId, calculationId, `${workDate}T01:10:00.000Z`, `${workDate}T10:00:00.000Z`],
      )
      if (mode === 'authoritative') {
        await client.query(
          `UPDATE attendance_records
              SET current_calculation_id = $1::uuid,
                  projection_owner = 'w4',
                  visibility_state = 'active',
                  visibility_reason = 'active'
            WHERE id = $2::uuid AND org_id = $3`,
          [calculationId, recordId, orgId],
        )
      }
      await client.query('COMMIT')
      return { calculationId, calculationVersion: 1 }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async function assertZeroW4ResultDml(recordId: string) {
    const calcs = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_record_calculations
        WHERE attendance_record_id = $1::uuid`,
      [recordId],
    )
    expect(Number(calcs.rows[0].n)).toBe(0)
    const rec = await pool.query(
      `SELECT current_calculation_id, visibility_state, visibility_reason, projection_owner
         FROM attendance_records WHERE id = $1::uuid`,
      [recordId],
    )
    expect(rec.rows[0]?.current_calculation_id).toBeNull()
    expect(rec.rows[0]?.visibility_state).toBe('active')
    expect(rec.rows[0]?.visibility_reason).not.toBe('operator_retirement')
    const edits = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_record_result_edits
        WHERE record_id = $1::uuid`,
      [recordId],
    )
    expect(Number(edits.rows[0].n)).toBe(0)
  }

  function recordBoundaryForTests(): {
    execute: (input: {
      kind: 'manual_edit' | 'recompute' | 'ops_retirement'
      operationId: string | null
      correlationId: string
      routeInput: Record<string, unknown>
    }) => Promise<unknown>
  } {
    const plugin = pluginRequire('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4RecordOperationBoundaryForTests?: {
        execute: (input: unknown) => Promise<unknown>
      }
    }
    const boundary = plugin.__attendanceW4RecordOperationBoundaryForTests
    if (!boundary || typeof boundary.execute !== 'function') {
      throw new Error('W4C3C_RECORD_BOUNDARY_TEST_SEAM_UNAVAILABLE')
    }
    return boundary
  }

  beforeAll(async () => {
    if (!dbUrl) throw new Error('W4C3C_ROUTE_TEST_REQUIRES_DATABASE')
    if (!(await canListen())) throw new Error('W4C3C_ROUTE_TEST_REQUIRES_LOOPBACK')
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    // Reserve a free port via OS assignment; restore prior PORT after.
    // Do not hardcode 7778 (collides with concurrent suites).
    delete process.env.PORT
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const loaded = await import('../../src/index')
    server = new loaded.MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address =
      typeof (server as { getAddress?: () => unknown }).getAddress === 'function'
        ? (server as { getAddress: () => unknown }).getAddress()
        : server.httpServer?.address()
    if (!address || typeof address === 'string') {
      throw new Error('W4C3C_ROUTE_TEST_SERVER_ADDRESS_UNAVAILABLE')
    }
    baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`
    pool = new Pool({ connectionString: dbUrl })
    serverReady = true
  }, 120_000)

  afterEach(() => {
    const plugin = pluginRequire('../../../../plugins/plugin-attendance/index.cjs') as {
      resetAttendanceSettingsCacheForTests?: () => void
    }
    plugin.resetAttendanceSettingsCacheForTests?.()
  })

  afterAll(async () => {
    if (priorEnv.databaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorEnv.databaseUrl
    if (priorEnv.rbacBypass === undefined) delete process.env.RBAC_BYPASS
    else process.env.RBAC_BYPASS = priorEnv.rbacBypass
    if (priorEnv.skipPlugins === undefined) delete process.env.SKIP_PLUGINS
    else process.env.SKIP_PLUGINS = priorEnv.skipPlugins
    if (priorEnv.port === undefined) delete process.env.PORT
    else process.env.PORT = priorEnv.port
    if (priorEnv.rollout === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorEnv.rollout
    await server?.stop?.().catch(() => undefined)
    await pool?.end().catch(() => undefined)
  })

  it('plugin source: routes require client/operator operationId and never randomUUID fallback', () => {
    requireServer()
    const pluginPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../plugins/plugin-attendance/index.cjs',
    )
    const source = readFileSync(pluginPath, 'utf8')
    expect(source).toMatch(/policy: z\.enum\(\['frozen_prior', 'current_policy'\]\)[\s\S]{0,200}operationId: z\.string\(\)\.uuid\(\)/)
    expect(source).toMatch(/ticket: z\.string\(\)\.min\(1\)\.max\(128\),[\s\S]{0,120}operationId: z\.string\(\)\.uuid\(\)/)
    const recomputeBlock = source.slice(
      source.indexOf("'/api/attendance/records/:id/recompute'"),
      source.indexOf("'/api/attendance/records/:id/ops-retirement'"),
    )
    const retirementBlock = source.slice(
      source.indexOf("'/api/attendance/records/:id/ops-retirement'"),
      source.indexOf("'/api/attendance/summary'"),
    )
    expect(recomputeBlock).not.toMatch(/crypto\.randomUUID\(\)/)
    expect(retirementBlock).not.toMatch(/crypto\.randomUUID\(\)/)
    expect(source).not.toMatch(/currentPolicyContext[\s\S]{0,400}segments:\s*\[\]/)
    expect(source).toMatch(/buildW4ShadowFrozenContextV1/)
    expect(source).toMatch(/ATTENDANCE_RESULT_EDIT_IDEMPOTENCY_CONFLICT/)
    // Complete payload congruence (not status-only): after_snapshot + reason + evidence.
    expect(source).toMatch(/sameAfter/)
    expect(source).toMatch(/sameEvidence/)
    expect(source).toMatch(/after_snapshot/)

    const manualAdapter = source.slice(
      source.indexOf('const manualEditAdapter ='),
      source.indexOf('const recomputeAdapter ='),
    )
    const w4Path = manualAdapter.slice(manualAdapter.indexOf("if (posture === 'authoritative' || posture === 'shadow')"))
    const editWindow = w4Path.indexOf('resolveAttendanceResultEditWindowContext')
    const appendCalculation = w4Path.indexOf('const result = await port.appendManualOverrideCalculation')
    const insertAudit = w4Path.indexOf('insertW4c3cManualResultEditAuditRow')
    const enqueueNotification = w4Path.indexOf('enqueueAttendanceResultEditNotification')
    const markNotification = w4Path.indexOf('markAttendanceResultEditNotificationStatus')
    const responseEdit = w4Path.indexOf('edit: mapResultEditRow(finalAuditRow)')
    const responseRecord = w4Path.indexOf('record: responseRecord')
    expect(editWindow).toBeGreaterThanOrEqual(0)
    expect(appendCalculation).toBeGreaterThan(editWindow)
    expect(insertAudit).toBeGreaterThan(appendCalculation)
    expect(enqueueNotification).toBeGreaterThan(insertAudit)
    expect(markNotification).toBeGreaterThan(insertAudit)
    expect(responseEdit).toBeGreaterThan(markNotification)
    expect(responseRecord).toBeGreaterThan(markNotification)
  })

  it('recompute without operationId is 400 validation (no server random)', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/recompute`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        'X-Org-Id': fixture.orgId,
      },
      body: { policy: 'frozen_prior' },
    })
    expect(response.status).toBe(400)
    expect(response.body?.error?.code || response.body?.ok).toBeTruthy()
  })

  it('ops-retirement without operationId is 400 validation (no server random)', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        'X-Org-Id': fixture.orgId,
      },
      body: { reason: 'cleanup', ticket: 'T-1' },
    })
    expect(response.status).toBe(400)
  })

  it('recompute and ops-retirement reject malformed record UUIDs before database casts', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const malformedRecordId = '------------------------------------'
    const cases = [
      {
        path: `/api/attendance/records/${malformedRecordId}/recompute`,
        body: {
          policy: 'frozen_prior',
          operationId: randomUUID(),
          expectedCalculationId: null,
          expectedCalculationVersion: null,
        },
      },
      {
        path: `/api/attendance/records/${malformedRecordId}/ops-retirement`,
        body: {
          reason: 'cleanup',
          ticket: 'T-BAD-ID',
          operationId: randomUUID(),
          expectedCalculationId: null,
          expectedCalculationVersion: null,
        },
      },
    ]
    for (const item of cases) {
      const response = await requestJson(`${baseUrl}${item.path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'X-Org-Id': fixture.orgId,
        },
        body: item.body,
      })
      expect(response.status, response.raw).toBe(400)
      expect(response.body?.error?.code).toBe('VALIDATION_ERROR')
    }
  })

  it('manual edit / recompute / retirement require auth', async () => {
    requireServer()
    const recordId = randomUUID()
    for (const pathSuffix of [
      '/api/attendance/anomaly-result-edits',
      `/api/attendance/records/${recordId}/recompute`,
      `/api/attendance/records/${recordId}/ops-retirement`,
    ]) {
      const response = await requestJson(`${baseUrl}${pathSuffix}`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          expectedCalculationId: null,
          expectedCalculationVersion: null,
          reason: 'x',
          ticket: 't',
          recordId,
          targetStatus: 'normal',
          idempotencyKey: randomUUID(),
          policy: 'frozen_prior',
        },
      })
      expect([401, 403]).toContain(response.status)
    }
  })

  it('capability/permission mismatch rejects non-admin callers before writes', async () => {
    requireServer()
    // Enforce real permission checks for this leg (suite default sets RBAC_BYPASS).
    const priorBypass = process.env.RBAC_BYPASS
    process.env.RBAC_BYPASS = 'false'
    try {
      const fixture = await seedAdmin('attendance:read')
      const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
      const op = randomUUID()
      const recompute = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/recompute`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
        body: {
          policy: 'frozen_prior',
          operationId: op,
          expectedCalculationId: null,
          expectedCalculationVersion: null,
        },
      })
      expect([403, 401]).toContain(recompute.status)

      const retirement = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
        body: {
          reason: 'cleanup',
          ticket: 'T-2',
          operationId: randomUUID(),
          expectedCalculationId: null,
          expectedCalculationVersion: null,
        },
      })
      expect([403, 401]).toContain(retirement.status)

      // Zero writes under denied capability.
      const calcs = await pool.query(
        `SELECT count(*)::int AS n FROM attendance_record_calculations
          WHERE attendance_record_id = $1::uuid`,
        [recordId],
      )
      expect(Number(calcs.rows[0].n)).toBe(0)
    } finally {
      if (priorBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = priorBypass
    }
  })

  it('org boundary: foreign org record is not found / not writable', async () => {
    requireServer()
    const a = await seedAdmin()
    const b = await seedAdmin()
    const { recordId } = await seedRecord(b.orgId, b.userId)
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${a.token}`, 'X-Org-Id': a.orgId },
      body: {
        reason: 'cross-org',
        ticket: 'T-CROSS',
        operationId: randomUUID(),
        expectedCalculationId: null,
        expectedCalculationVersion: null,
      },
    })
    expect([404, 409, 422, 403]).toContain(response.status)
    const still = await pool.query(
      `SELECT visibility_state, visibility_reason FROM attendance_records WHERE id = $1::uuid`,
      [recordId],
    )
    expect(still.rows[0]?.visibility_state).not.toBe('retired')
  })

  it('manual edit without complete prior fails closed (zero fabricated current write)', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'normal',
        reason: 'admin correction',
        operationId,
        idempotencyKey: operationId,
      },
    })
    if (response.status >= 200 && response.status < 300 && response.body?.ok) {
      const calcs = await pool.query(
        `SELECT attribution_snapshot, context_snapshot
           FROM attendance_record_calculations
          WHERE attendance_record_id = $1::uuid AND entrypoint = 'manual_override'`,
        [recordId],
      )
      for (const row of calcs.rows) {
        const attr = row.attribution_snapshot as { value?: { shiftId?: string; resolverVersion?: string } }
        expect(String(attr?.value?.shiftId || '')).not.toBe('manual-override')
        expect(String(attr?.value?.resolverVersion || '')).not.toMatch(/w4c3c-manual-override/)
      }
    } else {
      expect(response.status).toBeGreaterThanOrEqual(400)
    }
  })

  it('shadow manual edit persists a non-null parsed diff and preserves the legacy projection', async () => {
    requireServer()
    const fixture = await seedUser({ permission: 'attendance:admin' })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'shadow')
    const { recordId, workDate } = await seedRecord(fixture.orgId, fixture.userId)
    const prior = await seedAuthoritativePrior(
      fixture.orgId,
      fixture.userId,
      recordId,
      workDate,
      'shadow',
    )
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'normal',
        overrideMetrics: { workMinutes: 420, lateMinutes: 0 },
        reason: 'shadow compatibility correction',
        operationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion,
        idempotencyKey: operationId,
      },
    })
    expect(response.status, response.raw).toBe(200)
    expect(response.body?.data?.record?.status).toBe('normal')
    const calculationId = response.body?.data?.calculationId
    expect(calculationId).toEqual(expect.any(String))

    const record = await pool.query(
      `SELECT status, work_minutes, late_minutes, current_calculation_id
         FROM attendance_records WHERE id = $1::uuid AND org_id = $2`,
      [recordId, fixture.orgId],
    )
    expect(record.rows[0]).toMatchObject({
      status: 'normal',
      work_minutes: 420,
      late_minutes: 0,
      current_calculation_id: null,
    })
    const durable = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND entrypoint = 'manual_edit' AND operation_id = $2::uuid) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1 AND entrypoint = 'manual_edit' AND operation_id = $2::uuid) AS outbox,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE org_id = $1 AND attendance_record_id = $3::uuid) AS calculations,
         (SELECT count(*)::int FROM attendance_record_result_edits
           WHERE org_id = $1 AND record_id = $3::uuid AND notification_delivery_id IS NOT NULL) AS notified`,
      [fixture.orgId, operationId, recordId],
    )
    expect(durable.rows[0]).toMatchObject({ operations: 1, outbox: 1, calculations: 2, notified: 1 })

    const calculation = await pool.query(
      `SELECT shadow_diff_code, shadow_diff
         FROM attendance_record_calculations
        WHERE id = $1::uuid AND attendance_record_id = $2::uuid AND org_id = $3`,
      [calculationId, recordId, fixture.orgId],
    )
    expect(calculation.rows).toHaveLength(1)
    expect(parseAttendanceW4ShadowDiff(
      calculation.rows[0].shadow_diff_code,
      calculation.rows[0].shadow_diff,
    )).toEqual({
      schemaVersion: 1,
      code: 'status_changed',
      changedFields: ['status', 'workMinutes', 'lateMinutes'],
      absoluteMinuteDelta: 35,
      segmentCount: 1,
    })
  })

  it('shadow recompute persists a non-null parsed diff through the real route', async () => {
    requireServer()
    const fixture = await seedUser({ permission: 'attendance:admin' })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'shadow')
    const { recordId, workDate } = await seedRecord(fixture.orgId, fixture.userId)
    const prior = await seedAuthoritativePrior(
      fixture.orgId,
      fixture.userId,
      recordId,
      workDate,
      'shadow',
    )
    await pool.query(
      `UPDATE attendance_records
          SET status = 'normal', work_minutes = 420, late_minutes = 0
        WHERE id = $1::uuid AND org_id = $2`,
      [recordId, fixture.orgId],
    )
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/recompute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        policy: 'frozen_prior',
        operationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion,
      },
    })
    expect(response.status, response.raw).toBe(200)
    const calculationId = response.body?.data?.calculationId
    expect(calculationId).toEqual(expect.any(String))

    const calculation = await pool.query(
      `SELECT shadow_diff_code, shadow_diff
         FROM attendance_record_calculations
        WHERE id = $1::uuid AND attendance_record_id = $2::uuid AND org_id = $3`,
      [calculationId, recordId, fixture.orgId],
    )
    expect(calculation.rows).toHaveLength(1)
    expect(parseAttendanceW4ShadowDiff(
      calculation.rows[0].shadow_diff_code,
      calculation.rows[0].shadow_diff,
    )).toEqual({
      schemaVersion: 1,
      code: 'status_changed',
      changedFields: ['status', 'workMinutes', 'lateMinutes'],
      absoluteMinuteDelta: 120,
      segmentCount: 1,
    })
  })

  it('shadow status-only edit normalizes the W4 projection and legacy parent identically', async () => {
    requireServer()
    const fixture = await seedUser({ permission: 'attendance:admin' })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'shadow')
    const { recordId, workDate } = await seedRecord(fixture.orgId, fixture.userId)
    const prior = await seedAuthoritativePrior(
      fixture.orgId,
      fixture.userId,
      recordId,
      workDate,
      'shadow',
    )
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'early_leave',
        reason: 'shadow status-only normalization',
        operationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion,
        idempotencyKey: operationId,
      },
    })
    expect(response.status, response.raw).toBe(200)
    const shadowCalculationId = response.body?.data?.calculationId
    expect(shadowCalculationId).toEqual(expect.any(String))

    const stored = await pool.query(
      `SELECT r.status, r.work_minutes, r.late_minutes, r.early_leave_minutes,
              r.current_calculation_id::text AS current_calculation_id,
              c.projected_status, c.projected_work_minutes,
              c.projected_late_minutes, c.projected_early_leave_minutes
         FROM attendance_records r
         JOIN attendance_record_calculations c
           ON c.id = $3::uuid AND c.attendance_record_id = r.id AND c.org_id = r.org_id
        WHERE r.id = $1::uuid AND r.org_id = $2`,
      [recordId, fixture.orgId, shadowCalculationId],
    )
    expect(stored.rows[0]).toMatchObject({
      status: 'early_leave',
      work_minutes: 400,
      late_minutes: 0,
      early_leave_minutes: 0,
      current_calculation_id: null,
      projected_status: 'early_leave',
      projected_work_minutes: 400,
      projected_late_minutes: 0,
      projected_early_leave_minutes: 0,
    })

  })

  it('shadow anomaly refresh freezes the latest calculation instead of the current pointer', async () => {
    requireServer()
    const fixture = await seedUser({ permission: 'attendance:admin' })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'shadow')
    const { recordId, workDate } = await seedRecord(fixture.orgId, fixture.userId)
    const current = await seedAuthoritativePrior(
      fixture.orgId,
      fixture.userId,
      recordId,
      workDate,
      'authoritative',
    )
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'late',
        reason: 'shadow latest calculation freeze',
        operationId,
        expectedCalculationId: current.calculationId,
        expectedCalculationVersion: current.calculationVersion,
        idempotencyKey: operationId,
      },
    })
    expect(response.status, response.raw).toBe(200)
    const shadowCalculationId = response.body?.data?.calculationId
    expect(shadowCalculationId).toEqual(expect.any(String))

    const listing = await requestJson(
      `${baseUrl}/api/attendance/anomalies?from=${workDate}&to=${workDate}`,
      { headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId } },
    )
    expect(listing.status, listing.raw).toBe(200)
    const item = listing.body?.data?.items?.find((candidate: { recordId?: string }) => candidate.recordId === recordId)
    expect(item).toMatchObject({
      recordId,
      expectedCalculationId: shadowCalculationId,
      expectedCalculationVersion: current.calculationVersion + 1,
      status: 'late',
      workMinutes: 400,
      lateMinutes: 15,
      earlyLeaveMinutes: 0,
    })
  })

  it('authoritative manual edit enforces the configured edit window before W4 result DML', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId, 'late', '2025-01-01')
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'normal',
        reason: 'expired authoritative correction',
        operationId,
        expectedCalculationId: null,
        expectedCalculationVersion: null,
        idempotencyKey: operationId,
      },
    })
    expect(response.status, response.raw).toBe(422)
    expect(response.body?.error?.code).toBe('ATTENDANCE_RESULT_EDIT_WINDOW_EXPIRED')
    await assertZeroW4ResultDml(recordId)
  })

  it('authoritative manual edit returns the frontend contract and replays without duplicate effects', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const workDate = new Date().toISOString().slice(0, 10)
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId, 'late', workDate)
    const prior = await seedAuthoritativePrior(fixture.orgId, fixture.userId, recordId, workDate)
    const operationId = randomUUID()
    const body = {
      recordId,
      targetStatus: 'normal',
      overrideMetrics: { workMinutes: 420, lateMinutes: 0, earlyLeaveMinutes: 0 },
      reason: 'authoritative response contract',
      operationId,
      expectedCalculationId: prior.calculationId,
      expectedCalculationVersion: prior.calculationVersion,
      idempotencyKey: operationId,
    }

    const first = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body,
    })
    expect(first.status, first.raw).toBe(200)
    expect(first.body?.data).toMatchObject({
      alreadyApplied: false,
      mode: 'authoritative',
      projectedStatus: 'normal',
      edit: {
        recordId,
        beforeStatus: 'late',
        afterStatus: 'normal',
        idempotencyKey: operationId,
        notificationSkippedReason: null,
      },
      record: {
        id: recordId,
        status: 'normal',
        workMinutes: 420,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
      },
    })
    expect(first.body?.data?.edit?.id).toBe(operationId)
    expect(first.body?.data?.edit?.notificationDeliveryId).toEqual(expect.any(String))
    expect(first.body?.data?.calculationId).toEqual(expect.any(String))
    expect(first.body?.data?.calculationId).not.toBe(prior.calculationId)
    expect(Object.keys(first.body?.data?.record ?? {}).sort()).toEqual([
      'earlyLeaveMinutes',
      'firstInAt',
      'id',
      'isWorkday',
      'lastOutAt',
      'lateMinutes',
      'meta',
      'orgId',
      'status',
      'timezone',
      'userId',
      'workDate',
      'workMinutes',
    ])

    const afterFirst = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND entrypoint = 'manual_edit' AND operation_id = $2::uuid) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1 AND entrypoint = 'manual_edit' AND operation_id = $2::uuid) AS outbox,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE org_id = $1 AND attendance_record_id = $3::uuid) AS calculations,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE org_id = $1 AND attendance_record_id = $3::uuid AND entrypoint = 'manual_override') AS manual_calculations,
         (SELECT count(*)::int FROM attendance_record_result_edits
           WHERE org_id = $1 AND record_id = $3::uuid AND idempotency_key = $2::text) AS edits,
         (SELECT count(*)::int FROM attendance_record_result_edits e
           JOIN attendance_notification_deliveries d ON d.id = e.notification_delivery_id
          WHERE e.org_id = $1 AND e.record_id = $3::uuid AND e.idempotency_key = $2::text) AS deliveries,
         (SELECT (r.meta->'manual_result_edit'->>'auditId') = e.id::text
            FROM attendance_records r
            JOIN attendance_record_result_edits e
              ON e.org_id = r.org_id AND e.record_id = r.id
           WHERE r.org_id = $1 AND r.id = $3::uuid AND e.idempotency_key = $2::text) AS marker_audit_matches,
         (SELECT current_calculation_id::text FROM attendance_records
          WHERE org_id = $1 AND id = $3::uuid) AS current_calculation_id`,
      [fixture.orgId, operationId, recordId],
    )
    expect(afterFirst.rows[0]).toMatchObject({
      operations: 1,
      outbox: 1,
      calculations: 2,
      manual_calculations: 1,
      edits: 1,
      deliveries: 1,
      marker_audit_matches: true,
      current_calculation_id: first.body?.data?.calculationId,
    })

    const replay = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body,
    })
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body).toEqual(first.body)

    const afterReplay = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND entrypoint = 'manual_edit' AND operation_id = $2::uuid) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1 AND entrypoint = 'manual_edit' AND operation_id = $2::uuid) AS outbox,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE org_id = $1 AND attendance_record_id = $3::uuid) AS calculations,
         (SELECT count(*)::int FROM attendance_record_result_edits
           WHERE org_id = $1 AND record_id = $3::uuid AND idempotency_key = $2::text) AS edits,
         (SELECT count(*)::int FROM attendance_notification_deliveries d
           JOIN attendance_record_result_edits e ON e.notification_delivery_id = d.id
          WHERE e.org_id = $1 AND e.record_id = $3::uuid AND e.idempotency_key = $2::text) AS deliveries`,
      [fixture.orgId, operationId, recordId],
    )
    expect(afterReplay.rows[0]).toMatchObject({
      operations: 1,
      outbox: 1,
      calculations: 2,
      edits: 1,
      deliveries: 1,
    })
  })

  it('authoritative status-only edit freezes normalized metrics and refreshes late-tier meta', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const workDate = new Date().toISOString().slice(0, 10)
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId, 'late', workDate)
    await pool.query(
      `UPDATE attendance_records
          SET meta = '{"severe_late_count":1,"severe_late_minutes":15,"absence_late_count":1}'::jsonb
        WHERE id = $1::uuid AND org_id = $2`,
      [recordId, fixture.orgId],
    )
    const prior = await seedAuthoritativePrior(fixture.orgId, fixture.userId, recordId, workDate)
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'normal',
        reason: 'status-only normalization',
        operationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion,
        idempotencyKey: operationId,
      },
    })
    expect(response.status, response.raw).toBe(200)
    expect(response.body?.data?.record).toMatchObject({
      status: 'normal',
      workMinutes: 400,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    })

    const stored = await pool.query(
      `SELECT r.status, r.work_minutes, r.late_minutes, r.early_leave_minutes, r.meta,
              c.projected_status, c.projected_work_minutes,
              c.projected_late_minutes, c.projected_early_leave_minutes,
              c.manual_override_snapshot
         FROM attendance_records r
         JOIN attendance_record_calculations c ON c.id = r.current_calculation_id
        WHERE r.id = $1::uuid AND r.org_id = $2`,
      [recordId, fixture.orgId],
    )
    expect(stored.rows[0]).toMatchObject({
      status: 'normal',
      work_minutes: 400,
      late_minutes: 0,
      early_leave_minutes: 0,
      projected_status: 'normal',
      projected_work_minutes: 400,
      projected_late_minutes: 0,
      projected_early_leave_minutes: 0,
    })
    expect(stored.rows[0].meta).toMatchObject({
      severe_late_count: 0,
      severe_late_minutes: 0,
      absence_late_count: 0,
    })
    expect(stored.rows[0].manual_override_snapshot?.operations).toEqual([
      { op: 'set', field: 'status', value: 'normal' },
      { op: 'set', field: 'workMinutes', value: 400 },
      { op: 'set', field: 'lateMinutes', value: 0 },
      { op: 'set', field: 'earlyLeaveMinutes', value: 0 },
    ])
  })

  it('authoritative manual edit rejects a stale calculation version with zero durable effects', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const workDate = new Date().toISOString().slice(0, 10)
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId, 'late', workDate)
    const prior = await seedAuthoritativePrior(fixture.orgId, fixture.userId, recordId, workDate)
    const operationId = randomUUID()

    const response = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'normal',
        reason: 'stale expected version must fail',
        operationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion + 1,
        idempotencyKey: operationId,
      },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error?.code).toBe('ATTENDANCE_RECORD_VERSION_CONFLICT')

    const residue = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND operation_id = $2::uuid) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1 AND operation_id = $2::uuid) AS outbox,
         (SELECT count(*)::int FROM attendance_record_result_edits
           WHERE org_id = $1 AND idempotency_key = $2::text) AS edits,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE org_id = $1 AND attendance_record_id = $3::uuid) AS calculations`,
      [fixture.orgId, operationId, recordId],
    )
    expect(residue.rows[0]).toMatchObject({ operations: 0, outbox: 0, edits: 0, calculations: 1 })
  })

  it('shadow manual edit rejects a superseded latest calculation with zero second-operation effects', async () => {
    requireServer()
    const fixture = await seedUser({ permission: 'attendance:admin' })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'shadow')
    const { recordId, workDate } = await seedRecord(fixture.orgId, fixture.userId)
    const prior = await seedAuthoritativePrior(
      fixture.orgId,
      fixture.userId,
      recordId,
      workDate,
      'shadow',
    )
    const firstOperationId = randomUUID()
    const first = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'normal',
        reason: 'first shadow override',
        operationId: firstOperationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion,
        idempotencyKey: firstOperationId,
      },
    })
    expect(first.status, first.raw).toBe(200)

    const staleOperationId = randomUUID()
    const stale = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'adjusted',
        reason: 'stale shadow override',
        operationId: staleOperationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion,
        idempotencyKey: staleOperationId,
      },
    })
    expect(stale.status, stale.raw).toBe(409)
    expect(stale.body?.error?.code).toBe('ATTENDANCE_RECORD_VERSION_CONFLICT')

    const residue = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND operation_id = $2::uuid) AS stale_operations,
         (SELECT count(*)::int FROM attendance_record_result_edits
           WHERE org_id = $1 AND record_id = $3::uuid) AS edits,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE org_id = $1 AND attendance_record_id = $3::uuid) AS calculations,
         (SELECT current_calculation_id FROM attendance_records
           WHERE org_id = $1 AND id = $3::uuid) AS current_calculation_id`,
      [fixture.orgId, staleOperationId, recordId],
    )
    expect(residue.rows[0]).toMatchObject({
      stale_operations: 0,
      edits: 1,
      calculations: 2,
      current_calculation_id: null,
    })
  })

  it('source-level capability matrix positive control is present in the host boundary export', () => {
    requireServer()
    const boundaryPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/attendance/w4c3c-record-operation-boundary.ts',
    )
    const source = readFileSync(boundaryPath, 'utf8')
    expect(source).toMatch(/assertRecordOperationCapabilityMatchV1/)
    expect(source).toMatch(/manual_edit:\s*'manual_edit'/)
    expect(source).toMatch(/ops_retirement:\s*'retirement'/)
    const targetIdentity = source.indexOf('createVerifiedAttendanceCalculationTargetIdentityV1({')
    const targetLock = source.indexOf('acquireAttendanceCalculationTargetLocks(trx, [targetIdentity])')
    const secondPrepare = source.indexOf('const prepared = input.operationId === null')
    expect(targetIdentity).toBeGreaterThanOrEqual(0)
    expect(targetLock).toBeGreaterThan(targetIdentity)
    expect(secondPrepare).toBeGreaterThan(targetLock)
    expect(source.match(/targetWorkDate:/g)).toHaveLength(1)
    const pluginPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../plugins/plugin-attendance/index.cjs',
    )
    const pluginSource = readFileSync(pluginPath, 'utf8')
    const manualApplyPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src/attendance/w4c3c-manual-edit-apply.ts',
    )
    const manualApplySource = readFileSync(manualApplyPath, 'utf8')
    // Exact product bind (no null soft-pass) inside resolveRecordOperationAdminActorPosture.
    expect(pluginSource).toMatch(
      /tokenSubjectUserId !== actorId[\s\S]{0,120}Authenticated subject does not match the record operation actor/,
    )
    expect(pluginSource).toMatch(/resolveRecordOperationAdminActorPosture/)
    expect(pluginSource).toMatch(/W4C3C_OPS_RETIREMENT_REQUIRES_AUTHORITATIVE_POSTURE/)
    expect(manualApplySource).not.toMatch(/skipClosedCycleGuard/)
  })

  it('authoritative frozen-prior recompute replays without mutable-pointer conflicts', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const workDate = new Date().toISOString().slice(0, 10)
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId, 'late', workDate)
    const prior = await seedAuthoritativePrior(fixture.orgId, fixture.userId, recordId, workDate)
    const operationId = randomUUID()
    const request = {
      method: 'POST' as const,
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        policy: 'frozen_prior',
        operationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion,
      },
    }

    const first = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/recompute`, request)
    expect(first.status, first.raw).toBe(200)
    const replay = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/recompute`, request)
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body).toEqual(first.body)

    const durable = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND entrypoint = 'recompute' AND operation_id = $2::uuid) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1 AND entrypoint = 'recompute' AND operation_id = $2::uuid) AS outbox,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE org_id = $1 AND attendance_record_id = $3::uuid) AS calculations`,
      [fixture.orgId, operationId, recordId],
    )
    expect(durable.rows[0]).toMatchObject({ operations: 1, outbox: 1, calculations: 2 })
  })

  it('authoritative recompute rejects a stale expected calculation with zero durable effects', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const workDate = new Date().toISOString().slice(0, 10)
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId, 'late', workDate)
    const prior = await seedAuthoritativePrior(fixture.orgId, fixture.userId, recordId, workDate)
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/recompute`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        policy: 'frozen_prior',
        operationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion + 1,
      },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error?.code).toBe('ATTENDANCE_RECORD_VERSION_CONFLICT')

    const residue = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND operation_id = $2::uuid) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox
           WHERE org_id = $1 AND operation_id = $2::uuid) AS outbox,
         (SELECT count(*)::int FROM attendance_record_calculations
           WHERE org_id = $1 AND attendance_record_id = $3::uuid) AS calculations`,
      [fixture.orgId, operationId, recordId],
    )
    expect(residue.rows[0]).toMatchObject({ operations: 0, outbox: 0, calculations: 1 })
  })

  it('current-policy recompute admits only a timezone accepted by the single host validator', () => {
    requireServer()
    const plugin = pluginRequire('../../../../plugins/plugin-attendance/index.cjs') as {
      __attendanceW4CurrentPolicyTimezoneForTests?: (
        workContext: Record<string, unknown>,
        record: Record<string, unknown>,
      ) => string
    }
    const requireTimezone = plugin.__attendanceW4CurrentPolicyTimezoneForTests
    expect(typeof requireTimezone).toBe('function')
    expect(requireTimezone?.({ rule: { timezone: 'Asia/Taipei' } }, { timezone: 'UTC' })).toBe('Asia/Taipei')
    expect(() => requireTimezone?.({ rule: { timezone: '+08:00' } }, { timezone: 'UTC' })).toThrowError(
      expect.objectContaining({
        status: 409,
        code: 'W4C3C_RECOMPUTE_CURRENT_POLICY_INCOMPLETE',
      }),
    )
    expect(() => requireTimezone?.({ rule: {} }, {})).toThrowError(
      expect.objectContaining({
        status: 409,
        code: 'W4C3C_RECOMPUTE_CURRENT_POLICY_INCOMPLETE',
      }),
    )

    const pluginPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../plugins/plugin-attendance/index.cjs',
    )
    const source = readFileSync(pluginPath, 'utf8')
    const currentPolicyBlock = source.slice(
      source.indexOf("if (prepared.state.policy === 'current_policy')"),
      source.indexOf('const result = await port.appendRecomputeCalculation', source.indexOf("if (prepared.state.policy === 'current_policy')")),
    )
    expect(currentPolicyBlock).toMatch(/requireStrictCurrentPolicyTimezone/)
    expect(currentPolicyBlock).not.toMatch(/\|\|\s*'UTC'/)
  })

  it('route positive: attendance admin may retire under authoritative posture', async () => {
    requireServer()
    const fixture = await seedAdmin('attendance:admin')
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    const operationId = randomUUID()
    const request = {
      method: 'POST' as const,
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        reason: 'admin retirement positive',
        ticket: 'T-ADMIN-OK',
        operationId,
        expectedCalculationId: null,
        expectedCalculationVersion: null,
      },
    }
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      ...request,
    })
    expect(response.status, response.raw).toBe(200)
    expect(response.body?.ok !== false).toBe(true)
    const replay = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, request)
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body).toEqual(response.body)
    const after = await pool.query(
      `SELECT visibility_reason, current_calculation_id IS NOT NULL AS has_pointer,
              (SELECT count(*)::int FROM attendance_result_operations
                WHERE org_id = $2 AND entrypoint = 'ops_retirement' AND operation_id = $3::uuid) AS operations,
              (SELECT count(*)::int FROM attendance_result_event_outbox
                WHERE org_id = $2 AND entrypoint = 'ops_retirement' AND operation_id = $3::uuid) AS outbox,
              (SELECT count(*)::int FROM attendance_record_calculations
                WHERE org_id = $2 AND attendance_record_id = $1::uuid) AS calculations
         FROM attendance_records WHERE id = $1::uuid`,
      [recordId, fixture.orgId, operationId],
    )
    expect(after.rows[0]?.visibility_reason).toBe('operator_retirement')
    expect(after.rows[0]?.has_pointer).toBe(true)
    // First retirement of a legacy-untracked record writes one truthful baseline
    // plus one reversal; replay must not add a third calculation.
    expect(after.rows[0]).toMatchObject({ operations: 1, outbox: 1, calculations: 2 })
  })

  it('authoritative ops retirement rejects a stale expected calculation with zero durable effects', async () => {
    requireServer()
    const fixture = await seedAdmin('attendance:admin')
    const workDate = new Date().toISOString().slice(0, 10)
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId, 'late', workDate)
    const prior = await seedAuthoritativePrior(fixture.orgId, fixture.userId, recordId, workDate)
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        reason: 'stale retirement must fail',
        ticket: 'T-STALE',
        operationId,
        expectedCalculationId: prior.calculationId,
        expectedCalculationVersion: prior.calculationVersion + 1,
      },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error?.code).toBe('ATTENDANCE_RECORD_VERSION_CONFLICT')

    const residue = await pool.query(
      `SELECT current_calculation_id::text AS current_calculation_id,
              visibility_reason,
              (SELECT count(*)::int FROM attendance_result_operations
                WHERE org_id = $2 AND operation_id = $3::uuid) AS operations,
              (SELECT count(*)::int FROM attendance_result_event_outbox
                WHERE org_id = $2 AND operation_id = $3::uuid) AS outbox,
              (SELECT count(*)::int FROM attendance_record_calculations
                WHERE org_id = $2 AND attendance_record_id = $1::uuid) AS calculations
         FROM attendance_records
        WHERE org_id = $2 AND id = $1::uuid`,
      [recordId, fixture.orgId, operationId],
    )
    expect(residue.rows[0]).toMatchObject({
      current_calculation_id: prior.calculationId,
      visibility_reason: 'active',
      operations: 0,
      outbox: 0,
      calculations: 1,
    })
  })

  it('live punch cannot reactivate an operator-retired parent and rolls back its event', async () => {
    requireServer()
    const fixture = await seedUser({ permission: 'attendance:admin' })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'legacy')
    const { recordId, workDate } = await seedRecord(fixture.orgId, fixture.userId)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await appendOperatorRetirementCalculationV1({
        client: {
          query: (text, values) => client.query(text, values as unknown[]) as unknown as ReturnType<AttendanceW4TransactionClientV1['query']>,
        },
        orgId: fixture.orgId,
        recordId,
        expectedCalculationId: null,
        expectedCalculationVersion: null,
        operationId: randomUUID(),
        actorId: fixture.userId,
        correlationId: `retired-punch:${recordId}`,
        reason: 'route retirement fixture',
        ticket: 'T-RETIRED-PUNCH',
        mode: 'authoritative',
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    const before = await pool.query(
      `SELECT to_jsonb(r) AS record,
              (SELECT count(*)::int FROM attendance_events e
                WHERE e.org_id = r.org_id AND e.user_id = r.user_id AND e.work_date = r.work_date) AS event_count,
              (SELECT count(*)::int FROM attendance_record_calculations c
                WHERE c.attendance_record_id = r.id) AS calculation_count
         FROM attendance_records r
        WHERE r.id = $1::uuid`,
      [recordId],
    )
    expect(before.rows[0]?.record?.visibility_reason).toBe('operator_retirement')

    const response = await requestJson(`${baseUrl}/api/attendance/punch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        eventType: 'check_out',
        occurredAt: `${workDate}T11:00:00.000Z`,
        timezone: 'UTC',
        source: 'manual',
      },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error?.code).toBe('ATTENDANCE_RECORD_OPERATOR_RETIRED')

    const after = await pool.query(
      `SELECT to_jsonb(r) AS record,
              (SELECT count(*)::int FROM attendance_events e
                WHERE e.org_id = r.org_id AND e.user_id = r.user_id AND e.work_date = r.work_date) AS event_count,
              (SELECT count(*)::int FROM attendance_record_calculations c
                WHERE c.attendance_record_id = r.id) AS calculation_count
         FROM attendance_records r
        WHERE r.id = $1::uuid`,
      [recordId],
    )
    expect(after.rows[0]?.record).toEqual(before.rows[0]?.record)
    expect(after.rows[0]?.event_count).toBe(before.rows[0]?.event_count)
    expect(after.rows[0]?.calculation_count).toBe(before.rows[0]?.calculation_count)
  })

  it('in-tx auth: inactive user is rejected with zero W4 result DML', async () => {
    requireServer()
    // Seed org + record under an active admin, then attempt boundary with inactive actor.
    // HTTP mint+call may also fail at JWT activation gate; boundary proves the product in-tx check.
    const fixture = await seedAdmin()
    const inactive = await seedUser({
      orgId: fixture.orgId,
      permission: 'attendance:admin',
      isActive: false,
    })
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    // HTTP path (best-effort): may be 401 at hydrate or 403 at prepare — never 2xx.
    const http = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${inactive.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        reason: 'inactive',
        ticket: 'T-INACTIVE',
        operationId: randomUUID(),
        expectedCalculationId: null,
        expectedCalculationVersion: null,
      },
    })
    expect(http.status).toBeGreaterThanOrEqual(400)

    const boundary = recordBoundaryForTests()
    await expect(
      boundary.execute({
        kind: 'ops_retirement',
        operationId: randomUUID(),
        correlationId: `inactive:${recordId}`,
        routeInput: {
          orgId: fixture.orgId,
          actorId: inactive.userId,
          tokenSubjectUserId: inactive.userId,
          recordId,
          reason: 'inactive boundary',
          ticket: 'T-INACTIVE-B',
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    await assertZeroW4ResultDml(recordId)
  })

  it('in-tx auth: inactive user_orgs membership is rejected with zero W4 result DML', async () => {
    requireServer()
    const fixture = await seedAdmin()
    const outsider = await seedUser({
      orgId: fixture.orgId,
      permission: 'attendance:admin',
      membershipActive: false,
    })
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsider.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        reason: 'inactive membership',
        ticket: 'T-MEM',
        operationId: randomUUID(),
        expectedCalculationId: null,
        expectedCalculationVersion: null,
      },
    })
    expect(response.status, response.raw).toBe(403)
    expect(response.body?.error?.code).toBe('FORBIDDEN')
    await assertZeroW4ResultDml(recordId)
  })

  it('in-tx auth: missing attendance admin permission/role is rejected with zero W4 result DML', async () => {
    requireServer()
    // Do not use RBAC_BYPASS as evidence for this leg — force real middleware + in-tx checks.
    const priorBypass = process.env.RBAC_BYPASS
    process.env.RBAC_BYPASS = 'false'
    try {
      const fixture = await seedAdmin()
      const reader = await seedUser({
        orgId: fixture.orgId,
        permission: 'attendance:read',
      })
      const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
      const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${reader.token}`, 'X-Org-Id': fixture.orgId },
        body: {
          reason: 'no admin',
          ticket: 'T-NOADMIN',
          operationId: randomUUID(),
          expectedCalculationId: null,
          expectedCalculationVersion: null,
        },
      })
      expect([401, 403]).toContain(response.status)
      await assertZeroW4ResultDml(recordId)

      // Boundary path: in-tx posture rejects even if middleware were bypassed.
      const boundary = recordBoundaryForTests()
      await expect(
        boundary.execute({
          kind: 'recompute',
          operationId: randomUUID(),
          correlationId: `noadmin:${recordId}`,
          routeInput: {
            orgId: fixture.orgId,
            actorId: reader.userId,
            tokenSubjectUserId: reader.userId,
            recordId,
            policy: 'frozen_prior',
          },
        }),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
      await assertZeroW4ResultDml(recordId)
    } finally {
      if (priorBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = priorBypass
    }
  })

  it('in-tx auth: platform_admin (user_roles.admin) is a positive override without attendance:admin', async () => {
    requireServer()
    const subject = await seedAdmin()
    // Platform admin: empty permissions, no attendance:admin, user_roles.role_id='admin'.
    // Helper returns platform_admin before membership/permission checks (W4C-3b pattern).
    const platform = await seedUser({
      emptyPermissions: true,
      platformAdmin: true,
      membershipActive: false,
      orgId: subject.orgId,
    })
    const { recordId } = await seedRecord(subject.orgId, subject.userId)
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${platform.token}`, 'X-Org-Id': subject.orgId },
      body: {
        reason: 'platform admin override',
        ticket: 'T-PLATFORM',
        operationId: randomUUID(),
        expectedCalculationId: null,
        expectedCalculationVersion: null,
      },
    })
    expect(response.status, response.raw).toBe(200)
    const after = await pool.query(
      `SELECT visibility_reason FROM attendance_records WHERE id = $1::uuid`,
      [recordId],
    )
    expect(after.rows[0]?.visibility_reason).toBe('operator_retirement')
  })

  it('in-tx auth: token subject/actor mismatch rejects before W4 result DML (direct boundary)', async () => {
    requireServer()
    // Honest limitation: normal HTTP mint always binds actorId and tokenSubjectUserId from the same
    // authenticated principal, so a pure HTTP mismatch leg is not available without weakening the
    // production contract (no header override / trust hacks). Prove the exact product check via the
    // real boundary + real DB adapters instead.
    const fixture = await seedAdmin()
    const other = await seedUser({ orgId: fixture.orgId, permission: 'attendance:admin' })
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    const boundary = recordBoundaryForTests()
    await expect(
      boundary.execute({
        kind: 'ops_retirement',
        operationId: randomUUID(),
        correlationId: `mismatch:${recordId}`,
        routeInput: {
          orgId: fixture.orgId,
          actorId: fixture.userId,
          tokenSubjectUserId: other.userId,
          recordId,
          reason: 'mismatch',
          ticket: 'T-MISMATCH',
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    await assertZeroW4ResultDml(recordId)

    // Null/empty subject also fails exact bind (no soft-pass).
    await expect(
      boundary.execute({
        kind: 'manual_edit',
        operationId: randomUUID(),
        correlationId: `null-subject:${recordId}`,
        routeInput: {
          orgId: fixture.orgId,
          actorId: fixture.userId,
          tokenSubjectUserId: null,
          recordId,
          targetStatus: 'normal',
          overrideMetrics: null,
          reason: 'null subject',
          evidence: [],
          idempotencyKey: randomUUID(),
          editWindowDays: 30,
          notifyAffectedEmployee: false,
          requireStableOperationId: true,
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    await assertZeroW4ResultDml(recordId)
  })

  it('ops_retirement in legacy_projection_only fails closed with zero calculation/pointer/outbox/business writes', async () => {
    requireServer()
    const orgId = randomUUID()
    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-3c legacy', 'x', 'user', $3::jsonb,
               true, false, 'activated', now(), now())`,
      [userId, `w4c3c-legacy-${userId}@example.test`, JSON.stringify(['attendance:admin'])],
    )
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
    await seedOrgRollout(orgId, userId, 'legacy')
    const token = await mintToken(userId)
    const { recordId } = await seedRecord(orgId, userId)
    const operationId = randomUUID()
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Org-Id': orgId },
      body: {
        reason: 'legacy retirement attempt',
        ticket: 'T-LEGACY',
        operationId,
        expectedCalculationId: null,
        expectedCalculationVersion: null,
      },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error?.code).toBe('W4C3C_OPS_RETIREMENT_REQUIRES_AUTHORITATIVE_POSTURE')
    await assertZeroW4ResultDml(recordId)
  })

  it('ops_retirement in shadow fails closed because retirement must set_retired', async () => {
    requireServer()
    const fixture = await seedUser({ permission: 'attendance:admin' })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'shadow')
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    const response = await requestJson(`${baseUrl}/api/attendance/records/${recordId}/ops-retirement`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        reason: 'shadow retirement attempt',
        ticket: 'T-SHADOW',
        operationId: randomUUID(),
        expectedCalculationId: null,
        expectedCalculationVersion: null,
      },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error?.code).toBe('W4C3C_OPS_RETIREMENT_REQUIRES_AUTHORITATIVE_POSTURE')
    await assertZeroW4ResultDml(recordId)
  })

  it('manual edit operation conflict: same operationId with different metrics is exactly 409', async () => {
    requireServer()
    const fixture = await seedUser({ permission: 'attendance:admin' })
    await seedOrgRollout(fixture.orgId, fixture.userId, 'legacy')
    const { recordId } = await seedRecord(fixture.orgId, fixture.userId)
    const operationId = randomUUID()
    const idempotencyKey = randomUUID()
    const first = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'normal',
        overrideMetrics: { workMinutes: 400 },
        reason: 'first payload',
        operationId,
        idempotencyKey,
      },
    })
    expect(first.status, first.raw).toBe(200)

    const conflicting = await requestJson(`${baseUrl}/api/attendance/anomaly-result-edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Org-Id': fixture.orgId },
      body: {
        recordId,
        targetStatus: 'normal',
        overrideMetrics: { workMinutes: 999 },
        reason: 'first payload',
        operationId,
        idempotencyKey,
      },
    })
    expect(conflicting.status, conflicting.raw).toBe(409)
    expect(conflicting.body?.error?.code).toBe('ATTENDANCE_OPERATION_CONFLICT')

    const audits = await pool.query(
      `SELECT after_snapshot, reason FROM attendance_record_result_edits
        WHERE org_id = $1 AND idempotency_key = $2`,
      [fixture.orgId, idempotencyKey],
    )
    expect(audits.rows.length).toBe(1)
    expect(String(audits.rows[0].reason)).toBe('first payload')
    expect(Number(audits.rows[0].after_snapshot?.workMinutes)).toBe(400)
  })
})
