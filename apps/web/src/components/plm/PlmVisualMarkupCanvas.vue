<template>
  <section class="plm-visual-markup" data-testid="plm-visual-markup">
    <header class="markup-header">
      <strong>视觉标注</strong>
      <span class="markup-filename">{{ filename }}</span>
    </header>

    <div class="toolbar" role="toolbar" aria-label="标注工具">
      <button
        v-for="item in tools"
        :key="item.id"
        type="button"
        :data-testid="`markup-tool-${item.id}`"
        :title="item.label"
        :aria-pressed="writable && tool === item.id"
        :disabled="!writable"
        @click="selectTool(item.id)"
      >
        <component :is="item.icon" class="tool-icon" aria-hidden="true" />
        {{ item.label }}
      </button>
      <button type="button" data-testid="markup-cancel" :disabled="!draft" @click="draft = null">取消</button>
      <button type="button" data-testid="markup-zoom-in" :disabled="zoom >= 4" @click="changeZoom(1)">放大</button>
      <button type="button" data-testid="markup-zoom-out" :disabled="zoom <= 0.5" @click="changeZoom(-1)">缩小</button>
      <button type="button" data-testid="markup-fit" @click="zoom = 1">适应</button>
      <button type="button" data-testid="markup-rotate" @click="rotation = (rotation + 90) % 360">旋转</button>
      <span data-testid="markup-view-status" aria-live="polite">{{ Math.round(zoom * 100) }}% · {{ rotation }}°</span>
    </div>

    <p id="plm-markup-pin-help" data-testid="markup-keyboard-help">
      <template v-if="writable">选择“图钉”后，Tab 进入预览。方向键沿屏幕方向移动，Shift 加快，Enter 放置，Esc 取消。</template>
      <template v-else>当前为只读，不能添加标注。</template>
    </p>

    <div
      ref="stageRef"
      class="stage"
      data-testid="markup-stage"
      :style="{ aspectRatio: `${assetWidth} / ${assetHeight}` }"
      :tabindex="pinKeys ? 0 : -1"
      :role="pinKeys ? 'application' : 'group'"
      :aria-label="pinKeys ? '图钉放置区域' : '预览'"
      :aria-describedby="pinKeys ? 'plm-markup-pin-help' : undefined"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="draft = null"
      @keydown="onStageKeydown"
    >
      <div class="content" :style="contentStyle">
        <img class="preview-image" :src="imageUrl" :alt="filename" draggable="false" data-testid="markup-image" />
        <svg class="overlay" viewBox="0 0 1 1" preserveAspectRatio="none" inert aria-hidden="true" focusable="false">
          <defs>
            <marker :id="markerId" markerUnits="strokeWidth" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" class="arrow-head" />
            </marker>
          </defs>
          <g
            v-for="mark in marks"
            :key="mark.key"
            :data-kind="mark.kind"
            :data-draft="mark.draft ? 'true' : 'false'"
            :class="{ 'is-selected': mark.id === selectedId && mark.id !== '', 'is-focused': mark.id === focusedId && mark.id !== '', 'is-draft': mark.draft, 'keyboard-pin': mark.key === 'keyboard' }"
          >
            <circle v-if="mark.kind === 'pin'" class="shape" :cx="mark.x" :cy="mark.y" r="0.015" />
            <rect v-else-if="mark.kind === 'callout'" class="shape" :x="mark.x - 0.02" :y="mark.y - 0.02" width="0.04" height="0.04" rx="0.008" />
            <rect v-else-if="mark.kind === 'rectangle'" class="shape" :x="mark.x" :y="mark.y" :width="mark.w" :height="mark.h" />
            <line v-else class="shape" :x1="mark.x" :y1="mark.y" :x2="mark.x2" :y2="mark.y2" :marker-end="`url(#${markerId})`" />
          </g>
        </svg>
      </div>
    </div>

    <div>
      <h2 class="annotation-heading">标注</h2>
      <p v-if="annotations.length === 0" data-testid="markup-empty">当前没有标注</p>
      <ul v-else class="annotation-list" role="listbox" aria-label="标注列表" data-testid="markup-list">
        <li
          v-for="(annotation, index) in annotations"
          :id="`${optionPrefix}-${index}`"
          :key="annotation.id"
          role="option"
          data-testid="markup-option"
          :aria-selected="annotation.id === selectedId"
          :tabindex="index === listCursor ? 0 : -1"
          @click="chooseAnnotation(index)"
          @keydown="onOptionKeydown($event, index)"
          @focus="focusedId = annotation.id"
          @blur="focusedId = focusedId === annotation.id ? null : focusedId"
        >
          <span>{{ label(annotation.markup_type) }} {{ index + 1 }}</span>
          <span>{{ annotation.body.trim() ? annotation.body : '无说明' }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { ChatDotSquare, Crop, Location, TopRight } from '@element-plus/icons-vue'
import {
  type ArrowKey,
  type Point,
  KEYBOARD_PIN_STEP,
  KEYBOARD_PIN_STEP_FAST,
  arrowFromPoints,
  clientToNormalized,
  fittedContentSize,
  finalizePoint,
  nudgeNormalizedPoint,
  rectangleFromPoints,
} from './visualMarkupGeometry'

type MarkupType = 'pin' | 'rectangle' | 'arrow' | 'callout'

interface Annotation {
  id: string
  body: string
  markup_type: MarkupType
  geometry: Record<string, number>
}

interface Draft {
  kind: MarkupType
  origin: Point
  current: Point
}

interface Mark {
  key: string
  kind: MarkupType
  id: string
  draft: boolean
  x: number
  y: number
  w: number
  h: number
  x2: number
  y2: number
}

const props = defineProps<{
  imageUrl: string
  filename: string
  assetWidth: number
  assetHeight: number
  annotations: Annotation[]
  writable: boolean
  selectedId: string | null
}>()

const emit = defineEmits<{
  create: [payload: { markup_type: MarkupType; geometry: Record<string, number> }]
  select: [id: string]
}>()

const tools = [
  { id: 'pin' as const, label: '图钉', icon: Location },
  { id: 'rectangle' as const, label: '矩形', icon: Crop },
  { id: 'arrow' as const, label: '箭头', icon: TopRight },
  { id: 'callout' as const, label: '引注', icon: ChatDotSquare },
]
const labels: Record<MarkupType, string> = { pin: '图钉', rectangle: '矩形', arrow: '箭头', callout: '引注' }

const stageRef = ref<HTMLElement | null>(null)
const tool = ref<MarkupType | null>(props.writable ? 'pin' : null)
const draft = ref<Draft | null>(null)
const zoom = ref(1)
const rotation = ref(0)
const viewport = ref({ width: 0, height: 0 })
const keyboardPoint = ref<Point>({ x: 0.5, y: 0.5 })
const listCursor = ref(0)
const focusedId = ref<string | null>(null)
const markerId = `arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const optionPrefix = `markup-option-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
let resizeObserver: ResizeObserver | null = null

const pinKeys = computed(() => props.writable && tool.value === 'pin')

const contentStyle = computed(() => {
  const box = fittedContentSize(viewport.value.width, viewport.value.height, props.assetWidth, props.assetHeight, rotation.value)
  const sized = box.contentWidth > 0 && box.contentHeight > 0
  return {
    width: sized ? `${box.contentWidth}px` : '100%',
    height: sized ? `${box.contentHeight}px` : '100%',
    transform: `rotate(${rotation.value}deg) scale(${zoom.value})`,
  }
})

const marks = computed(() => {
  const items: Mark[] = props.annotations.map((annotation) => ({
    key: annotation.id,
    kind: annotation.markup_type,
    id: annotation.id,
    draft: false,
    x: annotation.geometry.x ?? annotation.geometry.x1,
    y: annotation.geometry.y ?? annotation.geometry.y1,
    w: annotation.geometry.width ?? 0,
    h: annotation.geometry.height ?? 0,
    x2: annotation.geometry.x2 ?? 0,
    y2: annotation.geometry.y2 ?? 0,
  }))
  const state = draft.value
  if (state?.kind === 'pin' || state?.kind === 'callout') {
    const point = contains(state.current) ? state.current : state.origin
    items.push(makeDraftMark('draft', state.kind, point.x, point.y))
  } else if (state?.kind === 'rectangle') {
    const rect = rectangleFromPoints(state.origin, state.current)
    if (rect) items.push({ ...makeDraftMark('draft', 'rectangle', rect.x, rect.y), w: rect.width, h: rect.height })
  } else if (state?.kind === 'arrow') {
    const arrow = arrowFromPoints(state.origin, state.current)
    if (arrow) items.push({ ...makeDraftMark('draft', 'arrow', arrow.x1, arrow.y1), x2: arrow.x2, y2: arrow.y2 })
  } else if (pinKeys.value) {
    items.push(makeDraftMark('keyboard', 'pin', keyboardPoint.value.x, keyboardPoint.value.y))
  }
  return items
})

watch(() => [props.imageUrl, props.filename, props.assetWidth, props.assetHeight], () => resetTransient())

watch(() => props.writable, (writable) => {
  if (!writable) {
    draft.value = null
    tool.value = null
  } else if (tool.value == null) tool.value = 'pin'
})

watch(() => [props.selectedId, props.annotations.map((annotation) => annotation.id)] as const, ([id]) => {
  const index = props.annotations.findIndex((annotation) => annotation.id === id)
  listCursor.value = index >= 0 ? index : Math.min(listCursor.value, Math.max(0, props.annotations.length - 1))
  if (!props.annotations.some((annotation) => annotation.id === focusedId.value)) focusedId.value = null
}, { immediate: true })

onMounted(() => {
  measure()
  const stage = stageRef.value
  if (stage && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(stage)
  }
  window.addEventListener('keydown', onWindowKeydown)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onWindowKeydown)
})

