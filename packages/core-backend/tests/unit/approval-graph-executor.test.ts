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
})
