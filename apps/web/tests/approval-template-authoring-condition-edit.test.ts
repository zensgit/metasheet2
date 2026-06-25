import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  validateTemplateDraft,
  type ConditionEdits,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import {
  applyConditionEditsToGraph,
  conditionEditsFromGraph,
  validateConditionEdits,
} from '../src/approvals/conditionEdit'

// G-2 — condition branch editing. PURE-LOGIC tests (no .vue / no Element Plus) so they run under
// the approval-web-guard CI gate. The GATE is topology-preservation: editing a condition node's
// LOGIC (rules / conjunction / defaultEdgeKey) must leave every OTHER node and ALL edges
// byte-identical, and an untouched complex graph must still round-trip byte-identical (G-1 floor).
// parallel / cc stay read-only (G-3 / G-4) — unaffected here.

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

// A condition graph: one condition node with a single explicit branch (rules + conjunction) + a
// defaultEdgeKey, fanning out to two approval arms. This is the same shape the G-1 round-trip uses.
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

const CONDITION_FORMULA_GRAPH: ApprovalGraph = {
  ...CONDITION_GRAPH,
  nodes: CONDITION_GRAPH.nodes.map((node) => {
    if (node.key !== 'cond_1' || node.type !== 'condition') return node
    return {
      ...node,
      config: {
        branches: [
          {
            edgeKey: 'edge-cond_1-high',
            rules: [],
            formula: { expression: 'SUM({items.amount}) >= 5000' },
          },
        ],
        defaultEdgeKey: 'edge-cond_1-low',
      },
    }
  }),
}

const CONDITION_FORMULA_WITH_CONJUNCTION_GRAPH: ApprovalGraph = {
  ...CONDITION_FORMULA_GRAPH,
  nodes: CONDITION_FORMULA_GRAPH.nodes.map((node) => {
    if (node.key !== 'cond_1' || node.type !== 'condition') return node
    return {
      ...node,
      config: {
        branches: [
          {
            edgeKey: 'edge-cond_1-high',
            conjunction: 'or',
            rules: [],
            formula: { expression: 'SUM({items.amount}) >= 5000' },
          },
        ],
        defaultEdgeKey: 'edge-cond_1-low',
      },
    }
  }),
}

// A condition node with NO conjunction on its branch (backend omits it) — proves seeding+rebuild do
// not resurrect a spurious `conjunction: 'and'`.
const CONDITION_GRAPH_NO_CONJUNCTION: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'cond_1',
      type: 'condition',
      name: '类型判断',
      config: {
        branches: [
          { edgeKey: 'edge-cond_1-a', rules: [{ fieldId: 'kind', operator: 'eq', value: 'a' }] },
          { edgeKey: 'edge-cond_1-b', rules: [{ fieldId: 'amount', operator: 'isEmpty' }] },
        ],
      },
    },
    {
      key: 'approval_a',
      type: 'approval',
      name: 'A',
      config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
    },
    {
      key: 'approval_b',
      type: 'approval',
      name: 'B',
      config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-cond_1', source: 'start', target: 'cond_1' },
    { key: 'edge-cond_1-a', source: 'cond_1', target: 'approval_a' },
    { key: 'edge-cond_1-b', source: 'cond_1', target: 'approval_b' },
    { key: 'edge-approval_a-end', source: 'approval_a', target: 'end' },
    { key: 'edge-approval_b-end', source: 'approval_b', target: 'end' },
  ],
}

// A PARALLEL graph (no condition node) — G-2 must leave it byte-identical (parallel stays read-only).
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

// A CC graph (no condition node) — G-2 must leave it byte-identical (cc stays read-only).
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

/** Assert the two graphs agree on EVERY non-condition node + the FULL edge list (topology gate). */
function expectTopologyByteIdentical(rebuilt: ApprovalGraph, original: ApprovalGraph): void {
  const nonCond = (graph: ApprovalGraph) => graph.nodes.filter((node) => node.type !== 'condition')
  // every non-condition node byte-identical (start / approval arms / parallel / cc / end)
  expect(nonCond(rebuilt)).toEqual(nonCond(original))
  // the FULL edge array byte-identical (no edge dropped / added / reordered / retargeted)
  expect(rebuilt.edges).toEqual(original.edges)
  // node identity + ORDER preserved (no reordering even of the condition node)
  expect(rebuilt.nodes.map((node) => node.key)).toEqual(original.nodes.map((node) => node.key))
}

