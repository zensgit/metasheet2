<template>
  <div class="workflow-designer">
    <!-- Header -->
    <div class="designer-header">
      <div class="header-left">
        <el-button :icon="ArrowLeft" @click="goBack">返回</el-button>
        <el-divider direction="vertical" />
        <span class="workflow-name">{{ workflowName || '新建工作流' }}</span>
        <el-tag v-if="isDirty" type="warning" size="small">未保存</el-tag>
      </div>
      <div class="header-center">
        <el-button-group>
          <el-button :icon="ZoomOut" @click="zoom(-0.1)" />
          <el-button>{{ Math.round(zoomLevel * 100) }}%</el-button>
          <el-button :icon="ZoomIn" @click="zoom(0.1)" />
          <el-button :icon="FullScreen" @click="fitViewport" />
        </el-button-group>
      </div>
      <div class="header-right">
        <el-button @click="showProperties = !showProperties">
          <el-icon><Setting /></el-icon>
          属性面板
        </el-button>
        <el-button @click="validateWorkflow">
          <el-icon><CircleCheck /></el-icon>
          验证
        </el-button>
        <el-button type="primary" @click="saveWorkflow" :loading="saving">
          <el-icon><Upload /></el-icon>
          保存
        </el-button>
        <el-button type="success" @click="deployWorkflow" :loading="deploying" :disabled="!workflowId">
          <el-icon><Promotion /></el-icon>
          部署
        </el-button>
      </div>
    </div>

    <!-- Main Content -->
    <div class="designer-content">
      <!-- Tool Palette -->
      <div class="tool-palette">
        <div class="palette-section">
          <div class="section-title">事件</div>
          <div
            v-for="item in eventElements"
            :key="item.type"
            class="palette-item"
            draggable="true"
            @dragstart="onDragStart($event, item)"
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
            @dragstart="onDragStart($event, item)"
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
            @dragstart="onDragStart($event, item)"
          >
            <div class="item-icon" :style="{ backgroundColor: item.color }">
              <component :is="item.icon" />
            </div>
            <span class="item-label">{{ item.label }}</span>
          </div>
        </div>
      </div>

      <!-- BPMN Canvas -->
      <div class="canvas-container" ref="canvasContainer">
        <div ref="bpmnCanvas" class="bpmn-canvas"></div>
        <!-- Drop Zone Overlay -->
        <div
          v-if="isDragging"
          class="drop-zone"
          @dragover.prevent
          @drop="onDrop"
        >
          拖放元素到此处
        </div>
      </div>

      <!-- Properties Panel -->
      <transition name="slide-right">
        <div v-if="showProperties" class="properties-panel">
          <div class="panel-header">
            <span>{{ selectedElement ? '元素属性' : '工作流属性' }}</span>
            <el-button :icon="Close" text @click="showProperties = false" />
          </div>
          <div class="panel-content">
            <!-- Workflow Properties -->
            <template v-if="!selectedElement">
              <el-form label-position="top" size="small">
                <el-form-item label="工作流名称">
                  <el-input v-model="workflowName" placeholder="输入工作流名称" />
                </el-form-item>
                <el-form-item label="工作流描述">
                  <el-input
                    v-model="workflowDescription"
                    type="textarea"
                    :rows="3"
                    placeholder="输入工作流描述"
                  />
                </el-form-item>
                <el-form-item label="版本">
                  <el-input v-model="workflowVersion" disabled />
                </el-form-item>
              </el-form>
            </template>
            <!-- Element Properties -->
            <template v-else>
              <el-form label-position="top" size="small">
                <el-form-item label="元素ID">
                  <el-input :model-value="selectedElement.id" disabled />
                </el-form-item>
                <el-form-item label="元素名称">
                  <el-input
                    v-model="elementName"
                    placeholder="输入元素名称"
                    @change="updateElementName"
                  />
                </el-form-item>
                <el-form-item label="元素类型">
                  <el-tag>{{ getElementTypeLabel(selectedElement.type) }}</el-tag>
                </el-form-item>
                <!-- Task-specific properties -->
                <template v-if="isTaskElement">
                  <el-form-item label="执行人">
                    <el-input v-model="taskAssignee" placeholder="输入执行人" />
                  </el-form-item>
                  <el-form-item label="候选人">
                    <el-input v-model="taskCandidates" placeholder="多人用逗号分隔" />
                  </el-form-item>
                  <el-form-item label="到期时间">
                    <el-input v-model="taskDueDate" placeholder="如: PT1H (1小时)" />
                  </el-form-item>
                </template>
                <!-- Gateway-specific properties -->
                <template v-if="isGatewayElement">
                  <el-form-item label="默认流">
                    <el-select v-model="gatewayDefault" placeholder="选择默认出口">
                      <el-option
                        v-for="flow in outgoingFlows"
                        :key="flow.id"
                        :label="flow.name || flow.id"
                        :value="flow.id"
                      />
                    </el-select>
                  </el-form-item>
                </template>
                <!-- Sequence Flow properties -->
                <template v-if="isSequenceFlow">
                  <el-form-item label="条件表达式">
                    <el-input
                      v-model="flowCondition"
                      type="textarea"
                      :rows="2"
                      placeholder="${amount > 1000}"
                    />
                  </el-form-item>
                </template>
              </el-form>
            </template>
          </div>
        </div>
      </transition>
    </div>

    <!-- Footer / Minimap -->
    <div class="designer-footer">
      <div class="minimap" ref="minimapContainer"></div>
      <div class="footer-info">
        <span>元素: {{ elementCount }}</span>
        <el-divider direction="vertical" />
        <span>连接: {{ connectionCount }}</span>
        <el-divider direction="vertical" />
        <span v-if="lastSaved">上次保存: {{ formatTime(lastSaved) }}</span>
      </div>
    </div>

    <!-- Validation Dialog -->
    <el-dialog v-model="showValidation" title="工作流验证结果" width="500px">
      <div v-if="validationErrors.length === 0" class="validation-success">
        <el-icon :size="48" color="#67c23a"><CircleCheckFilled /></el-icon>
        <p>工作流验证通过，没有发现问题。</p>
      </div>
      <div v-else class="validation-errors">
        <el-alert
          v-for="(error, index) in validationErrors"
          :key="index"
          :title="error.message"
          :type="error.severity === 'error' ? 'error' : 'warning'"
          :description="error.element ? `元素: ${error.element}` : ''"
          show-icon
          :closable="false"
          class="validation-item"
        />
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, markRaw } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft,
  ZoomIn,
  ZoomOut,
  FullScreen,
  Setting,
  Close,
  Upload,
  Promotion,
  CircleCheck,
  CircleCheckFilled,
  VideoPlay,
  VideoPause,
  User,
  Document,
  Message,
  Timer,
  Switch,
  Share,
  Operation
} from '@element-plus/icons-vue'

