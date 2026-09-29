/**
 * 请假撤销入口(阶段 B2)—— 考勤侧「待我审批的撤销」列表(AttendanceCancelRoundApproverPanel,owner 2026-09-29
 * 16:5x 「Attendance-side list (Recommended)」):只对持 `attendance:approve`(或 `attendance:admin` / 管理员)
 * 的查看者读取;首读为空或仍在读时不渲染卡片,有待办行或读失败时才出现,出现后在页面生命周期内保留(设计 MD
 * §9 第 22 项);读失败与「没有待办」不同形;每行通过 / 驳回走 `POST …/cancel-round/actions`,先读摘要
 * 确认轮次(实例 id 与轮次 id 都要对上、且仍在审批中),办理后核对 `data.roundId`;办理后重读列表。
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

import AttendanceCancelRoundApproverPanel from '../src/views/attendance/AttendanceCancelRoundApproverPanel.vue'
import { useLocale } from '../src/composables/useLocale'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// `Response.json()` settles on a macrotask, so each cycle also yields one timer turn.
async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
    await nextTick()
  }
}

const PENDING_PATH = '/api/attendance/cancel-rounds/pending'

function item(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'req-1',
    roundId: 'round-1',
    engineInstanceId: 'cr_1',
    requesterUserId: 'emp_1',
    requesterName: '张三',
    requestType: 'leave',
    startAt: '2026-09-30T01:00:00.000Z',
    endAt: '2026-09-30T09:00:00.000Z',
    launchedAt: '2026-09-29T02:00:00.000Z',
    ...overrides,
  }
}
const listBody = (items: unknown[], total = items.length) => ({ ok: true, data: { items, total } })

/** The leave's latest round as the summary read reports it, keyed by attendance request id. */
let latestRound: Record<string, Record<string, unknown> | null>
let summaryFails: Set<string>
let lists: Array<() => Response>
let actionResponses: Array<() => Response>
const pendingRound = (overrides: Record<string, unknown> = {}) => ({
  roundId: 'round-1', engineInstanceId: 'cr_1', outcome: 'pending', status: 'cancellation_pending_approval',
  startedAt: 's', endedAt: null, closeReason: null, blockCode: null, closedBySystem: false,
  canWithdraw: false, withdrawBlockedReason: 'APPROVAL_REVOKE_FORBIDDEN', cancellationOutcome: null,
  ...overrides,
})

function installFetch() {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (path === PENDING_PATH && method === 'GET') {
      const next = lists.length > 1 ? lists.shift()! : lists[0]
      return next()
    }
    const match = /^\/api\/attendance\/requests\/([^/]+)\/cancel-round(\/actions)?$/.exec(path)
    if (!match) throw new Error(`unexpected ${method} ${path}`)
    const requestId = decodeURIComponent(match[1])
    if (match[2] && method === 'POST') {
      const queued = actionResponses.shift()
      if (queued) return queued()
      const round = latestRound[requestId]
      return jsonResponse(200, { ok: true, data: { requestId, roundId: round?.roundId ?? null, outcome: 'applied', status: 'leave_cancelled' } })
    }
    if (summaryFails.has(requestId)) return jsonResponse(500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } })
    // entryEnabled is false on purpose: the launch flag gates launching, never deciding.
    return jsonResponse(200, { ok: true, data: { requestId, documentInstanceId: 'apv_orig', entryEnabled: false, round: latestRound[requestId] ?? null } })
  })
}
const calls = () => apiFetchMock.mock.calls.map((c) => [(c[1] as RequestInit | undefined)?.method ?? 'GET', c[0], (c[1] as RequestInit | undefined)?.body ?? null])
const posts = () => calls().filter((c) => c[0] === 'POST')

