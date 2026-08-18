/**
 * Lock-3 — handler-node authoring PURE-function acceptance (no mount):
 *  - G-13: the handler assignee-source registry equals the SEVEN-member set by exact-set equality
 *          (not count, not subset, not the full ApprovalAssigneeSourceKind union); two mutations
 *          (drop an admitted kind, add continuous_managers) each fail.
 *  - G-20: a `handlerx` graph forces the template read-only; a `handler` graph is recognised and
 *          complex-preserved (never flattened).
 *  - edit-model round-trip: a handler graph seeds a handler edit and rebuilds byte-identically; the
 *    validate preview rejects an unadmitted kind on a handler and a bad handlerMode.
 *  - graphTopologyEdit.appendHandlerNode inserts a valid, seven-member-admissible handler.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
  assigneeSourceRoster,
  type ApprovalCapabilityRegistry,
} from '../src/approvals/approvalCapabilityRegistry'
import {
  approvalNodeEditsFromGraph,
  applyApprovalNodeEditsToGraph,
  validateApprovalNodeEdits,
} from '../src/approvals/approvalNodeEdit'
import {
  isComplexApprovalGraph,
  unsupportedTemplateAuthoringReason,
} from '../src/approvals/templateAuthoring'
import { appendHandlerNode } from '../src/approvals/graphTopologyEdit'
import {
  HANDLER_ASSIGNEE_SOURCE_KINDS,
  type ApprovalGraph,
  type ApprovalTemplateDetailDTO,
} from '../src/types/approval'

const FORM_SCHEMA = { fields: [{ id: 'amount', type: 'number' as const, label: '金额' }] }

function handlerGraph(config: Record<string, unknown>): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'handler_h', type: 'handler', name: '办理', config: config as any },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2h', source: 'start', target: 'handler_h' },
      { key: 'h2e', source: 'handler_h', target: 'end' },
    ],
  }
}
function template(graph: ApprovalGraph): ApprovalTemplateDetailDTO {
  return {
    id: 't', key: 'k', name: 'n', description: null, category: null,
    visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
    activeVersionId: null, latestVersionId: null, createdAt: '', updatedAt: '',
    formSchema: FORM_SCHEMA as any, approvalGraph: graph,
  }
}

describe('Lock-3 G-13 — handler assignee-source registry exact set', () => {
  it('the registry roster for `handler` equals the SEVEN-member constant by exact set equality', () => {
    const roster = assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'handler').map((c) => c.kind)
    expect(new Set(roster)).toEqual(new Set(HANDLER_ASSIGNEE_SOURCE_KINDS))
    expect(roster).toHaveLength(HANDLER_ASSIGNEE_SOURCE_KINDS.length)
    // NOT the eight/nine-member approval union: strictly fewer kinds than the approval roster.
    const approvalRoster = assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'approval').map((c) => c.kind)
    expect(roster.length).toBeLessThan(approvalRoster.length)
    expect(roster).not.toContain('continuous_managers')
    expect(roster).not.toContain('requester_choice')
    // Lock-1 §K5-b `dept_head_at_level`: Lock-3 §1.5 names it a FORWARD ADMIT row for `handler`,
    // but per the SAME precedent this file already documents for `requester_choice` (shipped
    // before P4-A, and P4-A deliberately did NOT retroactively widen the roster for it — "a
    // separate follow-up decision, not P4-A", approval-product.ts's HANDLER_ASSIGNEE_SOURCE_KINDS
    // doc comment), K5-b's own slice does not widen the SEVEN-member handler roster either. Not
    // admitting it here is the deliberate deferral, not an oversight.
    expect(roster).not.toContain('dept_head_at_level')
    // Lock-1 §K3 `prior_node_approver`: unlike K5-b, Lock-3 §1.5 lists NO forward ADMIT row for
    // this kind at all — its absence from the handler roster is the contract, not a deferral.
    expect(roster).not.toContain('prior_node_approver')
  })

  it('mutation 1 — dropping an admitted kind fails the exact-set check', () => {
    const dropped: ApprovalCapabilityRegistry = {
      assigneeSourcesByNodeType: { handler: assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'handler').filter((c) => c.kind !== 'requester') },
      operationPoliciesByNodeType: {},
    }
    const roster = assigneeSourceRoster(dropped, 'handler').map((c) => c.kind)
    expect(new Set(roster)).not.toEqual(new Set(HANDLER_ASSIGNEE_SOURCE_KINDS))
  })

  it('mutation 2 — adding continuous_managers fails the exact-set check', () => {
    const added: ApprovalCapabilityRegistry = {
      assigneeSourcesByNodeType: { handler: [...assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'handler'), { kind: 'continuous_managers', label: '连续多级上级' }] },
      operationPoliciesByNodeType: {},
    }
    const roster = assigneeSourceRoster(added, 'handler').map((c) => c.kind)
    expect(new Set(roster)).not.toEqual(new Set(HANDLER_ASSIGNEE_SOURCE_KINDS))
  })

  // Lock-1 §K5-b deferral invariant: even though Lock-3 §1.5 names dept_head_at_level a FORWARD
  // ADMIT row for `handler`, this slice does NOT land it (see the `roster).not.toContain(...)`
  // assertion above) — so "adding" it here must fail the exact-set check exactly like mutation 2's
  // continuous_managers, not be silently accepted as a legitimate widening.
  it('mutation 3 — adding dept_head_at_level (Lock-1 §K5-b, deliberately deferred) fails the exact-set check', () => {
    const added: ApprovalCapabilityRegistry = {
      assigneeSourcesByNodeType: { handler: [...assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'handler'), { kind: 'dept_head_at_level', label: '指定层级部门负责人' }] },
      operationPoliciesByNodeType: {},
    }
    const roster = assigneeSourceRoster(added, 'handler').map((c) => c.kind)
    expect(new Set(roster)).not.toEqual(new Set(HANDLER_ASSIGNEE_SOURCE_KINDS))
  })

  // Lock-1 §K3: prior_node_approver has NO handler row in Lock-3 §1.5 (not even forward) —
  // "adding" it must fail the exact-set check exactly like the probes above.
  it('mutation 4 — adding prior_node_approver (Lock-1 §K3, no handler row exists) fails the exact-set check', () => {
    const added: ApprovalCapabilityRegistry = {
      assigneeSourcesByNodeType: { handler: [...assigneeSourceRoster(DEFAULT_APPROVAL_CAPABILITY_REGISTRY, 'handler'), { kind: 'prior_node_approver', label: '节点审批人' }] },
      operationPoliciesByNodeType: {},
    }
    const roster = assigneeSourceRoster(added, 'handler').map((c) => c.kind)
    expect(new Set(roster)).not.toEqual(new Set(HANDLER_ASSIGNEE_SOURCE_KINDS))
  })
})

describe('Lock-3 G-20 — handler recognised vs unknown type', () => {
  it('positive control: a `handler` graph is NOT unsupported (editable) and IS complex (canvas-preserved)', () => {
    const graph = handlerGraph({ assigneeSources: [{ kind: 'requester' }] })
    expect(unsupportedTemplateAuthoringReason(template(graph))).toBeNull()
    expect(isComplexApprovalGraph(graph)).toBe(true)
  })

  it('a `handlerx` (unknown) node forces the whole template read-only (fail-closed)', () => {
    const graph = handlerGraph({ assigneeSources: [{ kind: 'requester' }] })
    ;(graph.nodes[1] as { type: string }).type = 'handlerx'
    expect(unsupportedTemplateAuthoringReason(template(graph))).not.toBeNull()
  })
})

describe('Lock-3 — handler edit-model round-trip + validate', () => {
  it('seeds a handler edit (nodeType/handlerMode/opinionRequired) and rebuilds byte-identically', () => {
    const graph = handlerGraph({ assigneeSources: [{ kind: 'static_user', userIds: ['u1'] }], handlerMode: 'any', opinionRequired: true, fieldPermissions: [{ fieldId: 'amount', access: 'readonly' }] })
    const edits = approvalNodeEditsFromGraph(graph)
    expect(edits.handler_h.nodeType).toBe('handler')
    expect(edits.handler_h.handlerMode).toBe('any')
    expect(edits.handler_h.opinionRequired).toBe(true)
    // untouched round-trip is byte-identical.
    expect(applyApprovalNodeEditsToGraph(graph, edits)).toEqual(graph)
  })

  it('a handler edit NEVER emits approval-node keys even when the seed carries none', () => {
    const graph = handlerGraph({ assigneeSources: [{ kind: 'requester' }], handlerMode: 'all' })
    const rebuilt = applyApprovalNodeEditsToGraph(graph, approvalNodeEditsFromGraph(graph))
    const cfg = rebuilt.nodes[1].config as Record<string, unknown>
    expect(cfg.approvalMode).toBeUndefined()
    expect(cfg.emptyAssigneePolicy).toBeUndefined()
    expect(cfg.autoApprovalPolicy).toBeUndefined()
    expect(cfg.assigneeSources).toBeTruthy()
  })

  it('validate flags an unadmitted kind and a bad handlerMode on a handler edit; a valid handler passes', () => {
    const bad = validateApprovalNodeEdits({ handler_h: { nodeKey: 'handler_h', nodeType: 'handler', assigneeSources: [{ kind: 'continuous_managers', levels: 2 } as any], handlerMode: 'sequential' as any } })
    expect(bad.length).toBeGreaterThan(0)
    const ok = validateApprovalNodeEdits({ handler_h: { nodeKey: 'handler_h', nodeType: 'handler', assigneeSources: [{ kind: 'requester' }], handlerMode: 'all' } })
    expect(ok).toEqual([])
  })
})

describe('Lock-3 — graphTopologyEdit.appendHandlerNode', () => {
  it('inserts a handler node on a linear edge with a seven-member-admissible default roster', () => {
    const base: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 's2e', source: 'start', target: 'end' }],
    }
    const next = appendHandlerNode(base, 'start')
    const handler = next.nodes.find((n) => n.type === 'handler')
    expect(handler).toBeTruthy()
    const sources = (handler!.config as { assigneeSources: Array<{ kind: string }> }).assigneeSources
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.every((s) => (HANDLER_ASSIGNEE_SOURCE_KINDS as readonly string[]).includes(s.kind))).toBe(true)
    // the original edge is spliced: start → handler → end (single-out preserved).
    expect(next.edges).toHaveLength(2)
  })
})
