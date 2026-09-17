<template>
  <div class="todo-center" data-testid="todo-center">
    <h1 class="todo-center__title">{{ isZh ? '待办中心' : 'Todo Center' }}</h1>

    <p
      v-if="loadFailed"
      class="todo-center__status todo-center__status--failed"
      data-testid="todo-center-load-failed"
      role="alert"
    >
      {{ isZh ? '待办列表暂时无法加载,请稍后重试' : 'Could not load your to-dos right now. Please try again later.' }}
    </p>

    <template v-else>
      <section
        v-for="group in groups"
        :key="group.source"
        class="todo-center__group"
        :data-testid="`todo-center-group-${group.source}`"
      >
        <h2 class="todo-center__group-title">{{ sourceLabel(group.source) }}</h2>

        <!-- 判据 B negative control: `unavailable` and "checked, zero items" must never share a
             DOM shape — one says "could not tell", the other says "told you: none". -->
        <p
          v-if="group.status === 'unavailable'"
          class="todo-center__status todo-center__status--unavailable"
          data-testid="todo-center-group-unavailable"
          role="status"
        >
          {{ isZh ? '该来源暂时无法查询' : 'This source could not be checked right now' }}
        </p>
        <p
          v-else-if="group.items.length === 0"
          class="todo-center__status todo-center__status--empty"
          data-testid="todo-center-group-empty"
        >
          {{ isZh ? '暂无待办' : 'Nothing pending' }}
        </p>
        <ul v-else class="todo-center__items">
          <li v-for="item in group.items" :key="item.id" class="todo-center__item">
            <router-link :to="item.href" class="todo-center__item-link" data-testid="todo-center-item">
              <span class="todo-center__item-title">{{ item.title }}</span>
              <!-- 判据 C′: an item the viewer cannot currently act on renders visibly differently
                   from an actionable one (a view-only pill), never the same shape. Absent when the
                   source has no such notion (item.actionable === undefined) — nothing to render. -->
              <span
                v-if="item.actionable === false"
                class="todo-center__pill todo-center__pill--view-only"
                data-testid="todo-center-item-view-only"
              >{{ isZh ? '仅查看' : 'View only' }}</span>
            </router-link>
          </li>
        </ul>
      </section>

      <p
        v-if="groups.length === 0"
        class="todo-center__status"
        data-testid="todo-center-no-sources"
      >
        {{ isZh ? '暂无可用的待办来源' : 'No todo sources are registered' }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
// Todo Center page (B-2 phase 2, todo-center-design-lock v2.14 §4 front-end half).
//
// GROUPING RULE, and why it is the one thing this file must get right: groups are derived from
// `response.sources` (every registered source name, each already carrying its own `ok`/`unavailable`
// status), NOT from `response.items`. An `unavailable` source contributes zero items by
// construction (`pending-source-registry.ts`'s fail-closed catch) — deriving groups from `items`
// alone would make that source's group silently vanish, rendering byte-identical to "checked this
// source, it had nothing" (`ok` + 0 items). Lock §5 判据 B's negative control names exactly this:
// the two must never share a DOM shape. `sources`-driven grouping is what keeps them apart.
//
// 判据 E (代数守卫): copied WHOLE from `ApprovalTodoBadge.vue`'s mechanism (not re-derived item by
// item — see that file's docblock for why the microtask defer + `hasSession()` gate around the
// re-read are load-bearing, not incidental). Two independent monotonic-generation bumps:
//   * `refresh()`'s own bump discards a stale response when the transition issues its OWN new read
//     (a session remains — org/account switch).
//   * the auth-transition listener's bump discards a stale response when the transition issues NO
//     new read of its own (sign-out — nothing else would supersede the in-flight read).
// Both clear the rendered state synchronously on transition so the departing principal's list never
// lingers for the width of the new read.
import { onMounted, onUnmounted, ref } from 'vue'
import { getTodoItems, type PendingItem, type PendingSourceStatus, type TodoItemsResponse } from '../api'
import { useLocale } from '../../composables/useLocale'
import { getAuthPrincipalKey, onAuthPrincipalChange } from '../../composables/authPrincipal'

interface TodoGroup {
  source: string
  status: PendingSourceStatus
  items: PendingItem[]
}

const SOURCE_LABELS_ZH: Record<string, string> = { approval: '审批' }
const SOURCE_LABELS_EN: Record<string, string> = { approval: 'Approvals' }

function hasSession(): boolean {
  try {
    return getAuthPrincipalKey() !== null
  } catch {
    // A storage read can throw (Safari private mode). "Cannot tell" is not "signed out", so the
    // re-read is still issued and the server decides — same rationale as the badge's identical guard.
    return true
  }
}

const { isZh } = useLocale()

const groups = ref<TodoGroup[]>([])
const loadFailed = ref(false)

function sourceLabel(source: string): string {
  const table = isZh.value ? SOURCE_LABELS_ZH : SOURCE_LABELS_EN
  return table[source] ?? source
}

function applyResult(response: TodoItemsResponse | null): void {
  if (response === null) {
    // The aggregation endpoint itself threw (a bug in the aggregator, not a per-source outage —
    // `routes/todo.ts` reserves 500 for exactly that case) or the read never reached the server.
    // Discriminable from every per-source `unavailable` group: this is "the whole page failed",
    // not "one source could not be checked".
    loadFailed.value = true
    groups.value = []
    return
  }
  loadFailed.value = false
  groups.value = Object.entries(response.sources).map(([source, status]) => ({
    source,
    status,
    items: response.items.filter((item) => item.source === source),
  }))
}

let generation = 0
let disposed = false

async function refresh(): Promise<void> {
  generation += 1
  const mine = generation
  try {
    const result = await getTodoItems()
    if (mine !== generation) return // superseded — see 判据 E note above
    applyResult(result)
  } catch {
    if (mine !== generation) return
    applyResult(null)
  }
}

const unsubscribeAuthPrincipal = onAuthPrincipalChange(() => {
  generation += 1
  groups.value = []
  loadFailed.value = false
  void Promise.resolve().then(() => {
    if (disposed || !hasSession()) return
    void refresh()
  })
})

onMounted(() => {
  void refresh()
})

onUnmounted(() => {
  disposed = true
  unsubscribeAuthPrincipal()
})

defineExpose({ refresh })
</script>

<style scoped>
.todo-center {
  padding: 16px 24px;
}

.todo-center__title {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 16px;
}

.todo-center__group {
  margin-bottom: 24px;
}

.todo-center__group-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-secondary, #666);
  margin: 0 0 8px;
}

.todo-center__status {
  font-size: 13px;
  color: var(--el-text-color-secondary, #666);
  margin: 0;
}

.todo-center__status--unavailable {
  color: var(--el-color-warning, #e6a23c);
}

.todo-center__status--failed {
  color: var(--el-color-danger, #f56c6c);
}

.todo-center__items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.todo-center__item {
  border-bottom: 1px solid var(--el-border-color-lighter, #ebeef5);
}

.todo-center__item-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 4px;
  text-decoration: none;
  color: inherit;
}

.todo-center__pill {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 9px;
  background: var(--el-fill-color-light, #f0f2f5);
  color: var(--el-text-color-secondary, #666);
  white-space: nowrap;
}
</style>
