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
            <span>🔍</span>
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
      </div>
    </header>

    <el-tabs v-model="activeTab" class="approval-center__tabs" @tab-change="handleTabChange">
      <el-tab-pane label="待我处理" name="pending">
        <el-table
          :data="store.pendingApprovals"
          :loading="store.loading"
          style="width: 100%"
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
          :data="store.myApprovals"
          :loading="store.loading"
          style="width: 100%"
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
          :data="store.ccApprovals"
          :loading="store.loading"
          style="width: 100%"
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
          :data="store.completedApprovals"
          :loading="store.loading"
          style="width: 100%"
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
import type { UnifiedApprovalDTO, ApprovalStatus } from '../../types/approval'
import { useApprovalStore } from '../../approvals/store'

const router = useRouter()
const store = useApprovalStore()

const activeTab = ref<'pending' | 'mine' | 'cc' | 'completed'>('pending')
const searchText = ref('')
const statusFilter = ref<ApprovalStatus | ''>('')
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

.approval-center__tabs {
  margin-top: 8px;
}

.approval-center__pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
