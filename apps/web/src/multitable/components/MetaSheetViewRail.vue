<!--
  UI-P2-2b (design docs/development/multitable-ui-p2-2b-vertical-tree-design-20260713.md, per RATIFIED
  parent lock multitable-ui-p2-2-left-rail-detail-designlock-20260707.md §4.6/§5): re-layout of the
  P2-2a extraction from a horizontal tab strip into a persistent, collapsible vertical
  sheet->view TREE (the workspace/Base layer lives one level up, in MultitableWorkbench.vue's new
  `<aside>` rail-head — it does NOT enter this component's role="tree", per the design's explicit
  "avoid P2-1b-style role-not-matching-behavior" guardrail).

  The 7 props / 4 emits (select-sheet / select-view / create-sheet / toggle-personal) and their
  gating stay BEHAVIOR-equivalent to the pre-2b horizontal strip — only the DOM shape, CSS, and
  keyboard/ARIA surface changed. `defineProps` / `defineEmits` / `onAddSheet` / the
  VIEW_TYPE_ICON map + viewTypeIcon() are unchanged verbatim from the P2-2a version.

  The byte-identical-DOM baseline this slice retires (MetaViewTabBar.vue — see design MD §7/§8.1):
  its safety net (mount both, diff outerHTML) doesn't survive a real visual relayout, so the frozen
  file + its DOM-equivalence describe block + its own dedicated personal-toggle spec are removed.
  The replacement safety net is: behavior-equivalence (4 emits / gating / count conservation, in
  tests/meta-sheet-view-rail.spec.ts) + native-keyboard/ARIA tests (same file) + a zero-hardcoded-hex
  token gate (same file) — see the design MD §1-§6 for the full tree/emit/keyboard/token mapping this
  file implements.
-->
<template>
  <nav ref="rootEl" class="meta-view-rail">
    <ul role="tree" :aria-label="railLabel('rail.treeLabel', isZh)" class="meta-view-rail__tree">
      <li v-for="s in sheets" :key="s.id" role="none">
        <button
          role="treeitem"
          type="button"
          data-testid="rail-sheet-node"
          :data-node-key="sheetKey(s.id)"
          :aria-selected="s.id === activeSheetId"
          :aria-expanded="sheetAriaExpanded(s)"
          :tabindex="rovingTabindex(sheetKey(s.id))"
          class="meta-view-rail__sheet"
          :class="{ '--active': s.id === activeSheetId }"
          :title="s.name"
          @click="onSheetActivate(s)"
          @keydown="onTreeKeydown($event, { key: sheetKey(s.id), type: 'sheet', id: s.id })"
        >
          <span class="meta-view-rail__chevron" aria-hidden="true">
            <el-icon><component :is="s.id === activeSheetId ? IconCaretBottom : IconCaretRight" /></el-icon>
          </span>
          <span class="meta-view-rail__sheet-name">{{ s.name }}</span>
        </button>
        <ul v-if="s.id === activeSheetId && views.length" role="group" class="meta-view-rail__views">
          <li v-for="v in views" :key="v.id" class="meta-view-rail__view-row">
            <button
              role="treeitem"
              type="button"
              data-testid="rail-view-node"
              :data-node-key="viewKey(v.id)"
              :aria-selected="v.id === activeViewId"
              :tabindex="rovingTabindex(viewKey(v.id))"
              class="meta-view-rail__view"
              :class="{ '--active': v.id === activeViewId }"
              :title="v.name"
              @click="onViewActivate(v)"
              @keydown="onTreeKeydown($event, { key: viewKey(v.id), type: 'view', id: v.id })"
            >
              <span class="meta-view-rail__view-icon"><el-icon><component :is="viewTypeIcon(v.type)" /></el-icon></span>
              <span class="meta-view-rail__view-name">{{ v.name }}</span>
            </button>
            <!--
              Slice 3 personal-views toggle (design-lock multitable-personal-views-slice3-fe-toggle-design-lock-
              20260706.md §3 P1 + G-FE-4): rendered ONLY next to the ACTIVE view, and ONLY when the session
              capability `personalViewsEnabled` is on — flag-off means this button is entirely absent (no DOM, no
              click target, no request can ever originate from it). Labelled unambiguously as personal, never as
              an edit to the shared view (§1-C). Label string kept inline verbatim (design MD §5.4: minimal diff).
            -->
            <button
              v-if="personalViewsEnabled && v.id === activeViewId"
              type="button"
              class="meta-view-rail__personal-toggle"
              :class="{ '--on': isPersonalMode?.(v.id) }"
              data-testid="personal-view-toggle"
              :aria-pressed="isPersonalMode?.(v.id) === true"
              :title="personalToggleLabel"
              @click="emit('toggle-personal', v.id)"
            >{{ personalToggleLabel }}</button>
          </li>
        </ul>
      </li>
    </ul>
    <button v-if="canCreateSheet" type="button" data-testid="rail-add-sheet" class="meta-view-rail__add" @click="onAddSheet">
      ＋ {{ railLabel('rail.addSheet', isZh) }}
    </button>
  </nav>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Component } from 'vue'
