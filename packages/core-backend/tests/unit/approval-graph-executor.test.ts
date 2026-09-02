import { describe, expect, it } from 'vitest'
import {
  ApprovalGraphExecutor,
  canonicalizeRecordLinkFormData,
  isEmptyValue,
  pruneHiddenFormData,
  validateApprovalFormData,
} from '../../src/services/ApprovalGraphExecutor'
import { resolveApprovalAssignees } from '../../src/services/ApprovalAssigneeResolver'
import type { FormSchema, RuntimeGraph } from '../../src/types/approval-product'

describe('ApprovalGraphExecutor', () => {
  it('resolves the initial approval node after condition and cc nodes', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [
              {
                edgeKey: 'edge-security',
                rules: [{ fieldId: 'accessScope', operator: 'eq', value: 'tenant-admin' }],
              },
            ],
            defaultEdgeKey: 'edge-it',
          },
        },
        { key: 'notify', type: 'cc', config: { targetType: 'role', targetIds: ['ops'] } },
        { key: 'security-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['security'] } },
        { key: 'it-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-2'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-security', source: 'route', target: 'notify' },
        { key: 'edge-it', source: 'route', target: 'it-review' },
        { key: 'edge-notify-security', source: 'notify', target: 'security-review' },
        { key: 'edge-security-end', source: 'security-review', target: 'end' },
        { key: 'edge-it-end', source: 'it-review', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
      },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, { accessScope: 'tenant-admin' })
    const initial = executor.resolveInitialState()

    expect(initial.status).toBe('pending')
    expect(initial.currentNodeKey).toBe('security-review')
    expect(initial.currentStep).toBe(1)
    expect(initial.totalSteps).toBe(2)
    expect(initial.assignments).toEqual([
      {
        assignmentType: 'role',
        assigneeId: 'security',
        nodeKey: 'security-review',
        sourceStep: 1,
      },
    ])
    expect(initial.ccEvents).toEqual([
      {
        nodeKey: 'notify',
        targetType: 'role',
        targetId: 'ops',
      },
    ])
  })

  it('routes condition formula branches and keeps default as no-match only', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [
              {
                edgeKey: 'edge-high',
                rules: [],
                formula: { expression: 'SUM({items.amount}) >= 20000 AND {expense_type} == "travel"' },
              },
            ],
            defaultEdgeKey: 'edge-low',
          },
        },
        { key: 'high-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
        { key: 'low-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-high', source: 'route', target: 'high-review' },
        { key: 'edge-low', source: 'route', target: 'low-review' },
        { key: 'edge-high-end', source: 'high-review', target: 'end' },
        { key: 'edge-low-end', source: 'low-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const high = new ApprovalGraphExecutor(runtimeGraph, {
      expense_type: 'travel',
      items: [{ amount: 15000 }, { amount: 6000 }],
    }).resolveInitialState()
    expect(high.currentNodeKey).toBe('high-review')

    const low = new ApprovalGraphExecutor(runtimeGraph, {
      expense_type: 'office',
      items: [{ amount: 21000 }],
    }).resolveInitialState()
    expect(low.currentNodeKey).toBe('low-review')
  })

  it('fails closed on condition formula runtime errors instead of taking defaultEdgeKey', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'edge-high', rules: [], formula: { expression: '10 / {amount} > 1' } }],
            defaultEdgeKey: 'edge-low',
          },
        },
        { key: 'high-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
        { key: 'low-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-high', source: 'route', target: 'high-review' },
        { key: 'edge-low', source: 'route', target: 'low-review' },
        { key: 'edge-high-end', source: 'high-review', target: 'end' },
        { key: 'edge-low-end', source: 'low-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    expect(() => new ApprovalGraphExecutor(runtimeGraph, { amount: 0 }).resolveInitialState()).toThrow(/division by zero/)
  })

  it('skips a LEGACY empty-rules branch instead of match-all (defense-in-depth for stored graphs)', () => {
    // A rules-mode branch with `rules: []` is rejected at authoring/create/update/publish
    // (validateConditionBranchRules), but a graph STORED before that gate may still carry one.
    // `[].every(...)` is vacuously true — without the runtime guard the empty branch would capture
    // EVERY request (first-match-wins) and dead-code both the later branch and the default edge.
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [
              { edgeKey: 'edge-empty', rules: [] }, // legacy vacuous branch — must never match
              { edgeKey: 'edge-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] },
            ],
            defaultEdgeKey: 'edge-low',
          },
        },
        { key: 'empty-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['ghost'] } },
        { key: 'high-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
        { key: 'low-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-empty', source: 'route', target: 'empty-review' },
        { key: 'edge-high', source: 'route', target: 'high-review' },
        { key: 'edge-low', source: 'route', target: 'low-review' },
        { key: 'edge-empty-end', source: 'empty-review', target: 'end' },
        { key: 'edge-high-end', source: 'high-review', target: 'end' },
        { key: 'edge-low-end', source: 'low-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    // A matching request routes via the LATER, real branch — not the empty one.
    expect(new ApprovalGraphExecutor(runtimeGraph, { amount: 5000 }).resolveInitialState().currentNodeKey).toBe('high-review')
    // A non-matching request falls through to the default edge — the intended "else" mechanism.
    expect(new ApprovalGraphExecutor(runtimeGraph, { amount: 10 }).resolveInitialState().currentNodeKey).toBe('low-review')
  })

  it('rejects a LEGACY literal-only formula instead of silently taking another route', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [
              { edgeKey: 'edge-static', rules: [], formula: { expression: '1 == 1' } },
              { edgeKey: 'edge-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] },
            ],
            defaultEdgeKey: 'edge-low',
          },
        },
        { key: 'static-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['ghost'] } },
        { key: 'high-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
        { key: 'low-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-static', source: 'route', target: 'static-review' },
        { key: 'edge-high', source: 'route', target: 'high-review' },
        { key: 'edge-low', source: 'route', target: 'low-review' },
        { key: 'edge-static-end', source: 'static-review', target: 'end' },
        { key: 'edge-high-end', source: 'high-review', target: 'end' },
        { key: 'edge-low-end', source: 'low-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    expect(() => new ApprovalGraphExecutor(runtimeGraph, { amount: 5000 }).resolveInitialState()).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_CONDITION_FORMULA_CAPTURE_PRONE', statusCode: 409 }),
    )
  })

  it('rejects a LEGACY identity formula instead of masking missing data with the default route', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [
              { edgeKey: 'edge-identity', rules: [], formula: { expression: '{amount} == {amount}' } },
              { edgeKey: 'edge-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] },
            ],
            defaultEdgeKey: 'edge-low',
          },
        },
        { key: 'identity-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['ghost'] } },
        { key: 'high-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['senior'] } },
        { key: 'low-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-identity', source: 'route', target: 'identity-review' },
        { key: 'edge-high', source: 'route', target: 'high-review' },
        { key: 'edge-low', source: 'route', target: 'low-review' },
        { key: 'edge-identity-end', source: 'identity-review', target: 'end' },
        { key: 'edge-high-end', source: 'high-review', target: 'end' },
        { key: 'edge-low-end', source: 'low-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    expect(() => new ApprovalGraphExecutor(runtimeGraph, {}).resolveInitialState()).toThrowError(
      expect.objectContaining({ code: 'APPROVAL_CONDITION_FORMULA_CAPTURE_PRONE', statusCode: 409 }),
    )
  })

  it('routes a requester.department branch from threaded requesterContext, fail-closed on absent (RA-1a)', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'edge-fin', rules: [], formula: { expression: 'requester.department == "财务"' } }],
            defaultEdgeKey: 'edge-other',
          },
        },
        { key: 'fin-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['finance'] } },
        { key: 'other-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-fin', source: 'route', target: 'fin-review' },
        { key: 'edge-other', source: 'route', target: 'other-review' },
        { key: 'edge-fin-end', source: 'fin-review', target: 'end' },
        { key: 'edge-other-end', source: 'other-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    // match → finance branch, resolved from the frozen requester department (not formData)
    expect(new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: { department: '财务' } })
      .resolveInitialState().currentNodeKey).toBe('fin-review')
    // present-but-different → default edge (genuine no-match, not fail-closed)
    expect(new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: { department: '技术' } })
      .resolveInitialState().currentNodeKey).toBe('other-review')
    // absent context → FAIL-CLOSED throw, never silently take defaultEdgeKey (no phantom route)
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: null })
      .resolveInitialState()).toThrow(/context unavailable/)
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: {} })
      .resolveInitialState()).toThrow(/department is missing/)
    // 3rd arg omitted → requesterContext defaults null → fail-closed (covers paths that must thread it)
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {})
      .resolveInitialState()).toThrow(/context unavailable/)
  })

  it('routes a requester.title branch from threaded requesterContext, fail-closed on absent', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'edge-mgr', rules: [], formula: { expression: 'requester.title == "经理"' } }],
            defaultEdgeKey: 'edge-other',
          },
        },
        { key: 'mgr-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['manager'] } },
        { key: 'other-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-mgr', source: 'route', target: 'mgr-review' },
        { key: 'edge-other', source: 'route', target: 'other-review' },
        { key: 'edge-mgr-end', source: 'mgr-review', target: 'end' },
        { key: 'edge-other-end', source: 'other-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    // match → manager branch, resolved from the frozen requester title (not formData)
    expect(new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: { title: '经理' } })
      .resolveInitialState().currentNodeKey).toBe('mgr-review')
    // present-but-different → default edge (genuine no-match, not fail-closed)
    expect(new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: { title: '专员' } })
      .resolveInitialState().currentNodeKey).toBe('other-review')
    // absent context → FAIL-CLOSED throw, never silently take defaultEdgeKey (no phantom route)
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: null })
      .resolveInitialState()).toThrow(/context unavailable/)
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: {} })
      .resolveInitialState()).toThrow(/title is missing/)
    // 3rd arg omitted → requesterContext defaults null → fail-closed
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {})
      .resolveInitialState()).toThrow(/context unavailable/)
  })

  it('routes a requester.role membership branch from threaded requesterContext, fail-closed on absent', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'edge-fin', rules: [], formula: { expression: 'requester.role in ["finance_approver","admin"]' } }],
            defaultEdgeKey: 'edge-other',
          },
        },
        { key: 'fin-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['finance'] } },
        { key: 'other-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-fin', source: 'route', target: 'fin-review' },
        { key: 'edge-other', source: 'route', target: 'other-review' },
        { key: 'edge-fin-end', source: 'fin-review', target: 'end' },
        { key: 'edge-other-end', source: 'other-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    // match (intersection non-empty) → finance branch, resolved from the frozen role set (not formData)
    expect(new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: { roles: ['admin', 'eng'] } })
      .resolveInitialState().currentNodeKey).toBe('fin-review')
    // no-match (held roles disjoint from the literal set) → default edge (genuine no-match, not fail-closed)
    expect(new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: { roles: ['eng', 'sales'] } })
      .resolveInitialState().currentNodeKey).toBe('other-review')
    // absent context → FAIL-CLOSED throw, never silently take defaultEdgeKey (no phantom route)
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: null })
      .resolveInitialState()).toThrow(/context unavailable/)
    // null role set (read-throw / unresolved) → fail-closed throw
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: { roles: null } })
      .resolveInitialState()).toThrow(/roles are missing/)
    expect(() => new ApprovalGraphExecutor(runtimeGraph, {}, { requesterContext: {} })
      .resolveInitialState()).toThrow(/roles are missing/)
  })

  it('advances to approved when the next node is end', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'manager-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-1'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-manager', source: 'start', target: 'manager-review' },
        { key: 'edge-manager-end', source: 'manager-review', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
      },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const next = executor.resolveAfterApprove('manager-review')

    expect(next.status).toBe('approved')
    expect(next.currentNodeKey).toBeNull()
    expect(next.currentStep).toBe(1)
    expect(next.assignments).toEqual([])
  })

  it('evaluates date-only condition rules as comparable dates', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [
              {
                edgeKey: 'edge-sla',
                rules: [{ fieldId: 'requestedAt', operator: 'gte', value: '2026-04-11' }],
              },
            ],
            defaultEdgeKey: 'edge-standard',
          },
        },
        { key: 'sla-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['sla-reviewers'] } },
        { key: 'standard-review', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['standard-reviewers'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-sla', source: 'route', target: 'sla-review' },
        { key: 'edge-standard', source: 'route', target: 'standard-review' },
        { key: 'edge-sla-end', source: 'sla-review', target: 'end' },
        { key: 'edge-standard-end', source: 'standard-review', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
      },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, { requestedAt: '2026-04-11' })
    const initial = executor.resolveInitialState()

    expect(initial.currentNodeKey).toBe('sla-review')
    expect(initial.assignments).toEqual([
      {
        assignmentType: 'role',
        assigneeId: 'sla-reviewers',
        nodeKey: 'sla-review',
        sourceStep: 1,
      },
    ])
  })

  it('auto-approves empty approval nodes when the node policy allows it', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'review-gap',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: [],
            approvalMode: 'all',
            emptyAssigneePolicy: 'auto-approve',
          },
        },
        { key: 'final-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-9'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-gap', source: 'start', target: 'review-gap' },
        { key: 'edge-gap-final', source: 'review-gap', target: 'final-review' },
        { key: 'edge-final-end', source: 'final-review', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
      },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const initial = executor.resolveInitialState()

    expect(initial.currentNodeKey).toBe('final-review')
    expect(initial.currentStep).toBe(2)
    expect(initial.assignments).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'user-9',
        nodeKey: 'final-review',
        sourceStep: 2,
      },
    ])
    expect(initial.autoApprovalEvents).toEqual([
      {
        nodeKey: 'review-gap',
        sourceStep: 1,
        approvalMode: 'all',
        reason: 'empty-assignee',
      },
    ])
  })

  it('uses an injected resolver for assigneeSources nodes', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'dynamic-review', type: 'approval', config: { assigneeSources: [{ kind: 'requester' }] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-dynamic', source: 'start', target: 'dynamic-review' },
        { key: 'edge-dynamic-end', source: 'dynamic-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {}, {
      assignmentResolver: ({ nodeKey, sourceStep, config }) => [{
        assignmentType: 'user',
        assigneeId: `resolved-${config.assigneeSources?.[0]?.kind}`,
        nodeKey,
        sourceStep,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } },
      }],
    })

    expect(executor.resolveInitialState().assignments).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'resolved-requester',
        nodeKey: 'dynamic-review',
        sourceStep: 1,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } },
      },
    ])
  })

  it('lets empty dynamic resolution follow the existing empty-assignee policies', () => {
    const autoRuntimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'dynamic-gap',
          type: 'approval',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            emptyAssigneePolicy: 'auto-approve',
          },
        },
        { key: 'final-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-9'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-gap', source: 'start', target: 'dynamic-gap' },
        { key: 'edge-gap-final', source: 'dynamic-gap', target: 'final-review' },
        { key: 'edge-final-end', source: 'final-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const resolver = ({ nodeKey, sourceStep }: { nodeKey: string; sourceStep: number }) =>
      nodeKey === 'dynamic-gap'
        ? []
        : [{ assignmentType: 'user' as const, assigneeId: 'user-9', nodeKey, sourceStep }]
    const autoExecutor = new ApprovalGraphExecutor(autoRuntimeGraph, {}, { assignmentResolver: resolver })
    const initial = autoExecutor.resolveInitialState()

    expect(initial.currentNodeKey).toBe('final-review')
    expect(initial.autoApprovalEvents).toEqual([
      {
        nodeKey: 'dynamic-gap',
        sourceStep: 1,
        approvalMode: 'single',
        reason: 'empty-assignee',
      },
    ])

    const errorRuntimeGraph: RuntimeGraph = {
      ...autoRuntimeGraph,
      nodes: autoRuntimeGraph.nodes.map((node) =>
        node.key === 'dynamic-gap'
          ? { ...node, config: { assigneeSources: [{ kind: 'requester' }] } }
          : node),
    }
    const errorExecutor = new ApprovalGraphExecutor(errorRuntimeGraph, {}, { assignmentResolver: resolver })

    expect(() => errorExecutor.resolveInitialState()).toThrowError(expect.objectContaining({
      code: 'APPROVAL_ASSIGNEE_EMPTY',
      statusCode: 400,
    }))
  })

  // Lock-1 §K5-b: this is the REAL resolveApprovalAssignees wired into the REAL executor (not a
  // fake resolver returning `[]`) — the exact integration point the real-DB acceptance suite
  // exercises over real SQL (approval-dept-head-at-level.db.test.ts's out-of-range leg), run here
  // as a local, no-DB oracle for the SAME assertion: a `level` valid in contract but past the end
  // of the frozen deptHeadChainIds resolves EMPTY via the resolver's own positional slice, and the
  // executor's existing (unmodified) empty-assignee branching decides what happens next — never a
  // crash, never a silently-materialized assignee. Positive control pair, per §K5's own text
  // ("resolves EMPTY and falls to emptyAssigneePolicy, which is the shipped manager_at_level
  // behavior, unchanged"): 'error' throws APPROVAL_ASSIGNEE_EMPTY; 'auto-approve' auto-approves —
  // both are the SAME shipped emptyAssigneePolicy branch every other kind already goes through.
  it('Lock-1 §K5-b: dept_head_at_level level past the end of the frozen deptHeadChainIds resolves EMPTY through the REAL resolver, and the executor applies the node emptyAssigneePolicy (error throws APPROVAL_ASSIGNEE_EMPTY; auto-approve auto-approves) — never a crash, never a silent assignee', () => {
    const requesterSnapshot = { id: 'requester-1', deptHeadChainIds: ['head-1', 'head-2'] }
    const realResolver = ({ nodeKey, sourceStep, config }: { nodeKey: string; sourceStep: number; config: any }) =>
      resolveApprovalAssignees({ nodeKey, sourceStep, config, formSnapshot: {}, requesterSnapshot })

    const outOfRangeGraph = (emptyAssigneePolicy: 'error' | 'auto-approve'): RuntimeGraph => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'dhal-oor',
          type: 'approval',
          config: {
            assigneeSources: [{ kind: 'dept_head_at_level', level: 5 }],
            emptyAssigneePolicy,
          },
        },
        { key: 'final-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-9'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-oor', source: 'start', target: 'dhal-oor' },
        { key: 'edge-oor-final', source: 'dhal-oor', target: 'final-review' },
        { key: 'edge-final-end', source: 'final-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    })

    // Positive control FIRST: an IN-RANGE level resolves a real assignee through the SAME real
    // resolver + executor wiring (proves the fixture itself is capable of a non-empty result —
    // the out-of-range legs below are not vacuously empty because of a broken fixture).
    const inRangeExecutor = new ApprovalGraphExecutor(
      { ...outOfRangeGraph('error'), nodes: outOfRangeGraph('error').nodes.map((n) => n.key === 'dhal-oor' ? { ...n, config: { assigneeSources: [{ kind: 'dept_head_at_level', level: 1 }], emptyAssigneePolicy: 'error' } } : n) },
      {},
      { assignmentResolver: realResolver },
    )
    expect(inRangeExecutor.resolveInitialState().assignments).toEqual([
      { assignmentType: 'user', assigneeId: 'head-1', nodeKey: 'dhal-oor', sourceStep: 1, metadata: { resolvedFrom: { kind: 'dept_head_at_level', sourceIndex: 0 } } },
    ])

    // 'error': out-of-range level (5) against a 2-entry chain -> empty resolution -> throws.
    const errorExecutor = new ApprovalGraphExecutor(outOfRangeGraph('error'), {}, { assignmentResolver: realResolver })
    expect(() => errorExecutor.resolveInitialState()).toThrowError(expect.objectContaining({
      code: 'APPROVAL_ASSIGNEE_EMPTY',
      statusCode: 400,
    }))

    // 'auto-approve': the SAME empty resolution, but the node's own policy governs — the shipped,
    // unmodified `emptyAssigneePolicy: 'auto-approve'` branch fires (never a silent NOBODY: it is
    // an EXPLICIT, audited autoApprovalEvents entry, not an unassigned pending node).
    const autoExecutor = new ApprovalGraphExecutor(outOfRangeGraph('auto-approve'), {}, { assignmentResolver: realResolver })
    const autoInitial = autoExecutor.resolveInitialState()
    expect(autoInitial.currentNodeKey).toBe('final-review')
    expect(autoInitial.autoApprovalEvents).toEqual([
      { nodeKey: 'dhal-oor', sourceStep: 1, approvalMode: 'single', reason: 'empty-assignee' },
    ])
  })

  it('Lock-2 §L2-C: a form-field contact extension whose FROZEN entry is empty resolves EMPTY through the REAL resolver, and the executor applies the node emptyAssigneePolicy (error throws APPROVAL_ASSIGNEE_EMPTY; auto-approve fires an AUDITED auto-approval) — never a crash, never a silent assignee', () => {
    // Frozen map: level 1 resolved a manager; level 5 ran at create and resolved NOBODY (chain
    // shorter than the level) — frozen as an EMPTY entry, the §2.6 empty-resolution shape.
    const requesterSnapshot = {
      id: 'requester-1',
      fieldDerivedAssigneeIds: {
        'form_field_user_manager:contact:1': ['contact-mgr-1'],
        'form_field_user_manager:contact:5': [],
      },
    }
    const realResolver = ({ nodeKey, sourceStep, config }: { nodeKey: string; sourceStep: number; config: any }) =>
      resolveApprovalAssignees({ nodeKey, sourceStep, config, formSnapshot: { contact: 'contact-1' }, requesterSnapshot })

    const contactGraph = (level: number, emptyAssigneePolicy: 'error' | 'auto-approve'): RuntimeGraph => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'ffum-node',
          type: 'approval',
          config: {
            assigneeSources: [{ kind: 'form_field_user_manager', fieldId: 'contact', level }],
            emptyAssigneePolicy,
          },
        },
        { key: 'final-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-9'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-ffum', source: 'start', target: 'ffum-node' },
        { key: 'edge-ffum-final', source: 'ffum-node', target: 'final-review' },
        { key: 'edge-final-end', source: 'final-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    })

    // Positive control FIRST: the frozen level-1 entry resolves a real assignee through the SAME
    // real resolver + executor wiring, with the Lock-2 §2.6 audit metadata (fieldId + level).
    const okExecutor = new ApprovalGraphExecutor(contactGraph(1, 'error'), { contact: 'contact-1' }, { assignmentResolver: realResolver })
    expect(okExecutor.resolveInitialState().assignments).toEqual([
      { assignmentType: 'user', assigneeId: 'contact-mgr-1', nodeKey: 'ffum-node', sourceStep: 1, metadata: { resolvedFrom: { kind: 'form_field_user_manager', sourceIndex: 0, fieldId: 'contact', level: 1 } } },
    ])

    // 'error' (the absent default): the frozen-empty entry -> empty resolution -> fail-closed 400.
    const errorExecutor = new ApprovalGraphExecutor(contactGraph(5, 'error'), { contact: 'contact-1' }, { assignmentResolver: realResolver })
    expect(() => errorExecutor.resolveInitialState()).toThrowError(expect.objectContaining({
      code: 'APPROVAL_ASSIGNEE_EMPTY',
      statusCode: 400,
    }))

    // 'auto-approve': the SAME empty resolution under the author-selected policy — an EXPLICIT,
    // audited autoApprovalEvents entry (NEVER-NOBODY: no unassigned pending node, no silent skip).
    const autoExecutor = new ApprovalGraphExecutor(contactGraph(5, 'auto-approve'), { contact: 'contact-1' }, { assignmentResolver: realResolver })
    const autoInitial = autoExecutor.resolveInitialState()
    expect(autoInitial.currentNodeKey).toBe('final-review')
    expect(autoInitial.autoApprovalEvents).toEqual([
      { nodeKey: 'ffum-node', sourceStep: 1, approvalMode: 'single', reason: 'empty-assignee' },
    ])
  })

  // ── Lock-1 §K6 precondition (landed by the K3 slice): normalizeApprovalMode fails CLOSED ──
  // The executor's mode normalizer previously mapped ANY unrecognized mode silently to 'single'
  // (fail-open). Contract-valid data never reached that arm (the authoring choke + the stored-graph
  // re-normalize both reject unknown modes), but deploy skew / rollback around a future mode would
  // degrade it silently to first-approver-wins. These tests pin the closure:
  // the MUTATION "revert normalizeApprovalMode to fail-open" must red the first test below.
  it('fails CLOSED: an unrecognized approvalMode reaching the executor throws APPROVAL_MODE_UNSUPPORTED instead of running as single (G-14 arm; mutation: revert to fail-open reds THIS test)', () => {
    const unknownModeGraph = (approvalMode: unknown): RuntimeGraph => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'skewed',
          type: 'approval',
          // Hand-crafted config — the exact deploy-skew shape: a graph published by NEWER code
          // carrying a mode THIS executor does not know. Bypasses the authoring choke on purpose.
          config: { assigneeType: 'user', assigneeIds: ['approver-a', 'approver-b'], approvalMode: approvalMode as never },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-skewed', source: 'start', target: 'skewed' },
        { key: 'edge-skewed-end', source: 'skewed', target: 'end' },
      ],
      policy: { allowRevoke: true },
    })

    for (const unknown of ['SINGLE', 'or_sign', null, 42]) {
      const executor = new ApprovalGraphExecutor(unknownModeGraph(unknown), {})
      // Accessor path (getApprovalMode) and resolution path (resolveInitialState) both fail
      // closed — under the OLD fail-open arm both would have run the node as 'single'.
      expect(() => executor.getApprovalMode('skewed'), JSON.stringify(unknown)).toThrowError(expect.objectContaining({
        code: 'APPROVAL_MODE_UNSUPPORTED',
        statusCode: 400,
      }))
      expect(() => executor.resolveInitialState(), JSON.stringify(unknown)).toThrowError(expect.objectContaining({
        code: 'APPROVAL_MODE_UNSUPPORTED',
      }))
    }
    // Values-free: the error names the node key (template-authored — permitted), never the raw
    // unknown value (which could be arbitrary junk).
    try {
      new ApprovalGraphExecutor(unknownModeGraph('or_sign'), {}).getApprovalMode('skewed')
      expect.unreachable('getApprovalMode must throw for an unknown mode')
    } catch (error) {
      expect((error as Error).message).toContain('skewed')
      expect((error as Error).message).not.toContain('or_sign')
    }
  })

  it('positive controls per mode: every LEGITIMATE shipped approvalMode — absent (≡ single), single, all, any, threshold, sequential — still executes (G-14)', () => {
    const modeGraph = (config: Record<string, unknown>): RuntimeGraph => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'node-m', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['approver-a', 'approver-b'], ...config } as never },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-m', source: 'start', target: 'node-m' },
        { key: 'edge-m-end', source: 'node-m', target: 'end' },
      ],
      policy: { allowRevoke: true },
    })

    // Absent → the documented 'single' default (the ONE legitimate non-member input).
    const absentExecutor = new ApprovalGraphExecutor(modeGraph({}), {})
    expect(absentExecutor.getApprovalMode('node-m')).toBe('single')
    expect(absentExecutor.resolveInitialState().assignments).toHaveLength(2)

    for (const mode of ['single', 'all', 'any'] as const) {
      const executor = new ApprovalGraphExecutor(modeGraph({ approvalMode: mode }), {})
      expect(executor.getApprovalMode('node-m')).toBe(mode)
      expect(executor.resolveInitialState().assignments).toHaveLength(2)
    }
    // threshold needs its approvalThreshold to pass assertThresholdReachable.
    const thresholdExecutor = new ApprovalGraphExecutor(modeGraph({ approvalMode: 'threshold', approvalThreshold: 2 }), {})
    expect(thresholdExecutor.getApprovalMode('node-m')).toBe('threshold')
    expect(thresholdExecutor.resolveInitialState().assignments).toHaveLength(2)

    const sequentialExecutor = new ApprovalGraphExecutor(modeGraph({ approvalMode: 'sequential' }), {})
    expect(sequentialExecutor.getApprovalMode('node-m')).toBe('sequential')
    expect(sequentialExecutor.resolveInitialState().assignments).toEqual([
      expect.objectContaining({
        assigneeId: 'approver-a',
        metadata: { sequentialQueue: { position: 1, length: 2, state: 'active' } },
      }),
      expect.objectContaining({
        assigneeId: 'approver-b',
        metadata: { sequentialQueue: { position: 2, length: 2, state: 'queued' } },
      }),
    ])
  })

  it('sequential order follows assigneeSources order, resolver emission order, and first-occurrence dedup', () => {
    const graph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'ordered',
          type: 'approval',
          config: {
            assigneeSources: [
              { kind: 'static_user', userIds: ['u-b', 'u-a'] },
              { kind: 'static_user', userIds: ['u-a', 'u-c'] },
            ],
            approvalMode: 'sequential',
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'start-ordered', source: 'start', target: 'ordered' },
        { key: 'ordered-end', source: 'ordered', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }
    const executor = new ApprovalGraphExecutor(graph, {}, {
      assignmentResolver: ({ nodeKey, sourceStep, config }) => resolveApprovalAssignees({
        nodeKey,
        sourceStep,
        config,
        formSnapshot: {},
        requesterSnapshot: { id: 'requester' },
      }),
    })
    expect(executor.resolveInitialState().assignments.map((assignment) => ({
      id: assignment.assigneeId,
      queue: assignment.metadata?.sequentialQueue,
    }))).toEqual([
      { id: 'u-b', queue: { position: 1, length: 3, state: 'active' } },
      { id: 'u-a', queue: { position: 2, length: 3, state: 'queued' } },
      { id: 'u-c', queue: { position: 3, length: 3, state: 'queued' } },
    ])
  })

  // ── Lock-1 §K3 prior_node_approver — REAL resolver + REAL executor oracle ──
  // The same no-DB wiring precedent as the §K5-b test above: the REAL resolveApprovalAssignees
  // (not a fake returning []) inside the REAL executor, the exact integration point the real-DB
  // suite drives over SQL. The map is CALLER-supplied (the §2.1 contract): the test plays the
  // caller's role exactly as dispatchAction does after reading audit rows.
  it('Lock-1 §K3: a prior_node_approver node activated after the referenced node resolves that node ACTUAL deciders from the caller-supplied map; an absent/empty map falls to emptyAssigneePolicy (error throws APPROVAL_ASSIGNEE_EMPTY; auto-approve is an explicit audited event — never a silent nobody)', () => {
    const k3Graph = (emptyAssigneePolicy: 'error' | 'auto-approve'): RuntimeGraph => ({
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'gate', type: 'approval', config: { assigneeSources: [{ kind: 'static_user', userIds: ['approver-1'] }] } },
        { key: 'again', type: 'approval', config: { assigneeSources: [{ kind: 'prior_node_approver', nodeKey: 'gate' }], emptyAssigneePolicy } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-gate', source: 'start', target: 'gate' },
        { key: 'edge-gate-again', source: 'gate', target: 'again' },
        { key: 'edge-again-end', source: 'again', target: 'end' },
      ],
      policy: { allowRevoke: true },
    })
    const resolverWith = (priorNodeApprovers?: Record<string, string[]>) =>
      ({ nodeKey, sourceStep, config }: { nodeKey: string; sourceStep: number; config: never }) =>
        resolveApprovalAssignees({
          nodeKey,
          sourceStep,
          config,
          formSnapshot: {},
          requesterSnapshot: { id: 'requester-1' },
          ...(priorNodeApprovers !== undefined ? { priorNodeApprovers } : {}),
        })

    // Happy path (positive control FIRST): gate approved by approver-1 → the caller (playing
    // dispatchAction's role) supplies { gate: ['approver-1'] } → 'again' assigns approver-1 with
    // the §2.6 audit trail (resolvedFrom.priorNodeKey).
    const happyExecutor = new ApprovalGraphExecutor(k3Graph('error'), {}, { assignmentResolver: resolverWith({ gate: ['approver-1'] }) as never })
    const advanced = happyExecutor.resolveAfterApprove('gate')
    expect(advanced.currentNodeKey).toBe('again')
    expect(advanced.assignments).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'approver-1',
        nodeKey: 'again',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'prior_node_approver', sourceIndex: 0, priorNodeKey: 'gate' } },
      },
    ])

    // 'error' + no map (skipped/unreached/sentinel-only referenced round): fail-closed throw.
    const errorExecutor = new ApprovalGraphExecutor(k3Graph('error'), {}, { assignmentResolver: resolverWith(undefined) as never })
    expect(() => errorExecutor.resolveAfterApprove('gate')).toThrowError(expect.objectContaining({
      code: 'APPROVAL_ASSIGNEE_EMPTY',
      statusCode: 400,
    }))

    // 'auto-approve' + sentinel-only map: the drop leaves nothing and the node's OWN policy fires
    // an EXPLICIT audited auto-approval event (OD-L1-4(a)) — never a silently-materialized
    // assignee, never an unassigned pending node.
    const autoExecutor = new ApprovalGraphExecutor(k3Graph('auto-approve'), {}, { assignmentResolver: resolverWith({ gate: ['system:auto-approval'] }) as never })
    const autoAdvanced = autoExecutor.resolveAfterApprove('gate')
    expect(autoAdvanced.status).toBe('approved')
    expect(autoAdvanced.autoApprovalEvents).toEqual([
      { nodeKey: 'again', sourceStep: 2, approvalMode: 'single', reason: 'empty-assignee' },
    ])
  })

  it('tags resolveAfterApprove resolutions with the resolved-away node aggregate mode', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'any_review',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: ['approver-a', 'approver-b'],
            approvalMode: 'any',
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-any', source: 'start', target: 'any_review' },
        { key: 'edge-any-end', source: 'any_review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})

    const initial = executor.resolveInitialState()
    expect(initial.aggregateMode).toBeNull()
    expect(initial.aggregateComplete).toBe(false)
    expect(executor.getApprovalMode('any_review')).toBe('any')
    expect(executor.getApprovalNodeAssigneeIds('any_review')).toEqual(['approver-a', 'approver-b'])

    const completed = executor.resolveAfterApprove('any_review')
    expect(completed.status).toBe('approved')
    expect(completed.aggregateMode).toBe('any')
    expect(completed.aggregateComplete).toBe(true)
  })

  it('lists the visited approval nodes for return validation on the active path', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [
              {
                edgeKey: 'edge-fast',
                rules: [{ fieldId: 'amount', operator: 'lte', value: 1000 }],
              },
            ],
            defaultEdgeKey: 'edge-slow',
          },
        },
        { key: 'manager-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-1'] } },
        { key: 'director-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-2'] } },
        { key: 'finance-review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-3'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-fast', source: 'route', target: 'manager-review' },
        { key: 'edge-slow', source: 'route', target: 'director-review' },
        { key: 'edge-manager-finance', source: 'manager-review', target: 'finance-review' },
        { key: 'edge-director-finance', source: 'director-review', target: 'finance-review' },
        { key: 'edge-finance-end', source: 'finance-review', target: 'end' },
      ],
      policy: {
        allowRevoke: true,
      },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, { amount: 2000 })

    expect(executor.listVisitedApprovalNodeKeysUntil('finance-review')).toEqual([
      'director-review',
      'finance-review',
    ])
  })

  it('forks a parallel gateway into per-branch assignments and emits a parallelState', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'parallel_fork',
          type: 'parallel',
          config: {
            branches: ['edge-fork-a', 'edge-fork-b'],
            joinMode: 'all',
            joinNodeKey: 'finance-review',
          },
        },
        {
          key: 'legal-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['legal-1'] },
        },
        {
          key: 'compliance-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['compliance-1'] },
        },
        {
          key: 'finance-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['finance-1'] },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
        { key: 'edge-fork-a', source: 'parallel_fork', target: 'legal-review' },
        { key: 'edge-fork-b', source: 'parallel_fork', target: 'compliance-review' },
        { key: 'edge-a-join', source: 'legal-review', target: 'finance-review' },
        { key: 'edge-b-join', source: 'compliance-review', target: 'finance-review' },
        { key: 'edge-finance-end', source: 'finance-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const initial = executor.resolveInitialState()

    expect(initial.status).toBe('pending')
    expect(initial.currentNodeKey).toBe('parallel_fork')
    expect([...(initial.currentNodeKeys || [])].sort()).toEqual([
      'compliance-review',
      'legal-review',
    ])
    expect(initial.assignments.map((a) => ({ assigneeId: a.assigneeId, nodeKey: a.nodeKey })).sort((x, y) => x.assigneeId.localeCompare(y.assigneeId))).toEqual([
      { assigneeId: 'compliance-1', nodeKey: 'compliance-review' },
      { assigneeId: 'legal-1', nodeKey: 'legal-review' },
    ])
    expect(initial.parallelState).toBeDefined()
    expect(initial.parallelState!.parallelNodeKey).toBe('parallel_fork')
    expect(initial.parallelState!.joinNodeKey).toBe('finance-review')
    expect(initial.parallelState!.joinMode).toBe('all')
    const branchStates = initial.parallelState!.branches
    expect(branchStates['edge-fork-a']).toEqual({
      edgeKey: 'edge-fork-a',
      currentNodeKey: 'legal-review',
      complete: false,
    })
    expect(branchStates['edge-fork-b']).toEqual({
      edgeKey: 'edge-fork-b',
      currentNodeKey: 'compliance-review',
      complete: false,
    })
  })

  it('keeps the instance pending when one parallel branch approves and the other is still active', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'parallel_fork',
          type: 'parallel',
          config: {
            branches: ['edge-fork-a', 'edge-fork-b'],
            joinMode: 'all',
            joinNodeKey: 'finance-review',
          },
        },
        {
          key: 'legal-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['legal-1'] },
        },
        {
          key: 'compliance-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['compliance-1'] },
        },
        {
          key: 'finance-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['finance-1'] },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
        { key: 'edge-fork-a', source: 'parallel_fork', target: 'legal-review' },
        { key: 'edge-fork-b', source: 'parallel_fork', target: 'compliance-review' },
        { key: 'edge-a-join', source: 'legal-review', target: 'finance-review' },
        { key: 'edge-b-join', source: 'compliance-review', target: 'finance-review' },
        { key: 'edge-finance-end', source: 'finance-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const initial = executor.resolveInitialState()

    const afterLegal = executor.resolveAfterApproveInParallel('legal-review', initial.parallelState!)
    expect(afterLegal.status).toBe('pending')
    expect(afterLegal.currentNodeKey).toBe('parallel_fork')
    expect(afterLegal.currentNodeKeys).toEqual(['compliance-review'])
    expect(afterLegal.assignments).toEqual([])
    expect(afterLegal.parallelState!.branches['edge-fork-a']).toEqual({
      edgeKey: 'edge-fork-a',
      currentNodeKey: null,
      complete: true,
    })
    expect(afterLegal.parallelState!.branches['edge-fork-b']).toEqual({
      edgeKey: 'edge-fork-b',
      currentNodeKey: 'compliance-review',
      complete: false,
    })

    const afterCompliance = executor.resolveAfterApproveInParallel('compliance-review', afterLegal.parallelState!)
    expect(afterCompliance.status).toBe('pending')
    expect(afterCompliance.currentNodeKey).toBe('finance-review')
    expect(afterCompliance.currentNodeKeys).toBeUndefined()
    expect(afterCompliance.assignments).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'finance-1',
        nodeKey: 'finance-review',
        sourceStep: 3,
      },
    ])
  })

  it('advances past the join when one joinMode=any branch reaches the join', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'parallel_fork',
          type: 'parallel',
          config: {
            branches: ['edge-fork-a', 'edge-fork-b'],
            joinMode: 'any',
            joinNodeKey: 'finance-review',
          },
        },
        {
          key: 'legal-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['legal-1'] },
        },
        {
          key: 'compliance-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['compliance-1'] },
        },
        {
          key: 'finance-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['finance-1'] },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-fork', source: 'start', target: 'parallel_fork' },
        { key: 'edge-fork-a', source: 'parallel_fork', target: 'legal-review' },
        { key: 'edge-fork-b', source: 'parallel_fork', target: 'compliance-review' },
        { key: 'edge-a-join', source: 'legal-review', target: 'finance-review' },
        { key: 'edge-b-join', source: 'compliance-review', target: 'finance-review' },
        { key: 'edge-finance-end', source: 'finance-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const initial = executor.resolveInitialState()

    expect(initial.currentNodeKey).toBe('parallel_fork')
    expect(initial.parallelState!.joinMode).toBe('any')
    expect([...(initial.currentNodeKeys || [])].sort()).toEqual([
      'compliance-review',
      'legal-review',
    ])

    const afterLegal = executor.resolveAfterApproveInParallel('legal-review', initial.parallelState!)
    expect(afterLegal.status).toBe('pending')
    expect(afterLegal.currentNodeKey).toBe('finance-review')
    expect(afterLegal.currentNodeKeys).toBeUndefined()
    expect(afterLegal.parallelState!.branches['edge-fork-a']).toEqual({
      edgeKey: 'edge-fork-a',
      currentNodeKey: null,
      complete: true,
    })
    expect(afterLegal.parallelState!.branches['edge-fork-b']).toEqual({
      edgeKey: 'edge-fork-b',
      currentNodeKey: 'compliance-review',
      complete: false,
    })
    expect(afterLegal.assignments).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'finance-1',
        nodeKey: 'finance-review',
        sourceStep: 3,
      },
    ])
  })

  it('preserves pre-parallel events when a joinMode=any branch auto-completes during fanout', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'notify-before-fork', type: 'cc', config: { targetType: 'role', targetIds: ['ops'] } },
        {
          key: 'parallel_fork',
          type: 'parallel',
          config: {
            branches: ['edge-fork-auto', 'edge-fork-pending'],
            joinMode: 'any',
            joinNodeKey: 'finance-review',
          },
        },
        {
          key: 'auto-review',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: [],
            approvalMode: 'all',
            emptyAssigneePolicy: 'auto-approve',
          },
        },
        {
          key: 'compliance-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['compliance-1'] },
        },
        {
          key: 'finance-review',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: ['finance-1'] },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-notify', source: 'start', target: 'notify-before-fork' },
        { key: 'edge-notify-fork', source: 'notify-before-fork', target: 'parallel_fork' },
        { key: 'edge-fork-auto', source: 'parallel_fork', target: 'auto-review' },
        { key: 'edge-fork-pending', source: 'parallel_fork', target: 'compliance-review' },
        { key: 'edge-auto-join', source: 'auto-review', target: 'finance-review' },
        { key: 'edge-pending-join', source: 'compliance-review', target: 'finance-review' },
        { key: 'edge-finance-end', source: 'finance-review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const initial = executor.resolveInitialState()

    expect(initial.status).toBe('pending')
    expect(initial.currentNodeKey).toBe('finance-review')
    expect(initial.parallelState).toBeUndefined()
    expect(initial.assignments).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'finance-1',
        nodeKey: 'finance-review',
        sourceStep: 3,
      },
    ])
    expect(initial.ccEvents).toEqual([
      {
        nodeKey: 'notify-before-fork',
        targetType: 'role',
        targetId: 'ops',
      },
    ])
    expect(initial.autoApprovalEvents).toEqual([
      {
        nodeKey: 'auto-review',
        sourceStep: 1,
        approvalMode: 'all',
        reason: 'empty-assignee',
      },
    ])
  })

  it('throws instead of looping when the main path forms a pure cc cycle', () => {
    // Two cc nodes pointing at each other with no approval/parallel/end node in
    // the loop. Before the cycle guard this spun resolveFromNode forever and
    // hung the worker at instance creation; it must now fail fast.
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'notify-a', type: 'cc', config: { targetType: 'role', targetIds: ['ops'] } },
        { key: 'notify-b', type: 'cc', config: { targetType: 'role', targetIds: ['it'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-a', source: 'start', target: 'notify-a' },
        { key: 'edge-a-b', source: 'notify-a', target: 'notify-b' },
        { key: 'edge-b-a', source: 'notify-b', target: 'notify-a' },
      ],
      policy: { allowRevoke: true },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    expect(() => executor.resolveInitialState()).toThrowError(/cycle near/)
  })

  it('throws instead of looping when a condition routes back into a cc cycle (latent trigger)', () => {
    // The cycle hides behind a condition branch, so most submissions resolve
    // normally and only a specific form value routes into the loop — the nasty
    // case that survives casual review. The guard must catch it at runtime.
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'route',
          type: 'condition',
          config: {
            branches: [
              { edgeKey: 'edge-loop', rules: [{ fieldId: 'kind', operator: 'eq', value: 'cyclic' }] },
            ],
            defaultEdgeKey: 'edge-normal',
          },
        },
        { key: 'review', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-1'] } },
        { key: 'notify', type: 'cc', config: { targetType: 'role', targetIds: ['ops'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-route', source: 'start', target: 'route' },
        { key: 'edge-normal', source: 'route', target: 'review' },
        { key: 'edge-loop', source: 'route', target: 'notify' },
        { key: 'edge-notify-route', source: 'notify', target: 'route' },
        { key: 'edge-review-end', source: 'review', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    // Normal form data resolves to the approval node as usual.
    expect(new ApprovalGraphExecutor(runtimeGraph, { kind: 'normal' }).resolveInitialState().currentNodeKey)
      .toBe('review')
    // The cyclic branch fails fast rather than hanging.
    expect(() => new ApprovalGraphExecutor(runtimeGraph, { kind: 'cyclic' }).resolveInitialState())
      .toThrowError(/cycle near/)
  })
})

// Lock-7B §0.2 / G-11 (docs/development/approval-lock7b-required-at-node-20260820.md) — the ONE
// type-agnostic emptiness predicate `isEmptyValue`, exported so the required-at-node handler-submit
// check (ApprovalProductService.ts) reuses it VERBATIM rather than minting a second definition. Each
// EMPTY arm is asserted individually (per-arm mutation target: deleting any ONE disjunct from
// `isEmptyValue`'s source must red exactly the matching `it` below and no other EMPTY-arm test) and
// each disclosed NON-empty hole is asserted individually too, so an arm's own positive/negative pair
// discriminates it from every other arm.
describe('isEmptyValue (Lock-7B §0.2 / G-11) — the create-time definition, reused verbatim at the node', () => {
  it('EMPTY arm: the empty string', () => {
    expect(isEmptyValue('')).toBe(true)
  })
  it('EMPTY arm: null', () => {
    expect(isEmptyValue(null)).toBe(true)
  })
  it('EMPTY arm: undefined (the absent-key case at both create and the node)', () => {
    expect(isEmptyValue(undefined)).toBe(true)
  })
  it('EMPTY arm: an empty array', () => {
    expect(isEmptyValue([])).toBe(true)
  })
  it('disclosed NON-empty hole: the number 0', () => {
    expect(isEmptyValue(0)).toBe(false)
  })
  it('disclosed NON-empty hole: the boolean false', () => {
    expect(isEmptyValue(false)).toBe(false)
  })
  it('disclosed NON-empty hole: a whitespace-only string', () => {
    expect(isEmptyValue('   ')).toBe(false)
  })
  it('disclosed NON-empty hole: an empty object {}', () => {
    expect(isEmptyValue({})).toBe(false)
  })
  it('disclosed NON-empty hole: a NON-empty array', () => {
    expect(isEmptyValue(['x'])).toBe(false)
  })
  it('disclosed NON-empty hole: a non-blank string', () => {
    expect(isEmptyValue('x')).toBe(false)
  })
})

describe('validateApprovalFormData', () => {
  test('number fields reject unsafe integers instead of freezing a rounded snapshot value', () => {
    const schema = { fields: [{ id: 'amount', type: 'number', label: 'Amount' }] } as never
    expect(validateApprovalFormData(schema, { amount: 9007199254740993 }))
      .toEqual(['amount must be a lossless number'])
    expect(validateApprovalFormData(schema, { amount: Number.MAX_SAFE_INTEGER })).toEqual([])
  })

  it('keeps the pre-feature attachment contract while the runtime flag is OFF', () => {
    const schema: FormSchema = { fields: [{ id: 'files', type: 'attachment', label: 'Files' }] }
    expect(validateApprovalFormData(schema, { files: 'legacy-file-reference' })).toEqual([])
    expect(validateApprovalFormData(schema, { files: ['att_new'] }))
      .toEqual(['files must be a string'])
  })

  it('accepts only staged attachment-id arrays in the enabled attachment mode', () => {
    const schema: FormSchema = { fields: [{ id: 'files', type: 'attachment', label: 'Files' }] }
    expect(validateApprovalFormData(schema, { files: ['att_a', 'att_b'] }, { attachmentValueMode: 'ids' }))
      .toEqual([])
    expect(validateApprovalFormData(schema, { files: 'legacy-file-reference' }, { attachmentValueMode: 'ids' }))
      .toEqual(['files must be an array of attachment ids'])
  })

  it('detail-leaf attachment: legacy-valid while OFF; top-level-only enforced when ON (both controls)', () => {
    // A historical/frozen schema that somehow carries attachment inside a detail group.
    const schema: FormSchema = {
      fields: [{
        id: 'items',
        type: 'detail',
        label: '明细',
        columns: [
          { id: 'name', type: 'text', label: 'name' },
          { id: 'proof', type: 'attachment', label: 'proof' },
        ],
      }],
    }
    // Flag OFF / legacy: detail-leaf attachment values remain legacy-valid (string/record).
    expect(validateApprovalFormData(schema, {
      items: [{ name: 'row', proof: 'legacy-file-reference' }],
    })).toEqual([])
    // Flag ON / ids: top-level-only control rejects attachment leaves inside detail.
    const on = validateApprovalFormData(schema, {
      items: [{ name: 'row', proof: ['att_1'] }],
    }, { attachmentValueMode: 'ids' })
    expect(on).toContain('items.proof attachment fields are not allowed inside detail rows')
  })

  it('reports required, type, and option errors', () => {
    const formSchema: FormSchema = {
      fields: [
        { id: 'reason', type: 'textarea', label: 'Reason', required: true },
        { id: 'amount', type: 'number', label: 'Amount', required: true },
        {
          id: 'type',
          type: 'select',
          label: 'Type',
          options: [
            { label: 'Purchase', value: 'purchase' },
            { label: 'Travel', value: 'travel' },
          ],
        },
      ],
    }

    const errors = validateApprovalFormData(formSchema, {
      amount: 'not-a-number',
      type: 'unsupported',
    })

    expect(errors).toEqual([
      'reason is required',
      'amount must be a number',
      'type must be one of the configured options',
    ])
  })

  it('skips hidden required fields when their visibility rule is not satisfied', () => {
    const formSchema: FormSchema = {
      fields: [
        {
          id: 'showDetails',
          type: 'select',
          label: 'Show Details',
          required: true,
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ],
        },
        {
          id: 'details',
          type: 'textarea',
          label: 'Details',
          required: true,
          visibilityRule: {
            fieldId: 'showDetails',
            operator: 'eq',
            value: 'yes',
          },
        },
      ],
    }

    const errors = validateApprovalFormData(formSchema, {
      showDetails: 'no',
    })

    expect(errors).toEqual([])
  })

  it('supports simple visibility operators for visible fields', () => {
    const formSchema: FormSchema = {
      fields: [
        {
          id: 'selector',
          type: 'select',
          label: 'Selector',
          required: true,
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
        },
        {
          id: 'dependentText',
          type: 'text',
          label: 'Dependent Text',
          visibilityRule: {
            fieldId: 'selector',
            operator: 'in',
            values: ['a', 'b'],
          },
        },
        {
          id: 'emptyOnly',
          type: 'text',
          label: 'Empty Only',
          visibilityRule: {
            fieldId: 'dependentText',
            operator: 'isEmpty',
          },
        },
      ],
    }

    const visibleErrors = validateApprovalFormData(formSchema, {
      selector: 'a',
      dependentText: 'hello',
    })
    expect(visibleErrors).toEqual([])

    const hiddenErrors = validateApprovalFormData(formSchema, {
      selector: 'a',
      dependentText: 'hello',
      emptyOnly: 'should-not-be-validated',
    })
    expect(hiddenErrors).toEqual([])
  })

  it('enforces pattern, length, numeric, and date window constraints from field props', () => {
    const formSchema: FormSchema = {
      fields: [
        {
          id: 'ticketCode',
          type: 'text',
          label: 'Ticket Code',
          required: true,
          props: {
            minLength: 6,
            maxLength: 12,
            pattern: '^REQ-[0-9]+$',
          },
        },
        {
          id: 'amount',
          type: 'number',
          label: 'Amount',
          props: {
            min: 100,
            max: 500,
          },
        },
        {
          id: 'requestedAt',
          type: 'date',
          label: 'Requested At',
          props: {
            min: '2026-04-10',
            max: '2026-04-12',
          },
        },
      ],
    }

    const errors = validateApprovalFormData(formSchema, {
      ticketCode: 'REQ',
      amount: 50,
      requestedAt: '2026-04-09',
    })

    expect(errors).toEqual([
      'ticketCode must be at least 6 characters',
      'ticketCode does not match the required pattern',
      'amount must be at least 100',
      'requestedAt must be on or after 2026-04-10',
    ])
  })

  it('date fields accept ONLY a strict real-calendar YYYY-MM-DD string (floating civil date)', () => {
    const schema: FormSchema = { fields: [{ id: 'due', type: 'date', label: 'Due' }] }
    // Accepts real calendar dates, leap-year validated — never via Date.parse.
    expect(validateApprovalFormData(schema, { due: '2026-07-15' })).toEqual([])
    expect(validateApprovalFormData(schema, { due: '2024-02-29' })).toEqual([])
    expect(validateApprovalFormData(schema, { due: '2000-02-29' })).toEqual([])
    // Rejects impossible dates, datetime strings, locale strings, epoch numbers, Date
    // objects, and surrounding-whitespace variants (the form transport does not trim).
    const rejected: Array<[string, unknown]> = [
      ['non-leap Feb 29', '2026-02-29'],
      ['century non-leap Feb 29', '1900-02-29'],
      ['April 31', '2026-04-31'],
      ['month 13', '2026-13-01'],
      ['ISO datetime', '2026-07-15T10:00:00Z'],
      ['datetime with offset', '2026-07-15T23:30:00+08:00'],
      ['space-separated datetime', '2026-07-15 10:00:00'],
      ['locale string', '7/15/2026'],
      ['epoch-ms number', Date.UTC(2026, 6, 15)],
      ['Date object', new Date(Date.UTC(2026, 6, 15))],
      ['left whitespace', ' 2026-07-15'],
      ['right whitespace', '2026-07-15 '],
      ['single-digit month', '2026-7-15'],
      ['year zero', '0000-01-01'],
    ]
    for (const [label, value] of rejected) {
      expect(validateApprovalFormData(schema, { due: value }), label)
        .toEqual(['due must be a date value'])
    }
  })

  it('datetime fields keep instant semantics (positive control — unchanged behavior)', () => {
    const schema: FormSchema = { fields: [{ id: 'meet', type: 'datetime', label: 'Meet' }] }
    expect(validateApprovalFormData(schema, { meet: '2026-07-15T10:00:00Z' })).toEqual([])
    expect(validateApprovalFormData(schema, { meet: '2026-07-15 10:00:00' })).toEqual([])
    expect(validateApprovalFormData(schema, { meet: '2026-07-15' })).toEqual([])
    expect(validateApprovalFormData(schema, { meet: new Date(Date.UTC(2026, 6, 15)) })).toEqual([])
    expect(validateApprovalFormData(schema, { meet: 'not-a-date' }))
      .toEqual(['meet must be a date value'])
    expect(validateApprovalFormData(schema, { meet: 1752573600000 }))
      .toEqual(['meet must be a date value'])
  })

  it('date min/max compares validated YYYY-MM-DD calendar strings directly (timezone-stable)', () => {
    const schema: FormSchema = {
      fields: [{
        id: 'due',
        type: 'date',
        label: 'Due',
        props: { min: '2026-04-10', max: '2026-04-12' },
      }],
    }
    // Boundaries are inclusive and identical in every timezone (pure string comparison —
    // an epoch-converting mutation reds this under TZ=America/Los_Angeles / Asia/Taipei).
    expect(validateApprovalFormData(schema, { due: '2026-04-10' })).toEqual([])
    expect(validateApprovalFormData(schema, { due: '2026-04-12' })).toEqual([])
    expect(validateApprovalFormData(schema, { due: '2026-04-11' })).toEqual([])
    expect(validateApprovalFormData(schema, { due: '2026-04-09' }))
      .toEqual(['due must be on or after 2026-04-10'])
    expect(validateApprovalFormData(schema, { due: '2026-04-13' }))
      .toEqual(['due must be on or before 2026-04-12'])
  })

  it('datetime min/max keeps instant semantics (positive control — unchanged behavior)', () => {
    const schema: FormSchema = {
      fields: [{
        id: 'meet',
        type: 'datetime',
        label: 'Meet',
        props: { min: '2026-04-10T00:00:00Z', max: '2026-04-12T00:00:00Z' },
      }],
    }
    expect(validateApprovalFormData(schema, { meet: '2026-04-10T00:00:00Z' })).toEqual([])
    expect(validateApprovalFormData(schema, { meet: '2026-04-11T12:00:00Z' })).toEqual([])
    expect(validateApprovalFormData(schema, { meet: '2026-04-09T23:59:59Z' }))
      .toEqual(['meet must be on or after 2026-04-10T00:00:00Z'])
    expect(validateApprovalFormData(schema, { meet: '2026-04-12T00:00:01Z' }))
      .toEqual(['meet must be on or before 2026-04-12T00:00:00Z'])
  })

  // P1-B 加签 — buildAddSignAssignments returns one active user row per target
  // id at the current node, stamped {addedBy, addSign:true} and deliberately
  // carrying NO resolvedFrom (so it reads as a static, non-resolver assignment).
  it('buildAddSignAssignments stamps add-signed co-signers at the current node', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-1'] } },
        { key: 'approval_2', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-2'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-1', source: 'start', target: 'approval_1' },
        { key: 'edge-1-2', source: 'approval_1', target: 'approval_2' },
        { key: 'edge-2-end', source: 'approval_2', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }

    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    const rows = executor.buildAddSignAssignments('approval_2', ['user-9', 'user-10'], 'user-2')

    // approval_2 is the 2nd approval node → stepIndexForNode = index(1) + 1 = 2.
    expect(rows).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'user-9',
        nodeKey: 'approval_2',
        sourceStep: 2,
        metadata: { addedBy: 'user-2', addSign: true },
      },
      {
        assignmentType: 'user',
        assigneeId: 'user-10',
        nodeKey: 'approval_2',
        sourceStep: 2,
        metadata: { addedBy: 'user-2', addSign: true },
      },
    ])
    // No resolvedFrom — the dynamic-resolution discriminator stays absent.
    for (const row of rows) {
      expect('resolvedFrom' in row.metadata).toBe(false)
    }
  })

  it('buildAddSignAssignments returns an empty array for no targets', () => {
    const runtimeGraph: RuntimeGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user-1'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'edge-start-1', source: 'start', target: 'approval_1' },
        { key: 'edge-1-end', source: 'approval_1', target: 'end' },
      ],
      policy: { allowRevoke: true },
    }
    const executor = new ApprovalGraphExecutor(runtimeGraph, {})
    expect(executor.buildAddSignAssignments('approval_1', [], 'user-1')).toEqual([])
  })
})

