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

function findSection(container: HTMLElement, headingText: string): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h4')).find(
    candidate => candidate.textContent?.trim() === headingText,
  )
  expect(heading, `expected heading "${headingText}"`).toBeTruthy()
  const section = heading?.closest('.attendance__admin-section')
  expect(section, `expected section for "${headingText}"`).toBeTruthy()
  return section as HTMLElement
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label,
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function unwrapRef<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return (value as { value: T }).value
  }
  return value as T
}

function adminStatusText(container: HTMLElement): string {
  const status = container.querySelector('.attendance__status-block--admin .attendance__status')
  expect(status).toBeTruthy()
  return status?.textContent?.trim() || ''
}

function findTableWrapper(container: HTMLElement, text: string): HTMLElement {
  const wrapper = Array.from(container.querySelectorAll('.attendance__table-wrapper')).find(
    candidate => candidate.textContent?.includes(text),
  )
  expect(wrapper, `expected table wrapper containing "${text}"`).toBeTruthy()
  return wrapper as HTMLElement
}

describe('Attendance import batch timezone status', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.includes('/api/attendance/import/batches/batch-1/items')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [],
          },
        })
      }
      if (url.includes('/api/attendance/import/rollback/batch-1')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            ok: true,
          },
        })
      }
      if (url.includes('/api/attendance/import/batches?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [],
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
    vi.unstubAllGlobals()
    app = null
    container = null
  })

  it('keeps timezone context visible when batch items load into an empty result', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    unwrapRef<any[]>(setupState.importBatches).push({
      id: 'batch-1',
      status: 'completed',
      rowCount: 0,
      meta: {},
      source: 'manual',
      ruleSetId: '',
      createdAt: '2026-03-23T00:00:00.000Z',
    })
    await flushUi()

    const importSection = findSection(container!, 'Import (DingTalk / Manual)')
    const batchesWrapper = findTableWrapper(importSection, 'View items')
    expect(batchesWrapper.textContent).toContain('Preview timezone:')
    expect(batchesWrapper.textContent).toContain('Group timezone:')

    findButton(importSection, 'View items').click()
    await flushUi()

    expect(adminStatusText(container!)).toContain('Batch items loaded (0 rows).')
    expect(adminStatusText(container!)).toContain('Preview timezone:')
    expect(adminStatusText(container!)).toContain('Group timezone:')

    const emptyState = Array.from(importSection.querySelectorAll('.attendance__empty')).find(
      candidate => candidate.textContent?.includes('No batch items.'),
    )
    expect(emptyState).toBeTruthy()
    expect(emptyState?.parentElement?.textContent || emptyState?.textContent || '').toContain('Preview timezone:')
    expect(emptyState?.parentElement?.textContent || emptyState?.textContent || '').toContain('Group timezone:')
  })

  it('keeps timezone context visible inside the loaded batch items table', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    unwrapRef<any[]>(setupState.importBatches).push({
      id: 'batch-1',
      status: 'completed',
      rowCount: 1,
      meta: {},
      source: 'manual',
      ruleSetId: '',
      createdAt: '2026-03-23T00:00:00.000Z',
    })
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.includes('/api/attendance/import/batches/batch-1/items')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'item-1',
                workDate: '2026-03-23',
                userId: 'user-1',
                recordId: 'record-1',
                previewSnapshot: null,
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/import/batches?')) {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
    })
    await flushUi()

    const importSection = findSection(container!, 'Import (DingTalk / Manual)')
    findButton(importSection, 'View items').click()
    await flushUi()

    const itemsWrapper = findTableWrapper(importSection, 'Batch items')
    expect(itemsWrapper.textContent).toContain('Preview timezone:')
    expect(itemsWrapper.textContent).toContain('Group timezone:')
    expect(itemsWrapper.textContent).toContain('user-1')
  })

  it('keeps timezone context visible when viewing a batch snapshot', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    unwrapRef<any[]>(setupState.importBatches).push({
      id: 'batch-1',
      status: 'completed',
      rowCount: 1,
      meta: {},
      source: 'manual',
      ruleSetId: '',
      createdAt: '2026-03-23T00:00:00.000Z',
    })
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.includes('/api/attendance/import/batches/batch-1/items')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'item-1',
                workDate: '2026-03-23',
                userId: 'user-1',
                recordId: 'record-1',
                previewSnapshot: {
                  metrics: {
                    status: 'normal',
                  },
                },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/import/batches?')) {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
    })
    await flushUi()

    const importSection = findSection(container!, 'Import (DingTalk / Manual)')
    findButton(importSection, 'View items').click()
    await flushUi()
    findButton(importSection, 'View').click()
    await flushUi()

    const snapshotPanel = container!.querySelector('.attendance__snapshot-panel')
    expect(snapshotPanel).toBeTruthy()
    expect(snapshotPanel?.textContent).toContain('Snapshot context:')
    expect(snapshotPanel?.textContent).toContain('userId: user-1')
    expect(snapshotPanel?.textContent).toContain('workDate: 2026-03-23')
    expect(snapshotPanel?.textContent).toContain('recordId: record-1')
    expect(snapshotPanel?.textContent).toContain('Preview timezone:')
    expect(snapshotPanel?.textContent).toContain('Group timezone:')
    expect(snapshotPanel?.textContent).toContain('"status": "normal"')
  })

  it('falls back to placeholder snapshot context when context is missing', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    unwrapRef<any[]>(setupState.importBatches).push({
      id: 'batch-1',
      status: 'completed',
      rowCount: 1,
      meta: {},
      source: 'manual',
      ruleSetId: '',
      createdAt: '2026-03-23T00:00:00.000Z',
    })
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.includes('/api/attendance/import/batches/batch-1/items')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'item-1',
                workDate: '2026-03-23',
                userId: 'user-1',
                recordId: 'record-1',
                previewSnapshot: {
                  metrics: {
                    status: 'normal',
                  },
                },
              },
            ],
          },
        })
      }
      if (url.includes('/api/attendance/import/batches?')) {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
    })
    await flushUi()

    const importSection = findSection(container!, 'Import (DingTalk / Manual)')
    findButton(importSection, 'View items').click()
    await flushUi()

    setupState.importBatchSnapshot = {
      snapshot: {
        metrics: {
          status: 'normal',
        },
      },
    }
    await flushUi()

    const snapshotPanel = container!.querySelector('.attendance__snapshot-panel')
    expect(snapshotPanel).toBeTruthy()
    expect(snapshotPanel?.textContent).toContain('Snapshot context:')
    expect(snapshotPanel?.textContent).toContain('userId: --')
    expect(snapshotPanel?.textContent).toContain('workDate: --')
    expect(snapshotPanel?.textContent).toContain('recordId: --')
  })

  it('includes timezone context in rollback status feedback', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    unwrapRef<any[]>(setupState.importBatches).push({
      id: 'batch-1',
      status: 'completed',
      rowCount: 3,
      meta: {},
      source: 'manual',
      ruleSetId: '',
      createdAt: '2026-03-23T00:00:00.000Z',
    })
    await flushUi()

    const importSection = findSection(container!, 'Import (DingTalk / Manual)')
    findButton(importSection, 'Rollback').click()
    await flushUi()

    expect(adminStatusText(container!)).toContain('Import batch rolled back.')
    expect(adminStatusText(container!)).toContain('Preview timezone:')
    expect(adminStatusText(container!)).toContain('Group timezone:')
  })
})
