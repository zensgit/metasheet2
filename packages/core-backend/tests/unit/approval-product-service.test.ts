import { beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import { formulaReferencesRequesterAttribute } from '../../src/services/ApprovalConditionFormula'

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

const completionEventState = vi.hoisted(() => ({
  emitApprovalCompletionEvent: vi.fn(),
}))

const orgRelationsState = vi.hoisted(() => ({
  // Default returns {} so existing createApproval tests behave exactly as before
  // (when the real resolver threw on the un-stubbed pool and the error was swallowed).
  resolveApprovalRequesterOrgRelations: vi.fn(async () => ({})),
}))

const roleResolverState = vi.hoisted(() => ({
  // Default returns [] — only role-routed graphs invoke it, so existing tests are unaffected.
  resolveApprovalRequesterRoleIds: vi.fn(async () => [] as string[]),
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

vi.mock('../../src/services/ApprovalCompletionEvent', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/ApprovalCompletionEvent')>(
    '../../src/services/ApprovalCompletionEvent',
  )

  return {
    ...actual,
    emitApprovalCompletionEvent: completionEventState.emitApprovalCompletionEvent,
  }
})

vi.mock('../../src/services/ApprovalDirectoryOrg', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/ApprovalDirectoryOrg')>(
    '../../src/services/ApprovalDirectoryOrg',
  )

  return {
    ...actual,
    resolveApprovalRequesterOrgRelations: orgRelationsState.resolveApprovalRequesterOrgRelations,
  }
})

vi.mock('../../src/services/ApprovalRequesterRoles', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/ApprovalRequesterRoles')>(
    '../../src/services/ApprovalRequesterRoles',
  )

  return {
    ...actual,
    resolveApprovalRequesterRoleIds: roleResolverState.resolveApprovalRequesterRoleIds,
  }
})

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

function mockPublishedTemplatePool(
  runtimeGraph: Record<string, unknown>,
  requestNo = 'AP-101100',
  formSchema: Record<string, unknown> = { fields: [] },
) {
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
          form_schema: formSchema,
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
      return { rows: [{ request_no: requestNo }], rowCount: 1 }
    }
    throw new Error(`Unhandled pool query: ${statement}`)
  })
}

function mockInsertOnlyClient() {
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
    { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
  })
}

// nodeEntryEpoch (2026-07-03): the per-test mock routers predate the epoch columns, but the two
// epoch queries flow through EVERY create/approve/return/mutation path. Answer them uniformly here
// (checked right before each router's "Unhandled" throw) so no router needs to enumerate them:
//   - the activation-seq bump returns a stable value callers only thread onward as the epoch;
//   - currentNodeEntryEpoch returns a single NULL row, which keeps mock instances on the legacy
//     cutoff fallback (§6) so every pre-existing round-scoping / metadata assertion is unaffected.
function epochMockResult(statement: string): { rows: unknown[]; rowCount: number } | null {
  if (statement.startsWith('UPDATE approval_instances SET node_activation_seq = node_activation_seq + 1')) {
    return { rows: [{ node_activation_seq: 1 }], rowCount: 1 }
  }
  if (statement.startsWith('SELECT DISTINCT entry_epoch FROM approval_assignments')) {
    return { rows: [{ entry_epoch: null }], rowCount: 1 }
  }
  return null
}

