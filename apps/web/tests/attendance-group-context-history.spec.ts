import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue'
import {
  RouterView,
  createMemoryHistory,
  createRouter,
  type RouteRecordRaw,
} from 'vue-router'
import AttendanceExperienceView from '../src/views/attendance/AttendanceExperienceView.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => feature === 'attendanceAdmin' || feature === 'attendance',
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ isZh: ref(false) }),
}))

vi.mock('../src/views/attendance/AttendanceAdminCenter.vue', () => ({
  default: defineComponent({
    props: {
      routeGroupContext: { type: Object, default: null },
    },
    emits: ['clear-section', 'open-group-route'],
    template: `
      <div
        data-history-admin
        :data-history-group="routeGroupContext?.group.id || ''"
        :data-history-step="routeGroupContext?.step || ''"
        :data-history-surface="routeGroupContext?.surface || ''"
      >
        <button
          data-history-open-assignments
          @click="$emit('open-group-route', {
            groupId: '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f',
            step: 'schedule',
            surface: 'assignments',
          })"
        >Assignments</button>
      </div>
    `,
  }),
}))

vi.mock('../src/views/attendance/AttendanceOverview.vue', () => ({
  default: defineComponent({ template: '<div data-history-overview />' }),
}))
vi.mock('../src/views/attendance/AttendanceReportsView.vue', () => ({
  default: defineComponent({ template: '<div />' }),
}))
vi.mock('../src/views/attendance/AttendanceWorkflowDesigner.vue', () => ({
  default: defineComponent({ template: '<div />' }),
}))

const GROUP_ID = '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('attendance group-context R2 history', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === `/api/attendance/groups/${GROUP_ID}`) {
        return jsonResponse(200, {
          ok: true,
          data: {
            id: GROUP_ID,
            name: 'Authorized Operations',
            timezone: 'Asia/Shanghai',
            attendanceType: 'fixed_shift',
          },
        })
      }
      return jsonResponse(404, { ok: false })
    })
  })

  afterEach(() => {
    app?.unmount()
    container.remove()
    vi.clearAllMocks()
  })

  it('uses real router push, Back, and Forward while preserving group, step, and surface', async () => {
    const routes: RouteRecordRaw[] = [
      { path: '/attendance', name: 'attendance', component: AttendanceExperienceView },
      {
        path: '/attendance/admin/groups/:groupId/schedule',
        name: 'attendance-admin-group-schedule',
        component: AttendanceExperienceView,
      },
      {
        path: '/attendance/admin/groups/:groupId/calendar',
        name: 'attendance-admin-group-calendar',
        component: AttendanceExperienceView,
      },
      {
        path: '/attendance/admin/groups/:groupId/rules',
        name: 'attendance-admin-group-rules',
        component: AttendanceExperienceView,
      },
      { path: '/:pathMatch(.*)*', name: 'not-found', component: defineComponent({ template: '<div />' }) },
    ]
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/attendance?tab=admin&section=attendance-admin-groups')
    await router.isReady()

    app = createApp({ render: () => h(RouterView) })
    app.use(router)
    app.mount(container)
    await flushUi()

    const pushSpy = vi.spyOn(router, 'push')
    container.querySelector<HTMLButtonElement>('[data-history-open-assignments]')!.click()
    await pushSpy.mock.results[0]?.value
    await flushUi(8)

    const expectedRoute = `/attendance/admin/groups/${GROUP_ID}/schedule`
      + '?surface=assignments&returnTo=%2Fattendance%3Ftab%3Dadmin%26section%3Dattendance-admin-groups'
    expect(pushSpy).toHaveBeenCalledWith(expectedRoute)
    expect(router.currentRoute.value.fullPath).toBe(expectedRoute)
    expect(container.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-step')).toBe('schedule')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-surface')).toBe('assignments')

    const backComplete = new Promise<void>((resolve) => {
      const remove = router.afterEach(() => {
        remove()
        resolve()
      })
    })
    router.back()
    await backComplete
    await flushUi(8)
    expect(router.currentRoute.value.fullPath).toBe('/attendance?tab=admin&section=attendance-admin-groups')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe('')

    const forwardComplete = new Promise<void>((resolve) => {
      const remove = router.afterEach(() => {
        remove()
        resolve()
      })
    })
    router.forward()
    await forwardComplete
    await flushUi(8)
    expect(router.currentRoute.value.fullPath).toBe(expectedRoute)
    expect(container.querySelector('[data-attendance-group-context="ready"]')).toBeTruthy()
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-group')).toBe(GROUP_ID)
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-step')).toBe('schedule')
    expect(container.querySelector('[data-history-admin]')?.getAttribute('data-history-surface')).toBe('assignments')
  })
})
