// Operator-UAT-as-integration: exercises the approval template-authoring MVP's
// real end-to-end path against a REAL Postgres + the REAL MetaSheetServer (no mocks) —
// create (authoring shape w/ form_field_user) -> publish (real buildRuntimeGraph compile)
// -> start (POST /api/approvals, the same backend the /approvals/new/:id UI calls)
// -> assert the approver resolves from the form field at runtime.
//
// This is the API+DB layer of the operator UAT. It does NOT drive the deployed browser UI
// (host-blocked); the FE fail-closed behaviour is covered by apps/web's authoring spec.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// Same self-guard as the other approval *.api.test.ts (e.g. approval-wp1): this suite boots a real
// MetaSheetServer + connects to Postgres, so it must SKIP when DATABASE_URL is unset (the unit
// `test (18.x/20.x)` jobs, which match tests/integration but provide no DB) and RUN in the
// DB-provisioned plugin-tests `test:integration` step.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

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
  return await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

// The exact shape the frontend authoring MVP emits (buildFormSchema / buildApprovalGraph in
// apps/web/src/approvals/templateAuthoring.ts): linear start->approval_1->end, a `user`-typed
// `reviewer` field, and a form_field_user assignee source pointing at it.
function authoringFormSchema() {
  return {
    fields: [
      { id: 'amount', type: 'number', label: 'Amount', required: true },
      { id: 'reviewer', type: 'user', label: 'Reviewer', required: true },
    ],
  }
}
function authoringApprovalGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 'Start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        name: 'Reviewer',
        config: {
          assigneeSources: [{ kind: 'form_field_user', fieldId: 'reviewer' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
        },
      },
      { key: 'end', type: 'end', name: 'End', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval template authoring MVP — operator UAT (real DB, no mocks)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let adminToken = ''
  let requesterToken = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    expect(canListen).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address.port}`
    adminToken = await authToken(baseUrl, 'uat-admin')
    requesterToken = await authToken(baseUrl, 'uat-requester')
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
    if (server) await server.stop()
  })

  it('create -> publish -> start: the form_field_user approver resolves to the submitted form value', async () => {
    // 1. CREATE (authoring-MVP shape) via the real route
    const createResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: `uat-authoring-${Date.now()}`,
        name: 'UAT Authoring — Expense',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: authoringFormSchema(),
        approvalGraph: authoringApprovalGraph(),
      },
    })
    expect(createResp.status).toBe(201)
    const template = await createResp.json() as { id: string }
    expect(template.id).toBeTruthy()
    createdTemplateIds.add(template.id)

    // 2. VISIBLE in the template centre list
    const listResp = await jsonRequest(baseUrl, '/api/approval-templates', adminToken)
    expect(listResp.status).toBe(200)
    // List route envelope is { data, total, limit, offset } (approvals.ts:297).
    const listed = await listResp.json() as { data: Array<{ id: string }> }
    expect(listed.data.map((t) => t.id)).toContain(template.id)

    // 3. PUBLISH — runs the REAL approvalGraph -> runtimeGraph compile
    const publishResp = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect([200, 201]).toContain(publishResp.status)
    const published = await publishResp.json() as {
      runtimeGraph: { nodes: Array<{ key: string; config: Record<string, unknown> }> }
    }
    // The compile must PRESERVE the form_field_user assignee source (not drop/mangle it)
    const approvalNode = published.runtimeGraph.nodes.find((n) => n.key === 'approval_1')
    expect(approvalNode?.config?.assigneeSources).toEqual([{ kind: 'form_field_user', fieldId: 'reviewer' }])

    // 4. START via POST /api/approvals (the backend the /approvals/new/:id UI calls), submitting
    //    the reviewer field — the form_field_user source must resolve to THAT value.
    const startResp = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId: template.id, formData: { amount: 1200, reviewer: 'uat-approver-42' } },
    })
    expect(startResp.status).toBe(201)
    const approval = await startResp.json() as {
      id: string
      status: string
      currentNodeKey: string | null
      assignments: Array<{ assigneeId: string; isActive: boolean; nodeKey?: string | null }>
    }
    createdApprovalIds.add(approval.id)

    // 5. ASSERT the approver resolved from the form field
    expect(approval.status).toBe('pending')
    expect(approval.currentNodeKey).toBe('approval_1')
    const activeAssignees = approval.assignments.filter((a) => a.isActive).map((a) => a.assigneeId)
    expect(activeAssignees).toEqual(['uat-approver-42'])
  })
})
