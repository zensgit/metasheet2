import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'

// S7-1 (RATIFIED attendance-approval-s7 resolver design-lock): real-DB, HTTP-level coverage of the
// DISCRIMINATED-UNION step contract (§7 S7-1) and the RUNTIME fail-closed gate (§4.1). Two behavior
// classes:
//   • Authoring: the create (POST) AND update (PUT) approval-flow routes 422 every malformed/unavailable
//     dynamic step, each with a DISTINCT error code (mutation-friendly). At S7-1 no resolver is wired,
//     so even a shape-valid dynamic kind (flag ON) is APPROVAL_STEP_KIND_UNAVAILABLE.
//   • Runtime: a persisted dynamic-kind flow reached at request-create or step-advance while the flag is
//     OFF fails-closed BEFORE any mutation — never the legacy admin fallback. Because S7-1's authoring
//     API refuses dynamic kinds, the runtime tests seed the dynamic flow directly via SQL (simulating a
//     flow authored under a future flag-ON+resolver state, then the flag flipped off) — exactly the
//     defense-in-depth window §4.1 exists to close.
//
// RBAC_BYPASS='true' for this file: authorization is not under test here (S7-0 owns it); the bypass lets
// the approve reach the step-advance gate via the admin override so the §4.1 block is what we observe.

interface HttpResponse {
  status: number
  body: unknown
  raw: string
}

