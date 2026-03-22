<template>
  <section v-if="!canDesign" class="attendance-workflow">
    <article class="attendance-workflow__card">
      <h3>{{ t.title }}</h3>
      <p class="attendance-workflow__empty">
        {{ t.disabledHint }}
      </p>
    </article>
  </section>

  <section v-else class="attendance-workflow">
    <article v-if="workflowHandoff" class="attendance-workflow__card attendance-workflow__card--handoff">
      <h3>{{ t.handoffTitle }}</h3>
      <p class="attendance-workflow__hint">{{ t.handoffIntro }}</p>
      <div class="attendance-workflow__chips">
        <span class="attendance-workflow__chip">{{ t.requestTypeLabel }}: {{ requestTypeLabel }}</span>
        <span class="attendance-workflow__chip">{{ t.flowNameLabel }}: {{ workflowHandoff.approvalFlowName }}</span>
        <span class="attendance-workflow__chip">{{ t.stepCountLabel }}: {{ workflowHandoff.approvalStepCount }}</span>
        <span class="attendance-workflow__chip">{{ t.starterLabel }}: {{ starterLabel }}</span>
      </div>
      <p class="attendance-workflow__hint">{{ workflowHandoff.workflowDescription }}</p>
      <p v-if="workflowHandoff.approvalStepSummary" class="attendance-workflow__hint">
        {{ t.stepSummaryLabel }}: {{ workflowHandoff.approvalStepSummary }}
      </p>
      <div class="attendance-workflow__actions">
        <button class="attendance-workflow__btn" type="button" @click="backToAdmin">
          {{ t.backToAdmin }}
        </button>
        <button class="attendance-workflow__btn attendance-workflow__btn--ghost" type="button" @click="clearHandoff">
          {{ t.clearHandoff }}
        </button>
      </div>
    </article>

    <WorkflowDesigner />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import WorkflowDesigner from '../WorkflowDesigner.vue'
import { readAttendanceWorkflowHandoff } from './attendanceWorkflowHandoff'

withDefaults(
  defineProps<{
    canDesign?: boolean
  }>(),
  {
    canDesign: false,
  },
)

const { isZh } = useLocale()
const route = useRoute()
const router = useRouter()
const workflowHandoff = computed(() => readAttendanceWorkflowHandoff(route.query as Record<string, unknown>))
const requestTypeLabel = computed(() => {
  switch (workflowHandoff.value?.requestType) {
    case 'leave':
      return isZh.value ? '请假' : 'Leave'
    case 'overtime':
      return isZh.value ? '加班' : 'Overtime'
    case 'missed_check_in':
      return isZh.value ? '漏打上班卡' : 'Missed check-in'
    case 'missed_check_out':
      return isZh.value ? '漏打下班卡' : 'Missed check-out'
    case 'time_correction':
      return isZh.value ? '时间更正' : 'Time correction'
    default:
      return isZh.value ? '考勤' : 'Attendance'
  }
})
const starterLabel = computed(() => {
  return workflowHandoff.value?.workflowStarterId === 'parallel-review'
    ? (isZh.value ? '并行评审起步模板' : 'Parallel review starter')
    : (isZh.value ? '简单审批起步模板' : 'Simple approval starter')
})

const t = computed(() => {
  if (isZh.value) {
    return {
      title: '审批流程设计',
      disabledHint: '当前租户未启用流程能力。',
      handoffTitle: '考勤审批流程接力',
      handoffIntro: '当前设计器收到来自考勤审批构建器的接力上下文。这是一份起步说明，不会替换当前线上考勤审批执行逻辑。',
      requestTypeLabel: '申请类型',
      flowNameLabel: '审批流名称',
      stepCountLabel: '审批步骤数',
      starterLabel: '推荐起步模板',
      stepSummaryLabel: '步骤摘要',
      backToAdmin: '返回管理中心',
      clearHandoff: '清除接力信息',
    }
  }
  return {
    title: 'Approval Workflow Designer',
    disabledHint: 'Workflow capability is not enabled for this tenant.',
    handoffTitle: 'Attendance approval handoff',
    handoffIntro: 'This designer received starter context from the attendance approval builder. It does not replace the live attendance approval engine yet.',
    requestTypeLabel: 'Request type',
    flowNameLabel: 'Approval flow',
    stepCountLabel: 'Step count',
    starterLabel: 'Suggested starter',
    stepSummaryLabel: 'Step summary',
    backToAdmin: 'Back to admin',
    clearHandoff: 'Clear handoff',
  }
})

async function backToAdmin(): Promise<void> {
  await router.replace({ query: { tab: 'admin' } })
}

async function clearHandoff(): Promise<void> {
  await router.replace({ query: { tab: 'workflow' } })
}
</script>

<style scoped>
.attendance-workflow {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.attendance-workflow__card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 20px;
}

.attendance-workflow__card h3 {
  margin: 0 0 10px;
  font-size: 20px;
}

.attendance-workflow__desc,
.attendance-workflow__hint,
.attendance-workflow__empty {
  margin: 0;
  color: #4b5563;
}

.attendance-workflow__card--handoff {
  display: grid;
  gap: 10px;
  background: #f7fbff;
  border-color: #d8e3f4;
}

.attendance-workflow__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attendance-workflow__chip {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  padding: 4px 8px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 12px;
}

.attendance-workflow__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance-workflow__btn {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}

.attendance-workflow__btn--ghost {
  background: transparent;
}
</style>
