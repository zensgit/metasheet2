<template>
  <div class="tasks-list-members__backdrop">
    <div
      ref="dialogRef"
      class="tasks-list-members"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tasks-list-members-title"
      data-testid="tasks-list-members-dialog"
      :aria-busy="pending ? 'true' : 'false'"
      @keydown="onKeydown"
    >
      <h2 id="tasks-list-members-title" ref="titleRef" tabindex="-1" data-testid="tasks-list-members-title">{{ t.membersTitle }}</h2>

      <p v-if="bannerMessage" class="tasks-list-members__error" data-testid="tasks-list-members-error" role="alert">{{ bannerMessage }}</p>

      <p v-if="readState.kind === 'loading'" class="tasks-list-members__message" data-testid="tasks-list-members-loading">{{ t.loading }}</p>
      <p
        v-else-if="readState.kind === 'not_found'"
        class="tasks-list-members__message"
        data-testid="tasks-list-members-not-found"
        role="status"
      >{{ t.listWriteNotFound }}</p>
      <p
        v-else-if="readState.kind === 'forbidden'"
        class="tasks-list-members__message"
        data-testid="tasks-list-members-forbidden"
        role="status"
      >{{ t.listForbidden }}</p>
      <p
        v-else-if="readState.kind === 'error'"
        class="tasks-list-members__message"
        data-testid="tasks-list-members-load-error"
        role="alert"
      >{{ t.membersLoadFailed }}</p>

      <!-- [fe-31] every write control needs the roster: none renders before the read is ok. -->
      <template v-else>
        <p v-if="readState.members.length === 0" class="tasks-list-members__message" data-testid="tasks-list-members-empty">
          {{ t.membersEmpty }}
        </p>
        <ul v-else class="tasks-list-members__list" data-testid="tasks-list-members">
          <li
            v-for="row in readState.members"
            :key="row.userId"
            class="tasks-list-members__row"
            data-testid="tasks-list-member"
            :data-user-id="row.userId"
            :data-role="row.role"
          >
            <span data-testid="tasks-list-member-id">{{ row.userId }}</span>
            <span data-testid="tasks-list-member-role">{{ roleLabel(row.role) }}</span>
            <span v-if="row.userId === list.createdBy" data-testid="tasks-list-member-creator">{{ t.membersCreatorMark }}</span>
            <!-- The select shows the server's role: `:value` follows the row, and only a server answer
                 replaces the row. -->
            <select
              v-if="canChangeRole(row)"
              data-testid="tasks-list-member-role-select"
              :aria-label="fmt.membersRoleFor(row.userId)"
              :value="row.role"
              :disabled="pending"
              @change="onRoleChange(row, $event)"
            >
              <option value="read">{{ t.listRoleRead }}</option>
              <option value="edit">{{ t.listRoleEdit }}</option>
            </select>
            <template v-if="canTransferTo(row)">
              <button
                v-if="confirmingTransferId !== row.userId"
                type="button"
                data-testid="tasks-list-member-transfer"
                :aria-label="fmt.membersTransferNamed(row.userId)"
                :disabled="pending"
                @click="openTransferConfirm(row.userId)"
              >{{ t.membersTransfer }}</button>
              <span v-else data-testid="tasks-list-member-transfer-confirm">
                <span id="tasks-list-member-transfer-prompt" role="status" data-testid="tasks-list-member-transfer-prompt">{{
                  fmt.membersTransferPrompt(row.userId)
                }}</span>
                <button
                  type="button"
                  data-testid="tasks-list-member-transfer-confirm-yes"
                  aria-describedby="tasks-list-member-transfer-prompt"
                  :disabled="pending"
                  @click="onTransfer(row.userId)"
                >{{ t.membersTransferConfirm }}</button>
                <button
                  type="button"
                  data-testid="tasks-list-member-transfer-confirm-cancel"
                  :disabled="pending"
                  @click="cancelTransferConfirm(row.userId)"
                >{{ t.cancel }}</button>
              </span>
            </template>
            <button
              v-if="canRemove(row)"
              type="button"
              data-testid="tasks-list-member-remove"
              :aria-label="fmt.membersRemoveNamed(row.userId)"
              :disabled="pending"
              @click="onRemove(row.userId)"
            >{{ t.remove }}</button>
            <p
              v-if="rowError !== null && rowError.userId === row.userId"
              class="tasks-list-members__error"
              data-testid="tasks-list-member-error"
              role="alert"
            >{{ codeMessage(rowError.code, t) }}</p>
          </li>
        </ul>

        <form v-if="canManageMembers" class="tasks-list-members__add" data-testid="tasks-list-add-member-form" @submit.prevent="onAdd">
          <label for="tasks-list-add-member-input">{{ t.membersAddLabel }}</label>
          <input
            id="tasks-list-add-member-input"
            v-model="newMemberId"
            type="text"
            autocomplete="off"
            data-testid="tasks-list-add-member-input"
            :placeholder="t.membersAddPlaceholder"
            :disabled="pending || atMemberCap"
            :aria-invalid="addError !== null ? 'true' : undefined"
            :aria-describedby="addError !== null ? 'tasks-list-add-member-error' : undefined"
            @input="addError = null"
          />
          <label for="tasks-list-add-member-role">{{ t.membersAddRoleLabel }}</label>
          <select
            id="tasks-list-add-member-role"
            v-model="newMemberRole"
            data-testid="tasks-list-add-member-role"
            :disabled="pending || atMemberCap"
          >
            <option value="read">{{ t.listRoleRead }}</option>
            <option value="edit">{{ t.listRoleEdit }}</option>
          </select>
          <button
            type="submit"
            data-testid="tasks-list-add-member-submit"
            :disabled="pending || atMemberCap || newMemberId.trim().length === 0"
          >{{ t.membersAdd }}</button>
          <p v-if="atMemberCap" class="tasks-list-members__message" data-testid="tasks-list-add-member-cap" role="status">
            {{ t.codeLimitMembers }}
          </p>
          <p
            v-if="addErrorMessage"
            id="tasks-list-add-member-error"
            class="tasks-list-members__error"
            data-testid="tasks-list-add-member-error"
            role="alert"
          >{{ addErrorMessage }}</p>
        </form>

        <div v-if="canLeave" class="tasks-list-members__leave">
          <button
            v-if="!confirmingLeave"
            type="button"
            data-testid="tasks-list-leave"
            :disabled="pending"
            @click="openLeaveConfirm"
          >{{ t.membersLeave }}</button>
          <span v-else data-testid="tasks-list-leave-confirm">
            <span id="tasks-list-leave-prompt" role="status" data-testid="tasks-list-leave-prompt">{{ t.membersLeavePrompt }}</span>
            <button
              type="button"
              data-testid="tasks-list-leave-confirm-yes"
              aria-describedby="tasks-list-leave-prompt"
              :disabled="pending"
              @click="onLeave"
            >{{ t.membersLeaveConfirm }}</button>
            <button type="button" data-testid="tasks-list-leave-confirm-cancel" :disabled="pending" @click="cancelLeaveConfirm">
              {{ t.cancel }}
            </button>
          </span>
          <p v-if="leaveError !== null" class="tasks-list-members__error" data-testid="tasks-list-leave-error" role="alert">
            {{ codeMessage(leaveError, t) }}
          </p>
        </div>
      </template>

      <button type="button" class="tasks-list-members__close" data-testid="tasks-list-members-close" :disabled="pending" @click="close">
        {{ t.membersClose }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The members dialog of `/task-lists/:id` (M4 frontend design §5; backend `GET` / `POST
 * /api/task-lists/:id/members`, `PATCH` / `DELETE …/members/:userId`, `POST …/transfer-owner`,
 * PR-3a S6). Mounted by TaskListView while open; it reads the roster when it mounts.
 *
 * Abilities. The list carries `myRole`, `createdBy` and `ownerId` and no ability flags, so the
 * controls follow the design's inference (§5.1); the server still decides every write, and a 404 /
 * 422 it answers renders as usual:
 *   - add a member, change a role, remove a member: `myRole` is `edit` or `owner`;
 *   - a row's role can change unless it is the owner's row or the viewer's own row;
 *   - a row can be removed unless it is the creator's, the owner's or the viewer's own row;
 *   - those two row controls wait for the viewer's own id (hidden while it is pending or could not
 *     be resolved: the viewer's own row cannot be told apart before);
 *   - transfer: the viewer is the owner, on every row but the owner's;
 *   - leave: the viewer's id is known, the viewer is not the creator and not the owner.
 *
 * Writes. One at a time across the page and this dialog (`v-model:pending`; a local flag also
 * refuses a second write in the same tick, before the page's flag reaches this component). A
 * write's ok replaces the roster with the response's `members` — no re-read. A transfer's ok also
 * has the page re-read the list (its `ownerId` and `myRole` changed) and holds `pending` until
 * that read lands. A leave's ok tells the page, which closes the dialog and goes to `/tasks`. A
 * 404 says the list is not available, has the page re-read the list, and — when the dialog is
 * still showing — re-reads the roster. A transfer or leave that succeeded tells the lists bus even
 * when its answer lands after the dialog closed: the viewer's own role or membership changed.
 *
 * Errors land next to what caused them: the add form, the row acted on (role, remove, transfer),
 * the leave button; a 404 / 403 / any other failure takes the dialog's banner; `ORG_MISSING`
 * switches the page to its guidance block.
 *
 * Focus: the title takes focus on open; Tab and Shift+Tab wrap inside the dialog; Escape and the
 * close button close it (both inert while a write is in flight) and the page puts focus back on
 * the button that opened it. Once a write lands, focus that ended up outside the dialog comes back
 * in (`[fe-48]`): to the control the write started from while it is still there and usable, else
 * to the title. The transfer and leave confirmations swap out the button that opened them
 * (`[fe-49]`): opening one focuses its confirm button, which its prompt describes (the prompt is
 * also a status message); cancelling it focuses the button that comes back.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { TASKS_EN, TASKS_FMT_EN, TASKS_FMT_ZH, TASKS_ZH, codeMessage, type TasksText } from '../../tasks/labels'
import { focusAfterSwap } from '../../tasks/tasksFocus'
import {
  addTaskListMember,
  changeTaskListMemberRole,
  listTaskListMembers,
  removeTaskListMember,
  transferTaskListOwner,
  type TaskList,
  type TaskListAssignableRole,
  type TaskListMembership,
  type TaskListRole,
  type WriteFailure,
} from '../../tasks/tasksApi'
import { notifyListsChanged } from '../../tasks/tasksListsBus'

const props = defineProps<{
  /** The id every request of this dialog goes to (the page's route id). */
  listId: string
  /** The list as the page last read it. */
  list: TaskList
  currentUserId: string | null
  currentUserStatus: 'pending' | 'known' | 'unavailable'
  /** Shared with the page through `v-model:pending`. */
  pending: boolean
  /** The page's quiet re-read of the list; awaited while `pending` is held. */
  reloadList: () => Promise<void>
}>()

const emit = defineEmits<{
  'update:pending': [value: boolean]
  close: []
  left: []
  'org-missing': []
}>()

const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const fmt = computed(() => (isZh.value ? TASKS_FMT_ZH : TASKS_FMT_EN))

// ASSUMPTION(task-m4-fe): [D14] — at most 100 members per list.
const MEMBER_CAP = 100

type ReadState =
  | { kind: 'loading' }
  | { kind: 'ok'; members: TaskListMembership[] }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

type Banner = 'not_found' | 'forbidden' | 'error'

const readState = ref<ReadState>({ kind: 'loading' })
const banner = ref<Banner | null>(null)
const rowError = ref<{ userId: string; code: string } | null>(null)
const addError = ref<string | null>(null)
const leaveError = ref<string | null>(null)

const newMemberId = ref('')
// [fe-29] a new member starts with the narrower role.
const newMemberRole = ref<TaskListAssignableRole>('read')
const confirmingTransferId = ref<string | null>(null)
const confirmingLeave = ref(false)

const dialogRef = ref<HTMLElement | null>(null)
const titleRef = ref<HTMLElement | null>(null)

// Late-result guards: the read compares its generation, a write its token; unmounting advances both.
let readGeneration = 0
let writeToken = 0
let writing = false
// [fe-48] the control a write started from. While the write is out every control is disabled, and
// a browser moves focus off a disabled control to <body> (the focus fixup rule; jsdom does not); a
// transfer or a removal also takes its control away. Focus left on <body> sits outside this modal,
// where neither Escape nor the Tab wrap is heard — seen in a real browser in FE-8.
let focusBeforeWrite: HTMLElement | null = null

// RULED(2026-10-07): [R12] — the list's role rules (design §5.1): `edit` manages members like
// the owner, only the owner transfers, the creator and the owner are never removed, `owner` is
// never given directly.
const canManageMembers = computed(() => props.list.myRole === 'edit' || props.list.myRole === 'owner')

/** The viewer's own id once resolved; `null` while it is pending or could not be resolved. */
const viewerId = computed(() => (props.currentUserStatus === 'known' ? props.currentUserId : null))

// [fe-28] never the viewer's own row, and no row before the viewer's id is known.
function canChangeRole(row: TaskListMembership): boolean {
  return canManageMembers.value && row.role !== 'owner' && viewerId.value !== null && row.userId !== viewerId.value
}

function canRemove(row: TaskListMembership): boolean {
  return (
    canManageMembers.value &&
    row.userId !== props.list.createdBy &&
    row.role !== 'owner' &&
    viewerId.value !== null &&
    row.userId !== viewerId.value
  )
}

function canTransferTo(row: TaskListMembership): boolean {
  return props.list.myRole === 'owner' && row.userId !== props.list.ownerId
}

// ASSUMPTION(task-m4-fe): [own-14] (PR-3a) — a member leaves through the same DELETE; the creator
// cannot, and the owner transfers first.
const canLeave = computed(
  () => viewerId.value !== null && viewerId.value !== props.list.createdBy && props.list.myRole !== 'owner',
)

const atMemberCap = computed(() => readState.value.kind === 'ok' && readState.value.members.length >= MEMBER_CAP)

function roleLabel(role: TaskListRole): string {
  if (role === 'owner') return t.value.listRoleOwner
  if (role === 'edit') return t.value.listRoleEdit
  return t.value.listRoleRead
}

const bannerMessage = computed<string | null>(() => {
  switch (banner.value) {
    case 'not_found':
      return t.value.listWriteNotFound
    case 'forbidden':
      return t.value.listWriteForbidden
    case 'error':
      return t.value.actionFailed
    default:
      return null
  }
})

const addErrorMessage = computed<string | null>(() => {
  const code = addError.value
  if (code === null) return null
  // ASSUMPTION(task-m4-fe): [D14] — `LIMIT` here is the member cap.
  if (code === 'LIMIT') return t.value.codeLimitMembers
  return codeMessage(code, t.value)
})

// ---- the roster read -------------------------------------------------------------------------

/** The roster (one page: the member cap fits in it). `quiet` keeps the rows until the answer
 *  lands. A 404 has the page re-read the list unless `reloadListOnNotFound` is false. */
async function loadMembers(options: { quiet?: boolean; reloadListOnNotFound?: boolean } = {}): Promise<void> {
  readGeneration += 1
  const mine = readGeneration
  if (!options.quiet) readState.value = { kind: 'loading' }
  const result = await listTaskListMembers(props.listId, { isSuperseded: () => mine !== readGeneration })
  if (mine !== readGeneration) return
  switch (result.kind) {
    case 'ok':
      readState.value = { kind: 'ok', members: result.items.map(({ userId, role }) => ({ userId, role })) }
      return
    case 'org_missing':
      emit('org-missing')
      return
    case 'not_found':
      readState.value = { kind: 'not_found' }
      if (options.reloadListOnNotFound !== false) await props.reloadList()
      return
    case 'forbidden':
      readState.value = { kind: 'forbidden' }
      return
    default:
      readState.value = { kind: 'error' }
  }
}

// ---- writes ----------------------------------------------------------------------------------

/** The token of a write allowed to start now, or `null` while another write is in flight. */
function beginWrite(): number | null {
  if (props.pending || writing) return null
  writing = true
  const active = document.activeElement
  focusBeforeWrite = active instanceof HTMLElement && dialogRef.value?.contains(active) ? active : null
  emit('update:pending', true)
  banner.value = null
  rowError.value = null
  addError.value = null
  leaveError.value = null
  writeToken += 1
  return writeToken
}

function endWrite(token: number): void {
  if (token !== writeToken) return
  writing = false
  emit('update:pending', false)
  void returnFocus()
}

/** [fe-48] After a write: focus already inside the dialog stays; focus outside it goes back to the
 *  control the write started from when that control is still in the dialog and enabled, else to
 *  the title. A dialog that closed in the meantime (a leave) is left alone. */
async function returnFocus(): Promise<void> {
  const target = focusBeforeWrite
  focusBeforeWrite = null
  await nextTick()
  const dialog = dialogRef.value
  if (!dialog) return
  const active = document.activeElement
  if (active instanceof HTMLElement && dialog.contains(active)) return
  if (target && target.isConnected && dialog.contains(target) && !(target as HTMLButtonElement).disabled) {
    target.focus()
    return
  }
  titleRef.value?.focus()
}

/** [fe-31] A failed write: `ORG_MISSING` goes to the page's guidance block, a 422 / 409 code to
 *  the caller's spot, a 403 / any other failure to the banner. A 404 takes the banner and has the
 *  page re-read the list (design §5.3); when the dialog is still showing after that, the roster is
 *  read again too. */
async function applyFailure(result: WriteFailure, token: number, onCode: (code: string) => void): Promise<void> {
  switch (result.kind) {
    case 'org_missing':
      emit('org-missing')
      return
    case 'validation':
    case 'conflict':
      onCode(result.code)
      return
    case 'forbidden':
      banner.value = 'forbidden'
      return
    case 'not_found':
      banner.value = 'not_found'
      await props.reloadList()
      if (token !== writeToken) return
      await loadMembers({ quiet: true, reloadListOnNotFound: false })
      return
    default:
      banner.value = 'error'
  }
}

/** A write's ok: the response carries the whole roster ([fe-04]). */
function replaceRoster(members: TaskListMembership[]): void {
  readState.value = { kind: 'ok', members }
}

async function onAdd(): Promise<void> {
  const userId = newMemberId.value.trim()
  if (userId.length === 0 || atMemberCap.value) return
  const token = beginWrite()
  if (token === null) return
  try {
    const result = await addTaskListMember(props.listId, userId, newMemberRole.value)
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      newMemberId.value = ''
      replaceRoster(result.members)
      return
    }
    await applyFailure(result, token, (code) => {
      addError.value = code
    })
  } finally {
    endWrite(token)
  }
}

function onRoleChange(row: TaskListMembership, event: Event): void {
  const select = event.target as HTMLSelectElement
  const picked = select.value
  // A pick is a request, not a change: the select keeps the server's role until an answer
  // replaces the row.
  select.value = row.role
  if ((picked === 'read' || picked === 'edit') && picked !== row.role) void changeRole(row.userId, picked)
}

async function changeRole(userId: string, role: TaskListAssignableRole): Promise<void> {
  const token = beginWrite()
  if (token === null) return
  try {
    const result = await changeTaskListMemberRole(props.listId, userId, role)
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      replaceRoster(result.members)
      return
    }
    await applyFailure(result, token, (code) => {
      rowError.value = { userId, code }
    })
  } finally {
    endWrite(token)
  }
}

