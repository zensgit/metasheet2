<template>
  <div
    class="approval-form-builder"
    data-testid="approval-form-builder"
    :data-drag-active="activeDrag ? 'true' : undefined"
    @dragover="onCanvasDragOver"
    @drop="onCanvasDrop"
  >
    <div class="approval-form-builder__list" role="list" aria-label="表单字段">
      <template
        v-for="(descriptor, index) in slotDescriptors"
        :key="descriptor.key"
      >
        <div v-if="!readOnly" class="approval-form-builder__slot-region">
          <button
            type="button"
            class="approval-form-builder__slot"
            :class="{
              'is-drag-active': activeDrag !== null,
              'is-drop-target': dropTargetKey === descriptor.key,
              'is-menu-open': insertMenuSlotKey === descriptor.key,
            }"
            :data-testid="`approval-form-builder-slot-${descriptor.key}`"
            :data-slot-position="descriptor.position"
            :aria-label="`在位置 ${descriptor.position + 1} 插入字段`"
            :aria-expanded="insertMenuSlotKey === descriptor.key"
            @click.stop="onSlotClick(descriptor)"
            @dragenter="onSlotDragOver(descriptor, $event)"
            @dragover="onSlotDragOver(descriptor, $event)"
            @dragleave="onSlotDragLeave(descriptor)"
            @drop.stop="onSlotDrop(descriptor, $event)"
          >
            <span class="approval-form-builder__slot-line" aria-hidden="true" />
            <span class="approval-form-builder__slot-plus" aria-hidden="true">＋</span>
          </button>
          <div
            v-if="insertMenuSlotKey === descriptor.key"
            class="approval-form-builder__slot-menu"
            role="menu"
            aria-label="选择要插入的字段类型"
            data-testid="approval-form-builder-slot-menu"
          >
            <button
              v-for="option in insertTypeOptions"
              :key="option.type"
              type="button"
              role="menuitem"
              class="approval-form-builder__slot-menu-item"
              :data-testid="`approval-form-builder-insert-${option.type}`"
              @click.stop="onInsertMenuPick(descriptor, option.type)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div
          v-if="index < fields.length"
          class="approval-form-builder__card"
          :class="{ 'is-selected': selectedLocalId === fields[index].localId }"
          role="listitem"
          tabindex="-1"
          data-testid="approval-form-builder-card"
          :data-field-local-id="fields[index].localId"
          :data-field-type="fields[index].type"
          :data-selected="selectedLocalId === fields[index].localId ? 'true' : undefined"
          :aria-current="selectedLocalId === fields[index].localId ? 'true' : undefined"
          :aria-label="cardAccessibleName(fields[index], index)"
          @click="selectField(fields[index].localId)"
          @focusin="selectField(fields[index].localId)"
        >
          <div class="approval-form-builder__card-main">
            <span
              v-if="selectedLocalId === fields[index].localId"
              class="approval-form-builder__card-selected-mark"
              data-testid="approval-form-builder-card-selected-mark"
            >
              已选
            </span>
            <span class="approval-form-builder__card-label">
              {{ fields[index].label.trim() || typeLabels[fields[index].type] }}
            </span>
            <span class="approval-form-builder__card-summary">
              {{ cardSummary(fields[index]) }}
            </span>
          </div>
          <div v-if="!readOnly" class="approval-form-builder__card-actions">
            <button
              type="button"
              class="approval-form-builder__card-action"
              :data-testid="`approval-form-builder-move-up-${fields[index].localId}`"
              :disabled="index === 0"
              aria-label="上移"
              @click.stop="onMoveByOffset(fields[index].localId, -1)"
            >
              上移
            </button>
            <button
              type="button"
              class="approval-form-builder__card-action"
              :data-testid="`approval-form-builder-move-down-${fields[index].localId}`"
              :disabled="index === fields.length - 1"
              aria-label="下移"
              @click.stop="onMoveByOffset(fields[index].localId, 1)"
            >
              下移
            </button>
            <button
              type="button"
              class="approval-form-builder__card-handle"
              :data-testid="`approval-form-builder-handle-${fields[index].localId}`"
              :draggable="true"
              aria-label="拖拽调整字段位置"
              @click.stop
              @dragstart="onHandleDragStart(fields[index], $event)"
              @dragend="onHandleDragEnd"
            >
              ⠿
            </button>
          </div>
        </div>
      </template>
    </div>
    <p
      class="approval-form-builder__status"
      role="status"
      aria-live="polite"
      data-testid="approval-form-builder-status"
    >
      {{ statusMessage }}
    </p>
  </div>
