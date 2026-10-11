<template>
  <aside class="tasks-lists" data-testid="tasks-lists-sidebar" aria-labelledby="tasks-lists-heading">
    <h2 id="tasks-lists-heading" class="tasks-lists__heading">{{ t.sidebarHeading }}</h2>

    <form class="tasks-lists__create" data-testid="tasks-lists-create-form" @submit.prevent="onCreate">
      <label for="tasks-lists-create-input">{{ t.sidebarCreateLabel }}</label>
      <input
        id="tasks-lists-create-input"
        v-model="newName"
        type="text"
        autocomplete="off"
        data-testid="tasks-lists-create-input"
        :placeholder="t.sidebarCreatePlaceholder"
        :disabled="creating"
        :aria-invalid="createError ? 'true' : undefined"
        :aria-describedby="createError ? 'tasks-lists-create-error' : undefined"
        @input="createError = null"
      />
      <button type="submit" data-testid="tasks-lists-create-submit" :disabled="creating || newName.trim().length === 0">
        {{ t.sidebarCreate }}
      </button>
      <p v-if="createErrorMessage" id="tasks-lists-create-error" class="tasks-lists__error" data-testid="tasks-lists-create-error" role="alert">
        {{ createErrorMessage }}
      </p>
    </form>

    <label class="tasks-lists__archived-toggle">
      <input type="checkbox" data-testid="tasks-lists-archived-toggle" :checked="includeArchived" @change="onToggleArchived" />
      {{ t.sidebarShowArchived }}
    </label>

    <p v-if="readState.kind === 'loading'" class="tasks-lists__message" data-testid="tasks-lists-loading">{{ t.loading }}</p>
    <p v-else-if="readState.kind === 'empty'" class="tasks-lists__message" data-testid="tasks-lists-empty">{{ t.sidebarEmpty }}</p>
    <p v-else-if="readState.kind === 'forbidden'" class="tasks-lists__message" data-testid="tasks-lists-forbidden" role="status">
      {{ t.sidebarForbidden }}
    </p>
    <p v-else-if="readState.kind === 'unavailable'" class="tasks-lists__message" data-testid="tasks-lists-unavailable" role="status">
      {{ t.sidebarUnavailable }}
    </p>
    <p v-else-if="readState.kind === 'error'" class="tasks-lists__message" data-testid="tasks-lists-error" role="alert">
      {{ t.sidebarLoadFailed }}
    </p>
    <template v-else>
      <ul class="tasks-lists__items" data-testid="tasks-lists-items">
        <li
          v-for="list in readState.items"
          :key="list.id"
          class="tasks-lists__item"
          data-testid="tasks-lists-item"
          :data-list-id="list.id"
          :data-role="list.myRole"
          :data-archived="list.archivedAt === null ? 'false' : 'true'"
        >
          <router-link
            class="tasks-lists__item-name"
            :to="`/task-lists/${encodeURIComponent(list.id)}`"
            data-testid="tasks-lists-item-link"
          >{{ list.name }}</router-link>
          <span class="tasks-lists__item-role" data-testid="tasks-lists-item-role">{{ roleLabel(list.myRole) }}</span>
          <span v-if="list.archivedAt !== null" class="tasks-lists__item-archived" data-testid="tasks-lists-item-archived">
            {{ t.listArchivedMark }}
          </span>
        </li>
      </ul>
      <button v-if="hasMore" type="button" data-testid="tasks-lists-more" :disabled="loadingMore" @click="onLoadMore">
        {{ t.loadMore }}
      </button>
      <p v-if="moreFailed" class="tasks-lists__error" data-testid="tasks-lists-more-error" role="alert">{{ t.sidebarLoadMoreFailed }}</p>
    </template>
  </aside>
</template>

