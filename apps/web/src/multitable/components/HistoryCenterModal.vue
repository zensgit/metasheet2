<!--
  Global History & Point-in-Time Restore — T2/T3 read-only base-level history center.
  Lists permission-filtered change batches (newest first) with time/actor/source/action filters, and
  expands a batch to its per-record change detail. Read-only: no restore here (T5/T6 are gated). All
  visibility + counts come permission-filtered from the backend (LOCK-3) — the FE renders what it is given
  and never reconstructs hidden rows.
-->
<template>
  <div v-if="open" class="meta-hist__overlay" @click.self="emit('close')">
    <div class="meta-hist__modal" role="dialog" aria-modal="true" :aria-label="t('历史记录', 'History')">
      <header class="meta-hist__header">
        <h3 class="meta-hist__title">{{ t('历史记录', 'History') }}</h3>
        <button class="meta-hist__close" type="button" :aria-label="t('关闭', 'Close')" @click="emit('close')">×</button>
      </header>

      <div class="meta-hist__filters">
        <input v-model.trim="filterSearch" class="meta-hist__filter" :placeholder="t('搜索可见数据', 'Search visible data')" data-test="hist-filter-search" @keyup.enter="reload" />
        <input v-model.trim="filterActor" class="meta-hist__filter" :placeholder="t('操作人 ID', 'Actor id')" data-test="hist-filter-actor" @keyup.enter="reload" />
        <input v-model.trim="filterSource" class="meta-hist__filter" :placeholder="t('来源', 'Source')" data-test="hist-filter-source" @keyup.enter="reload" />
        <select v-model="filterAction" class="meta-hist__filter" data-test="hist-filter-action" @change="reload">
          <option value="">{{ t('全部动作', 'All actions') }}</option>
          <option value="create">{{ t('新建', 'Create') }}</option>
          <option value="update">{{ t('更新', 'Update') }}</option>
          <option value="delete">{{ t('删除', 'Delete') }}</option>
        </select>
        <input v-model="filterFrom" type="date" class="meta-hist__filter" :aria-label="t('起始日期', 'From date')" data-test="hist-filter-from" @change="reload" />
        <input v-model="filterTo" type="date" class="meta-hist__filter" :aria-label="t('结束日期', 'To date')" data-test="hist-filter-to" @change="reload" />
        <select v-if="fields && fields.length" v-model="filterField" class="meta-hist__filter" :aria-label="t('字段', 'Field')" data-test="hist-filter-field" @change="reload">
          <option value="">{{ t('全部字段', 'All fields') }}</option>
          <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
        </select>
        <label v-if="sheetId" class="meta-hist__scope" data-test="hist-filter-scope">
          <input v-model="scopeAllSheets" type="checkbox" @change="reload" />{{ t('全部表', 'All tables') }}
        </label>
        <button class="meta-hist__apply" type="button" data-test="hist-apply" @click="reload">{{ t('筛选', 'Filter') }}</button>
      </div>

      <p v-if="error" class="meta-hist__error" role="alert">{{ error }}</p>
      <p v-if="searchTruncated" class="meta-hist__warn" role="status" data-test="hist-search-truncated">
        {{ t('搜索结果可能不完整（已达检索上限），请缩小时间区间或其它筛选条件。', 'Search may be incomplete (candidate limit reached) — narrow the date range or other filters.') }}
      </p>
      <div v-if="loading" class="meta-hist__hint">{{ t('加载中…', 'Loading…') }}</div>
      <ul v-else-if="batches.length" class="meta-hist__list">
        <li v-for="b in batches" :key="b.batchId" class="meta-hist__row">
          <button class="meta-hist__summary" type="button" data-test="hist-batch" @click="toggle(b.batchId)">
            <span class="meta-hist__action" :data-action="b.action">{{ actionLabel(b.action) }}</span>
            <span class="meta-hist__counts" data-test="hist-counts">{{ countLabel(b) }}</span>
            <span class="meta-hist__who">{{ actorLabel(b.actorName, b.actorId) }} · {{ sourceLabel(b.source) }}</span>
            <span class="meta-hist__when">{{ formatTime(b.createdAt) }}</span>
          </button>
          <div v-if="expandedId === b.batchId" class="meta-hist__detail" data-test="hist-detail">
            <p v-if="detailLoading" class="meta-hist__hint">{{ t('加载中…', 'Loading…') }}</p>
            <p v-else-if="!detail" class="meta-hist__hint">{{ t('无法打开该批次', 'This batch is unavailable') }}</p>
            <ul v-else class="meta-hist__changes">
              <li v-for="(c, i) in detail.changes" :key="`${c.recordId}-${i}`" class="meta-hist__change" data-test="hist-change">
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
          </div>
        </li>
      </ul>
      <p v-else class="meta-hist__hint">{{ t('暂无历史记录', 'No history yet') }}</p>
      <button
        v-if="nextCursor && !loading"
        class="meta-hist__more"
        type="button"
        data-test="hist-load-more"
        :disabled="loadingMore"
        @click="loadMore"
      >{{ loadingMore ? t('加载中…', 'Loading…') : t('加载更多', 'Load more') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { useHistoryCenter } from '../composables/useHistoryCenter'
import { historyActor, recordLabel } from '../utils/meta-record-labels'
import type { HistoryBatchSummary, HistoryChange } from '../types'

const props = defineProps<{
  open: boolean
  baseId: string
  sheetId?: string
  fields?: Array<{ id: string; name: string }>
  /**
   * W3-5: a commit toast's "view in history" deep-link sets this to the batch it just wrote — on open, the
   * modal loads the normal (unfiltered) list AND immediately expands this one batch's detail via the SAME
   * `toggle`/`getHistoryBatch` mechanism a manual row click uses (no new filtering API). If the batch has
   * since scrolled off the default page (or ages out under retention), the expand silently finds nothing —
   * same as any other detail-load miss; it never throws.
   */
  initialBatchId?: string | null
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { isZh } = useLocale()
const t = (zh: string, en: string) => (isZh.value ? zh : en)

const filterSearch = ref('')
const filterActor = ref('')
const filterSource = ref('')
const filterAction = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterField = ref('')
const scopeAllSheets = ref(false) // T2b: default to the active sheet; opt in to all readable tables

const { batches, loading, loadingMore, error, nextCursor, searchTruncated, expandedId, detail, detailLoading, load, loadMore, toggle: toggleBatch } = useHistoryCenter()

function reload(): Promise<void> {
  return load(props.baseId, {
    // sheet scope: the active sheet by default; "all tables" clears it (the backend then spans every
    // readable sheet in the base). The field filter is leak-free server-side (post-mask), so the dropdown
    // is a convenience, not a security boundary.
    sheetId: scopeAllSheets.value ? undefined : props.sheetId,
    actorId: filterActor.value,
    source: filterSource.value,
    action: filterAction.value,
    from: filterFrom.value ? new Date(`${filterFrom.value}T00:00:00`).toISOString() : undefined,
    to: filterTo.value ? new Date(`${filterTo.value}T23:59:59.999`).toISOString() : undefined,
    fieldId: filterField.value,
    search: filterSearch.value,
  })
}

function toggle(batchId: string): Promise<void> {
  return toggleBatch(props.baseId, batchId)
}

watch(
  () => [props.open, props.baseId] as const,
  ([open]) => {
    if (!open || !props.baseId) return
    void reload().then(() => {
      // W3-5: a deep-linked open — expand the target batch right away, same as a manual row click.
      if (props.initialBatchId) void toggle(props.initialBatchId)
    })
  },
  { immediate: true },
)

function actorLabel(name: string | null | undefined, actorId: string | null): string {
  if (name) return name
  return actorId ? historyActor(actorId, isZh.value) : t('系统', 'System')
}
function sourceLabel(source: string): string {
  const map: Record<string, [string, string]> = {
    rest: ['手动', 'Manual'], multitable: ['手动', 'Manual'], button: ['按钮', 'Button'],
    automation: ['自动化', 'Automation'], import: ['导入', 'Import'], restore: ['恢复', 'Restore'],
    admin: ['系统', 'System'], 'global-rbac': ['系统', 'System'], 'ai-shortcut': ['AI 填充', 'AI fill'],
  }
  const pair = map[source]
  return pair ? t(pair[0], pair[1]) : source
}
function actionLabel(action: string): string {
  const map: Record<string, [string, string]> = {
    create: ['新建', 'Create'], update: ['更新', 'Update'], delete: ['删除', 'Delete'],
    restore: ['恢复', 'Restore'], bulk_update: ['批量更新', 'Bulk update'],
  }
  const pair = map[action]
  return pair ? t(pair[0], pair[1]) : action
}
function countLabel(b: HistoryBatchSummary): string {
  return t(`${b.visibleAffectedRecordCount} 条记录 · ${b.visibleAffectedFieldCount} 个字段`,
    `${b.visibleAffectedRecordCount} record(s) · ${b.visibleAffectedFieldCount} field(s)`)
}
function fieldsLabel(n: number): string {
  return t(`${n} 个字段`, `${n} field(s)`)
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
function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
</script>

<style scoped>
.meta-hist__overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.meta-hist__modal { background: var(--meta-surface, #fff); color: var(--meta-text, #1f2329); border-radius: 8px; min-width: 420px; max-width: 640px; max-height: 76vh; overflow: auto; padding: 16px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18); }
.meta-hist__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.meta-hist__title { margin: 0; font-size: 15px; }
.meta-hist__close { background: none; border: none; font-size: 20px; line-height: 1; cursor: pointer; color: inherit; }
.meta-hist__filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.meta-hist__filter { font-size: 12px; padding: 4px 6px; border: 1px solid var(--meta-border, #ddd); border-radius: 4px; }
.meta-hist__apply { cursor: pointer; font-size: 12px; }
.meta-hist__list { list-style: none; margin: 0; padding: 0; }
.meta-hist__row { border-bottom: 1px solid var(--meta-border, #eee); }
.meta-hist__summary { display: flex; align-items: center; gap: 12px; width: 100%; padding: 8px 0; background: none; border: none; cursor: pointer; text-align: left; color: inherit; }
.meta-hist__action { font-size: 12px; font-weight: 600; min-width: 56px; }
.meta-hist__counts { font-size: 12px; }
.meta-hist__who { flex: 1; min-width: 0; color: var(--meta-text-secondary, #888); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-hist__when { color: var(--meta-text-secondary, #888); font-size: 12px; white-space: nowrap; }
.meta-hist__detail { padding: 4px 0 10px 12px; }
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
.meta-hist__error { color: var(--meta-danger, #c0392b); margin: 0 0 8px; }
.meta-hist__hint { color: var(--meta-text-secondary, #888); padding: 12px 0; }
</style>
