import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  ApprovalNodeConfig,
  ApprovalTemplateDetailDTO,
  ApprovalTemplateVisibilityScope,
  AutoApprovalPolicy,
  EmptyAssigneePolicy,
  FormField,
  FormFieldType,
  FormFieldVisibilityOperator,
  FormFieldVisibilityRule,
  FormOption,
  FormSchema,
  CreateApprovalTemplateRequest,
  UpdateApprovalTemplateRequest,
} from '../types/approval'

export type AuthorableFieldType = Exclude<FormFieldType, 'attachment'>
export type ApprovalStepSourceKind = ApprovalAssigneeSource['kind']

export const AUTHORABLE_FIELD_TYPES: AuthorableFieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'select',
  'multi-select',
  'user',
]

/**
 * Editable representation of a `FormFieldVisibilityRule`. `dependsOnFieldId === ''`
 * means "no rule". `valueText` holds the eq/neq single value, or — for `in` —
 * newline-separated values; it is unused for isEmpty/notEmpty.
 */
export interface FieldVisibilityDraft {
  dependsOnFieldId: string
  operator: FormFieldVisibilityOperator
  valueText: string
}

export interface FieldAuthoringDraft {
  localId: string
  id: string
  type: AuthorableFieldType
  label: string
  required: boolean
  placeholder: string
  optionsText: string
  visibility: FieldVisibilityDraft
  original?: FormField
}

export interface ApprovalStepDraft {
  localId: string
  name: string
  sourceKind: ApprovalStepSourceKind
  idsText: string
  fieldId: string
  // How many management levels the `continuous_managers` source resolves (level 1 =
  // direct manager). Carried for every step but only meaningful when
  // `sourceKind === 'continuous_managers'`; the backend re-validates `[1, 10]`.
  levels: number
  approvalMode: ApprovalMode
  emptyAssigneePolicy: EmptyAssigneePolicy
  // Self-approver authoring: the editable toggle (merge the requester in as an
  // auto-approval). `originalAutoApprovalPolicy` preserves the three non-merge
  // sub-fields (mergeAdjacentApprover / dedupeHistoricalApprover / actorMode),
  // which are out of UI scope but must survive hydrate→rebuild (no silent flatten),
  // mirroring `FieldAuthoringDraft.original`.
  mergeWithRequester: boolean
  originalAutoApprovalPolicy?: AutoApprovalPolicy
}

export interface TemplateAuthoringDraft {
  templateId?: string
  key: string
  name: string
  description: string
  category: string
  visibilityType: ApprovalTemplateVisibilityScope['type']
  visibilityIdsText: string
  slaHoursText: string
  allowRevoke: boolean
  fields: FieldAuthoringDraft[]
  steps: ApprovalStepDraft[]
}

const UNSUPPORTED_GRAPH_NODE_TYPES = new Set(['cc', 'condition', 'parallel'])

function nextLocalId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
}

export function createEmptyFieldDraft(index = 1): FieldAuthoringDraft {
  return {
    localId: nextLocalId('field'),
    id: `field_${index}`,
    type: 'text',
    label: `字段 ${index}`,
    required: false,
    placeholder: '',
    optionsText: '',
    visibility: emptyVisibilityDraft(),
  }
}

export function emptyVisibilityDraft(): FieldVisibilityDraft {
  return { dependsOnFieldId: '', operator: 'eq', valueText: '' }
}

/** Hydrate an editable visibility draft from a stored rule (or blank for none). */
function visibilityDraftFromRule(rule: FormFieldVisibilityRule | undefined): FieldVisibilityDraft {
  if (!rule) return emptyVisibilityDraft()
  const valueText = rule.operator === 'in'
    ? (rule.values ?? []).map((value) => String(value)).join('\n')
    : (rule.value === undefined || rule.value === null ? '' : String(rule.value))
  return { dependsOnFieldId: rule.fieldId, operator: rule.operator, valueText }
}

