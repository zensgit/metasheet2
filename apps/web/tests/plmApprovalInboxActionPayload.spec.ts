import { describe, expect, it } from 'vitest'
import {
  buildApprovalInboxActionPayload,
  canSubmitApprovalInboxAction,
  normalizeApprovalInboxComment,
} from '../src/views/approvalInboxActionPayload'

describe('plmApprovalInboxActionPayload', () => {
  it('normalizes comments before building inbox action payloads', () => {
    expect(normalizeApprovalInboxComment('  reject this change  ')).toBe('reject this change')
  })

  it('lets approve submit without a comment and keeps optional comments', () => {
    expect(canSubmitApprovalInboxAction('approve', '')).toBe(true)
    expect(buildApprovalInboxActionPayload('approve', '', 3)).toEqual({
      version: 3,
    })
    expect(buildApprovalInboxActionPayload('approve', '  looks good  ', 3)).toEqual({
      version: 3,
      comment: 'looks good',
    })
  })

  it('requires a reason for reject and maps it to both reason and comment', () => {
    expect(canSubmitApprovalInboxAction('reject', '   ')).toBe(false)
    expect(buildApprovalInboxActionPayload('reject', '   ', 4)).toEqual({
      version: 4,
    })
    expect(canSubmitApprovalInboxAction('reject', '  missing sign-off ')).toBe(true)
    expect(buildApprovalInboxActionPayload('reject', '  missing sign-off ', 4)).toEqual({
      version: 4,
      reason: 'missing sign-off',
      comment: 'missing sign-off',
    })
  })
})
