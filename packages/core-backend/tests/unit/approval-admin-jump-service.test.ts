import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgState = vi.hoisted(() => ({
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}))

const eventBusState = vi.hoisted(() => ({
  emit: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

vi.mock('../../src/integration/events/event-bus', () => ({
  eventBus: eventBusState,
}))

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function buildNoopMetrics() {
  return {
    recordInstanceStart: vi.fn().mockResolvedValue(undefined),
    recordTerminal: vi.fn().mockResolvedValue(undefined),
    recordNodeActivation: vi.fn().mockResolvedValue(undefined),
    recordNodeDecision: vi.fn().mockResolvedValue(undefined),
    checkSlaBreaches: vi.fn().mockResolvedValue([]),
    getMetricsSummary: vi.fn(),
    getInstanceMetrics: vi.fn(),
    listActiveBreaches: vi.fn(),
  }
}

function adminActor(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'admin-1',
    userName: 'Admin One',
    roles: ['admin'],
    permissions: ['approvals:admin'],
    tenantId: 'default',
    ip: '127.0.0.1',
    userAgent: 'vitest',
    ...overrides,
  }
}

function buildInstanceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apr-1',
    status: 'pending',
    version: 2,
    source_system: 'platform',
    external_approval_id: null,
    workflow_key: 'approval-product-template',
    business_key: 'travel-request',
    title: 'Travel Request',
    requester_snapshot: { id: 'requester-1', name: 'Requester One' },
    subject_snapshot: {},
    policy_snapshot: { allowRevoke: true },
    metadata: {},
    current_step: 1,
    total_steps: 3,
    source_updated_at: null,
    last_synced_at: null,
    sync_status: 'ok',
    sync_error: null,
    template_id: 'tpl-1',
    template_version_id: 'ver-active',
    published_definition_id: 'pub-frozen',
    request_no: 'AP-100001',
    form_snapshot: {},
    current_node_key: 'manager_review',
    created_at: new Date('2026-05-15T00:00:00.000Z'),
    updated_at: new Date('2026-05-15T00:05:00.000Z'),
    ...overrides,
  }
}

function buildLinearGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'manager_review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
      { key: 'finance_review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['finance-1'] } },
      { key: 'cc_notify', type: 'cc', config: { targetType: 'user', targetIds: ['audit-1'] } },
      { key: 'director_review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['director-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-start-manager', source: 'start', target: 'manager_review' },
      { key: 'e-manager-finance', source: 'manager_review', target: 'finance_review' },
      { key: 'e-finance-cc', source: 'finance_review', target: 'cc_notify' },
      { key: 'e-cc-director', source: 'cc_notify', target: 'director_review' },
      { key: 'e-director-end', source: 'director_review', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
}

function buildParallelGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'parallel_fork', type: 'parallel', config: { branches: ['e-fork-legal', 'e-fork-finance'], joinNodeKey: 'post_join', joinMode: 'all' } },
      { key: 'legal_review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['legal-1'] } },
      { key: 'finance_branch_review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['finance-branch-1'] } },
      { key: 'post_join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['post-join-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-start-fork', source: 'start', target: 'parallel_fork' },
      { key: 'e-fork-legal', source: 'parallel_fork', target: 'legal_review' },
      { key: 'e-fork-finance', source: 'parallel_fork', target: 'finance_branch_review' },
      { key: 'e-legal-join', source: 'legal_review', target: 'post_join' },
      { key: 'e-finance-join', source: 'finance_branch_review', target: 'post_join' },
      { key: 'e-join-end', source: 'post_join', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
}

function buildAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asg-1',
    instance_id: 'apr-1',
    assignment_type: 'user',
    assignee_id: 'manager-1',
    source_step: 1,
    node_key: 'manager_review',
    is_active: true,
    metadata: {},
    created_at: new Date('2026-05-15T00:06:00.000Z'),
    updated_at: new Date('2026-05-15T00:06:00.000Z'),
    ...overrides,
  }
}

function buildParallelState() {
  return {
    parallelNodeKey: 'parallel_fork',
    joinNodeKey: 'post_join',
    joinMode: 'all',
    branches: {
      'e-fork-legal': { edgeKey: 'e-fork-legal', currentNodeKey: 'legal_review', complete: false },
      'e-fork-finance': { edgeKey: 'e-fork-finance', currentNodeKey: 'finance_branch_review', complete: false },
    },
  }
}

function mockAdminJumpQueries(options: {
  instance?: Record<string, unknown> | null
  runtimeGraph?: Record<string, unknown>
  assignments?: Array<Record<string, unknown>>
  historyRows?: Array<Record<string, unknown>>
}) {
  const instance = options.instance === undefined ? buildInstanceRow() : options.instance
  const runtimeGraph = options.runtimeGraph ?? buildLinearGraph()
  const assignments = options.assignments ?? [buildAssignment()]
  const historyRows = options.historyRows ?? []

  pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const statement = normalize(sql)
    if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }
    if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
      return { rows: instance ? [instance] : [], rowCount: instance ? 1 : 0 }
    }
    if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
      expect(params).toEqual([instance?.published_definition_id ?? 'pub-frozen'])
      return {
        rows: [{
          id: instance?.published_definition_id ?? 'pub-frozen',
          template_id: 'tpl-1',
          template_version_id: 'ver-frozen',
          runtime_graph: runtimeGraph,
          is_active: true,
          published_at: new Date('2026-05-15T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE')) {
      return { rows: assignments, rowCount: assignments.length }
    }
    if (statement.startsWith('SELECT id, actor_id, metadata FROM approval_records')) {
      return { rows: historyRows, rowCount: historyRows.length }
    }
    if (statement.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
      return { rows: [], rowCount: assignments.length }
    }
    if (statement.startsWith('UPDATE approval_instances')) {
      return { rows: [], rowCount: 1 }
    }
    if (statement.startsWith('INSERT INTO approval_assignments')) {
      return { rows: [], rowCount: 1 }
    }
    if (statement.startsWith('INSERT INTO approval_records')) {
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unhandled client query: ${statement}`)
  })
}

function mockDispatchQueriesForOldAssignee() {
  const instance = buildInstanceRow({
    current_node_key: 'finance_review',
    version: 3,
  })
  pgState.client.query.mockImplementation(async (sql: string) => {
    const statement = normalize(sql)
    if (statement === 'BEGIN' || statement === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }
    if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
      return { rows: [instance], rowCount: 1 }
    }
    if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
      return {
        rows: [{
          id: 'pub-frozen',
          template_id: 'tpl-1',
          template_version_id: 'ver-frozen',
          runtime_graph: buildLinearGraph(),
          is_active: true,
          published_at: new Date('2026-05-15T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE')) {
      return {
        rows: [buildAssignment({ id: 'asg-finance', assignee_id: 'finance-1', node_key: 'finance_review', source_step: 2 })],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled client query: ${statement}`)
  })
}

function installGetApprovalStub(service: { getApproval: (id: string) => Promise<unknown> }) {
  return vi.spyOn(service, 'getApproval').mockResolvedValue({
    id: 'apr-1',
    status: 'pending',
    currentNodeKey: 'finance_review',
    version: 3,
    assignments: [],
  })
}

function findRecordInsert(action: string) {
  return pgState.client.query.mock.calls.find(([sql, params]) =>
    normalize(String(sql)).startsWith('INSERT INTO approval_records')
    && Array.isArray(params)
    && params[1] === action)
}

function findInstanceUpdate() {
  return pgState.client.query.mock.calls.find(([sql]) =>
    normalize(String(sql)).startsWith('UPDATE approval_instances'))
}

function allSqlStatements(): string[] {
  return [
    ...pgState.client.query.mock.calls.map(([sql]) => normalize(String(sql))),
    ...pgState.pool.query.mock.calls.map(([sql]) => normalize(String(sql))),
  ]
}

