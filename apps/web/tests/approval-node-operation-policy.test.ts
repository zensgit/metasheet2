import { describe, expect, it } from 'vitest'
import type {
  ApprovalGraph,
  ApprovalTemplateDetailDTO,
  AutoApprovalPolicy,
  EmptyAssigneeFallback,
  NodeOperationPolicy,
} from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  setStepEmptyAssigneeFallbackIds,
  unsupportedTemplateAuthoringReason,
  validateTemplateApprovalFlow,
} from '../src/approvals/templateAuthoring'
import {
  SAME_PERSON_EXPLICIT_CHOICE_LABELS,
  SAME_PERSON_UNKNOWN_LABEL,
  SAME_PERSON_UNKNOWN_SELECT_VALUE,
  applyApprovalNodeEditsToGraph,
  applySamePersonChoice,
  approvalNodeEditsFromGraph,
  emptyAssigneeFallbackHasTarget,
  samePersonChoiceFromSelectValue,
  samePersonChoiceOptions,
  samePersonControlState,
  samePersonSelectValue,
  validateApprovalNodeEdits,
  withEmptyAssigneeFallbackIds,
} from '../src/approvals/approvalNodeEdit'
import {
  OPERATION_POLICY_MIXED_HINT,
  OPERATION_POLICY_SCOPE_HINT,
  applyOperationPolicyControl,
  operationPolicyControlState,
} from '../src/approvals/nodeOperationPolicyEdit'
import {
  DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
  hasRatifiedOperationPolicy,
} from '../src/approvals/approvalCapabilityRegistry'

/**
 * Lock-5 — per-node operation & member-action policy, FE half.
 * Source: docs/development/approval-lock5-node-operation-policy-20260817.md §1.1, §2.2, §2.3,
 * OD-L5-1(a)/OD-L5-2(a)/OD-L5-3(a), gates A-3, A-6, A-7, E-1, E-2.
 *
 * Pure helper + allowlist specs only (no `.vue`, no Element Plus) so this file runs under
 * approval-web-guard AND run-required-web-tests.sh. The MOUNTED tab assertions (E-1/E-2, the
 * handler F-1 half) live with the components they mount:
 * `approval-template-authoring-canvas-inspector.spec.ts` and `approval-handler-node-config.spec.ts`.
 */

const TRANSFER = { policyKeys: ['allowTransfer'] } as const
const ADD_REDUCE = { policyKeys: ['allowAddSign', 'allowReduceSign'] } as const
const RETURN = { policyKeys: ['allowReturn'] } as const

// ── OD-L5-3(a): absent ≡ allowed ─────────────────────────────────────────────────────────────
describe('Lock-5 OD-L5-3(a) — absent ≡ ALLOWED, and only an explicit false denies', () => {
  it('an absent policy object reads as allowed for every control', () => {
    expect(operationPolicyControlState(undefined, TRANSFER)).toEqual({ kind: 'editable', allowed: true })
    expect(operationPolicyControlState(undefined, ADD_REDUCE)).toEqual({ kind: 'editable', allowed: true })
    expect(operationPolicyControlState(undefined, RETURN)).toEqual({ kind: 'editable', allowed: true })
  })

  it('an explicit true reads as allowed, an explicit false as denied', () => {
    expect(operationPolicyControlState({ allowTransfer: true }, TRANSFER)).toEqual({ kind: 'editable', allowed: true })
    expect(operationPolicyControlState({ allowTransfer: false }, TRANSFER)).toEqual({ kind: 'editable', allowed: false })
  })

  it('POSITIVE CONTROL — a policy that denies a DIFFERENT verb leaves this control allowed', () => {
    // Without this, "absent ≡ allowed" could be green against a predicate that ignores the key
    // entirely and always answers `true`.
    expect(operationPolicyControlState({ allowReturn: false }, TRANSFER)).toEqual({ kind: 'editable', allowed: true })
    expect(operationPolicyControlState({ allowReturn: false }, RETURN)).toEqual({ kind: 'editable', allowed: false })
  })
})

// ── A-6 (emptiness half) + A-7 ───────────────────────────────────────────────────────────────
describe('Lock-5 gate A-6 — authoring all-default switches persists NO key at all', () => {
  it('turning every switch back to allowed yields `undefined`, so the caller omits the key', () => {
    let policy = applyOperationPolicyControl(undefined, TRANSFER, false)
    expect(policy).toEqual({ allowTransfer: false })
    policy = applyOperationPolicyControl(policy, TRANSFER, true)
    expect(policy).toBeUndefined()
  })

  it('checking a box DELETES the key rather than writing `true` (byte-stability)', () => {
    expect(applyOperationPolicyControl({ allowTransfer: true }, TRANSFER, true)).toBeUndefined()
  })

  it('POSITIVE CONTROL — setting ONE switch to false DOES change the bytes', () => {
    const before = undefined
    const after = applyOperationPolicyControl(before, RETURN, false)
    expect(after).not.toBeUndefined()
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before ?? null))
    expect(after).toEqual({ allowReturn: false })
  })
})

describe('Lock-5 OD-L5-2(a) / gate A-7 — ONE 允许加/减签 checkbox writes BOTH keys', () => {
  it('unchecking the combined control denies add-sign AND reduce-sign', () => {
    expect(applyOperationPolicyControl(undefined, ADD_REDUCE, false)).toEqual({
      allowAddSign: false,
      allowReduceSign: false,
    })
  })

  it('a persisted MIXED pair renders read-only (unrepresentable by one checkbox)', () => {
    expect(operationPolicyControlState({ allowAddSign: true, allowReduceSign: false }, ADD_REDUCE)).toEqual({ kind: 'mixed' })
    expect(operationPolicyControlState({ allowReduceSign: false }, ADD_REDUCE)).toEqual({ kind: 'mixed' })
  })

  it('POSITIVE CONTROL — a MATCHED pair renders editable, so read-only is state-selected', () => {
    expect(operationPolicyControlState({ allowAddSign: false, allowReduceSign: false }, ADD_REDUCE)).toEqual({ kind: 'editable', allowed: false })
    expect(operationPolicyControlState({ allowAddSign: true, allowReduceSign: true }, ADD_REDUCE)).toEqual({ kind: 'editable', allowed: true })
  })

  it('a mixed pair ROUND-TRIPS unchanged through seed → rebuild (nothing collapses it)', () => {
    const mixed: NodeOperationPolicy = { allowAddSign: true, allowReduceSign: false }
    const graph = complexGraphWithPolicy(mixed)
    const rebuilt = applyApprovalNodeEditsToGraph(graph, approvalNodeEditsFromGraph(graph))
    expect(rebuilt.nodes.find((n) => n.key === 'approval_1')!.config).toEqual({
      assigneeSources: [{ kind: 'requester' }],
      nodeOperationPolicy: mixed,
    })
  })

  it('flipping ONE control never clears a sibling nodeOperationPolicy field', () => {
    const seeded: NodeOperationPolicy = {
      allowTransfer: false,
      returnReviewMode: 'resume_forward',
      commentRequired: 'always',
    }
    const next = applyOperationPolicyControl(seeded, ADD_REDUCE, false)
    expect(next).toEqual({
      allowTransfer: false,
      allowAddSign: false,
      allowReduceSign: false,
      returnReviewMode: 'resume_forward',
      commentRequired: 'always',
    })
    // …and re-allowing it leaves the siblings alone too.
    expect(applyOperationPolicyControl(next, ADD_REDUCE, true)).toEqual(seeded)
  })

  it('the mixed-state copy is honest about what the editor will do (M8)', () => {
    expect(OPERATION_POLICY_MIXED_HINT).toContain('只读')
    expect(OPERATION_POLICY_MIXED_HINT).toContain('保存不会改动它')
  })

  it('A-4 authoring copy states that a flip reaches only instances created after the next publish', () => {
    expect(OPERATION_POLICY_SCOPE_HINT).toContain('发布')
    expect(OPERATION_POLICY_SCOPE_HINT).toContain('已在流转中的审批仍沿用其发起时的设置')
  })
})

