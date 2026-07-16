<!--
  W2 S2 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
  §2 组件表, §4, §7 S2): behavior-equivalent extraction of MetaRecordDrawer.vue's `history` tab body
  (pre-extraction file, post-S1: L100-155 template + loadRecordHistory/historyFieldDiffs/restore-
  selection script). This component receives the SAME props the history branch consumed in the drawer
  and re-emits `restore` UPWARD UNCHANGED (identical event name + payload shape) — the drawer relays
  it 1:1 to its own parent (the workbench), so the workbench's existing `onRestoreRecordVersion`
  listener needs no changes.

  HI-1 (zero new data paths): the ONLY fetch this panel makes is `apiClient.listRecordHistory` — the
  SAME existing gated read the pre-extraction drawer already called (lock §2 table sanctions this
  read path explicitly). No new `client.`/`fetch(`/`api.` call is introduced.

  RESTORE FLOW (owner-ruled OD-W2-4=a, lock Rev 2 / §4.2 / §6bis): restore is NOT re-implemented here.
  This panel only lets the user pick a target revision + narrow the field selection and then emits
  `restore` — the SAME event the drawer emitted before extraction. The parent (workbench) still owns
  the existing preview -> RestorePreviewDialog -> execute flow (`restorePreviewRecord`); this panel
  has NO direct-restore path and does not call any restore/execute API itself.

  FIELD-MASK INVARIANT (lock §4.4, gate-emphasized -- LEAK-SAFE BY CONSTRUCTION): `historyFieldDiffs`
  below iterates ONLY the server-masked `item.changedFieldIds` and reads ONLY the server-masked
  `item.patch` / `item.snapshot` -- moved VERBATIM from the drawer. Do NOT "helpfully" read raw
  snapshot keys or enumerate `Object.keys(item.snapshot)` -- that would bypass the server's field mask
  (redactRecordRevisionEntry / maskStoredRecordFieldIds already strip fields this actor can't see from
  changedFieldIds AND patch AND snapshot before they reach the wire). See the mutation note in the PR
  body: flipping the iteration source to raw snapshot keys must turn
  `meta-record-drawer-history-diff.spec.ts`'s LEAK-LOCK test red.

  `formatValue` / `textControlValue` delegate to the shared `../utils/recordDisplay.ts` module (W2 S2
  helper dedup, resolves S1 gate NIT-1) -- the same wrappers MetaRecordFieldsPanel.vue uses, byte-
  identical logic, no behavior divergence.
-->
<template>
  <div class="meta-record-drawer__history">
    <div v-if="historyLoading" class="meta-record-drawer__history-state">{{ l('record.historyLoading') }}</div>
    <div v-else-if="historyError" class="meta-record-drawer__history-state meta-record-drawer__history-state--error">{{ historyError }}</div>
    <div v-else-if="!canLoadHistory" class="meta-record-drawer__history-state">{{ l('record.historyUnavailable') }}</div>
    <div v-else-if="historyItems.length === 0" class="meta-record-drawer__history-state">{{ l('record.historyEmpty') }}</div>
    <ol v-else class="meta-record-drawer__history-list">
      <li v-for="(item, idx) in historyItems" :key="item.id" class="meta-record-drawer__history-item">
        <div class="meta-record-drawer__history-main">
          <span class="meta-record-drawer__history-action">{{ historyActionLabel(item.action) }}</span>
          <span class="meta-record-drawer__history-version">v{{ item.version }}</span>
          <span
            v-if="item.restoredFromVersion != null"
            class="meta-record-drawer__history-restored"
            data-test="record-history-restored-from"
          >{{ restoredFromVersionBadge(item.restoredFromVersion, isZh) }}</span>
        </div>
        <div class="meta-record-drawer__history-meta">
          <span>{{ formatHistoryTime(item.createdAt) }}</span>
          <span v-if="item.actorId">{{ historyActor(item.actorName || item.actorId, isZh) }}</span>
          <span>{{ item.source }}</span>
        </div>
        <div v-if="item.changedFieldIds.length" class="meta-record-drawer__history-fields">
          <div
            v-for="d in historyFieldDiffs(item, idx)"
            :key="d.fieldId"
            class="meta-record-drawer__history-diff"
            data-test="history-field-diff"
          >
            <input
              v-if="canRestoreTo(item)"
              type="checkbox"
              class="meta-record-drawer__history-diff-select"
              data-test="history-field-select"
              :checked="isRestoreFieldSelected(item, d.fieldId)"
              :aria-label="d.label"
              @change="toggleRestoreField(item, d.fieldId)"
            />
            <span class="meta-record-drawer__history-diff-label">{{ d.label }}</span>
            <span class="meta-record-drawer__history-diff-values">
              <span
                v-if="d.hasBefore"
                class="meta-record-drawer__history-diff-before"
                :title="d.before"
              >{{ d.before || '—' }}</span>
              <span v-if="d.hasBefore" class="meta-record-drawer__history-diff-arrow" aria-hidden="true">→</span>
              <span class="meta-record-drawer__history-diff-after" :title="d.after">{{ d.after || '—' }}</span>
            </span>
          </div>
        </div>
        <button
          v-if="canRestoreTo(item)"
          type="button"
          class="meta-record-drawer__history-restore"
          data-test="record-history-restore"
          :title="l('record.restoreTitle')"
          :disabled="selectedRestoreFields(item).length === 0"
          @click="requestRestore(item)"
        >{{ l('record.restore') }}</button>
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  LinkedRecordSummary,
  PersonSummary,
  MetaAttachment,
  MetaField,
  MetaRecord,
  MetaRecordRevision,
  MetaRowActions,
} from '../types'
import type { MultitableApiClient } from '../api/client'
import { useLocale } from '../../composables/useLocale'
import {
  recordLabel,
  historyActor,
  restoredFromVersionBadge,
  type MetaRecordLabelKey,
} from '../utils/meta-record-labels'
import { formatRecordFieldValue, textControlValue as textControlValueShared } from '../utils/recordDisplay'

