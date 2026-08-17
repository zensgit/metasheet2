import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-4 OD-L4-10(a) / Lock-6 L6-A gate A-7 (docs/development/approval-lock4-flow-policies-20260817.md
 * §F4-D; docs/development/approval-lock6-requester-global-policy-20260817.md §1 L6-A, §3 A-7) — real-DB,
 * whole-HTTP-stack proof that a RETURN invalidates dedup-relevant history that predates it.
 *
 * The shipped defect (F4-D, verified live on main at this document's baseline): `loadApprovalHistory`
 * applied no epoch/round/return filter, and the `action:'return'` dispatch branch fed that FULL,
 * unfiltered history straight into `applyAutoApprovalCascade`. With `mergeAdjacentApprover` or
 * `dedupeHistoricalApprover` set (settable today only through the publish API — reachable, not dead
 * code) and a graph where the SAME person is re-assigned to a node after a return, the re-entered node
 * silently re-merged against its OWN pre-return approval, nullifying the return with no human in the
 * loop. This is priced into Lock-6 L6-A as a ratified precondition ("Shipping the switch without one is
 * forbidden") because the template-level dedup tier this program ships next projects onto these same two
 * booleans.
 *
 * The fix (this PR, backend-only, no FE / wizard-step change):
 *   (1) `loadApprovalHistory`'s SQL now additionally requires
 *       `to_version >= COALESCE(MAX(to_version) WHERE action='return', 0)` — `to_version` is a
 *       per-instance monotonic counter stamped on every `approval_records` row (manual approves AND
 *       `insertAutoApprovalEvents` rows alike, with no legacy-NULL case), reusing the SAME round-boundary
 *       idea the T2-4 threshold tally's epoch/cutoff machinery already proves out, without a new column
 *       or a new metadata stamp on the return's own audit row.
 *   (2) The RETURN dispatch branch's own synchronous cascade evaluation now seeds `[]` instead of
 *       `await loadApprovalHistory(...)` — mirroring the CREATE cascade's existing `[]` seed — because at
 *       the exact moment a return's own cascade runs, its `action:'return'` row has not committed yet, so
 *       predicate (1) cannot yet see it and would still surface the immediately-preceding pre-return
 *       approval.
 *
 * Each test below proves BOTH dedup arms independently:
 *   - a PRE-return positive control that the arm actually fires via the documented API path;
 *   - the GATE assertion — after a return, the re-entered node stays PENDING (return not nullified);
 *   - a POST-return continuation — a genuine round-2 approval lets the SAME arm fire again correctly,
 *     proving the fix scopes to "since the last return", not "dedup permanently disabled".
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

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

function approvalNode(key: string, assigneeId: string) {
  return {
    key,
    type: 'approval',
    config: { assigneeType: 'user', assigneeIds: [assigneeId], approvalMode: 'single' },
  }
}

// A(P) -> B(P) -> C(Q). mergeAdjacentApprover matches P at B against P's IMMEDIATELY PRECEDING
// approval at A (adjacent in decision order — B and C do not need to be graph-adjacent to A/B).
function buildAdjacentGraph(p: string, q: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      approvalNode('approval_a', p),
      approvalNode('approval_b', p),
      approvalNode('approval_c', q),
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
      { key: 'e-b-c', source: 'approval_b', target: 'approval_c' },
      { key: 'e-c-end', source: 'approval_c', target: 'end' },
    ],
  }
}

