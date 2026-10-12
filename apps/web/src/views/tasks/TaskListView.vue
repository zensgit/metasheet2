<template>
  <section ref="pageRef" class="tasks-list-page" aria-labelledby="tasks-list-detail-title">
    <header class="tasks-list-page__header">
      <h1 id="tasks-list-detail-title" data-testid="tasks-list-detail-title">{{ headerTitle }}</h1>
      <router-link class="tasks-list-page__back-link" to="/tasks" data-testid="tasks-list-detail-back-link">
        &larr; {{ t.backToList }}
      </router-link>
    </header>

    <p v-if="contextState === null" class="tasks-list-page__message" data-testid="tasks-list-detail-loading">{{ t.loading }}</p>

    <template v-else-if="contextState.state === 'ready'">
      <!-- A write or a collection read that reports org_missing: the same guidance block as the
           context-level org_missing state below, in place of the page. -->
      <p v-if="orgMissing" class="tasks-list-page__message" data-testid="tasks-view-org-missing" role="status">
        {{ t.orgMissing }}
      </p>
      <p v-else-if="listResult.kind === 'loading'" class="tasks-list-page__message" data-testid="tasks-list-detail-loading">
        {{ t.loading }}
      </p>
      <p v-else-if="listResult.kind === 'not_found'" class="tasks-list-page__message" data-testid="tasks-list-detail-not-found" role="status">
        {{ t.listNotFound }}
      </p>
      <p v-else-if="listResult.kind === 'forbidden'" class="tasks-list-page__message" data-testid="tasks-list-detail-forbidden" role="status">
        {{ t.listForbidden }}
      </p>
      <p v-else-if="listResult.kind === 'error'" class="tasks-list-page__message" data-testid="tasks-list-detail-error" role="alert">
        {{ t.listPageLoadFailed }}
      </p>

      <div v-else class="tasks-list-page__body" data-testid="tasks-list-detail" :aria-busy="pending ? 'true' : 'false'">
        <p v-if="bannerMessage" class="tasks-list-page__message" data-testid="tasks-list-detail-banner" role="alert">{{ bannerMessage }}</p>

        <div class="tasks-list-page__meta">
          <span data-testid="tasks-list-detail-role" :data-role="listResult.list.myRole">
            {{ t.listMyRoleLabel }}{{ roleLabel(listResult.list.myRole) }}
          </span>
          <span v-if="listResult.list.archivedAt !== null" data-testid="tasks-list-detail-archived">{{ t.listArchivedMark }}</span>
        </div>

        <div class="tasks-list-page__actions">
          <template v-if="canManage">
            <button
              v-if="!renameOpen"
              type="button"
              data-testid="tasks-list-detail-rename"
              :disabled="pending"
              @click="openRename"
            >{{ t.listRename }}</button>
            <form v-else class="tasks-list-page__rename" data-testid="tasks-list-detail-rename-form" @submit.prevent="onRename">
              <label for="tasks-list-detail-rename-input">{{ t.listRenameLabel }}</label>
              <input
                id="tasks-list-detail-rename-input"
                v-model="renameDraft"
                type="text"
                autocomplete="off"
                data-testid="tasks-list-detail-rename-input"
                :disabled="pending"
                :aria-invalid="renameError ? 'true' : undefined"
                :aria-describedby="renameError ? 'tasks-list-detail-rename-error' : undefined"
                @input="renameError = null"
              />
              <button type="submit" data-testid="tasks-list-detail-rename-submit" :disabled="pending || renameDraft.trim().length === 0">
                {{ t.save }}
              </button>
              <button type="button" data-testid="tasks-list-detail-rename-cancel" :disabled="pending" @click="cancelRename">
                {{ t.cancel }}
              </button>
              <p
                v-if="renameError"
                id="tasks-list-detail-rename-error"
                class="tasks-list-page__error"
                data-testid="tasks-list-detail-rename-error"
                role="alert"
              >{{ codeMessage(renameError, t) }}</p>
            </form>
          </template>
          <template v-if="canArchive">
            <button
              v-if="listResult.list.archivedAt === null"
              type="button"
              data-testid="tasks-list-detail-archive"
              :disabled="pending"
              @click="onArchive(true)"
            >{{ t.listArchive }}</button>
            <button
              v-else
              type="button"
              data-testid="tasks-list-detail-unarchive"
              :disabled="pending"
              @click="onArchive(false)"
            >{{ t.listUnarchive }}</button>
          </template>
          <button
            ref="membersButton"
            type="button"
            data-testid="tasks-list-detail-members"
            aria-haspopup="dialog"
            @click="membersOpen = true"
          >{{ t.listMembers }}</button>
        </div>

        <section class="tasks-list-page__items" data-testid="tasks-list-detail-items-section" aria-labelledby="tasks-list-detail-items-heading">
          <h2 id="tasks-list-detail-items-heading">{{ t.listItemsHeading }}</h2>
          <p v-if="itemsResult.kind === 'loading'" class="tasks-list-page__message" data-testid="tasks-list-detail-items-loading">
            {{ t.loading }}
          </p>
          <p
            v-else-if="itemsResult.kind === 'unavailable'"
            class="tasks-list-page__message"
            data-testid="tasks-list-detail-items-unavailable"
            role="status"
          >{{ t.listItemsUnavailable }}</p>
          <template v-else>
            <p v-if="itemsResult.items.length === 0" class="tasks-list-page__message" data-testid="tasks-list-detail-items-empty">
              {{ t.listItemsEmpty }}
            </p>
            <!-- The grouping board (design §4.4, §6): flat rows until the groups and the placements are
                 in, grouped rows after. Each row's content is this page's. The board shows for an empty
                 list too, under the empty-state copy ([fe-42]). -->
            <TaskGroupBoard
              v-model:pending="pending"
              scope="list"
              :list-id="listId"
              :items="itemsResult.items"
              :groups="groupsResult.kind === 'ok' ? groupsResult.groups : null"
              :placements="placementsResult.kind === 'ok' ? placementsResult.placements : null"
              :unavailable="groupsResult.kind === 'unavailable' || placementsResult.kind === 'unavailable'"
              :truncated="boardTruncated"
              :can-manage="canManage"
              :reload="reloadBoard"
              flat-testid="tasks-list-detail-items"
              row-testid="tasks-list-detail-item"
              @org-missing="orgMissing = true"
            >
              <template #row="{ item }">
                <router-link :to="`/tasks/${encodeURIComponent(item.id)}`" data-testid="tasks-list-detail-item-link">{{ item.title }}</router-link>
                <span data-testid="tasks-list-detail-item-status">{{ item.status === 'done' ? t.statusDone : t.statusOpen }}</span>
                <span v-if="item.due_at" data-testid="tasks-list-detail-item-due">{{ formatViewerInstant(item.due_at, undefined, viewerLocale) }}</span>
                <template v-if="canManage">
                  <button
                    v-if="confirmingRemoveId !== item.id"
                    type="button"
                    data-testid="tasks-list-detail-item-remove"
                    :aria-label="fmt.listRemoveTaskNamed(item.title)"
                    :disabled="pending"
                    @click="openRemoveConfirm(item.id)"
                  >{{ t.listRemoveTask }}</button>
                  <span v-else data-testid="tasks-list-detail-item-remove-confirm">
                    <span id="tasks-list-detail-item-remove-prompt" data-testid="tasks-list-detail-item-remove-prompt">{{
                      t.listRemoveTaskConfirmPrompt
                    }}</span>
                    <button
                      type="button"
                      data-testid="tasks-list-detail-item-remove-confirm-yes"
                      aria-describedby="tasks-list-detail-item-remove-prompt"
                      :disabled="pending"
                      @click="onRemoveTask(item.id)"
                    >{{ t.listsRemoveConfirm }}</button>
                    <button
                      type="button"
                      data-testid="tasks-list-detail-item-remove-confirm-cancel"
                      :disabled="pending"
                      @click="cancelRemoveConfirm(item.id)"
                    >{{ t.cancel }}</button>
                  </span>
                </template>
              </template>
            </TaskGroupBoard>
          </template>
          <p
            v-if="itemsResult.kind === 'ok' && itemsResult.truncated"
            class="tasks-list-page__message"
            data-testid="tasks-list-detail-items-truncated"
            role="status"
          >{{ t.listItemsTruncated }}</p>

          <form
            v-if="canManage && itemsResult.kind === 'ok'"
            class="tasks-list-page__add-task"
            data-testid="tasks-list-detail-add-task-form"
            @submit.prevent="onAddTask"
          >
            <label for="tasks-list-detail-add-task-input">{{ t.listAddTaskLabel }}</label>
            <input
              id="tasks-list-detail-add-task-input"
              v-model="addTaskId"
              type="text"
              autocomplete="off"
              data-testid="tasks-list-detail-add-task-input"
              :placeholder="t.listAddTaskPlaceholder"
              :disabled="pending"
              :aria-invalid="addTaskError ? 'true' : undefined"
              :aria-describedby="addTaskError ? 'tasks-list-detail-add-task-error' : undefined"
              @input="addTaskError = null"
            />
            <button type="submit" data-testid="tasks-list-detail-add-task-submit" :disabled="pending || addTaskId.trim().length === 0">
              {{ t.listAddTask }}
            </button>
            <p
              v-if="addTaskErrorMessage"
              id="tasks-list-detail-add-task-error"
              class="tasks-list-page__error"
              data-testid="tasks-list-detail-add-task-error"
              role="alert"
            >{{ addTaskErrorMessage }}</p>
          </form>
        </section>

        <section class="tasks-list-page__events" data-testid="tasks-list-detail-events-section">
          <button
            type="button"
            data-testid="tasks-list-detail-events-toggle"
            aria-controls="tasks-list-detail-events-panel"
            :aria-expanded="eventsOpen ? 'true' : 'false'"
            @click="toggleEvents"
          >{{ t.listEventsToggle }}</button>
          <div v-if="eventsOpen" id="tasks-list-detail-events-panel" data-testid="tasks-list-detail-events">
            <h2>{{ t.listEventsHeading }}</h2>
            <p v-if="eventsResult.kind === 'loading'" class="tasks-list-page__message" data-testid="tasks-list-detail-events-loading">
              {{ t.loading }}
            </p>
            <p
              v-else-if="eventsResult.kind === 'error'"
              class="tasks-list-page__message"
              data-testid="tasks-list-detail-events-error"
              role="alert"
            >{{ t.listEventsLoadFailed }}</p>
            <p v-else-if="eventsResult.items.length === 0" class="tasks-list-page__message" data-testid="tasks-list-detail-events-empty">
              {{ t.listEventsEmpty }}
            </p>
            <ol v-else class="tasks-list-page__event-list" data-testid="tasks-list-detail-events-list">
              <li
                v-for="event in eventsResult.items"
                :key="event.id"
                class="tasks-list-page__event"
                data-testid="tasks-list-detail-event"
                :data-event-type="event.eventType"
              >
                <span data-testid="tasks-list-detail-event-actor">{{ event.actorId }}</span>
                <span data-testid="tasks-list-detail-event-type">{{ listEventLabel(event.eventType, t) }}</span>
                <time data-testid="tasks-list-detail-event-time" :datetime="event.occurredAt">
                  {{ formatViewerInstant(event.occurredAt, undefined, viewerLocale) }}
                </time>
              </li>
            </ol>
            <button
              v-if="eventsHasMore"
              type="button"
              data-testid="tasks-list-detail-events-more"
              :disabled="eventsLoadingMore"
              @click="onLoadMoreEvents"
            >{{ t.loadMore }}</button>
            <p v-if="eventsMoreFailed" class="tasks-list-page__error" data-testid="tasks-list-detail-events-more-error" role="alert">
              {{ t.listEventsLoadFailed }}
            </p>
          </div>
        </section>

        <TaskListMembersDialog
          v-if="membersOpen"
          v-model:pending="pending"
          :list-id="listId"
          :list="listResult.list"
          :current-user-id="currentUserId"
          :current-user-status="currentUserStatus"
          :reload-list="reloadListQuietly"
          @close="closeMembers"
          @left="onLeftList"
          @org-missing="orgMissing = true"
        />
      </div>
    </template>

    <!-- The four other context states render the same blocks (copy and data-testid) as TasksView. -->
    <p v-else-if="contextState.state === 'org_missing'" class="tasks-list-page__message" data-testid="tasks-view-org-missing" role="status">
      {{ t.orgMissing }}
    </p>
    <p v-else-if="contextState.state === 'unavailable'" class="tasks-list-page__message" data-testid="tasks-view-unavailable" role="status">
      {{ t.contextUnavailable }}
    </p>
    <p v-else-if="contextState.state === 'forbidden'" class="tasks-list-page__message" data-testid="tasks-view-forbidden" role="status">
      {{ t.contextForbidden }}
    </p>
    <p v-else class="tasks-list-page__message" data-testid="tasks-view-error" role="status">
      {{ t.contextError }}
    </p>
  </section>
