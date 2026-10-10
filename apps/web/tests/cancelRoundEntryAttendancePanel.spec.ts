/**
 * 请假撤销入口(阶段 B)—— 考勤自助面(AttendanceCancelRoundPanel,挂在 AttendanceView「最近申请」的请假行):
 * P-1 入口与谓词(entryEnabled false ⇒ 入口不渲染;I3 不满足 ⇒ 禁用而非隐藏 + 主语明确的原因 + 进度链接)、
 * 发起对话框(确认 + 可选说明)、申请人撤回、P-2 词表、P-3 三值分类与 formatLeaveBalanceMinutes、
 * P-7 未知 code 折叠、P-8 / P-6′ 文案、摘要读失败与「无轮次」不同形。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetchMock(...args) }
})

import AttendanceCancelRoundPanel from '../src/views/attendance/AttendanceCancelRoundPanel.vue'
import { useLocale } from '../src/composables/useLocale'
import {
  CANCEL_ROUND_BLOCK_CATEGORY_COPY,
  CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED,
  CANCEL_ROUND_CLIENT_COPY,
  CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT,
  CANCEL_ROUND_SEAT_CLASS_COPY,
  normalizeCancelRoundDeliveries,
} from '../src/approvals/cancelRound'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// `Response.json()` settles on a macrotask, so each cycle also yields one timer turn.
async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
  }
}

type Round = Record<string, unknown>
function round(overrides: Round = {}): Round {
  return {
    roundId: 'apr_1',
    engineInstanceId: 'cr_1',
    outcome: 'pending',
    status: 'cancellation_pending_approval',
    startedAt: '2026-09-29T01:00:00.000Z',
    endedAt: null,
    closeReason: null,
    blockCode: null,
    closedBySystem: false,
    canWithdraw: true,
    withdrawBlockedReason: null,
    cancellationOutcome: null,
    ...overrides,
  }
}
function summaryBody(data: { entryEnabled?: boolean; round?: Round | null }) {
  const payload: Record<string, unknown> = { requestId: 'req-1', documentInstanceId: 'apv_1', round: data.round ?? null }
  if (data.entryEnabled !== undefined) payload.entryEnabled = data.entryEnabled
  return { ok: true, data: payload }
}

/** Route-aware fake: GET summary answers from the queue (last entry repeats); POSTs answer `writes`. */
let summaries: Array<() => Response> = []
let writes: Array<() => Response> = []
function installFetch() {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === 'GET') {
      const next = summaries.length > 1 ? summaries.shift()! : summaries[0]
      return next()
    }
    const next = writes.shift()
    return next ? next() : jsonResponse(200, { ok: true, data: { requestId: 'req-1', roundId: 'apr_1', outcome: 'pending', status: 'x' } })
  })
}
const calls = () => apiFetchMock.mock.calls.map((c) => [(c[1] as RequestInit | undefined)?.method ?? 'GET', c[0], (c[1] as RequestInit | undefined)?.body ?? null])

const LEAVE = { id: 'req-1', request_type: 'leave', status: 'approved', user_id: 'emp_1' }

const apps: VueApp[] = []
async function mountPanel(request: Record<string, unknown> = LEAVE, currentUserId: string | null = 'emp_1', extra: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(AttendanceCancelRoundPanel, { request: request as never, currentUserId, ...extra }) })
  app.mount(container)
  apps.push(app)
  await flushUi()
  return container
}
const $ = (root: HTMLElement, attr: string) => root.querySelector<HTMLElement>(`[${attr}]`)

beforeEach(() => {
  apiFetchMock.mockReset()
  summaries = []
  writes = []
  installFetch()
  useLocale().setLocale('zh-CN')
})

afterEach(() => {
  while (apps.length) apps.pop()!.unmount()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
})

