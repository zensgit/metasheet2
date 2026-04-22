import type {
  ApprovalEdge,
  ApprovalMode,
  ApprovalNode,
  ApprovalNodeConfig,
  ConditionBranch,
  ConditionRule,
  FormField,
  FormSchema,
  ParallelNodeConfig,
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

export interface ApprovalGraphAutoApprovalEvent {
  nodeKey: string
  sourceStep: number
  approvalMode: ApprovalMode
  reason: 'empty-assignee'
}

/**
 * Per-branch runtime state tracked in `approval_instances.metadata.parallelBranchStates`
 * while an instance is inside a parallel-gateway region.
 *
 * The executor is stateless — the route service passes the current map in and
 * receives an updated map back on each resolution.
 */
export interface ParallelBranchState {
  edgeKey: string
  /** Current frontier inside this branch. `null` once the branch has reached the join node. */
  currentNodeKey: string | null
  complete: boolean
}

export interface ParallelInstanceState {
  parallelNodeKey: string
  joinNodeKey: string
  joinMode: 'all' | 'any'
  branches: Record<string, ParallelBranchState>
}

type BranchAdvance =
  | {
      kind: 'pending-approval'
      approvalNodeKey: string
      assignments: ApprovalGraphAssignment[]
      ccEvents: ApprovalCcEvent[]
      autoApprovalEvents: ApprovalGraphAutoApprovalEvent[]
    }
  | {
      kind: 'reached-join'
      ccEvents: ApprovalCcEvent[]
      autoApprovalEvents: ApprovalGraphAutoApprovalEvent[]
    }

export interface ApprovalGraphResolution {
  status: 'pending' | 'approved'
  currentNodeKey: string | null
  /**
   * Parallel gateway frontier. For non-parallel state this is either omitted
   * or equals `[currentNodeKey]`. When the resolution lands the instance
   * inside a parallel region, every still-pending branch's current approval
   * node is listed here; consumers can use length ≥ 2 as the "in parallel"
   * signal without peeking into metadata.
   */
  currentNodeKeys?: string[]
  currentStep: number | null
  totalSteps: number
  assignments: ApprovalGraphAssignment[]
  ccEvents: ApprovalCcEvent[]
  autoApprovalEvents: ApprovalGraphAutoApprovalEvent[]
  /**
   * Aggregation mode of the node that was just resolved away from (by `resolveAfterApprove`).
   * `null` for `resolveInitialState`, `resolveReturnToNode`, and non-approval advancement paths.
   * Any-mode resolution carries `'any'`; all-mode carries `'all'` only when aggregation is complete
   * (the route short-circuits incomplete all-mode before calling `resolveAfterApprove`).
   */
  aggregateMode: 'single' | 'all' | 'any' | null
  /**
   * Indicates that the previous node's aggregation requirement is satisfied and resolution advanced.
   * Always `true` when `resolveAfterApprove` returns (incomplete aggregation never reaches here).
   * `false` from the other entry points that do not represent an aggregation completion event.
   */
  aggregateComplete: boolean
  /**
   * When the resolution enters a parallel region, carries the initial branch
   * state map the route should persist to `metadata.parallelBranchStates`.
   * When the resolution leaves a parallel region (join-all complete), carries
   * the final state map so the caller can archive it before clearing metadata.
   */
  parallelState?: ParallelInstanceState
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

function isParallelNodeConfig(config: unknown): config is ParallelNodeConfig {
  return isRecord(config)
    && isNonEmptyStringArray(config.branches)
    && (config.branches as string[]).length >= 2
    && typeof config.joinNodeKey === 'string'
    && config.joinNodeKey.trim().length > 0
    && (config.joinMode === 'all' || config.joinMode === 'any')
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

function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'all' || value === 'any' || value === 'single' ? value : 'single'
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
    return this.resolveFromNode(start.key, { aggregateMode: null, aggregateComplete: false })
  }

  resolveAfterApprove(currentNodeKey: string): ApprovalGraphResolution {
    // The caller (ApprovalProductService) only reaches `resolveAfterApprove` after aggregation
    // is satisfied for the current node. For 'any' mode that is on the first approver; for 'all'
    // it is after the last approver; 'single' always satisfies on the sole approver. The resolution
    // therefore carries `aggregateComplete: true` along with the current node's approval mode so
    // downstream audit writers can distinguish `'any'` first-wins from `'all'` last-wins.
    const aggregateMode = this.getApprovalMode(currentNodeKey)
    const completionContext = { aggregateMode, aggregateComplete: true as const }
    const next = this.firstTargetForNode(currentNodeKey)
    if (!next) {
      return {
        status: 'approved',
        currentNodeKey: null,
        currentStep: this.totalSteps,
        totalSteps: this.totalSteps,
        assignments: [],
        ccEvents: [],
        autoApprovalEvents: [],
        aggregateMode,
        aggregateComplete: true,
      }
    }
    return this.resolveFromNode(next, completionContext)
  }

  /**
   * Advances a single branch inside a parallel-gateway region after one of its
   * approval nodes has finished aggregating (会签 last approver, 或签 first
   * approver, or single-approver completion). Returns either:
   *
   *   - `{ status: 'pending', currentNodeKey: parallelNodeKey, parallelState }`
   *     if the branch moved to another approval node in the same branch OR
   *     reached the join node while siblings remain pending. The route layer
   *     persists the updated `parallelState` into `metadata.parallelBranchStates`.
   *   - A post-join resolution (`resolveFromNode(joinNodeKey)`) once every
   *     branch has reported complete under `joinMode='all'`. In that case
   *     `parallelState` carries the final archived state map.
   *
   * The `joinMode='any'` path is reserved for a future wave and currently
   * throws; see the dev MD follow-up list.
   */
  resolveAfterApproveInParallel(
    branchNodeKey: string,
    currentState: ParallelInstanceState,
  ): ApprovalGraphResolution {
    const branch = Object.values(currentState.branches).find(
      (entry) => entry.currentNodeKey === branchNodeKey,
    )
    if (!branch) {
      throw new Error(`Parallel branch with current node ${branchNodeKey} not found in state`)
    }
    if (currentState.joinMode !== 'all') {
      throw new Error(`Parallel joinMode '${currentState.joinMode}' is not supported in v1`)
    }
    const aggregateMode = this.getApprovalMode(branchNodeKey)

    // Walk the branch forward one "advance step" — stop either at the next
    // pending approval node (still inside the branch) or at the join node.
    const advance = this.resolveBranchAdvance(branchNodeKey, currentState.joinNodeKey)
    const updatedBranches: Record<string, ParallelBranchState> = { ...currentState.branches }
    const branchEntryKey = Object.keys(currentState.branches).find(
      (key) => currentState.branches[key].currentNodeKey === branchNodeKey,
    )!

    if (advance.kind === 'pending-approval') {
      updatedBranches[branchEntryKey] = {
        edgeKey: branch.edgeKey,
        currentNodeKey: advance.approvalNodeKey,
        complete: false,
      }
      const updatedState: ParallelInstanceState = {
        ...currentState,
        branches: updatedBranches,
      }
      const pendingBranches = Object.values(updatedState.branches).filter((entry) => !entry.complete)
      return {
        status: 'pending',
        currentNodeKey: currentState.parallelNodeKey,
        currentNodeKeys: pendingBranches.map((entry) => entry.currentNodeKey!).filter((key): key is string => Boolean(key)),
        currentStep: this.stepIndexForNode(advance.approvalNodeKey) || this.totalSteps,
        totalSteps: this.totalSteps,
        assignments: advance.assignments,
        ccEvents: advance.ccEvents,
        autoApprovalEvents: advance.autoApprovalEvents,
        aggregateMode,
        aggregateComplete: true,
        parallelState: updatedState,
      }
    }

    // Branch reached the join node. Mark it complete and decide whether the
    // parallel region as a whole can advance.
    updatedBranches[branchEntryKey] = {
      edgeKey: branch.edgeKey,
      currentNodeKey: null,
      complete: true,
    }
    const updatedState: ParallelInstanceState = {
      ...currentState,
      branches: updatedBranches,
    }
    const allComplete = Object.values(updatedState.branches).every((entry) => entry.complete)

    if (!allComplete) {
      // Still waiting on siblings; keep the instance pending with fewer active branches.
      const pendingBranches = Object.values(updatedState.branches).filter((entry) => !entry.complete)
      return {
        status: 'pending',
        currentNodeKey: currentState.parallelNodeKey,
        currentNodeKeys: pendingBranches.map((entry) => entry.currentNodeKey!).filter((key): key is string => Boolean(key)),
        currentStep: this.stepIndexForNode(pendingBranches[0]?.currentNodeKey ?? '') || this.totalSteps,
        totalSteps: this.totalSteps,
        assignments: [],
        ccEvents: advance.ccEvents,
        autoApprovalEvents: advance.autoApprovalEvents,
        aggregateMode,
        aggregateComplete: true,
        parallelState: updatedState,
      }
    }

    // All branches complete — advance past the join node.
    const postJoin = this.resolveFromNode(currentState.joinNodeKey, {
      aggregateMode,
      aggregateComplete: true,
    })
    return {
      ...postJoin,
      ccEvents: [...advance.ccEvents, ...postJoin.ccEvents],
      autoApprovalEvents: [...advance.autoApprovalEvents, ...postJoin.autoApprovalEvents],
      parallelState: updatedState,
    }
  }

  getApprovalMode(nodeKey: string): ApprovalMode {
    return normalizeApprovalMode(this.getApprovalNodeConfig(nodeKey).approvalMode)
  }

  getApprovalNodeAssigneeIds(nodeKey: string): string[] {
    return [...this.getApprovalNodeConfig(nodeKey).assigneeIds]
  }

  resolveReturnToNode(targetNodeKey: string): ApprovalGraphResolution {
    this.getApprovalNodeConfig(targetNodeKey)
    return this.resolveFromNode(targetNodeKey, { aggregateMode: null, aggregateComplete: false })
  }

  listVisitedApprovalNodeKeysUntil(currentNodeKey: string): string[] {
    this.getApprovalNodeConfig(currentNodeKey)

    const start = this.runtimeGraph.nodes.find((node) => node.type === 'start')
    if (!start) {
      throw new Error('Runtime graph must contain a start node')
    }

    const visited = new Set<string>()
    const approvalTrail: string[] = []
    let nextNodeKey: string | null = start.key

    while (nextNodeKey) {
      if (visited.has(nextNodeKey)) {
        throw new Error(`Runtime graph contains a cycle near ${nextNodeKey}`)
      }
      visited.add(nextNodeKey)

      const node = this.nodeMap.get(nextNodeKey)
      if (!node) {
        throw new Error(`Runtime graph references unknown node ${nextNodeKey}`)
      }

      if (node.type === 'start') {
        nextNodeKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'condition') {
        nextNodeKey = this.resolveConditionTarget(node)
        continue
      }

      if (node.type === 'cc') {
        nextNodeKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'approval') {
        approvalTrail.push(node.key)
        if (node.key === currentNodeKey) {
          return approvalTrail
        }
        nextNodeKey = this.firstTargetForNode(node.key)
        continue
      }

      if (node.type === 'parallel') {
        // Return-to-node inside a parallel region is deferred to a follow-up
        // wave; the caller (dispatch route) rejects `return` when the
        // instance is in parallel state before reaching here. The linear
        // walker skips over the parallel fork and resumes at the join node.
        const parallelConfig = isParallelNodeConfig(node.config) ? node.config : null
        if (!parallelConfig) {
          throw new Error(`Parallel node ${node.key} has invalid config`)
        }
        nextNodeKey = parallelConfig.joinNodeKey
        continue
      }

      if (node.type === 'end') {
        break
      }
    }

    throw new Error(`Approval node ${currentNodeKey} is not reachable from runtime start`)
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

  private resolveFromNode(
    nodeKey: string,
    context: { aggregateMode: 'single' | 'all' | 'any' | null; aggregateComplete: boolean },
  ): ApprovalGraphResolution {
    const ccEvents: ApprovalCcEvent[] = []
    const autoApprovalEvents: ApprovalGraphAutoApprovalEvent[] = []
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
        const approvalMode = normalizeApprovalMode(approvalConfig.approvalMode)
        if (approvalConfig.assigneeIds.length === 0) {
          if (approvalConfig.emptyAssigneePolicy === 'auto-approve') {
            autoApprovalEvents.push({
              nodeKey: node.key,
              sourceStep,
              approvalMode,
              reason: 'empty-assignee',
            })
            currentKey = this.firstTargetForNode(node.key)
            continue
          }
          throw new Error(`Approval node ${node.key} has no assignees`)
        }
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
          autoApprovalEvents,
          aggregateMode: context.aggregateMode,
          aggregateComplete: context.aggregateComplete,
        }
      }

      if (node.type === 'parallel') {
        const parallelConfig = isParallelNodeConfig(node.config) ? node.config : null
        if (!parallelConfig) {
          throw new Error(`Parallel node ${node.key} has invalid config`)
        }
        if (parallelConfig.joinMode !== 'all') {
          throw new Error(`Parallel joinMode '${parallelConfig.joinMode}' is not supported in v1`)
        }

        const branchStates: Record<string, ParallelBranchState> = {}
        const branchAssignments: ApprovalGraphAssignment[] = []
        let allBranchesAutoComplete = true

        for (const edgeKey of parallelConfig.branches) {
          const branchStartNode = this.targetForEdge(edgeKey)
          if (!branchStartNode) {
            throw new Error(`Parallel branch edge ${edgeKey} has no target`)
          }
          const advance = this.resolveBranchAdvance(
            { fromNodeKey: branchStartNode, includeStartNode: true },
            parallelConfig.joinNodeKey,
          )
          ccEvents.push(...advance.ccEvents)
          autoApprovalEvents.push(...advance.autoApprovalEvents)

          if (advance.kind === 'pending-approval') {
            branchStates[edgeKey] = {
              edgeKey,
              currentNodeKey: advance.approvalNodeKey,
              complete: false,
            }
            branchAssignments.push(...advance.assignments)
            allBranchesAutoComplete = false
          } else {
            branchStates[edgeKey] = {
              edgeKey,
              currentNodeKey: null,
              complete: true,
            }
          }
        }

        if (allBranchesAutoComplete) {
          // Every branch fast-forwarded through auto-approvals / cc to the join
          // node. Continue walking past the join node directly.
          const postJoin = this.resolveFromNode(parallelConfig.joinNodeKey, context)
          return {
            ...postJoin,
            ccEvents: [...ccEvents, ...postJoin.ccEvents],
            autoApprovalEvents: [...autoApprovalEvents, ...postJoin.autoApprovalEvents],
          }
        }

        const pendingBranches = Object.values(branchStates).filter((entry) => !entry.complete)
        const firstBranchFrontier = pendingBranches[0]?.currentNodeKey ?? parallelConfig.joinNodeKey
        return {
          status: 'pending',
          currentNodeKey: node.key,
          currentNodeKeys: pendingBranches.map((entry) => entry.currentNodeKey!).filter((key): key is string => Boolean(key)),
          currentStep: this.stepIndexForNode(firstBranchFrontier) || this.totalSteps,
          totalSteps: this.totalSteps,
          assignments: branchAssignments,
          ccEvents,
          autoApprovalEvents,
          aggregateMode: context.aggregateMode,
          aggregateComplete: context.aggregateComplete,
          parallelState: {
            parallelNodeKey: node.key,
            joinNodeKey: parallelConfig.joinNodeKey,
            joinMode: parallelConfig.joinMode,
            branches: branchStates,
          },
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
          autoApprovalEvents,
          aggregateMode: context.aggregateMode,
          aggregateComplete: context.aggregateComplete,
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
      autoApprovalEvents,
      aggregateMode: context.aggregateMode,
      aggregateComplete: context.aggregateComplete,
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

  /**
   * Walks a single parallel branch until it either hits the next pending
   * approval node (branch still active) or reaches the join node (branch
   * complete for join-all purposes). CC and auto-approval events encountered
   * in between are collected for the caller to persist.
   *
   * The `from` argument has two shapes so both fan-out (from the parallel
   * node into a branch-start via edge traversal) and post-approval advance
   * (from the approver's own branch-local approval node) can share this
   * walker.
   *   - `{ fromNodeKey, includeStartNode: true }`: the walker starts ON
   *     `fromNodeKey` — used by the fan-out path where the edge target is
   *     the branch's first business node.
   *   - `fromNodeKey` as a string (equivalent to `includeStartNode: false`):
   *     the walker starts on the node AFTER `fromNodeKey` — used by the
   *     post-approval advance path where the caller already processed the
   *     branch's current approval.
   */
  private resolveBranchAdvance(
    from: string | { fromNodeKey: string; includeStartNode: boolean },
    joinNodeKey: string,
  ): BranchAdvance {
    const ccEvents: ApprovalCcEvent[] = []
    const autoApprovalEvents: ApprovalGraphAutoApprovalEvent[] = []
    const visited = new Set<string>()

    const startNodeKey = typeof from === 'string' ? from : from.fromNodeKey
    const includeStart = typeof from === 'string' ? false : from.includeStartNode
    let currentKey: string | null = includeStart ? startNodeKey : this.firstTargetForNode(startNodeKey)

    while (currentKey) {
      if (visited.has(currentKey)) {
        throw new Error(`Parallel branch contains a cycle near ${currentKey}`)
      }
      visited.add(currentKey)

      if (currentKey === joinNodeKey) {
        return { kind: 'reached-join', ccEvents, autoApprovalEvents }
      }

      const node = this.nodeMap.get(currentKey)
      if (!node) {
        throw new Error(`Runtime graph references unknown node ${currentKey}`)
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
        const approvalMode = normalizeApprovalMode(approvalConfig.approvalMode)
        if (approvalConfig.assigneeIds.length === 0) {
          if (approvalConfig.emptyAssigneePolicy === 'auto-approve') {
            autoApprovalEvents.push({
              nodeKey: node.key,
              sourceStep,
              approvalMode,
              reason: 'empty-assignee',
            })
            currentKey = this.firstTargetForNode(node.key)
            continue
          }
          throw new Error(`Approval node ${node.key} has no assignees`)
        }
        return {
          kind: 'pending-approval',
          approvalNodeKey: node.key,
          assignments: approvalConfig.assigneeIds.map((assigneeId) => ({
            assignmentType: approvalConfig.assigneeType,
            assigneeId,
            nodeKey: node.key,
            sourceStep,
          })),
          ccEvents,
          autoApprovalEvents,
        }
      }

      if (node.type === 'parallel') {
        throw new Error(`Nested parallel nodes are not supported in v1 (at ${node.key})`)
      }

      if (node.type === 'end') {
        throw new Error(`Parallel branch terminated at an end node before reaching join ${joinNodeKey}`)
      }

      if (node.type === 'start') {
        throw new Error(`Parallel branch walker unexpectedly hit start node ${node.key}`)
      }

      throw new Error(`Unsupported node type ${node.type}`)
    }

    throw new Error(`Parallel branch starting from ${startNodeKey} did not reach join ${joinNodeKey}`)
  }

  private targetForEdge(edgeKey: string): string | null {
    const edge = this.runtimeGraph.edges.find((entry) => entry.key === edgeKey)
    return edge?.target || null
  }

  private stepIndexForNode(nodeKey: string): number {
    const index = this.approvalNodeOrder.indexOf(nodeKey)
    return index >= 0 ? index + 1 : 0
  }

  private getApprovalNodeConfig(nodeKey: string): ApprovalNodeConfig {
    const node = this.nodeMap.get(nodeKey)
    if (!node || node.type !== 'approval') {
      throw new Error(`Approval node ${nodeKey} is not registered in the runtime graph`)
    }
    const approvalConfig = isApprovalNodeConfig(node.config) ? node.config : null
    if (!approvalConfig) {
      throw new Error(`Approval node ${node.key} has invalid config`)
    }
    return approvalConfig
  }
}
