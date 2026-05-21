import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'

vi.mock('../src/services/attendance/effectiveCalendar', () => {
  class EffectiveCalendarFetchError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.name = 'EffectiveCalendarFetchError'
      this.status = status
      this.code = code
    }
  }
  return {
    EffectiveCalendarFetchError,
    fetchEffectiveCalendar: vi.fn(),
  }
})

import AttendanceCalendarPolicyPreviewPanel from '../src/views/attendance/AttendanceCalendarPolicyPreviewPanel.vue'
import {
  EffectiveCalendarFetchError,
  fetchEffectiveCalendar,
  type CalendarEffectiveResponse,
} from '../src/services/attendance/effectiveCalendar'

const fetchEffectiveCalendarMock = vi.mocked(fetchEffectiveCalendar)

function flushUi(cycles = 4): Promise<void> {
  return Promise.all(Array.from({ length: cycles }).map(() => Promise.resolve().then(() => nextTick()))).then(
    () => undefined
  )
}

function buildResult(overrides: Partial<CalendarEffectiveResponse> = {}): CalendarEffectiveResponse {
  return {
    mode: 'orgOnly',
    from: '2026-10-01',
    to: '2026-10-07',
    timezone: 'Asia/Shanghai',
    items: [
      {
        date: '2026-10-06',
        base: { isWorkingDay: false, source: 'national', name: '国庆节', holidayId: 'h_1' },
        effective: { isWorkingDay: true, source: 'org', label: '调休上班', policyId: 'policy_1' },
        layers: [
          { kind: 'holiday', source: 'national', isWorkingDay: false, label: '国庆节' },
          { kind: 'calendar_policy', source: 'org', isWorkingDay: true, label: '调休上班', refId: 'policy_1' },
        ],
        overlays: [
          { kind: 'overtime', source: 'attendance_requests', requestType: 'overtime', minutes: 120, label: '加班' },
        ],
      },
    ],
    ...overrides,
  }
}

function setInput(container: HTMLElement, selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)
  expect(input, `expected input ${selector}`).toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input'))
}

function setSelect(container: HTMLElement, selector: string, value: string): void {
  const select = container.querySelector<HTMLSelectElement>(selector)
  expect(select, `expected select ${selector}`).toBeTruthy()
  select!.value = value
  select!.dispatchEvent(new Event('change'))
}

function clickPreview(container: HTMLElement): void {
  const button = container.querySelector<HTMLButtonElement>('[data-attendance-calendar-policy-preview-run]')
  expect(button).toBeTruthy()
  button!.click()
}

describe('AttendanceCalendarPolicyPreviewPanel', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  const tr = (_en: string, zh: string) => zh

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    fetchEffectiveCalendarMock.mockReset()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  function mountPanel(extraProps: Record<string, unknown> = {}): HTMLElement {
    app = createApp(AttendanceCalendarPolicyPreviewPanel, { tr, ...extraProps })
    app.mount(container!)
    return container!
  }

  it('previews org-level effective calendar rows through the backend resolver', async () => {
    fetchEffectiveCalendarMock.mockResolvedValueOnce(buildResult())
    const root = mountPanel()
    await flushUi()

    setInput(root, '[data-attendance-calendar-policy-preview-from]', '2026-10-01')
    setInput(root, '[data-attendance-calendar-policy-preview-to]', '2026-10-07')
    clickPreview(root)
    await flushUi(8)

    expect(fetchEffectiveCalendarMock).toHaveBeenCalledTimes(1)
    expect(fetchEffectiveCalendarMock).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-07',
      orgOnly: true,
      suppressUnauthorizedRedirect: true,
    })
    expect(root.querySelector('[data-attendance-calendar-policy-preview-result]')?.textContent).toContain('2026-10-06')
    expect(root.textContent).toContain('调休上班')
    expect(root.textContent).toContain('policy_1')
    expect(root.textContent).toContain('加班')
  })

  it('requires a target id for group/user preview modes before calling the API', async () => {
    const root = mountPanel()
    await flushUi()

    setInput(root, '[data-attendance-calendar-policy-preview-from]', '2026-10-01')
    setInput(root, '[data-attendance-calendar-policy-preview-to]', '2026-10-07')
    setSelect(root, '[data-attendance-calendar-policy-preview-mode]', 'userId')
    await flushUi()
    clickPreview(root)
    await flushUi()

    expect(fetchEffectiveCalendarMock).not.toHaveBeenCalled()
    expect(root.querySelector('[data-attendance-calendar-policy-preview-error]')?.textContent).toContain('用户 ID 不能为空')

    setInput(root, '[data-attendance-calendar-policy-preview-user]', 'user_42')
    fetchEffectiveCalendarMock.mockResolvedValueOnce(buildResult({ mode: 'userId' }))
    clickPreview(root)
    await flushUi(8)

    expect(fetchEffectiveCalendarMock).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-07',
      userId: 'user_42',
      suppressUnauthorizedRedirect: true,
    })
  })

  it('shows backend preview errors without mutating the settings editor state', async () => {
    fetchEffectiveCalendarMock.mockRejectedValueOnce(
      new EffectiveCalendarFetchError('No access to this user.', 403, 'FORBIDDEN'),
    )
    const root = mountPanel()
    await flushUi()

    setInput(root, '[data-attendance-calendar-policy-preview-from]', '2026-10-01')
    setInput(root, '[data-attendance-calendar-policy-preview-to]', '2026-10-07')
    clickPreview(root)
    await flushUi(8)

    const error = root.querySelector('[data-attendance-calendar-policy-preview-error]')
    expect(error?.textContent).toContain('No access to this user. (FORBIDDEN)')
    expect(root.querySelector('[data-attendance-calendar-policy-preview-result]')).toBeNull()
  })

  it('can include or exclude unsaved editor overrides from preview calls', async () => {
    const draftOverrides = [
      {
        date: '2026-10-06',
        effective: { isWorkingDay: true, source: 'org' as const, label: 'Draft workday' },
      },
    ]
    fetchEffectiveCalendarMock.mockResolvedValue(buildResult())
    const root = mountPanel({ draftOverrides })
    await flushUi()

    expect(root.textContent).toContain('包含未保存的编辑规则（1 条）')
    setInput(root, '[data-attendance-calendar-policy-preview-from]', '2026-10-01')
    setInput(root, '[data-attendance-calendar-policy-preview-to]', '2026-10-07')
    clickPreview(root)
    await flushUi(8)

    expect(fetchEffectiveCalendarMock).toHaveBeenLastCalledWith({
      from: '2026-10-01',
      to: '2026-10-07',
      orgOnly: true,
      suppressUnauthorizedRedirect: true,
      draftOverrides,
    })

    const checkbox = root.querySelector<HTMLInputElement>('[data-attendance-calendar-policy-preview-draft]')
    expect(checkbox).toBeTruthy()
    checkbox!.checked = false
    checkbox!.dispatchEvent(new Event('change'))
    await flushUi()
    clickPreview(root)
    await flushUi(8)

    expect(fetchEffectiveCalendarMock).toHaveBeenLastCalledWith({
      from: '2026-10-01',
      to: '2026-10-07',
      orgOnly: true,
      suppressUnauthorizedRedirect: true,
    })
  })
})
