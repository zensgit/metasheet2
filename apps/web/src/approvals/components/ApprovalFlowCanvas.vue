<script setup lang="ts">
/**
 * Canvas V2 flow surface (PR4 extract) — pure presentation.
 * Parent owns draft/history and all topology/command mutations.
 */
import { Connection, FullScreen, Promotion, Rank, Share, Tickets, User, ZoomIn, ZoomOut } from '@element-plus/icons-vue'
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
  canvasNodeSummary: (nodeKey: string) => string
  nodeTypeLabel: (type: string) => string
  canvasNodeByKey: (nodeKey: string) => ApprovalNode | undefined
  canMoveCanvasNode: (nodeKey: string) => boolean
  canInsertParallelOnEdge: (edgeKey: string) => boolean
  // Lock-3 §1.3/§1.5: hide 办理人 on any edge inside a parallel region (a handler is linear-only in v1).
  canInsertHandlerOnEdge: (edgeKey: string) => boolean
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
  'edge-insert-cc': [edgeKey: string]
  'edge-insert-condition': [edgeKey: string]
  'edge-insert-parallel': [edgeKey: string]
  // Lock-3 §1.5 — insert a 办理 (handler) node on this edge.
  'edge-insert-handler': [edgeKey: string]
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

// FS-7 fix-round (P2-1, 20260821 gate): the node card's accessible name previously carried the
// type ONLY on the unnamed fallback (the old `graphNodeLabel` used the node's trimmed `name` when
// present, else `nodeTypeLabel(type)`) — as soon as an author names a node, the type disappeared
// from the accname entirely, even though the visible `.template-authoring__canvas-node-kind` bar
// is a non-contributing SIBLING of this `role="button"` selector (its text is not announced on Tab
// focus). This composes BOTH when a name exists (`编辑<type>节点「<name>」`, the house 「」-quoting
// idiom used for named entities elsewhere in this package — e.g. graphLayout.ts's
// `节点「${node.name}」`) and falls back to the EXACT prior string when unnamed AND the node is
// found (`编辑<type>节点`, unchanged) so the seven unnamed-fallback accnames stay byte-identical.
// Values-free: only `name` (author-given business text) and the type label are interpolated —
// never `pos.key`/`node.key`.
//
// Disclosed, not an oversight: `canvasNodeByKey(nodeKey)` returning `undefined` (the node not
// found in the effective graph) is structurally unreachable in production — `pos.key` always comes
// from `canvasLayout.nodes`, which TemplateAuthoringView.vue derives via `computeLayout` from the
// SAME `canvasEffectiveGraph.value.nodes` array `canvasNodeByKey` looks up in, so the two can never
// disagree within one render. For that defensive branch this does NOT reproduce the OLD
// `graphNodeLabel`'s `'流程节点'` placeholder (a generic string carrying no type at all) — it falls
// through to `nodeTypeLabel('approval')` instead, mirroring the SAME `?? 'approval'` default the
// visible kind-bar directly above already uses (line ~239) rather than inventing a new fallback
// value. A behavioural difference in dead code, stated rather than silently inherited.
function canvasNodeAccName(nodeKey: string): string {
  const node = props.canvasNodeByKey(nodeKey)
  const typeLabel = props.nodeTypeLabel(node?.type ?? 'approval')
  const name = node?.name?.trim()
  return name ? `编辑${typeLabel}节点「${name}」` : `编辑${typeLabel}节点`
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
      <el-button
        :icon="FullScreen"
        aria-label="适应画布"
        data-testid="approval-canvas-fit"
        @click="emit('fit')"
      >
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
                stroke="var(--el-border-color)"
                stroke-width="1.25"
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
              v-for="pos in canvasLayout.nodes"
              :key="pos.key"
              class="template-authoring__canvas-node"
              :class="{
                'is-selected': selectedCanvasNode === pos.key,
                'is-moving': movingCanvasNode === pos.key,
              }"
              :style="nodePosStyle(pos)"
              :data-canvas-node="pos.key"
              :data-node-type="canvasNodeByKey(pos.key)?.type"
              data-testid="approval-canvas-node"
              :draggable="!readOnly && canMoveCanvasNode(pos.key)"
              @click="emit('select-node', pos.key)"
              @dragstart="emit('drag-start', $event, pos.key)"
              @dragend="emit('drag-end')"
            >
              <div
                class="template-authoring__canvas-node-kind"
                :data-node-type="canvasNodeByKey(pos.key)?.type"
              >
                {{ nodeTypeLabel(canvasNodeByKey(pos.key)?.type ?? 'approval') }}
              </div>
              <!-- FS-1 fix — the W4 approval-canvas closeout's single FAIL
                   (docs/development/approval-remaining-dev-verification-report-20260820.md §5.1;
                   NOT the same finding as "FAIL-1" in
                   approval-parity-verification-report-20260818.md, which names the unrelated
                   approval-inspector-keyboard.spec.ts harness rot, already fixed). RATIFIED
                   criterion violated:
                   approval-canvas-v2-interaction-design-lock-20260721.md:366 ("Long labels" row,
                   scope explicitly includes "Node cards"): "Truncate with ellipsis at component
                   limits (§14); full text on hover/focus tooltip, in the inspector, and in
                   accessible names." THREE legs — this fixes ONLY the FIRST (hover/focus
                   tooltip), which is the one §5.1 scopes the FAIL to. The "in the inspector" leg
                   is a separate, unverified claim about ApprovalCanvasNodeInspector.vue (§5.1:
                   "looks satisfied... not click-through-verified"), out of scope here. The "in
                   accessible names" leg is FS-7 — a DIFFERENT defect (the parent `role="button"`
                   div's own `aria-label` overrides the whole subtree's accessible name per
                   standard accname computation, so the summary text is never exposed via the
                   accessible NAME at all) — §5.1 explicitly requires FS-7 stay a SEPARATE slice,
                   never merged with this one. This fix does not touch `aria-label` and does not
                   close FS-7.
                   The summary line below is CSS-ellipsis-truncated
                   (.template-authoring__canvas-node-summary) but carried NO way to recover the
                   full text — not on hover, not on keyboard focus. el-tooltip wraps the SAME
                   focusable selector div (no extra DOM node, no extra tab stop — ElOnlyChild
                   clones the trigger attrs onto this exact element) with `trigger="['hover',
                   'focus']"`: Element Plus's default trigger is 'hover' ONLY (verified against
                   trigger2.mjs — the onFocus/onBlur handlers it wires are gated by
                   `whenTrigger(trigger, 'focus', …)`, so a bare `<el-tooltip>` would silently
                   stay hover-only and miss the a11y half, which is the point of this fix), so
                   'focus' must be listed explicitly. Content is the SAME `canvasNodeSummary(...)`
                   string already rendered inline — values-free (no raw ids), never re-derived.
                   P2-1 fix-round (rebase, 20260821): `:aria-label` below was widened from the
                   bare `` `编辑${graphNodeLabel(pos.key)}节点` `` literal to `canvasNodeAccName
                   (pos.key)` (composes type AND name — see that function's own doc comment above)
                   — this hunk is the confirmed merge-conflict intersection with #5058, resolved by
                   keeping #5058's tooltip wrapper and widening only this one binding. -->
              <el-tooltip
                :content="canvasNodeSummary(pos.key)"
                placement="top"
                :trigger="['hover', 'focus']"
                popper-class="template-authoring__canvas-node-summary-tooltip"
              >
                <div
                  class="template-authoring__canvas-node-selector"
                  role="button"
                  tabindex="0"
                  :aria-label="canvasNodeAccName(pos.key)"
                  :aria-pressed="selectedCanvasNode === pos.key"
                  data-testid="approval-canvas-node-select"
                  @click.stop="emit('select-node', pos.key)"
                  @keydown.enter.stop.prevent="emit('select-node', pos.key)"
                  @keydown.space.stop.prevent="emit('select-node', pos.key)"
                  @keydown="emit('node-keydown', $event, pos.key)"
                >
                  <span class="template-authoring__canvas-node-summary">
                    {{ canvasNodeSummary(pos.key) }}
                  </span>
                  <span class="template-authoring__canvas-node-chevron" aria-hidden="true">›</span>
                </div>
              </el-tooltip>
            </div>
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
                @click.stop
                @pointerdown.stop
              >
                <button
                  type="button"
                  role="menuitem"
                  aria-label="插入审批节点"
                  data-testid="approval-canvas-edge-insert-approval"
                  @click.stop="emit('edge-insert-approval', line.key)"
                >
                  <span class="template-authoring__canvas-edge-insert-icon is-approval" aria-hidden="true">
                    <el-icon><User /></el-icon>
                  </span>
                  审批人
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="插入抄送节点"
                  data-testid="approval-canvas-edge-insert-cc"
                  @click.stop="emit('edge-insert-cc', line.key)"
                >
                  <span class="template-authoring__canvas-edge-insert-icon is-cc" aria-hidden="true">
                    <el-icon><Promotion /></el-icon>
                  </span>
                  抄送人
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="插入条件分支"
                  data-testid="approval-canvas-edge-insert-condition"
                  @click.stop="emit('edge-insert-condition', line.key)"
                >
                  <span class="template-authoring__canvas-edge-insert-icon is-condition" aria-hidden="true">
                    <el-icon><Share /></el-icon>
                  </span>
                  条件分支
                </button>
                <button
                  v-if="canInsertParallelOnEdge(line.key)"
                  type="button"
                  role="menuitem"
                  aria-label="插入并行分支"
                  data-testid="approval-canvas-edge-insert-parallel"
                  @click.stop="emit('edge-insert-parallel', line.key)"
                >
                  <span class="template-authoring__canvas-edge-insert-icon is-parallel" aria-hidden="true">
                    <el-icon><Connection /></el-icon>
                  </span>
                  并行分支
                </button>
                <button
                  v-if="canInsertHandlerOnEdge(line.key)"
                  type="button"
                  role="menuitem"
                  aria-label="插入办理节点"
                  data-testid="approval-canvas-edge-insert-handler"
                  @click.stop="emit('edge-insert-handler', line.key)"
                >
                  <span class="template-authoring__canvas-edge-insert-icon is-handler" aria-hidden="true">
                    <el-icon><Tickets /></el-icon>
                  </span>
                  办理人
                </button>
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
      在连线上点「+」插入节点；选中节点后在右侧检查器配置与结构调整。Alt+↑/↓ 语义重排。
    </p>
  </div>
</template>

<style scoped>
.template-authoring__canvas-main {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.template-authoring__canvas-toolbar {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  margin: 0;
  padding: 4px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-bg-color) 92%, transparent);
  box-shadow: var(--el-box-shadow-lighter);
}
/* FAIL-2/V-6 fix (P7-R2, second root cause): these are real `<el-button>`s, so their
   `:focus-visible` ring does NOT come from a rule in this file at all — it comes from Element
   Plus's OWN base `.el-button` default, which sets `--el-button-outline-color:
   var(--el-color-primary-light-5)` (measured 2.14:1 here, same as every other light-5 ring in
   this component). Overriding the custom property, scoped to just this toolbar, fixes the ring
   without touching Element Plus's app-wide default for every other plain button in the product —
   that is a separate, unratified, much larger surface this fix round does not touch. */
