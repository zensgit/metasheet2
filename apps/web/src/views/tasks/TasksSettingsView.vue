<template>
  <section class="tasks-settings" aria-labelledby="tasks-settings-title">
    <header class="tasks-settings__header">
      <h1 id="tasks-settings-title">{{ t.settingsTitle }}</h1>
      <router-link class="tasks-settings__back-link" to="/tasks" data-testid="tasks-settings-back-link">
        &larr; {{ t.backToList }}
      </router-link>
    </header>

    <p v-if="contextState === null" class="tasks-settings__message" data-testid="tasks-settings-loading">
      {{ t.loading }}
    </p>

    <template v-else-if="contextState.state === 'ready'">
      <!-- A save answered 422 ORG_MISSING: the page shows the same guidance block as the
           context-level org_missing state below, in place of the form. -->
      <p v-if="orgMissingFromSave" class="tasks-settings__message" data-testid="tasks-view-org-missing" role="status">
        {{ t.orgMissing }}
      </p>
      <p v-else-if="readResult.kind === 'loading'" class="tasks-settings__message" data-testid="tasks-settings-loading">
        {{ t.loading }}
      </p>
      <p v-else-if="readResult.kind === 'not_found'" class="tasks-settings__message" data-testid="tasks-settings-not-found" role="status">
        {{ t.settingsNotFound }}
      </p>
      <p v-else-if="readResult.kind === 'forbidden'" class="tasks-settings__message" data-testid="tasks-settings-forbidden" role="status">
        {{ t.settingsForbidden }}
      </p>
      <p v-else-if="readResult.kind === 'error'" class="tasks-settings__message" data-testid="tasks-settings-error" role="alert">
        {{ t.settingsLoadFailed }}
      </p>

      <form
        v-else
        class="tasks-settings__form"
        data-testid="tasks-settings-form"
        :aria-busy="pending ? 'true' : 'false'"
        @submit.prevent="onSave"
      >
        <p v-if="saveBanner" class="tasks-settings__message" data-testid="tasks-settings-save-banner" role="alert">
          {{ saveBanner }}
        </p>

        <fieldset
          class="tasks-settings__field"
          data-testid="tasks-settings-badge-scope"
          :aria-describedby="fieldErrors.badgeScope ? 'tasks-settings-badge-scope-error' : undefined"
        >
          <legend>{{ t.settingsBadgeScopeLegend }}</legend>
          <label v-for="option in BADGE_SCOPE_OPTIONS" :key="option.value" class="tasks-settings__choice">
            <input
              v-model="draft.badgeScope"
              type="radio"
              name="tasks-settings-badge-scope"
              :value="option.value"
              :data-testid="`tasks-settings-badge-scope-${option.value}`"
              :disabled="pending"
              @change="clearOutcome"
            />
            {{ t[option.labelKey] }}
          </label>
          <p
            v-if="fieldErrors.badgeScope"
            id="tasks-settings-badge-scope-error"
            class="tasks-settings__error"
            data-testid="tasks-settings-badge-scope-error"
            role="alert"
          >{{ codeMessage(fieldErrors.badgeScope, t) }}</p>
        </fieldset>

        <div class="tasks-settings__field">
          <label class="tasks-settings__choice">
            <input
              type="checkbox"
              data-testid="tasks-settings-daily-reminder"
              :checked="draft.dailyReminderEnabled"
              :disabled="pending"
              :aria-describedby="describedBy('tasks-settings-daily-reminder-note', fieldErrors.dailyReminderEnabled ? 'tasks-settings-daily-reminder-error' : null)"
              @change="onDailyReminderChange"
            />
            {{ t.settingsDailyReminder }}
          </label>
          <p id="tasks-settings-daily-reminder-note" class="tasks-settings__note" data-testid="tasks-settings-daily-reminder-note">
            {{ t.settingsDailyReminderNote }}
          </p>
          <p
            v-if="fieldErrors.dailyReminderEnabled"
            id="tasks-settings-daily-reminder-error"
            class="tasks-settings__error"
            data-testid="tasks-settings-daily-reminder-error"
            role="alert"
          >{{ codeMessage(fieldErrors.dailyReminderEnabled, t) }}</p>
        </div>

        <div class="tasks-settings__field">
          <label for="tasks-settings-remind-policy">{{ t.settingsRemindPolicyLabel }}</label>
          <select
            id="tasks-settings-remind-policy"
            v-model="draft.defaultRemindPolicy.mode"
            data-testid="tasks-settings-remind-policy"
            :disabled="pending"
            :aria-invalid="fieldErrors.defaultRemindPolicy ? 'true' : undefined"
            :aria-describedby="fieldErrors.defaultRemindPolicy ? 'tasks-settings-remind-policy-error' : undefined"
            @change="clearOutcome"
          >
            <option value="default">{{ t.settingsRemindPolicyDefault }}</option>
            <option value="none">{{ t.settingsRemindPolicyNone }}</option>
          </select>
          <p
            v-if="fieldErrors.defaultRemindPolicy"
            id="tasks-settings-remind-policy-error"
            class="tasks-settings__error"
            data-testid="tasks-settings-remind-policy-error"
            role="alert"
          >{{ codeMessage(fieldErrors.defaultRemindPolicy, t) }}</p>
        </div>

        <div class="tasks-settings__field">
          <label for="tasks-settings-time-zone">{{ t.settingsTimeZoneLabel }}</label>
          <input
            id="tasks-settings-time-zone"
            v-model="draft.timeZone"
            type="text"
            autocomplete="off"
            list="tasks-settings-time-zone-options"
            data-testid="tasks-settings-time-zone"
            :placeholder="t.settingsTimeZonePlaceholder"
            :disabled="pending"
            :aria-invalid="fieldErrors.timeZone ? 'true' : undefined"
            :aria-describedby="describedBy(
              zoneAutofilled ? 'tasks-settings-time-zone-autofilled' : null,
              fieldErrors.timeZone ? 'tasks-settings-time-zone-error' : null,
            )"
            @input="onTimeZoneInput"
          />
          <button
            type="button"
            class="tasks-settings__use-browser-zone"
            :class="{ 'tasks-settings__use-browser-zone--suggested': suggestBrowserZone }"
            data-testid="tasks-settings-use-browser-zone"
            :data-suggested="suggestBrowserZone ? 'true' : 'false'"
            :disabled="pending || browserZone === ''"
            @click="onUseBrowserZone"
          >{{ t.settingsUseBrowserTimeZone }}</button>
          <datalist id="tasks-settings-time-zone-options" data-testid="tasks-settings-time-zone-options">
            <option v-for="option in timeZoneOptions" :key="option.value" :value="option.value" :label="option.label" />
          </datalist>
          <p
            v-if="zoneAutofilled"
            id="tasks-settings-time-zone-autofilled"
            class="tasks-settings__note"
            data-testid="tasks-settings-time-zone-autofilled"
            role="status"
          >{{ t.settingsTimeZoneAutofilled }}</p>
          <p
            v-if="fieldErrors.timeZone"
            id="tasks-settings-time-zone-error"
            class="tasks-settings__error"
            data-testid="tasks-settings-time-zone-error"
            role="alert"
          >{{ codeMessage(fieldErrors.timeZone, t) }}</p>
        </div>

        <div class="tasks-settings__actions">
          <button type="submit" data-testid="tasks-settings-save" :disabled="pending || patch === null">{{ t.save }}</button>
          <p v-if="fieldErrors.form" class="tasks-settings__error" data-testid="tasks-settings-save-error" role="alert">
            {{ codeMessage(fieldErrors.form, t) }}
          </p>
          <p v-if="saved" class="tasks-settings__note" data-testid="tasks-settings-saved" role="status">
            {{ t.settingsSaved }}
          </p>
        </div>
      </form>
    </template>

    <!-- The four other context states render the same blocks (copy and data-testid) as TasksView. -->
    <p v-else-if="contextState.state === 'org_missing'" class="tasks-settings__message" data-testid="tasks-view-org-missing" role="status">
      {{ t.orgMissing }}
    </p>
    <p v-else-if="contextState.state === 'unavailable'" class="tasks-settings__message" data-testid="tasks-view-unavailable" role="status">
      {{ t.contextUnavailable }}
    </p>
    <p v-else-if="contextState.state === 'forbidden'" class="tasks-settings__message" data-testid="tasks-view-forbidden" role="status">
      {{ t.contextForbidden }}
    </p>
    <p v-else class="tasks-settings__message" data-testid="tasks-view-error" role="status">
      {{ t.contextError }}
    </p>
  </section>
