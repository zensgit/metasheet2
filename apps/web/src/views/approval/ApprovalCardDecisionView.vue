<template>
  <section class="card-decision" data-testid="card-decision-page">
    <div v-if="loading" v-loading="true" class="card-decision__loading" />

    <el-alert
      v-else-if="loadError"
      :title="loadError"
      type="error"
      show-icon
      :closable="false"
      data-testid="card-decision-load-error"
    />

    <div v-else-if="needsLogin" class="card-decision__login" data-testid="card-decision-login">
      <p class="card-decision__meta">{{ launchMessage || '需要登录后处理该审批待办。' }}</p>
      <el-button type="primary" size="large" data-testid="card-decision-launch" @click="startDingTalkLaunch">
        使用钉钉登录
      </el-button>
    </div>

    <template v-else-if="summary">
      <header class="card-decision__header">
        <h1 data-testid="card-decision-title">{{ summary.approval.title ?? '审批待办' }}</h1>
        <p v-if="summary.approval.requestNo" class="card-decision__meta">编号：{{ summary.approval.requestNo }}</p>
        <p class="card-decision__meta">节点：{{ summary.nodeKey }}</p>
      </header>

      <!-- Terminal / stale states render the REAL ledger state instead of dead buttons. -->
      <el-alert
        v-if="!summary.actionable"
        :title="staleTitle"
        :type="summary.cardState === 'acted' ? 'success' : 'info'"
        show-icon
        :closable="false"
        data-testid="card-decision-stale"
      />

      <template v-else>
        <el-alert
          v-if="!summary.viewerIsRecipient"
          title="此待办的受理人不是当前账号；提交将按服务端受理校验执行。"
          type="warning"
          show-icon
          :closable="false"
        />
        <div class="card-decision__comment">
          <label class="card-decision__label">
            处理意见<span v-if="summary.approval.rejectCommentRequired">（驳回必填）</span>
          </label>
          <el-input
            v-model="comment"
            type="textarea"
            :rows="3"
            placeholder="填写处理意见"
            data-testid="card-decision-comment"
          />
        </div>
        <el-alert
          v-if="submitError"
          :title="submitError"
          type="error"
          show-icon
          :closable="false"
          data-testid="card-decision-submit-error"
        />
        <div class="card-decision__actions">
          <el-button
            type="success"
            size="large"
            :loading="submitting === 'approve'"
            :disabled="submitting !== ''"
            data-testid="card-decision-approve"
            @click="submit('approve')"
          >
            同意
          </el-button>
          <el-button
            type="danger"
            size="large"
            :loading="submitting === 'reject'"
            :disabled="submitting !== '' || rejectBlocked"
            data-testid="card-decision-reject"
            @click="submit('reject')"
          >
            驳回
          </el-button>
        </div>
        <p v-if="rejectBlocked" class="card-decision__hint" data-testid="card-decision-reject-hint">
          驳回前请先填写处理意见。
        </p>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
// A-3 (one-tap lock #3594 §5): minimal mobile decision page for the DingTalk approval card.
// Deep link carries ONLY ?d=<deliveryId>&t=<HMAC token>; the page resolves everything through the
// card-delivery endpoints (cardDecision.ts) and MUST NOT call the raw per-instance action route —
// direct calls would bypass the ledger card_state writeback + channel attribution (tripwire spec).
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  fetchApprovalCardSummary,
  launchDingTalkLoginForDecision,
  submitApprovalCardDecision,
  type ApprovalCardActionError,
  type ApprovalCardSummary,
} from '../../approvals/cardDecision'
import { useAuth } from '../../composables/useAuth'

const route = useRoute()

const loading = ref(true)
const loadError = ref('')
// Lock §5: unauthenticated deep link auto-launches DingTalk OAuth ONCE per delivery; a bounce-back
// still unauthenticated (cancelled/failed OAuth) renders a manual retry button instead of looping.
const needsLogin = ref(false)
const launchMessage = ref('')
const summary = ref<ApprovalCardSummary | null>(null)
const comment = ref('')
const submitting = ref<'' | 'approve' | 'reject'>('')
const submitError = ref('')

const deliveryId = computed(() => (typeof route.query.d === 'string' ? route.query.d : ''))
const token = computed(() => (typeof route.query.t === 'string' ? route.query.t : ''))

