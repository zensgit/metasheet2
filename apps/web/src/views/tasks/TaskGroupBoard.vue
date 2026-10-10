<template>
  <div
    v-if="model"
    ref="rootRef"
    class="tasks-group-board"
    data-testid="tasks-list"
    :data-scope="scope"
    :aria-busy="pending ? 'true' : 'false'"
  >
    <p class="tasks-group-board__live" aria-live="polite" data-testid="tasks-groups-live">{{ liveMessage }}</p>
    <p v-if="bannerMessage" class="tasks-group-board__error" data-testid="tasks-groups-banner" role="alert">{{ bannerMessage }}</p>
    <p v-if="reorderOffNotice" class="tasks-group-board__message" data-testid="tasks-groups-reorder-off" role="status">
      {{ t.groupsReorderOff }}
    </p>
    <div class="tasks-group-board__toolbar">
      <button type="button" data-testid="tasks-groups-refresh" :disabled="pending" @click="onRefresh">{{ t.groupsRefresh }}</button>
    </div>

    <section
      v-for="(group, groupIndex) in boardGroups"
      :key="groupKey(group)"
      class="tasks-group"
      data-testid="tasks-group"
      :data-group-id="group.id ?? ''"
      :data-default="group.isDefault ? 'true' : 'false'"
      :aria-labelledby="`tasks-group-heading-${groupIndex}`"
      @dragover="onDragOver"
      @drop="onDropOnGroup(groupKey(group), $event)"
    >
      <header class="tasks-group__header">
        <h3 :id="`tasks-group-heading-${groupIndex}`" class="tasks-group__name" data-testid="tasks-group-name">{{ group.name }}</h3>
        <span class="tasks-group__count" data-testid="tasks-group-count">{{ fmt.groupsItemCount(countOf(group)) }}</span>
        <template v-if="canManage">
          <form
            v-if="renamingKey === groupKey(group)"
            class="tasks-group__rename"
            data-testid="tasks-group-rename-form"
            @submit.prevent="onRename(group)"
          >
            <label :for="`tasks-group-rename-input-${groupIndex}`">{{ t.groupsRenameLabel }}</label>
            <input
              :id="`tasks-group-rename-input-${groupIndex}`"
              v-model="renameDraft"
              type="text"
              autocomplete="off"
              data-testid="tasks-group-rename-input"
              :disabled="pending"
              :aria-invalid="renameError ? 'true' : undefined"
              :aria-describedby="renameError ? `tasks-group-rename-error-${groupIndex}` : undefined"
              @input="renameError = null"
            />
            <button type="submit" data-testid="tasks-group-rename-submit" :disabled="pending || renameDraft.trim().length === 0">
              {{ t.save }}
            </button>
            <button type="button" data-testid="tasks-group-rename-cancel" :disabled="pending" @click="cancelRename(group)">{{ t.cancel }}</button>
            <p
              v-if="renameError"
              :id="`tasks-group-rename-error-${groupIndex}`"
              class="tasks-group-board__error"
              data-testid="tasks-group-rename-error"
              role="alert"
            >{{ codeMessage(renameError, t) }}</p>
          </form>
          <template v-else>
            <button
              type="button"
              data-testid="tasks-group-rename"
              :aria-label="fmt.groupsRenameNamed(group.name)"
              :aria-describedby="group.id === null ? `tasks-group-rename-hint-${groupIndex}` : undefined"
              :disabled="pending || group.id === null"
              @click="openRename(group)"
            >{{ t.listRename }}</button>
            <span
              v-if="group.id === null"
              :id="`tasks-group-rename-hint-${groupIndex}`"
              class="tasks-group-board__message"
              data-testid="tasks-group-rename-hint"
            >{{ t.groupsDefaultRenameHint }}</span>
          </template>
          <template v-if="!group.isDefault">
            <button
              v-if="confirmingDeleteKey !== groupKey(group)"
              type="button"
              data-testid="tasks-group-delete"
              :aria-label="fmt.groupsDeleteNamed(group.name)"
              :disabled="pending"
              @click="openDeleteConfirm(group)"
            >{{ t.groupsDelete }}</button>
            <span v-else data-testid="tasks-group-delete-confirm">
              <span id="tasks-group-delete-prompt" data-testid="tasks-group-delete-prompt">{{ fmt.groupsDeletePrompt(group.name) }}</span>
              <button
                type="button"
                data-testid="tasks-group-delete-confirm-yes"
                aria-describedby="tasks-group-delete-prompt"
                :disabled="pending"
                @click="onDelete(group)"
              >{{ t.groupsDeleteConfirm }}</button>
              <button type="button" data-testid="tasks-group-delete-confirm-cancel" :disabled="pending" @click="cancelDeleteConfirm(group)">
                {{ t.cancel }}
              </button>
            </span>
          </template>
          <p
            v-if="deleteError && deleteError.key === groupKey(group)"
            class="tasks-group-board__error"
            data-testid="tasks-group-delete-error"
            role="alert"
          >{{ codeMessage(deleteError.code, t) }}</p>
        </template>
      </header>

      <ol class="tasks-group__items" data-testid="tasks-group-items">
        <li
          v-for="(taskId, index) in orderedIds(group)"
          :key="taskId"
          class="tasks-group-board__row"
          :data-testid="rowTestid"
          :data-task-id="taskId"
          @dragover="onDragOver"
          @drop.stop="onDropOnRow(groupKey(group), taskId, $event)"
        >
          <span
            v-if="canManage"
            class="tasks-group-board__handle"
            data-testid="tasks-group-drag-handle"
            role="img"
            :aria-label="t.groupsDragHandle"
            :draggable="movesEnabled ? 'true' : 'false'"
            @dragstart="onDragStart(taskId, $event)"
            @dragend="onDragEnd"
          ></span>
          <slot name="row" :item="rowOf(taskId)" />
          <span v-if="canManage" class="tasks-group-board__moves">
            <button
              type="button"
              data-testid="tasks-group-move-up"
              data-move="up"
              :aria-label="fmt.groupsMoveUpNamed(titleOf(taskId))"
              :disabled="!movesEnabled || index === 0"
              @click="onStep(taskId, -1)"
            >{{ t.groupsMoveUp }}</button>
            <button
              type="button"
              data-testid="tasks-group-move-down"
              data-move="down"
              :aria-label="fmt.groupsMoveDownNamed(titleOf(taskId))"
              :disabled="!movesEnabled || index === orderedIds(group).length - 1"
              @click="onStep(taskId, 1)"
            >{{ t.groupsMoveDown }}</button>
            <select
              data-testid="tasks-group-move-to"
              data-move="group"
              :aria-label="fmt.groupsMoveToNamed(titleOf(taskId))"
              :value="groupKey(group)"
              :disabled="!movesEnabled"
              @change="onPickGroup(taskId, groupKey(group), $event)"
            >
              <option v-for="option in boardGroups" :key="groupKey(option)" :value="groupKey(option)">{{ option.name }}</option>
            </select>
          </span>
        </li>
      </ol>

      <template v-if="group.isDefault && tailIds.length > 0">
        <h4 :id="`tasks-group-unsorted-heading-${groupIndex}`" class="tasks-group__unsorted-heading" data-testid="tasks-group-unsorted-heading">
          {{ t.groupsUnsorted }}
        </h4>
        <ol
          class="tasks-group__items"
          data-testid="tasks-group-unsorted"
          :aria-labelledby="`tasks-group-unsorted-heading-${groupIndex}`"
        >
          <li
            v-for="taskId in tailIds"
            :key="taskId"
            class="tasks-group-board__row"
            :data-testid="rowTestid"
            :data-task-id="taskId"
            @dragover="onDragOver"
            @drop.stop="onDropOnRow(DEFAULT_GROUP_KEY, taskId, $event)"
          >
            <slot name="row" :item="rowOf(taskId)" />
            <span v-if="canManage" class="tasks-group-board__moves">
              <button
                type="button"
                data-testid="tasks-group-add-to-order"
                data-move="join"
                :aria-label="fmt.groupsAddToOrderNamed(titleOf(taskId))"
                :disabled="!movesEnabled"
                @click="onJoinOrder(taskId)"
              >{{ t.groupsAddToOrder }}</button>
              <select
                data-testid="tasks-group-move-to"
                data-move="group"
                :aria-label="fmt.groupsMoveToNamed(titleOf(taskId))"
                :value="DEFAULT_GROUP_KEY"
                :disabled="!movesEnabled"
                @change="onPickGroup(taskId, DEFAULT_GROUP_KEY, $event)"
              >
                <option v-for="option in boardGroups" :key="groupKey(option)" :value="groupKey(option)">{{ option.name }}</option>
              </select>
            </span>
          </li>
        </ol>
      </template>

      <p v-if="countOf(group) === 0" class="tasks-group-board__message" data-testid="tasks-group-empty">{{ t.groupsEmpty }}</p>
    </section>

    <form v-if="canManage" class="tasks-group-board__create" data-testid="tasks-groups-create-form" @submit.prevent="onCreate">
      <label for="tasks-groups-create-input">{{ t.groupsCreateLabel }}</label>
      <input
        id="tasks-groups-create-input"
        v-model="newGroupName"
        type="text"
        autocomplete="off"
        data-testid="tasks-groups-create-input"
        :placeholder="t.groupsCreatePlaceholder"
        :disabled="pending || atGroupCap"
        :aria-invalid="createError ? 'true' : undefined"
        :aria-describedby="createError ? 'tasks-groups-create-error' : undefined"
        @input="createError = null"
      />
      <button type="submit" data-testid="tasks-groups-create-submit" :disabled="pending || atGroupCap || newGroupName.trim().length === 0">
        {{ t.groupsCreate }}
      </button>
      <p v-if="atGroupCap" class="tasks-group-board__message" data-testid="tasks-groups-create-limit" role="status">{{ t.codeLimitGroups }}</p>
      <p
        v-if="createErrorMessage"
        id="tasks-groups-create-error"
        class="tasks-group-board__error"
        data-testid="tasks-groups-create-error"
        role="alert"
      >{{ createErrorMessage }}</p>
    </form>
  </div>

  <template v-else>
    <p v-if="showUnavailable" class="tasks-group-board__message" data-testid="tasks-groups-unavailable" role="status">
      {{ t.groupsUnavailable }}
    </p>
    <ul v-if="items.length > 0" class="tasks-group-board__flat" :data-testid="flatTestid">
      <li v-for="item in items" :key="item.id" class="tasks-group-board__row" :data-testid="rowTestid" :data-task-id="item.id">
        <slot name="row" :item="item" />
      </li>
    </ul>
  </template>
