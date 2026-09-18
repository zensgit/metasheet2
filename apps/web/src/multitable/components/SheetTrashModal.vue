<template>
  <ElDialog :model-value="open" :title="t('回收站', 'Recycle bin')" width="min(640px, calc(100vw - 32px))" append-to-body @close="emit('close')">
    <div class="sheet-trash" data-test="sheet-trash">
      <p v-if="error" role="alert" class="sheet-trash__error">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="loading">{{ t('加载中…', 'Loading…') }}</p>
      <p v-else-if="!rows.length && !error" data-test="sheet-trash-empty">{{ t('没有已删除的数据表', 'No deleted tables') }}</p>
      <ul v-else class="sheet-trash__list">
        <li v-for="sheet in rows" :key="sheet.id" class="sheet-trash__row" data-test="sheet-trash-row">
          <div class="sheet-trash__identity">
            <strong :title="sheet.id">{{ sheet.name }}</strong>
            <time :datetime="sheet.deletedAt" :title="sheet.deletedAt">{{ configHistoryTime(sheet.deletedAt, isZh) }}</time>
          </div>
          <template v-if="confirmingId === sheet.id">
            <p class="sheet-trash__confirmation">{{ t(`恢复整张表「${sheet.name}」及随表保留的记录、字段和视图？`, `Restore the table “${sheet.name}” with its retained records, fields and views?`) }}</p>
            <div class="sheet-trash__actions">
              <MtButton :disabled="busyId !== null" data-test="sheet-trash-cancel" @click="confirmingId = null">{{ t('取消', 'Cancel') }}</MtButton>
              <MtButton variant="primary" :disabled="busyId !== null || loading || loadingMore" data-test="sheet-trash-confirm" @click="restore(sheet)">{{ busyId === sheet.id ? t('恢复中…', 'Restoring…') : t('确认恢复整表', 'Confirm table restore') }}</MtButton>
            </div>
          </template>
          <MtButton v-else :disabled="busyId !== null || loading || loadingMore" data-test="sheet-trash-restore" @click="confirmingId = sheet.id">{{ t('恢复整表', 'Restore table') }}</MtButton>
        </li>
      </ul>
      <div class="sheet-trash__footer">
        <MtButton v-if="error" :disabled="loading || loadingMore || busyId !== null" data-test="sheet-trash-retry" @click="load(failedPage)">{{ t('重试', 'Retry') }}</MtButton>
        <MtButton v-else-if="nextCursor" :disabled="loadingMore || busyId !== null" data-test="sheet-trash-more" @click="load(true)">{{ loadingMore ? t('加载中…', 'Loading…') : t('加载更多', 'Load more') }}</MtButton>
      </div>
    </div>
  </ElDialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { ElDialog } from 'element-plus'
import type { DeletedSheet, MultitableApiClient } from '../api/client'
import { useLocale } from '../../composables/useLocale'
import { configHistoryTime } from '../utils/meta-config-history-labels'
import { MtButton } from '../ui'

