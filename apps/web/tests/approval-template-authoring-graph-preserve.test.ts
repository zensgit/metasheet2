import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  graphReadOnlyReason,
  isComplexApprovalGraph,
  unsupportedTemplateAuthoringReason,
} from '../src/approvals/templateAuthoring'

// G-1 — complex-graph load-preserve + anti-flatten. These are PURE-LOGIC tests (no .vue / no
// Element Plus import) so they run under the approval-web-guard CI gate; the .vue render path is
// covered in approvalTemplateAuthoring.spec.ts. The keystone is the round-trip: load a complex
// graph → save → byte-identical (no node/edge/config dropped or reordered).

function buildTemplate(approvalGraph: ApprovalGraph): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1',
    key: 'expense',
    name: '费用审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'draft',
    activeVersionId: null,
    latestVersionId: 'ver_1',
    createdAt: '2026-06-23T00:00:00Z',
    updatedAt: '2026-06-23T00:00:00Z',
    formSchema: {
      fields: [
        { id: 'amount', type: 'number', label: '金额', required: true },
        { id: 'kind', type: 'select', label: '类型', options: [{ label: 'A', value: 'a' }] },
      ],
    },
    approvalGraph,
  }
}

const LINEAR_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'approval_1',
      type: 'approval',
      name: '审批人 1',
      config: {
        assigneeSources: [{ kind: 'requester' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
      },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
    { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
  ],
}

// A graph with a CONDITION node (branches + rules + defaultEdgeKey) and two downstream approval
// arms — non-linear, so the linear projection would lose the condition + the second arm.
const CONDITION_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'cond_1',
      type: 'condition',
      name: '金额判断',
      config: {
        branches: [
          {
            edgeKey: 'edge-cond_1-high',
            rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }],
            conjunction: 'and',
          },
        ],
        defaultEdgeKey: 'edge-cond_1-low',
      },
    },
    {
      key: 'approval_high',
      type: 'approval',
      name: '大额审批',
      config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
    },
    {
      key: 'approval_low',
      type: 'approval',
      name: '小额审批',
      config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'auto-approve' },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-cond_1', source: 'start', target: 'cond_1' },
    { key: 'edge-cond_1-high', source: 'cond_1', target: 'approval_high' },
    { key: 'edge-cond_1-low', source: 'cond_1', target: 'approval_low' },
    { key: 'edge-approval_high-end', source: 'approval_high', target: 'end' },
    { key: 'edge-approval_low-end', source: 'approval_low', target: 'end' },
  ],
}

