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
  addAssigneeSourceCard,
  applyApprovalNodeEditsToGraph,
  approvalNodeEditsFromGraph,
  legalPriorApproverNodeKeys,
  placeholderRoleNodeKeys,
  removeAssigneeSourceCard,
  validateApprovalNodeEdits,
  type ApprovalNodeEdits,
} from '../src/approvals/approvalNodeEdit'

// Approval-node editing inside the graph authoring model. PURE-LOGIC tests (no .vue)
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
      approval_1: {
        nodeKey: 'approval_1',
        assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
        autoApprovalPolicy: { mergeWithRequester: true },
      },
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
  it('edits mode, empty policy, requester merge, and field permissions without touching topology', () => {
    const edits = approvalNodeEditsFromGraph(APPROVAL_GRAPH)
    edits.approval_1.approvalMode = 'any'
    edits.approval_1.emptyAssigneePolicy = 'auto-approve'
    edits.approval_1.autoApprovalPolicy = null
    edits.approval_1.fieldPermissions = [{ fieldId: 'amount', access: 'hidden' }]
    const rebuilt = applyApprovalNodeEditsToGraph(APPROVAL_GRAPH, edits)
    const cfg = node(rebuilt, 'approval_1').config as Record<string, unknown>
    expect(cfg).toMatchObject({
      approvalMode: 'any',
      emptyAssigneePolicy: 'auto-approve',
      fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
    })
    expect(cfg.autoApprovalPolicy).toBeUndefined()
    expect(rebuilt.edges).toEqual(APPROVAL_GRAPH.edges)
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
  it('Lock-1 §K2: requester_choice — company/role-with-ids pass; empty members/role list and bad mode are flagged', () => {
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'company' } }] },
    })).toEqual([])
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'requester_choice', mode: 'multi', scope: { type: 'role', roleIds: ['r1'] } }] },
    })).toEqual([])
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'requester_choice', mode: 'multi', scope: { type: 'members', userIds: [] } }] },
    })[0]).toMatch(/requester_choice/)
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'requester_choice', mode: 'multi', scope: { type: 'role', roleIds: ['  '] } }] },
    })[0]).toMatch(/requester_choice/)
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'requester_choice', mode: 'both', scope: { type: 'company' } } as never] },
    })[0]).toMatch(/requester_choice/)
  })
  it('Lock-1 §K4: continuous_dept_heads — a positive integer levels passes; 0/non-integer is flagged (isAssigneeSourceValid mirror site)', () => {
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'continuous_dept_heads', levels: 3 }] },
    })).toEqual([])
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'continuous_dept_heads', levels: 0 }] },
    })[0]).toMatch(/continuous_dept_heads/)
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'continuous_dept_heads', levels: 1.5 }] },
    })[0]).toMatch(/continuous_dept_heads/)
  })
  it('Lock-1 §K5-b: dept_head_at_level — a positive integer level passes; 0/non-integer is flagged (isAssigneeSourceValid mirror site)', () => {
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'dept_head_at_level', level: 2 }] },
    })).toEqual([])
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'dept_head_at_level', level: 0 }] },
    })[0]).toMatch(/dept_head_at_level/)
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'dept_head_at_level', level: 1.5 }] },
    })[0]).toMatch(/dept_head_at_level/)
  })
  // Lock-3 §1.5 deferral invariant: dept_head_at_level (K5-b) is NOT in the handler roster in
  // this slice (Lock-3's forward ADMIT is a separate follow-up — see
  // approval-handler-node-authoring.spec.ts's exact-set test). A handler carrying it must fail
  // closed here too.
  it('Lock-3 §1.5 deferral: a HANDLER node carrying dept_head_at_level is rejected (not in the seven-member handler roster)', () => {
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', nodeType: 'handler', assigneeSources: [{ kind: 'dept_head_at_level', level: 1 }] },
    })[0]).toMatch(/dept_head_at_level/)
  })

  it('Lock-1 §K3: prior_node_approver — a non-empty nodeKey passes; an empty/blank one is flagged (isAssigneeSourceValid mirror site)', () => {
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'prior_node_approver', nodeKey: 'gate' }] },
    })).toEqual([])
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'prior_node_approver', nodeKey: '' }] },
    })[0]).toMatch(/prior_node_approver/)
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', assigneeSources: [{ kind: 'prior_node_approver', nodeKey: '   ' }] },
    })[0]).toMatch(/prior_node_approver/)
  })
  // Lock-3 §1.5: prior_node_approver (K3) has NO handler row at all (not even a forward ADMIT) —
  // a handler carrying it must fail closed.
  it('Lock-1 §K3 / Lock-3 §1.5: a HANDLER node carrying prior_node_approver is rejected (not in the seven-member handler roster)', () => {
    expect(validateApprovalNodeEdits({
      a: { nodeKey: 'a', nodeType: 'handler', assigneeSources: [{ kind: 'prior_node_approver', nodeKey: 'gate' }] },
    })[0]).toMatch(/prior_node_approver/)
  })
})

