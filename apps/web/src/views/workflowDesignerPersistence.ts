import { useAuth } from '../composables/useAuth'
import type { WorkflowHubRouteState } from './workflowHubQueryState'

interface WorkflowEnvelope<T> {
  success?: boolean
  data?: T
  message?: string
  error?: string | { message?: string }
}

interface WorkflowEnvelopePayload extends Record<string, unknown> {
  id?: string
  workflowId?: string
  name?: string
  description?: string | null
  version?: string | number | null
  bpmnXml?: string
  bpmn?: string
  xml?: string
  message?: string
}

export interface LoadedWorkflowDraft {
  id?: string
  name: string
  description: string
  version: string
  bpmnXml: string
  raw: unknown
}

export interface SaveWorkflowDraftInput {
  workflowId?: string | null
  name: string
  description: string
  version: string
  bpmnXml: string
}

export interface SavedWorkflowDraft {
  workflowId?: string
  message?: string
  raw: unknown
}

export interface WorkflowDraftActionResult extends SavedWorkflowDraft {
  sourceWorkflowId?: string
  status?: string
}

export interface DeployWorkflowInput {
  name: string
  description?: string
  category?: string
  key?: string
  bpmnXml: string
}

export interface WorkflowDeploymentResult {
  definitionId?: string
  message?: string
  raw: unknown
}

export interface WorkflowDesignerPagination {
  total: number
  limit: number
  offset: number
  returned: number
}

export interface WorkflowDesignerTemplateListItem {
  id: string
  name: string
  description: string
  category: string
  requiredVariables: string[]
  optionalVariables: string[]
  tags: string[]
  featured: boolean
  source: 'builtin' | 'database'
  usageCount: number
  updatedAt?: string
  raw: unknown
}

export interface WorkflowDesignerTemplateDetail extends WorkflowDesignerTemplateListItem {
  definition: Record<string, unknown>
}

export interface WorkflowDesignerWorkflowListItem {
  id: string
  name: string
  description: string
  category: string | null
  status: string
  role: 'owner' | 'editor' | 'viewer' | null
  createdAt?: string
  updatedAt?: string
  raw: unknown
}

export interface WorkflowDesignerTemplateQuery {
  category?: string
  featured?: boolean
  search?: string
  source?: 'all' | 'builtin' | 'database'
  sortBy?: 'usage_count' | 'name' | 'updated_at'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface InstantiateWorkflowTemplateInput {
  templateId: string
  name?: string
  description?: string
  category?: string
}

export interface WorkflowDesignerWorkflowQuery {
  category?: string
  status?: string
  search?: string
  sortBy?: 'updated_at' | 'created_at' | 'name'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface WorkflowHubTeamView {
  id: string
  name: string
  scope: 'team'
  ownerUserId: string
  canManage: boolean
  state: WorkflowHubRouteState
  createdAt?: string
  updatedAt?: string
  raw: unknown
}

export const DEFAULT_WORKFLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
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

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback

  const record = payload as Record<string, unknown>

  if (typeof record.error === 'string' && record.error.trim()) return record.error
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message
  }
  if (typeof record.message === 'string' && record.message.trim()) return record.message

  return fallback
}

function unwrapEnvelope(payload: unknown): WorkflowEnvelopePayload {
  if (!payload || typeof payload !== 'object') return {}

  const envelope = payload as WorkflowEnvelope<WorkflowEnvelopePayload> & Record<string, unknown>
  if (envelope.success === false) {
    throw new Error(extractErrorMessage(payload, '请求失败'))
  }

  if (envelope.data && typeof envelope.data === 'object') {
    return envelope.data
  }

  return envelope as WorkflowEnvelopePayload
}

function unwrapListEnvelope(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return {
      data: [] as Record<string, unknown>[],
      metadata: {},
    }
  }

  const envelope = payload as Record<string, unknown>
  if (envelope.success === false) {
    throw new Error(extractErrorMessage(payload, '请求失败'))
  }

  return {
    data: Array.isArray(envelope.data)
      ? envelope.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : [],
    metadata: envelope.metadata && typeof envelope.metadata === 'object'
      ? envelope.metadata as Record<string, unknown>
      : {},
  }
}

function normalizePagination(metadata: Record<string, unknown>, fallbackCount: number): WorkflowDesignerPagination {
  const total = typeof metadata.total === 'number' ? metadata.total : fallbackCount
  const limit = typeof metadata.limit === 'number' ? metadata.limit : fallbackCount
  const offset = typeof metadata.offset === 'number' ? metadata.offset : 0
  const returned = typeof metadata.returned === 'number' ? metadata.returned : fallbackCount

  return { total, limit, offset, returned }
}

