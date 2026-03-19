<template>
  <el-dialog :model-value="modelValue" title="工作流模板" width="960px" @update:model-value="emit('update:modelValue', $event)">
    <div class="template-dialog">
      <section class="template-dialog__catalog">
        <div v-if="recentTemplateItems.length" class="template-dialog__recent">
          <div class="template-dialog__detail-block">
            <h4>最近使用</h4>
            <div class="template-dialog__tag-list template-dialog__tag-list--buttons">
              <button
                v-for="template in recentTemplateItems"
                :key="template.id"
                class="template-dialog__recent-chip"
                type="button"
                @click="emit('selectRecentTemplate', template.id)"
              >
                <span>{{ template.name }}</span>
                <small>{{ template.source }}</small>
              </button>
            </div>
          </div>
        </div>

        <div class="template-dialog__toolbar">
          <el-input
            :model-value="templateSearch"
            placeholder="搜索模板"
            @update:model-value="emit('update:templateSearch', $event)"
            @keydown.enter="emit('refreshCatalog', 0)"
          />
          <el-select
            :model-value="templateSource"
            placeholder="来源"
            @update:model-value="emit('update:templateSource', $event)"
            @change="emit('refreshCatalog', 0)"
          >
            <el-option label="全部来源" value="all" />
            <el-option label="Builtin" value="builtin" />
            <el-option label="Database" value="database" />
          </el-select>
        </div>

        <p v-if="templateError" class="template-dialog__error">{{ templateError }}</p>
        <div v-if="templateLoading" class="template-dialog__empty">加载模板中...</div>
        <div v-else-if="!templateItems.length" class="template-dialog__empty">当前没有可用模板。</div>
        <div v-else class="template-dialog__list">
          <button
            v-for="template in templateItems"
            :key="template.id"
            class="template-dialog__item"
            :class="{ 'is-active': template.id === selectedTemplateId }"
            type="button"
            @click="emit('selectTemplate', template.id)"
          >
            <div class="template-dialog__item-top">
              <strong>{{ template.name }}</strong>
              <span class="template-dialog__badge" :data-source="template.source">{{ template.source }}</span>
            </div>
            <p>{{ template.description || 'No description' }}</p>
            <div class="template-dialog__meta">
              <span>{{ template.category }}</span>
              <span>Usage {{ template.usageCount }}</span>
            </div>
          </button>
        </div>

        <div class="template-dialog__pager">
          <span>{{ templateRangeLabel }}</span>
          <div class="template-dialog__pager-actions">
            <el-button size="small" :disabled="templateLoading || !canPagePrev" @click="emit('refreshCatalog', previousOffset)">
              上一页
            </el-button>
            <el-button size="small" :disabled="templateLoading || !canPageNext" @click="emit('refreshCatalog', nextOffset)">
              下一页
            </el-button>
          </div>
        </div>
      </section>

      <section class="template-dialog__detail">
        <template v-if="selectedTemplate">
          <header class="template-dialog__detail-header">
            <div>
              <h3>{{ selectedTemplate.name }}</h3>
              <p>{{ selectedTemplate.description || 'No description' }}</p>
            </div>
            <span class="template-dialog__badge" :data-source="selectedTemplate.source">{{ selectedTemplate.source }}</span>
          </header>

          <div class="template-dialog__meta-grid">
            <div>
              <span class="template-dialog__meta-label">Category</span>
              <strong>{{ selectedTemplate.category }}</strong>
            </div>
            <div>
              <span class="template-dialog__meta-label">Required Vars</span>
              <strong>{{ selectedTemplate.requiredVariables.length }}</strong>
            </div>
            <div>
              <span class="template-dialog__meta-label">Optional Vars</span>
              <strong>{{ selectedTemplate.optionalVariables.length }}</strong>
            </div>
          </div>

          <div v-if="selectedTemplate.requiredVariables.length" class="template-dialog__detail-block">
            <h4>Required Variables</h4>
            <div class="template-dialog__tag-list">
              <span v-for="item in selectedTemplate.requiredVariables" :key="item" class="template-dialog__tag">{{ item }}</span>
            </div>
          </div>

          <div v-if="selectedTemplate.optionalVariables.length" class="template-dialog__detail-block">
            <h4>Optional Variables</h4>
            <div class="template-dialog__tag-list">
              <span v-for="item in selectedTemplate.optionalVariables" :key="item" class="template-dialog__tag">{{ item }}</span>
            </div>
          </div>

          <div v-if="selectedTemplate.tags.length" class="template-dialog__detail-block">
            <h4>Tags</h4>
            <div class="template-dialog__tag-list">
              <span v-for="item in selectedTemplate.tags" :key="item" class="template-dialog__tag">{{ item }}</span>
            </div>
          </div>
        </template>
        <div v-else class="template-dialog__empty">选择左侧模板查看详情。</div>
      </section>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!selectedTemplateId" :loading="applyingTemplate" @click="emit('applySelected')">
        使用模板
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElButton, ElDialog, ElInput, ElOption, ElSelect } from 'element-plus'
import type {
  WorkflowDesignerPagination,
  WorkflowDesignerTemplateDetail,
  WorkflowDesignerTemplateListItem,
} from '../../views/workflowDesignerPersistence'
import type { RecentWorkflowTemplateItem } from '../../views/workflowDesignerRecentTemplates'