async function onRemove(userId: string): Promise<void> {
  const token = beginWrite()
  if (token === null) return
  try {
    const result = await removeTaskListMember(props.listId, userId)
    if (token !== writeToken) return
    if (result.kind === 'ok') {
      replaceRoster(result.members)
      return
    }
    await applyFailure(result, token, (code) => {
      rowError.value = { userId, code }
    })
  } finally {
    endWrite(token)
  }
}

// [fe-49] the two confirmations: the control the viewer used is swapped out, which would leave
// focus on the page body, outside this modal, where neither Escape nor the Tab wrap is heard.
function openTransferConfirm(userId: string): void {
  confirmingTransferId.value = userId
  void focusAfterSwap(() => dialogRef.value, 'tasks-list-member-transfer-confirm-yes', { attr: 'data-user-id', value: userId })
}

function cancelTransferConfirm(userId: string): void {
  confirmingTransferId.value = null
  void focusAfterSwap(() => dialogRef.value, 'tasks-list-member-transfer', { attr: 'data-user-id', value: userId })
}

function openLeaveConfirm(): void {
  confirmingLeave.value = true
  void focusAfterSwap(() => dialogRef.value, 'tasks-list-leave-confirm-yes')
}

function cancelLeaveConfirm(): void {
  confirmingLeave.value = false
  void focusAfterSwap(() => dialogRef.value, 'tasks-list-leave')
}

