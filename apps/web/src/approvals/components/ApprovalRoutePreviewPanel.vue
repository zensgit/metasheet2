<template>
  <div class="approval-route-preview-panel">
    <p class="approval-route-preview-panel__hint" data-testid="approval-template-tryrun-draft-note">
      按最后保存的草稿和样例数据预演，不创建审批实例。
    </p>

    <el-form label-position="top" class="approval-route-preview-panel__form">
      <el-form-item label="样例发起人（留空 = 当前管理员）">
        <ApprovalUserPicker
          :model-value="requesterId"
          placeholder="搜索用户名 / 邮箱（可留空）"
          data-testid="approval-template-tryrun-requester-picker"
          @update:model-value="emit('update:requesterId', $event)"
        />
      </el-form-item>
      <template v-for="field in visibleFields" :key="field.id">
        <el-form-item
          v-if="!unsupportedReason(field)"
          :label="fieldLabel(field)"
          data-testid="approval-template-tryrun-field"
        >
          <el-input
            v-if="field.type === 'text' || field.type === 'textarea'"
            :model-value="formData[field.id]"
            :type="field.type === 'textarea' ? 'textarea' : 'text'"
            :rows="field.type === 'textarea' ? 2 : undefined"
            :placeholder="field.placeholder || `请输入${fieldLabel(field)}`"
            @update:model-value="setField(field.id, $event)"
          />
          <el-input-number
            v-else-if="field.type === 'number'"
            :model-value="numberFieldValue(field.id)"
            class="ms-w-100pct"
            @update:model-value="setField(field.id, $event)"
          />
          <el-date-picker
            v-else-if="field.type === 'date' || field.type === 'datetime'"
            :model-value="formData[field.id]"
            :type="field.type"
            :placeholder="field.placeholder || `请选择${fieldLabel(field)}`"
            class="ms-w-100pct"
            @update:model-value="setField(field.id, $event)"
          />
          <el-select
            v-else-if="field.type === 'select' || field.type === 'multi-select'"
            :model-value="formData[field.id]"
            :multiple="field.type === 'multi-select'"
            :placeholder="field.placeholder || `请选择${fieldLabel(field)}`"
            class="ms-w-100pct"
            @update:model-value="setField(field.id, $event)"
          >
            <el-option
              v-for="opt in (field.options || [])"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
          <ApprovalUserPicker
            v-else-if="field.type === 'user'"
            :model-value="(formData[field.id] as string | null | undefined) ?? null"
            @update:model-value="setField(field.id, $event)"
          />
        </el-form-item>
        <div
          v-else
          class="approval-route-preview-panel__hint"
          data-testid="approval-template-tryrun-field-unsupported"
        >
          {{ fieldLabel(field) }}：{{ unsupportedReason(field) }}
        </div>
      </template>
    </el-form>

    <el-collapse v-if="hiddenFields.length > 0" class="approval-route-preview-panel__hidden">
      <el-collapse-item
        :title="`当前隐藏 ${hiddenFields.length} 个字段（不参与走图）`"
        name="hidden"
        data-testid="approval-template-tryrun-hidden"
      >
        <ul class="approval-route-preview-panel__hidden-list">
          <li v-for="entry in hiddenFields" :key="entry.field.id" data-testid="approval-template-tryrun-hidden-field">
            <span>{{ fieldLabel(entry.field) }}</span>
            <small>{{ entry.reason }}</small>
          </li>
        </ul>
      </el-collapse-item>
    </el-collapse>

    <div class="approval-route-preview-panel__actions">
      <el-tooltip v-if="disabledReason" :content="disabledReason" placement="top">
        <span><el-button :loading="loading" disabled data-testid="approval-template-tryrun-button">运行预演</el-button></span>
      </el-tooltip>
      <el-button v-else type="primary" :loading="loading" data-testid="approval-template-tryrun-button" @click="emit('run')">
        运行预演
      </el-button>
    </div>

    <div v-if="error" class="approval-route-preview-panel__error" data-testid="approval-template-tryrun-error">
      {{ error }}
    </div>
    <div
      v-if="!error && preview && !highlightComplete"
      class="approval-route-preview-panel__partial"
      data-testid="approval-template-tryrun-partial-highlight"
    >
      部分路径无法从预演结果唯一映射，画布仅标出可确认的节点和连线。
    </div>
    <ol v-if="!error && preview" class="approval-route-preview-panel__route" data-testid="approval-template-tryrun-result">
      <li class="approval-route-preview-panel__step">发起人</li>
      <li
        v-for="node in preview.route"
        :key="node.nodeKey"
        class="approval-route-preview-panel__step"
        :class="{ 'is-unresolved': !!node.resolveError }"
        data-testid="approval-template-tryrun-node"
      >
        <strong>{{ nodeLabel(node.nodeKey) }}</strong>
        <span>{{ routePreviewAssigneeSummary(node) }}</span>
      </li>
      <li v-if="preview.truncated" class="approval-route-preview-panel__note">
        路径未能完整解析，以实际流转为准。
      </li>
      <li v-else-if="preview.route.length === 0" class="approval-route-preview-panel__note">
        当前样例将直接通过，无审批节点。
      </li>
    </ol>

    <section v-if="decisions.length > 0" class="approval-route-preview-panel__decisions" data-testid="approval-template-tryrun-decisions">
      <strong>分支结果</strong>
      <div v-for="decision in decisions" :key="decision.nodeKey" class="approval-route-preview-panel__decision">
        <span>{{ decision.nodeLabel }}：命中「{{ decision.matched }}」</span>
        <small v-if="decision.skipped.length">跳过：{{ decision.skipped.join('、') }}</small>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import type { ApprovalRoutePreview } from '../api'
