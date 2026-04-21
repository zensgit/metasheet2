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
          </select>
          <button class="meta-person-delivery__btn" type="button" data-action="refresh" @click="loadData">Refresh</button>
        </div>

        <div v-if="loading" class="meta-person-delivery__empty">Loading deliveries...</div>
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
              :class="delivery.success ? 'meta-person-delivery__badge--success' : 'meta-person-delivery__badge--failed'"
              :data-status="delivery.success ? 'success' : 'failed'"
            >
              {{ delivery.success ? 'success' : 'failed' }}
            </span>
            <span class="meta-person-delivery__time">{{ formatTime(delivery.createdAt) }}</span>
          </div>
          <div v-if="delivery.localUserSubtitle || delivery.dingtalkUserId" class="meta-person-delivery__detail">
            <span v-if="delivery.localUserSubtitle">{{ delivery.localUserSubtitle }}</span>
            <span v-if="delivery.dingtalkUserId">DingTalk: {{ delivery.dingtalkUserId }}</span>
          </div>
          <div class="meta-person-delivery__subject">{{ delivery.subject }}</div>
          <div v-if="!delivery.success && delivery.errorMessage" class="meta-person-delivery__error">{{ delivery.errorMessage }}</div>
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

async function loadData() {
  if (!props.client || !props.sheetId || !props.ruleId) return
  loading.value = true
  try {
    deliveries.value = await props.client.getAutomationDingTalkPersonDeliveries(props.sheetId, props.ruleId, 50)
  } catch {
    deliveries.value = []
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
</style>