// ── §2.2 / A-3 — the key stays EDITABLE in BOTH editors ──────────────────────────────────────
function tpl(approvalGraph: ApprovalGraph): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1', key: 'k', name: 'n', description: null, category: null,
    visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
    activeVersionId: null, latestVersionId: 'v1',
    createdAt: '2026-08-18T00:00:00Z', updatedAt: '2026-08-18T00:00:00Z',
    formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额', required: true }] },
    approvalGraph,
  }
}

/** LINEAR: start → approval_1 → end. Editable through the `steps` projection. */
function linearGraph(config: Record<string, unknown>): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '审批人 1', config: config as never },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'end' },
    ],
  }
}

/** COMPLEX: the same spine plus a `cc` node, which is what makes the graph preserved-verbatim. */
function complexGraph(config: Record<string, unknown>): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      { key: 'approval_1', type: 'approval', name: '审批人 1', config: config as never },
      { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['r1'] } as never },
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'approval_1' },
      { key: 'e2', source: 'approval_1', target: 'cc_1' },
      { key: 'e3', source: 'cc_1', target: 'end' },
    ],
  }
}

function complexGraphWithPolicy(policy: NodeOperationPolicy): ApprovalGraph {
  return complexGraph({ assigneeSources: [{ kind: 'requester' }], nodeOperationPolicy: policy })
}

describe('Lock-5 §2.2 / gate A-3 — nodeOperationPolicy stays EDITABLE in BOTH editors', () => {
  const policy: NodeOperationPolicy = { allowTransfer: false }

  it('COMPLEX editor: a template carrying the key is editable (not forced read-only)', () => {
    expect(unsupportedTemplateAuthoringReason(tpl(complexGraphWithPolicy(policy)))).toBeNull()
  })

  it('LINEAR editor: a template carrying the key is editable (not forced read-only)', () => {
    expect(unsupportedTemplateAuthoringReason(tpl(linearGraph({
      assigneeSources: [{ kind: 'requester' }],
      nodeOperationPolicy: policy,
    })))).toBeNull()
  })

  it('POSITIVE CONTROL — `signaturePolicy` STILL forces read-only in both, so the allowlists were widened for THIS key and not removed', () => {
    // Lock-5 A-3's mandated control, and OD-L5-10(a): signaturePolicy stays declared-inert and is
    // deliberately in NEITHER FE allowlist. If someone "helpfully" adds it while editing these
    // lists, this test goes red.
    const sig = { assigneeSources: [{ kind: 'requester' }], signaturePolicy: { required: true } }
    expect(unsupportedTemplateAuthoringReason(tpl(complexGraph(sig)))).not.toBeNull()
    expect(unsupportedTemplateAuthoringReason(tpl(linearGraph(sig)))).not.toBeNull()
  })

  it('a shape the BACKEND normalizer would reject still fails closed to read-only in both editors', () => {
    for (const bad of [
      { futureSwitch: true },                       // unknown sub-key → backend 400
      { allowTransfer: 'no' },                      // non-boolean → backend 400
      { returnReviewMode: 'jump_sideways' },        // out-of-enum → backend 400
      { commentRequired: 'sometimes' },             // out-of-enum → backend 400
      {},                                           // backend OMITS an all-absent object
      'nope',                                       // not an object at all
    ]) {
      const cfg = { assigneeSources: [{ kind: 'requester' }], nodeOperationPolicy: bad }
      expect(unsupportedTemplateAuthoringReason(tpl(complexGraph(cfg))), JSON.stringify(bad)).not.toBeNull()
      expect(unsupportedTemplateAuthoringReason(tpl(linearGraph(cfg))), JSON.stringify(bad)).not.toBeNull()
    }
  })

  it('§1.6 — a HANDLER carrying allowAddSign/allowReduceSign/allowReturn is read-only (the backend 400s it)', () => {
    const handlerGraph = (policyValue: unknown): ApprovalGraph => ({
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        { key: 'handler_1', type: 'handler', name: '办理', config: { assigneeSources: [{ kind: 'requester' }], nodeOperationPolicy: policyValue } as never },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'handler_1' },
        { key: 'e2', source: 'handler_1', target: 'end' },
      ],
    })
    expect(unsupportedTemplateAuthoringReason(tpl(handlerGraph({ allowAddSign: false })))).not.toBeNull()
    expect(unsupportedTemplateAuthoringReason(tpl(handlerGraph({ allowReduceSign: false })))).not.toBeNull()
    expect(unsupportedTemplateAuthoringReason(tpl(handlerGraph({ allowReturn: false })))).not.toBeNull()
    // POSITIVE CONTROL — the two ADMITTED keys keep the handler editable (OD-L5-11(a)).
    expect(unsupportedTemplateAuthoringReason(tpl(handlerGraph({ allowTransfer: false })))).toBeNull()
    expect(unsupportedTemplateAuthoringReason(tpl(handlerGraph({ commentRequired: 'always' })))).toBeNull()
  })
})

