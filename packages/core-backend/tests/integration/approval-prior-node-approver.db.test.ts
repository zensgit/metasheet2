import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { query } from '../../src/db/pg'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-1 §K3 `prior_node_approver` (节点审批人) — REAL-DB end-to-end acceptance
 * (docs/development/approval-lock1-enterprise-assignees-20260817.md §K3; gates G-1/G-2/G-10/
 * G-11/G-12/G-18 + OD-L1-3(a) LATEST-round scoping + OD-L1-4(a) skipped/empty fall-through +
 * freeze-of-the-RULE). Harness mirrors approval-dept-head-at-level.db.test.ts (K5-b), but this
 * kind needs NO directory fixture at all: resolution is INSTANCE-INTERNAL (audit-row actors),
 * never a directory read — the absence of any directory_* setup here is itself the point.
 *
 * Proves:
 *  G-1        authoring choke: missing/empty nodeKey and an unknown extra key each 400 naming the
 *             structural source path; a valid shape saves (positive control). A DANGLING reference
 *             is draft-SAVEABLE but publish-REJECTED — the dominance gate is publish-scoped.
 *  G-10       upstream legality at publish: dangling / downstream / self references 400
 *             (APPROVAL_ASSIGNEE_PRIOR_NODE_REFERENCE_INVALID, values-free: node keys + reason,
 *             never a person id); the legal upstream reference publishes (positive control —
 *             every other test in this file publishes one).
 *  happy path prior node approved by X → the referencing node assigns EXACTLY X, with the §2.6
 *             audit trail (resolvedFrom.kind/priorNodeKey) on the assignment row. This is ALSO
 *             the in-flight-merge proof: X's own approve record is inserted after resolution, so
 *             the caller-side merge is what carried X into the map.
 *  multi-seat 会签 (all): BOTH actual deciders (partial-vote audit row + in-flight actor) are
 *             assigned; 或签 (any): ONLY the acting decider is — "ACTUAL deciders", never the
 *             configured seat list.
 *  OD-L1-3(a) LATEST round only: after a return re-activates the referenced node and a DIFFERENT
 *             seat decides round 2, the referencing node assigns the round-2 decider only.
 *  OD-L1-4(a) skipped/empty fail-closed: an admin-jump PAST the referenced node (never decided)
 *             fails 400 APPROVAL_ASSIGNEE_EMPTY under emptyAssigneePolicy 'error' — and a
 *             create-time auto-approval cascade reaching the referencing node behaves the same
 *             ('error' ⇒ create fails with ZERO rows; 'auto-approve' ⇒ the instance completes
 *             with an EXPLICIT audited auto-approval record and no `system:*` assignee row —
 *             never a silent nobody). NOTE: this create-time arm resolves against an ABSENT
 *             `priorNodeApprovers` map (§K3: the map is never built on the create path), so it
 *             does not exercise the sentinel-drop filter itself — see G-11 below for the arms that
 *             do.
 *  G-11       two arms, over a genuine dispatch-path transaction (not create-time):
 *             (a) sentinel-drop: the referenced node auto-approves under `system:auto-approval` at
 *             CREATE (a COMMITTED, separate transaction — the cascade halts at a REAL human node
 *             before ever reaching the referencing node, unlike the OD-L1-4(a) arm above); the
 *             referencing node activates LATER, on the acting decider's OWN approve — EMPTY
 *             resolution, no `system:*` assignee row, audited auto-approval instead. Mutation
 *             note: this arm alone cannot distinguish "the map was built and filtered" from "the
 *             map was never built" — both look EMPTY (verified: gutting the dispatch call site
 *             leaves it green). (b) human-survivor reachability: the SAME graph, but the
 *             referencing node names BOTH the sentinel-only node AND a REAL decider in its
 *             `assigneeSources` — the real decider MUST survive resolution, which requires
 *             `loadPriorNodeApproverDeciders` to have genuinely run (a gutted call site drops the
 *             survivor too, mutation-verified) — the arm that actually carries reachability.
 *  G-12       no cross-node dedup: the SAME person approves at the prior node and AGAIN at the
 *             referencing node (intra-node dedup is unit-covered).
 *  freeze     the RULE is frozen with the instance's pinned published definition: re-publishing
 *             a v2 that changes the node's sources does NOT alter an in-flight instance's
 *             resolution (v1 semantics discriminated against v2's).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `pna-req-${TS}`
const DECIDER_A = `pna-a-${TS}`
const DECIDER_B = `pna-b-${TS}`
const MID = `pna-mid-${TS}`

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

// start -> gate (configurable seats/mode) -> again (prior_node_approver ref 'gate') -> end.
function pnaGraph(options: {
  gateSources?: Array<Record<string, unknown>>
  gateMode?: 'single' | 'all' | 'any'
  againSources?: Array<Record<string, unknown>>
  againPolicy?: 'error' | 'auto-approve'
  gateAutoApproval?: Record<string, unknown>
} = {}) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      {
        key: 'gate', type: 'approval', name: 'gate',
        config: {
          assigneeSources: options.gateSources ?? [{ kind: 'static_user', userIds: [DECIDER_A] }],
          approvalMode: options.gateMode ?? 'single',
          emptyAssigneePolicy: 'error',
          ...(options.gateAutoApproval ? { autoApprovalPolicy: options.gateAutoApproval } : {}),
        },
      },
      {
        key: 'again', type: 'approval', name: 'again',
        config: {
          assigneeSources: options.againSources ?? [{ kind: 'prior_node_approver', nodeKey: 'gate' }],
          approvalMode: 'single',
          emptyAssigneePolicy: options.againPolicy ?? 'error',
        },
      },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2g', source: 'start', target: 'gate' },
      { key: 'g2a', source: 'gate', target: 'again' },
      { key: 'a2e', source: 'again', target: 'end' },
    ],
  }
}