import type { RoutePreviewConditionDecision } from '../routePreviewHighlight'
import { routePreviewAssigneeSummary } from '../routePreviewSummary'
import type { FormField } from '../../types/approval'
import ApprovalUserPicker from './ApprovalUserPicker.vue'

const props = defineProps<{
  requesterId: string | null
  formData: Record<string, unknown>
  visibleFields: FormField[]
  hiddenFields: Array<{ field: FormField; reason: string }>
  loading: boolean
  error: string
  preview: ApprovalRoutePreview | null
  disabledReason: string
  decisions: RoutePreviewConditionDecision[]
  highlightComplete: boolean
  nodeLabel: (nodeKey: string) => string
}>()

const emit = defineEmits<{
  (event: 'update:requesterId', value: string | null): void
  (event: 'update:field', fieldId: string, value: unknown): void
  (event: 'run'): void
}>()

function fieldLabel(field: FormField): string {
  return field.label?.trim() || '未命名字段'
}

function numberFieldValue(fieldId: string): number | undefined {
  const value = props.formData[fieldId]
  return typeof value === 'number' ? value : undefined
}

function unsupportedReason(field: FormField): string | null {
  if (field.type === 'detail') return '试运行暂不支持明细子表单的样例值，已跳过（不影响其余字段的走图）'
  if (field.type === 'attachment') return '试运行暂不支持附件类型的样例值，已跳过'
  if (field.type === 'record-link') return '试运行暂不支持记录关联的样例值，已跳过'
  return null
}

function setField(fieldId: string, value: unknown): void {
  emit('update:field', fieldId, value)
}
</script>

<style scoped>
.approval-route-preview-panel {
  min-width: 0;
}
.approval-route-preview-panel__hint,
.approval-route-preview-panel__note,
.approval-route-preview-panel__step span,
.approval-route-preview-panel__decision small,
.approval-route-preview-panel__hidden-list small {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.approval-route-preview-panel__form,
.approval-route-preview-panel__route,
.approval-route-preview-panel__decisions {
  display: grid;
  gap: 8px;
}
.approval-route-preview-panel__hidden,
.approval-route-preview-panel__route,
.approval-route-preview-panel__decisions {
  margin-top: 14px;
}
.approval-route-preview-panel__hidden-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
}
.approval-route-preview-panel__hidden-list li {
  display: grid;
}
.approval-route-preview-panel__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
.approval-route-preview-panel__error {
  margin-top: 10px;
  color: var(--el-color-danger);
  font-size: 12px;
}
.approval-route-preview-panel__partial {
  margin-top: 10px;
  padding: 8px 10px;
  border-left: 3px solid var(--el-color-warning);
  background: var(--el-color-warning-light-9);
  color: var(--el-text-color-regular);
  font-size: 12px;
}
.approval-route-preview-panel__route {
  padding: 0;
  list-style: none;
}
.approval-route-preview-panel__step {
  display: grid;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--el-color-success-light-5);
  border-left: 3px solid var(--el-color-success);
  border-radius: 6px;
  background: var(--el-color-success-light-9);
  color: var(--el-text-color-primary);
  font-size: 12px;
}
.approval-route-preview-panel__step.is-unresolved {
  border-style: dashed;
  border-color: var(--el-color-warning);
  background: var(--el-color-warning-light-9);
}
.approval-route-preview-panel__decision {
  display: grid;
  gap: 2px;
  padding-left: 10px;
  border-left: 2px solid var(--el-color-primary-light-5);
  font-size: 12px;
}
</style>
