import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import Card from '../src/views/attendance/AttendanceBusinessTripRequestCard.vue'
import { apiFetch } from '../src/utils/api'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
const send = vi.mocked(apiFetch)
const operationId = '00000000-0000-4000-8000-000000000001'
let app: App | null = null
let container: HTMLDivElement | null = null
const refresh = vi.fn(async () => {})
function fixture() {
  const guard = createAttendanceSessionGuard('org-a', () => 'principal-a')
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(Card, { tr: (_en: string, zh: string) => zh, refreshRequests: refresh })
  app.provide(attendanceSessionGuardKey, guard)
  app.mount(container)
  const root = container
  const edit = async (selector: string, value: string) => {
    const input = root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector)!
    input.value = value
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    await nextTick()
  }
  const open = async () => { root.querySelector<HTMLButtonElement>('[data-trip-open]')!.click(); await nextTick() }
  const fill = async (zone = 'Asia/Singapore', start = '2026-10-15T09:00', end = '2026-10-15T18:00') => {
    await open()
    await edit('[data-trip-zone]', zone)
    await edit('[data-trip-local="startAt"]', start)
    await edit('[data-trip-local="endAt"]', end)
  }
  const submit = async () => {
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
  }
  return { guard, root, fill, edit, submit }
}
function reply(orgId = 'org-a'): Response {
  return new Response(JSON.stringify({ ok: true, data: {
    request: { id: 'request-a' },
    businessTrip: { requestId: 'request-a', orgId, destinationTimezone: 'Asia/Singapore',
      startAt: '2026-10-15T01:00:00.000Z', endAt: '2026-10-15T10:00:00.000Z' },
  } }))
}
function body(): Record<string, string> {
  return JSON.parse(String(send.mock.calls[0][1]?.body))
}
beforeEach(() => {
  send.mockReset()
  refresh.mockClear()
  vi.stubGlobal('crypto', { randomUUID: () => operationId })
})
afterEach(() => {
  app?.unmount(); app = null; container?.remove(); container = null
  vi.unstubAllGlobals()
})

