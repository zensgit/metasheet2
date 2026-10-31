/**
 * A1 — grid row virtualization (windowing) for MetaGridTable.
 *
 * The grid renders ONLY a visible window of rows (+ overscan) into the DOM instead of every loaded row,
 * so the node count stays bounded as the row set grows. This is a RENDER-ONLY change: the component is
 * fed rows directly (no data loading / masking touched), exactly like the record-lock spec mounts it.
 *
 * jsdom has no layout (clientHeight/scrollTop are 0), so we:
 *   - define a viewport height on the scroll wrap,
 *   - set scrollTop + dispatch a 'scroll' event to move the window,
 * and assert WINDOWING BEHAVIOR (rendered row count << total; window contents shift on scroll; frozen +
 * conditional-format cells still render in-window) — never brittle exact pixel counts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import type { EvaluatedFormatting, FieldScaleMap } from '../src/multitable/utils/conditional-formatting'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'title', name: 'Title', type: 'string' },
  { id: 'score', name: 'Score', type: 'number' },
]
const GROUP_FIELD: MetaField = { id: 'group', name: 'Group', type: 'string' }

function makeRows(n: number): MetaRecord[] {
  const rows: MetaRecord[] = []
  for (let i = 0; i < n; i++) {
    rows.push({ id: `r${i}`, version: 1, data: { title: `Row ${i}`, score: i, group: `Group ${i % 30}` } })
  }
  return rows
}

function mountGrid(rows: MetaRecord[], props: Record<string, unknown> = {}): HTMLDivElement {
  app?.unmount()
  container?.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows,
        visibleFields: FIELDS,
        sortRules: [],
        loading: false,
        currentPage: 1,
        totalPages: 1,
        startIndex: 0,
        canEdit: true,
        canDelete: true,
        searchText: '',
        rowDensity: 'normal',
        ...props,
      })
    },
  })
  app.mount(container)
  return container
}

/** Give the scroll wrap a real viewport height so windowing has a measurable window under jsdom. */
function setViewport(root: HTMLDivElement, clientHeight: number): HTMLElement {
  const wrap = root.querySelector('.meta-grid__table-wrap') as HTMLElement
  Object.defineProperty(wrap, 'clientHeight', { value: clientHeight, configurable: true })
  // jsdom returns 0 for offsetHeight too; leave row height to the density fallback (36px for 'normal').
  return wrap
}

function dataRowIds(root: HTMLDivElement): string[] {
  return Array.from(root.querySelectorAll('tbody tr.meta-grid__row'))
    .map((tr) => (tr.querySelector('[role="gridcell"]') ? tr : tr))
    .map((tr) => {
      // recover the row index from its visible row-number text (startIndex=0 → number = index+1)
      const num = tr.querySelector('.meta-grid__row-num span')?.textContent?.trim()
      return num ?? ''
    })
}

function renderedRowCount(root: HTMLDivElement): number {
  return root.querySelectorAll('tbody tr.meta-grid__row').length
}

function renderedGroupItemCount(root: HTMLDivElement): number {
  return root.querySelectorAll('tbody tr.meta-grid__row, tbody tr.meta-grid__group-header, tbody tr.meta-grid__group-subtotal').length
}

function spacerHeight(root: HTMLDivElement, selector: string): number {
  const cell = root.querySelector<HTMLElement>(`${selector} td`)
  const parsed = Number.parseFloat(cell?.style.height ?? '0')
  return Number.isFinite(parsed) ? parsed : 0
}

