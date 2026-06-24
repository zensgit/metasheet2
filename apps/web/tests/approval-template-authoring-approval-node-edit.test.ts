import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  unsupportedTemplateAuthoringReason,
  validateTemplateDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import {
  applyApprovalNodeEditsToGraph,
  approvalNodeEditsFromGraph,
  validateApprovalNodeEdits,
} from '../src/approvals/approvalNodeEdit'

// G-5 — approval-node editing (approver SOURCE only: `assigneeSources`). PURE-LOGIC tests (no .vue)
// so they run under approval-web-guard. The GATE is topology + cross-phase + WITHIN-NODE
// preservation: editing one approval node's source must leave every OTHER node + the FULL edge list
// byte-identical, must COMPOSE with condition/parallel/cc edits, must keep that node's OWN
// approvalMode/emptyAssigneePolicy/autoApprovalPolicy byte-identical, and a legacy node
// (assigneeType/assigneeIds, no assigneeSources) must round-trip byte-identical + get NO editor.
// PRE-CHECK: backend `validateApprovalAssigneeSourcesAgainstFormSchema` (ApprovalProductService.ts
// :457-480) requires a form_field_user source's fieldId to be a TOP-LEVEL `user` field.

function buildTemplate(approvalGraph: ApprovalGraph, fields = [{ id: 'mgr_field', type: 'user' as const, label: '经理', required: false }]): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1', key: 'expense', name: '费用审批', description: null, category: null,
    visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
    activeVersionId: null, latestVersionId: 'ver_1',
    createdAt: '2026-06-23T00:00:00Z', updatedAt: '2026-06-23T00:00:00Z',
    formSchema: { fields }, approvalGraph,
  }
}

// An approval node carrying autoApprovalPolicy + approvalMode + emptyAssigneePolicy (the within-node
// preservation case) inside a condition graph (so we also prove cross-node preservation).
const APPROVAL_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'approval_1', type: 'approval', name: '主管',
      config: {
        assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }],
        approvalMode: 'single', emptyAssigneePolicy: 'error',
        autoApprovalPolicy: { mergeWithRequester: true },
      },
    },
    { key: 'cond_1', type: 'condition', name: '金额判断', config: { branches: [{ edgeKey: 'edge-cond_1-high', rules: [{ fieldId: 'amount', operator: 'gt', value: 1000 }] }], defaultEdgeKey: 'edge-cond_1-low' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
    { key: 'edge-approval_1-cond_1', source: 'approval_1', target: 'cond_1' },
    { key: 'edge-cond_1-high', source: 'cond_1', target: 'end' },
    { key: 'edge-cond_1-low', source: 'cond_1', target: 'end' },
  ],
}

// Legacy approval node (assigneeType/assigneeIds, NO assigneeSources) inside a COMPLEX graph — the cc
// node forces the preserved-graph path (a linear graph would project to steps, a different code path
// that pre-dates G-5). This is the path G-5 governs: the legacy node is cloned verbatim, not seeded.
const LEGACY_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'approval_legacy', type: 'approval', name: '旧式', config: { assigneeType: 'role', assigneeIds: ['legacy_role'], approvalMode: 'single' } },
    { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['finance'] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-approval_legacy', source: 'start', target: 'approval_legacy' },
    { key: 'edge-approval_legacy-cc_1', source: 'approval_legacy', target: 'cc_1' },
    { key: 'edge-cc_1-end', source: 'cc_1', target: 'end' },
  ],
}

// One node of EACH editable type + an approval node — proves the FOUR passes compose disjointly.
const FOUR_TYPE_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'cond_1', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'e2', rules: [{ fieldId: 'amount', operator: 'gt', value: 1000 }] }], defaultEdgeKey: 'e3' } },
    { key: 'approval_1', type: 'approval', name: '主管', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'parallel_1', type: 'parallel', name: '并行', config: { branches: ['e4', 'e5'], joinMode: 'all', joinNodeKey: 'join_1' } },
    { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['finance'] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'cond_1' },
    { key: 'e2', source: 'cond_1', target: 'approval_1' },
    { key: 'e3', source: 'cond_1', target: 'end' },
    { key: 'e4', source: 'approval_1', target: 'parallel_1' },
    { key: 'e5', source: 'parallel_1', target: 'cc_1' },
    { key: 'e6', source: 'cc_1', target: 'end' },
  ],
}