</template>

<script setup lang="ts">
/**
 * `/task-lists/:id` — one task list (M4 frontend design §2.1, §2.4, §4.2, §5.1, §6; backend
 * `GET` / `PATCH /api/task-lists/:id`, `…/archive`, `…/unarchive`, `…/events` (PR-3a S5),
 * `…/items` (PR-3a S7) and `…/groups`, `…/group-items` (PR-3a S8)).
 *
 * Reads: `GET /api/tasks/context` first (the same five states as TasksView), then the list, its
 * items, its groups and its placements in parallel, each under its own generation; the activity on
 * demand, when its panel opens. The page state — loading / the list / not_found / forbidden /
 * error — comes from the list read ALONE: an items read that fails (a 404 included) leaves the
 * header and its controls in place and says the items are unavailable. The items render through
 * the grouping board: flat until the groups and the placements are in, flat with a notice when
 * either read failed, grouped after. A board write answered 404, and the board's refresh, re-read
 * the list quietly as well as the items, the groups and the placements.
 *
 * Abilities. The list body carries `myRole`, `createdBy` and `ownerId` and no ability flags, so
 * the controls follow the design's inference (§5.1); the server still decides every write, and a
 * 404 / 422 it answers renders as usual:
 *   - rename, add a task, remove a task: `myRole` is `edit` or `owner`;
 *   - the grouping board's writes — create, rename and delete a group, move a task (the drag
 *     handle, the step buttons, "add to the order" and the move-to-group picker): `myRole` is
 *     `edit` or `owner` (`canManage`, handed to the board); a `read` member sees the order and the
 *     refresh only;
 *   - archive / unarchive: `myRole` is `edit` or `owner`, or the viewer is the list's creator — the
 *     creator half only once the viewer's own id is known (hidden while it is pending or could not
 *     be resolved);
 *   - the members dialog: every member may open it; the controls inside follow the dialog's own
 *     inference (role, the viewer's own row, the creator and owner rows).
 *
 * Writes are pessimistic: an ok re-reads what it changed (the list after rename / archive /
 * unarchive, the items and the placements after add / remove) while the page stays as it is. One
 * write at a time across the page, the members dialog and the grouping board: while one is pending
 * every write control is disabled and a second submit sends nothing. A write
 * answered after the page moved on (another list, or the page left) touches nothing here; a list
 * write that succeeded still tells the lists bus, because the server state changed either way.
 * Remove uses an inline two-step confirmation (no `window.confirm`).
 *
 * Focus after a swap that is not a write (`[fe-50]`): opening the remove confirmation focuses its
 * confirm button, which the prompt describes; opening rename focuses the name input; cancelling
 * either focuses the button that comes back.
 *
 * Members (design §5): every member may open the members dialog (reading the roster needs only
 * `view`). The dialog shares this page's `pending` through `v-model:pending`, so a member write and
 * a page write never run together. It asks the page for a quiet re-read of the list after a
 * transfer and after a 404, holding `pending` until that read lands; when the viewer leaves the
 * list it reports back and the page goes to `/tasks`. Closing it puts focus back on its button.
 *
 * Route edge (`/task-lists/a` -> `/task-lists/b` reuses this instance): every draft, inline error,
 * confirmation, the banner, the activity panel and the members dialog reset, every generation and
 * the write token advance, and the reads run again.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TaskGroupBoard from './TaskGroupBoard.vue'
import TaskListMembersDialog from './TaskListMembersDialog.vue'
import { useAuth } from '../../composables/useAuth'
import { useLocale } from '../../composables/useLocale'
import {
  TASKS_EN,
  TASKS_FMT_EN,
  TASKS_FMT_ZH,
  TASKS_ZH,
  codeMessage,
  listEventLabel,
  type TasksText,
} from '../../tasks/labels'
import { loadTasksContext, type TasksContextResult } from '../../tasks/tasksContext'
import {
  addTaskToList,
  archiveTaskList,
  getTaskList,
  listTaskListEvents,
  listTaskListGroupItems,
  listTaskListGroups,
  listTaskListItems,
  removeTaskFromList,
  renameTaskList,
  unarchiveTaskList,
  type TaskGroup,
  type TaskList,
  type TaskListEvent,
  type TaskListItem,
  type TaskListRole,
  type TaskPlacement,
  type WriteFailure,
} from '../../tasks/tasksApi'
import { formatViewerInstant } from '../../tasks/tasksDateDisplay'
import { notifyListsChanged } from '../../tasks/tasksListsBus'
import { checkListName, normalizeUserText } from '../../tasks/tasksDraft'
import { focusAfterSwap } from '../../tasks/tasksFocus'

const route = useRoute()
const router = useRouter()

/** `/task-lists/:id`'s param. */
const listId = computed<string>(() => {
  const raw = (route as { params?: Record<string, unknown> } | undefined)?.params?.id
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0]
  return ''
})

