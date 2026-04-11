import type {
  ApprovalEdge,
  ApprovalNode,
  ApprovalNodeConfig,
  ConditionBranch,
  ConditionRule,
  FormField,
  FormSchema,
  RuntimeGraph,
} from '../types/approval-product'

export interface ApprovalGraphAssignment {
  assignmentType: 'user' | 'role'
  assigneeId: string
  nodeKey: string
  sourceStep: number
}

export interface ApprovalCcEvent {
  nodeKey: string
  targetType: 'user' | 'role'
  targetId: string
}

export interface ApprovalGraphResolution {
  status: 'pending' | 'approved'
  currentNodeKey: string | null
  currentStep: number | null
  totalSteps: number
  assignments: ApprovalGraphAssignment[]
  ccEvents: ApprovalCcEvent[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isApprovalNodeConfig(config: unknown): config is ApprovalNodeConfig {
  return isRecord(config)
    && (config.assigneeType === 'user' || config.assigneeType === 'role')
    && Array.isArray(config.assigneeIds)
}

function isConditionBranch(value: unknown): value is ConditionBranch {
  return isRecord(value)
    && typeof value.edgeKey === 'string'
    && Array.isArray(value.rules)
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
}

function looksLikeComparableDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:$|[T\s].*)/.test(value)
}

function normalizeComparableValue(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric) && trimmed === String(numeric)) {
      return numeric
    }
    const epoch = Date.parse(trimmed)
    if (!Number.isNaN(epoch) && looksLikeComparableDateString(trimmed)) {
      return epoch
    }
    return trimmed
  }
  return null
}

function isEmptyValue(value: unknown): boolean {
  return value === null
    || value === undefined
    || value === ''
    || (Array.isArray(value) && value.length === 0)
}

function evaluateRule(rule: ConditionRule, formData: Record<string, unknown>): boolean {
  const formValue = formData[rule.fieldId]

  switch (rule.operator) {
    case 'isEmpty':
      return isEmptyValue(formValue)
    case 'eq':
      return formValue === rule.value
    case 'neq':
      return formValue !== rule.value
    case 'in':
      if (Array.isArray(rule.value)) {
        const allowedValues = rule.value as unknown[]
        if (Array.isArray(formValue)) {
          return formValue.some((entry) => allowedValues.includes(entry))
        }
        return allowedValues.includes(formValue)
      }
      if (Array.isArray(formValue)) {
        return formValue.includes(rule.value)
      }
      return false
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = normalizeComparableValue(formValue)
      const right = normalizeComparableValue(rule.value)
      if (left === null || right === null) return false
      if (rule.operator === 'gt') return left > right
      if (rule.operator === 'gte') return left >= right
      if (rule.operator === 'lt') return left < right
      return left <= right
    }
    default:
      return false
  }
}

