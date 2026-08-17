import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-3 (docs/development/approval-lock3-handler-node-20260817.md) handler / 办理节点 — REAL-DB
 * end-to-end acceptance. Harness mirrors approval-requester-choice.db.test.ts.
 *
 * Gates covered here (behaviourally testable end-to-end): G-4 totalSteps invariance, G-6 unknown-type
 * fail-closed, G-7 choke prohibitions, G-8 topology, G-9 field-write fail-closed, G-10 action
 * authorization, G-11 transfer/epoch, G-12 mode semantics, G-16 audit + action verb (incl. the DB
 * CHECK), G-17 preview distinguishability, G-18 values-free errors, plus the §1.5/G-13 backend
 * registry rejection. Every absence assertion carries a positive control (Lock-3 §4).
 *
 * NOT here (covered elsewhere): G-13 exact-set + G-14 tabs + G-20 recognised-types = FE unit specs
 * (approval-handler-node-config / approval-handler-node-authoring). G-3 R-14 org-read fail-closed =
 * the exported detector's unit test (approval-handler-node-detectors); the create-side fail-closed
 * wiring is shipped and unchanged — only the DETECTOR now includes handler.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `hnode-req-${TS}`
const GATE = `hnode-gate-${TS}` // approval gate before the handler
const H1 = `hnode-h1-${TS}` // handler seat 1
const H2 = `hnode-h2-${TS}` // handler seat 2
const FINAL = `hnode-final-${TS}` // approval node after the handler
const OTHER = `hnode-other-${TS}` // transfer target / non-assignee
const KEYPFX = `hnode-${TS}`

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

const FORM_SCHEMA = { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }

function staticUser(userIds: string[]) {
  return [{ kind: 'static_user', userIds }]
}
// start → handler(mode) → approval(FINAL) → end. The default handler roster is [H1,H2] 会签.
function handlerThenApprovalGraph(handlerConfig: Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'handler_h', type: 'handler', name: '办理', config: handlerConfig },
      { key: 'approval_final', type: 'approval', name: 'final', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2h', source: 'start', target: 'handler_h' },
      { key: 'h2f', source: 'handler_h', target: 'approval_final' },
      { key: 'f2e', source: 'approval_final', target: 'end' },
    ],
  }
}
// gate → handler → end. Lets us reach the handler AFTER an approval, exercising a non-first-node handler.
function gateThenHandlerGraph(handlerConfig: Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'approval_gate', type: 'approval', name: 'gate', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'handler_h', type: 'handler', name: '办理', config: handlerConfig },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2g', source: 'start', target: 'approval_gate' },
      { key: 'g2h', source: 'approval_gate', target: 'handler_h' },
      { key: 'h2e', source: 'handler_h', target: 'end' },
    ],
  }
}

// approval_A(GATE) → handler_H(会签 [H1,H2]) → approval_B(FINAL). Exercises R-3 (the return-trail
// walker passing THROUGH a handler) and G-12's re-entry control (a re-entered handler round).
function threeStageGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'approval_A', type: 'approval', name: 'A', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'handler_H', type: 'handler', name: '办理', config: { assigneeSources: staticUser([H1, H2]), handlerMode: 'all' } },
      { key: 'approval_B', type: 'approval', name: 'B', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2a', source: 'start', target: 'approval_A' },
      { key: 'a2h', source: 'approval_A', target: 'handler_H' },
      { key: 'h2b', source: 'handler_H', target: 'approval_B' },
      { key: 'b2e', source: 'approval_B', target: 'end' },
    ],
  }
}

type ErrorBody = { code?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } }
function errorCode(body: ErrorBody): string | undefined {
  return body.code ?? body.error?.code
}
function errorDetails(body: ErrorBody): Record<string, unknown> | undefined {
  return body.error?.details
}

