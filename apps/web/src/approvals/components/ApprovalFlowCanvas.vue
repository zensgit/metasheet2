<template>
  <div ref="workspaceRef" class="template-authoring__canvas-workspace" data-testid="approval-canvas-workspace">
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
              <div
                v-for="target in canvasInsertionTargets"
                v-show="!readOnly && movingCanvasNode === null"
                :key="`insert-target-${target.edgeKey}`"
                class="template-authoring__canvas-insert-target"
                :style="{ left: `${target.insertX}px`, top: `${target.insertY}px` }"
              >
                <button
                  type="button"
                  class="template-authoring__canvas-insert-trigger"
                  :aria-label="target.label"
                  :aria-expanded="activeInsertionEdgeKey === target.edgeKey"
                  aria-haspopup="menu"
                  :data-testid="`approval-canvas-edge-insert-${target.edgeKey}`"
                  @click.stop="toggleInsertionMenu(target.edgeKey, $event)"
                  @keydown.esc.stop.prevent="closeInsertionMenu(target.edgeKey)"
                >
                  <el-icon><Plus /></el-icon>
                </button>
                <div
                  v-if="activeInsertionTarget?.edgeKey === target.edgeKey"
                  class="template-authoring__canvas-insert-menu"
                  role="menu"
                  :aria-label="target.label"
                  data-active-insertion-menu
                  :data-testid="`approval-canvas-edge-menu-${target.edgeKey}`"
                  @keydown.esc.stop.prevent="closeInsertionMenu(target.edgeKey)"
                >
                  <button
                    v-for="nodeType in target.nodeTypes"
                    :key="nodeType"
                    type="button"
                    role="menuitem"
                    class="template-authoring__canvas-insert-option"
                    :data-testid="`approval-canvas-edge-option-${target.edgeKey}-${nodeType}`"
                    @click.stop="chooseInsertion(target.edgeKey, nodeType)"
                  >
                    {{ nodeTypeLabel(nodeType) }}
                  </button>
                </div>
              </div>
              <button
                v-for="line in canvasMoveTargetLines"
                v-show="!readOnly"
                :key="`move-target-${line.key}`"
                type="button"
                class="template-authoring__canvas-move-target is-drag-active"
                :style="{ left: `${line.dropX}px`, top: `${line.dropY}px` }"
                :aria-label="canvasMoveTargetLabel(line.key)"
                data-drag-active="true"
                :data-testid="`approval-canvas-move-target-${line.key}`"
                @click.stop="emit('move-target-click', line.key)"
                @dragover.stop.prevent
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
      <p class="template-authoring__hint">画布用于编排结构（增删节点 / 分支、拖动布局）。点击节点在右侧检查器编辑配置；也可切换「辅助编辑模式」。</p>
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
        <section
          v-if="!readOnly && selectedCanvasBranchGroup"
          class="template-authoring__canvas-branch-reorder"
          :aria-label="selectedCanvasBranchGroup.title"
          data-testid="approval-canvas-branch-reorder"
        >
          <strong>{{ selectedCanvasBranchGroup.title }}</strong>
          <div
            v-for="(branch, branchIndex) in selectedCanvasBranchGroup.branches"
            :key="branch.edgeKey"
            class="template-authoring__canvas-branch-row"
            :class="{ 'is-dragging': draggingCanvasBranchEdgeKey === branch.edgeKey }"
            :data-testid="`approval-canvas-branch-row-${branch.edgeKey}`"
            @dragover.stop.prevent
            @drop="onBranchTargetDrop($event, branch.edgeKey)"
          >
            <button
              type="button"
              class="template-authoring__canvas-branch-handle"
              :draggable="selectedCanvasBranchGroup.branches.length > 1"
              :title="`拖动${branch.label}`"
              :aria-label="`拖动${branch.label}`"
              :data-testid="`approval-canvas-branch-handle-${branch.edgeKey}`"
              @dragstart.stop="emit('branch-drag-start', $event, selectedCanvasBranchGroup.kind, selectedCanvasBranchGroup.nodeKey, branch.edgeKey)"
              @dragend.stop="emit('branch-drag-end')"
              @keydown.alt.up.stop.prevent="emit('move-branch-step', selectedCanvasBranchGroup.kind, selectedCanvasBranchGroup.nodeKey, branch.edgeKey, 'up')"
              @keydown.alt.down.stop.prevent="emit('move-branch-step', selectedCanvasBranchGroup.kind, selectedCanvasBranchGroup.nodeKey, branch.edgeKey, 'down')"
            >
              <el-icon><Rank /></el-icon>
            </button>
            <span class="template-authoring__canvas-branch-label">{{ branch.label }}</span>
            <div class="template-authoring__canvas-branch-actions">
              <el-button
                :icon="Top"
                size="small"
                title="提高优先级"
                :aria-label="`提高${branch.label}优先级`"
                :disabled="branchIndex === 0"
                :data-testid="`approval-canvas-branch-up-${branch.edgeKey}`"
                @click="emit('move-branch-step', selectedCanvasBranchGroup.kind, selectedCanvasBranchGroup.nodeKey, branch.edgeKey, 'up')"
              />
              <el-button
                :icon="Bottom"
                size="small"
                title="降低优先级"
                :aria-label="`降低${branch.label}优先级`"
                :disabled="branchIndex === selectedCanvasBranchGroup.branches.length - 1"
                :data-testid="`approval-canvas-branch-down-${branch.edgeKey}`"
                @click="emit('move-branch-step', selectedCanvasBranchGroup.kind, selectedCanvasBranchGroup.nodeKey, branch.edgeKey, 'down')"
              />
            </div>
          </div>
        </section>
        <ApprovalGraphNodeConfigEditor :node="selectedCanvasInspectorNode" />
      </div>
    </aside>
    <p
      class="template-authoring__sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="approval-canvas-live-message"
    >{{ canvasLiveMessage }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { Bottom, FullScreen, Plus, Rank, Top, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
import type { ApprovalNode } from '../../types/approval'
import type { GraphLayout } from '../graphLayout'
import type { MinimapFrame } from '../canvasViewport'
import type { EdgeInsertableNodeType } from '../graphTopologyEdit'
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

interface CanvasInsertionTarget {
  edgeKey: string
  insertX: number
  insertY: number
  label: string
  nodeTypes: EdgeInsertableNodeType[]
}

type CanvasBranchKind = 'condition' | 'parallel'

interface CanvasBranchReorderGroup {
  kind: CanvasBranchKind
  nodeKey: string
  title: string
  branches: Array<{ edgeKey: string; label: string }>
}

const props = defineProps<{
  readOnly: boolean
  canvasValidity: string[]
  canvasZoomLabel: string
  canvasStageCss: Record<string, string>
  canvasSurfaceCss: Record<string, string>
  canvasLayout: GraphLayout
  canvasEdgeLines: CanvasEdgeLine[]
  canvasInsertionTargets: CanvasInsertionTarget[]
  canvasMoveTargetLines: CanvasEdgeLine[]
  selectedCanvasBranchGroup: CanvasBranchReorderGroup | null
  draggingCanvasBranchEdgeKey: string | null
  canvasLiveMessage: string
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
  (e: 'move-target-drop', event: DragEvent, edgeKey: string): void
  (e: 'move-step', nodeKey: string, direction: 'up' | 'down'): void
  (e: 'begin-move', nodeKey: string): void
  (e: 'branch-drag-start', event: DragEvent, kind: CanvasBranchKind, nodeKey: string, edgeKey: string): void
  (e: 'branch-drag-end'): void
  (e: 'branch-target-drop', event: DragEvent, kind: CanvasBranchKind, nodeKey: string, edgeKey: string): void
  (e: 'move-branch-step', kind: CanvasBranchKind, nodeKey: string, edgeKey: string, direction: 'up' | 'down'): void
  (e: 'add-condition-branch', nodeKey: string): void
  (e: 'add-parallel-branch', nodeKey: string): void
  (e: 'insert-node-into-edge', edgeKey: string, nodeType: EdgeInsertableNodeType): void
  (e: 'remove-node', nodeKey: string): void
}>()

const activeInsertionEdgeKey = ref<string | null>(null)
const activeInsertionTarget = computed(() =>
  props.canvasInsertionTargets.find((target) => target.edgeKey === activeInsertionEdgeKey.value) ?? null)
const workspaceRef = ref<HTMLElement | null>(null)
const activeInsertionTrigger = ref<HTMLButtonElement | null>(null)

function toggleInsertionMenu(edgeKey: string, event: MouseEvent): void {
  if (props.readOnly || !props.canvasInsertionTargets.some((target) => target.edgeKey === edgeKey)) return
  activeInsertionTrigger.value = event.currentTarget instanceof HTMLButtonElement
    ? event.currentTarget
    : null
  activeInsertionEdgeKey.value = activeInsertionEdgeKey.value === edgeKey ? null : edgeKey
  if (activeInsertionEdgeKey.value !== edgeKey) return
  void nextTick(() => {
    workspaceRef.value?.querySelector<HTMLElement>(
      '[data-active-insertion-menu] [role="menuitem"]',
    )?.focus()
  })
}

function closeInsertionMenu(edgeKey: string): void {
  if (activeInsertionEdgeKey.value !== edgeKey) return
  activeInsertionEdgeKey.value = null
  void nextTick(() => activeInsertionTrigger.value?.focus())
}

function chooseInsertion(edgeKey: string, nodeType: EdgeInsertableNodeType): void {
  const target = props.canvasInsertionTargets.find((candidate) => candidate.edgeKey === edgeKey)
  if (props.readOnly || !target?.nodeTypes.includes(nodeType)) return
  activeInsertionEdgeKey.value = null
  emit('insert-node-into-edge', edgeKey, nodeType)
}

function onMoveTargetDrop(event: DragEvent, edgeKey: string): void {
  event.preventDefault()
  event.stopPropagation()
  emit('move-target-drop', event, edgeKey)
}

function onBranchTargetDrop(event: DragEvent, edgeKey: string): void {
  event.preventDefault()
  event.stopPropagation()
  const group = props.selectedCanvasBranchGroup
  if (!group) return
  emit('branch-target-drop', event, group.kind, group.nodeKey, edgeKey)
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
.template-authoring__canvas-insert-target {
  position: absolute;
  z-index: 4;
  transform: translate(-50%, -50%);
}
.template-authoring__canvas-insert-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 1px solid var(--el-color-primary);
  border-radius: 50%;
  color: var(--el-color-primary);
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-lighter);
  cursor: pointer;
}
.template-authoring__canvas-insert-trigger:hover,
.template-authoring__canvas-insert-trigger:focus-visible,
.template-authoring__canvas-insert-trigger[aria-expanded='true'] {
  background: var(--el-color-primary-light-9);
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: 2px;
}
.template-authoring__canvas-insert-menu {
  position: absolute;
  left: 50%;
  top: 44px;
  z-index: 6;
  display: grid;
  min-width: 132px;
  padding: 4px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-light);
  transform: translateX(-50%);
}
.template-authoring__canvas-insert-option {
  min-height: 40px;
  padding: 8px 10px;
  border: 0;
  border-radius: 4px;
  color: var(--el-text-color-primary);
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.template-authoring__canvas-insert-option:hover,
.template-authoring__canvas-insert-option:focus-visible {
  background: var(--el-fill-color-light);
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: -2px;
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
.template-authoring__canvas-move-target:focus-visible,
.template-authoring__canvas-move-target.is-drag-active {
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
.template-authoring__canvas-branch-reorder {
  display: grid;
  gap: 8px;
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--el-border-color-light);
}
.template-authoring__canvas-branch-row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 4px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  background: var(--el-bg-color);
}
.template-authoring__canvas-branch-row.is-dragging {
  border-color: var(--el-color-primary);
  border-style: dashed;
}
.template-authoring__canvas-branch-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  color: var(--el-text-color-secondary);
  background: transparent;
  cursor: grab;
}
.template-authoring__canvas-branch-handle:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: 1px;
}
.template-authoring__canvas-branch-label {
  min-width: 0;
  overflow-wrap: anywhere;
}
.template-authoring__canvas-branch-actions {
  display: flex;
  gap: 4px;
}
.template-authoring__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
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
