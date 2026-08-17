<template>
  <aside
    class="approval-form-field-inspector"
    data-testid="approval-form-field-inspector"
  >
    <p class="approval-form-field-inspector__title">字段设置</p>

    <p
      v-if="!field"
      class="approval-form-field-inspector__empty"
      data-testid="approval-form-field-inspector-empty"
    >
      选择一个字段进行设置
    </p>

    <p
      v-else-if="readOnly"
      class="approval-form-field-inspector__empty"
      data-testid="approval-form-field-inspector-readonly"
    >
      只读模式下不可编辑字段设置
    </p>

    <form v-else class="approval-form-field-inspector__form" @submit.prevent>
      <label class="approval-form-field-inspector__row">
        <span class="approval-form-field-inspector__label">字段类型</span>
        <select
          class="approval-form-field-inspector__control"
          data-testid="approval-form-field-inspector-type"
          :value="field.type"
          @change="onTypeChange($event)"
        >
          <option
            v-for="option in typeOptions"
            :key="option.type"
            :value="option.type"
          >
            {{ option.label }}
          </option>
        </select>
      </label>

      <label class="approval-form-field-inspector__row">
        <span class="approval-form-field-inspector__label">字段名称</span>
        <input
          class="approval-form-field-inspector__control"
          data-testid="approval-form-field-inspector-label"
          type="text"
          :value="textValue('label')"
          @input="onTextInput('label', $event)"
          @blur="commitTextBuffer('label')"
          @keydown.enter.prevent="commitTextBuffer('label')"
        />
      </label>

      <label class="approval-form-field-inspector__row approval-form-field-inspector__row--inline">
        <input
          type="checkbox"
          data-testid="approval-form-field-inspector-required"
          :checked="field.required"
          @change="onRequiredChange($event)"
        />
        <span class="approval-form-field-inspector__label">必填</span>
      </label>

      <label class="approval-form-field-inspector__row">
        <span class="approval-form-field-inspector__label">提示文字</span>
        <input
          class="approval-form-field-inspector__control"
          data-testid="approval-form-field-inspector-placeholder"
          type="text"
          :value="textValue('placeholder')"
          @input="onTextInput('placeholder', $event)"
          @blur="commitTextBuffer('placeholder')"
          @keydown.enter.prevent="commitTextBuffer('placeholder')"
        />
      </label>

      <!-- options (select / multi-select): one logical row action = one commit -->
      <section
        v-if="field.type === 'select' || field.type === 'multi-select'"
        class="approval-form-field-inspector__section"
        data-testid="approval-form-field-inspector-options"
      >
        <p class="approval-form-field-inspector__label">选项</p>
        <div
          v-for="(row, index) in optionRows"
          :key="`${index}-${row.value}`"
          class="approval-form-field-inspector__option-row"
        >
          <input
            class="approval-form-field-inspector__control"
            :data-testid="`approval-form-field-inspector-option-label-${index}`"
            type="text"
            :value="optionLabelValue(index)"
            :aria-label="`选项 ${index + 1} 名称`"
            @input="onOptionLabelInput(index, $event)"
            @blur="commitOptionLabel(index)"
            @keydown.enter.prevent="commitOptionLabel(index)"
          />
          <button
            type="button"
            class="approval-form-field-inspector__minor-action"
            :data-testid="`approval-form-field-inspector-option-remove-${index}`"
            :aria-label="`删除选项 ${index + 1}`"
            @click="removeOption(index)"
          >
            删除
          </button>
        </div>
        <button
          type="button"
          class="approval-form-field-inspector__minor-action"
          data-testid="approval-form-field-inspector-option-add"
          @click="addOption"
        >
          添加选项
        </button>
      </section>

      <!-- detail columns -->
      <section
        v-if="field.type === 'detail'"
        class="approval-form-field-inspector__section"
        data-testid="approval-form-field-inspector-detail"
      >
        <p class="approval-form-field-inspector__label">子字段</p>
        <div
          v-for="column in field.detailColumns"
          :key="column.localId"
          class="approval-form-field-inspector__column-row"
          :data-column-local-id="column.localId"
        >
          <input
            class="approval-form-field-inspector__control"
            :data-testid="`approval-form-field-inspector-column-label-${column.localId}`"
            type="text"
            :value="columnLabelValue(column)"
            aria-label="子字段名称"
            @input="onColumnLabelInput(column.localId, $event)"
            @blur="commitColumnLabel(column.localId)"
            @keydown.enter.prevent="commitColumnLabel(column.localId)"
          />
          <select
            class="approval-form-field-inspector__control approval-form-field-inspector__control--narrow"
            :data-testid="`approval-form-field-inspector-column-type-${column.localId}`"
            aria-label="子字段类型"
            :value="column.type"
            @change="onColumnTypeChange(column.localId, $event)"
          >
            <option
              v-for="option in columnTypeOptions"
              :key="option.type"
              :value="option.type"
            >
              {{ option.label }}
            </option>
          </select>
          <label class="approval-form-field-inspector__row--inline">
            <input
              type="checkbox"
              :data-testid="`approval-form-field-inspector-column-required-${column.localId}`"
              :checked="column.required"
              aria-label="子字段必填"
              @change="onColumnRequiredChange(column.localId, $event)"
            />
            <span class="approval-form-field-inspector__hint">必填</span>
          </label>
          <button
            type="button"
            class="approval-form-field-inspector__minor-action"
            :data-testid="`approval-form-field-inspector-column-remove-${column.localId}`"
            aria-label="删除子字段"
            @click="removeColumn(column.localId)"
          >
            删除
          </button>
        </div>
        <button
          type="button"
          class="approval-form-field-inspector__minor-action"
          data-testid="approval-form-field-inspector-column-add"
          @click="addColumn"
        >
          添加子字段
        </button>
        <div class="approval-form-field-inspector__option-row">
          <label class="approval-form-field-inspector__row">
            <span class="approval-form-field-inspector__hint">最少行数</span>
            <input
              class="approval-form-field-inspector__control approval-form-field-inspector__control--narrow"
              data-testid="approval-form-field-inspector-min-rows"
              type="text"
              inputmode="numeric"
              :value="textValue('minRowsText')"
              @input="onTextInput('minRowsText', $event)"
              @blur="commitTextBuffer('minRowsText')"
              @keydown.enter.prevent="commitTextBuffer('minRowsText')"
            />
          </label>
          <label class="approval-form-field-inspector__row">
            <span class="approval-form-field-inspector__hint">最多行数</span>
            <input
              class="approval-form-field-inspector__control approval-form-field-inspector__control--narrow"
              data-testid="approval-form-field-inspector-max-rows"
              type="text"
              inputmode="numeric"
              :value="textValue('maxRowsText')"
              @input="onTextInput('maxRowsText', $event)"
              @blur="commitTextBuffer('maxRowsText')"
              @keydown.enter.prevent="commitTextBuffer('maxRowsText')"
            />
          </label>
        </div>
      </section>

      <!-- record-link: values-free summary only; the typed base/sheet pickers
           stay with the parent-owned catalog and arrive at the F4 mount. -->
      <section
        v-if="field.type === 'record-link'"
        class="approval-form-field-inspector__section"
        data-testid="approval-form-field-inspector-record-link"
      >
        <p class="approval-form-field-inspector__hint">
          {{ recordLinkConfigured ? '已选择目标空间与目标表。' : '尚未选择目标空间与目标表。' }}
        </p>
      </section>

      <!-- visibility rule -->
      <section
        class="approval-form-field-inspector__section"
        data-testid="approval-form-field-inspector-visibility"
      >
        <p class="approval-form-field-inspector__label">显示条件</p>
        <select
          class="approval-form-field-inspector__control"
          data-testid="approval-form-field-inspector-visibility-depends"
          aria-label="依赖字段"
          :value="field.visibility.dependsOnFieldId"
          @change="onVisibilityDependsChange($event)"
        >
          <option value="">始终显示</option>
          <option
            v-for="option in visibilityOptions"
            :key="option.id"
            :value="option.id"
          >
            {{ option.label }}
          </option>
        </select>
        <template v-if="field.visibility.dependsOnFieldId">
          <select
            class="approval-form-field-inspector__control"
            data-testid="approval-form-field-inspector-visibility-operator"
            aria-label="条件"
            :value="field.visibility.operator"
            @change="onVisibilityOperatorChange($event)"
          >
            <option
              v-for="option in VISIBILITY_OPERATOR_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <input
            v-if="visibilityNeedsValue"
            class="approval-form-field-inspector__control"
            data-testid="approval-form-field-inspector-visibility-value"
            type="text"
            aria-label="条件值"
            :value="textValue('valueText')"
            @input="onTextInput('valueText', $event)"
            @blur="commitTextBuffer('valueText')"
            @keydown.enter.prevent="commitTextBuffer('valueText')"
          />
        </template>
      </section>

      <!-- reference / dependency summary (FB-D6 provider, business labels only) -->
      <section
        class="approval-form-field-inspector__section"
        data-testid="approval-form-field-inspector-references"
      >
        <p class="approval-form-field-inspector__label">引用情况</p>
        <p v-if="referenceSummaries.length === 0" class="approval-form-field-inspector__hint">
          暂无其他配置使用此字段
        </p>
        <ul v-else class="approval-form-field-inspector__reference-list">
          <li v-for="entry in referenceSummaries" :key="entry.kind">
            {{ entry.label }}<template v-if="entry.count > 1">（{{ entry.count }} 处）</template>
          </li>
        </ul>
      </section>

      <div class="approval-form-field-inspector__actions">
        <button
          type="button"
          class="approval-form-field-inspector__danger-action"
          data-testid="approval-form-field-inspector-remove-field"
          @click="removeSelectedField"
        >
          删除字段
        </button>
      </div>
    </form>

    <p
      class="approval-form-field-inspector__status"
      role="status"
      aria-live="polite"
      data-testid="approval-form-field-inspector-status"
    >
      {{ statusMessage }}
    </p>
  </aside>
