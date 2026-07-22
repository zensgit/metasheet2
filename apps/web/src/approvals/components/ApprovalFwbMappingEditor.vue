<script lang="ts">
/** Confirmation lifecycle the PARENT owns (server-confirmed state machine). */
export type FwbMappingConfirmationState = 'unconfirmed' | 'confirming' | 'confirmed'
</script>

<script setup lang="ts">
// FWB create-mode mapping editor — a bounded, reusable UI shell over the FWB-1 authoring
// contract in `../fwbMappingConfig` (#4515/#4516). Production mounting and the server
// confirmation round-trip are later slices; this component deliberately:
//   - re-validates the WHOLE draft via validateFwbMappingConfig on every render (fail-closed
//     allowlist — the editor is UX, not the security boundary);
//   - NEVER generates, stores, or accepts a confirmationHash — the parent/server owns the
//     hash; this shell only knows the three confirmation STATES and asks for confirmation
//     (`request-confirmation`) when the draft validates;
//   - emits `invalidate-confirmation` on EVERY mapping mutation, so an edit after `confirmed`
//     immediately tears down the parent's confirmed state;
//   - keeps exact-number mappings unavailable: number targets are never offered for NEW
//     mappings, and a LOADED number mapping stays visible with a blocked reason instead of
//     being silently dropped (same treatment for unsupported types and option-less selects);
//   - keeps stale/unknown loaded field ids losslessly: the id survives only as the option
//     VALUE (round-trip), while the user-facing label is a generic localized
//     "Unavailable field" marker — never a blank select, never the raw id as the only label.
import { computed } from 'vue'
import { Delete, Plus } from '@element-plus/icons-vue'
import {
  toExecutorMappings,
  validateFwbMappingConfig,
  type FwbConfigIssue,
  type FwbMappingDraft,
  type TargetFieldInfo,
  type TemplateFieldInfo,
} from '../fwbMappingConfig'

type FwbConfirmationMapping = ReturnType<typeof toExecutorMappings>[number]

const props = withDefaults(defineProps<{
  templateFields: readonly TemplateFieldInfo[]
  targetFields: readonly TargetFieldInfo[]
  modelValue: readonly FwbMappingDraft[]
  disabled?: boolean
  loading?: boolean
  /** Bilingual chrome: zh labels when true, en otherwise. */
  isZh?: boolean
  confirmationState?: FwbMappingConfirmationState
}>(), {
  disabled: false,
  loading: false,
  isZh: true,
  confirmationState: 'unconfirmed',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: FwbMappingDraft[]): void
  /** Fired ONLY when the whole draft validates; payload is the executor-shaped mappings. */
  (e: 'request-confirmation', value: FwbConfirmationMapping[]): void
  /** Fired on every mapping mutation so the parent drops any confirmed state/hash. */
  (e: 'invalidate-confirmation'): void
}>()

const LABELS = {
  formField: { zh: '表单字段', en: 'Form field' },
  targetField: { zh: '目标字段', en: 'Target field' },
  addMapping: { zh: '添加映射', en: 'Add mapping' },
  removeMapping: { zh: '移除映射', en: 'Remove mapping' },
  confirm: { zh: '请求确认', en: 'Request confirmation' },
  unconfirmed: { zh: '未确认', en: 'Unconfirmed' },
  confirming: { zh: '确认中…', en: 'Confirming…' },
  confirmed: { zh: '已确认', en: 'Confirmed' },
  unavailableField: { zh: '不可用字段', en: 'Unavailable field' },
  emptyConfig: { zh: '至少需要一条映射', en: 'Add at least one mapping' },
  selectFormField: { zh: '请选择表单字段', en: 'Select a form field' },
  selectTargetField: { zh: '请选择目标字段', en: 'Select a target field' },
  unknownFormField: { zh: '表单字段已失效', en: 'Form field is no longer available' },
  unknownTargetField: { zh: '目标字段已失效', en: 'Target field is no longer available' },
  unsupportedType: { zh: '目标字段类型不支持', en: 'Unsupported target field type' },
  numberUnavailable: { zh: '数值字段暂不支持精确映射', en: 'Exact number mapping is not available yet' },
  selectNoOptions: { zh: '目标选项字段缺少可选值', en: 'Target select field has no options' },
  duplicateTarget: { zh: '目标字段重复', en: 'Duplicate target field' },
} as const

type LabelKey = keyof typeof LABELS

function t(key: LabelKey): string {
  return props.isZh ? LABELS[key].zh : LABELS[key].en
}

const controlsDisabled = computed(() => props.disabled || props.loading)

// Whole-draft validation — the single source of truth for what blocks confirmation.
const issues = computed<FwbConfigIssue[]>(() =>
  validateFwbMappingConfig(props.modelValue, props.templateFields, props.targetFields),
)

const globalReasons = computed<string[]>(() =>
  issues.value.filter((issue) => issue.code === 'empty_config').map(() => t('emptyConfig')),
)

