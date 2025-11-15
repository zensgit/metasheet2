<template>
  <div class="gateway-node" :style="{ borderColor: data.color }">
    <Handle type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" :id="'yes'" :style="{ top: '30%' }" />
    <Handle type="source" :position="Position.Right" :id="'no'" :style="{ top: '70%' }" />
    
    <div class="node-diamond" :style="{ backgroundColor: data.color }">
      <div class="diamond-content">
        <div class="node-icon">◆</div>
      </div>
    </div>
    
    <div class="node-label">{{ data.label }}</div>
    <div v-if="data.condition" class="node-condition">
      {{ data.condition }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'

defineProps<{
  data: {
    label: string
    color?: string
    condition?: string
  }
}>()
</script>

<style scoped>
.gateway-node {
  position: relative;
  width: 120px;
  height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.node-diamond {
  width: 60px;
  height: 60px;
  background: #f59e0b;
  transform: rotate(45deg);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid #d97706;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.diamond-content {
  transform: rotate(-45deg);
  color: white;
}

.node-icon {
  font-size: 24px;
}

.node-label {
  position: absolute;
  bottom: -20px;
  font-size: 12px;
  font-weight: 600;
  color: #1f2937;
  white-space: nowrap;
}

.node-condition {
  position: absolute;
  top: -20px;
  font-size: 10px;
  color: #6b7280;
  background: white;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid #e5e7eb;
  white-space: nowrap;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gateway-node:hover .node-diamond {
  transform: rotate(45deg) scale(1.1);
}
</style>