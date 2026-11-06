<!--
  派发任务 / Dispatch a task from a record (owner ruling R-45 step 1).

  From the record drawer's kebab: confirm a title, pick assignees, a completion mode and a due date,
  and a REAL task is created in the task centre through the same `createTask` wrapper the task create
  form uses (`POST /api/tasks`), with the record as its `source` ({ sheetId, viewId, recordId }; ids
  only) and the record's retry key (`dispatchKey`). That one write is all: the description is not
  written (a task dispatched before this kept its source line).

  RETRY KEY (tasks/recordTaskDispatchKey.ts): a key is obtained per record when the first create is
  sent and counted as sent before the request leaves; resending under it lets the service answer with
  the task the key already made instead of making a second one. The key is released once a result is
  on screen, on 再派一项, and when the service refuses it. An answer that lands after an await changes
  the record's entry (a 4xx counted off it, a refused or found key released) only while the page
  binding still holds and the entry still holds the key that request carried; otherwise it is left as
  it is.

  WHAT EACH ANSWER SAYS (only what the browser knows):
   - 2xx: the task (new: 任务已创建; a resend the service matched: the earlier task and a note that this
     submission changed nothing, after one read of it — a task that reads as not found gets no link
     and 再派一项). A sourced create answered without `sourceLinked: true` (a service that does not
     store the link) is still reported as created, with a note.
   - 4xx: THIS request created nothing; its own message. When the key already held an attempt with no
     readable answer, a separate line says that attempt's outcome is still not known.
   - no answer, a 5xx, or a 200 that cannot be read: the outcome is unknown. Never reported as a
     failure; the form stays exactly as sent and the primary button becomes 重试, which resends the same
     body under the same key (page memory only).
  On open, when this record's key holds an attempt with no readable answer and this page holds no body
  for it (a reload, another record and back), the dialog asks the record's task route for the caller's
  own task under that key: one → that task; none → a line saying it left no task you can open; the
  read failed → two lines saying neither can be told, and the form.
  Then (a plain open, or none found under the key) one read of the record's task list: the tasks the
  caller dispatched from this record are listed (已从此记录派发, a link each) with 再派一项, and the form
  is shown only after that button; when the list cannot be read, the form comes with a line saying so.
  Submit stays disabled while these reads are out.

  STRUCTURE: the same shape as MetaRecordApprovalSubmitDialog.vue — Teleport + overlay + `role="dialog"`
  with a backed `aria-modal` (focus in on open, Tab trapped, Esc closes only this dialog, focus back to
  the opener on close).

  DOUBLE CREATE: the state of a dispatch (in flight / created / failed) is kept per record OUTSIDE
  this component (tasks/recordTaskDispatchRuns.ts, keyed by `runKey`), because the dialog can be
  closed (取消 / × / Esc / overlay) or unmounted (the drawer moves to another record) while a create
  is out. Any dialog for the same record then sees the create still out (submit disabled, no second
  create) or the task it produced (the success panel and its link, not a blank form). Submit is also
  disabled from the first click until the create settles, and gone once the task exists. The record's
  ids are captured when submit is clicked, so a create always names the record it was sent from.

  IDENTITY: the dialog sends only under the page's binding (`binding`, tasks/recordTaskDispatchIdentity.ts):
  the signed-in user and org the page was set up under, marked changed for good the first time any
  other identity is seen (before any multitable request of the page, on a storage change or a session
  switch, or by this dialog). The dialog checks it again on open, right before the create (with no
  await between that check and the send), and right before each read it sends (the open-time reads of
  the record's tasks, the read of a matched task).
  Once the binding is changed nothing more is sent, the draft is cleared and the dialog shows a plain
  refusal instead of a form until the page is reloaded, as does any dialog opened after it.

  WHAT LEAVES THE RECORD: the title the dispatcher sees and confirms (prefilled from the primary
  field's display text), the user ids they confirm (prefilled from a person field they choose), and the
  record's ids. The dialog never reads `record.data` itself; the parent hands it only those values.
-->
<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-dispatch-overlay" @click.self="onCancel">
      <div
        ref="modalRef"
        class="meta-dispatch-modal"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        :aria-label="l('dispatch.dialogTitle')"
        data-testid="record-task-dispatch-dialog"
        @keydown="onKeydown"
      >
        <div class="meta-dispatch__header">
          <strong>{{ l('dispatch.dialogTitle') }}</strong>
          <MtIconButton class="meta-dispatch__close" :aria-label="l('dispatch.close')" @click="onCancel">&times;</MtIconButton>
        </div>

        <div v-if="identityRefusal" class="meta-dispatch__body" data-testid="record-task-dispatch-identity-refused">
          <p class="meta-dispatch__hint meta-dispatch__hint--warn" role="alert">{{ l(identityRefusal) }}</p>
        </div>

        <div v-else-if="resultPanel" class="meta-dispatch__body" :data-testid="resultPanel.testId">
          <p class="meta-dispatch__success" role="status">
            {{ l(resultPanel.heading) }}
            <template v-if="resultPanel.taskId">
              <RouterLink
                v-if="hasRouter"
                class="meta-dispatch__link"
                data-testid="record-task-dispatch-open-task"
                :to="taskPath(resultPanel.taskId)"
              >{{ l('dispatch.openTask') }}</RouterLink>
              <a
                v-else
                class="meta-dispatch__link"
                data-testid="record-task-dispatch-open-task"
                :href="taskPath(resultPanel.taskId)"
              >{{ l('dispatch.openTask') }}</a>
            </template>
          </p>
          <p
            v-for="note in resultPanel.notes"
            :key="note.id"
            class="meta-dispatch__hint"
            :class="{ 'meta-dispatch__hint--warn': note.warn }"
            :data-testid="`record-task-dispatch-${note.id}`"
          >{{ l(note.key) }}</p>
        </div>

        <div v-else-if="pendingElsewhere" class="meta-dispatch__body" data-testid="record-task-dispatch-pending">
          <p class="meta-dispatch__hint" role="status">{{ l('dispatch.pendingElsewhere') }}</p>
        </div>

        <div v-else-if="showExisting" class="meta-dispatch__body" data-testid="record-task-dispatch-existing">
          <p
            v-for="hint in formHints"
            :key="hint.id"
            class="meta-dispatch__hint meta-dispatch__hint--warn"
            role="alert"
            :data-testid="`record-task-dispatch-${hint.id}`"
          >{{ l(hint.key) }}</p>
          <p :id="controlId('existing-heading')" class="meta-dispatch__label">{{ l('dispatch.existingHeading') }}</p>
          <ul class="meta-dispatch__existing" :aria-labelledby="controlId('existing-heading')">
            <li v-for="task in existingTasks" :key="task.id" :data-task-id="task.id">
              <RouterLink
                v-if="hasRouter"
                class="meta-dispatch__link"
                data-testid="record-task-dispatch-existing-task"
                :to="taskPath(task.id)"
              >{{ task.title || l('dispatch.openTask') }}</RouterLink>
              <a
                v-else
                class="meta-dispatch__link"
                data-testid="record-task-dispatch-existing-task"
                :href="taskPath(task.id)"
              >{{ task.title || l('dispatch.openTask') }}</a>
            </li>
          </ul>
        </div>

        <div v-else class="meta-dispatch__body">
          <div class="meta-dispatch__row">
            <label class="meta-dispatch__label" :for="controlId('title')">
              {{ l('dispatch.titleLabel') }}<span class="meta-dispatch__required" :title="l('dispatch.requiredMark')">*</span>
            </label>
            <input
              :id="controlId('title')"
              v-model="title"
              type="text"
              class="meta-dispatch__control"
              data-testid="record-task-dispatch-title"
              :disabled="submitting"
            />
          </div>

          <div class="meta-dispatch__row">
            <span class="meta-dispatch__label">{{ l('dispatch.assigneesLabel') }}</span>
            <div v-if="personFields.length > 0" class="meta-dispatch__inline">
              <label class="meta-dispatch__sublabel" :for="controlId('person-field')">{{ l('dispatch.personFieldLabel') }}</label>
              <select
                :id="controlId('person-field')"
                class="meta-dispatch__control"
                data-testid="record-task-dispatch-person-field"
                :value="personFieldId"
                :disabled="submitting"
                @change="onSelectPersonField(($event.target as HTMLSelectElement).value)"
              >
                <option value="">{{ l('dispatch.personFieldNone') }}</option>
                <option v-for="field in personFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
            </div>
            <!-- Package 1b: people are picked by name; the user-id entry below is folded until asked for
                 (`hidden` as well, so the Tab trap steps over it). -->
            <div class="meta-dispatch__inline">
              <MtButton size="sm" data-testid="record-task-dispatch-pick-people" :disabled="submitting" @click="onPickPeople">{{ l('dispatch.pickPeople') }}</MtButton>
              <button
                type="button"
                class="meta-dispatch__link-button"
                data-testid="record-task-dispatch-add-by-id-toggle"
                :aria-expanded="typedOpen ? 'true' : 'false'"
                @click="typedOpen = !typedOpen"
              >{{ l('dispatch.assigneeInputLabel') }}</button>
            </div>
            <ul v-if="assignees.length > 0" class="meta-dispatch__chips" data-testid="record-task-dispatch-assignees">
              <li
                v-for="id in assignees"
                :key="id"
                class="meta-dispatch__chip"
                :data-assignee-id="id"
              >
                <span>{{ assigneeDisplay(id) }}</span>
                <span v-if="isInactive(id)" class="meta-dispatch__chip-note">（{{ l('dispatch.assigneeInactive') }}）</span>
                <span v-else-if="noAccessIds.has(id)" class="meta-dispatch__chip-note">（{{ l('dispatch.assigneeNoAccess') }}）</span>
                <button
                  type="button"
                  class="meta-dispatch__chip-remove"
                  :aria-label="l('dispatch.assigneeRemove')"
                  :disabled="submitting"
                  @click="removeAssignee(id)"
                >&times;</button>
              </li>
            </ul>
            <p v-else class="meta-dispatch__hint" data-testid="record-task-dispatch-assignees-empty">{{ l('dispatch.assigneesEmptyHint') }}</p>
            <p
              v-if="inactiveSkipped"
              class="meta-dispatch__hint"
              data-testid="record-task-dispatch-inactive-skipped"
            >{{ l('dispatch.inactiveSkipped') }}</p>
            <p
              v-if="accessSkipped > 0"
              class="meta-dispatch__hint"
              data-testid="record-task-dispatch-access-skipped"
            >{{ dispatchAccessSkipped(accessSkipped, isZh) }}</p>
            <div v-show="typedOpen" :hidden="!typedOpen" class="meta-dispatch__inline" data-testid="record-task-dispatch-add-by-id">
              <label class="meta-dispatch__sublabel" :for="controlId('assignee-input')">{{ l('dispatch.assigneeInputLabel') }}</label>
              <input
                :id="controlId('assignee-input')"
                ref="typedInputRef"
                v-model="typedAssignee"
                type="text"
                class="meta-dispatch__control"
                data-testid="record-task-dispatch-assignee-input"
                :placeholder="l('dispatch.assigneeInputPlaceholder')"
                :disabled="submitting"
              />
              <MtButton size="sm" data-testid="record-task-dispatch-assignee-add" :disabled="submitting" @click="onAddTyped">{{ l('dispatch.assigneeAdd') }}</MtButton>
            </div>
            <p
              v-if="assigneeError"
              class="meta-dispatch__hint meta-dispatch__hint--warn"
              role="alert"
              data-testid="record-task-dispatch-assignee-error"
            >{{ l(assigneeError) }}</p>
            <TaskPeoplePicker
              :visible="pickerOpen"
              mode="assignee"
              :before-request="verifyIdentity"
              @confirm="onPickerConfirm"
              @close="pickerOpen = false"
            />
          </div>

          <div class="meta-dispatch__row">
            <label class="meta-dispatch__label" :for="controlId('mode')">{{ l('dispatch.completionModeLabel') }}</label>
            <select
              :id="controlId('mode')"
              v-model="completionMode"
              class="meta-dispatch__control"
              data-testid="record-task-dispatch-mode"
              :disabled="submitting"
            >
              <option value="all">{{ modeText.modeAll }}</option>
              <option value="any">{{ modeText.modeAny }}</option>
            </select>
          </div>

          <div class="meta-dispatch__row meta-dispatch__row--due">
            <div class="meta-dispatch__due">
              <label class="meta-dispatch__label" :for="controlId('due-date')">
                {{ l('dispatch.dueDateLabel') }}<span class="meta-dispatch__required" :title="l('dispatch.requiredMark')">*</span>
              </label>
              <input
                :id="controlId('due-date')"
                v-model="dueDate"
                type="date"
                class="meta-dispatch__control"
                data-testid="record-task-dispatch-due-date"
                :disabled="submitting"
                aria-required="true"
              />
            </div>
            <div class="meta-dispatch__due">
              <label class="meta-dispatch__label" :for="controlId('due-time')">{{ l('dispatch.dueTimeLabel') }}</label>
              <input
                :id="controlId('due-time')"
                v-model="dueTime"
                type="time"
                step="60"
                class="meta-dispatch__control"
                data-testid="record-task-dispatch-due-time"
                :disabled="submitting || dueDate === ''"
              />
            </div>
          </div>

          <p class="meta-dispatch__hint" data-testid="record-task-dispatch-access-note">{{ l('dispatch.accessNote') }}</p>
          <p
            v-if="displayedError"
            class="meta-dispatch__hint meta-dispatch__hint--warn"
            role="alert"
            data-testid="record-task-dispatch-error"
          >{{ l(displayedError) }}</p>
          <p
            v-for="hint in formHints"
            :key="hint.id"
            class="meta-dispatch__hint meta-dispatch__hint--warn"
            role="alert"
            :data-testid="`record-task-dispatch-${hint.id}`"
          >{{ l(hint.key) }}</p>
        </div>

        <div class="meta-dispatch__actions">
          <MtButton class="meta-dispatch__btn" data-testid="record-task-dispatch-cancel" @click="onCancel">{{ resultPanel && !identityRefusal ? l('dispatch.done') : l('dispatch.cancel') }}</MtButton>
          <MtButton
            v-if="(resultPanel?.another || showExisting) && !identityRefusal"
            class="meta-dispatch__btn"
            data-testid="record-task-dispatch-another"
            @click="onAnother"
          >{{ l('dispatch.another') }}</MtButton>
          <!-- One element from 派发 to 重试: replacing a focused button would drop focus to the page. -->
          <MtButton
            v-if="!resultPanel && !identityRefusal && !showExisting"
            variant="primary"
            class="meta-dispatch__btn"
            data-testid="record-task-dispatch-submit"
            :disabled="inFlight || resolving"
            @click="onSubmit"
          >{{ inFlight ? l('dispatch.submitting') : unknownOutcome ? l('dispatch.retry') : l('dispatch.submit') }}</MtButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, useId, watch } from 'vue'
import { RouterLink, routerKey } from 'vue-router'
import type { PersonSummary } from '../types'
import { MtButton, MtIconButton } from '../ui'
import { useLocale } from '../../composables/useLocale'
import { dispatchAccessSkipped, recordLabel, type MetaRecordLabelKey } from '../utils/meta-record-labels'
import { TASKS_EN, TASKS_ZH } from '../../tasks/labels'
import TaskPeoplePicker, { type TaskPeoplePicked } from '../../tasks/TaskPeoplePicker.vue'
import { isInputMethodKey, moveFocusWithin } from '../../tasks/focusTrap'
import {
  createTask,
  getTask,
  resolvePeople,
  type CompletionMode,
  type CreateTaskInput,
  type CreateTaskResult,
  type PersonOption,
  type SearchPeopleResult,
} from '../../tasks/tasksApi'
import { usableViewerTimeZone } from '../../tasks/tasksDraft'
import { notifyTasksChanged } from '../../tasks/tasksBadgeBus'
import { NO_DISPATCH_IDENTITY, type DispatchBinding } from '../../tasks/recordTaskDispatchIdentity'
import { dispatchKeys, type DispatchKeyScope } from '../../tasks/recordTaskDispatchKey'
import type { MetaRecordTaskItem, MultitableApiClient } from '../api/client'
import {
  beginDispatchRun,
  forgetDispatchRun,
  markDispatchRunSeen,
  readDispatchRun,
  settleDispatchRun,
  type DispatchFailureState,
  type DispatchOutcome,
} from '../../tasks/recordTaskDispatchRuns'
import {
  DISPATCH_ASSIGNEE_LIMIT,
  addAssignees,
  buildDispatchCreateInput,
  classifyDispatchFailure,
  isSettledDispatchFailure,
  splitTypedAssigneeIds,
  type DispatchCheckCode,
  type DispatchFailure,
} from '../../tasks/recordTaskDispatch'

export interface DispatchPersonField {
  id: string
  name: string
  /** The field's user ids on this record (already filtered to valid ids, deduplicated). */
  ids: string[]
}

const props = withDefaults(defineProps<{
  visible: boolean
  /** The record's primary-field display text; `''` when the primary value is empty. */
  defaultTitle: string
  /** The record's native person fields the viewer can see, in field order. */
  personFields?: DispatchPersonField[]
  /** Display names for person-field user ids, keyed by field id (the drawer's own summaries). */
  personSummaries?: Record<string, PersonSummary[]>
  /** The record's sheet and id: the create's `source`, and the scope of the record's retry key. */
  sheetId: string
  recordId: string
  /** The view the record is open in, sent with the source when known. */
  viewId?: string
  /** The drawer's multitable client, for the open-time reads of the record's tasks (under its retry
   *  key, and the list of the caller's tasks from it). */
  apiClient?: Pick<MultitableApiClient, 'listRecordTasks'> | null
  /** The page's binding: the signed-in user and org it was set up under, and whether another has been seen. */
  binding: DispatchBinding
  /** The record's dispatch-state key under that identity (`dispatchRunKey(binding.identity, sheetId, recordId)`). */
  runKey: string
}>(), {
  personFields: () => [],
  personSummaries: () => ({}),
  viewId: undefined,
  apiClient: null,
})

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordLabelKey) => recordLabel(key, isZh.value)
const modeText = computed(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const hasRouter = !!inject(routerKey, null)
const idBase = useId()
const controlId = (name: string) => `${idBase}-dispatch-${name}`

const modalRef = ref<HTMLElement | null>(null)
const title = ref('')
const assignees = ref<string[]>([])
const personFieldId = ref('')
const typedAssignee = ref('')
const typedInputRef = ref<HTMLInputElement | null>(null)
const completionMode = ref<CompletionMode>('all')
const dueDate = ref('')
const dueTime = ref('')
const assigneeError = ref<MetaRecordLabelKey | null>(null)
const formError = ref<MetaRecordLabelKey | null>(null)
const inactiveSkipped = ref(false)
// Package 1b: the picker, the folded user-id entry, the names the picker gave, and what the people
// lookup after a person-field prefill said (not an active member: 已停用; cannot use tasks yet).
const pickerOpen = ref(false)
const typedOpen = ref(false)
const pickedNames = ref<Record<string, string>>({})
const absentIds = ref<Set<string>>(new Set())
const noAccessIds = ref<Set<string>>(new Set())
const accessSkipped = ref(0)
let resolveGeneration = 0
// This record's dispatch state lives outside the component (see the header comment).
const run = computed(() => readDispatchRun(props.runKey))
const inFlight = computed(() => run.value?.inFlight === true)
// The last create got no readable answer: its outcome is unknown until a retry is answered.
const unknownOutcome = computed(() => !inFlight.value && run.value?.failure?.unknown === true)
// The form's controls are locked while a create is out and while its outcome is unknown, so a retry
// can only ever resend what was sent.
const submitting = computed(() => inFlight.value || unknownOutcome.value)
const created = computed(() => run.value?.created ?? null)
// Whether THIS dialog's form sent the create that is out. A dialog mounted later for the same record
// has a form that was never sent, so it shows a pending note instead of that form.
const sentHere = ref(false)
const pendingElsewhere = computed(() => inFlight.value && !sentHere.value)
// The caller's tasks from this record are listed instead of the form until 再派一项 (cleared then).
const showExisting = computed(() => existingTasks.value.length > 0
  && !identityRefusal.value && !inFlight.value && !created.value && earlierCreatedId.value === null)
// The open-time read of the record's own task under its retry key (see the header comment).
const resolving = ref(false)
let resolveTicket = 0
/** The task that read found (shown like a matched resend). */
const earlierCreatedId = ref<string | null>(null)
/** The read found none. */
const earlierNoTask = ref(false)
/** An earlier attempt under the key has no readable answer and nothing here can say what it did. */
const earlierUnresolved = ref(false)
/** The record's tasks could not be read. */
const existingReadFailed = ref(false)
/** The tasks the caller dispatched from this record, as the open-time list read found them. */
const existingTasks = ref<MetaRecordTaskItem[]>([])
let previouslyFocused: HTMLElement | null = null
// The refusal shown once the page's binding is changed; never cleared (see the header).
const identityRefusal = computed<MetaRecordLabelKey | null>(() => {
  if (!props.binding.changed.value) return null
  return props.binding.identity === NO_DISPATCH_IDENTITY ? 'dispatch.identityUnavailable' : 'dispatch.identityChanged'
})

/** Drops everything the dispatcher entered or the record filled in. */
function clearDraft(): void {
  title.value = ''
  assignees.value = []
  personFieldId.value = ''
  typedAssignee.value = ''
  completionMode.value = 'all'
  dueDate.value = ''
  dueTime.value = ''
  assigneeError.value = null
  formError.value = null
  inactiveSkipped.value = false
  sentHere.value = false
  pickerOpen.value = false
  typedOpen.value = false
  pickedNames.value = {}
  absentIds.value = new Set()
  noAccessIds.value = new Set()
  accessSkipped.value = 0
  resolveGeneration += 1
  clearOpenState()
}

/** Drops what the open-time read and the last answer put on screen. */
function clearOpenState(): void {
  resolveTicket += 1
  resolving.value = false
  earlierCreatedId.value = null
  earlierNoTask.value = false
  earlierUnresolved.value = false
  existingReadFailed.value = false
  existingTasks.value = []
}

/** Whether a request sent now would carry the page's identity, and no other has been seen. When not,
 *  the binding is changed for good, and the watcher below clears the draft. */
function verifyIdentity(): boolean {
  return props.binding.check()
}

// The binding changes from many places (the page's requests, a storage change from another tab, a
// session switch in this tab, this dialog's own checks); the draft goes at once, in the same run, so a
// form that is open flips to the refusal before anyone clicks.
watch(() => props.binding.changed.value, (changed) => {
  if (changed) clearDraft()
}, { flush: 'sync', immediate: true })

watch(dueDate, (date) => {
  if (date === '') dueTime.value = ''
})

const summaryById = computed(() => {
  const map = new Map<string, PersonSummary>()
  for (const list of Object.values(props.personSummaries ?? {})) {
    for (const summary of list ?? []) if (!map.has(summary.id)) map.set(summary.id, summary)
  }
  return map
})

function assigneeDisplay(id: string): string {
  return summaryById.value.get(id)?.display || pickedNames.value[id] || id
}

function isInactive(id: string): boolean {
  return summaryById.value.get(id)?.inactive === true || absentIds.value.has(id)
}

function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`
}

/** The record this dialog dispatches from: the scope of its retry key. */
function currentScope(): DispatchKeyScope {
  return { sheetId: props.sheetId, recordId: props.recordId }
}

interface PanelNote {
  id: string
  key: MetaRecordLabelKey
  warn: boolean
}

interface ResultPanel {
  testId: string
  heading: MetaRecordLabelKey
  /** The task to link to; none when it cannot be opened. */
  taskId: string | null
  notes: PanelNote[]
  /** 再派一项 is offered (a deliberate second dispatch, under a fresh key). */
  another: boolean
}

// A created task, a resend the service matched, or the task the open-time read found.
const resultPanel = computed<ResultPanel | null>(() => {
  const done = created.value
  if (done?.reused && !done.openable) {
    return { testId: 'record-task-dispatch-reused', heading: 'dispatch.reusedNotOpenable', taskId: null, notes: [], another: true }
  }
  if (done?.reused) {
    return {
      testId: 'record-task-dispatch-reused',
      heading: 'dispatch.reusedHeading',
      taskId: done.id,
      notes: [{ id: 'reused-note', key: 'dispatch.reusedNote', warn: false }],
      another: true,
    }
  }
  if (done) {
    const notes: PanelNote[] = []
    if (!done.sourceLinked) notes.push({ id: 'source-not-linked', key: 'dispatch.sourceNotLinked', warn: true })
    if (done.earlierUnresolved) notes.push({ id: 'earlier-unresolved', key: 'dispatch.earlierUnresolved', warn: true })
    return { testId: 'record-task-dispatch-success', heading: 'dispatch.success', taskId: done.id, notes, another: false }
  }
  if (earlierCreatedId.value) {
    // Nothing was submitted on this page, so the resend note ("this submission changed nothing") would
    // not be true here; only that the earlier attempt made this task.
    return {
      testId: 'record-task-dispatch-earlier-created',
      heading: 'dispatch.reusedHeading',
      taskId: earlierCreatedId.value,
      notes: [{ id: 'earlier-created-note', key: 'dispatch.earlierCreated', warn: false }],
      another: true,
    }
  }
  return null
})

// The form's message: a pre-check or a 4xx, or the unknown outcome of the last create.
const displayedError = computed<MetaRecordLabelKey | null>(() => {
  if (formError.value) return formError.value
  return unknownOutcome.value ? 'dispatch.outcomeUnknown' : null
})

const formHints = computed<Array<{ id: string; key: MetaRecordLabelKey }>>(() => {
  const hints: Array<{ id: string; key: MetaRecordLabelKey }> = []
  if (earlierNoTask.value) hints.push({ id: 'earlier-no-task', key: 'dispatch.earlierNoTask' })
  if (earlierUnresolved.value) hints.push({ id: 'earlier-unresolved', key: 'dispatch.earlierUnresolved' })
  if (existingReadFailed.value) hints.push({ id: 'existing-read-failed', key: 'dispatch.existingReadFailed' })
  if (unknownOutcome.value && run.value?.failure?.keyNotSaved) hints.push({ id: 'key-not-saved', key: 'dispatch.keyNotSaved' })
  return hints
})

/** A person field's ids without the people the drawer marks as deactivated: the server refuses an
 *  assignee who is not an active member, so filling one in would make the first submit fail. Such a
 *  person can still be added by typing the id. */
function activeIds(field: DispatchPersonField | undefined): string[] {
  return field ? field.ids.filter((id) => !isInactive(id)) : []
}

/** Replace the assignee list with a person field's active ids (capped at the limit, which is then said). */
function applyPersonField(fieldId: string): void {
  personFieldId.value = fieldId
  assigneeError.value = null
  absentIds.value = new Set()
  noAccessIds.value = new Set()
  accessSkipped.value = 0
  const field = props.personFields.find((entry) => entry.id === fieldId)
  const ids = activeIds(field)
  inactiveSkipped.value = field !== undefined && ids.length < field.ids.length
  if (ids.length > DISPATCH_ASSIGNEE_LIMIT) {
    assignees.value = ids.slice(0, DISPATCH_ASSIGNEE_LIMIT)
    assigneeError.value = 'dispatch.assigneeLimit'
  } else {
    assignees.value = [...ids]
  }
  void checkPrefill(fieldId, [...assignees.value])
}

/** Package 1b: person-field ids skip the picker, so they are looked up once (`resolvePeople`). Only
 *  an `ok` answer for the same prefill is acted on: an id it leaves out (not an active member of
 *  the org) is dropped and said, like a deactivated person; a person who cannot use tasks yet is
 *  dropped too, and counted. Any other answer changes nothing; the create's own check remains.
 *  An answer that lands once the form is sent (a create out, or its outcome unknown) is not acted on
 *  either: the locked form shows what was sent, and a retry resends that. */
async function checkPrefill(fieldId: string, ids: string[]): Promise<void> {
  const mine = ++resolveGeneration
  if (ids.length === 0 || !verifyIdentity()) return
  let result: SearchPeopleResult
  try {
    result = await resolvePeople(ids)
  } catch {
    return
  }
  if (mine !== resolveGeneration || personFieldId.value !== fieldId || props.binding.changed.value || submitting.value) return
  if (result.kind !== 'ok') return
  const found = new Map<string, PersonOption>(result.items.map((item): [string, PersonOption] => [item.id, item]))
  const absent = ids.filter((id) => !found.has(id))
  const blocked = ids.filter((id) => found.get(id)?.canUseTasks === false)
  if (absent.length === 0 && blocked.length === 0) return
  absentIds.value = new Set(absent)
  noAccessIds.value = new Set(blocked)
  if (absent.length > 0) inactiveSkipped.value = true
  accessSkipped.value = blocked.length
  const dropped = new Set([...absent, ...blocked])
  assignees.value = assignees.value.filter((id) => !dropped.has(id))
}

/** 选择人员: the button is focused first (a click does not focus a button in macOS Safari), so the
 *  picker hands focus back to it on close. */
function onPickPeople(event: MouseEvent): void {
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
  pickerOpen.value = true
}

function onPickerConfirm(picked: TaskPeoplePicked): void {
  pickerOpen.value = false
  if (submitting.value) return
  const result = addAssignees(assignees.value, picked.ids)
  if (!result.ok) {
    assigneeError.value = result.code === 'LIMIT' ? 'dispatch.assigneeLimit' : 'dispatch.assigneeInvalid'
    return
  }
  assignees.value = result.ids
  pickedNames.value = { ...pickedNames.value, ...picked.names }
  assigneeError.value = null
}

function onSelectPersonField(fieldId: string): void {
  applyPersonField(fieldId)
}

function onAddTyped(): void {
  if (submitting.value) return
  const parts = splitTypedAssigneeIds(typedAssignee.value)
  if (parts.length === 0) return
  const result = addAssignees(assignees.value, parts)
  if (!result.ok) {
    assigneeError.value = result.code === 'LIMIT' ? 'dispatch.assigneeLimit' : 'dispatch.assigneeInvalid'
    return
  }
  assignees.value = result.ids
  assigneeError.value = null
  typedAssignee.value = ''
}

function removeAssignee(id: string): void {
  if (submitting.value) return
  assignees.value = assignees.value.filter((entry) => entry !== id)
  if (assigneeError.value === 'dispatch.assigneeLimit' && assignees.value.length <= DISPATCH_ASSIGNEE_LIMIT) {
    assigneeError.value = null
  }
}

function resetForm(): void {
  title.value = props.defaultTitle
  typedAssignee.value = ''
  completionMode.value = 'all'
  dueDate.value = ''
  dueTime.value = ''
  formError.value = null
  sentHere.value = false
  // A picker left open when the open-time read replaced the form does not come back with it.
  pickerOpen.value = false
  clearOpenState()
  // Prefill from the first person field that holds an active person; the dispatcher can pick another
  // or none.
  const first = props.personFields.find((field) => activeIds(field).length > 0)
  applyPersonField(first ? first.id : '')
}

/** The form as the create with an unknown outcome sent it (a dialog mounted since), with the names the
 *  picker gave for its people. The controls stay locked; a retry resends the kept body, not these values. */
function restoreSentForm(input: CreateTaskInput | null, names: Record<string, string> | null): void {
  formError.value = null
  assigneeError.value = null
  inactiveSkipped.value = false
  typedAssignee.value = ''
  // Package 1b: no picker over the locked form, and no lookup note or late lookup from another form.
  pickerOpen.value = false
  absentIds.value = new Set()
  noAccessIds.value = new Set()
  accessSkipped.value = 0
  resolveGeneration += 1
  clearOpenState()
  pickedNames.value = names ? { ...names } : {}
  if (!input) return
  title.value = input.title
  personFieldId.value = ''
  assignees.value = input.assignees ? [...input.assignees] : []
  completionMode.value = input.completionMode ?? 'all'
  dueDate.value = input.dueDate ?? ''
  dueTime.value = input.dueTime ?? ''
}

/** A 4xx on screen: its message, and the line about an earlier attempt when the key held one. */
function showFailure(failure: DispatchFailureState): void {
  formError.value = failure.message as MetaRecordLabelKey
  earlierUnresolved.value = failure.earlierUnresolved
}

/** The page size of the open-time list read: the service's largest, so the caller's own tasks are on
 *  it unless the record holds more than that many tasks the caller can open. */
const OPEN_LIST_LIMIT = 100

/**
 * The reads on open (the header comment): first, when this record's retry key holds an attempt with no
 * readable answer and this page holds no body for it, one read of the record's task route under that
 * key for the caller's own live task; then, unless that read found the task or failed, one read of the
 * record's task list for the tasks the caller dispatched from it. Each read is sent only under the
 * page's binding, checked right before it. The key stays unless a task is found under it (that result
 * is then on screen) or 再派一项 is chosen.
 */
async function resolveOnOpen(): Promise<void> {
  const scope = currentScope()
  const ticket = ++resolveTicket
  const client = props.apiClient && typeof props.apiClient.listRecordTasks === 'function' ? props.apiClient : null
  // Whether this read's answer may still be shown: nothing newer on screen, and nothing sent since.
  const current = () => ticket === resolveTicket && props.visible && !identityRefusal.value
    && !run.value?.inFlight && !run.value?.created
  resolving.value = true
  try {
    if (dispatchKeys.isUnresolved(scope)) {
      // `undefined`: the read failed, the service could not tell the session's org, or no key or
      // client to read with.
      let found: string | null | undefined
      let key: string | null = null
      try {
        key = dispatchKeys.obtain(scope).key
      } catch {
        key = null
      }
      if (client && key !== null) {
        if (!verifyIdentity()) return
        try {
          const page = await client.listRecordTasks(scope.sheetId, scope.recordId, { dispatchKey: key })
          found = page.degraded ? undefined : (page.items[0]?.id ?? null)
        } catch {
          found = undefined
        }
      }
      if (!current()) return
      if (found === undefined) {
        earlierUnresolved.value = true
        existingReadFailed.value = true
        return
      }
      if (found !== null) {
        // The read went out under the binding and this key: the task is shown, and the entry released,
        // only while both still hold.
        if (!verifyIdentity()) return
        earlierCreatedId.value = found
        if (key !== null && dispatchKeys.holds(scope, key)) dispatchKeys.release(scope)
        return
      }
      // Kept: a resend from the form is still the same attempt (a task made and since deleted answers
      // as a matched resend that cannot be opened).
      earlierNoTask.value = true
    }
    if (!client) {
      if (current()) existingReadFailed.value = true
      return
    }
    if (!verifyIdentity()) return
    // `undefined`: the read failed, or the service could not tell the session's org.
    let mine: MetaRecordTaskItem[] | undefined
    try {
      const page = await client.listRecordTasks(scope.sheetId, scope.recordId, { limit: OPEN_LIST_LIMIT })
      mine = page.degraded ? undefined : page.items.filter((item) => item.isMine)
    } catch {
      mine = undefined
    }
    if (!current()) return
    if (mine === undefined) existingReadFailed.value = true
    else existingTasks.value = mine
  } finally {
    if (ticket === resolveTicket) resolving.value = false
  }
}

watch(() => props.visible, (open) => {
  if (!open) {
    previouslyFocused?.focus()
    previouslyFocused = null
    resolveTicket += 1
    resolving.value = false
    return
  }
  previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void nextTick(() => modalRef.value?.focus())
  if (!verifyIdentity()) return
  const current = run.value
  // A create for this record is still out: submit stays disabled (it reads the run). The dialog that
  // sent it keeps the dispatcher's form; a dialog mounted since shows the pending note.
  if (current?.inFlight) {
    if (!sentHere.value) resetForm()
    return
  }
  // A task was created and its result has not been on screen yet: show it, not a fresh form.
  if (current?.created && !current.seen) return
  // The last create's outcome is unknown: the form as it was sent, locked, with 重试.
  if (current?.failure?.unknown) {
    if (!sentHere.value) restoreSentForm(current.input, current.pickedNames)
    return
  }
  if (current?.failure) {
    if (!sentHere.value) resetForm()
    showFailure(current.failure)
    forgetDispatchRun(props.runKey)
    return
  }
  forgetDispatchRun(props.runKey)
  resetForm()
  void resolveOnOpen()
}, { immediate: true })

// A result that lands while this dialog is on screen is shown here: a created task's panel counts as
// seen (the next open starts afresh) and its retry key is released, a 4xx becomes the form's message.
// An unknown outcome stays on the run (the form shows it) until a retry is answered.
watch(
  () => [props.visible, run.value?.inFlight, run.value?.created, run.value?.failure] as const,
  ([open]) => {
    const current = run.value
    if (!open || !current || current.inFlight || identityRefusal.value) return
    if (current.created) {
      markDispatchRunSeen(props.runKey)
      // A matched task that cannot be opened keeps its key until 再派一项.
      if (!(current.created.reused && !current.created.openable)) dispatchKeys.release(currentScope())
      return
    }
    // A dialog mounted while the create was out showed the pending note over a fresh form; once the
    // outcome is unknown it shows the form as that create sent it, which is what 重试 resends.
    if (current.failure?.unknown) {
      if (!sentHere.value) restoreSentForm(current.input, current.pickedNames)
      return
    }
    if (current.failure) {
      showFailure(current.failure)
      forgetDispatchRun(props.runKey)
    }
  },
  { immediate: true },
)

const CHECK_MESSAGES: Record<DispatchCheckCode, MetaRecordLabelKey> = {
  TITLE_REQUIRED: 'dispatch.titleRequired',
  INVALID_TITLE: 'dispatch.invalidTitle',
  DUE_DATE_REQUIRED: 'dispatch.dueDateRequired',
  ZONE_UNAVAILABLE: 'dispatch.zoneUnavailable',
  INVALID_DATE: 'dispatch.invalidDate',
  INVALID_TIME_ZONE: 'dispatch.invalidDate',
  TIME_ZONE_REQUIRED: 'dispatch.invalidDate',
  INVALID_ASSIGNEES: 'dispatch.assigneeInvalid',
  LIMIT: 'dispatch.assigneeLimit',
}

const FAILURE_MESSAGES: Record<DispatchFailure, MetaRecordLabelKey> = {
  INACTIVE_ORG_MEMBER: 'dispatch.errorInactiveMember',
  ASSIGNEE_TASK_ACCESS_REQUIRED: 'dispatch.errorAssigneeTaskAccess',
  INVALID_ASSIGNEES: 'dispatch.assigneeInvalid',
  LIMIT: 'dispatch.assigneeLimit',
  ORG_MISSING: 'dispatch.errorOrgMissing',
  FORBIDDEN: 'dispatch.errorForbidden',
  TASKS_UNAVAILABLE: 'dispatch.errorTasksUnavailable',
  INVALID_TITLE: 'dispatch.invalidTitle',
  INVALID_DATE: 'dispatch.invalidDate',
  SOURCE_NOT_READABLE: 'dispatch.errorSourceNotReadable',
  INVALID_DISPATCH_KEY: 'dispatch.errorRejected',
  REJECTED: 'dispatch.errorRejected',
  OUTCOME_UNKNOWN: 'dispatch.outcomeUnknown',
}

/** Whether a task a resend was matched to can be opened: one read of it, sent only under the page's
 *  binding. Only a not-found answer says it cannot (gone, or no longer visible); a refusal or an error
 *  does not, and the task is linked as before. */
async function probeOpenable(taskId: string, binding: DispatchBinding): Promise<boolean> {
  if (!binding.check()) return true
  try {
    const read = await getTask(taskId)
    return read.kind !== 'not_found'
  } catch {
    return true
  }
}

/** Whether a late answer may still change the record's retry-key entry: the identity the request was
 *  sent under still holds (the page binding, which a change marks for good), and the entry still holds
 *  the key the request carried. A session change in this tab clears every entry, so the record may
 *  since hold a newer key, made under another account, that this answer says nothing about. */
function holdsSentKey(scope: DispatchKeyScope, key: string | undefined, binding: DispatchBinding): boolean {
  return binding.check() && key !== undefined && dispatchKeys.holds(scope, key)
}

/** The create. Never throws. `wasUnresolved` and `persisted` are read before the request was sent. */
async function dispatch(
  input: CreateTaskInput,
  scope: DispatchKeyScope,
  wasUnresolved: boolean,
  persisted: boolean,
  binding: DispatchBinding,
): Promise<DispatchOutcome> {
  const unknown: DispatchOutcome = {
    failure: { message: 'dispatch.outcomeUnknown', unknown: true, earlierUnresolved: false, keyNotSaved: !persisted },
  }
  let result: CreateTaskResult
  try {
    // The caller checked the identity in the same synchronous run: `createTask` reaches `apiFetch`,
    // which reads the token and org header, before its first await.
    result = await createTask(input)
  } catch {
    return unknown
  }
  if (result.kind !== 'ok') {
    const failure = classifyDispatchFailure(result)
    if (!isSettledDispatchFailure(failure)) return unknown
    // A 4xx: this request created nothing. It is counted off the record's entry only while that entry
    // is still the one it was counted into (`holdsSentKey`); otherwise the entry is left as it is.
    if (holdsSentKey(scope, input.dispatchKey, binding)) {
      dispatchKeys.markSettled(scope)
      // A key the service refuses has nothing left to match; the next attempt gets a fresh one.
      if (failure === 'INVALID_DISPATCH_KEY') dispatchKeys.release(scope)
    }
    return {
      failure: { message: FAILURE_MESSAGES[failure], unknown: false, earlierUnresolved: wasUnresolved, keyNotSaved: false },
    }
  }
  const sourceLinked = result.sourceLinked !== false
  if (result.reused === true) {
    // Nothing new was made, so the badge has nothing to re-read.
    const openable = await probeOpenable(result.id, binding)
    return { created: { id: result.id, reused: true, openable, sourceLinked, earlierUnresolved: false } }
  }
  try {
    // The top bar's 待办任务 badge re-reads, as after a create on the task page.
    notifyTasksChanged()
  } catch {
    // The task exists either way.
  }
  return {
    created: {
      id: result.id,
      reused: false,
      openable: true,
      sourceLinked,
      // A service that does not store the link never looked the key up, so it says nothing about an
      // earlier attempt under it.
      earlierUnresolved: wasUnresolved && !sourceLinked,
    },
  }
}

async function onSubmit(): Promise<void> {
  // MtButton already drops clicks while it is disabled; this is the handler's own guard.
  if (inFlight.value || resolving.value || resultPanel.value || showExisting.value || identityRefusal.value) return
  const current = run.value
  // A retry of a create with an unknown outcome resends exactly the body it sent, under its key.
  const retryInput = current?.failure?.unknown === true ? current.input : null
  let input: CreateTaskInput
  if (retryInput) {
    input = retryInput
  } else {
    formError.value = null
    const built = buildDispatchCreateInput(
      {
        title: title.value,
        assignees: assignees.value,
        completionMode: completionMode.value,
        dueDate: dueDate.value,
        dueTime: dueTime.value,
      },
      dueDate.value === '' ? '' : usableViewerTimeZone(),
    )
    if (!built.ok) {
      formError.value = CHECK_MESSAGES[built.code]
      return
    }
    input = built.input
  }
  // Captured now: the dialog may be closed, or the drawer moved to another record, before the create
  // settles, and the outcome still belongs to this record and this identity.
  const runKey = props.runKey
  const binding = props.binding
  const scope = currentScope()
  const viewId = props.viewId
  // The identity the create will carry, read right before it is sent: nothing below awaits before
  // `apiFetch` reads the token and org header.
  if (!verifyIdentity()) return
  if (!retryInput) {
    // Before the run starts: a key that cannot be made leaves no run behind and sends nothing.
    let key: string
    try {
      key = dispatchKeys.obtain(scope).key
    } catch {
      formError.value = 'dispatch.errorNotSent'
      return
    }
    // Ids only, and no base id: the service checks a sent base id against the sheet, and the drawer's
    // base id is the workbench's, which can trail a sheet opened from elsewhere; the task page links
    // back through the sheet and view. The inspector shows 派发任务 only when each id is one the
    // service takes as a source (`dispatchSourceUsable`).
    const source = viewId
      ? { sheetId: scope.sheetId, recordId: scope.recordId, viewId }
      : { sheetId: scope.sheetId, recordId: scope.recordId }
    input = { ...input, source, dispatchKey: key }
  }
  // The picker's names for the people sent go with the run, for a dialog mounted since (never sent).
  const sentNames = Object.fromEntries((input.assignees ?? [])
    .filter((id) => pickedNames.value[id])
    .map((id) => [id, pickedNames.value[id]]))
  const ticket = beginDispatchRun(runKey, binding.identity, input, sentNames)
  if (ticket === null) return
  formError.value = null
  clearOpenState()
  // Read before the send: whether the key already held an attempt with no readable answer.
  const wasUnresolved = dispatchKeys.isUnresolved(scope)
  // Counted as sent before the request leaves, so a reload while it is out still finds it.
  const { persisted } = dispatchKeys.markSent(scope)
  sentHere.value = true
  settleDispatchRun(runKey, ticket, await dispatch(input, scope, wasUnresolved, persisted, binding))
  // A change while the create was out turns this dialog to the refusal, not to the other identity's
  // view of a task it did not create.
  verifyIdentity()
}

/** 再派一项: a deliberate second dispatch from this record, always under a fresh key. */
function onAnother(): void {
  if (inFlight.value || identityRefusal.value) return
  dispatchKeys.release(currentScope())
  forgetDispatchRun(props.runKey)
  resetForm()
  // The button goes with the panel or list it belonged to: focus moves to the dialog, as on open.
  void nextTick(() => modalRef.value?.focus())
}

function onCancel(): void {
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // An Escape the input method may be using cancels the composition, not the dialog; it still goes
    // no further, so nothing around the dialog closes on it either.
    if (isInputMethodKey(event)) {
      event.stopPropagation()
      return
    }
    event.preventDefault()
    // The inspector's own Escape handler closes the whole drawer; Esc in a modal closes the modal only.
    event.stopPropagation()
    emit('close')
    return
  }
  // Enter in the user-id box adds the typed ids. Handled here, not by a listener on the box: Vue
  // skips a later listener attached in the millisecond an event was first stamped (see the people
  // picker's onPanelKeydown), so one on the box would let an Esc or Tab there skip this handler.
  if (event.key === 'Enter' && event.target === typedInputRef.value) {
    // An Enter that commits a composition adds nothing: the box's model does not hold the composed
    // text until the composition ends.
    if (isInputMethodKey(event)) return
    event.preventDefault()
    onAddTyped()
    return
  }
  // Every Tab is moved here, wrapping inside the dialog, a date or time input's own parts and a Tab
  // the input method took aside (see tasks/focusTrap.ts).
  if (event.key === 'Tab' && modalRef.value) moveFocusWithin(modalRef.value, event)
}
</script>

<style scoped>
.meta-dispatch-overlay { position: fixed; inset: 0; z-index: 110; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
.meta-dispatch-modal { background: #fff; border-radius: 6px; min-width: 420px; max-width: 540px; box-shadow: 0 10px 40px rgba(0,0,0,.18); display: flex; flex-direction: column; max-height: 80vh; }
.meta-dispatch__header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #ebedf0; }
.meta-dispatch__body { padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
.meta-dispatch__row { display: flex; flex-direction: column; gap: 6px; }
.meta-dispatch__row--due { flex-direction: row; gap: 12px; }
.meta-dispatch__due { display: flex; flex-direction: column; gap: 6px; flex: 1; }
.meta-dispatch__inline { display: flex; align-items: center; gap: 8px; }
.meta-dispatch__label { font-size: 12px; color: #909399; }
.meta-dispatch__sublabel { font-size: 12px; color: #909399; white-space: nowrap; }
.meta-dispatch__required { color: #f56c6c; margin-left: 2px; }
.meta-dispatch__control { border: 1px solid #dcdfe6; border-radius: 4px; padding: 6px 8px; font-size: 14px; min-width: 0; flex: 1; }
.meta-dispatch__chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.meta-dispatch__chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; background: #f4f4f5; font-size: 13px; }
.meta-dispatch__chip-note { color: #909399; font-size: 12px; }
.meta-dispatch__link-button { border: none; background: none; padding: 0; font-size: 12px; color: var(--ms-color-primary, #409eff); cursor: pointer; }
.meta-dispatch__chip-remove { border: none; background: transparent; cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; }
.meta-dispatch__hint { font-size: 13px; margin: 0; color: #909399; }
.meta-dispatch__hint--warn { color: #e6a23c; }
.meta-dispatch__success { margin: 0; font-size: 14px; }
.meta-dispatch__link { margin-left: 8px; color: var(--ms-color-primary, #409eff); }
.meta-dispatch__existing { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.meta-dispatch__existing .meta-dispatch__link { margin-left: 0; overflow-wrap: anywhere; }
.meta-dispatch__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #ebedf0; }
/* Narrow screens: the dialog drops its fixed minimum and fits the viewport with a 16px gutter on
   each side; the due date and time stack. Nothing changes above the breakpoint. */
@media (max-width: 480px) {
  .meta-dispatch-overlay { padding: 0 16px; }
  .meta-dispatch-modal { min-width: 0; width: 100%; max-width: calc(100vw - 32px); box-sizing: border-box; }
  .meta-dispatch__row--due { flex-direction: column; }
}
</style>
