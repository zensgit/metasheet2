import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  ApprovalNode,
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
import {
  buildDetailColumns,
  detailColumnDraftsFromField,
  validateDetailColumnsDraft,
  type DetailColumnDraft,
} from './detailField'
import {
  applyConditionEditsToGraph,
  conditionEditsFromGraph,
  validateConditionEdits,
  type ConditionEdits,
} from './conditionEdit'
import {
  applyParallelEditsToGraph,
  parallelEditsFromGraph,
  validateParallelEdits,
  type ParallelEdits,
} from './parallelEdit'
import {
  applyCcEditsToGraph,
  ccEditsFromGraph,
  validateCcEdits,
  type CcEdits,
} from './ccEdit'
import {
  applyApprovalNodeEditsToGraph,
  approvalNodeEditsFromGraph,
  validateApprovalNodeEdits,
  type ApprovalNodeEdits,
} from './approvalNodeEdit'

export type { DetailColumnDraft } from './detailField'
export { createEmptyDetailColumnDraft, DETAIL_LEAF_FIELD_TYPES } from './detailField'
export type {
  ConditionEdits,
  ConditionNodeEdit,
  ConditionBranchEdit,
  ConditionRuleEdit,
  ConditionRuleOperator,
} from './conditionEdit'
export { CONDITION_RULE_OPERATORS } from './conditionEdit'
export type { ParallelEdits, ParallelNodeEdit } from './parallelEdit'
export { PARALLEL_JOIN_MODES } from './parallelEdit'
export type { CcEdits, CcNodeEdit } from './ccEdit'
export { CC_TARGET_TYPES } from './ccEdit'
export type { ApprovalNodeEdits, ApprovalNodeSourceEdit } from './approvalNodeEdit'

export type AuthorableFieldType = Exclude<FormFieldType, 'attachment'>
export type ApprovalStepSourceKind = ApprovalAssigneeSource['kind']

// Top-level authorable field types: the 8 leaf scalar types plus `detail` (repeatable
// line-items group). `attachment` is intentionally excluded (not authorable in v1); `detail`
// is top-level-only — its sub-fields are restricted to the leaf set (`DETAIL_LEAF_FIELD_TYPES`)
// and may never themselves be `detail` (one nesting level).
export const AUTHORABLE_FIELD_TYPES: AuthorableFieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'select',
  'multi-select',
  'user',
  'detail',
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
  // detail / sub-form authoring — meaningful only when `type === 'detail'`. `columns` is the
  // editable sub-field list; `minRowsText`/`maxRowsText` are raw text inputs ('' = unset).
  detailColumns: DetailColumnDraft[]
  minRowsText: string
  maxRowsText: string
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
  // `sourceKind === 'continuous_managers'`. The backend re-validates against its
  // configurable cap `[1, MAX_MANAGER_CHAIN_LEVELS]` (default 10, env
  // `APPROVAL_MANAGER_CHAIN_MAX_LEVELS`, hard ceiling 50). The authoring UI (v1)
  // intentionally fixes the input max at 10; reading the server cap into the UI so
  // ops can configure more than 10 is a follow-up (not wired in v1).
  levels: number
  // Single 1-based management level the `manager_at_level` source resolves;
  // meaningful only when `sourceKind === 'manager_at_level'`. Same backend cap as `levels`.
  level: number
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
  // G-1 anti-flatten keystone: a COMPLEX graph (any cc/condition/parallel node, or any
  // non-linear shape) is captured here verbatim at hydrate and emitted UNCHANGED by
  // `buildApprovalGraph` — the linear `steps` projection is NEVER applied to it, so save can
  // not drop/reorder complex nodes/edges/config. `undefined` for plain linear templates (which
  // keep the editable `steps` round-trip). The graph editor (G-2+) replaces this pass-through.
  preservedGraph?: ApprovalGraph
  // G-2 condition editor: editable LOGIC for each `condition` node in `preservedGraph`, keyed by
  // node key (seeded 1:1 from the preserved condition nodes). Only a condition node's rules /
  // conjunction / defaultEdgeKey are editable here; branch/edge TOPOLOGY and every non-condition
  // node/edge stay byte-identical-preserved (G-1 floor). `buildApprovalGraph` applies these onto a
  // COPY of `preservedGraph`. Empty/absent for linear or non-condition complex graphs.
  conditionEdits?: ConditionEdits
  // G-3 parallel editor: editable `joinMode` for each `parallel` node in `preservedGraph`, keyed by
  // node key (seeded 1:1 from the preserved parallel nodes). ONLY `joinMode` ('all' | 'any' — both
  // backend-accepted, see `parallelEdit.ts`) is editable; `branches`/`joinNodeKey` are topology and
  // every non-parallel node/edge stay byte-identical-preserved. `buildApprovalGraph` composes these
  // with the condition edits onto a COPY of `preservedGraph`. Empty/absent for linear or
  // non-parallel complex graphs.
  parallelEdits?: ParallelEdits
  // G-4 cc editor: editable targetType/targetIds for each `cc` node in `preservedGraph`, seeded
  // 1:1. Topology (edges) + every non-cc node stay byte-identical. Empty {} when no cc node.
  ccEdits?: CcEdits
  approvalNodeEdits?: ApprovalNodeEdits
  // Server-side amount total-check mapping (design-lock #3161, shipped by #3176; on the presets via
  // #3183). The editor does NOT author it yet — it is carried hydrate→save VERBATIM so an
  // authoring-page save cannot silently drop a preset-shipped control (the #3161 §1 exposure).
  amountConsistencyCheck?: FormSchema['amountConsistencyCheck']
}

