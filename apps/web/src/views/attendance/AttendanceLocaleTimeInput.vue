<script setup lang="ts">
import { computed, ref, useAttrs, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  formatClockTime,
  localeTimePeriodLabel,
  parseLocaleTimeInput,
} from './attendanceLocaleTime'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  id?: string
  ariaLabel?: string
  name?: string
  modelValue?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'input', value: Event): void
}>()

const attrs = useAttrs()
const { isZh } = useLocale()
const focused = ref(false)
const draft = ref('')
const listId = `attendance-locale-time-${Math.random().toString(36).slice(2, 10)}`

const suggestions = computed(() => {
  const values: string[] = []
  for (let hour = 0; hour < 24; hour += 1) {
    values.push(`${String(hour).padStart(2, '0')}:00`)
  }
  return values
})

const periodHint = computed(() => localeTimePeriodLabel(
  focused.value ? (props.modelValue || '') : (draft.value || props.modelValue || ''),
  isZh.value ? 'zh' : 'en',
))

function syncDraft(value: string): void {
  draft.value = formatClockTime(value) || value || ''
}

watch(() => [props.modelValue, isZh.value] as const, ([value]) => {
  if (!focused.value) syncDraft(value || '')
}, { immediate: true })

function emitStored(next: string, event?: Event): void {
  emit('update:modelValue', next)
  if (event) emit('input', event)
}

function onCanonicalInput(event: Event): void {
  emitStored((event.target as HTMLInputElement).value, event)
}

function commitDraft(event?: Event): void {
  focused.value = false
  if (event?.target instanceof HTMLInputElement) draft.value = event.target.value
  const parsed = parseLocaleTimeInput(draft.value)
  if (!parsed) {
    syncDraft(props.modelValue || '')
    return
  }
  emitStored(parsed, event)
  syncDraft(parsed)
}
</script>

<template>
  <span class="attendance-locale-time" data-attendance-locale-time :data-locale-time="isZh ? 'zh' : 'en'">
    <input
      class="attendance-locale-time__value"
      type="text"
      :name="name"
      :value="modelValue || ''"
      v-bind="attrs"
      :aria-hidden="ariaLabel ? 'true' : undefined"
      tabindex="-1"
      autocomplete="off"
      @input="onCanonicalInput"
    />
    <input
      :id="id"
      class="attendance-locale-time__typed"
      data-attendance-locale-time-typed
      type="text"
      :list="listId"
      :value="draft"
      placeholder="09:00"
      :aria-label="ariaLabel || (isZh ? '时间（24 小时，例如 09:00）' : 'Time (24-hour, for example 09:00)')"
      autocomplete="off"
      @focus="focused = true"
      @input="draft = ($event.target as HTMLInputElement).value"
      @change="commitDraft($event)"
      @blur="commitDraft($event)"
      @keydown.enter.prevent="commitDraft($event)"
    />
    <span
      v-if="periodHint"
      class="attendance-locale-time__hint"
      data-attendance-locale-time-hint
    >{{ periodHint }}</span>
    <datalist :id="listId">
      <option v-for="suggestion in suggestions" :key="suggestion" :value="suggestion" />
    </datalist>
  </span>
</template>

<style scoped>
.attendance-locale-time {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  max-width: 100%;
}

.attendance-locale-time__value {
  position: absolute;
  width: 1px;
  height: 1px;
  min-width: 0;
  min-height: 0;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.attendance-locale-time__typed {
  width: 6.5rem;
  min-width: 0;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: var(--ms-radius-md, 8px);
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-1, #1f2329);
  font-size: 13px;
}

.attendance-locale-time__hint {
  color: var(--ms-text-3, #667085);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
}
</style>
