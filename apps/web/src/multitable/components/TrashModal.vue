<!--
  #15 recycle bin — a modal listing a sheet's deleted records with a per-row Restore action.
  Visibility is the caller's concern (open it only for actors who can delete); the backend gates the
  list/restore endpoints on canDeleteRecord regardless. Loads on open via useTrash; restore is
  optimistic-on-success and surfaces 409 (id occupied) / 403 inline via the composable's `error`.
-->
<template>
  <div v-if="open" class="meta-trash__overlay" @click.self="emit('close')">
    <div class="meta-trash__modal" role="dialog" aria-modal="true" :aria-label="t('回收站', 'Recycle bin')">
      <header class="meta-trash__header">
        <h3 class="meta-trash__title">{{ t('回收站', 'Recycle bin') }}</h3>
        <button class="meta-trash__close" type="button" :aria-label="t('关闭', 'Close')" @click="emit('close')">×</button>
      </header>

      <p v-if="error" class="meta-trash__error" role="alert">{{ error }}</p>

      <div v-if="loading" class="meta-trash__hint">{{ t('加载中…', 'Loading…') }}</div>
      <ul v-else-if="rows.length" class="meta-trash__list">
        <li v-for="row in rows" :key="row.rec.recordId" class="meta-trash__row">
          <div class="meta-trash__identity">
            <span class="meta-trash__title-text" :title="row.rec.recordId" data-test="trash-record-title">{{ row.title }}</span>
            <span class="meta-trash__meta">{{ formatDeleted(row.rec.deletedAt) }}<template v-if="row.rec.deletedBy"> · {{ deletedByLabel(row.rec.deletedByName || row.rec.deletedBy) }}</template></span>
          </div>
          <template v-if="confirmingId === row.rec.recordId">
            <span class="meta-trash__confirm-text">{{ t(`恢复「${row.title}」？`, `Restore “${row.title}”?`) }}</span>
            <button
              class="meta-trash__restore"
              type="button"
              data-test="trash-restore-confirm"
              :disabled="restoringIds.includes(row.rec.recordId)"
              @click="confirmRestore(row.rec.recordId)"
            >{{ restoringIds.includes(row.rec.recordId) ? t('恢复中…', 'Restoring…') : t('确定恢复', 'Confirm') }}</button>
            <button class="meta-trash__cancel" type="button" @click="confirmingId = null">{{ t('取消', 'Cancel') }}</button>
          </template>
          <button
            v-else
            class="meta-trash__restore"
            type="button"
            data-test="trash-restore"
            @click="confirmingId = row.rec.recordId"
          >{{ t('恢复', 'Restore') }}</button>
        </li>
      </ul>
      <p v-else class="meta-trash__hint">{{ t('回收站为空', 'The recycle bin is empty') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useTrash } from '../composables/useTrash'
import { pickRecordTitle } from '../utils/field-display'
import { historyActor } from '../utils/meta-record-labels'
import type { MetaDeletedRecord, MetaField } from '../types'

// `fields` is the current sheet's field list (passed by the workbench). It lets a trashed row show a
// human-readable title from its backend-masked data instead of the raw record id.
const props = defineProps<{ open: boolean; sheetId: string; fields?: MetaField[] }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'restored', recordId: string): void }>()

const { isZh } = useLocale()
const t = (zh: string, en: string) => (isZh.value ? zh : en)
const { records, loading, error, restoringIds, load, restore } = useTrash()

// Which row (if any) is awaiting an in-DOM restore confirmation. Cleared on (re)open.
const confirmingId = ref<string | null>(null)

watch(
  () => [props.open, props.sheetId] as const,
  ([open, sheetId]) => {
    if (open && sheetId) void load(sheetId)
    confirmingId.value = null
  },
  { immediate: true },
)

// A trashed record's human-readable title: the first field (by column order) whose backend-masked
// value renders to a non-empty display string. Masked / unreadable fields render '—' and are skipped,
// so a field the actor can't read transparently falls through to the next readable field. When nothing
// is readable, fall back to a short form of the raw record id so the row is still identifiable.
function recordTitle(rec: MetaDeletedRecord): string {
  return pickRecordTitle({ fields: props.fields ?? [], data: rec.data, isZh: isZh.value }) ?? shortRecordId(rec.recordId)
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

function formatDeleted(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function confirmRestore(recordId: string): Promise<void> {
  const ok = await restore(recordId)
  confirmingId.value = null
  if (ok) emit('restored', recordId)
}
</script>

<style scoped>
.meta-trash__overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.meta-trash__modal { background: var(--meta-surface, #fff); color: var(--meta-text, #1f2329); border-radius: 8px; min-width: 360px; max-width: 560px; max-height: 70vh; overflow: auto; padding: 16px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18); }
.meta-trash__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.meta-trash__title { margin: 0; font-size: 15px; }
.meta-trash__close { background: none; border: none; font-size: 20px; line-height: 1; cursor: pointer; color: inherit; }
.meta-trash__list { list-style: none; margin: 0; padding: 0; }
.meta-trash__row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--meta-border, #eee); }
.meta-trash__identity { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.meta-trash__title-text { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-trash__meta { color: var(--meta-text-secondary, #888); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-trash__confirm-text { font-size: 12px; color: var(--meta-text-secondary, #888); white-space: nowrap; }
.meta-trash__restore { cursor: pointer; }
.meta-trash__cancel { cursor: pointer; background: none; border: none; color: var(--meta-text-secondary, #888); }
.meta-trash__restore:disabled { cursor: default; opacity: 0.6; }
.meta-trash__error { color: var(--meta-danger, #c0392b); margin: 0 0 8px; }
.meta-trash__hint { color: var(--meta-text-secondary, #888); padding: 12px 0; }
</style>
