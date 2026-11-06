<!--
  选择负责人 / 选择关注人 — the people picker of the task pages (task usability package 1b).

  Searches the active members of the viewer's org by name (`searchPeople`, `GET /api/tasks/people`)
  and lets the viewer tick several; confirm hands the parent the chosen ids, which it sends through
  its own writes unchanged. Each row shows the name (the id when there is none), a distinguishing
  detail (a masked email; the id when two rows would read the same, or when there is no detail) and,
  for a person who cannot use tasks yet, a 还不能使用任务 tag. In `assignee` mode such a row cannot be
  ticked, since the assignee write would refuse it; in `follower` mode it can (followers need no task
  access), the tag stays as information.

  A blank term sends nothing and shows the "type a name" hint, never "no one matches". A term is sent
  300ms after the last keystroke; an answer to an older term is dropped. `beforeRequest`, when given,
  is asked right before every search and nothing is sent when it says no.

  Account switches: the picker holds the identity it was opened under (`readDispatchIdentity`, the
  user and org a request would carry, as the record dispatch dialog reads it). When another identity
  is seen — on a storage change from another tab, a session switch in this tab, the start of a search,
  the answer to one, or confirm — the rows, the term, the ticks and any pending search are cleared and
  nothing from before is shown or handed back. A token refresh for the same user and org is not a
  change. This is not the parent's gate: `beforeRequest` is still asked first, and the parent decides
  whether anything may be sent at all.

  Inline overlay (no Teleport), so it can open inside another dialog. Esc closes this picker only;
  Tab and Shift+Tab stay inside it. On close, focus goes back to the control that opened it (see
  returnFocus). A mousedown on the overlay is held back: it would otherwise move focus to the nearest
  focusable element around the picker before the click closes it, and focus would stay there.
-->
<template>
  <div v-if="visible" class="task-people-picker__overlay" @mousedown.self.prevent @click.self="emit('close')">
    <div
      ref="panelRef"
      class="task-people-picker"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      data-testid="task-people-picker"
      @keydown="onPanelKeydown"
    >
      <div class="task-people-picker__header">
        <strong>{{ title }}</strong>
      </div>
      <label class="task-people-picker__label" :for="inputId">{{ t.peopleSearchLabel }}</label>
      <input
        :id="inputId"
        ref="inputRef"
        v-model="term"
        type="search"
        class="task-people-picker__input"
        data-testid="task-people-picker-search"
        :placeholder="t.peopleSearchPlaceholder"
        autocomplete="off"
        @input="onInput"
      />
      <div class="task-people-picker__body">
        <p v-if="state.kind === 'idle'" class="task-people-picker__hint" data-testid="task-people-picker-type-hint">{{ t.peopleTypeToSearch }}</p>
        <p v-else-if="state.kind === 'loading'" class="task-people-picker__hint" data-testid="task-people-picker-loading">{{ t.loading }}</p>
        <p v-else-if="state.kind === 'failed'" class="task-people-picker__hint task-people-picker__hint--warn" role="alert" data-testid="task-people-picker-error">{{ failureText }}</p>
        <template v-else-if="okState">
          <p v-if="okState.items.length === 0" class="task-people-picker__hint" data-testid="task-people-picker-empty">{{ t.peopleNoMatch }}</p>
          <ul v-else class="task-people-picker__list" data-testid="task-people-picker-list">
            <li
              v-for="row in okState.items"
              :key="row.id"
              class="task-people-picker__row"
              :class="{ 'task-people-picker__row--blocked': isBlocked(row) }"
              data-testid="task-people-picker-row"
              :data-person-id="row.id"
            >
              <label class="task-people-picker__row-label" :title="row.canUseTasks ? undefined : t.peopleCannotUseTasksHint">
                <input
                  type="checkbox"
                  data-testid="task-people-picker-check"
                  :checked="picked.has(row.id)"
                  :disabled="isBlocked(row)"
                  @change="toggle(row)"
                />
                <span class="task-people-picker__text">
                  <span class="task-people-picker__name" data-testid="task-people-picker-name">{{ row.name || row.id }}</span>
                  <span class="task-people-picker__detail" data-testid="task-people-picker-detail">{{ subtitle(row) }}</span>
                </span>
                <span v-if="!row.canUseTasks" class="task-people-picker__tag" data-testid="task-people-picker-no-access">{{ t.peopleCannotUseTasks }}</span>
              </label>
            </li>
          </ul>
          <p v-if="okState.hasMore" class="task-people-picker__hint" data-testid="task-people-picker-more">{{ t.peopleRefineSearch }}</p>
        </template>
      </div>
      <div class="task-people-picker__footer">
        <span class="task-people-picker__count" data-testid="task-people-picker-count">{{ t.peopleSelectedLabel }}{{ picked.size }}</span>
        <div class="task-people-picker__actions">
          <button type="button" data-testid="task-people-picker-cancel" @click="emit('close')">{{ t.cancel }}</button>
          <button type="button" data-testid="task-people-picker-confirm" :disabled="confirmable.length === 0" @click="onConfirm">{{ t.peopleConfirm }}</button>
        </div>
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
import { isPathSafeSegment, searchPeople, type PersonOption, type SearchPeopleResult } from './tasksApi'

