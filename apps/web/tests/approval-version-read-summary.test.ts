import { describe, expect, it } from 'vitest'
import { buildApprovalVersionReadSummary } from '../src/approvals/approvalVersionReadSummary'
import { buildVersionGraphOverlay } from '../src/approvals/versionGraphOverlay'
import { diffApprovalTemplateVersions } from '../src/approvals/templateVersionDiff'
import type { ApprovalGraph } from '../src/types/approval'

const before: ApprovalGraph = {
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

const after: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'a1', type: 'approval', name: '总监', config: { approvalMode: 'all' } },
    { key: 'cc1', type: 'cc', name: '财务抄送', config: { targetType: 'role', targetIds: ['finance'] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'a1' },
    { key: 'e3', source: 'a1', target: 'cc1' },
    { key: 'e4', source: 'cc1', target: 'end' },
  ],
}

const form = {
  fields: [
    { id: 'title', type: 'text' as const, label: '标题', required: true },
  ],
}

describe('buildApprovalVersionReadSummary (D8-b thin)', () => {
  it('summarizes real diff + overlay without exposing raw keys as the headline', () => {
    const diff = diffApprovalTemplateVersions(
      { formSchema: form, approvalGraph: before },
      { formSchema: form, approvalGraph: after },
    )
    expect(diff.totalChanges).toBeGreaterThan(0)
    const overlay = buildVersionGraphOverlay(before, after, diff)
    const summary = buildApprovalVersionReadSummary(diff, overlay)
    expect(summary.totalChanges).toBe(diff.totalChanges)
    expect(summary.lines[0]).toMatch(/共 \d+ 处差异/)
    expect(summary.lines.some((line) => line.includes('总监') || line.includes('财务抄送'))).toBe(true)
    // Primary lines use business labels / 中文 entity names, not bare edge key dumps as the only text.
    expect(summary.overlay).not.toBeNull()
    expect(summary.overlay!.addedNodes).toBeGreaterThanOrEqual(1)
  })

  it('empty diff is a single no-diff line and null overlay tallies when omitted', () => {
    const empty = buildApprovalVersionReadSummary({
      changes: [],
      fieldChanges: 0,
      nodeChanges: 0,
      edgeChanges: 0,
      totalChanges: 0,
    })
    expect(empty.lines).toEqual(['与对照版本无差异'])
    expect(empty.overlay).toBeNull()
  })
})
