import { Client } from 'pg'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import {
  getOrCreateLocalIntegration,
  setLocalMembershipManager,
} from '../../src/directory/directory-sync'
import { archiveLocalAccount, archiveLocalDepartment } from '../../src/directory/local-directory-org'
import { adminDirectoryLocalRouter } from '../../src/routes/admin-directory-local'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'

/**
 * Canonical Org MVP — B3 (normalized manager relation), #4215 §5.4, real DB.
 *
 * Owner ruling (Wave 3, 2026-07-12): the manager/department-head link is a FIRST-CLASS,
 * provider-neutral flag on the membership (`directory_account_departments.is_manager`), NOT parsed
 * from a provider's raw JSON. `ApprovalDirectoryOrg`'s direct-manager resolution (step 2) is now
 * DUAL-SOURCE with precedence:
 *   - if the requester's primary department has ANY `is_manager = true` membership → resolve from
 *     that normalized relation (authoritative, even when it links to no local user);
 *   - otherwise → the legacy DingTalk `raw.leader_in_dept` parse, byte-for-byte unchanged.
 *
 * This proves, against real Postgres:
 *   (a) NORMALIZED resolution — a local integration whose manager is flagged via the normalized
 *       relation (set through `setLocalMembershipManager`) resolves that manager;
 *   (b) DINGTALK REGRESSION PIN (load-bearing compat leg) — a DingTalk-shaped integration whose
 *       manager is flagged the pre-existing way (`raw.leader_in_dept`, `is_manager` left
 *       default-false) resolves the SAME manager it always did; a positive control asserts NO
 *       membership got an `is_manager` flag, so the compat argument is non-vacuous;
 *   (c) PRECEDENCE — when a department has BOTH a legacy `leader_in_dept` leader AND a normalized
 *       `is_manager` manager (a different account), the normalized relation wins and the legacy
 *       source is ignored;
 *   (d1) `is_manager` DEFAULTS false; the writer sets it and writes NO provider raw;
 *   (d2) the writer's LOCAL-ONLY boundary — it refuses (no-op) a DingTalk membership, keeping the
 *       bit-identical guarantee's writer side intact.
 *
 * Fixture IDs are namespaced with this file's own STAMP + a per-scenario suffix — integration
 * specs share one real Postgres in CI (plugin-tests.yml), so a bare `Date.now()` can collide with
 * another file's fixtures in the same run.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()

// Adapt the QueryResultRow-constrained `query` to the resolver's unconstrained QueryFn.
const queryFn = <Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> =>
  query(text, params).then((r) => ({ rows: r.rows as Row[] }))

function id(suffix: string): string {
  return `b3-nm-${STAMP}-${suffix}`
}

async function seedUser(userId: string): Promise<void> {
  await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [userId, `${userId}@example.test`])
}

async function seedDept(integrationId: string, provider: string, externalId: string, name: string): Promise<string> {
  return (
    await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
       VALUES ($1, $2, $3, $4, true, '{}'::jsonb) RETURNING id`,
      [integrationId, provider, externalId, name],
    )
  ).rows[0].id
}

async function seedAccount(
  integrationId: string,
  provider: string,
  externalUserId: string,
  externalKey: string,
  name: string,
  raw: Record<string, unknown>,
): Promise<string> {
  return (
    await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [integrationId, provider, externalUserId, externalKey, name, JSON.stringify(raw)],
    )
  ).rows[0].id
}

async function link(accountId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
     VALUES ($1, $2, 'linked', 'manual')`,
    [accountId, userId],
  )
}

async function membership(accountId: string, departmentId: string, isPrimary: boolean): Promise<void> {
  await query(
    `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
     VALUES ($1, $2, $3)`,
    [accountId, departmentId, isPrimary],
  )
}

async function readIsManager(accountId: string, departmentId: string): Promise<boolean> {
  return (
    await query<{ is_manager: boolean }>(
      `SELECT is_manager FROM directory_account_departments
        WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [accountId, departmentId],
    )
  ).rows[0].is_manager
}

describeIfDatabase('B3 normalized manager relation — ApprovalDirectoryOrg dual-source (real DB)', () => {
  const integrationIds: string[] = []
  const userIds: string[] = []

  // (a) local integration — normalized relation.
  const U_A_REQ = id('a-req')
  const U_A_MGR = id('a-mgr')
  let localDeptA = ''
  let localMgrAccountA = ''

  // (b) DingTalk-shaped integration — legacy leader_in_dept.
  const U_B_REQ = id('b-req')
  const U_B_MGR = id('b-mgr')
  let dtIntegrationB = ''

  // (c) precedence — both sources present on one DingTalk integration.
  const U_C_REQ = id('c-req')
  const U_C_LEGACY = id('c-legacy')
  const U_C_NORM = id('c-norm')
  let dtDeptC = ''
  let normAccountC = ''

  // (d1) writer + default + no-raw.
  let localDeptD = ''
  let localAccountD = ''

  // (d2) writer local-only boundary.
  let dtDeptE = ''
  let dtAccountE = ''

  beforeAll(async () => {
    // ---- (a) local integration ----
    const localA = await getOrCreateLocalIntegration(id('a-org'))
    integrationIds.push(localA.id)
    localDeptA = await seedDept(localA.id, 'local', id('a-dept'), 'EngA')
    await seedUser(U_A_REQ)
    await seedUser(U_A_MGR)
    const reqA = await seedAccount(localA.id, 'local', id('a-ext-req'), id('a-key-req'), 'ReqA', {})
    localMgrAccountA = await seedAccount(localA.id, 'local', id('a-ext-mgr'), id('a-key-mgr'), 'MgrA', {})
    userIds.push(U_A_REQ, U_A_MGR)
    await link(reqA, U_A_REQ)
    await link(localMgrAccountA, U_A_MGR)
    await membership(reqA, localDeptA, true)
    await membership(localMgrAccountA, localDeptA, false)

    // ---- (b) DingTalk-shaped integration ----
    dtIntegrationB = (
      await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [id('b-int'), id('b-corp')],
      )
    ).rows[0].id
    integrationIds.push(dtIntegrationB)
    const deptB = await seedDept(dtIntegrationB, 'dingtalk', id('b-dept'), 'EngB')
    await seedUser(U_B_REQ)
    await seedUser(U_B_MGR)
    const reqB = await seedAccount(dtIntegrationB, 'dingtalk', id('b-ext-req'), id('b-key-req'), 'ReqB', {})
    const mgrB = await seedAccount(dtIntegrationB, 'dingtalk', id('b-ext-mgr'), id('b-key-mgr'), 'MgrB', {
      leader_in_dept: [{ dept_id: id('b-dept'), leader: true }],
    })
    userIds.push(U_B_REQ, U_B_MGR)
    await link(reqB, U_B_REQ)
    await link(mgrB, U_B_MGR)
    await membership(reqB, deptB, true)
    await membership(mgrB, deptB, true) // NOTE: is_manager intentionally left default-false.

    // ---- (c) precedence: legacy leader AND normalized manager on one DingTalk integration ----
    const dtIntegrationC = (
      await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [id('c-int'), id('c-corp')],
      )
    ).rows[0].id
    integrationIds.push(dtIntegrationC)
    dtDeptC = await seedDept(dtIntegrationC, 'dingtalk', id('c-dept'), 'EngC')
    await seedUser(U_C_REQ)
    await seedUser(U_C_LEGACY)
    await seedUser(U_C_NORM)
    const reqC = await seedAccount(dtIntegrationC, 'dingtalk', id('c-ext-req'), id('c-key-req'), 'ReqC', {})
    const legacyC = await seedAccount(dtIntegrationC, 'dingtalk', id('c-ext-legacy'), id('c-key-legacy'), 'LegacyC', {
      leader_in_dept: [{ dept_id: id('c-dept'), leader: true }],
    })
    normAccountC = await seedAccount(dtIntegrationC, 'dingtalk', id('c-ext-norm'), id('c-key-norm'), 'NormC', {})
    userIds.push(U_C_REQ, U_C_LEGACY, U_C_NORM)
    await link(reqC, U_C_REQ)
    await link(legacyC, U_C_LEGACY)
    await link(normAccountC, U_C_NORM)
    await membership(reqC, dtDeptC, true)
    await membership(legacyC, dtDeptC, true)
    await membership(normAccountC, dtDeptC, true)

    // ---- (d1) local writer target ----
    const localD = await getOrCreateLocalIntegration(id('d-org'))
    integrationIds.push(localD.id)
    localDeptD = await seedDept(localD.id, 'local', id('d-dept'), 'EngD')
    localAccountD = await seedAccount(localD.id, 'local', id('d-ext'), id('d-key'), 'AcctD', {})
    await membership(localAccountD, localDeptD, true)

    // ---- (d2) DingTalk writer-boundary target ----
    const dtIntegrationE = (
      await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [id('e-int'), id('e-corp')],
      )
    ).rows[0].id
    integrationIds.push(dtIntegrationE)
    dtDeptE = await seedDept(dtIntegrationE, 'dingtalk', id('e-dept'), 'EngE')
    dtAccountE = await seedAccount(dtIntegrationE, 'dingtalk', id('e-ext'), id('e-key'), 'AcctE', {})
    await membership(dtAccountE, dtDeptE, true)
  })

  afterAll(async () => {
    try {
      for (const integrationId of integrationIds) {
        // account_departments + links cascade on directory_accounts delete.
        await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
      if (userIds.length > 0) await query(`DELETE FROM users WHERE id = ANY($1)`, [userIds])
    } catch {
      /* best effort */
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('(a) resolves the manager from the NORMALIZED is_manager relation on a local integration', async () => {
    // Exercise the writer as the flag source (the PATCH /memberships route calls it in production).
    expect(
      await setLocalMembershipManager(id('a-org'), { directoryAccountId: localMgrAccountA, directoryDepartmentId: localDeptA }, true),
    ).toEqual({ outcome: 'updated' })

    const rel = await resolveApprovalRequesterOrgRelations(U_A_REQ, queryFn)
    // Exact shape: manager from the normalized relation; department name lifted; no title/head seeded.
    expect(rel).toEqual({ managerId: U_A_MGR, primaryDepartmentName: 'EngA' })
  })

  it('(b) DINGTALK REGRESSION PIN: legacy leader_in_dept resolution is unchanged, and no is_manager was set', async () => {
    const rel = await resolveApprovalRequesterOrgRelations(U_B_REQ, queryFn)
    expect(rel).toEqual({ managerId: U_B_MGR, primaryDepartmentName: 'EngB' })

    // Positive control for the compat argument: NOT ONE membership on the DingTalk integration
    // carries the normalized flag — the whole reason the legacy path still runs bit-identically.
    const flagged = (
      await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM directory_account_departments ad
           JOIN directory_accounts a ON a.id = ad.directory_account_id
          WHERE a.integration_id = $1 AND ad.is_manager = true`,
        [dtIntegrationB],
      )
    ).rows[0].count
    expect(flagged).toBe(0)
  })

  it('(c) PRECEDENCE: the normalized relation wins over a legacy leader_in_dept leader in the same dept', async () => {
    // Flag the normalized manager directly (this DingTalk membership is not a writer target — the
    // writer is local-only — so the resolver-precedence fixture sets the column directly).
    await query(
      `UPDATE directory_account_departments SET is_manager = true
        WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [normAccountC, dtDeptC],
    )

    const rel = await resolveApprovalRequesterOrgRelations(U_C_REQ, queryFn)
    expect(rel.managerId).toBe(U_C_NORM) // normalized wins
    expect(rel.managerId).not.toBe(U_C_LEGACY) // legacy leader_in_dept is ignored once normalized is present
  })

  it('(d1) is_manager defaults false; the writer flips it and writes NO provider raw', async () => {
    expect(await readIsManager(localAccountD, localDeptD)).toBe(false) // DEFAULT false

    expect(
      await setLocalMembershipManager(id('d-org'), { directoryAccountId: localAccountD, directoryDepartmentId: localDeptD }, true),
    ).toEqual({ outcome: 'updated' })
    expect(await readIsManager(localAccountD, localDeptD)).toBe(true)

    // No raw write: the account's provider-raw JSON is untouched by the normalized-flag write.
    const raw = (await query<{ raw: unknown }>(`SELECT raw FROM directory_accounts WHERE id = $1`, [localAccountD])).rows[0].raw
    expect(raw).toEqual({})

    // Round-trips back to false.
    expect(
      await setLocalMembershipManager(id('d-org'), { directoryAccountId: localAccountD, directoryDepartmentId: localDeptD }, false),
    ).toEqual({ outcome: 'updated' })
    expect(await readIsManager(localAccountD, localDeptD)).toBe(false)
  })

  it('(d2) writer LOCAL-ONLY boundary: it refuses (no-op) a DingTalk membership, leaving is_manager false', async () => {
    // dtIntegrationE has org_id 'default' (schema default), so 'default' is the org that WOULD match
    // if provider weren't the blocker — isolating the boundary to the `i.provider = 'local'` gate.
    expect(
      await setLocalMembershipManager('default', { directoryAccountId: dtAccountE, directoryDepartmentId: dtDeptE }, true),
    ).toEqual({ outcome: 'not_found' })
    expect(await readIsManager(dtAccountE, dtDeptE)).toBe(false)
  })
})

