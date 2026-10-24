import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import Panel from '../src/views/attendance/AttendanceGroupMembershipPolicyPanel.vue'
import { apiFetch } from '../src/utils/api'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
const send = vi.mocked(apiFetch)
const URL = '/api/attendance/group-membership-policy?orgId=org-a'
const policy = (allowMultipleGroups = false, version = 0, orgId = 'org-a') => ({
  ok: true, data: { orgId, allowMultipleGroups, version },
})
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let app: App | null = null
let root: HTMLDivElement
let principal: string

function fixture() {
  root = document.createElement('div')
  document.body.appendChild(root)
  const guard = createAttendanceSessionGuard('org-a', () => principal)
  app = createApp(Panel, { tr: (en: string) => en })
  app.provide(attendanceSessionGuardKey, guard)
  app.mount(root)
  return guard
}
function button(name: 'refresh' | 'save'): HTMLButtonElement {
  return root.querySelector('[data-membership-' + name + ']')!
}
function has(selector: string): boolean { return root.querySelector(selector) !== null }
async function load(): Promise<void> {
  button('refresh').click()
  await nextTick()
  await vi.waitFor(() => { expect(button('refresh').disabled).toBe(false) })
}
async function propose(value = true): Promise<void> {
  const checkbox = root.querySelector<HTMLInputElement>('[data-membership-allow-multiple]')!
  checkbox.checked = value
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
}
async function save(): Promise<void> {
  button('save').click()
  await nextTick()
  await vi.waitFor(() => { expect(button('refresh').disabled).toBe(false) })
}
function deferred<T>() {
  let finish!: (value: T) => void
  const promise = new Promise<T>(resolve => { finish = resolve })
  return { promise, finish }
}
beforeEach(() => { send.mockReset(); principal = 'principal-a' })
afterEach(() => { app?.unmount(); app = null; root?.remove() })

