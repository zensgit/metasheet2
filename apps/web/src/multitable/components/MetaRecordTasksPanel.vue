<!--
  关联任务 / Linked tasks — a collapsible section at the foot of the record inspector's 详情 tab, right
  after 审批 (MetaRecordApprovalPanel), package 2.

  What a business user gets: after dispatching tasks from a record, opening the record and expanding
  关联任务 lists the tasks dispatched from THIS record that the viewer can open — title, status, due
  date — each a link to /tasks/:id.

  WIRE: GET /api/multitable/sheets/:sheetId/records/:recordId/tasks through the workbench's own client
  (`listRecordTasks`). The server passes the task read door and the record read gate, then answers only
  the linked tasks the viewer could open from the task centre, in the viewer's org. It answers no count,
  so this panel can show none: an empty list says nothing about tasks the viewer cannot open.

  SELF-GATING: renders NOTHING unless a record, a sheetId and an apiClient are all present AND the top
  bar's 任务 rule holds (`canSeeTasksEntry`: the tasks feature is on and the viewer holds tasks:read).
  With the tasks feature off nothing about tasks renders and no request is sent. The permission snapshot
  is not reactive, so the rule is re-read on every record move, the way the inspector re-reads its 派发任务
  gate.

  LAZY: the GET fires on FIRST EXPAND only — never on record open. Collapse/re-expand reuses the loaded
  list. A change signal always INVALIDATES that cache: a record switch, `refreshToken` being bumped, or a
  task change the viewer made on this page (`onTasksChanged`, which the 派发任务 dialog fires after a
  create). An open section re-reads at once; a collapsed one re-reads on its next expand. A signal that
  lands mid-read is queued, because the read in flight is about to write the rows from before it.

  STATES: loading; a list; empty; 403 → its own sentence (no retry: the answer will not change); 404, or
  a server that could not tell the session's org → "not available right now"; anything else → a generic
  failure with a manual 重试. None of them carries the thrown message or a status code.

  VALUES-FREE: renders the task title, a status, a due date and a link. No person, no record value.
-->
<template>
  <section v-if="sectionVisible" class="meta-record-tasks" data-test="record-tasks">
    <button
      type="button"
      class="meta-record-tasks__toggle"
      data-test="record-tasks-toggle"
      :aria-expanded="expanded"
      :aria-controls="bodyId"
      :title="expanded ? l('recordTasks.panelCollapse') : l('recordTasks.panelExpand')"
      @click="onToggle"
    >
      <span class="meta-record-tasks__caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <span class="meta-record-tasks__title">{{ l('recordTasks.panelTitle') }}</span>
    </button>
    <div v-if="expanded" :id="bodyId" class="meta-record-tasks__body" data-test="record-tasks-body">
      <div
        v-if="loading"
        class="meta-record-tasks__hint"
        data-test="record-tasks-loading"
      >{{ l('recordTasks.panelLoading') }}</div>
      <template v-else-if="failure">
        <div
          class="meta-record-tasks__hint meta-record-tasks__hint--error"
          data-test="record-tasks-error"
          :data-failure="failure"
        >{{ failureText }}</div>
        <button
          v-if="failure === 'failed'"
          type="button"
          class="meta-record-tasks__retry"
          data-test="record-tasks-retry"
          @click="onRetry"
        >{{ l('recordTasks.panelRetry') }}</button>
      </template>
      <ul
        v-else-if="items.length > 0"
        class="meta-record-tasks__list"
        data-test="record-tasks-list"
      >
        <li
          v-for="item in items"
          :key="item.id"
          class="meta-record-tasks__entry"
          data-test="record-tasks-entry"
        >
          <RouterLink
            v-if="hasRouter"
            class="meta-record-tasks__link"
            data-test="record-tasks-link"
            :to="taskPath(item.id)"
          >{{ item.title || l('recordTasks.untitled') }}</RouterLink>
          <a
            v-else
            class="meta-record-tasks__link"
            data-test="record-tasks-link"
            :href="taskPath(item.id)"
          >{{ item.title || l('recordTasks.untitled') }}</a>
          <span class="meta-record-tasks__meta">
            <span
              v-if="statusLabel(item.status)"
              class="meta-record-tasks__status"
              data-test="record-tasks-status"
              :data-status="item.status"
            >{{ statusLabel(item.status) }}</span>
            <span v-if="dueText(item)" data-test="record-tasks-due">{{ l('recordTasks.due') }} {{ dueText(item) }}</span>
          </span>
        </li>
      </ul>
      <div
        v-else
        class="meta-record-tasks__hint"
        data-test="record-tasks-empty"
      >{{ l('recordTasks.panelEmpty') }}</div>
      <!-- The server's own truncation flag for the page we asked for, shown only beside rows on screen.
           It counts the rows rendered, never a total. -->
      <div
        v-if="hasMore && !loading && !failure && items.length > 0"
        class="meta-record-tasks__hint meta-record-tasks__more"
        data-test="record-tasks-has-more"
      >{{ hasMoreNotice }}</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onUnmounted, ref, useId, watch } from 'vue'
