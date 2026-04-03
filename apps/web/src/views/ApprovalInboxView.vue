<template>
  <section class="approval-inbox">
    <header class="approval-inbox__header">
      <div>
        <h1>{{ t.title }}</h1>
        <p>{{ t.subtitle }}</p>
      </div>
      <button class="btn btn--ghost" type="button" :disabled="loading" @click="refreshInbox">
        {{ loading ? t.refreshing : t.refresh }}
      </button>
    </header>

    <div class="approval-inbox__layout">
      <article class="approval-inbox__card">
        <div class="approval-inbox__card-header">
          <h2>{{ t.pendingApprovals }}</h2>
          <span class="approval-inbox__count">{{ approvals.length }}</span>
        </div>

        <p v-if="error" class="approval-inbox__error">{{ error }}</p>
        <div v-else-if="loading" class="approval-inbox__empty">{{ t.loadingApprovals }}</div>
        <div v-else-if="!approvals.length" class="approval-inbox__empty">{{ t.noApprovals }}</div>
        <table v-else class="approval-inbox__table">
          <thead>
            <tr>
              <th>{{ t.id }}</th>
              <th>{{ t.status }}</th>
              <th>{{ t.version }}</th>
              <th>{{ t.updated }}</th>
              <th>{{ t.actions }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="approval in approvals"
              :key="approval.id"
              :class="{ 'approval-inbox__row--active': selectedApprovalId === approval.id }"
            >
              <td class="mono">{{ approval.id }}</td>
              <td>{{ approval.status }}</td>
              <td>{{ formatPendingVersion(approval) }}</td>
              <td>{{ formatDate(approval.updated_at || approval.created_at) }}</td>
              <td>
                <div class="approval-inbox__actions">
                  <button class="btn btn--ghost btn--mini" type="button" @click="selectApproval(approval.id)">
                    {{ t.historyButton }}
                  </button>
                  <button
                    class="btn btn--ghost btn--mini"
                    type="button"
                    :disabled="actingId === approval.id || !canActOnApproval(approval)"
                    @click="approve(approval.id)"
                  >
                    {{ t.approve }}
                  </button>
                  <button
                    class="btn btn--ghost btn--mini"
                    type="button"
                    :disabled="actingId === approval.id || !canActOnApproval(approval) || !canSubmitApprovalInboxAction('reject', comment)"
                    @click="reject(approval.id)"
                  >
                    {{ t.reject }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="approval-inbox__card">
        <div class="approval-inbox__card-header">
          <h2>{{ t.history }}</h2>
          <span v-if="selectedApprovalId" class="mono">{{ selectedApprovalId }}</span>
        </div>

        <label class="approval-inbox__comment">
          {{ t.actionComment }}
          <input v-model.trim="comment" type="text" :placeholder="t.actionCommentPlaceholder" />
        </label>

        <p v-if="actionStatus" class="approval-inbox__status">{{ actionStatus }}</p>
        <p v-if="historyError" class="approval-inbox__error">{{ historyError }}</p>
        <div v-else-if="historyLoading" class="approval-inbox__empty">{{ t.loadingHistory }}</div>
        <div v-else-if="!selectedApprovalId" class="approval-inbox__empty">{{ t.selectApproval }}</div>
        <div v-else-if="!history.length" class="approval-inbox__empty">{{ t.noHistory }}</div>
        <table v-else class="approval-inbox__table">
          <thead>
            <tr>
              <th>{{ t.action }}</th>
              <th>{{ t.from }}</th>
              <th>{{ t.to }}</th>
              <th>{{ t.actor }}</th>
              <th>{{ t.version }}</th>
              <th>{{ t.occurred }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in history" :key="record.id">
              <td>{{ record.action }}</td>
              <td>{{ record.from_status || '-' }}</td>
              <td>{{ record.to_status }}</td>
              <td>{{ formatHistoryActor(record) }}</td>
              <td>{{ formatHistoryVersion(record) }}</td>
              <td>{{ formatDate(record.occurred_at || record.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ApprovalHistoryEntry } from './plm/plmPanelModels'
import { useLocale } from '../composables/useLocale'
import { apiFetch } from '../utils/api'
import {
  buildApprovalInboxActionPayload,
  canActOnApprovalInboxEntry,
  canSubmitApprovalInboxAction,
  formatApprovalInboxVersion,
  resolveApprovalActionVersion,
} from './approvalInboxActionPayload'
import {
  readApprovalInboxErrorRecord,
  readApprovalInboxError,
  reconcileApprovalInboxConflictVersion,
  resolveApprovalInboxActionStatusAfterRefresh,
} from './approvalInboxFeedback'
import {
  resolvePlmApprovalHistoryActorLabel,
  resolvePlmApprovalHistoryVersionLabel,
} from './plm/plmApprovalHistoryDisplay'

interface ApprovalInstance {
  id: string
  status: string
  version?: string | number
  created_at?: string
  updated_at?: string
}

interface ApprovalRecord extends ApprovalHistoryEntry {
  id: string
  action: string
  actor_id: string
  from_status?: string | null
  to_status: string
  occurred_at?: string
  created_at?: string
}

const approvals = ref<ApprovalInstance[]>([])
const history = ref<ApprovalRecord[]>([])
const loading = ref(false)
const historyLoading = ref(false)
const error = ref('')
const historyError = ref('')
const actionStatus = ref('')
const selectedApprovalId = ref('')
const actingId = ref('')
const comment = ref('')
const { isZh } = useLocale()

const t = computed(() => (isZh.value
  ? {
      title: '审批中心',
      subtitle: '平台审批统一入口，数据来自 `/api/approvals/*`。',
      refresh: '刷新',
      refreshing: '刷新中...',
      pendingApprovals: '待处理审批',
      history: '审批历史',
      loadingApprovals: '正在加载审批...',
      noApprovals: '暂无待处理审批。',
      loadApprovalsFailed: '加载审批失败',
      actionComment: '审批备注',
      actionCommentPlaceholder: '批准可选，驳回必填',
      loadingHistory: '正在加载审批历史...',
      selectApproval: '请选择一条审批查看历史。',
      noHistory: '暂无审批记录。',
      loadHistoryFailed: '加载审批历史失败',
      rejectRequiresReason: '驳回必须填写原因',
      versionUnavailable: '当前审批版本不可用',
      sessionUnavailable: '审批中心会话不可用，请重新登录后重试。',
      approve: '通过',
      reject: '驳回',
      historyButton: '历史',
      id: 'ID',
      status: '状态',
      version: '版本',
      updated: '更新时间',
      actions: '操作',
      action: '动作',
      from: '从',
      to: '到',
      actor: '执行人',
      occurred: '发生时间',
    }
  : {
      title: 'Approval Inbox',
      subtitle: 'Platform approvals that already live behind `/api/approvals/*`.',
      refresh: 'Refresh',
      refreshing: 'Refreshing...',
      pendingApprovals: 'Pending Approvals',
      history: 'History',
      loadingApprovals: 'Loading approvals...',
      noApprovals: 'No pending approvals.',
      loadApprovalsFailed: 'Failed to load approvals',
      actionComment: 'Action Comment',
      actionCommentPlaceholder: 'Optional for approve, required for reject',
      loadingHistory: 'Loading history...',
      selectApproval: 'Select an approval to load history.',
      noHistory: 'No approval records.',
      loadHistoryFailed: 'Failed to load approval history',
      rejectRequiresReason: 'Reject requires a reason',
      versionUnavailable: 'Approval version is unavailable',
      sessionUnavailable: 'Approval center session is unavailable. Sign in again and retry.',
      approve: 'Approve',
      reject: 'Reject',
      historyButton: 'History',
      id: 'ID',
      status: 'Status',
      version: 'Version',
      updated: 'Updated',
      actions: 'Actions',
      action: 'Action',
      from: 'From',
      to: 'To',
      actor: 'Actor',
      occurred: 'Occurred',
    }
))

function formatDate(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatHistoryActor(record: ApprovalRecord) {
  return resolvePlmApprovalHistoryActorLabel(record)
}

function formatHistoryVersion(record: ApprovalRecord) {
  return resolvePlmApprovalHistoryVersionLabel(record)
}

function formatPendingVersion(approval: ApprovalInstance) {
  return formatApprovalInboxVersion(approval)
}

function canActOnApproval(approval: ApprovalInstance) {
  return canActOnApprovalInboxEntry(approval)
}

async function loadHistory(id: string) {
  selectedApprovalId.value = id
  historyLoading.value = true
  historyError.value = ''

  try {
    const response = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/history`, {
      suppressUnauthorizedRedirect: true,
    })
    if (!response.ok) throw new Error(await readApprovalInboxError(response))
    const payload = await response.json()
    history.value = Array.isArray(payload?.data?.items)
      ? payload.data.items
      : Array.isArray(payload?.data)
        ? payload.data
        : []
  } catch (err) {
    historyError.value = err instanceof Error ? err.message : t.value.loadHistoryFailed
    history.value = []
  } finally {
    historyLoading.value = false
  }
}

async function refreshInboxState(options?: { preserveActionStatus?: boolean }) {
  loading.value = true
  error.value = ''
  actionStatus.value = resolveApprovalInboxActionStatusAfterRefresh(
    actionStatus.value,
    options?.preserveActionStatus ?? false,
  )

  try {
    const response = await apiFetch('/api/approvals/pending?limit=50&offset=0', {
      suppressUnauthorizedRedirect: true,
    })
    if (!response.ok) throw new Error(await readApprovalInboxError(response))
    const payload = await response.json()
    approvals.value = Array.isArray(payload?.data) ? payload.data : []
    if (selectedApprovalId.value) {
      await loadHistory(selectedApprovalId.value)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : t.value.loadApprovalsFailed
    approvals.value = []
  } finally {
    loading.value = false
  }
}

function refreshInbox() {
  void refreshInboxState()
}

async function performAction(id: string, action: 'approve' | 'reject') {
  actionStatus.value = ''
  error.value = ''
  if (!canSubmitApprovalInboxAction(action, comment.value)) {
    error.value = t.value.rejectRequiresReason
    return
  }
  const approval = approvals.value.find((entry) => entry.id === id)
  const version = resolveApprovalActionVersion(approval)
  if (version === null) {
    error.value = t.value.versionUnavailable
    return
  }
  actingId.value = id

  try {
    const response = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      suppressUnauthorizedRedirect: true,
      body: JSON.stringify(buildApprovalInboxActionPayload(action, comment.value, version)),
    })
    if (!response.ok) {
      const failure = await readApprovalInboxErrorRecord(response)
      if (response.status === 401) {
        throw new Error(t.value.sessionUnavailable)
      }
      if (failure.code === 'APPROVAL_VERSION_CONFLICT') {
        approvals.value = reconcileApprovalInboxConflictVersion(approvals.value, id, failure.currentVersion)
        await refreshInboxState()
        if (!error.value) {
          error.value = failure.message
        }
        return
      }
      throw new Error(failure.message)
    }
    actionStatus.value = `${action === 'approve' ? t.value.approve : t.value.reject} ${id}`
    comment.value = ''
    await refreshInboxState({ preserveActionStatus: true })
  } catch (err) {
    error.value = err instanceof Error
      ? err.message
      : action === 'approve'
        ? t.value.sessionUnavailable
        : t.value.loadApprovalsFailed
  } finally {
    actingId.value = ''
  }
}

function selectApproval(id: string) {
  void loadHistory(id)
}

function approve(id: string) {
  void performAction(id, 'approve')
}

function reject(id: string) {
  void performAction(id, 'reject')
}

onMounted(() => {
  refreshInbox()
})
</script>

<style scoped>
.approval-inbox {
  padding: 24px;
  display: grid;
  gap: 20px;
}

.approval-inbox__header,
.approval-inbox__card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.approval-inbox__header h1,
.approval-inbox__card-header h2 {
  margin: 0;
  font-size: 20px;
}

.approval-inbox__header p {
  margin: 6px 0 0;
  color: #6b7280;
}

.approval-inbox__layout {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
}

.approval-inbox__card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 16px;
  padding: 20px;
  display: grid;
  gap: 16px;
}

.approval-inbox__count {
  min-width: 32px;
  padding: 4px 10px;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
}

.approval-inbox__comment {
  display: grid;
  gap: 8px;
  color: #475569;
}

.approval-inbox__comment input {
  min-height: 40px;
  border: 1px solid #d1d5db;
  border-radius: 10px;
  padding: 0 12px;
}

.approval-inbox__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.approval-inbox__table th,
.approval-inbox__table td {
  padding: 10px 12px;
  border-bottom: 1px solid #f1f5f9;
  text-align: left;
  vertical-align: top;
}

.approval-inbox__row--active {
  background: #f8fafc;
}

.approval-inbox__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.approval-inbox__empty,
.approval-inbox__error,
.approval-inbox__status {
  padding: 18px;
  border-radius: 12px;
  background: #f8fafc;
  color: #475569;
}

.approval-inbox__error {
  background: #fef2f2;
  color: #b91c1c;
}

.approval-inbox__status {
  background: #ecfdf5;
  color: #047857;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  text-decoration: none;
  cursor: pointer;
}

.btn--ghost {
  background: #fff;
}

.btn--mini {
  min-height: 28px;
  padding: 0 10px;
  font-size: 12px;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

@media (max-width: 1100px) {
  .approval-inbox__layout {
    grid-template-columns: 1fr;
  }
}
</style>
