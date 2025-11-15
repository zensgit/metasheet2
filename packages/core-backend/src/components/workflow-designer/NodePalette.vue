<template>
  <div class="node-palette">
    <h3 class="palette-title">节点组件</h3>

    <div class="palette-section">
      <h4 class="section-title">基础节点</h4>
      <div class="node-list">
        <div
          v-for="node in basicNodes"
          :key="node.type"
          class="palette-node"
          :draggable="true"
          @dragstart="onDragStart($event, node.type)"
          @dragend="onDragEnd"
        >
          <div class="node-icon" :style="{ backgroundColor: node.color }">
            {{ node.icon }}
          </div>
          <span class="node-label">{{ node.label }}</span>
        </div>
      </div>
    </div>

    <div class="palette-section">
      <h4 class="section-title">控制节点</h4>
      <div class="node-list">
        <div
          v-for="node in controlNodes"
          :key="node.type"
          class="palette-node"
          :draggable="true"
          @dragstart="onDragStart($event, node.type)"
          @dragend="onDragEnd"
        >
          <div class="node-icon" :style="{ backgroundColor: node.color }">
            {{ node.icon }}
          </div>
          <span class="node-label">{{ node.label }}</span>
        </div>
      </div>
    </div>

    <div class="palette-section">
      <h4 class="section-title">集成节点</h4>
      <div class="node-list">
        <div
          v-for="node in integrationNodes"
          :key="node.type"
          class="palette-node"
          :draggable="true"
          @dragstart="onDragStart($event, node.type)"
          @dragend="onDragEnd"
        >
          <div class="node-icon" :style="{ backgroundColor: node.color }">
            {{ node.icon }}
          </div>
          <span class="node-label">{{ node.label }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  dragStart: [nodeType: string]
  dragEnd: []
}>()

const basicNodes = [
  { type: 'start', label: '开始', icon: '▶', color: '#22c55e' },
  { type: 'end', label: '结束', icon: '■', color: '#ef4444' },
  { type: 'task', label: '任务', icon: '📋', color: '#3b82f6' },
  { type: 'subprocess', label: '子流程', icon: '📁', color: '#8b5cf6' }
]

const controlNodes = [
  { type: 'gateway', label: '条件网关', icon: '◆', color: '#f59e0b' },
  { type: 'parallel', label: '并行网关', icon: '+', color: '#f59e0b' },
  { type: 'loop', label: '循环', icon: '🔄', color: '#06b6d4' },
  { type: 'event', label: '事件', icon: '⚡', color: '#06b6d4' }
]

const integrationNodes = [
  { type: 'http', label: 'HTTP请求', icon: '🌐', color: '#10b981' },
  { type: 'database', label: '数据库', icon: '🗄️', color: '#6366f1' },
  { type: 'script', label: '脚本', icon: '📝', color: '#ec4899' },
  { type: 'approval', label: '审批', icon: '✓', color: '#f97316' },
  { type: 'notification', label: '通知', icon: '🔔', color: '#14b8a6' },
  { type: 'webhook', label: 'Webhook', icon: '🔗', color: '#a855f7' }
]

const onDragStart = (event: DragEvent, nodeType: string) => {
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('application/vueflow', nodeType)
  }
  emit('dragStart', nodeType)
}

const onDragEnd = () => {
  emit('dragEnd')
}
</script>

<style scoped>
.node-palette {
  width: 260px;
  background: white;
  border-right: 1px solid #e5e7eb;
  overflow-y: auto;
  padding: 16px;
}

.palette-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 16px 0;
  color: #1f2937;
}

.palette-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  color: #6b7280;
  margin: 0 0 12px 0;
  letter-spacing: 0.5px;
}

.node-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.palette-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: grab;
  transition: all 0.2s;
  background: white;
}

.palette-node:hover {
  border-color: #3b82f6;
  background: #f0f9ff;
  transform: translateY(-2px);
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.palette-node:active {
  cursor: grabbing;
  transform: translateY(0);
}

.node-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 16px;
  margin-bottom: 6px;
  color: white;
}

.node-label {
  font-size: 12px;
  color: #374151;
  text-align: center;
  word-break: break-all;
}
</style>