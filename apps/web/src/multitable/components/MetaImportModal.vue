<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-import-overlay" @click.self="requestClose">
      <div class="meta-import-modal">
        <div class="meta-import__header">
          <strong>{{ l('import.title') }}</strong>
          <button class="meta-import__close" @click="requestClose">&times;</button>
        </div>

        <div v-if="step === 'paste'" class="meta-import__body">
          <div v-if="restoredDraft" class="meta-import__warning">
            <span>{{ l('import.recoveredDraft') }}</span>
          </div>
          <p class="meta-import__hint">{{ l('import.pasteHint') }}</p>
          <label class="meta-import__file-drop" @dragover.prevent @drop.prevent="onFileDrop">
            <input
              class="meta-import__file-input"
              type="file"
              accept=".csv,text/csv,.tsv,text/tab-separated-values,.txt,text/plain,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xls,application/vnd.ms-excel"
              @change="onFileSelect"
            />
            <span>{{ l('import.fileDrop') }}</span>
          </label>
          <textarea
            ref="textareaRef"
            class="meta-import__textarea"
            :placeholder="l('import.textareaPlaceholder')"
            :value="rawText"
            @input="rawText = ($event.target as HTMLTextAreaElement).value"
          ></textarea>
          <div v-if="parseError" class="meta-import__error">{{ parseError }}</div>
          <div class="meta-import__actions">
            <button class="meta-import__btn" :disabled="isImporting" @click="requestClose">{{ l('import.cancel') }}</button>
            <button class="meta-import__btn meta-import__btn--primary" :disabled="!rawText.trim()" @click="parseAndPreview">{{ l('import.preview') }}</button>
          </div>
        </div>

        <div v-else-if="step === 'preview'" class="meta-import__body">
          <div v-if="restoredDraft" class="meta-import__warning">
            <span>{{ l('import.recoveredDraft') }}</span>
          </div>
          <div v-if="createFieldsDropped" class="meta-import__warning meta-import__create-dropped">
            <span>{{ l('import.createFieldsDropped') }}</span>
          </div>
          <div v-if="parseWarning" class="meta-import__warning">
            <span>{{ parseWarning }}</span>
          </div>
          <p class="meta-import__hint">{{ detectedRows(parsedRows.length, isZh) }}</p>
          <div v-if="hasImportDraftIssues" class="meta-import__warning">
            <span>{{ importDraftIssueText }}</span>
            <button class="meta-import__btn-inline" @click="reconcileImportDraft">{{ l('import.reconcileDraft') }}</button>
          </div>
          <div class="meta-import__mapping">
            <div v-for="(header, i) in parsedHeaders" :key="i" class="meta-import__map-row">
              <span class="meta-import__col-name">{{ header }}</span>
              <span class="meta-import__arrow">&rarr;</span>
              <select class="meta-import__field-select" :value="fieldMapping[i] ?? ''" @change="fieldMapping[i] = ($event.target as HTMLSelectElement).value">
                <option value="">{{ l('import.skip') }}</option>
                <option v-for="f in importableFields" :key="f.id" :value="f.id">{{ f.name }}</option>
                <option v-if="canOfferCreateField(header)" :value="CREATE_FIELD_SENTINEL">{{ createFieldOption(plannedCreateFieldName(header), isZh) }}</option>
              </select>
            </div>
          </div>
          <p v-if="createFieldRequests.length" class="meta-import__hint meta-import__create-summary">
            {{ createFieldsPlanned(createFieldRequests.length, isZh) }}
          </p>
          <p v-if="skippedColumnCount > 0" class="meta-import__hint meta-import__skip-summary">
            {{ columnsSkippedNoField(skippedColumnCount, isZh) }}
          </p>
          <p v-if="existingFieldSkippedColumnCount > 0" class="meta-import__hint meta-import__existing-skip-summary">
            {{ columnsSkippedExistingField(existingFieldSkippedColumnCount, isZh) }}
          </p>
          <div v-if="createFieldsErrorText" class="meta-import__error meta-import__create-error">{{ createFieldsErrorText }}</div>
          <div v-if="parsedRows.length" class="meta-import__preview-table">
            <table>
              <thead><tr><th v-for="(h, i) in parsedHeaders" :key="i">{{ h }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, ri) in parsedRows.slice(0, 5)" :key="ri">
                  <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
                </tr>
                <tr v-if="parsedRows.length > 5"><td :colspan="parsedHeaders.length" class="meta-import__more">{{ moreRows(parsedRows.length - 5, isZh) }}</td></tr>
              </tbody>
            </table>
          </div>
          <div class="meta-import__actions">
            <button class="meta-import__btn" :disabled="isImporting" @click="goBackToPaste">{{ l('import.back') }}</button>
            <button class="meta-import__btn meta-import__btn--primary" :disabled="!canImportPreview" @click="doImport">
              {{ importRecords(parsedRows.length, isZh) }}
            </button>
          </div>
        </div>

        <div v-else-if="step === 'importing'" class="meta-import__body meta-import__importing">
          <div class="meta-import__spinner"></div>
          <p>{{ importingRecords(pendingRecordCount, isZh) }}</p>
          <div class="meta-import__actions meta-import__actions--center">
            <button class="meta-import__btn" @click="requestClose">{{ l('import.cancelImport') }}</button>
          </div>
        </div>

        <div v-else class="meta-import__body">
          <div class="meta-import__result" :class="hasImportWarnings ? 'meta-import__result--warning' : 'meta-import__result--success'">
            <strong>{{ resultSummaryText }}</strong>
            <p v-if="hasFailedImports">
              <template v-if="retryableFailureCount > 0">
                {{ l('import.failedReviewRetry') }}
              </template>
              <template v-else>
                {{ l('import.failedReviewMapping') }}
              </template>
            </p>
            <p v-else-if="hasSkippedImports">
              {{ l('import.skippedDuplicates') }}
            </p>
            <p v-else>{{ l('import.success') }}</p>
          </div>
          <div v-if="hasImportDraftIssues" class="meta-import__warning">
            <span>{{ importDraftIssueText }}</span>
            <button class="meta-import__btn-inline" @click="reconcileImportDraft">{{ l('import.reconcileDraft') }}</button>
          </div>
          <div v-if="failedPreviewRows.length" class="meta-import__failures">
            <div v-for="failure in failedPreviewRows" :key="`${failure.originalIndex}:${failure.fieldId ?? 'row'}`" class="meta-import__failure">
              <div class="meta-import__failure-head">
                <strong>{{ rowLabel(failure.rowNumber, isZh) }}</strong>
                <span>{{ failure.message }}</span>
              </div>
              <div class="meta-import__failure-row">{{ failure.values.join(' | ') || l('import.emptyRow') }}</div>
            </div>
            <div v-if="remainingFailedCount > 0" class="meta-import__more">
              {{ moreFailedRows(remainingFailedCount, isZh) }}
            </div>
          </div>
          <div v-if="manualFixRows.length" class="meta-import__fixes">
            <div v-for="failure in manualFixRows" :key="`${failure.rowIndex}:${failure.fieldId ?? 'row'}`" class="meta-import__fix">
              <div class="meta-import__failure-head">
                <strong>{{ fixRowLabel(failure.rowNumber, isZh) }}</strong>
                <span>{{ failure.message }}</span>
              </div>
              <div class="meta-import__fix-grid">
                <label
                  v-for="(cell, ci) in failure.values"
                  :key="`${failure.rowIndex}:${ci}`"
                  class="meta-import__fix-cell"
                  :class="{ 'meta-import__fix-cell--problem': failure.problemColumnIndexes.includes(ci) }"
                >
                  <span>{{ parsedHeaders[ci] || columnLabel(ci, isZh) }}</span>
                  <input class="meta-import__fix-input" :value="cell" @input="updateFailedCell(failure.rowIndex, ci, ($event.target as HTMLInputElement).value)" />
                </label>
              </div>
              <div v-if="failure.showPeopleHint" class="meta-import__fix-hint">
                {{ l('import.peopleExactHint') }}
              </div>
              <div v-if="failure.canUsePicker" class="meta-import__fix-picker-row">
                <button class="meta-import__btn meta-import__btn--primary" @click="openPickerForFailure(failure)">
                  {{ failure.pickerButtonLabel }}
                </button>
                <div v-if="failure.selectedSummaries.length" class="meta-import__fix-selected">
                  {{ failure.selectedSummaries.map((item) => item.display || item.id).join(', ') }}
                </div>
              </div>
            </div>
          </div>
          <div class="meta-import__actions">
            <button class="meta-import__btn" :disabled="isImporting" @click="goBackToPreview">{{ l('import.backToMapping') }}</button>
            <button v-if="hasFailedImports && retryableFailureCount > 0" class="meta-import__btn meta-import__btn--primary" :disabled="!canRetryFailedRows" @click="retryFailedRows">
              {{ l('import.retryFailedRows') }}
            </button>
            <button v-if="manualFixRows.length" class="meta-import__btn meta-import__btn--primary" :disabled="!canApplyFixes" @click="applyFixesAndRetry">
              {{ l('import.applyFixes') }}
            </button>
            <button class="meta-import__btn" :disabled="isImporting" @click="requestClose">{{ l('import.close') }}</button>
          </div>
        </div>
      </div>
    </div>
    <MetaLinkPicker
      :visible="pickerVisible"
      :field="pickerField"
      :current-value="pickerCurrentValue"
      :initial-search="pickerInitialSearch"
      @close="closePicker"
      @confirm="onPickerConfirm"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import MetaLinkPicker from './MetaLinkPicker.vue'
