<template>
  <div
    ref="rootRef"
    class="approval-form-builder"
    data-testid="approval-form-builder"
    :data-drag-active="activeDrag ? 'true' : undefined"
    @dragover="onCanvasDragOver"
    @drop="onCanvasDrop"
  >
    <div class="approval-form-builder__canvas">
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
            aria-haspopup="menu"
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
            @keydown="onSlotMenuKeydown(descriptor, $event)"
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
          <div class="approval-form-builder__card-content">
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

            <!-- The requester form already renders detail fields as an editable table. Mirror that
                 shape here so configuring columns immediately produces a faithful authoring
                 preview instead of the previous opaque "N 个子字段" summary. Controls stay
                 disabled: values belong to approval instances, not template authoring. -->
            <div
              v-if="fields[index].type === 'detail'"
              class="approval-form-builder__detail-preview"
              data-testid="approval-form-builder-detail-preview"
            >
              <table
                v-if="fields[index].detailColumns.length > 0"
                class="approval-form-builder__detail-table"
                :aria-label="`${fields[index].label.trim() || '明细'}子表格预览`"
              >
                <thead>
                  <tr>
                    <th
                      v-for="column in fields[index].detailColumns"
                      :key="column.localId"
                      scope="col"
                      :data-column-local-id="column.localId"
                    >
                      {{ detailColumnLabel(column) }}
                      <span
                        v-if="column.required"
                        class="approval-form-builder__detail-required"
                        aria-label="必填"
                      >*</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td
                      v-for="column in fields[index].detailColumns"
                      :key="column.localId"
                    >
                      <textarea
                        v-if="column.type === 'textarea'"
                        disabled
                        rows="1"
                        :aria-label="`${detailColumnLabel(column)}输入预览`"
                        :placeholder="detailPreviewPlaceholder(column)"
                      />
                      <select
                        v-else-if="column.type === 'select' || column.type === 'multi-select' || column.type === 'user'"
                        disabled
                        :aria-label="`${detailColumnLabel(column)}选择预览`"
                      >
                        <option>{{ detailPreviewPlaceholder(column) }}</option>
                      </select>
                      <input
                        v-else
                        disabled
                        :type="column.type === 'number' ? 'number' : 'text'"
                        :aria-label="`${detailColumnLabel(column)}输入预览`"
                        :placeholder="detailPreviewPlaceholder(column)"
                      />
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="approval-form-builder__detail-empty">
                请在右侧添加子字段
              </p>
            </div>
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
    <!-- F3B: selected-field inspector — same ONE adapter path via the typed
         command seam; selection switches settle its dirty buffer first. -->
    <ApprovalFormFieldInspector
      ref="inspectorRef"
      class="approval-form-builder__inspector"
      :field="selectedField"
      :references="selectedFieldReferences"
      :visibility-options="visibilityOptions"
      :read-only="readOnly"
      :execute="runInspectorCommand"
    />
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
 * fallback. F4 mounts it in `TemplateAuthoringView.vue` behind the existing
 * `approvalCanvasV2` flag (default ON) — the explicit flag-OFF operator rollback renders only
 * the legacy inline editor. Exercisable standalone (mounted
 * tests + the owned browser harness under `apps/web/verification/`) and, once
 * hydrated with the flag ON, as the production form surface.
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
 * - Read-only mode renders no slots, handles, or move buttons. The read-only
 *   guard is ALSO re-checked at mutation time on the drop path (P3-2: a drop
 *   racing a readOnly flip must not insert).
 * - F3B: hosts `ApprovalFormFieldInspector` for the selected field. Inspector
 *   edits run through `runInspectorCommand` — the SAME one adapter path — and
 *   every selection switch settles the inspector's dirty buffer first (FB-D7:
 *   a valid buffer commits as ONE entry; an invalid buffer BLOCKS the switch;
 *   never a silent discard).
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
  DetailColumnDraft,
  FieldAuthoringDraft,
  TemplateAuthoringDraft,
} from '../templateAuthoring'
import {
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  APPROVAL_FORM_PALETTE_GROUPS,
} from './ApprovalFormPalette.vue'
import ApprovalFormFieldInspector, {
  type FormFieldInspectorCommand,
} from './ApprovalFormFieldInspector.vue'

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
const rootRef = ref<HTMLElement | null>(null)
const inspectorRef = ref<{
  settlePendingEdits(): boolean
  isDirty(): boolean
} | null>(null)

const typeLabels = APPROVAL_FORM_FIELD_TYPE_LABELS
const insertTypeOptions = APPROVAL_FORM_PALETTE_GROUPS.flatMap(
  (group) => group.entries,
)

