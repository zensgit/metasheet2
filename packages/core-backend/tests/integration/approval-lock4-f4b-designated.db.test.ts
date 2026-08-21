import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-4 §3 F4-B — designated empty-assignee fallback (审批人为空时 → `emptyAssigneePolicy:
 * 'designated'`), real-DB acceptance (server door + full create/dispatch flow). Source:
 * `docs/development/approval-lock4-flow-policies-20260817.md` (RATIFIED 2026-08-17) OD-L4-3(a),
 * gates B-1, B-2, B-3.
 *
 * FS-3 (2026-08-21): F4-A/F4-C/F4-E each shipped a real-DB acceptance lane; F4-B shipped only
 * `tests/unit/approval-p3a-f4b-designated-fallback{,-normalize}.test.ts` — pure in-process
 * `ApprovalGraphExecutor` construction, never through the real HTTP server + Postgres. This file is
 * that missing lane. DB-INDEPENDENT logic (the resolver dispatch, the pure executor branching,
 * threshold-reachability-on-the-fallback-set) stays covered by the unit suites above — this file
 * proves the SAME behavior fires through the real server door, and covers what genuinely needs a
 * DB: durable `approval_assignments`/`approval_records` rows, the authoring choke over real HTTP
 * (it fires at CREATE — one of its five entry points — not merely publish, confirmed empirically
 * below), and a POST-PUBLISH persisted-graph tamper that only a real stored row can model.
 *
 * ── The two executor sites (C-1 correction, carried from the unit suite) ──
 * `resolveAfterApprove` TAIL-CALLS `resolveFromNode` — same site (SITE 1: covers both initial
 * resolution and after-approve re-entry). The genuinely SECOND site is the private
 * `resolveBranchAdvance`, reachable (for an empty-assignee node) ONLY through a parallel branch's
 * SECOND node, via `resolveAfterApproveInParallel`. The lock's own "at BOTH executor sites (initial
 * resolution and resolveAfterApprove)" wording under-names this; the scout's correction stands, and
 * this file builds the parallel fixture required to reach it for real.
 *
 * ── B-2 disclosure (carried verbatim, real-DB half) ──
 * The lock names THREE zero-assignee cases for the designated fallback — "empty list, deactivated
 * ids, role with no members". Only the FIRST is enforced anywhere in this codebase today: the
 * authoring choke (`validateEmptyAssigneeFallbackConfigs`) rejects an empty/absent fallback at
 * publish, and `resolveDesignatedFallbackAssignments` (`ApprovalGraphExecutor.ts`) independently
 * fails closed if one somehow reaches dispatch anyway. The other two are NOT filtered: `static_user`
 * / `static_role` (`ApprovalAssigneeResolver.ts`, the SAME resolver path the fallback routes
 * through) apply no active-status check and — per that file's own gate-B-2 disclosure comment —
 * NO role-membership expansion at all: a `roleIds` entry is pushed through as a literal assignee id,
 * never queried against real role membership. There is structurally no "role with N members" to
 * exhaust through this path. This file therefore proves the ONE enforced arm (empty/absent), not a
 * general "any invalid designated set fails closed" claim — asserting the latter would be the
 * overclaim `feedback_absolute_claim_sweep_must_be_mechanical.md` warns about.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function buildFormSchema() {
  return { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] }
}

/** SITE 1 fixture: a single empty node, reached at INITIAL resolution (`resolveFromNode`). */
function linearGraph(nodeOverrides: Record<string, unknown> = {}) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'empty-node',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: [], approvalMode: 'single', ...nodeOverrides },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'empty-node' },
      { key: 'e2', source: 'empty-node', target: 'end' },
    ],
  }
}

/** SITE 1 re-entry fixture: a real predecessor node, then the empty node — exercises the
 *  `resolveAfterApprove` tail-call into `resolveFromNode` (still SITE 1, per the C-1 correction). */
function afterApproveGraph(mgrId: string, nodeOverrides: Record<string, unknown> = {}) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'manager-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: [mgrId], approvalMode: 'single' } },
      {
        key: 'empty-node',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: [], approvalMode: 'single', ...nodeOverrides },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'manager-review' },
      { key: 'e2', source: 'manager-review', target: 'empty-node' },
      { key: 'e3', source: 'empty-node', target: 'end' },
    ],
  }
}