</template>

<script lang="ts">
/**
 * Values-free feedback copy (§3.1/FB-D3/§8): typed refusals map to named
 * business explanations that carry NO field values, labels, or ids. Exported
 * for the specs to pin the exact copy.
 */
export const STALE_SLOT_RETRY_MESSAGE =
  '插入位置已变化，本次操作未执行，请重试。'
export const GENERIC_RETRY_MESSAGE = '操作未完成，请重试。'
</script>

<script setup lang="ts">
/**
 * F2 Designer 2.0 form canvas (delta §3.2/§3.3, FB-D1..D4, FB-D8) — the NEW
 * builder, SEPARATE from the extracted flag-OFF `ApprovalFormInlineEditor`
 * fallback. It has NO production mount in this slice: F4 performs the first
 * mount in `TemplateAuthoringView.vue` behind the existing `approvalCanvasV2`
 * flag. Until then it is fully exercisable standalone (mounted tests + the
 * owned browser harness under `apps/web/verification/`).
 *
 * Contract highlights:
 * - ONE command path (FB-D4): palette click (`appendField`), palette drag,
 *   slot click/keyboard insertion, existing-field drag, and keyboard
 *   上移/下移 ALL go through the injected `approvalFormAuthoringAdapter`. This
 *   component never splices/filters the field array itself.
 * - N+1 semantic insertion slots (FB-D3): each slot carries the
 *   `FormInsertionAnchor` bound at render ({start} | {after,localId}); the
 *   pure command re-resolves it against the CURRENT draft immediately before
 *   mutation. A stale anchor is a values-free no-op with a retry message —
 *   never an index fallback, never an append fallback.
 * - Typed drag codec (§3.1): drops decode strictly via
 *   `readApprovalFormDragPayload`; `text/plain`/foreign/malformed payloads are
 *   never commands. `dragover` may only use MIME-type PRESENCE as the
 *   candidate signal.
 * - Transient drag state (§3.1) clears on: drop (success or failure, on-slot
 *   or outside), dragend, Escape, route change (unmount), and the read-only
 *   transition.
 * - The move HANDLE initiates existing-field drag, not the whole card (§3.3).
 * - Read-only mode renders no slots, handles, or move buttons.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from 'vue'
import {
  createFormAuthoringAdapter,
  type FormAdapterResult,
  type FormAuthoringAdapter,
  type FormAuthoringSession,
} from '../approvalFormAuthoringAdapter'
import type { FormInsertionAnchor } from '../approvalFormCommands'
import {
  createApprovalFormDragSession,
  dataTransferSignalsApprovalFormDrag,
  readApprovalFormDragPayload,
  writeApprovalFormDragPayload,
  type ApprovalFormDragPayload,
  type ApprovalFormDragSession,
} from '../approvalFormDragPayload'
import type {
  AuthorableFieldType,
  FieldAuthoringDraft,
  TemplateAuthoringDraft,
} from '../templateAuthoring'
import {
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  APPROVAL_FORM_PALETTE_GROUPS,
} from './ApprovalFormPalette.vue'

interface InsertionSlotDescriptor {
  key: string
  anchor: FormInsertionAnchor
  position: number
}

const props = withDefaults(
  defineProps<{
    /** Hydrated draft seeding the session (once, at mount). */
    draft: TemplateAuthoringDraft
    readOnly?: boolean
    /** Shared transient drag session (pass the same one to the palette). */
    dragSession?: ApprovalFormDragSession
    /** FB-D4/FB-D5 seam: the ONE production adapter; injectable in tests. */
    adapter?: FormAuthoringAdapter
  }>(),
  { readOnly: false, dragSession: undefined, adapter: undefined },
)