function issueLabel(code: FwbConfigIssue['code']): string {
  switch (code) {
    case 'unknown_form_field': return t('unknownFormField')
    case 'unknown_target_field': return t('unknownTargetField')
    case 'unsupported_target_type': return t('unsupportedType')
    case 'exact_number_mapping_unavailable': return t('numberUnavailable')
    case 'select_options_missing': return t('selectNoOptions')
    case 'duplicate_target': return t('duplicateTarget')
    case 'empty_config': return t('emptyConfig')
  }
}

/** Compact per-row block reasons; empty (not-yet-picked) selects get a friendlier prompt. */
function rowReasons(index: number): string[] {
  const row = props.modelValue[index]
  const reasons: string[] = []
  if (row) {
    if (!row.formFieldId) reasons.push(t('selectFormField'))
    if (!row.targetFieldId) reasons.push(t('selectTargetField'))
  }
  for (const issue of issues.value) {
    if (!('index' in issue) || issue.index !== index) continue
    if (issue.code === 'unknown_form_field' && row && !row.formFieldId) continue
    if (issue.code === 'unknown_target_field' && row && !row.targetFieldId) continue
    reasons.push(issueLabel(issue.code))
  }
  return reasons
}

interface SelectOption {
  value: string
  label: string
  disabled: boolean
}

function formOptions(row: FwbMappingDraft): SelectOption[] {
  const options: SelectOption[] = props.templateFields.map((f) => ({ value: f.id, label: f.label, disabled: false }))
  if (row.formFieldId && !props.templateFields.some((f) => f.id === row.formFieldId)) {
    // Stale loaded id: lossless value, generic marker label (never the raw id alone).
    options.push({ value: row.formFieldId, label: t('unavailableField'), disabled: true })
  }
  return options
}

type NormalizedTargetType = 'text' | 'number' | 'date' | 'select' | null

function normalizeTargetType(type: string): NormalizedTargetType {
  if (type === 'string' || type === 'text') return 'text'
  if (type === 'number' || type === 'date' || type === 'select') return type
  return null
}

function targetOptions(row: FwbMappingDraft, rowIndex: number): SelectOption[] {
  const options: SelectOption[] = []
  for (const field of props.targetFields) {
    const normalized = normalizeTargetType(field.type)
    const isCurrentValue = row.targetFieldId === field.id
    const isHeldByAnotherRow = props.modelValue.some(
      (mapping, index) => index !== rowIndex && mapping.targetFieldId === field.id,
    )
    if (normalized === 'text' || normalized === 'date') {
      options.push({ value: field.id, label: field.label, disabled: isHeldByAnotherRow })
    } else if (normalized === 'select') {
      const hasOptions = !!field.selectOptions && field.selectOptions.length > 0
      options.push(hasOptions
        ? { value: field.id, label: field.label, disabled: isHeldByAnotherRow }
        : { value: field.id, label: `${field.label}（${t('selectNoOptions')}）`, disabled: true })
    } else if (isCurrentValue) {
      // number / unsupported: never offered for NEW mappings — only kept visible (disabled,
      // with a blocked reason) when a LOADED mapping already points at it.
      const reason = normalized === 'number' ? t('numberUnavailable') : t('unsupportedType')
      options.push({ value: field.id, label: `${field.label}（${reason}）`, disabled: true })
    }
  }
  if (row.targetFieldId && !props.targetFields.some((f) => f.id === row.targetFieldId)) {
    options.push({ value: row.targetFieldId, label: t('unavailableField'), disabled: true })
  }
  return options
}

const stateLabel = computed(() => t(props.confirmationState))

const confirmDisabled = computed(() =>
  controlsDisabled.value || props.confirmationState !== 'unconfirmed' || issues.value.length > 0,
)

function emitDraft(next: FwbMappingDraft[]): void {
  emit('update:modelValue', next)
  // Any mutation — including one made while `confirmed` — invalidates confirmation immediately.
  emit('invalidate-confirmation')
}

function addRow(): void {
  if (controlsDisabled.value) return
  emitDraft([...props.modelValue, { formFieldId: '', targetFieldId: '' }])
}

function removeRow(index: number): void {
  if (controlsDisabled.value) return
  emitDraft(props.modelValue.filter((_, i) => i !== index))
}

function setFormField(index: number, value: unknown): void {
  if (controlsDisabled.value) return
  const id = typeof value === 'string' ? value : ''
  emitDraft(props.modelValue.map((m, i) => (i === index ? { ...m, formFieldId: id } : m)))
}

function setTargetField(index: number, value: unknown): void {
  if (controlsDisabled.value) return
  const id = typeof value === 'string' ? value : ''
  emitDraft(props.modelValue.map((m, i) => (i === index ? { ...m, targetFieldId: id } : m)))
}

function requestConfirmation(): void {
  if (controlsDisabled.value || props.confirmationState !== 'unconfirmed') return
  // Fail-closed: ask for confirmation ONLY when the whole draft validates. The parent/server
  // owns the confirmationHash — this component never sees one.
  if (issues.value.length > 0) return
  emit('request-confirmation', toExecutorMappings(props.modelValue, props.targetFields))
}
</script>

