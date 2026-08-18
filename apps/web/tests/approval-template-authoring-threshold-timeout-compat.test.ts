import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  unsupportedTemplateAuthoringReason,
  validateTemplateApprovalFlow,
  type TemplateAuthoringDraft,
} from '../src/approvals/templateAuthoring'
import {
  applyApprovalNodeEditsToGraph,
  approvalNodeEditsFromGraph,
  validateApprovalNodeEdits,
} from '../src/approvals/approvalNodeEdit'
import { collectParallelRegionNodeKeys } from '../src/approvals/graphTopologyEdit'

// P1-C (approval-parity-master-design-lock-20260817.md §P1-C, master M6): the shipped engine
// `threshold` (T2-4 N-of-M / 门槛会签) approval mode and `timeout` (T1-1) node config were
// FE-UNEXPOSED — both linear/complex authoring allowlists forced ANY carrying template fully
// read-only (I12/I13), which is what actually prevented the flatten (the backend re-emits both keys
// verbatim, ApprovalProductService.ts :2260-2347 / :1468-1493 — it never silently drops them). This
// slice adds both keys to BOTH allowlists so a carrying template becomes EDITABLE, without
// introducing an actual flatten. PURE-LOGIC tests (no .vue) — run under approval-web-guard.

function buildTemplate(approvalGraph: ApprovalGraph): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1', key: 'expense', name: '费用审批', description: null, category: null,
    visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
    activeVersionId: null, latestVersionId: 'ver_1',
    createdAt: '2026-08-18T00:00:00Z', updatedAt: '2026-08-18T00:00:00Z',
    formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额', required: true }] },
    approvalGraph,
  }
}

// ── LINEAR fixtures — plain start -> approval_1 -> end, no cc/condition/parallel/handler node ──────
const LINEAR_THRESHOLD_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'approval_1', type: 'approval', name: '主管',
      config: {
        assigneeSources: [{ kind: 'static_user', userIds: ['u1', 'u2', 'u3'] }],
        approvalMode: 'threshold',
        approvalThreshold: 2,
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

const LINEAR_TIMEOUT_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'approval_1', type: 'approval', name: '主管',
      config: {
        assigneeSources: [{ kind: 'direct_manager' }],
        approvalMode: 'single',
        emptyAssigneePolicy: 'error',
        timeout: { afterMinutes: 45, effect: 'remind' },
      },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
    { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
  ],
}

