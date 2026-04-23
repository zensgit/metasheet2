<template>
  <section class="template-center">
    <header class="template-center__header">
      <h1>审批模板</h1>
      <div class="template-center__toolbar">
        <el-select
          v-model="categoryFilter"
          placeholder="全部分类"
          clearable
          data-testid="template-center-category-filter"
          style="width: 160px; margin-right: 12px"
          @change="handleCategoryChange"
        >
          <el-option
            v-for="category in categories"
            :key="category"
            :label="category"
            :value="category"
          />
        </el-select>
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
      <el-table-column prop="description" label="描述" min-width="180">
        <template #default="{ row }">
          {{ row.description ?? '-' }}
        </template>
      </el-table-column>
      <el-table-column label="分类" width="120">
        <template #default="{ row }">
          <el-tag
            v-if="row.category"
            size="small"
            type="info"
            effect="plain"
            data-testid="template-center-row-category"
          >
            {{ row.category }}
          </el-tag>
          <span v-else class="template-center__category-empty">未分组</span>
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
      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'published' && canWrite"
            type="primary"
            size="small"
            @click.stop="startApproval(row.id)"
          >
            发起审批
          </el-button>
          <el-button
            v-if="canManageTemplates"
            size="small"
            :loading="cloningId === row.id"
            data-testid="template-center-clone-button"
            @click.stop="handleClone(row)"
          >
            克隆
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
import { ElMessage } from 'element-plus'
import type { ApprovalTemplateListItemDTO, ApprovalTemplateStatus } from '../../types/approval'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'
import { cloneTemplate, listTemplateCategories } from '../../approvals/api'

const router = useRouter()
const store = useApprovalTemplateStore()
const { canWrite, canManageTemplates } = useApprovalPermissions()

const statusTab = ref<'all' | ApprovalTemplateStatus>('all')
const searchText = ref('')
// Wave 2 WP4 slice 1 — category filter state. `''` = no filter.
const categoryFilter = ref<string>('')
const categories = ref<string[]>([])
const cloningId = ref<string | null>(null)
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
    // Wave 2 WP4 slice 1 — only pass `category` when it's a non-empty
    // selection so the backend filter stays inert for "全部分类".
    category: categoryFilter.value || undefined,
    page: currentPage.value,
    pageSize: pageSize.value,
  })
}

async function loadCategories() {
  try {
    categories.value = await listTemplateCategories()
  } catch (e: any) {
    // Non-fatal: dropdown just stays empty. The rest of the page continues
    // to work without the filter.
    categories.value = []
  }
}

function handleTabChange() {
  currentPage.value = 1
  loadData()
}

function handleSearch() {
  currentPage.value = 1
  loadData()
}

function handleCategoryChange() {
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

async function handleClone(row: ApprovalTemplateListItemDTO) {
  if (!canManageTemplates.value) return
  if (cloningId.value) return
  cloningId.value = row.id
  try {
    const cloned = await cloneTemplate(row.id)
    ElMessage.success(`已克隆模板：${cloned.name}`)
    // Refresh categories in the background; navigation should not wait on it.
    void loadCategories()
    router.push({ path: `/approval-templates/${cloned.id}` })
  } catch (e: any) {
    ElMessage.error(e?.message ?? '克隆模板失败')
  } finally {
    cloningId.value = null
  }
}

onMounted(() => {
  loadData()
  loadCategories()
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

.template-center__category-empty {
  color: var(--el-text-color-secondary, #909399);
  font-size: 12px;
}
</style>