describe('entry visibility (P-1 + entryEnabled)', () => {
  it('entryEnabled absent ⇒ read but render nothing; false with an existing round ⇒ progress only, no entry', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ round: null }))]
    const root = await mountPanel()
    expect(calls()).toEqual([['GET', '/api/attendance/requests/req-1/cancel-round', null]])
    expect($(root, 'data-attendance-cancel-round')).toBeNull()
    expect($(root, 'data-cancel-round-launch')).toBeNull()

    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: false, round: round() }))]
    const withRound = await mountPanel()
    expect($(withRound, 'data-cancel-round-progress')).not.toBeNull()
    expect($(withRound, 'data-cancel-round-launch')).toBeNull()
  })

  it('entryEnabled true: shown only on the viewer\'s own APPROVED leave; non-leave rows never read', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true }))]
    expect($(await mountPanel(), 'data-cancel-round-launch')).not.toBeNull()
    expect($(await mountPanel(LEAVE, 'someone_else'), 'data-cancel-round-launch')).toBeNull()
    expect($(await mountPanel(LEAVE, null), 'data-cancel-round-launch')).toBeNull()
    expect($(await mountPanel({ ...LEAVE, status: 'cancelled' }), 'data-cancel-round-launch')).toBeNull()
    apiFetchMock.mockClear()
    await mountPanel({ ...LEAVE, request_type: 'missed_check_in' })
    await mountPanel({ ...LEAVE, status: 'pending' })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('a round re-read as applied (V2) removes the entry even while the parent row still says approved', async () => {
    summaries = [() => jsonResponse(200, summaryBody({
      entryEnabled: true,
      round: round({ outcome: 'applied', status: 'leave_cancelled', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' }),
    }))]
    const root = await mountPanel()
    expect($(root, 'data-cancel-round-status')!.textContent).toBe('请假已取消')
    expect($(root, 'data-cancel-round-launch')).toBeNull()
  })

  it('I3 unmet ⇒ DISABLED (not hidden) with a subject-bearing reason and an in-page link to the progress', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round() }))]
    const root = await mountPanel()
    const button = $(root, 'data-cancel-round-launch') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.disabled).toBe(true)
    const reason = $(root, 'data-cancel-round-launch-blocked')!
    expect(reason.textContent).toContain('这条请假已有一个撤销申请在审批中')
    expect(button.getAttribute('aria-describedby')).toBe(reason.id)
    const link = $(root, 'data-cancel-round-progress-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('#attendance-cancel-round-req-1')
    expect(root.querySelector('#attendance-cancel-round-req-1')).not.toBeNull()
  })

  it('a failed summary read is not rendered like "no round"; a 404 renders nothing', async () => {
    summaries = [() => jsonResponse(500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } })]
    const failed = await mountPanel()
    expect($(failed, 'data-cancel-round-unavailable')!.textContent).toContain('撤销状态暂时无法读取')
    expect($(failed, 'data-cancel-round-launch')).toBeNull()
    summaries = [() => jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Request not found' } })]
    const notFound = await mountPanel()
    expect($(notFound, 'data-attendance-cancel-round')).toBeNull()
  })
})

describe('launch flag OFF with an existing round (owner 2026-09-29 18:3x 「Hide launch, keep existing (Recommended)」)', () => {
  it('OFF hides only the launch: an existing pending round keeps its progress and a working withdraw', async () => {
    summaries = [
      () => jsonResponse(200, summaryBody({ entryEnabled: false, round: round() })),
      () => jsonResponse(200, summaryBody({ entryEnabled: false, round: round({ outcome: 'withdrawn', status: 'cancellation_withdrawn', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' }) })),
    ]
    const root = await mountPanel()
    expect($(root, 'data-cancel-round-progress')).not.toBeNull()
    expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请审批中')
    expect($(root, 'data-cancel-round-entry')).toBeNull()
    expect($(root, 'data-cancel-round-launch')).toBeNull()
    const withdraw = $(root, 'data-cancel-round-withdraw') as HTMLButtonElement
    expect(withdraw).not.toBeNull()
    expect(withdraw.disabled).toBe(false)
    withdraw.click()
    await flushUi()
    // F1: the withdraw names the round this panel rendered
    expect(calls()[1]).toEqual(['POST', '/api/attendance/requests/req-1/cancel-round/withdraw', JSON.stringify({ expectedRoundId: 'apr_1' })])
    expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请已撤回')
    // the withdrawn round stays readable; OFF still offers no launch
    expect($(root, 'data-cancel-round-progress')).not.toBeNull()
    expect($(root, 'data-cancel-round-launch')).toBeNull()
  })

  it('OFF with a finished round: its outcome stays readable (V2 result lines, V3 word), and no launch', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: false, round: round({ outcome: 'applied', status: 'leave_cancelled', canWithdraw: false, cancellationOutcome: { status: 'cancelled', reversal: { reversed: 480, lots: 1, unrecoverableExpired: 0, alreadyReversed: false } } }) }))]
    const applied = await mountPanel({ ...LEAVE, status: 'cancelled' })
    expect($(applied, 'data-cancel-round-status')!.textContent).toBe('请假已取消')
    expect($(applied, 'data-cancel-round-result')!.textContent).toContain('本次已返还 1天')
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: false, round: round({ outcome: 'rejected', status: 'cancellation_rejected', canWithdraw: false }) }))]
    const rejected = await mountPanel()
    expect($(rejected, 'data-cancel-round-status')!.textContent).toBe('撤销申请被驳回')
    expect($(rejected, 'data-cancel-round-launch')).toBeNull()
    expect($(rejected, 'data-cancel-round-withdraw')).toBeNull()
  })
})

