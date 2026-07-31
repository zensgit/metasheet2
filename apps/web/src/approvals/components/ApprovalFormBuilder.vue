<template>
  <el-card
    class="approval-form-builder"
    :class="{ 'approval-form-builder--workspace': workspaceEnabled }"
    shadow="never"
    data-testid="approval-form-builder"
  >
    <template #header>
      <div class="approval-form-builder__header">
        <div>
          <strong>表单字段</strong>
          <small v-if="workspaceEnabled">拖入组件，选中字段后在右侧配置</small>
        </div>
        <el-button
          v-if="!workspaceEnabled"
          size="small"
          :disabled="readOnly || !structuralMutationEnabled"
          data-testid="approval-template-add-field"
          @click="requestAddField('text', fields.length)"
        >
          <el-icon><Plus /></el-icon>
          添加字段
        </el-button>
      </div>
    </template>

    <div v-if="workspaceEnabled" class="approval-form-builder__workspace">
      <ApprovalFormPalette
        :read-only="readOnly || !structuralMutationEnabled"
        :attachment-authoring-enabled="attachmentAuthoringEnabled"
        @add="appendFieldOfType"
      />

      <main
        class="approval-form-builder__canvas"
        aria-labelledby="approval-form-canvas-heading"
        data-testid="approval-form-field-list"
      >
        <div class="approval-form-builder__canvas-heading">
          <div>
            <strong id="approval-form-canvas-heading">表单画布</strong>
            <small>{{ fields.length }} 个字段</small>
          </div>
        </div>

        <template v-for="(item, index) in fields" :key="item.localId">
          <button
            type="button"
            class="approval-form-builder__drop-slot"
            :class="{
              'is-active': activeFieldDropIndex === index,
              'is-selected': selectedFieldInsertionIndex === index,
            }"
            :disabled="readOnly"
            :aria-pressed="selectedFieldInsertionIndex === index"
            :aria-label="`选择在字段 ${index + 1} 前插入组件`"
            :data-testid="`approval-form-drop-slot-${index}`"
            @click="selectFieldInsertionSlot(index)"
            @dragenter.prevent="activateFieldDropSlot(index)"
            @dragover.prevent="activateFieldDropSlot(index)"
            @dragleave="deactivateFieldDropSlot(index)"
            @drop.prevent="onFieldInsertionDrop($event, index)"
          >
            <span aria-hidden="true">+</span>
          </button>

          <article
            class="approval-form-builder__field-card"
            :class="{ 'is-selected': selectedFieldLocalId === item.localId }"
            data-testid="approval-template-field-row"
            :data-field-local-id="item.localId"
            :aria-current="selectedFieldLocalId === item.localId ? 'true' : undefined"
            @click="selectField(item.localId)"
          >
            <div class="approval-form-builder__field-summary">
              <button
                type="button"
                class="approval-form-builder__drag-handle"
                :disabled="readOnly"
                :aria-label="`移动字段 ${index + 1}`"
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                title="拖动排序；也可按 Alt + 方向键"
                data-testid="approval-form-field-drag-handle"
                :draggable="!readOnly"
                @click.stop
                @dragstart.stop="onFieldDragStart($event, index)"
                @dragend.stop="resetFieldDragState"
                @keydown="onFieldKeyboardReorder($event, index)"
              >
                <el-icon><Rank /></el-icon>
              </button>
              <button
                type="button"
                class="approval-form-builder__field-select"
                :aria-label="`选择${item.label.trim() || `字段 ${index + 1}`}，${APPROVAL_FORM_FIELD_TYPE_LABELS[item.type]}`"
                :aria-pressed="selectedFieldLocalId === item.localId"
                data-testid="approval-form-field-select"
                @click.stop="selectField(item.localId)"
              >
                <span class="approval-form-builder__field-copy">
                  <strong>{{ item.label.trim() || `字段 ${index + 1}` }}</strong>
                  <span>{{ APPROVAL_FORM_FIELD_TYPE_LABELS[item.type] }}</span>
                </span>
                <span v-if="item.required" class="approval-form-builder__required">必填</span>
              </button>
            </div>
            <div class="approval-form-builder__field-actions">
              <el-button
                text
                size="small"
                :disabled="readOnly || index === 0"
                aria-label="上移字段"
                @click.stop="moveField(index, -1)"
              >
                <el-icon><ArrowUp /></el-icon>
              </el-button>
              <el-button
                text
                size="small"
                :disabled="readOnly || index === fields.length - 1"
                aria-label="下移字段"
                @click.stop="moveField(index, 1)"
              >
                <el-icon><ArrowDown /></el-icon>
              </el-button>
              <el-button
                text
                size="small"
                type="danger"
                :disabled="readOnly || !structuralMutationEnabled || fields.length === 1"
                aria-label="删除字段"
                data-testid="approval-template-remove-field"
                @click.stop="removeField(index)"
              >
                <el-icon><Delete /></el-icon>
              </el-button>
            </div>
          </article>
        </template>

        <button
          type="button"
          class="approval-form-builder__drop-slot"
          :class="{
            'is-active': activeFieldDropIndex === fields.length,
            'is-selected': selectedFieldInsertionIndex === fields.length,
          }"
          :disabled="readOnly"
          :aria-pressed="selectedFieldInsertionIndex === fields.length"
          aria-label="选择在表单末尾插入组件"
          :data-testid="`approval-form-drop-slot-${fields.length}`"
          @click="selectFieldInsertionSlot(fields.length)"
          @dragenter.prevent="activateFieldDropSlot(fields.length)"
          @dragover.prevent="activateFieldDropSlot(fields.length)"
          @dragleave="deactivateFieldDropSlot(fields.length)"
          @drop.prevent="onFieldInsertionDrop($event, fields.length)"
        >
          <span aria-hidden="true">+</span>
        </button>

        <p
          class="approval-form-builder__status"
          role="status"
          aria-live="polite"
          data-testid="approval-form-builder-status"
        >
          {{ formBuilderAnnouncement }}
        </p>
        <p
          v-if="!structuralMutationEnabled && structuralMutationReason"
          class="approval-form-builder__status"
          role="status"
          data-testid="approval-form-structure-disabled"
        >
          {{ structuralMutationReason }}
        </p>
      </main>

      <aside class="approval-form-builder__inspector-shell">
        <ApprovalFieldInspector
          v-if="selectedField"
          :field="selectedField"
          :fields="fields"
          :read-only="readOnly"
          :record-link-bases="recordLinkBases"
          :record-link-sheets="recordLinkSheets"
          :record-link-catalog-loading="recordLinkCatalogLoading"
          :record-link-catalog-loaded="recordLinkCatalogLoaded"
          :record-link-catalog-error="recordLinkCatalogError"
          :attachment-authoring-enabled="attachmentAuthoringEnabled"
          @retry-record-link-catalog="emit('retry-record-link-catalog')"
          @update:field="emit('update-field', $event)"
        />
      </aside>
    </div>

    <div v-else class="approval-form-builder__legacy-list">
      <div
        v-for="(item, index) in fields"
        :key="item.localId"
        class="approval-form-builder__legacy-item"
        data-testid="approval-template-field-row"
        :draggable="!readOnly"
        @dragstart="onFieldDragStart($event, index)"
        @dragover.prevent
        @drop.prevent="onLegacyFieldDrop(index)"
        @dragend="resetFieldDragState"
      >
        <div class="approval-form-builder__legacy-toolbar">
          <strong>字段 {{ index + 1 }}</strong>
          <div>
            <el-button size="small" :disabled="readOnly || index === 0" @click="moveField(index, -1)">上移</el-button>
            <el-button size="small" :disabled="readOnly || index === fields.length - 1" @click="moveField(index, 1)">下移</el-button>
            <el-button
              size="small"
              type="danger"
              :disabled="readOnly || !structuralMutationEnabled || fields.length === 1"
              data-testid="approval-template-remove-field"
              @click="removeField(index)"
            >
              删除
            </el-button>
          </div>
        </div>
        <ApprovalFieldInspector
          :field="fields[index]!"
          :fields="fields"
          :read-only="readOnly"
          :show-heading="false"
          :record-link-bases="recordLinkBases"
          :record-link-sheets="recordLinkSheets"
          :record-link-catalog-loading="recordLinkCatalogLoading"
          :record-link-catalog-loaded="recordLinkCatalogLoaded"
          :record-link-catalog-error="recordLinkCatalogError"
          :attachment-authoring-enabled="attachmentAuthoringEnabled"
          @retry-record-link-catalog="emit('retry-record-link-catalog')"
          @update:field="emit('update-field', $event)"
        />
      </div>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Delete, Plus, Rank } from '@element-plus/icons-vue'
