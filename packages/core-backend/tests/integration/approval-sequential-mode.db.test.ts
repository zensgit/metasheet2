import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { fetch as undiciFetch } from 'undici'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// TOP-LEVEL: the dedicated real-DB lane sets EXPECT_DB=1, so a missing DATABASE_URL must fail
// instead of skipping the describeIfDatabase suite and reporting a false green.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

type JsonRecord = Record<string, unknown>

type AssignmentRow = {
  assignee_id: string
  is_active: boolean
  entry_epoch: number | null
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
  await grantApprovalWriteForIntegrationActor(userId)
  const response = await undiciFetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  return (await response.json() as { token: string }).token
}

async function request(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
) {
  return await undiciFetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

function formSchema() {
  return { fields: [{ id: 'reason', type: 'text', label: 'Reason', required: true }] }
}

function linearGraph(assignees: string[], approvalMode: 'sequential' | 'all', finalAssignee?: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_seq',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: assignees, approvalMode },
      },
      ...(finalAssignee
        ? [{ key: 'approval_final', type: 'approval', config: { assigneeType: 'user', assigneeIds: [finalAssignee], approvalMode: 'single' } }]
        : []),
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-seq', source: 'start', target: 'approval_seq' },
      finalAssignee
        ? { key: 'edge-seq-final', source: 'approval_seq', target: 'approval_final' }
        : { key: 'edge-seq-end', source: 'approval_seq', target: 'end' },
      ...(finalAssignee ? [{ key: 'edge-final-end', source: 'approval_final', target: 'end' }] : []),
    ],
  }
}

