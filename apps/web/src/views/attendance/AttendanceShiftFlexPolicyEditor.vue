<template>
  <div class="shift-flex" data-attendance-shift-flex>
    <div class="shift-flex__header">
      <span>{{ tr('Flexible attendance', '弹性考勤') }}</span>
      <span
        class="shift-flex__badge"
        :data-flex-eligible="flexEligible ? 'true' : 'false'"
      >
        {{ flexEligible ? tr('Single-segment eligible', '单时段可配置') : tr('Multi-segment blocked', '多时段不可用') }}
      </span>
    </div>

    <label class="shift-flex__field">
      <span>{{ tr('Mode', '模式') }}</span>
      <select
        v-model="mode"
        data-attendance-shift-flex-mode
        :disabled="!flexEligible && mode === 'strict'"
      >
        <option value="strict">{{ tr('Strict (fixed segment times)', '严格（固定时段）') }}</option>
        <option value="flex_required_duration" :disabled="!flexEligible">
          {{ tr('Flex required duration', '弹性应工时') }}
        </option>
      </select>
    </label>

    <template v-if="mode === 'flex_required_duration'">
      <div class="shift-flex__grid">
        <label class="shift-flex__field">
          <span>{{ tr('Required minutes', '应工时（分钟）') }}</span>
          <input
            v-model.number="requiredMinutes"
            type="number"
            min="1"
            max="1440"
            step="1"
            data-attendance-shift-flex-required-minutes
          />
        </label>
        <label class="shift-flex__field">
          <span>{{ tr('Arrival window before (min)', '到岗窗口提前（分钟）') }}</span>
          <input
            v-model.number="arrivalWindowBeforeMinutes"
            type="number"
            min="0"
            step="1"
            data-attendance-shift-flex-arrival-before
          />
        </label>
        <label class="shift-flex__field">
          <span>{{ tr('Arrival window after (min)', '到岗窗口延后（分钟）') }}</span>
          <input
            v-model.number="arrivalWindowAfterMinutes"
            type="number"
            min="0"
            step="1"
            data-attendance-shift-flex-arrival-after
          />
        </label>
        <label class="shift-flex__field">
          <span>{{ tr('Core start (optional)', '核心开始（可选）') }}</span>
          <input
            v-model="coreStartTime"
            type="time"
            step="60"
            data-attendance-shift-flex-core-start
          />
        </label>
        <label class="shift-flex__field">
          <span>{{ tr('Core end (optional)', '核心结束（可选）') }}</span>
          <input
            v-model="coreEndTime"
            type="time"
            step="60"
            data-attendance-shift-flex-core-end
          />
        </label>
      </div>
    </template>

    <ul
      v-if="analysis.errors.length"
      class="shift-flex__errors"
      role="alert"
      data-attendance-shift-flex-errors
    >
      <li v-for="error in analysis.errors" :key="error">{{ error }}</li>
    </ul>

    <ul class="shift-flex__explain" data-attendance-shift-flex-explain>
      <li v-for="line in analysis.explain" :key="line">{{ line }}</li>
      <li>
        {{
          tr(
            'Grace is not flexibility: late/early grace only moves thresholds after the flex expectation is resolved.',
            '宽限不是弹性：迟到/早退宽限只在弹性期望解析之后移动阈值。',
          )
        }}
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import {
  analyzeAttendanceShiftFlexPolicy,
  type AttendanceShiftFlexPolicy,
} from './attendanceShiftSegments'

const props = defineProps<{
  flexEligible: boolean
  analysis: ReturnType<typeof analyzeAttendanceShiftFlexPolicy>
}>()

const model = defineModel<AttendanceShiftFlexPolicy>('policy', { required: true })
const { isZh } = useLocale()
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)

const mode = computed({
  get: () => model.value.mode,
  set: (next: 'strict' | 'flex_required_duration') => {
    if (next === 'strict') {
      model.value = { mode: 'strict' }
      return
    }
    if (!props.flexEligible) return
    const current = model.value
    model.value = {
      mode: 'flex_required_duration',
      requiredMinutes: current.mode === 'flex_required_duration' ? current.requiredMinutes : 480,
      arrivalWindowBeforeMinutes:
        current.mode === 'flex_required_duration' ? current.arrivalWindowBeforeMinutes : 60,
      arrivalWindowAfterMinutes:
        current.mode === 'flex_required_duration' ? current.arrivalWindowAfterMinutes : 120,
      coreStartTime: current.mode === 'flex_required_duration' ? current.coreStartTime : null,
      coreEndTime: current.mode === 'flex_required_duration' ? current.coreEndTime : null,
    }
  },
})

const requiredMinutes = computed({
  get: () => (model.value.mode === 'flex_required_duration' ? model.value.requiredMinutes : 480),
  set: (value: number) => {
    if (model.value.mode !== 'flex_required_duration') return
    model.value = { ...model.value, requiredMinutes: value }
  },
})

const arrivalWindowBeforeMinutes = computed({
  get: () => (
    model.value.mode === 'flex_required_duration' ? model.value.arrivalWindowBeforeMinutes : 0
  ),
  set: (value: number) => {
    if (model.value.mode !== 'flex_required_duration') return
    model.value = { ...model.value, arrivalWindowBeforeMinutes: value }
  },
})

const arrivalWindowAfterMinutes = computed({
  get: () => (
    model.value.mode === 'flex_required_duration' ? model.value.arrivalWindowAfterMinutes : 0
  ),
  set: (value: number) => {
    if (model.value.mode !== 'flex_required_duration') return
    model.value = { ...model.value, arrivalWindowAfterMinutes: value }
  },
})

const coreStartTime = computed({
  get: () => (
    model.value.mode === 'flex_required_duration' ? (model.value.coreStartTime ?? '') : ''
  ),
  set: (value: string) => {
    if (model.value.mode !== 'flex_required_duration') return
    model.value = { ...model.value, coreStartTime: value || null }
  },
})

const coreEndTime = computed({
  get: () => (
    model.value.mode === 'flex_required_duration' ? (model.value.coreEndTime ?? '') : ''
  ),
  set: (value: string) => {
    if (model.value.mode !== 'flex_required_duration') return
    model.value = { ...model.value, coreEndTime: value || null }
  },
})
</script>

<style scoped>
.shift-flex {
  display: grid;
  grid-column: 1 / -1;
  gap: var(--ms-space-3);
  min-width: 0;
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  font-size: 12px;
}

.shift-flex__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2);
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.shift-flex__badge {
  color: var(--ms-text-2);
  font-weight: var(--ms-font-weight-normal, 400);
}

.shift-flex__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--ms-space-2);
}

.shift-flex__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.shift-flex__field input,
.shift-flex__field select {
  min-width: 0;
  width: 100%;
}

.shift-flex__errors {
  margin: 0;
  padding-left: 1.2em;
  color: var(--ms-danger, #b42318);
}

.shift-flex__explain {
  margin: 0;
  padding-left: 1.2em;
  color: var(--ms-text-2);
}
</style>
