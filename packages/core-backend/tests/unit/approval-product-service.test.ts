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

  it('rejects return actions until pack 1A runtime semantics are implemented', async () => {
    const runtimeGraph = buildRuntimeGraph()

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
            version: 4,
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

    await expect(service.dispatchAction(
      'apr-1',
      { action: 'return', targetNodeKey: 'approval_1' },
      { userId: 'user-1' },
    )).rejects.toMatchObject({
      message: 'Return action is not implemented yet',
      statusCode: 409,
      code: 'APPROVAL_ACTION_NOT_SUPPORTED',
    })

    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })
})
