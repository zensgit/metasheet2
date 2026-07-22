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

          <!-- B3-09 (模板治理 — 版本历史): admin-only (the endpoint sits behind the same
               template-admin guard as publish/archive; non-admins never fetch, so no 403 noise).
               Summary rows only — full schema/graph of one version stays an on-demand detail
               fetch, not part of this list. -->
          <div
            v-if="canManageTemplates"
            class="template-detail__section"
            data-testid="template-detail-version-history"
          >
            <h2>版本历史</h2>
            <el-alert
              v-if="versionHistoryError"
              type="warning"
              :title="versionHistoryError"
              :closable="false"
            />
            <el-table
              v-else
              :data="versionHistory"
              class="ms-w-100pct"
              max-height="320"
              stripe
            >
              <el-table-column label="版本" :width="isNarrowViewport ? 72 : 90">
                <template #default="{ row }">v{{ row.version }}</template>
              </el-table-column>
              <el-table-column label="状态" :width="isNarrowViewport ? 120 : 140">
                <template #default="{ row }">
                  <el-tag size="small" :type="versionStatusTagType(row.status)">
                    {{ versionStatusLabel(row.status) }}
                  </el-tag>
                  <el-tag
                    v-if="row.publishedDefinitionId"
                    size="small"
                    type="success"
                    class="template-detail__version-active-tag"
                  >
                    当前生效
                  </el-tag>
                  <el-tag
                    v-if="row.restoredFromVersionId"
                    size="small"
                    type="warning"
                    class="template-detail__version-source-tag"
                  >
                    恢复自 {{ restoredSourceLabel(row.restoredFromVersionId) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column v-if="!isNarrowViewport" label="发布说明" min-width="240">
                <template #default="{ row }">
                  <span v-if="row.publishNote" class="template-detail__version-note">{{ row.publishNote }}</span>
                  <span v-else>-</span>
                </template>
              </el-table-column>
              <el-table-column v-if="!isNarrowViewport" label="更新时间" width="180">
                <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
              </el-table-column>
              <el-table-column
                label="操作"
                :width="isNarrowViewport ? 142 : 190"
                :fixed="isNarrowViewport ? undefined : 'right'"
              >
                <template #default="{ row }">
                  <el-button
                    link
                    type="primary"
                    :icon="View"
                    :loading="versionDiffLoading && selectedVersionId === row.id"
                    :data-testid="`template-version-compare-${row.id}`"
                    @click="openVersionDiff(row)"
                  >
                    查看变化
                  </el-button>
                  <el-button
                    v-if="row.id !== template.latestVersionId"
                    link
                    type="warning"
                    :icon="RefreshLeft"
                    :loading="restoringVersionId === row.id"
                    :data-testid="`template-version-restore-${row.id}`"
                    @click="handleRestoreVersion(row)"
                  >
                    恢复
                  </el-button>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty description="暂无版本记录" :image-size="60" />
              </template>
            </el-table>

            <div
              v-if="selectedVersionId"
              v-loading="versionDiffLoading"
              class="template-detail__version-diff"
              data-testid="template-version-diff"
            >
              <div class="template-detail__version-diff-header">
                <div>
                  <h3>{{ versionDiffTitle }}</h3>
                  <span v-if="selectedVersion?.restoredFromVersionId" class="template-detail__version-source">
                    恢复自 {{ restoredSourceLabel(selectedVersion.restoredFromVersionId) }}
                  </span>
                </div>
                <el-button
                  circle
                  text
                  :icon="Close"
                  title="关闭版本比较"
                  aria-label="关闭版本比较"
                  @click="closeVersionDiff"
                />
              </div>
              <template v-if="versionDiff">
                <div class="template-detail__version-diff-summary">
                  <span>表单字段 {{ versionDiff.fieldChanges }}</span>
                  <span>流程节点 {{ versionDiff.nodeChanges }}</span>
                  <span>连线 {{ versionDiff.edgeChanges }}</span>
                </div>
                <el-segmented
                  v-if="versionDiff.totalChanges > 0"
                  v-model="versionDiffMode"
                  :options="versionDiffModeOptions"
                  size="small"
                  class="template-detail__version-diff-mode"
                  data-testid="template-version-diff-mode"
                />
                <el-empty
                  v-if="versionDiff.totalChanges === 0"
                  description="与上一版本无结构变化"
                  :image-size="48"
                />
                <ul v-else-if="versionDiffMode === 'list'" class="template-detail__version-change-list">
                  <li
                    v-for="change in versionDiff.changes"
                    :key="`${change.entity}-${change.key}-${change.kind}`"
                  >
                    <el-tag
                      size="small"
                      :type="versionChangeTagType(change.kind)"
                      class="template-detail__version-change-kind"
                    >
                      {{ versionChangeKindLabel(change.kind) }}
                    </el-tag>
                    <span class="template-detail__version-change-entity">
                      {{ versionChangeEntityLabel(change.entity) }}
                    </span>
                    <strong>{{ change.label }}</strong>
                  </li>
                </ul>
                <div
                  v-else-if="versionOverlay && versionOverlayLayout"
                  class="template-detail__version-overlay"
                  data-testid="template-version-graph-overlay"
                >
                  <p v-if="versionDiff.fieldChanges" class="template-detail__version-overlay-note">
                    另有 {{ versionDiff.fieldChanges }} 项表单字段变化，请切回列表查看。
                  </p>
                  <div
                    class="template-detail__version-overlay-canvas"
                    :style="{ width: `${versionOverlayLayout.width}px`, height: `${versionOverlayLayout.height}px` }"
                  >
                    <svg
                      class="template-detail__version-overlay-edges"
                      :width="versionOverlayLayout.width"
                      :height="versionOverlayLayout.height"
                    >
                      <defs>
                        <marker id="approval-version-overlay-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                          <path d="M0,0 L7,3 L0,6 Z" fill="currentColor" />
                        </marker>
                      </defs>
                      <path
                        v-for="line in versionOverlayEdgeLines"
                        :key="line.key"
                        :d="line.path"
                        class="template-detail__version-overlay-edge"
                        :class="line.change ? `is-${line.change}` : ''"
                        marker-end="url(#approval-version-overlay-arrow)"
                        data-testid="template-version-overlay-edge"
                      />
                    </svg>
                    <div
                      v-for="pos in versionOverlayLayout.nodes"
                      :key="pos.key"
                      class="template-detail__version-overlay-node"
                      :class="versionOverlayNodeChange(pos.key) ? `is-${versionOverlayNodeChange(pos.key)}` : ''"
                      :style="{
                        left: `${pos.x}px`,
                        top: `${pos.y}px`,
                        width: `${VERSION_OVERLAY_NODE_W}px`,
                        minHeight: `${VERSION_OVERLAY_NODE_H}px`,
                      }"
                      data-testid="template-version-overlay-node"
                    >
                      <strong>{{ versionOverlayNodeLabel(pos.key) }}</strong>
                      <el-tag
                        v-if="versionOverlayNodeChange(pos.key)"
                        size="small"
                        :type="versionChangeTagType(versionOverlayNodeChange(pos.key)!)"
                      >
                        {{ versionChangeKindLabel(versionOverlayNodeChange(pos.key)!) }}
                      </el-tag>
                    </div>
                  </div>
                </div>
              </template>
              <el-alert
                v-else-if="versionDiffError"
                type="warning"
                :title="versionDiffError"
                :closable="false"
              />
            </div>
          </div>
        </div>
      </div>

      <el-empty v-else-if="!store.loading" description="未找到模板" />
    </div>
  </PageShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
  View,
  RefreshLeft,
  Close,
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  ApprovalNodeType,
  FormFieldType,
  ApprovalMode,
  EmptyAssigneePolicy,
  ApprovalTemplateVisibilityScope,
  ApprovalTemplateVisibilityType,
  ApprovalTemplateVersionSummaryDTO,
  ApprovalTemplateVersionDetailDTO,
  ApprovalTemplateStatus,
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
  getTemplateVersion,
  listTemplateVersions,
  restoreTemplateVersion,
} from '../../approvals/api'
import {
  diffApprovalTemplateVersions,
  type TemplateVersionChangeEntity,
  type TemplateVersionChangeKind,
  type TemplateVersionDiff,
} from '../../approvals/templateVersionDiff'
import { buildVersionGraphOverlay } from '../../approvals/versionGraphOverlay'
import {
  computeLayout,
  GRAPH_LAYOUT_NODE_HEIGHT,
  GRAPH_LAYOUT_NODE_WIDTH,
} from '../../approvals/graphLayout'
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
const isNarrowViewport = ref(false)
let narrowViewportQuery: MediaQueryList | null = null