import { RouterLink, routerKey } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import { useAuth } from '../../composables/useAuth'
import { useFeatureFlags } from '../../stores/featureFlags'
import { canSeeTasksEntry } from '../../tasks/tasksAccess'
import { onTasksChanged } from '../../tasks/tasksBadgeBus'
import { formatBusinessTimestamp } from '../utils/business-timezone'
import { recordLabel, recordTasksHasMoreNotice, type MetaRecordLabelKey } from '../utils/meta-record-labels'
import type { MultitableApiClient, MetaRecordTaskItem } from '../api/client'
import type { MetaRecord } from '../types'

const props = defineProps<{
  record?: MetaRecord | null
  sheetId?: string
  apiClient?: MultitableApiClient
  /** Bumped by the inspector when its own action changed the record's tasks. A plain counter: this
   *  panel stays the one place that reads the list from the server. */
  refreshToken?: number
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey) => recordLabel(key, isZh.value)
// Non-throwing inject: the drawer mounts without a router in several specs.
const hasRouter = !!inject(routerKey, null)

const featureFlags = useFeatureFlags()
const auth = useAuth()
// The top bar's 任务 rule, and not inside a focused product shell (attendance-only, plm-workbench-only),
// whose route allowlists do not include /tasks, the same as the drawer's 派发任务 entry. `hasPermission`
// reads a stored snapshot that is not reactive, so the rule is re-read on every record move.
const canSeeTasks = computed(() => {
  void props.record?.id
  if (featureFlags.isAttendanceFocused() || featureFlags.isPlmWorkbenchFocused()) return false
  return canSeeTasksEntry({ hasFeature: featureFlags.hasFeature, hasPermission: auth.hasPermission })
})

/** The page this panel asks for, named so the server's default can change without changing it. */
const RECORD_TASKS_PAGE_SIZE = 20

type Failure = 'forbidden' | 'unavailable' | 'failed'

const bodyId = `meta-record-tasks-${useId()}`
const expanded = ref(false)
const loading = ref(false)
const loaded = ref(false)
const failure = ref<Failure | null>(null)
const items = ref<MetaRecordTaskItem[]>([])
const hasMore = ref(false)

const sectionVisible = computed(() => Boolean(props.record && props.sheetId && props.apiClient && canSeeTasks.value))

const failureText = computed(() => {
  if (failure.value === 'forbidden') return l('recordTasks.panelForbidden')
  if (failure.value === 'unavailable') return l('recordTasks.panelUnavailable')
  return l('recordTasks.panelError')
})

const hasMoreNotice = computed(() => recordTasksHasMoreNotice(items.value.length, isZh.value))

function statusLabel(status: string): string {
  if (status === 'open') return l('recordTasks.statusOpen')
  if (status === 'done') return l('recordTasks.statusDone')
  return ''
}

function dueText(item: MetaRecordTaskItem): string {
  if (item.dueDate) return item.dueDate
  if (item.dueAt) return formatBusinessTimestamp(item.dueAt) ?? ''
  return ''
}