describe('Lock-5 §2.2 — the LINEAR path re-emits the key verbatim (editable is not enough on its own)', () => {
  it('hydrate → buildApprovalGraph round-trips a linear nodeOperationPolicy unchanged', () => {
    const policy: NodeOperationPolicy = { allowAddSign: false, allowReduceSign: false, commentRequired: 'always' }
    const draft = draftFromTemplate(tpl(linearGraph({
      assigneeSources: [{ kind: 'requester' }],
      nodeOperationPolicy: policy,
    })))
    expect(draft.steps[0]?.nodeOperationPolicy).toEqual(policy)
    const rebuilt = buildApprovalGraph(draft)
    expect((rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>).nodeOperationPolicy)
      .toEqual(policy)
  })

  it('POSITIVE CONTROL — a linear step with NO policy emits NO key (byte-stability for every existing template)', () => {
    const draft = draftFromTemplate(tpl(linearGraph({ assigneeSources: [{ kind: 'requester' }] })))
    expect(draft.steps[0]?.nodeOperationPolicy).toBeUndefined()
    const config = buildApprovalGraph(draft).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(config, 'nodeOperationPolicy')).toBe(false)
  })

  it('the re-emitted object is a COPY, never an alias of the reactive draft', () => {
    const draft = draftFromTemplate(tpl(linearGraph({
      assigneeSources: [{ kind: 'requester' }],
      nodeOperationPolicy: { allowReturn: false },
    })))
    const rebuilt = buildApprovalGraph(draft)
    const emitted = (rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>)
      .nodeOperationPolicy as NodeOperationPolicy
    expect(emitted).not.toBe(draft.steps[0]!.nodeOperationPolicy)
    emitted.allowReturn = true
    expect(draft.steps[0]!.nodeOperationPolicy).toEqual({ allowReturn: false })
  })
})

describe('Lock-5 §2.2 — the CANVAS path seeds and rebuilds the key identically', () => {
  it('an untouched seed reproduces the persisted object byte-for-byte (no spurious diff)', () => {
    const graph = complexGraphWithPolicy({ allowTransfer: false, allowReturn: false })
    const rebuilt = applyApprovalNodeEditsToGraph(graph, approvalNodeEditsFromGraph(graph))
    expect(rebuilt.nodes.find((n) => n.key === 'approval_1')!.config).toEqual(
      graph.nodes.find((n) => n.key === 'approval_1')!.config,
    )
  })

  it('`null` on the edit REMOVES the key; an untouched (absent) edit preserves it', () => {
    const graph = complexGraphWithPolicy({ allowTransfer: false })
    const edits = approvalNodeEditsFromGraph(graph)

    const preserved = applyApprovalNodeEditsToGraph(graph, edits)
    expect((preserved.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>).nodeOperationPolicy)
      .toEqual({ allowTransfer: false })

    edits.approval_1!.nodeOperationPolicy = null
    const cleared = applyApprovalNodeEditsToGraph(graph, edits)
    const config = cleared.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(config, 'nodeOperationPolicy')).toBe(false)
  })

  it('a node the author never opened keeps every OTHER config field byte-identical', () => {
    const graph = complexGraph({
      assigneeSources: [{ kind: 'requester' }],
      approvalMode: 'all',
      emptyAssigneePolicy: 'error',
      fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
      nodeOperationPolicy: { allowReturn: false },
    })
    const edits = approvalNodeEditsFromGraph(graph)
    edits.approval_1!.nodeOperationPolicy = { allowReturn: false, allowTransfer: false }
    const rebuilt = applyApprovalNodeEditsToGraph(graph, edits)
    expect(rebuilt.nodes.find((n) => n.key === 'approval_1')!.config).toEqual({
      assigneeSources: [{ kind: 'requester' }],
      approvalMode: 'all',
      emptyAssigneePolicy: 'error',
      fieldPermissions: [{ fieldId: 'amount', access: 'hidden' }],
      nodeOperationPolicy: { allowReturn: false, allowTransfer: false },
    })
    // Every other node/edge untouched.
    expect(rebuilt.nodes.find((n) => n.key === 'cc_1')!.config).toEqual({ targetType: 'role', targetIds: ['r1'] })
    expect(rebuilt.edges).toEqual(graph.edges)
  })
})

// ── E-1's registry mechanism (unmounted half) ────────────────────────────────────────────────
describe('Lock-5 gate E-1 — the tab is registry-driven, per node type', () => {
  it('the shipped registry declares operation policies for approval and handler ONLY', () => {
    expect(hasRatifiedOperationPolicy(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'approval')).toBe(true)
    expect(hasRatifiedOperationPolicy(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'handler')).toBe(true)
    for (const nodeType of ['start', 'end', 'cc', 'condition', 'parallel'] as const) {
      expect(hasRatifiedOperationPolicy(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, nodeType)).toBe(false)
    }
  })

  it('every declared capability names ≥1 key whose enforcement has LANDED (E-2, mechanically)', () => {
    const enforced = new Set(['allowTransfer', 'allowAddSign', 'allowReduceSign', 'allowReturn'])
    const entries = Object.values(DEFAULT_APPROVAL_CAPABILITY_REGISTRY.operationPoliciesByNodeType).flat()
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry!.policyKeys.length).toBeGreaterThan(0)
      for (const key of entry!.policyKeys) expect(enforced.has(key)).toBe(true)
    }
  })

  it('§1.6 — the handler roster is EXACTLY the transfer control (OD-L5-11(a))', () => {
    expect(DEFAULT_APPROVAL_CAPABILITY_REGISTRY.operationPoliciesByNodeType.handler!.map((c) => c.id))
      .toEqual(['transfer'])
    expect(DEFAULT_APPROVAL_CAPABILITY_REGISTRY.operationPoliciesByNodeType.approval!.map((c) => c.id))
      .toEqual(['transfer', 'add_reduce_sign', 'return'])
  })
})

// ── Fix-round P1-1 (gate P3A-F4B-20260819, docs/development/approval-lock4-flow-policies-20260817.md
// §3 F4-B / §2.3) — `emptyAssigneeFallback` joins the FOUR allowlists in this one slice, mirroring
// Lock-5's own §2.2/gate A-3 structure above (fixture helpers `tpl`/`linearGraph`/`complexGraph`
// reused unchanged). Before this fix-round a template carrying the key was bricked READ-ONLY in
// BOTH editors (X-2 empirically FAILED); §2.1/P3-2 additionally required the linear enum-flatten
// repair and the canvas validator widening to move in the SAME slice, or the naive allowlist-only
// fix would silently downgrade a persisted `'designated'` to `'error'` on save.
function complexGraphWithF4B(fallback: EmptyAssigneeFallback): ApprovalGraph {
  return complexGraph({
    assigneeSources: [{ kind: 'static_user', userIds: ['admin-1'] }],
    emptyAssigneePolicy: 'designated',
    emptyAssigneeFallback: fallback,
  })
}

