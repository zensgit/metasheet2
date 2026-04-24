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
  })
})