/**
 * Build the emitted `visibilityRule` from the draft, or `undefined` for "no rule".
 * The editor is authoritative: callers MUST delete a missing rule rather than let
 * a stale one survive via the `original` spread (see buildFormSchema).
 */
function buildVisibilityRule(visibility: FieldVisibilityDraft): FormFieldVisibilityRule | undefined {
  const fieldId = visibility.dependsOnFieldId.trim()
  if (!fieldId) return undefined
  if (visibility.operator === 'in') {
    const values = visibility.valueText.split('\n').map((line) => line.trim()).filter(Boolean)
    return { fieldId, operator: 'in', values }
  }
  if (visibility.operator === 'isEmpty' || visibility.operator === 'notEmpty') {
    return { fieldId, operator: visibility.operator }
  }
  return { fieldId, operator: visibility.operator, value: visibility.valueText.trim() }
}

export function createEmptyStepDraft(index = 1): ApprovalStepDraft {
  return {
    localId: nextLocalId('step'),
    name: `审批人 ${index}`,
    sourceKind: 'requester',
    idsText: '',
    fieldId: '',
    levels: 2,
    approvalMode: 'single',
    emptyAssigneePolicy: 'error',
    mergeWithRequester: false,
  }
}

export function createEmptyTemplateDraft(): TemplateAuthoringDraft {
  return {
    key: '',
    name: '',
    description: '',
    category: '',
    visibilityType: 'all',
    visibilityIdsText: '',
    slaHoursText: '',
    allowRevoke: true,
    fields: [createEmptyFieldDraft(1)],
    steps: [createEmptyStepDraft(1)],
  }
}

export function formatOptionsText(options?: FormOption[]): string {
  return (options ?? [])
    .map((option) => `${option.label}:${option.value}`)
    .join('\n')
}

export function parseOptionsText(value: string): FormOption[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':')
      if (separator === -1) {
        return { label: line, value: line }
      }
      return {
        label: line.slice(0, separator).trim(),
        value: line.slice(separator + 1).trim(),
      }
    })
}

