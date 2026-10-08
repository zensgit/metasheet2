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
      <p class="card-decision__meta">{{ launchMessage || t.loginRequired }}</p>
      <el-button type="primary" size="large" data-testid="card-decision-launch" @click="startDingTalkLaunch">
        {{ t.loginWithDingTalk }}
      </el-button>
    </div>

    <template v-else-if="summary">
      <header class="card-decision__header">
        <h1 data-testid="card-decision-title">{{ summary.approval.title ?? t.titleFallback }}</h1>
        <p v-if="summary.approval.requestNo" class="card-decision__meta">{{ t.requestNo }}{{ summary.approval.requestNo }}</p>
        <p class="card-decision__meta">{{ t.node }}<code class="card-decision__code">{{ summary.nodeKey }}</code></p>
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
          :title="t.notRecipient"
          type="warning"
          show-icon
          :closable="false"
        />
        <div class="card-decision__comment">
          <label class="card-decision__label">
            {{ t.commentLabel }}<span v-if="cardCommentRequired === 'always'">{{ t.commentRequired }}</span><span v-else-if="cardCommentRequired === 'reject_only'">{{ t.commentRequiredOnReject }}</span>
          </label>
          <el-input
            v-model="comment"
            type="textarea"
            :rows="3"
            :placeholder="t.commentPlaceholder"
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
            :disabled="submitting !== '' || approveBlocked"
            data-testid="card-decision-approve"
            @click="submit('approve')"
          >
            {{ t.approve }}
          </el-button>
          <el-button
            type="danger"
            size="large"
            :loading="submitting === 'reject'"
            :disabled="submitting !== '' || rejectBlocked"
            data-testid="card-decision-reject"
            @click="submit('reject')"
          >
            {{ t.reject }}
          </el-button>
        </div>
        <p v-if="rejectBlocked" class="card-decision__hint" data-testid="card-decision-reject-hint">
          {{ t.rejectHint }}
        </p>
        <p v-if="approveBlocked" class="card-decision__hint" data-testid="card-decision-approve-hint">
          {{ t.approveHint }}
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
import { useLocale } from '../../composables/useLocale'
import { CARD_EN, CARD_ZH, type CardOwnErrorKey } from './approvalCardDecisionLabels'

const route = useRoute()

// O-8 / F8-1: this page follows the shell locale (module-scope `useLocale()` singleton); its copy
// lives in approvalCardDecisionLabels.ts. Its own error copy is kept as a label KEY (a server
// message is kept verbatim), so a later locale switch re-renders it in the new language.
const { isZh } = useLocale()
const t = computed(() => (isZh.value ? CARD_ZH : CARD_EN))

const loading = ref(true)
const loadErrorKey = ref<CardOwnErrorKey | ''>('')
const loadErrorServerMessage = ref('')
const loadError = computed(() =>
  loadErrorServerMessage.value || (loadErrorKey.value ? t.value[loadErrorKey.value] : ''),
)
// Lock §5: unauthenticated deep link auto-launches DingTalk OAuth ONCE per delivery; a bounce-back
// still unauthenticated (cancelled/failed OAuth) renders a manual retry button instead of looping.
const needsLogin = ref(false)
const launchMessage = ref('')
const summary = ref<ApprovalCardSummary | null>(null)
const comment = ref('')
const submitting = ref<'' | 'approve' | 'reject'>('')
const submitErrorKey = ref<CardOwnErrorKey | ''>('')
const submitErrorServerMessage = ref('')
const submitError = computed(() =>
  submitErrorServerMessage.value || (submitErrorKey.value ? t.value[submitErrorKey.value] : ''),
)

const deliveryId = computed(() => (typeof route.query.d === 'string' ? route.query.d : ''))
const token = computed(() => (typeof route.query.t === 'string' ? route.query.t : ''))

// Lock-5 §1.3 / gate CR-3 — both sides now derive from the EFFECTIVE node requirement the server
// resolved at THIS delivery's node (it joins the frozen runtime graph for exactly this). The
// three-valued field is optional so an older server degrades to the shipped reject-only reading.
const cardCommentRequired = computed<'never' | 'reject_only' | 'always'>(() => {
  const resolved = summary.value?.approval.commentRequired
  if (resolved) return resolved
  return (summary.value?.approval.rejectCommentRequired ?? true) ? 'reject_only' : 'never'
})
const rejectBlocked = computed(() =>
  cardCommentRequired.value !== 'never' && comment.value.trim().length === 0,
)
const approveBlocked = computed(() =>
  cardCommentRequired.value === 'always' && comment.value.trim().length === 0,
)

const staleTitle = computed(() => {
  const s = summary.value
  if (!s) return ''
  if (s.cardState === 'acted') {
    const acted = s.actedAction === 'approve' ? t.value.approve : s.actedAction === 'reject' ? t.value.reject : s.actedAction ?? ''
    return isZh.value ? `该待办已处理（${acted}）。` : `This task has already been handled (${acted}).`
  }
  if (s.approval.status !== 'pending') return t.value.staleClosed
  // outcome_unknown deliberately NOT here (PR #4046 Phase B): such a card MAY have been
  // delivered, so while its instance is pending the server marks it actionable and this stale
  // branch never renders; if it is non-actionable for another reason the generic 已流转 message
  // below is the accurate one — not "未成功投递".
  if (s.sendStatus === 'pending' || s.sendStatus === 'failed') return t.value.staleUndelivered
  return t.value.staleMoved
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
  loadErrorKey.value = ''
  loadErrorServerMessage.value = ''
  needsLogin.value = false
  if (!deliveryId.value || !token.value) {
    loading.value = false
    loadErrorKey.value = 'invalidLink'
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
    if (cardError?.code === 'APPROVAL_CARD_DELIVERY_NOT_FOUND') loadErrorKey.value = 'linkExpired'
    else if (typeof cardError?.message === 'string') loadErrorServerMessage.value = cardError.message
    else loadErrorKey.value = 'loadFailed'
  } finally {
    loading.value = false
  }
}

async function submit(decision: 'approve' | 'reject') {
  if (submitting.value) return
  submitErrorKey.value = ''
  submitErrorServerMessage.value = ''
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
    if (typeof cardError?.message === 'string') submitErrorServerMessage.value = cardError.message
    else submitErrorKey.value = 'submitFailed'
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
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin: 2px 0;
}

/* UF-8: the card-delivery summary carries only the raw nodeKey (this page deliberately has no
   template-store import — see cardDecision.ts — so there is no node name to resolve without a
   new API call, out of scope for a presentation-only slice); honest <code> fallback names it as
   a machine value instead of plain inline text (design-lock §3.5). */
.card-decision__code {
  font-family: monospace;
  font-size: 12px;
  background: var(--ms-bg-page);
  padding: 1px 4px;
  border-radius: var(--ms-radius-sm);
}

.card-decision__label {
  display: block;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}

.card-decision__actions {
  display: flex;
  gap: 12px;
  position: sticky;
  bottom: 0;
  padding: 8px 0 calc(8px + env(safe-area-inset-bottom));
  background: var(--el-bg-color);
}

.card-decision__actions .el-button {
  flex: 1;
  min-height: 44px;
}

.card-decision__hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin: 0;
}
</style>
