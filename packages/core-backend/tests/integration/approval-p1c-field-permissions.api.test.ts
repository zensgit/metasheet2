import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

// Real-DB spec: runs only with a Postgres DATABASE_URL (DB-backed CI step in
// plugin-tests.yml + local); excluded from the no-DB default test job, skipped here.
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
  await grantApprovalWriteForIntegrationActor(userId)
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
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

// Two-field form. `secret` is hidden at approval_1 (and via visibilityRule for the
// orthogonality node); `reason` is always visible. `attendanceRequestId`-style
// non-hidden keys (here `reason`) prove list rows keep their non-hidden fields.
function buildFormSchema() {
  return {
    fields: [
      { id: 'reason', type: 'text', label: '事由', required: true },
      { id: 'secret', type: 'text', label: '机密' },
    ],
  }
}

// approval_1 hides `secret`; approval_2 hides nothing → after advancing past
// approval_1, `secret` reappears.
function buildHidingGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['p1c-manager-1'],
          fieldPermissions: [{ fieldId: 'secret', access: 'hidden' }],
        },
      },
      {
        key: 'approval_2',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['p1c-manager-2'] },
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

// Legacy graph carrying no fieldPermissions — proves default-absent === unchanged.
function buildLegacyGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['p1c-manager-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-1', source: 'start', target: 'approval_1' },
      { key: 'edge-1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

// Orthogonality: `secret` is hidden by node-permission AND by a visibilityRule
// that would otherwise SHOW it; `extra` is hidden only by visibilityRule.
function buildOrthogonalSchema() {
  return {
    fields: [
      { id: 'reason', type: 'text', label: '事由', required: true },
      { id: 'secret', type: 'text', label: '机密', visibilityRule: { fieldId: 'reason', operator: 'notEmpty' } },
    ],
  }
}

function buildOrthogonalGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_1',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: ['p1c-manager-1'],
          fieldPermissions: [{ fieldId: 'secret', access: 'hidden' }],
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-1', source: 'start', target: 'approval_1' },
      { key: 'edge-1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

async function authorPublishStart(
  baseUrl: string,
  adminToken: string,
  requesterToken: string,
  templateKey: string,
  formSchema: JsonRecord,
  approvalGraph: JsonRecord,
  formData: JsonRecord,
  bookkeeping: { templates: Set<string>; approvals: Set<string> },
): Promise<{ id: string; currentNodeKey: string | null }> {
  const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
    method: 'POST',
    body: { key: templateKey, name: templateKey, formSchema, approvalGraph },
  })
  expect(templateResponse.status).toBe(201)
  const template = await templateResponse.json() as { id: string }
  bookkeeping.templates.add(template.id)

  const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
    method: 'POST',
    body: { policy: { allowRevoke: true } },
  })
  expect(publishResponse.status).toBe(200)

  const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
    method: 'POST',
    body: { templateId: template.id, formData },
  })
  expect(createResponse.status).toBe(201)
  const created = await createResponse.json() as { id: string; currentNodeKey: string | null }
  bookkeeping.approvals.add(created.id)
  return created
}

