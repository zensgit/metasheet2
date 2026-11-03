<template>
  <!--
    客户反馈 2026-09-24 #4c (PR #6083 review S3): the mouse path for a date-time — a calendar button that
    opens Element Plus's date-time PANEL (24-hour, `YYYY-MM-DD HH:mm`, zh-CN / en locale) in a popover.

    It sits NEXT TO MetaDateTimeInput (the typing path) in the form view and the record drawer rather than
    replacing it: Element Plus's <el-date-picker> input silently REVERTS text it cannot parse on blur, which
    is exactly the "dropped silently" behaviour B2 forbids, so typing stays in our strict text box and this
    component only ever produces valid instants. The grid cell editor keeps the text box alone (popover /
    blur interplay with the grid's click-away commit).

    Zone bridge: the panel works in the BROWSER's local time (a `Date` whose LOCAL components are what is
    shown). We hand it a Date whose local components equal the BUSINESS wall clock, and read the picked
    Date's local components back as a business wall clock (business-timezone.ts `pickerDateForValue` /
    `valueForPickerDate`). The browser's zone therefore never changes the stored instant.
  -->
  <MtPopover v-model:open="open" placement="bottom-start">
    <template #trigger>
      <button
        type="button"
        class="meta-datetime-picker__trigger"
        data-meta-datetime-picker-trigger=""
        :disabled="disabled"
        :aria-label="pickLabel"
        :title="pickLabel"
        :aria-expanded="open ? 'true' : 'false'"
        @mousedown.prevent
      >&#x1F4C5;</button>
    </template>
    <div class="meta-datetime-picker__panel" data-meta-datetime-picker-panel="">
      <ElConfigProvider :locale="elLocale">
        <ElDatePickerPanel
          :model-value="pickerDate ?? undefined"
          type="datetime"
          @update:model-value="onPanelUpdate"
          format="YYYY-MM-DD HH:mm"
          date-format="YYYY-MM-DD"
          time-format="HH:mm"
          :show-now="true"
          :show-confirm="false"
          :border="false"
        />
      </ElConfigProvider>
      <div class="meta-datetime-picker__footer">
        <button type="button" class="meta-datetime-picker__btn" data-meta-datetime-picker-cancel="" @click="close">{{ cancelLabel }}</button>
        <button type="button" class="meta-datetime-picker__btn meta-datetime-picker__btn--primary" data-meta-datetime-picker-confirm="" :disabled="!pickerDate" @click="confirm">{{ okLabel }}</button>
      </div>
    </div>
  </MtPopover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElConfigProvider, ElDatePickerPanel } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import { useLocale } from '../../../composables/useLocale'
import { metaCoreLabel } from '../../utils/meta-core-labels'
import { pickerDateForValue, valueForPickerDate } from '../../utils/business-timezone'
import { MtPopover } from '../../ui'

const props = defineProps<{
  /** The stored value: a UTC ISO instant, or null/'' when empty. */
  modelValue: unknown
  /** IANA zone the wall clock is picked in (resolveDateTimeTimezone(field.property)). */
  timezone: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  /** The picked wall clock as a UTC ISO instant (only on 确定 / OK — never while browsing the panel). */
  (e: 'update:modelValue', value: string): void
}>()

const { isZh } = useLocale()
const elLocale = computed(() => (isZh.value ? zhCn : en))
const pickLabel = computed(() => metaCoreLabel('cell.dateTimePick', isZh.value))
const okLabel = computed(() => (isZh.value ? '确定' : 'OK'))
const cancelLabel = computed(() => (isZh.value ? '取消' : 'Cancel'))

const open = ref(false)
const pickerDate = ref<Date | null>(pickerDateForValue(props.modelValue, props.timezone))

// Re-seed the panel from the stored value each time it opens (and when the value / zone change while open).
watch([open, () => props.modelValue, () => props.timezone], () => {
  pickerDate.value = pickerDateForValue(props.modelValue, props.timezone)
})

function close() {
  open.value = false
}

// The panel hands back a Date (or a string/number/array for other picker types we never use); keep a Date.
function onPanelUpdate(next: unknown) {
  pickerDate.value = next instanceof Date && !Number.isNaN(next.getTime()) ? next : null
}

/** Commit what the panel shows, as a business wall clock → UTC instant. Exposed for tests / hosts. */
function applyPickedDate(picked: Date | null | undefined): string | null {
  const value = valueForPickerDate(picked, props.timezone)
  if (value !== null) emit('update:modelValue', value)
  return value
}

function confirm() {
  applyPickedDate(pickerDate.value)
  close()
}

defineExpose({ applyPickedDate, open })
</script>

<style scoped>
.meta-datetime-picker__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--ms-border, #ddd);
  border-radius: 4px;
  background: var(--ms-bg-card, #fff);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.meta-datetime-picker__trigger:disabled { cursor: not-allowed; opacity: 0.5; }
.meta-datetime-picker__panel { padding: 4px; }
.meta-datetime-picker__footer { display: flex; justify-content: flex-end; gap: 6px; padding: 6px 8px 4px; }
.meta-datetime-picker__btn {
  padding: 4px 12px;
  border: 1px solid var(--ms-border, #ddd);
  border-radius: 4px;
  background: var(--ms-bg-card, #fff);
  font-size: 12px;
  cursor: pointer;
}
.meta-datetime-picker__btn--primary {
  background: var(--ms-primary, #2f6fed);
  border-color: var(--ms-primary, #2f6fed);
  color: #fff;
}
.meta-datetime-picker__btn:disabled { cursor: not-allowed; opacity: 0.5; }
</style>
