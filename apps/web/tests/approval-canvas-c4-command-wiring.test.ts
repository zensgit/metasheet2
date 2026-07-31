import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { executeApprovalCanvasCommand } from '../src/approvals/approvalCanvasCommands'
import type { ApprovalGraph, ConditionNodeConfig, ParallelNodeConfig } from '../src/types/approval'

const HERE = dirname(fileURLToPath(import.meta.url))
const AUTHORING_SOURCE = readFileSync(
  join(HERE, '../src/views/approval/TemplateAuthoringView.vue'),
  'utf8',
)
const RENDERER_SOURCE = readFileSync(
  join(HERE, '../src/approvals/components/ApprovalFlowCanvas.vue'),
  'utf8',
)

function linearGraph(): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 'Start', config: {} },
      { key: 'a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'b', type: 'cc', name: 'B', config: { targetType: 'role', targetIds: ['finance'] } },
      { key: 'c', type: 'approval', name: 'C', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'End', config: {} },
    ],
    edges: [
      { key: 'e-start-a', source: 'start', target: 'a' },
      { key: 'e-a-b', source: 'a', target: 'b' },
      { key: 'e-b-c', source: 'b', target: 'c' },
      { key: 'e-c-end', source: 'c', target: 'end' },
    ],
  }
}

function branchGraph(): ApprovalGraph {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 'Start', config: {} },
      {
        key: 'condition',
        type: 'condition',
        name: 'Condition',
        config: {
          branches: [
            { edgeKey: 'e-high', rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }], conjunction: 'and' },
            { edgeKey: 'e-low', rules: [{ fieldId: 'amount', operator: 'gte', value: 100 }], conjunction: 'and' },
          ],
          defaultEdgeKey: 'e-default',
        },
      },
      { key: 'high', type: 'approval', name: 'High', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'low', type: 'approval', name: 'Low', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'fallback', type: 'cc', name: 'Fallback', config: { targetType: 'role', targetIds: ['audit'] } },
      { key: 'merge', type: 'cc', name: 'Merge', config: { targetType: 'role', targetIds: ['finance'] } },
      { key: 'parallel', type: 'parallel', name: 'Parallel', config: { branches: ['e-left', 'e-right'], joinMode: 'all', joinNodeKey: 'join' } },
      { key: 'left', type: 'approval', name: 'Left', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'right', type: 'approval', name: 'Right', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'join', type: 'approval', name: 'Join', config: { assigneeSources: [{ kind: 'dept_head' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'End', config: {} },
    ],
    edges: [
      { key: 'e-start-condition', source: 'start', target: 'condition' },
      { key: 'e-high', source: 'condition', target: 'high' },
      { key: 'e-low', source: 'condition', target: 'low' },
      { key: 'e-default', source: 'condition', target: 'fallback' },
      { key: 'e-high-merge', source: 'high', target: 'merge' },
      { key: 'e-low-merge', source: 'low', target: 'merge' },
      { key: 'e-default-merge', source: 'fallback', target: 'merge' },
      { key: 'e-merge-parallel', source: 'merge', target: 'parallel' },
      { key: 'e-left', source: 'parallel', target: 'left' },
      { key: 'e-right', source: 'parallel', target: 'right' },
      { key: 'e-left-join', source: 'left', target: 'join' },
      { key: 'e-right-join', source: 'right', target: 'join' },
      { key: 'e-join-end', source: 'join', target: 'end' },
    ],
  }
}

describe('Canvas V2 C4 typed command wiring', () => {
  it('keeps one page-level command apply seam for node and both branch command kinds', () => {
    expect(AUTHORING_SOURCE.match(/executeApprovalCanvasCommand\(/g)).toHaveLength(1)
    expect(AUTHORING_SOURCE).toContain("type: 'move-node-into-edge'")
    expect(AUTHORING_SOURCE).toContain("type: 'reorder-condition-branches'")
    expect(AUTHORING_SOURCE).toContain("type: 'reorder-parallel-branches'")
    expect(AUTHORING_SOURCE).not.toMatch(/\bmoveLinearNode\s*\(/)
  })

  it('keeps the renderer intent-only and free of topology config rules', () => {
    expect(RENDERER_SOURCE).not.toMatch(
      /executeApprovalCanvasCommand|applyTopologyToDraft|linearNodeMoveTargets|ConditionNodeConfig|ParallelNodeConfig/,
    )
    expect(RENDERER_SOURCE).toContain("emit('move-target-drop'")
    expect(RENDERER_SOURCE).toContain("emit('branch-target-drop'")
    expect(RENDERER_SOURCE).toContain('aria-live="polite"')
  })

  it('executes node, condition, and parallel edits through the existing command algebra', () => {
    const move = executeApprovalCanvasCommand(linearGraph(), {
      type: 'move-node-into-edge',
      nodeKey: 'b',
      intoEdgeKey: 'e-start-a',
    })
    expect(move.ok).toBe(true)
    if (!move.ok) return
    expect(move.graph.edges).toEqual([
      { key: 'e-start-a', source: 'start', target: 'b' },
      { key: 'e-b-c', source: 'b', target: 'a' },
      { key: 'e-a-b', source: 'a', target: 'c' },
      { key: 'e-c-end', source: 'c', target: 'end' },
    ])

    const condition = executeApprovalCanvasCommand(branchGraph(), {
      type: 'reorder-condition-branches',
      conditionNodeKey: 'condition',
      orderedEdgeKeys: ['e-low', 'e-high'],
    })
    expect(condition.ok).toBe(true)
    if (!condition.ok) return
    const conditionNode = condition.graph.nodes.find((node) => node.key === 'condition')!
    expect((conditionNode.config as ConditionNodeConfig).branches.map((branch) => branch.edgeKey))
      .toEqual(['e-low', 'e-high'])
    expect((conditionNode.config as ConditionNodeConfig).defaultEdgeKey).toBe('e-default')

    const parallel = executeApprovalCanvasCommand(condition.graph, {
      type: 'reorder-parallel-branches',
      parallelNodeKey: 'parallel',
      orderedEdgeKeys: ['e-right', 'e-left'],
    })
    expect(parallel.ok).toBe(true)
    if (!parallel.ok) return
    expect((parallel.graph.nodes.find((node) => node.key === 'parallel')!.config as ParallelNodeConfig).branches)
      .toEqual(['e-right', 'e-left'])
  })
})
