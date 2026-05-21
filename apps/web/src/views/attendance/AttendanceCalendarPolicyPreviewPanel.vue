<template>
  <div class="attendance__calendar-preview" data-attendance-calendar-policy-preview>
    <div class="attendance__calendar-preview-header">
      <div>
        <h5>{{ tr('Preview effective calendar', '预览有效日历') }}</h5>
        <p class="attendance__field-hint">
          {{ tr('Uses the saved effective-calendar resolver. Unsaved edits must be saved first.', '使用已保存的有效日历解析器；未保存的修改需先保存。') }}
        </p>
      </div>
      <button
        class="attendance__btn"
        type="button"
        :disabled="previewLoading"
        data-attendance-calendar-policy-preview-run
        @click="runPreview"
      >
        {{ previewLoading ? tr('Previewing...', '预览中...') : tr('Preview', '预览') }}
      </button>
    </div>

    <div class="attendance__calendar-preview-controls">
      <label class="attendance__field">
        <span>{{ tr('From', '开始日期') }}</span>
        <input v-model="previewFrom" type="date" data-attendance-calendar-policy-preview-from />
      </label>
      <label class="attendance__field">
        <span>{{ tr('To', '结束日期') }}</span>
        <input v-model="previewTo" type="date" data-attendance-calendar-policy-preview-to />
      </label>
      <label class="attendance__field">
        <span>{{ tr('Scope', '范围') }}</span>
        <select v-model="previewMode" data-attendance-calendar-policy-preview-mode>
          <option value="orgOnly">{{ tr('Organization', '组织') }}</option>
          <option value="groupId">{{ tr('Attendance group', '考勤组') }}</option>
          <option value="userId">{{ tr('User', '用户') }}</option>
        </select>
      </label>
      <label v-if="previewMode === 'groupId'" class="attendance__field">
        <span>{{ tr('Group ID or code', '考勤组 ID 或编码') }}</span>
        <input v-model="previewGroupId" type="text" placeholder="group_1" data-attendance-calendar-policy-preview-group />
      </label>
      <label v-if="previewMode === 'userId'" class="attendance__field">
        <span>{{ tr('User ID', '用户 ID') }}</span>
        <input v-model="previewUserId" type="text" placeholder="user_1" data-attendance-calendar-policy-preview-user />
      </label>
    </div>

    <p v-if="previewError" class="attendance__status attendance__status--error" data-attendance-calendar-policy-preview-error>
      {{ previewError }}
    </p>

    <div v-if="previewResult" class="attendance__calendar-preview-result" data-attendance-calendar-policy-preview-result>
      <div class="attendance__admin-meta">
        <strong>{{ tr('Result', '结果') }}</strong>
        <span>{{ modeLabel(previewResult.mode) }}</span>
        <span>{{ previewResult.from }} → {{ previewResult.to }}</span>
        <span>{{ previewResult.timezone }}</span>
        <span>{{ previewResult.items.length }} {{ tr('day(s)', '天') }}</span>
      </div>
      <div v-if="previewResult.items.length === 0" class="attendance__empty">
        {{ tr('No calendar rows returned.', '暂无日历结果。') }}
      </div>
      <div v-else class="attendance__table-wrapper">
        <table class="attendance__table">
          <thead>
            <tr>
              <th>{{ tr('Date', '日期') }}</th>
              <th>{{ tr('Base', '基础') }}</th>
              <th>{{ tr('Effective', '生效') }}</th>
              <th>{{ tr('Label / policy', '标签 / 规则') }}</th>
              <th>{{ tr('Layers', '层级') }}</th>
              <th>{{ tr('Overlays', '叠加') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in previewResult.items" :key="item.date">
              <td>{{ item.date }}</td>
              <td>
                <span :class="dayClass(item.base.isWorkingDay)">{{ dayLabel(item.base.isWorkingDay) }}</span>
                <small>{{ sourceLabel(item.base.source) }}</small>
              </td>
              <td>
                <span :class="dayClass(item.effective.isWorkingDay)">{{ dayLabel(item.effective.isWorkingDay) }}</span>
                <small>{{ sourceLabel(item.effective.source) }}</small>
              </td>
              <td>
                <span>{{ item.effective.label || item.base.name || '--' }}</span>
                <small v-if="item.effective.policyId">{{ item.effective.policyId }}</small>
              </td>
              <td>{{ layerSummary(item) }}</td>
              <td>{{ overlaySummary(item) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import {
  EffectiveCalendarFetchError,
  fetchEffectiveCalendar,
  type CalendarEffectiveItem,
  type CalendarEffectiveMode,
  type CalendarEffectiveSource,
  type CalendarEffectiveResponse,
  type FetchEffectiveCalendarOptions,
} from '../../services/attendance/effectiveCalendar'

type Translate = (en: string, zh: string) => string
type PreviewMode = CalendarEffectiveMode

const props = defineProps<{
  tr: Translate
}>()

const tr = props.tr

const today = () => new Date().toISOString().slice(0, 10)
const previewFrom = ref(today())
const previewTo = ref(today())
const previewMode = ref<PreviewMode>('orgOnly')
const previewGroupId = ref('')
const previewUserId = ref('')
const previewLoading = ref(false)
const previewError = ref('')
const previewResult = ref<CalendarEffectiveResponse | null>(null)

const SOURCE_LABELS: Record<CalendarEffectiveSource, [string, string]> = {
  rule: ['Rule', '规则'],
  shift: ['Shift', '班次'],
  rotation: ['Rotation', '轮班'],
  national: ['National holiday', '法定节假日'],
  manual: ['Manual holiday', '手动节假日'],
  org: ['Organization policy', '组织规则'],
  group: ['Group policy', '考勤组规则'],
  role: ['Role policy', '角色规则'],
  user: ['User policy', '用户规则'],
}

const MODE_LABELS: Record<PreviewMode, [string, string]> = {
  orgOnly: ['Organization', '组织'],
  groupId: ['Attendance group', '考勤组'],
  userId: ['User', '用户'],
}

function dayLabel(isWorkingDay: boolean): string {
  return isWorkingDay ? tr('Working day', '工作日') : tr('Rest day', '休息日')
}

function dayClass(isWorkingDay: boolean): string {
  return isWorkingDay ? 'attendance__calendar-preview-day attendance__calendar-preview-day--work' : 'attendance__calendar-preview-day attendance__calendar-preview-day--rest'
}

function sourceLabel(source: CalendarEffectiveSource): string {
  const label = SOURCE_LABELS[source]
  return label ? tr(label[0], label[1]) : source
}

function modeLabel(mode: PreviewMode): string {
  const label = MODE_LABELS[mode]
  return label ? tr(label[0], label[1]) : mode
}

function layerSummary(item: CalendarEffectiveItem): string {
  if (!item.layers.length) return '--'
  return item.layers
    .map((layer) => `${sourceLabel(layer.source)}:${dayLabel(layer.isWorkingDay)}`)
    .join(' / ')
}

function overlaySummary(item: CalendarEffectiveItem): string {
  if (!item.overlays.length) return '--'
  return item.overlays
    .map((overlay) => overlay.label || overlay.requestType || overlay.kind)
    .join(' / ')
}

function buildPreviewOptions(): FetchEffectiveCalendarOptions | null {
  const from = previewFrom.value.trim()
  const to = previewTo.value.trim()
  if (!from || !to) {
    previewError.value = tr('From and to dates are required.', '开始和结束日期不能为空。')
    return null
  }
  if (from > to) {
    previewError.value = tr('From date must be before or equal to to date.', '开始日期必须早于或等于结束日期。')
    return null
  }

  const options: FetchEffectiveCalendarOptions = {
    from,
    to,
    suppressUnauthorizedRedirect: true,
  }
  if (previewMode.value === 'orgOnly') {
    options.orgOnly = true
    return options
  }
  if (previewMode.value === 'groupId') {
    const groupId = previewGroupId.value.trim()
    if (!groupId) {
      previewError.value = tr('Group ID or code is required.', '考勤组 ID 或编码不能为空。')
      return null
    }
    options.groupId = groupId
    return options
  }
  const userId = previewUserId.value.trim()
  if (!userId) {
    previewError.value = tr('User ID is required.', '用户 ID 不能为空。')
    return null
  }
  options.userId = userId
  return options
}

async function runPreview() {
  previewError.value = ''
  const options = buildPreviewOptions()
  if (!options) return

  previewLoading.value = true
  previewResult.value = null
  try {
    previewResult.value = await fetchEffectiveCalendar(options)
  } catch (error) {
    if (error instanceof EffectiveCalendarFetchError) {
      previewError.value = error.code ? `${error.message} (${error.code})` : error.message
    } else if (error instanceof Error) {
      previewError.value = error.message
    } else {
      previewError.value = String(error)
    }
  } finally {
    previewLoading.value = false
  }
}
</script>

<style scoped>
.attendance__calendar-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid #e5e7eb;
}

.attendance__calendar-preview-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.attendance__calendar-preview-header h5 {
  margin: 0 0 4px;
}

.attendance__calendar-preview-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.attendance__calendar-preview-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attendance__calendar-preview-day {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.attendance__calendar-preview-day--work {
  background: #e8f5e9;
  color: #1b5e20;
}

.attendance__calendar-preview-day--rest {
  background: #fff3e0;
  color: #8a4b00;
}

.attendance__calendar-preview td small {
  display: block;
  margin-top: 4px;
  color: #6b7280;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #555;
}

.attendance__field input,
.attendance__field select {
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
}

.attendance__field-hint {
  margin: 0;
  color: #777;
  font-size: 11px;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__status {
  margin: 0;
  font-size: 12px;
  color: #2e7d32;
}

.attendance__status--error {
  color: #c62828;
}

.attendance__admin-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  color: #555;
  font-size: 13px;
}

.attendance__table-wrapper {
  width: 100%;
  overflow-x: auto;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
}

.attendance__table th,
.attendance__table td {
  border-bottom: 1px solid #e0e0e0;
  padding: 8px;
  text-align: left;
  font-size: 13px;
  vertical-align: top;
}

.attendance__empty {
  color: #888;
  font-size: 13px;
}
</style>
