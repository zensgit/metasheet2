import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-5 §1.3 (L5-C / L5-D) — `commentRequired`, real-DB.
 * Source: `docs/development/approval-lock5-node-operation-policy-20260817.md` §1.3, OD-L5-7(a),
 * OD-L5-8(a), gates CR-1, CR-2 (and the server half of CR-3's DTO carrier).
 *
 * ### The two shipped hardcodings this slice moves TOGETHER
 *
 * §1.3: "Both hardcodings move in the same slice… Either alone is a defect: leaving `:6698` strict
 * makes the switch inert on the platform path; leaving `:5224` hardcoded makes the bridge and card
 * paths and all four FE sites disagree with the node."
 *   A. the UNCONDITIONAL reject-comment check in `dispatchAction` → now reads the effective policy;
 *   B. the literal `rejectCommentRequired: true` written into `policy_snapshot` at instance CREATE
 *      → now OMITTED, with `effectiveCommentRequired` mapping absence to `'reject_only'`.
 *
 * ### Error-code contract (§1.3), pinned below
 *
 * The REJECT side keeps emitting `REJECT_COMMENT_REQUIRED` — existing clients key on it. The APPROVE
 * side gets a NEW `APPROVAL_COMMENT_REQUIRED`. No shipped client's error handling changes meaning.
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

/** A(p) -> B(q) -> end, with `commentRequired` optionally declared on A. */
function graphWith(p: string, q: string, commentRequired?: 'never' | 'reject_only' | 'always') {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_a',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [p],
          approvalMode: 'single',
          ...(commentRequired ? { nodeOperationPolicy: { commentRequired } } : {}),
        },
      },
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