describe('P1-C linear no-flatten (I12/I13)', () => {
  it('a linear template carrying approvalMode:threshold + approvalThreshold is EDITABLE (no-flatten)', () => {
    expect(unsupportedTemplateAuthoringReason(buildTemplate(LINEAR_THRESHOLD_GRAPH))).toBeNull()
  })
  it('a linear template carrying a node timeout is EDITABLE (no-flatten)', () => {
    expect(unsupportedTemplateAuthoringReason(buildTemplate(LINEAR_TIMEOUT_GRAPH))).toBeNull()
  })
  it('positive control: a linear approval node with a GENUINELY unknown config key still forces read-only', () => {
    const graph: ApprovalGraph = {
      ...LINEAR_THRESHOLD_GRAPH,
      nodes: LINEAR_THRESHOLD_GRAPH.nodes.map((n) => (n.key === 'approval_1'
        ? { ...n, config: { ...n.config, futureFlag: true } as never }
        : n)),
    }
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('positive control: an out-of-union approvalMode value still forces read-only (never silently coerced to single)', () => {
    const graph: ApprovalGraph = {
      ...LINEAR_THRESHOLD_GRAPH,
      nodes: LINEAR_THRESHOLD_GRAPH.nodes.map((n) => (n.key === 'approval_1'
        ? { ...n, config: { assigneeSources: n.config.assigneeSources, approvalMode: 'bogus' as never, emptyAssigneePolicy: 'error' } }
        : n)),
    }
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('positive control: approvalThreshold present under a NON-threshold mode forces read-only (backend-drop shape)', () => {
    const graph: ApprovalGraph = {
      ...LINEAR_THRESHOLD_GRAPH,
      nodes: LINEAR_THRESHOLD_GRAPH.nodes.map((n) => (n.key === 'approval_1'
        ? { ...n, config: { ...n.config, approvalMode: 'all' as const } }
        : n)),
    }
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  // NOT a no-flatten gap: backend `normalizeNodeTimeout` is SHAPE-only (a bare `as NodeTimeoutEffect`
  // cast, no enum check — ApprovalProductService.ts :1488) — an untouched node carrying a
  // declared-but-currently-unsupported effect still round-trips byte-identical through it, so the FE
  // shape check must stay permissive here too (mirrors the advisor guidance: derive from normalize,
  // not validate). This exact combination is actually UNREACHABLE via real backend data —
  // `validateNodeTimeoutConfigs` rejects `auto_approve`/`auto_reject` at every authoring entry point
  // (`APPROVAL_NODE_TIMEOUT_EFFECT_UNSUPPORTED`) — SUPPORTED-effect enforcement is therefore a
  // SEPARATE, validation-time concern (see the "M6 dynamic-M honesty" describe block below and the
  // M7 component spec's option-list assertion), never a no-flatten/shape gate.
  it('a timeout with a declared-but-unsupported effect (auto_approve) stays EDITABLE at the shape level (not a no-flatten gate)', () => {
    const graph: ApprovalGraph = {
      ...LINEAR_TIMEOUT_GRAPH,
      nodes: LINEAR_TIMEOUT_GRAPH.nodes.map((n) => (n.key === 'approval_1'
        ? { ...n, config: { ...n.config, timeout: { afterMinutes: 45, effect: 'auto_approve' } as never } }
        : n)),
    }
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
})

describe('P1-C linear round-trip', () => {
  it('threshold N=2 round-trips hydrate -> build byte-identical', () => {
    const draft = draftFromTemplate(buildTemplate(LINEAR_THRESHOLD_GRAPH))
    expect(draft.steps[0].approvalMode).toBe('threshold')
    expect(draft.steps[0].approvalThreshold).toBe(2)
    const rebuilt = buildApprovalGraph(draft)
    const config = rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.approvalMode).toBe('threshold')
    expect(config.approvalThreshold).toBe(2)
  })
  it('switching mode AWAY from threshold drops approvalThreshold entirely (no orphaned key)', () => {
    const draft = draftFromTemplate(buildTemplate(LINEAR_THRESHOLD_GRAPH))
    draft.steps[0].approvalMode = 'all'
    const config = buildApprovalGraph(draft).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.approvalMode).toBe('all')
    expect(config).not.toHaveProperty('approvalThreshold')
  })
  it('timeout (duration + effect) round-trips hydrate -> build byte-identical', () => {
    const draft = draftFromTemplate(buildTemplate(LINEAR_TIMEOUT_GRAPH))
    expect(draft.steps[0].timeoutEnabled).toBe(true)
    expect(draft.steps[0].timeoutAfterMinutesText).toBe('45')
    expect(draft.steps[0].timeoutEffect).toBe('remind')
    const config = buildApprovalGraph(draft).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.timeout).toEqual({ afterMinutes: 45, effect: 'remind' })
  })
  it('a transfer-effect timeout round-trips its target user id', () => {
    const graph: ApprovalGraph = {
      ...LINEAR_TIMEOUT_GRAPH,
      nodes: LINEAR_TIMEOUT_GRAPH.nodes.map((n) => (n.key === 'approval_1'
        ? { ...n, config: { ...n.config, timeout: { afterMinutes: 30, effect: 'transfer', transferToUserId: 'backup_u1' } } }
        : n)),
    }
    const draft = draftFromTemplate(buildTemplate(graph))
    expect(draft.steps[0].timeoutTransferToUserId).toBe('backup_u1')
    const config = buildApprovalGraph(draft).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.timeout).toEqual({ afterMinutes: 30, effect: 'transfer', transferToUserId: 'backup_u1' })
  })
  it('a jump-effect timeout resolves through the stable localId, surviving a step reorder', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'approval_1', type: 'approval', name: '一审', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error', timeout: { afterMinutes: 20, effect: 'jump', jumpToNodeKey: 'approval_2' } } },
        { key: 'approval_2', type: 'approval', name: '二审', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'approval_2' },
        { key: 'e3', source: 'approval_2', target: 'end' },
      ],
    }
    const draft = draftFromTemplate(buildTemplate(graph))
    expect(draft.steps[0].timeoutJumpToStepLocalId).toBe(draft.steps[1].localId)
    // Reorder: move 二审 before 一审 — node keys are REASSIGNED positionally at build time.
    draft.steps.reverse()
    const rebuilt = buildApprovalGraph(draft)
    const jumpingNode = rebuilt.nodes.find((n) => n.name === '一审')!
    const targetNode = rebuilt.nodes.find((n) => n.name === '二审')!
    expect((jumpingNode.config as Record<string, unknown>).timeout).toMatchObject({ jumpToNodeKey: targetNode.key })
  })
})

describe('P1-C linear validation preview (M6 dynamic-M honesty)', () => {
  it('rejects a non-integer / zero threshold', () => {
    const draft = draftFromTemplate(buildTemplate(LINEAR_THRESHOLD_GRAPH))
    draft.steps[0].approvalThreshold = 0
    expect(validateTemplateApprovalFlow(draft).some((e) => e.includes('门槛会签人数'))).toBe(true)
  })
  it('does NOT invent a static N<=M publish bound for a static_user source (backend never enforces it for assigneeSources)', () => {
    const draft = draftFromTemplate(buildTemplate(LINEAR_THRESHOLD_GRAPH))
    // 5 required, only 3 static users configured — the backend's static bound is scoped to the
    // LEGACY assigneeType/assigneeIds shape only (ApprovalProductService.ts :2292), which this
    // editor never emits (`buildStepConfig` always writes `assigneeSources`), so this must NOT be
    // a blocking error (M8: do not claim a validation the engine doesn't perform).
    draft.steps[0].approvalThreshold = 5
    expect(validateTemplateApprovalFlow(draft)).toEqual([])
  })
  it('requires an effect + valid duration when timeout is enabled', () => {
    const draft = draftFromTemplate(buildTemplate(LINEAR_TIMEOUT_GRAPH))
    draft.steps[0].timeoutEffect = ''
    draft.steps[0].timeoutAfterMinutesText = '0'
    const errors = validateTemplateApprovalFlow(draft)
    expect(errors.some((e) => e.includes('超时后的处理方式'))).toBe(true)
    expect(errors.some((e) => e.includes('超时时长'))).toBe(true)
  })
  it('requires a transfer target / jump target for their respective effects', () => {
    const draft = draftFromTemplate(buildTemplate(LINEAR_TIMEOUT_GRAPH))
    draft.steps[0].timeoutEffect = 'transfer'
    draft.steps[0].timeoutTransferToUserId = ''
    expect(validateTemplateApprovalFlow(draft).some((e) => e.includes('超时转交'))).toBe(true)
    draft.steps[0].timeoutEffect = 'jump'
    draft.steps[0].timeoutJumpToStepLocalId = ''
    expect(validateTemplateApprovalFlow(draft).some((e) => e.includes('超时跳转'))).toBe(true)
  })
})

// ── COMPLEX fixtures — a cc node forces the preserved-graph path ────────────────────────────────
function complexWith(approvalConfig: Record<string, unknown>): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '主管', config: approvalConfig as never },
      { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['finance'] } },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'cc_1' },
      { key: 'e3', source: 'cc_1', target: 'end' },
    ],
  }
}