export function parseIdsText(value: string): string[] {
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

function isAuthorableFieldType(value: FormFieldType): value is AuthorableFieldType {
  return AUTHORABLE_FIELD_TYPES.includes(value as AuthorableFieldType)
}

function fieldDraftFromField(field: FormField): FieldAuthoringDraft | null {
  if (!isAuthorableFieldType(field.type)) return null
  return {
    localId: nextLocalId('field'),
    id: field.id,
    type: field.type,
    label: field.label,
    required: field.required === true,
    placeholder: field.placeholder ?? '',
    optionsText: formatOptionsText(field.options),
    visibility: visibilityDraftFromRule(field.visibilityRule),
    original: field,
  }
}

function stepDraftFromApprovalNode(
  node: ApprovalGraph['nodes'][number],
  index: number,
): ApprovalStepDraft | null {
  if (node.type !== 'approval') return null
  const config = node.config as Record<string, unknown>
  const source = Array.isArray(config.assigneeSources)
    ? config.assigneeSources[0] as ApprovalAssigneeSource | undefined
    : undefined
  const legacyType = config.assigneeType
  const legacyIds = Array.isArray(config.assigneeIds)
    ? config.assigneeIds.filter((entry): entry is string => typeof entry === 'string')
    : []

  let sourceKind: ApprovalStepSourceKind = 'requester'
  let idsText = ''
  let fieldId = ''
  let levels = 2
  if (source?.kind === 'static_user') {
    sourceKind = 'static_user'
    idsText = formatIds(source.userIds)
  } else if (source?.kind === 'static_role') {
    sourceKind = 'static_role'
    idsText = formatIds(source.roleIds)
  } else if (source?.kind === 'requester') {
    sourceKind = 'requester'
  } else if (source?.kind === 'form_field_user') {
    sourceKind = 'form_field_user'
    fieldId = source.fieldId
  } else if (source?.kind === 'direct_manager') {
    sourceKind = 'direct_manager'
  } else if (source?.kind === 'dept_head') {
    sourceKind = 'dept_head'
  } else if (source?.kind === 'continuous_managers') {
    sourceKind = 'continuous_managers'
    levels = source.levels
  } else if (legacyType === 'user') {
    sourceKind = 'static_user'
    idsText = formatIds(legacyIds)
  } else if (legacyType === 'role') {
    sourceKind = 'static_role'
    idsText = formatIds(legacyIds)
  }

  // Hydrate the self-approver policy: surface `mergeWithRequester` as the editable
  // toggle, and stash the full policy so non-merge sub-fields survive a rebuild.
  const autoApprovalPolicy = config.autoApprovalPolicy as AutoApprovalPolicy | undefined
  const mergeWithRequester = autoApprovalPolicy?.mergeWithRequester === true

  return {
    localId: nextLocalId('step'),
    name: node.name ?? `审批人 ${index}`,
    sourceKind,
    idsText,
    fieldId,
    levels,
    approvalMode: config.approvalMode === 'all' || config.approvalMode === 'any' ? config.approvalMode : 'single',
    emptyAssigneePolicy: config.emptyAssigneePolicy === 'auto-approve' ? 'auto-approve' : 'error',
    mergeWithRequester,
    ...(autoApprovalPolicy ? { originalAutoApprovalPolicy: autoApprovalPolicy } : {}),
  }
}

function orderedLinearNodes(graph: ApprovalGraph): ApprovalGraph['nodes'] | null {
  const nodeByKey = new Map(graph.nodes.map((node) => [node.key, node]))
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!edge || typeof edge.key !== 'string' || typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      return null
    }
    const edgeKeys = Object.keys(edge as unknown as Record<string, unknown>)
    if (edgeKeys.some((key) => !['key', 'source', 'target'].includes(key))) {
      return null
    }
    if (!nodeByKey.has(edge.source) || !nodeByKey.has(edge.target)) return null
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
  }

  const starts = graph.nodes.filter((node) => node.type === 'start')
  const ends = graph.nodes.filter((node) => node.type === 'end')
  if (starts.length !== 1 || ends.length !== 1) return null

  const ordered: ApprovalGraph['nodes'] = []
  const visited = new Set<string>()
  let cursor = starts[0].key
  let reachedEnd = false
  while (!reachedEnd) {
    if (visited.has(cursor)) return null
    const node = nodeByKey.get(cursor)
    if (!node) return null
    ordered.push(node)
    visited.add(cursor)
    if (node.type === 'end') {
      reachedEnd = true
      break
    }
    const next = outgoing.get(cursor) ?? []
    if (next.length !== 1) return null
    cursor = next[0]
  }

  if (visited.size !== graph.nodes.length) return null
  for (const node of graph.nodes) {
    const inCount = incoming.get(node.key)?.length ?? 0
    const outCount = outgoing.get(node.key)?.length ?? 0
    if (node.type === 'start' && inCount !== 0) return null
    if (node.type === 'end' && outCount !== 0) return null
    if (node.type === 'approval' && (inCount !== 1 || outCount !== 1)) return null
  }
  return ordered
}