function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`
}

function classify(error: unknown): Failure {
  const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
  if (status === 403) return 'forbidden'
  if (status === 404) return 'unavailable'
  return 'failed'
}

// Stale-response guard: a load whose captured version no longer matches when it settles was superseded
// by a record switch, a refresh or the unmount, and writes nothing.
let activeLoadVersion = 0
// A change signal that arrives while a read is in flight re-runs the read from its own `finally`.
let refreshPending = false

function resetState(): void {
  activeLoadVersion += 1
  refreshPending = false
  expanded.value = false
  loading.value = false
  loaded.value = false
  failure.value = null
  items.value = []
  hasMore.value = false
}

function invalidate(): void {
  loaded.value = false
  if (!expanded.value) return
  if (loading.value) {
    refreshPending = true
    return
  }
  void loadTasks()
}

// Record navigation inside the drawer must not show the previous record's tasks.
watch(() => props.record?.id, () => {
  resetState()
})

watch(() => props.refreshToken, () => {
  invalidate()
})

// A task change the viewer made on this page (a dispatch from this drawer included).
const stopTasksChanged = onTasksChanged(() => {
  invalidate()
})

onUnmounted(() => {
  activeLoadVersion += 1
  stopTasksChanged()
})

async function loadTasks(): Promise<void> {
  if (loaded.value || loading.value) return
  const client = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  const loadVersion = ++activeLoadVersion
  if (!client || !sheetId || !recordId || !canSeeTasks.value) {
    items.value = []
    hasMore.value = false
    loaded.value = true
    return
  }
  loading.value = true
  failure.value = null
  try {
    const page = await client.listRecordTasks(sheetId, recordId, { limit: RECORD_TASKS_PAGE_SIZE })
    if (loadVersion !== activeLoadVersion) return
    if (page.degraded) {
      items.value = []
      hasMore.value = false
      failure.value = 'unavailable'
    } else {
      items.value = page.items
      hasMore.value = page.hasMore
    }
    loaded.value = true
  } catch (error) {
    if (loadVersion !== activeLoadVersion) return
    items.value = []
    hasMore.value = false
    failure.value = classify(error)
    // A 403 or a 404 is an answer: it is kept until the next change signal. A generic failure is
    // retried by the button or by the next expand.
    loaded.value = failure.value !== 'failed'
  } finally {
    if (loadVersion === activeLoadVersion) {
      loading.value = false
      if (refreshPending) {
        refreshPending = false
        loaded.value = false
        if (expanded.value) void loadTasks()
      }
    }
  }
}

function onToggle(): void {
  expanded.value = !expanded.value
  if (expanded.value) void loadTasks()
}

function onRetry(): void {
  loaded.value = false
  void loadTasks()
}
</script>

<style scoped>
.meta-record-tasks { margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 10px; }
.meta-record-tasks__toggle { display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; cursor: pointer; color: #475569; font-size: 12px; font-weight: 600; }
.meta-record-tasks__caret { font-size: 10px; color: #94a3b8; }
.meta-record-tasks__title { letter-spacing: 0.02em; }
.meta-record-tasks__body { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.meta-record-tasks__hint { font-size: 12px; color: #94a3b8; }
.meta-record-tasks__hint--error { color: #b45309; }
.meta-record-tasks__retry { align-self: flex-start; background: none; border: none; padding: 0; cursor: pointer; font-size: 11px; color: var(--ms-color-primary, #409eff); }
.meta-record-tasks__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.meta-record-tasks__entry { display: flex; flex-direction: column; gap: 3px; border-left: 2px solid #e2e8f0; padding-left: 8px; }
.meta-record-tasks__link { font-size: 12px; color: var(--ms-color-primary, #409eff); }
.meta-record-tasks__meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: #64748b; }
.meta-record-tasks__status { font-size: 11px; color: #64748b; background: #f1f5f9; border-radius: 4px; padding: 1px 6px; }
.meta-record-tasks__more { color: #b45309; }
</style>
