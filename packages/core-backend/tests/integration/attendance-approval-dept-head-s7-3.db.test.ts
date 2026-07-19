import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'

// S7-3 (RATIFIED attendance-approval-s7 resolver design-lock §2.2 / §3.3 / §3.4 / §4 / §4.1 / §7 S7-3):
// real-DB, HTTP-level coverage of dept_head end-to-end:
//   linked resolution + freeze into requester_snapshot.deptHeadId
//   vacant/unlinked head fail-closed + zero persistence
//   self-exclusion
//   two-org / one-local-user org-anchor
//   2-step freeze after directory relation mutation
//   dynamic assignment approve+reject authorization (negative / positive / admin)
//   flag-off create + flag-off advance rollback (§4.1 both paths)
//   legacy static still works with flag off
//   direct_manager regression control
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

describeIfDatabase('S7-3 dept_head — freeze + assignment + auth (real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined
  let pool: Pool | undefined
  let prevRbac: string | undefined
  let prevFlag: string | undefined

  const runSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const orgHome = `s7-3-home-${runSuffix}`
  const orgForeign = `s7-3-foreign-${runSuffix}`
  const orgVacant = `s7-3-vacant-${runSuffix}`
  const orgSelf = `s7-3-self-${runSuffix}`
  const orgFreeze = `s7-3-freeze-${runSuffix}`
  const orgAuthz = `s7-3-authz-${runSuffix}`
  const orgFlagOff = `s7-3-flagoff-${runSuffix}`
  const orgDm = `s7-3-dm-${runSuffix}`

  const requester = `s7-3-req-${runSuffix}`
  const headHome = `s7-3-head-home-${runSuffix}`
  const headForeign = `s7-3-head-foreign-${runSuffix}`
  const headAlt = `s7-3-head-alt-${runSuffix}`
  const managerHome = `s7-3-mgr-home-${runSuffix}`
  const otherApprover = `s7-3-other-${runSuffix}`
  const adminActor = `s7-3-admin-${runSuffix}`

  const userIds: string[] = [
    requester,
    headHome,
    headForeign,
    headAlt,
    managerHome,
    otherApprover,
    adminActor,
  ]
  const integrationIds: string[] = []
  const createdFlowIds: string[] = []
  const createdInstanceIds: string[] = []
  const createdRequestIds: string[] = []

  let adminToken = ''
  let headToken = ''
  let managerToken = ''
  let otherToken = ''
  let adminActorToken = ''

  // Directory fixture handles for freeze-mutation + org-anchor cases.
  let homeHeadExternal = ''
  let freezeDeptId = ''
  let freezeHeadExternal = ''
  let freezeAltExternal = ''

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
      [userId, `${userId}@s7-3.test`],
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

  async function seedDept(
    integrationId: string,
    externalId: string,
    name: string,
    raw: Record<string, unknown> = {},
  ): Promise<string> {
    return (
      await (pool as Pool).query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
         VALUES ($1, 'dingtalk', $2, $3, true, $4::jsonb) RETURNING id`,
        [integrationId, externalId, name, JSON.stringify(raw)],
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
      body: JSON.stringify({ comment: `s7-3 ${action}` }),
    })
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) throw new Error('S7-3 tests require an available loopback port.')
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required for the S7-3 suite.')

    process.env.DATABASE_URL = dbUrl
    prevRbac = process.env.RBAC_BYPASS
    prevFlag = process.env[DYNAMIC_FLAG]
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    process.env[DYNAMIC_FLAG] = 'true'

    pool = new Pool({ connectionString: dbUrl })
    await pool.query('SELECT 1')

    for (const uid of userIds) await seedUser(uid)

    // ── orgHome: linked requester + dept head via dept_manager_userid_list (first-linked wins) ──
    const homeInt = await seedIntegration(orgHome, `s7-3-home-int-${runSuffix}`, `corp-home-${runSuffix}`)
    homeHeadExternal = `ext-head-home-${runSuffix}`
    const homeDeptExternal = `dept-home-${runSuffix}`
    const homeDeptId = await seedDept(homeInt, homeDeptExternal, 'Home Eng', {
      dept_manager_userid_list: [homeHeadExternal],
    })
    const homeReqAcc = await seedAccount(homeInt, `ext-req-home-${runSuffix}`, `key-req-home-${runSuffix}`, 'ReqHome')
    const homeHeadAcc = await seedAccount(homeInt, homeHeadExternal, `key-head-home-${runSuffix}`, 'HeadHome')
    // Also seed a direct manager distinct from dept head so mixed-flow controls stay independent.
    const homeMgrAcc = await seedAccount(homeInt, `ext-mgr-home-${runSuffix}`, `key-mgr-home-${runSuffix}`, 'MgrHome')
    await link(homeReqAcc, requester)
    await link(homeHeadAcc, headHome)
    await link(homeMgrAcc, managerHome)
    await membership(homeReqAcc, homeDeptId, true, false)
    await membership(homeHeadAcc, homeDeptId, false, false)
    await membership(homeMgrAcc, homeDeptId, false, true)

    // ── orgForeign: same local requester linked into a different org with a different dept head ──
    // updated_at will be more recent than home so the unscoped pick would choose foreign —
    // the org anchor must force home when attendance requests use orgHome.
    const foreignInt = await seedIntegration(orgForeign, `s7-3-foreign-int-${runSuffix}`, `corp-foreign-${runSuffix}`)
    const foreignHeadExternal = `ext-head-foreign-${runSuffix}`
    const foreignDept = await seedDept(foreignInt, `dept-foreign-${runSuffix}`, 'Foreign Eng', {
      dept_manager_userid_list: [foreignHeadExternal],
    })
    const foreignReqAcc = await seedAccount(
      foreignInt,
      `ext-req-foreign-${runSuffix}`,
      `key-req-foreign-${runSuffix}`,
      'ReqForeign',
    )
    const foreignHeadAcc = await seedAccount(
      foreignInt,
      foreignHeadExternal,
      `key-head-foreign-${runSuffix}`,
      'HeadForeign',
    )
    await link(foreignReqAcc, requester)
    await link(foreignHeadAcc, headForeign)
    await membership(foreignReqAcc, foreignDept, true, false)
    await membership(foreignHeadAcc, foreignDept, false, false)
    await pool.query(`UPDATE directory_accounts SET updated_at = now() + interval '1 hour' WHERE id = $1`, [
      foreignReqAcc,
    ])

    // ── orgFreeze: 2-step flow freeze fixture (static step 0 + dept_head step 1) ──
    const freezeInt = await seedIntegration(orgFreeze, `s7-3-freeze-int-${runSuffix}`, `corp-freeze-${runSuffix}`)
    freezeHeadExternal = `ext-head-freeze-${runSuffix}`
    freezeAltExternal = `ext-head-alt-${runSuffix}`
    freezeDeptId = await seedDept(freezeInt, `dept-freeze-${runSuffix}`, 'Freeze Eng', {
      dept_manager_userid_list: [freezeHeadExternal],
    })
    const freezeReqAcc = await seedAccount(
      freezeInt,
      `ext-req-freeze-${runSuffix}`,
      `key-req-freeze-${runSuffix}`,
      'ReqFreeze',
    )
    const freezeHeadAcc = await seedAccount(
      freezeInt,
      freezeHeadExternal,
      `key-head-freeze-${runSuffix}`,
      'HeadFreeze',
    )
    const freezeAltAcc = await seedAccount(
      freezeInt,
      freezeAltExternal,
      `key-head-alt-${runSuffix}`,
      'HeadAlt',
    )
    await link(freezeReqAcc, requester)
    await link(freezeHeadAcc, headHome)
    await link(freezeAltAcc, headAlt)
    await membership(freezeReqAcc, freezeDeptId, true, false)
    await membership(freezeHeadAcc, freezeDeptId, false, false)
    await membership(freezeAltAcc, freezeDeptId, false, false)

    // ── orgSelf: requester is the only linked dept head → self-exclusion at freeze ──
    const selfInt = await seedIntegration(orgSelf, `s7-3-self-int-${runSuffix}`, `corp-self-${runSuffix}`)
    const selfReqExternal = `ext-req-self-${runSuffix}`
    const selfDept = await seedDept(selfInt, `dept-self-${runSuffix}`, 'Self Eng', {
      dept_manager_userid_list: [selfReqExternal],
    })
    const selfReqAcc = await seedAccount(selfInt, selfReqExternal, `key-req-self-${runSuffix}`, 'ReqSelf')
    await link(selfReqAcc, requester)
    await membership(selfReqAcc, selfDept, true, false)

    // ── orgVacant: department with empty / unlinked head list ──
    const vacantInt = await seedIntegration(orgVacant, `s7-3-vacant-int-${runSuffix}`, `corp-vacant-${runSuffix}`)
    const vacantDept = await seedDept(vacantInt, `dept-vacant-${runSuffix}`, 'Vacant Eng', {
      dept_manager_userid_list: [`ext-unlinked-head-${runSuffix}`],
    })
    const vacantReqAcc = await seedAccount(
      vacantInt,
      `ext-req-vacant-${runSuffix}`,
      `key-req-vacant-${runSuffix}`,
      'ReqVacant',
    )
    // Unlinked head account (no directory_account_links row) → vacant for resolution purposes.
    await seedAccount(
      vacantInt,
      `ext-unlinked-head-${runSuffix}`,
      `key-unlinked-head-${runSuffix}`,
      'UnlinkedHead',
    )
    await link(vacantReqAcc, requester)
    await membership(vacantReqAcc, vacantDept, true, false)

    // ── orgDm: direct_manager regression control (normalized is_manager) ──
    const dmInt = await seedIntegration(orgDm, `s7-3-dm-int-${runSuffix}`, `corp-dm-${runSuffix}`)
    const dmDept = await seedDept(dmInt, `dept-dm-${runSuffix}`, 'Dm Eng', {})
    const dmReqAcc = await seedAccount(dmInt, `ext-req-dm-${runSuffix}`, `key-req-dm-${runSuffix}`, 'ReqDm')
    const dmMgrAcc = await seedAccount(dmInt, `ext-mgr-dm-${runSuffix}`, `key-mgr-dm-${runSuffix}`, 'MgrDm')
    await link(dmReqAcc, requester)
    await link(dmMgrAcc, managerHome)
    await membership(dmReqAcc, dmDept, true, false)
    await membership(dmMgrAcc, dmDept, false, true)

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
         ($3, 'attendance:approve'),
         ($4, 'attendance:admin'),
         ($5, 'attendance:write'),
         ($5, 'attendance:approve'),
         ($5, 'attendance:admin')
       ON CONFLICT DO NOTHING`,
      [headHome, managerHome, otherApprover, adminActor, requester],
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
    if (!address || typeof address === 'string') throw new Error('S7-3 server did not expose a TCP address.')
    baseUrl = `http://127.0.0.1:${address.port}`

    adminToken = await devToken(requester, 'user', 'attendance:admin,attendance:write,attendance:approve')
    headToken = await devToken(headHome, 'user', 'attendance:approve')
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
        for (const oid of [orgHome, orgForeign, orgVacant, orgSelf, orgFreeze, orgAuthz, orgFlagOff, orgDm]) {
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

  // ── Authoring: S7-3 makes dept_head available when flag ON ──
  it('AUTHORING: flag ON + dept_head accepted (S7-3 implements the kind)', async () => {
    setFlag(true)
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: `s7-3-dh-flow-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 'dept_head' }],
        orgId: orgHome,
        isActive: true,
      }),
    })
    expect(res.status, res.raw).toBe(201)
    const id = (res.body as { data?: { id?: string } }).data?.id
    if (id) createdFlowIds.push(id)
    const steps = (res.body as { data?: { steps?: unknown[] } }).data?.steps
    expect(steps).toEqual([{ name: undefined, kind: 'dept_head' }])
  })

  it('AUTHORING: continuous_managers stays OUT-of-v1 (KIND_INVALID, not silent accept)', async () => {
    setFlag(true)
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: `s7-3-cm-out-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 'continuous_managers', levels: 2 }],
        orgId: orgHome,
        isActive: true,
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_INVALID')
  })

  // ── Linked resolution + freeze + assignment ──
  it('RUNTIME create: linked dept_head freezes deptHeadId and builds user assignment', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgHome, 'time_correction', [{ kind: 'dept_head' }], `s7-3-linked-${runSuffix}`)

    const workDate = '2026-07-01'
    const res = await createRequest(orgHome, adminToken, workDate, 's7-3 linked resolution')
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
    const snap = inst.rows[0].requester_snapshot as { id?: string; deptHeadId?: string }
    expect(snap.deptHeadId).toBe(headHome)
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
      assignee_id: headHome,
    })
    // Must NOT have fallen through to admin/source_queue.
    expect(assignments.rows.some((r) => r.assignment_type === 'source_queue')).toBe(false)
    expect(assignments.rows.some((r) => r.assignee_id === 'admin')).toBe(false)
  })

  // ── Org anchor: two orgs, one local user ──
  it('ORG-ANCHOR: two-org/one-local-user resolves dept head from the requesting org only', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    const workDate = '2026-07-02'
    await seedFlow(orgHome, 'time_correction', [{ kind: 'dept_head' }], `s7-3-anchor-${runSuffix}`)

    const res = await createRequest(orgHome, adminToken, workDate, 's7-3 org anchor')
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
    const snap = inst.rows[0].requester_snapshot as { deptHeadId?: string }
    expect(snap.deptHeadId).toBe(headHome)
    expect(snap.deptHeadId).not.toBe(headForeign)
  })

  // ── Vacant/unlinked head block-with-error + zero persistence ──
  it('VACANT: unlinked dept head create fails 422 with ZERO attendance_requests / approval rows', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgVacant, 'time_correction', [{ kind: 'dept_head' }], `s7-3-vacant-${runSuffix}`)

    const beforeReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgVacant],
    )
    const beforeInst = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_instances
        WHERE (metadata->>'orgId' = $1 OR subject_snapshot->>'orgId' = $1)`,
      [orgVacant],
    )
    const beforeAssign = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_assignments aa
         JOIN approval_instances ai ON ai.id = aa.instance_id
        WHERE (ai.metadata->>'orgId' = $1 OR ai.subject_snapshot->>'orgId' = $1)`,
      [orgVacant],
    )

    const res = await createRequest(orgVacant, adminToken, '2026-07-03', 's7-3 vacant head block')
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED')

    const afterReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgVacant],
    )
    const afterInst = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_instances
        WHERE (metadata->>'orgId' = $1 OR subject_snapshot->>'orgId' = $1)`,
      [orgVacant],
    )
    const afterAssign = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_assignments aa
         JOIN approval_instances ai ON ai.id = aa.instance_id
        WHERE (ai.metadata->>'orgId' = $1 OR ai.subject_snapshot->>'orgId' = $1)`,
      [orgVacant],
    )
    expect(afterReq.rows[0].n).toBe(beforeReq.rows[0].n)
    expect(afterInst.rows[0].n).toBe(beforeInst.rows[0].n)
    expect(afterAssign.rows[0].n).toBe(beforeAssign.rows[0].n)
  })

  // ── Self-exclusion ──
  it('SELF-EXCLUSION: requester-as-dept-head fails 422 with zero persistence', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgSelf, 'time_correction', [{ kind: 'dept_head' }], `s7-3-self-${runSuffix}`)

    const beforeReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgSelf],
    )
    const res = await createRequest(orgSelf, adminToken, '2026-07-04', 's7-3 self-exclusion')
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED')
    const afterReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgSelf],
    )
    expect(afterReq.rows[0].n).toBe(beforeReq.rows[0].n)
  })

  // ── Multi-step zero-persistence when later step is unresolvable ──
  it('UNLINKED multi-step [static, dept_head]: create 422 + zero request/instance/assignment rows', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    const orgMulti = `s7-3-unlinked-multi-${runSuffix}`
    const multiUser = `s7-3-unlinked-multi-user-${runSuffix}`
    await seedUser(multiUser)
    userIds.push(multiUser)
    await (pool as Pool).query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'attendance:write'), ($1, 'attendance:admin')
       ON CONFLICT DO NOTHING`,
      [multiUser],
    )
    await seedFlow(
      orgMulti,
      'time_correction',
      [
        { name: 'S0', approverUserIds: [multiUser] },
        { name: 'S1', kind: 'dept_head' },
      ],
      `s7-3-unlinked-multi-${runSuffix}`,
    )

    const multiToken = await devToken(multiUser, 'user', 'attendance:admin,attendance:write')
    const beforeReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgMulti],
    )
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
        workDate: '2026-07-05',
        requestType: 'time_correction',
        requestedInAt: '2026-07-05T01:00:00Z',
        requestedOutAt: '2026-07-05T10:00:00Z',
        reason: 's7-3 unlinked multi-step block at create',
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
  it('FREEZE: 2-step flow keeps step-2 assignee after directory dept-head mutation', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(
      orgFreeze,
      'time_correction',
      [
        { name: 'S0', approverUserIds: [headHome] },
        { name: 'S1', kind: 'dept_head' },
      ],
      `s7-3-freeze-${runSuffix}`,
    )

    const workDate = '2026-07-06'
    const res = await createRequest(orgFreeze, adminToken, workDate, 's7-3 freeze')
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
    ).rows[0].requester_snapshot as { deptHeadId?: string }
    expect(snapBefore.deptHeadId).toBe(headHome)

    // Mutate directory: swap dept_manager_userid_list to headAlt BEFORE step-1 advance.
    await (pool as Pool).query(
      `UPDATE directory_departments
          SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{dept_manager_userid_list}', $1::jsonb)
        WHERE id = $2`,
      [JSON.stringify([freezeAltExternal]), freezeDeptId],
    )

    // Step 0 assignee (headHome) approves → advances to step 1 (dept_head).
    const approve = await act(requestId, headToken, 'approve')
    expect(approve.status, approve.raw).toBe(200)

    const snapAfter = (
      await (pool as Pool).query(
        'SELECT requester_snapshot, current_step, current_node_key FROM approval_instances WHERE id = $1',
        [instanceId],
      )
    ).rows[0]
    expect((snapAfter.requester_snapshot as { deptHeadId?: string }).deptHeadId).toBe(headHome)
    expect(snapAfter.current_step).toBe(1)
    expect(snapAfter.current_node_key).toBe(NODE_KEY_1)

    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE AND node_key = $2`,
      [instanceId, NODE_KEY_1],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: headHome }),
    ])
    // The mutated headAlt must NOT be the assignee.
    expect(assignments.rows.some((r) => r.assignee_id === headAlt)).toBe(false)
  })

  // ── Dynamic assignment authorization (S7-0 re-run for this kind) ──
  it('AUTHZ: dynamic user assignee can approve/reject; unassigned scope-authorized actor 403s; admin override works', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'false'
    try {
      await seedFlow(orgAuthz, 'time_correction', [{ kind: 'dept_head' }], `s7-3-authz-${runSuffix}`)
      const authzInt = await seedIntegration(orgAuthz, `s7-3-authz-int-${runSuffix}`, `corp-authz-${runSuffix}`)
      const authzHeadExternal = `ext-head-authz-${runSuffix}`
      const authzDept = await seedDept(authzInt, `dept-authz-${runSuffix}`, 'Authz Eng', {
        dept_manager_userid_list: [authzHeadExternal],
      })
      const authzReqAcc = await seedAccount(
        authzInt,
        `ext-req-authz-${runSuffix}`,
        `key-req-authz-${runSuffix}`,
        'ReqAuthz',
      )
      const authzHeadAcc = await seedAccount(
        authzInt,
        authzHeadExternal,
        `key-head-authz-${runSuffix}`,
        'HeadAuthz',
      )
      await link(authzReqAcc, requester)
      await link(authzHeadAcc, headHome)
      await membership(authzReqAcc, authzDept, true, false)
      await membership(authzHeadAcc, authzDept, false, false)

      // Positive approve leg
      const workDateA = '2026-07-07'
      const createA = await createRequest(orgAuthz, adminToken, workDateA, 's7-3 authz approve')
      expect(createA.status, createA.raw).toBe(201)
      const requestIdA = requestIdFrom(createA) as string
      createdRequestIds.push(requestIdA)
      const instA = (
        await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestIdA])
      ).rows[0].approval_instance_id as string
      createdInstanceIds.push(instA)

      // Negative: otherApprover holds attendance:approve (broad gate) but is NOT the dept head.
      const negApprove = await act(requestIdA, otherToken, 'approve')
      expect(negApprove.status, negApprove.raw).toBe(403)
      expect(errorCode(negApprove)).toBe('FORBIDDEN')

      // Positive: headHome is the frozen assignee.
      const posApprove = await act(requestIdA, headToken, 'approve')
      expect(posApprove.status, posApprove.raw).toBe(200)

      // Reject legs on a fresh request.
      const workDateB = '2026-07-08'
      const createB = await createRequest(orgAuthz, adminToken, workDateB, 's7-3 authz reject')
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

      const posReject = await act(requestIdB, headToken, 'reject')
      expect(posReject.status, posReject.raw).toBe(200)

      // Admin override (not the assignee) on a third request — approve.
      const workDateC = '2026-07-09'
      const createC = await createRequest(orgAuthz, adminToken, workDateC, 's7-3 authz admin')
      expect(createC.status, createC.raw).toBe(201)
      const requestIdC = requestIdFrom(createC) as string
      createdRequestIds.push(requestIdC)
      const instC = (
        await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestIdC])
      ).rows[0].approval_instance_id as string
      createdInstanceIds.push(instC)

      const adminApprove = await act(requestIdC, adminActorToken, 'approve')
      expect(adminApprove.status, adminApprove.raw).toBe(200)

      // Admin override reject (symmetric).
      const workDateD = '2026-07-10'
      const createD = await createRequest(orgAuthz, adminToken, workDateD, 's7-3 authz admin reject')
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
  it('FLAG-OFF create: dynamic dept_head flow fails-closed with zero rows', async () => {
    setFlag(false)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgFlagOff, 'time_correction', [{ kind: 'dept_head' }], `s7-3-flagoff-create-${runSuffix}`)

    const before = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgFlagOff],
    )
    const res = await createRequest(orgFlagOff, adminToken, '2026-07-11', 's7-3 flag-off create')
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')
    const after = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgFlagOff],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  // ── Flag-off advance rollback (design-lock §4.1 path (b) re-verified for dept_head) ──
  it('FLAG-OFF advance: step-0 approve into dept_head fails and rolls back (instance still at step 0)', async () => {
    process.env.RBAC_BYPASS = 'true'
    setFlag(true)
    const orgAdv = `s7-3-adv-${runSuffix}`
    // Directory for this org so create freezes dept_head successfully under flag ON.
    const advInt = await seedIntegration(orgAdv, `s7-3-adv-int-${runSuffix}`, `corp-adv-${runSuffix}`)
    const advHeadExternal = `ext-head-adv-${runSuffix}`
    const advDept = await seedDept(advInt, `dept-adv-${runSuffix}`, 'Adv Eng', {
      dept_manager_userid_list: [advHeadExternal],
    })
    const advReqAcc = await seedAccount(
      advInt,
      `ext-req-adv-${runSuffix}`,
      `key-req-adv-${runSuffix}`,
      'ReqAdv',
    )
    const advHeadAcc = await seedAccount(
      advInt,
      advHeadExternal,
      `key-head-adv-${runSuffix}`,
      'HeadAdv',
    )
    await link(advReqAcc, requester)
    await link(advHeadAcc, headHome)
    await membership(advReqAcc, advDept, true, false)
    await membership(advHeadAcc, advDept, false, false)

    // 2-step: static step 0 (headHome) → dynamic dept_head step 1.
    await seedFlow(
      orgAdv,
      'time_correction',
      [
        { name: 'S0', approverUserIds: [headHome] },
        { name: 'S1', kind: 'dept_head' },
      ],
      `s7-3-flagoff-adv-${runSuffix}`,
    )

    const create = await createRequest(orgAdv, adminToken, '2026-07-15', 's7-3 flag-off advance')
    expect(create.status, create.raw).toBe(201)
    const requestId = requestIdFrom(create) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)

    // Freeze succeeded under flag ON (dept head present in snapshot).
    const snapBefore = (
      await (pool as Pool).query('SELECT requester_snapshot FROM approval_instances WHERE id = $1', [instanceId])
    ).rows[0].requester_snapshot as { deptHeadId?: string }
    expect(snapBefore.deptHeadId).toBe(headHome)

    // Flip flag OFF before step advance — §4.1 path (b): next dynamic step is unavailable.
    setFlag(false)
    try {
      const approve = await act(requestId, headToken, 'approve')
      expect(approve.status, approve.raw).toBe(422)
      expect(errorCode(approve)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')

      // Transaction fully rolls back: instance still pending at step 0.
      const inst = await (pool as Pool).query(
        'SELECT status, current_step, current_node_key, version FROM approval_instances WHERE id = $1',
        [instanceId],
      )
      expect(inst.rows[0].status).toBe('pending')
      expect(inst.rows[0].current_step).toBe(0)
      expect(inst.rows[0].current_node_key).toBe(NODE_KEY_0)

      // Attendance request remains pending (no status advance / finalization).
      const reqRow = await (pool as Pool).query(
        'SELECT status FROM attendance_requests WHERE id = $1',
        [requestId],
      )
      expect(reqRow.rows[0].status).toBe('pending')

      // No approval_records appended for the failed advance.
      const records = await (pool as Pool).query(
        'SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1',
        [instanceId],
      )
      expect(records.rows[0].n).toBe(0)

      // Original step-0 assignment remains the only active assignment; no step-1 rows.
      const active = await (pool as Pool).query(
        `SELECT assignment_type, assignee_id, node_key FROM approval_assignments
          WHERE instance_id = $1 AND is_active = TRUE`,
        [instanceId],
      )
      expect(active.rows).toEqual([
        expect.objectContaining({
          assignment_type: 'user',
          assignee_id: headHome,
          node_key: NODE_KEY_0,
        }),
      ])
      const step1Any = await (pool as Pool).query(
        `SELECT COUNT(*)::int AS n FROM approval_assignments
          WHERE instance_id = $1 AND node_key = $2`,
        [instanceId, NODE_KEY_1],
      )
      expect(step1Any.rows[0].n).toBe(0)
    } finally {
      // Restore flag for subsequent legs (suite afterAll also restores prevFlag).
      setFlag(true)
      await (pool as Pool).query('DELETE FROM attendance_requests WHERE org_id = $1', [orgAdv]).catch(() => undefined)
      await (pool as Pool).query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgAdv]).catch(() => undefined)
    }
  })

  // ── Legacy static byte-identity under flag off ──
  it('LEGACY static: flag OFF flow with no dynamic kind still creates + assigns statically', async () => {
    setFlag(false)
    process.env.RBAC_BYPASS = 'true'
    const orgLegacy = `s7-3-legacy-${runSuffix}`
    await seedFlow(
      orgLegacy,
      'time_correction',
      [{ name: 'LM', approverUserIds: [headHome] }],
      `s7-3-legacy-${runSuffix}`,
    )
    const res = await createRequest(orgLegacy, adminToken, '2026-07-12', 's7-3 legacy static')
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
    // Legacy snapshot shape: id/name only (no deptHeadId freeze when no dynamic kind).
    expect(snap.deptHeadId).toBeUndefined()
    expect(snap.managerId).toBeUndefined()
    expect(snap.id).toBe(requester)
    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: headHome }),
    ])
    await (pool as Pool).query('DELETE FROM attendance_requests WHERE org_id = $1', [orgLegacy]).catch(() => undefined)
    await (pool as Pool).query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgLegacy]).catch(() => undefined)
  })

  // ── direct_manager regression control ──
  it('REGRESSION: direct_manager still freezes managerId and assigns (S7-2 preserved)', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgDm, 'time_correction', [{ kind: 'direct_manager' }], `s7-3-dm-reg-${runSuffix}`)

    const res = await createRequest(orgDm, adminToken, '2026-07-13', 's7-3 dm regression')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)
    const snap = (
      await (pool as Pool).query('SELECT requester_snapshot FROM approval_instances WHERE id = $1', [instanceId])
    ).rows[0].requester_snapshot as { managerId?: string; deptHeadId?: string }
    expect(snap.managerId).toBe(managerHome)
    expect(snap.deptHeadId).toBeUndefined()
    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerHome }),
    ])
  })

  // ── Mixed direct_manager + dept_head flow freezes both ──
  it('MIXED: direct_manager + dept_head freezes both and assigns step 0 from manager', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(
      orgHome,
      'time_correction',
      [
        { name: 'S0', kind: 'direct_manager' },
        { name: 'S1', kind: 'dept_head' },
      ],
      `s7-3-mixed-${runSuffix}`,
    )

    const res = await createRequest(orgHome, adminToken, '2026-07-14', 's7-3 mixed flow')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)

    const snap = (
      await (pool as Pool).query('SELECT requester_snapshot FROM approval_instances WHERE id = $1', [instanceId])
    ).rows[0].requester_snapshot as { managerId?: string; deptHeadId?: string }
    expect(snap.managerId).toBe(managerHome)
    expect(snap.deptHeadId).toBe(headHome)

    const step0 = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE AND node_key = $2`,
      [instanceId, NODE_KEY_0],
    )
    expect(step0.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerHome }),
    ])

    // Advance: manager approves → step 1 uses frozen dept head (not live).
    const approve = await act(requestId, managerToken, 'approve')
    expect(approve.status, approve.raw).toBe(200)
    const step1 = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE AND node_key = $2`,
      [instanceId, NODE_KEY_1],
    )
    expect(step1.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: headHome }),
    ])
  })
})
