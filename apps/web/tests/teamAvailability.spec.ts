// #6 TA-3 — team-availability service + §3c state presentation + clear-on-failure composable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../src/utils/api'
import {
  fetchTeamAvailability,
  teamAvailabilityStateMeta,
  type TeamAvailabilityResponse,
} from '../src/services/attendance/teamAvailability'
import { useTeamAvailability } from '../src/views/attendance/useTeamAvailability'
import { createApp, nextTick } from 'vue'
import AttendanceTeamAvailabilitySection from '../src/views/attendance/AttendanceTeamAvailabilitySection.vue'

const apiFetchMock = vi.mocked(apiFetch)

async function flushUi(cycles = 8): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function okPayload(): { ok: true; data: TeamAvailabilityResponse } {
  return {
    ok: true,
    data: {
      groupId: 'grp_1',
      range: { from: '2026-09-21', to: '2026-09-21' },
      members: 2,
      items: [
        { date: '2026-09-21', userId: 'u1', state: 'pending_leave' },
        { date: '2026-09-21', userId: 'u2', state: 'scheduled' },
      ],
      summary: [
        { date: '2026-09-21', scheduled: 1, rest: 0, approvedLeave: 0, pendingLeaveTentative: 1, unscheduled: 0, availableFormal: 2 },
      ],
    },
  }
}

describe('fetchTeamAvailability', () => {
  beforeEach(() => apiFetchMock.mockReset())
  afterEach(() => vi.clearAllMocks())

  it('builds the group-only URL with groupId/from/to + suppressUnauthorizedRedirect default true', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, okPayload()))
    await fetchTeamAvailability({ groupId: 'grp_1', from: '2026-09-21', to: '2026-09-22' })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [path, options] = apiFetchMock.mock.calls[0]
    expect(path).toBe('/api/attendance/team-availability?groupId=grp_1&from=2026-09-21&to=2026-09-22')
    expect((options as any)?.suppressUnauthorizedRedirect).toBe(true)
  })

  it('requires groupId (v1 group-only)', async () => {
    await expect(fetchTeamAvailability({ groupId: '', from: '2026-09-21', to: '2026-09-21' })).rejects.toThrow(/groupId/)
  })

  it('throws TeamAvailabilityFetchError carrying status/code on 403 and 404', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN', message: 'no' } }))
    await expect(fetchTeamAvailability({ groupId: 'g', from: '2026-09-21', to: '2026-09-21' }))
      .rejects.toMatchObject({ name: 'TeamAvailabilityFetchError', status: 403, code: 'FORBIDDEN' })
    apiFetchMock.mockResolvedValueOnce(jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }))
    await expect(fetchTeamAvailability({ groupId: 'g', from: '2026-09-21', to: '2026-09-21' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })
})

describe('teamAvailabilityStateMeta (§3c — provisional, distinct from approved)', () => {
  it('pending_leave is PROVISIONAL with the "待审批，未生效" tooltip', () => {
    const m = teamAvailabilityStateMeta('pending_leave')
    expect(m.provisional).toBe(true)
    expect(m.zhTooltip).toBe('待审批，未生效')
    expect(m.enTooltip).toBe('Pending approval, not yet effective')
  })
  it('pending_leave is NOT equated with approved_leave (distinct class, not provisional, no not-yet-effective tooltip)', () => {
    const pending = teamAvailabilityStateMeta('pending_leave')
    const approved = teamAvailabilityStateMeta('approved_leave')
    expect(pending.className).not.toBe(approved.className)
    expect(approved.provisional).toBe(false)
    expect(approved.zhTooltip).toBeUndefined()
  })
})

