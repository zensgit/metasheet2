<script setup lang="ts">
/**
 * Canvas V2 inspector chrome (PR4 extract) — topology actions + config slot.
 * Parent owns selection and all mutations; config editor still uses provide/inject.
 *
 * Lock-0 L0-1 (docs/development/approval-lock0-d0-interaction-delta-20260817.md): the contextual
 * section stack (the `节点设置` slot below) becomes a tab strip for `approval` nodes with editable
 * config. Tab MEMBERSHIP is derived from the L0-2 capability registry — `操作权限` exists in the
 * DOM only when the registry declares a ratified operation policy for the node type (never, at the
 * shipped baseline). Tabs are PRESENTATION ONLY: switching tabs is local component state with zero
 * side effects on the draft/undo history, no Save/Cancel, no confirm-on-switch (parent §5 lines
 * 204-206, delta §1 L0-1 preserved invariants).
 *
 * The tab content itself lives in `ApprovalGraphNodeConfigEditor.vue` (rendered via `<slot/>`
 * below) — this component only owns the tab STRIP (buttons + roving tabindex) and tells the config
 * editor which tab is active via `APPROVAL_CANVAS_INSPECTOR_TABS_KEY` (provide/inject reaches
 * slotted content by mount position, not by which template authored the vnode, so this works even
 * though the config editor is instantiated in TemplateAuthoringView.vue's template, not this one).
 */
import { computed, inject, nextTick, provide, ref, watch, type ComponentPublicInstance } from 'vue'
import type { ApprovalNode } from '../../types/approval'
import {
  DEFAULT_APPROVAL_CAPABILITY_REGISTRY,
  hasRatifiedOperationPolicy,
  type ApprovalCapabilityRegistry,
} from '../approvalCapabilityRegistry'
import {
  APPROVAL_CANVAS_INSPECTOR_TABS_KEY,
  type ApprovalCanvasInspectorTabDescriptor,
  type ApprovalCanvasInspectorTabId,
} from '../canvasInspectorTabsContext'
import { APPROVAL_NODE_CONFIG_EDITOR_KEY } from '../nodeConfigEditorContext'

const props = defineProps<{
  node: ApprovalNode
  readOnly: boolean
  movingCanvasNode: string | null
  graphNodeLabel: (nodeKey: string) => string
  nodeTypeLabel: (type: string) => string
  canMoveCanvasNode: (nodeKey: string) => boolean
  canvasStepMoveTarget: (nodeKey: string, direction: 'up' | 'down') => string | undefined
  canInsertAfter: (node: ApprovalNode) => boolean
  canInsertParallelAfter: (node: ApprovalNode) => boolean
  canRemoveNode: (node: ApprovalNode) => boolean
  /** L0-2 capability registry driving tab membership. Optional — defaults to the shipped registry;
   *  tests override it to prove tab membership is the registry's doing (A-1/A-2 positive control). */
  registry?: ApprovalCapabilityRegistry
}>()

const emit = defineEmits<{
  close: []
  'move-up': [nodeKey: string]
  'move-down': [nodeKey: string]
  'begin-move': [nodeKey: string]
  'add-condition-branch': [nodeKey: string]
  'add-parallel-branch': [nodeKey: string]
  'insert-approval': [nodeKey: string]
  'insert-condition': [nodeKey: string]
  'insert-parallel': [nodeKey: string]
  remove: [nodeKey: string]
}>()

const rootEl = ref<HTMLElement | null>(null)
defineExpose({
  getEl: (): HTMLElement | null => rootEl.value,
  scrollIntoView: (opts?: ScrollIntoViewOptions) => {
    rootEl.value?.scrollIntoView(opts)
  },
})

// ── L0-1 tab strip ──────────────────────────────────────────────────────────────────────────────
// Read-only use of the SAME shared context TemplateAuthoringView.vue provides to the config editor
// (this component is a normal descendant of it, not just a slot-content wrapper, so a plain
// inject() here sees it) — only to decide whether the SELECTED node has editable approval config
// (i.e. would take ApprovalGraphNodeConfigEditor.vue's tabbed branch) vs. everything else (legacy
// read-only approval nodes, condition/parallel/cc/start/end), which keeps the flat pre-L0-1
// presentation unchanged.
const configEditorApi = inject(APPROVAL_NODE_CONFIG_EDITOR_KEY, undefined)
const hasEditableApprovalConfig = computed(() => {
  // Lock-3 §1.5: a handler node ALSO takes the tabbed presentation (办理人设置 + 表单权限), reusing the
  // same edit model — so it must be admitted here alongside `approval`.
  if (props.node.type !== 'approval' && props.node.type !== 'handler') return false
  const fn = configEditorApi?.approvalNodeEditFor
  return typeof fn === 'function' ? Boolean(fn(props.node.key)) : false
})

