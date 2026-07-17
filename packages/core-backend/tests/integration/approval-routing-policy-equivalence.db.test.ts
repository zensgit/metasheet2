import net from 'net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration, setLocalMembershipManager } from '../../src/directory/directory-sync'
import {
  addLocalMembership,
  createLocalAccount,
  createLocalDepartment,
  switchLocalPrimaryDepartment,
} from '../../src/directory/local-directory-org'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'

/**
 * Canonical Org MVP — B6 (approval-routing local/DingTalk REAL-DB EQUIVALENCE), §10.1 + design
 * lock §2. The FIRST (and only) consumer migrated in this milestone is approval routing; this file
 * is its parity + in-flight-invariance proof:
 *
 * MATRIX (resolver-level, dedicated org):
 *   1. SOURCE CHECK (the vacuity killer): with SENTINEL titles that differ per side, policy→local
 *      resolves the local sentinel and policy→dingtalk the dingtalk sentinel — proving the policy
 *      switch genuinely switches sources (if B5-b's restriction broke, THIS reds first; without it
 *      the equivalence leg below could pass vacuously with both legs reading one source).
 *   2. EQUIVALENCE: with seeded-EQUIVALENT data (same dept name, same title, same manager person —
 *      local via the B3 first-class `is_manager`, DingTalk via legacy `raw.leader_in_dept`),
 *      policy→local and policy→dingtalk produce IDENTICAL requester department/title/manager
 *      (§10.1's exact triple).
 *   3. KNOWN GAP PINNED (ledger §2 routing 加固批): deptHead still resolves from the LEGACY
 *      per-provider source — local side undefined, DingTalk side the manager. Asserted explicitly
 *      so the asymmetry is a visible, tracked fact, not a silent surprise. (Manager CHAIN likewise
 *      stays legacy; not exercised here — includeManagerChain is not opted into.)
 *
 * IN-FLIGHT INVARIANCE (instance-level, real server + real createApproval, org 'default'):
 *   4. An approval created under policy→dingtalk bakes `requester_snapshot.directoryTitle` from
 *      the DingTalk source; FLIPPING the policy to local afterwards leaves that stored snapshot
 *      BYTE-IDENTICAL (jsonb::text compared pre/post) — in-flight approvals keep baked routing;
 *      historical instances are not rewritten. A NEW approval created after the flip bakes the
 *      LOCAL title — the positive control proving the flip really changed new resolutions (so the
 *      first instance's constancy is meaningful, not "nothing changed anywhere").
 *
 * Proof-slice vacuity discipline: this ticket adds NO production code, so the load-bearing
 * mutation runs against the CONSUMED B5-b predicate — neutering the policy-scoped
 * `AND a.integration_id = $2::uuid` restriction with a PARAM-PRESERVING no-op (e.g.
 * `AND ($2::uuid IS NOT NULL OR a.integration_id = $2::uuid)`) reds the sentinel leg with the
 * exact source-collapse signature (`expected 'DT-SENTINEL' to be 'LOCAL-SENTINEL'`) — a literal
 * deletion also reds but only via a PG param-count error, which proves less (gate P3-3).
 * On the in-flight leg: the byte-identical re-read is a RESIDUE PIN (today no code path rewrites
 * snapshots, so it is structurally stable); the LOAD-BEARING invariance evidence is the positive
 * control — instance #2 differing proves the flip changed new resolutions while #1 stayed frozen
 * (gate P3-1, stated honestly).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const MATRIX_ORG = `b6-eq-${TS}`

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}
async function tok(base: string, userId: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
  return ((await res.json()) as { token: string }).token
}
async function req(base: string, path: string, token: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

async function seedUser(id: string): Promise<void> {
  await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x') ON CONFLICT (id) DO NOTHING`, [
    id,
    `${id}@example.test`,
    id,
  ])
}
async function dingtalkIntegration(org: string, tag: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
    [org, `DT b6 ${tag} ${TS}`, `corp-b6-${TS}-${tag}`],
  )
  return r.rows[0].id
}
async function dtDept(integrationId: string, extId: string, name: string, raw: unknown = {}): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
     VALUES ($1, 'dingtalk', $2, $3, true, $4::jsonb) RETURNING id`,
    [integrationId, extId, name, JSON.stringify(raw ?? {})],
  )
  return r.rows[0].id
}
async function dtAccount(
  integrationId: string,
  userId: string,
  title: string | null,
  raw: unknown,
  primaryDeptId?: string,
): Promise<string> {
  const acc = await query<{ id: string }>(
    `INSERT INTO directory_accounts (integration_id, provider, external_user_id, external_key, name, title, is_active, raw)
     VALUES ($1, 'dingtalk', $2, $2, $3, $4, true, $5::jsonb) RETURNING id`,
    [integrationId, `dt:b6:${TS}:${userId}:${integrationId.slice(0, 8)}`, userId, title, JSON.stringify(raw ?? {})],
  )
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
     VALUES ($1, $2, 'linked', 'manual')`,
    [acc.rows[0].id, userId],
  )
  if (primaryDeptId) {
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true)`,
      [acc.rows[0].id, primaryDeptId],
    )
  }
  return acc.rows[0].id
}
async function setPolicy(org: string, canonical: string | null): Promise<void> {
  if (canonical === null) {
    await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = 'approval_routing'`, [org])
    return
  }
  await query(
    `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
     VALUES ($1, 'approval_routing', $2)
     ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq
     DO UPDATE SET canonical_integration_id = EXCLUDED.canonical_integration_id, updated_at = NOW()`,
    [org, canonical],
  )
}

describeIfDatabase('Canonical Org MVP — B6 approval-routing local/DingTalk equivalence (real DB)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  const REQ = `b6-req-${TS}`
  let reqTok = ''
  const cleanupOrgs: string[] = [MATRIX_ORG]
  const cleanupUsers: string[] = []
  const cleanupAccountIds: string[] = []
  const cleanupIntegrationIds: string[] = []

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    const { ensureApprovalSchemaReady } = await import('../helpers/approval-schema-bootstrap')
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
  })

  afterAll(async () => {
    try {
      // gate P3-2: the 'default' routing policy is the single most cross-suite-dangerous residue —
      // delete it FIRST so a throw later in this block can never leak it into serially-later suites.
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = ANY($1)`, [['default', ...cleanupOrgs]])
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`%-${TS}`])).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        const iids = (await pool.query(`SELECT id FROM approval_instances WHERE template_id = ANY($1)`, [tids])).rows.map(
          (r) => r.id as string,
        )
        if (iids.length > 0) {
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1)`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1)`, [tids])
      }
      for (const id of cleanupAccountIds.splice(0)) await query(`DELETE FROM directory_accounts WHERE id = $1`, [id])
      for (const id of cleanupIntegrationIds.splice(0)) await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
      for (const org of cleanupOrgs.splice(0)) await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
      for (const uid of cleanupUsers.splice(0)) await query(`DELETE FROM users WHERE id = $1`, [uid])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('matrix: source check (sentinels), then seeded-equivalent local vs DingTalk resolve the IDENTICAL dept/title/manager triple; the deptHead legacy asymmetry stays pinned', async () => {
    const org = MATRIX_ORG
    const requester = `b6-eq-req-${TS}`
    const manager = `b6-eq-mgr-${TS}`
    cleanupUsers.push(requester, manager)
    await seedUser(requester)
    await seedUser(manager)

    // ---- local side (B1/B2/B3 writers — the product path, not raw SQL) ----
    const local = await getOrCreateLocalIntegration(org)
    const lDept = await createLocalDepartment({ orgId: org, name: 'Engineering' })
    const lReq = await createLocalAccount({ orgId: org, localUserId: requester, title: 'LOCAL-SENTINEL' })
    const lMgr = await createLocalAccount({ orgId: org, localUserId: manager, title: 'Manager' })
    await addLocalMembership({ orgId: org, accountId: lReq.id, departmentId: lDept.id })
    await switchLocalPrimaryDepartment(org, lReq.id, lDept.id)
    await addLocalMembership({ orgId: org, accountId: lMgr.id, departmentId: lDept.id })
    await setLocalMembershipManager(org, { directoryAccountId: lMgr.id, directoryDepartmentId: lDept.id }, true)

    // ---- DingTalk side (provider-shaped rows: manager via legacy raw.leader_in_dept) ----
    const dt = await dingtalkIntegration(org, 'matrix')
    const DT_DEPT_EXT = `b6dept-${TS}`
    const MGR_EXT = `dt:b6:${TS}:${manager}:` // dtAccount() builds external ids with this prefix + integration slice
    const dDept = await dtDept(dt, DT_DEPT_EXT, 'Engineering', { dept_manager_userid_list: [`${MGR_EXT}${dt.slice(0, 8)}`] })
    await dtAccount(dt, requester, 'DT-SENTINEL', { dept_ids: [DT_DEPT_EXT] }, dDept)
    await dtAccount(dt, manager, 'Manager', { leader_in_dept: [{ dept_id: DT_DEPT_EXT, leader: true }] }, dDept)

    // 1) SOURCE CHECK — the policy switch must genuinely switch sources (vacuity killer)
    await setPolicy(org, local.id)
    const viaLocalSentinel = await resolveApprovalRequesterOrgRelations(requester, query)
    expect(viaLocalSentinel.primaryTitle).toBe('LOCAL-SENTINEL')
    await setPolicy(org, dt)
    const viaDtSentinel = await resolveApprovalRequesterOrgRelations(requester, query)
    expect(viaDtSentinel.primaryTitle).toBe('DT-SENTINEL')

    // 2) EQUIVALENCE — align the titles, then the §10.1 triple must be IDENTICAL across sources
    await query(`UPDATE directory_accounts SET title = 'Engineer' WHERE title IN ('LOCAL-SENTINEL','DT-SENTINEL')`)
    await setPolicy(org, local.id)
    const viaLocal = await resolveApprovalRequesterOrgRelations(requester, query)
    await setPolicy(org, dt)
    const viaDt = await resolveApprovalRequesterOrgRelations(requester, query)

    const triple = (r: typeof viaLocal) => ({
      department: r.primaryDepartmentName ?? null,
      title: r.primaryTitle ?? null,
      managerId: r.managerId ?? null,
    })
    expect(triple(viaLocal)).toEqual({ department: 'Engineering', title: 'Engineer', managerId: manager })
    expect(triple(viaDt)).toEqual(triple(viaLocal)) // the §10.1 parity claim, both ways seeded equivalent

    // 3) KNOWN GAP (ledger §2): deptHead still comes from the LEGACY per-provider source — pinned,
    //    not hidden. When this asymmetry is closed (routing 加固批), THIS assertion should flip.
    expect(viaLocal.deptHeadId).toBeUndefined()
    expect(viaDt.deptHeadId).toBe(manager)
  })

  it('in-flight invariance: a policy flip leaves an existing instance requester_snapshot byte-identical; a new instance follows the new policy', async () => {
    // fixtures in 'default' — the org the approval routes resolve for the dev-token requester
    cleanupUsers.push(REQ)
    await seedUser(REQ)
    const local = await getOrCreateLocalIntegration('default')
    const lAcc = await createLocalAccount({ orgId: 'default', localUserId: REQ, title: 'Local Title' })
    const dt = await dingtalkIntegration('default', 'inflight')
    cleanupIntegrationIds.push(dt)
    const dAcc = await dtAccount(dt, REQ, 'DingTalk Title', {})
    cleanupAccountIds.push(lAcc.id, dAcc)

    await setPolicy('default', dt)

    // publish a minimal auto-approve template (no department/title routing → no create-time wedge)
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'approval_1', type: 'approval', name: 'mgr', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'auto-approve' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key: `b6-inflight-${TS}`, name: 'b6', formSchema: { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }, approvalGraph: graph },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)

    const start = async (): Promise<string> => {
      const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
      expect(started.status, await started.clone().text()).toBeLessThan(300)
      const body = (await started.json()) as { id?: string; data?: { id: string } }
      return (body.id ?? body.data?.id) as string
    }
    const snapshotOf = async (aid: string): Promise<{ text: string; title: string | null }> => {
      const r = await query<{ snap: string; title: string | null }>(
        `SELECT requester_snapshot::text AS snap, requester_snapshot->>'directoryTitle' AS title FROM approval_instances WHERE id = $1`,
        [aid],
      )
      return { text: r.rows[0].snap, title: r.rows[0].title }
    }

    // #1 under policy→dingtalk: bakes the DingTalk title
    const a1 = await start()
    const before = await snapshotOf(a1)
    expect(before.title).toBe('DingTalk Title')

    // FLIP the policy — in-flight #1 must stay byte-identical
    await setPolicy('default', local.id)
    const after = await snapshotOf(a1)
    expect(after.text).toBe(before.text) // stored jsonb unchanged, byte-for-byte

    // #2 after the flip: bakes the LOCAL title — the positive control (the flip changed NEW resolutions)
    const a2 = await start()
    const second = await snapshotOf(a2)
    expect(second.title).toBe('Local Title')
  })
})