</template>

<script lang="ts">
import type {
  FormDependencyKind,
  FormDetailColumnPropertyPatch,
  FormFieldDependency,
  FormFieldPropertyPatch,
} from '../approvalFormCommands'
import type { FormFieldType as InspectorFormFieldType } from '../../types/approval'

/** Typed command surface the inspector may request (FB-D4 single path). */
export type FormFieldInspectorCommand =
  | {
      kind: 'update-properties'
      localId: string
      patch: FormFieldPropertyPatch
    }
  | { kind: 'retype'; localId: string; nextType: InspectorFormFieldType }
  | { kind: 'remove-field'; localId: string }
  | { kind: 'add-detail-column'; fieldLocalId: string }
  | {
      kind: 'update-detail-column'
      fieldLocalId: string
      columnLocalId: string
      patch: FormDetailColumnPropertyPatch
    }
  | {
      kind: 'retype-detail-column'
      fieldLocalId: string
      columnLocalId: string
      nextType: InspectorFormFieldType
    }
  | {
      kind: 'remove-detail-column'
      fieldLocalId: string
      columnLocalId: string
    }

/**
 * F3 values-free inspector copy (FB-D6/FB-D7/§8). Refusals map dependency
 * KINDS to business labels; no field values, labels, internal locations, or
 * persistent/local IDs ever enter this copy. Exported for exact spec pins.
 */
