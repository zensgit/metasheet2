import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, nextTick, type App } from 'vue'
import AttendanceOverview from '../src/views/attendance/AttendanceOverview.vue'
import AttendanceReportsView from '../src/views/attendance/AttendanceReportsView.vue'

vi.mock('../src/views/AttendanceView.vue', () => ({
  default: defineComponent({
    props: {
      mode: {
        type: String,
        required: true,
      },
      initialSectionId: {
        type: String,
        default: '',
      },
    },
    template: '<div :data-mode="mode" :data-section="initialSectionId"></div>',
  }),
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('Attendance surface wrappers', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('keeps overview routed through the overview mode shell', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(AttendanceOverview, { initialSectionId: 'attendance-overview-requests' })
    app.mount(container)
    await flushUi()

    const surface = container.querySelector<HTMLElement>('[data-mode="overview"]')
    expect(surface).toBeTruthy()
    expect(surface?.dataset.section).toBe('attendance-overview-requests')
  })

  it('keeps reports routed through the dedicated reports shell mode', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(AttendanceReportsView, { initialSectionId: 'attendance-overview-records' })
    app.mount(container)
    await flushUi()

    const surface = container.querySelector<HTMLElement>('[data-mode="reports"]')
    expect(surface).toBeTruthy()
    expect(surface?.dataset.section).toBe('attendance-overview-records')
  })
})
