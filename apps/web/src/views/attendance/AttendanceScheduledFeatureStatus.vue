<template>
  <div
    class="scheduled-status"
    role="status"
    data-attendance-scheduled-feature-status
    :data-scheduled-feature="feature"
    :data-configured-state="view.configured"
    :data-runnable-state="view.runnable"
  >
    <!--
      A1 「提示与实际状态」: pure DISPLAY component. It renders the pre-derived view from
      `attendanceScheduledFeatureStatus.ts` and nothing else - no fetch, no button, no write door. Two rows,
      always both shown: 「已配置」 (the saved org-side policy) and 「当前是否可运行」 (the server run switches).
      An open switch is shown as "on", never as "running".
    -->
    <div class="scheduled-status__row">
      <span class="scheduled-status__label">{{ view.configLabel }}</span>
      <span
        class="scheduled-status__chip"
        :class="`scheduled-status__chip--${configuredTone}`"
        data-scheduled-feature-configured
      >{{ view.configuredLabel }}</span>
    </div>
    <div class="scheduled-status__row">
      <span class="scheduled-status__label">{{ view.runLabel }}</span>
      <span
        class="scheduled-status__chip"
        :class="`scheduled-status__chip--${runnableTone}`"
        data-scheduled-feature-runnable
      >{{ view.runnableLabel }}</span>
    </div>
    <p
      class="scheduled-status__detail"
      :class="{ 'scheduled-status__detail--warn': view.warn }"
      data-scheduled-feature-detail
    >{{ view.detail }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  describeScheduledFeatureStatus,
  type AttendanceConfiguredState,
  type AttendanceRunnableState,
  type AttendanceRuntimeGateEntry,
  type AttendanceScheduledFeatureKey,
  type TranslateFn,
} from './attendanceScheduledFeatureStatus'

const props = defineProps<{
  tr: TranslateFn
  feature: AttendanceScheduledFeatureKey
  /** From the SAVED settings the server last returned - never from an unsaved checkbox. */
  configured: AttendanceConfiguredState
  /** The server's gate report for this feature; null = not reported (treated as unknown, fail-closed). */
  gate: AttendanceRuntimeGateEntry | null
}>()

const view = computed(() => describeScheduledFeatureStatus(props.tr, {
  feature: props.feature,
  configured: props.configured,
  gate: props.gate,
}))

type Tone = 'ok' | 'info' | 'warn' | 'muted'

const configuredTone = computed<Tone>(() => {
  const state: AttendanceConfiguredState = view.value.configured
  if (state === 'configured') return 'ok'
  if (state === 'incomplete') return 'warn'
  return 'muted'
})

// An open switch is neutral blue, deliberately NOT the success green of "configured": open only means "not
// blocked by these gates", not "running".
const runnableTone = computed<Tone>(() => {
  const state: AttendanceRunnableState = view.value.runnable
  if (state === 'open') return 'info'
  if (state === 'closed') return 'warn'
  return 'muted'
})
</script>

<style scoped>
.scheduled-status {
  display: grid;
  gap: var(--ms-space-1);
  margin: var(--ms-space-2) 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-page);
  font-size: 12px;
}

.scheduled-status__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.scheduled-status__label {
  min-width: 96px;
  color: var(--ms-text-2);
}

.scheduled-status__chip {
  padding: 2px var(--ms-space-2);
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  background: var(--ms-bg-card);
  color: var(--ms-text-2);
}

.scheduled-status__chip--ok {
  border-color: var(--ms-color-success);
  color: var(--ms-text-1);
}

.scheduled-status__chip--info {
  border-color: var(--ms-color-primary);
  color: var(--ms-text-1);
}

.scheduled-status__chip--warn {
  border-color: var(--ms-color-warning);
  color: var(--ms-text-1);
}

.scheduled-status__chip--muted {
  color: var(--ms-text-3);
}

.scheduled-status__detail {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.scheduled-status__detail--warn {
  color: var(--ms-text-1);
  font-weight: 600;
}
</style>