function syncNarrowViewport(event?: MediaQueryListEvent) {
  isNarrowViewport.value = event?.matches ?? narrowViewportQuery?.matches ?? false
}

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

// B3-09 (模板治理 — 版本历史) — admin-only fetch. `canManageTemplates` resolves asynchronously
// (refreshApprovalAccess), so a mount-time check would race a slow permission load to a permanently
// empty section; instead watch it and fetch ONCE when it turns true. Non-admins never fire the
// request (the endpoint would 403 them anyway).
const versionHistory = ref<ApprovalTemplateVersionSummaryDTO[]>([])
const versionHistoryError = ref('')
const selectedVersionId = ref<string | null>(null)
const selectedVersion = ref<ApprovalTemplateVersionDetailDTO | null>(null)
const selectedBaseline = ref<ApprovalTemplateVersionSummaryDTO | null>(null)
const selectedBaselineSnapshot = ref<Pick<ApprovalTemplateVersionDetailDTO, 'formSchema' | 'approvalGraph'> | null>(null)
const versionDiff = ref<TemplateVersionDiff | null>(null)
const versionDiffMode = ref<'list' | 'canvas'>('list')
const versionDiffModeOptions = [
  { label: '变化列表', value: 'list' },
  { label: '流程画布', value: 'canvas' },
]
const versionDiffLoading = ref(false)
const versionDiffError = ref('')
const restoringVersionId = ref<string | null>(null)
const versionDetailCache = new Map<string, ApprovalTemplateVersionDetailDTO>()
let versionHistoryFetched = false