<script setup lang="ts">
/**
 * The `/tasks` lists sidebar (M4 frontend design §2.4, §4.1; backend `GET` / `POST /api/task-lists`,
 * PR-3a S5). Mounted by TasksView inside its ready list branch, so it sits behind the same gate as
 * the page. Every `data-testid` here starts with `tasks-lists-` (`[fe-18]`): the sidebar stays on
 * the page in every list state, and none of its ids may coincide with the ids the list-page specs
 * count.
 *
 * Reads: one page of the viewer's lists at a time (`listTaskLists`, 100 per page, the server's
 * order); "load more" asks for the next offset until the rows read reach `total` (a row seen twice
 * is kept once). Archived lists are hidden until "show archived" is ticked; every change of that
 * box re-reads from offset 0 under a new generation, so an older page landing late is dropped.
 * States: loading / the list / empty / forbidden (403) / unavailable (404: a backend without the
 * list routes) / error. The degraded body (no org selected) is reported to TasksView, which shows
 * its org guidance block in place of the whole list page.
 *
 * Create: the name is pre-checked (`checkListName`) and sent normalized; one create at a time. The
 * two name codes render next to the input; a 403 / 404 / other failure renders there too. ok
 * clears the input, tells the lists bus (this sidebar's own subscription re-reads the first page,
 * as it does for every list change) and opens the new list. A create answered after the sidebar
 * was left only tells the bus.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import { TASKS_EN, TASKS_ZH, codeMessage, type TasksText } from '../../tasks/labels'
import { createTaskList, listTaskLists, type CollectionResult, type TaskList, type TaskListRole } from '../../tasks/tasksApi'
import { notifyListsChanged, onListsChanged } from '../../tasks/tasksListsBus'
import { checkListName, normalizeUserText } from '../../tasks/tasksDraft'

const emit = defineEmits<{
  (event: 'org-missing'): void
}>()

const router = useRouter()
const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))

type ReadState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: TaskList[] }
  | { kind: 'empty' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  | { kind: 'error' }

type CreateError = { kind: 'code'; code: string } | { kind: 'forbidden' } | { kind: 'unavailable' } | { kind: 'error' }

const includeArchived = ref(false)
const readState = ref<ReadState>({ kind: 'loading' })
/** Rows read from the server so far — the offset of the next page. */
const nextOffset = ref(0)
const total = ref(0)
const lastPageEmpty = ref(false)
const loadingMore = ref(false)
const moreFailed = ref(false)

const newName = ref('')
const creating = ref(false)
const createError = ref<CreateError | null>(null)

// Late-result guards: every read compares the generation it started under (a re-read or leaving
// the page advances it); a create compares its token (leaving the page advances it).
let readGeneration = 0
let createToken = 0

const hasMore = computed(() => readState.value.kind === 'ok' && nextOffset.value < total.value && !lastPageEmpty.value)

const createErrorMessage = computed<string | null>(() => {
  const error = createError.value
  if (!error) return null
  switch (error.kind) {
    case 'code':
      return codeMessage(error.code, t.value)
    case 'forbidden':
      return t.value.sidebarCreateForbidden
    case 'unavailable':
      return t.value.sidebarUnavailable
    default:
      return t.value.sidebarCreateFailed
  }
})

function roleLabel(role: TaskListRole): string {
  if (role === 'owner') return t.value.listRoleOwner
  if (role === 'edit') return t.value.listRoleEdit
  return t.value.listRoleRead
}

// ASSUMPTION(task-m4-fe): [own-19] (PR-3a) — with no org selected the lists read is the degraded
// 200 body; TasksView answers it with the same org guidance block as its own list read.
/** The read state for a failed collection read; `null` for the degraded body, which is reported
 *  to TasksView instead. */
// [fe-22] a 404 (a backend without the list routes) is its own "lists unavailable" state and a 403
// its own "no permission" state; neither uses the read-failure copy.
function failureState(result: Exclude<CollectionResult<TaskList>, { kind: 'ok' }>): ReadState | null {
  switch (result.kind) {
    case 'org_missing':
      return null
    case 'forbidden':
      return { kind: 'forbidden' }
    case 'not_found':
      return { kind: 'unavailable' }
    default:
      return { kind: 'error' }
  }
}

