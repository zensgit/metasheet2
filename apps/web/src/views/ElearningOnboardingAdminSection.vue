<template>
  <section class="onboarding" aria-labelledby="elearning-onboarding-title" data-testid="elearning-onboarding-section">
    <header>
      <h2 id="elearning-onboarding-title">{{ text('New employee learning', '新员工学习') }}</h2>
      <p>{{ description() }}</p>
    </header>

    <form
      v-if="assignmentEnabled"
      class="onboarding__form"
      data-testid="elearning-onboarding-policy-form"
      @submit.prevent="void createPolicy()"
    >
      <label>
        <span>{{ text('Training plan ID', '培训计划 ID') }}</span>
        <input v-model="trainingPlanId" data-testid="elearning-onboarding-plan" type="text" autocomplete="off" :disabled="busy">
      </label>
      <label>
        <span>{{ text('Match by', '匹配方式') }}</span>
        <select v-model="subjectType" data-testid="elearning-onboarding-subject-type" :disabled="busy">
          <option value="department">{{ text('Department', '部门') }}</option>
          <option value="position">{{ text('Position', '岗位') }}</option>
        </select>
      </label>
      <label>
        <span>{{ subjectType === 'department' ? text('Department ID', '部门 ID') : text('Position', '岗位') }}</span>
        <input v-model="subjectRef" data-testid="elearning-onboarding-subject-ref" type="text" autocomplete="off" :disabled="busy">
      </label>
      <label v-if="subjectType === 'department'" class="onboarding__check">
        <input v-model="includeChildren" data-testid="elearning-onboarding-include-children" type="checkbox" :disabled="busy">
        <span>{{ text('Include child departments', '包含子部门') }}</span>
      </label>
      <label>
        <span>{{ text('Hire window (days)', '入职匹配窗口（天）') }}</span>
        <input v-model.number="hireWindowDays" data-testid="elearning-onboarding-hire-window" type="number" min="0" max="365" step="1" :disabled="busy">
      </label>
      <label>
        <span>{{ text('Completion deadline (days)', '完成期限（天）') }}</span>
        <input v-model.number="deadlineDays" data-testid="elearning-onboarding-deadline" type="number" min="0" max="3650" step="1" :disabled="busy">
      </label>
      <label class="onboarding__check">
        <input v-model="weeklyReportEnabled" data-testid="elearning-onboarding-weekly-enabled" type="checkbox" :disabled="busy">
        <span>{{ text('Create weekly aggregate reports', '生成每周聚合报告') }}</span>
      </label>
      <button data-testid="elearning-onboarding-create" type="submit" :disabled="busy">
        {{ busy ? text('Saving...', '保存中…') : text('Create policy', '创建策略') }}
      </button>
    </form>

    <article v-if="policy" class="onboarding__policy" data-testid="elearning-onboarding-policy-result">
      <strong>{{ policy.policyId }}</strong>
      <span>{{ policy.status }}</span>
      <button
        v-if="assignmentEnabled && policy.status === 'active'"
        data-testid="elearning-onboarding-retire"
        type="button"
        :disabled="busy"
        @click="void retirePolicy()"
      >
        {{ text('Retire policy', '停用策略') }}
      </button>
    </article>

    <form
      v-if="analyticsEnabled"
      class="onboarding__form onboarding__report-form"
      data-testid="elearning-onboarding-report-form"
      @submit.prevent="void loadReport()"
    >
      <label>
        <span>{{ text('Policy ID', '策略 ID') }}</span>
        <input v-model="reportPolicyId" data-testid="elearning-onboarding-report-policy" type="text" autocomplete="off" :disabled="reportBusy">
      </label>
      <label>
        <span>{{ text('Week start', '周开始日期') }}</span>
        <input v-model="weekStart" data-testid="elearning-onboarding-week-start" type="date" :disabled="reportBusy">
      </label>
      <button data-testid="elearning-onboarding-report-load" type="submit" :disabled="reportBusy">
        {{ reportBusy ? text('Loading...', '查询中…') : text('Load weekly report', '查询周报') }}
      </button>
    </form>

    <article v-if="report" class="onboarding__report" data-testid="elearning-onboarding-report-result">
      <strong>{{ report.weekStart }} – {{ report.weekEnd }}</strong>
      <p v-if="report.suppressed" data-testid="elearning-onboarding-report-suppressed">
        {{ text('Values are suppressed because the group is below the privacy threshold.', '因样本数低于隐私阈值，统计值已抑制。') }}
      </p>
      <dl v-else data-testid="elearning-onboarding-report-counts">
        <dt>{{ text('Enqueued', '已入队') }}</dt><dd>{{ report.enqueuedCount }}</dd>
        <dt>{{ text('Assigned learners', '已指派学员') }}</dt><dd>{{ report.assignedUserCount }}</dd>
        <dt>{{ text('Failed', '失败') }}</dt><dd>{{ report.failedCount }}</dd>
        <dt>{{ text('Dead', '终止') }}</dt><dd>{{ report.deadCount }}</dd>
      </dl>
    </article>

    <p v-if="status" class="onboarding__status" data-testid="elearning-onboarding-status" role="status">
      {{ status }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  createElearningOnboardingPolicy,
  getElearningOnboardingWeeklyReport,
  retireElearningOnboardingPolicy,
  type ElearningOnboardingPolicy,
  type ElearningOnboardingPolicyCommand,
  type ElearningOnboardingSubjectType,
  type ElearningOnboardingWeeklyReport,
} from '../services/elearningOnboarding'