const props = defineProps<{
  open: boolean
  baseId: string
  client: Pick<MultitableApiClient, 'listDeletedSheets' | 'restoreSheet'>
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'restored', payload: { baseId: string; sheetId: string }): void
}>()
const { isZh } = useLocale()
const t = (zh: string, en: string) => isZh.value ? zh : en
const rows = ref<DeletedSheet[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const failedPage = ref(false)
const error = ref('')
const notice = ref('')
const confirmingId = ref<string | null>(null)
const busyId = ref<string | null>(null)
let generation = 0

function failureMessage(cause: unknown, operation: 'list' | 'restore'): string {
  const code = (cause as { code?: string })?.code
  if (operation === 'list') {
    if (code === 'FORBIDDEN') return t('当前没有查看此回收站的权限。', 'You do not have permission to view this recycle bin.')
    return t('无法加载已删除的数据表，请重试。', 'Unable to load deleted tables. Try again.')
  }
  if (code === 'FORBIDDEN') return t('当前没有恢复这些数据表的权限。', 'You do not have permission to restore these tables.')
  if (code === 'NOT_FOUND' || code === 'SHEET_DELETED') return t('该数据表已不在回收站，请重新加载。', 'This table is no longer in the recycle bin. Reload the list.')
  if (code === 'RECOVERY_IN_PROGRESS') return t('该表正在执行其他恢复任务，请稍后重试。', 'Another recovery is running on this table. Try again later.')
  return t('无法完成操作，请重试。', 'The operation could not be completed. Try again.')
}

async function load(more: boolean): Promise<void> {
  if (!props.open || !props.baseId || busyId.value || loading.value || loadingMore.value || (more && !nextCursor.value)) return
  const ticket = generation
  const baseId = props.baseId
  if (more) loadingMore.value = true
  else { loading.value = true; rows.value = []; nextCursor.value = null; confirmingId.value = null }
  error.value = ''
  notice.value = ''
  failedPage.value = false
  try {
    const page = await props.client.listDeletedSheets(baseId, { limit: 20, ...(more ? { cursor: nextCursor.value! } : {}) })
    if (ticket !== generation || baseId !== props.baseId) return
    const existing = more ? rows.value : []
    rows.value = [...existing, ...page.sheets.filter((row) => !existing.some((old) => old.id === row.id))]
    nextCursor.value = page.nextCursor
  } catch (cause) {
    if (ticket === generation) { error.value = failureMessage(cause, 'list'); failedPage.value = more }
  } finally {
    if (ticket === generation) { loading.value = false; loadingMore.value = false }
  }
}

async function restore(sheet: DeletedSheet): Promise<void> {
  if (!props.open || busyId.value || loading.value || loadingMore.value || confirmingId.value !== sheet.id || sheet.baseId !== props.baseId) return
  const ticket = generation
  const baseId = props.baseId
  busyId.value = sheet.id
  error.value = ''; notice.value = ''
  try {
    const result = await props.client.restoreSheet(sheet.id)
    if (ticket !== generation || baseId !== props.baseId) return
    if (result.restored !== sheet.id || result.sheet?.id !== sheet.id || result.sheet.baseId !== baseId) throw new Error('Invalid sheet restore response')
    rows.value = rows.value.filter((row) => row.id !== sheet.id)
    confirmingId.value = null
    notice.value = t(`已恢复数据表「${sheet.name}」`, `Restored table “${sheet.name}”`)
    emit('restored', { baseId, sheetId: sheet.id })
  } catch (cause) {
    if (ticket === generation) { error.value = failureMessage(cause, 'restore'); failedPage.value = false }
  } finally {
    if (ticket === generation) busyId.value = null
  }
}

watch(() => [props.open, props.baseId] as const, () => {
  generation += 1
  rows.value = []; nextCursor.value = null; confirmingId.value = null; busyId.value = null
  error.value = ''; notice.value = ''; loading.value = false; loadingMore.value = false; failedPage.value = false
  if (props.open && props.baseId) void load(false)
}, { immediate: true })
onBeforeUnmount(() => { generation += 1 })
</script>

<style scoped>
.sheet-trash { min-width: 0; color: var(--ms-text-primary); }
.sheet-trash__list { list-style: none; padding: 0; margin: 0; }
.sheet-trash__row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--ms-border); }
.sheet-trash__identity { flex: 1; min-width: 180px; display: flex; flex-direction: column; gap: 6px; overflow-wrap: anywhere; }
.sheet-trash__identity time { font-size: 12px; color: var(--ms-text-secondary); }
.sheet-trash__confirmation { flex-basis: 100%; margin: 0; overflow-wrap: anywhere; }
.sheet-trash__actions, .sheet-trash__footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.sheet-trash__footer { margin-top: 12px; }
.sheet-trash__error { color: var(--ms-color-danger); }
</style>