describe('ApprovalProductService adminJump', () => {
  beforeEach(() => {
    vi.resetModules()
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    eventBusState.emit.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  it('T2/T3 rejects terminal or stale instances before mutating jump state', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)

    mockAdminJumpQueries({ instance: buildInstanceRow({ status: 'approved' }) })
    await expect(service.adminJump('apr-1', { version: 2, targetNodeKey: 'finance_review', reason: 'ops fix' }, adminActor()))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(allSqlStatements().some((statement) => statement.includes('approval_published_definitions'))).toBe(false)
    expect(pgState.client.query.mock.calls.some(([sql]) => normalize(String(sql)) === 'ROLLBACK')).toBe(true)

    pgState.client.query.mockReset()
    mockAdminJumpQueries({ instance: buildInstanceRow({ version: 3 }) })
    await expect(service.adminJump('apr-1', { version: 2, targetNodeKey: 'finance_review', reason: 'stale' }, adminActor()))
      .rejects.toMatchObject({ statusCode: 409, details: { currentVersion: 3 } })
    expect(allSqlStatements().some((statement) => statement.includes('UPDATE approval_instances'))).toBe(false)
  })

  it('T4/T7/T10/T12/T13 jumps using the frozen runtime graph and records admin audit/event state', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    installGetApprovalStub(service)
    mockAdminJumpQueries({ runtimeGraph: buildLinearGraph() })

    const result = await service.adminJump(
      'apr-1',
      { version: 2, targetNodeKey: 'finance_review', reason: 'skip broken node' },
      adminActor(),
    )

    expect(result).toMatchObject({ id: 'apr-1', currentNodeKey: 'finance_review' })
    const statements = allSqlStatements()
    expect(statements.some((statement) => statement.includes('approval_templates'))).toBe(false)
    expect(statements.some((statement) => statement.includes('approval_template_versions'))).toBe(false)
    expect(statements.some((statement) => statement.includes('active_version_id'))).toBe(false)

    const updateCall = findInstanceUpdate()
    expect(updateCall?.[1]).toEqual([
      'apr-1',
      'pending',
      3,
      'finance_review',
      2,
      3,
    ])
    expect(normalize(String(updateCall?.[0]))).not.toContain('template_version_id')
    expect(normalize(String(updateCall?.[0]))).not.toContain('published_definition_id')

    const assignmentInsert = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(String(sql)).startsWith('INSERT INTO approval_assignments'))
    expect(assignmentInsert?.[1]).toEqual([
      'apr-1',
      'user',
      'finance-1',
      2,
      'finance_review',
    ])

    const recordCall = findRecordInsert('jump')
    expect(recordCall).toBeTruthy()
    const recordParams = recordCall?.[1] as unknown[]
    expect(recordParams[2]).toBe('admin-1')
    expect(recordParams[4]).toBe('skip broken node')
    expect(recordParams[7]).toBe(2)
    expect(recordParams[8]).toBe(3)
    const metadata = JSON.parse(String(recordParams[9])) as Record<string, unknown>
    expect(metadata).toMatchObject({
      adminJump: true,
      fromNodeKey: 'manager_review',
      toNodeKey: 'finance_review',
      nextNodeKey: 'finance_review',
      actorId: 'admin-1',
      parallelStateCleared: false,
    })
    expect(metadata.oldAssignees).toEqual([{
      assignmentType: 'user',
      assigneeId: 'manager-1',
      nodeKey: 'manager_review',
      sourceStep: 1,
    }])
    expect(eventBusState.emit).toHaveBeenCalledWith('approval.admin_jumped', expect.objectContaining({
      instanceId: 'apr-1',
      fromNodeKey: 'manager_review',
      toNodeKey: 'finance_review',
      actorId: 'admin-1',
      publishedDefinitionId: 'pub-frozen',
    }))
  })

  it('T5 rejects missing targets and existing non-approval target nodes', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)

    mockAdminJumpQueries({ runtimeGraph: buildLinearGraph() })
    await expect(service.adminJump('apr-1', { version: 2, targetNodeKey: 'missing_node', reason: 'bad' }, adminActor()))
      .rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_JUMP_TARGET_INVALID' })

    pgState.client.query.mockReset()
    mockAdminJumpQueries({ runtimeGraph: buildLinearGraph() })
    await expect(service.adminJump('apr-1', { version: 2, targetNodeKey: 'cc_notify', reason: 'bad' }, adminActor()))
      .rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_JUMP_TARGET_INVALID' })

    expect(allSqlStatements().some((statement) => statement.includes('INSERT INTO approval_records'))).toBe(false)
  })

  it('T6 rejects backward jumps and T12 rejects stale double-jump versions with 409', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)

    mockAdminJumpQueries({
      instance: buildInstanceRow({ current_node_key: 'finance_review' }),
      runtimeGraph: buildLinearGraph(),
    })
    await expect(service.adminJump('apr-1', { version: 2, targetNodeKey: 'manager_review', reason: 'backward' }, adminActor()))
      .rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_JUMP_TARGET_NOT_FORWARD' })

    pgState.client.query.mockReset()
    mockAdminJumpQueries({ instance: buildInstanceRow({ version: 3 }) })
    await expect(service.adminJump('apr-1', { version: 2, targetNodeKey: 'finance_review', reason: 'stale second jump' }, adminActor()))
      .rejects.toMatchObject({ statusCode: 409, details: { currentVersion: 3 } })
  })

  it('T8 prevents old assignees from acting after jump deactivates their assignment', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    mockDispatchQueriesForOldAssignee()

    await expect(service.dispatchAction(
      'apr-1',
      { action: 'approve', version: 3 },
      { ...adminActor({ userId: 'manager-1', userName: 'Manager One', roles: [], permissions: ['approvals:act'] }) },
    )).rejects.toMatchObject({ statusCode: 403, code: 'APPROVAL_ASSIGNMENT_REQUIRED' })
  })

  it('T9 applies PD3 parallel boundaries: branch targets fail, post-join targets clear branch state', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    installGetApprovalStub(service)
    const parallelGraph = buildParallelGraph()
    const parallelInstance = buildInstanceRow({
      current_node_key: 'parallel_fork',
      metadata: { parallelBranchStates: buildParallelState() },
    })

    mockAdminJumpQueries({ instance: parallelInstance, runtimeGraph: parallelGraph })
    await expect(service.adminJump('apr-1', { version: 2, targetNodeKey: 'legal_review', reason: 'bad branch' }, adminActor()))
      .rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_JUMP_PARALLEL_BRANCH_TARGET_UNSUPPORTED' })

    pgState.client.query.mockReset()
    mockAdminJumpQueries({
      instance: parallelInstance,
      runtimeGraph: parallelGraph,
      assignments: [
        buildAssignment({ id: 'asg-legal', assignee_id: 'legal-1', node_key: 'legal_review' }),
        buildAssignment({ id: 'asg-finance', assignee_id: 'finance-branch-1', node_key: 'finance_branch_review' }),
      ],
    })

    await service.adminJump('apr-1', { version: 2, targetNodeKey: 'post_join', reason: 'join recovery' }, adminActor())

    const updateCall = findInstanceUpdate()
    expect(normalize(String(updateCall?.[0]))).toContain("metadata = COALESCE(metadata, '{}'::jsonb) - 'parallelBranchStates'")
    expect(updateCall?.[1]).toEqual([
      'apr-1',
      'pending',
      3,
      'post_join',
      3,
      3,
    ])
    const recordCall = findRecordInsert('jump')
    const metadata = JSON.parse(String((recordCall?.[1] as unknown[])[9])) as Record<string, unknown>
    expect(metadata).toMatchObject({
      fromNodeKey: 'parallel_fork',
      toNodeKey: 'post_join',
      parallelStateCleared: true,
    })
  })
})
