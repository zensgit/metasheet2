<!--
  派发任务 / Dispatch a task from a record (owner ruling R-45 step 1).

  From the record drawer's kebab: confirm a title, pick assignees, a completion mode and a due date,
  and a REAL task is created in the task centre through the same `createTask` wrapper the task create
  form uses (`POST /api/tasks`). A second write then puts one plain line naming the source record into
  the task description through the task edit path (`PATCH /api/tasks/:id` with `expectedVersion`). When
  only that second write fails, the task still exists: the dialog reports the task as created and adds
  a note, it never reports a failure for a task that was made.

  STRUCTURE: the same shape as MetaRecordApprovalSubmitDialog.vue — Teleport + overlay + `role="dialog"`
  with a backed `aria-modal` (focus in on open, Tab trapped, Esc closes only this dialog, focus back to
  the opener on close).

  DOUBLE CREATE: the state of a dispatch (in flight / created / failed) is kept per record OUTSIDE
  this component (tasks/recordTaskDispatchRuns.ts, keyed by `runKey`), because the dialog can be
  closed (取消 / × / Esc / overlay) or unmounted (the drawer moves to another record) while a create
  is out. Any dialog for the same record then sees the create still out (submit disabled, no second
  create) or the task it produced (the success panel and its link, not a blank form). Submit is also
  disabled from the first click until both writes settle, and gone once the task exists. The record
  link is captured when submit is clicked, so a late source-line write always names the record the
  task was created from.

  IDENTITY: the dialog sends only under the page's binding (`binding`, tasks/recordTaskDispatchIdentity.ts):
  the signed-in user and org the page was set up under, marked changed for good the first time any
  other identity is seen (before any multitable request of the page, on a storage change or a session
  switch, or by this dialog). The dialog checks it again on open, right before the create (with no
  await between that check and the send) and right before each read/write of the description step.
  Once the binding is changed nothing more is sent, the draft is cleared and the dialog shows a plain
  refusal instead of a form until the page is reloaded, as does any dialog opened after it.

  WHAT LEAVES THE RECORD: the title the dispatcher sees and confirms (prefilled from the primary
  field's display text), the user ids they confirm (prefilled from a person field they choose), and the
  record's deep link (ids only). The dialog never reads `record.data` itself; the parent hands it only
  those values.
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

        <div v-else-if="created" class="meta-dispatch__body" data-testid="record-task-dispatch-success">
          <p class="meta-dispatch__success" role="status">
            {{ l('dispatch.success') }}
            <RouterLink
              v-if="hasRouter"
              class="meta-dispatch__link"
              data-testid="record-task-dispatch-open-task"
              :to="taskPath(created.id)"
            >{{ l('dispatch.openTask') }}</RouterLink>
            <a
              v-else
              class="meta-dispatch__link"
              data-testid="record-task-dispatch-open-task"
              :href="taskPath(created.id)"
            >{{ l('dispatch.openTask') }}</a>
          </p>
          <p
            v-if="created.sourceNoteFailed"
            class="meta-dispatch__hint meta-dispatch__hint--warn"
            data-testid="record-task-dispatch-source-note-failed"
          >{{ l('dispatch.sourceNoteFailed') }}</p>
        </div>

        <div v-else-if="pendingElsewhere" class="meta-dispatch__body" data-testid="record-task-dispatch-pending">
          <p class="meta-dispatch__hint" role="status">{{ l('dispatch.pendingElsewhere') }}</p>
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
            <ul v-if="assignees.length > 0" class="meta-dispatch__chips" data-testid="record-task-dispatch-assignees">
              <li
                v-for="id in assignees"
                :key="id"
                class="meta-dispatch__chip"
                :data-assignee-id="id"
              >
                <span>{{ assigneeDisplay(id) }}</span>
                <span v-if="isInactive(id)" class="meta-dispatch__chip-note">（{{ l('dispatch.assigneeInactive') }}）</span>
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
            <div class="meta-dispatch__inline">
              <label class="meta-dispatch__sublabel" :for="controlId('assignee-input')">{{ l('dispatch.assigneeInputLabel') }}</label>
              <input
                :id="controlId('assignee-input')"
                v-model="typedAssignee"
                type="text"
                class="meta-dispatch__control"
                data-testid="record-task-dispatch-assignee-input"
                :placeholder="l('dispatch.assigneeInputPlaceholder')"
                :disabled="submitting"
                @keydown.enter.prevent="onAddTyped"
              />
              <MtButton size="sm" data-testid="record-task-dispatch-assignee-add" :disabled="submitting" @click="onAddTyped">{{ l('dispatch.assigneeAdd') }}</MtButton>
            </div>
            <p
              v-if="assigneeError"
              class="meta-dispatch__hint meta-dispatch__hint--warn"
              role="alert"
              data-testid="record-task-dispatch-assignee-error"
            >{{ l(assigneeError) }}</p>
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
            v-if="formError"
            class="meta-dispatch__hint meta-dispatch__hint--warn"
            role="alert"
            data-testid="record-task-dispatch-error"
          >{{ l(formError) }}</p>
        </div>

        <div class="meta-dispatch__actions">
          <MtButton class="meta-dispatch__btn" data-testid="record-task-dispatch-cancel" @click="onCancel">{{ created && !identityRefusal ? l('dispatch.done') : l('dispatch.cancel') }}</MtButton>
          <MtButton
            v-if="!created && !identityRefusal"
            variant="primary"
            class="meta-dispatch__btn"
            data-testid="record-task-dispatch-submit"
            :disabled="submitting"
            @click="onSubmit"
          >{{ submitting ? l('dispatch.submitting') : l('dispatch.submit') }}</MtButton>
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
import { recordLabel, type MetaRecordLabelKey } from '../utils/meta-record-labels'
import { TASKS_EN, TASKS_ZH } from '../../tasks/labels'
import { createTask, getTask, patchTask, type CompletionMode, type CreateTaskInput } from '../../tasks/tasksApi'
import { usableViewerTimeZone } from '../../tasks/tasksDraft'
import { notifyTasksChanged } from '../../tasks/tasksBadgeBus'
import { NO_DISPATCH_IDENTITY, type DispatchBinding } from '../../tasks/recordTaskDispatchIdentity'
import {
  beginDispatchRun,
  forgetDispatchRun,
  markDispatchRunSeen,
  readDispatchRun,
  settleDispatchRun,
  type DispatchOutcome,
} from '../../tasks/recordTaskDispatchRuns'
import {
  DISPATCH_ASSIGNEE_LIMIT,
  addAssignees,
  buildDispatchCreateInput,
  buildSourceLine,
  classifyDispatchFailure,
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
  /** The record's deep link (ids only), written into the task description after the create. */
  recordLink: string
  /** The page's binding: the signed-in user and org it was set up under, and whether another has been seen. */
  binding: DispatchBinding
  /** The record's dispatch-state key under that identity (`dispatchRunKey(binding.identity, sheetId, recordId)`). */
  runKey: string
}>(), {
  personFields: () => [],
  personSummaries: () => ({}),
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
const completionMode = ref<CompletionMode>('all')
const dueDate = ref('')
const dueTime = ref('')
const assigneeError = ref<MetaRecordLabelKey | null>(null)
const formError = ref<MetaRecordLabelKey | null>(null)
const inactiveSkipped = ref(false)
// This record's dispatch state lives outside the component (see the header comment).
const run = computed(() => readDispatchRun(props.runKey))
const submitting = computed(() => run.value?.inFlight === true)
const created = computed(() => run.value?.created ?? null)
// Whether THIS dialog's form sent the create that is out. A dialog mounted later for the same record
// has a form that was never sent, so it shows a pending note instead of that form.
const sentHere = ref(false)
const pendingElsewhere = computed(() => submitting.value && !sentHere.value)
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
  return summaryById.value.get(id)?.display || id
}

function isInactive(id: string): boolean {
  return summaryById.value.get(id)?.inactive === true
}

function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`
}

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
  const field = props.personFields.find((entry) => entry.id === fieldId)
  const ids = activeIds(field)
  inactiveSkipped.value = field !== undefined && ids.length < field.ids.length
  if (ids.length > DISPATCH_ASSIGNEE_LIMIT) {
    assignees.value = ids.slice(0, DISPATCH_ASSIGNEE_LIMIT)
    assigneeError.value = 'dispatch.assigneeLimit'
    return
  }
  assignees.value = [...ids]
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
  // Prefill from the first person field that holds an active person; the dispatcher can pick another
  // or none.
  const first = props.personFields.find((field) => activeIds(field).length > 0)
  applyPersonField(first ? first.id : '')
}

watch(() => props.visible, (open) => {
  if (!open) {
    previouslyFocused?.focus()
    previouslyFocused = null
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
  if (current?.failure) {
    if (!sentHere.value) resetForm()
    formError.value = current.failure as MetaRecordLabelKey
    forgetDispatchRun(props.runKey)
    return
  }
  forgetDispatchRun(props.runKey)
  resetForm()
}, { immediate: true })

// A result that lands while this dialog is on screen is shown here: a created task's panel counts as
// seen (the next open starts afresh), a failure becomes the form's message.
watch(
  () => [props.visible, run.value?.inFlight, run.value?.created, run.value?.failure] as const,
  ([open]) => {
    const current = run.value
    if (!open || !current || current.inFlight || identityRefusal.value) return
    if (current.created) {
      markDispatchRunSeen(props.runKey)
      return
    }
    if (current.failure) {
      formError.value = current.failure as MetaRecordLabelKey
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
  FAILED: 'dispatch.errorFailed',
}

/** The second write: one source line into the new task's description. `false` when it did not land,
 *  or was not sent because the page's binding has changed since the create (each check sits right
 *  before its send, with no await between). `recordLink` and `binding` are the ones captured when
 *  submit was clicked, not the current props. */
async function writeSourceLine(
  taskId: string,
  version: number | undefined,
  recordLink: string,
  binding: DispatchBinding,
): Promise<boolean> {
  let expectedVersion = version
  if (expectedVersion === undefined) {
    if (!binding.check()) return false
    const read = await getTask(taskId)
    expectedVersion = read.kind === 'ok' ? read.task.version : undefined
  }
  if (expectedVersion === undefined) return false
  const description = buildSourceLine(l('dispatch.sourceLinePrefix'), recordLink)
  if (!binding.check()) return false
  const patched = await patchTask(taskId, { expectedVersion, description })
  return patched.kind === 'ok'
}

/** Both writes. Never throws: a create that fails is a failure message; a create that succeeds is a
 *  created task, with a note when only the second write did not land. */
async function dispatch(input: CreateTaskInput, recordLink: string, binding: DispatchBinding): Promise<DispatchOutcome> {
  let taskId: string | null = null
  try {
    // The caller checked the identity in the same synchronous run: `createTask` reaches `apiFetch`,
    // which reads the token and org header, before its first await.
    const result = await createTask(input)
    if (result.kind !== 'ok') return { failure: FAILURE_MESSAGES[classifyDispatchFailure(result)] }
    taskId = result.id
    // The top bar's 待办任务 badge re-reads, as after a create on the task page.
    notifyTasksChanged()
    let sourceWritten = false
    try {
      sourceWritten = await writeSourceLine(result.id, result.version, recordLink, binding)
    } catch {
      sourceWritten = false
    }
    return { created: { id: result.id, sourceNoteFailed: !sourceWritten } }
  } catch {
    return taskId === null
      ? { failure: 'dispatch.errorFailed' }
      : { created: { id: taskId, sourceNoteFailed: true } }
  }
}

async function onSubmit(): Promise<void> {
  // MtButton already drops clicks while it is disabled; this is the handler's own guard.
  if (submitting.value || created.value || identityRefusal.value) return
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
  // Captured now: the dialog may be closed, or the drawer moved to another record, before the
  // writes settle, and the outcome still belongs to this record and this identity.
  const runKey = props.runKey
  const recordLink = props.recordLink
  const binding = props.binding
  // The identity the create will carry, read right before it is sent: nothing below awaits before
  // `apiFetch` reads the token and org header.
  if (!verifyIdentity()) return
  const ticket = beginDispatchRun(runKey, binding.identity)
  if (ticket === null) return
  sentHere.value = true
  settleDispatchRun(runKey, ticket, await dispatch(built.input, recordLink, binding))
  // A change while the writes were out turns this dialog to the refusal, not to the other identity's
  // view of a task it did not create.
  verifyIdentity()
}

function onCancel(): void {
  emit('close')
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    // The inspector's own Escape handler closes the whole drawer; Esc in a modal closes the modal only.
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const modal = modalRef.value
  if (!modal) return
  const focusable = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  if (focusable.length === 0) {
    event.preventDefault()
    modal.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  const activeInModal = active instanceof HTMLElement && modal.contains(active) && active !== modal
  if (event.shiftKey) {
    if (!activeInModal || active === first) {
      event.preventDefault()
      last.focus()
    }
  } else if (!activeInModal || active === last) {
    event.preventDefault()
    first.focus()
  }
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
.meta-dispatch__chip-remove { border: none; background: transparent; cursor: pointer; padding: 0 2px; font-size: 14px; line-height: 1; }
.meta-dispatch__hint { font-size: 13px; margin: 0; color: #909399; }
.meta-dispatch__hint--warn { color: #e6a23c; }
.meta-dispatch__success { margin: 0; font-size: 14px; }
.meta-dispatch__link { margin-left: 8px; color: var(--ms-color-primary, #409eff); }
.meta-dispatch__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #ebedf0; }
/* Narrow screens: the dialog drops its fixed minimum and fits the viewport with a 16px gutter on
   each side; the due date and time stack. Nothing changes above the breakpoint. */
@media (max-width: 480px) {
  .meta-dispatch-overlay { padding: 0 16px; }
  .meta-dispatch-modal { min-width: 0; width: 100%; max-width: calc(100vw - 32px); box-sizing: border-box; }
  .meta-dispatch__row--due { flex-direction: column; }
}
</style>
