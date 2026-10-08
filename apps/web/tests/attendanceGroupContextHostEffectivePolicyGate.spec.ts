import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import type { AttendanceGroupRouteContext } from '../src/router/attendanceGroupContextRoute'
import AttendanceGroupContextHost from '../src/views/attendance/AttendanceGroupContextHost.vue'
import { apiFetch } from '../src/utils/api'

// W6-3 (#4556) OD-W6-7=(a): the panel's mount point is `AttendanceGroupContextHost.vue` (the
// #4711 host), gated by `hasFeature('attendanceGroupEffectivePolicyPanel')`. This file proves BOTH
// halves of that gate at the host level:
//  - gate OFF (the module-scoped default, and vitest's default per-file module registry — no other
//    test file's mock leaks in) => the panel is absent from the DOM and issues zero network calls,
//    byte-identical to `attendanceGroupContextHost.spec.ts`'s pre-W6-3 behavior (that file is left
//    completely unmodified by this slice and stays green — see the PR body for that proof);
//  - gate ON (mocked here explicitly) => the panel mounts and is reachable.

const mockPanelFlag = ref(false)
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => (feature === 'attendanceGroupEffectivePolicyPanel' ? mockPanelFlag.value : false),
  }),
}))

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router')
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn() }),
  }
})

const GROUP_A = '11111111-2222-4333-8444-555555555555'

function context(groupId: string): AttendanceGroupRouteContext {
  return {
    groupId,
    step: 'schedule',
    surface: null,
    target: { kind: 'group-stage', stage: 'schedule' },
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

describe('AttendanceGroupContextHost — OD-W6-7 effective-policy panel gate', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    mockPanelFlag.value = false
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  function mount(): void {
    const ScopedContent = defineComponent({
      setup() {
        return () => h('div', { 'data-scoped-content': 'true' })
      },
    })
    const Root = defineComponent({
      setup() {
        return () => h(AttendanceGroupContextHost, { context: context(GROUP_A) }, { default: () => h(ScopedContent) })
      },
    })
    app = createApp(Root)
    app.mount(container!)
  }

  it('gate OFF (default): the panel never mounts and issues zero effective-policy fetches', async () => {
    vi.mocked(apiFetch).mockResolvedValue(response(200, { id: GROUP_A, name: 'A', timezone: 'UTC' }))
    mount()
    await flushUi()

    expect(container!.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-panel]')).toBeNull()
    const effectivePolicyCalls = vi.mocked(apiFetch).mock.calls.filter(([path]) =>
      String(path).includes('/effective-policy'),
    )
    expect(effectivePolicyCalls).toHaveLength(0)
  })

  it('gate ON: the panel mounts inside the ready host, collapsed (no auto-fetch)', async () => {
    mockPanelFlag.value = true
    vi.mocked(apiFetch).mockResolvedValue(response(200, { id: GROUP_A, name: 'A', timezone: 'UTC' }))
    mount()
    await flushUi()

    expect(container!.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
    expect(container!.querySelector('[data-attendance-w6-effective-policy-panel]')).toBeTruthy()
    expect(
      container!.querySelector(
        '[data-attendance-w6-effective-policy-panel][data-attendance-w6-effective-policy-status="idle"]',
      ),
    ).toBeTruthy()
    const effectivePolicyCalls = vi.mocked(apiFetch).mock.calls.filter(([path]) =>
      String(path).includes('/effective-policy'),
    )
    expect(effectivePolicyCalls).toHaveLength(0)
  })
})