</template>

<script setup lang="ts">
/**
 * The grouping board (M4 frontend design §4.4, §6; backend PR-3a §3.5), shared by the list page
 * (`scope: 'list'`) and the assigned view's personal groups (`scope: 'user'`).
 *
 * The host reads the rows, the groups and the placements and passes them in; the board renders,
 * moves and writes. Until both group reads are in — and when one failed, or the groups cannot hold
 * a board — the rows render as a flat list, with a notice when the groups are unavailable. Each
 * row's content comes from the host's `row` slot. Group names show as the server sends them, the
 * default group's included ([fe-41]). Order and move rules: `tasks/tasksGroupBoard.ts`.
 *
 * Moves — the handle (drag and drop) or the row's keyboard controls (up, down, join the order,
 * move to a group) — send one PUT per gesture. The board shows the move at once; an ok waits for
 * the host's re-read of the groups and the placements and then shows the server's order; a failure
 * puts the order back and says why in the board's banner: `INVALID_POSITION` and `INVALID_GROUP`
 * re-read the groups and the placements, a 404 re-reads the rows as well. Moves are offered to a
 * manager only, and only while nothing was cut short and every placement names a shown row and a
 * known group; otherwise the order still shows, the move controls are disabled and a notice says so.
 * After a keyboard move, focus returns to the same control of the same task, or to the task's group
 * select when that control is disabled or gone.
 *
 * Group writes (create, rename, delete) wait for the server, then for the host's re-read. The
 * default group has no delete; the personal default group cannot be renamed before its row exists.
 * Opening a group's rename focuses the name input, opening its delete confirmation focuses the
 * confirm button (which the prompt describes), and cancelling either focuses the group's button
 * that comes back (`[fe-50]`).
 *
 * One write at a time across the host page and the board (`v-model:pending`; a local flag also
 * refuses a second write in the same tick). The refresh button is a write for this rule. An answer
 * that lands after the board unmounted touches nothing; a write still in flight at unmount hands
 * the shared flag back.
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { TASKS_EN, TASKS_FMT_EN, TASKS_FMT_ZH, TASKS_ZH, codeMessage, type TasksText } from '../../tasks/labels'
import {
  createTaskListGroup,
  createUserGroup,
  deleteTaskListGroup,
  deleteUserGroup,
  placeTaskInListGroup,
  placeTaskInUserGroup,
  renameTaskListGroup,
  renameUserGroup,
  type TaskGroup,
  type TaskGroupScope,
  type TaskListItem,
  type TaskPlacement,
  type WriteFailure,
} from '../../tasks/tasksApi'
import { checkGroupName, normalizeUserText } from '../../tasks/tasksDraft'
import { focusAfterSwap } from '../../tasks/tasksFocus'
import {
  DEFAULT_GROUP_KEY,
  GROUP_CAP,
  applyMove,
  buildBoardModel,
  groupKey,
  locateTask,
  planDrop,
  planJoinOrder,
  planStep,
  planToGroup,
  type BoardModel,
  type PlannedMove,
} from '../../tasks/tasksGroupBoard'

const props = defineProps<{
  scope: TaskGroupScope
  /** The list every list-scope request goes to (the page's route id). */
  listId?: string
  /** The rows, in the server's order. */
  items: TaskListItem[]
  /** `null` until the read is in, and after it failed. */
  groups: TaskGroup[] | null
  placements: TaskPlacement[] | null
  /** A group read failed. */
  unavailable: boolean
  /** The rows, the groups or the placements stopped short of their `total`. */
  truncated: boolean
  /** Group writes and moves are offered. */
  canManage: boolean
  /** Shared with the host through `v-model:pending`. */
  pending: boolean
  /** The host's quiet re-read of the groups and the placements — and of the rows with `items`. */
  reload: (options?: { items?: boolean }) => Promise<void>
  /** `data-testid` of the flat list. */
  flatTestid: string
  /** `data-testid` of every row. */
  rowTestid: string
}>()

