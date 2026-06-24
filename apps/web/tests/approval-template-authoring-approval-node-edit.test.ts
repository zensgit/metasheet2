import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  unsupportedTemplateAuthoringReason,
  validateTemplateDraft,
} from '../src/approvals/templateAuthoring'
import {
  applyApprovalNodeEditsToGraph,
  approvalNodeEditsFromGraph,
  validateApprovalNodeEdits,
} from '../src/approvals/approvalNodeEdit'

// G-5 — approval node editing inside a preserved complex graph. PURE-LOGIC tests (no .vue /
// Element Plus) so they run under approval-web-guard. The gate is topology preservation: editing one
// approval node changes only that node's editable config; every condition/parallel/cc node, every
// non-edited approval node, and the full edge list remain byte-identical.

function buildTemplate(approvalGraph: ApprovalGraph): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1',
    key: 'amount_tier',
    name: '金额分级审批',
    description: null,
    category: null,
    visibilityScope: { type: 'all', ids: [] },
    slaHours: null,
    status: 'draft',
    activeVersionId: null,
    latestVersionId: 'ver_1',
    createdAt: '2026-06-24T00:00:00Z',
    updatedAt: '2026-06-24T00:00:00Z',
    formSchema: {
      fields: [
        { id: 'amount', type: 'number', label: '金额', required: true },
        { id: 'budget_owner', type: 'user', label: '预算负责人' },
      ],
    },
    approvalGraph,
  }
}

