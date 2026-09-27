<template>
  <section class="tasks-view" aria-labelledby="tasks-view-title">
    <template v-if="contextState?.state === 'ready'">
      <!-- `/tasks/:id` loads this SAME component (tasks-routes.spec.ts gate 22). Backend PR #6062
           ships `GET /api/tasks/:id`; this renders its real states. Design lock §5.2 "引导流三触发"
           still applies to the WRITE actions available here (complete/reopen can 422 ORG_MISSING) —
           that reuses the SAME `orgMissingFromAction` flag / guidance block the list branch uses, so
           it is checked first, before the detail read's own states. -->
      <template v-if="taskId">
        <header class="tasks-view__header">
          <h1 id="tasks-view-title">任务详情</h1>
          <router-link class="tasks-view__back-link" to="/tasks" data-testid="tasks-detail-back-link">
            &larr; 返回任务列表
          </router-link>
        </header>

        <template v-if="orgMissingFromAction">
          <p class="tasks-view__message" data-testid="tasks-view-org-missing" role="status">
            请先选择一个组织后再查看任务
          </p>
        </template>
        <template v-else>
          <p v-if="actionErrorMessage" class="tasks-view__message" data-testid="tasks-action-error" role="alert">
            {{ actionErrorMessage }}
          </p>

          <div v-if="detailResult.kind === 'ok'" class="tasks-view__detail" data-testid="tasks-detail">
            <h2 class="tasks-view__detail-title" data-testid="tasks-detail-title">{{ detailResult.task.title }}</h2>
            <p class="tasks-view__detail-status" data-testid="tasks-detail-status">
              {{ detailResult.task.status === 'done' ? '已完成' : '进行中' }}
            </p>
            <p class="tasks-view__detail-completion-mode" data-testid="tasks-detail-completion-mode">
              {{ detailResult.task.completionMode === 'all' ? '全部负责人完成' : '任一负责人完成' }}
            </p>
            <p class="tasks-view__detail-due" data-testid="tasks-detail-due">
              {{ formatDueDisplay(detailResult.task) }}
            </p>

            <ul class="tasks-view__detail-assignees" data-testid="tasks-detail-assignees">
              <li
                v-for="assignee in detailResult.task.assignees"
                :key="assignee.userId"
                class="tasks-view__detail-assignee"
                data-testid="tasks-detail-assignee"
              >
                <span class="tasks-view__detail-assignee-id">{{ assignee.userId }}</span>
                <span class="tasks-view__detail-assignee-status" data-testid="tasks-detail-assignee-status">
                  {{ assignee.completedAt ? `已完成于 ${formatViewerInstant(assignee.completedAt)}` : '未完成' }}
                </span>
              </li>
            </ul>

            <button
              v-if="detailResult.task.status === 'open' && detailResult.task.canComplete"
              type="button"
              data-testid="tasks-detail-complete-button"
              :disabled="detailActionPending"
              @click="onDetailComplete"
            >完成</button>
            <button
              v-if="detailResult.task.status === 'done' && detailResult.task.canReopen"
              type="button"
              data-testid="tasks-detail-reopen-button"
              :disabled="detailActionPending"
              @click="onDetailReopen"
            >重启</button>
          </div>
          <p
            v-else-if="detailResult.kind === 'not_found'"
            class="tasks-view__message"
            data-testid="tasks-detail-not-found"
            role="status"
          >未找到该任务</p>
          <p
            v-else-if="detailResult.kind === 'forbidden'"
            class="tasks-view__message"
            data-testid="tasks-detail-forbidden"
            role="status"
          >您没有权限查看此任务</p>
          <p
            v-else-if="detailResult.kind === 'error'"
            class="tasks-view__message"
            data-testid="tasks-detail-error"
            role="alert"
          >加载任务详情失败，请稍后重试</p>
          <p v-else class="tasks-view__message" data-testid="tasks-detail-loading">
            加载中…
          </p>
        </template>
      </template>

      <!-- Design lock §5.2 "引导流三触发": a list read or a write (create/complete/reopen) that
           reports org_missing hides the rest of the ready UI and shows the SAME guidance block the
           context-level 'org_missing' state below shows. `predicate_error` never sets this. -->
      <template v-else-if="orgMissingFromAction">
        <p class="tasks-view__message" data-testid="tasks-view-org-missing" role="status">
          请先选择一个组织后再查看任务
        </p>
      </template>

      <template v-else>
        <header class="tasks-view__header">
          <h1 id="tasks-view-title">任务</h1>
        </header>

        <nav class="tasks-view__switcher" aria-label="任务视角">
          <button
            v-for="viewOption in VIEWS"
            :key="viewOption.value"
            type="button"
            class="tasks-view__switch-button"
            :data-testid="`tasks-view-switch-${viewOption.value}`"
            :aria-pressed="currentView === viewOption.value"
            :disabled="currentView === viewOption.value"
            @click="switchView(viewOption.value)"
          >{{ viewOption.label }}</button>
        </nav>

        <form class="tasks-view__create" data-testid="tasks-create-form" @submit.prevent="onCreate">
          <input
            v-model="newTitle"
            type="text"
            class="tasks-view__create-title"
            data-testid="tasks-create-title"
            placeholder="新建任务标题"
          />
          <select v-model="newCompletionMode" data-testid="tasks-create-completion-mode">
            <option value="all">全部负责人完成</option>
            <option value="any">任一负责人完成</option>
          </select>
          <button
            type="submit"
            data-testid="tasks-create-submit"
            :disabled="creating || newTitle.trim().length === 0"
          >创建</button>
        </form>
        <p v-if="createErrorVisible" class="tasks-view__message" data-testid="tasks-create-error" role="alert">
          创建任务失败，请稍后重试
        </p>
        <!-- Complete/reopen results other than ok/org_missing (forbidden / not_found / error) used
             to be silently dropped — the click just did nothing, with no way to tell "it worked" from
             "it failed". This surfaces the failure WITHOUT clearing the list, so the row the action
             failed on is still visible for a retry. -->
        <p v-if="actionErrorMessage" class="tasks-view__message" data-testid="tasks-action-error" role="alert">
          {{ actionErrorMessage }}
        </p>

        <ul v-if="listResult.kind === 'ok'" class="tasks-view__list" data-testid="tasks-list">
          <li v-for="task in listResult.items" :key="task.id" class="tasks-view__item" data-testid="tasks-list-item">
            <router-link
              class="tasks-view__item-title"
              :to="`/tasks/${encodeURIComponent(task.id)}`"
              data-testid="tasks-list-item-link"
            >{{ task.title }}</router-link>
            <span class="tasks-view__item-status">{{ task.status === 'done' ? '已完成' : '进行中' }}</span>
            <span v-if="task.due_at" class="tasks-view__item-due" data-testid="tasks-list-item-due">{{ formatViewerInstant(task.due_at) }}</span>
            <button
              v-if="task.status === 'open'"
              type="button"
              data-testid="tasks-complete-button"
              @click="onComplete(task.id)"
            >完成</button>
            <button
              v-else
              type="button"
              data-testid="tasks-reopen-button"
              @click="onReopen(task.id)"
            >重启</button>
          </li>
        </ul>
        <p v-else-if="listResult.kind === 'empty'" class="tasks-view__message" data-testid="tasks-list-empty">
          暂无任务
        </p>
        <p v-else-if="listResult.kind === 'error'" class="tasks-view__message" data-testid="tasks-list-error" role="alert">
          加载任务失败，请稍后重试
        </p>
        <p v-else class="tasks-view__message" data-testid="tasks-list-loading">
          加载中…
        </p>
      </template>
    </template>

    <template v-else-if="contextState?.state === 'org_missing'">
      <p class="tasks-view__message" data-testid="tasks-view-org-missing" role="status">
        请先选择一个组织后再查看任务
      </p>
    </template>

    <template v-else-if="contextState?.state === 'unavailable'">
      <p class="tasks-view__message" data-testid="tasks-view-unavailable" role="status">
        任务功能未启用或当前服务不支持
      </p>
    </template>

    <template v-else-if="contextState?.state === 'forbidden'">
      <p class="tasks-view__message" data-testid="tasks-view-forbidden" role="status">
        您没有权限查看任务
      </p>
    </template>

    <template v-else-if="contextState?.state === 'error'">
      <p class="tasks-view__message" data-testid="tasks-view-error" role="status">
        加载任务时出现错误，请稍后重试
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { loadTasksContext, type TasksContextResult } from '../../tasks/tasksContext'
import {
  completeTask,
  createTask,
  getTask,
  listTasks,
  reopenTask,
  type CompletionMode,
  type TaskDetail,
  type TaskListItem,
  type TaskView,
} from '../../tasks/tasksApi'
import { notifyTasksChanged } from '../../tasks/tasksBadgeBus'
import { formatDueDisplay, formatViewerInstant } from '../../tasks/tasksDateDisplay'