function measure(): void {
  const stage = stageRef.value
  if (!stage) return
  // CSS zoom scales the client rectangle; fitted dimensions use layout pixels.
  viewport.value = { width: stage.clientWidth, height: stage.clientHeight }
}

function label(kind: MarkupType): string {
  return labels[kind]
}

function contains(point: Point): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= 1 && point.y <= 1
}

function makeDraftMark(key: string, kind: MarkupType, x: number, y: number): Mark {
  return { key, kind, id: '', draft: true, x, y, w: 0, h: 0, x2: 0, y2: 0 }
}

function selectTool(next: MarkupType): void {
  if (!props.writable) return
  if (tool.value !== next) draft.value = null
  tool.value = next
}

function changeZoom(direction: 1 | -1): void {
  const next = zoom.value * (direction > 0 ? 1.25 : 0.8)
  zoom.value = Math.round(Math.min(4, Math.max(0.5, next)) * 10000) / 10000
}

function resetTransient(): void {
  draft.value = null
  keyboardPoint.value = { x: 0.5, y: 0.5 }
  zoom.value = 1
  rotation.value = 0
  listCursor.value = 0
  focusedId.value = null
}

function readPointer(event: PointerEvent): Point | null {
  const rect = stageRef.value?.getBoundingClientRect()
  if (!rect) return null
  return clientToNormalized({
    clientX: event.clientX,
    clientY: event.clientY,
    viewportLeft: rect.left,
    viewportTop: rect.top,
    viewportWidth: rect.width,
    viewportHeight: rect.height,
    assetWidth: props.assetWidth,
    assetHeight: props.assetHeight,
    zoom: zoom.value,
    rotation: rotation.value,
  })
}

