<!--
  T8-2 Reset UI — T-source picker (the product entry the #3250 dialog was missing; #3250/#3251 flagged
  "entry-wiring needs a T-source"). Lets a sheet-admin pick a point-in-time T and hands it to the existing
  ResetConfirmDialog as `asOf`. The dialog owns preview → typed two-step confirm → execute; this only sources T.

  T-source = recent Global History batch timestamps first. The free datetime-local picker remains as an advanced
  fallback, but the normal destructive path is anchored to an audited history batch and passes that batch's
  `createdAt` ISO to reset-preview/execute.

  Timezone: datetime-local is browser-local; `asOf` is the corresponding UTC ISO for the API. The human-facing
  "Target" line is derived FROM `asOf` (not the raw input), so what the user sees can never diverge from what the
  destructive op uses. Gated on `pitResetEnabled` ALONE (it already encodes flag ∧ canManageSheetAccess); the
  dialog is mounted only once T is valid & past, so the dialog's own "Reset to {asOf}…" button never fires empty.
-->
<template>
  <div v-if="pitResetEnabled" class="reset-picker" data-test="reset-picker">
    <div class="reset-picker__history" data-test="reset-picker-history">
      <div class="reset-picker__heading">Reset this sheet to a Global History point</div>
      <div class="reset-picker__history-row">
        <label class="reset-picker__label">
          <span>History point</span>
          <select
            class="reset-picker__input reset-picker__select"
            data-test="reset-picker-history-select"
            v-model="selectedBatchId"
            :disabled="historyLoading || historyOptions.length === 0"
            @change="mode = 'history'"
          >
            <option value="">Select a recent history batch</option>
            <option v-for="batch in historyOptions" :key="batch.batchId" :value="batch.batchId">
              {{ historyBatchLabel(batch) }}
            </option>
          </select>
        </label>
        <button
          type="button"
          class="reset-picker__refresh"
          data-test="reset-picker-history-refresh"
          :disabled="historyLoading || !canLoadHistory"
          @click="loadHistoryBatches"
        >
          Refresh
        </button>
      </div>
      <p v-if="historyLoading" class="reset-picker__hint" data-test="reset-picker-history-loading">Loading history points...</p>
      <p v-else-if="historyError" class="reset-picker__hint reset-picker__hint--warn" data-test="reset-picker-history-error">{{ historyError }}</p>
      <p v-else-if="canLoadHistory && historyOptions.length === 0" class="reset-picker__hint" data-test="reset-picker-history-empty">No recent history batches found.</p>
      <p v-else-if="!canLoadHistory" class="reset-picker__hint" data-test="reset-picker-history-unavailable">History points unavailable.</p>
    </div>

    <details class="reset-picker__manual" data-test="reset-picker-manual">
      <summary>Advanced manual time</summary>
      <label class="reset-picker__label">
        <span>Manual point in time</span>
        <input
          type="datetime-local"
          class="reset-picker__input"
          data-test="reset-picker-input"
          v-model="localValue"
          :max="nowLocalValue"
          @input="mode = 'manual'"
        />
      </label>
    </details>

    <!-- datetime-local coerces invalid text to '' so a non-empty-unparseable value can't occur; if `asOf` is somehow
         null it simply renders nothing below (fail-safe: no dialog), so no separate invalid branch is needed. -->
    <p v-if="asOf && isFuture" class="reset-picker__hint reset-picker__hint--warn" data-test="reset-picker-future">
      Pick a time in the past — you can only reset to an earlier state.
    </p>

    <template v-else-if="asOf">
      <p class="reset-picker__target" data-test="reset-picker-target">
        Target: <strong>{{ targetDisplay }}</strong> (your local time)
        <span v-if="selectedHistoryBatch && mode === 'history'"> from history batch {{ shortSelectedBatchId }}</span>
      </p>
      <ResetConfirmDialog
        :pit-reset-enabled="true"
        :as-of="asOf"
        :reset-preview="boundPreview"
        :reset-execute="boundExecute"
        :on-done="onDone"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import ResetConfirmDialog from './ResetConfirmDialog.vue'
import type { ResetPreview, ResetResult } from '../api/client'
import type { HistoryBatchSummary } from '../types'

type ListHistoryEvents = (
  baseId: string,
  params?: { sheetId?: string; limit?: number },
) => Promise<{ batches: HistoryBatchSummary[] }>