describe('launch dialog and withdraw', () => {
  it('confirm + optional reason → POST launch → summary re-read → V1 progress, entry now disabled', async () => {
    summaries = [
      () => jsonResponse(200, summaryBody({ entryEnabled: true })),
      () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round() })),
    ]
    writes = [() => jsonResponse(201, summaryBody({ entryEnabled: true, round: round() }))]
    const root = await mountPanel()
    $(root, 'data-cancel-round-launch')!.click()
    await flushUi()
    const dialog = $(root, 'data-cancel-round-dialog')!
    expect(dialog.getAttribute('role')).toBe('dialog')
    const textarea = $(root, 'data-cancel-round-reason') as HTMLTextAreaElement
    textarea.value = '  行程取消  '
    textarea.dispatchEvent(new Event('input'))
    $(root, 'data-cancel-round-confirm')!.click()
    await flushUi()
    expect(calls()).toEqual([
      ['GET', '/api/attendance/requests/req-1/cancel-round', null],
      ['POST', '/api/attendance/requests/req-1/cancel-round', JSON.stringify({ reason: '行程取消' })],
      ['GET', '/api/attendance/requests/req-1/cancel-round', null],
    ])
    expect($(root, 'data-cancel-round-dialog')).toBeNull()
    expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请审批中')
    expect($(root, 'data-cancel-round-leave-valid')!.textContent).toContain('请假仍然有效')
    expect(($(root, 'data-cancel-round-launch') as HTMLButtonElement).disabled).toBe(true)
  })

  it('launch refusals: seat-class codes show the weak copy; a retryable 503 shows V8 (warning, not a failure)', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true }))]
    writes = [
      () => jsonResponse(409, { ok: false, error: { code: 'CANCEL_ROUND_SEAT_INELIGIBLE', message: 'A cancellation cannot be started' } }),
      () => jsonResponse(503, { ok: false, error: { code: 'CANCEL_ROUND_DISPATCH_CONTENDED', message: 'x' } }),
    ]
    const root = await mountPanel()
    $(root, 'data-cancel-round-launch')!.click()
    await flushUi()
    $(root, 'data-cancel-round-confirm')!.click()
    await flushUi()
    expect($(root, 'data-cancel-round-dialog-error')!.textContent).toContain(CANCEL_ROUND_SEAT_CLASS_COPY.zh)
    $(root, 'data-cancel-round-confirm')!.click()
    await flushUi()
    const err = $(root, 'data-cancel-round-dialog-error')!
    const tag = err.querySelector<HTMLElement>('.ms-status-tag')!
    expect(tag.dataset).toMatchObject({ domain: 'cancelRound', status: 'system_busy_retry', tone: 'warning' })
    expect(err.textContent).toContain('仍在审批中')
  })

  it('withdraw → POST withdraw → re-read → V4, and the entry is enabled again', async () => {
    summaries = [
      () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round() })),
      () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ outcome: 'withdrawn', status: 'cancellation_withdrawn', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' }) })),
    ]
    const root = await mountPanel()
    $(root, 'data-cancel-round-withdraw')!.click()
    await flushUi()
    expect(calls()[1]).toEqual(['POST', '/api/attendance/requests/req-1/cancel-round/withdraw', JSON.stringify({ expectedRoundId: 'apr_1' })])
    expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请已撤回')
    expect($(root, 'data-cancel-round-withdraw')).toBeNull()
    expect(($(root, 'data-cancel-round-launch') as HTMLButtonElement).disabled).toBe(false)
    expect($(root, 'data-cancel-round-action-error')).toBeNull()
  })

  // F1 (reviewer 2026-10-08): a tab still showing round R1 after the leave's R1 was withdrawn and R2
  // launched elsewhere. The withdraw names R1, so the server refuses (409, nothing written) instead of
  // withdrawing R2 — a round this tab never showed.
  const STALE_REFUSAL = () =>
    jsonResponse(409, { ok: false, error: { code: 'INVALID_STATUS_TRANSITION', message: 'Approval is already in a terminal status' } })

  it('stale tab: the round on screen was replaced — the withdraw names it, the server refuses, and the panel says nothing was done next to the NEW round, which keeps its own withdraw', async () => {
    summaries = [
      () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round() })),
      () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ roundId: 'apr_2', engineInstanceId: 'cr_2', startedAt: '2026-09-30T01:00:00.000Z' }) })),
    ]
    writes = [STALE_REFUSAL]
    const root = await mountPanel()
    $(root, 'data-cancel-round-withdraw')!.click()
    await flushUi()
    expect(calls()).toEqual([
      ['GET', '/api/attendance/requests/req-1/cancel-round', null],
      ['POST', '/api/attendance/requests/req-1/cancel-round/withdraw', JSON.stringify({ expectedRoundId: 'apr_1' })],
      ['GET', '/api/attendance/requests/req-1/cancel-round', null],
    ])
    const error = $(root, 'data-cancel-round-action-error')!
    expect(error.textContent).toContain(CANCEL_ROUND_CLIENT_COPY[CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT].zh)
    // never the 「an approver already acted」 copy beside a round no approver has touched, never 「withdrawn」
    expect(root.textContent).not.toContain('已有审批人处理过')
    expect(root.textContent).not.toContain('撤销申请已撤回')
    expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请审批中')
    const again = $(root, 'data-cancel-round-withdraw') as HTMLButtonElement
    expect(again).not.toBeNull()
    expect(again.disabled).toBe(false)
  })

  it('same round, already finished (409; the re-read shows the SAME round decided): the registered withdraw copy stays — not the stale-round copy', async () => {
    summaries = [
      () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round() })),
      () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ outcome: 'rejected', status: 'cancellation_rejected', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' }) })),
    ]
    writes = [STALE_REFUSAL]
    const root = await mountPanel()
    $(root, 'data-cancel-round-withdraw')!.click()
    await flushUi()
    expect(calls()[1]).toEqual(['POST', '/api/attendance/requests/req-1/cancel-round/withdraw', JSON.stringify({ expectedRoundId: 'apr_1' })])
    const error = $(root, 'data-cancel-round-action-error')!
    expect(error.textContent).toContain('已有审批人处理过,无法再撤回本次撤销申请')
    expect(error.textContent).not.toContain(CANCEL_ROUND_CLIENT_COPY[CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT].zh)
    expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请被驳回')
  })

  it('a withdraw the server attributes to another round, or to no named round, is never a silent success', async () => {
    const withdrawn = () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ outcome: 'withdrawn', status: 'cancellation_withdrawn', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' }) }))
    for (const body of [
      { requestId: 'req-1', roundId: 'apr_other', outcome: 'withdrawn', status: 'cancellation_withdrawn' },
      { requestId: 'req-1' },
    ]) {
      summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round() })), withdrawn]
      writes = [() => jsonResponse(200, { ok: true, data: body })]
      const root = await mountPanel()
      $(root, 'data-cancel-round-withdraw')!.click()
      await flushUi()
      const notice = $(root, 'data-cancel-round-action-error')
      expect(notice, JSON.stringify(body)).not.toBeNull()
      expect(notice!.textContent).toContain(CANCEL_ROUND_CLIENT_COPY[CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED].zh)
    }
  })

  it('withdraw closed by an approver: disabled with the server-resolved reason; a non-requester sees no withdraw', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ canWithdraw: false, withdrawBlockedReason: 'APPROVAL_REVOKE_WINDOW_CLOSED' }) }))]
    const root = await mountPanel()
    expect(($(root, 'data-cancel-round-withdraw') as HTMLButtonElement).disabled).toBe(true)
    expect($(root, 'data-cancel-round-withdraw-reason')!.textContent).toContain('已有审批人处理过,无法再撤回本次撤销申请')
    const other = await mountPanel(LEAVE, 'someone_else')
    expect($(other, 'data-cancel-round-withdraw')).toBeNull()
  })

  it('the server says the viewer is not the requester (APPROVAL_REVOKE_FORBIDDEN): no withdraw even on the viewer\'s own row', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ canWithdraw: false, withdrawBlockedReason: 'APPROVAL_REVOKE_FORBIDDEN' }) }))]
    const root = await mountPanel()
    expect($(root, 'data-cancel-round-progress')).not.toBeNull()
    expect($(root, 'data-cancel-round-withdraw')).toBeNull()
    expect($(root, 'data-cancel-round-withdraw-reason')).toBeNull()
  })
})

