<template>
  <section class="credit-admin" aria-labelledby="credit-admin-title">
    <header>
      <h2 id="credit-admin-title">{{ text('Credit rules', '学分规则') }}</h2>
      <p>{{ text('Publish one active automatic rule per behavior.', '为每种自动行为发布一条当前生效规则。') }}</p>
    </header>

    <form class="credit-admin__form" data-testid="elearning-credit-rule-form" @submit.prevent="void submit()">
      <label>
        <span>{{ text('Behavior', '行为') }}</span>
        <select v-model="behavior" data-testid="elearning-credit-rule-behavior" :disabled="busy">
          <option v-for="item in behaviors" :key="item" :value="item">{{ behaviorLabel(item) }}</option>
        </select>
      </label>
      <label>
        <span>{{ text('Points', '学分') }}</span>
        <input v-model.number="points" data-testid="elearning-credit-rule-points" type="number" min="1" step="1" :disabled="busy">
      </label>
      <label>
        <span>{{ text('Daily cap (optional)', '每日上限（可选）') }}</span>
        <input v-model="dailyCap" data-testid="elearning-credit-rule-cap" type="number" min="1" step="1" :disabled="busy">
      </label>
      <label>
        <span>{{ text('Time zone', '时区') }}</span>
        <input v-model="timeZone" data-testid="elearning-credit-rule-timezone" type="text" :disabled="busy" autocomplete="off">
      </label>
      <button data-testid="elearning-credit-rule-submit" type="submit" :disabled="busy">
        {{ busy ? text('Publishing...', '正在发布…') : text('Publish rule', '发布规则') }}
      </button>
    </form>

    <p v-if="status" class="credit-admin__status" :class="{ 'credit-admin__status--error': error }" data-testid="elearning-credit-rule-status" role="status">
      {{ status }}
    </p>
    <p v-if="loading" data-testid="elearning-credit-rule-loading">{{ text('Loading rules...', '正在加载规则…') }}</p>
    <p v-else-if="rules.length === 0" data-testid="elearning-credit-rule-empty">{{ text('No active rules.', '暂无生效规则。') }}</p>
    <ul v-else class="credit-admin__rules" data-testid="elearning-credit-rule-list">
      <li v-for="rule in rules" :key="rule.behavior">
        <strong>{{ behaviorLabel(rule.behavior) }}</strong>
        <span>{{ rule.points }} · {{ rule.dailyCap === null ? text('no daily cap', '无每日上限') : text(`daily cap ${rule.dailyCap}`, `每日上限 ${rule.dailyCap}`) }} · {{ rule.timeZone }} · v{{ rule.version }}</span>
      </li>
    </ul>

    <section class="credit-admin__adjustment" aria-labelledby="credit-adjustment-title">
      <header>
        <h3 id="credit-adjustment-title">{{ text('Manual adjustment', '人工调整学分') }}</h3>
        <p>{{ text('Add or deduct credits for one employee. The balance cannot become negative.', '为单个员工增加或扣减学分，调整后余额不能为负。') }}</p>
      </header>
      <form class="credit-admin__form" data-testid="elearning-credit-adjust-form" @submit.prevent="void submitAdjustment()">
        <label>
          <span>{{ text('Employee user ID', '员工用户 ID') }}</span>
          <input v-model="adjustUserId" data-testid="elearning-credit-adjust-user" type="text" maxlength="512" autocomplete="off" :disabled="adjustBusy">
        </label>
        <label>
          <span>{{ text('Points (non-zero)', '调整分值（不可为 0）') }}</span>
          <input v-model.number="adjustPoints" data-testid="elearning-credit-adjust-points" type="number" :min="-PG_INT4_MAX" :max="PG_INT4_MAX" step="1" :disabled="adjustBusy">
        </label>
        <label>
          <span>{{ text('Reason', '调整原因') }}</span>
          <input v-model="adjustReason" data-testid="elearning-credit-adjust-reason" type="text" maxlength="512" autocomplete="off" :disabled="adjustBusy">
        </label>
        <button data-testid="elearning-credit-adjust-submit" type="submit" :disabled="adjustBusy">
          {{ adjustBusy ? text('Saving...', '正在保存…') : text('Save adjustment', '保存调整') }}
        </button>
      </form>
      <p v-if="adjustStatus" class="credit-admin__status" :class="{ 'credit-admin__status--error': adjustError }" data-testid="elearning-credit-adjust-status" role="status">
        {{ adjustStatus }}
      </p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useLocale } from '../composables/useLocale'
import { ElearningApiError } from '../services/elearning'
import {
  adjustElearningCredit,
  listElearningCreditRules,
  publishElearningCreditRule,
  type ElearningCreditAutomaticBehavior,
  type ElearningCreditRule,
} from '../services/elearningCredit'

const PG_INT4_MAX = 2_147_483_647
const behaviors: ElearningCreditAutomaticBehavior[] = [
  'login',
  'complete_course',
  'complete_plan',
  'pass_exam',
  'submit_survey',
  'complete_map',
  'complete_offline',
]
const { isZh } = useLocale()
const behavior = ref<ElearningCreditAutomaticBehavior>('complete_course')
const points = ref(1)
const dailyCap = ref('')
const timeZone = ref(defaultTimeZone())
const rules = ref<ElearningCreditRule[]>([])
const loading = ref(false)
const busy = ref(false)
const status = ref('')
const error = ref(false)
const adjustUserId = ref('')
const adjustPoints = ref(1)
const adjustReason = ref('')
const adjustBusy = ref(false)
const adjustStatus = ref('')
const adjustError = ref(false)
let requestId = ''
let attemptedPayload = ''
let adjustmentRequestId = ''
let attemptedAdjustmentPayload = ''