// Lock-1 §K3 — legalPriorApproverNodeKeys: the FE mirror of the backend publish dominance gate
// (`assertPriorNodeApproverReferencesUpstream`), driving the typed node picker. Candidate ⟺
// approval node, ≠ carrier, strictly upstream on EVERY runtime-reachable path (removal test).
// The full shape matrix (condition-branch / parallel-sibling / downstream / dangling) is owned by
// the backend gate's own unit suite; this proves the MIRROR agrees on the discriminating shapes.
describe('Lock-1 §K3: legalPriorApproverNodeKeys (typed picker candidates)', () => {
  it('linear chain: offers exactly the strictly-earlier approval nodes (never self, never downstream, never start/end)', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'a1', type: 'approval', name: '一审', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'a2', type: 'approval', name: '二审', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'a3', type: 'approval', name: '三审', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'a1' },
        { key: 'e2', source: 'a1', target: 'a2' },
        { key: 'e3', source: 'a2', target: 'a3' },
        { key: 'e4', source: 'a3', target: 'end' },
      ],
    }
    expect(legalPriorApproverNodeKeys(graph, 'a3')).toEqual(['a1', 'a2'])
    expect(legalPriorApproverNodeKeys(graph, 'a2')).toEqual(['a1'])
    // The first approval node has nothing upstream — an empty candidate list (positive control
    // that the non-empty lists above are carrier-selected, not a constant).
    expect(legalPriorApproverNodeKeys(graph, 'a1')).toEqual([])
  })

  it('condition merge: a node reachable only through ONE branch is NOT offered after the merge; the pre-condition node is', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'pre', type: 'approval', name: '预审', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'route', type: 'condition', name: '判断', config: { branches: [{ edgeKey: 'edge-b1', rules: [{ fieldId: 'amount', operator: 'gt', value: 1 }] }], defaultEdgeKey: 'edge-b2' } },
        { key: 'branch-a', type: 'approval', name: '高额', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'branch-b', type: 'approval', name: '低额', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'merge', type: 'approval', name: '终审', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'pre' },
        { key: 'e2', source: 'pre', target: 'route' },
        { key: 'edge-b1', source: 'route', target: 'branch-a' },
        { key: 'edge-b2', source: 'route', target: 'branch-b' },
        { key: 'e3', source: 'branch-a', target: 'merge' },
        { key: 'e4', source: 'branch-b', target: 'merge' },
        { key: 'e5', source: 'merge', target: 'end' },
      ],
    }
    expect(legalPriorApproverNodeKeys(graph, 'merge')).toEqual(['pre'])
    // Within a branch, the pre-condition node is still on every path — offered.
    expect(legalPriorApproverNodeKeys(graph, 'branch-a')).toEqual(['pre'])
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

  // Lock-1 §K2: requester_choice is the FIRST source with a nested object (`scope`), so its
  // allowlist check needs a third level — the flat 2-level allowlist alone cannot see inside it.
  it('K2: a well-formed requester_choice source is allowed on the complex path (every scope type)', () => {
    for (const scope of [
      { type: 'company' },
      { type: 'members', userIds: ['u1'] },
      { type: 'role', roleIds: ['r1'] },
    ]) {
      const graph = complexWith({ assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope }] })
      expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
    }
  })
  it('K2: a malformed requester_choice (extra scope key / unknown scope type / bad mode) forces read-only', () => {
    const extraScopeKey = complexWith({
      assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'members', userIds: ['u1'], futureFlag: true } }],
    })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(extraScopeKey))).not.toBeNull()
    const unknownScopeType = complexWith({
      assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'dept' } }],
    })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(unknownScopeType))).not.toBeNull()
    const badMode = complexWith({
      assigneeSources: [{ kind: 'requester_choice', mode: 'both', scope: { type: 'company' } }],
    })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(badMode))).not.toBeNull()
  })

  // NESTED unknown keys: the backend rebuilds assigneeSources[] / autoApprovalPolicy / fieldPermissions[]
  // from fixed fields too, so a nested unknown key is ALSO silently dropped on save — must be fail-closed,
  // not just top-level keys.
  it('flags a nested unknown key in an assigneeSources entry (backend drops it)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager', futureFlag: true }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('flags a nested unknown key in autoApprovalPolicy (backend drops it)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], autoApprovalPolicy: { mergeWithRequester: true, futureFlag: true } })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('flags a nested unknown key in a fieldPermissions entry (backend drops it)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], fieldPermissions: [{ fieldId: 'amount', access: 'hidden', futureFlag: true }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('flags an unknown assignee source KIND', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'future_kind' }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('ALLOWS fully-known nested shapes (per-kind fields + all 4 policy fields + fieldPermissions {fieldId,access})', () => {
    const graph = complexWith({
      assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }, { kind: 'manager_at_level', level: 2 }],
      autoApprovalPolicy: { mergeWithRequester: true, mergeAdjacentApprover: false, dedupeHistoricalApprover: true, actorMode: 'system' },
      fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
    })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })

  // Lock-1 §K4 — BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND mirror site: continuous_dept_heads must be
  // ALLOWED (present in the allowlist) on the complex path, and an extra key on it must still be
  // caught (the allowlist is per-kind exact, not a blanket pass-through).
  it('K4: continuous_dept_heads is allowed on the complex path (registered in BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'continuous_dept_heads', levels: 3 }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
  it('K4: a continuous_dept_heads source with an unknown extra key forces read-only', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'continuous_dept_heads', levels: 3, futureFlag: true }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })

  // Lock-1 §K5-b — BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND mirror site: dept_head_at_level must be
  // ALLOWED (present in the allowlist) on the complex path, and an extra key on it must still be
  // caught (the allowlist is per-kind exact, not a blanket pass-through).
  it('K5-b: dept_head_at_level is allowed on the complex path (registered in BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'dept_head_at_level', level: 2 }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
  it('K5-b: a dept_head_at_level source with an unknown extra key forces read-only', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'dept_head_at_level', level: 2, futureFlag: true }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })

  // Lock-1 §K3 — BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND mirror site: prior_node_approver must be
  // ALLOWED (present in the allowlist) on the complex path, and an extra key on it must still be
  // caught (the allowlist is per-kind exact, not a blanket pass-through).
  it('K3: prior_node_approver is allowed on the complex path (registered in BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'prior_node_approver', nodeKey: 'approval_0' }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
  it('K3: a prior_node_approver source with an unknown extra key forces read-only', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'prior_node_approver', nodeKey: 'approval_0', futureFlag: true }] })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
})