function buildQueryString(query: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    params.set(key, String(value))
  }

  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

function normalizeWorkflowHubRouteState(value: unknown): WorkflowHubRouteState {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}

  return {
    workflowSearch: typeof record.workflowSearch === 'string' ? record.workflowSearch : '',
    workflowStatus:
      record.workflowStatus === 'draft' || record.workflowStatus === 'published' || record.workflowStatus === 'archived'
        ? record.workflowStatus
        : '',
    workflowSortBy:
      record.workflowSortBy === 'created_at' || record.workflowSortBy === 'name'
        ? record.workflowSortBy
        : 'updated_at',
    workflowOffset: typeof record.workflowOffset === 'number' ? record.workflowOffset : 0,
    templateSearch: typeof record.templateSearch === 'string' ? record.templateSearch : '',
    templateSource:
      record.templateSource === 'builtin' || record.templateSource === 'database'
        ? record.templateSource
        : 'all',
    templateSortBy:
      record.templateSortBy === 'name' || record.templateSortBy === 'updated_at'
        ? record.templateSortBy
        : 'usage_count',
    templateOffset: typeof record.templateOffset === 'number' ? record.templateOffset : 0,
  }
}

async function requestJson(path: string, init: RequestInit = {}) {
  const { buildAuthHeaders } = useAuth()
  const response = await fetch(path, {
    ...init,
    headers: {
      ...buildAuthHeaders(),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  return { response, payload }
}

export function normalizeLoadedWorkflow(payload: unknown, workflowId: string): LoadedWorkflowDraft {
  const data = unwrapEnvelope(payload)
  const bpmnXml =
    typeof data.bpmnXml === 'string'
      ? data.bpmnXml
      : typeof data.bpmn === 'string'
        ? data.bpmn
        : typeof data.xml === 'string'
          ? data.xml
          : ''

  if (!bpmnXml.trim()) {
    throw new Error('当前部署返回的是可视化工作流定义，未包含 BPMN XML，无法直接回填到 BPMN 设计器。')
  }

  return {
    id: typeof data.id === 'string' ? data.id : workflowId,
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : '',
    version: data.version == null ? '1.0.0' : String(data.version),
    bpmnXml,
    raw: payload,
  }
}

export function normalizeSavedWorkflow(payload: unknown, workflowId?: string | null): SavedWorkflowDraft {
  const data = unwrapEnvelope(payload)

  return {
    workflowId:
      typeof data.workflowId === 'string'
        ? data.workflowId
        : typeof data.id === 'string'
          ? data.id
          : workflowId ?? undefined,
    message: typeof data.message === 'string' ? data.message : undefined,
    raw: payload,
  }
}

export function createWorkflowDeploymentPayload(input: DeployWorkflowInput) {
  return {
    name: input.name.trim() || '未命名工作流',
    description: input.description?.trim() || '',
    category: input.category?.trim() || '',
    key: input.key?.trim() || '',
    bpmnXml: input.bpmnXml,
  }
}

export async function loadWorkflowDraft(workflowId: string): Promise<LoadedWorkflowDraft> {
  const { response, payload } = await requestJson(`/api/workflow-designer/workflows/${workflowId}`)
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '加载工作流失败'))
  }
  return normalizeLoadedWorkflow(payload, workflowId)
}

export async function saveWorkflowDraft(input: SaveWorkflowDraftInput): Promise<SavedWorkflowDraft> {
  const path = input.workflowId
    ? `/api/workflow-designer/workflows/${input.workflowId}`
    : '/api/workflow-designer/workflows'
  const method = input.workflowId ? 'PUT' : 'POST'
  const payload = {
    name: input.name.trim() || '未命名工作流',
    description: input.description,
    version: input.version,
    bpmnXml: input.bpmnXml,
  }

  const { response, payload: data } = await requestJson(path, {
    method,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(data, '保存工作流失败'))
  }

  return normalizeSavedWorkflow(data, input.workflowId)
}

export async function deployWorkflowXml(input: DeployWorkflowInput): Promise<WorkflowDeploymentResult> {
  const payload = createWorkflowDeploymentPayload(input)
  const { response, payload: data } = await requestJson('/api/workflow/deploy', {
    method: 'POST',
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(data, '部署工作流失败'))
  }

  const result = unwrapEnvelope(data)
  return {
    definitionId: typeof result.definitionId === 'string' ? result.definitionId : undefined,
    message: typeof result.message === 'string' ? result.message : undefined,
    raw: data,
  }
}

