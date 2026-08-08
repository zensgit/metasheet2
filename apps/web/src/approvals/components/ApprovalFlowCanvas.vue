<script setup lang="ts">
/**
 * Canvas V2 flow surface (PR4 extract) — pure presentation.
 * Parent owns draft/history and all topology/command mutations.
 */
import { FullScreen, Rank, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import { ref, type CSSProperties } from 'vue'
import type { ApprovalNode } from '../../types/approval'
import type { GraphLayout, NodeLayout } from '../graphLayout'

export interface CanvasEdgeLine {
  key: string
  path: string
  dropX: number
  dropY: number
}

export interface CanvasMinimapFrame {
  offsetX: number
  offsetY: number
  scale: number
  viewport: { x: number; y: number; width: number; height: number }
}

const props = defineProps<{
  readOnly: boolean
  canvasValidity: string[]
  canUndo: boolean
  canRedo: boolean
  canvasZoomLabel: string
  /** Avoid attr names ending in `-style=` (UF-6 static style= false positive). */
  canvasStageCss: CSSProperties
  canvasSurfaceCss: CSSProperties
  canvasLayout: GraphLayout
  canvasEdgeLines: CanvasEdgeLine[]
  canvasMoveTargetLines: CanvasEdgeLine[]
  selectedCanvasNode: string | null
  movingCanvasNode: string | null
  edgeInsertMenuEdgeKey: string | null
  canvasMinimap: CanvasMinimapFrame
  nodeWidth: number
  nodeHeight: number
  minimapWidth: number
  minimapHeight: number
  graphNodeLabel: (nodeKey: string) => string
  nodeTypeLabel: (type: string) => string
  canvasNodeByKey: (nodeKey: string) => ApprovalNode | undefined
  canMoveCanvasNode: (nodeKey: string) => boolean
  canInsertParallelOnEdge: (edgeKey: string) => boolean
  canvasMoveTargetLabel: (edgeKey: string) => string
}>()

const emit = defineEmits<{
  undo: []
  redo: []
  'zoom-out': []
  'zoom-in': []
  'zoom-reset': []
  fit: []
  scroll: []
  'select-node': [nodeKey: string]
  'node-keydown': [event: KeyboardEvent, nodeKey: string]
  'drag-start': [event: DragEvent, nodeKey: string]
  'drag-end': []
  'move-target-click': [edgeKey: string]
  drop: [event: DragEvent, edgeKey: string]
  'toggle-edge-insert': [edgeKey: string]
  'edge-insert-approval': [edgeKey: string]
  'edge-insert-condition': [edgeKey: string]
  'edge-insert-parallel': [edgeKey: string]
}>()

const canvasViewportRef = ref<HTMLElement | null>(null)

function onViewportScroll(): void {
  emit('scroll')
}

defineExpose({
  getViewportEl: (): HTMLElement | null => canvasViewportRef.value,
})

function nodePosStyle(pos: NodeLayout): CSSProperties {
  return {
    position: 'absolute',
    left: `${pos.x}px`,
    top: `${pos.y}px`,
    width: `${props.nodeWidth}px`,
  }
}
</script>

<template>
  <div class="template-authoring__canvas-main">
    <el-alert
      v-if="canvasValidity.length"
      type="warning"
      :closable="false"
      show-icon
      data-testid="approval-canvas-validity"
      title="画布结构校验（保存时后端为最终判定）"
    >
      <ul class="template-authoring__error-list">
        <li v-for="issue in canvasValidity" :key="issue">{{ issue }}</li>
      </ul>
    </el-alert>
    <div class="template-authoring__canvas-toolbar" data-testid="approval-canvas-toolbar">
      <el-button-group>
        <el-button
          :disabled="readOnly || !canUndo"
          title="撤销"
          aria-label="撤销"
          data-testid="approval-canvas-undo"
          @click="emit('undo')"
        >
          撤销
        </el-button>
        <el-button
          :disabled="readOnly || !canRedo"
          title="重做"
          aria-label="重做"
          data-testid="approval-canvas-redo"
          @click="emit('redo')"
        >
          重做
        </el-button>
      </el-button-group>
      <el-button-group>
        <el-button
          :icon="ZoomOut"
          title="缩小画布"
          aria-label="缩小画布"
          data-testid="approval-canvas-zoom-out"
          @click="emit('zoom-out')"
        />
        <el-button
          class="template-authoring__canvas-zoom-label"
          aria-label="重置画布缩放为 100%"
          data-testid="approval-canvas-zoom-label"
          @click="emit('zoom-reset')"
        >
          {{ canvasZoomLabel }}
        </el-button>
        <el-button
          :icon="ZoomIn"
          title="放大画布"
          aria-label="放大画布"
          data-testid="approval-canvas-zoom-in"
          @click="emit('zoom-in')"
        />
      </el-button-group>
      <el-button :icon="FullScreen" data-testid="approval-canvas-fit" @click="emit('fit')">
        适应画布
      </el-button>
    </div>
    <div class="template-authoring__canvas-viewport-shell">
      <div
        ref="canvasViewportRef"
        class="template-authoring__canvas-viewport"
        role="region"
        aria-label="审批流程画布"
        tabindex="0"
        @scroll="onViewportScroll"
      >
        <div class="template-authoring__canvas-stage" :style="canvasStageCss">
          <div
            class="template-authoring__canvas"
            data-testid="approval-graph-canvas"
            :style="canvasSurfaceCss"
          >
            <svg
              class="template-authoring__canvas-edges"
              :width="canvasLayout.width"
              :height="canvasLayout.height"
            >
              <defs>
                <marker id="approval-canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                  <path d="M0,0 L7,3 L0,6 Z" fill="var(--el-border-color-darker)" />
                </marker>
              </defs>
              <path
                v-for="line in canvasEdgeLines"
                :key="line.key"
                :d="line.path"
                stroke="var(--el-border-color-darker)"
                stroke-width="1.5"
                fill="none"
                marker-end="url(#approval-canvas-arrow)"
                data-testid="approval-canvas-edge"
              />
            </svg>
            <button
              v-for="line in canvasMoveTargetLines"
              :key="`move-target-${line.key}`"
              type="button"
              class="template-authoring__canvas-move-target"
              :style="{ left: `${line.dropX}px`, top: `${line.dropY}px` }"
              :aria-label="canvasMoveTargetLabel(line.key)"
              :data-testid="`approval-canvas-move-target-${line.key}`"
              @click.stop="emit('move-target-click', line.key)"
              @dragover.prevent
              @drop="emit('drop', $event, line.key)"
            >
              <el-icon><Rank /></el-icon>
              <span>移到这里</span>
            </button>
            <div
              v-for="line in canvasEdgeLines"
              v-show="!readOnly && !movingCanvasNode"
              :key="`edge-insert-${line.key}`"
              class="template-authoring__canvas-edge-insert"
              :class="{ 'is-open': edgeInsertMenuEdgeKey === line.key }"
              :style="{ left: `${line.dropX}px`, top: `${line.dropY}px` }"
              data-testid="approval-canvas-edge-insert"
              :data-edge-key="line.key"
            >
              <button
                type="button"
                class="template-authoring__canvas-edge-insert-btn"
                aria-label="在此连线插入节点"
                title="在此连线插入节点"
                :aria-expanded="edgeInsertMenuEdgeKey === line.key"
                :data-testid="`approval-canvas-edge-insert-${line.key}`"
                @click.stop="emit('toggle-edge-insert', line.key)"
              >
                +
              </button>
              <div
                v-if="edgeInsertMenuEdgeKey === line.key"
                class="template-authoring__canvas-edge-insert-menu"
                role="menu"
                data-testid="approval-canvas-edge-insert-menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid="approval-canvas-edge-insert-approval"
                  @click.stop="emit('edge-insert-approval', line.key)"
                >
                  审批
                </button>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="approval-canvas-edge-insert-condition"
                  @click.stop="emit('edge-insert-condition', line.key)"
                >
                  条件
                </button>
                <button
                  v-if="canInsertParallelOnEdge(line.key)"
                  type="button"
                  role="menuitem"
                  data-testid="approval-canvas-edge-insert-parallel"
                  @click.stop="emit('edge-insert-parallel', line.key)"
                >
                  并行
                </button>
              </div>
            </div>
            <div
              v-for="pos in canvasLayout.nodes"
              :key="pos.key"
              class="template-authoring__canvas-node"
              :class="{
                'is-selected': selectedCanvasNode === pos.key,
                'is-moving': movingCanvasNode === pos.key,
              }"
              :style="nodePosStyle(pos)"
              :data-canvas-node="pos.key"
              data-testid="approval-canvas-node"
              :draggable="!readOnly && canMoveCanvasNode(pos.key)"
              @click="emit('select-node', pos.key)"
              @dragstart="emit('drag-start', $event, pos.key)"
              @dragend="emit('drag-end')"
            >
              <div
                class="template-authoring__canvas-node-selector"
                role="button"
                tabindex="0"
                :aria-label="`编辑${graphNodeLabel(pos.key)}节点`"
                :aria-pressed="selectedCanvasNode === pos.key"
                data-testid="approval-canvas-node-select"
                @click.stop="emit('select-node', pos.key)"
                @keydown.enter.stop.prevent="emit('select-node', pos.key)"
                @keydown.space.stop.prevent="emit('select-node', pos.key)"
                @keydown="emit('node-keydown', $event, pos.key)"
              >
                <strong>{{ graphNodeLabel(pos.key) }}</strong>
                <span
                  class="template-authoring__node-type"
                  :data-node-type="canvasNodeByKey(pos.key)?.type"
                >
                  {{ nodeTypeLabel(canvasNodeByKey(pos.key)?.type ?? 'approval') }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <svg
        class="template-authoring__canvas-minimap"
        :width="minimapWidth"
        :height="minimapHeight"
        :viewBox="`0 0 ${minimapWidth} ${minimapHeight}`"
        role="img"
        aria-label="画布缩略导航"
        data-testid="approval-canvas-minimap"
      >
        <g :transform="`translate(${canvasMinimap.offsetX} ${canvasMinimap.offsetY}) scale(${canvasMinimap.scale})`">
          <path
            v-for="line in canvasEdgeLines"
            :key="`minimap-${line.key}`"
            :d="line.path"
            class="template-authoring__canvas-minimap-edge"
          />
          <rect
            v-for="pos in canvasLayout.nodes"
            :key="`minimap-${pos.key}`"
            :x="pos.x"
            :y="pos.y"
            :width="nodeWidth"
            :height="nodeHeight"
            rx="6"
            class="template-authoring__canvas-minimap-node"
          />
        </g>
        <rect
          :x="canvasMinimap.viewport.x"
          :y="canvasMinimap.viewport.y"
          :width="canvasMinimap.viewport.width"
          :height="canvasMinimap.viewport.height"
          class="template-authoring__canvas-minimap-window"
          data-testid="approval-canvas-minimap-window"
        />
      </svg>
    </div>
    <p class="template-authoring__hint">
      在连线上点「+」插入节点；选中节点后在右侧检查器配置与结构调整。Alt+↑/↓ 语义重排。辅助编辑模式保留完整结构列表。
    </p>
  </div>
</template>

<style scoped>
.template-authoring__canvas-main {
  flex: 1 1 auto;
  min-width: 0;
}
.template-authoring__canvas-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-height: 32px;
  margin-bottom: 8px;
}
.template-authoring__canvas-zoom-label {
  min-width: 58px;
  font-variant-numeric: tabular-nums;
}
.template-authoring__canvas-viewport-shell {
  position: relative;
  min-width: 0;
}
.template-authoring__canvas-viewport {
  min-height: 360px;
  max-height: min(66vh, 720px);
  max-width: 100%;
  overflow: auto;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--ms-bg-page);
}
.template-authoring__canvas-viewport:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: 2px;
}
.template-authoring__canvas-stage {
  position: relative;
  min-width: 1px;
  min-height: 1px;
}
.template-authoring__canvas {
  position: relative;
  background: var(--ms-bg-page);
  min-height: 200px;
}
.template-authoring__canvas-edges {
  position: absolute;
  left: 0;
  top: 0;
}
.template-authoring__canvas-node {
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--ms-bg-card);
  box-shadow: var(--el-box-shadow-lighter);
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: default;
  font-size: 12px;
  min-height: 96px;
}
.template-authoring__canvas-node[draggable='true'] {
  cursor: grab;
}
.template-authoring__canvas-node.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-5);
}
.template-authoring__canvas-node.is-moving {
  border-style: dashed;
  border-color: var(--el-color-primary);
}
.template-authoring__canvas-node-selector {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  border-radius: 4px;
  cursor: pointer;
  outline: none;
}
.template-authoring__canvas-node-selector:focus-visible {
  box-shadow: 0 0 0 2px var(--el-color-primary-light-5);
}
.template-authoring__canvas-edge-insert {
  position: absolute;
  z-index: 4;
  transform: translate(-50%, -50%);
}
.template-authoring__canvas-edge-insert-btn {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--el-color-primary);
  background: var(--ms-bg-card);
  color: var(--el-color-primary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.template-authoring__canvas-edge-insert-btn:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.template-authoring__canvas-edge-insert-menu {
  position: absolute;
  top: 26px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 72px;
  padding: 4px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--ms-bg-card);
  box-shadow: var(--el-box-shadow-lighter);
}
.template-authoring__canvas-edge-insert-menu button {
  border: 0;
  background: transparent;
  padding: 4px 8px;
  text-align: left;
  cursor: pointer;
  font-size: 12px;
  border-radius: 4px;
}
.template-authoring__canvas-edge-insert-menu button:hover,
.template-authoring__canvas-edge-insert-menu button:focus-visible {
  background: var(--el-fill-color-light);
}
.template-authoring__canvas-move-target {
  position: absolute;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 4px 8px;
  border: 1px dashed var(--el-color-primary);
  border-radius: 6px;
  color: var(--el-color-primary);
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-lighter);
  transform: translate(-50%, -50%);
  cursor: pointer;
  font-size: 12px;
}
.template-authoring__canvas-move-target:hover,
.template-authoring__canvas-move-target:focus-visible {
  border-style: solid;
  background: var(--el-color-primary-light-9);
  outline: none;
}
.template-authoring__canvas-minimap {
  position: absolute;
  right: 12px;
  bottom: 12px;
  box-sizing: border-box;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: color-mix(in srgb, var(--el-bg-color) 94%, transparent);
  box-shadow: var(--el-box-shadow-lighter);
  pointer-events: none;
}
.template-authoring__canvas-minimap-edge {
  fill: none;
  stroke: var(--el-border-color-darker);
  stroke-width: 5;
}
.template-authoring__canvas-minimap-node {
  fill: var(--el-fill-color-light);
  stroke: var(--el-border-color-darker);
  stroke-width: 4;
}
.template-authoring__canvas-minimap-window {
  fill: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
  stroke: var(--el-color-primary);
  stroke-width: 1.5;
}
.template-authoring__error-list {
  margin: 0;
  padding-left: 18px;
}
.template-authoring__hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.template-authoring__node-type {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
@media (max-width: 560px) {
  .template-authoring__canvas-minimap {
    display: none;
  }
}
</style>