export const INSPECTOR_INVALID_BUFFER_MESSAGE =
  '当前字段设置未完成，请先修正后再继续。'
export const INSPECTOR_GENERIC_RETRY_MESSAGE = '操作未完成，请重试。'
export const INSPECTOR_LAST_FIELD_MESSAGE = '表单至少需要保留一个字段。'
export const INSPECTOR_LAST_DETAIL_COLUMN_MESSAGE =
  '明细字段至少需要保留一个子字段。'
export const INSPECTOR_RETYPE_REFUSAL_PREFIX =
  '暂不能修改字段类型，以下配置正在使用此字段，请先调整后重试：'
export const INSPECTOR_DELETE_REFUSAL_PREFIX =
  '暂不能删除，以下配置正在使用此字段，请先调整后重试：'

/** Business labels for every dependency kind (never internal locations/IDs). */
export const DEPENDENCY_KIND_BUSINESS_LABELS: Record<FormDependencyKind, string> = {
  visibility_rule: '字段显示条件',
  step_assignee_source: '审批步骤的审批人来源',
  step_field_permission: '审批步骤的表单权限',
  condition_rule: '条件分支规则',
  condition_formula: '条件公式',
  approval_node_assignee_source: '审批节点的审批人来源',
  preserved_graph_reference: '流程图配置',
  amount_consistency_mapping: '金额一致性校验',
  external_reference: '外部引用',
  detail_config: '明细字段配置',
  record_link_config: '关联记录配置',
  attachment_boundary: '附件能力边界',
}

/** Values-free refusal copy: prefix + deduped business kind labels. */
export function describeDependencyRefusal(
  prefix: string,
  dependencies: readonly FormFieldDependency[],
): string {
  const labels = Array.from(
    new Set(
      dependencies.map((entry) => DEPENDENCY_KIND_BUSINESS_LABELS[entry.kind]),
    ),
  )
  return `${prefix}${labels.join('、')}`
}
</script>