// BPMN.js imports
import BpmnModeler from 'bpmn-js/lib/Modeler'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn-embedded.css'

// Types
interface PaletteItem {
  type: string
  label: string
  icon: typeof VideoPlay
  color: string
}

interface ValidationError {
  message: string
  severity: 'error' | 'warning'
  element?: string
}

interface BpmnElement {
  id: string
  type: string
  businessObject?: {
    name?: string
    $type?: string
    assignee?: string
    candidateUsers?: string
    dueDate?: string
    default?: { id: string }
    conditionExpression?: { body: string }
    outgoing?: Array<{ id: string; name?: string }>
  }
}

// Router
const router = useRouter()
const route = useRoute()

// State
const bpmnCanvas = ref<HTMLElement | null>(null)
const canvasContainer = ref<HTMLElement | null>(null)
const minimapContainer = ref<HTMLElement | null>(null)
let modeler: BpmnModeler | null = null

const workflowId = ref<string | null>(null)
const workflowName = ref('')
const workflowDescription = ref('')
const workflowVersion = ref('1.0.0')
const isDirty = ref(false)
const saving = ref(false)
const deploying = ref(false)
const lastSaved = ref<Date | null>(null)

const zoomLevel = ref(1)
const showProperties = ref(true)
const showValidation = ref(false)
const validationErrors = ref<ValidationError[]>([])

