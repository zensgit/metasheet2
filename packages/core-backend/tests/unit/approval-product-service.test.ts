import { beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'

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

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function buildRuntimeGraph(policyOverrides?: Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
      { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
    ],
    policy: {
      allowRevoke: true,
      ...policyOverrides,
    },
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
    requester_snapshot: { id: 'user-1', name: 'Owner One' },
    subject_snapshot: {},
    policy_snapshot: { allowRevoke: true },
    metadata: {},
    current_step: 1,
    total_steps: 1,
    source_updated_at: null,
    last_synced_at: null,
    sync_status: 'ok',
    sync_error: null,
    template_id: 'tpl-1',
    template_version_id: 'ver-1',
    published_definition_id: 'pub-1',
    request_no: 'AP-100001',
    form_snapshot: {},
    current_node_key: 'approval_1',
    created_at: new Date('2026-04-11T00:00:00.000Z'),
    updated_at: new Date('2026-04-11T00:05:00.000Z'),
    ...overrides,
  }
}

function buildApprovalDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apr-1',
    sourceSystem: 'platform',
    externalApprovalId: null,
    workflowKey: 'approval-product-template',
    businessKey: 'travel-request',
    title: 'Travel Request',
    status: 'pending',
    requester: { id: 'user-1', name: 'Owner One' },
    subject: {},
    policy: { allowRevoke: true },
    currentStep: 1,
    totalSteps: 1,
    templateId: 'tpl-1',
    templateVersionId: 'ver-1',
    publishedDefinitionId: 'pub-1',
    requestNo: 'AP-100001',
    formSnapshot: {},
    currentNodeKey: 'approval_1',
    assignments: [],
    createdAt: '2026-04-11T00:00:00.000Z',
    updatedAt: '2026-04-11T00:05:00.000Z',
    ...overrides,
  }
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

