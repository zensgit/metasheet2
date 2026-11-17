import type { RouteLocationRaw } from 'vue-router'
import { AppRouteNames } from '../router/types'

export const BUSINESS_CHECK_ENDPOINT = '/api/permissions/v2/business-check'

export const RESOURCE_ID_FIELDS = ['baseId', 'sheetId', 'viewId', 'recordId', 'fieldId'] as const

export type ResourceIdField = (typeof RESOURCE_ID_FIELDS)[number]

export type ResourceIdInput = Partial<Record<ResourceIdField, string>>

export type BusinessCheckPhase =
  | 'idle'
  | 'pending'
  | 'allow'
  | 'deny'
  | 'unknown'
  | 'forbidden'
  | 'unavailable'
  | 'missing'
  | 'error'

export type BusinessCheckView = {
  phase: BusinessCheckPhase
  detail: string
}

type GuardPolicy = {
  kind: 'guard'
  policyId: string
  label: string
  mode: 'single' | 'any'
  permissions: readonly string[]
}

type ResourcePolicy = {
  kind: 'resource'
  policyId: string
  label: string
  resourceFields: readonly ResourceIdField[]
  note: string
}

export type BusinessCheckPolicy = GuardPolicy | ResourcePolicy

export type BusinessGuardCheckRequest = {
  subject: { kind: 'target'; userId: string }
  policyId: string
  mode: 'single' | 'any'
  permissions: string[]
}

export type BusinessResourceCheckRequest = {
  subject: { kind: 'target'; userId: string }
  policyId: string
  resource: { kind: 'sheet'; [key: string]: string }
}

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/
const CHECK_RESULTS = new Set(['allow', 'deny', 'unknown'])
const CHECK_LAYERS = new Set(['business_guard', 'resource_visibility', 'resource_context'])

export const BUSINESS_CHECK_POLICIES: readonly BusinessCheckPolicy[] = [
  {
    kind: 'guard',
    policyId: 'attendance.decision-trace',
    label: '考勤判定追踪',
    mode: 'single',
    permissions: ['attendance:read'],
  },
  {
    kind: 'guard',
    policyId: 'approval-templates.list',
    label: '审批模板列表',
    mode: 'single',
    permissions: ['approvals:read'],
  },
  {
    kind: 'guard',
    policyId: 'approval-templates.directory.roles',
    label: '审批模板角色目录',
    mode: 'any',
    permissions: ['approval-templates:manage', 'approvals:admin-templates'],
  },
  {
    kind: 'resource',
    policyId: 'multitable.context.sheet',
    label: '表可见性和读取',
    resourceFields: ['baseId', 'sheetId'],
    note: '',
  },
  {
    kind: 'resource',
    policyId: 'multitable.context.view-access',
    label: '视图配置中的访问能力',
    resourceFields: ['baseId', 'sheetId', 'viewId'],
    note: '这项检查的是上下文返回的配置能力。',
  },
  {
    kind: 'resource',
    policyId: 'multitable.record.read',
    label: '指定记录读取',
    resourceFields: ['baseId', 'sheetId', 'recordId'],
    note: '',
  },
  {
    kind: 'resource',
    policyId: 'multitable.record.field-read',
    label: '指定记录上的字段可见性',
    resourceFields: ['baseId', 'sheetId', 'recordId', 'fieldId'],
    note: '',
  },
]

export const RESOURCE_FIELD_LABELS: Record<ResourceIdField, string> = {
  baseId: '库标识',
  sheetId: '表标识',
  viewId: '视图标识',
  recordId: '记录标识',
  fieldId: '字段标识',
}

export function findBusinessCheckPolicy(policyId: string): BusinessCheckPolicy | null {
  return BUSINESS_CHECK_POLICIES.find((policy) => policy.policyId === policyId) ?? null
}

export function normalizeResourceId(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > 128) return null
  if (!RESOURCE_ID_PATTERN.test(trimmed)) return null
  return trimmed
}

// Named multitable route. The signed-in session follows the route guard.
// The checked member and role are not part of this location.
export function businessCheckMultitableLocation(resourceIds: ResourceIdInput): RouteLocationRaw | null {
  const sheetId = normalizeResourceId(resourceIds.sheetId ?? '')
  const viewId = normalizeResourceId(resourceIds.viewId ?? '')
  if (!sheetId || !viewId) return null
  const query: Record<string, string> = {}
  const baseId = normalizeResourceId(resourceIds.baseId ?? '')
  const recordId = normalizeResourceId(resourceIds.recordId ?? '')
  const fieldId = normalizeResourceId(resourceIds.fieldId ?? '')
  if (baseId) query.baseId = baseId
  if (recordId) query.recordId = recordId
  if (fieldId) query.fieldId = fieldId
  return {
    name: AppRouteNames.MULTITABLE,
    params: { sheetId, viewId },
    query,
  }
}

