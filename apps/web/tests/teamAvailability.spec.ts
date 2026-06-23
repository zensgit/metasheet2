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

const apiFetchMock = vi.mocked(apiFetch)

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
})