/** Reads the first page again (archived lists included when the box is ticked). */
async function loadFirstPage(): Promise<void> {
  readGeneration += 1
  const mine = readGeneration
  readState.value = { kind: 'loading' }
  loadingMore.value = false
  moreFailed.value = false
  const result = await listTaskLists({ includeArchived: includeArchived.value, offset: 0 })
  if (mine !== readGeneration) return
  if (result.kind === 'ok') {
    nextOffset.value = result.items.length
    total.value = result.total
    lastPageEmpty.value = result.items.length === 0
    readState.value = result.items.length === 0 ? { kind: 'empty' } : { kind: 'ok', items: uniqueById([], result.items) }
    return
  }
  const failed = failureState(result)
  if (failed === null) {
    emit('org-missing')
    return
  }
  readState.value = failed
}

function uniqueById(current: TaskList[], page: TaskList[]): TaskList[] {
  const seen = new Set(current.map((list) => list.id))
  const merged = [...current]
  for (const list of page) {
    if (seen.has(list.id)) continue
    seen.add(list.id)
    merged.push(list)
  }
  return merged
}

async function onLoadMore(): Promise<void> {
  if (readState.value.kind !== 'ok' || loadingMore.value) return
  const mine = readGeneration
  loadingMore.value = true
  moreFailed.value = false
  const result = await listTaskLists({ includeArchived: includeArchived.value, offset: nextOffset.value })
  if (mine !== readGeneration) return
  loadingMore.value = false
  const state = readState.value
  if (result.kind === 'ok') {
    nextOffset.value += result.items.length
    total.value = result.total
    lastPageEmpty.value = result.items.length === 0
    if (state.kind === 'ok') readState.value = { kind: 'ok', items: uniqueById(state.items, result.items) }
    return
  }
  if (result.kind === 'org_missing') {
    emit('org-missing')
    return
  }
  // The rows already shown stay; the button stays for a retry.
  moreFailed.value = true
}

function onToggleArchived(event: Event): void {
  includeArchived.value = (event.target as HTMLInputElement).checked
  void loadFirstPage()
}

// ASSUMPTION(task-m4-fe): [D14] — the name rule (1–100 code points after normalization) is the
// server's; the pre-check only saves a round trip.
async function onCreate(): Promise<void> {
  if (creating.value) return
  createError.value = null
  const check = checkListName(newName.value)
  if (check !== 'ok') {
    createError.value = { kind: 'code', code: check }
    return
  }
  const name = normalizeUserText(newName.value) ?? ''
  const token = ++createToken
  creating.value = true
  const result = await createTaskList(name)
  // The list exists on the server whether or not the viewer is still here.
  if (result.kind === 'ok') notifyListsChanged()
  if (token !== createToken) return
  creating.value = false
  switch (result.kind) {
    case 'ok':
      newName.value = ''
      void router.push(`/task-lists/${encodeURIComponent(result.list.id)}`)
      return
    case 'validation':
    case 'conflict':
      createError.value = { kind: 'code', code: result.code }
      return
    case 'org_missing':
      emit('org-missing')
      return
    case 'forbidden':
      createError.value = { kind: 'forbidden' }
      return
    case 'not_found':
      createError.value = { kind: 'unavailable' }
      return
    default:
      createError.value = { kind: 'error' }
  }
}

// Subscribed in setup, before anything awaits, so an early unmount can never leave a listener
// behind. [fe-23] the sidebar re-reads its first page on every lists-bus event — its own create
// included (the create notifies, a late ok too, and the re-read follows from here).
const unsubscribe = onListsChanged(() => {
  void loadFirstPage()
})

onMounted(() => {
  void loadFirstPage()
})

onBeforeUnmount(() => {
  unsubscribe()
  readGeneration += 1
  createToken += 1
})
</script>

<style scoped>
.tasks-lists {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 200px;
}

.tasks-lists__heading {
  margin: 0;
  font-size: 1rem;
}

.tasks-lists__create {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.tasks-lists__items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-lists__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
}

.tasks-lists__item-role,
.tasks-lists__item-archived,
.tasks-lists__message {
  color: var(--el-text-color-secondary, #666);
}

.tasks-lists__error {
  flex-basis: 100%;
  margin: 0;
  color: var(--el-color-danger, #c45656);
}
</style>