const selectedElement = ref<BpmnElement | null>(null)
const elementName = ref('')
const taskAssignee = ref('')
const taskCandidates = ref('')
const taskDueDate = ref('')
const gatewayDefault = ref('')
const flowCondition = ref('')

const isDragging = ref(false)
const draggedItem = ref<PaletteItem | null>(null)

const elementCount = ref(0)
const connectionCount = ref(0)

// Palette Items
const eventElements: PaletteItem[] = [
  { type: 'bpmn:StartEvent', label: '开始事件', icon: VideoPlay, color: '#67c23a' },
  { type: 'bpmn:EndEvent', label: '结束事件', icon: VideoPause, color: '#f56c6c' },
  { type: 'bpmn:IntermediateCatchEvent', label: '中间事件', icon: Timer, color: '#e6a23c' },
]

const taskElements: PaletteItem[] = [
  { type: 'bpmn:UserTask', label: '用户任务', icon: User, color: '#409eff' },
  { type: 'bpmn:ServiceTask', label: '服务任务', icon: Operation, color: '#909399' },
  { type: 'bpmn:ScriptTask', label: '脚本任务', icon: Document, color: '#9c27b0' },
  { type: 'bpmn:SendTask', label: '发送任务', icon: Message, color: '#00bcd4' },
]

const gatewayElements: PaletteItem[] = [
  { type: 'bpmn:ExclusiveGateway', label: '排他网关', icon: Switch, color: '#ff9800' },
  { type: 'bpmn:ParallelGateway', label: '并行网关', icon: Share, color: '#4caf50' },
  { type: 'bpmn:InclusiveGateway', label: '包容网关', icon: Operation, color: '#673ab7' },
]

// Computed
const isTaskElement = computed(() => {
  return selectedElement.value?.type?.includes('Task')
})

const isGatewayElement = computed(() => {
  return selectedElement.value?.type?.includes('Gateway')
})

const isSequenceFlow = computed(() => {
  return selectedElement.value?.type === 'bpmn:SequenceFlow'
})

const outgoingFlows = computed(() => {
  if (!selectedElement.value?.businessObject?.outgoing) return []
  return selectedElement.value.businessObject.outgoing.map(flow => ({
    id: flow.id,
    name: flow.name
  }))
})

// Element Type Labels
function getElementTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    'bpmn:StartEvent': '开始事件',
    'bpmn:EndEvent': '结束事件',
    'bpmn:UserTask': '用户任务',
    'bpmn:ServiceTask': '服务任务',
    'bpmn:ScriptTask': '脚本任务',
    'bpmn:SendTask': '发送任务',
    'bpmn:ExclusiveGateway': '排他网关',
    'bpmn:ParallelGateway': '并行网关',
    'bpmn:InclusiveGateway': '包容网关',
    'bpmn:SequenceFlow': '顺序流',
    'bpmn:IntermediateCatchEvent': '中间事件',
  }
  return labels[type] || type
}

// Lifecycle
onMounted(async () => {
  await initModeler()

  // Load workflow if ID provided
  const id = route.params.id as string
  if (id && id !== 'new') {
    workflowId.value = id
    await loadWorkflow(id)
  } else {
    // Create new workflow with default diagram
    await createNewWorkflow()
  }
})

onBeforeUnmount(() => {
  if (modeler) {
    modeler.destroy()
  }
})