// [fe-27] reached through the row's two-step confirmation.
async function onTransfer(userId: string): Promise<void> {
  const token = beginWrite()
  if (token === null) return
  try {
    const result = await transferTaskListOwner(props.listId, userId)
    // [fe-32] the viewer's own role changed: the lists bus hears it even when the answer is late.
    if (result.kind === 'ok') notifyListsChanged()
    if (token !== writeToken) return
    confirmingTransferId.value = null
    if (result.kind === 'ok') {
      replaceRoster(result.members)
      await props.reloadList()
      return
    }
    await applyFailure(result, token, (code) => {
      rowError.value = { userId, code }
    })
  } finally {
    endWrite(token)
  }
}

async function onLeave(): Promise<void> {
  const viewer = viewerId.value
  if (viewer === null || !canLeave.value) return
  const token = beginWrite()
  if (token === null) return
  try {
    const result = await removeTaskListMember(props.listId, viewer)
    // [fe-32] the viewer is no longer a member: the lists bus hears it even when the answer is late.
    if (result.kind === 'ok') notifyListsChanged()
    if (token !== writeToken) return
    confirmingLeave.value = false
    if (result.kind === 'ok') {
      emit('left')
      return
    }
    await applyFailure(result, token, (code) => {
      leaveError.value = code
    })
  } finally {
    endWrite(token)
  }
}

