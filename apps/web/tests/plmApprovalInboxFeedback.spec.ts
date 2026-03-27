import { describe, expect, it } from 'vitest'
import {
  readApprovalInboxErrorRecord,
  readApprovalInboxError,
  reconcileApprovalInboxConflictVersion,
  resolveApprovalInboxActionStatusAfterRefresh,
  resolveApprovalInboxErrorRecord,
  resolveApprovalInboxErrorMessage,
  resolveApprovalInboxThrownErrorRecord,
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

  it('exposes approval version conflict metadata for retry recovery', () => {
    expect(
      resolveApprovalInboxErrorRecord(
        {
          ok: false,
          error: {
            code: 'APPROVAL_VERSION_CONFLICT',
            message: 'Approval instance version mismatch',
            currentVersion: 7,
          },
        },
        '409 Conflict',
      ),
    ).toEqual({
      code: 'APPROVAL_VERSION_CONFLICT',
      currentVersion: 7,
      message: 'Approval instance version mismatch',
    })
  })

  it('reads structured conflict metadata from action responses', async () => {
    await expect(
      readApprovalInboxErrorRecord({
        status: 409,
        statusText: 'Conflict',
        json: async () => ({
          ok: false,
          error: {
            code: 'APPROVAL_VERSION_CONFLICT',
            message: 'Approval instance version mismatch',
            currentVersion: 5,
          },
        }),
      }),
    ).resolves.toEqual({
      code: 'APPROVAL_VERSION_CONFLICT',
      currentVersion: 5,
      message: 'Approval instance version mismatch',
    })
  })

  it('reconciles stale approval versions without mutating other rows', () => {
    expect(
      reconcileApprovalInboxConflictVersion(
        [
          { id: 'approval-1', version: 2, status: 'pending' },
          { id: 'approval-2', version: 4, status: 'pending' },
        ],
        'approval-1',
        3,
      ),
    ).toEqual([
      { id: 'approval-1', version: 3, status: 'pending' },
      { id: 'approval-2', version: 4, status: 'pending' },
    ])
  })

  it('reads conflict metadata from thrown errors for product-view recovery', () => {
    const conflict = new Error('Approval instance version mismatch') as Error & {
      code?: string
      currentVersion?: number
    }
    conflict.code = 'APPROVAL_VERSION_CONFLICT'
    conflict.currentVersion = 6

    expect(
      resolveApprovalInboxThrownErrorRecord(conflict, '审批通过失败'),
    ).toEqual({
      code: 'APPROVAL_VERSION_CONFLICT',
      currentVersion: 6,
      message: 'Approval instance version mismatch',
    })

    expect(
      resolveApprovalInboxThrownErrorRecord(null, '审批通过失败'),
    ).toEqual({
      code: null,
      currentVersion: null,
      message: '审批通过失败',
    })
  })
})
