import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  validateTemplateDraft,
  type ParallelEdits,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import {
  applyParallelEditsToGraph,
  parallelEditsFromGraph,
  validateParallelEdits,
  PARALLEL_JOIN_MODES,
} from '../src/approvals/parallelEdit'
import { applyConditionEditsToGraph, conditionEditsFromGraph } from '../src/approvals/conditionEdit'

// G-3 — parallel JOIN-MODE editing. PURE-LOGIC tests (no .vue / no Element Plus) so they run under
// the approval-web-guard CI gate. The GATE is topology-preservation + cross-phase preservation:
// editing a parallel node's `joinMode` must leave every OTHER node (start / approval / condition /
// cc / end) and the FULL edge list byte-identical, condition (G-2) edits must compose with parallel
// (G-3) edits, and an untouched complex graph must still round-trip byte-identical (G-1 floor).
// PRE-CHECK: the backend `normalizeApprovalGraph` ACCEPTS both 'all' and 'any' (PARALLEL_JOIN_MODES
// = {'all','any'}, joinMode written verbatim) so the editor offers both — these tests exercise both.

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

// A PARALLEL graph: one fork (branches + joinNodeKey + joinMode 'all') fanning to two approval arms
// that re-converge at a join node. Same shape the G-1/G-2 round-trips use.
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

// A graph carrying BOTH a parallel fork AND a condition node (each arm of the fork routes through a
// condition). Proves G-2 (condition) and G-3 (parallel) edits COMPOSE on the same graph and leave
// the cc-free remainder byte-identical.
const PARALLEL_PLUS_CONDITION_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'fork_1',
      type: 'parallel',
      name: '并行',
      config: { branches: ['edge-fork_1-cond', 'edge-fork_1-b'], joinMode: 'all', joinNodeKey: 'join_1' },
    },
    {
      key: 'cond_1',
      type: 'condition',
      name: '金额判断',
      config: {
        branches: [
          { edgeKey: 'edge-cond_1-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' },
        ],
        defaultEdgeKey: 'edge-cond_1-low',
      },
    },
    { key: 'approval_high', type: 'approval', name: '大额', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'approval_low', type: 'approval', name: '小额', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'approval_b', type: 'approval', name: '法务', config: { assigneeSources: [{ kind: 'static_role', roleIds: ['legal'] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'join_1', type: 'approval', name: '汇聚', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-fork_1', source: 'start', target: 'fork_1' },
    { key: 'edge-fork_1-cond', source: 'fork_1', target: 'cond_1' },
    { key: 'edge-fork_1-b', source: 'fork_1', target: 'approval_b' },
    { key: 'edge-cond_1-high', source: 'cond_1', target: 'approval_high' },
    { key: 'edge-cond_1-low', source: 'cond_1', target: 'approval_low' },
    { key: 'edge-approval_high-join', source: 'approval_high', target: 'join_1' },
    { key: 'edge-approval_low-join', source: 'approval_low', target: 'join_1' },
    { key: 'edge-approval_b-join', source: 'approval_b', target: 'join_1' },
    { key: 'edge-join_1-end', source: 'join_1', target: 'end' },
  ],
}

// A CONDITION-only graph (no parallel node) — G-3 must leave it byte-identical.
const CONDITION_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'cond_1',
      type: 'condition',
      name: '金额判断',
      config: {
        branches: [
          { edgeKey: 'edge-cond_1-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' },
        ],
        defaultEdgeKey: 'edge-cond_1-low',
      },
    },
    { key: 'approval_high', type: 'approval', name: '大额审批', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'approval_low', type: 'approval', name: '小额审批', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'auto-approve' } },
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

// A CC graph (no parallel node) — G-3 must leave it byte-identical (cc stays read-only / G-4).
const CC_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'approval_1', type: 'approval', name: '审批人 1', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'cc_1', type: 'cc', name: '抄送 HR', config: { targetType: 'role', targetIds: ['hr', 'admin'] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
    { key: 'edge-approval_1-cc_1', source: 'approval_1', target: 'cc_1' },
    { key: 'edge-cc_1-end', source: 'cc_1', target: 'end' },
  ],
}

/** Assert the two graphs agree on EVERY non-parallel node + the FULL edge list (topology gate). */
function expectTopologyByteIdentical(rebuilt: ApprovalGraph, original: ApprovalGraph): void {
  const nonParallel = (graph: ApprovalGraph) => graph.nodes.filter((node) => node.type !== 'parallel')
  // every non-parallel node byte-identical (start / approval arms / condition / cc / join / end)
  expect(nonParallel(rebuilt)).toEqual(nonParallel(original))
  // the FULL edge array byte-identical (no edge dropped / added / reordered / retargeted)
  expect(rebuilt.edges).toEqual(original.edges)
  // node identity + ORDER preserved (no reordering even of the parallel node)
  expect(rebuilt.nodes.map((node) => node.key)).toEqual(original.nodes.map((node) => node.key))
}

