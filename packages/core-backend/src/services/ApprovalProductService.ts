import crypto from 'crypto'
import { pool } from '../db/pg'
import type {
  ApprovalActionRequest,
  ApprovalTemplateDetailDTO,
  ApprovalTemplateListItemDTO,
  ApprovalTemplateVersionDetailDTO,
  ApprovalGraph,
  ApprovalMode,
  CreateApprovalRequest,
  CreateApprovalTemplateRequest,
  EmptyAssigneePolicy,
  FormSchema,
  PublishApprovalTemplateRequest,
  RuntimeGraph,
  RuntimePolicy,
  UpdateApprovalTemplateRequest,
} from '../types/approval-product'
import {
  ApprovalGraphExecutor,
  type ApprovalGraphAutoApprovalEvent,
  type ParallelInstanceState,
  validateApprovalFormData,
} from './ApprovalGraphExecutor'
import type {
  ApprovalAssignmentDTO,
  ApprovalAssignmentRow,
  ApprovalInstanceRow,
  UnifiedApprovalDTO,
} from './approval-bridge-types'
import { APPROVAL_ERROR_CODES } from './approval-bridge-types'
import { ServiceError } from './ApprovalBridgeService'

interface ApprovalTemplateListQuery {
  status?: string
  search?: string
  /**
   * Wave 2 WP4 slice 1 — equality filter on `approval_templates.category`.
   * Empty / undefined leaves the filter unset (returns all categories AND
   * uncategorized rows). Trimmed by the router before reaching this layer.
   */
  category?: string
  limit: number
  offset: number
}

type TemplateVersionPreference = 'active' | 'latest'
const TEMPLATE_CLONE_KEY_ATTEMPTS = 3

interface CreateApprovalActor {
  userId: string
  userName?: string
  email?: string
  department?: string
  roles?: string[]
  permissions?: string[]
}

type TemplateRow = {
  id: string
  key: string
  name: string
  description: string | null
  /**
   * Wave 2 WP4 slice 1 — nullable group label for the template center filter.
   */
  category: string | null
  status: 'draft' | 'published' | 'archived'
  active_version_id: string | null
  latest_version_id: string | null
  created_at: Date
  updated_at: Date
}

type TemplateVersionRow = {
  id: string
  template_id: string
  version: number
  status: 'draft' | 'published' | 'archived'
  form_schema: Record<string, unknown>
  approval_graph: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === '23505'
}

type PublishedDefinitionRow = {
  id: string
  template_id: string
  template_version_id: string
  runtime_graph: Record<string, unknown>
  is_active: boolean
  published_at: Date
}

type TemplateBundle = {
  template: TemplateRow
  version: TemplateVersionRow
  publishedDefinition: PublishedDefinitionRow | null
}

type TemplateMetadataPatch = {
  key?: string
  name?: string
  description?: string | null
  /**
   * Wave 2 WP4 slice 1 — category edits on the parent template row. Explicit
   * `null` clears the field; `undefined` leaves it untouched.
   */
  category?: string | null
}

type ApprovalRecordInsert = {
  action: string
  actorId: string | null
  actorName: string | null
  comment: string | null
  fromStatus: string | null
  toStatus: string
  fromVersion: number | null
  toVersion: number
  metadata: Record<string, unknown>
  targetUserId?: string | null
}

type ApprovalDbClient = {
  query: typeof pool.query
  release: () => void
}

type ValidationContext = {
  status: number
  code: string
}

const REQUEST_VALIDATION_CONTEXT: ValidationContext = {
  status: 400,
  code: 'VALIDATION_ERROR',
}

const STORED_FORM_SCHEMA_CONTEXT: ValidationContext = {
  status: 500,
  code: 'APPROVAL_TEMPLATE_SCHEMA_INVALID',
}

const STORED_GRAPH_CONTEXT: ValidationContext = {
  status: 500,
  code: 'APPROVAL_TEMPLATE_GRAPH_INVALID',
}

const STORED_RUNTIME_CONTEXT: ValidationContext = {
  status: 500,
  code: 'APPROVAL_RUNTIME_GRAPH_INVALID',
}

const FORM_FIELD_TYPES = new Set([
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'select',
  'multi-select',
  'user',
  'attachment',
])

const APPROVAL_NODE_TYPES = new Set(['start', 'approval', 'cc', 'condition', 'parallel', 'end'])
const CONDITION_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'isEmpty'])
const APPROVAL_MODES = new Set<ApprovalMode>(['single', 'all', 'any'])
const PARALLEL_JOIN_MODES = new Set(['all', 'any'])
const EMPTY_ASSIGNEE_POLICIES = new Set<EmptyAssigneePolicy>(['error', 'auto-approve'])

function toNullableRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeApprovalMode(value: unknown, context: ValidationContext, path: string): ApprovalMode | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !APPROVAL_MODES.has(value as ApprovalMode)) {
    failValidation(context, `${path} must be single, all, or any`)
  }
  return value as ApprovalMode
}

function normalizeEmptyAssigneePolicy(
  value: unknown,
  context: ValidationContext,
  path: string,
): EmptyAssigneePolicy | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !EMPTY_ASSIGNEE_POLICIES.has(value as EmptyAssigneePolicy)) {
    failValidation(context, `${path} must be error or auto-approve`)
  }
  return value as EmptyAssigneePolicy
}

function failValidation(context: ValidationContext, message: string): never {
  throw new ServiceError(message, context.status, context.code)
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry))
    return Object.freeze(value)
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry))
    return Object.freeze(value)
  }
  return value
}

async function rollbackQuietly(client: ApprovalDbClient | null): Promise<void> {
  if (!client) return
  try {
    await client.query('ROLLBACK')
  } catch {
    // Ignore rollback errors so the original failure is preserved.
  }
}

function normalizeFormField(
  value: unknown,
  index: number,
  context: ValidationContext,
): FormSchema['fields'][number] {
  if (!isRecord(value)) {
    failValidation(context, `formSchema.fields[${index}] must be an object`)
  }
  if (!isNonEmptyString(value.id)) {
    failValidation(context, `formSchema.fields[${index}].id is required`)
  }
  if (!FORM_FIELD_TYPES.has(String(value.type))) {
    failValidation(context, `formSchema.fields[${index}].type is invalid`)
  }
  if (!isNonEmptyString(value.label)) {
    failValidation(context, `formSchema.fields[${index}].label is required`)
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    failValidation(context, `formSchema.fields[${index}].required must be a boolean`)
  }
  if (value.placeholder !== undefined && typeof value.placeholder !== 'string') {
    failValidation(context, `formSchema.fields[${index}].placeholder must be a string`)
  }
  if (
    value.options !== undefined &&
    (!Array.isArray(value.options)
      || value.options.some(
        (option, optionIndex) =>
          !isRecord(option)
          || !isNonEmptyString(option.label)
          || !isNonEmptyString(option.value)
          || optionIndex < 0,
      ))
  ) {
    failValidation(context, `formSchema.fields[${index}].options must be an array of label/value pairs`)
  }
  if (value.props !== undefined && !isRecord(value.props)) {
    failValidation(context, `formSchema.fields[${index}].props must be an object`)
  }

  return {
    id: value.id.trim(),
    type: value.type as FormSchema['fields'][number]['type'],
    label: value.label.trim(),
    ...(value.required !== undefined ? { required: value.required } : {}),
    ...(value.placeholder !== undefined ? { placeholder: value.placeholder } : {}),
    ...(value.defaultValue !== undefined ? { defaultValue: value.defaultValue } : {}),
    ...(Array.isArray(value.options)
      ? {
          options: value.options.map((option) => ({
            label: (option as { label: string }).label.trim(),
            value: (option as { value: string }).value.trim(),
          })),
        }
      : {}),
    ...(isRecord(value.props) ? { props: { ...value.props } } : {}),
  } as FormSchema['fields'][number]
}

function assertFormSchema(value: unknown, context: ValidationContext = REQUEST_VALIDATION_CONTEXT): FormSchema {
  if (!isRecord(value) || !Array.isArray(value.fields)) {
    failValidation(context, 'formSchema must contain fields')
  }

  return {
    fields: value.fields.map((field, index) => normalizeFormField(field, index, context)),
  }
}

