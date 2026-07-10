<template>
  <PageShell width="default">
    <PageHeader
      class="template-detail__header"
      :title="headerTitle"
      back
      back-label="返回模板列表"
      @back="goBack"
    >
      <template v-if="template" #meta>
        <StatusTag domain="approvalTemplate" :status="template.status" force-locale="zh" />
      </template>
      <template v-if="template" #actions>
        <el-button
          v-if="template.status === 'published' && canWrite"
          type="primary"
          :loading="store.loading"
          @click="startApproval"
        >
          发起审批
        </el-button>
        <el-button
          v-if="canManageTemplates"
          data-testid="template-detail-edit-button"
          @click="editTemplate"
        >
          编辑模板
        </el-button>
        <el-button
          v-if="canManageTemplates && template.status === 'published'"
          :loading="archiving"
          data-testid="template-detail-archive-button"
          @click="handleArchive"
        >
          停用
        </el-button>
        <el-button
          v-if="canManageTemplates && template.status === 'archived'"
          :loading="archiving"
          data-testid="template-detail-unarchive-button"
          @click="handleUnarchive"
        >
          启用
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="store.error"
      :title="store.error"
      type="error"
      show-icon
      :closable="true"
      class="template-detail__error"
      @close="store.error = null"
    >
      <template #default>
        <el-button type="primary" link @click="retryLoad">重新加载</el-button>
      </template>
    </el-alert>

    <div v-loading="store.loading" class="template-detail__content-wrapper">
      <div v-if="template" class="template-detail__body">
        <!-- Template info -->
        <div class="template-detail__info">
          <p v-if="template.description">{{ template.description }}</p>
          <!--
            Wave 2 WP4 slice 1 — 模板分类. Read-only for non-admins; inline
            editable for `approval-templates:manage`. We intentionally keep
            this as a single field instead of building a full edit mode —
            that broader editor is deferred to a later WP4 slice.
          -->
          <div class="template-detail__category">
            <span class="template-detail__category-label">模板分类:</span>
            <template v-if="!editingCategory">
              <el-tag
                v-if="template.category"
                size="small"
                type="info"
                effect="plain"
                data-testid="template-detail-category-tag"
              >
                {{ template.category }}
              </el-tag>
              <span v-else class="template-detail__category-empty" data-testid="template-detail-category-empty">
                未分组
              </span>
              <el-button
                v-if="canManageTemplates"
                text
                size="small"
                data-testid="template-detail-category-edit-button"
                class="ms-ml-8"
                @click="beginEditCategory"
              >
                编辑
              </el-button>
            </template>
            <template v-else>
              <el-input
                v-model="categoryDraft"
                size="small"
                placeholder="分组标识，用于模板中心筛选，留空表示未分组"
                class="ms-w-240 ms-mr-8"
                maxlength="64"
                data-testid="template-detail-category-input"
                @keyup.enter="saveCategory"
                @keyup.escape="cancelEditCategory"
              />
              <el-button
                type="primary"
                size="small"
                :loading="categorySaving"
                data-testid="template-detail-category-save-button"
                @click="saveCategory"
              >
                保存
              </el-button>
              <el-button
                size="small"
                :disabled="categorySaving"
                data-testid="template-detail-category-cancel-button"
                @click="cancelEditCategory"
              >
                取消
              </el-button>
            </template>
          </div>
          <div class="template-detail__visibility">
            <span class="template-detail__category-label">可见范围:</span>
            <template v-if="!editingVisibility">
              <el-tag size="small" effect="plain" data-testid="template-detail-visibility-tag">
                {{ visibilityScopeLabel(template.visibilityScope) }}
              </el-tag>
              <span
                v-if="template.visibilityScope.type !== 'all'"
                class="template-detail__visibility-ids"
                data-testid="template-detail-visibility-ids"
              >
                {{ template.visibilityScope.ids.join(', ') }}
              </span>
              <el-button
                v-if="canManageTemplates"
                text
                size="small"
                data-testid="template-detail-visibility-edit-button"
                class="ms-ml-8"
                @click="beginEditVisibility"
              >
                编辑
              </el-button>
            </template>
            <template v-else>
              <el-select
                v-model="visibilityTypeDraft"
                size="small"
                class="ms-w-120 ms-mr-8"
                data-testid="template-detail-visibility-type"
              >
                <el-option label="全员" value="all" />
                <el-option label="部门" value="dept" />
                <el-option label="角色" value="role" />
                <el-option label="用户" value="user" />
              </el-select>
              <el-input
                v-model="visibilityIdsDraft"
                size="small"
                placeholder="逗号分隔 id，如 dept-finance, role-manager"
                class="ms-w-320 ms-mr-8"
                :disabled="visibilityTypeDraft === 'all'"
                data-testid="template-detail-visibility-ids-input"
                @keyup.enter="saveVisibility"
                @keyup.escape="cancelEditVisibility"
              />
              <el-button
                type="primary"
                size="small"
                :loading="visibilitySaving"
                data-testid="template-detail-visibility-save-button"
                @click="saveVisibility"
              >
                保存
              </el-button>
              <el-button
                size="small"
                :disabled="visibilitySaving"
                data-testid="template-detail-visibility-cancel-button"
                @click="cancelEditVisibility"
              >
                取消
              </el-button>
            </template>
          </div>
          <!--
            Wave 2 WP5 slice 1 — 模板 SLA. Positive integer hours or null
            (留空). Visible to all; inline editable by admins.
          -->
          <div class="template-detail__sla">
            <span class="template-detail__category-label">SLA (小时):</span>
            <template v-if="!editingSla">
              <el-tag
                v-if="template.slaHours !== null && template.slaHours !== undefined"
                size="small"
                type="warning"
                effect="plain"
                data-testid="template-detail-sla-tag"
              >
                {{ template.slaHours }}
              </el-tag>
              <span v-else class="template-detail__category-empty" data-testid="template-detail-sla-empty">
                未设置
              </span>
              <el-button
                v-if="canManageTemplates"
                text
                size="small"
                data-testid="template-detail-sla-edit-button"
                class="ms-ml-8"
                @click="beginEditSla"
              >
                编辑
              </el-button>
            </template>
            <template v-else>
              <el-input-number
                v-model="slaDraft"
                :min="1"
                :max="8760"
                size="small"
                class="ms-w-160 ms-mr-8"
                data-testid="template-detail-sla-input"
                placeholder="留空清除"
                :controls="false"
              />
              <el-button
                type="primary"
                size="small"
                :loading="slaSaving"
                data-testid="template-detail-sla-save-button"
                @click="saveSla"
              >
                保存
              </el-button>
              <el-button
                size="small"
                :disabled="slaSaving"
                data-testid="template-detail-sla-cancel-button"
                @click="cancelEditSla"
              >
                取消
              </el-button>
            </template>
          </div>
          <div class="template-detail__meta">
            <span>模板 Key: {{ template.key }}</span>
            <span>当前版本: {{ template.activeVersionId ?? '无' }}</span>
            <span>创建时间: {{ formatDate(template.createdAt) }}</span>
            <span>更新时间: {{ formatDate(template.updatedAt) }}</span>
          </div>
        </div>

        <div class="template-detail__content">
          <!-- Form schema section -->
          <div class="template-detail__section">
            <h2>表单字段</h2>
            <el-table :data="template.formSchema.fields" class="ms-w-100pct" max-height="400" stripe>
              <el-table-column prop="label" label="字段名" min-width="160" />
              <el-table-column label="类型" width="120">
                <template #default="{ row }">
                  <el-tag size="small">{{ fieldTypeLabel(row.type) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="必填" width="80">
                <template #default="{ row }">
                  <el-tag v-if="row.required" type="danger" size="small">必填</el-tag>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <el-table-column prop="placeholder" label="占位文本" min-width="160">
                <template #default="{ row }">
                  {{ row.placeholder ?? '-' }}
                </template>
              </el-table-column>
              <el-table-column label="选项" min-width="200">
                <template #default="{ row }">
                  <span v-if="row.options && row.options.length">
                    {{ row.options.map((o: any) => o.label).join(', ') }}
                  </span>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty description="暂无表单字段" :image-size="60" />
              </template>
            </el-table>
          </div>

          <div class="template-detail__section">
            <h2>字段显隐规则</h2>
            <el-empty
              v-if="visibilityRuleSummaries.length === 0"
              description="暂无字段显隐规则"
              :image-size="60"
            />
            <el-table v-else :data="visibilityRuleSummaries" class="ms-w-100pct" stripe>
              <el-table-column label="字段" min-width="160">
                <template #default="{ row }">
                  {{ row.field.label }}
                </template>
              </el-table-column>
              <el-table-column label="规则说明" min-width="260">
                <template #default="{ row }">
                  {{ row.summary }}
                </template>
              </el-table-column>
            </el-table>
          </div>

          <!-- Approval graph section -->
          <div class="template-detail__section">
            <h2>审批流程</h2>
            <el-timeline v-if="template.approvalGraph.nodes.length">
              <el-timeline-item
                v-for="node in template.approvalGraph.nodes"
                :key="node.key"
                :type="nodeTimelineType(node.type)"
                :icon="nodeTimelineIcon(node.type)"
                size="large"
              >
                <div class="template-detail__node-content">
                  <strong>{{ node.name ?? node.key }}</strong>
                  <el-tag size="small" :type="nodeTagType(node.type)">
                    {{ nodeTypeLabel(node.type) }}
                  </el-tag>
                  <span
                    v-if="'assigneeType' in node.config && node.config.assigneeType"
                    class="template-detail__node-assignee"
                  >
                    {{ (node.config as any).assigneeType === 'role' ? '角色' : '用户' }}:
                    {{ (node.config as any).assigneeIds?.join(', ') ?? '-' }}
                  </span>
                  <el-tag
                    v-if="node.type === 'approval' && (node.config as any).approvalMode"
                    size="small"
                    class="template-detail__node-mode"
                  >
                    {{ approvalModeLabel((node.config as any).approvalMode) }}
                  </el-tag>
                  <el-tag
                    v-if="node.type === 'approval' && (node.config as any).emptyAssigneePolicy"
                    size="small"
                    :type="(node.config as any).emptyAssigneePolicy === 'auto-approve' ? 'success' : 'danger'"
                    class="template-detail__node-policy"
                  >
                    {{ emptyAssigneePolicyLabel((node.config as any).emptyAssigneePolicy) }}
                  </el-tag>
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="暂无审批节点" :image-size="60" />
          </div>
        </div>
      </div>

      <el-empty v-else-if="!store.loading" description="未找到模板" />
    </div>
  </PageShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PageShell from '../../components/layout/PageShell.vue'
import PageHeader from '../../components/layout/PageHeader.vue'
import StatusTag from '../../components/status/StatusTag.vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Flag,
  UserFilled,
  Message,
  QuestionFilled,
  CircleCheckFilled,
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  ApprovalNodeType,
  FormFieldType,
  ApprovalMode,
  EmptyAssigneePolicy,
  ApprovalTemplateVisibilityScope,
  ApprovalTemplateVisibilityType,
} from '../../types/approval'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'
import {
  updateTemplateCategory,
  updateTemplateSlaHours,
  updateTemplateVisibilityScope,
  getTemplateUsage,
  archiveTemplate,
  unarchiveTemplate,
} from '../../approvals/api'
import { describeFieldVisibilityRule } from '../../approvals/fieldVisibility'
import { templateArchiveConfirmMessage, templateUnarchiveConfirmMessage } from '../../approvals/templateArchiveConfirm'

const route = useRoute()
const router = useRouter()
const store = useApprovalTemplateStore()
const { canWrite, canManageTemplates } = useApprovalPermissions()

const template = computed(() => store.activeTemplate)
// PageHeader requires a non-optional title; before the template loads (or on error) fall back to
// generic copy — the original hand-rolled `<h1 v-if="template">` rendered nothing at all here.
const headerTitle = computed(() => template.value?.name ?? '审批模板')
const visibilityRuleSummaries = computed(() => {
  const currentTemplate = template.value
  if (!currentTemplate) return []
  return currentTemplate.formSchema.fields
    .map((field) => ({
      field,
      summary: describeFieldVisibilityRule(field, currentTemplate.formSchema),
    }))
    .filter((entry) => entry.summary !== null)
})

// Wave 2 WP4 slice 1 — inline category editor state.
const editingCategory = ref(false)
const categoryDraft = ref('')
const categorySaving = ref(false)
const editingVisibility = ref(false)
const visibilityTypeDraft = ref<ApprovalTemplateVisibilityType>('all')
const visibilityIdsDraft = ref('')
const visibilitySaving = ref(false)
// Wave 2 WP5 slice 1 — inline SLA editor state.
const editingSla = ref(false)
const slaDraft = ref<number | null>(null)
const slaSaving = ref(false)
// B3-08 — 停用/启用 state.
const archiving = ref(false)

function beginEditSla() {
  if (!template.value) return
  slaDraft.value = template.value.slaHours ?? null
  editingSla.value = true
}

function cancelEditSla() {
  editingSla.value = false
  slaDraft.value = null
}

async function saveSla() {
  if (!template.value || slaSaving.value) return
  const raw = slaDraft.value
  const nextSla = raw === null || raw === undefined || Number.isNaN(Number(raw)) ? null : Number(raw)
  if (nextSla !== null && (!Number.isInteger(nextSla) || nextSla <= 0)) {
    ElMessage.error('SLA 必须是正整数小时')
    return
  }
  const current = template.value.slaHours ?? null
  if (nextSla === current) {
    editingSla.value = false
    return
  }
  slaSaving.value = true
  try {
    const updated = await updateTemplateSlaHours(template.value.id, nextSla)
    store.activeTemplate = updated
    editingSla.value = false
    ElMessage.success(nextSla === null ? '已清除 SLA' : `已更新 SLA 为 ${nextSla} 小时`)
  } catch (e: any) {
    ElMessage.error(e?.message ?? '更新 SLA 失败')
  } finally {
    slaSaving.value = false
  }
}

function beginEditCategory() {
  if (!template.value) return
  categoryDraft.value = template.value.category ?? ''
  editingCategory.value = true
}

function cancelEditCategory() {
  editingCategory.value = false
  categoryDraft.value = ''
}

async function saveCategory() {
  if (!template.value || categorySaving.value) return
  const trimmed = categoryDraft.value.trim()
  const nextCategory = trimmed.length > 0 ? trimmed : null
  const currentCategory = template.value.category ?? null
  if (nextCategory === currentCategory) {
    editingCategory.value = false
    return
  }
  categorySaving.value = true
  try {
    const updated = await updateTemplateCategory(template.value.id, nextCategory)
    // Patch the cached store so the header refreshes without a round-trip.
    store.activeTemplate = updated
    editingCategory.value = false
    ElMessage.success(nextCategory ? `已更新分类为 ${nextCategory}` : '已清除模板分类')
  } catch (e: any) {
    ElMessage.error(e?.message ?? '更新分类失败')
  } finally {
    categorySaving.value = false
  }
}

function visibilityScopeLabel(scope: ApprovalTemplateVisibilityScope): string {
  if (!scope || scope.type === 'all') return '全员可见'
  const map: Record<ApprovalTemplateVisibilityType, string> = {
    all: '全员可见',
    dept: '按部门',
    role: '按角色',
    user: '按用户',
  }
  return map[scope.type]
}

function beginEditVisibility() {
  if (!template.value) return
  visibilityTypeDraft.value = template.value.visibilityScope.type
  visibilityIdsDraft.value = template.value.visibilityScope.ids.join(', ')
  editingVisibility.value = true
}

function cancelEditVisibility() {
  editingVisibility.value = false
  visibilityTypeDraft.value = 'all'
  visibilityIdsDraft.value = ''
}

async function saveVisibility() {
  if (!template.value || visibilitySaving.value) return
  const ids = visibilityIdsDraft.value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (visibilityTypeDraft.value !== 'all' && ids.length === 0) {
    ElMessage.error('可见范围至少需要一个 id')
    return
  }
  const nextScope: ApprovalTemplateVisibilityScope = visibilityTypeDraft.value === 'all'
    ? { type: 'all', ids: [] }
    : { type: visibilityTypeDraft.value, ids: Array.from(new Set(ids)) }
  const current = template.value.visibilityScope
  if (current.type === nextScope.type && current.ids.join('\n') === nextScope.ids.join('\n')) {
    editingVisibility.value = false
    return
  }
  visibilitySaving.value = true
  try {
    const updated = await updateTemplateVisibilityScope(template.value.id, nextScope)
    store.activeTemplate = updated
    editingVisibility.value = false
    ElMessage.success('已更新模板可见范围')
  } catch (e: any) {
    ElMessage.error(e?.message ?? '更新可见范围失败')
  } finally {
    visibilitySaving.value = false
  }
}

function fieldTypeLabel(type: FormFieldType) {
  const map: Record<FormFieldType, string> = {
    text: '文本',
    textarea: '多行文本',
    number: '数字',
    date: '日期',
    datetime: '日期时间',
    select: '单选',
    'multi-select': '多选',
    user: '用户',
    attachment: '附件',
    detail: '明细',
  }
  return map[type] ?? type
}

function nodeTypeLabel(type: ApprovalNodeType) {
  const map: Record<ApprovalNodeType, string> = {
    start: '开始',
    approval: '审批',
    cc: '抄送',
    condition: '条件',
    parallel: '并行',
    end: '结束',
  }
  return map[type] ?? type
}

function nodeTimelineType(type: ApprovalNodeType): string {
  const map: Record<ApprovalNodeType, string> = {
    start: 'primary',
    approval: 'warning',
    cc: 'success',
    condition: 'danger',
    parallel: 'warning',
    end: 'info',
  }
  return map[type] ?? 'info'
}

function nodeTimelineIcon(type: ApprovalNodeType) {
  const map: Record<ApprovalNodeType, any> = {
    start: Flag,
    approval: UserFilled,
    cc: Message,
    condition: QuestionFilled,
    parallel: QuestionFilled,
    end: CircleCheckFilled,
  }
  return map[type] ?? undefined
}

function nodeTagType(type: ApprovalNodeType): string {
  const map: Record<ApprovalNodeType, string> = {
    start: '',
    approval: 'warning',
    cc: 'success',
    condition: 'danger',
    parallel: 'warning',
    end: 'info',
  }
  return map[type] ?? ''
}

function approvalModeLabel(mode: ApprovalMode): string {
  const map: Record<ApprovalMode, string> = { single: '单人审批', all: '会签', any: '或签' }
  return map[mode] ?? mode
}

function emptyAssigneePolicyLabel(policy: EmptyAssigneePolicy): string {
  const map: Record<EmptyAssigneePolicy, string> = { error: '无人时报错', 'auto-approve': '无人时自动通过' }
  return map[policy] ?? policy
}

function formatDate(dateStr: string) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('zh-CN')
}