// A(P) -> B(Q) -> C(P) -> D(R). dedupeHistoricalApprover matches P at C against ANY earlier approval
// by P (here, A) — B's DIFFERENT actor (Q) breaks graph-adjacency, isolating this from
// mergeAdjacentApprover so the test exercises dedupeHistoricalApprover specifically. D's assignee is a
// THIRD, distinct actor R (not Q) so D does not ALSO spuriously dedupe against B's approval within the
// same cascade that resolves C — D must stay a genuinely pending node to return from.
function buildHistoricalGraph(p: string, q: string, r: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      approvalNode('approval_a', p),
      approvalNode('approval_b', q),
      approvalNode('approval_c', p),
      approvalNode('approval_d', r),
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
      { key: 'e-b-c', source: 'approval_b', target: 'approval_c' },
      { key: 'e-c-d', source: 'approval_c', target: 'approval_d' },
      { key: 'e-d-end', source: 'approval_d', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval dedup round-scoping — a return invalidates pre-return history (Lock-4 OD-L4-10(a), Lock-6 gate A-7)', () => {
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

  async function publishGraphTemplate(adminToken: string, approvalGraph: object, autoApproval: Record<string, boolean>): Promise<string> {
    const templateKey = `dedup-rs-${TS}-${Math.floor(Math.random() * 1e6)}`
    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Dedup Round-Scoping Template',
        description: 'Lock-4 OD-L4-10(a) / Lock-6 gate A-7',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
    expect(templateResponse.status, await templateResponse.clone().text()).toBe(201)
    const template = (await templateResponse.json()) as { id: string }
    createdTemplateIds.add(template.id)

    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true, autoApproval } },
    })
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return template.id
  }

  async function createApproval(requesterToken: string, templateId: string, reason: string): Promise<{
    id: string
    currentNodeKey: string | null
  }> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string; currentNodeKey: string | null }
    createdApprovalIds.add(inst.id)
    return inst
  }

  type ActResult = { status: string; currentNodeKey: string | null }
  function actor(token: string, instanceId: string) {
    return async (body: object): Promise<ActResult> => {
      const response = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, {
        method: 'POST',
        body,
      })
      expect(response.status, await response.clone().text()).toBe(200)
      return (await response.json()) as ActResult
    }
  }

  async function grantWrite(userId: string): Promise<void> {
    grantedUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  it('mergeAdjacentApprover: a return invalidates a stale ADJACENT approval — A stays PENDING (gate A-7)', async () => {
    const p = `dedup-rs-p-${TS}-adj`
    const q = `dedup-rs-q-${TS}-adj`
    const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-adj`)
    const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-adj`)
    await grantWrite(`dedup-rs-req-${TS}-adj`)
    const pTok = await authToken(baseUrl, p)
    const qTok = await authToken(baseUrl, q)

    const templateId = await publishGraphTemplate(adminToken, buildAdjacentGraph(p, q), { mergeAdjacentApprover: true })
    const inst = await createApproval(requesterToken, templateId, 'r')
    expect(inst.currentNodeKey).toBe('approval_a')
    const act = { p: actor(pTok, inst.id), q: actor(qTok, inst.id) }

    // Positive control: P approves A; B (also assigned to P) auto-merges as ADJACENT to A's approval
    // in the SAME dispatch call, skipping straight to C.
    const afterP1 = await act.p({ action: 'approve', comment: 'P r1' })
    expect(afterP1.currentNodeKey).toBe('approval_c')

    // Q (assignee at C) returns to A.
    const afterReturn = await act.q({ action: 'return', targetNodeKey: 'approval_a', comment: 'send back' })

    // GATE: A must stay PENDING, not silently re-merge against B's stale round-1 approval.
    expect(afterReturn.status).toBe('pending')
    expect(afterReturn.currentNodeKey).toBe('approval_a')

    // Continuation: a GENUINE round-2 approval at A lets the SAME adjacent-merge fire again normally.
    const afterP2 = await act.p({ action: 'approve', comment: 'P r2' })
    expect(afterP2.currentNodeKey).toBe('approval_c')
  })

  it('dedupeHistoricalApprover: a return invalidates a stale NON-ADJACENT approval — C stays PENDING (gate A-7)', async () => {
    const p = `dedup-rs-p-${TS}-hist`
    const q = `dedup-rs-q-${TS}-hist`
    const r = `dedup-rs-r-${TS}-hist`
    const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-hist`)
    const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-hist`)
    await grantWrite(`dedup-rs-req-${TS}-hist`)
    const pTok = await authToken(baseUrl, p)
    const qTok = await authToken(baseUrl, q)
    const rTok = await authToken(baseUrl, r)

    const templateId = await publishGraphTemplate(adminToken, buildHistoricalGraph(p, q, r), { dedupeHistoricalApprover: true })
    const inst = await createApproval(requesterToken, templateId, 'r')
    expect(inst.currentNodeKey).toBe('approval_a')
    const act = { p: actor(pTok, inst.id), q: actor(qTok, inst.id), r: actor(rTok, inst.id) }

    // P approves A. B (assigned to Q, a DIFFERENT actor) does not match either dedup arm — stays pending.
    const afterP1 = await act.p({ action: 'approve', comment: 'P r1' })
    expect(afterP1.currentNodeKey).toBe('approval_b')

    // Positive control: Q approves B; C (assigned to P, NOT graph-adjacent to A) auto-dedupes against
    // A's earlier approval by the SAME actor P, skipping straight to D (assigned to R — a third actor
    // who has no history match yet, so D stays genuinely pending rather than cascading further).
    const afterQ1 = await act.q({ action: 'approve', comment: 'Q r1' })
    expect(afterQ1.currentNodeKey).toBe('approval_d')

    // R (assignee at D) returns to C.
    const afterReturn = await act.r({ action: 'return', targetNodeKey: 'approval_c', comment: 'send back' })

    // GATE: C must stay PENDING, not silently re-dedupe against A's stale round-1 approval.
    expect(afterReturn.status).toBe('pending')
    expect(afterReturn.currentNodeKey).toBe('approval_c')

    // Continuation: a GENUINE round-2 approval at C does NOT spuriously carry D past its own dedup
    // check either — round 2 has no R-actor approval yet, so D correctly stays pending on its own.
    const afterP2 = await act.p({ action: 'approve', comment: 'P r2' })
    expect(afterP2.status).toBe('pending')
    expect(afterP2.currentNodeKey).toBe('approval_d')
  })
})
