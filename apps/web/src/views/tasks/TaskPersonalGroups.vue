<template>
  <TaskGroupBoard
    v-model:pending="pending"
    scope="user"
    :items="items"
    :groups="groupsResult.kind === 'ok' ? groupsResult.groups : null"
    :placements="placementsResult.kind === 'ok' ? placementsResult.placements : null"
    :unavailable="groupsResult.kind === 'unavailable' || placementsResult.kind === 'unavailable'"
    :truncated="truncated"
    :can-manage="true"
    :reload="reload"
    flat-testid="tasks-list"
    row-testid="tasks-list-item"
    @org-missing="emit('org-missing')"
  >
    <template #row="{ item }"><slot name="row" :item="item" /></template>
  </TaskGroupBoard>
</template>

<script setup lang="ts">
/**
 * The assigned view's personal groups on `/tasks` (M4 frontend design §2.4, §4.6; backend
 * `GET /api/task-groups`, `GET /api/task-groups/items`, PR-3a S8). TasksView mounts it only for the
 * assigned view with a non-empty list and hands it that list's rows; the rows' content comes from
 * TasksView's `row` slot, so the row actions stay TasksView's.
 *
 * Reads: the groups and the placements, in parallel when it mounts, each under its own generation.
 * Until both are in the rows render flat — the same `tasks-list` list and `tasks-list-item` rows as
 * the other views; when either read fails, flat with the "groups unavailable" notice; when both are
 * in, the board. A collection read that reports no org reads as unavailable here: the task list's
 * own read shows the guidance block first. A write that reports no org asks TasksView for it.
 *
 * Writes go through the board, under this component's own `pending` (nothing else on `/tasks`
 * shares it). The board's re-read after a write is quiet: the groups and the placements, and — for
 * the refresh button and after a 404 — the rows as well, through TasksView's quiet list read.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TaskGroupBoard from './TaskGroupBoard.vue'
import { listUserGroupItems, listUserGroups, type TaskGroup, type TaskListItem, type TaskPlacement } from '../../tasks/tasksApi'

const props = defineProps<{
  /** The assigned view's rows, in the server's order. */
  items: TaskListItem[]
  /** TasksView's quiet re-read of the assigned view's rows. */
  reloadItems: () => Promise<void>
}>()

const emit = defineEmits<{ 'org-missing': [] }>()

defineSlots<{ row(props: { item: TaskListItem }): unknown }>()

type GroupsState = { kind: 'loading' } | { kind: 'ok'; groups: TaskGroup[]; truncated: boolean } | { kind: 'unavailable' }
type PlacementsState =
  | { kind: 'loading' }
  | { kind: 'ok'; placements: TaskPlacement[]; truncated: boolean }
  | { kind: 'unavailable' }

const groupsResult = ref<GroupsState>({ kind: 'loading' })
const placementsResult = ref<PlacementsState>({ kind: 'loading' })
const pending = ref(false)

// Late-result guards: each read compares its generation; unmounting advances both.
let groupsGeneration = 0
let placementsGeneration = 0

const truncated = computed(
  () =>
    (groupsResult.value.kind === 'ok' && groupsResult.value.truncated) ||
    (placementsResult.value.kind === 'ok' && placementsResult.value.truncated),
)

// RULED(2026-10-07): [R11] — personal groups belong to the assigned view only; the reads list
// the viewer's groups (exactly one default) and the placements of the tasks still assigned to the
// viewer.
// ASSUMPTION(task-m4-fe): [own-24] (PR-3a) — the default group's `id` is `null` before its row
// exists.
/** `quiet` keeps what is showing until the answer lands. */
async function loadGroups(options: { quiet?: boolean } = {}): Promise<void> {
  groupsGeneration += 1
  const mine = groupsGeneration
  if (!options.quiet) groupsResult.value = { kind: 'loading' }
  const result = await listUserGroups()
  if (mine !== groupsGeneration) return
  groupsResult.value =
    result.kind === 'ok' ? { kind: 'ok', groups: result.items, truncated: result.items.length < result.total } : { kind: 'unavailable' }
}

async function loadPlacements(options: { quiet?: boolean } = {}): Promise<void> {
  placementsGeneration += 1
  const mine = placementsGeneration
  if (!options.quiet) placementsResult.value = { kind: 'loading' }
  const result = await listUserGroupItems({ isSuperseded: () => mine !== placementsGeneration })
  if (mine !== placementsGeneration) return
  placementsResult.value =
    result.kind === 'ok'
      ? { kind: 'ok', placements: result.items, truncated: result.items.length < result.total }
      : { kind: 'unavailable' }
}

/** The board's re-read. [fe-40] the rows are TasksView's: `items` re-reads them through it. */
async function reload(options: { items?: boolean } = {}): Promise<void> {
  await Promise.all([options.items ? props.reloadItems() : undefined, loadGroups({ quiet: true }), loadPlacements({ quiet: true })])
}

onMounted(() => {
  void loadGroups()
  void loadPlacements()
})

onBeforeUnmount(() => {
  groupsGeneration += 1
  placementsGeneration += 1
})
</script>
