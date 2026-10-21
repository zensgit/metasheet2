import { describe, expect, it } from 'vitest'
import {
  APPROVAL_TYPES,
  REQUEST_VALIDATION_CONTEXT,
  assertApprovalGraph,
  normalizeApprovalType,
  validateApprovalTypePlacement,
} from '../../src/services/ApprovalProductService'
import { ApprovalGraphExecutor } from '../../src/services/ApprovalGraphExecutor'
import type { ApprovalGraph, RuntimeGraph } from '../../src/types/approval-product'

/**
 * Lock-4 §2 F4-A — node-level automatic decision (审批类型), `approvalType?: 'manual' |
 * 'auto_approve'` on `type:'approval'`. Source: `docs/development/approval-lock4-flow-policies-
 * 20260817.md` (RATIFIED 2026-08-17) OD-L4-1(a), OD-L4-2(a), gates A-1, A-2, A-3.
 *
 * DB-INDEPENDENT (required `test (18.x/20.x)` lane): the publish-time authoring choke
 * (`assertApprovalGraph` + `validateApprovalTypePlacement`) and the executor's F4-A short-circuit
 * (`ApprovalGraphExecutor.resolveInitialState`) are both pure functions over an in-memory graph — no
 * HTTP server, no Postgres. A-3's `dedupeHistoricalApprover`-exemption pin and the byte-identical
 * absent-config behavior over a real create+dispatch flow live in the real-DB companion
 * `tests/integration/approval-lock4-f4a-auto-decision.db.test.ts`.
 */

function twoStepGraph(overrides: {
  autoNodeConfig?: Record<string, unknown>
  manualAssigneeId?: string
}): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'auto1',
        type: 'approval',
        config: {
          approvalMode: 'single',
          ...(overrides.autoNodeConfig ?? {}),
        },
      },
      {
        key: 'manual2',
        type: 'approval',
        config: {
          assigneeType: 'user',
          assigneeIds: [overrides.manualAssigneeId ?? 'user-2'],
          approvalMode: 'single',
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-start-auto1', source: 'start', target: 'auto1' },
      { key: 'e-auto1-manual2', source: 'auto1', target: 'manual2' },
      { key: 'e-manual2-end', source: 'manual2', target: 'end' },
    ],
  } as ApprovalGraph
}

function toRuntimeGraph(graph: ApprovalGraph): RuntimeGraph {
  return { ...graph, policy: { allowRevoke: true } } as RuntimeGraph
}

describe('Lock-4 F4-A — APPROVAL_TYPES exact-set membership', () => {
  it('contains EXACTLY manual and auto_approve — auto_reject is not a member (OD-L4-2(a))', () => {
    expect(APPROVAL_TYPES).toEqual(new Set(['manual', 'auto_approve']))
    expect(APPROVAL_TYPES.has('auto_reject' as never)).toBe(false)
  })
})

describe('Lock-4 F4-A — normalizeApprovalType', () => {
  it('absent value normalizes to undefined (no throw) — the byte-identical-legacy default', () => {
    expect(normalizeApprovalType(undefined, REQUEST_VALIDATION_CONTEXT, 'p')).toBeUndefined()
  })

  it('accepts "manual"', () => {
    expect(normalizeApprovalType('manual', REQUEST_VALIDATION_CONTEXT, 'p')).toBe('manual')
  })

  it('accepts "auto_approve"', () => {
    expect(normalizeApprovalType('auto_approve', REQUEST_VALIDATION_CONTEXT, 'p')).toBe('auto_approve')
  })

  it('OD-L4-2(a) RATIFIED — "auto_approve only, auto_reject deferred… no inert third option": "auto_reject" is rejected, not silently accepted as a dormant value', () => {
    expect(() => normalizeApprovalType('auto_reject', REQUEST_VALIDATION_CONTEXT, 'p')).toThrow(/must be manual or auto_approve/)
  })

  it('rejects an arbitrary off-enum string (not merely auto_reject — the Set membership check itself)', () => {
    expect(() => normalizeApprovalType('sometimes', REQUEST_VALIDATION_CONTEXT, 'p')).toThrow(/must be manual or auto_approve/)
  })
})

