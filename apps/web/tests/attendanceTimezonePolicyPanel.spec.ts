import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Panel from '../src/views/attendance/AttendanceTimezonePolicyPanel.vue'
import { apiFetch } from '../src/utils/api'
import { attendanceSessionGuardKey, createAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
const send = vi.mocked(apiFetch)
const policy = (enabled = false) => ({
  ok: true, data: {
    enabled, version: enabled ? 2 : 0,
    systemDefault: { orgId: 'org-a', referenceId: 'rule-a', timezone: 'Asia/Singapore', version: 3 },
  },
})
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let app: App | null = null
let container: HTMLDivElement | null = null

function fixture() {
  const guard = createAttendanceSessionGuard('org-a', () => 'principal-a')
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(Panel, { tr: (_en: string, zh: string) => zh })
  app.provide(attendanceSessionGuardKey, guard)
  app.mount(container)
  const root = container
  const button = root.querySelector('button')!
  const load = async () => {
    button.click()
    await nextTick()
    await vi.waitFor(() => { expect(button.disabled).toBe(false) })
  }
  return { root, button, guard, load }
}
function text(root: HTMLElement, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? ''
}

beforeEach(() => { send.mockReset() })
afterEach(() => { app?.unmount(); app = null; container?.remove(); container = null })

describe('attendance timezone policy panel', () => {
  it('waits for an explicit view and is mounted in real admin settings', () => {
    fixture()
    expect(send).not.toHaveBeenCalled()
    const host = readFileSync(resolve(process.cwd(), 'src/views/AttendanceView.vue'), 'utf8')
    expect(host).toContain('<AttendanceTimezonePolicyPanel :tr="tr" />')
  })

  it('shows the actual organization default for an absent OFF policy', async () => {
    send.mockResolvedValueOnce(response(policy()))
    const f = fixture()
    await f.load()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('/api/attendance/timezone-policy')
    expect(text(f.root, '[data-timezone-enabled]')).toBe('未启用')
    expect(text(f.root, '[data-timezone-default]')).toBe('Asia/Singapore')
    expect(f.root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  })

  it('shows a persisted enabled policy and keeps preview/save disabled until the proposal changes', async () => {
    send.mockResolvedValueOnce(response(policy(true)))
    const f = fixture()
    await f.load()
    expect(text(f.root, '[data-timezone-enabled]')).toBe('已启用')
    expect(f.root.querySelector<HTMLButtonElement>('[data-timezone-preview]')?.disabled).toBe(true)
    expect(f.root.querySelector<HTMLButtonElement>('[data-timezone-save]')?.disabled).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 404])('refuses unavailable response %s without default fallback', async status => {
    send.mockResolvedValueOnce(response({ ok: false }, status))
    const f = fixture()
    await f.load()
    expect(text(f.root, '[role="status"]')).toBe('配置不可用，请确认登录会话和考勤管理权限。')
    expect(f.root.querySelector('[data-timezone-default]')).toBeNull()
  })

  it.each([422, 503])('reports response %s as failure rather than OFF', async status => {
    send.mockResolvedValueOnce(response({ ok: false, error: { message: 'synthetic-sensitive-value' } }, status))
    const f = fixture()
    await f.load()
    expect(text(f.root, '[role="alert"]')).toBe('无法读取考勤时区配置。')
    expect(f.root.textContent).not.toContain('synthetic-sensitive-value')
    expect(f.root.querySelector('[data-timezone-enabled]')).toBeNull()
  })

  it.each([
    { ...policy(), data: { ...policy().data, enabled: 'false' } },
    { ...policy(), data: { ...policy().data, systemDefault: { ...policy().data.systemDefault, orgId: 'org-b' } } },
    { ...policy(), data: { ...policy().data, systemDefault: { ...policy().data.systemDefault, timezone: 'invalid-zone' } } },
  ])('rejects malformed or foreign configuration', async body => {
    send.mockResolvedValueOnce(response(body))
    const f = fixture()
    await f.load()
    expect(f.root.querySelector('[role="alert"]')).not.toBeNull()
    expect(f.root.querySelector('[data-timezone-default]')).toBeNull()
  })

  it('clears the previous policy when refresh fails', async () => {
    send.mockResolvedValueOnce(response(policy())).mockRejectedValueOnce(new Error('synthetic-sensitive-value'))
    const f = fixture()
    await f.load()
    expect(f.root.querySelector('[data-timezone-default]')).not.toBeNull()
    await f.load()
    expect(f.root.querySelector('[role="alert"]')).not.toBeNull()
    expect(f.root.querySelector('[data-timezone-default]')).toBeNull()
  })

  it('erases configuration and refuses new requests after session invalidation', async () => {
    send.mockResolvedValueOnce(response(policy()))
    const f = fixture()
    await f.load()
    f.guard.invalidate()
    await nextTick()
    expect(f.root.querySelector('[data-timezone-default]')).toBeNull()
    await f.load()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not deliver an in-flight response after the session changes', async () => {
    let finish!: (value: Response) => void
    send.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    const f = fixture()
    f.button.click()
    await nextTick()
    f.guard.invalidate()
    finish(response(policy()))
    await nextTick()
    await vi.waitFor(() => { expect(f.root.querySelector('[role="status"]')).not.toBeNull() })
    expect(f.root.querySelector('[data-timezone-default]')).toBeNull()
  })
})


const impactResponse = (conflictingUsers = 0) => ({ ok: true, data: {
  currentVersion: 0, proposedEnabled: true, evaluatedUsers: 2, affectedUsers: 2, conflictingUsers,
  conflictCounts: { startedContext: conflictingUsers, tripContext: 0, invalidTargetContext: 0 },
} })
async function propose(root: HTMLDivElement, enabled: boolean): Promise<void> {
  const checkbox = root.querySelector<HTMLInputElement>('[data-timezone-proposed]')!
  checkbox.checked = enabled
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
}
async function preview(root: HTMLDivElement): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-timezone-preview]')!.click()
  await nextTick()
  await vi.waitFor(() => { expect(root.querySelector<HTMLButtonElement>('[data-timezone-preview]')?.disabled).toBe(false) })
}

