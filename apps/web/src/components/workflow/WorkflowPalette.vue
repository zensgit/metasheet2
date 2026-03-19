<template>
  <div class="tool-palette">
    <div class="palette-section">
      <div class="section-title">事件</div>
      <div
        v-for="item in eventElements"
        :key="item.type"
        class="palette-item"
        draggable="true"
        @dragstart="$emit('drag-start', $event, item)"
      >
        <div class="item-icon" :style="{ backgroundColor: item.color }">
          <component :is="item.icon" />
        </div>
        <span class="item-label">{{ item.label }}</span>
      </div>
    </div>
    <div class="palette-section">
      <div class="section-title">任务</div>
      <div
        v-for="item in taskElements"
        :key="item.type"
        class="palette-item"
        draggable="true"
        @dragstart="$emit('drag-start', $event, item)"
      >
        <div class="item-icon" :style="{ backgroundColor: item.color }">
          <component :is="item.icon" />
        </div>
        <span class="item-label">{{ item.label }}</span>
      </div>
    </div>
    <div class="palette-section">
      <div class="section-title">网关</div>
      <div
        v-for="item in gatewayElements"
        :key="item.type"
        class="palette-item"
        draggable="true"
        @dragstart="$emit('drag-start', $event, item)"
      >
        <div class="item-icon" :style="{ backgroundColor: item.color }">
          <component :is="item.icon" />
        </div>
        <span class="item-label">{{ item.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
type PaletteItem = {
  type: string
  label: string
  icon: any
  color: string
}

defineProps<{
  eventElements: PaletteItem[]
  taskElements: PaletteItem[]
  gatewayElements: PaletteItem[]
}>()

defineEmits<{
  (event: 'drag-start', dragEvent: DragEvent, item: any): void
}>()
</script>

<style scoped>
.tool-palette {
  width: 220px;
  background: #fff;
  border-right: 1px solid #e4e7ed;
  padding: 20px;
  overflow-y: auto;
}

.palette-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 12px;
  text-transform: uppercase;
}

.palette-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  margin-bottom: 8px;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  cursor: grab;
  transition: all 0.2s;
}

.palette-item:hover {
  background: #ecf5ff;
  border-color: #409eff;
  transform: translateX(4px);
}

.palette-item:active {
  cursor: grabbing;
}

.item-icon {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  flex-shrink: 0;
}

.item-label {
  font-size: 14px;
  color: #303133;
}
</style>