function onPointerDown(event: PointerEvent): void {
  if (!props.writable || !tool.value || event.button !== 0) return
  const point = readPointer(event)
  if (!point || !contains(point)) return
  draft.value = { kind: tool.value, origin: point, current: point }
  const stage = event.currentTarget
  if (stage instanceof Element) {
    try { stage.setPointerCapture(event.pointerId) } catch { /* pointer capture is absent in jsdom */ }
  }
}

function onPointerMove(event: PointerEvent): void {
  const state = draft.value
  if (!state || !props.writable) return
  const point = readPointer(event)
  if (point) draft.value = { ...state, current: point }
}

function onPointerUp(event: PointerEvent): void {
  const state = draft.value
  if (!state) return
  draft.value = null
  if (!props.writable) return
  const point = readPointer(event)
  if (!point) return
  if (state.kind === 'pin' || state.kind === 'callout') {
    const geometry = finalizePoint(point)
    if (geometry) emitCreate(state.kind, { ...geometry })
    return
  }
  const geometry = state.kind === 'rectangle' ? rectangleFromPoints(state.origin, point) : arrowFromPoints(state.origin, point)
  if (geometry) emitCreate(state.kind, { ...geometry })
}

function emitCreate(markupType: MarkupType, geometry: Record<string, number>): void {
  emit('create', Object.freeze({ markup_type: markupType, geometry: Object.freeze({ ...geometry }) }))
}

function onStageKeydown(event: KeyboardEvent): void {
  if (!pinKeys.value) return
  if (event.key === 'Enter') {
    event.preventDefault()
    if (draft.value) return
    const geometry = finalizePoint(keyboardPoint.value)
    if (geometry) emitCreate('pin', { ...geometry })
    return
  }
  if (!isArrowKey(event.key)) return
  event.preventDefault()
  keyboardPoint.value = nudgeNormalizedPoint(
    keyboardPoint.value,
    event.key,
    rotation.value,
    event.shiftKey ? KEYBOARD_PIN_STEP_FAST : KEYBOARD_PIN_STEP,
  )
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') draft.value = null
}

