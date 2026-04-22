import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ApprovalBridgePlmAdapter } from '../../src/services/approval-bridge-types'

type ApprovalFixture = {
  id: string
  request_type: string
  title: string
  requester_id: string
  requester_name: string
  status: 'pending' | 'approved' | 'rejected'
  version?: number
  created_at: string
  updated_at?: string
  product_id?: string
  product_number?: string
  product_name?: string
}

type ApprovalHistoryFixture = {
  id: string
  eco_id?: string
  stage_id?: string
  approval_type?: string
  required_role?: string
  user_id?: string | null
  status?: string
  comment?: string | null
  approved_at?: string | null
  created_at?: string | null
}

type InstanceRow = {
  id: string
  status: string
  version: number
  source_system: string
  external_approval_id: string | null
  workflow_key: string | null
  business_key: string | null
  title: string | null
  requester_snapshot: Record<string, unknown>
  subject_snapshot: Record<string, unknown>
  policy_snapshot: Record<string, unknown>
  metadata: Record<string, unknown>
  current_step: number
  total_steps: number
  source_updated_at: Date | null
  last_synced_at: Date | null
  sync_status: string
  sync_error: string | null
  created_at: Date
  updated_at: Date
}

type AssignmentRow = {
  id: string
  instance_id: string
  assignment_type: string
  assignee_id: string
  source_step: number
  is_active: boolean
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

type ApprovalRecordRow = {
  id: number
  instance_id: string
  action: string
  actor_id: string | null
  actor_name: string | null
  comment: string | null
  reason: string | null
  from_status: string | null
  to_status: string
  from_version: number | null
  to_version: number
  metadata: Record<string, unknown>
  occurred_at: Date
  created_at: Date
}

const routeState = vi.hoisted(() => {
  const plmApprovals: ApprovalFixture[] = [
    {
      id: 'eco-1',
      request_type: 'eco',
      title: 'ECO-1',
      requester_id: 'user-1',
      requester_name: 'Alice',
      status: 'pending',
      version: 7,
      created_at: '2026-04-04T00:00:00.000Z',
      updated_at: '2026-04-04T00:05:00.000Z',
      product_id: 'prod-1',
      product_number: 'PN-1',
      product_name: 'Motor Housing',
    },
  ]

  const plmHistory: ApprovalHistoryFixture[] = [
    {
      id: 'hist-1',
      eco_id: 'eco-1',
      stage_id: 'review',
      approval_type: 'mandatory',
      required_role: 'reviewer',
      user_id: 'reviewer-1',
      status: 'approved',
      comment: 'LGTM',
      approved_at: '2026-04-04T00:10:00.000Z',
      created_at: '2026-04-04T00:09:00.000Z',
    },
  ]

  const state = {
    instances: new Map<string, InstanceRow>(),
    assignments: new Map<string, AssignmentRow>(),
    records: [] as ApprovalRecordRow[],
    recordId: 1,
  }

  const now = () => new Date('2026-04-04T08:00:00.000Z')

  const baseInstance = (overrides: Partial<InstanceRow> = {}): InstanceRow => ({
    id: 'local-1',
    status: 'pending',
    version: 0,
    source_system: 'platform',
    external_approval_id: null,
    workflow_key: null,
    business_key: null,
    title: 'Local approval',
    requester_snapshot: {},
    subject_snapshot: {},
    policy_snapshot: {},
    metadata: {},
    current_step: 0,
    total_steps: 0,
    source_updated_at: null,
    last_synced_at: null,
    sync_status: 'ok',
    sync_error: null,
    created_at: now(),
    updated_at: now(),
    ...overrides,
  })

  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  const parseJson = (value: unknown): Record<string, unknown> => {
    if (!value) return {}
    if (typeof value === 'string') {
      return JSON.parse(value) as Record<string, unknown>
    }
    return value as Record<string, unknown>
  }

  const filterDynamicInstances = (sql: string, params: unknown[]) => {
    let rows = Array.from(state.instances.values())
    let index = 0

    if (sql.includes('source_system = $')) {
      const value = String(params[index++])
      rows = rows.filter((row) => row.source_system === value)
    }
    if (sql.includes('status = $')) {
      const value = String(params[index++])
      rows = rows.filter((row) => row.status === value)
    }
    if (sql.includes('workflow_key = $')) {
      rows = rows.filter((row) => row.workflow_key === String(params[index++]))
    }
    if (sql.includes('business_key = $')) {
      rows = rows.filter((row) => row.business_key === String(params[index++]))
    }
    if (sql.includes('SELECT instance_id FROM approval_assignments')) {
      const assigneeId = String(params[index++])
      const assignedInstanceIds = new Set(
        Array.from(state.assignments.values())
          .filter((row) => row.assignee_id === assigneeId && row.is_active)
          .map((row) => row.instance_id),
      )
      rows = rows.filter((row) => assignedInstanceIds.has(row.id))
    }

    return { rows, index }
  }

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = normalize(sql)

    if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }

    if (normalized.startsWith('SELECT ai.* FROM approval_instances ai WHERE ai.status = \'pending\'')) {
      const limit = Number(params[0])
      const offset = Number(params[1])
      const rows = Array.from(state.instances.values())
        .filter((row) => row.status === 'pending' && row.source_system === 'platform')
        .slice(offset, offset + limit)
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('SELECT COUNT(*)::text AS count FROM approval_instances WHERE status = \'pending\'')) {
      const count = Array.from(state.instances.values())
        .filter((row) => row.status === 'pending' && row.source_system === 'platform').length
      return { rows: [{ count: String(count) }], rowCount: 1 }
    }

    if (normalized.startsWith('SELECT COUNT(*)::text AS count FROM approval_instances')) {
      const { rows } = filterDynamicInstances(normalized, params)
      return { rows: [{ count: String(rows.length) }], rowCount: 1 }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances WHERE id = $1 AND COALESCE(source_system, \'platform\') = \'platform\' FOR UPDATE')) {
      const row = state.instances.get(String(params[0]))
      const rows = row && row.source_system === 'platform' ? [row] : []
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances WHERE id = $1 FOR UPDATE')) {
      const row = state.instances.get(String(params[0]))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
      const row = state.instances.get(String(params[0]))
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances WHERE')) {
      const { rows, index } = filterDynamicInstances(normalized, params)
      const limit = Number(params[index])
      const offset = Number(params[index + 1])
      const sorted = rows.sort((left, right) => {
        const leftPrimary = (left.source_updated_at ?? left.updated_at).getTime()
        const rightPrimary = (right.source_updated_at ?? right.updated_at).getTime()
        if (leftPrimary !== rightPrimary) {
          return rightPrimary - leftPrimary
        }
        if (left.updated_at.getTime() !== right.updated_at.getTime()) {
          return right.updated_at.getTime() - left.updated_at.getTime()
        }
        return right.id.localeCompare(left.id)
      })
      const sliced = sorted.slice(offset, offset + limit)
      return { rows: sliced, rowCount: sliced.length }
    }

    if (normalized.startsWith('SELECT * FROM approval_instances ORDER BY COALESCE(source_updated_at, updated_at) DESC')) {
      const limit = Number(params[0])
      const offset = Number(params[1])
      const rows = Array.from(state.instances.values())
      const sorted = rows.sort((left, right) => {
        const leftPrimary = (left.source_updated_at ?? left.updated_at).getTime()
        const rightPrimary = (right.source_updated_at ?? right.updated_at).getTime()
        if (leftPrimary !== rightPrimary) {
          return rightPrimary - leftPrimary
        }
        if (left.updated_at.getTime() !== right.updated_at.getTime()) {
          return right.updated_at.getTime() - left.updated_at.getTime()
        }
        return right.id.localeCompare(left.id)
      })
      const sliced = sorted.slice(offset, offset + limit)
      return { rows: sliced, rowCount: sliced.length }
    }

    if (normalized.startsWith('SELECT * FROM approval_assignments WHERE instance_id = ANY($1)')) {
      const ids = new Set((params[0] as string[]) || [])
      const rows = Array.from(state.assignments.values()).filter((row) => ids.has(row.instance_id))
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('SELECT id, action, actor_id, actor_name, comment, from_status, to_status, metadata, occurred_at FROM approval_records')) {
      const rows = state.records
        .filter((row) => row.instance_id === String(params[0]))
        .sort((left, right) => right.occurred_at.getTime() - left.occurred_at.getTime())
      return { rows, rowCount: rows.length }
    }

    if (normalized.startsWith('INSERT INTO approval_instances')) {
      const [
        id,
        status,
        sourceSystem,
        externalApprovalId,
        workflowKey,
        businessKey,
        title,
        requesterSnapshot,
        subjectSnapshot,
        policySnapshot,
        metadata,
        sourceUpdatedAt,
      ] = params
      const existing = Array.from(state.instances.values()).find(
        (row) => row.source_system === sourceSystem && row.external_approval_id === externalApprovalId,
      )
      const preserved = existing || state.instances.get(String(id))
      const timestamp = now()
      const nextRow: InstanceRow = {
        ...(preserved || baseInstance({ id: String(id) })),
        id: preserved?.id || String(id),
        status: String(status),
        source_system: String(sourceSystem),
        external_approval_id: externalApprovalId == null ? null : String(externalApprovalId),
        workflow_key: workflowKey == null ? null : String(workflowKey),
        business_key: businessKey == null ? null : String(businessKey),
        title: title == null ? null : String(title),
        requester_snapshot: parseJson(requesterSnapshot),
        subject_snapshot: parseJson(subjectSnapshot),
        policy_snapshot: parseJson(policySnapshot),
        metadata: parseJson(metadata),
        current_step: 0,
        total_steps: 0,
        source_updated_at: sourceUpdatedAt ? new Date(String(sourceUpdatedAt)) : null,
        last_synced_at: timestamp,
        sync_status: 'ok',
        sync_error: null,
        created_at: preserved?.created_at || timestamp,
        updated_at: timestamp,
      }
      state.instances.set(nextRow.id, nextRow)
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('INSERT INTO approval_assignments')) {
      const instanceId = String(params[0])
      const key = `${instanceId}:source_queue:plm:source-owned:0`
      const timestamp = now()
      const existing = state.assignments.get(key)
      state.assignments.set(key, {
        id: existing?.id || `assign-${state.assignments.size + 1}`,
        instance_id: instanceId,
        assignment_type: 'source_queue',
        assignee_id: 'plm:source-owned',
        source_step: 0,
        is_active: Boolean(params[1]),
        metadata: parseJson(params[2]),
        created_at: existing?.created_at || timestamp,
        updated_at: timestamp,
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_assignments')) {
      const instanceId = String(params[0])
      const key = `${instanceId}:source_queue:plm:source-owned:0`
      const existing = state.assignments.get(key)
      if (!existing || !existing.is_active) {
        return { rows: [], rowCount: 0 }
      }
      state.assignments.set(key, {
        ...existing,
        source_step: 0,
        is_active: Boolean(params[1]),
        metadata: parseJson(params[2]),
        updated_at: now(),
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_instances SET sync_status = \'error\'')) {
      const row = state.instances.get(String(params[1]))
      if (row) {
        row.sync_status = 'error'
        row.sync_error = String(params[0])
        row.last_synced_at = now()
        row.updated_at = now()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('UPDATE approval_instances SET status = $1,')) {
      const row = state.instances.get(String(params[2]))
      const expectedVersion = Number(params[3])
      const expectedStatus = String(params[4])
      if (row && row.version === expectedVersion && row.status === expectedStatus) {
        row.status = String(params[0])
        row.version = Number(params[1])
        row.sync_status = 'ok'
        row.sync_error = null
        row.last_synced_at = now()
        row.updated_at = now()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
      Array.from(state.assignments.values())
        .filter((row) => row.instance_id === String(params[0]) && row.is_active)
        .forEach((row) => {
          row.is_active = false
          row.updated_at = now()
        })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('UPDATE approval_instances SET status = \'approved\'')) {
      const row = state.instances.get(String(params[1]))
      if (row) {
        row.status = 'approved'
        row.version = Number(params[0])
        row.updated_at = now()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('UPDATE approval_instances SET status = \'rejected\'')) {
      const row = state.instances.get(String(params[1]))
      if (row) {
        row.status = 'rejected'
        row.version = Number(params[0])
        row.updated_at = now()
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    if (normalized.startsWith('INSERT INTO approval_records')) {
      let record: ApprovalRecordRow

      if (normalized.includes("VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)")) {
        record = {
          id: state.recordId++,
          instance_id: String(params[0]),
          action: String(params[1]),
          actor_id: params[2] == null ? null : String(params[2]),
          actor_name: params[3] == null ? null : String(params[3]),
          comment: params[4] == null ? null : String(params[4]),
          reason: null,
          from_status: params[5] == null ? null : String(params[5]),
          to_status: String(params[6]),
          from_version: params[7] == null ? null : Number(params[7]),
          to_version: Number(params[8]),
          metadata: parseJson(params[9]),
          occurred_at: now(),
          created_at: now(),
        }
      } else if (normalized.includes("VALUES ($1, 'approve'")) {
        record = {
          id: state.recordId++,
          instance_id: String(params[0]),
          action: 'approve',
          actor_id: params[1] == null ? null : String(params[1]),
          actor_name: params[2] == null ? null : String(params[2]),
          comment: params[3] == null ? null : String(params[3]),
          reason: null,
          from_status: params[4] == null ? null : String(params[4]),
          to_status: 'approved',
          from_version: params[5] == null ? null : Number(params[5]),
          to_version: Number(params[6]),
          metadata: parseJson(params[7]),
          occurred_at: now(),
          created_at: now(),
        }
      } else {
        record = {
          id: state.recordId++,
          instance_id: String(params[0]),
          action: 'reject',
          actor_id: params[1] == null ? null : String(params[1]),
          actor_name: params[2] == null ? null : String(params[2]),
          reason: params[3] == null ? null : String(params[3]),
          comment: params[4] == null ? null : String(params[4]),
          from_status: params[5] == null ? null : String(params[5]),
          to_status: 'rejected',
          from_version: params[6] == null ? null : Number(params[6]),
          to_version: Number(params[7]),
          metadata: parseJson(params[8]),
          occurred_at: now(),
          created_at: now(),
        }
      }

      state.records.push(record)
      return { rows: [{ id: record.id }], rowCount: 1 }
    }

    throw new Error(`Unhandled SQL in approvals bridge test: ${normalized}`)
  })

  const pool = {
    query,
    connect: vi.fn(async () => ({
      query,
      release: vi.fn(),
    })),
  }

  const reset = () => {
    state.instances.clear()
    state.assignments.clear()
    state.records = []
    state.recordId = 1
    plmApprovals.splice(1)
    plmHistory.splice(1)
    plmApprovals[0].status = 'pending'
    plmApprovals[0].version = 7
    plmHistory[0].approved_at = '2026-04-04T00:10:00.000Z'
    plmHistory[0].created_at = '2026-04-04T00:09:00.000Z'
    state.instances.set('local-1', baseInstance())
    query.mockClear()
    pool.connect.mockClear()
  }

  return {
    state,
    pool,
    reset,
    plmApprovals,
    plmHistory,
  }
})

vi.mock('../../src/db/pg', () => ({
  pool: routeState.pool,
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'test-user',
      sub: 'test-user',
      name: 'Test User',
      email: 'test@example.com',
      permissions: ['*:*'],
      roles: ['admin'],
    } as never
    next()
  },
}))

import { approvalsRouter } from '../../src/routes/approvals'
import { approvalHistoryRouter } from '../../src/routes/approval-history'

function createPlmAdapterMock(): ApprovalBridgePlmAdapter & {
  getApprovals: ReturnType<typeof vi.fn>
  getApprovalById: ReturnType<typeof vi.fn>
  getApprovalHistory: ReturnType<typeof vi.fn>
  approveApproval: ReturnType<typeof vi.fn>
  rejectApproval: ReturnType<typeof vi.fn>
} {
  const selectApprovals = (options?: { status?: string; limit?: number; offset?: number }) => {
    const filtered = routeState.plmApprovals.filter((approval) => !options?.status || approval.status === options.status)
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? filtered.length
    return {
      data: filtered.slice(offset, offset + limit),
      totalCount: filtered.length,
    }
  }

  return {
    getApprovals: vi.fn(async (options?: { status?: string; limit?: number; offset?: number }) => {
      const result = selectApprovals(options)
      return {
        data: result.data,
        metadata: { totalCount: result.totalCount },
      }
    }),
    getApprovalById: vi.fn(async (approvalId: string) => ({
      data: routeState.plmApprovals.filter((approval) => approval.id === approvalId),
      metadata: { totalCount: routeState.plmApprovals.filter((approval) => approval.id === approvalId).length },
    })),
    getApprovalHistory: vi.fn(async () => ({
      data: routeState.plmHistory,
      metadata: { totalCount: routeState.plmHistory.length },
    })),
    approveApproval: vi.fn(async (approvalId: string, version: number, comment?: string) => {
      const approval = routeState.plmApprovals.find((item) => item.id === approvalId)
      if (approval) {
        approval.status = 'approved'
        if (typeof approval.version === 'number') {
          approval.version += 1
        }
      }
      return {
        data: [{ id: approvalId, version, comment: comment || null }],
        metadata: { totalCount: 1 },
      }
    }),
    rejectApproval: vi.fn(async (approvalId: string, version: number, comment: string) => {
      const approval = routeState.plmApprovals.find((item) => item.id === approvalId)
      if (approval) {
        approval.status = 'rejected'
        if (typeof approval.version === 'number') {
          approval.version += 1
        }
      }
      return {
        data: [{ id: approvalId, version, comment }],
        metadata: { totalCount: 1 },
      }
    }),
  }
}

function createApp(plmAdapter?: ApprovalBridgePlmAdapter) {
  const app = express()
  app.use(express.json())
  app.use(approvalsRouter({ plmAdapter }))
  app.use(approvalHistoryRouter({ plmAdapter }))
  return app
}

describe('approval bridge routes', () => {
  beforeEach(() => {
    routeState.reset()
  })

  it('syncs PLM approvals on unified list reads', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createApp(plmAdapter)

    const response = await request(app)
      .get('/api/approvals?sourceSystem=plm&status=pending')
      .expect(200)

    expect(plmAdapter.getApprovals).toHaveBeenCalledWith({
      status: 'pending',
      productId: undefined,
      requesterId: undefined,
      limit: 50,
      offset: 0,
    })
    expect(routeState.state.instances.has('plm:eco-1')).toBe(true)
    expect(routeState.state.instances.get('plm:eco-1')?.metadata.source_version).toBe(7)
    expect(response.body.total).toBe(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'plm:eco-1',
      sourceSystem: 'plm',
      externalApprovalId: 'eco-1',
      workflowKey: 'plm-eco-review',
      businessKey: 'plm:product:prod-1',
      status: 'pending',
      assignments: [
        {
          type: 'source_queue',
          assigneeId: 'plm:source-owned',
          sourceStep: 0,
          isActive: true,
        },
      ],
    })
  })

  it('syncs enough PLM pages to satisfy later paginated unified list reads', async () => {
    routeState.plmApprovals.push({
      id: 'eco-2',
      request_type: 'eco',
      title: 'ECO-2',
      requester_id: 'user-2',
      requester_name: 'Bob',
      status: 'pending',
      version: 3,
      created_at: '2026-04-04T00:01:00.000Z',
      updated_at: '2026-04-04T00:06:00.000Z',
      product_id: 'prod-2',
      product_number: 'PN-2',
      product_name: 'Drive Shaft',
    })

    const plmAdapter = createPlmAdapterMock()
    const response = await request(createApp(plmAdapter))
      .get('/api/approvals?sourceSystem=plm&limit=1&offset=1')
      .expect(200)

    expect(plmAdapter.getApprovals).toHaveBeenNthCalledWith(1, {
      status: undefined,
      productId: undefined,
      requesterId: undefined,
      limit: 50,
      offset: 0,
    })
    expect(response.body.total).toBe(2)
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'plm:eco-1',
      externalApprovalId: 'eco-1',
    })
  })

  it('lists platform approvals without requiring a configured PLM bridge', async () => {
    routeState.state.assignments.set('local-1:user-1', {
      id: 'assign-1',
      instance_id: 'local-1',
      assignment_type: 'user',
      assignee_id: 'user-1',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: new Date('2026-04-04T08:00:00.000Z'),
      updated_at: new Date('2026-04-04T08:00:00.000Z'),
    })

    const response = await request(createApp())
      .get('/api/approvals?assignee=user-1')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].id).toBe('local-1')
  })

  it('clamps oversized unified list limits before syncing PLM approvals', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createApp(plmAdapter)

    await request(app)
      .get('/api/approvals?sourceSystem=plm&limit=999')
      .expect(200)

    expect(plmAdapter.getApprovals).toHaveBeenCalledWith({
      status: undefined,
      productId: undefined,
      requesterId: undefined,
      limit: 50,
      offset: 0,
    })
  })

  it('skips PLM sync work when the requested unified list limit is zero', async () => {
    const plmAdapter = createPlmAdapterMock()
    const response = await request(createApp(plmAdapter))
      .get('/api/approvals?sourceSystem=plm&limit=0')
      .expect(200)

    expect(plmAdapter.getApprovals).not.toHaveBeenCalled()
    expect(response.body.total).toBe(0)
    expect(response.body.data).toEqual([])
  })

  it('rejects PLM assignee filtering in phase 1', async () => {
    const app = createApp(createPlmAdapterMock())

    const response = await request(app)
      .get('/api/approvals?sourceSystem=plm&assignee=me')
      .expect(400)

    expect(response.body.error.code).toBe('ASSIGNEE_FILTER_UNSUPPORTED')
  })

  it('returns a controlled unavailable response when the PLM adapter is not connected', async () => {
    const plmAdapter = createPlmAdapterMock()
    plmAdapter.getApprovals.mockRejectedValueOnce(new Error('HTTP client not initialized'))

    const response = await request(createApp(plmAdapter))
      .get('/api/approvals?sourceSystem=plm')
      .expect(503)

    expect(response.body.error.code).toBe('PLM_APPROVAL_BRIDGE_UNAVAILABLE')
  })

  it('lists platform approvals without requiring a PLM adapter', async () => {
    const response = await request(createApp())
      .get('/api/approvals')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'local-1',
      sourceSystem: 'platform',
    })
  })

  it('filters non-PLM approvals by active assignee assignments', async () => {
    const local = routeState.state.instances.get('local-1')!
    routeState.state.instances.set('local-2', {
      ...local,
      id: 'local-2',
      title: 'Assigned approval',
      updated_at: new Date('2026-04-04T09:00:00.000Z'),
    })

    routeState.state.assignments.set('local-1:user-1', {
      id: 'assign-1',
      instance_id: 'local-1',
      assignment_type: 'user',
      assignee_id: 'user-1',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: new Date('2026-04-04T08:00:00.000Z'),
      updated_at: new Date('2026-04-04T08:00:00.000Z'),
    })
    routeState.state.assignments.set('local-2:user-2', {
      id: 'assign-2',
      instance_id: 'local-2',
      assignment_type: 'user',
      assignee_id: 'user-2',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: new Date('2026-04-04T09:00:00.000Z'),
      updated_at: new Date('2026-04-04T09:00:00.000Z'),
    })

    const app = createApp(createPlmAdapterMock())
    const response = await request(app)
      .get('/api/approvals?assignee=user-2')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data).toHaveLength(1)
    expect(response.body.data[0]).toMatchObject({
      id: 'local-2',
      title: 'Assigned approval',
      assignments: [
        {
          type: 'user',
          assigneeId: 'user-2',
          isActive: true,
        },
      ],
    })
  })

  it('refreshes PLM details on demand', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createApp(plmAdapter)

    const response = await request(app)
      .get('/api/approvals/plm:eco-1')
      .expect(200)

    expect(plmAdapter.getApprovalById).toHaveBeenCalledWith('eco-1')
    expect(response.body).toMatchObject({
      id: 'plm:eco-1',
      sourceSystem: 'plm',
      title: 'ECO-1',
      status: 'pending',
    })
  })

  it('maps PLM history to unified history DTOs', async () => {
    const app = createApp(createPlmAdapterMock())

    const response = await request(app)
      .get('/api/approvals/plm:eco-1/history?page=1&pageSize=1')
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      data: {
        page: 1,
        pageSize: 1,
        total: 1,
      },
    })
    expect(response.body.data.items[0]).toMatchObject({
      id: 'hist-1',
      action: 'approve',
      actorId: 'reviewer-1',
      toStatus: 'approved',
      comment: 'LGTM',
    })
  })

  it('paginates PLM history through the canonical history route', async () => {
    routeState.plmHistory.push({
      id: 'hist-2',
      eco_id: 'eco-1',
      stage_id: 'approval',
      approval_type: 'mandatory',
      required_role: 'manager',
      user_id: 'reviewer-2',
      status: 'rejected',
      comment: 'needs changes',
      approved_at: '2026-04-04T00:11:00.000Z',
      created_at: '2026-04-04T00:11:00.000Z',
    })

    const response = await request(createApp(createPlmAdapterMock()))
      .get('/api/approvals/plm:eco-1/history?page=2&pageSize=1')
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      data: {
        page: 2,
        pageSize: 1,
        total: 2,
      },
    })
    expect(response.body.data.items).toHaveLength(1)
    expect(response.body.data.items[0].id).toBe('hist-1')
  })

  it('returns null occurredAt when PLM history has no timestamps', async () => {
    routeState.plmHistory[0].approved_at = null
    routeState.plmHistory[0].created_at = null
    const app = createApp(createPlmAdapterMock())

    const response = await request(app)
      .get('/api/approvals/plm:eco-1/history')
      .expect(200)

    expect(response.body.data.items[0].occurredAt).toBeNull()
  })

  it('requires a reject comment on unified actions', async () => {
    const app = createApp(createPlmAdapterMock())

    const response = await request(app)
      .post('/api/approvals/plm:eco-1/actions')
      .send({ action: 'reject' })
      .expect(400)

    expect(response.body.error.code).toBe('REJECT_COMMENT_REQUIRED')
  })

  it('dispatches PLM approve actions and writes local audit state', async () => {
    const plmAdapter = createPlmAdapterMock()
    const app = createApp(plmAdapter)

    const response = await request(app)
      .post('/api/approvals/plm:eco-1/actions')
      .send({ action: 'approve', comment: 'Ship it' })
      .expect(200)

    expect(plmAdapter.approveApproval).toHaveBeenCalledWith('eco-1', 7, 'Ship it')
    expect(response.body).toMatchObject({
      id: 'plm:eco-1',
      status: 'approved',
    })

    const mirrored = routeState.state.instances.get('plm:eco-1')
    expect(mirrored?.status).toBe('approved')
    expect(routeState.state.records).toHaveLength(1)
    expect(routeState.state.records[0]).toMatchObject({
      instance_id: 'plm:eco-1',
      action: 'approve',
      to_status: 'approved',
    })
    expect(mirrored?.version).toBe(1)
    expect(Array.from(routeState.state.assignments.values())[0]?.is_active).toBe(false)
  })

  it('fails PLM actions when the source version remains unavailable', async () => {
    routeState.state.instances.set('plm:legacy', {
      ...routeState.state.instances.get('local-1')!,
      id: 'plm:legacy',
      source_system: 'plm',
      external_approval_id: 'legacy',
      workflow_key: 'plm-eco-review',
      business_key: 'plm:approval:legacy',
      title: 'Legacy PLM approval',
      metadata: {},
    })

    const plmAdapter = createPlmAdapterMock()
    plmAdapter.getApprovalById.mockResolvedValueOnce({
      data: [],
      error: new Error('refresh failed'),
    })

    const response = await request(createApp(plmAdapter))
      .post('/api/approvals/plm:legacy/actions')
      .send({ action: 'approve', comment: 'Ship it' })
      .expect(502)

    expect(plmAdapter.approveApproval).not.toHaveBeenCalled()
    expect(response.body).toMatchObject({
      error: {
        code: 'SOURCE_ACTION_FAILED',
        message: 'PLM source version is unavailable',
      },
    })
  })

  it('keeps merged PLM history sorting deterministic when upstream timestamps are invalid', async () => {
    routeState.plmHistory[0].approved_at = 'not-a-date'
    routeState.plmHistory[0].created_at = 'still-not-a-date'

    const app = createApp(createPlmAdapterMock())
    await request(app)
      .post('/api/approvals/plm:eco-1/actions')
      .send({ action: 'approve', comment: 'Ship it' })
      .expect(200)

    const response = await request(app)
      .get('/api/approvals/plm:eco-1/history')
      .expect(200)

    expect(response.body.data.items[0]).toMatchObject({
      action: 'approve',
      actorId: 'test-user',
      comment: 'Ship it',
    })
    expect(response.body.data.items[1].id).toBe('hist-1')
  })

  it('merges local audit records into PLM history responses', async () => {
    const app = createApp(createPlmAdapterMock())

    await request(app)
      .post('/api/approvals/plm:eco-1/actions')
      .send({ action: 'approve', comment: 'Ship it' })
      .expect(200)

    const history = await request(app)
      .get('/api/approvals/plm:eco-1/history')
      .expect(200)

    expect(history.body.data.total).toBe(2)
    expect(history.body.data.items[0]).toMatchObject({
      action: 'approve',
      actorId: 'test-user',
      comment: 'Ship it',
      metadata: {
        sourceSystem: 'plm',
      },
    })
  })

  it('returns structured errors when PLM history fetch fails', async () => {
    const plmAdapter = createPlmAdapterMock()
    plmAdapter.getApprovalHistory.mockResolvedValueOnce({
      data: [],
      error: new Error('upstream boom'),
    })

    const response = await request(createApp(plmAdapter))
      .get('/api/approvals/plm:eco-1/history')
      .expect(502)

    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'SOURCE_ACTION_FAILED',
        message: 'Failed to fetch PLM approval history',
      },
    })
    expect(String(response.body.error.details.upstream)).toContain('upstream boom')
  })

  it('filters non-PLM approvals by active assignee from approval_assignments', async () => {
    const now = new Date('2026-04-04T08:00:00.000Z')
    // Add a second platform instance that should NOT be returned
    routeState.state.instances.set('local-2', {
      ...routeState.state.instances.get('local-1')!,
      id: 'local-2',
      title: 'Local approval 2',
    })

    // Assign local-1 to user-assignee (active)
    routeState.state.assignments.set('local-1:source_queue:user-assignee:0', {
      id: 'assign-a1',
      instance_id: 'local-1',
      assignment_type: 'source_queue',
      assignee_id: 'user-assignee',
      source_step: 0,
      is_active: true,
      metadata: {},
      created_at: now,
      updated_at: now,
    })

    const app = createApp(createPlmAdapterMock())
    const response = await request(app)
      .get('/api/approvals?assignee=user-assignee')
      .expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].id).toBe('local-1')
  })

  it('keeps legacy pending approvals scoped to platform-owned rows', async () => {
    routeState.state.instances.set('plm:eco-1', {
      ...routeState.state.instances.get('local-1')!,
      id: 'plm:eco-1',
      source_system: 'plm',
      external_approval_id: 'eco-1',
      workflow_key: 'plm-eco-review',
      business_key: 'plm:product:prod-1',
      title: 'ECO-1',
    })

    const app = createApp(createPlmAdapterMock())
    const response = await request(app).get('/api/approvals/pending').expect(200)

    expect(response.body.total).toBe(1)
    expect(response.body.data[0].id).toBe('local-1')
  })
})