const route = useRoute()

/** `/tasks/:id`'s param, normalized: vue-router can hand back a `string[]` for a repeated segment,
 *  which this route never declares, but reading defensively costs nothing. */
const taskId = computed<string | undefined>(() => {
  const raw = (route as { params?: Record<string, unknown> } | undefined)?.params?.id
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return undefined
})

const contextState = ref<TasksContextResult | null>(null)

const VIEWS: Array<{ value: TaskView; label: string }> = [
  { value: 'assigned', label: '分配给我' },
  { value: 'following', label: '关注中' },
  { value: 'created', label: '我创建的' },
  { value: 'delegated', label: '我委派的' },
  { value: 'any_role', label: '任一角色' },
]

const currentView = ref<TaskView>('assigned')

type ListRenderState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: TaskListItem[] }
  | { kind: 'empty' }
  | { kind: 'error' }

const listResult = ref<ListRenderState>({ kind: 'loading' })

type DetailRenderState =
  | { kind: 'loading' }
  | { kind: 'ok'; task: TaskDetail }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

const detailResult = ref<DetailRenderState>({ kind: 'loading' })

const orgMissingFromAction = ref(false)

const newTitle = ref('')
const newCompletionMode = ref<CompletionMode>('all')
const creating = ref(false)
const createErrorVisible = ref(false)

