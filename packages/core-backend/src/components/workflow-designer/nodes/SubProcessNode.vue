<template>
  <div class="subprocess-node" :style="{ borderColor: data.color }">
    <Handle type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" />
    
    <div class="node-header" :style="{ backgroundColor: data.color }">
      <div class="node-icon">📁</div>
      <div class="node-type">子流程</div>
    </div>
    
    <div class="node-body">
      <div class="node-label">{{ data.label || '未命名子流程' }}</div>
      <div v-if="data.subprocess" class="subprocess-ref">
        <span class="ref-icon">🔗</span>
        <span class="ref-text">{{ data.subprocess }}</span>
      </div>
      <div class="subprocess-indicator">
        <div class="mini-box"></div>
        <div class="mini-box"></div>
        <div class="mini-box"></div>
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
    subprocess?: string
  }
}>()
</script>

<style scoped>
.subprocess-node {
  background: white;
  border: 3px double #8b5cf6;
  border-radius: 8px;
  min-width: 200px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  transition: all 0.2s;
}

.subprocess-node:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

.node-header {
  background: #8b5cf6;
  color: white;
  padding: 8px 12px;
  border-radius: 5px 5px 0 0;
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

.subprocess-ref {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #6b7280;
  margin-top: 4px;
  padding: 4px 8px;
  background: #f3f4f6;
  border-radius: 4px;
}

.ref-icon {
  font-size: 12px;
}

.ref-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subprocess-indicator {
  display: flex;
  gap: 4px;
  margin-top: 8px;
  justify-content: center;
}

.mini-box {
  width: 20px;
  height: 20px;
  border: 1px solid #d1d5db;
  border-radius: 2px;
  background: #f9fafb;
}
</style>