const emit = defineEmits<{
  (
    e: 'draft-change',
    draft: TemplateAuthoringDraft,
    focusLocalId: string | null,
  ): void
}>()

const adapter: FormAuthoringAdapter =
  props.adapter ?? createFormAuthoringAdapter()
const dragSession: ApprovalFormDragSession =
  props.dragSession ?? createApprovalFormDragSession()

const sessionRef = shallowRef<FormAuthoringSession>(
  adapter.startSession(props.draft, props.draft.fields[0]?.localId ?? null),
)
const selectedLocalId = ref<string | null>(
  props.draft.fields[0]?.localId ?? null,
)
const statusMessage = ref('')
const activeDrag = shallowRef<ApprovalFormDragPayload | null>(
  dragSession.active(),
)
const dropTargetKey = ref<string | null>(null)
const insertMenuSlotKey = ref<string | null>(null)

const typeLabels = APPROVAL_FORM_FIELD_TYPE_LABELS
const insertTypeOptions = APPROVAL_FORM_PALETTE_GROUPS.flatMap(
  (group) => group.entries,
)

const fields = computed(() => sessionRef.value.draft.fields)

// FB-D3: N+1 slots for N fields, identified by current neighbors, never a
// persisted index/pixel. The anchor is bound to the slot at RENDER; the
// command re-resolves it at mutation time.
const slotDescriptors = computed<InsertionSlotDescriptor[]>(() => {
  const descriptors: InsertionSlotDescriptor[] = [
    { key: 'start', anchor: { kind: 'start' }, position: 0 },
  ]
  sessionRef.value.draft.fields.forEach((field, index) => {
    descriptors.push({
      key: `after-${field.localId}`,
      anchor: { kind: 'after', localId: field.localId },
      position: index + 1,
    })
  })
  return descriptors
})

function cardSummary(field: FieldAuthoringDraft): string {
  const parts = [typeLabels[field.type], field.required ? '必填' : '选填']
  if (field.type === 'detail') {
    parts.push(`${field.detailColumns.length} 个子字段`)
  }
  return parts.join(' · ')
}

function cardAccessibleName(field: FieldAuthoringDraft, index: number): string {
  const label = field.label.trim() || typeLabels[field.type]
  return `${label}，${typeLabels[field.type]}字段，位置 ${index + 1}`
}

function selectField(localId: string): void {
  selectedLocalId.value = localId
}

/**
 * Commit one adapter result: success updates session/selection and (only for a
 * value-changing edit) emits `draft-change`; rejection surfaces a VALUES-FREE
 * retry message and leaves session, draft, and history untouched (FB-D4).
 */
function applyResult(result: FormAdapterResult): boolean {
  if (!result.ok) {
    statusMessage.value =
      result.reason === 'target_not_found' || result.reason === 'field_not_found'
        ? STALE_SLOT_RETRY_MESSAGE
        : GENERIC_RETRY_MESSAGE
    return false
  }
  sessionRef.value = result.session
  selectedLocalId.value = result.focusLocalId
  statusMessage.value = ''
  if (result.changed) {
    emit('draft-change', result.session.draft, result.focusLocalId)
  }
  if (result.focusLocalId) void focusCard(result.focusLocalId)
  return true
}

async function focusCard(localId: string): Promise<void> {
  await nextTick()
  const card = document.querySelector<HTMLElement>(
    `[data-testid="approval-form-builder"] [data-field-local-id="${localId}"]`,
  )
  card?.focus()
}

/** Palette click path: append (§3.1), same adapter as every other path. */
function appendField(type: AuthorableFieldType): boolean {
  if (props.readOnly) return false
  return applyResult(adapter.addField(sessionRef.value, type))
}

/** Slot click/keyboard path: exact-anchor insert via the same adapter. */
function insertFieldAt(
  anchor: FormInsertionAnchor,
  type: AuthorableFieldType,
): boolean {
  if (props.readOnly) return false
  return applyResult(adapter.addField(sessionRef.value, type, anchor))
}

/**
 * Adapter passthrough (reference-aware, last-field-forbidden). No F2 UI mounts
 * it — the delete affordance arrives with the F3 inspector — but the command
 * surface stays the ONE adapter path.
 */
