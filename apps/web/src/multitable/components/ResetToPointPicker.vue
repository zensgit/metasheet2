<!--
  W2 exact-anchor recovery picker. Lets a sheet-admin pick a Global History batch and hands its
  `historyBatchId` to the mode-specific Revert/Reset dialog. Revert keeps post-anchor-created records; Reset
  can delete them and therefore owns the typed two-step confirmation.

  EXACT ANCHOR ONLY (W2): the free datetime-local fallback is GONE. Destructive Reset accepts exactly one of
  `historyBatchId` (this picker) or `anchorOperationId` (API-only, not offered as a control here) — never a
  wall-clock time. `createdAt` stays display text: the human-facing "Target" line is derived FROM the selected
  batch's `createdAt` (not any free-form input), so what the user sees can never diverge from the anchor the
  destructive op uses. Each command is gated by its own server-derived capability (which already encodes
  flag ∧ canManageSheetAccess); dialogs mount only after a history batch is selected.

  i18n (R5b strict-zero closeout): strings routed through `l()` → meta-record-labels.ts `record.resetPicker*`.
  The stray `{{ ' ' }}` mustaches around some labels are NOT decorative — a whitespace-only static text node that
  is the first/last child of its element is unconditionally stripped by Vue's template whitespace-condense pass
  (unlike a mixed text+space node, which only gets collapsed), so a literal-string-space would silently vanish
  where the original hardcoded copy had a leading/trailing space. Wrapping the space in its own interpolation
  keeps it immune to that pass — do not "clean this up" without re-diffing rendered output byte-for-byte.
-->
<template>
  <div v-if="recoveryEnabled" class="reset-picker" data-test="reset-picker">
    <div class="reset-picker__history" data-test="reset-picker-history">
      <div class="reset-picker__heading">{{ l(pickerHeadingKey) }}</div>
      <div class="reset-picker__history-row">
        <label class="reset-picker__label">
          <span>{{ l('record.resetPickerHistoryLabel') }}</span>
          <select
            class="reset-picker__input reset-picker__select"
            data-test="reset-picker-history-select"
            v-model="selectedBatchId"
            :disabled="historyLoading || historyOptions.length === 0"
          >
            <option value="">{{ l('record.resetPickerHistoryPlaceholder') }}</option>
            <option v-for="batch in historyOptions" :key="batch.batchId" :value="batch.batchId">
              {{ historyBatchLabel(batch) }}
            </option>
          </select>
        </label>
        <MtButton
          class="reset-picker__refresh"
          data-test="reset-picker-history-refresh"
          :disabled="historyLoading || !canLoadHistory"
          @click="loadHistoryBatches"
        >{{ ' ' }}{{ l('record.resetPickerRefresh') }}{{ ' ' }}</MtButton>
      </div>
      <p v-if="historyLoading" class="reset-picker__hint" data-test="reset-picker-history-loading">{{ l('record.resetPickerHistoryLoading') }}</p>
      <p v-else-if="historyError" class="reset-picker__hint reset-picker__hint--warn" data-test="reset-picker-history-error">{{ historyError }}</p>
      <p v-else-if="canLoadHistory && historyOptions.length === 0" class="reset-picker__hint" data-test="reset-picker-history-empty">{{ l('record.resetPickerHistoryEmpty') }}</p>
      <p v-else-if="!canLoadHistory" class="reset-picker__hint" data-test="reset-picker-history-unavailable">{{ l('record.resetPickerHistoryUnavailable') }}</p>
    </div>

    <!-- Exact-anchor only: no free wall-clock control is offered (removed W2). -->
    <p class="reset-picker__hint" data-test="reset-picker-exact-anchor-note">{{ l(pickerNoteKey) }}</p>

    <template v-if="anchor">
      <p class="reset-picker__target" data-test="reset-picker-target">{{ ' ' }}{{ l('record.resetPickerTargetPrefix') }} <strong>{{ targetDisplay }}</strong> {{ l('record.resetPickerTargetSuffix') }}
        <span>{{ ' ' }}{{ l('record.resetPickerFromBatch') }} {{ shortSelectedBatchId }}</span>
      </p>
      <ResetConfirmDialog
        v-if="revertReady"
        mode="revert"
        :sheet-revert-enabled="true"
        :as-of="historyAsOf ?? ''"
        :anchor="anchor"
        :reset-preview="boundRevertPreview"
        :reset-execute="boundRevertExecute"
        :on-done="handleDone"
      />
      <ResetConfirmDialog
        v-if="pitResetEnabled"
        mode="reset"
        :pit-reset-enabled="true"
        :as-of="historyAsOf ?? ''"
        :anchor="anchor"
        :reset-preview="boundPreview"
        :reset-execute="boundExecute"
        :on-done="handleDone"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import ResetConfirmDialog from './ResetConfirmDialog.vue'