describe('validateApprovalFormData — detail (明细) rows (C-2)', () => {
  const detailSchema: FormSchema = {
    fields: [
      {
        id: 'items', type: 'detail', label: '明细', required: true, minRows: 1, maxRows: 3,
        columns: [
          { id: 'product', type: 'text', label: '品名', required: true },
          { id: 'qty', type: 'number', label: '数量', required: true },
          // required, but only visible (hence only required) when product === 'special'
          { id: 'note', type: 'text', label: '备注', required: true, visibilityRule: { fieldId: 'product', operator: 'eq', value: 'special' } },
        ],
      },
    ],
  }

  it('accepts valid rows', () => {
    expect(validateApprovalFormData(detailSchema, { items: [{ product: 'A', qty: 2 }] })).toEqual([])
  })

  it('row-addresses a missing required cell', () => {
    expect(validateApprovalFormData(detailSchema, { items: [{ product: 'A' }] })).toEqual(['items[0].qty is required'])
  })

  it('row-addresses a wrong cell type', () => {
    expect(validateApprovalFormData(detailSchema, { items: [{ product: 'A', qty: 'two' }] })).toEqual(['items[0].qty must be a number'])
  })

  it('enforces maxRows (non-empty, too many)', () => {
    expect(validateApprovalFormData(detailSchema, {
      items: [{ product: 'a', qty: 1 }, { product: 'b', qty: 1 }, { product: 'c', qty: 1 }, { product: 'd', qty: 1 }],
    })).toContain('items allows at most 3 row(s)')
  })

  it('enforces minRows (a non-empty array below the floor; an empty required detail is "required" instead)', () => {
    // a required+empty detail is caught by the required check first (empty array = empty value)
    expect(validateApprovalFormData(detailSchema, { items: [] })).toEqual(['items is required'])
    // minRows is the meaningful floor for non-empty arrays: minRows 2, one row
    const minSchema: FormSchema = { fields: [{ id: 'items', type: 'detail', label: '明细', minRows: 2, columns: [{ id: 'x', type: 'text', label: 'x' }] }] }
    expect(validateApprovalFormData(minSchema, { items: [{ x: 'a' }] })).toContain('items requires at least 2 row(s)')
  })

  it('rejects a non-array detail value', () => {
    expect(validateApprovalFormData(detailSchema, { items: 'nope' })).toEqual(['items must be a list'])
  })

  it('applies per-row visibility: a hidden required sub-field is not required, but required when visible', () => {
    expect(validateApprovalFormData(detailSchema, { items: [{ product: 'A', qty: 1 }] })).toEqual([])
    expect(validateApprovalFormData(detailSchema, { items: [{ product: 'special', qty: 1 }] })).toEqual(['items[0].note is required'])
  })
})

