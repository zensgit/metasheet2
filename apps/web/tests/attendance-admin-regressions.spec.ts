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

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
  window.dispatchEvent(new Event('resize'))
}

function emptyAttendanceResponse(): Response {
  return jsonResponse(200, {
    ok: true,
    data: {
      items: [],
      summary: null,
    },
  })
}

describe('Attendance admin regressions', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    setViewportWidth(1280)

    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('/api/attendance/import/template')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            payloadExample: {
              source: 'dingtalk',
              mode: 'override',
              columns: ['userId', 'workDate', 'firstInAt', 'lastOutAt'],
              requiredFields: ['userId', 'workDate'],
              ruleSetId: '<ruleSetId>',
              userId: '<userId>',
            },
            mappingProfiles: [
              {
                id: 'default-profile',
                name: 'Default profile',
                description: 'Default import mapping',
                requiredFields: ['userId'],
                mapping: {
                  firstInAt: { sourceField: '1_on_duty_user_check_time' },
                },
              },
            ],
          },
        })
      }
      return emptyAttendanceResponse()
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
    app = null
    container = null
  })

  it('focuses the clicked admin section after toggling show-all', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const toggle = container!.querySelector<HTMLButtonElement>('.attendance__admin-actions .attendance__btn')
    expect(toggle?.textContent).toContain('Show all sections')

    toggle!.click()
    await flushUi(2)
    expect(toggle?.textContent).toContain('Focus current section')

    const settings = container!.querySelector<HTMLElement>('#attendance-admin-settings')
    const groupMembers = container!.querySelector<HTMLElement>('#attendance-admin-group-members')
    expect(settings).toBeTruthy()
    expect(groupMembers).toBeTruthy()
    expect(window.getComputedStyle(settings!).display).not.toBe('none')
    expect(window.getComputedStyle(groupMembers!).display).not.toBe('none')

    const groupMembersNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-group-members"]')
    expect(groupMembersNav).toBeTruthy()
    groupMembersNav!.click()
    await flushUi(2)

    expect(toggle?.textContent).toContain('Show all sections')
    expect(window.getComputedStyle(settings!).display).toBe('none')
    expect(window.getComputedStyle(groupMembers!).display).not.toBe('none')
    expect(container!.querySelector('.attendance__admin-nav-current')?.textContent).toContain('Organization · Group members')
    expect(container!.textContent).toContain('User picker')
    expect(container!.textContent).toContain('Append selected user')
  })

  it('restores the run21 holiday calendar, rule builder, and import template guidance', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const holidayNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-holidays"]')
    const ruleSetNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-rule-sets"]')
    const importNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import"]')
    expect(holidayNav).toBeTruthy()
    expect(ruleSetNav).toBeTruthy()
    expect(importNav).toBeTruthy()

    holidayNav!.click()
    await flushUi(2)
    expect(container!.textContent).toContain('Holiday management now follows a month calendar.')
    expect(container!.textContent).toContain('Selected date')

    ruleSetNav!.click()
    await flushUi(2)
    expect(container!.textContent).toContain('Structured rule builder')
    expect(container!.textContent).toContain('Apply builder to JSON')

    importNav!.click()
    await flushUi(2)
    const importSection = container!.querySelector<HTMLElement>('[data-admin-section="attendance-admin-import"]')
    expect(importSection).toBeTruthy()
    const buttons = Array.from(importSection!.querySelectorAll<HTMLButtonElement>('button'))
    const loadTemplateButton = buttons.find(button => button.textContent?.includes('Load template'))
    expect(loadTemplateButton).toBeTruthy()
    loadTemplateButton!.click()
    await flushUi(2)

    const mappingProfileSelect = container!.querySelector<HTMLSelectElement>('#attendance-import-profile')
    expect(mappingProfileSelect).toBeTruthy()
    mappingProfileSelect!.value = 'default-profile'
    mappingProfileSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    expect(container!.textContent).toContain('Template guide')
    expect(container!.textContent).toContain('Field meanings')
    expect(container!.textContent).toContain('Selected mapping profile')
    expect(container!.textContent).toContain('Suggested CSV header')
  })
})
