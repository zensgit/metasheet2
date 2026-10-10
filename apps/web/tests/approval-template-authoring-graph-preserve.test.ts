import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  graphReadOnlyReason,
  isComplexApprovalGraph,
  setStepApprovalType,
  stepOmitsAssigneeSources,
  unsupportedTemplateAuthoringReason,
  validateTemplateApprovalFlow,
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
    // A node-level `signaturePolicy` on a LINEAR approval node is outside the editor allowlist →
    // fail-closed (the linear-path config check still runs; a complex graph would skip it and
    // preserve). NOTE: `fieldPermissions` is NOT an example here — T1-4 added it to the linear
    // allowlist and the editor authors it. P1-C (approval-parity-master-design-lock-20260817.md
    // §P1-C) ALSO removed `timeout` (+ `approvalThreshold`) from this list of examples — both are
    // now linear-authored/preserved keys (apps/web/tests/approval-template-authoring-threshold-
    // timeout-compat.test.ts covers their no-flatten status); `signaturePolicy` remains the
    // still-unsupported example, per the master lock's explicit deferral ("Keep persisted
    // `signaturePolicy` round-trip-safe and read-only until its declared owner slice").
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
            signaturePolicy: { required: true },
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

// ── Lock-4 §1 F4-A — `approvalType` (审批类型) through BOTH editors ─────────────────────────────────
// docs/development/approval-lock4-flow-policies-20260817.md §1 F4-A, §2.3, gates X-2/X-3 (their
// approvalType analogs), OD-L4-2(a). The backend rebuild re-emits the key (allowlist 1); before this
// slice the FE forced every carrying template READ-ONLY (allowlists 2 and 3 lacked it), and widening
// only those two would have DROPPED the key on the linear save and invented a `requester` source for
// a sourceless auto_approve node. Fixtures are in the backend-NORMALIZED shape (the rebuild's key
// order; `approvalMode`/`emptyAssigneePolicy` present, since the linear builder always emits both),
// so `JSON.stringify` equality pins KEY ORDER as well — `toEqual` would not.

function f4aLinearGraph(config: Record<string, unknown>): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '审批人 1', config: config as never },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
      { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
    ],
  }
}

// The cc node forces the preserved-graph (canvas) path.
function f4aComplexGraph(config: Record<string, unknown>): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '主管', config: config as never },
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