const COMPLEX_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'cond_1',
      type: 'condition',
      name: '金额判断',
      config: {
        branches: [{ edgeKey: 'edge-cond-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 5000 }], conjunction: 'and' }],
        defaultEdgeKey: 'edge-cond-low',
      },
    },
    {
      key: 'approval_high',
      type: 'approval',
      name: '高额审批',
      config: {
        assigneeSources: [{ kind: 'manager_at_level', level: 2 }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
        autoApprovalPolicy: { mergeWithRequester: true, mergeAdjacentApprover: true },
        fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
      },
    },
    {
      key: 'approval_low',
      type: 'approval',
      name: '普通审批',
      config: {
        assigneeSources: [{ kind: 'direct_manager' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'auto-approve',
      },
    },
    { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['finance'] } },
    {
      key: 'fork_1',
      type: 'parallel',
      name: '并行',
      config: { branches: ['edge-fork-a', 'edge-fork-b'], joinMode: 'all', joinNodeKey: 'join_1' },
    },
    { key: 'join_1', type: 'approval', name: '汇聚', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-cond', source: 'start', target: 'cond_1' },
    { key: 'edge-cond-high', source: 'cond_1', target: 'approval_high' },
    { key: 'edge-cond-low', source: 'cond_1', target: 'approval_low' },
    { key: 'edge-approval-high-cc', source: 'approval_high', target: 'cc_1' },
    { key: 'edge-cc-fork', source: 'cc_1', target: 'fork_1' },
    { key: 'edge-fork-a', source: 'fork_1', target: 'approval_low' },
    { key: 'edge-fork-b', source: 'fork_1', target: 'join_1' },
    { key: 'edge-approval-low-join', source: 'approval_low', target: 'join_1' },
    { key: 'edge-join-end', source: 'join_1', target: 'end' },
  ],
}

const clone = (graph: ApprovalGraph): ApprovalGraph => JSON.parse(JSON.stringify(graph))

function nonEditedApprovalNodes(graph: ApprovalGraph, editedKey: string): ApprovalGraph['nodes'] {
  return graph.nodes.filter((node) => node.type !== 'approval' || node.key !== editedKey)
}

describe('G-5 approvalNodeEditsFromGraph', () => {
  it('seeds one edit per approval node with source and policy fields', () => {
    const edits = approvalNodeEditsFromGraph(COMPLEX_GRAPH)
    expect(Object.keys(edits)).toEqual(['approval_high', 'approval_low', 'join_1'])
    expect(edits.approval_high.sourceKind).toBe('manager_at_level')
    expect(edits.approval_high.level).toBe(2)
    expect(edits.approval_high.mergeWithRequester).toBe(true)
    expect(edits.approval_low.emptyAssigneePolicy).toBe('auto-approve')
  })
})

describe('G-5 untouched round-trip', () => {
  it('keeps a complex graph byte-identical when approval node edits are untouched', () => {
    const original = clone(COMPLEX_GRAPH)
    expect(buildApprovalGraph(draftFromTemplate(buildTemplate(COMPLEX_GRAPH)))).toEqual(original)
  })
})

describe('G-5 topology preservation', () => {
  it('editing one approval source changes only that approval node config; every edge and other node is byte-identical', () => {
    const original = clone(COMPLEX_GRAPH)
    const draft = draftFromTemplate(buildTemplate(COMPLEX_GRAPH))
    draft.approvalNodeEdits!.approval_high.sourceKind = 'static_role'
    draft.approvalNodeEdits!.approval_high.idsText = 'finance, cfo'
    draft.approvalNodeEdits!.approval_high.approvalMode = 'all'
    draft.approvalNodeEdits!.approval_high.emptyAssigneePolicy = 'auto-approve'
    const rebuilt = buildApprovalGraph(draft)

    expect(nonEditedApprovalNodes(rebuilt, 'approval_high')).toEqual(nonEditedApprovalNodes(original, 'approval_high'))
    expect(rebuilt.edges).toEqual(original.edges)
    expect(rebuilt.nodes.map((node) => node.key)).toEqual(original.nodes.map((node) => node.key))
    expect(rebuilt.nodes.find((node) => node.key === 'approval_high')!.config).toEqual({
      assigneeSources: [{ kind: 'static_role', roleIds: ['finance', 'cfo'] }],
      approvalMode: 'all',
      emptyAssigneePolicy: 'auto-approve',
      autoApprovalPolicy: { mergeWithRequester: true, mergeAdjacentApprover: true },
      fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
    })
  })

  it('preserves config siblings while the mergeWithRequester toggle owns only that flag', () => {
    const draft = draftFromTemplate(buildTemplate(COMPLEX_GRAPH))
    draft.approvalNodeEdits!.approval_high.sourceKind = 'static_user'
    draft.approvalNodeEdits!.approval_high.idsText = 'u2'
    draft.approvalNodeEdits!.approval_high.mergeWithRequester = false
    const rebuilt = buildApprovalGraph(draft)
    expect(rebuilt.nodes.find((node) => node.key === 'approval_high')!.config).toEqual({
      assigneeSources: [{ kind: 'static_user', userIds: ['u2'] }],
      approvalMode: 'single',
      emptyAssigneePolicy: 'error',
      autoApprovalPolicy: { mergeAdjacentApprover: true },
      fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
    })
  })

  it('applyApprovalNodeEditsToGraph does not mutate the input graph', () => {
    const before = clone(COMPLEX_GRAPH)
    const edits = approvalNodeEditsFromGraph(COMPLEX_GRAPH)
    edits.approval_high.sourceKind = 'requester'
    applyApprovalNodeEditsToGraph(COMPLEX_GRAPH, edits)
    expect(COMPLEX_GRAPH).toEqual(before)
  })
})

describe('G-5 preview validation', () => {
  it('requires static user/role ids and valid form_field_user field ids', () => {
    const edits = approvalNodeEditsFromGraph(COMPLEX_GRAPH)
    edits.approval_high.sourceKind = 'static_user'
    edits.approval_high.idsText = ''
    edits.approval_low.sourceKind = 'form_field_user'
    edits.approval_low.fieldId = 'amount'
    const errors = validateApprovalNodeEdits(edits, buildTemplate(COMPLEX_GRAPH).formSchema)
    expect(errors.some((error) => /需要填写用户\/角色 id/.test(error))).toBe(true)
    expect(errors.some((error) => /表单用户字段无效/.test(error))).toBe(true)
  })

  it('surfaces approval-node preview errors through validateTemplateDraft', () => {
    const draft = draftFromTemplate(buildTemplate(COMPLEX_GRAPH))
    draft.approvalNodeEdits!.approval_high.sourceKind = 'form_field_user'
    draft.approvalNodeEdits!.approval_high.fieldId = 'amount'
    expect(validateTemplateDraft(draft).some((error) => /表单用户字段无效/.test(error))).toBe(true)
  })
})

describe('G-5 fail-closed boundary', () => {
  it('keeps a complex graph editable when approval node fieldPermissions are representable and preserved', () => {
    expect(unsupportedTemplateAuthoringReason(buildTemplate(COMPLEX_GRAPH))).toBeNull()
  })

  it('fails closed for a complex approval node with multiple assigneeSources, rather than flattening to the first', () => {
    const graph = clone(COMPLEX_GRAPH)
    const approval = graph.nodes.find((node) => node.key === 'approval_high')!
    approval.config = {
      assigneeSources: [{ kind: 'requester' }, { kind: 'dept_head' }],
      approvalMode: 'single',
      emptyAssigneePolicy: 'error',
    }
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toContain('暂不支持的审批人来源')
  })

  it('fails closed for complex approval-node config keys outside the G-5 editable/preserved allowlist', () => {
    const graph = clone(COMPLEX_GRAPH)
    const approval = graph.nodes.find((node) => node.key === 'approval_high')!
    approval.config = { ...approval.config, customEscalation: true } as never
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toContain('暂不支持的配置')
  })
})
