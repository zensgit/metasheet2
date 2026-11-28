<!--
  选择父任务 / 选择任务 — the task picker of the task pages: one task, picked by its title.

  Two modes:
  - `parent` (the task page): the parent candidates of the task (`getParentCandidates`), read once each
    time the picker opens, never before; the term filters their titles here, ignoring case.
  - `list-item` (the list page): the tasks the viewer created and the tasks assigned to them, in any
    status (`listTasks`), searched by title 300ms after the last keystroke. An answer to an older term
    is dropped, and both answers must be readable. Tasks in `excludeIds` are left out; a done task
    carries a mark.

  A blank term shows the "type a title" hint and sends nothing. At most 50 rows show; when more match,
  a hint asks for more of the title. A row shows the title (the id when the title is blank), and also
  the id when another row on screen has the same title. `beforeRequest`, when given, is asked right
  before every read, and nothing is sent when it says no. Confirm hands the parent the chosen task.

  Account switches, Escape, Tab, the overlay and focus work as in the people picker
  (TaskPeoplePicker.vue): the picker holds the identity it was opened under (`readDispatchIdentity`)
  and clears its rows, its term and its choice when another one is seen: on a storage change from
  another tab, a session switch in this tab, before a read, when an answer lands, and on confirm.
  Esc closes this picker only; Tab and Shift+Tab stay inside it; on close, focus goes back to the
  control that opened it. A mousedown on the overlay is held back, so focus does not move to the page
  behind the picker before the click closes it.