// Complex node types the v1 LINEAR steps editor can't author. They are NOT "unsupported" — a
// graph containing them is load-preserved verbatim (read-only graph view), never flattened.
const COMPLEX_GRAPH_NODE_TYPES = new Set(['cc', 'condition', 'parallel'])

/**
 * True when a graph can't be edited through the linear `steps` model and so must be
 * preserved verbatim: any `cc` / `condition` / `parallel` node is present, OR the topology is
 * not a single linear start→approval*→end chain (`orderedLinearNodes` returns null). This is the
 * G-1 anti-flatten gate — its truth means `draftFromTemplate` captures `preservedGraph` and the
 * view renders the graph read-only.
 */
export function isComplexApprovalGraph(graph: ApprovalGraph): boolean {
  if (graph.nodes.some((node) => COMPLEX_GRAPH_NODE_TYPES.has(node.type))) return true
  return orderedLinearNodes(graph) === null
}

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
    detailColumns: [],
    minRowsText: '',
    maxRowsText: '',
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
    level: 1,
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
    detailColumns: field.type === 'detail' ? detailColumnDraftsFromField(field) : [],
    minRowsText: field.type === 'detail' && field.minRows != null ? String(field.minRows) : '',
    maxRowsText: field.type === 'detail' && field.maxRows != null ? String(field.maxRows) : '',
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
  let level = 1
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
  } else if (source?.kind === 'manager_at_level') {
    sourceKind = 'manager_at_level'
    level = source.level
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
    level,
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

// The full set of node types the runtime recognises. A node whose type is outside this set is
// genuinely un-authorable (data corruption / a newer schema) → the whole template stays read-only
// and save is blocked, never flattened. `cc`/`condition`/`parallel` ARE recognised (G-1
// load-preserves them) and are deliberately included here.
const RECOGNISED_GRAPH_NODE_TYPES = new Set([
  'start',
  'approval',
  'cc',
  'condition',
  'parallel',
  'end',
])

/**
 * Reason the WHOLE template must open read-only with SAVE DISABLED (truly-unsupported, distinct
 * from a complex-but-save-preserving graph — see `graphReadOnlyReason`). Returns a message for:
 *  - an un-authorable FIELD type (e.g. `attachment`), or
 *  - a node carrying EXTRA keys beyond key/type/name/config, or a node whose `type` is not
 *    recognised by the runtime, or
 *  - (LINEAR graphs only) an approval node whose `config` has keys/sources the linear editor
 *    can't represent — for COMPLEX graphs this is skipped because the graph is preserved verbatim
 *    rather than projected to `steps`.
 * Returns `null` when the template is editable OR complex-but-preservable.
 */
// The approval-node config keys the BACKEND `normalizeApprovalGraph` re-emits for a COMPLEX graph
// (ApprovalProductService.ts:899-911). Any other key — TOP-LEVEL or NESTED — is silently dropped on
// save. NB: this is the COMPLEX path's allowlist ONLY — the linear path reconstructs via
// `buildStepConfig`, which does NOT preserve `fieldPermissions`, so the two allowlists must stay
// SEPARATE (sharing would let a linear node's `fieldPermissions` through, then flatten it).
const BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS = [
  'assigneeType',
  'assigneeIds',
  'assigneeSources',
  'approvalMode',
  'emptyAssigneePolicy',
  'autoApprovalPolicy',
  'fieldPermissions',
]
// The backend ALSO rebuilds the NESTED shapes from fixed fields, silently dropping any other — so the
// allowlist must be shape-level, not just top-level:
//   - assigneeSources[] per kind (ApprovalProductService.ts:408-453)
//   - autoApprovalPolicy (:371-376) — 4 fields
//   - fieldPermissions[] (:786-799) — { fieldId, access }
// All three bottom out in primitives / string-arrays (no deeper objects), so this 2-level check is complete.
const BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND: Record<string, string[]> = {
  static_user: ['kind', 'userIds'],
  static_role: ['kind', 'roleIds'],
  requester: ['kind'],
  direct_manager: ['kind'],
  dept_head: ['kind'],
  continuous_managers: ['kind', 'levels'],
  manager_at_level: ['kind', 'level'],
  form_field_user: ['kind', 'fieldId'],
}
const BACKEND_AUTO_APPROVAL_POLICY_KEYS = ['mergeWithRequester', 'mergeAdjacentApprover', 'dedupeHistoricalApprover', 'actorMode']
const BACKEND_FIELD_PERMISSION_KEYS = ['fieldId', 'access']

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function hasKeyOutside(value: unknown, allowed: string[]): boolean {
  return isPlainRecord(value) && Object.keys(value).some((key) => !allowed.includes(key))
}

/**
 * True when a COMPLEX approval node's config carries a key — TOP-LEVEL or NESTED in assigneeSources[]
 * / autoApprovalPolicy / fieldPermissions[] — that the backend `normalizeApprovalGraph` does NOT
 * re-emit (and silently DROPS on save). The FE preserves config verbatim, so without this the
 * deep-equal round-trip looks clean while the real save flattens the unknown key.
 */
function complexApprovalConfigHasBackendDrop(config: Record<string, unknown>): boolean {
  if (hasKeyOutside(config, BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS)) return true
  const sources = config.assigneeSources
  if (Array.isArray(sources)) {
    for (const source of sources) {
      if (!isPlainRecord(source)) return true
      const allowed = BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND[source.kind as string]
      if (!allowed || hasKeyOutside(source, allowed)) return true
    }
  }
  if (hasKeyOutside(config.autoApprovalPolicy, BACKEND_AUTO_APPROVAL_POLICY_KEYS)) return true
  const perms = config.fieldPermissions
  if (Array.isArray(perms)) {
    for (const perm of perms) {
      if (!isPlainRecord(perm) || hasKeyOutside(perm, BACKEND_FIELD_PERMISSION_KEYS)) return true
    }
  }
  return false
}

// The COMPLEX-path config shapes the backend re-emits for the OTHER node types (same silent-drop
// risk as approval): cc → {targetType, targetIds}; parallel → {branches, joinMode, joinNodeKey};
// condition → {branches, defaultEdgeKey} with each branch {edgeKey, conjunction?, rules, formula?}
// and each rule {fieldId, operator, value?} (the rule `value` is a free leaf, NOT shape-checked);
// start/end → {}. Formula branches are backend-preserved after FC-1, but the current G-2 editor
// cannot round-trip them, so they remain fail-closed here until FC-2 formula authoring ships.
const BACKEND_CC_CONFIG_KEYS = ['targetType', 'targetIds']
const BACKEND_PARALLEL_CONFIG_KEYS = ['branches', 'joinMode', 'joinNodeKey']
const BACKEND_CONDITION_CONFIG_KEYS = ['branches', 'defaultEdgeKey']
const BACKEND_CONDITION_BRANCH_KEYS = ['edgeKey', 'conjunction', 'rules', 'formula']
const BACKEND_CONDITION_FORMULA_KEYS = ['expression']
const BACKEND_CONDITION_RULE_KEYS = ['fieldId', 'operator', 'value']

/**
 * True when a complex node's config carries a key the backend `normalizeApprovalGraph` does NOT
 * re-emit (and silently drops on save) — generalises the approval-node shape-check to EVERY node
 * type. cc/parallel are flat; condition recurses config → branches[] → rules[]; start/end re-emit
 * {} so any config key is dropped. Without this a save flattens the unknown key while the FE
 * deep-equal round-trip looks clean.
 */
function complexNodeConfigHasBackendDrop(node: ApprovalNode): boolean {
  const config = (node.config ?? {}) as Record<string, unknown>
  switch (node.type) {
    case 'approval':
      return complexApprovalConfigHasBackendDrop(config)
    case 'cc':
      return hasKeyOutside(config, BACKEND_CC_CONFIG_KEYS)
    case 'parallel':
      return hasKeyOutside(config, BACKEND_PARALLEL_CONFIG_KEYS)
    case 'condition': {
      if (hasKeyOutside(config, BACKEND_CONDITION_CONFIG_KEYS)) return true
      const branches = config.branches
      if (Array.isArray(branches)) {
        for (const branch of branches) {
          if (!isPlainRecord(branch) || hasKeyOutside(branch, BACKEND_CONDITION_BRANCH_KEYS)) return true
          if (branch.formula !== undefined) {
            if (!isPlainRecord(branch.formula) || hasKeyOutside(branch.formula, BACKEND_CONDITION_FORMULA_KEYS)) return true
            return true
          }
          const rules = branch.rules
          if (Array.isArray(rules)) {
            for (const rule of rules) {
              if (!isPlainRecord(rule) || hasKeyOutside(rule, BACKEND_CONDITION_RULE_KEYS)) return true
            }
          }
        }
      }
      return false
    }
    case 'start':
    case 'end':
      // backend re-emits {} for these — any config key would be silently dropped.
      return Object.keys(config).length > 0
    default:
      return false
  }
}

export function unsupportedTemplateAuthoringReason(template: ApprovalTemplateDetailDTO): string | null {
  const unsupportedField = template.formSchema.fields.find((field) => !isAuthorableFieldType(field.type))
  if (unsupportedField) {
    return `包含暂不支持编辑的字段类型：${unsupportedField.label || unsupportedField.id} (${unsupportedField.type})`
  }

  // A node carrying extra keys, or an unrecognised node type, is genuinely un-authorable and
  // blocks save. NOTE: cc/condition/parallel are RECOGNISED (load-preserved) and do NOT trip
  // this — they are surfaced read-only via `graphReadOnlyReason`, never flattened.
  const unknownNode = template.approvalGraph.nodes.find((node) => {
    const nodeKeys = Object.keys(node as unknown as Record<string, unknown>)
    return nodeKeys.some((key) => !['key', 'type', 'name', 'config'].includes(key))
      || !RECOGNISED_GRAPH_NODE_TYPES.has(node.type)
  })
  if (unknownNode) {
    return `包含暂不支持编辑的审批节点：${unknownNode.name || unknownNode.key} (${unknownNode.type})`
  }

  // Complex graphs (cc/condition/parallel or non-linear) are load-preserved verbatim via
  // spread-original-first — BUT the backend `normalizeApprovalGraph` rebuilds EVERY node's config
  // from a fixed per-type allowlist and silently DROPS any other key (top-level or nested) on save.
  // The FE deep-equal round-trip can't see that drop, so fail-closed: ANY node carrying a config key
  // the backend won't preserve is unsupported (read-only, save disabled), never silently flattened.
  if (isComplexApprovalGraph(template.approvalGraph)) {
    const unsupportedNode = template.approvalGraph.nodes.find((node) => complexNodeConfigHasBackendDrop(node))
    if (unsupportedNode) {
      return `节点含后端不会保留的配置（保存将丢失），已锁定为只读：${unsupportedNode.name || unsupportedNode.key}（${unsupportedNode.type}）`
    }
    return null
  }

  const ordered = orderedLinearNodes(template.approvalGraph)
  if (!ordered) {
    // Unreachable in practice (a non-linear graph is already complex above), but keeps the
    // linear path total: an unexpected non-linear shape stays read-only rather than projecting.
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
      if (!['static_user', 'static_role', 'requester', 'form_field_user', 'direct_manager', 'dept_head', 'continuous_managers', 'manager_at_level'].includes(source?.kind)) return true
    }
    return false
  })
  if (unsupportedApproval) {
    return `审批节点含暂不支持的配置：${unsupportedApproval.name || unsupportedApproval.key}`
  }

  return null
}