describe('round outcome presentation (P-2 / P-3 / P-7)', () => {
  it('V2: three outcome statuses stay three; minutes go through formatLeaveBalanceMinutes', async () => {
    const applied = (outcome: unknown) => () => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ outcome: 'applied', status: 'leave_cancelled', canWithdraw: false, cancellationOutcome: outcome }) }))
    summaries = [applied({ status: 'cancelled', reversal: { reversed: 480, lots: 1, unrecoverableExpired: 0, alreadyReversed: false } })]
    const a = await mountPanel({ ...LEAVE, status: 'cancelled' })
    expect($(a, 'data-cancel-round-status')!.textContent).toBe('请假已取消')
    expect($(a, 'data-cancel-round-result')!.textContent).toContain('本次已返还 1天(共 1 个批次)')
    expect($(a, 'data-cancel-round-leave-valid')).toBeNull()

    summaries = [applied({ status: 'cancelled_with_unrecoverable_expired', reversal: { reversed: 540, lots: 2, unrecoverableExpired: 60, alreadyReversed: true } })]
    const b = await mountPanel({ ...LEAVE, status: 'cancelled' })
    const text = $(b, 'data-cancel-round-result')!.textContent!
    expect(text).toContain('本次已返还 1天 1小时;另有 1小时 因额度已过期未能返还')
    expect(text).toContain('此前已返还过,本次未重复返还')

    summaries = [applied({ status: 'cancelled_reversal_unreported', reversal: null })]
    const c = await mountPanel({ ...LEAVE, status: 'cancelled' })
    const unreported = $(c, 'data-cancel-round-result')!.textContent!
    expect(unreported).toContain('返还结果暂未能读取')
    expect(unreported).not.toContain('0天')
    expect(unreported).not.toContain('已返还 0')
  })

  it('system closure (V5) and an approver rejection (V3) are distinguishable; the leave stays valid in both', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ outcome: 'expired', status: 'cancellation_window_closed', closedBySystem: true, closeReason: 'round_expired', canWithdraw: false }) }))]
    const expired = await mountPanel()
    expect($(expired, 'data-cancel-round-status')!.textContent).toBe('撤销窗口已过,申请自动关闭')
    expect(expired.textContent).not.toContain('驳回')
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ outcome: 'rejected', status: 'cancellation_rejected', canWithdraw: false }) }))]
    const rejected = await mountPanel()
    expect($(rejected, 'data-cancel-round-status')!.textContent).toBe('撤销申请被驳回')
    expect($(rejected, 'data-cancel-round-leave-valid')).not.toBeNull()
  })

  it('V6 with an unknown code: category copy + the raw code folded as a technical detail, never 原因未知', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ outcome: 'blocked', status: 'cancellation_blocked', closedBySystem: true, closeReason: 'business_blocked:FUTURE_CODE_X', blockCode: 'FUTURE_CODE_X', canWithdraw: false }) }))]
    const root = await mountPanel()
    const block = $(root, 'data-cancel-round-block')!
    expect(block.textContent).toContain(CANCEL_ROUND_BLOCK_CATEGORY_COPY.zh)
    expect(block.querySelector('details')!.textContent).toContain('FUTURE_CODE_X')
    expect(root.textContent).not.toContain('原因未知')
  })
})