// P1-B — master §P1-B / approval-parity-master-design-lock-20260817.md: remove the linear/canvas
// editor's single-source restriction and expose ALL existing assignee sources as editable cards.
// This slice is FE-ONLY (the engine's `assigneeSources[]` union + identity dedup already ships —
// ApprovalAssigneeResolver.ts:150 `sources.forEach`, dedup at :121-123). These are the PURE-LOGIC
// halves: hydrate seeds the FULL array (not just [0]), addAssigneeSourceCard/removeAssigneeSourceCard
// are the edit-model mutators the config editor's add/remove buttons delegate to, and
// applyApprovalNodeEditsToGraph is the publish-payload-shape pin. The .vue wiring (multi-card render,
// buttons, hydrate showing N cards) is covered in approval-template-authoring-canvas-inspector.spec.ts
// (direct component mount) and approvalTemplateAuthoring.spec.ts (full SFC mount, real save payload).
describe('P1-B: multi-source assignee cards — hydrate seeds the FULL array', () => {
  // A cc node forces the COMPLEX/preserved-graph path (matches this suite's established
  // LEGACY_GRAPH/FOUR_TYPE_GRAPH convention above) — this is the P1-B surface
  // (`draft.approvalNodeEdits` → `ApprovalGraphNodeConfigEditor.vue`). A PURE linear topology
  // (no condition/parallel/cc/handler node) instead projects through the SEPARATE `draft.steps`
  // wizard model, whose `sourceFromStep` is single-source by design and stays that way — that
  // model is an explicit P1-B non-goal (master lock source-anchor: "linear editor" = this SFC,
  // not the step wizard), not a regression to chase here.
  const TWO_SOURCE_GRAPH: ApprovalGraph = {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'approval_1', type: 'approval', name: '主管',
        config: {
          assigneeSources: [{ kind: 'direct_manager' }, { kind: 'dept_head' }],
          approvalMode: 'any', emptyAssigneePolicy: 'error',
        },
      },
      { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['finance'] } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'cc_1' },
      { key: 'e3', source: 'cc_1', target: 'end' },
    ],
  }

  it('seeds ALL sources, not only assigneeSources[0] (mutation: hydrate only [0] → this reds)', () => {
    const edits = approvalNodeEditsFromGraph(TWO_SOURCE_GRAPH)
    // A hydrate regressed to `assigneeSources: [node.config.assigneeSources[0]]` still passes a
    // length-agnostic `toContainEqual`-style check, so pin the exact array — length AND contents.
    expect(edits.approval_1.assigneeSources).toEqual([{ kind: 'direct_manager' }, { kind: 'dept_head' }])
    expect(edits.approval_1.assigneeSources).toHaveLength(2)
  })

  it('round-trips 2 sources byte-identically through draftFromTemplate → buildApprovalGraph (no card dropped)', () => {
    const original = JSON.parse(JSON.stringify(TWO_SOURCE_GRAPH)) as ApprovalGraph
    const rebuilt = buildApprovalGraph(draftFromTemplate(buildTemplate(TWO_SOURCE_GRAPH)))
    expect(rebuilt).toEqual(original)
  })
})

