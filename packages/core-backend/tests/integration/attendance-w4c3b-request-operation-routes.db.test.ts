import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import type { MetaSheetServer } from '../../src/index'

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

describeIfDatabase('W4C-3b P13 request operation routes (real plugin, real PostgreSQL)', () => {
  let server: MetaSheetServer | undefined
  let pool: Pool
  let baseUrl = ''
  const priorEnv = {
    databaseUrl: process.env.DATABASE_URL,
    rbacBypass: process.env.RBAC_BYPASS,
    skipPlugins: process.env.SKIP_PLUGINS,
    rollout: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
  }

  async function mintToken(userId: string): Promise<string> {
    const response = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
    )
    const token = response.body?.token
    if (typeof token !== 'string' || !token) throw new Error(`failed to mint token: ${response.raw}`)
    return token
  }

  async function seedOrg(
    state: 'legacy' | 'shadow' | 'suspended',
    permission = 'attendance:admin',
  ) {
    const orgId = randomUUID()
    const userId = randomUUID()
    await pool.query(
      `INSERT INTO users
       (id, email, username, name, password_hash, role, permissions, is_active, is_admin, created_at, updated_at)
       VALUES ($1, $2, $1, 'W4C-3b request fixture', 'x', 'user', $3::jsonb,
               true, false, now(), now())`,
      [userId, `w4c3b-request-${userId}@example.test`, JSON.stringify([permission])],
    )
    await pool.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [userId, orgId])
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
       (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'legacy', 'w4c3b-request-test', 'TEST_FIXTURE', $2, 1, NULL, 'synthetic_staging')`,
      [orgId, userId],
    )
    if (state === 'shadow' || state === 'suspended') {
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'shadow', prior_state = 'legacy', version = 2
          WHERE org_id = $1`,
        [orgId],
      )
    }
    if (state === 'suspended') {
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
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = 'suspended', prior_state = 'authoritative', version = 5
          WHERE org_id = $1`,
        [orgId],
      )
    }
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = orgId
    return { orgId, userId, token: await mintToken(userId) }
  }

  async function createRequest(
    fixture: Awaited<ReturnType<typeof seedOrg>>,
    workDate: string,
  ) {
    const response = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}` },
      body: {
        operationId: randomUUID(),
        orgId: fixture.orgId,
        workDate,
        requestType: 'missed_check_in',
        requestedInAt: `${workDate}T09:00:00.000Z`,
        reason: 'W4C-3b decision fixture',
      },
    })
    expect(response.status, response.raw).toBe(201)
    const requestId = response.body?.data?.request?.id
    expect(typeof requestId).toBe('string')
    return requestId as string
  }

  async function loadApprovalCursor(requestId: string) {
    const result = await pool.query(
      `SELECT ai.id, ai.version, ai.current_node_key
         FROM attendance_requests ar
         JOIN approval_instances ai ON ai.id = ar.approval_instance_id
        WHERE ar.id = $1::uuid`,
      [requestId],
    )
    expect(result.rows).toHaveLength(1)
    return {
      approvalId: String(result.rows[0].id),
      version: Number(result.rows[0].version),
      node: String(result.rows[0].current_node_key),
    }
  }

  async function assignApprovalUser(
    approval: Awaited<ReturnType<typeof loadApprovalCursor>>,
    userId: string,
  ) {
    await pool.query(
      `INSERT INTO approval_assignments
         (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata)
       VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)`,
      [approval.approvalId, userId, approval.node],
    )
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
    return { userId, token: await mintToken(userId) }
  }

  async function requestDecisionResidue(orgId: string, requestId: string) {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_result_operations
           WHERE org_id = $1 AND entrypoint = 'request_decision' AND resolved_request_id = $2::uuid) AS operations,
         (SELECT count(*)::int
            FROM attendance_result_event_outbox outbox
            JOIN attendance_result_operations operation
              ON operation.org_id = outbox.org_id
             AND operation.entrypoint = outbox.entrypoint
             AND operation.operation_id = outbox.operation_id
           WHERE operation.org_id = $1
             AND operation.entrypoint = 'request_decision'
             AND operation.resolved_request_id = $2::uuid) AS outbox,
         (SELECT count(*)::int FROM approval_records pr
           JOIN attendance_requests ar ON ar.approval_instance_id = pr.instance_id
          WHERE ar.org_id = $1 AND ar.id = $2::uuid) AS approval_records`,
      [orgId, requestId],
    )
    return result.rows[0] as { operations: number; outbox: number; approval_records: number }
  }

  async function dispatchCentralDecision(
    approvalId: string,
    actorId: string,
    action: 'approve' | 'reject',
  ) {
    const { ApprovalBridgeService } = await import('../../src/services/ApprovalBridgeService')
    const bridge = new ApprovalBridgeService(null)
    return bridge.dispatchAction(
      approvalId,
      { action, comment: `central ${action}` },
      { userId: actorId, userName: actorId },
    )
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

  beforeAll(async () => {
    if (!dbUrl || !(await canListen())) throw new Error('W4C3B_REQUEST_ROUTE_TEST_REQUIRES_DATABASE_AND_LOOPBACK')
    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
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
  }, 120000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (server) await server.stop()
    for (const [key, value] of Object.entries({
      DATABASE_URL: priorEnv.databaseUrl,
      RBAC_BYPASS: priorEnv.rbacBypass,
      SKIP_PLUGINS: priorEnv.skipPlugins,
      ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED: priorEnv.rollout,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('replays shadow create and edit without duplicate source, snapshot, operation, or outbox rows', async () => {
    const fixture = await seedOrg('shadow')
    const createOperationId = randomUUID()
      const createBody = {
        operationId: createOperationId,
        orgId: fixture.orgId,
        workDate: '2049-08-01',
        requestType: 'missed_check_in',
        requestedInAt: '2049-08-01T09:00:00.000Z',
        reason: 'P13 create',
      }
      const headers = { Authorization: `Bearer ${fixture.token}` }
      const first = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: createBody })
      const replay = await requestJson(`${baseUrl}/api/attendance/requests`, { method: 'POST', headers, body: createBody })
      expect(first.status).toBe(201)
      expect(replay.status).toBe(201)
      expect(replay.body).toEqual(first.body)
      expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 1, operations: 1, outbox: 1 })

      const requestId = first.body?.data?.request?.id
      const snapshot = first.body?.data?.requestSnapshot
      expect(typeof requestId).toBe('string')
      expect(snapshot).toMatchObject({ version: 1 })
      const editOperationId = randomUUID()
      const editBody = {
        operationId: editOperationId,
        reason: 'P13 edit',
        expectedSnapshotVersion: snapshot.version,
        expectedSnapshotFingerprint: snapshot.fingerprint,
      }
      const edited = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
        method: 'PUT', headers, body: editBody,
      })
      const editReplay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}`, {
        method: 'PUT', headers, body: editBody,
      })
      expect(edited.status, JSON.stringify(edited.body)).toBe(200)
      expect(editReplay.status).toBe(200)
      expect(editReplay.body).toEqual(edited.body)
    expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 2, operations: 2, outbox: 2 })
  })

  it('keeps null-ID legacy bytes while producing zero W4 rows', async () => {
    const fixture = await seedOrg('legacy')
    const response = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fixture.token}` },
        body: {
          orgId: fixture.orgId,
          workDate: '2049-08-02',
          requestType: 'missed_check_in',
          requestedInAt: '2049-08-02T09:00:00.000Z',
          reason: 'legacy create',
        },
      })
      expect(response.status).toBe(201)
      expect(response.body?.data?.request).toMatchObject({
        org_id: fixture.orgId,
        request_type: 'missed_check_in',
      })
    expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 0, operations: 0, outbox: 0 })
  })

  it('blocks suspended create before request, approval, snapshot, operation, and outbox DML', async () => {
    const fixture = await seedOrg('suspended')
    const response = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${fixture.token}` },
        body: {
          operationId: randomUUID(),
          orgId: fixture.orgId,
          workDate: '2049-08-03',
          requestType: 'missed_check_in',
          requestedInAt: '2049-08-03T09:00:00.000Z',
        },
      })
      expect(response.status).toBe(503)
      expect(response.body?.error?.code).toBe('SEGMENT_CALCULATION_SUSPENDED')
    expect(await counts(fixture.orgId)).toEqual({ requests: 0, snapshots: 0, operations: 0, outbox: 0 })
  })

  it('replays a shadow cancellation without duplicating source, operation, or outbox rows', async () => {
    const fixture = await seedOrg('shadow')
    const headers = { Authorization: `Bearer ${fixture.token}` }
    const created = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers,
      body: {
        operationId: randomUUID(),
        orgId: fixture.orgId,
        workDate: '2049-08-04',
        requestType: 'missed_check_in',
        requestedInAt: '2049-08-04T09:00:00.000Z',
        reason: 'P14 cancel replay',
      },
    })
    expect(created.status, created.raw).toBe(201)
    const requestId = created.body?.data?.request?.id
    const snapshot = created.body?.data?.requestSnapshot
    expect(typeof requestId).toBe('string')
    expect(snapshot).toMatchObject({ version: 1 })

    const cancelBody = {
      operationId: randomUUID(),
      expectedSnapshotVersion: snapshot.version,
      expectedSnapshotFingerprint: snapshot.fingerprint,
      comment: 'cancel once',
    }
    const first = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/cancel`, {
      method: 'POST', headers, body: cancelBody,
    })
    const replay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/cancel`, {
      method: 'POST', headers, body: cancelBody,
    })
    expect(first.status, first.raw).toBe(200)
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(first.body?.data).toMatchObject({ requestId, status: 'cancelled', orgId: fixture.orgId })
    expect(await counts(fixture.orgId)).toEqual({ requests: 1, snapshots: 1, operations: 2, outbox: 2 })

    const persisted = await pool.query(
      'SELECT status, resolved_by FROM attendance_requests WHERE id = $1::uuid AND org_id = $2',
      [requestId, fixture.orgId],
    )
    expect(persisted.rows).toEqual([{ status: 'cancelled', resolved_by: fixture.userId }])
  })

  it('rolls back approved-leave cancellation when P14 has no frozen parent calculation', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = randomUUID()
    await pool.query(
      `INSERT INTO attendance_requests
         (id, org_id, user_id, work_date, request_type, status, reason)
       VALUES ($1::uuid, $2, $3, '2049-08-05', 'leave', 'approved', 'P14 no-parent route')`,
      [requestId, fixture.orgId, fixture.userId],
    )
    const before = await counts(fixture.orgId)
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.token}` },
      body: { operationId: randomUUID(), comment: 'must fail closed' },
    })
    expect(response.status, response.raw).toBe(409)
    expect(response.body?.error).toMatchObject({
      code: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
      details: [{ field: 'calculation', message: 'record_missing' }],
    })
    expect(await counts(fixture.orgId)).toEqual(before)
    const persisted = await pool.query(
      'SELECT status, resolved_by, resolved_at FROM attendance_requests WHERE id = $1::uuid AND org_id = $2',
      [requestId, fixture.orgId],
    )
    expect(persisted.rows).toEqual([{ status: 'approved', resolved_by: null, resolved_at: null }])
  })

  it('replays a shadow reject with exact approval OCC and no duplicate decision residue', async () => {
    const fixture = await seedOrg('shadow', 'attendance:approve')
    const requestId = await createRequest(fixture, '2049-08-06')
    const approval = await loadApprovalCursor(requestId)
    await assignApprovalUser(approval, fixture.userId)
    const operationId = randomUUID()
    const body = {
      operationId,
      expectedApprovalVersion: approval.version,
      expectedApprovalNode: approval.node,
      comment: 'reject exactly once',
    }
    const headers = { Authorization: `Bearer ${fixture.token}` }
    const first = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST', headers, body,
    })
    const replay = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST', headers, body,
    })
    expect(first.status, first.raw).toBe(200)
    expect(replay.status, replay.raw).toBe(200)
    expect(replay.body).toEqual(first.body)
    expect(first.body?.data).toMatchObject({ requestId, status: 'rejected' })
    expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
      operations: 1,
      outbox: 1,
      approval_records: 1,
    })
  })

  it('fails closed on missing OCC, incongruent replay, and a new operation after resolution', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = await createRequest(fixture, '2049-08-07')
    const approval = await loadApprovalCursor(requestId)
    const headers = { Authorization: `Bearer ${fixture.token}` }

    const missingOcc = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers,
      body: { operationId: randomUUID(), comment: 'missing OCC' },
    })
    expect(missingOcc.status, missingOcc.raw).toBe(400)
    expect(missingOcc.body?.error?.code).toBe('REQUEST_DECISION_OCC_REQUIRED')
    expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
      operations: 0,
      outbox: 0,
      approval_records: 0,
    })

    const operationId = randomUUID()
    const acceptedBody = {
      operationId,
      expectedApprovalVersion: approval.version,
      expectedApprovalNode: approval.node,
      comment: 'accepted command',
    }
    const accepted = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST', headers, body: acceptedBody,
    })
    expect(accepted.status, accepted.raw).toBe(200)

    const conflict = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers,
      body: { ...acceptedBody, comment: 'different command' },
    })
    expect(conflict.status, conflict.raw).toBe(409)
    expect(conflict.body?.error?.code).toBe('ATTENDANCE_OPERATION_CONFLICT')

    const resolvedRetry = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers,
      body: {
        ...acceptedBody,
        operationId: randomUUID(),
      },
    })
    expect(resolvedRetry.status, resolvedRetry.raw).toBe(400)
    expect(resolvedRetry.body?.error?.code).toBe('INVALID_STATUS')
    expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
      operations: 1,
      outbox: 1,
      approval_records: 1,
    })
  })

  it('rejects a durable actor without active org membership before decision DML', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = await createRequest(fixture, '2049-08-08')
    const approval = await loadApprovalCursor(requestId)
    const outsiderId = randomUUID()
    await pool.query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin, activation_status)
       VALUES ($1, $2, $1, 'W4C-3b outsider', 'x', 'user', '["attendance:approve"]'::jsonb,
               TRUE, FALSE, 'activated')`,
      [outsiderId, `w4c3b-outsider-${outsiderId}@example.test`],
    )
    const outsiderToken = await mintToken(outsiderId)
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsiderToken}` },
      body: {
        operationId: randomUUID(),
        expectedApprovalVersion: approval.version,
        expectedApprovalNode: approval.node,
        comment: 'cross-org attempt',
      },
    })
    expect(response.status, response.raw).toBe(403)
    expect(response.body?.error?.code).toBe('FORBIDDEN')
    expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
      operations: 0,
      outbox: 0,
      approval_records: 0,
    })
  })

  it('rejects an active same-org approver who is not assigned before decision DML', async () => {
    const fixture = await seedOrg('shadow')
    const requestId = await createRequest(fixture, '2049-08-09')
    const approval = await loadApprovalCursor(requestId)
    const unassigned = await seedOrgActor(fixture.orgId, 'attendance:approve')
    const response = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/reject`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${unassigned.token}` },
      body: {
        operationId: randomUUID(),
        expectedApprovalVersion: approval.version,
        expectedApprovalNode: approval.node,
        comment: 'same-org unassigned attempt',
      },
    })
    expect(response.status, response.raw).toBe(403)
    expect(response.body?.error?.code).toBe('FORBIDDEN')
    expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
      operations: 0,
      outbox: 0,
      approval_records: 0,
    })
  })

  it('keeps central and plugin reject paths single-bodied in both sequential orders', async () => {
    for (const order of ['central-first', 'plugin-first'] as const) {
      const fixture = await seedOrg('shadow', 'attendance:approve')
      const requestId = await createRequest(
        fixture,
        order === 'central-first' ? '2049-08-10' : '2049-08-11',
      )
      const approval = await loadApprovalCursor(requestId)
      await assignApprovalUser(approval, fixture.userId)
      const headers = { Authorization: `Bearer ${fixture.token}` }
      const body = {
        operationId: randomUUID(),
        expectedApprovalVersion: approval.version,
        expectedApprovalNode: approval.node,
        comment: `${order} plugin reject`,
      }
      const pluginDecision = () => requestJson(
        `${baseUrl}/api/attendance/requests/${requestId}/reject`,
        { method: 'POST', headers, body },
      )

      if (order === 'central-first') {
        await expect(
          dispatchCentralDecision(approval.approvalId, fixture.userId, 'reject'),
        ).rejects.toMatchObject({
          code: 'ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED',
          statusCode: 409,
        })
        expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
          operations: 0,
          outbox: 0,
          approval_records: 0,
        })
        const response = await pluginDecision()
        expect(response.status, response.raw).toBe(200)
      } else {
        const response = await pluginDecision()
        expect(response.status, response.raw).toBe(200)
        await expect(
          dispatchCentralDecision(approval.approvalId, fixture.userId, 'reject'),
        ).rejects.toMatchObject({
          code: 'INVALID_STATUS_TRANSITION',
          statusCode: 409,
        })
      }

      expect(await requestDecisionResidue(fixture.orgId, requestId)).toEqual({
        operations: 1,
        outbox: 1,
        approval_records: 1,
      })
      const terminal = await pool.query(
        `SELECT ar.status AS request_status,
                ai.status AS approval_status,
                ai.version AS approval_version,
                count(aa.id) FILTER (WHERE aa.is_active = TRUE)::int AS active_assignments
           FROM attendance_requests ar
           JOIN approval_instances ai ON ai.id = ar.approval_instance_id
           LEFT JOIN approval_assignments aa ON aa.instance_id = ai.id
          WHERE ar.id = $1::uuid AND ar.org_id = $2
          GROUP BY ar.status, ai.status, ai.version`,
        [requestId, fixture.orgId],
      )
      expect(terminal.rows).toEqual([{
        request_status: 'rejected',
        approval_status: 'rejected',
        approval_version: approval.version + 1,
        active_assignments: 0,
      }])
    }
  })
})
