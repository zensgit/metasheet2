<template>
  <section class="tasks-view" aria-labelledby="tasks-view-title">
    <template v-if="contextState?.state === 'ready'">
      <!-- `/tasks/:id` loads this SAME component (tasks-routes.spec.ts gate 22) but there is no
           `GET /api/tasks/:id` yet (backend PR #6062 does not ship one) — this stays a skeleton
           that says so, and issues no list read. -->
      <template v-if="taskId">
        <header class="tasks-view__header">
          <h1 id="tasks-view-title">任务</h1>
        </header>
        <p class="tasks-view__placeholder" data-testid="tasks-view-placeholder">
          任务详情功能尚未提供
        </p>
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
            <span class="tasks-view__item-title">{{ task.title }}</span>
            <span class="tasks-view__item-status">{{ task.status === 'done' ? '已完成' : '进行中' }}</span>
            <span v-if="task.due_at" class="tasks-view__item-due">{{ task.due_at }}</span>
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
  listTasks,
  reopenTask,
  type CompletionMode,
  type TaskListItem,
  type TaskView,
} from '../../tasks/tasksApi'
import { notifyTasksChanged } from '../../tasks/tasksBadgeBus'

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

function switchView(view: TaskView): void {
  if (view === currentView.value) return
  currentView.value = view
  void loadList()
}

async function onCreate(): Promise<void> {
  const title = newTitle.value.trim()
  if (!title || creating.value) return
  creating.value = true
  createErrorVisible.value = false
  try {
    const result = await createTask({ title, completionMode: newCompletionMode.value })
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

async function onComplete(id: string): Promise<void> {
  actionErrorKind.value = null
  const result = await completeTask(id)
  if (result.kind === 'org_missing') {
    orgMissingFromAction.value = true
    return
  }
  if (result.kind === 'ok') {
    notifyTasksChanged()
    await loadList()
    return
  }
  // 'forbidden' | 'not_found' | 'error' — surfaced via `actionErrorMessage`; the list is left
  // exactly as it is (no `loadList()` call), so the row the action failed on stays visible.
  actionErrorKind.value = result.kind
}

async function onReopen(id: string): Promise<void> {
  actionErrorKind.value = null
  const result = await reopenTask(id, 'self')
  if (result.kind === 'org_missing') {
    orgMissingFromAction.value = true
    return
  }
  if (result.kind === 'ok') {
    notifyTasksChanged()
    await loadList()
    return
  }
  actionErrorKind.value = result.kind
}

// Vue Router reuses this component instance across `/tasks` <-> `/tasks/:id` navigations (both
// resolve to the same file), so `onMounted` alone would miss a same-instance transition back to
// the list. Re-issuing the list read only on that specific transition (id -> none) keeps the
// detail skeleton's own "no list call" rule intact for the other direction.
watch(taskId, (id) => {
  if (!id && contextState.value?.state === 'ready') {
    void loadList()
  }
})

onMounted(async () => {
  contextState.value = await loadTasksContext()
  if (contextState.value.state === 'ready' && !taskId.value) {
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

.tasks-view__placeholder,
.tasks-view__message {
  color: var(--el-text-color-secondary, #666);
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