import ApprovalFieldInspector from './ApprovalFieldInspector.vue'
import ApprovalFormPalette from './ApprovalFormPalette.vue'
import type { FieldAuthoringDraft, FormAuthoringFieldType } from '../templateAuthoring'
import {
  APPROVAL_FORM_FIELD_MOVE_MIME,
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  readMovedFieldIndex,
  readPaletteFieldType,
} from '../formPalette'
import type { RecordLinkNamedOption } from '../recordLinkField'

const props = defineProps<{
  fields: FieldAuthoringDraft[]
  workspaceEnabled: boolean
  readOnly: boolean
  recordLinkBases: RecordLinkNamedOption[]
  recordLinkSheets: Array<RecordLinkNamedOption & { baseId?: string | null }>
  recordLinkCatalogLoading: boolean
  recordLinkCatalogLoaded: boolean
  recordLinkCatalogError: string
  structuralMutationEnabled: boolean
  structuralMutationReason: string
  attachmentAuthoringEnabled: boolean
}>()

const fields = computed(() => props.fields)

const emit = defineEmits<{
  'retry-record-link-catalog': []
  'update-field': [field: FieldAuthoringDraft]
  'add-field': [request: { type: FormAuthoringFieldType; insertionIndex: number }]
  'remove-field': [request: { localId: string }]
  'move-field': [request: { localId: string; targetIndex: number }]
}>()

