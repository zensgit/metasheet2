import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { isCancelRoundInstance } from '../../src/attendance/w4c3b-central-approval-hooks'
import { CANCEL_ROUND_APPROVAL_NODE_KEY } from '../../src/db/seeds/approval-cancel-round-published-definition'

/**
 * Approval change-request design lock v5.9 §14.3 outlets #2/#4/#6 (lock:359,362-363 area;
 * table rows #2/#4/#6) — real-DB acceptance for the FIRST SLICE of the "outlet-guards" file the
 * taskbook's own split promised (seat-guards.db.test.ts's header: "a separate outlet-guards file
 * per the taskbook split — those chokepoints sit on the decide/dispatch/legacy-route paths, not
 * seat-writers"). Per the sub-unit handoff's advisor guidance this is split further, by shared
 * oracle, into THREE slices rather than one file:
 *   - THIS FILE: #2 (`adminJump`, `rejectIfCancelRound` at `APS:8582`) and #4/#6 (`dispatchAction`
 *     action gate, `assertCancelRoundActionAllowed` at `APS:9928`) — both throw the SAME
 *     `CancelRoundOutletForbiddenError` (409 `CANCEL_ROUND_OUTLET_FORBIDDEN`) IN-PROCESS, before
 *     any DML, with no route-catch translation step to verify.
 *   - NOT covered by this file (separate slices): #3 (`applyNodeTimeoutEffect` — a two-part
 *     oracle, outcome literal AND deadline-consumption, needing an env-flag-gated scanner call
 *     and a two-round re-pickup negative control — "这是判据不是括号", lock:363); #7/#7′/#8
 *     (legacy `POST /:id/approve`/`/:id/reject` and `ApprovalBridgeService.dispatchAction` — a
 *     different oracle: the 409 must survive each route's own catch translation, not merely be
 *     thrown in-process); #12/#13 (seat-write chokepoints — `approval-cancel-round-seat-guards
 *     .db.test.ts`); attendance-parity and attendance-FK-migration (separate files); 判据 II/IV
 *     of redemption (depend on WI-10/11/12, not on this branch).
 *
 * Both outlets in this file are asserted with a PAIRED positive control on the SAME service
 * method against an ORDINARY (non-cancel-round) instance, so a future regression that turns the
 * guard into a blanket disable of `adminJump`/`dispatchAction` (rather than a cancel-round-
 * specific rejection) fails this file too, not just the negative half.
 *
 * Fixture reuse: same harness as `approval-cancel-round-seat-guards.db.test.ts` (real one-node
 * template, real create+approve through the running server, `createCancelRoundInstance` called
 * in-process — no HTTP route exists for it yet). Duplicated here rather than imported, matching
 * this corpus's own convention (each `.db.test.ts` file is self-contained).
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

/** `start -> approval_a -> end`: a single approval node, one assignee, single approvalMode. */
function oneNodeGraph(approverId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_a',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'single' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-end', source: 'approval_a', target: 'end' },
    ],
  }
}

/**
 * `start -> approval_a -> approval_b -> approval_c -> end`: THREE approval nodes so an ordinary
 * (non-cancel-round) instance has a genuine downstream approval-type jump target once its FIRST
 * node has been decided — the positive control for outlet #2 needs this shape; the cancel-round
 * definition itself has only one approval node (`buildCancelRoundApprovalGraph`), so a genuine
 * successful jump is only constructible on an ordinary instance, never on the cancel round.
 */
function threeNodeGraph(approverA: string, approverB: string, approverC: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [approverA], approvalMode: 'single' } },
      { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [approverB], approvalMode: 'single' } },
      { key: 'approval_c', type: 'approval', config: { assigneeType: 'user', assigneeIds: [approverC], approvalMode: 'single' } },
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