import { useLocale } from '../../composables/useLocale'
import type { LinkedRecordSummary, MetaField } from '../types'
import { buildImportedRecords, parseDelimitedText } from '../import/delimited'
import type { ImportBuildFailure, ImportBuildResult, ImportFieldOverrides, ImportValueResolver } from '../import/delimited'
import { XLSX_MAX_BYTES, XLSX_MAX_ROWS, mapXlsxColumnsToFields, parseXlsxBuffer } from '../import/xlsx-mapping'
import {
  CREATE_FIELD_SENTINEL,
  createFieldPlaceholderId,
  planCreateFieldNames,
  type ImportCreateFieldRequest,
  type ImportSubmitPayload,
} from '../import/create-fields'
import { isLinkField, isPersonField, linkActionLabel } from '../utils/link-fields'
import {
  columnLabel,
  columnsSkippedExistingField,
  columnsSkippedNoField,
  createFieldOption,
  createFieldsPlanned,
  detectedRows,
  fieldNoLongerImportable,
  fileTooLarge,
  fixRowLabel,
  importComplete,
  importLabel,
  importRecords,
  importResultSummary,
  importingRecords,
  manualRepairFieldRemoved,
  mappedFieldRemoved,
  moreDraftIssues,
  moreFailedRows,
  moreRows,
  rowLabel,
  selectedRepairInvalid,
  xlsxTruncated,
} from '../utils/meta-import-labels'

type ImportResultFailure = ImportBuildFailure & {
  index?: number
  rowIndex: number
  retryable?: boolean
  skipped?: boolean
}

type ImportResult = {
  attempted: number
  succeeded: number
  failed: number
  skipped?: number
  firstError: string | null
  failures: ImportResultFailure[]
}

type ImportDraftSnapshot = {
  version: 1
  rawText: string
  parsedHeaders: string[]
  parsedRows: string[][]
  fieldMapping: Record<number, string>
  manualFieldOverrides: ImportFieldOverrides
  manualOverrideSummaries: Record<string, LinkedRecordSummary[]>
  step: 'paste' | 'preview'
}

type ImportDraftIssue = {
  kind: 'mapping-missing' | 'mapping-not-importable' | 'manual-override-invalid'
  fieldId: string
  message: string
}

const props = defineProps<{
  visible: boolean
  sheetId?: string | null
  fields: MetaField[]
  importing?: boolean
  result?: ImportResult | null
  fieldResolvers?: Record<string, ImportValueResolver>
  /**
   * Whether the CALLER may create fields on this sheet (workbench passes `caps.canManageFields`).
   * This modal only offers/defaults the "create new field" mapping when it is true; the actual write
   * is still gated in the workbench AND by the server's 403 on POST /api/multitable/fields.
   */
  canCreateFields?: boolean
  /** Set by the caller when field creation failed — sends the modal back to mapping, no rows written. */
  createFieldsError?: string | null
  /** columnIndex → newly created field id; rebinds the sentinel so a re-import never re-creates it. */
  createdFieldColumns?: Record<number, string> | null
  /**
   * EVERY field name that already exists on the target sheet — including the ones this modal can
   * not map onto (formula/lookup/rollup, readonly, hidden by field permissions), which `fields` has
   * already been filtered past. Used ONLY to answer "is this header missing from the sheet?": with
   * `fields` alone, a header matching a formula column looks missing and would DEFAULT to "create a
   * new field", silently producing an `X (2)` shadow text column (export → re-import round trip).
   * Names only, never values. Falls back to `fields` when the caller does not supply it.
   */
  existingFieldNames?: string[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'cancel-import'): void
  (e: 'import', payload: ImportSubmitPayload): void
  (e: 'update:dirty', dirty: boolean): void
}>()

