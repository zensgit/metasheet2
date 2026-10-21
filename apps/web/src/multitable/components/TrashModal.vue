<!--
  Deleted records — a modal listing a sheet's deleted records with a per-row Restore action.
  Visibility is the caller's concern (open it only for actors who can delete); the backend gates the
  list/restore endpoints on canDeleteRecord regardless. Loads on open via useTrash; restore is
  optimistic-on-success and surfaces 409 (id occupied) / 403 inline via the composable's `error`.
-->
<template>
  <div v-if="open" class="meta-trash__overlay" @click.self="emit('close')">
    <div class="meta-trash__modal" role="dialog" aria-modal="true" :aria-label="t('已删除的记录', 'Deleted records')">
      <header class="meta-trash__header">
        <h3 class="meta-trash__title">{{ t('已删除的记录', 'Deleted records') }}</h3>
        <MtIconButton class="meta-trash__close" :aria-label="t('关闭', 'Close')" @click="emit('close')">×</MtIconButton>
      </header>
      <p class="meta-trash__scope" data-test="trash-current-scope">{{ t('当前可恢复的已删除记录', 'Current recoverable deleted records') }}</p>

      <p v-if="error" class="meta-trash__error" role="alert">{{ error }}</p>
      <p v-if="selectedUnavailable" class="meta-trash__hint" role="status" data-test="trash-selected-unavailable">{{ t('该历史记录当前不可恢复。', 'This historical record is not currently available to restore.') }}</p>

      <div v-if="loading" class="meta-trash__hint">{{ t('加载中…', 'Loading…') }}</div>
      <ul v-else-if="rowsWithDetails.length" class="meta-trash__list">
        <li v-for="row in rowsWithDetails" :key="row.rec.recordId" class="meta-trash__row">
          <div class="meta-trash__identity">
            <span class="meta-trash__title-text" :title="row.rec.recordId" data-test="trash-record-title">{{ row.title }}</span>
            <span v-if="row.rec.deletedAt" class="meta-trash__meta">{{ configHistoryTime(row.rec.deletedAt, isZh) }}<template v-if="row.rec.deletedBy"> · {{ deletedByLabel(row.rec.deletedByName || row.rec.deletedBy) }}</template></span>
            <dl v-if="row.details.length" class="meta-trash__details" data-test="trash-record-details">
              <template v-for="detail in row.details" :key="detail.fieldId">
                <dt :title="detail.name">{{ detail.name }}</dt>
                <dd :title="detail.value">{{ detail.value }}</dd>
              </template>
            </dl>
            <p v-else class="meta-trash__details-empty" data-test="trash-record-details-empty">{{ t('没有可显示的删除前字段值', 'No visible pre-deletion field values are available') }}</p>
            <p v-if="row.hasUnavailableDetails" class="meta-trash__details-empty" data-test="trash-record-details-partial">{{ t('部分删除前字段值不可用', 'Some visible pre-deletion field values are unavailable') }}</p>
          </div>
          <template v-if="confirmingId === row.rec.recordId">
            <span class="meta-trash__confirm-text">{{ t(`恢复「${row.title}」？`, `Restore “${row.title}”?`) }}</span>
            <button
              class="meta-trash__restore"
              type="button"
              data-test="trash-restore-confirm"
              :disabled="loading || loadingMore || restoringIds.includes(row.rec.recordId)"
              @click="confirmRestore(row.rec)"
            >{{ restoringIds.includes(row.rec.recordId) ? t('恢复中…', 'Restoring…') : t('确定恢复', 'Confirm') }}</button>
            <MtButton class="meta-trash__cancel" @click="confirmingId = null">{{ t('取消', 'Cancel') }}</MtButton>
          </template>
          <button
            v-else
            class="meta-trash__restore"
            type="button"
            data-test="trash-restore"
            :disabled="loading || loadingMore"
            @click="confirmingId = row.rec.recordId"
          >{{ t('恢复', 'Restore') }}</button>
        </li>
      </ul>
      <p v-else class="meta-trash__hint">{{ t('没有已删除的记录', 'No deleted records') }}</p>
      <MtButton
        v-if="records.length < total && !loading"
        class="meta-trash__more"
        data-test="trash-load-more"
        :disabled="loadingMore || restoringIds.length > 0"
        @click="loadMore(sheetId)"
      >{{ loadingMore ? t('加载中…', 'Loading…') : t('加载更多', 'Load more') }}</MtButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useTrash } from '../composables/useTrash'
import { formatFieldDisplay, pickRecordTitle } from '../utils/field-display'
import { configHistoryTime } from '../utils/meta-config-history-labels'
import { historyActor } from '../utils/meta-record-labels'
import { MtButton, MtIconButton } from '../ui'
import type { MetaDeletedRecord, MetaField } from '../types'

type DisplayField = { id: string; name: string; type?: string; order?: number; property?: Record<string, unknown> }

// `fields` is the current sheet's two-layer-visible field list. It controls both the title and every
// displayed pre-deletion detail; data keys without visible field metadata are never rendered.
const props = defineProps<{ open: boolean; sheetId: string; fields?: DisplayField[]; selectedRecordId?: string | null }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'restored', payload: { sheetId: string; recordId: string }): void }>()

const { isZh } = useLocale()
const t = (zh: string, en: string) => (isZh.value ? zh : en)
const { records, total, loading, loadingMore, error, restoringIds, load, loadMore, loadSelected, restore, reset } = useTrash()

// Which row (if any) is awaiting an in-DOM restore confirmation. Cleared on (re)open.
const confirmingId = ref<string | null>(null)
const selectedUnavailable = ref(false)
let modalGeneration = 0

