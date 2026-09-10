import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// BOM备料 错误码对照抽屉 (P1-6, I-22) — the DOM half of `codeHelp.ts`'s pure reversal.
//
// Guards this suite pins:
//   H1 防漏 (anti-drop): the drawer renders EXACTLY one row per key across the source tables —
//      computed independently here by importing the raw tables and summing `Object.keys(...).length`,
//      never by re-reading `codeHelp.ts`'s own internal list. A future edit that silently drops a row
//      (a bad filter, an off-by-one slice, a table forgotten after a rename) fails this count even if
//      the underlying table's own key count changes. A second case pins the COMPOSITION as well as the
//      total, so swapping one table for a different one of the same size cannot pass.
//   H2 搜索: narrows by CODE substring and by PROSE substring (zh), case-insensitively; an empty query
//      is the full list, not an empty one; a query matching nothing renders the empty state.
//   H3 双语: the SAME entry renders in Chinese under zh-CN and in English under any other locale.
//   H4 值面反向断言: no entry's rendered text looks like a business value (an email, a part/drawing
//      number shaped token) — every field here is authored prose, never response data, so this proves
//      the invariant rather than merely restating "no props were passed".
//   H5 抽屉: the panel IS a <details>, collapsed on first render (§2.4 P-7 / §6.2 P1-6 / §4.1 I-22 all
//      call it a 抽屉), and collapsing does not remove a single row from the DOM.
//   H6 诚实空态: the empty state carries a `data-empty-state` value (G2) and says "not in this
//      reference", never "no such code" (G4).

const h = vi.hoisted(() => ({ locale: 'zh-CN' as string }))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

import StockPreparationCodeHelpPanel from '../src/components/integration/stockPreparation/StockPreparationCodeHelpPanel.vue'
import { stockPrepCodeHelpEntries, stockPrepCodeHelpSearch } from '../src/services/integration/stockPreparation/codeHelp'
import {
  STOCK_PREP_ADMIN_ACTION_PLAIN,
  STOCK_PREP_BLOCKER_PLAIN,
  STOCK_PREP_BOARD_ERROR_PLAIN,
  STOCK_PREP_ERROR_PLAIN,
  STOCK_PREP_SOURCE_BLOCKER_PLAIN,
  STOCK_PREP_SOURCE_WARNING_PLAIN,
  STOCK_PREP_SYNC_REASON_PLAIN,
} from '../src/services/integration/stockPreparation/plainLanguage'

/**
 * H1's independent expectation — imported straight from `plainLanguage.ts`, NOT via `codeHelp.ts`, so
 * a regression in the module under test cannot also corrupt the number it is checked against. Keyed by
 * the `group` id the panel stamps on every row, so H1 can check COMPOSITION and not just the total:
 * replacing one table with a different table of the same size fails here, which a bare sum would not.
 */
const SOURCE_TABLES_BY_GROUP: Record<string, Record<string, unknown>> = {
  'error': STOCK_PREP_ERROR_PLAIN,
  'board-error': STOCK_PREP_BOARD_ERROR_PLAIN,
  'blocker': STOCK_PREP_BLOCKER_PLAIN,
  'source-blocker': STOCK_PREP_SOURCE_BLOCKER_PLAIN,
  'source-warning': STOCK_PREP_SOURCE_WARNING_PLAIN,
  // Included after review: StockPreparationProjectSyncPanel.vue renders `row.result.reason` as a bare
  // `<code>`, so these codes DO reach a person as text to look up.
  'sync-reason': STOCK_PREP_SYNC_REASON_PLAIN,
  'admin-action': STOCK_PREP_ADMIN_ACTION_PLAIN,
}

function expectedRowCount(): number {
  return Object.values(SOURCE_TABLES_BY_GROUP).reduce((total, table) => total + Object.keys(table).length, 0)
}

