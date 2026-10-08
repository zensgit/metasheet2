import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, isRef, nextTick, ref, unref } from 'vue'
import { createAttendanceSessionGuard, provideAttendanceSessionGuard } from '../src/composables/useAttendanceSessionGuard'
import { useAttendanceSetupReadiness } from '../src/views/attendance/useAttendanceSetupReadiness'
import { useAttendanceApprovalDirectoryReadiness } from '../src/views/attendance/useAttendanceApprovalDirectoryReadiness'
import { useAttendanceDecisionTrace } from '../src/views/attendance/useAttendanceDecisionTrace'
import { useAttendanceAdminUsers } from '../src/views/attendance/useAttendanceAdminUsers'
import { useTeamAvailability } from '../src/views/attendance/useTeamAvailability'
import { fetchTeamAvailability } from '../src/services/attendance/teamAvailability'
import type { apiFetch } from '../src/utils/api'

type ReadOptions = { apiFetch: typeof apiFetch; isSessionCurrent: () => boolean }
const readConsumers = [
  { name: 'setup', create(options: ReadOptions) {
    const model = useAttendanceSetupReadiness(options)
    return { model, load: () => model.loadReadiness('synthetic-org') }
  } },
  { name: 'directory', create(options: ReadOptions) {
    const model = useAttendanceApprovalDirectoryReadiness(options)
    return { model, load: () => model.loadReadiness('synthetic-org') }
  } },
  { name: 'trace', create(options: ReadOptions) {
    const model = useAttendanceDecisionTrace(options)
    return { model, load: () => model.loadTrace('self', { category: 'today_status', workDate: '2026-09-08' }) }
  } },
  { name: 'users', create(options: ReadOptions) {
    const model = useAttendanceAdminUsers(options)
    return { model, load: () => model.loadUsers('synthetic') }
  } },
  { name: 'team', create(options: ReadOptions) {
    const model = useTeamAvailability({
      fetchAvailability: query => fetchTeamAvailability(query, options.apiFetch),
      isSessionCurrent: options.isSessionCurrent,
    })
    return { model, load: () => model.load('synthetic-group', '2026-09-08', '2026-09-08') }
  } },
]

describe('attendance session guard', () => {
  describe.each(readConsumers)('$name read consumer', ({ create }) => {
    it.each(['response', 'rejection'])('preserves stale state across a late %s and sends no retry', async outcome => {
      const guard = createAttendanceSessionGuard('synthetic-org', () => 'synthetic-epoch')
      let resolve!: (response: Response) => void
      let reject!: (error: Error) => void
      const send = vi.fn(() => new Promise<Response>((yes, no) => { resolve = yes; reject = no }))
      const { model, load } = create({ apiFetch: guard.wrapFetch(send), isSessionCurrent: guard.isCurrent })
      const snapshot = () => JSON.stringify(Object.fromEntries(
        Object.entries(model).filter(([, value]) => isRef(value)).map(([key, value]) => [key, unref(value)]),
      ))
      const pending = load()
      expect(send).toHaveBeenCalledTimes(1)
      const before = snapshot()
      guard.invalidate()
      if (outcome === 'response') resolve(new Response('{}', { status: 403 }))
      else reject(new Error('synthetic transport failure'))
      await pending
      expect(snapshot() === before).toBe(true)
      await load()
      expect(send).toHaveBeenCalledTimes(1)
      expect(snapshot() === before).toBe(true)
    })
  })

  it.each([false, true])('inherits the root scope without rebinding or owning its disposal (stale=%s)', async stale => {
    let rootGuard!: ReturnType<typeof createAttendanceSessionGuard>
    let childGuard!: ReturnType<typeof createAttendanceSessionGuard>
    const visible = ref(false)
    const Child = defineComponent({
      setup() {
        childGuard = provideAttendanceSessionGuard('new-context-must-not-rebind')
        return () => h('span')
      },
    })
    const Root = defineComponent({
      setup() {
        rootGuard = provideAttendanceSessionGuard('original-context')
        return () => visible.value ? h(Child) : null
      },
    })
    const app = createApp(Root)
    const container = document.createElement('div')
    app.mount(container)
    try {
      if (stale) rootGuard.invalidate()
      visible.value = true
      await nextTick()
      expect(childGuard === rootGuard).toBe(true)
      expect(childGuard.orgId).toBe('original-context')
      expect(childGuard.stale.value).toBe(stale)
      visible.value = false
      await nextTick()
      expect(rootGuard.stale.value).toBe(stale)
    } finally { app.unmount() }
    expect(rootGuard.stale.value).toBe(true)
  })

  it('passes the exact request and body through while its scope is current', async () => {
    const guard = createAttendanceSessionGuard('org-a', () => 'actor:a:epoch1')
    const send = vi.fn().mockResolvedValue(new Response('{"ok":true}'))
    const options = { method: 'POST', body: '{"expectedVersion":1}' }
    const response = await guard.wrapFetch(send)('/cleaning-apply', options)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('/cleaning-apply', options)
    expect(await response.json()).toEqual({ ok: true })
    expect(guard.stale.value).toBe(false)
  })

  it('blocks a deferred old action before send and does not recover on A-B-A', async () => {
    let identity = 'actor:a:epoch1'
    const guard = createAttendanceSessionGuard('org-a', () => identity)
    const send = vi.fn()
    const action = guard.wrapFetch(send)
    identity = 'actor:b:epoch2'
    await expect(action('/cleaning-apply', { method: 'POST' })).rejects.toThrow('ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED')
    identity = 'actor:a:epoch1'
    await expect(action('/cleaning-apply', { method: 'POST' })).rejects.toThrow('ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED')
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an already-sent response after the session changes without claiming rollback', async () => {
    let identity = 'actor:a:epoch1'
    const guard = createAttendanceSessionGuard('org-a', () => identity)
    let finish!: (response: Response) => void
    const send = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    const pending = guard.wrapFetch(send)('/cleaning-apply', { method: 'POST' })
    identity = 'actor:b:epoch2'
    finish(new Response('{}'))
    await expect(pending).rejects.toThrow('ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(['json', 'text', 'blob'] as const)('rejects a late %s payload', async method => {
    let identity = 'actor:a:epoch1'
    const guard = createAttendanceSessionGuard('org-a', () => identity)
    let finish!: (value: never) => void
    const response = new Response('{}')
    vi.spyOn(response, method).mockImplementation(() => new Promise(resolve => { finish = resolve }) as never)
    const guarded = await guard.wrapFetch(vi.fn().mockResolvedValue(response))('/records')
    const body = guarded[method]()
    identity = 'actor:b:epoch2'
    finish({} as never)
    await expect(body).rejects.toThrow('ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED')
  })

  it('guards cloned bodies and disposal, preserving the original request count', async () => {
    const guard = createAttendanceSessionGuard('org-a', () => 'actor:a:epoch1')
    const send = vi.fn().mockResolvedValue(new Response('{}'))
    const response = await guard.wrapFetch(send)('/records')
    const clone = response.clone()
    guard.invalidate()
    await expect(clone.json()).rejects.toThrow('ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED')
    await expect(guard.wrapFetch(send)('/cleaning-apply')).rejects.toThrow('ATTENDANCE_SESSION_CHANGED_RELOAD_REQUIRED')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
