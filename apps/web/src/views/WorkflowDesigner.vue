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
        <el-button @click="openTemplatePicker">
          <el-icon><Document /></el-icon>
          模板
        </el-button>
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
        <el-button type="success" @click="deployWorkflow" :loading="deploying">
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
                    <el-input
                      id="workflow-task-assignee"
                      v-model="taskAssignee"
                      name="taskAssignee"
                      placeholder="输入执行人"
                    />
                  </el-form-item>
                  <el-form-item label="候选人">
                    <el-input
                      id="workflow-task-candidates"
                      v-model="taskCandidates"
                      name="taskCandidates"
                      placeholder="多人用逗号分隔"
                    />
                  </el-form-item>
                  <el-form-item label="到期时间">
                    <el-input
                      id="workflow-task-due-date"
                      v-model="taskDueDate"
                      name="taskDueDate"
                      placeholder="如: PT1H (1小时)"
                    />
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

    <WorkflowTemplateDialog
      v-model="showTemplates"
      :template-loading="templateLoading"
      :applying-template="applyingTemplate"
      :template-error="templateError"
      :template-search="templateSearch"
      :template-source="templateSource"
      :template-items="templateItems"
      :template-pagination="templatePagination"
      :template-range-label="templateRangeLabel"
      :recent-template-items="recentTemplateItems"
      :selected-template-id="selectedTemplateId"
      :selected-template="selectedTemplate"
      @update:template-search="templateSearch = $event"
      @update:template-source="templateSource = $event"
      @refresh-catalog="refreshTemplateCatalog"
      @select-template="selectTemplate"
      @select-recent-template="selectRecentTemplate"
      @apply-selected="applyTemplate(selectedTemplateId || undefined)"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick, markRaw } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import {
  ElAlert,
  ElButton,
  ElButtonGroup,
  ElDialog,
  ElDivider,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElTag,
} from 'element-plus'
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
import 'element-plus/es/components/alert/style/css'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/button-group/style/css'
import 'element-plus/es/components/dialog/style/css'
import 'element-plus/es/components/divider/style/css'
import 'element-plus/es/components/form/style/css'
import 'element-plus/es/components/form-item/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import 'element-plus/es/components/option/style/css'
import 'element-plus/es/components/select/style/css'
import 'element-plus/es/components/tag/style/css'
import type { WorkflowModelerInstance } from './workflowDesignerRuntime'
import {
  DEFAULT_WORKFLOW_XML,
  deploySavedWorkflowDraft,
  deployWorkflowXml,
  instantiateWorkflowTemplate,
  loadWorkflowDraft,
  saveWorkflowDraft,
  type WorkflowDesignerPagination,
  type WorkflowDesignerTemplateDetail,
  type WorkflowDesignerTemplateListItem,
} from './workflowDesignerPersistence'
import {
  invalidateWorkflowDraftCatalogCache,
  invalidateWorkflowTemplateCatalogCache,
  invalidateWorkflowTemplateDetailCache,
  listWorkflowTemplatesCached,
  loadWorkflowTemplateCached,
} from './workflowDesignerCatalogCache'
import {
  buildRecentWorkflowTemplateItem,
  readRecentWorkflowTemplates,
  rememberRecentWorkflowTemplate,
  type RecentWorkflowTemplateItem,
} from './workflowDesignerRecentTemplates'
import { validateWorkflowElements } from './workflowDesignerValidation'
import WorkflowTemplateDialog from '../components/workflow/WorkflowTemplateDialog.vue'