export async function deploySavedWorkflowDraft(workflowId: string): Promise<WorkflowDeploymentResult> {
  const { response, payload: data } = await requestJson(`/api/workflow-designer/workflows/${workflowId}/deploy`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(data, '部署工作流失败'))
  }

  const result = unwrapEnvelope(data)
  return {
    definitionId:
      typeof result.deploymentId === 'string'
        ? result.deploymentId
        : typeof result.definitionId === 'string'
          ? result.definitionId
          : undefined,
    message: typeof result.message === 'string' ? result.message : undefined,
    raw: data,
  }
}

export async function listWorkflowTemplates(query: WorkflowDesignerTemplateQuery = {}) {
  const { response, payload } = await requestJson(`/api/workflow-designer/templates${buildQueryString({
    category: query.category,
    featured: query.featured,
    search: query.search,
    source: query.source,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit: query.limit,
    offset: query.offset,
  })}`)

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '加载工作流模板失败'))
  }

  const { data, metadata } = unwrapListEnvelope(payload)
  return {
    items: data.map((item): WorkflowDesignerTemplateListItem => {
      const source: WorkflowDesignerTemplateListItem['source'] = item.source === 'database' ? 'database' : 'builtin'

      return {
        id: typeof item.id === 'string' ? item.id : '',
        name: typeof item.name === 'string' ? item.name : '',
        description: typeof item.description === 'string' ? item.description : '',
        category: typeof item.category === 'string' ? item.category : 'general',
        requiredVariables: Array.isArray(item.required_variables)
          ? item.required_variables.filter((entry): entry is string => typeof entry === 'string')
          : [],
        optionalVariables: Array.isArray(item.optional_variables)
          ? item.optional_variables.filter((entry): entry is string => typeof entry === 'string')
          : [],
        tags: Array.isArray(item.tags)
          ? item.tags.filter((entry): entry is string => typeof entry === 'string')
          : [],
        featured: item.is_featured === true,
        source,
        usageCount: typeof item.usage_count === 'number' ? item.usage_count : 0,
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
        raw: item,
      }
    }),
    pagination: normalizePagination(metadata, data.length),
    raw: payload,
  }
}

export async function loadWorkflowTemplate(templateId: string): Promise<WorkflowDesignerTemplateDetail> {
  const { response, payload } = await requestJson(`/api/workflow-designer/templates/${templateId}`)

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '加载工作流模板失败'))
  }

  const data = unwrapEnvelope(payload)
  const definition = data.template_definition && typeof data.template_definition === 'object'
    ? data.template_definition as Record<string, unknown>
    : {}

  return {
    id: typeof data.id === 'string' ? data.id : templateId,
    name: typeof data.name === 'string' ? data.name : '',
    description: typeof data.description === 'string' ? data.description : '',
    category: typeof data.category === 'string' ? data.category : 'general',
    requiredVariables: Array.isArray(data.required_variables)
      ? data.required_variables.filter((entry): entry is string => typeof entry === 'string')
      : [],
    optionalVariables: Array.isArray(data.optional_variables)
      ? data.optional_variables.filter((entry): entry is string => typeof entry === 'string')
      : [],
    tags: Array.isArray(data.tags)
      ? data.tags.filter((entry): entry is string => typeof entry === 'string')
      : [],
    featured: data.is_featured === true,
    source: data.source === 'database' ? 'database' : 'builtin',
    usageCount: typeof data.usage_count === 'number' ? data.usage_count : 0,
    updatedAt: typeof data.updated_at === 'string' ? data.updated_at : undefined,
    definition,
    raw: payload,
  }
}

export async function instantiateWorkflowTemplate(input: InstantiateWorkflowTemplateInput): Promise<SavedWorkflowDraft> {
  const { response, payload } = await requestJson(`/api/workflow-designer/templates/${input.templateId}/instantiate`, {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      category: input.category,
    }),
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '根据模板创建工作流失败'))
  }

  return normalizeSavedWorkflow(payload)
}

export interface AttendanceApprovalFlowWorkflowLinkResult {
  id: string
  workflowId: string | null
  name: string
  requestType: string
}

export async function linkAttendanceApprovalFlowWorkflow(
  approvalFlowId: string,
  workflowId: string | null,
): Promise<AttendanceApprovalFlowWorkflowLinkResult> {
  const { response, payload } = await requestJson(`/api/attendance/approval-flows/${approvalFlowId}/workflow-link`, {
    method: 'PUT',
    body: JSON.stringify({ workflowId }),
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '绑定审批流工作流草稿失败'))
  }

  const data = unwrapEnvelope(payload)
  return {
    id: typeof data.id === 'string' ? data.id : approvalFlowId,
    workflowId: typeof data.workflowId === 'string' && data.workflowId.trim() ? data.workflowId : null,
    name: typeof data.name === 'string' ? data.name : '',
    requestType: typeof data.requestType === 'string' ? data.requestType : '',
  }
}