const apps: VueApp[] = []
async function mountPanel(props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(AttendanceCancelRoundApproverPanel, { canDecide: true, ...props } as never) })
  app.mount(container)
  apps.push(app)
  await flushUi()
  return container
}
const $ = (root: HTMLElement, attr: string) => root.querySelector<HTMLElement>(`[${attr}]`)
const click = async (root: HTMLElement, attr: string) => {
  $(root, attr)!.click()
  await flushUi()
}

beforeEach(() => {
  apiFetchMock.mockReset()
  latestRound = { 'req-1': pendingRound(), 'req-2': pendingRound({ roundId: 'round-2', engineInstanceId: 'cr_2' }) }
  summaryFails = new Set()
  lists = [() => jsonResponse(200, listBody([item()]))]
  actionResponses = []
  installFetch()
  useLocale().setLocale('zh-CN')
})

afterEach(() => {
  while (apps.length) apps.pop()!.unmount()
  document.body.innerHTML = ''
  useLocale().setLocale('en')
})

describe('visibility and read states', () => {
  it('without the grant (canDecide false): nothing rendered and nothing read', async () => {
    const root = await mountPanel({ canDecide: false })
    expect($(root, 'data-cancel-round-pending')).toBeNull()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('reads the agreed route and lists the viewer\'s pending cancellations: requester, leave, V1 word, no approver names', async () => {
    lists = [() => jsonResponse(200, listBody([item(), item({ requestId: 'req-2', roundId: 'round-2', engineInstanceId: 'cr_2', requesterName: null, requesterUserId: 'emp_2' })]))]
    const root = await mountPanel()
    expect(calls()).toEqual([['GET', PENDING_PATH, null]])
    const rows = root.querySelectorAll<HTMLElement>('[data-cancel-round-pending-item]')
    expect([...rows].map((r) => r.dataset.cancelRoundPendingItem)).toEqual(['req-1', 'req-2'])
    expect(rows[0].textContent).toContain('张三')
    expect(rows[0].textContent).toContain('请假')
    expect(rows[1].textContent).toContain('用户 emp_2')
    const tag = rows[0].querySelector<HTMLElement>('[data-cancel-round-pending-status]')!
    expect(tag.dataset).toMatchObject({ domain: 'cancelRound', status: 'cancellation_pending_approval' })
    expect(tag.textContent).toBe('撤销申请审批中')
    expect($(root, 'data-cancel-round-pending-total')!.textContent).toBe('2')
    expect($(root, 'data-cancel-round-pending-empty')).toBeNull()
    expect($(root, 'data-cancel-round-pending-error')).toBeNull()
  })

  it('an empty first read renders no card at all; a failed read is a card of its own — never the same shape', async () => {
    lists = [() => jsonResponse(200, listBody([]))]
    const empty = await mountPanel()
    expect(calls()).toEqual([['GET', PENDING_PATH, null]])
    expect($(empty, 'data-cancel-round-pending')).toBeNull()
    expect(empty.textContent).toBe('')

    for (const failed of [
      () => jsonResponse(500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } }),
      () => jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } }),
      () => jsonResponse(200, { ok: true, data: { total: 0 } }),
      () => jsonResponse(200, listBody([item({ roundId: undefined })])),
    ]) {
      lists = [failed]
      const root = await mountPanel()
      expect($(root, 'data-cancel-round-pending')!.dataset.cancelRoundPendingState).toBe('error')
      expect($(root, 'data-cancel-round-pending-error')!.textContent).toContain('待我审批的撤销申请暂时无法读取')
      expect($(root, 'data-cancel-round-pending-empty')).toBeNull()
      expect($(root, 'data-cancel-round-pending-list')).toBeNull()
      expect(root.textContent).not.toContain('暂无待我审批的撤销申请')
    }
  })

  it('no card while the first read is in flight; it appears when the read lands with rows', async () => {
    let release: (response: Response) => void = () => {}
    lists = [(() => new Promise<Response>((resolve) => { release = resolve })) as unknown as () => Response]
    const root = await mountPanel()
    expect(calls()).toEqual([['GET', PENDING_PATH, null]])
    expect($(root, 'data-cancel-round-pending')).toBeNull()
    expect(root.textContent).toBe('')
    release(jsonResponse(200, listBody([item()])))
    await flushUi()
    expect($(root, 'data-cancel-round-pending')!.dataset.cancelRoundPendingState).toBe('ready')
    expect($(root, 'data-cancel-round-pending-item')!.dataset.cancelRoundPendingItem).toBe('req-1')
  })

  it('once shown the card stays: a failed read retried into an empty list shows the empty line', async () => {
    lists = [
      () => jsonResponse(503, { ok: false, error: { code: 'DB_NOT_READY', message: 'x' } }),
      () => jsonResponse(200, listBody([])),
    ]
    const root = await mountPanel()
    expect($(root, 'data-cancel-round-pending-error')).not.toBeNull()
    await click(root, 'data-cancel-round-pending-retry')
    expect($(root, 'data-cancel-round-pending')!.dataset.cancelRoundPendingState).toBe('ready')
    expect($(root, 'data-cancel-round-pending-empty')!.textContent).toContain('暂无待我审批的撤销申请')
    expect($(root, 'data-cancel-round-pending-error')).toBeNull()
  })

  it('retry after a failed read re-reads and renders the list', async () => {
    lists = [
      () => jsonResponse(503, { ok: false, error: { code: 'DB_NOT_READY', message: 'x' } }),
      () => jsonResponse(200, listBody([item()])),
    ]
    const root = await mountPanel()
    expect($(root, 'data-cancel-round-pending-error')).not.toBeNull()
    await click(root, 'data-cancel-round-pending-retry')
    expect($(root, 'data-cancel-round-pending-item')).not.toBeNull()
    expect($(root, 'data-cancel-round-pending-error')).toBeNull()
  })

  it('the deep-link request id marks its row and brings it into view once; the page is told', async () => {
    const original = HTMLElement.prototype.scrollIntoView
    const scrolled = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrolled
    try {
      lists = [() => jsonResponse(200, listBody([item(), item({ requestId: 'req-2', roundId: 'round-2', engineInstanceId: 'cr_2' })]))]
      const shown = vi.fn()
      const root = await mountPanel({ focusRequestId: 'req-2', onFocusedRowShown: shown })
      const focused = root.querySelectorAll<HTMLElement>('[data-cancel-round-pending-focused="true"]')
      expect([...focused].map((r) => r.dataset.cancelRoundPendingItem)).toEqual(['req-2'])
      expect(scrolled).toHaveBeenCalledTimes(1)
      expect(scrolled.mock.instances[0]).toBe(focused[0])
      expect(shown.mock.calls).toEqual([['req-2']])
      // a re-read (e.g. after a decision on another row) does not scroll again
      await click(root, 'data-cancel-round-pending-reload')
      expect(scrolled).toHaveBeenCalledTimes(1)
      expect(shown).toHaveBeenCalledTimes(1)
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('a deep-link id that is not in the list scrolls nothing and tells the page nothing', async () => {
    const original = HTMLElement.prototype.scrollIntoView
    const scrolled = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrolled
    try {
      const shown = vi.fn()
      const root = await mountPanel({ focusRequestId: 'req-elsewhere', onFocusedRowShown: shown })
      expect(root.querySelector('[data-cancel-round-pending-focused="true"]')).toBeNull()
      expect(scrolled).not.toHaveBeenCalled()
      expect(shown).not.toHaveBeenCalled()
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })
})

describe('decisions go through the attendance route with the round confirmed', () => {
  it('通过: summary pre-read → POST actions → list re-read; success is announced and the row leaves (the card stays)', async () => {
    lists = [() => jsonResponse(200, listBody([item()])), () => jsonResponse(200, listBody([]))]
    const root = await mountPanel()
    await click(root, 'data-cancel-round-pending-approve')
    expect($(root, 'data-cancel-round-pending-confirm')!.dataset.confirmAction).toBe('approve')
    // the confirmation says what the click does, not the round's outcome (countersign needs every seat)
    expect($(root, 'data-cancel-round-pending-confirm')!.textContent).toContain('撤销申请全部审批通过后,该请假才会被取消')
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    await click(root, 'data-cancel-round-pending-confirm-submit')
    expect(calls()).toEqual([
      ['GET', PENDING_PATH, null],
      ['GET', '/api/attendance/requests/req-1/cancel-round', null],
      ['POST', '/api/attendance/requests/req-1/cancel-round/actions', JSON.stringify({ action: 'approve' })],
      ['GET', PENDING_PATH, null],
    ])
    const notice = $(root, 'data-cancel-round-pending-notice')!
    expect(notice.dataset.noticeKind).toBe('success')
    expect(notice.textContent).toContain('已提交通过意见')
    expect($(root, 'data-cancel-round-pending-item')).toBeNull()
    expect($(root, 'data-cancel-round-pending-empty')).not.toBeNull()
  })

  it('驳回 sends the optional comment; cancelling the confirmation sends nothing', async () => {
    const root = await mountPanel()
    await click(root, 'data-cancel-round-pending-reject')
    await click(root, 'data-cancel-round-pending-confirm-cancel')
    expect($(root, 'data-cancel-round-pending-confirm')).toBeNull()
    expect(posts()).toHaveLength(0)

    await click(root, 'data-cancel-round-pending-reject')
    const textarea = $(root, 'data-cancel-round-pending-comment') as HTMLTextAreaElement
    textarea.value = '  时间冲突  '
    textarea.dispatchEvent(new Event('input'))
    await click(root, 'data-cancel-round-pending-confirm-submit')
    expect(posts()).toEqual([['POST', '/api/attendance/requests/req-1/cancel-round/actions', JSON.stringify({ action: 'reject', comment: '时间冲突' })]])
    expect($(root, 'data-cancel-round-pending-notice')!.textContent).toContain('已提交驳回意见')
  })

  it('a stale row is never decided: another instance, another round id, a closed round, or an unreadable summary ⇒ nothing sent', async () => {
    for (const stale of [
      () => { latestRound['req-1'] = pendingRound({ engineInstanceId: 'cr_newer', roundId: 'round-newer' }) },
      () => { latestRound['req-1'] = pendingRound({ roundId: 'round-other' }) },
      () => { latestRound['req-1'] = pendingRound({ outcome: 'withdrawn', status: 'cancellation_withdrawn' }) },
      () => { latestRound['req-1'] = null },
      () => { summaryFails.add('req-1') },
    ]) {
      latestRound = { 'req-1': pendingRound() }
      summaryFails = new Set()
      stale()
      apiFetchMock.mockClear()
      const root = await mountPanel()
      await click(root, 'data-cancel-round-pending-approve')
      await click(root, 'data-cancel-round-pending-confirm-submit')
      expect(posts()).toHaveLength(0)
      const notice = $(root, 'data-cancel-round-pending-notice')!
      expect(notice.dataset.noticeKind).toBe('error')
      expect(notice.textContent).toContain('未执行任何操作')
      // the list is re-read so the stale row does not stay on screen unexplained
      expect(calls().filter((c) => c[1] === PENDING_PATH)).toHaveLength(2)
    }
  })

  it('a decision the server attributes to another round is "could not confirm" — neither success nor failure', async () => {
    actionResponses.push(() => jsonResponse(200, { ok: true, data: { requestId: 'req-1', roundId: 'round-other', outcome: 'applied', status: 'leave_cancelled' } }))
    const root = await mountPanel()
    await click(root, 'data-cancel-round-pending-approve')
    await click(root, 'data-cancel-round-pending-confirm-submit')
    expect(posts()).toHaveLength(1)
    const notice = $(root, 'data-cancel-round-pending-notice')!
    expect(notice.dataset.noticeKind).toBe('unconfirmed')
    expect(notice.textContent).toContain('操作已提交,但无法确认')
    expect(notice.textContent).not.toContain('已提交通过意见')
    expect(notice.textContent).not.toContain('失败')
  })

  it('server refusals keep their mapped copy: a retryable 503 is V8 (warning), a no-seat 403 keeps the server sentence', async () => {
    actionResponses.push(
      () => jsonResponse(503, { ok: false, error: { code: 'CANCEL_ROUND_DISPATCH_CONTENDED', message: 'x' } }),
      () => jsonResponse(403, { ok: false, error: { code: 'APPROVAL_ASSIGNMENT_REQUIRED', message: 'Approval assignment not found for actor' } }),
    )
    const root = await mountPanel()
    await click(root, 'data-cancel-round-pending-approve')
    await click(root, 'data-cancel-round-pending-confirm-submit')
    const busyNotice = $(root, 'data-cancel-round-pending-notice')!
    expect(busyNotice.querySelector<HTMLElement>('.ms-status-tag')!.dataset).toMatchObject({ domain: 'cancelRound', status: 'system_busy_retry', tone: 'warning' })
    expect(busyNotice.textContent).toContain('仍在审批中')

    await click(root, 'data-cancel-round-pending-approve')
    await click(root, 'data-cancel-round-pending-confirm-submit')
    expect($(root, 'data-cancel-round-pending-notice')!.textContent).toContain('Approval assignment not found for actor')
    expect(posts()).toHaveLength(2)
  })
})

describe('AttendanceView wiring', () => {
  const source = readFileSync(resolve(__dirname, '../src/views/AttendanceView.vue'), 'utf8')

  it('mounted once, as its own overview card before (not inside) the collapsed request tools', () => {
    const tagIndex = source.indexOf('<AttendanceCancelRoundApproverPanel')
    expect(tagIndex).toBeGreaterThan(-1)
    expect(source.indexOf('<AttendanceCancelRoundApproverPanel', tagIndex + 1)).toBe(-1)
    const toolsIndex = source.indexOf('data-attendance-request-tools')
    expect(toolsIndex).toBeGreaterThan(tagIndex)
    // not nested in any <details>: every <details> opened before the tag is closed before it
    const before = source.slice(0, tagIndex)
    expect(before.split('<details').length).toBe(before.split('</details>').length)
    const tag = source.slice(tagIndex, source.indexOf('/>', tagIndex))
    expect(tag).toContain('v-if="showOverview"')
    expect(tag).toContain(':can-decide="cancelRoundApproverVisible"')
    expect(tag).toContain(':focus-request-id="focusedAttendanceRequestId"')
    expect(tag).toContain('@focused-row-shown="cancelRoundApproverLandedFor = $event"')
  })

  it('the deep-link section scroll leaves the approver row in view once the list has shown it', () => {
    const fn = source.slice(source.indexOf('async function focusInitialAttendanceSection('), source.indexOf('\nfunction ', source.indexOf('async function focusInitialAttendanceSection(')))
    expect(fn).toContain('cancelRoundApproverLandedFor.value === props.initialRequestId.trim()')
    expect(fn).toContain("if (!approverRowShown) target.scrollIntoView({ behavior: 'auto', block: 'start' })")
    expect(fn.match(/scrollIntoView\(/g)).toHaveLength(1)
  })

  it('the grant predicate is the shared canDecideCancelRoundWith over the session access snapshot', () => {
    const decl = source.slice(source.indexOf('const cancelRoundApproverVisible'), source.indexOf('))', source.indexOf('const cancelRoundApproverVisible')) + 2)
    expect(decl).toContain("typeof auth.getAccessSnapshot === 'function'")
    expect(decl).toContain('canDecideCancelRoundWith(auth.getAccessSnapshot())')
  })
})
