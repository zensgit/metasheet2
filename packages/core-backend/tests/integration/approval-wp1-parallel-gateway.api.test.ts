import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

type JsonRecord = Record<string, unknown>

type ApprovalAssignmentRow = {
  assignee_id: string
  node_key: string | null
  is_active: boolean
  metadata: JsonRecord | null
}

type ApprovalInstanceRow = {
  status: string
  current_node_key: string | null
  metadata: JsonRecord | null
}

type ApprovalRecordRow = {
  action: string
  actor_id: string | null
  to_status: string
  metadata: JsonRecord
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

/**
 * Two parallel branches join at a finance-review node before reaching end.
 * Branch A: legal-review (single approver, user legal-1)
 * Branch B: compliance-review (single approver, user compliance-1)
 * Shared join: finance-review (single approver, user finance-1)
 */
function buildParallelGatewayGraph(joinMode: 'all' | 'any' = 'all') {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'parallel_fork',
        type: 'parallel',
        config: {
          branches: ['edge-fork-legal', 'edge-fork-compliance'],
          joinMode,
          joinNodeKey: 'finance_review',
        },
      },
      {
        key: 'legal_review',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['legal-1'] },
      },
      {
        key: 'compliance_review',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['compliance-1'] },
      },
      {
        key: 'finance_review',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['finance-1'] },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
      { key: 'edge-fork-legal', source: 'parallel_fork', target: 'legal_review' },
      { key: 'edge-fork-compliance', source: 'parallel_fork', target: 'compliance_review' },
      { key: 'edge-legal-join', source: 'legal_review', target: 'finance_review' },
      { key: 'edge-compliance-join', source: 'compliance_review', target: 'finance_review' },
      { key: 'edge-finance-end', source: 'finance_review', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval Wave 2 WP1 parallel-gateway (并行分支) API', () => {
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

  it('forks two branches and joins only after all branches complete (joinMode=all)', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-parallel')
    const requesterToken = await authToken(baseUrl, 'requester-parallel')
    const legalToken = await authToken(baseUrl, 'legal-1')
    const complianceToken = await authToken(baseUrl, 'compliance-1')
    const financeToken = await authToken(baseUrl, 'finance-1')

    const templateKey = `approval-wp1-parallel-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Parallel Gateway Template',
        description: 'WP1 parallel-gateway integration',
        formSchema: buildFormSchema(),
        approvalGraph: buildParallelGatewayGraph(),
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

    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: {
        templateId: template.id,
        formData: { reason: 'parallel-gateway request' },
      },
    })
    expect(createResponse.status).toBe(201)
    const createdApproval = await createResponse.json() as {
      id: string
      status: string
      currentNodeKey: string | null
      currentNodeKeys?: string[] | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    createdApprovalIds.add(createdApproval.id)
    expect(createdApproval.status).toBe('pending')
    expect(createdApproval.currentNodeKey).toBe('parallel_fork')
    expect(createdApproval.currentNodeKeys).toBeDefined()
    expect([...(createdApproval.currentNodeKeys || [])].sort()).toEqual([
      'compliance_review',
      'legal_review',
    ])

    const activeAssignees = createdApproval.assignments
      .filter((a) => a.isActive)
      .map((a) => ({ assigneeId: a.assigneeId, nodeKey: a.nodeKey }))
      .sort((a, b) => a.assigneeId.localeCompare(b.assigneeId))
    expect(activeAssignees).toEqual([
      { assigneeId: 'compliance-1', nodeKey: 'compliance_review' },
      { assigneeId: 'legal-1', nodeKey: 'legal_review' },
    ])

    // First branch (legal) approves — the instance stays pending in parallel state
    // with the second branch still active.
    const legalApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, legalToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'legal ok' },
    })
    expect(legalApproveResponse.status).toBe(200)
    const afterLegal = await legalApproveResponse.json() as {
      status: string
      currentNodeKey: string | null
      currentNodeKeys?: string[] | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    expect(afterLegal.status).toBe('pending')
    expect(afterLegal.currentNodeKey).toBe('parallel_fork')
    expect(afterLegal.currentNodeKeys).toEqual(['compliance_review'])
    expect(
      afterLegal.assignments
        .filter((a) => a.isActive)
        .map((a) => ({ assigneeId: a.assigneeId, nodeKey: a.nodeKey })),
    ).toEqual([
      { assigneeId: 'compliance-1', nodeKey: 'compliance_review' },
    ])

    // Second branch (compliance) approves — join-all triggers, advance past
    // the join node to finance-review.
    const complianceApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, complianceToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'compliance ok' },
    })
    expect(complianceApproveResponse.status).toBe(200)
    const afterCompliance = await complianceApproveResponse.json() as {
      status: string
      currentNodeKey: string | null
      currentNodeKeys?: string[] | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    expect(afterCompliance.status).toBe('pending')
    expect(afterCompliance.currentNodeKey).toBe('finance_review')
    expect(afterCompliance.currentNodeKeys).toBeFalsy()
    expect(
      afterCompliance.assignments
        .filter((a) => a.isActive)
        .map((a) => ({ assigneeId: a.assigneeId, nodeKey: a.nodeKey })),
    ).toEqual([
      { assigneeId: 'finance-1', nodeKey: 'finance_review' },
    ])

    // Sanity: metadata no longer carries parallelBranchStates once the region closes.
    const pool = poolManager.get()
    const instanceResult = await pool.query<ApprovalInstanceRow>(
      `SELECT status, current_node_key, metadata FROM approval_instances WHERE id = $1`,
      [createdApproval.id],
    )
    expect(instanceResult.rows[0]?.current_node_key).toBe('finance_review')
    expect((instanceResult.rows[0]?.metadata as JsonRecord | undefined)?.parallelBranchStates).toBeUndefined()

    // Post-join approval completes the whole instance.
    const financeApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, financeToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'finance ok' },
    })
    expect(financeApproveResponse.status).toBe(200)
    const afterFinance = await financeApproveResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean }>
    }
    expect(afterFinance.status).toBe('approved')
    expect(afterFinance.currentNodeKey).toBeNull()
    expect(afterFinance.assignments.filter((a) => a.isActive)).toHaveLength(0)

    // Audit trail: two branch approvals, then join-close approval.
    const approveRecordsResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1 AND action = 'approve'
       ORDER BY to_version ASC, created_at ASC`,
      [createdApproval.id],
    )
    expect(approveRecordsResult.rows).toHaveLength(3)
    expect(approveRecordsResult.rows[0]?.actor_id).toBe('legal-1')
    expect(approveRecordsResult.rows[0]?.metadata).toMatchObject({
      nodeKey: 'legal_review',
      parallelNodeKey: 'parallel_fork',
      parallelBranchComplete: false,
    })
    expect(approveRecordsResult.rows[1]?.actor_id).toBe('compliance-1')
    expect(approveRecordsResult.rows[1]?.metadata).toMatchObject({
      nodeKey: 'compliance_review',
      parallelNodeKey: 'parallel_fork',
      parallelBranchComplete: true,
      nextNodeKey: 'finance_review',
    })
    expect(approveRecordsResult.rows[2]?.actor_id).toBe('finance-1')
    expect(approveRecordsResult.rows[2]?.metadata).toMatchObject({
      nodeKey: 'finance_review',
      nextNodeKey: null,
      aggregateComplete: true,
    })
  })

  it('joins after the first completed branch and cancels sibling branches (joinMode=any)', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-parallel-any')
    const requesterToken = await authToken(baseUrl, 'requester-parallel-any')
    const legalToken = await authToken(baseUrl, 'legal-1')
    const complianceToken = await authToken(baseUrl, 'compliance-1')
    const financeToken = await authToken(baseUrl, 'finance-1')

    const templateKey = `approval-wp1-parallel-any-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Parallel Gateway Any Template',
        description: 'WP1 parallel-gateway join-any integration',
        formSchema: buildFormSchema(),
        approvalGraph: buildParallelGatewayGraph('any'),
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

    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: {
        templateId: template.id,
        formData: { reason: 'parallel-gateway join-any request' },
      },
    })
    expect(createResponse.status).toBe(201)
    const createdApproval = await createResponse.json() as {
      id: string
      status: string
      currentNodeKey: string | null
      currentNodeKeys?: string[] | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    createdApprovalIds.add(createdApproval.id)
    expect(createdApproval.status).toBe('pending')
    expect(createdApproval.currentNodeKey).toBe('parallel_fork')
    expect([...(createdApproval.currentNodeKeys || [])].sort()).toEqual([
      'compliance_review',
      'legal_review',
    ])

    const legalApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, legalToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'legal wins join-any' },
    })
    expect(legalApproveResponse.status).toBe(200)
    const afterLegal = await legalApproveResponse.json() as {
      status: string
      currentNodeKey: string | null
      currentNodeKeys?: string[] | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null; metadata?: JsonRecord }>
    }
    expect(afterLegal.status).toBe('pending')
    expect(afterLegal.currentNodeKey).toBe('finance_review')
    expect(afterLegal.currentNodeKeys).toBeFalsy()
    expect(
      afterLegal.assignments
        .filter((a) => a.isActive)
        .map((a) => ({ assigneeId: a.assigneeId, nodeKey: a.nodeKey })),
    ).toEqual([
      { assigneeId: 'finance-1', nodeKey: 'finance_review' },
    ])

    const pool = poolManager.get()
    const assignmentResult = await pool.query<ApprovalAssignmentRow>(
      `SELECT assignee_id, node_key, is_active, metadata
       FROM approval_assignments
       WHERE instance_id = $1
       ORDER BY created_at ASC`,
      [createdApproval.id],
    )
    const complianceAssignment = assignmentResult.rows.find((row) => row.assignee_id === 'compliance-1')
    expect(complianceAssignment?.is_active).toBe(false)
    expect(complianceAssignment?.metadata).toMatchObject({
      parallelCancelledBy: 'legal-1',
      parallelJoinMode: 'any',
      parallelNodeKey: 'parallel_fork',
    })

    const instanceResult = await pool.query<ApprovalInstanceRow>(
      `SELECT status, current_node_key, metadata FROM approval_instances WHERE id = $1`,
      [createdApproval.id],
    )
    expect(instanceResult.rows[0]?.current_node_key).toBe('finance_review')
    expect((instanceResult.rows[0]?.metadata as JsonRecord | undefined)?.parallelBranchStates).toBeUndefined()

    const complianceApproveResponse = await jsonRequest(
      baseUrl,
      `/api/approvals/${createdApproval.id}/actions`,
      complianceToken,
      {
        method: 'POST',
        body: { action: 'approve', comment: 'too late' },
      },
    )
    expect(complianceApproveResponse.status).toBe(403)

    const financeApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, financeToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'finance ok' },
    })
    expect(financeApproveResponse.status).toBe(200)
    const afterFinance = await financeApproveResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean }>
    }
    expect(afterFinance.status).toBe('approved')
    expect(afterFinance.currentNodeKey).toBeNull()
    expect(afterFinance.assignments.filter((a) => a.isActive)).toHaveLength(0)

    const recordsResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1
       ORDER BY to_version ASC, created_at ASC`,
      [createdApproval.id],
    )
    const legalApproveRecord = recordsResult.rows.find((row) => row.action === 'approve' && row.actor_id === 'legal-1')
    expect(legalApproveRecord?.metadata).toMatchObject({
      nodeKey: 'legal_review',
      nextNodeKey: 'finance_review',
      parallelNodeKey: 'parallel_fork',
      parallelBranchComplete: true,
      parallelJoinMode: 'any',
      parallelCancelledAssignees: ['compliance-1'],
    })
    const cancellationRecord = recordsResult.rows.find((row) =>
      row.action === 'sign' && row.metadata.parallelAutoCancelled === true)
    expect(cancellationRecord?.metadata).toMatchObject({
      nodeKey: 'legal_review',
      parallelJoinMode: 'any',
      parallelNodeKey: 'parallel_fork',
      parallelCancelledBy: 'legal-1',
      cancelledAssignees: ['compliance-1'],
    })
  })

  it('rejects return while the instance is in a parallel branch with a typed error', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-parallel-return')
    const requesterToken = await authToken(baseUrl, 'requester-parallel-return')
    const legalToken = await authToken(baseUrl, 'legal-2')
    const templateKey = `approval-wp1-parallel-return-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Parallel Gateway Return-Reject Template',
        description: 'return during parallel should be rejected',
        formSchema: buildFormSchema(),
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'parallel_fork_2',
              type: 'parallel',
              config: {
                branches: ['edge-fork-legal-2', 'edge-fork-compliance-2'],
                joinMode: 'all',
                joinNodeKey: 'finance_review_2',
              },
            },
            {
              key: 'legal_review_2',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['legal-2'] },
            },
            {
              key: 'compliance_review_2',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['compliance-2'] },
            },
            {
              key: 'finance_review_2',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['finance-2'] },
            },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-fork-2', source: 'start', target: 'parallel_fork_2' },
            { key: 'edge-fork-legal-2', source: 'parallel_fork_2', target: 'legal_review_2' },
            { key: 'edge-fork-compliance-2', source: 'parallel_fork_2', target: 'compliance_review_2' },
            { key: 'edge-legal-join-2', source: 'legal_review_2', target: 'finance_review_2' },
            { key: 'edge-compliance-join-2', source: 'compliance_review_2', target: 'finance_review_2' },
            { key: 'edge-finance-end-2', source: 'finance_review_2', target: 'end' },
          ],
        },
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

    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId: template.id, formData: { reason: 'return should fail' } },
    })
    expect(createResponse.status).toBe(201)
    const createdApproval = await createResponse.json() as { id: string }
    createdApprovalIds.add(createdApproval.id)

    const returnResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, legalToken, {
      method: 'POST',
      body: { action: 'return', comment: 'not valid', targetNodeKey: 'start' },
    })
    expect(returnResponse.status).toBe(409)
    const errorPayload = await returnResponse.json() as { error?: { code?: string } }
    expect(errorPayload.error?.code).toBe('APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED')
  })

  it('rejects templates whose parallel branches share an approver', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-parallel-dup')
    const templateKey = `approval-wp1-parallel-dup-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Parallel Gateway Duplicate Approver Template',
        description: 'duplicate approver across branches must be rejected',
        formSchema: buildFormSchema(),
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'parallel_fork_dup',
              type: 'parallel',
              config: {
                branches: ['edge-fork-a-dup', 'edge-fork-b-dup'],
                joinMode: 'all',
                joinNodeKey: 'finance_review_dup',
              },
            },
            {
              key: 'branch_a_dup',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['shared-approver'] },
            },
            {
              key: 'branch_b_dup',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['shared-approver'] },
            },
            {
              key: 'finance_review_dup',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['finance-dup'] },
            },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-fork-dup', source: 'start', target: 'parallel_fork_dup' },
            { key: 'edge-fork-a-dup', source: 'parallel_fork_dup', target: 'branch_a_dup' },
            { key: 'edge-fork-b-dup', source: 'parallel_fork_dup', target: 'branch_b_dup' },
            { key: 'edge-a-join-dup', source: 'branch_a_dup', target: 'finance_review_dup' },
            { key: 'edge-b-join-dup', source: 'branch_b_dup', target: 'finance_review_dup' },
            { key: 'edge-finance-end-dup', source: 'finance_review_dup', target: 'end' },
          ],
        },
      },
    })
    expect(templateResponse.status).toBe(400)
    const errorPayload = await templateResponse.json() as { error?: { code?: string; message?: string } }
    expect(errorPayload.error?.code).toBe('VALIDATION_ERROR')
    expect(errorPayload.error?.message || '').toMatch(/duplicate approver/i)
  })
})