.template-authoring__canvas-toolbar :deep(.el-button) {
  --el-button-outline-color: var(--el-color-primary);
}
.template-authoring__canvas-zoom-label {
  min-width: 58px;
  font-variant-numeric: tabular-nums;
}
.template-authoring__canvas-viewport-shell {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}
.template-authoring__canvas-viewport {
  min-height: min(72vh, 720px);
  height: 100%;
  max-height: none;
  max-width: 100%;
  overflow: auto;
  border: 0;
  border-radius: 0;
  background: var(--el-fill-color-lighter);
}
/* FAIL-2/V-6 fix (P7-R2, 20260818): the previous ring token, `--el-color-primary-light-5`,
   measured 2.05-2.14:1 against every abutting canvas surface in real Chromium — below the
   ratified >= 3:1 focus-ring contrast (approval-canvas-v2-interaction-design-lock-20260721.md:412).
   `--el-color-primary` measured 4.45-5.17:1 on every surface this ring can abut (already the
   token the passing edge-insert-btn ring below used) — see the P7 phase-A evidence ledger FAIL-2
   table. UF-6 note: exact color values are recorded in the ledger, not as literals here — this
   file's own zero-hex-literal guard scans <style> block comment text too. */
.template-authoring__canvas-viewport:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.template-authoring__canvas-stage {
  position: relative;
  min-width: 1px;
  min-height: 1px;
}
.template-authoring__canvas {
  position: relative;
  background: transparent;
  min-height: 200px;
}
.template-authoring__canvas-edges {
  position: absolute;
  left: 0;
  top: 0;
}
/* D0 §3.2 flat-card grammar (P1-D): flat background, 1px border, 8px radius, no shadow stack, no
   gradient, no nested cards. Type is a TEXT label (`.template-authoring__canvas-node-kind`, below)
   — color is never the sole carrier (V-6/V-8). The per-type left-border accent below is a
   supplementary token-only accent, NOT the superseded colored-title-band/ribbon presentation. */