const props = defineProps<{
  modelValue: boolean
  templateLoading: boolean
  applyingTemplate: boolean
  templateError: string
  templateSearch: string
  templateSource: 'all' | 'builtin' | 'database'
  templateItems: WorkflowDesignerTemplateListItem[]
  templatePagination: WorkflowDesignerPagination
  templateRangeLabel: string
  recentTemplateItems: RecentWorkflowTemplateItem[]
  selectedTemplateId: string | null
  selectedTemplate: WorkflowDesignerTemplateDetail | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:templateSearch': [value: string]
  'update:templateSource': [value: 'all' | 'builtin' | 'database']
  refreshCatalog: [offset: number]
  selectTemplate: [templateId: string]
  selectRecentTemplate: [templateId: string]
  applySelected: []
}>()

const canPagePrev = computed(() => props.templatePagination.offset > 0)
const canPageNext = computed(
  () => props.templatePagination.offset + props.templatePagination.returned < props.templatePagination.total,
)
const previousOffset = computed(() => Math.max(0, props.templatePagination.offset - props.templatePagination.limit))
const nextOffset = computed(() => props.templatePagination.offset + props.templatePagination.limit)
</script>

<style scoped>
.template-dialog {
  display: grid;
  grid-template-columns: minmax(320px, 0.9fr) minmax(0, 1.1fr);
  gap: 16px;
}

.template-dialog__catalog,
.template-dialog__detail {
  min-height: 420px;
}

.template-dialog__recent {
  margin-bottom: 12px;
}

.template-dialog__toolbar,
.template-dialog__pager,
.template-dialog__pager-actions,
.template-dialog__item-top,
.template-dialog__meta-grid,
.template-dialog__tag-list {
  display: flex;
  gap: 12px;
}

.template-dialog__toolbar,
.template-dialog__pager,
.template-dialog__meta-grid {
  justify-content: space-between;
  align-items: center;
}

.template-dialog__list {
  display: grid;
  gap: 12px;
  margin: 12px 0;
}

.template-dialog__item {
  width: 100%;
  text-align: left;
  border: 1px solid #dcdfe6;
  border-radius: 12px;
  background: #fff;
  padding: 12px;
  cursor: pointer;
}

.template-dialog__item.is-active {
  border-color: #409eff;
  box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.15);
}

.template-dialog__item p,
.template-dialog__detail-header p {
  margin: 6px 0 0;
  color: #606266;
}

.template-dialog__meta {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: #909399;
}

.template-dialog__badge,
.template-dialog__tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  background: #f4f4f5;
  color: #606266;
}

.template-dialog__badge {
  text-transform: capitalize;
}

.template-dialog__badge[data-source='builtin'] {
  background: #ecf5ff;
  color: #409eff;
}

.template-dialog__badge[data-source='database'] {
  background: #f0f9eb;
  color: #67c23a;
}

.template-dialog__detail {
  padding: 12px;
  border: 1px solid #ebeef5;
  border-radius: 12px;
  background: #fafafa;
}

.template-dialog__detail-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.template-dialog__detail-header h3,
.template-dialog__detail-block h4 {
  margin: 0;
}

.template-dialog__meta-grid > div,
.template-dialog__detail-block {
  display: grid;
  gap: 6px;
}

.template-dialog__tag-list--buttons {
  flex-wrap: wrap;
}

.template-dialog__meta-label {
  font-size: 12px;
  color: #909399;
}

.template-dialog__tag {
  background: #fff;
}

.template-dialog__recent-chip {
  display: inline-grid;
  gap: 2px;
  border: 1px solid #dcdfe6;
  border-radius: 999px;
  background: #fff;
  padding: 8px 12px;
  cursor: pointer;
}

.template-dialog__recent-chip small {
  color: #909399;
}

.template-dialog__empty,
.template-dialog__error {
  padding: 16px;
  text-align: center;
  color: #909399;
}

.template-dialog__error {
  color: #f56c6c;
}

@media (max-width: 1080px) {
  .template-dialog {
    grid-template-columns: 1fr;
  }
}
</style>
