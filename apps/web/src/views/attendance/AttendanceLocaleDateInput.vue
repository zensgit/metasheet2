<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useAttrs, watch, watchPostEffect } from 'vue'
import { useLocale } from '../../composables/useLocale'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  modelValue?: string
  disabled?: boolean
  readonly?: boolean
  min?: string
  max?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  input: [event: Event]
}>()

const attrs = useAttrs()
const { isZh } = useLocale()
const open = ref(false)
const input = ref<HTMLInputElement | null>(null)
const blocked = computed(() => props.disabled || props.readonly)

watch(blocked, (value) => {
  if (value) open.value = false
})

watchPostEffect(() => {
  input.value?.setCustomValidity(isOutsideRange(props.modelValue || '')
    ? (isZh.value ? '日期超出可选范围。' : 'Date is outside the allowed range.')
    : '')
})
const root = ref<HTMLElement | null>(null)
const viewYear = ref(new Date().getFullYear())
const viewMonth = ref(new Date().getMonth())

const weekdayHeaders = computed(() => (
  isZh.value
    ? ['一', '二', '三', '四', '五', '六', '日']
    : ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
))

const monthTitle = computed(() => {
  if (isZh.value) return `${viewYear.value}年${viewMonth.value + 1}月`
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${names[viewMonth.value]} ${viewYear.value}`
})

const placeholder = computed(() => {
  const fromAttrs = attrs.placeholder
  if (typeof fromAttrs === 'string' && fromAttrs) return fromAttrs
  return isZh.value ? '年-月-日' : 'yyyy-mm-dd'
})

function parseIso(value?: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value || '').trim())
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(date.getTime())) return null
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1) return null
  return date
}

function isOutsideRange(value: string): boolean {
  if (!parseIso(value)) return false
  return Boolean((parseIso(props.min) && value < props.min!) || (parseIso(props.max) && value > props.max!))
}

function toIso(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function syncView(value?: string): void {
  const parsed = parseIso(value) || new Date()
  viewYear.value = parsed.getFullYear()
  viewMonth.value = parsed.getMonth()
}

watch(() => props.modelValue, (value) => {
  if (open.value) syncView(value)
})

const cells = computed(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1)
  const startOffset = isZh.value ? (first.getDay() + 6) % 7 : first.getDay()
  const gridStart = new Date(viewYear.value, viewMonth.value, 1 - startOffset)
  const selected = parseIso(props.modelValue)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index)
    return {
      iso: toIso(date),
      label: String(date.getDate()),
      outside: date.getMonth() !== viewMonth.value,
      disabled: isOutsideRange(toIso(date)),
      selected: Boolean(selected && toIso(selected) === toIso(date)),
    }
  })
})

function commit(value: string, event?: Event): void {
  if (blocked.value) return
  emit('update:modelValue', value)
  emit('input', event || new Event('input', { bubbles: true }))
}

function onTextInput(event: Event): void {
  commit((event.target as HTMLInputElement).value, event)
}

function showCalendar(): void {
  if (blocked.value) return
  open.value = true
  syncView(props.modelValue)
}

function toggle(): void {
  if (blocked.value) return
  open.value = !open.value
  if (open.value) syncView(props.modelValue)
}

function shiftMonth(delta: number): void {
  const next = new Date(viewYear.value, viewMonth.value + delta, 1)
  viewYear.value = next.getFullYear()
  viewMonth.value = next.getMonth()
}

function pick(iso: string): void {
  if (blocked.value || isOutsideRange(iso)) return
  commit(iso)
  open.value = false
}

function clearValue(): void {
  commit('')
  open.value = false
}

function pickToday(): void {
  pick(toIso(new Date()))
}

function onFocusOut(event: FocusEvent): void {
  if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget)) open.value = false
}

function onDocumentPointer(event: Event): void {
  const target = event.target
  if (!(target instanceof Node) || !root.value?.contains(target)) open.value = false
}

watch(open, (isOpen) => {
  if (typeof document === 'undefined') return
  if (isOpen) document.addEventListener('pointerdown', onDocumentPointer)
  else document.removeEventListener('pointerdown', onDocumentPointer)
})

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('pointerdown', onDocumentPointer)
})
</script>

<template>
  <span ref="root" class="attendance-locale-date" data-attendance-locale-date :data-locale-date="isZh ? 'zh' : 'en'" @focusout="onFocusOut">
    <input
      ref="input"
      class="attendance-locale-date__input"
      v-bind="attrs"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      :disabled="disabled"
      :readonly="readonly"
      :min="min"
      :max="max"
      :value="modelValue || ''"
      :placeholder="placeholder"
      @input="onTextInput"
      @focus="showCalendar"
    />
    <button class="attendance-locale-date__button" type="button" :disabled="blocked" :aria-label="isZh ? '打开日历' : 'Open calendar'" @click="toggle">
      {{ isZh ? '日历' : 'Cal' }}
    </button>
    <span v-if="open" class="attendance-locale-date__popup" data-attendance-locale-date-popup @pointerdown.stop>
      <span class="attendance-locale-date__nav">
        <button type="button" :aria-label="isZh ? '上个月' : 'Previous month'" @click="shiftMonth(-1)">‹</button>
        <strong>{{ monthTitle }}</strong>
        <button type="button" :aria-label="isZh ? '下个月' : 'Next month'" @click="shiftMonth(1)">›</button>
      </span>
      <span class="attendance-locale-date__weekdays">
        <span v-for="label in weekdayHeaders" :key="label">{{ label }}</span>
      </span>
      <span class="attendance-locale-date__grid">
        <button
          v-for="cell in cells"
          :key="cell.iso + cell.label"
          type="button"
          :data-date="cell.iso"
          :disabled="cell.disabled"
          :class="{ 'is-outside': cell.outside, 'is-selected': cell.selected }"
          @click="pick(cell.iso)"
        >
          {{ cell.label }}
        </button>
      </span>
      <span class="attendance-locale-date__actions">
        <button type="button" data-attendance-locale-date-clear @click="clearValue">{{ isZh ? '清除' : 'Clear' }}</button>
        <button type="button" :disabled="isOutsideRange(toIso(new Date()))" data-attendance-locale-date-today @click="pickToday">{{ isZh ? '今天' : 'Today' }}</button>
      </span>
    </span>
  </span>
</template>

<style scoped>
.attendance-locale-date {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  width: 100%;
}

.attendance-locale-date__input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
}

.attendance-locale-date__button {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: 8px;
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-2, #667085);
  font-size: 12px;
  cursor: pointer;
}

.attendance-locale-date__popup {
  position: absolute;
  z-index: 40;
  top: calc(100% + 4px);
  left: 0;
  display: grid;
  gap: 8px;
  width: 280px;
  padding: 10px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: 10px;
  background: var(--ms-bg-card, #fff);
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12);
}

.attendance-locale-date__nav,
.attendance-locale-date__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.attendance-locale-date__nav button,
.attendance-locale-date__actions button,
.attendance-locale-date__grid button {
  border: 0;
  background: transparent;
  color: var(--ms-text-1, #1f2329);
  cursor: pointer;
}

.attendance-locale-date__weekdays,
.attendance-locale-date__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  text-align: center;
  font-size: 12px;
}

.attendance-locale-date__weekdays span {
  color: var(--ms-text-3, #667085);
}

.attendance-locale-date__grid button {
  min-height: 28px;
  border-radius: 6px;
}

.attendance-locale-date__grid .is-outside {
  color: #98a2b3;
}

.attendance-locale-date__grid .is-selected {
  background: #2563eb;
  color: #fff;
}
</style>
