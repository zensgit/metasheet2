<script setup lang="ts">
/**
 * Canvas V2 inspector chrome (PR4 extract) — topology actions + config slot.
 * Parent owns selection and all mutations; config editor still uses provide/inject.
 */
import { ref } from 'vue'
import type { ApprovalNode } from '../../types/approval'

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
        <strong>{{ graphNodeLabel(node.key) }}</strong>
        <span class="template-authoring__node-type" :data-node-type="node.type">
          {{ nodeTypeLabel(node.type) }}
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
      <slot />
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
@media (max-width: 960px) {
  .template-authoring__canvas-inspector {
    flex: 1 1 auto;
    width: 100%;
    max-height: none;
  }
}
</style>
