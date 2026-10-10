<template>
  <section
    ref="root"
    class="tasks-detail-editor"
    data-testid="tasks-detail-editor"
    :data-phase="phase"
    aria-labelledby="tasks-detail-editor-heading"
  >
    <h3 id="tasks-detail-editor-heading" tabindex="-1" data-testid="tasks-detail-editor-heading">{{ t.editorHeading }}</h3>
    <p v-if="conflictMessage" class="tasks-detail-editor__notice" data-testid="tasks-detail-editor-conflict" role="alert">
      {{ conflictMessage }}
    </p>
    <p v-else-if="serverUpdated" class="tasks-detail-editor__notice" data-testid="tasks-detail-editor-server-updated" role="status">
      {{ t.editorServerUpdated }}
    </p>

    <form
      class="tasks-detail-editor__form"
      data-testid="tasks-detail-editor-form"
      novalidate
      :aria-busy="pending ? 'true' : 'false'"
      @submit.prevent="onSubmit"
    >
      <div class="tasks-detail-editor__field">
        <label for="tasks-detail-editor-title">{{ t.editorTitleLabel }}</label>
        <input
          id="tasks-detail-editor-title"
          type="text"
          autocomplete="off"
          aria-required="true"
          data-testid="tasks-detail-editor-title"
          :value="draft.title"
          :disabled="pending"
          :aria-invalid="fieldErrors.title ? 'true' : undefined"
          :aria-describedby="fieldErrors.title ? 'tasks-detail-editor-title-error' : undefined"
          @input="onText('title', $event)"
        />
        <p
          v-if="fieldErrors.title"
          id="tasks-detail-editor-title-error"
          class="tasks-detail-editor__error"
          data-testid="tasks-detail-editor-title-error"
          role="alert"
        >{{ codeMessage(fieldErrors.title, t) }}</p>
      </div>

      <div class="tasks-detail-editor__field">
        <label for="tasks-detail-editor-description">{{ t.editorDescriptionLabel }}</label>
        <!-- No `maxlength`: it counts UTF-16 units, the limit counts code points (the counter and
             the pre-check below). -->
        <textarea
          id="tasks-detail-editor-description"
          data-testid="tasks-detail-editor-description"
          :value="draft.description"
          :disabled="pending"
          :aria-invalid="fieldErrors.description ? 'true' : undefined"
          :aria-describedby="describedBy('tasks-detail-editor-description-count', fieldErrors.description ? 'tasks-detail-editor-description-error' : null)"
          @input="onText('description', $event)"
        ></textarea>
        <p id="tasks-detail-editor-description-count" class="tasks-detail-editor__note" data-testid="tasks-detail-editor-description-count">
          {{ fmt.descriptionCount(descriptionLength, TASK_DESCRIPTION_MAX_CODEPOINTS) }}
        </p>
        <p
          v-if="fieldErrors.description"
          id="tasks-detail-editor-description-error"
          class="tasks-detail-editor__error"
          data-testid="tasks-detail-editor-description-error"
          role="alert"
        >{{ codeMessage(fieldErrors.description, t) }}</p>
      </div>

      <div v-for="pair in DATE_PAIRS" :key="pair.date" class="tasks-detail-editor__field">
        <label :for="`tasks-detail-editor-${pair.testid}-date`">{{ t[pair.dateLabel] }}</label>
        <input
          :id="`tasks-detail-editor-${pair.testid}-date`"
          type="date"
          :data-testid="`tasks-detail-editor-${pair.testid}-date`"
          :value="draft[pair.date] ?? ''"
          :disabled="pending"
          :aria-invalid="fieldErrors[pair.date] ? 'true' : undefined"
          :aria-describedby="fieldErrors[pair.date] ? `tasks-detail-editor-${pair.testid}-date-error` : undefined"
          @change="onDate(pair.date, $event)"
        />
        <label :for="`tasks-detail-editor-${pair.testid}-time`">{{ t[pair.timeLabel] }}</label>
        <input
          :id="`tasks-detail-editor-${pair.testid}-time`"
          type="time"
          step="60"
          :data-testid="`tasks-detail-editor-${pair.testid}-time`"
          :value="draft[pair.time] ?? ''"
          :disabled="pending"
          :aria-invalid="fieldErrors[pair.time] ? 'true' : undefined"
          :aria-describedby="fieldErrors[pair.time] ? `tasks-detail-editor-${pair.testid}-time-error` : undefined"
          @change="onTime(pair.time, $event)"
        />
        <p
          v-if="fieldErrors[pair.date]"
          :id="`tasks-detail-editor-${pair.testid}-date-error`"
          class="tasks-detail-editor__error"
          :data-testid="`tasks-detail-editor-${pair.testid}-date-error`"
          role="alert"
        >{{ codeMessage(fieldErrors[pair.date] ?? '', t) }}</p>
        <p
          v-if="fieldErrors[pair.time]"
          :id="`tasks-detail-editor-${pair.testid}-time-error`"
          class="tasks-detail-editor__error"
          :data-testid="`tasks-detail-editor-${pair.testid}-time-error`"
          role="alert"
        >{{ codeMessage(fieldErrors[pair.time] ?? '', t) }}</p>
      </div>

      <div class="tasks-detail-editor__field">
        <label for="tasks-detail-editor-time-zone">{{ t.editorTimeZoneLabel }}</label>
        <input
          id="tasks-detail-editor-time-zone"
          type="text"
          autocomplete="off"
          list="tasks-detail-editor-time-zone-options"
          data-testid="tasks-detail-editor-time-zone"
          :value="draft.timeZone"
          :placeholder="t.editorTimeZonePlaceholder"
          :disabled="pending"
          :aria-invalid="fieldErrors.timeZone ? 'true' : undefined"
          :aria-describedby="fieldErrors.timeZone ? 'tasks-detail-editor-time-zone-error' : undefined"
          @input="onTimeZoneInput"
        />
        <button
          type="button"
          data-testid="tasks-detail-editor-use-browser-zone"
          :disabled="pending || browserZone === ''"
          @click="onUseBrowserZone"
        >{{ t.editorUseBrowserTimeZone }}</button>
        <datalist id="tasks-detail-editor-time-zone-options" data-testid="tasks-detail-editor-time-zone-options">
          <option v-for="option in timeZoneOptions" :key="option.value" :value="option.value" :label="option.label" />
        </datalist>
        <p
          v-if="fieldErrors.timeZone"
          id="tasks-detail-editor-time-zone-error"
          class="tasks-detail-editor__error"
          data-testid="tasks-detail-editor-time-zone-error"
          role="alert"
        >{{ codeMessage(fieldErrors.timeZone, t) }}</p>
      </div>

      <fieldset class="tasks-detail-editor__field" data-testid="tasks-detail-editor-reminder">
        <legend>{{ t.editorReminderLegend }}</legend>
        <label class="tasks-detail-editor__choice">
          <input
            type="radio"
            name="tasks-detail-editor-reminder"
            value="none"
            data-testid="tasks-detail-editor-remind-none"
            :checked="draft.remindAt === null"
            :disabled="pending"
            @change="onReminderMode('none')"
          />
          {{ t.editorReminderNone }}
        </label>
        <label class="tasks-detail-editor__choice">
          <input
            type="radio"
            name="tasks-detail-editor-reminder"
            value="at"
            data-testid="tasks-detail-editor-remind-at"
            :checked="draft.remindAt !== null"
            :disabled="pending"
            @change="onReminderMode('at')"
          />
          {{ t.editorReminderAt }}
        </label>
        <template v-if="draft.remindAt !== null">
          <label for="tasks-detail-editor-remind-at-input">{{ t.editorReminderTimeLabel }}</label>
          <input
            id="tasks-detail-editor-remind-at-input"
            type="datetime-local"
            data-testid="tasks-detail-editor-remind-at-input"
            :value="reminderInputValue"
            :disabled="pending"
            :aria-invalid="fieldErrors.remindAt ? 'true' : undefined"
            :aria-describedby="fieldErrors.remindAt ? 'tasks-detail-editor-remind-at-error' : undefined"
            @change="onReminderInput"
          />
        </template>
        <p v-if="reminderNotFollowing" class="tasks-detail-editor__note" data-testid="tasks-detail-editor-remind-hint" role="status">
          {{ t.editorReminderNotFollowing }}
        </p>
        <p
          v-if="fieldErrors.remindAt"
          id="tasks-detail-editor-remind-at-error"
          class="tasks-detail-editor__error"
          data-testid="tasks-detail-editor-remind-at-error"
          role="alert"
        >{{ codeMessage(fieldErrors.remindAt, t) }}</p>
      </fieldset>

      <div class="tasks-detail-editor__actions">
        <button type="submit" data-testid="tasks-detail-editor-submit" :disabled="pending || patch === null">{{ t.save }}</button>
        <button
          v-if="patch !== null || phase === 'conflict'"
          type="button"
          data-testid="tasks-detail-editor-discard"
          :disabled="pending"
          @click="onDiscard"
        >{{ t.editorDiscard }}</button>
        <p v-if="fieldErrors.form" class="tasks-detail-editor__error" data-testid="tasks-detail-editor-error" role="alert">
          {{ codeMessage(fieldErrors.form, t) }}
        </p>
      </div>
    </form>
  </section>