describeIfDatabase('cancel-round outlet guards (§14.3 #2, #4/#6): a cancel-round instance cannot be admin-jumped or dispatched a non-allowed action', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdRoundIds = new Set<string>()
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
      const roundIds = [...createdRoundIds]
      const templateIds = [...createdTemplateIds]
      if (roundIds.length > 0) {
        await pool().query('DELETE FROM approval_rounds WHERE id = ANY($1::text[])', [roundIds])
      }
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

  async function grantWrite(userId: string): Promise<void> {
    grantedUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  async function publishTemplate(adminToken: string, graph: unknown, label: string): Promise<string> {
    const templateKey = `wi-outlet-guard-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'outlet-guards cancel-round fixture',
        description: 'approval-cancel-round-outlet-guards.db.test.ts',
        formSchema: buildFormSchema(),
        approvalGraph: graph,
      },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const template = (await create.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return template.id
  }

  async function createPendingInstance(requesterToken: string, templateId: string): Promise<string> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string }
    createdApprovalIds.add(inst.id)
    return inst.id
  }

  async function approve(approverToken: string, instanceId: string): Promise<void> {
    const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, approverToken, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(approveResponse.status, await approveResponse.clone().text()).toBe(200)
  }

  async function createCancelRound(requesterId: string, documentId: string): Promise<string> {
    const service = new ApprovalProductService()
    const dto = await service.createCancelRoundInstance(documentId, { userId: requesterId })
    createdApprovalIds.add(dto.id)
    const roundRow = await pool().query<{ id: string }>(`SELECT id FROM approval_rounds WHERE engine_instance_id = $1`, [
      dto.id,
    ])
    if (roundRow.rows[0]) createdRoundIds.add(roundRow.rows[0].id)
    const instanceRow = await pool().query(`SELECT * FROM approval_instances WHERE id = $1`, [dto.id])
    expect(isCancelRoundInstance(instanceRow.rows[0])).toBe(true)
    return dto.id
  }

  it('#2 adminJump — a cancel-round instance is rejected 409 CANCEL_ROUND_OUTLET_FORBIDDEN; a genuine downstream jump on an ordinary instance still succeeds', async () => {
    const suffix = `jump-${TS}`
    const approverId = `wi-outlet-apr-${suffix}`
    const requesterId = `wi-outlet-req-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, `wi-outlet-admin-${suffix}`)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    // --- Negative construct: the cancel round itself. ---
    const templateA = await publishTemplate(adminToken, oneNodeGraph(approverId), 'a')
    const documentA = await createPendingInstance(requesterToken, templateA)
    await approve(approverToken, documentA)
    const cancelRoundInstanceId = await createCancelRound(requesterId, documentA)

    const before = await pool().query<{ version: number; status: string; current_node_key: string | null }>(
      `SELECT version, status, current_node_key FROM approval_instances WHERE id = $1`,
      [cancelRoundInstanceId],
    )
    expect(before.rows[0]?.status).toBe('pending')

    const service = new ApprovalProductService()
    await expect(
      service.adminJump(
        cancelRoundInstanceId,
        { version: before.rows[0]!.version, targetNodeKey: 'end', reason: 'outlet-guard probe' },
        { userId: `wi-outlet-actor-${suffix}`, userName: 'outlet guard actor' },
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CANCEL_ROUND_OUTLET_FORBIDDEN' })

    // Byte-identical before/after: the guard fired before any write (not merely before a
    // COMMIT the ROLLBACK happened to erase).
    const after = await pool().query<{ version: number; status: string; current_node_key: string | null }>(
      `SELECT version, status, current_node_key FROM approval_instances WHERE id = $1`,
      [cancelRoundInstanceId],
    )
    expect(after.rows[0]).toEqual(before.rows[0])

    // --- Positive control: an ORDINARY three-node instance, jumped forward for real. ---
    const approverB = `wi-outlet-aprB-${suffix}`
    const approverC = `wi-outlet-aprC-${suffix}`
    const requesterId2 = `wi-outlet-req2-${suffix}`
    await grantWrite(requesterId2)
    const requesterToken2 = await authToken(baseUrl, requesterId2)
    const approverTokenA2 = await authToken(baseUrl, `wi-outlet-aprA2-${suffix}`)
    const templateB = await publishTemplate(adminToken, threeNodeGraph(`wi-outlet-aprA2-${suffix}`, approverB, approverC), 'b')
    const documentB = await createPendingInstance(requesterToken2, templateB)
    await approve(approverTokenA2, documentB) // current_node_key -> approval_b

    const beforeJump = await pool().query<{ version: number; current_node_key: string | null }>(
      `SELECT version, current_node_key FROM approval_instances WHERE id = $1`,
      [documentB],
    )
    expect(beforeJump.rows[0]?.current_node_key).toBe('approval_b')

    const jumped = await service.adminJump(
      documentB,
      { version: beforeJump.rows[0]!.version, targetNodeKey: 'approval_c', reason: 'positive control jump' },
      { userId: `wi-outlet-admin-actor-${suffix}`, userName: 'outlet guard admin actor' },
    )
    expect(jumped.id).toBe(documentB)

    const afterJump = await pool().query<{ current_node_key: string | null }>(
      `SELECT current_node_key FROM approval_instances WHERE id = $1`,
      [documentB],
    )
    expect(afterJump.rows[0]?.current_node_key).toBe('approval_c')
  })

  it("#4/#6 dispatchAction action gate — a cancel-round instance rejects 'handle' and 'return' 409 CANCEL_ROUND_OUTLET_FORBIDDEN; 'comment' (an allowed action) still succeeds", async () => {
    const suffix = `gate-${TS}`
    const approverId = `wi-outlet-gate-apr-${suffix}`
    const requesterId = `wi-outlet-gate-req-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, `wi-outlet-gate-admin-${suffix}`)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateA = await publishTemplate(adminToken, oneNodeGraph(approverId), 'a')
    const documentA = await createPendingInstance(requesterToken, templateA)
    await approve(approverToken, documentA)
    const cancelRoundInstanceId = await createCancelRound(requesterId, documentA)

    const service = new ApprovalProductService()

    for (const action of ['handle', 'return'] as const) {
      const before = await pool().query<{ version: number; status: string }>(
        `SELECT version, status FROM approval_instances WHERE id = $1`,
        [cancelRoundInstanceId],
      )
      await expect(
        service.dispatchAction(
          cancelRoundInstanceId,
          { action },
          { userId: approverId, userName: 'gate actor', roles: [] },
        ),
        `action=${action}`,
      ).rejects.toMatchObject({ statusCode: 409, code: 'CANCEL_ROUND_OUTLET_FORBIDDEN' })

      const after = await pool().query<{ version: number; status: string }>(
        `SELECT version, status FROM approval_instances WHERE id = $1`,
        [cancelRoundInstanceId],
      )
      expect(after.rows[0], `action=${action}`).toEqual(before.rows[0])
    }

    // Positive control: 'comment' is in the allow-set ({approve,reject,revoke,comment}) — the
    // SAME instance, the SAME method, a DIFFERENT action succeeds. The acting user must hold the
    // current node's seat (`actorCanAct`, checked AFTER the action gate) — that seat is the
    // original document's approver, resolved by `createCancelRoundInstance` via requester_choice.
    const commentResult = await service.dispatchAction(
      cancelRoundInstanceId,
      { action: 'comment', comment: 'outlet-guard positive control' },
      { userId: approverId, userName: 'gate actor', roles: [] },
    )
    expect(commentResult.id).toBe(cancelRoundInstanceId)

    const commentRecord = await pool().query<{ action: string; comment: string | null }>(
      `SELECT action, comment FROM approval_records WHERE instance_id = $1 AND action = 'comment' ORDER BY created_at DESC LIMIT 1`,
      [cancelRoundInstanceId],
    )
    expect(commentRecord.rows[0]?.comment).toBe('outlet-guard positive control')

    // The instance's own current_node_key is unchanged by the comment (no state transition).
    const finalRow = await pool().query<{ current_node_key: string | null; status: string }>(
      `SELECT current_node_key, status FROM approval_instances WHERE id = $1`,
      [cancelRoundInstanceId],
    )
    expect(finalRow.rows[0]?.current_node_key).toBe(CANCEL_ROUND_APPROVAL_NODE_KEY)
    expect(finalRow.rows[0]?.status).toBe('pending')
  })
})
