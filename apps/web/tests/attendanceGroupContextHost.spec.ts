import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import type { AttendanceGroupRouteContext } from '../src/router/attendanceGroupContextRoute'
import AttendanceGroupContextHost from '../src/views/attendance/AttendanceGroupContextHost.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

const GROUP_A = '11111111-2222-4333-8444-555555555555'
const GROUP_B = '66666666-7777-4888-8999-000000000000'

function context(groupId: string, step: AttendanceGroupRouteContext['step'] = 'schedule'): AttendanceGroupRouteContext {
  return {
    groupId,
    step,
    surface: null,
    target: { kind: 'group-stage', stage: step === 'rules' ? 'policies' : 'schedule' },
    returnTo: '/attendance?tab=admin&section=attendance-admin-groups',
  }
}

function response(status: number, data?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ ok: status >= 200 && status < 300, data }),
  } as Response
}

async function flushUi(cycles = 5): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('AttendanceGroupContextHost', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  function mount(initialContext: AttendanceGroupRouteContext | null, onReady?: () => void) {
    const currentContext = ref(initialContext)
    const ScopedContent = defineComponent({
      setup() {
        onReady?.()
        return () => h('div', { 'data-scoped-content': 'true' })
      },
    })
    const Root = defineComponent({
      setup() {
        return () => h(AttendanceGroupContextHost, { context: currentContext.value }, {
          default: () => h(ScopedContent),
        })
      },
    })
    app = createApp(Root)
    app.mount(container!)
    return currentContext
  }

  it('does not start member or manager requests before the probe succeeds', async () => {
    let resolveProbe: ((value: Response) => void) | null = null
    vi.mocked(apiFetch)
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveProbe = resolve }))
      .mockResolvedValue(response(200))
    const scopedRequest = vi.fn(() => {
      void apiFetch(`/api/attendance/groups/${GROUP_A}/members`)
      void apiFetch(`/api/attendance/groups/${GROUP_A}/managers`)
    })
    mount(context(GROUP_A), scopedRequest)
    await flushUi()

    expect(apiFetch).toHaveBeenCalledWith(`/api/attendance/groups/${GROUP_A}`)
    expect(scopedRequest).not.toHaveBeenCalled()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(container!.querySelector('[data-attendance-group-context="loading"]')).toBeTruthy()

    resolveProbe?.(response(200, { id: GROUP_A, name: 'A', timezone: 'UTC' }))
    await flushUi()

    expect(scopedRequest).toHaveBeenCalledTimes(1)
    expect(apiFetch).toHaveBeenNthCalledWith(2, `/api/attendance/groups/${GROUP_A}/members`)
    expect(apiFetch).toHaveBeenNthCalledWith(3, `/api/attendance/groups/${GROUP_A}/managers`)
    expect(container!.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
  })

  it('maps denied and missing groups to the same unavailable posture', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(response(403))
    mount(context(GROUP_A))
    await flushUi()
    expect(container!.querySelector('[data-attendance-group-context="unavailable"]')).toBeTruthy()

    app?.unmount()
    vi.mocked(apiFetch).mockResolvedValueOnce(response(404))
    mount(context(GROUP_B))
    await flushUi()
    expect(container!.querySelector('[data-attendance-group-context="unavailable"]')).toBeTruthy()
  })

  it('retries unexpected failures without changing the route context', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, { id: GROUP_A, name: 'A', timezone: 'UTC' }))
    mount(context(GROUP_A))
    await flushUi()
    expect(container!.querySelector('[data-attendance-group-context="error"]')).toBeTruthy()

    container!.querySelector<HTMLButtonElement>('[data-attendance-group-context="error"] button')!.click()
    await flushUi()

    expect(apiFetch).toHaveBeenNthCalledWith(2, `/api/attendance/groups/${GROUP_A}`)
    expect(container!.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
  })

  it('discards a stale successful A response after the route changes to B', async () => {
    let resolveA: ((value: Response) => void) | null = null
    let resolveB: ((value: Response) => void) | null = null
    vi.mocked(apiFetch).mockImplementation((path: string) => new Promise<Response>(resolve => {
      if (path.endsWith(GROUP_A)) resolveA = resolve
      if (path.endsWith(GROUP_B)) resolveB = resolve
    }))
    const currentContext = mount(context(GROUP_A))
    await flushUi()
    currentContext.value = context(GROUP_B, 'rules')
    await flushUi()

    resolveA?.(response(200, { id: GROUP_A, name: 'A', timezone: 'UTC' }))
    await flushUi()
    expect(container!.querySelector('[data-attendance-group-context="ready"]')).toBeNull()

    resolveB?.(response(200, { id: GROUP_B, name: 'B', timezone: 'UTC' }))
    await flushUi()
    expect(container!.textContent).toContain('B')
    expect(container!.textContent).toContain('Rules')
  })
})
