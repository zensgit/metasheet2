<template>
  <section class="template-detail">
    <header class="template-detail__header">
      <el-button text @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
        返回模板列表
      </el-button>
      <h1 v-if="template">{{ template.name }}</h1>
      <el-tag
        v-if="template"
        :type="statusTagType(template.status)"
        size="large"
        :effect="template.status === 'published' ? 'dark' : 'light'"
      >
        {{ statusLabel(template.status) }}
      </el-tag>
      <el-button
        v-if="template && template.status === 'published' && canWrite"
        type="primary"
        :loading="store.loading"
        @click="startApproval"
      >
        发起审批
      </el-button>
    </header>

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
            <el-table :data="template.formSchema.fields" style="width: 100%" max-height="400" stripe>
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
                </div>
              </el-timeline-item>
            </el-timeline>
            <el-empty v-else description="暂无审批节点" :image-size="60" />
          </div>
        </div>
      </div>

      <el-empty v-else-if="!store.loading" description="未找到模板" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowLeft,
  Flag,
  UserFilled,
  Message,
  QuestionFilled,
  CircleCheckFilled,
} from '@element-plus/icons-vue'
import type { ApprovalNodeType, FormFieldType } from '../../types/approval'
import { useApprovalTemplateStore } from '../../approvals/templateStore'
import { useApprovalPermissions } from '../../approvals/permissions'

const route = useRoute()
const router = useRouter()
const store = useApprovalTemplateStore()
const { canWrite } = useApprovalPermissions()

const template = computed(() => store.activeTemplate)

function statusTagType(status: string) {
  const map: Record<string, string> = {
    published: 'success',
    draft: 'warning',
    archived: 'info',
  }
  return map[status] ?? ''
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    published: '已发布',
    draft: '草稿',
    archived: '已归档',
  }
  return map[status] ?? status
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
  }
  return map[type] ?? type
}

function nodeTypeLabel(type: ApprovalNodeType) {
  const map: Record<ApprovalNodeType, string> = {
    start: '开始',
    approval: '审批',
    cc: '抄送',
    condition: '条件',
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
    end: 'info',
  }
  return map[type] ?? ''
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

onMounted(() => {
  const id = route.params.id as string
  store.loadTemplate(id)
})
</script>

<style scoped>
.template-detail {
  max-width: 1000px;
  margin: 0 auto;
  padding: 24px;
}

.template-detail__header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.template-detail__header h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  flex: 1;
}

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
  color: var(--el-text-color-regular, #606266);
  margin: 0 0 12px;
}

.template-detail__meta {
  display: flex;
  gap: 24px;
  font-size: 13px;
  color: var(--el-text-color-secondary, #909399);
  flex-wrap: wrap;
}

.template-detail__content {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.template-detail__section {
  background: #fff;
  border: 1px solid var(--el-border-color-lighter, #e4e7ed);
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
  color: var(--el-text-color-regular, #606266);
}

@media (max-width: 768px) {
  .template-detail__meta {
    flex-direction: column;
    gap: 8px;
  }
}
</style>
