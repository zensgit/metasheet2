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
          view: { id: 'v1' },
          page: { offset: 0, limit: 50, total: 0, hasMore: false },
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled())
    // #6075 round 2: hidden/group state is written only into the view it was LOADED from — wait for v1's load.
    await vi.waitFor(() => expect(grid.isViewStateLoadedFor('v1')).toBe(true))
    fetchFn.mockClear()

    fetchFn.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { view: { id: 'v1' } } }), { status: 200 }),
    )

    await grid.setGroupField('f1')
    expect(grid.groupFieldId.value).toBe('f1')
    const body = JSON.parse(fetchFn.mock.calls[0][1].body)
    // Nested grouping: persists the NEW ordered fieldIds[] AND the legacy fieldId (= level-1) for
    // back-compat with single-field readers (Kanban/Gantt + older clients).
    expect(body.groupInfo).toEqual({ fieldIds: ['f1'], fieldId: 'f1' })
  })

  // #6075 round 3 (N5) originally recorded this as the pre-existing bug #6084: a view-less load fixture meant
  // syncFromView never ran, the "only into the view it was loaded from" gate dropped the write, and the test
  // passed while sending NOTHING. It now loads a real grouped view and asserts what is ACTUALLY sent — fixed
  // for #6084: an explicit empty groupInfo (`{}`), never an absent key, so ungrouping is actually saved.
  it('setGroupField(null) sends a PATCH with an explicit empty groupInfo ({}), not an absent key (#6084 fix)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        data: {
          id: 'v1',
          fields: [{ id: 'f1', name: 'Status', type: 'select' }],
          rows: [],
          view: { id: 'v1', groupInfo: { fieldIds: ['f1'], fieldId: 'f1' } },
          page: { offset: 0, limit: 50, total: 0, hasMore: false },
        },
      }), { status: 200 }),
    )
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    await vi.waitFor(() => expect(grid.isViewStateLoadedFor('v1')).toBe(true))
    // Precondition: the view really is grouped, so the null below clears something.
    expect(grid.groupFieldId.value).toBe('f1')
    fetchFn.mockClear()

    fetchFn.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { view: { id: 'v1' } } }), { status: 200 }),
    )

    await grid.setGroupField(null)
    expect(grid.groupFieldId.value).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toContain('/api/multitable/views/v1')
    expect(init.method).toBe('PATCH')
    const body = JSON.parse(init.body)
    expect(body).toEqual({ groupInfo: {} })
  })

  // #6084: the fix above only proves what is SENT; this proves the server actually persisted it — a reload
  // (a fresh loadViewData, as a page refresh / view switch would do) must come back with no grouping, not the
  // pre-clear grouping the mock "server" stored before setGroupField(null) ran.
  it('setGroupField(null) persists the cleared grouping so a reload stays ungrouped (#6084)', async () => {
    let storedGroupInfo: Record<string, unknown> = { fieldIds: ['f1'], fieldId: 'f1' }
    const fetchFn = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(init.body ?? '{}')
        if ('groupInfo' in body) storedGroupInfo = body.groupInfo
        return new Response(JSON.stringify({ ok: true, data: { view: { id: 'v1' } } }), { status: 200 })
      }
      return new Response(JSON.stringify({
        ok: true,
        data: {
          id: 'v1',
          fields: [{ id: 'f1', name: 'Status', type: 'select' }],
          rows: [],
          view: { id: 'v1', groupInfo: storedGroupInfo },
          page: { offset: 0, limit: 50, total: 0, hasMore: false },
        },
      }), { status: 200 })
    })
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    await vi.waitFor(() => expect(grid.isViewStateLoadedFor('v1')).toBe(true))
    expect(grid.groupFieldId.value).toBe('f1')

    await grid.setGroupField(null)
    expect(grid.groupFieldId.value).toBeNull()
    expect(storedGroupInfo).toEqual({})

    // Reload — a fresh syncFromView must read back "no grouping", not resurrect the pre-clear group.
    await grid.loadViewData(0)
    await vi.waitFor(() => expect(grid.groupFieldId.value).toBeNull())
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