function normalizeApprovalGraph(value: unknown, context: ValidationContext): ApprovalGraph {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    failValidation(context, 'approvalGraph must contain nodes and edges')
  }

  const nodes = value.nodes.map((node, index) => {
    if (!isRecord(node)) {
      failValidation(context, `approvalGraph.nodes[${index}] must be an object`)
    }
    if (!isNonEmptyString(node.key)) {
      failValidation(context, `approvalGraph.nodes[${index}].key is required`)
    }
    if (!APPROVAL_NODE_TYPES.has(String(node.type))) {
      failValidation(context, `approvalGraph.nodes[${index}].type is invalid`)
    }
    if (!isRecord(node.config)) {
      failValidation(context, `approvalGraph.nodes[${index}].config must be an object`)
    }

    const normalizedNode = {
      key: node.key.trim(),
      type: node.type as ApprovalGraph['nodes'][number]['type'],
      ...(typeof node.name === 'string' && node.name.trim().length > 0 ? { name: node.name.trim() } : {}),
      config: {} as Record<string, unknown>,
    }

    switch (node.type) {
      case 'approval':
        if ((node.config.assigneeType !== 'user' && node.config.assigneeType !== 'role')
          || !Array.isArray(node.config.assigneeIds)
          || node.config.assigneeIds.some((entry) => !isNonEmptyString(entry))) {
          failValidation(context, `approvalGraph.nodes[${index}].config must define assigneeType and assigneeIds`)
        }
        {
          const approvalMode = normalizeApprovalMode(
            node.config.approvalMode,
            context,
            `approvalGraph.nodes[${index}].config.approvalMode`,
          )
          const emptyAssigneePolicy = normalizeEmptyAssigneePolicy(
            node.config.emptyAssigneePolicy,
            context,
            `approvalGraph.nodes[${index}].config.emptyAssigneePolicy`,
          )
          normalizedNode.config = {
            assigneeType: node.config.assigneeType,
            assigneeIds: node.config.assigneeIds.map((entry) => entry.trim()),
            ...(approvalMode ? { approvalMode } : {}),
            ...(emptyAssigneePolicy ? { emptyAssigneePolicy } : {}),
          }
        }
        break
      case 'cc':
        if ((node.config.targetType !== 'user' && node.config.targetType !== 'role')
          || !Array.isArray(node.config.targetIds)
          || node.config.targetIds.some((entry) => !isNonEmptyString(entry))) {
          failValidation(context, `approvalGraph.nodes[${index}].config must define targetType and targetIds`)
        }
        normalizedNode.config = {
          targetType: node.config.targetType,
          targetIds: node.config.targetIds.map((entry) => entry.trim()),
        }
        break
      case 'parallel':
        if (!Array.isArray(node.config.branches)
          || node.config.branches.some((entry) => !isNonEmptyString(entry))
          || node.config.branches.length < 2) {
          failValidation(
            context,
            `approvalGraph.nodes[${index}].config.branches must list at least two edgeKeys`,
          )
        }
        if (!isNonEmptyString(node.config.joinNodeKey)) {
          failValidation(
            context,
            `approvalGraph.nodes[${index}].config.joinNodeKey is required`,
          )
        }
        if (typeof node.config.joinMode !== 'string' || !PARALLEL_JOIN_MODES.has(node.config.joinMode)) {
          failValidation(
            context,
            `approvalGraph.nodes[${index}].config.joinMode must be 'all' or 'any'`,
          )
        }
        normalizedNode.config = {
          branches: (node.config.branches as string[]).map((entry) => entry.trim()),
          joinMode: node.config.joinMode,
          joinNodeKey: (node.config.joinNodeKey as string).trim(),
        }
        break
      case 'condition':
        if (!Array.isArray(node.config.branches)) {
          failValidation(context, `approvalGraph.nodes[${index}].config.branches must be an array`)
        }
        normalizedNode.config = {
          branches: node.config.branches.map((branch, branchIndex) => {
            if (!isRecord(branch) || !isNonEmptyString(branch.edgeKey) || !Array.isArray(branch.rules)) {
              failValidation(context, `approvalGraph.nodes[${index}].config.branches[${branchIndex}] is invalid`)
            }
            if (branch.conjunction !== undefined && branch.conjunction !== 'and' && branch.conjunction !== 'or') {
              failValidation(context, `approvalGraph.nodes[${index}].config.branches[${branchIndex}].conjunction is invalid`)
            }
            return {
              edgeKey: branch.edgeKey.trim(),
              ...(branch.conjunction ? { conjunction: branch.conjunction } : {}),
              rules: branch.rules.map((rule, ruleIndex) => {
                if (!isRecord(rule) || !isNonEmptyString(rule.fieldId) || !CONDITION_OPERATORS.has(String(rule.operator))) {
                  failValidation(
                    context,
                    `approvalGraph.nodes[${index}].config.branches[${branchIndex}].rules[${ruleIndex}] is invalid`,
                  )
                }
                return {
                  fieldId: rule.fieldId.trim(),
                  operator: rule.operator,
                  ...(rule.value !== undefined ? { value: rule.value } : {}),
                }
              }),
            }
          }),
          ...(isNonEmptyString(node.config.defaultEdgeKey)
            ? { defaultEdgeKey: node.config.defaultEdgeKey.trim() }
            : {}),
        }
        break
      default:
        normalizedNode.config = {}
        break
    }

    return normalizedNode as ApprovalGraph['nodes'][number]
  })

  const nodeKeys = new Set(nodes.map((node) => node.key))
  if (nodeKeys.size !== nodes.length) {
    failValidation(context, 'approvalGraph node keys must be unique')
  }

  const edges = value.edges.map((edge, index) => {
    if (!isRecord(edge) || !isNonEmptyString(edge.key) || !isNonEmptyString(edge.source) || !isNonEmptyString(edge.target)) {
      failValidation(context, `approvalGraph.edges[${index}] is invalid`)
    }
    return {
      key: edge.key.trim(),
      source: edge.source.trim(),
      target: edge.target.trim(),
    }
  })

  const edgeKeys = new Set(edges.map((edge) => edge.key))
  if (edgeKeys.size !== edges.length) {
    failValidation(context, 'approvalGraph edge keys must be unique')
  }
  if (edges.some((edge) => !nodeKeys.has(edge.source) || !nodeKeys.has(edge.target))) {
    failValidation(context, 'approvalGraph edges must reference known nodes')
  }

  // Parallel-gateway structural validation: referenced edges and join node must
  // exist; branches must not share approval-node assignees (v1 limitation — the
  // approval_assignments.active-unique index cannot represent the same user
  // being active in two branches at once). Nested parallel is rejected too.
  const edgeMap = new Map(edges.map((edge) => [edge.key, edge]))
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]))
  for (const node of nodes) {
    if (node.type !== 'parallel') continue
    const parallelConfig = node.config as { branches: string[]; joinNodeKey: string }
    for (const branchEdgeKey of parallelConfig.branches) {
      const edge = edgeMap.get(branchEdgeKey)
      if (!edge || edge.source !== node.key) {
        failValidation(
          context,
          `approvalGraph parallel node ${node.key} references unknown branch edge ${branchEdgeKey}`,
        )
      }
    }
    const joinNode = nodeByKey.get(parallelConfig.joinNodeKey)
    if (!joinNode) {
      failValidation(
        context,
        `approvalGraph parallel node ${node.key} references unknown join node ${parallelConfig.joinNodeKey}`,
      )
    }

    // Collect the approval-node assignees reachable from each branch start up to
    // the join node. Reject duplicate assigneeIds across branches because the
    // active-assignment unique index cannot hold two active rows for the same
    // user at once. Nested parallel is explicitly rejected in v1.
    const assigneesPerBranch: Array<Set<string>> = []
    for (const branchEdgeKey of parallelConfig.branches) {
      const edge = edgeMap.get(branchEdgeKey)!
      const branchAssignees = collectBranchAssignees(
        edge.target,
        parallelConfig.joinNodeKey,
        nodeByKey,
        edges,
        context,
      )
      assigneesPerBranch.push(branchAssignees)
    }
    const seen = new Set<string>()
    for (const branchAssignees of assigneesPerBranch) {
      for (const assignee of branchAssignees) {
        if (seen.has(assignee)) {
          failValidation(
            context,
            `approvalGraph parallel node ${node.key} has duplicate approver '${assignee}' across branches`,
          )
        }
        seen.add(assignee)
      }
    }
  }

  return { nodes, edges }
}

function collectBranchAssignees(
  startNodeKey: string,
  joinNodeKey: string,
  nodeByKey: Map<string, ApprovalGraph['nodes'][number]>,
  edges: ApprovalGraph['edges'],
  context: ValidationContext,
): Set<string> {
  const assignees = new Set<string>()
  const outgoing = new Map<string, ApprovalGraph['edges']>()
  for (const edge of edges) {
    const existing = outgoing.get(edge.source) || []
    existing.push(edge)
    outgoing.set(edge.source, existing)
  }

  const visited = new Set<string>()
  let currentKey: string | null = startNodeKey
  while (currentKey) {
    if (currentKey === joinNodeKey) return assignees
    if (visited.has(currentKey)) {
      failValidation(context, `approvalGraph parallel branch contains a cycle near ${currentKey}`)
    }
    visited.add(currentKey)
    const node = nodeByKey.get(currentKey)
    if (!node) {
      failValidation(context, `approvalGraph parallel branch references unknown node ${currentKey}`)
    }
    if (node.type === 'parallel') {
      failValidation(context, `approvalGraph parallel branch cannot contain nested parallel node ${node.key}`)
    }
    if (node.type === 'end') {
      failValidation(
        context,
        `approvalGraph parallel branch must reach join before end (at ${node.key})`,
      )
    }
    if (node.type === 'approval') {
      const approvalConfig = node.config as { assigneeIds?: string[] }
      for (const assignee of approvalConfig.assigneeIds ?? []) {
        assignees.add(assignee)
      }
    }
    // Walk the first outgoing edge — condition nodes aren't explored for every
    // branch here (the form-data isn't available at template validation
    // time), so duplicate detection is conservative across the statically
    // reachable first-edge path. Condition branches inside parallel remain
    // legal at runtime; this check only flags obvious overlaps.
    const nextEdge = outgoing.get(currentKey)?.[0]
    currentKey = nextEdge?.target ?? null
  }
  failValidation(
    context,
    `approvalGraph parallel branch starting near ${startNodeKey} never reaches join ${joinNodeKey}`,
  )
}