const selectedFieldLocalId = ref(fields.value[0]?.localId ?? '')
const formBuilderAnnouncement = ref('')
const activeFieldDropIndex = ref<number | null>(null)
const selectedFieldInsertionIndex = ref<number | null>(null)
const draggedFieldIndex = ref<number | null>(null)

const selectedField = computed(
  () => fields.value.find((item) => item.localId === selectedFieldLocalId.value) ?? fields.value[0],
)

watch(
  () => fields.value.map((item) => item.localId),
  (ids) => {
    if (ids.includes(selectedFieldLocalId.value)) return
    selectedFieldLocalId.value = ids[0] ?? ''
  },
  { immediate: true },
)

function selectField(localId: string): void {
  selectedFieldLocalId.value = localId
}

function requestAddField(type: FormAuthoringFieldType, index: number): void {
  if (props.readOnly || !props.structuralMutationEnabled) return
  if (type === 'attachment' && !props.attachmentAuthoringEnabled) return
  const insertionIndex = Math.max(0, Math.min(index, fields.value.length))
  emit('add-field', { type, insertionIndex })
  selectedFieldInsertionIndex.value = null
}

function appendFieldOfType(type: FormAuthoringFieldType): void {
  requestAddField(type, selectedFieldInsertionIndex.value ?? fields.value.length)
}

function removeField(index: number): void {
  if (props.readOnly || !props.structuralMutationEnabled || fields.value.length === 1) return
  const localId = fields.value[index]?.localId
  if (localId) emit('remove-field', { localId })
}

function moveField(index: number, delta: -1 | 1): void {
  const target = index + delta
  if (props.readOnly || target < 0 || target >= fields.value.length) return
  const localId = fields.value[index]?.localId
  if (localId) emit('move-field', { localId, targetIndex: target })
}

function onFieldDragStart(event: DragEvent, index: number): void {
  if (props.readOnly) return
  draggedFieldIndex.value = index
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(APPROVAL_FORM_FIELD_MOVE_MIME, String(index))
}

function onLegacyFieldDrop(index: number): void {
  if (props.readOnly || draggedFieldIndex.value === null) return
  const localId = fields.value[draggedFieldIndex.value]?.localId
  if (localId) emit('move-field', { localId, targetIndex: index })
  resetFieldDragState()
}

function activateFieldDropSlot(index: number): void {
  if (!props.readOnly) activeFieldDropIndex.value = index
}

function selectFieldInsertionSlot(index: number): void {
  if (props.readOnly || !props.structuralMutationEnabled) return
  if (selectedFieldInsertionIndex.value === index) {
    selectedFieldInsertionIndex.value = null
    formBuilderAnnouncement.value = '已取消插入位置'
    return
  }
  selectedFieldInsertionIndex.value = index
  formBuilderAnnouncement.value = `已选择第 ${index + 1} 个插入位置，请选择表单组件`
}

function deactivateFieldDropSlot(index: number): void {
  if (activeFieldDropIndex.value === index) activeFieldDropIndex.value = null
}

function resetFieldDragState(): void {
  draggedFieldIndex.value = null
  activeFieldDropIndex.value = null
}

function onFieldInsertionDrop(event: DragEvent, insertionIndex: number): void {
  if (props.readOnly) {
    resetFieldDragState()
    return
  }
  const paletteType = readPaletteFieldType(event.dataTransfer, props.attachmentAuthoringEnabled)
  if (paletteType) {
    requestAddField(paletteType, insertionIndex)
    resetFieldDragState()
    return
  }
  const sourceIndex = readMovedFieldIndex(event.dataTransfer)
  if (
    sourceIndex === null
    || draggedFieldIndex.value === null
    || sourceIndex !== draggedFieldIndex.value
    || sourceIndex < 0
    || sourceIndex >= fields.value.length
  ) {
    resetFieldDragState()
    return
  }
  const targetIndex = insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex
  if (targetIndex !== sourceIndex) {
    const localId = fields.value[sourceIndex]?.localId
    if (localId) emit('move-field', { localId, targetIndex })
  }
  resetFieldDragState()
}

function focusField(localId: string): void {
  selectedFieldLocalId.value = localId
}

function currentFieldLocalId(): string | null {
  return selectedFieldLocalId.value || null
}

