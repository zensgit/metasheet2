import { describe, expect, it } from 'vitest'
import { ApprovalApiError } from '../src/approvals/api'
import { describeTemplateAuthoringError } from '../src/approvals/templateAuthoringErrors'

describe('describeTemplateAuthoringError', () => {
  it('maps topology and formula machine codes without echoing backend identifiers', () => {
    const cases = [
      ['APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT', '多个并行分支'],
      ['APPROVAL_CONDITION_BRANCH_RULES_EMPTY', '条件分支'],
      ['APPROVAL_CONDITION_FORMULA_STATIC', '条件公式'],
      ['APPROVAL_CONDITION_FORMULA_ALWAYS_TRUE', '其他情况'],
    ] as const
    for (const [code, expected] of cases) {
      const error = new ApprovalApiError('node fork_1 / field owner_secret', 400, code)
      const message = describeTemplateAuthoringError(error, '操作失败')
      expect(message).toContain(expected)
      expect(message).not.toContain('fork_1')
      expect(message).not.toContain('owner_secret')
    }
  })

  // T5b (test report 2026-10-08): two parallel branches sharing one approver — the copy names both
  // branches (and the gateway) by their business labels, taken from the values-free `details`.
  it('names both conflicting parallel branches from values-free details, never the keys or the backend message', () => {
    const labels: Record<string, string> = { fork_1: '会签', lane_a: '财务甲', lane_b: '财务乙' }
    const error = new ApprovalApiError(
      "approvalGraph parallel node fork_1 has duplicate approver 'finance' across branches",
      400,
      'VALIDATION_ERROR',
      { reason: 'parallel_duplicate_approver', nodeKey: 'fork_1', conflictingNodeKeys: ['lane_a', 'lane_b'] },
    )
    const message = describeTemplateAuthoringError(error, '保存表单失败', { nodeLabel: (key) => labels[key] })
    expect(message).toBe('并行分支「会签」中「财务甲」与「财务乙」的审批人相同，请为每个分支选择不同的审批人')
    for (const leaked of ['fork_1', 'lane_a', 'lane_b', 'finance', 'duplicate']) expect(message).not.toContain(leaked)
    // Without a resolver (or with an unknown key) the copy stays specific but unattributed.
    expect(describeTemplateAuthoringError(error, '保存表单失败')).toBe('并行分支中有两个分支的审批人相同，请为每个分支选择不同的审批人')
    expect(describeTemplateAuthoringError(error, '保存表单失败', { nodeLabel: () => undefined }))
      .toBe('并行分支中有两个分支的审批人相同，请为每个分支选择不同的审批人')
    // A resolver that would echo the key is ignored (values-free belt and braces).
    expect(describeTemplateAuthoringError(error, '保存表单失败', { nodeLabel: (key) => key })).not.toContain('lane_a')
  })

  it('attributes the publish-time placeholder and dynamic-conflict codes to their nodes when details name them', () => {
    const labels: Record<string, string> = { lane_2: '并行审批 2', a: '甲审批', b: '乙审批' }
    const nodeLabel = (key: string) => labels[key]
    expect(describeTemplateAuthoringError(
      new ApprovalApiError('x', 400, 'APPROVAL_ROLE_PLACEHOLDER_NOT_CONFIGURED', { nodeKey: 'lane_2' }),
      '发布表单失败',
      { nodeLabel },
    )).toBe('审批节点「并行审批 2」仍为占位审批角色，请先替换为真实审批人后再发布')
    expect(describeTemplateAuthoringError(
      new ApprovalApiError('x', 400, 'APPROVAL_ROLE_PLACEHOLDER_NOT_CONFIGURED'),
      '发布表单失败',
    )).toBe('仍有审批节点使用占位审批角色，请先替换为真实审批人后再发布')
    expect(describeTemplateAuthoringError(
      new ApprovalApiError('x', 400, 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT', { nodeKey: 'fork', conflictingNodeKeys: ['a', 'b'] }),
      '发布表单失败',
      { nodeLabel },
    )).toBe('并行分支中「甲审批」与「乙审批」的审批人可能重复，请调整审批人配置后重试')
  })

  // Gate r1 NIT-5: two nodes with the SAME business label (e.g. both lanes named after their node
  // type) would read 「审批」与「审批」 — attribution that names nothing. Such a pair falls back to the
  // unattributed copy; distinct labels keep the attributed copy (positive control).
  it('falls back to the unattributed copy when both conflicting nodes share one label', () => {
    const sameLabel = (key: string) => ({ fork_1: '会签', lane_a: '审批', lane_b: '审批' } as Record<string, string>)[key]
    expect(describeTemplateAuthoringError(
      new ApprovalApiError('x', 400, 'VALIDATION_ERROR', { reason: 'parallel_duplicate_approver', nodeKey: 'fork_1', conflictingNodeKeys: ['lane_a', 'lane_b'] }),
      '保存表单失败',
      { nodeLabel: sameLabel },
    )).toBe('并行分支中有两个分支的审批人相同，请为每个分支选择不同的审批人')
    expect(describeTemplateAuthoringError(
      new ApprovalApiError('x', 400, 'APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT', { nodeKey: 'fork_1', conflictingNodeKeys: ['lane_a', 'lane_b'] }),
      '发布表单失败',
      { nodeLabel: sameLabel },
    )).toBe('多个并行分支的审批人可能重复，请调整审批人配置后重试')
    const distinct = (key: string) => ({ fork_1: '会签', lane_a: '审批', lane_b: '复核' } as Record<string, string>)[key]
    expect(describeTemplateAuthoringError(
      new ApprovalApiError('x', 400, 'VALIDATION_ERROR', { reason: 'parallel_duplicate_approver', nodeKey: 'fork_1', conflictingNodeKeys: ['lane_a', 'lane_b'] }),
      '保存表单失败',
      { nodeLabel: distinct },
    )).toBe('并行分支「会签」中「审批」与「复核」的审批人相同，请为每个分支选择不同的审批人')
  })

  it('uses a values-free fallback for unknown API and local errors', () => {
    expect(describeTemplateAuthoringError(
      new ApprovalApiError('database host db.internal:5432', 500, 'UNKNOWN'),
      '保存表单失败',
    )).toBe('保存表单失败')
    expect(describeTemplateAuthoringError(new Error('raw local message'), '保存表单失败')).toBe('保存表单失败')
  })
})