// A graph with a PARALLEL fork (branches + joinNodeKey + joinMode) and a join node.
const PARALLEL_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'fork_1',
      type: 'parallel',
      name: '并行会签',
      config: { branches: ['edge-fork_1-a', 'edge-fork_1-b'], joinMode: 'all', joinNodeKey: 'join_1' },
    },
    {
      key: 'approval_a',
      type: 'approval',
      name: '财务',
      config: { assigneeSources: [{ kind: 'static_role', roleIds: ['finance'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
    },
    {
      key: 'approval_b',
      type: 'approval',
      name: '法务',
      config: { assigneeSources: [{ kind: 'static_role', roleIds: ['legal'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
    },
    { key: 'join_1', type: 'approval', name: '汇聚', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-fork_1', source: 'start', target: 'fork_1' },
    { key: 'edge-fork_1-a', source: 'fork_1', target: 'approval_a' },
    { key: 'edge-fork_1-b', source: 'fork_1', target: 'approval_b' },
    { key: 'edge-approval_a-join', source: 'approval_a', target: 'join_1' },
    { key: 'edge-approval_b-join', source: 'approval_b', target: 'join_1' },
    { key: 'edge-join_1-end', source: 'join_1', target: 'end' },
  ],
}

// A graph with a CC (抄送) node — targetType + targetIds.
const CC_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'approval_1',
      type: 'approval',
      name: '审批人 1',
      config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
    },
    { key: 'cc_1', type: 'cc', name: '抄送 HR', config: { targetType: 'role', targetIds: ['hr', 'admin'] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
    { key: 'edge-approval_1-cc_1', source: 'approval_1', target: 'cc_1' },
    { key: 'edge-cc_1-end', source: 'cc_1', target: 'end' },
  ],
}

describe('G-1 isComplexApprovalGraph', () => {
  it('is true for a condition graph', () => {
    expect(isComplexApprovalGraph(CONDITION_GRAPH)).toBe(true)
  })

  it('is true for a parallel graph', () => {
    expect(isComplexApprovalGraph(PARALLEL_GRAPH)).toBe(true)
  })

  it('is true for a cc graph', () => {
    expect(isComplexApprovalGraph(CC_GRAPH)).toBe(true)
  })

  it('is true for a non-linear graph that branches without a complex node type', () => {
    // start fans out to two approval nodes (out-degree 2) — not a single linear chain even though
    // every node type is start/approval/end. `orderedLinearNodes` returns null → complex.
    const nonLinear: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'approval_1', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'approval_2', type: 'approval', name: 'B', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'start', target: 'approval_2' },
        { key: 'e3', source: 'approval_1', target: 'end' },
        { key: 'e4', source: 'approval_2', target: 'end' },
      ],
    }
    expect(isComplexApprovalGraph(nonLinear)).toBe(true)
  })

  it('is false for a plain linear start→approval→end graph', () => {
    expect(isComplexApprovalGraph(LINEAR_GRAPH)).toBe(false)
  })
})

describe('G-1 anti-flatten round-trip (load → save is byte-identical, nothing flattened)', () => {
  it('round-trips a CONDITION graph unchanged through draftFromTemplate → buildApprovalGraph', () => {
    const template = buildTemplate(CONDITION_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    // byte-identical: the condition node, both arms, every edge and rule survive verbatim.
    expect(rebuilt).toEqual(original)
    expect(rebuilt.nodes.map((node) => node.key)).toEqual(original.nodes.map((node) => node.key))
    expect(rebuilt.edges).toEqual(original.edges)
  })

  it('round-trips a PARALLEL graph unchanged through draftFromTemplate → buildApprovalGraph', () => {
    const template = buildTemplate(PARALLEL_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(rebuilt).toEqual(original)
    // the fork's branches + joinNodeKey + joinMode are preserved (not collapsed to a chain).
    const fork = rebuilt.nodes.find((node) => node.type === 'parallel')
    expect(fork?.config).toEqual({ branches: ['edge-fork_1-a', 'edge-fork_1-b'], joinMode: 'all', joinNodeKey: 'join_1' })
    expect(rebuilt.edges).toEqual(original.edges)
  })

  it('round-trips a CC graph unchanged through draftFromTemplate → buildApprovalGraph', () => {
    const template = buildTemplate(CC_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(rebuilt).toEqual(original)
    const cc = rebuilt.nodes.find((node) => node.type === 'cc')
    expect(cc?.config).toEqual({ targetType: 'role', targetIds: ['hr', 'admin'] })
  })

  it('captures the full graph verbatim in preservedGraph for a complex template', () => {
    const draft = draftFromTemplate(buildTemplate(CONDITION_GRAPH))
    expect(draft.preservedGraph).toEqual(CONDITION_GRAPH)
    // the linear `steps` projection is NOT applied to a complex graph (would drop the condition
    // + the second arm) — preservedGraph is the sole source for buildApprovalGraph.
    expect(draft.preservedGraph?.nodes.some((node) => node.type === 'condition')).toBe(true)
  })

  it('leaves preservedGraph undefined for a linear template (steps editor stays live)', () => {
    const draft = draftFromTemplate(buildTemplate(LINEAR_GRAPH))
    expect(draft.preservedGraph).toBeUndefined()
    // the linear builder still emits the deterministic start→approval_1→end chain.
    expect(buildApprovalGraph(draft).nodes.map((node) => node.key)).toEqual(['start', 'approval_1', 'end'])
  })
})

describe('G-1 unsupportedTemplateAuthoringReason — complex graphs are save-able, not unsupported', () => {
  it('returns null for a CONDITION graph (now save-preserving, no longer blocked)', () => {
    expect(unsupportedTemplateAuthoringReason(buildTemplate(CONDITION_GRAPH))).toBeNull()
  })

  it('returns null for a PARALLEL graph (now save-preserving, no longer blocked)', () => {
    expect(unsupportedTemplateAuthoringReason(buildTemplate(PARALLEL_GRAPH))).toBeNull()
  })

  it('returns null for a CC graph (now save-preserving, no longer blocked)', () => {
    expect(unsupportedTemplateAuthoringReason(buildTemplate(CC_GRAPH))).toBeNull()
  })

  it('still returns a reason for an unauthorable attachment field type', () => {
    const template = buildTemplate(LINEAR_GRAPH)
    template.formSchema = { fields: [{ id: 'file', type: 'attachment', label: '附件' }] }
    expect(unsupportedTemplateAuthoringReason(template)).toContain('暂不支持编辑的字段类型')
  })

  it('still returns a reason for an unknown node type (not in the recognised set)', () => {
    const template = buildTemplate({
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        // `webhook` is not a recognised node type → genuinely un-authorable, stays read-only.
        { key: 'hook', type: 'webhook' as never, name: '回调', config: {} },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'hook' },
        { key: 'e2', source: 'hook', target: 'end' },
      ],
    })
    expect(unsupportedTemplateAuthoringReason(template)).toContain('暂不支持编辑的审批节点')
  })

  it('still returns a reason for a node carrying EXTRA keys beyond key/type/name/config', () => {
    const template = buildTemplate({
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['hr'] }, extra: 'x' } as never,
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'cc_1' },
        { key: 'e2', source: 'cc_1', target: 'end' },
      ],
    })
    expect(unsupportedTemplateAuthoringReason(template)).toContain('暂不支持编辑的审批节点')
  })

  it('still returns a reason for a LINEAR approval node carrying an unsupported config key', () => {
    // fieldPermissions on a LINEAR approval node is outside the editor allowlist → fail-closed
    // (the linear-path config check still runs; a complex graph would skip it and preserve).
    const template = buildTemplate({
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: '审批人 1',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            emptyAssigneePolicy: 'error',
            fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
          } as never,
        },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    })
    expect(unsupportedTemplateAuthoringReason(template)).toContain('暂不支持的配置')
  })
})

describe('G-1 graphReadOnlyReason — complex graphs render read-only but stay save-able', () => {
  it('returns a message for condition / parallel / cc graphs', () => {
    expect(graphReadOnlyReason(buildTemplate(CONDITION_GRAPH))).not.toBeNull()
    expect(graphReadOnlyReason(buildTemplate(PARALLEL_GRAPH))).not.toBeNull()
    expect(graphReadOnlyReason(buildTemplate(CC_GRAPH))).not.toBeNull()
  })

  it('returns null for a plain linear graph (the steps editor is live)', () => {
    expect(graphReadOnlyReason(buildTemplate(LINEAR_GRAPH))).toBeNull()
  })

  it('returns null for a truly-unsupported template (fully read-only via unsupportedReason instead)', () => {
    // an unknown node type is unsupported, not merely complex — the graph read-only view never
    // opens; the whole template is locked by unsupportedTemplateAuthoringReason.
    const template = buildTemplate({
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'hook', type: 'webhook' as never, name: '回调', config: {} },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'hook' },
        { key: 'e2', source: 'hook', target: 'end' },
      ],
    })
    expect(graphReadOnlyReason(template)).toBeNull()
    expect(unsupportedTemplateAuthoringReason(template)).not.toBeNull()
  })
})
