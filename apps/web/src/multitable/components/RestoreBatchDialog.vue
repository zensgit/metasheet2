<template>
  <Teleport to="body">
    <div v-if="visible" class="restore-batch-overlay" data-test="restore-batch" @click.self="onCancel">
      <div class="restore-batch-modal" role="dialog" :aria-label="l('record.batchRestoreTitle')">
        <div class="restore-batch__header">
          <strong>{{ l('record.batchRestoreTitle') }}</strong>
          <button class="restore-batch__close" :aria-label="l('record.batchRestoreCancel')" @click="onCancel">&times;</button>
        </div>

        <!-- Target control: default = revert to original (v1); Advanced reveals a version-N picker (the MIX entry). -->
        <div v-if="phase === 'preview'" class="restore-batch__target">
          <p class="restore-batch__revert">{{ l('record.batchRestoreRevertOriginal') }}</p>
          <button type="button" class="restore-batch__advanced-toggle" data-test="batch-restore-advanced" @click="advancedOpen = !advancedOpen">
            {{ l('record.batchRestoreAdvanced') }}
          </button>
          <label v-if="advancedOpen" class="restore-batch__version">
            <span>{{ l('record.batchRestoreVersionLabel') }}</span>
            <input
              type="number"
              min="1"
              class="restore-batch__version-input"
              data-test="batch-restore-version"
              :value="versionInput"
              @change="onVersionChange"
              @keyup.enter="onVersionChange"
            />
          </label>
        </div>

        <div class="restore-batch__body">
          <p v-if="loading" class="restore-batch__hint" data-test="batch-restore-loading">{{ l('record.batchRestoreLoading') }}</p>

          <!-- Preview phase: per-record restorable / skipped(reason). -->
          <template v-else-if="phase === 'preview'">
            <ul class="restore-batch__list" data-test="batch-restore-preview-list">
              <li v-for="rec in previewRecords" :key="rec.recordId" class="restore-batch__row" :data-status="rec.status">
                <span class="restore-batch__rec">{{ recordLabelOf(rec.recordId) }}</span>
                <span v-if="rec.status === 'restorable'" class="restore-batch__chip restore-batch__chip--ok" data-test="batch-restorable">
                  {{ l('record.batchRestoreSummaryRestorable') }}
                </span>
                <span v-else class="restore-batch__chip restore-batch__chip--skip" data-test="batch-skipped">
                  {{ skipReason(rec.skipReason) }}
                </span>
              </li>
            </ul>
            <p v-if="restorableCount === 0" class="restore-batch__hint restore-batch__hint--warn" role="alert" data-test="batch-restore-none">
              {{ l('record.batchRestoreNoneRestorable') }}
            </p>
            <p v-else class="restore-batch__summary" data-test="batch-restore-summary">
              {{ restorableCount }} {{ l('record.batchRestoreSummaryRestorable') }} · {{ skippedCount }} {{ l('record.batchRestoreSummarySkipped') }}
            </p>
          </template>

          <!-- Result phase: per-record restored / skipped(reason). -->
          <template v-else>
            <p class="restore-batch__label">{{ l('record.batchRestoreResultTitle') }}</p>
            <ul class="restore-batch__list" data-test="batch-restore-result-list">
              <li v-for="rec in resultRecords" :key="rec.recordId" class="restore-batch__row" :data-status="rec.status">
                <span class="restore-batch__rec">{{ recordLabelOf(rec.recordId) }}</span>
                <span v-if="rec.status === 'restored'" class="restore-batch__chip restore-batch__chip--ok" data-test="batch-restored">
                  {{ l('record.batchRestoreRestored') }}
                </span>
                <span v-else class="restore-batch__chip restore-batch__chip--skip" data-test="batch-result-skipped">
                  {{ skipReason(rec.skipReason) }}
                </span>
              </li>
            </ul>
            <p class="restore-batch__summary" data-test="batch-restore-result-summary">
              {{ restoredCount }} {{ l('record.batchRestoreRestored') }} · {{ skippedCount }} {{ l('record.batchRestoreSummarySkipped') }}
            </p>
          </template>
        </div>

        <div class="restore-batch__footer">
          <template v-if="phase === 'preview'">
            <button type="button" class="restore-batch__btn" @click="onCancel">{{ l('record.batchRestoreCancel') }}</button>
            <button
              type="button"
              class="restore-batch__btn restore-batch__btn--primary"
              :disabled="!canConfirm"
              data-test="batch-restore-confirm"
              @click="onConfirm"
            >
              {{ l('record.batchRestoreConfirm') }}
            </button>
          </template>
          <button v-else type="button" class="restore-batch__btn restore-batch__btn--primary" data-test="batch-restore-done" @click="onDone">
            {{ l('record.batchRestoreDone') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import type { RestoreBatchPreviewRecord, RestoreBatchExecuteRecord } from '../api/client'
import { recordLabel, batchSkipReasonLabel, type MetaRecordLabelKey } from '../utils/meta-record-labels'

const props = defineProps<{
  visible: boolean
  phase: 'preview' | 'result'
  loading: boolean
  targetVersion: number
  previewRecords: RestoreBatchPreviewRecord[]
  restorableCount: number
  skippedCount: number
  /** false when the server withheld a scope identity (empty restorable set / drift) — confirm blocked. */
  executable: boolean
  resultRecords: RestoreBatchExecuteRecord[]
  restoredCount: number
  /** resolve a record id to a display label (the workbench owns the record map). */
  recordLabelOf: (recordId: string) => string
  isZh: boolean
}>()

const emit = defineEmits<{ (e: 'preview-version', version: number): void; (e: 'confirm'): void; (e: 'cancel'): void; (e: 'done'): void }>()

const l = (key: MetaRecordLabelKey): string => recordLabel(key, props.isZh)
const skipReason = (reason: string | undefined): string => batchSkipReasonLabel(reason, props.isZh)

const advancedOpen = ref(false)
const versionInput = computed(() => props.targetVersion)
// Confirm only when the preview returned an executable identity over a non-empty restorable set.
const canConfirm = computed(() => !props.loading && props.executable && props.restorableCount > 0)

function onVersionChange(ev: Event): void {
  const raw = Number((ev.target as HTMLInputElement).value)
  if (Number.isFinite(raw) && raw >= 1) emit('preview-version', Math.floor(raw))
}
function onConfirm(): void {
  if (canConfirm.value) emit('confirm')
}
function onCancel(): void {
  emit('cancel')
}
function onDone(): void {
  emit('done')
}
</script>

<style scoped>
.restore-batch-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.restore-batch-modal {
  background: var(--surface, #fff);
  border-radius: 10px;
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.2);
}
.restore-batch__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border, #e2e8f0);
}
.restore-batch__close {
  border: none;
  background: none;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  color: var(--text-secondary, #64748b);
}
.restore-batch__target {
  padding: 12px 16px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.restore-batch__revert { margin: 0; font-weight: 600; }
.restore-batch__advanced-toggle {
  align-self: flex-start;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: 12px;
  color: var(--primary, #2563eb);
}
.restore-batch__version {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.restore-batch__version-input {
  width: 80px;
  padding: 4px 6px;
  border: 1px solid var(--border, #cbd5e1);
  border-radius: 6px;
}
.restore-batch__body {
  padding: 16px;
  overflow-y: auto;
}
.restore-batch__label { margin: 0 0 8px; font-weight: 600; }
.restore-batch__hint { margin: 0; color: var(--text-secondary, #64748b); }
.restore-batch__hint--warn { color: var(--danger, #b91c1c); }
.restore-batch__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.restore-batch__row {
  display: flex;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
  padding: 6px 8px;
  background: var(--surface-muted, #f1f5f9);
  border-radius: 6px;
}
.restore-batch__rec { font-weight: 600; word-break: break-word; }
.restore-batch__chip { font-size: 12px; white-space: nowrap; }
.restore-batch__chip--ok { color: var(--success, #15803d); }
.restore-batch__chip--skip { color: var(--text-secondary, #64748b); }
.restore-batch__summary { margin: 10px 0 0; color: var(--text-secondary, #64748b); font-size: 13px; }
.restore-batch__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border, #e2e8f0);
}
.restore-batch__btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--border, #cbd5e1);
  background: var(--surface, #fff);
  cursor: pointer;
}
.restore-batch__btn--primary {
  background: var(--primary, #2563eb);
  color: #fff;
  border-color: var(--primary, #2563eb);
}
.restore-batch__btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