</template>

<script lang="ts">
import { buildTimezoneOptions, type TimezoneOption } from '../../utils/timezones'

// Module scope, shared by every editor instance: the zone candidates are built once per browser
// zone (the editor is re-created on every reload of the task).
let zoneOptionsCache: { zone: string; options: TimezoneOption[] } | null = null

/** The zone input's candidates, the given browser zone first; none when they cannot be built. */
function zoneOptionsFor(browserZone: string): TimezoneOption[] {
  if (zoneOptionsCache !== null && zoneOptionsCache.zone === browserZone) return zoneOptionsCache.options
  let options: TimezoneOption[] = []
  try {
    options = buildTimezoneOptions(browserZone ? [browserZone] : [])
  } catch {
    options = []
  }
  zoneOptionsCache = { zone: browserZone, options }
  return options
}
</script>

<script setup lang="ts">
/**
 * The `/tasks/:id` editor (design §4.3, §7.2, §7.3; backend `PATCH /api/tasks/:id`, PR-3a S4).
 *
 * Stateless (`[fe-15]`): the draft, the pre-check and server error codes, the phase and the
 * version a 409 reported all live in TasksView's editor state and arrive as props. Every edit
 * emits a new draft (`update:draft`); submitting emits the changed keys (`submit`) and the parent
 * runs the pre-checks and the request on its shared detail-action token; `discard` asks the
 * parent to reset the draft to the task's current values. Nothing here sends a request.
 *
 * Control rules:
 *   - the controls hold the draft's canonical form (`[fe-17]`): times `'HH:MM'` — a time control
 *     that reports seconds is cut to minutes — and `''` from a cleared date / time control is
 *     `null`;
 *   - clearing a date clears its time too (the server rejects a time without its date);
 *   - the first date on a task without a zone takes the browser's zone ([own-07] below);
 *   - touching the reminder (either choice, or the time) marks it touched; only a touched reminder
 *     enters the request, and a changed due date with an untouched reminder shows that the
 *     reminder does not follow it ([own-06]);
 *   - the reminder time is entered in the browser's local time and kept as `Date#toISOString()`;
 *     choosing "at a set time" without a time leaves `''`, which the pre-check reports;
 *   - the submit button is disabled while an action is pending or nothing differs;
 *   - when an inline error appears, focus moves to the control it belongs to;
 *   - "discard my changes" takes its own button away (the draft is clean after it), so focus
 *     moves to the editor's heading (`[fe-50]`).
 */
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { TASKS_EN, TASKS_FMT_EN, TASKS_FMT_ZH, TASKS_ZH, codeMessage, type TasksText } from '../../tasks/labels'
import { resolveViewerTimeZone, type TaskDetail, type TaskPatch } from '../../tasks/tasksApi'
import { focusAfterSwap } from '../../tasks/tasksFocus'
import {
  TASK_DESCRIPTION_MAX_CODEPOINTS,
  buildTaskPatch,
  isValidTimeZoneName,
  type EditorErrorSlot,
  type EditorPhase,
  type TaskDraft,
} from '../../tasks/tasksDraft'