const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const fmt = computed(() => (isZh.value ? TASKS_FMT_ZH : TASKS_FMT_EN))
const viewerLocale = computed(() => (isZh.value ? 'zh-CN' : 'en-US'))

type ListState =
  | { kind: 'loading' }
  | { kind: 'ok'; list: TaskList }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

type ItemsState =
  | { kind: 'loading' }
  | { kind: 'ok'; items: TaskListItem[]; truncated: boolean }
  | { kind: 'unavailable' }

type EventsState = { kind: 'loading' } | { kind: 'ok'; items: TaskListEvent[] } | { kind: 'error' }

type GroupsState = { kind: 'loading' } | { kind: 'ok'; groups: TaskGroup[]; truncated: boolean } | { kind: 'unavailable' }

type PlacementsState =
  | { kind: 'loading' }
  | { kind: 'ok'; placements: TaskPlacement[]; truncated: boolean }
  | { kind: 'unavailable' }

type Banner = { kind: 'forbidden' } | { kind: 'not_found' } | { kind: 'error' } | { kind: 'code'; code: string }

type AddTaskError = { kind: 'not_found' } | { kind: 'code'; code: string }

const contextState = ref<TasksContextResult | null>(null)
const listResult = ref<ListState>({ kind: 'loading' })
const itemsResult = ref<ItemsState>({ kind: 'loading' })
const groupsResult = ref<GroupsState>({ kind: 'loading' })
const placementsResult = ref<PlacementsState>({ kind: 'loading' })
const orgMissing = ref(false)

