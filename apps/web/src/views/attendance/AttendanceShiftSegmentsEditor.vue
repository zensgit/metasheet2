<template>
  <div class="shift-segments" data-attendance-shift-segments>
    <div class="shift-segments__header">
      <span>{{ tr('Paid work segments', '计薪工作时段') }}</span>
      <button
        class="shift-segments__icon-button"
        type="button"
        :disabled="!canAddSegment"
        :title="addSegmentTitle"
        :aria-label="tr('Add segment', '添加时段')"
        data-attendance-shift-segment-add
        @click="addSegment"
      >
        <Plus />
      </button>
    </div>

    <div
      v-for="(segment, segmentIndex) in segments"
      :key="`shift-segment-${segmentIndex}`"
      class="shift-segments__row"
      data-attendance-shift-segment-row
    >
      <strong>{{ tr(`Segment ${segmentIndex + 1}`, `时段 ${segmentIndex + 1}`) }}</strong>
      <label class="shift-segments__field">
        <span>{{ tr('Start', '开始') }}</span>
        <input
          v-model="segment.startTime"
          type="time"
          step="60"
          :data-attendance-shift-segment-start="segmentIndex"
        />
      </label>
      <label class="shift-segments__field">
        <span>{{ tr('End', '结束') }}</span>
        <input
          v-model="segment.endTime"
          type="time"
          step="60"
          :data-attendance-shift-segment-end="segmentIndex"
        />
      </label>
      <label class="shift-segments__field">
        <span>{{ tr('End day', '结束日期') }}</span>
        <select
          v-model.number="segment.endDayOffset"
          :data-attendance-shift-segment-end-day="segmentIndex"
        >
          <option :value="0">{{ tr('Same day', '当日') }}</option>
          <option :value="1">{{ tr('Next day', '次日') }}</option>
        </select>
      </label>
      <div class="shift-segments__actions">
        <button
          class="shift-segments__icon-button"
          type="button"
          :disabled="segmentIndex === 0"
          :title="tr('Move segment up', '上移时段')"
          :aria-label="tr(`Move segment ${segmentIndex + 1} up`, `上移时段 ${segmentIndex + 1}`)"
          :data-attendance-shift-segment-up="segmentIndex"
          @click="moveSegment(segmentIndex, -1)"
        >
          <Top />
        </button>
        <button
          class="shift-segments__icon-button"
          type="button"
          :disabled="segmentIndex === segments.length - 1"
          :title="tr('Move segment down', '下移时段')"
          :aria-label="tr(`Move segment ${segmentIndex + 1} down`, `下移时段 ${segmentIndex + 1}`)"
          :data-attendance-shift-segment-down="segmentIndex"
          @click="moveSegment(segmentIndex, 1)"
        >
          <Bottom />
        </button>
        <button
          class="shift-segments__icon-button shift-segments__icon-button--danger"
          type="button"
          :disabled="segments.length === 1"
          :title="tr('Remove segment', '删除时段')"
          :aria-label="tr(`Remove segment ${segmentIndex + 1}`, `删除时段 ${segmentIndex + 1}`)"
          :data-attendance-shift-segment-remove="segmentIndex"
          @click="removeSegment(segmentIndex)"
        >
          <Delete />
        </button>
      </div>
    </div>

    <ul
      v-if="analysis.errors.length"
      class="shift-segments__errors"
      role="alert"
      data-attendance-shift-segment-errors
    >
      <li v-for="error in analysis.errors" :key="error">{{ error }}</li>
    </ul>

    <div
      class="shift-segments__preview"
      data-attendance-shift-segment-preview
      :data-planned-minutes="analysis.plannedMinutes"
      :data-gap-minutes="analysis.unpaidGapMinutes"
    >
      <span>
        <strong>{{ analysis.plannedMinutes }}</strong>
        {{ tr('paid min', '计薪分钟') }}
      </span>
      <span>
        <strong>{{ analysis.unpaidGapMinutes }}</strong>
        {{ tr('unpaid gap min', '非计薪间隔分钟') }}
      </span>
      <span>{{ analysis.midnightCrossings ? tr('Crosses midnight', '跨午夜') : tr('Same-day', '当日') }}</span>
      <span>{{ analysis.flexEligible ? tr('Flex eligible', '可配置弹性') : tr('Flex unavailable', '不可配置弹性') }}</span>
      <span>{{ tr('Envelope', '兼容时间窗') }}: {{ analysis.compatibilityEnvelope }}</span>
    </div>

    <p
      v-if="previewOnly"
      class="shift-segments__warning"
      role="status"
      data-attendance-shift-segment-preview-only
    >
      {{
        tr(
          'Preview only: you may save and edit this shift, but it cannot be assigned, rotated, swapped, dispatched, published, or auto-matched until authoritative segment calculation is enabled.',
          '仅供预览：可以保存和编辑，但在权威分段核算启用前，不能用于分配、轮班、换班、调度、发布或自动匹配。',
        )
      }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { Bottom, Delete, Plus, Top } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type {
  AttendanceShiftSegmentAnalysis,
  AttendanceShiftSegmentDraft,
} from './attendanceShiftSegments'

defineProps<{
  analysis: AttendanceShiftSegmentAnalysis
  previewOnly: boolean
}>()

const segments = defineModel<AttendanceShiftSegmentDraft[]>('segments', { required: true })
const { isZh } = useLocale()
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)
const canAddSegment = computed(() => (
  segments.value.length < 3
  && segments.value[segments.value.length - 1]?.endDayOffset !== 1
))
const addSegmentTitle = computed(() => (
  segments.value[segments.value.length - 1]?.endDayOffset === 1
    ? tr('A cross-midnight segment must be last.', '跨午夜时段必须是最后一段。')
    : tr('Add segment', '添加时段')
))