/**
 * SITE 2 fixture: a parallel fork whose FIRST branch has TWO nodes — `legal-review` (real
 * assignee) then `legal-review-2` (empty primary source, the fixture's variable policy) — joining
 * `finance-review`. The sibling branch is a single real-assignee node. `legal-review-2` is reached
 * ONLY once `legal-review` is approved (`resolveAfterApproveInParallel` → the private
 * `resolveBranchAdvance` → SITE 2), never at initial resolution (initial resolution only ever
 * activates `legal-review` and `compliance-review` for this graph, mirroring the unit suite's
 * reachability probe).
 */
function parallelSecondNodeGraph(
  ids: { legal: string; compliance: string; finance: string },
  nodeOverrides: Record<string, unknown> = {},
) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'parallel_fork', type: 'parallel', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'finance-review' } },
      { key: 'legal-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: [ids.legal], approvalMode: 'single' } },
      {
        key: 'legal-review-2',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: [], approvalMode: 'single', ...nodeOverrides },
      },
      { key: 'compliance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: [ids.compliance], approvalMode: 'single' } },
      { key: 'finance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: [ids.finance], approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-start-fork', source: 'start', target: 'parallel_fork' },
      { key: 'e-fork-a', source: 'parallel_fork', target: 'legal-review' },
      { key: 'e-fork-b', source: 'parallel_fork', target: 'compliance-review' },
      { key: 'e-legal-legal2', source: 'legal-review', target: 'legal-review-2' },
      { key: 'e-legal2-join', source: 'legal-review-2', target: 'finance-review' },
      { key: 'e-b-join', source: 'compliance-review', target: 'finance-review' },
      { key: 'e-finance-end', source: 'finance-review', target: 'end' },
    ],
  }
}