const pending = ref(false)
const banner = ref<Banner | null>(null)

const renameOpen = ref(false)
const renameDraft = ref('')
const renameError = ref<string | null>(null)

const addTaskId = ref('')
const addTaskError = ref<AddTaskError | null>(null)
const confirmingRemoveId = ref<string | null>(null)

const eventsOpen = ref(false)
const eventsResult = ref<EventsState>({ kind: 'loading' })
const eventsNextOffset = ref(0)
const eventsTotal = ref(0)
const eventsLastPageEmpty = ref(false)
const eventsLoadingMore = ref(false)
const eventsMoreFailed = ref(false)

const membersOpen = ref(false)
const membersButton = ref<HTMLButtonElement | null>(null)
const pageRef = ref<HTMLElement | null>(null)

// Late-result guards: each read compares its generation, each write the token; a route edge and
// leaving the page advance all of them.
let listGeneration = 0
let itemsGeneration = 0
let groupsGeneration = 0
let placementsGeneration = 0
let eventsGeneration = 0
let writeToken = 0

// The viewer's own id, resolved once per page instance, for the creator half of the archive rule.
const currentUserId = ref<string | null>(null)
const currentUserStatus = ref<'pending' | 'known' | 'unavailable'>('pending')
let currentUserFetchStarted = false

