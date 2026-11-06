// Browser-verification harness for the grid footer 「跳转到第 [ ] 行」 (客户反馈 2026-10-27, R74). It mounts the
// REAL MetaGridTable under the app's production stylesheets (element-plus, tokens.css, App.vue's global reset) in a
// fixed-height box, and serves synthetic rows the way the workbench / useMultitableGrid serves them, so Playwright
// can measure whether the jumped row ends inside the band between the sticky header and the aggregation footer.
// jsdom has no sticky geometry; this is the visibility witness.
//
// Query params:
//   mode=all|paged  all: every row is held at once (windowed above 60 rows).
//                   paged: page 1 at offset 0; go-to-page replaces the rows with that page after ~60 ms with
//                   loading=true (50 rows per page is not windowed).
//   total=<n> size=<n> agg=1 (sticky aggregation footer)
import 'element-plus/dist/index.css'
import '../src/styles/tokens.css'
import { createApp, h, ref, computed } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

// App.vue's global (unscoped) reset, copied: it sets the line-height the real rows are laid out with.
const reset = document.createElement('style')
reset.textContent = [
  '* { margin: 0; padding: 0; box-sizing: border-box; }',
  "html, body { height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #333; background-color: var(--ms-bg-page); }",
].join('\n')
document.head.prepend(reset)

declare global {
  interface Window {
    __GRID_ROW_JUMP__?: { ready: boolean; selects: string[]; goToPage: number[]; offset: () => number }
  }
}

const params = new URLSearchParams(window.location.search)
const mode = params.get('mode') ?? 'all'
const total = Number(params.get('total') ?? '2000')
const size = Number(params.get('size') ?? '50')
const agg = params.get('agg') === '1'

const FIELDS: MetaField[] = [
  { id: 'code', name: 'Code', type: 'string' },
  { id: 'name', name: 'Name', type: 'string' },
  { id: 'qty', name: 'Qty', type: 'number' },
]
const ALL: MetaRecord[] = Array.from({ length: total }, (_, i): MetaRecord => ({
  id: `r${i}`,
  version: 1,
  data: { code: `C-${String(i + 1).padStart(5, '0')}`, name: `Item ${i + 1}`, qty: i + 1 },
}))

const rows = ref<MetaRecord[]>(mode === 'paged' ? ALL.slice(0, size) : ALL)
const offset = ref(0)
const loading = ref(false)
const selected = ref<string | null>(null)
const currentPage = computed(() => Math.floor(offset.value / size) + 1)
const totalPages = computed(() => Math.max(1, Math.ceil(total / size)))

const state = {
  ready: false,
  selects: [] as string[],
  goToPage: [] as number[],
  offset: () => offset.value,
}
window.__GRID_ROW_JUMP__ = state

function goToPage(p: number) {
  state.goToPage.push(p)
  if (mode !== 'paged') return
  const safe = Math.min(Math.max(1, p), totalPages.value)
  const nextOffset = (safe - 1) * size
  if (nextOffset === offset.value) return
  loading.value = true
  setTimeout(() => {
    rows.value = ALL.slice(nextOffset, nextOffset + size)
    offset.value = nextOffset
    loading.value = false
  }, 60)
}

createApp({
  setup() {
    return () => h(MetaGridTable, {
      rows: rows.value,
      visibleFields: FIELDS,
      sortRules: [],
      loading: loading.value,
      currentPage: currentPage.value,
      totalPages: totalPages.value,
      startIndex: offset.value,
      canEdit: true,
      canCreate: true,
      selectedRecordId: selected.value,
      searchText: '',
      rowDensity: 'normal',
      infiniteScroll: true,
      canLoadMore: false,
      totalRows: total,
      pageSize: size,
      pageSizeOptions: [50, 100, 200, 500],
      rangeContextKey: '["s1","v1"]',
      ...(agg ? { aggregationConfig: { qty: 'sum' }, aggregates: { qty: { fn: 'sum', value: 1 } } } : {}),
      onSelectRecord: (id: string) => { state.selects.push(id); selected.value = id },
      onGoToPage: goToPage,
    })
  },
}).mount('#app')

requestAnimationFrame(() => requestAnimationFrame(() => { state.ready = true }))
