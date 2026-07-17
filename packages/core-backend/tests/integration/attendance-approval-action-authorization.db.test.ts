import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'

// S7-0 (RATIFIED S7 lock §3.1/§3.2): the attendance approval engine must make the ACTIVE
// approval_assignments rows for the current node the ACTION-AUTHORIZATION source of truth for BOTH
// approve AND reject. Before S7-0, approve consulted only the legacy static step fields
// (approverUserIds/approverRoleIds) and reject had NO assignment check at all — so any actor who
// passed the broad scheduler-scope gate could approve or reject a request they were not assigned.
//
// This real-DB matrix drives the live approve/reject HTTP routes with RBAC_BYPASS='false' (real
// authorization) and asserts the per-`assignment_type` predicate the fix reuses verbatim from the
// central engine (ApprovalBridgeService.ts:359-363):
//   user         -> assignee_id == actorId
//   role         -> assignee_id ∈ the actor's role ids
//   source_queue -> assignee_id ∈ the actor's permission strings
// The 12-leg matrix (3 types × {positive, negative} × {approve, reject}) is designed so BOTH known
// wrong implementations fail: a user-equality-only check wrongly 403s the legitimate role/queue
// approvers (positive legs go red), and an exists-any-active-row check wrongly authorizes the
// unassigned-but-scope-authorized actor (every negative leg goes red). Admin-override legs assert
// hasAttendanceAdminAccess still authorizes a non-assignee, symmetric on approve and reject.
//
// The negative legs assert error.code === 'FORBIDDEN' (the assignment check's code), NOT
// 'SCHEDULER_SCOPE_FORBIDDEN' (the broad gate's code) — proving the block comes from the S7-0
// assignment check, not the pre-existing broad gate every actor here deliberately passes.

interface HttpResponse {
  status: number
  body: unknown
  raw: string
}

function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          let body: unknown
          try {
            body = data ? JSON.parse(data) : undefined
          } catch {
            body = undefined
          }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      }
    )
    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

const NODE_KEY_0 = 'attendance_request_step_0'

const attendanceAuthzDbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = attendanceAuthzDbUrl ? describe : describe.skip

