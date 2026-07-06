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

      <div v-if="initialBatchId && !pinnedDismissed" class="meta-hist__pinned" data-test="hist-pinned-batch">
        <div class="meta-hist__pinned-head">
          <span class="meta-hist__pinned-label">{{ t('已定位到该批次', 'Jumped to this batch') }}</span>
          <button class="meta-hist__pinned-dismiss" type="button" data-test="hist-pinned-dismiss" @click="dismissPinned">{{ t('清除定位', 'Clear') }}</button>
        </div>
        <p v-if="pinnedLoading" class="meta-hist__hint">{{ t('加载中…', 'Loading…') }}</p>
        <p v-else-if="!pinnedDetail" class="meta-hist__hint">{{ t('无法打开该批次', 'This batch is unavailable') }}</p>
        <template v-else>
          <div class="meta-hist__pinned-summary">
            <span class="meta-hist__who">{{ actorLabel(pinnedDetail.actorName, pinnedDetail.actorId) }} · {{ sourceLabel(pinnedDetail.source) }}</span>
            <span class="meta-hist__when">{{ formatTime(pinnedDetail.createdAt) }}</span>
            <span class="meta-hist__counts" data-test="hist-pinned-counts">{{ countLabel(pinnedDetail) }}</span>
          </div>
          <HistoryBatchChangesList :changes="pinnedDetail.changes" :fields="fields" :action-label="actionLabel" />
        </template>
      </div>

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
            <HistoryBatchChangesList v-else :changes="detail.changes" :fields="fields" :action-label="actionLabel" />
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
import { historyActor } from '../utils/meta-record-labels'
import HistoryBatchChangesList from './HistoryBatchChangesList.vue'

const props = defineProps<{
  open: boolean
  baseId: string
  sheetId?: string
  fields?: Array<{ id: string; name: string }>
  /**
   * W3-5/W3-5b: a commit toast's "view in history" deep-link sets this to the batch it just wrote. On open,
   * the modal loads the normal (unfiltered) list AND ALSO fetches this one batch's own detail via the SAME
   * `getHistoryBatch` mechanism a manual row click uses (no new filtering API) into a PINNED banner at the
   * top of the modal (see `pinnedDetail`/`loadPinned`) — independent of whether the batch is among the rows
   * on the current page (a different active filter, or many commits since, would otherwise leave it with no
   * row to expand under; the pinned banner ALWAYS shows it). A "clear" affordance on the banner dismisses it
   * without affecting the normal paged list. If the batch is unavailable (e.g. aged out under retention),
   * the banner shows the same "unavailable" hint as a normal row's failed expand — it never throws.
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

const {
  batches, loading, loadingMore, error, nextCursor, searchTruncated, expandedId, detail, detailLoading, load, loadMore, toggle: toggleBatch,
  pinnedDetail, pinnedLoading, loadPinned, clearPinned,
} = useHistoryCenter()

// W3-5b: local dismiss flag for the pinned banner — reset whenever a fresh deep-linked open fires (below),
// so re-opening the modal with a NEW initialBatchId always shows its own pinned banner even if a PREVIOUS
// one was dismissed in this same mounted instance.
const pinnedDismissed = ref(false)

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
    void reload()
    // W3-5b: the pinned banner is the sole deep-link display mechanism (see the prop doc above) — it does
    // NOT depend on `reload()` finishing or on the batch being present in the resulting page, so it fires
    // independently. Reset any earlier dismissal, and drop a stale pin from a previous deep-linked open
    // when this open has no `initialBatchId` (e.g. the toolbar's plain "History" button).
    pinnedDismissed.value = false
    if (props.initialBatchId) void loadPinned(props.baseId, props.initialBatchId)
    else clearPinned()
  },
  { immediate: true },
)

function dismissPinned(): void {
  pinnedDismissed.value = true
  clearPinned()
}

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
// countLabel is shared by the per-row batch button (b: HistoryBatchSummary) AND the W3-5b pinned banner
// (pinnedDetail: HistoryBatchDetail) — both carry the same two visible-count fields, so the parameter
// type only requires that structural subset (never the full HistoryBatchSummary shape).
function countLabel(b: { visibleAffectedRecordCount: number; visibleAffectedFieldCount: number }): string {
  return t(`${b.visibleAffectedRecordCount} 条记录 · ${b.visibleAffectedFieldCount} 个字段`,
    `${b.visibleAffectedRecordCount} record(s) · ${b.visibleAffectedFieldCount} field(s)`)
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
/* W3-5b pinned-batch banner — new markup, so per the UI-foundation design-lock (tokens.css §3.1) it takes
   color/spacing/radius ONLY from the real, always-resolvable `--ms-*` tokens (no hardcoded hex, no new
   token vocabulary), unlike this file's pre-existing `--meta-*` hex-fallback pattern above/below (legacy,
   left as-is — out of scope for this additive change). */
.meta-hist__pinned { border: 1px solid var(--ms-border); border-left: 3px solid var(--ms-color-primary); border-radius: var(--ms-radius-md); padding: var(--ms-space-3); margin-bottom: var(--ms-space-4); background: var(--ms-bg-card); }
.meta-hist__pinned-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--ms-space-2); }
.meta-hist__pinned-label { font-size: 12px; font-weight: 600; color: var(--ms-color-primary); }
.meta-hist__pinned-dismiss { font-size: 12px; padding: 2px 8px; border: 1px solid var(--ms-border); border-radius: var(--ms-radius-sm); background: none; color: var(--ms-text-2); cursor: pointer; }
.meta-hist__pinned-dismiss:hover { background: var(--ms-bg-page); }
.meta-hist__pinned-summary { display: flex; gap: 12px; align-items: center; margin-bottom: var(--ms-space-2); }
.meta-hist__error { color: var(--meta-danger, #c0392b); margin: 0 0 8px; }
.meta-hist__hint { color: var(--meta-text-secondary, #888); padding: 12px 0; }
</style>
