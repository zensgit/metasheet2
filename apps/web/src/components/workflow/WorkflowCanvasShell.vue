<template>
  <div ref="containerEl" class="canvas-container">
    <div ref="canvasEl" class="bpmn-canvas"></div>
    <div v-if="isDragging" class="drop-zone" @dragover.prevent @drop="$emit('drop', $event)">
      拖放元素到此处
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  isDragging: boolean
}>()

defineEmits<{
  (event: 'drop', dragEvent: DragEvent): void
}>()

const containerEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLElement | null>(null)

defineExpose({
  containerEl,
  canvasEl,
})
</script>

<style scoped>
.canvas-container {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: #fafafa;
}

.bpmn-canvas {
  width: 100%;
  height: 100%;
}

.drop-zone {
  position: absolute;
  inset: 20px;
  border: 2px dashed #409eff;
  border-radius: 12px;
  background: rgba(64, 158, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: #409eff;
  pointer-events: all;
  z-index: 20;
}
</style>