const { isZh } = useLocale()
const l = (key: Parameters<typeof importLabel>[0]) => importLabel(key, isZh.value)

const step = ref<'paste' | 'preview' | 'importing' | 'result'>('paste')
const rawText = ref('')
const parsedHeaders = ref<string[]>([])
const parsedRows = ref<string[][]>([])
const fieldMapping = ref<Record<number, string>>({})
const pendingRecordCount = ref(0)
const lastAttemptRecords = ref<Array<Record<string, unknown>>>([])
const lastAttemptRowIndexes = ref<number[]>([])
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const parseError = ref('')
const parseWarning = ref('')
const manualFieldOverrides = ref<ImportFieldOverrides>({})
const manualOverrideSummaries = ref<Record<string, LinkedRecordSummary[]>>({})
const pickerTarget = ref<{ rowIndex: number; fieldId: string } | null>(null)
const pickerVisible = ref(false)
const restoredDraft = ref(false)
const createFieldsDropped = ref(false)

const canCreateFields = computed(() => props.canCreateFields === true)
const createFieldsErrorText = computed(() => props.createFieldsError ?? '')
/**
 * A sentinel only counts while the caller still holds manage-fields AND the header is non-empty.
 *
 * The manage-fields half is deliberately REDUNDANT with the `props.canCreateFields` watch below,
 * which already rewrites every sentinel to '' the moment the capability is lost, and with
 * `restoreImportDraft`, which degrades a restored sentinel the same way. No single-guard mutation
 * can turn it red for that reason — it is kept as the fail-closed last line in case a future caller
 * introduces a fourth way for a sentinel to coexist with a missing capability.
 */
function isActiveCreateColumn(columnIndex: number | string): boolean {
  if (!canCreateFields.value) return false
  if (fieldMapping.value[Number(columnIndex)] !== CREATE_FIELD_SENTINEL) return false
  return (parsedHeaders.value[Number(columnIndex)] ?? '').trim().length > 0
}
function canOfferCreateField(header: string): boolean {
  return canCreateFields.value && header.trim().length > 0
}
/**
 * Names of every field that already exists on the sheet, NOT just the importable ones.
 * `props.fields` is the import surface (workbench strips formula/lookup/rollup, readonly and
 * permission-hidden fields before it gets here), so it can not answer "does the sheet already have
 * a column called X?" — `existingFieldNames` can. Fall back to the import surface when the caller
 * predates the prop; the write side (planCreateFieldNames) still de-duplicates either way.
 */
const existingFieldNameKeys = computed(() => {
  const source = props.existingFieldNames ?? props.fields.map((field) => field.name)
  const keys = new Set<string>()
  for (const name of source) {
    const key = String(name ?? '').trim().toLowerCase()
    if (key) keys.add(key)
  }
  return keys
})
const importableFieldNameKeys = computed(() => {
  const keys = new Set<string>()
  for (const field of importableFields.value) {
    const key = String(field.name ?? '').trim().toLowerCase()
    if (key) keys.add(key)
  }
  return keys
})
/**
 * True when the sheet already has a field with this header's name (case-insensitive) that this
 * modal can NOT map onto — formula/lookup/rollup, readonly, or hidden by field permissions.
 *
 * The "and not importable" half matters: two columns that both normalize to one importable field
 * are a different story (the matcher gives the field to the first and the second legitimately wants
 * its own new column), so those must keep defaulting to create.
 */
function headerMatchesUnmappableField(header: string): boolean {
  const key = header.trim().toLowerCase()
  if (!key) return false
  return existingFieldNameKeys.value.has(key) && !importableFieldNameKeys.value.has(key)
}
/**
 * The option label must show the name that would ACTUALLY be created: when the header collides with
 * an existing (unmappable) field the planner suffixes it to `X (2)`, and promising 「X」 there would
 * be a lie. Same planner as the write side, so the two can not drift.
 */
function plannedCreateFieldName(header: string): string {
  const plan = planCreateFieldNames({
    requests: [{ header, columnIndex: 0 }],
    existingNames: [...existingFieldNameKeys.value],
  })
  return plan.ok ? plan.names[0] : header.trim()
}
/**
 * Columns skipped because the sheet ALREADY has a field of that name that this modal can not write
 * into (formula/lookup/rollup, readonly, or hidden by field permissions). Reported separately from
 * `skippedColumnCount` so "the sheet has no such column" and "the sheet has it but it is read-only"
 * do not collapse into one misleading sentence.
 */
const existingFieldSkippedColumnCount = computed(() => parsedHeaders.value.filter((header, index) => {
  if (!header.trim()) return false
  const mapped = fieldMapping.value[index]
  if (mapped && mapped !== CREATE_FIELD_SENTINEL) return false
  if (mapped === CREATE_FIELD_SENTINEL && isActiveCreateColumn(index)) return false
  return headerMatchesUnmappableField(header)
}).length)
const createFieldRequests = computed<ImportCreateFieldRequest[]>(() =>
  Object.keys(fieldMapping.value)
    .map((columnIndex) => Number(columnIndex))
    .filter((columnIndex) => Number.isInteger(columnIndex) && isActiveCreateColumn(columnIndex))
    .sort((a, b) => a - b)
    .map((columnIndex) => ({ columnIndex, header: (parsedHeaders.value[columnIndex] ?? '').trim() })),
)
const skippedColumnCount = computed(() => parsedHeaders.value.filter((header, index) => {
  if (!header.trim()) return false
  // Counted by existingFieldSkippedColumnCount instead — different cause, different sentence.
  if (headerMatchesUnmappableField(header)) return false
  const mapped = fieldMapping.value[index]
  if (!mapped) return true
  return mapped === CREATE_FIELD_SENTINEL && !isActiveCreateColumn(index)
}).length)

const hasMappedFields = computed(() => Object.entries(fieldMapping.value).some(([columnIndex, value]) => {
  if (!value) return false
  if (value === CREATE_FIELD_SENTINEL) return isActiveCreateColumn(columnIndex)
  return true
}))
function isImportReadOnlyField(field: MetaField): boolean {
  const property = field.property ?? {}
  return property.readonly === true || property.readOnly === true
}