function removeField(localId: string): boolean {
  if (props.readOnly) return false
  return applyResult(adapter.removeField(sessionRef.value, localId))
}

function onMoveByOffset(localId: string, offset: -1 | 1): void {
  if (props.readOnly) return
  applyResult(adapter.moveFieldByOffset(sessionRef.value, localId, offset))
}

// --- insertion slot interactions -------------------------------------------

function onSlotClick(descriptor: InsertionSlotDescriptor): void {
  if (props.readOnly) return
  insertMenuSlotKey.value =
    insertMenuSlotKey.value === descriptor.key ? null : descriptor.key
}

function onInsertMenuPick(
  descriptor: InsertionSlotDescriptor,
  type: AuthorableFieldType,
): void {
  insertMenuSlotKey.value = null
  insertFieldAt(descriptor.anchor, type)
}

function isCandidateDrag(event: DragEvent): boolean {
  return (
    activeDrag.value !== null ||
    dataTransferSignalsApprovalFormDrag(event.dataTransfer)
  )
}

function onSlotDragOver(
  descriptor: InsertionSlotDescriptor,
  event: DragEvent,
): void {
  if (props.readOnly) return
  if (!isCandidateDrag(event)) return
  event.preventDefault()
  if (event.dataTransfer) {
    try {
      event.dataTransfer.dropEffect =
        activeDrag.value?.kind === 'field' ? 'move' : 'copy'
    } catch {
      // readonly dropEffect in exotic hosts; affordance only.
    }
  }
  dropTargetKey.value = descriptor.key
}

function onSlotDragLeave(descriptor: InsertionSlotDescriptor): void {
  if (dropTargetKey.value === descriptor.key) dropTargetKey.value = null
}

/**
 * Drop on slot k: strict decode first (§3.1 — full structured validation at
 * drop, before ANY command/draft/history mutation), then the slot's
 * render-time SEMANTIC anchor goes to the adapter, which re-resolves it
 * against the current draft (FB-D3). Transient drag state clears on both
 * success and failure.
 */
function onSlotDrop(
  descriptor: InsertionSlotDescriptor,
  event: DragEvent,
): void {
  event.preventDefault()
  const payload = readApprovalFormDragPayload(event.dataTransfer)
  clearTransientDragState()
  if (props.readOnly) return
  if (!payload) return // foreign/malformed/generic payload: never a command
  if (payload.kind === 'palette') {
    applyResult(adapter.addField(sessionRef.value, payload.fieldType, descriptor.anchor))
    return
  }
  moveFieldToAnchor(payload.localId, descriptor.anchor)
}

/**
 * Existing-field drop: resolve the semantic anchor against the CURRENT draft
 * and call the same canonical `moveField` the keyboard path uses (§3.3).
 * Dropping a field on one of its own adjacent slots is a value-identical
 * boundary no-op (zero history entries) by adapter construction.
 */
function moveFieldToAnchor(
  movingLocalId: string,
  anchor: FormInsertionAnchor,
): void {
  if (anchor.kind === 'start') {
    const first = sessionRef.value.draft.fields[0]
    if (!first) return
    applyResult(
      adapter.moveField(sessionRef.value, movingLocalId, first.localId, 'before'),
    )
    return
  }
  applyResult(
    adapter.moveField(sessionRef.value, movingLocalId, anchor.localId, 'after'),
  )
}

// --- existing-field drag (move handle, §3.3) --------------------------------

function onHandleDragStart(field: FieldAuthoringDraft, event: DragEvent): void {
  if (props.readOnly) {
    event.preventDefault()
    return
  }
  const payload = {
    version: 1,
    kind: 'field',
    localId: field.localId,
  } as const
  writeApprovalFormDragPayload(event.dataTransfer, payload)
  dragSession.begin(payload)
  selectedLocalId.value = field.localId
}

function onHandleDragEnd(): void {
  clearTransientDragState()
}

// --- canvas-level (outside-slot) drag handling ------------------------------

function onCanvasDragOver(_event: DragEvent): void {
  // Invalid regions are NOT drop targets (§3.2): no preventDefault here, so
  // the browser refuses the drop outside a slot.
}