function isArrowKey(key: string): key is ArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
}

function chooseAnnotation(index: number): void {
  const annotation = props.annotations[index]
  if (!annotation) return
  listCursor.value = index
  emit('select', annotation.id)
  document.getElementById(`${optionPrefix}-${index}`)?.focus()
}

function onOptionKeydown(event: KeyboardEvent, index: number): void {
  const count = props.annotations.length
  if (count === 0) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    chooseAnnotation(index)
    return
  }
  let next = index
  if (event.key === 'ArrowDown') next = Math.min(count - 1, index + 1)
  else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = count - 1
  else return
  event.preventDefault()
  chooseAnnotation(next)
}
</script>

<style scoped>
.plm-visual-markup { display: flex; flex-direction: column; gap: 8px; min-width: 0; color: #111; font: 13px/1.4 system-ui, sans-serif; }
.markup-header, .toolbar, .annotation-list li { display: flex; align-items: center; gap: 8px; }
.markup-header { justify-content: space-between; }
.markup-filename { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toolbar { flex-wrap: wrap; }
button { min-height: 32px; border: 1px solid #d0d7de; border-radius: 6px; padding: 4px 10px; background: #f9fafb; color: #111; font: inherit; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.45; }
.tool-icon { width: 16px; height: 16px; vertical-align: middle; margin-right: 4px; }
button[aria-pressed='true'] { background: #111; color: #fff; outline: 3px solid #ffe14a; outline-offset: 1px; }
button:focus-visible, .annotation-list li:focus-visible, .stage:focus-visible { outline: 3px solid #111; outline-offset: 2px; box-shadow: 0 0 0 5px #ffe14a; }
p, h2 { margin: 0; }
.annotation-heading { font-size: 14px; }
.stage { position: relative; width: 100%; max-height: 70vh; overflow: hidden; background: #111; touch-action: none; }
.content { position: absolute; inset: 0; margin: auto; transform-origin: center center; }
.preview-image, .overlay { position: absolute; inset: 0; width: 100%; height: 100%; }
.preview-image { object-fit: fill; pointer-events: none; user-select: none; }
.overlay { pointer-events: none; overflow: visible; }
.shape { fill: none; stroke: #fff; stroke-width: 2px; vector-effect: non-scaling-stroke; filter: drop-shadow(1px 0 0 #000) drop-shadow(-1px 0 0 #000) drop-shadow(0 1px 0 #000) drop-shadow(0 -1px 0 #000); }
.arrow-head { fill: #fff; stroke: #000; stroke-width: 0.6px; }
.is-selected .shape { stroke: #ffe14a; stroke-width: 3px; }
.is-focused .shape { stroke: #fff; stroke-width: 4px; }
.is-draft .shape { stroke: #00e5ff; stroke-dasharray: 4 3; }
.stage:focus-visible .keyboard-pin .shape { stroke: #ffe14a; stroke-width: 3px; }
.annotation-list { flex-direction: column; align-items: stretch; margin: 0; padding: 0; list-style: none; }
.annotation-list li { justify-content: space-between; min-height: 36px; border: 1px solid #d0d7de; border-radius: 6px; padding: 6px 8px; background: #fff; cursor: pointer; }
.annotation-list li[aria-selected='true'] { background: #111; color: #fff; box-shadow: inset 4px 0 0 #ffe14a; }
.annotation-list li span:first-child { font-weight: 700; }
.annotation-list li span:last-child { min-width: 0; overflow-wrap: anywhere; text-align: right; }
@media (max-width: 560px) {
  button { flex: 1 1 calc(50% - 8px); min-height: 40px; }
  .markup-header, .annotation-list li { align-items: flex-start; flex-direction: column; }
  .annotation-list li span:last-child { text-align: left; }
  .stage { max-height: none; }
}
@media (prefers-reduced-motion: reduce) {
  .plm-visual-markup * { transition: none; animation: none; }
}
@media (forced-colors: active) {
  button[aria-pressed='true'], .annotation-list li[aria-selected='true'], .stage:focus-visible, .annotation-list li:focus-visible { outline: 3px solid Highlight; }
  .is-selected .shape, .is-focused .shape { stroke: Highlight; }
}
</style>
