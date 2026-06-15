<template>
  <div class="compile-preview" data-testid="compile-preview">
    <div v-if="loading" class="compile-preview__state" data-testid="compile-preview-loading">
      正在编译预览…
    </div>

    <el-alert
      v-else-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
      data-testid="compile-preview-error"
    >
      预览失败，草稿未被修改。
    </el-alert>

    <div v-else-if="!result" class="compile-preview__state" data-testid="compile-preview-empty">
      暂无预览结果。
    </div>

    <div v-else class="compile-preview__body" data-testid="compile-preview-body">
      <p class="compile-preview__note">
        只读预览：以下为该草稿编译到现有自动化 / 审批原语的结果，不会部署、启动或修改草稿。
      </p>

      <div class="compile-preview__summary">
        <span>来源：{{ sourceModeLabel }}</span>
        <span v-if="result.source.sourceVersion != null">版本 v{{ result.source.sourceVersion }}</span>
        <el-tag
          :type="result.supported ? 'success' : 'warning'"
          size="small"
          data-testid="compile-preview-supported"
        >
          {{ result.supported ? '可完整映射' : '存在不支持的节点' }}
        </el-tag>
      </div>

      <section class="compile-preview__section">
        <h4>自动化预览</h4>
        <template v-if="result.automationPreview">
          <p data-testid="compile-preview-automation">
            {{ result.automationPreview.actionCount }} 个动作 · 需要执行模式
            {{ result.automationPreview.requiresExecutionMode }}
          </p>
          <details v-if="result.automationPreview.actionCount" class="compile-preview__detail" open>
            <summary>查看动作配置（已脱敏）</summary>
            <pre data-testid="compile-preview-automation-actions">{{ toJson(result.automationPreview.actions) }}</pre>
          </details>
        </template>
        <p v-else class="compile-preview__muted">无自动化映射</p>
      </section>

      <section class="compile-preview__section">
        <h4>审批预览</h4>
        <template v-if="result.approvalPreview">
          <p data-testid="compile-preview-approval">
            表单：{{ yesNo(result.approvalPreview.hasFormSchema) }} · 审批图：{{ yesNo(result.approvalPreview.hasApprovalGraph) }}
            · 运行预览：{{ yesNo(result.approvalPreview.hasRuntimeGraphPreview) }}
          </p>
          <details
            v-if="result.approvalPreview.hasApprovalGraph"
            class="compile-preview__detail"
            open
          >
            <summary>查看审批图（已脱敏）</summary>
            <pre data-testid="compile-preview-approval-graph">{{ toJson(result.approvalPreview.approvalGraph) }}</pre>
          </details>
          <details v-if="result.approvalPreview.hasFormSchema" class="compile-preview__detail">
            <summary>查看表单结构（已脱敏）</summary>
            <pre data-testid="compile-preview-approval-form">{{ toJson(result.approvalPreview.formSchema) }}</pre>
          </details>
          <details v-if="result.approvalPreview.hasRuntimeGraphPreview" class="compile-preview__detail">
            <summary>查看运行预览（已脱敏）</summary>
            <pre data-testid="compile-preview-approval-runtime">{{ toJson(result.approvalPreview.runtimeGraphPreview) }}</pre>
          </details>
        </template>
        <p v-else class="compile-preview__muted">无审批映射</p>
      </section>

      <section class="compile-preview__section">
        <h4>映射报告（{{ result.mappingReport.length }}）</h4>
        <table
          v-if="result.mappingReport.length"
          class="compile-preview__table"
          data-testid="compile-preview-mapping"
        >
          <thead>
            <tr>
              <th>BPMN 元素</th>
              <th>类型</th>
              <th>目标</th>
              <th>目标原语</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(mapping, index) in result.mappingReport" :key="`${mapping.bpmnElementId}-${index}`">
              <td>{{ mapping.bpmnElementId }}</td>
              <td>{{ mapping.bpmnElementType }}</td>
              <td>{{ targetLabel(mapping.target) }}</td>
              <td>{{ mapping.targetKind }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="compile-preview__muted">无映射</p>
      </section>

      <section class="compile-preview__section">
        <h4>缺口报告（{{ result.gapReport.length }}）</h4>
        <el-alert
          v-if="result.gapReport.length"
          type="warning"
          :closable="false"
          show-icon
          title="以下 BPMN 节点暂无法映射到现有原语"
          data-testid="compile-preview-gaps"
        >
          <ul class="compile-preview__gaps">
            <li v-for="(gap, index) in result.gapReport" :key="`${gap.bpmnElementId}-${index}`">
              <strong>{{ gap.bpmnElementId }}</strong>（{{ gap.bpmnElementType }}）：{{ gap.reason }}
              <em v-if="gap.requiredRung"> · 需要能力：{{ gap.requiredRung }}</em>
            </li>
          </ul>
        </el-alert>
        <p v-else class="compile-preview__muted" data-testid="compile-preview-no-gaps">无缺口</p>
      </section>

      <section v-if="result.warnings.length" class="compile-preview__section">
        <h4>警告（{{ result.warnings.length }}）</h4>
        <ul class="compile-preview__warnings" data-testid="compile-preview-warnings">
          <li v-for="(warning, index) in result.warnings" :key="index">{{ warning }}</li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElAlert, ElTag } from 'element-plus'
// Element Plus styles are loaded globally (and by the parent WorkflowDesigner view);
// per-component CSS imports are intentionally omitted so this panel mounts cleanly in jsdom tests.
import type {
  WorkflowCompilePreview,
  WorkflowCompilePreviewMapping,
} from '../../views/workflowDesignerPersistence'

const props = defineProps<{
  result: WorkflowCompilePreview | null
  loading: boolean
  error: string
}>()

const sourceModeLabel = computed(() =>
  props.result?.source.mode === 'bpmn_xml' ? 'BPMN XML' : '可视化定义',
)

function yesNo(value: boolean): string {
  return value ? '有' : '无'
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2)
}

function targetLabel(target: WorkflowCompilePreviewMapping['target']): string {
  if (target === 'automation') return '自动化'
  if (target === 'approval') return '审批'
  return '结构'
}
</script>

<style scoped>
.compile-preview {
  font-size: 14px;
  color: #303133;
}

.compile-preview__state {
  padding: 24px;
  text-align: center;
  color: #909399;
}

.compile-preview__note {
  margin: 0 0 12px;
  padding: 8px 12px;
  background: #f4f4f5;
  border-radius: 4px;
  color: #606266;
  font-size: 13px;
}

.compile-preview__summary {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.compile-preview__section {
  margin-bottom: 16px;
}

.compile-preview__section h4 {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.compile-preview__muted {
  margin: 0;
  color: #909399;
}

.compile-preview__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.compile-preview__table th,
.compile-preview__table td {
  border: 1px solid #ebeef5;
  padding: 6px 10px;
  text-align: left;
}

.compile-preview__table th {
  background: #fafafa;
  font-weight: 600;
}

.compile-preview__detail {
  margin-top: 8px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  padding: 6px 10px;
  background: #fafafa;
}

.compile-preview__detail summary {
  cursor: pointer;
  color: #606266;
  font-size: 13px;
  user-select: none;
}

.compile-preview__detail pre {
  margin: 8px 0 0;
  max-height: 240px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.compile-preview__gaps,
.compile-preview__warnings {
  margin: 4px 0 0;
  padding-left: 18px;
}

.compile-preview__gaps li,
.compile-preview__warnings li {
  margin-bottom: 4px;
  line-height: 1.5;
}
</style>
