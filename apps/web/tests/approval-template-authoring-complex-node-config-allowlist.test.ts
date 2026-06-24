import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, ApprovalTemplateDetailDTO } from '../src/types/approval'
import { unsupportedTemplateAuthoringReason } from '../src/approvals/templateAuthoring'

// Follow-up to the G-5 approval-node fail-closed (#3124): the SAME backend silent-drop applies to
// cc / condition / parallel (and start/end) node configs. The backend `normalizeApprovalGraph`
// rebuilds each from a fixed per-type shape (ApprovalProductService.ts) and DROPS any other key —
// top-level OR nested (condition branches[].rules[]). `complexNodeConfigHasBackendDrop` now fails
// closed for EVERY node type, so an unknown key can't silently flatten on save while the FE
// deep-equal round-trip looks clean. Pure helper test (no .vue) → runs under approval-web-guard.

function tpl(approvalGraph: ApprovalGraph): ApprovalTemplateDetailDTO {
  return {
    id: 'tpl_1', key: 'k', name: 'n', description: null, category: null,
    visibilityScope: { type: 'all', ids: [] }, slaHours: null, status: 'draft',
    activeVersionId: null, latestVersionId: 'v1',
    createdAt: '2026-06-24T00:00:00Z', updatedAt: '2026-06-24T00:00:00Z',
    formSchema: { fields: [{ id: 'amount', type: 'number', label: '金额', required: true }] },
    approvalGraph,
  }
}
// start → [node] → end — the node's type (cc/condition/parallel) makes the graph complex (preserved path).
function reasonFor(node: { key: string; type: string; name?: string; config: Record<string, unknown> }): string | null {
  return unsupportedTemplateAuthoringReason(tpl({
    nodes: [
      { key: 'start', type: 'start', name: '发起', config: {} },
      node as never,
      { key: 'end', type: 'end', name: '结束', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: node.key },
      { key: 'e2', source: node.key, target: 'end' },
    ],
  }))
}

describe('complex node config fail-closed — cc (backend re-emits {targetType, targetIds})', () => {
  it('flags an unknown cc config key', () => {
    expect(reasonFor({ key: 'cc_1', type: 'cc', config: { targetType: 'role', targetIds: ['r1'], futureFlag: true } })).not.toBeNull()
  })
  it('allows a known cc config', () => {
    expect(reasonFor({ key: 'cc_1', type: 'cc', config: { targetType: 'role', targetIds: ['r1'] } })).toBeNull()
  })
})

describe('complex node config fail-closed — parallel (backend re-emits {branches, joinMode, joinNodeKey})', () => {
  it('flags an unknown parallel config key', () => {
    expect(reasonFor({ key: 'p1', type: 'parallel', config: { branches: ['a', 'b'], joinMode: 'all', joinNodeKey: 'j', futureFlag: true } })).not.toBeNull()
  })
  it('allows a known parallel config', () => {
    expect(reasonFor({ key: 'p1', type: 'parallel', config: { branches: ['a', 'b'], joinMode: 'all', joinNodeKey: 'j' } })).toBeNull()
  })
})

describe('complex node config fail-closed — condition (recurses config → branches[] → rules[])', () => {
  const cond = (branch: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    reasonFor({ key: 'c1', type: 'condition', config: { branches: [branch], defaultEdgeKey: 'd', ...top } })
  it('flags an unknown top-level condition key', () => {
    expect(cond({ edgeKey: 'e', rules: [] }, { futureFlag: true })).not.toBeNull()
  })
  it('flags an unknown branch key', () => {
    expect(cond({ edgeKey: 'e', rules: [], futureFlag: true })).not.toBeNull()
  })
  it('flags an unknown rule key', () => {
    expect(cond({ edgeKey: 'e', rules: [{ fieldId: 'amount', operator: 'gt', value: 1, futureFlag: true }] })).not.toBeNull()
  })
  it('allows a known condition (conjunction + a FREE-FORM rule value — value is a leaf, not shape-checked)', () => {
    expect(cond({ edgeKey: 'e', conjunction: 'and', rules: [{ fieldId: 'amount', operator: 'in', value: { complex: ['object', 'leaf'] } }] })).toBeNull()
  })
})

describe('complex node config fail-closed — start/end re-emit {} (any config key is dropped)', () => {
  it('flags a stray config key on a start node in a complex graph', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', name: '发起', config: { stray: true } as never },
        { key: 'cc_1', type: 'cc', name: '抄送', config: { targetType: 'role', targetIds: ['r1'] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [{ key: 'e1', source: 'start', target: 'cc_1' }, { key: 'e2', source: 'cc_1', target: 'end' }],
    }
    expect(unsupportedTemplateAuthoringReason(tpl(graph))).not.toBeNull()
  })
})