const fields = computed(() => sessionRef.value.draft.fields)

// --- F3B inspector wiring ---------------------------------------------------

const selectedField = computed<FieldAuthoringDraft | null>(
  () =>
    sessionRef.value.draft.fields.find(
      (field) => field.localId === selectedLocalId.value,
    ) ?? null,
)

/** FB-D6 reference provider output for the selected field (business summary). */
const selectedFieldReferences = computed(() =>
  selectedLocalId.value
    ? adapter.listFieldReferences(sessionRef.value, selectedLocalId.value)
    : [],
)

/**
 * Visibility depends-on candidates: other fields with an id, excluding
 * `record-link`/`detail` (server fail-closed as visibility dependencies).
 * Option TEXT is the business label only — ids ride the non-visible value.
 *
 * Lock-8 L8-A (approval-lock8-field-vocabulary-20260817.md §1.1, MS-9): `explanation` joins the
 * exclusion — it carries no value at all, so offering it here would be an M7 inert control
 * (always selectable, never publishable; the server rejects it unconditionally regardless of
 * which authoring surface produced the reference). NOTE: `date_range` is NOT excluded here — this
 * F2 track's own predicate predates it and stayed unaddressed by L8-B, out of this slice's scope;
 * not re-fixed here to avoid an unrelated-scope edit riding along.
 */
const visibilityOptions = computed(() => {
  const current = selectedField.value
  if (!current) return []
  return sessionRef.value.draft.fields
    .filter(
      (field) =>
        field.localId !== current.localId &&
        field.id.trim().length > 0 &&
        field.type !== 'record-link' &&
        field.type !== 'detail' &&
        field.type !== 'explanation',
    )
    .map((field) => ({
      id: field.id.trim(),
      label: field.label.trim() || typeLabels[field.type],
    }))
})

/**
 * FB-D7: settle the inspector's dirty buffer before any selection-changing
 * action. A valid buffer commits as ONE history entry; an invalid buffer
 * BLOCKS the action (the inspector shows values-free copy). Never a silent
 * discard.
 */
function settleInspector(): boolean {
  const inspector = inspectorRef.value
  if (!inspector) return true
  return inspector.settlePendingEdits()
}

/**
 * F3B: the ONE command path for inspector edits (FB-D4). Each typed command
 * maps to exactly one adapter call; the result is applied here (the single
 * session writer) and returned SYNCHRONOUSLY so the inspector can render
 * named refusals. Inspector commits keep DOM focus in the inspector
 * (moveFocus: false); a successful delete moves focus to the next card.
 */
function runInspectorCommand(
  command: FormFieldInspectorCommand,
): FormAdapterResult | null {
  if (props.readOnly) return null
  const session = sessionRef.value
  let result: FormAdapterResult
  switch (command.kind) {
    case 'update-properties':
      result = adapter.updateFieldProperties(
        session,
        command.localId,
        command.patch,
      )
      break
    case 'retype':
      result = adapter.retypeField(session, command.localId, command.nextType)
      break
    case 'remove-field':
      result = adapter.removeField(session, command.localId)
      break
    case 'add-detail-column':
      result = adapter.addDetailColumn(session, command.fieldLocalId)
      break
    case 'update-detail-column':
      result = adapter.updateDetailColumn(
        session,
        command.fieldLocalId,
        command.columnLocalId,
        command.patch,
      )
      break
    case 'retype-detail-column':
      result = adapter.retypeDetailColumn(
        session,
        command.fieldLocalId,
        command.columnLocalId,
        command.nextType,
      )
      break
    case 'remove-detail-column':
      result = adapter.removeDetailColumn(
        session,
        command.fieldLocalId,
        command.columnLocalId,
      )
      break
  }
  applyResult(result, {
    moveFocus: command.kind === 'remove-field',
    surfaceStatus: false,
  })
  return result
}

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

function detailColumnLabel(column: DetailColumnDraft): string {
  return column.label.trim() || (column.type === 'attachment' ? '附件' : typeLabels[column.type])
}

function detailPreviewPlaceholder(column: DetailColumnDraft): string {
  const label = detailColumnLabel(column)
  if (column.type === 'select' || column.type === 'multi-select' || column.type === 'user') {
    return `请选择${label}`
  }
  if (column.type === 'date' || column.type === 'datetime') return `请选择${label}`
  if (column.type === 'number') return `请输入${label}`
  return column.original?.placeholder?.trim() || `请输入${label}`
}

function cardAccessibleName(field: FieldAuthoringDraft, index: number): string {
  const label = field.label.trim() || typeLabels[field.type]
  return `${label}，${typeLabels[field.type]}字段，位置 ${index + 1}`
}