const importableFields = computed(() =>
  props.fields.filter((field) =>
    !['formula', 'lookup', 'rollup'].includes(field.type) && !isImportReadOnlyField(field),
  ),
)
const importableFieldIds = computed(() => new Set(importableFields.value.map((field) => field.id)))
const fieldsById = computed(() => new Map(props.fields.map((field) => [field.id, field])))
const hasFailedImports = computed(() => (props.result?.failed ?? 0) > 0)
const hasSkippedImports = computed(() => (props.result?.skipped ?? 0) > 0)
const hasImportWarnings = computed(() => hasFailedImports.value || hasSkippedImports.value)
const isImporting = computed(() => props.importing === true || step.value === 'importing')
const importDraftStorageKey = computed(() => `metasheet:multitable:import-draft:${props.sheetId || 'default'}`)
const retryableFailureCount = computed(() => (props.result?.failures ?? []).filter((failure) => !failure.skipped && failure.retryable !== false).length)
const manualFixRows = computed(() => (props.result?.failures ?? [])
  .filter((failure) => !failure.skipped && failure.retryable === false)
  .map((failure) => {
    const field = typeof failure.fieldId === 'string' ? props.fields.find((candidate) => candidate.id === failure.fieldId) ?? null : null
    const problemColumnIndexes = typeof failure.fieldId === 'string'
      ? Object.entries(fieldMapping.value).filter(([, mappedFieldId]) => mappedFieldId === failure.fieldId).map(([columnIndex]) => Number(columnIndex))
      : []
    const key = failure.fieldId ? overrideKey(failure.rowIndex, failure.fieldId) : null
    const selectedSummaries = key ? (manualOverrideSummaries.value[key] ?? []) : []
    return {
      ...failure,
      rowNumber: failure.rowIndex + 2,
      values: [...(parsedRows.value[failure.rowIndex] ?? [])],
      problemColumnIndexes,
      problemField: field,
      showPeopleHint: !!field && isPersonField(field) && /exact match|people value/i.test(failure.message),
      canUsePicker: !!field && isLinkField(field),
      pickerButtonLabel: linkActionLabel(field, selectedSummaries.length, isZh.value),
      selectedSummaries,
    }
  }))
const resultSummaryText = computed(() => {
  if (!props.result) return importComplete(isZh.value)
  const skipped = props.result.skipped ?? 0
  return importResultSummary(props.result.succeeded, skipped, props.result.failed, isZh.value)
})
const failedPreviewRows = computed(() => (props.result?.failures ?? []).slice(0, 5).map((failure) => ({
  ...failure,
  originalIndex: failure.rowIndex,
})).map((failure) => ({
  ...failure,
  rowNumber: failure.originalIndex + 2,
  values: parsedRows.value[failure.originalIndex] ?? [],
})))
const remainingFailedCount = computed(() => Math.max((props.result?.failures.length ?? 0) - failedPreviewRows.value.length, 0))
const pickerField = computed(() => {
  const target = pickerTarget.value
  if (!target) return null
  return props.fields.find((field) => field.id === target.fieldId) ?? null
})
const pickerCurrentValue = computed(() => {
  const target = pickerTarget.value
  if (!target) return []
  return manualFieldOverrides.value[target.rowIndex]?.[target.fieldId] ?? []
})
const pickerInitialSearch = computed(() => {
  const target = pickerTarget.value
  if (!target) return ''
  const failure = manualFixRows.value.find((item) => item.rowIndex === target.rowIndex && item.fieldId === target.fieldId)
  const problemIndex = failure?.problemColumnIndexes[0]
  if (typeof problemIndex !== 'number') return ''
  return parsedRows.value[target.rowIndex]?.[problemIndex] ?? ''
})
const importDraftIssues = computed<ImportDraftIssue[]>(() => {
  const issues = new Map<string, ImportDraftIssue>()
  for (const [columnIndex, fieldId] of Object.entries(fieldMapping.value)) {
    if (!fieldId) continue
    // A "create this column as a new field" sentinel is NOT a stale mapping: there is no field to
    // look up yet. It is dropped elsewhere (restore / permission-loss) when it can no longer be
    // honoured, so it must never raise a mapping-missing draft issue here.
    if (fieldId === CREATE_FIELD_SENTINEL) continue
    const field = fieldsById.value.get(fieldId)
    const header = parsedHeaders.value[Number(columnIndex)] || columnLabel(Number(columnIndex), isZh.value)
    if (!field) {
      issues.set(`mapping:${fieldId}`, {
        kind: 'mapping-missing',
        fieldId,
        message: mappedFieldRemoved(header, isZh.value),
      })
      continue
    }
    if (!importableFieldIds.value.has(fieldId)) {
      issues.set(`mapping:${fieldId}`, {
        kind: 'mapping-not-importable',
        fieldId,
        message: fieldNoLongerImportable(field.name, isZh.value),
      })
    }
  }
  for (const [rowIndexText, rowOverrides] of Object.entries(manualFieldOverrides.value)) {
    for (const fieldId of Object.keys(rowOverrides ?? {})) {
      const field = fieldsById.value.get(fieldId)
      if (!field) {
        issues.set(`override:${rowIndexText}:${fieldId}`, {
          kind: 'manual-override-invalid',
          fieldId,
          message: manualRepairFieldRemoved(isZh.value),
        })
        continue
      }
      if (!isLinkField(field)) {
        issues.set(`override:${rowIndexText}:${fieldId}`, {
          kind: 'manual-override-invalid',
          fieldId,
          message: selectedRepairInvalid(field.name, isZh.value),
        })
      }
    }
  }
  return [...issues.values()]
})
const hasImportDraftIssues = computed(() => importDraftIssues.value.length > 0)
const importDraftIssueText = computed(() => {
  if (!importDraftIssues.value.length) return ''
  const [first, ...rest] = importDraftIssues.value
  return moreDraftIssues(first.message, rest.length, isZh.value)
})
const canImportPreview = computed(() => hasMappedFields.value && props.importing !== true && !hasImportDraftIssues.value)
const canRetryFailedRows = computed(() => !props.importing && !hasImportDraftIssues.value && failedPreviewRows.value.length > 0)
const canApplyFixes = computed(() => !props.importing && !hasImportDraftIssues.value)
const importDraftDirty = computed(() => props.visible && (
  rawText.value.trim().length > 0 ||
  parsedHeaders.value.length > 0 ||
  parsedRows.value.length > 0 ||
  Object.keys(fieldMapping.value).length > 0 ||
  pendingRecordCount.value > 0 ||
  lastAttemptRecords.value.length > 0 ||
  lastAttemptRowIndexes.value.length > 0 ||
  Object.keys(manualFieldOverrides.value).length > 0 ||
  Object.keys(manualOverrideSummaries.value).length > 0 ||
  pickerTarget.value !== null ||
  pickerVisible.value ||
  parseError.value.length > 0 ||
  step.value !== 'paste' ||
  props.result !== null
))

