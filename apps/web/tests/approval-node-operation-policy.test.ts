import { describe, expect, it } from 'vitest'
import type {
  ApprovalGraph,
  ApprovalTemplateDetailDTO,
  EmptyAssigneeFallback,
  NodeOperationPolicy,
} from '../src/types/approval'
import {
  buildApprovalGraph,
  draftFromTemplate,
  unsupportedTemplateAuthoringReason,
} from '../src/approvals/templateAuthoring'
import {
  applyApprovalNodeEditsToGraph,
  approvalNodeEditsFromGraph,
  validateApprovalNodeEdits,
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
  it('an untouched seed + rebuild reproduces the persisted designated + emptyAssigneeFallback byte-for-byte (spread-preserve, no edit-model entry needed)', () => {
    const graph = complexGraphWithF4B({ userIds: ['admin-1'] })
    const rebuilt = applyApprovalNodeEditsToGraph(graph, approvalNodeEditsFromGraph(graph))
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