async function ensureCurrentUser(): Promise<void> {
  if (currentUserFetchStarted) return
  currentUserFetchStarted = true
  let id: string | null = null
  try {
    id = await useAuth().getCurrentUserId()
  } catch {
    id = null
  }
  currentUserId.value = id
  currentUserStatus.value = id ? 'known' : 'unavailable'
}

const headerTitle = computed(() => (listResult.value.kind === 'ok' ? listResult.value.list.name : t.value.listPageTitle))

// RULED(2026-10-07): [R12] — the role rules of the list (design §5.1): `edit` acts like the
// owner except for a transfer, `read` only views; the creator may archive and unarchive.
const canManage = computed(() => {
  const state = listResult.value
  return state.kind === 'ok' && (state.list.myRole === 'edit' || state.list.myRole === 'owner')
})

// [fe-26] the creator half of archive / unarchive waits for the viewer's own id: hidden while the
// id is pending, and when it could not be resolved.
const canArchive = computed(() => {
  const state = listResult.value
  if (state.kind !== 'ok') return false
  if (canManage.value) return true
  return currentUserStatus.value === 'known' && currentUserId.value === state.list.createdBy
})

function roleLabel(role: TaskListRole): string {
  if (role === 'owner') return t.value.listRoleOwner
  if (role === 'edit') return t.value.listRoleEdit
  return t.value.listRoleRead
}

const bannerMessage = computed<string | null>(() => {
  const current = banner.value
  if (!current) return null
  switch (current.kind) {
    case 'forbidden':
      return t.value.listWriteForbidden
    case 'not_found':
      return t.value.listWriteNotFound
    case 'code':
      return codeMessage(current.code, t.value)
    default:
      return t.value.actionFailed
  }
})

const addTaskErrorMessage = computed<string | null>(() => {
  const error = addTaskError.value
  if (!error) return null
  if (error.kind === 'not_found') return t.value.listAddTaskNotFound
  // ASSUMPTION(task-m4-fe): [D14] — `LIMIT` here is the per-task list quota.
  if (error.code === 'LIMIT') return t.value.codeLimitTaskLists
  return codeMessage(error.code, t.value)
})

/** The board offers no move while any of its three reads stopped short of its `total`. */
const boardTruncated = computed(
  () =>
    (itemsResult.value.kind === 'ok' && itemsResult.value.truncated) ||
    (groupsResult.value.kind === 'ok' && groupsResult.value.truncated) ||
    (placementsResult.value.kind === 'ok' && placementsResult.value.truncated),
)