// Initialize BPMN Modeler
async function initModeler() {
  if (!bpmnCanvas.value) return

  modeler = markRaw(new BpmnModeler({
    container: bpmnCanvas.value,
    keyboard: { bindTo: document },
  }))

  // Event listeners
  modeler.on('selection.changed', (e: { newSelection: BpmnElement[] }) => {
    if (e.newSelection.length === 1) {
      selectedElement.value = e.newSelection[0]
      loadElementProperties()
    } else {
      selectedElement.value = null
    }
  })

  modeler.on('element.changed', () => {
    isDirty.value = true
    updateCounts()
  })

  modeler.on('shape.added', () => {
    isDirty.value = true
    updateCounts()
  })

  modeler.on('shape.removed', () => {
    isDirty.value = true
    updateCounts()
  })

  modeler.on('connection.added', () => {
    isDirty.value = true
    updateCounts()
  })

  modeler.on('connection.removed', () => {
    isDirty.value = true
    updateCounts()
  })

  // Canvas events for zoom
  const canvas = modeler.get('canvas') as { zoom: (level?: number | string, center?: string) => number }
  canvas.zoom('fit-viewport', 'auto')
  zoomLevel.value = canvas.zoom()
}

// Load element properties into form
function loadElementProperties() {
  if (!selectedElement.value) return

  const bo = selectedElement.value.businessObject
  elementName.value = bo?.name || ''

  if (isTaskElement.value) {
    taskAssignee.value = bo?.assignee || ''
    taskCandidates.value = bo?.candidateUsers || ''
    taskDueDate.value = bo?.dueDate || ''
  }

  if (isGatewayElement.value) {
    gatewayDefault.value = bo?.default?.id || ''
  }

  if (isSequenceFlow.value) {
    flowCondition.value = bo?.conditionExpression?.body || ''
  }
}

// Update element name
function updateElementName() {
  if (!modeler || !selectedElement.value) return

  const modeling = modeler.get('modeling') as {
    updateProperties: (element: BpmnElement, props: Record<string, unknown>) => void
  }
  modeling.updateProperties(selectedElement.value, { name: elementName.value })
}

// Zoom controls
function zoom(delta: number) {
  if (!modeler) return
  const canvas = modeler.get('canvas') as { zoom: (level?: number | string, center?: string) => number }
  zoomLevel.value = Math.max(0.2, Math.min(2, zoomLevel.value + delta))
  canvas.zoom(zoomLevel.value)
}

function fitViewport() {
  if (!modeler) return
  const canvas = modeler.get('canvas') as { zoom: (level?: number | string, center?: string) => number }
  canvas.zoom('fit-viewport', 'auto')
  zoomLevel.value = canvas.zoom()
}

// Update element counts
function updateCounts() {
  if (!modeler) return

  const elementRegistry = modeler.get('elementRegistry') as {
    getAll: () => BpmnElement[]
  }
  const elements = elementRegistry.getAll()

  elementCount.value = elements.filter(e => e.type !== 'bpmn:SequenceFlow' && e.type !== 'label').length
  connectionCount.value = elements.filter(e => e.type === 'bpmn:SequenceFlow').length
}

// Drag and drop handlers
function onDragStart(event: DragEvent, item: PaletteItem) {
  draggedItem.value = item
  isDragging.value = true
  event.dataTransfer?.setData('text/plain', item.type)
}

function onDrop(event: DragEvent) {
  isDragging.value = false
  if (!modeler || !draggedItem.value || !canvasContainer.value) return

  const rect = canvasContainer.value.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top

  // Get canvas to convert coordinates
  const canvas = modeler.get('canvas') as {
    viewbox: () => { x: number; y: number; scale: number }
  }
  const viewbox = canvas.viewbox()

  const realX = viewbox.x + (x / viewbox.scale)
  const realY = viewbox.y + (y / viewbox.scale)

  // Create element
  const elementFactory = modeler.get('elementFactory') as {
    createShape: (options: { type: string }) => BpmnElement
  }
  const create = modeler.get('create') as {
    start: (event: DragEvent, shape: BpmnElement) => void
  }

  const shape = elementFactory.createShape({ type: draggedItem.value.type })

  // Use modeling to create at position
  const modeling = modeler.get('modeling') as {
    createShape: (shape: BpmnElement, position: { x: number; y: number }, parent: BpmnElement) => void
  }
  const canvas2 = modeler.get('canvas') as { getRootElement: () => BpmnElement }
  const rootElement = canvas2.getRootElement()

  modeling.createShape(shape, { x: realX, y: realY }, rootElement)

  draggedItem.value = null
}

