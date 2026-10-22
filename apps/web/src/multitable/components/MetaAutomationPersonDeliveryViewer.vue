<template>
  <div v-if="visible" class="meta-person-delivery__overlay" @click.self="$emit('close')">
    <div class="meta-person-delivery">
      <div class="meta-person-delivery__header">
        <h4 class="meta-person-delivery__title">{{ automationLabel('delivery.personTitle', isZh) }}</h4>
        <MtIconButton class="meta-person-delivery__close" @click="$emit('close')">&times;</MtIconButton>
      </div>

      <div class="meta-person-delivery__body">
        <div class="meta-person-delivery__toolbar">
          <select v-model="statusFilter" class="meta-person-delivery__select" data-field="statusFilter">
            <option value="">{{ automationLabel('status.all', isZh) }}</option>
            <option value="success">{{ automationStatusLabel('success', isZh) }}</option>
            <option value="failed">{{ automationStatusLabel('failed', isZh) }}</option>
            <option value="skipped">{{ automationLabel('delivery.statusSkippedUnbound', isZh) }}</option>
            <option value="outcome_unknown">{{ automationStatusLabel('outcome_unknown', isZh) }}</option>
          </select>
          <MtButton class="meta-person-delivery__btn" data-action="refresh" :disabled="loading" @click="loadData">{{ automationLabel('log.refresh', isZh) }}</MtButton>
        </div>

        <div v-if="loading" class="meta-person-delivery__empty">{{ automationLabel('delivery.loading', isZh) }}</div>
        <div v-else-if="errorMessage" class="meta-person-delivery__error-state" data-person-delivery-error="true">
          {{ errorMessage }}
        </div>
        <div v-else-if="filteredDeliveries.length === 0" class="meta-person-delivery__empty" data-empty="true">
          {{ automationLabel('delivery.emptyPerson', isZh) }}
        </div>

        <div
          v-for="delivery in filteredDeliveries"
          :key="delivery.id"
          class="meta-person-delivery__item"
          :data-person-delivery-id="delivery.id"
        >
          <div class="meta-person-delivery__summary">
            <!-- 客户反馈 2026-10-21 item 1 (review round 2): the name slot never shows the bare id; an id with no
                 user reads 未找到该用户 (not "inactive user"), and the id moves to the secondary line. -->
            <span class="meta-person-delivery__recipient" data-field="person-delivery-recipient">
              {{ recipientName(delivery) }}
              <em v-if="delivery.localUserExists !== false && delivery.localUserIsActive === false">{{ automationLabel('delivery.inactiveUser', isZh) }}</em>
            </span>
            <span
              class="meta-person-delivery__badge"
              :class="`meta-person-delivery__badge--${deliveryStatus(delivery)}`"
              :data-status="deliveryStatus(delivery)"
            >
              {{ deliveryStatusLabel(delivery) }}
            </span>
            <span class="meta-person-delivery__time">{{ formatTime(delivery.createdAt) }}</span>
          </div>
          <div v-if="delivery.localUserSubtitle || delivery.dingtalkUserId || !hasRealName(delivery)" class="meta-person-delivery__detail">
            <span v-if="!hasRealName(delivery)" data-field="person-delivery-local-user-id">{{ delivery.localUserId }}</span>
            <span v-if="delivery.localUserSubtitle">{{ delivery.localUserSubtitle }}</span>
            <span v-if="delivery.dingtalkUserId">{{ automationLabel('delivery.dingtalkPrefix', isZh) }}{{ isZh ? '：' : ': ' }}{{ delivery.dingtalkUserId }}</span>
          </div>
          <div class="meta-person-delivery__subject">{{ delivery.subject }}</div>
          <div v-if="deliveryStatus(delivery) !== 'success' && deliveryReason(delivery)" class="meta-person-delivery__error">
            {{ deliveryReason(delivery) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { DingTalkPersonDelivery } from '../types'
import type { MultitableApiClient } from '../api/client'
import { automationLabel, automationStatusLabel } from '../utils/meta-automation-labels'
import { formatBusinessTimestamp } from '../utils/business-timezone'
import { MtButton, MtIconButton } from '../ui'

function hasRealName(delivery: DingTalkPersonDelivery): boolean {
  return delivery.localUserExists !== false && Boolean(delivery.localUserLabel) && delivery.localUserLabel !== delivery.localUserId
}

function recipientName(delivery: DingTalkPersonDelivery): string {
  if (delivery.localUserExists === false) return automationLabel('delivery.userNotFound', isZh.value)
  return hasRealName(delivery) ? delivery.localUserLabel as string : automationLabel('delivery.unnamedUser', isZh.value)
}

const props = defineProps<{
  visible: boolean
  sheetId: string
  ruleId: string
  client?: MultitableApiClient
  /** 客户反馈 2026-10-21 item 1 (review round 1): opened from a run log row → start on 跳过（未绑定）. */
  initialStatusFilter?: string
}>()

defineEmits<{
  (e: 'close'): void
}>()

const loading = ref(false)
const deliveries = ref<DingTalkPersonDelivery[]>([])
const statusFilter = ref('')
let loadRequestId = 0
const SERVER_STATUS_FILTERS = ['success', 'failed', 'skipped', 'outcome_unknown'] as const
function isServerStatusFilter(value: string): value is (typeof SERVER_STATUS_FILTERS)[number] {
  return (SERVER_STATUS_FILTERS as readonly string[]).includes(value)
}
const errorMessage = ref('')
const { isZh } = useLocale()

const filteredDeliveries = computed(() => {
  if (!statusFilter.value) return deliveries.value
  return deliveries.value.filter((delivery) => deliveryStatus(delivery) === statusFilter.value)
})

// 'outcome_unknown' (PR #4046 Phase B): the send was attempted and the response lost — the
// message MAY have been delivered. Distinct badge/filter value; folding it into 'failed' would
// erase the reconciliation signal.
type DeliveryStatus = 'success' | 'failed' | 'skipped' | 'outcome_unknown'

const UNBOUND_DINGTALK_REASON = 'DingTalk account is not linked or user is inactive'

function deliveryStatus(delivery: DingTalkPersonDelivery): DeliveryStatus {
  if (delivery.status === 'success' || delivery.status === 'failed' || delivery.status === 'skipped' || delivery.status === 'outcome_unknown') return delivery.status
  if (delivery.success) return 'success'
  if (!delivery.dingtalkUserId && delivery.errorMessage === UNBOUND_DINGTALK_REASON) return 'skipped'
  return 'failed'
}

function deliveryStatusLabel(delivery: DingTalkPersonDelivery): string {
  const status = deliveryStatus(delivery)
  return automationStatusLabel(status, isZh.value)
}

function deliveryReason(delivery: DingTalkPersonDelivery): string {
  if (deliveryStatus(delivery) === 'skipped') {
    if (delivery.errorMessage === UNBOUND_DINGTALK_REASON || !delivery.errorMessage) {
      // Review round 2: the sender stores one generic sentence for every skip; name the real cause where the
      // user's CURRENT row tells it (gone / inactive / active without a DingTalk link). Older servers that do
      // not send `localUserExists` keep the generic sentence.
      if (delivery.localUserExists === false) return automationLabel('delivery.reasonUserNotFound', isZh.value)
      if (delivery.localUserExists === true && delivery.localUserIsActive === false) return automationLabel('delivery.reasonUserInactive', isZh.value)
      if (delivery.localUserExists === true && delivery.localUserIsActive === true && !delivery.dingtalkUserId) return automationLabel('delivery.reasonNotLinked', isZh.value)
      return automationLabel('delivery.unboundReason', isZh.value)
    }
    return delivery.errorMessage
  }
  return delivery.errorMessage || ''
}

// 客户反馈 2026-09-24 #4c follow-up: the business timezone, fixed 24-hour format — not the browser's zone / locale.
function formatTime(ts: string): string {
  return formatBusinessTimestamp(ts, { precision: 'second' }) ?? ts
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : automationLabel('error.loadPersonDeliveries', isZh.value)
}

async function loadData() {
  if (!props.client || !props.sheetId || !props.ruleId) return
  const requestId = ++loadRequestId
  loading.value = true
  errorMessage.value = ''
  try {
    const status = isServerStatusFilter(statusFilter.value) ? statusFilter.value : undefined
    // Unfiltered loads keep the original 3-argument call; the options argument only carries a status.
    const loaded = status
      ? await props.client.getAutomationDingTalkPersonDeliveries(props.sheetId, props.ruleId, 50, { status })
      : await props.client.getAutomationDingTalkPersonDeliveries(props.sheetId, props.ruleId, 50)
    if (requestId !== loadRequestId) return
    deliveries.value = loaded
  } catch (error) {
    if (requestId !== loadRequestId) return
    deliveries.value = []
    errorMessage.value = readErrorMessage(error)
  } finally {
    if (requestId === loadRequestId) loading.value = false
  }
}

// Review round 2: the status filter is applied by the SERVER (before its LIMIT), so the skipped rows of an
// older run are not lost behind the latest 50. Changing it reloads; the list is still filtered locally too.
watch(statusFilter, () => {
  if (props.visible) void loadData()
})

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return
    const next = props.initialStatusFilter ?? ''
    if (statusFilter.value !== next) statusFilter.value = next // the watcher above loads
    else void loadData()
  },
  { immediate: true },
)
</script>