describe('Lock-4 §3 F4-B / gate X-2 — emptyAssigneeFallback stays EDITABLE in BOTH editors', () => {
  const fallback: EmptyAssigneeFallback = { userIds: ['admin-1'], roleIds: ['approval-admin'] }

  it('COMPLEX editor: a template carrying designated + emptyAssigneeFallback is editable (not forced read-only)', () => {
    expect(unsupportedTemplateAuthoringReason(tpl(complexGraphWithF4B(fallback)))).toBeNull()
  })

  it('LINEAR editor: a template carrying designated + emptyAssigneeFallback is editable (not forced read-only)', () => {
    expect(unsupportedTemplateAuthoringReason(tpl(linearGraph({
      assigneeSources: [{ kind: 'static_user', userIds: ['admin-1'] }],
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: fallback,
    })))).toBeNull()
  })

  it('POSITIVE CONTROL — `signaturePolicy` STILL forces read-only in both, so the allowlists were widened for THIS key and not removed (reused verbatim from gate A-3)', () => {
    const sig = { assigneeSources: [{ kind: 'requester' }], signaturePolicy: { required: true } }
    expect(unsupportedTemplateAuthoringReason(tpl(complexGraph(sig)))).not.toBeNull()
    expect(unsupportedTemplateAuthoringReason(tpl(linearGraph(sig)))).not.toBeNull()
  })

  it('a shape the BACKEND normalizer would reject still fails closed to read-only in both editors', () => {
    for (const bad of [
      { extra: true },                 // unknown sub-key → backend 400
      { userIds: 'admin-1' },          // not an array → backend 400
      { roleIds: 42 },                 // not an array → backend 400
      [],                              // not an object at all
      'nope',                          // not an object at all
    ]) {
      const cfg = {
        assigneeSources: [{ kind: 'static_user', userIds: ['admin-1'] }],
        emptyAssigneePolicy: 'designated',
        emptyAssigneeFallback: bad,
      }
      expect(unsupportedTemplateAuthoringReason(tpl(complexGraph(cfg))), JSON.stringify(bad)).not.toBeNull()
      expect(unsupportedTemplateAuthoringReason(tpl(linearGraph(cfg))), JSON.stringify(bad)).not.toBeNull()
    }
  })

  it('a genuinely UNKNOWN emptyAssigneePolicy value still fails closed to read-only on the LINEAR path (the out-of-union door stays shut)', () => {
    const cfg = { assigneeSources: [{ kind: 'requester' }], emptyAssigneePolicy: 'not-a-real-policy' }
    expect(unsupportedTemplateAuthoringReason(tpl(complexGraph(cfg)))).toBeNull()
    // ^ COMPLEX path preserves scalars verbatim without an enum check (matches `approvalMode`'s own
    // posture on this path — the complex path never flattens a scalar, so an off-enum value simply
    // round-trips unchanged; the backend rejects it explicitly at save, never a silent drop). The
    // LINEAR path is the one with an explicit out-of-union door, asserted below.
    expect(unsupportedTemplateAuthoringReason(tpl(linearGraph(cfg)))).not.toBeNull()
  })
})

describe('Lock-4 §3 F4-B / gate P3-2 — the LINEAR path re-emits designated + fallback verbatim (no silent flatten)', () => {
  it("hydrate → buildApprovalGraph round-trips 'designated' + emptyAssigneeFallback unchanged (the master M4 no-flatten check)", () => {
    const fallback: EmptyAssigneeFallback = { userIds: ['admin-1', 'admin-2'], roleIds: ['approval-admin'] }
    const draft = draftFromTemplate(tpl(linearGraph({
      assigneeSources: [{ kind: 'static_user', userIds: ['admin-1'] }],
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: fallback,
    })))
    expect(draft.steps[0]?.emptyAssigneePolicy).toBe('designated')
    expect(draft.steps[0]?.emptyAssigneeFallback).toEqual(fallback)
    const rebuilt = buildApprovalGraph(draft)
    const config = rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.emptyAssigneePolicy).toBe('designated')
    expect(config.emptyAssigneeFallback).toEqual(fallback)
  })

  it('POSITIVE CONTROL — a linear step with NO fallback emits NO key (byte-stability for every existing template)', () => {
    const draft = draftFromTemplate(tpl(linearGraph({ assigneeSources: [{ kind: 'requester' }] })))
    expect(draft.steps[0]?.emptyAssigneeFallback).toBeUndefined()
    const config = buildApprovalGraph(draft).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(config, 'emptyAssigneeFallback')).toBe(false)
    // Regression pin for the (pre-existing) sibling key: `emptyAssigneePolicy` is unconditionally
    // emitted (never omitted, defaults to `'error'`) — this fix round's P1-1/P3-2 changes touch only
    // hydration and `emptyAssigneeFallback`'s OWN conditional emission, never this always-emit
    // behavior for an untouched template.
    expect(Object.prototype.hasOwnProperty.call(config, 'emptyAssigneePolicy')).toBe(true)
    expect(config.emptyAssigneePolicy).toBe('error')
  })

  it('the re-emitted emptyAssigneeFallback object is a COPY, never an alias of the reactive draft', () => {
    const draft = draftFromTemplate(tpl(linearGraph({
      assigneeSources: [{ kind: 'static_user', userIds: ['admin-1'] }],
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: { userIds: ['admin-1'] },
    })))
    const rebuilt = buildApprovalGraph(draft)
    const emitted = (rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>)
      .emptyAssigneeFallback as EmptyAssigneeFallback
    expect(emitted).not.toBe(draft.steps[0]!.emptyAssigneeFallback)
    emitted.userIds = ['tampered']
    expect(draft.steps[0]!.emptyAssigneeFallback).toEqual({ userIds: ['admin-1'] })
  })

  it("an OFF-ENUM emptyAssigneePolicy value is preserved verbatim by hydrate (never coerced to 'error') — the read-only guard is the single door, not this line", () => {
    const draft = draftFromTemplate(tpl(linearGraph({
      assigneeSources: [{ kind: 'requester' }],
      emptyAssigneePolicy: 'not-a-real-policy',
    })))
    expect(draft.steps[0]?.emptyAssigneePolicy).toBe('not-a-real-policy')
  })

  it("switching a designated step's 空审批人策略 away (the shipped <el-select>, bound directly to step.emptyAssigneePolicy) leaves NO orphaned emptyAssigneeFallback key — otherwise P2-3's own validator 400s a save on a key no linear UI can see or clear", () => {
    const draft = draftFromTemplate(tpl(linearGraph({
      assigneeSources: [{ kind: 'static_user', userIds: ['admin-1'] }],
      emptyAssigneePolicy: 'designated',
      emptyAssigneeFallback: { userIds: ['admin-1'] },
    })))
    expect(draft.steps[0]?.emptyAssigneeFallback).toEqual({ userIds: ['admin-1'] })
    // Mirrors what the shipped <el-select v-model="step.emptyAssigneePolicy"> does on selection —
    // it writes the draft field directly; there is no separate "clear fallback" step in the UI.
    draft.steps[0]!.emptyAssigneePolicy = 'error'
    const config = buildApprovalGraph(draft).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.emptyAssigneePolicy).toBe('error')
    expect(Object.prototype.hasOwnProperty.call(config, 'emptyAssigneeFallback')).toBe(false)
  })
})