// =============================================================================================
// B3 writer scope + resolver integration binding (real DB). The writer's UPDATE binds org +
// integration (+ active status) + provider (on all three joined rows) + account/department; the
// resolver binds `d.integration_id` to the requester's integration. Mutation targets: m1 = drop
// the resolver's `d.integration_id`; m2 = drop the writer's `d.integration_id = a.integration_id`
// (isolated below with a same-provider, different-integration fixture — a DingTalk-department
// fixture would ALSO trip the newer `d.provider = 'local'` predicate and so could not isolate m2
// on its own); m-status/m-aprov/m-dprov = the owner round-3 predicates, isolated in the route
// describe block below (each test flips exactly ONE of status/account-provider/dept-provider).
// =============================================================================================
describeIfDatabase('B3 writer four-way scope + resolver integration binding (real DB)', () => {
  const integrationIds: string[] = []
  const userIds: string[] = []

  afterAll(async () => {
    try {
      for (const integrationId of integrationIds) {
        await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
      if (userIds.length > 0) await query(`DELETE FROM users WHERE id = ANY($1)`, [userIds])
    } catch {
      /* best effort */
    }
  })

  it('writer refuses a CROSS-ORG call (org mismatch) — not_found, is_manager untouched; correct org flips it', async () => {
    const local = await getOrCreateLocalIntegration(id('wx-org'))
    integrationIds.push(local.id)
    const dept = await seedDept(local.id, 'local', id('wx-dept'), 'WX')
    const acct = await seedAccount(local.id, 'local', id('wx-ext'), id('wx-key'), 'WX', {})
    await membership(acct, dept, true)

    // Same account+dept, but a DIFFERENT org string → the `i.org_id = $3` gate fails → no match.
    expect(
      await setLocalMembershipManager(id('wx-OTHER-org'), { directoryAccountId: acct, directoryDepartmentId: dept }, true),
    ).toEqual({ outcome: 'not_found' })
    expect(await readIsManager(acct, dept)).toBe(false)

    // Control: the CORRECT org DOES flip it (proves the fixture is otherwise writable — the org
    // gate, not some unrelated bind, is what refused the cross-org call above).
    expect(
      await setLocalMembershipManager(id('wx-org'), { directoryAccountId: acct, directoryDepartmentId: dept }, true),
    ).toEqual({ outcome: 'updated' })
    expect(await readIsManager(acct, dept)).toBe(true)
  })

  it('writer refuses a LOCAL-account × DINGTALK-department malformed membership — not_found', async () => {
    const local = await getOrCreateLocalIntegration(id('wf-org'))
    integrationIds.push(local.id)
    const localAcct = await seedAccount(local.id, 'local', id('wf-ext'), id('wf-key'), 'WF', {})

    // A DingTalk integration + department; wire the LOCAL account to the DingTalk dept (malformed).
    const dt = (
      await query<{ id: string }>(`INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`, [id('wf-dt-int'), id('wf-dt-corp')])
    ).rows[0].id
    integrationIds.push(dt)
    const dtDept = await seedDept(dt, 'dingtalk', id('wf-dt-dept'), 'WF-DT')
    await membership(localAcct, dtDept, true)

    // The account is local & in this org, but the department lives in the DingTalk integration —
    // refused BOTH by the `d.integration_id = a.integration_id` bind AND by `d.provider = 'local'`
    // (the DingTalk dept's own provider column). Because two independent predicates both reject
    // this fixture, it is NOT the isolating test for either one — see the dedicated
    // same-provider/different-integration fixture right below for the m2-isolated case, and the
    // route describe block below for the m-dprov-isolated case.
    expect(
      await setLocalMembershipManager(id('wf-org'), { directoryAccountId: localAcct, directoryDepartmentId: dtDept }, true),
    ).toEqual({ outcome: 'not_found' })
    expect(await readIsManager(localAcct, dtDept)).toBe(false)
  })

  it('writer refuses a LOCAL-account × LOCAL-department pair from DIFFERENT integrations — not_found (m2 target, isolated from provider checks)', async () => {
    const localA = await getOrCreateLocalIntegration(id('wf2-org-a'))
    integrationIds.push(localA.id)
    const acctA = await seedAccount(localA.id, 'local', id('wf2-ext-a'), id('wf2-key-a'), 'WF2A', {})

    const localB = await getOrCreateLocalIntegration(id('wf2-org-b'))
    integrationIds.push(localB.id)
    const deptB = await seedDept(localB.id, 'local', id('wf2-dept-b'), 'WF2B')

    // Both rows are provider='local' (passes a.provider/d.provider AND i.provider/i.status) but
    // belong to DIFFERENT integrations — only `d.integration_id = a.integration_id` refuses this,
    // so this fixture isolates m2 cleanly (dropping it, and only it, flips the result to true).
    await membership(acctA, deptB, true)

    expect(
      await setLocalMembershipManager(id('wf2-org-a'), { directoryAccountId: acctA, directoryDepartmentId: deptB }, true),
    ).toEqual({ outcome: 'not_found' })
    expect(await readIsManager(acctA, deptB)).toBe(false)
  })

  it('resolver binds d.integration_id: a same-external-id is_manager row in ANOTHER integration does NOT leak (m1 target)', async () => {
    const U_REQ = id('rg-req')
    const U_MGR = id('rg-mgr')
    await seedUser(U_REQ)
    await seedUser(U_MGR)
    userIds.push(U_REQ, U_MGR)

    const SHARED_EXT = id('rg-shared-ext')

    // int-1 — the requester's integration; its primary dept carries SHARED_EXT.
    const int1 = await getOrCreateLocalIntegration(id('rg-org1'))
    integrationIds.push(int1.id)
    const dept1 = await seedDept(int1.id, 'local', SHARED_EXT, 'RG1')
    const req = await seedAccount(int1.id, 'local', id('rg-ext-req'), id('rg-key-req'), 'RGReq', {})
    await link(req, U_REQ)
    await membership(req, dept1, true)

    // int-2 — a DIFFERENT integration with a dept sharing the SAME external_department_id. The
    // manager account is in int-1 (so `a.integration_id = $1` passes), but its is_manager membership
    // points at the int-2 dept, and its raw carries NO leader_in_dept (so the LEGACY path can never
    // resolve it). Only the normalized read could — and only if `d.integration_id` were dropped.
    const int2 = await getOrCreateLocalIntegration(id('rg-org2'))
    integrationIds.push(int2.id)
    const dept2 = await seedDept(int2.id, 'local', SHARED_EXT, 'RG2')
    const mgr = await seedAccount(int1.id, 'local', id('rg-ext-mgr'), id('rg-key-mgr'), 'RGMgr', {})
    await link(mgr, U_MGR)
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary, is_manager)
       VALUES ($1, $2, false, true)`,
      [mgr, dept2],
    )

    const rel = await resolveApprovalRequesterOrgRelations(U_REQ, queryFn)
    // With `d.integration_id` bound to the requester's integration, the int-2 dept is out of scope →
    // no normalized manager, and the legacy scan finds no leader → managerId is absent. Dropping the
    // bind (m1) would leak U_MGR here.
    expect(rel.managerId).toBeUndefined()
  })
})

// =============================================================================================
// B3 set-manager ROUTE (real DB, HTTP) — PATCH /memberships/:id {isManager}. Drives the REAL
// route as platform admin: end-to-end true→resolver-resolves / false→resolver-stops, the audit
// row, platform-admin gating (401/403), field smuggling + type rejection, the XOR / no-partial
// contract (m3 target: drop the XOR guard), the empty-body 400, and the 404 on a non-local /
// absent membership.
// =============================================================================================
describeIfDatabase('B3 set-manager route — PATCH /memberships/:id {isManager} (real DB, HTTP)', () => {
  const S = Date.now()
  const rid = (s: string): string => `b3-route-${S}-${s}`
  const accountIds: string[] = []
  const otherIntegrationIds: string[] = []
  const userIds: string[] = []
  // Owner round-3 (P2-1/P2-2) hardening tests each seed their OWN department under `localInt` so
  // a temporary provider/status flip never touches the shared `deptId` fixture other tests here
  // depend on.
  const extraDeptIds: string[] = []
  let localInt = ''
  let deptId = ''
  let mgrAccountId = ''
  let membershipId = ''
  let uReq = ''
  let uMgr = ''
  let localAcctForMalformed = ''
  let dtDeptId = ''

  function appAs(user: unknown): express.Express {
    const app = express()
    app.use(express.json())
    if (user !== undefined) {
      app.use((req, _res, next) => {
        ;(req as express.Request & { user?: unknown }).user = user
        next()
      })
    }
    app.use('/api/admin/directory/local', adminDirectoryLocalRouter())
    return app
  }
  const adminApp = appAs({ id: `b3-route-admin-${S}`, role: 'admin' })
  const nonAdminApp = appAs({ id: `b3-route-nonadmin-${S}` })
  const noAuthApp = appAs(undefined)

  beforeAll(async () => {
    // The route resolves org 'default' server-side, so seed into the default org's local integration.
    const local = await getOrCreateLocalIntegration('default')
    localInt = local.id
    uReq = rid('u-req')
    uMgr = rid('u-mgr')
    await seedUser(uReq)
    await seedUser(uMgr)
    userIds.push(uReq, uMgr)
    deptId = await seedDept(localInt, 'local', rid('dept'), 'RouteDept')
    const reqAccountId = await seedAccount(localInt, 'local', rid('ext-req'), rid('key-req'), 'RouteReq', {})
    mgrAccountId = await seedAccount(localInt, 'local', rid('ext-mgr'), rid('key-mgr'), 'RouteMgr', {})
    accountIds.push(reqAccountId, mgrAccountId)
    await link(reqAccountId, uReq)
    await link(mgrAccountId, uMgr)
    await membership(reqAccountId, deptId, true)
    await membership(mgrAccountId, deptId, false)
    membershipId = `${mgrAccountId}:${deptId}`

    // Malformed target: a LOCAL account (default int) joined to a DingTalk department.
    localAcctForMalformed = await seedAccount(localInt, 'local', rid('ext-mal'), rid('key-mal'), 'RouteMal', {})
    accountIds.push(localAcctForMalformed)
    const dtInt = (
      await query<{ id: string }>(`INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`, [rid('dt-int'), rid('dt-corp')])
    ).rows[0].id
    otherIntegrationIds.push(dtInt)
    dtDeptId = await seedDept(dtInt, 'dingtalk', rid('dt-dept'), 'RouteDT')
    await membership(localAcctForMalformed, dtDeptId, true)
  })

  afterAll(async () => {
    try {
      for (const accountId of accountIds) await query(`DELETE FROM directory_accounts WHERE id = $1`, [accountId])
      if (deptId) await query(`DELETE FROM directory_departments WHERE id = $1`, [deptId])
      for (const extraDeptId of extraDeptIds) await query(`DELETE FROM directory_departments WHERE id = $1`, [extraDeptId])
      for (const integrationId of otherIntegrationIds) {
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
      if (userIds.length > 0) await query(`DELETE FROM users WHERE id = ANY($1)`, [userIds])
    } catch {
      /* best effort */
    }
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('set true over HTTP → ApprovalDirectoryOrg resolves the manager; audit row written; false → resolver stops', async () => {
    const setTrue = await request(adminApp).patch(`/api/admin/directory/local/memberships/${membershipId}`).send({ isManager: true })
    expect(setTrue.status).toBe(200)
    expect(setTrue.body.data.membership.isManager).toBe(true)
    expect(await readIsManager(mgrAccountId, deptId)).toBe(true)

    const resolvedOn = await resolveApprovalRequesterOrgRelations(uReq, queryFn)
    expect(resolvedOn.managerId).toBe(uMgr)

    const audit = await query<{ action_details: Record<string, unknown> }>(
      `SELECT action_details FROM audit_logs
        WHERE action = 'directory.local_membership.set_manager' AND resource_id = $1
        ORDER BY id DESC LIMIT 1`,
      [membershipId],
    )
    expect(audit.rows.length).toBe(1)
    // Values-free payload: structured IDs (references) + the boolean operation flag only — no
    // names / emails / raw values ever reach the audit surface.
    expect(audit.rows[0].action_details).toEqual({ accountId: mgrAccountId, departmentId: deptId, isManager: true })

    const setFalse = await request(adminApp).patch(`/api/admin/directory/local/memberships/${membershipId}`).send({ isManager: false })
    expect(setFalse.status).toBe(200)
    expect(setFalse.body.data.membership.isManager).toBe(false)
    expect(await readIsManager(mgrAccountId, deptId)).toBe(false)

    const resolvedOff = await resolveApprovalRequesterOrgRelations(uReq, queryFn)
    expect(resolvedOff.managerId).toBeUndefined()
  })

  it('rejects an UNAUTHENTICATED request (401), no write', async () => {
    const res = await request(noAuthApp).patch(`/api/admin/directory/local/memberships/${membershipId}`).send({ isManager: true })
    expect(res.status).toBe(401)
    expect(await readIsManager(mgrAccountId, deptId)).toBe(false)
  })

  it('rejects a NON-ADMIN authenticated request (403), no write', async () => {
    const res = await request(nonAdminApp).patch(`/api/admin/directory/local/memberships/${membershipId}`).send({ isManager: true })
    expect(res.status).toBe(403)
    expect(await readIsManager(mgrAccountId, deptId)).toBe(false)
  })

  it('rejects a body smuggling org_id/corp_id (400 UNKNOWN_FIELDS), no write', async () => {
    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/memberships/${membershipId}`)
      .send({ isManager: true, org_id: 'attacker-org', corp_id: 'evil-corp' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_UNKNOWN_FIELDS')
    expect(await readIsManager(mgrAccountId, deptId)).toBe(false)
  })

  it.each([
    { name: 'isManager as a string', value: 'true' },
    { name: 'isManager as a number', value: 1 },
    { name: 'isManager as null', value: null },
  ])('rejects $name — 400 INVALID_INPUT, no write', async ({ value }) => {
    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/memberships/${membershipId}`)
      .send({ isManager: value })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
    expect(await readIsManager(mgrAccountId, deptId)).toBe(false)
  })

  it('rejects a COMBINED {isPrimary, isManager} body — 400, and proves NO partial write (m3 target)', async () => {
    const before = (
      await query<{ is_primary: boolean; is_manager: boolean }>(
        `SELECT is_primary, is_manager FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [mgrAccountId, deptId],
      )
    ).rows[0]

    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/memberships/${membershipId}`)
      .send({ isPrimary: true, isManager: true })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')

    const after = (
      await query<{ is_primary: boolean; is_manager: boolean }>(
        `SELECT is_primary, is_manager FROM directory_account_departments WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [mgrAccountId, deptId],
      )
    ).rows[0]
    expect(after).toEqual(before) // neither column moved — the combined request applied nothing
  })

  it('rejects an EMPTY body {} — 400 INVALID_INPUT', async () => {
    const res = await request(adminApp).patch(`/api/admin/directory/local/memberships/${membershipId}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_INVALID_INPUT')
  })

  it('returns 404 for a LOCAL-account × DINGTALK-department membership (writer no-op), is_manager untouched', async () => {
    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/memberships/${localAcctForMalformed}:${dtDeptId}`)
      .send({ isManager: true })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_NOT_FOUND')
    expect(await readIsManager(localAcctForMalformed, dtDeptId)).toBe(false)
  })

  it('returns 404 for an ABSENT membership (random ids)', async () => {
    const res = await request(adminApp)
      .patch(`/api/admin/directory/local/memberships/00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000001`)
      .send({ isManager: true })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_NOT_FOUND')
  })

  // Owner round-3 P2-1: the writer lacked `i.status = 'active'` — an INACTIVE local integration
  // still matched the UPDATE. This flips the SHARED `localInt` row (the only integration the
  // route can ever reach, since `resolveLocalDirectoryOrgId` is hardcoded to 'default') under a
  // try/finally so it is guaranteed back to 'active' for every test after this one, regardless of
  // assertion outcome. A dedicated fresh account+dept keeps the blast radius off `deptId` /
  // `mgrAccountId`. Mutation m-status: dropping `i.status = 'active'` from the writer's UPDATE
  // must redden this test (the `not_found` / 404 assertions below would flip to updated/200).
  it('writer + route refuse an INACTIVE local integration — not_found / 404 / no audit; reactivating restores the write (m-status target)', async () => {
    const dept = await seedDept(localInt, 'local', rid('inact-dept'), 'RouteInactDept')
    extraDeptIds.push(dept)
    const acct = await seedAccount(localInt, 'local', rid('inact-ext'), rid('inact-key'), 'RouteInactAcct', {})
    accountIds.push(acct)
    await membership(acct, dept, false)
    const mid = `${acct}:${dept}`

    await query(`UPDATE directory_integrations SET status = 'inactive' WHERE id = $1`, [localInt])
    try {
      // (a) writer directly: outcome not_found, is_manager unchanged.
      expect(await setLocalMembershipManager('default', { directoryAccountId: acct, directoryDepartmentId: dept }, true)).toEqual({ outcome: 'not_found' })
      expect(await readIsManager(acct, dept)).toBe(false)

      // (b) the route: 404, no audit row.
      const res = await request(adminApp).patch(`/api/admin/directory/local/memberships/${mid}`).send({ isManager: true })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('DIRECTORY_LOCAL_NOT_FOUND')
      const audit = await query(
        `SELECT 1 FROM audit_logs WHERE action = 'directory.local_membership.set_manager' AND resource_id = $1`,
        [mid],
      )
      expect(audit.rows.length).toBe(0)
      expect(await readIsManager(acct, dept)).toBe(false)
    } finally {
      await query(`UPDATE directory_integrations SET status = 'active' WHERE id = $1`, [localInt])
    }

    // (c) positive control: same account/dept, integration reactivated → the writer now applies.
    expect(await setLocalMembershipManager('default', { directoryAccountId: acct, directoryDepartmentId: dept }, true)).toEqual({ outcome: 'updated' })
    expect(await readIsManager(acct, dept)).toBe(true)
  })

  // Owner round-3 P2-2 (predicate 1 of 2): the writer checked `i.provider = 'local'` but never
  // the CHILD rows — a membership whose `directory_accounts.provider` is mislabeled 'dingtalk'
  // under an otherwise-local integration still matched. Flips ONLY the account's provider (never
  // the department's), isolating this test to the `a.provider = 'local'` predicate. Mutation
  // m-aprov: dropping that predicate must redden this test without affecting the department-
  // provider test below.
  it('writer + route refuse an ACCOUNT row mislabeled provider — not_found / 404 / no audit; restoring re-enables the write (m-aprov target)', async () => {
    const dept = await seedDept(localInt, 'local', rid('aprov-dept'), 'RouteAprovDept')
    extraDeptIds.push(dept)
    const acct = await seedAccount(localInt, 'local', rid('aprov-ext'), rid('aprov-key'), 'RouteAprovAcct', {})
    accountIds.push(acct)
    await membership(acct, dept, false)
    const mid = `${acct}:${dept}`

    await query(`UPDATE directory_accounts SET provider = 'dingtalk' WHERE id = $1`, [acct])
    try {
      expect(await setLocalMembershipManager('default', { directoryAccountId: acct, directoryDepartmentId: dept }, true)).toEqual({ outcome: 'not_found' })
      expect(await readIsManager(acct, dept)).toBe(false)

      const res = await request(adminApp).patch(`/api/admin/directory/local/memberships/${mid}`).send({ isManager: true })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('DIRECTORY_LOCAL_NOT_FOUND')
      const audit = await query(
        `SELECT 1 FROM audit_logs WHERE action = 'directory.local_membership.set_manager' AND resource_id = $1`,
        [mid],
      )
      expect(audit.rows.length).toBe(0)
      expect(await readIsManager(acct, dept)).toBe(false)
    } finally {
      await query(`UPDATE directory_accounts SET provider = 'local' WHERE id = $1`, [acct])
    }

    // Positive control: same account/dept, provider restored to 'local' → the writer now applies.
    expect(await setLocalMembershipManager('default', { directoryAccountId: acct, directoryDepartmentId: dept }, true)).toEqual({ outcome: 'updated' })
    expect(await readIsManager(acct, dept)).toBe(true)
  })

  // Owner round-3 P2-2 (predicate 2 of 2): same gap on the DEPARTMENT side — a
  // `directory_departments.provider` mislabeled 'dingtalk' under an otherwise-local integration
  // still matched. Flips ONLY the department's provider (never the account's), isolating this
  // test to the `d.provider = 'local'` predicate. Mutation m-dprov: dropping that predicate must
  // redden THIS test while the account-provider test above stays green — proving the two
  // predicates (and their tests) are independently load-bearing.
  it('writer + route refuse a DEPARTMENT row mislabeled provider — not_found / 404 / no audit; restoring re-enables the write (m-dprov target)', async () => {
    const dept = await seedDept(localInt, 'local', rid('dprov-dept'), 'RouteDprovDept')
    extraDeptIds.push(dept)
    const acct = await seedAccount(localInt, 'local', rid('dprov-ext'), rid('dprov-key'), 'RouteDprovAcct', {})
    accountIds.push(acct)
    await membership(acct, dept, false)
    const mid = `${acct}:${dept}`

    await query(`UPDATE directory_departments SET provider = 'dingtalk' WHERE id = $1`, [dept])
    try {
      expect(await setLocalMembershipManager('default', { directoryAccountId: acct, directoryDepartmentId: dept }, true)).toEqual({ outcome: 'not_found' })
      expect(await readIsManager(acct, dept)).toBe(false)

      const res = await request(adminApp).patch(`/api/admin/directory/local/memberships/${mid}`).send({ isManager: true })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('DIRECTORY_LOCAL_NOT_FOUND')
      const audit = await query(
        `SELECT 1 FROM audit_logs WHERE action = 'directory.local_membership.set_manager' AND resource_id = $1`,
        [mid],
      )
      expect(audit.rows.length).toBe(0)
      expect(await readIsManager(acct, dept)).toBe(false)
    } finally {
      await query(`UPDATE directory_departments SET provider = 'local' WHERE id = $1`, [dept])
    }

    // Positive control: same account/dept, provider restored to 'local' → the writer now applies.
    expect(await setLocalMembershipManager('default', { directoryAccountId: acct, directoryDepartmentId: dept }, true)).toEqual({ outcome: 'updated' })
    expect(await readIsManager(acct, dept)).toBe(true)
  })
})

