import { describe, expect, it } from 'vitest'

import { deriveRoutePreviewHighlight } from '../src/approvals/routePreviewHighlight'
import type { ApprovalGraph, FormSchema } from '../src/types/approval'

const schema: FormSchema = {
  fields: [
    { id: 'amount', type: 'number', label: '报销金额', required: true },
    {
      id: 'category',
      type: 'select',
      label: '费用类型',
      options: [{ label: '差旅', value: 'internal-travel-id' }],
    },
    { id: 'reviewer', type: 'user', label: '复核人' },
  ],
}

function route(nodeKey: string) {
  return { nodeKey, nodeLabel: nodeKey, assignees: [] }
}

describe('deriveRoutePreviewHighlight', () => {
  it('highlights only the uniquely proven condition path and describes matched/skipped branches', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: {} },
        {
          key: 'condition',
          type: 'condition',
          name: '金额判断',
          config: {
            branches: [{ edgeKey: 'high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }],
            defaultEdgeKey: 'low',
          },
        },
        { key: 'finance', type: 'approval', name: '财务审批', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
        { key: 'manager', type: 'approval', name: '主管审批', config: { assigneeType: 'user', assigneeIds: ['u2'] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'to-condition', source: 'start', target: 'condition' },
        { key: 'high', source: 'condition', target: 'finance' },
        { key: 'low', source: 'condition', target: 'manager' },
        { key: 'finance-end', source: 'finance', target: 'end' },
        { key: 'manager-end', source: 'manager', target: 'end' },
      ],
    }

    const result = deriveRoutePreviewHighlight(graph, [route('finance')], false, schema)
    expect([...result.nodeKeys].sort()).toEqual(['condition', 'end', 'finance', 'start'])
    expect([...result.edgeKeys].sort()).toEqual(['finance-end', 'high', 'to-condition'])
    expect(result.decisions).toEqual([{
      nodeKey: 'condition',
      nodeLabel: '金额判断',
      matched: '报销金额 ≥ 1000',
      skipped: ['默认分支'],
    }])
    expect(result.complete).toBe(true)
  })

  it('does not invent a decision when multiple branches reconverge on the same returned node', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'condition',
          type: 'condition',
          config: {
            branches: [{ edgeKey: 'yes', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }] }],
            defaultEdgeKey: 'no',
          },
        },
        { key: 'approval', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'start-condition', source: 'start', target: 'condition' },
        { key: 'yes', source: 'condition', target: 'approval' },
        { key: 'no', source: 'condition', target: 'approval' },
        { key: 'approval-end', source: 'approval', target: 'end' },
      ],
    }

    const result = deriveRoutePreviewHighlight(graph, [route('approval')], false, schema)
    expect(result.nodeKeys.has('approval')).toBe(true)
    expect(result.edgeKeys.has('yes')).toBe(false)
    expect(result.edgeKeys.has('no')).toBe(false)
    expect(result.decisions).toEqual([])
    expect(result.complete).toBe(false)
  })

  it('unions unique paths to parallel frontier nodes without treating sibling order as a path', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'parallel', type: 'parallel', config: { branches: ['left', 'right'], joinMode: 'all', joinNodeKey: 'end' } },
        { key: 'left-approval', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
        { key: 'right-approval', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u2'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'start-parallel', source: 'start', target: 'parallel' },
        { key: 'left', source: 'parallel', target: 'left-approval' },
        { key: 'right', source: 'parallel', target: 'right-approval' },
        { key: 'left-end', source: 'left-approval', target: 'end' },
        { key: 'right-end', source: 'right-approval', target: 'end' },
      ],
    }

    const result = deriveRoutePreviewHighlight(
      graph,
      [route('left-approval'), route('right-approval')],
      true,
      schema,
    )
    expect([...result.nodeKeys].sort()).toEqual([
      'left-approval',
      'parallel',
      'right-approval',
      'start',
    ])
    expect([...result.edgeKeys].sort()).toEqual(['left', 'right', 'start-parallel'])
    expect(result.complete).toBe(false)
  })

  it('uses configured option labels and never exposes select or user internal values', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'condition',
          type: 'condition',
          name: '安全标签',
          config: {
            branches: [{
              edgeKey: 'matched',
              conjunction: 'and',
              rules: [
                { fieldId: 'category', operator: 'eq', value: 'internal-travel-id' },
                { fieldId: 'reviewer', operator: 'eq', value: 'user-secret-id' },
              ],
            }],
            defaultEdgeKey: 'other',
          },
        },
        { key: 'approval', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
        { key: 'fallback', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u2'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'start-condition', source: 'start', target: 'condition' },
        { key: 'matched', source: 'condition', target: 'approval' },
        { key: 'other', source: 'condition', target: 'fallback' },
        { key: 'approval-end', source: 'approval', target: 'end' },
        { key: 'fallback-end', source: 'fallback', target: 'end' },
      ],
    }

    const result = deriveRoutePreviewHighlight(graph, [route('approval')], false, schema)
    const decision = result.decisions[0]!
    expect(decision.matched).toContain('费用类型 = 差旅')
    expect(decision.matched).toContain('复核人 = 已配置成员')
    expect(decision.matched).not.toContain('internal-travel-id')
    expect(decision.matched).not.toContain('user-secret-id')
  })
})
