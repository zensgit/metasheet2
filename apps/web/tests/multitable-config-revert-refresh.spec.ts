import { describe, expect, it, vi } from 'vitest'

import { refreshAfterConfigRevert } from '../src/multitable/views/config-revert-refresh'

// T9-W-3 blocker lock: after a successful config revert, MultitableWorkbench.onConfigReverted must
// reload sheet meta + grid (not just the history list) — otherwise the field name / view filter /
// grid stay stale behind a "撤销成功" toast. This locks the reload contract that onConfigReverted calls.
describe('refreshAfterConfigRevert — T9-W-3 post-revert UI refresh', () => {
  it('reloads sheet meta THEN the grid (meta before grid) with the active sheet + current offset', async () => {
    const order: string[] = []
    const loadSheetMeta = vi.fn(async (id: string) => { order.push(`meta:${id}`) })
    const loadViewData = vi.fn(async (off: number) => { order.push(`grid:${off}`) })

    await refreshAfterConfigRevert({ sheetId: 'sheet_1', loadSheetMeta, loadViewData, offset: 40 })

    expect(loadSheetMeta).toHaveBeenCalledWith('sheet_1')
    expect(loadViewData).toHaveBeenCalledWith(40)
    expect(order).toEqual(['meta:sheet_1', 'grid:40']) // meta reload BEFORE grid reload
  })

  it('does nothing when there is no active sheet (no stale-id reload)', async () => {
    const loadSheetMeta = vi.fn(async () => {})
    const loadViewData = vi.fn(async () => {})

    await refreshAfterConfigRevert({ sheetId: null, loadSheetMeta, loadViewData, offset: 0 })
    await refreshAfterConfigRevert({ sheetId: '', loadSheetMeta, loadViewData, offset: 0 })

    expect(loadSheetMeta).not.toHaveBeenCalled()
    expect(loadViewData).not.toHaveBeenCalled()
  })
})
