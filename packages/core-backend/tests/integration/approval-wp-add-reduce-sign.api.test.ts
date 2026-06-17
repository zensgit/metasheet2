import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// Real-DB spec: runs only with a Postgres DATABASE_URL (DB-backed CI step in
// plugin-tests.yml + local); excluded from the no-DB default test job, skipped here.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// P1-B 加签/减签 (add_sign / reduce_sign) — real-PG integration. The
// wire-vs-fixture invariant (MEMORY: skip-when-unreachable blind spot) requires
// asserting `approval_assignments.is_active` flips and the live-count derived
// 会签 completion against Postgres, not against hand-built fixtures.

type JsonRecord = Record<string, unknown>

type AssignmentDTO = {
  id: string
  type: string
  assigneeId: string
  nodeKey?: string | null
  isActive: boolean
  metadata: JsonRecord
}

type ApprovalDTO = {
  id: string
  status: string
  currentNodeKey: string | null
  assignments: AssignmentDTO[]
}

type ApprovalRecordRow = {
  action: string
  actor_id: string | null
  to_status: string
  to_version: number
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

function buildFormSchema() {
  return {
    fields: [{ id: 'reason', type: 'text', label: '事由', required: true }],
  }
}

function buildAllModeGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_all',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: ['manager-1', 'manager-2'], approvalMode: 'all' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-all', source: 'start', target: 'approval_all' },
      { key: 'edge-all-end', source: 'approval_all', target: 'end' },
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
        config: { assigneeType: 'user', assigneeIds: ['manager-1', 'manager-2'], approvalMode: 'any' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-any', source: 'start', target: 'approval_any' },
      { key: 'edge-any-end', source: 'approval_any', target: 'end' },
    ],
  }
}

function buildParallelGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'parallel_fork',
        type: 'parallel',
        config: { branches: ['edge-fork-a', 'edge-fork-b'], joinMode: 'all', joinNodeKey: 'finance-review' },
      },
      { key: 'legal-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['legal-1'] } },
      { key: 'compliance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['compliance-1'] } },
      { key: 'finance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['finance-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
      { key: 'edge-fork-a', source: 'parallel_fork', target: 'legal-review' },
      { key: 'edge-fork-b', source: 'parallel_fork', target: 'compliance-review' },
      { key: 'edge-a-join', source: 'legal-review', target: 'finance-review' },
      { key: 'edge-b-join', source: 'compliance-review', target: 'finance-review' },
      { key: 'edge-finance-end', source: 'finance-review', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval P1-B add_sign / reduce_sign API', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()

  async function publishTemplate(adminToken: string, key: string, name: string, graph: unknown): Promise<string> {
    const templateResponse = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: { key, name, description: name, formSchema: buildFormSchema(), approvalGraph: graph },
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

  async function startApproval(requesterToken: string, templateId: string): Promise<ApprovalDTO> {
    const createResponse = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'add/reduce sign request' } },
    })
    expect(createResponse.status).toBe(201)
    const approval = await createResponse.json() as ApprovalDTO
    createdApprovalIds.add(approval.id)
    return approval
  }

  function activeAssignees(approval: ApprovalDTO, nodeKey: string): string[] {
    return approval.assignments
      .filter((a) => a.isActive && a.nodeKey === nodeKey)
      .map((a) => a.assigneeId)
      .sort()
  }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
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
      // ignore cleanup failures
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // (1) 会签 add_sign extends — live-count derivation auto-extends the node.
  it('会签: add_sign inserts an active co-signer and the node only completes after all three approve', async () => {
    const adminToken = await authToken(baseUrl, 'admin-as-all')
    const requesterToken = await authToken(baseUrl, 'requester-as-all')
    const m1 = await authToken(baseUrl, 'manager-1')
    const m2 = await authToken(baseUrl, 'manager-2')
    const m9 = await authToken(baseUrl, 'manager-9')
    const templateId = await publishTemplate(adminToken, `as-all-${Date.now()}`, 'AddSign All', buildAllModeGraph())
    const approval = await startApproval(requesterToken, templateId)
    expect(approval.currentNodeKey).toBe('approval_all')
    const pool = poolManager.get()
    const startVersion = (await pool.query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`, [approval.id])).rows[0]!.version

    // manager-1 加签 manager-9 (parallel).
    const addResponse = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST',
      body: { action: 'add_sign', targetUserIds: ['manager-9'], addSignMode: 'parallel', comment: '需要补充审批' },
    })
    expect(addResponse.status).toBe(200)
    const afterAdd = await addResponse.json() as ApprovalDTO
    expect(activeAssignees(afterAdd, 'approval_all')).toEqual(['manager-1', 'manager-2', 'manager-9'])
    // INV-5: version bumped on add_sign (unlike transfer). Asserted against PG
    // (the DTO does not surface `version`).
    const addedVersion = (await pool.query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`, [approval.id])).rows[0]!.version
    expect(addedVersion).toBeGreaterThan(startVersion)

    // The new row is stamped addSign:true.
    const addedRow = afterAdd.assignments.find((a) => a.assigneeId === 'manager-9' && a.isActive)
    expect(addedRow?.metadata.addSign).toBe(true)
    expect(addedRow?.metadata.addedBy).toBe('manager-1')

    // First two original assignees approve → still pending (3rd outstanding).
    for (const token of [m1, m2]) {
      const r = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, token, {
        method: 'POST',
        body: { action: 'approve' },
      })
      expect(r.status).toBe(200)
    }
    const midState = await (await jsonRequest(baseUrl, `/api/approvals/${approval.id}`, requesterToken)).json() as ApprovalDTO
    expect(midState.status).toBe('pending')
    expect(midState.currentNodeKey).toBe('approval_all')
    expect(activeAssignees(midState, 'approval_all')).toEqual(['manager-9'])

    // The add-signed approver completes the node.
    const finalResponse = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m9, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(finalResponse.status).toBe(200)
    const finalState = await finalResponse.json() as ApprovalDTO
    expect(finalState.status).toBe('approved')
    expect(finalState.currentNodeKey).toBeNull()

    // Assert the is_active flips against PG directly (wire-vs-fixture).
    const pgRows = await pool.query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 ORDER BY assignee_id`,
      [approval.id],
    )
    expect(pgRows.rows.every((r) => r.is_active === false)).toBe(true)

    // Audit: exactly one add_sign record with precise metadata.
    const addRecords = await pool.query<ApprovalRecordRow>(
      `SELECT action, actor_id, to_status, to_version, metadata FROM approval_records WHERE instance_id = $1 AND action = 'add_sign'`,
      [approval.id],
    )
    expect(addRecords.rows).toHaveLength(1)
    expect(addRecords.rows[0]?.metadata).toMatchObject({
      nodeKey: 'approval_all',
      addSignMode: 'parallel',
      addedUserIds: ['manager-9'],
    })
  })

  // (2) 或签 add_sign — any-of-now-3 can win.
  it('或签: an add-signed approver can win the node first-wins', async () => {
    const adminToken = await authToken(baseUrl, 'admin-as-any')
    const requesterToken = await authToken(baseUrl, 'requester-as-any')
    const m1 = await authToken(baseUrl, 'manager-1')
    const m9 = await authToken(baseUrl, 'manager-9')
    const templateId = await publishTemplate(adminToken, `as-any-${Date.now()}`, 'AddSign Any', buildAnyModeGraph())
    const approval = await startApproval(requesterToken, templateId)
    expect(approval.currentNodeKey).toBe('approval_any')

    const addResponse = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST',
      body: { action: 'add_sign', targetUserIds: ['manager-9'] },
    })
    expect(addResponse.status).toBe(200)
    const afterAdd = await addResponse.json() as ApprovalDTO
    expect(activeAssignees(afterAdd, 'approval_any')).toEqual(['manager-1', 'manager-2', 'manager-9'])

    // The add-signed approver wins immediately (或签 first-wins).
    const winResponse = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m9, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(winResponse.status).toBe(200)
    const won = await winResponse.json() as ApprovalDTO
    expect(won.status).toBe('approved')
    expect(won.assignments.filter((a) => a.isActive)).toHaveLength(0)
  })

  // (3) reduce_sign happy path + (4) non-add-signed 409 + (5) last-assignee 409.
  it('减签: removes only an add-signed row, refuses requester-original and last-assignee', async () => {
    const adminToken = await authToken(baseUrl, 'admin-rs')
    const requesterToken = await authToken(baseUrl, 'requester-rs')
    const m1 = await authToken(baseUrl, 'manager-1')
    const m2 = await authToken(baseUrl, 'manager-2')
    const templateId = await publishTemplate(adminToken, `rs-${Date.now()}`, 'ReduceSign', buildAllModeGraph())
    const approval = await startApproval(requesterToken, templateId)

    // add_sign manager-9.
    const addResponse = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST',
      body: { action: 'add_sign', targetUserIds: ['manager-9'] },
    })
    expect(addResponse.status).toBe(200)

    // (4) reduce a requester-original assignee → 409 NOT_ADD_SIGNED.
    const reduceOriginal = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST',
      body: { action: 'reduce_sign', targetAssignmentUserId: 'manager-2' },
    })
    expect(reduceOriginal.status).toBe(409)
    expect((await reduceOriginal.json() as { error: { code: string } }).error.code).toBe('APPROVAL_ASSIGNMENT_NOT_ADD_SIGNED')

    // (3) reduce the add-signed manager-9 → is_active flips FALSE.
    const reduceAdded = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST',
      body: { action: 'reduce_sign', targetAssignmentUserId: 'manager-9' },
    })
    expect(reduceAdded.status).toBe(200)
    const afterReduce = await reduceAdded.json() as ApprovalDTO
    expect(activeAssignees(afterReduce, 'approval_all')).toEqual(['manager-1', 'manager-2'])

    const pool = poolManager.get()
    const m9Row = await pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM approval_assignments WHERE instance_id = $1 AND assignee_id = 'manager-9'`,
      [approval.id],
    )
    expect(m9Row.rows.every((r) => r.is_active === false)).toBe(true)

    // reduce_sign audit row present with exact metadata.
    const reduceRecords = await pool.query<ApprovalRecordRow>(
      `SELECT action, metadata FROM approval_records WHERE instance_id = $1 AND action = 'reduce_sign'`,
      [approval.id],
    )
    expect(reduceRecords.rows).toHaveLength(1)
    expect(reduceRecords.rows[0]?.metadata).toMatchObject({ nodeKey: 'approval_all', removedUserId: 'manager-9' })

    // Node still completes from the two remaining (live count shrank).
    expect((await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, { method: 'POST', body: { action: 'approve' } })).status).toBe(200)
    const last = await (await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m2, { method: 'POST', body: { action: 'approve' } })).json() as ApprovalDTO
    expect(last.status).toBe('approved')
  })

  // (5) reduce the LAST add-signed approver when it is the only active row → 409.
  it('减签: refuses removing the last active approver at a node', async () => {
    const adminToken = await authToken(baseUrl, 'admin-rs-last')
    const requesterToken = await authToken(baseUrl, 'requester-rs-last')
    // Single-assignee node — manager-1 add_signs manager-9, then approves itself
    // away, leaving manager-9 as the only active row. Reducing it must 409.
    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_all', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'], approvalMode: 'all' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-all', source: 'start', target: 'approval_all' },
        { key: 'edge-all-end', source: 'approval_all', target: 'end' },
      ],
    }
    const m1 = await authToken(baseUrl, 'manager-1')
    const m9 = await authToken(baseUrl, 'manager-9')
    const templateId = await publishTemplate(adminToken, `rs-last-${Date.now()}`, 'ReduceLast', graph)
    const approval = await startApproval(requesterToken, templateId)

    expect((await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST', body: { action: 'add_sign', targetUserIds: ['manager-9'] },
    })).status).toBe(200)
    // manager-1 approves → only manager-9 (add-signed) remains active.
    expect((await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST', body: { action: 'approve' },
    })).status).toBe(200)

    const reduceLast = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m9, {
      method: 'POST', body: { action: 'reduce_sign', targetAssignmentUserId: 'manager-9' },
    })
    expect(reduceLast.status).toBe(409)
    expect((await reduceLast.json() as { error: { code: string } }).error.code).toBe('APPROVAL_REDUCE_LAST_ASSIGNEE')
  })

  // (6) non-assignee add_sign → 403 (actorCanAct gate).
  it('non-assignee add_sign is rejected with 403', async () => {
    const adminToken = await authToken(baseUrl, 'admin-403')
    const requesterToken = await authToken(baseUrl, 'requester-403')
    const stranger = await authToken(baseUrl, 'stranger-1')
    const templateId = await publishTemplate(adminToken, `as-403-${Date.now()}`, 'AddSign403', buildAllModeGraph())
    const approval = await startApproval(requesterToken, templateId)
    const r = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, stranger, {
      method: 'POST', body: { action: 'add_sign', targetUserIds: ['manager-9'] },
    })
    expect(r.status).toBe(403)
    expect((await r.json() as { error: { code: string } }).error.code).toBe('APPROVAL_ASSIGNMENT_REQUIRED')
  })

  // (7) parallel region: before-mode 409, parallel-mode scoped to the branch.
  it('parallel region: before-mode add_sign is 409, parallel-mode is scoped to the branch node', async () => {
    const adminToken = await authToken(baseUrl, 'admin-par')
    const requesterToken = await authToken(baseUrl, 'requester-par')
    const legal = await authToken(baseUrl, 'legal-1')
    const templateId = await publishTemplate(adminToken, `as-par-${Date.now()}`, 'AddSignParallel', buildParallelGraph())
    const approval = await startApproval(requesterToken, templateId)

    // before-mode inside a parallel region → 409.
    const before = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, legal, {
      method: 'POST', body: { action: 'add_sign', targetUserIds: ['legal-9'], addSignMode: 'before' },
    })
    expect(before.status).toBe(409)
    expect((await before.json() as { error: { code: string } }).error.code).toBe('APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED')

    // parallel-mode is allowed and scoped to the actor's branch node.
    const parallel = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, legal, {
      method: 'POST', body: { action: 'add_sign', targetUserIds: ['legal-9'], addSignMode: 'parallel' },
    })
    expect(parallel.status).toBe(200)
    const after = await parallel.json() as ApprovalDTO
    const added = after.assignments.find((a) => a.assigneeId === 'legal-9' && a.isActive)
    expect(added?.nodeKey).toBe('legal-review')
    expect(added?.metadata.addSign).toBe(true)
  })

  // (8) empty targetUserIds → 400; (route) unknown action → 400.
  it('validation: empty targetUserIds is 400 and an unknown action is 400 at the route', async () => {
    const adminToken = await authToken(baseUrl, 'admin-val')
    const requesterToken = await authToken(baseUrl, 'requester-val')
    const m1 = await authToken(baseUrl, 'manager-1')
    const templateId = await publishTemplate(adminToken, `as-val-${Date.now()}`, 'AddSignVal', buildAllModeGraph())
    const approval = await startApproval(requesterToken, templateId)

    const empty = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST', body: { action: 'add_sign', targetUserIds: [] },
    })
    expect(empty.status).toBe(400)
    expect((await empty.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')

    const unknown = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST', body: { action: 'frobnicate' },
    })
    expect(unknown.status).toBe(400)
  })

  // (9) version monotonic + history DTO carries the rows.
  it('audit: add_sign and reduce_sign bump version monotonically and appear in history', async () => {
    const adminToken = await authToken(baseUrl, 'admin-hist')
    const requesterToken = await authToken(baseUrl, 'requester-hist')
    const m1 = await authToken(baseUrl, 'manager-1')
    const templateId = await publishTemplate(adminToken, `as-hist-${Date.now()}`, 'AddSignHist', buildAllModeGraph())
    const approval = await startApproval(requesterToken, templateId)

    const pool = poolManager.get()
    const readVersion = async (): Promise<number> => (await pool.query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`, [approval.id])).rows[0]!.version

    const v0 = await readVersion()
    expect((await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST', body: { action: 'add_sign', targetUserIds: ['manager-9'] },
    })).status).toBe(200)
    const v1 = await readVersion()
    expect((await jsonRequest(baseUrl, `/api/approvals/${approval.id}/actions`, m1, {
      method: 'POST', body: { action: 'reduce_sign', targetAssignmentUserId: 'manager-9' },
    })).status).toBe(200)
    const v2 = await readVersion()
    // INV-5: monotonic version bump on both actions (asserted against PG).
    expect(v1).toBeGreaterThan(v0)
    expect(v2).toBeGreaterThan(v1)

    const records = await pool.query<ApprovalRecordRow>(
      `SELECT action, to_version FROM approval_records WHERE instance_id = $1 AND action IN ('add_sign','reduce_sign') ORDER BY to_version ASC`,
      [approval.id],
    )
    expect(records.rows.map((r) => r.action)).toEqual(['add_sign', 'reduce_sign'])
    expect(records.rows[0]!.to_version).toBe(v1)
    expect(records.rows[1]!.to_version).toBe(v2)

    // History DTO surfaces the rows (route returns { ok, data: { items } }).
    const historyResponse = await jsonRequest(baseUrl, `/api/approvals/${approval.id}/history`, requesterToken)
    expect(historyResponse.status).toBe(200)
    const history = await historyResponse.json() as { data: { items: Array<{ action: string }> } }
    const actions = history.data.items.map((h) => h.action)
    expect(actions).toContain('add_sign')
    expect(actions).toContain('reduce_sign')
  })
})
