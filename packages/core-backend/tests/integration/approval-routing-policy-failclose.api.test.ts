import net from 'net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Pool } from 'pg'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { pool, query } from '../../src/db/pg'
import { getOrCreateLocalIntegration, setLocalMembershipManager } from '../../src/directory/directory-sync'
import {
  addLocalMembership,
  createLocalAccount,
  createLocalDepartment,
  switchLocalPrimaryDepartment,
} from '../../src/directory/local-directory-org'
import { grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * B5-b owner P1 — the routing-policy FAIL-CLOSE at approval create + shared preview substrate,
 * real server + real DB.
 *
 * The hazard being closed (owner review): a misconfigured `approval_routing` policy makes the org
 * resolver throw; the create path caught it and proceeded with EMPTY orgRelations; every org-derived
 * assignee source (direct_manager / dept_head / continuous_managers / manager_at_level) then
 * resolved empty; under `emptyAssigneePolicy: 'auto-approve'` the instance was AUTO-APPROVED —
 * a broken policy became a FAIL-OPEN that silently approves approvals.
 *
 * Proof, for EACH of the four org assignee sources (all with the dangerous auto-approve policy):
 *   A. BROKEN POLICY (canonical target disabled) → create rejected **422
 *      APPROVAL_ROUTING_POLICY_MISCONFIGURED**, and — the load-bearing half — **ZERO
 *      approval_instances and ZERO approval_assignments** exist for the template.
 *   B. TRANSIENT org-read failure (test-local vi.spyOn on Pool.query: Reflect.apply-delegates
 *      every overload arg; throws only the routing-policy probe while a scoped boolean is enabled —
 *      no shared-schema DDL, no production hook) → create rejected **503
 *      APPROVAL_REQUESTER_ORG_UNRESOLVED**, zero instances/assignments.
 *   C. POSITIVE CONTROLS (the guard must not over-block):
 *      C1. healthy policy→local + requester HAS a manager → direct_manager creates a genuine
 *          PENDING instance WITH an assignment (the resolvable case works end-to-end);
 *      C2. healthy policy + a requester with NO manager → auto-approve still fires (GENUINE data
 *          absence keeps the pre-existing emptyAssigneePolicy semantic — fail-close is only for
 *          "could not find out", never for "found out: none").
 *
 * Permanent HTTP pins for the SHARED assembleCreationContext substrate — each endpoint is its
 * OWN load-bearing case (so a guard mutation reds B3-05 and B3-06 independently, not only the
 * first sequential assertion):
 *   D1/D2. BROKEN policy → 422 APPROVAL_ROUTING_POLICY_MISCONFIGURED on
 *          POST /api/approvals/preview and POST /api/approval-templates/:id/route-preview
 *          (own fixture each, zero approval instances/assignments).
 *   E1/E2. TRANSIENT org-read failure → 503 APPROVAL_REQUESTER_ORG_UNRESOLVED on the same two
 *          surfaces (own fixture each, zero approval instances/assignments).
 *
 * Load-bearing mutation (out-of-band, recorded in the PR): deleting the create-time
 * `runtimeGraphUsesOrgAssigneeSource` guard turns leg A back into a 2xx auto-approval → A reds;
 * each of D1/D2/E1/E2 also reds independently (they share the same guard).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `b5bfc-req-${TS}` // requester WITH manager (positive control C1) + all fail legs
const REQ_NOMGR = `b5bfc-nomgr-${TS}` // requester with NO manager (positive control C2)

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}
async function tok(base: string, userId: string): Promise<string> {
  await grantApprovalWriteForIntegrationActor(userId)
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

type OrgSourceKind = 'direct_manager' | 'dept_head' | 'continuous_managers' | 'manager_at_level'
function graph(kind: OrgSourceKind) {
  const source =
    kind === 'continuous_managers' ? { kind, levels: 2 } : kind === 'manager_at_level' ? { kind, level: 1 } : { kind }
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      // auto-approve is DELIBERATE: it is the dangerous policy the fail-open exploited
      { key: 'approval_1', type: 'approval', name: 'a', config: { assigneeSources: [source], approvalMode: 'single', emptyAssigneePolicy: 'auto-approve' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'end' },
    ],
  }
}

