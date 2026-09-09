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
    <span v-if="headerMarkIcon" class="meta-field-header__icon" aria-hidden="true">
      <component :is="headerMarkIcon" />
    </span>
    <span class="meta-field-header__name" :title="field.name">{{ field.name }}</span>
    <span v-if="sortDirection" class="meta-field-header__sort" aria-hidden="true">
      <component :is="sortDirection === 'asc' ? SheetCaretTop : SheetCaretBottom" />
    </span>
    <button
      type="button"
      class="meta-field-header__pin"
      :class="{ 'meta-field-header__pin--on': frozen }"
      :aria-label="pinLabel"
      :title="pinLabel"
      @click.stop="emit('toggle-freeze')"
      @mousedown.stop
    ><SheetPin /></button>
    <div
      class="meta-field-header__resize"
      @mousedown.stop.prevent="onResizeStart"
    />
  </th>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MetaField } from '../types'
import { useLocale } from '../../composables/useLocale'
import { metaCoreLabel } from '../utils/meta-core-labels'
import { fieldTypeHeaderMark } from '../utils/field-type-glyph'
import {
  SheetCaretBottom,
  SheetCaretTop,
  SheetCheck,
  SheetClock,
  SheetFields,
  SheetFiles,
  SheetFilter,
  SheetLink,
  SheetPin,
  SheetUser,
  SheetViewCalendar,
} from '../ui/sheet-chrome-icons'

const props = defineProps<{
  field: MetaField
  sortDirection?: 'asc' | 'desc' | null
  sortable?: boolean
  width?: number
  frozen?: boolean
  frozenLeft?: number | null
}>()

const emit = defineEmits<{
  (e: 'toggle-sort'): void
  (e: 'resize', fieldId: string, width: number): void
  (e: 'reorder', fromFieldId: string, toFieldId: string): void
  (e: 'toggle-freeze'): void
}>()

const { isZh } = useLocale()
const pinLabel = computed(() => metaCoreLabel(props.frozen ? 'grid.unfreezeColumns' : 'grid.freezeUpToColumn', isZh.value))

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

const HEADER_MARK_ICONS = {
  fields: SheetFields,
  calendar: SheetViewCalendar,
  clock: SheetClock,
  user: SheetUser,
  files: SheetFiles,
  link: SheetLink,
  check: SheetCheck,
  filter: SheetFilter,
} as const

const headerMarkIcon = computed(() => {
  const mark = fieldTypeHeaderMark(props.field.type)
  return mark.kind === 'outline' ? HEADER_MARK_ICONS[mark.name] : null
})

const headerStyle = computed(() => {
  const style: Record<string, string> = {}
  if (props.width) {
    style.width = `${props.width}px`
    style.minWidth = `${props.width}px`
    style.maxWidth = `${props.width}px`
  }
  // Frozen headers keep CSS `position: sticky; top: 0` for vertical stickiness and add
  // horizontal `left` + a z-index above non-frozen headers (3) and frozen body cells (2).
  // `position: sticky` is a containing block, so the absolute resize handle still anchors here.
  if (props.frozenLeft != null) {
    style.position = 'sticky'
    style.left = `${props.frozenLeft}px`
    style.zIndex = '4'
    style.background = 'var(--ms-bg-card, #fff)'
  }
  return Object.keys(style).length ? style : undefined
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
  padding: 8px 16px; text-align: left; font-weight: 500; font-size: var(--ms-sheet-font-header, 12px);
  color: var(--ms-text-2, #4b5563);
  border-bottom: 1px solid var(--ms-sheet-hairline, #ebebeb); background: var(--ms-bg-card, #fff); white-space: nowrap;
  user-select: none; position: sticky; top: 0; z-index: 3;
}
.meta-field-header--sortable { cursor: pointer; }
.meta-field-header--sortable:hover { background: var(--ms-bg-page, #f5f6f8); }
.meta-field-header__icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 12px; height: 12px;
  margin-right: 6px; flex-shrink: 0;
  color: var(--ms-sheet-icon-color, #6b7280);
}
.meta-field-header__icon :deep(.ms-sheet-icon) { width: 12px; height: 12px; }
.meta-field-header__name { overflow: hidden; text-overflow: ellipsis; }
.meta-field-header__sort {
  display: inline-flex; align-items: center; margin-left: 4px;
  color: var(--ms-sheet-icon-color, #6b7280);
}
.meta-field-header__sort :deep(.ms-sheet-icon) { width: 12px; height: 12px; }
.meta-field-header__pin {
  display: inline-flex; align-items: center; justify-content: center;
  width: 12px; height: 12px; padding: 0; margin-left: 4px;
  border: none; background: none; cursor: pointer;
  color: var(--ms-sheet-icon-color, #6b7280);
  opacity: 0; transition: opacity 0.12s; vertical-align: middle;
}
.meta-field-header__pin :deep(.ms-sheet-icon) { width: 12px; height: 12px; }
.meta-field-header:hover .meta-field-header__pin { opacity: 0.4; }
.meta-field-header__pin:hover { opacity: 0.85; }
.meta-field-header__pin--on { opacity: 0.9; }
.meta-field-header__resize { position: absolute; top: 0; right: -4px; width: 9px; height: 100%; cursor: col-resize; z-index: 2; }
.meta-field-header__resize:hover { background: rgba(37, 99, 235, 0.14); }
.meta-field-header__resize::after { content: ''; position: absolute; top: 25%; left: 3px; width: 3px; height: 50%; border-left: 1px solid transparent; border-right: 1px solid transparent; }
.meta-field-header__resize:hover::after { border-left-color: rgb(32, 56, 107); border-right-color: rgb(32, 56, 107); }
.meta-field-header--drag-over { background: rgba(37, 99, 235, 0.14); border-left: 2px solid rgba(37, 99, 235, 0.45); }
</style>
