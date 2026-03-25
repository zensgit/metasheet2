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
    expect(buildApprovalInboxActionPayload('approve', '')).toEqual({})
    expect(buildApprovalInboxActionPayload('approve', '  looks good  ')).toEqual({
      comment: 'looks good',
    })
  })

  it('requires a reason for reject and maps it to both reason and comment', () => {
    expect(canSubmitApprovalInboxAction('reject', '   ')).toBe(false)
    expect(buildApprovalInboxActionPayload('reject', '   ')).toEqual({})
    expect(canSubmitApprovalInboxAction('reject', '  missing sign-off ')).toBe(true)
    expect(buildApprovalInboxActionPayload('reject', '  missing sign-off ')).toEqual({
      reason: 'missing sign-off',
      comment: 'missing sign-off',
    })
  })
})
