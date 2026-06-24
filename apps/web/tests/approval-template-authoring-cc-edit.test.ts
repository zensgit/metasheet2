import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  validateTemplateDraft,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import { applyCcEditsToGraph, ccEditsFromGraph, validateCcEdits, CC_TARGET_TYPES } from '../src/approvals/ccEdit'
import { applyConditionEditsToGraph, conditionEditsFromGraph } from '../src/approvals/conditionEdit'

// G-4 — cc node editing (targetType + targetIds). PURE-LOGIC tests (no .vue / no Element Plus) so
// they run under the approval-web-guard CI gate. The GATE is topology + cross-phase preservation:
// editing a cc node's targets must leave every OTHER node (start/approval/condition/parallel/end) and
// the FULL edge list byte-identical, cc edits must COMPOSE with condition/parallel edits, and an
// untouched complex graph must still round-trip byte-identical (G-1 floor). PRE-CHECK: the backend
// `normalizeApprovalGraph` cc rule (ApprovalProductService.ts:914-922) = targetType ∈ {'user','role'}
// + a non-empty targetIds string[] (trimmed). The editor + validateCcEdits mirror exactly.

function buildTemplate(approvalGraph: ApprovalGraph): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1', key: 'expense', name: '费用审批', description: null, category: null,
    visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
    activeVersionId: null, latestVersionId: 'ver_1',
    createdAt: '2026-06-23T00:00:00Z', updatedAt: '2026-06-23T00:00:00Z',
    formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额', required: true }] },
    approvalGraph,
  }
}

// A graph with a cc node: start → approval_1 → cc_1 → end.
const CC_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'approval_1', type: 'approval', name: '主管', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'cc_1', type: 'cc', name: '抄送财务', config: { targetType: 'role', targetIds: ['finance', 'audit'] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
    { key: 'edge-approval_1-cc_1', source: 'approval_1', target: 'cc_1' },
    { key: 'edge-cc_1-end', source: 'cc_1', target: 'end' },
  ],
}

// A graph with BOTH a condition node and a cc node — proves G-2 (condition) + G-4 (cc) edits compose.
const CONDITION_PLUS_CC_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'cond_1', type: 'condition', name: '金额判断', config: { branches: [{ edgeKey: 'edge-cond_1-high', rules: [{ fieldId: 'amount', operator: 'gt', value: 1000 }] }], defaultEdgeKey: 'edge-cond_1-low' } },
    { key: 'approval_high', type: 'approval', name: '高额', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['vp'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'user', targetIds: ['u1'] } },
    { key: 'approval_low', type: 'approval', name: '低额', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-cond_1', source: 'start', target: 'cond_1' },
    { key: 'edge-cond_1-high', source: 'cond_1', target: 'approval_high' },
    { key: 'edge-cond_1-low', source: 'cond_1', target: 'approval_low' },
    { key: 'edge-approval_high-cc_1', source: 'approval_high', target: 'cc_1' },
    { key: 'edge-cc_1-end', source: 'cc_1', target: 'end' },
    { key: 'edge-approval_low-end', source: 'approval_low', target: 'end' },
  ],
}

const clone = (g: ApprovalGraph): ApprovalGraph => JSON.parse(JSON.stringify(g))
const nonCc = (g: ApprovalGraph) => g.nodes.filter((n) => n.type !== 'cc')

describe('ccEditsFromGraph (seed)', () => {
  it('seeds one entry per cc node with its existing targetType/targetIds', () => {
    expect(ccEditsFromGraph(CC_GRAPH)).toEqual({ cc_1: { nodeKey: 'cc_1', targetType: 'role', targetIds: ['finance', 'audit'] } })
  })
  it('is empty for a graph with no cc node', () => {
    expect(ccEditsFromGraph({ nodes: [{ key: 'start', type: 'start', config: {} }], edges: [] })).toEqual({})
  })
})

