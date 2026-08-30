<template>
  <div class="task-inbox" data-testid="plm-task-inbox">
    <header class="task-inbox__head">
      <div>
        <h2 class="task-inbox__title">任务收件箱 · Task inbox</h2>
        <p class="task-inbox__subtitle">
          只读看板：聚合了你名下的审批、ECO 审批/活动、工作流任务。每行都是你自己的任务（服务端按登录身份自限定）。
        </p>
      </div>
      <button
        type="button"
        class="task-inbox__refresh"
        data-testid="plm-task-inbox-refresh"
        :disabled="loading"
        @click="reload"
      >
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </header>

    <!-- Filters (client-side over the caller's own rows; the provider is already self-scoped). -->
    <div class="task-inbox__filters" data-testid="plm-task-inbox-filters">
      <label>
        来源
        <select v-model="filters.source" data-testid="plm-task-inbox-filter-source" @change="reload">
          <option value="">全部</option>
          <option value="approval_request">审批请求</option>
          <option value="eco_approval">ECO 审批</option>
          <option value="eco_activity">ECO 活动</option>
          <option value="workflow_task">工作流任务</option>
        </select>
      </label>
      <label>
        状态
        <input
          v-model.trim="filters.state"
          type="text"
          placeholder="按状态过滤"
          data-testid="plm-task-inbox-filter-state"
          @keyup.enter="reload"
        />
      </label>
      <label class="task-inbox__checkbox">
        <input
          v-model="filters.overdueOnly"
          type="checkbox"
          data-testid="plm-task-inbox-filter-overdue"
          @change="reload"
        />
        仅逾期
      </label>
    </div>

    <!-- Degraded / unavailable states. -->
    <p v-if="unavailable" class="task-inbox__notice" data-testid="plm-task-inbox-unavailable">
      任务收件箱在当前数据源不可用。
    </p>
    <p
      v-else-if="needsCredential"
      class="task-inbox__notice task-inbox__notice--warn"
      data-testid="plm-task-inbox-no-credential"
    >
      需要以你自己的 PLM 身份读取（未检测到已关联的 PLM 登录凭据）。请先关联你的 PLM 账户后再查看，本看板绝不会用共享服务账户代读。
    </p>
    <p
      v-else-if="transientReason"
      class="task-inbox__notice"
      data-testid="plm-task-inbox-transient"
    >
      暂时无法获取收件箱，请稍后刷新。
    </p>

    <!-- Per-source health strip: a non-ok source still returns 200; showing only `items` would
         present a truncated inbox as complete (taskbook §4.3). -->
    <ul
      v-if="showBoard && sources.length"
      class="task-inbox__sources"
      data-testid="plm-task-inbox-sources"
    >
      <li
        v-for="src in sources"
        :key="src.source"
        class="task-inbox__source"
        :class="`task-inbox__source--${src.status}`"
        :data-source="src.source"
        :data-status="src.status"
        data-testid="plm-task-inbox-source"
      >
        <strong>{{ sourceLabel(src.source) }}</strong>
        <span class="task-inbox__source-status">{{ statusLabel(src.status) }}</span>
        <span v-if="typeof src.count === 'number'" class="task-inbox__source-count">{{ src.count }}</span>
        <!-- reason is displayed ONLY for ok/unsupported; an error source's text is already
             stripped at the relay and defensively suppressed here too. -->
        <small v-if="displayableReason(src)" class="task-inbox__source-reason">{{ src.reason }}</small>
        <small v-else-if="src.status === 'error'" class="task-inbox__source-reason">该来源暂时不可用</small>
      </li>
    </ul>

    <template v-if="showBoard">
      <p v-if="sortedRows.length === 0" class="task-inbox__hint" data-testid="plm-task-inbox-empty">
        没有匹配的任务。
      </p>
      <table v-else class="task-inbox__table" data-testid="plm-task-inbox-table">
        <thead>
          <tr>
            <th
              v-for="col in columns"
              :key="col.key"
              :class="{ 'is-sortable': col.sortable, 'is-active': sortKey === col.key }"
              :data-col="col.key"
              @click="col.sortable && toggleSort(col.key)"
            >
              {{ col.label }}
              <span v-if="col.sortable && sortKey === col.key">{{ sortDir === 'asc' ? '▲' : '▼' }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, idx) in sortedRows"
            :key="rowKey(row, idx)"
            data-testid="plm-task-inbox-row"
            :data-source="row.source"
            :class="{ 'is-overdue': row.is_overdue }"
          >
            <td :data-col="'source'">{{ sourceLabel(row.source) }}</td>
            <td :data-col="'title'">{{ row.title }}</td>
            <td :data-col="'state'">{{ row.state || '—' }}</td>
            <td :data-col="'is_overdue'">
              <span :class="row.is_overdue ? 'task-inbox__badge--overdue' : 'task-inbox__badge--ok'">
                {{ row.is_overdue ? '逾期' : '正常' }}
              </span>
            </td>
            <td :data-col="'due_at'">{{ row.due_at || '—' }}</td>
            <td :data-col="'priority'">{{ row.priority || '—' }}</td>
            <td :data-col="'object'">
              <span v-if="row.entity_type || row.entity_id">{{ row.entity_type || '' }} {{ row.entity_id || '' }}</span>
              <span v-else>—</span>
            </td>
            <!-- action_url is a typed OBJECT REFERENCE, navigable for only 1 of 4 sources today
                 (taskbook §5). Render it NON-navigable: read-only metadata, never a hyperlink. -->
            <td :data-col="'action_url'">
              <code class="task-inbox__ref" data-testid="plm-task-inbox-action-ref">{{ row.action_url }}</code>
            </td>
            <td :data-col="'created_at'">{{ row.created_at || '—' }}</td>
            <td :data-col="'updated_at'">{{ row.updated_at || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p class="task-inbox__footnote">
        本看板不提供批量审批/批量决策（每行指向不同的写端点，且最敏感的审批转移端点存在开放授权缺口——taskbook §5.3）。
        对象引用仅作只读展示，不作可点击链接。
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  getPlmTaskInbox,
  type PlmTaskInboxItem,
  type PlmTaskInboxResult,
  type PlmTaskInboxSourceStatus,
} from '../../services/integration/workbench'

const props = withDefaults(defineProps<{
  dataSourceId: string
  /** The viewing user's own PLM bearer. Empty -> relay degrades to no-plm-credential (no service account). */
  plmUserToken?: string
}>(), {
  plmUserToken: '',
})

const loading = ref(false)
const result = ref<PlmTaskInboxResult | null>(null)
const filters = reactive({ source: '', state: '', overdueOnly: false })
const sortKey = ref<string>('')
const sortDir = ref<'asc' | 'desc'>('asc')

const columns: Array<{ key: string; label: string; sortable: boolean }> = [
  { key: 'source', label: '来源', sortable: true },
  { key: 'title', label: '标题', sortable: true },
  { key: 'state', label: '状态', sortable: true },
  { key: 'is_overdue', label: '逾期', sortable: true },
  { key: 'due_at', label: '截止', sortable: true },
  { key: 'priority', label: '优先级', sortable: true },
  { key: 'object', label: '对象', sortable: false },
  { key: 'action_url', label: '对象引用', sortable: false },
  { key: 'created_at', label: '创建', sortable: true },
  { key: 'updated_at', label: '更新', sortable: true },
]

const unavailable = computed(() => result.value != null && result.value.available === false)
const needsCredential = computed(() => result.value?.available === true && result.value.reason === 'no-plm-credential')
const transientReason = computed(() => result.value?.available === true && result.value.reason === 'unavailable')
const showBoard = computed(() => result.value?.available === true && !needsCredential.value && !transientReason.value)

const sources = computed<PlmTaskInboxSourceStatus[]>(() =>
  result.value?.available === true ? result.value.sources : [],
)

const rows = computed<PlmTaskInboxItem[]>(() => (result.value?.available === true ? result.value.items : []))

// Defensive client-side filter (the relay already returns the caller's own rows).
const filteredRows = computed<PlmTaskInboxItem[]>(() =>
  rows.value.filter((r) => {
    if (filters.source && r.source !== filters.source) return false
    if (filters.state && (r.state || '').toLowerCase().indexOf(filters.state.toLowerCase()) === -1) return false
    if (filters.overdueOnly && !r.is_overdue) return false
    return true
  }),
)

const sortedRows = computed<PlmTaskInboxItem[]>(() => {
  const key = sortKey.value
  if (!key) return filteredRows.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  return [...filteredRows.value].sort((a, b) => {
    const av = (a as Record<string, unknown>)[key]
    const bv = (b as Record<string, unknown>)[key]
    if (av === bv) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return av < bv ? -dir : dir
  })
})

function rowKey(row: PlmTaskInboxItem, idx: number): string {
  return `${row.source}:${row.entity_id || row.action_url || idx}`
}

function toggleSort(key: string): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

const SOURCE_LABELS: Record<string, string> = {
  approval_request: '审批请求',
  eco_approval: 'ECO 审批',
  eco_activity: 'ECO 活动',
  workflow_task: '工作流任务',
}
function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source
}

const STATUS_LABELS: Record<string, string> = {
  ok: '正常',
  unsupported: '不支持',
  error: '不可用',
}
function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status
}

