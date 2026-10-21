import { describe, expect, it, vi } from 'vitest'
import type { ApprovalInstanceRow } from '../../src/services/approval-bridge-types'
import type { RuntimeGraph } from '../../src/types/approval-product'

/**
 * `returnableNodeKeys` rides BOTH instance-DTO carriers the FE store publishes into
 * `activeApproval`:
 *   * the DETAIL READ — `ApprovalBridgeService` `toUnifiedDTO` (GET /api/approvals/:id), on the
 *     detail path only (the list path shares the builder and must stay byte-identical);
 *   * every ACTION RESPONSE — `ApprovalProductService` `toUnifiedApprovalDTO`.
 * Both builders are module-private in spirit and exported only as this no-DB seam; the walk itself
 * is pinned in approval-return-targets.test.ts. No database: the builders are pure functions of
 * the row, and the pool is mocked to `null` so importing the two service modules has no effect.
 */
vi.mock('../../src/db/pg', () => ({ pool: null }))

/** start → approval_1 → approval_2 → approval_3 → end */
const GRAPH: RuntimeGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } },
    { key: 'approval_2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } },
    { key: 'approval_3', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } },
    { key: 'end', type: 'end', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'approval_1' },
    { key: 'e2', source: 'approval_1', target: 'approval_2' },
    { key: 'e3', source: 'approval_2', target: 'approval_3' },
    { key: 'e4', source: 'approval_3', target: 'end' },
  ],
  policy: { allowRevoke: true },
}

/** `GRAPH` without its start node — the executor refuses to walk it, so the field must be ABSENT. */
const START_LESS_GRAPH: RuntimeGraph = {
  ...GRAPH,
  nodes: GRAPH.nodes.filter((node) => node.type !== 'start'),
}

/** `GRAPH` with the cursor node (approval_3) carrying an explicit `allowReturn: false`. */
const RETURN_DISABLED_AT_CURSOR_GRAPH: RuntimeGraph = {
  ...GRAPH,
  nodes: GRAPH.nodes.map((node) => (
    node.key === 'approval_3'
      ? { ...node, config: { ...node.config, nodeOperationPolicy: { allowReturn: false } } }
      : node
  )),
}

function row(overrides: Partial<ApprovalInstanceRow> = {}): ApprovalInstanceRow {
  const now = new Date('2026-08-01T10:00:00.000Z')
  return {
    id: 'apv_1',
    status: 'pending',
    version: 3,
    source_system: 'platform',
    external_approval_id: null,
    workflow_key: null,
    business_key: null,
    title: 'generic title',
    requester_snapshot: { id: 'user_99', name: 'requester' },
    subject_snapshot: {},
    policy_snapshot: { allowRevoke: true },
    metadata: {},
    current_step: 3,
    total_steps: 3,
    source_updated_at: null,
    last_synced_at: null,
    sync_status: 'ok',
    template_id: 'tpl_1',
    template_version_id: 'ver_1',
    published_definition_id: 'pub_1',
    request_no: 'AP-100001',
    form_snapshot: {},
    current_node_key: 'approval_3',
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('returnableNodeKeys — the detail-read carrier (ApprovalBridgeService toUnifiedDTO)', () => {
  it('is present on the detail path, in trail order, and absent on the list path (same builder, no flag)', async () => {
    const { toUnifiedDTO } = await import('../../src/services/ApprovalBridgeService')
    const detail = toUnifiedDTO(row(), [], GRAPH, { withReturnableNodeKeys: true })
    expect(detail.returnableNodeKeys).toEqual(['approval_1', 'approval_2'])

    const list = toUnifiedDTO(row(), [], GRAPH)
    expect(Object.prototype.hasOwnProperty.call(list, 'returnableNodeKeys')).toBe(false)
  })

  it('[] is a value (nothing legal) and absence means not computed: non-pending, no frozen graph', async () => {
    const { toUnifiedDTO } = await import('../../src/services/ApprovalBridgeService')
    expect(toUnifiedDTO(row({ current_node_key: 'approval_1' }), [], GRAPH, { withReturnableNodeKeys: true }).returnableNodeKeys)
      .toEqual([])
    const closed = toUnifiedDTO(row({ status: 'approved' }), [], GRAPH, { withReturnableNodeKeys: true })
    expect(Object.prototype.hasOwnProperty.call(closed, 'returnableNodeKeys')).toBe(false)
    const bridged = toUnifiedDTO(row({ published_definition_id: null }), [], null, { withReturnableNodeKeys: true })
    expect(Object.prototype.hasOwnProperty.call(bridged, 'returnableNodeKeys')).toBe(false)
  })

  it('walks the RAW form snapshot, not the redacted echo: a hidden routing field still picks the branch', async () => {
    const { toUnifiedDTO } = await import('../../src/services/ApprovalBridgeService')
    // start → route ⇒ {amount ≥ 1000: approval_high | default: approval_low} → approval_final → end,
    // with `amount` hidden at the cursor node so the echoed `formSnapshot` no longer carries it.
    const graph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'edge_high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }],
            defaultEdgeKey: 'edge_low',
          },
        },
        { key: 'approval_high', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } },
        { key: 'approval_low', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } },
        {
          key: 'approval_final',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: ['user_1'],
            fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'route' },
        { key: 'edge_high', source: 'route', target: 'approval_high' },
        { key: 'edge_low', source: 'route', target: 'approval_low' },
        { key: 'e2', source: 'approval_high', target: 'approval_final' },
        { key: 'e3', source: 'approval_low', target: 'approval_final' },
        { key: 'e4', source: 'approval_final', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }
    const dto = toUnifiedDTO(
      row({ current_node_key: 'approval_final', form_snapshot: { amount: 5000, note: 'x' } }),
      [],
      graph,
      { withReturnableNodeKeys: true },
    )
    expect(dto.formSnapshot).toEqual({ note: 'x' })
    expect(dto.returnableNodeKeys).toEqual(['approval_high'])
  })

  it('a malformed frozen graph (no start node) leaves the field ABSENT — the detail read never fails for it', async () => {
    // Gate r1 NIT-1: criterion B at carrier level, not only at the helper.
    const { toUnifiedDTO } = await import('../../src/services/ApprovalBridgeService')
    let dto: ReturnType<typeof toUnifiedDTO> | null = null
    expect(() => { dto = toUnifiedDTO(row(), [], START_LESS_GRAPH, { withReturnableNodeKeys: true }) }).not.toThrow()
    expect(dto).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(dto, 'returnableNodeKeys')).toBe(false)
  })

  it('a cancel-round row ([] by kind) and an allowReturn:false cursor ([] by policy) both ride the detail read as []', async () => {
    // Gate r1 P3-1: the builder threads `row.workflow_key`; dropping it would turn the cancel-round
    // answer back into the trail. The policy answer needs only the graph the builder already holds.
    const { toUnifiedDTO } = await import('../../src/services/ApprovalBridgeService')
    expect(toUnifiedDTO(row({ workflow_key: 'approval.cancel-round' }), [], GRAPH, { withReturnableNodeKeys: true }).returnableNodeKeys)
      .toEqual([])
    expect(toUnifiedDTO(row(), [], RETURN_DISABLED_AT_CURSOR_GRAPH, { withReturnableNodeKeys: true }).returnableNodeKeys)
      .toEqual([])
  })
})