describe('Lock-4 §3 F4-B / gate P3-2 — the CANVAS path preserves the key across an edit it does not own', () => {
  it('an untouched seed + rebuild reproduces the persisted designated + emptyAssigneeFallback byte-for-byte (W1-1a: identity seed — the edit model now carries the key)', () => {
    const graph = complexGraphWithF4B({ userIds: ['admin-1'] })
    const edits = approvalNodeEditsFromGraph(graph)
    expect(edits.approval_1?.emptyAssigneeFallback).toEqual({ userIds: ['admin-1'] })
    const rebuilt = applyApprovalNodeEditsToGraph(graph, edits)
    expect(rebuilt.nodes.find((n) => n.key === 'approval_1')!.config).toEqual(
      graph.nodes.find((n) => n.key === 'approval_1')!.config,
    )
  })

  it('editing an UNRELATED node leaves a designated node (which the author never opened) byte-identical', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: '审批人 1',
          config: {
            assigneeSources: [{ kind: 'static_user', userIds: ['admin-1'] }],
            emptyAssigneePolicy: 'designated',
            emptyAssigneeFallback: { userIds: ['admin-1'] },
          } as never,
        },
        {
          key: 'approval_2',
          type: 'approval',
          name: '审批人 2',
          config: { assigneeSources: [{ kind: 'requester' }] } as never,
        },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'approval_2' },
        { key: 'e3', source: 'approval_2', target: 'end' },
      ],
    }
    const edits = approvalNodeEditsFromGraph(graph)
    edits.approval_2!.assigneeSources = [{ kind: 'static_role', roleIds: ['finance'] }]
    const rebuilt = applyApprovalNodeEditsToGraph(graph, edits)
    expect(rebuilt.nodes.find((n) => n.key === 'approval_1')!.config).toEqual(
      graph.nodes.find((n) => n.key === 'approval_1')!.config,
    )
  })

  it("validateApprovalNodeEdits no longer flags a seeded 'designated' edit — an untouched, valid, persisted value must not block save on a node the author never opened", () => {
    const graph = complexGraphWithF4B({ userIds: ['admin-1'] })
    const edits = approvalNodeEditsFromGraph(graph)
    expect(edits.approval_1?.emptyAssigneePolicy).toBe('designated')
    expect(validateApprovalNodeEdits(edits)).toEqual([])
  })

  it('POSITIVE CONTROL — validateApprovalNodeEdits still rejects a genuinely unknown emptyAssigneePolicy value', () => {
    const edits = approvalNodeEditsFromGraph(complexGraph({
      assigneeSources: [{ kind: 'requester' }],
      emptyAssigneePolicy: 'not-a-real-policy',
    }))
    expect(validateApprovalNodeEdits(edits).length).toBeGreaterThan(0)
  })

  it("switching a designated node's 空审批人策略 control away on the CANVAS path leaves NO orphaned emptyAssigneeFallback key — mirrors approvalThreshold's own conditional-clear arm in the same function", () => {
    const graph = complexGraphWithF4B({ userIds: ['admin-1'] })
    const edits = approvalNodeEditsFromGraph(graph)
    expect(edits.approval_1?.emptyAssigneePolicy).toBe('designated')
    // Mirrors what the shipped inspector control does — sets the edit's emptyAssigneePolicy field
    // directly, with no separate "clear fallback" action.
    edits.approval_1!.emptyAssigneePolicy = 'error'
    const rebuilt = applyApprovalNodeEditsToGraph(graph, edits)
    const config = rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.emptyAssigneePolicy).toBe('error')
    expect(Object.prototype.hasOwnProperty.call(config, 'emptyAssigneeFallback')).toBe(false)
  })

  it('POSITIVE CONTROL — an UNTOUCHED designated edit (policy left as-is) keeps the fallback (the clear is policy-selected, not unconditional)', () => {
    const graph = complexGraphWithF4B({ userIds: ['admin-1'] })
    const rebuilt = applyApprovalNodeEditsToGraph(graph, approvalNodeEditsFromGraph(graph))
    const config = rebuilt.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.emptyAssigneePolicy).toBe('designated')
    expect(config.emptyAssigneeFallback).toEqual({ userIds: ['admin-1'] })
  })
})

// ── W1-1a (Lock-4 §3 F4-B, RATIFIED; backend on main) — the 'designated' fallback becomes AUTHORABLE
// in BOTH editors through typed user/role pickers. The lock: "`emptyAssigneeFallback?: { userIds?:
// string[]; roleIds?: string[] }`, filled through typed pickers only (D0 §10.2). `'error'` stays the
// absent default." Backend enforcement evidence (Lock-4 §2.1 / X-5): tests/unit/
// approval-p3a-f4b-designated-fallback.test.ts (B-1/B-2/B-3) + approval-realdb-f4b-designated lane.
describe('W1-1a — Lock-4 F4-B authoring: the shared fallback helpers', () => {
  it('withEmptyAssigneeFallbackIds replaces ONE side, keeps the other, and prunes blanks / duplicates / an empty side', () => {
    expect(withEmptyAssigneeFallbackIds(undefined, 'user', ['u1', ' u1 ', '', 'u2'])).toEqual({ userIds: ['u1', 'u2'] })
    expect(withEmptyAssigneeFallbackIds({ userIds: ['u1'] }, 'role', ['r1'])).toEqual({ userIds: ['u1'], roleIds: ['r1'] })
    expect(withEmptyAssigneeFallbackIds({ userIds: ['u1'], roleIds: ['r1'] }, 'user', [])).toEqual({ roleIds: ['r1'] })
  })

  it('clearing BOTH sides yields undefined (the key is dropped — the backend normalizes an all-empty fallback to absent the same way)', () => {
    expect(withEmptyAssigneeFallbackIds({ roleIds: ['r1'] }, 'role', [])).toBeUndefined()
    expect(withEmptyAssigneeFallbackIds(undefined, 'user', ['  '])).toBeUndefined()
  })

  it('returns a FRESH object (never aliases the input)', () => {
    const input: EmptyAssigneeFallback = { userIds: ['u1'], roleIds: ['r1'] }
    const out = withEmptyAssigneeFallbackIds(input, 'user', ['u2'])!
    expect(out).not.toBe(input)
    expect(input).toEqual({ userIds: ['u1'], roleIds: ['r1'] })
  })

  it('emptyAssigneeFallbackHasTarget mirrors the backend B-s10 emptiness check (empty arrays ≡ absent)', () => {
    expect(emptyAssigneeFallbackHasTarget(undefined)).toBe(false)
    expect(emptyAssigneeFallbackHasTarget(null)).toBe(false)
    expect(emptyAssigneeFallbackHasTarget({})).toBe(false)
    expect(emptyAssigneeFallbackHasTarget({ userIds: [], roleIds: [] })).toBe(false)
    expect(emptyAssigneeFallbackHasTarget({ userIds: ['  '] })).toBe(false)
    // POSITIVE CONTROLS — either side alone counts.
    expect(emptyAssigneeFallbackHasTarget({ userIds: ['u1'] })).toBe(true)
    expect(emptyAssigneeFallbackHasTarget({ roleIds: ['r1'] })).toBe(true)
  })
})

