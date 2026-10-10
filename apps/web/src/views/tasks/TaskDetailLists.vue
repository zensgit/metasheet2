<template>
  <section ref="rootRef" class="tasks-detail-lists" data-testid="tasks-detail-lists" aria-labelledby="tasks-detail-lists-heading">
    <h3 id="tasks-detail-lists-heading">{{ t.listsHeading }}</h3>

    <p v-if="listIds.length === 0" class="tasks-detail-lists__message" data-testid="tasks-detail-lists-empty">
      {{ t.listsEmpty }}
    </p>
    <ul v-else class="tasks-detail-lists__items" data-testid="tasks-detail-lists-items">
      <li v-for="row in rows" :key="row.id" class="tasks-detail-lists__item" data-testid="tasks-detail-lists-item" :data-list-id="row.id">
        <span data-testid="tasks-detail-lists-item-name">{{ row.label }}</span>
        <span v-if="row.notMember" data-testid="tasks-detail-lists-not-member">{{ t.listsNotMember }}</span>
        <template v-if="canEdit">
          <button
            v-if="confirmingId !== row.id"
            type="button"
            data-testid="tasks-detail-lists-remove"
            :aria-label="fmt.listsRemoveFrom(row.label)"
            :disabled="pending"
            @click="openRemoveConfirm(row.id)"
          >{{ t.listsRemove }}</button>
          <span v-else data-testid="tasks-detail-lists-remove-confirm">
            <span id="tasks-detail-lists-remove-prompt" data-testid="tasks-detail-lists-remove-prompt">{{ t.listsRemoveConfirmPrompt }}</span>
            <button
              type="button"
              data-testid="tasks-detail-lists-remove-confirm-yes"
              aria-describedby="tasks-detail-lists-remove-prompt"
              :disabled="pending"
              @click="emit('remove', row.id)"
            >{{ t.listsRemoveConfirm }}</button>
            <button
              type="button"
              data-testid="tasks-detail-lists-remove-confirm-cancel"
              :disabled="pending"
              @click="cancelRemoveConfirm(row.id)"
            >{{ t.cancel }}</button>
          </span>
        </template>
      </li>
    </ul>

    <p v-if="myLists.kind === 'unavailable'" class="tasks-detail-lists__message" data-testid="tasks-detail-lists-mine-unavailable">
      {{ t.listsMineUnavailable }}
    </p>
    <template v-else-if="canAdd">
      <p v-if="myLists.kind === 'loading'" class="tasks-detail-lists__message" data-testid="tasks-detail-lists-mine-loading">
        {{ t.loading }}
      </p>
      <p v-else-if="candidates.length === 0" class="tasks-detail-lists__message" data-testid="tasks-detail-lists-no-candidates">
        {{ t.listsNoCandidates }}
      </p>
      <form v-else class="tasks-detail-lists__add" data-testid="tasks-detail-lists-add-form" @submit.prevent="onAdd">
        <label for="tasks-detail-lists-add-select">{{ t.listsAddLabel }}</label>
        <select
          id="tasks-detail-lists-add-select"
          v-model="selectedListId"
          data-testid="tasks-detail-lists-add-select"
          :disabled="pending"
        >
          <option value="">{{ t.listsAddPlaceholder }}</option>
          <option v-for="list in candidates" :key="list.id" :value="list.id">{{ list.name }}</option>
        </select>
        <button type="submit" data-testid="tasks-detail-lists-add-submit" :disabled="pending || !candidateIds.has(selectedListId)">
          {{ t.listsAdd }}
        </button>
      </form>
    </template>

    <p v-if="errorMessage" class="tasks-detail-lists__error" data-testid="tasks-detail-lists-error" role="alert">
      {{ errorMessage }}
    </p>
  </section>
</template>

<script lang="ts">
import type { TaskList } from '../../tasks/tasksApi'

/** TasksView's "my lists" read (every page of `GET /api/task-lists?includeArchived=true`).
 *  `complete` is false when the read stopped at the page bound with more lists on the server. */
export type MyListsState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: TaskList[]; complete: boolean }
  | { kind: 'unavailable' }

/** The inline error of the last add / remove: the folded 404 of an add, or a contract code. */
export type DetailListsError = { kind: 'add_not_found' } | { kind: 'code'; code: string }
</script>