describe('P1-C complex no-flatten (I12/I13) — M8 stale-comment correction', () => {
  it('a complex template carrying approvalMode:threshold + approvalThreshold is EDITABLE (backend DOES preserve both keys)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'threshold', approvalThreshold: 2, emptyAssigneePolicy: 'error' })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
  it('a complex template carrying a node timeout is EDITABLE', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error', timeout: { afterMinutes: 90, effect: 'jump', jumpToNodeKey: 'approval_1' } })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
  it('positive control: signaturePolicy stays UNSUPPORTED — still read-only (not part of this slice, owner deferral preserved)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], signaturePolicy: { required: true } })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('positive control: approvalThreshold present under a NON-threshold mode forces read-only', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'any', approvalThreshold: 2 })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  // Same rationale as the linear-path counterpart above: shape-preservable (normalizeNodeTimeout is
  // permissive on effect value), currently-unreachable via real data, and SUPPORTED-effect
  // enforcement belongs to validation, not the no-flatten shape gate.
  it('a timeout with a declared-but-unsupported effect (auto_reject) stays EDITABLE at the shape level', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], timeout: { afterMinutes: 10, effect: 'auto_reject' } })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).toBeNull()
  })
  it('positive control: a timeout carrying unit:"wall_clock" explicitly forces read-only (normalize never emits it — a stored graph would never carry it either)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], timeout: { afterMinutes: 10, effect: 'remind', unit: 'wall_clock' } })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('positive control: a timeout with an extra unknown key forces read-only', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], timeout: { afterMinutes: 10, effect: 'remind', futureFlag: true } })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
  it('positive control: a timeout with a non-numeric afterMinutes forces read-only', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], timeout: { afterMinutes: '10', effect: 'remind' } })
    expect(unsupportedTemplateAuthoringReason(buildTemplate(graph))).not.toBeNull()
  })
})

