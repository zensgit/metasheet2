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
        <button
          v-if="c.action !== 'delete'"
          type="button"
          class="meta-hist__change-rec meta-hist__change-rec--link"
          :title="c.recordId"
          data-test="hist-rec-label"
          @click="emit('open-record', { sheetId: c.sheetId, recordId: c.recordId })"
        >{{ recordDisplay(c) }}</button>
        <span v-else class="meta-hist__change-rec" :title="c.recordId" data-test="hist-rec-label">{{ recordDisplay(c) }}</span>
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
import { formatFieldDisplay, pickRecordTitle } from '../utils/field-display'
import type { HistoryChange, LinkedRecordSummary, MetaField, PersonSummary } from '../types'

const props = defineProps<{
  changes: HistoryChange[]
  /** Field metadata for label/type-aware rendering. `type`/`order`/`property` are optional so legacy
   *  callers that only carry {id,name} keep the plain-text rendering path; typed entries additionally
   *  unlock record titles (pickRecordTitle) and type-aware diff values (formatFieldDisplay). */
  fields?: Array<{ id: string; name: string; type?: string; order?: number; property?: Record<string, unknown> }>
  /** Best-effort display caches, keyed recordId → fieldId → summaries (the grid's already-fetched maps).
   *  Rows absent from the cache (historical/deleted/off-page records) fall back to formatFieldDisplay's
   *  own count/id fallbacks — never a fetch, never un-masking. */
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  personSummaries?: Record<string, Record<string, PersonSummary[]>>
  /** Reuses the caller's own action-label map (kept as a single source of truth in HistoryCenterModal.vue —
   *  this is prop-drilling, not a shared-module extraction, per the AI-fields S1 design-lock's constraint
   *  on `sourceLabel` NOT applying here since this is a distinct map (per-change action, not source)). */
  actionLabel: (action: string) => string
}>()

// PR-C click-through: a non-delete change's record label is a button that asks the host to open the
// record drawer (delete rows stay plain text — the record is gone). The list only EMITS; sheet
// switching / drawer opening / not-found feedback are the workbench's concern.
const emit = defineEmits<{ (e: 'open-record', payload: { sheetId: string; recordId: string }): void }>()

const { isZh } = useLocale()

function fieldsLabel(n: number): string {
  return isZh.value ? `${n} 个字段` : `${n} field(s)`
}
function shortRecordId(id: string): string {
  const trimmed = id.startsWith('rec_') ? id.slice(4) : id
  return `#${trimmed.slice(0, 8)}`
}

// Record label: human title when one is derivable from the change's OWN already-masked payload
// (after = full post-change snapshot; before = prior/pre-delete snapshot — so deleted records title
// from `before`), else the short record id. Reuses pickRecordTitle (TrashModal's heuristic: first
// field in column order whose value renders non-empty; masked/unreadable fields render '—' and are
// skipped) — leak-safe by construction, no fetch, no un-masking, full id stays in the title attr.
const typedFields = (): MetaField[] =>
  ((props.fields ?? []).filter((f) => typeof f.type === 'string') as MetaField[])
function recordDisplay(c: HistoryChange): string {
  const fields = typedFields()
  const data = c.after ?? c.before
  if (fields.length && data) {
    const title = pickRecordTitle({ fields, data, isZh: isZh.value })
    if (title) return title
  }
  return shortRecordId(c.recordId)
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
// Type-aware diff value: when the field's metadata (incl. `type`) is available, render through the
// shared formatFieldDisplay (same renderer as the record drawer's history diffs) — link/person values
// resolve to display names via the grid's already-fetched summary caches, with formatFieldDisplay's own
// count/id fallbacks on cache miss (historical/deleted/off-page rows). Fields known only by id/name
// (e.g. non-active sheets in all-tables mode) keep the legacy plain-text path above.
//
// Owner P2 (link sides): the cached link summaries describe the record's CURRENT cell, and
// formatFieldDisplay renders the summaries VERBATIM when present — ignoring `value`. A history diff
// renders two DIFFERENT values (before vs after) for the same cell, so each side must get only the
// summaries for ITS OWN ids, in value order; otherwise before=[A] and after=[A,B] both display "A, B".
// Full coverage of this side's ids → value-ordered summaries; any miss → null (formatFieldDisplay's
// honest count fallback) rather than an under-counted name list.
function linkSummariesForSide(c: HistoryChange, fieldId: string, v: unknown): LinkedRecordSummary[] | null {
  const cached = props.linkSummaries?.[c.recordId]?.[fieldId]
  if (!cached?.length || !Array.isArray(v)) return null
  const byId = new Map(cached.map((s) => [s.id, s]))
  const matched = v.map((id) => byId.get(String(id)))
  return matched.every((s): s is LinkedRecordSummary => s !== undefined) ? matched : null
}
function formatDiffValueFor(c: HistoryChange, fieldId: string, v: unknown): string {
  const f = props.fields?.find((x) => x.id === fieldId)
  if (!f || typeof f.type !== 'string') return formatDiffValue(v)
  return formatFieldDisplay({
    field: f as MetaField,
    value: v,
    linkSummaries: f.type === 'link' ? linkSummariesForSide(c, fieldId, v) : null,
    personSummaries: props.personSummaries?.[c.recordId]?.[fieldId] ?? null,
    isZh: isZh.value,
  })
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
      before: beforeHas ? formatDiffValueFor(c, fieldId, (c.before as Record<string, unknown>)[fieldId]) : '',
      after: afterHas ? formatDiffValueFor(c, fieldId, (c.after as Record<string, unknown>)[fieldId]) : '',
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
.meta-hist__change-rec--link { background: none; border: none; padding: 0; font: inherit; cursor: pointer; text-decoration: underline dotted; }
.meta-hist__change-rec--link:hover { color: var(--meta-text, #0f172a); }
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