<style scoped>
.meta-person-delivery__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.meta-person-delivery {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 620px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.meta-person-delivery__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-person-delivery__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}

/* .meta-person-delivery__close: now <MtIconButton> (ghost, token-styled; the &times; glyph char passes
   through its default-slot icon fallback (size token-normalized to the icon control)). Bespoke hardcoded
   CSS removed (UI-P2-1c T1 batch-4). Class kept on the element only for selector stability. */

.meta-person-delivery__body {
  padding: 16px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta-person-delivery__toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.meta-person-delivery__select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: #fff;
}

/* .meta-person-delivery__btn: the Refresh control is now <MtButton> (ghost, token-styled — it was a neutral
   bordered-white secondary action). Bespoke hex CSS removed to avoid double-styling the MtButton root; class
   + data-action kept for selector stability. The header close-× glyph stays bespoke. */

.meta-person-delivery__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #f8fafc;
  color: #64748b;
}

.meta-person-delivery__item {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-person-delivery__summary {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.meta-person-delivery__recipient {
  font-weight: 600;
  color: #0f172a;
}

.meta-person-delivery__recipient em {
  margin-left: 8px;
  font-style: normal;
  font-size: 11px;
  color: #b45309;
}

.meta-person-delivery__badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.meta-person-delivery__badge--success {
  background: #dcfce7;
  color: #16a34a;
}

.meta-person-delivery__badge--failed {
  background: #fee2e2;
  color: #dc2626;
}

.meta-person-delivery__badge--skipped {
  background: #fef3c7;
  color: #b45309;
}

.meta-person-delivery__badge--outcome_unknown {
  background: #e2e8f0;
  color: #475569;
}

.meta-person-delivery__time {
  margin-left: auto;
  color: #64748b;
}

.meta-person-delivery__detail {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #475569;
}

.meta-person-delivery__subject {
  color: #0f172a;
  font-size: 13px;
}

.meta-person-delivery__error {
  font-size: 12px;
  color: #b91c1c;
}

.meta-person-delivery__error-state {
  padding: 10px 12px;
  border: 1px solid #fecaca;
  border-radius: 10px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 13px;
}
</style>