describe('validateApprovalFormData — record-link value shape (FWB-0 Layer 2)', () => {
  const schema: FormSchema = {
    fields: [{
      id: 'linked',
      type: 'record-link',
      label: '关联记录',
      required: true,
      props: { baseId: 'base_a', sheetId: 'sheet_a' },
    }],
  }

  it('accepts exactly one { recordId: non-blank string }', () => {
    expect(validateApprovalFormData(schema, { linked: { recordId: 'rec_1' } })).toEqual([])
    expect(validateApprovalFormData(schema, { linked: { recordId: '  rec_2  ' } })).toEqual([])
  })

  it('rejects arrays, free-text, empty id, and extra target overrides (fail-closed)', () => {
    expect(validateApprovalFormData(schema, { linked: 'rec_1' })).toEqual([
      'linked must be exactly { recordId } (single non-blank string; no free-text id, no multi-value)',
    ])
    expect(validateApprovalFormData(schema, { linked: ['rec_1'] })).toEqual([
      'linked must be exactly { recordId } (single non-blank string; no free-text id, no multi-value)',
    ])
    expect(validateApprovalFormData(schema, { linked: { recordId: '' } })).toEqual([
      'linked must be exactly { recordId } (single non-blank string; no free-text id, no multi-value)',
    ])
    expect(validateApprovalFormData(schema, { linked: { recordId: 'a', sheetId: 'override' } })).toEqual([
      'linked must be exactly { recordId } (single non-blank string; no free-text id, no multi-value)',
    ])
    expect(validateApprovalFormData(schema, { linked: { recordIds: ['a', 'b'] } })).toEqual([
      'linked must be exactly { recordId } (single non-blank string; no free-text id, no multi-value)',
    ])
  })

  it('required empty still surfaces required (not a type error)', () => {
    expect(validateApprovalFormData(schema, {})).toEqual(['linked is required'])
  })
})