const emit = defineEmits<{
  'update:pending': [value: boolean]
  'org-missing': []
}>()

// [fe-33] each row's content is the host's: the flat list and the board render the same slot.
defineSlots<{ row(props: { item: TaskListItem }): unknown }>()

const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const fmt = computed(() => (isZh.value ? TASKS_FMT_ZH : TASKS_FMT_EN))

type MoveControl = 'up' | 'down' | 'join' | 'group'

type Banner = { kind: 'not_found' } | { kind: 'forbidden' } | { kind: 'error' } | { kind: 'code'; code: string }

const rootRef = ref<HTMLElement | null>(null)
/** A move's order, shown from the click until the re-read it waits for is back. */
const override = ref<BoardModel | null>(null)
const banner = ref<Banner | null>(null)
const liveMessage = ref('')
const newGroupName = ref('')
const createError = ref<string | null>(null)
const renamingKey = ref<string | null>(null)
const renameDraft = ref('')
const renameError = ref<string | null>(null)
const confirmingDeleteKey = ref<string | null>(null)
const deleteError = ref<{ key: string; code: string } | null>(null)
const dragTaskId = ref<string | null>(null)

// Late-result guard: a write compares its token; unmounting advances it.
let writeToken = 0
let writing = false

const baseModel = computed<BoardModel | null>(() =>
  props.groups !== null && props.placements !== null ? buildBoardModel(props.groups, props.placements, props.items) : null,
)
const model = computed<BoardModel | null>(() => override.value ?? baseModel.value)
const boardGroups = computed<TaskGroup[]>(() => model.value?.groups ?? [])
const tailIds = computed<string[]>(() => model.value?.tail ?? [])

