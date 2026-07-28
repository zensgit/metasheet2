<template>
  <div class="template-authoring__canvas-workspace" data-testid="approval-canvas-workspace">
    <div class="template-authoring__canvas-main">
      <el-alert
        v-if="canvasValidity.length"
        type="warning"
        :closable="false"
        show-icon
        data-testid="approval-canvas-validity"
        title="画布结构校验（保存时后端为最终判定）"
      >
        <ul class="template-authoring__error-list"><li v-for="issue in canvasValidity" :key="issue">{{ issue }}</li></ul>
      </el-alert>
      <div class="template-authoring__canvas-toolbar" data-testid="approval-canvas-toolbar">
        <el-button-group>
          <el-button :icon="ZoomOut" title="缩小画布" aria-label="缩小画布" data-testid="approval-canvas-zoom-out" @click="emit('zoom-out')" />
          <el-button
            class="template-authoring__canvas-zoom-label"
            aria-label="重置画布缩放为 100%"
            data-testid="approval-canvas-zoom-label"
            @click="emit('zoom-reset')"
          >
            {{ canvasZoomLabel }}
          </el-button>
          <el-button :icon="ZoomIn" title="放大画布" aria-label="放大画布" data-testid="approval-canvas-zoom-in" @click="emit('zoom-in')" />
        </el-button-group>
        <el-button :icon="FullScreen" data-testid="approval-canvas-fit" @click="emit('fit')">适应画布</el-button>
      </div>
      <div class="template-authoring__canvas-viewport-shell">
        <div
          ref="canvasViewportRef"
          class="template-authoring__canvas-viewport"
          role="region"
          aria-label="审批流程画布"
          tabindex="0"
          @scroll="emit('viewport-scroll')"
        >
          <div class="template-authoring__canvas-stage" :style="canvasStageCss">
            <div
              class="template-authoring__canvas"
              data-testid="approval-graph-canvas"
              :style="canvasSurfaceCss"
            >
              <svg class="template-authoring__canvas-edges" :width="canvasLayout.width" :height="canvasLayout.height">
                <defs>
                  <marker id="approval-canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                    <path d="M0,0 L7,3 L0,6 Z" fill="#bbb" />
                  </marker>
                </defs>
                <path
                  v-for="line in canvasEdgeLines"
                  :key="line.key"
                  :d="line.path"
                  stroke="#bbb"
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
                @drop="onMoveTargetDrop($event, line.key)"
              >
                <el-icon><Rank /></el-icon>
                <span>移到这里</span>
              </button>
              <div
                v-for="pos in canvasLayout.nodes"
                :key="pos.key"
                class="template-authoring__canvas-node"
                :class="{ 'is-selected': selectedCanvasNode === pos.key, 'is-moving': movingCanvasNode === pos.key }"
                :style="{ position: 'absolute', left: pos.x + 'px', top: pos.y + 'px', width: nodeWidth + 'px' }"
                :data-canvas-node="pos.key"
                data-testid="approval-canvas-node"
                :draggable="!readOnly && canMoveCanvasNode(pos.key)"
                @click="emit('select-node', pos.key)"
                @dragstart="emit('node-drag-start', $event, pos.key)"
                @dragend="emit('node-drag-end')"
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
                  <span class="template-authoring__node-type" :data-node-type="canvasNodeByKey(pos.key)?.type">
                    {{ nodeTypeLabel(canvasNodeByKey(pos.key)?.type ?? 'approval') }}
                  </span>
                </div>
                <div v-if="!readOnly" class="template-authoring__canvas-node-actions">
                  <template v-if="canMoveCanvasNode(pos.key)">
                    <el-button
                      :icon="Top"
                      size="small"
                      title="上移节点"
                      :aria-label="`上移${graphNodeLabel(pos.key)}`"
                      :disabled="!canvasStepMoveTarget(pos.key, 'up')"
                      :data-testid="`approval-canvas-move-up-${pos.key}`"
                      @click.stop="emit('move-step', pos.key, 'up')"
                    />
                    <el-button
                      :icon="Bottom"
                      size="small"
                      title="下移节点"
                      :aria-label="`下移${graphNodeLabel(pos.key)}`"
                      :disabled="!canvasStepMoveTarget(pos.key, 'down')"
                      :data-testid="`approval-canvas-move-down-${pos.key}`"
                      @click.stop="emit('move-step', pos.key, 'down')"
                    />
                    <el-button
                      :icon="Rank"
                      size="small"
                      title="移动节点"
                      :aria-label="`选择${graphNodeLabel(pos.key)}的移动位置`"
                      :type="movingCanvasNode === pos.key ? 'primary' : undefined"
                      :data-testid="`approval-canvas-move-${pos.key}`"
                      @click.stop="emit('begin-move', pos.key)"
                    />
                  </template>
                  <el-button v-if="canvasNodeByKey(pos.key)?.type === 'condition'" size="small" :data-testid="`approval-canvas-add-condition-${pos.key}`" @click.stop="emit('add-condition-branch', pos.key)">+条件分支</el-button>
                  <el-button v-if="canvasNodeByKey(pos.key)?.type === 'parallel'" size="small" :data-testid="`approval-canvas-add-parallel-${pos.key}`" @click.stop="emit('add-parallel-branch', pos.key)">+并行分支</el-button>
                  <template v-if="canInsertAfter(canvasNodeByKey(pos.key)!)">
                    <el-button size="small" :data-testid="`approval-canvas-insert-${pos.key}`" @click.stop="emit('insert-approval-after', pos.key)">+审批</el-button>
                    <el-button size="small" :data-testid="`approval-canvas-insert-condition-${pos.key}`" @click.stop="emit('insert-condition-after', pos.key)">+条件</el-button>
                    <!-- F4: no +并行 inside a parallel branch — the backend rejects nested parallel. -->
                    <el-button v-if="canInsertParallelAfter(canvasNodeByKey(pos.key)!)" size="small" :data-testid="`approval-canvas-insert-parallel-${pos.key}`" @click.stop="emit('insert-parallel-after', pos.key)">+并行</el-button>
                  </template>
                  <el-button v-if="canRemoveNode(canvasNodeByKey(pos.key)!)" size="small" type="danger" :data-testid="`approval-canvas-remove-${pos.key}`" @click.stop="emit('remove-node', pos.key)">删除</el-button>
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
      <p class="template-authoring__hint">画布用于编排结构（增删节点 / 分支、拖动布局）。点击节点在右侧检查器编辑配置；也可切换「结构列表」。</p>
    </div>
    <aside
      v-if="selectedCanvasInspectorNode"
      ref="canvasInspectorRef"
      class="template-authoring__canvas-inspector"
      data-testid="approval-canvas-inspector"
      :data-inspector-node="selectedCanvasInspectorNode.key"
      :data-inspector-type="selectedCanvasInspectorNode.type"
    >
      <div class="template-authoring__canvas-inspector-header">
        <div class="template-authoring__canvas-inspector-title">
          <strong>{{ graphNodeLabel(selectedCanvasInspectorNode.key) }}</strong>
          <span class="template-authoring__node-type" :data-node-type="selectedCanvasInspectorNode.type">
            {{ nodeTypeLabel(selectedCanvasInspectorNode.type) }}
          </span>
        </div>
        <el-button
          text
          size="small"
          data-testid="approval-canvas-inspector-close"
          @click="emit('close-inspector')"
        >关闭</el-button>
      </div>
      <div class="template-authoring__canvas-inspector-body">
        <ApprovalGraphNodeConfigEditor :node="selectedCanvasInspectorNode" />
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Bottom, FullScreen, Rank, Top, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import type { ApprovalNode } from '../../types/approval'
import type { GraphLayout } from '../graphLayout'
import type { MinimapFrame } from '../canvasViewport'
import ApprovalGraphNodeConfigEditor from './ApprovalGraphNodeConfigEditor.vue'