const props = defineProps<{
  /** flag-derived capability (MULTITABLE_ENABLE_PIT_RESET ∧ canManageSheetAccess); off/absent ⇒ whole entry hidden. */
  pitResetEnabled?: boolean
  /** base-level Global History scope. Required for the primary history-anchored picker path. */
  baseId?: string
  /** bound here (not in the dialog) so the (sheetId, asOf) wiring is covered by THIS component's unit test. */
  sheetId: string
  listHistoryEvents?: ListHistoryEvents
  resetPreview: (sheetId: string, asOf: string) => Promise<ResetPreview>
  resetExecute: (sheetId: string, asOf: string, previewIdentity: string) => Promise<ResetResult>
  onDone?: () => void
}>()

const RECENT_HISTORY_LIMIT = 20

const localValue = ref('')
const selectedBatchId = ref('')
const historyBatches = ref<HistoryBatchSummary[]>([])
const historyLoading = ref(false)
const historyError = ref<string | null>(null)
const mode = ref<'history' | 'manual'>('history')
let historyLoadSeq = 0

/** The single T-source seam: a browser-local datetime-local string → UTC ISO instant, or null if unparseable. */
function localToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local) // datetime-local has no offset → interpreted in the browser's local tz
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function hasUsableCreatedAt(batch: HistoryBatchSummary): boolean {
  return typeof batch.createdAt === 'string' && batch.createdAt.length > 0 && !Number.isNaN(new Date(batch.createdAt).getTime())
}

function historyBatchLabel(batch: HistoryBatchSummary): string {
  const when = new Date(batch.createdAt).toLocaleString()
  const actor = batch.actorName || batch.actorId || 'System'
  const action = batch.action || 'update'
  const records = batch.visibleAffectedRecordCount === 1 ? '1 record' : `${batch.visibleAffectedRecordCount} records`
  return `${when} - ${action} - ${actor} - ${records}`
}

const canLoadHistory = computed(() =>
  props.pitResetEnabled === true &&
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
const manualAsOf = computed<string | null>(() => localToIso(localValue.value))
const asOf = computed<string | null>(() => (mode.value === 'manual' ? manualAsOf.value : historyAsOf.value))
// Derived FROM asOf (never from the raw input) so the displayed target and the API asOf cannot diverge.
const targetDisplay = computed(() => (asOf.value ? new Date(asOf.value).toLocaleString() : ''))
const isFuture = computed(() => (asOf.value ? new Date(asOf.value).getTime() > Date.now() : false))

// `:max` on the input (local wall-clock now) so the picker discourages future selection before the isFuture guard.
const nowLocalValue = computed(() => {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
})

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
      if (mode.value !== 'manual') mode.value = 'history'
    }
  } catch (err) {
    if (loadSeq !== historyLoadSeq) return
    historyBatches.value = []
    selectedBatchId.value = ''
    historyError.value = err instanceof Error ? err.message : 'Failed to load history points'
  } finally {
    if (loadSeq === historyLoadSeq) historyLoading.value = false
  }
}

watch(
  () => [props.pitResetEnabled === true, props.baseId, props.sheetId, props.listHistoryEvents] as const,
  () => {
    void loadHistoryBatches()
  },
  { immediate: true },
)

const boundPreview = (a: string): Promise<ResetPreview> => props.resetPreview(props.sheetId, a)
const boundExecute = (a: string, identity: string): Promise<ResetResult> => props.resetExecute(props.sheetId, a, identity)
</script>

<style scoped>
.reset-picker { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid #fda29b; border-radius: 8px; background: #fffbfa; }
.reset-picker__history { display: flex; flex-direction: column; gap: 6px; }
.reset-picker__heading { font-size: 13px; font-weight: 600; color: #912018; }
.reset-picker__history-row { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.reset-picker__label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #912018; }
.reset-picker__input { padding: 6px 8px; border: 1px solid #d0d5dd; border-radius: 6px; max-width: 240px; }
.reset-picker__select { min-width: min(520px, 100%); max-width: min(640px, 100%); }
.reset-picker__refresh { padding: 6px 10px; border: 1px solid #d0d5dd; border-radius: 6px; background: #fff; color: #912018; cursor: pointer; }
.reset-picker__refresh:disabled { cursor: default; opacity: 0.6; }
.reset-picker__manual { color: #912018; font-size: 12px; }
.reset-picker__manual > summary { cursor: pointer; }
.reset-picker__manual .reset-picker__label { margin-top: 6px; }
.reset-picker__hint { font-size: 12px; margin: 0; }
.reset-picker__hint--warn { color: #b42318; }
.reset-picker__target { font-size: 13px; margin: 0; }
</style>