// [fe-37] groups that cannot hold a board read as unavailable.
const showUnavailable = computed(
  () => props.unavailable || (props.groups !== null && props.placements !== null && baseModel.value === null),
)

const rowsById = computed(() => new Map(props.items.map((item) => [item.id, item])))

function rowOf(taskId: string): TaskListItem {
  return rowsById.value.get(taskId) as TaskListItem
}

function titleOf(taskId: string): string {
  return rowsById.value.get(taskId)?.title ?? taskId
}

function orderedIds(group: TaskGroup): string[] {
  return model.value?.ordered[groupKey(group)] ?? []
}

function countOf(group: TaskGroup): number {
  return orderedIds(group).length + (group.isDefault ? tailIds.value.length : 0)
}

// [fe-35] the board's index space must be the server's for a move to count right.
const movesAllowed = computed(
  () => props.canManage && model.value !== null && model.value.consistent && !props.truncated,
)
const movesEnabled = computed(() => movesAllowed.value && !props.pending)
const reorderOffNotice = computed(() => props.canManage && model.value !== null && !props.pending && !movesAllowed.value)
const atGroupCap = computed(() => boardGroups.value.length >= GROUP_CAP)

// [fe-34] the board's failures take its own banner, not the host page's.
const bannerMessage = computed<string | null>(() => {
  const current = banner.value
  if (current === null) return null
  switch (current.kind) {
    case 'not_found':
      return t.value.groupsNotFound
    case 'forbidden':
      return t.value.groupsForbidden
    case 'code':
      return codeMessage(current.code, t.value)
    default:
      return t.value.actionFailed
  }
})