import type { MetaSheet, MetaView } from '../types'
import { useLocale } from '../../composables/useLocale'
import { railLabel } from '../utils/meta-sheet-view-rail-labels'
import { ElIcon } from 'element-plus'
import {
  Grid as IconGrid,
  Tickets as IconForm,
  Postcard as IconKanban,
  Picture as IconGallery,
  Calendar as IconCalendar,
  DataLine as IconTimeline,
  Histogram as IconGantt,
  Share as IconHierarchy,
  CaretRight as IconCaretRight,
  CaretBottom as IconCaretBottom,
} from '@element-plus/icons-vue'

const props = defineProps<{
  sheets: MetaSheet[]
  views: MetaView[]
  activeSheetId: string
  activeViewId: string
  canCreateSheet?: boolean
  // Slice 3: flag-derived session capability (MetaCapabilities.personalViewsEnabled) — absent/false hides
  // the toggle entirely (G-FE-4). NOT a client-side env const.
  personalViewsEnabled?: boolean
  isPersonalMode?: (viewId: string) => boolean
}>()

const emit = defineEmits<{
  (e: 'select-sheet', id: string): void
  (e: 'select-view', id: string): void
  (e: 'create-sheet', name: string): void
  (e: 'toggle-personal', viewId: string): void
}>()

const { isZh } = useLocale()
const personalToggleLabel = computed(() => (isZh.value ? '个人视图' : 'My view'))

function onAddSheet() {
  const name = `Sheet ${props.sheets.length + 1}`
  emit('create-sheet', name)
}

// View-type icon map (UI-P1b): monochrome Element Plus SVGs replacing the former Unicode-glyph map
// (grid \u2637, form \u2263, kanban \u2630, gallery \u25A6, calendar \u2339, timeline \u2500, gantt \u25AC, hierarchy \u251C).
const VIEW_TYPE_ICON: Record<string, Component> = {
  grid: IconGrid,
  form: IconForm,
  kanban: IconKanban,
  gallery: IconGallery,
  calendar: IconCalendar,
  timeline: IconTimeline,
  gantt: IconGantt,
  hierarchy: IconHierarchy,
}
function viewTypeIcon(type: string): Component {
  return VIEW_TYPE_ICON[type] ?? IconGrid
}

// --- UI-P2-2b: tree structure, roving tabindex, keyboard nav --------------------------------
// (design docs/development/multitable-ui-p2-2b-vertical-tree-design-20260713.md §1.3/§3.2/§5)

function sheetKey(id: string): string {
  return `sheet:${id}`
}
function viewKey(id: string): string {
  return `view:${id}`
}

interface FlatNode {
  key: string
  type: 'sheet' | 'view'
  id: string
}