.template-authoring__canvas-node {
  box-sizing: border-box;
  padding: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-left: 3px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--ms-bg-card);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  cursor: default;
  font-size: 12px;
  min-height: 76px;
  height: 76px;
}
.template-authoring__canvas-node[draggable='true'] {
  cursor: grab;
}
.template-authoring__canvas-node-kind {
  flex: 0 0 28px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
}
/* Per-type accent lives on the CARD's left border only — flat, token-only, never a fill/background
   on the type-label row above (that stays the single flat color for every node type). `danger` is
   the destructive/error token elsewhere in this UI, so it is never used for a node TYPE — reserved
   for a future validation marker (D0 §3.2 point 3), which this component does not implement today. */
.template-authoring__canvas-node[data-node-type='start'],
.template-authoring__canvas-node[data-node-type='end'] {
  border-left-color: var(--el-color-info);
}
.template-authoring__canvas-node[data-node-type='approval'] {
  border-left-color: var(--el-color-primary);
}
.template-authoring__canvas-node[data-node-type='cc'] {
  border-left-color: var(--el-color-success);
}
.template-authoring__canvas-node[data-node-type='condition'] {
  border-left-color: var(--el-color-warning);
}
/* Considered trade-off (gate fix round, P2-3): `parallel` shares `--el-color-info` with `start`/`end`
   above rather than a distinct token, so those three of six types now render an identical left-border
   accent. `--el-color-info` is `parallel`'s OWN informational token elsewhere in this same component
   (the edge-insert menu icon, `.is-parallel { background: var(--el-color-info) }`), and D0's only hard
   requirement is that type stays TEXT-carried (`nodeTypeLabel`) with color merely supplementary — no
   clause requires six mutually distinct border colors. The alternative (an unused-elsewhere token like
   `--el-color-primary-dark-2`) would restore distinctness but fails the "existing token used for
   informational accents elsewhere in the approval UI" instruction. Recorded here, not shipped silently. */
