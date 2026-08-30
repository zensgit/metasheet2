<template>
  <section class="analytics-admin" aria-labelledby="elearning-analytics-title" data-testid="elearning-analytics-admin-section">
    <header>
      <h2 id="elearning-analytics-title">{{ text('Department analytics', '部门学习统计') }}</h2>
      <p>{{ text('Read one completed UTC day. Small groups remain suppressed.', '查询一个已完成的 UTC 日期；小样本保持抑制。') }}</p>
    </header>

    <form class="analytics-admin__form" data-testid="elearning-analytics-form" @submit.prevent="void load()">
      <label>
        <span>{{ text('Department ID', '部门 ID') }}</span>
        <input v-model="departmentId" data-testid="elearning-analytics-department" type="text" autocomplete="off" :disabled="loading">
      </label>
      <label>
        <span>{{ text('Statistics date (UTC)', '统计日期（UTC）') }}</span>
        <input v-model="statsDate" data-testid="elearning-analytics-date" type="date" :disabled="loading">
      </label>
      <button data-testid="elearning-analytics-submit" type="submit" :disabled="loading">
        {{ loading ? text('Loading...', '正在查询…') : text('Load statistics', '查询统计') }}
      </button>
    </form>

    <p v-if="error" class="analytics-admin__status analytics-admin__status--error" data-testid="elearning-analytics-error" role="status">
      {{ error }}
    </p>
    <article v-if="result" class="analytics-admin__result" data-testid="elearning-analytics-result">
      <header>
        <strong>{{ result.statsDate }}</strong>
        <span>{{ text(`Projection v${result.projectedVersion}`, `投影版本 ${result.projectedVersion}`) }}</span>
      </header>
      <p v-if="result.suppressed" data-testid="elearning-analytics-suppressed">
        {{ text(`Suppressed: fewer than ${result.minGroupSize} learners.`, `已抑制：学习人数少于 ${result.minGroupSize}。`) }}
      </p>
      <dl v-else class="analytics-admin__metrics" data-testid="elearning-analytics-metrics">
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
  getElearningDepartmentStatsDaily,
  type ElearningDepartmentStatsDaily,
  type ElearningDepartmentStatsDailyMetrics,
} from '../services/elearningAnalytics'

const { isZh } = useLocale()
const departmentId = ref('')
const statsDate = ref(previousUtcDate())
const loading = ref(false)
const error = ref('')
const result = ref<ElearningDepartmentStatsDaily | null>(null)

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function previousUtcDate(): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 400) return text('Enter a valid department ID and UTC date.', '请输入有效的部门 ID 和 UTC 日期。')
    if (value.status === 403) return text('This department is outside your management scope.', '该部门不在您的管理范围内。')
    if (value.status === 404) return text('No daily projection exists for this date.', '该日期暂无统计投影。')
  }
  return text('Unable to load department analytics.', '无法加载部门学习统计。')
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
    result.value = await getElearningDepartmentStatsDaily(
      departmentId.value.trim(),
      statsDate.value,
    )
  } catch (value) {
    error.value = errorText(value)
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.analytics-admin,
.analytics-admin__form,
.analytics-admin__result {
  display: grid;
  gap: 12px;
}

.analytics-admin {
  border: 1px solid #dfe7f4;
  border-radius: 10px;
  padding: 14px;
  background: #fff;
}

.analytics-admin h2,
.analytics-admin p {
  margin: 0;
}

.analytics-admin__form {
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  align-items: end;
}

.analytics-admin__form label {
  display: grid;
  gap: 6px;
}

.analytics-admin__form input,
.analytics-admin__form button {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

.analytics-admin__form button {
  border: 0;
  background: #2563eb;
  color: #fff;
  cursor: pointer;
}

.analytics-admin__status,
.analytics-admin__result {
  border-radius: 8px;
  padding: 10px 12px;
  background: #eef7ff;
}

.analytics-admin__status--error {
  color: #9b1c1c;
  background: #fdecec;
}

.analytics-admin__result header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.analytics-admin__metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
  margin: 0;
}

.analytics-admin__metrics dt {
  color: #5f7088;
}

.analytics-admin__metrics dd {
  margin: 2px 0 0;
  font-weight: 600;
}
</style>