</template>

<script setup lang="ts">
/**
 * `/tasks/settings` — the viewer's own task settings (design §2.1, §4.5, §7.1; backend
 * `GET/PATCH /api/task-settings`, PR-3a S3).
 *
 * Reads: `GET /api/tasks/context` first (the same five states as TasksView), then
 * `GET /api/task-settings`. Read states: loading / ok (the form) / not_found (a missing route or a
 * missing org; the contract does not tell them apart) / forbidden / error.
 *
 * Save rules:
 *   - the request carries only the keys the draft changed (`buildSettingsPatch`); an unchanged
 *     draft disables the save button and sends nothing; a cleared zone is sent as `null`;
 *     `badgeScope` / `defaultRemindPolicy` are never sent as `null`;
 *   - the pre-check (`checkSettingsDraft`) runs before any request; a code it reports renders next
 *     to its field and nothing is sent;
 *   - one save at a time: while a save is pending every control is disabled and a second submit
 *     sends nothing;
 *   - a 422 code renders next to the field it belongs to (`INVALID_SETTINGS` and any unlisted code
 *     next to the save button); 422 `ORG_MISSING` replaces the form with the org guidance block;
 *     403 / 404 / anything else render the page banner;
 *   - ok: the response replaces the form (the server answers with the canonical zone name),
 *     "saved" shows, and `notifyTasksChanged()` makes the nav badge re-read at once (its scope may
 *     have changed). The server sends no realtime signal for a settings write, so this nudge is the
 *     badge's only prompt short of its next poll; it is sent after every successful save, not only
 *     one that changed the badge scope (`[fe-54]`);
 *   - a result that lands after the page was left touches no page state; an ok one still calls
 *     `notifyTasksChanged()`, because the server state changed either way.
 *
 * The daily reminder needs a time zone: ticking it while the zone is empty fills in the browser's
 * zone and says so (`[fe-06]`); the viewer still saves explicitly. Leaving the page with unsaved
 * changes is not intercepted (`[fe-03]`).
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { TASKS_EN, TASKS_ZH, codeMessage, type TasksText } from '../../tasks/labels'
import { loadTasksContext, type TasksContextResult } from '../../tasks/tasksContext'
import {
  getTaskSettings,
  patchTaskSettings,
  resolveViewerTimeZone,
  type PatchTaskSettingsResult,
  type TaskBadgeScope,
  type TaskSettings,
} from '../../tasks/tasksApi'
import { notifyTasksChanged } from '../../tasks/tasksBadgeBus'
import {
  buildSettingsPatch,
  checkSettingsDraft,
  initSettingsDraft,
  isValidTimeZoneName,
  type SettingsDraft,
  type SettingsField,
} from '../../tasks/tasksDraft'
import { buildTimezoneOptions, type TimezoneOption } from '../../utils/timezones'

const { isZh } = useLocale()
const t = computed<TasksText>(() => (isZh.value ? TASKS_ZH : TASKS_EN))

// RULED(2026-10-07): [R02] — the three badge scopes, in this order.
const BADGE_SCOPE_OPTIONS: Array<{ value: TaskBadgeScope; labelKey: keyof TasksText }> = [
  { value: 'off', labelKey: 'settingsBadgeScopeOff' },
  { value: 'overdue', labelKey: 'settingsBadgeScopeOverdue' },
  { value: 'overdue_or_today', labelKey: 'settingsBadgeScopeOverdueOrToday' },
]

/** Where an inline error renders: next to one of the four fields, or next to the save button. */
type ErrorSlot = SettingsField | 'form'

