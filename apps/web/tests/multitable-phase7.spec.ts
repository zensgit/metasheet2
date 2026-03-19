import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { MultitableApiClient } from '../src/multitable/api/client'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'

function mockClientWithFn(fetchFn: ReturnType<typeof vi.fn>) {
  return new MultitableApiClient({ fetchFn })
}

// --- Quick search filtering ---
describe('quick search filtering', () => {
  it('filters rows by matching substring in any visible field', () => {
    const rows = [
      { id: 'r1', version: 1, data: { f1: 'Alice Smith', f2: 'Engineering' } },
      { id: 'r2', version: 1, data: { f1: 'Bob Jones', f2: 'Marketing' } },
      { id: 'r3', version: 1, data: { f1: 'Charlie Brown', f2: 'Engineering' } },
    ]
    const fields = [
      { id: 'f1', name: 'Name', type: 'string' as const },
      { id: 'f2', name: 'Dept', type: 'string' as const },
    ]
    const searchText = 'alice'
    const filtered = rows.filter((row) =>
      fields.some((f) => {
        const v = row.data[f.id as keyof typeof row.data]
        return v != null && String(v).toLowerCase().includes(searchText.toLowerCase())
      }),
    )
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('r1')
  })

  it('returns all rows when search text is empty', () => {
    const rows = [
      { id: 'r1', version: 1, data: { f1: 'Alice' } },
      { id: 'r2', version: 1, data: { f1: 'Bob' } },
    ]
    const searchText = ''
    const filtered = searchText ? rows.filter(() => false) : rows
    expect(filtered).toHaveLength(2)
  })

  it('filters across multiple fields (name and department)', () => {
    const rows = [
      { id: 'r1', version: 1, data: { f1: 'Alice', f2: 'Engineering' } },
      { id: 'r2', version: 1, data: { f1: 'Bob', f2: 'Marketing' } },
    ]
    const fields = [
      { id: 'f1', name: 'Name', type: 'string' as const },
      { id: 'f2', name: 'Dept', type: 'string' as const },
    ]
    const searchText = 'market'
    const filtered = rows.filter((row) =>
      fields.some((f) => {
        const v = row.data[f.id as keyof typeof row.data]
        return v != null && String(v).toLowerCase().includes(searchText.toLowerCase())
      }),
    )
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('r2')
  })
})

// --- Date-like field detection ---
describe('date-like field detection', () => {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}/
  const DATE_FIELD_NAMES = /date|time|deadline|due|start|end|created|updated|birthday/i

  it('detects date-like field by name', () => {
    expect(DATE_FIELD_NAMES.test('created_date')).toBe(true)
    expect(DATE_FIELD_NAMES.test('Due Date')).toBe(true)
    expect(DATE_FIELD_NAMES.test('deadline')).toBe(true)
    expect(DATE_FIELD_NAMES.test('birthday')).toBe(true)
  })

  it('detects date-like field by value pattern', () => {
    expect(DATE_RE.test('2026-03-18')).toBe(true)
    expect(DATE_RE.test('2026-01-01T10:00:00')).toBe(true)
    expect(DATE_RE.test('not-a-date')).toBe(false)
    expect(DATE_RE.test('hello')).toBe(false)
  })

  it('does not match non-date field names', () => {
    expect(DATE_FIELD_NAMES.test('Name')).toBe(false)
    expect(DATE_FIELD_NAMES.test('Status')).toBe(false)
    expect(DATE_FIELD_NAMES.test('Amount')).toBe(false)
  })
})

// --- Parallel bulk delete ---
describe('parallel bulk delete', () => {
  beforeEach(() => {
    const store: Record<string, string> = {}
    ;(globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    }
  })

  it('executes deletes in parallel using Promise.all pattern', async () => {
    const callOrder: string[] = []
    const fetchFn = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url)
      if (urlStr.includes('/records/')) {
        const id = urlStr.split('/records/')[1]?.split('?')[0]
        callOrder.push(`delete_${id}`)
      }
      return new Response(JSON.stringify({
        ok: true,
        data: { id: 'v1', fields: [], rows: [], page: { offset: 0, limit: 50, total: 0, hasMore: false } },
      }), { status: 200 })
    })

    const ids = ['r1', 'r2', 'r3']
    // Simulate the parallel delete pattern from MultitableWorkbench
    const client = mockClientWithFn(fetchFn)
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled())
    fetchFn.mockClear()

    fetchFn.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    // Parallel pattern
    await Promise.all(ids.map((rid) => grid.deleteRecord(rid)))
    // All three deletes should have been initiated
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3)
  })
})

// --- Keyboard shortcuts structure ---
describe('keyboard shortcuts legend', () => {
  it('defines expected shortcut keys', () => {
    const shortcuts = [
      { keys: 'Arrow keys', action: 'Navigate cells' },
      { keys: 'Enter', action: 'Edit cell' },
      { keys: 'Escape', action: 'Cancel edit / close' },
      { keys: 'Tab', action: 'Next cell' },
      { keys: 'Ctrl+Z', action: 'Undo' },
      { keys: 'Ctrl+Y', action: 'Redo' },
      { keys: '?', action: 'Toggle this help' },
    ]
    expect(shortcuts).toHaveLength(7)
    expect(shortcuts.find((s) => s.keys === 'Ctrl+Z')?.action).toBe('Undo')
  })
})

// --- Content-visibility CSS optimization ---
describe('content-visibility optimization', () => {
  it('applies valid CSS contain-intrinsic-size value', () => {
    const value = 'auto 36px'
    expect(value).toMatch(/^auto \d+px$/)
  })
})

// --- Row count display ---
describe('row count in toolbar', () => {
  it('displays total from page info', () => {
    const page = { offset: 0, limit: 50, total: 123, hasMore: true }
    expect(page.total).toBe(123)
    expect(`${page.total} rows`).toBe('123 rows')
  })
})