describe('MetaGridTable row virtualization (A1)', () => {
  it('renders only a windowed subset when N >> page rows', async () => {
    const root = mountGrid(makeRows(2000))
    setViewport(root, 600)
    // re-measure (mount measured against clientHeight 0 → default 600 viewport; still windowed)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    const count = renderedRowCount(root)
    // Far fewer than the 2000 total — windowing is in effect (assert behavior, not an exact count).
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThan(200)
    expect(count).toBeLessThan(2000)
    // Spacer rows reserve the off-screen height (bottom spacer present at top of a long list).
    expect(root.querySelector('[data-test="grid-bottom-spacer"]')).toBeTruthy()
  })

  it('shifts the rendered window when the container is scrolled', async () => {
    const root = mountGrid(makeRows(2000))
    const wrap = setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    const firstBefore = dataRowIds(root)[0]
    expect(firstBefore).toBe('1') // row index 0 → row number 1

    // Scroll far down: 36px row height * ~500 rows.
    wrap.scrollTop = 18000
    wrap.dispatchEvent(new Event('scroll'))
    await nextTick()

    const idsAfter = dataRowIds(root)
    const firstAfter = idsAfter[0]
    expect(firstAfter).not.toBe(firstBefore) // window moved
    expect(Number(firstAfter)).toBeGreaterThan(100) // we are deep in the list now
    // A top spacer now exists (rows scrolled above the window).
    expect(root.querySelector('[data-test="grid-top-spacer"]')).toBeTruthy()
    // Still windowed (not the whole 2000).
    expect(renderedRowCount(root)).toBeLessThan(200)
  })

  it('keeps frozen columns and conditional-format cells rendering inside the window', async () => {
    const rows = makeRows(2000)
    // Conditional formatting + a color-scale fill on a row that will be in the INITIAL window (row 0).
    const formatting: { byRecordId: Map<string, EvaluatedFormatting> } = {
      byRecordId: new Map<string, EvaluatedFormatting>([
        ['r0', { cellStyles: { score: { backgroundColor: '#ffeeee', color: '#900' } }, rowStyle: undefined }],
      ]),
    }
    const scale: FieldScaleMap = {
      byField: {
        score: { byRecordId: { r0: { scaleColor: '#34d399' } } },
      },
    }
    const root = mountGrid(rows, {
      frozenLeftColumnIds: ['title'], // freeze the first column
      conditionalFormatting: formatting,
      conditionalFormattingScale: scale,
    })
    setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    // Windowed (subset only).
    expect(renderedRowCount(root)).toBeLessThan(200)

    // Frozen first column: its body cells are position:sticky (the frozen styling is applied in-window).
    const firstRow = root.querySelector('tbody tr.meta-grid__row') as HTMLElement
    const firstCell = firstRow.querySelector('.meta-grid__cell') as HTMLElement
    expect(firstCell.style.position).toBe('sticky')

    // Conditional-format / scale-fill cell for r0 (in the initial window) renders with the scale-fill class.
    const scaleCell = root.querySelector('.meta-grid__cell--scale-fill') as HTMLElement | null
    expect(scaleCell).toBeTruthy()
  })

  it('renders ALL rows identically for a small dataset (no windowing, no regression)', async () => {
    const root = mountGrid(makeRows(10))
    setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    // Every row present, no spacer rows — common-case behavior is byte-for-byte unchanged.
    expect(renderedRowCount(root)).toBe(10)
    expect(root.querySelector('[data-test="grid-top-spacer"]')).toBeNull()
    expect(root.querySelector('[data-test="grid-bottom-spacer"]')).toBeNull()
  })

  it('keeps the keyboard-focused row inside the rendered window while navigating down', async () => {
    const root = mountGrid(makeRows(2000))
    const wrap = setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    const grid = root.querySelector('.meta-grid') as HTMLElement
    const scrollBefore = wrap.scrollTop
    // Drive ArrowDown well past the initial window (initial window ≈ 600/36 + overscan ≈ 32 rows).
    // Focus starts at -1; the first press moves to index 0, so N presses land on index N-1.
    const PRESSES = 80
    for (let i = 0; i < PRESSES; i++) {
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    }
    await nextTick()

    // The container scrolled to follow focus (focused row pushed below the viewport bottom).
    expect(wrap.scrollTop).toBeGreaterThan(scrollBefore)

    // The focused row (index PRESSES-1 → row number PRESSES) is actually mounted, not a stale/blank window.
    const focused = root.querySelector('tbody tr.meta-grid__row--focused') as HTMLElement | null
    expect(focused).toBeTruthy()
    expect(focused!.querySelector('.meta-grid__row-num span')?.textContent?.trim()).toBe(String(PRESSES))
    // Still windowed (the 2000-row set is not fully mounted).
    expect(renderedRowCount(root)).toBeLessThan(200)
  })

  it('does NOT window when a row is expanded (variable height fallback to full render)', async () => {
    const root = mountGrid(makeRows(2000))
    setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    // sanity: windowed before expand
    expect(renderedRowCount(root)).toBeLessThan(200)

    // Expand the first visible row via its expand button → windowing turns off, all rows render.
    const expandBtn = root.querySelector('.meta-grid__expand-btn') as HTMLButtonElement
    expandBtn.click()
    await nextTick()

    expect(renderedRowCount(root)).toBe(2000)
    expect(root.querySelector('[data-test="grid-top-spacer"]')).toBeNull()
    expect(root.querySelector('[data-test="grid-bottom-spacer"]')).toBeNull()
  })
})

