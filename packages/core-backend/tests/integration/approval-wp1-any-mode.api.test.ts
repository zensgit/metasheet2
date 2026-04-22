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

function buildAnyModeGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_any',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['approver-a', 'approver-b'],
          approvalMode: 'any',
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-any', source: 'start', target: 'approval_any' },
      { key: 'edge-any-end', source: 'approval_any', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval Wave 2 WP1 any-mode (或签) API', () => {
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

  it('advances an any-mode approval on the first approver and cancels siblings with audit metadata', async () => {
    const adminToken = await authToken(baseUrl, 'approval-admin-any')
    const requesterToken = await authToken(baseUrl, 'requester-any')
    const approverAToken = await authToken(baseUrl, 'approver-a')
    const approverBToken = await authToken(baseUrl, 'approver-b')
    const templateKey = `approval-wp1-any-${Date.now()}`

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'Any Mode Template',
        description: 'approvalMode=any integration',
        formSchema: buildFormSchema(),
        approvalGraph: buildAnyModeGraph(),
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
        formData: { reason: 'any-mode request' },
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
    expect(createdApproval.currentNodeKey).toBe('approval_any')
    expect(
      createdApproval.assignments
        .filter((assignment) => assignment.isActive)
        .map((assignment) => assignment.assigneeId)
        .sort(),
    ).toEqual(['approver-a', 'approver-b'])

    const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, approverAToken, {
      method: 'POST',
      body: {
        action: 'approve',
        comment: 'approver-a wins',
      },
    })
    expect(approveResponse.status).toBe(200)
    const completedApproval = await approveResponse.json() as {
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; metadata?: JsonRecord }>
    }
    expect(completedApproval.status).toBe('approved')
    expect(completedApproval.currentNodeKey).toBeNull()
    expect(completedApproval.assignments.filter((assignment) => assignment.isActive)).toHaveLength(0)

    const pool = poolManager.get()
    const assignmentResult = await pool.query<ApprovalAssignmentRow>(
      `SELECT assignee_id, is_active, metadata
       FROM approval_assignments
       WHERE instance_id = $1
       ORDER BY assignee_id ASC`,
      [createdApproval.id],
    )
    const approverBRow = assignmentResult.rows.find((row) => row.assignee_id === 'approver-b')
    expect(approverBRow).toBeTruthy()
    expect(approverBRow?.is_active).toBe(false)
    expect(approverBRow?.metadata).toMatchObject({
      aggregateCancelledBy: 'approver-a',
      aggregateMode: 'any',
    })
    expect(typeof (approverBRow?.metadata as JsonRecord | undefined)?.aggregateCancelledAt).toBe('string')

    const approverARow = assignmentResult.rows.find((row) => row.assignee_id === 'approver-a')
    expect(approverARow?.is_active).toBe(false)
    // approver-a's own row should NOT carry aggregateCancelledBy — that metadata is reserved for siblings.
    expect((approverARow?.metadata as JsonRecord | undefined)?.aggregateCancelledBy).toBeUndefined()

    const approveRecordsResult = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, metadata
       FROM approval_records
       WHERE instance_id = $1 AND action = 'approve'
       ORDER BY to_version ASC, created_at ASC`,
      [createdApproval.id],
    )
    expect(approveRecordsResult.rows).toHaveLength(1)
    expect(approveRecordsResult.rows[0]?.actor_id).toBe('approver-a')
    expect(approveRecordsResult.rows[0]?.to_status).toBe('approved')
    expect(approveRecordsResult.rows[0]?.metadata).toMatchObject({
      nodeKey: 'approval_any',
      nextNodeKey: null,
      approvalMode: 'any',
      aggregateComplete: true,
      aggregateCancelled: ['approver-b'],
    })

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
      nodeKey: 'approval_any',
      autoCancelled: true,
      aggregateMode: 'any',
      aggregateCancelledBy: 'approver-a',
      cancelledAssignees: ['approver-b'],
    })

    // approver-b attempting to approve afterward should be rejected — the active assignment is gone.
    const lateApproveResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/actions`, approverBToken, {
      method: 'POST',
      body: {
        action: 'approve',
        comment: 'too late',
      },
    })
    expect(lateApproveResponse.status).toBe(403)
    const errorPayload = await lateApproveResponse.json() as { error?: { code?: string } }
    expect(errorPayload.error?.code).toBe('APPROVAL_ASSIGNMENT_REQUIRED')

    const timelineResponse = await jsonRequest(baseUrl, `/api/approvals/${createdApproval.id}/history`, approverAToken)
    expect(timelineResponse.status).toBe(200)
    const timelinePayload = await timelineResponse.json() as {
      ok: boolean
      data: { items: Array<{ action: string; metadata?: JsonRecord }> }
    }
    const actions = timelinePayload.data.items.map((item) => item.action)
    expect(actions).toContain('approve')
    expect(actions).toContain('sign')
  })
})