import { MtButton } from '../ui'
import type { ExactAnchorRequest, ResetPreview, ResetResult } from '../api/client'
import type { HistoryBatchSummary } from '../types'
import { useLocale } from '../../composables/useLocale'
import { recordLabel, resetPickerRecordCount, type MetaRecordLabelKey } from '../utils/meta-record-labels'

type ListHistoryEvents = (
  baseId: string,
  params?: { sheetId?: string; limit?: number },
) => Promise<{ batches: HistoryBatchSummary[] }>

const props = defineProps<{
  /** flag-derived capability (MULTITABLE_ENABLE_PIT_RESET ∧ canManageSheetAccess); off/absent ⇒ whole entry hidden. */
  pitResetEnabled?: boolean
  /** flag-derived Revert capability (MULTITABLE_ENABLE_SHEET_REVERT ∧ canManageSheetAccess). */
  sheetRevertEnabled?: boolean
  /** base-level Global History scope. Required for the primary history-anchored picker path. */
  baseId?: string
  /** bound here (not in the dialog) so the (sheetId, anchor) wiring is covered by THIS component's unit test. */
  sheetId: string
  listHistoryEvents?: ListHistoryEvents
  resetPreview: (sheetId: string, anchor: ExactAnchorRequest) => Promise<ResetPreview>
  resetExecute: (sheetId: string, previewIdentity: string) => Promise<ResetResult>
  revertPreview?: (sheetId: string, anchor: ExactAnchorRequest) => Promise<ResetPreview>
  revertExecute?: (sheetId: string, previewIdentity: string) => Promise<ResetResult>
  onDone?: () => void | Promise<void>
}>()

const RECENT_HISTORY_LIMIT = 20

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey): string => recordLabel(key, isZh.value)

const selectedBatchId = ref('')
const selectedSheetId = ref('')
const historyBatches = ref<HistoryBatchSummary[]>([])
const historyLoading = ref(false)
const historyError = ref<string | null>(null)
let historyLoadSeq = 0

const recoveryEnabled = computed(() => props.pitResetEnabled === true || props.sheetRevertEnabled === true)
const revertReady = computed(() =>
  props.sheetRevertEnabled === true &&
  typeof props.revertPreview === 'function' &&
  typeof props.revertExecute === 'function',
)
const pickerHeadingKey = computed<MetaRecordLabelKey>(() => {
  if (props.pitResetEnabled === true && props.sheetRevertEnabled === true) return 'record.recoveryPickerHeading'
  return props.sheetRevertEnabled === true ? 'record.revertPickerHeading' : 'record.resetPickerHeading'
})
const pickerNoteKey = computed<MetaRecordLabelKey>(() =>
  props.sheetRevertEnabled === true ? 'record.recoveryPickerExactAnchorNote' : 'record.resetPickerExactAnchorNote',
)

function hasUsableCreatedAt(batch: HistoryBatchSummary): boolean {
  return typeof batch.createdAt === 'string' && batch.createdAt.length > 0 && !Number.isNaN(new Date(batch.createdAt).getTime())
}

function historyBatchLabel(batch: HistoryBatchSummary): string {
  const when = new Date(batch.createdAt).toLocaleString()
  const actor = batch.actorName || batch.actorId || l('record.resetPickerSystemActor')
  const action = batch.action || l('record.resetPickerDefaultAction')
  const records = resetPickerRecordCount(batch.visibleAffectedRecordCount, isZh.value)
  return `${when} - ${action} - ${actor} - ${records}`
}

const canLoadHistory = computed(() =>
  recoveryEnabled.value &&
  typeof props.baseId === 'string' &&
  props.baseId.length > 0 &&
  typeof props.listHistoryEvents === 'function',
)

const historyOptions = computed(() => historyBatches.value.filter(hasUsableCreatedAt))
const selectedHistoryBatch = computed(() =>
  historyOptions.value.find((batch) => batch.batchId === selectedBatchId.value) ?? null,
)
const shortSelectedBatchId = computed(() => selectedHistoryBatch.value?.batchId.slice(0, 8) ?? '')
const historyAsOf = computed<string | null>(() => selectedHistoryBatch.value?.createdAt ?? null)
// The SOLE T-source: an exact Global History batch id — never a free wall-clock time.
const anchor = computed<ExactAnchorRequest | null>(() =>
  selectedHistoryBatch.value ? { historyBatchId: selectedHistoryBatch.value.batchId } : null,
)
// Derived FROM the selected batch (never from free-form input), so the displayed target and the anchor the
// destructive op uses can never diverge.
const targetDisplay = computed(() => (historyAsOf.value ? new Date(historyAsOf.value).toLocaleString() : ''))

