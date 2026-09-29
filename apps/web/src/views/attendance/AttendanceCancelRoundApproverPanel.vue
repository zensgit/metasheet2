<!--
  请假撤销 —— 考勤侧「待我审批的撤销」列表(阶段 B2)。挂在 AttendanceView 概览页,自成一张卡片。

  Authority: owner 2026-09-29 16:5x 「Attendance-side list (Recommended)」 — a list on the attendance
  side, guarded by `attendance:approve`, filtered by the server to the viewer's own live seats (same seat
  source as the decision route). See docs/development/approval-cancel-entry-phase-b-fe-design-20260929.md
  §B2.

  - `canDecide` is the caller's display predicate (`canDecideCancelRoundWith`, the same one the approval
    surfaces use). False ⇒ nothing is rendered and nothing is read.
  - A failed read (any non-2xx, including a route that is not there, or a malformed body) is its own
    state with its own copy and a retry — never rendered like 「no pending cancellations」.
  - Approve / reject go through `decideCancelRoundOnRequest`: the summary is read first and the round on
    screen (engine instance id AND round id from the list) must still be the leave's pending round, or
    nothing is sent; after the decision the server-named `roundId` must match, or the page says it could
    not confirm (not 「failed」, not 「done」). The list is re-read after every attempt.
  - No approver / seat names are rendered (P-6): the list names only the requester and the leave.
  - The launch flag (`entryEnabled`) gates launching a round, not deciding one: this list does not read it.
  - Deep link (`?requestId=`, e.g. a cancel round's todo item, P-11 (a)): the matching row is marked and,
    once per request id, brought into view — for an approver this row is where the decision is made — and
    `focused-row-shown` tells the page, whose own section scroll must then leave it in view.
  - Decision copy says what the click does (this approver's decision is submitted); the round's outcome is
    read back, not promised: a countersigned round needs every seat, and an approved round can still block.
-->
<template>
  <section
    v-if="canDecide"
    ref="rootEl"
    class="attendance-cancel-round-approver"
    :aria-labelledby="titleId"
    data-cancel-round-pending
    :data-cancel-round-pending-state="loadState"
  >
    <div class="attendance-cancel-round-approver__header">
      <h3 :id="titleId" class="attendance-cancel-round-approver__title">
        {{ tr('Cancellation requests awaiting my approval', '待我审批的撤销申请') }}
        <span v-if="loadState === 'ready'" class="attendance-cancel-round-approver__count" data-cancel-round-pending-total>{{ total }}</span>
      </h3>
      <button
        type="button"
        class="attendance__btn attendance__btn--compact"
        :disabled="loadState === 'loading' || busy"
        data-cancel-round-pending-reload
        @click="load"
      >
        {{ tr('Reload', '重载') }}
      </button>
    </div>

    <p
      v-if="notice"
      class="attendance-cancel-round-approver__notice"
      :class="`attendance-cancel-round-approver__notice--${notice.kind}`"
      :role="notice.kind === 'error' ? 'alert' : 'status'"
      data-cancel-round-pending-notice
      :data-notice-kind="notice.kind"
    >
      <StatusTag v-if="notice.presentationKey" domain="cancelRound" :status="notice.presentationKey" size="sm" />
      <span>{{ notice.message }}</span>
    </p>

    <p v-if="loadState === 'loading'" class="attendance-cancel-round-approver__note" data-cancel-round-pending-loading>
      {{ tr('Loading...', '加载中...') }}
    </p>
    <p
      v-else-if="loadState === 'error'"
      class="attendance-cancel-round-approver__unavailable"
      role="status"
      data-cancel-round-pending-error
    >
      {{ tr('Cancellation requests awaiting your approval cannot be shown right now.', '待我审批的撤销申请暂时无法读取。') }}
      <button type="button" class="attendance__btn attendance__btn--compact" data-cancel-round-pending-retry @click="load">
        {{ tr('Retry', '重试') }}
      </button>
    </p>
    <p
      v-else-if="loadState === 'ready' && items.length === 0"
      class="attendance-cancel-round-approver__note"
      data-cancel-round-pending-empty
    >
      {{ tr('No cancellation requests are waiting for your approval.', '暂无待我审批的撤销申请。') }}
    </p>
    <template v-else-if="loadState === 'ready'">
      <p v-if="total > items.length" class="attendance-cancel-round-approver__note" data-cancel-round-pending-truncated>
        {{ tr(`Showing ${items.length} of ${total}.`, `显示 ${items.length} 条,共 ${total} 条。`) }}
      </p>
      <ul class="attendance-cancel-round-approver__list" data-cancel-round-pending-list>
        <li
          v-for="item in items"
          :key="item.roundId"
          class="attendance-cancel-round-approver__item"
          :class="{ 'attendance-cancel-round-approver__item--focused': isFocused(item) }"
          :data-cancel-round-pending-item="item.requestId"
          :data-cancel-round-pending-focused="isFocused(item) ? 'true' : undefined"
        >
          <div class="attendance-cancel-round-approver__line">
            <strong>{{ requesterLabel(item) }}</strong>
            <span>· {{ requestTypeLabel(item) }}</span>
            <StatusTag domain="cancelRound" status="cancellation_pending_approval" size="sm" data-cancel-round-pending-status />
          </div>
          <div class="attendance-cancel-round-approver__meta">
            <span data-cancel-round-pending-period>{{ tr('Leave period', '请假时间') }}: {{ formatStamp(item.startAt) }} – {{ formatStamp(item.endAt) }}</span>
            <span data-cancel-round-pending-launched>{{ tr('Cancellation requested', '撤销发起于') }}: {{ formatStamp(item.launchedAt) }}</span>
          </div>

          <div
            v-if="confirming && confirming.roundId === item.roundId"
            class="attendance-cancel-round-approver__confirm"
            data-cancel-round-pending-confirm
            :data-confirm-action="confirming.action"
          >
            <p class="attendance-cancel-round-approver__note">
              {{ confirming.action === 'approve'
                ? tr('Approve this cancellation request? The leave is cancelled only when the cancellation request is fully approved.', '确认通过这条撤销申请?撤销申请全部审批通过后,该请假才会被取消。')
                : tr('Reject this cancellation request? If it is rejected, the leave stays valid.', '确认驳回这条撤销申请?撤销申请被驳回时,请假仍然有效。') }}
            </p>
            <label v-if="confirming.action === 'reject'" class="attendance-cancel-round-approver__field">
              <span>{{ tr('Comment (optional)', '驳回说明(可选)') }}</span>
              <textarea v-model="comment" rows="2" maxlength="2000" data-cancel-round-pending-comment />
            </label>
            <div class="attendance-cancel-round-approver__actions">
              <button type="button" class="attendance__btn" :disabled="busy" data-cancel-round-pending-confirm-cancel @click="cancelConfirm">
                {{ tr('Cancel', '取消') }}
              </button>
              <button
                type="button"
                class="attendance__btn attendance__btn--primary"
                :disabled="busy"
                data-cancel-round-pending-confirm-submit
                @click="submit(item)"
              >
                {{ busy
                  ? tr('Submitting...', '提交中...')
                  : confirming.action === 'approve' ? tr('Confirm approval', '确认通过') : tr('Confirm rejection', '确认驳回') }}
              </button>
            </div>
          </div>
          <div v-else class="attendance-cancel-round-approver__actions">
            <button
              type="button"
              class="attendance__btn attendance__btn--compact"
              :disabled="busy"
              data-cancel-round-pending-approve
              @click="startConfirm(item, 'approve')"
            >
              {{ tr('Approve', '通过') }}
            </button>
            <button
              type="button"
              class="attendance__btn attendance__btn--compact attendance__btn--danger"
              :disabled="busy"
              data-cancel-round-pending-reject
              @click="startConfirm(item, 'reject')"
            >
              {{ tr('Reject', '驳回') }}
            </button>
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, useId, watch } from 'vue'
import StatusTag from '../../components/status/StatusTag.vue'
import { useLocale } from '../../composables/useLocale'
import {
  CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED,
  decideCancelRoundOnRequest,
  describeCancelRoundError,
  fetchPendingCancelRounds,
  type PendingCancelRoundItem,
} from '../../approvals/cancelRound'

const props = withDefaults(defineProps<{
  canDecide: boolean
  /** The attendance page's deep-link request id (`?requestId=`): the matching row is marked. */
  focusRequestId?: string
  formatDateTime?: (value: string | null | undefined) => string
  formatRequestType?: (value: string) => string
}>(), {
  focusRequestId: '',
  formatDateTime: undefined,
  formatRequestType: undefined,
})

const emit = defineEmits<{
  /** The deep-linked row was brought into view (once per request id). */
  (e: 'focused-row-shown', requestId: string): void
}>()

const { isZh } = useLocale()
const tr = (en: string, zh: string): string => (isZh.value ? zh : en)
const titleId = `${useId()}-title`

type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type NoticeKind = 'success' | 'unconfirmed' | 'error'
interface Notice {
  kind: NoticeKind
  message: string
  presentationKey: 'action_incomplete_retry' | 'system_busy_retry' | null
}

const loadState = ref<LoadState>('idle')
const items = ref<PendingCancelRoundItem[]>([])
const total = ref(0)
const busy = ref(false)
const notice = ref<Notice | null>(null)
const confirming = ref<{ roundId: string; action: 'approve' | 'reject' } | null>(null)
const comment = ref('')
const rootEl = ref<HTMLElement | null>(null)
let generation = 0
let landedFor = ''

async function load(): Promise<void> {
  if (!props.canDecide) return
  generation += 1
  const mine = generation
  // A re-read after a decision keeps the current list on screen until the answer lands.
  if (loadState.value !== 'ready') loadState.value = 'loading'
  try {
    const list = await fetchPendingCancelRounds()
    if (mine !== generation) return
    items.value = list.items
    total.value = list.total
    loadState.value = 'ready'
    void landOnFocusedRow()
  } catch {
    if (mine !== generation) return
    items.value = []
    total.value = 0
    loadState.value = 'error'
  }
}

function isFocused(item: PendingCancelRoundItem): boolean {
  const focus = props.focusRequestId.trim()
  return focus.length > 0 && item.requestId === focus
}

/** Deep link: bring the linked row into view once per request id (re-reads after a decision do not scroll). */
async function landOnFocusedRow(): Promise<void> {
  const focus = props.focusRequestId.trim()
  if (!focus || landedFor === focus || loadState.value !== 'ready') return
  if (!items.value.some((item) => item.requestId === focus)) return
  landedFor = focus
  await nextTick()
  const row = rootEl.value?.querySelector('[data-cancel-round-pending-focused="true"]')
  if (row instanceof HTMLElement && typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ behavior: 'auto', block: 'center' })
  }
  emit('focused-row-shown', focus)
}