describe('G-3 parallelEditsFromGraph — seed from preserved parallel nodes', () => {
  it('captures one entry per parallel node carrying its joinMode (1:1)', () => {
    const edits = parallelEditsFromGraph(PARALLEL_GRAPH)
    expect(Object.keys(edits)).toEqual(['fork_1'])
    expect(edits.fork_1).toEqual({ nodeKey: 'fork_1', joinMode: 'all' })
  })

  it('is empty for a condition / cc graph (no parallel node)', () => {
    expect(parallelEditsFromGraph(CONDITION_GRAPH)).toEqual({})
    expect(parallelEditsFromGraph(CC_GRAPH)).toEqual({})
  })

  it('seeds joinMode "any" verbatim from an any-mode fork (backend accepts both)', () => {
    const anyGraph: ApprovalGraph = JSON.parse(JSON.stringify(PARALLEL_GRAPH))
    ;(anyGraph.nodes[1].config as { joinMode: string }).joinMode = 'any'
    expect(parallelEditsFromGraph(anyGraph).fork_1.joinMode).toBe('any')
  })
})

describe('G-3 topology-preservation — editing joinMode keeps everything else byte-identical', () => {
  it('edit joinMode all → any → buildApprovalGraph → ONLY that parallel node config.joinMode changes; all other nodes + edges byte-identical', () => {
    const template = buildTemplate(PARALLEL_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    draft.parallelEdits!.fork_1.joinMode = 'any'
    const rebuilt = buildApprovalGraph(draft)

    // GATE: every non-parallel node + the full edge array are byte-identical to the original.
    expectTopologyByteIdentical(rebuilt, original)
    // the ONE parallel node reflects ONLY the joinMode edit — branches + joinNodeKey unchanged, in
    // their original key positions (key order stays branches, joinMode, joinNodeKey).
    const fork = rebuilt.nodes.find((node) => node.key === 'fork_1')!
    expect(fork.config).toEqual({ branches: ['edge-fork_1-a', 'edge-fork_1-b'], joinMode: 'any', joinNodeKey: 'join_1' })
    expect(Object.keys(fork.config)).toEqual(['branches', 'joinMode', 'joinNodeKey'])
    // the original fork still said 'all' (we did not mutate the input graph).
    const origFork = original.nodes.find((node) => node.key === 'fork_1')! as { config: { joinMode: string } }
    expect(origFork.config.joinMode).toBe('all')
  })

  it('editing joinMode any → all keeps branches + joinNodeKey + all edges byte-identical', () => {
    const anyTemplate = buildTemplate(JSON.parse(JSON.stringify(PARALLEL_GRAPH)))
    ;(anyTemplate.approvalGraph.nodes[1].config as { joinMode: string }).joinMode = 'any'
    const original = structuredClone(anyTemplate.approvalGraph)
    const draft = draftFromTemplate(anyTemplate)
    draft.parallelEdits!.fork_1.joinMode = 'all'
    const rebuilt = buildApprovalGraph(draft)

    expectTopologyByteIdentical(rebuilt, original)
    const fork = rebuilt.nodes.find((node) => node.key === 'fork_1')!
    expect(fork.config).toEqual({ branches: ['edge-fork_1-a', 'edge-fork_1-b'], joinMode: 'all', joinNodeKey: 'join_1' })
  })
})

describe('G-3 cross-phase — condition (G-2) AND parallel (G-3) edits compose; everything else byte-identical', () => {
  it('editing a condition rule AND a parallel joinMode both land; all OTHER nodes + edges byte-identical', () => {
    const template = buildTemplate(PARALLEL_PLUS_CONDITION_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    // both edit models seeded from the one graph
    draft.conditionEdits!.cond_1.branches[0].rules[0].value = 5000
    draft.parallelEdits!.fork_1.joinMode = 'any'
    const rebuilt = buildApprovalGraph(draft)

    // the condition edit landed
    const cond = rebuilt.nodes.find((node) => node.key === 'cond_1')! as { config: { branches: { rules: { value: unknown }[] }[] } }
    expect(cond.config.branches[0].rules[0].value).toBe(5000)
    // the parallel edit landed
    const fork = rebuilt.nodes.find((node) => node.key === 'fork_1')! as { config: { joinMode: string } }
    expect(fork.config.joinMode).toBe('any')

    // EVERYTHING ELSE byte-identical: every node that is NOT cond_1 / fork_1, plus the full edge list.
    const others = (graph: ApprovalGraph) => graph.nodes.filter((node) => node.key !== 'cond_1' && node.key !== 'fork_1')
    expect(others(rebuilt)).toEqual(others(original))
    expect(rebuilt.edges).toEqual(original.edges)
    expect(rebuilt.nodes.map((node) => node.key)).toEqual(original.nodes.map((node) => node.key))
    // input graph never mutated
    const origFork = original.nodes.find((node) => node.key === 'fork_1')! as { config: { joinMode: string } }
    expect(origFork.config.joinMode).toBe('all')
  })

  it('composing applyConditionEditsToGraph then applyParallelEditsToGraph with SEEDED edits is identity', () => {
    const conditionEdits = conditionEditsFromGraph(PARALLEL_PLUS_CONDITION_GRAPH)
    const parallelEdits = parallelEditsFromGraph(PARALLEL_PLUS_CONDITION_GRAPH)
    const composed = applyParallelEditsToGraph(
      applyConditionEditsToGraph(PARALLEL_PLUS_CONDITION_GRAPH, conditionEdits),
      parallelEdits,
    )
    expect(composed).toEqual(PARALLEL_PLUS_CONDITION_GRAPH)
  })
})

describe('G-3 untouched round-trip — no spurious diffs from seeding (G-1 floor holds)', () => {
  it('an UNTOUCHED parallel graph round-trips byte-identical through draftFromTemplate → buildApprovalGraph', () => {
    const template = buildTemplate(PARALLEL_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(rebuilt).toEqual(original)
  })

  it('an UNTOUCHED parallel+condition graph round-trips byte-identical (both seedings are identity)', () => {
    const template = buildTemplate(PARALLEL_PLUS_CONDITION_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const rebuilt = buildApprovalGraph(draftFromTemplate(template))
    expect(rebuilt).toEqual(original)
  })

  it('applyParallelEditsToGraph with the seeded edits is identity for the parallel graph', () => {
    const edits = parallelEditsFromGraph(PARALLEL_GRAPH)
    expect(applyParallelEditsToGraph(PARALLEL_GRAPH, edits)).toEqual(PARALLEL_GRAPH)
  })
})

describe('G-3 condition / cc unaffected — still byte-identical-preserved', () => {
  it('a CONDITION-only graph round-trips byte-identical (G-3 leaves it untouched, no parallel edits)', () => {
    const template = buildTemplate(CONDITION_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    // no parallel node ⇒ no parallel edits seeded.
    expect(draft.parallelEdits).toEqual({})
    expect(buildApprovalGraph(draft)).toEqual(original)
  })

  it('a CC graph round-trips byte-identical (cc stays read-only / G-4)', () => {
    const template = buildTemplate(CC_GRAPH)
    const original = structuredClone(template.approvalGraph)
    const draft = draftFromTemplate(template)
    expect(draft.parallelEdits).toEqual({})
    const rebuilt = buildApprovalGraph(draft)
    expect(rebuilt).toEqual(original)
    const cc = rebuilt.nodes.find((node) => node.type === 'cc')
    expect(cc?.config).toEqual({ targetType: 'role', targetIds: ['hr', 'admin'] })
  })

  it('applyParallelEditsToGraph passes a condition/cc graph through byte-identical with empty edits', () => {
    expect(applyParallelEditsToGraph(CONDITION_GRAPH, {})).toEqual(CONDITION_GRAPH)
    expect(applyParallelEditsToGraph(CC_GRAPH, {})).toEqual(CC_GRAPH)
  })
})

describe('G-3 input is never mutated', () => {
  it('applyParallelEditsToGraph does not mutate the source graph', () => {
    const before = structuredClone(PARALLEL_GRAPH)
    const edits = parallelEditsFromGraph(PARALLEL_GRAPH)
    edits.fork_1.joinMode = 'any'
    applyParallelEditsToGraph(PARALLEL_GRAPH, edits)
    expect(PARALLEL_GRAPH).toEqual(before)
  })
})

describe('G-3 join-mode option set — backend accepts BOTH all and any (pre-check)', () => {
  it('the editor offers exactly [all, any]', () => {
    expect(PARALLEL_JOIN_MODES).toEqual(['all', 'any'])
  })

  it('both seeded all and seeded any pass the validation preview', () => {
    expect(validateParallelEdits(parallelEditsFromGraph(PARALLEL_GRAPH))).toEqual([])
    const anyGraph: ApprovalGraph = JSON.parse(JSON.stringify(PARALLEL_GRAPH))
    ;(anyGraph.nodes[1].config as { joinMode: string }).joinMode = 'any'
    expect(validateParallelEdits(parallelEditsFromGraph(anyGraph))).toEqual([])
  })
})

describe('G-3 validation preview (UX-only; backend normalizeApprovalGraph is final arbiter)', () => {
  it('flags an out-of-set joinMode (only reachable via a corrupt edit, never the UI select)', () => {
    const edits: ParallelEdits = {
      fork_1: { nodeKey: 'fork_1', joinMode: 'majority' as never },
    }
    const errors = validateParallelEdits(edits)
    expect(errors.some((message) => message.includes('fork_1') && message.includes('汇聚模式无效'))).toBe(true)
  })

  it('surfaces the out-of-set joinMode error through validateTemplateDraft when the draft carries parallel edits', () => {
    const draft: TemplateAuthoringDraft = draftFromTemplate(buildTemplate(PARALLEL_GRAPH))
    draft.parallelEdits!.fork_1.joinMode = 'majority' as never
    const errors = validateTemplateDraft(draft, null)
    expect(errors.some((message) => message.includes('汇聚模式无效'))).toBe(true)
  })

  it('an untouched parallel draft produces NO parallel validation errors (valid graph stays valid)', () => {
    const draft: TemplateAuthoringDraft = draftFromTemplate(buildTemplate(PARALLEL_GRAPH))
    expect(validateTemplateDraft(draft, null).filter((message) => message.includes('汇聚模式'))).toEqual([])
  })
})