const props = defineProps<{
  task: TaskDetail
  draft: TaskDraft
  phase: EditorPhase
  conflictVersion: number | null
  fieldErrors: Partial<Record<EditorErrorSlot, string>>
  serverUpdated: boolean
  pending: boolean
}>()

const emit = defineEmits<{
  (event: 'update:draft', draft: TaskDraft): void
  (event: 'submit', patch: TaskPatch): void
  (event: 'discard'): void
}>()

const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))
const fmt = computed(() => (isZh.value ? TASKS_FMT_ZH : TASKS_FMT_EN))

const root = ref<HTMLElement | null>(null)

type DateField = 'dueDate' | 'startDate'
type TimeField = 'dueTime' | 'startTime'

const DATE_PAIRS: ReadonlyArray<{
  date: DateField
  time: TimeField
  testid: 'due' | 'start'
  dateLabel: keyof TasksText
  timeLabel: keyof TasksText
}> = [
  { date: 'dueDate', time: 'dueTime', testid: 'due', dateLabel: 'editorDueDateLabel', timeLabel: 'editorDueTimeLabel' },
  { date: 'startDate', time: 'startTime', testid: 'start', dateLabel: 'editorStartDateLabel', timeLabel: 'editorStartTimeLabel' },
]

/** The control each inline error moves focus to, in the order the form shows them. */
const FOCUS_TARGETS: ReadonlyArray<[EditorErrorSlot, string]> = [
  ['title', 'tasks-detail-editor-title'],
  ['description', 'tasks-detail-editor-description'],
  ['dueDate', 'tasks-detail-editor-due-date'],
  ['dueTime', 'tasks-detail-editor-due-time'],
  ['startDate', 'tasks-detail-editor-start-date'],
  ['startTime', 'tasks-detail-editor-start-time'],
  ['timeZone', 'tasks-detail-editor-time-zone'],
  ['remindAt', 'tasks-detail-editor-remind-at-input'],
]