// Create new workflow
async function createNewWorkflow() {
  const defaultXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="开始" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="179" y="159" width="36" height="36" />
        <bpmndi:BPMNLabel>
          <dc:Bounds x="186" y="202" width="22" height="14" />
        </bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`

  try {
    await modeler?.importXML(defaultXml)
    await nextTick()
    fitViewport()
    updateCounts()
    isDirty.value = false
  } catch (err) {
    console.error('Failed to create new workflow:', err)
    ElMessage.error('创建工作流失败')
  }
}

// Load workflow from backend
async function loadWorkflow(id: string) {
  try {
    const response = await fetch(`/api/workflow-designer/workflows/${id}`)
    if (!response.ok) throw new Error('Failed to load workflow')

    const data = await response.json()
    workflowName.value = data.name
    workflowDescription.value = data.description || ''
    workflowVersion.value = data.version || '1.0.0'

    if (data.bpmnXml) {
      await modeler?.importXML(data.bpmnXml)
      await nextTick()
      fitViewport()
      updateCounts()
    }

    isDirty.value = false
    ElMessage.success('工作流加载成功')
  } catch (err) {
    console.error('Failed to load workflow:', err)
    ElMessage.error('加载工作流失败')
    await createNewWorkflow()
  }
}

// Save workflow
async function saveWorkflow() {
  if (!modeler) return

  saving.value = true
  try {
    const { xml } = await modeler.saveXML({ format: true })

    const payload = {
      name: workflowName.value || '未命名工作流',
      description: workflowDescription.value,
      version: workflowVersion.value,
      bpmnXml: xml
    }

    const url = workflowId.value
      ? `/api/workflow-designer/workflows/${workflowId.value}`
      : '/api/workflow-designer/workflows'

    const response = await fetch(url, {
      method: workflowId.value ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!response.ok) throw new Error('Failed to save workflow')

    const data = await response.json()
    if (!workflowId.value) {
      workflowId.value = data.id
      // Update URL without reload
      router.replace({ params: { id: data.id } })
    }

    isDirty.value = false
    lastSaved.value = new Date()
    ElMessage.success('工作流保存成功')
  } catch (err) {
    console.error('Failed to save workflow:', err)
    ElMessage.error('保存工作流失败')
  } finally {
    saving.value = false
  }
}

// Deploy workflow
async function deployWorkflow() {
  if (!workflowId.value) {
    ElMessage.warning('请先保存工作流')
    return
  }

  if (isDirty.value) {
    await ElMessageBox.confirm('有未保存的更改，是否先保存？', '提示', {
      confirmButtonText: '保存并部署',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await saveWorkflow()
  }

  deploying.value = true
  try {
    const response = await fetch(`/api/workflow/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: workflowId.value })
    })

    if (!response.ok) throw new Error('Failed to deploy workflow')

    ElMessage.success('工作流部署成功')
  } catch (err) {
    console.error('Failed to deploy workflow:', err)
    ElMessage.error('部署工作流失败')
  } finally {
    deploying.value = false
  }
}