function asApprovalGraph(value: Record<string, unknown>): ApprovalGraph {
  return normalizeApprovalGraph(value, STORED_GRAPH_CONTEXT)
}

function toApprovalTemplateListItemDTO(row: TemplateRow): ApprovalTemplateListItemDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    // Wave 2 WP4 slice 1 — older rows predate the column; coerce undefined to null.
    category: row.category ?? null,
    status: row.status,
    activeVersionId: row.active_version_id,
    latestVersionId: row.latest_version_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toApprovalTemplateDetailDTO(bundle: TemplateBundle): ApprovalTemplateDetailDTO {
  return {
    ...toApprovalTemplateListItemDTO(bundle.template),
    formSchema: asFormSchema(bundle.version.form_schema),
    approvalGraph: asApprovalGraph(bundle.version.approval_graph),
  }
}

function toApprovalTemplateVersionDetailDTO(bundle: TemplateBundle): ApprovalTemplateVersionDetailDTO {
  return {
    id: bundle.version.id,
    templateId: bundle.version.template_id,
    version: bundle.version.version,
    status: bundle.version.status,
    formSchema: asFormSchema(bundle.version.form_schema),
    approvalGraph: asApprovalGraph(bundle.version.approval_graph),
    runtimeGraph: bundle.publishedDefinition ? asRuntimeGraph(bundle.publishedDefinition.runtime_graph) : null,
    publishedDefinitionId: bundle.publishedDefinition?.id || null,
    createdAt: bundle.version.created_at.toISOString(),
    updatedAt: bundle.version.updated_at.toISOString(),
  }
}

function toUnifiedApprovalDTO(
  row: ApprovalInstanceRow,
  assignments: ApprovalAssignmentDTO[],
): UnifiedApprovalDTO {
  // Surface `currentNodeKeys` when the instance is inside a parallel region so
  // consumers (frontend timeline, callers checking `.length > 1`) can detect
  // parallel state without peeking at metadata. When there's no parallel
  // state, we leave the field undefined; callers continue to use
  // `currentNodeKey` unchanged.
  const parallelState = readParallelBranchStates(row.metadata)
  const currentNodeKeys = parallelState
    ? Object.values(parallelState.branches)
        .filter((entry) => !entry.complete && entry.currentNodeKey)
        .map((entry) => entry.currentNodeKey as string)
    : undefined

  return {
    id: row.id,
    sourceSystem: row.source_system,
    externalApprovalId: row.external_approval_id,
    workflowKey: row.workflow_key,
    businessKey: row.business_key,
    title: row.title,
    status: row.status,
    requester: toNullableRecord(row.requester_snapshot),
    subject: toNullableRecord(row.subject_snapshot),
    policy: toNullableRecord(row.policy_snapshot),
    currentStep: row.current_step,
    totalSteps: row.total_steps,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    publishedDefinitionId: row.published_definition_id,
    requestNo: row.request_no,
    formSnapshot: toNullableRecord(row.form_snapshot),
    currentNodeKey: row.current_node_key,
    ...(currentNodeKeys ? { currentNodeKeys } : {}),
    assignments,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function assignmentMatchesActor(
  assignment: ApprovalAssignmentRow,
  actorId: string,
  actorRoles: string[],
): boolean {
  if (!assignment.is_active) return false
  if (assignment.assignment_type === 'user') {
    return assignment.assignee_id === actorId
  }
  if (assignment.assignment_type === 'role') {
    return actorRoles.includes(assignment.assignee_id)
  }
  return false
}

function normalizePage(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ServiceError(`${fieldName} is required`, 400, 'VALIDATION_ERROR')
  }
  return value.trim()
}

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new ServiceError('String value expected', 400, 'VALIDATION_ERROR')
  }
  return value.trim()
}

/**
 * Wave 2 WP4 slice 1 — category normalization.
 *   - `undefined` → `undefined` (meaning "caller didn't touch this field")
 *   - `null` / empty / whitespace → `null` (explicit "clear")
 *   - non-empty string → trimmed
 *   - > 64 chars → 400 VALIDATION_ERROR
 *   - non-string → 400 VALIDATION_ERROR
 */
const APPROVAL_TEMPLATE_CATEGORY_MAX_LENGTH = 64

function normalizeTemplateCategory(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new ServiceError('category must be a string', 400, 'VALIDATION_ERROR')
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > APPROVAL_TEMPLATE_CATEGORY_MAX_LENGTH) {
    throw new ServiceError(
      `category must be at most ${APPROVAL_TEMPLATE_CATEGORY_MAX_LENGTH} characters`,
      400,
      'VALIDATION_ERROR',
    )
  }
  return trimmed
}

function assertApprovalGraph(value: unknown, context: ValidationContext = REQUEST_VALIDATION_CONTEXT): ApprovalGraph {
  return normalizeApprovalGraph(value, context)
}

function asFormSchema(value: Record<string, unknown>): FormSchema {
  return assertFormSchema(value, STORED_FORM_SCHEMA_CONTEXT)
}

function assertRuntimePolicy(
  value: unknown,
  context: ValidationContext = REQUEST_VALIDATION_CONTEXT,
): RuntimePolicy {
  const policy = value as { allowRevoke?: unknown; revokeBeforeNodeKeys?: unknown } | null
  if (typeof value !== 'object' || value === null || typeof policy?.allowRevoke !== 'boolean') {
    failValidation(context, 'policy.allowRevoke is required')
  }
  if (
    policy.revokeBeforeNodeKeys !== undefined &&
    (!Array.isArray(policy.revokeBeforeNodeKeys) ||
      !policy.revokeBeforeNodeKeys.every((item) => typeof item === 'string' && item.trim().length > 0))
  ) {
    failValidation(context, 'policy.revokeBeforeNodeKeys must be a string array')
  }
  return {
    allowRevoke: policy.allowRevoke,
    revokeBeforeNodeKeys: Array.isArray(policy.revokeBeforeNodeKeys)
      ? policy.revokeBeforeNodeKeys.map((item) => item.trim())
      : undefined,
  }
}

function asRuntimeGraph(value: Record<string, unknown>): RuntimeGraph {
  if (!isRecord(value)) {
    failValidation(STORED_RUNTIME_CONTEXT, 'runtimeGraph must be an object')
  }

  const graph = assertApprovalGraph(
    {
      nodes: value.nodes,
      edges: value.edges,
    },
    STORED_RUNTIME_CONTEXT,
  )
  const policy = assertRuntimePolicy(value.policy, STORED_RUNTIME_CONTEXT)

  return deepFreeze({
    ...graph,
    policy,
  })
}

function buildRuntimeGraph(approvalGraph: ApprovalGraph, policy: RuntimePolicy): RuntimeGraph {
  const copied = JSON.parse(JSON.stringify(approvalGraph)) as ApprovalGraph
  return deepFreeze({
    ...copied,
    policy: {
      allowRevoke: policy.allowRevoke,
      ...(policy.revokeBeforeNodeKeys ? { revokeBeforeNodeKeys: [...policy.revokeBeforeNodeKeys] } : {}),
    },
  })
}

function buildPersistableParallelState(state: ParallelInstanceState): Record<string, unknown> {
  return {
    parallelNodeKey: state.parallelNodeKey,
    joinNodeKey: state.joinNodeKey,
    joinMode: state.joinMode,
    branches: Object.fromEntries(
      Object.entries(state.branches).map(([edgeKey, entry]) => [
        edgeKey,
        {
          edgeKey: entry.edgeKey,
          currentNodeKey: entry.currentNodeKey,
          complete: entry.complete,
        },
      ]),
    ),
  }
}

function readParallelBranchStates(metadata: unknown): ParallelInstanceState | null {
  if (!isRecord(metadata)) return null
  const states = (metadata as { parallelBranchStates?: unknown }).parallelBranchStates
  if (!isRecord(states)) return null
  if (typeof states.parallelNodeKey !== 'string'
    || typeof states.joinNodeKey !== 'string'
    || (states.joinMode !== 'all' && states.joinMode !== 'any')
    || !isRecord(states.branches)) {
    return null
  }
  const branches: Record<string, ParallelInstanceState['branches'][string]> = {}
  for (const [edgeKey, entryRaw] of Object.entries(states.branches)) {
    if (!isRecord(entryRaw)) return null
    const entry = entryRaw as { edgeKey?: unknown; currentNodeKey?: unknown; complete?: unknown }
    if (typeof entry.edgeKey !== 'string') return null
    if (entry.currentNodeKey !== null && typeof entry.currentNodeKey !== 'string') return null
    if (typeof entry.complete !== 'boolean') return null
    branches[edgeKey] = {
      edgeKey: entry.edgeKey,
      currentNodeKey: entry.currentNodeKey as string | null,
      complete: entry.complete,
    }
  }
  return {
    parallelNodeKey: states.parallelNodeKey as string,
    joinNodeKey: states.joinNodeKey as string,
    joinMode: states.joinMode as 'all' | 'any',
    branches,
  }
}