/** The changed keys, or `null` when the draft equals the task's values. */
const patch = computed(() => buildTaskPatch(props.task, props.draft))

const descriptionLength = computed(() => Array.from(props.draft.description).length)

const conflictMessage = computed<string | null>(() => {
  if (props.phase !== 'conflict') return null
  return props.conflictVersion !== null ? fmt.value.versionConflict(props.conflictVersion) : t.value.versionConflictUnknown
})

// ASSUMPTION(task-m4-fe): [own-06] (PR-3a) — a PATCH never derives the reminder; changing the due
// date leaves it where it is.
const reminderNotFollowing = computed(() => {
  const changes = patch.value
  return changes !== null && ('dueDate' in changes || 'dueTime' in changes) && !props.draft.remindTouched
})

/** The browser's zone when it is a usable IANA name, `''` otherwise. */
function usableBrowserZone(): string {
  const zone = resolveViewerTimeZone()
  return isValidTimeZoneName(zone) ? zone : ''
}

const browserZone = usableBrowserZone()

const timeZoneOptions: TimezoneOption[] = zoneOptionsFor(browserZone)

function describedBy(...ids: Array<string | null>): string | undefined {
  const present = ids.filter((id): id is string => id !== null)
  return present.length > 0 ? present.join(' ') : undefined
}

function update(changes: Partial<TaskDraft>): void {
  emit('update:draft', { ...props.draft, ...changes })
}