describe('MetaGridTable grouped row virtualization (GW)', () => {
  it('renders only a windowed subset of grouped rows when grouped item count is large', async () => {
    const root = mountGrid(makeRows(3000), { groupField: GROUP_FIELD })
    setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    expect(renderedRowCount(root)).toBeGreaterThan(0)
    expect(renderedRowCount(root)).toBeLessThan(200)
    expect(renderedGroupItemCount(root)).toBeLessThan(240)
    expect(root.querySelector('[data-test="grid-bottom-spacer"]')).toBeTruthy()
    // C1: spacers reserve the exact full grouped stream height under jsdom's 36px density fallback.
    const fullItems = 3000 + 30 // data rows + group headers; no subtotal rows without aggregateGroups
    const mountedItems = renderedGroupItemCount(root)
    expect(spacerHeight(root, '[data-test="grid-top-spacer"]') + mountedItems * 36 + spacerHeight(root, '[data-test="grid-bottom-spacer"]')).toBe(fullItems * 36)
  })

  it('shifts the grouped rendered window when the container is scrolled', async () => {
    const root = mountGrid(makeRows(3000), { groupField: GROUP_FIELD })
    const wrap = setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    const firstBefore = dataRowIds(root)[0]
    expect(firstBefore).toBe('1')

    wrap.scrollTop = 18000
    wrap.dispatchEvent(new Event('scroll'))
    await nextTick()

    const firstAfter = dataRowIds(root)[0]
    expect(firstAfter).not.toBe(firstBefore)
    expect(Number(firstAfter)).toBeGreaterThan(100)
    expect(renderedRowCount(root)).toBeLessThan(200)
    expect(root.querySelector('[data-test="grid-top-spacer"]')).toBeTruthy()
  })

  it('renders small grouped sets fully without spacer rows', async () => {
    const root = mountGrid(makeRows(10), { groupField: GROUP_FIELD })
    setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    expect(renderedRowCount(root)).toBe(10)
    expect(root.querySelector('[data-test="grid-top-spacer"]')).toBeNull()
    expect(root.querySelector('[data-test="grid-bottom-spacer"]')).toBeNull()
  })

  it('keeps the keyboard-focused grouped row inside the rendered window while navigating down', async () => {
    const root = mountGrid(makeRows(3000), { groupField: GROUP_FIELD })
    const wrap = setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    const grid = root.querySelector('.meta-grid') as HTMLElement
    const scrollBefore = wrap.scrollTop
    const PRESSES = 80
    for (let i = 0; i < PRESSES; i++) {
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    }
    await nextTick()

    expect(wrap.scrollTop).toBeGreaterThan(scrollBefore)
    const focused = root.querySelector('tbody tr.meta-grid__row--focused') as HTMLElement | null
    expect(focused).toBeTruthy()
    expect(focused!.querySelector('.meta-grid__row-num span')?.textContent?.trim()).toBe(String(PRESSES))
    expect(renderedRowCount(root)).toBeLessThan(200)
  })

  it('keeps select-all model-based under grouped windowing', async () => {
    const onSelectionChange = vi.fn()
    const root = mountGrid(makeRows(3000), {
      groupField: GROUP_FIELD,
      enableMultiSelect: true,
      onSelectionChange,
    })
    setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    expect(renderedRowCount(root)).toBeLessThan(200)
    const checkbox = root.querySelector('thead input[type="checkbox"]') as HTMLInputElement
    checkbox.dispatchEvent(new Event('change'))
    await nextTick()

    const selected = onSelectionChange.mock.calls.at(-1)?.[0] as string[]
    expect(selected).toHaveLength(3000)
    expect(selected[0]).toBe('r0')
    expect(selected.at(-1)).toBe('r2999')
  })

  it('forces full grouped render during print and restores windowing after print', async () => {
    const root = mountGrid(makeRows(3000), { groupField: GROUP_FIELD })
    setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    expect(renderedRowCount(root)).toBeLessThan(200)
    window.dispatchEvent(new Event('beforeprint'))
    await nextTick()

    expect(renderedRowCount(root)).toBe(3000)
    expect(root.querySelector('[data-test="grid-top-spacer"]')).toBeNull()
    expect(root.querySelector('[data-test="grid-bottom-spacer"]')).toBeNull()

    window.dispatchEvent(new Event('afterprint'))
    await nextTick()
    expect(renderedRowCount(root)).toBeLessThan(200)
    expect(root.querySelector('[data-test="grid-bottom-spacer"]')).toBeTruthy()
  })

  it('keeps server subtotal values intact inside the grouped window', async () => {
    const root = mountGrid(makeRows(300), {
      groupField: GROUP_FIELD,
      aggregationConfig: { score: 'sum' },
      aggregateGroups: Array.from({ length: 30 }, (_, i) => ({
        key: `Group ${i}`,
        count: 10,
        aggregates: { score: { fn: 'sum', value: 9000 + i } },
      })),
    })
    setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    expect(renderedGroupItemCount(root)).toBeLessThan(120)
    const subtotal = root.querySelector('[data-test="group-subtotal"][data-group-path="Group 0"]') as HTMLElement | null
    expect(subtotal).toBeTruthy()
    expect(subtotal!.textContent).toContain('9000')
  })

  it('clamps to a nonblank grouped window after a controlled collapse while scrolled', async () => {
    app?.unmount()
    container?.remove()
    const collapsed = ref<string[]>([])
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      setup() {
        return () => h(MetaGridTable, {
          rows: makeRows(3000),
          visibleFields: FIELDS,
          sortRules: [],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          startIndex: 0,
          canEdit: true,
          canDelete: true,
          searchText: '',
          rowDensity: 'normal',
          groupField: GROUP_FIELD,
          collapsedGroupKeys: collapsed.value,
          onToggleGroup: (key: string) => {
            collapsed.value = collapsed.value.includes(key)
              ? collapsed.value.filter((item) => item !== key)
              : [...collapsed.value, key]
          },
        })
      },
    })
    app.mount(container)
    const root = container
    const wrap = setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    wrap.scrollTop = 18000
    wrap.dispatchEvent(new Event('scroll'))
    await nextTick()

    const header = root.querySelector('[data-test="group-header"]') as HTMLElement
    const toggledPath = header.getAttribute('data-group-path')
    header.click()
    await nextTick()

    expect(collapsed.value).toContain(toggledPath)
    expect(renderedGroupItemCount(root)).toBeGreaterThan(0)
    expect(renderedGroupItemCount(root)).toBeLessThan(240)
    expect(root.querySelector(`[data-test="group-header"][data-group-path="${toggledPath}"]`)).toBeTruthy()
  })
})

