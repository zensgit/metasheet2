/**
 * 请假撤销入口(阶段 B)—— 共享核心:词表(P-2)、错误码文案(P-7 / P-8 / P-6′)、考勤侧四条路由的客户端、
 * 审批侧办理的请假 id 解析。Design: docs/development/approval-cancel-entry-phase-b-fe-design-20260929.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `approvals/api.ts` reads `__APPROVAL_MOCK__` at module load; under Vitest `DEV` is true, so without
// this override `getApproval` returns its mock fixture and never reaches the stubbed transport.
vi.hoisted(() => {
  ;(globalThis as { __APPROVAL_MOCK__?: boolean }).__APPROVAL_MOCK__ = false
})

const apiFetchMock = vi.fn()
const apiGetMock = vi.fn()

vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
    apiGet: (...args: unknown[]) => apiGetMock(...args),
  }
})

import { resolveStatusDisplay } from '../src/utils/statusDomains'
import {
  CANCEL_ROUND_BLOCK_CATEGORY_COPY,
  CANCEL_ROUND_ERROR_COPY,
  CANCEL_ROUND_SEAT_CLASS_COPY,
  CANCEL_ROUND_STATUS_KEYS,
  approvalStatusTagProps,
  cancelRoundStatusKeyFromApproval,
  cancelRoundStatusKeyFromSummary,
  decideCancelRound,
  decideCancelRoundFromApproval,
  describeCancelRoundBlock,
  describeCancelRoundError,
  fetchCancelRoundSummary,
  launchCancelRound,
  needsCancelRoundCloseReason,
  normalizeCancelRoundSummary,
  resetCancelRoundLeaveRequestIdCache,
  resolveCancelRoundLeaveRequestId,
  withdrawCancelRound,
} from '../src/approvals/cancelRound'
import { ApprovalApiError } from '../src/approvals/api'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  apiGetMock.mockReset()
  resetCancelRoundLeaveRequestIdCache()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('cancelRound status domain (P-2)', () => {
  it('every round state names its subject and differs from the approvalInstance words', () => {
    const subjects = ['撤销', '请假']
    for (const key of CANCEL_ROUND_STATUS_KEYS) {
      const zh = resolveStatusDisplay('cancelRound', key, true)
      expect(subjects.some((subject) => zh.label.includes(subject)), `${key}: ${zh.label}`).toBe(true)
      expect(zh.label).not.toBe(key)
    }
    // The approvalInstance domain itself is untouched.
    expect(resolveStatusDisplay('approvalInstance', 'rejected', true)).toEqual({ tone: 'danger', label: '已驳回' })
    expect(resolveStatusDisplay('approvalInstance', 'revoked', true)).toEqual({ tone: 'info', label: '已撤回' })
    expect(resolveStatusDisplay('approvalInstance', 'cancelled', true)).toEqual({ tone: 'info', label: '已取消' })
  })

  it('V7 / V8 are non-terminal: warning tone, never the danger tone of a failure', () => {
    for (const key of ['action_incomplete_retry', 'system_busy_retry']) {
      const display = resolveStatusDisplay('cancelRound', key, true)
      expect(display.tone).toBe('warning')
      expect(display.label).toContain('请稍后重试')
      expect(display.label).not.toContain('失败')
    }
  })

  it('system closure (V5 / V6) and an approver rejection (V3) never share a label', () => {
    const v3 = resolveStatusDisplay('cancelRound', 'cancellation_rejected', true).label
    const v5 = resolveStatusDisplay('cancelRound', 'cancellation_window_closed', true).label
    const v6 = resolveStatusDisplay('cancelRound', 'cancellation_blocked', true).label
    expect(new Set([v3, v5, v6]).size).toBe(3)
    expect(v5).not.toContain('驳回')
    expect(v6).not.toContain('驳回')
    const unresolved = resolveStatusDisplay('cancelRound', 'status_unavailable', true).label
    expect(unresolved).not.toContain('驳回')
  })
})

describe('V-word resolution', () => {
  it('summary: machine status wins, outcome is the fallback, unknown is never a V-word', () => {
    expect(cancelRoundStatusKeyFromSummary({ status: 'cancellation_window_closed', outcome: 'expired' })).toBe('cancellation_window_closed')
    expect(cancelRoundStatusKeyFromSummary({ status: '', outcome: 'blocked' })).toBe('cancellation_blocked')
    expect(cancelRoundStatusKeyFromSummary({ status: 'mystery', outcome: 'mystery' })).toBe('status_unavailable')
  })

  it('approval DTO: rejected is V3 only when the criterion was read and says "no system closure"', () => {
    expect(cancelRoundStatusKeyFromApproval('rejected', { kind: 'resolved', closeReason: null })).toBe('cancellation_rejected')
    expect(cancelRoundStatusKeyFromApproval('rejected', { kind: 'resolved', closeReason: 'round_expired' })).toBe('cancellation_window_closed')
    expect(cancelRoundStatusKeyFromApproval('rejected', { kind: 'resolved', closeReason: 'business_blocked:X_Y' })).toBe('cancellation_blocked')
    expect(cancelRoundStatusKeyFromApproval('rejected', { kind: 'resolving' })).toBe('status_resolving')
    expect(cancelRoundStatusKeyFromApproval('rejected', { kind: 'unavailable' })).toBe('status_unavailable')
    expect(cancelRoundStatusKeyFromApproval('pending', { kind: 'unavailable' })).toBe('cancellation_pending_approval')
    expect(cancelRoundStatusKeyFromApproval('approved', { kind: 'unavailable' })).toBe('leave_cancelled')
    expect(cancelRoundStatusKeyFromApproval('revoked', { kind: 'unavailable' })).toBe('cancellation_withdrawn')
  })

  it('domain selector: workflowKey decides the domain; the detail DTO carries the criterion', () => {
    expect(approvalStatusTagProps({ status: 'rejected', workflowKey: 'attendance.request' })).toEqual({
      domain: 'approvalInstance',
      status: 'rejected',
    })
    expect(approvalStatusTagProps({ status: 'rejected', workflowKey: 'approval.cancel-round', cancelRoundCloseReason: 'round_expired' })).toEqual({
      domain: 'cancelRound',
      status: 'cancellation_window_closed',
    })
    expect(approvalStatusTagProps({ status: 'rejected', workflowKey: 'approval.cancel-round' })).toEqual({
      domain: 'cancelRound',
      status: 'cancellation_rejected',
    })
    expect(approvalStatusTagProps({ status: 'rejected', workflowKey: 'approval.cancel-round' }, { kind: 'resolving' }).status).toBe('status_resolving')
    expect(needsCancelRoundCloseReason({ status: 'rejected', workflowKey: 'approval.cancel-round' })).toBe(true)
    expect(needsCancelRoundCloseReason({ status: 'pending', workflowKey: 'approval.cancel-round' })).toBe(false)
    expect(needsCancelRoundCloseReason({ status: 'rejected', workflowKey: null })).toBe(false)
  })
})

describe('error copy (P-7 / P-8 / P-6′)', () => {
  const REGISTERED = [
    'CANCEL_ROUND_DOCUMENT_NOT_APPROVED',
    'CANCEL_ROUND_REQUESTER_ONLY',
    'CANCEL_ROUND_SUITE_FORBIDDEN',
    'CANCEL_ROUND_ALREADY_PENDING',
    'CANCEL_ROUND_NO_ELIGIBLE_APPROVER',
    'CANCEL_ROUND_SEAT_INELIGIBLE',
    'CANCEL_ROUND_SUITE_UNKNOWN',
    'CANCEL_ROUND_WINDOW_OUT_OF_RANGE',
    'CANCEL_ROUND_OUTLET_FORBIDDEN',
    'CANCEL_ROUND_CREATE_FAILED',
    'CANCEL_ROUND_WINDOW_ANCHOR_MISSING',
    'CANCEL_ROUND_INVARIANT_VIOLATION',
    'CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE',
    'CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED',
    'CANCEL_ROUND_DISPATCH_CONTENDED',
    'CANCEL_ROUND_BUSINESS_TARGET_MISSING',
    'ATTENDANCE_CALCULATION_ROLLOUT_BUSY',
  ]

  it('every source-enumerated code has zh + en copy that is not the raw code', () => {
    for (const code of REGISTERED) {
      const entry = CANCEL_ROUND_ERROR_COPY[code]
      expect(entry, code).toBeTruthy()
      for (const isZh of [true, false]) {
        const d = describeCancelRoundError(new ApprovalApiError('raw server text', 409, code), isZh, 'fallback')
        expect(d.message, code).not.toBe('raw server text')
        expect(d.message).not.toContain(code)
        expect(d.message.length).toBeGreaterThan(4)
      }
    }
  })

  it('seat-class codes use the P-6′ weak copy (no cause claimed)', () => {
    for (const code of ['CANCEL_ROUND_SEAT_INELIGIBLE', 'CANCEL_ROUND_NO_ELIGIBLE_APPROVER']) {
      const d = describeCancelRoundError(new ApprovalApiError('x', 409, code), true, 'f')
      expect(d.message).toBe(CANCEL_ROUND_SEAT_CLASS_COPY.zh)
      expect(d.message).not.toContain('资格')
    }
  })

  it('retryable codes carry V7 / V8 and never read as a failure', () => {
    const v7 = describeCancelRoundError(new ApprovalApiError('x', 409, 'CANCEL_ROUND_WINDOW_ANCHOR_MISSING'), true, 'f')
    expect(v7).toMatchObject({ cls: 'retryable', presentationKey: 'action_incomplete_retry' })
    expect(v7.message).toContain('仍在审批中')
    const v8 = describeCancelRoundError(new ApprovalApiError('x', 503, 'CANCEL_ROUND_DISPATCH_CONTENDED'), true, 'f')
    expect(v8).toMatchObject({ cls: 'retryable', presentationKey: 'system_busy_retry' })
    expect(v8.message).not.toContain('失败')
  })

  it('an unregistered code keeps the server message (same as the approval side); message-less falls back', () => {
    expect(describeCancelRoundError(new ApprovalApiError('Approval assignment not found for actor', 403, 'APPROVAL_ASSIGNMENT_REQUIRED'), true, 'f').message)
      .toBe('Approval assignment not found for actor')
    expect(describeCancelRoundError({}, true, '操作失败').message).toBe('操作失败')
  })

  it('business_blocked: known codes get their own copy; unknown codes get category copy + the code, never 原因未知', () => {
    const known = describeCancelRoundBlock('ATTENDANCE_CANCELLATION_REVIEW_REQUIRED', true)
    expect(known.known).toBe(true)
    expect(known.message).not.toBe(CANCEL_ROUND_BLOCK_CATEGORY_COPY.zh)
    const unknown = describeCancelRoundBlock('SOME_FUTURE_CODE', true)
    expect(unknown).toEqual({ message: CANCEL_ROUND_BLOCK_CATEGORY_COPY.zh, code: 'SOME_FUTURE_CODE', known: false })
    expect(unknown.message).not.toContain('未知')
    expect(describeCancelRoundBlock(null, false).message).toBe(CANCEL_ROUND_BLOCK_CATEGORY_COPY.en)
  })
})

describe('attendance-side client', () => {
  it('summary: entryEnabled absent ⇒ false; present true ⇒ true; round normalised', async () => {
    expect(normalizeCancelRoundSummary({ ok: true, data: { requestId: 'r1', round: null } }, 'r1')).toEqual({
      requestId: 'r1',
      documentInstanceId: null,
      entryEnabled: false,
      round: null,
    })
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      ok: true,
      data: {
        requestId: 'r1',
        documentInstanceId: 'apv_1',
        entryEnabled: true,
        round: {
          roundId: 'apr_1', engineInstanceId: 'e1', outcome: 'applied', status: 'leave_cancelled',
          startedAt: 's', endedAt: 'e', closeReason: null, blockCode: null, closedBySystem: false,
          canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION',
          cancellationOutcome: { status: 'cancelled_reversal_unreported', reversal: null },
        },
      },
    }))
    const summary = await fetchCancelRoundSummary('r 1')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/attendance/requests/r%201/cancel-round')
    expect(summary.entryEnabled).toBe(true)
    expect(summary.round?.cancellationOutcome).toEqual({ status: 'cancelled_reversal_unreported', reversal: null })
  })

  it('writes go to the attendance routes; failures surface the server code; success bodies are not read', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(200, { ok: true, data: { requestId: 'r1', roundId: 'apr_1', outcome: 'withdrawn', status: 'cancellation_withdrawn' } }))
    await launchCancelRound('r1', '  plans changed ')
    await withdrawCancelRound('r1', '')
    await decideCancelRound('r1', 'reject', 'no')
    expect(apiFetchMock.mock.calls.map((c) => [c[0], (c[1] as RequestInit).method, (c[1] as RequestInit).body])).toEqual([
      ['/api/attendance/requests/r1/cancel-round', 'POST', JSON.stringify({ reason: 'plans changed' })],
      ['/api/attendance/requests/r1/cancel-round/withdraw', 'POST', JSON.stringify({})],
      ['/api/attendance/requests/r1/cancel-round/actions', 'POST', JSON.stringify({ action: 'reject', comment: 'no' })],
    ])
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { ok: false, error: { code: 'CANCEL_ROUND_ALREADY_PENDING', message: 'm' } }))
    await expect(launchCancelRound('r1')).rejects.toMatchObject({ status: 409, code: 'CANCEL_ROUND_ALREADY_PENDING' })
  })
})

describe('approver path: leave id resolution (fail closed)', () => {
  it('cancel-round businessKey → original instance → attendance-request:<id>', async () => {
    apiGetMock.mockResolvedValueOnce({ id: 'apv_orig', businessKey: 'attendance-request:req-42' })
    await expect(resolveCancelRoundLeaveRequestId({ id: 'cr1', businessKey: 'apv_orig' })).resolves.toBe('req-42')
    expect(apiGetMock).toHaveBeenCalledWith('/api/approvals/apv_orig')
  })

  it('a missing prefix or a failed read throws — it never falls back to another id', async () => {
    apiGetMock.mockResolvedValueOnce({ id: 'apv_orig', businessKey: 'something-else' })
    await expect(resolveCancelRoundLeaveRequestId({ id: 'cr2', businessKey: 'apv_orig' })).rejects.toBeInstanceOf(ApprovalApiError)
    apiGetMock.mockRejectedValueOnce(new Error('API error: 404'))
    await expect(resolveCancelRoundLeaveRequestId({ id: 'cr3', businessKey: 'apv_orig' })).rejects.toBeInstanceOf(ApprovalApiError)
    await expect(resolveCancelRoundLeaveRequestId({ id: 'cr4', businessKey: null })).rejects.toBeInstanceOf(ApprovalApiError)
  })

  it('decide maps a 409 WINDOW_ANCHOR_MISSING to V7 copy and keeps status + code', async () => {
    apiGetMock.mockResolvedValueOnce({ id: 'apv_orig', businessKey: 'attendance-request:req-7' })
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { ok: false, error: { code: 'CANCEL_ROUND_WINDOW_ANCHOR_MISSING', message: 'raw' } }))
    const failure = await decideCancelRoundFromApproval({ id: 'cr5', businessKey: 'apv_orig' }, 'approve').catch((e) => e)
    expect(failure).toBeInstanceOf(ApprovalApiError)
    expect(failure.status).toBe(409)
    expect(failure.code).toBe('CANCEL_ROUND_WINDOW_ANCHOR_MISSING')
    expect(failure.message).toBe(CANCEL_ROUND_ERROR_COPY.CANCEL_ROUND_WINDOW_ANCHOR_MISSING.zh)
    expect(apiFetchMock).toHaveBeenCalledWith('/api/attendance/requests/req-7/cancel-round/actions', expect.anything())
  })
})