async function setPolicy(org: string, canonical: string): Promise<void> {
  await query(
    `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
     VALUES ($1, 'approval_routing', $2)
     ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq
     DO UPDATE SET canonical_integration_id = EXCLUDED.canonical_integration_id, updated_at = NOW()`,
    [org, canonical],
  )
}

/** B5-b policy-probe SELECT shape (ApprovalDirectoryOrg step 0). */
function isRoutingPolicyProbeSql(text: unknown): text is string {
  return (
    typeof text === 'string' &&
    text.includes('org_directory_routing_policy') &&
    text.includes('approval_routing')
  )
}

type PreviewEndpoint = {
  id: string
  label: string
  path: (tid: string) => string
  body: (tid: string) => Record<string, unknown>
}

const PREVIEW_ENDPOINTS: PreviewEndpoint[] = [
  {
    id: 'b305',
    label: 'POST /api/approvals/preview (B3-05)',
    path: () => '/api/approvals/preview',
    body: (tid) => ({ templateId: tid, formData: { reason: 'r' } }),
  },
  {
    id: 'b306',
    label: 'POST /api/approval-templates/:id/route-preview (B3-06)',
    path: (tid) => `/api/approval-templates/${tid}/route-preview`,
    body: () => ({ sampleFormData: { reason: 'r' }, sampleRequesterId: REQ }),
  },
]