/**
 * Canvas V2 flow workspace — presentational shell for the D-1/D-5/D-6 canvas (main surface, SVG
 * edges, nodes, edge/move targets, minimap) plus the right-side inspector. TemplateAuthoringView
 * stays the owner of business state (selection, zoom, drag/move) and topology/command handlers;
 * this component only renders derived data (props) and emits intents (events) for the parent to
 * apply through the SAME handlers used before extraction — no graph/topology rule is duplicated
 * here.
 */

interface CanvasEdgeLine {
  key: string
  path: string
  dropX: number
  dropY: number
}

defineProps<{
  readOnly: boolean
  canvasValidity: string[]
  canvasZoomLabel: string
  canvasStageCss: Record<string, string>
  canvasSurfaceCss: Record<string, string>
  canvasLayout: GraphLayout
  canvasEdgeLines: CanvasEdgeLine[]
  canvasMoveTargetLines: CanvasEdgeLine[]
  canvasMinimap: MinimapFrame
  selectedCanvasNode: string | null
  movingCanvasNode: string | null
  selectedCanvasInspectorNode: ApprovalNode | null
  nodeWidth: number
  nodeHeight: number
  minimapWidth: number
  minimapHeight: number
  graphNodeLabel: (nodeKey: string) => string
  nodeTypeLabel: (type: string) => string
  canvasNodeByKey: (key: string) => ApprovalNode | undefined
  canMoveCanvasNode: (nodeKey: string) => boolean
  canvasStepMoveTarget: (nodeKey: string, direction: 'up' | 'down') => string | undefined
  canvasMoveTargetLabel: (edgeKey: string) => string
  canInsertAfter: (node: ApprovalNode) => boolean
  canInsertParallelAfter: (node: ApprovalNode) => boolean
  canRemoveNode: (node: ApprovalNode) => boolean
}>()