describe('attendance timezone policy preview and explicit save', () => {
  it('requires the actual bound preview before a CAS save and refreshes after confirmed write', async () => {
    send.mockResolvedValueOnce(response(policy()))
      .mockResolvedValueOnce(response(impactResponse()))
      .mockResolvedValueOnce(response({ ok: true, data: { enabled: true, version: 1 } }))
      .mockResolvedValueOnce(response({ ...policy(true), data: { ...policy(true).data, version: 1 } }))
    const f = fixture();await f.load();await propose(f.root, true)
    expect(f.root.querySelector<HTMLButtonElement>('[data-timezone-save]')?.disabled).toBe(true)
    await preview(f.root)
    expect(text(f.root, '[data-timezone-affected]')).toBe('2')
    expect(send).toHaveBeenNthCalledWith(2, '/api/attendance/timezone-policy/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, expectedVersion: 0 }),
    })
    f.root.querySelector<HTMLButtonElement>('[data-timezone-save]')!.click();await nextTick()
    await vi.waitFor(() => { expect(text(f.root, '[data-timezone-enabled]')).toBe('已启用') })
    expect(send).toHaveBeenNthCalledWith(3, '/api/attendance/timezone-policy', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, expectedVersion: 0 }),
    })
    expect(send).toHaveBeenNthCalledWith(4, '/api/attendance/timezone-policy')
    expect(f.root.querySelector('[data-timezone-impact]')).toBeNull()
  })
  it('shows real conflict counts and refuses to send a write when conflicts remain', async () => {
    send.mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response(impactResponse(2)))
    const f = fixture();await f.load();await propose(f.root, true);await preview(f.root)
    expect(text(f.root, '[data-timezone-conflicting]')).toBe('2')
    const save = f.root.querySelector<HTMLButtonElement>('[data-timezone-save]')!
    expect(save.disabled).toBe(true);save.click();await nextTick()
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('invalidates a preview when the proposal changes, even if changed back', async () => {
    send.mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response(impactResponse()))
    const f = fixture();await f.load();await propose(f.root, true);await preview(f.root)
    expect(f.root.querySelector<HTMLButtonElement>('[data-timezone-save]')?.disabled).toBe(false)
    await propose(f.root, false);await propose(f.root, true)
    expect(f.root.querySelector('[data-timezone-impact]')).toBeNull()
    expect(f.root.querySelector<HTMLButtonElement>('[data-timezone-save]')?.disabled).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it.each([
    response({ ok: false, error: { code: 'private-value' } }, 409),
    response({ ...impactResponse(), data: { ...impactResponse().data, currentVersion: 1 } }),
    response({ ...impactResponse(), data: { ...impactResponse().data, affectedUsers: 3 } }),
    response({ ...impactResponse(), data: { ...impactResponse().data, conflictCounts: { startedContext: 1, tripContext: 0, invalidTargetContext: 0 } } }),
  ])('refuses failed or unbound preview without exposing response values', async result => {
    send.mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(result)
    const f = fixture();await f.load();await propose(f.root, true);await preview(f.root)
    expect(f.root.querySelector('[data-timezone-impact]')).toBeNull()
    expect(f.root.querySelector<HTMLButtonElement>('[data-timezone-save]')?.disabled).toBe(true)
    expect(f.root.textContent).not.toContain('private-value')
    expect(text(f.root, '[data-timezone-change-message]')).toContain('无法确认影响')
  })
  it('discards pending impact when the session is invalidated', async () => {
    let finish!: (response: Response) => void
    send.mockResolvedValueOnce(response(policy())).mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    const f = fixture();await f.load();await propose(f.root, true)
    f.root.querySelector<HTMLButtonElement>('[data-timezone-preview]')!.click();await nextTick()
    f.guard.invalidate();finish(response(impactResponse()));await nextTick()
    await vi.waitFor(() => { expect(f.root.querySelector('[data-timezone-impact]')).toBeNull() })
    expect(f.root.querySelector('[data-timezone-default]')).toBeNull()
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('does not claim an uncertain write is OFF or offer another save without a refresh', async () => {
    send.mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response(impactResponse()))
      .mockResolvedValueOnce(response({ ok: true, data: { enabled: false, version: 1 } }))
    const f = fixture();await f.load();await propose(f.root, true);await preview(f.root)
    f.root.querySelector<HTMLButtonElement>('[data-timezone-save]')!.click();await nextTick()
    await vi.waitFor(() => { expect(f.root.querySelector('[data-timezone-enabled]')).toBeNull() })
    expect(text(f.root, '[data-timezone-change-message]')).toContain('无法确认保存结果')
    expect(f.root.querySelector('[data-timezone-save]')).toBeNull()
    expect(send).toHaveBeenCalledTimes(3)
  })
})
