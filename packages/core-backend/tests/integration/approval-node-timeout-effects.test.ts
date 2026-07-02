import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { ApprovalMetricsService } from '../../src/services/ApprovalMetricsService'
import {
  ApprovalSlaScheduler,
  type ApprovalNodeTimeoutReminder,
} from '../../src/services/ApprovalSlaScheduler'

/**
 * T1-1 slice-2 — transfer/jump node-timeout effects (real DB, real HTTP publish/create path).
 *
 * Ballot decisions locked here:
 *  - Q1: transfer + jump wired; auto_* still publish-rejected (terminal gate CLOSED — no env set).
 *  - QS-a: timeout.transferToUserId / timeout.jumpToNodeKey publish validation (target-specific 400s).
 *  - QS-b: a jump whose resolution cascades to a TERMINAL state is SKIPPED (no state mutation) while
 *    APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS is unset, and the timeout is consumed (single-shot).
 *  - Q3: audit reuses actions 'transfer'/'jump' with metadata.timeoutEffect=true.
 *  - Q7: system actor 'system:approval-timeout'.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

type JsonRecord = Record<string, unknown>

type ApprovalRecordRow = {
  action: string
  actor_id: string | null
  to_status: string
  metadata: JsonRecord
}

type ApprovalAssignmentRow = {
  assignee_id: string
  is_active: boolean
}

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
  const payload = await response.json() as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
  return response
}

function buildFormSchema() {
  return {
    fields: [
      { id: 'reason', type: 'text', label: '事由', required: true },
    ],
  }
}

type TimeoutConfig = Record<string, unknown>

// Single approval node carrying a timeout config — publish-validation fixtures.
function buildSingleNodeGraph(timeout: TimeoutConfig | undefined) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'node_a',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['approver-a'],
          approvalMode: 'single',
          ...(timeout !== undefined ? { timeout } : {}),
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-a', source: 'start', target: 'node_a' },
      { key: 'edge-a-end', source: 'node_a', target: 'end' },
    ],
  }
}

// A(approver-a) -> B(approver-b, timeout) -> end. Fire the timeout while pending at B.
function buildTwoNodeGraph(timeoutOnB: TimeoutConfig) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'node_a',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['approver-a'], approvalMode: 'single' },
      },
      {
        key: 'node_b',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['approver-b'], approvalMode: 'single', timeout: timeoutOnB },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-a', source: 'start', target: 'node_a' },
      { key: 'edge-a-b', source: 'node_a', target: 'node_b' },
      { key: 'edge-b-end', source: 'node_b', target: 'end' },
    ],
  }
}

// A -> B(timeout jump -> C) -> C(requester-merged auto-approval) -> end: the timeout jump's
// cascade lands TERMINAL (approved) — must be gated-skipped while the terminal gate is closed.
function buildTerminalCascadeGraph(requesterId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'node_a',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['approver-a'], approvalMode: 'single' },
      },
      {
        key: 'node_b',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['approver-b'],
          approvalMode: 'single',
          timeout: { afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'node_c' },
        },
      },
      {
        key: 'node_c',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [requesterId],
          approvalMode: 'single',
          autoApprovalPolicy: { mergeWithRequester: true },
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-a', source: 'start', target: 'node_a' },
      { key: 'edge-a-b', source: 'node_a', target: 'node_b' },
      { key: 'edge-b-c', source: 'node_b', target: 'node_c' },
      { key: 'edge-c-end', source: 'node_c', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval T1-1 slice-2 node-timeout transfer/jump effects — real DB', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()

  function rawQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    return poolManager.get().query<T>(sql, params) as unknown as Promise<{ rows: T[] }>
  }

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    const pool = poolManager.get()
    try {
      const approvalIds = [...createdApprovalIds]
      const templateIds = [...createdTemplateIds]
      if (approvalIds.length > 0) {
        await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await pool.query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
    } catch {
      // Ignore cleanup failures — the top-level describe restart clears everything on rerun.
    }
    if (server) {
      await server.stop()
    }
  })

  async function createTemplate(adminToken: string, approvalGraph: object): Promise<Response> {
    const templateKey = `approval-t11s2-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    return jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Node Timeout Effects Template',
        description: 'T1-1 slice-2 transfer/jump timeout effects integration',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
  }

  async function publishGraphTemplate(adminToken: string, approvalGraph: object): Promise<string> {
    const templateResponse = await createTemplate(adminToken, approvalGraph)
    expect(templateResponse.status).toBe(201)
    const template = await templateResponse.json() as { id: string }
    createdTemplateIds.add(template.id)
    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResponse.status).toBe(200)
    return template.id
  }

  async function startApproval(requesterToken: string, templateId: string): Promise<{ id: string; currentNodeKey: string | null }> {
    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'node timeout effects' } },
    })
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json() as { id: string; currentNodeKey: string | null }
    createdApprovalIds.add(created.id)
    return created
  }

  // The decision(old node) + activation(new node) metrics writes after an approve are two CONCURRENT
  // unawaited best-effort calls, and recordNodeDecision clears the deadline columns — a late decision
  // write can wipe the fresh activation stamp (pre-existing slice-1 race, register reviewer note (3)).
  // Deterministic test arming: wait until the columns are STABLE across consecutive reads (in-flight
  // writers settled), then force-arm BOTH columns overdue (mirrors the slice-1 remind test seeding
  // metrics directly). The service re-validates the effect against the published graph config anyway.
  async function forceDeadlineOverdue(instanceId: string, effect: string): Promise<void> {
    let prev = ''
    let stable = 0
    for (let attempt = 0; attempt < 60 && stable < 3; attempt++) {
      const row = await rawQuery<{ current_node_deadline_at: unknown; current_node_timeout_effect: string | null }>(
        `SELECT current_node_deadline_at, current_node_timeout_effect FROM approval_metrics WHERE instance_id = $1`,
        [instanceId],
      )
      const sig = `${row.rows[0]?.current_node_timeout_effect ?? 'null'}|${row.rows[0]?.current_node_deadline_at ? 'set' : 'null'}`
      stable = sig === prev ? stable + 1 : 0
      prev = sig
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(stable).toBeGreaterThanOrEqual(3)
    const updated = await rawQuery(
      `UPDATE approval_metrics
         SET current_node_deadline_at = now() - INTERVAL '1 minute',
             current_node_timeout_effect = $2
       WHERE instance_id = $1
       RETURNING instance_id`,
      [instanceId, effect],
    )
    expect(updated.rows).toHaveLength(1)
  }

  async function fetchRecords(instanceId: string): Promise<ApprovalRecordRow[]> {
    const result = await rawQuery<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata FROM approval_records WHERE instance_id = $1 ORDER BY created_at ASC`,
      [instanceId],
    )
    return result.rows
  }

  async function fetchActiveAssignees(instanceId: string): Promise<string[]> {
    const result = await rawQuery<ApprovalAssignmentRow>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1`,
      [instanceId],
    )
    return result.rows.filter((row) => row.is_active).map((row) => row.assignee_id).sort()
  }

  async function fetchInstance(instanceId: string): Promise<{ status: string; current_node_key: string | null; version: number }> {
    const result = await rawQuery<{ status: string; current_node_key: string | null; version: number }>(
      `SELECT status, current_node_key, version FROM approval_instances WHERE id = $1`,
      [instanceId],
    )
    expect(result.rows).toHaveLength(1)
    return result.rows[0]
  }

  function buildScheduler(reminders?: ApprovalNodeTimeoutReminder[]): ApprovalSlaScheduler {
    const service = new ApprovalProductService()
    return new ApprovalSlaScheduler({
      metrics: new ApprovalMetricsService(rawQuery),
      pool: { query: rawQuery },
      onNodeReminder: reminders
        ? async (reminder) => { reminders.push(reminder) }
        : undefined,
      onNodeEffect: async ({ instanceId, effect }) => service.applyNodeTimeoutEffect(instanceId, effect),
    })
  }

  it('has DATABASE_URL configured (sentinel — never skip-green)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('terminal gate is CLOSED in this suite (owner amendment — no env enablement)', () => {
    expect(process.env.APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS).toBeUndefined()
  })

  it('publish REJECTS a transfer timeout without transferToUserId (QS-a)', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const response = await createTemplate(adminToken, buildSingleNodeGraph({ afterMinutes: 1, effect: 'transfer' }))
    expect(response.status).toBe(400)
    const body = await response.json() as { code?: string; error?: { code?: string } }
    expect(JSON.stringify(body)).toContain('APPROVAL_NODE_TIMEOUT_TARGET_INVALID')
  })

  it('publish REJECTS a jump timeout to a nonexistent node (QS-a)', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const response = await createTemplate(
      adminToken,
      buildSingleNodeGraph({ afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'no_such_node' }),
    )
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('APPROVAL_NODE_TIMEOUT_TARGET_INVALID')
  })

  it('publish REJECTS a jump timeout targeting a non-approval node (QS-a)', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const response = await createTemplate(
      adminToken,
      buildSingleNodeGraph({ afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'end' }),
    )
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('APPROVAL_NODE_TIMEOUT_TARGET_INVALID')
  })

  it('publish REJECTS a self-jump timeout (QS-a)', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const response = await createTemplate(
      adminToken,
      buildSingleNodeGraph({ afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'node_a' }),
    )
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('APPROVAL_NODE_TIMEOUT_TARGET_INVALID')
  })

  it('publish REJECTS a remind timeout carrying a stray target field (strict cross-field)', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const response = await createTemplate(
      adminToken,
      buildSingleNodeGraph({ afterMinutes: 1, effect: 'remind', transferToUserId: 'someone' }),
    )
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('APPROVAL_NODE_TIMEOUT_TARGET_INVALID')
  })

  it('publish still REJECTS auto_approve / auto_reject (terminal effects stay unwired)', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    for (const effect of ['auto_approve', 'auto_reject']) {
      const response = await createTemplate(adminToken, buildSingleNodeGraph({ afterMinutes: 1, effect }))
      expect(response.status).toBe(400)
      expect(JSON.stringify(await response.json())).toContain('APPROVAL_NODE_TIMEOUT_EFFECT_UNSUPPORTED')
    }
  })

  it('TRANSFER: an overdue transfer timeout hands the node to the target once (single-shot) and the node still completes', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const requesterToken = await authToken(baseUrl, 'timeout-requester')
    const targetToken = await authToken(baseUrl, 'timeout-target')

    const templateId = await publishGraphTemplate(
      adminToken,
      buildSingleNodeGraph({ afterMinutes: 1, effect: 'transfer', transferToUserId: 'timeout-target' }),
    )
    const inst = await startApproval(requesterToken, templateId)
    expect(inst.currentNodeKey).toBe('node_a')
    expect(await fetchActiveAssignees(inst.id)).toEqual(['approver-a'])

    await forceDeadlineOverdue(inst.id, 'transfer')
    const scheduler = buildScheduler()
    await scheduler.tick(new Date())

    // Node handed over: original approver inactive, target active; instance unchanged otherwise.
    expect(await fetchActiveAssignees(inst.id)).toEqual(['timeout-target'])
    const afterTransfer = await fetchInstance(inst.id)
    expect(afterTransfer.status).toBe('pending')
    expect(afterTransfer.current_node_key).toBe('node_a')

    // Audit: action='transfer', system actor, timeoutEffect discriminator (Q3/Q7).
    const records = await fetchRecords(inst.id)
    const transferRecords = records.filter((row) => row.action === 'transfer')
    expect(transferRecords).toHaveLength(1)
    expect(transferRecords[0].actor_id).toBe('system:approval-timeout')
    expect(transferRecords[0].metadata.timeoutEffect).toBe(true)
    expect(transferRecords[0].metadata.targetUserId).toBe('timeout-target')

    // Single-shot: deadline consumed inside the effect transaction; a second tick adds nothing.
    const deadline = await rawQuery<{ current_node_deadline_at: unknown }>(
      `SELECT current_node_deadline_at FROM approval_metrics WHERE instance_id = $1`,
      [inst.id],
    )
    expect(deadline.rows[0]?.current_node_deadline_at).toBeNull()
    await scheduler.tick(new Date())
    expect((await fetchRecords(inst.id)).filter((row) => row.action === 'transfer')).toHaveLength(1)

    // The handed-over node still functions: the target approves and the instance completes.
    const approve = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/actions`, targetToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'approved after timeout handover' },
    })
    expect(approve.status).toBe(200)
    expect((await fetchInstance(inst.id)).status).toBe('approved')
  })

  it('JUMP: an overdue jump timeout sends the instance to the target node with re-entry semantics', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const requesterToken = await authToken(baseUrl, 'timeout-requester')
    const approverAToken = await authToken(baseUrl, 'approver-a')

    const templateId = await publishGraphTemplate(
      adminToken,
      buildTwoNodeGraph({ afterMinutes: 1, effect: 'jump', jumpToNodeKey: 'node_a' }),
    )
    const inst = await startApproval(requesterToken, templateId)
    expect(inst.currentNodeKey).toBe('node_a')

    const firstApprove = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/actions`, approverAToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'advance to node_b' },
    })
    expect(firstApprove.status).toBe(200)
    const atB = await fetchInstance(inst.id)
    expect(atB.current_node_key).toBe('node_b')

    await forceDeadlineOverdue(inst.id, 'jump')
    const scheduler = buildScheduler()
    await scheduler.tick(new Date())

    // Jumped back to node_a: re-entry re-resolves node_a's assignment; version bumped.
    const afterJump = await fetchInstance(inst.id)
    expect(afterJump.status).toBe('pending')
    expect(afterJump.current_node_key).toBe('node_a')
    expect(afterJump.version).toBe(atB.version + 1)
    expect(await fetchActiveAssignees(inst.id)).toEqual(['approver-a'])

    const records = await fetchRecords(inst.id)
    const jumpRecords = records.filter((row) => row.action === 'jump')
    expect(jumpRecords).toHaveLength(1)
    expect(jumpRecords[0].actor_id).toBe('system:approval-timeout')
    expect(jumpRecords[0].metadata.timeoutEffect).toBe(true)
    expect(jumpRecords[0].metadata.toNodeKey).toBe('node_a')

    // node_a carries no timeout → the re-entry activation leaves no armed deadline.
    const deadline = await rawQuery<{ current_node_deadline_at: unknown }>(
      `SELECT current_node_deadline_at FROM approval_metrics WHERE instance_id = $1`,
      [inst.id],
    )
    expect(deadline.rows[0]?.current_node_deadline_at).toBeNull()

    // Single-shot: a second tick adds no further jump.
    await scheduler.tick(new Date())
    expect((await fetchRecords(inst.id)).filter((row) => row.action === 'jump')).toHaveLength(1)
  })

  it('QS-b GATED SKIP: a jump whose cascade lands TERMINAL is skipped with NO state mutation and the timeout is consumed', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const requesterToken = await authToken(baseUrl, 'timeout-requester-cascade')
    const approverAToken = await authToken(baseUrl, 'approver-a')

    const templateId = await publishGraphTemplate(adminToken, buildTerminalCascadeGraph('timeout-requester-cascade'))
    const inst = await startApproval(requesterToken, templateId)
    const firstApprove = await jsonRequest(baseUrl, `/api/approvals/${inst.id}/actions`, approverAToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'advance to node_b' },
    })
    expect(firstApprove.status).toBe(200)
    const atB = await fetchInstance(inst.id)
    expect(atB.current_node_key).toBe('node_b')

    await forceDeadlineOverdue(inst.id, 'jump')
    const service = new ApprovalProductService()
    const outcome = await service.applyNodeTimeoutEffect(inst.id, 'jump')
    expect(outcome).toBe('skipped_terminal_gated')

    // No state mutation: still pending at node_b, same version, approver-b still active, no jump record.
    const after = await fetchInstance(inst.id)
    expect(after.status).toBe('pending')
    expect(after.current_node_key).toBe('node_b')
    expect(after.version).toBe(atB.version)
    expect(await fetchActiveAssignees(inst.id)).toEqual(['approver-b'])
    expect((await fetchRecords(inst.id)).filter((row) => row.action === 'jump')).toHaveLength(0)

    // Timeout consumed (single-shot for this activation) so the gated skip cannot warn-loop every tick.
    const deadline = await rawQuery<{ current_node_deadline_at: unknown }>(
      `SELECT current_node_deadline_at FROM approval_metrics WHERE instance_id = $1`,
      [inst.id],
    )
    expect(deadline.rows[0]?.current_node_deadline_at).toBeNull()
  })

  it('RACE GUARD: a future (not yet due) deadline is skipped stale with nothing consumed or mutated', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const requesterToken = await authToken(baseUrl, 'timeout-requester')

    const templateId = await publishGraphTemplate(
      adminToken,
      buildSingleNodeGraph({ afterMinutes: 60, effect: 'transfer', transferToUserId: 'timeout-target' }),
    )
    const inst = await startApproval(requesterToken, templateId)

    const service = new ApprovalProductService()
    const outcome = await service.applyNodeTimeoutEffect(inst.id, 'transfer')
    expect(outcome).toBe('skipped_stale')

    // Untouched: original assignee still active, deadline still armed (future), no transfer record.
    expect(await fetchActiveAssignees(inst.id)).toEqual(['approver-a'])
    expect((await fetchRecords(inst.id)).filter((row) => row.action === 'transfer')).toHaveLength(0)
    const deadline = await rawQuery<{ current_node_deadline_at: unknown }>(
      `SELECT current_node_deadline_at FROM approval_metrics WHERE instance_id = $1`,
      [inst.id],
    )
    expect(deadline.rows[0]?.current_node_deadline_at).not.toBeNull()
  })

  it('REMIND regression: a remind timeout still notifies and never invokes the effect path', async () => {
    const adminToken = await authToken(baseUrl, 'timeout-admin')
    const requesterToken = await authToken(baseUrl, 'timeout-requester')

    const templateId = await publishGraphTemplate(
      adminToken,
      buildSingleNodeGraph({ afterMinutes: 1, effect: 'remind' }),
    )
    const inst = await startApproval(requesterToken, templateId)
    await forceDeadlineOverdue(inst.id, 'remind')

    const reminders: ApprovalNodeTimeoutReminder[] = []
    const scheduler = buildScheduler(reminders)
    await scheduler.tick(new Date())

    const mine = reminders.filter((r) => r.instanceId === inst.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].effect).toBe('remind')
    expect(mine[0].assigneeIds).toContain('approver-a')
    // No state mutation from the remind path.
    expect(await fetchActiveAssignees(inst.id)).toEqual(['approver-a'])
    expect((await fetchInstance(inst.id)).status).toBe('pending')
  })
})