function overrideKey(rowIndex: number, fieldId: string) {
  return `${rowIndex}:${fieldId}`
}

function readStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function buildImportDraftSnapshot(): ImportDraftSnapshot {
  return {
    version: 1,
    rawText: rawText.value,
    parsedHeaders: [...parsedHeaders.value],
    parsedRows: parsedRows.value.map((row) => [...row]),
    fieldMapping: { ...fieldMapping.value },
    manualFieldOverrides: JSON.parse(JSON.stringify(manualFieldOverrides.value)) as ImportFieldOverrides,
    manualOverrideSummaries: JSON.parse(JSON.stringify(manualOverrideSummaries.value)) as Record<string, LinkedRecordSummary[]>,
    step: parsedRows.value.length > 0 ? 'preview' : 'paste',
  }
}

function clearImportDraft() {
  readStorage()?.removeItem(importDraftStorageKey.value)
}

function persistImportDraft() {
  const storage = readStorage()
  if (!storage || !props.visible) return
  if (!importDraftDirty.value || step.value === 'importing') {
    storage.removeItem(importDraftStorageKey.value)
    return
  }
  storage.setItem(importDraftStorageKey.value, JSON.stringify(buildImportDraftSnapshot()))
}

function restoreImportDraft() {
  const storage = readStorage()
  if (!storage) return false
  const raw = storage.getItem(importDraftStorageKey.value)
  if (!raw) return false
  try {
    const snapshot = JSON.parse(raw) as Partial<ImportDraftSnapshot>
    rawText.value = typeof snapshot.rawText === 'string' ? snapshot.rawText : ''
    parsedHeaders.value = Array.isArray(snapshot.parsedHeaders) ? snapshot.parsedHeaders.filter((item): item is string => typeof item === 'string') : []
    parsedRows.value = Array.isArray(snapshot.parsedRows)
      ? snapshot.parsedRows.map((row) => Array.isArray(row) ? row.map((cell) => typeof cell === 'string' ? cell : '') : [])
      : []
    // Drafts persist the create-field sentinel, but permissions can change between sessions: when the
    // caller no longer holds manage-fields the sentinel DEGRADES to skip (never to a silent create),
    // and the modal says so.
    const restoredMapping = Object.entries(snapshot.fieldMapping ?? {}).filter(([, fieldId]) => typeof fieldId === 'string')
    const droppedCreateColumns = restoredMapping.filter(([, fieldId]) => fieldId === CREATE_FIELD_SENTINEL).length
    fieldMapping.value = Object.fromEntries(
      restoredMapping.map(([columnIndex, fieldId]) => (
        fieldId === CREATE_FIELD_SENTINEL && !canCreateFields.value
          ? [columnIndex, '']
          : [columnIndex, fieldId]
      )),
    ) as Record<number, string>
    createFieldsDropped.value = droppedCreateColumns > 0 && !canCreateFields.value
    manualFieldOverrides.value = (snapshot.manualFieldOverrides && typeof snapshot.manualFieldOverrides === 'object')
      ? snapshot.manualFieldOverrides
      : {}
    manualOverrideSummaries.value = (snapshot.manualOverrideSummaries && typeof snapshot.manualOverrideSummaries === 'object')
      ? snapshot.manualOverrideSummaries
      : {}
    step.value = snapshot.step === 'preview' && parsedRows.value.length > 0 ? 'preview' : 'paste'
    parseError.value = ''
    parseWarning.value = ''
    restoredDraft.value = true
    return true
  } catch {
    storage.removeItem(importDraftStorageKey.value)
    return false
  }
}

watch(() => props.visible, (visible, previousVisible) => {
  if (!visible) {
    resetState()
    return
  }
  if (!previousVisible) {
    resetState()
    if (!restoreImportDraft()) {
      nextTick(() => textareaRef.value?.focus())
    }
  }
})

watch(
  importDraftDirty,
  (dirty) => {
    emit('update:dirty', dirty)
  },
  { immediate: true },
)

watch(pickerField, (field) => {
  if (!pickerVisible.value) return
  if (field && isLinkField(field)) return
  closePicker()
})

watch(
  [
    () => props.visible,
    rawText,
    parsedHeaders,
    parsedRows,
    fieldMapping,
    manualFieldOverrides,
    manualOverrideSummaries,
    step,
  ],
  ([visible]) => {
    if (!visible) return
    persistImportDraft()
  },
  { deep: true },
)

watch(() => props.result, (result) => {
  if (result && result.failed === 0 && (result.skipped ?? 0) === 0) {
    clearImportDraft()
  }
})

// Manage-fields revoked while the modal is open → every sentinel degrades to skip immediately.
// Tightening only: this watch never turns a skip into a create.
watch(() => props.canCreateFields, (canCreate) => {
  if (canCreate) return
  const entries = Object.entries(fieldMapping.value)
  if (!entries.some(([, fieldId]) => fieldId === CREATE_FIELD_SENTINEL)) return
  fieldMapping.value = Object.fromEntries(
    entries.map(([columnIndex, fieldId]) => [columnIndex, fieldId === CREATE_FIELD_SENTINEL ? '' : fieldId]),
  ) as Record<number, string>
  createFieldsDropped.value = true
})

// Field creation failed in the caller: no records were written, so return to mapping instead of
// leaving the modal spinning on the importing step (props.result stays null in that case).
watch(() => props.createFieldsError, (message) => {
  if (!message) return
  if (step.value === 'importing' || step.value === 'result') step.value = 'preview'
})

// Fields were created: rebind those columns from the sentinel to the real field ids so a second
// import attempt maps onto the new fields instead of creating duplicates.
watch(() => props.createdFieldColumns, (created) => {
  if (!created || !Object.keys(created).length) return
  const next = { ...fieldMapping.value }
  let changed = false
  for (const [columnIndex, fieldId] of Object.entries(created)) {
    if (typeof fieldId !== 'string' || !fieldId) continue
    if (next[Number(columnIndex)] !== CREATE_FIELD_SENTINEL) continue
    next[Number(columnIndex)] = fieldId
    changed = true
  }
  if (changed) fieldMapping.value = next
}, { deep: true })