function text(en: string, zh: string): string {
  return isZh.value ? zh : en
}

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function behaviorLabel(value: ElearningCreditAutomaticBehavior): string {
  const labels: Record<ElearningCreditAutomaticBehavior, [string, string]> = {
    login: ['Login', '登录'],
    complete_course: ['Complete course', '完成课程'],
    complete_plan: ['Complete plan', '完成计划'],
    pass_exam: ['Pass exam', '考试通过'],
    submit_survey: ['Submit survey', '提交问卷'],
    complete_map: ['Complete learning map', '完成学习地图'],
    complete_offline: ['Complete offline activity', '完成线下活动'],
  }
  const [en, zh] = labels[value]
  return text(en, zh)
}

function newRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : ''
}

function errorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 409) return text('This request ID was already used for different rule values.', '该请求标识已用于不同的规则内容。')
    if (value.status === 403) return text('You do not have permission to manage credit rules.', '您没有管理学分规则的权限。')
    if (value.status === 404) return text('Credit rules are disabled.', '学分规则功能未启用。')
  }
  return text('Unable to update credit rules. Try again.', '无法更新学分规则，请重试。')
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    rules.value = await listElearningCreditRules()
  } catch (value) {
    error.value = true
    status.value = errorText(value)
  } finally {
    loading.value = false
  }
}

async function submit(): Promise<void> {
  if (busy.value) return
  const cap = dailyCap.value.trim() === '' ? null : Number(dailyCap.value)
  const payload = JSON.stringify({
    behavior: behavior.value,
    points: points.value,
    dailyCap: cap,
    timeZone: timeZone.value.trim(),
  })
  if (payload !== attemptedPayload) {
    requestId = newRequestId()
    attemptedPayload = payload
  }
  if (!requestId) {
    error.value = true
    status.value = text('Secure request identifiers are unavailable.', '当前环境无法生成安全请求标识。')
    return
  }
  busy.value = true
  error.value = false
  status.value = ''
  try {
    await publishElearningCreditRule({
      requestId,
      behavior: behavior.value,
      points: points.value,
      dailyCap: cap,
      timeZone: timeZone.value.trim(),
    })
    attemptedPayload = ''
    requestId = ''
    status.value = text('Rule published.', '规则已发布。')
    rules.value = await listElearningCreditRules()
  } catch (value) {
    error.value = true
    status.value = errorText(value)
  } finally {
    busy.value = false
  }
}

function adjustmentErrorText(value: unknown): string {
  if (value instanceof ElearningApiError) {
    if (value.status === 409) return text('This request ID was already used for different adjustment values, or the balance limit was reached.', '该请求标识已用于不同调整内容，或余额边界不允许本次调整。')
    if (value.status === 403) return text('You do not have permission to adjust credits.', '您没有人工调整学分的权限。')
    if (value.status === 404) return text('Credit adjustment is unavailable or the employee is not in this organization.', '人工调整功能不可用，或该员工不属于当前组织。')
    if (value.status === 400) return text('Enter a valid employee, non-zero integer points, and a reason.', '请输入有效员工、非零整数分值和调整原因。')
  }
  return text('Unable to save the adjustment. Try again.', '无法保存学分调整，请重试。')
}

async function submitAdjustment(): Promise<void> {
  if (adjustBusy.value) return
  const payload = JSON.stringify({
    userId: adjustUserId.value.trim(),
    points: adjustPoints.value,
    reason: adjustReason.value.trim(),
  })
  if (payload !== attemptedAdjustmentPayload) {
    adjustmentRequestId = newRequestId()
    attemptedAdjustmentPayload = payload
  }
  if (!adjustmentRequestId) {
    adjustError.value = true
    adjustStatus.value = text('Secure request identifiers are unavailable.', '当前环境无法生成安全请求标识。')
    return
  }
  adjustBusy.value = true
  adjustError.value = false
  adjustStatus.value = ''
  try {
    const result = await adjustElearningCredit({
      requestId: adjustmentRequestId,
      userId: adjustUserId.value,
      points: adjustPoints.value,
      reason: adjustReason.value,
    })
    adjustmentRequestId = ''
    attemptedAdjustmentPayload = ''
    adjustStatus.value = text(
      `Adjustment saved. Current balance: ${result.balancePoints}.`,
      `调整已保存，当前余额：${result.balancePoints}。`,
    )
  } catch (value) {
    adjustError.value = true
    adjustStatus.value = adjustmentErrorText(value)
  } finally {
    adjustBusy.value = false
  }
}

onMounted(() => {
  void refresh()
})
</script>

<style scoped>
.credit-admin {
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid #cbd9e8;
  border-radius: 10px;
  background: #f8fbff;
}
.credit-admin h2,
.credit-admin p { margin: 0; }
.credit-admin__form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  align-items: end;
}
.credit-admin__form label { display: grid; gap: 4px; }
.credit-admin__form input,
.credit-admin__form select,
.credit-admin__form button { min-height: 36px; }
.credit-admin__form button { cursor: pointer; }
.credit-admin__status--error { color: #b42318; }
.credit-admin__rules { display: grid; gap: 8px; margin: 0; padding-left: 20px; }
.credit-admin__rules li { display: grid; gap: 2px; }
.credit-admin__adjustment {
  display: grid;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid #cbd9e8;
}
.credit-admin__adjustment h3 { margin: 0; }
</style>
