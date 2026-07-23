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

  it('uses a values-free fallback for unknown API and local errors', () => {
    expect(describeTemplateAuthoringError(
      new ApprovalApiError('database host db.internal:5432', 500, 'UNKNOWN'),
      '保存模板失败',
    )).toBe('保存模板失败')
    expect(describeTemplateAuthoringError(new Error('raw local message'), '保存模板失败')).toBe('保存模板失败')
  })
})
