// Browser-verification harness for grid keyboard paste (dev/CI only; outside src/, so vue-tsc and the
// app build ignore it). A plain-HTTP deployment reached by IP is not a secure context and has NO async
// Clipboard API, so this page removes it before mounting the real MetaGridTable: the only way a value
// can reach `patch-cell` is the browser's own paste event. Chrome dispatches that event at the element
// holding the caret (e.g. the text span inside a clicked cell), not at the focused grid root, which is
// exactly what a jsdom test that dispatches on the grid root cannot show.
//
// `?layout=pinned` mounts a second, wider grid instead (customer field report 2026-10-21 #5): multi-select
// on, the first column frozen, enough columns to scroll horizontally — the sticky-layering check (header
// select-all must stay on top of the frozen column and the first body rows at any horizontal scroll).
// `&frozen=none` runs the same grid with no frozen column.
import { createApp, h } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

declare global {
  interface Window {
    __GRID_PASTE__?: { ready: boolean; clipboardApi: boolean; patches: unknown[][] }
  }
}

Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => undefined })

const params = new URLSearchParams(window.location.search)
const pinnedLayout = params.get('layout') === 'pinned'
// `&frozen=none` keeps the wide multi-select grid but freezes no column.
const frozenLeftColumnIds = params.get('frozen') === 'none' ? [] : ['code']

const FIELDS: MetaField[] = pinnedLayout
  ? [
      { id: 'code', name: 'Code', type: 'string' },
      ...Array.from({ length: 11 }, (_, i): MetaField => ({ id: `c${i}`, name: `Column ${i + 1}`, type: 'string' })),
    ]
  : [
      { id: 'title', name: 'Title', type: 'string' },
      { id: 'amount', name: 'Amount', type: 'number' },
    ]
const ROWS: MetaRecord[] = pinnedLayout
  ? Array.from({ length: 12 }, (_, r): MetaRecord => ({
      id: `p${r}`,
      version: 1,
      data: Object.fromEntries(FIELDS.map((f, c) => [f.id, `r${r + 1} c${c + 1}`])),
    }))
  : [
      { id: 'r0', version: 1, data: { title: 'first title', amount: 10 } },
      { id: 'r1', version: 2, data: { title: 'second title', amount: 20 } },
    ]

const state = { ready: false, clipboardApi: 'clipboard' in navigator && !!(navigator as { clipboard?: unknown }).clipboard, patches: [] as unknown[][] }
window.__GRID_PASTE__ = state

createApp({
  setup() {
    return () => h(MetaGridTable, {
      rows: ROWS,
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
      ...(pinnedLayout
        ? { enableMultiSelect: true, frozenLeftColumnIds, columnWidths: Object.fromEntries(FIELDS.map((f) => [f.id, 160])) }
        : {}),
      onPatchCell: (...args: unknown[]) => { state.patches.push(args) },
    })
  },
}).mount('#app')

requestAnimationFrame(() => { state.ready = true })
