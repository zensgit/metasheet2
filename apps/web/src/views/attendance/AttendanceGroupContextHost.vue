<template>
  <section v-if="state.kind === 'loading'" class="attendance-group-context" data-attendance-group-context="loading">
    <p>{{ tr('Loading attendance group...', '正在加载考勤组...') }}</p>
  </section>
  <section v-else-if="state.kind === 'unavailable'" class="attendance-group-context" data-attendance-group-context="unavailable">
    <p>{{ tr('This attendance group is unavailable.', '该考勤组不可用。') }}</p>
    <button type="button" @click="emit('return')">{{ tr('Return', '返回') }}</button>
  </section>
  <section v-else-if="state.kind === 'error'" class="attendance-group-context" data-attendance-group-context="error">
    <p>{{ tr('Unable to load this attendance group.', '无法加载该考勤组。') }}</p>
    <button type="button" @click="retry">{{ tr('Retry', '重试') }}</button>
    <button type="button" @click="emit('return')">{{ tr('Return', '返回') }}</button>
  </section>
  <section v-else class="attendance-group-context" data-attendance-group-context="ready">
    <header class="attendance-group-context__breadcrumb">
      <span>{{ state.group.name }}</span>
      <span aria-hidden="true">/</span>
      <span>{{ stepLabel }}</span>
    </header>
    <slot
      :group="state.group"
      :step="state.step"
      :surface="state.surface"
      :return-to="state.returnTo"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import type { AttendanceGroupRouteContext } from '../../router/attendanceGroupContextRoute'
import { useLocale } from '../../composables/useLocale'
import { useAttendanceGroupRouteContext } from './useAttendanceGroupRouteContext'

const props = defineProps<{
  context: AttendanceGroupRouteContext | null
}>()

const emit = defineEmits<{
  (event: 'return'): void
}>()

const { state, retry } = useAttendanceGroupRouteContext({
  context: toRef(props, 'context'),
  enabled: computed(() => true),
})
const { isZh } = useLocale()
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)

const stepLabel = computed(() => {
  if (state.value.kind !== 'ready') return ''
  if (state.value.step === 'calendar') return tr('Calendar', '日历')
  if (state.value.step === 'rules') return tr('Rules', '规则')
  return tr('Schedule', '排班')
})
</script>

<style scoped>
.attendance-group-context__breadcrumb {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
