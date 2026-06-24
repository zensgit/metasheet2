import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  ApprovalNode,
  ApprovalNodeConfig,
  AutoApprovalPolicy,
  EmptyAssigneePolicy,
  FormSchema,
} from '../types/approval'

// G-5 — approval node editing inside a preserved complex graph. This is config-only:
// assignee source, approvalMode, emptyAssigneePolicy, and mergeWithRequester. Node keys, node
// order, and every edge remain topology and are preserved byte-for-byte.

export type ApprovalNodeSourceKind = ApprovalAssigneeSource['kind']

export interface ApprovalNodeEdit {
  nodeKey: string
  name: string
  sourceKind: ApprovalNodeSourceKind
  idsText: string
  fieldId: string
  levels: number
  level: number
  approvalMode: ApprovalMode
  emptyAssigneePolicy: EmptyAssigneePolicy
  mergeWithRequester: boolean
  originalAutoApprovalPolicy?: AutoApprovalPolicy
}

export type ApprovalNodeEdits = Record<string, ApprovalNodeEdit>

export const APPROVAL_NODE_SOURCE_KINDS: readonly ApprovalNodeSourceKind[] = [
  'static_user',
  'static_role',
  'requester',
  'direct_manager',
  'dept_head',
  'continuous_managers',
  'manager_at_level',
  'form_field_user',
] as const

const APPROVAL_NODE_SOURCE_KIND_SET = new Set<string>(APPROVAL_NODE_SOURCE_KINDS)
const APPROVAL_MODES: readonly ApprovalMode[] = ['single', 'all', 'any'] as const
const APPROVAL_MODE_SET = new Set<string>(APPROVAL_MODES)
const EMPTY_ASSIGNEE_POLICIES: readonly EmptyAssigneePolicy[] = ['error', 'auto-approve'] as const
const EMPTY_ASSIGNEE_POLICY_SET = new Set<string>(EMPTY_ASSIGNEE_POLICIES)

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function parseIdsText(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,，]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )
}

function formatIds(ids?: string[]): string {
  return (ids ?? []).join(', ')
}

export function isApprovalNodeSourceKind(value: unknown): value is ApprovalNodeSourceKind {
  return typeof value === 'string' && APPROVAL_NODE_SOURCE_KIND_SET.has(value)
}

function sourceFromConfig(config: ApprovalNodeConfig): ApprovalAssigneeSource | undefined {
  return Array.isArray(config.assigneeSources)
    ? config.assigneeSources[0] as ApprovalAssigneeSource | undefined
    : undefined
}

function editFromApprovalNode(node: ApprovalNode, index: number): ApprovalNodeEdit | null {
  if (node.type !== 'approval') return null
  const config = node.config as ApprovalNodeConfig
  const source = sourceFromConfig(config)
  if (!source || !isApprovalNodeSourceKind(source.kind)) return null

  let idsText = ''
  let fieldId = ''
  let levels = 2
  let level = 1
  if (source.kind === 'static_user') {
    idsText = formatIds(source.userIds)
  } else if (source.kind === 'static_role') {
    idsText = formatIds(source.roleIds)
  } else if (source.kind === 'form_field_user') {
    fieldId = source.fieldId
  } else if (source.kind === 'continuous_managers') {
    levels = source.levels
  } else if (source.kind === 'manager_at_level') {
    level = source.level
  }

  const autoApprovalPolicy = config.autoApprovalPolicy
  return {
    nodeKey: node.key,
    name: node.name ?? `审批节点 ${index + 1}`,
    sourceKind: source.kind,
    idsText,
    fieldId,
    levels,
    level,
    approvalMode: config.approvalMode === 'all' || config.approvalMode === 'any' ? config.approvalMode : 'single',
    emptyAssigneePolicy: config.emptyAssigneePolicy === 'auto-approve' ? 'auto-approve' : 'error',
    mergeWithRequester: autoApprovalPolicy?.mergeWithRequester === true,
    ...(autoApprovalPolicy ? { originalAutoApprovalPolicy: cloneJson(autoApprovalPolicy) } : {}),
  }
}

export function approvalNodeEditsFromGraph(graph: ApprovalGraph | undefined): ApprovalNodeEdits {
  const edits: ApprovalNodeEdits = {}
  if (!graph) return edits
  graph.nodes.forEach((node, index) => {
    const edit = editFromApprovalNode(node, index)
    if (edit) edits[node.key] = edit
  })
  return edits
}

function sourceFromEdit(edit: ApprovalNodeEdit): ApprovalAssigneeSource {
  if (edit.sourceKind === 'static_user') {
    return { kind: 'static_user', userIds: parseIdsText(edit.idsText) }
  }
  if (edit.sourceKind === 'static_role') {
    return { kind: 'static_role', roleIds: parseIdsText(edit.idsText) }
  }
  if (edit.sourceKind === 'form_field_user') {
    return { kind: 'form_field_user', fieldId: edit.fieldId.trim() }
  }
  if (edit.sourceKind === 'direct_manager') {
    return { kind: 'direct_manager' }
  }
  if (edit.sourceKind === 'dept_head') {
    return { kind: 'dept_head' }
  }
  if (edit.sourceKind === 'continuous_managers') {
    return { kind: 'continuous_managers', levels: edit.levels }
  }
  if (edit.sourceKind === 'manager_at_level') {
    return { kind: 'manager_at_level', level: edit.level }
  }
  return { kind: 'requester' }
}

