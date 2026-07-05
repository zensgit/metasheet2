// Browser-verification harness for grouped grid windowing. It mounts the real
// MetaGridTable with a production-scale grouped row set and publishes bounded,
// values-free render metrics for Playwright to assert.
import { createApp, h, nextTick } from 'vue'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

declare global {
  interface Window {
    __GW_METRICS__?: GroupedWindowingMetrics
  }
}

interface Snapshot {
  dataRows: number
  groupHeaders: number
  groupSubtotals: number
  mountedItems: number
  topSpacerHeight: number
  bottomSpacerHeight: number
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  firstRowNumber: string | null
  lastRowNumber: string | null
}

interface GroupedWindowingMetrics {
  ready: true
  rows: number
  groups: number
  expectedFullDataRows: number
  expectedFullGroupHeaders: number
  mountMs: number
  scrollFrameMs: number
  initial: Snapshot
  afterScroll: Snapshot
}

const params = new URLSearchParams(window.location.search)
const ROW_COUNT = Math.max(1, Math.min(20_000, Number(params.get('rows') ?? 5_000) || 5_000))
const GROUP_COUNT = Math.max(1, Math.min(500, Number(params.get('groups') ?? 50) || 50))

const FIELDS: MetaField[] = [
  { id: 'group', name: 'Group', type: 'string' },
  { id: 'title', name: 'Title', type: 'string' },
  { id: 'score', name: 'Score', type: 'number' },
]
const GROUP_FIELD = FIELDS[0]

function makeRows(n: number, groups: number): MetaRecord[] {
  const rows: MetaRecord[] = []
  for (let i = 0; i < n; i++) {
    const group = `Group ${String(i % groups).padStart(3, '0')}`
    rows.push({
      id: `r${i}`,
      version: 1,
      data: {
        group,
        title: `Row ${i}`,
        score: i,
      },
    })
  }
  return rows
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function flushRender(): Promise<void> {
  await nextTick()
  await nextFrame()
  await nextTick()
}

function spacerHeight(selector: string): number {
  const el = document.querySelector<HTMLElement>(selector)
  const cell = el?.querySelector<HTMLElement>('td')
  if (!cell) return 0
  const parsed = Number.parseFloat(cell.style.height || getComputedStyle(cell).height || '0')
  return Number.isFinite(parsed) ? parsed : 0
}

function snapshot(): Snapshot {
  const wrap = document.querySelector<HTMLElement>('.meta-grid__table-wrap')
  const rowNumbers = Array.from(document.querySelectorAll<HTMLElement>('tbody tr.meta-grid__row .meta-grid__row-num span'))
    .map((el) => el.textContent?.trim() ?? '')
    .filter(Boolean)
  const dataRows = document.querySelectorAll('tbody tr.meta-grid__row').length
  const groupHeaders = document.querySelectorAll('tbody tr.meta-grid__group-header').length
  const groupSubtotals = document.querySelectorAll('tbody tr.meta-grid__group-subtotal').length
  return {
    dataRows,
    groupHeaders,
    groupSubtotals,
    mountedItems: dataRows + groupHeaders + groupSubtotals,
    topSpacerHeight: spacerHeight('[data-test="grid-top-spacer"]'),
    bottomSpacerHeight: spacerHeight('[data-test="grid-bottom-spacer"]'),
    scrollTop: wrap?.scrollTop ?? 0,
    scrollHeight: wrap?.scrollHeight ?? 0,
    clientHeight: wrap?.clientHeight ?? 0,
    firstRowNumber: rowNumbers[0] ?? null,
    lastRowNumber: rowNumbers[rowNumbers.length - 1] ?? null,
  }
}

const rows = makeRows(ROW_COUNT, GROUP_COUNT)
const mountStart = performance.now()

createApp({
  setup() {
    return () => h('div', { style: 'height:640px;border:1px solid #d8dee4;display:flex;min-height:0' }, [
      h(MetaGridTable, {
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
        groupField: GROUP_FIELD,
      }),
    ])
  },
}).mount('#app')

async function run() {
  await flushRender()
  const mountMs = performance.now() - mountStart
  const initial = snapshot()
  const wrap = document.querySelector<HTMLElement>('.meta-grid__table-wrap')
  const scrollStart = performance.now()
  if (wrap) {
    wrap.scrollTop = Math.max(0, Math.floor(wrap.scrollHeight * 0.5))
    wrap.dispatchEvent(new Event('scroll'))
  }
  await flushRender()
  const scrollFrameMs = performance.now() - scrollStart
  window.__GW_METRICS__ = {
    ready: true,
    rows: ROW_COUNT,
    groups: GROUP_COUNT,
    expectedFullDataRows: ROW_COUNT,
    expectedFullGroupHeaders: GROUP_COUNT,
    mountMs,
    scrollFrameMs,
    initial,
    afterScroll: snapshot(),
  }
  window.dispatchEvent(new Event('gw-metrics-ready'))
}

void run()