/** The 422 codes of `PATCH /api/task-settings` and the field each one renders next to. */
const SETTINGS_CODE_SLOT: Readonly<Record<string, ErrorSlot>> = {
  INVALID_SETTINGS: 'form',
  INVALID_BADGE_SCOPE: 'badgeScope',
  INVALID_DAILY_REMINDER_ENABLED: 'dailyReminderEnabled',
  INVALID_POLICY: 'defaultRemindPolicy',
  INVALID_TIME_ZONE: 'timeZone',
  DAILY_REMINDER_REQUIRES_TIME_ZONE: 'timeZone',
}

function slotForCode(code: string): ErrorSlot {
  return Object.prototype.hasOwnProperty.call(SETTINGS_CODE_SLOT, code) ? SETTINGS_CODE_SLOT[code] : 'form'
}

type ReadState =
  | { kind: 'loading' }
  | { kind: 'ok'; settings: TaskSettings }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'error' }

type SaveBannerKind = 'forbidden' | 'not_found' | 'error'

const contextState = ref<TasksContextResult | null>(null)
const readResult = ref<ReadState>({ kind: 'loading' })
/** The form's working copy. Rendered only while `readResult` is ok, which is also when it is
 *  initialized from the server's settings. */
const draft = ref<SettingsDraft>({ badgeScope: '', dailyReminderEnabled: false, defaultRemindPolicy: { mode: '' }, timeZone: '' })
const pending = ref(false)
const saved = ref(false)
const fieldErrors = ref<Partial<Record<ErrorSlot, string>>>({})
const saveBannerKind = ref<SaveBannerKind | null>(null)
const orgMissingFromSave = ref(false)
const zoneAutofilled = ref(false)