// Types
interface PaletteItem {
  type: string
  label: string
  icon: typeof VideoPlay
  color: string
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
let modeler: WorkflowModelerInstance | null = null

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
const showTemplates = ref(false)
const validationErrors = ref<ReturnType<typeof validateWorkflowElements>>([])
const templateLoading = ref(false)
const applyingTemplate = ref(false)
const templateError = ref('')
const templateSearch = ref('')
const templateSource = ref<'all' | 'builtin' | 'database'>('all')
const templateItems = ref<WorkflowDesignerTemplateListItem[]>([])
const templatePagination = ref<WorkflowDesignerPagination>({
  total: 0,
  limit: 6,
  offset: 0,
  returned: 0,
})
const recentTemplateItems = ref<RecentWorkflowTemplateItem[]>([])
const selectedTemplateId = ref<string | null>(null)
const selectedTemplate = ref<WorkflowDesignerTemplateDetail | null>(null)

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

const templateRangeLabel = computed(() => {
  if (!templatePagination.value.total) return '0 items'
  const start = templatePagination.value.offset + 1
  const end = templatePagination.value.offset + templatePagination.value.returned
  return `${start}-${end} / ${templatePagination.value.total}`
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
  } else if (typeof route.query.templateId === 'string' && route.query.templateId) {
    await createNewWorkflow()
    await applyTemplate(route.query.templateId, { skipConfirm: true })
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

  const { createWorkflowModeler } = await import('./workflowDesignerRuntime')

  modeler = markRaw(createWorkflowModeler({
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

function refreshRecentTemplateItems() {
  recentTemplateItems.value = readRecentWorkflowTemplates()
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
  try {
    workflowId.value = null
    await modeler?.importXML(DEFAULT_WORKFLOW_XML)
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
    const data = await loadWorkflowDraft(id)
    workflowId.value = id
    workflowName.value = data.name
    workflowDescription.value = data.description
    workflowVersion.value = data.version
    await modeler?.importXML(data.bpmnXml)
    await nextTick()
    fitViewport()
    updateCounts()

    isDirty.value = false
    ElMessage.success('工作流加载成功')
  } catch (err) {
    console.error('Failed to load workflow:', err)
    ElMessage.error(err instanceof Error ? err.message : '加载工作流失败')
    await createNewWorkflow()
  }
}

async function refreshTemplateCatalog(offset = templatePagination.value.offset) {
  templateLoading.value = true
  templateError.value = ''

  try {
    const result = await listWorkflowTemplatesCached({
      search: templateSearch.value.trim() || undefined,
      source: templateSource.value,
      sortBy: 'usage_count',
      sortOrder: 'desc',
      limit: templatePagination.value.limit,
      offset,
    })

    templateItems.value = result.items
    templatePagination.value = {
      ...result.pagination,
      limit: templatePagination.value.limit,
    }

    const nextSelected = selectedTemplateId.value && result.items.some((item) => item.id === selectedTemplateId.value)
      ? selectedTemplateId.value
      : result.items[0]?.id

    if (nextSelected) {
      await selectTemplate(nextSelected)
    } else {
      selectedTemplateId.value = null
      selectedTemplate.value = null
    }
  } catch (error) {
    templateError.value = error instanceof Error ? error.message : '加载模板失败'
    templateItems.value = []
    selectedTemplateId.value = null
    selectedTemplate.value = null
    templatePagination.value = {
      ...templatePagination.value,
      total: 0,
      offset: 0,
      returned: 0,
    }
  } finally {
    templateLoading.value = false
  }
}

async function selectTemplate(templateId: string) {
  selectedTemplateId.value = templateId
  try {
    selectedTemplate.value = await loadWorkflowTemplateCached(templateId)
  } catch (error) {
    templateError.value = error instanceof Error ? error.message : '加载模板详情失败'
    selectedTemplate.value = null
  }
}

async function selectRecentTemplate(templateId: string) {
  await selectTemplate(templateId)
}

async function openTemplatePicker() {
  refreshRecentTemplateItems()
  showTemplates.value = true
  if (!templateItems.value.length) {
    await refreshTemplateCatalog(0)
  }
}

async function applyTemplate(templateId?: string, options: { skipConfirm?: boolean } = {}) {
  if (!templateId) return

  if (!options.skipConfirm && (isDirty.value || workflowId.value)) {
    await ElMessageBox.confirm('应用模板会创建一个新的工作流草稿并切换当前设计器，是否继续？', '提示', {
      confirmButtonText: '继续',
      cancelButtonText: '取消',
      type: 'warning',
    })
  }

  applyingTemplate.value = true
  try {
    const templateRecord =
      selectedTemplate.value?.id === templateId
        ? selectedTemplate.value
        : await loadWorkflowTemplateCached(templateId)

    const result = await instantiateWorkflowTemplate({
      templateId,
      name: !workflowId.value && workflowName.value.trim() ? workflowName.value.trim() : undefined,
    })

    invalidateWorkflowDraftCatalogCache()
    invalidateWorkflowTemplateCatalogCache()
    invalidateWorkflowTemplateDetailCache(templateId)

    if (!result.workflowId) {
      throw new Error('模板实例化后未返回工作流 ID')
    }

    recentTemplateItems.value = rememberRecentWorkflowTemplate(buildRecentWorkflowTemplateItem(templateRecord))

    await router.replace({
      name: 'workflow-designer',
      params: { id: result.workflowId },
      query: {},
    })

    showTemplates.value = false
    await loadWorkflow(result.workflowId)
    lastSaved.value = new Date()
    ElMessage.success(result.message || '模板已应用')
  } catch (error) {
    if (error === 'cancel') return
    console.error('Failed to apply template:', error)
    ElMessage.error(error instanceof Error ? error.message : '应用模板失败')
  } finally {
    applyingTemplate.value = false
  }
}

refreshRecentTemplateItems()

// Save workflow
async function saveWorkflow() {
  if (!modeler) return false

  saving.value = true
  try {
    const { xml } = await modeler.saveXML({ format: true })

    const saved = await saveWorkflowDraft({
      workflowId: workflowId.value,
      name: workflowName.value,
      description: workflowDescription.value,
      version: workflowVersion.value,
      bpmnXml: xml,
    })
    invalidateWorkflowDraftCatalogCache()

    if (!workflowId.value && saved.workflowId) {
      workflowId.value = saved.workflowId
      // Update URL without reload
      router.replace({ params: { id: saved.workflowId } })
    }

    isDirty.value = false
    lastSaved.value = new Date()
    ElMessage.success(saved.message || '工作流保存成功')
    return true
  } catch (err) {
    console.error('Failed to save workflow:', err)
    ElMessage.error(err instanceof Error ? err.message : '保存工作流失败')
    return false
  } finally {
    saving.value = false
  }
}

// Deploy workflow
async function deployWorkflow() {
  if (!modeler) {
    return
  }

  const hasUnsavedChanges = isDirty.value || !workflowId.value

  if (hasUnsavedChanges) {
    await ElMessageBox.confirm('部署前将先保存当前草稿并发布，是否继续？', '提示', {
      confirmButtonText: '保存并部署',
      cancelButtonText: '取消',
      type: 'warning',
    })
  }

  deploying.value = true
  try {
    let deployed

    if (hasUnsavedChanges) {
      const saved = await saveWorkflow()
      if (!saved || !workflowId.value) return
      deployed = await deploySavedWorkflowDraft(workflowId.value)
    } else if (workflowId.value) {
      deployed = await deploySavedWorkflowDraft(workflowId.value)
    } else {
      const { xml } = await modeler.saveXML({ format: true })
      deployed = await deployWorkflowXml({
        name: workflowName.value,
        description: workflowDescription.value,
        bpmnXml: xml,
      })
    }

    ElMessage.success(deployed.message || '工作流部署成功')
  } catch (err) {
    if (err === 'cancel') return
    console.error('Failed to deploy workflow:', err)
    ElMessage.error(err instanceof Error ? err.message : '部署工作流失败')
  } finally {
    deploying.value = false
  }
}

// Validate workflow
function validateWorkflow() {
  if (!modeler) return

  const elementRegistry = modeler.get('elementRegistry') as {
    getAll: () => BpmnElement[]
  }
  validationErrors.value = validateWorkflowElements(elementRegistry.getAll())
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

.template-dialog {
  display: grid;
  gap: 16px;
  grid-template-columns: minmax(320px, 0.9fr) minmax(0, 1.1fr);
}

.template-dialog__catalog,
.template-dialog__detail {
  display: grid;
  gap: 14px;
  min-height: 420px;
}

.template-dialog__recent {
  padding: 14px;
  border-radius: 12px;
  border: 1px solid #dbeafe;
  background: linear-gradient(180deg, #f8fbff 0%, #eef6ff 100%);
}

.template-dialog__toolbar,
.template-dialog__pager,
.template-dialog__pager-actions,
.template-dialog__item-top,
.template-dialog__meta-grid,
.template-dialog__tag-list {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.template-dialog__list {
  display: grid;
  gap: 10px;
  max-height: 420px;
  overflow: auto;
}

.template-dialog__item {
  padding: 14px;
  border-radius: 12px;
  border: 1px solid var(--el-border-color-light);
  background: #fff;
  text-align: left;
  display: grid;
  gap: 10px;
  cursor: pointer;
}

.template-dialog__item.is-active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.12);
}

.template-dialog__item p,
.template-dialog__detail-header p {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.template-dialog__meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.template-dialog__badge,
.template-dialog__tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}

.template-dialog__badge {
  background: #eff6ff;
  color: #1d4ed8;
}

.template-dialog__badge[data-source='builtin'] {
  background: #ecfccb;
  color: #3f6212;
}

.template-dialog__badge[data-source='database'] {
  background: #ede9fe;
  color: #7c3aed;
}

.template-dialog__detail {
  border: 1px solid var(--el-border-color-light);
  border-radius: 14px;
  padding: 16px;
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
}

.template-dialog__detail-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.template-dialog__detail-header h3,
.template-dialog__detail-block h4 {
  margin: 0;
}

.template-dialog__meta-grid > div,
.template-dialog__detail-block {
  display: grid;
  gap: 6px;
}

.template-dialog__tag-list--buttons {
  gap: 10px;
}

.template-dialog__meta-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.template-dialog__tag {
  background: #f3f4f6;
  color: #374151;
}

.template-dialog__recent-chip {
  border: 1px solid #dbeafe;
  background: #fff;
  border-radius: 999px;
  padding: 8px 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #1f2937;
}

.template-dialog__recent-chip small {
  color: #64748b;
  text-transform: uppercase;
}

.template-dialog__empty,
.template-dialog__error {
  padding: 18px;
  border-radius: 12px;
  background: #f8fafc;
  color: #475569;
}

.template-dialog__error {
  background: #fef2f2;
  color: #b91c1c;
}

@media (max-width: 960px) {
  .template-dialog {
    grid-template-columns: 1fr;
  }
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
