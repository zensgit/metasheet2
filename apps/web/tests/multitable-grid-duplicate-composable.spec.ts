/**
 * Duplicate / clone record (design 2026-06-16) — useMultitableGrid.duplicateRecord.
 * The composable POSTs to /records/:id/duplicate, returns the NEW record id on success (so the workbench can
 * open the clone), reloads the page, and sets a localized fallback error on failure. There is NO front-end
 * permission mirror — the server owns the value-copy + field-mask.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('useMultitableGrid.duplicateRecord', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })
  afterEach(() => {
    useLocale().setLocale('en')
    vi.restoreAllMocks()
  })

  it('POSTs to the duplicate endpoint, returns the new record id, and clears error', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/duplicate')) return jsonResponse({ ok: true, data: { record: { id: 'rec_clone', version: 1, data: {} } } })
      return jsonResponse({ ok: true, data: { rows: [], page: { total: 0, offset: 0, limit: 50 } } })
    })
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }) })

    const newId = await grid.duplicateRecord('rec_source')

    expect(newId).toBe('rec_clone')
    expect(grid.error.value).toBeNull()
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/multitable/records/rec_source/duplicate',
      expect.objectContaining({ method: 'POST' }),
    )
    // body carries the sheet/view context so the server can resolve the source sheet
    const body = JSON.parse((fetchFn.mock.calls.find((c) => String(c[0]).includes('/duplicate'))![1] as any).body)
    expect(body.sheetId).toBe('s1')
    expect(body.viewId).toBe('v1')
  })

  it('reloads the current page after a successful duplicate', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/duplicate')) return jsonResponse({ ok: true, data: { record: { id: 'rec_clone', version: 1, data: {} } } })
      return jsonResponse({ ok: true, data: { rows: [], page: { total: 0, offset: 0, limit: 50 } } })
    })
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }) })

    await grid.duplicateRecord('rec_source')

    // a view-data reload happened (a GET that is not the duplicate POST)
    expect(fetchFn.mock.calls.some((c) => !String(c[0]).includes('/duplicate'))).toBe(true)
  })

  it('keeps a backend error message raw ahead of the localized fallback', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('/duplicate')) return jsonResponse({ ok: false, error: { code: 'FORBIDDEN', message: 'backend duplicate raw' } }, 403)
      return jsonResponse({ ok: true, data: { rows: [], page: { total: 0, offset: 0, limit: 50 } } })
    })
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client: new MultitableApiClient({ fetchFn }) })

    const newId = await grid.duplicateRecord('rec_source')

    expect(newId).toBeNull()
    expect(grid.error.value).toBe('backend duplicate raw')
  })

  it('returns null and sets the localized fallback error when the failure carries no message', async () => {
    useLocale().setLocale('zh-CN')
    const client = new MultitableApiClient({ fetchFn: vi.fn(async () => jsonResponse({ ok: true, data: { rows: [], page: { total: 0, offset: 0, limit: 50 } } })) })
    // A message-less rejection (e.g. a non-Error throw) — the only path that reaches the FE fallback,
    // since the client always sets `.message` on HTTP errors.
    vi.spyOn(client, 'duplicateRecord').mockRejectedValue({})
    const grid = useMultitableGrid({ sheetId: ref('s1'), viewId: ref('v1'), client })

    const newId = await grid.duplicateRecord('rec_source')

    expect(newId).toBeNull()
    expect(grid.error.value).toBe('复制记录失败')
  })
})
