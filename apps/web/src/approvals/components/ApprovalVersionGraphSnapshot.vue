<template>
  <section class="approval-version-graph" :aria-label="title">
    <header class="approval-version-graph__header">
      <strong>{{ title }}</strong>
      <span>{{ Math.round(zoom * 100) }}%</span>
    </header>
    <div
      ref="viewportRef"
      class="approval-version-graph__viewport"
      role="region"
      :aria-label="`${title}流程图`"
      tabindex="0"
      @scroll="emitScroll"
    >
      <div class="approval-version-graph__stage" :style="stageStyle">
        <div class="approval-version-graph__surface" :style="surfaceStyle">
          <svg class="approval-version-graph__edges" :width="layout.width" :height="layout.height" aria-hidden="true">
            <defs>
              <marker :id="markerId" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                <path d="M0,0 L7,3 L0,6 Z" fill="currentColor" />
              </marker>
            </defs>
            <path
              v-for="line in edgeLines"
              :key="line.key"
              :d="line.path"
              class="approval-version-graph__edge"
              :class="line.change ? `is-${line.change}` : ''"
              :marker-end="`url(#${markerId})`"
            />
          </svg>
          <button
            v-for="position in layout.nodes"
            :key="position.key"
            type="button"
            class="approval-version-graph__node"
            :class="[
              nodeChanges[position.key] ? `is-${nodeChanges[position.key]}` : '',
              { 'is-selected': selectedNodeKey === position.key },
            ]"
            :style="{
              left: `${position.x}px`,
              top: `${position.y}px`,
              width: `${NODE_WIDTH}px`,
              height: `${NODE_HEIGHT}px`,
            }"
            :aria-pressed="selectedNodeKey === position.key"
            @click="emit('select-node', position.key)"
          >
            <strong>{{ nodeLabel(position.key) }}</strong>
            <span>{{ nodeType(position.key) }}</span>
            <em v-if="nodeChanges[position.key]">{{ nodeChangeLabel(position.key) }}</em>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ApprovalGraph } from '../../types/approval'
import {
  approvalNodeDisplayLabel,
  approvalNodeTypeLabel,
} from '../approvalVersionPresentation'
import {
  computeLayout,
  GRAPH_LAYOUT_NODE_HEIGHT,
  GRAPH_LAYOUT_NODE_WIDTH,
} from '../graphLayout'
import type { TemplateVersionChangeKind } from '../templateVersionDiff'

const props = defineProps<{
  title: string
  markerId: string
  graph: ApprovalGraph
  zoom: number
  nodeChanges: Partial<Record<string, TemplateVersionChangeKind>>
  edgeChanges: Partial<Record<string, TemplateVersionChangeKind>>
  selectedNodeKey: string | null
}>()

const emit = defineEmits<{
  (event: 'select-node', nodeKey: string): void
  (event: 'scroll', position: { left: number; top: number }): void
}>()

const NODE_WIDTH = GRAPH_LAYOUT_NODE_WIDTH
const NODE_HEIGHT = GRAPH_LAYOUT_NODE_HEIGHT
const layout = computed(() => computeLayout(props.graph))
const nodesByKey = computed(() => new Map(props.graph.nodes.map((node) => [node.key, node])))
const edgeLines = computed(() => {
  const positions = new Map(layout.value.nodes.map((node) => [node.key, node]))
  return props.graph.edges.map((edge) => {
    const source = positions.get(edge.source)
    const target = positions.get(edge.target)
    const x1 = (source?.x ?? 0) + NODE_WIDTH / 2
    const y1 = (source?.y ?? 0) + NODE_HEIGHT
    const x2 = (target?.x ?? 0) + NODE_WIDTH / 2
    const y2 = target?.y ?? 0
    const midY = y1 + (y2 - y1) / 2
    return {
      key: edge.key,
      path: `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`,
      change: props.edgeChanges[edge.key],
    }
  })
})
const stageStyle = computed(() => ({
  width: `${Math.round(layout.value.width * props.zoom)}px`,
  height: `${Math.round(layout.value.height * props.zoom)}px`,
}))
const surfaceStyle = computed(() => ({
  width: `${layout.value.width}px`,
  height: `${layout.value.height}px`,
  transform: `scale(${props.zoom})`,
  transformOrigin: '0 0',
}))
const viewportRef = ref<HTMLElement | null>(null)

function nodeLabel(nodeKey: string): string {
  return approvalNodeDisplayLabel(nodesByKey.value.get(nodeKey))
}

function nodeType(nodeKey: string): string {
  return approvalNodeTypeLabel(nodesByKey.value.get(nodeKey)?.type ?? '')
}

function changeLabel(change: TemplateVersionChangeKind): string {
  return ({ added: '新增', removed: '删除', changed: '修改', moved: '移动' } as const)[change]
}

function nodeChangeLabel(nodeKey: string): string {
  const change = props.nodeChanges[nodeKey]
  return change ? changeLabel(change) : ''
}

function emitScroll(): void {
  const viewport = viewportRef.value
  if (!viewport) return
  emit('scroll', { left: viewport.scrollLeft, top: viewport.scrollTop })
}

function setScroll(left: number, top: number): void {
  const viewport = viewportRef.value
  if (!viewport || (viewport.scrollLeft === left && viewport.scrollTop === top)) return
  viewport.scrollTo({ left, top })
}

defineExpose({ viewportRef, setScroll })
</script>

<style scoped>
.approval-version-graph {
  min-width: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-bg-color);
}
.approval-version-graph__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.approval-version-graph__header span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.approval-version-graph__viewport {
  min-height: 360px;
  max-height: 520px;
  overflow: auto;
  background: var(--ms-bg-page);
}
.approval-version-graph__viewport:focus-visible {
  outline: 2px solid var(--el-color-primary-light-5);
  outline-offset: -2px;
}
.approval-version-graph__stage,
.approval-version-graph__surface {
  position: relative;
  min-width: 1px;
  min-height: 1px;
}
.approval-version-graph__edges {
  position: absolute;
  inset: 0;
  color: var(--el-border-color-dark);
}
.approval-version-graph__edge {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.approval-version-graph__node {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  overflow: hidden;
  padding: 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
  box-shadow: var(--el-box-shadow-lighter);
  text-align: left;
  cursor: pointer;
}
.approval-version-graph__node span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 14px;
}
.approval-version-graph__node strong {
  display: -webkit-box;
  overflow: hidden;
  line-height: 18px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.approval-version-graph__node em {
  color: var(--el-color-warning);
  font-size: 12px;
  font-style: normal;
  line-height: 14px;
}
.approval-version-graph__node.is-selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-5);
}
.approval-version-graph__node.is-added,
.approval-version-graph__edge.is-added {
  color: var(--el-color-success);
  border-color: var(--el-color-success);
}
.approval-version-graph__node.is-removed,
.approval-version-graph__edge.is-removed {
  color: var(--el-color-danger);
  border-color: var(--el-color-danger);
}
.approval-version-graph__node.is-changed,
.approval-version-graph__edge.is-changed {
  color: var(--el-color-warning);
  border-color: var(--el-color-warning);
}
@media (max-width: 900px) {
  .approval-version-graph__viewport {
    min-height: 300px;
    max-height: 420px;
  }
}
</style>