export type TaskPeoplePickerMode = 'assignee' | 'follower'

/** What confirm hands the parent: the chosen ids in the order they were ticked, and their names. */
export interface TaskPeoplePicked {
  ids: string[]
  names: Record<string, string>
}

const props = defineProps<{
  visible: boolean
  mode: TaskPeoplePickerMode
  /** Asked right before every search; nothing is sent when it answers false. */
  beforeRequest?: () => boolean
}>()

const emit = defineEmits<{
  (e: 'confirm', picked: TaskPeoplePicked): void
  (e: 'close'): void
}>()

const SEARCH_DEBOUNCE_MS = 300

type PickerState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'failed'; reason: Exclude<SearchPeopleResult['kind'], 'ok'> }
  | { kind: 'ok'; items: PersonOption[]; hasMore: boolean }

const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const inputId = `${useId()}-people-search`
const title = computed(() => (props.mode === 'assignee' ? t.value.pickAssignee : t.value.pickFollower))

const panelRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const term = ref('')
const state = shallowRef<PickerState>({ kind: 'idle' })
// Ticked people, in the order they were ticked (a Map keeps insertion order).
const picked = shallowRef(new Map<string, PersonOption>())
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0
// The identity the rows, the term and the ticks on screen belong to (see the header).
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
  generation += 1
  term.value = ''
  state.value = { kind: 'idle' }
  picked.value = new Map()
  identity = readDispatchIdentity()
}

/** Whether another identity than the one on screen is seen now; if so, everything on screen is
 *  cleared (and the pending search stopped) before this returns `true`. */
function identityChanged(): boolean {
  if (readDispatchIdentity() === identity) return false
  reset()
  return true
}

watch(() => props.visible, (open, wasOpen) => {
  if (wasOpen && !open) returnFocus()
  reset()
  if (open) {
    opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    openerDialog = opener?.closest<HTMLElement>('[role="dialog"]') ?? null
    void nextTick(() => inputRef.value?.focus())
  }
}, { immediate: true })

const stopSessionSwitch = onAuthSessionSwitch(() => { identityChanged() })
const onStorage = () => { identityChanged() }
if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

onBeforeUnmount(() => {
  returnFocus()
  clearTimer()
  generation += 1
  stopSessionSwitch()
  if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
})

const okState = computed(() => (state.value.kind === 'ok' ? state.value : null))

function isBlocked(row: PersonOption): boolean {
  return props.mode === 'assignee' && !row.canUseTasks
}

/** The detail, or the id when there is none; with the id appended when another row on screen has
 *  the same name and the same detail. */
function subtitle(row: PersonOption): string {
  if (!row.detail) return row.id
  const items = okState.value?.items ?? []
  const twin = items.some((other) => other.id !== row.id && other.name === row.name && other.detail === row.detail)
  return twin ? `${row.detail} · ${row.id}` : row.detail
}

const failureText = computed(() => {
  if (state.value.kind !== 'failed') return ''
  switch (state.value.reason) {
    case 'org_missing':
      return t.value.orgMissing
    case 'forbidden':
      return t.value.actionForbidden
    case 'rate_limited':
      return t.value.peopleRateLimited
    default:
      return t.value.peopleLoadFailed
  }
})

async function runSearch(query: string): Promise<void> {
  if (props.beforeRequest && !props.beforeRequest()) return
  if (identityChanged()) return
  const mine = ++generation
  state.value = { kind: 'loading' }
  let result: SearchPeopleResult
  try {
    result = await searchPeople(query)
  } catch {
    result = { kind: 'error', status: 0 }
  }
  if (mine !== generation) return
  // An answer that lands under another identity than the one it was asked under is not shown.
  if (identityChanged()) return
  if (result.kind === 'ok') {
    state.value = result.requiresQuery ? { kind: 'idle' } : { kind: 'ok', items: result.items, hasMore: result.hasMore }
    return
  }
  state.value = { kind: 'failed', reason: result.kind }
}