describe('canonicalizeRecordLinkFormData — FWB-0 Layer 2', () => {
  it('rewrites padded recordId to the exact trimmed canonical object in-place', () => {
    const schema: FormSchema = {
      fields: [
        {
          id: 'linked',
          type: 'record-link',
          label: '关联',
          props: { baseId: 'b', sheetId: 's' },
        },
        { id: 'reason', type: 'text', label: '事由' },
      ],
    }
    const formData: Record<string, unknown> = {
      linked: { recordId: '  rec-1  ' },
      reason: 'keep',
    }
    canonicalizeRecordLinkFormData(schema, formData)
    expect(formData.linked).toEqual({ recordId: 'rec-1' })
    expect(formData.reason).toBe('keep')
  })

  it('does not loosen structural validation — invalid shapes stay untouched', () => {
    const schema: FormSchema = {
      fields: [{
        id: 'linked',
        type: 'record-link',
        label: '关联',
        props: { baseId: 'b', sheetId: 's' },
      }],
    }
    const invalid: Record<string, unknown> = {
      linked: { recordId: 'a', sheetId: 'smuggle' },
    }
    canonicalizeRecordLinkFormData(schema, invalid)
    expect(invalid.linked).toEqual({ recordId: 'a', sheetId: 'smuggle' })
  })
})

describe('pruneHiddenFormData — detail (明细) per-row cells (C-2)', () => {
  const schema: FormSchema = {
    fields: [
      {
        id: 'items', type: 'detail', label: '明细',
        columns: [
          { id: 'product', type: 'text', label: '品名' },
          { id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'product', operator: 'eq', value: 'special' } },
        ],
      },
    ],
  }

  it('drops hidden cells per row and unknown sub-keys, keeps visible cells', () => {
    expect(pruneHiddenFormData(schema, {
      items: [
        { product: 'A', note: 'drop-me', evil: 'x' },
        { product: 'special', note: 'keep' },
      ],
    })).toEqual({
      items: [
        { product: 'A' },
        { product: 'special', note: 'keep' },
      ],
    })
  })
})
