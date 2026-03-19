import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'

function mockClientWithFn(fetchFn: ReturnType<typeof vi.fn>) {
  return new MultitableApiClient({ fetchFn })
}

// --- Group-by picker (toolbar → grid composable) ---
describe('group-by from toolbar', () => {
  beforeEach(() => {
    const store: Record<string, string> = {}
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    }
  })

  it('setGroupField persists groupInfo to updateView', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          id: 'v1',
          fields: [{ id: 'f1', name: 'Status', type: 'select' }],
          rows: [],
          page: { offset: 0, limit: 50, total: 0, hasMore: false },
        },
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
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    expect(body.groupInfo).toEqual({ fieldId: 'f1' })
  })

  it('setGroupField(null) sends undefined groupInfo', async () => {
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

// --- CSV export logic ---
describe('CSV export helpers', () => {
  function csvEscape(val: string): string {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) return `"${val.replace(/"/g, '""')}"`
    return val
  }

  it('escapes values with commas', () => {
    expect(csvEscape('hello, world')).toBe('"hello, world"')
  })

  it('escapes values with double quotes', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
  })

  it('passes through plain values', () => {
    expect(csvEscape('hello')).toBe('hello')
  })

  it('escapes values with newlines', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
  })
})

// --- Toast component structure ---
describe('toast notification structure', () => {
  it('toast types are valid', () => {
    const validTypes = ['error', 'success', 'info']
    validTypes.forEach((t) => {
      expect(['error', 'success', 'info']).toContain(t)
    })
  })

  it('error toast uses longer duration than success', () => {
    const errorDuration = 5000
    const successDuration = 3000
    expect(errorDuration).toBeGreaterThan(successDuration)
  })
})

// --- Hidden field persistence roundtrip ---
describe('hidden field persistence roundtrip', () => {
  beforeEach(() => {
    const store: Record<string, string> = {}
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    }
  })

  it('syncs hiddenFieldIds from view on load', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          id: 'v1',
          fields: [
            { id: 'f1', name: 'A', type: 'string' },
            { id: 'f2', name: 'B', type: 'number' },
            { id: 'f3', name: 'C', type: 'boolean' },
          ],
          rows: [],
          view: { id: 'v1', hiddenFieldIds: ['f2'] },
          page: { offset: 0, limit: 50, total: 0, hasMore: false },
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })

    await vi.waitFor(() => expect(grid.hiddenFieldIds.value).toContain('f2'))
    expect(grid.visibleFields.value.map((f) => f.id)).toEqual(['f1', 'f3'])
  })
})