function requestJson(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
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
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function errorCode(res: HttpResponse): string | undefined {
  return (res.body as { error?: { code?: string } } | undefined)?.error?.code
}

const NODE_KEY_0 = 'attendance_request_step_0'
const NODE_KEY_1 = 'attendance_request_step_1'
const DYNAMIC_FLAG = 'ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED'
const HOST_MAX_LEVEL = 10 // host-resolved default (APPROVAL_MANAGER_CHAIN_MAX_LEVELS unset)

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

describeIfDatabase('S7-1 dynamic-kind step contract + fail-closed (authoring + runtime)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined
  let pool: Pool | undefined
  let prevRbac: string | undefined
  let prevFlag: string | undefined

  const runSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const orgId = `s7-1-${runSuffix}`
  const requester = `s7-1-req-${runSuffix}`
  let adminToken: string
  const createdFlowIds: string[] = []
  const createdInstanceIds: string[] = []
  const createdRequestIds: string[] = []

  function setFlag(on: boolean): void {
    if (on) process.env[DYNAMIC_FLAG] = 'true'
    else delete process.env[DYNAMIC_FLAG]
  }

  async function devToken(userId: string, roles: string, perms: string): Promise<string> {
    const res = await requestJson(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(
        roles,
      )}&perms=${encodeURIComponent(perms)}`,
    )
    const token = (res.body as { token?: string } | undefined)?.token
    if (!token) throw new Error(`dev-token issuance failed for ${userId}: ${res.raw}`)
    return token
  }

  function authHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }

  async function createFlow(steps: unknown[], name: string): Promise<HttpResponse> {
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ name, requestType: 'leave', steps, orgId, isActive: true }),
    })
    const id = (res.body as { data?: { id?: string } } | undefined)?.data?.id
    if (id) createdFlowIds.push(id)
    return res
  }

  async function seedStaticFlowRow(name: string): Promise<string> {
    const id = randomUUID()
    await (pool as Pool).query(
      `INSERT INTO attendance_approval_flows (id, org_id, name, request_type, steps, is_active)
       VALUES ($1, $2, $3, 'leave', $4::jsonb, true)`,
      [id, orgId, name, JSON.stringify([{ name: 'S', approverUserIds: [requester] }])],
    )
    createdFlowIds.push(id)
    return id
  }

  async function updateFlow(id: string, steps: unknown[]): Promise<HttpResponse> {
    return requestJson(`${baseUrl}/api/attendance/approval-flows/${id}`, {
      method: 'PUT',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ steps, orgId }),
    })
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) throw new Error('S7-1 tests require an available loopback port.')
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required for the S7-1 suite.')

    process.env.DATABASE_URL = dbUrl
    prevRbac = process.env.RBAC_BYPASS
    prevFlag = process.env[DYNAMIC_FLAG]
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    delete process.env[DYNAMIC_FLAG] // default OFF

    const repoRoot = path.join(__dirname, '../../../../')
    pool = new Pool({ connectionString: dbUrl })
    await pool.query('SELECT 1')

    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('S7-1 server did not expose a TCP address.')
    baseUrl = `http://127.0.0.1:${address.port}`

    adminToken = await devToken(requester, 'user', 'attendance:admin,attendance:write,attendance:approve')
  })

  afterAll(async () => {
    if (pool) {
      try {
        if (createdRequestIds.length > 0) {
          await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
        }
        await pool.query('DELETE FROM attendance_requests WHERE org_id = $1', [orgId]).catch(() => undefined)
        if (createdInstanceIds.length > 0) {
          await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [createdInstanceIds]).catch(() => undefined)
          await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [createdInstanceIds]).catch(() => undefined)
          await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds]).catch(() => undefined)
        }
        await pool.query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgId]).catch(() => undefined)
      } finally {
        await pool.end()
      }
    }
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) {
      await (server as unknown as { stop: () => Promise<void> }).stop()
    }
    if (prevRbac === undefined) delete process.env.RBAC_BYPASS
    else process.env.RBAC_BYPASS = prevRbac
    if (prevFlag === undefined) delete process.env[DYNAMIC_FLAG]
    else process.env[DYNAMIC_FLAG] = prevFlag
  })

  // ── Authoring rejection matrix — each shape gets a DISTINCT code, on BOTH create and update ──
  // Shape cases run with the flag OFF (default): the shape check precedes the availability check, so the
  // SHAPE code (not APPROVAL_STEP_KIND_UNAVAILABLE) must still surface — proving shape precedence.
  const shapeCases: Array<{ label: string; steps: unknown[]; code: string }> = [
    { label: 'unknown kind', steps: [{ kind: 'bogus_kind' }], code: 'APPROVAL_STEP_KIND_INVALID' },
    { label: 'continuous_managers is OUT-of-v1', steps: [{ kind: 'continuous_managers', levels: 2 }], code: 'APPROVAL_STEP_KIND_INVALID' },
    { label: 'manager_at_level missing level', steps: [{ kind: 'manager_at_level' }], code: 'APPROVAL_STEP_LEVEL_INVALID' },
    { label: 'manager_at_level non-integer level', steps: [{ kind: 'manager_at_level', level: 1.5 }], code: 'APPROVAL_STEP_LEVEL_INVALID' },
    { label: 'manager_at_level level 0', steps: [{ kind: 'manager_at_level', level: 0 }], code: 'APPROVAL_STEP_LEVEL_INVALID' },
    { label: 'manager_at_level level MAX+1', steps: [{ kind: 'manager_at_level', level: HOST_MAX_LEVEL + 1 }], code: 'APPROVAL_STEP_LEVEL_INVALID' },
    { label: 'static/dynamic mixed', steps: [{ kind: 'direct_manager', approverUserIds: ['u1'] }], code: 'APPROVAL_STEP_STATIC_DYNAMIC_MIXED' },
  ]

  for (const c of shapeCases) {
    it(`CREATE rejects ${c.label} → 422 ${c.code}`, async () => {
      setFlag(false)
      const res = await createFlow(c.steps, `s7-1-create-${c.code}-${runSuffix}-${Math.random().toString(36).slice(2, 6)}`)
      expect(res.status, res.raw).toBe(422)
      expect(errorCode(res)).toBe(c.code)
    })

    it(`UPDATE rejects ${c.label} → 422 ${c.code}`, async () => {
      setFlag(false)
      const flowId = await seedStaticFlowRow(`s7-1-update-${c.code}-${runSuffix}-${Math.random().toString(36).slice(2, 6)}`)
      const res = await updateFlow(flowId, c.steps)
      expect(res.status, res.raw).toBe(422)
      expect(errorCode(res)).toBe(c.code)
      // The rejected update must not have replaced the persisted static steps.
      const row = await (pool as Pool).query('SELECT steps FROM attendance_approval_flows WHERE id = $1', [flowId])
      expect(JSON.stringify(row.rows[0].steps)).toContain(requester)
    })
  }

  it('CREATE rejects a shape-valid dynamic kind at S7-1 (flag ON, no resolver) → 422 APPROVAL_STEP_KIND_UNAVAILABLE', async () => {
    setFlag(true)
    try {
      const res = await createFlow([{ kind: 'direct_manager' }], `s7-1-unavail-${runSuffix}`)
      expect(res.status, res.raw).toBe(422)
      expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')
    } finally {
      setFlag(false)
    }
  })

  it('CREATE + UPDATE accept a valid static flow (legacy path unaffected)', async () => {
    setFlag(false)
    const created = await createFlow([{ name: 'LM', approverUserIds: [requester] }], `s7-1-static-${runSuffix}`)
    expect(created.status, created.raw).toBe(201)
    const flowId = (created.body as { data?: { id?: string } }).data?.id as string
    const updated = await updateFlow(flowId, [{ name: 'LM2', approverUserIds: [requester] }])
    expect(updated.status, updated.raw).toBe(200)
  })

  // ── §4.1 runtime create fail-closed: a dynamic flow reached at request submission, flag OFF ──
  it('RUNTIME create: dynamic flow + flag OFF ⇒ request-create fails-closed with ZERO persisted rows', async () => {
    setFlag(false)
    // Seed (bypassing the S7-1 authoring gate) an ACTIVE dynamic time_correction flow — the only active
    // time_correction flow in this unique org, so loadApprovalFlow picks it.
    const dynFlowId = randomUUID()
    await (pool as Pool).query(
      `INSERT INTO attendance_approval_flows (id, org_id, name, request_type, steps, is_active)
       VALUES ($1, $2, $3, 'time_correction', $4::jsonb, true)`,
      [dynFlowId, orgId, `s7-1-runtime-create-${runSuffix}`, JSON.stringify([{ kind: 'direct_manager' }])],
    )
    createdFlowIds.push(dynFlowId)

    const workDate = '2026-05-20'
    const before = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1 AND user_id = $2',
      [orgId, requester],
    )
    const res = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        orgId,
        workDate,
        requestType: 'time_correction',
        requestedInAt: `${workDate}T01:25:00Z`,
        requestedOutAt: `${workDate}T10:00:00Z`,
        reason: 's7-1 runtime create fail-closed',
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')
    const after = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1 AND user_id = $2',
      [orgId, requester],
    )
    expect(after.rows[0].n, 'no attendance_requests row may persist on a fail-closed create').toBe(before.rows[0].n)
  })

  // ── §4.1 runtime step-advance fail-closed: approve step 1 advancing into a dynamic step 2, flag OFF ──
  it('RUNTIME advance: approve step 1 into dynamic step 2 + flag OFF ⇒ fails-closed and rolls back (no mutation)', async () => {
    setFlag(false)
    const requestId = randomUUID()
    const instanceId = randomUUID()
    const client = pool as Pool

    // step 1 static (index 0), step 2 dynamic (index 1) — frozen into the request metadata.
    await client.query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, current_step, total_steps, current_node_key)
       VALUES ($1, 'pending', 0, 'platform', 'attendance_request_approval', $2, $3,
               $4::jsonb, 0, 2, $5)`,
      [
        instanceId,
        `attendance-request:${requestId}`,
        `S7-1 advance ${runSuffix}`,
        JSON.stringify({ id: requester, name: requester }),
        NODE_KEY_0,
      ],
    )
    createdInstanceIds.push(instanceId)

    await client.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, approval_instance_id, metadata)
       VALUES ($1, $2, CURRENT_DATE, 'missed_check_in', 'pending', $3, $4, $5::jsonb)`,
      [
        requestId,
        requester,
        orgId,
        instanceId,
        JSON.stringify({ approvalFlow: { steps: [{ approverUserIds: [requester] }, { kind: 'direct_manager' }], currentStep: 0 } }),
      ],
    )
    createdRequestIds.push(requestId)

    // Active assignment for the current (static, step-0) node — requester is the assignee.
    await client.query(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, source_step, is_active, metadata)
       VALUES ($1, 'user', $2, $3, 0, TRUE, '{}'::jsonb)`,
      [instanceId, requester, NODE_KEY_0],
    )

    const res = await requestJson(`${baseUrl}/api/attendance/requests/${requestId}/approve`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({ comment: 's7-1 advance fail-closed' }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')

    // The transaction must have rolled back: still step 0, version 0, pending, no record, node unchanged.
    const inst = await client.query('SELECT status, version, current_step, current_node_key FROM approval_instances WHERE id = $1', [instanceId])
    expect(inst.rows[0].status).toBe('pending')
    expect(Number(inst.rows[0].version)).toBe(0)
    expect(Number(inst.rows[0].current_step)).toBe(0)
    expect(inst.rows[0].current_node_key).toBe(NODE_KEY_0)
    const rec = await client.query('SELECT 1 FROM approval_records WHERE instance_id = $1', [instanceId])
    expect(rec.rows.length, 'a fail-closed advance must not append an approval record').toBe(0)
    // No step-1 (dynamic) assignments were swapped in, and the step-0 assignment is untouched.
    const step1 = await client.query('SELECT 1 FROM approval_assignments WHERE instance_id = $1 AND node_key = $2', [instanceId, NODE_KEY_1])
    expect(step1.rows.length, 'no dynamic step-2 assignment may be written on a rolled-back advance').toBe(0)
    const step0 = await client.query('SELECT is_active FROM approval_assignments WHERE instance_id = $1 AND node_key = $2', [instanceId, NODE_KEY_0])
    expect(step0.rows.length).toBe(1)
    expect(step0.rows[0].is_active).toBe(true)
  })
})