describeIfDatabase('Attendance approval action authorization — S7-0 (approve + reject)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined
  let pool: Pool | undefined
  let previousRbacBypass: string | undefined

  const runSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const orgId = 'default'

  // Actors. Every APPROVER holds attendance:approve so the broad scheduler-scope gate
  // (canAccessOtherUsers) is passed by ALL of them — the S7-0 assignment check is therefore the
  // sole differentiator between authorized and blocked. The requester is the subject of the request
  // and needs no permissions (its rows are seeded directly, not created via the API).
  const requesterUserId = `s7req-${runSuffix}`
  const userAssignee = `s7-user-assignee-${runSuffix}`
  const roleAssignee = `s7-role-assignee-${runSuffix}`
  const queueAssignee = `s7-queue-assignee-${runSuffix}`
  // The single "scope-authorized but NOT assigned" negative actor, reused across every negative leg:
  // holds attendance:approve (passes the broad gate) but matches no crafted assignment.
  const otherApprover = `s7-other-approver-${runSuffix}`
  // Admin override actor: holds attendance:admin (=> hasAttendanceAdminAccess) but is never the
  // crafted assignee.
  const adminActor = `s7-admin-${runSuffix}`

  const assignedRoleId = `s7-role-${runSuffix}`
  const queuePermission = `attendance:s7-queue-${runSuffix}`

  const allActorIds = [
    requesterUserId,
    userAssignee,
    roleAssignee,
    queueAssignee,
    otherApprover,
    adminActor,
  ]

  const tokens: Record<string, string> = {}
  const createdInstanceIds: string[] = []
  const createdRequestIds: string[] = []

  async function devToken(userId: string, roles: string, perms: string): Promise<string> {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(
        roles
      )}&perms=${encodeURIComponent(perms)}`
    )
    const token = (res.body as { token?: string } | undefined)?.token
    if (!token) {
      throw new Error(`dev-token issuance failed for ${userId}: ${res.raw}`)
    }
    return token
  }

  // Seed a fresh pending attendance request + shared-pool approval instance + a precisely-crafted
  // ACTIVE assignment set for the current node (step 0). A 2-step flow makes `approve` NON-final so
  // the positive-approve legs reach a clean 200 without exercising request-type finalization side
  // effects; `reject` is final regardless. The crafted assignments — not buildAttendanceApprovalAssignments'
  // production output — are what the S7-0 check reads, so the test targets the authorization check
  // directly and controls the assignment_type under test.
  async function seedRequest(
    assignments: Array<{ type: 'user' | 'role' | 'source_queue'; assignee: string }>
  ): Promise<{ requestId: string; instanceId: string }> {
    const requestId = randomUUID()
    const instanceId = randomUUID()
    const client = pool as Pool

    await client.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, current_step, total_steps, current_node_key)
       VALUES ($1, 'pending', 0, 'platform', 'attendance_request_approval', $2, $3,
               $4::jsonb, 0, 2, $5)`,
      [
        instanceId,
        `attendance-request:${requestId}`,
        `S7-0 authz ${runSuffix}`,
        JSON.stringify({ id: requesterUserId, name: requesterUserId }),
        NODE_KEY_0,
      ]
    )
    createdInstanceIds.push(instanceId)

    await client.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, approval_instance_id, metadata)
       VALUES ($1, $2, CURRENT_DATE, 'missed_check_in', 'pending', $3, $4, $5::jsonb)`,
      [
        requestId,
        requesterUserId,
        orgId,
        instanceId,
        JSON.stringify({ approvalFlow: { steps: [{}, {}], currentStep: 0 } }),
      ]
    )
    createdRequestIds.push(requestId)

    for (const assignment of assignments) {
      await client.query(
        `INSERT INTO approval_assignments
           (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata)
         VALUES ($1, $2, $3, $4, 0, TRUE, '{}'::jsonb)`,
        [instanceId, assignment.type, assignment.assignee, NODE_KEY_0]
      )
    }

    return { requestId, instanceId }
  }

  async function act(requestId: string, token: string, action: 'approve' | 'reject'): Promise<HttpResponse> {
    return requestJson(`${baseUrl}/api/attendance/requests/${requestId}/${action}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ comment: `s7-0 ${action} authorization test` }),
    })
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) {
      throw new Error('S7-0 authorization tests require an available loopback port.')
    }

    const dbUrl = attendanceAuthzDbUrl
    if (!dbUrl) {
      throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required for the S7-0 authorization suite.')
    }

    process.env.DATABASE_URL = dbUrl
    // Exercise the REAL authorization path: with RBAC_BYPASS='true' (the integration default),
    // hasAttendanceAdminAccess short-circuits to true for everyone and the admin override would mask
    // the assignment check entirely. Override to 'false' for this file only, restored in afterAll.
    previousRbacBypass = process.env.RBAC_BYPASS
    process.env.RBAC_BYPASS = 'false'
    process.env.SKIP_PLUGINS = 'false'

    const repoRoot = path.join(__dirname, '../../../../')

    pool = new Pool({ connectionString: dbUrl })
    await pool.query('SELECT 1')

    // Seed the RBAC substrate the plugin's checks read (DB tables, NOT the JWT claims).
    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES
         ('attendance:approve', 'Attendance Approve', 'Approve attendance requests'),
         ('attendance:admin', 'Attendance Admin', 'Administer attendance'),
         ($1, 'S7-0 Queue Permission', 'Custom source_queue permission for S7-0 authz test')
       ON CONFLICT (code) DO NOTHING`,
      [queuePermission]
    )
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES
         ($1, 'attendance:approve'),
         ($2, 'attendance:approve'),
         ($3, 'attendance:approve'),
         ($4, 'attendance:approve'),
         ($4, $6),
         ($5, 'attendance:admin')
       ON CONFLICT DO NOTHING`,
      [userAssignee, roleAssignee, otherApprover, queueAssignee, adminActor, queuePermission]
    )
    await pool.query(
      `INSERT INTO user_roles (user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [roleAssignee, assignedRoleId]
    )

    // Load MetaSheetServer only AFTER DATABASE_URL is set (the DB pool initializes at import).
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') {
      throw new Error('S7-0 authorization server did not expose a TCP address.')
    }
    baseUrl = `http://127.0.0.1:${address.port}`

    tokens[userAssignee] = await devToken(userAssignee, 'user', 'attendance:approve')
    tokens[roleAssignee] = await devToken(roleAssignee, 'user', 'attendance:approve')
    tokens[queueAssignee] = await devToken(queueAssignee, 'user', 'attendance:approve')
    tokens[otherApprover] = await devToken(otherApprover, 'user', 'attendance:approve')
    tokens[adminActor] = await devToken(adminActor, 'user', 'attendance:admin')
  })

  afterAll(async () => {
    if (pool) {
      try {
        if (createdRequestIds.length > 0) {
          await pool
            .query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds])
            .catch(() => undefined)
        }
        if (createdInstanceIds.length > 0) {
          await pool
            .query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [createdInstanceIds])
            .catch(() => undefined)
          await pool
            .query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [createdInstanceIds])
            .catch(() => undefined)
          await pool
            .query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds])
            .catch(() => undefined)
        }
        await pool
          .query('DELETE FROM user_roles WHERE user_id = ANY($1::varchar[])', [allActorIds])
          .catch(() => undefined)
        await pool
          .query('DELETE FROM user_permissions WHERE user_id = ANY($1::varchar[])', [allActorIds])
          .catch(() => undefined)
        await pool
          .query('DELETE FROM permissions WHERE code = $1', [queuePermission])
          .catch(() => undefined)
      } finally {
        await pool.end()
      }
    }
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) {
      await (server as unknown as { stop: () => Promise<void> }).stop()
    }
    if (previousRbacBypass === undefined) {
      delete process.env.RBAC_BYPASS
    } else {
      process.env.RBAC_BYPASS = previousRbacBypass
    }
  })

  // ---- The 12-leg per-assignment_type matrix (positive + negative × approve + reject) ----
  const typeLegs: Array<{
    label: 'user' | 'role' | 'source_queue'
    positiveActor: () => string
    assignments: () => Array<{ type: 'user' | 'role' | 'source_queue'; assignee: string }>
  }> = [
    {
      label: 'user',
      positiveActor: () => userAssignee,
      assignments: () => [{ type: 'user', assignee: userAssignee }],
    },
    {
      label: 'role',
      positiveActor: () => roleAssignee,
      assignments: () => [{ type: 'role', assignee: assignedRoleId }],
    },
    {
      label: 'source_queue',
      positiveActor: () => queueAssignee,
      assignments: () => [{ type: 'source_queue', assignee: queuePermission }],
    },
  ]

  for (const leg of typeLegs) {
    for (const action of ['approve', 'reject'] as const) {
      it(`${leg.label} · ${action} · assigned actor is authorized (positive)`, async () => {
        const { requestId, instanceId } = await seedRequest(leg.assignments())
        const res = await act(requestId, tokens[leg.positiveActor()], action)
        expect(res.status, res.raw).toBe(200)
        const rec = await (pool as Pool).query(
          'SELECT 1 FROM approval_records WHERE instance_id = $1 AND actor_id = $2 AND action = $3',
          [instanceId, leg.positiveActor(), action]
        )
        expect(rec.rows.length, `expected an approval_records ${action} row for the assigned actor`).toBeGreaterThan(0)
      })

      it(`${leg.label} · ${action} · unassigned scope-authorized actor is blocked 403/FORBIDDEN (negative)`, async () => {
        const { requestId, instanceId } = await seedRequest(leg.assignments())
        const res = await act(requestId, tokens[otherApprover], action)
        // 403 from the S7-0 assignment check specifically (FORBIDDEN), not the broad scheduler-scope
        // gate (SCHEDULER_SCOPE_FORBIDDEN) — otherApprover holds attendance:approve and passes that
        // gate, so any 403 here can only be the assignment check.
        expect(res.status, res.raw).toBe(403)
        expect((res.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('FORBIDDEN')
        // The blocked action must not have mutated the instance (check precedes the UPDATE, inside txn).
        const inst = await (pool as Pool).query(
          'SELECT status, version FROM approval_instances WHERE id = $1',
          [instanceId]
        )
        expect(inst.rows[0].status).toBe('pending')
        expect(Number(inst.rows[0].version)).toBe(0)
        const rec = await (pool as Pool).query(
          'SELECT 1 FROM approval_records WHERE instance_id = $1 AND actor_id = $2',
          [instanceId, otherApprover]
        )
        expect(rec.rows.length, 'a blocked actor must not have written an approval record').toBe(0)
      })
    }
  }

  // ---- Admin-override legs: a non-assignee admin still authorized on BOTH actions ----
  for (const action of ['approve', 'reject'] as const) {
    it(`admin override · ${action} · admin authorized without being the assignee`, async () => {
      // Assignment is user:userAssignee — adminActor is NOT the assignee and matches no branch, so
      // authorization can only come from the admin override applied AFTER the failed match.
      const { requestId, instanceId } = await seedRequest([{ type: 'user', assignee: userAssignee }])
      const res = await act(requestId, tokens[adminActor], action)
      expect(res.status, res.raw).toBe(200)
      const rec = await (pool as Pool).query(
        'SELECT 1 FROM approval_records WHERE instance_id = $1 AND actor_id = $2 AND action = $3',
        [instanceId, adminActor, action]
      )
      expect(rec.rows.length, `expected an approval_records ${action} row for the admin override`).toBeGreaterThan(0)
    })
  }
})