function validateFieldType(field: FormField, value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }

  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'user':
    case 'attachment':
      return typeof value === 'string' || isRecord(value) ? null : `${field.id} must be a string`
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${field.id} must be a number`
    case 'date':
    case 'datetime':
      if (typeof value === 'string') {
        return Number.isNaN(Date.parse(value.trim())) ? `${field.id} must be a date value` : null
      }
      return value instanceof Date && !Number.isNaN(value.getTime())
        ? null
        : `${field.id} must be a date value`
    case 'select':
      if (typeof value !== 'string') return `${field.id} must be a string`
      if (field.options?.length && !field.options.some((option) => option.value === value)) {
        return `${field.id} must be one of the configured options`
      }
      return null
    case 'multi-select':
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        return `${field.id} must be an array of strings`
      }
      if (field.options?.length && value.some((entry) => !field.options!.some((option) => option.value === entry))) {
        return `${field.id} must contain only configured options`
      }
      return null
    default:
      return null
  }
}

function getFieldPropNumber(field: FormField, key: string): number | null {
  const raw = field.props?.[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function getFieldPropString(field: FormField, key: string): string | null {
  const raw = field.props?.[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null
}

function validateFieldConstraints(field: FormField, value: unknown): string[] {
  if (value === undefined || value === null) {
    return []
  }

  switch (field.type) {
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') return []
      const errors: string[] = []
      const minLength = getFieldPropNumber(field, 'minLength')
      const maxLength = getFieldPropNumber(field, 'maxLength')
      const pattern = getFieldPropString(field, 'pattern')

      if (minLength !== null && value.length < minLength) {
        errors.push(`${field.id} must be at least ${minLength} characters`)
      }
      if (maxLength !== null && value.length > maxLength) {
        errors.push(`${field.id} must be at most ${maxLength} characters`)
      }
      if (pattern) {
        try {
          if (!new RegExp(pattern).test(value)) {
            errors.push(`${field.id} does not match the required pattern`)
          }
        } catch {
          // Ignore invalid admin-configured regex patterns here and treat them as non-enforced.
        }
      }
      return errors
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return []
      const errors: string[] = []
      const min = getFieldPropNumber(field, 'min')
      const max = getFieldPropNumber(field, 'max')

      if (min !== null && value < min) {
        errors.push(`${field.id} must be at least ${min}`)
      }
      if (max !== null && value > max) {
        errors.push(`${field.id} must be at most ${max}`)
      }
      return errors
    }
    case 'date':
    case 'datetime': {
      const valueComparable = normalizeComparableValue(value)
      if (valueComparable === null) return []

      const errors: string[] = []
      const min = getFieldPropString(field, 'min')
      const max = getFieldPropString(field, 'max')
      const minComparable = min ? normalizeComparableValue(min) : null
      const maxComparable = max ? normalizeComparableValue(max) : null

      if (typeof valueComparable === 'number' && typeof minComparable === 'number' && valueComparable < minComparable) {
        errors.push(`${field.id} must be on or after ${min}`)
      }
      if (typeof valueComparable === 'number' && typeof maxComparable === 'number' && valueComparable > maxComparable) {
        errors.push(`${field.id} must be on or before ${max}`)
      }
      return errors
    }
    default:
      return []
  }
}

export function validateApprovalFormData(formSchema: FormSchema, formData: Record<string, unknown>): string[] {
  const errors: string[] = []

  for (const field of formSchema.fields) {
    const value = formData[field.id]
    if (field.required && isEmptyValue(value)) {
      errors.push(`${field.id} is required`)
      continue
    }
    const typeError = validateFieldType(field, value)
    if (typeError) {
      errors.push(typeError)
      continue
    }
    errors.push(...validateFieldConstraints(field, value))
  }

  return errors
}

export class ApprovalGraphExecutor {
  private readonly nodeMap = new Map<string, ApprovalNode>()
  private readonly outgoingEdges = new Map<string, ApprovalEdge[]>()
  private readonly approvalNodeOrder: string[]

  constructor(
    private readonly runtimeGraph: RuntimeGraph,
    private readonly formData: Record<string, unknown>,
  ) {
    for (const node of runtimeGraph.nodes) {
      this.nodeMap.set(node.key, node)
    }
    for (const edge of runtimeGraph.edges) {
      const existing = this.outgoingEdges.get(edge.source) || []
      existing.push(edge)
      this.outgoingEdges.set(edge.source, existing)
    }
    this.approvalNodeOrder = runtimeGraph.nodes
      .filter((node) => node.type === 'approval')
      .map((node) => node.key)
  }

  get totalSteps(): number {
    return this.approvalNodeOrder.length
  }

  resolveInitialState(): ApprovalGraphResolution {
    const start = this.runtimeGraph.nodes.find((node) => node.type === 'start')
    if (!start) {
      throw new Error('Runtime graph must contain a start node')
    }
    return this.resolveFromNode(start.key)
  }

  resolveAfterApprove(currentNodeKey: string): ApprovalGraphResolution {
    const next = this.firstTargetForNode(currentNodeKey)
    if (!next) {
      return {
        status: 'approved',
        currentNodeKey: null,
        currentStep: this.totalSteps,
        totalSteps: this.totalSteps,
        assignments: [],
        ccEvents: [],
      }
    }
    return this.resolveFromNode(next)
  }

  buildTransferAssignments(currentNodeKey: string, targetUserId: string): ApprovalGraphAssignment[] {
    const currentStep = this.stepIndexForNode(currentNodeKey)
    return [{
      assignmentType: 'user',
      assigneeId: targetUserId,
      nodeKey: currentNodeKey,
      sourceStep: currentStep,
    }]
  }

  private resolveFromNode(nodeKey: string): ApprovalGraphResolution {
    const ccEvents: ApprovalCcEvent[] = []
    let currentKey: string | null = nodeKey

    while (currentKey) {
      const node = this.nodeMap.get(currentKey)
      if (!node) {
        throw new Error(`Runtime graph references unknown node ${currentKey}`)
      }

      if (node.type === 'start') {
        currentKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'condition') {
        currentKey = this.resolveConditionTarget(node)
        continue
      }

      if (node.type === 'cc') {
        const ccConfig = node.config as unknown as Record<string, unknown>
        const targetIds = ccConfig.targetIds
        const targetType = ccConfig.targetType
        if (!isNonEmptyStringArray(targetIds) || (targetType !== 'user' && targetType !== 'role')) {
          throw new Error(`CC node ${node.key} has invalid config`)
        }
        for (const targetId of targetIds) {
          ccEvents.push({
            nodeKey: node.key,
            targetType,
            targetId,
          })
        }
        currentKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'approval') {
        const approvalConfig = isApprovalNodeConfig(node.config) ? node.config : null
        if (!approvalConfig) {
          throw new Error(`Approval node ${node.key} has invalid config`)
        }
        const sourceStep = this.stepIndexForNode(node.key)
        return {
          status: 'pending',
          currentNodeKey: node.key,
          currentStep: sourceStep,
          totalSteps: this.totalSteps,
          assignments: approvalConfig.assigneeIds.map((assigneeId) => ({
            assignmentType: approvalConfig.assigneeType,
            assigneeId,
            nodeKey: node.key,
            sourceStep,
          })),
          ccEvents,
        }
      }

      if (node.type === 'end') {
        return {
          status: 'approved',
          currentNodeKey: null,
          currentStep: this.totalSteps,
          totalSteps: this.totalSteps,
          assignments: [],
          ccEvents,
        }
      }

      throw new Error(`Unsupported node type ${node.type}`)
    }

    return {
      status: 'approved',
      currentNodeKey: null,
      currentStep: this.totalSteps,
      totalSteps: this.totalSteps,
      assignments: [],
      ccEvents,
    }
  }

  private resolveConditionTarget(node: ApprovalNode): string | null {
    const config = node.config as unknown as Record<string, unknown>
    const rawBranches = config.branches
    const branches = Array.isArray(rawBranches)
      ? rawBranches.filter(isConditionBranch)
      : []

    for (const branch of branches) {
      const conjunction = branch.conjunction === 'or' ? 'or' : 'and'
      const result = conjunction === 'or'
        ? branch.rules.some((rule) => evaluateRule(rule, this.formData))
        : branch.rules.every((rule) => evaluateRule(rule, this.formData))
      if (result) {
        return this.targetForEdge(branch.edgeKey)
      }
    }

    const defaultEdgeKey = config.defaultEdgeKey
    if (typeof defaultEdgeKey === 'string' && defaultEdgeKey.trim()) {
      return this.targetForEdge(defaultEdgeKey)
    }

    return this.firstTargetForNode(node.key)
  }

  private firstTargetForNode(nodeKey: string): string | null {
    const edge = this.outgoingEdges.get(nodeKey)?.[0]
    return edge?.target || null
  }

  private targetForEdge(edgeKey: string): string | null {
    const edge = this.runtimeGraph.edges.find((entry) => entry.key === edgeKey)
    return edge?.target || null
  }

  private stepIndexForNode(nodeKey: string): number {
    const index = this.approvalNodeOrder.indexOf(nodeKey)
    return index >= 0 ? index + 1 : 0
  }
}