/** Set by `onComplete`/`onReopen` for any result other than 'ok'/'org_missing' (those two are
 *  handled separately — 'ok' refreshes the list, 'org_missing' switches to the guidance block).
 *  'not_found' and 'error' share one generic message: neither is actionable differently by the
 *  viewer, unlike 'forbidden', which names the real cause. */
const actionErrorKind = ref<'forbidden' | 'not_found' | 'error' | null>(null)

const actionErrorMessage = computed(() => {
  if (actionErrorKind.value === 'forbidden') return '您没有权限修改此任务'
  if (actionErrorKind.value) return '操作失败，请稍后重试'
  return null
})

// Guards against a slow response for a superseded view (or a superseded reload) painting over a
// newer one's result — the same shape as this codebase's other transition-safe reads.
let listGeneration = 0

// Identifies "the list page" a row action (complete/reopen) — or the create form — started from,
// mirroring the detail page's own `taskId.value !== id` guard (see `onDetailComplete`/
// `onDetailReopen` below). Bumped whenever the viewer leaves the list for a reason an in-flight
// action can't see coming: navigating to `/tasks/:id` (the `watch(taskId, ...)` handler below) or
// switching to a different list view (`switchView`). A captured token that no longer matches after
// an await means the response belongs to a page the viewer isn't looking at anymore.
let listPageToken = 0

async function loadList(): Promise<void> {
  listGeneration += 1
  const mine = listGeneration
  listResult.value = { kind: 'loading' }
  const result = await listTasks(currentView.value)
  if (mine !== listGeneration) return

  if (result.kind === 'ok') {
    listResult.value = result.items.length === 0 ? { kind: 'empty' } : { kind: 'ok', items: result.items }
    return
  }
  if (result.kind === 'org_missing') {
    orgMissingFromAction.value = true
    return
  }
  // 'predicate_error' | 'forbidden' | 'not_found' | 'error': all render as the same discriminable
  // failure state (distinct from 'empty' — an empty 200 and a failed load must never look the
  // same), but 'predicate_error' specifically must NOT set `orgMissingFromAction`.
  listResult.value = { kind: 'error' }
}