-->
<template>
  <div v-if="visible" class="task-picker__overlay" @mousedown.self.prevent @click.self="emit('close')">
    <div
      ref="panelRef"
      class="task-picker"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      data-testid="task-picker"
      @keydown="onPanelKeydown"
    >
      <div class="task-picker__header">
        <strong>{{ title }}</strong>
      </div>
      <label class="task-picker__label" :for="inputId">{{ t.taskPickerSearchLabel }}</label>
      <input
        :id="inputId"
        ref="inputRef"
        v-model="term"
        type="search"
        class="task-picker__input"
        data-testid="task-picker-search"
        :placeholder="t.taskPickerSearchPlaceholder"
        :maxlength="TASK_SEARCH_MAX_LENGTH"
        autocomplete="off"
        @input="onInput"
      />
      <div class="task-picker__body">
        <p v-if="view.kind === 'idle'" class="task-picker__hint" data-testid="task-picker-type-hint">{{ t.taskPickerTypeToSearch }}</p>
        <p v-else-if="view.kind === 'loading'" class="task-picker__hint" data-testid="task-picker-loading">{{ t.loading }}</p>
        <p v-else-if="view.kind === 'failed'" class="task-picker__hint task-picker__hint--warn" role="alert" data-testid="task-picker-error">{{ failureText }}</p>
        <template v-else-if="okView">
          <p v-if="okView.rows.length === 0" class="task-picker__hint" data-testid="task-picker-empty">{{ t.taskPickerNoMatch }}</p>
          <ul v-else class="task-picker__list" data-testid="task-picker-list">
            <li
              v-for="row in okView.rows"
              :key="row.id"
              class="task-picker__row"
              data-testid="task-picker-row"
              :data-task-id="row.id"
            >
              <label class="task-picker__row-label">
                <input
                  type="radio"
                  :name="choiceName"
                  data-testid="task-picker-choice"
                  :checked="chosenId === row.id"
                  @change="chosenId = row.id"
                />
                <span class="task-picker__text">
                  <span class="task-picker__title" data-testid="task-picker-title">{{ rowLabel(row) }}</span>
                  <span v-if="showsId(row)" class="task-picker__id" data-testid="task-picker-id">{{ row.id }}</span>
                </span>
                <span v-if="row.status === 'done'" class="task-picker__tag" data-testid="task-picker-done">{{ t.statusDone }}</span>
              </label>
            </li>
          </ul>
          <p v-if="okView.hasMore" class="task-picker__hint" data-testid="task-picker-more">{{ t.taskPickerRefineSearch }}</p>
        </template>
      </div>
      <div class="task-picker__footer">
        <button type="button" data-testid="task-picker-cancel" @click="emit('close')">{{ t.cancel }}</button>
        <button type="button" data-testid="task-picker-confirm" :disabled="chosen === null" @click="onConfirm">{{ t.peopleConfirm }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { onAuthSessionSwitch } from '../composables/authPrincipal'
import { useLocale } from '../composables/useLocale'
import { isInputMethodKey, moveFocusWithin } from './focusTrap'
import { TASKS_EN, TASKS_ZH, type TasksText } from './labels'
import { readDispatchIdentity } from './recordTaskDispatchIdentity'
import {
  getParentCandidates,
  isPathSafeSegment,
  listTasks,
  type ListTasksResult,
  type ParentCandidatesResult,
  type TaskStatus,
} from './tasksApi'
import { TASK_SEARCH_DEBOUNCE_MS, TASK_SEARCH_MAX_LENGTH, taskSearchTerm, titleHoldsTaskSearch } from './tasksSearch'

export type TaskPickerMode = 'parent' | 'list-item'

/** What confirm hands the parent: the chosen task. */
export interface TaskPicked {
  id: string
  title: string
}

const props = defineProps<{
  visible: boolean
  mode: TaskPickerMode
  /** Parent mode: the task whose parent is being picked. */
  taskId?: string
  /** List-item mode: tasks not to offer. */
  excludeIds?: readonly string[]
  /** Asked right before every read; nothing is sent when it answers false. */
  beforeRequest?: () => boolean
}>()

const emit = defineEmits<{
  (e: 'confirm', picked: TaskPicked): void
  (e: 'close'): void
}>()

/** The most rows the picker shows at once. */
const MAX_ROWS = 50

interface PickerRow {
  id: string
  title: string
  /** List-item mode only. */
  status?: TaskStatus
}

interface ListedRow {
  id: string
  title: string
  status: TaskStatus
}

type FailureReason = 'forbidden' | 'org_missing' | 'error'

type Loaded =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed'; reason: FailureReason }
  /** `cut`: an answer stopped short of its total. */
  | { kind: 'ok'; rows: PickerRow[]; cut: boolean }

type PickerView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed'; reason: FailureReason }
  | { kind: 'ok'; rows: PickerRow[]; hasMore: boolean }

const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const inputId = `${useId()}-task-search`
const choiceName = `${useId()}-task-choice`
const title = computed(() => (props.mode === 'parent' ? t.value.pickParent : t.value.listPickTask))

const panelRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const term = ref('')
// Parent mode: the candidates of this opening. List-item mode: the answer to the last term searched.
const loaded = shallowRef<Loaded>({ kind: 'idle' })
const chosenId = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null
let candidatesGeneration = 0
let searchGeneration = 0
// The identity the rows, the term and the choice on screen belong to (see the header).
let identity = readDispatchIdentity()
// The element that had focus when the picker opened, and the dialog around it (if any); cleared once
// focus has been handed back.
let opener: HTMLElement | null = null
let openerDialog: HTMLElement | null = null

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function reset(): void {
  clearTimer()
  candidatesGeneration += 1
  searchGeneration += 1
  term.value = ''
  loaded.value = { kind: 'idle' }
  chosenId.value = null
  identity = readDispatchIdentity()
}

/** Whether another identity than the one on screen is seen now; if so, everything on screen is
 *  cleared (and the pending search stopped) before this returns `true`. */
function identityChanged(): boolean {
  if (readDispatchIdentity() === identity) return false
  reset()
  if (props.visible && props.mode === 'parent') emit('close')
  return true
}

/** Parent mode: the candidates of this opening, read once. */
async function loadCandidates(): Promise<void> {
  if (props.beforeRequest && !props.beforeRequest()) return
  if (identityChanged()) return
  const mine = ++candidatesGeneration
  loaded.value = { kind: 'loading' }
  let result: ParentCandidatesResult | undefined
  try {
    result = await getParentCandidates(props.taskId ?? '')
  } catch {
    result = undefined
  }
  if (mine !== candidatesGeneration) return
  // An answer that lands under another identity than the one it was asked under is not shown.
  if (identityChanged()) return
  if (result && result.kind === 'ok') {
    loaded.value = { kind: 'ok', rows: result.items.map((item) => ({ id: item.id, title: item.title })), cut: false }
    return
  }
  loaded.value = { kind: 'failed', reason: result && result.kind === 'forbidden' ? 'forbidden' : 'error' }
}

function isListedRow(value: unknown): value is ListedRow {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && isPathSafeSegment(record.id)
    && typeof record.title === 'string'
    && (record.status === 'open' || record.status === 'done')
}

function failureOf(result: ListTasksResult | undefined): FailureReason {
  if (result && result.kind === 'org_missing') return 'org_missing'
  if (result && result.kind === 'forbidden') return 'forbidden'
  return 'error'
}

/** List-item mode: the tasks the viewer created and those assigned to them whose title holds
 *  `query`, both views at once; an answer that cannot be read, or one malformed row, fails the search. */
async function runSearch(query: string): Promise<void> {
  if (props.beforeRequest && !props.beforeRequest()) return
  if (identityChanged()) return
  const mine = searchGeneration
  loaded.value = { kind: 'loading' }
  let answers: Array<ListTasksResult | undefined>
  try {
    answers = await Promise.all([
      listTasks('created', undefined, 'all', query),
      listTasks('assigned', undefined, 'all', query),
    ])
  } catch {
    answers = [undefined, undefined]
  }
  if (mine !== searchGeneration) return
  // An answer that lands under another identity than the one it was asked under is not shown.
  if (identityChanged()) return
  const okAnswers: Array<Extract<ListTasksResult, { kind: 'ok' }>> = []
  for (const answer of answers) {
    if (!answer || answer.kind !== 'ok') {
      loaded.value = { kind: 'failed', reason: failureOf(answer) }
      return
    }
    okAnswers.push(answer)
  }
  const items: unknown[] = okAnswers.flatMap((answer) => answer.items)
  if (okAnswers.length !== 2 || !items.every(isListedRow)) {
    loaded.value = { kind: 'failed', reason: 'error' }
    return
  }
  const excluded = new Set(props.excludeIds ?? [])
  const seen = new Set<string>()
  const rows: PickerRow[] = []
  for (const item of items as ListedRow[]) {
    if (excluded.has(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    rows.push({ id: item.id, title: item.title, status: item.status })
  }
  const cut = okAnswers.some((answer) => answer.total !== undefined && answer.total > answer.items.length)
  loaded.value = { kind: 'ok', rows, cut }
}

watch(() => props.visible, (open, wasOpen) => {
  if (wasOpen && !open) returnFocus()
  reset()
  if (open) {
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    openerDialog = opener?.closest<HTMLElement>('[role="dialog"]') ?? null
    void nextTick(() => inputRef.value?.focus())
  }
  if (open && props.mode === 'parent') void loadCandidates()
}, { immediate: true })

const stopSessionSwitch = onAuthSessionSwitch(() => { identityChanged() })
const onStorage = () => { identityChanged() }
if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

onBeforeUnmount(() => {
  returnFocus()
  clearTimer()
  candidatesGeneration += 1
  searchGeneration += 1
  stopSessionSwitch()
  if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
})

const view = computed<PickerView>(() => {
  const state = loaded.value
  if (state.kind === 'failed') return state
  if (props.mode === 'parent' && taskSearchTerm(term.value) === '') return { kind: 'idle' }
  if (state.kind !== 'ok') return state
  const matching = props.mode === 'parent' ? state.rows.filter((row) => titleHoldsTaskSearch(row.title, term.value)) : state.rows
  return { kind: 'ok', rows: matching.slice(0, MAX_ROWS), hasMore: state.cut || matching.length > MAX_ROWS }
})

const okView = computed(() => (view.value.kind === 'ok' ? view.value : null))

function isBlankTitle(row: PickerRow): boolean {
  return taskSearchTerm(row.title) === ''
}

/** The title, or the id when the title is blank. */
function rowLabel(row: PickerRow): string {
  return isBlankTitle(row) ? row.id : row.title
}

/** Whether the id shows under the title: when another row on screen has the same title. */
function showsId(row: PickerRow): boolean {
  if (isBlankTitle(row)) return false
  const current = okView.value
  return current !== null && current.rows.some((other) => other.id !== row.id && other.title === row.title)
}

const failureText = computed(() => {
  const current = view.value
  if (current.kind !== 'failed') return ''
  if (current.reason === 'forbidden') return t.value.actionForbidden
  if (current.reason === 'org_missing') return t.value.orgMissing
  return t.value.taskPickerLoadFailed
})

// One keydown listener for the whole panel, never one on the search box as well. Vue stamps an event
// at the first of its listeners the event reaches, and skips any later one attached in that same
// millisecond or after. With a second listener on the box taking the stamp, an Esc arriving in the
// millisecond the picker opened would skip this one and close what is around the picker too.
function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // An Escape the input method may be using cancels the composition, not the picker. It still goes
    // no further, and its default is held back: the search box is type="search", which Chromium
    // empties on Escape.
    if (isInputMethodKey(event)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key === 'Tab') {
    // Tab stays inside the picker: nothing around it sees the key, and focus moves here (unless the
    // input method took the key, see tasks/focusTrap.ts).
    event.stopPropagation()
    moveFocusWithin(event.currentTarget as HTMLElement, event)
    return
  }
  // Enter in the search box submits nothing around the picker.
  if (event.key === 'Enter' && event.target === inputRef.value) event.preventDefault()
}

/** Hands focus back to the opener once the picker is gone (after the DOM update): only when focus
 *  was in the picker or is on the page itself, never when it has moved to another element since. An
 *  opener that is disabled (a write it started still out) or no longer in the page hands it to the
 *  dialog it was in, while that dialog is still in the page; with both gone, nothing is focused. */
function returnFocus(): void {
  const target = opener
  const dialog = openerDialog
  opener = null
  openerDialog = null
  if (!target) return
  void nextTick(() => {
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) return
    if (target.isConnected && !target.matches(':disabled')) {
      target.focus()
      return
    }
    if (dialog?.isConnected) dialog.focus()
  })
}

function onInput(event: Event): void {
  if (props.mode !== 'list-item') return
  clearTimer()
  const query = taskSearchTerm((event.target as HTMLInputElement).value)
  searchGeneration += 1
  if (query === '') {
    loaded.value = { kind: 'idle' }
    return
  }
  timer = setTimeout(() => {
    timer = null
    void runSearch(query)
  }, TASK_SEARCH_DEBOUNCE_MS)
}

/** The chosen row while it is on screen; only an id that can be placed in a request path leaves the
 *  picker. */
const chosen = computed<PickerRow | null>(() => {
  const current = okView.value
  if (!current || chosenId.value === null) return null
  const row = current.rows.find((entry) => entry.id === chosenId.value)
  return row && isPathSafeSegment(row.id) ? row : null
})

function onConfirm(): void {
  if (identityChanged()) return
  const row = chosen.value
  if (!row) return
  emit('confirm', { id: row.id, title: row.title })
}
</script>

<style scoped>
.task-picker__overlay { position: fixed; inset: 0; z-index: 130; background: rgba(0,0,0,.2); display: flex; align-items: center; justify-content: center; padding: 0 16px; }
.task-picker { background: #fff; border-radius: 6px; width: min(480px, calc(100vw - 32px)); max-height: 70vh; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; box-shadow: 0 10px 40px rgba(0,0,0,.18); }
.task-picker__label { font-size: 12px; color: #909399; }
.task-picker__input { border: 1px solid #dcdfe6; border-radius: 4px; padding: 8px; font-size: 16px; min-width: 0; }
.task-picker__body { overflow-y: auto; min-height: 80px; }
.task-picker__list { list-style: none; margin: 0; padding: 0; }
.task-picker__row-label { display: flex; align-items: center; gap: 8px; min-height: 40px; cursor: pointer; }
.task-picker__text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.task-picker__title { overflow-wrap: anywhere; }
.task-picker__id { font-size: 12px; color: #909399; overflow-wrap: anywhere; }
.task-picker__tag { font-size: 12px; color: #67c23a; white-space: nowrap; }
.task-picker__hint { margin: 8px 0; font-size: 13px; color: #909399; }
.task-picker__hint--warn { color: #e6a23c; }
.task-picker__footer { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
</style>