function buildApprovalNodeConfig(original: ApprovalNodeConfig, edit: ApprovalNodeEdit): ApprovalNodeConfig {
  const autoApprovalPolicy: AutoApprovalPolicy = {
    ...cloneJson(edit.originalAutoApprovalPolicy ?? {}),
    ...(edit.mergeWithRequester ? { mergeWithRequester: true } : {}),
  }
  if (!edit.mergeWithRequester) {
    delete autoApprovalPolicy.mergeWithRequester
  }
  const config: ApprovalNodeConfig = {
    ...cloneJson(original),
    assigneeSources: [sourceFromEdit(edit)],
    approvalMode: edit.approvalMode,
    emptyAssigneePolicy: edit.emptyAssigneePolicy,
  }
  delete config.assigneeType
  delete config.assigneeIds
  if (Object.keys(autoApprovalPolicy).length > 0) {
    config.autoApprovalPolicy = autoApprovalPolicy
  } else {
    delete config.autoApprovalPolicy
  }
  return config
}

export function applyApprovalNodeEditsToGraph(
  graph: ApprovalGraph,
  edits: ApprovalNodeEdits,
): ApprovalGraph {
  const nodes: ApprovalNode[] = graph.nodes.map((node) => {
    if (node.type !== 'approval') return cloneJson(node)
    const edit = edits[node.key]
    if (!edit) return cloneJson(node)
    return {
      ...cloneJson(node),
      config: buildApprovalNodeConfig(node.config as ApprovalNodeConfig, edit),
    }
  })
  return {
    nodes,
    edges: graph.edges.map((edge) => cloneJson(edge)),
  }
}

export function validateApprovalNodeEdits(edits: ApprovalNodeEdits, formSchema: FormSchema): string[] {
  const errors: string[] = []
  const userFieldIds = new Set(
    formSchema.fields
      .filter((field) => field.type === 'user')
      .map((field) => field.id),
  )
  for (const edit of Object.values(edits)) {
    const label = edit.name.trim() || edit.nodeKey
    if (!isApprovalNodeSourceKind(edit.sourceKind)) {
      errors.push(`审批节点 ${label} 的审批人来源无效`)
    }
    if (!APPROVAL_MODE_SET.has(edit.approvalMode)) {
      errors.push(`审批节点 ${label} 的审批模式无效`)
    }
    if (!EMPTY_ASSIGNEE_POLICY_SET.has(edit.emptyAssigneePolicy)) {
      errors.push(`审批节点 ${label} 的空审批人策略无效`)
    }
    if ((edit.sourceKind === 'static_user' || edit.sourceKind === 'static_role') && parseIdsText(edit.idsText).length === 0) {
      errors.push(`审批节点 ${label} 需要填写用户/角色 id`)
    }
    if (edit.sourceKind === 'form_field_user' && !userFieldIds.has(edit.fieldId.trim())) {
      errors.push(`审批节点 ${label} 的表单用户字段无效`)
    }
    if (edit.sourceKind === 'continuous_managers' && (!Number.isInteger(edit.levels) || edit.levels < 1 || edit.levels > 10)) {
      errors.push(`审批节点 ${label} 的连续上级层级数必须在 1 到 10 之间`)
    }
    if (edit.sourceKind === 'manager_at_level' && (!Number.isInteger(edit.level) || edit.level < 1 || edit.level > 10)) {
      errors.push(`审批节点 ${label} 的指定上级层级必须在 1 到 10 之间`)
    }
  }
  return errors
}

export function unsupportedComplexApprovalNodeConfigReason(graph: ApprovalGraph): string | null {
  const allowedConfigKeys = new Set([
    'assigneeSources',
    'approvalMode',
    'emptyAssigneePolicy',
    'autoApprovalPolicy',
    'fieldPermissions',
  ])
  for (const node of graph.nodes) {
    if (node.type !== 'approval') continue
    const config = node.config as ApprovalNodeConfig
    const configKeys = Object.keys(config as Record<string, unknown>)
    if (configKeys.some((key) => !allowedConfigKeys.has(key))) {
      return `审批节点含暂不支持的配置：${node.name || node.key}`
    }
    if (!Array.isArray(config.assigneeSources) || config.assigneeSources.length !== 1) {
      return `审批节点含暂不支持的审批人来源：${node.name || node.key}`
    }
    const source = config.assigneeSources[0]
    if (!isApprovalNodeSourceKind(source?.kind)) {
      return `审批节点含暂不支持的审批人来源：${node.name || node.key}`
    }
  }
  return null
}