describe('P1-C complex round-trip (approvalNodeEdit.ts editable, not just preserved)', () => {
  it('threshold N=2 seeds into the editable model and round-trips through an untouched edit', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'threshold', approvalThreshold: 2, emptyAssigneePolicy: 'error' })
    const edits = approvalNodeEditsFromGraph(graph)
    expect(edits.approval_1.approvalMode).toBe('threshold')
    expect(edits.approval_1.approvalThreshold).toBe(2)
    const rebuilt = applyApprovalNodeEditsToGraph(graph, edits)
    const config = rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.approvalMode).toBe('threshold')
    expect(config.approvalThreshold).toBe(2)
  })
  it('EDITING N (not just preserving it) lands in the rebuilt graph', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'threshold', approvalThreshold: 2, emptyAssigneePolicy: 'error' })
    const edits = approvalNodeEditsFromGraph(graph)
    edits.approval_1.approvalThreshold = 3
    const config = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.approvalThreshold).toBe(3)
  })
  it('switching mode away from threshold drops approvalThreshold from the rebuilt graph (no orphaned key)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'static_role', roleIds: ['mgr'] }], approvalMode: 'threshold', approvalThreshold: 2, emptyAssigneePolicy: 'error' })
    const edits = approvalNodeEditsFromGraph(graph)
    edits.approval_1.approvalMode = 'all'
    const config = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.approvalMode).toBe('all')
    expect(config).not.toHaveProperty('approvalThreshold')
  })
  it('timeout seeds into the editable model, is EDITABLE (not just preserved), and round-trips', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error', timeout: { afterMinutes: 60, effect: 'remind' } })
    const edits = approvalNodeEditsFromGraph(graph)
    expect(edits.approval_1.timeout).toEqual({ afterMinutes: 60, effect: 'remind' })
    edits.approval_1.timeout = { afterMinutes: 15, effect: 'remind' }
    const config = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.timeout).toEqual({ afterMinutes: 15, effect: 'remind' })
  })
  it('clearing timeout (edit.timeout = null) removes it from the rebuilt graph', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error', timeout: { afterMinutes: 60, effect: 'remind' } })
    const edits = approvalNodeEditsFromGraph(graph)
    edits.approval_1.timeout = null
    const config = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config).not.toHaveProperty('timeout')
  })
  it('an UNTOUCHED edit round-trips the whole graph byte-identical (no spurious diff)', () => {
    const graph = complexWith({ assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'threshold', approvalThreshold: 4, emptyAssigneePolicy: 'error', timeout: { afterMinutes: 60, effect: 'remind' } })
    const edits = approvalNodeEditsFromGraph(graph)
    expect(applyApprovalNodeEditsToGraph(graph, edits)).toEqual(graph)
  })
})

