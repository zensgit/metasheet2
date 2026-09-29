<!--
  请假撤销 —— 考勤自助面入口(阶段 B)。挂在 AttendanceView「最近申请」的请假行上(不是换班列表)。

  Authority: approval change-request lock v5.9 header 「RATIFY 追记 —— 产品入口增补 v2」 (P-1 entry +
  predicates, P-2 wording, P-3 ④ formatter, P-4 summary read, P-6 no seat display, P-7 / P-8 copy) and
  the owner's 2026-09-29 choices (「Attendance-side + OFF flag」, 「Summary exposes entryEnabled」).
  See docs/development/approval-cancel-entry-phase-b-fe-design-20260929.md.

  - `entryEnabled === false` (or absent): the launch entry is not rendered at all. The progress of a
    round that already exists is still shown — reading it and withdrawing it are not flag-gated.
  - Entry visible only when (a) the leave is approved and (b) the viewer is the leave's own user.
    (c) an in-flight round (I3) DISABLES the entry — never hides it — with a subject-bearing reason
    and an in-page link to that round's progress.
  - No approver / seat names anywhere (P-6). No free-text block detail (P-7): only the bounded code,
    folded as a technical detail.
  - A failed summary read is NOT rendered like 「no round」 (P-8 ③); a 404 (route absent or not
    visible) renders nothing, like a disabled entry.
  - Hiding a button is never the guard: every predicate is re-checked by the server.