const clone = (g: ApprovalGraph): ApprovalGraph => JSON.parse(JSON.stringify(g))
const nonApproval = (g: ApprovalGraph) => g.nodes.filter((n) => n.type !== 'approval')
const node = (g: ApprovalGraph, key: string) => g.nodes.find((n) => n.key === key)!

describe('approvalNodeEditsFromGraph (seed)', () => {
  it('seeds one entry per approval node that HAS assigneeSources', () => {
    expect(approvalNodeEditsFromGraph(APPROVAL_GRAPH)).toEqual({
      approval_1: { nodeKey: 'approval_1', assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }] },
    })
  })
  it('does NOT seed a legacy approval node (no assigneeSources array) — stays read-only', () => {
    expect(approvalNodeEditsFromGraph(LEGACY_GRAPH)).toEqual({})
  })
})

describe('G-5 topology-preservation — editing an approver source keeps everything else byte-identical', () => {
  it('changes ONLY the edited approval node assigneeSources; all other nodes + full edges byte-identical', () => {
    const original = clone(APPROVAL_GRAPH)
    const edits = approvalNodeEditsFromGraph(APPROVAL_GRAPH)
    edits.approval_1.assigneeSources = [{ kind: 'direct_manager' }]
    const rebuilt = applyApprovalNodeEditsToGraph(APPROVAL_GRAPH, edits)
    expect(nonApproval(rebuilt)).toEqual(nonApproval(original)) // start / condition / end untouched
    expect(rebuilt.edges).toEqual(original.edges) // topology untouched
    expect((node(rebuilt, 'approval_1').config as { assigneeSources: unknown }).assigneeSources).toEqual([{ kind: 'direct_manager' }])
  })
  it('WITHIN-NODE: the edited node keeps its OWN approvalMode / emptyAssigneePolicy / autoApprovalPolicy byte-identical', () => {
    const edits = approvalNodeEditsFromGraph(APPROVAL_GRAPH)
    edits.approval_1.assigneeSources = [{ kind: 'dept_head' }]
    const cfg = node(applyApprovalNodeEditsToGraph(APPROVAL_GRAPH, edits), 'approval_1').config as Record<string, unknown>
    expect(cfg.approvalMode).toBe('single')
    expect(cfg.emptyAssigneePolicy).toBe('error')
    expect(cfg.autoApprovalPolicy).toEqual({ mergeWithRequester: true }) // preserved, not dropped
    expect(cfg.assigneeSources).toEqual([{ kind: 'dept_head' }])
  })
  it('does not mutate the input graph', () => {
    const before = clone(APPROVAL_GRAPH)
    const edits = approvalNodeEditsFromGraph(APPROVAL_GRAPH)
    edits.approval_1.assigneeSources = [{ kind: 'requester' }]
    applyApprovalNodeEditsToGraph(APPROVAL_GRAPH, edits)
    expect(APPROVAL_GRAPH).toEqual(before)
  })
})

describe('G-5 untouched round-trip — G-1 floor holds (incl. legacy nodes)', () => {
  it('an approval+condition graph round-trips byte-identical through draftFromTemplate → buildApprovalGraph', () => {
    const original = clone(APPROVAL_GRAPH)
    expect(buildApprovalGraph(draftFromTemplate(buildTemplate(APPROVAL_GRAPH)))).toEqual(original)
  })
  it('a LEGACY approval node round-trips byte-identical (not seeded, cloned verbatim)', () => {
    const original = clone(LEGACY_GRAPH)
    expect(buildApprovalGraph(draftFromTemplate(buildTemplate(LEGACY_GRAPH)))).toEqual(original)
  })
})