// Flattened, DOM-order list of every focusable tree node: each sheet, and — immediately after the
// ACTIVE sheet only — its view leaves. `views` only ever holds the active sheet's views (§1.3 data
// invariant, enforced by the consumer), so this iteration order already matches the design's key map
// order: "sheet1, ..., activeSheet, its view1..M, ..., sheetN".
const flatNodes = computed<FlatNode[]>(() => {
  const nodes: FlatNode[] = []
  for (const s of props.sheets) {
    nodes.push({ key: sheetKey(s.id), type: 'sheet', id: s.id })
    if (s.id === props.activeSheetId) {
      for (const v of props.views) {
        nodes.push({ key: viewKey(v.id), type: 'view', id: v.id })
      }
    }
  }
  return nodes
})

// Roving-tabindex default position: the active view leaf, else the active sheet node, else the
// first node in the flattened list (design §5.3).
const defaultFocusKey = computed<string>(() => {
  const nodes = flatNodes.value
  const activeView = viewKey(props.activeViewId)
  if (nodes.some((n) => n.key === activeView)) return activeView
  const activeSheet = sheetKey(props.activeSheetId)
  if (nodes.some((n) => n.key === activeSheet)) return activeSheet
  return nodes[0]?.key ?? ''
})

const focusedKey = ref<string>('')
const rootEl = ref<HTMLElement | null>(null)

// Clamp ONLY when the current roving position no longer exists in the flattened list (sheets/views
// shrank, or the active ids stopped resolving to a rendered node) — this deliberately does NOT
// re-snap to the newly-active node on every prop change, so a keyboard-navigated (but not yet
// activated) position survives unrelated prop churn. A click, however, explicitly repositions the
// roving key to the clicked node (see onSheetActivate/onViewActivate below) — that mirrors real
// browser focus-follows-click and keeps "exactly one tabindex=0" honest after a mouse interaction.
watch(
  flatNodes,
  () => {
    if (!flatNodes.value.some((n) => n.key === focusedKey.value)) {
      focusedKey.value = defaultFocusKey.value
    }
  },
  { immediate: true },
)

function rovingTabindex(key: string): number {
  return key === focusedKey.value ? 0 : -1
}

function sheetAriaExpanded(s: MetaSheet): 'true' | 'false' | undefined {
  // "true" only when the sheet is active AND has renderable children — an active sheet with zero
  // views must not claim to be expanded (nothing is actually shown). Non-active sheets are "false"
  // (collapsed, but expandable via activation). See design §5.3.
  if (s.id !== props.activeSheetId) return 'false'
  return props.views.length > 0 ? 'true' : undefined
}

async function moveFocusTo(key: string) {
  if (!flatNodes.value.some((n) => n.key === key)) return
  focusedKey.value = key
  await nextTick()
  const el = rootEl.value?.querySelector<HTMLElement>(`[data-node-key="${key}"]`)
  el?.focus()
}

function onSheetActivate(s: MetaSheet) {
  focusedKey.value = sheetKey(s.id)
  emit('select-sheet', s.id)
}

function onViewActivate(v: MetaView) {
  focusedKey.value = viewKey(v.id)
  emit('select-view', v.id)
}

// Arrow/Home/End move focus ONLY — they never emit (deliberate ARIA deviation from the APG default
// tree pattern: here, "expand" IS "activate" IS side-effecting — see design §1.3/§3.2/§5.2 for why
// free multi-expand is out of scope). Enter/Space activation is native <button> semantics (the click
// handlers above already cover it — no separate keydown-driven emit here, so a real browser's default
// keyboard-activates-button behavior cannot double-fire this component's emit).
function onTreeKeydown(event: KeyboardEvent, node: FlatNode) {
  const nodes = flatNodes.value
  const idx = nodes.findIndex((n) => n.key === node.key)
  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault()
      if (idx >= 0 && idx + 1 < nodes.length) void moveFocusTo(nodes[idx + 1].key)
      break
    }
    case 'ArrowUp': {
      event.preventDefault()
      if (idx > 0) void moveFocusTo(nodes[idx - 1].key)
      break
    }
    case 'ArrowRight': {
      event.preventDefault()
      // Only the ACTIVE (already-expanded) sheet has a first view leaf to move into; a non-active
      // sheet is a no-op (expanding it would require activating it, which arrow keys never do).
      if (node.type === 'sheet' && node.id === props.activeSheetId) {
        const firstView = nodes.find((n) => n.type === 'view')
        if (firstView) void moveFocusTo(firstView.key)
      }
      break
    }
    case 'ArrowLeft': {
      event.preventDefault()
      // A view leaf's parent is always the active sheet (§1.3); a sheet node is a no-op (collapse is
      // a derived state, not something arrow keys can "undo").
      if (node.type === 'view') void moveFocusTo(sheetKey(props.activeSheetId))
      break
    }
    case 'Home': {
      event.preventDefault()
      if (nodes[0]) void moveFocusTo(nodes[0].key)
      break
    }
    case 'End': {
      event.preventDefault()
      if (nodes[nodes.length - 1]) void moveFocusTo(nodes[nodes.length - 1].key)
      break
    }
    default:
      break
  }
}
</script>

