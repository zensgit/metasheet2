import { describe, expect, it } from 'vitest'
import { ApprovalApiError, approvalRequestError } from '../src/approvals/api'

/**
 * B1-04 (宽恕型错误三件套) — unit coverage for the error-surfacing helper that
 * `createApproval` and `dispatchAction` (apps/web/src/approvals/api.ts) funnel their failed
 * (non-OK) responses through, generalizing the ad hoc `payload.error.code/message` parsing
 * `remindApproval` already did for its own failure branches.
 *
 * This exercises `approvalRequestError` directly against a fabricated `Response`, rather than
 * via `createApproval`/`dispatchAction` themselves: `approvals/api.ts`'s `USE_MOCK` flag is
 * `import.meta.env.DEV || ...`, and `DEV` is always `true` under Vitest, so those exported
 * functions always take their mock branch here and never reach the real fetch path. The helper
 * itself has no such gate, so it is independently testable.
 */
function fakeResponse(status: number, jsonImpl: () => Promise<unknown>): Response {
  return { status, json: jsonImpl } as unknown as Response
}

describe('approvalRequestError', () => {
  it('surfaces the server error message + code verbatim', async () => {
    const response = fakeResponse(400, async () => ({
      error: { code: 'AMOUNT_MISMATCH', message: '金额合计不一致' },
    }))

    let caught: unknown
    try {
      await approvalRequestError(response)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ApprovalApiError)
    const error = caught as ApprovalApiError
    expect(error.message).toBe('金额合计不一致')
    expect(error.code).toBe('AMOUNT_MISMATCH')
    expect(error.status).toBe(400)
  })

  it('falls back to a status-coded message for a non-JSON body', async () => {
    const response = fakeResponse(500, async () => {
      throw new Error('Unexpected token < in JSON')
    })

    let caught: unknown
    try {
      await approvalRequestError(response)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ApprovalApiError)
    const error = caught as ApprovalApiError
    expect(error.message).toBe('请求失败（500）')
    expect(error.code).toBeUndefined()
    expect(error.status).toBe(500)
  })

  it('falls back to a status-coded message when the JSON body has no `error.message`', async () => {
    const response = fakeResponse(403, async () => ({ ok: false }))

    let caught: unknown
    try {
      await approvalRequestError(response)
    } catch (err) {
      caught = err
    }

    expect((caught as ApprovalApiError).message).toBe('请求失败（403）')
    expect((caught as ApprovalApiError).code).toBeUndefined()
  })

  it('ignores a blank server message and falls back to the status-coded message', async () => {
    const response = fakeResponse(422, async () => ({ error: { code: 'X', message: '   ' } }))

    let caught: unknown
    try {
      await approvalRequestError(response)
    } catch (err) {
      caught = err
    }

    const error = caught as ApprovalApiError
    expect(error.message).toBe('请求失败（422）')
    expect(error.code).toBe('X')
  })
})