.template-authoring__canvas-node[data-node-type='parallel'] {
  border-left-color: var(--el-color-info);
}
/* FAIL-6 fix (P7-R2, gate fix round): the P4-A slice added the `handler` (办理) node type to the
   canvas without a per-type accent, so it fell through to the CARD's own default
   `border-left: 3px solid var(--el-border-color-lighter)` — the only one of seven shipped types
   with no accent at all. Extends the SAME info-token-sharing trade-off already recorded above for
   `parallel` (start/end/parallel all already share `--el-color-info`, D0's only hard requirement
   being that type stays TEXT-carried, never six mutually distinct colors) rather than reaching for
   `--el-color-danger`/`--el-color-error`, which stay reserved elsewhere in this component for a
   future validation marker, never a node TYPE. */
.template-authoring__canvas-node[data-node-type='handler'] {
  border-left-color: var(--el-color-info);
}
/* Selection accent — a ring plus border-color change on the CARD itself, applied uniformly across
   every node type (never a per-type fill). Declared AFTER the per-type accent rules above so its
   equal-specificity `border-left-color` actually wins the cascade instead of being shadowed by the
   later per-type rule (both are `.template-authoring__canvas-node` + one class/attribute, so source
   order decides). */
.template-authoring__canvas-node.is-selected {
  border-color: var(--el-color-primary);
  border-left-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-7);
}
.template-authoring__canvas-node.is-moving {
  border-style: dashed;
  border-color: var(--el-color-primary);
}
.template-authoring__canvas-node-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
  padding: 0 12px;
  cursor: pointer;
  outline: none;
}
/* FAIL-2/V-6 fix (P7-R2): same light-5 -> primary swap as the viewport ring above. */
.template-authoring__canvas-node-selector:focus-visible {
  box-shadow: inset 0 0 0 2px var(--el-color-primary);
}
.template-authoring__canvas-node-summary {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--el-text-color-regular);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.template-authoring__canvas-node-chevron {
  flex: 0 0 auto;
  color: var(--el-text-color-placeholder);
  font-size: 16px;
  line-height: 1;
}
.template-authoring__canvas-edge-insert {
  position: absolute;
  z-index: 6;
  transform: translate(-50%, -50%);
  pointer-events: auto;
}
.template-authoring__canvas-edge-insert.is-open {
  z-index: 20;
}
.template-authoring__canvas-edge-insert-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--el-color-primary-light-5);
  background: var(--ms-bg-card);
  color: var(--el-color-primary);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  box-shadow: var(--el-box-shadow-lighter);
}
.template-authoring__canvas-edge-insert.is-open .template-authoring__canvas-edge-insert-btn {
  background: var(--el-color-primary);
  color: var(--el-color-white);
}
.template-authoring__canvas-edge-insert-btn:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.template-authoring__canvas-edge-insert-menu {
  position: absolute;
  top: 50%;
  left: 36px;
  transform: translateY(-50%);
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
  min-width: max-content;
  padding: 10px 12px 8px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  background: var(--ms-bg-card);
  box-shadow: var(--el-box-shadow);
  pointer-events: auto;
}
.template-authoring__canvas-edge-insert-menu button {
  border: 0;
  background: transparent;
  padding: 0;
  min-width: 52px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  font-size: 11px;
  color: var(--el-text-color-regular);
  border-radius: 6px;
}
.template-authoring__canvas-edge-insert-menu button:hover {
  color: var(--el-color-primary);
}
/* FAIL-2 sub-finding fix (P7-R2): this selector used to be shared with `:hover` above and set
   ONLY `color:` — signalling focus by TEXT COLOR alone, no ring (also a §7 checklist "colour is
   not the sole carrier of state" trip). Split from hover and given its own non-color channel
   (`outline`) so every `:focus-visible` rule in this file carries a real ring — the hover-only
   look above is unchanged. */
