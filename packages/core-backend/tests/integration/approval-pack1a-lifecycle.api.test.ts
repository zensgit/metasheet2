import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

type JsonRecord = Record<string, unknown>

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

function buildAllModeGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_all',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['manager-1', 'manager-2'],
          approvalMode: 'all',
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-all', source: 'start', target: 'approval_all' },
      { key: 'edge-all-end', source: 'approval_all', target: 'end' },
    ],
  }
}

function buildReturnGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['manager-1'] },
      },
      {
        key: 'approval_2',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['manager-2'] },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-1', source: 'start', target: 'approval_1' },
      { key: 'edge-1-2', source: 'approval_1', target: 'approval_2' },
      { key: 'edge-2-end', source: 'approval_2', target: 'end' },
    ],
  }
}

function buildAutoApproveGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_empty',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [],
          approvalMode: 'single',
          emptyAssigneePolicy: 'auto-approve',
        },
      },
      {
        key: 'approval_final',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['manager-3'] },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-empty', source: 'start', target: 'approval_empty' },
      { key: 'edge-empty-final', source: 'approval_empty', target: 'approval_final' },
      { key: 'edge-final-end', source: 'approval_final', target: 'end' },
    ],
  }
}

describe('Approval Pack 1A lifecycle API', () => {
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
      // ignore cleanup failures
    }

    if (server) {
      await server.stop()
    }
  })

  it('keeps all-mode approvals pending until the final assignee approves', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-all')
    const requesterToken = await authToken(baseUrl, 'requester-all')
    const manager1Token = await authToken(baseUrl, 'manager-1')
    const manager2Token = await authToken(baseUrl, 'manager-2')
    const templateKey = `approval-pack1a-all-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'All Mode Template',
        description: 'approvalMode=all integration',
        formSchema: buildFormSchema(),
        approvalGraph: buildAllModeGraph(),
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
        formData: { reason: 'all-mode request' },
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
    expect(createdApproval.currentNodeKey).toBe('approval_all')
    expect(createdApproval.assignments.filter((assignment) => assignment.isActive).map((assignment) => assignment.assigneeId).sort())
      .toEqual(['manager-1', 'manager-2'])

    const firstApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, manager1Token, {
      method: 'POST',
      body: {
        action: 'approve',
        comment: 'manager-1 approved',
      },
    })
    expect(firstApproveResponse.status).toBe(200)
    const firstApproval = await firstApproveResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean }>
    }
    expect(firstApproval.status).toBe('pending')
    expect(firstApproval.currentNodeKey).toBe('approval_all')
    expect(firstApproval.assignments.filter((assignment) => assignment.isActive).map((assignment) => assignment.assigneeId))
      .toEqual(['manager-2'])

    const secondApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, manager2Token, {
      method: 'POST',
      body: {
        action: 'approve',
        comment: 'manager-2 approved',
      },
    })
    expect(secondApproveResponse.status).toBe(200)
    const completedApproval = await secondApproveResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ isActive: boolean }>
    }
    expect(completedApproval.status).toBe('approved')
    expect(completedApproval.currentNodeKey).toBeNull()
    expect(completedApproval.assignments.filter((assignment) => assignment.isActive)).toHaveLength(0)

    const pool = poolManager.get()
    const historyResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1 AND action = 'approve'
       ORDER BY to_version ASC, id ASC`,
      [createdApproval.id],
    )
    const approveEvents = historyResult.rows
    expect(approveEvents).toHaveLength(2)
    expect(approveEvents[0]?.metadata).toMatchObject({
      nodeKey: 'approval_all',
      nextNodeKey: 'approval_all',
      approvalMode: 'all',
      aggregateComplete: false,
      remainingAssignments: 1,
    })
    expect(approveEvents[1]?.metadata).toMatchObject({
      nodeKey: 'approval_all',
      nextNodeKey: null,
      approvalMode: 'all',
      aggregateComplete: true,
    })
  })

  it('returns a workflow to a previously visited approval node', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-return')
    const requesterToken = await authToken(baseUrl, 'requester-return')
    const manager1Token = await authToken(baseUrl, 'manager-1')
    const manager2Token = await authToken(baseUrl, 'manager-2')
    const templateKey = `approval-pack1a-return-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Return Template',
        description: 'return integration',
        formSchema: buildFormSchema(),
        approvalGraph: buildReturnGraph(),
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
        formData: { reason: 'return request' },
      },
    })
    expect(createResponse.status).toBe(201)
    const createdApproval = await createResponse.json() as { id: string }
    createdApprovalIds.add(createdApproval.id)

    const firstApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, manager1Token, {
      method: 'POST',
      body: {
        action: 'approve',
        comment: 'forward to second approver',
      },
    })
    expect(firstApproveResponse.status).toBe(200)
    const advancedApproval = await firstApproveResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    expect(advancedApproval.status).toBe('pending')
    expect(advancedApproval.currentNodeKey).toBe('approval_2')
    expect(advancedApproval.assignments.filter((assignment) => assignment.isActive).map((assignment) => assignment.assigneeId))
      .toEqual(['manager-2'])

    const returnResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, manager2Token, {
      method: 'POST',
      body: {
        action: 'return',
        targetNodeKey: 'approval_1',
        comment: '补充材料',
      },
    })
    expect(returnResponse.status).toBe(200)
    const returnedApproval = await returnResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    expect(returnedApproval.status).toBe('pending')
    expect(returnedApproval.currentNodeKey).toBe('approval_1')
    expect(
      returnedApproval.assignments
        .filter((assignment) => assignment.isActive)
        .map((assignment) => `${assignment.nodeKey}:${assignment.assigneeId}`),
    ).toEqual(['approval_1:manager-1'])

    const pool = poolManager.get()
    const historyResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1 AND action = 'return'`,
      [createdApproval.id],
    )
    expect(historyResult.rows).toHaveLength(1)
    expect(historyResult.rows[0]?.actor_id).toBe('manager-2')
    expect(historyResult.rows[0]?.to_status).toBe('pending')
    expect(historyResult.rows[0]?.metadata).toMatchObject({
      nodeKey: 'approval_2',
      targetNodeKey: 'approval_1',
      nextNodeKey: 'approval_1',
    })
  })

  it('auto-approves empty-assignee nodes and records a system approval history entry', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-auto')
    const requesterToken = await authToken(baseUrl, 'requester-auto')
    const templateKey = `approval-pack1a-auto-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Auto Approve Template',
        description: 'auto-approve integration',
        formSchema: buildFormSchema(),
        approvalGraph: buildAutoApproveGraph(),
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
        formData: { reason: 'auto-approve request' },
      },
    })
    expect(createResponse.status).toBe(201)
    const createdApproval = await createResponse.json() as {
      id: string
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
      requestNo?: string | null
    }
    createdApprovalIds.add(createdApproval.id)
    expect(createdApproval.status).toBe('pending')
    expect(createdApproval.currentNodeKey).toBe('approval_final')
    expect(createdApproval.requestNo).toMatch(/^AP-\d+$/)
    expect(
      createdApproval.assignments
        .filter((assignment) => assignment.isActive)
        .map((assignment) => `${assignment.nodeKey}:${assignment.assigneeId}`),
    ).toEqual(['approval_final:manager-3'])

    const pool = poolManager.get()
    const historyResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1
       ORDER BY occurred_at ASC, created_at ASC`,
      [createdApproval.id],
    )
    const autoApproveRecord = historyResult.rows.find((row) =>
      row.action === 'approve' && row.actor_id === 'system' && row.metadata?.autoApproved === true)
    expect(autoApproveRecord).toBeTruthy()
    expect(autoApproveRecord?.to_status).toBe('pending')
    expect(autoApproveRecord?.metadata).toMatchObject({
      nodeKey: 'approval_empty',
      sourceStep: 1,
      approvalMode: 'single',
      autoApproved: true,
      reason: 'empty-assignee',
    })
  })
})