describe('P1-B: addAssigneeSourceCard — appends without touching existing cards', () => {
  function twoNodeEdits(sources: Array<Record<string, unknown>>): ApprovalNodeEdits {
    return {
      approval_1: { nodeKey: 'approval_1', assigneeSources: sources as never },
      approval_2: { nodeKey: 'approval_2', assigneeSources: [{ kind: 'requester' }] },
    }
  }

  it('appends the new card at the END; the existing card is untouched (positive control: single-source template still works)', () => {
    const edits = twoNodeEdits([{ kind: 'direct_manager' }])
    addAssigneeSourceCard(edits, 'approval_1', { kind: 'dept_head' })
    expect(edits.approval_1.assigneeSources).toEqual([{ kind: 'direct_manager' }, { kind: 'dept_head' }])
    // The OTHER node's edit is completely untouched — add is scoped to the named node only.
    expect(edits.approval_2.assigneeSources).toEqual([{ kind: 'requester' }])
  })

  it('is a no-op for a node key absent from edits (no crash, no stray entry created)', () => {
    const edits = twoNodeEdits([{ kind: 'direct_manager' }])
    addAssigneeSourceCard(edits, 'no_such_node', { kind: 'requester' })
    expect(Object.keys(edits)).toEqual(['approval_1', 'approval_2'])
  })

  it('deep-clones the default source — mutating the caller-supplied object afterward does not alter the stored card', () => {
    const edits = twoNodeEdits([{ kind: 'direct_manager' }])
    const mutableDefault: { kind: string; userIds: string[] } = { kind: 'static_user', userIds: ['u1'] }
    addAssigneeSourceCard(edits, 'approval_1', mutableDefault as never)
    mutableDefault.userIds.push('u2')
    expect(edits.approval_1.assigneeSources[1]).toEqual({ kind: 'static_user', userIds: ['u1'] })
  })
})

describe('P1-B: removeAssigneeSourceCard — removes the RIGHT card and is fail-closed at length<=1', () => {
  function twoSourceEdits(): ApprovalNodeEdits {
    return {
      approval_1: {
        nodeKey: 'approval_1',
        // Deliberately distinguishable shapes (not two of the same kind) so a splice off-by-one
        // is provable, not just a count check.
        assigneeSources: [{ kind: 'direct_manager' }, { kind: 'dept_head' }, { kind: 'requester' }] as never,
      },
    }
  }

  it('removes the card AT sourceIndex; the SURVIVORS are the other two, in original order (not a count-only check)', () => {
    const edits = twoSourceEdits()
    removeAssigneeSourceCard(edits, 'approval_1', 1) // remove the MIDDLE card (dept_head)
    expect(edits.approval_1.assigneeSources).toEqual([{ kind: 'direct_manager' }, { kind: 'requester' }])
  })

  it('removes index 0 correctly (not always "the last element" — discriminates a hardcoded pop/slice(1))', () => {
    const edits = twoSourceEdits()
    removeAssigneeSourceCard(edits, 'approval_1', 0)
    expect(edits.approval_1.assigneeSources).toEqual([{ kind: 'dept_head' }, { kind: 'requester' }])
  })

  it('is a no-op for an out-of-range index (no crash, array untouched)', () => {
    const edits = twoSourceEdits()
    removeAssigneeSourceCard(edits, 'approval_1', 99)
    expect(edits.approval_1.assigneeSources).toHaveLength(3)
    removeAssigneeSourceCard(edits, 'approval_1', -1)
    expect(edits.approval_1.assigneeSources).toHaveLength(3)
  })

  it('is a no-op for a missing node key', () => {
    const edits = twoSourceEdits()
    removeAssigneeSourceCard(edits, 'no_such_node', 0)
    expect(Object.keys(edits)).toEqual(['approval_1'])
  })

  // THE fail-closed guard (master §P1-B: "a node must keep ≥1 source; removing the last is
  // forbidden"). Positive control immediately above (2→2 survivors from a 3-source node) proves
  // removal genuinely works; this proves it stops working at exactly 1. A mutation flipping the
  // `length <= 1` guard to allow last-removal turns this red.
  it('FAIL-CLOSED: refuses to remove the last remaining source — the node keeps its one card', () => {
    const edits: ApprovalNodeEdits = {
      approval_1: { nodeKey: 'approval_1', assigneeSources: [{ kind: 'direct_manager' }] },
    }
    removeAssigneeSourceCard(edits, 'approval_1', 0)
    expect(edits.approval_1.assigneeSources).toEqual([{ kind: 'direct_manager' }]) // unchanged — refused
    expect(edits.approval_1.assigneeSources).toHaveLength(1)
  })

  it('positive control for the guard above: at length 2, removal DOES proceed (the guard is length-selected, not a blanket refusal)', () => {
    const edits: ApprovalNodeEdits = {
      approval_1: { nodeKey: 'approval_1', assigneeSources: [{ kind: 'direct_manager' }, { kind: 'dept_head' }] },
    }
    removeAssigneeSourceCard(edits, 'approval_1', 0)
    expect(edits.approval_1.assigneeSources).toEqual([{ kind: 'dept_head' }])
  })
})

