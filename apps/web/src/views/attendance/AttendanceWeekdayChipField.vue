<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { useLocale } from '../../composables/useLocale'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  id?: string
  name?: string
  modelValue?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  input: [event: Event]
}>()

const attrs = useAttrs()
const { isZh } = useLocale()

const displayOrder = [1, 2, 3, 4, 5, 6, 0]
const labelsEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const labelsZh = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function parseDays(value?: string): number[] {
  const days = new Set<number>()
  for (const part of String(value || '').split(/[\s,]+/)) {
    if (!part) continue
    const day = Number(part)
    if (Number.isInteger(day) && day >= 0 && day <= 6) days.add(day)
  }
  return [...days].sort((left, right) => left - right)
}

const selected = computed(() => parseDays(props.modelValue))
const storedValue = computed(() => selected.value.join(','))

function write(days: number[], event?: Event): void {
  const next = [...new Set(days)].filter((day) => day >= 0 && day <= 6).sort((left, right) => left - right).join(',')
  emit('update:modelValue', next)
  if (event) emit('input', event)
}

function toggle(day: number): void {
  const next = selected.value.includes(day)
    ? selected.value.filter((item) => item !== day)
    : [...selected.value, day]
  write(next)
}

function onValueInput(event: Event): void {
  write(parseDays((event.target as HTMLInputElement).value), event)
}

function label(day: number): string {
  return isZh.value ? labelsZh[day] : labelsEn[day]
}
</script>

<template>
  <span class="weekday-chips" data-attendance-weekday-field>
    <input
      :id="id"
      :name="name"
      class="attendance-locale-time__value"
      type="text"
      :value="storedValue"
      v-bind="attrs"
      tabindex="-1"
      @input="onValueInput"
    />
    <button
      v-for="day in displayOrder"
      :key="day"
      type="button"
      class="weekday-chips__chip"
      :class="{ 'weekday-chips__chip--on': selected.includes(day) }"
      :aria-pressed="selected.includes(day)"
      :data-attendance-weekday="day"
      @click="toggle(day)"
    >
      {{ label(day) }}
    </button>
  </span>
</template>

<style scoped>
.weekday-chips {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: fit-content;
  max-width: 100%;
}

.attendance-locale-time__value {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.weekday-chips__chip {
  min-height: 28px;
  padding: 2px 8px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: 999px;
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-2, #667085);
  font-size: 12px;
  cursor: pointer;
}

.weekday-chips__chip--on {
  border-color: #2563eb;
  background: #dbeafe;
  color: #1e3a8a;
}
</style>