function parseAndPreview() {
  parseError.value = ''
  const parsed = parseDelimitedText(rawText.value)
  const lines = parsed.rows
  if (lines.length < 2) {
    parseError.value = l('import.errorNeedRows')
    return
  }
  parsedHeaders.value = lines[0]
  parsedRows.value = lines.slice(1).filter((row) => row.some((cell) => cell.trim()))
  if (!parsedRows.value.length) {
    parseError.value = l('import.errorNoRows')
    return
  }

  // Paste and file paths now share ONE matcher (mapXlsxColumnsToFields): it trims both sides and
  // refuses to map two headers onto the same field, which the old inline paste matcher did not.
  fieldMapping.value = buildDefaultFieldMapping(parsedHeaders.value)
  step.value = 'preview'
}

/**
 * Default column → field mapping: exact (case-insensitive, trimmed, de-duplicated) name match first;
 * every remaining non-empty header defaults to "create a new text field" WHEN the caller holds
 * manage-fields, otherwise to skip (the pre-existing behaviour).
 */
function buildDefaultFieldMapping(headers: string[]): Record<number, string> {
  const mapping = { ...mapXlsxColumnsToFields(headers, importableFields.value).mapping }
  headers.forEach((header, index) => {
    if (mapping[index]) return
    // "Missing from the sheet" is decided against EVERY existing field name, not just the mappable
    // ones. A header matching a formula/readonly/hidden field is left on skip: defaulting it to
    // create would build an `X (2)` shadow text column behind the user's back (the export →
    // re-import round trip hits exactly this). The option stays in the dropdown for anyone who
    // deliberately wants the extra column.
    mapping[index] = canOfferCreateField(header) && !headerMatchesUnmappableField(header)
      ? CREATE_FIELD_SENTINEL
      : ''
  })
  return mapping
}

async function readAndSetText(file: File) {
  parseError.value = ''
  try {
    rawText.value = await file.text()
  } catch (error: any) {
    parseError.value = error.message ?? l('import.errorReadFile')
  }
}

function isXlsxFile(file: File): boolean {
  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) return true
  const lowerType = file.type.toLowerCase()
  return (
    lowerType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    lowerType === 'application/vnd.ms-excel'
  )
}

async function readAndSetXlsx(file: File) {
  parseError.value = ''
  parseWarning.value = ''
  if (file.size > XLSX_MAX_BYTES) {
    parseError.value = fileTooLarge((XLSX_MAX_BYTES / (1024 * 1024)).toFixed(0), isZh.value)
    return
  }
  try {
    const xlsx = (await import('xlsx')) as unknown as Parameters<typeof parseXlsxBuffer>[0]
    const buffer = await file.arrayBuffer()
    const result = parseXlsxBuffer(xlsx, buffer)
    if (!result.headers.length || !result.rows.length) {
      parseError.value = l('import.errorSpreadsheetEmpty')
      return
    }
    rawText.value = ''
    parsedHeaders.value = result.headers
    parsedRows.value = result.rows
    fieldMapping.value = buildDefaultFieldMapping(result.headers)
    if (result.truncated) {
      parseWarning.value = xlsxTruncated(parsedRows.value.length, XLSX_MAX_ROWS, isZh.value)
    }
    step.value = 'preview'
  } catch (error: any) {
    parseError.value = error?.message ?? l('import.errorReadExcel')
  }
}

function onFileSelect(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (isXlsxFile(file)) void readAndSetXlsx(file)
  else void readAndSetText(file)
}

function onFileDrop(event: DragEvent) {
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  if (isXlsxFile(file)) void readAndSetXlsx(file)
  else void readAndSetText(file)
}

watch([() => props.importing, () => props.result, () => props.visible], ([importing, result, visible]) => {
  if (!visible) return
  if (importing) {
    step.value = 'importing'
    return
  }
  if (result) step.value = 'result'
}, { immediate: true })

/**
 * Mapping handed to `buildImportedRecords`: the sentinel is replaced by a per-column PLACEHOLDER key
 * (`__create__:<columnIndex>`) that cannot collide with a real field id, so the raw cell text is
 * carried through the build untouched. The workbench rewrites those keys to the ids of the fields it
 * creates before any record is written. Sentinels that are no longer honourable become skip.
 */
function effectiveFieldMapping(): Record<number, string> {
  const mapping: Record<number, string> = {}
  for (const [columnIndex, fieldId] of Object.entries(fieldMapping.value)) {
    if (fieldId !== CREATE_FIELD_SENTINEL) {
      mapping[Number(columnIndex)] = fieldId
      continue
    }
    mapping[Number(columnIndex)] = isActiveCreateColumn(columnIndex) ? createFieldPlaceholderId(Number(columnIndex)) : ''
  }
  return mapping
}

async function buildRecords(): Promise<ImportBuildResult> {
  return buildImportedRecords({
    parsedRows: parsedRows.value,
    fieldMapping: effectiveFieldMapping(),
    fields: props.fields,
    fieldResolvers: props.fieldResolvers,
    fieldOverrides: manualFieldOverrides.value,
    isZh: isZh.value,
  })
}

async function doImport() {
  step.value = 'importing'
  pendingRecordCount.value = parsedRows.value.length
  const result = await buildRecords()
  emitImport(result)
}

function requestClose() {
  if (isImporting.value) {
    emit('cancel-import')
    return
  }
  if (importDraftDirty.value && !window.confirm(l('import.discardConfirm'))) return
  clearImportDraft()
  emit('close')
}

function goBackToPaste() {
  if (isImporting.value) return
  step.value = 'paste'
}

function goBackToPreview() {
  if (isImporting.value) return
  step.value = 'preview'
}

function retryFailedRows() {
  const result = props.result
  if (!result?.failures.length) return
  const retryableFailures = result.failures.filter((failure) => !failure.skipped && failure.retryable !== false)
  const preservedFailures = result.failures.filter((failure) => failure.skipped || failure.retryable === false).map((failure) => ({ ...failure }))
  const nextRecords = retryableFailures
    .map((failure) => (typeof failure.index === 'number' ? lastAttemptRecords.value[failure.index] : null))
    .filter((record): record is Record<string, unknown> => !!record)
  const nextRowIndexes = retryableFailures
    .map((failure) => (typeof failure.index === 'number' ? lastAttemptRowIndexes.value[failure.index] : null))
    .filter((rowIndex): rowIndex is number => typeof rowIndex === 'number')

  if (!nextRecords.length) {
    if (preservedFailures.length) {
      emitImport({
        records: [],
        rowIndexes: [],
        failures: preservedFailures,
      })
    }
    return
  }
  if (nextRecords.length !== nextRowIndexes.length) return
  emitImport({
    records: nextRecords,
    rowIndexes: nextRowIndexes,
    failures: preservedFailures,
  })
}