function announce(message: string): void {
  formBuilderAnnouncement.value = message
}

defineExpose({ focusField, currentFieldLocalId, announce })

function onFieldKeyboardReorder(event: KeyboardEvent, index: number): void {
  if (props.readOnly || !event.altKey) return
  if (event.key === 'ArrowUp' && index > 0) {
    event.preventDefault()
    moveField(index, -1)
  } else if (event.key === 'ArrowDown' && index < fields.value.length - 1) {
    event.preventDefault()
    moveField(index, 1)
  }
}
</script>

<style scoped>
.approval-form-builder {
  border-color: var(--ms-border-light);
  border-radius: var(--ms-radius-lg);
  box-shadow: var(--ms-shadow-card);
}

.approval-form-builder__header,
.approval-form-builder__legacy-toolbar,
.approval-form-builder__canvas-heading,
.approval-form-builder__field-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.approval-form-builder__header > div,
.approval-form-builder__canvas-heading > div {
  display: grid;
  gap: 2px;
}

.approval-form-builder__header small,
.approval-form-builder__canvas-heading small {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.approval-form-builder__workspace {
  display: grid;
  grid-template-columns: minmax(220px, 240px) minmax(300px, 1fr) minmax(300px, 380px);
  align-items: start;
  gap: 16px;
}

.approval-form-builder__workspace :deep(.approval-form-palette) {
  grid-row: auto;
}

.approval-form-builder__canvas,
.approval-form-builder__inspector-shell {
  min-width: 0;
}

.approval-form-builder__canvas {
  padding: 14px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}

.approval-form-builder__canvas-heading {
  margin-bottom: 8px;
}

.approval-form-builder__inspector-shell {
  position: sticky;
  top: 116px;
  max-height: calc(100vh - 148px);
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
}

.approval-form-builder__field-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 64px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: var(--el-bg-color);
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.approval-form-builder__field-card:hover,
.approval-form-builder__field-card.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-8);
}

.approval-form-builder__field-copy {
  display: grid;
  min-width: 0;
}

.approval-form-builder__field-select {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 10px;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.approval-form-builder__field-select:focus-visible {
  border-color: var(--el-color-primary);
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: 1px;
}

.approval-form-builder__field-copy strong,
.approval-form-builder__field-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.approval-form-builder__required {
  flex: 0 0 auto;
  padding: 2px 6px;
  border: 1px solid var(--el-color-danger-light-5);
  border-radius: 999px;
  color: var(--el-color-danger);
  font-size: 11px;
}

.approval-form-builder__field-copy span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.approval-form-builder__field-actions {
  display: flex;
  align-items: center;
}

.approval-form-builder__drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: grab;
}

.approval-form-builder__drag-handle:hover:not(:disabled),
.approval-form-builder__drag-handle:focus-visible {
  border-color: var(--el-border-color);
  outline: none;
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
}

.approval-form-builder__drag-handle:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.approval-form-builder__drop-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 28px;
  margin: 4px 0;
  padding: 0;
  border: 1px dashed transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-placeholder);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  transition: min-height 0.15s ease, border-color 0.15s ease, background 0.15s ease;
}

.approval-form-builder__drop-slot::before,
.approval-form-builder__drop-slot::after {
  height: 1px;
  flex: 1;
  background: var(--el-border-color-lighter);
  content: '';
}

.approval-form-builder__drop-slot span {
  padding: 0 8px;
}

.approval-form-builder__drop-slot:hover:not(:disabled),
.approval-form-builder__drop-slot:focus-visible,
.approval-form-builder__drop-slot.is-active,
.approval-form-builder__drop-slot.is-selected {
  min-height: 44px;
  border-color: var(--el-color-primary);
  outline: none;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.approval-form-builder__drop-slot:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.approval-form-builder__status {
  min-height: 20px;
  margin: 4px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.approval-form-builder__legacy-list {
  display: grid;
  gap: 12px;
}

.approval-form-builder__legacy-item {
  padding: 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.approval-form-builder__legacy-toolbar {
  margin-bottom: 12px;
}

@media (max-width: 1280px) {
  .approval-form-builder__workspace {
    grid-template-columns: minmax(180px, 210px) minmax(300px, 1fr);
  }

  .approval-form-builder__inspector-shell {
    position: static;
    grid-column: 1 / -1;
    max-height: none;
  }
}

@media (max-width: 860px) {
  .approval-form-builder__workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .approval-form-builder__workspace :deep(.approval-form-palette),
  .approval-form-builder__inspector-shell {
    grid-column: 1;
  }
}

@media (max-width: 760px) {
  .approval-form-builder__field-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .approval-form-builder__field-actions {
    justify-content: flex-end;
  }

  .approval-form-builder__legacy-toolbar {
    align-items: flex-start;
  }
}
</style>