const eventsHasMore = computed(
  () => eventsResult.value.kind === 'ok' && eventsNextOffset.value < eventsTotal.value && !eventsLastPageEmpty.value,
)

// ---- reads -----------------------------------------------------------------------------------

/** The list itself. `quiet` (after a write) keeps the page as it is until the answer lands. */
async function loadList(options: { quiet?: boolean } = {}): Promise<void> {
  listGeneration += 1
  const mine = listGeneration
  if (!options.quiet) listResult.value = { kind: 'loading' }
  const result = await getTaskList(listId.value)
  if (mine !== listGeneration) return
  listResult.value = result.kind === 'ok' ? { kind: 'ok', list: result.list } : { kind: result.kind }
}

// RULED(2026-10-07): [R04] — the rows link to the task's own page; nothing assumes a list
// member sees the task in any list view.
/** The list's items (every page; past the page bound the read is cut short). Any failure says the
 *  items are unavailable and leaves the rest of the page alone. */
// [fe-21] the page state comes from the list read alone: an items read that fails, a 404 included,
// only swaps the items section for "unavailable" (the header, rename and archive stay), and the
// add-a-task form renders only while the items read is ok.
async function loadItems(options: { quiet?: boolean } = {}): Promise<void> {
  itemsGeneration += 1
  const mine = itemsGeneration
  if (!options.quiet) itemsResult.value = { kind: 'loading' }
  const result = await listTaskListItems(listId.value, { isSuperseded: () => mine !== itemsGeneration })
  if (mine !== itemsGeneration) return
  if (result.kind === 'ok') {
    itemsResult.value = { kind: 'ok', items: result.items, truncated: result.items.length < result.total }
    return
  }
  if (result.kind === 'org_missing') {
    orgMissing.value = true
    return
  }
  itemsResult.value = { kind: 'unavailable' }
}

// RULED(2026-10-07): [R11] — every list has exactly one default group; a task without a
// placement sits in it, after the placed ones.
/** The list's groups (one page: the group cap fits in it). A failure leaves the items flat. */
async function loadGroups(options: { quiet?: boolean } = {}): Promise<void> {
  groupsGeneration += 1
  const mine = groupsGeneration
  if (!options.quiet) groupsResult.value = { kind: 'loading' }
  const result = await listTaskListGroups(listId.value)
  if (mine !== groupsGeneration) return
  if (result.kind === 'ok') {
    groupsResult.value = { kind: 'ok', groups: result.items, truncated: result.items.length < result.total }
    return
  }
  if (result.kind === 'org_missing') {
    orgMissing.value = true
    return
  }
  groupsResult.value = { kind: 'unavailable' }
}

/** The list's placements (every page; past the page bound the read is cut short). */
async function loadPlacements(options: { quiet?: boolean } = {}): Promise<void> {
  placementsGeneration += 1
  const mine = placementsGeneration
  if (!options.quiet) placementsResult.value = { kind: 'loading' }
  const result = await listTaskListGroupItems(listId.value, { isSuperseded: () => mine !== placementsGeneration })
  if (mine !== placementsGeneration) return
  if (result.kind === 'ok') {
    placementsResult.value = { kind: 'ok', placements: result.items, truncated: result.items.length < result.total }
    return
  }
  if (result.kind === 'org_missing') {
    orgMissing.value = true
    return
  }
  placementsResult.value = { kind: 'unavailable' }
}

/** The board's quiet re-read: the groups and the placements; with `items` (a 404, the refresh
 *  button) also the items and the list itself — [fe-44] the members dialog's 404 rule: a viewer who
 *  lost the list sees not_found, a changed role changes the controls. */
async function reloadBoard(options: { items?: boolean } = {}): Promise<void> {
  await Promise.all([
    options.items ? reloadListQuietly() : undefined,
    options.items ? loadItems({ quiet: true }) : undefined,
    loadGroups({ quiet: true }),
    loadPlacements({ quiet: true }),
  ])
}

function enterList(): void {
  void loadList()
  void loadItems()
  void loadGroups()
  void loadPlacements()
}

// RULED(2026-10-07): [R19] — the list's activity: read when the panel opens, a page at a time.
async function loadEventsFirstPage(): Promise<void> {
  eventsGeneration += 1
  const mine = eventsGeneration
  eventsResult.value = { kind: 'loading' }
  eventsLoadingMore.value = false
  eventsMoreFailed.value = false
  const result = await listTaskListEvents(listId.value, { offset: 0 })
  if (mine !== eventsGeneration) return
  if (result.kind === 'ok') {
    eventsNextOffset.value = result.items.length
    eventsTotal.value = result.total
    eventsLastPageEmpty.value = result.items.length === 0
    eventsResult.value = { kind: 'ok', items: result.items }
    return
  }
  if (result.kind === 'org_missing') {
    orgMissing.value = true
    return
  }
  eventsResult.value = { kind: 'error' }
}

