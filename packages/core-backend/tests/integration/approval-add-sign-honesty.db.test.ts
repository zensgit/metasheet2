import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-5 gate B-2 — `'before'` honesty, real-DB.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §0 C-3/C-5,
 * §0.1 (the `add_sign` row), gate B-2, master M8.
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
 * ### Not in this slice (deferred with evidence — see the last test in this file)
 *
 * B-1 (`'after'` reaching the service, unknown mode 400) and B-3/B-4/B-5 (the after-sign runtime
 * shape) are NOT here. B-1 alone would manufacture a NEW placebo — widening the doors so `'after'`
 * arrives while the service still coerces it to `'parallel'` is the same lying-control shape B-2
 * exists to retire — and B-3's ratified arm has a reproduced blocker, pinned below.
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

describeIfDatabase("Lock-5 B-2 — `'before'` and `'parallel'` add-sign are byte-identical outside a parallel region", () => {
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

  it("B-2 corollary: an UNKNOWN add-sign mode is silently coerced today — the B-1 door is NOT widened in this slice", async () => {
    // Honest disclosure, pinned so it cannot be mistaken for fixed. The route filter
    // (`routes/approvals.ts`) turns anything but 'before'/'parallel' into `undefined`, and the
    // service then coerces `undefined` to 'parallel'. Gate B-1 would make an unknown mode a 400
    // `APPROVAL_ADD_SIGN_MODE_INVALID` and let `'after'` through — DEFERRED here, because widening
    // the doors without B-3's runtime would make `'after'` a NEW placebo, which is exactly the
    // defect B-2 retires. When B-1 lands, THIS test must be inverted in the same change.
    const suffix = 'b1-deferred'
    const p = `l5b-p-${TS}-${suffix}`
    const q = `l5b-q-${TS}-${suffix}`
    const addee = `l5b-add-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5b-admin-${TS}-${suffix}`)
    const requesterId = `l5b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const templateId = await publishGraphTemplate(adminToken, linearGraph(p, q), suffix)
    const inst = await createApproval(requesterToken, templateId)
    const response = await act(pTok, inst.id, { action: 'add_sign', targetUserIds: [addee], addSignMode: 'after' })
    // Not a 400, and not after-sign semantics: it is accepted and recorded as `'parallel'`.
    expect(response.status, await response.clone().text()).toBe(200)
    const audit = await pool().query(
      "SELECT metadata->>'addSignMode' AS mode FROM approval_records WHERE instance_id = $1 AND action = 'add_sign'",
      [inst.id],
    )
    expect(audit.rows[0].mode).toBe('parallel')
    const shape = await runtimeShape(inst.id, 'approval_a')
    expect(new Set(shape.assignments.map((row: { entry_epoch: number }) => Number(row.entry_epoch))).size).toBe(1)
    expect(shape.instance.current_node_key).toBe('approval_a')
  })

  it('B-3 DEFERRAL EVIDENCE: OD-L5-4(b)\'s fresh-epoch round is refused by the shipped mixed-epoch invariant at a multi-seat node', async () => {
    // WHY THIS TEST EXISTS. OD-L5-4(b) (the RECORDED decision) reads: "the actor's seat is consumed
    // as an approval, the addees activate as a fresh nodeEntryEpoch round at the SAME node… no graph
    // mutation, existing machinery". At a SINGLE-seat node that composes. At a MULTI-seat 会签 node
    // it does not: the remaining sibling seat still carries the OLD epoch, and
    // `currentNodeEntryEpoch` fails CLOSED on a node whose active seats span epochs
    // ("a single round must never span epochs" — it never MAX()-collapses).
    //
    // This is constructed and observed, not argued: the test builds the exact state OD-L5-4(b)
    // prescribes and drives the sibling's next real action through the HTTP stack. The instance is
    // bricked for that approver. Implementing B-3 therefore needs an owner decision the lock does
    // not contain — a new refusal at multi-seat nodes (a contract addition), or a deferred-round
    // ledger (new persisted state, which contradicts "existing machinery"). Hence B-1/B-3/B-4/B-5
    // are deferred with this reproducer attached rather than guessed at.
    const suffix = 'b3-evidence'
    const p1 = `l5b-p1-${TS}-${suffix}`
    const p2 = `l5b-p2-${TS}-${suffix}`
    const addee = `l5b-add-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5b-admin-${TS}-${suffix}`)
    const requesterId = `l5b-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const p2Tok = await authToken(baseUrl, p2)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p1, p2], approvalMode: 'all' } },
        { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p1], approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-s-a', source: 'start', target: 'approval_a' },
        { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
        { key: 'e-b-end', source: 'approval_b', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.currentNodeKey).toBe('approval_a')

    // Construct EXACTLY what OD-L5-4(b) prescribes for an `'after'` add-sign by p1:
    //   1. p1's seat is consumed,
    //   2. the addee activates as a FRESH nodeEntryEpoch round at the SAME node.
    // p2's seat is untouched, as it must be — p2 has not decided.
    await pool().query(
      'UPDATE approval_assignments SET is_active = FALSE WHERE instance_id = $1 AND node_key = $2 AND assignee_id = $3',
      [inst.id, 'approval_a', p1],
    )
    const bumped = await pool().query(
      'UPDATE approval_instances SET node_activation_seq = node_activation_seq + 1 WHERE id = $1 RETURNING node_activation_seq',
      [inst.id],
    )
    const freshEpoch = Number(bumped.rows[0].node_activation_seq)
    await pool().query(
      `INSERT INTO approval_assignments
         (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, entry_epoch, metadata, created_at, updated_at)
       VALUES ($1, 'user', $2, 1, 'approval_a', TRUE, $3, '{"addSign":true}'::jsonb, now(), now())`,
      [inst.id, addee, freshEpoch],
    )

    const spanning = await pool().query(
      'SELECT DISTINCT entry_epoch FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE',
      [inst.id, 'approval_a'],
    )
    expect(spanning.rows.length).toBe(2) // the state OD-L5-4(b) asks for, at a multi-seat node

    // GATE: the sibling's next real decision is refused by the structural invariant.
    const response = await act(p2Tok, inst.id, { action: 'approve', comment: 'ok' })
    expect(response.status).toBe(500)
    expect(((await response.json()) as { error: { code: string } }).error.code)
      .toBe('APPROVAL_NODE_ENTRY_EPOCH_MIXED')

    // POSITIVE CONTROL: with the addee seated at the SAME epoch as the sibling — i.e. today's
    // shipped `'parallel'` shape — the identical approve SUCCEEDS. So the refusal above is caused by
    // the epoch SPAN that OD-L5-4(b) introduces, not by the extra seat, the 会签 mode, or the fixture.
    await pool().query(
      'UPDATE approval_assignments SET entry_epoch = (SELECT MIN(entry_epoch) FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE) WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE',
      [inst.id, 'approval_a'],
    )
    const retry = await act(p2Tok, inst.id, { action: 'approve', comment: 'ok' })
    expect(retry.status, await retry.clone().text()).toBe(200)
  })
})