// One keydown listener for the whole panel, never one on the search box as well. Vue stamps an event
// at the first of its listeners the event reaches, and skips any later one attached in that same
// millisecond or after. With a second listener on the box taking the stamp, an Esc arriving in the
// millisecond the picker opened would skip this one and close the dialog around the picker too.
function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // An Escape the input method may be using cancels the composition, not the picker. It still goes
    // no further, so a dialog around the picker does not close on it either.
    if (isInputMethodKey(event)) {
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key === 'Tab') {
    // Tab stays inside the picker: a dialog around it never sees the key, and focus moves here
    // (unless the input method took the key, see tasks/focusTrap.ts).
    event.stopPropagation()
    moveFocusWithin(event.currentTarget as HTMLElement, event)
    return
  }
  // Enter in the search box submits nothing around the picker.
  if (event.key === 'Enter' && event.target === inputRef.value) event.preventDefault()
}

/** Hands focus back to the opener once the picker is gone (after the DOM update): only when focus
 *  was in the picker or is on the page itself, never when it has moved to another element since (a
 *  dialog closing around the picker restores its own). An opener that is disabled (a write it started
 *  still out) or no longer in the page (the dialog around it turned to another view) hands it to that
 *  dialog, while the dialog is still in the page; with both gone, nothing is focused. */
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
    // focus() leaves an element that cannot take focus (no tabindex) as it is.
    if (dialog?.isConnected) dialog.focus()
  })
}

function onInput(event: Event): void {
  clearTimer()
  const query = (event.target as HTMLInputElement).value.trim()
  if (query.length === 0) {
    generation += 1
    state.value = { kind: 'idle' }
    return
  }
  timer = setTimeout(() => {
    timer = null
    void runSearch(query)
  }, SEARCH_DEBOUNCE_MS)
}

function toggle(row: PersonOption): void {
  if (isBlocked(row)) return
  const next = new Map(picked.value)
  if (next.has(row.id)) next.delete(row.id)
  else next.set(row.id, row)
  picked.value = next
}

// Only ids that can be placed in a request path leave the picker.
const confirmable = computed(() => Array.from(picked.value.values()).filter((row) => isPathSafeSegment(row.id) && !isBlocked(row)))

function onConfirm(): void {
  if (identityChanged()) return
  const rows = confirmable.value
  if (rows.length === 0) return
  emit('confirm', {
    ids: rows.map((row) => row.id),
    names: Object.fromEntries(rows.filter((row) => row.name).map((row) => [row.id, row.name])),
  })
}
</script>

<style scoped>
.task-people-picker__overlay { position: fixed; inset: 0; z-index: 130; background: rgba(0,0,0,.2); display: flex; align-items: center; justify-content: center; padding: 0 16px; }
.task-people-picker { background: #fff; border-radius: 6px; width: min(480px, calc(100vw - 32px)); max-height: 70vh; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; box-shadow: 0 10px 40px rgba(0,0,0,.18); }
.task-people-picker__label { font-size: 12px; color: #909399; }
.task-people-picker__input { border: 1px solid #dcdfe6; border-radius: 4px; padding: 8px; font-size: 16px; min-width: 0; }
.task-people-picker__body { overflow-y: auto; min-height: 80px; }
.task-people-picker__list { list-style: none; margin: 0; padding: 0; }
.task-people-picker__row-label { display: flex; align-items: center; gap: 8px; min-height: 40px; cursor: pointer; }
.task-people-picker__row--blocked .task-people-picker__row-label { cursor: not-allowed; color: #909399; }
.task-people-picker__text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.task-people-picker__name { overflow-wrap: anywhere; }
.task-people-picker__detail { font-size: 12px; color: #909399; overflow-wrap: anywhere; }
.task-people-picker__tag { font-size: 12px; color: #e6a23c; white-space: nowrap; }
.task-people-picker__hint { margin: 8px 0; font-size: 13px; color: #909399; }
.task-people-picker__hint--warn { color: #e6a23c; }
.task-people-picker__footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.task-people-picker__count { font-size: 13px; color: #606266; }
.task-people-picker__actions { display: flex; gap: 8px; }
</style>
