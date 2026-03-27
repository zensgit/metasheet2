<template>
  <section class="approval-inbox">
    <header class="approval-inbox__header">
      <div>
        <h1>Approval Inbox</h1>
        <p>Platform approvals that already live behind `/api/approvals/*`.</p>
      </div>
      <button class="btn btn--ghost" type="button" :disabled="loading" @click="refreshInbox">
        {{ loading ? 'Refreshing...' : 'Refresh' }}
      </button>
    </header>

    <div class="approval-inbox__layout">
      <article class="approval-inbox__card">
        <div class="approval-inbox__card-header">
          <h2>Pending Approvals</h2>
          <span class="approval-inbox__count">{{ approvals.length }}</span>
        </div>

        <p v-if="error" class="approval-inbox__error">{{ error }}</p>
        <div v-else-if="loading" class="approval-inbox__empty">Loading approvals...</div>
        <div v-else-if="!approvals.length" class="approval-inbox__empty">No pending approvals.</div>
        <table v-else class="approval-inbox__table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Version</th>
              <th>Updated</th>
              <th>Actions</th>
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
              <td>{{ approval.version }}</td>
              <td>{{ formatDate(approval.updated_at || approval.created_at) }}</td>
              <td>
                <div class="approval-inbox__actions">
                  <button class="btn btn--ghost btn--mini" type="button" @click="selectApproval(approval.id)">
                    History
                  </button>
                  <button
                    class="btn btn--ghost btn--mini"
                    type="button"
                    :disabled="actingId === approval.id"
                    @click="approve(approval.id)"
                  >
                    Approve
                  </button>
                  <button
                    class="btn btn--ghost btn--mini"
                    type="button"
                    :disabled="actingId === approval.id || !canSubmitApprovalInboxAction('reject', comment)"
                    @click="reject(approval.id)"
                  >
                    Reject
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="approval-inbox__card">
        <div class="approval-inbox__card-header">
          <h2>History</h2>
          <span v-if="selectedApprovalId" class="mono">{{ selectedApprovalId }}</span>
        </div>

        <label class="approval-inbox__comment">
          Action Comment
          <input v-model.trim="comment" type="text" placeholder="Optional for approve, required for reject" />
        </label>

        <p v-if="actionStatus" class="approval-inbox__status">{{ actionStatus }}</p>
        <p v-if="historyError" class="approval-inbox__error">{{ historyError }}</p>
        <div v-else-if="historyLoading" class="approval-inbox__empty">Loading history...</div>
        <div v-else-if="!selectedApprovalId" class="approval-inbox__empty">Select an approval to load history.</div>
        <div v-else-if="!history.length" class="approval-inbox__empty">No approval records.</div>
        <table v-else class="approval-inbox__table">
          <thead>
            <tr>
              <th>Action</th>
              <th>From</th>
              <th>To</th>
              <th>Actor</th>
              <th>Occurred</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in history" :key="record.id">
              <td>{{ record.action }}</td>
              <td>{{ record.from_status || '-' }}</td>
              <td>{{ record.to_status }}</td>
              <td>{{ record.actor_name || record.actor_id }}</td>
              <td>{{ formatDate(record.occurred_at || record.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'
import {
  buildApprovalInboxActionPayload,
  canSubmitApprovalInboxAction,
  resolveApprovalActionVersion,
} from './approvalInboxActionPayload'
import {
  readApprovalInboxErrorRecord,
  readApprovalInboxError,
  reconcileApprovalInboxConflictVersion,
  resolveApprovalInboxActionStatusAfterRefresh,
} from './approvalInboxFeedback'

interface ApprovalInstance {
  id: string
  status: string
  version: number
  created_at?: string
  updated_at?: string
}

interface ApprovalRecord {
  id: string
  action: string
  actor_id: string
  actor_name?: string | null
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

function formatDate(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function loadHistory(id: string) {
  selectedApprovalId.value = id
  historyLoading.value = true
  historyError.value = ''

  try {
    const response = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/history`)
    if (!response.ok) throw new Error(await readApprovalInboxError(response))
    const payload = await response.json()
    history.value = Array.isArray(payload?.data?.items)
      ? payload.data.items
      : Array.isArray(payload?.data)
        ? payload.data
        : []
  } catch (err) {
    historyError.value = err instanceof Error ? err.message : 'Failed to load approval history'
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
    const response = await apiFetch('/api/approvals/pending?limit=50&offset=0')
    if (!response.ok) throw new Error(await readApprovalInboxError(response))
    const payload = await response.json()
    approvals.value = Array.isArray(payload?.data) ? payload.data : []
    if (selectedApprovalId.value) {
      await loadHistory(selectedApprovalId.value)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load approvals'
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
    error.value = 'Reject requires a reason'
    return
  }
  const approval = approvals.value.find((entry) => entry.id === id)
  const version = resolveApprovalActionVersion(approval)
  if (version === null) {
    error.value = 'Approval version is unavailable'
    return
  }
  actingId.value = id

  try {
    const response = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify(buildApprovalInboxActionPayload(action, comment.value, version)),
    })
    if (!response.ok) {
      const failure = await readApprovalInboxErrorRecord(response)
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
    actionStatus.value = `${action === 'approve' ? 'Approved' : 'Rejected'} ${id}`
    await refreshInboxState({ preserveActionStatus: true })
  } catch (err) {
    error.value = err instanceof Error ? err.message : `Failed to ${action} approval`
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
