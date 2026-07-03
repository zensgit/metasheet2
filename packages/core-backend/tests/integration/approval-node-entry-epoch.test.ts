import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// nodeEntryEpoch (design-lock 2026-07-03) — durable T2-4 threshold round-scoping.
// These tests exercise the epoch mechanism itself (§9): the condition/cc-in-the-middle 4th
// vector, mid-round assignee mutations that PRESERVE the epoch, the mixed-epoch fail-closed
// belt, and the migration dual-read fallback. The pre-existing behavioural regressions
// (#3446 / #3499 / #3453) live in approval-nofm-threshold.test.ts and must stay green there.

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

type JsonRecord = Record<string, unknown>

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
) {
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

// A bare threshold (2-of-3) node → end. Used for the mid-round mutation + mixed-epoch cases.
function buildThresholdGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_threshold',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['approver-a', 'approver-b', 'approver-c'],
          approvalMode: 'threshold',
          approvalThreshold: 2,
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-threshold', source: 'start', target: 'approval_threshold' },
      { key: 'edge-threshold-end', source: 'approval_threshold', target: 'end' },
    ],
  }
}

// Threshold (2-of-3) → a second single node, so an approver can RETURN to the resolved
// threshold node and re-activate it (the dual-read migration test drives this).
function buildThresholdReentryGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_threshold',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['approver-a', 'approver-b', 'approver-c'],
          approvalMode: 'threshold',
          approvalThreshold: 2,
        },
      },
      {
        key: 'approval_second',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['approver-a'], approvalMode: 'single' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-threshold', source: 'start', target: 'approval_threshold' },
      { key: 'edge-threshold-second', source: 'approval_threshold', target: 'approval_second' },
      { key: 'edge-second-end', source: 'approval_second', target: 'end' },
    ],
  }
}