// F2 (reviewer 2026-10-08): 「请假仍然有效」 is said only of a leave that IS still approved. A leave cancelled
// some other way — the direct cancel (`POST /api/attendance/requests/:id/cancel`), which does not touch the
// round — keeps its last round's V1 / V3–V6 word, but never that note; and a round closed because the leave
// is no longer approved (`CANCEL_ROUND_DOCUMENT_NOT_APPROVED`) never shows it, whatever the parent row says.
describe('「请假仍然有效」 only next to a leave that is still approved (F2)', () => {
  const WORDS: Array<[string, Round]> = [
    ['V1 pending', round()],
    ['V3 rejected', round({ outcome: 'rejected', status: 'cancellation_rejected', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' })],
    ['V4 withdrawn', round({ outcome: 'withdrawn', status: 'cancellation_withdrawn', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' })],
    ['V5 window closed', round({ outcome: 'expired', status: 'cancellation_window_closed', closedBySystem: true, closeReason: 'round_expired', canWithdraw: false })],
    // V6 from the producer whose leave really does stay valid (C-1's attendance refusal), not a synthetic code
    ['V6 blocked (review required)', round({
      outcome: 'blocked', status: 'cancellation_blocked', closedBySystem: true,
      closeReason: 'business_blocked:ATTENDANCE_CANCELLATION_REVIEW_REQUIRED', blockCode: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED', canWithdraw: false,
    })],
  ]
  const NOT_APPROVED_BLOCK = round({
    outcome: 'blocked', status: 'cancellation_blocked', closedBySystem: true,
    closeReason: 'business_blocked:CANCEL_ROUND_DOCUMENT_NOT_APPROVED', blockCode: 'CANCEL_ROUND_DOCUMENT_NOT_APPROVED', canWithdraw: false,
  })

  it.each(WORDS)('T3 control — %s on an APPROVED leave carries the note', async (_label, r) => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: r }))]
    const root = await mountPanel()
    expect($(root, 'data-cancel-round-progress')).not.toBeNull()
    expect($(root, 'data-cancel-round-leave-valid')!.textContent).toContain('请假仍然有效')
  })

  it.each(WORDS)('T2 — %s on a CANCELLED leave (cancelled outside the round) does not carry the note', async (_label, r) => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: r }))]
    const root = await mountPanel({ ...LEAVE, status: 'cancelled' })
    expect($(root, 'data-cancel-round-progress')).not.toBeNull()
    expect($(root, 'data-cancel-round-leave-valid')).toBeNull()
  })

  it('T1 — a cancelled leave whose round was blocked because the leave is no longer approved: the block copy, and no note contradicting it', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: NOT_APPROVED_BLOCK }))]
    const root = await mountPanel({ ...LEAVE, status: 'cancelled' })
    expect($(root, 'data-cancel-round-block')!.textContent).toContain('该请假已不再是已通过状态')
    expect($(root, 'data-cancel-round-leave-valid')).toBeNull()
  })

  it('T4 — the block code wins over a parent row that still says approved (stale prop, or the row and the document diverged)', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: NOT_APPROVED_BLOCK }))]
    const root = await mountPanel()
    expect($(root, 'data-cancel-round-block')!.textContent).toContain('该请假已不再是已通过状态')
    expect($(root, 'data-cancel-round-leave-valid')).toBeNull()
  })
})