describe('Lock-4 F4-A gate A-1 — "approvalType on start/end/cc/condition/parallel… fail publish 400… non-manual node inside a parallel region is rejected… a non-manual linear approval node publishes — the rejection is placement-selected"', () => {
  const forbiddenNodeFixtures: Array<{ type: string; node: Record<string, unknown> }> = [
    { type: 'start', node: { key: 'start', type: 'start', config: { approvalType: 'auto_approve' } } },
    { type: 'cc', node: { key: 'cc1', type: 'cc', config: { targetType: 'role', targetIds: ['ops'], approvalType: 'auto_approve' } } },
    {
      type: 'condition',
      node: { key: 'cond1', type: 'condition', config: { branches: [], approvalType: 'auto_approve' } },
    },
    {
      type: 'parallel',
      node: {
        key: 'par1',
        type: 'parallel',
        config: { branches: ['e1', 'e2'], joinNodeKey: 'j1', joinMode: 'all', approvalType: 'auto_approve' },
      },
    },
    { type: 'end', node: { key: 'end2', type: 'end', config: { approvalType: 'auto_approve' } } },
  ]

  for (const fixture of forbiddenNodeFixtures) {
    it(`REJECTS approvalType on a '${fixture.type}' node with 400 (not silently dropped)`, () => {
      const graph: ApprovalGraph = {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'a1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
          { key: 'end', type: 'end', config: {} },
          fixture.node,
        ].filter((n) => fixture.type !== n.type || n === fixture.node) as ApprovalGraph['nodes'],
        edges: [
          { key: 'e-start-a1', source: 'start', target: 'a1' },
          { key: 'e-a1-end', source: 'a1', target: 'end' },
        ],
      } as ApprovalGraph
      expect(() => assertApprovalGraph(graph)).toThrow(new RegExp(`config\\.approvalType is not supported on a ${fixture.type} node`))
    })
  }

  it('POSITIVE CONTROL — a linear approval node with approvalType:"auto_approve" and NO assignees publishes cleanly (assignee-required carve-out, A-s5)', () => {
    const graph = twoStepGraph({ autoNodeConfig: { approvalType: 'auto_approve' } })
    expect(() => assertApprovalGraph(graph)).not.toThrow()
    expect(() => validateApprovalTypePlacement(assertApprovalGraph(graph))).not.toThrow()
  })

  it('CONTROL — a "manual" node (explicit) with NO assignees STILL 400s — the carve-out is approvalType-selected, not blanket-relaxed', () => {
    const graph = twoStepGraph({ autoNodeConfig: { approvalType: 'manual' } })
    expect(() => assertApprovalGraph(graph)).toThrow(/must define assigneeType and assigneeIds or assigneeSources/)
  })

  it('CONTROL — absent approvalType (today\'s default) with NO assignees STILL 400s — byte-identical legacy behavior', () => {
    const graph = twoStepGraph({})
    expect(() => assertApprovalGraph(graph)).toThrow(/must define assigneeType and assigneeIds or assigneeSources/)
  })

  it('rejects a non-manual approval node inside a parallel region (APPROVAL_NODE_AUTO_TYPE_PARALLEL_UNSUPPORTED)', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'par1',
          type: 'parallel',
          config: { branches: ['e-p-b1', 'e-p-b2'], joinNodeKey: 'join1', joinMode: 'all' },
        },
        { key: 'b1', type: 'approval', config: { approvalType: 'auto_approve', approvalMode: 'single' } },
        { key: 'b2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u2'] } },
        { key: 'join1', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-start-par1', source: 'start', target: 'par1' },
        { key: 'e-p-b1', source: 'par1', target: 'b1' },
        { key: 'e-p-b2', source: 'par1', target: 'b2' },
        { key: 'e-b1-join1', source: 'b1', target: 'join1' },
        { key: 'e-b2-join1', source: 'b2', target: 'join1' },
      ],
    } as ApprovalGraph
    const normalized = assertApprovalGraph(graph, undefined, { allowParallelDuplicateAssignees: true })
    expect(() => validateApprovalTypePlacement(normalized)).toThrow(/APPROVAL_NODE_AUTO_TYPE_PARALLEL_UNSUPPORTED|not supported inside a parallel region/)
  })

  it('POSITIVE CONTROL — the SAME parallel-branch position with approvalType absent (manual) does NOT trip the parallel-region rejection', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'par1',
          type: 'parallel',
          config: { branches: ['e-p-b1', 'e-p-b2'], joinNodeKey: 'join1', joinMode: 'all' },
        },
        { key: 'b1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
        { key: 'b2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u2'] } },
        { key: 'join1', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-start-par1', source: 'start', target: 'par1' },
        { key: 'e-p-b1', source: 'par1', target: 'b1' },
        { key: 'e-p-b2', source: 'par1', target: 'b2' },
        { key: 'e-b1-join1', source: 'b1', target: 'join1' },
        { key: 'e-b2-join1', source: 'b2', target: 'join1' },
      ],
    } as ApprovalGraph
    const normalized = assertApprovalGraph(graph, undefined, { allowParallelDuplicateAssignees: true })
    expect(() => validateApprovalTypePlacement(normalized)).not.toThrow()
  })

  it('a non-manual node MAY still be a condition-branch TARGET (OD-L4-1(a)) — condition branches are not parallel regions', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'e-hi', rules: [{ fieldId: 'amount', operator: 'gt', value: 100 }] }],
            defaultEdgeKey: 'e-lo',
          },
        },
        { key: 'hi', type: 'approval', config: { approvalType: 'auto_approve', approvalMode: 'single' } },
        { key: 'lo', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u2'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e-start-route', source: 'start', target: 'route' },
        { key: 'e-hi', source: 'route', target: 'hi' },
        { key: 'e-lo', source: 'route', target: 'lo' },
        { key: 'e-hi-end', source: 'hi', target: 'end' },
        { key: 'e-lo-end', source: 'lo', target: 'end' },
      ],
    } as ApprovalGraph
    const normalized = assertApprovalGraph(graph)
    expect(() => validateApprovalTypePlacement(normalized)).not.toThrow()
  })
})

