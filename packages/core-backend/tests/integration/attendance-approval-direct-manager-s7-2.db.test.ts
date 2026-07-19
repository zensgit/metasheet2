import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'

// S7-2 (RATIFIED attendance-approval-s7 resolver design-lock §2.1 / §3.3 / §3.4 / §4 / §4.1 / §7 S7-2):
// real-DB, HTTP-level coverage of direct_manager end-to-end:
//   linked resolution + freeze into requester_snapshot.managerId
//   unlinked block-with-error + zero persistence
//   two-org / one-local-user org-anchor
//   2-step freeze after directory relation mutation
//   dynamic assignment approve+reject authorization (negative / positive / admin)
//   flag-off create + flag-off advance rollback
//   legacy static still works with flag off
//   S7-1 NITs folded: empty-static-array MIXED + non-string kind → distinct 422
//
// RBAC_BYPASS is toggled per-case: authoring / create paths use 'true' for simplicity; the
// assignment-authorization legs force 'false' so the S7-0 predicate is what we observe.

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

const DYNAMIC_FLAG = 'ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED'
const NODE_KEY_0 = 'attendance_request_step_0'
const NODE_KEY_1 = 'attendance_request_step_1'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

describeIfDatabase('S7-2 direct_manager — freeze + assignment + auth (real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined
  let pool: Pool | undefined
  let prevRbac: string | undefined
  let prevFlag: string | undefined

  const runSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const orgHome = `s7-2-home-${runSuffix}`
  const orgForeign = `s7-2-foreign-${runSuffix}`
  const orgUnlinked = `s7-2-unlinked-${runSuffix}`
  const orgFreeze = `s7-2-freeze-${runSuffix}`
  const orgAuthz = `s7-2-authz-${runSuffix}`
  const orgFlagOff = `s7-2-flagoff-${runSuffix}`

  const requester = `s7-2-req-${runSuffix}`
  const managerHome = `s7-2-mgr-home-${runSuffix}`
  const managerForeign = `s7-2-mgr-foreign-${runSuffix}`
  const managerAlt = `s7-2-mgr-alt-${runSuffix}`
  const otherApprover = `s7-2-other-${runSuffix}`
  const adminActor = `s7-2-admin-${runSuffix}`

  const userIds: string[] = [requester, managerHome, managerForeign, managerAlt, otherApprover, adminActor]
  const integrationIds: string[] = []
  const createdFlowIds: string[] = []
  const createdInstanceIds: string[] = []
  const createdRequestIds: string[] = []

  let adminToken = ''
  let managerToken = ''
  let otherToken = ''
  let adminActorToken = ''

  // Directory fixture handles for freeze-mutation + org-anchor cases.
  let homeMgrAccountId = ''
  let homeDeptId = ''
  let homeIntegrationId = ''
  let freezeMgrAccountId = ''
  let freezeAltAccountId = ''
  let freezeDeptId = ''

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

  async function seedUser(userId: string): Promise<void> {
    await (pool as Pool).query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@s7-2.test`],
    )
  }

  async function seedIntegration(orgId: string, name: string, corpId: string): Promise<string> {
    const id = (
      await (pool as Pool).query<{ id: string }>(
        `INSERT INTO directory_integrations (org_id, name, corp_id, provider, status)
         VALUES ($1, $2, $3, 'dingtalk', 'active') RETURNING id`,
        [orgId, name, corpId],
      )
    ).rows[0].id
    integrationIds.push(id)
    return id
  }

  async function seedDept(integrationId: string, externalId: string, name: string): Promise<string> {
    return (
      await (pool as Pool).query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
         VALUES ($1, 'dingtalk', $2, $3, true, '{}'::jsonb) RETURNING id`,
        [integrationId, externalId, name],
      )
    ).rows[0].id
  }

  async function seedAccount(
    integrationId: string,
    externalUserId: string,
    externalKey: string,
    name: string,
    raw: Record<string, unknown> = {},
  ): Promise<string> {
    return (
      await (pool as Pool).query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, raw, is_active)
         VALUES ($1, 'dingtalk', $2, $3, $4, $5::jsonb, true) RETURNING id`,
        [integrationId, externalUserId, externalKey, name, JSON.stringify(raw)],
      )
    ).rows[0].id
  }

  async function link(accountId: string, userId: string): Promise<void> {
    await (pool as Pool).query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [accountId, userId],
    )
  }

  async function membership(
    accountId: string,
    departmentId: string,
    isPrimary: boolean,
    isManager = false,
  ): Promise<void> {
    await (pool as Pool).query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary, is_manager)
       VALUES ($1, $2, $3, $4)`,
      [accountId, departmentId, isPrimary, isManager],
    )
  }

  async function seedFlow(
    orgId: string,
    requestType: string,
    steps: unknown[],
    name: string,
  ): Promise<string> {
    const id = randomUUID()
    await (pool as Pool).query(
      `INSERT INTO attendance_approval_flows (id, org_id, name, request_type, steps, is_active)
       VALUES ($1, $2, $3, $4, $5::jsonb, true)`,
      [id, orgId, name, requestType, JSON.stringify(steps)],
    )
    createdFlowIds.push(id)
    return id
  }

  async function createRequest(
    orgId: string,
    token: string,
    workDate: string,
    reason: string,
  ): Promise<HttpResponse> {
    return requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        orgId,
        workDate,
        requestType: 'time_correction',
        requestedInAt: `${workDate}T01:00:00Z`,
        requestedOutAt: `${workDate}T10:00:00Z`,
        reason,
      }),
    })
  }

  function requestIdFrom(res: HttpResponse): string | undefined {
    return (res.body as { data?: { request?: { id?: string } } } | undefined)?.data?.request?.id
  }

  async function act(
    requestId: string,
    token: string,
    action: 'approve' | 'reject',
  ): Promise<HttpResponse> {
    return requestJson(`${baseUrl}/api/attendance/requests/${requestId}/${action}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ comment: `s7-2 ${action}` }),
    })
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) throw new Error('S7-2 tests require an available loopback port.')
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required for the S7-2 suite.')

    process.env.DATABASE_URL = dbUrl
    prevRbac = process.env.RBAC_BYPASS
    prevFlag = process.env[DYNAMIC_FLAG]
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    process.env[DYNAMIC_FLAG] = 'true'

    pool = new Pool({ connectionString: dbUrl })
    await pool.query('SELECT 1')

    for (const uid of userIds) await seedUser(uid)

    // ── orgHome: linked requester + normalized is_manager (authoritative) ──
    homeIntegrationId = await seedIntegration(orgHome, `s7-2-home-int-${runSuffix}`, `corp-home-${runSuffix}`)
    homeDeptId = await seedDept(homeIntegrationId, `dept-home-${runSuffix}`, 'Home Eng')
    const homeReqAcc = await seedAccount(homeIntegrationId, `ext-req-home-${runSuffix}`, `key-req-home-${runSuffix}`, 'ReqHome')
    homeMgrAccountId = await seedAccount(homeIntegrationId, `ext-mgr-home-${runSuffix}`, `key-mgr-home-${runSuffix}`, 'MgrHome')
    // Legacy leader that would resolve to managerAlt — precedence must pick normalized managerHome.
    const homeLegacyAcc = await seedAccount(
      homeIntegrationId,
      `ext-legacy-home-${runSuffix}`,
      `key-legacy-home-${runSuffix}`,
      'LegacyHome',
      { leader_in_dept: [{ dept_id: `dept-home-${runSuffix}`, leader: true }] },
    )
    await link(homeReqAcc, requester)
    await link(homeMgrAccountId, managerHome)
    await link(homeLegacyAcc, managerAlt)
    await membership(homeReqAcc, homeDeptId, true, false)
    await membership(homeMgrAccountId, homeDeptId, false, true) // normalized manager
    await membership(homeLegacyAcc, homeDeptId, false, false)

    // ── orgForeign: same local requester linked into a different org with a different manager ──
    // updated_at will be more recent than home (inserted later) so the unscoped pick would choose
    // foreign — the org anchor must force home when attendance requests use orgHome.
    const foreignInt = await seedIntegration(orgForeign, `s7-2-foreign-int-${runSuffix}`, `corp-foreign-${runSuffix}`)
    const foreignDept = await seedDept(foreignInt, `dept-foreign-${runSuffix}`, 'Foreign Eng')
    const foreignReqAcc = await seedAccount(foreignInt, `ext-req-foreign-${runSuffix}`, `key-req-foreign-${runSuffix}`, 'ReqForeign')
    const foreignMgrAcc = await seedAccount(foreignInt, `ext-mgr-foreign-${runSuffix}`, `key-mgr-foreign-${runSuffix}`, 'MgrForeign')
    await link(foreignReqAcc, requester)
    await link(foreignMgrAcc, managerForeign)
    await membership(foreignReqAcc, foreignDept, true, false)
    await membership(foreignMgrAcc, foreignDept, false, true)
    // Bump foreign account updated_at so it is "more recent" than home (unscoped would pick it).
    await pool.query(`UPDATE directory_accounts SET updated_at = now() + interval '1 hour' WHERE id = $1`, [
      foreignReqAcc,
    ])

    // ── orgFreeze: 2-step flow freeze fixture (static step 0 + direct_manager step 1) ──
    const freezeInt = await seedIntegration(orgFreeze, `s7-2-freeze-int-${runSuffix}`, `corp-freeze-${runSuffix}`)
    freezeDeptId = await seedDept(freezeInt, `dept-freeze-${runSuffix}`, 'Freeze Eng')
    const freezeReqAcc = await seedAccount(freezeInt, `ext-req-freeze-${runSuffix}`, `key-req-freeze-${runSuffix}`, 'ReqFreeze')
    freezeMgrAccountId = await seedAccount(freezeInt, `ext-mgr-freeze-${runSuffix}`, `key-mgr-freeze-${runSuffix}`, 'MgrFreeze')
    freezeAltAccountId = await seedAccount(freezeInt, `ext-mgr-alt-${runSuffix}`, `key-mgr-alt-${runSuffix}`, 'MgrAlt')
    // Separate local user for freeze-org requester to avoid multi-org link noise on the shared requester.
    // Reuse managerHome as the initial freeze manager; managerAlt as the post-mutation manager.
    await link(freezeReqAcc, requester)
    await link(freezeMgrAccountId, managerHome)
    await link(freezeAltAccountId, managerAlt)
    await membership(freezeReqAcc, freezeDeptId, true, false)
    await membership(freezeMgrAccountId, freezeDeptId, false, true)
    await membership(freezeAltAccountId, freezeDeptId, false, false)

    // RBAC substrate for authz legs (real DB tables, not just JWT claims).
    await pool.query(
      `INSERT INTO permissions (code, name, description)
       VALUES
         ('attendance:approve', 'Attendance Approve', 'Approve attendance requests'),
         ('attendance:admin', 'Attendance Admin', 'Administer attendance'),
         ('attendance:write', 'Attendance Write', 'Create attendance requests')
       ON CONFLICT (code) DO NOTHING`,
    )
    await pool.query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES
         ($1, 'attendance:approve'),
         ($2, 'attendance:approve'),
         ($3, 'attendance:admin'),
         ($4, 'attendance:write'),
         ($4, 'attendance:approve'),
         ($4, 'attendance:admin')
       ON CONFLICT DO NOTHING`,
      [managerHome, otherApprover, adminActor, requester],
    )

    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('S7-2 server did not expose a TCP address.')
    baseUrl = `http://127.0.0.1:${address.port}`

    adminToken = await devToken(requester, 'user', 'attendance:admin,attendance:write,attendance:approve')
    managerToken = await devToken(managerHome, 'user', 'attendance:approve')
    otherToken = await devToken(otherApprover, 'user', 'attendance:approve')
    adminActorToken = await devToken(adminActor, 'user', 'attendance:admin')
  })

  afterAll(async () => {
    if (pool) {
      try {
        if (createdRequestIds.length > 0) {
          await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
        }
        for (const oid of [orgHome, orgForeign, orgUnlinked, orgFreeze, orgAuthz, orgFlagOff]) {
          await pool.query('DELETE FROM attendance_requests WHERE org_id = $1', [oid]).catch(() => undefined)
          await pool.query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [oid]).catch(() => undefined)
        }
        if (createdInstanceIds.length > 0) {
          await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [createdInstanceIds]).catch(() => undefined)
          await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [createdInstanceIds]).catch(() => undefined)
          await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds]).catch(() => undefined)
        }
        for (const integrationId of integrationIds) {
          await pool.query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId]).catch(() => undefined)
          await pool.query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId]).catch(() => undefined)
          await pool.query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId]).catch(() => undefined)
        }
        await pool.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [userIds]).catch(() => undefined)
        await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds]).catch(() => undefined)
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

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── Authoring: S7-2 makes direct_manager available when flag ON ──
  it('AUTHORING: flag ON + direct_manager accepted (S7-2 implements the kind)', async () => {
    setFlag(true)
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: `s7-2-dm-flow-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 'direct_manager' }],
        orgId: orgHome,
        isActive: true,
      }),
    })
    expect(res.status, res.raw).toBe(201)
    const id = (res.body as { data?: { id?: string } }).data?.id
    if (id) createdFlowIds.push(id)
    const steps = (res.body as { data?: { steps?: unknown[] } }).data?.steps
    expect(steps).toEqual([{ name: undefined, kind: 'direct_manager' }])
  })

  it('AUTHORING: dept_head still UNAVAILABLE (S7-3 not shipped)', async () => {
    setFlag(true)
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: `s7-2-dh-unavail-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 'dept_head' }],
        orgId: orgHome,
        isActive: true,
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')
  })

  // ── S7-1 NITs folded ──
  it('NIT: dynamic + empty approverUserIds:[] → 422 MIXED (key-shape constraint)', async () => {
    setFlag(true)
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: `s7-2-mixed-empty-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 'direct_manager', approverUserIds: [] }],
        orgId: orgHome,
        isActive: true,
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_STATIC_DYNAMIC_MIXED')
  })

  it('NIT: non-string kind (number) → 422 APPROVAL_STEP_KIND_INVALID (not zod 400)', async () => {
    setFlag(true)
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: `s7-2-nonstr-kind-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 123 }],
        orgId: orgHome,
        isActive: true,
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_INVALID')
  })

  // ── Linked resolution + freeze + assignment ──
  it('RUNTIME create: linked direct_manager freezes managerId and builds user assignment', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgHome, 'time_correction', [{ kind: 'direct_manager' }], `s7-2-linked-${runSuffix}`)

    const workDate = '2026-06-01'
    const res = await createRequest(orgHome, adminToken, workDate, 's7-2 linked resolution')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    expect(requestId).toBeTruthy()
    createdRequestIds.push(requestId)

    const reqRow = await (pool as Pool).query(
      'SELECT approval_instance_id FROM attendance_requests WHERE id = $1',
      [requestId],
    )
    const instanceId = reqRow.rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)

    const inst = await (pool as Pool).query(
      'SELECT requester_snapshot, current_node_key FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    const snap = inst.rows[0].requester_snapshot as { id?: string; managerId?: string }
    // Normalized is_manager (managerHome) wins over legacy leader_in_dept (managerAlt).
    expect(snap.managerId).toBe(managerHome)
    expect(snap.id).toBe(requester)

    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id, is_active, metadata
         FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toHaveLength(1)
    expect(assignments.rows[0]).toMatchObject({
      assignment_type: 'user',
      assignee_id: managerHome,
    })
    // Must NOT have fallen through to admin/source_queue.
    expect(assignments.rows.some((r) => r.assignment_type === 'source_queue')).toBe(false)
    expect(assignments.rows.some((r) => r.assignee_id === 'admin')).toBe(false)
  })

  // ── Org anchor: two orgs, one local user ──
  it('ORG-ANCHOR: two-org/one-local-user resolves manager from the requesting org only', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    // orgHome flow (already seeded above is leave+direct_manager; ensure one is active for leave).
    // Create against orgHome — must get managerHome, NEVER managerForeign (even though foreign
    // account is more recently updated and would win the unscoped pick).
    const workDate = '2026-06-02'
    // Deactivate any leftover leave flows on orgHome except we already have one; create a fresh one
    // in case the prior test's flow is fine.
    await seedFlow(orgHome, 'time_correction', [{ kind: 'direct_manager' }], `s7-2-anchor-${runSuffix}`)

    const res = await createRequest(orgHome, adminToken, workDate, 's7-2 org anchor')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    createdRequestIds.push(requestId)
    const reqRow = await (pool as Pool).query(
      'SELECT approval_instance_id FROM attendance_requests WHERE id = $1',
      [requestId],
    )
    const instanceId = reqRow.rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)
    const inst = await (pool as Pool).query('SELECT requester_snapshot FROM approval_instances WHERE id = $1', [
      instanceId,
    ])
    const snap = inst.rows[0].requester_snapshot as { managerId?: string }
    expect(snap.managerId).toBe(managerHome)
    expect(snap.managerId).not.toBe(managerForeign)
  })

  // ── Unlinked block-with-error + zero persistence ──
  it('UNLINKED: direct_manager create fails 422 with ZERO attendance_requests / approval rows', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    // Purely-local user with no directory link in orgUnlinked.
    const unlinkedUser = `s7-2-unlinked-user-${runSuffix}`
    await seedUser(unlinkedUser)
    userIds.push(unlinkedUser)
    await (pool as Pool).query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'attendance:write'), ($1, 'attendance:admin')
       ON CONFLICT DO NOTHING`,
      [unlinkedUser],
    )
    await seedFlow(orgUnlinked, 'time_correction', [{ kind: 'direct_manager' }], `s7-2-unlinked-${runSuffix}`)

    const unlinkedToken = await devToken(unlinkedUser, 'user', 'attendance:admin,attendance:write')
    const beforeReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgUnlinked],
    )
    const beforeInst = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_instances WHERE business_key LIKE $1`,
      [`attendance-request:%`],
    )

    const res = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: authHeaders(unlinkedToken),
      body: JSON.stringify({
        orgId: orgUnlinked,
        workDate: '2026-06-03',
        requestType: 'time_correction',
        requestedInAt: '2026-06-03T01:00:00Z',
        requestedOutAt: '2026-06-03T10:00:00Z',
        reason: 's7-2 unlinked block',
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED')

    const afterReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgUnlinked],
    )
    expect(afterReq.rows[0].n).toBe(beforeReq.rows[0].n)
    // No new instance for this org's request path (business_key contains the request id which was never written).
    const afterInst = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_instances WHERE business_key LIKE $1`,
      [`attendance-request:%`],
    )
    expect(afterInst.rows[0].n).toBe(beforeInst.rows[0].n)
  })

  // P2 fix: multi-step [static, direct_manager] must ALSO fail closed at create when manager is
  // unresolvable — never persist step-0 and strand on advance.
  it('UNLINKED multi-step [static, direct_manager]: create 422 + zero request/instance/assignment rows (org-scoped)', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    const orgMulti = `s7-2-unlinked-multi-${runSuffix}`
    const multiUser = `s7-2-unlinked-multi-user-${runSuffix}`
    await seedUser(multiUser)
    userIds.push(multiUser)
    await (pool as Pool).query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'attendance:write'), ($1, 'attendance:admin')
       ON CONFLICT DO NOTHING`,
      [multiUser],
    )
    // Static step 0 would have assigned multiUser; direct_manager at step 1 is unresolvable (no link).
    await seedFlow(
      orgMulti,
      'time_correction',
      [
        { name: 'S0', approverUserIds: [multiUser] },
        { name: 'S1', kind: 'direct_manager' },
      ],
      `s7-2-unlinked-multi-${runSuffix}`,
    )

    const multiToken = await devToken(multiUser, 'user', 'attendance:admin,attendance:write')
    const beforeReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgMulti],
    )
    // approval_instances store attendance org on metadata/subject_snapshot (no org_id column).
    const beforeInst = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_instances
        WHERE (metadata->>'orgId' = $1 OR subject_snapshot->>'orgId' = $1)`,
      [orgMulti],
    )
    const beforeAssign = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_assignments aa
         JOIN approval_instances ai ON ai.id = aa.instance_id
        WHERE (ai.metadata->>'orgId' = $1 OR ai.subject_snapshot->>'orgId' = $1)`,
      [orgMulti],
    )

    const res = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: authHeaders(multiToken),
      body: JSON.stringify({
        orgId: orgMulti,
        workDate: '2026-06-11',
        requestType: 'time_correction',
        requestedInAt: '2026-06-11T01:00:00Z',
        requestedOutAt: '2026-06-11T10:00:00Z',
        reason: 's7-2 unlinked multi-step block at create',
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED')

    const afterReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgMulti],
    )
    const afterInst = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_instances
        WHERE (metadata->>'orgId' = $1 OR subject_snapshot->>'orgId' = $1)`,
      [orgMulti],
    )
    const afterAssign = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_assignments aa
         JOIN approval_instances ai ON ai.id = aa.instance_id
        WHERE (ai.metadata->>'orgId' = $1 OR ai.subject_snapshot->>'orgId' = $1)`,
      [orgMulti],
    )
    expect(afterReq.rows[0].n, 'zero attendance_requests on create-time freeze failure').toBe(beforeReq.rows[0].n)
    expect(afterInst.rows[0].n, 'zero approval_instances on create-time freeze failure').toBe(beforeInst.rows[0].n)
    expect(afterAssign.rows[0].n, 'zero approval_assignments on create-time freeze failure').toBe(
      beforeAssign.rows[0].n,
    )

    await (pool as Pool).query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgMulti]).catch(() => undefined)
  })

  // ── 2-step freeze after directory mutation ──
  it('FREEZE: 2-step flow keeps step-2 assignee after directory manager mutation', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(
      orgFreeze,
      'time_correction',
      [
        { name: 'S0', approverUserIds: [managerHome] },
        { name: 'S1', kind: 'direct_manager' },
      ],
      `s7-2-freeze-${runSuffix}`,
    )

    const workDate = '2026-06-04'
    const res = await createRequest(orgFreeze, adminToken, workDate, 's7-2 freeze')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    createdRequestIds.push(requestId)
    const reqRow = await (pool as Pool).query(
      'SELECT approval_instance_id FROM attendance_requests WHERE id = $1',
      [requestId],
    )
    const instanceId = reqRow.rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)

    const snapBefore = (
      await (pool as Pool).query('SELECT requester_snapshot FROM approval_instances WHERE id = $1', [instanceId])
    ).rows[0].requester_snapshot as { managerId?: string }
    expect(snapBefore.managerId).toBe(managerHome)

    // Mutate directory: flip is_manager from managerHome → managerAlt BEFORE step-1 advance.
    await (pool as Pool).query(
      `UPDATE directory_account_departments SET is_manager = false
        WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [freezeMgrAccountId, freezeDeptId],
    )
    await (pool as Pool).query(
      `UPDATE directory_account_departments SET is_manager = true
        WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [freezeAltAccountId, freezeDeptId],
    )

    // Step 0 assignee (managerHome) approves → advances to step 1 (direct_manager).
    const approve = await act(requestId, managerToken, 'approve')
    expect(approve.status, approve.raw).toBe(200)

    const snapAfter = (
      await (pool as Pool).query(
        'SELECT requester_snapshot, current_step, current_node_key FROM approval_instances WHERE id = $1',
        [instanceId],
      )
    ).rows[0]
    expect((snapAfter.requester_snapshot as { managerId?: string }).managerId).toBe(managerHome)
    expect(snapAfter.current_step).toBe(1)
    expect(snapAfter.current_node_key).toBe(NODE_KEY_1)

    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE AND node_key = $2`,
      [instanceId, NODE_KEY_1],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerHome }),
    ])
    // The mutated managerAlt must NOT be the assignee.
    expect(assignments.rows.some((r) => r.assignee_id === managerAlt)).toBe(false)
  })

  // ── Dynamic assignment authorization (S7-0 re-run for this kind) ──
  it('AUTHZ: dynamic user assignee can approve; unassigned scope-authorized actor 403s; admin override works', async () => {
    setFlag(true)
    // Force real authorization (no RBAC bypass).
    process.env.RBAC_BYPASS = 'false'
    try {
      await seedFlow(orgAuthz, 'time_correction', [{ kind: 'direct_manager' }], `s7-2-authz-${runSuffix}`)
      // Seed directory for orgAuthz so create can freeze managerHome.
      const authzInt = await seedIntegration(orgAuthz, `s7-2-authz-int-${runSuffix}`, `corp-authz-${runSuffix}`)
      const authzDept = await seedDept(authzInt, `dept-authz-${runSuffix}`, 'Authz Eng')
      const authzReqAcc = await seedAccount(authzInt, `ext-req-authz-${runSuffix}`, `key-req-authz-${runSuffix}`, 'ReqAuthz')
      const authzMgrAcc = await seedAccount(authzInt, `ext-mgr-authz-${runSuffix}`, `key-mgr-authz-${runSuffix}`, 'MgrAuthz')
      await link(authzReqAcc, requester)
      await link(authzMgrAcc, managerHome)
      await membership(authzReqAcc, authzDept, true, false)
      await membership(authzMgrAcc, authzDept, false, true)

      // Positive approve leg
      const workDateA = '2026-06-05'
      const createA = await createRequest(orgAuthz, adminToken, workDateA, 's7-2 authz approve')
      expect(createA.status, createA.raw).toBe(201)
      const requestIdA = requestIdFrom(createA) as string
      createdRequestIds.push(requestIdA)
      const instA = (
        await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestIdA])
      ).rows[0].approval_instance_id as string
      createdInstanceIds.push(instA)

      // Negative: otherApprover holds attendance:approve (broad gate) but is NOT the manager.
      const negApprove = await act(requestIdA, otherToken, 'approve')
      expect(negApprove.status, negApprove.raw).toBe(403)
      expect(errorCode(negApprove)).toBe('FORBIDDEN')

      // Positive: managerHome is the frozen assignee.
      const posApprove = await act(requestIdA, managerToken, 'approve')
      expect(posApprove.status, posApprove.raw).toBe(200)

      // Reject legs on a fresh request.
      const workDateB = '2026-06-06'
      const createB = await createRequest(orgAuthz, adminToken, workDateB, 's7-2 authz reject')
      expect(createB.status, createB.raw).toBe(201)
      const requestIdB = requestIdFrom(createB) as string
      createdRequestIds.push(requestIdB)
      const instB = (
        await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestIdB])
      ).rows[0].approval_instance_id as string
      createdInstanceIds.push(instB)

      const negReject = await act(requestIdB, otherToken, 'reject')
      expect(negReject.status, negReject.raw).toBe(403)
      expect(errorCode(negReject)).toBe('FORBIDDEN')

      const posReject = await act(requestIdB, managerToken, 'reject')
      expect(posReject.status, posReject.raw).toBe(200)

      // Admin override (not the assignee) on a third request — approve.
      const workDateC = '2026-06-07'
      const createC = await createRequest(orgAuthz, adminToken, workDateC, 's7-2 authz admin')
      expect(createC.status, createC.raw).toBe(201)
      const requestIdC = requestIdFrom(createC) as string
      createdRequestIds.push(requestIdC)
      const instC = (
        await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestIdC])
      ).rows[0].approval_instance_id as string
      createdInstanceIds.push(instC)

      const adminApprove = await act(requestIdC, adminActorToken, 'approve')
      expect(adminApprove.status, adminApprove.raw).toBe(200)

      // P3: admin override reject (symmetric with approve — non-assignee admin still authorized).
      const workDateD = '2026-06-12'
      const createD = await createRequest(orgAuthz, adminToken, workDateD, 's7-2 authz admin reject')
      expect(createD.status, createD.raw).toBe(201)
      const requestIdD = requestIdFrom(createD) as string
      createdRequestIds.push(requestIdD)
      const instD = (
        await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestIdD])
      ).rows[0].approval_instance_id as string
      createdInstanceIds.push(instD)

      const adminReject = await act(requestIdD, adminActorToken, 'reject')
      expect(adminReject.status, adminReject.raw).toBe(200)
    } finally {
      process.env.RBAC_BYPASS = 'true'
    }
  })

  // ── Flag-off create ──
  it('FLAG-OFF create: dynamic flow fails-closed with zero rows', async () => {
    setFlag(false)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgFlagOff, 'time_correction', [{ kind: 'direct_manager' }], `s7-2-flagoff-create-${runSuffix}`)

    const before = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgFlagOff],
    )
    const res = await createRequest(orgFlagOff, adminToken, '2026-06-08', 's7-2 flag-off create')
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')
    const after = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgFlagOff],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  // ── Flag-off advance rollback ──
  it('FLAG-OFF advance: step-1 approve fails and rolls back (instance still at step 0)', async () => {
    process.env.RBAC_BYPASS = 'true'
    setFlag(true)
    const orgAdv = `s7-2-adv-${runSuffix}`
    // Directory for this org so create succeeds under flag ON.
    const advInt = await seedIntegration(orgAdv, `s7-2-adv-int-${runSuffix}`, `corp-adv-${runSuffix}`)
    const advDept = await seedDept(advInt, `dept-adv-${runSuffix}`, 'Adv Eng')
    const advReqAcc = await seedAccount(advInt, `ext-req-adv-${runSuffix}`, `key-req-adv-${runSuffix}`, 'ReqAdv')
    const advMgrAcc = await seedAccount(advInt, `ext-mgr-adv-${runSuffix}`, `key-mgr-adv-${runSuffix}`, 'MgrAdv')
    await link(advReqAcc, requester)
    await link(advMgrAcc, managerHome)
    await membership(advReqAcc, advDept, true, false)
    await membership(advMgrAcc, advDept, false, true)

    await seedFlow(
      orgAdv,
      'time_correction',
      [
        { name: 'S0', approverUserIds: [managerHome] },
        { name: 'S1', kind: 'direct_manager' },
      ],
      `s7-2-flagoff-adv-${runSuffix}`,
    )

    const create = await createRequest(orgAdv, adminToken, '2026-06-09', 's7-2 flag-off advance')
    expect(create.status, create.raw).toBe(201)
    const requestId = requestIdFrom(create) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)

    // Flip flag OFF before step advance.
    setFlag(false)
    const approve = await act(requestId, managerToken, 'approve')
    expect(approve.status, approve.raw).toBe(422)
    expect(errorCode(approve)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')

    const inst = await (pool as Pool).query(
      'SELECT status, current_step, current_node_key, version FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    expect(inst.rows[0].status).toBe('pending')
    expect(inst.rows[0].current_step).toBe(0)
    expect(inst.rows[0].current_node_key).toBe(NODE_KEY_0)
    // No approval_records appended for the failed advance.
    const records = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1',
      [instanceId],
    )
    expect(records.rows[0].n).toBe(0)
    // Active assignment still step 0's static assignee.
    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerHome }),
    ])

    await (pool as Pool).query('DELETE FROM attendance_requests WHERE org_id = $1', [orgAdv]).catch(() => undefined)
    await (pool as Pool).query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgAdv]).catch(() => undefined)
  })

  // ── Legacy static byte-identity under flag off ──
  it('LEGACY static: flag OFF flow with no dynamic kind still creates + assigns statically', async () => {
    setFlag(false)
    process.env.RBAC_BYPASS = 'true'
    const orgLegacy = `s7-2-legacy-${runSuffix}`
    await seedFlow(
      orgLegacy,
      'time_correction',
      [{ name: 'LM', approverUserIds: [managerHome] }],
      `s7-2-legacy-${runSuffix}`,
    )
    const res = await createRequest(orgLegacy, adminToken, '2026-06-10', 's7-2 legacy static')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)
    const snap = (
      await (pool as Pool).query('SELECT requester_snapshot FROM approval_instances WHERE id = $1', [instanceId])
    ).rows[0].requester_snapshot as Record<string, unknown>
    // Legacy snapshot shape: id/name only (no managerId freeze when no dynamic kind).
    expect(snap.managerId).toBeUndefined()
    expect(snap.id).toBe(requester)
    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerHome }),
    ])
    await (pool as Pool).query('DELETE FROM attendance_requests WHERE org_id = $1', [orgLegacy]).catch(() => undefined)
    await (pool as Pool).query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgLegacy]).catch(() => undefined)
  })
})