function requesterLabel(item: PendingCancelRoundItem): string {
  if (item.requesterName) return item.requesterName
  if (item.requesterUserId) return `${tr('User', '用户')} ${item.requesterUserId}`
  return '--'
}

function requestTypeLabel(item: PendingCancelRoundItem): string {
  const type = item.requestType ?? ''
  if (props.formatRequestType) return props.formatRequestType(type)
  return type === 'leave' ? tr('Leave', '请假') : type || '--'
}

function formatStamp(value: string | null): string {
  if (props.formatDateTime) return props.formatDateTime(value)
  if (!value) return '--'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '--' : date.toLocaleString(isZh.value ? 'zh-CN' : 'en-US')
}

function startConfirm(item: PendingCancelRoundItem, action: 'approve' | 'reject'): void {
  if (busy.value) return
  comment.value = ''
  confirming.value = { roundId: item.roundId, action }
}

function cancelConfirm(): void {
  if (busy.value) return
  confirming.value = null
}

async function submit(item: PendingCancelRoundItem): Promise<void> {
  const current = confirming.value
  if (busy.value || !current || current.roundId !== item.roundId) return
  busy.value = true
  notice.value = null
  try {
    await decideCancelRoundOnRequest(
      item.requestId,
      { engineInstanceId: item.engineInstanceId, roundId: item.roundId },
      current.action,
      current.action === 'reject' ? comment.value : null,
      isZh.value,
    )
    notice.value = {
      kind: 'success',
      message: current.action === 'approve'
        ? tr('Your approval was submitted.', '已提交通过意见')
        : tr('Your rejection was submitted.', '已提交驳回意见'),
      presentationKey: null,
    }
  } catch (error) {
    const described = describeCancelRoundError(error, isZh.value, tr('The action could not be completed.', '操作未能完成'))
    notice.value = {
      kind: described.code === CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED ? 'unconfirmed' : 'error',
      message: described.message,
      presentationKey: described.presentationKey,
    }
  } finally {
    confirming.value = null
    busy.value = false
  }
  await load()
}