/**
 * G-1 — reason the GRAPH (not the whole template) must render READ-ONLY: the graph is complex
 * (any cc/condition/parallel node, or non-linear) so the v1 linear `steps` editor can't author
 * it. Distinct from `unsupportedTemplateAuthoringReason`: a complex graph is NOT unsupported — the
 * form/metadata stay EDITABLE and SAVE stays enabled (it preserves the graph verbatim via
 * `draftFromTemplate`→`preservedGraph`→`buildApprovalGraph`). Returns `null` for a linear graph
 * (the steps editor is live) and for a truly-unsupported template (that path is fully read-only
 * via `unsupportedTemplateAuthoringReason`; the graph view never opens). The G-2+ editors will
 * narrow this to only genuinely-unrepresentable constructs.
 */
export function graphReadOnlyReason(template: ApprovalTemplateDetailDTO): string | null {
  if (unsupportedTemplateAuthoringReason(template)) return null
  if (!isComplexApprovalGraph(template.approvalGraph)) return null
  return '该审批流程包含复杂节点：条件分支可在下方编辑分支规则，并行 / 抄送节点以只读结构展示；未改动的节点与连线在保存时原样保留，不会被改写。'
}

export function draftFromTemplate(template: ApprovalTemplateDetailDTO): TemplateAuthoringDraft {
  // G-1 anti-flatten keystone: a complex graph is captured VERBATIM and never projected to the
  // linear `steps` model. `buildApprovalGraph` re-emits it byte-identical, so load→save can not
  // drop or reorder its cc/condition/parallel nodes/edges/config.
  const complex = isComplexApprovalGraph(template.approvalGraph)
  const ordered = orderedLinearNodes(template.approvalGraph) ?? template.approvalGraph.nodes
  const fields = template.formSchema.fields
    .map(fieldDraftFromField)
    .filter((field): field is FieldAuthoringDraft => field !== null)
  // Skip the approval-only step projection for complex graphs — they round-trip via
  // `preservedGraph`, and projecting would discard the non-approval nodes (the flatten risk).
  const steps = complex
    ? []
    : ordered
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
    // Hydrate side of the #3161 §1 preserve: carry the amount total-check mapping through verbatim
    // (shallow clone, never alias the source schema). Absent → no key (no phantom on round-trip).
    ...(template.formSchema.amountConsistencyCheck
      ? { amountConsistencyCheck: { ...template.formSchema.amountConsistencyCheck } }
      : {}),
    ...(complex
      ? {
          preservedGraph: template.approvalGraph,
          // G-2: seed the editable condition logic from the preserved condition nodes (1:1).
          // Empty {} when the complex graph has no condition node (parallel/cc-only).
          conditionEdits: conditionEditsFromGraph(template.approvalGraph),
          // G-3: seed the editable parallel joinMode from the preserved parallel nodes (1:1).
          // Empty {} when the complex graph has no parallel node (condition/cc-only).
          parallelEdits: parallelEditsFromGraph(template.approvalGraph),
          ccEdits: ccEditsFromGraph(template.approvalGraph),
          approvalNodeEdits: approvalNodeEditsFromGraph(template.approvalGraph),
        }
      : {}),
    fields: fields.length > 0 ? fields : [createEmptyFieldDraft(1)],
    // A complex graph round-trips via `preservedGraph` and has no editable steps — keep
    // `steps: []` (no phantom step). Linear drafts seed an empty step for the editor.
    steps: complex ? steps : (steps.length > 0 ? steps : [createEmptyStepDraft(1)]),
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
      // detail / sub-form: emit `columns` + optional `minRows`/`maxRows` from the sub-field
      // editor, or delete all three so a field changed away from `detail` does not carry stale
      // detail keys resurrected from the `original` spread (mirrors the options omit discipline;
      // the backend rejects detail-only keys on a non-detail field).
      if (field.type === 'detail') {
        next.columns = buildDetailColumns(field.detailColumns)
        const minRows = field.minRowsText.trim()
        const maxRows = field.maxRowsText.trim()
        if (minRows) next.minRows = Number(minRows)
        else delete next.minRows
        if (maxRows) next.maxRows = Number(maxRows)
        else delete next.maxRows
      } else {
        delete next.columns
        delete next.minRows
        delete next.maxRows
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
    // Preserve side of the #3161 §1 fix: re-emit the amount total-check mapping verbatim. The editor
    // doesn't author it, so a rebuild that dropped it would silently kill a preset-shipped control.
    ...(draft.amountConsistencyCheck ? { amountConsistencyCheck: { ...draft.amountConsistencyCheck } } : {}),
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
  if (step.sourceKind === 'manager_at_level') {
    return { kind: 'manager_at_level', level: step.level }
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
  // G-1/G-2/G-3 anti-flatten keystone: a preserved complex graph is NEVER rebuilt from `steps`, so
  // its cc/condition/parallel nodes/edges survive save. Two disjoint edit passes COMPOSE onto a COPY
  // of the graph: G-2 (`applyConditionEditsToGraph`) replaces ONLY each condition node's config, G-3
  // (`applyParallelEditsToGraph`) replaces ONLY each parallel node's `joinMode`, and G-4
  // (`applyCcEditsToGraph`) replaces ONLY each cc node's targetType/targetIds. The three passes touch
  // disjoint node types and each deep-clones everything else, so all edits land while every other
  // node + ALL edges stay byte-identical; an untouched graph round-trips unchanged.
  // Only linear drafts take the build below.
  if (draft.preservedGraph) {
    const withConditionEdits = applyConditionEditsToGraph(draft.preservedGraph, draft.conditionEdits ?? {})
    const withParallelEdits = applyParallelEditsToGraph(withConditionEdits, draft.parallelEdits ?? {})
    const withCcEdits = applyCcEditsToGraph(withParallelEdits, draft.ccEdits ?? {})
    // G-5: replace ONLY each edited approval node's `assigneeSources` (approver source); approvalMode /
    // emptyAssigneePolicy / autoApprovalPolicy + every other node + ALL edges stay byte-identical.
    return applyApprovalNodeEditsToGraph(withCcEdits, draft.approvalNodeEdits ?? {})
  }
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

/**
 * D-2/D-3 topology bridge: apply a STRUCTURAL graph op (graphTopologyEdit) to a COMPLEX draft. The op
 * runs on the current EFFECTIVE graph (preservedGraph with the G-2..G-5 config edits already applied,
 * so no in-progress config is lost), the result becomes the new preservedGraph, and the four
 * config-edit maps are re-seeded from it. `buildApprovalGraph(result)` therefore equals the op's
 * output, so the (future) canvas and the structured editors stay one source of truth. No-op for a
 * linear draft (no preservedGraph) — linear structure is authored via `steps`.
 */
export function applyTopologyToComplexDraft(
  draft: TemplateAuthoringDraft,
  op: (graph: ApprovalGraph) => ApprovalGraph,
): TemplateAuthoringDraft {
  if (!draft.preservedGraph) return draft
  const next = op(buildApprovalGraph(draft))
  return {
    ...draft,
    preservedGraph: next,
    conditionEdits: conditionEditsFromGraph(next),
    parallelEdits: parallelEditsFromGraph(next),
    ccEdits: ccEditsFromGraph(next),
    approvalNodeEdits: approvalNodeEditsFromGraph(next),
  }
}

/**
 * D-4 form-field reorder: move the item at `from` to index `to`, returning a NEW array (pure). This is
 * the drag-to-position logic the field builder's native drag wires to — more general than the existing
 * one-step up/down. Out-of-range indices are clamped/no-op'd so a stray drag can't corrupt the list.
 */
export function moveItemToIndex<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return items.slice()
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
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
    // detail / sub-form: mirror the backend `normalizeDetailFieldParts` reject-set client-side
    // (non-empty leaf-only unique-id columns, no nesting, minRows <= maxRows non-negative ints).
    if (field.type === 'detail') {
      errors.push(
        ...validateDetailColumnsDraft(
          field.label.trim() || field.id.trim(),
          field.detailColumns,
          field.minRowsText,
          field.maxRowsText,
        ),
      )
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
  // A complex graph (preservedGraph) carries no editable steps — the step requirement only
  // applies to linear drafts that build their graph from `steps`.
  if (!draft.preservedGraph && draft.steps.length === 0) errors.push('至少需要一个审批步骤')
  // G-2 condition-editor PREVIEW: rule fieldId must reference a form field, operator must be in the
  // union, and defaultEdgeKey must be an OUTGOING edge of the condition node (the fall-through edge;
  // checked against `preservedGraph`'s edges). UX-only — the backend `normalizeApprovalGraph`
  // re-validates and is the final arbiter (we never relax it here).
  if (draft.conditionEdits && Object.keys(draft.conditionEdits).length > 0) {
    errors.push(...validateConditionEdits(draft.conditionEdits, buildFormSchema(draft), draft.preservedGraph))
  }
  // G-3 parallel-editor PREVIEW: joinMode must be in the backend-accepted set ('all' | 'any').
  // UX-only — the backend `normalizeApprovalGraph` re-validates and is the final arbiter.
  if (draft.parallelEdits && Object.keys(draft.parallelEdits).length > 0) {
    errors.push(...validateParallelEdits(draft.parallelEdits))
  }
  if (draft.ccEdits && Object.keys(draft.ccEdits).length > 0) {
    errors.push(...validateCcEdits(draft.ccEdits))
  }
  if (draft.approvalNodeEdits && Object.keys(draft.approvalNodeEdits).length > 0) {
    errors.push(...validateApprovalNodeEdits(draft.approvalNodeEdits, draft.fields))
  }
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
