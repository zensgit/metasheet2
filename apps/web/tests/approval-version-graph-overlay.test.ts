import { describe, expect, it } from 'vitest'
import { computeLayout } from '../src/approvals/graphLayout'
import { buildVersionGraphOverlay } from '../src/approvals/versionGraphOverlay'
import type { ApprovalGraph } from '../src/types/approval'
import type { TemplateVersionDiff } from '../src/approvals/templateVersionDiff'

const before: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'removed', type: 'approval', name: '旧审批', config: { approvalMode: 'single' } },
    { key: 'changed', type: 'approval', name: '原审批', config: { approvalMode: 'single' } },
    { key: 'end', type: 'end', config: {} },
  ],
  edges: [
    { key: 'old-edge', source: 'start', target: 'removed' },
    { key: 'changed-edge', source: 'removed', target: 'changed' },
    { key: 'end-edge', source: 'changed', target: 'end' },
  ],
}

const after: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'changed', type: 'approval', name: '新审批', config: { approvalMode: 'all' } },
    { key: 'added', type: 'cc', name: '新增抄送', config: { targetType: 'role', targetIds: ['finance'] } },
    { key: 'end', type: 'end', config: {} },
  ],
  edges: [
    { key: 'changed-edge', source: 'start', target: 'changed' },
    { key: 'added-edge', source: 'changed', target: 'added' },
    { key: 'end-edge', source: 'added', target: 'end' },
  ],
}

const diff: TemplateVersionDiff = {
  changes: [
    { kind: 'removed', entity: 'node', key: 'removed', label: '旧审批' },
    { kind: 'changed', entity: 'node', key: 'changed', label: '新审批' },
    { kind: 'added', entity: 'node', key: 'added', label: '新增抄送' },
    { kind: 'removed', entity: 'edge', key: 'old-edge', label: 'start -> removed' },
    { kind: 'changed', entity: 'edge', key: 'changed-edge', label: 'start -> changed' },
    { kind: 'added', entity: 'edge', key: 'added-edge', label: 'changed -> added' },
  ],
  fieldChanges: 0,
  nodeChanges: 3,
  edgeChanges: 3,
  totalChanges: 6,
}

describe('approval version graph overlay', () => {
  it('keeps removed entities in the union and marks graph changes by stable key', () => {
    const overlay = buildVersionGraphOverlay(before, after, diff)
    expect(overlay.graph.nodes.map((node) => node.key)).toEqual(['start', 'changed', 'added', 'end', 'removed'])
    expect(overlay.graph.edges.map((edge) => edge.key)).toEqual(['changed-edge', 'added-edge', 'end-edge', 'old-edge'])
    expect(Object.fromEntries(overlay.nodeChanges)).toEqual({ removed: 'removed', changed: 'changed', added: 'added' })
    expect(Object.fromEntries(overlay.edgeChanges)).toEqual({
      'old-edge': 'removed',
      'changed-edge': 'changed',
      'added-edge': 'added',
    })
    expect(computeLayout(overlay.graph).nodes).toHaveLength(5)
  })

  it('does not invent badges for an empty diff', () => {
    const overlay = buildVersionGraphOverlay(after, after, {
      changes: [],
      fieldChanges: 0,
      nodeChanges: 0,
      edgeChanges: 0,
      totalChanges: 0,
    })
    expect(overlay.nodeChanges.size).toBe(0)
    expect(overlay.edgeChanges.size).toBe(0)
  })
})