// Late-result guards: the read compares a generation, a save compares a token; leaving the page
// advances both.
let readGeneration = 0
let saveToken = 0

/** The changed keys, or `null` when the draft equals the server's settings. */
const patch = computed(() => (readResult.value.kind === 'ok' ? buildSettingsPatch(readResult.value.settings, draft.value) : null))

const saveBanner = computed<string | null>(() => {
  switch (saveBannerKind.value) {
    case 'forbidden':
      return t.value.settingsSaveForbidden
    case 'not_found':
      return t.value.settingsSaveUnavailable
    case 'error':
      return t.value.settingsSaveFailed
    default:
      return null
  }
})

/** The browser's zone when it is a usable IANA name, `''` otherwise. */
function usableBrowserZone(): string {
  const zone = resolveViewerTimeZone()
  return isValidTimeZoneName(zone) ? zone : ''
}

const browserZone = usableBrowserZone()

/** The suggestion is highlighted while the zone input is empty (as it is for `timeZone: null`). */
const suggestBrowserZone = computed(() => browserZone !== '' && draft.value.timeZone.trim() === '')

/** Candidates for the zone input, the browser's zone first. Computed once per page. */
const timeZoneOptions: TimezoneOption[] = (() => {
  try {
    return buildTimezoneOptions(browserZone ? [browserZone] : [])
  } catch {
    return []
  }
})()

function describedBy(...ids: Array<string | null>): string | undefined {
  const present = ids.filter((id): id is string => id !== null)
  return present.length > 0 ? present.join(' ') : undefined
}

/** Any edit, and every save attempt, retires the previous save's outcome: "saved", the inline
 *  errors and the banner. */
function clearOutcome(): void {
  saved.value = false
  fieldErrors.value = {}
  saveBannerKind.value = null
}

function onTimeZoneInput(): void {
  clearOutcome()
  zoneAutofilled.value = false
}