describe('G-2 conditionEditsFromGraph — seed from preserved condition nodes', () => {
  it('captures one entry per condition node, branches 1:1', () => {
    const edits = conditionEditsFromGraph(CONDITION_GRAPH)
    expect(Object.keys(edits)).toEqual(['cond_1'])
    expect(edits.cond_1.branches.map((branch) => branch.edgeKey)).toEqual(['edge-cond_1-high'])
    expect(edits.cond_1.branches[0].predicateMode).toBe('rules')
    expect(edits.cond_1.branches[0].rules).toEqual([{ fieldId: 'amount', operator: 'gte', value: 1000 }])
    expect(edits.cond_1.defaultEdgeKey).toBe('edge-cond_1-low')
  })

  it('captures formula branches without flattening them back to rules', () => {
    const edits = conditionEditsFromGraph(CONDITION_FORMULA_GRAPH)
    expect(edits.cond_1.branches[0]).toMatchObject({
      edgeKey: 'edge-cond_1-high',
      predicateMode: 'formula',
      formulaExpression: 'SUM({items.amount}) >= 5000',
      rules: [],
    })
  })

  it('is empty for a parallel / cc graph (no condition node)', () => {
    expect(conditionEditsFromGraph(PARALLEL_GRAPH)).toEqual({})
    expect(conditionEditsFromGraph(CC_GRAPH)).toEqual({})
  })

  it('defaults a missing branch conjunction to "and" in the edit model', () => {
    const edits = conditionEditsFromGraph(CONDITION_GRAPH_NO_CONJUNCTION)
    expect(edits.cond_1.branches.every((branch) => branch.conjunction === 'and')).toBe(true)
  })
})

