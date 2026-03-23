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

function findImportSection(container: HTMLElement): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h4')).find(
    candidate => candidate.textContent?.trim() === 'Import (DingTalk / Manual)',
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

describe('Attendance import timezone status', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.startsWith('/api/attendance/import/prepare')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            commitToken: 'token-1',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }

      if (url.startsWith('/api/attendance/import/preview')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                userId: 'user-1',
                workDate: '2026-03-23',
                workMinutes: 480,
                lateMinutes: 0,
                earlyLeaveMinutes: 0,
                status: 'normal',
                warnings: [],
                matchedPolicies: [],
              },
            ],
            rowCount: 1,
            truncated: false,
            stats: {
              invalid: 0,
              duplicates: 0,
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

  it('keeps preview and group timezone context in preview status feedback', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const section = findImportSection(container!)
    findButton(section, 'Preview').click()
    await flushUi()

    expect(container!.textContent).toContain('Preview loaded (1 rows).')
    expect(container!.textContent).toContain('Preview timezone:')
    expect(container!.textContent).toContain('Group timezone: Use import timezone (UTC')
  })

  it('keeps timezone context in local import validation errors', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, any>
    setupState.importForm.payload = '{'
    await flushUi()

    const section = findImportSection(container!)
    findButton(section, 'Preview').click()
    await flushUi()

    expect(container!.textContent).toContain('Invalid JSON payload for import.')
    expect(container!.textContent).toContain('Fix JSON syntax in payload and retry preview.')
    expect(container!.textContent).toContain('Preview timezone:')
    expect(container!.textContent).toContain('Group timezone: Use import timezone (UTC')
  })
})
