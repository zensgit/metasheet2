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
      <ul v-else-if="records.length" class="meta-trash__list">
        <li v-for="rec in records" :key="rec.recordId" class="meta-trash__row">
          <span class="meta-trash__id" :title="rec.recordId">{{ rec.recordId }}</span>
          <span class="meta-trash__meta">{{ formatDeleted(rec.deletedAt) }}</span>
          <button
            class="meta-trash__restore"
            type="button"
            :disabled="restoringIds.includes(rec.recordId)"
            @click="onRestore(rec.recordId)"
          >{{ restoringIds.includes(rec.recordId) ? t('恢复中…', 'Restoring…') : t('恢复', 'Restore') }}</button>
        </li>
      </ul>
      <p v-else class="meta-trash__hint">{{ t('回收站为空', 'The recycle bin is empty') }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useTrash } from '../composables/useTrash'

const props = defineProps<{ open: boolean; sheetId: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'restored', recordId: string): void }>()

const { isZh } = useLocale()
const t = (zh: string, en: string) => (isZh.value ? zh : en)
const { records, loading, error, restoringIds, load, restore } = useTrash()

watch(
  () => [props.open, props.sheetId] as const,
  ([open, sheetId]) => {
    if (open && sheetId) void load(sheetId)
  },
  { immediate: true },
)

function formatDeleted(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function onRestore(recordId: string): Promise<void> {
  const ok = await restore(recordId)
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
.meta-trash__id { font-family: monospace; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-trash__meta { color: var(--meta-text-secondary, #888); font-size: 12px; white-space: nowrap; }
.meta-trash__restore { cursor: pointer; }
.meta-trash__restore:disabled { cursor: default; opacity: 0.6; }
.meta-trash__error { color: var(--meta-danger, #c0392b); margin: 0 0 8px; }
.meta-trash__hint { color: var(--meta-text-secondary, #888); padding: 12px 0; }
</style>