describe('Lock-4 F4-A gate A-2 — "an auto_approve node advances with reason auto-node-approve and resolves NO assignees; currentStep lands on the NEXT node\'s index, not the skipped one — asserting totalSteps unchanged proves nothing"', () => {
  it('auto_approve node with NO assignee sources at all: advances past it with NO resolver injected (assignment resolution is SKIPPED, not merely empty-tolerant)', () => {
    const runtimeGraph = toRuntimeGraph(twoStepGraph({ autoNodeConfig: { approvalType: 'auto_approve' } }))
    // Deliberately NO assignmentResolver option — if the executor called resolveAssignmentsForApprovalNode
    // for this node at all it would return [] (no injected resolver, no legacy assigneeIds) and hit the
    // (irrelevant) empty-assignee 400 path instead of short-circuiting. A green run here proves resolution
    // never ran for this node.
    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const initial = executor.resolveInitialState()

    expect(initial.status).toBe('pending')
    expect(initial.currentNodeKey).toBe('manual2')
    // The member-visible currentStep lands on manual2 (index 2 in approvalNodeOrder=[auto1,manual2]),
    // NOT on auto1 (index 1) — the node was skipped, not merely resolved-then-shown.
    expect(initial.currentStep).toBe(2)
    expect(initial.totalSteps).toBe(2) // never reads config — asserting this alone would prove nothing (A-2's own warning)
    expect(initial.assignments).toEqual([
      { assignmentType: 'user', assigneeId: 'user-2', nodeKey: 'manual2', sourceStep: 2 },
    ])
    expect(initial.autoApprovalEvents).toEqual([
      { nodeKey: 'auto1', sourceStep: 1, approvalMode: 'single', reason: 'auto-node-approve' },
    ])
  })

  it('NEGATIVE CONTROL — the identical graph with approvalType ABSENT (manual) holds PENDING at auto1 with currentStep on IT, and needs a real assignment resolver or it 400s empty — proving the short-circuit above is config-selected', () => {
    // auto1 needs a real assigneeSources shape here (unlike the auto_approve fixtures above) — a
    // 'manual' node with NO assignee sources is a structurally invalid config (isApprovalNodeConfig),
    // which is the correct, unrelated, byte-identical-legacy failure mode gate A-1's own control
    // above already covers at the publish layer; this control isolates the DISPATCH-side behavior.
    const runtimeGraph = toRuntimeGraph(twoStepGraph({ autoNodeConfig: { assigneeSources: [{ kind: 'static_user', userIds: ['user-1'] }] } }))
    const executor = new ApprovalGraphExecutor(runtimeGraph, {}, {
      assignmentResolver: ({ nodeKey, sourceStep }) => [{ assignmentType: 'user', assigneeId: 'user-1', nodeKey, sourceStep }],
    })
    const initial = executor.resolveInitialState()
    expect(initial.status).toBe('pending')
    expect(initial.currentNodeKey).toBe('auto1')
    expect(initial.currentStep).toBe(1)
    expect(initial.autoApprovalEvents).toEqual([])
  })

  it('an auto_approve node immediately before end resolves the whole instance to approved, carrying the auto-node-approve event', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'auto1', type: 'approval', config: { approvalType: 'auto_approve', approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'auto1' },
        { key: 'e2', source: 'auto1', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }
    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const initial = executor.resolveInitialState()
    expect(initial.status).toBe('approved')
    expect(initial.currentNodeKey).toBeNull()
    expect(initial.autoApprovalEvents).toEqual([
      { nodeKey: 'auto1', sourceStep: 1, approvalMode: 'single', reason: 'auto-node-approve' },
    ])
  })
})