.template-authoring__canvas-edge-insert-menu button:focus-visible {
  color: var(--el-color-primary);
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.template-authoring__canvas-edge-insert-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--el-color-white);
  font-size: 16px;
}
.template-authoring__canvas-edge-insert-icon.is-approval {
  background: var(--el-color-warning);
}
.template-authoring__canvas-edge-insert-icon.is-cc {
  background: var(--el-color-primary);
}
.template-authoring__canvas-edge-insert-icon.is-condition {
  background: var(--el-color-success);
}
.template-authoring__canvas-edge-insert-icon.is-parallel {
  background: var(--el-color-info);
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
.template-authoring__canvas-move-target:hover {
  border-style: solid;
  background: var(--el-color-primary-light-9);
}
/* FAIL-2 sub-finding fix (P7-R2): this selector used to be shared with `:hover` above and shipped
   a bare `outline: none` — a removal with no replacement ring. Split from hover and given a real
   >=3:1 ring (`outline`) so every `:focus-visible` rule in this file carries a non-color channel —
   the hover-only look above is unchanged. */
.template-authoring__canvas-move-target:focus-visible {
  border-style: solid;
  background: var(--el-color-primary-light-9);
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}
.template-authoring__canvas-minimap {
  position: absolute;
  right: 12px;
  bottom: 56px;
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
  display: none;
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