-->
<template>
  <div
    v-if="visible"
    class="attendance-cancel-round"
    :data-attendance-cancel-round="request.id"
    :data-cancel-round-state="loadState"
  >
    <p
      v-if="loadState === 'error'"
      class="attendance-cancel-round__unavailable"
      role="status"
      data-cancel-round-unavailable
    >
      {{ tr('Cancellation status is unavailable right now.', '撤销状态暂时无法读取。') }}
      <button type="button" class="attendance__btn attendance__btn--compact" data-cancel-round-retry @click="load">
        {{ tr('Retry', '重试') }}
      </button>
    </p>

    <template v-else-if="summary">
      <section
        v-if="round"
        :id="progressAnchorId"
        ref="progressRef"
        class="attendance-cancel-round__progress"
        tabindex="-1"
        :aria-label="tr('Cancellation progress', '撤销进度')"
        data-cancel-round-progress
      >
        <div class="attendance-cancel-round__line">
          <StatusTag domain="cancelRound" :status="statusKey" size="sm" data-cancel-round-status />
          <span v-if="leaveStillValid" class="attendance-cancel-round__note" data-cancel-round-leave-valid>
            {{ tr('The leave is still valid.', '请假仍然有效') }}
          </span>
        </div>

        <div v-if="statusKey === 'cancellation_blocked'" class="attendance-cancel-round__block" data-cancel-round-block>
          <span>{{ blockCopy.message }}</span>
          <details v-if="blockCopy.code" class="attendance-cancel-round__detail" data-cancel-round-block-detail>
            <summary>{{ tr('Technical detail', '技术细节') }}</summary>
            <code>{{ blockCopy.code }}</code>
          </details>
        </div>

        <ul v-if="statusKey === 'leave_cancelled'" class="attendance-cancel-round__result" data-cancel-round-result>
          <li v-for="line in resultLines" :key="line">{{ line }}</li>
        </ul>

        <div v-if="showWithdraw" class="attendance-cancel-round__line">
          <button
            type="button"
            class="attendance__btn attendance__btn--compact"
            :disabled="!round.canWithdraw || busy !== null"
            data-cancel-round-withdraw
            @click="withdraw"
          >
            {{ busy === 'withdraw' ? tr('Withdrawing...', '撤回中...') : tr('Withdraw cancellation request', '撤回撤销申请') }}
          </button>
          <span v-if="withdrawDisabledReason" class="attendance-cancel-round__note" data-cancel-round-withdraw-reason>
            {{ withdrawDisabledReason }}
          </span>
        </div>

        <p v-if="progressError" class="attendance-cancel-round__error" role="alert" data-cancel-round-action-error>
          <StatusTag v-if="progressError.presentationKey" domain="cancelRound" :status="progressError.presentationKey" size="sm" />
          <span>{{ progressError.message }}</span>
        </p>
      </section>

      <div v-if="showEntry" class="attendance-cancel-round__line" data-cancel-round-entry>
        <button
          ref="launchButtonRef"
          type="button"
          class="attendance__btn attendance__btn--compact"
          :disabled="launchBlocked || busy !== null"
          :aria-describedby="launchBlocked ? blockedReasonId : undefined"
          data-cancel-round-launch
          @click="openDialog"
        >
          {{ tr('Request cancellation', '申请撤销') }}
        </button>
        <span v-if="launchBlocked" :id="blockedReasonId" class="attendance-cancel-round__note" data-cancel-round-launch-blocked>
          {{ tr('This leave already has a cancellation request pending approval.', '这条请假已有一个撤销申请在审批中') }}
          <a :href="`#${progressAnchorId}`" data-cancel-round-progress-link @click.prevent="focusProgress">
            {{ tr('View its progress', '查看撤销进度') }}
          </a>
        </span>
      </div>
    </template>

    <div
      v-if="dialogOpen"
      class="attendance-cancel-round__modal"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="dialogTitleId"
      data-cancel-round-dialog
      @keydown.esc="closeDialog"
    >
      <div class="attendance-cancel-round__modal-body">
        <h5 :id="dialogTitleId" class="attendance-cancel-round__title">
          {{ tr('Request to cancel this leave', '申请撤销这条请假') }}
        </h5>
        <p class="attendance-cancel-round__note">
          {{ tr(
            'The cancellation request goes to approval. Until it is approved the leave stays valid; once it is approved the leave is cancelled.',
            '撤销申请需要审批。审批通过前请假仍然有效;通过后请假将被取消。',
          ) }}
        </p>
        <label class="attendance-cancel-round__field">
          <span>{{ tr('Reason (optional)', '说明(可选)') }}</span>
          <textarea
            ref="reasonRef"
            v-model="reason"
            rows="3"
            maxlength="2000"
            data-cancel-round-reason
          />
        </label>
        <p v-if="dialogError" class="attendance-cancel-round__error" role="alert" data-cancel-round-dialog-error>
          <StatusTag v-if="dialogError.presentationKey" domain="cancelRound" :status="dialogError.presentationKey" size="sm" />
          <span>{{ dialogError.message }}</span>
        </p>
        <div class="attendance-cancel-round__actions">
          <button type="button" class="attendance__btn" data-cancel-round-cancel @click="closeDialog">
            {{ tr('Cancel', '取消') }}
          </button>
          <button
            type="button"
            class="attendance__btn attendance__btn--primary"
            :disabled="busy !== null"
            data-cancel-round-confirm
            @click="confirmLaunch"
          >
            {{ busy === 'launch' ? tr('Submitting...', '提交中...') : tr('Submit cancellation request', '提交撤销申请') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import StatusTag from '../../components/status/StatusTag.vue'
import { useLocale } from '../../composables/useLocale'
import { ApprovalApiError } from '../../approvals/api'
import {
  cancelRoundStatusKeyFromSummary,
  describeCancelRoundBlock,
  describeCancelRoundError,
  fetchCancelRoundSummary,
  launchCancelRound,
  withdrawCancelRound,
  type CancelRoundErrorDescription,
  type CancelRoundSummary,
} from '../../approvals/cancelRound'
import { cancelRoundResultLines } from './attendanceCancelRoundPresentation'

const props = defineProps<{
  request: { id: string; request_type: string; status: string; user_id?: string | null }
  currentUserId: string | null
}>()

const { isZh } = useLocale()
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)

type LoadState = 'idle' | 'loading' | 'ready' | 'hidden' | 'error'
const loadState = ref<LoadState>('idle')
const summary = ref<CancelRoundSummary | null>(null)
const busy = ref<'launch' | 'withdraw' | null>(null)
const dialogOpen = ref(false)
const reason = ref('')
const dialogError = ref<CancelRoundErrorDescription | null>(null)
const progressError = ref<CancelRoundErrorDescription | null>(null)
const progressRef = ref<HTMLElement | null>(null)
const reasonRef = ref<HTMLTextAreaElement | null>(null)
const launchButtonRef = ref<HTMLButtonElement | null>(null)

const uid = useId()
const progressAnchorId = computed(() => `attendance-cancel-round-${props.request.id}`)
const blockedReasonId = `${uid}-blocked`
const dialogTitleId = `${uid}-title`

/** Only a leave that is approved — or already cancelled, possibly by a round — can carry a round. */
const readable = computed(() =>
  props.request.request_type === 'leave' && (props.request.status === 'approved' || props.request.status === 'cancelled'),
)
const round = computed(() => summary.value?.round ?? null)
const isOwnLeave = computed(() => Boolean(props.currentUserId) && props.request.user_id === props.currentUserId)

/**
 * P-1 (a)(b) + entryEnabled. (c) is `launchBlocked`: it disables, it does not hide. The `request` prop
 * comes from the parent list and is not refreshed here, so a round this panel has re-read as applied
 * (V2 — the leave is cancelled) also removes the entry.
 */
const showEntry = computed(() =>
  summary.value?.entryEnabled === true
  && props.request.status === 'approved'
  && round.value?.outcome !== 'applied'
  && isOwnLeave.value,
)
const launchBlocked = computed(() => round.value?.outcome === 'pending')

const statusKey = computed(() => (round.value ? cancelRoundStatusKeyFromSummary(round.value) : 'status_unavailable'))
const leaveStillValid = computed(() =>
  ['cancellation_pending_approval', 'cancellation_rejected', 'cancellation_withdrawn', 'cancellation_window_closed', 'cancellation_blocked']
    .includes(statusKey.value),
)
const blockCopy = computed(() => describeCancelRoundBlock(round.value?.blockCode, isZh.value))
const resultLines = computed(() => cancelRoundResultLines(round.value?.cancellationOutcome ?? null, tr))

/**
 * The withdraw affordance is for the leave's own user on a pending round. `canWithdraw` is resolved
 * by the server with the engine's own gate; the FE never derives a second predicate. A non-requester
 * (`APPROVAL_REVOKE_FORBIDDEN`) sees no button at all.
 */
const showWithdraw = computed(() =>
  round.value?.outcome === 'pending'
  && isOwnLeave.value
  && round.value.withdrawBlockedReason !== 'APPROVAL_REVOKE_FORBIDDEN',
)
const withdrawDisabledReason = computed(() => {
  const current = round.value
  if (!current || current.canWithdraw || !current.withdrawBlockedReason) return null
  return describeCancelRoundError({ code: current.withdrawBlockedReason }, isZh.value, '').message || null
})

const visible = computed(() => {
  if (!readable.value) return false
  if (loadState.value === 'error') return true
  if (loadState.value !== 'ready') return false
  return Boolean(round.value) || showEntry.value
})

async function load(): Promise<void> {
  if (!readable.value) return
  // A re-read after a write keeps the current view until the answer lands (no flicker).
  if (!summary.value) loadState.value = 'loading'
  try {
    summary.value = await fetchCancelRoundSummary(props.request.id)
    loadState.value = 'ready'
  } catch (error) {
    summary.value = null
    loadState.value = error instanceof ApprovalApiError && error.status === 404 ? 'hidden' : 'error'
  }
}

function describe(error: unknown, fallbackEn: string, fallbackZh: string): CancelRoundErrorDescription {
  return describeCancelRoundError(error, isZh.value, tr(fallbackEn, fallbackZh))
}

async function openDialog(): Promise<void> {
  if (launchBlocked.value) return
  reason.value = ''
  dialogError.value = null
  dialogOpen.value = true
  await nextTick()
  reasonRef.value?.focus()
}

async function closeDialog(): Promise<void> {
  if (busy.value === 'launch') return
  dialogOpen.value = false
  await nextTick()
  launchButtonRef.value?.focus()
}

async function confirmLaunch(): Promise<void> {
  if (busy.value) return
  busy.value = 'launch'
  dialogError.value = null
  try {
    await launchCancelRound(props.request.id, reason.value)
    dialogOpen.value = false
    progressError.value = null
    await load()
  } catch (error) {
    dialogError.value = describe(error, 'The cancellation request could not be submitted.', '撤销申请未能提交')
    // e.g. ALREADY_PENDING raced in from another tab: re-read so the page shows the real state.
    void load()
  } finally {
    busy.value = null
  }
}

async function withdraw(): Promise<void> {
  if (busy.value) return
  busy.value = 'withdraw'
  progressError.value = null
  try {
    await withdrawCancelRound(props.request.id)
    await load()
  } catch (error) {
    progressError.value = describe(error, 'The cancellation request could not be withdrawn.', '撤销申请未能撤回')
    void load()
  } finally {
    busy.value = null
  }
}

async function focusProgress(): Promise<void> {
  await nextTick()
  progressRef.value?.scrollIntoView?.({ block: 'nearest' })
  progressRef.value?.focus()
}

onMounted(() => { void load() })
watch(() => [props.request.id, props.request.status] as const, () => { void load() })
</script>

<style scoped>
.attendance-cancel-round {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin-top: var(--ms-space-2);
}

.attendance-cancel-round__progress {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-sm);
}

.attendance-cancel-round__line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

.attendance-cancel-round__note,
.attendance-cancel-round__unavailable {
  color: var(--ms-text-2);
  font-size: 12px;
}

.attendance-cancel-round__result {
  margin: 0;
  padding-left: var(--ms-space-4);
  color: var(--ms-text-1);
  font-size: 13px;
}

.attendance-cancel-round__block {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
}

.attendance-cancel-round__detail code {
  user-select: all;
  color: var(--ms-text-2);
}

.attendance-cancel-round__error {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  margin: 0;
  color: var(--ms-color-danger);
  font-size: 12px;
}

.attendance-cancel-round__modal {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--ms-text-1) 45%, transparent);
}

.attendance-cancel-round__modal-body {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  width: calc(100% - 32px);
  max-width: 480px;
  padding: var(--ms-space-5);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
  box-shadow: var(--ms-shadow-pop);
}

.attendance-cancel-round__title {
  margin: 0;
  font-size: var(--ms-font-size-section-title);
}

.attendance-cancel-round__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
}

.attendance-cancel-round__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ms-space-2);
}
</style>
