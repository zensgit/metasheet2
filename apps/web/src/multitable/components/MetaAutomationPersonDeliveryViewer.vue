<template>
  <div v-if="visible" class="meta-person-delivery__overlay" @click.self="$emit('close')">
    <div class="meta-person-delivery">
      <div class="meta-person-delivery__header">
        <h4 class="meta-person-delivery__title">DingTalk Person Deliveries</h4>
        <button class="meta-person-delivery__close" type="button" @click="$emit('close')">&times;</button>
      </div>

      <div class="meta-person-delivery__body">
        <div class="meta-person-delivery__toolbar">
          <select v-model="statusFilter" class="meta-person-delivery__select" data-field="statusFilter">
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped / unbound</option>
          </select>
          <button class="meta-person-delivery__btn" type="button" :disabled="loading" data-action="refresh" @click="loadData">Refresh</button>
        </div>

        <div v-if="loading" class="meta-person-delivery__empty">Loading deliveries...</div>
        <div v-else-if="errorMessage" class="meta-person-delivery__error-state" data-person-delivery-error="true">
          {{ errorMessage }}
        </div>
        <div v-else-if="filteredDeliveries.length === 0" class="meta-person-delivery__empty" data-empty="true">
          No DingTalk person deliveries found.
        </div>

        <div
          v-for="delivery in filteredDeliveries"
          :key="delivery.id"
          class="meta-person-delivery__item"
          :data-person-delivery-id="delivery.id"
        >
          <div class="meta-person-delivery__summary">
            <span class="meta-person-delivery__recipient">
              {{ delivery.localUserLabel || delivery.localUserId }}
              <em v-if="!delivery.localUserIsActive">Inactive user</em>
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
          <div v-if="delivery.localUserSubtitle || delivery.dingtalkUserId" class="meta-person-delivery__detail">
            <span v-if="delivery.localUserSubtitle">{{ delivery.localUserSubtitle }}</span>
            <span v-if="delivery.dingtalkUserId">DingTalk: {{ delivery.dingtalkUserId }}</span>
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
import type { DingTalkPersonDelivery } from '../types'
import type { MultitableApiClient } from '../api/client'

const props = defineProps<{
  visible: boolean
  sheetId: string
  ruleId: string
  client?: MultitableApiClient
}>()

defineEmits<{
  (e: 'close'): void
}>()

const loading = ref(false)
const deliveries = ref<DingTalkPersonDelivery[]>([])
const statusFilter = ref('')
const errorMessage = ref('')

const filteredDeliveries = computed(() => {
  if (!statusFilter.value) return deliveries.value
  return deliveries.value.filter((delivery) => deliveryStatus(delivery) === statusFilter.value)
})

type DeliveryStatus = 'success' | 'failed' | 'skipped'

const UNBOUND_DINGTALK_REASON = 'DingTalk account is not linked or user is inactive'

function deliveryStatus(delivery: DingTalkPersonDelivery): DeliveryStatus {
  if (delivery.status === 'success' || delivery.status === 'failed' || delivery.status === 'skipped') return delivery.status
  if (delivery.success) return 'success'
  if (!delivery.dingtalkUserId && delivery.errorMessage === UNBOUND_DINGTALK_REASON) return 'skipped'
  return 'failed'
}

function deliveryStatusLabel(delivery: DingTalkPersonDelivery): string {
  const status = deliveryStatus(delivery)
  if (status === 'skipped') return 'skipped'
  return status
}

function deliveryReason(delivery: DingTalkPersonDelivery): string {
  if (deliveryStatus(delivery) === 'skipped') {
    return delivery.errorMessage || UNBOUND_DINGTALK_REASON
  }
  return delivery.errorMessage || ''
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Failed to load DingTalk person deliveries.'
}

async function loadData() {
  if (!props.client || !props.sheetId || !props.ruleId) return
  loading.value = true
  errorMessage.value = ''
  try {
    deliveries.value = await props.client.getAutomationDingTalkPersonDeliveries(props.sheetId, props.ruleId, 50)
  } catch (error) {
    deliveries.value = []
    errorMessage.value = readErrorMessage(error)
  } finally {
    loading.value = false
  }
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      statusFilter.value = ''
      void loadData()
    }
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

.meta-person-delivery__close {
  border: none;
  background: none;
  font-size: 22px;
  cursor: pointer;
  color: #64748b;
  line-height: 1;
  padding: 0 4px;
}

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

.meta-person-delivery__btn {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 14px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

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
