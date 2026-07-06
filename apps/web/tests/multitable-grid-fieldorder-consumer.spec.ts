/**
 * Slice 3b — the FE consumer of per-view (incl. per-user personal overlay) column order.
 * `useMultitableGrid.visibleFields` renders columns in the effective `view.fieldOrder` (server-resolved via
 * applyPersonalViewOverlay), FAIL-SOFT on stale/unknown/hidden ids.
 *
 * Design: docs/development/multitable-personal-views-slice3-fe-toggle-design-lock-20260706.md (G-FE-5).
 * G-FE-5: an unknown / missing / stale fieldOrder id must be ignored — no crash, no blank column, and no
 * real column ever dropped. The backend only whitelists string[]; it does NOT validate sheet membership,
 * so the FE must be robust.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'

import { useMultitableGrid } from '../src/multitable/composables/useMultitableGrid'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { MetaField } from '../src/multitable/types'

const field = (id: string, order: number): MetaField => ({ id, name: id, type: 'string', order })
const makeGrid = () =>
  useMultitableGrid({
    sheetId: ref('s1'),
    viewId: ref('v1'),
    client: new MultitableApiClient({ fetchFn: vi.fn(async () => new Response('{}', { status: 200 })) }),
  })
const ids = (grid: ReturnType<typeof makeGrid>) => grid.visibleFields.value.map((f) => f.id)

describe('useMultitableGrid — Slice 3b fieldOrder column consumer', () => {
  it('renders columns in view.fieldOrder; fields absent from fieldOrder keep natural order, appended', () => {
    const grid = makeGrid()
    grid.fields.value = [field('a', 1), field('b', 2), field('c', 3)]
    grid.syncFromView({ fieldOrder: ['c', 'a'] })
    expect(ids(grid)).toEqual(['c', 'a', 'b'])
  })

  it('empty / absent fieldOrder ⇒ natural field order, unchanged from before Slice 3b', () => {
    const grid = makeGrid()
    grid.fields.value = [field('a', 1), field('b', 2)]
    grid.syncFromView({ fieldOrder: [] })
    expect(ids(grid)).toEqual(['a', 'b'])
    grid.syncFromView({}) // no fieldOrder key at all
    expect(ids(grid)).toEqual(['a', 'b'])
  })

  it('G-FE-5: unknown / stale ids in fieldOrder are ignored — no crash, no blank column, no real column dropped', () => {
    const grid = makeGrid()
    grid.fields.value = [field('a', 1), field('b', 2)]
    grid.syncFromView({ fieldOrder: ['ghost', 'b', 'also-gone', 'a'] })
    expect(ids(grid)).toEqual(['b', 'a']) // real fields ordered; unknown ids dropped
    expect(ids(grid)).not.toContain('ghost')
    expect(grid.visibleFields.value.length).toBe(2) // exactly the real fields — no phantom column
  })

  it('G-FE-5: a fieldOrder that is ENTIRELY unknown ids falls back to natural order (never empties the grid)', () => {
    const grid = makeGrid()
    grid.fields.value = [field('a', 1), field('b', 2)]
    grid.syncFromView({ fieldOrder: ['x', 'y', 'z'] })
    expect(ids(grid)).toEqual(['a', 'b'])
  })

  it('G-FE-5: a duplicate id in fieldOrder does not duplicate the column', () => {
    const grid = makeGrid()
    grid.fields.value = [field('a', 1), field('b', 2)]
    grid.syncFromView({ fieldOrder: ['a', 'a', 'b'] })
    expect(ids(grid)).toEqual(['a', 'b'])
  })

  it('a fieldOrder id pointing at a HIDDEN field is skipped (stays hidden); the rest of the order is honored', () => {
    const grid = makeGrid()
    grid.fields.value = [field('a', 1), field('b', 2), field('c', 3)]
    grid.syncFromView({ hiddenFieldIds: ['b'], fieldOrder: ['b', 'c', 'a'] })
    expect(ids(grid)).toEqual(['c', 'a']) // b is hidden ⇒ never rendered, even though named first in fieldOrder
  })

  it('non-string entries in fieldOrder are filtered on ingest (defensive against a malformed payload)', () => {
    const grid = makeGrid()
    grid.fields.value = [field('a', 1), field('b', 2)]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    grid.syncFromView({ fieldOrder: ['b', 123 as any, null as any, 'a'] })
    expect(ids(grid)).toEqual(['b', 'a'])
  })
})