watch(
  () => [props.open, props.sheetId, props.selectedRecordId] as const,
  ([open, sheetId, selectedRecordId]) => {
    const currentModalGeneration = ++modalGeneration
    confirmingId.value = null
    selectedUnavailable.value = false
    reset()
    if (!open || !sheetId) return
    if (selectedRecordId) {
      void loadSelected(sheetId, selectedRecordId).then((found) => {
        if (currentModalGeneration === modalGeneration && !error.value) selectedUnavailable.value = !found
      })
      return
    }
    void load(sheetId)
  },
  { immediate: true },
)

onUnmounted(() => {
  modalGeneration += 1
  reset()
})

// A trashed record's human-readable title: the first field (by column order) whose backend-masked
// value renders to a non-empty display string. Masked / unreadable fields render '—' and are skipped,
// so a field the actor can't read transparently falls through to the next readable field. When nothing
// is readable, fall back to a short form of the raw record id so the row is still identifiable.
function recordTitle(rec: MetaDeletedRecord): string {
  return pickRecordTitle({ fields: typedFields(), data: rec.data, isZh: isZh.value }) ?? shortRecordId(rec.recordId)
}

function typedFields(): MetaField[] {
  return (props.fields ?? []).filter((field): field is DisplayField & { type: string } => typeof field.type === 'string') as MetaField[]
}

function shortRecordId(id: string): string {
  const trimmed = id.startsWith('rec_') ? id.slice(4) : id
  return `#${trimmed.slice(0, 8)}`
}

// deletedBy is a user id; the FE has no name directory for actors, so reuse the same "由/by <id>"
// affordance the record-history timeline uses (consistent, and better than hiding who deleted it).
function deletedByLabel(actorId: string): string {
  return historyActor(actorId, isZh.value)
}

const rows = computed(() => records.value.map((rec) => ({ rec, title: recordTitle(rec) })))
const displayedRows = computed(() => {
  if (!props.selectedRecordId) return rows.value
  return [...rows.value].sort((a, b) => Number(b.rec.recordId === props.selectedRecordId) - Number(a.rec.recordId === props.selectedRecordId))
})
const detailRows = (rec: MetaDeletedRecord) => (props.fields ?? [])
  .filter((field): field is DisplayField & { type: string } => typeof field.type === 'string' && Object.prototype.hasOwnProperty.call(rec.data, field.id))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map((field) => ({
    fieldId: field.id,
    name: field.name,
    value: formatFieldDisplay({ field: field as MetaField, value: rec.data[field.id], isZh: isZh.value }),
  }))
const rowsWithDetails = computed(() => displayedRows.value.map((row) => {
  const details = detailRows(row.rec)
  const visibleFieldCount = typedFields().length
  return {
    ...row,
    details,
    hasUnavailableDetails: visibleFieldCount > details.length,
  }
}))

async function confirmRestore(rec: MetaDeletedRecord): Promise<void> {
  const currentModalGeneration = modalGeneration
  const ok = await restore(rec.recordId, rec.sheetId)
  if (currentModalGeneration !== modalGeneration || !props.open || props.sheetId !== rec.sheetId) return
  confirmingId.value = null
  if (ok) emit('restored', { sheetId: rec.sheetId, recordId: rec.recordId })
}
</script>

<style scoped>
.meta-trash__overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.meta-trash__modal { background: var(--meta-surface, #fff); color: var(--meta-text, #1f2329); border-radius: 8px; width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; padding: 16px; box-sizing: border-box; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18); }
.meta-trash__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.meta-trash__title { flex: 1; min-width: 0; margin: 0; font-size: 15px; }
/* .meta-trash__close: now <MtIconButton> (ghost, token-styled; the × glyph char passes through its
   default-slot icon fallback, size token-normalized to the icon control). Bespoke hardcoded CSS
   removed (UI-P2-1c T4). Class kept on the element only for selector stability — sole sharer. */
.meta-trash__list { list-style: none; margin: 0; padding: 0; }
.meta-trash__scope { margin: 0 0 8px; color: var(--meta-text-secondary, #888); font-size: 12px; }
.meta-trash__row { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 12px; padding: 8px 0; border-bottom: 1px solid var(--meta-border, #eee); }
.meta-trash__identity { flex: 1 1 180px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.meta-trash__title-text { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-trash__meta { color: var(--meta-text-secondary, #888); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-trash__details { display: grid; grid-template-columns: minmax(0, 38%) minmax(0, 1fr); gap: 2px 8px; margin: 4px 0 0; font-size: 12px; }
.meta-trash__details dt { color: var(--meta-text-secondary, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-trash__details dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-trash__details-empty { margin: 4px 0 0; color: var(--meta-text-secondary, #888); font-size: 12px; }
.meta-trash__confirm-text { flex: 1 1 100%; font-size: 12px; color: var(--meta-text-secondary, #888); }
.meta-trash__restore { cursor: pointer; }
/* .meta-trash__cancel: now <MtButton> (ghost, token-styled); its bespoke hardcoded CSS was removed
   (UI-P2-1c T4). Class kept on the element only for selector stability — sole sharer. Red line:
   .meta-trash__restore (Restore / Confirm-restore) is delete-adjacent semantic and is NOT migrated. */
.meta-trash__restore:disabled { cursor: default; opacity: 0.6; }
.meta-trash__error { color: var(--meta-danger, #c0392b); margin: 0 0 8px; }
.meta-trash__hint { color: var(--meta-text-secondary, #888); padding: 12px 0; }
</style>
