<template>
  <div class="workflow-designer">
    <div class="designer-toolbar">
      <div class="toolbar-section">
        <button @click="saveWorkflow" :disabled="!hasChanges" class="btn btn-primary">
          保存工作流
        </button>
        <button @click="validateWorkflow" class="btn btn-secondary">
          验证
        </button>
        <button @click="exportWorkflow" class="btn btn-secondary">
          导出
        </button>
        <button @click="importWorkflow" class="btn btn-secondary">
          导入
        </button>
      </div>
      <div class="toolbar-section">
        <button @click="zoomIn" class="btn-icon">➕</button>
        <button @click="zoomOut" class="btn-icon">➖</button>
        <button @click="fitView" class="btn-icon">⛶</button>
        <button @click="toggleMinimap" class="btn-icon">🗺️</button>
      </div>
    </div>

    <div class="designer-container">
      <NodePalette
        @dragStart="handleNodeDragStart"
        @dragEnd="handleNodeDragEnd"
      />

      <div class="canvas-wrapper">
        <VueFlow
          ref="vueFlow"
          v-model:nodes="nodes"
          v-model:edges="edges"
          @nodes-change="onNodesChange"
          @edges-change="onEdgesChange"
          @connect="onConnect"
          @edge-update="onEdgeUpdate"
          @node-click="onNodeClick"
          @pane-click="onPaneClick"
          @drop="onDrop"
          @dragover="onDragOver"
          :node-types="nodeTypes"
          :edge-types="edgeTypes"
          :default-viewport="{ x: 0, y: 0, zoom: 1 }"
          :min-zoom="0.2"
          :max-zoom="4"
          :connection-mode="ConnectionMode.Loose"
          :delete-key-code="['Delete', 'Backspace']"
          :multi-selection-key-code="['Meta', 'Control']"
          :pan-on-scroll="true"
          :selection-mode="SelectionMode.Partial"
          :snap-to-grid="snapToGrid"
          :snap-grid="[15, 15]"
          :fit-view-on-init="true"
          :nodes-draggable="true"
          :nodes-connectable="true"
          :nodes-focusable="true"
          :edges-updatable="true"
          :edges-focusable="true"
        >
          <Background
            v-if="showBackground"
            :variant="backgroundVariant"
            :gap="15"
          />
          <MiniMap
            v-if="showMinimap"
            :node-color="getNodeColor"
            :mask-color="'rgba(0, 0, 0, 0.4)'"
          />
          <Controls
            :show-zoom="true"
            :show-fit-view="true"
            :show-interactive="true"
          />
        </VueFlow>
      </div>

      <PropertyPanel
        v-if="selectedNode"
        :node="selectedNode"
        @update="updateNodeProperties"
        @close="selectedNode = null"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import {
  VueFlow,
  useVueFlow,
  Node,
  Edge,
  Connection,
  EdgeChange,
  NodeChange,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  MarkerType,
  ConnectionMode,
  SelectionMode
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'

import NodePalette from './NodePalette.vue'
import PropertyPanel from './PropertyPanel.vue'

// Import custom nodes
import StartNode from './nodes/StartNode.vue'
import EndNode from './nodes/EndNode.vue'
import TaskNode from './nodes/TaskNode.vue'
import GatewayNode from './nodes/GatewayNode.vue'
import SubProcessNode from './nodes/SubProcessNode.vue'
import EventNode from './nodes/EventNode.vue'

// Import custom edges
import ConditionalEdge from './edges/ConditionalEdge.vue'

const props = defineProps<{
  workflowId?: string
  initialData?: {
    nodes: Node[]
    edges: Edge[]
  }
}>()

const emit = defineEmits<{
  save: [data: { nodes: Node[], edges: Edge[] }]
  validate: [result: ValidationResult]
}>()

// Vue Flow instance
const vueFlow = ref()
const { project, fitView, zoomIn: vfZoomIn, zoomOut: vfZoomOut } = useVueFlow()

// State
const nodes = ref<Node[]>([])
const edges = ref<Edge[]>([])
const selectedNode = ref<Node | null>(null)
const hasChanges = ref(false)
const showMinimap = ref(true)
const showBackground = ref(true)
const backgroundVariant = ref<'lines' | 'dots'>('dots')
const snapToGrid = ref(true)
const draggedNodeType = ref<string | null>(null)

// Node and edge types
const nodeTypes = {
  start: StartNode,
  end: EndNode,
  task: TaskNode,
  gateway: GatewayNode,
  subprocess: SubProcessNode,
  event: EventNode
}

const edgeTypes = {
  conditional: ConditionalEdge
}

// Initialize
onMounted(() => {
  if (props.initialData) {
    nodes.value = props.initialData.nodes
    edges.value = props.initialData.edges
  } else {
    // Create default start node
    nodes.value = [{
      id: 'start-1',
      type: 'start',
      position: { x: 100, y: 100 },
      data: { label: '开始', color: '#22c55e' }
    }]
  }
})

// Node drag handlers
const handleNodeDragStart = (nodeType: string) => {
  draggedNodeType.value = nodeType
}

const handleNodeDragEnd = () => {
  draggedNodeType.value = null
}

// Drop handler
const onDrop = (event: DragEvent) => {
  event.preventDefault()

  if (!draggedNodeType.value) return

  const position = project({
    x: event.clientX - event.currentTarget.getBoundingClientRect().left,
    y: event.clientY - event.currentTarget.getBoundingClientRect().top
  })

  const newNode: Node = {
    id: `${draggedNodeType.value}-${Date.now()}`,
    type: draggedNodeType.value,
    position,
    data: getDefaultNodeData(draggedNodeType.value)
  }

  nodes.value = [...nodes.value, newNode]
  hasChanges.value = true
}

const onDragOver = (event: DragEvent) => {
  event.preventDefault()
  if (draggedNodeType.value) {
    event.dataTransfer!.dropEffect = 'copy'
  }
}

// Node/Edge change handlers
const onNodesChange = (changes: NodeChange[]) => {
  nodes.value = applyNodeChanges(changes, nodes.value)
  hasChanges.value = true
}

const onEdgesChange = (changes: EdgeChange[]) => {
  edges.value = applyEdgeChanges(changes, edges.value)
  hasChanges.value = true
}

// Connection handlers
const onConnect = (connection: Connection) => {
  const newEdge: Edge = {
    ...connection,
    id: `edge-${Date.now()}`,
    type: 'smoothstep',
    animated: true,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 20,
      height: 20
    }
  }
  edges.value = addEdge(newEdge, edges.value)
  hasChanges.value = true
}

