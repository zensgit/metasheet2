<template>
  <PageShell width="default">
    <PageHeader class="template-center__header" title="审批模板">
      <template #actions>
        <div class="template-center__toolbar">
          <el-select
            v-model="categoryFilter"
            placeholder="全部分类"
            clearable
            data-testid="template-center-category-filter"
            class="ms-w-160 ms-mr-12"
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
            class="ms-w-240"
            @clear="handleSearch"
            @keyup.enter="handleSearch"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <el-button
            v-if="canManageTemplates"
            type="primary"
            class="ms-ml-12"
            data-testid="template-center-new-button"
            @click="createTemplate"
          >
            新建模板
          </el-button>
          <el-button
            v-if="canManageTemplates"
            class="ms-ml-8"
            data-testid="template-center-delegations-link"
            @click="$router.push('/approval-delegations')"
          >
            委托管理
          </el-button>
        </div>
      </template>
    </PageHeader>

    <!-- B1-08: 最近使用 — 发起热路径从「进模板全表找行」降到 1 击。localStorage per-user，
         点击已删除/已归档模板时由填单页的加载错误 + 返回兜底。 -->
    <div
      v-if="canWrite && recentTemplates.length > 0"
      class="template-center__recent"
      data-testid="template-center-recent"
    >
      <span class="template-center__recent-label">最近使用</span>
      <el-tag
        v-for="entry in recentTemplates"
        :key="entry.templateId"
        class="template-center__recent-chip"
        effect="plain"
        :data-testid="`template-center-recent-${entry.templateId}`"
        @click="startApproval(entry.templateId)"
      >
        {{ entry.name }}
      </el-tag>
    </div>

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

    <!-- G-B2-17: admin path unchanged — the management table stays exactly as before. -->
    <el-table
      v-if="canManageTemplates"
      v-loading="store.loading"
      :data="store.templates"
      class="ms-w-100pct"
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
      <el-table-column label="可见范围" width="160">
        <template #default="{ row }">
          <el-tag size="small" effect="plain" data-testid="template-center-row-visibility">
            {{ visibilityScopeLabel(row.visibilityScope) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <StatusTag domain="approvalTemplate" :status="row.status" size="sm" force-locale="zh" />
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
      <el-table-column label="操作" width="280" fixed="right">
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
          <el-button
            v-if="canManageTemplates && row.status === 'published'"
            size="small"
            :loading="archivingId === row.id"
            data-testid="template-center-archive-button"
            @click.stop="handleArchive(row)"
          >
            停用
          </el-button>
          <el-button
            v-if="canManageTemplates && row.status === 'archived'"
            size="small"
            :loading="archivingId === row.id"
            data-testid="template-center-unarchive-button"
            @click.stop="handleUnarchive(row)"
          >
            启用
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

    <!-- G-B2-17: requester (!canManageTemplates) card gallery. 普通员工's only real intent
         here is "find a template → start a request" — the admin table's columns (visibility
         scope, created/updated timestamps, clone) are management chrome they never act on, so
         the gallery surfaces just name / description / category / the one primary action. -->
    <div
      v-else
      v-loading="store.loading"
      class="template-center__gallery-wrap"
      data-testid="template-center-gallery"
    >
      <div v-if="visibleGalleryTemplates.length > 0" class="template-center__gallery">
        <el-card
          v-for="tpl in visibleGalleryTemplates"
          :key="tpl.id"
          class="template-center__gallery-card"
          shadow="hover"
          data-testid="template-center-gallery-card"
        >
          <div class="template-center__gallery-card-head">
            <span class="template-center__gallery-card-name">{{ tpl.name }}</span>
            <StatusTag domain="approvalTemplate" :status="tpl.status" size="sm" force-locale="zh" />
          </div>
          <p class="template-center__gallery-card-desc">
            {{ tpl.description || '暂无描述' }}
          </p>
          <div class="template-center__gallery-card-footer">
            <el-tag
              v-if="tpl.category"
              size="small"
              type="info"
              effect="plain"
              data-testid="template-center-gallery-category"
            >
              {{ tpl.category }}
            </el-tag>
            <span v-else class="template-center__category-empty">未分组</span>
            <el-button
              v-if="tpl.status === 'published' && canWrite"
              type="primary"
              size="small"
              data-testid="template-center-gallery-start-button"
              @click="startApproval(tpl.id)"
            >
              发起申请
            </el-button>
          </div>
        </el-card>
      </div>
      <EmptyState
        v-else
        data-testid="template-center-gallery-empty"
        :title="searchText || categoryFilter ? '未找到匹配的模板' : '暂无可用的审批模板'"
      />
    </div>

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
  </PageShell>
</template>

<script setup lang="ts">
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import StatusTag from '../../components/status/StatusTag.vue'
import EmptyState from '../../components/status/EmptyState.vue'
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { ApprovalTemplateListItemDTO, ApprovalTemplateStatus } from '../../types/approval'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'
import {
  cloneTemplate,
  listTemplateCategories,
  getTemplateUsage,
  archiveTemplate,
  unarchiveTemplate,
} from '../../approvals/api'
import { listRecentTemplates, type RecentTemplateEntry } from '../../approvals/recentTemplates'
import { useAuth } from '../../composables/useAuth'
import { filterGalleryTemplates } from '../../approvals/templateGalleryFilter'
import { templateArchiveConfirmMessage, templateUnarchiveConfirmMessage } from '../../approvals/templateArchiveConfirm'

const router = useRouter()
const store = useApprovalTemplateStore()
const { canWrite, canManageTemplates } = useApprovalPermissions()
const recentTemplates = ref<RecentTemplateEntry[]>([])

const statusTab = ref<'all' | ApprovalTemplateStatus>('all')
const searchText = ref('')
// Wave 2 WP4 slice 1 — category filter state. `''` = no filter.
const categoryFilter = ref<string>('')
const categories = ref<string[]>([])
const cloningId = ref<string | null>(null)
// B3-08 — 停用/启用 in-flight row id.
const archivingId = ref<string | null>(null)
const currentPage = ref(1)
const pageSize = ref(10)

// G-B2-17 — the requester gallery re-filters the current page's templates instantly as
// categoryFilter/searchText change (no need to wait for handleSearch's Enter/blur), on top of
// whatever the backend already returned. The admin table below does NOT consume this: it keeps
// rendering `store.templates` directly, unchanged.
const visibleGalleryTemplates = computed(() =>
  filterGalleryTemplates(store.templates, {
    category: categoryFilter.value,
    search: searchText.value,
  }),
)

function visibilityScopeLabel(scope: ApprovalTemplateListItemDTO['visibilityScope']) {
  if (!scope || scope.type === 'all') return '全员可见'
  const count = scope.ids?.length ?? 0
  const map: Record<string, string> = {
    dept: '部门',
    role: '角色',
    user: '用户',
  }
  return `${map[scope.type] ?? scope.type} ${count}`
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

function createTemplate() {
  if (!canManageTemplates.value) return
  router.push({ path: '/approval-templates/new' })
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

// B3-08 (模板治理 — 停用): fetch the usage/blast-radius indicator first (best-effort — a failed
// usage read still shows the confirm, just without the instance-count line), same flow as
// TemplateDetailView's handleArchive. Refreshes the row in place from the response rather than
// reloading the whole page.
async function handleArchive(row: ApprovalTemplateListItemDTO) {
  if (!canManageTemplates.value || archivingId.value) return
  let usage
  try {
    usage = await getTemplateUsage(row.id)
  } catch {
    usage = undefined
  }
  try {
    await ElMessageBox.confirm(
      templateArchiveConfirmMessage(row.name, usage),
      '停用模板',
      { confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  archivingId.value = row.id
  try {
    const updated = await archiveTemplate(row.id)
    row.status = updated.status
    ElMessage.success('已停用模板')
  } catch (e: any) {
    ElMessage.error(e?.message ?? '停用模板失败')
  } finally {
    archivingId.value = null
  }
}

async function handleUnarchive(row: ApprovalTemplateListItemDTO) {
  if (!canManageTemplates.value || archivingId.value) return
  try {
    await ElMessageBox.confirm(
      templateUnarchiveConfirmMessage(row.name),
      '启用模板',
      { confirmButtonText: '启用', cancelButtonText: '取消', type: 'info' },
    )
  } catch {
    return
  }
  archivingId.value = row.id
  try {
    const updated = await unarchiveTemplate(row.id)
    row.status = updated.status
    ElMessage.success('已启用模板')
  } catch (e: any) {
    ElMessage.error(e?.message ?? '启用模板失败')
  } finally {
    archivingId.value = null
  }
}

onMounted(() => {
  loadData()
  loadCategories()
  // B1-08: best-effort — a missing session just means no shortcut row.
  void useAuth()
    .getCurrentUserId()
    .then((uid) => {
      recentTemplates.value = listRecentTemplates(uid)
    })
    .catch(() => {})
})
</script>

<style scoped>
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
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-center__recent {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.template-center__recent-label {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.template-center__recent-chip {
  cursor: pointer;
}

/* G-B2-17: requester card gallery. */
.template-center__gallery-wrap {
  min-height: 160px;
}

.template-center__gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--ms-space-4);
}

.template-center__gallery-card :deep(.el-card__body) {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.template-center__gallery-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ms-space-2);
}

.template-center__gallery-card-name {
  font-size: var(--ms-font-size-section-title);
  font-weight: var(--ms-font-weight-title);
  color: var(--ms-text-1);
  line-height: 1.4;
}

.template-center__gallery-card-desc {
  margin: 0;
  min-height: 40px;
  font-size: 13px;
  color: var(--ms-text-2);
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.template-center__gallery-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ms-space-2);
}
</style>
