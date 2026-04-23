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
        <el-table
          v-loading="store.loading"
          :data="store.pendingApprovals"
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
import { getPendingCount, markAllApprovalsRead } from '../../approvals/api'

const router = useRouter()
const store = useApprovalStore()
const { canWrite } = useApprovalPermissions()

// Wave 2 WP3 slice 1/2: server-owned pending badge. Slice 1 drove the count
// off active assignments; slice 2 flips the primary semantic to `unreadCount`
// (rows the user hasn't opened). The total `count` is preserved for the
// tooltip so "待办 X / 其中 Y 未读" stays discoverable.
const pendingBadgeCount = ref(0)
const pendingTotalCount = ref(0)
async function refreshPendingBadgeCount(): Promise<void> {
  try {
    const result = await getPendingCount(sourceSystemFilter.value)
    pendingBadgeCount.value = Number.isFinite(result.unreadCount) ? result.unreadCount : 0
    pendingTotalCount.value = Number.isFinite(result.count) ? result.count : 0
  } catch {
    // Badge is decorative — do not surface errors here; the tab itself
    // surfaces list-load failures via `store.error`.
    pendingBadgeCount.value = 0
    pendingTotalCount.value = 0
  }
}

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
  loadCurrentTab()
  // Refresh badge whenever the user re-enters the 待办 tab so recent actions
  // reflect immediately.
  void refreshPendingBadgeCount()
}

function handleSearch() {
  currentPage.value = 1
  loadCurrentTab()
}

function handleSourceSystemChange() {
  currentPage.value = 1
  loadCurrentTab()
  void refreshPendingBadgeCount()
}

function handlePageChange(page: number) {
  currentPage.value = page
  loadCurrentTab()
}

function handleRowClick(row: UnifiedApprovalDTO) {
  router.push({ name: 'approval-detail', params: { id: row.id } })
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
  margin-bottom: 12px;
}
</style>