function updateFailedCell(rowIndex: number, columnIndex: number, value: string) {
  const nextRows = [...parsedRows.value]
  const currentRow = [...(nextRows[rowIndex] ?? [])]
  currentRow[columnIndex] = value
  nextRows[rowIndex] = currentRow
  parsedRows.value = nextRows
  const fieldId = fieldMapping.value[columnIndex]
  if (fieldId && manualFieldOverrides.value[rowIndex]?.[fieldId] !== undefined) {
    const rowOverrides = { ...(manualFieldOverrides.value[rowIndex] ?? {}) }
    delete rowOverrides[fieldId]
    const nextOverrides = { ...manualFieldOverrides.value }
    if (Object.keys(rowOverrides).length) nextOverrides[rowIndex] = rowOverrides
    else delete nextOverrides[rowIndex]
    manualFieldOverrides.value = nextOverrides

    const nextSummaries = { ...manualOverrideSummaries.value }
    delete nextSummaries[overrideKey(rowIndex, fieldId)]
    manualOverrideSummaries.value = nextSummaries
  }
}

function reconcileImportDraft() {
  const nextFieldMapping = { ...fieldMapping.value }
  for (const [columnIndex, fieldId] of Object.entries(nextFieldMapping)) {
    if (!fieldId || importableFieldIds.value.has(fieldId)) continue
    // Keep live create-field sentinels: reconcile exists to drop mappings whose FIELD vanished, and
    // a sentinel has no field yet. Without this guard reconcile would silently reset the column to
    // "skip" and the import would drop that column's data.
    if (fieldId === CREATE_FIELD_SENTINEL && isActiveCreateColumn(columnIndex)) continue
    delete nextFieldMapping[Number(columnIndex)]
  }

  const nextOverrides: ImportFieldOverrides = {}
  const nextSummaries: Record<string, LinkedRecordSummary[]> = {}
  for (const [rowIndexText, rowOverrides] of Object.entries(manualFieldOverrides.value)) {
    const rowIndex = Number(rowIndexText)
    const keptOverrides: Record<string, unknown> = {}
    for (const [fieldId, overrideValue] of Object.entries(rowOverrides ?? {})) {
      const field = fieldsById.value.get(fieldId)
      if (!field || !isLinkField(field)) continue
      keptOverrides[fieldId] = overrideValue
      const summaries = manualOverrideSummaries.value[overrideKey(rowIndex, fieldId)]
      if (summaries) nextSummaries[overrideKey(rowIndex, fieldId)] = summaries
    }
    if (Object.keys(keptOverrides).length > 0) nextOverrides[rowIndex] = keptOverrides
  }

  fieldMapping.value = nextFieldMapping
  manualFieldOverrides.value = nextOverrides
  manualOverrideSummaries.value = nextSummaries
  if (pickerTarget.value) {
    const field = fieldsById.value.get(pickerTarget.value.fieldId)
    if (!field || !isLinkField(field)) closePicker()
  }
}

async function applyFixesAndRetry() {
  const result = props.result
  if (!result?.failures.length) return

  const manualFailures = result.failures.filter((failure) => !failure.skipped && failure.retryable === false)
  const manualRowIndexes = [...new Set(manualFailures.map((failure) => failure.rowIndex))].sort((a, b) => a - b)
  const subsetOverrides = manualRowIndexes.reduce<ImportFieldOverrides>((acc, originalRowIndex, subsetRowIndex) => {
    if (manualFieldOverrides.value[originalRowIndex]) acc[subsetRowIndex] = { ...manualFieldOverrides.value[originalRowIndex] }
    return acc
  }, {})
  const rebuilt = await buildImportedRecords({
    parsedRows: manualRowIndexes.map((rowIndex) => [...(parsedRows.value[rowIndex] ?? [])]),
    fieldMapping: effectiveFieldMapping(),
    fields: props.fields,
    fieldResolvers: props.fieldResolvers,
    fieldOverrides: subsetOverrides,
    isZh: isZh.value,
  })

  const retryableFailures = result.failures.filter((failure) => !failure.skipped && failure.retryable !== false)
  const nextRetryableRecords = retryableFailures
    .map((failure) => (typeof failure.index === 'number' ? lastAttemptRecords.value[failure.index] : null))
    .filter((record): record is Record<string, unknown> => !!record)
  const nextRetryableRowIndexes = retryableFailures
    .map((failure) => (typeof failure.index === 'number' ? lastAttemptRowIndexes.value[failure.index] : null))
    .filter((rowIndex): rowIndex is number => typeof rowIndex === 'number')

  emitImport({
    records: [...nextRetryableRecords, ...rebuilt.records],
    rowIndexes: [...nextRetryableRowIndexes, ...rebuilt.rowIndexes.map((rowIndex) => manualRowIndexes[rowIndex] ?? rowIndex)],
    failures: rebuilt.failures.map((failure) => ({
      ...failure,
      rowIndex: manualRowIndexes[failure.rowIndex] ?? failure.rowIndex,
    })),
  })
}

function openPickerForFailure(failure: { rowIndex: number; fieldId?: string; canUsePicker?: boolean }) {
  if (!failure.canUsePicker || !failure.fieldId) return
  pickerTarget.value = { rowIndex: failure.rowIndex, fieldId: failure.fieldId }
  pickerVisible.value = true
}

function closePicker() {
  pickerVisible.value = false
  pickerTarget.value = null
}

function onPickerConfirm(payload: { recordIds: string[]; summaries: LinkedRecordSummary[] }) {
  const target = pickerTarget.value
  if (!target) return
  const rowOverrides = {
    ...(manualFieldOverrides.value[target.rowIndex] ?? {}),
    [target.fieldId]: payload.recordIds,
  }
  manualFieldOverrides.value = {
    ...manualFieldOverrides.value,
    [target.rowIndex]: rowOverrides,
  }
  manualOverrideSummaries.value = {
    ...manualOverrideSummaries.value,
    [overrideKey(target.rowIndex, target.fieldId)]: payload.summaries,
  }

  const label = payload.summaries.map((summary) => summary.display || summary.id).join(', ')
  const problemIndexes = Object.entries(fieldMapping.value)
    .filter(([, mappedFieldId]) => mappedFieldId === target.fieldId)
    .map(([columnIndex]) => Number(columnIndex))
    .filter((columnIndex) => Number.isInteger(columnIndex) && columnIndex >= 0)
  if (problemIndexes.length > 0) {
    const nextRows = [...parsedRows.value]
    const currentRow = [...(nextRows[target.rowIndex] ?? [])]
    for (const problemIndex of problemIndexes) {
      currentRow[problemIndex] = label
    }
    nextRows[target.rowIndex] = currentRow
    parsedRows.value = nextRows
  }
  closePicker()
}

