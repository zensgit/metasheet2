<template>
  <!--
    客户反馈 2026-09-24 #4c: the date-time editor. Replaces `<input type="datetime-local">`, which read and
    wrote the BROWSER's zone (a Beijing 09:00 was stored as whatever 09:00 meant on that laptop) and drew
    its own 12h/24h UI from the OS locale. This is a plain text input showing `YYYY-MM-DD HH:mm` (24-hour)
    in the given business `timezone`, and parsing what is typed in that SAME zone — see
    ../../utils/business-timezone.ts.

    Single root on purpose: the host's class / id / aria-* / keydown / blur listeners fall through onto
    the <input> itself, and so does the host's scoped-style id — the grid editor, form view and record
    drawer keep their existing input styling and keyboard handling unchanged.
  -->
  <input
    ref="inputEl"
    type="text"
    class="meta-datetime-input"
    data-meta-datetime-input=""
    autocomplete="off"
    spellcheck="false"
    :placeholder="DATE_TIME_INPUT_PLACEHOLDER"
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
import {
  dateTimeValueToUtcMs,
  dateTimeZoneHint,
  formatDateTimeInZone,
  parseDateTimeInput,
} from '../../utils/business-timezone'

const DATE_TIME_INPUT_PLACEHOLDER = 'YYYY-MM-DD HH:mm'

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
}>()

const { isZh } = useLocale()
const zoneHint = computed(() => dateTimeZoneHint(props.timezone, isZh.value))

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

watch([() => props.modelValue, () => props.timezone], () => {
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  if (parsed.ok && sameInstant(parsed.value, props.modelValue)) return
  draft.value = formatForInput(props.modelValue)
})

function onInput(event: Event) {
  draft.value = (event.target as HTMLInputElement).value
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  // A partial / invalid draft emits NOTHING — it must never turn into a clear of the stored value.
  if (!parsed.ok || sameInstant(parsed.value, props.modelValue)) return
  emit('update:modelValue', parsed.value)
}

// `change` / `blur` re-read the element: a `change` is not always preceded by an `input` event
// (autofill, IME commit, a script setting `.value`), and the element — not the draft — is the truth.
function syncDraftFromElement(event: Event) {
  const target = event.target
  if (target instanceof HTMLInputElement) draft.value = target.value
}

function onChange(event: Event) {
  syncDraftFromElement(event)
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  if (!parsed.ok) {
    draft.value = formatForInput(props.modelValue)
    return
  }
  const changed = !sameInstant(parsed.value, props.modelValue)
  draft.value = formatForInput(parsed.value)
  if (changed) emit('change', parsed.value)
}

function onBlur(event: Event) {
  // Settle the box on the canonical spelling of what it denotes; an unparseable leftover reverts to
  // the stored value (which is what the host commits — the last VALID draft, never the garbage).
  syncDraftFromElement(event)
  const parsed = parseDateTimeInput(draft.value, props.timezone)
  draft.value = parsed.ok ? formatForInput(parsed.value) : formatForInput(props.modelValue)
}

// Hosts hold a ref to THIS component where they used to hold the <input> (MetaCellEditor focuses its
// `inputRef` on mount via `'focus' in inputRef.value`), so the element methods they call are re-exposed.
const inputEl = ref<HTMLInputElement | null>(null)
defineExpose({
  focus: () => inputEl.value?.focus(),
  blur: () => inputEl.value?.blur(),
  select: () => inputEl.value?.select(),
})
</script>