<script setup lang="ts">
/**
 * F3 Designer 2.0 selected-field inspector (delta §3.4, FB-D6/FB-D7) — the
 * NEW builder's property pane, SEPARATE from the extracted flag-OFF
 * `ApprovalFormInlineEditor` fallback. Composed by `ApprovalFormBuilder`
 * (standalone until the F4 production mount behind `approvalCanvasV2`).
 *
 * Contract highlights:
 * - ONE command path (FB-D4): every edit is a typed `FormFieldInspectorCommand`
 *   run through the injected `execute` seam — the builder maps each to exactly
 *   one `approvalFormAuthoringAdapter` call. This component NEVER mutates the
 *   draft or field objects itself.
 * - Committed edits only (FB-D7): text inputs buffer locally and commit on
 *   blur/Enter; selects/toggles commit on change; one logical option/detail
 *   row action = one command = one history entry. Typing a character NEVER
 *   issues a command (per-keystroke undo entries are forbidden).
 * - `settlePendingEdits()` commits one valid dirty buffer as ONE command, or
 *   blocks (returns false) on an invalid buffer with values-free copy — the
 *   builder calls it before every selection switch; a dirty buffer is never
 *   silently discarded.
 * - Type change = the typed retype command; a named
 *   `field_type_incompatible_with_references` refusal renders VALUES-FREE
 *   business copy listing the dependency kinds and reverts the control. The
 *   legacy silent `invalidateStaleRecordLinkDependencies` cleanup is never
 *   called from this path.
 * - Option rows: a new option receives a generated OPAQUE value
 *   (`optionValueFactory` seam); existing hand-authored values are preserved
 *   and never regenerated (§3.4).
 * - No persistent/local IDs in any rendered copy; `localId` appears only in
 *   non-visible data-* attributes/test ids (§8).
 */
import { computed, reactive, ref, watch } from 'vue'
import type { FormAdapterResult } from '../approvalFormAuthoringAdapter'
// NOTE: FormFieldPropertyPatch / FormDetailColumnPropertyPatch and the
// dependency types are imported in the sibling <script> block above; the two
// blocks share one module scope, so they must not be imported twice.
import { DETAIL_LEAF_FIELD_TYPES, type DetailColumnDraft } from '../detailField'
import type { FormFieldType } from '../../types/approval'
import type {
  AuthorableFieldType,
  FieldAuthoringDraft,
  FieldVisibilityDraft,
} from '../templateAuthoring'
import {
  APPROVAL_FORM_FIELD_TYPE_LABELS,
  APPROVAL_FORM_PALETTE_GROUPS,
} from './ApprovalFormPalette.vue'

const props = withDefaults(
  defineProps<{
    /** The selected field (read-only view model), or null when none. */
    field: FieldAuthoringDraft | null
    /** FB-D6 current-draft reference set for the selected field. */
    references?: readonly FormFieldDependency[]
    /** Business options for the visibility depends-on picker (no self/record-link/detail). */
    visibilityOptions?: readonly { id: string; label: string }[]
    readOnly?: boolean
    /**
     * FB-D4 seam: run one typed command through the ONE adapter path. Returns
     * the adapter result, or null when the surface is read-only/unavailable.
     */
    execute: (command: FormFieldInspectorCommand) => FormAdapterResult | null
    /** Opaque value seam for NEW options (§3.4); injectable for determinism. */
    optionValueFactory?: () => string
  }>(),
  {
    references: () => [],
    visibilityOptions: () => [],
    readOnly: false,
    optionValueFactory: undefined,
  },
)

const VISIBILITY_OPERATOR_OPTIONS: readonly {
  value: FieldVisibilityDraft['operator']
  label: string
}[] = [
  { value: 'eq', label: '等于' },
  { value: 'neq', label: '不等于' },
  { value: 'in', label: '包含任一（每行一个值）' },
  { value: 'isEmpty', label: '为空' },
  { value: 'notEmpty', label: '不为空' },
]

const typeOptions = APPROVAL_FORM_PALETTE_GROUPS.flatMap(
  (group) => group.entries,
)
const columnTypeOptions = DETAIL_LEAF_FIELD_TYPES.map((type) => ({
  type,
  label: APPROVAL_FORM_FIELD_TYPE_LABELS[type as AuthorableFieldType],
}))

const field = computed(() => props.field)
const recordLinkConfigured = computed(
  () =>
    Boolean(field.value) &&
    field.value!.recordLinkBaseId.trim() !== '' &&
    field.value!.recordLinkSheetId.trim() !== '',
)
const visibilityNeedsValue = computed(() => {
  const operator = field.value?.visibility.operator
  return operator === 'eq' || operator === 'neq' || operator === 'in'
})

const referenceSummaries = computed(() => {
  const counts = new Map<FormDependencyKind, number>()
  for (const entry of props.references) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)
  }
  return Array.from(counts.entries()).map(([kind, count]) => ({
    kind,
    label: DEPENDENCY_KIND_BUSINESS_LABELS[kind],
    count,
  }))
})

