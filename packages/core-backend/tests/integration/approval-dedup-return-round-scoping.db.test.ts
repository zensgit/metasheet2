import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { getApprovalMetricsService } from '../../src/services/ApprovalMetricsService'

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

  it('mergeAdjacentApprover: a SECOND return re-floors independently — the floor tracks the LATEST return, not the first', async () => {
    // Directly exercises the crux of the `to_version` mechanism: `MAX(to_version) WHERE
    // action='return'` must advance to the SECOND return's to_version, not stay pinned to the
    // first. Between the two returns this drives TWO non-return, to_version-bumping writes — a
    // MANUAL approve (P at A) and an AUTO-approval-event insert (B's adjacent auto-merge, written
    // by `insertAutoApprovalEvents`) — proving those ordinary writes never disturb the
    // `action='return'`-filtered floor query (it is orthogonal to which OTHER action types
    // occurred in between; it only ever inspects rows tagged `action='return'`).
    const p = `dedup-rs-p-${TS}-2x`
    const q = `dedup-rs-q-${TS}-2x`
    const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-2x`)
    const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-2x`)
    await grantWrite(`dedup-rs-req-${TS}-2x`)
    const pTok = await authToken(baseUrl, p)
    const qTok = await authToken(baseUrl, q)

    const templateId = await publishGraphTemplate(adminToken, buildAdjacentGraph(p, q), { mergeAdjacentApprover: true })
    const inst = await createApproval(requesterToken, templateId, 'r')
    expect(inst.currentNodeKey).toBe('approval_a')
    const act = { p: actor(pTok, inst.id), q: actor(qTok, inst.id) }

    // Round 1: P approves A; B auto-merges (adjacent) -> C.
    const afterP1 = await act.p({ action: 'approve', comment: 'P r1' })
    expect(afterP1.currentNodeKey).toBe('approval_c')

    // RETURN #1 (floor becomes this return's to_version).
    const afterReturn1 = await act.q({ action: 'return', targetNodeKey: 'approval_a', comment: 'send back 1' })
    expect(afterReturn1.status).toBe('pending')
    expect(afterReturn1.currentNodeKey).toBe('approval_a')

    // Round 2, between the two returns: a MANUAL approve (P at A) plus the AUTO-approval-event
    // insert it triggers (B's adjacent auto-merge) — both non-return, both bump to_version.
    const afterP2 = await act.p({ action: 'approve', comment: 'P r2' })
    expect(afterP2.currentNodeKey).toBe('approval_c')

    // RETURN #2. The floor must now be return #2's to_version — HIGHER than return #1's — so
    // round 2's stale B-approval (and everything from round 1) is excluded all over again.
    const afterReturn2 = await act.q({ action: 'return', targetNodeKey: 'approval_a', comment: 'send back 2' })
    expect(afterReturn2.status).toBe('pending')
    expect(afterReturn2.currentNodeKey).toBe('approval_a')

    // Round 3: dedup fires normally yet again, proving the mechanism is not a one-shot fix that
    // only tolerates a single return.
    const afterP3 = await act.p({ action: 'approve', comment: 'P r3' })
    expect(afterP3.currentNodeKey).toBe('approval_c')
  })

  // Adversarial-gate P2-1 (PR #4965 review): every test above returns TO the node whose OWN
  // dedup evaluation the assertion checks, so that evaluation runs through the RETURN call site's
  // `[]` seed — NOT the durable `to_version` floor in `loadApprovalHistory`. Reverting ONLY the
  // floor (keeping the `[]` seed) therefore left all three prior tests green: they never exercised
  // the floor at all. This test isolates the floor specifically: the return targets an EARLIER
  // node (B), so the node under test (C) is re-reached via a NORMAL forward advance in round 2 —
  // through `loadApprovalHistory`, the floor-guarded path — not through the return's own seed.
  it('ISOLATED floor proof: a return to an EARLIER node still round-scopes a node reached later via ordinary forward advance', async () => {
    const p = `dedup-rs-p-${TS}-iso`
    const q = `dedup-rs-q-${TS}-iso`
    const r = `dedup-rs-r-${TS}-iso`
    const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-iso`)
    const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-iso`)
    await grantWrite(`dedup-rs-req-${TS}-iso`)
    const pTok = await authToken(baseUrl, p)
    const qTok = await authToken(baseUrl, q)
    const rTok = await authToken(baseUrl, r)

    const templateId = await publishGraphTemplate(adminToken, buildHistoricalGraph(p, q, r), { dedupeHistoricalApprover: true })
    const inst = await createApproval(requesterToken, templateId, 'r')
    expect(inst.currentNodeKey).toBe('approval_a')
    const act = { p: actor(pTok, inst.id), q: actor(qTok, inst.id), r: actor(rTok, inst.id) }

    // Round 1: P approves A; B (Q) has no match; Q approves B; C (P) auto-dedupes against A ->
    // advances to D (R, no match, stays pending). Positive control that the mechanism fires at all.
    await act.p({ action: 'approve', comment: 'P r1' })
    const afterQ1 = await act.q({ action: 'approve', comment: 'Q r1' })
    expect(afterQ1.currentNodeKey).toBe('approval_d')

    // R (at D) returns to B — EARLIER than C, the node whose evaluation this test isolates. B's
    // OWN re-entry (protected by the `[]` seed, already covered elsewhere) is not the assertion
    // here; only a light sanity check.
    const afterReturn = await act.r({ action: 'return', targetNodeKey: 'approval_b', comment: 'send back to B' })
    expect(afterReturn.status).toBe('pending')
    expect(afterReturn.currentNodeKey).toBe('approval_b')

    // Round 2: Q approves B (a GENUINE, non-seeded dispatch call). C activates and its dedupe
    // check runs through `loadApprovalHistory` — the FLOOR-guarded path. A_round1:P predates the
    // return and must be excluded; round 2 has recorded no P-actor approval yet, so C must stay
    // PENDING. Without the floor (P2-1's isolated mutation), C would wrongly re-dedupe against the
    // stale A_round1:P entry and leak forward to D.
    const afterQ2 = await act.q({ action: 'approve', comment: 'Q r2' })
    expect(afterQ2.status).toBe('pending')
    expect(afterQ2.currentNodeKey).toBe('approval_c')
  })

  // Adversarial-gate P2-2 (PR #4965 review, live-reproduced): `applyNodeTimeoutEffect`'s jump
  // effect reaches its target through the SAME `resolveReturnToNode` resolver a manual return
  // uses, but stamped `action:'jump'`. A BACKWARD jump (target already visited) is exactly as
  // nullifying as an unfloored manual return if the floor only recognizes `action='return'`. A
  // FORWARD jump (skipping ahead) is legitimate progress — matching admin jump's structurally
  // forward-only design (`isReachableDownstream`) — and must NOT re-floor.
  describe('timeout-jump direction-aware re-entry (Lock-4 OD-L4-10(a) corrected boundary: backward re-entry, not literal return)', () => {
    async function forceDeadlineOverdue(instanceId: string, effect: string): Promise<void> {
      let prev = ''
      let stable = 0
      for (let attempt = 0; attempt < 60 && stable < 3; attempt++) {
        const row = await pool().query<{ current_node_deadline_at: unknown; current_node_timeout_effect: string | null }>(
          `SELECT current_node_deadline_at, current_node_timeout_effect FROM approval_metrics WHERE instance_id = $1`,
          [instanceId],
        )
        const sig = `${row.rows[0]?.current_node_timeout_effect ?? 'null'}|${row.rows[0]?.current_node_deadline_at ? 'set' : 'null'}`
        stable = sig === prev ? stable + 1 : 0
        prev = sig
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(stable).toBeGreaterThanOrEqual(3)
      const updated = await pool().query(
        `UPDATE approval_metrics
           SET current_node_deadline_at = now() - INTERVAL '1 minute',
               current_node_timeout_effect = $2
         WHERE instance_id = $1
         RETURNING instance_id`,
        [instanceId, effect],
      )
      expect(updated.rows).toHaveLength(1)
    }

    function buildBackwardJumpGraph(p: string, q: string) {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          approvalNode('approval_a', p),
          approvalNode('approval_b', p),
          {
            key: 'approval_c',
            type: 'approval',
            config: {
              assigneeType: 'user',
              assigneeIds: [q],
              approvalMode: 'single',
              timeout: { afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'approval_a' },
            },
          },
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

    it('GATE: a BACKWARD timeout-jump does NOT nullify — the re-entered node stays PENDING, not silently re-merged against stale history', async () => {
      const p = `dedup-rs-p-${TS}-bwjump`
      const q = `dedup-rs-q-${TS}-bwjump`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-bwjump`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-bwjump`)
      await grantWrite(`dedup-rs-req-${TS}-bwjump`)
      const pTok = await authToken(baseUrl, p)

      const templateId = await publishGraphTemplate(adminToken, buildBackwardJumpGraph(p, q), { mergeAdjacentApprover: true })
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_a')
      const act = { p: actor(pTok, inst.id) }

      // Positive control: P approves A; B (also P) auto-merges as adjacent -> C.
      const afterP1 = await act.p({ action: 'approve', comment: 'P r1' })
      expect(afterP1.currentNodeKey).toBe('approval_c')

      // C's timeout fires and jumps BACKWARD to A (already visited).
      await forceDeadlineOverdue(inst.id, 'jump')
      const service = new ApprovalProductService()
      const outcome = await service.applyNodeTimeoutEffect(inst.id, 'jump')
      expect(outcome).toBe('applied')

      const afterJump = await pool().query<{ status: string; current_node_key: string | null }>(
        `SELECT status, current_node_key FROM approval_instances WHERE id = $1`,
        [inst.id],
      )
      // GATE: A must stay PENDING, not silently re-merge against B's stale round-1 approval.
      expect(afterJump.rows[0]?.status).toBe('pending')
      expect(afterJump.rows[0]?.current_node_key).toBe('approval_a')

      // The jump row is stamped for the floor to key on.
      const jumpRecord = await pool().query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'jump' ORDER BY created_at DESC LIMIT 1`,
        [inst.id],
      )
      expect(jumpRecord.rows[0]?.metadata?.backwardReentry).toBe(true)

      // Continuation: a genuine round-2 approval at A lets the same adjacent-merge fire again.
      const afterP2 = await act.p({ action: 'approve', comment: 'P r2' })
      expect(afterP2.currentNodeKey).toBe('approval_c')
    })

    // ISOLATED floor-CONSUMPTION proof for the backward-jump OR-branch (adversarial-gate P2-A on
    // PR #4965, second round). The GATE test above only exercises (a) the jump's OWN synchronous
    // cascade via the `[]` seed (immediate pending) and (b) the marker WRITE
    // (`metadata.backwardReentry===true`) — it never exercises the floor SQL's CONSUMPTION of that
    // marker to round-scope a LATER node reached via ordinary forward advance. This is the exact
    // backward-jump analog of the return-floor's own ISOLATED test above: the jump targets an
    // EARLIER node (B) than the one under test (C), so C's dedupe check runs through
    // `loadApprovalHistory` — the floor-guarded path — not through the jump's own `[]` seed.
    //
    // A(P) -> B(Q) -> C(P) -> D(R, timeout: BACKWARD jump to B). Round 1: P approves A; B has no
    // match; Q approves B; C auto-dedupes against A (historical) -> D (no match, pending, timeout
    // armed). D's timeout jumps BACKWARD to B. Round 2: Q approves B (a GENUINE, non-seeded
    // dispatch). C activates and its dedupe check must exclude A_round1:P (predates the backward
    // jump) via the floor's `action='jump' AND backwardReentry` OR-branch — WITH the fix, C stays
    // PENDING; with that OR-branch removed, C wrongly re-dedupes against the stale entry and leaks
    // forward to D.
    function buildBackwardJumpFloorConsumptionGraph(p: string, q: string, r: string) {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          approvalNode('approval_a', p),
          approvalNode('approval_b', q),
          approvalNode('approval_c', p),
          {
            key: 'approval_d',
            type: 'approval',
            config: {
              assigneeType: 'user',
              assigneeIds: [r],
              approvalMode: 'single',
              timeout: { afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'approval_b' },
            },
          },
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

    it('ISOLATED floor-CONSUMPTION proof: a backward jump to an EARLIER node still round-scopes a node reached later via ordinary forward advance', async () => {
      const p = `dedup-rs-p-${TS}-bwjumpiso`
      const q = `dedup-rs-q-${TS}-bwjumpiso`
      const r = `dedup-rs-r-${TS}-bwjumpiso`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-bwjumpiso`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-bwjumpiso`)
      await grantWrite(`dedup-rs-req-${TS}-bwjumpiso`)
      const pTok = await authToken(baseUrl, p)
      const qTok = await authToken(baseUrl, q)

      const templateId = await publishGraphTemplate(adminToken, buildBackwardJumpFloorConsumptionGraph(p, q, r), { dedupeHistoricalApprover: true })
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_a')
      const act = { p: actor(pTok, inst.id), q: actor(qTok, inst.id) }

      // Round 1: P approves A; B (Q) has no match; Q approves B; C (P) auto-dedupes against A ->
      // advances to D (R, no match, stays pending). Positive control that the mechanism fires.
      await act.p({ action: 'approve', comment: 'P r1' })
      const afterQ1 = await act.q({ action: 'approve', comment: 'Q r1' })
      expect(afterQ1.currentNodeKey).toBe('approval_d')

      // D's timeout fires and jumps BACKWARD to B (already visited) — EARLIER than C, the node
      // whose evaluation this test isolates.
      await forceDeadlineOverdue(inst.id, 'jump')
      const service = new ApprovalProductService()
      const outcome = await service.applyNodeTimeoutEffect(inst.id, 'jump')
      expect(outcome).toBe('applied')
      const afterJump = await pool().query<{ status: string; current_node_key: string | null }>(
        `SELECT status, current_node_key FROM approval_instances WHERE id = $1`,
        [inst.id],
      )
      // B's OWN re-entry (protected by the jump's `[]` seed, already covered by the GATE test
      // above) is not the assertion here; only a light sanity check.
      expect(afterJump.rows[0]?.status).toBe('pending')
      expect(afterJump.rows[0]?.current_node_key).toBe('approval_b')

      // Round 2: Q approves B (a GENUINE, non-seeded dispatch call). C activates and its dedupe
      // check runs through `loadApprovalHistory` — the FLOOR-guarded path, keyed on the
      // `action='jump' AND backwardReentry` OR-branch this time (not `action='return'`).
      // A_round1:P predates the backward jump and must be excluded; round 2 has recorded no
      // P-actor approval yet, so C must stay PENDING. With that OR-branch removed, C would wrongly
      // re-dedupe against the stale A_round1:P entry and leak forward to D.
      const afterQ2 = await act.q({ action: 'approve', comment: 'Q r2' })
      expect(afterQ2.status).toBe('pending')
      expect(afterQ2.currentNodeKey).toBe('approval_c')
    })

    // A(P) -> B(X, timeout: FORWARD jump to D, skipping C) -> C(Y) -> D(P) -> E(Z). P approves A
    // (creating the only history entry) and B — NOT A — is left the genuinely active/pending node
    // whose own timeout fires, so `applyNodeTimeoutEffect` re-validates against B's OWN config
    // (matching `instance.current_node_key` at fire time) rather than skipping stale. D auto-dedupes
    // against A (composing across the forward jump) and advances to E — pending, not terminal, so
    // this test does not depend on the separately-gated QS-b terminal-cascade flag.
    function buildForwardJumpGraph(p: string, x: string, y: string, z: string) {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          approvalNode('approval_a', p),
          {
            key: 'approval_b',
            type: 'approval',
            config: {
              assigneeType: 'user',
              assigneeIds: [x],
              approvalMode: 'single',
              timeout: { afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'approval_d' },
            },
          },
          approvalNode('approval_c', y),
          approvalNode('approval_d', p),
          approvalNode('approval_e', z),
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
          { key: 'e-b-c', source: 'approval_b', target: 'approval_c' },
          { key: 'e-c-d', source: 'approval_c', target: 'approval_d' },
          { key: 'e-d-e', source: 'approval_d', target: 'approval_e' },
          { key: 'e-e-end', source: 'approval_e', target: 'end' },
        ],
      }
    }

    it('POSITIVE CONTROL: a FORWARD timeout-jump is legitimate progress and still composes — it does NOT re-floor', async () => {
      const p = `dedup-rs-p-${TS}-fwjump`
      const x = `dedup-rs-x-${TS}-fwjump`
      const y = `dedup-rs-y-${TS}-fwjump`
      const z = `dedup-rs-z-${TS}-fwjump`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-fwjump`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-fwjump`)
      await grantWrite(`dedup-rs-req-${TS}-fwjump`)
      const pTok = await authToken(baseUrl, p)

      const templateId = await publishGraphTemplate(adminToken, buildForwardJumpGraph(p, x, y, z), { dedupeHistoricalApprover: true })
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_a')
      const act = { p: actor(pTok, inst.id) }

      // P approves A (the ONLY history entry) -> B activates (assignee X, no match) and is left the
      // genuinely PENDING current node. B's OWN timeout jumps FORWARD to D, skipping C.
      const afterP1 = await act.p({ action: 'approve', comment: 'P r1' })
      expect(afterP1.currentNodeKey).toBe('approval_b')
      await forceDeadlineOverdue(inst.id, 'jump')
      const service = new ApprovalProductService()
      const outcome = await service.applyNodeTimeoutEffect(inst.id, 'jump')
      expect(outcome).toBe('applied')

      // The jump row is NOT stamped backward.
      const jumpRecord = await pool().query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'jump' ORDER BY created_at DESC LIMIT 1`,
        [inst.id],
      )
      expect(jumpRecord.rows[0]?.metadata?.backwardReentry).toBeUndefined()

      // D's assignee is the SAME P who approved A — dedupeHistoricalApprover composes across the
      // forward jump exactly as the pre-existing "compose after the jump" behavior promises: D
      // auto-dedupes immediately (skipping straight to E, pending). A floored/blocked forward jump
      // would instead leave D pending — the discriminating difference from the backward case above.
      const afterJump = await pool().query<{ status: string; current_node_key: string | null }>(
        `SELECT status, current_node_key FROM approval_instances WHERE id = $1`,
        [inst.id],
      )
      expect(afterJump.rows[0]?.status).toBe('pending')
      expect(afterJump.rows[0]?.current_node_key).toBe('approval_e')
    })
    // ────────────────────────────────────────────────────────────────────────────────────────────
    // H-1 — "approval node timeout effect vs the async metrics activation write".
    //
    // The node-activation deadline stamp (`ApprovalMetricsService.recordNodeActivation`, the deadline
    // UPDATE) arms `approval_metrics.current_node_deadline_at` / `current_node_timeout_effect`. Those
    // two columns are NOT observability-only: they are the SLA scanner's armed state, and
    // `applyNodeTimeoutEffect` re-reads them `FOR UPDATE` as its scan→fire race guard
    // (`ApprovalProductService.applyNodeTimeoutEffect`, the
    // `!armed || Number.isNaN(deadlineMs) || deadlineMs > Date.now() || ... !== scannedEffect` branch).
    //
    // Pre-fix that stamp was dispatched fire-and-forget (`safeMetricsCall`, `Promise.resolve().then(fn)`
    // with no await), so it could still be IN FLIGHT when the action response was already observed and
    // could land AFTER a later writer had moved those columns — silently overwriting newer state with
    // `activatedAt + afterMinutes` (always a FUTURE instant) or with NULL. The observable symptom is
    // `applyNodeTimeoutEffect` returning 'skipped_stale' against a row that was correctly armed overdue.
    //
    // The fix is producer-side await-settle: `emitNodeActivationMetric` now returns a promise (which
    // ALWAYS resolves — failures are still logged and swallowed) and every post-commit call site awaits
    // it. Both tests below pin that with a DETERMINISTIC interleaving — no timing sweep, no sleep tuning:
    // the activation stamp is gated behind a fixed delay and the test decides exactly when it lands.
    const H1_LATE_STAMP_MS = 1200

    type ActivationInput = Parameters<ReturnType<typeof getApprovalMetricsService>['recordNodeActivation']>[0]

    /**
     * Delay the FIRST `recordNodeActivation` deadline stamp for (instanceId, nodeKey) by `delayMs`,
     * and expose `landed` — a promise that resolves once that stamp has actually committed.
     *
     * Installed as an OWN property on the shared metrics singleton (the same object every
     * `new ApprovalProductService()` captures through its default constructor argument), so it reaches
     * the real HTTP action path; `restore()` deletes the own property, putting the prototype method back.
     * No production test hook, no env switch.
     */
    function installLateActivationStamp(instanceId: string, nodeKey: string, delayMs: number): {
      landed: Promise<void>
      restore: () => void
    } {
      const metrics = getApprovalMetricsService()
      const original = metrics.recordNodeActivation.bind(metrics)
      let resolveLanded: () => void = () => {}
      const landed = new Promise<void>((resolve) => {
        resolveLanded = resolve
      })
      let intercepted = false
      Object.defineProperty(metrics, 'recordNodeActivation', {
        configurable: true,
        writable: true,
        value: async (input: ActivationInput): Promise<void> => {
          if (intercepted || input.instanceId !== instanceId || input.nodeKey !== nodeKey) {
            return original(input)
          }
          intercepted = true
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          await original(input)
          resolveLanded()
        },
      })
      return {
        landed,
        restore: () => {
          delete (metrics as unknown as Record<string, unknown>).recordNodeActivation
        },
      }
    }

    /** Never hang the suite on `landed` if the stamp is lost — surface it as a failed assertion instead. */
    async function landedWithin(landed: Promise<void>, ms: number): Promise<boolean> {
      return await Promise.race([
        landed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ])
    }

    it('H-1 DISCRIMINATOR: the node-activation deadline stamp is DURABLE before the action response returns', async () => {
      const p = `dedup-rs-p-${TS}-h1dur`
      const q = `dedup-rs-q-${TS}-h1dur`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-h1dur`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-h1dur`)
      await grantWrite(`dedup-rs-req-${TS}-h1dur`)
      const pTok = await authToken(baseUrl, p)

      const templateId = await publishGraphTemplate(adminToken, buildBackwardJumpGraph(p, q), { mergeAdjacentApprover: true })
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_a')
      const act = { p: actor(pTok, inst.id) }

      const hook = installLateActivationStamp(inst.id, 'approval_c', H1_LATE_STAMP_MS)
      try {
        // P approves A; B (also P) auto-merges as adjacent -> C, whose node config carries
        // `timeout: { afterMinutes: 1, effect: 'jump', ... }`. The activation stamp for C is gated
        // behind H1_LATE_STAMP_MS, so it can only have landed if the request AWAITED it.
        const afterP1 = await act.p({ action: 'approve', comment: 'P r1' })
        expect(afterP1.currentNodeKey).toBe('approval_c')

        // Read the armed row with NO polling, NO sleep and NO retry: this is the discriminating
        // observation. Pre-fix the request returns immediately and both columns are still NULL here
        // (the stamp is in flight); post-fix the request cannot return until the stamp is durable.
        const armed = await pool().query<{ current_node_deadline_at: unknown; current_node_timeout_effect: string | null }>(
          `SELECT current_node_deadline_at, current_node_timeout_effect FROM approval_metrics WHERE instance_id = $1`,
          [inst.id],
        )
        expect(
          armed.rows[0]?.current_node_timeout_effect,
          'the activating node\'s timeout effect must be durable by the time the action response returns',
        ).toBe('jump')
        expect(
          armed.rows[0]?.current_node_deadline_at,
          'the activating node\'s deadline must be durable by the time the action response returns',
        ).not.toBeNull()

        // Positive control for the harness itself: the interception really fired (otherwise the two
        // assertions above would pass vacuously on a stamp that was never delayed at all).
        expect(await landedWithin(hook.landed, 15000), 'the intercepted activation stamp must have run').toBe(true)
      } finally {
        hook.restore()
        await landedWithin(hook.landed, 15000)
      }
    })

    it('H-1 GATE: a LATE activation re-stamp does NOT overwrite an already-overdue armed state — the timeout effect still applies', async () => {
      const p = `dedup-rs-p-${TS}-h1race`
      const q = `dedup-rs-q-${TS}-h1race`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-h1race`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-h1race`)
      await grantWrite(`dedup-rs-req-${TS}-h1race`)
      const pTok = await authToken(baseUrl, p)

      const templateId = await publishGraphTemplate(adminToken, buildBackwardJumpGraph(p, q), { mergeAdjacentApprover: true })
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_a')
      const act = { p: actor(pTok, inst.id) }

      const hook = installLateActivationStamp(inst.id, 'approval_c', H1_LATE_STAMP_MS)
      try {
        const afterP1 = await act.p({ action: 'approve', comment: 'P r1' })
        expect(afterP1.currentNodeKey).toBe('approval_c')

        // Force C's deadline overdue. `forceDeadlineOverdue`'s stability poll exits after ~200ms —
        // well inside H1_LATE_STAMP_MS — so pre-fix it exits on the "not armed yet" signature and its
        // forced UPDATE is written while the activation stamp is STILL IN FLIGHT.
        await forceDeadlineOverdue(inst.id, 'jump')

        // Pull the activation stamp to ground BEFORE the timeout effect reads the armed row. This
        // reproduces the CI interleaving deterministically (report §4.2 T2 < T4 < T5): pre-fix the
        // late stamp lands here and rewrites the deadline to `activatedAt + 60s` (a FUTURE instant),
        // so the guard's `deadlineMs > Date.now()` disjunct is true and the effect is skipped.
        // Post-fix the stamp landed inside the action request above, so this is already resolved and
        // nothing writes those columns between the forced UPDATE and the guard's read.
        expect(await landedWithin(hook.landed, 15000), 'the intercepted activation stamp must have run').toBe(true)

        const service = new ApprovalProductService()
        const outcome = await service.applyNodeTimeoutEffect(inst.id, 'jump')
        expect(
          outcome,
          'a late activation re-stamp must not be able to overwrite the armed overdue state and make the timeout effect skip as stale',
        ).toBe('applied')

        // And the effect really took: the backward jump landed on A, still pending.
        const afterJump = await pool().query<{ status: string; current_node_key: string | null }>(
          `SELECT status, current_node_key FROM approval_instances WHERE id = $1`,
          [inst.id],
        )
        expect(afterJump.rows[0]?.status).toBe('pending')
        expect(afterJump.rows[0]?.current_node_key).toBe('approval_a')
      } finally {
        hook.restore()
        await landedWithin(hook.landed, 15000)
      }
    })

    // ──────────────────────────────────────────────────────────────────────────────────────────
    // H-1 round 2 — SAME-NODE re-activation, and per-call-site coverage of every awaited hook.
    //
    // Round 1 awaited the activation stamp but dispatched it INLINE (`await fn()`), so on a path that
    // emits the decision close first and the activation second, the activation's own transaction
    // reached the shared `approval_metrics` row BEFORE the close had even been invoked. When the
    // resolution lands back on the node that was just decided, that order is not merely different, it
    // is WRONG: `recordNodeActivation` finds the node's breakdown entry still open, treats the call as
    // a re-emit (`added=false`) and SKIPS its deadline UPDATE; the close then lands, closes the entry,
    // and its scope guard (`approval_instances.current_node_key = $2`) is satisfied — the instance
    // really is still at that node — so it NULLs both deadline columns. The node is live again with no
    // SLA armed and no breakdown entry for the re-activation.
    //
    // Measured on this machine with a same-node probe (n=30 each, one-off DB, PG 15.17, Node v25.9.0):
    // baseline `cd42eaf74` 27 re-armed / 3 lost; round-1 head `ad0a5a75` 8 / 22; microtask trampoline
    // alone 19 / 11; trampoline + AWAITED close 30 / 0 (single interleaving). Restoring the dispatch
    // order is therefore not sufficient — the two transactions still race their `SELECT … FOR UPDATE`.
    // The fix awaits the close on the two paths that can re-activate the node they just decided.
    const H1_LATE_CLOSE_MS = 600

    type DecisionInput = Parameters<ReturnType<typeof getApprovalMetricsService>['recordNodeDecision']>[0]

    /**
     * Mirror of `installLateActivationStamp` for the DECISION close: delay the first
     * `recordNodeDecision(instanceId, nodeKey)` by `delayMs`, exposing `landed` for the moment it
     * commits. Widening the close's window is what turns the interleaving from a race into a fact:
     * with the close dispatched-but-unawaited, the activation ALWAYS wins and the loss is
     * deterministic; with the close awaited, the activation cannot start until it has committed.
     */
    function installLateDecisionClose(instanceId: string, nodeKey: string, delayMs: number): {
      landed: Promise<void>
      restore: () => void
    } {
      const metrics = getApprovalMetricsService()
      const original = metrics.recordNodeDecision.bind(metrics)
      let resolveLanded: () => void = () => {}
      const landed = new Promise<void>((resolve) => {
        resolveLanded = resolve
      })
      let intercepted = false
      Object.defineProperty(metrics, 'recordNodeDecision', {
        configurable: true,
        writable: true,
        value: async (input: DecisionInput): Promise<void> => {
          if (intercepted || input.instanceId !== instanceId || input.nodeKey !== nodeKey) {
            return original(input)
          }
          intercepted = true
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          await original(input)
          resolveLanded()
        },
      })
      return {
        landed,
        restore: () => {
          delete (metrics as unknown as Record<string, unknown>).recordNodeDecision
        },
      }
    }

    async function readMetrics(instanceId: string): Promise<{
      effect: string | null
      deadlineSet: boolean
      breakdownLength: number
      currentNodeKey: string | null
    }> {
      const result = await pool().query<{
        current_node_deadline_at: unknown
        current_node_timeout_effect: string | null
        node_breakdown: unknown
        current_node_key: string | null
      }>(
        `SELECT m.current_node_deadline_at, m.current_node_timeout_effect, m.node_breakdown, i.current_node_key
           FROM approval_metrics m
           JOIN approval_instances i ON i.id = m.instance_id
          WHERE m.instance_id = $1`,
        [instanceId],
      )
      const row = result.rows[0]
      return {
        effect: row?.current_node_timeout_effect ?? null,
        deadlineSet: row?.current_node_deadline_at !== null && row?.current_node_deadline_at !== undefined,
        breakdownLength: Array.isArray(row?.node_breakdown) ? (row.node_breakdown as unknown[]).length : -1,
        currentNodeKey: row?.current_node_key ?? null,
      }
    }

    // start → A(auto_approve, no assignee) → C(Q, timeout jump BACK to A) → end.
    // A is skipped by `approvalType:'auto_approve'` independently of history, so BOTH a timeout jump
    // to A and a return to A resolve straight back to C — i.e. `resolution.currentNodeKey` equals the
    // node that was just decided. This is the shape that loses the arm.
    function buildSameNodeReentryGraph(q: string) {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'approval_a', type: 'approval', config: { approvalType: 'auto_approve' } },
          {
            key: 'approval_c',
            type: 'approval',
            config: {
              assigneeType: 'user',
              assigneeIds: [q],
              approvalMode: 'single',
              timeout: { afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'approval_a' },
            },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-c', source: 'approval_a', target: 'approval_c' },
          { key: 'e-c-end', source: 'approval_c', target: 'end' },
        ],
      }
    }

    it('H-1 P1-1 GATE (timeout jump): a jump that resolves back to the SAME node re-arms its deadline and keeps its breakdown entry', async () => {
      const q = `dedup-rs-q-${TS}-h1same`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-h1same`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-h1same`)
      await grantWrite(`dedup-rs-req-${TS}-h1same`)

      const templateId = await publishGraphTemplate(adminToken, buildSameNodeReentryGraph(q), {})
      const inst = await createApproval(requesterToken, templateId, 'r')
      // A auto-approves during creation, so the instance starts parked on C with C's timeout armed
      // by `recordInstanceStart`.
      expect(inst.currentNodeKey).toBe('approval_c')
      await forceDeadlineOverdue(inst.id, 'jump')

      // Delay ONLY the close of the node that is about to time out. Pre-fix the close is dispatched
      // and never waited on, so the re-activation stamp runs first against a still-open entry.
      const hook = installLateDecisionClose(inst.id, 'approval_c', H1_LATE_CLOSE_MS)
      try {
        const service = new ApprovalProductService()
        const outcome = await service.applyNodeTimeoutEffect(inst.id, 'jump')
        expect(outcome).toBe('applied')

        // Observable landing point, not a sleep: read only once the close has actually committed, so
        // this cannot pass by reading the pre-close snapshot.
        expect(await landedWithin(hook.landed, 15000), 'the intercepted decision close must have run').toBe(true)

        const after = await readMetrics(inst.id)
        expect(after.currentNodeKey, 'the jump target auto-approves, so the instance lands back on C').toBe('approval_c')
        expect(
          after.effect,
          're-activating the SAME node must re-arm its timeout effect, not leave it cleared by the decision close',
        ).toBe('jump')
        expect(
          after.deadlineSet,
          're-activating the SAME node must re-arm its deadline, not leave it cleared by the decision close',
        ).toBe(true)
        expect(
          after.breakdownLength,
          'the re-activation must append its own node_breakdown entry (the closed round-1 entry plus a fresh open one)',
        ).toBe(2)
      } finally {
        hook.restore()
        await landedWithin(hook.landed, 15000)
      }
    }, 60000)

    it('H-1 P1-1 GATE (return branch): a return that resolves back to the SAME node re-arms its deadline and keeps its breakdown entry', async () => {
      const q = `dedup-rs-q-${TS}-h1sameret`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-h1sameret`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-h1sameret`)
      await grantWrite(`dedup-rs-req-${TS}-h1sameret`)
      const qTok = await authToken(baseUrl, q)

      const templateId = await publishGraphTemplate(adminToken, buildSameNodeReentryGraph(q), {})
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_c')

      // Same shape as the jump gate above, through `dispatchAction`'s `return` branch instead: the
      // return target auto-approves, so the resolution lands back on the node the return was issued
      // from. This is the second call site whose close is awaited.
      const hook = installLateDecisionClose(inst.id, 'approval_c', H1_LATE_CLOSE_MS)
      try {
        const afterReturn = await actor(qTok, inst.id)({ action: 'return', targetNodeKey: 'approval_a', comment: 'send back' })
        expect(afterReturn.status).toBe('pending')
        expect(afterReturn.currentNodeKey).toBe('approval_c')

        expect(await landedWithin(hook.landed, 15000), 'the intercepted decision close must have run').toBe(true)

        const after = await readMetrics(inst.id)
        expect(
          after.effect,
          'a return that lands back on the same node must re-arm its timeout effect',
        ).toBe('jump')
        expect(
          after.deadlineSet,
          'a return that lands back on the same node must re-arm its deadline',
        ).toBe(true)
        expect(
          after.breakdownLength,
          'the re-activation must append its own node_breakdown entry',
        ).toBe(2)
      } finally {
        hook.restore()
        await landedWithin(hook.landed, 15000)
      }
    }, 60000)

    // ── per-call-site durability coverage (round-1 gate P2-1) ─────────────────────────────────
    // Each test below delays the activation stamp of ONE call site and then reads the armed row with
    // no polling: only a caller that AWAITS the stamp can have made it durable by the time the call
    // returns. Neutering that one `await` (→ `void`) makes exactly the matching test go red; the
    // 2×N mutation grid is in the verification MD.

    it('H-1 SITE (admin jump): the jump response does not return until the target node’s activation stamp is durable', async () => {
      const p = `dedup-rs-p-${TS}-h1adm`
      const q = `dedup-rs-q-${TS}-h1adm`
      const adminId = `dedup-rs-admin-${TS}-h1adm`
      const adminToken = await authToken(baseUrl, adminId)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-h1adm`)
      await grantWrite(`dedup-rs-req-${TS}-h1adm`)

      // A(P) → B(P) → C(Q, timeout jump → A). The admin jumps straight from A to C, so C's timeout
      // is the stamp under test; before the jump the columns are NULL (A carries no timeout).
      const templateId = await publishGraphTemplate(adminToken, buildBackwardJumpGraph(p, q), {})
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_a')
      expect((await readMetrics(inst.id)).effect).toBeNull()

      const versionRow = await pool().query<{ version: number }>(
        `SELECT version FROM approval_instances WHERE id = $1`,
        [inst.id],
      )
      const hook = installLateActivationStamp(inst.id, 'approval_c', H1_LATE_STAMP_MS)
      try {
        const jump = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/jump`, adminToken, {
          method: 'POST',
          body: { targetNodeKey: 'approval_c', reason: 'admin jump', version: versionRow.rows[0]?.version },
        })
        expect(jump.status, await jump.clone().text()).toBe(200)

        const after = await readMetrics(inst.id)
        expect(after.currentNodeKey).toBe('approval_c')
        expect(
          after.effect,
          'the admin-jump call site must not return before the target node’s activation stamp is durable',
        ).toBe('jump')
        expect(after.deadlineSet).toBe(true)
        expect(await landedWithin(hook.landed, 15000), 'the intercepted activation stamp must have run').toBe(true)
      } finally {
        hook.restore()
        await landedWithin(hook.landed, 15000)
      }
    }, 60000)

    it('H-1 SITE (timeout re-activation): applyNodeTimeoutEffect does not return until the re-entered node’s activation stamp is durable', async () => {
      const q = `dedup-rs-q-${TS}-h1toact`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-h1toact`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-h1toact`)
      await grantWrite(`dedup-rs-req-${TS}-h1toact`)

      const templateId = await publishGraphTemplate(adminToken, buildSameNodeReentryGraph(q), {})
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_c')
      await forceDeadlineOverdue(inst.id, 'jump')

      // Here the DECISION close runs at full speed (it is awaited, so it commits first and clears the
      // columns) and only the re-activation stamp is delayed: the columns can therefore only be armed
      // again if `applyNodeTimeoutEffect` waited for that stamp before returning.
      const hook = installLateActivationStamp(inst.id, 'approval_c', H1_LATE_STAMP_MS)
      try {
        const service = new ApprovalProductService()
        const outcome = await service.applyNodeTimeoutEffect(inst.id, 'jump')
        expect(outcome).toBe('applied')

        const after = await readMetrics(inst.id)
        expect(
          after.effect,
          'the timeout re-activation call site must not return before its activation stamp is durable',
        ).toBe('jump')
        expect(after.deadlineSet).toBe(true)
        expect(await landedWithin(hook.landed, 15000), 'the intercepted activation stamp must have run').toBe(true)
      } finally {
        hook.restore()
        await landedWithin(hook.landed, 15000)
      }
    }, 60000)

    it('H-1 SITE (handler branch): completing a handler does not return until the next node’s activation stamp is durable', async () => {
      const h = `dedup-rs-h-${TS}-h1hand`
      const q = `dedup-rs-q-${TS}-h1hand`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-h1hand`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-h1hand`)
      await grantWrite(`dedup-rs-req-${TS}-h1hand`)
      const hTok = await authToken(baseUrl, h)

      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'handler_h', type: 'handler', config: { assigneeSources: [{ kind: 'static_user', userIds: [h] }], handlerMode: 'any' } },
          {
            key: 'approval_c',
            type: 'approval',
            config: {
              assigneeType: 'user',
              assigneeIds: [q],
              approvalMode: 'single',
              timeout: { afterMinutes: 1, effect: 'remind' },
            },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-h', source: 'start', target: 'handler_h' },
          { key: 'e-h-c', source: 'handler_h', target: 'approval_c' },
          { key: 'e-c-end', source: 'approval_c', target: 'end' },
        ],
      }
      const templateId = await publishGraphTemplate(adminToken, graph, {})
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('handler_h')
      expect((await readMetrics(inst.id)).effect).toBeNull()

      const hook = installLateActivationStamp(inst.id, 'approval_c', H1_LATE_STAMP_MS)
      try {
        const afterHandle = await actor(hTok, inst.id)({ action: 'handle', comment: 'done' })
        expect(afterHandle.currentNodeKey).toBe('approval_c')

        const after = await readMetrics(inst.id)
        expect(
          after.effect,
          'the handler call site must not return before the next node’s activation stamp is durable',
        ).toBe('remind')
        expect(after.deadlineSet).toBe(true)
        expect(await landedWithin(hook.landed, 15000), 'the intercepted activation stamp must have run').toBe(true)
      } finally {
        hook.restore()
        await landedWithin(hook.landed, 15000)
      }
    }, 60000)

    it('H-1 SITE (return branch): the return response does not return until the re-entered node’s activation stamp is durable', async () => {
      const p = `dedup-rs-p-${TS}-h1ret`
      const q = `dedup-rs-q-${TS}-h1ret`
      const adminToken = await authToken(baseUrl, `dedup-rs-admin-${TS}-h1ret`)
      const requesterToken = await authToken(baseUrl, `dedup-rs-req-${TS}-h1ret`)
      await grantWrite(`dedup-rs-req-${TS}-h1ret`)
      const pTok = await authToken(baseUrl, p)
      const qTok = await authToken(baseUrl, q)

      // A(P, timeout remind) → B(Q) → end. P approves A; B carries no timeout, so activating B CLEARS
      // both columns. Q then returns to A, whose activation must re-arm them before the call returns.
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_a',
            type: 'approval',
            config: {
              assigneeType: 'user',
              assigneeIds: [p],
              approvalMode: 'single',
              timeout: { afterMinutes: 1, effect: 'remind' },
            },
          },
          approvalNode('approval_b', q),
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
          { key: 'e-b-end', source: 'approval_b', target: 'end' },
        ],
      }
      const templateId = await publishGraphTemplate(adminToken, graph, {})
      const inst = await createApproval(requesterToken, templateId, 'r')
      expect(inst.currentNodeKey).toBe('approval_a')

      const afterP = await actor(pTok, inst.id)({ action: 'approve', comment: 'P r1' })
      expect(afterP.currentNodeKey).toBe('approval_b')
      expect((await readMetrics(inst.id)).effect, 'B carries no timeout, so activating B clears the columns').toBeNull()

      const hook = installLateActivationStamp(inst.id, 'approval_a', H1_LATE_STAMP_MS)
      try {
        const afterReturn = await actor(qTok, inst.id)({ action: 'return', targetNodeKey: 'approval_a', comment: 'send back' })
        expect(afterReturn.currentNodeKey).toBe('approval_a')

        const after = await readMetrics(inst.id)
        expect(
          after.effect,
          'the return call site must not return before the re-entered node’s activation stamp is durable',
        ).toBe('remind')
        expect(after.deadlineSet).toBe(true)
        expect(await landedWithin(hook.landed, 15000), 'the intercepted activation stamp must have run').toBe(true)
      } finally {
        hook.restore()
        await landedWithin(hook.landed, 15000)
      }
    }, 60000)
  })
})