function addSegment(): void {
  if (!canAddSegment.value) return
  const previous = segments.value[segments.value.length - 1]
  const startTime = previous?.endTime ?? '09:00'
  const [hour = 9, minute = 0] = startTime.split(':').map(Number)
  const nextTotalMinutes = hour * 60 + minute + 60
  const nextHour = Math.floor((nextTotalMinutes % 1440) / 60)
  const nextMinute = nextTotalMinutes % 60
  segments.value.push({
    startTime,
    startDayOffset: 0,
    endTime: `${String(nextHour).padStart(2, '0')}:${String(nextMinute).padStart(2, '0')}`,
    endDayOffset: nextTotalMinutes >= 1440 ? 1 : 0,
  })
}

function moveSegment(index: number, direction: -1 | 1): void {
  const target = index + direction
  if (target < 0 || target >= segments.value.length) return
  const [segment] = segments.value.splice(index, 1)
  if (segment) segments.value.splice(target, 0, segment)
}

function removeSegment(index: number): void {
  if (segments.value.length <= 1) return
  segments.value.splice(index, 1)
}
</script>

<style scoped>
.shift-segments {
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

.shift-segments__header,
.shift-segments__actions,
.shift-segments__preview {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
}

.shift-segments__header {
  justify-content: space-between;
  color: var(--ms-text-1);
  font-weight: var(--ms-font-weight-title);
}

.shift-segments__row {
  display: grid;
  grid-template-columns: minmax(72px, max-content) repeat(3, minmax(140px, 1fr)) max-content;
  align-items: end;
  gap: var(--ms-space-3);
  padding-top: var(--ms-space-3);
  border-top: 1px solid var(--ms-border-light);
}

.shift-segments__row > strong {
  align-self: center;
  color: var(--ms-text-1);
}

.shift-segments__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: var(--ms-text-2);
}

.shift-segments__field input,
.shift-segments__field select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
}

.shift-segments__actions {
  min-height: 36px;
}

.shift-segments__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
}

.shift-segments__icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.shift-segments__icon-button--danger {
  border-color: var(--ms-color-danger);
  color: var(--ms-color-danger);
}

.shift-segments__icon-button svg {
  width: 16px;
  height: 16px;
}

.shift-segments__errors {
  margin: 0;
  padding-left: 20px;
  color: var(--ms-color-danger);
}

.shift-segments__preview {
  flex-wrap: wrap;
  color: var(--ms-text-2);
  font-variant-numeric: tabular-nums;
}

.shift-segments__preview span {
  padding-right: var(--ms-space-3);
  border-right: 1px solid var(--ms-border-light);
}

.shift-segments__preview span:last-child {
  padding-right: 0;
  border-right: 0;
}

.shift-segments__warning {
  margin: 0;
  padding: var(--ms-space-3);
  border-left: 3px solid var(--ms-color-warning);
  color: var(--ms-text-1);
  background: var(--ms-bg-page);
}

@media (max-width: 768px) {
  .shift-segments__row {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .shift-segments__actions {
    justify-content: flex-end;
  }
}
</style>
