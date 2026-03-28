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
      if (url.includes('/api/attendance/rule-sets/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            ruleSetId: 'rule-set-1',
            totalEvents: 2,
            config: {
              source: 'manual',
              rule: {
                timezone: 'Asia/Shanghai',
                workStartTime: '09:00',
                workEndTime: '18:00',
                lateGraceMinutes: 10,
                earlyGraceMinutes: 10,
                workingDays: [1, 2, 3, 4, 5],
                overtimeThresholdMinutes: 60,
              },
            },
            notes: ['Preview normalized overtime threshold.'],
            preview: [
              {
                userId: 'user-1',
                workDate: '2026-03-28',
                firstInAt: '2026-03-28T09:17:00.000Z',
                lastOutAt: '2026-03-28T18:02:00.000Z',
                workMinutes: 465,
                lateMinutes: 17,
                earlyLeaveMinutes: 0,
                status: 'late',
                isWorkingDay: true,
                source: {
                  eventIds: ['evt-1', 'evt-2'],
                },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/rule-templates/versions/version-1')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            id: 'version-1',
            version: 7,
            createdAt: '2026-03-28T08:00:00.000Z',
            createdBy: 'ops-admin',
            sourceVersionId: 'version-6',
            itemCount: 2,
            templates: [
              { name: 'Night Shift', rules: [] },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/rule-templates')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            system: [],
            library: [],
            versions: [
              {
                id: 'version-1',
                version: 7,
                createdAt: '2026-03-28T08:00:00.000Z',
                createdBy: 'ops-admin',
                itemCount: 2,
                sourceVersionId: 'version-6',
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/import/batches/batch-1/items')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            total: 1,
            items: [
              {
                id: 'item-1',
                userId: 'user-1',
                workDate: '2026-03-28',
                recordId: null,
                createdAt: '2026-03-28T09:00:00.000Z',
                previewSnapshot: {
                  metrics: {
                    status: 'warning',
                    workMinutes: 470,
                    lateMinutes: 12,
                    earlyLeaveMinutes: 0,
                    leaveMinutes: 0,
                    overtimeMinutes: 30,
                    warnings: ['Missing downstream record'],
                  },
                  policy: {
                    matchedRuleSet: 'Default policy',
                  },
                  engine: {
                    adapter: 'bulk',
                  },
                },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/import/batches')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'batch-1',
                status: 'completed',
                rowCount: 3,
                source: 'csv',
                createdBy: 'ops-admin',
                createdAt: '2026-03-28T08:30:00.000Z',
                updatedAt: '2026-03-28T09:00:00.000Z',
                ruleSetId: '',
                mapping: {
                  firstInAt: '1_on_duty_user_check_time',
                  lastOutAt: '1_off_duty_user_check_time',
                },
                meta: {
                  engine: 'bulk',
                  chunkConfig: {
                    itemsChunkSize: 200,
                    recordsChunkSize: 100,
                  },
                },
              },
            ],
          },
        })
      }
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
    expect(container!.textContent).toContain('Draft preview')
    expect(container!.textContent).toContain('Sample event builder')

    const previewButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Preview rule set'))
    expect(previewButton).toBeTruthy()
    previewButton!.click()
    await flushUi(4)

    expect(container!.textContent).toContain('Rows affected')
    expect(container!.textContent).toContain('Raise late grace')
    expect(container!.textContent).toContain('Selected preview row')
    expect(container!.textContent).toContain('Source payload')

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

  it('restores template version details and import batch diagnostics from the split admin sections', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const templateLibraryNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-rule-template-library"]')
    expect(templateLibraryNav).toBeTruthy()
    templateLibraryNav!.click()
    await flushUi(2)

    const viewVersionButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('View'))
    expect(viewVersionButton).toBeTruthy()
    viewVersionButton!.click()
    await flushUi(2)

    expect(container!.textContent).toContain('Selected version')
    expect(container!.textContent).toContain('ops-admin')
    expect(container!.textContent).toContain('Night Shift')

    const importBatchesNav = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    expect(importBatchesNav).toBeTruthy()
    importBatchesNav!.click()
    await flushUi(2)

    const importBatchesSection = container!.querySelector<HTMLElement>('[data-admin-section="attendance-admin-import-batches"]')
    expect(importBatchesSection).toBeTruthy()

    const viewItemsButton = Array.from(importBatchesSection!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('View items'))
    expect(viewItemsButton).toBeTruthy()
    viewItemsButton!.click()
    await flushUi(6)

    expect(importBatchesSection!.textContent).toContain('Rollback impact estimate')
    expect(importBatchesSection!.textContent).toContain('Retry guidance')
    expect(importBatchesSection!.textContent).toContain('Mapping viewer')
    expect(importBatchesSection!.textContent).toContain('Selected item detail')
    expect(importBatchesSection!.textContent).toContain('Engine: bulk')
  })
})