const createErrorMessage = computed<string | null>(() => {
  const code = createError.value
  if (code === null) return null
  // ASSUMPTION(task-m4-fe): [D14] — `LIMIT` here is the group cap.
  if (code === 'LIMIT') return t.value.codeLimitGroups
  return codeMessage(code, t.value)
})

// ---- writes ----------------------------------------------------------------------------------

/** The token of a write allowed to start now, or `null` while another write is in flight. */
function beginWrite(): number | null {
  if (props.pending || writing) return null
  writing = true
  emit('update:pending', true)
  banner.value = null
  createError.value = null
  renameError.value = null
  deleteError.value = null
  liveMessage.value = ''
  writeToken += 1
  return writeToken
}

function endWrite(token: number): void {
  if (token !== writeToken) return
  writing = false
  emit('update:pending', false)
}

/** A failed write: `ORG_MISSING` goes to the host's guidance block, a 422 / 409 code to the
 *  caller's spot, a 403 / any other failure to the banner; a 404 takes the banner and re-reads the
 *  rows, the groups and the placements. */
async function applyFailure(result: WriteFailure, onCode: (code: string) => void): Promise<void> {
  switch (result.kind) {
    case 'org_missing':
      emit('org-missing')
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
      await props.reload({ items: true })
      return
    default:
      banner.value = { kind: 'error' }
  }
}

function groupNameOf(board: BoardModel, key: string): string {
  return board.groups.find((group) => groupKey(group) === key)?.name ?? ''
}

// RULED(2026-10-07): [R11] — one default group per container; a task sits in at most one
// group; the placement PUT names the default group with `null` in both scopes.
// [fe-05] one PUT per gesture; the unsorted tail joins the order one row at a time.
async function runMove(move: PlannedMove | null, control: MoveControl | null): Promise<void> {
  const board = model.value
  if (move === null || board === null || !movesAllowed.value) return
  const from = locateTask(board, move.taskId)
  const token = beginWrite()
  if (token === null) return
  override.value = applyMove(board, move)
  liveMessage.value = t.value.groupsSaving
  let moved = false
  try {
    const result =
      props.scope === 'list'
        ? await placeTaskInListGroup(props.listId ?? '', move.taskId, move.groupId, move.position)
        : await placeTaskInUserGroup(move.taskId, move.groupId, move.position)
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      // The server renumbers the target group and may land the default group's row: both reads.
      await props.reload()
      if (token !== writeToken) return
      override.value = null
      liveMessage.value =
        from !== null && from.key === move.key
          ? fmt.value.groupsMovedTo(move.position + 1)
          : fmt.value.groupsMovedToGroup(groupNameOf(board, move.key), move.position + 1)
      moved = true
      return
    }
    override.value = null
    liveMessage.value = ''
    if (result.kind === 'validation' || result.kind === 'conflict') {
      // [fe-43] both codes read the code table's copy and re-read the groups and the placements.
      banner.value = { kind: 'code', code: result.code }
      if (result.code === 'INVALID_POSITION' || result.code === 'INVALID_GROUP') await props.reload()
      return
    }
    await applyFailure(result, () => undefined)
  } finally {
    endWrite(token)
    if (moved && control !== null) void restoreFocus(move.taskId, control)
  }
}