const onEdgeUpdate = ({ edge, connection }: { edge: Edge, connection: Connection }) => {
  edges.value = edges.value.map(e => {
    if (e.id === edge.id) {
      return { ...e, ...connection }
    }
    return e
  })
  hasChanges.value = true
}

// Click handlers
const onNodeClick = (event: MouseEvent, node: Node) => {
  selectedNode.value = node
}

const onPaneClick = () => {
  selectedNode.value = null
}

// Property update
const updateNodeProperties = (properties: Record<string, any>) => {
  if (!selectedNode.value) return

  nodes.value = nodes.value.map(node => {
    if (node.id === selectedNode.value!.id) {
      return {
        ...node,
        data: {
          ...node.data,
          ...properties
        }
      }
    }
    return node
  })
  hasChanges.value = true
}

// Toolbar actions
const saveWorkflow = async () => {
  const workflowData = {
    nodes: nodes.value,
    edges: edges.value
  }
  emit('save', workflowData)
  hasChanges.value = false
}

const validateWorkflow = () => {
  const result = performValidation()
  emit('validate', result)
}

const exportWorkflow = () => {
  const data = {
    version: '1.0.0',
    nodes: nodes.value,
    edges: edges.value,
    metadata: {
      created: new Date().toISOString(),
      type: 'workflow-designer'
    }
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `workflow-${Date.now()}.json`
  link.click()
  URL.revokeObjectURL(url)
}

const importWorkflow = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    const text = await file.text()
    const data = JSON.parse(text)

    nodes.value = data.nodes || []
    edges.value = data.edges || []
    hasChanges.value = true
  }
  input.click()
}