describeIfDatabase('B5-b owner P1 — routing-policy fail-close at approval create (real server, real DB)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let reqNoMgrTok = ''
  let localIntId = ''
  let dtIntId = ''
  const cleanupUserIds: string[] = []
  const cleanupAccountIds: string[] = []

  /**
   * Test-local vi.spyOn on the SAME pg Pool.query ApprovalProductService binds into
   * `resolveApprovalRequesterOrgRelations` (`import { pool } from '../db/pg'` →
   * poolManager.getInternalPool()). Reflect.apply-forwards every overload argument to the
   * original method; the routing-policy probe throws ONLY while `orgPolicyProbeFaultEnabled`
   * is true. No shared-schema DDL, no production hook. Spy installed in beforeAll; boolean
   * cleared in afterEach; mockRestore in afterAll.
   */
  let orgPolicyProbeFaultEnabled = false
  let orgPolicyProbeFaultFired = 0
  let querySpy: MockInstance | null = null
  const servicePool = pool as Pool | null

  function enableOrgPolicyProbeFault(): void {
    orgPolicyProbeFaultEnabled = true
    orgPolicyProbeFaultFired = 0
  }
  function disableOrgPolicyProbeFault(): void {
    orgPolicyProbeFaultEnabled = false
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    expect(servicePool, 'ApprovalProductService pool must be available for fault injection').toBeTruthy()
    const originalQuery = servicePool!.query
    querySpy = vi.spyOn(servicePool!, 'query').mockImplementation(function (this: Pool, ...args: unknown[]) {
      const text = args[0]
      if (orgPolicyProbeFaultEnabled && isRoutingPolicyProbeSql(text)) {
        orgPolicyProbeFaultFired += 1
        return Promise.reject(new Error('simulated transient org routing-policy read failure'))
      }
      return Reflect.apply(originalQuery, this, args)
    })

    const { ensureApprovalSchemaReady } = await import('../helpers/approval-schema-bootstrap')
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    reqNoMgrTok = await tok(base, REQ_NOMGR)

    // fixtures in 'default' (the org the server resolves): local integration + requester with a
    // real manager (dept membership + is_manager), plus a dingtalk integration to be the broken
    // policy target.
    const MGR = `b5bfc-mgr-${TS}`
    for (const u of [REQ, REQ_NOMGR, MGR]) {
      cleanupUserIds.push(u)
      await query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, 'x') ON CONFLICT (id) DO NOTHING`, [
        u,
        `${u}@example.test`,
        u,
      ])
    }
    const local = await getOrCreateLocalIntegration('default')
    localIntId = local.id
    const dept = await createLocalDepartment({ orgId: 'default', name: `FC Dept ${TS}` })
    const aReq = await createLocalAccount({ orgId: 'default', localUserId: REQ, title: 'FC Requester' })
    const aNo = await createLocalAccount({ orgId: 'default', localUserId: REQ_NOMGR, title: 'FC NoMgr' })
    const aMgr = await createLocalAccount({ orgId: 'default', localUserId: MGR, title: 'FC Manager' })
    cleanupAccountIds.push(aReq.id, aNo.id, aMgr.id)
    await addLocalMembership({ orgId: 'default', accountId: aReq.id, departmentId: dept.id })
    await switchLocalPrimaryDepartment('default', aReq.id, dept.id)
    await addLocalMembership({ orgId: 'default', accountId: aMgr.id, departmentId: dept.id })
    await setLocalMembershipManager('default', { directoryAccountId: aMgr.id, directoryDepartmentId: dept.id }, true)

    const dt = await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ('default', 'dingtalk', $1, 'active', $2, '{}'::jsonb) RETURNING id`,
      [`DT fc ${TS}`, `corp-fc-${TS}`],
    )
    dtIntId = dt.rows[0].id
  })

  afterEach(() => {
    // Safety net: a test must never leave the scoped fault boolean armed.
    disableOrgPolicyProbeFault()
  })

  afterAll(async () => {
    disableOrgPolicyProbeFault()
    // Restore the real Pool.query — the spy must not outlive this suite.
    querySpy?.mockRestore()
    querySpy = null
    try {
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
      const poolClient = poolManager.get()
      const tids = (await poolClient.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`%-${TS}`])).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        const iids = (await poolClient.query(`SELECT id FROM approval_instances WHERE template_id = ANY($1)`, [tids])).rows.map(
          (r) => r.id as string,
        )
        if (iids.length > 0) {
          await poolClient.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await poolClient.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await poolClient.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await poolClient.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1)`, [tids])
        await poolClient.query(`DELETE FROM approval_templates WHERE id = ANY($1)`, [tids])
      }
      for (const id of cleanupAccountIds.splice(0)) await query(`DELETE FROM directory_accounts WHERE id = $1`, [id])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [dtIntId])
      for (const uid of cleanupUserIds.splice(0)) await query(`DELETE FROM users WHERE id = $1`, [uid])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  async function publish(key: string, kind: OrgSourceKind): Promise<string> {
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }, approvalGraph: graph(kind) },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)
    return tid
  }
  async function zeroRows(tid: string): Promise<void> {
    const inst = await query<{ n: number }>(`SELECT count(*)::int AS n FROM approval_instances WHERE template_id = $1`, [tid])
    expect(inst.rows[0].n).toBe(0)
    const asg = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approval_assignments a JOIN approval_instances i ON i.id = a.instance_id WHERE i.template_id = $1`,
      [tid],
    )
    expect(asg.rows[0].n).toBe(0)
  }

  const KINDS: OrgSourceKind[] = ['direct_manager', 'dept_head', 'continuous_managers', 'manager_at_level']

  it('A. BROKEN policy → 422 APPROVAL_ROUTING_POLICY_MISCONFIGURED for ALL FOUR org sources, zero instances, zero assignments', async () => {
    await setPolicy('default', dtIntId)
    await query(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [dtIntId])
    try {
      for (const kind of KINDS) {
        const tid = await publish(`fc-broken-${kind}-${TS}`, kind)
        const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
        const text = await started.clone().text()
        expect(started.status, `${kind}: ${text}`).toBe(422)
        expect(text).toContain('APPROVAL_ROUTING_POLICY_MISCONFIGURED')
        await zeroRows(tid) // the fail-open would have left an auto-approved instance here
      }
    } finally {
      await query(`UPDATE directory_integrations SET status = 'active' WHERE id = $1`, [dtIntId])
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
    }
  })

  it('B. TRANSIENT org-read failure → 503 APPROVAL_REQUESTER_ORG_UNRESOLVED for all four sources, zero instances, zero assignments', async () => {
    // healthy policy in place; arm the scoped Pool.query spy only for the create calls
    // (non-policy Error shape — not a config error). Publish stays on the healthy path.
    await setPolicy('default', localIntId)
    try {
      const tids: Array<{ kind: OrgSourceKind; tid: string }> = []
      for (const kind of KINDS) {
        tids.push({ kind, tid: await publish(`fc-transient-${kind}-${TS}`, kind) })
      }
      enableOrgPolicyProbeFault()
      try {
        for (const { kind, tid } of tids) {
          const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
          const text = await started.clone().text()
          expect(started.status, `${kind}: ${text}`).toBe(503)
          expect(text).toContain('APPROVAL_REQUESTER_ORG_UNRESOLVED')
          await zeroRows(tid)
        }
        // spy must have matched the real probe (guards against silent SQL-shape drift)
        expect(orgPolicyProbeFaultFired).toBeGreaterThan(0)
      } finally {
        disableOrgPolicyProbeFault()
      }
    } finally {
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
    }
  })

  it('C1. positive control: healthy policy→local + resolvable manager → a genuine PENDING instance WITH an assignment', async () => {
    await setPolicy('default', localIntId)
    try {
      const tid = await publish(`fc-ok-${TS}`, 'direct_manager')
      const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
      expect(started.status, await started.clone().text()).toBeLessThan(300)
      const inst = await query<{ id: string; status: string }>(
        `SELECT id, status FROM approval_instances WHERE template_id = $1`,
        [tid],
      )
      expect(inst.rows).toHaveLength(1)
      expect(['pending', 'in_progress', 'running', 'active']).toContain(inst.rows[0].status)
      const asg = await query<{ n: number }>(`SELECT count(*)::int AS n FROM approval_assignments WHERE instance_id = $1`, [
        inst.rows[0].id,
      ])
      expect(asg.rows[0].n).toBeGreaterThan(0) // a REAL live assignment — not auto-approved
    } finally {
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
    }
  })

  it('C2. positive control: healthy policy + requester with NO manager → auto-approve still fires (genuine absence unchanged)', async () => {
    await setPolicy('default', localIntId)
    try {
      const tid = await publish(`fc-nomgr-${TS}`, 'direct_manager')
      const started = await req(base, '/api/approvals', reqNoMgrTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
      expect(started.status, await started.clone().text()).toBeLessThan(300)
      const inst = await query<{ status: string }>(`SELECT status FROM approval_instances WHERE template_id = $1`, [tid])
      expect(inst.rows).toHaveLength(1)
      expect(['approved', 'completed', 'auto_approved']).toContain(inst.rows[0].status)
    } finally {
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
    }
  })

  // Independently load-bearing: each preview endpoint is its own case so a guard mutation reds
  // B3-05 and B3-06 separately (a sequential dual-assert in one test would stop at the first fail).
  it.each(PREVIEW_ENDPOINTS)(
    'D. BROKEN policy → 422 APPROVAL_ROUTING_POLICY_MISCONFIGURED on $label, zero approval instances/assignments',
    async (endpoint) => {
      await setPolicy('default', dtIntId)
      await query(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [dtIntId])
      try {
        const tid = await publish(`fc-prev-broken-${endpoint.id}-${TS}`, 'direct_manager')
        const res = await req(base, endpoint.path(tid), reqTok, {
          method: 'POST',
          body: endpoint.body(tid),
        })
        const text = await res.clone().text()
        expect(res.status, `${endpoint.label}: ${text}`).toBe(422)
        expect(text).toContain('APPROVAL_ROUTING_POLICY_MISCONFIGURED')
        await zeroRows(tid)
      } finally {
        await query(`UPDATE directory_integrations SET status = 'active' WHERE id = $1`, [dtIntId])
        await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
      }
    },
  )

  it.each(PREVIEW_ENDPOINTS)(
    'E. TRANSIENT org-read failure → 503 APPROVAL_REQUESTER_ORG_UNRESOLVED on $label, zero approval instances/assignments',
    async (endpoint) => {
      await setPolicy('default', localIntId)
      try {
        const tid = await publish(`fc-prev-transient-${endpoint.id}-${TS}`, 'direct_manager')
        enableOrgPolicyProbeFault()
        try {
          const res = await req(base, endpoint.path(tid), reqTok, {
            method: 'POST',
            body: endpoint.body(tid),
          })
          const text = await res.clone().text()
          expect(res.status, `${endpoint.label}: ${text}`).toBe(503)
          expect(text).toContain('APPROVAL_REQUESTER_ORG_UNRESOLVED')
          await zeroRows(tid)
          expect(orgPolicyProbeFaultFired).toBeGreaterThan(0)
        } finally {
          disableOrgPolicyProbeFault()
        }
      } finally {
        await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
      }
    },
  )
})
