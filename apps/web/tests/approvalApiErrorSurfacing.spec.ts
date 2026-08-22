import { describe, expect, it , vi} from 'vitest'
import { ApprovalApiError, approvalRequestError, normalizeApprovalHistoryEnvelope } from '../src/approvals/api'
import { collectHistoryAttachmentRefIds } from '../src/approvals/attachmentRefs'

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

/**
 * Lock-9 FE fix round (2026-08-22, gate P1-2) — `getApprovalHistory` itself is behind the same
 * `USE_MOCK` gate `approvalRequestError` above is documented as unable to bypass under Vitest
 * (`DEV` is always `true`), so this exercises the extracted pure normalizer directly rather than
 * fighting the module-level const with `vi.stubEnv`/`vi.resetModules`. The payload below is the
 * VERBATIM body captured from a real `MetaSheetServer` + live Postgres read in the independent
 * gate (`GET /api/approvals/:id/history`, platform branch, one seeded `comment` row) — not a
 * fabricated fixture.
 */
describe('normalizeApprovalHistoryEnvelope (Lock-9 fix round, gate P1-2)', () => {
  const REAL_WIRE_ENVELOPE = {
    ok: true,
    data: {
      items: [
        {
          id: '1052',
          occurred_at: '2026-08-22T06:04:24.994Z',
          actor_id: 'probe-req-1787378664639',
          actor_name: 'Requester',
          action: 'comment',
          comment: 'hello',
          from_status: null,
          to_status: 'approved',
          version: 1,
          from_version: null,
          to_version: 1,
        },
      ],
      page: 1,
      pageSize: 50,
      total: 1,
    },
  }

  it('unwraps the real {ok, data:{items}} envelope to the items array', () => {
    const result = normalizeApprovalHistoryEnvelope(REAL_WIRE_ENVELOPE)
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect((result[0] as unknown as { id: string }).id).toBe('1052')
  })

  it('passes an already-array payload through unchanged (mock branch / defensive future-proofing)', () => {
    const arr = [{ id: 'h1' }]
    expect(normalizeApprovalHistoryEnvelope(arr)).toBe(arr)
  })

  it('fails closed to [] for a malformed/absent envelope rather than throwing', () => {
    expect(normalizeApprovalHistoryEnvelope(null)).toEqual([])
    expect(normalizeApprovalHistoryEnvelope(undefined)).toEqual([])
    expect(normalizeApprovalHistoryEnvelope({ ok: true })).toEqual([])
    expect(normalizeApprovalHistoryEnvelope({ ok: true, data: {} })).toEqual([])
    expect(normalizeApprovalHistoryEnvelope({ ok: true, data: { items: 'not-an-array' } })).toEqual([])
  })

  it('end-to-end: the real wire envelope, normalized, no longer throws through collectHistoryAttachmentRefIds', () => {
    // This IS the P1-2 chain: attachmentRefs.ts:145 `for (const item of history ?? [])` used to
    // receive the raw envelope object and throw `TypeError: ... is not iterable`. Feeding it
    // through the normalizer first (as `getApprovalHistory` now does) makes that structurally
    // impossible regardless of what the server returns.
    const history = normalizeApprovalHistoryEnvelope(REAL_WIRE_ENVELOPE)
    expect(() => collectHistoryAttachmentRefIds(history as never)).not.toThrow()
    // The platform branch's row has no `metadata` column at all (gate P1-1, disclosed in the PR
    // body) — correctly resolves to no ids, not a crash and not a fabricated one.
    expect(collectHistoryAttachmentRefIds(history as never)).toEqual([])
  })

  it('getApprovalHistory itself unwraps the real envelope (pins the CALL SITE, not just the helper)', async () => {
    // Requal P2 (2026-08-22): reverting getApprovalHistory to its pre-fix body while leaving the
    // normalizer intact left the ENTIRE required lane green — the five tests above exercise the
    // function, nothing exercised the wiring. This test pins the call site: it must red if the
    // route function stops routing through the normalizer.
    vi.resetModules()
    vi.stubEnv('DEV', false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => REAL_WIRE_ENVELOPE,
      clone() { return this },
    }))
    try {
      const { getApprovalHistory } = await import('../src/approvals/api')
      await expect(getApprovalHistory('apv_1')).resolves.toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it('end-to-end: a PLM-shaped row (metadata present) still resolves its staged process-attachment ids', () => {
    const plmShapedHistory = normalizeApprovalHistoryEnvelope({
      ok: true,
      data: {
        items: [{ id: 'h1', metadata: { attachmentIds: ['att_probe_1'] } }],
        page: 1,
        pageSize: 50,
        total: 1,
      },
    })
    expect(collectHistoryAttachmentRefIds(plmShapedHistory as never)).toEqual(['att_probe_1'])
  })
})