describe('BOM备料 错误码对照抽屉 (P1-6)', () => {
  let app: VueApp | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    h.locale = 'zh-CN'
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  async function mount(): Promise<HTMLDivElement> {
    app = createApp(StockPreparationCodeHelpPanel as Component)
    app.mount(container!)
    await nextTick()
    return container!
  }

  function rows(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll('[data-testid="stock-prep-code-help-row"]')) as HTMLElement[]
  }

  // ---------------------------------------------------------------------------
  // H1 — 防漏
  // ---------------------------------------------------------------------------

  it('H1: renders exactly one row per key across the source tables, unfiltered', async () => {
    const expected = expectedRowCount()
    // A positive control on the expectation itself: if this ever reads 0, the imports above are
    // broken and the test below would pass vacuously.
    expect(expected).toBeGreaterThan(30)

    const root = await mount()
    expect(rows(root).length).toBe(expected)
    expect(root.querySelector('[data-testid="stock-prep-code-help-count"]')?.textContent).toContain(String(expected))

    // ...and the pure function backing the panel agrees, independent of the DOM.
    expect(stockPrepCodeHelpEntries().length).toBe(expected)
  })

  it('H1: every row carries its source code, and every code is unique within its own table', async () => {
    const root = await mount()
    const codes = rows(root).map((row) => row.dataset.code)
    expect(codes.every((code) => typeof code === 'string' && code.length > 0)).toBe(true)
    // Duplicate (code, group) pairs would mean two rows collapsed into the same key during rendering.
    const pairs = rows(root).map((row) => `${row.dataset.group}:${row.dataset.code}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('H1: the COMPOSITION matches too — every group present, with its own exact key set', async () => {
    // A total-only assertion passes if a table is swapped for a different one of the same size. This
    // one compares each group's rendered code set against that group's own raw table, so a swapped,
    // renamed or dropped table fails even at an unchanged total.
    const root = await mount()
    const byGroup = new Map<string, string[]>()
    for (const row of rows(root)) {
      const group = row.dataset.group!
      byGroup.set(group, [...(byGroup.get(group) ?? []), row.dataset.code!])
    }
    expect([...byGroup.keys()].sort()).toEqual(Object.keys(SOURCE_TABLES_BY_GROUP).sort())
    for (const [group, table] of Object.entries(SOURCE_TABLES_BY_GROUP)) {
      expect(byGroup.get(group)!.slice().sort(), `group ${group} must render exactly its own keys`)
        .toEqual(Object.keys(table).slice().sort())
    }
  })

  // ---------------------------------------------------------------------------
  // H2 — 搜索
  // ---------------------------------------------------------------------------

  it('H2: searching by a CODE substring narrows to the matching row(s), case-insensitively', async () => {
    const root = await mount()
    const input = root.querySelector('[data-testid="stock-prep-code-help-search"]') as HTMLInputElement
    input.value = 'forbidden'
    input.dispatchEvent(new Event('input'))
    await nextTick()

    // Asserted as "narrowed, and the FORBIDDEN row is among the survivors" rather than "exactly one":
    // the search also scans prose, so a future entry whose sentence happens to contain "forbidden"
    // would otherwise turn this red for a reason that has nothing to do with the behaviour under test.
    const matched = rows(root)
    expect(matched.length).toBeGreaterThan(0)
    expect(matched.length).toBeLessThan(expectedRowCount())
    expect(matched.map((row) => row.dataset.code)).toContain('FORBIDDEN')
  })

  it('H2: searching by a PROSE substring narrows to the row(s) whose sentence contains it', async () => {
    const root = await mount()
    const input = root.querySelector('[data-testid="stock-prep-code-help-search"]') as HTMLInputElement
    // A phrase unique to `pull_principal_delegation_unavailable`'s zh line — nowhere in its own code.
    input.value = '当初绑定它的那个人'
    input.dispatchEvent(new Event('input'))
    await nextTick()

    const matched = rows(root)
    expect(matched.length).toBe(1)
    expect(matched[0].dataset.code).toBe('pull_principal_delegation_unavailable')
  })

  it('H2: an empty query is the FULL list, not an empty one — and a non-matching query empties it', async () => {
    const root = await mount()
    const input = root.querySelector('[data-testid="stock-prep-code-help-search"]') as HTMLInputElement
    const expected = expectedRowCount()

    input.value = '   '
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(rows(root).length, 'whitespace-only query must not filter anything out').toBe(expected)

    input.value = '这是一个不会出现在任何词表里的搜索词-zzz-999'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(rows(root).length).toBe(0)
    expect(root.querySelector('[data-testid="stock-prep-code-help-empty"]')).not.toBeNull()

    input.value = ''
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(rows(root).length).toBe(expected)
    expect(root.querySelector('[data-testid="stock-prep-code-help-empty"]')).toBeNull()
  })

  it('H2 (pure function): stockPrepCodeHelpSearch matches code, zh, en, zhNext and enNext', () => {
    const entries = stockPrepCodeHelpEntries()
    // A code-only match.
    expect(stockPrepCodeHelpSearch(entries, 'STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY').map((e) => e.code))
      .toEqual(['STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY'])
    // An English zhNext/enNext-only phrase (from FORBIDDEN's second line).
    const byNext = stockPrepCodeHelpSearch(entries, 'never to an individual')
    expect(byNext.some((e) => e.code === 'FORBIDDEN')).toBe(true)
    // No match at all.
    expect(stockPrepCodeHelpSearch(entries, 'zzz-not-a-real-code-zzz')).toEqual([])
  })

  // ---------------------------------------------------------------------------
  // H3 — 双语
  // ---------------------------------------------------------------------------

  it('H3: the same entry renders zh under zh-CN and en under any other locale', async () => {
    h.locale = 'zh-CN'
    const zhRoot = await mount()
    const zhRow = rows(zhRoot).find((row) => row.dataset.code === 'FORBIDDEN')!
    expect(zhRow.textContent).toContain('当前账号没有做这件事的权限')
    expect(zhRow.textContent).not.toContain('This account is not allowed')

    app!.unmount()
    app = null
    container!.innerHTML = ''

    h.locale = 'en-US'
    const enRoot = await mount()
    const enRow = rows(enRoot).find((row) => row.dataset.code === 'FORBIDDEN')!
    expect(enRow.textContent).toContain('This account is not allowed')
    expect(enRow.textContent).not.toContain('当前账号没有做这件事的权限')

    // The intro/search placeholder/count line switch too — not just the row content.
    expect(enRoot.querySelector('[data-testid="stock-prep-code-help-intro"]')?.textContent).not.toContain('对照')
  })

  // ---------------------------------------------------------------------------
  // H4 — 值面反向断言
  // ---------------------------------------------------------------------------

  it('H4: no entry looks like it carries a business value (email, part/drawing-number shaped token)', () => {
    const emailPattern = /[\w.+-]+@[\w-]+\.[\w.-]+/
    // Matches things shaped like the planted examples other stock-prep specs forbid — e.g.
    // "DWG-51190-C", "MAT-KK7781": 2-6 uppercase letters, a hyphen, then 3+ digits.
    const partNumberPattern = /\b[A-Z]{2,6}-\d{3,}[A-Z0-9-]*\b/
    for (const entry of stockPrepCodeHelpEntries()) {
      const blob = [entry.code, entry.zh, entry.en, entry.zhNext, entry.enNext].filter(Boolean).join(' ')
      expect(emailPattern.test(blob), `entry ${entry.code} looks like it contains an email`).toBe(false)
      expect(partNumberPattern.test(blob), `entry ${entry.code} looks like it contains a part/drawing number`).toBe(false)
    }
  })

  // ---------------------------------------------------------------------------
  // H5 — 抽屉 (collapsed by default) / H6 — 诚实空态
  // ---------------------------------------------------------------------------

  it('H5: the panel is a native <details>, COLLAPSED on first render, with every row still in the DOM', async () => {
    const root = await mount()
    const drawer = root.querySelector('[data-testid="stock-prep-code-help"]') as HTMLDetailsElement
    expect(drawer, 'the panel root must exist').not.toBeNull()
    expect(drawer.tagName.toLowerCase(), 'a native <details>, not a div with a class').toBe('details')
    expect(drawer.open, 'a 抽屉 opens on demand — it must not render expanded').toBe(false)
    // G6: a native disclosure, never `el-drawer`. The summary is the affordance.
    expect(root.querySelector('[data-testid="stock-prep-code-help-summary"]')?.tagName.toLowerCase()).toBe('summary')

    // Collapsed hides visually, never structurally: every row (and the search box) is still queryable,
    // which is what lets StockPreparationInstallView.spec.ts's P1-7c count rows without opening it.
    expect(rows(root).length).toBe(expectedRowCount())
    expect(root.querySelector('[data-testid="stock-prep-code-help-search"]')).not.toBeNull()
  })

  it('H6: the empty state is enumerated (G2) and says "not in this reference", never "no such code" (G4)', async () => {
    const root = await mount()
    const input = root.querySelector('[data-testid="stock-prep-code-help-search"]') as HTMLInputElement
    input.value = 'zzz-not-a-real-code-zzz'
    input.dispatchEvent(new Event('input'))
    await nextTick()

    const empty = root.querySelector('[data-testid="stock-prep-code-help-empty"]') as HTMLElement
    expect(empty).not.toBeNull()
    expect(empty.dataset.emptyState, 'G2: every new empty state carries an enumerated value').toBe('code-help-no-match')
    // G4: an admin pasting a real code from a support thread must not read this as "that code does not
    // exist" — the copy scopes the miss to this reference and names the next step.
    expect(empty.textContent).toContain('这不代表这个代码不存在')
    expect(empty.textContent).toContain('交给管理员')
  })

  it('H6: the intro makes a BOUNDED claim — it states its own count and disclaims being the全集', async () => {
    // The first draft opened with 「把系统里能报的每一个代码」 / "Every code this system can raise",
    // which is falsifiable on sight: plainLanguage.ts has 20+ tables and this drawer reads seven.
    const root = await mount()
    const intro = root.querySelector('[data-testid="stock-prep-code-help-intro"]') as HTMLElement
    expect(intro.textContent).not.toContain('每一个代码')
    expect(intro.textContent).toContain(String(expectedRowCount()))
    expect(intro.textContent).toContain('不是全系统所有代码的全集')
  })

  it('H4: the rendered panel never contains a realistic planted business value', async () => {
    // The same discipline StockPreparationInstallView.spec.ts's V-07 pins, restated here even though
    // this panel takes no props and so has no channel for a caller to plant one through: the panel's
    // own static content must not itself have accidentally been authored with example customer data.
    const FORBIDDEN = ['DWG-51190-C', 'MAT-KK7781', '涡轮增压器总成', 'sqlserver://sa:hunter2@10.2.3.4/PLM']
    const root = await mount()
    const rendered = root.textContent ?? ''
    for (const forbidden of FORBIDDEN) {
      expect(rendered, `values-free: "${forbidden}" reached the DOM`).not.toContain(forbidden)
    }
  })
})
