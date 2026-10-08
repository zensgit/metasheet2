import { describe, expect, it } from 'vitest'
import { buildApprovalVersionDualCanvas } from '../src/approvals/approvalVersionDualCanvas'
import { buildVersionGraphOverlay } from '../src/approvals/versionGraphOverlay'
import { diffApprovalTemplateVersions } from '../src/approvals/templateVersionDiff'
import type { ApprovalGraph } from '../src/types/approval'

const empty: ApprovalGraph = { nodes: [], edges: [] }

const beforeLinear: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'a1', type: 'approval', name: '经理', config: { approvalMode: 'single' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'a1' },
    { key: 'e2', source: 'a1', target: 'end' },
  ],
}

const afterWithNode: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'a1', type: 'approval', name: '经理', config: { approvalMode: 'single' } },
    { key: 'cc1', type: 'cc', name: '财务抄送', config: { targetType: 'role', targetIds: ['finance'] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'a1' },
    { key: 'e3', source: 'a1', target: 'cc1' },
    { key: 'e4', source: 'cc1', target: 'end' },
  ],
}

const emptyForm = { fields: [] as [] }

describe('buildApprovalVersionDualCanvas (D8-b residual)', () => {
  it('handles empty / null graphs with dual titles and zero-size change maps', () => {
    const model = buildApprovalVersionDualCanvas(null, empty)
    expect(model.left.title).toBe('对照版本')
    expect(model.right.title).toBe('当前版本')
    expect(model.left.graph.nodes).toEqual([])
    expect(model.right.graph.nodes).toEqual([])
    expect(model.nodeChanges.size).toBe(0)
    expect(model.edgeChanges.size).toBe(0)
    expect(model.nodeChange('any')).toBeUndefined()
    expect(model.edgeChange('any')).toBeUndefined()
  })

  it('linear before/after node add surfaces change map via overlay', () => {
    const diff = diffApprovalTemplateVersions(
      { formSchema: emptyForm, approvalGraph: beforeLinear },
      { formSchema: emptyForm, approvalGraph: afterWithNode },
    )
    expect(diff.nodeChanges).toBeGreaterThanOrEqual(1)
    const overlay = buildVersionGraphOverlay(beforeLinear, afterWithNode, diff)
    const model = buildApprovalVersionDualCanvas(beforeLinear, afterWithNode, { overlay })

    expect(model.left.graph.nodes.map((n) => n.key)).toEqual(['start', 'a1', 'end'])
    expect(model.right.graph.nodes.map((n) => n.key)).toEqual(['start', 'a1', 'cc1', 'end'])
    expect(model.nodeChange('cc1')).toBe('added')
    // Removed edge from before should be marked when present in overlay maps
    expect(model.edgeChange('e2')).toBe('removed')
    expect(model.edgeChange('e3')).toBe('added')
    expect(model.edgeChange('e4')).toBe('added')
  })

  it('accepts explicit node/edge maps without overlay', () => {
    const nodeChanges = new Map([['cc1', 'added' as const]])
    const edgeChanges = new Map([['e3', 'added' as const]])
    const model = buildApprovalVersionDualCanvas(beforeLinear, afterWithNode, {
      nodeChanges,
      edgeChanges,
    })
    expect(model.nodeChange('cc1')).toBe('added')
    expect(model.edgeChange('e3')).toBe('added')
    expect(model.nodeChange('a1')).toBeUndefined()
  })

  it('layout widths are positive when graphs are non-empty', () => {
    const model = buildApprovalVersionDualCanvas(beforeLinear, afterWithNode)
    expect(model.left.layout.width).toBeGreaterThan(0)
    expect(model.right.layout.width).toBeGreaterThan(0)
    expect(model.left.layout.nodes.length).toBe(beforeLinear.nodes.length)
    expect(model.right.layout.nodes.length).toBe(afterWithNode.nodes.length)
    // Each laid-out node has finite coordinates
    for (const side of [model.left, model.right]) {
      for (const n of side.layout.nodes) {
        expect(Number.isFinite(n.x)).toBe(true)
        expect(Number.isFinite(n.y)).toBe(true)
      }
    }
  })
})