export function businessCheckConditionKey(policyId: string, resourceIds: ResourceIdInput): string {
  const policy = findBusinessCheckPolicy(policyId)
  if (!policy) return ''
  if (policy.kind === 'guard') return policy.policyId
  return [policy.policyId, ...policy.resourceFields.map((field) => resourceIds[field]?.trim() ?? '')].join('\n')
}

export function buildBusinessCheckRequest(
  userId: string,
  policyId: string,
  resourceIds: ResourceIdInput = {},
): BusinessGuardCheckRequest | BusinessResourceCheckRequest | null {
  if (userId.trim() === '') return null
  const policy = findBusinessCheckPolicy(policyId)
  if (!policy) return null
  const subject = { kind: 'target' as const, userId }
  if (policy.kind === 'guard') {
    return {
      subject,
      policyId: policy.policyId,
      mode: policy.mode,
      permissions: [...policy.permissions],
    }
  }
  const resource: { kind: 'sheet'; [key: string]: string } = { kind: 'sheet' }
  for (const field of policy.resourceFields) {
    const normalized = normalizeResourceId(resourceIds[field] ?? '')
    if (!normalized) return null
    resource[field] = normalized
  }
  return {
    subject,
    policyId: policy.policyId,
    resource,
  }
}

export function idleBusinessCheckView(): BusinessCheckView {
  return { phase: 'idle', detail: '' }
}

export function pendingBusinessCheckView(label: string): BusinessCheckView {
  return { phase: 'pending', detail: `正在检查「${label}」。` }
}

export function businessCheckTransportView(label: string): BusinessCheckView {
  return { phase: 'error', detail: `「${label}」检查失败，本次没有结论。` }
}

export function businessCheckStillCurrent(input: {
  startedGeneration: number
  currentGeneration: number
  startedUserId: string
  currentUserId: string
  startedKey: string
  currentKey: string
}): boolean {
  return input.startedGeneration === input.currentGeneration
    && input.startedUserId !== ''
    && input.startedUserId === input.currentUserId
    && input.startedKey !== ''
    && input.startedKey === input.currentKey
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isValidLayer(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value.layer === 'string'
    && CHECK_LAYERS.has(value.layer)
    && typeof value.result === 'string'
    && CHECK_RESULTS.has(value.result)
}

function isValidBusinessPayload(payload: unknown, policyId: string): payload is { result: 'allow' | 'deny' | 'unknown' } {
  if (!isRecord(payload)) return false
  if (payload.policyId !== policyId) return false
  if (typeof payload.result !== 'string' || !CHECK_RESULTS.has(payload.result)) return false
  if (!Array.isArray(payload.layers) || payload.layers.length === 0 || !payload.layers.every(isValidLayer)) return false
  if (typeof payload.evaluatedAt !== 'string' || payload.evaluatedAt.trim() === '') return false
  if (payload.semantics !== 'guard_snapshot') return false
  return true
}

function allowDetail(policy: BusinessCheckPolicy): string {
  if (policy.kind === 'guard') {
    return `「${policy.label}」通过此权限检查。这不保证业务动作成功。`
  }
  if (policy.policyId === 'multitable.context.view-access') {
    return `「${policy.label}」通过此权限检查。这是上下文返回的配置能力。`
  }
  return `「${policy.label}」通过此权限检查。`
}

function closedDetail(phase: BusinessCheckPhase, label: string): BusinessCheckView {
  if (phase === 'deny') return { phase, detail: `「${label}」这次权限检查没有通过。` }
  if (phase === 'unknown') return { phase, detail: `「${label}」无法判定，本次没有结论。` }
  if (phase === 'forbidden') return { phase, detail: `没有权限检查「${label}」，本次没有结论。` }
  if (phase === 'unavailable') return { phase, detail: `「${label}」这次检查暂时不可用，本次没有结论。` }
  if (phase === 'missing') return { phase, detail: `没有「${label}」的检查结果，本次没有结论。` }
  return { phase: 'error', detail: `「${label}」的检查回执无法核对，本次没有结论。` }
}

export function readBusinessCheckResponse(input: {
  httpStatus: number
  payload: unknown
  requestedPolicyId: string
}): BusinessCheckView {
  const policy = findBusinessCheckPolicy(input.requestedPolicyId)
  const label = policy?.label ?? '这项检查'
  if (input.httpStatus === 403) return closedDetail('forbidden', label)
  if (input.httpStatus === 503) return closedDetail('unavailable', label)
  if (input.httpStatus === 404) return closedDetail('missing', label)
  if (input.httpStatus < 200 || input.httpStatus >= 300) return businessCheckTransportView(label)
  if (!policy || !isValidBusinessPayload(input.payload, policy.policyId)) return closedDetail('error', label)
  if (input.payload.result === 'unknown') return closedDetail('unknown', label)
  if (input.payload.result === 'deny') return closedDetail('deny', label)
  return { phase: 'allow', detail: allowDetail(policy) }
}