describe('W1-1a — Lock-4 F4-B authoring: LINEAR editor writes the fallback through the typed pickers', () => {
  function designatedLinearDraft(fallback?: EmptyAssigneeFallback) {
    return draftFromTemplate(tpl(linearGraph({
      assigneeSources: [{ kind: 'requester' }],
      emptyAssigneePolicy: fallback ? 'designated' : 'error',
      ...(fallback ? { emptyAssigneeFallback: fallback } : {}),
    })))
  }
  function approvalConfig(graph: ApprovalGraph): Record<string, unknown> {
    return graph.nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
  }

  it("picking 'designated' + a role through the picker emits exactly { emptyAssigneePolicy:'designated', emptyAssigneeFallback:{ roleIds } }", () => {
    const draft = designatedLinearDraft()
    draft.steps[0]!.emptyAssigneePolicy = 'designated'
    setStepEmptyAssigneeFallbackIds(draft.steps[0]!, 'role', ['approval-admin'])
    const config = approvalConfig(buildApprovalGraph(draft))
    expect(config.emptyAssigneePolicy).toBe('designated')
    expect(config.emptyAssigneeFallback).toEqual({ roleIds: ['approval-admin'] })
  })

  it('adding users keeps the roles (one side at a time), and the emitted object is pruned', () => {
    const draft = designatedLinearDraft({ roleIds: ['approval-admin'] })
    setStepEmptyAssigneeFallbackIds(draft.steps[0]!, 'user', ['u1', '', 'u1'])
    expect(approvalConfig(buildApprovalGraph(draft)).emptyAssigneeFallback).toEqual({ userIds: ['u1'], roleIds: ['approval-admin'] })
  })

  it('switching away omits the key, switching BACK restores the last-entered targets (the approvalThreshold posture)', () => {
    const draft = designatedLinearDraft({ userIds: ['u1'] })
    draft.steps[0]!.emptyAssigneePolicy = 'auto-approve'
    expect(Object.prototype.hasOwnProperty.call(approvalConfig(buildApprovalGraph(draft)), 'emptyAssigneeFallback')).toBe(false)
    draft.steps[0]!.emptyAssigneePolicy = 'designated'
    expect(approvalConfig(buildApprovalGraph(draft)).emptyAssigneeFallback).toEqual({ userIds: ['u1'] })
  })

  it('B-s10 FE mirror: designated with NO target is a SAVE-blocking error (the backend rejects it on create/update, APPROVAL_EMPTY_ASSIGNEE_FALLBACK_REQUIRED)', () => {
    const draft = designatedLinearDraft({ userIds: ['u1'] })
    setStepEmptyAssigneeFallbackIds(draft.steps[0]!, 'user', [])
    expect(draft.steps[0]!.emptyAssigneeFallback).toBeUndefined()
    const designatedError = (errors: string[]) => errors.some((e) => e.includes('转交指定人员'))
    expect(designatedError(validateTemplateApprovalFlow(draft))).toBe(true)
    // minimal ≡ the 保存草稿 gate (collectTemplateSaveMinimum) — must block there too.
    expect(designatedError(validateTemplateApprovalFlow(draft, { minimal: true }))).toBe(true)
    // values-free: the message names the step and the policy only, never an id.
    expect(validateTemplateApprovalFlow(draft).find((e) => e.includes('转交指定人员'))).not.toContain('u1')
  })

  it('POSITIVE CONTROLS — a designated step WITH a target, and a non-designated step with no fallback, pass the same check', () => {
    const withTarget = designatedLinearDraft({ roleIds: ['approval-admin'] })
    expect(validateTemplateApprovalFlow(withTarget).some((e) => e.includes('转交指定人员'))).toBe(false)
    const plain = designatedLinearDraft()
    expect(validateTemplateApprovalFlow(plain).some((e) => e.includes('转交指定人员'))).toBe(false)
  })
})

describe('W1-1a — Lock-4 F4-B authoring: CANVAS editor carries the fallback in the edit model', () => {
  it('the seed is IDENTITY: present when persisted, absent (not even an undefined key) when not', () => {
    const withKey = approvalNodeEditsFromGraph(complexGraphWithF4B({ roleIds: ['approval-admin'] }))
    expect(withKey.approval_1?.emptyAssigneeFallback).toEqual({ roleIds: ['approval-admin'] })
    const without = approvalNodeEditsFromGraph(complexGraph({ assigneeSources: [{ kind: 'requester' }] }))
    expect(Object.prototype.hasOwnProperty.call(without.approval_1, 'emptyAssigneeFallback')).toBe(false)
  })

  it('an authored fallback is written under designated; null removes it; switching away removes it', () => {
    const graph = complexGraph({ assigneeSources: [{ kind: 'requester' }], emptyAssigneePolicy: 'error' })
    const edits = approvalNodeEditsFromGraph(graph)
    edits.approval_1!.emptyAssigneePolicy = 'designated'
    edits.approval_1!.emptyAssigneeFallback = withEmptyAssigneeFallbackIds(undefined, 'user', ['u1'])
    let config = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.emptyAssigneePolicy).toBe('designated')
    expect(config.emptyAssigneeFallback).toEqual({ userIds: ['u1'] })

    edits.approval_1!.emptyAssigneeFallback = null
    config = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(config, 'emptyAssigneeFallback')).toBe(false)

    edits.approval_1!.emptyAssigneeFallback = { userIds: ['u1'] }
    edits.approval_1!.emptyAssigneePolicy = 'auto-approve'
    config = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(config, 'emptyAssigneeFallback')).toBe(false)
  })

  it('B-s10 FE mirror on the CANVAS path: designated without a target is flagged; with one it is not (positive control)', () => {
    const graph = complexGraph({ assigneeSources: [{ kind: 'requester' }], emptyAssigneePolicy: 'error' })
    const edits = approvalNodeEditsFromGraph(graph)
    edits.approval_1!.emptyAssigneePolicy = 'designated'
    expect(validateApprovalNodeEdits(edits).some((e) => e.includes('转交指定人员'))).toBe(true)
    edits.approval_1!.emptyAssigneeFallback = { userIds: [], roleIds: [] }
    expect(validateApprovalNodeEdits(edits).some((e) => e.includes('转交指定人员'))).toBe(true)
    edits.approval_1!.emptyAssigneeFallback = { roleIds: ['approval-admin'] }
    expect(validateApprovalNodeEdits(edits)).toEqual([])
  })
})