const props = defineProps<{
  record?: MetaRecord | null
  fields: MetaField[]
  canEdit: boolean
  rowActions?: MetaRowActions | null
  linkSummariesByField?: Record<string, LinkedRecordSummary[]>
  personSummariesByField?: Record<string, PersonSummary[]>
  attachmentSummariesByField?: Record<string, MetaAttachment[]>
  sheetId?: string
  apiClient?: MultitableApiClient
}>()

const emit = defineEmits<{
  /** Relayed 1:1 by the drawer to its own parent (the workbench), which owns the existing
   * preview -> RestorePreviewDialog -> execute flow (OD-W2-4=a) — this panel never calls restore
   * itself, only requests it. */
  (e: 'restore', payload: { recordId: string; targetVersion: number; expectedVersion: number; fieldIds?: string[] }): void
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey) => recordLabel(key, isZh.value)

const historyItems = ref<MetaRecordRevision[]>([])
const historyLoading = ref(false)
const historyError = ref('')
let historyRequestId = 0

const fieldLabelById = computed(() => new Map(props.fields.map((field) => [field.id, field.name])))
const canLoadHistory = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)

// Fetch trigger: fires once on mount (this panel only mounts while the drawer's history tab is
// active — the parent's `v-if="activeTab === 'history'"` is the tab-switch-in trigger the
// pre-extraction drawer's `watch([activeTab, ...])` used to gate) and again whenever the record
// identity, its version (a restore bumps it via the workbench's refreshSelectedRecordContext while
// the user stays on this tab), sheetId, or apiClient change.
watch(
  [() => props.record?.id, () => props.record?.version, () => props.sheetId, () => props.apiClient],
  () => { void loadRecordHistory() },
  { immediate: true },
)

async function loadRecordHistory() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId) {
    historyItems.value = []
    historyLoading.value = false
    historyError.value = ''
    return
  }
  const requestId = ++historyRequestId
  historyLoading.value = true
  historyError.value = ''
  try {
    const items = await apiClient.listRecordHistory(sheetId, recordId, { limit: 50 })
    if (requestId !== historyRequestId) return
    historyItems.value = items
  } catch (error: any) {
    if (requestId !== historyRequestId) return
    historyItems.value = []
    historyError.value = error?.message ?? l('record.errorHistoryLoad')
  } finally {
    if (requestId === historyRequestId) historyLoading.value = false
  }
}

function historyActionLabel(action: MetaRecordRevision['action']): string {
  if (action === 'create') return l('record.historyActionCreated')
  if (action === 'delete') return l('record.historyActionDeleted')
  return l('record.historyActionUpdated')
}

// Slice 3: a prior NON-delete revision is restorable when the user can edit the record. The current
// version (== record.version) shows no button (restoring to it is a no-op). Delete revisions are not
// restorable here (undelete is Slice 2b → the endpoint returns RESTORE_UNSUPPORTED).
function canRestoreTo(item: MetaRecordRevision): boolean {
  return (
    props.canEdit
    && props.rowActions?.canEdit !== false
    && !!props.record
    && item.action !== 'delete'
    && item.version !== props.record.version
  )
}

// Per-field restore selection, keyed by revision id. Default (no entry) = ALL changed fields selected
// (full restore, the prior behavior). Unchecking narrows to a subset → emits fieldIds; re-checking all
// → omits fieldIds (canonical full restore). Only the actor-visible changedFieldIds are selectable
// (they are already permission-masked server-side), so a hidden field can never be targeted.
const restoreFieldSelection = ref<Record<string, Set<string>>>({})
function isRestoreFieldSelected(item: MetaRecordRevision, fieldId: string): boolean {
  const sel = restoreFieldSelection.value[item.id]
  return sel ? sel.has(fieldId) : true
}
function toggleRestoreField(item: MetaRecordRevision, fieldId: string): void {
  const next = new Set(restoreFieldSelection.value[item.id] ?? item.changedFieldIds)
  if (next.has(fieldId)) next.delete(fieldId)
  else next.add(fieldId)
  restoreFieldSelection.value = { ...restoreFieldSelection.value, [item.id]: next }
}
function selectedRestoreFields(item: MetaRecordRevision): string[] {
  return item.changedFieldIds.filter((fieldId) => isRestoreFieldSelected(item, fieldId))
}

