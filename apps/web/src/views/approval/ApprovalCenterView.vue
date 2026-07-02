<template>
  <section class="approval-center">
    <header class="approval-center__header">
      <h1>审批中心</h1>
      <div class="approval-center__toolbar">
        <el-input
          v-model="searchText"
          placeholder="搜索审批编号或标题"
          clearable
          style="width: 240px"
          @clear="handleSearch"
          @keyup.enter="handleSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-select
          v-model="statusFilter"
          placeholder="状态筛选"
          clearable
          style="width: 140px; margin-left: 12px"
          @change="handleSearch"
        >
          <el-option label="待处理" value="pending" />
          <el-option label="已通过" value="approved" />
          <el-option label="已驳回" value="rejected" />
          <el-option label="已撤回" value="revoked" />
        </el-select>
        <el-select
          v-model="sourceSystemFilter"
          placeholder="来源系统"
          style="width: 140px; margin-left: 12px"
          data-testid="approval-source-filter"
          @change="handleSourceSystemChange"
        >
          <el-option label="全部来源" value="all" />
          <el-option label="平台审批" value="platform" />
          <el-option label="PLM 审批" value="plm" />
        </el-select>
        <el-button
          v-if="canWrite"
          type="primary"
          style="margin-left: 12px"
          @click="router.push({ name: 'approval-template-list' })"
        >
          发起审批
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="true"
      class="approval-center__error"
      @close="store.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="loadCurrentTab">重新加载</el-button>
      </template>
    </el-alert>

    <el-tabs v-model="activeTab" class="approval-center__tabs" @tab-change="handleTabChange">
      <el-tab-pane name="pending">
        <!-- Wave 2 WP3 slice 1/2: 红点 / 未读计数 — badge shows `unreadCount`
             (未读), not the total `count` (待办). Hidden when unread is zero so
             the badge never renders an empty bubble. A tooltip surfaces the
             "待办 X / 其中 Y 未读" pair so the total is still discoverable
             without muddling the primary semantic. Refreshed on mount and on
             tab switch (slice 1) plus after 全部标记已读 (slice 2). -->
        <template #label>
          <span class="approval-center__tab-label">
            <span>待我处理</span>
            <el-tooltip
              v-if="pendingBadgeCount > 0"
              :content="`待办 ${pendingTotalCount} / 其中 ${pendingBadgeCount} 未读`"
              placement="top"
            >
              <el-badge
                :value="pendingBadgeCount"
                :max="99"
                class="approval-center__tab-badge"
                data-testid="approval-pending-badge"
              />
            </el-tooltip>
          </span>
        </template>
        <!-- Wave 2 WP3 slice 2 — bulk 全部标记已读. Disabled until the server
             reports at least one unread row for the current filter so clicking
             never issues a no-op round-trip. -->
        <div class="approval-center__tab-toolbar">
          <!-- 操作台: batch approve/reject over the current selection. Each row still runs the
               authoritative single-instance server transition (frontend fan-out, not a bulk endpoint). -->
          <span
            v-if="selectedPending.length > 0"
            class="approval-center__selection-count"
            data-testid="approval-selection-count"
          >已选 {{ selectedPending.length }} 项</span>
          <el-button
            type="success"
            plain
            :disabled="selectedPending.length === 0 || batchRunning"
            :loading="batchRunning && batchAction === 'approve'"
            data-testid="approval-batch-approve"
            @click="handleBatchApprove"
          >
            批量通过
          </el-button>
          <el-button
            type="danger"
            plain
            :disabled="selectedPending.length === 0 || batchRunning"
            :loading="batchRunning && batchAction === 'reject'"
            data-testid="approval-batch-reject"
            @click="openBatchReject"
          >
            批量驳回
          </el-button>
          <el-button
            type="primary"
            plain
            :disabled="pendingBadgeCount <= 0"
            :loading="markingAllRead"
            data-testid="approval-mark-all-read"
            @click="handleMarkAllRead"
          >
            全部标记已读
          </el-button>
        </div>
        <div
          class="approval-center__attendance-entry"
          data-testid="attendance-approval-queue-entry"
        >
          <div class="approval-center__attendance-entry-copy">
            <strong>考勤审批</strong>
            <p>
              补卡、请假、加班审批当前在考勤模块处理，不计入平台/PLM 待办列表。
            </p>
          </div>
          <el-button type="primary" plain @click="openAttendanceApprovalQueue">
            待处理考勤审批
          </el-button>
        </div>
        <el-table
          ref="pendingTableRef"
          v-loading="store.loading"
          :data="store.pendingApprovals"
          style="width: 100%"
          max-height="560"
          stripe
          highlight-current-row
          :row-key="rowKey"
          @row-click="handleRowClick"
          @selection-change="handlePendingSelectionChange"
        >
          <el-table-column
            type="selection"
            width="44"
            :selectable="isRowBatchSelectable"
          />
          <el-table-column prop="requestNo" label="审批编号" width="180" />
          <el-table-column prop="title" label="标题" min-width="200" />
          <el-table-column label="发起人" width="120">
            <template #default="{ row }">
              {{ row.requester?.name ?? '-' }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small" :data-status="row.status">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="发起时间" width="180">
            <template #default="{ row }">
              {{ formatDate(row.createdAt) }}
            </template>
          </el-table-column>
          <template #empty>
            <el-empty
              :description="searchText ? '未找到匹配的审批' : '暂无待处理审批'"
              :image-size="100"
            />
          </template>
        </el-table>
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalPending"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>

      <el-tab-pane label="我发起的" name="mine">
        <el-table
          v-loading="store.loading"
          :data="store.myApprovals"
          style="width: 100%"
          max-height="560"
          stripe
          highlight-current-row
          @row-click="handleRowClick"
        >
          <el-table-column prop="requestNo" label="审批编号" width="180" />
          <el-table-column prop="title" label="标题" min-width="200" />
          <el-table-column label="发起人" width="120">
            <template #default="{ row }">
              {{ row.requester?.name ?? '-' }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small" :data-status="row.status">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="发起时间" width="180">
            <template #default="{ row }">
              {{ formatDate(row.createdAt) }}
            </template>
          </el-table-column>
          <!-- 催办: a requester nudge to the current approver, only meaningful while the instance is
               still pending. Server-side rate-limited (1/instance/user/hour); 429 surfaces gracefully. -->
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'pending'"
                type="primary"
                link
                :loading="remindingId === row.id"
                :disabled="remindingId !== null"
                :data-testid="`approval-urge-${row.id}`"
                @click.stop="handleUrge(row)"
              >
                催办
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty
              :description="searchText ? '未找到匹配的审批' : '暂无我发起的审批'"
              :image-size="100"
            />
          </template>
        </el-table>
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalMine"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>

      <el-tab-pane label="抄送我的" name="cc">
        <el-table
          v-loading="store.loading"
          :data="store.ccApprovals"
          style="width: 100%"
          max-height="560"
          stripe
          highlight-current-row
          @row-click="handleRowClick"
        >
          <el-table-column prop="requestNo" label="审批编号" width="180" />
          <el-table-column prop="title" label="标题" min-width="200" />
          <el-table-column label="发起人" width="120">
            <template #default="{ row }">
              {{ row.requester?.name ?? '-' }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small" :data-status="row.status">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="发起时间" width="180">
            <template #default="{ row }">
              {{ formatDate(row.createdAt) }}
            </template>
          </el-table-column>
          <template #empty>
            <el-empty
              :description="searchText ? '未找到匹配的审批' : '暂无抄送我的审批'"
              :image-size="100"
            />
          </template>
        </el-table>
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalCc"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>

      <el-tab-pane label="已完成" name="completed">
        <el-table
          v-loading="store.loading"
          :data="store.completedApprovals"
          style="width: 100%"
          max-height="560"
          stripe
          highlight-current-row
          @row-click="handleRowClick"
        >
          <el-table-column prop="requestNo" label="审批编号" width="180" />
          <el-table-column prop="title" label="标题" min-width="200" />
          <el-table-column label="发起人" width="120">
            <template #default="{ row }">
              {{ row.requester?.name ?? '-' }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" size="small" :data-status="row.status">
                {{ statusLabel(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="发起时间" width="180">
            <template #default="{ row }">
              {{ formatDate(row.createdAt) }}
            </template>
          </el-table-column>
          <template #empty>
            <el-empty
              :description="searchText ? '未找到匹配的审批' : '暂无已完成审批'"
              :image-size="100"
            />
          </template>
        </el-table>
        <el-pagination
          class="approval-center__pagination"
          background
          layout="total, prev, pager, next"
          :total="store.totalCompleted"
          :current-page="currentPage"
          :page-size="pageSize"
          @update:current-page="handlePageChange"
        />
      </el-tab-pane>
    </el-tabs>

    <!-- Batch reject: a comment is offered (some templates require one; a per-row failure is captured
         in the manifest rather than aborting the batch). -->
    <el-dialog
      v-model="batchRejectDialogVisible"
      title="批量驳回"
      width="440px"
      data-testid="approval-batch-reject-dialog"
    >
      <p class="approval-center__batch-reject-summary">
        将驳回所选的 {{ selectedPending.length }} 项审批。
      </p>
      <el-input
        v-model="batchRejectComment"
        type="textarea"
        :rows="3"
        placeholder="驳回意见（部分审批模板要求必填）"
        data-testid="approval-batch-reject-comment"
      />
      <template #footer>
        <el-button data-testid="approval-batch-reject-cancel" @click="batchRejectDialogVisible = false">取消</el-button>
        <el-button
          type="danger"
          :loading="batchRunning"
          data-testid="approval-batch-reject-confirm"
          @click="handleBatchReject"
        >
          确认驳回
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { UnifiedApprovalDTO, ApprovalStatus } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalPermissions } from '../../approvals/permissions'
import { dispatchAction, getPendingCount, markAllApprovalsRead, remindApproval } from '../../approvals/api'
import { runApprovalBatchAction } from '../../approvals/useApprovalBatchActions'
import { useApprovalCountsRealtime, type ApprovalCountsUpdatedPayload } from '../../approvals/useApprovalCountsRealtime'

const router = useRouter()
const store = useApprovalStore()
const { canWrite } = useApprovalPermissions()

// ── 操作台: batch approve/reject over the pending selection ────────────────
const pendingTableRef = ref<{ clearSelection: () => void } | null>(null)
const selectedPending = ref<UnifiedApprovalDTO[]>([])
const batchRunning = ref(false)
const batchAction = ref<'approve' | 'reject' | null>(null)
const batchRejectDialogVisible = ref(false)
const batchRejectComment = ref('')
const remindingId = ref<string | null>(null)

function rowKey(row: UnifiedApprovalDTO): string {
  return row.id
}

// Only platform-native pending rows are batch-actionable here; attendance-backed approvals live in the
// attendance module (their row-click routes away), so excluding them keeps the batch honest.
function isRowBatchSelectable(row: UnifiedApprovalDTO): boolean {
  return row.status === 'pending' && !isAttendanceApproval(row)
}

function handlePendingSelectionChange(rows: UnifiedApprovalDTO[]): void {
  selectedPending.value = rows.filter(isRowBatchSelectable)
}

function clearPendingSelection(): void {
  selectedPending.value = []
  // Guard the child API: the ref may be null (tab not rendered) or, under test stubs, a component
  // without ElTable's imperative methods — never let a missing clearSelection abort navigation.
  if (typeof pendingTableRef.value?.clearSelection === 'function') {
    pendingTableRef.value.clearSelection()
  }
}

async function runBatch(action: 'approve' | 'reject', comment: string): Promise<void> {
  const ids = selectedPending.value.map((row) => row.id)
  if (ids.length === 0 || batchRunning.value) return
  batchRunning.value = true
  batchAction.value = action
  try {
    const trimmed = comment.trim()
    const result = await runApprovalBatchAction(
      ids,
      () => (trimmed ? { action, comment: trimmed } : { action }),
      (id, req) => dispatchAction(id, req),
    )
    if (result.failed.length === 0) {
      ElMessage.success(`已${action === 'approve' ? '通过' : '驳回'} ${result.succeeded.length} 项`)
    } else if (result.succeeded.length === 0) {
      ElMessage.error(`全部 ${result.failed.length} 项处理失败：${result.failed[0]?.message ?? ''}`)
    } else {
      ElMessage.warning(`成功 ${result.succeeded.length} 项，失败 ${result.failed.length} 项（失败项仍在列表中）`)
    }
    clearPendingSelection()
    loadCurrentTab()
    void refreshPendingBadgeCount()
  } finally {
    batchRunning.value = false
    batchAction.value = null
  }
}

async function handleBatchApprove(): Promise<void> {
  await runBatch('approve', '')
}

function openBatchReject(): void {
  if (selectedPending.value.length === 0) return
  batchRejectComment.value = ''
  batchRejectDialogVisible.value = true
}

async function handleBatchReject(): Promise<void> {
  await runBatch('reject', batchRejectComment.value)
  batchRejectDialogVisible.value = false
}

async function handleUrge(row: UnifiedApprovalDTO): Promise<void> {
  if (remindingId.value) return
  remindingId.value = row.id
  try {
    const result = await remindApproval(row.id)
    if (result.ok) {
      ElMessage.success('已发送催办提醒')
    } else if (result.status === 429) {
      const retry = result.error.retryAfterSeconds
      ElMessage.warning(retry ? `催办过于频繁，请 ${Math.ceil(retry / 60)} 分钟后再试` : '催办过于频繁，请稍后再试')
    } else {
      ElMessage.error(result.error.message || '催办失败，请重试')
    }
  } catch {
    ElMessage.error('催办失败，请重试')
  } finally {
    remindingId.value = null
  }
}

// Wave 2 WP3 slice 1/2: server-owned pending badge. Slice 1 drove the count
// off active assignments; slice 2 flips the primary semantic to `unreadCount`
// (rows the user hasn't opened). The total `count` is preserved for the
// tooltip so "待办 X / 其中 Y 未读" stays discoverable.
const pendingBadgeCount = ref(0)
const pendingTotalCount = ref(0)
function applyPendingBadgeCount(count: number, unreadCount: number): void {
  pendingBadgeCount.value = Number.isFinite(unreadCount) ? unreadCount : 0
  pendingTotalCount.value = Number.isFinite(count) ? count : 0
}

async function refreshPendingBadgeCount(): Promise<void> {
  try {
    const result = await getPendingCount(sourceSystemFilter.value)
    applyPendingBadgeCount(result.count, result.unreadCount)
  } catch {
    // Badge is decorative — do not surface errors here; the tab itself
    // surfaces list-load failures via `store.error`.
    pendingBadgeCount.value = 0
    pendingTotalCount.value = 0
  }
}

function handleRealtimeCountsUpdated(payload: ApprovalCountsUpdatedPayload): void {
  const scopedCounts = payload.countsBySourceSystem?.[sourceSystemFilter.value] ?? payload
  applyPendingBadgeCount(scopedCounts.count, scopedCounts.unreadCount)
}

useApprovalCountsRealtime({
  onCountsUpdated: handleRealtimeCountsUpdated,
})

// Wave 2 WP3 slice 2 — bulk 全部标记已读. Honours the current sourceSystem tab
// so the button's effect matches the tooltip the user is looking at.
const markingAllRead = ref(false)
async function handleMarkAllRead(): Promise<void> {
  if (markingAllRead.value) return
  markingAllRead.value = true
  try {
    const result = await markAllApprovalsRead(sourceSystemFilter.value)
    ElMessage.success(result.markedCount > 0
      ? `已标记 ${result.markedCount} 条为已读`
      : '当前范围内无未读审批')
    await refreshPendingBadgeCount()
  } catch {
    ElMessage.error('标记已读失败，请重试')
  } finally {
    markingAllRead.value = false
  }
}

const activeTab = ref<'pending' | 'mine' | 'cc' | 'completed'>('pending')
const searchText = ref('')
const statusFilter = ref<ApprovalStatus | ''>('')
// Wave 2 WP2: source filter driving the `sourceSystem` query param on /api/approvals.
// Default 'all' surfaces the unified feed; switching narrows to platform or PLM-mirrored rows.
const sourceSystemFilter = ref<'all' | 'platform' | 'plm'>('all')
const currentPage = ref(1)
const pageSize = ref(10)
const attendanceRequestsSection = 'attendance-overview-requests'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function statusTagType(status: string) {
  const map: Record<string, string> = {
    pending: 'warning',
    approved: 'success',
    rejected: 'danger',
    revoked: 'info',
    cancelled: 'info',
  }
  return map[status] ?? ''
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    pending: '待处理',
    approved: '已通过',
    rejected: '已驳回',
    revoked: '已撤回',
    cancelled: '已取消',
  }
  return map[status] ?? status
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function loadCurrentTab() {
  const query = {
    search: searchText.value || undefined,
    status: (statusFilter.value || undefined) as ApprovalStatus | undefined,
    page: currentPage.value,
    pageSize: pageSize.value,
    sourceSystem: sourceSystemFilter.value,
  }
  switch (activeTab.value) {
    case 'pending': store.loadPending(query); break
    case 'mine': store.loadMine(query); break
    case 'cc': store.loadCc(query); break
    case 'completed': store.loadCompleted(query); break
  }
}

function handleTabChange() {
  currentPage.value = 1
  clearPendingSelection()
  loadCurrentTab()
  // Refresh badge whenever the user re-enters the 待办 tab so recent actions
  // reflect immediately.
  void refreshPendingBadgeCount()
}

function handleSearch() {
  currentPage.value = 1
  clearPendingSelection()
  loadCurrentTab()
}

function handleSourceSystemChange() {
  currentPage.value = 1
  clearPendingSelection()
  loadCurrentTab()
  void refreshPendingBadgeCount()
}

function handlePageChange(page: number) {
  currentPage.value = page
  clearPendingSelection()
  loadCurrentTab()
}

function isAttendanceApproval(row: UnifiedApprovalDTO): boolean {
  return row.workflowKey === 'attendance.request'
    || row.formSnapshot?.attendanceRequestId !== undefined
}

function attendanceRequestIdOf(row: UnifiedApprovalDTO): string | null {
  const rawRequestId = row.formSnapshot?.attendanceRequestId
  if (rawRequestId === undefined || rawRequestId === null) return null
  const requestId = String(rawRequestId).trim()
  return requestId ? requestId : null
}

function attendanceRequestQuery(row?: UnifiedApprovalDTO): Record<string, string> {
  const query: Record<string, string> = { section: attendanceRequestsSection }
  if (!row) return query
  const requestId = attendanceRequestIdOf(row)
  if (requestId) query.requestId = requestId
  return query
}

function handleRowClick(row: UnifiedApprovalDTO) {
  if (isAttendanceApproval(row)) {
    router.push({
      name: 'attendance',
      query: attendanceRequestQuery(row),
    })
    return
  }
  router.push({ name: 'approval-detail', params: { id: row.id } })
}

function openAttendanceApprovalQueue() {
  const firstPendingAttendanceRequest = store.pendingApprovals.find(row =>
    isAttendanceApproval(row) && attendanceRequestIdOf(row) !== null,
  )
  router.push({
    name: 'attendance',
    query: attendanceRequestQuery(firstPendingAttendanceRequest),
  })
}

onMounted(() => {
  loadCurrentTab()
  void refreshPendingBadgeCount()
})
</script>

<style scoped>
.approval-center {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

.approval-center__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.approval-center__header h1 {
  font-size: 22px;
  font-weight: 600;
  margin: 0;
}

.approval-center__toolbar {
  display: flex;
  align-items: center;
}

.approval-center__error {
  margin-bottom: 16px;
}

.approval-center__tabs {
  margin-top: 8px;
}

.approval-center__pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}

.approval-center__tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.approval-center__tab-badge {
  margin-left: 4px;
}

.approval-center__tab-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.approval-center__selection-count {
  margin-right: auto;
  color: #4b5563;
  font-size: 13px;
}

.approval-center__batch-reject-summary {
  margin: 0 0 12px;
  color: #4b5563;
  font-size: 14px;
}

.approval-center__attendance-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  margin-bottom: 12px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  background: #eff6ff;
}

.approval-center__attendance-entry-copy {
  display: grid;
  gap: 4px;
}

.approval-center__attendance-entry-copy strong {
  color: #1f2937;
  font-size: 14px;
}

.approval-center__attendance-entry-copy p {
  margin: 0;
  color: #4b5563;
  font-size: 13px;
  line-height: 1.5;
}

@media (max-width: 720px) {
  .approval-center__attendance-entry {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