describe('P-5 delivery status (「Full status, no raw ids/errors」; 16:5x 「Show the list」)', () => {
  const delivery = (overrides: Record<string, unknown> = {}) => ({
    channelType: 'dingtalk_approval_card', status: 'delivered', attempts: 1,
    createdAt: '2026-09-29T01:00:00.000Z', lastAttemptAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T01:00:05.000Z',
    ...overrides,
  })

  it('one row per delivery: channel type, fixed status copy, attempts, timestamps — and nothing else off the wire', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ deliveries: [
      // extra keys a future server might add must never reach the page
      delivery({ recipientUserId: 'u-secret-1', externalMessageId: 'ext-secret-2', errorText: 'provider said secret-3' }),
      delivery({ channelType: 'dingtalk_todo', status: 'pending', attempts: 2, lastAttemptAt: '2026-09-29T02:00:00.000Z' }),
      delivery({ channelType: 'dingtalk_todo', status: 'failed', attempts: 3 }),
    ] }) }))]
    const root = await mountPanel(LEAVE, 'emp_1', { formatDateTime: (v: string | null | undefined) => `T<${v ?? '-'}>` })
    const rows = [...root.querySelectorAll<HTMLElement>('[data-cancel-round-delivery]')]
    expect(rows.map((r) => r.dataset.deliveryStatus)).toEqual(['delivered', 'pending', 'failed'])
    expect(rows.map((r) => r.querySelector('[data-cancel-round-delivery-channel]')!.textContent)).toEqual(['钉钉审批卡片', '钉钉待办', '钉钉待办'])
    expect(rows.map((r) => r.querySelector('[data-cancel-round-delivery-status]')!.textContent)).toEqual([
      '已送达', '发送中或结果待确认', '未能送达(不影响撤销申请本身)',
    ])
    expect(rows[1].querySelector('[data-cancel-round-delivery-attempts]')!.textContent).toBe('尝试 2 次')
    expect(rows[1].querySelector('[data-cancel-round-delivery-last-attempt]')!.textContent).toContain('T<2026-09-29T02:00:00.000Z>')
    expect(rows[0].querySelector('[data-cancel-round-delivery-created]')!.textContent).toContain('T<2026-09-29T01:00:00.000Z>')
    expect(rows[0].querySelector('[data-cancel-round-delivery-updated]')!.textContent).toContain('T<2026-09-29T01:00:05.000Z>')
    const text = root.textContent ?? ''
    for (const secret of ['u-secret-1', 'ext-secret-2', 'secret-3']) expect(text).not.toContain(secret)
    expect(Object.keys(normalizeCancelRoundDeliveries([delivery({ recipientUserId: 'x', id: 'y' })])![0]).sort()).toEqual(
      ['attempts', 'channelType', 'createdAt', 'lastAttemptAt', 'status', 'updatedAt'],
    )
  })

  it('a failed delivery does not change the round: the pending round keeps its V1 word and tone', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ deliveries: [delivery({ status: 'failed' })] }) }))]
    const root = await mountPanel()
    const tag = $(root, 'data-cancel-round-status')!
    expect(tag.dataset).toMatchObject({ domain: 'cancelRound', status: 'cancellation_pending_approval', tone: 'warning' })
    expect(tag.textContent).toBe('撤销申请审批中')
    const block = $(root, 'data-cancel-round-deliveries')!
    expect(block.querySelector('.ms-status-tag')).toBeNull()
    for (const word of ['驳回', '撤回', '请假已取消', '无法撤销', '失败']) expect(block.textContent).not.toContain(word)
    expect($(root, 'data-cancel-round-withdraw')).not.toBeNull()
  })

  it('an empty list is its own line; deliveries not reported at all render nothing (never 「none sent」)', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ deliveries: [] }) }))]
    const empty = await mountPanel()
    expect($(empty, 'data-cancel-round-deliveries-empty')!.textContent).toContain('暂无这条撤销申请的通知投递记录')
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round() }))]
    const absent = await mountPanel()
    expect($(absent, 'data-cancel-round-progress')).not.toBeNull()
    expect($(absent, 'data-cancel-round-deliveries')).toBeNull()
    expect($(absent, 'data-cancel-round-deliveries-empty')).toBeNull()
  })

  it('an unknown status is not reported; an unknown channel type is kept under a neutral label', async () => {
    summaries = [() => jsonResponse(200, summaryBody({ entryEnabled: true, round: round({ deliveries: [
      delivery({ status: 'outcome_unknown' }),
      delivery({ channelType: 'future_channel', status: 'delivered' }),
    ] }) }))]
    const root = await mountPanel()
    const rows = [...root.querySelectorAll<HTMLElement>('[data-cancel-round-delivery]')]
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('[data-cancel-round-delivery-channel]')!.textContent).toBe('其他通知渠道')
    expect(root.textContent).not.toContain('future_channel')
  })
})

