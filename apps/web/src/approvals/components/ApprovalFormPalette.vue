<template>
  <div class="approval-form-palette" data-testid="approval-form-palette">
    <p class="approval-form-palette__title">控件</p>
    <div
      v-if="!readOnly"
      class="approval-form-palette__groups"
      role="group"
      aria-label="添加表单字段类型"
    >
      <section
        v-for="group in APPROVAL_FORM_PALETTE_GROUPS"
        :key="group.id"
        class="approval-form-palette__group"
      >
        <h3>{{ group.label }}</h3>
        <div class="approval-form-palette__grid">
          <button
            v-for="entry in group.entries"
            :key="entry.type"
            type="button"
            class="approval-form-palette__chip"
            :data-testid="`approval-form-palette-chip-${entry.type}`"
            :draggable="true"
            :aria-label="`添加${entry.label}字段`"
            @click="onChipClick(entry.type)"
            @dragstart="onChipDragStart(entry.type, $event)"
            @dragend="onChipDragEnd"
          >
            <span>{{ entry.label }}</span>
            <span class="approval-form-palette__mark" aria-hidden="true">{{ entry.mark }}</span>
          </button>
        </div>
      </section>
    </div>
    <p
      v-else
      class="approval-form-palette__readonly-note"
      data-testid="approval-form-palette-readonly"
    >
      只读模式下不可添加字段
    </p>
  </div>
</template>

<script lang="ts">
/**
 * F2 palette display data — the same AuthorableFieldType grouping/labels/marks
 * as the shipped #4917 shell (`TemplateAuthoringView.vue` fieldPaletteGroups),
 * defined here so the Designer 2.0 palette/builder pair is standalone (FB-D8:
 * separate from the extracted `ApprovalFormInlineEditor` fallback, which keeps
 * receiving the parent's copies via props). Exported so `ApprovalFormBuilder`
 * renders identical type labels on cards and insertion menus.
 */
import type { AuthorableFieldType } from '../templateAuthoring'

export interface ApprovalFormPaletteEntry {
  type: AuthorableFieldType
  label: string
  mark: string
}

export interface ApprovalFormPaletteGroup {
  id: string
  label: string
  entries: ApprovalFormPaletteEntry[]
}

export const APPROVAL_FORM_FIELD_TYPE_LABELS: Record<
  AuthorableFieldType,
  string
> = {
  text: '文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  datetime: '日期时间',
  select: '单选',
  'multi-select': '多选',
  user: '人员',
  detail: '明细',
  'record-link': '关联记录',
}

const FIELD_TYPE_MARKS: Record<AuthorableFieldType, string> = {
  text: 'A',
  textarea: 'Aa',
  number: '123',
  date: '日',
  datetime: '时',
  select: '○',
  'multi-select': '☑',
  user: '人',
  detail: '表',
  'record-link': '链',
}

export const APPROVAL_FORM_PALETTE_GROUPS: ApprovalFormPaletteGroup[] = [
  { id: 'text', label: '文本', types: ['text', 'textarea'] },
  { id: 'number', label: '数值', types: ['number'] },
  { id: 'choice', label: '选项', types: ['select', 'multi-select'] },
  { id: 'date', label: '日期', types: ['date', 'datetime'] },
  { id: 'other', label: '其他', types: ['user', 'detail', 'record-link'] },
].map(({ id, label, types }) => ({
  id,
  label,
  entries: (types as AuthorableFieldType[]).map((type) => ({
    type,
    label: APPROVAL_FORM_FIELD_TYPE_LABELS[type],
    mark: FIELD_TYPE_MARKS[type],
  })),
}))
</script>

<script setup lang="ts">
/**
 * F2 Designer 2.0 palette (delta §3.1, FB-D8) — standalone until the F4 mount
 * behind `approvalCanvasV2`. NOT the flag-OFF fallback (that stays
 * `ApprovalFormInlineEditor.vue`).
 *
 * - Click = append intent (`append-field`); the composing owner routes it to
 *   the ONE `approvalFormAuthoringAdapter` (FB-D4). This component never
 *   mutates a draft itself.
 * - Dragstart writes the typed codec payload under the application MIME only
 *   and begins the shared transient drag session; dragend, unmount (route
 *   change), and the read-only transition clear it (§3.1).
 * - Read-only mode renders no draggable chips (§3.1).
 * - Chips are native buttons: keyboard activation (Enter/Space) is complete
 *   without pointer drag (FB-D2).
 */
import { onBeforeUnmount, watch } from 'vue'
import {
  createApprovalFormDragSession,
  writeApprovalFormDragPayload,
  type ApprovalFormDragSession,
} from '../approvalFormDragPayload'
import type { AuthorableFieldType as AuthorableFieldTypeSetup } from '../templateAuthoring'

const props = withDefaults(
  defineProps<{
    readOnly?: boolean
    /** Shared transient drag session (pass the builder's; defaults local). */
    dragSession?: ApprovalFormDragSession
  }>(),
  { readOnly: false, dragSession: undefined },
)

const emit = defineEmits<{
  (e: 'append-field', type: AuthorableFieldTypeSetup): void
}>()

const session: ApprovalFormDragSession =
  props.dragSession ?? createApprovalFormDragSession()

function onChipClick(type: AuthorableFieldTypeSetup): void {
  if (props.readOnly) return
  emit('append-field', type)
}

function onChipDragStart(
  type: AuthorableFieldTypeSetup,
  event: DragEvent,
): void {
  if (props.readOnly) {
    event.preventDefault()
    return
  }
  const payload = { version: 1, kind: 'palette', fieldType: type } as const
  writeApprovalFormDragPayload(event.dataTransfer, payload)
  session.begin(payload)
}

function onChipDragEnd(): void {
  session.clear()
}

// §3.1 transient-state clearing: read-only transition + route change/unmount.
watch(
  () => props.readOnly,
  (readOnly) => {
    if (readOnly) session.clear()
  },
)
onBeforeUnmount(() => {
  session.clear()
})
</script>

<style scoped>
.approval-form-palette {
  padding: 12px 12px 16px;
  overflow: auto;
  background: var(--el-bg-color);
}
.approval-form-palette__title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
}
.approval-form-palette__groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.approval-form-palette__group h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}
.approval-form-palette__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.approval-form-palette__chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 40px;
  padding: 6px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: grab;
  text-align: left;
}
.approval-form-palette__chip:hover,
.approval-form-palette__chip:focus-visible {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}
.approval-form-palette__chip:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.approval-form-palette__mark {
  color: var(--el-text-color-placeholder);
  font-size: 11px;
}
.approval-form-palette__readonly-note {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