describe('attendance group membership policy', () => {
  it('waits for explicit loading and explains legacy and calculation boundaries', () => {
    fixture()
    expect(send).not.toHaveBeenCalled()
    expect(button('save').disabled).toBe(true)
    expect(root.textContent).toContain('not allowed by default')
    expect(root.textContent).toContain('existing members are kept and history is not recomputed')
    expect(root.textContent).toContain('does not allow multiple calculation attributions on the same day')
  })

  it('loads OFF version zero and leaves unchanged save disabled', async () => {
    send.mockResolvedValueOnce(response(policy()))
    fixture(); await load()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(URL, { method: 'GET' })
    expect(root.querySelector<HTMLInputElement>('[data-membership-allow-multiple]')!.checked).toBe(false)
    expect(button('save').disabled).toBe(true)
  })

  it('saves the exact versioned proposal then reads current state before success', async () => {
    send.mockResolvedValueOnce(response(policy()))
      .mockResolvedValueOnce(response(policy(true, 1)))
      .mockResolvedValueOnce(response(policy(true, 1)))
    fixture(); await load(); await propose(); await save()
    expect(send).toHaveBeenNthCalledWith(2, URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowMultipleGroups: true, expectedVersion: 0 }),
    })
    expect(send).toHaveBeenNthCalledWith(3, URL, { method: 'GET' })
    expect(has('[data-membership-saved]')).toBe(true)
    expect(button('save').disabled).toBe(true)
  })

  it.each([401, 403, 404])('refuses unavailable status %s without treating it as OFF', async status => {
    send.mockResolvedValueOnce(response({ ok: false, error: { message: 'private-value' } }, status))
    fixture(); await load()
    expect(root.textContent).toContain('permission')
    expect(root.textContent).not.toContain('private-value')
    expect(has('[data-membership-current]')).toBe(false)
    expect(button('save').disabled).toBe(true)
  })

  it.each([
    { ok: false, data: policy().data },
    { data: policy().data },
    policy(false, 0, 'org-b'),
    policy(false, -1),
    policy(false, 0.5),
    { ok: true, data: { ...policy().data, allowMultipleGroups: 'false' } },
    { ok: true, data: { orgId: 'org-a', allowMultipleGroups: false } },
  ])('rejects a malformed, non-success or foreign GET envelope', async body => {
    send.mockResolvedValueOnce(response(body))
    fixture(); await load()
    expect(has('[data-membership-error]')).toBe(true)
    expect(has('[data-membership-current]')).toBe(false)
    expect(button('save').disabled).toBe(true)
  })

  it.each([policy(false, 1), policy(true, 0), policy(true, 1, 'org-b')])(
    'requires the exact boolean, version and organization in a save ACK', async ack => {
      send.mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response(ack))
      fixture(); await load(); await propose(); await save()
      expect(send).toHaveBeenCalledTimes(2)
      expect(has('[data-membership-saved]')).toBe(false)
      expect(button('save').disabled).toBe(true)
      expect(root.textContent).toContain('unknown')
    },
  )

  it.each([409, 503])('requires refresh after an unsuccessful save %s', async status => {
    send.mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response({ ok: false }, status))
    fixture(); await load(); await propose(); await save()
    button('save').click(); await nextTick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(has('[data-membership-saved]')).toBe(false)
    expect(button('save').disabled).toBe(true)
  })

  it('does not claim saved when confirming refresh fails', async () => {
    send.mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response(policy(true, 1)))
      .mockRejectedValueOnce(new Error('private-value'))
    fixture(); await load(); await propose(); await save()
    expect(has('[data-membership-saved]')).toBe(false)
    expect(button('save').disabled).toBe(true)
    expect(root.textContent).not.toContain('private-value')
  })

  it('requires refresh after an uncertain network write', async () => {
    send.mockResolvedValueOnce(response(policy())).mockRejectedValueOnce(new Error('private-value'))
    fixture(); await load(); await propose(); await save()
    button('save').click(); await nextTick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(has('[data-membership-saved]')).toBe(false)
    expect(button('save').disabled).toBe(true)
    expect(root.textContent).not.toContain('private-value')
  })

  it('discards a late GET through the real session guard', async () => {
    const pending = deferred<Response>()
    send.mockReturnValueOnce(pending.promise)
    const guard = fixture()
    button('refresh').click(); await nextTick()
    guard.invalidate(); await nextTick()
    pending.finish(response(policy(true, 9)))
    await vi.waitFor(() => { expect(has('[data-membership-current]')).toBe(false) })
    expect(has('[data-membership-saved]')).toBe(false)
    button('refresh').click(); await nextTick()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('blocks a changed principal before sending a save', async () => {
    send.mockResolvedValueOnce(response(policy()))
    fixture(); await load(); await propose()
    principal = 'principal-b'
    button('save').click(); await nextTick()
    expect(send).toHaveBeenCalledTimes(1)
    expect(has('[data-membership-saved]')).toBe(false)
    expect(button('save').disabled).toBe(true)
  })

  it('rejects a late save ACK after invalidation without a followup GET', async () => {
    const pending = deferred<Response>()
    send.mockResolvedValueOnce(response(policy())).mockReturnValueOnce(pending.promise)
    const guard = fixture(); await load(); await propose()
    button('save').click(); await nextTick()
    guard.invalidate(); await nextTick()
    pending.finish(response(policy(true, 1)))
    await vi.waitFor(() => { expect(has('[data-membership-current]')).toBe(false) })
    expect(send).toHaveBeenCalledTimes(2)
    expect(has('[data-membership-saved]')).toBe(false)
  })

  it('sends only one POST on double click', async () => {
    const pending = deferred<Response>()
    send.mockResolvedValueOnce(response(policy())).mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response(policy(true, 1)))
    fixture(); await load(); await propose()
    button('save').click(); button('save').click(); await nextTick()
    expect(send).toHaveBeenCalledTimes(2)
    pending.finish(response(policy(true, 1)))
    await vi.waitFor(() => { expect(has('[data-membership-saved]')).toBe(true) })
    expect(send).toHaveBeenCalledTimes(3)
  })
})