// Validate workflow
function validateWorkflow() {
  if (!modeler) return

  validationErrors.value = []

  const elementRegistry = modeler.get('elementRegistry') as {
    getAll: () => BpmnElement[]
    filter: (fn: (e: BpmnElement) => boolean) => BpmnElement[]
  }
  const elements = elementRegistry.getAll()

  // Check for start event
  const startEvents = elements.filter(e => e.type === 'bpmn:StartEvent')
  if (startEvents.length === 0) {
    validationErrors.value.push({
      message: '工作流缺少开始事件',
      severity: 'error'
    })
  } else if (startEvents.length > 1) {
    validationErrors.value.push({
      message: '工作流有多个开始事件',
      severity: 'warning'
    })
  }

  // Check for end event
  const endEvents = elements.filter(e => e.type === 'bpmn:EndEvent')
  if (endEvents.length === 0) {
    validationErrors.value.push({
      message: '工作流缺少结束事件',
      severity: 'error'
    })
  }

  // Check for unconnected elements
  elements.forEach(element => {
    if (element.type.includes('Task') || element.type.includes('Gateway')) {
      const incoming = (element as { incoming?: unknown[] }).incoming || []
      const outgoing = (element as { outgoing?: unknown[] }).outgoing || []

      if (incoming.length === 0) {
        validationErrors.value.push({
          message: '元素没有入口连接',
          severity: 'warning',
          element: element.businessObject?.name || element.id
        })
      }
      if (outgoing.length === 0) {
        validationErrors.value.push({
          message: '元素没有出口连接',
          severity: 'warning',
          element: element.businessObject?.name || element.id
        })
      }
    }
  })

  showValidation.value = true
}

// Navigation
function goBack() {
  if (isDirty.value) {
    ElMessageBox.confirm('有未保存的更改，确定要离开吗？', '提示', {
      confirmButtonText: '离开',
      cancelButtonText: '取消',
      type: 'warning'
    }).then(() => {
      router.back()
    }).catch(() => {})
  } else {
    router.back()
  }
}

// Format time
function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// Watch for unsaved changes warning
watch(isDirty, (dirty) => {
  if (dirty) {
    window.onbeforeunload = () => '有未保存的更改'
  } else {
    window.onbeforeunload = null
  }
})
</script>

<style scoped>
.workflow-designer {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-page);
}

/* Header */
.designer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.workflow-name {
  font-size: 16px;
  font-weight: 500;
}

.header-center {
  display: flex;
  align-items: center;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Main Content */
.designer-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

/* Tool Palette */
.tool-palette {
  width: 200px;
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-light);
  overflow-y: auto;
  padding: 12px;
}

.palette-section {
  margin-bottom: 16px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  text-transform: uppercase;
  margin-bottom: 8px;
  padding-left: 4px;
}

.palette-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  cursor: grab;
  transition: background 0.2s;
  margin-bottom: 4px;
}

.palette-item:hover {
  background: var(--el-fill-color-light);
}

.palette-item:active {
  cursor: grabbing;
}

.item-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-size: 14px;
}

.item-label {
  font-size: 13px;
  color: var(--el-text-color-regular);
}

/* Canvas Container */
.canvas-container {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.bpmn-canvas {
  width: 100%;
  height: 100%;
}

.drop-zone {
  position: absolute;
  inset: 0;
  background: rgba(64, 158, 255, 0.1);
  border: 2px dashed var(--el-color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: var(--el-color-primary);
  pointer-events: all;
}

/* Properties Panel */
.properties-panel {
  width: 280px;
  background: var(--el-bg-color);
  border-left: 1px solid var(--el-border-color-light);
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-light);
  font-weight: 500;
}

.panel-content {
  flex: 1;
  padding: 16px;
  overflow-y: auto;
}

/* Slide animation */
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 0.2s ease;
}

.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(100%);
}

/* Footer */
.designer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color-light);
}

.minimap {
  width: 150px;
  height: 100px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.footer-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

/* Validation */
.validation-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px;
  text-align: center;
}

.validation-success p {
  margin-top: 12px;
  color: var(--el-text-color-secondary);
}

.validation-errors {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.validation-item {
  margin-bottom: 0;
}

/* BPMN.js overrides */
:deep(.bjs-powered-by) {
  display: none;
}

:deep(.djs-palette) {
  display: none;
}

:deep(.djs-context-pad) {
  background: var(--el-bg-color);
  border-radius: 6px;
  box-shadow: var(--el-box-shadow-light);
}
</style>