<script setup lang="ts">
/**
 * The `/tasks/:id` "lists holding this task" section (design §4.3; backend `listIds` on the
 * detail body, PR-3a S7, and `POST` / `DELETE /api/task-lists/:id/items…`).
 *
 * Stateless apart from the picker's selection and the open remove confirmation (`[fe-15]`): the
 * list ids come from the detail, the names from TasksView's "my lists" read, and both writes are
 * emitted (`add` / `remove`) for TasksView to send on its shared detail-action token — so every
 * control here is disabled while ANY detail action is pending, and an add / remove in flight
 * disables every other detail action.
 *
 * Rules:
 *   - a list id is shown by name when it is one of my lists; once the "my lists" read is complete,
 *     an id that is not among them is shown as the id plus "not a member"; while that read is
 *     loading or failed, ids are shown as they are;
 *   - the picker offers my lists where I am `edit` or `owner` and that do not hold the task yet;
 *   - every row has a remove control, behind an inline two-step confirmation (no
 *     `window.confirm`); the server answers for the rows I may not touch ([own-25] below);
 *     opening it focuses its confirm button, which the prompt describes, and cancelling it focuses
 *     the row's remove button that comes back (`[fe-50]`);
 *   - the remove controls show when the task's `canEdit` allows editing it (a list editor removes
 *     from a list they edit; the creator through the creator branch); the add picker shows when
 *     `canAdd` does — TasksView passes the task's member-management ability (`[fe-47]`: adding
 *     takes a direct role on the task, creator or assignee, the very predicate behind
 *     `canManageMembers`), so a viewer who edits the task only through a list sees no picker that
 *     could only answer 404.
 */
import { computed, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { TASKS_EN, TASKS_FMT_EN, TASKS_FMT_ZH, TASKS_ZH, codeMessage, type TasksText } from '../../tasks/labels'
import { focusAfterSwap } from '../../tasks/tasksFocus'

// RULED(2026-10-07): [own-25] (PR-3a, R12 (a2)) — the task's creator may remove it from a list
// they are not a member of, so every row offers removal and a 404 is the server's answer for the
// rest.
// RULED(2026-10-07): [R04] — nothing here assumes the task shows in any list view.
const props = defineProps<{
  listIds: string[]
  myLists: MyListsState
  canEdit: boolean
  canAdd: boolean
  pending: boolean
  error: DetailListsError | null
}>()

const emit = defineEmits<{
  (event: 'add', listId: string): void
  (event: 'remove', listId: string): void
}>()

const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const fmt = computed(() => (isZh.value ? TASKS_FMT_ZH : TASKS_FMT_EN))

const selectedListId = ref('')
const confirmingId = ref<string | null>(null)
const rootRef = ref<HTMLElement | null>(null)

function openRemoveConfirm(listId: string): void {
  confirmingId.value = listId
  void focusAfterSwap(() => rootRef.value, 'tasks-detail-lists-remove-confirm-yes', { attr: 'data-list-id', value: listId })
}

function cancelRemoveConfirm(listId: string): void {
  confirmingId.value = null
  void focusAfterSwap(() => rootRef.value, 'tasks-detail-lists-remove', { attr: 'data-list-id', value: listId })
}

const rows = computed(() => {
  const mine = props.myLists
  return props.listIds.map((id) => {
    const list = mine.kind === 'ok' ? mine.items.find((item) => item.id === id) : undefined
    return {
      id,
      label: list ? list.name : id,
      notMember: mine.kind === 'ok' && mine.complete && list === undefined,
    }
  })
})

const candidates = computed<TaskList[]>(() => {
  const mine = props.myLists
  if (mine.kind !== 'ok') return []
  const held = new Set(props.listIds)
  return mine.items.filter((list) => (list.myRole === 'edit' || list.myRole === 'owner') && !held.has(list.id))
})

const candidateIds = computed(() => new Set(candidates.value.map((list) => list.id)))

const errorMessage = computed<string | null>(() => {
  const error = props.error
  if (!error) return null
  if (error.kind === 'add_not_found') return t.value.listsAddNotFound
  // ASSUMPTION(task-m4-fe): [D14] — `LIMIT` here is the per-task list quota.
  if (error.code === 'LIMIT') return t.value.codeLimitTaskLists
  return codeMessage(error.code, t.value)
})

// One detail action at a time is enforced by TasksView's handler (and the button is disabled
// while an action is pending); this only keeps a non-candidate from emitting.
function onAdd(): void {
  const listId = selectedListId.value
  if (!candidateIds.value.has(listId)) return
  emit('add', listId)
}
</script>

<style scoped>
.tasks-detail-lists__items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-detail-lists__item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.tasks-detail-lists__add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.tasks-detail-lists__message {
  color: var(--el-text-color-secondary, #666);
}

.tasks-detail-lists__error {
  color: var(--el-color-danger, #c45656);
}
</style>