// Same out-of-order-resolution discipline as `listGeneration` above, for the detail read: a
// superseded `getTask` response (an OLDER id's request resolving AFTER a NEWER id's already did)
// must never overwrite the currently-displayed task.
let detailGeneration = 0

async function loadDetail(id: string): Promise<void> {
  detailGeneration += 1
  const mine = detailGeneration
  detailResult.value = { kind: 'loading' }
  const result = await getTask(id)
  if (mine !== detailGeneration) return
  detailResult.value = result.kind === 'ok' ? { kind: 'ok', task: result.task } : { kind: result.kind }
}

function switchView(view: TaskView): void {
  if (view === currentView.value) return
  listPageToken += 1
  currentView.value = view
  void loadList()
}

async function onCreate(): Promise<void> {
  const title = newTitle.value.trim()
  if (!title || creating.value) return
  creating.value = true
  createErrorVisible.value = false
  const page = listPageToken
  try {
    const result = await createTask({ title, completionMode: newCompletionMode.value })
    // Same page-moved-on guard as `onComplete`/`onReopen` below — a late org_missing here would
    // otherwise flip `orgMissingFromAction`, which the detail-page template checks FIRST (before
    // its own states), painting the guidance block over whatever the viewer navigated to. A late
    // 'ok' still clears the typed title (the task really was created — leaving stale text sitting
    // in the input invites a duplicate submit next time the viewer is back on the list) and still
    // notifies the badge bus; it just has no current list to reload.
    if (page !== listPageToken) {
      if (result.kind === 'ok') {
        newTitle.value = ''
        notifyTasksChanged()
      }
      return
    }
    if (result.kind === 'ok') {
      newTitle.value = ''
      notifyTasksChanged()
      await loadList()
    } else if (result.kind === 'org_missing') {
      orgMissingFromAction.value = true
    } else {
      createErrorVisible.value = true
    }
  } finally {
    creating.value = false
  }
}

/** Shared result-classification for `completeTask`/`reopenTask` outcomes, used by BOTH the list
 *  row actions and the detail-page actions below. Returns `'ok'` when the caller should reload its
 *  own data source; any other outcome has already fully updated the shared `orgMissingFromAction` /
 *  `actionErrorKind` state and the caller does nothing further. */
function applyActionOutcome(kind: 'ok' | 'org_missing' | 'forbidden' | 'not_found' | 'error'): 'ok' | 'other' {
  if (kind === 'org_missing') {
    orgMissingFromAction.value = true
    return 'other'
  }
  if (kind === 'ok') {
    // P3(iii): a later action succeeding must clear a stale guidance flag left by an EARLIER
    // action (or an earlier list/detail read) — nothing else ever flips this back to false, so
    // without this the view would stay stuck on the org-guidance block for the rest of the mounted
    // instance even after the org context recovers. Reset BEFORE the reload, not after: the reload
    // can legitimately set this flag itself (its own org_missing branch), and resetting after it
    // would clobber that fresh `true` back to `false`.
    orgMissingFromAction.value = false
    notifyTasksChanged()
    return 'ok'
  }
  // 'forbidden' | 'not_found' | 'error' — surfaced via `actionErrorMessage`; the caller leaves its
  // own data exactly as it is (no reload), so whatever the action failed on stays visible.
  actionErrorKind.value = kind
  return 'other'
}

async function onComplete(id: string): Promise<void> {
  actionErrorKind.value = null
  const page = listPageToken
  const result = await completeTask(id)
  // Guard against the viewer having moved on WHILE the request was in flight — navigated to a
  // task's detail page, or switched to a different list view — mirroring the detail page's own
  // `taskId.value !== id` guard below. A late forbidden/error/org_missing must not paint its
  // banner/guidance over wherever the viewer is looking now, and a late 'ok' has no list left to
  // reload here (wherever they moved to already loaded its own data) — but it really did happen
  // server-side, so the shared badge bus still needs to hear about it.
  if (page !== listPageToken) {
    if (result.kind === 'ok') notifyTasksChanged()
    return
  }
  if (applyActionOutcome(result.kind) === 'ok') await loadList()
}