const tabs = computed<ApprovalCanvasInspectorTabDescriptor[]>(() => {
  const registry = props.registry ?? DEFAULT_APPROVAL_CAPABILITY_REGISTRY
  const list: ApprovalCanvasInspectorTabDescriptor[] = [
    // Lock-3 §1.5: the first tab's LABEL is node-type specific (办理人设置 for a handler) — which is
    // exactly why the strip is derived per node TYPE rather than hand-written once.
    { id: 'assignee', label: props.node.type === 'handler' ? '办理人设置' : '审批人设置' },
    { id: 'fieldPermissions', label: '表单权限' },
  ]
  if (hasRatifiedOperationPolicy(registry, props.node.type)) {
    list.push({ id: 'operations', label: '操作权限' })
  }
  return list
})

const activeTab = ref<ApprovalCanvasInspectorTabId>('assignee')

watch(
  () => props.node.key,
  () => {
    activeTab.value = tabs.value[0]?.id ?? 'assignee'
  },
)
watch(tabs, (list) => {
  if (!list.some((tab) => tab.id === activeTab.value)) {
    activeTab.value = list[0]?.id ?? 'assignee'
  }
})

function selectTab(id: ApprovalCanvasInspectorTabId): void {
  activeTab.value = id
}

const tabButtonRefs = new Map<string, HTMLElement>()
function setTabButtonRef(id: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) tabButtonRefs.set(id, el)
  else tabButtonRefs.delete(id)
}
function focusTabButton(id: string): void {
  tabButtonRefs.get(id)?.focus()
}

/** A-12: this handler is bound to the tablist element ONLY, so it never sees keydowns that
 *  originate in the sibling topology toolbar (they bubble through a different DOM subtree) — the
 *  two arrow-key widgets are independent by construction, not by a shared dispatcher that routes
 *  between them. */
function onTabsKeydown(event: KeyboardEvent): void {
  const list = tabs.value
  const currentIndex = list.findIndex((tab) => tab.id === activeTab.value)
  if (currentIndex < 0) return
  let targetIndex: number | null = null
  if (event.key === 'ArrowRight') targetIndex = (currentIndex + 1) % list.length
  else if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + list.length) % list.length
  else if (event.key === 'Home') targetIndex = 0
  else if (event.key === 'End') targetIndex = list.length - 1
  if (targetIndex === null) return
  event.preventDefault()
  event.stopPropagation()
  const target = list[targetIndex]
  selectTab(target.id)
  void nextTick(() => focusTabButton(target.id))
}

// provide() unconditionally (once, at setup) — `active` is the reactive gate the config editor
// reads; a persisting inspector instance that moves selection between node types stays correct.
provide(APPROVAL_CANVAS_INSPECTOR_TABS_KEY, {
  active: hasEditableApprovalConfig,
  tabs,
  activeTab,
})
</script>

