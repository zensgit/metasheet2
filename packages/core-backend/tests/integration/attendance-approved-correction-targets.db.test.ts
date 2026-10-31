import { requestOnlinePunchFixture } from '../utils/attendance-online-punch-fixture'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { approvedCorrectionGroupV2Fixture } from '../utils/attendance-approved-correction-group-v2-fixture'
import { readNativeCorrectionParentPosture, seedNativeApprovedCorrectionSource } from '../utils/attendance-approved-correction-native-source-fixture'
import type { MetaSheetServer } from '../../src/index'
import {
  restoreAttendanceSettingsRow,
  snapshotAttendanceSettingsRow,
  type AttendanceSettingsRowSnapshot,
} from '../utils/attendance-settings-row'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL

type JsonResponse = { status: number; body: Record<string, any> | null; raw: string }

function canListen(): Promise<boolean> {
  const probe = net.createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

const requestJson = (...args: Parameters<typeof rawRequestJson>): ReturnType<typeof rawRequestJson> =>
  requestOnlinePunchFixture(args[0], args[1] ?? {}, rawRequestJson)

function rawRequestJson(
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

// Isolated source-native route harness. No DB means a hard setup failure, never skip-green.
// Dynamic src/index import follows exact false RBAC flags; token claims grant no authority.
describe('attendance approved correction targets (real W53 source server and database)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  const seededDefaultRuleIds: string[] = []
  const seededPermissionUserIds: string[] = []
  let baseUrl = ''
  let settingsRowSnapshot: AttendanceSettingsRowSnapshot | undefined
  const pluginRequire = createRequire(import.meta.url)
  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    rbacTokenTrust: process.env.RBAC_TOKEN_TRUST,
    skipPlugins: process.env.SKIP_PLUGINS,
    rollout: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
    w7Context: process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED,
  }

  async function mintToken(userId: string, tenantId?: string): Promise<string> {
    const response = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}&roles=viewer&perms=${encodeURIComponent('synthetic:ungranted')}`,
    )
    const token = response.body?.token
    if (typeof token !== 'string' || !token) throw new Error('CORRECTION_A_TOKEN_FIXTURE_FAILED')
    return token
  }

  async function grantFixturePermissions(userId: string, permissions: string[]) {
    const exact = [...new Set(permissions)]
    await pool.query(
      'INSERT INTO user_permissions (user_id,permission_code) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING',
      [userId, exact],
    )
    await pool.query(
      "INSERT INTO user_namespace_admissions (user_id,namespace,enabled,source) VALUES ($1,'attendance',true,'test_fixture') ON CONFLICT (user_id,namespace) DO UPDATE SET enabled=true",
      [userId],
    )
    seededPermissionUserIds.push(userId)
  }

  async function seedOrg(
    state: 'legacy' | 'shadow',
    permission = 'attendance:admin',
  ) {
    const orgId = randomUUID()
    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-3b request fixture', 'x', 'user', $3::jsonb,
               true, false, 'activated', now(), now())`,
      [userId, `w4c3b-request-${userId}@example.test`, JSON.stringify([permission])],
    )
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
    await grantFixturePermissions(userId, ['attendance:read', 'attendance:write', permission])
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3b-request-test', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
      [orgId, userId],
    )
    if (state === 'shadow') {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'shadow', prior_state = 'legacy', version = 2
          WHERE org_id = $1`,
        [orgId],
      )
    }
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
    const defaultRule = await pool.query<{ id: string }>(
      `INSERT INTO attendance_rules
       (id, org_id, name, timezone, timezone_version, work_start_time, work_end_time, working_days, is_default)
       SELECT $1, $2, 'owned timezone fixture', $3, 1, '09:00', '18:00', '[1,2,3,4,5]'::jsonb, true
       WHERE NOT EXISTS (SELECT 1 FROM attendance_rules WHERE org_id = $2 AND is_default = true)
       RETURNING id`,
      [randomUUID(), orgId, 'UTC'],
    )
    seededDefaultRuleIds.push(...defaultRule.rows.map(row => row.id))
    return { orgId, userId, token: await mintToken(userId, orgId) }
  }

  async function seedOrgActor(orgId: string, permission: string) {
    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'W4C-3b org actor', 'x', 'user', $3::jsonb,
               TRUE, FALSE, 'activated')`,
      [userId, `w4c3b-org-actor-${userId}@example.test`, JSON.stringify([permission])],
    )
    await pool.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
      [userId, orgId],
    )
    await grantFixturePermissions(userId, ['attendance:read', 'attendance:write', permission])
    return { userId, token: await mintToken(userId, orgId) }
  }

  async function requestDecisionResidue(orgId: string, requestId: string, operationId: string | null = null) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1
             AND entrypoint = 'request_decision'
             AND (resolved_request_id = $2::uuid OR ($3::uuid IS NOT NULL AND operation_id = $3::uuid))) AS operations,
         (SELECT count(*)::int
            FROM attendance_result_event_outbox outbox
           WHERE outbox.org_id = $1
             AND outbox.entrypoint = 'request_decision'
             AND (
               ($3::uuid IS NOT NULL AND outbox.operation_id = $3::uuid)
               OR EXISTS (
                 SELECT 1 FROM attendance_result_operations operation
                  WHERE operation.org_id = outbox.org_id
                    AND operation.entrypoint = outbox.entrypoint
                    AND operation.operation_id = outbox.operation_id
                    AND operation.resolved_request_id = $2::uuid
               )
             )) AS outbox,
         (SELECT count(*)::int FROM approval_records pr
           JOIN attendance_requests ar ON ar.approval_instance_id = pr.instance_id
          WHERE ar.org_id = $1 AND ar.id = $2::uuid) AS approval_records`,
      [orgId, requestId, operationId],
    )
    return result.rows[0] as { operations: number; outbox: number; approval_records: number }
  }

  async function counts(orgId: string) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_requests WHERE org_id = $1) AS requests,
         (SELECT count(*)::int FROM attendance_request_calculation_snapshots WHERE org_id = $1) AS snapshots,
         (SELECT count(*)::int FROM attendance_result_operations WHERE org_id = $1) AS operations,
         (SELECT count(*)::int FROM attendance_result_event_outbox WHERE org_id = $1) AS outbox`,
      [orgId],
    )
    return result.rows[0] as { requests: number; snapshots: number; operations: number; outbox: number }
  }

  // A source fixture is generated through the existing public calculation writer.
  // It is synthetic setup, not native source-mutation acceptance credit.
  async function seedApprovedCorrectionSource(
    fixture: Awaited<ReturnType<typeof seedOrg>>,
    groupData?: ReturnType<typeof approvedCorrectionGroupV2Fixture>,
  ) {
    const { approvedCorrectionFixture } = await import('../utils/attendance-approved-correction-fixture')
    const { calculateAttendanceSegmentsV1 } = await import('../../src/attendance/w4c1-segment-calculator')
    const { writeAuthoritativeSegmentCalculationV1 } = await import('../../src/attendance/w4c2-authoritative-calculation-core')
    const { computeAttendanceImportRollbackPreimageFingerprintV1 } = await import('../../src/attendance/w4c3a-import-rollback')
    const data = groupData ?? approvedCorrectionFixture(fixture.orgId, fixture.userId)
    data.evidence = data.evidence.map(item => ({ ...item, ref: randomUUID() }))
    const calculation = calculateAttendanceSegmentsV1({
      attribution: data.attribution, context: data.context as unknown as Parameters<typeof calculateAttendanceSegmentsV1>[0]['context'], evidence: data.evidence, approvedFacts: [],
    })
    if (calculation.outcome !== 'completed' || !calculation.dailyProjection) throw new Error('CORRECTION_A_FIXTURE_INVALID')
    const projected = calculation.dailyProjection
    const recordId = randomUUID()
    const projection = { status: projected.status, firstInAt: projected.firstInAt, lastOutAt: projected.lastOutAt,
      workMinutes: projected.workedMinutes, lateMinutes: projected.lateMinutes, earlyLeaveMinutes: projected.earlyLeaveMinutes }
    const preimage = { posture: 'present' as const, projectionOwner: 'legacy_untracked' as const,
      currentCalculationId: null, visibilityState: 'active' as const, visibilityReason: 'active' as const,
      projection, compatibilityFingerprint: computeAttendanceImportRollbackPreimageFingerprintV1({
        projection, projectionOwner: 'legacy_untracked', currentCalculationId: null,
        visibilityState: 'active', visibilityReason: 'active',
      }) }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'INSERT INTO attendance_records (id,org_id,user_id,work_date,timezone,status,first_in_at,last_out_at,work_minutes,late_minutes,early_leave_minutes,is_workday,meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12::jsonb)',
        [recordId, fixture.orgId, fixture.userId, data.context.workDate, 'UTC', projection.status, projection.firstInAt,
          projection.lastOutAt, projection.workMinutes, projection.lateMinutes, projection.earlyLeaveMinutes, '{}'])
      for (const item of data.evidence) {
        if (item.kind !== 'punch') throw new Error('CORRECTION_A_FIXTURE_INVALID')
        await client.query(
          'INSERT INTO attendance_events (id,org_id,user_id,work_date,event_type,occurred_at,source,timezone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [item.ref, fixture.orgId, fixture.userId, data.context.workDate, item.direction, item.occurredAt, 'api', 'UTC'])
      }
      const provenanceRef = { transport: 'live_event' as const, sourceRef: data.evidence[0].ref,
        artifactSha256: null, normalizedCsvSha256: null, convertedSheetName: null }
      const written = await writeAuthoritativeSegmentCalculationV1(client, {
        orgId: fixture.orgId, recordId, entrypoint: 'live', operationId: randomUUID(), calculation,
        attribution: data.attribution, context: data.context as unknown as Parameters<typeof calculateAttendanceSegmentsV1>[0]['context'], evidence: data.evidence, approvedFacts: [],
        provenanceRef, inputProvenance: { ...provenanceRef, payloadFingerprint: 'a'.repeat(64) },
        payloadFingerprint: 'a'.repeat(64), preimage, expectedCurrentCalculationId: null,
        actorId: fixture.userId, correlationId: 'approved-correction-A-synthetic-source',
      })
      await client.query('COMMIT')
      return { ...data, recordId, calculationId: written.calculationId }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async function loadCorrectionTargets(fixture: Awaited<ReturnType<typeof seedOrg>>) {
    return requestJson(baseUrl + '/api/attendance/correction-targets?workDate=2049-08-21', {
      headers: { Authorization: 'Bearer ' + fixture.token },
    })
  }
  async function createExactCorrection(fixture: Awaited<ReturnType<typeof seedOrg>>) {
    const candidate = await loadCorrectionTargets(fixture)
    expect(candidate.status, candidate.raw).toBe(200)
    const data = candidate.body!.data
    expect(data.posture).toBe('canonical')
    const target = (segmentIndex: number, direction: string) => data.candidates.find(
      (item: { target: { segmentIndex: number; direction: string } }) =>
        item.target.segmentIndex === segmentIndex && item.target.direction === direction).target
    const body = { operationId: randomUUID(), orgId: fixture.orgId, workDate: '2049-08-21',
      requestType: 'time_correction', requestedInAt: '2049-08-21T09:00:00.000Z',
      requestedOutAt: '2049-08-21T18:00:00.000Z', reason: 'approved correction A',
      correctionTargets: { schemaVersion: 1, source: data.source, checkIn: target(0, 'check_in'), checkOut: target(1, 'check_out') } }
    const headers = { Authorization: 'Bearer ' + fixture.token, 'x-org-id': fixture.orgId }
    const created = await requestJson(baseUrl + '/api/attendance/requests', { method: 'POST', headers, body })
    expect(created.status, created.raw).toBe(201)
    return { body, headers, created, requestId: String(created.body!.data.request.id) }
  }

  beforeAll(async () => {
    if (!dbUrl || !(await canListen())) throw new Error('APPROVED_CORRECTION_REAL_DATABASE_AND_LOOPBACK_REQUIRED')
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'false'
    process.env.RBAC_TOKEN_TRUST = 'false'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const loaded = await import('../../src/index')
    server = new loaded.MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('attendance server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
    settingsRowSnapshot = await snapshotAttendanceSettingsRow(pool)
  }, 120000)

  afterEach(async () => {
    if (!pool) return
    await restoreAttendanceSettingsRow(pool, settingsRowSnapshot)
    const plugin = pluginRequire('../../../../plugins/plugin-attendance/index.cjs') as {
      resetAttendanceSettingsCacheForTests?: () => void
    }
    plugin.resetAttendanceSettingsCacheForTests?.()
  })

  afterAll(async () => {
    try {
      if (pool) {
        await pool.query(
          'DELETE FROM user_permissions WHERE user_id = ANY($1::text[]) AND permission_code = ANY($2::text[])',
          [seededPermissionUserIds, ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:admin']],
        )
        await pool.query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[]) AND namespace = $2',
          [seededPermissionUserIds, 'attendance'])
        await pool.query('DELETE FROM attendance_rules WHERE id = ANY($1::uuid[])', [seededDefaultRuleIds])
      }
    } finally {
      try { if (server) await server.stop() }
      finally {
        try { await pool?.end() }
        finally {
          for (const [key, value] of Object.entries({
            DATABASE_URL: priorEnv.databaseUrl, RBAC_BYPASS: priorEnv.rbacBypass,
            RBAC_TOKEN_TRUST: priorEnv.rbacTokenTrust, SKIP_PLUGINS: priorEnv.skipPlugins,
            ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: priorEnv.rollout,
            ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED: priorEnv.w7Context,
          })) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
        }
      }
    }
  })

  describe('approved correction A', () => {
    it('distinguishes exact OFF/legacy from canonical unsupported without request writes', async () => {
      const legacy = await seedOrg('legacy')
      expect(await loadCorrectionTargets(legacy)).toMatchObject({ status: 200, body: { ok: true,
        data: { schemaVersion: 1, posture: 'legacy_projection_only', source: null, candidates: [] } } })
      const shadow = await seedOrg('shadow')
      const refused = await loadCorrectionTargets(shadow)
      expect(refused.status, refused.raw).toBe(422)
      expect(refused.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED',
        message: 'ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED' } })
      expect(await counts(shadow.orgId)).toEqual({ requests: 0, snapshots: 0, operations: 0, outbox: 0 })
    })

    it('requires explicit multisegment selection and rejects display/foreign-source/foreign-user targets atomically', async () => {
      const fixture = await seedOrg('shadow')
      await seedNativeApprovedCorrectionSource(pool, fixture)
      const before = await counts(fixture.orgId)
      expect({ requests: before.requests, snapshots: before.snapshots }).toEqual({ requests: 0, snapshots: 0 })
      const candidate = await loadCorrectionTargets(fixture)
      expect(candidate.status, candidate.raw).toBe(200)
      const data = candidate.body!.data
      expect(data.candidates[0].display).toEqual({ timezone: 'UTC', expectedStartAt: '2049-08-21T09:00:00.000Z',
        expectedEndAt: '2049-08-21T12:00:00.000Z', originalOccurredAt: '2049-08-21T09:15:00.000Z', source: 'attendance_event' })
      const headers = { Authorization: 'Bearer ' + fixture.token }
      const base = { operationId: randomUUID(), orgId: fixture.orgId, workDate: '2049-08-21', requestType: 'missed_check_in',
        requestedInAt: '2049-08-21T09:00:00.000Z',
        correctionTargets: { schemaVersion: 1, source: data.source, checkIn: null, checkOut: null } }
      const ambiguous = await requestJson(baseUrl + '/api/attendance/requests', { method: 'POST', headers, body: base })
      expect(ambiguous.status, ambiguous.raw).toBe(422)
      expect(ambiguous.body!.error.code).toBe('ATTENDANCE_CORRECTION_TARGET_SELECTION_REQUIRED')
      const display = await requestJson(baseUrl + '/api/attendance/requests', { method: 'POST', headers,
        body: { ...base, operationId: randomUUID(), correctionTargets: { ...base.correctionTargets,
          checkIn: { ...data.candidates[0].target, display: data.candidates[0].display } } } })
      expect(display.status, display.raw).toBe(400)
      expect(display.body!.error.code).toBe('ATTENDANCE_CORRECTION_TARGET_INVALID')
      const foreign = await requestJson(baseUrl + '/api/attendance/requests', { method: 'POST', headers,
        body: { ...base, operationId: randomUUID(), correctionTargets: { ...base.correctionTargets,
          source: { ...data.source, recordId: randomUUID() }, checkIn: data.candidates[0].target } } })
      expect(foreign.status, foreign.raw).toBe(409)
      expect(foreign.body!.error.code).toBe('ATTENDANCE_CORRECTION_TARGET_STALE')
      const otherUser = await seedOrgActor(fixture.orgId, 'attendance:approve')
      const other = await requestJson(baseUrl + '/api/attendance/requests', { method: 'POST',
        headers: { Authorization: 'Bearer ' + otherUser.token }, body: { ...base, operationId: randomUUID(),
          correctionTargets: { ...base.correctionTargets, checkIn: data.candidates[0].target } } })
      expect(other.status, other.raw).toBe(422)
      expect(other.body!.error.code).toBe('ATTENDANCE_CORRECTION_SOURCE_UNSUPPORTED')
      expect(await counts(fixture.orgId)).toEqual(before)
    })

    it('retains targets on edit/replay, binds displayed snapshot OCC, and appends two-sided canonical shadow facts once', async () => {
      const fixture = await seedOrg('shadow')
      const source = await seedNativeApprovedCorrectionSource(pool, fixture)
      const made = await createExactCorrection(fixture)
      const { headers, requestId } = made
      const replay = await requestJson(baseUrl + '/api/attendance/requests', { method: 'POST', headers, body: made.body })
      expect(replay.body).toEqual(made.created.body)
      const read = async () => {
        const response = await requestJson(baseUrl + '/api/attendance/requests/' + requestId, { headers })
        expect(response.status, response.raw).toBe(200)
        return response
      }
      const original = (await read()).body!.data.request.decisionContext
      expect(original).toEqual({ schemaVersion: 1, requestId,
        approvalInstanceId: made.created.body!.data.request.approval_instance_id,
        expectedApprovalVersion: 0, expectedApprovalNode: 'attendance_request_step_0',
        expectedSnapshotVersion: 1, expectedSnapshotFingerprint: made.created.body!.data.requestSnapshot.fingerprint })
      const editBody = { operationId: randomUUID(), reason: 'A edit preserves exact targets',
        expectedSnapshotVersion: original.expectedSnapshotVersion, expectedSnapshotFingerprint: original.expectedSnapshotFingerprint }
      const edited = await requestJson(baseUrl + '/api/attendance/requests/' + requestId, { method: 'PUT', headers, body: editBody })
      expect(edited.status, edited.raw).toBe(200)
      const editReplay = await requestJson(baseUrl + '/api/attendance/requests/' + requestId, { method: 'PUT', headers, body: editBody })
      expect(editReplay.body).toEqual(edited.body)
      expect(edited.body!.data.request.metadata.correctionTargets).toEqual(made.body.correctionTargets)
      const stale = await requestJson(baseUrl + '/api/attendance/requests/' + requestId + '/approve', {
        method: 'POST', headers, body: { ...original, operationId: randomUUID() } })
      expect(stale.status, stale.raw).toBe(409)
      expect(stale.body!.error.code).toBe('ATTENDANCE_CORRECTION_SNAPSHOT_CHANGED')
      expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({ operations: 0, outbox: 0, approval_records: 0 })
      const shown = (await read()).body!.data.request.decisionContext
      const decision = { operationId: randomUUID(), expectedApprovalVersion: shown.expectedApprovalVersion,
        expectedApprovalNode: shown.expectedApprovalNode, expectedSnapshotVersion: shown.expectedSnapshotVersion,
        expectedSnapshotFingerprint: shown.expectedSnapshotFingerprint }
      const approved = await requestJson(baseUrl + '/api/attendance/requests/' + requestId + '/approve', { method: 'POST', headers, body: decision })
      expect(approved.status, approved.raw).toBe(200)
      const approvedReplay = await requestJson(baseUrl + '/api/attendance/requests/' + requestId + '/approve', { method: 'POST', headers, body: decision })
      expect(approvedReplay.body).toEqual(approved.body)
      const calculated = await pool.query(
        "SELECT approved_facts_snapshot,evidence_snapshot,context_snapshot FROM attendance_record_calculations WHERE org_id=$1 AND entrypoint='correction' AND operation_id=$2",
        [fixture.orgId, decision.operationId])
      expect(calculated.rows).toHaveLength(1)
      const fact = calculated.rows[0].approved_facts_snapshot[0]
      expect(fact).toEqual({ kind: 'correction', schemaVersion: 2, requestId, requestSnapshotVersion: 2,
        requestSnapshotFingerprint: shown.expectedSnapshotFingerprint, approvalVersion: 1,
        approvalRecordId: fact.approvalRecordId,
        changes: [
          { target: made.body.correctionTargets.checkIn, occurredAt: made.body.requestedInAt, adjustmentEvidenceRef: 'correction:' + requestId + ':check_in' },
          { target: made.body.correctionTargets.checkOut, occurredAt: made.body.requestedOutAt, adjustmentEvidenceRef: 'correction:' + requestId + ':check_out' },
        ] })
      expect(fact.approvalRecordId).toMatch(/^[0-9]+$/)
      expect(fact.changes[1].target).toEqual({ kind: 'insertion', direction: 'check_out', segmentIndex: 1 })
      expect(calculated.rows[0].context_snapshot).toEqual(source.context)
      expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({ operations: 1, outbox: 1, approval_records: 1 })
      expect(await readNativeCorrectionParentPosture(pool, fixture.orgId, source.recordId)).toEqual(source.parentPreimage)
    })

    it('moves the authoritative pointer through the existing guarded core writer', async () => {
      const fixture = await seedOrg('shadow')
      await pool.query("UPDATE attendance_calculation_rollout_state SET state='eligible',prior_state='shadow',version=3 WHERE org_id=$1", [fixture.orgId])
      await pool.query("UPDATE attendance_calculation_rollout_state SET state='authoritative',prior_state='eligible',version=4 WHERE org_id=$1", [fixture.orgId])
      const source = await seedNativeApprovedCorrectionSource(pool, fixture, { mode: 'authoritative' })
      const made = await createExactCorrection(fixture)
      const read = await requestJson(baseUrl + '/api/attendance/requests/' + made.requestId, { headers: made.headers })
      expect(read.status, read.raw).toBe(200)
      const shown = read.body!.data.request.decisionContext
      const operationId = randomUUID()
      const approved = await requestJson(baseUrl + '/api/attendance/requests/' + made.requestId + '/approve', {
        method: 'POST', headers: made.headers, body: { ...shown, operationId } })
      expect(approved.status, approved.raw).toBe(200)
      const result = await pool.query(
        "SELECT r.current_calculation_id::text, r.status, r.work_minutes, r.late_minutes, c.mode, c.entrypoint, c.supersedes_calculation_id::text FROM attendance_records r JOIN attendance_record_calculations c ON c.id=r.current_calculation_id WHERE r.id=$1 AND r.org_id=$2",
        [source.recordId, fixture.orgId])
      expect(result.rows).toEqual([{ current_calculation_id: result.rows[0].current_calculation_id,
        status: 'adjusted', work_minutes: 480, late_minutes: 0, mode: 'authoritative', entrypoint: 'correction',
        supersedes_calculation_id: source.calculationId }])
      expect(result.rows[0].current_calculation_id).not.toBe(source.calculationId)
      expect(await requestDecisionResidue(fixture.orgId, made.requestId, operationId))
        .toEqual({ operations: 1, outbox: 1, approval_records: 1 })
    })

    it('rejects an intervening punch before terminal writes with zero decision residue', async () => {
      const fixture = await seedOrg('shadow')
      await seedNativeApprovedCorrectionSource(pool, fixture)
      const made = await createExactCorrection(fixture)
      const read = await requestJson(baseUrl + '/api/attendance/requests/' + made.requestId, { headers: made.headers })
      expect(read.status, read.raw).toBe(200)
      const shown = read.body!.data.request.decisionContext
      await pool.query(
        'INSERT INTO attendance_events (id,org_id,user_id,work_date,event_type,occurred_at,source,timezone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), fixture.orgId, fixture.userId, '2049-08-21', 'check_out', '2049-08-21T18:00:00.000Z', 'api', 'UTC'])
      const response = await requestJson(baseUrl + '/api/attendance/requests/' + made.requestId + '/approve', {
        method: 'POST', headers: made.headers, body: { ...shown, operationId: randomUUID() } })
      expect(response.status, response.raw).toBe(409)
      expect(response.body!.error.code).toBe('ATTENDANCE_CORRECTION_TARGET_STALE')
      expect(await requestDecisionResidue(fixture.orgId, made.requestId)).toEqual({ operations: 0, outbox: 0, approval_records: 0 })
      const state = await pool.query('SELECT status FROM attendance_requests WHERE id=$1', [made.requestId])
      expect(state.rows).toEqual([{ status: 'pending' }])
    })
    it('retains an explicit group_effective frozenV2 source through the real correction route', async () => {
      const fixture = await seedOrg('shadow')
      const source = await seedNativeApprovedCorrectionSource(pool, fixture, { groupV2: true })
      expect(source.context).toEqual(source.preparedContext)
      const frozenSource = () => pool.query(
        `SELECT to_jsonb(c) AS calculation,
                (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.segment_index) FROM attendance_record_segments s
                  WHERE s.calculation_id=c.id AND s.record_id=c.attendance_record_id AND s.org_id=c.org_id) AS segments
           FROM attendance_record_calculations c WHERE c.id=$1 AND c.org_id=$2`,
        [source.calculationId, fixture.orgId])
      const sourcePreimage = (await frozenSource()).rows
      expect(sourcePreimage).toHaveLength(1)
      const candidate = await loadCorrectionTargets(fixture)
      expect(candidate.status, candidate.raw).toBe(200)
      expect(candidate.body!.data.posture).toBe('canonical')
      const made = await createExactCorrection(fixture)
      const read = await requestJson(baseUrl + '/api/attendance/requests/' + made.requestId, { headers: made.headers })
      expect(read.status, read.raw).toBe(200)
      const shown = read.body!.data.request.decisionContext
      const operationId = randomUUID()
      const approved = await requestJson(baseUrl + '/api/attendance/requests/' + made.requestId + '/approve', {
        method: 'POST', headers: made.headers, body: {
          operationId, expectedApprovalVersion: shown.expectedApprovalVersion, expectedApprovalNode: shown.expectedApprovalNode,
          expectedSnapshotVersion: shown.expectedSnapshotVersion, expectedSnapshotFingerprint: shown.expectedSnapshotFingerprint,
        } })
      expect(approved.status, approved.raw).toBe(200)
      const rows = await pool.query(
        "SELECT context_snapshot,approved_facts_snapshot,mode FROM attendance_record_calculations WHERE org_id=$1 AND entrypoint='correction' AND operation_id=$2",
        [fixture.orgId, operationId])
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0].context_snapshot).toEqual(source.context)
      expect(rows.rows[0].context_snapshot.schemaVersion).toBe(2)
      expect(rows.rows[0].context_snapshot.selector).toBe('group_effective')
      expect(rows.rows[0].context_snapshot.calculationGroupId).toBe(source.groupId)
      expect(rows.rows[0].mode).toBe('shadow')
      expect(rows.rows[0].approved_facts_snapshot).toHaveLength(1)
      expect(rows.rows[0].approved_facts_snapshot[0].changes).toHaveLength(2)
      expect((await frozenSource()).rows).toEqual(sourcePreimage)
      expect(await readNativeCorrectionParentPosture(pool, fixture.orgId, source.recordId)).toEqual(source.parentPreimage)
      expect(await requestDecisionResidue(fixture.orgId, made.requestId, operationId))
        .toEqual({ operations: 1, outbox: 1, approval_records: 1 })
    })

    it('source04: keeps approval audit out of later live punch evidence and retains the approved correction', async () => {
      expect(process.env.RBAC_BYPASS).toBe('false')
      expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
      const fixture = await seedOrg('shadow')
      const workDate = new Date().toISOString().slice(0, 10)
      const startAt = workDate + 'T00:00:00.000Z'
      const endAt = new Date(Date.parse(startAt) + 86_400_000).toISOString()
      await pool.query("UPDATE attendance_calculation_rollout_state SET state='eligible',prior_state='shadow',version=3 WHERE org_id=$1", [fixture.orgId])
      await pool.query("UPDATE attendance_calculation_rollout_state SET state='authoritative',prior_state='eligible',version=4 WHERE org_id=$1", [fixture.orgId])
      const source = await seedNativeApprovedCorrectionSource(pool, fixture, { mode: 'authoritative', workDate, singleSegment: true })
      expect(source.context).toEqual(source.preparedContext)
      const genuineInRef = source.evidence[0].ref
      const headers = { Authorization: 'Bearer ' + fixture.token, 'x-org-id': fixture.orgId }
      const initialEvents = await pool.query(
        'SELECT id::text,event_type FROM attendance_events WHERE org_id=$1 AND user_id=$2 AND work_date=$3 ORDER BY id',
        [fixture.orgId, fixture.userId, workDate])
      expect(initialEvents.rows).toEqual([{ id: genuineInRef, event_type: 'check_in' }])

      const targetUrl = baseUrl + '/api/attendance/correction-targets?workDate=' + encodeURIComponent(workDate)
      const beforeTargets = await requestJson(targetUrl, { headers })
      expect(beforeTargets.status, beforeTargets.raw).toBe(200)
      expect(beforeTargets.body!.data.posture).toBe('canonical')
      const originalTarget = { kind: 'replacement', segmentIndex: 0, direction: 'check_in', evidenceRef: genuineInRef }
      expect(beforeTargets.body!.data.candidates.map((item: { target: unknown }) => item.target)).toEqual([
        originalTarget, { kind: 'insertion', segmentIndex: 0, direction: 'check_out' },
      ])
      const correctedInAt = source.instant('09:00')
      const created = await requestJson(baseUrl + '/api/attendance/requests', {
        method: 'POST', headers, body: {
          operationId: randomUUID(), orgId: fixture.orgId, workDate, requestType: 'time_correction',
          requestedInAt: correctedInAt, reason: 'source04 producer regression',
          correctionTargets: { schemaVersion: 1, source: beforeTargets.body!.data.source,
            checkIn: originalTarget, checkOut: null },
        } })
      expect(created.status, created.raw).toBe(201)
      const requestId = String(created.body!.data.request.id)
      const shownRequest = await requestJson(baseUrl + '/api/attendance/requests/' + requestId, { headers })
      expect(shownRequest.status, shownRequest.raw).toBe(200)
      const shown = shownRequest.body!.data.request.decisionContext
      const approvalOperationId = randomUUID()
      const approved = await requestJson(baseUrl + '/api/attendance/requests/' + requestId + '/approve', {
        method: 'POST', headers, body: {
          operationId: approvalOperationId, expectedApprovalVersion: shown.expectedApprovalVersion,
          expectedApprovalNode: shown.expectedApprovalNode, expectedSnapshotVersion: shown.expectedSnapshotVersion,
          expectedSnapshotFingerprint: shown.expectedSnapshotFingerprint,
        } })
      expect(approved.status, approved.raw).toBe(200)
      const audits = await pool.query(
        "SELECT id::text,occurred_at,source,meta FROM attendance_events WHERE org_id=$1 AND user_id=$2 AND work_date=$3 AND event_type='adjustment' ORDER BY id",
        [fixture.orgId, fixture.userId, workDate])
      expect(audits.rows).toHaveLength(1)
      const audit = audits.rows[0]
      expect(audit.source).toBe('request')
      expect(audit.meta.requestId).toBe(requestId)
      const auditInstant = new Date(audit.occurred_at).toISOString()
      expect(auditInstant >= startAt && auditInstant < endAt,
        'SOURCE04_REQUIRES_THE_REAL_APPROVAL_AUDIT_INSIDE_THE_FROZEN_DAY').toBe(true)
      const correctionRows = await pool.query(
        "SELECT id::text,version,evidence_snapshot,approved_facts_snapshot,projected_first_in_at FROM attendance_record_calculations WHERE org_id=$1 AND attendance_record_id=$2 AND entrypoint='correction' AND operation_id=$3",
        [fixture.orgId, source.recordId, approvalOperationId])
      expect(correctionRows.rows).toHaveLength(1)
      const correction = correctionRows.rows[0]
      const adjustmentEvidenceRef = 'correction:' + requestId + ':check_in'
      expect(correction.approved_facts_snapshot).toEqual([{
        kind: 'correction', schemaVersion: 2, requestId, requestSnapshotVersion: shown.expectedSnapshotVersion,
        requestSnapshotFingerprint: shown.expectedSnapshotFingerprint,
        approvalVersion: shown.expectedApprovalVersion + 1,
        approvalRecordId: correction.approved_facts_snapshot[0].approvalRecordId,
        changes: [{ target: originalTarget, occurredAt: correctedInAt, adjustmentEvidenceRef }],
      }])
      expect(correction.approved_facts_snapshot[0].approvalRecordId).toMatch(/^[0-9]+$/)
      expect(new Date(correction.projected_first_in_at).toISOString()).toBe(correctedInAt)

      const checkoutOperationId = randomUUID()
      // requestJson delegates this URL through requestOnlinePunchFixture:
      // occurredAt is removed from HTTP and selects only the existing test clock.
      const checkoutAt = source.instant('18:00')
      const checkedOut = await requestJson(baseUrl + '/api/attendance/punch', {
        method: 'POST', headers, body: {
          orgId: fixture.orgId, operationId: checkoutOperationId,
          eventType: 'check_out', timezone: 'UTC', occurredAt: checkoutAt,
        } })
      expect(checkedOut.status, checkedOut.raw).toBe(200)
      const checkoutRows = await pool.query(
        "SELECT id::text,occurred_at FROM attendance_events WHERE org_id=$1 AND user_id=$2 AND work_date=$3 AND event_type='check_out' ORDER BY id",
        [fixture.orgId, fixture.userId, workDate])
      expect(checkoutRows.rows).toHaveLength(1)
      const genuineOutRef = checkoutRows.rows[0].id
      expect(new Date(checkoutRows.rows[0].occurred_at).toISOString()).toBe(checkoutAt)
      const latestRows = await pool.query(
        "SELECT id::text,version,entrypoint,operation_id::text,outcome,outcome_reason_code,evidence_snapshot,approved_facts_snapshot,projected_first_in_at,projected_last_out_at,projected_work_minutes,projected_late_minutes,projected_status FROM attendance_record_calculations WHERE org_id=$1 AND attendance_record_id=$2 AND calculation_kind='calculation' ORDER BY version DESC LIMIT 1",
        [fixture.orgId, source.recordId])
      expect(latestRows.rows).toHaveLength(1)
      const latest = latestRows.rows[0]
      const afterTargets = await requestJson(targetUrl, { headers })
      const auditsAfter = await pool.query(
        "SELECT id::text,source,meta->>'requestId' AS request_id FROM attendance_events WHERE org_id=$1 AND user_id=$2 AND work_date=$3 AND event_type='adjustment' ORDER BY id",
        [fixture.orgId, fixture.userId, workDate])
      expect(auditsAfter.rows).toEqual([{ id: audit.id, source: 'request', request_id: requestId }])
      expect(latest.entrypoint).toBe('live')
      expect(latest.operation_id).toBe(checkoutOperationId)
      expect(Number(latest.version)).toBeGreaterThan(Number(correction.version))
      expect.soft(latest.evidence_snapshot.some((item: { ref: string }) => item.ref === audit.id),
        'SOURCE04_AUDIT_ADJUSTMENT_MUST_NOT_BECOME_PSEUDO_CHECK_IN').toBe(false)
      expect.soft(latest.evidence_snapshot.filter((item: { kind: string }) => item.kind === 'punch')
        .map((item: { ref: string; direction: string }) => ({ ref: item.ref, direction: item.direction }))
        .sort((left: { ref: string }, right: { ref: string }) => left.ref.localeCompare(right.ref)))
        .toEqual([{ ref: genuineInRef, direction: 'check_in' }, { ref: genuineOutRef, direction: 'check_out' }]
          .sort((left, right) => left.ref.localeCompare(right.ref)))
      expect.soft(latest.approved_facts_snapshot,
        'SOURCE04_NEXT_LIVE_DROPPED_APPROVED_CORRECTION_FACTS').toEqual(correction.approved_facts_snapshot)
      expect.soft(latest.evidence_snapshot.find((item: { ref: string }) => item.ref === adjustmentEvidenceRef),
        'SOURCE04_NEXT_LIVE_DROPPED_APPROVED_ADJUSTMENT_EVIDENCE').toEqual({
          kind: 'approved_adjustment', ref: adjustmentEvidenceRef, direction: 'check_in',
          occurredAt: correctedInAt, source: 'correction',
        })
      expect.soft(latest.outcome, 'SOURCE04_NEXT_LIVE_MUST_REMAIN_CANONICAL').toBe('completed')
      expect.soft(latest.projected_first_in_at === null ? null : new Date(latest.projected_first_in_at).toISOString(),
        'SOURCE04_NEXT_LIVE_LOST_THE_APPROVED_CHECK_IN').toBe(correctedInAt)
      expect.soft(latest.projected_last_out_at === null ? null : new Date(latest.projected_last_out_at).toISOString()).toBe(checkoutAt)
      expect.soft(latest.projected_work_minutes).toBe(540)
      expect.soft(latest.projected_late_minutes).toBe(0)
      expect.soft(latest.projected_status).toBe('adjusted')
      expect.soft(afterTargets.status, 'SOURCE04_NEXT_CANONICAL_SOURCE_MUST_BE_READABLE').toBe(200)
      expect.soft(afterTargets.body?.data?.posture).toBe('canonical')
      expect.soft(afterTargets.body?.data?.source?.calculationId).toBe(latest.id)
      expect.soft(afterTargets.body?.data?.candidates?.map((item: { target: unknown }) => item.target),
        'SOURCE04_NEXT_TARGETS_MUST_REFERENCE_RETAINED_APPROVED_EFFECT').toEqual([
        { kind: 'replacement', segmentIndex: 0, direction: 'check_in', evidenceRef: adjustmentEvidenceRef },
        { kind: 'replacement', segmentIndex: 0, direction: 'check_out', evidenceRef: genuineOutRef },
      ])
    })

  })

  // Populated-source admission coverage only; synthetic setup grants no runtime acceptance credit.
  // The migrated record key includes org_id, so the ORG case can keep the same user and date.
  async function populatedIsolationState(fixtures: Awaited<ReturnType<typeof seedOrg>>[]) {
    const result = []
    for (const fixture of fixtures) {
      const rows = await pool.query(
        `SELECT
           (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
              FROM attendance_records r WHERE r.org_id=$1 AND r.user_id=$2) AS records,
           (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb)
              FROM attendance_record_calculations c JOIN attendance_records r ON r.id=c.attendance_record_id AND r.org_id=c.org_id
             WHERE r.org_id=$1 AND r.user_id=$2) AS calculations,
           (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.calculation_id,s.segment_index), '[]'::jsonb)
              FROM attendance_record_segments s JOIN attendance_records r ON r.id=s.record_id AND r.org_id=s.org_id
             WHERE r.org_id=$1 AND r.user_id=$2) AS segments,
           (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
              FROM attendance_events e WHERE e.org_id=$1 AND e.user_id=$2) AS events`,
        [fixture.orgId, fixture.userId])
      result.push({ counts: await counts(fixture.orgId), sourceRows: rows.rows[0] })
    }
    return result
  }

  async function seedPopulatedIsolationSource(fixture: Awaited<ReturnType<typeof seedOrg>>) {
    const source = await seedApprovedCorrectionSource(fixture)
    const rows = await pool.query(
      `SELECT r.org_id,r.user_id,r.work_date::text,r.current_calculation_id::text,r.projection_owner,r.visibility_state,
              c.version,c.mode,c.outcome,c.expected_segment_count,c.context_snapshot,c.evidence_snapshot,
              c.semantic_input_fingerprint,
              (SELECT array_agg(s.segment_index ORDER BY s.segment_index) FROM attendance_record_segments s
                WHERE s.calculation_id=c.id AND s.record_id=r.id AND s.org_id=r.org_id) AS child_indices,
              (SELECT array_agg(e.id::text ORDER BY e.id) FROM attendance_events e
                WHERE e.org_id=r.org_id AND e.user_id=r.user_id AND e.work_date=r.work_date) AS punch_refs,
              u.is_active,u.is_admin,u.activation_status,uo.is_active AS membership_active
         FROM attendance_records r JOIN attendance_record_calculations c ON c.id=r.current_calculation_id
          AND c.attendance_record_id=r.id AND c.org_id=r.org_id
         JOIN users u ON u.id=r.user_id JOIN user_orgs uo ON uo.user_id=u.id AND uo.org_id=r.org_id
        WHERE r.id=$1 AND r.org_id=$2 AND r.user_id=$3`,
      [source.recordId, fixture.orgId, fixture.userId])
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]
    expect(row.semantic_input_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(row).toEqual({
      org_id: fixture.orgId, user_id: fixture.userId, work_date: '2049-08-21',
      current_calculation_id: source.calculationId, projection_owner: 'w4', visibility_state: 'active',
      version: 2, mode: 'authoritative', outcome: 'completed', expected_segment_count: 2,
      context_snapshot: source.context, evidence_snapshot: source.evidence,
      semantic_input_fingerprint: row.semantic_input_fingerprint, child_indices: [0, 1],
      punch_refs: source.evidence.map(item => item.ref).sort(),
      is_active: true, is_admin: false, activation_status: 'activated', membership_active: true,
    })
    // This is the ordinary HTTP payload tuple read from persisted public-writer output,
    // not a verified source/operation identity or an authority issued by the test.
    return {
      schemaVersion: 1,
      source: { recordId: source.recordId, calculationId: source.calculationId,
        calculationVersion: row.version, semanticInputFingerprint: row.semantic_input_fingerprint },
      checkIn: { kind: 'replacement', segmentIndex: 0, direction: 'check_in', evidenceRef: source.evidence[0].ref },
      checkOut: { kind: 'insertion', segmentIndex: 1, direction: 'check_out' },
    }
  }

  async function assertPopulatedSourceIsolation(
    current: Awaited<ReturnType<typeof seedOrg>>,
    foreign: Awaited<ReturnType<typeof seedOrg>>,
  ) {
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    const orgIds = [...new Set([current.orgId, foreign.orgId])]
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgIds.join(',')
    // Only these fresh synthetic org rows transition; defaults and policy are untouched.
    await pool.query("UPDATE attendance_calculation_rollout_state SET state='eligible',prior_state='shadow',version=3 WHERE org_id=ANY($1::text[])", [orgIds])
    await pool.query("UPDATE attendance_calculation_rollout_state SET state='authoritative',prior_state='eligible',version=4 WHERE org_id=ANY($1::text[])", [orgIds])
    const ownTargets = await seedPopulatedIsolationSource(current)
    const foreignTargets = await seedPopulatedIsolationSource(foreign)
    expect(foreignTargets.source.recordId).not.toBe(ownTargets.source.recordId)
    expect(foreignTargets.source.calculationId).not.toBe(ownTargets.source.calculationId)
    const fixtures = [current, foreign]
    const before = await populatedIsolationState(fixtures)
    for (const state of before) {
      expect(state.counts).toEqual({ requests: 0, snapshots: 0, operations: 0, outbox: 0 })
    }
    const headers = { Authorization: 'Bearer ' + current.token, 'X-Org-ID': current.orgId }
    const draft = { orgId: current.orgId, workDate: '2049-08-21', requestType: 'time_correction',
      requestedInAt: '2049-08-21T09:00:00.000Z', requestedOutAt: '2049-08-21T18:00:00.000Z',
      reason: 'populated source isolation' }
    const denied = await requestJson(baseUrl + '/api/attendance/requests', { method: 'POST', headers,
      body: { ...draft, operationId: randomUUID(), correctionTargets: foreignTargets } })
    expect(denied.status, denied.raw).toBe(409)
    expect(denied.body).toEqual({ ok: false, error: {
      code: 'ATTENDANCE_CORRECTION_TARGET_STALE', message: 'ATTENDANCE_CORRECTION_TARGET_STALE',
    } })
    expect(await populatedIsolationState(fixtures)).toEqual(before)

    // All positive controls follow the denial, before any pending request can preempt it.
    for (const [fixture, targets] of [[current, ownTargets], [foreign, foreignTargets]] as const) {
      const eligible = await requestJson(baseUrl + '/api/attendance/correction-targets?workDate=2049-08-21', {
        headers: { Authorization: 'Bearer ' + fixture.token, 'X-Org-ID': fixture.orgId },
      })
      expect(eligible.status, eligible.raw).toBe(200)
      expect(eligible.body!.data.posture).toBe('canonical')
      expect(eligible.body!.data.source).toEqual(targets.source)
      const frozen = before[fixture === current ? 0 : 1].sourceRows.calculations
        .find((item: { id: string }) => item.id === targets.source.calculationId).evidence_snapshot
      expect(eligible.body!.data.candidates.map((item: { target: unknown }) => item.target)).toEqual([
        { kind: 'replacement', segmentIndex: 0, direction: 'check_in', evidenceRef: frozen[0].ref },
        { kind: 'replacement', segmentIndex: 1, direction: 'check_in', evidenceRef: frozen[2].ref },
        { kind: 'replacement', segmentIndex: 0, direction: 'check_out', evidenceRef: frozen[1].ref },
        targets.checkOut,
      ])
    }
    expect(await populatedIsolationState(fixtures)).toEqual(before)
    const created = await requestJson(baseUrl + '/api/attendance/requests', { method: 'POST', headers,
      body: { ...draft, operationId: randomUUID(), correctionTargets: ownTargets } })
    expect(created.status, created.raw).toBe(201)
    const requestId = String(created.body!.data.request.id)
    const read = await requestJson(baseUrl + '/api/attendance/requests/' + requestId, { headers })
    expect(read.status, read.raw).toBe(200)
    expect(read.body!.data.request.metadata.correctionTargets).toEqual(ownTargets)
    const shown = read.body!.data.request.decisionContext
    const operationId = randomUUID()
    const approved = await requestJson(baseUrl + '/api/attendance/requests/' + requestId + '/approve', {
      method: 'POST', headers, body: { operationId,
        expectedApprovalVersion: shown.expectedApprovalVersion, expectedApprovalNode: shown.expectedApprovalNode,
        expectedSnapshotVersion: shown.expectedSnapshotVersion, expectedSnapshotFingerprint: shown.expectedSnapshotFingerprint,
      } })
    expect(approved.status, approved.raw).toBe(200)
    expect(await requestDecisionResidue(current.orgId, requestId, operationId))
      .toEqual({ operations: 1, outbox: 1, approval_records: 1 })
    const result = await pool.query(
      `SELECT r.current_calculation_id::text,c.entrypoint,c.operation_id::text,
              c.context_snapshot->>'orgId' AS org_id,c.context_snapshot->>'userId' AS user_id
         FROM attendance_records r JOIN attendance_record_calculations c ON c.id=r.current_calculation_id
          AND c.attendance_record_id=r.id AND c.org_id=r.org_id WHERE r.id=$1 AND r.org_id=$2`,
      [ownTargets.source.recordId, current.orgId])
    expect(result.rows).toHaveLength(1)
    expect(result.rows).toEqual([{ current_calculation_id: result.rows[0].current_calculation_id,
      entrypoint: 'correction', operation_id: operationId, org_id: current.orgId, user_id: current.userId }])
    expect(result.rows[0].current_calculation_id).not.toBe(ownTargets.source.calculationId)
    expect((await populatedIsolationState([foreign]))[0].sourceRows).toEqual(before[1].sourceRows)

    const afterCurrent = await populatedIsolationState(fixtures)
    expect(afterCurrent[0].counts).toEqual({ requests: 1, snapshots: 1, operations: 2, outbox: 2 })
    const foreignBefore = afterCurrent[1].counts
    expect(foreignBefore).toEqual(current.orgId === foreign.orgId
      ? afterCurrent[0].counts : before[1].counts)
    const currentSnapshots = await pool.query(
      'SELECT * FROM attendance_request_calculation_snapshots WHERE org_id=$1 AND request_id=$2 ORDER BY version',
      [current.orgId, requestId])
    expect(currentSnapshots.rows).toHaveLength(1)
    const foreignHeaders = { Authorization: 'Bearer ' + foreign.token, 'X-Org-ID': foreign.orgId }
    const foreignCreateOperationId = randomUUID()
    const foreignCreated = await requestJson(baseUrl + '/api/attendance/requests', {
      method: 'POST', headers: foreignHeaders,
      body: { ...draft, orgId: foreign.orgId, operationId: foreignCreateOperationId, correctionTargets: foreignTargets },
    })
    expect(foreignCreated.status, foreignCreated.raw).toBe(201)
    expect(await counts(foreign.orgId)).toEqual({ requests: foreignBefore.requests + 1,
      snapshots: foreignBefore.snapshots + 1, operations: foreignBefore.operations + 1, outbox: foreignBefore.outbox + 1 })
    const foreignRequestId = String(foreignCreated.body!.data.request.id)
    const foreignRead = await requestJson(baseUrl + '/api/attendance/requests/' + foreignRequestId, { headers: foreignHeaders })
    expect(foreignRead.status, foreignRead.raw).toBe(200)
    expect(foreignRead.body!.data.request.org_id).toBe(foreign.orgId)
    expect(foreignRead.body!.data.request.user_id).toBe(foreign.userId)
    expect(foreignRead.body!.data.request.metadata.correctionTargets).toEqual(foreignTargets)
    const foreignShown = foreignRead.body!.data.request.decisionContext
    const foreignOperationId = randomUUID()
    const foreignApproved = await requestJson(baseUrl + '/api/attendance/requests/' + foreignRequestId + '/approve', {
      method: 'POST', headers: foreignHeaders, body: { operationId: foreignOperationId,
        expectedApprovalVersion: foreignShown.expectedApprovalVersion, expectedApprovalNode: foreignShown.expectedApprovalNode,
        expectedSnapshotVersion: foreignShown.expectedSnapshotVersion, expectedSnapshotFingerprint: foreignShown.expectedSnapshotFingerprint,
      } })
    expect(foreignApproved.status, foreignApproved.raw).toBe(200)
    expect(await requestDecisionResidue(foreign.orgId, foreignRequestId, foreignOperationId))
      .toEqual({ operations: 1, outbox: 1, approval_records: 1 })
    expect(await requestDecisionResidue(current.orgId, requestId, operationId))
      .toEqual({ operations: 1, outbox: 1, approval_records: 1 })
    const foreignResult = await pool.query(
      `SELECT r.current_calculation_id::text,c.entrypoint,c.operation_id::text,c.supersedes_calculation_id::text,
              c.context_snapshot->>'orgId' AS org_id,c.context_snapshot->>'userId' AS user_id
         FROM attendance_records r JOIN attendance_record_calculations c ON c.id=r.current_calculation_id
          AND c.attendance_record_id=r.id AND c.org_id=r.org_id WHERE r.id=$1 AND r.org_id=$2`,
      [foreignTargets.source.recordId, foreign.orgId])
    expect(foreignResult.rows).toHaveLength(1)
    expect(foreignResult.rows).toEqual([{ current_calculation_id: foreignResult.rows[0].current_calculation_id,
      entrypoint: 'correction', operation_id: foreignOperationId,
      supersedes_calculation_id: foreignTargets.source.calculationId, org_id: foreign.orgId, user_id: foreign.userId }])
    expect(foreignResult.rows[0].current_calculation_id).not.toBe(foreignTargets.source.calculationId)
    const afterForeign = await populatedIsolationState(fixtures)
    expect(afterForeign[0].sourceRows).toEqual(afterCurrent[0].sourceRows)
    const retainedSnapshots = await pool.query(
      'SELECT * FROM attendance_request_calculation_snapshots WHERE org_id=$1 AND request_id=$2 ORDER BY version',
      [current.orgId, requestId])
    expect(retainedSnapshots.rows).toEqual(currentSnapshots.rows)
    expect(afterForeign[1].sourceRows.calculations)
      .toHaveLength(afterCurrent[1].sourceRows.calculations.length + 1)
    const foreignExpected = { requests: foreignBefore.requests + 1, snapshots: foreignBefore.snapshots + 1,
      operations: foreignBefore.operations + 2, outbox: foreignBefore.outbox + 2 }
    expect(afterForeign[1].counts).toEqual(foreignExpected)
    expect(afterForeign[0].counts).toEqual(current.orgId === foreign.orgId ? foreignExpected : afterCurrent[0].counts)
  }

  describe('populated frozen source isolation', () => {
    it('A_ORG_POPULATED_SOURCE: rejects a fully valid other-org source for the same user and date', async () => {
      const current = await seedOrg('shadow')
      const otherOrg = await seedOrg('shadow')
      await pool.query('INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,$2,true)',
        [current.userId, otherOrg.orgId])
      const foreign = { orgId: otherOrg.orgId, userId: current.userId,
        token: await mintToken(current.userId, otherOrg.orgId) }
      expect(foreign.userId).toBe(current.userId)
      expect(foreign.orgId).not.toBe(current.orgId)
      await assertPopulatedSourceIsolation(current, foreign)
    })

    it('A_USER_POPULATED_SOURCE: rejects a fully valid same-org source owned by another active user', async () => {
      const current = await seedOrg('shadow')
      const foreign = { ...await seedOrgActor(current.orgId, 'attendance:approve'), orgId: current.orgId }
      expect(foreign.orgId).toBe(current.orgId)
      expect(foreign.userId).not.toBe(current.userId)
      await assertPopulatedSourceIsolation(current, foreign)
    })
  })

})