describe('P1-B: publish-payload-shape pin — applyApprovalNodeEditsToGraph serializes ALL sources', () => {
  const THREE_SOURCE_GRAPH: ApprovalGraph = {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      {
        key: 'approval_1', type: 'approval', name: '主管',
        config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'any', emptyAssigneePolicy: 'error' },
      },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'end' },
    ],
  }

  it('a 3-source edit serializes as exactly 3 sources, in order, on the rebuilt graph (mutation dropping sources[1..] reds)', () => {
    const edits = approvalNodeEditsFromGraph(THREE_SOURCE_GRAPH)
    edits.approval_1.assigneeSources = [
      { kind: 'direct_manager' },
      { kind: 'dept_head' },
      { kind: 'manager_at_level', level: 2 },
    ]
    const rebuilt = applyApprovalNodeEditsToGraph(THREE_SOURCE_GRAPH, edits)
    const config = rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as { assigneeSources: unknown }
    expect(config.assigneeSources).toEqual([
      { kind: 'direct_manager' },
      { kind: 'dept_head' },
      { kind: 'manager_at_level', level: 2 },
    ])
  })

  it('validateApprovalNodeEdits passes all 3 sources through as independently-validated (a bad card at index 2 is still caught, not lost past index 0)', () => {
    const errors = validateApprovalNodeEdits({
      approval_1: {
        nodeKey: 'approval_1',
        assigneeSources: [
          { kind: 'direct_manager' },
          { kind: 'dept_head' },
          { kind: 'static_role', roleIds: [] }, // invalid — empty roleIds
        ],
      },
    })
    expect(errors.some((e) => /static_role/.test(e))).toBe(true)
  })
})

describe('P1-B: placeholderRoleNodeKeys widened to ALL sources (backend assertNoUnconfiguredPlaceholderRoles loops every source)', () => {
  const SENTINEL = '__APPROVAL_ROLE_PLACEHOLDER__'

  it('catches a placeholder at index 0 (unchanged prior behavior — positive control)', () => {
    const edits: ApprovalNodeEdits = {
      approval_1: { nodeKey: 'approval_1', assigneeSources: [{ kind: 'static_role', roleIds: [SENTINEL] }] },
    }
    expect(placeholderRoleNodeKeys(edits)).toEqual(['approval_1'])
  })

  it('P1-B: ALSO catches a placeholder at index 1 — before multi-card editing, index 1 was never authorable, so this is new coverage', () => {
    const edits: ApprovalNodeEdits = {
      approval_1: {
        nodeKey: 'approval_1',
        assigneeSources: [{ kind: 'direct_manager' }, { kind: 'static_role', roleIds: [SENTINEL] }],
      },
    }
    expect(placeholderRoleNodeKeys(edits)).toEqual(['approval_1'])
  })

  it('a real (non-placeholder) role at any index does not false-positive', () => {
    const edits: ApprovalNodeEdits = {
      approval_1: {
        nodeKey: 'approval_1',
        assigneeSources: [{ kind: 'direct_manager' }, { kind: 'static_role', roleIds: ['real-role-id'] }],
      },
    }
    expect(placeholderRoleNodeKeys(edits)).toEqual([])
  })
})
