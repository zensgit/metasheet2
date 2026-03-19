<template>
  <div class="properties-panel">
    <div class="panel-header">
      <span>{{ selectedElement ? '元素属性' : '工作流属性' }}</span>
      <el-button :icon="Close" text @click="emit('close')" />
    </div>
    <div class="panel-content">
      <template v-if="!selectedElement">
        <el-form label-position="top" size="small">
          <el-form-item label="工作流名称">
            <el-input :model-value="workflowName" placeholder="输入工作流名称" @update:model-value="emit('update:workflowName', $event)" />
          </el-form-item>
          <el-form-item label="工作流描述">
            <el-input
              :model-value="workflowDescription"
              type="textarea"
              :rows="3"
              placeholder="输入工作流描述"
              @update:model-value="emit('update:workflowDescription', $event)"
            />
          </el-form-item>
          <el-form-item label="版本">
            <el-input :model-value="workflowVersion" disabled />
          </el-form-item>
        </el-form>
      </template>
      <template v-else>
        <el-form label-position="top" size="small">
          <el-form-item label="元素ID">
            <el-input :model-value="selectedElement.id" disabled />
          </el-form-item>
          <el-form-item label="元素名称">
            <el-input
              :model-value="elementName"
              placeholder="输入元素名称"
              @update:model-value="emit('update:elementName', $event)"
              @change="emit('commitElementName')"
            />
          </el-form-item>
          <el-form-item label="元素类型">
            <el-tag>{{ elementTypeLabel }}</el-tag>
          </el-form-item>
          <template v-if="isTaskElement">
            <el-form-item label="执行人">
              <el-input
                id="workflow-task-assignee"
                :model-value="taskAssignee"
                name="taskAssignee"
                placeholder="输入执行人"
                @update:model-value="emit('update:taskAssignee', $event)"
              />
            </el-form-item>
            <el-form-item label="候选人">
              <el-input
                id="workflow-task-candidates"
                :model-value="taskCandidates"
                name="taskCandidates"
                placeholder="多人用逗号分隔"
                @update:model-value="emit('update:taskCandidates', $event)"
              />
            </el-form-item>
            <el-form-item label="到期时间">
              <el-input
                id="workflow-task-due-date"
                :model-value="taskDueDate"
                name="taskDueDate"
                placeholder="如: PT1H (1小时)"
                @update:model-value="emit('update:taskDueDate', $event)"
              />
            </el-form-item>
          </template>
          <template v-if="isGatewayElement">
            <el-form-item label="默认流">
              <el-select :model-value="gatewayDefault" placeholder="选择默认出口" @update:model-value="emit('update:gatewayDefault', $event)">
                <el-option
                  v-for="flow in outgoingFlows"
                  :key="flow.id"
                  :label="flow.name || flow.id"
                  :value="flow.id"
                />
              </el-select>
            </el-form-item>
          </template>
          <template v-if="isSequenceFlow">
            <el-form-item label="条件表达式">
              <el-input
                :model-value="flowCondition"
                type="textarea"
                :rows="2"
                placeholder="${amount > 1000}"
                @update:model-value="emit('update:flowCondition', $event)"
              />
            </el-form-item>
          </template>
        </el-form>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ElButton, ElForm, ElFormItem, ElInput, ElOption, ElSelect, ElTag } from 'element-plus'
import { Close } from '@element-plus/icons-vue'

interface BpmnElement {
  id: string
  type: string
}

defineProps<{
  workflowName: string
  workflowDescription: string
  workflowVersion: string
  selectedElement: BpmnElement | null
  elementName: string
  elementTypeLabel: string
  taskAssignee: string
  taskCandidates: string
  taskDueDate: string
  gatewayDefault: string
  flowCondition: string
  isTaskElement: boolean
  isGatewayElement: boolean
  isSequenceFlow: boolean
  outgoingFlows: Array<{ id: string; name?: string }>
}>()

const emit = defineEmits<{
  close: []
  'update:workflowName': [value: string]
  'update:workflowDescription': [value: string]
  'update:elementName': [value: string]
  commitElementName: []
  'update:taskAssignee': [value: string]
  'update:taskCandidates': [value: string]
  'update:taskDueDate': [value: string]
  'update:gatewayDefault': [value: string]
  'update:flowCondition': [value: string]
}>()
</script>

<style scoped>
.properties-panel {
  width: 280px;
  background: var(--el-bg-color);
  border-left: 1px solid var(--el-border-color-light);
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-light);
  font-weight: 500;
}

.panel-content {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}
</style>
