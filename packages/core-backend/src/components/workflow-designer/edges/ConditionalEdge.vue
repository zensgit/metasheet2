<template>
  <g>
    <BaseEdge
      :id="id"
      :path="path"
      :marker-end="markerEnd"
      :style="style"
    />
    <EdgeLabelRenderer>
      <div
        :style="{
          position: 'absolute',
          transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          pointerEvents: 'all'
        }"
        class="edge-label"
      >
        <div class="label-content" @click="onLabelClick">
          {{ data?.label || condition || 'Condition' }}
        </div>
        <button @click.stop="onEditClick" class="edit-btn">✏️</button>
      </div>
    </EdgeLabelRenderer>
  </g>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@vue-flow/core'

const props = defineProps<{
  id: string
  sourceX: number
  sourceY: number
  targetX: number
  targetY: number
  sourcePosition: any
  targetPosition: any
  data?: {
    label?: string
    condition?: string
    color?: string
  }
  markerEnd?: string
  style?: any
}>()

const emit = defineEmits<{
  labelClick: []
  editClick: []
}>()

const [path, labelX, labelY] = getBezierPath({
  sourceX: props.sourceX,
  sourceY: props.sourceY,
  sourcePosition: props.sourcePosition,
  targetX: props.targetX,
  targetY: props.targetY,
  targetPosition: props.targetPosition
})

const condition = computed(() => props.data?.condition || '')

const onLabelClick = () => {
  emit('labelClick')
}

const onEditClick = () => {
  emit('editClick')
}
</script>

<style scoped>
.edge-label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.label-content {
  background: white;
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 12px;
  color: #374151;
  cursor: pointer;
  transition: all 0.2s;
}

.label-content:hover {
  background: #f3f4f6;
  border-color: #3b82f6;
}

.edit-btn {
  width: 20px;
  height: 20px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: white;
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.edit-btn:hover {
  background: #f3f4f6;
  border-color: #3b82f6;
}
</style>