// ── Linear-only fail-closed + positive control — a REAL parallel region ─────────────────────────
// start -> parallel_1 -[branch e_b1]-> inner_approval -> join (approval, OUTSIDE the region — the
// join node itself is excluded by `collectParallelRegionNodeKeys`) -[branch e_b2]-> join -> end.
const PARALLEL_GRAPH: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'parallel_1', type: 'parallel', name: '并行', config: { branches: ['e_b1', 'e_b2'], joinMode: 'all', joinNodeKey: 'join' } },
    { key: 'inner_approval', type: 'approval', name: '并行内审批', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'join', type: 'approval', name: '汇聚后审批', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'parallel_1' },
    { key: 'e_b1', source: 'parallel_1', target: 'inner_approval' },
    { key: 'e_b2', source: 'parallel_1', target: 'join' },
    { key: 'e_inner_join', source: 'inner_approval', target: 'join' },
    { key: 'e_end', source: 'join', target: 'end' },
  ],
}

describe('P1-C FE parallel-region mirror agrees with the reused backend port', () => {
  it('collectParallelRegionNodeKeys marks inner_approval IN, and start/parallel_1/join/end OUT', () => {
    const region = collectParallelRegionNodeKeys(PARALLEL_GRAPH)
    expect(region.has('inner_approval')).toBe(true)
    expect(region.has('join')).toBe(false)
    expect(region.has('parallel_1')).toBe(false)
    expect(region.has('start')).toBe(false)
  })
})

describe('P1-C linear-only fail-closed (complex path) + positive control', () => {
  it('rejects approvalMode:threshold on a node INSIDE a parallel region', () => {
    const region = collectParallelRegionNodeKeys(PARALLEL_GRAPH)
    const errors = validateApprovalNodeEdits({
      inner_approval: { nodeKey: 'inner_approval', assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'threshold', approvalThreshold: 1 },
    }, undefined, region)
    expect(errors.some((e) => e.includes('并行分支内') && e.includes('门槛会签'))).toBe(true)
  })
  it('POSITIVE CONTROL: the SAME approvalMode:threshold on a node OUTSIDE the parallel region (the join node) is accepted', () => {
    const region = collectParallelRegionNodeKeys(PARALLEL_GRAPH)
    const errors = validateApprovalNodeEdits({
      join: { nodeKey: 'join', assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'threshold', approvalThreshold: 1 },
    }, undefined, region)
    expect(errors).toEqual([])
  })
  it('rejects a timeout on a node INSIDE a parallel region', () => {
    const region = collectParallelRegionNodeKeys(PARALLEL_GRAPH)
    const errors = validateApprovalNodeEdits({
      inner_approval: { nodeKey: 'inner_approval', assigneeSources: [{ kind: 'direct_manager' }], timeout: { afterMinutes: 30, effect: 'remind' } },
    }, undefined, region)
    expect(errors.some((e) => e.includes('并行分支内') && e.includes('节点超时'))).toBe(true)
  })
  it('POSITIVE CONTROL: the SAME timeout on a node OUTSIDE the parallel region (the join node) is accepted', () => {
    const region = collectParallelRegionNodeKeys(PARALLEL_GRAPH)
    const errors = validateApprovalNodeEdits({
      join: { nodeKey: 'join', assigneeSources: [{ kind: 'dept_head' }], timeout: { afterMinutes: 30, effect: 'remind' } },
    }, undefined, region)
    expect(errors).toEqual([])
  })
  it('omitting parallelRegionNodeKeys treats every node as outside a parallel region (existing callers unaffected)', () => {
    const errors = validateApprovalNodeEdits({
      inner_approval: { nodeKey: 'inner_approval', assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'threshold', approvalThreshold: 1 },
    })
    expect(errors).toEqual([])
  })
  it('validateTemplateApprovalFlow wires the SAME region check end-to-end from draft.preservedGraph', () => {
    const draft: TemplateAuthoringDraft = {
      ...draftFromTemplate(buildTemplate(PARALLEL_GRAPH)),
    }
    draft.approvalNodeEdits!.inner_approval.approvalMode = 'threshold'
    draft.approvalNodeEdits!.inner_approval.approvalThreshold = 1
    expect(validateTemplateApprovalFlow(draft).some((e) => e.includes('并行分支内'))).toBe(true)
  })
})