/** [fe-38] after a keyboard move: the same control of the same task, or the task's group select
 *  when that control is disabled or gone. */
async function restoreFocus(taskId: string, control: MoveControl): Promise<void> {
  await nextTick()
  const root = rootRef.value
  if (root === null) return
  const row = Array.from(root.querySelectorAll<HTMLElement>('[data-task-id]')).find(
    (element) => element.getAttribute('data-task-id') === taskId,
  )
  if (row === undefined) return
  const preferred = row.querySelector<HTMLButtonElement | HTMLSelectElement>(`[data-move="${control}"]`)
  const target = preferred !== null && !preferred.disabled ? preferred : row.querySelector<HTMLSelectElement>('[data-move="group"]')
  target?.focus()
}

function onStep(taskId: string, step: -1 | 1): void {
  const board = model.value
  if (board === null) return
  void runMove(planStep(board, taskId, step), step < 0 ? 'up' : 'down')
}

function onJoinOrder(taskId: string): void {
  const board = model.value
  if (board === null) return
  void runMove(planJoinOrder(board, taskId), 'join')
}

function onPickGroup(taskId: string, currentKey: string, event: Event): void {
  const select = event.target as HTMLSelectElement
  const picked = select.value
  // A pick is a request: the select shows the task's group until the board moves the task.
  select.value = currentKey
  const board = model.value
  if (board === null) return
  void runMove(planToGroup(board, taskId, picked), 'group')
}

// [fe-36] the handle starts a drag; a row takes a drop before it, or after it on its lower half;
// a group's free space and the unsorted tail take a drop at the end of the group's order.
function onDragStart(taskId: string, event: DragEvent): void {
  if (!movesEnabled.value) {
    event.preventDefault()
    return
  }
  dragTaskId.value = taskId
  const transfer = event.dataTransfer
  if (transfer) {
    transfer.effectAllowed = 'move'
    transfer.setData('text/plain', taskId)
    const row = (event.currentTarget as HTMLElement | null)?.closest('li')
    if (row) transfer.setDragImage(row, 16, 16)
  }
}

function onDragEnd(): void {
  dragTaskId.value = null
}

function onDragOver(event: DragEvent): void {
  if (dragTaskId.value === null) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

function onDropOnRow(key: string, rowId: string, event: DragEvent): void {
  const taskId = dragTaskId.value
  if (taskId === null) return
  event.preventDefault()
  dragTaskId.value = null
  const board = model.value
  if (board === null) return
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const after = typeof event.clientY === 'number' && event.clientY > box.top + box.height / 2
  void runMove(planDrop(board, taskId, key, rowId, after), null)
}

function onDropOnGroup(key: string, event: DragEvent): void {
  const taskId = dragTaskId.value
  if (taskId === null) return
  event.preventDefault()
  dragTaskId.value = null
  const board = model.value
  if (board === null) return
  void runMove(planDrop(board, taskId, key, null, false), null)
}

// ASSUMPTION(task-m4-fe): [D14] — a group name is 1–100 code points after normalization; the
// pre-check only saves a round trip.
async function onCreate(): Promise<void> {
  if (!props.canManage || atGroupCap.value) return
  createError.value = null
  const check = checkGroupName(newGroupName.value)
  if (check !== 'ok') {
    createError.value = check
    return
  }
  const name = normalizeUserText(newGroupName.value) ?? ''
  const token = beginWrite()
  if (token === null) return
  try {
    const result = props.scope === 'list' ? await createTaskListGroup(props.listId ?? '', name) : await createUserGroup(name)
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      newGroupName.value = ''
      await props.reload()
      return
    }
    await applyFailure(result, (code) => {
      createError.value = code
    })
  } finally {
    endWrite(token)
  }
}

// ASSUMPTION(task-m4-fe): [own-24] (PR-3a) — the personal default group has no id before its row
// exists and cannot be renamed until then.
function openRename(group: TaskGroup): void {
  if (props.pending || group.id === null) return
  renamingKey.value = groupKey(group)
  renameDraft.value = group.name
  renameError.value = null
  void focusAfterSwap(() => rootRef.value, 'tasks-group-rename-input')
}

function closeRename(): void {
  renamingKey.value = null
  renameDraft.value = ''
  renameError.value = null
}