/**
 * A1 — infinite-scroll TRIGGER (the activation that makes the windowing engage). The grid emits
 * `load-more` when the user scrolls near the bottom of the FLAT body and a next page is available
 * (`canLoadMore`). The composable owns dedup + the actual append; here we assert the EMIT contract only.
 */
describe('MetaGridTable infinite-scroll load-more trigger (A1)', () => {
  // jsdom reports 0 for scrollHeight/clientHeight. Define them so "distance from bottom" is measurable:
  // a tall content (scrollHeight) in a short viewport (clientHeight), scrolled to a given scrollTop.
  function setScrollGeometry(root: HTMLDivElement, opts: { scrollHeight: number; clientHeight: number; scrollTop: number }): HTMLElement {
    const wrap = root.querySelector('.meta-grid__table-wrap') as HTMLElement
    Object.defineProperty(wrap, 'clientHeight', { value: opts.clientHeight, configurable: true })
    Object.defineProperty(wrap, 'scrollHeight', { value: opts.scrollHeight, configurable: true })
    wrap.scrollTop = opts.scrollTop
    return wrap
  }

  it('emits load-more when scrolled near the bottom and a next page is available', async () => {
    const loadMore = vi.fn()
    const root = mountGrid(makeRows(60), { canLoadMore: true, onLoadMore: loadMore })
    // tall content (2160px), 600px viewport; scroll to within the 400px threshold of the bottom.
    const wrap = setScrollGeometry(root, { scrollHeight: 2160, clientHeight: 600, scrollTop: 1300 })
    await nextTick()

    wrap.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(loadMore).toHaveBeenCalled()
  })

  it('does NOT emit load-more when far from the bottom', async () => {
    const loadMore = vi.fn()
    const root = mountGrid(makeRows(60), { canLoadMore: true, onLoadMore: loadMore })
    const wrap = setScrollGeometry(root, { scrollHeight: 2160, clientHeight: 600, scrollTop: 0 })
    await nextTick()

    wrap.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(loadMore).not.toHaveBeenCalled()
  })

  it('does NOT emit load-more when canLoadMore is false (end-of-data / small dataset)', async () => {
    const loadMore = vi.fn()
    const root = mountGrid(makeRows(60), { canLoadMore: false, onLoadMore: loadMore })
    const wrap = setScrollGeometry(root, { scrollHeight: 2160, clientHeight: 600, scrollTop: 1300 })
    await nextTick()

    wrap.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(loadMore).not.toHaveBeenCalled()
  })

  it('kicks one load-more when the loaded rows do not fill the viewport (no scrollbar) but more exist', async () => {
    const loadMore = vi.fn()
    // 10 rows; content shorter than the viewport → no scrollbar → scroll never fires, so a kick is needed.
    const root = mountGrid(makeRows(10), { canLoadMore: true, onLoadMore: loadMore })
    setScrollGeometry(root, { scrollHeight: 360, clientHeight: 600, scrollTop: 0 })
    window.dispatchEvent(new Event('resize')) // re-measures → maybeKickWhenNotScrollable
    await nextTick()
    expect(loadMore).toHaveBeenCalled()
  })
})