function requestRestore(item: MetaRecordRevision): void {
  const record = props.record
  if (!record || !canRestoreTo(item)) return
  const selected = selectedRestoreFields(item)
  if (selected.length === 0) return // nothing selected → no-op (button is also disabled)
  // All changed fields selected → full restore (omit fieldIds); a proper subset → per-field restore.
  const fieldIds = selected.length === item.changedFieldIds.length ? undefined : selected
  emit('restore', { recordId: record.id, targetVersion: item.version, expectedVersion: record.version, ...(fieldIds ? { fieldIds } : {}) })
}

// Per-field before→after diff for a revision. LEAK-SAFE BY CONSTRUCTION: the backend
// (redactRecordRevisionEntry / maskStoredRecordFieldIds) already strips fields this actor can't see
// from changedFieldIds AND patch AND snapshot before they reach the wire, so iterating changedFieldIds
// and reading only patch/snapshot cannot surface a masked field. `after` = the value at this revision
// (snapshot preferred, patch fallback when snapshot is unavailable); `before` = the value at the
// next-older visible revision's snapshot (absent when there's no prior snapshot — e.g. the create row,
// a pruned gap, or an unavailable snapshot → show after only).
interface HistoryFieldDiff { fieldId: string; label: string; before: string; after: string; hasBefore: boolean }
function historyFieldDiffs(item: MetaRecordRevision, index: number): HistoryFieldDiff[] {
  const olderSnap = historyItems.value[index + 1]?.snapshot ?? null
  const has = (obj: Record<string, unknown> | null | undefined, key: string): boolean =>
    !!obj && Object.prototype.hasOwnProperty.call(obj, key)
  return item.changedFieldIds.map((fieldId) => {
    const field = props.fields.find((f) => f.id === fieldId) ?? null
    const fmt = (v: unknown): string => (field ? formatValue(field, v) : textControlValue(v))
    const afterRaw = has(item.snapshot, fieldId)
      ? item.snapshot![fieldId]
      : has(item.patch, fieldId) ? item.patch[fieldId] : undefined
    const hasBefore = has(olderSnap, fieldId)
    return {
      fieldId,
      label: fieldLabelById.value.get(fieldId) ?? fieldId,
      before: hasBefore ? fmt(olderSnap![fieldId]) : '',
      after: fmt(afterRaw),
      hasBefore,
    }
  })
}

function formatHistoryTime(value: string): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Date(timestamp).toLocaleString()
}

function formatValue(field: MetaField, v: unknown): string {
  return formatRecordFieldValue(field, v, {
    linkSummariesByField: props.linkSummariesByField,
    personSummariesByField: props.personSummariesByField,
    attachmentSummariesByField: props.attachmentSummariesByField,
    isZh: isZh.value,
  })
}

function textControlValue(value: unknown): string {
  return textControlValueShared(value)
}
</script>

<style scoped>
.meta-record-drawer__history-state { padding: 18px 12px; border: 1px dashed #d8e1ee; border-radius: 8px; color: #64748b; font-size: 13px; text-align: center; }
.meta-record-drawer__history-state--error { border-color: #fecaca; color: #b91c1c; background: #fef2f2; }
.meta-record-drawer__history-list { display: flex; flex-direction: column; gap: 10px; padding: 0; margin: 0; list-style: none; }
.meta-record-drawer__history-item { padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; }
.meta-record-drawer__history-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
.meta-record-drawer__history-action { font-size: 13px; font-weight: 700; color: #111827; }
.meta-record-drawer__history-version { font-size: 11px; font-weight: 700; color: #2563eb; background: #eff6ff; border-radius: 999px; padding: 2px 7px; }
/* OD-W2-5a R11 restore badge — muted, reuses the panel's existing meta color (#64748b), no new hex. */
.meta-record-drawer__history-restored { font-size: 11px; color: #64748b; font-style: italic; }
.meta-record-drawer__history-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #64748b; }
.meta-record-drawer__history-fields { margin-top: 8px; font-size: 12px; color: #374151; word-break: break-word; }
.meta-record-drawer__history-diff { display: flex; align-items: baseline; gap: 8px; padding: 2px 0; }
.meta-record-drawer__history-diff + .meta-record-drawer__history-diff { border-top: 1px dashed #f1f5f9; }
.meta-record-drawer__history-diff-label { flex: 0 0 auto; max-width: 38%; font-weight: 600; color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-record-drawer__history-diff-values { flex: 1 1 auto; display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.meta-record-drawer__history-diff-before { color: #94a3b8; text-decoration: line-through; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
.meta-record-drawer__history-diff-arrow { flex: 0 0 auto; color: #cbd5e1; }
.meta-record-drawer__history-diff-after { color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.meta-record-drawer__history-diff-select { flex: 0 0 auto; margin: 0 2px 0 0; cursor: pointer; }
.meta-record-drawer__history-restore:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
