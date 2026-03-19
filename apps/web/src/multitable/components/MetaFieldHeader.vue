<template>
  <th
    class="meta-field-header"
    :class="{ 'meta-field-header--sortable': sortable, 'meta-field-header--drag-over': isDragOver }"
    :style="headerStyle"
    draggable="true"
    @click="sortable && emit('toggle-sort')"
    @dragstart="onDragStart"
    @dragover.prevent="onDragOver"
    @dragleave="isDragOver = false"
    @drop.prevent="onDrop"
  >
    <span class="meta-field-header__icon">{{ fieldTypeIcon }}</span>
    <span class="meta-field-header__name" :title="field.name">{{ field.name }}</span>
    <span v-if="sortDirection" class="meta-field-header__sort">
      {{ sortDirection === 'asc' ? '\u25B2' : '\u25BC' }}
    </span>
    <div
      class="meta-field-header__resize"
      @mousedown.stop.prevent="onResizeStart"
    />
  </th>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MetaField } from '../types'

const FIELD_ICONS: Record<string, string> = {
  string: 'Aa', number: '#', boolean: '\u2611', date: '\u{1F4C5}', select: '\u25CF',
  link: '\u21C4', lookup: '\u2197', rollup: '\u03A3', formula: 'fx',
}

const props = defineProps<{
  field: MetaField
  sortDirection?: 'asc' | 'desc' | null
  sortable?: boolean
  width?: number
}>()

const emit = defineEmits<{
  (e: 'toggle-sort'): void
  (e: 'resize', fieldId: string, width: number): void
  (e: 'reorder', fromFieldId: string, toFieldId: string): void
}>()

const isDragOver = ref(false)

function onDragStart(e: DragEvent) {
  e.dataTransfer?.setData('text/plain', props.field.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver() {
  isDragOver.value = true
}

function onDrop(e: DragEvent) {
  isDragOver.value = false
  const fromId = e.dataTransfer?.getData('text/plain')
  if (fromId && fromId !== props.field.id) {
    emit('reorder', fromId, props.field.id)
  }
}

const fieldTypeIcon = computed(() => FIELD_ICONS[props.field.type] ?? '?')

const headerStyle = computed(() => {
  if (!props.width) return undefined
  return { width: `${props.width}px`, minWidth: `${props.width}px`, maxWidth: `${props.width}px` }
})

function onResizeStart(e: MouseEvent) {
  const startX = e.clientX
  const startWidth = props.width ?? 160
  function onMouseMove(ev: MouseEvent) {
    const w = Math.max(60, Math.min(600, startWidth + ev.clientX - startX))
    emit('resize', props.field.id, w)
  }
  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}
</script>

<style scoped>
.meta-field-header {
  padding: 8px 12px; text-align: left; font-weight: 500; font-size: 13px;
  border-bottom: 2px solid #e5e7eb; background: #f9fafb; white-space: nowrap;
  user-select: none; position: sticky; top: 0; z-index: 1; position: relative;
}
.meta-field-header--sortable { cursor: pointer; }
.meta-field-header--sortable:hover { background: #f0f2f5; }
.meta-field-header__icon { display: inline-block; width: 22px; text-align: center; color: #999; font-size: 12px; margin-right: 4px; }
.meta-field-header__name { overflow: hidden; text-overflow: ellipsis; }
.meta-field-header__sort { margin-left: 4px; font-size: 10px; color: #409eff; }
.meta-field-header__resize { position: absolute; top: 0; right: -4px; width: 9px; height: 100%; cursor: col-resize; z-index: 2; }
.meta-field-header__resize:hover { background: #409eff; opacity: 0.5; }
.meta-field-header__resize::after { content: ''; position: absolute; top: 25%; left: 3px; width: 3px; height: 50%; border-left: 1px solid transparent; border-right: 1px solid transparent; }
.meta-field-header__resize:hover::after { border-left-color: #fff; border-right-color: #fff; }
.meta-field-header--drag-over { background: #ecf5ff; border-left: 2px solid #409eff; }
</style>
