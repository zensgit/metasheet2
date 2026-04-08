<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-import-overlay" @click.self="requestClose">
      <div class="meta-import-modal">
        <div class="meta-import__header">
          <strong>Import Records</strong>
          <button class="meta-import__close" @click="requestClose">&times;</button>
        </div>

        <div v-if="step === 'paste'" class="meta-import__body">
          <div v-if="restoredDraft" class="meta-import__warning">
            <span>Recovered your previous import draft for this sheet.</span>
          </div>
          <p class="meta-import__hint">Paste tab-separated data from Excel or Google Sheets (first row = headers):</p>
          <label class="meta-import__file-drop" @dragover.prevent @drop.prevent="onFileDrop">
            <input class="meta-import__file-input" type="file" accept=".csv,text/csv,.tsv,text/tab-separated-values,.txt,text/plain" @change="onFileSelect" />
            <span>Choose a CSV/TSV file or drop it here</span>
          </label>
          <textarea
            ref="textareaRef"
            class="meta-import__textarea"
            placeholder="Name&#x9;Age&#x9;Email&#x0A;Alice&#x9;30&#x9;alice@example.com"
            :value="rawText"
            @input="rawText = ($event.target as HTMLTextAreaElement).value"
          ></textarea>
          <div v-if="parseError" class="meta-import__error">{{ parseError }}</div>
          <div class="meta-import__actions">
            <button class="meta-import__btn" :disabled="isImporting" @click="requestClose">Cancel</button>
            <button class="meta-import__btn meta-import__btn--primary" :disabled="!rawText.trim()" @click="parseAndPreview">Preview</button>
          </div>
        </div>

        <div v-else-if="step === 'preview'" class="meta-import__body">
          <div v-if="restoredDraft" class="meta-import__warning">
            <span>Recovered your previous import draft for this sheet.</span>
          </div>
          <p class="meta-import__hint">{{ parsedRows.length }} record(s) detected. Map columns to fields:</p>
          <div v-if="hasImportDraftIssues" class="meta-import__warning">
            <span>{{ importDraftIssueText }}</span>
            <button class="meta-import__btn-inline" @click="reconcileImportDraft">Reconcile draft</button>
          </div>
          <div class="meta-import__mapping">
            <div v-for="(header, i) in parsedHeaders" :key="i" class="meta-import__map-row">
              <span class="meta-import__col-name">{{ header }}</span>
              <span class="meta-import__arrow">&rarr;</span>
              <select class="meta-import__field-select" :value="fieldMapping[i] ?? ''" @change="fieldMapping[i] = ($event.target as HTMLSelectElement).value">
                <option value="">(skip)</option>
                <option v-for="f in importableFields" :key="f.id" :value="f.id">{{ f.name }}</option>
              </select>
            </div>
          </div>
          <div v-if="parsedRows.length" class="meta-import__preview-table">
            <table>
              <thead><tr><th v-for="(h, i) in parsedHeaders" :key="i">{{ h }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, ri) in parsedRows.slice(0, 5)" :key="ri">
                  <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
                </tr>
                <tr v-if="parsedRows.length > 5"><td :colspan="parsedHeaders.length" class="meta-import__more">... and {{ parsedRows.length - 5 }} more</td></tr>
              </tbody>
            </table>
          </div>
          <div class="meta-import__actions">
            <button class="meta-import__btn" :disabled="isImporting" @click="goBackToPaste">Back</button>
            <button class="meta-import__btn meta-import__btn--primary" :disabled="!canImportPreview" @click="doImport">
              Import {{ parsedRows.length }} record(s)
            </button>
          </div>
        </div>

        <div v-else-if="step === 'importing'" class="meta-import__body meta-import__importing">
          <div class="meta-import__spinner"></div>
          <p>Importing {{ pendingRecordCount }} record(s)...</p>
          <div class="meta-import__actions meta-import__actions--center">
            <button class="meta-import__btn" @click="requestClose">Cancel import</button>
          </div>
        </div>

        <div v-else class="meta-import__body">
          <div class="meta-import__result" :class="hasImportWarnings ? 'meta-import__result--warning' : 'meta-import__result--success'">
            <strong>{{ resultSummaryText }}</strong>
            <p v-if="hasFailedImports">
              <template v-if="retryableFailureCount > 0">
                Review the failed rows below, then retry just those rows or return to mapping.
              </template>
              <template v-else>
                Review the failed rows below and return to mapping to fix the source data.
              </template>
            </p>
            <p v-else-if="hasSkippedImports">
              Some rows were skipped as duplicates.
            </p>
            <p v-else>The selected records were imported successfully.</p>
          </div>
          <div v-if="hasImportDraftIssues" class="meta-import__warning">
            <span>{{ importDraftIssueText }}</span>
            <button class="meta-import__btn-inline" @click="reconcileImportDraft">Reconcile draft</button>
          </div>
          <div v-if="failedPreviewRows.length" class="meta-import__failures">
            <div v-for="failure in failedPreviewRows" :key="`${failure.originalIndex}:${failure.fieldId ?? 'row'}`" class="meta-import__failure">
              <div class="meta-import__failure-head">
                <strong>Row {{ failure.rowNumber }}</strong>
                <span>{{ failure.message }}</span>
              </div>
              <div class="meta-import__failure-row">{{ failure.values.join(' | ') || '(empty row)' }}</div>
            </div>
            <div v-if="remainingFailedCount > 0" class="meta-import__more">
              ... and {{ remainingFailedCount }} more failed row(s)
            </div>
          </div>
          <div v-if="manualFixRows.length" class="meta-import__fixes">
            <div v-for="failure in manualFixRows" :key="`${failure.rowIndex}:${failure.fieldId ?? 'row'}`" class="meta-import__fix">
              <div class="meta-import__failure-head">
                <strong>Fix Row {{ failure.rowNumber }}</strong>
                <span>{{ failure.message }}</span>
              </div>
              <div class="meta-import__fix-grid">
                <label
                  v-for="(cell, ci) in failure.values"
                  :key="`${failure.rowIndex}:${ci}`"
                  class="meta-import__fix-cell"
                  :class="{ 'meta-import__fix-cell--problem': failure.problemColumnIndexes.includes(ci) }"
                >
                  <span>{{ parsedHeaders[ci] || `Column ${ci + 1}` }}</span>
                  <input class="meta-import__fix-input" :value="cell" @input="updateFailedCell(failure.rowIndex, ci, ($event.target as HTMLInputElement).value)" />
                </label>
              </div>
              <div v-if="failure.showPeopleHint" class="meta-import__fix-hint">
                Use an exact email address or person record ID for this field.
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
            <button class="meta-import__btn" :disabled="isImporting" @click="goBackToPreview">Back to mapping</button>
            <button v-if="hasFailedImports && retryableFailureCount > 0" class="meta-import__btn meta-import__btn--primary" :disabled="!canRetryFailedRows" @click="retryFailedRows">
              Retry failed rows
            </button>
            <button v-if="manualFixRows.length" class="meta-import__btn meta-import__btn--primary" :disabled="!canApplyFixes" @click="applyFixesAndRetry">
              Apply fixes and retry
            </button>
            <button class="meta-import__btn" :disabled="isImporting" @click="requestClose">Close</button>
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
import type { LinkedRecordSummary, MetaField } from '../types'
import { buildImportedRecords, parseDelimitedText } from '../import/delimited'
import type { ImportBuildFailure, ImportBuildResult, ImportFieldOverrides, ImportValueResolver } from '../import/delimited'
import { isLinkField, isPersonField, linkActionLabel } from '../utils/link-fields'

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
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'cancel-import'): void
  (e: 'import', payload: ImportBuildResult): void
  (e: 'update:dirty', dirty: boolean): void
}>()

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
const manualFieldOverrides = ref<ImportFieldOverrides>({})
const manualOverrideSummaries = ref<Record<string, LinkedRecordSummary[]>>({})
const pickerTarget = ref<{ rowIndex: number; fieldId: string } | null>(null)
const pickerVisible = ref(false)
const restoredDraft = ref(false)