async function onReopen(id: string): Promise<void> {
  actionErrorKind.value = null
  const page = listPageToken
  const result = await reopenTask(id, 'self')
  if (page !== listPageToken) {
    if (result.kind === 'ok') notifyTasksChanged()
    return
  }
  if (applyActionOutcome(result.kind) === 'ok') await loadList()
}

// True while a detail complete/reopen request is in flight — disables both detail action buttons
// so a second click can't fire a second overlapping request. A per-request token (rather than a
// bare boolean flip in `finally`) so a STALE request's `finally` can never clear a NEWER request's
// pending flag out from under it.
const detailActionPending = ref(false)
let detailActionToken = 0

async function onDetailComplete(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await completeTask(id)
    // Guard against a navigation (to a different id, OR back to the list) that happened WHILE the
    // request was in flight. Checked BEFORE `applyActionOutcome` — not just before the reload:
    // a late 403/error/org_missing result must not paint its banner/guidance over whatever the
    // viewer is looking at now, and reloading a no-longer-current id would bump `detailGeneration`
    // and briefly paint the OLD task's data over it too. The watch below already issued its own
    // `loadDetail`/`loadList` for wherever the viewer navigated to, so this action has nothing
    // left to do there — except a late 'ok' really did happen server-side, so the shared badge
    // still needs to hear about it.
    if (taskId.value !== id) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (applyActionOutcome(result.kind) === 'ok') await loadDetail(id)
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

async function onDetailReopen(): Promise<void> {
  const id = taskId.value
  if (!id || detailActionPending.value) return
  actionErrorKind.value = null
  const token = ++detailActionToken
  detailActionPending.value = true
  try {
    const result = await reopenTask(id, 'self')
    if (taskId.value !== id) {
      if (result.kind === 'ok') notifyTasksChanged()
      return
    }
    if (applyActionOutcome(result.kind) === 'ok') await loadDetail(id)
  } finally {
    if (token === detailActionToken) detailActionPending.value = false
  }
}

// Vue Router reuses this component instance across `/tasks` <-> `/tasks/:id` navigations (both
// resolve to the same file), so `onMounted` alone would miss a same-instance transition. This
// fires on every edge: list -> detail and detail -> detail load the new id's detail; detail -> list
// reloads the list. Also clears any action-error state left over from whatever the viewer was
// looking at before — it belongs to that stale id, not the one now showing.
watch(taskId, (id) => {
  if (contextState.value?.state !== 'ready') return
  actionErrorKind.value = null
  // A navigation away invalidates whatever detail action was in flight for the PREVIOUS id — bump
  // the token so that request's own `finally` (see `onDetailComplete`/`onDetailReopen`) can no
  // longer be the one that clears `detailActionPending`, and unblock the buttons on wherever the
  // viewer just navigated to (there is no still-in-flight request FOR that page yet).
  detailActionToken += 1
  detailActionPending.value = false
  // Same idea for the LIST page's own row actions / create form (see `listPageToken` above) — any
  // route change away from (or between) `/tasks/:id` routes also means "the list" is no longer
  // what's showing, so a list action still in flight from before this navigation must be treated
  // as stale too.
  listPageToken += 1
  if (id) {
    void loadDetail(id)
  } else {
    void loadList()
  }
})

onMounted(async () => {
  contextState.value = await loadTasksContext()
  if (contextState.value.state !== 'ready') return
  if (taskId.value) {
    await loadDetail(taskId.value)
  } else {
    await loadList()
  }
})
</script>

<style scoped>
.tasks-view {
  padding: 24px;
}

.tasks-view__header h1 {
  margin: 0 0 8px;
}

.tasks-view__message {
  color: var(--el-text-color-secondary, #666);
}

.tasks-view__detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tasks-view__detail-assignees {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-view__detail-assignee {
  display: flex;
  gap: 12px;
  padding: 4px 0;
}

.tasks-view__switcher {
  display: flex;
  gap: 8px;
  margin: 12px 0;
}

.tasks-view__create {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.tasks-view__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-view__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter, #eee);
}
</style>
