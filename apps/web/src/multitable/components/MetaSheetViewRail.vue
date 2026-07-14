<!--
  UI-P2-2a extraction (design-lock multitable-ui-p2-2-left-rail-detail-designlock-20260707.md §5):
  this is the sheet/view tab logic moved verbatim out of MetaViewTabBar.vue — the sole consumer
  (MultitableWorkbench.vue) now mounts THIS component instead. Template/script/style are
  byte-identical to the pre-extraction MetaViewTabBar.vue (see that file's header for why it is
  still present) — this slice is a pure move, zero visual change, no logic edits. P2-2b (Opus-gated)
  is the follow-up slice that re-layouts this into a vertical table→view tree; it has not happened
  yet, so the markup/CSS below still describes a horizontal tab strip.
-->
<template>
  <div class="meta-tab-bar">
    <div class="meta-tab-bar__sheets">
      <button
        v-for="s in sheets"
        :key="s.id"
        class="meta-tab-bar__tab"
        :class="{ 'meta-tab-bar__tab--active': s.id === activeSheetId }"
        @click="emit('select-sheet', s.id)"
      >{{ s.name }}</button>
      <button v-if="canCreateSheet" class="meta-tab-bar__tab meta-tab-bar__tab--add" @click="onAddSheet">+</button>
    </div>
    <div v-if="views.length" class="meta-tab-bar__views">
      <span v-for="v in views" :key="v.id" class="meta-tab-bar__view-group">
        <button
          class="meta-tab-bar__view"
          :class="{ 'meta-tab-bar__view--active': v.id === activeViewId }"
          @click="emit('select-view', v.id)"
        >
          <span class="meta-tab-bar__view-icon"><el-icon><component :is="viewTypeIcon(v.type)" /></el-icon></span>
          {{ v.name }}
        </button>
        <!--
          Slice 3 personal-views toggle (design-lock multitable-personal-views-slice3-fe-toggle-design-lock-
          20260706.md §3 P1 + G-FE-4): rendered ONLY next to the ACTIVE view, and ONLY when the session
          capability `personalViewsEnabled` is on — flag-off means this button is entirely absent (no DOM, no
          click target, no request can ever originate from it). Labelled unambiguously as personal, never as
          an edit to the shared view (§1-C).
        -->
        <button
          v-if="personalViewsEnabled && v.id === activeViewId"
          type="button"
          class="meta-tab-bar__personal-toggle"
          :class="{ 'meta-tab-bar__personal-toggle--on': isPersonalMode?.(v.id) }"
          data-testid="personal-view-toggle"
          :aria-pressed="isPersonalMode?.(v.id) === true"
          :title="personalToggleLabel"
          @click="emit('toggle-personal', v.id)"
        >{{ personalToggleLabel }}</button>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Component } from 'vue'
import type { MetaSheet, MetaView } from '../types'
import { useLocale } from '../../composables/useLocale'
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
</script>

<style scoped>
.meta-tab-bar { display: flex; flex-direction: column; border-bottom: 1px solid #e5e7eb; background: #fafbfc; }
.meta-tab-bar__sheets { display: flex; padding: 4px 8px 0; gap: 2px; }
.meta-tab-bar__tab {
  padding: 6px 14px; font-size: 13px; border: none; border-radius: 4px 4px 0 0;
  background: transparent; color: #666; cursor: pointer;
}
.meta-tab-bar__tab:hover { background: #f0f0f0; }
.meta-tab-bar__tab--active { background: #fff; color: #333; font-weight: 500; box-shadow: 0 -1px 2px rgba(0,0,0,.06); }
.meta-tab-bar__tab--add { color: #409eff; font-size: 16px; padding: 4px 10px; font-weight: 600; }
.meta-tab-bar__views { display: flex; padding: 2px 8px 4px; gap: 2px; overflow-x: auto; scrollbar-width: thin; }
.meta-tab-bar__views::-webkit-scrollbar { height: 3px; }
.meta-tab-bar__views::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }
.meta-tab-bar__view-group { display: inline-flex; align-items: center; gap: 2px; }
.meta-tab-bar__view {
  display: flex; align-items: center; gap: 4px; padding: 3px 10px; font-size: 12px;
  border: none; border-radius: 3px; background: transparent; color: #888; cursor: pointer;
}
.meta-tab-bar__view:hover { background: #eee; }
.meta-tab-bar__view--active { background: #e8f0fe; color: #409eff; font-weight: 500; }
.meta-tab-bar__view-icon { display: inline-flex; align-items: center; font-size: 14px; color: currentColor; }
.meta-tab-bar__personal-toggle {
  padding: 2px 8px; font-size: 11px; border: 1px solid #d0d5dd; border-radius: 10px;
  background: #fff; color: #6b7280; cursor: pointer; white-space: nowrap;
}
.meta-tab-bar__personal-toggle:hover { background: #f5f5f5; }
.meta-tab-bar__personal-toggle--on { background: #ecfdf3; border-color: #6ce9a6; color: #067647; font-weight: 500; }
@media print { .meta-tab-bar { display: none !important; } }
</style>
