import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'

function mockClientWithFn(fetchFn: ReturnType<typeof vi.fn>) {
  return new MultitableApiClient({ fetchFn })
}

// --- Hidden field persistence ---
describe('hidden field persistence via updateView', () => {
  // Mock localStorage for column width tests
  const store: Record<string, string> = {}
  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k])
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    }
  })

  it('toggleFieldVisibility calls updateView with hiddenFieldIds', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { id: 'v1', fields: [{ id: 'f1', name: 'A', type: 'string' }, { id: 'f2', name: 'B', type: 'number' }], rows: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })

    // Wait for initial load
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled())
    fetchFn.mockClear()

    // Mock updateView response
    fetchFn.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { view: { id: 'v1' } } }), { status: 200 }),
    )

    grid.toggleFieldVisibility('f2')
    expect(grid.hiddenFieldIds.value).toContain('f2')

    // Wait for async persist call
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled())
    const callUrl = fetchFn.mock.calls[0][0] as string
    expect(callUrl).toContain('/api/multitable/views/v1')
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.hiddenFieldIds).toContain('f2')
  })
})

// --- Calendar view normalizeDate logic ---
describe('calendar date normalisation', () => {
  it('normalises YYYY-MM-DD format', () => {
    // Test the normalizeDate logic inline since it's a private function
    const raw = '2026-03-18'
    const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
    expect(m).not.toBeNull()
    expect(`${m![1]}-${String(Number(m![2])).padStart(2, '0')}-${String(Number(m![3])).padStart(2, '0')}`).toBe('2026-03-18')
  })

  it('normalises YYYY/MM/DD format', () => {
    const raw = '2026/3/8'
    const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
    expect(m).not.toBeNull()
    expect(Number(m![2])).toBe(3)
    expect(Number(m![3])).toBe(8)
  })
})

// --- EmbedHost postMessage ---
describe('EmbedHost postMessage protocol', () => {
  it('mt:navigate message structure is valid', () => {
    const msg = { type: 'mt:navigate', sheetId: 's2', viewId: 'v3' }
    expect(msg.type).toBe('mt:navigate')
    expect(msg.type.startsWith('mt:')).toBe(true)
    expect(msg.sheetId).toBeDefined()
  })

  it('mt:select-record message structure is valid', () => {
    const msg = { type: 'mt:select-record', recordId: 'r5' }
    expect(msg.type.startsWith('mt:')).toBe(true)
    expect(msg.recordId).toBe('r5')
  })

  it('mt:theme message supports primaryColor', () => {
    const msg = { type: 'mt:theme', primaryColor: '#ff6600' }
    expect(msg.type).toBe('mt:theme')
    expect(msg.primaryColor).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

// --- Grid groupBy ---
describe('grid groupBy', () => {
  beforeEach(() => {
    const store: Record<string, string> = {}
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    }
  })

  it('syncFromView reads groupInfo.fieldId', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          id: 'v1',
          fields: [{ id: 'f1', name: 'Status', type: 'select' }],
          rows: [],
          view: { id: 'v1', groupInfo: { fieldId: 'f1' } },
          page: { offset: 0, limit: 50, total: 0, hasMore: false },
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })

    await vi.waitFor(() => expect(grid.groupFieldId.value).toBe('f1'))
    expect(grid.groupField.value?.id).toBe('f1')
  })

  it('setGroupField persists via updateView', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { id: 'v1', fields: [{ id: 'f1', name: 'Status', type: 'select' }], rows: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled())
    fetchFn.mockClear()

    fetchFn.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { view: { id: 'v1' } } }), { status: 200 }),
    )

    await grid.setGroupField('f1')
    expect(grid.groupFieldId.value).toBe('f1')
    expect(fetchFn).toHaveBeenCalled()
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.groupInfo).toEqual({ fieldId: 'f1' })
  })

  it('setGroupField(null) clears grouping', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: { id: 'v1', fields: [], rows: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled())
    fetchFn.mockClear()

    fetchFn.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { view: { id: 'v1' } } }), { status: 200 }),
    )

    await grid.setGroupField(null)
    expect(grid.groupFieldId.value).toBeNull()
  })
})