onMounted(() => { void load() })
watch(() => props.canDecide, () => { void load() })
watch(() => props.focusRequestId, () => { void landOnFocusedRow() })
</script>

<style scoped>
.attendance-cancel-round-approver {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.attendance-cancel-round-approver__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2);
}

.attendance-cancel-round-approver__title {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  margin: 0;
  font-size: var(--ms-font-size-section-title);
}

.attendance-cancel-round-approver__count {
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: normal;
}

.attendance-cancel-round-approver__note,
.attendance-cancel-round-approver__unavailable {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 12px;
}

.attendance-cancel-round-approver__notice {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  margin: 0;
  font-size: 12px;
  color: var(--ms-text-1);
}

.attendance-cancel-round-approver__notice--error {
  color: var(--ms-color-danger);
}

.attendance-cancel-round-approver__list {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.attendance-cancel-round-approver__item {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-sm);
}

.attendance-cancel-round-approver__item--focused {
  border-color: var(--ms-color-warning);
}

.attendance-cancel-round-approver__line,
.attendance-cancel-round-approver__meta,
.attendance-cancel-round-approver__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

.attendance-cancel-round-approver__meta {
  color: var(--ms-text-2);
  font-size: 12px;
}

.attendance-cancel-round-approver__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.attendance-cancel-round-approver__field {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
  font-size: 13px;
}
</style>
