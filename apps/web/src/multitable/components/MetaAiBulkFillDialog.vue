<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="ai-bulk-overlay"
      data-test="ai-bulk-fill"
      @click.self="onClose"
    >
      <div class="ai-bulk-modal" role="dialog" :aria-label="l('aibulk.title')" aria-modal="true">
        <div class="ai-bulk__header">
          <strong>{{ l('aibulk.title') }}</strong>
          <span class="ai-bulk__field" data-test="ai-bulk-field">{{ fieldName(fieldId) }}</span>
          <button class="ai-bulk__close" :aria-label="l('aibulk.close')" @click="onClose">&times;</button>
        </div>

        <div class="ai-bulk__body">
          <!-- Error banner: code-keyed copy, shown in every phase. RATE_LIMITED adds a countdown. -->
          <p
            v-if="ctrl.state.error"
            class="ai-bulk__alert ai-bulk__alert--error"
            role="alert"
            data-test="ai-bulk-error"
          >
            {{ errorMessage }}
            <span v-if="ctrl.state.retryRemainingMs" data-test="ai-bulk-retry">
              · {{ retryCountdown }}
            </span>
          </p>

          <!-- ───────────────────────── Phase: scope (idle) ───────────────────────── -->
          <template v-if="ctrl.state.phase === 'idle' || ctrl.state.phase === 'previewing'">
            <fieldset class="ai-bulk__scope" data-test="ai-bulk-scope">
              <label class="ai-bulk__scope-opt">
                <input
                  type="radio"
                  name="ai-bulk-scope"
                  value="view"
                  :checked="scope === 'view'"
                  :disabled="ctrl.busy.value"
                  @change="scope = 'view'"
                />
                <span>
                  <span class="ai-bulk__scope-label">{{ l('aibulk.scopeView') }}</span>
                  <span class="ai-bulk__scope-hint">{{ l('aibulk.scopeViewHint') }}</span>
                </span>
              </label>
              <label v-if="hasSelection" class="ai-bulk__scope-opt">
                <input
                  type="radio"
                  name="ai-bulk-scope"
                  value="selection"
                  :checked="scope === 'selection'"
                  :disabled="ctrl.busy.value"
                  @change="scope = 'selection'"
                />
                <span>
                  <span class="ai-bulk__scope-label">{{ l('aibulk.scopeSelection') }} ({{ selectedRecordIds.length }})</span>
                  <span class="ai-bulk__scope-hint">{{ l('aibulk.scopeSelectionHint') }}</span>
                </span>
              </label>
            </fieldset>

            <!-- Cost honesty: the abandon-still-charged warning, BEFORE generation. -->
            <p class="ai-bulk__quota-note" role="note" data-test="ai-bulk-quota-note">{{ l('aibulk.quotaNote') }}</p>
          </template>

          <!-- ───────────────────────── Phase: review ───────────────────────── -->
          <template v-else-if="ctrl.state.phase === 'review'">
            <!-- Cost + summary header (cost already charged). -->
            <div class="ai-bulk__result-head">
              <span class="ai-bulk__cost" data-test="ai-bulk-cost">{{ costLine }}</span>
              <span class="ai-bulk__summary" data-test="ai-bulk-summary">{{ previewSummary }}</span>
            </div>
            <p class="ai-bulk__quota-note ai-bulk__quota-note--compact" role="note">{{ l('aibulk.quotaNote') }}</p>

            <!-- Partial (capped) — broke early, NO count (oracle guard). -->
            <p
              v-if="ctrl.partial.value"
              class="ai-bulk__alert ai-bulk__alert--warn"
              role="alert"
              data-test="ai-bulk-partial"
            >
              {{ l('aibulk.partialNotice') }}
            </p>

            <!-- Confirmable rows — the ONLY selectable rows (masked included, badged). -->
            <template v-if="ctrl.rows.value.length > 0">
              <table class="ai-bulk__table" data-test="ai-bulk-rows">
                <thead>
                  <tr>
                    <th class="ai-bulk__col-select">
                      <input
                        type="checkbox"
                        :aria-label="l('aibulk.selectAll')"
                        :checked="ctrl.allConfirmableSelected.value"
                        data-test="ai-bulk-select-all"
                        @change="onToggleAll"
                      />
                    </th>
                    <th>{{ l('aibulk.colRecord') }}</th>
                    <th>{{ l('aibulk.colCurrent') }}</th>
                    <th>{{ l('aibulk.colProposed') }}</th>
                    <th>{{ l('aibulk.colState') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in ctrl.rows.value"
                    :key="row.recordId"
                    class="ai-bulk__row"
                    :data-record-id="row.recordId"
                    data-test="ai-bulk-row"
                  >
                    <td class="ai-bulk__col-select">
                      <input
                        type="checkbox"
                        :aria-label="l('aibulk.colSelect')"
                        :checked="ctrl.selected.value.has(row.recordId)"
                        :data-record-id="row.recordId"
                        data-test="ai-bulk-row-select"
                        @change="ctrl.toggleRow(row.recordId)"
                      />
                    </td>
                    <td class="ai-bulk__cell-record">{{ recordName(row.recordId) }}</td>
                    <td class="ai-bulk__cell-current">{{ currentValue(row.recordId) }}</td>
                    <td class="ai-bulk__cell-proposed">{{ row.proposed }}</td>
                    <td class="ai-bulk__cell-state">
                      <span
                        v-if="row.masked"
                        class="ai-bulk__badge ai-bulk__badge--masked"
                        :title="l('aibulk.badgeMaskedTitle')"
                        data-test="ai-bulk-badge-masked"
                      >{{ l('aibulk.badgeMasked') }}</span>
                      <span
                        v-else
                        class="ai-bulk__badge ai-bulk__badge--ready"
                        data-test="ai-bulk-badge-ready"
                      >{{ l('aibulk.badgeConfirmable') }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>
            <p v-else class="ai-bulk__empty" data-test="ai-bulk-empty">{{ l('aibulk.emptyConfirmable') }}</p>

            <!-- Skipped — UNCHARGED, NON-selectable, distinct reasons. -->
            <section v-if="ctrl.skipped.value.length > 0" class="ai-bulk__group" data-test="ai-bulk-skipped">
              <h4 class="ai-bulk__group-title">{{ l('aibulk.skippedHeading') }} ({{ ctrl.skipped.value.length }})</h4>
              <p class="ai-bulk__group-note">{{ l('aibulk.skippedNote') }}</p>
              <ul class="ai-bulk__group-list">
                <li
                  v-for="s in ctrl.skipped.value"
                  :key="s.recordId"
                  class="ai-bulk__group-item"
                  :data-record-id="s.recordId"
                  data-test="ai-bulk-skipped-item"
                >
                  <span class="ai-bulk__group-record">{{ recordName(s.recordId) }}</span>
                  <span class="ai-bulk__group-reason">{{ skippedReason(s.reason) }}</span>
                </li>
              </ul>
            </section>

            <!-- Failures — CHARGED but non-confirmable, NON-selectable, distinct reasons. -->
            <section v-if="ctrl.failures.value.length > 0" class="ai-bulk__group ai-bulk__group--charged" data-test="ai-bulk-failures">
              <h4 class="ai-bulk__group-title">{{ l('aibulk.failuresHeading') }} ({{ ctrl.failures.value.length }})</h4>
              <p class="ai-bulk__group-note">{{ l('aibulk.failuresNote') }}</p>
              <ul class="ai-bulk__group-list">
                <li
                  v-for="f in ctrl.failures.value"
                  :key="f.recordId"
                  class="ai-bulk__group-item"
                  :data-record-id="f.recordId"
                  data-test="ai-bulk-failure-item"
                >
                  <span class="ai-bulk__group-record">{{ recordName(f.recordId) }}</span>
                  <span class="ai-bulk__group-reason">{{ failureReason(f.reason) }}</span>
                </li>
              </ul>
            </section>
          </template>

          <!-- ───────────────────────── Phase: committing / done ───────────────────────── -->
          <template v-else-if="ctrl.state.phase === 'committing' || ctrl.state.phase === 'done'">
            <div v-if="commitData" class="ai-bulk__result-head">
              <span class="ai-bulk__summary ai-bulk__summary--strong" data-test="ai-bulk-commit-summary">{{ commitSummary }}</span>
            </div>

            <!-- All-expired (run TTL lapsed): re-preview prompt, never a blank success. -->
            <p
              v-if="commitData && allExpired"
              class="ai-bulk__alert ai-bulk__alert--warn"
              role="alert"
              data-test="ai-bulk-all-expired"
            >
              {{ l('aibulk.allExpired') }}
            </p>

            <!-- Stale guidance: any row needs a re-preview. -->
            <p
              v-if="commitData && hasStale"
              class="ai-bulk__alert ai-bulk__alert--warn"
              role="alert"
              data-test="ai-bulk-stale-guidance"
            >
              {{ l('aibulk.outcomeStaleGuidance') }}
            </p>

            <table v-if="commitData" class="ai-bulk__table" data-test="ai-bulk-outcomes">
              <thead>
                <tr>
                  <th>{{ l('aibulk.colRecord') }}</th>
                  <th>{{ l('aibulk.outcomeHeading') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="o in commitData.outcomes"
                  :key="o.recordId"
                  class="ai-bulk__row"
                  :data-record-id="o.recordId"
                  :data-outcome="o.outcome"
                  data-test="ai-bulk-outcome-row"
                >
                  <td class="ai-bulk__cell-record">{{ recordName(o.recordId) }}</td>
                  <td>
                    <span
                      class="ai-bulk__badge"
                      :class="outcomeBadgeClass(o.outcome)"
                      :data-outcome="o.outcome"
                      data-test="ai-bulk-outcome-badge"
                    >{{ outcomeLabel(o.outcome) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <div class="ai-bulk__footer">
          <!-- idle/previewing: generate -->
          <template v-if="ctrl.state.phase === 'idle' || ctrl.state.phase === 'previewing'">
            <button type="button" class="ai-bulk__btn" @click="onClose">{{ l('aibulk.cancel') }}</button>
            <button
              type="button"
              class="ai-bulk__btn ai-bulk__btn--primary"
              :disabled="ctrl.busy.value"
              data-test="ai-bulk-generate"
              @click="onGenerate"
            >
              {{ ctrl.state.phase === 'previewing' ? l('aibulk.generating') : l('aibulk.generate') }}
            </button>
          </template>

          <!-- review: confirm selected -->
          <template v-else-if="ctrl.state.phase === 'review'">
            <button type="button" class="ai-bulk__btn" @click="onClose">{{ l('aibulk.cancel') }}</button>
            <button
              type="button"
              class="ai-bulk__btn ai-bulk__btn--primary"
              :disabled="ctrl.busy.value || ctrl.selectedCount.value === 0"
              data-test="ai-bulk-confirm"
              @click="onConfirm"
            >
              {{ ctrl.state.phase === 'committing' ? l('aibulk.committing') : confirmLabel }}
            </button>
          </template>

          <!-- committing/done: done -->
          <template v-else>
            <button
              type="button"
              class="ai-bulk__btn ai-bulk__btn--primary"
              :disabled="ctrl.state.phase === 'committing'"
              data-test="ai-bulk-done"
              @click="onClose"
            >
              {{ ctrl.state.phase === 'committing' ? l('aibulk.committing') : l('aibulk.done') }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { AiBulkCommitOutcome } from '../api/client'
import type { useAiBulkFill } from '../composables/useAiBulkFill'
import { aiBulkErrorMessage, aiRetryCountdown } from '../utils/meta-api-error-labels'
import {
  aiBulkCommitSummary,
  aiBulkCostLine,
  aiBulkFailureReason,
  aiBulkLabel,
  aiBulkOutcomeLabel,
  aiBulkPreviewSummary,
  aiBulkSkippedReason,
  type MetaAiBulkLabelKey,
} from '../utils/meta-ai-bulk-labels'

type BulkFillController = ReturnType<typeof useAiBulkFill>

const props = defineProps<{
  visible: boolean
  /** The shared useAiBulkFill instance (the Workbench owns it). */
  controller: BulkFillController
  /** The target field id (must have a persisted aiShortcut). */
  fieldId: string
  /** The active view id (scope:'view'). */
  viewId: string
  /** Currently-selected grid record ids (enables scope:'selection'). */
  selectedRecordIds: string[]
  /** Resolve a field id → display name. */
  fieldName: (fieldId: string) => string
  /** Resolve a record id → a short display label (e.g. primary-field value). */
  recordName: (recordId: string) => string
  /** Resolve a record id → its CURRENT value for the target field (the diff "before"). */
  currentValueFor: (recordId: string) => string
  isZh: boolean
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const ctrl = props.controller
const l = (key: MetaAiBulkLabelKey): string => aiBulkLabel(key, props.isZh)

const scope = ref<'view' | 'selection'>('view')
const hasSelection = computed(() => props.selectedRecordIds.length > 0)

// When the dialog opens, reset the scope choice (default to view).
watch(
  () => props.visible,
  (open) => {
    if (open) scope.value = 'view'
  },
)

const errorMessage = computed(() => {
  const err = ctrl.state.error
  if (!err) return ''
  return aiBulkErrorMessage(err.code, props.isZh) ?? err.message
})

const retryCountdown = computed(() => {
  const ms = ctrl.state.retryRemainingMs
  if (!ms) return ''
  return aiRetryCountdown(Math.ceil(ms / 1000), props.isZh)
})

const costLine = computed(() => aiBulkCostLine(ctrl.settledCost.value, props.isZh))
const previewSummary = computed(() =>
  aiBulkPreviewSummary(ctrl.confirmableCount.value, ctrl.skipped.value.length, ctrl.failures.value.length, props.isZh),
)
const confirmLabel = computed(() => `${l('aibulk.confirm')} (${ctrl.selectedCount.value})`)

const commitData = computed(() => ctrl.state.commit)
const commitSummary = computed(() => (commitData.value ? aiBulkCommitSummary(commitData.value.counts, props.isZh) : ''))
const hasStale = computed(() => (commitData.value?.counts.stale_reprev ?? 0) > 0)
const allExpired = computed(() => {
  const c = commitData.value
  if (!c || c.outcomes.length === 0) return false
  return c.outcomes.every((o) => o.outcome === 'not_in_cache')
})

function recordName(recordId: string): string {
  return props.recordName(recordId)
}
function currentValue(recordId: string): string {
  const v = props.currentValueFor(recordId)
  return v === '' ? l('aibulk.currentEmpty') : v
}
function skippedReason(reason: string): string {
  return aiBulkSkippedReason(reason, props.isZh)
}
function failureReason(reason: string): string {
  return aiBulkFailureReason(reason, props.isZh)
}
function outcomeLabel(outcome: string): string {
  return aiBulkOutcomeLabel(outcome, props.isZh)
}
function outcomeBadgeClass(outcome: AiBulkCommitOutcome): string {
  return outcome === 'written' ? 'ai-bulk__badge--ready' : 'ai-bulk__badge--warn'
}

function onToggleAll(): void {
  if (ctrl.allConfirmableSelected.value) ctrl.clearSelection()
  else ctrl.selectAllConfirmable()
}

function onGenerate(): void {
  if (ctrl.busy.value) return
  if (scope.value === 'selection') {
    void ctrl.preview({ fieldId: props.fieldId, scope: 'view', viewId: props.viewId, recordIds: props.selectedRecordIds })
  } else {
    void ctrl.preview({ fieldId: props.fieldId, scope: 'view', viewId: props.viewId })
  }
}

function onConfirm(): void {
  if (ctrl.busy.value || ctrl.selectedCount.value === 0) return
  void ctrl.commit()
}

function onClose(): void {
  ctrl.reset()
  emit('close')
}
</script>

<style scoped>
.ai-bulk-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 24px;
}
.ai-bulk-modal {
  background: #fff;
  border-radius: 10px;
  width: min(820px, 100%);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.25);
}
.ai-bulk__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid #e2e8f0;
}
.ai-bulk__header strong {
  font-size: 15px;
}
.ai-bulk__field {
  font-size: 12px;
  color: #64748b;
  background: #f1f5f9;
  border-radius: 4px;
  padding: 2px 8px;
}
.ai-bulk__close {
  margin-left: auto;
  border: none;
  background: none;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: #64748b;
}
.ai-bulk__body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ai-bulk__scope {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}
.ai-bulk__scope-opt {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  cursor: pointer;
}
.ai-bulk__scope-opt span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ai-bulk__scope-label {
  font-size: 13px;
  font-weight: 600;
}
.ai-bulk__scope-hint {
  font-size: 12px;
  color: #64748b;
}
.ai-bulk__quota-note {
  font-size: 12px;
  color: #92400e;
  background: #fef3c7;
  border-radius: 6px;
  padding: 8px 10px;
  margin: 0;
}
.ai-bulk__quota-note--compact {
  background: transparent;
  padding: 0;
  color: #b45309;
}
.ai-bulk__alert {
  font-size: 13px;
  border-radius: 6px;
  padding: 8px 10px;
  margin: 0;
}
.ai-bulk__alert--error {
  color: #b91c1c;
  background: #fee2e2;
}
.ai-bulk__alert--warn {
  color: #92400e;
  background: #fef3c7;
}
.ai-bulk__result-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: baseline;
}
.ai-bulk__cost {
  font-size: 13px;
  font-weight: 600;
  color: #334155;
}
.ai-bulk__summary {
  font-size: 12px;
  color: #475569;
}
.ai-bulk__summary--strong {
  font-size: 14px;
  font-weight: 600;
  color: #0f172a;
}
.ai-bulk__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.ai-bulk__table th,
.ai-bulk__table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: top;
}
.ai-bulk__table th {
  color: #64748b;
  font-weight: 600;
  border-bottom-color: #e2e8f0;
}
.ai-bulk__col-select {
  width: 44px;
}
.ai-bulk__cell-current {
  color: #94a3b8;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 220px;
}
.ai-bulk__cell-proposed {
  color: #0f172a;
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 260px;
}
.ai-bulk__badge {
  display: inline-block;
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 8px;
  white-space: nowrap;
}
.ai-bulk__badge--ready {
  color: #166534;
  background: #dcfce7;
}
.ai-bulk__badge--masked {
  color: #9a3412;
  background: #ffedd5;
}
.ai-bulk__badge--warn {
  color: #92400e;
  background: #fef3c7;
}
.ai-bulk__empty {
  font-size: 13px;
  color: #64748b;
  margin: 0;
}
.ai-bulk__group {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
}
.ai-bulk__group--charged {
  border-color: #fcd34d;
  background: #fffbeb;
}
.ai-bulk__group-title {
  font-size: 13px;
  margin: 0 0 4px;
}
.ai-bulk__group-note {
  font-size: 12px;
  color: #64748b;
  margin: 0 0 8px;
}
.ai-bulk__group-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ai-bulk__group-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
}
.ai-bulk__group-record {
  color: #334155;
}
.ai-bulk__group-reason {
  color: #92400e;
  white-space: nowrap;
}
.ai-bulk__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid #e2e8f0;
}
.ai-bulk__btn {
  font-size: 13px;
  border-radius: 6px;
  padding: 7px 14px;
  border: 1px solid #cbd5e1;
  background: #fff;
  cursor: pointer;
}
.ai-bulk__btn--primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #fff;
}
.ai-bulk__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