function selectField(localId: string): void {
  if (selectedLocalId.value === localId) return
  // FB-D7: a dirty inspector buffer settles (ONE entry) or BLOCKS the switch.
  if (!settleInspector()) return
  selectedLocalId.value = localId
}

/**
 * Commit one adapter result: success updates session/selection and (only for a
 * value-changing edit) emits `draft-change`; rejection surfaces a VALUES-FREE
 * retry message and leaves session, draft, and history untouched (FB-D4).
 * Inspector-originated commands keep DOM focus in the inspector
 * (`moveFocus: false`) and render their own refusal copy (`surfaceStatus:
 * false` keeps the canvas status line quiet for them).
 */
function applyResult(
  result: FormAdapterResult,
  options: { moveFocus?: boolean; surfaceStatus?: boolean } = {},
): boolean {
  const { moveFocus = true, surfaceStatus = true } = options
  if (!result.ok) {
    if (surfaceStatus) {
      statusMessage.value =
        result.reason === 'target_not_found' || result.reason === 'field_not_found'
          ? STALE_SLOT_RETRY_MESSAGE
          : GENERIC_RETRY_MESSAGE
    }
    return false
  }
  sessionRef.value = result.session
  selectedLocalId.value = result.focusLocalId
  statusMessage.value = ''
  if (result.changed) {
    emit('draft-change', result.session.draft, result.focusLocalId)
  }
  if (moveFocus && result.focusLocalId) void focusCard(result.focusLocalId)
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
  if (!settleInspector()) return false
  return applyResult(adapter.addField(sessionRef.value, type))
}

/**
 * Slot click/keyboard path: exact-anchor insert via the same adapter. The
 * read-only check here executes AT MUTATION TIME — the drop path routes
 * through this function, so deleting the early `onSlotDrop` guard alone
 * cannot re-open a read-only insert (P3-2).
 */
function insertFieldAt(
  anchor: FormInsertionAnchor,
  type: AuthorableFieldType,
): boolean {
  if (props.readOnly) return false
  if (!settleInspector()) return false
  return applyResult(adapter.addField(sessionRef.value, type, anchor))
}

/**
 * Adapter passthrough (reference-aware, last-field-forbidden) — the F3
 * inspector's delete affordance also routes here via `runInspectorCommand`;
 * the command surface stays the ONE adapter path.
 */
function removeField(localId: string): boolean {
  if (props.readOnly) return false
  return applyResult(adapter.removeField(sessionRef.value, localId))
}

function onMoveByOffset(localId: string, offset: -1 | 1): void {
  if (props.readOnly) return
  if (!settleInspector()) return
  applyResult(adapter.moveFieldByOffset(sessionRef.value, localId, offset))
}

/**
 * F4 production mount (delta §5 F4 / §9.5): the undo/redo AFFORDANCE. F1
 * built the session history mechanics and F3 made committed inspector edits
 * undoable, but neither F2 nor F3 wired a trigger — this component had no
 * consumer-facing undo/redo path before F4. The integrating view (
 * `TemplateAuthoringView.vue`) reuses its existing 撤销/重做 toolbar buttons,
 * redirected to these exposed methods while `approvalCanvasV2` is mounted,
 * so there is exactly ONE undo/redo control — never a second, divergent
 * history stack (M7).
 */
function undo(): boolean {
  if (props.readOnly) return false
  if (!settleInspector()) return false
  return applyResult(adapter.undo(sessionRef.value))
}

function redo(): boolean {
  if (props.readOnly) return false
  if (!settleInspector()) return false
  return applyResult(adapter.redo(sessionRef.value))
}

function canUndo(): boolean {
  return adapter.canUndo(sessionRef.value)
}

function canRedo(): boolean {
  return adapter.canRedo(sessionRef.value)
}

// --- insertion slot interactions -------------------------------------------

function onSlotClick(descriptor: InsertionSlotDescriptor): void {
  if (props.readOnly) return
  const opening = insertMenuSlotKey.value !== descriptor.key
  insertMenuSlotKey.value = opening ? descriptor.key : null
  // Menu keyboard semantics (aria-haspopup="menu"): focus moves into the menu
  // on open; arrows cycle items; Escape closes and returns to the trigger.
  if (opening) void focusInsertMenuItem(0)
}

async function focusInsertMenuItem(index: number): Promise<void> {
  await nextTick()
  const items = insertMenuItems()
  items[((index % items.length) + items.length) % items.length]?.focus()
}

