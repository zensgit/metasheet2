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

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function findImportSection(container: HTMLElement): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h4')).find(
    candidate => candidate.textContent?.trim() === 'Import (DingTalk / Manual)'
  )
  expect(heading, 'expected import section heading').toBeTruthy()
  const section = heading!.closest('.attendance__admin-section')
  expect(section, 'expected import section container').toBeTruthy()
  return section as HTMLElement
}

function previewRowCount(section: HTMLElement): number {
  return section.querySelectorAll('.attendance__table-wrapper .attendance__table tbody tr').length
}

function previewEmptyStateText(section: HTMLElement): string {
  return section.querySelector('.attendance__empty')?.textContent?.trim() ?? ''
}

function csvWarningText(section: HTMLElement): string {
  return Array.from(section.querySelectorAll('.attendance__status'))
    .map(node => node.textContent?.trim() ?? '')
    .find(text => text.includes('CSV warnings:')) ?? ''
}

function unwrapRef<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return (value as { value: T }).value
  }
  return value as T
}

describe('Attendance import preview regression', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('clears stale preview rows/warnings on preview retry failure and keeps retry action metadata', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    let previewRequestCount = 0

    apiFetchMock.mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.startsWith('/api/attendance/import/prepare')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            commitToken: `token-${previewRequestCount + 1}`,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }

      if (url.startsWith('/api/attendance/import/preview')) {
        previewRequestCount += 1
        if (previewRequestCount === 1) {
          return jsonResponse(200, {
            ok: true,
            data: {
              items: [
                {
                  userId: 'user-old',
                  workDate: '2026-03-01',
                  workMinutes: 480,
                  lateMinutes: 5,
                  earlyLeaveMinutes: 0,
                  status: 'late',
                  warnings: ['stale-item-warning'],
                  matchedPolicies: [],
                },
              ],
              csvWarnings: ['stale-csv-warning'],
              groupWarnings: ['stale-group-warning'],
              rowCount: 1,
            },
          })
        }

        return jsonResponse(502, {
          ok: false,
          error: {
            code: 'BAD_GATEWAY',
            message: 'gateway temporarily unavailable',
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

    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi(6)

    const importSection = findImportSection(container!)

    findButton(importSection, 'Preview').click()
    await flushUi(6)

    expect(importSection.textContent).toContain('user-old')
    expect(csvWarningText(importSection)).toContain('stale-csv-warning; stale-group-warning')
    expect(previewRowCount(importSection)).toBe(1)

    findButton(importSection, 'Preview').click()
    await flushUi(6)

    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    expect(previewRowCount(importSection)).toBe(0)
    expect(previewEmptyStateText(importSection)).toBe('No preview data.')
    expect(csvWarningText(importSection)).toBe('')
    expect(container!.textContent).toContain('Import preview request hit a temporary gateway error.')
    expect(container!.textContent).toContain('Code: BAD_GATEWAY')
    expect(container!.textContent).toContain('Retry preview')

    expect(unwrapRef<any[]>(setupState.importPreview)).toHaveLength(0)
    expect(unwrapRef<string[]>(setupState.importCsvWarnings)).toEqual([])
    expect(unwrapRef<Record<string, unknown> | null>(setupState.statusMeta)?.action).toBe('retry-preview-import')

    findButton(container!, 'Retry preview').click()
    await flushUi(6)

    expect(previewRequestCount).toBe(3)
    expect(previewRowCount(importSection)).toBe(0)
    expect(previewEmptyStateText(importSection)).toBe('No preview data.')
    expect(csvWarningText(importSection)).toBe('')
    expect(unwrapRef<any[]>(setupState.importPreview)).toHaveLength(0)
    expect(unwrapRef<string[]>(setupState.importCsvWarnings)).toEqual([])
    expect(unwrapRef<Record<string, unknown> | null>(setupState.statusMeta)?.action).toBe('retry-preview-import')
  })
})
