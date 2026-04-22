import { describe, expect, it } from 'vitest'
import { ApprovalGraphExecutor, validateApprovalFormData } from '../../src/services/ApprovalGraphExecutor'
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
})

describe('validateApprovalFormData', () => {
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
})