// ---- closing and focus -----------------------------------------------------------------------

// [fe-30] a write in flight keeps the dialog open until its answer lands.
function close(): void {
  if (props.pending || writing) return
  emit('close')
}

const FOCUSABLE = 'button, input, select, textarea, a[href]'

function focusableElements(): HTMLElement[] {
  const root = dialogRef.value
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => !(element as HTMLButtonElement | HTMLInputElement).disabled,
  )
}

// [fe-12] the minimal focus trap: Tab past the last control wraps to the first, Shift+Tab before
// the first wraps to the last; the set is taken at keydown time, disabled controls left out.
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    close()
    return
  }
  if (event.key !== 'Tab') return
  const items = focusableElements()
  if (items.length === 0) {
    event.preventDefault()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement as HTMLElement | null
  const inside = active !== null && items.includes(active)
  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault()
      last.focus()
    }
    return
  }
  if (!inside || active === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  titleRef.value?.focus()
  void loadMembers()
})

onBeforeUnmount(() => {
  readGeneration += 1
  writeToken += 1
  // A write still in flight hands the shared flag back here: an answer that lands after unmount
  // never reaches the page (the page can leave its list body — a re-read that ends in not_found —
  // while this dialog holds the flag).
  if (writing) {
    writing = false
    emit('update:pending', false)
  }
})
</script>

<style scoped>
.tasks-list-members__backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 48px 16px;
  background: rgba(0, 0, 0, 0.35);
}

.tasks-list-members {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(640px, 100%);
  max-height: calc(100vh - 96px);
  overflow: auto;
  padding: 20px 24px;
  border-radius: 8px;
  background: var(--el-bg-color, #fff);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}

.tasks-list-members h2 {
  margin: 0;
}

.tasks-list-members__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tasks-list-members__row,
.tasks-list-members__add,
.tasks-list-members__leave {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.tasks-list-members__row {
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter, #eee);
}

.tasks-list-members__message {
  margin: 0;
  color: var(--el-text-color-secondary, #666);
}

.tasks-list-members__error {
  flex-basis: 100%;
  margin: 0;
  color: var(--el-color-danger, #c45656);
}

.tasks-list-members__close {
  align-self: flex-end;
}
</style>