// --- local edit buffer (FB-D7) ----------------------------------------------

type TextBufferKey =
  | 'label'
  | 'placeholder'
  | 'valueText'
  | 'minRowsText'
  | 'maxRowsText'

interface EditBuffer {
  text: Partial<Record<TextBufferKey, string>>
  /** Option row label edits keyed by row index. */
  optionLabels: Record<number, string>
  /** Detail column label edits keyed by column localId. */
  columnLabels: Record<string, string>
}

const buffer = reactive<EditBuffer>({
  text: {},
  optionLabels: {},
  columnLabels: {},
})
const statusMessage = ref('')

function clearBuffer(): void {
  buffer.text = {}
  buffer.optionLabels = {}
  buffer.columnLabels = {}
}

// A NEW selection gets a clean buffer. The builder settles/blocks the old
// buffer BEFORE switching (FB-D7) — this watcher only resets state for the
// newly selected field; it never discards a still-pending buffer for the SAME
// field.
watch(
  () => props.field?.localId,
  () => {
    clearBuffer()
    statusMessage.value = ''
  },
)

function committedText(key: TextBufferKey): string {
  const current = field.value
  if (!current) return ''
  if (key === 'valueText') return current.visibility.valueText
  return current[key]
}

function textValue(key: TextBufferKey): string {
  return buffer.text[key] ?? committedText(key)
}

function isDirty(): boolean {
  return (
    Object.keys(buffer.text).length > 0 ||
    Object.keys(buffer.optionLabels).length > 0 ||
    Object.keys(buffer.columnLabels).length > 0
  )
}

// --- option rows over `optionsText` (values preserved; §3.4) ----------------

interface OptionRow {
  label: string
  value: string
}

function parseOptionRows(text: string): OptionRow[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':')
      if (separator === -1) return { label: line, value: line }
      return {
        label: line.slice(0, separator).trim(),
        value: line.slice(separator + 1).trim(),
      }
    })
}

function serializeOptionRows(rows: readonly OptionRow[]): string {
  return rows.map((row) => `${row.label}:${row.value}`).join('\n')
}

const optionRows = computed<OptionRow[]>(() =>
  field.value ? parseOptionRows(field.value.optionsText) : [],
)

function optionLabelValue(index: number): string {
  return buffer.optionLabels[index] ?? optionRows.value[index]?.label ?? ''
}

function defaultOptionValue(): string {
  if (props.optionValueFactory) return props.optionValueFactory()
  const bytes = new Uint8Array(8)
  const cryptoApi = (globalThis as { crypto?: Crypto }).crypto
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  let token = ''
  for (let index = 0; index < bytes.length; index += 1) {
    token += bytes[index]!.toString(16).padStart(2, '0')
  }
  return `opt_${token}`
}

// --- command execution ------------------------------------------------------

function runCommand(command: FormFieldInspectorCommand): boolean {
  const result = props.execute(command)
  if (result === null) return false
  if (result.ok) {
    statusMessage.value = ''
    return true
  }
  if (result.reason === 'last_field_removal_forbidden') {
    statusMessage.value = INSPECTOR_LAST_FIELD_MESSAGE
  } else if (result.reason === 'last_detail_column_removal_forbidden') {
    statusMessage.value = INSPECTOR_LAST_DETAIL_COLUMN_MESSAGE
  } else if (result.reason === 'field_type_incompatible_with_references') {
    statusMessage.value = describeDependencyRefusal(
      INSPECTOR_RETYPE_REFUSAL_PREFIX,
      result.dependencies,
    )
  } else if (result.reason === 'field_is_referenced') {
    statusMessage.value = describeDependencyRefusal(
      INSPECTOR_DELETE_REFUSAL_PREFIX,
      result.dependencies,
    )
  } else {
    statusMessage.value = INSPECTOR_GENERIC_RETRY_MESSAGE
  }
  return false
}

function commitPatch(patch: FormFieldPropertyPatch): boolean {
  const current = field.value
  if (!current) return false
  return runCommand({
    kind: 'update-properties',
    localId: current.localId,
    patch,
  })
}

// --- text buffer commit/validation (FB-D7) ----------------------------------

function isRowCountText(value: string): boolean {
  return value.trim() === '' || /^\d+$/.test(value.trim())
}