async function loadHistoryBatches(): Promise<void> {
  const loadSeq = ++historyLoadSeq
  if (!canLoadHistory.value) {
    historyBatches.value = []
    selectedBatchId.value = ''
    historyError.value = null
    historyLoading.value = false
    return
  }

  const baseId = props.baseId as string
  const listHistoryEvents = props.listHistoryEvents as ListHistoryEvents
  historyLoading.value = true
  historyError.value = null
  try {
    const res = await listHistoryEvents(baseId, { sheetId: props.sheetId, limit: RECENT_HISTORY_LIMIT })
    if (loadSeq !== historyLoadSeq) return
    historyBatches.value = Array.isArray(res.batches) ? res.batches : []
    if (!historyOptions.value.some((batch) => batch.batchId === selectedBatchId.value)) {
      selectedBatchId.value = ''
    }
  } catch (err) {
    if (loadSeq !== historyLoadSeq) return
    historyBatches.value = []
    selectedBatchId.value = ''
    historyError.value = err instanceof Error ? err.message : l('record.resetPickerErrorLoad')
  } finally {
    if (loadSeq === historyLoadSeq) historyLoading.value = false
  }
}

function resetHistoryScope(): void {
  ++historyLoadSeq
  selectedBatchId.value = ''
  selectedSheetId.value = ''
  historyBatches.value = []
  historyError.value = null
  historyLoading.value = false
}

watch(
  selectedBatchId,
  (batchId) => {
    selectedSheetId.value = batchId ? props.sheetId : ''
  },
  { flush: 'sync' },
)

watch(
  () => [props.pitResetEnabled === true, props.sheetRevertEnabled === true, props.baseId, props.sheetId, props.listHistoryEvents] as const,
  () => {
    // Scope switches revoke the old selection synchronously. The frozen sheet id below then prevents even
    // a same-tick stale modal callback from pairing an old anchor with the newly selected sheet.
    resetHistoryScope()
    void loadHistoryBatches()
  },
  { immediate: true },
)

function staleSelectionError(): Error & { status: number; code: string } {
  return Object.assign(new Error('The selected recovery scope changed; re-preview.'), {
    status: 409,
    code: 'PREVIEW_IDENTITY_INVALID',
  })
}

const boundPreview = (a: ExactAnchorRequest): Promise<ResetPreview> =>
  selectedSheetId.value ? props.resetPreview(selectedSheetId.value, a) : Promise.reject(staleSelectionError())
const boundExecute = (identity: string): Promise<ResetResult> =>
  selectedSheetId.value ? props.resetExecute(selectedSheetId.value, identity) : Promise.reject(staleSelectionError())
const boundRevertPreview = (a: ExactAnchorRequest): Promise<ResetPreview> =>
  selectedSheetId.value && props.revertPreview
    ? props.revertPreview(selectedSheetId.value, a)
    : Promise.reject(staleSelectionError())
const boundRevertExecute = (identity: string): Promise<ResetResult> =>
  selectedSheetId.value && props.revertExecute
    ? props.revertExecute(selectedSheetId.value, identity)
    : Promise.reject(staleSelectionError())

async function handleDone(): Promise<void> {
  try {
    await props.onDone?.()
  } finally {
    await loadHistoryBatches()
  }
}
</script>

<style scoped>
.reset-picker { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid #fda29b; border-radius: 8px; background: #fffbfa; }
.reset-picker__history { display: flex; flex-direction: column; gap: 6px; }
.reset-picker__heading { font-size: 13px; font-weight: 600; color: #912018; }
.reset-picker__history-row { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.reset-picker__label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #912018; }
.reset-picker__input { padding: 6px 8px; border: 1px solid #d0d5dd; border-radius: 6px; max-width: 240px; }
.reset-picker__select { min-width: min(520px, 100%); max-width: min(640px, 100%); }
/* .reset-picker__refresh: the Refresh control is now <MtButton> (ghost, token-styled); its bespoke
   hardcoded-hex CSS was removed to avoid double-styling the MtButton root. Class + data-test kept for
   selector stability. */
.reset-picker__hint { font-size: 12px; margin: 0; }
.reset-picker__hint--warn { color: #b42318; }
.reset-picker__target { font-size: 13px; margin: 0; }
</style>
