// Browser-verification harness (dev/CI only — NOT part of the app build/typecheck; lives outside src/
// so vue-tsc + vite build ignore it). Real UF token load (../src/styles/tokens.css — the exact statement
// apps/web/src/main.ts uses) + the copied CSS in rail-drawer-harness.html's <style> block let a real
// browser resolve the UI-P2-2c drawer rule's computed values (position/z-index/width/background-color/
// box-shadow) — see design docs/development/multitable-ui-p2-2c-responsive-design-20260714.md §7.
// This harness intentionally does NOT reproduce MultitableWorkbench.vue's viewport/resize STATE machine
// (that's already proven in jsdom, see the 'UI-P2-2c' describe in
// apps/web/tests/multitable-workbench-view.spec.ts) — the three buttons below just apply the class
// combinations directly so the spec can assert each state's resolved CSS in isolation.
//
// `?grid=1` (review of the grid select-all z-index fix, 2026-10-21): main holds the REAL MetaGridTable
// (multi-select on, so its sticky header corner sits under the drawer's top-left), and the drawer holds two
// real controls at its top — a base-picker trigger stand-in and the rail toggle — so the spec can hit-test
// and click them. The drawer's z-index (5) lives in the content stacking context; the grid's own sticky
// tiers must stay local to the grid (`.meta-grid` isolates) so the drawer paints over the whole grid.
import { createApp, h, ref } from 'vue'
import '../src/styles/tokens.css'
import MetaGridTable from '../src/multitable/components/MetaGridTable.vue'
import type { MetaField, MetaRecord } from '../src/multitable/types'

declare global {
  interface Window {
    __RAIL_DRAWER__?: { baseMenuOpen: boolean; toggleClicks: number; selectedRows: number }
  }
}

const withGrid = new URLSearchParams(window.location.search).get('grid') === '1'
const GRID_FIELDS: MetaField[] = Array.from({ length: 8 }, (_, i): MetaField => ({ id: `g${i}`, name: `Column ${i + 1}`, type: 'string' }))
const GRID_ROWS: MetaRecord[] = Array.from({ length: 6 }, (_, r): MetaRecord => ({
  id: `gr${r}`,
  version: 1,
  data: Object.fromEntries(GRID_FIELDS.map((f, c) => [f.id, `r${r + 1} c${c + 1}`])),
}))
const probe = { baseMenuOpen: false, toggleClicks: 0, selectedRows: 0 }
window.__RAIL_DRAWER__ = probe

type Mode = 'default' | 'collapsed' | 'drawer'

createApp({
  setup() {
    const mode = ref<Mode>('default')
    const railClass = () => ({
      'mt-workbench__rail': true,
      'mt-workbench__rail--collapsed': mode.value === 'collapsed',
      'mt-workbench__rail--drawer': mode.value === 'drawer',
    })
    const baseMenuOpen = ref(false)
    const railChildren = () => withGrid
      ? [
          h('div', { style: 'display:flex;gap:4px;padding:4px' }, [
            h('button', {
              'data-test': 'rail-base-trigger',
              style: 'width:120px;height:32px',
              onClick: () => { baseMenuOpen.value = !baseMenuOpen.value; probe.baseMenuOpen = baseMenuOpen.value },
            }, 'base picker'),
            h('button', {
              'data-test': 'rail-toggle',
              style: 'width:32px;height:32px',
              onClick: () => { probe.toggleClicks += 1 },
            }, '<'),
          ]),
          baseMenuOpen.value ? h('div', { 'data-test': 'rail-base-menu' }, 'base menu') : null,
        ]
      : 'rail content'
    const mainChildren = () => withGrid
      ? [h(MetaGridTable, {
          rows: GRID_ROWS,
          visibleFields: GRID_FIELDS,
          sortRules: [],
          loading: false,
          currentPage: 1,
          totalPages: 1,
          startIndex: 0,
          canEdit: true,
          canDelete: true,
          searchText: '',
          rowDensity: 'normal',
          enableMultiSelect: true,
          frozenLeftColumnIds: ['g0'],
          columnWidths: Object.fromEntries(GRID_FIELDS.map((f) => [f.id, 160])),
          onSelectionChange: (ids: string[]) => { probe.selectedRows = ids.length },
        })]
      : 'main content'
    return () => h('div', [
      h('div', { style: 'margin-bottom:12px;display:flex;gap:8px' }, [
        h('button', { 'data-test': 'mode-default', onClick: () => { mode.value = 'default' } }, 'default'),
        h('button', { 'data-test': 'mode-collapsed', onClick: () => { mode.value = 'collapsed' } }, 'collapsed'),
        h('button', { 'data-test': 'mode-drawer', onClick: () => { mode.value = 'drawer' } }, 'drawer'),
      ]),
      h('div', { 'data-test': 'current-mode', style: 'margin-bottom:12px;color:#333' }, `mode: ${mode.value}`),
      h('div', { class: 'mt-workbench__content', 'data-test': 'content' }, [
        h('aside', { class: railClass(), 'data-test': 'rail' }, railChildren()),
        h('div', { class: 'mt-workbench__main', 'data-test': 'main' }, mainChildren()),
      ]),
    ])
  },
}).mount('#app')