function emitImport(payload: ImportBuildResult) {
  if (!payload.records.length && !payload.failures.length) return
  step.value = 'importing'
  pendingRecordCount.value = payload.records.length
  lastAttemptRecords.value = payload.records
  lastAttemptRowIndexes.value = payload.rowIndexes
  // Every emit path (first import, retry, apply-fixes) carries the CURRENT create requests: once the
  // caller reports the created ids back via `createdFieldColumns` the sentinels are gone, so a retry
  // can never create the same field twice.
  const createFields = createFieldRequests.value
  const submitPayload: ImportSubmitPayload = createFields.length ? { ...payload, createFields } : payload
  emit('import', submitPayload)
}

function resetState() {
  step.value = 'paste'
  rawText.value = ''
  parsedHeaders.value = []
  parsedRows.value = []
  fieldMapping.value = {}
  pendingRecordCount.value = 0
  lastAttemptRecords.value = []
  lastAttemptRowIndexes.value = []
  manualFieldOverrides.value = {}
  manualOverrideSummaries.value = {}
  pickerTarget.value = null
  pickerVisible.value = false
  parseError.value = ''
  parseWarning.value = ''
  restoredDraft.value = false
  createFieldsDropped.value = false
}

onBeforeUnmount(() => {
  emit('update:dirty', false)
})
</script>

<style scoped>
.meta-import-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
.meta-import-modal { background: #fff; border-radius: 8px; width: 560px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0,0,0,.15); }
.meta-import__header { display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-bottom: 1px solid #eee; font-size: 15px; }
.meta-import__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-import__body { padding: 16px 20px; overflow-y: auto; }
.meta-import__hint { font-size: 13px; color: #666; margin-bottom: 12px; }
.meta-import__warning { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; padding: 8px 10px; border: 1px solid #f3d19e; border-radius: 6px; background: #fff7e6; color: #8a5a00; font-size: 12px; }
.meta-import__file-drop { display: flex; align-items: center; justify-content: center; margin-bottom: 12px; padding: 12px; border: 1px dashed #cbd5e1; border-radius: 6px; color: #475569; font-size: 13px; cursor: pointer; background: #f8fafc; }
.meta-import__file-drop:hover { border-color: #409eff; color: #409eff; }
.meta-import__file-input { display: none; }
.meta-import__textarea { width: 100%; min-height: 120px; border: 1px solid #ddd; border-radius: 4px; padding: 8px; font-family: monospace; font-size: 12px; resize: vertical; }
.meta-import__textarea:focus { border-color: #409eff; outline: none; }
.meta-import__error { margin-top: 8px; color: #f56c6c; font-size: 12px; }
.meta-import__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; padding-top: 12px; border-top: 1px solid #f0f0f0; }
.meta-import__actions--center { justify-content: center; }
.meta-import__btn { padding: 6px 16px; border: 1px solid #ddd; border-radius: 4px; background: #fff; font-size: 13px; cursor: pointer; }
.meta-import__btn:hover { background: #f5f5f5; }
.meta-import__btn--primary { background: #409eff; color: #fff; border-color: #409eff; }
.meta-import__btn--primary:hover { background: #66b1ff; }
.meta-import__btn--primary:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-import__btn-inline { align-self: flex-start; padding: 4px 10px; border: 1px dashed #cbd5e1; border-radius: 4px; background: #fff; color: #475569; cursor: pointer; font-size: 12px; }
.meta-import__mapping { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.meta-import__map-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.meta-import__col-name { min-width: 100px; font-weight: 500; color: #333; }
.meta-import__arrow { color: #999; }
.meta-import__field-select { padding: 3px 8px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px; }
.meta-import__preview-table { max-height: 180px; overflow: auto; border: 1px solid #eee; border-radius: 4px; }
.meta-import__preview-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
.meta-import__preview-table th { background: #f9fafb; padding: 4px 8px; border-bottom: 1px solid #eee; text-align: left; font-weight: 600; color: #666; }
.meta-import__preview-table td { padding: 4px 8px; border-bottom: 1px solid #f5f5f5; }
.meta-import__more { text-align: center; color: #999; font-style: italic; }
.meta-import__importing { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 20px; }
.meta-import__result { padding: 12px; border-radius: 8px; margin-bottom: 12px; }
.meta-import__result strong { display: block; margin-bottom: 6px; font-size: 14px; }
.meta-import__result p { margin: 0; font-size: 12px; line-height: 1.5; }
.meta-import__result--success { background: #f0f9eb; color: #2f7d32; }
.meta-import__result--warning { background: #fff7e6; color: #8a5a00; }
.meta-import__failures { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.meta-import__failure { padding: 10px 12px; border: 1px solid #f3e2b8; border-radius: 8px; background: #fffdfa; }
.meta-import__failure-head { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; font-size: 12px; color: #7c5b12; }
.meta-import__failure-row { font-family: monospace; font-size: 11px; color: #5b6472; word-break: break-word; }
.meta-import__fixes { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
.meta-import__fix { padding: 10px 12px; border: 1px solid #d9e5f7; border-radius: 8px; background: #f8fbff; }
.meta-import__fix-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.meta-import__fix-cell { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #475467; }
.meta-import__fix-cell--problem span { color: #0f5ba7; font-weight: 600; }
.meta-import__fix-input { width: 100%; padding: 6px 8px; border: 1px solid #d0d5dd; border-radius: 4px; font-size: 12px; background: #fff; }
.meta-import__fix-cell--problem .meta-import__fix-input { border-color: #409eff; box-shadow: 0 0 0 1px rgba(64,158,255,.12); }
.meta-import__fix-hint { margin-top: 8px; font-size: 12px; color: #0f5ba7; }
.meta-import__fix-picker-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.meta-import__fix-selected { font-size: 12px; color: #0f5ba7; }
.meta-import__spinner { width: 32px; height: 32px; border: 3px solid #eee; border-top-color: #409eff; border-radius: 50%; animation: meta-import-spin 0.8s linear infinite; }
@keyframes meta-import-spin { to { transform: rotate(360deg); } }
/* Create-missing-fields summaries (appended; no existing rule changed). */
.meta-import__create-summary { margin: 8px 0 0; color: #0f5ba7; }
.meta-import__skip-summary { margin: 8px 0 0; }
.meta-import__create-error { margin-top: 8px; }
</style>
