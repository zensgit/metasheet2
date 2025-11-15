<template>
  <div class="task-node" :style="{ borderColor: data.color }">
    <Handle type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" />
    
    <div class="node-header" :style="{ backgroundColor: data.color }">
      <div class="node-icon">📋</div>
      <div class="node-type">任务</div>
    </div>
    
    <div class="node-body">
      <div class="node-label">{{ data.label || '未命名任务' }}</div>
      <div v-if="data.assignee" class="node-meta">
        <span class="meta-icon">👤</span>
        <span class="meta-text">{{ data.assignee }}</span>
      </div>
      <div v-if="data.dueDate" class="node-meta">
        <span class="meta-icon">📅</span>
        <span class="meta-text">{{ data.dueDate }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'

defineProps<{
  data: {
    label: string
    color?: string
    assignee?: string
    dueDate?: string
  }
}>()
</script>

<style scoped>
.task-node {
  background: white;
  border: 2px solid #3b82f6;
  border-radius: 8px;
  min-width: 180px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  transition: all 0.2s;
}

.task-node:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

.node-header {
  background: #3b82f6;
  color: white;
  padding: 8px 12px;
  border-radius: 6px 6px 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.node-icon {
  font-size: 16px;
}

.node-type {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.node-body {
  padding: 12px;
}

.node-label {
  font-size: 14px;
  font-weight: 500;
  color: #1f2937;
  margin-bottom: 8px;
}

.node-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
}

.meta-icon {
  font-size: 12px;
}

.meta-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>