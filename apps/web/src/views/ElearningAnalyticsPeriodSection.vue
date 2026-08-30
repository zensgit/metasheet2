<template>
  <section class="analytics-period" aria-labelledby="elearning-analytics-period-title" data-testid="elearning-analytics-period-section">
    <header>
      <h2 id="elearning-analytics-period-title">{{ text('Period summary', '区间汇总') }}</h2>
      <p>{{ text('Aggregate one department across an inclusive UTC date range.', '按 UTC 日期区间汇总单个部门。') }}</p>
    </header>

    <form class="analytics-period__form" data-testid="elearning-analytics-period-form" @submit.prevent="void load()">
      <label>
        <span>{{ text('Department ID', '部门 ID') }}</span>
        <input v-model="departmentId" data-testid="elearning-analytics-period-department" type="text" autocomplete="off" :disabled="loading">
      </label>
      <label>
        <span>{{ text('Start date', '开始日期') }}</span>
        <input v-model="startDate" data-testid="elearning-analytics-period-start" type="date" :disabled="loading">
      </label>
      <label>
        <span>{{ text('End date', '结束日期') }}</span>
        <input v-model="endDate" data-testid="elearning-analytics-period-end" type="date" :disabled="loading">
      </label>
      <button data-testid="elearning-analytics-period-submit" type="submit" :disabled="loading">
        {{ loading ? text('Loading...', '正在查询…') : text('Load summary', '查询汇总') }}
      </button>
    </form>

    <p v-if="error" class="analytics-period__status analytics-period__status--error" data-testid="elearning-analytics-period-error" role="status">
      {{ error }}
    </p>
    <article v-if="result" class="analytics-period__result" data-testid="elearning-analytics-period-result">
      <strong>{{ startDate }} – {{ endDate }}</strong>
      <p v-if="result.suppressed" data-testid="elearning-analytics-period-suppressed">
        {{ text('Suppressed because the department is below the privacy threshold.', '因部门人数低于隐私阈值，统计值已抑制。') }}
      </p>
      <dl v-else class="analytics-period__metrics" data-testid="elearning-analytics-period-metrics">
        <template v-for="metric in metrics(result.metrics)" :key="metric.label">
          <dt>{{ metric.label }}</dt>
          <dd>{{ metric.value }}</dd>
        </template>
      </dl>
    </article>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  getElearningDepartmentStatsPeriod,
  type ElearningDepartmentStatsDailyMetrics,
  type ElearningDepartmentStatsPeriod,
} from '../services/elearningAnalytics'

const { isZh } = useLocale()
const departmentId = ref('')
const endDate = ref(previousUtcDate())
const startDate = ref(daysBefore(endDate.value, 6))
const loading = ref(false)
const error = ref('')
const result = ref<ElearningDepartmentStatsPeriod | null>(null)

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function previousUtcDate(): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function daysBefore(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function nextUtcDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return ''
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 400) return text('Enter a valid department and date range.', '请输入有效的部门和日期区间。')
    if (value.status === 403) return text('This department is outside your management scope.', '该部门不在您的管理范围内。')
    if (value.status === 404) return text('No department data exists for this range.', '该区间暂无部门数据。')
  }
  return text('Unable to load the period summary.', '无法加载区间汇总。')
}

function metrics(value: ElearningDepartmentStatsDailyMetrics): Array<{ label: string; value: string }> {
  return [
    { label: text('Assigned', '已指派'), value: String(value.assignedCount) },
    { label: text('Completed', '已完成'), value: String(value.completedCount) },
    { label: text('Completion rate', '完成率'), value: `${(value.completionRate * 100).toFixed(1)}%` },
    { label: text('Overdue', '已逾期'), value: String(value.overdueCount) },
    { label: text('Learners', '学习人数'), value: String(value.learnerCount) },
    { label: text('Members', '部门人数'), value: String(value.memberCount) },
    { label: text('Exam participants', '考试人数'), value: String(value.examParticipantCount) },
    { label: text('Learning seconds', '学习秒数'), value: String(value.learningSeconds) },
    { label: text('Credit total', '总学分'), value: String(value.creditTotal) },
    { label: text('Credit average', '平均学分'), value: String(value.creditAverage) },
  ]
}

async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await getElearningDepartmentStatsPeriod(
      departmentId.value.trim(),
      `${startDate.value}T00:00:00.000Z`,
      `${nextUtcDay(endDate.value)}T00:00:00.000Z`,
    )
  } catch (value) {
    error.value = errorText(value)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.analytics-period,
.analytics-period__form,
.analytics-period__result {
  display: grid;
  gap: 12px;
}

.analytics-period {
  border: 1px solid #dfe7f4;
  border-radius: 10px;
  padding: 14px;
  background: #fff;
}

.analytics-period h2,
.analytics-period p {
  margin: 0;
}

.analytics-period__form {
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  align-items: end;
}

.analytics-period__form label {
  display: grid;
  gap: 6px;
}

.analytics-period__form input,
.analytics-period__form button {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

.analytics-period__form button {
  border: 0;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}

.analytics-period__status,
.analytics-period__result {
  border-radius: 8px;
  padding: 10px 12px;
  background: #eef7ff;
}

.analytics-period__status--error {
  color: #9b1c1c;
  background: #fdecec;
}

.analytics-period__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin: 0;
}

.analytics-period__metrics dt {
  color: #5f7088;
}

.analytics-period__metrics dd {
  margin: 2px 0 0;
  font-weight: 600;
}
</style>