describe('ApprovalProductService', () => {
  beforeEach(() => {
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
    completionEventState.emitApprovalCompletionEvent.mockReset()
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockReset()
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockResolvedValue({})
    roleResolverState.resolveApprovalRequesterRoleIds.mockReset()
    roleResolverState.resolveApprovalRequesterRoleIds.mockResolvedValue([])
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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

  it('locks the instance row with FOR UPDATE during dispatch (concurrency invariant)', async () => {
    // Guards the dispatch serialization invariant: concurrent actions on one
    // instance — including two approvers acting on two parallel branches at
    // once — are serialized by a row lock on approval_instances, NOT by
    // optimistic retry. A refactor that drops `FOR UPDATE` would silently
    // reintroduce a lost-update on the JSONB parallelBranchStates
    // read-modify-write. This pins the SELECT shape so that regression fails CI.
    // (True two-session race coverage is an integration test requiring a real
    // Postgres; tracked separately as a DB-harness follow-up.)
    const runtimeGraph = buildRuntimeGraph()
    const captured: string[] = []

    pgState.client.query.mockImplementation(async (sql: string) => {
      captured.push(sql)
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return { rows: [buildInstanceRow()], rowCount: 1 }
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
      if (statement.startsWith('SELECT COUNT(*)::text AS count')) {
        return { rows: [{ count: '0' }], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith("UPDATE approval_instances SET status = 'revoked'")) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      status: 'revoked',
      currentNodeKey: null,
      assignments: [],
    }))

    await service.dispatchAction('apr-1', { action: 'revoke', comment: 'cancel' }, { userId: 'user-1' })

    const instanceSelect = captured.find((sql) =>
      /SELECT \* FROM approval_instances WHERE id = \$1/.test(sql))
    expect(instanceSelect, 'dispatch must SELECT the instance row').toBeDefined()
    expect(instanceSelect).toMatch(/FOR UPDATE/)
  })

  it('emits a completion event when the requester revokes an approval', async () => {
    const runtimeGraph = buildRuntimeGraph()

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return { rows: [buildInstanceRow()], rowCount: 1 }
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
      if (statement.startsWith('SELECT COUNT(*)::text AS count')) {
        return { rows: [{ count: '0' }], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith("UPDATE approval_instances SET status = 'revoked'")) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      status: 'revoked',
      currentNodeKey: null,
      assignments: [],
    }))

    const result = await service.dispatchAction(
      'apr-1',
      { action: 'revoke', comment: 'cancel request' },
      { userId: 'user-1' },
    )

    expect(result.status).toBe('revoked')
    expect(completionEventState.emitApprovalCompletionEvent).toHaveBeenCalledTimes(1)
    expect(completionEventState.emitApprovalCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'approval.revoked',
      transition: expect.objectContaining({
        action: 'revoke',
        fromStatus: 'pending',
        toStatus: 'revoked',
        fromVersion: 2,
        toVersion: 3,
        nodeKey: 'approval_1',
      }),
      actor: { id: 'user-1', name: 'user-1' },
      requester: { id: 'user-1' },
    }))
  })

  it('emits a completion event when an approver rejects an approval', async () => {
    const runtimeGraph = buildRuntimeGraph()

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return { rows: [buildInstanceRow()], rowCount: 1 }
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
      if (statement.startsWith("UPDATE approval_instances SET status = 'rejected'")) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      status: 'rejected',
      currentNodeKey: null,
      assignments: [],
    }))

    const result = await service.dispatchAction(
      'apr-1',
      { action: 'reject', comment: 'insufficient evidence' },
      { userId: 'manager-1', userName: 'Manager One' },
    )

    expect(result.status).toBe('rejected')
    expect(completionEventState.emitApprovalCompletionEvent).toHaveBeenCalledTimes(1)
    expect(completionEventState.emitApprovalCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'approval.rejected',
      transition: expect.objectContaining({
        action: 'reject',
        fromStatus: 'pending',
        toStatus: 'rejected',
        fromVersion: 2,
        toVersion: 3,
        nodeKey: 'approval_1',
      }),
      actor: { id: 'manager-1', name: 'Manager One' },
      requester: { id: 'user-1' },
    }))
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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
      if (statement.startsWith('UPDATE approval_instances SET metadata = COALESCE')) {
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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
    expect(completionEventState.emitApprovalCompletionEvent).not.toHaveBeenCalled()
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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
    expect(completionEventState.emitApprovalCompletionEvent).not.toHaveBeenCalled()
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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

  describe('detail / sub-form (明细) field contract (C-1 author-time validation)', () => {
    // assertFormSchema runs BEFORE pool.connect(), so reject cases throw without any query mock.
    const wrap = (field: Record<string, unknown>, extra: Record<string, unknown>[] = []) => ({
      key: 'detail-tpl',
      name: 'Detail Tpl',
      visibilityScope: { type: 'all', ids: [] },
      formSchema: { fields: [field, ...extra] },
      approvalGraph: buildRuntimeGraph(),
    })
    const create = async (request: unknown) => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      return new ApprovalProductService().createTemplate(request as never)
    }

    it('rejects a detail field with empty columns', async () => {
      await expect(create(wrap({ id: 'items', type: 'detail', label: '明细', columns: [] })))
        .rejects.toThrow(/columns must be a non-empty array/)
    })

    it('rejects a detail nested inside a detail (one level only)', async () => {
      await expect(create(wrap({
        id: 'items', type: 'detail', label: '明细',
        columns: [{ id: 'sub', type: 'detail', label: 'sub', columns: [{ id: 'x', type: 'text', label: 'x' }] }],
      }))).rejects.toThrow(/detail cannot be nested inside a detail group/)
    })

    it('rejects attachment fields inside detail rows (attachment v1 is top-level only)', async () => {
      const previous = process.env.APPROVAL_ATTACHMENTS_ENABLED
      process.env.APPROVAL_ATTACHMENTS_ENABLED = 'true'
      try {
        await expect(create(wrap({
          id: 'items', type: 'detail', label: '明细',
          columns: [{ id: 'proof', type: 'attachment', label: '附件' }],
        }))).rejects.toThrow(/attachment fields are not allowed inside detail groups/)
      } finally {
        if (previous === undefined) delete process.env.APPROVAL_ATTACHMENTS_ENABLED
        else process.env.APPROVAL_ATTACHMENTS_ENABLED = previous
      }
    })

    it('rejects an unknown sub-field type', async () => {
      await expect(create(wrap({
        id: 'items', type: 'detail', label: '明细', columns: [{ id: 'x', type: 'bogus', label: 'x' }],
      }))).rejects.toThrow(/type is invalid/)
    })

    it('rejects duplicate sub-field ids within a group', async () => {
      await expect(create(wrap({
        id: 'items', type: 'detail', label: '明细',
        columns: [{ id: 'x', type: 'text', label: 'x' }, { id: 'x', type: 'number', label: 'x2' }],
      }))).rejects.toThrow(/ids must be unique within the detail group/)
    })

    it('rejects minRows > maxRows', async () => {
      await expect(create(wrap({
        id: 'items', type: 'detail', label: '明细', minRows: 5, maxRows: 2,
        columns: [{ id: 'x', type: 'text', label: 'x' }],
      }))).rejects.toThrow(/minRows must be <= maxRows/)
    })

    it('rejects a negative row bound', async () => {
      await expect(create(wrap({
        id: 'items', type: 'detail', label: '明细', minRows: -1,
        columns: [{ id: 'x', type: 'text', label: 'x' }],
      }))).rejects.toThrow(/minRows must be a non-negative integer/)
    })

    it('rejects detail-only keys (columns) on a non-detail field', async () => {
      await expect(create(wrap({ id: 'x', type: 'text', label: 'x', columns: [{ id: 'y', type: 'text', label: 'y' }] })))
        .rejects.toThrow(/only valid on a detail field/)
    })

    it('rejects a top-level visibilityRule targeting a detail field', async () => {
      await expect(create(wrap(
        { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'product', type: 'text', label: '品名' }] },
        [{ id: 'note', type: 'text', label: 'note', visibilityRule: { fieldId: 'items', operator: 'notEmpty' } }],
      ))).rejects.toThrow(/cannot reference a detail field/)
    })

    it('rejects a sub-field visibilityRule referencing a top-level (cross-scope) field', async () => {
      await expect(create(wrap({
        id: 'items', type: 'detail', label: '明细',
        columns: [
          { id: 'product', type: 'text', label: '品名' },
          { id: 'note', type: 'text', label: 'note', visibilityRule: { fieldId: 'topLevelOnly', operator: 'notEmpty' } },
        ],
      }))).rejects.toThrow(/must reference an existing field/)
    })

    it('rejects a form_field_user assignee source pointing at a detail sub-field (sources stay top-level)', async () => {
      // `approver` is a user-typed SUB-FIELD of `items`, not a top-level field — the assignee
      // validator resolves form_field_user.fieldId against top-level fields only, so it rejects.
      const request = {
        key: 'detail-assignee',
        name: 'Detail Assignee',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: { fields: [{ id: 'items', type: 'detail', label: '明细', columns: [{ id: 'approver', type: 'user', label: '审批人' }] }] },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            { key: 'approval_1', type: 'approval', config: { assigneeSources: [{ kind: 'form_field_user', fieldId: 'approver' }] } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
            { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
          ],
          policy: { allowRevoke: true },
        },
      }
      await expect(create(request)).rejects.toThrow(/must reference a user field/)
    })

    it('accepts a valid detail and round-trips columns / minRows / maxRows + a sibling sub-field rule', async () => {
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const s = normalize(sql)
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (s.startsWith('INSERT INTO approval_templates')) {
          return { rows: [{ id: 'tpl-d', key: String(params?.[0]), name: String(params?.[1]), description: null, category: null, visibility_scope: JSON.parse(String(params?.[4])), sla_hours: null, status: 'draft', active_version_id: null, latest_version_id: null, created_at: new Date('2026-04-11T00:00:00.000Z'), updated_at: new Date('2026-04-11T00:00:00.000Z') }], rowCount: 1 }
        }
        if (s.startsWith('INSERT INTO approval_template_versions')) {
          return { rows: [{ id: 'ver-d', template_id: 'tpl-d', version: 1, status: 'draft', form_schema: JSON.parse(String(params?.[1])), approval_graph: JSON.parse(String(params?.[2])), created_at: new Date('2026-04-11T00:00:00.000Z'), updated_at: new Date('2026-04-11T00:00:00.000Z') }], rowCount: 1 }
        }
        if (s.startsWith('UPDATE approval_templates')) {
          return { rows: [{ id: 'tpl-d', key: 'detail-tpl', name: 'Detail Tpl', description: null, category: null, visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft', active_version_id: 'ver-d', latest_version_id: 'ver-d', created_at: new Date('2026-04-11T00:00:00.000Z'), updated_at: new Date('2026-04-11T00:00:00.000Z') }], rowCount: 1 }
        }
        throw new Error(`Unhandled query: ${s}`)
      })

      const result = await create(wrap({
        id: 'items', type: 'detail', label: '明细', required: true, minRows: 1, maxRows: 50,
        columns: [
          { id: 'product', type: 'text', label: '品名', required: true },
          { id: 'qty', type: 'number', label: '数量', required: true },
          { id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'product', operator: 'notEmpty' } },
        ],
      }))
      const field = result.formSchema.fields[0]
      expect(field.type).toBe('detail')
      expect(field.minRows).toBe(1)
      expect(field.maxRows).toBe(50)
      expect(field.columns?.map((column) => column.id)).toEqual(['product', 'qty', 'note'])
      expect(field.columns?.[2].visibilityRule).toEqual({ fieldId: 'product', operator: 'notEmpty' })
    })
  })

  describe('approval condition formula contract (FC-1)', () => {
    const formulaFormSchema = {
      fields: [
        { id: 'amount', type: 'number', label: 'Amount' },
        { id: 'items', type: 'detail', label: 'Items', columns: [{ id: 'amount', type: 'number', label: 'Line Amount' }] },
      ],
    }
    const formulaGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'edge-high', rules: [], formula: { expression: 'SUM({items.amount}) >= 20000' } }],
            defaultEdgeKey: 'edge-low',
          },
        },
        { key: 'high', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
        { key: 'low', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-high', source: 'route', target: 'high' },
        { key: 'edge-low', source: 'route', target: 'low' },
        { key: 'edge-high-end', source: 'high', target: 'end' },
        { key: 'edge-low-end', source: 'low', target: 'end' },
      ],
    }

    it('preserves formula branches through createTemplate normalization', async () => {
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (statement.startsWith('INSERT INTO approval_templates')) {
          return { rows: [{ id: 'tpl-formula', key: String(params?.[0]), name: String(params?.[1]), description: null, category: null, visibility_scope: JSON.parse(String(params?.[4])), sla_hours: null, status: 'draft', active_version_id: null, latest_version_id: null, created_at: new Date('2026-06-25T00:00:00.000Z'), updated_at: new Date('2026-06-25T00:00:00.000Z') }], rowCount: 1 }
        }
        if (statement.startsWith('INSERT INTO approval_template_versions')) {
          return { rows: [{ id: 'ver-formula', template_id: 'tpl-formula', version: 1, status: 'draft', form_schema: JSON.parse(String(params?.[1])), approval_graph: JSON.parse(String(params?.[2])), created_at: new Date('2026-06-25T00:00:00.000Z'), updated_at: new Date('2026-06-25T00:00:00.000Z') }], rowCount: 1 }
        }
        if (statement.startsWith('UPDATE approval_templates')) {
          return { rows: [{ id: 'tpl-formula', key: 'formula-template', name: 'Formula Template', description: null, category: null, visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft', active_version_id: null, latest_version_id: 'ver-formula', created_at: new Date('2026-06-25T00:00:00.000Z'), updated_at: new Date('2026-06-25T00:00:00.000Z') }], rowCount: 1 }
        }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
      })

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().createTemplate({
        key: 'formula-template',
        name: 'Formula Template',
        formSchema: formulaFormSchema,
        approvalGraph: formulaGraph,
      } as never)

      const condition = result.approvalGraph.nodes.find((node) => node.key === 'route')
      expect((condition?.config as { branches: Array<{ formula?: { expression: string } }> }).branches[0].formula)
        .toEqual({ expression: 'SUM({items.amount}) >= 20000' })
      const insertVersionCall = pgState.client.query.mock.calls.find(([sql]) =>
        normalize(sql as string).startsWith('INSERT INTO approval_template_versions'))
      const persistedGraph = JSON.parse(String(insertVersionCall?.[1]?.[2]))
      expect(persistedGraph.nodes[1].config.branches[0].formula).toEqual({ expression: 'SUM({items.amount}) >= 20000' })
    })

    it('rejects formula branches that mix rules or reference unknown fields before hitting the database', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate({
        key: 'formula-mix',
        name: 'Formula Mix',
        formSchema: formulaFormSchema,
        approvalGraph: {
          ...formulaGraph,
          nodes: formulaGraph.nodes.map((node) => node.key === 'route'
            ? {
                ...node,
                config: {
                  branches: [{
                    edgeKey: 'edge-high',
                    rules: [{ fieldId: 'amount', operator: 'gte', value: 20000 }],
                    formula: { expression: 'SUM({items.amount}) >= 20000' },
                  }],
                  defaultEdgeKey: 'edge-low',
                },
              }
            : node),
        },
      } as never)).rejects.toThrow(/cannot mix formula and rules/)

      await expect(service.createTemplate({
        key: 'formula-unknown',
        name: 'Formula Unknown',
        formSchema: formulaFormSchema,
        approvalGraph: {
          ...formulaGraph,
          nodes: formulaGraph.nodes.map((node) => node.key === 'route'
            ? {
                ...node,
                config: {
                  branches: [{ edgeKey: 'edge-high', rules: [], formula: { expression: '{ghost} == 1' } }],
                  defaultEdgeKey: 'edge-low',
                },
              }
            : node),
        },
      } as never)).rejects.toThrow(/unknown field reference/)
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects a literal-only formula branch before hitting the database', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().createTemplate({
        key: 'formula-static',
        name: 'Formula Static',
        formSchema: formulaFormSchema,
        approvalGraph: {
          ...formulaGraph,
          nodes: formulaGraph.nodes.map((node) => node.key === 'route'
            ? {
                ...node,
                config: {
                  branches: [{ edgeKey: 'edge-high', rules: [], formula: { expression: '1 == 1' } }],
                  defaultEdgeKey: 'edge-low',
                },
              }
            : node),
        },
      } as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'APPROVAL_CONDITION_FORMULA_STATIC',
        details: { branchIndex: 0 },
      })
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects a field-dependent formula proven true by the field bounds', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().createTemplate({
        key: 'formula-bound-tautology',
        name: 'Formula Bound Tautology',
        formSchema: {
          fields: [{ id: 'amount', type: 'number', label: 'Amount', required: true, props: { min: 0 } }],
        },
        approvalGraph: {
          ...formulaGraph,
          nodes: formulaGraph.nodes.map((node) => node.key === 'route'
            ? {
                ...node,
                config: {
                  branches: [{ edgeKey: 'edge-high', rules: [], formula: { expression: '{amount} >= -1' } }],
                  defaultEdgeKey: 'edge-low',
                },
              }
            : node),
        },
      } as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'APPROVAL_CONDITION_FORMULA_ALWAYS_TRUE',
        details: { branchIndex: 0 },
      })
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })
  })

  it('accepts authoring-MVP form-field-user assignee sources when creating a template', async () => {
    const request = {
      key: 'expense-authoring',
      name: 'Expense Authoring',
      description: 'Template emitted by the frontend authoring MVP',
      visibilityScope: { type: 'all', ids: [] },
      formSchema: {
        fields: [
          { id: 'amount', type: 'number', label: 'Amount', required: true },
          { id: 'reviewer', type: 'user', label: 'Reviewer', required: true },
        ],
      },
      approvalGraph: {
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
      },
    }

    pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_templates')) {
        return {
          rows: [{
            id: 'tpl-authoring',
            key: String(params?.[0]),
            name: String(params?.[1]),
            description: params?.[2] == null ? null : String(params?.[2]),
            category: null,
            visibility_scope: JSON.parse(String(params?.[4])),
            sla_hours: null,
            status: 'draft',
            active_version_id: null,
            latest_version_id: null,
            created_at: new Date('2026-06-05T00:00:00.000Z'),
            updated_at: new Date('2026-06-05T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('INSERT INTO approval_template_versions')) {
        return {
          rows: [{
            id: 'ver-authoring',
            template_id: 'tpl-authoring',
            version: 1,
            status: 'draft',
            form_schema: JSON.parse(String(params?.[1])),
            approval_graph: JSON.parse(String(params?.[2])),
            created_at: new Date('2026-06-05T00:00:00.000Z'),
            updated_at: new Date('2026-06-05T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('UPDATE approval_templates')) {
        return {
          rows: [{
            id: 'tpl-authoring',
            key: 'expense-authoring',
            name: 'Expense Authoring',
            description: 'Template emitted by the frontend authoring MVP',
            category: null,
            visibility_scope: { type: 'all', ids: [] },
            sla_hours: null,
            status: 'draft',
            active_version_id: null,
            latest_version_id: 'ver-authoring',
            created_at: new Date('2026-06-05T00:00:00.000Z'),
            updated_at: new Date('2026-06-05T00:00:00.000Z'),
          }],
          rowCount: 1,
        }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()
    const result = await service.createTemplate(request as never)

    const approvalNode = result.approvalGraph.nodes.find((node) => node.key === 'approval_1')
    expect(approvalNode?.config).toEqual({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'reviewer' }],
      approvalMode: 'single',
      emptyAssigneePolicy: 'error',
    })
    expect(pgState.client.release).toHaveBeenCalledTimes(1)
  })

  it('rejects continuous_managers with invalid levels before hitting the database (no silent default)', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    const requestWithLevels = (levels: unknown) => ({
      key: 'cm-bad',
      name: 'CM Bad',
      visibilityScope: { type: 'all', ids: [] },
      formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: 'Chain',
            config: {
              assigneeSources: [{ kind: 'continuous_managers', levels }],
              approvalMode: 'all',
              emptyAssigneePolicy: 'error',
            },
          },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'end' },
        ],
      },
    })

    for (const badLevels of [0, 11, 1.5, undefined, 'two']) {
      await expect(service.createTemplate(requestWithLevels(badLevels) as never)).rejects.toMatchObject({
        message: 'approvalGraph.nodes[1].config.assigneeSources[0].levels must be an integer between 1 and 10',
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      })
    }
    expect(pgState.pool.connect).not.toHaveBeenCalled()
  })

  it('rejects manager_at_level with invalid level before hitting the database (no silent default)', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    const requestWithLevel = (level: unknown) => ({
      key: 'mal-bad',
      name: 'MAL Bad',
      visibilityScope: { type: 'all', ids: [] },
      formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: 'Level',
            config: {
              assigneeSources: [{ kind: 'manager_at_level', level }],
              approvalMode: 'all',
              emptyAssigneePolicy: 'error',
            },
          },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'end' },
        ],
      },
    })

    for (const badLevel of [0, 11, 1.5, undefined, 'two']) {
      await expect(service.createTemplate(requestWithLevel(badLevel) as never)).rejects.toMatchObject({
        message: 'approvalGraph.nodes[1].config.assigneeSources[0].level must be an integer between 1 and 10',
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      })
    }
    expect(pgState.pool.connect).not.toHaveBeenCalled()
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

  describe('P1-C node field permissions (hidden subset)', () => {
    function fieldPermRequest(fieldPermissions: unknown) {
      return {
        key: 'fieldperm-tpl',
        name: 'Field Perm Template',
        formSchema: {
          fields: [
            { id: 'amount', type: 'number', label: 'Amount' },
            { id: 'secret', type: 'text', label: 'Secret' },
          ],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'approval_1',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['manager-1'], fieldPermissions },
            },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
            { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
          ],
        },
      }
    }

    function mockTemplateInsert() {
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
          return { rows: [], rowCount: 0 }
        }
        if (statement.startsWith('INSERT INTO approval_templates')) {
          return {
            rows: [{
              id: 'tpl-fieldperm',
              key: String(params?.[0]),
              name: String(params?.[1]),
              description: null,
              category: null,
              visibility_scope: JSON.parse(String(params?.[4])),
              sla_hours: null,
              status: 'draft',
              active_version_id: null,
              latest_version_id: null,
              created_at: new Date('2026-06-17T00:00:00.000Z'),
              updated_at: new Date('2026-06-17T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        if (statement.startsWith('INSERT INTO approval_template_versions')) {
          return {
            rows: [{
              id: 'ver-fieldperm',
              template_id: 'tpl-fieldperm',
              version: 1,
              status: 'draft',
              form_schema: JSON.parse(String(params?.[1])),
              approval_graph: JSON.parse(String(params?.[2])),
              created_at: new Date('2026-06-17T00:00:00.000Z'),
              updated_at: new Date('2026-06-17T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        if (statement.startsWith('UPDATE approval_templates')) {
          return {
            rows: [{
              id: 'tpl-fieldperm',
              key: 'fieldperm-tpl',
              name: 'Field Perm Template',
              description: null,
              category: null,
              visibility_scope: { type: 'all', ids: [] },
              sla_hours: null,
              status: 'draft',
              active_version_id: null,
              latest_version_id: 'ver-fieldperm',
              created_at: new Date('2026-06-17T00:00:00.000Z'),
              updated_at: new Date('2026-06-17T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
      })
    }

    it('rejects an invalid access enum before hitting the database (no silent default)', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        fieldPermRequest([{ fieldId: 'secret', access: 'invisible' }]) as never,
      )).rejects.toMatchObject({
        message: 'approvalGraph.nodes[1].config.fieldPermissions[0].access must be editable, readonly, or hidden',
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      })
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects a missing fieldId before hitting the database', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        fieldPermRequest([{ access: 'hidden' }]) as never,
      )).rejects.toMatchObject({
        message: 'approvalGraph.nodes[1].config.fieldPermissions[0].fieldId is required',
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      })
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects a duplicate fieldId within one node', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        fieldPermRequest([
          { fieldId: 'secret', access: 'hidden' },
          { fieldId: 'secret', access: 'readonly' },
        ]) as never,
      )).rejects.toMatchObject({
        message: 'approvalGraph.nodes[1].config.fieldPermissions[1].fieldId is duplicated',
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      })
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects an unknown fieldId not present in the form schema', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        fieldPermRequest([{ fieldId: 'ghost', access: 'hidden' }]) as never,
      )).rejects.toMatchObject({
        message: 'approvalGraph node approval_1 fieldPermissions references unknown field ghost',
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      })
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('accepts a valid hidden permission, trims fieldId, and round-trips byte-stably', async () => {
      mockTemplateInsert()
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      const result = await service.createTemplate(
        fieldPermRequest([
          { fieldId: '  secret  ', access: 'hidden' },
          { fieldId: 'amount', access: 'editable' },
        ]) as never,
      )
      const node = result.approvalGraph.nodes.find((n) => n.key === 'approval_1')
      expect((node?.config as Record<string, unknown>).fieldPermissions).toEqual([
        { fieldId: 'secret', access: 'hidden' },
        { fieldId: 'amount', access: 'editable' },
      ])
    })

    it('omits an empty fieldPermissions array (does not emit [])', async () => {
      mockTemplateInsert()
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      const result = await service.createTemplate(fieldPermRequest([]) as never)
      const node = result.approvalGraph.nodes.find((n) => n.key === 'approval_1')
      expect((node?.config as Record<string, unknown>).fieldPermissions).toBeUndefined()
    })
  })

  describe('T1-1 node-level SLA timeout (author / publish validation)', () => {
    function timeoutRequest(timeout: unknown) {
      return {
        key: 'node-timeout-tpl',
        name: 'Node Timeout Template',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'approval_1',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['manager-1'], timeout },
            },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
            { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
          ],
        },
      }
    }

    function parallelTimeoutRequest(timeout: unknown) {
      return {
        key: 'node-timeout-parallel-tpl',
        name: 'Node Timeout Parallel Template',
        formSchema: { fields: [] },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'parallel_fork',
              type: 'parallel',
              config: { branches: ['edge-fork-a', 'edge-fork-b'], joinMode: 'all', joinNodeKey: 'end' },
            },
            {
              key: 'branch_a',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: ['user-a'], timeout },
            },
            { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
            { key: 'edge-fork-a', source: 'parallel_fork', target: 'branch_a' },
            { key: 'edge-fork-b', source: 'parallel_fork', target: 'branch_b' },
            { key: 'edge-a-end', source: 'branch_a', target: 'end' },
            { key: 'edge-b-end', source: 'branch_b', target: 'end' },
          ],
        },
      }
    }

    function mockTemplateInsert() {
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
          return { rows: [], rowCount: 0 }
        }
        if (statement.startsWith('INSERT INTO approval_templates')) {
          return {
            rows: [{
              id: 'tpl-node-timeout',
              key: String(params?.[0]),
              name: String(params?.[1]),
              description: null,
              category: null,
              visibility_scope: JSON.parse(String(params?.[4])),
              sla_hours: null,
              status: 'draft',
              active_version_id: null,
              latest_version_id: null,
              created_at: new Date('2026-06-29T00:00:00.000Z'),
              updated_at: new Date('2026-06-29T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        if (statement.startsWith('INSERT INTO approval_template_versions')) {
          return {
            rows: [{
              id: 'ver-node-timeout',
              template_id: 'tpl-node-timeout',
              version: 1,
              status: 'draft',
              form_schema: JSON.parse(String(params?.[1])),
              approval_graph: JSON.parse(String(params?.[2])),
              created_at: new Date('2026-06-29T00:00:00.000Z'),
              updated_at: new Date('2026-06-29T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        if (statement.startsWith('UPDATE approval_templates')) {
          return {
            rows: [{
              id: 'tpl-node-timeout',
              key: 'node-timeout-tpl',
              name: 'Node Timeout Template',
              description: null,
              category: null,
              visibility_scope: { type: 'all', ids: [] },
              sla_hours: null,
              status: 'draft',
              active_version_id: null,
              latest_version_id: 'ver-node-timeout',
              created_at: new Date('2026-06-29T00:00:00.000Z'),
              updated_at: new Date('2026-06-29T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
      })
    }

    it('rejects a non-integer afterMinutes before hitting the database', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        timeoutRequest({ afterMinutes: 1.5, effect: 'remind' }) as never,
      )).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_NODE_TIMEOUT_INVALID' })
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects a zero / negative afterMinutes', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        timeoutRequest({ afterMinutes: 0, effect: 'remind' }) as never,
      )).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_NODE_TIMEOUT_INVALID' })
    })

    it('rejects an afterMinutes above the cap', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        timeoutRequest({ afterMinutes: 100001, effect: 'remind' }) as never,
      )).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_NODE_TIMEOUT_INVALID' })
    })

    it('rejects an off-enum effect', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        timeoutRequest({ afterMinutes: 30, effect: 'escalate' }) as never,
      )).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_NODE_TIMEOUT_INVALID' })
    })

    it.each(['auto_approve', 'auto_reject'])(
      'rejects the still-unwired terminal effect %s',
      async (effect) => {
        const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
        const service = new ApprovalProductService()
        await expect(service.createTemplate(
          timeoutRequest({ afterMinutes: 30, effect }) as never,
        )).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_NODE_TIMEOUT_EFFECT_UNSUPPORTED' })
      },
    )

    it.each(['transfer', 'jump'])(
      'rejects the slice-2 effect %s without its required target',
      async (effect) => {
        const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
        const service = new ApprovalProductService()
        await expect(service.createTemplate(
          timeoutRequest({ afterMinutes: 30, effect }) as never,
        )).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_NODE_TIMEOUT_TARGET_INVALID' })
      },
    )

    it('rejects a timeout on a node inside a parallel region', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate(
        parallelTimeoutRequest({ afterMinutes: 30, effect: 'remind' }) as never,
      )).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_NODE_TIMEOUT_PARALLEL_UNSUPPORTED' })
    })

    it('accepts a valid remind timeout and preserves it through normalization', async () => {
      mockTemplateInsert()
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      const result = await service.createTemplate(
        timeoutRequest({ afterMinutes: 30, effect: 'remind' }) as never,
      )
      const node = result.approvalGraph.nodes.find((n) => n.key === 'approval_1')
      expect((node?.config as Record<string, unknown>).timeout).toEqual({ afterMinutes: 30, effect: 'remind' })
    })
  })

  describe('empty condition-branch rules gate (author / publish validation)', () => {
    // A rules-mode branch with `rules: []` evaluates as `[].every(...)` === TRUE at runtime — it
    // would silently capture ALL traffic (first-match-wins) and dead-code the default edge. The
    // gate raises its own code at create / update / publish (like validateNodeTimeoutConfigs),
    // NEVER inside normalizeApprovalGraph's stored-graph path (plain reads must not brick).
    // Negative control for the formula exemption: the FC-1 describe above proves createTemplate
    // ACCEPTS formula branches carrying `rules: []` — dropping the exemption REDs those tests.
    function emptyBranchGraph() {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'route',
            type: 'condition',
            config: { branches: [{ edgeKey: 'edge-high', rules: [] }], defaultEdgeKey: 'edge-low' },
          },
          { key: 'high', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
          { key: 'low', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'edge-start-route', source: 'start', target: 'route' },
          { key: 'edge-high', source: 'route', target: 'high' },
          { key: 'edge-low', source: 'route', target: 'low' },
          { key: 'edge-high-end', source: 'high', target: 'end' },
          { key: 'edge-low-end', source: 'low', target: 'end' },
        ],
      }
    }

    it('rejects a rules-mode branch with EMPTY rules at createTemplate, before hitting the database', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate({
        key: 'empty-branch-tpl',
        name: 'Empty Branch Template',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: emptyBranchGraph(),
      } as never)).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_CONDITION_BRANCH_RULES_EMPTY' })
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects an already-STORED empty-rules branch at PUBLISH (a legacy draft can never reach a published definition)', async () => {
      const template = {
        id: 'tpl-empty-branch', key: 'empty-branch', name: 'Empty Branch', description: null, category: null,
        visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
        active_version_id: null, latest_version_id: 'ver-eb', created_at: new Date(), updated_at: new Date(),
      }
      const version = {
        id: 'ver-eb', template_id: 'tpl-empty-branch', version: 1, status: 'draft',
        form_schema: { fields: [] }, approval_graph: emptyBranchGraph(),
        created_at: new Date(), updated_at: new Date(),
      }
      pgState.client.query.mockImplementation(async (sql: string) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) return { rows: [template], rowCount: 1 }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) return { rows: [version], rowCount: 1 }
        if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) return { rows: [], rowCount: 0 }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
      })
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(
        new ApprovalProductService().publishTemplate('tpl-empty-branch', { policy: { allowRevoke: true } } as never),
      ).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_CONDITION_BRANCH_RULES_EMPTY' })
    })
  })

  describe('parallel dynamic-assignee conflict publish gate (F2)', () => {
    // Provably-identical DYNAMIC sources across parallel branches resolve to the same user on
    // EVERY request, so fan-out raises the typed 409 APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT
    // 100% of the time — publish now rejects the same shape with the same code (status 400).
    // Different kinds / different parameters must NOT be flagged (they may be legal; the runtime
    // guard owns org-shape-dependent collisions), and the publish policy's mergeAdjacentApprover
    // exemption mirrors allowParallelDuplicateAssignees for statics.
    function parallelDynamicGraph(sourceA: unknown, sourceB: unknown) {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['edge-fork-a', 'edge-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          { key: 'branch_a', type: 'approval', config: { assigneeSources: [sourceA], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'branch_b', type: 'approval', config: { assigneeSources: [sourceB], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'edge-start-fork', source: 'start', target: 'fork' },
          { key: 'edge-fork-a', source: 'fork', target: 'branch_a' },
          { key: 'edge-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'edge-a-join', source: 'branch_a', target: 'join' },
          { key: 'edge-b-join', source: 'branch_b', target: 'join' },
          { key: 'edge-join-end', source: 'join', target: 'end' },
        ],
      }
    }

    function mockParallelPublish(graph: unknown) {
      const template = {
        id: 'tpl-par', key: 'par', name: 'Parallel', description: null, category: null,
        visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
        active_version_id: null, latest_version_id: 'ver-par', created_at: new Date(), updated_at: new Date(),
      }
      const version = {
        id: 'ver-par', template_id: 'tpl-par', version: 1, status: 'draft',
        form_schema: { fields: [] }, approval_graph: graph,
        created_at: new Date(), updated_at: new Date(),
      }
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) return { rows: [template], rowCount: 1 }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) return { rows: [version], rowCount: 1 }
        if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) return { rows: [], rowCount: 0 }
        if (statement.startsWith('INSERT INTO approval_published_definitions')) {
          return { rows: [{ id: 'pub-par', template_id: 'tpl-par', template_version_id: 'ver-par', runtime_graph: JSON.parse(String(params?.[2])), is_active: true, published_at: new Date() }], rowCount: 1 }
        }
        if (statement.startsWith("UPDATE approval_template_versions SET status = 'published'")) return { rows: [{ ...version, status: 'published' }], rowCount: 1 }
        if (statement.startsWith("UPDATE approval_templates SET status = 'published'")) return { rows: [], rowCount: 1 }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
      })
    }

    it('rejects requester×requester branches at publish with the runtime conflict code (the old untouched-starter shape)', async () => {
      mockParallelPublish(parallelDynamicGraph({ kind: 'requester' }, { kind: 'requester' }))
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(
        new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never),
      ).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT' })
    })

    it('rejects same-parameter dynamic sources (manager_at_level 2 × manager_at_level 2)', async () => {
      mockParallelPublish(parallelDynamicGraph({ kind: 'manager_at_level', level: 2 }, { kind: 'manager_at_level', level: 2 }))
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(
        new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never),
      ).rejects.toMatchObject({ statusCode: 400, code: 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT' })
    })

    it('publishes DIFFERENT dynamic kinds / DIFFERENT parameters clean (no false positive)', async () => {
      mockParallelPublish(parallelDynamicGraph({ kind: 'requester' }, { kind: 'direct_manager' }))
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never)
      expect(result.publishedDefinitionId).toBe('pub-par')

      mockParallelPublish(parallelDynamicGraph({ kind: 'manager_at_level', level: 1 }, { kind: 'manager_at_level', level: 2 }))
      const second = await new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never)
      expect(second.publishedDefinitionId).toBe('pub-par')
    })

    it('exempts a publish policy carrying autoApproval.mergeAdjacentApprover (mirrors allowParallelDuplicateAssignees)', async () => {
      mockParallelPublish(parallelDynamicGraph({ kind: 'requester' }, { kind: 'requester' }))
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().publishTemplate(
        'tpl-par',
        { policy: { allowRevoke: true, autoApproval: { mergeAdjacentApprover: true } } } as never,
      )
      expect(result.publishedDefinitionId).toBe('pub-par')
    })

    // ── Owner P2 (review #4433): a CONDITION nested inside a parallel branch must not hide its
    // alternative paths from the publish gate. The old walk followed each node's FIRST outgoing
    // edge only, so a conflict behind a condition's default (or any non-first) edge published
    // green and then 409'd every matching request at runtime. The fixed walk enumerates ALL
    // condition paths up to the join and intersects the per-branch source SETS across branches.
    // FE mirror goldens: apps/web/tests/approval-template-authoring-parallel-edit.test.ts
    // ('condition paths inside a parallel branch (owner P2)') — keep in lockstep. ──

    // Owner's constructed case: branch A = condition (rules path → <highPathSource>, DEFAULT path →
    // requester — rules edge declared FIRST so the old walk never reached the requester),
    // branch B = <branchBSource>.
    function conditionDefaultPathGraph(branchBSource: unknown, highPathSource: unknown = { kind: 'dept_head' }) {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
              defaultEdgeKey: 'e-cond-low',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeSources: [highPathSource], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'approval_low', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'branch_b', type: 'approval', config: { assigneeSources: [branchBSource], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          // Rules edge FIRST, default edge SECOND — first-edge-only traversal missed approval_low.
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-cond-low', source: 'cond_1', target: 'approval_low' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-low-join', source: 'approval_low', target: 'join' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
    }

    it('GOLDEN (owner case): condition DEFAULT path resolves to requester, branch B is requester → publish rejects naming requester', async () => {
      mockParallelPublish(conditionDefaultPathGraph({ kind: 'requester' }))
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(
        new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT',
        details: { nodeKey: 'fork', source: 'requester', conflictingNodeKeys: ['approval_low', 'branch_b'] },
      })
    })

    it('publishes clean when every condition path yields a DIFFERENT source than branch B (negative control)', async () => {
      // Paths yield dept_head / requester; branch B is direct_manager — nothing provably identical.
      mockParallelPublish(conditionDefaultPathGraph({ kind: 'direct_manager' }))
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never)
      expect(result.publishedDefinitionId).toBe('pub-par')
    })

    it('rejects a conflict hidden behind the RULES edge when the default edge is declared first', async () => {
      // Default edge (→ approval_low, requester) declared FIRST; the dept_head conflict sits behind
      // the RULES edge, which a first-edge-only walk would never enter. Branch B = dept_head.
      const graph = conditionDefaultPathGraph({ kind: 'dept_head' })
      const condEdgeKeys = new Set(['e-cond-high', 'e-cond-low'])
      const [highEdge, lowEdge] = graph.edges.filter((edge) => condEdgeKeys.has(edge.key))
      graph.edges = graph.edges.map((edge) => (edge.key === 'e-cond-high' ? lowEdge : edge.key === 'e-cond-low' ? highEdge : edge))
      mockParallelPublish(graph)
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(
        new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT',
        details: { nodeKey: 'fork', source: 'dept_head' },
      })
    })

    it('rejects a conflict reachable only through a DEEP condition chain (condition → condition, default → default)', async () => {
      const deepChain = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: { branches: [{ edgeKey: 'e-c1-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 10000 }], conjunction: 'and' }], defaultEdgeKey: 'e-c1-c2' },
          },
          {
            key: 'cond_2',
            type: 'condition',
            config: { branches: [{ edgeKey: 'e-c2-mid', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }], defaultEdgeKey: 'e-c2-low' },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'approval_mid', type: 'approval', config: { assigneeSources: [{ kind: 'manager_at_level', level: 1 }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'approval_low', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'branch_b', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          // Rules edges declared first at BOTH levels — the conflicting requester sits two default
          // hops deep (cond_1 default → cond_2 default → approval_low).
          { key: 'e-c1-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-c1-c2', source: 'cond_1', target: 'cond_2' },
          { key: 'e-c2-mid', source: 'cond_2', target: 'approval_mid' },
          { key: 'e-c2-low', source: 'cond_2', target: 'approval_low' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-mid-join', source: 'approval_mid', target: 'join' },
          { key: 'e-low-join', source: 'approval_low', target: 'join' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
      mockParallelPublish(deepChain)
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(
        new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT',
        details: { nodeKey: 'fork', source: 'requester', conflictingNodeKeys: ['approval_low', 'branch_b'] },
      })
    })

    it('ignores a stray outgoing edge that runtime condition routing can never select', async () => {
      const graph = conditionDefaultPathGraph({ kind: 'direct_manager' })
      graph.nodes.splice(-2, 0, {
        key: 'approval_stray',
        type: 'approval',
        config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
      })
      graph.edges.splice(-1, 0,
        { key: 'e-cond-stray', source: 'cond_1', target: 'approval_stray' },
        { key: 'e-stray-join', source: 'approval_stray', target: 'join' },
      )
      mockParallelPublish(graph)
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().publishTemplate(
        'tpl-par',
        { policy: { allowRevoke: true } } as never,
      )
      expect(result.publishedDefinitionId).toBe('pub-par')
    })

    it('without a default, scans the first-outgoing fallback for dynamic conflicts', async () => {
      const graph = conditionDefaultPathGraph({ kind: 'requester' })
      const condition = graph.nodes.find((node) => node.key === 'cond_1')!
      condition.config = {
        branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
      }
      const highIndex = graph.edges.findIndex((edge) => edge.key === 'e-cond-high')
      const lowIndex = graph.edges.findIndex((edge) => edge.key === 'e-cond-low')
      ;[graph.edges[highIndex], graph.edges[lowIndex]] = [graph.edges[lowIndex], graph.edges[highIndex]]
      mockParallelPublish(graph)

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().publishTemplate(
        'tpl-par',
        { policy: { allowRevoke: true } } as never,
      )).rejects.toMatchObject({
        statusCode: 400,
        code: 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT',
        details: { nodeKey: 'fork', source: 'requester' },
      })
    })

    it('does NOT reject the same source on two ALTERNATIVE paths of ONE branch alone (within-branch union, not a conflict)', async () => {
      // Both cond_1 paths resolve to requester but branch B is a STATIC role — alternative paths of
      // one branch never run simultaneously, so publish must stay green.
      mockParallelPublish(conditionDefaultPathGraph({ kind: 'static_role', roleIds: ['legal'] }, { kind: 'requester' }))
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().publishTemplate('tpl-par', { policy: { allowRevoke: true } } as never)
      expect(result.publishedDefinitionId).toBe('pub-par')
    })
  })

  describe('parallel branch all-path join reachability (author / publish)', () => {
    // The strict write gate proves every runtime-possible path through a parallel
    // branch reaches the configured join. Stored reads keep the historical
    // first-edge compatibility path so a validator tightening cannot brick them.
    // The prior first-outgoing-edge-only walk accepted templates where a condition's
    // FIRST rules edge joined while a non-first / default edge hit end (or dead-ended /
    // nested-parallel / cycled); create/update/publish went green, then a request that
    // selected the alternate edge failed before insert with
    // "Parallel branch terminated at an end node before reaching join".
    //
    // Mutation proof: reverting collectBranchAssignees to first-edge-only
    // (`outgoing.get(current)?.[0]` only, no config-declared condition fan-out) REDs the
    // exact GOLDEN below (and the symmetric non-first-rules failure). Convergent-DAG +
    // all-paths-join positives stay green either way; nested-parallel/cycle-on-non-first
    // negatives also RED under first-edge-only (they sit behind the non-first arm).
    // Complexity mutation: drop DONE memoization (path-local rewalk only) hangs the
    // layered-diamond acceptance (2^24 shared-tail recomputations) while the single-
    // diamond convergent control still passes.
    // Condition-successor mutation: walking ALL graph outgoing edges (instead of
    // config.branches[].edgeKey + defaultEdgeKey, with firstTarget only when default is
    // absent) REDs the stray-outgoing positive and may false-green foreign-owned edgeKeys.

    function mockCreateInsert(templateKey: string) {
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
          return { rows: [], rowCount: 0 }
        }
        if (statement.startsWith('INSERT INTO approval_templates')) {
          return {
            rows: [{
              id: 'tpl-join-reach',
              key: String(params?.[0]),
              name: String(params?.[1]),
              description: null,
              category: null,
              visibility_scope: JSON.parse(String(params?.[4])),
              sla_hours: null,
              status: 'draft',
              active_version_id: null,
              latest_version_id: null,
              created_at: new Date('2026-06-29T00:00:00.000Z'),
              updated_at: new Date('2026-06-29T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        if (statement.startsWith('INSERT INTO approval_template_versions')) {
          return {
            rows: [{
              id: 'ver-join-reach',
              template_id: 'tpl-join-reach',
              version: 1,
              status: 'draft',
              form_schema: JSON.parse(String(params?.[1])),
              approval_graph: JSON.parse(String(params?.[2])),
              created_at: new Date('2026-06-29T00:00:00.000Z'),
              updated_at: new Date('2026-06-29T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        if (statement.startsWith('UPDATE approval_templates')) {
          return {
            rows: [{
              id: 'tpl-join-reach',
              key: templateKey,
              name: 'Join Reach Template',
              description: null,
              category: null,
              visibility_scope: { type: 'all', ids: [] },
              sla_hours: null,
              status: 'draft',
              active_version_id: null,
              latest_version_id: 'ver-join-reach',
              created_at: new Date('2026-06-29T00:00:00.000Z'),
              updated_at: new Date('2026-06-29T00:00:00.000Z'),
            }],
            rowCount: 1,
          }
        }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
      })
    }

    function mockPublish(graph: unknown) {
      const template = {
        id: 'tpl-join-reach', key: 'join-reach', name: 'Join Reach', description: null, category: null,
        visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
        active_version_id: null, latest_version_id: 'ver-join-reach', created_at: new Date(), updated_at: new Date(),
      }
      const version = {
        id: 'ver-join-reach', template_id: 'tpl-join-reach', version: 1, status: 'draft',
        form_schema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] }, approval_graph: graph,
        created_at: new Date(), updated_at: new Date(),
      }
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) return { rows: [template], rowCount: 1 }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) return { rows: [version], rowCount: 1 }
        if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) return { rows: [], rowCount: 0 }
        if (statement.startsWith('INSERT INTO approval_published_definitions')) {
          return { rows: [{ id: 'pub-join-reach', template_id: 'tpl-join-reach', template_version_id: 'ver-join-reach', runtime_graph: JSON.parse(String(params?.[2])), is_active: true, published_at: new Date() }], rowCount: 1 }
        }
        if (statement.startsWith("UPDATE approval_template_versions SET status = 'published'")) return { rows: [{ ...version, status: 'published' }], rowCount: 1 }
        if (statement.startsWith("UPDATE approval_templates SET status = 'published'")) return { rows: [], rowCount: 1 }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
      })
    }

    /**
     * GOLDEN shape: parallel branch A starts at a condition whose FIRST (rules) edge
     * reaches join via approval_high, but whose SECOND (default) edge reaches `end`
     * without joining. Branch B is a plain approval → join. First-edge-only walks
     * never see the default arm and accept the template.
     */
    function goldenDefaultEndsBeforeJoinGraph() {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
              defaultEdgeKey: 'e-cond-low',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-high'] } },
          { key: 'approval_low', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-low'] } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          // Rules edge FIRST (joins), default edge SECOND (hits end) — first-edge-only is false-green.
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-cond-low', source: 'cond_1', target: 'approval_low' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-low-end', source: 'approval_low', target: 'end' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
    }

    const goldenReject = {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'approvalGraph parallel branch must reach join before end (at end)',
    }

    it('GOLDEN: first condition edge joins, default edge reaches end → createTemplate rejects before DB', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.createTemplate({
        key: 'join-reach-golden',
        name: 'Join Reach Golden',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: goldenDefaultEndsBeforeJoinGraph(),
      } as never)).rejects.toMatchObject(goldenReject)
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('GOLDEN: same shape → updateTemplate rejects before DB', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService()
      await expect(service.updateTemplate('tpl-join-reach', {
        approvalGraph: goldenDefaultEndsBeforeJoinGraph(),
      } as never)).rejects.toMatchObject(goldenReject)
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('GOLDEN: same readable historical shape → publishTemplate rejects at the strict write gate', async () => {
      mockPublish(goldenDefaultEndsBeforeJoinGraph())
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(
        new ApprovalProductService().publishTemplate('tpl-join-reach', { policy: { allowRevoke: true } } as never),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'approvalGraph parallel branch must reach join before end (at end)',
      })
    })

    it('GOLDEN: clone rejects a readable historical graph before creating a new draft version', async () => {
      const graph = goldenDefaultEndsBeforeJoinGraph()
      const template = {
        id: 'tpl-join-reach', key: 'join-reach', name: 'Join Reach', description: null, category: null,
        visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
        active_version_id: null, latest_version_id: 'ver-join-reach', created_at: new Date(), updated_at: new Date(),
      }
      const version = {
        id: 'ver-join-reach', template_id: 'tpl-join-reach', version: 1, status: 'draft',
        form_schema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] }, approval_graph: graph,
        created_at: new Date(), updated_at: new Date(),
      }
      pgState.pool.query.mockImplementation(async (sql: string) => {
        const statement = normalize(sql)
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
          return { rows: [template], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
          return { rows: [version], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`Unhandled pool query: ${statement}`)
      })

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().cloneTemplate('tpl-join-reach')).rejects.toMatchObject(goldenReject)
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('compatibility GOLDEN: ordinary reads still return a historical first-edge-valid graph', async () => {
      const graph = goldenDefaultEndsBeforeJoinGraph()
      const template = {
        id: 'tpl-join-reach', key: 'join-reach', name: 'Join Reach', description: null, category: null,
        visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
        active_version_id: null, latest_version_id: 'ver-join-reach', created_at: new Date(), updated_at: new Date(),
      }
      const version = {
        id: 'ver-join-reach', template_id: 'tpl-join-reach', version: 1, status: 'draft',
        form_schema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] }, approval_graph: graph,
        created_at: new Date(), updated_at: new Date(),
      }
      pgState.pool.query.mockImplementation(async (sql: string) => {
        const statement = normalize(sql)
        if (statement.startsWith('SELECT * FROM approval_templates WHERE')) return { rows: [template], rowCount: 1 }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) return { rows: [version], rowCount: 1 }
        if (statement.startsWith('SELECT * FROM approval_published_definitions')) return { rows: [], rowCount: 0 }
        throw new Error(`Unhandled query: ${statement}`)
      })

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().getTemplate('tpl-join-reach')
      expect(result?.approvalGraph).toEqual(graph)
    })

    it('form-only update revalidates the copied historical graph before creating a new version', async () => {
      const graph = goldenDefaultEndsBeforeJoinGraph()
      const template = {
        id: 'tpl-join-reach', key: 'join-reach', name: 'Join Reach', description: null, category: null,
        visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
        active_version_id: null, latest_version_id: 'ver-join-reach', created_at: new Date(), updated_at: new Date(),
      }
      const version = {
        id: 'ver-join-reach', template_id: 'tpl-join-reach', version: 1, status: 'draft',
        form_schema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] }, approval_graph: graph,
        created_at: new Date(), updated_at: new Date(),
      }
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) return { rows: [template], rowCount: 1 }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE template_id = $1')) return { rows: [version], rowCount: 1 }
        if (statement.startsWith('SELECT COALESCE(MAX(version), 0)::text')) return { rows: [{ max_version: '1' }], rowCount: 1 }
        if (statement.startsWith('INSERT INTO approval_template_versions')) {
          return { rows: [{ ...version, id: 'ver-join-reach-2', version: 2, form_schema: JSON.parse(String(params?.[2])) }], rowCount: 1 }
        }
        if (statement.startsWith('UPDATE approval_templates SET latest_version_id')) {
          return { rows: [{ ...template, latest_version_id: 'ver-join-reach-2' }], rowCount: 1 }
        }
        throw new Error(`Unhandled query: ${statement}`)
      })

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().updateTemplate('tpl-join-reach', {
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
      } as never)).rejects.toMatchObject(goldenReject)
    })

    it('no-default runtime fallback follows the first outgoing edge as well as declared rule edges', async () => {
      const graph = goldenDefaultEndsBeforeJoinGraph()
      const condition = graph.nodes.find((node) => node.key === 'cond_1')!
      condition.config = {
        branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
      }
      const highIndex = graph.edges.findIndex((edge) => edge.key === 'e-cond-high')
      const lowIndex = graph.edges.findIndex((edge) => edge.key === 'e-cond-low')
      ;[graph.edges[highIndex], graph.edges[lowIndex]] = [graph.edges[lowIndex], graph.edges[highIndex]]
      // First outgoing is now the undeclared low edge -> end; the declared high
      // edge joins. Omitting the firstTarget fallback would false-accept.
      mockCreateInsert('join-reach-no-default')
      await expect(new (await import('../../src/services/ApprovalProductService')).ApprovalProductService().createTemplate({
        key: 'join-reach-no-default',
        name: 'Join Reach No Default',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)).rejects.toMatchObject(goldenReject)
    })

    it('symmetric: non-first RULES edge reaches end (default joins) → create rejects', async () => {
      // Two rules edges: first joins, second ends — default also joins. First-edge-only green;
      // all-path must still reject the non-first rules arm.
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [
                { edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 10000 }], conjunction: 'and' },
                { edgeKey: 'e-cond-mid', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' },
              ],
              defaultEdgeKey: 'e-cond-low',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-high'] } },
          { key: 'approval_mid', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-mid'] } },
          { key: 'approval_low', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-low'] } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-cond-mid', source: 'cond_1', target: 'approval_mid' },
          { key: 'e-cond-low', source: 'cond_1', target: 'approval_low' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-mid-end', source: 'approval_mid', target: 'end' },
          { key: 'e-low-join', source: 'approval_low', target: 'join' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().createTemplate({
        key: 'join-reach-rules-end',
        name: 'Join Reach Rules End',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)).rejects.toMatchObject(goldenReject)
    })

    it('positive control: every condition alternative reaches join → create accepts', async () => {
      const graph = goldenDefaultEndsBeforeJoinGraph()
      // Fix the default arm: low → join instead of end.
      graph.edges = graph.edges.map((edge) => (
        edge.key === 'e-low-end' ? { ...edge, key: 'e-low-join', target: 'join' } : edge
      ))
      mockCreateInsert('join-reach-ok')
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().createTemplate({
        key: 'join-reach-ok',
        name: 'Join Reach OK',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)
      expect(result.id).toBe('tpl-join-reach')
      expect(result.approvalGraph.nodes.some((n) => n.key === 'fork' && n.type === 'parallel')).toBe(true)
    })

    it('positive control: convergent DAG (two condition arms rejoin a shared pre-join node) is NOT a cycle', async () => {
      // cond → high → shared → join
      //     ↘ low  ↗
      // A global-visited cycle detector would false-positive when the second arm re-enters `shared`.
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
              defaultEdgeKey: 'e-cond-low',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-high'] } },
          { key: 'approval_low', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-low'] } },
          { key: 'shared', type: 'cc', config: { targetType: 'user', targetIds: ['watcher-1'] } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-cond-low', source: 'cond_1', target: 'approval_low' },
          { key: 'e-high-shared', source: 'approval_high', target: 'shared' },
          { key: 'e-low-shared', source: 'approval_low', target: 'shared' },
          { key: 'e-shared-join', source: 'shared', target: 'join' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
      mockCreateInsert('join-reach-dag')
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().createTemplate({
        key: 'join-reach-dag',
        name: 'Join Reach DAG',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)
      expect(result.id).toBe('tpl-join-reach')
    })

    it('positive control: layered convergent diamond DAG accepts in O(V+E) (memoized; pure path rewalk is exponential)', async () => {
      // Complexity proof (deterministic, no wall-clock):
      //   N stacked diamonds inside branch A:
      //     cond_i ──► left_i  ──► merge_i ──► cond_{i+1} (or join)
      //           └──► right_i ──┘
      //   Path count = 2^N. A pure path-local DFS that rewalks shared tails on every
      //   reconvergence evaluates the final merge 2^N times. With N=24 that is >16M
      //   full tail recomputations and hangs the suite; the tri-color DONE memo evaluates
      //   each node once (O(V+E) ≈ 3N + const), so createTemplate completes. N=24 is large
      //   enough that non-memoized rewalk is practically impossible in the test budget,
      //   without relying on a flaky timing assertion.
      // Mutation: drop doneMemo short-circuit (keep path-local visiting only) → this test
      // hangs / times out while the single-diamond convergent control still passes.
      const LAYERS = 24
      const nodes: Array<Record<string, unknown>> = [
        { key: 'start', type: 'start', config: {} },
        { key: 'fork', type: 'parallel', config: { branches: ['e-fork-diamonds', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
        { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
        { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
        { key: 'end', type: 'end', config: {} },
      ]
      const edges: Array<{ key: string; source: string; target: string }> = [
        { key: 'e-start-fork', source: 'start', target: 'fork' },
        { key: 'e-fork-diamonds', source: 'fork', target: 'cond_0' },
        { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
        { key: 'e-b-join', source: 'branch_b', target: 'join' },
        { key: 'e-join-end', source: 'join', target: 'end' },
      ]
      for (let i = 0; i < LAYERS; i += 1) {
        const condKey = `cond_${i}`
        const leftKey = `left_${i}`
        const rightKey = `right_${i}`
        const mergeKey = `merge_${i}`
        const nextKey = i + 1 < LAYERS ? `cond_${i + 1}` : 'join'
        nodes.push(
          {
            key: condKey,
            type: 'condition',
            config: {
              branches: [{ edgeKey: `e-${condKey}-left`, rules: [{ fieldId: 'amount', operator: 'gte', value: i }], conjunction: 'and' }],
              defaultEdgeKey: `e-${condKey}-right`,
            },
          },
          // Distinct static assignees per arm so a memoized UNION still sees every arm once;
          // first-edge-only would miss all right_* ids, and path rewalk would re-collect them 2^i times.
          { key: leftKey, type: 'approval', config: { assigneeType: 'user', assigneeIds: [`user-L${i}`] } },
          { key: rightKey, type: 'approval', config: { assigneeType: 'user', assigneeIds: [`user-R${i}`] } },
          { key: mergeKey, type: 'cc', config: { targetType: 'user', targetIds: [`watcher-${i}`] } },
        )
        edges.push(
          { key: `e-${condKey}-left`, source: condKey, target: leftKey },
          { key: `e-${condKey}-right`, source: condKey, target: rightKey },
          { key: `e-${leftKey}-merge`, source: leftKey, target: mergeKey },
          { key: `e-${rightKey}-merge`, source: rightKey, target: mergeKey },
          { key: `e-${mergeKey}-next`, source: mergeKey, target: nextKey },
        )
      }
      mockCreateInsert('join-reach-layered')
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().createTemplate({
        key: 'join-reach-layered',
        name: 'Join Reach Layered',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: { nodes, edges },
      } as never)
      expect(result.id).toBe('tpl-join-reach')
      // Sanity: graph size is linear in LAYERS (memoized walk bound), not exponential.
      expect(result.approvalGraph.nodes.length).toBe(5 + LAYERS * 4)
    })

    it('positive control: a deep valid condition chain does not overflow the JavaScript call stack', async () => {
      const DEPTH = 4_000
      const nodes: Array<Record<string, unknown>> = [
        { key: 'start', type: 'start', config: {} },
        { key: 'fork', type: 'parallel', config: { branches: ['e-fork-deep', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
        { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
        { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
        { key: 'end', type: 'end', config: {} },
      ]
      const edges: Array<{ key: string; source: string; target: string }> = [
        { key: 'e-start-fork', source: 'start', target: 'fork' },
        { key: 'e-fork-deep', source: 'fork', target: 'cond-deep-0' },
        { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
        { key: 'e-b-join', source: 'branch_b', target: 'join' },
        { key: 'e-join-end', source: 'join', target: 'end' },
      ]
      for (let index = 0; index < DEPTH; index += 1) {
        const key = `cond-deep-${index}`
        const edgeKey = `e-cond-deep-${index}`
        const target = index + 1 < DEPTH ? `cond-deep-${index + 1}` : 'join'
        nodes.push({
          key,
          type: 'condition',
          config: {
            branches: [{ edgeKey, rules: [{ fieldId: 'amount', operator: 'gte', value: index }], conjunction: 'and' }],
          },
        })
        edges.push({ key: edgeKey, source: key, target })
      }

      mockCreateInsert('join-reach-deep')
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().createTemplate({
        key: 'join-reach-deep',
        name: 'Join Reach Deep',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: { nodes, edges },
      } as never)
      expect(result.approvalGraph.nodes).toHaveLength(DEPTH + 5)
    })

    it('positive: stray outgoing edge NOT referenced by condition config must not fail a valid branch', async () => {
      // Discriminator vs "walk every graph outgoing edge": config rules+default both join,
      // but a stray edge from cond_1 → end sits in the edges array (not in branches /
      // defaultEdgeKey). Runtime never selects it (resolveConditionTarget only uses
      // declared edgeKeys + default / firstTarget), so authoring must stay green. Walking
      // all outgoing would false-fail with "must reach join before end".
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
              defaultEdgeKey: 'e-cond-low',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-high'] } },
          { key: 'approval_low', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-low'] } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-cond-low', source: 'cond_1', target: 'approval_low' },
          // Stray: same source as the condition, but NOT in config — must be ignored.
          { key: 'e-cond-stray-end', source: 'cond_1', target: 'end' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-low-join', source: 'approval_low', target: 'join' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
      mockCreateInsert('join-reach-stray')
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().createTemplate({
        key: 'join-reach-stray',
        name: 'Join Reach Stray',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)
      expect(result.id).toBe('tpl-join-reach')
    })

    it('negative: condition branch/default edgeKey owned by another node is rejected', async () => {
      // resolveConditionTarget → targetForEdge looks up by key globally, so a defaultEdgeKey
      // whose edge is sourced from branch_b would still return a target at runtime. Authoring
      // must reject the malformed ownership rather than treat it as a legal condition route.
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
              // Foreign-owned: this edge's source is branch_b, not cond_1.
              defaultEdgeKey: 'e-b-join',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-high'] } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().createTemplate({
        key: 'join-reach-foreign-edge',
        name: 'Join Reach Foreign Edge',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'approvalGraph parallel branch condition cond_1 references invalid edge e-b-join',
      })
    })

    it('negative: nested parallel on a NON-first condition path is rejected', async () => {
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
              defaultEdgeKey: 'e-cond-nested',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-high'] } },
          // Nested parallel sits only on the default arm (second outgoing edge).
          {
            key: 'nested_fork',
            type: 'parallel',
            config: { branches: ['e-nested-x', 'e-nested-y'], joinMode: 'all', joinNodeKey: 'join' },
          },
          { key: 'nested_x', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-x'] } },
          { key: 'nested_y', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-y'] } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-cond-nested', source: 'cond_1', target: 'nested_fork' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-nested-x', source: 'nested_fork', target: 'nested_x' },
          { key: 'e-nested-y', source: 'nested_fork', target: 'nested_y' },
          { key: 'e-nx-join', source: 'nested_x', target: 'join' },
          { key: 'e-ny-join', source: 'nested_y', target: 'join' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().createTemplate({
        key: 'join-reach-nested',
        name: 'Join Reach Nested',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'approvalGraph parallel branch cannot contain nested parallel node nested_fork',
      })
    })

    it('negative: cycle on a NON-first condition path is rejected', async () => {
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
              defaultEdgeKey: 'e-cond-cycle',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-high'] } },
          { key: 'cycle_a', type: 'cc', config: { targetType: 'user', targetIds: ['watcher-a'] } },
          { key: 'cycle_b', type: 'cc', config: { targetType: 'user', targetIds: ['watcher-b'] } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-b'] } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-cond-cycle', source: 'cond_1', target: 'cycle_a' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-a-b', source: 'cycle_a', target: 'cycle_b' },
          { key: 'e-b-a', source: 'cycle_b', target: 'cycle_a' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().createTemplate({
        key: 'join-reach-cycle',
        name: 'Join Reach Cycle',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'approvalGraph parallel branch contains a cycle near cycle_a',
      })
    })

    it('strengthens static duplicate-assignee collection across ALL condition paths', async () => {
      // Branch A: rules arm → user-high (unique); default arm → user-shared.
      // Branch B: user-shared. First-edge-only only saw user-high and accepted the overlap.
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['e-fork-cond', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
          {
            key: 'cond_1',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'e-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' }],
              defaultEdgeKey: 'e-cond-low',
            },
          },
          { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-high'] } },
          { key: 'approval_low', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-shared'] } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-shared'] } },
          { key: 'join', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['final-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-start-fork', source: 'start', target: 'fork' },
          { key: 'e-fork-cond', source: 'fork', target: 'cond_1' },
          { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'e-cond-high', source: 'cond_1', target: 'approval_high' },
          { key: 'e-cond-low', source: 'cond_1', target: 'approval_low' },
          { key: 'e-high-join', source: 'approval_high', target: 'join' },
          { key: 'e-low-join', source: 'approval_low', target: 'join' },
          { key: 'e-b-join', source: 'branch_b', target: 'join' },
          { key: 'e-join-end', source: 'join', target: 'end' },
        ],
      }
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().createTemplate({
        key: 'join-reach-dup',
        name: 'Join Reach Dup',
        formSchema: { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] },
        approvalGraph: graph,
      } as never)).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: "approvalGraph parallel node fork has duplicate approver 'user-shared' across branches",
      })
    })
  })

  it('rejects empty assigneeSources and invalid form field sources before hitting the database', async () => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await expect(service.createTemplate({
      key: 'empty-sources',
      name: 'Empty Sources',
      formSchema: { fields: [] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'approval_1', type: 'approval', config: { assigneeSources: [] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
          { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
        ],
      },
    } as never)).rejects.toMatchObject({
      message: 'approvalGraph.nodes[1].config.assigneeSources must not be empty',
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    })

    await expect(service.createTemplate({
      key: 'bad-field-source',
      name: 'Bad Field Source',
      formSchema: {
        fields: [
          { id: 'notes', type: 'text', label: 'Notes' },
        ],
      },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            config: { assigneeSources: [{ kind: 'form_field_user', fieldId: 'notes' }] },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
          { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
        ],
      },
    } as never)).rejects.toMatchObject({
      message: 'approvalGraph node approval_1 assigneeSources form_field_user must reference a user field',
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
      if (statement.startsWith('SELECT form_schema FROM approval_template_versions WHERE id = $1')) {
        return { rows: [{ form_schema: { fields: [] } }], rowCount: 1 }
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
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

    expect(completionEventState.emitApprovalCompletionEvent).toHaveBeenCalledTimes(1)
    expect(completionEventState.emitApprovalCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'approval.approved',
      approval: expect.objectContaining({
        templateId: 'tpl-1',
        templateVersionId: 'ver-1',
        publishedDefinitionId: 'pub-1',
        businessKey: 'auto',
        workflowKey: 'approval-product-template',
      }),
      transition: expect.objectContaining({
        action: 'auto_approve',
        fromStatus: null,
        toStatus: 'approved',
        fromVersion: null,
        toVersion: 0,
        nodeKey: null,
      }),
      actor: null,
      requester: { id: 'user-1' },
    }))
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
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

  // B3-08 (模板治理 — 停用/启用 + 用量): archiveTemplate/unarchiveTemplate is the only way to REACH
  // (or leave) the `archived` status; the pre-existing `bundle.template.status !== 'published'` gate
  // in assembleCreationContext (exercised above) already fails closed for it. These tests prove (a)
  // the transition itself is a real, transactional status flip and (b) chaining it into createApproval
  // is non-vacuous — the create-time gate only actually fires because the stored row changed.
  describe('B3-08 template archive/unarchive + usage', () => {
    function mockArchiveTransactionClient(templateRow: Record<string, unknown>, versionRow: Record<string, unknown>) {
      pgState.client.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
          return { rows: [], rowCount: 0 }
        }
        // Must be checked BEFORE the plain (no FOR UPDATE) branch below — the FOR UPDATE text is a
        // superset prefix match of the plain one.
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) {
          return { rows: [templateRow], rowCount: 1 }
        }
        if (statement.startsWith('UPDATE approval_templates SET status = $1, updated_at = now() WHERE id = $2')) {
          templateRow.status = params[0]
          return { rows: [], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
          return { rows: [templateRow], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1 AND template_id = $2')) {
          return { rows: [versionRow], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`Unhandled client query: ${statement}`)
      })
    }

    function buildTemplateRow(overrides: Record<string, unknown> = {}) {
      return {
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
        ...overrides,
      }
    }

    function buildVersionRow(runtimeGraph: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
      return {
        id: 'ver-2',
        template_id: 'tpl-1',
        version: 2,
        status: 'published',
        form_schema: { fields: [] },
        approval_graph: runtimeGraph,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
      }
    }

    it('archives a published template', async () => {
      const templateRow = buildTemplateRow({ status: 'published' })
      const versionRow = buildVersionRow(buildRuntimeGraph())
      mockArchiveTransactionClient(templateRow, versionRow)

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService(buildNoopMetrics() as never)

      const updated = await service.archiveTemplate('tpl-1')
      expect(updated.status).toBe('archived')
      expect(templateRow.status).toBe('archived')
    })

    it('rejects archiving a template that is not published (state-machine guard, no write happens)', async () => {
      const templateRow = buildTemplateRow({ status: 'draft' })
      const versionRow = buildVersionRow(buildRuntimeGraph())
      mockArchiveTransactionClient(templateRow, versionRow)

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService(buildNoopMetrics() as never)

      await expect(service.archiveTemplate('tpl-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'APPROVAL_TEMPLATE_ARCHIVE_INVALID_STATUS',
      })
      // Non-vacuous: the guard must reject BEFORE issuing the UPDATE.
      expect(templateRow.status).toBe('draft')
      const updateCall = pgState.client.query.mock.calls.find(([sql]) =>
        normalize(sql as string).startsWith('UPDATE approval_templates SET status = $1'))
      expect(updateCall).toBeUndefined()
    })

    it('unarchives an archived template and lets a subsequent createApproval succeed again', async () => {
      const runtimeGraph = buildRuntimeGraph()
      const templateRow = buildTemplateRow({ status: 'archived' })
      const versionRow = buildVersionRow(runtimeGraph)
      mockArchiveTransactionClient(templateRow, versionRow)

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService(buildNoopMetrics() as never)

      const updated = await service.unarchiveTemplate('tpl-1')
      expect(updated.status).toBe('published')
      expect(templateRow.status).toBe('published')

      // Reversibility: createApproval reads through `pool.query` (not `client.query`) for the
      // template bundle — mock it to return the SAME now-published row.
      pgState.pool.query.mockImplementation(async (sql: string) => {
        const statement = normalize(sql)
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
          return { rows: [templateRow], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
          return { rows: [versionRow], rowCount: 1 }
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
          return { rows: [{ request_no: 'AP-101002' }], rowCount: 1 }
        }
        throw new Error(`Unhandled pool query: ${statement}`)
      })
      pgState.client.query.mockImplementation(async (sql: string) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (statement.startsWith('INSERT INTO approval_instances')) return { rows: [], rowCount: 1 }
        if (statement.startsWith('INSERT INTO approval_assignments')) return { rows: [], rowCount: 1 }
        if (statement.startsWith('INSERT INTO approval_records')) return { rows: [], rowCount: 1 }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
      })
      // createApproval's final step re-reads the freshly-inserted instance via getApproval — stub
      // it out (as the existing "creates new approvals..." test above does) since exercising THAT
      // read is not what this test is about.
      vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
        templateVersionId: 'ver-2',
        publishedDefinitionId: 'pub-2',
      }))

      await expect(service.createApproval(
        { templateId: 'tpl-1', formData: {} },
        { userId: 'requester-1' },
      )).resolves.toBeDefined()
    })

    it('rejects unarchiving a template that is not archived', async () => {
      const templateRow = buildTemplateRow({ status: 'published' })
      const versionRow = buildVersionRow(buildRuntimeGraph())
      mockArchiveTransactionClient(templateRow, versionRow)

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService(buildNoopMetrics() as never)

      await expect(service.unarchiveTemplate('tpl-1')).rejects.toMatchObject({
        statusCode: 409,
        code: 'APPROVAL_TEMPLATE_UNARCHIVE_INVALID_STATUS',
      })
      expect(templateRow.status).toBe('published')
    })

    it('mutation-proof: archiving a template is what makes createApproval reject it — the create-time gate only fires because the stored status actually flipped', async () => {
      const runtimeGraph = buildRuntimeGraph()
      const templateRow = buildTemplateRow({ status: 'published' })
      const versionRow = buildVersionRow(runtimeGraph)
      mockArchiveTransactionClient(templateRow, versionRow)

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService(buildNoopMetrics() as never)

      await service.archiveTemplate('tpl-1')
      expect(templateRow.status).toBe('archived')

      pgState.pool.query.mockImplementation(async (sql: string) => {
        const statement = normalize(sql)
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
          return { rows: [templateRow], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
          return { rows: [versionRow], rowCount: 1 }
        }
        if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`Unhandled pool query: ${statement}`)
      })

      await expect(service.createApproval(
        { templateId: 'tpl-1', formData: {} },
        { userId: 'requester-1' },
      )).rejects.toMatchObject({
        statusCode: 409,
        code: 'APPROVAL_TEMPLATE_NOT_PUBLISHED',
      })
    })

    it('getTemplateUsage reports total + still-in-flight instance counts scoped to the template', async () => {
      pgState.pool.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        const statement = normalize(sql)
        if (statement.startsWith('SELECT id FROM approval_templates WHERE id = $1')) {
          return { rows: [{ id: 'tpl-1' }], rowCount: 1 }
        }
        if (statement.startsWith('SELECT COUNT(*)::text AS total_count')) {
          expect(params[0]).toBe('tpl-1')
          expect(params[1]).toEqual(['approved', 'rejected', 'revoked', 'cancelled'])
          return { rows: [{ total_count: '5', active_count: '2' }], rowCount: 1 }
        }
        throw new Error(`Unhandled pool query: ${statement}`)
      })

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService(buildNoopMetrics() as never)

      await expect(service.getTemplateUsage('tpl-1')).resolves.toEqual({
        templateId: 'tpl-1',
        instanceCount: 5,
        activeInstanceCount: 2,
      })
    })

    it('getTemplateUsage 404s for a template that does not exist', async () => {
      pgState.pool.query.mockImplementation(async (sql: string) => {
        const statement = normalize(sql)
        if (statement.startsWith('SELECT id FROM approval_templates WHERE id = $1')) {
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`Unhandled pool query: ${statement}`)
      })

      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const service = new ApprovalProductService(buildNoopMetrics() as never)

      await expect(service.getTemplateUsage('tpl-missing')).rejects.toMatchObject({
        statusCode: 404,
        code: 'APPROVAL_TEMPLATE_NOT_FOUND',
      })
    })
  })

  // RA-1a wedge guard (error-vs-empty split): a transient directory-read failure must not freeze an
  // absent department into a downstream requester.department condition (which would wedge every later
  // approval, admin-cancel only). A read that THROWS fails the create fast; a read that SUCCEEDS with no
  // department proceeds (genuine absence — runtime fail-closes per the lock, never blocks the requester).
  const wedgeGraph = {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['mgr-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'condition_1', type: 'condition', config: { branches: [{ edgeKey: 'eng', rules: [], formula: { expression: "requester.department == 'Eng'" } }], defaultEdgeKey: 'other' } },
      { key: 'approval_eng', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['eng-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'approval_other', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['oth-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'condition_1' },
      { key: 'eng', source: 'condition_1', target: 'approval_eng' },
      { key: 'other', source: 'condition_1', target: 'approval_other' },
      { key: 'e3', source: 'approval_eng', target: 'end' },
      { key: 'e4', source: 'approval_other', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
  function mountWedgeSql(graph: unknown = wedgeGraph) {
    pgState.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
        return { rows: [{ id: 'tpl-1', key: 'travel', name: 'Travel', description: null, category: null, visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'published', active_version_id: 'ver-2', latest_version_id: 'ver-2', created_at: new Date(), updated_at: new Date() }], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return { rows: [{ id: 'ver-2', template_id: 'tpl-1', version: 2, status: 'published', form_schema: { fields: [] }, approval_graph: graph, created_at: new Date(), updated_at: new Date() }], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return { rows: [{ id: 'pub-2', template_id: 'tpl-1', template_version_id: 'ver-2', runtime_graph: graph, is_active: true, published_at: new Date() }], rowCount: 1 }
      }
      if (statement.startsWith(`SELECT 'AP-' || nextval('approval_request_no_seq')::text AS request_no`)) {
        return { rows: [{ request_no: 'AP-101050' }], rowCount: 1 }
      }
      throw new Error(`Unhandled pool query: ${statement}`)
    })
    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (statement.startsWith('SELECT assignment_type, assignee_id, node_key FROM approval_assignments')) return { rows: [], rowCount: 0 }
      if (statement.startsWith('INSERT INTO approval_instances')) return { rows: [], rowCount: 1 }
      if (statement.startsWith('INSERT INTO approval_assignments')) return { rows: [], rowCount: 1 }
      if (statement.startsWith('INSERT INTO approval_records')) return { rows: [], rowCount: 1 }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
    })
  }

  it('RA-1a wedge guard: fails create fast (503) when the directory read THROWS and the graph routes on requester.department', async () => {
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockRejectedValue(new Error('transient directory read failure'))
    mountWedgeSql()
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'APPROVAL_REQUESTER_DEPARTMENT_UNRESOLVED' })
  })

  it('RA-1a wedge guard: a SUCCESSFUL read with no department also rejects AT CREATE (422) — genuine absence is fail-closed at create per the lock, never a downstream wedge', async () => {
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockResolvedValue({}) // success, but no primaryDepartmentName
    mountWedgeSql()
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'APPROVAL_REQUESTER_DEPARTMENT_REQUIRED' })
  })

  // P1 fix: detection is token-aware (AST), so a quoted "requester.department" is NOT a requester reference.
  const literalGraph = {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['mgr-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'condition_1', type: 'condition', config: { branches: [{ edgeKey: 'eng', rules: [], formula: { expression: '"requester.department" == "x"' } }], defaultEdgeKey: 'other' } },
      { key: 'approval_eng', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['eng-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'approval_other', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['oth-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'condition_1' },
      { key: 'eng', source: 'condition_1', target: 'approval_eng' },
      { key: 'other', source: 'condition_1', target: 'approval_other' },
      { key: 'e3', source: 'approval_eng', target: 'end' },
      { key: 'e4', source: 'approval_other', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }

  it('RA-1a guard detection is token-aware — a quoted "requester.department" is not a requester reference (P1)', () => {
    expect(formulaReferencesRequesterAttribute("requester.department == 'Eng'", 'department')).toBe(true)
    expect(formulaReferencesRequesterAttribute('NOT (requester.department == "Eng")', 'department')).toBe(true)
    expect(formulaReferencesRequesterAttribute('"requester.department" == "x"', 'department')).toBe(false)
    expect(formulaReferencesRequesterAttribute('{reason} == "requester.department"', 'department')).toBe(false)
    expect(formulaReferencesRequesterAttribute('{amount} > 5', 'department')).toBe(false)
  })

  it('RA-1a wedge guard does NOT fire for a string-literal "requester.department" — create succeeds with no department (P1)', async () => {
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockResolvedValue({}) // no department
    mountWedgeSql(literalGraph)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' })).resolves.toBeTruthy()
  })

  // requester.title wedge guard — same error-vs-empty split as department. A title-routed condition
  // downstream of an approval node would otherwise freeze an absent title into the snapshot and wedge every
  // later approval (admin-cancel only); reject at create instead, distinguishing transient-read (503) from
  // genuine row-level absence (422).
  const titleWedgeGraph = {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['mgr-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'condition_1', type: 'condition', config: { branches: [{ edgeKey: 'mgr', rules: [], formula: { expression: "requester.title == '经理'" } }], defaultEdgeKey: 'other' } },
      { key: 'approval_mgr', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['m-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'approval_other', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['oth-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'condition_1' },
      { key: 'mgr', source: 'condition_1', target: 'approval_mgr' },
      { key: 'other', source: 'condition_1', target: 'approval_other' },
      { key: 'e3', source: 'approval_mgr', target: 'end' },
      { key: 'e4', source: 'approval_other', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
  const titleLiteralGraph = {
    ...titleWedgeGraph,
    nodes: titleWedgeGraph.nodes.map((node) =>
      node.key === 'condition_1'
        ? { ...node, config: { branches: [{ edgeKey: 'mgr', rules: [], formula: { expression: '"requester.title" == "x"' } }], defaultEdgeKey: 'other' } }
        : node),
  }

  it('title wedge guard: fails create fast (503) when the directory read THROWS and the graph routes on requester.title', async () => {
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockRejectedValue(new Error('transient directory read failure'))
    mountWedgeSql(titleWedgeGraph)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'APPROVAL_REQUESTER_TITLE_UNRESOLVED' })
  })

  it('title wedge guard: a SUCCESSFUL read with no title also rejects AT CREATE (422) — genuine absence is fail-closed at create', async () => {
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockResolvedValue({}) // success, but no primaryTitle
    mountWedgeSql(titleWedgeGraph)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'APPROVAL_REQUESTER_TITLE_REQUIRED' })
  })

  it('title guard detection is token-aware — a quoted "requester.title" is not a requester reference', () => {
    expect(formulaReferencesRequesterAttribute("requester.title == '经理'", 'title')).toBe(true)
    expect(formulaReferencesRequesterAttribute('NOT (requester.title == "经理")', 'title')).toBe(true)
    expect(formulaReferencesRequesterAttribute('"requester.title" == "x"', 'title')).toBe(false)
    expect(formulaReferencesRequesterAttribute('{reason} == "requester.title"', 'title')).toBe(false)
  })

  it('title wedge guard does NOT fire for a string-literal "requester.title" — create succeeds with no title', async () => {
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockResolvedValue({}) // no title
    mountWedgeSql(titleLiteralGraph)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' })).resolves.toBeTruthy()
  })

  // requester.role wedge guard — RA-1b CURATED-VOCABULARY makes role a PREDICATE, not a routing key, so it
  // DIVERGES from department/title: only a TRANSIENT read failure fails create closed (503). A successful
  // GENUINE-EMPTY curated set is NOT rejected — it freezes [] and routes to DEFAULT (membership = false).
  // The role-id set is resolved by the SEPARATE user_roles resolver (mocked here).
  const roleWedgeGraph = {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['mgr-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'condition_1', type: 'condition', config: { branches: [{ edgeKey: 'fin', rules: [], formula: { expression: 'requester.role in ["finance_approver","admin"]' } }], defaultEdgeKey: 'other' } },
      { key: 'approval_fin', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['f-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'approval_other', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['oth-1'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'condition_1' },
      { key: 'fin', source: 'condition_1', target: 'approval_fin' },
      { key: 'other', source: 'condition_1', target: 'approval_other' },
      { key: 'e3', source: 'approval_fin', target: 'end' },
      { key: 'e4', source: 'approval_other', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
  const roleLiteralGraph = {
    ...roleWedgeGraph,
    nodes: roleWedgeGraph.nodes.map((node) =>
      node.key === 'condition_1'
        ? { ...node, config: { branches: [{ edgeKey: 'fin', rules: [], formula: { expression: '"requester.role" == "x"' } }], defaultEdgeKey: 'other' } }
        : node),
  }

  it('role wedge guard: fails create fast (503) when the user_roles read THROWS and the graph routes on requester.role', async () => {
    roleResolverState.resolveApprovalRequesterRoleIds.mockRejectedValue(new Error('transient user_roles read failure'))
    mountWedgeSql(roleWedgeGraph)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'APPROVAL_REQUESTER_ROLE_UNRESOLVED' })
  })

  it('role GENUINE-EMPTY: a SUCCESSFUL read with NO curated roles does NOT 422 — create succeeds (routes to DEFAULT)', async () => {
    // RA-1b: role is a predicate. Empty curated set must NOT reject at create (unlike department/title); it
    // freezes [] and the condition takes its default edge. Only a thrown read fails closed (503, above).
    roleResolverState.resolveApprovalRequesterRoleIds.mockResolvedValue([]) // success, but no curated roles
    mountWedgeSql(roleWedgeGraph)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' }))
      .resolves.toBeTruthy()
  })

  it('role guard detection is token-aware — a quoted "requester.role" is not a requester reference', () => {
    expect(formulaReferencesRequesterAttribute('requester.role in ["a","b"]', 'role')).toBe(true)
    expect(formulaReferencesRequesterAttribute('NOT (requester.role in ["a"])', 'role')).toBe(true)
    expect(formulaReferencesRequesterAttribute('"requester.role" == "x"', 'role')).toBe(false)
    expect(formulaReferencesRequesterAttribute('{reason} == "requester.role"', 'role')).toBe(false)
  })

  it('role wedge guard does NOT fire for a string-literal "requester.role" — create succeeds and the resolver is never called', async () => {
    roleResolverState.resolveApprovalRequesterRoleIds.mockResolvedValue([]) // would 422 if invoked
    mountWedgeSql(roleLiteralGraph)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' })).resolves.toBeTruthy()
    // gated query: a non-role graph must not even read user_roles.
    expect(roleResolverState.resolveApprovalRequesterRoleIds).not.toHaveBeenCalled()
  })

  it('role wedge guard does NOT fire when the resolver returns a non-empty role set — create succeeds', async () => {
    roleResolverState.resolveApprovalRequesterRoleIds.mockResolvedValue(['admin'])
    mountWedgeSql(roleWedgeGraph)
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({ templateVersionId: 'ver-2', publishedDefinitionId: 'pub-2' }))
    await expect(service.createApproval({ templateId: 'tpl-1', formData: {} }, { userId: 'requester-1' })).resolves.toBeTruthy()
    expect(roleResolverState.resolveApprovalRequesterRoleIds).toHaveBeenCalledTimes(1)
  })

  it('bakes the manager chain into the persisted requester snapshot for a manager_at_level graph', async () => {
    // Regression for the bake-gate gap: prove createApproval ITSELF wires the
    // scanner result through to the snapshot — not just the resolver. The org
    // directory walk is mocked (covered by approval-manager-chain tests); it
    // returns the chain ONLY when createApproval passes includeManagerChain:true,
    // so this also goes red if that wiring (includeManagerChain: needsManagerChain)
    // is removed.
    orgRelationsState.resolveApprovalRequesterOrgRelations.mockImplementation(
      async (_userId: string, _query: unknown, options?: { includeManagerChain?: boolean }) =>
        options?.includeManagerChain
          ? { managerId: 'u-m1', managerChainIds: ['u-m1', 'u-m2'] }
          : {},
    )

    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: {
            assigneeSources: [{ kind: 'manager_at_level', level: 1 }],
            emptyAssigneePolicy: 'auto-approve',
          },
        },
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
            id: 'tpl-1', key: 'travel', name: 'Travel Approval', description: null,
            category: null, visibility_scope: { type: 'all', ids: [] }, sla_hours: null,
            status: 'published', active_version_id: 'ver-2', latest_version_id: 'ver-2',
            created_at: new Date(), updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return {
          rows: [{
            id: 'ver-2', template_id: 'tpl-1', version: 2, status: 'published',
            form_schema: { fields: [] }, approval_graph: runtimeGraph,
            created_at: new Date(), updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return {
          rows: [{
            id: 'pub-2', template_id: 'tpl-1', template_version_id: 'ver-2',
            runtime_graph: runtimeGraph, is_active: true, published_at: new Date(),
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
      if (statement.startsWith('SELECT assignment_type, assignee_id, node_key FROM approval_assignments')) {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) return { rows: [], rowCount: 1 }
      if (statement.startsWith('INSERT INTO approval_assignments')) return { rows: [], rowCount: 1 }
      if (statement.startsWith('INSERT INTO approval_records')) return { rows: [], rowCount: 1 }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
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

    // Scanner saw manager_at_level -> createApproval asked the resolver for the chain.
    expect(orgRelationsState.resolveApprovalRequesterOrgRelations).toHaveBeenCalledWith(
      'requester-1',
      expect.anything(),
      { includeManagerChain: true },
    )

    // And the chain is baked into the PERSISTED requester snapshot (INSERT param $5 / index 4),
    // not merely present on a transient resolver return.
    const insertInstance = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_instances'))
    const requesterSnapshot = JSON.parse(String(insertInstance?.[1]?.[4]))
    expect(requesterSnapshot.managerChainIds).toEqual(['u-m1', 'u-m2'])
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
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

  it('uses deterministic requester precedence when multiple auto-approval rules match', async () => {
    const runtimeGraph = buildRuntimeGraph({
      autoApproval: {
        mergeWithRequester: true,
        dedupeHistoricalApprover: true,
      },
    })
    mockPublishedTemplatePool(runtimeGraph, 'AP-101005')
    mockInsertOnlyClient()

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
      JSON.parse(String(params?.[9])).autoApproved === true)
    expect(JSON.parse(String(autoRecordCall?.[1]?.[9]))).toMatchObject({
      reason: 'auto-merge-requester',
      policySource: 'template',
      originalApprover: {
        type: 'user',
        id: 'manager-1',
      },
    })
  })

  it('does not double-emit when empty-assignee auto approval coexists with requester merge policy', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: [],
            emptyAssigneePolicy: 'auto-approve',
            autoApprovalPolicy: { mergeWithRequester: true },
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
        autoApproval: {
          mergeWithRequester: true,
        },
      },
    }
    mockPublishedTemplatePool(runtimeGraph, 'AP-101006')
    mockInsertOnlyClient()

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

    const autoRecordCalls = pgState.client.query.mock.calls
      .filter(([sql, params]) =>
        normalize(sql as string).startsWith('INSERT INTO approval_records') &&
        JSON.parse(String(params?.[9])).autoApproved === true)
    const autoRecords = autoRecordCalls.map(([, params]) => JSON.parse(String(params?.[9])))

    expect(autoRecords).toHaveLength(1)
    expect(autoRecordCalls[0]?.[1]?.[2]).toBe('system:auto-approval')
    expect(autoRecords[0]).toMatchObject({
      reason: 'empty-assignee',
      nodeKey: 'approval_1',
    })
  })

  it('keeps pre-pr2 runtime graphs without autoApproval behavior unchanged', async () => {
    const runtimeGraph = buildRuntimeGraph()
    mockPublishedTemplatePool(runtimeGraph, 'AP-101007')
    mockInsertOnlyClient()

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
      JSON.parse(String(params?.[9])).autoApproved === true)).toBe(false)
  })

  it('creates requester-source assignments from the frozen published runtime graph with metadata', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }
    mockPublishedTemplatePool(runtimeGraph, 'AP-101008')

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('SELECT assignment_type, assignee_id, node_key FROM approval_assignments')) {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_assignments')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      currentNodeKey: 'approval_1',
      assignments: [{
        id: 'asg-requester',
        type: 'user',
        assigneeId: 'requester-1',
        sourceStep: 1,
        nodeKey: 'approval_1',
        isActive: true,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } },
      }],
    }))

    await service.createApproval(
      { templateId: 'tpl-1', formData: {} },
      { userId: 'requester-1', userName: 'Requester One' },
    )

    const assignmentInsert = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))
    expect(assignmentInsert?.[1]).toEqual([
      expect.any(String),
      'user',
      'requester-1',
      1,
      'approval_1',
      1, // entry_epoch (nodeEntryEpoch): the initial activation's bumped node_activation_seq
      JSON.stringify({ resolvedFrom: { kind: 'requester', sourceIndex: 0 } }),
    ])
  })

  it('creates, publishes, and starts an authoring-MVP template through the compiled runtime graph', async () => {
    const formSchema = {
      fields: [
        { id: 'amount', type: 'number', label: 'Amount', required: true },
        { id: 'reviewer', type: 'user', label: 'Reviewer', required: true },
      ],
    }
    const approvalGraph = {
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

    let templateRow: Record<string, unknown> | null = null
    let versionRow: Record<string, unknown> | null = null
    let publishedDefinitionRow: Record<string, unknown> | null = null

    pgState.pool.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1')) {
        return { rows: templateRow ? [templateRow] : [], rowCount: templateRow ? 1 : 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) {
        return { rows: versionRow ? [versionRow] : [], rowCount: versionRow ? 1 : 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions')) {
        return {
          rows: publishedDefinitionRow ? [publishedDefinitionRow] : [],
          rowCount: publishedDefinitionRow ? 1 : 0,
        }
      }
      if (statement.startsWith(`SELECT 'AP-' || nextval('approval_request_no_seq')::text AS request_no`)) {
        return { rows: [{ request_no: 'AP-101010' }], rowCount: 1 }
      }
      throw new Error(`Unhandled pool query: ${statement}`)
    })

    pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_templates')) {
        templateRow = {
          id: 'tpl-chain',
          key: String(params?.[0]),
          name: String(params?.[1]),
          description: params?.[2] == null ? null : String(params?.[2]),
          category: null,
          visibility_scope: JSON.parse(String(params?.[4])),
          sla_hours: null,
          status: 'draft',
          active_version_id: null,
          latest_version_id: null,
          created_at: new Date('2026-06-05T00:00:00.000Z'),
          updated_at: new Date('2026-06-05T00:00:00.000Z'),
        }
        return { rows: [templateRow], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_template_versions')) {
        versionRow = {
          id: 'ver-chain',
          template_id: String(params?.[0]),
          version: 1,
          status: 'draft',
          form_schema: JSON.parse(String(params?.[1])),
          approval_graph: JSON.parse(String(params?.[2])),
          created_at: new Date('2026-06-05T00:00:00.000Z'),
          updated_at: new Date('2026-06-05T00:00:00.000Z'),
        }
        return { rows: [versionRow], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_templates SET latest_version_id')) {
        templateRow = {
          ...templateRow,
          latest_version_id: String(params?.[0]),
          updated_at: new Date('2026-06-05T00:01:00.000Z'),
        }
        return { rows: [templateRow], rowCount: 1 }
      }
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) {
        return { rows: templateRow ? [templateRow] : [], rowCount: templateRow ? 1 : 0 }
      }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1 AND template_id = $2')) {
        return { rows: versionRow ? [versionRow] : [], rowCount: versionRow ? 1 : 0 }
      }
      if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_published_definitions')) {
        publishedDefinitionRow = {
          id: 'pub-chain',
          template_id: String(params?.[0]),
          template_version_id: String(params?.[1]),
          runtime_graph: JSON.parse(String(params?.[2])),
          is_active: true,
          published_at: new Date('2026-06-05T00:02:00.000Z'),
        }
        return { rows: [publishedDefinitionRow], rowCount: 1 }
      }
      if (statement.startsWith("UPDATE approval_template_versions SET status = 'published'")) {
        versionRow = {
          ...versionRow,
          status: 'published',
          updated_at: new Date('2026-06-05T00:03:00.000Z'),
        }
        return { rows: [versionRow], rowCount: 1 }
      }
      if (statement.startsWith("UPDATE approval_templates SET status = 'published'")) {
        templateRow = {
          ...templateRow,
          status: 'published',
          active_version_id: String(params?.[0]),
          updated_at: new Date('2026-06-05T00:04:00.000Z'),
        }
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('SELECT assignment_type, assignee_id, node_key FROM approval_assignments')) {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_assignments')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      id: 'apr-chain',
      templateId: 'tpl-chain',
      templateVersionId: 'ver-chain',
      publishedDefinitionId: 'pub-chain',
      currentNodeKey: 'approval_1',
      formSnapshot: { amount: 1200, reviewer: 'approver-42' },
      assignments: [{
        id: 'asg-form-user',
        type: 'user',
        assigneeId: 'approver-42',
        sourceStep: 1,
        nodeKey: 'approval_1',
        isActive: true,
        metadata: { resolvedFrom: { kind: 'form_field_user', sourceIndex: 0, fieldId: 'reviewer' } },
      }],
    }))

    const created = await service.createTemplate({
      key: 'expense-chain',
      name: 'Expense Chain',
      visibilityScope: { type: 'all', ids: [] },
      formSchema,
      approvalGraph,
    } as never)
    const published = await service.publishTemplate(created.id, { policy: { allowRevoke: true } } as never)
    await service.createApproval(
      { templateId: created.id, formData: { amount: 1200, reviewer: 'approver-42' } },
      { userId: 'requester-1', userName: 'Requester One' },
    )

    const compiledApprovalNode = published.runtimeGraph.nodes.find((node) => node.key === 'approval_1')
    expect(compiledApprovalNode?.config).toEqual({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'reviewer' }],
      approvalMode: 'single',
      emptyAssigneePolicy: 'error',
    })

    const assignmentInsert = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))
    expect(assignmentInsert?.[1]).toEqual([
      expect.any(String),
      'user',
      'approver-42',
      1,
      'approval_1',
      1, // entry_epoch (nodeEntryEpoch): the initial activation's bumped node_activation_seq
      JSON.stringify({ resolvedFrom: { kind: 'form_field_user', sourceIndex: 0, fieldId: 'reviewer' } }),
    ])
  })

  it('rejects duplicate dynamic assignees across parallel branches at creation time', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'parallel_fork',
          type: 'parallel',
          config: {
            branches: ['edge-fork-legal', 'edge-fork-compliance'],
            joinMode: 'all',
            joinNodeKey: 'end',
          },
        },
        { key: 'legal-review', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'compliance-review', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
        { key: 'edge-fork-legal', source: 'parallel_fork', target: 'legal-review' },
        { key: 'edge-fork-compliance', source: 'parallel_fork', target: 'compliance-review' },
        { key: 'edge-legal-end', source: 'legal-review', target: 'end' },
        { key: 'edge-compliance-end', source: 'compliance-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }
    mockPublishedTemplatePool(runtimeGraph, 'AP-101009')

    pgState.client.query.mockImplementation(async (sql: string) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_instances')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled client query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)

    await expect(service.createApproval(
      { templateId: 'tpl-1', formData: {} },
      { userId: 'requester-1' },
    )).rejects.toMatchObject({
      code: 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT',
      statusCode: 409,
      details: {
        assignmentType: 'user',
        assigneeId: 'requester-1',
        nodeKeys: ['legal-review', 'compliance-review'],
      },
    })

    const statements = pgState.client.query.mock.calls.map(([sql]) => normalize(sql as string))
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(statements.some((statement) => statement.startsWith('INSERT INTO approval_assignments'))).toBe(false)
  })

  it('keeps all-mode approvals pending when requester auto-merge leaves human assignees', async () => {
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
        { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
        autoApproval: {
          mergeWithRequester: true,
        },
      },
    }
    mockPublishedTemplatePool(runtimeGraph, 'AP-101008')
    mockInsertOnlyClient()

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
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
    }))

    await service.createApproval(
      { templateId: 'tpl-1', formData: {} },
      { userId: 'manager-1' },
    )

    const assignmentInserts = pgState.client.query.mock.calls.filter(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))
    expect(assignmentInserts).toHaveLength(1)
    expect(assignmentInserts[0]?.[1]).toEqual([expect.any(String), 'user', 'manager-2', 1, 'approval_1', 1, '{}'])

    const autoRecordCall = pgState.client.query.mock.calls.find(([sql, params]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records') &&
      JSON.parse(String(params?.[9])).reason === 'auto-merge-requester')
    expect(JSON.parse(String(autoRecordCall?.[1]?.[9]))).toMatchObject({
      approvalMode: 'all',
      originalApprover: {
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
          actorMode: 'original_approver',
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
      if (statement.startsWith('UPDATE approval_instances SET metadata = COALESCE')) {
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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
    expect(completionEventState.emitApprovalCompletionEvent).toHaveBeenCalledTimes(1)
    expect(completionEventState.emitApprovalCompletionEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'approval.approved',
      approval: expect.objectContaining({
        instanceId: 'apr-1',
        requestNo: 'AP-100001',
        templateId: 'tpl-1',
        templateVersionId: 'ver-1',
        publishedDefinitionId: 'pub-1',
      }),
      transition: expect.objectContaining({
        action: 'approve',
        fromStatus: 'pending',
        toStatus: 'approved',
        fromVersion: 2,
        toVersion: 3,
        nodeKey: 'approval_a',
      }),
      actor: { id: 'manager-1', name: 'manager-1' },
      requester: { id: 'user-1' },
    }))

    const autoRecordCalls = pgState.client.query.mock.calls
      .filter(([sql, params]) =>
        normalize(sql as string).startsWith('INSERT INTO approval_records') &&
        JSON.parse(String(params?.[9])).reason === 'auto-merge-adjacent')
    const autoRecords = autoRecordCalls.map(([, params]) => JSON.parse(String(params?.[9])))

    expect(autoRecords).toHaveLength(2)
    expect(autoRecordCalls.map(([, params]) => params?.[2])).toEqual(['manager-1', 'manager-1'])
    expect(autoRecords[0]).toMatchObject({
      nodeKey: 'approval_b',
      reason: 'auto-merge-adjacent',
      actorMode: 'original_approver',
      matchedAgainst: { nodeKey: 'approval_a' },
    })
    expect(autoRecords[1]).toMatchObject({
      nodeKey: 'approval_c',
      reason: 'auto-merge-adjacent',
      actorMode: 'original_approver',
      matchedAgainst: { nodeKey: 'approval_b' },
    })
  })

  it('uses the instance-bound runtime policy snapshot when auto-approving old instances', async () => {
    const frozenRuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'approval_2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-1'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval-1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval-1-approval-2', source: 'approval_1', target: 'approval_2' },
        { key: 'edge-approval-2-end', source: 'approval_2', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
        autoApproval: {
          mergeWithRequester: true,
        },
      },
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
            published_definition_id: 'pub-old-policy',
            current_step: 1,
            total_steps: 2,
            current_node_key: 'approval_1',
          })],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT * FROM approval_published_definitions WHERE id = $1')) {
        expect(params).toEqual(['pub-old-policy'])
        return {
          rows: [{
            id: 'pub-old-policy',
            template_id: 'tpl-1',
            template_version_id: 'ver-old',
            runtime_graph: frozenRuntimeGraph,
            is_active: false,
            published_at: new Date(),
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
        expect(params).toEqual(['apr-1', 'approved', 3, null, 2, 2])
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_assignments')) {
        throw new Error('auto-merged requester should not create a human assignment')
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      status: 'approved',
      templateVersionId: 'ver-old',
      publishedDefinitionId: 'pub-old-policy',
      currentStep: 2,
      totalSteps: 2,
      currentNodeKey: null,
      assignments: [],
    }))

    const result = await service.dispatchAction(
      'apr-1',
      { action: 'approve' },
      { userId: 'manager-1' },
    )

    expect(result.status).toBe('approved')
    const statements = [
      ...pgState.client.query.mock.calls,
      ...pgState.pool.query.mock.calls,
    ].map(([sql]) => normalize(sql as string))
    expect(statements.some((statement) => statement.includes('approval_templates'))).toBe(false)
    expect(statements.some((statement) => statement.includes('approval_template_versions'))).toBe(false)
    expect(statements.some((statement) => statement.includes('active_version_id'))).toBe(false)

    const autoRecordCall = pgState.client.query.mock.calls.find(([sql, params]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records') &&
      JSON.parse(String(params?.[9])).reason === 'auto-merge-requester')
    expect(JSON.parse(String(autoRecordCall?.[1]?.[9]))).toMatchObject({
      nodeKey: 'approval_2',
      policySource: 'template',
      originalApprover: {
        type: 'user',
        id: 'user-1',
      },
    })
  })

  it('rolls back when chained auto-approval exceeds the per-dispatch guard', async () => {
    const approvalNodes = Array.from({ length: 52 }, (_, index) => ({
      key: `approval_${index + 1}`,
      type: 'approval',
      config: { assigneeType: 'user', assigneeIds: ['manager-1'] },
    }))
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        ...approvalNodes,
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval-1', source: 'start', target: 'approval_1' },
        ...Array.from({ length: 51 }, (_, index) => ({
          key: `edge-approval-${index + 1}-${index + 2}`,
          source: `approval_${index + 1}`,
          target: `approval_${index + 2}`,
        })),
        { key: 'edge-approval-52-end', source: 'approval_52', target: 'end' },
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
      if (statement === 'BEGIN' || statement === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (statement === 'COMMIT') {
        throw new Error('guard breach should not commit')
      }
      if (statement.startsWith('SELECT * FROM approval_instances WHERE id = $1')) {
        return {
          rows: [buildInstanceRow({
            current_node_key: 'approval_1',
            current_step: 1,
            total_steps: 52,
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
            id: 'asg-approval-1',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'manager-1',
            source_step: 1,
            node_key: 'approval_1',
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)

    await expect(service.dispatchAction(
      'apr-1',
      { action: 'approve' },
      { userId: 'manager-1' },
    )).rejects.toMatchObject({
      code: 'APPROVAL_AUTO_STEP_LIMIT_EXCEEDED',
      details: {
        autoSteps: 51,
        lastNodeKey: 'approval_52',
      },
    })

    const statements = pgState.client.query.mock.calls.map(([sql]) => normalize(sql as string))
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(statements.some((statement) =>
      statement.startsWith('UPDATE approval_instances SET status = $2'))).toBe(false)
    expect(statements.some((statement) =>
      statement.startsWith('INSERT INTO approval_records'))).toBe(false)
  })

  it('auto-approves independent parallel branches without duplicate active assignments', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_gate', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['lead-1'] } },
        {
          key: 'parallel_fork',
          type: 'parallel',
          config: {
            branches: ['edge-fork-legal', 'edge-fork-compliance'],
            joinMode: 'all',
            joinNodeKey: 'end',
          },
        },
        { key: 'legal-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'compliance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-2'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-gate', source: 'start', target: 'approval_gate' },
        { key: 'edge-gate-fork', source: 'approval_gate', target: 'parallel_fork' },
        { key: 'edge-fork-legal', source: 'parallel_fork', target: 'legal-review' },
        { key: 'edge-fork-compliance', source: 'parallel_fork', target: 'compliance-review' },
        { key: 'edge-legal-end', source: 'legal-review', target: 'end' },
        { key: 'edge-compliance-end', source: 'compliance-review', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
        autoApproval: {
          dedupeHistoricalApprover: true,
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
            current_node_key: 'approval_gate',
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
            id: 'asg-gate',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'lead-1',
            source_step: 1,
            node_key: 'approval_gate',
            is_active: true,
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('SELECT id, actor_id, metadata FROM approval_records')) {
        return {
          rows: [
            { id: 10, actor_id: 'manager-1', metadata: { nodeKey: 'prior-legal' } },
            { id: 11, actor_id: 'manager-2', metadata: { nodeKey: 'prior-compliance' } },
          ],
          rowCount: 2,
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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
      { userId: 'lead-1' },
    )

    expect(result.status).toBe('approved')
    expect(pgState.client.query.mock.calls.some(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))).toBe(false)

    const autoRecords = pgState.client.query.mock.calls
      .filter(([sql, params]) =>
        normalize(sql as string).startsWith('INSERT INTO approval_records') &&
        JSON.parse(String(params?.[9])).reason === 'auto-dedupe-historical')
      .map(([, params]) => JSON.parse(String(params?.[9])))

    expect(autoRecords).toHaveLength(2)
    expect(autoRecords.map((entry) => entry.nodeKey)).toEqual(['legal-review', 'compliance-review'])
    expect(autoRecords.map((entry) => entry.matchedAgainst.nodeKey)).toEqual(['prior-legal', 'prior-compliance'])
  })

  it('dispatches dynamic assignees from the instance-bound runtime graph without active template reads', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_gate', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['lead-1'] } },
        { key: 'requester-review', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-gate', source: 'start', target: 'approval_gate' },
        { key: 'edge-gate-requester', source: 'approval_gate', target: 'requester-review' },
        { key: 'edge-requester-end', source: 'requester-review', target: 'end' },
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
            current_node_key: 'approval_gate',
            current_step: 1,
            total_steps: 2,
            requester_snapshot: { id: 'requester-1', name: 'Requester One' },
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
            id: 'asg-gate',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'lead-1',
            source_step: 1,
            node_key: 'approval_gate',
            is_active: true,
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
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
      if (statement.startsWith('SELECT assignment_type, assignee_id, node_key FROM approval_assignments')) {
        return { rows: [], rowCount: 0 }
      }
      if (statement.startsWith('INSERT INTO approval_assignments')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      currentStep: 2,
      totalSteps: 2,
      currentNodeKey: 'requester-review',
      assignments: [{
        id: 'asg-requester',
        type: 'user',
        assigneeId: 'requester-1',
        sourceStep: 2,
        nodeKey: 'requester-review',
        isActive: true,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } },
      }],
    }))

    await service.dispatchAction(
      'apr-1',
      { action: 'approve' },
      { userId: 'lead-1' },
    )

    const statements = pgState.client.query.mock.calls.map(([sql]) => normalize(sql as string))
    expect(statements.some((statement) => statement.includes('approval_template_versions'))).toBe(false)
    expect(statements.some((statement) => statement.includes('approval_templates'))).toBe(false)

    const assignmentInsert = pgState.client.query.mock.calls.find(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))
    expect(assignmentInsert?.[1]).toEqual([
      'apr-1',
      'user',
      'requester-1',
      2,
      'requester-review',
      1, // entry_epoch (nodeEntryEpoch): the forward-advance activation's bumped node_activation_seq
      JSON.stringify({ resolvedFrom: { kind: 'requester', sourceIndex: 0 } }),
    ])
  })

  it('rejects duplicate dynamic assignees across parallel branches at advance time', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_gate', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['lead-1'] } },
        {
          key: 'parallel_fork',
          type: 'parallel',
          config: {
            branches: ['edge-fork-legal', 'edge-fork-compliance'],
            joinMode: 'all',
            joinNodeKey: 'end',
          },
        },
        { key: 'legal-review', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'compliance-review', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-gate', source: 'start', target: 'approval_gate' },
        { key: 'edge-gate-fork', source: 'approval_gate', target: 'parallel_fork' },
        { key: 'edge-fork-legal', source: 'parallel_fork', target: 'legal-review' },
        { key: 'edge-fork-compliance', source: 'parallel_fork', target: 'compliance-review' },
        { key: 'edge-legal-end', source: 'legal-review', target: 'end' },
        { key: 'edge-compliance-end', source: 'compliance-review', target: 'end' },
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
            current_node_key: 'approval_gate',
            current_step: 1,
            total_steps: 3,
            requester_snapshot: { id: 'requester-1', name: 'Requester One' },
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
            id: 'asg-gate',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'lead-1',
            source_step: 1,
            node_key: 'approval_gate',
            is_active: true,
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }
      }
      if (statement.startsWith('UPDATE approval_assignments SET is_active = FALSE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_instances SET metadata = COALESCE')) {
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('UPDATE approval_instances SET status = $2')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)

    await expect(service.dispatchAction(
      'apr-1',
      { action: 'approve' },
      { userId: 'lead-1' },
    )).rejects.toMatchObject({
      code: 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT',
      statusCode: 409,
      details: {
        assignmentType: 'user',
        assigneeId: 'requester-1',
        nodeKeys: ['legal-review', 'compliance-review'],
      },
    })

    const statements = pgState.client.query.mock.calls.map(([sql]) => normalize(sql as string))
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(statements.some((statement) => statement.startsWith('INSERT INTO approval_assignments'))).toBe(false)
    expect(statements.some((statement) => statement.startsWith('INSERT INTO approval_records'))).toBe(false)
  })

  it('refuses and warns when adjacent merge would auto-approve duplicate parallel assignees', async () => {
    const runtimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_gate', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        {
          key: 'parallel_fork',
          type: 'parallel',
          config: {
            branches: ['edge-fork-legal', 'edge-fork-compliance'],
            joinMode: 'all',
            joinNodeKey: 'end',
          },
        },
        { key: 'legal-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'compliance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-gate', source: 'start', target: 'approval_gate' },
        { key: 'edge-gate-fork', source: 'approval_gate', target: 'parallel_fork' },
        { key: 'edge-fork-legal', source: 'parallel_fork', target: 'legal-review' },
        { key: 'edge-fork-compliance', source: 'parallel_fork', target: 'compliance-review' },
        { key: 'edge-legal-end', source: 'legal-review', target: 'end' },
        { key: 'edge-compliance-end', source: 'compliance-review', target: 'end' },
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
            current_node_key: 'approval_gate',
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
            id: 'asg-gate',
            instance_id: 'apr-1',
            assignment_type: 'user',
            assignee_id: 'manager-1',
            source_step: 1,
            node_key: 'approval_gate',
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
      if (statement.startsWith('UPDATE approval_instances SET metadata = COALESCE')) {
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService(buildNoopMetrics() as never)
    vi.spyOn(service, 'getApproval').mockResolvedValue(buildApprovalDto({
      status: 'pending',
      currentNodeKey: 'parallel_fork',
      currentNodeKeys: ['compliance-review'],
      assignments: [{
        id: 'asg-compliance',
        type: 'user',
        assigneeId: 'manager-1',
        sourceStep: 2,
        nodeKey: 'compliance-review',
        isActive: true,
        metadata: {},
      }],
    }))

    const result = await service.dispatchAction(
      'apr-1',
      { action: 'approve' },
      { userId: 'manager-1' },
    )

    expect(result.status).toBe('pending')
    const assignmentInserts = pgState.client.query.mock.calls.filter(([sql]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_assignments'))
    expect(assignmentInserts).toHaveLength(1)
    expect(assignmentInserts[0]?.[1]).toEqual(['apr-1', 'user', 'manager-1', 3, 'compliance-review', 1, '{}'])

    const skippedRecord = pgState.client.query.mock.calls.find(([sql, params]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records') &&
      JSON.parse(String(params?.[9])).skipReason === 'cross_branch_adjacency_conflict')
    expect(skippedRecord?.[1]?.[1]).toBe('sign')
    expect(JSON.parse(String(skippedRecord?.[1]?.[9]))).toMatchObject({
      nodeKey: 'compliance-review',
      reason: 'auto-merge-adjacent',
      skipped: true,
      skipReason: 'cross_branch_adjacency_conflict',
      conflictBranches: ['legal-review', 'compliance-review'],
      originalApprover: {
        type: 'user',
        id: 'manager-1',
      },
    })

    const autoRecord = pgState.client.query.mock.calls.find(([sql, params]) =>
      normalize(sql as string).startsWith('INSERT INTO approval_records') &&
      JSON.parse(String(params?.[9])).reason === 'auto-merge-adjacent' &&
      JSON.parse(String(params?.[9])).skipped !== true)
    expect(JSON.parse(String(autoRecord?.[1]?.[9]))).toMatchObject({
      nodeKey: 'legal-review',
      reason: 'auto-merge-adjacent',
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
        expect(params).toEqual(['apr-1', 'user', 'legacy-manager', 2, 'approval_old_high', 1, '{}'])
        return { rows: [], rowCount: 1 }
      }
      if (statement.startsWith('INSERT INTO approval_records')) {
        return { rows: [], rowCount: 1 }
      }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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

  it('preserves condition formulas through publish runtime_graph and read-back DTO', async () => {
    const formSchema = {
      fields: [
        { id: 'amount', type: 'number', label: 'Amount' },
        { id: 'items', type: 'detail', label: 'Items', columns: [{ id: 'amount', type: 'number', label: 'Line Amount' }] },
      ],
    }
    const approvalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'edge-high', rules: [], formula: { expression: 'SUM({items.amount}) >= 20000' } }],
            defaultEdgeKey: 'edge-low',
          },
        },
        { key: 'high', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
        { key: 'low', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-high', source: 'route', target: 'high' },
        { key: 'edge-low', source: 'route', target: 'low' },
        { key: 'edge-high-end', source: 'high', target: 'end' },
        { key: 'edge-low-end', source: 'low', target: 'end' },
      ],
    }
    const template = {
      id: 'tpl-1',
      key: 'formula',
      name: 'Formula Approval',
      description: null,
      category: null,
      visibility_scope: { type: 'all', ids: [] },
      sla_hours: null,
      status: 'draft',
      active_version_id: null,
      latest_version_id: 'ver-2',
      created_at: new Date(),
      updated_at: new Date(),
    }
    const version = {
      id: 'ver-2',
      template_id: 'tpl-1',
      version: 2,
      status: 'draft',
      form_schema: formSchema,
      approval_graph: approvalGraph,
      created_at: new Date(),
      updated_at: new Date(),
    }

    pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const statement = normalize(sql)
      if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) return { rows: [template], rowCount: 1 }
      if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) return { rows: [version], rowCount: 1 }
      if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) return { rows: [], rowCount: 0 }
      if (statement.startsWith('INSERT INTO approval_published_definitions')) {
        const runtimeGraph = JSON.parse(String(params?.[2]))
        expect(runtimeGraph.nodes[1].config.branches[0].formula).toEqual({ expression: 'SUM({items.amount}) >= 20000' })
        return { rows: [{ id: 'pub-2', template_id: 'tpl-1', template_version_id: 'ver-2', runtime_graph: runtimeGraph, is_active: true, published_at: new Date() }], rowCount: 1 }
      }
      if (statement.startsWith("UPDATE approval_template_versions SET status = 'published'")) {
        return { rows: [{ ...version, status: 'published' }], rowCount: 1 }
      }
      if (statement.startsWith("UPDATE approval_templates SET status = 'published'")) return { rows: [], rowCount: 1 }
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const result = await new ApprovalProductService().publishTemplate('tpl-1', { policy: { allowRevoke: true } } as never)

    const condition = result.runtimeGraph?.nodes.find((node) => node.key === 'route')
    expect((condition?.config as { branches: Array<{ formula?: { expression: string } }> }).branches[0].formula)
      .toEqual({ expression: 'SUM({items.amount}) >= 20000' })
  })

  // RA-1b CURATED-VOCABULARY — publish HARD GATE. A role-routed condition must publish ONLY when every
  // requester.role literal is curated (roles.approval_usable=true); an uncurated literal fails closed.
  describe('publish curated requester.role vocabulary gate (RA-1b)', () => {
    const roleFormSchema = { fields: [] as unknown[] }
    function roleRoutedGraph(expression: string) {
      return {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'route',
            type: 'condition',
            config: {
              branches: [{ edgeKey: 'edge-high', rules: [], formula: { expression } }],
              defaultEdgeKey: 'edge-low',
            },
          },
          { key: 'high', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
          { key: 'low', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'edge-start-route', source: 'start', target: 'route' },
          { key: 'edge-high', source: 'route', target: 'high' },
          { key: 'edge-low', source: 'route', target: 'low' },
          { key: 'edge-high-end', source: 'high', target: 'end' },
          { key: 'edge-low-end', source: 'low', target: 'end' },
        ],
      }
    }
    const template = {
      id: 'tpl-1', key: 'role-formula', name: 'Role Formula', description: null, category: null,
      visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
      active_version_id: null, latest_version_id: 'ver-2', created_at: new Date(), updated_at: new Date(),
    }
    function mockPublish(expression: string, curatedRoleIds: string[]) {
      const version = {
        id: 'ver-2', template_id: 'tpl-1', version: 2, status: 'draft',
        form_schema: roleFormSchema, approval_graph: roleRoutedGraph(expression),
        created_at: new Date(), updated_at: new Date(),
      }
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const statement = normalize(sql)
        if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (statement.startsWith('SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE')) return { rows: [template], rowCount: 1 }
        if (statement.startsWith('SELECT * FROM approval_template_versions WHERE id = $1')) return { rows: [version], rowCount: 1 }
        if (statement.startsWith('UPDATE approval_published_definitions SET is_active = FALSE')) return { rows: [], rowCount: 0 }
        // RA-1b curated-set read — fetched on the transaction client, once per publish, only when role-routed.
        if (statement.startsWith('SELECT id FROM roles WHERE approval_usable')) {
          return { rows: curatedRoleIds.map((id) => ({ id })), rowCount: curatedRoleIds.length }
        }
        if (statement.startsWith('INSERT INTO approval_published_definitions')) {
          const runtimeGraph = JSON.parse(String(params?.[2]))
          return { rows: [{ id: 'pub-2', template_id: 'tpl-1', template_version_id: 'ver-2', runtime_graph: runtimeGraph, is_active: true, published_at: new Date() }], rowCount: 1 }
        }
        if (statement.startsWith("UPDATE approval_template_versions SET status = 'published'")) return { rows: [{ ...version, status: 'published' }], rowCount: 1 }
        if (statement.startsWith("UPDATE approval_templates SET status = 'published'")) return { rows: [], rowCount: 1 }
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
      })
    }

    it('publishes a CURATED requester.role literal', async () => {
      mockPublish('requester.role in ["finance_approver"]', ['finance_approver', 'expense_lead'])
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const result = await new ApprovalProductService().publishTemplate('tpl-1', { policy: { allowRevoke: true } } as never)
      expect(result.publishedDefinitionId).toBe('pub-2')
    })

    it('rejects an UNCURATED requester.role literal at publish (APPROVAL_REQUESTER_ROLE_NOT_CURATED, 400)', async () => {
      // "admin" is a SYSTEM role NOT in the curated set — the boundary the owner sharpened.
      mockPublish('requester.role in ["admin"]', ['finance_approver'])
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(
        new ApprovalProductService().publishTemplate('tpl-1', { policy: { allowRevoke: true } } as never),
      ).rejects.toMatchObject({
        code: 'APPROVAL_REQUESTER_ROLE_NOT_CURATED',
        statusCode: 400,
        message: expect.stringContaining('admin'),
      })
    })
  })

  it('snapshots publish-time auto-approval policy into runtime_graph without a migration column', async () => {
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

    pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
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
        const insertedRuntimeGraph = JSON.parse(String(params?.[2]))
        expect(insertedRuntimeGraph.policy.autoApproval).toEqual({
          mergeWithRequester: true,
          mergeAdjacentApprover: true,
          actorMode: 'system',
        })
        return {
          rows: [{
            id: 'pub-2',
            template_id: 'tpl-1',
            template_version_id: 'ver-2',
            runtime_graph: insertedRuntimeGraph,
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
    })

    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()

    await service.publishTemplate('tpl-1', {
      policy: {
        allowRevoke: true,
        autoApproval: {
          mergeWithRequester: true,
          mergeAdjacentApprover: true,
          actorMode: 'system',
        },
      },
    } as never)

    const statements = pgState.client.query.mock.calls.map(([sql]) => normalize(sql as string))
    expect(statements.some((statement) => statement.includes('auto_approval_policy'))).toBe(false)
    expect(statements.some((statement) => statement.includes('ALTER TABLE'))).toBe(false)
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
        { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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
      { const epochResult = epochMockResult(statement); if (epochResult) return epochResult } throw new Error(`Unhandled query: ${statement}`)
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

  describe('T2-4 threshold (N-of-M) mode publish validation', () => {
    const createTemplate = async (request: unknown) => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      return new ApprovalProductService().createTemplate(request as never)
    }

    const thresholdGraph = (approvalConfig: Record<string, unknown>) => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_threshold', type: 'approval', config: approvalConfig },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-threshold', source: 'start', target: 'approval_threshold' },
        { key: 'edge-threshold-end', source: 'approval_threshold', target: 'end' },
      ],
      policy: { allowRevoke: true },
    })

    const baseRequest = (graph: Record<string, unknown>) => ({
      key: 'threshold-tpl',
      name: 'Threshold Tpl',
      visibilityScope: { type: 'all', ids: [] },
      formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
      approvalGraph: graph,
    })

    it('rejects an empty parallel branch that connects the fork directly to its join', async () => {
      const graph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['empty', 'review'], joinMode: 'any', joinNodeKey: 'end' } },
          { key: 'reviewer', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['reviewer-1'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'start-fork', source: 'start', target: 'fork' },
          { key: 'empty', source: 'fork', target: 'end' },
          { key: 'review', source: 'fork', target: 'reviewer' },
          { key: 'review-end', source: 'reviewer', target: 'end' },
        ],
        policy: { allowRevoke: true },
      }
      const rejection = createTemplate(baseRequest(graph))
      await expect(rejection).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
      })
      await expect(rejection).rejects.not.toMatchObject({
        message: expect.stringMatching(/fork|empty|end/),
      })
    })

    it('rejects a threshold node whose N exceeds the distinct static approver count', async () => {
      // N=4 against 3 distinct static users → out of range.
      await expect(createTemplate(baseRequest(thresholdGraph({
        assigneeType: 'user',
        assigneeIds: ['u-a', 'u-b', 'u-c'],
        approvalMode: 'threshold',
        approvalThreshold: 4,
      })))).rejects.toMatchObject({
        code: 'APPROVAL_THRESHOLD_OUT_OF_RANGE',
        statusCode: 400,
      })
    })

    it('rejects a threshold node with a non-positive / non-integer threshold', async () => {
      await expect(createTemplate(baseRequest(thresholdGraph({
        assigneeType: 'user',
        assigneeIds: ['u-a', 'u-b'],
        approvalMode: 'threshold',
        approvalThreshold: 0,
      })))).rejects.toMatchObject({
        code: 'APPROVAL_THRESHOLD_INVALID',
        statusCode: 400,
      })

      await expect(createTemplate(baseRequest(thresholdGraph({
        assigneeType: 'user',
        assigneeIds: ['u-a', 'u-b'],
        approvalMode: 'threshold',
        approvalThreshold: 1.5,
      })))).rejects.toMatchObject({
        code: 'APPROVAL_THRESHOLD_INVALID',
        statusCode: 400,
      })

      // 'threshold' mode with no approvalThreshold at all is also rejected.
      await expect(createTemplate(baseRequest(thresholdGraph({
        assigneeType: 'user',
        assigneeIds: ['u-a', 'u-b'],
        approvalMode: 'threshold',
      })))).rejects.toMatchObject({
        code: 'APPROVAL_THRESHOLD_INVALID',
        statusCode: 400,
      })
    })

    it('rejects a threshold node nested inside a parallel region (linear-only in v1)', async () => {
      const parallelGraph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'fork', type: 'parallel', config: { branches: ['edge-fork-a', 'edge-fork-b'], joinNodeKey: 'join', joinMode: 'all' } },
          // A VALID threshold (2 of 2) so the per-node range check passes and the dedicated
          // parallel-region guard is the failure that fires.
          { key: 'branch_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['p-a1', 'p-a2'], approvalMode: 'threshold', approvalThreshold: 2 } },
          { key: 'branch_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['p-b1'] } },
          { key: 'join', type: 'end', config: {} },
        ],
        edges: [
          { key: 'edge-start-fork', source: 'start', target: 'fork' },
          { key: 'edge-fork-a', source: 'fork', target: 'branch_a' },
          { key: 'edge-fork-b', source: 'fork', target: 'branch_b' },
          { key: 'edge-a-join', source: 'branch_a', target: 'join' },
          { key: 'edge-b-join', source: 'branch_b', target: 'join' },
        ],
        policy: { allowRevoke: true },
      }
      await expect(createTemplate(baseRequest(parallelGraph))).rejects.toMatchObject({
        code: 'APPROVAL_THRESHOLD_IN_PARALLEL',
        statusCode: 400,
      })
    })

    it('accepts a valid linear threshold (2-of-3) node and round-trips approvalThreshold', async () => {
      pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        const s = normalize(sql)
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (s.startsWith('INSERT INTO approval_templates')) {
          return { rows: [{ id: 'tpl-t', key: String(params?.[0]), name: String(params?.[1]), description: null, category: null, visibility_scope: JSON.parse(String(params?.[4])), sla_hours: null, status: 'draft', active_version_id: null, latest_version_id: null, created_at: new Date('2026-06-30T00:00:00.000Z'), updated_at: new Date('2026-06-30T00:00:00.000Z') }], rowCount: 1 }
        }
        if (s.startsWith('INSERT INTO approval_template_versions')) {
          return { rows: [{ id: 'ver-t', template_id: 'tpl-t', version: 1, status: 'draft', form_schema: JSON.parse(String(params?.[1])), approval_graph: JSON.parse(String(params?.[2])), created_at: new Date('2026-06-30T00:00:00.000Z'), updated_at: new Date('2026-06-30T00:00:00.000Z') }], rowCount: 1 }
        }
        if (s.startsWith('UPDATE approval_templates')) {
          return { rows: [{ id: 'tpl-t', key: 'threshold-tpl', name: 'Threshold Tpl', description: null, category: null, visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft', active_version_id: null, latest_version_id: 'ver-t', created_at: new Date('2026-06-30T00:00:00.000Z'), updated_at: new Date('2026-06-30T00:00:00.000Z') }], rowCount: 1 }
        }
        throw new Error(`Unhandled query: ${s}`)
      })

      const result = await createTemplate(baseRequest(thresholdGraph({
        assigneeType: 'user',
        assigneeIds: ['u-a', 'u-b', 'u-c'],
        approvalMode: 'threshold',
        approvalThreshold: 2,
      })))
      const node = result.approvalGraph.nodes.find((n) => n.key === 'approval_threshold')
      expect((node?.config as { approvalMode?: string }).approvalMode).toBe('threshold')
      expect((node?.config as { approvalThreshold?: number }).approvalThreshold).toBe(2)

      const insertVersionCall = pgState.client.query.mock.calls.find(([sql]) =>
        normalize(sql as string).startsWith('INSERT INTO approval_template_versions'))
      const persistedGraph = JSON.parse(String(insertVersionCall?.[1]?.[2]))
      expect(persistedGraph.nodes[1].config.approvalThreshold).toBe(2)
    })
  })
})
