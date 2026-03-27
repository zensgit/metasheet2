import { describe, expect, it } from 'vitest'
import {
  readApprovalInboxError,
  resolveApprovalInboxActionStatusAfterRefresh,
  resolveApprovalInboxErrorMessage,
} from '../src/views/approvalInboxFeedback'

describe('approvalInboxFeedback', () => {
  it('preserves action status during action-triggered refreshes only when requested', () => {
    expect(resolveApprovalInboxActionStatusAfterRefresh('Approved ECO-1', true)).toBe('Approved ECO-1')
    expect(resolveApprovalInboxActionStatusAfterRefresh('Approved ECO-1', false)).toBe('')
  })

  it('prefers nested structured error messages over generic HTTP fallbacks', () => {
    expect(
      resolveApprovalInboxErrorMessage(
        {
          ok: false,
          error: {
            code: 'APPROVAL_VERSION_CONFLICT',
            message: 'Approval instance version mismatch',
          },
        },
        '409 Conflict',
      ),
    ).toBe('Approval instance version mismatch')

    expect(
      resolveApprovalInboxErrorMessage(
        {
          message: 'Rejection reason is required',
        },
        '400 Bad Request',
      ),
    ).toBe('Rejection reason is required')

    expect(resolveApprovalInboxErrorMessage(null, '500 Internal Server Error')).toBe('500 Internal Server Error')
  })

  it('reads structured response errors for history and action flows alike', async () => {
    await expect(
      readApprovalInboxError({
        status: 409,
        statusText: 'Conflict',
        json: async () => ({
          ok: false,
          error: {
            message: 'Approval history is unavailable for archived approvals',
          },
        }),
      }),
    ).resolves.toBe('Approval history is unavailable for archived approvals')

    await expect(
      readApprovalInboxError({
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('invalid json')
        },
      }),
    ).resolves.toBe('500 Internal Server Error')
  })
})