const F4A_SOURCELESS_AUTO = { approvalMode: 'single', approvalType: 'auto_approve', emptyAssigneePolicy: 'error' }
const F4A_CONFIGS: Array<[string, Record<string, unknown>]> = [
  ['auto_approve with NO assignee carrier', F4A_SOURCELESS_AUTO],
  [
    'auto_approve that still carries a source (only an API save produces one)',
    { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', approvalType: 'auto_approve', emptyAssigneePolicy: 'error' },
  ],
  [
    "an explicit 'manual'",
    { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', approvalType: 'manual', emptyAssigneePolicy: 'error' },
  ],
  [
    'sourceless auto_approve whose person-only settings are hidden but must survive verbatim',
    {
      approvalMode: 'all',
      approvalType: 'auto_approve',
      emptyAssigneePolicy: 'auto-approve',
      autoApprovalPolicy: { mergeWithRequester: true },
      fieldPermissions: [{ fieldId: 'amount', access: 'readonly' }],
      timeout: { afterMinutes: 30, effect: 'remind' },
    },
  ],
]

describe('Lock-4 §1 F4-A — approvalType keeps a template EDITABLE in both editors (gate X-2 analog)', () => {
  for (const [label, config] of F4A_CONFIGS) {
    it(`LINEAR and CANVAS: ${label} is editable (not forced read-only)`, () => {
      expect(unsupportedTemplateAuthoringReason(buildTemplate(f4aLinearGraph(config)))).toBeNull()
      expect(unsupportedTemplateAuthoringReason(buildTemplate(f4aComplexGraph(config)))).toBeNull()
    })
  }

  it('POSITIVE CONTROL — signaturePolicy still forces read-only on both paths, so the allowlists were widened for approvalType and not removed', () => {
    const config = { ...F4A_SOURCELESS_AUTO, signaturePolicy: { required: true } }
    expect(unsupportedTemplateAuthoringReason(buildTemplate(f4aLinearGraph(config)))).not.toBeNull()
    expect(unsupportedTemplateAuthoringReason(buildTemplate(f4aComplexGraph(config)))).not.toBeNull()
  })
})

describe('Lock-4 §1 F4-A — an approvalType outside the FE union stays READ-ONLY on both paths (gate X-3 analog, OD-L4-2(a))', () => {
  it("'auto_reject' (deferred, no inert third option) and other off-union values force read-only on the linear AND the canvas path", () => {
    for (const value of ['auto_reject', 'AUTO_APPROVE', '', 42, null]) {
      const config = { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', approvalType: value, emptyAssigneePolicy: 'error' }
      expect(unsupportedTemplateAuthoringReason(buildTemplate(f4aLinearGraph(config))), JSON.stringify(value)).not.toBeNull()
      expect(unsupportedTemplateAuthoringReason(buildTemplate(f4aComplexGraph(config))), JSON.stringify(value)).not.toBeNull()
    }
  })

  it('POSITIVE CONTROL — the SAME shape with a known value is editable, so read-only is value-selected', () => {
    for (const value of ['manual', 'auto_approve']) {
      const config = { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', approvalType: value, emptyAssigneePolicy: 'error' }
      expect(unsupportedTemplateAuthoringReason(buildTemplate(f4aLinearGraph(config))), value).toBeNull()
      expect(unsupportedTemplateAuthoringReason(buildTemplate(f4aComplexGraph(config))), value).toBeNull()
    }
  })
})

describe("Lock-4 §1 F4-A — approvalType round-trips BYTE-FOR-BYTE through each editor's save build (the silent-drop pin)", () => {
  for (const [label, config] of F4A_CONFIGS) {
    it(`LINEAR (steps → buildStepConfig): ${label}`, () => {
      const graph = f4aLinearGraph(config)
      const draft = draftFromTemplate(buildTemplate(graph))
      expect(draft.preservedGraph).toBeUndefined()
      expect(draft.steps).toHaveLength(1)
      expect(JSON.stringify(buildApprovalGraph(draft))).toBe(JSON.stringify(graph))
    })

    it(`CANVAS (approvalNodeEdits → applyApprovalNodeEditsToGraph): ${label}`, () => {
      const graph = f4aComplexGraph(config)
      const draft = draftFromTemplate(buildTemplate(graph))
      expect(draft.preservedGraph).toBeDefined()
      expect(JSON.stringify(buildApprovalGraph(draft))).toBe(JSON.stringify(graph))
    })
  }

  it('a sourceless auto_approve node hydrates with the omit flag on the linear path (no phantom requester source)', () => {
    const draft = draftFromTemplate(buildTemplate(f4aLinearGraph(F4A_SOURCELESS_AUTO)))
    expect(draft.steps[0]?.approvalType).toBe('auto_approve')
    expect(stepOmitsAssigneeSources(draft.steps[0]!)).toBe(true)
  })

  it('a sourceless auto_approve node is SEEDED into the canvas edit model, so it is editable rather than cloned past', () => {
    const draft = draftFromTemplate(buildTemplate(f4aComplexGraph(F4A_SOURCELESS_AUTO)))
    expect(draft.approvalNodeEdits?.approval_1).toMatchObject({
      nodeKey: 'approval_1',
      approvalType: 'auto_approve',
      omitAssigneeSources: true,
      assigneeSources: [],
    })
  })

  it('POSITIVE CONTROL — the round-trip is not vacuous: choosing 人工审批 on the sourceless step DOES change the bytes (key removed, the requester default becomes the live source)', () => {
    const draft = draftFromTemplate(buildTemplate(f4aLinearGraph(F4A_SOURCELESS_AUTO)))
    setStepApprovalType(draft.steps[0]!, 'manual')
    const config = buildApprovalGraph(draft).nodes.find((node) => node.key === 'approval_1')!.config
    expect(JSON.stringify(config)).toBe(
      JSON.stringify({ assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' }),
    )
  })
})

describe('Lock-4 §1 F4-A — linear 审批类型 authoring (setStepApprovalType)', () => {
  const MANUAL_STATIC = { assigneeSources: [{ kind: 'static_user', userIds: ['u1', 'u2'] }], approvalMode: 'all', emptyAssigneePolicy: 'error' }
  const idsError = (errors: string[]) => errors.filter((error) => error.includes('需要填写用户/角色 id'))

  it('自动通过 omits assigneeSources (never [] and never the hidden scratch) and emits approvalType where the backend rebuild puts it', () => {
    const draft = draftFromTemplate(buildTemplate(f4aLinearGraph(MANUAL_STATIC)))
    setStepApprovalType(draft.steps[0]!, 'auto_approve')
    expect(stepOmitsAssigneeSources(draft.steps[0]!)).toBe(true)
    const config = buildApprovalGraph(draft).nodes.find((node) => node.key === 'approval_1')!.config
    expect(JSON.stringify(config)).toBe(JSON.stringify({ approvalMode: 'all', approvalType: 'auto_approve', emptyAssigneePolicy: 'error' }))
  })

  it('人工审批 after 自动通过 restores the configured source: an accidental traversal of the radiogroup is lossless (bytes equal the original)', () => {
    const graph = f4aLinearGraph(MANUAL_STATIC)
    const draft = draftFromTemplate(buildTemplate(graph))
    setStepApprovalType(draft.steps[0]!, 'auto_approve')
    setStepApprovalType(draft.steps[0]!, 'manual')
    expect(JSON.stringify(buildApprovalGraph(draft))).toBe(JSON.stringify(graph))
  })

  it('the hidden scratch source is not validated while omitted; POSITIVE CONTROL: the same source is validated again once live', () => {
    const draft = draftFromTemplate(buildTemplate(f4aLinearGraph(MANUAL_STATIC)))
    const step = draft.steps[0]!
    step.idsText = ''
    setStepApprovalType(step, 'auto_approve')
    expect(validateTemplateApprovalFlow(draft)).toEqual([])
    expect(validateTemplateApprovalFlow(draft, { minimal: true })).toEqual([])
    setStepApprovalType(step, 'manual')
    expect(idsError(validateTemplateApprovalFlow(draft))).toHaveLength(1)
  })

  it('an auto_approve step that still CARRIES a source keeps validating it (it is saved); dropping it is an explicit choice of 自动通过', () => {
    const draft = draftFromTemplate(buildTemplate(f4aLinearGraph({
      assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }],
      approvalMode: 'single',
      approvalType: 'auto_approve',
      emptyAssigneePolicy: 'error',
    })))
    const step = draft.steps[0]!
    expect(stepOmitsAssigneeSources(step)).toBe(false)
    step.idsText = ''
    expect(idsError(validateTemplateApprovalFlow(draft))).toHaveLength(1)
    setStepApprovalType(step, 'auto_approve')
    expect(stepOmitsAssigneeSources(step)).toBe(true)
    expect(idsError(validateTemplateApprovalFlow(draft))).toHaveLength(0)
    const config = buildApprovalGraph(draft).nodes.find((node) => node.key === 'approval_1')!.config as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(config, 'assigneeSources')).toBe(false)
  })
})