// ── W1-1a (Lock-4 §2 F4-C, RATIFIED; backend on main) — the four-value 审批人与发起人为同一人时
// control. Lock text: "Enum `samePersonPolicy?: 'self_approve' | 'auto_skip' |
// 'transfer_direct_manager' | 'transfer_dept_head'`, absent ≡ `'self_approve'` ≡ today's behavior when
// `mergeWithRequester` is off." / "`mergeWithRequester:true` … IS the 自动跳过 family … stays the
// persisted carrier for that value, so no existing graph changes shape." Backend enforcement evidence
// (§2.1 / X-5): tests/unit/approval-lock4-f4c-same-person.test.ts (exact set, auto_skip synthesis,
// X-1, C-1/C-3) + tests/integration/approval-lock4-f4c-same-person.db.test.ts (C-1/C-2/C-3).
describe('W1-1a — Lock-4 F4-C: samePersonControlState projects what the backend RUNS', () => {
  const cases: Array<[string, AutoApprovalPolicy | undefined, string]> = [
    ['absent policy', undefined, 'default'],
    ['empty object', {}, 'default'],
    ['explicit mergeWithRequester:false', { mergeWithRequester: false }, 'default'],
    ['bare legacy carrier', { mergeWithRequester: true }, 'auto_skip'],
    ['auto_skip as the backend persists it', { mergeWithRequester: true, samePersonPolicy: 'auto_skip' }, 'auto_skip'],
    ['explicit self_approve', { samePersonPolicy: 'self_approve' }, 'self_approve'],
    ['transfer_direct_manager', { samePersonPolicy: 'transfer_direct_manager' }, 'transfer_direct_manager'],
    ['transfer_dept_head', { samePersonPolicy: 'transfer_dept_head' }, 'transfer_dept_head'],
    // API-only combinations: the resolver substitutes BEFORE the merge cascade, so a transfer wins…
    ['transfer + a co-present merge flag', { samePersonPolicy: 'transfer_dept_head', mergeWithRequester: true }, 'transfer_dept_head'],
    // …but an explicit self_approve does NOT stop the merge cascade — runtime auto-skips, so the UI says so.
    ['self_approve + a co-present merge flag', { samePersonPolicy: 'self_approve', mergeWithRequester: true }, 'auto_skip'],
    ['siblings only', { mergeAdjacentApprover: true, actorMode: 'system' }, 'default'],
  ]
  for (const [label, policy, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(samePersonControlState(policy)).toEqual({ kind: 'editable', choice: expected })
      expect(samePersonSelectValue(policy)).toBe(expected)
    })
  }

  it('gate X-3: an OFF-ENUM persisted value is `unknown` — never projected onto a known choice', () => {
    const policy = { samePersonPolicy: 'transfer_to_ceo' } as unknown as AutoApprovalPolicy
    expect(samePersonControlState(policy)).toEqual({ kind: 'unknown' })
    expect(samePersonSelectValue(policy)).toBe(SAME_PERSON_UNKNOWN_SELECT_VALUE)
  })
})

describe('W1-1a — Lock-4 F4-C: applySamePersonChoice owns BOTH carriers and keeps every sibling', () => {
  const siblings: AutoApprovalPolicy = { mergeAdjacentApprover: true, dedupeHistoricalApprover: false, actorMode: 'system' }

  it("implementer default (a): 'auto_skip' writes samePersonPolicy:'auto_skip' AND mergeWithRequester:true (the shape the backend persists)", () => {
    expect(applySamePersonChoice(undefined, 'auto_skip')).toEqual({ mergeWithRequester: true, samePersonPolicy: 'auto_skip' })
  })

  it('INVARIANT — leaving auto_skip for self_approve / a transfer DELETES mergeWithRequester (else the merge cascade would still auto-skip while the UI says otherwise)', () => {
    for (const from of [{ mergeWithRequester: true }, { mergeWithRequester: true, samePersonPolicy: 'auto_skip' }] as AutoApprovalPolicy[]) {
      expect(applySamePersonChoice(from, 'self_approve')).toEqual({ samePersonPolicy: 'self_approve' })
      expect(applySamePersonChoice(from, 'transfer_direct_manager')).toEqual({ samePersonPolicy: 'transfer_direct_manager' })
      expect(applySamePersonChoice(from, 'transfer_dept_head')).toEqual({ samePersonPolicy: 'transfer_dept_head' })
    }
  })

  it("implementer default (b): 'default' OMITS both keys — null when nothing else is left (the canvas 'remove the key' grammar)", () => {
    expect(applySamePersonChoice({ mergeWithRequester: true, samePersonPolicy: 'auto_skip' }, 'default')).toBeNull()
    expect(applySamePersonChoice({ samePersonPolicy: 'transfer_dept_head' }, 'default')).toBeNull()
    expect(applySamePersonChoice({ samePersonPolicy: 'self_approve' }, 'default')).toBeNull()
  })

  it('delete-key-keep-siblings (Lock-4 OD-L4-6): mergeAdjacentApprover / dedupeHistoricalApprover / actorMode survive every pick', () => {
    expect(applySamePersonChoice({ ...siblings, mergeWithRequester: true }, 'default')).toEqual(siblings)
    expect(applySamePersonChoice(siblings, 'transfer_direct_manager')).toEqual({ ...siblings, samePersonPolicy: 'transfer_direct_manager' })
    expect(applySamePersonChoice(siblings, 'auto_skip')).toEqual({ ...siblings, mergeWithRequester: true, samePersonPolicy: 'auto_skip' })
  })

  it('implementer default (c): re-picking the CURRENT projection is a no-op — a bare legacy { mergeWithRequester:true } keeps its exact shape', () => {
    const legacy: AutoApprovalPolicy = { mergeWithRequester: true }
    expect(applySamePersonChoice(legacy, 'auto_skip')).toBe(legacy)
    expect(applySamePersonChoice(undefined, 'default')).toBeUndefined()
  })

  it('gate X-3: an unknown persisted value is never overwritten by the control (fail-closed no-op)', () => {
    const unknown = { samePersonPolicy: 'transfer_to_ceo' } as unknown as AutoApprovalPolicy
    expect(applySamePersonChoice(unknown, 'auto_skip')).toBe(unknown)
    expect(applySamePersonChoice(unknown, 'default')).toBe(unknown)
  })

  it('the raw select value is narrowed before any write: only default + the four ratified values pass', () => {
    expect(samePersonChoiceFromSelectValue('default')).toBe('default')
    expect(samePersonChoiceFromSelectValue('transfer_dept_head')).toBe('transfer_dept_head')
    expect(samePersonChoiceFromSelectValue(SAME_PERSON_UNKNOWN_SELECT_VALUE)).toBeNull()
    expect(samePersonChoiceFromSelectValue('')).toBeNull()
    expect(samePersonChoiceFromSelectValue(undefined)).toBeNull()
  })
})