const zoomIn = () => vfZoomIn()
const zoomOut = () => vfZoomOut()
const fitView = () => vueFlow.value?.fitView()
const toggleMinimap = () => showMinimap.value = !showMinimap.value

// Helper functions
const getDefaultNodeData = (nodeType: string) => {
  const defaults: Record<string, any> = {
    start: { label: '开始', color: '#22c55e' },
    end: { label: '结束', color: '#ef4444' },
    task: { label: '任务', color: '#3b82f6', assignee: '', dueDate: '' },
    gateway: { label: '网关', color: '#f59e0b', condition: '' },
    subprocess: { label: '子流程', color: '#8b5cf6', subprocess: '' },
    event: { label: '事件', color: '#06b6d4', eventType: 'timer' }
  }
  return defaults[nodeType] || { label: '节点' }
}

const getNodeColor = (node: Node) => {
  return node.data?.color || '#6b7280'
}

const performValidation = (): ValidationResult => {
  const errors: string[] = []
  const warnings: string[] = []

  // Check for start nodes
  const startNodes = nodes.value.filter(n => n.type === 'start')
  if (startNodes.length === 0) {
    errors.push('工作流必须有开始节点')
  } else if (startNodes.length > 1) {
    warnings.push('工作流有多个开始节点')
  }

  // Check for end nodes
  const endNodes = nodes.value.filter(n => n.type === 'end')
  if (endNodes.length === 0) {
    warnings.push('建议添加结束节点')
  }

  // Check for disconnected nodes
  const connectedNodeIds = new Set<string>()
  edges.value.forEach(edge => {
    connectedNodeIds.add(edge.source)
    connectedNodeIds.add(edge.target)
  })

  nodes.value.forEach(node => {
    if (!connectedNodeIds.has(node.id) && node.type !== 'start') {
      warnings.push(`节点 "${node.data.label}" 未连接`)
    }
  })

  // Check gateway conditions
  const gatewayNodes = nodes.value.filter(n => n.type === 'gateway')
  gatewayNodes.forEach(gateway => {
    const outgoingEdges = edges.value.filter(e => e.source === gateway.id)
    if (outgoingEdges.length < 2) {
      warnings.push(`网关 "${gateway.data.label}" 应有至少两个输出`)
    }
  })

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

// Type definitions
interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
</script>

<style scoped>
.workflow-designer {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f9fafb;
}

.designer-toolbar {
  height: 56px;
  background: white;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.toolbar-section {
  display: flex;
  gap: 8px;
  align-items: center;
}

.btn {
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid #d1d5db;
  background: white;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.btn:hover {
  background: #f3f4f6;
}

.btn-primary {
  background: #3b82f6;
  color: white;
  border-color: #3b82f6;
}

.btn-primary:hover {
  background: #2563eb;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: white;
  cursor: pointer;
  font-size: 16px;
}

.btn-icon:hover {
  background: #f3f4f6;
}

.designer-container {
  flex: 1;
  display: flex;
  position: relative;
  overflow: hidden;
}

.canvas-wrapper {
  flex: 1;
  position: relative;
}

/* Vue Flow custom styles */
:deep(.vue-flow) {
  background: #f9fafb;
}

:deep(.vue-flow__minimap) {
  background: white;
  border: 1px solid #e5e7eb;
}

:deep(.vue-flow__controls) {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

:deep(.vue-flow__node) {
  font-size: 14px;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

:deep(.vue-flow__edge-path) {
  stroke-width: 2;
}

:deep(.vue-flow__handle) {
  width: 10px;
  height: 10px;
  border: 2px solid white;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}
</style>