describe('P-6 on the self-service panel (§15.6): no approver / seat names, no approval-side reads', () => {
  // Names planted on every wire object the panel receives (summary, round, deliveries, outcome, and the
  // parent list row). None of them may reach the page — text or attributes — in any state, and the panel
  // reads only the attendance cancel-round routes (never `/api/approvals/*`, which employees cannot read).
  const NAMES = ['审批人甲乙丙', 'Approver Zed Quux', 'seat-holder-u-77', '委托人丁戊']
  const planted = {
    approverName: NAMES[0],
    currentApprovers: [{ userId: NAMES[2], name: NAMES[1] }],
    assignees: [{ assigneeId: NAMES[2], assigneeName: NAMES[0], delegatedFromName: NAMES[3] }],
    seats: [{ userId: NAMES[2], displayName: NAMES[1] }],
    currentHandler: NAMES[1],
    delegatedFrom: NAMES[3],
  }
  const plantedDelivery = {
    channelType: 'dingtalk_todo', status: 'pending', attempts: 1,
    createdAt: '2026-09-29T01:00:00.000Z', lastAttemptAt: '2026-09-29T01:00:00.000Z', updatedAt: '2026-09-29T01:00:00.000Z',
    recipientName: NAMES[1], recipientUserId: NAMES[2],
  }
  function wire(overrides: Round = {}) {
    return {
      ok: true,
      data: {
        requestId: 'req-1', documentInstanceId: 'apv_1', entryEnabled: true,
        approvers: [NAMES[0]], currentApproverNames: [NAMES[1]],
        round: round({ ...planted, deliveries: [plantedDelivery], ...overrides }),
      },
    }
  }
  const PLANTED_ROW = { ...LEAVE, approver_name: NAMES[0], approved_by: NAMES[2], approver: { id: NAMES[2], name: NAMES[1] } }
  function expectNoNames(root: HTMLElement, where: string) {
    const html = root.innerHTML
    for (const name of NAMES) expect(html, `${where}: ${name}`).not.toContain(name)
  }

  it('planted names never render (pending → withdraw → launch dialog → re-launch, a withdraw closed by an approver, a launch refused for the seat, and every outcome); only attendance routes are read', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      summaries = [
        () => jsonResponse(200, wire()),
        () => jsonResponse(200, wire({ outcome: 'withdrawn', status: 'cancellation_withdrawn', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' })),
        () => jsonResponse(200, wire()),
      ]
      writes = [
        () => jsonResponse(200, { ok: true, data: { requestId: 'req-1', roundId: 'apr_1', outcome: 'withdrawn', status: 'cancellation_withdrawn' } }),
        () => jsonResponse(201, { ok: true, data: { requestId: 'req-1', roundId: 'apr_2', approverName: NAMES[0] } }),
      ]
      const root = await mountPanel(PLANTED_ROW)
      expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请审批中')
      expect(root.querySelectorAll('[data-cancel-round-delivery]')).toHaveLength(1)
      expectNoNames(root, 'pending')

      $(root, 'data-cancel-round-withdraw')!.click()
      await flushUi()
      expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请已撤回')
      expectNoNames(root, 'withdrawn')

      $(root, 'data-cancel-round-launch')!.click()
      await flushUi()
      expect($(root, 'data-cancel-round-dialog')).not.toBeNull()
      expectNoNames(root, 'launch dialog')
      $(root, 'data-cancel-round-confirm')!.click()
      await flushUi()
      expect($(root, 'data-cancel-round-status')!.textContent).toBe('撤销申请审批中')
      expectNoNames(root, 're-launched')

      // A pending round an approver has already acted on: the withdraw reason is shown (phase D, S/B gate P3-1).
      summaries = [() => jsonResponse(200, wire({ canWithdraw: false, withdrawBlockedReason: 'APPROVAL_REVOKE_WINDOW_CLOSED' }))]
      const closed = await mountPanel(PLANTED_ROW)
      expect($(closed, 'data-cancel-round-withdraw-reason')!.textContent).toContain('无法再撤回')
      expectNoNames(closed, 'withdraw closed by an approver')

      // A launch refused for the seat (P-6′): the dialog shows the weak copy, and nothing the refusal
      // body carries besides its code and message reaches the page.
      summaries = [() => jsonResponse(200, wire({ outcome: 'withdrawn', status: 'cancellation_withdrawn', canWithdraw: false, withdrawBlockedReason: 'INVALID_STATUS_TRANSITION' }))]
      writes = [() => jsonResponse(409, {
        ok: false,
        error: { code: 'CANCEL_ROUND_SEAT_INELIGIBLE', message: 'A cancellation cannot be started', approverName: NAMES[0], details: { approverId: NAMES[2], approver: NAMES[1] } },
      })]
      const refused = await mountPanel(PLANTED_ROW)
      $(refused, 'data-cancel-round-launch')!.click()
      await flushUi()
      $(refused, 'data-cancel-round-confirm')!.click()
      await flushUi()
      expect($(refused, 'data-cancel-round-dialog-error')!.textContent).toContain(CANCEL_ROUND_SEAT_CLASS_COPY.zh)
      expectNoNames(refused, 'launch refused for the seat')

      const outcomes: Array<[Round, string]> = [
        [{ outcome: 'applied', status: 'leave_cancelled', canWithdraw: false, cancellationOutcome: { status: 'cancelled', reversal: { reversed: 480, lots: 1, unrecoverableExpired: 0, alreadyReversed: false, approverName: NAMES[0] }, decidedBy: NAMES[1] } }, '请假已取消'],
        [{ outcome: 'rejected', status: 'cancellation_rejected', canWithdraw: false, rejectedBy: NAMES[1] }, '撤销申请被驳回'],
        [{ outcome: 'expired', status: 'cancellation_window_closed', closedBySystem: true, closeReason: 'round_expired', canWithdraw: false }, '撤销窗口已过,申请自动关闭'],
        [{ outcome: 'blocked', status: 'cancellation_blocked', closedBySystem: true, closeReason: 'business_blocked:FUTURE_CODE_X', blockCode: 'FUTURE_CODE_X', canWithdraw: false }, CANCEL_ROUND_BLOCK_CATEGORY_COPY.zh],
      ]
      for (const [overrides, word] of outcomes) {
        summaries = [() => jsonResponse(200, wire(overrides))]
        const r = await mountPanel(PLANTED_ROW)
        expect(r.textContent).toContain(word)
        expectNoNames(r, String(overrides.outcome))
      }

      const paths = apiFetchMock.mock.calls.map((c) => String(c[0]))
      expect(paths.length).toBeGreaterThanOrEqual(9)
      for (const p of paths) expect(p).toMatch(/^\/api\/attendance\/requests\/req-1\/cancel-round(\/withdraw)?$/)
      expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/approvals'))).toEqual([])
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('AttendanceView wiring', () => {
  it('the panel is mounted once, on LEAVE rows of 最近申请 — not in the shift-swap list', () => {
    const source = readFileSync(resolve(__dirname, '../src/views/AttendanceView.vue'), 'utf8')
    const tagIndex = source.indexOf('<AttendanceCancelRoundPanel')
    expect(tagIndex).toBeGreaterThan(-1)
    expect(source.indexOf('<AttendanceCancelRoundPanel', tagIndex + 1)).toBe(-1)
    const recentHeader = source.indexOf("tr('Recent requests', '最近申请')")
    const shiftSwapBlock = source.indexOf('data-shift-swap-requests')
    expect(recentHeader).toBeGreaterThan(-1)
    expect(tagIndex).toBeGreaterThan(recentHeader)
    expect(tagIndex).toBeLessThan(shiftSwapBlock)
    const tag = source.slice(tagIndex, source.indexOf('/>', tagIndex))
    expect(tag).toContain('v-if="item.request_type === \'leave\'"')
    expect(tag).toContain(':current-user-id="currentUserId"')
  })
})
