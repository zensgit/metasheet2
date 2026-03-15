<template>
  <div class="designer-header">
    <div class="header-left">
      <el-button :icon="ArrowLeft" @click="$emit('go-back')">返回</el-button>
      <el-divider direction="vertical" />
      <span class="workflow-name">{{ workflowName || '新建工作流' }}</span>
      <el-tag v-if="isDirty" type="warning" size="small">未保存</el-tag>
    </div>
    <div class="header-center">
      <el-button-group>
        <el-button :icon="ZoomOut" @click="$emit('zoom', -0.1)" />
        <el-button>{{ Math.round(zoomLevel * 100) }}%</el-button>
        <el-button :icon="ZoomIn" @click="$emit('zoom', 0.1)" />
        <el-button :icon="FullScreen" @click="$emit('fit-viewport')" />
      </el-button-group>
    </div>
    <div class="header-right">
      <el-button @click="$emit('open-template-picker')">
        <el-icon><Document /></el-icon>
        模板
      </el-button>
      <el-button @click="$emit('toggle-properties')">
        <el-icon><Setting /></el-icon>
        属性面板
      </el-button>
      <el-button @click="$emit('validate-workflow')">
        <el-icon><CircleCheck /></el-icon>
        验证
      </el-button>
      <el-button type="primary" :loading="saving" @click="$emit('save-workflow')">
        <el-icon><Upload /></el-icon>
        保存
      </el-button>
      <el-button type="success" :loading="deploying" @click="$emit('deploy-workflow')">
        <el-icon><Promotion /></el-icon>
        部署
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ElButton, ElButtonGroup, ElDivider, ElIcon, ElTag } from 'element-plus'
import {
  ArrowLeft,
  CircleCheck,
  Document,
  FullScreen,
  Promotion,
  Setting,
  Upload,
  ZoomIn,
  ZoomOut,
} from '@element-plus/icons-vue'

defineProps<{
  workflowName: string
  isDirty: boolean
  zoomLevel: number
  saving: boolean
  deploying: boolean
}>()

defineEmits<{
  (event: 'go-back'): void
  (event: 'zoom', delta: number): void
  (event: 'fit-viewport'): void
  (event: 'open-template-picker'): void
  (event: 'toggle-properties'): void
  (event: 'validate-workflow'): void
  (event: 'save-workflow'): void
  (event: 'deploy-workflow'): void
}>()
</script>

<style scoped>
.designer-header {
  height: 64px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08);
  z-index: 100;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.workflow-name {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}

.header-center {
  display: flex;
  align-items: center;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