// =============================================================================================
// PB4-2 — the manager writer is the archived read-only guard (owner design lock §3): it must
// self-contain `a.is_active = true AND d.is_active = true` in its OWN locked transaction and NOT
// rely on any route pre-check. Its discriminated result maps archived → 409 (distinct from
// missing → 404). Proves BOTH: the DIRECT writer classifies archived, and a TWO-CONNECTION barrier
// serializes the write point against a concurrent archive in both linearizations.
// =============================================================================================
describeIfDatabase('PB4-2 — manager writer archived read-only (real DB)', () => {
  const P = Date.now()
  const pid = (s: string): string => `pb42-mgr-${P}-${s}`
  const createdOrgs: string[] = []
  const defaultScopedAccounts: string[] = []
  const defaultScopedDepts: string[] = []

  function appAs(user: unknown): express.Express {
    const app = express()
    app.use(express.json())
    if (user !== undefined) {
      app.use((req, _res, next) => {
        ;(req as express.Request & { user?: unknown }).user = user
        next()
      })
    }
    app.use('/api/admin/directory/local', adminDirectoryLocalRouter())
    return app
  }
  const adminApp = appAs({ id: `pb42-mgr-admin-${P}`, role: 'admin' })

  async function withHolder(fn: (holder: Client) => Promise<void>): Promise<void> {
    const holder = new Client({ connectionString: process.env.DATABASE_URL })
    await holder.connect()
    try {
      await fn(holder)
    } finally {
      await holder.end()
    }
  }
  async function waitForBlockedDirectoryWriter(min = 1): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const r = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%directory_%'`,
      )
      if ((r.rows[0]?.n ?? 0) >= min) return
      await new Promise((res) => setTimeout(res, 20))
    }
    throw new Error('timed out waiting for a blocked directory writer (barrier never engaged)')
  }
  function settled<T>(p: Promise<T>): Promise<unknown> {
    return p.then(
      (v) => v,
      (e) => e,
    )
  }

  async function seedLocalMembership(tag: string): Promise<{ org: string; acct: string; dept: string; membershipId: string }> {
    const org = pid(`${tag}-org`)
    createdOrgs.push(org)
    const local = await getOrCreateLocalIntegration(org)
    const dept = await seedDept(local.id, 'local', pid(`${tag}-dept`), 'MgrDept')
    const acct = await seedAccount(local.id, 'local', pid(`${tag}-ext`), pid(`${tag}-key`), 'MgrAcct', {})
    await membership(acct, dept, false)
    return { org, acct, dept, membershipId: `${acct}:${dept}` }
  }

  afterAll(async () => {
    try {
      for (const acct of defaultScopedAccounts) await query(`DELETE FROM directory_accounts WHERE id = $1`, [acct])
      for (const dept of defaultScopedDepts) await query(`DELETE FROM directory_departments WHERE id = $1`, [dept])
      for (const org of createdOrgs) await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    } catch {
      /* best effort */
    }
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('A. DIRECT writer returns { outcome: "archived" } when the ACCOUNT is archived — is_manager untouched', async () => {
    const { org, acct, dept } = await seedLocalMembership('a-acct')
    await query(`UPDATE directory_accounts SET is_active = false WHERE id = $1`, [acct])

    expect(await setLocalMembershipManager(org, { directoryAccountId: acct, directoryDepartmentId: dept }, true)).toEqual({
      outcome: 'archived',
    })
    expect(await readIsManager(acct, dept)).toBe(false)
  })

  it('A. DIRECT writer returns { outcome: "archived" } when the DEPARTMENT is archived — is_manager untouched', async () => {
    const { org, acct, dept } = await seedLocalMembership('a-dept')
    await query(`UPDATE directory_departments SET is_active = false WHERE id = $1`, [dept])

    expect(await setLocalMembershipManager(org, { directoryAccountId: acct, directoryDepartmentId: dept }, true)).toEqual({
      outcome: 'archived',
    })
    expect(await readIsManager(acct, dept)).toBe(false)
  })

  it('B. barrier (ii) — archive holds the account lock first → the writer sees is_active=false → { outcome: "archived" }, no write', async () => {
    const { org, acct, dept } = await seedLocalMembership('b-ii')

    await withHolder(async (holder) => {
      await holder.query('BEGIN')
      await holder.query(`UPDATE directory_accounts SET is_active = false WHERE id = $1`, [acct])
      const writePromise = setLocalMembershipManager(org, { directoryAccountId: acct, directoryDepartmentId: dept }, true)
      void settled(writePromise)
      await waitForBlockedDirectoryWriter() // the writer is parked behind the holder's account-row lock
      await holder.query('COMMIT')
      expect(await writePromise).toEqual({ outcome: 'archived' })
    })
    expect(await readIsManager(acct, dept)).toBe(false)
  })

  it('B. barrier (i) — a SQL stand-in for the writer holds the locks first → a concurrent archive parks → is_manager set, archive applies after', async () => {
    const { org, acct, dept } = await seedLocalMembership('b-i')

    await withHolder(async (holder) => {
      await holder.query('BEGIN')
      // The writer's stand-in acquires the SAME locks (account before department, fixed order) and
      // sets is_manager — a SQL STAND-IN for setLocalMembershipManager winning the lock (the real
      // service opens+commits its own transaction, so it cannot be held open while the archive runs).
      await holder.query(`SELECT id FROM directory_accounts WHERE id = $1 FOR UPDATE`, [acct])
      await holder.query(`SELECT id FROM directory_departments WHERE id = $1 FOR UPDATE`, [dept])
      await holder.query(
        `UPDATE directory_account_departments SET is_manager = true
          WHERE directory_account_id = $1 AND directory_department_id = $2`,
        [acct, dept],
      )
      const archivePromise = archiveLocalDepartment(org, dept)
      void settled(archivePromise)
      await waitForBlockedDirectoryWriter() // the archive is parked behind the writer's dept-row lock
      await holder.query('COMMIT')
      await archivePromise
    })

    expect(await readIsManager(acct, dept)).toBe(true) // the manager write won
    const drow = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_departments WHERE id = $1`, [dept])
    expect(drow.rows[0].is_active).toBe(false) // archive applied AFTER
  })

  it('C. ROUTE maps an archived membership to 409 (distinct from the 404 for a missing one) — no audit', async () => {
    // The route resolves org 'default' server-side, so this fixture lives in the default local
    // integration; a dedicated account/dept keeps the archive off every other 'default' fixture.
    const local = await getOrCreateLocalIntegration('default')
    const dept = await seedDept(local.id, 'local', pid('route-dept'), 'RouteMgrDept')
    const acct = await seedAccount(local.id, 'local', pid('route-ext'), pid('route-key'), 'RouteMgrAcct', {})
    defaultScopedDepts.push(dept)
    defaultScopedAccounts.push(acct)
    await membership(acct, dept, false)
    const mid = `${acct}:${dept}`
    await query(`UPDATE directory_accounts SET is_active = false WHERE id = $1`, [acct])

    const res = await request(adminApp).patch(`/api/admin/directory/local/memberships/${mid}`).send({ isManager: true })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('DIRECTORY_LOCAL_CONFLICT')
    expect(await readIsManager(acct, dept)).toBe(false)

    const audit = await query(
      `SELECT 1 FROM audit_logs WHERE action = 'directory.local_membership.set_manager' AND resource_id = $1`,
      [mid],
    )
    expect(audit.rows.length).toBe(0)
  })
})