const props = defineProps<{
  assignmentEnabled: boolean
  analyticsEnabled: boolean
}>()

const { isZh } = useLocale()
const trainingPlanId = ref('')
const subjectType = ref<ElearningOnboardingSubjectType>('department')
const subjectRef = ref('')
const includeChildren = ref(false)
const hireWindowDays = ref(30)
const deadlineDays = ref(30)
const weeklyReportEnabled = ref(true)
const busy = ref(false)
const policy = ref<ElearningOnboardingPolicy | null>(null)
const reportPolicyId = ref('')
const weekStart = ref(previousClosedWeekMonday())
const reportBusy = ref(false)
const report = ref<ElearningOnboardingWeeklyReport | null>(null)
const status = ref('')
let pendingPolicyIdentity: { fingerprint: string; requestId: string } | null = null

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function description(): string {
  if (props.assignmentEnabled && props.analyticsEnabled) {
    return text(
      'Manage assignment policies and privacy-suppressed weekly reports.',
      '管理指派策略与执行隐私抑制的周报。',
    )
  }
  return props.assignmentEnabled
    ? text(
        'Assign an active training plan by department or position.',
        '按部门或岗位指派已启用的培训计划。',
      )
    : text(
        'Review privacy-suppressed weekly onboarding reports.',
        '查看执行隐私抑制的新员工学习周报。',
      )
}

function previousClosedWeekMonday(): string {
  const date = new Date()
  const day = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7) - 7)
  return date.toISOString().slice(0, 10)
}

function errorText(error: unknown): string {
  if (error instanceof ElearningApiError) {
    if (error.status === 400) return text('Enter valid policy values.', '请输入有效的策略信息。')
    if (error.status === 403) return text('You cannot manage this policy.', '您无权管理该策略。')
    if (error.status === 404) return text('The plan, policy, or report was not found.', '未找到培训计划、策略或报告。')
    if (error.status === 409) return text('The request conflicts with an existing policy.', '请求与现有策略冲突。')
  }
  return text('Unable to complete the operation.', '无法完成操作。')
}

function logicalPolicyInput(): Omit<ElearningOnboardingPolicyCommand, 'requestId'> {
  return {
    trainingPlanId: trainingPlanId.value.trim().toLowerCase(),
    matchRules: [{
      subjectType: subjectType.value,
      subjectRef: subjectType.value === 'department'
        ? subjectRef.value.trim().toLowerCase()
        : subjectRef.value.trim(),
      includeChildren: subjectType.value === 'department' && includeChildren.value,
    }],
    hireWindowDays: hireWindowDays.value,
    deadlineDays: deadlineDays.value,
    weeklyReportEnabled: weeklyReportEnabled.value,
  }
}

function requestIdFor(input: Omit<ElearningOnboardingPolicyCommand, 'requestId'>): string {
  const fingerprint = JSON.stringify(input)
  if (pendingPolicyIdentity?.fingerprint === fingerprint) {
    return pendingPolicyIdentity.requestId
  }
  const requestId = crypto.randomUUID()
  pendingPolicyIdentity = { fingerprint, requestId }
  return requestId
}

async function createPolicy(): Promise<void> {
  if (busy.value || !props.assignmentEnabled) return
  busy.value = true
  status.value = ''
  const input = logicalPolicyInput()
  try {
    policy.value = await createElearningOnboardingPolicy({
      requestId: requestIdFor(input),
      ...input,
    })
    pendingPolicyIdentity = null
    reportPolicyId.value = policy.value.policyId
    status.value = text('Policy created.', '策略已创建。')
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function retirePolicy(): Promise<void> {
  if (busy.value || !props.assignmentEnabled || !policy.value) return
  busy.value = true
  status.value = ''
  try {
    policy.value = await retireElearningOnboardingPolicy(policy.value.policyId)
    status.value = text('Policy retired.', '策略已停用。')
  } catch (error) {
    status.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function loadReport(): Promise<void> {
  if (reportBusy.value || !props.analyticsEnabled) return
  reportBusy.value = true
  status.value = ''
  report.value = null
  try {
    report.value = await getElearningOnboardingWeeklyReport(
      reportPolicyId.value.trim(),
      weekStart.value,
    )
  } catch (error) {
    status.value = errorText(error)
  } finally {
    reportBusy.value = false
  }
}

watch(subjectType, (value) => {
  if (value === 'position') includeChildren.value = false
})
</script>

<style scoped>
.onboarding,
.onboarding__form,
.onboarding__policy,
.onboarding__report {
  display: grid;
  gap: 12px;
}

.onboarding {
  border: 1px solid #dfe7f4;
  border-radius: 10px;
  padding: 14px;
  background: #fff;
}

.onboarding h2,
.onboarding p {
  margin: 0;
}

.onboarding__form {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  align-items: end;
}

.onboarding__form label,
.onboarding__check {
  display: grid;
  gap: 6px;
}

.onboarding__check {
  grid-template-columns: auto 1fr;
  align-items: center;
}

.onboarding__policy {
  grid-template-columns: 1fr auto auto;
  align-items: center;
}

.onboarding__report dl {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 12px;
  margin: 0;
}

.onboarding__report dd {
  margin: 0;
}

.onboarding__status {
  color: #8a3b12;
}
</style>
