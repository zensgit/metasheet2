<template>
  <div class="start-node">
    <Handle type="source" :position="Position.Right" />
    <div class="node-content">
      <div class="node-icon">▶</div>
      <div class="node-label">{{ data.label }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'

defineProps<{
  data: {
    label: string
    color?: string
  }
}>()
</script>

<style scoped>
.start-node {
  background: #22c55e;
  border: 2px solid #16a34a;
  border-radius: 50%;
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  transition: all 0.2s;
}

.start-node:hover {
  transform: scale(1.05);
  box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
}

.node-content {
  text-align: center;
  color: white;
}

.node-icon {
  font-size: 24px;
  margin-bottom: 4px;
}

.node-label {
  font-size: 12px;
  font-weight: 600;
}
</style>