describe('returnableNodeKeys — the action-response carrier (ApprovalProductService toUnifiedApprovalDTO)', () => {
  it('is present whenever the frozen graph is handed in, with the same values as the detail read', async () => {
    const { toUnifiedApprovalDTO } = await import('../../src/services/ApprovalProductService')
    expect(toUnifiedApprovalDTO(row(), [], null, GRAPH).returnableNodeKeys).toEqual(['approval_1', 'approval_2'])
    expect(toUnifiedApprovalDTO(row({ current_node_key: 'approval_1' }), [], null, GRAPH).returnableNodeKeys).toEqual([])
  })

  it('is absent without a graph (older call shape / no published definition) and on a non-pending instance', async () => {
    const { toUnifiedApprovalDTO } = await import('../../src/services/ApprovalProductService')
    expect(Object.prototype.hasOwnProperty.call(toUnifiedApprovalDTO(row(), [], null), 'returnableNodeKeys')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(toUnifiedApprovalDTO(row(), [], null, null), 'returnableNodeKeys')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(
      toUnifiedApprovalDTO(row({ status: 'approved' }), [], null, GRAPH),
      'returnableNodeKeys',
    )).toBe(false)
  })

  it('inside a parallel region both the fork-cursor [] and the existing currentNodeKeys carrier ride together', async () => {
    const { toUnifiedApprovalDTO } = await import('../../src/services/ApprovalProductService')
    const graph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } },
        { key: 'parallel_1', type: 'parallel', config: { branches: ['edge_p1', 'edge_p2'], joinMode: 'all', joinNodeKey: 'approval_2' } },
        { key: 'approval_p1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } },
        { key: 'approval_p2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_2'] } },
        { key: 'approval_2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_1'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'parallel_1' },
        { key: 'edge_p1', source: 'parallel_1', target: 'approval_p1' },
        { key: 'edge_p2', source: 'parallel_1', target: 'approval_p2' },
        { key: 'edge_j1', source: 'approval_p1', target: 'approval_2' },
        { key: 'edge_j2', source: 'approval_p2', target: 'approval_2' },
        { key: 'e3', source: 'approval_2', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }
    const dto = toUnifiedApprovalDTO(
      row({
        current_node_key: 'parallel_1',
        metadata: {
          parallelBranchStates: {
            parallelNodeKey: 'parallel_1',
            joinNodeKey: 'approval_2',
            joinMode: 'all',
            branches: {
              edge_p1: { edgeKey: 'edge_p1', currentNodeKey: 'approval_p1', complete: false },
              edge_p2: { edgeKey: 'edge_p2', currentNodeKey: null, complete: true },
            },
          },
        },
      }),
      [],
      null,
      graph,
    )
    expect(dto.currentNodeKeys).toEqual(['approval_p1'])
    expect(dto.returnableNodeKeys).toEqual([])
  })

  it('a malformed frozen graph (no start node) leaves the field ABSENT — the action response never fails for it', async () => {
    // Gate r1 NIT-1: criterion B at carrier level, not only at the helper.
    const { toUnifiedApprovalDTO } = await import('../../src/services/ApprovalProductService')
    let dto: ReturnType<typeof toUnifiedApprovalDTO> | null = null
    expect(() => { dto = toUnifiedApprovalDTO(row(), [], null, START_LESS_GRAPH) }).not.toThrow()
    expect(dto).not.toBeNull()
    expect(Object.prototype.hasOwnProperty.call(dto, 'returnableNodeKeys')).toBe(false)
  })

  it('a cancel-round row ([] by kind) and an allowReturn:false cursor ([] by policy) both ride the action response as []', async () => {
    // Gate r1 P3-1: same two answers as the detail read, from the same row column and the same graph.
    const { toUnifiedApprovalDTO } = await import('../../src/services/ApprovalProductService')
    expect(toUnifiedApprovalDTO(row({ workflow_key: 'approval.cancel-round' }), [], null, GRAPH).returnableNodeKeys).toEqual([])
    expect(toUnifiedApprovalDTO(row(), [], null, RETURN_DISABLED_AT_CURSOR_GRAPH).returnableNodeKeys).toEqual([])
  })
})