// RULED(2026-10-07): [R07] — the daily reminder needs a zone; [fe-06] fills in the browser's.
function onDailyReminderChange(event: Event): void {
  const enabled = (event.target as HTMLInputElement).checked
  clearOutcome()
  draft.value.dailyReminderEnabled = enabled
  if (!enabled || draft.value.timeZone.trim() !== '') return
  const zone = usableBrowserZone()
  if (zone === '') return
  draft.value.timeZone = zone
  zoneAutofilled.value = true
}

function onUseBrowserZone(): void {
  const zone = usableBrowserZone()
  if (zone === '') return
  clearOutcome()
  zoneAutofilled.value = false
  draft.value.timeZone = zone
}

async function onSave(): Promise<void> {
  if (pending.value) return
  const state = readResult.value
  if (state.kind !== 'ok') return
  const changes = buildSettingsPatch(state.settings, draft.value)
  if (changes === null) return
  clearOutcome()
  const check = checkSettingsDraft(draft.value)
  if (!check.ok) {
    fieldErrors.value = { [check.field]: check.code }
    return
  }

  const token = ++saveToken
  pending.value = true
  const result = await patchTaskSettings(changes)
  // [fe-54] Every successful save re-reads the badge: no realtime signal follows a settings write.
  if (result.kind === 'ok') notifyTasksChanged()
  if (token !== saveToken) return
  pending.value = false
  applySaveResult(result)
}

function applySaveResult(result: PatchTaskSettingsResult): void {
  switch (result.kind) {
    case 'ok':
      readResult.value = { kind: 'ok', settings: result.settings }
      draft.value = initSettingsDraft(result.settings)
      zoneAutofilled.value = false
      saved.value = true
      return
    case 'validation':
      fieldErrors.value = { [slotForCode(result.code)]: result.code }
      return
    // ASSUMPTION(task-m4-fe): [own-19] (PR-3a) — a save with no org selected is 422 ORG_MISSING.
    case 'org_missing':
      orgMissingFromSave.value = true
      return
    case 'forbidden':
    case 'not_found':
      saveBannerKind.value = result.kind
      return
    default:
      saveBannerKind.value = 'error'
  }
}

// ASSUMPTION(task-m4-fe): [own-19] (PR-3a) — with no org selected the settings read is a 404, the
// same answer as a missing route; the not_found copy names both causes.
onMounted(async () => {
  const generation = readGeneration
  const context = await loadTasksContext()
  if (generation !== readGeneration) return
  contextState.value = context
  if (context.state !== 'ready') return
  const result = await getTaskSettings()
  if (generation !== readGeneration) return
  if (result.kind === 'ok') {
    draft.value = initSettingsDraft(result.settings)
    readResult.value = { kind: 'ok', settings: result.settings }
  } else {
    readResult.value = { kind: result.kind }
  }
})

onBeforeUnmount(() => {
  readGeneration += 1
  saveToken += 1
})

// Read by tests/tasks-settings-view.spec.ts to show that a result landing after the page was left
// changes no page state.
defineExpose({ readResult, draft, pending, saved, fieldErrors, saveBannerKind, orgMissingFromSave })
</script>

<style scoped>
.tasks-settings {
  padding: 24px;
  max-width: 720px;
}

.tasks-settings__header h1 {
  margin: 0 0 8px;
}

.tasks-settings__message,
.tasks-settings__note {
  color: var(--el-text-color-secondary, #666);
}

.tasks-settings__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.tasks-settings__field {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  border: 0;
  margin: 0;
  padding: 0;
}

.tasks-settings__field legend {
  margin-bottom: 4px;
}

.tasks-settings__choice {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tasks-settings__note,
.tasks-settings__error {
  flex-basis: 100%;
  margin: 0;
}

.tasks-settings__error {
  color: var(--el-color-danger, #c45656);
}

.tasks-settings__use-browser-zone--suggested {
  font-weight: 600;
}

.tasks-settings__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
</style>