/** null = valid; otherwise the buffer blocks with values-free copy. */
function bufferValidationError(): string | null {
  const current = field.value
  if (!current) return null
  const label = buffer.text.label
  if (label !== undefined && label.trim() === '') {
    return INSPECTOR_INVALID_BUFFER_MESSAGE
  }
  const minRows = buffer.text.minRowsText ?? current.minRowsText
  const maxRows = buffer.text.maxRowsText ?? current.maxRowsText
  if (
    buffer.text.minRowsText !== undefined ||
    buffer.text.maxRowsText !== undefined
  ) {
    if (!isRowCountText(minRows) || !isRowCountText(maxRows)) {
      return INSPECTOR_INVALID_BUFFER_MESSAGE
    }
    if (
      minRows.trim() !== '' &&
      maxRows.trim() !== '' &&
      Number(minRows.trim()) > Number(maxRows.trim())
    ) {
      return INSPECTOR_INVALID_BUFFER_MESSAGE
    }
  }
  for (const value of Object.values(buffer.optionLabels)) {
    if (value.trim() === '') return INSPECTOR_INVALID_BUFFER_MESSAGE
  }
  for (const value of Object.values(buffer.columnLabels)) {
    if (value.trim() === '') return INSPECTOR_INVALID_BUFFER_MESSAGE
  }
  return null
}

function onTextInput(key: TextBufferKey, event: Event): void {
  // Buffer only — NEVER a command per keystroke (FB-D7).
  buffer.text = {
    ...buffer.text,
    [key]: (event.target as HTMLInputElement).value,
  }
}

function textPatchFor(
  key: TextBufferKey,
  value: string,
  current: FieldAuthoringDraft,
): FormFieldPropertyPatch {
  if (key === 'valueText') {
    return { visibility: { ...current.visibility, valueText: value } }
  }
  return { [key]: value }
}

function commitTextBuffer(key: TextBufferKey): void {
  const current = field.value
  if (!current) return
  const value = buffer.text[key]
  if (value === undefined) return
  if (value === committedText(key)) {
    // Value-identical buffer: drop it without a command (zero history).
    const { [key]: _dropped, ...rest } = buffer.text
    buffer.text = rest
    return
  }
  const error = keyBlocksCommit(key) ? bufferValidationError() : null
  if (error) {
    statusMessage.value = error
    return
  }
  if (commitPatch(textPatchFor(key, value, current))) {
    const { [key]: _committed, ...rest } = buffer.text
    buffer.text = rest
  }
}

function keyBlocksCommit(key: TextBufferKey): boolean {
  return key === 'label' || key === 'minRowsText' || key === 'maxRowsText'
}

// --- select/toggle commits (commit on change) -------------------------------

function onTypeChange(event: Event): void {
  const current = field.value
  if (!current) return
  const select = event.target as HTMLSelectElement
  const nextType = select.value as FormFieldType
  if (nextType === current.type) return
  const committed = runCommand({
    kind: 'retype',
    localId: current.localId,
    nextType,
  })
  if (!committed) {
    // Rejection = zero mutation; snap the control back to the real type.
    select.value = current.type
  }
}

function onRequiredChange(event: Event): void {
  const current = field.value
  if (!current) return
  const checked = (event.target as HTMLInputElement).checked
  if (!commitPatch({ required: checked })) {
    ;(event.target as HTMLInputElement).checked = current.required
  }
}

function onVisibilityDependsChange(event: Event): void {
  const current = field.value
  if (!current) return
  const value = (event.target as HTMLSelectElement).value
  const visibility: FieldVisibilityDraft = value
    ? { ...current.visibility, dependsOnFieldId: value }
    : { dependsOnFieldId: '', operator: 'eq', valueText: '' }
  if (!commitPatch({ visibility })) {
    ;(event.target as HTMLSelectElement).value =
      current.visibility.dependsOnFieldId
  }
}

function onVisibilityOperatorChange(event: Event): void {
  const current = field.value
  if (!current) return
  const value = (event.target as HTMLSelectElement)
    .value as FieldVisibilityDraft['operator']
  if (!commitPatch({ visibility: { ...current.visibility, operator: value } })) {
    ;(event.target as HTMLSelectElement).value = current.visibility.operator
  }
}

// --- option row actions (one logical action = one commit) -------------------

function onOptionLabelInput(index: number, event: Event): void {
  buffer.optionLabels = {
    ...buffer.optionLabels,
    [index]: (event.target as HTMLInputElement).value,
  }
}