describeIfDatabase('Approval Lock-1 K6 sequential mode', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const templateIds = new Set<string>()
  const approvalIds = new Set<string>()
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const admin = `k6-admin-${suffix}`
  const requester = `k6-requester-${suffix}`
  const approvers = ['a', 'b', 'c'].map((name) => `k6-${name}-${suffix}`)
  const finalApprover = `k6-final-${suffix}`

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address!.port}`
  })

  afterAll(async () => {
    const pool = poolManager.get()
    const ids = [...approvalIds]
    const templates = [...templateIds]
    if (ids.length > 0) {
      await pool.query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [ids])
      await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [ids])
      await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [ids])
    }
    if (templates.length > 0) {
      await pool.query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templates])
      await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templates])
      await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templates])
    }
    await server?.stop()
  })

  async function publish(
    graph: object,
    label: string,
    policy: object = { allowRevoke: true },
  ): Promise<string> {
    const token = await authToken(baseUrl, admin)
    const created = await request(baseUrl, '/api/approval-templates', token, {
      method: 'POST',
      body: {
        key: `k6-${label}-${suffix}`,
        name: `K6 ${label}`,
        formSchema: formSchema(),
        approvalGraph: graph,
      },
    })
    expect(created.status).toBe(201)
    const templateId = (await created.json() as { id: string }).id
    templateIds.add(templateId)
    const published = await request(baseUrl, `/api/approval-templates/${templateId}/publish`, token, {
      method: 'POST',
      body: { policy },
    })
    expect(published.status).toBe(200)
    return templateId
  }

  async function create(templateId: string): Promise<string> {
    const token = await authToken(baseUrl, requester)
    const response = await request(baseUrl, '/api/approvals', token, {
      method: 'POST',
      body: { templateId, formData: { reason: 'K6' } },
    })
    expect(response.status).toBe(201)
    const id = (await response.json() as { id: string }).id
    approvalIds.add(id)
    return id
  }

  async function act(instanceId: string, userId: string, body: object) {
    const token = await authToken(baseUrl, userId)
    return await request(baseUrl, `/api/approvals/${instanceId}/actions`, token, { method: 'POST', body })
  }

  async function sequentialRows(instanceId: string): Promise<AssignmentRow[]> {
    const result = await poolManager.get().query<AssignmentRow>(
      `SELECT assignee_id, is_active, entry_epoch, metadata
         FROM approval_assignments
        WHERE instance_id = $1 AND node_key = 'approval_seq'
        ORDER BY entry_epoch ASC, created_at ASC`,
      [instanceId],
    )
    return result.rows
  }

  it('activates one head, advances in order, and restarts at position 1 on a fresh re-entry epoch (G-15)', async () => {
    const templateId = await publish(linearGraph(approvers, 'sequential', finalApprover), 'sequential')
    const instanceId = await create(templateId)

    const initial = await sequentialRows(instanceId)
    expect(initial.map((row) => ({ id: row.assignee_id, active: row.is_active, queue: row.metadata.sequentialQueue }))).toEqual([
      { id: approvers[0], active: true, queue: { position: 1, length: 3, state: 'active' } },
      { id: approvers[1], active: false, queue: { position: 2, length: 3, state: 'queued' } },
      { id: approvers[2], active: false, queue: { position: 3, length: 3, state: 'queued' } },
    ])

    const outOfTurn = await act(instanceId, approvers[1], { action: 'approve' })
    expect(outOfTurn.status).toBe(403)

    const addSign = await act(instanceId, approvers[0], {
      action: 'add_sign',
      targetUserIds: [`k6-extra-${suffix}`],
      addSignMode: 'parallel',
    })
    expect(addSign.status).toBe(409)
    expect((await addSign.json() as { error?: { code?: string } }).error?.code).toBe('APPROVAL_NODE_OPERATION_DISABLED')

    for (let index = 0; index < approvers.length; index += 1) {
      const response = await act(instanceId, approvers[index], { action: 'approve', comment: `step-${index + 1}` })
      expect(response.status).toBe(200)
      const active = (await sequentialRows(instanceId)).filter((row) => row.is_active)
      if (index < approvers.length - 1) {
        expect(active.map((row) => row.assignee_id)).toEqual([approvers[index + 1]])
      } else {
        expect(active).toHaveLength(0)
      }
    }

    const returned = await act(instanceId, finalApprover, {
      action: 'return',
      targetNodeKey: 'approval_seq',
      comment: 'restart',
    })
    expect(returned.status).toBe(200)
    const afterReturn = await sequentialRows(instanceId)
    const epochs = [...new Set(afterReturn.map((row) => row.entry_epoch))]
    expect(epochs).toHaveLength(2)
    const latestEpoch = Math.max(...epochs.map((epoch) => epoch ?? -1))
    const latest = afterReturn.filter((row) => row.entry_epoch === latestEpoch)
    expect(latest.map((row) => ({ id: row.assignee_id, active: row.is_active, queue: row.metadata.sequentialQueue }))).toEqual([
      { id: approvers[0], active: true, queue: { position: 1, length: 3, state: 'active' } },
      { id: approvers[1], active: false, queue: { position: 2, length: 3, state: 'queued' } },
      { id: approvers[2], active: false, queue: { position: 3, length: 3, state: 'queued' } },
    ])

    const rejected = await act(instanceId, approvers[0], { action: 'reject', comment: 'stop' })
    expect(rejected.status).toBe(200)
    expect((await rejected.json() as { status: string }).status).toBe('rejected')
  })

  it('keeps all-mode as the positive control with every identical assignee active', async () => {
    const templateId = await publish(linearGraph(approvers, 'all'), 'all-control')
    const instanceId = await create(templateId)
    const rows = await sequentialRows(instanceId)
    expect(rows.map((row) => row.assignee_id)).toEqual(approvers)
    expect(rows.every((row) => row.is_active)).toBe(true)
    expect(rows.every((row) => row.metadata.sequentialQueue === undefined)).toBe(true)
  })

  it('fails closed and rolls back the head decision when persisted queue ordering is corrupt', async () => {
    const templateId = await publish(linearGraph(approvers, 'sequential'), 'sequential-corrupt')
    const instanceId = await create(templateId)
    const pool = poolManager.get()
    const before = await pool.query<{ version: number }>(
      'SELECT version FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    await pool.query(
      `UPDATE approval_assignments
          SET metadata = jsonb_set(metadata, '{sequentialQueue,position}', '99'::jsonb, false)
        WHERE instance_id = $1 AND assignee_id = $2`,
      [instanceId, approvers[1]],
    )

    const response = await act(instanceId, approvers[0], { action: 'approve' })
    expect(response.status).toBe(409)
    expect((await response.json() as { error?: { code?: string } }).error?.code).toBe(
      'APPROVAL_SEQUENTIAL_QUEUE_INVALID',
    )

    const after = await pool.query<{ version: number }>(
      'SELECT version FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    expect(after.rows).toEqual(before.rows)
    expect(Object.fromEntries(
      (await sequentialRows(instanceId)).map((row) => [row.assignee_id, row.is_active]),
    )).toEqual({
      [approvers[0]]: true,
      [approvers[1]]: false,
      [approvers[2]]: false,
    })
    const decisions = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM approval_records
        WHERE instance_id = $1 AND action = 'approve'`,
      [instanceId],
    )
    expect(decisions.rows).toEqual([{ count: '0' }])
  })

  it('auto-approves only the sequential head and promotes exactly one manual successor', async () => {
    const graph = linearGraph([requester, approvers[1], approvers[2]], 'sequential')
    const node = graph.nodes.find((candidate) => candidate.key === 'approval_seq')!
    node.config = { ...node.config, autoApprovalPolicy: { mergeWithRequester: true } }
    const templateId = await publish(graph, 'sequential-requester-auto')
    const instanceId = await create(templateId)
    const rows = await sequentialRows(instanceId)
    expect(rows.map((row) => ({ id: row.assignee_id, active: row.is_active, queue: row.metadata.sequentialQueue }))).toEqual([
      { id: approvers[1], active: true, queue: { position: 2, length: 3, state: 'active' } },
      { id: approvers[2], active: false, queue: { position: 3, length: 3, state: 'queued' } },
    ])
    const autoRecords = await poolManager.get().query<{ actor_id: string; metadata: JsonRecord }>(
      `SELECT actor_id, metadata
         FROM approval_records
        WHERE instance_id = $1 AND action = 'approve' AND metadata->>'autoApproved' = 'true'`,
      [instanceId],
    )
    expect(autoRecords.rows).toEqual([
      expect.objectContaining({
        actor_id: 'system:auto-approval',
        metadata: expect.objectContaining({
          nodeKey: 'approval_seq',
          originalApprover: { id: requester, type: 'user' },
        }),
      }),
    ])
  })

  it('leaves a handler frontier pending before applying sequential auto-approval', async () => {
    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'handler_first',
          type: 'handler',
          config: { assigneeSources: [{ kind: 'requester' }], handlerMode: 'all' },
        },
        {
          key: 'approval_seq',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: [requester, approvers[1]],
            approvalMode: 'sequential',
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-handler', source: 'start', target: 'handler_first' },
        { key: 'edge-handler-seq', source: 'handler_first', target: 'approval_seq' },
        { key: 'edge-seq-end', source: 'approval_seq', target: 'end' },
      ],
    }
    const templateId = await publish(
      graph,
      'handler-before-sequential',
      { allowRevoke: true, autoApproval: { mergeWithRequester: true } },
    )
    const instanceId = await create(templateId)
    const initial = await poolManager.get().query<{ current_node_key: string; assignee_id: string }>(
      `SELECT i.current_node_key, a.assignee_id
         FROM approval_instances i
         JOIN approval_assignments a ON a.instance_id = i.id AND a.is_active IS TRUE
        WHERE i.id = $1`,
      [instanceId],
    )
    expect(initial.rows).toEqual([{ current_node_key: 'handler_first', assignee_id: requester }])

    const handled = await act(instanceId, requester, { action: 'handle' })
    expect(handled.status).toBe(200)
    expect((await sequentialRows(instanceId)).map((row) => ({ id: row.assignee_id, active: row.is_active }))).toEqual([
      { id: approvers[1], active: true },
    ])
  })
})