describe('G-2 topology-preservation — editing a condition rule keeps everything else byte-identical', () => {
  it('edit a rule → buildApprovalGraph → ONLY the condition node config changes; all other nodes + edges byte-identical', () => {
    const template = buildTemplate(CONDITION_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    // change the rule's value 1000 → 5000 (logic edit, no topology change)
    draft.conditionEdits!.cond_1.branches[0].rules[0].value = 5000
    const rebuilt = buildApprovalGraph(draft)

    // GATE: every non-condition node + the full edge array are byte-identical to the original.
    expectTopologyByteIdentical(rebuilt, original)
    // the ONE condition node reflects the edit (and nothing else about it changed).
    const cond = rebuilt.nodes.find((node) => node.key === 'cond_1')!
    expect(cond.config).toEqual({
      branches: [
        { edgeKey: 'edge-cond_1-high', conjunction: 'and', rules: [{ fieldId: 'amount', operator: 'gte', value: 5000 }] },
      ],
      defaultEdgeKey: 'edge-cond_1-low',
    })
    // the original condition node still said 1000 (we did not mutate the input graph).
    const origCond = original.nodes.find((node) => node.key === 'cond_1')! as { config: { branches: { rules: { value: unknown }[] }[] } }
    expect(origCond.config.branches[0].rules[0].value).toBe(1000)
  })

  it('changing a branch conjunction and defaultEdgeKey keeps all other nodes + edges byte-identical', () => {
    const template = buildTemplate(CONDITION_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    draft.conditionEdits!.cond_1.branches[0].conjunction = 'or'
    draft.conditionEdits!.cond_1.defaultEdgeKey = 'edge-cond_1-high'
    const rebuilt = buildApprovalGraph(draft)

    expectTopologyByteIdentical(rebuilt, original)
    const cond = rebuilt.nodes.find((node) => node.key === 'cond_1')!
    expect(cond.config).toEqual({
      branches: [
        { edgeKey: 'edge-cond_1-high', conjunction: 'or', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] },
      ],
      defaultEdgeKey: 'edge-cond_1-high',
    })
  })

  it('adding/removing a RULE (not a branch) preserves topology byte-identical', () => {
    const template = buildTemplate(CONDITION_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    // add a second rule to the existing branch — still no topology change.
    draft.conditionEdits!.cond_1.branches[0].rules.push({ fieldId: 'kind', operator: 'eq', value: 'a' })
    const rebuilt = buildApprovalGraph(draft)

    expectTopologyByteIdentical(rebuilt, original)
    const cond = rebuilt.nodes.find((node) => node.key === 'cond_1')! as { config: { branches: { rules: unknown[] }[] } }
    expect(cond.config.branches[0].rules).toEqual([
      { fieldId: 'amount', operator: 'gte', value: 1000 },
      { fieldId: 'kind', operator: 'eq', value: 'a' },
    ])
  })

  it('editing a formula branch emits formula + empty rules and preserves topology byte-identical', () => {
    const template = buildTemplate(CONDITION_FORMULA_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    draft.conditionEdits!.cond_1.branches[0].formulaExpression = 'SUM({items.amount}) >= 20000'
    const rebuilt = buildApprovalGraph(draft)

    expectTopologyByteIdentical(rebuilt, original)
    const cond = rebuilt.nodes.find((node) => node.key === 'cond_1')!
    expect(cond.config).toEqual({
      branches: [
        { edgeKey: 'edge-cond_1-high', rules: [], formula: { expression: 'SUM({items.amount}) >= 20000' } },
      ],
      defaultEdgeKey: 'edge-cond_1-low',
    })
  })
})

describe('G-2 untouched round-trip — no spurious diffs from seeding (G-1 floor holds)', () => {
  it('an UNTOUCHED condition graph round-trips byte-identical through draftFromTemplate → buildApprovalGraph', () => {
    const template = buildTemplate(CONDITION_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(rebuilt).toEqual(original)
  })

  it('an UNTOUCHED condition graph WITHOUT branch conjunctions round-trips byte-identical (no resurrected conjunction)', () => {
    const template = buildTemplate(CONDITION_GRAPH_NO_CONJUNCTION)
    const original = structuredClone(template.approvalGraph)
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(rebuilt).toEqual(original)
    // explicit: the branches still carry NO conjunction key.
    const cond = rebuilt.nodes.find((node) => node.key === 'cond_1')! as { config: { branches: Record<string, unknown>[] } }
    expect(cond.config.branches.every((branch) => !('conjunction' in branch))).toBe(true)
    // and the isEmpty rule still carries NO value key.
    const isEmptyRule = (cond.config.branches[1] as { rules: Record<string, unknown>[] }).rules[0]
    expect('value' in isEmptyRule).toBe(false)
  })

  it('applyConditionEditsToGraph with the seeded edits is identity for the condition graph', () => {
    const edits = conditionEditsFromGraph(CONDITION_GRAPH)
    expect(applyConditionEditsToGraph(CONDITION_GRAPH, edits)).toEqual(CONDITION_GRAPH)
  })

  it('applyConditionEditsToGraph with seeded formula edits is identity for a formula condition graph', () => {
    const edits = conditionEditsFromGraph(CONDITION_FORMULA_GRAPH)
    expect(applyConditionEditsToGraph(CONDITION_FORMULA_GRAPH, edits)).toEqual(CONDITION_FORMULA_GRAPH)
  })

  it('a formula branch with a backend-preserved conjunction stays byte-identical', () => {
    const edits = conditionEditsFromGraph(CONDITION_FORMULA_WITH_CONJUNCTION_GRAPH)
    expect(applyConditionEditsToGraph(CONDITION_FORMULA_WITH_CONJUNCTION_GRAPH, edits)).toEqual(CONDITION_FORMULA_WITH_CONJUNCTION_GRAPH)
  })
})

describe('G-2 parallel / cc unaffected — still byte-identical-preserved (G-3/G-4 read-only)', () => {
  it('a PARALLEL graph round-trips byte-identical (G-2 leaves it untouched, no condition edits)', () => {
    const template = buildTemplate(PARALLEL_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    // no condition node ⇒ no condition edits seeded.
    expect(draft.conditionEdits).toEqual({})
    const rebuilt = buildApprovalGraph(draft)
    expect(rebuilt).toEqual(original)
    const fork = rebuilt.nodes.find((node) => node.type === 'parallel')
    expect(fork?.config).toEqual({ branches: ['edge-fork_1-a', 'edge-fork_1-b'], joinMode: 'all', joinNodeKey: 'join_1' })
  })

  it('a CC graph round-trips byte-identical (G-2 leaves it untouched)', () => {
    const template = buildTemplate(CC_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(rebuilt).toEqual(original)
    const cc = rebuilt.nodes.find((node) => node.type === 'cc')
    expect(cc?.config).toEqual({ targetType: 'role', targetIds: ['hr', 'admin'] })
  })

  it('applyConditionEditsToGraph passes a parallel/cc graph through byte-identical with empty edits', () => {
    expect(applyConditionEditsToGraph(PARALLEL_GRAPH, {})).toEqual(PARALLEL_GRAPH)
    expect(applyConditionEditsToGraph(CC_GRAPH, {})).toEqual(CC_GRAPH)
  })
})

describe('G-2 input is never mutated', () => {
  it('applyConditionEditsToGraph does not mutate the source graph', () => {
    const before = structuredClone(CONDITION_GRAPH)
    const edits = conditionEditsFromGraph(CONDITION_GRAPH)
    edits.cond_1.branches[0].rules[0].value = 9999
    applyConditionEditsToGraph(CONDITION_GRAPH, edits)
    expect(CONDITION_GRAPH).toEqual(before)
  })
})

describe('G-2 validation preview (UX-only; backend normalizeApprovalGraph is final arbiter)', () => {
  const formSchema = buildTemplate(CONDITION_GRAPH).formSchema

  it('flags a rule fieldId that is NOT a form field', () => {
    const edits: ConditionEdits = {
      cond_1: {
        nodeKey: 'cond_1',
        branches: [{ edgeKey: 'edge-cond_1-high', predicateMode: 'rules', conjunction: 'and', rules: [{ fieldId: 'ghost', operator: 'gte', value: 1 }], formulaExpression: '' }],
        defaultEdgeKey: 'edge-cond_1-low',
      },
    }
    const errors = validateConditionEdits(edits, formSchema, CONDITION_GRAPH)
    expect(errors.some((message) => message.includes('ghost') && message.includes('不存在'))).toBe(true)
  })

  it('flags a defaultEdgeKey that is NOT an outgoing edge of the condition node', () => {
    // `edge-start-cond_1` exists in the graph but its source is `start`, not `cond_1` — so it is not
    // a legal fall-through edge for this node. (The runtime resolves defaultEdgeKey via the edge
    // list; an edge that doesn't leave this node would route to the wrong place.)
    const edits: ConditionEdits = {
      cond_1: {
        nodeKey: 'cond_1',
        branches: [{ edgeKey: 'edge-cond_1-high', predicateMode: 'rules', conjunction: 'and', rules: [{ fieldId: 'amount', operator: 'gte', value: 1 }], formulaExpression: '' }],
        defaultEdgeKey: 'edge-start-cond_1',
      },
    }
    const errors = validateConditionEdits(edits, formSchema, CONDITION_GRAPH)
    expect(errors.some((message) => message.includes('edge-start-cond_1') && message.includes('默认分支'))).toBe(true)
  })

  it('accepts a defaultEdgeKey that IS an outgoing fall-through edge (distinct from the branch edge)', () => {
    // canonical valid shape: branch edge `edge-cond_1-high`, fall-through default `edge-cond_1-low`
    // — both outgoing from cond_1, NOT the same edge. Must NOT be flagged.
    const edits = conditionEditsFromGraph(CONDITION_GRAPH)
    expect(edits.cond_1.defaultEdgeKey).toBe('edge-cond_1-low')
    expect(validateConditionEdits(edits, formSchema, CONDITION_GRAPH)).toEqual([])
  })

  it('flags an empty rule fieldId (needs a field chosen)', () => {
    const edits: ConditionEdits = {
      cond_1: {
        nodeKey: 'cond_1',
        branches: [{ edgeKey: 'edge-cond_1-high', predicateMode: 'rules', conjunction: 'and', rules: [{ fieldId: '', operator: 'gte', value: 1 }], formulaExpression: '' }],
        defaultEdgeKey: '',
      },
    }
    const errors = validateConditionEdits(edits, formSchema, CONDITION_GRAPH)
    expect(errors.some((message) => message.includes('需要选择字段'))).toBe(true)
  })

  it('passes a valid seeded edit (fieldId exists, defaultEdgeKey is a real outgoing edge)', () => {
    const edits = conditionEditsFromGraph(CONDITION_GRAPH)
    expect(validateConditionEdits(edits, formSchema, CONDITION_GRAPH)).toEqual([])
  })

  it('surfaces the rule-fieldId error through validateTemplateDraft when the draft carries condition edits', () => {
    const draft: TemplateAuthoringDraft = draftFromTemplate(buildTemplate(CONDITION_GRAPH))
    draft.conditionEdits!.cond_1.branches[0].rules[0].fieldId = 'ghost'
    const errors = validateTemplateDraft(draft, null)
    expect(errors.some((message) => message.includes('ghost'))).toBe(true)
  })

  it('surfaces the defaultEdgeKey error through validateTemplateDraft (checked against preservedGraph edges)', () => {
    const draft: TemplateAuthoringDraft = draftFromTemplate(buildTemplate(CONDITION_GRAPH))
    draft.conditionEdits!.cond_1.defaultEdgeKey = 'edge-start-cond_1'
    const errors = validateTemplateDraft(draft, null)
    expect(errors.some((message) => message.includes('edge-start-cond_1') && message.includes('默认分支'))).toBe(true)
  })

  it('an untouched condition draft produces NO validation errors (G-1 floor: valid graph stays valid)', () => {
    const draft: TemplateAuthoringDraft = draftFromTemplate(buildTemplate(CONDITION_GRAPH))
    // only condition-edit errors are asserted absent; key/name are seeded so the draft is complete.
    expect(validateTemplateDraft(draft, null).filter((message) => message.includes('条件节点'))).toEqual([])
  })
})