function commitOptionLabel(index: number): void {
  const current = field.value
  if (!current) return
  const value = buffer.optionLabels[index]
  if (value === undefined) return
  const rows = optionRows.value
  if (value === rows[index]?.label) {
    const { [index]: _dropped, ...rest } = buffer.optionLabels
    buffer.optionLabels = rest
    return
  }
  if (value.trim() === '') {
    statusMessage.value = INSPECTOR_INVALID_BUFFER_MESSAGE
    return
  }
  // Value PRESERVED: only the label changes; the hand-authored/generated
  // value is never regenerated (§3.4).
  const next = rows.map((row, rowIndex) =>
    rowIndex === index ? { label: value.trim(), value: row.value } : row,
  )
  if (commitPatch({ optionsText: serializeOptionRows(next) })) {
    const { [index]: _committed, ...rest } = buffer.optionLabels
    buffer.optionLabels = rest
  }
}

function addOption(): void {
  const current = field.value
  if (!current) return
  const rows = optionRows.value
  const next = [
    ...rows,
    { label: `选项 ${rows.length + 1}`, value: defaultOptionValue() },
  ]
  commitPatch({ optionsText: serializeOptionRows(next) })
}

function removeOption(index: number): void {
  const current = field.value
  if (!current) return
  const next = optionRows.value.filter((_row, rowIndex) => rowIndex !== index)
  commitPatch({ optionsText: serializeOptionRows(next) })
}

// --- detail column actions --------------------------------------------------

function columnLabelValue(column: DetailColumnDraft): string {
  return buffer.columnLabels[column.localId] ?? column.label
}

function onColumnLabelInput(columnLocalId: string, event: Event): void {
  buffer.columnLabels = {
    ...buffer.columnLabels,
    [columnLocalId]: (event.target as HTMLInputElement).value,
  }
}

function commitColumnLabel(columnLocalId: string): void {
  const current = field.value
  if (!current) return
  const value = buffer.columnLabels[columnLocalId]
  if (value === undefined) return
  const column = current.detailColumns.find(
    (candidate) => candidate.localId === columnLocalId,
  )
  if (!column || value === column.label) {
    const { [columnLocalId]: _dropped, ...rest } = buffer.columnLabels
    buffer.columnLabels = rest
    return
  }
  if (value.trim() === '') {
    statusMessage.value = INSPECTOR_INVALID_BUFFER_MESSAGE
    return
  }
  const committed = runCommand({
    kind: 'update-detail-column',
    fieldLocalId: current.localId,
    columnLocalId,
    patch: { label: value },
  })
  if (committed) {
    const { [columnLocalId]: _committed, ...rest } = buffer.columnLabels
    buffer.columnLabels = rest
  }
}

function onColumnTypeChange(columnLocalId: string, event: Event): void {
  const current = field.value
  if (!current) return
  const select = event.target as HTMLSelectElement
  const column = current.detailColumns.find(
    (candidate) => candidate.localId === columnLocalId,
  )
  if (!column) return
  const nextType = select.value as FormFieldType
  if (nextType === column.type) return
  const committed = runCommand({
    kind: 'retype-detail-column',
    fieldLocalId: current.localId,
    columnLocalId,
    nextType,
  })
  if (!committed) select.value = column.type
}

function onColumnRequiredChange(columnLocalId: string, event: Event): void {
  const current = field.value
  if (!current) return
  const checked = (event.target as HTMLInputElement).checked
  const column = current.detailColumns.find(
    (candidate) => candidate.localId === columnLocalId,
  )
  const committed = runCommand({
    kind: 'update-detail-column',
    fieldLocalId: current.localId,
    columnLocalId,
    patch: { required: checked },
  })
  if (!committed && column) {
    ;(event.target as HTMLInputElement).checked = column.required
  }
}

function addColumn(): void {
  const current = field.value
  if (!current) return
  runCommand({ kind: 'add-detail-column', fieldLocalId: current.localId })
}

function removeColumn(columnLocalId: string): void {
  const current = field.value
  if (!current) return
  runCommand({
    kind: 'remove-detail-column',
    fieldLocalId: current.localId,
    columnLocalId,
  })
}

// --- delete field -----------------------------------------------------------

function removeSelectedField(): void {
  const current = field.value
  if (!current) return
  runCommand({ kind: 'remove-field', localId: current.localId })
}

// --- selection-switch settlement (FB-D7) ------------------------------------

/**
 * Commit one valid dirty buffer as ONE history entry, or block (false) on an
 * invalid buffer with values-free copy. Never silently discards edits.
 */
