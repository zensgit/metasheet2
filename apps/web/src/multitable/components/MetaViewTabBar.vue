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
      <button
        v-for="v in views"
        :key="v.id"
        class="meta-tab-bar__view"
        :class="{ 'meta-tab-bar__view--active': v.id === activeViewId }"
        @click="emit('select-view', v.id)"
      >
        <span class="meta-tab-bar__view-icon">{{ viewTypeIcon(v.type) }}</span>
        {{ v.name }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MetaSheet, MetaView } from '../types'

const props = defineProps<{
  sheets: MetaSheet[]
  views: MetaView[]
  activeSheetId: string
  activeViewId: string
  canCreateSheet?: boolean
}>()

const emit = defineEmits<{
  (e: 'select-sheet', id: string): void
  (e: 'select-view', id: string): void
  (e: 'create-sheet', name: string): void
}>()

function onAddSheet() {
  const name = `Sheet ${props.sheets.length + 1}`
  emit('create-sheet', name)
}

function viewTypeIcon(type: string): string {
  const map: Record<string, string> = { grid: '\u2637', form: '\u2263', kanban: '\u2630', gallery: '\u25A6', calendar: '\u2339' }
  return map[type] ?? '\u2637'
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
.meta-tab-bar__views { display: flex; padding: 2px 8px 4px; gap: 2px; }
.meta-tab-bar__view {
  display: flex; align-items: center; gap: 4px; padding: 3px 10px; font-size: 12px;
  border: none; border-radius: 3px; background: transparent; color: #888; cursor: pointer;
}
.meta-tab-bar__view:hover { background: #eee; }
.meta-tab-bar__view--active { background: #e8f0fe; color: #409eff; font-weight: 500; }
.meta-tab-bar__view-icon { font-size: 14px; }
@media print { .meta-tab-bar { display: none !important; } }
</style>