describe('business trip destination timezone form', () => {
  it('does not read or write before explicit submission', () => {
    fixture()
    expect(send).not.toHaveBeenCalled()
  })
  it('shows both unique destination offsets before submitting', async () => {
    const f = fixture()
    await f.fill()
    expect(f.root.querySelector('[data-trip-offset="startAt"]')?.textContent).toContain('UTC+08:00')
    expect(f.root.querySelector('[data-trip-offset="endAt"]')?.textContent).toContain('UTC+08:00')
    expect(send).not.toHaveBeenCalled()
  })
  it('shows the actual offset independently at each endpoint across a DST change', async () => {
    const f = fixture()
    await f.fill('America/New_York', '2026-07-01T09:00', '2026-12-01T18:00')
    expect(f.root.querySelector('[data-trip-offset="startAt"]')?.textContent).toContain('UTC-04:00')
    expect(f.root.querySelector('[data-trip-offset="endAt"]')?.textContent).toContain('UTC-05:00')
    expect(send).not.toHaveBeenCalled()
  })
  it('posts exact destination UTC endpoints through the dedicated route', async () => {
    send.mockResolvedValueOnce(reply())
    const f = fixture()
    await f.fill()
    await f.submit()
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
    expect(send.mock.calls[0][0]).toBe('/api/attendance/business-trip-requests')
    expect(body()).toEqual({ destinationTimezone: 'Asia/Singapore', startAt: '2026-10-15T01:00:00.000Z',
      endAt: '2026-10-15T10:00:00.000Z', operationId })
    expect(f.root.textContent).toContain('出差申请已提交，审批通过后生效。')
  })
  it('requires an explicit choice for a repeated destination time', async () => {
    send.mockRejectedValueOnce(new Error('network'))
    const f = fixture()
    await f.fill('America/New_York', '2026-11-01T01:30', '2026-11-01T03:00')
    await f.submit()
    expect(send).not.toHaveBeenCalled()
    await f.edit('[data-trip-fold="startAt"]', '2026-11-01T06:30:00.000Z')
    await f.submit()
    await vi.waitFor(() => { expect(send).toHaveBeenCalledOnce() })
    expect(body().startAt).toBe('2026-11-01T06:30:00.000Z')
    expect(body().endAt).toBe('2026-11-01T08:00:00.000Z')
  })
  it('rejects nonexistent destination times without shifting them', async () => {
    const f = fixture()
    await f.fill('America/New_York', '2026-03-08T02:30', '2026-03-08T04:00')
    await f.submit()
    expect(send).not.toHaveBeenCalled()
    expect(f.root.textContent).toContain('该当地时间不存在')
  })
  it('rejects an end before the start', async () => {
    const f = fixture()
    await f.fill('Asia/Singapore', '2026-10-15T18:00', '2026-10-15T09:00')
    await f.submit()
    expect(send).not.toHaveBeenCalled()
  })
  it.each([403, 409, 422, 503])('uses a fixed error for server refusal %s', async status => {
    send.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: { message: 'synthetic-sensitive-value' } }), { status }))
    const f = fixture()
    await f.fill()
    await f.submit()
    await vi.waitFor(() => { expect(f.root.querySelector('[role="alert"]')).not.toBeNull() })
    expect(f.root.textContent).not.toContain('synthetic-sensitive-value')
    expect(refresh).not.toHaveBeenCalled()
  })
  it('reuses the same operation identity after an uncertain network result', async () => {
    send.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(reply())
    const f = fixture()
    await f.fill()
    await f.submit()
    await vi.waitFor(() => { expect(f.root.querySelector('[role="alert"]')).not.toBeNull() })
    await f.submit()
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
    expect(send.mock.calls[1][1]?.body).toBe(send.mock.calls[0][1]?.body)
  })
  it('creates a fresh operation identity after a confirmed successful submission', async () => {
    const nextId = '00000000-0000-4000-8000-000000000002'
    const nonce = vi.fn().mockReturnValueOnce(operationId).mockReturnValueOnce(nextId)
    vi.stubGlobal('crypto', { randomUUID: nonce })
    send.mockResolvedValueOnce(reply()).mockResolvedValueOnce(reply())
    const f = fixture()
    await f.fill()
    await f.submit()
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledTimes(1) })
    await f.fill()
    await f.submit()
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledTimes(2) })
    expect(JSON.parse(String(send.mock.calls[0][1]?.body)).operationId).toBe(operationId)
    expect(JSON.parse(String(send.mock.calls[1][1]?.body)).operationId).toBe(nextId)
  })
  it('refuses a foreign organization acknowledgement', async () => {
    send.mockResolvedValueOnce(reply('org-b'))
    const f = fixture()
    await f.fill()
    await f.submit()
    await vi.waitFor(() => { expect(f.root.querySelector('[role="alert"]')).not.toBeNull() })
    expect(refresh).not.toHaveBeenCalled()
  })
  it('discards in-flight acknowledgements after the session changes', async () => {
    let finish!: (response: Response) => void
    send.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    const f = fixture()
    await f.fill()
    await f.submit()
    f.guard.invalidate()
    await nextTick()
    finish(reply())
    await nextTick()
    await nextTick()
    expect(refresh).not.toHaveBeenCalled()
    expect(f.root.textContent).not.toContain('出差申请已提交')
    expect(f.root.querySelector('form')).toBeNull()
  })
  it('fails without sending when secure UUID generation is unavailable', async () => {
    vi.stubGlobal('crypto', {})
    const f = fixture()
    await f.fill()
    await f.submit()
    expect(send).not.toHaveBeenCalled()
    expect(f.root.textContent).toContain('无法生成申请标识')
  })
})
