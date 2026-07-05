// Grid performance measure-first baseline (Tier-B gap #4, docs/research/multitable-feishu-refresh-audit-20260629.md).
// NOT a virtualization implementation — A1 row-windowing already shipped (#3008, 2026-06-22). This
// measures actual mount time + real DOM node count via jsdom (Vue Test Utils-style createApp/mount,
// following this file's sibling multitable-grid-databar.spec.ts pattern), at scale, on both the
// windowed (flat) and unwindowed (grouped) paths. Real numbers from a real Vue+jsdom render — not a
// browser paint/scroll-jank measurement (that needs Playwright + a live dev server, out of scope here).
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, type App } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  app?.unmount(); app = null
  container?.remove(); container = null
  useLocale().setLocale('en')
})

const FIELDS: MetaField[] = [
  { id: 'idx', name: 'Index', type: 'number' },
  { id: 'label', name: 'Label', type: 'string' },
  { id: 'group', name: 'Group', type: 'string' },
]

function makeRows(n: number, groupBuckets = 0): MetaRecord[] {
  const out: MetaRecord[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      id: `r${i}`,
      version: 1,
      data: {
        idx: i,
        label: `row-${i}`,
        group: groupBuckets > 0 ? `g${i % groupBuckets}` : undefined,
      },
    })
  }
  return out
}

function mountGrid(props: Record<string, unknown>) {
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp({
    setup() {
      return () => h(MetaGridTable, {
        rows: [], visibleFields: FIELDS, sortRules: [], loading: false,
        currentPage: 1, totalPages: 1, startIndex: 0, canEdit: true,
        searchText: '', rowDensity: 'normal', ...props,
      })
    },
  })
  const t0 = performance.now()
  app.mount(container)
  const mountMs = performance.now() - t0
  return { root: container, mountMs }
}

function domRowCount(root: HTMLElement): number {
  return root.querySelectorAll('tbody tr.meta-grid__row').length
}

describe('grid perf baseline — flat (windowed) path', () => {
  it('1k rows: mounts fast, DOM row count is WINDOWED (far below row count)', () => {
    const rows = makeRows(1_000)
    const { root, mountMs } = mountGrid({ rows })
    const rendered = domRowCount(root)
    // eslint-disable-next-line no-console
    console.log(`[grid-perf] flat 1,000 rows: mount=${mountMs.toFixed(1)}ms, DOM rows=${rendered}`)
    expect(rendered).toBeLessThan(100) // VIRTUALIZE_MIN_ROWS=60 + 2*OVERSCAN_ROWS(8) window, generous margin
    expect(rendered).toBeGreaterThan(0)
  })

  it('10k rows: DOM row count STAYS windowed (not O(n))', () => {
    const rows = makeRows(10_000)
    const { root, mountMs } = mountGrid({ rows })
    const rendered = domRowCount(root)
    // eslint-disable-next-line no-console
    console.log(`[grid-perf] flat 10,000 rows: mount=${mountMs.toFixed(1)}ms, DOM rows=${rendered}`)
    expect(rendered).toBeLessThan(100)
  })

  it('100k rows (the audit gap\'s own target scale): DOM row count STAYS windowed, mount stays fast', () => {
    const rows = makeRows(100_000)
    const { root, mountMs } = mountGrid({ rows })
    const rendered = domRowCount(root)
    // eslint-disable-next-line no-console
    console.log(`[grid-perf] flat 100,000 rows: mount=${mountMs.toFixed(1)}ms, DOM rows=${rendered}`)
    expect(rendered).toBeLessThan(100)
    // Not a hard perf assertion (CI machines vary) — logged for the baseline doc's real numbers, the
    // meaningful assertion is the bounded DOM count above.
  })

  it('appending a page onto an already-large flat set (infinite-scroll growth) recomputes without blowing up', () => {
    const base = makeRows(50_000)
    const { root } = mountGrid({ rows: base })
    const before = domRowCount(root)
    // Simulate the parent appending the next page (A1 infinite-scroll growth 50k -> 50,050).
    const grown = base.concat(makeRows(50).map((r, i) => ({ ...r, id: `p${i}` })))
    const t0 = performance.now()
    app!.unmount()
    container!.remove()
    const remount = mountGrid({ rows: grown })
    const remountMs = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`[grid-perf] flat 50,000 -> 50,050 (simulated page-append via remount): ${remountMs.toFixed(1)}ms, DOM rows before=${before} after=${domRowCount(remount.root)}`)
    expect(domRowCount(remount.root)).toBeLessThan(100)
  })
})

describe('grid perf baseline — grouped path (NOT windowed — confirms the code-level finding)', () => {
  it('grouped mode renders EVERY row into the DOM regardless of scale (no windowing on this path)', () => {
    const N = 3_000
    const rows = makeRows(N, 30) // 30 groups, ~100 rows/group
    const groupField = FIELDS.find((f) => f.id === 'group')!
    const t0 = performance.now()
    const { root } = mountGrid({ rows, groupField })
    const mountMs = performance.now() - t0
    const rendered = domRowCount(root)
    // eslint-disable-next-line no-console
    console.log(`[grid-perf] GROUPED ${N} rows / 30 groups: mount=${mountMs.toFixed(1)}ms, DOM rows=${rendered} (expect ≈${N}, i.e. unwindowed)`)
    // The component's own code comment says windowing is "active only on the flat path... otherwise the
    // template renders every row exactly as before" — this assertion proves that in a REAL render, not
    // just from reading the comment.
    expect(rendered).toBeGreaterThan(N * 0.9)
  })
})