const versionDiffTitle = computed(() => {
  if (!selectedVersion.value) return '版本变化'
  return selectedBaseline.value
    ? `v${selectedBaseline.value.version} -> v${selectedVersion.value.version}`
    : `v${selectedVersion.value.version} 初始内容`
})
const versionOverlay = computed(() => {
  if (!selectedVersion.value || !selectedBaselineSnapshot.value || !versionDiff.value) return null
  return buildVersionGraphOverlay(
    selectedBaselineSnapshot.value.approvalGraph,
    selectedVersion.value.approvalGraph,
    versionDiff.value,
  )
})
const versionOverlayLayout = computed(() => versionOverlay.value ? computeLayout(versionOverlay.value.graph) : null)
const VERSION_OVERLAY_NODE_W = GRAPH_LAYOUT_NODE_WIDTH
const VERSION_OVERLAY_NODE_H = GRAPH_LAYOUT_NODE_HEIGHT
const versionOverlayEdgeLines = computed(() => {
  const overlay = versionOverlay.value
  const layout = versionOverlayLayout.value
  if (!overlay || !layout) return []
  const positions = new Map(layout.nodes.map((node) => [node.key, node]))
  return overlay.graph.edges.map((edge) => {
    const source = positions.get(edge.source)
    const target = positions.get(edge.target)
    const x1 = (source?.x ?? 0) + GRAPH_LAYOUT_NODE_WIDTH / 2
    const y1 = (source?.y ?? 0) + GRAPH_LAYOUT_NODE_HEIGHT
    const x2 = (target?.x ?? 0) + GRAPH_LAYOUT_NODE_WIDTH / 2
    const y2 = target?.y ?? 0
    const midY = y1 + (y2 - y1) / 2
    return {
      key: edge.key,
      path: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`,
      change: overlay.edgeChanges.get(edge.key),
    }
  })
})
function versionOverlayNodeChange(nodeKey: string): TemplateVersionChangeKind | undefined {
  return versionOverlay.value?.nodeChanges.get(nodeKey)
}
function versionOverlayNodeLabel(nodeKey: string): string {
  const node = versionOverlay.value?.graph.nodes.find((candidate) => candidate.key === nodeKey)
  return node?.name?.trim() || (node ? nodeTypeLabel(node.type) : '流程节点')
}

const VERSION_STATUS_LABELS: Record<ApprovalTemplateStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已停用',
}

function versionStatusLabel(status: ApprovalTemplateStatus): string {
  return VERSION_STATUS_LABELS[status] ?? status
}

function versionStatusTagType(status: ApprovalTemplateStatus): 'primary' | 'info' | 'warning' {
  if (status === 'published') return 'primary'
  if (status === 'archived') return 'warning'
  return 'info'
}

async function loadVersionHistory() {
  if (versionHistoryFetched) return
  versionHistoryFetched = true
  try {
    versionHistory.value = await listTemplateVersions(route.params.id as string)
    versionHistoryError.value = ''
  } catch (e: any) {
    // Load failure degrades to an inline warning — never blocks the rest of the detail page.
    versionHistoryError.value = e?.message ?? '版本历史加载失败'
  }
}

async function refreshVersionHistory() {
  versionHistory.value = await listTemplateVersions(route.params.id as string)
  versionHistoryError.value = ''
  versionHistoryFetched = true
}

function emptyVersionSnapshot(): Pick<ApprovalTemplateVersionDetailDTO, 'formSchema' | 'approvalGraph'> {
  return { formSchema: { fields: [] }, approvalGraph: { nodes: [], edges: [] } }
}

async function loadVersionDetail(versionId: string): Promise<ApprovalTemplateVersionDetailDTO> {
  const cached = versionDetailCache.get(versionId)
  if (cached) return cached
  const detail = await getTemplateVersion(route.params.id as string, versionId)
  versionDetailCache.set(versionId, detail)
  return detail
}

async function openVersionDiff(row: ApprovalTemplateVersionSummaryDTO) {
  selectedVersionId.value = row.id
  selectedVersion.value = null
  selectedBaselineSnapshot.value = null
  versionDiff.value = null
  versionDiffError.value = ''
  versionDiffLoading.value = true
  const rowIndex = versionHistory.value.findIndex((entry) => entry.id === row.id)
  const baseline = rowIndex >= 0 ? versionHistory.value[rowIndex + 1] ?? null : null
  selectedBaseline.value = baseline
  try {
    const [current, previous] = await Promise.all([
      loadVersionDetail(row.id),
      baseline ? loadVersionDetail(baseline.id) : Promise.resolve(emptyVersionSnapshot()),
    ])
    if (selectedVersionId.value !== row.id) return
    selectedVersion.value = current
    selectedBaselineSnapshot.value = previous
    versionDiff.value = diffApprovalTemplateVersions(previous, current)
  } catch (e: any) {
    if (selectedVersionId.value === row.id) {
      versionDiffError.value = e?.message ?? '版本变化加载失败'
    }
  } finally {
    if (selectedVersionId.value === row.id) versionDiffLoading.value = false
  }
}

function closeVersionDiff() {
  selectedVersionId.value = null
  selectedVersion.value = null
  selectedBaseline.value = null
  selectedBaselineSnapshot.value = null
  versionDiff.value = null
  versionDiffMode.value = 'list'
  versionDiffError.value = ''
}

function restoredSourceLabel(versionId: string): string {
  const source = versionHistory.value.find((entry) => entry.id === versionId)
  return source ? `v${source.version}` : '历史版本'
}

async function handleRestoreVersion(row: ApprovalTemplateVersionSummaryDTO) {
  const currentTemplate = template.value
  if (!currentTemplate?.latestVersionId || restoringVersionId.value) return
  try {
    await ElMessageBox.confirm(
      `将 v${row.version} 复制为新的草稿版本。当前已发布版本和运行中的审批不会改变。`,
      `恢复 v${row.version}`,
      { confirmButtonText: '恢复为新草稿', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }

  restoringVersionId.value = row.id
  try {
    const restored = await restoreTemplateVersion(currentTemplate.id, row.id, {
      expectedLatestVersionId: currentTemplate.latestVersionId,
    })
    versionDetailCache.set(restored.id, restored)
    await Promise.all([store.loadTemplate(currentTemplate.id), refreshVersionHistory()])
    ElMessage.success(`已恢复为草稿 v${restored.version}`)
    const restoredRow = versionHistory.value.find((entry) => entry.id === restored.id)
    if (restoredRow) await openVersionDiff(restoredRow)
  } catch (e: any) {
    ElMessage.error(e?.message ?? '恢复版本失败')
  } finally {
    restoringVersionId.value = null
  }
}

const VERSION_CHANGE_KIND_LABELS: Record<TemplateVersionChangeKind, string> = {
  added: '新增',
  removed: '删除',
  changed: '修改',
  moved: '移动',
}

const VERSION_CHANGE_ENTITY_LABELS: Record<TemplateVersionChangeEntity, string> = {
  field: '字段',
  node: '节点',
  edge: '连线',
}

function versionChangeKindLabel(kind: TemplateVersionChangeKind): string {
  return VERSION_CHANGE_KIND_LABELS[kind]
}

function versionChangeEntityLabel(entity: TemplateVersionChangeEntity): string {
  return VERSION_CHANGE_ENTITY_LABELS[entity]
}

function versionChangeTagType(kind: TemplateVersionChangeKind): 'success' | 'danger' | 'warning' | 'info' {
  if (kind === 'added') return 'success'
  if (kind === 'removed') return 'danger'
  if (kind === 'moved') return 'info'
  return 'warning'
}

watch(
  canManageTemplates,
  (isAdmin) => {
    if (isAdmin) void loadVersionHistory()
  },
  { immediate: true },
)

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    narrowViewportQuery = window.matchMedia('(max-width: 768px)')
    syncNarrowViewport()
    narrowViewportQuery.addEventListener('change', syncNarrowViewport)
  }
  const id = route.params.id as string
  store.loadTemplate(id)
})

onBeforeUnmount(() => {
  narrowViewportQuery?.removeEventListener('change', syncNarrowViewport)
  narrowViewportQuery = null
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

/* B3-09 — version-history rows */
.template-detail__version-active-tag {
  margin-left: 8px;
}

.template-detail__version-source-tag {
  margin-left: 8px;
}

.template-detail__version-note {
  white-space: pre-wrap;
  word-break: break-word;
}

.template-detail__version-diff {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.template-detail__version-diff-header,
.template-detail__version-diff-summary,
.template-detail__version-change-list li {
  display: flex;
  align-items: center;
}

.template-detail__version-diff-header {
  justify-content: space-between;
  gap: 12px;
}

.template-detail__version-diff-header h3 {
  margin: 0;
  font-size: 16px;
}

.template-detail__version-source {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-detail__version-diff-summary {
  gap: 20px;
  margin: 12px 0;
  color: var(--el-text-color-regular);
  font-size: 13px;
}

.template-detail__version-change-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.template-detail__version-change-list li {
  gap: 8px;
  min-width: 0;
}

.template-detail__version-change-list strong {
  overflow-wrap: anywhere;
}

.template-detail__version-change-kind,
.template-detail__version-change-entity {
  flex: 0 0 auto;
}

.template-detail__version-change-entity {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-detail__version-diff-mode {
  margin-bottom: 12px;
}

.template-detail__version-overlay {
  min-width: 0;
  max-height: min(66vh, 720px);
  overflow: auto;
}

.template-detail__version-overlay-note {
  margin: 0 0 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.template-detail__version-overlay-canvas {
  position: relative;
  min-width: 100%;
  min-height: 220px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--ms-bg-page);
}

.template-detail__version-overlay-edges {
  position: absolute;
  inset: 0;
  color: var(--el-border-color-darker);
}

.template-detail__version-overlay-edge {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}

.template-detail__version-overlay-edge.is-added {
  color: var(--el-color-success);
}

.template-detail__version-overlay-edge.is-changed,
.template-detail__version-overlay-edge.is-moved {
  color: var(--el-color-warning);
  stroke-dasharray: 2 3;
}

.template-detail__version-overlay-edge.is-removed {
  color: var(--el-color-danger);
  stroke-dasharray: 5 4;
}

.template-detail__version-overlay-node {
  position: absolute;
  box-sizing: border-box;
  min-height: 76px;
  padding: 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--ms-bg-card);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}

.template-detail__version-overlay-node.is-added {
  border-color: var(--el-color-success);
}

.template-detail__version-overlay-node.is-changed,
.template-detail__version-overlay-node.is-moved {
  border-color: var(--el-color-warning);
}

.template-detail__version-overlay-node.is-removed {
  border-color: var(--el-color-danger);
  border-style: dashed;
  opacity: 0.72;
}

@media (max-width: 768px) {
  .template-detail__meta {
    flex-direction: column;
    gap: 8px;
  }

  .template-detail__version-diff-summary {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
}
</style>