describeIfDatabase('Lock-5 §1.3 — commentRequired: node-level, snapshot fallback, both hardcodings moved', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const grantedUserIds = new Set<string>()
  const createdUserIds = new Set<string>()

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
      if (createdUserIds.size > 0) {
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...createdUserIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  async function publishGraphTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const templateKey = `l5cr-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const response = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Lock-5 commentRequired',
        description: 'approval-lock5-node-operation-policy-20260817 §1.3',
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

  async function errorCodeOf(response: Response): Promise<string> {
    return ((await response.json()) as { error: { code: string } }).error.code
  }

  /** Fresh actors + a published template for one arm of the matrix. */
  async function arena(label: string, commentRequired?: 'never' | 'reject_only' | 'always') {
    const p = `l5cr-p-${TS}-${label}`
    const q = `l5cr-q-${TS}-${label}`
    const adminToken = await authToken(baseUrl, `l5cr-admin-${TS}-${label}`)
    const requesterId = `l5cr-req-${TS}-${label}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)
    const templateId = await publishGraphTemplate(adminToken, graphWith(p, q, commentRequired), label)
    return { p, q, adminToken, requesterToken, pTok, templateId }
  }

  it("CR-1: 'never' lets a BARE REJECT through", async () => {
    // MUTATION: revert the enforcement to the unconditional
    // `if (request.action === 'reject' && !request.comment?.trim())` and this test reds — proving
    // the ENUM is enforcing, not the FE.
    const a = await arena('never', 'never')
    const inst = await createApproval(a.requesterToken, a.templateId)
    const response = await act(a.pTok, inst.id, { action: 'reject' })
    expect(response.status, await response.clone().text()).toBe(200)
    const rows = await pool().query("SELECT comment FROM approval_records WHERE instance_id = $1 AND action = 'reject'", [inst.id])
    expect(rows.rows[0]?.comment).toBeNull()
  })

  it("CR-1: 'never' also lets a bare APPROVE through (the approve side is not newly strict)", async () => {
    const a = await arena('never-approve', 'never')
    const inst = await createApproval(a.requesterToken, a.templateId)
    const response = await act(a.pTok, inst.id, { action: 'approve' })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(((await response.json()) as { currentNodeKey: string | null }).currentNodeKey).toBe('approval_b')
  })

  it("CR-1: 'always' refuses a bare APPROVE with APPROVAL_COMMENT_REQUIRED — a NEW code, values-free", async () => {
    const a = await arena('always', 'always')
    const inst = await createApproval(a.requesterToken, a.templateId)
    const response = await act(a.pTok, inst.id, { action: 'approve' })
    expect(response.status, await response.clone().text()).toBe(400)
    const body = (await response.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }
    // §1.3: the approve side gets a NEW code so no shipped client's REJECT_COMMENT_REQUIRED
    // handling changes meaning.
    expect(body.error.code).toBe('APPROVAL_COMMENT_REQUIRED')
    expect(body.error.code).not.toBe('REJECT_COMMENT_REQUIRED')
    // §2.4 / X-1 values-free: `{ nodeKey }` and nothing else.
    expect(body.error.details).toEqual({ nodeKey: 'approval_a' })
    expect(body.error.message).not.toContain(a.p)
    expect(body.error.message).not.toContain(inst.id)

    // POSITIVE CONTROL: the SAME approve WITH a comment succeeds — the refusal is comment-selected.
    const withComment = await act(a.pTok, inst.id, { action: 'approve', comment: '同意' })
    expect(withComment.status, await withComment.clone().text()).toBe(200)
  })

  it("CR-1: 'always' ALSO refuses a bare reject, still as REJECT_COMMENT_REQUIRED (shipped code preserved)", async () => {
    const a = await arena('always-reject', 'always')
    const inst = await createApproval(a.requesterToken, a.templateId)
    const response = await act(a.pTok, inst.id, { action: 'reject' })
    expect(response.status).toBe(400)
    expect(await errorCodeOf(response)).toBe('REJECT_COMMENT_REQUIRED')
  })

  it("CR-1: 'reject_only' AND absent both reproduce today exactly — bare reject 400 REJECT_COMMENT_REQUIRED, bare approve 200", async () => {
    for (const [label, declared] of [['reject-only', 'reject_only'], ['absent', undefined]] as const) {
      const a = await arena(`today-${label}`, declared)

      const rejectInst = await createApproval(a.requesterToken, a.templateId)
      const rejectResponse = await act(a.pTok, rejectInst.id, { action: 'reject' })
      expect(rejectResponse.status, `${label} bare reject`).toBe(400)
      expect(await errorCodeOf(rejectResponse), label).toBe('REJECT_COMMENT_REQUIRED')

      // The approve side must NOT have become strict for these two values.
      const approveInst = await createApproval(a.requesterToken, a.templateId)
      const approveResponse = await act(a.pTok, approveInst.id, { action: 'approve' })
      expect(approveResponse.status, `${label} bare approve: ${await approveResponse.clone().text()}`).toBe(200)

      // …and a reject WITH a comment still works.
      const okInst = await createApproval(a.requesterToken, a.templateId)
      expect((await act(a.pTok, okInst.id, { action: 'reject', comment: '不同意' })).status).toBe(200)
    }
  }, 60_000)

  it('CR-2: an instance created BEFORE this slice (policy_snapshot.rejectCommentRequired:true, no node key) still requires a reject comment', async () => {
    // The legacy shape, reproduced exactly: the node declares NOTHING and the instance carries the
    // literal this slice stopped writing. `effectiveCommentRequired` must fall back to it.
    const a = await arena('cr2-legacy')
    const inst = await createApproval(a.requesterToken, a.templateId)
    await pool().query(
      `UPDATE approval_instances
          SET policy_snapshot = policy_snapshot || '{"rejectCommentRequired": true}'::jsonb
        WHERE id = $1`,
      [inst.id],
    )
    const response = await act(a.pTok, inst.id, { action: 'reject' })
    expect(response.status).toBe(400)
    expect(await errorCodeOf(response)).toBe('REJECT_COMMENT_REQUIRED')
  })

  it("CR-2 POSITIVE CONTROL: the same legacy snapshot with a node saying 'never' does NOT require one — the fallback is presence-selected", async () => {
    const a = await arena('cr2-node-wins', 'never')
    const inst = await createApproval(a.requesterToken, a.templateId)
    await pool().query(
      `UPDATE approval_instances
          SET policy_snapshot = policy_snapshot || '{"rejectCommentRequired": true}'::jsonb
        WHERE id = $1`,
      [inst.id],
    )
    // The NODE value wins over the snapshot (OD-L5-8(a): node level, snapshot only as FALLBACK).
    const response = await act(a.pTok, inst.id, { action: 'reject' })
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it("CR-2 (fallback's other arm): a legacy snapshot saying `false` with no node key does NOT require a comment", async () => {
    const a = await arena('cr2-false')
    const inst = await createApproval(a.requesterToken, a.templateId)
    await pool().query(
      `UPDATE approval_instances
          SET policy_snapshot = policy_snapshot || '{"rejectCommentRequired": false}'::jsonb
        WHERE id = $1`,
      [inst.id],
    )
    expect((await act(a.pTok, inst.id, { action: 'reject' })).status).toBe(200)
  })

  it('§1.3 hardcoding B: instance CREATE no longer writes a literal rejectCommentRequired, and behavior is unchanged', async () => {
    const a = await arena('hardcoding-b')
    const inst = await createApproval(a.requesterToken, a.templateId)
    const row = await pool().query<{ policy_snapshot: Record<string, unknown> }>(
      'SELECT policy_snapshot FROM approval_instances WHERE id = $1',
      [inst.id],
    )
    const snapshot = row.rows[0]!.policy_snapshot
    // The literal is gone…
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'rejectCommentRequired')).toBe(false)
    // …the siblings it used to travel with are untouched…
    expect(snapshot.allowRevoke).toBe(true)
    expect(snapshot.sourceOfTruth).toBe('platform')
    // …and the ABSENCE resolves to today's answer, which is the whole point of removing it.
    const response = await act(a.pTok, inst.id, { action: 'reject' })
    expect(response.status).toBe(400)
    expect(await errorCodeOf(response)).toBe('REJECT_COMMENT_REQUIRED')
  })

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // The A-2 / CR-3 DTO carrier (server half)
  // ───────────────────────────────────────────────────────────────────────────────────────────

  it('A-2 carrier: the DETAIL read ships the actor-scoped effective operations; the LIST read stays byte-identical', async () => {
    const suffix = 'carrier'
    const p = `l5cr-p-${TS}-${suffix}`
    const q = `l5cr-q-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5cr-admin-${TS}-${suffix}`)
    const requesterId = `l5cr-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const graph = graphWith(p, q, 'always')
    // Deny two of the four verbs so the carrier is demonstrably policy-driven, not all-true.
    ;(graph.nodes[1]!.config as Record<string, unknown>).nodeOperationPolicy = {
      commentRequired: 'always',
      allowTransfer: false,
      allowReturn: false,
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)

    const detail = await jsonRequest(baseUrl, `/api/approvals/${inst.id}`, pTok)
    expect(detail.status, await detail.clone().text()).toBe(200)
    const dto = (await detail.json()) as { nodeOperations?: Record<string, unknown> }
    expect(dto.nodeOperations).toEqual({
      allowTransfer: false,
      allowAddSign: true,
      allowReduceSign: true,
      allowReturn: false,
      commentRequired: 'always',
    })

    // The values MATCH what the server actually enforces — the two doors are one predicate (§2.3).
    expect((await act(pTok, inst.id, { action: 'transfer', targetUserId: q })).status).toBe(409)
    expect((await act(pTok, inst.id, { action: 'approve' })).status).toBe(400)

    // A NON-seat viewer (the requester) gets NO carrier — nothing to gate, and never over-reported.
    const requesterView = await jsonRequest(baseUrl, `/api/approvals/${inst.id}`, requesterToken)
    expect(requesterView.status).toBe(200)
    expect((await requesterView.json() as { nodeOperations?: unknown }).nodeOperations).toBeUndefined()
  })

  it("CR-3 (card path): the card summary derives the requirement from the NODE, not policy_snapshot", async () => {
    // The FOURTH reader §1.3 names. `buildSummary` used to read `policy_snapshot` ONLY, so a node
    // saying `'never'` still produced a card demanding a reject comment — the exact disagreement
    // §1.3 calls out. It now joins the frozen published definition and resolves at the DELIVERY's
    // node. MUTATION: revert the summary to `rejectCommentRequired: true` / `'reject_only'` and the
    // `'never'` arm below reds.
    const { getApprovalCardDeliverySummary } = await import('../../src/services/ApprovalCardDeliveryAction')
    const { createHmac } = await import('crypto')
    const secret = process.env.APPROVAL_CARD_LINK_SECRET
    process.env.APPROVAL_CARD_LINK_SECRET = 'l5cr-card-secret'
    try {
      const queryFn: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> =
        async (sql, params) => pool().query(sql, params as never)

      for (const [label, declared, expectReject, expectEnum] of [
        ['never', 'never', false, 'never'],
        ['always', 'always', true, 'always'],
        ['absent', undefined, true, 'reject_only'],
      ] as const) {
        const a = await arena(`card-${label}`, declared)
        const inst = await createApproval(a.requesterToken, a.templateId)
        const seat = await pool().query(
          'SELECT entry_epoch FROM approval_assignments WHERE instance_id = $1 AND assignee_id = $2 AND is_active = TRUE',
          [inst.id, a.p],
        )
        const deliveryId = `l5cr-card-${TS}-${label}`
        await pool().query(
          `INSERT INTO dingtalk_approval_card_deliveries
             (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, card_state, send_status, entry_epoch)
           VALUES ($1, $2, 'approval_a', $3, $3, 'interactive_card', 'sent', 'sent', $4)`,
          [deliveryId, inst.id, a.p, seat.rows[0]?.entry_epoch],
        )
        const token = createHmac('sha256', 'l5cr-card-secret').update(deliveryId).digest('hex').slice(0, 32)
        const result = await getApprovalCardDeliverySummary(
          { query: queryFn },
          { deliveryId, token, viewerUserId: a.p },
        )
        expect(result.status, label).toBe('ok')
        const approval = (result as { summary: { approval: { rejectCommentRequired: boolean; commentRequired: string } } }).summary.approval
        expect(approval.commentRequired, `${label} enum`).toBe(expectEnum)
        expect(approval.rejectCommentRequired, `${label} boolean`).toBe(expectReject)
        await pool().query('DELETE FROM dingtalk_approval_card_deliveries WHERE id = $1', [deliveryId])
      }
    } finally {
      if (secret === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
      else process.env.APPROVAL_CARD_LINK_SECRET = secret
    }
  }, 60_000)

  it('A-2 carrier: a ROLE-typed seat gets the SAME scoping as a user seat (gate finding P2-1)', async () => {
    // The choke treats a role seat as first-class (`assignmentMatchesActor` matches on the actor's
    // ROLES), so a carrier scoped to user seats only left every role-seated approver with NO
    // `nodeOperations` — the bar rendered all four verbs and the server 409'd each click, minting a
    // `policy_denied` row per click, and `commentRequired:'always'` was invisible so the approve
    // confirm stayed enabled and the submit 400'd.
    // MUTATION: revert the role arm in `ApprovalBridgeService`'s seat filter (or drop the
    // `resolveApprovalActorRoles` argument at the route) and this test reds.
    const suffix = 'role-seat'
    const roleId = `l5cr-role-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l5cr-admin-${TS}-${suffix}`)
    const requesterId = `l5cr-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    // A token whose ROLES contain the seat's role id — the shape the choke matches on.
    const approverId = `l5cr-roleuser-${TS}-${suffix}`
    const approverResponse = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(approverId)}&roles=${encodeURIComponent(`admin,${roleId}`)}&perms=${encodeURIComponent('*:*')}`,
    )
    expect(approverResponse.status).toBe(200)
    const approverToken = ((await approverResponse.json()) as { token: string }).token
    // Lock-10 (S1): the role-typed seat arm is DB-backed (OD-S1-17(a)) — the trusted `roles`
    // JWT claim above satisfies rbacGuard but no longer, alone, satisfies canReadApprovalInstance's
    // role match. Seed the real users.role row `viewerRoles` reads so this stays a role-seat test,
    // not (accidentally, post-S1) a "nobody can read this" test.
    createdUserIds.add(approverId)
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $1||'@example.test', $1, 'x', $2, TRUE)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE`,
      [approverId, roleId],
    )

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_a',
          type: 'approval',
          config: {
            assigneeType: 'role',
            assigneeIds: [roleId],
            approvalMode: 'single',
            nodeOperationPolicy: { allowTransfer: false, commentRequired: 'always' },
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-s-a', source: 'start', target: 'approval_a' },
        { key: 'e-a-end', source: 'approval_a', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)

    // The seat really is ROLE-typed — otherwise this test would be a user-seat test in disguise.
    const seats = await pool().query(
      'SELECT assignment_type, assignee_id FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE',
      [inst.id],
    )
    expect(seats.rows.map((r: { assignment_type: string }) => r.assignment_type)).toEqual(['role'])

    // GATE: the role-seated approver's detail read carries the carrier, matching what the server enforces.
    const detail = await jsonRequest(baseUrl, `/api/approvals/${inst.id}`, approverToken)
    expect(detail.status, await detail.clone().text()).toBe(200)
    const dto = (await detail.json()) as { nodeOperations?: Record<string, unknown> }
    expect(dto.nodeOperations).toEqual({
      allowTransfer: false,
      allowAddSign: true,
      allowReduceSign: true,
      allowReturn: true,
      commentRequired: 'always',
    })

    // …and the server door agrees on the SAME actor, so the mirror is not over- or under-reporting.
    expect((await act(approverToken, inst.id, { action: 'transfer', targetUserId: requesterId })).status).toBe(409)
    expect((await act(approverToken, inst.id, { action: 'approve' })).status).toBe(400)
    expect((await act(approverToken, inst.id, { action: 'approve', comment: '同意' })).status).toBe(200)
  })

  it('A-2 carrier SURVIVES an action: the dispatch RESPONSE carries the same mirror a fresh GET does (finding P2-R2)', async () => {
    // THE SEQUENCE THIS GUARDS. The FE store overwrites `activeApproval` with the dispatch response,
    // and the four member handlers refresh only history. So if the action response omits
    // `nodeOperations`, the mirror EVAPORATES after the member's first successful action: post a
    // 评论 (ungated, leaves the seat intact) at a node with `allowTransfer:false` and all four
    // forbidden verbs re-render — each click then 409s and mints another `policy_denied` row. That
    // is the M7 exposure A-2 exists to close, in the most routine sequence there is.
    // MUTATION: delete the `nodeOperations` population block in `ApprovalProductService.getApproval`
    // (or drop `actor.roles` from the dispatch call sites, for the role arm) and this test reds.
    for (const [label, seatKind] of [['user', 'user'], ['role', 'role']] as const) {
      const suffix = `p2r2-${label}`
      const roleId = `l5cr-role-${TS}-${suffix}`
      const adminToken = await authToken(baseUrl, `l5cr-admin-${TS}-${suffix}`)
      const requesterId = `l5cr-req-${TS}-${suffix}`
      const requesterToken = await authToken(baseUrl, requesterId)
      await grantWrite(requesterId)

      const approverId = `l5cr-approver-${TS}-${suffix}`
      const rolesParam = seatKind === 'role' ? `admin,${roleId}` : 'admin'
      const approverResponse = await fetch(
        `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(approverId)}&roles=${encodeURIComponent(rolesParam)}&perms=${encodeURIComponent('*:*')}`,
      )
      expect(approverResponse.status).toBe(200)
      const approverToken = ((await approverResponse.json()) as { token: string }).token
      // Lock-10 (S1): role-typed seat admission is DB-backed (OD-S1-17(a)) — seed the users.role
      // row for the role branch so this stays a role-seat test post-S1 (the user branch already
      // qualifies via arm 2's user-typed match on approverId itself, no DB row needed there).
      if (seatKind === 'role') {
        createdUserIds.add(approverId)
        await pool().query(
          `INSERT INTO users (id, email, name, password_hash, role, is_active) VALUES ($1, $1||'@example.test', $1, 'x', $2, TRUE)
           ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE`,
          [approverId, roleId],
        )
      }

      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_a',
            type: 'approval',
            config: {
              ...(seatKind === 'role'
                ? { assigneeType: 'role', assigneeIds: [roleId] }
                : { assigneeType: 'user', assigneeIds: [approverId] }),
              approvalMode: 'single',
              nodeOperationPolicy: { allowTransfer: false, allowReturn: false },
            },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-end', source: 'approval_a', target: 'end' },
        ],
      }
      const templateId = await publishGraphTemplate(adminToken, graph, suffix)
      const inst = await createApproval(requesterToken, templateId)

      const beforeGet = await jsonRequest(baseUrl, `/api/approvals/${inst.id}`, approverToken)
      expect(beforeGet.status, label).toBe(200)
      const beforeOps = (await beforeGet.json() as { nodeOperations?: unknown }).nodeOperations
      expect(beforeOps, `${label} GET`).toEqual({
        allowTransfer: false, allowAddSign: true, allowReduceSign: true, allowReturn: false,
        commentRequired: 'reject_only',
      })

      // The routine action: an UNGATED verb that leaves the actor's seat intact.
      const commentResponse = await act(approverToken, inst.id, { action: 'comment', comment: 'hi' })
      expect(commentResponse.status, `${label} comment: ${await commentResponse.clone().text()}`).toBe(200)
      const afterAction = (await commentResponse.json() as { nodeOperations?: unknown }).nodeOperations

      // GATE: the ACTION RESPONSE carries the mirror…
      expect(afterAction, `${label} ACTION-RESPONSE`).toEqual(beforeOps)
      // …and it still agrees with a fresh GET, so the two reads cannot drift.
      const afterGet = await jsonRequest(baseUrl, `/api/approvals/${inst.id}`, approverToken)
      expect((await afterGet.json() as { nodeOperations?: unknown }).nodeOperations, `${label} GET-after`).toEqual(beforeOps)
      // …and the server door still refuses, so the mirror is not over-reporting.
      expect((await act(approverToken, inst.id, { action: 'transfer', targetUserId: requesterId })).status, label).toBe(409)
    }
  }, 90_000)

  it('A-2 carrier after the actor LOSES their seat: the action response honestly carries NO mirror', async () => {
    // The other arm of P2-R2's fix: once the approver approves and the node advances past them, they
    // hold no seat, so there is no bar to mirror and the honest value is absence — exactly what a
    // fresh GET now returns. Without this, "the response always carries the carrier" could be
    // satisfied by a stale copy that outlives the seat.
    const a = await arena('p2r2-seatless')
    const inst = await createApproval(a.requesterToken, a.templateId)
    const approveResponse = await act(a.pTok, inst.id, { action: 'approve', comment: 'ok' })
    expect(approveResponse.status, await approveResponse.clone().text()).toBe(200)
    const body = await approveResponse.json() as { currentNodeKey: string | null; nodeOperations?: unknown }
    expect(body.currentNodeKey).toBe('approval_b')
    expect(body.nodeOperations).toBeUndefined()
    const freshGet = await jsonRequest(baseUrl, `/api/approvals/${inst.id}`, a.pTok)
    expect((await freshGet.json() as { nodeOperations?: unknown }).nodeOperations).toBeUndefined()
  })

  it('A-2 carrier POSITIVE CONTROL: a node with NO policy reports every verb allowed (absent ≡ allowed, not fail-closed)', async () => {
    // Guards the OD-L5-3(a) inversion trap: copying `allowRevoke`'s `=== true` idiom would report
    // everything DENIED here and hide the whole member bar on every pre-Lock-5 instance.
    const a = await arena('carrier-default')
    const inst = await createApproval(a.requesterToken, a.templateId)
    const detail = await jsonRequest(baseUrl, `/api/approvals/${inst.id}`, a.pTok)
    expect(detail.status).toBe(200)
    expect((await detail.json() as { nodeOperations?: Record<string, unknown> }).nodeOperations).toEqual({
      allowTransfer: true,
      allowAddSign: true,
      allowReduceSign: true,
      allowReturn: true,
      commentRequired: 'reject_only',
    })
  })
})
