import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import type { ApprovalActionRequest } from '../../src/types/approval-product'

/**
 * Lock-5 gates B-1 / B-2 / B-3 / B-4 / B-5 — add-sign modes, real-DB.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §0 C-3/C-5/C-6,
 * §0.1 (the `add_sign` row), OD-L5-4(b) (`:311-322`, recorded `:348-349`), OD-L5-5(a), gates
 * B-1..B-5 (`:270-274`), master M8; execution ledger row "OD-L5-4(b) — four enumerated
 * completions" + owner disposition (1), 2026-10-01 (F4-S1).
 *
 * ### What this file pins, and why a PIN is the deliverable
 *
 * §0.1 states the shipped defect: **"`'before'` is audit-metadata only."** `buildAddSignAssignments`
 * takes no mode argument and both modes seat co-signers at the CURRENT node in the SAME epoch, so
 * outside a parallel region `'before'` and `'parallel'` are byte-identical runtime behavior — while
 * the member dialog shipped a `前加签` / `并加签` radio implying a choice.
 *
 * B-2's ratified disposition is HONESTY, not new semantics: pin the identity so nobody can later
 * claim the modes differ, and stop the FE label claiming corpus C-3's node-insertion semantic (that
 * half is `apps/web/src/approvals/addSignHonestyCopy.ts` + its spec). Node-insertion 前加签 is
 * ratified NOWHERE in Lock-5 — C-3's row says the shipped `'before'` is a MISLABEL of it, and
 * OD-L5-4 is about **after**-sign (`'after'`), a different verb entirely.
 *
 * The pin is deliberately behavioural (assignee set, `entry_epoch`, `is_active`, node/status/version
 * transition) rather than a source-text assertion: a regex guard can be deleted, and a comment is
 * not an invariant. If a later slice makes `'before'` genuinely differ, THIS test is what goes red
 * and forces the honesty copy to be revisited in the same change.
 *
 * ### F4-S1 (this slice): `'after'` lands under OD-L5-4(b) + owner disposition (1)
 *
 * B-1: both doors are explicit — an unknown mode is 400 `APPROVAL_ADD_SIGN_MODE_INVALID` at the
 * route AND at the service, and `'after'` reaches the service as `'after'`. B-3: an after-sign
 * consumes the actor's seat as an approval and, when that approval COMPLETES the node's current
 * round, seats the addees as a FRESH `nodeEntryEpoch` round at the SAME node; the node advances only
 * when that round completes; the instance never terminates early. Owner disposition (1) on the
 * ledger's four-completions row: when the approval does NOT complete the round (undecided 会签
 * siblings / threshold still short), the action is refused 409
 * `APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE` with NOTHING persisted — the pre-slice "DEFERRAL
 * EVIDENCE" reproducer (a hand-built cross-epoch state that bricked the sibling) is therefore
 * rewritten below as the pin that no such state can be produced through the API. B-4: inside a
 * parallel region `'after'` reuses `APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED`. B-5: with two or
 * more addees `addSignAggregation` (`all` | `any`) governs the appended round.
 *
 * Not widened here (disclosed, pinned): a `sequential` node refuses add-sign of EVERY mode through
 * the pre-existing operation-policy rule (#5451), so the "last person of a sequential queue" arm
 * of disposition (1) is unreachable on this baseline.
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
  return ((await response.json()) as { token: string }).token
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

/** LINEAR (no parallel region): A(p) -> B(q) -> end. */
function linearGraph(p: string, q: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
      { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [q], approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
      { key: 'e-b-end', source: 'approval_b', target: 'end' },
    ],
  }
}

/** A parallel fork whose two branch approvers are `pa` / `pb`, joining at a single finance node. */
function parallelGraph(pa: string, pb: string, join: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'parallel_fork', type: 'parallel', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join_node' } },
      { key: 'branch_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [pa], approvalMode: 'single' } },
      { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [pb], approvalMode: 'single' } },
      { key: 'join_node', type: 'approval', config: { assigneeType: 'user', assigneeIds: [join], approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-fork', source: 'start', target: 'parallel_fork' },
      { key: 'e-fork-a', source: 'parallel_fork', target: 'branch_a' },
      { key: 'e-fork-b', source: 'parallel_fork', target: 'branch_b' },
      { key: 'e-a-join', source: 'branch_a', target: 'join_node' },
      { key: 'e-b-join', source: 'branch_b', target: 'join_node' },
      { key: 'e-join-end', source: 'join_node', target: 'end' },
    ],
  }
}