describe('G-4 topology-preservation — editing a cc target keeps everything else byte-identical', () => {
  it('changes ONLY the cc node config; all other nodes + the full edge list byte-identical', () => {
    const original = clone(CC_GRAPH)
    const edits = ccEditsFromGraph(CC_GRAPH)
    edits.cc_1.targetType = 'user'
    edits.cc_1.targetIds = ['  u9  ', '', 'u10']
    const rebuilt = applyCcEditsToGraph(CC_GRAPH, edits)
    expect(nonCc(rebuilt)).toEqual(nonCc(original)) // start / approval / end untouched
    expect(rebuilt.edges).toEqual(original.edges) // full topology untouched
    expect(rebuilt.nodes.find((n) => n.key === 'cc_1')!.config).toEqual({ targetType: 'user', targetIds: ['u9', 'u10'] }) // trimmed + empties dropped
  })
  it('does not mutate the input graph', () => {
    const before = clone(CC_GRAPH)
    const edits = ccEditsFromGraph(CC_GRAPH)
    edits.cc_1.targetIds = ['x']
    applyCcEditsToGraph(CC_GRAPH, edits)
    expect(CC_GRAPH).toEqual(before)
  })
})

describe('G-4 untouched round-trip — no spurious diffs from seeding (G-1 floor holds)', () => {
  it('a cc graph round-trips byte-identical through draftFromTemplate → buildApprovalGraph', () => {
    const original = clone(CC_GRAPH)
    expect(buildApprovalGraph(draftFromTemplate(buildTemplate(CC_GRAPH)))).toEqual(original)
  })
  it('a condition+cc graph round-trips byte-identical untouched', () => {
    const original = clone(CONDITION_PLUS_CC_GRAPH)
    expect(buildApprovalGraph(draftFromTemplate(buildTemplate(CONDITION_PLUS_CC_GRAPH)))).toEqual(original)
  })
})

describe('G-4 cross-phase — cc + condition edits compose; nothing else drifts', () => {
  it('editing a condition rule AND a cc target both land; all other nodes + edges byte-identical', () => {
    const draft: TemplateAuthoringDraft = draftFromTemplate(buildTemplate(CONDITION_PLUS_CC_GRAPH))
    // edit the condition rule value + the cc target
    draft.conditionEdits!.cond_1.branches[0].rules[0].value = 5000
    draft.ccEdits!.cc_1.targetIds = ['u2']
    const rebuilt = buildApprovalGraph(draft)
    // condition + cc reflect the edits
    expect((rebuilt.nodes.find((n) => n.key === 'cond_1')!.config as { branches: { rules: { value: unknown }[] }[] }).branches[0].rules[0].value).toBe(5000)
    expect(rebuilt.nodes.find((n) => n.key === 'cc_1')!.config).toEqual({ targetType: 'user', targetIds: ['u2'] })
    // everything else byte-identical
    const other = (g: ApprovalGraph) => g.nodes.filter((n) => n.type !== 'cc' && n.type !== 'condition')
    expect(other(rebuilt)).toEqual(other(CONDITION_PLUS_CC_GRAPH))
    expect(rebuilt.edges).toEqual(CONDITION_PLUS_CC_GRAPH.edges)
  })
  it('applying cc edits leaves condition nodes byte-identical (disjoint passes)', () => {
    const condEdits = conditionEditsFromGraph(CONDITION_PLUS_CC_GRAPH)
    const afterCond = applyConditionEditsToGraph(CONDITION_PLUS_CC_GRAPH, condEdits)
    const afterCc = applyCcEditsToGraph(afterCond, ccEditsFromGraph(CONDITION_PLUS_CC_GRAPH))
    expect(afterCc).toEqual(CONDITION_PLUS_CC_GRAPH) // seeded (untouched) compose is identity
  })
})

describe('validateCcEdits (preview mirrors the backend cc rule)', () => {
  it('offers exactly [user, role]', () => {
    expect([...CC_TARGET_TYPES]).toEqual(['user', 'role'])
  })
  it('passes a valid cc edit', () => {
    expect(validateCcEdits({ cc_1: { nodeKey: 'cc_1', targetType: 'user', targetIds: ['u1'] } })).toEqual([])
  })
  it('flags an empty targetIds', () => {
    expect(validateCcEdits({ cc_1: { nodeKey: 'cc_1', targetType: 'user', targetIds: ['', '  '] } })[0]).toMatch(/至少需要一个抄送对象/)
  })
  it('flags an invalid targetType', () => {
    expect(validateCcEdits({ cc_1: { nodeKey: 'cc_1', targetType: 'dept' as never, targetIds: ['u1'] } })[0]).toMatch(/类型无效/)
  })
  it('surfaces a cc preview error through validateTemplateDraft', () => {
    const draft = draftFromTemplate(buildTemplate(CC_GRAPH))
    draft.ccEdits!.cc_1.targetIds = []
    expect(validateTemplateDraft(draft).some((e) => /抄送/.test(e))).toBe(true)
  })
})
