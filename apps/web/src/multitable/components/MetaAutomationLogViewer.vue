<template>
  <div v-if="visible" class="meta-log-viewer__overlay" @click.self="$emit('close')">
    <div class="meta-log-viewer">
      <div class="meta-log-viewer__header">
        <h4 class="meta-log-viewer__title">Execution Logs</h4>
        <button class="meta-log-viewer__close" type="button" @click="$emit('close')">&times;</button>
      </div>

      <div class="meta-log-viewer__body">
        <!-- Stats bar -->
        <div v-if="stats" class="meta-log-viewer__stats" data-stats="true">
          <div class="meta-log-viewer__stat">
            <span class="meta-log-viewer__stat-label">Total</span>
            <span class="meta-log-viewer__stat-value">{{ stats.total }}</span>
          </div>
          <div class="meta-log-viewer__stat">
            <span class="meta-log-viewer__stat-label">Success</span>
            <span class="meta-log-viewer__stat-value meta-log-viewer__stat-value--success">{{ stats.success }}</span>
          </div>
          <div class="meta-log-viewer__stat">
            <span class="meta-log-viewer__stat-label">Failed</span>
            <span class="meta-log-viewer__stat-value meta-log-viewer__stat-value--failed">{{ stats.failed }}</span>
          </div>
          <div class="meta-log-viewer__stat">
            <span class="meta-log-viewer__stat-label">Avg duration</span>
            <span class="meta-log-viewer__stat-value">{{ stats.avgDuration }}ms</span>
          </div>
        </div>

        <!-- Toolbar -->
        <div class="meta-log-viewer__toolbar">
          <select v-model="statusFilter" class="meta-log-viewer__select" data-field="statusFilter">
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
          </select>
          <button class="meta-log-viewer__btn" type="button" data-action="refresh" @click="loadData">Refresh</button>
        </div>

        <!-- Load error (replaces previous silent catch) -->
        <div
          v-if="loadError"
          class="meta-log-viewer__error"
          data-error="true"
          role="alert"
        >
          <span class="meta-log-viewer__error-label">Failed to load logs:</span>
          <span class="meta-log-viewer__error-message" data-field="error-message">{{ loadError }}</span>
          <button
            type="button"
            class="meta-log-viewer__btn meta-log-viewer__btn--retry"
            data-action="retry"
            @click="loadData"
          >Retry</button>
        </div>

        <!-- Log list -->
        <div v-if="loading" class="meta-log-viewer__empty">Loading logs...</div>
        <div v-else-if="!loadError && filteredLogs.length === 0" class="meta-log-viewer__empty" data-empty="true">No execution logs found.</div>
        <div
          v-for="log in filteredLogs"
          :key="log.id"
          class="meta-log-viewer__log-item"
          :data-log-id="log.id"
          @click="toggleExpand(log.id)"
        >
          <div class="meta-log-viewer__log-summary">
            <span class="meta-log-viewer__log-time">{{ formatTime(log.triggeredAt) }}</span>
            <span
              class="meta-log-viewer__badge"
              :class="`meta-log-viewer__badge--${log.status}`"
              :data-status="log.status"
            >{{ log.status }}</span>
            <span class="meta-log-viewer__log-trigger" data-field="triggeredBy">{{ log.triggeredBy }}</span>
            <span class="meta-log-viewer__log-duration">{{ log.duration ?? '-' }}ms</span>
          </div>
          <div v-if="expandedId === log.id && log.steps" class="meta-log-viewer__log-detail" data-detail="true">
            <div class="meta-log-viewer__support-actions">
              <button
                class="meta-log-viewer__btn meta-log-viewer__btn--support"
                type="button"
                data-action="copy-support-packet"
                @click.stop="copySupportPacket(log)"
              >Copy redacted packet</button>
              <button
                class="meta-log-viewer__btn meta-log-viewer__btn--support"
                type="button"
                data-action="download-support-packet"
                @click.stop="downloadSupportPacket(log)"
              >Download JSON</button>
              <span
                v-if="supportPacketStatus[log.id]"
                class="meta-log-viewer__support-status"
                data-field="support-packet-status"
              >{{ supportPacketStatus[log.id] }}</span>
            </div>
            <div
              v-for="(step, idx) in log.steps"
              :key="idx"
              class="meta-log-viewer__step"
            >
              <span class="meta-log-viewer__step-num">{{ idx + 1 }}.</span>
              <span class="meta-log-viewer__step-type">{{ step.actionType }}</span>
              <span
                class="meta-log-viewer__badge meta-log-viewer__badge--sm"
                :class="`meta-log-viewer__badge--${step.status}`"
              >{{ step.status }}</span>
              <span v-if="step.durationMs" class="meta-log-viewer__step-dur">{{ step.durationMs }}ms</span>
              <div
                v-if="step.error"
                class="meta-log-viewer__step-error"
                data-field="step-error"
              >{{ summarizeStepError(step.error) }}</div>
              <div
                v-if="step.output"
                class="meta-log-viewer__step-output"
                data-field="step-output"
              >{{ summarizeStepOutput(step.output) }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { AutomationExecution, AutomationStats } from '../types'
import type { MultitableApiClient } from '../api/client'
import {
  redactString,
  summarizeStepError,
  summarizeStepOutput,
} from '../utils/automation-log-redact'
import {
  createAutomationLogSupportPacketFilename,
  renderAutomationLogSupportPacketJson,
  renderAutomationLogSupportPacketMarkdown,
} from '../utils/automation-log-support-packet'

const props = defineProps<{
  sheetId: string
  ruleId: string
  visible: boolean
  client?: MultitableApiClient
}>()

defineEmits<{
  (e: 'close'): void
}>()

const loading = ref(false)
const logs = ref<AutomationExecution[]>([])
const stats = ref<AutomationStats | null>(null)
const statusFilter = ref('')
const expandedId = ref<string | null>(null)
const loadError = ref<string | null>(null)
const supportPacketStatus = ref<Record<string, string>>({})

const filteredLogs = computed(() => {
  if (!statusFilter.value) return logs.value
  return logs.value.filter((l) => l.status === statusFilter.value)
})

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

function setSupportPacketStatus(executionId: string, message: string) {
  supportPacketStatus.value = {
    ...supportPacketStatus.value,
    [executionId]: message,
  }
}

async function copySupportPacket(log: AutomationExecution) {
  try {
    const clipboard = navigator?.clipboard
    if (!clipboard?.writeText) {
      throw new Error('Clipboard unavailable')
    }
    await clipboard.writeText(renderAutomationLogSupportPacketMarkdown(log))
    setSupportPacketStatus(log.id, 'Redacted packet copied.')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    setSupportPacketStatus(log.id, redactString(`Copy failed: ${message}`))
  }
}

function downloadSupportPacket(log: AutomationExecution) {
  try {
    const blob = new Blob([renderAutomationLogSupportPacketJson(log)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = createAutomationLogSupportPacketFilename(log)
    link.click()
    URL.revokeObjectURL(url)
    setSupportPacketStatus(log.id, 'Redacted JSON downloaded.')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    setSupportPacketStatus(log.id, redactString(`Download failed: ${message}`))
  }
}

async function loadData() {
  if (!props.client || !props.sheetId || !props.ruleId) return
  loading.value = true
  loadError.value = null
  try {
    const [logsResult, statsResult] = await Promise.all([
      props.client.getAutomationLogs(props.sheetId, props.ruleId, 50),
      props.client.getAutomationStats(props.sheetId, props.ruleId),
    ])
    logs.value = logsResult
    stats.value = statsResult
  } catch (err: unknown) {
    // Surface a redacted error to the operator. Previous behaviour was a
    // silent catch which left the panel showing "No execution logs found"
    // when fetches actually failed (the user could not tell the difference
    // between an empty rule and a backend / network error).
    const message = err instanceof Error ? err.message : String(err)
    loadError.value = redactString(message) || 'Unknown error'
    logs.value = []
    stats.value = null
  } finally {
    loading.value = false
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      expandedId.value = null
      statusFilter.value = ''
      loadError.value = null
      supportPacketStatus.value = {}
      void loadData()
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.meta-log-viewer__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.meta-log-viewer {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  width: 620px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
}

.meta-log-viewer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 12px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-log-viewer__title { margin: 0; font-size: 16px; font-weight: 700; color: #0f172a; }
.meta-log-viewer__close { border: none; background: none; font-size: 22px; cursor: pointer; color: #64748b; line-height: 1; padding: 0 4px; }

.meta-log-viewer__body {
  padding: 16px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
}

.meta-log-viewer__stats {
  display: flex;
  gap: 16px;
  padding: 12px;
  background: #f8fafc;
  border-radius: 10px;
}

.meta-log-viewer__stat { display: flex; flex-direction: column; align-items: center; gap: 2px; flex: 1; }
.meta-log-viewer__stat-label { font-size: 11px; color: #94a3b8; text-transform: uppercase; font-weight: 600; }
.meta-log-viewer__stat-value { font-size: 18px; font-weight: 700; color: #0f172a; }
.meta-log-viewer__stat-value--success { color: #16a34a; }
.meta-log-viewer__stat-value--failed { color: #dc2626; }

.meta-log-viewer__toolbar { display: flex; gap: 8px; align-items: center; }

.meta-log-viewer__select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: #fff;
}

.meta-log-viewer__btn {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 14px;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}

.meta-log-viewer__empty {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #f8fafc;
  color: #64748b;
}

.meta-log-viewer__error {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  background: #fef2f2;
  color: #b91c1c;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.meta-log-viewer__error-label { font-weight: 600; }
.meta-log-viewer__error-message { flex: 1; word-break: break-word; }
.meta-log-viewer__btn--retry {
  border-color: #fecaca;
  color: #b91c1c;
  background: #fff;
}

.meta-log-viewer__log-item {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
}

.meta-log-viewer__log-item:hover { background: #f8fafc; }

.meta-log-viewer__log-summary { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.meta-log-viewer__log-time { color: #64748b; min-width: 140px; }
.meta-log-viewer__log-trigger { color: #475569; }
.meta-log-viewer__log-duration { margin-left: auto; color: #94a3b8; }

.meta-log-viewer__badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.meta-log-viewer__badge--success { background: #dcfce7; color: #16a34a; }
.meta-log-viewer__badge--failed { background: #fef2f2; color: #dc2626; }
.meta-log-viewer__badge--skipped { background: #f1f5f9; color: #64748b; }
.meta-log-viewer__badge--sm { font-size: 10px; padding: 1px 6px; }

.meta-log-viewer__log-detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #e2e8f0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-log-viewer__support-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 0 2px;
}

.meta-log-viewer__btn--support {
  padding: 4px 10px;
  font-size: 12px;
}

.meta-log-viewer__support-status {
  font-size: 12px;
  color: #64748b;
}

.meta-log-viewer__step { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.meta-log-viewer__step-num { font-weight: 700; color: #2563eb; }
.meta-log-viewer__step-type { color: #475569; }
.meta-log-viewer__step-dur { color: #94a3b8; margin-left: auto; }
.meta-log-viewer__step-error { width: 100%; padding: 4px 8px; background: #fef2f2; color: #dc2626; border-radius: 4px; font-size: 11px; }
.meta-log-viewer__step-output { width: 100%; padding: 4px 8px; background: #f8fafc; color: #475569; border-radius: 4px; font-size: 11px; word-break: break-all; }
</style>