export function unsupportedTemplateAuthoringReason(template: ApprovalTemplateDetailDTO): string | null {
  const unsupportedField = template.formSchema.fields.find((field) => !isAuthorableFieldType(field.type))
  if (unsupportedField) {
    return `包含暂不支持编辑的字段类型：${unsupportedField.label || unsupportedField.id} (${unsupportedField.type})`
  }

  const unknownNode = template.approvalGraph.nodes.find((node) => {
    const nodeKeys = Object.keys(node as unknown as Record<string, unknown>)
    return nodeKeys.some((key) => !['key', 'type', 'name', 'config'].includes(key))
      || UNSUPPORTED_GRAPH_NODE_TYPES.has(node.type)
      || !['start', 'approval', 'end'].includes(node.type)
  })
  if (unknownNode) {
    return `包含暂不支持编辑的审批节点：${unknownNode.name || unknownNode.key} (${unknownNode.type})`
  }

  const ordered = orderedLinearNodes(template.approvalGraph)
  if (!ordered) {
    return '审批流程不是 MVP 支持的线性结构'
  }

  const unsupportedApproval = ordered.find((node) => {
    if (node.type !== 'approval') return false
    const config = node.config as Record<string, unknown>
    const allowedConfigKeys = [
      'assigneeType',
      'assigneeIds',
      'assigneeSources',
      'approvalMode',
      'emptyAssigneePolicy',
      'autoApprovalPolicy',
    ]
    if (Object.keys(config).some((key) => !allowedConfigKeys.includes(key))) return true
    const sources = config.assigneeSources
    if (sources !== undefined) {
      if (!Array.isArray(sources) || sources.length !== 1) return true
      const source = sources[0] as ApprovalAssigneeSource
      if (!['static_user', 'static_role', 'requester', 'form_field_user', 'direct_manager', 'dept_head', 'continuous_managers'].includes(source?.kind)) return true
    }
    return false
  })
  if (unsupportedApproval) {
    return `审批节点含暂不支持的配置：${unsupportedApproval.name || unsupportedApproval.key}`
  }

  return null
}

export function draftFromTemplate(template: ApprovalTemplateDetailDTO): TemplateAuthoringDraft {
  const ordered = orderedLinearNodes(template.approvalGraph) ?? template.approvalGraph.nodes
  const fields = template.formSchema.fields
    .map(fieldDraftFromField)
    .filter((field): field is FieldAuthoringDraft => field !== null)
  const steps = ordered
    .map(stepDraftFromApprovalNode)
    .filter((step): step is ApprovalStepDraft => step !== null)

  return {
    templateId: template.id,
    key: template.key,
    name: template.name,
    description: template.description ?? '',
    category: template.category ?? '',
    visibilityType: template.visibilityScope?.type ?? 'all',
    visibilityIdsText: formatIds(template.visibilityScope?.ids),
    slaHoursText: template.slaHours == null ? '' : String(template.slaHours),
    allowRevoke: true,
    fields: fields.length > 0 ? fields : [createEmptyFieldDraft(1)],
    steps: steps.length > 0 ? steps : [createEmptyStepDraft(1)],
  }
}

export function buildFormSchema(draft: TemplateAuthoringDraft): FormSchema {
  return {
    fields: draft.fields.map((field) => {
      const base = field.original ? { ...field.original } : {}
      const next: FormField = {
        ...base,
        id: field.id.trim(),
        type: field.type,
        label: field.label.trim(),
        required: field.required,
        ...(field.placeholder.trim() ? { placeholder: field.placeholder.trim() } : {}),
      }
      if (!field.placeholder.trim()) {
        delete next.placeholder
      }
      if (field.type === 'select' || field.type === 'multi-select') {
        next.options = parseOptionsText(field.optionsText)
      } else {
        delete next.options
      }
      // Editor is authoritative for visibilityRule: emit the built rule, or
      // delete it so a cleared rule is not resurrected from the `original` spread.
      const visibilityRule = buildVisibilityRule(field.visibility)
      if (visibilityRule) {
        next.visibilityRule = visibilityRule
      } else {
        delete next.visibilityRule
      }
      return next
    }),
  }
}

function sourceFromStep(step: ApprovalStepDraft): ApprovalAssigneeSource {
  if (step.sourceKind === 'static_user') {
    return { kind: 'static_user', userIds: parseIdsText(step.idsText) }
  }
  if (step.sourceKind === 'static_role') {
    return { kind: 'static_role', roleIds: parseIdsText(step.idsText) }
  }
  if (step.sourceKind === 'form_field_user') {
    return { kind: 'form_field_user', fieldId: step.fieldId.trim() }
  }
  if (step.sourceKind === 'direct_manager') {
    return { kind: 'direct_manager' }
  }
  if (step.sourceKind === 'dept_head') {
    return { kind: 'dept_head' }
  }
  if (step.sourceKind === 'continuous_managers') {
    return { kind: 'continuous_managers', levels: step.levels }
  }
  return { kind: 'requester' }
}

