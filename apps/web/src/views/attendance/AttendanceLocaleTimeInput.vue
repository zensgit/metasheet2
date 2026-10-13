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
  (event: 'update:modelValue', value: string): void
  (event: 'input', value: Event): void
}>()

const attrs = useAttrs()
const { isZh } = useLocale()

const hours = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'))

function parseTime(value: string): { hour12: string; minute: string; period: 'am' | 'pm'; empty: boolean } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim())
  if (!match) {
    return { hour12: '', minute: '', period: 'am', empty: true }
  }
  const hour24 = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  const period: 'am' | 'pm' = hour24 >= 12 ? 'pm' : 'am'
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return {
    hour12: String(hour12),
    minute: String(minute).padStart(2, '0'),
    period,
    empty: false,
  }
}

const parts = computed(() => parseTime(props.modelValue || ''))

function emitTime(hour12: number, minute: number, period: 'am' | 'pm'): void {
  let hour24 = hour12 % 12
  if (period === 'pm') hour24 += 12
  const next = `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  emit('update:modelValue', next)
}

function onHour(event: Event): void {
  const hour12 = Number((event.target as HTMLSelectElement).value)
  if (!Number.isFinite(hour12) || hour12 < 1) return
  const minute = parts.value.empty ? 0 : Number(parts.value.minute)
  emitTime(hour12, minute, parts.value.period)
}

function onMinute(event: Event): void {
  const minute = Number((event.target as HTMLSelectElement).value)
  const hour12 = parts.value.empty ? 12 : Number(parts.value.hour12)
  emitTime(hour12, minute, parts.value.period)
}

function onPeriod(event: Event): void {
  const period = (event.target as HTMLSelectElement).value === 'pm' ? 'pm' : 'am'
  const hour12 = parts.value.empty ? 12 : Number(parts.value.hour12)
  const minute = parts.value.empty ? 0 : Number(parts.value.minute)
  emitTime(hour12, minute, period)
}

function onValueInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  emit('input', event)
}
</script>

<template>
  <span class="attendance-locale-time" data-attendance-locale-time :data-locale-time="isZh ? 'zh' : 'en'">
    <input
      :id="id"
      :name="name"
      class="attendance-locale-time__value"
      type="text"
      :value="modelValue || ''"
      v-bind="attrs"
      tabindex="-1"
      @input="onValueInput"
    />
    <select
      class="attendance-locale-time__part"
      data-attendance-locale-time-hour
      :aria-label="isZh ? '时' : 'Hour'"
      :value="parts.hour12"
      @change="onHour"
    >
      <option v-if="parts.empty" value=""></option>
      <option v-for="hour in hours" :key="hour" :value="hour">{{ hour }}</option>
    </select>
    <span class="attendance-locale-time__sep" aria-hidden="true">:</span>
    <select
      class="attendance-locale-time__part attendance-locale-time__part--minute"
      data-attendance-locale-time-minute
      :aria-label="isZh ? '分' : 'Minute'"
      :value="parts.minute"
      @change="onMinute"
    >
      <option v-if="parts.empty" value=""></option>
      <option v-for="minute in minutes" :key="minute" :value="minute">{{ minute }}</option>
    </select>
    <select
      class="attendance-locale-time__period"
      data-attendance-locale-time-period
      :aria-label="isZh ? '上午或下午' : 'AM or PM'"
      :value="parts.period"
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
  gap: 4px;
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

.attendance-locale-time__part,
.attendance-locale-time__period {
  width: auto;
  min-width: 0;
  max-width: 4.5rem;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: var(--ms-radius-md, 8px);
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-1, #1f2329);
  font-size: 13px;
}

.attendance-locale-time__period {
  max-width: 4.75rem;
}

.attendance-locale-time__sep {
  color: var(--ms-text-3, #667085);
  font-size: 13px;
  line-height: 1;
}
</style>
