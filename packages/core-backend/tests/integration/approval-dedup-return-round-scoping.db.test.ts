import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

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
  })
})
