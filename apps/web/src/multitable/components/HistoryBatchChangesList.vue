<!--
  Shared per-field diff renderer for a Global History batch's changes[] payload — used by BOTH the
  per-row expansion in HistoryCenterModal.vue (existing) and the W3-5b pinned-batch banner (a deep-linked
  batch that may not be on the modal's current page). Extracted so the two render paths can never drift
  apart; purely presentational — renders EXACTLY what the batch-detail payload already carries
  (`HistoryChange.before`/`after`, already permission-masked server-side per LOCK-3), no extra fetch, no
  un-masking, no widened field set.
-->
<template>
  <ul class="meta-hist__changes">
    <li v-for="(c, i) in changes" :key="`${c.recordId}-${i}`" class="meta-hist__change" data-test="hist-change">
      <div class="meta-hist__change-summary">
        <span class="meta-hist__change-action" :data-action="c.action">{{ actionLabel(c.action) }}</span>
        <span class="meta-hist__change-rec" :title="c.recordId">{{ shortRecordId(c.recordId) }}</span>
        <span class="meta-hist__change-fields">{{ fieldsLabel(c.changedFieldIds.length) }}</span>
      </div>
      <ul v-if="c.changedFieldIds.length" class="meta-hist__diff" data-test="hist-diff">
        <li v-for="d in changeFieldDiffs(c)" :key="d.fieldId" class="meta-hist__diff-row" data-test="hist-diff-row">
          <span class="meta-hist__diff-label" :title="diffFieldName(d.fieldId)">{{ diffFieldName(d.fieldId) }}</span>
          <span class="meta-hist__diff-values">
            <template v-if="d.shape === 'masked'">
              <span class="meta-hist__diff-masked" data-test="hist-diff-masked">{{ diffMaskedLabel() }}</span>
            </template>
            <template v-else-if="d.shape === 'set'">
              <span class="meta-hist__diff-op" data-test="hist-diff-op">{{ diffOpLabel('set') }}</span>
              <span class="meta-hist__diff-after" :title="d.after">{{ d.after }}</span>
            </template>
            <template v-else-if="d.shape === 'cleared'">
              <span class="meta-hist__diff-before" :title="d.before">{{ d.before }}</span>
              <span class="meta-hist__diff-arrow" aria-hidden="true">→</span>
              <span class="meta-hist__diff-op" data-test="hist-diff-op">{{ diffOpLabel('cleared') }}</span>
            </template>
            <template v-else>
              <span class="meta-hist__diff-before" :title="d.before">{{ d.before }}</span>
              <span class="meta-hist__diff-arrow" aria-hidden="true">→</span>
              <span class="meta-hist__diff-after" :title="d.after">{{ d.after }}</span>
            </template>
          </span>
        </li>
      </ul>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { useLocale } from '../../composables/useLocale'
import { recordLabel } from '../utils/meta-record-labels'
import type { HistoryChange } from '../types'

const props = defineProps<{
  changes: HistoryChange[]
  fields?: Array<{ id: string; name: string }>
  /** Reuses the caller's own action-label map (kept as a single source of truth in HistoryCenterModal.vue —
   *  this is prop-drilling, not a shared-module extraction, per the AI-fields S1 design-lock's constraint
   *  on `sourceLabel` NOT applying here since this is a distinct map (per-change action, not source)). */
  actionLabel: (action: string) => string
}>()

const { isZh } = useLocale()

function fieldsLabel(n: number): string {
  return isZh.value ? `${n} 个字段` : `${n} field(s)`
}
function shortRecordId(id: string): string {
  const trimmed = id.startsWith('rec_') ? id.slice(4) : id
  return `#${trimmed.slice(0, 8)}`
}

// --- Inline per-field diff (read-only detail expansion) ---
// Renders EXACTLY what the batch-detail payload already carries (HistoryChange.before/after, both
// already permission-masked server-side per LOCK-3) — no extra fetch, no un-masking. A field is only
// ever a diff row here because it is already listed in `changedFieldIds` (itself post-mask); this code
// never widens that set.
type FieldDiffShape = 'changed' | 'set' | 'cleared' | 'masked'
interface FieldDiffRow { fieldId: string; shape: FieldDiffShape; before: string; after: string }

function hasFieldValue(container: Record<string, unknown> | null, fieldId: string): boolean {
  return !!container && Object.prototype.hasOwnProperty.call(container, fieldId)
}
function formatDiffValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return String(v) }
  }
  return String(v)
}
// Shape rule (per changed field id):
//  - present on both sides           → 'changed' (normal before→after diff)
//  - present only on the after side  → 'set'      (no prior value — e.g. a create, or a field just added)
//  - present only on the before side → 'cleared'  (the field was emptied)
//  - present on NEITHER side         → 'masked'   (LOCK-3 hid the value on both sides even though the
//                                                   batch still reports the field as changed)
function changeFieldDiffs(c: HistoryChange): FieldDiffRow[] {
  return c.changedFieldIds.map((fieldId) => {
    const beforeHas = hasFieldValue(c.before, fieldId)
    const afterHas = hasFieldValue(c.after, fieldId)
    const shape: FieldDiffShape = beforeHas && afterHas ? 'changed' : afterHas ? 'set' : beforeHas ? 'cleared' : 'masked'
    return {
      fieldId,
      shape,
      before: beforeHas ? formatDiffValue((c.before as Record<string, unknown>)[fieldId]) : '',
      after: afterHas ? formatDiffValue((c.after as Record<string, unknown>)[fieldId]) : '',
    }
  })
}
function diffFieldName(fieldId: string): string {
  return props.fields?.find((f) => f.id === fieldId)?.name ?? fieldId
}
function diffOpLabel(shape: 'set' | 'cleared'): string {
  return recordLabel(shape === 'set' ? 'record.restorePreviewSet' : 'record.restorePreviewUnset', isZh.value)
}
function diffMaskedLabel(): string {
  return recordLabel('record.historyDiffMasked', isZh.value)
}
</script>

<style scoped>
.meta-hist__changes { list-style: none; margin: 0; padding: 0; }
.meta-hist__change { padding: 3px 0; font-size: 12px; }
.meta-hist__change-summary { display: flex; gap: 10px; align-items: center; }
.meta-hist__change-action { font-weight: 500; min-width: 48px; }
.meta-hist__change-rec { color: var(--meta-text-secondary, #888); }
.meta-hist__change-fields { color: var(--meta-text-secondary, #888); }
.meta-hist__diff { list-style: none; margin: 4px 0 0; padding: 0; }
.meta-hist__diff-row { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; }
.meta-hist__diff-row + .meta-hist__diff-row { border-top: 1px dashed var(--meta-border, #eee); }
.meta-hist__diff-label { flex: 0 0 auto; max-width: 38%; font-weight: 600; color: var(--meta-text-secondary, #475569); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-hist__diff-values { flex: 1 1 auto; display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.meta-hist__diff-before { color: #94a3b8; text-decoration: line-through; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.meta-hist__diff-arrow { flex: 0 0 auto; color: #cbd5e1; }
.meta-hist__diff-after { color: var(--meta-text, #0f172a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.meta-hist__diff-op { flex: 0 0 auto; font-style: italic; color: var(--meta-text-secondary, #888); }
.meta-hist__diff-masked { color: var(--meta-text-secondary, #888); font-style: italic; }
</style>
