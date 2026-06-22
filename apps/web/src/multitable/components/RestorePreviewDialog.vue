<template>
  <Teleport to="body">
    <div v-if="visible" class="restore-preview-overlay" data-test="restore-preview" @click.self="onCancel">
      <div class="restore-preview-modal" role="dialog" :aria-label="l('record.restorePreviewTitle')">
        <div class="restore-preview__header">
          <strong>{{ l('record.restorePreviewTitle') }}</strong>
          <button class="restore-preview__close" :aria-label="l('record.restorePreviewCancel')" @click="onCancel">&times;</button>
        </div>

        <div class="restore-preview__body">
          <p v-if="loading" class="restore-preview__hint" data-test="restore-preview-loading">{{ l('record.restorePreviewLoading') }}</p>

          <!-- Conflict: schema drift → not executable (the server withheld an identity). No confirm. -->
          <p v-else-if="schemaDrift || !executable" class="restore-preview__hint restore-preview__hint--warn" role="alert" data-test="restore-preview-conflict">
            {{ l('record.restorePreviewConflict') }}
          </p>

          <!-- No-op: nothing would change. -->
          <p v-else-if="changes.length === 0" class="restore-preview__hint" data-test="restore-preview-empty">{{ l('record.restorePreviewNoChanges') }}</p>

          <!-- The masked diff: which fields would change, and to what. -->
          <template v-else>
            <p class="restore-preview__label">{{ l('record.restorePreviewWillChange') }}</p>
            <ul class="restore-preview__changes" data-test="restore-preview-changes">
              <li v-for="change in changes" :key="change.fieldId" class="restore-preview__change">
                <span class="restore-preview__field">{{ fieldName(change.fieldId) }}</span>
                <span class="restore-preview__op">{{ change.op === 'unset' ? l('record.restorePreviewUnset') : l('record.restorePreviewSet') }}</span>
                <span v-if="change.op === 'set'" class="restore-preview__value">{{ displayValue(change.value) }}</span>
              </li>
            </ul>
          </template>
        </div>

        <div class="restore-preview__footer">
          <button type="button" class="restore-preview__btn" @click="onCancel">{{ l('record.restorePreviewCancel') }}</button>
          <button
            type="button"
            class="restore-preview__btn restore-preview__btn--primary"
            :disabled="!canConfirm"
            data-test="restore-preview-confirm"
            @click="onConfirm"
          >
            {{ l('record.restorePreviewExecute') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import type { RestorePreviewChange } from '../api/client'
import { recordLabel, type MetaRecordLabelKey } from '../utils/meta-record-labels'

const props = defineProps<{
  visible: boolean
  loading: boolean
  changes: RestorePreviewChange[]
  schemaDrift: boolean
  /** false when the server withheld a preview identity (e.g. schema drift) — restore is blocked. */
  executable: boolean
  /** resolve a field id to its display name (the workbench owns the field map). */
  fieldName: (fieldId: string) => string
  isZh: boolean
}>()

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const l = (key: MetaRecordLabelKey): string => recordLabel(key, props.isZh)
// Confirm only when there is a real, executable, non-empty change set — never offers to "restore" a conflict or a no-op.
const canConfirm = computed(() => !props.loading && props.executable && !props.schemaDrift && props.changes.length > 0)

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function onConfirm(): void {
  if (canConfirm.value) emit('confirm')
}
function onCancel(): void {
  emit('cancel')
}
</script>

<style scoped>
.restore-preview-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.restore-preview-modal {
  background: var(--surface, #fff);
  border-radius: 10px;
  width: min(440px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 40px rgba(15, 23, 42, 0.2);
}
.restore-preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border, #e2e8f0);
}
.restore-preview__close {
  border: none;
  background: none;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  color: var(--text-secondary, #64748b);
}
.restore-preview__body {
  padding: 16px;
  overflow-y: auto;
}
.restore-preview__label {
  margin: 0 0 8px;
  font-weight: 600;
}
.restore-preview__hint {
  margin: 0;
  color: var(--text-secondary, #64748b);
}
.restore-preview__hint--warn {
  color: var(--danger, #b91c1c);
}
.restore-preview__changes {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.restore-preview__change {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 6px 8px;
  background: var(--surface-muted, #f1f5f9);
  border-radius: 6px;
}
.restore-preview__field { font-weight: 600; }
.restore-preview__op { color: var(--text-secondary, #64748b); font-size: 12px; }
.restore-preview__value { word-break: break-word; }
.restore-preview__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border, #e2e8f0);
}
.restore-preview__btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--border, #cbd5e1);
  background: var(--surface, #fff);
  cursor: pointer;
}
.restore-preview__btn--primary {
  background: var(--primary, #2563eb);
  color: #fff;
  border-color: var(--primary, #2563eb);
}
.restore-preview__btn--primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