async function onLoadMoreEvents(): Promise<void> {
  if (eventsResult.value.kind !== 'ok' || eventsLoadingMore.value) return
  const mine = eventsGeneration
  eventsLoadingMore.value = true
  eventsMoreFailed.value = false
  const result = await listTaskListEvents(listId.value, { offset: eventsNextOffset.value })
  if (mine !== eventsGeneration) return
  eventsLoadingMore.value = false
  const state = eventsResult.value
  if (result.kind === 'ok') {
    eventsNextOffset.value += result.items.length
    eventsTotal.value = result.total
    eventsLastPageEmpty.value = result.items.length === 0
    if (state.kind === 'ok') {
      const seen = new Set(state.items.map((event) => event.id))
      eventsResult.value = { kind: 'ok', items: [...state.items, ...result.items.filter((event) => !seen.has(event.id))] }
    }
    return
  }
  if (result.kind === 'org_missing') {
    orgMissing.value = true
    return
  }
  eventsMoreFailed.value = true
}

// [fe-25] the activity panel reads its first page again each time it opens, and closes on a list
// change; a row shows the actor, the event word and the time, never the payload.
function toggleEvents(): void {
  eventsOpen.value = !eventsOpen.value
  if (eventsOpen.value) {
    void loadEventsFirstPage()
  } else {
    eventsGeneration += 1
  }
}

// ---- writes ----------------------------------------------------------------------------------

/** A failed write: org_missing switches to the guidance block, a 422 / 409 code goes where the
 *  caller says, 403 / 404 / anything else take the page banner. */
// [fe-24] a write's ok re-reads quietly — the content stays and the write controls stay disabled
// until the read lands; its 404 / 403 / failure only takes the banner and re-reads nothing.
function applyWriteFailure(result: WriteFailure, onCode: (code: string) => void): void {
  switch (result.kind) {
    case 'org_missing':
      orgMissing.value = true
      return
    case 'validation':
    case 'conflict':
      onCode(result.code)
      return
    case 'forbidden':
      banner.value = { kind: 'forbidden' }
      return
    case 'not_found':
      banner.value = { kind: 'not_found' }
      return
    default:
      banner.value = { kind: 'error' }
  }
}

function openRename(): void {
  const state = listResult.value
  if (state.kind !== 'ok' || pending.value) return
  renameDraft.value = state.list.name
  renameError.value = null
  renameOpen.value = true
  void focusAfterSwap(() => pageRef.value, 'tasks-list-detail-rename-input')
}

function closeRename(): void {
  renameOpen.value = false
  renameDraft.value = ''
  renameError.value = null
}

/** The rename form's cancel button: the rename button comes back and takes focus. */
function cancelRename(): void {
  closeRename()
  void focusAfterSwap(() => pageRef.value, 'tasks-list-detail-rename')
}

// [fe-50] the remove confirmation swaps out the row's remove button, and cancel swaps it back.
function openRemoveConfirm(taskId: string): void {
  confirmingRemoveId.value = taskId
  void focusAfterSwap(() => pageRef.value, 'tasks-list-detail-item-remove-confirm-yes', { attr: 'data-task-id', value: taskId })
}

function cancelRemoveConfirm(taskId: string): void {
  confirmingRemoveId.value = null
  void focusAfterSwap(() => pageRef.value, 'tasks-list-detail-item-remove', { attr: 'data-task-id', value: taskId })
}

// ASSUMPTION(task-m4-fe): [D14] — the name rule (1–100 code points after normalization) is the
// server's; the pre-check only saves a round trip. The same name is still sent: the server answers
// it with a no-op 200.
// [fe-23] rename, archive and unarchive tell the lists bus on ok, a late ok included (the server
// state changed either way); adding or removing a task tells no bus.
async function onRename(): Promise<void> {
  const id = listId.value
  if (pending.value || listResult.value.kind !== 'ok') return
  renameError.value = null
  banner.value = null
  const check = checkListName(renameDraft.value)
  if (check !== 'ok') {
    renameError.value = check
    return
  }
  const name = normalizeUserText(renameDraft.value) ?? ''
  const token = ++writeToken
  pending.value = true
  try {
    const result = await renameTaskList(id, name)
    if (result.kind === 'ok') notifyListsChanged()
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      closeRename()
      await loadList({ quiet: true })
      return
    }
    applyWriteFailure(result, (code) => {
      renameError.value = code
    })
  } finally {
    if (token === writeToken) pending.value = false
  }
}

