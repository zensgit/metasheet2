import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

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
  metadata: JsonRecord | null
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
  options: {
    method?: string
    body?: unknown
  } = {},
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
      {
        id: 'reason',
        type: 'text',
        label: '事由',
        required: true,
      },
    ],
  }
}

// T2-4: a single approval node with three baked assignees (M=3) and threshold N=2.
// The node resolves APPROVED on the 2nd distinct approval; the 3rd assignee is cancelled.
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

// T2-4 P1 semantic-hole regression: a ROLE source resolves only M=2 distinct approver slots
// but the node config demands N=3. Publish-time validation only bounds N <= M for the fully-
// static USER case, so this graph publishes; the N > M must be caught FAIL-CLOSED when the
// assignments are RESOLVED at create — never silently approved once the 2 slots are exhausted
// with the 3rd approval impossible.
function buildUnreachableThresholdGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_threshold',
        type: 'approval',
        config: {
          assigneeType: 'role',
          assigneeIds: ['role-reviewers', 'role-leads'], // M = 2 distinct role slots
          approvalMode: 'threshold',
          approvalThreshold: 3, // N = 3 > M = 2
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

describeIfDatabase('Approval T2-4 N-of-M threshold (门槛会签) API', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)

    await ensureApprovalSchemaReady()

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
    })
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

  async function publishGraphTemplate(adminToken: string, approvalGraph: object): Promise<string> {
    const templateKey = `approval-t24-threshold-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Threshold Mode Template',
        description: 'approvalMode=threshold (N-of-M) integration',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
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

  async function publishThresholdTemplate(adminToken: string): Promise<string> {
    return publishGraphTemplate(adminToken, buildThresholdGraph())
  }

  it('resolves a threshold (2-of-3) node on the SECOND distinct approval and cancels the third assignee', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-threshold')
    const requesterToken = await authToken(baseUrl, 'requester-threshold')
    const approverAToken = await authToken(baseUrl, 'approver-a')
    const approverBToken = await authToken(baseUrl, 'approver-b')
    const approverCToken = await authToken(baseUrl, 'approver-c')

    const templateId = await publishThresholdTemplate(adminToken)

    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: {
        templateId,
        formData: { reason: 'threshold request' },
      },
    })
    expect(createResponse.status).toBe(201)
    const createdApproval = await createResponse.json() as {
      id: string
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    createdApprovalIds.add(createdApproval.id)
    expect(createdApproval.status).toBe('pending')
    expect(createdApproval.currentNodeKey).toBe('approval_threshold')
    expect(
      createdApproval.assignments
        .filter((assignment) => assignment.isActive)
        .map((assignment) => assignment.assigneeId)
        .sort(),
    ).toEqual(['approver-a', 'approver-b', 'approver-c'])

    // FIRST approval (approver-a): threshold (2) not yet met → node stays pending, siblings active.
    const firstApprove = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, approverAToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'approver-a (1 of 2)' },
    })
    expect(firstApprove.status).toBe(200)
    const afterFirst = await firstApprove.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean }>
    }
    expect(afterFirst.status).toBe('pending')
    expect(afterFirst.currentNodeKey).toBe('approval_threshold')
    expect(
      afterFirst.assignments
        .filter((assignment) => assignment.isActive)
        .map((assignment) => assignment.assigneeId)
        .sort(),
    ).toEqual(['approver-b', 'approver-c'])

    // SECOND distinct approval (approver-b): threshold met → APPROVED, approver-c cancelled.
    const secondApprove = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, approverBToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'approver-b (2 of 2)' },
    })
    expect(secondApprove.status).toBe(200)
    const afterSecond = await secondApprove.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean }>
    }
    expect(afterSecond.status).toBe('approved')
    expect(afterSecond.currentNodeKey).toBeNull()
    expect(afterSecond.assignments.filter((assignment) => assignment.isActive)).toHaveLength(0)

    const pool = poolManager.get()
    const assignmentResult = await pool.query<ApprovalAssignmentRow>(
      `SELECT assignee_id, is_active, metadata
       FROM approval_assignments
       WHERE instance_id = $1
       ORDER BY assignee_id ASC`,
      [createdApproval.id],
    )
    // approver-c's still-pending assignment is cancelled the moment the Nth (2nd) approval lands.
    const approverCRow = assignmentResult.rows.find((row) => row.assignee_id === 'approver-c')
    expect(approverCRow).toBeTruthy()
    expect(approverCRow?.is_active).toBe(false)
    expect(approverCRow?.metadata).toMatchObject({
      aggregateCancelledBy: 'approver-b',
      aggregateMode: 'threshold',
    })
    expect(typeof (approverCRow?.metadata as JsonRecord | undefined)?.aggregateCancelledAt).toBe('string')

    // The two approvers' own rows are deactivated WITHOUT the sibling-cancel metadata.
    const approverARow = assignmentResult.rows.find((row) => row.assignee_id === 'approver-a')
    expect(approverARow?.is_active).toBe(false)
    expect((approverARow?.metadata as JsonRecord | undefined)?.aggregateCancelledBy).toBeUndefined()
    const approverBRow = assignmentResult.rows.find((row) => row.assignee_id === 'approver-b')
    expect(approverBRow?.is_active).toBe(false)
    expect((approverBRow?.metadata as JsonRecord | undefined)?.aggregateCancelledBy).toBeUndefined()

    // Two approve records: approver-a partial (aggregateComplete false) + approver-b complete.
    const approveRecordsResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1 AND action = 'approve'
       ORDER BY to_version ASC, created_at ASC`,
      [createdApproval.id],
    )
    expect(approveRecordsResult.rows).toHaveLength(2)
    expect(approveRecordsResult.rows[0]?.actor_id).toBe('approver-a')
    expect(approveRecordsResult.rows[0]?.to_status).toBe('pending')
    expect(approveRecordsResult.rows[0]?.metadata).toMatchObject({
      nodeKey: 'approval_threshold',
      approvalMode: 'threshold',
      aggregateComplete: false,
      approvalThreshold: 2,
      approvedCount: 1,
    })
    expect(approveRecordsResult.rows[1]?.actor_id).toBe('approver-b')
    expect(approveRecordsResult.rows[1]?.to_status).toBe('approved')
    expect(approveRecordsResult.rows[1]?.metadata).toMatchObject({
      nodeKey: 'approval_threshold',
      nextNodeKey: null,
      approvalMode: 'threshold',
      aggregateComplete: true,
      approvalThreshold: 2,
      aggregateCancelled: ['approver-c'],
    })

    // One system 'sign' audit row records the threshold-driven sibling cancellation.
    const signRecordsResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1 AND action = 'sign'
       ORDER BY created_at ASC`,
      [createdApproval.id],
    )
    expect(signRecordsResult.rows).toHaveLength(1)
    expect(signRecordsResult.rows[0]?.actor_id).toBe('system')
    expect(signRecordsResult.rows[0]?.metadata).toMatchObject({
      nodeKey: 'approval_threshold',
      autoCancelled: true,
      aggregateMode: 'threshold',
      aggregateCancelledBy: 'approver-b',
      cancelledAssignees: ['approver-c'],
    })

    // approver-c attempting to approve afterward is rejected — their active assignment is gone.
    const lateApprove = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, approverCToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'too late' },
    })
    expect(lateApprove.status).toBe(403)
    const errorPayload = await lateApprove.json() as { error?: { code?: string } }
    expect(errorPayload.error?.code).toBe('APPROVAL_ASSIGNMENT_REQUIRED')
  })

  it('still REJECTS the whole instance on a single reject (destructive path unchanged)', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-threshold-rej')
    const requesterToken = await authToken(baseUrl, 'requester-threshold-rej')
    const approverAToken = await authToken(baseUrl, 'approver-a')

    const templateId = await publishThresholdTemplate(adminToken)

    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: {
        templateId,
        formData: { reason: 'threshold reject request' },
      },
    })
    expect(createResponse.status).toBe(201)
    const createdApproval = await createResponse.json() as { id: string; status: string }
    createdApprovalIds.add(createdApproval.id)
    expect(createdApproval.status).toBe('pending')

    // A single reject terminates the instance — no N-of-M counting on the destructive path.
    const rejectResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, approverAToken, {
      method: 'POST',
      body: { action: 'reject', comment: 'one reject ends it' },
    })
    expect(rejectResponse.status).toBe(200)
    const rejected = await rejectResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean }>
    }
    expect(rejected.status).toBe('rejected')
    expect(rejected.currentNodeKey).toBeNull()
    expect(rejected.assignments.filter((assignment) => assignment.isActive)).toHaveLength(0)

    const pool = poolManager.get()
    const activeAfterReject = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE`,
      [createdApproval.id],
    )
    expect(Number.parseInt(activeAfterReject.rows[0]?.count || '0', 10)).toBe(0)
  })

  it('FAILS CLOSED at resolution when threshold N exceeds the resolved approver count (N > M)', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-threshold-nm')
    const requesterToken = await authToken(baseUrl, 'requester-threshold-nm')

    // Publish SUCCEEDS: publish-time N <= M validation only covers fully-static USER lists, so a
    // 2-role / threshold-3 node passes authoring. This is exactly the P1 semantic hole — a
    // DYNAMIC/ROLE source whose resolved M is never re-checked against N.
    const templateId = await publishGraphTemplate(adminToken, buildUnreachableThresholdGraph())

    // createApproval resolves the role source to M=2 distinct slots < threshold N=3. It MUST fail
    // closed at resolution rather than create a node that silently approves once its 2 assignments
    // are exhausted (the 3rd distinct approval being impossible). Against the pre-fix code this
    // returns 201 and creates a node that would silent-approve a 3-of-2 — the assertion goes RED.
    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: {
        templateId,
        formData: { reason: 'unreachable threshold request' },
      },
    })
    expect(createResponse.status).toBe(422)
    const errorPayload = await createResponse.json() as { id?: string; error?: { code?: string } }
    if (errorPayload.id) {
      createdApprovalIds.add(errorPayload.id)
    }
    expect(errorPayload.error?.code).toBe('APPROVAL_THRESHOLD_UNREACHABLE')

    // Fail-closed-at-resolution means no instance was ever inserted (the throw fires before the
    // create transaction begins) — so the unmet threshold can never be silently approved later.
    const pool = poolManager.get()
    const leakedInstances = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM approval_instances WHERE template_id = $1`,
      [templateId],
    )
    expect(Number.parseInt(leakedInstances.rows[0]?.count || '0', 10)).toBe(0)
  })
})