function onText(field: 'title' | 'description', event: Event): void {
  update({ [field]: (event.target as HTMLInputElement | HTMLTextAreaElement).value })
}

const CLOCK_WITH_SECONDS_RE = /^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/

/** A time control's value in the draft's minutes form; `''` is `null`. */
function clockMinutes(value: string): string | null {
  if (value === '') return null
  return CLOCK_WITH_SECONDS_RE.test(value) ? value.slice(0, 5) : value
}

// ASSUMPTION(task-m4-fe): [own-07] (PR-3a) — a date needs a zone, so the first date on a task
// without one takes the browser's zone; clearing a date sends its time as null too.
function onDate(field: DateField, event: Event): void {
  const value = (event.target as HTMLInputElement).value
  const date = value === '' ? null : value
  const changes: Partial<TaskDraft> = { [field]: date }
  if (date === null) changes[field === 'dueDate' ? 'dueTime' : 'startTime'] = null
  if (date !== null && props.draft.timeZone.trim() === '' && browserZone !== '') changes.timeZone = browserZone
  update(changes)
}

function onTime(field: TimeField, event: Event): void {
  update({ [field]: clockMinutes((event.target as HTMLInputElement).value) })
}

function onTimeZoneInput(event: Event): void {
  update({ timeZone: (event.target as HTMLInputElement).value })
}

function onUseBrowserZone(): void {
  if (browserZone !== '') update({ timeZone: browserZone })
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/** An ISO instant as a `datetime-local` value in the browser's local time; `''` for a value that
 *  is not an instant. */
function localInputValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const LOCAL_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/

/** A `datetime-local` value (the browser's local time) as `Date#toISOString()`; `''` when the
 *  control holds no complete value. */
function isoFromLocalInput(value: string): string {
  const match = LOCAL_INPUT_RE.exec(value)
  if (!match) return ''
  const date = new Date(0)
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  date.setHours(Number(match[4]), Number(match[5]), Number(match[6] ?? '0'), 0)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

const reminderInputValue = computed(() => (props.draft.remindAt ? localInputValue(props.draft.remindAt) : ''))

function onReminderMode(mode: 'none' | 'at'): void {
  if (mode === 'none') {
    update({ remindAt: null, remindTouched: true })
    return
  }
  if (props.draft.remindAt === null) update({ remindAt: '', remindTouched: true })
}

function onReminderInput(event: Event): void {
  update({ remindAt: isoFromLocalInput((event.target as HTMLInputElement).value), remindTouched: true })
}

function onDiscard(): void {
  emit('discard')
  void focusAfterSwap(() => root.value, 'tasks-detail-editor-heading')
}

// The parent's handler is where one-action-at-a-time is enforced (and the submit button is
// disabled while an action is pending); this only keeps an unchanged draft from emitting.
function onSubmit(): void {
  const changes = patch.value
  if (changes === null) return
  emit('submit', changes)
}

// An inline error moves focus to its control (design §7.2: a date without a zone focuses the zone
// input). Runs after the DOM update, so the error node and `aria-invalid` are already in place.
watch(
  () => props.fieldErrors,
  (errors) => {
    const target = FOCUS_TARGETS.find(([slot]) => errors[slot])
    if (!target) return
    root.value?.querySelector<HTMLElement>(`[data-testid="${target[1]}"]`)?.focus()
  },
  { flush: 'post' },
)
</script>

<style scoped>
.tasks-detail-editor__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tasks-detail-editor__field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  border: 0;
  margin: 0;
  padding: 0;
}

.tasks-detail-editor__field textarea {
  flex-basis: 100%;
  min-height: 72px;
}

.tasks-detail-editor__choice {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tasks-detail-editor__note,
.tasks-detail-editor__error {
  flex-basis: 100%;
  margin: 0;
}

.tasks-detail-editor__note,
.tasks-detail-editor__notice {
  color: var(--el-text-color-secondary, #666);
}

.tasks-detail-editor__error {
  color: var(--el-color-danger, #c45656);
}

.tasks-detail-editor__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
</style>