describe('ApprovalProductService', () => {
  beforeEach(() => {
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  it('blocks revoke when the published runtime policy disables it', async () => {
    const runtimeGraph = buildRuntimeGraph({ allowRevoke: false })

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return {
          rows: [{
            id: 'apr-1',
            status: 'pending',
            version: 2,
            source_system: 'platform',
            external_approval_id: null,
            workflow_key: 'approval-product-template',
            business_key: 'travel-request',
            title: 'Travel Request',
            requester_snapshot: { id: 'user-1', name: 'Owner One' },
            subject_snapshot: {},
            policy_snapshot: { allowRevoke: false },
            metadata: {},
            current_step: 1,
            total_steps: 1,
            source_updated_at: null,
            last_synced_at: null,
            sync_status: 'ok',
            sync_error: null,
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            published_definition_id: 'pub-1',
            request_no: 'AP-100001',
            form_snapshot: {},
            current_node_key: 'approval_1',
            created_at: new Date('2026-04-11T00:00:00.000Z'),
            updated_at: new Date('2026-04-11T00:05:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await expect(service.dispatchAction('apr-1', { action: 'revoke' }, { userId: 'user-1' }))
      .rejects
      .toMatchObject({
        message: 'Approval cannot be revoked for this template',
        statusCode: 409,
        code: 'APPROVAL_REVOKE_DISABLED',
      })

    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('blocks revoke when the current node is outside the runtime revoke window', async () => {
    const runtimeGraph = buildRuntimeGraph({ revokeBeforeNodeKeys: ['approval_2'] })

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return {
          rows: [{
            id: 'apr-1',
            status: 'pending',
            version: 3,
            source_system: 'platform',
            external_approval_id: null,
            workflow_key: 'approval-product-template',
            business_key: 'travel-request',
            title: 'Travel Request',
            requester_snapshot: { id: 'user-1', name: 'Owner One' },
            subject_snapshot: {},
            policy_snapshot: { allowRevoke: true },
            metadata: {},
            current_step: 1,
            total_steps: 1,
            source_updated_at: null,
            last_synced_at: null,
            sync_status: 'ok',
            sync_error: null,
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            published_definition_id: 'pub-1',
            request_no: 'AP-100001',
            form_snapshot: {},
            current_node_key: 'approval_1',
            created_at: new Date('2026-04-11T00:00:00.000Z'),
            updated_at: new Date('2026-04-11T00:05:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await expect(service.dispatchAction('apr-1', { action: 'revoke' }, { userId: 'user-1' }))
      .rejects
      .toMatchObject({
        message: 'Approval can no longer be revoked',
        statusCode: 409,
        code: 'APPROVAL_REVOKE_WINDOW_CLOSED',
      })

    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('rejects return targets that are not previously visited approval nodes', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'approval_2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-2'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval-1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-1-approval-2', source: 'approval_1', target: 'approval_2' },
        { key: 'edge-approval-2-end', source: 'approval_2', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return {
          rows: [buildInstanceRow({
            version: 4,
            current_step: 2,
            total_steps: 2,
            current_node_key: 'approval_2',
          })],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1')) {
        return {
          rows: [{
            id: 'asg-approval-2',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'manager-2',
            source_step: 2,
            node_key: 'approval_2',
            is_active: true,
            metadata: {},
            created_at: new Date('2026-04-11T00:00:00.000Z'),
            updated_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await expect(service.dispatchAction(
      'apr-1',
      { action: 'return', targetNodeKey: 'approval_2' },
      { userId: 'manager-2' },
    )).rejects.toMatchObject({
      message: 'Return target must be a previously visited approval node',
      statusCode: 409,
      code: 'APPROVAL_RETURN_TARGET_INVALID',
    })

    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('returns an approval to a previously visited node and reassigns that node', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'approval_2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-2'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval-1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-1-approval-2', source: 'approval_1', target: 'approval_2' },
        { key: 'edge-approval-2-end', source: 'approval_2', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return {
          rows: [buildInstanceRow({
            version: 4,
            current_step: 2,
            total_steps: 2,
            current_node_key: 'approval_2',
          })],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1')) {
        return {
          rows: [{
            id: 'asg-approval-2',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'manager-2',
            source_step: 2,
            node_key: 'approval_2',
            is_active: true,
            metadata: {},
            created_at: new Date('2026-04-11T00:00:00.000Z'),
            updated_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_instances SET status = $2')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_assignments')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()
    vi.spyOn(service, 'getApproval').mockResolvedValue(
      buildApprovalDto({
        currentStep: 1,
        totalSteps: 2,
        currentNodeKey: 'approval_1',
        assignments: [{
          id: 'asg-returned',
          type: 'user',
          assigneeId: 'manager-1',
          sourceStep: 1,
          nodeKey: 'approval_1',
          isActive: true,
          metadata: {},
        }],
      }),
    )

    const result = await service.dispatchAction(
      'apr-1',
      { action: 'return', targetNodeKey: 'approval_1', comment: 'needs rework' },
      { userId: 'manager-2' },
    )

    expect(result.currentNodeKey).toBe('approval_1')
    expect(result.assignments).toEqual([
      {
        id: 'asg-returned',
        type: 'user',
        assigneeId: 'manager-1',
        sourceStep: 1,
        nodeKey: 'approval_1',
        isActive: true,
        metadata: {},
      },
    ])

    const recordCall = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records'))
    expect(recordCall).toBeDefined()
    expect(JSON.parse(String(recordCall?.[1]?.[9]))).toMatchObject({
      nodeKey: 'approval_2',
      targetNodeKey: 'approval_1',
      nextNodeKey: 'approval_1',
    })
    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('keeps all-mode approvals pending until every assignee has acted', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
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
        { key: 'edge-start-approval-1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-1-end', source: 'approval_1', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return {
          rows: [buildInstanceRow({
            version: 4,
            current_step: 1,
            total_steps: 1,
            current_node_key: 'approval_1',
          })],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1')) {
        return {
          rows: [
            {
              id: 'asg-manager-1',
              instance_id: 'apr-1',
              assignment_type: 'user',
              assignee_id: 'manager-1',
              source_step: 1,
              node_key: 'approval_1',
              is_active: true,
              metadata: {},
              created_at: new Date('2026-04-11T00:00:00.000Z'),
              updated_at: new Date('2026-04-11T00:00:00.000Z'),
            },
            {
              id: 'asg-manager-2',
              instance_id: 'apr-1',
              assignment_type: 'user',
              assignee_id: 'manager-2',
              source_step: 1,
              node_key: 'approval_1',
              is_active: true,
              metadata: {},
              created_at: new Date('2026-04-11T00:00:00.000Z'),
              updated_at: new Date('2026-04-11T00:00:00.000Z'),
            },
          ],
          rowCount: 2,
        }
      }
      if (statement.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
        expect(params).toEqual(['apr-1', 'approval_1', 'manager-1', []])
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_instances SET version = $2')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()
    vi.spyOn(service, 'getApproval').mockResolvedValue(
      buildApprovalDto({
        currentNodeKey: 'approval_1',
        assignments: [{
          id: 'asg-manager-2',
          type: 'user',
          assigneeId: 'manager-2',
          sourceStep: 1,
          nodeKey: 'approval_1',
          isActive: true,
          metadata: {},
        }],
      }),
    )

    const result = await service.dispatchAction(
      'apr-1',
      { action: 'approve', comment: 'approved by first signer' },
      { userId: 'manager-1' },
    )

    expect(result.status).toBe('pending')
    expect(result.currentNodeKey).toBe('approval_1')
    expect(pgState.client.query.mock.calls.some(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))).toBe(false)

    const recordCall = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records'))
    expect(recordCall).toBeDefined()
    expect(JSON.parse(String(recordCall?.[1]?.[9]))).toMatchObject({
      nodeKey: 'approval_1',
      nextNodeKey: 'approval_1',
      approvalMode: 'all',
      aggregateComplete: false,
      remainingAssignments: 1,
    })
    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('retries template clone key generation on a unique violation', async () => {
    const randomBytesSpy = vi.spyOn(crypto, 'randomBytes')
      .mockReturnValueOnce(Buffer.from('aaaaaa', 'hex') as never)
      .mockReturnValueOnce(Buffer.from('bbbbbb', 'hex') as never)

    const sourceTemplate = {
      id: 'tpl-source',
      key: 'travel',
      name: 'Travel',
      description: 'Travel template',
      category: '请假',
      status: 'archived',
      active_version_id: null,
      latest_version_id: 'ver-source',
      created_at: new Date('2026-04-23T00:00:00.000Z'),
      updated_at: new Date('2026-04-23T00:00:00.000Z'),
    }
    const sourceVersion = {
      id: 'ver-source',
      template_id: 'tpl-source',
      version: 3,
      status: 'archived',
      form_schema: { fields: [] },
      approval_graph: { nodes: [], edges: [] },
      created_at: new Date('2026-04-23T00:00:00.000Z'),
      updated_at: new Date('2026-04-23T00:00:00.000Z'),
    }

    pgState.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
        return { rows: [sourceTemplate], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return { rows: [sourceVersion], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unhandled pool query: ${statement}`)
    })

    let templateInsertAttempts = 0
    pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'ROLLBACK' || statement === 'COMMIT') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_templates')) {
        templateInsertAttempts += 1
        if (templateInsertAttempts === 1) {
          throw Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'idx_approval_templates_key',
          })
        }
        expect(params?.[0]).toBe('travel_copy_bbbbbb')
        return {
          rows: [{
            ...sourceTemplate,
            id: 'tpl-clone',
            key: 'travel_copy_bbbbbb',
            name: 'Travel (副本)',
            status: 'draft',
            active_version_id: null,
            latest_version_id: null,
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('INSERT INTO approval_template_versions')) {
        return {
          rows: [{
            ...sourceVersion,
            id: 'ver-clone',
            template_id: 'tpl-clone',
            version: 1,
            status: 'draft',
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('UPDATE approval_templates SET latest_version_id')) {
        return {
          rows: [{
            ...sourceTemplate,
            id: 'tpl-clone',
            key: 'travel_copy_bbbbbb',
            name: 'Travel (副本)',
            status: 'draft',
            active_version_id: null,
            latest_version_id: 'ver-clone',
          }],
          rowCount: 1,
        }
      }
      throw new Error(`Unhandled client query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()
    const result = await service.cloneTemplate('tpl-source')

    expect(result).toMatchObject({
      id: 'tpl-clone',
      key: 'travel_copy_bbbbbb',
      name: 'Travel (副本)',
      status: 'draft',
      category: '请假',
      latestVersionId: 'ver-clone',
    })
    expect(templateInsertAttempts).toBe(2)
    expect(pgState.client.query.mock.calls.filter(([sql]) => normalize(sql as string) === 'ROLLBACK')).toHaveLength(1)
    expect(pgState.client.query.mock.calls.filter(([sql]) => normalize(sql as string) === 'COMMIT')).toHaveLength(1)
    expect(pgState.client.release).toHaveBeenCalledTimes(2)

    randomBytesSpy.mockRestore()
  })

  it('persists visibility rules when creating a template', async () => {
    const request = {
      key: 'expense-with-rule',
      name: 'Expense With Rule',
      description: 'Template with dependent field visibility',
      visibilityScope: { type: 'all', ids: [] },
      formSchema: {
        fields: [
          {
            id: 'showDetails',
            type: 'select',
            label: 'Show Details',
            required: true,
            options: [
              { label: 'Yes', value: 'yes' },
              { label: 'No', value: 'no' },
            ],
          },
          {
            id: 'details',
            type: 'textarea',
            label: 'Details',
            required: true,
            visibilityRule: {
              fieldId: 'showDetails',
              operator: 'eq',
              value: 'yes',
            },
          },
        ],
      },
      approvalGraph: buildRuntimeGraph(),
    }

    pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_templates')) {
        return {
          rows: [{
            id: 'tpl-visibility',
            key: String(params?.[0]),
            name: String(params?.[1]),
            description: params?.[2] == null ? null : String(params?.[2]),
            category: null,
            visibility_scope: JSON.parse(String(params?.[4])),
            sla_hours: null,
            status: 'draft',
            active_version_id: null,
            latest_version_id: null,
            created_at: new Date('2026-04-11T00:00:00.000Z'),
            updated_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('INSERT INTO approval_template_versions')) {
        return {
          rows: [{
            id: 'ver-visibility',
            template_id: 'tpl-visibility',
            version: 1,
            status: 'draft',
            form_schema: JSON.parse(String(params?.[1])),
            approval_graph: JSON.parse(String(params?.[2])),
            created_at: new Date('2026-04-11T00:00:00.000Z'),
            updated_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('UPDATE approval_templates')) {
        return {
          rows: [{
            id: 'tpl-visibility',
            key: 'expense-with-rule',
            name: 'Expense With Rule',
            description: 'Template with dependent field visibility',
            category: null,
            visibility_scope: { type: 'all', ids: [] },
            sla_hours: null,
            status: 'draft',
            active_version_id: 'ver-visibility',
            latest_version_id: 'ver-visibility',
            created_at: new Date('2026-04-11T00:00:00.000Z'),
            updated_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()
    const result = await service.createTemplate(request as never)

    expect(result.formSchema.fields[1].visibilityRule).toEqual({
      fieldId: 'showDetails',
      operator: 'eq',
      value: 'yes',
    })
    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid visibility rules before hitting the database', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await expect(service.createTemplate({
      key: 'broken-rule',
      name: 'Broken Rule',
      formSchema: {
        fields: [
          {
            id: 'showDetails',
            type: 'select',
            label: 'Show Details',
            options: [
              { label: 'Yes', value: 'yes' },
              { label: 'No', value: 'no' },
            ],
          },
          {
            id: 'details',
            type: 'textarea',
            label: 'Details',
            visibilityRule: {
              fieldId: 'missing-field',
              operator: 'eq',
              value: 'yes',
            },
          },
        ],
      },
      approvalGraph: buildRuntimeGraph(),
    } as never)).rejects.toMatchObject({
      message: 'formSchema.fields[1].visibilityRule.fieldId must reference an existing field',
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    })
    expect(pgState.pool.connect).not.toHaveBeenCalled()

    await expect(service.createTemplate({
      key: 'self-rule',
      name: 'Self Rule',
      formSchema: {
        fields: [
          {
            id: 'details',
            type: 'textarea',
            label: 'Details',
            visibilityRule: {
              fieldId: 'details',
              operator: 'isEmpty',
            },
          },
        ],
      },
      approvalGraph: buildRuntimeGraph(),
    } as never)).rejects.toMatchObject({
      message: 'formSchema.fields[0].visibilityRule cannot reference itself',
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    })
    expect(pgState.pool.connect).not.toHaveBeenCalled()
  })

  it('records terminal metrics for approvals auto-approved at creation', async () => {
    const metrics = {
      recordInstanceStart: vi.fn().mockResolvedValue(undefined),
      recordTerminal: vi.fn().mockResolvedValue(undefined),
      recordNodeActivation: vi.fn().mockResolvedValue(undefined),
      recordNodeDecision: vi.fn().mockResolvedValue(undefined),
      checkSlaBreaches: vi.fn().mockResolvedValue([]),
      getMetricsSummary: vi.fn(),
      getInstanceMetrics: vi.fn(),
      listActiveBreaches: vi.fn(),
    }
    const autoApprovedGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [], emptyAssigneePolicy: 'auto-approve' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    pgState.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
        return {
          rows: [{
            id: 'tpl-1',
            key: 'auto',
            name: 'Auto Approval',
            description: null,
            category: null,
            visibility_scope: { type: 'all', ids: [] },
            sla_hours: 4,
            status: 'published',
            active_version_id: 'ver-1',
            latest_version_id: 'ver-1',
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return {
          rows: [{
            id: 'ver-1',
            template_id: 'tpl-1',
            version: 1,
            status: 'published',
            form_schema: { fields: [] },
            approval_graph: autoApprovedGraph,
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: autoApprovedGraph,
            is_active: true,
            published_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith(`SELECT 'AP-' || nextval('approval_request_no_seq')::text AS request_no`)) {
        return { rows: [{ request_no: 'AP-100999' }], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return { rows: [buildInstanceRow({ status: 'approved', current_node_key: null })], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`Unhandled pool query: ${statement}`)
    })

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_assignments')) {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unhandled client query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(metrics as never)

    await service.createApproval(
      { templateId: 'tpl-1', formData: {} },
      { userId: 'user-1', tenantId: 'tenant-a' },
    )

    await vi.waitFor(() => {
      expect(metrics.recordInstanceStart).toHaveBeenCalledWith(expect.objectContaining({
        templateId: 'tpl-1',
        tenantId: 'tenant-a',
        slaHours: 4,
        initialNodeKey: null,
      }))
      expect(metrics.recordTerminal).toHaveBeenCalledWith(expect.objectContaining({
        terminalState: 'approved',
      }))
    })
  })

  it('creates new approvals from the currently active published definition', async () => {
    const runtimeGraph = buildRuntimeGraph()

    pgState.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
        return {
          rows: [{
            id: 'tpl-1',
            key: 'travel',
            name: 'Travel Approval',
            description: null,
            category: null,
            visibility_scope: { type: 'all', ids: [] },
            sla_hours: null,
            status: 'published',
            active_version_id: 'ver-2',
            latest_version_id: 'ver-2',
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return {
          rows: [{
            id: 'ver-2',
            template_id: 'tpl-1',
            version: 2,
            status: 'published',
            form_schema: { fields: [] },
            approval_graph: runtimeGraph,
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return {
          rows: [{
            id: 'pub-2',
            template_id: 'tpl-1',
            template_version_id: 'ver-2',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith(`SELECT 'AP-' || nextval('approval_request_no_seq')::text AS request_no`)) {
        return { rows: [{ request_no: 'AP-101001' }], rowCount: 1 }
      }
      throw new Error(`Unhandled pool query: ${statement}`)
    })

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) {
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

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      templateVersionId: 'ver-2',
      publishedDefinitionId: 'pub-2',
    }))

    await service.createApproval(
      { templateId: 'tpl-1', formData: {} },
      { userId: 'requester-1' },
    )

    const versionSelect = pgState.pool.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('SELECT * FROM approval_template_versions WHERE id = $1'))
    expect(versionSelect?.[1]).toEqual(['ver-2', 'tpl-1'])

    const insertInstance = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_instances'))
    expect(insertInstance?.[1]?.[11]).toBe('ver-2')
    expect(insertInstance?.[1]?.[12]).toBe('pub-2')
  })

  it('auto-approves requester-owned initial nodes from the runtime policy snapshot', async () => {
    const runtimeGraph = buildRuntimeGraph({
      autoApproval: {
        mergeWithRequester: true,
      },
    })

    pgState.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
        return {
          rows: [{
            id: 'tpl-1',
            key: 'travel',
            name: 'Travel Approval',
            description: null,
            category: null,
            visibility_scope: { type: 'all', ids: [] },
            sla_hours: null,
            status: 'published',
            active_version_id: 'ver-1',
            latest_version_id: 'ver-1',
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return {
          rows: [{
            id: 'ver-1',
            template_id: 'tpl-1',
            version: 1,
            status: 'published',
            form_schema: { fields: [] },
            approval_graph: runtimeGraph,
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith(`SELECT 'AP-' || nextval('approval_request_no_seq')::text AS request_no`)) {
        return { rows: [{ request_no: 'AP-101002' }], rowCount: 1 }
      }
      throw new Error(`Unhandled pool query: ${statement}`)
    })

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) {
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

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      status: 'approved',
      currentStep: 1,
      currentNodeKey: null,
      assignments: [],
    }))

    await service.createApproval(
      { templateId: 'tpl-1', formData: {} },
      { userId: 'manager-1' },
    )

    expect(pgState.client.query.mock.calls.some(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))).toBe(false)
    const insertInstance = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_instances'))
    expect(insertInstance?.[1]?.[1]).toBe('approved')
    expect(insertInstance?.[1]?.[15]).toBeNull()

    const autoRecordCall = pgState.client.query.mock.calls.find(([sql, params]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records') &&
      JSON.parse(String(params?.[9])).reason === 'auto-merge-requester')
    expect(autoRecordCall?.[1]?.[2]).toBe('system:auto-approval')
    expect(JSON.parse(String(autoRecordCall?.[1]?.[9]))).toMatchObject({
      nodeKey: 'approval_1',
      autoApproved: true,
      reason: 'auto-merge-requester',
      policySource: 'template',
      originalApprover: {
        type: 'user',
        id: 'manager-1',
      },
      actorMode: 'system',
    })
  })

  it('lets node auto-approval override disable an enabled template policy', async () => {
    const runtimeGraph = {
      ...buildRuntimeGraph({
        autoApproval: {
          mergeWithRequester: true,
        },
      }),
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: ['manager-1'],
            autoApprovalPolicy: { mergeWithRequester: false },
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
    }

    pgState.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
        return {
          rows: [{
            id: 'tpl-1',
            key: 'travel',
            name: 'Travel Approval',
            description: null,
            category: null,
            visibility_scope: { type: 'all', ids: [] },
            sla_hours: null,
            status: 'published',
            active_version_id: 'ver-1',
            latest_version_id: 'ver-1',
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return {
          rows: [{
            id: 'ver-1',
            template_id: 'tpl-1',
            version: 1,
            status: 'published',
            form_schema: { fields: [] },
            approval_graph: runtimeGraph,
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith(`SELECT 'AP-' || nextval('approval_request_no_seq')::text AS request_no`)) {
        return { rows: [{ request_no: 'AP-101003' }], rowCount: 1 }
      }
      throw new Error(`Unhandled pool query: ${statement}`)
    })

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) {
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

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      currentNodeKey: 'approval_1',
      assignments: [{
        id: 'asg-manager-1',
        type: 'user',
        assigneeId: 'manager-1',
        sourceStep: 1,
        nodeKey: 'approval_1',
        isActive: true,
        metadata: {},
      }],
    }))

    await service.createApproval(
      { templateId: 'tpl-1', formData: {} },
      { userId: 'manager-1' },
    )

    expect(pgState.client.query.mock.calls.some(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))).toBe(true)
    expect(pgState.client.query.mock.calls.some(([sql, params]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records') &&
      JSON.parse(String(params?.[9])).reason === 'auto-merge-requester')).toBe(false)
  })

  it('lets node auto-approval override enable a disabled template policy', async () => {
    const runtimeGraph = {
      ...buildRuntimeGraph(),
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: ['manager-1'],
            autoApprovalPolicy: { mergeWithRequester: true },
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
    }

    pgState.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
        return {
          rows: [{
            id: 'tpl-1',
            key: 'travel',
            name: 'Travel Approval',
            description: null,
            category: null,
            visibility_scope: { type: 'all', ids: [] },
            sla_hours: null,
            status: 'published',
            active_version_id: 'ver-1',
            latest_version_id: 'ver-1',
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return {
          rows: [{
            id: 'ver-1',
            template_id: 'tpl-1',
            version: 1,
            status: 'published',
            form_schema: { fields: [] },
            approval_graph: runtimeGraph,
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith(`SELECT 'AP-' || nextval('approval_request_no_seq')::text AS request_no`)) {
        return { rows: [{ request_no: 'AP-101004' }], rowCount: 1 }
      }
      throw new Error(`Unhandled pool query: ${statement}`)
    })

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) {
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

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      status: 'approved',
      currentNodeKey: null,
      assignments: [],
    }))

    await service.createApproval(
      { templateId: 'tpl-1', formData: {} },
      { userId: 'manager-1' },
    )

    const autoRecordCall = pgState.client.query.mock.calls.find(([sql, params]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records') &&
      JSON.parse(String(params?.[9])).reason === 'auto-merge-requester')
    expect(JSON.parse(String(autoRecordCall?.[1]?.[9]))).toMatchObject({
      policySource: 'node',
      originalApprover: {
        type: 'user',
        id: 'manager-1',
      },
    })
  })

  it('auto-approves adjacent same-user chains transitively after a human approval', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'approval_c', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-a', source: 'start', target: 'approval_a' },
        { key: 'edge-a-b', source: 'approval_a', target: 'approval_b' },
        { key: 'edge-b-c', source: 'approval_b', target: 'approval_c' },
        { key: 'edge-c-end', source: 'approval_c', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
        autoApproval: {
          mergeAdjacentApprover: true,
        },
      },
    }

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return {
          rows: [buildInstanceRow({
            current_node_key: 'approval_a',
            current_step: 1,
            total_steps: 3,
          })],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
        return {
          rows: [{
            id: 'pub-1',
            template_id: 'tpl-1',
            template_version_id: 'ver-1',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1')) {
        return {
          rows: [{
            id: 'asg-a',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'manager-1',
            source_step: 1,
            node_key: 'approval_a',
            is_active: true,
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT id, actor_id, metadata FROM approval_records')) {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_instances SET status = $2')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_assignments')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      status: 'approved',
      currentStep: 3,
      totalSteps: 3,
      currentNodeKey: null,
      assignments: [],
    }))

    const result = await service.dispatchAction(
      'apr-1',
      { action: 'approve' },
      { userId: 'manager-1' },
    )

    expect(result.status).toBe('approved')
    expect(pgState.client.query.mock.calls.some(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))).toBe(false)
    const updateCall = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('UPDATE approval_instances SET status = $2'))
    expect(updateCall?.[1]).toEqual(['apr-1', 'approved', 3, null, 3, 3])

    const autoRecords = pgState.client.query.mock.calls
      .filter(([sql, params]) =>
        normalize(sql as string).startsWith('INSERT INTO approval_records') &&
        JSON.parse(String(params?.[9])).reason === 'auto-merge-adjacent')
      .map(([, params]) => JSON.parse(String(params?.[9])))

    expect(autoRecords).toHaveLength(2)
    expect(autoRecords[0]).toMatchObject({
      nodeKey: 'approval_b',
      reason: 'auto-merge-adjacent',
      matchedAgainst: { nodeKey: 'approval_a' },
    })
    expect(autoRecords[1]).toMatchObject({
      nodeKey: 'approval_c',
      reason: 'auto-merge-adjacent',
      matchedAgainst: { nodeKey: 'approval_b' },
    })
  })

  it('advances existing approvals from the instance-bound stale published definition and form snapshot', async () => {
    const frozenRuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        {
          key: 'legacy_condition',
          type: 'condition',
          config: {
            branches: [{
              edgeKey: 'edge-condition-old-high',
              rules: [{ fieldId: 'legacyAmount', operator: 'gt', value: 100 }],
            }],
            defaultEdgeKey: 'edge-condition-old-low',
          },
        },
        { key: 'approval_old_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['legacy-manager'] } },
        { key: 'approval_old_low', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['fallback-manager'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-condition', source: 'approval_1', target: 'legacy_condition' },
        { key: 'edge-condition-old-high', source: 'legacy_condition', target: 'approval_old_high' },
        { key: 'edge-condition-old-low', source: 'legacy_condition', target: 'approval_old_low' },
        { key: 'edge-old-high-end', source: 'approval_old_high', target: 'end' },
        { key: 'edge-old-low-end', source: 'approval_old_low', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return {
          rows: [buildInstanceRow({
            template_version_id: 'ver-old',
            published_definition_id: 'pub-old',
            form_snapshot: { legacyAmount: 250 },
            current_step: 1,
            total_steps: 3,
            current_node_key: 'approval_1',
          })],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
        expect(params).toEqual(['pub-old'])
        return {
          rows: [{
            id: 'pub-old',
            template_id: 'tpl-1',
            template_version_id: 'ver-old',
            runtime_graph: frozenRuntimeGraph,
            is_active: false,
            published_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_assignments WHERE instance_id = $1')) {
        return {
          rows: [{
            id: 'asg-manager-1',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'manager-1',
            source_step: 1,
            node_key: 'approval_1',
            is_active: true,
            metadata: {},
            created_at: new Date('2026-04-11T00:00:00.000Z'),
            updated_at: new Date('2026-04-11T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_instances SET status = $2')) {
        expect(params).toEqual(['apr-1', 'pending', 3, 'approval_old_high', 2, 3])
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_assignments')) {
        expect(params).toEqual(['apr-1', 'user', 'legacy-manager', 2, 'approval_old_high'])
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      templateVersionId: 'ver-old',
      publishedDefinitionId: 'pub-old',
      formSnapshot: { legacyAmount: 250 },
      currentStep: 2,
      totalSteps: 3,
      currentNodeKey: 'approval_old_high',
      assignments: [{
        id: 'asg-legacy',
        type: 'user',
        assigneeId: 'legacy-manager',
        sourceStep: 2,
        nodeKey: 'approval_old_high',
        isActive: true,
        metadata: {},
      }],
    }))

    const result = await service.dispatchAction(
      'apr-1',
      { action: 'approve', comment: 'use frozen runtime' },
      { userId: 'manager-1' },
    )

    expect(result.templateVersionId).toBe('ver-old')
    expect(result.publishedDefinitionId).toBe('pub-old')
    expect(result.currentNodeKey).toBe('approval_old_high')

    const statements = [
      ...pgState.client.query.mock.calls,
      ...pgState.pool.query.mock.calls,
    ].map(([sql]) => normalize(sql as string))
    expect(statements.some((statement) => statement.includes('approval_templates'))).toBe(false)
    expect(statements.some((statement) => statement.includes('active_version_id'))).toBe(false)

    const recordCall = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records'))
    expect(JSON.parse(String(recordCall?.[1]?.[9]))).toMatchObject({
      nodeKey: 'approval_1',
      nextNodeKey: 'approval_old_high',
      aggregateComplete: true,
    })
  })

  it('allows template version delete/archive checks when no unfinished instance references remain', async () => {
    pgState.pool.query.mockResolvedValue({
      rows: [{ unfinished_count: '0', sample_instance_id: null }],
      rowCount: 1,
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await expect(service.assertTemplateVersionDeletable('ver-archive-safe')).resolves.toBeUndefined()

    const statement = normalize(pgState.pool.query.mock.calls[0]?.[0] as string)
    expect(statement).toContain('status <> ALL($2::text[])')
    expect(statement).toContain('published_definition_id IN')
    expect(pgState.pool.query.mock.calls[0]?.[1]).toEqual([
      'ver-archive-safe',
      ['approved', 'rejected', 'revoked', 'cancelled'],
    ])
  })

  it('blocks template version delete/archive checks with unfinished count and sample id', async () => {
    pgState.pool.query.mockResolvedValue({
      rows: [{ unfinished_count: '2', sample_instance_id: 'apr-pending-1' }],
      rowCount: 1,
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await expect(service.assertTemplateVersionDeletable('ver-in-use')).rejects.toMatchObject({
      message: expect.stringContaining('2 unfinished approval instance(s)'),
      statusCode: 409,
      code: 'APPROVAL_TEMPLATE_VERSION_IN_USE',
      details: {
        unfinishedCount: 2,
        sampleInstanceId: 'apr-pending-1',
      },
    })
    await expect(service.assertTemplateVersionDeletable('ver-in-use')).rejects.toThrow('apr-pending-1')
  })

  it('serializes publish with a template row lock and template-scoped active definition swap', async () => {
    const runtimeGraph = buildRuntimeGraph()
    const template = {
      id: 'tpl-1',
      key: 'travel',
      name: 'Travel Approval',
      description: null,
      category: null,
      visibility_scope: { type: 'all', ids: [] },
      sla_hours: null,
      status: 'draft',
      active_version_id: 'ver-1',
      latest_version_id: 'ver-2',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const version = {
      id: 'ver-2',
      template_id: 'tpl-1',
      version: 2,
      status: 'draft',
      form_schema: { fields: [] },
      approval_graph: runtimeGraph,
      created_at: new Date(),
      updated_at: new Date(),
    }

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) {
        return { rows: [template], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return { rows: [version], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_published_definitions')) {
        return {
          rows: [{
            id: 'pub-2',
            template_id: 'tpl-1',
            template_version_id: 'ver-2',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith("UPDATE approval_template_versions SET status = 'published'")) {
        return { rows: [{ ...version, status: 'published' }], rowCount: 1 }
      }
      if (statement.startsWith("UPDATE approval_templates SET status = 'published'")) {
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    const result = await service.publishTemplate('tpl-1', { policy: { allowRevoke: true } } as never)

    expect(result.publishedDefinitionId).toBe('pub-2')
    const statements = pgState.client.query.mock.calls.map(([sql]) => normalize(sql as string))
    const lockIndex = statements.findIndex((statement) =>
      statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE'))
    const deactivateIndex = statements.findIndex((statement) =>
      statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE'))
    const insertIndex = statements.findIndex((statement) =>
      statement.startsWith('INSERT INTO approval_published_definitions'))
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(deactivateIndex).toBeGreaterThan(lockIndex)
    expect(insertIndex).toBeGreaterThan(deactivateIndex)
    expect(statements.filter((statement) => statement === 'COMMIT')).toHaveLength(1)
  })

  it('keeps only one active published definition across concurrent publish calls', async () => {
    const runtimeGraph = buildRuntimeGraph()
    const template = {
      id: 'tpl-1',
      key: 'travel',
      name: 'Travel Approval',
      description: null,
      category: null,
      visibility_scope: { type: 'all', ids: [] },
      sla_hours: null,
      status: 'draft',
      active_version_id: 'ver-1',
      latest_version_id: 'ver-2',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const version = {
      id: 'ver-2',
      template_id: 'tpl-1',
      version: 2,
      status: 'draft',
      form_schema: { fields: [] },
      approval_graph: runtimeGraph,
      created_at: new Date(),
      updated_at: new Date(),
    }
    const publishedDefinitions = [
      {
        id: 'pub-1',
        template_id: 'tpl-1',
        template_version_id: 'ver-1',
        runtime_graph: runtimeGraph,
        is_active: true,
        published_at: new Date(),
      },
    ]
    let publishSequence = 1
    let lockTail = Promise.resolve()
    let releaseCurrentLock: (() => void) | null = null

    async function acquireTemplateLock(): Promise<void> {
      const previous = lockTail
      let release!: () => void
      lockTail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      releaseCurrentLock = release
    }

    function releaseTemplateLock(): void {
      releaseCurrentLock?.()
      releaseCurrentLock = null
    }

    function buildClient() {
      const client = {
        query: vi.fn(),
        release: vi.fn(),
      }
      client.query.mockImplementation(async (sql: string) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN') {
          return { rows: [], rowCount: 0 }
        }
        if (statement === 'COMMIT' || statement === 'ROLLBACK') {
          releaseTemplateLock()
          return { rows: [], rowCount: 0 }
        }
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) {
          await acquireTemplateLock()
          return { rows: [template], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
          return { rows: [version], rowCount: 1 }
        }
        if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) {
          for (const definition of publishedDefinitions) {
            if (definition.template_id === 'tpl-1') {
              definition.is_active = false
            }
          }
          return { rows: [], rowCount: publishedDefinitions.length }
        }
        if (statement.startsWith('INSERT INTO approval_published_definitions')) {
          publishSequence += 1
          const definition = {
            id: `pub-${publishSequence}`,
            template_id: 'tpl-1',
            template_version_id: 'ver-2',
            runtime_graph: runtimeGraph,
            is_active: true,
            published_at: new Date(),
          }
          publishedDefinitions.push(definition)
          return { rows: [definition], rowCount: 1 }
        }
        if (statement.startsWith("UPDATE approval_template_versions SET status = 'published'")) {
          return { rows: [{ ...version, status: 'published' }], rowCount: 1 }
        }
        if (statement.startsWith("UPDATE approval_templates SET status = 'published'")) {
          template.status = 'published'
          template.active_version_id = 'ver-2'
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled query: ${statement}`)
      })
      return client
    }

    const clientA = buildClient()
    const clientB = buildClient()
    pgState.pool.connect
      .mockResolvedValueOnce(clientA)
      .mockResolvedValueOnce(clientB)

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await Promise.all([
      service.publishTemplate('tpl-1', { policy: { allowRevoke: true } } as never),
      service.publishTemplate('tpl-1', { policy: { allowRevoke: true } } as never),
    ])

    expect(publishedDefinitions.filter((definition) => definition.is_active)).toHaveLength(1)
    expect(publishedDefinitions.at(-1)).toMatchObject({
      template_version_id: 'ver-2',
      is_active: true,
    })
    expect(clientA.release).toHaveBeenCalledTimes(1)
    expect(clientB.release).toHaveBeenCalledTimes(1)
  })

  it('rolls back publish when the active definition insert fails', async () => {
    const runtimeGraph = buildRuntimeGraph()
    const template = {
      id: 'tpl-1',
      key: 'travel',
      name: 'Travel Approval',
      description: null,
      category: null,
      visibility_scope: { type: 'all', ids: [] },
      sla_hours: null,
      status: 'draft',
      active_version_id: 'ver-1',
      latest_version_id: 'ver-2',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const version = {
      id: 'ver-2',
      template_id: 'tpl-1',
      version: 2,
      status: 'draft',
      form_schema: { fields: [] },
      approval_graph: runtimeGraph,
      created_at: new Date(),
      updated_at: new Date(),
    }

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) {
        return { rows: [template], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return { rows: [version], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_published_definitions')) {
        throw new Error('insert failed')
      }
      throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await expect(service.publishTemplate('tpl-1', { policy: { allowRevoke: true } } as never))
      .rejects.toThrow('insert failed')

    const statements = pgState.client.query.mock.calls.map(([sql]) => normalize(sql as string))
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(statements.some((statement) =>
      statement.startsWith("UPDATE approval_templates SET status = 'published'"))).toBe(false)
    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })
})