describeIfDatabase('Approval P1-C node field permissions (hidden subset) API', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const bookkeeping = { templates: new Set<string>(), approvals: new Set<string>() }

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
      const approvalIds = [...bookkeeping.approvals]
      const templateIds = [...bookkeeping.templates]
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

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('redacts a hidden field for every viewer while AT the hiding node, on detail AND list, and restores it after advancing', async () => {
    const adminToken = await authToken(baseUrl, 'p1c-admin')
    const requesterToken = await authToken(baseUrl, 'p1c-requester')
    const manager1Token = await authToken(baseUrl, 'p1c-manager-1')
    const observerToken = await authToken(baseUrl, 'p1c-observer')

    const created = await authorPublishStart(
      baseUrl,
      adminToken,
      requesterToken,
      `p1c-hidden-${Date.now()}`,
      buildFormSchema(),
      buildHidingGraph(),
      { reason: 'trip', secret: 'classified' },
      bookkeeping,
    )
    expect(created.currentNodeKey).toBe('approval_1')

    // DETAIL: while AT approval_1 the hidden field is absent for active approver,
    // requester, AND an observer/admin with no assignment — but `reason` stays.
    for (const token of [manager1Token, requesterToken, observerToken, adminToken]) {
      const detail = await jsonRequest(baseUrl, `/api/approvals/${created.id}`, token)
      expect(detail.status).toBe(200)
      const body = await detail.json() as { formSnapshot: JsonRecord | null }
      expect(body.formSnapshot).not.toHaveProperty('secret')
      expect(body.formSnapshot).toHaveProperty('reason', 'trip')
    }

    // LIST: same redaction keyed on instance-active node; non-hidden field kept.
    // Query the active approver's pending queue (manager-1 is the active assignee
    // at approval_1) — the list row's formSnapshot must be redacted identically.
    const listAtHiding = await jsonRequest(baseUrl, '/api/approvals?sourceSystem=all&tab=pending&limit=200', manager1Token)
    expect(listAtHiding.status).toBe(200)
    const listBody = await listAtHiding.json() as { data: Array<{ id: string; formSnapshot: JsonRecord | null }> }
    const listRow = listBody.data.find((row) => row.id === created.id)
    expect(listRow).toBeTruthy()
    expect(listRow?.formSnapshot).not.toHaveProperty('secret')
    expect(listRow?.formSnapshot).toHaveProperty('reason', 'trip')

    // The DB form_snapshot is intact (redaction is echo-only, not a write).
    const pool = poolManager.get()
    const stored = await pool.query<{ form_snapshot: JsonRecord }>(
      'SELECT form_snapshot FROM approval_instances WHERE id = $1',
      [created.id],
    )
    expect(stored.rows[0]?.form_snapshot).toMatchObject({ reason: 'trip', secret: 'classified' })

    // Advance past approval_1 to approval_2 (which hides nothing) → secret returns.
    const approveResponse = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, manager1Token, {
      method: 'POST',
      body: { action: 'approve', comment: 'm1 ok' },
    })
    expect(approveResponse.status).toBe(200)
    const advanced = await approveResponse.json() as { currentNodeKey: string | null }
    expect(advanced.currentNodeKey).toBe('approval_2')

    const detailAfter = await jsonRequest(baseUrl, `/api/approvals/${created.id}`, requesterToken)
    const detailAfterBody = await detailAfter.json() as { formSnapshot: JsonRecord | null }
    expect(detailAfterBody.formSnapshot).toHaveProperty('secret', 'classified')
    expect(detailAfterBody.formSnapshot).toHaveProperty('reason', 'trip')

    // History/timeline rows are not altered by redaction (assert directly on the
    // records table — redaction is a read-time echo transform, never a write).
    const records = await pool.query<{ action: string }>(
      'SELECT action FROM approval_records WHERE instance_id = $1 ORDER BY id ASC',
      [created.id],
    )
    expect(records.rows.length).toBeGreaterThan(0)
    expect(records.rows.some((row) => row.action === 'approve')).toBe(true)
  })

  it('leaves a legacy instance with no fieldPermissions unchanged', async () => {
    const adminToken = await authToken(baseUrl, 'p1c-admin')
    const requesterToken = await authToken(baseUrl, 'p1c-requester')

    const created = await authorPublishStart(
      baseUrl,
      adminToken,
      requesterToken,
      `p1c-legacy-${Date.now()}`,
      buildFormSchema(),
      buildLegacyGraph(),
      { reason: 'legacy', secret: 'still-here' },
      bookkeeping,
    )

    const detail = await jsonRequest(baseUrl, `/api/approvals/${created.id}`, requesterToken)
    expect(detail.status).toBe(200)
    const body = await detail.json() as { formSnapshot: JsonRecord | null }
    expect(body.formSnapshot).toMatchObject({ reason: 'legacy', secret: 'still-here' })
  })

  it('applies node redaction orthogonally to visibilityRule', async () => {
    const adminToken = await authToken(baseUrl, 'p1c-admin')
    const requesterToken = await authToken(baseUrl, 'p1c-requester')

    const created = await authorPublishStart(
      baseUrl,
      adminToken,
      requesterToken,
      `p1c-ortho-${Date.now()}`,
      buildOrthogonalSchema(),
      buildOrthogonalGraph(),
      // reason is non-empty → visibilityRule for `secret` would SHOW it; node
      // permission still hides it. Proves the two axes are independent.
      { reason: 'present', secret: 'double-guarded' },
      bookkeeping,
    )

    const detail = await jsonRequest(baseUrl, `/api/approvals/${created.id}`, requesterToken)
    expect(detail.status).toBe(200)
    const body = await detail.json() as { formSnapshot: JsonRecord | null }
    expect(body.formSnapshot).not.toHaveProperty('secret')
    expect(body.formSnapshot).toHaveProperty('reason', 'present')
  })

  // T1-4 §4 build contract — echo-ONLY redaction. These lock behavior that #2799 already ships
  // correctly (no RED-before): a hidden field that ALSO drives routing must still route, and a
  // `readonly` entry must persist + round-trip while producing NO runtime redaction.

  it('resolves a form_field_user assignee from a hidden driver field while redacting it from the echo (routing unaffected)', async () => {
    const adminToken = await authToken(baseUrl, 'p1c-admin')
    const requesterToken = await authToken(baseUrl, 'p1c-requester')

    const formSchema = {
      fields: [
        { id: 'reason', type: 'text', label: '事由', required: true },
        { id: 'approver', type: 'user', label: '审批人' },
      ],
    }
    // approval_1 resolves its approver FROM `approver` AND hides `approver`. The assignee is resolved
    // at create from the STORED snapshot; the echo redaction is read-time only.
    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: {
            assigneeSources: [{ kind: 'form_field_user', fieldId: 'approver' }],
            fieldPermissions: [{ fieldId: 'approver', access: 'hidden' }],
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-1', source: 'start', target: 'approval_1' },
        { key: 'edge-1-end', source: 'approval_1', target: 'end' },
      ],
    }

    const created = await authorPublishStart(
      baseUrl,
      adminToken,
      requesterToken,
      `p1c-driver-${Date.now()}`,
      formSchema,
      graph,
      { reason: 'trip', approver: 'p1c-manager-driven' },
      bookkeeping,
    )
    expect(created.currentNodeKey).toBe('approval_1')

    const detail = await jsonRequest(baseUrl, `/api/approvals/${created.id}`, requesterToken)
    expect(detail.status).toBe(200)
    const body = await detail.json() as {
      formSnapshot: JsonRecord | null
      assignments: Array<{ assigneeId: string; isActive: boolean }>
    }
    // Echo hides the routing driver...
    expect(body.formSnapshot).not.toHaveProperty('approver')
    expect(body.formSnapshot).toHaveProperty('reason', 'trip')
    // ...but the assignee was resolved from its stored value (routing unaffected).
    expect(body.assignments.some((assignment) => assignment.assigneeId === 'p1c-manager-driven' && assignment.isActive)).toBe(true)
  })

  it('routes a downstream condition on a hidden driver field unchanged while redacting it at the hiding node', async () => {
    const adminToken = await authToken(baseUrl, 'p1c-admin')
    const requesterToken = await authToken(baseUrl, 'p1c-requester')
    const manager1Token = await authToken(baseUrl, 'p1c-manager-1')

    const formSchema = {
      fields: [
        { id: 'reason', type: 'text', label: '事由', required: true },
        { id: 'amount', type: 'text', label: '金额' },
      ],
    }
    // approval_1 hides `amount`; the DOWNSTREAM condition routes on `amount`. Approving approval_1
    // dispatches to the condition, which reads the STORED (un-redacted) `amount` → the `high` branch.
    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['p1c-manager-1'], fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }] },
        },
        {
          key: 'cond_1',
          type: 'condition',
          config: { branches: [{ edgeKey: 'to-high', rules: [{ fieldId: 'amount', operator: 'eq', value: 'big' }] }], defaultEdgeKey: 'to-low' },
        },
        { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['p1c-high'] } },
        { key: 'approval_low', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['p1c-low'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-1', source: 'start', target: 'approval_1' },
        { key: 'edge-1-c', source: 'approval_1', target: 'cond_1' },
        { key: 'to-high', source: 'cond_1', target: 'approval_high' },
        { key: 'to-low', source: 'cond_1', target: 'approval_low' },
        { key: 'edge-high-end', source: 'approval_high', target: 'end' },
        { key: 'edge-low-end', source: 'approval_low', target: 'end' },
      ],
    }

    const created = await authorPublishStart(
      baseUrl,
      adminToken,
      requesterToken,
      `p1c-cond-${Date.now()}`,
      formSchema,
      graph,
      { reason: 'trip', amount: 'big' },
      bookkeeping,
    )
    expect(created.currentNodeKey).toBe('approval_1')

    // While AT approval_1, `amount` is redacted from the echo...
    const detail = await jsonRequest(baseUrl, `/api/approvals/${created.id}`, requesterToken)
    const body = await detail.json() as { formSnapshot: JsonRecord | null }
    expect(body.formSnapshot).not.toHaveProperty('amount')
    expect(body.formSnapshot).toHaveProperty('reason', 'trip')

    // ...and approving approval_1 routes the condition on the STORED `amount` → the high branch.
    const approve = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, manager1Token, {
      method: 'POST',
      body: { action: 'approve', comment: 'ok' },
    })
    expect(approve.status).toBe(200)
    const advanced = await approve.json() as { currentNodeKey: string | null }
    expect(advanced.currentNodeKey).toBe('approval_high')
  })

  it('persists a readonly fieldPermission that round-trips through save/load and stays runtime-inert (still echoed)', async () => {
    const adminToken = await authToken(baseUrl, 'p1c-admin')
    const requesterToken = await authToken(baseUrl, 'p1c-requester')

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['p1c-manager-1'], fieldPermissions: [{ fieldId: 'secret', access: 'readonly' }] },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-1', source: 'start', target: 'approval_1' },
        { key: 'edge-1-end', source: 'approval_1', target: 'end' },
      ],
    }

    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: { key: `p1c-ro-${Date.now()}`, name: 'p1c-readonly', formSchema: buildFormSchema(), approvalGraph: graph },
    })
    expect(templateResponse.status).toBe(201)
    const template = await templateResponse.json() as { id: string }
    bookkeeping.templates.add(template.id)

    // Round-trip: GET the saved template → the readonly fieldPermission survived normalize/save/load.
    const getTemplate = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}`, adminToken)
    expect(getTemplate.status).toBe(200)
    const templateDetail = await getTemplate.json() as {
      approvalGraph: { nodes: Array<{ key: string; config: { fieldPermissions?: Array<{ fieldId: string; access: string }> } }> }
    }
    const savedNode = templateDetail.approvalGraph.nodes.find((node) => node.key === 'approval_1')
    expect(savedNode?.config.fieldPermissions).toEqual([{ fieldId: 'secret', access: 'readonly' }])

    // Runtime-inert: publish + create → `secret` is STILL echoed (readonly is not redacted).
    const publish = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publish.status).toBe(200)
    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId: template.id, formData: { reason: 'trip', secret: 'shown' } },
    })
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json() as { id: string }
    bookkeeping.approvals.add(created.id)

    const detail = await jsonRequest(baseUrl, `/api/approvals/${created.id}`, requesterToken)
    const body = await detail.json() as { formSnapshot: JsonRecord | null }
    expect(body.formSnapshot).toHaveProperty('secret', 'shown')
    expect(body.formSnapshot).toHaveProperty('reason', 'trip')
  })
})