describeIfDatabase('Lock-4 F4-B — designated empty-assignee fallback: server door + B-1/B-2/legacy real-DB behavior', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const grantedUserIds = new Set<string>()

  const pool = () => poolManager.get()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    try {
      const approvalIds = [...createdApprovalIds]
      const templateIds = [...createdTemplateIds]
      if (approvalIds.length > 0) {
        await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      if (grantedUserIds.size > 0) {
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[...grantedUserIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  async function tryCreateTemplate(adminToken: string, approvalGraph: object, label: string): Promise<Response> {
    const templateKey = `l4-f4b-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    return jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: { key: templateKey, name: 'Lock-4 F4-B', description: 'approval-lock4-flow-policies-20260817', formSchema: buildFormSchema(), approvalGraph },
    })
  }

  async function createTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const response = await tryCreateTemplate(adminToken, approvalGraph, label)
    expect(response.status, await response.clone().text()).toBe(201)
    const template = (await response.json()) as { id: string }
    createdTemplateIds.add(template.id)
    return template.id
  }

  async function tryPublish(adminToken: string, templateId: string): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approval-templates/${templateId}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
  }

  async function publishGraphTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const templateId = await createTemplate(adminToken, approvalGraph, label)
    const publishResponse = await tryPublish(adminToken, templateId)
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return templateId
  }

  async function tryCreateApproval(requesterToken: string, templateId: string): Promise<Response> {
    return jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
  }

  type ApprovalDTO = {
    id: string
    currentNodeKey: string | null
    currentNodeKeys?: string[]
    status: string
    assignments: Array<{ assigneeId: string; nodeKey?: string | null }>
  }

  async function createApproval(requesterToken: string, templateId: string): Promise<ApprovalDTO> {
    const response = await tryCreateApproval(requesterToken, templateId)
    expect(response.status, await response.clone().text()).toBe(201)
    const inst = (await response.json()) as ApprovalDTO
    createdApprovalIds.add(inst.id)
    return inst
  }

  async function act(token: string, instanceId: string, body: object): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, { method: 'POST', body })
  }

  async function grantWrite(userId: string): Promise<void> {
    grantedUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  async function assignmentsFor(instanceId: string, nodeKey: string): Promise<Array<{ assignee_id: string; assignment_type: string; is_active: boolean; metadata: Record<string, unknown> | null }>> {
    const result = await pool().query(
      'SELECT assignee_id, assignment_type, is_active, metadata FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 ORDER BY id ASC',
      [instanceId, nodeKey],
    )
    return result.rows as never
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Gate B-1 SITE 1 (resolveFromNode) — initial resolution
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('B-1 SITE 1 initial resolution: an empty primary source with emptyAssigneePolicy:"designated" dispatches to the designated set, persisted as a real approval_assignments row', async () => {
    const suffix = 's1-initial'
    const adminId = `l4-f4b-admin-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const requesterId = `l4-f4b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graph = linearGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: [adminId] } })
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)

    expect(inst.status).toBe('pending')
    expect(inst.currentNodeKey).toBe('empty-node')
    expect(inst.assignments.map((a) => a.assigneeId)).toEqual([adminId])

    const rows = await assignmentsFor(inst.id, 'empty-node')
    expect(rows).toHaveLength(1)
    expect(rows[0].assignee_id).toBe(adminId)
    expect(rows[0].assignment_type).toBe('user')
    expect(rows[0].is_active).toBe(true)
    // Routed through the SAME resolveApprovalAssignees path as static_user — resolvedFrom.kind
    // proves it, never hand-built inline in the executor.
    expect((rows[0].metadata?.resolvedFrom as Record<string, unknown> | undefined)?.kind).toBe('static_user')
  })

  it('CONTROL for B-1 SITE 1 (Gate 2) — "error" on the IDENTICAL linear fixture still throws APPROVAL_ASSIGNEE_EMPTY, at create', async () => {
    const suffix = 's1-initial-ctl'
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const requesterId = `l4-f4b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graph = linearGraph({ emptyAssigneePolicy: 'error' })
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const response = await tryCreateApproval(requesterToken, templateId)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; details?: { nodeKey?: string } } }
    expect(body.error.code).toBe('APPROVAL_ASSIGNEE_EMPTY')
    expect(body.error.details?.nodeKey).toBe('empty-node')
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Gate B-1 SITE 1 — re-entry via resolveAfterApprove (still site 1, per the C-1 correction)
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('B-1 SITE 1 re-entry (resolveAfterApprove tail-calls resolveFromNode): a genuine prior approval dispatches into the designated ROLE fallback', async () => {
    const suffix = 's1-reentry'
    const mgrId = `l4-f4b-mgr-${TS}-${suffix}`
    const mgrToken = await authToken(baseUrl, mgrId)
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const requesterId = `l4-f4b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graph = afterApproveGraph(mgrId, { emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { roleIds: ['approval-admin'] } })
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.currentNodeKey).toBe('manager-review')

    const advance = await act(mgrToken, inst.id, { action: 'approve' })
    expect(advance.status, await advance.clone().text()).toBe(200)
    const advanceBody = (await advance.json()) as { status: string; currentNodeKey: string | null }
    expect(advanceBody.status).toBe('pending')
    expect(advanceBody.currentNodeKey).toBe('empty-node')

    const rows = await assignmentsFor(inst.id, 'empty-node')
    expect(rows).toHaveLength(1)
    expect(rows[0].assignee_id).toBe('approval-admin')
    expect(rows[0].assignment_type).toBe('role')
    expect(rows[0].is_active).toBe(true)
  })

  it('CONTROL for the re-entry fixture (Gate 2) — "error" 400s the APPROVE action itself, and the predecessor\'s assignment is rolled back untouched (never a wedge)', async () => {
    const suffix = 's1-reentry-ctl'
    const mgrId = `l4-f4b-mgr-${TS}-${suffix}`
    const mgrToken = await authToken(baseUrl, mgrId)
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const requesterId = `l4-f4b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graph = afterApproveGraph(mgrId, { emptyAssigneePolicy: 'error' })
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)

    const before = await assignmentsFor(inst.id, 'manager-review')
    expect(before.map((r) => r.is_active)).toEqual([true])

    const advance = await act(mgrToken, inst.id, { action: 'approve' })
    expect(advance.status).toBe(400)
    const body = (await advance.json()) as { error: { code: string } }
    expect(body.error.code).toBe('APPROVAL_ASSIGNEE_EMPTY')

    // Rollback proof: the manager's assignment (deactivated inside the same transaction that then
    // threw) is restored active — the failed advance left NO trace, not a half-applied state.
    const after = await assignmentsFor(inst.id, 'manager-review')
    expect(after.map((r) => r.is_active)).toEqual([true])
    expect(await assignmentsFor(inst.id, 'empty-node')).toEqual([])
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Gate B-1 SITE 2 (resolveBranchAdvance via resolveAfterApproveInParallel) + B-3 mutation anchor
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('B-1 SITE 2: designated dispatches inside a parallel branch\'s SECOND node, reached only after the first is genuinely approved — flow completes to approved with no wedge', async () => {
    const suffix = 's2'
    const legalId = `l4-f4b-legal-${TS}-${suffix}`
    const complianceId = `l4-f4b-compliance-${TS}-${suffix}`
    const financeId = `l4-f4b-finance-${TS}-${suffix}`
    const adminFallbackId = `l4-f4b-admin-${TS}-${suffix}`
    const legalToken = await authToken(baseUrl, legalId)
    const complianceToken = await authToken(baseUrl, complianceId)
    const financeToken = await authToken(baseUrl, financeId)
    const adminFallbackToken = await authToken(baseUrl, adminFallbackId)
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const requesterId = `l4-f4b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graph = parallelSecondNodeGraph(
      { legal: legalId, compliance: complianceId, finance: financeId },
      { emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: [adminFallbackId] } },
    )
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.status).toBe('pending')
    expect([...(inst.currentNodeKeys ?? [])].sort()).toEqual(['compliance-review', 'legal-review'])

    // legal-review-2 does not exist yet — SITE 2 has not fired.
    expect(await assignmentsFor(inst.id, 'legal-review-2')).toEqual([])

    const advance = await act(legalToken, inst.id, { action: 'approve' })
    expect(advance.status, await advance.clone().text()).toBe(200)
    const advanceBody = (await advance.json()) as { status: string; currentNodeKeys?: string[] }
    expect(advanceBody.status).toBe('pending')
    // The sibling branch (compliance-review) is untouched; only legal-review's OWN branch
    // advanced, into legal-review-2 — the designated fallback dispatch.
    expect([...(advanceBody.currentNodeKeys ?? [])].sort()).toEqual(['compliance-review', 'legal-review-2'])

    const rows = await assignmentsFor(inst.id, 'legal-review-2')
    expect(rows).toHaveLength(1)
    expect(rows[0].assignee_id).toBe(adminFallbackId)
    expect(rows[0].assignment_type).toBe('user')
    expect(rows[0].is_active).toBe(true)

    // Completion proof: no wedge. Finish both branches and the join.
    const complianceApprove = await act(complianceToken, inst.id, { action: 'approve' })
    expect(complianceApprove.status, await complianceApprove.clone().text()).toBe(200)
    const legal2Approve = await act(adminFallbackToken, inst.id, { action: 'approve' })
    expect(legal2Approve.status, await legal2Approve.clone().text()).toBe(200)
    const legal2Body = (await legal2Approve.json()) as { status: string; currentNodeKey: string | null }
    expect(legal2Body.status).toBe('pending')
    expect(legal2Body.currentNodeKey).toBe('finance-review')
    const financeApprove = await act(financeToken, inst.id, { action: 'approve' })
    expect(financeApprove.status, await financeApprove.clone().text()).toBe(200)
    expect(((await financeApprove.json()) as { status: string }).status).toBe('approved')
  })

  it('CONTROL for SITE 2 (Gate 2) — "error" on the IDENTICAL parallel fixture 400s the approve action, and legal-review\'s assignment rolls back untouched', async () => {
    const suffix = 's2-ctl'
    const legalId = `l4-f4b-legal-${TS}-${suffix}`
    const complianceId = `l4-f4b-compliance-${TS}-${suffix}`
    const financeId = `l4-f4b-finance-${TS}-${suffix}`
    const legalToken = await authToken(baseUrl, legalId)
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const requesterId = `l4-f4b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graph = parallelSecondNodeGraph(
      { legal: legalId, compliance: complianceId, finance: financeId },
      { emptyAssigneePolicy: 'error' },
    )
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)

    const advance = await act(legalToken, inst.id, { action: 'approve' })
    expect(advance.status).toBe(400)
    const body = (await advance.json()) as { error: { code: string; details?: { nodeKey?: string } } }
    expect(body.error.code).toBe('APPROVAL_ASSIGNEE_EMPTY')
    expect(body.error.details?.nodeKey).toBe('legal-review-2')

    const legalRows = await assignmentsFor(inst.id, 'legal-review')
    expect(legalRows.map((r) => r.is_active)).toEqual([true])
    expect(await assignmentsFor(inst.id, 'legal-review-2')).toEqual([])
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Gate B-2 / Gate 3 — exhausted/invalid designated set fails closed, real HTTP + DB
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('Gate 3 authoring choke: "designated" with an ABSENT emptyAssigneeFallback is REJECTED at the authoring choke — fires at CREATE (validateEmptyAssigneeFallbackConfigs runs at all five authoring entry points, not merely publish), never reaches dispatch', async () => {
    const suffix = 'choke-absent'
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const graph = linearGraph({ emptyAssigneePolicy: 'designated' })
    const response = await tryCreateTemplate(adminToken, graph, suffix)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('APPROVAL_EMPTY_ASSIGNEE_FALLBACK_REQUIRED')
  })

  it('Gate 3 authoring choke: "designated" with an EXPLICITLY EMPTY fallback ({userIds:[],roleIds:[]}) is ALSO rejected at CREATE — collapses to absent before the choke, same code', async () => {
    const suffix = 'choke-empty-arrays'
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const graph = linearGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: [], roleIds: [] } })
    const response = await tryCreateTemplate(adminToken, graph, suffix)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('APPROVAL_EMPTY_ASSIGNEE_FALLBACK_REQUIRED')
  })

  it('POSITIVE CONTROL for the authoring choke — "designated" WITH a non-empty fallback publishes fine (200)', async () => {
    const suffix = 'choke-ctl'
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const graph = linearGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: [`l4-f4b-admin-${TS}-${suffix}`] } })
    const templateId = await createTemplate(adminToken, graph, suffix)
    const response = await tryPublish(adminToken, templateId)
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it('Gate 3 authoring choke, reverse: emptyAssigneeFallback present while policy is NOT "designated" is a REJECTED dangling key, at CREATE', async () => {
    const suffix = 'choke-dangling'
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const graph = linearGraph({ emptyAssigneePolicy: 'error', emptyAssigneeFallback: { userIds: [`l4-f4b-admin-${TS}-${suffix}`] } })
    const response = await tryCreateTemplate(adminToken, graph, suffix)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('APPROVAL_EMPTY_ASSIGNEE_FALLBACK_NOT_ALLOWED')
  })

  // Mutation-coverage note: this test is DELIBERATELY insensitive to the B-3 site-1 mutation
  // (neutering resolveFromNode's `emptyAssigneePolicy === 'designated'` arm) — the tampered graph
  // below has its `emptyAssigneeFallback` key stripped entirely, so `resolveDesignatedFallbackAssignments`
  // returns `[]` on either side of that mutation and the terminal throw fires either way. It IS
  // sensitive to `resolveDesignatedFallbackAssignments`'s own fail-closed return (verified: mutating
  // that arm to dispatch a fake assignee instead of `[]` reds this test, restored via sha256).
  it(
    'Gate 3 dispatch-time fail-closed on a PERSISTED-BUT-INVALID graph (bypassing the authoring choke — models a legacy row from before this choke shipped, or a direct DB write): ' +
      'designated resolving to an EMPTY set terminates at APPROVAL_ASSIGNEE_EMPTY with { nodeKey } only, never a silent nobody, never a second fallback hop, and creates NOTHING in the DB',
    async () => {
      const suffix = 'tamper'
      const adminFallbackId = `l4-f4b-admin-${TS}-${suffix}`
      const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
      const requesterId = `l4-f4b-req-${TS}-${suffix}`
      const requesterToken = await authToken(baseUrl, requesterId)
      await grantWrite(requesterId)

      // Publish a VALID designated graph through the real authoring API (never hand-craft
      // runtime_graph — that is how this test would rot as the normalized shape evolves).
      const graph = linearGraph({ emptyAssigneePolicy: 'designated', emptyAssigneeFallback: { userIds: [adminFallbackId] } })
      const templateId = await publishGraphTemplate(adminToken, graph, suffix)

      const before = await pool().query<{ id: string; runtime_graph: { nodes: Array<{ key: string; config: Record<string, unknown> }> } }>(
        'SELECT id, runtime_graph FROM approval_published_definitions WHERE template_id = $1::uuid AND is_active = TRUE',
        [templateId],
      )
      expect(before.rows).toHaveLength(1)
      const publishedId = before.rows[0].id
      const runtimeGraph = before.rows[0].runtime_graph
      const emptyNode = runtimeGraph.nodes.find((n) => n.key === 'empty-node')
      expect(emptyNode).toBeTruthy()
      expect(emptyNode!.config.emptyAssigneeFallback).toBeTruthy()
      // Surgical tamper: strip ONLY the fallback key, leaving `emptyAssigneePolicy: 'designated'`
      // in place — exactly the shape `asRuntimeGraph`'s own doc comment names as deliberately
      // un-re-validated on load/dispatch ("an already-published, already-dispatching instance's
      // graph [must not] throw on its NEXT read if the rule ever tightened").
      delete emptyNode!.config.emptyAssigneeFallback
      await pool().query('UPDATE approval_published_definitions SET runtime_graph = $2::jsonb WHERE id = $1::uuid', [
        publishedId,
        JSON.stringify(runtimeGraph),
      ])

      const response = await tryCreateApproval(requesterToken, templateId)
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string; message: string; details?: { nodeKey?: string } } }
      expect(body.error.code).toBe('APPROVAL_ASSIGNEE_EMPTY')
      expect(body.error.details).toEqual({ nodeKey: 'empty-node' })
      // X-4 values-free: no id (the fallback's or anyone else's) leaks into the error payload.
      expect(JSON.stringify(body.error)).not.toContain(adminFallbackId)

      // Never a silent nobody, never a second hop: the create is atomic and pre-transactional
      // (`executor.resolveInitialState()` runs BEFORE `BEGIN`) — assert the DB agrees nothing was
      // written, not merely that the HTTP call 400'd.
      const instanceCount = await pool().query('SELECT count(*)::int AS n FROM approval_instances WHERE template_id = $1::uuid', [templateId])
      expect(instanceCount.rows[0].n).toBe(0)
      const assignmentCount = await pool().query('SELECT count(*)::int AS n FROM approval_assignments WHERE assignee_id = $1', [adminFallbackId])
      expect(assignmentCount.rows[0].n).toBe(0)
    },
  )

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // Gate 4 — legacy graphs (the key entirely absent) are byte-identical to today's explicit default
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('Gate 4: a node with NO emptyAssigneePolicy key at all produces a response BYTE-IDENTICAL (deep-equal) to the same graph with emptyAssigneePolicy:"error" explicit', async () => {
    const suffix = 'legacy'
    const adminToken = await authToken(baseUrl, `l4-f4b-tpladmin-${TS}-${suffix}`)
    const requesterId = `l4-f4b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graphAbsent = linearGraph()
    const templateAbsent = await publishGraphTemplate(adminToken, graphAbsent, 'legacy-absent')
    const responseAbsent = await tryCreateApproval(requesterToken, templateAbsent)
    expect(responseAbsent.status).toBe(400)
    const bodyAbsent = (await responseAbsent.json()) as { error: unknown }

    const graphExplicit = linearGraph({ emptyAssigneePolicy: 'error' })
    const templateExplicit = await publishGraphTemplate(adminToken, graphExplicit, 'legacy-explicit')
    const responseExplicit = await tryCreateApproval(requesterToken, templateExplicit)
    expect(responseExplicit.status).toBe(400)
    const bodyExplicit = (await responseExplicit.json()) as { error: unknown }

    // A create-time 400 persists nothing (pre-`BEGIN` throw) — no per-instance field (request
    // number, timestamp, id) exists to normalize away, so this deep-equal is a TRUE byte-for-byte
    // comparison of the full error payload, not one weakened to pass.
    expect(bodyAbsent).toEqual(bodyExplicit)
    expect((bodyAbsent as { error: { code: string } }).error.code).toBe('APPROVAL_ASSIGNEE_EMPTY')
  })
})