/**
 * 客户反馈 2026-10-27 (R74): the footer 「跳转到第 [ ] 行」 on a loaded row scrolls it into view. Windowed (more than
 * 60 rows) a pre-scroll by row arithmetic mounts it (jsdom has no layout, so the assertion is the scrollTop that
 * arithmetic produces); with windowing off, the mounted row is scrolled into view. Then the real geometry corrects
 * the scroll so the row sits in the band between the sticky header and the (optional) aggregation footer. jsdom
 * cannot see sticky geometry, so the correction is checked here with stubbed rects only; the real-browser witness
 * is verification/grid-row-jump-visibility.spec.ts (Multitable browser verify lane).
 */
describe('MetaGridTable footer row jump scrolls the row into view', () => {
  function jumpTo(root: HTMLDivElement, value: string): void {
    const input = root.querySelector('[data-testid="grid-row-jump-input"]') as HTMLInputElement
    input.value = value
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }

  it('windowed flat grid: row 1500 of 2000 loaded rows → scrollTop by row-height arithmetic, row mounted and focused', async () => {
    const onGoToPage = vi.fn()
    const root = mountGrid(makeRows(2000), { totalRows: 2000, pageSize: 50, onGoToPage })
    const wrap = setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    jumpTo(root, '1500')
    await nextTick()
    // Row 1500 is index 1499: its bottom is 1500 × 36px below the in-flow header (37px, the jsdom fallback). The
    // pre-scroll clears the header too, so the row bottom lands at the viewport's bottom edge. jsdom cannot see the
    // sticky header, so this is the arithmetic only; the browser lane is the visibility witness.
    expect(wrap.scrollTop).toBe(1500 * 36 + 37 - 600)
    expect(onGoToPage).not.toHaveBeenCalled()
    const focused = root.querySelector('tbody tr.meta-grid__row--focused') as HTMLElement | null
    expect(focused?.querySelector('.meta-grid__row-num span')?.textContent?.trim()).toBe('1500')
    expect(renderedRowCount(root)).toBeLessThan(200)
  })

  it('windowed grouped grid: the visible row number lands mounted and focused', async () => {
    const root = mountGrid(makeRows(3000), { groupField: GROUP_FIELD, totalRows: 3000, pageSize: 50 })
    const wrap = setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    jumpTo(root, '1000')
    await nextTick()
    expect(wrap.scrollTop).toBeGreaterThan(0)
    const focused = root.querySelector('tbody tr.meta-grid__row--focused') as HTMLElement | null
    expect(focused?.querySelector('.meta-grid__row-num span')?.textContent?.trim()).toBe('1000')
  })

  it('60 rows or fewer (windowing off): the mounted row is scrolled into view', async () => {
    // jsdom has no scrollIntoView; record which element it is called on.
    const scrolledInto: Element[] = []
    const original = (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
    ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function (this: Element) { scrolledInto.push(this) }
    try {
      const root = mountGrid(makeRows(30), { totalRows: 30, pageSize: 50 })
      const wrap = setViewport(root, 600)
      window.dispatchEvent(new Event('resize'))
      await nextTick()

      jumpTo(root, '25')
      await nextTick()
      await nextTick()
      expect(wrap.scrollTop).toBe(0)
      expect(scrolledInto).toHaveLength(1)
      const target = scrolledInto[0] as HTMLElement
      expect(target.classList.contains('meta-grid__row--focused')).toBe(true)
      expect(target.querySelector('.meta-grid__row-num span')?.textContent?.trim()).toBe('25')
    } finally {
      ;(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = original
    }
  })

  // Stubbed geometry (jsdom has none): the wrap spans y 100..536, the sticky header cell ends at 136, the sticky
  // aggregation footer starts at 500. scrollIntoView({ block: 'nearest' }) alone would leave an upward target at the
  // scrollport top, under the header.
  function stubRect(el: Element, top: number, height: number, scrolledBy?: () => number): void {
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const y = top - (scrolledBy ? scrolledBy() : 0)
        return { top: y, bottom: y + height, height, left: 0, right: 800, width: 800, x: 0, y, toJSON: () => ({}) }
      },
    })
  }

  async function settle(): Promise<void> {
    await nextTick()
    await nextTick()
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  }

  it('the row is corrected out from under the sticky header (upward jump) and above the aggregation footer (downward)', async () => {
    const original = (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
    ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function () { /* geometry stubbed below */ }
    try {
      const root = mountGrid(makeRows(30), {
        totalRows: 30,
        pageSize: 50,
        aggregationConfig: { title: 'count' },
        aggregates: { title: { fn: 'count', value: 30 } },
      })
      const wrap = setViewport(root, 436)
      window.dispatchEvent(new Event('resize'))
      await nextTick()
      stubRect(wrap, 100, 436)
      stubRect(root.querySelector('thead tr th') as Element, 100, 36)
      const footCell = root.querySelector('tfoot.meta-grid__foot tr > td:first-child') as Element
      expect(footCell).not.toBeNull()
      stubRect(footCell, 500, 36)
      wrap.scrollTop = 300
      // A body row moves with the scroll: its stubbed top is where it sits while scrollTop is 300.
      const moved = () => wrap.scrollTop - 300

      // Upward: after scrollIntoView the row's top is at the scrollport top (100), 36px under the header.
      const rows = root.querySelectorAll('tbody tr.meta-grid__row')
      stubRect(rows[4], 100, 36, moved)
      jumpTo(root, '5')
      await settle()
      expect(wrap.scrollTop).toBe(300 - 36)

      // Downward: the row's bottom is at the scrollport bottom (536), 36px under the footer.
      wrap.scrollTop = 300
      stubRect(rows[20], 500, 36, moved)
      jumpTo(root, '21')
      await settle()
      expect(wrap.scrollTop).toBe(300 + 36)

      // Already inside the band: nothing moves.
      wrap.scrollTop = 300
      stubRect(rows[10], 200, 36, moved)
      jumpTo(root, '11')
      await settle()
      expect(wrap.scrollTop).toBe(300)
    } finally {
      ;(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = original
    }
  })
})

/**
 * R78 known limitation e: a keyboard move that changes the focused row (ArrowUp/ArrowDown, and
 * ArrowLeft/ArrowRight/Tab when they wrap to another row) scrolls exactly like the footer row jump above, so the row
 * ends inside the band between the sticky header and the aggregation footer. A move within the row keeps the plain
 * window arithmetic. jsdom has no layout: the windowed case pins the arithmetic, the paged case uses stubbed rects;
 * the real-browser witness is verification/grid-row-jump-visibility.spec.ts.
 */
describe('MetaGridTable keyboard row moves use the row-jump band rule (R78 e)', () => {
  function press(root: HTMLDivElement, key: string, times = 1): void {
    const grid = root.querySelector('.meta-grid') as HTMLElement
    for (let i = 0; i < times; i++) grid.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }

  function focusedRowNumber(root: HTMLDivElement): string | undefined {
    return root.querySelector('tbody tr.meta-grid__row--focused .meta-grid__row-num span')?.textContent?.trim()
  }

  it('windowed: ArrowDown clears the in-flow header; a move within the row does not scroll; a wrap to the next row does', async () => {
    const root = mountGrid(makeRows(2000))
    const wrap = setViewport(root, 600)
    window.dispatchEvent(new Event('resize'))
    await nextTick()

    // Focus starts at -1, so 80 presses land on index 79 (row 80). Its bottom is 80 × 36px below the in-flow header
    // (37px, the jsdom fallback): the row bottom lands at the viewport's bottom edge, as the jump's pre-scroll does.
    press(root, 'ArrowDown', 80)
    await nextTick()
    expect(focusedRowNumber(root)).toBe('80')
    expect(wrap.scrollTop).toBe(80 * 36 + 37 - 600)

    // Within the row (column 0 → 1): the plain arithmetic is unchanged, so a position it accepts is kept.
    wrap.scrollTop = 80 * 36 - 600
    press(root, 'ArrowRight')
    await nextTick()
    expect(focusedRowNumber(root)).toBe('80')
    expect(wrap.scrollTop).toBe(80 * 36 - 600)

    // ArrowRight on the last column wraps to row 81: that is a row change, so the band rule applies.
    press(root, 'ArrowRight')
    await nextTick()
    expect(focusedRowNumber(root)).toBe('81')
    expect(wrap.scrollTop).toBe(81 * 36 + 37 - 600)
    expect(renderedRowCount(root)).toBeLessThan(200)
  })

  function stubRect(el: Element, top: number, height: number, scrolledBy?: () => number): void {
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        const y = top - (scrolledBy ? scrolledBy() : 0)
        return { top: y, bottom: y + height, height, left: 0, right: 800, width: 800, x: 0, y, toJSON: () => ({}) }
      },
    })
  }

  async function settle(): Promise<void> {
    await nextTick()
    await nextTick()
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  }

  // Same stubbed geometry as the jump case above: the wrap spans y 100..536, the sticky header cell ends at 136, the
  // sticky aggregation footer starts at 500. 30 rows are not windowed, so before this fix nothing scrolled at all.
  it('paged (not windowed): ArrowDown under the footer and ArrowUp under the header are corrected into the band; a row already inside stays put', async () => {
    const scrolledInto: Element[] = []
    const original = (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
    ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function (this: Element) { scrolledInto.push(this) }
    try {
      const root = mountGrid(makeRows(30), {
        totalRows: 30,
        pageSize: 50,
        aggregationConfig: { title: 'count' },
        aggregates: { title: { fn: 'count', value: 30 } },
      })
      const wrap = setViewport(root, 436)
      window.dispatchEvent(new Event('resize'))
      await nextTick()
      stubRect(wrap, 100, 436)
      stubRect(root.querySelector('thead tr th') as Element, 100, 36)
      const footCell = root.querySelector('tfoot.meta-grid__foot tr > td:first-child') as Element
      expect(footCell).not.toBeNull()
      stubRect(footCell, 500, 36)
      const moved = () => wrap.scrollTop - 300
      const rows = root.querySelectorAll('tbody tr.meta-grid__row')
      const clickCell = async (ri: number) => {
        ;(root.querySelector(`td[data-ri="${ri}"][data-ci="0"]`) as HTMLElement).click()
        await nextTick()
      }

      // Down: row 21's bottom is at the scrollport bottom (536), 36px under the footer.
      wrap.scrollTop = 300
      await clickCell(19)
      stubRect(rows[20], 500, 36, moved)
      press(root, 'ArrowDown')
      await settle()
      expect(focusedRowNumber(root)).toBe('21')
      expect(wrap.scrollTop).toBe(300 + 36)
      // The mounted row itself was scrolled to (block: 'nearest'), as the jump does with windowing off.
      expect(scrolledInto[scrolledInto.length - 1]?.classList.contains('meta-grid__row--focused')).toBe(true)

      // Up: row 5's top is at the scrollport top (100), 36px under the sticky header.
      wrap.scrollTop = 300
      await clickCell(5)
      stubRect(rows[4], 100, 36, moved)
      press(root, 'ArrowUp')
      await settle()
      expect(focusedRowNumber(root)).toBe('5')
      expect(wrap.scrollTop).toBe(300 - 36)

      // Already inside the band: nothing moves.
      wrap.scrollTop = 300
      await clickCell(10)
      stubRect(rows[11], 200, 36, moved)
      press(root, 'ArrowDown')
      await settle()
      expect(focusedRowNumber(root)).toBe('12')
      expect(wrap.scrollTop).toBe(300)
    } finally {
      ;(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView = original
    }
  })
})