/**
 * Build the approval-node config for a step. The `mergeWithRequester` toggle is the
 * only authored sub-field of `autoApprovalPolicy`; the three non-merge sub-fields are
 * preserved verbatim from `originalAutoApprovalPolicy` (no silent flatten). The
 * `autoApprovalPolicy` key is OMITTED entirely when the effective policy is empty —
 * mirroring `buildFormSchema`'s `delete next.visibilityRule` omit-empty discipline so a
 * bare `{}` is never persisted.
 */
function buildStepConfig(step: ApprovalStepDraft): ApprovalNodeConfig {
  const autoApprovalPolicy: AutoApprovalPolicy = {
    ...step.originalAutoApprovalPolicy,
    ...(step.mergeWithRequester ? { mergeWithRequester: true } : {}),
  }
  // The toggle owns `mergeWithRequester`: when OFF, drop the flag but keep preserved
  // siblings. (Spread-only would resurrect a `mergeWithRequester:true` carrier.)
  if (!step.mergeWithRequester) {
    delete autoApprovalPolicy.mergeWithRequester
  }
  return {
    assigneeSources: [sourceFromStep(step)],
    approvalMode: step.approvalMode,
    emptyAssigneePolicy: step.emptyAssigneePolicy,
    ...(Object.keys(autoApprovalPolicy).length > 0 ? { autoApprovalPolicy } : {}),
  }
}

export function buildApprovalGraph(draft: TemplateAuthoringDraft): ApprovalGraph {
  const approvalNodes = draft.steps.map((step, index) => ({
    key: `approval_${index + 1}`,
    type: 'approval' as const,
    name: step.name.trim() || `审批人 ${index + 1}`,
    config: buildStepConfig(step),
  }))
  const nodes: ApprovalGraph['nodes'] = [
    { key: 'start', type: 'start', name: '发起', config: {} },
    ...approvalNodes,
    { key: 'end', type: 'end', name: '结束', config: {} },
  ]
  const keys = nodes.map((node) => node.key)
  return {
    nodes,
    edges: keys.slice(0, -1).map((source, index) => ({
      key: `edge-${source}-${keys[index + 1]}`,
      source,
      target: keys[index + 1],
    })),
  }
}

export function buildVisibilityScope(draft: TemplateAuthoringDraft): ApprovalTemplateVisibilityScope {
  if (draft.visibilityType === 'all') return { type: 'all', ids: [] }
  return { type: draft.visibilityType, ids: parseIdsText(draft.visibilityIdsText) }
}

export function buildSlaHours(draft: TemplateAuthoringDraft): number | null {
  const value = draft.slaHoursText.trim()
  if (!value) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : Number.NaN
}