export class ApprovalProductService {
  async listTemplates(query: ApprovalTemplateListQuery): Promise<{ data: ApprovalTemplateListItemDTO[]; total: number }> {
    if (!pool) throw new Error('Database not available')

    const conditions: string[] = []
    const params: unknown[] = []
    let index = 1

    if (query.status) {
      conditions.push(`status = $${index++}`)
      params.push(query.status)
    }
    if (query.search) {
      conditions.push(`(name ILIKE $${index} OR key ILIKE $${index})`)
      params.push(`%${query.search}%`)
      index += 1
    }
    if (query.category) {
      conditions.push(`category = $${index++}`)
      params.push(query.category)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const totalResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM approval_templates ${where}`,
      params,
    )
    const result = await pool.query<TemplateRow>(
      `SELECT *
       FROM approval_templates
       ${where}
       ORDER BY updated_at DESC, id DESC
       LIMIT $${index++} OFFSET $${index++}`,
      [...params, query.limit, query.offset],
    )

    return {
      data: result.rows.map(toApprovalTemplateListItemDTO),
      total: Number.parseInt(totalResult.rows[0]?.count || '0', 10),
    }
  }

  async getTemplate(id: string): Promise<ApprovalTemplateDetailDTO | null> {
    const bundle = await this.loadTemplateBundle(id, undefined, 'latest')
    return bundle ? toApprovalTemplateDetailDTO(bundle) : null
  }

  async getTemplateVersion(templateId: string, versionId: string): Promise<ApprovalTemplateVersionDetailDTO | null> {
    const bundle = await this.loadTemplateBundle(templateId, versionId)
    return bundle ? toApprovalTemplateVersionDetailDTO(bundle) : null
  }

  async createTemplate(request: CreateApprovalTemplateRequest): Promise<ApprovalTemplateDetailDTO> {
    if (!pool) throw new Error('Database not available')

    const key = normalizeRequiredString(request.key, 'key')
    const name = normalizeRequiredString(request.name, 'name')
    const description = normalizeOptionalString(request.description)
    // Wave 2 WP4 slice 1 — category is optional; `undefined`/empty → null.
    const category = normalizeTemplateCategory(request.category) ?? null
    const formSchema = assertFormSchema(request.formSchema)
    const approvalGraph = assertApprovalGraph(request.approvalGraph)

    let client: ApprovalDbClient | null = null
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      const templateResult = await client.query<TemplateRow>(
        `INSERT INTO approval_templates (key, name, description, category, status)
         VALUES ($1, $2, $3, $4, 'draft')
         RETURNING *`,
        [key, name, description ?? null, category],
      )
      let template = templateResult.rows[0]

      const versionResult = await client.query<TemplateVersionRow>(
        `INSERT INTO approval_template_versions (template_id, version, status, form_schema, approval_graph)
         VALUES ($1, 1, 'draft', $2, $3)
         RETURNING *`,
        [template.id, JSON.stringify(formSchema), JSON.stringify(approvalGraph)],
      )
      const version = versionResult.rows[0]

      const updatedTemplateResult = await client.query<TemplateRow>(
        `UPDATE approval_templates
         SET latest_version_id = $1, updated_at = now()
         WHERE id = $2
         RETURNING *`,
        [version.id, template.id],
      )
      template = updatedTemplateResult.rows[0]

      await client.query('COMMIT')

      return toApprovalTemplateDetailDTO({
        template,
        version,
        publishedDefinition: null,
      })
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    } finally {
      client?.release()
    }
  }

  async updateTemplate(id: string, request: UpdateApprovalTemplateRequest): Promise<ApprovalTemplateDetailDTO> {
    if (!pool) throw new Error('Database not available')

    const metadataPatch: TemplateMetadataPatch = {}
    if (request.key !== undefined) metadataPatch.key = normalizeRequiredString(request.key, 'key')
    if (request.name !== undefined) metadataPatch.name = normalizeRequiredString(request.name, 'name')
    if (request.description !== undefined) metadataPatch.description = normalizeOptionalString(request.description) ?? null
    if (request.category !== undefined) {
      // Wave 2 WP4 slice 1 — category lives on the parent row and is NOT
      // snapshotted into a new `approval_template_versions` record. Changing
      // only category leaves the form/approval graph untouched.
      metadataPatch.category = normalizeTemplateCategory(request.category) ?? null
    }

    const formSchema = request.formSchema !== undefined ? assertFormSchema(request.formSchema) : undefined
    const approvalGraph = request.approvalGraph !== undefined ? assertApprovalGraph(request.approvalGraph) : undefined

    let client: ApprovalDbClient | null = null
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      const templateResult = await client.query<TemplateRow>(
        `SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE`,
        [id],
      )
      let template = templateResult.rows[0]
      if (!template) {
        throw new ServiceError('Approval template not found', 404, 'APPROVAL_TEMPLATE_NOT_FOUND')
      }

      if (Object.keys(metadataPatch).length > 0) {
        const setClauses: string[] = []
        const params: unknown[] = []
        let index = 1

        if (metadataPatch.key !== undefined) {
          setClauses.push(`key = $${index++}`)
          params.push(metadataPatch.key)
        }
        if (metadataPatch.name !== undefined) {
          setClauses.push(`name = $${index++}`)
          params.push(metadataPatch.name)
        }
        if (metadataPatch.description !== undefined) {
          setClauses.push(`description = $${index++}`)
          params.push(metadataPatch.description)
        }
        if (metadataPatch.category !== undefined) {
          setClauses.push(`category = $${index++}`)
          params.push(metadataPatch.category)
        }
        setClauses.push('updated_at = now()')
        params.push(id)

        const updatedTemplateResult = await client.query<TemplateRow>(
          `UPDATE approval_templates
           SET ${setClauses.join(', ')}
           WHERE id = $${index}
           RETURNING *`,
          params,
        )
        template = updatedTemplateResult.rows[0]
      }

      let version: TemplateVersionRow | null = null
      const shouldCreateVersion = formSchema !== undefined || approvalGraph !== undefined
      if (shouldCreateVersion) {
        const latestVersionResult = await client.query<TemplateVersionRow>(
          `SELECT *
           FROM approval_template_versions
           WHERE template_id = $1
           ORDER BY version DESC
           LIMIT 1`,
          [id],
        )
        const latestVersion = latestVersionResult.rows[0]
        if (!latestVersion) {
          throw new ServiceError('Approval template version not found', 404, 'APPROVAL_TEMPLATE_VERSION_NOT_FOUND')
        }

        const maxVersionResult = await client.query<{ max_version: string }>(
          `SELECT COALESCE(MAX(version), 0)::text AS max_version
           FROM approval_template_versions
           WHERE template_id = $1`,
          [id],
        )
        const nextVersion = Number.parseInt(maxVersionResult.rows[0]?.max_version || '0', 10) + 1

        const versionResult = await client.query<TemplateVersionRow>(
          `INSERT INTO approval_template_versions (template_id, version, status, form_schema, approval_graph)
           VALUES ($1, $2, 'draft', $3, $4)
           RETURNING *`,
          [
            id,
            nextVersion,
            JSON.stringify(formSchema ?? latestVersion.form_schema),
            JSON.stringify(approvalGraph ?? latestVersion.approval_graph),
          ],
        )
        version = versionResult.rows[0]

        const updatedTemplateResult = await client.query<TemplateRow>(
          `UPDATE approval_templates
           SET latest_version_id = $1, updated_at = now()
           WHERE id = $2
           RETURNING *`,
          [version.id, id],
        )
        template = updatedTemplateResult.rows[0]
      } else {
        const bundle = await this.loadTemplateBundleWithClient(client, id, undefined, 'latest')
        version = bundle?.version ?? null
      }

      await client.query('COMMIT')

      if (!version) {
        throw new ServiceError('Approval template version not found', 404, 'APPROVAL_TEMPLATE_VERSION_NOT_FOUND')
      }

      return toApprovalTemplateDetailDTO({
        template,
        version,
        publishedDefinition: null,
      })
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    } finally {
      client?.release()
    }
  }

  async publishTemplate(id: string, request: PublishApprovalTemplateRequest): Promise<ApprovalTemplateVersionDetailDTO> {
    if (!pool) throw new Error('Database not available')

    const policy = assertRuntimePolicy(request.policy)
    let client: ApprovalDbClient | null = null
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      const templateResult = await client.query<TemplateRow>(
        `SELECT * FROM approval_templates WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const template = templateResult.rows[0]
      if (!template) {
        throw new ServiceError('Approval template not found', 404, 'APPROVAL_TEMPLATE_NOT_FOUND')
      }
      if (!template.latest_version_id) {
        throw new ServiceError('Approval template has no version to publish', 400, 'APPROVAL_TEMPLATE_VERSION_NOT_FOUND')
      }

      const versionResult = await client.query<TemplateVersionRow>(
        `SELECT * FROM approval_template_versions WHERE id = $1 AND template_id = $2`,
        [template.latest_version_id, id],
      )
      const version = versionResult.rows[0]
      if (!version) {
        throw new ServiceError('Approval template version not found', 404, 'APPROVAL_TEMPLATE_VERSION_NOT_FOUND')
      }

      await client.query(
        `UPDATE approval_published_definitions
         SET is_active = FALSE
         WHERE template_id = $1 AND is_active = TRUE`,
        [id],
      )

      const runtimeGraph = buildRuntimeGraph(asApprovalGraph(version.approval_graph), policy)

      const publishedDefinitionResult = await client.query<PublishedDefinitionRow>(
        `INSERT INTO approval_published_definitions (template_id, template_version_id, runtime_graph, is_active, published_at)
         VALUES ($1, $2, $3, TRUE, now())
         RETURNING *`,
        [id, version.id, JSON.stringify(runtimeGraph)],
      )
      const publishedDefinition = publishedDefinitionResult.rows[0]

      const updatedVersionResult = await client.query<TemplateVersionRow>(
        `UPDATE approval_template_versions
         SET status = 'published', updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [version.id],
      )
      const updatedVersion = updatedVersionResult.rows[0]

      await client.query(
        `UPDATE approval_templates
         SET status = 'published',
             active_version_id = $1,
             updated_at = now()
         WHERE id = $2`,
        [version.id, id],
      )

      await client.query('COMMIT')

      return toApprovalTemplateVersionDetailDTO({
        template,
        version: updatedVersion,
        publishedDefinition,
      })
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    } finally {
      client?.release()
    }
  }

  /**
   * Wave 2 WP4 slice 1 — list distinct, non-null categories used by templates
   * in `approval_templates`. Drives the template center dropdown filter.
   *
   * Returns a sorted array of strings. We do this server-side rather than
   * client-side because the template row count is small and this keeps the
   * frontend from paging through every template just to populate a filter.
   */
  async listTemplateCategories(): Promise<string[]> {
    if (!pool) throw new Error('Database not available')
    const result = await pool.query<{ category: string }>(
      `SELECT DISTINCT category
       FROM approval_templates
       WHERE category IS NOT NULL
       ORDER BY category ASC`,
    )
    return result.rows.map((row) => row.category).filter((v) => typeof v === 'string' && v.length > 0)
  }

  /**
   * Wave 2 WP4 slice 1 — clone an existing template as a new DRAFT.
   *
   * Copies:
   *   - formSchema + approvalGraph from the source's latest version
   *   - category (so the clone lands in the same group)
   * Does NOT copy:
   *   - published_definition (the clone is a draft until the caller publishes)
   *   - status (the clone is always 'draft')
   *   - version history (fresh version 1)
   *
   * Name / key mutations:
   *   - name:  `"{original} (副本)"`
   *   - key:   `"{original}_copy_<6 hex chars>"`     (guarantees uniqueness)
   *
   * Permission: callers must already hold `approval-templates:manage`; this
   * method treats the clone as an ordinary draft creation from the acting
   * admin's perspective.
   */
  async cloneTemplate(id: string): Promise<ApprovalTemplateDetailDTO> {
    if (!pool) throw new Error('Database not available')

    // Load the source bundle — we prefer the `latest` version so that
    // in-flight draft edits carry over, but the source template itself can
    // sit in any status (draft / published / archived).
    const source = await this.loadTemplateBundle(id, undefined, 'latest')
    if (!source) {
      throw new ServiceError('Approval template not found', 404, 'APPROVAL_TEMPLATE_NOT_FOUND')
    }
    if (!source.version) {
      throw new ServiceError('Approval template has no version to clone', 400, 'APPROVAL_TEMPLATE_VERSION_NOT_FOUND')
    }

    const newName = `${source.template.name} (副本)`

    for (let attempt = 0; attempt < TEMPLATE_CLONE_KEY_ATTEMPTS; attempt += 1) {
      // `crypto.randomBytes(3).toString('hex')` yields exactly 6 hex chars.
      const copySuffix = crypto.randomBytes(3).toString('hex')
      const newKey = `${source.template.key}_copy_${copySuffix}`
      let client: ApprovalDbClient | null = null
      try {
        client = await pool.connect()
        await client.query('BEGIN')

        const templateResult = await client.query<TemplateRow>(
          `INSERT INTO approval_templates (key, name, description, category, status)
           VALUES ($1, $2, $3, $4, 'draft')
           RETURNING *`,
          [newKey, newName, source.template.description, source.template.category ?? null],
        )
        let template = templateResult.rows[0]

        const versionResult = await client.query<TemplateVersionRow>(
          `INSERT INTO approval_template_versions (template_id, version, status, form_schema, approval_graph)
           VALUES ($1, 1, 'draft', $2, $3)
           RETURNING *`,
          [
            template.id,
            JSON.stringify(source.version.form_schema),
            JSON.stringify(source.version.approval_graph),
          ],
        )
        const version = versionResult.rows[0]

        const updatedTemplateResult = await client.query<TemplateRow>(
          `UPDATE approval_templates
           SET latest_version_id = $1, updated_at = now()
           WHERE id = $2
           RETURNING *`,
          [version.id, template.id],
        )
        template = updatedTemplateResult.rows[0]

        await client.query('COMMIT')

        return toApprovalTemplateDetailDTO({
          template,
          version,
          publishedDefinition: null,
        })
      } catch (error) {
        await rollbackQuietly(client)
        if (isPostgresUniqueViolation(error) && attempt < TEMPLATE_CLONE_KEY_ATTEMPTS - 1) {
          continue
        }
        if (isPostgresUniqueViolation(error)) {
          throw new ServiceError(
            'Approval template clone key conflict',
            409,
            'APPROVAL_TEMPLATE_CLONE_KEY_CONFLICT',
          )
        }
        throw error
      } finally {
        client?.release()
      }
    }

    throw new ServiceError(
      'Approval template clone key conflict',
      409,
      'APPROVAL_TEMPLATE_CLONE_KEY_CONFLICT',
    )
  }

  async createApproval(request: CreateApprovalRequest, actor: CreateApprovalActor): Promise<UnifiedApprovalDTO> {
    if (!pool) throw new Error('Database not available')

    const bundle = await this.loadTemplateBundle(request.templateId, undefined, 'active')
    if (!bundle) {
      throw new ServiceError('Approval template not found', 404, 'APPROVAL_TEMPLATE_NOT_FOUND')
    }
    if (bundle.template.status !== 'published' || !bundle.publishedDefinition || !bundle.publishedDefinition.is_active) {
      throw new ServiceError('Approval template is not published', 409, 'APPROVAL_TEMPLATE_NOT_PUBLISHED')
    }

    const formSchema = asFormSchema(bundle.version.form_schema)
    const validationErrors = validateApprovalFormData(formSchema, request.formData)
    if (validationErrors.length > 0) {
      throw new ServiceError(
        'Approval form data is invalid',
        400,
        'VALIDATION_ERROR',
        { errors: validationErrors },
      )
    }

    const runtimeGraph = asRuntimeGraph(bundle.publishedDefinition.runtime_graph)
    const executor = new ApprovalGraphExecutor(runtimeGraph, request.formData)
    const initial = executor.resolveInitialState()
    const instanceId = crypto.randomUUID()
    const requestNo = await this.allocateRequestNo()

    const requesterSnapshot = {
      id: actor.userId,
      name: actor.userName || actor.userId,
      email: actor.email,
      department: actor.department,
      roles: actor.roles || [],
      permissions: actor.permissions || [],
    }

    const instanceMetadata: Record<string, unknown> = { templateKey: bundle.template.key }
    if (initial.parallelState) {
      instanceMetadata.parallelBranchStates = buildPersistableParallelState(initial.parallelState)
    }

    let client: ApprovalDbClient | null = null
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      await client.query(
        `INSERT INTO approval_instances
         (id, status, version, source_system, external_approval_id, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, sync_error,
          template_id, template_version_id, published_definition_id, request_no, form_snapshot, current_node_key,
          created_at, updated_at)
         VALUES
         ($1, $2, 0, 'platform', NULL, 'approval-product-template', $3, $4,
          $5, $6, $7, $8,
          $9, $10, 'ok', NULL,
          $11, $12, $13, $14, $15, $16,
          now(), now())`,
        [
          instanceId,
          initial.status,
          bundle.template.key,
          bundle.template.name,
          JSON.stringify(requesterSnapshot),
          JSON.stringify({ templateId: bundle.template.id, templateKey: bundle.template.key }),
          JSON.stringify({ rejectCommentRequired: true, allowRevoke: runtimeGraph.policy.allowRevoke, sourceOfTruth: 'platform' }),
          JSON.stringify(instanceMetadata),
          initial.currentStep ?? 0,
          initial.totalSteps,
          bundle.template.id,
          bundle.version.id,
          bundle.publishedDefinition.id,
          requestNo,
          JSON.stringify(request.formData),
          initial.currentNodeKey,
        ],
      )

      await this.insertAssignments(client, instanceId, initial.assignments)
      await this.insertAutoApprovalEvents(client, instanceId, 0, initial.status, initial.autoApprovalEvents)
      await this.insertCcEvents(client, instanceId, 0, initial.status, initial.ccEvents)
      await this.insertApprovalRecord(client, instanceId, {
        action: 'created',
        actorId: actor.userId,
        actorName: actor.userName || actor.userId,
        comment: null,
        fromStatus: null,
        toStatus: initial.status,
        fromVersion: null,
        toVersion: 0,
        metadata: {
          nodeKey: 'start',
          requestNo,
        },
      })

      await client.query('COMMIT')
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    } finally {
      client?.release()
    }

    const approval = await this.getApproval(instanceId)
    if (!approval) {
      throw new ServiceError('Approval not found after creation', 500, 'APPROVAL_CREATE_FAILED')
    }
    return approval
  }

  async dispatchAction(
    id: string,
    request: ApprovalActionRequest,
    actor: CreateApprovalActor & { ip?: string | null; userAgent?: string | null },
  ): Promise<UnifiedApprovalDTO> {
    if (!pool) throw new Error('Database not available')

    let client: ApprovalDbClient | null = null
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      const instanceResult = await client.query<ApprovalInstanceRow>(
        `SELECT * FROM approval_instances WHERE id = $1 AND COALESCE(source_system, 'platform') = 'platform' FOR UPDATE`,
        [id],
      )
      const instance = instanceResult.rows[0]
      if (!instance) {
        throw new ServiceError('Approval not found', 404, APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND)
      }
      if (!instance.published_definition_id) {
        throw new ServiceError('Approval is not managed by the template runtime', 409, 'APPROVAL_RUNTIME_UNSUPPORTED')
      }

      const runtimeResult = await client.query<PublishedDefinitionRow>(
        `SELECT * FROM approval_published_definitions WHERE id = $1`,
        [instance.published_definition_id],
      )
      const runtime = runtimeResult.rows[0]
      if (!runtime) {
        throw new ServiceError('Published definition not found', 404, 'APPROVAL_PUBLISHED_DEFINITION_NOT_FOUND')
      }

      const assignments = await client.query<ApprovalAssignmentRow>(
        `SELECT * FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ORDER BY created_at ASC`,
        [id],
      )

      const runtimeGraph = asRuntimeGraph(runtime.runtime_graph)
      const executor = new ApprovalGraphExecutor(runtimeGraph, toNullableRecord(instance.form_snapshot) || {})
      const storedCurrentNodeKey = instance.current_node_key
      const actorRoles = actor.roles || []
      const actorName = actor.userName || actor.userId
      const parallelState = readParallelBranchStates(instance.metadata)
      const isInParallelRegion = Boolean(parallelState && storedCurrentNodeKey === parallelState.parallelNodeKey)

      // Resolve the actor's effective branch node. In single-linear state this
      // is `instance.current_node_key`. In a parallel region the actor's
      // decision applies to *their* branch's current approval node, which
      // is the `node_key` of one of their still-active assignments matching
      // a pending branch frontier in `parallelBranchStates`.
      let currentNodeKey: string | null = storedCurrentNodeKey
      let actorBranchNodeKey: string | null = null
      if (isInParallelRegion && parallelState) {
        const pendingBranchNodeKeys = new Set(
          Object.values(parallelState.branches)
            .filter((entry) => !entry.complete && entry.currentNodeKey)
            .map((entry) => entry.currentNodeKey as string),
        )
        const candidate = assignments.rows.find((assignment) => {
          if (!assignmentMatchesActor(assignment, actor.userId, actorRoles)) return false
          return assignment.node_key ? pendingBranchNodeKeys.has(assignment.node_key) : false
        })
        if (candidate?.node_key) {
          actorBranchNodeKey = candidate.node_key
          currentNodeKey = candidate.node_key
        }
      }

      const currentNodeAssignments = currentNodeKey
        ? assignments.rows.filter((assignment) => assignment.node_key === currentNodeKey)
        : []
      const actorAssignments = currentNodeAssignments.filter((assignment) =>
        assignmentMatchesActor(assignment, actor.userId, actorRoles))
      const actorCanAct = actorAssignments.length > 0
      const nextVersion = instance.version + 1

      if (request.action !== 'revoke' && !actorCanAct) {
        throw new ServiceError('Approval assignment not found for actor', 403, 'APPROVAL_ASSIGNMENT_REQUIRED')
      }

      if (request.action === 'comment') {
        await this.insertApprovalRecord(client, id, {
          action: 'comment',
          actorId: actor.userId,
          actorName,
          comment: request.comment || null,
          fromStatus: instance.status,
          toStatus: instance.status,
          fromVersion: instance.version,
          toVersion: instance.version,
          metadata: { nodeKey: currentNodeKey },
        }, actor)
        await client.query('COMMIT')
        return (await this.getApproval(id))!
      }

      if (request.action === 'transfer') {
        if (!request.targetUserId) {
          throw new ServiceError('targetUserId is required for transfer', 400, 'VALIDATION_ERROR')
        }
        if (!currentNodeKey) {
          throw new ServiceError('Approval does not have an active node', 409, APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION)
        }
        await this.deactivateActorAssignmentsAtNode(client, id, currentNodeKey, actor.userId, actorRoles)
        await this.insertAssignments(client, id, executor.buildTransferAssignments(currentNodeKey, request.targetUserId))
        await this.insertApprovalRecord(client, id, {
          action: 'transfer',
          actorId: actor.userId,
          actorName,
          comment: request.comment || null,
          fromStatus: instance.status,
          toStatus: instance.status,
          fromVersion: instance.version,
          toVersion: instance.version,
          metadata: { nodeKey: currentNodeKey },
          targetUserId: request.targetUserId,
        }, actor)
        await client.query('COMMIT')
        return (await this.getApproval(id))!
      }

      if (request.action === 'revoke') {
        if (!runtimeGraph.policy.allowRevoke) {
          throw new ServiceError('Approval cannot be revoked for this template', 409, 'APPROVAL_REVOKE_DISABLED')
        }
        const requesterId = toNullableRecord(instance.requester_snapshot)?.id
        if (requesterId !== actor.userId) {
          throw new ServiceError('Only the requester can revoke this approval', 403, 'APPROVAL_REVOKE_FORBIDDEN')
        }
        if (!currentNodeKey) {
          throw new ServiceError('Approval does not have an active node', 409, APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION)
        }
        if (
          runtimeGraph.policy.revokeBeforeNodeKeys?.length &&
          !runtimeGraph.policy.revokeBeforeNodeKeys.includes(currentNodeKey)
        ) {
          throw new ServiceError('Approval can no longer be revoked', 409, 'APPROVAL_REVOKE_WINDOW_CLOSED')
        }
        const handledResult = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM approval_records
           WHERE instance_id = $1
             AND action IN ('approve', 'reject', 'transfer')
             AND metadata->>'nodeKey' = $2`,
          [id, currentNodeKey],
        )
        if (Number.parseInt(handledResult.rows[0]?.count || '0', 10) > 0) {
          throw new ServiceError('Approval can no longer be revoked', 409, 'APPROVAL_REVOKE_WINDOW_CLOSED')
        }

        await client.query(
          `UPDATE approval_assignments SET is_active = FALSE, updated_at = now() WHERE instance_id = $1 AND is_active = TRUE`,
          [id],
        )
        await client.query(
          `UPDATE approval_instances
           SET status = 'revoked',
               version = $2,
               current_node_key = NULL,
               current_step = total_steps,
               metadata = COALESCE(metadata, '{}'::jsonb) - 'parallelBranchStates',
               updated_at = now()
           WHERE id = $1`,
          [id, nextVersion],
        )
        await this.insertApprovalRecord(client, id, {
          action: 'revoke',
          actorId: actor.userId,
          actorName,
          comment: request.comment || null,
          fromStatus: instance.status,
          toStatus: 'revoked',
          fromVersion: instance.version,
          toVersion: nextVersion,
          metadata: { nodeKey: currentNodeKey },
        }, actor)
        await client.query('COMMIT')
        return (await this.getApproval(id))!
      }

      if (instance.status !== 'pending') {
        throw new ServiceError(
          `Cannot ${request.action}: current status is ${instance.status}`,
          409,
          APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION,
        )
      }

      if (request.action === 'reject' && !request.comment?.trim()) {
        throw new ServiceError('Rejection comment is required', 400, APPROVAL_ERROR_CODES.REJECT_COMMENT_REQUIRED)
      }

      if (!currentNodeKey) {
        throw new ServiceError('Approval does not have an active node', 409, APPROVAL_ERROR_CODES.INVALID_STATUS_TRANSITION)
      }

      if (request.action === 'return') {
        if (isInParallelRegion) {
          // Return-to-node inside a parallel region is deferred to a
          // follow-up wave; the route rejects with a typed error so clients
          // can surface a specific message. See follow-ups in the dev MD.
          throw new ServiceError(
            'Return is not supported while the approval is in a parallel branch',
            409,
            'APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED',
          )
        }
        const targetNodeKey = request.targetNodeKey?.trim()
        if (!targetNodeKey) {
          throw new ServiceError('targetNodeKey is required for return', 400, 'VALIDATION_ERROR')
        }
        const visitedApprovalNodes = executor.listVisitedApprovalNodeKeysUntil(currentNodeKey)
        if (!visitedApprovalNodes.slice(0, -1).includes(targetNodeKey)) {
          throw new ServiceError(
            'Return target must be a previously visited approval node',
            409,
            'APPROVAL_RETURN_TARGET_INVALID',
          )
        }

        await this.deactivateAllActiveAssignments(client, id)
        const resolution = executor.resolveReturnToNode(targetNodeKey)
        await client.query(
          `UPDATE approval_instances
           SET status = $2,
               version = $3,
               current_node_key = $4,
               current_step = $5,
               total_steps = $6,
               updated_at = now()
           WHERE id = $1`,
          [
            id,
            resolution.status,
            nextVersion,
            resolution.currentNodeKey,
            resolution.currentStep ?? instance.total_steps,
            resolution.totalSteps,
          ],
        )
        await this.insertAssignments(client, id, resolution.assignments)
        await this.insertApprovalRecord(client, id, {
          action: 'return',
          actorId: actor.userId,
          actorName,
          comment: request.comment || null,
          fromStatus: instance.status,
          toStatus: resolution.status,
          fromVersion: instance.version,
          toVersion: nextVersion,
          metadata: {
            nodeKey: currentNodeKey,
            targetNodeKey,
            nextNodeKey: resolution.currentNodeKey,
          },
        }, actor)
        await this.insertAutoApprovalEvents(client, id, nextVersion, resolution.status, resolution.autoApprovalEvents)
        await this.insertCcEvents(client, id, nextVersion, resolution.status, resolution.ccEvents)
        await client.query('COMMIT')
        return (await this.getApproval(id))!
      }

      if (request.action === 'reject') {
        await this.deactivateAllActiveAssignments(client, id)
        await client.query(
          `UPDATE approval_instances
           SET status = 'rejected',
               version = $2,
               current_node_key = NULL,
               current_step = total_steps,
               metadata = COALESCE(metadata, '{}'::jsonb) - 'parallelBranchStates',
               updated_at = now()
           WHERE id = $1`,
          [id, nextVersion],
        )
        await this.insertApprovalRecord(client, id, {
          action: 'reject',
          actorId: actor.userId,
          actorName,
          comment: request.comment || null,
          fromStatus: instance.status,
          toStatus: 'rejected',
          fromVersion: instance.version,
          toVersion: nextVersion,
          metadata: { nodeKey: currentNodeKey },
        }, actor)
        await client.query('COMMIT')
        return (await this.getApproval(id))!
      }

      const approvalMode = executor.getApprovalMode(currentNodeKey)
      // Approval aggregation semantics:
      //   'all'    (会签): deactivate only the actor's assignment, short-circuit if siblings remain.
      //   'any'    (或签): first approver wins — deactivate siblings with an audit trail
      //                    (aggregateCancelledBy/aggregateCancelledAt metadata) + one 'sign' record.
      //   'single' / default: exactly one assignee expected; blanket-deactivate all active rows.
      let aggregateCancelledAssigneeIds: string[] = []
      let parallelCancelledAssigneeIds: string[] = []
      if (approvalMode === 'all') {
        await this.deactivateActorAssignmentsAtNode(client, id, currentNodeKey, actor.userId, actorRoles)
        const remainingAssignments = currentNodeAssignments.length - actorAssignments.length
        if (remainingAssignments > 0) {
          await client.query(
            `UPDATE approval_instances
             SET version = $2,
                 updated_at = now()
             WHERE id = $1`,
            [id, nextVersion],
          )
          await this.insertApprovalRecord(client, id, {
            action: 'approve',
            actorId: actor.userId,
            actorName,
            comment: request.comment || null,
            fromStatus: instance.status,
            toStatus: instance.status,
            fromVersion: instance.version,
            toVersion: nextVersion,
            metadata: {
              nodeKey: currentNodeKey,
              nextNodeKey: currentNodeKey,
              approvalMode,
              aggregateComplete: false,
              remainingAssignments,
            },
          }, actor)
          await client.query('COMMIT')
          return (await this.getApproval(id))!
        }
      } else if (approvalMode === 'any') {
        // Deactivate actor's own assignment first.
        await this.deactivateActorAssignmentsAtNode(client, id, currentNodeKey, actor.userId, actorRoles)
        // Identify siblings (still-active, non-actor) whose assignments the first-wins aggregation cancels.
        const siblingAssignments = currentNodeAssignments.filter((assignment) =>
          !assignmentMatchesActor(assignment, actor.userId, actorRoles))
        aggregateCancelledAssigneeIds = Array.from(
          new Set(siblingAssignments.map((assignment) => assignment.assignee_id)),
        )
        if (siblingAssignments.length > 0) {
          await client.query(
            `UPDATE approval_assignments
             SET is_active = FALSE,
                 metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'aggregateCancelledBy', $3::text,
                   'aggregateCancelledAt', now()::text,
                   'aggregateMode', 'any'
                 ),
                 updated_at = now()
             WHERE instance_id = $1
               AND node_key = $2
               AND is_active = TRUE
               AND id = ANY($4::uuid[])`,
            [id, currentNodeKey, actor.userId, siblingAssignments.map((assignment) => assignment.id)],
          )
        }
      } else {
        // Single-approver mode. In parallel state the blanket
        // `deactivateAllActiveAssignments` would cancel sibling branches'
        // pending assignments as well, so scope the deactivation to the
        // actor's own branch node. Linear state keeps the legacy behavior.
        if (isInParallelRegion) {
          await this.deactivateActorAssignmentsAtNode(client, id, currentNodeKey, actor.userId, actorRoles)
        } else {
          await this.deactivateAllActiveAssignments(client, id)
        }
      }

      const resolution = isInParallelRegion && parallelState && actorBranchNodeKey
        ? executor.resolveAfterApproveInParallel(actorBranchNodeKey, parallelState)
        : executor.resolveAfterApprove(currentNodeKey)

      const parallelAnyWinner =
        isInParallelRegion
        && parallelState?.joinMode === 'any'
        && resolution.currentNodeKey !== parallelState.parallelNodeKey
      if (parallelAnyWinner && parallelState) {
        const pendingSiblingNodeKeys = new Set(
          Object.values(parallelState.branches)
            .filter((entry) => !entry.complete && entry.currentNodeKey && entry.currentNodeKey !== currentNodeKey)
            .map((entry) => entry.currentNodeKey as string),
        )
        const siblingAssignments = assignments.rows.filter((assignment) =>
          assignment.is_active
          && assignment.node_key
          && pendingSiblingNodeKeys.has(assignment.node_key))
        parallelCancelledAssigneeIds = Array.from(
          new Set(siblingAssignments.map((assignment) => assignment.assignee_id)),
        )
        if (siblingAssignments.length > 0) {
          await client.query(
            `UPDATE approval_assignments
             SET is_active = FALSE,
                 metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                   'parallelCancelledBy', $3::text,
                   'parallelCancelledAt', now()::text,
                   'parallelJoinMode', 'any',
                   'parallelNodeKey', $4::text
                 ),
                 updated_at = now()
             WHERE instance_id = $1
               AND is_active = TRUE
               AND id = ANY($2::uuid[])`,
            [
              id,
              siblingAssignments.map((assignment) => assignment.id),
              actor.userId,
              parallelState.parallelNodeKey,
            ],
          )
        }
      }

      // Manage parallel branch state in `approval_instances.metadata`:
      //   - If the resolution's `currentNodeKey` equals a parallel fork node
      //     (either the same one we were already inside, or a brand-new
      //     parallel region reached after a linear stage), persist / refresh
      //     `parallelBranchStates` so subsequent dispatches can re-derive
      //     branch nodes.
      //   - Otherwise, strip any prior `parallelBranchStates` so the
      //     instance returns to linear semantics.
      const resolutionEntersParallel =
        resolution.parallelState !== undefined
        && resolution.currentNodeKey === resolution.parallelState.parallelNodeKey
      if (resolutionEntersParallel && resolution.parallelState) {
        await client.query(
          `UPDATE approval_instances
           SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('parallelBranchStates', $2::jsonb),
               updated_at = now()
           WHERE id = $1`,
          [id, JSON.stringify(buildPersistableParallelState(resolution.parallelState))],
        )
      } else if (isInParallelRegion) {
        await client.query(
          `UPDATE approval_instances
           SET metadata = COALESCE(metadata, '{}'::jsonb) - 'parallelBranchStates',
               updated_at = now()
           WHERE id = $1`,
          [id],
        )
      }

      await client.query(
        `UPDATE approval_instances
         SET status = $2,
             version = $3,
             current_node_key = $4,
             current_step = $5,
             total_steps = $6,
             updated_at = now()
         WHERE id = $1`,
        [
          id,
          resolution.status,
          nextVersion,
          resolution.currentNodeKey,
          resolution.currentStep ?? instance.total_steps,
          resolution.totalSteps,
        ],
      )
      await this.insertAssignments(client, id, resolution.assignments)
      const approveRecordMetadata: Record<string, unknown> = {
        nodeKey: currentNodeKey,
        nextNodeKey: resolution.currentNodeKey,
        approvalMode,
        aggregateComplete: true,
      }
      if (isInParallelRegion) {
        approveRecordMetadata.parallelNodeKey = parallelState?.parallelNodeKey
        approveRecordMetadata.parallelBranchComplete =
          resolution.currentNodeKey !== parallelState?.parallelNodeKey
        if (parallelAnyWinner) {
          approveRecordMetadata.parallelJoinMode = 'any'
          approveRecordMetadata.parallelCancelledAssignees = parallelCancelledAssigneeIds
        }
      }
      if (approvalMode === 'any' && aggregateCancelledAssigneeIds.length > 0) {
        approveRecordMetadata.aggregateCancelled = aggregateCancelledAssigneeIds
      }
      await this.insertApprovalRecord(client, id, {
        action: 'approve',
        actorId: actor.userId,
        actorName,
        comment: request.comment || null,
        fromStatus: instance.status,
        toStatus: resolution.status,
        fromVersion: instance.version,
        toVersion: nextVersion,
        metadata: approveRecordMetadata,
      }, actor)
      if (approvalMode === 'any' && aggregateCancelledAssigneeIds.length > 0) {
        // One 'sign' audit row describing the aggregation cancellation — lets the timeline UI
        // render a muted "已被 {approver} 的决定覆盖" line without mining assignment metadata.
        await this.insertApprovalRecord(client, id, {
          action: 'sign',
          actorId: 'system',
          actorName: 'System',
          comment: null,
          fromStatus: instance.status,
          toStatus: resolution.status,
          fromVersion: instance.version,
          toVersion: nextVersion,
          metadata: {
            nodeKey: currentNodeKey,
            autoCancelled: true,
            aggregateMode: 'any',
            aggregateCancelledBy: actor.userId,
            cancelledAssignees: aggregateCancelledAssigneeIds,
          },
        })
      }
      if (parallelAnyWinner && parallelCancelledAssigneeIds.length > 0) {
        await this.insertApprovalRecord(client, id, {
          action: 'sign',
          actorId: 'system',
          actorName: 'System',
          comment: null,
          fromStatus: instance.status,
          toStatus: resolution.status,
          fromVersion: instance.version,
          toVersion: nextVersion,
          metadata: {
            nodeKey: currentNodeKey,
            parallelAutoCancelled: true,
            parallelJoinMode: 'any',
            parallelNodeKey: parallelState?.parallelNodeKey,
            parallelCancelledBy: actor.userId,
            cancelledAssignees: parallelCancelledAssigneeIds,
          },
        })
      }
      await this.insertAutoApprovalEvents(client, id, nextVersion, resolution.status, resolution.autoApprovalEvents)
      await this.insertCcEvents(client, id, nextVersion, resolution.status, resolution.ccEvents)

      await client.query('COMMIT')
    } catch (error) {
      await rollbackQuietly(client)
      throw error
    } finally {
      client?.release()
    }