function insertMenuItems(): HTMLButtonElement[] {
  return Array.from(
    rootRef.value?.querySelectorAll<HTMLButtonElement>(
      '.approval-form-builder__slot-menu-item',
    ) ?? [],
  )
}

function closeInsertMenu(refocusTrigger: boolean): void {
  const slotKey = insertMenuSlotKey.value
  insertMenuSlotKey.value = null
  if (refocusTrigger && slotKey) {
    rootRef.value
      ?.querySelector<HTMLButtonElement>(
        `[data-testid="approval-form-builder-slot-${slotKey}"]`,
      )
      ?.focus()
  }
}

function onSlotMenuKeydown(
  _descriptor: InsertionSlotDescriptor,
  event: KeyboardEvent,
): void {
  const items = insertMenuItems()
  if (items.length === 0) return
  const activeIndex = items.indexOf(
    document.activeElement as HTMLButtonElement,
  )
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    void focusInsertMenuItem(activeIndex + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    void focusInsertMenuItem(activeIndex <= 0 ? items.length - 1 : activeIndex - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    void focusInsertMenuItem(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    void focusInsertMenuItem(items.length - 1)
  } else if (event.key === 'Escape') {
    // Handled here (close + focus return); stop it from ALSO reaching the
    // window listener, which would clear without restoring focus.
    event.stopPropagation()
    closeInsertMenu(true)
  }
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
 *
 * P3-2 (F2 gate): the early read-only check below is a fast path only —
 * `props.readOnly` is RE-CHECKED at mutation time inside `insertFieldAt` /
 * `moveFieldToAnchor`, so a drop dispatched on a retained slot node while a
 * readOnly flip is landing cannot insert even if this early return is lost.
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
    // Same mutation-time guarded path as slot click/keyboard (FB-D4 + P3-2).
    insertFieldAt(descriptor.anchor, payload.fieldType)
    return
  }
  moveFieldToAnchor(payload.localId, descriptor.anchor)
}

/**
 * Existing-field drop: resolve the semantic anchor against the CURRENT draft
 * and call the same canonical `moveField` the keyboard path uses (§3.3).
 * Dropping a field on one of its own adjacent slots is a value-identical
 * boundary no-op (zero history entries) by adapter construction. The
 * read-only re-check runs HERE, at mutation time, immediately before the
 * anchor-resolving adapter call (P3-2).
 */
function moveFieldToAnchor(
  movingLocalId: string,
  anchor: FormInsertionAnchor,
): void {
  if (props.readOnly) return
  if (!settleInspector()) return
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

// The exposed programmatic command surface. Each command member
// (appendField / insertFieldAt / moveFieldToAnchor / removeField) carries its
// OWN mutation-time read-only re-check, and each re-check is individually
// pinned by the PER-GATE A read-only gate test: a caller arriving here —
// programmatic or a future UI path without its own gate — hits the same
// boundary as the interactive paths. (getSession / getDragSession are
// read-only accessors, not mutation commands.)
defineExpose({
  appendField,
  insertFieldAt,
  moveFieldToAnchor,
  removeField,
  undo,
  redo,
  canUndo,
  canRedo,
  getSession: () => sessionRef.value,
  getDragSession: () => dragSession,
})
</script>

<style scoped>
.approval-form-builder {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 16px;
  min-height: 240px;
  padding: 16px;
  background: var(--el-fill-color-lighter);
  border-radius: 12px;
}

.approval-form-builder__canvas {
  display: flex;
  flex: 1 1 420px;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.approval-form-builder__inspector {
  flex: 0 1 320px;
  min-width: 260px;
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  min-height: 56px;
  padding: 10px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-bg-color);
  cursor: pointer;
}

.approval-form-builder__card-content {
  flex: 1;
  min-width: 0;
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

.approval-form-builder__detail-preview {
  overflow-x: auto;
  margin-top: 10px;
}

.approval-form-builder__detail-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--el-bg-color);
  font-size: 12px;
}

.approval-form-builder__detail-table th,
.approval-form-builder__detail-table td {
  min-width: 128px;
  padding: 8px;
  border: 1px solid var(--el-border-color-lighter);
  text-align: left;
}

.approval-form-builder__detail-table th {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
  font-weight: 500;
}

.approval-form-builder__detail-table input,
.approval-form-builder__detail-table select,
.approval-form-builder__detail-table textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-placeholder);
  resize: none;
}

.approval-form-builder__detail-required {
  margin-left: 2px;
  color: var(--el-color-danger);
}

.approval-form-builder__detail-empty {
  margin: 0;
  padding: 12px;
  border: 1px dashed var(--el-border-color);
  color: var(--el-text-color-placeholder);
  text-align: center;
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
