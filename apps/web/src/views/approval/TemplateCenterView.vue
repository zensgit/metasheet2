<template>
  <section class="template-center">
    <header class="template-center__header">
      <h1>审批模板</h1>
      <div class="template-center__toolbar">
        <el-input
          v-model="searchText"
          placeholder="搜索模板名称"
          clearable
          style="width: 240px"
          @clear="handleSearch"
          @keyup.enter="handleSearch"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <el-tooltip
          v-if="canManageTemplates"
          content="即将上线"
          placement="top"
        >
          <el-button
            type="primary"
            style="margin-left: 12px"
            disabled
          >
            新建模板
          </el-button>
        </el-tooltip>
      </div>
    </header>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="true"
      class="template-center__error"
      @close="store.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="loadData">重新加载</el-button>
      </template>
    </el-alert>

    <el-tabs v-model="statusTab" class="template-center__tabs" @tab-change="handleTabChange">
      <el-tab-pane label="全部" name="all" />
      <el-tab-pane label="已发布" name="published" />
      <el-tab-pane label="草稿" name="draft" />
      <el-tab-pane label="已归档" name="archived" />
    </el-tabs>

    <el-table
      v-loading="store.loading"
      :data="store.templates"
      style="width: 100%"
      max-height="560"
      stripe
      highlight-current-row
      @row-click="handleRowClick"
    >
      <el-table-column prop="name" label="模板名称" min-width="200" />
      <el-table-column prop="description" label="描述" min-width="200">
        <template #default="{ row }">
          {{ row.description ?? '-' }}
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag
            :type="templateStatusTagType(row.status)"
            size="small"
            :effect="row.status === 'published' ? 'dark' : 'light'"
          >
            {{ templateStatusLabel(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最近更新" width="180">
        <template #default="{ row }">
          {{ formatDate(row.updatedAt) }}
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="180">
        <template #default="{ row }">
          {{ formatDate(row.createdAt) }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'published' && canWrite"
            type="primary"
            size="small"
            @click.stop="startApproval(row.id)"
          >
            发起审批
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          :description="searchText ? '未找到匹配的模板' : '暂无审批模板，点击新建模板开始'"
          :image-size="100"
        />
      </template>
    </el-table>

    <el-pagination
      v-if="store.total > pageSize"
      class="template-center__pagination"
      background
      layout="total, prev, pager, next"
      :total="store.total"
      :current-page="currentPage"
      :page-size="pageSize"
      @update:current-page="handlePageChange"
    />
  </section>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import type { ApprovalTemplateListItemDTO, ApprovalTemplateStatus } from '../../types/approval'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'

const router = useRouter()
const store = useApprovalTemplateStore()
const { canWrite, canManageTemplates } = useApprovalPermissions()

const statusTab = ref<'all' | ApprovalTemplateStatus>('all')
const searchText = ref('')
const currentPage = ref(1)
const pageSize = ref(10)

function templateStatusTagType(status: string) {
  const map: Record<string, string> = {
    published: 'success',
    draft: 'warning',
    archived: 'info',
  }
  return map[status] ?? ''
}

function templateStatusLabel(status: string) {
  const map: Record<string, string> = {
    published: '已发布',
    draft: '草稿',
    archived: '已归档',
  }
  return map[status] ?? status
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

function loadData() {
  store.loadTemplates({
    status: statusTab.value === 'all' ? undefined : statusTab.value,
    search: searchText.value || undefined,
    page: currentPage.value,
    pageSize: pageSize.value,
  })
}

function handleTabChange() {
  currentPage.value = 1
  loadData()
}

function handleSearch() {
  currentPage.value = 1
  loadData()
}

function handlePageChange(page: number) {
  currentPage.value = page
  loadData()
}

function handleRowClick(row: ApprovalTemplateListItemDTO) {
  router.push({ path: `/approval-templates/${row.id}` })
}

function startApproval(templateId: string) {
  router.push({ path: `/approvals/new/${templateId}` })
}

onMounted(() => {
  loadData()
})
</script>

<style scoped>
.template-center {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
}

.template-center__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.template-center__header h1 {
  font-size: 22px;
  font-weight: 600;
  margin: 0;
}

.template-center__toolbar {
  display: flex;
  align-items: center;
}

.template-center__error {
  margin-bottom: 16px;
}

.template-center__tabs {
  margin-bottom: 16px;
}

.template-center__pagination {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
}
</style>