// reason is safe to show ONLY for ok/unsupported (taskbook §4.3).
function displayableReason(src: PlmTaskInboxSourceStatus): boolean {
  return (src.status === 'ok' || src.status === 'unsupported') && !!src.reason
}

async function reload(): Promise<void> {
  if (!props.dataSourceId) return
  loading.value = true
  try {
    result.value = await getPlmTaskInbox(props.dataSourceId, props.plmUserToken, {
      source: filters.source || undefined,
      state: filters.state || undefined,
      overdue: filters.overdueOnly || undefined,
    })
  } finally {
    loading.value = false
  }
}

watch(() => props.dataSourceId, reload)
watch(() => props.plmUserToken, reload)
onMounted(reload)
</script>

<style scoped>
.task-inbox { display: flex; flex-direction: column; gap: 12px; }
.task-inbox__head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.task-inbox__title { margin: 0; font-size: 16px; }
.task-inbox__subtitle { margin: 4px 0 0; font-size: 12px; color: #6b7280; }
.task-inbox__refresh { align-self: flex-start; padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; }
.task-inbox__refresh:disabled { opacity: 0.6; cursor: default; }
.task-inbox__filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.task-inbox__filters label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #374151; }
.task-inbox__checkbox { flex-direction: row !important; align-items: center; gap: 6px; }
.task-inbox__notice { padding: 8px 12px; border-radius: 6px; background: #f3f4f6; font-size: 13px; color: #374151; }
.task-inbox__notice--warn { background: #fef3c7; color: #92400e; }
.task-inbox__sources { display: flex; flex-wrap: wrap; gap: 8px; list-style: none; padding: 0; margin: 0; }
.task-inbox__source { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: #f3f4f6; font-size: 12px; }
.task-inbox__source--ok { background: #ecfdf5; }
.task-inbox__source--unsupported { background: #fef3c7; }
.task-inbox__source--error { background: #fee2e2; }
.task-inbox__source-reason { color: #6b7280; }
.task-inbox__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.task-inbox__table th, .task-inbox__table td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; vertical-align: top; }
.task-inbox__table th.is-sortable { cursor: pointer; user-select: none; }
.task-inbox__table th.is-active { color: #2563eb; }
.task-inbox__table tr.is-overdue { background: #fff7ed; }
.task-inbox__badge--overdue { color: #b91c1c; font-weight: 600; }
.task-inbox__badge--ok { color: #059669; }
.task-inbox__ref { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #6b7280; word-break: break-all; }
.task-inbox__hint, .task-inbox__footnote { font-size: 12px; color: #6b7280; }
</style>
