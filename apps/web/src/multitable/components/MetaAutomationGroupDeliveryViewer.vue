<template>
  <div v-if="visible" class="meta-group-delivery__overlay" @click.self="$emit('close')">
    <div class="meta-group-delivery">
      <div class="meta-group-delivery__header">
        <h4 class="meta-group-delivery__title">DingTalk Group Deliveries</h4>
        <button class="meta-group-delivery__close" type="button" @click="$emit('close')">&times;</button>
      </div>

      <div class="meta-group-delivery__body">
        <div class="meta-group-delivery__toolbar">
          <select v-model="statusFilter" class="meta-group-delivery__select" data-field="statusFilter">
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>
          <button class="meta-group-delivery__btn" type="button" :disabled="loading" data-action="refresh" @click="loadData">Refresh</button>
        </div>

        <div v-if="loading" class="meta-group-delivery__empty">Loading deliveries...</div>
        <div v-else-if="errorMessage" class="meta-group-delivery__error-state" data-group-delivery-error="true">
          {{ errorMessage }}
        </div>
        <div v-else-if="filteredDeliveries.length === 0" class="meta-group-delivery__empty" data-empty="true">
          No DingTalk group deliveries found.
        </div>

        <div
          v-for="delivery in filteredDeliveries"
          :key="delivery.id"
          class="meta-group-delivery__item"
          :data-group-delivery-id="delivery.id"
        >
          <div class="meta-group-delivery__summary">
            <span class="meta-group-delivery__destination">{{ delivery.destinationName || delivery.destinationId }}</span>
            <span
              class="meta-group-delivery__badge"
              :class="delivery.success ? 'meta-group-delivery__badge--success' : 'meta-group-delivery__badge--failed'"
              :data-status="delivery.success ? 'success' : 'failed'"
            >
              {{ delivery.success ? 'success' : 'failed' }}
            </span>
            <span class="meta-group-delivery__time">{{ formatTime(delivery.createdAt) }}</span>
          </div>
          <div class="meta-group-delivery__subject">{{ delivery.subject }}</div>
          <div v-if="!delivery.success && delivery.errorMessage" class="meta-group-delivery__error">{{ delivery.errorMessage }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DingTalkGroupDelivery } from '../types'
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
const deliveries = ref<DingTalkGroupDelivery[]>([])
const statusFilter = ref('')
const errorMessage = ref('')

const filteredDeliveries = computed(() => {
  if (!statusFilter.value) return deliveries.value
  const expected = statusFilter.value === 'success'
  return deliveries.value.filter((delivery) => delivery.success === expected)
})

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
    : 'Failed to load DingTalk group deliveries.'
}

async function loadData() {
  if (!props.client || !props.sheetId || !props.ruleId) return
  loading.value = true
  errorMessage.value = ''
  try {
    deliveries.value = await props.client.getAutomationDingTalkGroupDeliveries(props.sheetId, props.ruleId, 50)
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
.meta-group-delivery__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.meta-group-delivery {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 620px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.meta-group-delivery__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-group-delivery__title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: #0f172a;
}

.meta-group-delivery__close {
  border: none;
  background: none;
  font-size: 22px;
  cursor: pointer;
  color: #64748b;
  line-height: 1;
  padding: 0 4px;
}

.meta-group-delivery__body {
  padding: 16px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta-group-delivery__toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}

.meta-group-delivery__select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: #fff;
}

.meta-group-delivery__btn {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 14px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-group-delivery__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #f8fafc;
  color: #64748b;
}

.meta-group-delivery__item {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-group-delivery__summary {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.meta-group-delivery__destination {
  font-weight: 600;
  color: #0f172a;
}

.meta-group-delivery__badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.meta-group-delivery__badge--success {
  background: #dcfce7;
  color: #16a34a;
}

.meta-group-delivery__badge--failed {
  background: #fee2e2;
  color: #dc2626;
}

.meta-group-delivery__time {
  margin-left: auto;
  color: #64748b;
}

.meta-group-delivery__subject {
  font-size: 13px;
  color: #334155;
}

.meta-group-delivery__error {
  color: #dc2626;
  font-size: 12px;
}

.meta-group-delivery__error-state {
  padding: 10px 12px;
  border: 1px solid #fecaca;
  border-radius: 10px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 13px;
}
</style>