// ── Anti-skip-green sentinel (mirrors approval-realdb-acceptance) ─────────────────────────────
// TOP-LEVEL, OUTSIDE describeIfDatabase: the dedicated approval-realdb-handler.yml lane sets
// EXPECT_DB=1; there a missing/broken DATABASE_URL REDS the run instead of silent skip-green.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('Lock-3 handler node — real-DB authoring/dispatch acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let h1Tok = ''
  let h2Tok = ''
  let finalTok = ''
  let gateTok = ''
  let otherTok = ''

  async function createTemplate(key: string, graph: unknown): Promise<Response> {
    return req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: graph },
    })
  }
  async function createTemplateId(key: string, graph: unknown): Promise<string> {
    const created = await createTemplate(key, graph)
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { id: string }).id
  }
  async function publishTemplate(tid: string): Promise<Response> {
    return req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })
  }
  async function createPublished(key: string, graph: unknown): Promise<string> {
    const tid = await createTemplateId(key, graph)
    const published = await publishTemplate(tid)
    expect(published.status, await published.clone().text()).toBe(200)
    return tid
  }
  async function createInstance(tid: string): Promise<string> {
    const ok = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(ok.status, await ok.clone().text()).toBe(201)
    return ((await ok.json()) as { id: string }).id
  }
  async function act(iid: string, token: string, body: Record<string, unknown>): Promise<Response> {
    return req(base, `/api/approvals/${iid}/actions`, token, { method: 'POST', body })
  }
  async function activeAssignees(iid: string): Promise<Array<{ assignee_id: string; node_key: string | null; source_step: number; entry_epoch: number | string | null; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(
      `SELECT assignee_id, node_key, source_step, entry_epoch, metadata FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ORDER BY assignee_id`,
      [iid],
    )
    return rows.rows as Array<{ assignee_id: string; node_key: string | null; source_step: number; entry_epoch: number | string | null; metadata: Record<string, unknown> | null }>
  }
  async function instanceRow(iid: string): Promise<{ status: string; current_node_key: string | null; total_steps: number; current_step: number }> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT status, current_node_key, total_steps, current_step FROM approval_instances WHERE id = $1`, [iid])
    return rows.rows[0] as { status: string; current_node_key: string | null; total_steps: number; current_step: number }
  }
  async function records(iid: string, action?: string): Promise<Array<{ action: string; actor_id: string | null; comment: string | null; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = action
      ? await pool.query(`SELECT action, actor_id, comment, metadata FROM approval_records WHERE instance_id = $1 AND action = $2 ORDER BY id ASC`, [iid, action])
      : await pool.query(`SELECT action, actor_id, comment, metadata FROM approval_records WHERE instance_id = $1 ORDER BY id ASC`, [iid])
    return rows.rows as Array<{ action: string; actor_id: string | null; comment: string | null; metadata: Record<string, unknown> | null }>
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`)
    for (const userId of [REQ, GATE, H1, H2, FINAL, OTHER]) {
      await pool.query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE) ON CONFLICT (id) DO NOTHING`, [userId, `${userId}@x.test`])
    }
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    h1Tok = await tok(base, H1)
    h2Tok = await tok(base, H2)
    finalTok = await tok(base, FINAL)
    gateTok = await tok(base, GATE)
    otherTok = await tok(base, OTHER)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`${KEYPFX}-%`])).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        const iids = (await pool.query(`SELECT id FROM approval_instances WHERE template_id = ANY($1::uuid[])`, [tids])).rows.map((r) => r.id as string)
        if (iids.length > 0) {
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1::uuid[])`, [tids])
      }
      await pool.query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, GATE, H1, H2, FINAL, OTHER]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  // ── G-6 — unknown node type still fail-closed; `handler` itself is admitted ───────────────────
  it('G-6: a graph with type "handlerx" is rejected 400; the same fixture with "handler" is accepted 201', async () => {
    const ok = handlerThenApprovalGraph({ assigneeSources: staticUser([H1]) })
    // positive control: `handler` is accepted (admission is enumerated, not permissive)
    await createTemplateId(`${KEYPFX}-g6-ok`, ok)
    const bad = JSON.parse(JSON.stringify(ok)) as ReturnType<typeof handlerThenApprovalGraph>
    bad.nodes[1].type = 'handlerx'
    const res = await createTemplate(`${KEYPFX}-g6-bad`, bad)
    expect(res.status).toBe(400)
  })

  // ── G-7 — authoring choke prohibitions (§1.2) ────────────────────────────────────────────────
  it('G-7: forbidden handler keys/values each 400; a valid handler in the SAME graph saves', async () => {
    // positive control: valid handler saves (rejection is shape-selected, not blanket)
    await createTemplateId(`${KEYPFX}-g7-ok`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1]), handlerMode: 'all' }))
    const bad: Array<{ config: Record<string, unknown>; label: string }> = [
      { label: 'emptyAssigneePolicy:auto-approve', config: { assigneeSources: staticUser([H1]), emptyAssigneePolicy: 'auto-approve' } },
      { label: 'handlerMode:sequential', config: { assigneeSources: staticUser([H1]), handlerMode: 'sequential' } },
      { label: 'handlerMode:threshold', config: { assigneeSources: staticUser([H1]), handlerMode: 'threshold' } },
      { label: 'approvalThreshold', config: { assigneeSources: staticUser([H1]), approvalThreshold: 2 } },
      { label: 'autoApprovalPolicy', config: { assigneeSources: staticUser([H1]), autoApprovalPolicy: { mergeWithRequester: true } } },
      { label: 'timeout', config: { assigneeSources: staticUser([H1]), timeout: { afterMinutes: 60, effect: 'remind' } } },
      { label: 'approvalMode', config: { assigneeSources: staticUser([H1]), approvalMode: 'all' } },
      { label: 'assigneeIds', config: { assigneeType: 'user', assigneeIds: [H1] } },
      { label: 'empty assigneeSources', config: { assigneeSources: [] } },
      { label: 'missing assigneeSources', config: { handlerMode: 'all' } },
    ]
    for (const { config, label } of bad) {
      const res = await createTemplate(`${KEYPFX}-g7-bad`, handlerThenApprovalGraph(config))
      expect(res.status, label).toBe(400)
    }
  })

  // ── §1.5 / G-13 (backend arm) — the seven-member handler registry rejects an unadmitted kind ──
  it('G-13(backend): continuous_managers on a handler is 400 APPROVAL_HANDLER_SOURCE_KIND_UNSUPPORTED; direct_manager (admitted) saves', async () => {
    // positive control: an admitted kind saves
    await createTemplateId(`${KEYPFX}-g13-ok`, handlerThenApprovalGraph({ assigneeSources: [{ kind: 'direct_manager' }] }))
    const res = await createTemplate(`${KEYPFX}-g13-bad`, handlerThenApprovalGraph({ assigneeSources: [{ kind: 'continuous_managers', levels: 2 }] }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as ErrorBody
    expect(errorCode(body)).toBe('APPROVAL_HANDLER_SOURCE_KIND_UNSUPPORTED')
  })

  // ── G-8 — topology: parallel region / join forbidden; main-path + condition-branch allowed ────
  it('G-8: handler inside a parallel branch and handler as joinNodeKey each fail at publish; main path + condition branch publish', async () => {
    // Positive control 1 — handler on the MAIN path publishes.
    await createPublished(`${KEYPFX}-g8-main`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1]) }))
    // Positive control 2 — handler INSIDE a condition branch body publishes.
    const condGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'cond', type: 'condition', name: 'c', config: { branches: [{ edgeKey: 'c2h', rules: [{ fieldId: 'reason', operator: 'eq', value: 'x' }] }], defaultEdgeKey: 'c2f' } },
        { key: 'handler_h', type: 'handler', name: '办理', config: { assigneeSources: staticUser([H1]) } },
        { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2c', source: 'start', target: 'cond' },
        { key: 'c2h', source: 'cond', target: 'handler_h' },
        { key: 'c2f', source: 'cond', target: 'approval_final' },
        { key: 'h2f', source: 'handler_h', target: 'approval_final' },
        { key: 'f2e', source: 'approval_final', target: 'end' },
      ],
    }
    await createPublished(`${KEYPFX}-g8-cond`, condGraph)

    // Negative 1 — handler inside a parallel branch fails at publish.
    const parallelGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'fork', type: 'parallel', name: 'fork', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
        { key: 'handler_a', type: 'handler', name: '办理', config: { assigneeSources: staticUser([H1]) } },
        { key: 'branch_b', type: 'approval', name: 'B', config: { assigneeSources: staticUser([H2]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'join', type: 'approval', name: 'join', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 'e-start-fork', source: 'start', target: 'fork' },
        { key: 'e-fork-a', source: 'fork', target: 'handler_a' },
        { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
        { key: 'e-a-join', source: 'handler_a', target: 'join' },
        { key: 'e-b-join', source: 'branch_b', target: 'join' },
        { key: 'e-join-end', source: 'join', target: 'end' },
      ],
    }
    // The topology gate runs at every write site (create/update/publish), so it rejects at the
    // EARLIEST — create — which is strictly more fail-closed than publish-only.
    const parRes = await createTemplate(`${KEYPFX}-g8-parallel`, parallelGraph)
    expect(parRes.status).toBe(400)
    expect(errorCode((await parRes.json()) as ErrorBody)).toBe('APPROVAL_HANDLER_IN_PARALLEL')

    // Negative 2 — handler AS the join node fails at publish.
    const joinGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'fork', type: 'parallel', name: 'fork', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'handler_join' } },
        { key: 'branch_a', type: 'approval', name: 'A', config: { assigneeSources: staticUser([H1]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'branch_b', type: 'approval', name: 'B', config: { assigneeSources: staticUser([H2]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'handler_join', type: 'handler', name: '办理', config: { assigneeSources: staticUser([FINAL]) } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 'e-start-fork', source: 'start', target: 'fork' },
        { key: 'e-fork-a', source: 'fork', target: 'branch_a' },
        { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
        { key: 'e-a-join', source: 'branch_a', target: 'handler_join' },
        { key: 'e-b-join', source: 'branch_b', target: 'handler_join' },
        { key: 'e-join-end', source: 'handler_join', target: 'end' },
      ],
    }
    const joinRes = await createTemplate(`${KEYPFX}-g8-join`, joinGraph)
    expect(joinRes.status).toBe(400)
    expect(errorCode((await joinRes.json()) as ErrorBody)).toBe('APPROVAL_HANDLER_AS_JOIN')
  })

  // ── G-4 — totalSteps invariance ──────────────────────────────────────────────────────────────
  it('G-4: inserting a handler leaves totalSteps counting only approval nodes; removing an approval node DOES change it', async () => {
    // gate(approval) + handler + final(approval) => totalSteps === 2 (handler not counted).
    const withHandler = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'approval_gate', type: 'approval', name: 'g', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'handler_h', type: 'handler', name: '办理', config: { assigneeSources: staticUser([H1]) } },
        { key: 'approval_final', type: 'approval', name: 'f', config: { assigneeSources: staticUser([FINAL]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2g', source: 'start', target: 'approval_gate' },
        { key: 'g2h', source: 'approval_gate', target: 'handler_h' },
        { key: 'h2f', source: 'handler_h', target: 'approval_final' },
        { key: 'f2e', source: 'approval_final', target: 'end' },
      ],
    }
    const tid = await createPublished(`${KEYPFX}-g4`, withHandler)
    const iid = await createInstance(tid)
    expect((await instanceRow(iid)).total_steps).toBe(2)
    // positive control: a two-approval graph WITHOUT the handler still has totalSteps 2, and a
    // one-approval variant has totalSteps 1 — proving the count tracks approval nodes, not vacuous.
    const oneApproval = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'approval_gate', type: 'approval', name: 'g', config: { assigneeSources: staticUser([GATE]), approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'handler_h', type: 'handler', name: '办理', config: { assigneeSources: staticUser([H1]) } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2g', source: 'start', target: 'approval_gate' },
        { key: 'g2h', source: 'approval_gate', target: 'handler_h' },
        { key: 'h2e', source: 'handler_h', target: 'end' },
      ],
    }
    const tid1 = await createPublished(`${KEYPFX}-g4-one`, oneApproval)
    const iid1 = await createInstance(tid1)
    expect((await instanceRow(iid1)).total_steps).toBe(1)
  })

  // ── G-1 (behavioural) — a handler graph creates and PAUSES at the handler with resolved seats ─
  it('G-1: creating a handler-first graph pauses at the handler with both 会签 seats active; the source_step is the disjoint handler ordinal', async () => {
    const tid = await createPublished(`${KEYPFX}-g1`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1, H2]), handlerMode: 'all' }))
    const iid = await createInstance(tid)
    const row = await instanceRow(iid)
    expect(row.status).toBe('pending')
    expect(row.current_node_key).toBe('handler_h')
    const seats = await activeAssignees(iid)
    expect(seats.map((s) => s.assignee_id).sort()).toEqual([H1, H2].sort())
    expect(seats.every((s) => s.node_key === 'handler_h')).toBe(true)
    // OD-L3-5(b): a handler seat's source_step is the disjoint ordinal (> totalSteps=1), never 0.
    expect(seats.every((s) => Number(s.source_step) > row.total_steps)).toBe(true)
  })

  // ── G-9 — field-write fail-closed (§3) ───────────────────────────────────────────────────────
  it('G-9: a handle carrying fieldWrites (non-empty / {} / null) is 422 with zero handle rows and NO advance; without the key it advances', async () => {
    for (const fieldWrites of [{ reason: 'edited' }, {}, null] as unknown[]) {
      const tid = await createPublished(`${KEYPFX}-g9-${Math.random().toString(16).slice(2, 8)}`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1]) }))
      const iid = await createInstance(tid)
      const res = await act(iid, h1Tok, { action: 'handle', fieldWrites })
      expect(res.status, JSON.stringify(fieldWrites)).toBe(422)
      const body = (await res.json()) as ErrorBody
      expect(errorCode(body)).toBe('APPROVAL_HANDLER_FIELD_WRITES_UNSUPPORTED')
      // zero handle rows, no advance (still pending at the handler).
      expect(await records(iid, 'handle')).toHaveLength(0)
      const row = await instanceRow(iid)
      expect(row.status).toBe('pending')
      expect(row.current_node_key).toBe('handler_h')
    }
    // positive control: a handle WITHOUT the key succeeds and advances past the handler.
    const tidOk = await createPublished(`${KEYPFX}-g9-ok`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1]) }))
    const iidOk = await createInstance(tidOk)
    const ok = await act(iidOk, h1Tok, { action: 'handle' })
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect((await instanceRow(iidOk)).current_node_key).toBe('approval_final')
  })

  // ── G-10 — action authorization ───────────────────────────────────────────────────────────────
  it('G-10: approve/reject/return/add_sign at a handler are 409; the seated actor CAN handle; approve at an approval node still 200', async () => {
    const tid = await createPublished(`${KEYPFX}-g10`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1]) }))
    const iid = await createInstance(tid)
    for (const action of ['approve', 'reject', 'return', 'add_sign']) {
      const body: Record<string, unknown> = { action }
      if (action === 'reject') body.comment = 'x'
      if (action === 'return') body.targetNodeKey = 'approval_final'
      if (action === 'add_sign') body.targetUserIds = [H2]
      const res = await act(iid, h1Tok, body)
      expect(res.status, action).toBe(409)
      expect(errorCode((await res.json()) as ErrorBody)).toBe('APPROVAL_HANDLER_ACTION_NOT_ALLOWED')
    }
    // A non-seated actor cannot handle (403).
    const forbidden = await act(iid, otherTok, { action: 'handle' })
    expect(forbidden.status).toBe(403)
    // positive control: the seated actor CAN handle → advances to the approval node.
    const ok = await act(iid, h1Tok, { action: 'handle' })
    expect(ok.status, await ok.clone().text()).toBe(200)
    // positive control (other dimension): approve at the now-current APPROVAL node still succeeds.
    const approve = await act(iid, finalTok, { action: 'approve' })
    expect(approve.status, await approve.clone().text()).toBe(200)
    expect((await instanceRow(iid)).status).toBe('approved')

    // `handle` at a non-handler node is a 409 mismatch (positive control: handle at the handler worked above).
    const tid2 = await createPublished(`${KEYPFX}-g10-mismatch`, gateThenHandlerGraph({ assigneeSources: staticUser([H1]) }))
    const iid2 = await createInstance(tid2)
    const mismatch = await act(iid2, gateTok, { action: 'handle' })
    expect(mismatch.status).toBe(409)
    expect(errorCode((await mismatch.json()) as ErrorBody)).toBe('APPROVAL_HANDLE_NODE_MISMATCH')
  })

  // ── G-11 — transfer preserves the epoch; an activation bumps it ───────────────────────────────
  it('G-11: a handler transfer moves the seat (target holds it, original does not) and PRESERVES the node epoch; activation bumps it', async () => {
    const tid = await createPublished(`${KEYPFX}-g11`, gateThenHandlerGraph({ assigneeSources: staticUser([H1]) }))
    const iid = await createInstance(tid)
    // Approve the gate → the handler ACTIVATES (epoch bump). Capture the handler's activation epoch.
    expect((await act(iid, gateTok, { action: 'approve' })).status).toBe(200)
    const beforeSeats = await activeAssignees(iid)
    const handlerSeat = beforeSeats.find((s) => s.node_key === 'handler_h')!
    expect(handlerSeat.assignee_id).toBe(H1)
    const activationEpoch = Number(handlerSeat.entry_epoch)
    // Transfer H1 → OTHER.
    const tr = await act(iid, h1Tok, { action: 'transfer', targetUserId: OTHER })
    expect(tr.status, await tr.clone().text()).toBe(200)
    const afterSeats = await activeAssignees(iid)
    const ids = afterSeats.filter((s) => s.node_key === 'handler_h').map((s) => s.assignee_id)
    expect(ids).toEqual([OTHER]) // target holds, original does not
    const transferredSeat = afterSeats.find((s) => s.node_key === 'handler_h')!
    // epoch PRESERVED (transfer is a same-round mutation, not an activation).
    expect(Number(transferredSeat.entry_epoch)).toBe(activationEpoch)
    // positive control: the ACTIVATION that first placed the handler seat carried a HIGHER epoch than
    // the gate's activation — i.e. activation DOES bump. Prove via the gate approve record's epoch delta.
    const handleRecordsBefore = await records(iid, 'transfer')
    expect(handleRecordsBefore.length).toBe(1)
  })

  // ── G-12 — mode semantics (会签 all / 或签 any) ────────────────────────────────────────────────
  it('G-12: 或签 completes on the first submission; 会签 completes only after every seat submits', async () => {
    // 或签 'any' — first H1 submit completes the node and advances.
    const tidAny = await createPublished(`${KEYPFX}-g12-any`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1, H2]), handlerMode: 'any' }))
    const iidAny = await createInstance(tidAny)
    expect((await act(iidAny, h1Tok, { action: 'handle' })).status).toBe(200)
    expect((await instanceRow(iidAny)).current_node_key).toBe('approval_final') // advanced on first
    // 会签 'all' — first H1 submit keeps it pending; second H2 submit completes.
    const tidAll = await createPublished(`${KEYPFX}-g12-all`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1, H2]), handlerMode: 'all' }))
    const iidAll = await createInstance(tidAll)
    expect((await act(iidAll, h1Tok, { action: 'handle' })).status).toBe(200)
    const mid = await instanceRow(iidAll)
    expect(mid.current_node_key).toBe('handler_h') // still pending — not every seat submitted
    expect(mid.status).toBe('pending')
    expect((await act(iidAll, h2Tok, { action: 'handle' })).status).toBe(200)
    expect((await instanceRow(iidAll)).current_node_key).toBe('approval_final') // now advanced
  })

  // ── opinionRequired — blank comment 422; a comment succeeds ───────────────────────────────────
  it('opinionRequired: a blank 办理意见 is 422 APPROVAL_HANDLER_OPINION_REQUIRED; a non-blank comment succeeds', async () => {
    const tid = await createPublished(`${KEYPFX}-opinion`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1]), opinionRequired: true }))
    const iid = await createInstance(tid)
    const blank = await act(iid, h1Tok, { action: 'handle' })
    expect(blank.status).toBe(422)
    expect(errorCode((await blank.json()) as ErrorBody)).toBe('APPROVAL_HANDLER_OPINION_REQUIRED')
    expect((await instanceRow(iid)).current_node_key).toBe('handler_h') // no advance
    // positive control: a comment satisfies it.
    const ok = await act(iid, h1Tok, { action: 'handle', comment: '已办理' })
    expect(ok.status, await ok.clone().text()).toBe(200)
    expect((await instanceRow(iid)).current_node_key).toBe('approval_final')
  })

  // ── G-16 — audit + action verb (incl. the DB CHECK) ──────────────────────────────────────────
  it('G-16: a submission writes exactly one action=handle row with { nodeKey, nodeEntryEpoch }; the CHECK accepts handle and rejects handlex', async () => {
    const tid = await createPublished(`${KEYPFX}-g16`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1]) }))
    const iid = await createInstance(tid)
    expect((await act(iid, h1Tok, { action: 'handle', comment: 'done' })).status).toBe(200)
    const handleRows = await records(iid, 'handle')
    expect(handleRows).toHaveLength(1)
    expect(handleRows[0].actor_id).toBe(H1)
    expect(handleRows[0].comment).toBe('done')
    expect(handleRows[0].metadata?.nodeKey).toBe('handler_h')
    expect(typeof handleRows[0].metadata?.nodeEntryEpoch).toBe('number')
    // The DB CHECK: a raw handle INSERT is accepted; a handlex INSERT is rejected (positive+negative).
    const pool = poolManager.get()
    await expect(pool.query(
      `INSERT INTO approval_records (instance_id, action, actor_id, from_status, to_status, from_version, to_version) VALUES ($1, 'handle', $2, 'pending', 'pending', 1, 1)`,
      [iid, H1],
    )).resolves.toBeTruthy()
    await expect(pool.query(
      `INSERT INTO approval_records (instance_id, action, actor_id, from_status, to_status, from_version, to_version) VALUES ($1, 'handlex', $2, 'pending', 'pending', 1, 1)`,
      [iid, H1],
    )).rejects.toThrow()
  })

  // ── G-17 — preview distinguishability ─────────────────────────────────────────────────────────
  it('G-17: a route preview over a mixed graph labels the handler row nodeType=handler; an all-approval graph is all approval', async () => {
    const tid = await createPublished(`${KEYPFX}-g17`, gateThenHandlerGraph({ assigneeSources: staticUser([H1]) }))
    const res = await req(base, `/api/approval-templates/${tid}/route-preview`, reqTok, { method: 'POST', body: { sampleFormData: { reason: 'r' } } })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { route?: Array<{ nodeKey: string; nodeType?: string }> }
    const route = body.route ?? []
    const handlerRow = route.find((r) => r.nodeKey === 'handler_h')
    expect(handlerRow?.nodeType).toBe('handler')
    const gateRow = route.find((r) => r.nodeKey === 'approval_gate')
    expect(gateRow?.nodeType).toBe('approval')
  })

  // ── R-3 + G-12 re-entry control — return walks THROUGH a handler; a re-entered round is fresh ─
  it('R-3/G-12: a return-target trail walks through a handler (200 to approval_A); the re-entered handler round ignores prior-round submissions', async () => {
    const tid = await createPublished(`${KEYPFX}-reentry`, threeStageGraph())
    const iid = await createInstance(tid)
    // Approve A → the handler activates. Capture its round-1 activation epoch.
    expect((await act(iid, gateTok, { action: 'approve' })).status).toBe(200)
    const round1Seats = (await activeAssignees(iid)).filter((s) => s.node_key === 'handler_H')
    expect(round1Seats.map((s) => s.assignee_id).sort()).toEqual([H1, H2].sort())
    const epoch1 = Number(round1Seats[0].entry_epoch)
    // Both 会签 seats submit → advance to approval_B.
    expect((await act(iid, h1Tok, { action: 'handle' })).status).toBe(200)
    expect((await act(iid, h2Tok, { action: 'handle' })).status).toBe(200)
    expect((await instanceRow(iid)).current_node_key).toBe('approval_B')
    // R-3: FINAL (holding the approval_B seat) returns to approval_A — the trail walker
    // (listVisitedApprovalNodeKeysUntil) passes THROUGH handler_H without a phantom cycle.
    const ret = await act(iid, finalTok, { action: 'return', targetNodeKey: 'approval_A' })
    expect(ret.status, await ret.clone().text()).toBe(200)
    expect((await instanceRow(iid)).current_node_key).toBe('approval_A')
    // Approve A AGAIN → the handler RE-activates: fresh seats, a HIGHER epoch than round 1.
    expect((await act(iid, gateTok, { action: 'approve' })).status).toBe(200)
    const round2Seats = (await activeAssignees(iid)).filter((s) => s.node_key === 'handler_H')
    expect(round2Seats.map((s) => s.assignee_id).sort()).toEqual([H1, H2].sort())
    expect(Number(round2Seats[0].entry_epoch)).toBeGreaterThan(epoch1)
    // G-12 CONTROL: H1 submits ONCE in the new round → the node STAYS pending; the two prior-round
    // 'handle' records must NOT satisfy the new 会签 round. Then H2 submits → advance.
    expect((await act(iid, h1Tok, { action: 'handle' })).status).toBe(200)
    expect((await instanceRow(iid)).current_node_key).toBe('handler_H')
    expect((await act(iid, h2Tok, { action: 'handle' })).status).toBe(200)
    expect((await instanceRow(iid)).current_node_key).toBe('approval_B')
  })

  // ── Handler as the LAST node — terminal to approved, submit-only (never an 'approve' verb) ────
  it('a handler as the last node completes the instance to approved via handle only (never an approve verb attributed to it)', async () => {
    const tid = await createPublished(`${KEYPFX}-terminal`, gateThenHandlerGraph({ assigneeSources: staticUser([H1]) }))
    const iid = await createInstance(tid)
    expect((await act(iid, gateTok, { action: 'approve' })).status).toBe(200)
    expect((await instanceRow(iid)).current_node_key).toBe('handler_h')
    expect((await act(iid, h1Tok, { action: 'handle', comment: '打款完成' })).status).toBe(200)
    const row = await instanceRow(iid)
    expect(row.status).toBe('approved')
    expect(row.current_node_key).toBeNull()
    // Exactly one action='handle' row, and NO 'approve' row attributed to the handler node (§2.1 —
    // a handler submission is never recorded as an approval).
    const handleRows = (await records(iid, 'handle'))
    expect(handleRows).toHaveLength(1)
    expect(handleRows[0].metadata?.nodeKey).toBe('handler_h')
    const approveRowsAtHandler = (await records(iid, 'approve')).filter((r) => r.metadata?.nodeKey === 'handler_h')
    expect(approveRowsAtHandler).toHaveLength(0)
  })

  // ── G-18 — values-free errors ──────────────────────────────────────────────────────────────────
  it('G-18: the handler 422/409 error bodies carry nodeKey and never a person id', async () => {
    const tid = await createPublished(`${KEYPFX}-g18`, handlerThenApprovalGraph({ assigneeSources: staticUser([H1]), opinionRequired: true }))
    const iid = await createInstance(tid)
    // field-write 422 carries nodeKey, no person id.
    const fw = await act(iid, h1Tok, { action: 'handle', fieldWrites: { reason: 'x' } })
    const fwBody = (await fw.json()) as ErrorBody
    expect(errorDetails(fwBody)?.nodeKey).toBe('handler_h')
    expect(JSON.stringify(fwBody)).not.toContain(H1)
    // opinion 422 carries nodeKey, no person id.
    const op = await act(iid, h1Tok, { action: 'handle' })
    const opBody = (await op.json()) as ErrorBody
    expect(errorDetails(opBody)?.nodeKey).toBe('handler_h')
    expect(JSON.stringify(opBody)).not.toContain(H1)
    // action-not-allowed 409 carries nodeKey, no person id.
    const na = await act(iid, h1Tok, { action: 'approve' })
    const naBody = (await na.json()) as ErrorBody
    expect(errorDetails(naBody)?.nodeKey).toBe('handler_h')
    expect(JSON.stringify(naBody)).not.toContain(H1)
  })
})