/** [fe-50] the group's section, where its rename and delete controls come back. */
function sectionOf(group: TaskGroup): { attr: string; value: string } {
  return { attr: 'data-group-id', value: group.id ?? '' }
}

/** The rename form's cancel button: the group's rename button comes back and takes focus. */
function cancelRename(group: TaskGroup): void {
  closeRename()
  void focusAfterSwap(() => rootRef.value, 'tasks-group-rename', sectionOf(group))
}

function openDeleteConfirm(group: TaskGroup): void {
  confirmingDeleteKey.value = groupKey(group)
  void focusAfterSwap(() => rootRef.value, 'tasks-group-delete-confirm-yes', sectionOf(group))
}

function cancelDeleteConfirm(group: TaskGroup): void {
  confirmingDeleteKey.value = null
  void focusAfterSwap(() => rootRef.value, 'tasks-group-delete', sectionOf(group))
}

async function onRename(group: TaskGroup): Promise<void> {
  const groupId = group.id
  if (groupId === null) return
  renameError.value = null
  const check = checkGroupName(renameDraft.value)
  if (check !== 'ok') {
    renameError.value = check
    return
  }
  const name = normalizeUserText(renameDraft.value) ?? ''
  const token = beginWrite()
  if (token === null) return
  try {
    const result =
      props.scope === 'list' ? await renameTaskListGroup(props.listId ?? '', groupId, name) : await renameUserGroup(groupId, name)
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      closeRename()
      await props.reload()
      return
    }
    await applyFailure(result, (code) => {
      renameError.value = code
    })
  } finally {
    endWrite(token)
  }
}

// RULED(2026-10-07): [R11] — deleting a group sends its tasks back to the default group; the
// default group is never deleted.
async function onDelete(group: TaskGroup): Promise<void> {
  const groupId = group.id
  if (groupId === null || group.isDefault) return
  const key = groupKey(group)
  const token = beginWrite()
  if (token === null) return
  try {
    const result = props.scope === 'list' ? await deleteTaskListGroup(props.listId ?? '', groupId) : await deleteUserGroup(groupId)
    if (token !== writeToken) return
    confirmingDeleteKey.value = null
    if (result.kind === 'ok') {
      await props.reload()
      return
    }
    await applyFailure(result, (code) => {
      deleteError.value = { key, code }
    })
  } finally {
    endWrite(token)
  }
}

// [fe-39] the board does not follow other people's changes on its own (design §6.5): refresh
// re-reads the rows, the groups and the placements.
async function onRefresh(): Promise<void> {
  const token = beginWrite()
  if (token === null) return
  try {
    await props.reload({ items: true })
  } finally {
    endWrite(token)
  }
}

onBeforeUnmount(() => {
  writeToken += 1
  // A write still in flight hands the shared flag back here: its answer never reaches the host.
  if (writing) {
    writing = false
    emit('update:pending', false)
  }
})
</script>

<style scoped>
.tasks-group-board {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tasks-group-board__live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.tasks-group-board__toolbar {
  display: flex;
  justify-content: flex-end;
}

.tasks-group {
  padding: 8px 12px;
  border: 1px solid var(--el-border-color-lighter, #eee);
  border-radius: 6px;
}

.tasks-group__header,
.tasks-group__rename,
.tasks-group-board__create {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.tasks-group__name {
  margin: 0;
  font-size: 15px;
}

.tasks-group__count,
.tasks-group-board__message,
.tasks-group__unsorted-heading {
  color: var(--el-text-color-secondary, #666);
}

.tasks-group__unsorted-heading {
  margin: 8px 0 0;
  font-size: 13px;
}

.tasks-group__items,
.tasks-group-board__flat {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-group-board__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--el-border-color-lighter, #eee);
}

.tasks-group-board__handle {
  cursor: grab;
  color: var(--el-text-color-secondary, #666);
  user-select: none;
}

.tasks-group-board__handle::before {
  content: '\22EE\22EE';
}

.tasks-group-board__handle[draggable='false'] {
  cursor: default;
  opacity: 0.4;
}

.tasks-group-board__moves {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
}

.tasks-group-board__error {
  flex-basis: 100%;
  margin: 0;
  color: var(--el-color-danger, #c45656);
}
</style>