<template>
  <aside
    ref="rootEl"
    class="template-authoring__canvas-inspector"
    data-testid="approval-canvas-inspector"
    :data-inspector-node="node.key"
    :data-inspector-type="node.type"
  >
    <div class="template-authoring__canvas-inspector-header">
      <div class="template-authoring__canvas-inspector-title">
        <strong>{{ nodeTypeLabel(node.type) }}</strong>
        <span class="template-authoring__node-type" :data-node-type="node.type">
          {{ graphNodeLabel(node.key) }}
        </span>
      </div>
      <el-button
        text
        size="small"
        data-testid="approval-canvas-inspector-close"
        aria-label="关闭节点检查器"
        @click="emit('close')"
      >
        关闭
      </el-button>
    </div>
    <div class="template-authoring__canvas-inspector-body">
      <div
        v-if="!readOnly"
        class="template-authoring__inspector-topology"
        data-testid="approval-canvas-inspector-topology"
        role="toolbar"
        :aria-label="`${graphNodeLabel(node.key)}节点拓扑操作`"
      >
        <template v-if="canMoveCanvasNode(node.key)">
          <el-button
            size="small"
            :disabled="!canvasStepMoveTarget(node.key, 'up')"
            :data-testid="`approval-canvas-move-up-${node.key}`"
            :aria-label="`上移${graphNodeLabel(node.key)}节点`"
            @click="emit('move-up', node.key)"
          >
            上移
          </el-button>
          <el-button
            size="small"
            :disabled="!canvasStepMoveTarget(node.key, 'down')"
            :data-testid="`approval-canvas-move-down-${node.key}`"
            :aria-label="`下移${graphNodeLabel(node.key)}节点`"
            @click="emit('move-down', node.key)"
          >
            下移
          </el-button>
          <el-button
            size="small"
            :type="movingCanvasNode === node.key ? 'primary' : undefined"
            :data-testid="`approval-canvas-move-${node.key}`"
            :aria-label="`移动${graphNodeLabel(node.key)}节点`"
            @click="emit('begin-move', node.key)"
          >
            移动
          </el-button>
        </template>
        <el-button
          v-if="node.type === 'condition'"
          size="small"
          :data-testid="`approval-canvas-add-condition-${node.key}`"
          :aria-label="`为${graphNodeLabel(node.key)}添加条件分支`"
          @click="emit('add-condition-branch', node.key)"
        >
          +条件分支
        </el-button>
        <el-button
          v-if="node.type === 'parallel'"
          size="small"
          :data-testid="`approval-canvas-add-parallel-${node.key}`"
          :aria-label="`为${graphNodeLabel(node.key)}添加并行分支`"
          @click="emit('add-parallel-branch', node.key)"
        >
          +并行分支
        </el-button>
        <template v-if="canInsertAfter(node)">
          <el-button
            size="small"
            :data-testid="`approval-canvas-insert-${node.key}`"
            :aria-label="`在${graphNodeLabel(node.key)}后插入审批节点`"
            @click="emit('insert-approval', node.key)"
          >
            +审批
          </el-button>
          <el-button
            size="small"
            :data-testid="`approval-canvas-insert-condition-${node.key}`"
            :aria-label="`在${graphNodeLabel(node.key)}后插入条件节点`"
            @click="emit('insert-condition', node.key)"
          >
            +条件
          </el-button>
          <el-button
            v-if="canInsertParallelAfter(node)"
            size="small"
            :data-testid="`approval-canvas-insert-parallel-${node.key}`"
            :aria-label="`在${graphNodeLabel(node.key)}后插入并行节点`"
            @click="emit('insert-parallel', node.key)"
          >
            +并行
          </el-button>
        </template>
        <el-button
          v-if="canRemoveNode(node)"
          size="small"
          type="danger"
          :data-testid="`approval-canvas-remove-${node.key}`"
          :aria-label="`删除${graphNodeLabel(node.key)}节点`"
          @click="emit('remove', node.key)"
        >
          删除
        </el-button>
      </div>
      <template v-if="hasEditableApprovalConfig">
        <div
          class="template-authoring__canvas-inspector-tabs"
          role="tablist"
          aria-label="节点设置"
          data-testid="approval-canvas-inspector-tablist"
          @keydown="onTabsKeydown"
        >
          <button
            v-for="tab in tabs"
            :key="tab.id"
            type="button"
            role="tab"
            :id="`approval-canvas-inspector-tab-${tab.id}`"
            :aria-selected="activeTab === tab.id ? 'true' : 'false'"
            :aria-controls="`approval-canvas-inspector-tabpanel-${tab.id}`"
            :tabindex="activeTab === tab.id ? 0 : -1"
            class="template-authoring__canvas-inspector-tab"
            :class="{ 'is-active': activeTab === tab.id }"
            :data-testid="`approval-canvas-inspector-tab-${tab.id}`"
            :ref="(el) => setTabButtonRef(tab.id, el as Element | null)"
            @click="selectTab(tab.id)"
          >{{ tab.label }}</button>
        </div>
        <div
          :id="`approval-canvas-inspector-tabpanel-${activeTab}`"
          role="tabpanel"
          :aria-labelledby="`approval-canvas-inspector-tab-${activeTab}`"
          class="template-authoring__canvas-inspector-tabpanel"
          data-testid="approval-canvas-inspector-tabpanel"
          :data-active-tab="activeTab"
        >
          <slot />
        </div>
      </template>
      <template v-else>
        <p class="template-authoring__inspector-section-label">节点设置</p>
        <slot />
      </template>
    </div>
  </aside>
</template>

<style scoped>
.template-authoring__canvas-inspector {
  flex: 0 0 400px;
  width: 400px;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--el-border-color-lighter);
  border-left: 1px solid var(--el-border-color);
  border-radius: 0;
  background: var(--el-bg-color);
  display: flex;
  flex-direction: column;
  max-height: none;
  overflow: hidden;
  scroll-margin-top: 164px;
}
.template-authoring__canvas-inspector-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--el-border-color-light);
}
.template-authoring__canvas-inspector-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 15px;
}
.template-authoring__inspector-section-label {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}
.template-authoring__canvas-inspector-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 14px;
}
.template-authoring__inspector-topology {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.template-authoring__node-type {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
/* L0-1 tab strip — flat, no shadow/gradient (parent §3.2 restraint, V-8). */
.template-authoring__canvas-inspector-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.template-authoring__canvas-inspector-tab {
  appearance: none;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  cursor: pointer;
}
.template-authoring__canvas-inspector-tab.is-active {
  background: var(--el-fill-color-light);
  border-color: var(--el-border-color);
  color: var(--el-color-primary);
  font-weight: 600;
}
.template-authoring__canvas-inspector-tab:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
.template-authoring__canvas-inspector-tabpanel {
  min-width: 0;
}
@media (max-width: 960px) {
  .template-authoring__canvas-inspector {
    flex: 1 1 auto;
    width: 100%;
    max-height: none;
  }
}
</style>
