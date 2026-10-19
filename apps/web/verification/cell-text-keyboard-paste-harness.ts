// Browser-verification harness for grid keyboard paste (dev/CI only; outside src/, so vue-tsc and the
// app build ignore it). A plain-HTTP deployment reached by IP is not a secure context and has NO async
// Clipboard API, so this page removes it before mounting the real MetaGridTable: the only way a value
// can reach `patch-cell` is the browser's own paste event. Chrome dispatches that event at the element
// holding the caret (e.g. the text span inside a clicked cell), not at the focused grid root, which is
// exactly what a jsdom test that dispatches on the grid root cannot show.
import { createApp, h } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

declare global {
  interface Window {
    __GRID_PASTE__?: { ready: boolean; clipboardApi: boolean; patches: unknown[][] }
  }
}

Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => undefined })

const FIELDS: MetaField[] = [
  { id: 'title', name: 'Title', type: 'string' },
  { id: 'amount', name: 'Amount', type: 'number' },
]
const ROWS: MetaRecord[] = [
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
      onPatchCell: (...args: unknown[]) => { state.patches.push(args) },
    })
  },
}).mount('#app')

requestAnimationFrame(() => { state.ready = true })