// The design-lock's headline 4th vector: a CONDITION node sits between the upstream approval node
// and the threshold node X. N1(approval) → condition → X(2-of-3) → N3. The executor traverses the
// condition transparently, so forward re-entry lands the instance on X. The epoch is minted when X
// is ACTIVATED (entry vector irrelevant), so a re-entered round never re-counts the prior round.
function buildConditionInMiddleGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_upstream',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['approver-p'], approvalMode: 'single' },
      },
      {
        key: 'condition_route',
        type: 'condition',
        config: {
          // Deterministic route to X: the branch matches reason='route', and the default also
          // points at X, so the instance always forwards into the threshold node.
          branches: [{ edgeKey: 'edge-cond-threshold', rules: [{ fieldId: 'reason', operator: 'eq', value: 'route' }] }],
          defaultEdgeKey: 'edge-cond-threshold',
        },
      },
      {
        key: 'approval_threshold',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['approver-a', 'approver-b', 'approver-c'],
          approvalMode: 'threshold',
          approvalThreshold: 2,
        },
      },
      {
        key: 'approval_second',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['approver-a'], approvalMode: 'single' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-upstream', source: 'start', target: 'approval_upstream' },
      { key: 'edge-upstream-cond', source: 'approval_upstream', target: 'condition_route' },
      { key: 'edge-cond-threshold', source: 'condition_route', target: 'approval_threshold' },
      { key: 'edge-threshold-second', source: 'approval_threshold', target: 'approval_second' },
      { key: 'edge-second-end', source: 'approval_second', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval nodeEntryEpoch — durable threshold round-scoping', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
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
      if (createdUserIds.size > 0) {
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...createdUserIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  async function ensureUsers(...ids: string[]): Promise<void> {
    for (const id of ids) {
      createdUserIds.add(id)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active)
         VALUES ($1, $2, $3, 'test', 'user', '[]'::jsonb, TRUE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, updated_at = now()`,
        [id, `${id}@example.test`, id],
      )
    }
  }

  async function publishGraphTemplate(adminToken: string, approvalGraph: object): Promise<string> {
    const templateKey = `epoch-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'nodeEntryEpoch Template',
        description: 'nodeEntryEpoch integration',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
    expect(templateResponse.status, await templateResponse.clone().text()).toBe(201)
    const template = (await templateResponse.json()) as { id: string }
    createdTemplateIds.add(template.id)

    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
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

  type ActResult = {
    status: string
    currentNodeKey: string | null
    assignments: Array<{ assigneeId: string; isActive: boolean }>
  }

  function actor(token: string, instanceId: string) {
    return async (body: object): Promise<ActResult> => {
      const response = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, {
        method: 'POST',
        body,
      })
      return (await response.json()) as ActResult
    }
  }

  async function nodeActivationSeq(instanceId: string): Promise<number> {
    const result = await pool().query<{ node_activation_seq: number }>(
      `SELECT node_activation_seq FROM approval_instances WHERE id = $1`,
      [instanceId],
    )
    expect(result.rows).toHaveLength(1)
    return Number(result.rows[0].node_activation_seq)
  }

  async function activeAssigneeIds(instanceId: string): Promise<string[]> {
    const result = await pool().query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ORDER BY assignee_id`,
      [instanceId],
    )
    return result.rows.map((row) => row.assignee_id)
  }

  it('condition-in-the-middle: a re-entered threshold node does NOT re-resolve on stale prior-round votes (4th vector)', async () => {
    const adminToken = await authToken(baseUrl, 'epoch-admin-condition')
    const requesterToken = await authToken(baseUrl, 'epoch-requester-condition')
    const pTok = await authToken(baseUrl, 'approver-p')
    const aTok = await authToken(baseUrl, 'approver-a')
    const bTok = await authToken(baseUrl, 'approver-b')

    const templateId = await publishGraphTemplate(adminToken, buildConditionInMiddleGraph())
    // reason='route' drives the condition branch to the threshold node.
    const inst = await createApproval(requesterToken, templateId, 'route')
    expect(inst.currentNodeKey).toBe('approval_upstream')

    const act = { p: actor(pTok, inst.id), a: actor(aTok, inst.id), b: actor(bTok, inst.id) }

    // ROUND 1: P approves the upstream node → forwards THROUGH the condition into X. A + B resolve the
    // 2-of-3 → advances to the second node.
    const afterP1 = await act.p({ action: 'approve', comment: 'P r1' })
    expect(afterP1.currentNodeKey).toBe('approval_threshold')
    await act.a({ action: 'approve', comment: 'A r1' })
    const afterB1 = await act.b({ action: 'approve', comment: 'B r1' })
    expect(afterB1.currentNodeKey).toBe('approval_second')

    // Return to the UPSTREAM node (approver-a is the second node's approver). The return names the
    // upstream node — the forward path back into X crosses the transparently-skipped condition node.
    const afterReturn = await act.a({ action: 'return', targetNodeKey: 'approval_upstream', comment: 'send back' })
    expect(afterReturn.currentNodeKey).toBe('approval_upstream')

    // ROUND 2: P re-approves upstream → forward through the condition, re-activating X (a FRESH epoch).
    const afterP2 = await act.p({ action: 'approve', comment: 'P r2' })
    expect(afterP2.currentNodeKey).toBe('approval_threshold')

    // ONE fresh vote must NOT re-satisfy the 2-of-3 on the stale round-1 A+B approves (which carry the
    // prior epoch). The epoch keys off X's ACTIVATION, so the condition-in-the-middle entry vector is
    // irrelevant — round 2 starts at 0 prior votes.
    const afterA2 = await act.a({ action: 'approve', comment: 'A r2 (1 of 2)' })
    expect(afterA2.status).toBe('pending')
    expect(afterA2.currentNodeKey).toBe('approval_threshold')

    // A second distinct fresh vote resolves the fresh round → advances.
    const afterB2 = await act.b({ action: 'approve', comment: 'B r2 (2 of 2)' })
    expect(afterB2.currentNodeKey).toBe('approval_second')
  })

  it('mid-round MANUAL TRANSFER preserves the node epoch — the transferred-in approver counts in the same round', async () => {
    const adminToken = await authToken(baseUrl, 'epoch-admin-transfer')
    const requesterToken = await authToken(baseUrl, 'epoch-requester-transfer')
    const aTok = await authToken(baseUrl, 'approver-a')
    const bTok = await authToken(baseUrl, 'approver-b')
    const dTok = await authToken(baseUrl, 'approver-d')

    const templateId = await publishGraphTemplate(adminToken, buildThresholdGraph())
    const inst = await createApproval(requesterToken, templateId, 'manual transfer preserves epoch')
    expect(inst.currentNodeKey).toBe('approval_threshold')
    const seqAtActivation = await nodeActivationSeq(inst.id)

    const act = { a: actor(aTok, inst.id), b: actor(bTok, inst.id), d: actor(dTok, inst.id) }

    // approver-a casts the first (partial) vote of the round.
    const afterA = await act.a({ action: 'approve', comment: 'A partial (1 of 2)' })
    expect(afterA.status).toBe('pending')
    expect(afterA.currentNodeKey).toBe('approval_threshold')
    expect(await nodeActivationSeq(inst.id)).toBe(seqAtActivation)

    // approver-b hands their still-pending seat to approver-d MID-ROUND (manual transfer).
    const seqBeforeTransfer = await nodeActivationSeq(inst.id)
    const transfer = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/actions`, bTok, {
      method: 'POST',
      body: { action: 'transfer', targetUserId: 'approver-d', comment: 'hand my seat to D' },
    })
    expect(transfer.status, await transfer.clone().text()).toBe(200)
    // §4·B invariant: a same-round mutation must NOT bump node_activation_seq.
    expect(await nodeActivationSeq(inst.id)).toBe(seqBeforeTransfer)
    expect(await activeAssigneeIds(inst.id)).toEqual(['approver-c', 'approver-d'])

    // The transferred-in D carries the SAME entry_epoch as the round; so A + D = 2 distinct → resolves.
    const afterD = await act.d({ action: 'approve', comment: 'D (2 of 2, same round as A)' })
    expect(afterD.status).toBe('approved')
    expect(afterD.currentNodeKey).toBeNull()

    // D's approve carries the current round's epoch and A + D were tallied together.
    const epochRows = await pool().query<{ entry_epoch: number | null }>(
      `SELECT DISTINCT entry_epoch FROM approval_assignments
        WHERE instance_id = $1 AND node_key = 'approval_threshold' AND assignee_id IN ('approver-a', 'approver-d')`,
      [inst.id],
    )
    expect(epochRows.rows).toHaveLength(1)
    expect(epochRows.rows[0].entry_epoch).not.toBeNull()
  })

  it('mid-round ADMIN REASSIGN / handover preserves the node epoch — the reassigned-in approver counts in the same round', async () => {
    await ensureUsers('approver-a', 'approver-b', 'approver-c', 'epoch-handover-to')
    const adminToken = await authToken(baseUrl, 'epoch-admin-reassign')
    const requesterToken = await authToken(baseUrl, 'epoch-requester-reassign')
    const aTok = await authToken(baseUrl, 'approver-a')
    const eTok = await authToken(baseUrl, 'epoch-handover-to')
    // Process-admin (bulk reassign) surface.
    const processAdmin = await authToken(baseUrl, 'epoch-process-admin')

    const templateId = await publishGraphTemplate(adminToken, buildThresholdGraph())
    const inst = await createApproval(requesterToken, templateId, 'admin reassign preserves epoch')
    expect(inst.currentNodeKey).toBe('approval_threshold')

    const act = { a: actor(aTok, inst.id), e: actor(eTok, inst.id) }

    // approver-a casts the first (partial) vote of the round.
    const afterA = await act.a({ action: 'approve', comment: 'A partial (1 of 2)' })
    expect(afterA.status).toBe('pending')
    expect(afterA.currentNodeKey).toBe('approval_threshold')

    // Admin reassigns approver-b's still-pending seat to epoch-handover-to MID-ROUND.
    const seqBeforeReassign = await nodeActivationSeq(inst.id)
    const reassign = await jsonRequest(baseUrl, '/api/approvals/admin/reassign', processAdmin, {
      method: 'POST',
      body: {
        fromUserId: 'approver-b',
        toUserId: 'epoch-handover-to',
        instanceIds: [inst.id],
        reason: 'B unavailable mid-round',
      },
    })
    expect(reassign.status, await reassign.clone().text()).toBe(200)
    const reassignBody = (await reassign.json()) as { data: { succeeded: string[]; skipped: unknown[] } }
    expect(reassignBody.data.succeeded).toEqual([inst.id])
    // §4·B invariant: reassign is a same-round mutation → node_activation_seq unchanged.
    expect(await nodeActivationSeq(inst.id)).toBe(seqBeforeReassign)
    expect(await activeAssigneeIds(inst.id)).toEqual(['approver-c', 'epoch-handover-to'])

    // The reassigned-in approver carries the round's epoch → A + handover-to = 2 distinct → resolves.
    const afterE = await act.e({ action: 'approve', comment: 'handover-to (2 of 2, same round as A)' })
    expect(afterE.status).toBe('approved')
    expect(afterE.currentNodeKey).toBeNull()

    const epochRows = await pool().query<{ entry_epoch: number | null }>(
      `SELECT DISTINCT entry_epoch FROM approval_assignments
        WHERE instance_id = $1 AND node_key = 'approval_threshold' AND assignee_id IN ('approver-a', 'epoch-handover-to')`,
      [inst.id],
    )
    expect(epochRows.rows).toHaveLength(1)
    expect(epochRows.rows[0].entry_epoch).not.toBeNull()
  })

  it('FAILS CLOSED when a threshold node active assignments span two distinct non-NULL epochs (§5 belt)', async () => {
    const adminToken = await authToken(baseUrl, 'epoch-admin-mixed')
    const requesterToken = await authToken(baseUrl, 'epoch-requester-mixed')
    const aTok = await authToken(baseUrl, 'approver-a')

    const templateId = await publishGraphTemplate(adminToken, buildThresholdGraph())
    const inst = await createApproval(requesterToken, templateId, 'mixed epoch fail-closed')
    expect(inst.currentNodeKey).toBe('approval_threshold')

    // Deliberately corrupt the invariant: force approver-c's active seat onto a DIFFERENT non-NULL
    // epoch so the node's active assignments span {n, n+9999} — a mis-classified insert would look
    // like this. currentNodeEntryEpoch must fail closed rather than MAX()-collapse the tally.
    const bump = await pool().query<{ count: string }>(
      `UPDATE approval_assignments
          SET entry_epoch = entry_epoch + 9999
        WHERE instance_id = $1 AND node_key = 'approval_threshold' AND assignee_id = 'approver-c' AND is_active = TRUE`,
      [inst.id],
    )
    expect(Number(bump.rowCount)).toBe(1)

    const distinct = await pool().query<{ entry_epoch: number | null }>(
      `SELECT DISTINCT entry_epoch FROM approval_assignments
        WHERE instance_id = $1 AND node_key = 'approval_threshold' AND is_active = TRUE`,
      [inst.id],
    )
    expect(distinct.rows.length).toBeGreaterThan(1)

    const response = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/actions`, aTok, {
      method: 'POST',
      body: { action: 'approve', comment: 'A against a mixed-epoch node' },
    })
    expect(response.status).toBe(500)
    const payload = (await response.json()) as { error?: { code?: string } }
    expect(payload.error?.code).toBe('APPROVAL_NODE_ENTRY_EPOCH_MIXED')

    // Fail-closed: the instance is untouched — still pending on the threshold node, no approve landed.
    const state = await pool().query<{ status: string; current_node_key: string | null }>(
      `SELECT status, current_node_key FROM approval_instances WHERE id = $1`,
      [inst.id],
    )
    expect(state.rows[0].status).toBe('pending')
    expect(state.rows[0].current_node_key).toBe('approval_threshold')
    const approves = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM approval_records WHERE instance_id = $1 AND action = 'approve'`,
      [inst.id],
    )
    expect(Number.parseInt(approves.rows[0].count, 10)).toBe(0)
  })

  it('MIGRATION dual-read: a legacy NULL-epoch round scopes via the cutoff fallback, then the epoch path takes over on re-activation', async () => {
    const adminToken = await authToken(baseUrl, 'epoch-admin-dualread')
    const requesterToken = await authToken(baseUrl, 'epoch-requester-dualread')
    const aTok = await authToken(baseUrl, 'approver-a')
    const bTok = await authToken(baseUrl, 'approver-b')

    const templateId = await publishGraphTemplate(adminToken, buildThresholdReentryGraph())
    const inst = await createApproval(requesterToken, templateId, 'dual-read migration')
    expect(inst.currentNodeKey).toBe('approval_threshold')

    // Simulate a threshold instance that was pending mid-round AT DEPLOY: its active assignments
    // carry entry_epoch = NULL (pre-migration activation). The instance counter is left intact so
    // subsequent activations still mint fresh epochs.
    const nulled = await pool().query(
      `UPDATE approval_assignments SET entry_epoch = NULL WHERE instance_id = $1`,
      [inst.id],
    )
    expect(Number(nulled.rowCount)).toBeGreaterThan(0)

    const act = { a: actor(aTok, inst.id), b: actor(bTok, inst.id) }

    // ROUND 1 runs entirely on the legacy (NULL-epoch) cutoff fallback: A partial keeps it pending,
    // B resolves the 2-of-3 and advances. The two approves are written epoch-less.
    const afterA1 = await act.a({ action: 'approve', comment: 'A r1 (legacy cutoff)' })
    expect(afterA1.status).toBe('pending')
    expect(afterA1.currentNodeKey).toBe('approval_threshold')
    const afterB1 = await act.b({ action: 'approve', comment: 'B r1 (legacy cutoff resolves)' })
    expect(afterB1.currentNodeKey).toBe('approval_second')

    // The round-1 approves are epoch-less (dual-read wrote no nodeEntryEpoch for the NULL round).
    const legacyApproves = await pool().query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM approval_records
        WHERE instance_id = $1 AND action = 'approve'
          AND metadata->>'nodeKey' = 'approval_threshold'
          AND metadata ? 'nodeEntryEpoch'`,
      [inst.id],
    )
    expect(Number.parseInt(legacyApproves.rows[0].count, 10)).toBe(0)

    // RE-ACTIVATION: approver-a (at the second node) returns to the threshold node. The return path
    // mints a FRESH epoch and stamps it on the re-activated seats — the instance switches to the
    // epoch path.
    const afterReturn = await act.a({ action: 'return', targetNodeKey: 'approval_threshold', comment: 'send back' })
    expect(afterReturn.currentNodeKey).toBe('approval_threshold')
    const reactivatedEpoch = await pool().query<{ entry_epoch: number | null }>(
      `SELECT DISTINCT entry_epoch FROM approval_assignments
        WHERE instance_id = $1 AND node_key = 'approval_threshold' AND is_active = TRUE`,
      [inst.id],
    )
    expect(reactivatedEpoch.rows).toHaveLength(1)
    expect(reactivatedEpoch.rows[0].entry_epoch).not.toBeNull()

    // ROUND 2 is scoped by the epoch, which EXCLUDES the epoch-less round-1 votes: ONE fresh vote must
    // NOT re-resolve on the stale legacy A+B approves.
    const afterA2 = await act.a({ action: 'approve', comment: 'A r2 (1 of 2, epoch path)' })
    expect(afterA2.status).toBe('pending')
    expect(afterA2.currentNodeKey).toBe('approval_threshold')

    // A second distinct fresh vote resolves the fresh round → advances again.
    const afterB2 = await act.b({ action: 'approve', comment: 'B r2 (2 of 2, epoch path)' })
    expect(afterB2.currentNodeKey).toBe('approval_second')
  })
})