<style scoped>
/* UI-P2-2b token map (design MD §6): every color below is a UF/EP CSS variable already defined in
   apps/web/src/styles/tokens.css — zero hardcoded hex (enforced by this spec's own token gate, T6). */
.meta-view-rail {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  background: var(--ms-bg-page);
}
.meta-view-rail__tree {
  flex: 1;
  list-style: none;
  margin: 0;
  padding: var(--ms-space-2) 0;
}
.meta-view-rail__sheet {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  width: 100%;
  min-height: var(--ms-control-height);
  padding: 0 var(--ms-space-3);
  border: none;
  border-radius: var(--ms-radius-sm);
  background: transparent;
  color: var(--ms-text-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.meta-view-rail__sheet:hover { background: var(--ms-bg-card); }
.meta-view-rail__sheet.--active { background: var(--el-color-primary-light-9); color: var(--ms-color-primary); font-weight: 500; }
.meta-view-rail__sheet.--active:hover { background: var(--el-color-primary-light-8); }
.meta-view-rail__chevron { display: inline-flex; align-items: center; width: 14px; flex-shrink: 0; font-size: 12px; color: var(--ms-text-3); }
.meta-view-rail__sheet-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-view-rail__views { list-style: none; margin: 0; padding: 0; }
.meta-view-rail__view-row { display: flex; align-items: center; gap: var(--ms-space-1); padding-right: var(--ms-space-2); }
.meta-view-rail__view {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  flex: 1;
  min-width: 0;
  min-height: var(--ms-control-height);
  padding: 0 var(--ms-space-3) 0 var(--ms-space-5);
  border: none;
  border-radius: var(--ms-radius-sm);
  background: transparent;
  color: var(--ms-text-3);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.meta-view-rail__view:hover { background: var(--ms-bg-card); }
.meta-view-rail__view.--active { background: var(--el-color-primary-light-9); color: var(--ms-color-primary); font-weight: 500; }
.meta-view-rail__view.--active:hover { background: var(--el-color-primary-light-8); }
.meta-view-rail__view-icon { display: inline-flex; align-items: center; font-size: 14px; color: currentColor; flex-shrink: 0; }
.meta-view-rail__view-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-view-rail__personal-toggle {
  flex-shrink: 0;
  padding: 2px var(--ms-space-2);
  border: 1px solid var(--ms-border);
  border-radius: 10px;
  background: var(--ms-bg-card);
  color: var(--ms-color-info);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.meta-view-rail__personal-toggle:hover { background: var(--ms-bg-page); }
.meta-view-rail__personal-toggle.--on {
  background: var(--el-color-success-light-9);
  border-color: var(--el-color-success-light-5);
  color: var(--el-color-success-dark-2);
  font-weight: 500;
}
.meta-view-rail__add {
  display: flex;
  align-items: center;
  gap: var(--ms-space-1);
  width: 100%;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: none;
  border-top: 1px solid var(--ms-border-light);
  background: transparent;
  color: var(--ms-color-primary);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.meta-view-rail__add:hover { background: var(--ms-bg-card); }
.meta-view-rail__sheet:focus-visible,
.meta-view-rail__view:focus-visible,
.meta-view-rail__add:focus-visible,
.meta-view-rail__personal-toggle:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: -2px;
}
@media print { .meta-view-rail { display: none !important; } }
</style>