describe('G-5 four-phase compose — condition + parallel + cc + approval-node edits all land', () => {
  it('all four edits land; start/end + every non-edited field + all edges byte-identical', () => {
    const draft: TemplateAuthoringDraft = draftFromTemplate(buildTemplate(FOUR_TYPE_GRAPH))
    draft.conditionEdits!.cond_1.branches[0].rules[0].value = 9999
    draft.parallelEdits!.parallel_1.joinMode = 'any'
    draft.ccEdits!.cc_1.targetIds = ['treasury']
    draft.approvalNodeEdits!.approval_1.assigneeSources = [{ kind: 'manager_at_level', level: 2 }]
    const rebuilt = buildApprovalGraph(draft)
    expect((node(rebuilt, 'cond_1').config as { branches: { rules: { value: unknown }[] }[] }).branches[0].rules[0].value).toBe(9999)
    expect((node(rebuilt, 'parallel_1').config as { joinMode: string }).joinMode).toBe('any')
    expect((node(rebuilt, 'cc_1').config as { targetIds: string[] }).targetIds).toEqual(['treasury'])
    expect((node(rebuilt, 'approval_1').config as { assigneeSources: unknown }).assigneeSources).toEqual([{ kind: 'manager_at_level', level: 2 }])
    expect(rebuilt.edges).toEqual(FOUR_TYPE_GRAPH.edges) // topology untouched
    expect(node(rebuilt, 'start')).toEqual(node(FOUR_TYPE_GRAPH, 'start'))
    expect(node(rebuilt, 'end')).toEqual(node(FOUR_TYPE_GRAPH, 'end'))
  })
})

describe('validateApprovalNodeEdits (preview mirrors the backend assignee rule)', () => {
  it('passes a valid source edit', () => {
    expect(validateApprovalNodeEdits({ a: { nodeKey: 'a', assigneeSources: [{ kind: 'direct_manager' }] } })).toEqual([])
  })
  it('flags an empty assigneeSources', () => {
    expect(validateApprovalNodeEdits({ a: { nodeKey: 'a', assigneeSources: [] } })[0]).toMatch(/至少需要一个审批人来源/)
  })
  it('flags a form_field_user pointing at a NON-top-level-user field', () => {
    const errs = validateApprovalNodeEdits(
      { a: { nodeKey: 'a', assigneeSources: [{ kind: 'form_field_user', fieldId: 'amount' }] } },
      [{ id: 'amount', type: 'number' }, { id: 'mgr_field', type: 'user' }],
    )
    expect(errs[0]).toMatch(/顶层用户字段/)
  })
  it('passes a form_field_user pointing at a top-level user field', () => {
    expect(validateApprovalNodeEdits(
      { a: { nodeKey: 'a', assigneeSources: [{ kind: 'form_field_user', fieldId: 'mgr_field' }] } },
      [{ id: 'mgr_field', type: 'user' }],
    )).toEqual([])
  })
  it('surfaces an approval-node preview error through validateTemplateDraft', () => {
    const draft = draftFromTemplate(buildTemplate(APPROVAL_GRAPH))
    draft.approvalNodeEdits!.approval_1.assigneeSources = []
    expect(validateTemplateDraft(draft).some((e) => /审批人来源/.test(e))).toBe(true)
  })
})

describe('G-5 fail-closed — complex approval-node config must stay within the BACKEND allowlist', () => {
  // The backend `normalizeApprovalGraph` rebuilds approval config from {assigneeType, assigneeIds,
  // assigneeSources, approvalMode, emptyAssigneePolicy, autoApprovalPolicy, fieldPermissions} and
  // silently DROPS any other key on save. The FE deep-equal round-trip can't see that drop, so a
  // complex approval node (cc node forces the preserved path) carrying an unknown key must be
  // UNSUPPORTED — read-only + save disabled — not silently flattened on save.
  const complexWith = (approvalConfig: Record<string, unknown>): ApprovalGraph => ({
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '主管', config: approvalConfig },
      { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['finance'] } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'cc_1' },
      { key: 'e3', source: 'cc_1', target: 'end' },
    ],
  })
  it('flags a complex approval node carrying an unknown config key (backend would drop it → save disabled)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], customRoutingHint: 'x' })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('ALLOWS fieldPermissions — the backend DOES preserve it on the complex path (not over-strict)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
  it('allows a complex approval node with only backend-preserved keys', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error', autoApprovalPolicy: { mergeWithRequester: true } })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
})
