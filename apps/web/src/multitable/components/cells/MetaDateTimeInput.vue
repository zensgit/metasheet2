<template>
  <!--
    客户反馈 2026-09-24 #4c: the date-time editor. Replaces `<input type="datetime-local">`, which read and
    wrote the BROWSER's zone (a Beijing 09:00 was stored as whatever 09:00 meant on that laptop) and drew
    its own 12h/24h UI from the OS locale. This is a plain text input showing `YYYY-MM-DD HH:mm` (24-hour)
    in the given business `timezone`, and parsing what is typed in that SAME zone — see
    ../../utils/business-timezone.ts.

    Single root on purpose: the host's class / id / aria-* / keydown / blur listeners fall through onto
    the <input> itself, and so does the host's scoped-style id — the grid editor, form view and record
    drawer keep their existing input styling and keyboard handling unchanged. The host renders the
    invalid-draft message (it owns the layout around the box); this component only reports the state.
  -->
  <input
    ref="inputEl"
    type="text"
    class="meta-datetime-input"
    :class="{ 'meta-datetime-input--invalid': invalid }"
    data-meta-datetime-input=""
    :data-invalid="invalid ? 'true' : undefined"
    autocomplete="off"
    spellcheck="false"
    :placeholder="placeholder"
    :title="zoneHint || undefined"
    :value="draft"
    @input="onInput"
    @change="onChange"
    @blur="onBlur"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { metaCoreLabel } from '../../utils/meta-core-labels'
import {
  dateTimeValueToUtcMs,
  dateTimeZoneHint,
  formatDateTimeInZone,
  parseDateTimeInput,
} from '../../utils/business-timezone'

const props = defineProps<{
  /** The stored value: a UTC ISO instant, or null/'' when empty. */
  modelValue: unknown
  /** IANA zone the wall clock is shown and typed in (resolveDateTimeTimezone(field.property)). */
  timezone: string
}>()

const emit = defineEmits<{
  /** Every keystroke that yields a valid wall clock (UTC ISO) or an empty box (null). Never for a partial draft. */
  (e: 'update:modelValue', value: string | null): void
  /** Native `change` (commit on blur/Enter), only when the typed instant differs from `modelValue`. */
  (e: 'change', value: string | null): void
  /**
   * B2 — the invalid-draft contract. `true` when the person tried to COMMIT (change / blur / Enter via
   * `flagInvalidDraft`) a non-empty draft the parser rejects; the draft stays in the box (never reverted,
   * never turned into a clear, never handed on as a value) and the host shows the values-free message.
   * `false` as soon as the draft becomes valid or empty, or the value changes from outside.
   */
  (e: 'update:invalid', invalid: boolean): void
  /**
   * B2 — the LIVE gate. `true` whenever the box holds non-empty text the parser rejects, touched or not
   * (a half-typed value counts). A host that submits a whole form (MetaFormView) blocks on this, so a person
   * who types garbage and clicks Submit without ever leaving the box is still stopped; `update:invalid`
   * above is the quieter, display-oriented signal.
   */
  (e: 'update:unparseable', unparseable: boolean): void
}>()

const { isZh } = useLocale()
const zoneHint = computed(() => dateTimeZoneHint(props.timezone, isZh.value))
const placeholder = computed(() => metaCoreLabel('cell.dateTimePlaceholder', isZh.value))

function formatForInput(value: unknown): string {
  return formatDateTimeInZone(value, props.timezone) ?? ''
}

function sameInstant(a: unknown, b: unknown): boolean {
  return dateTimeValueToUtcMs(a, props.timezone) === dateTimeValueToUtcMs(b, props.timezone)
}

// The text in the box. It is NOT re-derived from `modelValue` on every render: a person typing
// `2026-9-24 9:30` emits a valid instant whose canonical spelling differs, and re-rendering that
// spelling mid-typing would move the caret. The draft only follows `modelValue` when the two stop
// denoting the same instant — i.e. the value changed from somewhere else (a collaborator, a reset).
const draft = ref(formatForInput(props.modelValue))

// `touched`: a commit was attempted on the current unparseable draft. The error is not shown while a
// person is still typing a partial value; it appears when they try to leave / commit garbage, and
// disappears the moment the text parses (or is emptied).
const touched = ref(false)
const invalid = ref(false)
const unparseable = ref(false)

function refreshInvalid() {
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  const nextUnparseable = !parsed.ok
  if (nextUnparseable !== unparseable.value) {
    unparseable.value = nextUnparseable
    emit('update:unparseable', nextUnparseable)
  }
  const next = touched.value && !parsed.ok
  if (next === invalid.value) return
  invalid.value = next
  emit('update:invalid', next)
}

watch([() => props.modelValue, () => props.timezone], () => {
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  if (parsed.ok && sameInstant(parsed.value, props.modelValue)) return
  draft.value = formatForInput(props.modelValue)
  touched.value = false
  refreshInvalid()
})

function onInput(event: Event) {
  draft.value = (event.target as HTMLInputElement).value
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  if (parsed.ok) touched.value = false
  refreshInvalid()
  // A partial / invalid draft emits NOTHING — it must never turn into a clear of the stored value.
  if (!parsed.ok || sameInstant(parsed.value, props.modelValue)) return
  emit('update:modelValue', parsed.value)
}

// `change` / `blur` re-read the element: a `change` is not always preceded by an `input` event
// (autofill, IME commit, a script setting `.value`), and the element — not the draft — is the truth.
function syncDraftFromElement(event?: Event) {
  const target = event?.target ?? inputEl.value
  if (target instanceof HTMLInputElement) draft.value = target.value
}

function onChange(event: Event) {
  syncDraftFromElement(event)
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  if (!parsed.ok) {
    // B2: keep the garbage visible and flag it — do NOT revert to the stored value.
    touched.value = true
    refreshInvalid()
    return
  }
  const changed = !sameInstant(parsed.value, props.modelValue)
  draft.value = formatForInput(parsed.value)
  touched.value = false
  refreshInvalid()
  if (changed) emit('change', parsed.value)
}

function onBlur(event: Event) {
  // Settle the box on the canonical spelling of what it denotes. An unparseable leftover STAYS (with the
  // invalid flag) so the person sees what was refused; the host never commits it.
  syncDraftFromElement(event)
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  if (!parsed.ok) {
    touched.value = true
    refreshInvalid()
    return
  }
  draft.value = formatForInput(parsed.value)
  touched.value = false
  refreshInvalid()
}

/**
 * Host hook for Enter / Tab: re-read the element and, when the current non-empty draft is unparseable,
 * flag it (shows the error) and return `true` so the host blocks its commit. Returns `false` when the draft
 * is valid or empty (the host proceeds as usual).
 */
function flagInvalidDraft(): boolean {
  syncDraftFromElement()
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  if (parsed.ok) {
    touched.value = false
    refreshInvalid()
    return false
  }
  touched.value = true
  refreshInvalid()
  return true
}

// Hosts hold a ref to THIS component where they used to hold the <input> (MetaCellEditor focuses its
// `inputRef` on mount via `'focus' in inputRef.value`), so the element methods they call are re-exposed.
const inputEl = ref<HTMLInputElement | null>(null)
defineExpose({
  focus: () => inputEl.value?.focus(),
  blur: () => inputEl.value?.blur(),
  select: () => inputEl.value?.select(),
  flagInvalidDraft,
  isInvalid: () => invalid.value,
  isUnparseable: () => unparseable.value,
})
</script>
