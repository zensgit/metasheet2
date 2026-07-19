import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'

// S7-4 (RATIFIED attendance-approval-s7 resolver design-lock §2.3 B1 / §3.3 / §3.4 / §4 / §4.1 / §7 S7-4):
// real-DB, HTTP-level coverage of manager_at_level end-to-end:
//   valid level-1/level-2 resolution + freeze into requester_snapshot.managerChainIds
//   unlinked / short chain block-with-error + zero persistence
//   two-org / one-local-user org-anchor
//   2-step freeze after directory chain mutation
//   dynamic assignment approve+reject authorization (negative / positive / admin)
//   flag-off create + flag-off advance rollback
//   missing/throwing port fail-closed is covered by unit tests (port is host-injected here)
//   legacy static still works with flag off
//   cycle/dense-chain/cap behavior is covered by ApprovalDirectoryOrg unit + approval-manager-chain.db
//
// Chain fixtures use leader_in_dept (the walk source for managerChainIds), NOT is_manager.

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

describeIfDatabase('S7-4 manager_at_level — freeze + assignment + auth (real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl: string | undefined
  let pool: Pool | undefined
  let prevRbac: string | undefined
  let prevFlag: string | undefined

  const runSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const orgHome = `s7-4-home-${runSuffix}`
  const orgForeign = `s7-4-foreign-${runSuffix}`
  const orgUnlinked = `s7-4-unlinked-${runSuffix}`
  const orgFreeze = `s7-4-freeze-${runSuffix}`
  const orgAuthz = `s7-4-authz-${runSuffix}`
  const orgFlagOff = `s7-4-flagoff-${runSuffix}`
  const orgShort = `s7-4-short-${runSuffix}`

  const requester = `s7-4-req-${runSuffix}`
  const managerL1Home = `s7-4-m1-home-${runSuffix}`
  const managerL2Home = `s7-4-m2-home-${runSuffix}`
  const managerL1Foreign = `s7-4-m1-foreign-${runSuffix}`
  const managerL1Alt = `s7-4-m1-alt-${runSuffix}`
  const otherApprover = `s7-4-other-${runSuffix}`
  const adminActor = `s7-4-admin-${runSuffix}`

  const userIds: string[] = [
    requester,
    managerL1Home,
    managerL2Home,
    managerL1Foreign,
    managerL1Alt,
    otherApprover,
    adminActor,
  ]
  const integrationIds: string[] = []
  const createdFlowIds: string[] = []
  const createdInstanceIds: string[] = []
  const createdRequestIds: string[] = []

  let adminToken = ''
  let managerL1Token = ''
  let managerL2Token = ''
  let otherToken = ''
  let adminActorToken = ''

  // Freeze-mutation fixture handles (orgFreeze leader swap).
  let freezeDeptR = ''
  let freezeAccM1 = ''
  let freezeAccAlt = ''

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
      [userId, `${userId}@s7-4.test`],
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
  ): Promise<void> {
    await (pool as Pool).query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary, is_manager)
       VALUES ($1, $2, $3, false)`,
      [accountId, departmentId, isPrimary],
    )
  }

  /**
   * Two-level dense chain for orgHome:
   *   R primary DEPT_R
   *   M1 leader of DEPT_R (leader_in_dept), primary DEPT_M1
   *   M2 leader of DEPT_M1, primary DEPT_M2 (top)
   * → managerChainIds = [managerL1Home, managerL2Home]
   */
  async function seedTwoLevelChain(
    orgId: string,
    localRequester: string,
    localM1: string,
    localM2: string,
    tag: string,
  ): Promise<{ integrationId: string; deptR: string; accM1: string; accM2: string }> {
    const integrationId = await seedIntegration(orgId, `s7-4-${tag}-int-${runSuffix}`, `corp-${tag}-${runSuffix}`)
    const extDeptR = `dept-r-${tag}-${runSuffix}`
    const extDeptM1 = `dept-m1-${tag}-${runSuffix}`
    const extDeptM2 = `dept-m2-${tag}-${runSuffix}`
    const deptR = await seedDept(integrationId, extDeptR, `${tag} R Eng`)
    const deptM1 = await seedDept(integrationId, extDeptM1, `${tag} M1 Eng`)
    const deptM2 = await seedDept(integrationId, extDeptM2, `${tag} M2 Eng`)

    const accR = await seedAccount(integrationId, `ext-r-${tag}-${runSuffix}`, `key-r-${tag}-${runSuffix}`, `Req${tag}`)
    const accM1 = await seedAccount(
      integrationId,
      `ext-m1-${tag}-${runSuffix}`,
      `key-m1-${tag}-${runSuffix}`,
      `M1${tag}`,
      { leader_in_dept: [{ dept_id: extDeptR, leader: true }] },
    )
    const accM2 = await seedAccount(
      integrationId,
      `ext-m2-${tag}-${runSuffix}`,
      `key-m2-${tag}-${runSuffix}`,
      `M2${tag}`,
      { leader_in_dept: [{ dept_id: extDeptM1, leader: true }] },
    )

    await link(accR, localRequester)
    await link(accM1, localM1)
    await link(accM2, localM2)
    await membership(accR, deptR, true)
    await membership(accM1, deptR, false)
    await membership(accM1, deptM1, true)
    await membership(accM2, deptM1, false)
    await membership(accM2, deptM2, true)

    return { integrationId, deptR, accM1, accM2 }
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
      body: JSON.stringify({ comment: `s7-4 ${action}` }),
    })
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) throw new Error('S7-4 tests require an available loopback port.')
    if (!dbUrl) throw new Error('DATABASE_URL / ATTENDANCE_TEST_DATABASE_URL is required for the S7-4 suite.')

    process.env.DATABASE_URL = dbUrl
    prevRbac = process.env.RBAC_BYPASS
    prevFlag = process.env[DYNAMIC_FLAG]
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    process.env[DYNAMIC_FLAG] = 'true'

    pool = new Pool({ connectionString: dbUrl })
    await pool.query('SELECT 1')

    for (const uid of userIds) await seedUser(uid)

    // ── orgHome: two-level chain ──
    await seedTwoLevelChain(orgHome, requester, managerL1Home, managerL2Home, 'home')

    // ── orgForeign: same local requester, different L1 manager (more recent updated_at) ──
    const foreign = await seedTwoLevelChain(
      orgForeign,
      requester,
      managerL1Foreign,
      managerL2Home,
      'foreign',
    )
    await pool.query(`UPDATE directory_accounts SET updated_at = now() + interval '1 hour'
      WHERE integration_id = $1`, [foreign.integrationId])

    // ── orgFreeze: two-level chain for freeze-mutation (swap L1 leader after create) ──
    const freeze = await seedTwoLevelChain(orgFreeze, requester, managerL1Home, managerL2Home, 'freeze')
    freezeDeptR = freeze.deptR
    freezeAccM1 = freeze.accM1
    // Alternate L1 leader account (linked to managerL1Alt), not leader yet.
    freezeAccAlt = await seedAccount(
      freeze.integrationId,
      `ext-m1-alt-${runSuffix}`,
      `key-m1-alt-${runSuffix}`,
      'M1Alt',
      {},
    )
    await link(freezeAccAlt, managerL1Alt)
    await membership(freezeAccAlt, freezeDeptR, false)

    // RBAC substrate for authz legs.
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
      [managerL1Home, managerL2Home, otherApprover, adminActor, requester],
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
    if (!address || typeof address === 'string') throw new Error('S7-4 server did not expose a TCP address.')
    baseUrl = `http://127.0.0.1:${address.port}`

    adminToken = await devToken(requester, 'user', 'attendance:admin,attendance:write,attendance:approve')
    managerL1Token = await devToken(managerL1Home, 'user', 'attendance:approve')
    managerL2Token = await devToken(managerL2Home, 'user', 'attendance:approve')
    otherToken = await devToken(otherApprover, 'user', 'attendance:approve')
    adminActorToken = await devToken(adminActor, 'user', 'attendance:admin')
  })

  afterAll(async () => {
    if (pool) {
      try {
        if (createdRequestIds.length > 0) {
          await pool.query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [createdRequestIds]).catch(() => undefined)
        }
        for (const oid of [orgHome, orgForeign, orgUnlinked, orgFreeze, orgAuthz, orgFlagOff, orgShort]) {
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

  // ── Authoring: S7-4 makes manager_at_level available when flag ON ──
  it('AUTHORING: flag ON + manager_at_level accepted (S7-4 implements the kind)', async () => {
    setFlag(true)
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: `s7-4-mal-flow-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 'manager_at_level', level: 2 }],
        orgId: orgHome,
        isActive: true,
      }),
    })
    expect(res.status, res.raw).toBe(201)
    const id = (res.body as { data?: { id?: string } }).data?.id
    if (id) createdFlowIds.push(id)
    const steps = (res.body as { data?: { steps?: unknown[] } }).data?.steps
    expect(steps).toEqual([{ name: undefined, kind: 'manager_at_level', level: 2 }])
  })

  // ── S7-1 NITs remain fixed ──
  it('NIT: dynamic + empty approverUserIds:[] → 422 MIXED (key-shape constraint)', async () => {
    setFlag(true)
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST',
      headers: authHeaders(adminToken),
      body: JSON.stringify({
        name: `s7-4-mixed-empty-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 'manager_at_level', level: 1, approverUserIds: [] }],
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
        name: `s7-4-nonstr-kind-${runSuffix}`,
        requestType: 'time_correction',
        steps: [{ kind: 123 }],
        orgId: orgHome,
        isActive: true,
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_STEP_KIND_INVALID')
  })

  // ── Linked resolution + freeze + assignment (level 1) ──
  it('RUNTIME create: level=1 freezes managerChainIds and assigns chain[0]', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgHome, 'time_correction', [{ kind: 'manager_at_level', level: 1 }], `s7-4-l1-${runSuffix}`)

    const workDate = '2026-07-01'
    const res = await createRequest(orgHome, adminToken, workDate, 's7-4 level1 resolution')
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
      'SELECT requester_snapshot FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    const snap = inst.rows[0].requester_snapshot as { id?: string; managerChainIds?: string[] }
    expect(snap.id).toBe(requester)
    expect(snap.managerChainIds).toEqual([managerL1Home, managerL2Home])

    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id, is_active, metadata
         FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toHaveLength(1)
    expect(assignments.rows[0]).toMatchObject({
      assignment_type: 'user',
      assignee_id: managerL1Home,
    })
    expect(assignments.rows.some((r) => r.assignment_type === 'source_queue')).toBe(false)
    expect(assignments.rows.some((r) => r.assignee_id === 'admin')).toBe(false)
  })

  // ── Level 2 positional pick ──
  it('RUNTIME create: level=2 assigns chain[1] (exactly one positional manager)', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgHome, 'time_correction', [{ kind: 'manager_at_level', level: 2 }], `s7-4-l2-${runSuffix}`)

    const res = await createRequest(orgHome, adminToken, '2026-07-02', 's7-4 level2 resolution')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)

    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerL2Home }),
    ])
    // Must not assign L1 or expand to multiple managers.
    expect(assignments.rows.some((r) => r.assignee_id === managerL1Home)).toBe(false)
    expect(assignments.rows).toHaveLength(1)
  })

  // ── Org anchor: two orgs, one local user ──
  it('ORG-ANCHOR: two-org/one-local-user freezes chain from the requesting org only', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(orgHome, 'time_correction', [{ kind: 'manager_at_level', level: 1 }], `s7-4-anchor-${runSuffix}`)

    const res = await createRequest(orgHome, adminToken, '2026-07-03', 's7-4 org anchor')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)
    const snap = (
      await (pool as Pool).query('SELECT requester_snapshot FROM approval_instances WHERE id = $1', [instanceId])
    ).rows[0].requester_snapshot as { managerChainIds?: string[] }
    expect(snap.managerChainIds?.[0]).toBe(managerL1Home)
    expect(snap.managerChainIds?.[0]).not.toBe(managerL1Foreign)
  })

  // ── Unlinked block-with-error + zero persistence ──
  it('UNLINKED: manager_at_level create fails 422 with ZERO attendance_requests / approval rows', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    const unlinkedUser = `s7-4-unlinked-user-${runSuffix}`
    await seedUser(unlinkedUser)
    userIds.push(unlinkedUser)
    await (pool as Pool).query(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'attendance:write'), ($1, 'attendance:admin')
       ON CONFLICT DO NOTHING`,
      [unlinkedUser],
    )
    await seedFlow(orgUnlinked, 'time_correction', [{ kind: 'manager_at_level', level: 1 }], `s7-4-unlinked-${runSuffix}`)

    const unlinkedToken = await devToken(unlinkedUser, 'user', 'attendance:admin,attendance:write')
    const beforeReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgUnlinked],
    )
    const beforeInst = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_instances
        WHERE (metadata->>'orgId' = $1 OR subject_snapshot->>'orgId' = $1)`,
      [orgUnlinked],
    )

    const res = await requestJson(`${baseUrl}/api/attendance/requests`, {
      method: 'POST',
      headers: authHeaders(unlinkedToken),
      body: JSON.stringify({
        orgId: orgUnlinked,
        workDate: '2026-07-04',
        requestType: 'time_correction',
        requestedInAt: '2026-07-04T01:00:00Z',
        requestedOutAt: '2026-07-04T10:00:00Z',
        reason: 's7-4 unlinked block',
      }),
    })
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED')

    const afterReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgUnlinked],
    )
    const afterInst = await (pool as Pool).query(
      `SELECT COUNT(*)::int AS n FROM approval_instances
        WHERE (metadata->>'orgId' = $1 OR subject_snapshot->>'orgId' = $1)`,
      [orgUnlinked],
    )
    expect(afterReq.rows[0].n).toBe(beforeReq.rows[0].n)
    expect(afterInst.rows[0].n).toBe(beforeInst.rows[0].n)
  })

  // ── Short chain (level 2 on a one-level org) ──
  it('SHORT CHAIN: level=2 with only one linked manager → create 422 + zero rows', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    // One-level chain only.
    const intId = await seedIntegration(orgShort, `s7-4-short-int-${runSuffix}`, `corp-short-${runSuffix}`)
    const extDept = `dept-short-${runSuffix}`
    const deptId = await seedDept(intId, extDept, 'Short Eng')
    const accR = await seedAccount(intId, `ext-r-short-${runSuffix}`, `key-r-short-${runSuffix}`, 'ReqShort')
    const accM = await seedAccount(
      intId,
      `ext-m-short-${runSuffix}`,
      `key-m-short-${runSuffix}`,
      'MgrShort',
      { leader_in_dept: [{ dept_id: extDept, leader: true }] },
    )
    await link(accR, requester)
    await link(accM, managerL1Home)
    await membership(accR, deptId, true)
    await membership(accM, deptId, false)

    await seedFlow(orgShort, 'time_correction', [{ kind: 'manager_at_level', level: 2 }], `s7-4-short-${runSuffix}`)

    const beforeReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgShort],
    )
    const res = await createRequest(orgShort, adminToken, '2026-07-05', 's7-4 short chain')
    expect(res.status, res.raw).toBe(422)
    expect(errorCode(res)).toBe('APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED')
    const afterReq = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgShort],
    )
    expect(afterReq.rows[0].n).toBe(beforeReq.rows[0].n)
  })

  // ── 2-step freeze after directory mutation ──
  it('FREEZE: 2-step flow keeps step-2 assignee after directory chain mutation', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'true'
    await seedFlow(
      orgFreeze,
      'time_correction',
      [
        { name: 'S0', approverUserIds: [managerL1Home] },
        { name: 'S1', kind: 'manager_at_level', level: 1 },
      ],
      `s7-4-freeze-${runSuffix}`,
    )

    const res = await createRequest(orgFreeze, adminToken, '2026-07-06', 's7-4 freeze')
    expect(res.status, res.raw).toBe(201)
    const requestId = requestIdFrom(res) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)

    const snapBefore = (
      await (pool as Pool).query('SELECT requester_snapshot FROM approval_instances WHERE id = $1', [instanceId])
    ).rows[0].requester_snapshot as { managerChainIds?: string[] }
    expect(snapBefore.managerChainIds?.[0]).toBe(managerL1Home)

    // Mutate directory: strip L1 leadership from freezeAccM1, give it to freezeAccAlt BEFORE advance.
    await (pool as Pool).query(
      `UPDATE directory_accounts SET raw = '{}'::jsonb WHERE id = $1`,
      [freezeAccM1],
    )
    await (pool as Pool).query(
      `UPDATE directory_accounts SET raw = $2::jsonb WHERE id = $1`,
      [
        freezeAccAlt,
        JSON.stringify({
          leader_in_dept: [
            {
              dept_id: (
                await (pool as Pool).query<{ external_department_id: string }>(
                  'SELECT external_department_id FROM directory_departments WHERE id = $1',
                  [freezeDeptR],
                )
              ).rows[0].external_department_id,
              leader: true,
            },
          ],
        }),
      ],
    )

    // Step 0 assignee approves → advances to step 1 (manager_at_level level 1).
    const approve = await act(requestId, managerL1Token, 'approve')
    expect(approve.status, approve.raw).toBe(200)

    const snapAfter = (
      await (pool as Pool).query(
        'SELECT requester_snapshot, current_step, current_node_key FROM approval_instances WHERE id = $1',
        [instanceId],
      )
    ).rows[0]
    expect((snapAfter.requester_snapshot as { managerChainIds?: string[] }).managerChainIds?.[0]).toBe(
      managerL1Home,
    )
    expect(snapAfter.current_step).toBe(1)
    expect(snapAfter.current_node_key).toBe(NODE_KEY_1)

    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE AND node_key = $2`,
      [instanceId, NODE_KEY_1],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerL1Home }),
    ])
    // Mutated L1 alt must NOT be the assignee.
    expect(assignments.rows.some((r) => r.assignee_id === managerL1Alt)).toBe(false)
  })

  // ── Dynamic assignment authorization (S7-0 re-run for this kind) ──
  it('AUTHZ: dynamic user assignee can approve+reject; unassigned scope-authorized actor 403s; admin override works', async () => {
    setFlag(true)
    process.env.RBAC_BYPASS = 'false'
    try {
      await seedFlow(orgAuthz, 'time_correction', [{ kind: 'manager_at_level', level: 1 }], `s7-4-authz-${runSuffix}`)
      await seedTwoLevelChain(orgAuthz, requester, managerL1Home, managerL2Home, 'authz')

      // Positive approve
      const createA = await createRequest(orgAuthz, adminToken, '2026-07-07', 's7-4 authz approve')
      expect(createA.status, createA.raw).toBe(201)
      const requestIdA = requestIdFrom(createA) as string
      createdRequestIds.push(requestIdA)
      createdInstanceIds.push(
        (
          await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [
            requestIdA,
          ])
        ).rows[0].approval_instance_id as string,
      )

      const negApprove = await act(requestIdA, otherToken, 'approve')
      expect(negApprove.status, negApprove.raw).toBe(403)
      expect(errorCode(negApprove)).toBe('FORBIDDEN')

      // L2 is on the chain but is NOT the level-1 assignee — must also 403.
      const l2Approve = await act(requestIdA, managerL2Token, 'approve')
      expect(l2Approve.status, l2Approve.raw).toBe(403)

      const posApprove = await act(requestIdA, managerL1Token, 'approve')
      expect(posApprove.status, posApprove.raw).toBe(200)

      // Reject legs
      const createB = await createRequest(orgAuthz, adminToken, '2026-07-08', 's7-4 authz reject')
      expect(createB.status, createB.raw).toBe(201)
      const requestIdB = requestIdFrom(createB) as string
      createdRequestIds.push(requestIdB)
      createdInstanceIds.push(
        (
          await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [
            requestIdB,
          ])
        ).rows[0].approval_instance_id as string,
      )

      const negReject = await act(requestIdB, otherToken, 'reject')
      expect(negReject.status, negReject.raw).toBe(403)
      expect(errorCode(negReject)).toBe('FORBIDDEN')

      const posReject = await act(requestIdB, managerL1Token, 'reject')
      expect(posReject.status, posReject.raw).toBe(200)

      // Admin override approve
      const createC = await createRequest(orgAuthz, adminToken, '2026-07-09', 's7-4 authz admin')
      expect(createC.status, createC.raw).toBe(201)
      const requestIdC = requestIdFrom(createC) as string
      createdRequestIds.push(requestIdC)
      createdInstanceIds.push(
        (
          await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [
            requestIdC,
          ])
        ).rows[0].approval_instance_id as string,
      )
      const adminApprove = await act(requestIdC, adminActorToken, 'approve')
      expect(adminApprove.status, adminApprove.raw).toBe(200)

      // Admin override reject
      const createD = await createRequest(orgAuthz, adminToken, '2026-07-10', 's7-4 authz admin reject')
      expect(createD.status, createD.raw).toBe(201)
      const requestIdD = requestIdFrom(createD) as string
      createdRequestIds.push(requestIdD)
      createdInstanceIds.push(
        (
          await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [
            requestIdD,
          ])
        ).rows[0].approval_instance_id as string,
      )
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
    await seedFlow(orgFlagOff, 'time_correction', [{ kind: 'manager_at_level', level: 1 }], `s7-4-flagoff-create-${runSuffix}`)

    const before = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM attendance_requests WHERE org_id = $1',
      [orgFlagOff],
    )
    const res = await createRequest(orgFlagOff, adminToken, '2026-07-11', 's7-4 flag-off create')
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
    const orgAdv = `s7-4-adv-${runSuffix}`
    await seedTwoLevelChain(orgAdv, requester, managerL1Home, managerL2Home, 'adv')

    await seedFlow(
      orgAdv,
      'time_correction',
      [
        { name: 'S0', approverUserIds: [managerL1Home] },
        { name: 'S1', kind: 'manager_at_level', level: 2 },
      ],
      `s7-4-flagoff-adv-${runSuffix}`,
    )

    const create = await createRequest(orgAdv, adminToken, '2026-07-12', 's7-4 flag-off advance')
    expect(create.status, create.raw).toBe(201)
    const requestId = requestIdFrom(create) as string
    createdRequestIds.push(requestId)
    const instanceId = (
      await (pool as Pool).query('SELECT approval_instance_id FROM attendance_requests WHERE id = $1', [requestId])
    ).rows[0].approval_instance_id as string
    createdInstanceIds.push(instanceId)

    setFlag(false)
    const approve = await act(requestId, managerL1Token, 'approve')
    expect(approve.status, approve.raw).toBe(422)
    expect(errorCode(approve)).toBe('APPROVAL_STEP_KIND_UNAVAILABLE')

    const inst = await (pool as Pool).query(
      'SELECT status, current_step, current_node_key FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    expect(inst.rows[0].status).toBe('pending')
    expect(inst.rows[0].current_step).toBe(0)
    expect(inst.rows[0].current_node_key).toBe(NODE_KEY_0)
    const records = await (pool as Pool).query(
      'SELECT COUNT(*)::int AS n FROM approval_records WHERE instance_id = $1',
      [instanceId],
    )
    expect(records.rows[0].n).toBe(0)
    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerL1Home }),
    ])

    await (pool as Pool).query('DELETE FROM attendance_requests WHERE org_id = $1', [orgAdv]).catch(() => undefined)
    await (pool as Pool).query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgAdv]).catch(() => undefined)
  })

  // ── Legacy static byte-identity under flag off ──
  it('LEGACY static: flag OFF flow with no dynamic kind still creates + assigns statically', async () => {
    setFlag(false)
    process.env.RBAC_BYPASS = 'true'
    const orgLegacy = `s7-4-legacy-${runSuffix}`
    await seedFlow(
      orgLegacy,
      'time_correction',
      [{ name: 'LM', approverUserIds: [managerL1Home] }],
      `s7-4-legacy-${runSuffix}`,
    )
    const res = await createRequest(orgLegacy, adminToken, '2026-07-13', 's7-4 legacy static')
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
    expect(snap.managerChainIds).toBeUndefined()
    expect(snap.managerId).toBeUndefined()
    expect(snap.id).toBe(requester)
    const assignments = await (pool as Pool).query(
      `SELECT assignment_type, assignee_id FROM approval_assignments
        WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
    expect(assignments.rows).toEqual([
      expect.objectContaining({ assignment_type: 'user', assignee_id: managerL1Home }),
    ])
    await (pool as Pool).query('DELETE FROM attendance_requests WHERE org_id = $1', [orgLegacy]).catch(() => undefined)
    await (pool as Pool).query('DELETE FROM attendance_approval_flows WHERE org_id = $1', [orgLegacy]).catch(() => undefined)
  })
})
