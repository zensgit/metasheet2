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
import { createApp, h, nextTick, type App } from 'vue'
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

function makeRows(n: number): MetaRecord[] {
  const rows: MetaRecord[] = []
  for (let i = 0; i < n; i++) {
    rows.push({ id: `r${i}`, version: 1, data: { title: `Row ${i}`, score: i } })
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
