import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTodoCount, getTodoItems, isTodoResponseDegraded } from '../src/todo/api'

// B-2 phase 2, todo-center-design-lock §3/§4 — the todo center's own API client. These wrappers
// are the ONLY thing the center page and the nav badge are allowed to call; pinning their request
// shape and response pass-through here means neither call site can silently start re-deriving the
// per-source `sources` map instead of forwarding it (lock §3: "不得自行判断可见性").
describe('todo center api client', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    localStorage.clear()
    localStorage.setItem('auth_token', 'test-token')
  })

  it('getTodoItems calls GET /api/todo/items and returns the items + sources verbatim', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          { source: 'approval', id: 'inst-1', title: '请假申请', href: '/approvals/inst-1', updatedAt: '2026-09-18T00:00:00.000Z' },
        ],
        sources: { approval: 'ok' },
      }),
    })

    const result = await getTodoItems()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/todo/items')
    expect((options?.method ?? 'GET').toUpperCase()).toBe('GET')
    // Pass-through, not re-derived: same object shape the registry produced.
    expect(result).toEqual({
      items: [
        { source: 'approval', id: 'inst-1', title: '请假申请', href: '/approvals/inst-1', updatedAt: '2026-09-18T00:00:00.000Z' },
      ],
      sources: { approval: 'ok' },
    })
  })

  it('getTodoCount calls GET /api/todo/count and returns the count + sources verbatim', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ count: 3, sources: { approval: 'ok' } }),
    })

    const result = await getTodoCount()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/todo/count')
    expect(result).toEqual({ count: 3, sources: { approval: 'ok' } })
  })

  it('with named sources the read carries one comma-joined sources key', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0, items: [], sources: {} }) })

    await getTodoCount({ sources: ['approval'] })
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/todo\/count\?sources=approval$/)

    await getTodoItems({ sources: ['approval', 'task'] })
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/todo\/items\?sources=approval,task$/)
  })

  it('without named sources the URL has no query', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0, items: [], sources: {} }) })

    await getTodoCount()
    await getTodoItems()

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/todo\/count$/)
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/todo\/items$/)
  })

  it('both reads send the viewer time zone', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ count: 0, items: [], sources: {} }) })
    const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(),
      timeZone: 'Asia/Shanghai',
    })

    await getTodoCount()
    await getTodoItems()
    zone.mockRestore()

    for (const call of fetchMock.mock.calls) {
      const headers = new Headers((call[1] as RequestInit).headers)
      expect(headers.get('x-viewer-time-zone')).toBe('Asia/Shanghai')
    }
  })

  it('getTodoItems rejects on a non-ok response rather than inventing an empty list', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })

    await expect(getTodoItems()).rejects.toThrow()
  })

  describe('isTodoResponseDegraded', () => {
    it('is false for a genuinely ok, all-sources-ok response (negative control)', () => {
      expect(isTodoResponseDegraded({ sources: { approval: 'ok' } })).toBe(false)
    })

    it('is true when any source reports unavailable, even with a nonzero count', () => {
      expect(isTodoResponseDegraded({ sources: { approval: 'unavailable' } })).toBe(true)
    })

    it('is true when the legacy `degraded: true` flag is present, even with every source ok', () => {
      // This is the stubbed shape the design lock requires the badge to treat as unavailable —
      // `/api/todo/count` cannot emit it in this lane (double-gated by APPROVALS_OPTIONAL), so this
      // is the only place it can be exercised (todo-center-design-lock §4, 判据 B 徽标格).
      expect(isTodoResponseDegraded({ degraded: true, sources: { approval: 'ok' } })).toBe(true)
    })
  })
})
