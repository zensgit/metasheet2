import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([
      {
        name: 'plugin-attendance',
        status: 'active',
      },
    ]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function findPayrollCyclesSection(container: HTMLElement): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h4')).find(
    candidate => candidate.textContent?.trim() === 'Payroll Cycles',
  )
  expect(heading).toBeTruthy()
  const section = heading?.closest('.attendance__admin-section')
  expect(section).toBeTruthy()
  return section as HTMLElement
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label,
  )
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

function unwrapRef<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return (value as { value: T }).value
  }
  return value as T
}

describe('Attendance payroll timezone status', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.includes('/api/attendance/payroll-cycles/cycle-1/summary')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            summary: {
              total_minutes: 480,
              leave_minutes: 0,
              overtime_minutes: 30,
              total_late_minutes: 5,
              total_early_leave_minutes: 0,
            },
          },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('includes cycle template timezone context in payroll summary status feedback', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    unwrapRef<any[]>(setupState.payrollTemplates).push({
      id: 'tpl-1',
      name: 'CN Payroll',
      timezone: 'Asia/Shanghai',
      startDay: 1,
      endDay: 30,
      endMonthOffset: 0,
      autoGenerate: true,
      isDefault: true,
    })
    setupState.payrollCycleForm.templateId = 'tpl-1'
    setupState.payrollCycleEditingId = 'cycle-1'
    await flushUi()

    const section = findPayrollCyclesSection(container!)
    findButton(section, 'Load summary').click()
    await flushUi()

    expect(container!.textContent).toContain('Payroll summary loaded.')
    expect(container!.textContent).toContain('Cycle template timezone: CN Payroll (UTC+08:00 · Asia/Shanghai)')
  })
})
