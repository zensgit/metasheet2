import { describe, expect, it } from 'vitest'
import type { ApprovalTemplateVersionDetailDTO } from '../src/types/approval'
import { diffApprovalTemplateVersions } from '../src/approvals/templateVersionDiff'

function version(overrides: Partial<ApprovalTemplateVersionDetailDTO> = {}): ApprovalTemplateVersionDetailDTO {
  return {
    id: 'v1',
    templateId: 'tpl-1',
    version: 1,
    status: 'draft',
    formSchema: {
      fields: [
        { id: 'amount', type: 'number', label: '金额', required: true },
        { id: 'reason', type: 'text', label: '原因' },
      ],
    },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approve', type: 'approval', name: '主管审批', config: { approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approve' },
        { key: 'e2', source: 'approve', target: 'end' },
      ],
    },
    runtimeGraph: null,
    publishedDefinitionId: null,
    publishNote: null,
    restoredFromVersionId: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  }
}

describe('approval template version diff', () => {
  it('reports field, node, and edge changes by stable identity', () => {
    const before = version()
    const after = version({
      formSchema: {
        fields: [
          { id: 'amount', type: 'number', label: '报销金额', required: true },
          { id: 'costCenter', type: 'text', label: '成本中心' },
        ],
      },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'approve', type: 'approval', name: '财务审批', config: { approvalMode: 'all' } },
          { key: 'cc', type: 'cc', name: '抄送财务', config: { targetType: 'role', targetIds: ['finance'] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approve' },
          { key: 'e2', source: 'approve', target: 'cc' },
          { key: 'e3', source: 'cc', target: 'end' },
        ],
      },
    })

    const diff = diffApprovalTemplateVersions(before, after)

    expect(diff).toMatchObject({ fieldChanges: 3, nodeChanges: 2, edgeChanges: 2, totalChanges: 7 })
    expect(diff.changes).toEqual(expect.arrayContaining([
      { kind: 'changed', entity: 'field', key: 'amount', label: '报销金额' },
      { kind: 'removed', entity: 'field', key: 'reason', label: '原因' },
      { kind: 'added', entity: 'field', key: 'costCenter', label: '成本中心' },
      { kind: 'changed', entity: 'node', key: 'approve', label: '财务审批' },
      { kind: 'added', entity: 'node', key: 'cc', label: '抄送财务' },
      { kind: 'changed', entity: 'edge', key: 'e2', label: 'approve -> cc' },
      { kind: 'added', entity: 'edge', key: 'e3', label: 'cc -> end' },
    ]))
  })

  it('treats field reordering as a visible change but ignores object-key order', () => {
    const before = version()
    const after = version({
      formSchema: { fields: [...before.formSchema.fields].reverse() },
      approvalGraph: {
        nodes: before.approvalGraph.nodes.map((node) => ({
          type: node.type,
          key: node.key,
          config: node.config,
          ...(node.name ? { name: node.name } : {}),
        })),
        edges: before.approvalGraph.edges,
      },
    })

    const diff = diffApprovalTemplateVersions(before, after)
    expect(diff.fieldChanges).toBe(2)
    expect(diff.nodeChanges).toBe(0)
    expect(diff.edgeChanges).toBe(0)
  })
})