describeIfDatabase("Lock-5 L5-B — add-sign modes: B-2 identity pin, B-1 doors, B-3/B-4/B-5 after-sign (OD-L5-4(b) + owner disposition (1))", () => {
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

  async function publishGraphTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const templateKey = `l5b-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const response = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Lock-5 B-2 add-sign honesty',
        description: 'approval-lock5-node-operation-policy-20260817 gate B-2',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
    expect(response.status, await response.clone().text()).toBe(201)
    const template = (await response.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return template.id
  }

  async function createApproval(requesterToken: string, templateId: string): Promise<{ id: string; currentNodeKey: string | null }> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string; currentNodeKey: string | null }
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

  /** The observable runtime state add-sign produces, normalized so two instances are comparable. */
  async function runtimeShape(instanceId: string, nodeKey: string) {
    const assignments = await pool().query(
      `SELECT assignee_id, assignment_type, source_step, is_active, entry_epoch,
              metadata->>'addSign' AS add_sign, metadata->>'addedBy' AS added_by
         FROM approval_assignments
        WHERE instance_id = $1 AND node_key = $2
        ORDER BY assignee_id ASC`,
      [instanceId, nodeKey],
    )
    const instance = await pool().query(
      'SELECT status, current_node_key, version, current_step, total_steps, node_activation_seq FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    return { assignments: assignments.rows, instance: instance.rows[0] }
  }

  it("B-2 PIN: `'before'` and `'parallel'` produce IDENTICAL assignments, epoch and instance transition on a linear node", async () => {
    // Two instances of the SAME template, same actor, same addee — the ONLY difference in the
    // request is `addSignMode`. Everything observable at runtime must match.
    const suffix = 'b2-pin'
    const p = `l5b-p-${TS}-${suffix}`
    const q = `l5b-q-${TS}-${suffix}`
    const addee = `l5b-add-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5b-admin-${TS}-${suffix}`)
    const requesterId = `l5b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const templateId = await publishGraphTemplate(adminToken, linearGraph(p, q), suffix)

    const parallelInst = await createApproval(requesterToken, templateId)
    const beforeInst = await createApproval(requesterToken, templateId)
    expect(parallelInst.currentNodeKey).toBe('approval_a')
    expect(beforeInst.currentNodeKey).toBe('approval_a')

    const rParallel = await act(pTok, parallelInst.id, { action: 'add_sign', targetUserIds: [addee], addSignMode: 'parallel' })
    expect(rParallel.status, await rParallel.clone().text()).toBe(200)
    const rBefore = await act(pTok, beforeInst.id, { action: 'add_sign', targetUserIds: [addee], addSignMode: 'before' })
    expect(rBefore.status, await rBefore.clone().text()).toBe(200)

    const shapeParallel = await runtimeShape(parallelInst.id, 'approval_a')
    const shapeBefore = await runtimeShape(beforeInst.id, 'approval_a')

    // THE PIN. Assignee set, seat activity, source step, and — the load-bearing one — `entry_epoch`
    // are identical: `'before'` did NOT open a preceding node and did NOT mint a round of its own.
    expect(shapeBefore.assignments).toEqual(shapeParallel.assignments)
    expect(shapeBefore.instance).toEqual(shapeParallel.instance)
    // Both seated the addee into the CURRENT node's CURRENT round alongside the adder.
    expect(shapeBefore.assignments.map((row: { assignee_id: string }) => row.assignee_id)).toEqual([addee, p].sort())
    const epochs = new Set(shapeBefore.assignments.map((row: { entry_epoch: number }) => Number(row.entry_epoch)))
    expect(epochs.size).toBe(1)
    // The node did not advance and the instance did not terminate.
    expect(shapeBefore.instance.current_node_key).toBe('approval_a')
    expect(shapeBefore.instance.status).toBe('pending')

    // …and the ONLY place the two runs differ is the audit row's `addSignMode` — §0.1's
    // "audit-metadata only", pinned as an equality rather than left as prose.
    const auditMode = async (id: string) => {
      const rows = await pool().query(
        "SELECT metadata->>'addSignMode' AS mode, metadata->>'addedUserIds' AS added FROM approval_records WHERE instance_id = $1 AND action = 'add_sign'",
        [id],
      )
      return rows.rows[0]
    }
    const aParallel = await auditMode(parallelInst.id)
    const aBefore = await auditMode(beforeInst.id)
    expect(aParallel.mode).toBe('parallel')
    expect(aBefore.mode).toBe('before')
    expect(aBefore.added).toEqual(aParallel.added)
  })

  it("B-2 POSITIVE CONTROL: inside a parallel region the two modes DO diverge — `'before'` is 409 while `'parallel'` succeeds", async () => {
    // Without this, the identity pin above would be green against a build where add_sign is broken
    // for BOTH modes (or where the mode never reaches the service at all). Here the mode demonstrably
    // reaches the service and demonstrably selects a different outcome — so the pin is not vacuous.
    const suffix = 'b2-ctl'
    const pa = `l5b-pa-${TS}-${suffix}`
    const pb = `l5b-pb-${TS}-${suffix}`
    const join = `l5b-join-${TS}-${suffix}`
    const addee = `l5b-add-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5b-admin-${TS}-${suffix}`)
    const requesterId = `l5b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const paTok = await authToken(baseUrl, pa)

    const templateId = await publishGraphTemplate(adminToken, parallelGraph(pa, pb, join), suffix)

    const beforeInst = await createApproval(requesterToken, templateId)
    const rBefore = await act(paTok, beforeInst.id, { action: 'add_sign', targetUserIds: [addee], addSignMode: 'before' })
    expect(rBefore.status, await rBefore.clone().text()).toBe(409)
    expect(((await rBefore.json()) as { error: { code: string } }).error.code)
      .toBe('APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED')

    const parallelInst = await createApproval(requesterToken, templateId)
    const rParallel = await act(paTok, parallelInst.id, { action: 'add_sign', targetUserIds: [addee], addSignMode: 'parallel' })
    expect(rParallel.status, await rParallel.clone().text()).toBe(200)
    const seated = await pool().query(
      'SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE ORDER BY assignee_id',
      [parallelInst.id, 'branch_a'],
    )
    expect(seated.rows.map((row: { assignee_id: string }) => row.assignee_id)).toEqual([addee, pa].sort())
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // F4-S1 helpers — read-side only; every assertion below is on persisted rows, never on prose.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  async function instanceRow(instanceId: string) {
    const result = await pool().query<{
      status: string
      current_node_key: string | null
      version: number
      node_activation_seq: number | string
      metadata: Record<string, unknown> | null
    }>(
      'SELECT status, current_node_key, version, node_activation_seq, metadata FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    const row = result.rows[0]
    return { ...row, node_activation_seq: Number(row.node_activation_seq) }
  }

  async function activeSeats(instanceId: string, nodeKey: string) {
    const result = await pool().query<{ assignee_id: string; entry_epoch: number | string | null; add_sign: string | null }>(
      `SELECT assignee_id, entry_epoch, metadata->>'addSign' AS add_sign
         FROM approval_assignments
        WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE
        ORDER BY assignee_id ASC`,
      [instanceId, nodeKey],
    )
    return result.rows.map((row) => ({
      assigneeId: row.assignee_id,
      entryEpoch: row.entry_epoch === null ? null : Number(row.entry_epoch),
      addSign: row.add_sign === 'true',
    }))
  }

  /** Every audit row AFTER the instance's own `created` row (which every instance carries). */
  async function auditRows(instanceId: string) {
    const result = await pool().query<{ action: string; actor_id: string; metadata: Record<string, unknown> | null }>(
      `SELECT action, actor_id, metadata FROM approval_records
        WHERE instance_id = $1 AND action <> 'created'
        ORDER BY occurred_at ASC, id ASC`,
      [instanceId],
    )
    return result.rows
  }

  function multiSeatGraph(assigneeIds: string[], approvalMode: 'all' | 'any' | 'threshold', extra: Record<string, unknown> = {}) {
    return {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds, approvalMode, ...extra } },
        { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [assigneeIds[0]], approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-s-a', source: 'start', target: 'approval_a' },
        { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
        { key: 'e-b-end', source: 'approval_b', target: 'end' },
      ],
    }
  }

  async function fixture(label: string, graphFor: (ids: { p: string; q: string; addee: string; addee2: string; p2: string; p3: string }) => object) {
    const ids = {
      p: `l5b-p-${TS}-${label}`,
      p2: `l5b-p2-${TS}-${label}`,
      p3: `l5b-p3-${TS}-${label}`,
      q: `l5b-q-${TS}-${label}`,
      addee: `l5b-add-${TS}-${label}`,
      addee2: `l5b-add2-${TS}-${label}`,
    }
    const adminToken = await authToken(baseUrl, `l5b-admin-${TS}-${label}`)
    const requesterId = `l5b-req-${TS}-${label}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const templateId = await publishGraphTemplate(adminToken, graphFor(ids), label)
    const tokens = {
      p: await authToken(baseUrl, ids.p),
      p2: await authToken(baseUrl, ids.p2),
      p3: await authToken(baseUrl, ids.p3),
      q: await authToken(baseUrl, ids.q),
      addee: await authToken(baseUrl, ids.addee),
      addee2: await authToken(baseUrl, ids.addee2),
    }
    return { ids, tokens, templateId, requesterToken, adminToken }
  }

  it("B-1 (ROUTE door): an UNKNOWN add-sign mode is 400 `APPROVAL_ADD_SIGN_MODE_INVALID`, nothing is persisted, and an ABSENT mode still defaults to 'parallel'", async () => {
    // Inverted from the pre-slice corollary ("an unknown mode is silently coerced today"). Reverting
    // the route filter alone flattens 'bogus' to undefined → the service's 'parallel' default → 200,
    // which is exactly what turns this test red (B-1: "reverting EITHER door alone turns a named
    // test red"; the service door has its own pin below).
    const f = await fixture('b1-route', ({ p, q }) => linearGraph(p, q))
    const inst = await createApproval(f.requesterToken, f.templateId)
    const before = await instanceRow(inst.id)

    const bogus = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'bogus' })
    expect(bogus.status, await bogus.clone().text()).toBe(400)
    expect(((await bogus.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_ADD_SIGN_MODE_INVALID')
    expect(await auditRows(inst.id)).toEqual([])
    expect((await activeSeats(inst.id, 'approval_a')).map((seat) => seat.assigneeId)).toEqual([f.ids.p])
    expect(await instanceRow(inst.id)).toEqual(before)

    // POSITIVE CONTROL (value-selected): the SAME request with the key ABSENT is today's default.
    const absent = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee] })
    expect(absent.status, await absent.clone().text()).toBe(200)
    const rows = await auditRows(inst.id)
    expect(rows.map((row) => row.action)).toEqual(['add_sign'])
    expect(rows[0].metadata?.addSignMode).toBe('parallel')
  })

  it('B-1 (SERVICE door): a direct dispatch with an unknown mode is refused 400 by the service itself, and an unknown aggregation too', async () => {
    // Bypasses the route entirely: if the service's own check is reverted to the old
    // `=== 'before' ? 'before' : 'parallel'` coercion, this call succeeds and the test goes red —
    // independently of the route pin above.
    const f = await fixture('b1-service', ({ p, q }) => linearGraph(p, q))
    const inst = await createApproval(f.requesterToken, f.templateId)
    const service = new ApprovalProductService()
    const actor = { userId: f.ids.p, userName: f.ids.p, roles: [] as string[] }
    await expect(
      service.dispatchAction(
        inst.id,
        { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'bogus' } as unknown as ApprovalActionRequest,
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_ADD_SIGN_MODE_INVALID' })
    await expect(
      service.dispatchAction(
        inst.id,
        { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after', addSignAggregation: 'most' } as unknown as ApprovalActionRequest,
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' })
    expect(await auditRows(inst.id)).toEqual([])
    expect((await activeSeats(inst.id, 'approval_a')).map((seat) => seat.assigneeId)).toEqual([f.ids.p])
  })

  async function waitForMetricsStart(instanceId: string): Promise<void> {
    // `recordInstanceStart` is fire-and-forget by contract (a metrics outage must never fail the
    // instance), so give it a moment to land before the metrics reading below is asserted.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const row = await pool().query('SELECT 1 FROM approval_metrics WHERE instance_id = $1', [instanceId])
      if (row.rows.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('approval_metrics start row did not land')
  }

  it("B-3 (single seat): 'after' consumes the actor's seat as an approval, seats the addee as a FRESH epoch round at the SAME node, does not terminate the instance, and the node advances when that round completes", async () => {
    const f = await fixture('b3-single', ({ p, q }) => linearGraph(p, q))
    const inst = await createApproval(f.requesterToken, f.templateId)
    await waitForMetricsStart(inst.id)
    const before = await instanceRow(inst.id)
    const originalEpoch = (await activeSeats(inst.id, 'approval_a'))[0].entryEpoch
    expect(originalEpoch).not.toBeNull()

    const response = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after', comment: 'after-sign' })
    expect(response.status, await response.clone().text()).toBe(200)

    // The actor's seat is consumed; the addee is the ONLY live seat, under a NEW epoch.
    const seats = await activeSeats(inst.id, 'approval_a')
    expect(seats).toEqual([{ assigneeId: f.ids.addee, entryEpoch: originalEpoch! + 1, addSign: true }])
    const after = await instanceRow(inst.id)
    expect(after.status).toBe('pending')
    expect(after.current_node_key).toBe('approval_a')
    expect(after.version).toBe(before.version + 1)
    expect(after.node_activation_seq).toBe(before.node_activation_seq + 1)
    // The appended-round carrier, keyed on the fresh epoch.
    expect(after.metadata?.addSignAppendedRound).toEqual({ nodeKey: 'approval_a', entryEpoch: originalEpoch! + 1, aggregation: 'all' })

    // Audit: the actor's approve (old epoch, marked as round-closing-not-node-closing) + the
    // add_sign row carrying the round triple. No completion event shape, no terminal status.
    const rows = await auditRows(inst.id)
    expect(rows.map((row) => row.action)).toEqual(['approve', 'add_sign'])
    expect(rows[0].actor_id).toBe(f.ids.p)
    expect(rows[0].metadata).toMatchObject({
      nodeKey: 'approval_a',
      nextNodeKey: 'approval_a',
      aggregateComplete: true,
      nodeEntryEpoch: originalEpoch,
      addSignAfter: true,
      appendedNodeEntryEpoch: originalEpoch! + 1,
    })
    expect(rows[1].metadata).toMatchObject({
      nodeKey: 'approval_a',
      addSignMode: 'after',
      addedUserIds: [f.ids.addee],
      addSignAggregation: 'all',
      nodeEntryEpoch: originalEpoch,
      appendedNodeEntryEpoch: originalEpoch! + 1,
    })

    // Metrics reading (documented in the slice MD): the appended round is a NEW activation of the
    // same node — the first breakdown entry is closed with the actor, a second open entry exists.
    const metrics = await pool().query<{ node_breakdown: Array<{ nodeKey: string; decidedAt: string | null; approverIds: string[] }> }>(
      'SELECT node_breakdown FROM approval_metrics WHERE instance_id = $1',
      [inst.id],
    )
    const entriesForA = (metrics.rows[0]?.node_breakdown ?? []).filter((entry) => entry.nodeKey === 'approval_a')
    expect(entriesForA.length).toBe(2)
    expect(entriesForA[0].decidedAt).not.toBeNull()
    expect(entriesForA[0].approverIds).toEqual([f.ids.p])
    expect(entriesForA[1].decidedAt).toBeNull()

    // The actor no longer holds a seat: a second decision by them is a 403, not a double vote.
    const again = await act(f.tokens.p, inst.id, { action: 'approve', comment: 'again' })
    expect(again.status).toBe(403)

    // The appended round completes → the node ADVANCES (to approval_b, q seated) — it was not skipped.
    const addeeApprove = await act(f.tokens.addee, inst.id, { action: 'approve', comment: 'ok' })
    expect(addeeApprove.status, await addeeApprove.clone().text()).toBe(200)
    const advanced = await instanceRow(inst.id)
    expect(advanced.status).toBe('pending')
    expect(advanced.current_node_key).toBe('approval_b')
    expect((await activeSeats(inst.id, 'approval_b')).map((seat) => seat.assigneeId)).toEqual([f.ids.q])
    expect((await activeSeats(inst.id, 'approval_a')).length).toBe(0)

    // …and the instance terminates only through the LAST node, as always.
    const qApprove = await act(f.tokens.q, inst.id, { action: 'approve', comment: 'ok' })
    expect(qApprove.status, await qApprove.clone().text()).toBe(200)
    expect((await instanceRow(inst.id)).status).toBe('approved')
  })

  it("B-3 POSITIVE CONTROL: the same fixture with 'parallel' keeps ONE round and ONE epoch (two live seats, no approve row)", async () => {
    const f = await fixture('b3-ctl', ({ p, q }) => linearGraph(p, q))
    const inst = await createApproval(f.requesterToken, f.templateId)
    const before = await instanceRow(inst.id)
    const response = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'parallel' })
    expect(response.status, await response.clone().text()).toBe(200)
    const seats = await activeSeats(inst.id, 'approval_a')
    expect(seats.map((seat) => seat.assigneeId)).toEqual([f.ids.addee, f.ids.p].sort())
    expect(new Set(seats.map((seat) => seat.entryEpoch)).size).toBe(1)
    const after = await instanceRow(inst.id)
    expect(after.node_activation_seq).toBe(before.node_activation_seq)
    expect(after.metadata?.addSignAppendedRound).toBeUndefined()
    expect((await auditRows(inst.id)).map((row) => row.action)).toEqual(['add_sign'])
  })

  it("B-3 / owner disposition (1): at a 会签 node with an UNDECIDED sibling, 'after' is refused 409 `APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE` with NO cross-epoch state — and succeeds once the actor's approval is the round's last", async () => {
    // Rewrites the pre-slice "B-3 DEFERRAL EVIDENCE" test. That test hand-built OD-L5-4(b)'s literal
    // state at a multi-seat node (the addee under a fresh epoch beside an undecided sibling under the
    // old one) and observed the sibling's next approve fail closed with
    // `APPROVAL_NODE_ENTRY_EPOCH_MIXED`. Disposition (1) makes that state unreachable through the
    // API: the after-sign is refused BEFORE anything is written, in the engine's own 会签 partial
    // branch. This test pins the refusal, pins that the persisted state is byte-identical after it,
    // and then proves the sibling is NOT bricked — their approve is a plain 200.
    const f = await fixture('b3-incomplete', ({ p, p2 }) => multiSeatGraph([p, p2], 'all'))
    const inst = await createApproval(f.requesterToken, f.templateId)
    expect(inst.currentNodeKey).toBe('approval_a')
    const seatsBefore = await activeSeats(inst.id, 'approval_a')
    expect(seatsBefore.length).toBe(2)
    const rowBefore = await instanceRow(inst.id)

    const refused = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(refused.status, await refused.clone().text()).toBe(409)
    const body = (await refused.json()) as { error: { code: string; details?: unknown } }
    expect(body.error.code).toBe('APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE')
    // Values-free: no details at all — no seat count, no sibling, no epoch.
    expect(body.error.details).toBeUndefined()

    // NOTHING persisted: seats, epochs, version, activation seq, metadata, audit — all unchanged.
    expect(await activeSeats(inst.id, 'approval_a')).toEqual(seatsBefore)
    expect(await instanceRow(inst.id)).toEqual(rowBefore)
    expect(await auditRows(inst.id)).toEqual([])
    const spanning = await pool().query(
      'SELECT DISTINCT entry_epoch FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE',
      [inst.id, 'approval_a'],
    )
    expect(spanning.rows.length).toBe(1)

    // The sibling is NOT bricked (the pre-slice reproducer's 500 cannot happen): a partial 会签 vote.
    const sibling = await act(f.tokens.p2, inst.id, { action: 'approve', comment: 'ok' })
    expect(sibling.status, await sibling.clone().text()).toBe(200)
    expect((await instanceRow(inst.id)).current_node_key).toBe('approval_a')

    // POSITIVE CONTROL (round-completion-selected): now the actor IS the last seat of the round, so
    // the identical after-sign succeeds and opens the appended round under a fresh epoch.
    const originalEpoch = seatsBefore[0].entryEpoch
    const accepted = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    expect(await activeSeats(inst.id, 'approval_a')).toEqual([{ assigneeId: f.ids.addee, entryEpoch: originalEpoch! + 1, addSign: true }])
    expect((await auditRows(inst.id)).map((row) => `${row.action}:${row.actor_id}`))
      .toEqual([`approve:${f.ids.p2}`, `approve:${f.ids.p}`, `add_sign:${f.ids.p}`])
    // …and completing the appended round advances the node (approval_b seats p, per multiSeatGraph).
    const addeeApprove = await act(f.tokens.addee, inst.id, { action: 'approve', comment: 'ok' })
    expect(addeeApprove.status, await addeeApprove.clone().text()).toBe(200)
    expect((await instanceRow(inst.id)).current_node_key).toBe('approval_b')
  })

  it("B-3 (或签): at an 'any' node the actor's approval completes the round on its own — the sibling is cancelled with the shipped audit row and the appended round opens", async () => {
    const f = await fixture('b3-any', ({ p, p2 }) => multiSeatGraph([p, p2], 'any'))
    const inst = await createApproval(f.requesterToken, f.templateId)
    const originalEpoch = (await activeSeats(inst.id, 'approval_a'))[0].entryEpoch
    const response = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await activeSeats(inst.id, 'approval_a')).toEqual([{ assigneeId: f.ids.addee, entryEpoch: originalEpoch! + 1, addSign: true }])
    const rows = await auditRows(inst.id)
    expect(rows.map((row) => row.action)).toEqual(['approve', 'add_sign', 'sign'])
    expect(rows[2].metadata).toMatchObject({ autoCancelled: true, aggregateMode: 'any', cancelledAssignees: [f.ids.p2] })
    // The cancelled sibling holds no seat in the appended round.
    const siblingApprove = await act(f.tokens.p2, inst.id, { action: 'approve', comment: 'late' })
    expect(siblingApprove.status).toBe(403)
  })

  it("B-3 (threshold): 'after' is refused while the tally is short, and accepted by the approval that reaches N — the remaining sibling is cancelled", async () => {
    const f = await fixture('b3-threshold', ({ p, p2, p3 }) => multiSeatGraph([p, p2, p3], 'threshold', { approvalThreshold: 2 }))
    const inst = await createApproval(f.requesterToken, f.templateId)
    const rowBefore = await instanceRow(inst.id)
    const seatsBefore = await activeSeats(inst.id, 'approval_a')
    expect(seatsBefore.length).toBe(3)

    // 0 prior + this one = 1 < 2 with siblings left → refused, nothing written.
    const refused = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(refused.status, await refused.clone().text()).toBe(409)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE')
    expect(await activeSeats(inst.id, 'approval_a')).toEqual(seatsBefore)
    expect(await instanceRow(inst.id)).toEqual(rowBefore)
    expect(await auditRows(inst.id)).toEqual([])

    // p2's plain approve is the first of two; then p's after-sign IS the second → the round completes.
    const partial = await act(f.tokens.p2, inst.id, { action: 'approve', comment: 'ok' })
    expect(partial.status, await partial.clone().text()).toBe(200)
    const accepted = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const seats = await activeSeats(inst.id, 'approval_a')
    expect(seats.map((seat) => seat.assigneeId)).toEqual([f.ids.addee])
    expect(seats[0].entryEpoch).toBe(seatsBefore[0].entryEpoch! + 1)
    const rows = await auditRows(inst.id)
    expect(rows.map((row) => row.action)).toEqual(['approve', 'approve', 'add_sign', 'sign'])
    expect(rows[3].metadata).toMatchObject({ aggregateMode: 'threshold', cancelledAssignees: [f.ids.p3] })
  })

  it("B-4: inside a parallel region 'after' is refused with the SAME code as 'before' (`APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED`) and no new code appears", async () => {
    const f = await fixture('b4', ({ p, p2, q }) => parallelGraph(p, p2, q))
    const inst = await createApproval(f.requesterToken, f.templateId)
    const rowBefore = await instanceRow(inst.id)
    const response = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(response.status, await response.clone().text()).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED')
    expect(await instanceRow(inst.id)).toEqual(rowBefore)
    expect(await auditRows(inst.id)).toEqual([])
    // Placement-selected: the linear B-3 test above is this refusal's positive control.
  })

  it("B-5: with two or more addees `addSignAggregation` is REQUIRED for 'after' and governs the appended round — 'all' needs every addee, 'any' the first; a single addee needs none", async () => {
    // (a) required
    const missing = await fixture('b5-missing', ({ p, q }) => linearGraph(p, q))
    const instMissing = await createApproval(missing.requesterToken, missing.templateId)
    const noAggregation = await act(missing.tokens.p, instMissing.id, { action: 'add_sign', targetUserIds: [missing.ids.addee, missing.ids.addee2], addSignMode: 'after' })
    expect(noAggregation.status, await noAggregation.clone().text()).toBe(400)
    expect(((await noAggregation.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    expect(await auditRows(instMissing.id)).toEqual([])
    const badAggregation = await act(missing.tokens.p, instMissing.id, { action: 'add_sign', targetUserIds: [missing.ids.addee, missing.ids.addee2], addSignMode: 'after', addSignAggregation: 'most' })
    expect(badAggregation.status, await badAggregation.clone().text()).toBe(400)
    // …and the key is NOT read for 'parallel' (byte-identical to before: a stray value is ignored).
    const parallelStray = await act(missing.tokens.p, instMissing.id, { action: 'add_sign', targetUserIds: [missing.ids.addee], addSignMode: 'parallel', addSignAggregation: 'any' })
    expect(parallelStray.status, await parallelStray.clone().text()).toBe(200)
    expect((await auditRows(instMissing.id))[0].metadata?.addSignAggregation).toBeUndefined()

    // (b) 'all': the appended round waits for BOTH addees; the node's authored mode ('single') does
    // not apply to the appended round.
    const all = await fixture('b5-all', ({ p, q }) => linearGraph(p, q))
    const instAll = await createApproval(all.requesterToken, all.templateId)
    const okAll = await act(all.tokens.p, instAll.id, { action: 'add_sign', targetUserIds: [all.ids.addee, all.ids.addee2], addSignMode: 'after', addSignAggregation: 'all' })
    expect(okAll.status, await okAll.clone().text()).toBe(200)
    expect((await instanceRow(instAll.id)).metadata?.addSignAppendedRound).toMatchObject({ nodeKey: 'approval_a', aggregation: 'all' })
    const seatsAll = await activeSeats(instAll.id, 'approval_a')
    expect(seatsAll.map((seat) => seat.assigneeId)).toEqual([all.ids.addee, all.ids.addee2].sort())
    expect(new Set(seatsAll.map((seat) => seat.entryEpoch)).size).toBe(1)
    const firstOfAll = await act(all.tokens.addee, instAll.id, { action: 'approve', comment: 'ok' })
    expect(firstOfAll.status, await firstOfAll.clone().text()).toBe(200)
    expect((await instanceRow(instAll.id)).current_node_key).toBe('approval_a') // still waiting on addee2
    expect((await activeSeats(instAll.id, 'approval_a')).map((seat) => seat.assigneeId)).toEqual([all.ids.addee2])
    const secondOfAll = await act(all.tokens.addee2, instAll.id, { action: 'approve', comment: 'ok' })
    expect(secondOfAll.status, await secondOfAll.clone().text()).toBe(200)
    expect((await instanceRow(instAll.id)).current_node_key).toBe('approval_b')

    // (c) 'any': the first addee's approve completes the appended round and cancels the other.
    const any = await fixture('b5-any', ({ p, q }) => linearGraph(p, q))
    const instAny = await createApproval(any.requesterToken, any.templateId)
    const okAny = await act(any.tokens.p, instAny.id, { action: 'add_sign', targetUserIds: [any.ids.addee, any.ids.addee2], addSignMode: 'after', addSignAggregation: 'any' })
    expect(okAny.status, await okAny.clone().text()).toBe(200)
    const firstOfAny = await act(any.tokens.addee2, instAny.id, { action: 'approve', comment: 'ok' })
    expect(firstOfAny.status, await firstOfAny.clone().text()).toBe(200)
    expect((await instanceRow(instAny.id)).current_node_key).toBe('approval_b')
    const rowsAny = await auditRows(instAny.id)
    const cancelRow = rowsAny.find((row) => row.action === 'sign' && row.metadata?.aggregateCancelledBy === any.ids.addee2)
    expect(cancelRow?.metadata).toMatchObject({ aggregateMode: 'any', cancelledAssignees: [any.ids.addee] })

    // (d) a single addee: no aggregation needed (pinned by the B-3 single-seat test, which sends none).
  })

  it("Lock-5 D-1 stays: a policy-disabled node refuses 'after' with `APPROVAL_NODE_OPERATION_DISABLED` and writes exactly ONE `policy_denied` row — before any mode logic runs", async () => {
    const f = await fixture('d1', ({ p, q }) => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single', nodeOperationPolicy: { allowAddSign: false, allowReduceSign: false } } },
        { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [q], approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-s-a', source: 'start', target: 'approval_a' },
        { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
        { key: 'e-b-end', source: 'approval_b', target: 'end' },
      ],
    }))
    const inst = await createApproval(f.requesterToken, f.templateId)
    const response = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(response.status, await response.clone().text()).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_NODE_OPERATION_DISABLED')
    const rows = await auditRows(inst.id)
    expect(rows.map((row) => row.action)).toEqual(['policy_denied'])
    expect(rows[0].metadata).toMatchObject({ nodeKey: 'approval_a', operation: 'add_sign', policyKey: 'allowAddSign' })
    expect((await activeSeats(inst.id, 'approval_a')).map((seat) => seat.assigneeId)).toEqual([f.ids.p])
  })

  it("DISCLOSED RESIDUAL (pinned, not widened): at a `sequential` node 'after' is refused by the pre-existing sequential rule (`APPROVAL_NODE_OPERATION_DISABLED`), so disposition (1)'s sequential arm is unreachable on this baseline", async () => {
    const f = await fixture('sequential', ({ p, p2, q }) => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_a', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: [p, p2] }], approvalMode: 'sequential', emptyAssigneePolicy: 'error' } },
        { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [q], approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-s-a', source: 'start', target: 'approval_a' },
        { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
        { key: 'e-b-end', source: 'approval_b', target: 'end' },
      ],
    }))
    const inst = await createApproval(f.requesterToken, f.templateId)
    // Head of the queue with p2 still queued …
    const queued = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(queued.status, await queued.clone().text()).toBe(409)
    expect(((await queued.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_NODE_OPERATION_DISABLED')
    // … and the LAST person of the queue: the same pre-existing refusal, not an appended round.
    const headApprove = await act(f.tokens.p, inst.id, { action: 'approve', comment: 'ok' })
    expect(headApprove.status, await headApprove.clone().text()).toBe(200)
    const last = await act(f.tokens.p2, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(last.status, await last.clone().text()).toBe(409)
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_NODE_OPERATION_DISABLED')
  })

  it("§1.3 / CR-1 carries over: at a `commentRequired:'always'` node a bare 'after' is 400 `APPROVAL_COMMENT_REQUIRED` (the consumed seat IS an approval) and a commented one succeeds", async () => {
    const f = await fixture('cr1', ({ p, q }) => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single', nodeOperationPolicy: { commentRequired: 'always' } } },
        { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [q], approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-s-a', source: 'start', target: 'approval_a' },
        { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
        { key: 'e-b-end', source: 'approval_b', target: 'end' },
      ],
    }))
    const inst = await createApproval(f.requesterToken, f.templateId)
    const bare = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(bare.status, await bare.clone().text()).toBe(400)
    expect(((await bare.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_COMMENT_REQUIRED')
    expect(await auditRows(inst.id)).toEqual([])
    const commented = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after', comment: 'reason' })
    expect(commented.status, await commented.clone().text()).toBe(200)
    expect((await activeSeats(inst.id, 'approval_a')).map((seat) => seat.assigneeId)).toEqual([f.ids.addee])
    // POSITIVE CONTROL (value-selected): 'parallel' at the same node needs no comment — it is not a
    // decision — so the gate above is mode-selected, not a blanket comment requirement on add_sign.
    const inst2 = await createApproval(f.requesterToken, f.templateId)
    const parallelBare = await act(f.tokens.p, inst2.id, { action: 'add_sign', targetUserIds: [f.ids.addee2], addSignMode: 'parallel' })
    expect(parallelBare.status, await parallelBare.clone().text()).toBe(200)
  })

  it("Downstream `prior_node_approver` under an appended round resolves to the APPENDED round's deciders (OD-L1-3(a) latest-round rule) — the original actor is not among them", async () => {
    // Documented reading for the slice MD, pinned so it cannot drift silently.
    const f = await fixture('prior', ({ p }) => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'gate', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: [p] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'again', type: 'approval', config: { assigneeSources: [{ kind: 'prior_node_approver', nodeKey: 'gate' }], approvalMode: 'all', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 's2g', source: 'start', target: 'gate' },
        { key: 'g2a', source: 'gate', target: 'again' },
        { key: 'a2e', source: 'again', target: 'end' },
      ],
    }))
    const inst = await createApproval(f.requesterToken, f.templateId)
    expect(inst.currentNodeKey).toBe('gate')
    const afterSign = await act(f.tokens.p, inst.id, { action: 'add_sign', targetUserIds: [f.ids.addee], addSignMode: 'after' })
    expect(afterSign.status, await afterSign.clone().text()).toBe(200)
    const addeeApprove = await act(f.tokens.addee, inst.id, { action: 'approve', comment: 'ok' })
    expect(addeeApprove.status, await addeeApprove.clone().text()).toBe(200)
    expect((await instanceRow(inst.id)).current_node_key).toBe('again')
    expect((await activeSeats(inst.id, 'again')).map((seat) => seat.assigneeId)).toEqual([f.ids.addee])
  })
})
