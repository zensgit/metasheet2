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
          @change="handleSearch"
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
        <!-- Wave 2 WP3 slice 1: 红点 / 待办计数 — render the server-provided
             pending count alongside the tab label. Hidden when the count is
             zero so the badge never shows an empty bubble. The count is the
             total across the user's assignments (not the current page), so
             use a dedicated state slot instead of the store's per-page
             `pendingCount` computed. -->
        <template #label>
          <span class="approval-center__tab-label">
            <span>待我处理</span>
            <el-badge
              v-if="pendingBadgeCount > 0"
              :value="pendingBadgeCount"
              :max="99"
              class="approval-center__tab-badge"
              data-testid="approval-pending-badge"
            />
          </span>
        </template>
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
import type { UnifiedApprovalDTO, ApprovalStatus } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'
import { useApprovalPermissions } from '../../approvals/permissions'
import { getPendingCount } from '../../approvals/api'

const router = useRouter()
const store = useApprovalStore()
const { canWrite } = useApprovalPermissions()

// Wave 2 WP3 slice 1: server-owned pending count. Refreshed on mount and tab
// switch so the badge matches the 待办 tab after any action reduces the user's
// assignment queue.
const pendingBadgeCount = ref(0)
async function refreshPendingBadgeCount(): Promise<void> {
  try {
    const result = await getPendingCount(sourceSystemFilter.value)
    pendingBadgeCount.value = Number.isFinite(result.count) ? result.count : 0
  } catch {
    // Badge is decorative — do not surface errors here; the tab itself
    // surfaces list-load failures via `store.error`.
    pendingBadgeCount.value = 0
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
</style>
