<template>
  <section class="request-timezone" aria-live="polite" data-request-timezone>
    <p v-if="loading">{{ tr('Loading target shift timezone…', '正在读取目标班次时区…') }}</p>
    <p v-else-if="failed">{{ attendanceTimezoneErrorMessage(errorCode, tr) ?? tr('Target timezone could not be confirmed. Refresh before submitting.', '无法确认目标班次时区，请刷新后再提交。') }}</p>
    <p v-else-if="target">{{ tr('Target shift timezone', '目标班次时区') }}: {{ target.timezone }} · {{ target.workDate }}</p>
    <p v-else>{{ tr('Select a valid work date to confirm its timezone.', '请选择有效工作日期以确认考勤时区。') }}</p>
    <button type="button" :disabled="loading" @click="$emit('refresh')">{{ tr('Refresh timezone', '刷新时区') }}</button>
    <template v-for="endpoint in endpoints" :key="endpoint.key">
      <label v-if="resolved[endpoint.key].kind === 'fold'" class="request-timezone__choice">
        <span>{{ tr(endpoint.en, endpoint.zh) }}</span>
        <select :value="selected[endpoint.key]" @change="select(endpoint.key, $event)">
          <option value="">{{ tr('Confirm the repeated time offset', '确认重复时间的偏移') }}</option>
          <option v-for="choice in resolved[endpoint.key].choices" :key="choice.instant" :value="choice.instant">
            {{ choice.offsetLabel }}
          </option>
        </select>
      </label>
      <p v-else-if="resolved[endpoint.key].kind === 'gap'">{{ tr(endpoint.en, endpoint.zh) }}: {{ tr('This local time does not exist.', '这个当地时间不存在。') }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { attendanceTimezoneErrorMessage } from './attendanceTimezoneError'
import type { AttendanceTimezoneTarget } from './attendanceTimezoneTarget'
import type { AttendanceWallTimeResult } from './attendanceWallTime'

defineProps<{
  tr: (en: string, zh: string) => string
  target: AttendanceTimezoneTarget | null
  loading: boolean
  failed: boolean
  errorCode?: unknown
  selected: { inAt: string; outAt: string }
  resolved: { inAt: AttendanceWallTimeResult; outAt: AttendanceWallTimeResult }
}>()
const emit = defineEmits<{
  refresh: []
  select: [key: 'inAt' | 'outAt', value: string]
}>()
const endpoints = [
  { key: 'inAt' as const, en: 'Start / requested in', zh: '开始／申请上班时间' },
  { key: 'outAt' as const, en: 'End / requested out', zh: '结束／申请下班时间' },
]
function select(key: 'inAt' | 'outAt', event: Event): void {
  emit('select', key, (event.target as HTMLSelectElement).value)
}
</script>

<style scoped>
.request-timezone { display: grid; gap: 8px; grid-column: 1 / -1; padding: 10px; border: 1px solid var(--ms-border-light); border-radius: var(--ms-radius-md); }
.request-timezone p { margin: 0; }
.request-timezone button { justify-self: start; }
.request-timezone__choice { display: grid; gap: 4px; }
.request-timezone select { min-width: 0; max-width: 100%; }
</style>