function goBack() {
  router.push({ path: '/approval-templates' })
}

function retryLoad() {
  const id = route.params.id as string
  store.error = null
  store.loadTemplate(id)
}

function startApproval() {
  if (template.value) {
    router.push({ path: `/approvals/new/${template.value.id}` })
  }
}

function editTemplate() {
  if (!template.value || !canManageTemplates.value) return
  router.push({ path: `/approval-templates/${template.value.id}/edit` })
}

// B3-08 (模板治理 — 停用): fetches the usage/blast-radius indicator FIRST (best-effort — a failed
// usage read still shows the confirm, just without the instance-count line) so the confirm dialog
// can state it, mirroring the ruleStats / DelegationSettingsView.disable() precedent.
async function handleArchive() {
  if (!template.value || archiving.value) return
  const current = template.value
  let usage
  try {
    usage = await getTemplateUsage(current.id)
  } catch {
    usage = undefined
  }
  try {
    await ElMessageBox.confirm(
      templateArchiveConfirmMessage(current.name, usage),
      '停用模板',
      { confirmButtonText: '停用', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  archiving.value = true
  try {
    const updated = await archiveTemplate(current.id)
    store.activeTemplate = updated
    ElMessage.success('已停用模板')
  } catch (e: any) {
    ElMessage.error(e?.message ?? '停用模板失败')
  } finally {
    archiving.value = false
  }
}

async function handleUnarchive() {
  if (!template.value || archiving.value) return
  const current = template.value
  try {
    await ElMessageBox.confirm(
      templateUnarchiveConfirmMessage(current.name),
      '启用模板',
      { confirmButtonText: '启用', cancelButtonText: '取消', type: 'info' },
    )
  } catch {
    return
  }
  archiving.value = true
  try {
    const updated = await unarchiveTemplate(current.id)
    store.activeTemplate = updated
    ElMessage.success('已启用模板')
  } catch (e: any) {
    ElMessage.error(e?.message ?? '启用模板失败')
  } finally {
    archiving.value = false
  }
}

onMounted(() => {
  const id = route.params.id as string
  store.loadTemplate(id)
})
</script>

<style scoped>
.template-detail__error {
  margin-bottom: 16px;
}

.template-detail__content-wrapper {
  min-height: 200px;
}

.template-detail__info {
  margin-bottom: 20px;
}

.template-detail__info p {
  color: var(--el-text-color-regular);
  margin: 0 0 12px;
}

.template-detail__meta {
  display: flex;
  gap: 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  flex-wrap: wrap;
}

.template-detail__category,
.template-detail__visibility {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 12px;
  font-size: 13px;
  flex-wrap: wrap;
}

.template-detail__category-label {
  color: var(--el-text-color-regular);
  margin-right: 4px;
}

.template-detail__category-empty {
  color: var(--el-text-color-secondary);
}

.template-detail__visibility-ids {
  color: var(--el-text-color-secondary);
}

.template-detail__content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.template-detail__section {
  background: var(--ms-bg-card);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 20px;
}

.template-detail__section h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 16px;
}

.template-detail__node-content {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.template-detail__node-assignee {
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.template-detail__node-mode,
.template-detail__node-policy {
  margin-left: 4px;
}

@media (max-width: 768px) {
  .template-detail__meta {
    flex-direction: column;
    gap: 8px;
  }
}
</style>