describe('W1-1a — Lock-4 F4-C: option rendering (M8 honesty — business labels, never the raw enum)', () => {
  it('offers 默认 + exactly the four ratified values, in lock order', () => {
    expect(samePersonChoiceOptions(undefined).map((o) => o.value))
      .toEqual(['default', 'self_approve', 'auto_skip', 'transfer_direct_manager', 'transfer_dept_head'])
    for (const option of samePersonChoiceOptions(undefined)) {
      expect(option.label).not.toMatch(/self_approve|auto_skip|transfer_/)
    }
    expect(samePersonChoiceOptions(undefined)[1]!.label).toBe(SAME_PERSON_EXPLICIT_CHOICE_LABELS.self_approve)
  })

  it("default (b) honesty: 默认 says 跟随模板 only when the node has NO other node-level auto-approval key", () => {
    expect(samePersonChoiceOptions(undefined)[0]!.label).toBe('默认（跟随模板设置）')
    expect(samePersonChoiceOptions({ mergeWithRequester: true })[0]!.label).toBe('默认（跟随模板设置）')
    // A sibling key means the node ALREADY overrides the template-level policy (Lock-4 §0 precedence).
    expect(samePersonChoiceOptions({ mergeAdjacentApprover: true })[0]!.label).toBe('默认（本节点不单独设置）')
  })

  it('gate X-3: an unknown persisted value gets ONE leading read-only option with an honest label (never the raw string)', () => {
    const options = samePersonChoiceOptions({ samePersonPolicy: 'transfer_to_ceo' } as unknown as AutoApprovalPolicy)
    expect(options[0]).toEqual({ value: SAME_PERSON_UNKNOWN_SELECT_VALUE, label: SAME_PERSON_UNKNOWN_LABEL })
    expect(options.map((o) => o.label).join('|')).not.toContain('transfer_to_ceo')
    // POSITIVE CONTROL — a known value adds no such option (the branch is value-selected).
    expect(samePersonChoiceOptions({ samePersonPolicy: 'transfer_dept_head' }).some((o) => o.value === SAME_PERSON_UNKNOWN_SELECT_VALUE)).toBe(false)
  })
})

describe('W1-1a — Lock-4 F4-C on the CANVAS path: round-trip + write-through + X-3', () => {
  const known: AutoApprovalPolicy[] = [
    { mergeWithRequester: true },
    { mergeWithRequester: true, samePersonPolicy: 'auto_skip' },
    { samePersonPolicy: 'self_approve' },
    { samePersonPolicy: 'transfer_direct_manager', actorMode: 'system' },
    { samePersonPolicy: 'transfer_dept_head' },
  ]

  it('a template carrying ANY known samePersonPolicy is EDITABLE on the complex path (the key joined the nested allowlist)', () => {
    for (const policy of known) {
      expect(unsupportedTemplateAuthoringReason(tpl(complexGraph({ assigneeSources: [{ kind: 'requester' }], autoApprovalPolicy: policy }))), JSON.stringify(policy)).toBeNull()
    }
  })

  it('an untouched seed + rebuild is byte-identical for every known shape (no existing graph changes shape)', () => {
    for (const policy of known) {
      const graph = complexGraph({ assigneeSources: [{ kind: 'requester' }], autoApprovalPolicy: policy })
      const rebuilt = applyApprovalNodeEditsToGraph(graph, approvalNodeEditsFromGraph(graph))
      expect(rebuilt.nodes.find((n) => n.key === 'approval_1')!.config, JSON.stringify(policy)).toEqual(
        graph.nodes.find((n) => n.key === 'approval_1')!.config,
      )
    }
  })

  it('write-through: a pick applied to the edit lands in the rebuilt node config', () => {
    const graph = complexGraph({ assigneeSources: [{ kind: 'requester' }], autoApprovalPolicy: { mergeWithRequester: true } })
    const edits = approvalNodeEditsFromGraph(graph)
    edits.approval_1!.autoApprovalPolicy = applySamePersonChoice(edits.approval_1!.autoApprovalPolicy, 'transfer_direct_manager')
    const config = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(config.autoApprovalPolicy).toEqual({ samePersonPolicy: 'transfer_direct_manager' })

    edits.approval_1!.autoApprovalPolicy = applySamePersonChoice(edits.approval_1!.autoApprovalPolicy, 'default')
    const cleared = applyApprovalNodeEditsToGraph(graph, edits).nodes.find((n) => n.key === 'approval_1')!.config as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(cleared, 'autoApprovalPolicy')).toBe(false)
  })

  it('gate X-3 on BOTH paths: an off-enum samePersonPolicy forces read-only; a known value stays editable (value-selected)', () => {
    const off = { assigneeSources: [{ kind: 'requester' }], autoApprovalPolicy: { samePersonPolicy: 'transfer_to_ceo' } }
    expect(unsupportedTemplateAuthoringReason(tpl(complexGraph(off)))).not.toBeNull()
    expect(unsupportedTemplateAuthoringReason(tpl(linearGraph(off)))).not.toBeNull()
    const on = { assigneeSources: [{ kind: 'requester' }], autoApprovalPolicy: { samePersonPolicy: 'transfer_dept_head' } }
    expect(unsupportedTemplateAuthoringReason(tpl(complexGraph(on)))).toBeNull()
    expect(unsupportedTemplateAuthoringReason(tpl(linearGraph(on)))).toBeNull()
  })

  it('POSITIVE CONTROL — a genuinely unknown autoApprovalPolicy KEY still forces read-only (the allowlist widened by ONE key, not removed)', () => {
    const cfg = { assigneeSources: [{ kind: 'requester' }], autoApprovalPolicy: { mergeWithRequester: true, futureFlag: true } }
    expect(unsupportedTemplateAuthoringReason(tpl(complexGraph(cfg)))).not.toBeNull()
    expect(unsupportedTemplateAuthoringReason(tpl(linearGraph(cfg)))).not.toBeNull()
  })
})