const rejectBlocked = computed(() =>
  (summary.value?.approval.rejectCommentRequired ?? true) && comment.value.trim().length === 0,
)

const staleTitle = computed(() => {
  const s = summary.value
  if (!s) return ''
  if (s.cardState === 'acted') {
    return `该待办已处理（${s.actedAction === 'approve' ? '同意' : s.actedAction === 'reject' ? '驳回' : s.actedAction ?? ''}）。`
  }
  if (s.approval.status !== 'pending') return '该审批已办结，无需处理。'
  if (s.sendStatus !== 'sent') return '该卡片未成功投递，无法在此处理。'
  return '该待办已流转（转办/新一轮），此卡片不再有效。'
})

function cardErrorOf(error: unknown): ApprovalCardActionError | null {
  const holder = error as { cardError?: ApprovalCardActionError }
  return holder?.cardError ?? null
}

function launchGuardKey(): string {
  return `approval-card-launch-attempted:${deliveryId.value}`
}

async function startDingTalkLaunch(): Promise<void> {
  launchMessage.value = ''
  const result = await launchDingTalkLoginForDecision(route.fullPath)
  if (!result.ok) {
    needsLogin.value = true
    launchMessage.value = result.message ?? ''
  }
  // ok → browser is navigating away; nothing else to render.
}

async function load() {
  loading.value = true
  loadError.value = ''
  needsLogin.value = false
  if (!deliveryId.value || !token.value) {
    loading.value = false
    loadError.value = '链接无效：缺少必要参数。'
    return
  }
  // Lock §5: session check BEFORE any api call — missing session drives the DingTalk launch flow
  // directly (never the generic /login page).
  const userId = await useAuth().getCurrentUserId().catch(() => null)
  if (!userId) {
    loading.value = false
    let attempted = false
    try {
      attempted = window.sessionStorage.getItem(launchGuardKey()) === '1'
      window.sessionStorage.setItem(launchGuardKey(), '1')
    } catch { /* storage unavailable → still attempt once */ }
    if (!attempted) {
      await startDingTalkLaunch()
      if (!needsLogin.value) return // navigating away
    } else {
      needsLogin.value = true
    }
    return
  }
  try {
    window.sessionStorage.removeItem(launchGuardKey())
  } catch { /* noop */ }
  try {
    summary.value = await fetchApprovalCardSummary(deliveryId.value, token.value)
  } catch (error) {
    const cardError = cardErrorOf(error)
    loadError.value = cardError?.code === 'APPROVAL_CARD_DELIVERY_NOT_FOUND'
      ? '链接无效或已失效。'
      : cardError?.message ?? '加载失败，请稍后重试。'
  } finally {
    loading.value = false
  }
}

async function submit(decision: 'approve' | 'reject') {
  if (submitting.value) return
  submitError.value = ''
  submitting.value = decision
  try {
    summary.value = await submitApprovalCardDecision(
      deliveryId.value,
      token.value,
      decision,
      comment.value.trim() || undefined,
    )
  } catch (error) {
    const cardError = cardErrorOf(error)
    // A stale/terminal response carries the REAL summary — render it instead of a dead form.
    if (cardError?.summary) summary.value = cardError.summary
    submitError.value = cardError?.message ?? '提交失败，请重试。'
  } finally {
    submitting.value = ''
  }
}

onMounted(load)
</script>

<style scoped>
.card-decision {
  max-width: 480px;
  margin: 0 auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-decision__loading {
  min-height: 200px;
}

.card-decision__header h1 {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 8px;
}

.card-decision__meta {
  color: var(--el-text-color-secondary, #909399);
  font-size: 13px;
  margin: 2px 0;
}

.card-decision__label {
  display: block;
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
  margin-bottom: 6px;
}

.card-decision__actions {
  display: flex;
  gap: 12px;
  position: sticky;
  bottom: 0;
  padding: 8px 0 calc(8px + env(safe-area-inset-bottom));
  background: var(--el-bg-color, #fff);
}

.card-decision__actions .el-button {
  flex: 1;
  min-height: 44px;
}

.card-decision__hint {
  color: var(--el-text-color-secondary, #909399);
  font-size: 12px;
  margin: 0;
}
</style>