export async function duplicateWorkflowDraft(workflowId: string, name?: string): Promise<WorkflowDraftActionResult> {
  const { response, payload } = await requestJson(`/api/workflow-designer/workflows/${workflowId}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '复制工作流失败'))
  }

  const data = unwrapEnvelope(payload)
  return {
    ...normalizeSavedWorkflow(payload),
    sourceWorkflowId: typeof data.sourceWorkflowId === 'string' ? data.sourceWorkflowId : workflowId,
  }
}

export async function archiveWorkflowDraft(workflowId: string): Promise<WorkflowDraftActionResult> {
  const { response, payload } = await requestJson(`/api/workflow-designer/workflows/${workflowId}/archive`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '归档工作流失败'))
  }

  const data = unwrapEnvelope(payload)
  return {
    ...normalizeSavedWorkflow(payload, workflowId),
    status: typeof data.status === 'string' ? data.status : undefined,
  }
}

export async function restoreWorkflowDraft(workflowId: string): Promise<WorkflowDraftActionResult> {
  const { response, payload } = await requestJson(`/api/workflow-designer/workflows/${workflowId}/restore`, {
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '恢复工作流失败'))
  }

  const data = unwrapEnvelope(payload)
  return {
    ...normalizeSavedWorkflow(payload, workflowId),
    status: typeof data.status === 'string' ? data.status : undefined,
  }
}

export async function listWorkflowDrafts(query: WorkflowDesignerWorkflowQuery = {}) {
  const { response, payload } = await requestJson(`/api/workflow-designer/workflows${buildQueryString({
    category: query.category,
    status: query.status,
    search: query.search,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    limit: query.limit,
    offset: query.offset,
  })}`)

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '加载工作流列表失败'))
  }

  const { data, metadata } = unwrapListEnvelope(payload)
  return {
    items: data.map((item): WorkflowDesignerWorkflowListItem => {
      const role: WorkflowDesignerWorkflowListItem['role'] =
        item.role === 'owner' || item.role === 'editor' || item.role === 'viewer' ? item.role : null

      return {
        id: typeof item.id === 'string' ? item.id : '',
        name: typeof item.name === 'string' ? item.name : '',
        description: typeof item.description === 'string' ? item.description : '',
        category: typeof item.category === 'string' ? item.category : null,
        status: typeof item.status === 'string' ? item.status : 'draft',
        role,
        createdAt: typeof item.created_at === 'string' ? item.created_at : undefined,
        updatedAt: typeof item.updated_at === 'string' ? item.updated_at : undefined,
        raw: item,
      }
    }),
    pagination: normalizePagination(metadata, data.length),
    raw: payload,
  }
}

export async function listWorkflowHubTeamViews() {
  const { response, payload } = await requestJson('/api/workflow-designer/hub-views/team')

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '加载团队视图失败'))
  }

  const { data } = unwrapListEnvelope(payload)
  return {
    items: data.map((item): WorkflowHubTeamView => ({
      id: typeof item.id === 'string' ? item.id : '',
      name: typeof item.name === 'string' ? item.name : '',
      scope: 'team',
      ownerUserId: typeof item.ownerUserId === 'string' ? item.ownerUserId : '',
      canManage: item.canManage === true,
      state: normalizeWorkflowHubRouteState(item.state),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : undefined,
      raw: item,
    })),
    raw: payload,
  }
}

export async function saveWorkflowHubTeamView(name: string, state: WorkflowHubRouteState): Promise<WorkflowHubTeamView> {
  const { response, payload } = await requestJson('/api/workflow-designer/hub-views/team', {
    method: 'POST',
    body: JSON.stringify({
      name,
      state,
    }),
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '保存团队视图失败'))
  }

  const data = unwrapEnvelope(payload)
  return {
    id: typeof data.id === 'string' ? data.id : '',
    name: typeof data.name === 'string' ? data.name : name.trim(),
    scope: 'team',
    ownerUserId: typeof data.ownerUserId === 'string' ? data.ownerUserId : '',
    canManage: data.canManage === true,
    state: normalizeWorkflowHubRouteState(data.state),
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
    raw: payload,
  }
}

export async function deleteWorkflowHubTeamView(viewId: string) {
  const { response, payload } = await requestJson(`/api/workflow-designer/hub-views/team/${viewId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, '删除团队视图失败'))
  }

  return unwrapEnvelope(payload)
}