export function validateTemplateDraft(
  draft: TemplateAuthoringDraft,
  unsupportedReason?: string | null,
): string[] {
  const errors: string[] = []
  if (unsupportedReason) errors.push(unsupportedReason)
  if (!draft.key.trim()) errors.push('模板 Key 必填')
  if (!draft.name.trim()) errors.push('模板名称必填')
  if (draft.visibilityType !== 'all' && parseIdsText(draft.visibilityIdsText).length === 0) {
    errors.push('非全员可见范围至少需要一个 id')
  }
  if (Number.isNaN(buildSlaHours(draft))) {
    errors.push('SLA 必须是正整数小时或留空')
  }
  const fields = draft.fields.map((field) => field.id.trim()).filter(Boolean)
  if (fields.length !== draft.fields.length) errors.push('字段 id 必填')
  if (new Set(fields).size !== fields.length) errors.push('字段 id 不能重复')
  draft.fields.forEach((field) => {
    if (!field.label.trim()) errors.push(`字段 ${field.id || '(未命名)'} 的名称必填`)
    if ((field.type === 'select' || field.type === 'multi-select')) {
      const options = parseOptionsText(field.optionsText)
      if (options.length === 0) errors.push(`字段 ${field.label || field.id} 需要至少一个选项`)
      if (options.some((option) => !option.label.trim() || !option.value.trim())) {
        errors.push(`字段 ${field.label || field.id} 的选项 label/value 不能为空`)
      }
    }
  })
  // Mirror the server visibility-rule reject-set (normalizeFormFieldVisibilityRule +
  // validateFormFieldVisibilityRules): dependency must reference an existing field,
  // not itself; `in` needs >=1 value; and the dependency graph must be acyclic.
  const fieldIdSet = new Set(draft.fields.map((field) => field.id.trim()).filter(Boolean))
  const visibilityDeps = new Map<string, string>()
  draft.fields.forEach((field) => {
    const dependsOn = field.visibility.dependsOnFieldId.trim()
    if (!dependsOn) return
    const fieldId = field.id.trim()
    const label = field.label.trim() || fieldId || '(未命名)'
    if (!fieldIdSet.has(dependsOn)) {
      errors.push(`字段 ${label} 的显隐依赖字段不存在`)
      return
    }
    if (dependsOn === fieldId) {
      errors.push(`字段 ${label} 的显隐规则不能依赖自身`)
      return
    }
    if (field.visibility.operator === 'in'
      && field.visibility.valueText.split('\n').map((line) => line.trim()).filter(Boolean).length === 0) {
      errors.push(`字段 ${label} 的显隐"包含"规则需要至少一个值`)
    }
    if (fieldId) visibilityDeps.set(fieldId, dependsOn)
  })
  const cycleState = new Map<string, 0 | 1 | 2>()
  let cycleReported = false
  const visitVisibility = (fieldId: string): void => {
    const state = cycleState.get(fieldId) ?? 0
    if (state === 1) {
      if (!cycleReported) {
        errors.push('字段显隐规则存在循环依赖')
        cycleReported = true
      }
      return
    }
    if (state === 2) return
    cycleState.set(fieldId, 1)
    const dependsOn = visibilityDeps.get(fieldId)
    if (dependsOn) visitVisibility(dependsOn)
    cycleState.set(fieldId, 2)
  }
  visibilityDeps.forEach((_dependsOn, fieldId) => visitVisibility(fieldId))
  if (draft.steps.length === 0) errors.push('至少需要一个审批步骤')
  const userFieldIds = new Set(draft.fields.filter((field) => field.type === 'user').map((field) => field.id.trim()))
  draft.steps.forEach((step, index) => {
    const label = step.name.trim() || `审批步骤 ${index + 1}`
    if ((step.sourceKind === 'static_user' || step.sourceKind === 'static_role') && parseIdsText(step.idsText).length === 0) {
      errors.push(`${label} 需要填写用户/角色 id`)
    }
    if (step.sourceKind === 'form_field_user' && !userFieldIds.has(step.fieldId.trim())) {
      errors.push(`${label} 的表单用户字段无效`)
    }
  })
  return errors
}

export function buildCreateTemplatePayload(draft: TemplateAuthoringDraft): CreateApprovalTemplateRequest {
  return {
    key: draft.key.trim(),
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    category: draft.category.trim() || null,
    visibilityScope: buildVisibilityScope(draft),
    slaHours: buildSlaHours(draft),
    formSchema: buildFormSchema(draft),
    approvalGraph: buildApprovalGraph(draft),
  }
}

export function buildUpdateTemplatePayload(draft: TemplateAuthoringDraft): UpdateApprovalTemplateRequest {
  return buildCreateTemplatePayload(draft)
}
