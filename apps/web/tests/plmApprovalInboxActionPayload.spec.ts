import { describe, expect, it } from 'vitest'
import {
  buildApprovalInboxActionPayload,
  canActOnApprovalInboxEntry,
  canSubmitApprovalInboxAction,
  formatApprovalInboxVersion,
  normalizeApprovalInboxComment,
  resolveApprovalActionVersion,
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

  it('resolves optimistic-lock versions from numeric and string payloads', () => {
    expect(resolveApprovalActionVersion({ version: 3 })).toBe(3)
    expect(resolveApprovalActionVersion({ version: '4' })).toBe(4)
    expect(resolveApprovalActionVersion({ version: ' 5 ' })).toBe(5)
    expect(resolveApprovalActionVersion({ version: '' })).toBeNull()
    expect(resolveApprovalActionVersion({ version: -1 })).toBeNull()
    expect(resolveApprovalActionVersion({ version: 'NaN' })).toBeNull()
    expect(resolveApprovalActionVersion(null)).toBeNull()
  })

  it('formats inbox versions and actionability from the resolved optimistic-lock version', () => {
    expect(formatApprovalInboxVersion({ version: 3 })).toBe('3')
    expect(formatApprovalInboxVersion({ version: ' 4 ' })).toBe('4')
    expect(formatApprovalInboxVersion({ version: '' })).toBe('-')
    expect(canActOnApprovalInboxEntry({ version: 3 })).toBe(true)
    expect(canActOnApprovalInboxEntry({ version: ' 4 ' })).toBe(true)
    expect(canActOnApprovalInboxEntry({ version: '' })).toBe(false)
    expect(canActOnApprovalInboxEntry(null)).toBe(false)
  })
})