const hasMappedFields = computed(() => Object.values(fieldMapping.value).some((value) => value))
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
      pickerButtonLabel: linkActionLabel(field, selectedSummaries.length),
      selectedSummaries,
    }
  }))
const resultSummaryText = computed(() => {
  if (!props.result) return 'Import complete'
  const skipped = props.result.skipped ?? 0
  if (props.result.failed > 0 && skipped > 0) return `${props.result.succeeded} imported, ${skipped} skipped, ${props.result.failed} failed`
  if (props.result.failed > 0) return `${props.result.succeeded} imported, ${props.result.failed} failed`
  if (skipped > 0) return `${props.result.succeeded} imported, ${skipped} skipped`
  return `Imported ${props.result.succeeded} record(s)`
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
    const field = fieldsById.value.get(fieldId)
    const header = parsedHeaders.value[Number(columnIndex)] || `Column ${Number(columnIndex) + 1}`
    if (!field) {
      issues.set(`mapping:${fieldId}`, {
        kind: 'mapping-missing',
        fieldId,
        message: `Mapped field for ${header} was removed in the background. Reconcile the draft before importing.`,
      })
      continue
    }
    if (!importableFieldIds.value.has(fieldId)) {
      issues.set(`mapping:${fieldId}`, {
        kind: 'mapping-not-importable',
        fieldId,
        message: `${field.name} is no longer an importable field. Reconcile the draft before importing.`,
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
          message: 'A manual repair targets a field that was removed in the background. Reconcile the draft before importing.',
        })
        continue
      }
      if (!isLinkField(field)) {
        issues.set(`override:${rowIndexText}:${fieldId}`, {
          kind: 'manual-override-invalid',
          fieldId,
          message: `A selected linked-record repair for ${field.name} is no longer valid because the field changed type. Reconcile the draft before importing.`,
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
  return rest.length > 0 ? `${first.message} ${rest.length} more issue(s) need review.` : first.message
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
    fieldMapping.value = Object.fromEntries(
      Object.entries(snapshot.fieldMapping ?? {}).filter(([, fieldId]) => typeof fieldId === 'string'),
    ) as Record<number, string>
    manualFieldOverrides.value = (snapshot.manualFieldOverrides && typeof snapshot.manualFieldOverrides === 'object')
      ? snapshot.manualFieldOverrides
      : {}
    manualOverrideSummaries.value = (snapshot.manualOverrideSummaries && typeof snapshot.manualOverrideSummaries === 'object')
      ? snapshot.manualOverrideSummaries
      : {}
    step.value = snapshot.step === 'preview' && parsedRows.value.length > 0 ? 'preview' : 'paste'
    parseError.value = ''
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

function parseAndPreview() {
  parseError.value = ''
  const parsed = parseDelimitedText(rawText.value)
  const lines = parsed.rows
  if (lines.length < 2) {
    parseError.value = 'Need at least one header row and one data row'
    return
  }
  parsedHeaders.value = lines[0]
  parsedRows.value = lines.slice(1).filter((row) => row.some((cell) => cell.trim()))
  if (!parsedRows.value.length) {
    parseError.value = 'No importable rows found'
    return
  }

  fieldMapping.value = {}
  parsedHeaders.value.forEach((header, index) => {
    const normalizedHeader = header.toLowerCase().trim()
    const match = importableFields.value.find((field) => field.name.toLowerCase() === normalizedHeader)
    if (match) fieldMapping.value[index] = match.id
  })
  step.value = 'preview'
}

async function readAndSetText(file: File) {
  parseError.value = ''
  try {
    rawText.value = await file.text()
  } catch (error: any) {
    parseError.value = error.message ?? 'Failed to read file'
  }
}

function onFileSelect(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void readAndSetText(file)
}

function onFileDrop(event: DragEvent) {
  const file = event.dataTransfer?.files?.[0]
  if (file) void readAndSetText(file)
}

watch([() => props.importing, () => props.result, () => props.visible], ([importing, result, visible]) => {
  if (!visible) return
  if (importing) {
    step.value = 'importing'
    return
  }
  if (result) step.value = 'result'
}, { immediate: true })

async function buildRecords(): Promise<ImportBuildResult> {
  return buildImportedRecords({
    parsedRows: parsedRows.value,
    fieldMapping: fieldMapping.value,
    fields: props.fields,
    fieldResolvers: props.fieldResolvers,
    fieldOverrides: manualFieldOverrides.value,
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
  if (importDraftDirty.value && !window.confirm('Discard unsaved import changes?')) return
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
    fieldMapping: fieldMapping.value,
    fields: props.fields,
    fieldResolvers: props.fieldResolvers,
    fieldOverrides: subsetOverrides,
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
  emit('import', payload)
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
  restoredDraft.value = false
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
</style>