// start -> gate(any A,B) -> mid(MID) -> again (prior 'gate') -> end — the return/round fixture,
// and (with a jump) the skipped-node fixture referencing 'mid'.
function fourNodeGraph(againRef: 'gate' | 'mid') {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'gate', type: 'approval', name: 'gate', config: { assigneeSources: [{ kind: 'static_user', userIds: [DECIDER_A, DECIDER_B] }], approvalMode: 'any', emptyAssigneePolicy: 'error' } },
      { key: 'mid', type: 'approval', name: 'mid', config: { assigneeSources: [{ kind: 'static_user', userIds: [MID] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'again', type: 'approval', name: 'again', config: { assigneeSources: [{ kind: 'prior_node_approver', nodeKey: againRef }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2g', source: 'start', target: 'gate' },
      { key: 'g2m', source: 'gate', target: 'mid' },
      { key: 'm2a', source: 'mid', target: 'again' },
      { key: 'a2e', source: 'again', target: 'end' },
    ],
  }
}

type ErrorBody = { code?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } }
function errorCode(body: ErrorBody): string | undefined {
  return body.code ?? body.error?.code
}

// K2-precedent anti-skip-green sentinel: TOP-LEVEL (not inside describeIfDatabase — there it
// would be skipped exactly when it should fire). Armed by EXPECT_DB=1 in the
// approval-realdb-acceptance.yml lane: a DB-expected run with a missing DATABASE_URL goes RED
// instead of silently skip-greening the whole suite. Unarmed no-DB collection skips cleanly.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('Lock-1 §K3 prior_node_approver — real-DB publish/dispatch acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let aTok = ''
  let bTok = ''
  let midTok = ''

  async function createTemplate(key: string, graph: unknown): Promise<string> {
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: graph },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { id: string }).id
  }
  async function publishTemplate(tid: string): Promise<Response> {
    return req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })
  }
  async function createPublished(key: string, graph: unknown): Promise<string> {
    const tid = await createTemplate(key, graph)
    const published = await publishTemplate(tid)
    expect(published.status, await published.clone().text()).toBe(200)
    return tid
  }
  async function activeAssignees(iid: string, nodeKey: string): Promise<Array<{ assignee_id: string; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(
      `SELECT assignee_id, metadata FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE ORDER BY assignee_id`,
      [iid, nodeKey],
    )
    return rows.rows as Array<{ assignee_id: string; metadata: Record<string, unknown> | null }>
  }
  async function createAsReq(tid: string): Promise<{ status: number; iid?: string; text: string }> {
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    const text = await started.clone().text()
    if (started.status >= 300) return { status: started.status, text }
    return { status: started.status, iid: ((await started.json()) as { id: string }).id, text }
  }
  async function act(iid: string, token: string, body: Record<string, unknown>): Promise<Response> {
    return req(base, `/api/approvals/${iid}/actions`, token, { method: 'POST', body })
  }
  async function instanceVersion(iid: string): Promise<number> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT version FROM approval_instances WHERE id = $1`, [iid])
    return Number(rows.rows[0].version)
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    for (const u of [REQ, DECIDER_A, DECIDER_B, MID]) {
      await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`, [u, `${u}@example.test`])
    }
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    aTok = await tok(base, DECIDER_A)
    bTok = await tok(base, DECIDER_B)
    midTok = await tok(base, MID)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`pna-${TS}-%`])).rows.map((r) => r.id as string)
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
      await query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, DECIDER_A, DECIDER_B, MID]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  // ── G-1 — authoring choke: exact shape ───────────────────────────────────────────────────────
  it('G-1: prior_node_approver saves with a valid shape; missing/empty nodeKey and an unknown extra key each 400 naming the structural source path (G-18: no person id)', async () => {
    // Positive control FIRST: a valid shape saves as a draft.
    const okTid = await createTemplate(`pna-${TS}-g1-ok`, pnaGraph())
    expect(okTid).toBeTruthy()

    const badSources: Array<Record<string, unknown>> = [
      { kind: 'prior_node_approver' }, // nodeKey missing
      { kind: 'prior_node_approver', nodeKey: '' }, // empty
      { kind: 'prior_node_approver', nodeKey: '   ' }, // blank
      { kind: 'prior_node_approver', nodeKey: 'gate', futureFlag: true }, // unknown extra key
    ]
    for (const source of badSources) {
      const graph = pnaGraph({ againSources: [source] })
      const res = await req(base, '/api/approval-templates', reqTok, {
        method: 'POST',
        body: { key: `pna-${TS}-g1-bad`, name: 'bad', formSchema: FORM_SCHEMA, approvalGraph: graph },
      })
      expect(res.status, JSON.stringify(source)).toBe(400)
      const raw = await res.clone().text()
      // G-18: values-free — the message carries the structural source path (template-authored,
      // §2.6-permitted), never a person id (none was supplied for a shape rejection).
      expect(raw).toContain('assigneeSources[0]')
    }
  })

  // ── G-2 — not-yet-implemented is not inert (positive control: this slice's kind persists) ────
  it('G-2: a contract-unimplemented kind (user_group / K1, not landed at this baseline) is rejected at authoring, never persisted', async () => {
    const graph = pnaGraph({ againSources: [{ kind: 'user_group', groupIds: ['g1'] }] })
    const key = `pna-${TS}-g2-unimplemented`
    const res = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: graph },
    })
    expect(res.status).toBe(400)
    const rows = await query(`SELECT id FROM approval_templates WHERE key = $1`, [key])
    expect(rows.rows).toHaveLength(0)
    // Positive control: prior_node_approver (this slice's implemented kind) persists — G-1 above.
  })

  // ── G-10 — upstream legality: the dominance gate is PUBLISH-scoped, values-free ─────────────
  it('G-10: a DANGLING reference is draft-saveable but publish-rejected; DOWNSTREAM and SELF references publish-reject too; the reason + node keys are in the body, no person id (G-18)', async () => {
    // Dangling: draft save OK (stored drafts stay fixable), publish 400.
    const danglingTid = await createTemplate(`pna-${TS}-g10-dangling`, pnaGraph({ againSources: [{ kind: 'prior_node_approver', nodeKey: 'nope' }] }))
    const danglingPub = await publishTemplate(danglingTid)
    const danglingText = await danglingPub.clone().text()
    expect(danglingPub.status, danglingText).toBe(400)
    expect(errorCode(JSON.parse(danglingText) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_PRIOR_NODE_REFERENCE_INVALID')
    expect(danglingText).toContain('again')
    expect(danglingText).toContain('nope')

    // Downstream: gate references 'again' (which is after it).
    const downstreamTid = await createTemplate(`pna-${TS}-g10-downstream`, pnaGraph({
      gateSources: [{ kind: 'prior_node_approver', nodeKey: 'again' }],
      againSources: [{ kind: 'static_user', userIds: [DECIDER_A] }],
    }))
    const downstreamPub = await publishTemplate(downstreamTid)
    const downstreamText = await downstreamPub.clone().text()
    expect(downstreamPub.status, downstreamText).toBe(400)
    expect(errorCode(JSON.parse(downstreamText) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_PRIOR_NODE_REFERENCE_INVALID')

    // Self.
    const selfTid = await createTemplate(`pna-${TS}-g10-self`, pnaGraph({ againSources: [{ kind: 'prior_node_approver', nodeKey: 'again' }] }))
    const selfPub = await publishTemplate(selfTid)
    expect(selfPub.status, await selfPub.clone().text()).toBe(400)

    // Positive control: the legal upstream reference publishes (the same shape every dispatch
    // test below relies on).
    const legalTid = await createTemplate(`pna-${TS}-g10-legal`, pnaGraph())
    const legalPub = await publishTemplate(legalTid)
    expect(legalPub.status, await legalPub.clone().text()).toBe(200)
  })

  // ── Happy path + G-12 no-dedup + audit trail ─────────────────────────────────────────────────
  it('happy path: gate approved by A → `again` assigns EXACTLY A with resolvedFrom.priorNodeKey audit; the SAME person then approves again at `again` (G-12 no cross-node dedup) and the instance completes', async () => {
    const tid = await createPublished(`pna-${TS}-happy`, pnaGraph())
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    const gateApprove = await act(iid, aTok, { action: 'approve' })
    expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)

    const assignees = await activeAssignees(iid, 'again')
    expect(assignees.map((a) => a.assignee_id)).toEqual([DECIDER_A])
    const resolvedFrom = (assignees[0].metadata as { resolvedFrom?: { kind?: string; priorNodeKey?: string } } | null)?.resolvedFrom
    expect(resolvedFrom?.kind).toBe('prior_node_approver')
    expect(resolvedFrom?.priorNodeKey).toBe('gate')

    // G-12: the same person approves AGAIN at the referencing node — no cross-node dedup.
    const againApprove = await act(iid, aTok, { action: 'approve' })
    expect(againApprove.status, await againApprove.clone().text()).toBeLessThan(300)
    const finalStatus = await query(`SELECT status FROM approval_instances WHERE id = $1`, [iid])
    expect(finalStatus.rows[0].status).toBe('approved')
  })

  // ── Multi-seat semantics: ACTUAL deciders, not the configured seat list ──────────────────────
  it('multi-seat 会签 (all): BOTH actual deciders assign at `again` (persisted partial vote + in-flight actor compose); 或签 (any): ONLY the acting decider does', async () => {
    // all-mode: A approves (partial, committed as an audit row), then B approves (completes —
    // B rides the in-flight merge). `again` = [A, B].
    const allTid = await createPublished(`pna-${TS}-all`, pnaGraph({ gateSources: [{ kind: 'static_user', userIds: [DECIDER_A, DECIDER_B] }], gateMode: 'all' }))
    const allStarted = await createAsReq(allTid)
    expect(allStarted.status, allStarted.text).toBe(201)
    const allIid = allStarted.iid!
    const firstVote = await act(allIid, aTok, { action: 'approve' })
    expect(firstVote.status, await firstVote.clone().text()).toBeLessThan(300)
    expect(await activeAssignees(allIid, 'again')).toHaveLength(0) // partial: node not resolved yet
    const secondVote = await act(allIid, bTok, { action: 'approve' })
    expect(secondVote.status, await secondVote.clone().text()).toBeLessThan(300)
    const allAssignees = await activeAssignees(allIid, 'again')
    expect(allAssignees.map((a) => a.assignee_id).sort()).toEqual([DECIDER_A, DECIDER_B].sort())

    // any-mode: A approves first — B never acted, so B is NOT an "actual decider".
    const anyTid = await createPublished(`pna-${TS}-any`, pnaGraph({ gateSources: [{ kind: 'static_user', userIds: [DECIDER_A, DECIDER_B] }], gateMode: 'any' }))
    const anyStarted = await createAsReq(anyTid)
    expect(anyStarted.status, anyStarted.text).toBe(201)
    const anyIid = anyStarted.iid!
    const anyVote = await act(anyIid, aTok, { action: 'approve' })
    expect(anyVote.status, await anyVote.clone().text()).toBeLessThan(300)
    expect((await activeAssignees(anyIid, 'again')).map((a) => a.assignee_id)).toEqual([DECIDER_A])
  })

  // ── OD-L1-3(a) — LATEST round only ───────────────────────────────────────────────────────────
  it('round scoping (OD-L1-3(a)): after a return re-activates the referenced node and a DIFFERENT seat decides round 2, `again` assigns the round-2 decider ONLY (round-1 votes never leak in)', async () => {
    const tid = await createPublished(`pna-${TS}-rounds`, fourNodeGraph('gate'))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    // Round 1: A decides gate (any-mode). mid activates.
    const round1 = await act(iid, aTok, { action: 'approve' })
    expect(round1.status, await round1.clone().text()).toBeLessThan(300)
    // MID returns to gate → round 2 (fresh epoch; round-1 records now belong to a stale round).
    const returned = await act(iid, midTok, { action: 'return', targetNodeKey: 'gate' })
    expect(returned.status, await returned.clone().text()).toBeLessThan(300)
    // Round 2: B decides gate this time.
    const round2 = await act(iid, bTok, { action: 'approve' })
    expect(round2.status, await round2.clone().text()).toBeLessThan(300)
    // mid again, then advance to `again`.
    const midApprove = await act(iid, midTok, { action: 'approve' })
    expect(midApprove.status, await midApprove.clone().text()).toBeLessThan(300)

    // LATEST round only: B — the round-2 decider — and NOT A (round 1).
    expect((await activeAssignees(iid, 'again')).map((a) => a.assignee_id)).toEqual([DECIDER_B])
  })

  // ── OD-L1-4(a) — skipped referenced node fails closed (never silent) ─────────────────────────
  it('skipped node (OD-L1-4(a)): an admin jump PAST the never-decided referenced node fails 400 APPROVAL_ASSIGNEE_EMPTY under `error` (values-free, names the node); the normal un-skipped flow through the SAME graph resolves (positive control)', async () => {
    const tid = await createPublished(`pna-${TS}-skip`, fourNodeGraph('mid'))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    // Instance sits at gate; jump straight to `again`, skipping mid (never decided).
    const version = await instanceVersion(iid)
    const jump = await req(base, `/api/approvals/${iid}/jump`, reqTok, {
      method: 'POST',
      body: { version, targetNodeKey: 'again', reason: 'skip-mid probe' },
    })
    const jumpText = await jump.clone().text()
    expect(jump.status, jumpText).toBe(400)
    expect(errorCode(JSON.parse(jumpText) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_EMPTY')
    expect(jumpText).toContain('again')
    // Fail-closed: the failed jump left the instance pending at gate with zero `again` rows.
    expect(await activeAssignees(iid, 'again')).toHaveLength(0)

    // Positive control (the same graph, un-skipped): gate → mid → `again` assigns MID.
    const gateApprove = await act(iid, aTok, { action: 'approve' })
    expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)
    const midApprove = await act(iid, midTok, { action: 'approve' })
    expect(midApprove.status, await midApprove.clone().text()).toBeLessThan(300)
    expect((await activeAssignees(iid, 'again')).map((a) => a.assignee_id)).toEqual([MID])
  })

  // ── OD-L1-4(a) — create-time cascade reaching the referencing node ───────────────────────────
  // NOTE: this arm's `again` resolves against an ABSENT `priorNodeApprovers` map (the create path
  // never builds one — §K3), so it does NOT exercise the sentinel-drop filter (G-11's actual
  // reachability leg is below, "service-door reachability (G-11)"). Kept for OD-L1-4(a) coverage.
  it('auto-approved referenced node: a create-time cascade reaching `again` fails the create 400 with ZERO rows under `error`; under an explicit `auto-approve` the instance completes with an AUDITED auto-approval record and NO system:* assignee row (never silent, OD-L1-4(a))', async () => {
    // gate resolves to the requester + mergeWithRequester → auto-approved at create (sentinel
    // decider) → `again` activates during the create cascade with no persisted round.
    const cascadeGraph = (againPolicy: 'error' | 'auto-approve') => pnaGraph({
      gateSources: [{ kind: 'requester' }],
      gateAutoApproval: { mergeWithRequester: true },
      againPolicy,
    })

    // 'error': fail-closed create — 400 APPROVAL_ASSIGNEE_EMPTY, zero instance rows.
    const errorTid = await createPublished(`pna-${TS}-cascade-err`, cascadeGraph('error'))
    const preCount = await query(`SELECT COUNT(*)::int AS n FROM approval_instances WHERE template_id = $1`, [errorTid])
    const failed = await createAsReq(errorTid)
    expect(failed.status, failed.text).toBe(400)
    expect(errorCode(JSON.parse(failed.text) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_EMPTY')
    const postCount = await query(`SELECT COUNT(*)::int AS n FROM approval_instances WHERE template_id = $1`, [errorTid])
    expect(postCount.rows[0].n).toBe(preCount.rows[0].n)

    // 'auto-approve': the instance completes; the empty resolution is an EXPLICIT audited
    // auto-approval, and no `system:*` id ever becomes an assignee (G-11).
    const autoTid = await createPublished(`pna-${TS}-cascade-auto`, cascadeGraph('auto-approve'))
    const auto = await createAsReq(autoTid)
    expect(auto.status, auto.text).toBe(201)
    const autoIid = auto.iid!
    const status = await query(`SELECT status FROM approval_instances WHERE id = $1`, [autoIid])
    expect(status.rows[0].status).toBe('approved')
    const sentinelAssignees = await query(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND assignee_id LIKE 'system:%'`,
      [autoIid],
    )
    expect(sentinelAssignees.rows).toHaveLength(0)
    const auditedAuto = await query(
      `SELECT id FROM approval_records WHERE instance_id = $1 AND action = 'approve' AND actor_id = 'system:auto-approval' AND metadata->>'nodeKey' = 'again'`,
      [autoIid],
    )
    expect(auditedAuto.rows.length).toBeGreaterThan(0)
  })

  // ── G-11 — sentinel-drop over a genuine dispatch-path transaction ───────────────────────────
  // NOTE on what this leg does and does NOT prove: it shows the sentinel never leaks into an
  // assignee row even when `again` resolves on a REAL dispatch-path transaction (not the
  // create-time cascade). It does NOT, by itself, prove `loadPriorNodeApproverDeciders` was
  // actually CALLED — an empty resolution here looks IDENTICAL whether the map was built and
  // correctly filtered, or never built at all (mutation-verified: gutting the dispatch call site
  // so `priorNodeApprovers` stays undefined leaves this leg green, same failure mode the P2
  // finding named for the OD-L1-4(a) arm above). That reachability claim is carried by the
  // separate "human-survivor reachability (G-11)" leg below, which requires the map to be built
  // and filtered correctly by MIXING a sentinel-only reference with a REAL decider reference.
  it('sentinel-drop over a real dispatch-path transaction (G-11): `gate` auto-approves under `system:auto-approval` at CREATE (a COMMITTED transaction, cascade halted at a REAL human `mid` node before ever touching `again`); MID\'s LATER approve activates `again` on the dispatch path — EMPTY resolution, no system:* assignee, audited auto-approval', async () => {
    // start -> gate (requester + mergeWithRequester ⇒ auto-approves AT CREATE, COMMITTED) ->
    // mid (REAL human decider ⇒ the create-time cascade halts HERE, never reaching `again`) ->
    // again (prior_node_approver -> 'gate', emptyAssigneePolicy 'auto-approve') -> end.
    //
    // Unlike the OD-L1-4(a) arm above (where `again` sits immediately downstream of the
    // auto-approving node and resolves within the SAME create-time cascade — where
    // `getPriorNodeApprovers` is omitted entirely, §K3), this graph puts a REAL decider (`mid`)
    // between `gate` and `again`. `again` can only activate on MID's own approve — a SEPARATE,
    // LATER transaction on the dispatch/act path.
    const svcDoorGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'gate', type: 'approval', name: 'gate',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
            autoApprovalPolicy: { mergeWithRequester: true },
          },
        },
        { key: 'mid', type: 'approval', name: 'mid', config: { assigneeSources: [{ kind: 'static_user', userIds: [MID] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        {
          key: 'again', type: 'approval', name: 'again',
          config: {
            assigneeSources: [{ kind: 'prior_node_approver', nodeKey: 'gate' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'auto-approve',
          },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2g', source: 'start', target: 'gate' },
        { key: 'g2m', source: 'gate', target: 'mid' },
        { key: 'm2a', source: 'mid', target: 'again' },
        { key: 'a2e', source: 'again', target: 'end' },
      ],
    }
    const tid = await createPublished(`pna-${TS}-g11-svc-door`, svcDoorGraph)
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    // Reachability + COMMITTED: `gate`'s sentinel row already exists, from create()'s own
    // transaction, BEFORE mid ever acts — not an in-flight merge on the SAME request.
    const gateAuto = await query(
      `SELECT id FROM approval_records WHERE instance_id = $1 AND action = 'approve' AND actor_id = 'system:auto-approval' AND metadata->>'nodeKey' = 'gate'`,
      [iid],
    )
    expect(gateAuto.rows.length).toBeGreaterThan(0)
    // The create-time cascade halted at `mid` (a real human) — `again` was never touched at create.
    expect(await activeAssignees(iid, 'again')).toHaveLength(0)
    expect((await activeAssignees(iid, 'mid')).map((a) => a.assignee_id)).toEqual([MID])

    // MID's approve is a NEW, LATER transaction: `again` activates and its
    // prior_node_approver('gate') resolution reads gate's committed sentinel row for real.
    const midApprove = await act(iid, midTok, { action: 'approve' })
    expect(midApprove.status, await midApprove.clone().text()).toBeLessThan(300)

    // No phantom `system:*` seat — an EMPTY resolution, never a leaked sentinel assignee.
    expect(await activeAssignees(iid, 'again')).toHaveLength(0)
    const sentinelAssignees = await query(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND assignee_id LIKE 'system:%'`,
      [iid],
    )
    expect(sentinelAssignees.rows).toHaveLength(0)
    // The empty resolution is an EXPLICIT audited auto-approval on `again` itself
    // (emptyAssigneePolicy 'auto-approve') — never a silent nobody.
    const auditedAuto = await query(
      `SELECT id FROM approval_records WHERE instance_id = $1 AND action = 'approve' AND actor_id = 'system:auto-approval' AND metadata->>'nodeKey' = 'again'`,
      [iid],
    )
    expect(auditedAuto.rows.length).toBeGreaterThan(0)
    const finalStatus = await query(`SELECT status FROM approval_instances WHERE id = $1`, [iid])
    expect(finalStatus.rows[0].status).toBe('approved')
  })

  // ── G-11 — human-survivor reachability: the map-build itself is load-bearing ────────────────
  // The leg above cannot distinguish "the map was built and correctly filtered" from "the map was
  // never built at all" — both look like an EMPTY resolution. This leg closes that gap the way the
  // resolver's OWN unit test does (approval-assignee-resolver.test.ts:260's mandatory
  // human-survivor positive control): `again` references TWO prior nodes in the SAME
  // `assigneeSources` array — the sentinel-only `gate` (must contribute nothing) AND the REAL
  // human decider `mid` (must survive). `mid` is `again`'s own immediate predecessor, so MID's
  // approve is simultaneously the ACT that activates `again` and the round `mid` itself is being
  // decided in — `mid`'s entry is carried through the in-flight-merge branch of
  // `loadPriorNodeApproverDeciders`, `gate`'s through the persisted-audit-row branch: one
  // resolution, both branches of the SAME function. If the dispatch call site were gutted (the
  // map stays undefined, mutation-verified to leave the leg above green), `again` would resolve
  // to EMPTY here too — MID would silently NOT be an assignee — and the assertion below reds.
  it('human-survivor reachability (G-11): `again` references BOTH the sentinel-only `gate` and the REAL decider `mid` — `mid` MUST survive resolution, which is only possible if loadPriorNodeApproverDeciders genuinely ran (a gutted call site, mutation-verified, silently drops MID too — NOT a vacuous "map absent" pass)', async () => {
    const survivorGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'gate', type: 'approval', name: 'gate',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
            autoApprovalPolicy: { mergeWithRequester: true },
          },
        },
        { key: 'mid', type: 'approval', name: 'mid', config: { assigneeSources: [{ kind: 'static_user', userIds: [MID] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        {
          key: 'again', type: 'approval', name: 'again',
          config: {
            // Sentinel-only reference FIRST, real-decider reference SECOND — order-independence
            // is incidental here; what matters is BOTH sources feed the SAME resolution.
            assigneeSources: [
              { kind: 'prior_node_approver', nodeKey: 'gate' },
              { kind: 'prior_node_approver', nodeKey: 'mid' },
            ],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
          },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2g', source: 'start', target: 'gate' },
        { key: 'g2m', source: 'gate', target: 'mid' },
        { key: 'm2a', source: 'mid', target: 'again' },
        { key: 'a2e', source: 'again', target: 'end' },
      ],
    }
    const tid = await createPublished(`pna-${TS}-g11-survivor`, survivorGraph)
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    // gate's sentinel row already committed at create; `again` untouched (cascade halted at mid).
    const gateAuto = await query(
      `SELECT id FROM approval_records WHERE instance_id = $1 AND action = 'approve' AND actor_id = 'system:auto-approval' AND metadata->>'nodeKey' = 'gate'`,
      [iid],
    )
    expect(gateAuto.rows.length).toBeGreaterThan(0)
    expect(await activeAssignees(iid, 'again')).toHaveLength(0)

    // MID's approve is BOTH the decider of `mid` (in-flight branch) and the trigger that
    // activates `again` (persisted-row branch, reading gate's committed sentinel).
    const midApprove = await act(iid, midTok, { action: 'approve' })
    expect(midApprove.status, await midApprove.clone().text()).toBeLessThan(300)

    // The REAL survivor: `again` resolves to EXACTLY [MID] — gate's sentinel contributed
    // nothing, but a genuinely-built, correctly-filtered map still carried mid's real decider
    // through. A map that was never built (call-site gutted) would have dropped MID here too.
    expect((await activeAssignees(iid, 'again')).map((a) => a.assignee_id)).toEqual([MID])
    const sentinelAssignees = await query(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND assignee_id LIKE 'system:%'`,
      [iid],
    )
    expect(sentinelAssignees.rows).toHaveLength(0)
  })

  // ── Freeze: the RULE rides the instance's pinned published definition ────────────────────────
  it('freeze of the RULE: re-publishing a v2 that changes the referencing node sources does NOT alter an in-flight instance resolution (v1 semantics discriminated against v2)', async () => {
    const tid = await createPublished(`pna-${TS}-freeze`, pnaGraph())
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    // Re-publish v2: `again` now names a STATIC approver (DECIDER_B). If the in-flight instance
    // wrongly read the live template, `again` would assign B; the frozen v1 rule assigns the
    // gate decider A. B ≠ A makes the arms discriminating, not vacuous.
    const patched = await req(base, `/api/approval-templates/${tid}`, reqTok, {
      method: 'PATCH',
      body: { key: `pna-${TS}-freeze`, name: 'v2', formSchema: FORM_SCHEMA, approvalGraph: pnaGraph({ againSources: [{ kind: 'static_user', userIds: [DECIDER_B] }] }) },
    })
    expect(patched.status, await patched.clone().text()).toBe(200)
    const republished = await publishTemplate(tid)
    expect(republished.status, await republished.clone().text()).toBe(200)

    // Dispatch the in-flight (v1-pinned) instance: gate approved by A → `again` = A per v1.
    const gateApprove = await act(iid, aTok, { action: 'approve' })
    expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)
    expect((await activeAssignees(iid, 'again')).map((a) => a.assignee_id)).toEqual([DECIDER_A])

    // Positive control (temporal, not a dead read): a NEW instance under v2 picks up the v2
    // static source — `again` assigns B without any gate decider involvement.
    const v2Started = await createAsReq(tid)
    expect(v2Started.status, v2Started.text).toBe(201)
    const v2Approve = await act(v2Started.iid!, aTok, { action: 'approve' })
    expect(v2Approve.status, await v2Approve.clone().text()).toBeLessThan(300)
    expect((await activeAssignees(v2Started.iid!, 'again')).map((a) => a.assignee_id)).toEqual([DECIDER_B])
  })
})