<template>
  <div class="fwb-mapping-editor" data-testid="approval-fwb-mapping-editor">
    <div v-if="modelValue.length > 0" class="fwb-mapping-editor__head">
      <span class="fwb-mapping-editor__col-label">{{ t('formField') }}</span>
      <span class="fwb-mapping-editor__col-label">{{ t('targetField') }}</span>
      <span class="fwb-mapping-editor__col-spacer" />
    </div>

    <div
      v-for="(row, index) in modelValue"
      :key="index"
      class="fwb-mapping-editor__row"
      data-testid="fwb-mapping-row"
      :data-row-index="index"
    >
      <el-select
        class="fwb-mapping-editor__select fwb-mapping-editor__select--form"
        size="small"
        :model-value="row.formFieldId || undefined"
        :placeholder="t('formField')"
        :disabled="controlsDisabled"
        data-testid="fwb-form-field-select"
        @update:model-value="setFormField(index, $event)"
      >
        <el-option
          v-for="option in formOptions(row)"
          :key="option.value"
          :label="option.label"
          :value="option.value"
          :data-value="option.value"
          :disabled="option.disabled"
        />
      </el-select>

      <el-select
        class="fwb-mapping-editor__select fwb-mapping-editor__select--target"
        size="small"
        :model-value="row.targetFieldId || undefined"
        :placeholder="t('targetField')"
        :disabled="controlsDisabled"
        data-testid="fwb-target-field-select"
        @update:model-value="setTargetField(index, $event)"
      >
        <el-option
          v-for="option in targetOptions(row, index)"
          :key="option.value"
          :label="option.label"
          :value="option.value"
          :data-value="option.value"
          :disabled="option.disabled"
        />
      </el-select>

      <el-button
        class="fwb-mapping-editor__icon-btn"
        size="small"
        text
        type="danger"
        :disabled="controlsDisabled"
        :aria-label="t('removeMapping')"
        :title="t('removeMapping')"
        data-testid="fwb-remove-mapping"
        @click="removeRow(index)"
      >
        <el-icon><Delete /></el-icon>
      </el-button>

      <p
        v-if="rowReasons(index).length > 0"
        class="fwb-mapping-editor__row-issues"
        data-testid="fwb-row-issues"
      >{{ rowReasons(index).join('；') }}</p>
    </div>

    <div class="fwb-mapping-editor__footer">
      <el-button
        size="small"
        :disabled="controlsDisabled"
        :aria-label="t('addMapping')"
        :title="t('addMapping')"
        data-testid="fwb-add-mapping"
        @click="addRow"
      >
        <el-icon><Plus /></el-icon>
        <span>{{ t('addMapping') }}</span>
      </el-button>

      <span
        class="fwb-mapping-editor__state"
        :class="`fwb-mapping-editor__state--${confirmationState}`"
        :data-state="confirmationState"
        data-testid="fwb-confirmation-state"
      >{{ stateLabel }}</span>

      <el-button
        size="small"
        type="primary"
        :disabled="confirmDisabled"
        data-testid="fwb-request-confirmation"
        @click="requestConfirmation"
      >{{ t('confirm') }}</el-button>
    </div>

    <p
      v-if="globalReasons.length > 0"
      class="fwb-mapping-editor__global-issues"
      data-testid="fwb-global-issues"
    >{{ globalReasons.join('；') }}</p>
  </div>
</template>

<style scoped>
.fwb-mapping-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.fwb-mapping-editor__head,
.fwb-mapping-editor__row {
  display: grid;
  /* Stable dimensions: both field columns share width and shrink without wrapping. */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 32px;
  gap: 8px;
  align-items: center;
}

.fwb-mapping-editor__row {
  min-height: 32px;
}

.fwb-mapping-editor__col-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fwb-mapping-editor__select {
  width: 100%;
  min-width: 0;
}

.fwb-mapping-editor__icon-btn {
  justify-self: end;
}

.fwb-mapping-editor__row-issues {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--el-color-danger);
  overflow: hidden;
  text-overflow: ellipsis;
}

.fwb-mapping-editor__footer {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.fwb-mapping-editor__state {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.fwb-mapping-editor__state--confirmed {
  color: var(--el-color-success);
}

.fwb-mapping-editor__state--confirming {
  color: var(--el-color-warning);
}

.fwb-mapping-editor__global-issues {
  margin: 0;
  font-size: 12px;
  color: var(--el-color-danger);
}

/* Responsive: stack the two field columns on narrow widths, keep the remove button beside
   the target field; the header row is redundant once stacked. */
@media (max-width: 640px) {
  .fwb-mapping-editor__head {
    display: none;
  }

  .fwb-mapping-editor__row {
    grid-template-columns: minmax(0, 1fr) 32px;
  }

  .fwb-mapping-editor__select--form {
    grid-column: 1 / -1;
  }
}
</style>