    const approval = await this.getApproval(id)
    if (!approval) {
      throw new ServiceError('Approval not found after action', 404, APPROVAL_ERROR_CODES.APPROVAL_NOT_FOUND)
    }
    return approval
  }

  async getApproval(id: string): Promise<UnifiedApprovalDTO | null> {
    if (!pool) throw new Error('Database not available')

    const result = await pool.query<ApprovalInstanceRow>(
      `SELECT * FROM approval_instances WHERE id = $1`,
      [id],
    )
    const row = result.rows[0]
    if (!row) return null

    const assignmentsResult = await pool.query<ApprovalAssignmentRow>(
      `SELECT * FROM approval_assignments WHERE instance_id = $1 ORDER BY created_at ASC`,
      [id],
    )

    return toUnifiedApprovalDTO(
      row,
      assignmentsResult.rows.map((assignment) => ({
        id: assignment.id,
        type: assignment.assignment_type,
        assigneeId: assignment.assignee_id,
        sourceStep: assignment.source_step,
        nodeKey: assignment.node_key,
        isActive: assignment.is_active,
        metadata: assignment.metadata || {},
      })),
    )
  }

  async isTemplateRuntimeInstance(id: string): Promise<boolean> {
    if (!pool) throw new Error('Database not available')

    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1
        FROM approval_instances
        WHERE id = $1
          AND COALESCE(source_system, 'platform') = 'platform'
          AND published_definition_id IS NOT NULL
      ) AS exists`,
      [id],
    )

    return Boolean(result.rows[0]?.exists)
  }

  private async allocateRequestNo(): Promise<string> {
    if (!pool) throw new Error('Database not available')

    const result = await pool.query<{ request_no: string }>(
      `SELECT 'AP-' || nextval('approval_request_no_seq')::text AS request_no`,
    )
    return result.rows[0]?.request_no || `AP-${normalizePage(Date.now(), 100001)}`
  }

  private async loadTemplateBundle(
    templateId: string,
    explicitVersionId?: string,
    preferredVersion: TemplateVersionPreference = 'active',
  ): Promise<TemplateBundle | null> {
    if (!pool) throw new Error('Database not available')

    return this.loadTemplateBundleWithClient(pool, templateId, explicitVersionId, preferredVersion)
  }

  private async loadTemplateBundleWithClient(
    client: { query: typeof pool.query },
    templateId: string,
    explicitVersionId?: string,
    preferredVersion: TemplateVersionPreference = 'active',
  ): Promise<TemplateBundle | null> {
    const templateResult = await client.query<TemplateRow>(
      `SELECT * FROM approval_templates WHERE id = $1`,
      [templateId],
    )
    const template = templateResult.rows[0]
    if (!template) return null

    const versionId = explicitVersionId
      || (preferredVersion === 'latest' ? template.latest_version_id || template.active_version_id : template.active_version_id || template.latest_version_id)
    if (!versionId) return null

    const versionResult = await client.query<TemplateVersionRow>(
      `SELECT * FROM approval_template_versions WHERE id = $1 AND template_id = $2`,
      [versionId, template.id],
    )
    const version = versionResult.rows[0]
    if (!version) return null

    const publishedResult = await client.query<PublishedDefinitionRow>(
      `SELECT *
       FROM approval_published_definitions
       WHERE template_version_id = $1
       ORDER BY is_active DESC, published_at DESC
       LIMIT 1`,
      [version.id],
    )

    return {
      template,
      version,
      publishedDefinition: publishedResult.rows[0] || null,
    }
  }

  private async deactivateAllActiveAssignments(
    client: { query: typeof pool.query },
    instanceId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE approval_assignments SET is_active = FALSE, updated_at = now() WHERE instance_id = $1 AND is_active = TRUE`,
      [instanceId],
    )
  }

  private async deactivateActorAssignmentsAtNode(
    client: { query: typeof pool.query },
    instanceId: string,
    nodeKey: string,
    actorId: string,
    actorRoles: string[],
  ): Promise<void> {
    await client.query(
      `UPDATE approval_assignments
       SET is_active = FALSE, updated_at = now()
       WHERE instance_id = $1
         AND node_key = $2
         AND is_active = TRUE
         AND (
           (assignment_type = 'user' AND assignee_id = $3)
           OR (assignment_type = 'role' AND assignee_id = ANY($4::text[]))
         )`,
      [instanceId, nodeKey, actorId, actorRoles],
    )
  }

  private async insertAssignments(
    client: { query: typeof pool.query },
    instanceId: string,
    assignments: Array<{ assignmentType: 'user' | 'role'; assigneeId: string; nodeKey: string; sourceStep: number }>,
  ): Promise<void> {
    for (const assignment of assignments) {
      await client.query(
        `INSERT INTO approval_assignments
         (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, TRUE, '{}'::jsonb, now(), now())`,
        [
          instanceId,
          assignment.assignmentType,
          assignment.assigneeId,
          assignment.sourceStep,
          assignment.nodeKey,
        ],
      )
    }
  }

  private async insertAutoApprovalEvents(
    client: { query: typeof pool.query },
    instanceId: string,
    version: number,
    status: string,
    autoApprovalEvents: ApprovalGraphAutoApprovalEvent[],
  ): Promise<void> {
    for (const event of autoApprovalEvents) {
      await this.insertApprovalRecord(client, instanceId, {
        action: 'approve',
        actorId: 'system',
        actorName: 'System',
        comment: null,
        fromStatus: status,
        toStatus: status,
        fromVersion: version,
        toVersion: version,
        metadata: {
          nodeKey: event.nodeKey,
          sourceStep: event.sourceStep,
          approvalMode: event.approvalMode,
          autoApproved: true,
          reason: event.reason,
        },
      })
    }
  }

  private async insertCcEvents(
    client: { query: typeof pool.query },
    instanceId: string,
    version: number,
    status: string,
    ccEvents: Array<{ nodeKey: string; targetType: 'user' | 'role'; targetId: string }>,
  ): Promise<void> {
    for (const event of ccEvents) {
      await this.insertApprovalRecord(client, instanceId, {
        action: 'cc',
        actorId: 'system',
        actorName: 'System',
        comment: null,
        fromStatus: status,
        toStatus: status,
        fromVersion: version,
        toVersion: version,
        metadata: {
          nodeKey: event.nodeKey,
          targetType: event.targetType,
          targetId: event.targetId,
        },
      })
    }
  }

  private async insertApprovalRecord(
    client: { query: typeof pool.query },
    instanceId: string,
    record: ApprovalRecordInsert,
    actor?: { ip?: string | null; userAgent?: string | null },
  ): Promise<void> {
    await client.query(
      `INSERT INTO approval_records
       (instance_id, action, actor_id, actor_name, comment, from_status, to_status, from_version, to_version, metadata, target_user_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        instanceId,
        record.action,
        record.actorId || 'system',
        record.actorName,
        record.comment,
        record.fromStatus,
        record.toStatus,
        record.fromVersion,
        record.toVersion,
        JSON.stringify(record.metadata),
        record.targetUserId || null,
        actor?.ip || null,
        actor?.userAgent || null,
      ],
    )
  }
}

export function resolveApprovalListPaging(page: unknown, pageSize: unknown): { limit: number; offset: number } {
  const normalizedPage = normalizePage(page, 1)
  const normalizedPageSize = normalizePage(pageSize, 20)
  return {
    limit: normalizedPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  }
}