const emit = defineEmits<{
  (e: 'zoom-out'): void
  (e: 'zoom-in'): void
  (e: 'zoom-reset'): void
  (e: 'fit'): void
  (e: 'viewport-scroll'): void
  (e: 'select-node', nodeKey: string): void
  (e: 'close-inspector'): void
  (e: 'node-keydown', event: KeyboardEvent, nodeKey: string): void
  (e: 'node-drag-start', event: DragEvent, nodeKey: string): void
  (e: 'node-drag-end'): void
  (e: 'move-target-click', edgeKey: string): void
  (e: 'move-step', nodeKey: string, direction: 'up' | 'down'): void
  (e: 'begin-move', nodeKey: string): void
  (e: 'add-condition-branch', nodeKey: string): void
  (e: 'add-parallel-branch', nodeKey: string): void
  (e: 'insert-approval-after', nodeKey: string): void
  (e: 'insert-condition-after', nodeKey: string): void
  (e: 'insert-parallel-after', nodeKey: string): void
  (e: 'remove-node', nodeKey: string): void
}>()

function onMoveTargetDrop(event: DragEvent, edgeKey: string): void {
  event.preventDefault()
  event.stopPropagation()
  emit('move-target-click', edgeKey)
}

// Exposed for the parent to read/measure (fit-to-viewport, scroll sync, mobile inspector scroll)
// — the parent owns that logic since it also owns the zoom/viewport-state it computes from these.
const canvasViewportRef = ref<HTMLElement | null>(null)
const canvasInspectorRef = ref<HTMLElement | null>(null)

defineExpose({ canvasViewportRef, canvasInspectorRef })
</script>

<style scoped>
.template-authoring__canvas-workspace {
  display: flex;
  align-items: stretch;
  gap: 12px;
  min-width: 0;
  width: 100%;
}
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
.template-authoring__canvas-node-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
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
@media (max-width: 560px) {
  .template-authoring__canvas-minimap {
    display: none;
  }
}
.template-authoring__canvas-inspector {
  /* ~400px so ms-w-360 controls fit with body padding; stacks to 100% under 960px. */
  flex: 0 0 400px;
  width: 400px;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  background: var(--el-bg-color);
  display: flex;
  flex-direction: column;
  max-height: min(70vh, 720px);
  overflow: hidden;
  scroll-margin-top: 164px;
}
.template-authoring__canvas-inspector-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--el-border-color-light);
}
.template-authoring__canvas-inspector-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 13px;
}
.template-authoring__canvas-inspector-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 14px;
}
@media (max-width: 960px) {
  .template-authoring__canvas-workspace {
    flex-direction: column;
  }
  .template-authoring__canvas-inspector {
    flex: 1 1 auto;
    width: 100%;
    max-height: none;
  }
}

/* Shared with the parent (list view rows / validation summary carry their own copies of these —
   Vue scoped CSS cannot reach across the component boundary once this markup moved here). */
.template-authoring__hint {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.template-authoring__node-type {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
}
.template-authoring__error-list {
  margin: 6px 0 0;
  padding-left: 20px;
}
</style>
