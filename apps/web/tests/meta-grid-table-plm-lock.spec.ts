/**
 * 备料 option B (awaiting the owner's A/B/C ruling): the grid renders PLM-system columns read-only.
 *
 * A column carrying `property.humanWriteLock = 'plm_system'` (a PLM column on a 备料 project sheet) must:
 *   - never open an inline editor, EVEN when the server-threaded `fieldReadOnlyIds` is stale/empty (the
 *     grid's own client-side check, MetaGridTable `isEditable`);
 *   - be SKIPPED by range fill — the human columns in the same range are still written, and the toolbar
 *     says the PLM columns were skipped; a range made only of PLM columns submits nothing and says so;
 *   - stay selectable (copying a range is reading, and reading is unaffected).
 *
 * Collected by the required web gate through the existing `meta-grid-table` token (a vitest path-substring
 * filter, apps/web/scripts/run-required-web-tests.sh). Fill (drag) only — no clipboard involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import { useLocale } from '../src/composables/useLocale'
import type { MetaField, MetaRecord, MetaRowActions } from '../src/multitable/types'
import type { RangeChange } from '../src/multitable/utils/grid-range-fill'

const LOCK = { humanWriteLock: 'plm_system' }
// Column 0 = locked PLM-system string (图号-like), 1 = human string (备注-like), 2 = locked PLM-system string.
function fields(): MetaField[] {
  return [
    { id: 'plmCode', name: 'PLM code', type: 'string', property: { ...LOCK } },
    { id: 'notes', name: 'Notes', type: 'string' },
    { id: 'plmKey', name: 'PLM key', type: 'string', property: { ...LOCK } },
  ]
}
function rows(): MetaRecord[] {
  return [0, 1, 2].map((i) => ({
    id: `r${i}`, version: 3 + i,
    data: { plmCode: `CODE-${i}`, notes: `note-${i}`, plmKey: `KEY-${i}` },
  }))
}
type GridState = {
  rows: MetaRecord[]
  visibleFields: MetaField[]
  rangeContextKey: string
  canEdit: boolean
  fieldReadOnlyIds: string[]
  rowActionOverrides: Record<string, MetaRowActions>
  commitRange: ((changes: RangeChange[]) => Promise<unknown>) | undefined
}

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

beforeEach(() => {
  useLocale().setLocale('en')
  vi.stubEnv('VITE_MULTITABLE_RANGE_FILL_ENABLED', 'true')
})
afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  vi.unstubAllEnvs()
})

async function mountGrid(overrides: Partial<GridState> = {}) {
  const commitRange = vi.fn(async (_changes: RangeChange[]) => {})
  const patchCell = vi.fn()
  const state = reactive<GridState>({
    rows: rows(), visibleFields: fields(), rangeContextKey: 'sheet1:view1', canEdit: true,
    // Deliberately EMPTY: the grid must not depend on the server's per-field map to keep a PLM column closed.
    fieldReadOnlyIds: [], rowActionOverrides: {}, commitRange, ...overrides,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup: () => () => h(MetaGridTable, {
      ...state, sortRules: [], loading: false, currentPage: 1, totalPages: 1, startIndex: 0,
      canDelete: true, canBulkEdit: true, enableMultiSelect: true, canComment: true,
      searchText: '', rowDensity: 'normal', groupField: null, collapsedGroupKeys: [],
      'onPatch-cell': patchCell,
    }),
  })
  app.mount(container)
  await nextTick()
  const root = container
  const get = (selector: string): HTMLElement => {
    const element = root.querySelector<HTMLElement>(selector)
    expect(element, selector).not.toBeNull()
    return element!
  }
  const cell = (row: number, col: number) => get(`[data-range-row="${row}"][data-range-col="${col}"]`)
  return { root, state, commitRange, patchCell, get, cell }
}
type Grid = Awaited<ReturnType<typeof mountGrid>>

async function mouse(target: HTMLElement, type: string, options: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options }))
  await nextTick()
}
async function rectangle(grid: Grid, top: number, left: number, bottom: number, right: number) {
  await mouse(grid.cell(top, left), 'mousedown')
  await mouse(grid.cell(bottom, right), 'mouseenter')
  await mouse(grid.cell(bottom, right), 'mouseup')
}
async function fill(grid: Grid, row: number, col: number) {
  await mouse(grid.get('[data-test="range-fill-handle"]'), 'mousedown')
  await mouse(grid.cell(row, col), 'mouseenter')
  await mouse(grid.cell(row, col), 'mouseup')
}
async function settled(grid: Grid) {
  await nextTick()
  await vi.waitFor(() => expect((grid.get('[data-test="range-mode"]') as HTMLSelectElement).disabled).toBe(false))
}
async function flushUi() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}
function editorOpen(root: HTMLElement): boolean {
  return !!root.querySelector('.meta-cell-editor__input')
}

describe('MetaGridTable — PLM-system columns are read-only for people (option B)', () => {
  it('a locked cell never opens the inline editor, even with an empty fieldReadOnlyIds; a human cell does', async () => {
    const grid = await mountGrid()
    const locked = grid.cell(0, 0)
    locked.click()
    locked.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(editorOpen(grid.root)).toBe(false)

    const human = grid.cell(0, 1)
    human.click()
    human.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flushUi()
    expect(editorOpen(grid.root)).toBe(true)
    expect(grid.patchCell).not.toHaveBeenCalled()
  })

  it('fill-down over [locked, human, locked] writes ONLY the human column and says the PLM columns were skipped', async () => {
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 0, 2)
    await fill(grid, 2, 0)
    await settled(grid)
    expect(grid.commitRange).toHaveBeenCalledTimes(1)
    expect(grid.commitRange).toHaveBeenCalledWith([
      { recordId: 'r1', fieldId: 'notes', value: 'note-0', expectedVersion: 4 },
      { recordId: 'r2', fieldId: 'notes', value: 'note-0', expectedVersion: 5 },
    ])
    const sent = grid.commitRange.mock.calls[0][0] as RangeChange[]
    expect(sent.some((change) => change.fieldId === 'plmCode' || change.fieldId === 'plmKey')).toBe(false)
    expect(grid.get('[data-test="range-status"]').textContent).toContain('PLM-system columns are read-only and were skipped')
  })

  it('fill-down of a locked column only submits nothing and says so', async () => {
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 0, 0)
    await fill(grid, 2, 0)
    await settled(grid)
    expect(grid.commitRange).not.toHaveBeenCalled()
    expect(grid.get('[data-test="range-status"]').textContent).toContain('Only read-only PLM-system columns selected; nothing submitted.')
  })

  it('a locked cell is still selectable (copying a range is reading)', async () => {
    const grid = await mountGrid()
    await rectangle(grid, 0, 0, 1, 0)
    const selected = Array.from(grid.root.querySelectorAll<HTMLElement>('.meta-grid__cell--range'))
      .map((element) => `${element.dataset.rangeRow}:${element.dataset.rangeCol}`)
    expect(selected).toEqual(['0:0', '1:0'])
    expect((grid.get('[data-test="range-copy"]') as HTMLButtonElement).disabled).toBe(false)
  })
})