describe('useTeamAvailability — clear-on-failure invariant (403/404/failure clears old data)', () => {
  beforeEach(() => apiFetchMock.mockReset())

  it('load success sets data; a subsequent failed query CLEARS the stale table + records the status', async () => {
    const ta = useTeamAvailability()
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, okPayload()))
    await ta.load('grp_1', '2026-09-21', '2026-09-21')
    expect(ta.data.value?.members).toBe(2)
    expect(ta.errorStatus.value).toBeNull()

    // a 404 (e.g. a typo'd / deleted group) must NOT keep the previous group's table.
    apiFetchMock.mockResolvedValueOnce(jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }))
    await ta.load('ghost', '2026-09-21', '2026-09-21')
    expect(ta.data.value).toBeNull()
    expect(ta.errorStatus.value).toBe(404)
  })

  it('clears the old table at the START of a new load — no stale group while the request is in flight', async () => {
    const ta = useTeamAvailability()
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, okPayload()))
    await ta.load('grp_1', '2026-09-21', '2026-09-21')
    expect(ta.data.value?.members).toBe(2)

    // a second load whose request never resolves in this tick → the old data must be gone synchronously.
    let resolveSecond: (r: Response) => void = () => {}
    apiFetchMock.mockReturnValueOnce(new Promise<Response>((res) => { resolveSecond = res }))
    const pending = ta.load('grp_b', '2026-09-22', '2026-09-22') // NOT awaited
    expect(ta.data.value).toBeNull() // group A's table cleared the instant group B's load begins
    expect(ta.loading.value).toBe(true)
    resolveSecond(jsonResponse(200, okPayload()))
    await pending
  })
})

describe('AttendanceTeamAvailabilitySection — RENDER (the owner-enumerated §3c vitest criterion)', () => {
  beforeEach(() => apiFetchMock.mockReset())

  function mountSection() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    // ZH locale so the rendered tooltip is the §3c "待审批，未生效".
    const app = createApp(AttendanceTeamAvailabilitySection, { tr: (_en: string, zh: string) => zh })
    app.mount(container)
    const fillForm = () => {
      for (const [sel, value] of [['#attendance-ta-group', 'grp_1'], ['#attendance-ta-from', '2026-09-21'], ['#attendance-ta-to', '2026-09-21']] as const) {
        const el = container.querySelector(sel) as HTMLInputElement
        el.value = value
        el.dispatchEvent(new Event('input'))
      }
    }
    const clickLoad = () => (container.querySelector('.attendance__btn--primary') as HTMLButtonElement).click()
    return { container, app, fillForm, clickLoad }
  }

  it('a mocked pending_leave item renders a PROVISIONAL matrix cell carrying the "待审批，未生效" tooltip; scheduled does not', async () => {
    const { container, app, fillForm, clickLoad } = mountSection()
    await flushUi()
    fillForm()
    await flushUi()
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, okPayload())) // u1 pending_leave + u2 scheduled
    clickLoad()
    await flushUi()

    const matrix = container.querySelector('[data-attendance-team-availability-matrix]')
    expect(matrix, 'matrix renders after a successful load').toBeTruthy()
    const provisional = matrix!.querySelectorAll('.attendance-ta__chip--provisional')
    expect(provisional.length).toBe(1) // ONLY the pending_leave member's cell is provisional
    expect((provisional[0] as HTMLElement).getAttribute('title')).toContain('待审批，未生效')
    // 1 date × 2 members = 2 state cells; exactly one provisional → the scheduled cell is NOT provisional.
    expect(matrix!.querySelectorAll('.attendance-ta__chip:not(.attendance-ta__chip--none)').length).toBe(2)

    app.unmount()
    container.remove()
  })

  it('a failed (404) load clears the rendered table — no stale matrix, error shown', async () => {
    const { container, app, fillForm, clickLoad } = mountSection()
    await flushUi()
    fillForm()
    await flushUi()
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, okPayload()))
    clickLoad()
    await flushUi()
    expect(container.querySelector('[data-attendance-team-availability-matrix]')).toBeTruthy()

    apiFetchMock.mockResolvedValueOnce(jsonResponse(404, { ok: false, error: { code: 'NOT_FOUND', message: 'gone' } }))
    clickLoad()
    await flushUi()
    expect(container.querySelector('[data-attendance-team-availability-matrix]')).toBeNull()
    expect(container.querySelector('[data-attendance-team-availability-error]')).toBeTruthy()

    app.unmount()
    container.remove()
  })

  it('starting a NEW load immediately removes the previous matrix (no stale table in-flight)', async () => {
    const { container, app, fillForm, clickLoad } = mountSection()
    await flushUi()
    fillForm()
    await flushUi()
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, okPayload()))
    clickLoad()
    await flushUi()
    expect(container.querySelector('[data-attendance-team-availability-matrix]')).toBeTruthy()

    // a second load whose request never resolves → the matrix must vanish the instant the load starts.
    apiFetchMock.mockReturnValueOnce(new Promise<Response>(() => { /* never resolves */ }))
    clickLoad()
    await flushUi()
    expect(container.querySelector('[data-attendance-team-availability-matrix]')).toBeNull()

    app.unmount()
    container.remove()
  })
})