function settlePendingEdits(): boolean {
  const current = field.value
  if (!current || !isDirty()) return true
  const error = bufferValidationError()
  if (error) {
    statusMessage.value = error
    return false
  }

  // All dirty FIELD-LEVEL buffers combine into ONE update-properties command
  // (one history entry). Dirty option labels fold into the same optionsText
  // patch; visibility valueText folds into the same visibility patch.
  const patch: {
    label?: string
    placeholder?: string
    optionsText?: string
    minRowsText?: string
    maxRowsText?: string
    visibility?: FieldVisibilityDraft
  } = {}
  if (buffer.text.label !== undefined && buffer.text.label !== current.label) {
    patch.label = buffer.text.label
  }
  if (
    buffer.text.placeholder !== undefined &&
    buffer.text.placeholder !== current.placeholder
  ) {
    patch.placeholder = buffer.text.placeholder
  }
  if (
    buffer.text.minRowsText !== undefined &&
    buffer.text.minRowsText !== current.minRowsText
  ) {
    patch.minRowsText = buffer.text.minRowsText
  }
  if (
    buffer.text.maxRowsText !== undefined &&
    buffer.text.maxRowsText !== current.maxRowsText
  ) {
    patch.maxRowsText = buffer.text.maxRowsText
  }
  if (
    buffer.text.valueText !== undefined &&
    buffer.text.valueText !== current.visibility.valueText
  ) {
    patch.visibility = {
      ...current.visibility,
      valueText: buffer.text.valueText,
    }
  }
  const dirtyOptionEntries = Object.entries(buffer.optionLabels)
  if (dirtyOptionEntries.length > 0) {
    const rows = optionRows.value.map((row, rowIndex) => {
      const pending = buffer.optionLabels[rowIndex]
      return pending !== undefined && pending !== row.label
        ? { label: pending.trim(), value: row.value }
        : row
    })
    const nextText = serializeOptionRows(rows)
    if (nextText !== current.optionsText) patch.optionsText = nextText
  }
  if (Object.keys(patch).length > 0 && !commitPatch(patch)) return false

  // Dirty COLUMN labels are separate logical edits (one command each; in
  // practice blur commits them before a switch, so at most one is pending).
  for (const [columnLocalId, pending] of Object.entries(buffer.columnLabels)) {
    const column = field.value?.detailColumns.find(
      (candidate) => candidate.localId === columnLocalId,
    )
    if (!column || pending === column.label) continue
    const committed = runCommand({
      kind: 'update-detail-column',
      fieldLocalId: current.localId,
      columnLocalId,
      patch: { label: pending },
    })
    if (!committed) return false
  }

  clearBuffer()
  statusMessage.value = ''
  return true
}

defineExpose({ settlePendingEdits, isDirty })
</script>

<style scoped>
.approval-form-field-inspector {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 16px;
  background: var(--el-fill-color-lighter);
  border-radius: 12px;
}

.approval-form-field-inspector__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.approval-form-field-inspector__empty {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.approval-form-field-inspector__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.approval-form-field-inspector__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.approval-form-field-inspector__row--inline {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  min-height: 40px;
}

.approval-form-field-inspector__label {
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.approval-form-field-inspector__hint {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.approval-form-field-inspector__control {
  min-height: 40px;
  padding: 4px 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-size: 13px;
}

.approval-form-field-inspector__control--narrow {
  max-width: 140px;
}

.approval-form-field-inspector__control:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}

.approval-form-field-inspector__section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.approval-form-field-inspector__option-row,
.approval-form-field-inspector__column-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.approval-form-field-inspector__option-row .approval-form-field-inspector__control,
.approval-form-field-inspector__column-row .approval-form-field-inspector__control {
  flex: 1;
  min-width: 120px;
}

.approval-form-field-inspector__minor-action {
  min-height: 40px;
  min-width: 40px;
  padding: 4px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);
  color: var(--el-text-color-regular);
  font-size: 12px;
  cursor: pointer;
}

.approval-form-field-inspector__minor-action:hover,
.approval-form-field-inspector__minor-action:focus-visible {
  border-color: var(--el-color-primary-light-5);
  color: var(--el-color-primary);
}

.approval-form-field-inspector__minor-action:focus-visible,
.approval-form-field-inspector__danger-action:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.approval-form-field-inspector__reference-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.approval-form-field-inspector__actions {
  display: flex;
  justify-content: flex-start;
  padding-top: 8px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.approval-form-field-inspector__danger-action {
  min-height: 40px;
  padding: 4px 12px;
  border: 1px solid var(--el-color-danger);
  border-radius: 6px;
  background: var(--el-bg-color);
  color: var(--el-color-danger);
  font-size: 12px;
  cursor: pointer;
}

.approval-form-field-inspector__status {
  min-height: 18px;
  margin: 0;
  font-size: 12px;
  color: var(--el-color-danger);
}
</style>
