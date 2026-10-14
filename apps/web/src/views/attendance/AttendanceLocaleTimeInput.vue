<script setup lang="ts">
import { computed, ref, useAttrs, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  composeStoredTime,
  formatLocaleTimeInput,
  parseLocaleTimeInput,
  parseStoredTime,
} from './attendanceLocaleTime'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  id?: string
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
  const locale = isZh.value ? 'zh' : 'en'
  const values: string[] = []
  for (let hour = 0; hour < 24; hour += 1) {
    const stored = `${String(hour).padStart(2, '0')}:00`
    values.push(stored, formatLocaleTimeInput(stored, locale))
  }
  return values
})

function syncDraft(value: string): void {
  draft.value = formatLocaleTimeInput(value, isZh.value ? 'zh' : 'en') || value || ''
}

watch(() => [props.modelValue, isZh.value] as const, ([value]) => {
  if (!focused.value) syncDraft(value || '')
}, { immediate: true })

const parts = computed(() => parseStoredTime(props.modelValue || ''))

function emitStored(next: string, event?: Event): void {
  emit('update:modelValue', next)
  if (event) emit('input', event)
}

function onCanonicalInput(event: Event): void {
  emitStored((event.target as HTMLInputElement).value, event)
}

function commitDraft(event?: Event): void {
  focused.value = false
  const parsed = parseLocaleTimeInput(draft.value)
  if (!parsed) {
    syncDraft(props.modelValue || '')
    return
  }
  emitStored(parsed, event)
  syncDraft(parsed)
}

function onPeriod(event: Event): void {
  const period = (event.target as HTMLSelectElement).value === 'pm' ? 'pm' : 'am'
  const current = parts.value ?? { hour12: 12, minute: 0, period: 'am' as const }
  emitStored(composeStoredTime(current.hour12, current.minute, period), event)
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
      :placeholder="isZh ? '9:00 或 18:00' : '9:00 or 18:00'"
      :aria-label="isZh ? '时间，可输入 9:00 或 18:00' : 'Time, type 9:00 or 18:00'"
      autocomplete="off"
      @focus="focused = true"
      @input="draft = ($event.target as HTMLInputElement).value"
      @change="commitDraft($event)"
      @blur="commitDraft($event)"
      @keydown.enter.prevent="commitDraft($event)"
    />
    <datalist :id="listId">
      <option v-for="suggestion in suggestions" :key="suggestion" :value="suggestion" />
    </datalist>
    <select
      class="attendance-locale-time__period"
      data-attendance-locale-time-period
      :aria-label="isZh ? '上午或下午' : 'AM or PM'"
      :value="parts?.period || 'am'"
      @change="onPeriod"
    >
      <option value="am">{{ isZh ? '上午' : 'AM' }}</option>
      <option value="pm">{{ isZh ? '下午' : 'PM' }}</option>
    </select>
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

.attendance-locale-time__typed,
.attendance-locale-time__period {
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: var(--ms-radius-md, 8px);
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-1, #1f2329);
  font-size: 13px;
}

.attendance-locale-time__typed {
  width: 8.5rem;
  min-width: 0;
}

.attendance-locale-time__period {
  width: auto;
  min-width: 0;
  max-width: 4.75rem;
}
</style>