async function onArchive(archive: boolean): Promise<void> {
  const id = listId.value
  if (pending.value || listResult.value.kind !== 'ok') return
  banner.value = null
  const token = ++writeToken
  pending.value = true
  try {
    const result = archive ? await archiveTaskList(id) : await unarchiveTaskList(id)
    if (result.kind === 'ok') notifyListsChanged()
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      await loadList({ quiet: true })
      return
    }
    applyWriteFailure(result, (code) => {
      banner.value = { kind: 'code', code }
    })
  } finally {
    if (token === writeToken) pending.value = false
  }
}

// RULED(2026-10-07): [own-25] (PR-3a, R12 (a1)) — adding needs a direct role on the task; the 404
// folds that with a missing task and an unavailable list, and the inline copy reads it that way.
async function onAddTask(): Promise<void> {
  const id = listId.value
  const taskId = addTaskId.value.trim()
  if (pending.value || taskId.length === 0) return
  addTaskError.value = null
  banner.value = null
  const token = ++writeToken
  pending.value = true
  try {
    const result = await addTaskToList(id, taskId)
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      addTaskId.value = ''
      await Promise.all([loadItems({ quiet: true }), loadPlacements({ quiet: true })])
      return
    }
    if (result.kind === 'not_found') {
      addTaskError.value = { kind: 'not_found' }
      return
    }
    applyWriteFailure(result, (code) => {
      addTaskError.value = { kind: 'code', code }
    })
  } finally {
    if (token === writeToken) pending.value = false
  }
}

async function onRemoveTask(taskId: string): Promise<void> {
  const id = listId.value
  if (pending.value) return
  banner.value = null
  const token = ++writeToken
  pending.value = true
  try {
    const result = await removeTaskFromList(id, taskId)
    if (token !== writeToken) return
    confirmingRemoveId.value = null
    if (result.kind === 'ok') {
      await Promise.all([loadItems({ quiet: true }), loadPlacements({ quiet: true })])
      return
    }
    applyWriteFailure(result, (code) => {
      banner.value = { kind: 'code', code }
    })
  } finally {
    if (token === writeToken) pending.value = false
  }
}

// ---- the members dialog ----------------------------------------------------------------------

/** The dialog closed: focus goes back to the button that opened it. */
function closeMembers(): void {
  membersOpen.value = false
  void nextTick(() => membersButton.value?.focus())
}

/** The viewer left the list (the dialog has told the lists bus): the list is no longer theirs to
 *  read, so the page goes to `/tasks`. */
function onLeftList(): void {
  membersOpen.value = false
  void router.push('/tasks')
}

/** The dialog's re-read of the list after a transfer or a 404: quiet, the page keeps its content. */
function reloadListQuietly(): Promise<void> {
  return loadList({ quiet: true })
}

// ---- lifecycle -------------------------------------------------------------------------------

/** Everything that belongs to the list that was showing. */
function resetPage(): void {
  listGeneration += 1
  itemsGeneration += 1
  groupsGeneration += 1
  placementsGeneration += 1
  eventsGeneration += 1
  writeToken += 1
  pending.value = false
  banner.value = null
  closeRename()
  addTaskId.value = ''
  addTaskError.value = null
  confirmingRemoveId.value = null
  eventsOpen.value = false
  eventsResult.value = { kind: 'loading' }
  eventsMoreFailed.value = false
  eventsLoadingMore.value = false
  membersOpen.value = false
}

watch(listId, () => {
  if (contextState.value?.state !== 'ready') return
  resetPage()
  enterList()
})

let left = false

onMounted(async () => {
  const context = await loadTasksContext()
  if (left) return
  contextState.value = context
  if (context.state !== 'ready') return
  void ensureCurrentUser()
  enterList()
})

onBeforeUnmount(() => {
  left = true
  listGeneration += 1
  itemsGeneration += 1
  groupsGeneration += 1
  placementsGeneration += 1
  eventsGeneration += 1
  writeToken += 1
})
</script>

<style scoped>
.tasks-list-page {
  padding: 24px;
  max-width: 880px;
}

.tasks-list-page__header h1 {
  margin: 0 0 8px;
}

.tasks-list-page__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tasks-list-page__meta,
.tasks-list-page__actions,
.tasks-list-page__rename,
.tasks-list-page__add-task {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.tasks-list-page__event-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-list-page__event {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter, #eee);
}

.tasks-list-page__message {
  color: var(--el-text-color-secondary, #666);
}

.tasks-list-page__error {
  flex-basis: 100%;
  margin: 0;
  color: var(--el-color-danger, #c45656);
}
</style>