function onCanvasDrop(event: DragEvent): void {
  // Dropping outside a slot is a no-op; it still clears transient state.
  event.preventDefault()
  clearTransientDragState()
}

// --- transient-state clearing (§3.1: all five triggers) ---------------------

function clearTransientDragState(): void {
  dragSession.clear()
  dropTargetKey.value = null
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  clearTransientDragState()
  insertMenuSlotKey.value = null
}

const unsubscribe = dragSession.subscribe((active) => {
  activeDrag.value = active
  if (!active) dropTargetKey.value = null
})

watch(
  () => props.readOnly,
  (readOnly) => {
    if (readOnly) {
      clearTransientDragState()
      insertMenuSlotKey.value = null
    }
  },
)

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  clearTransientDragState() // route change/unmount clears the shared session
  unsubscribe()
})

defineExpose({
  appendField,
  insertFieldAt,
  removeField,
  getSession: () => sessionRef.value,
  getDragSession: () => dragSession,
})
</script>

<style scoped>
.approval-form-builder {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 240px;
  padding: 16px;
  background: var(--el-fill-color-lighter);
  border-radius: 12px;
}

.approval-form-builder__list {
  display: flex;
  flex-direction: column;
}

.approval-form-builder__slot-region {
  position: relative;
}

.approval-form-builder__slot {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 40px;
  padding: 4px 8px;
  border: 0;
  background: transparent;
  cursor: pointer;
  color: var(--el-text-color-placeholder);
}

.approval-form-builder__slot-line {
  flex: 1;
  height: 2px;
  border-radius: 1px;
  background: var(--el-border-color-lighter);
}

.approval-form-builder__slot-plus {
  font-size: 12px;
  opacity: 0;
}

.approval-form-builder__slot:hover .approval-form-builder__slot-plus,
.approval-form-builder__slot:focus-visible .approval-form-builder__slot-plus,
.approval-form-builder__slot.is-drag-active .approval-form-builder__slot-plus,
.approval-form-builder__slot.is-menu-open .approval-form-builder__slot-plus {
  opacity: 1;
}

.approval-form-builder__slot:hover .approval-form-builder__slot-line,
.approval-form-builder__slot:focus-visible .approval-form-builder__slot-line,
.approval-form-builder__slot.is-drag-active .approval-form-builder__slot-line {
  background: var(--el-color-primary-light-5);
}

.approval-form-builder__slot.is-drop-target .approval-form-builder__slot-line {
  height: 4px;
  background: var(--el-color-primary);
}

.approval-form-builder__slot.is-drop-target {
  color: var(--el-color-primary);
}

.approval-form-builder__slot:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.approval-form-builder__slot-menu {
  position: absolute;
  z-index: 10;
  top: 100%;
  left: 8px;
  display: grid;
  grid-template-columns: repeat(2, minmax(96px, 1fr));
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-lighter);
}

.approval-form-builder__slot-menu-item {
  min-height: 40px;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.approval-form-builder__slot-menu-item:hover,
.approval-form-builder__slot-menu-item:focus-visible {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}

.approval-form-builder__card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 56px;
  padding: 10px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color);
  cursor: pointer;
}

.approval-form-builder__card.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary-light-5);
}

.approval-form-builder__card:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.approval-form-builder__card-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.approval-form-builder__card-selected-mark {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--el-color-primary);
  border-radius: 4px;
  font-size: 11px;
  color: var(--el-color-primary);
}

.approval-form-builder__card-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.approval-form-builder__card-summary {
  flex: none;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.approval-form-builder__card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.approval-form-builder__card-action,
.approval-form-builder__card-handle {
  min-height: 40px;
  min-width: 40px;
  padding: 4px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: pointer;
}

.approval-form-builder__card-action:disabled {
  color: var(--el-text-color-placeholder);
  cursor: not-allowed;
}

.approval-form-builder__card-handle {
  cursor: grab;
  touch-action: none;
}

.approval-form-builder__card-action:focus-visible,
.approval-form-builder__card-handle:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.approval-form-builder__status {
  min-height: 18px;
  margin: 0;
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
