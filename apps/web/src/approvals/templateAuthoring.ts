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
  NodeFieldAccess,
  NodeFieldPermission,
  CreateApprovalTemplateRequest,
  UpdateApprovalTemplateRequest,
  RuntimePolicy,
} from '../types/approval'
import {
  buildDetailColumns,
  detailColumnDraftsFromField,
  validateDetailColumnsDraft,
  type DetailColumnDraft,
} from './detailField'
import { validateRecordLinkPinAgainstLoadedCatalog } from './recordLinkField'
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
export { approvalFormulaInsertOptions } from './conditionEdit'
export type { ParallelEdits, ParallelNodeEdit } from './parallelEdit'
export { PARALLEL_JOIN_MODES, parallelDynamicAssigneeConflicts } from './parallelEdit'
export type { CcEdits, CcNodeEdit } from './ccEdit'
export { CC_TARGET_TYPES } from './ccEdit'
export type { ApprovalNodeEdits, ApprovalNodeSourceEdit } from './approvalNodeEdit'
export { placeholderRoleNodeKeys, isPlaceholderRoleSource, addAssigneeSourceCard, removeAssigneeSourceCard } from './approvalNodeEdit'

export type AuthorableFieldType = Exclude<FormFieldType, 'attachment'>
export type ApprovalStepSourceKind = ApprovalAssigneeSource['kind']

// Top-level authorable field types: the 8 leaf scalar types plus `detail` (repeatable
// line-items group) and `record-link` (FWB-0 Layer 2 single linked multitable record).
// `attachment` is intentionally excluded (not authorable in v1); `detail` and `record-link`
// are top-level-only — detail sub-fields are restricted to the leaf set
// (`DETAIL_LEAF_FIELD_TYPES`, which excludes `record-link`) and may never themselves be
// `detail` (one nesting level).
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
  'record-link',
  // Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2): start+end date pair.
  'date_range',
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
  /**
   * FWB-0 Layer 2 record-link: server-pinned multitable binding. Meaningful only when
   * `type === 'record-link'`. Both must be non-empty for save; fill UI scopes the single-record
   * picker to this sheet (no free-text record-id entry).
   */
  recordLinkBaseId: string
  recordLinkSheetId: string
  /**
   * L8-C (approval-lock8-field-vocabulary-20260817.md §1.3, OD-L8-6): formatted-number display
   * props. Meaningful only when `type === 'number'`. Props on the EXISTING `number` type — NOT a
   * new field type (M10). `numberCurrencySymbol === ''` means "no currency prefix" (props key
   * omitted at build); the two booleans default `false` (also omitted). Editor is authoritative
   * for these three keys once touched — buildFormSchema does not resurrect them from `original`
   * when cleared. min/max/step/precision/derivedFrom stay unauthorable (pass through `original`
   * verbatim, §0.4), unchanged by this slice.
   */
  numberCurrencySymbol: string
  numberThousandsSeparator: boolean
  numberUppercaseCny: boolean
  /**
   * L8-B (approval-lock8-field-vocabulary-20260817.md §1.2, OD-L8-4/OD-L8-8): date_range draft
   * carrier. Meaningful only when `type === 'date_range'`. `dateRangeDateType` mirrors C-7/C-6's
   * required 3-way granularity enum and has NO absent-default — `''` is the "not yet chosen" draft
   * state (publish rejects it, §1.2), never silently coerced to a default arm. `dateRangeStartLabel`
   * / `dateRangeEndLabel` are the required C-7 控件名称 1/2; `dateRangeDurationLabel` is an OPTIONAL
   * custom label for the ALWAYS-rendered derived duration (OD-L8-8) — its absence does not turn the
   * duration display off, only its label falls back to a default.
   */
  dateRangeDateType: '' | 'date' | 'date_half_day' | 'date_minute'
  dateRangeStartLabel: string
  dateRangeEndLabel: string
  dateRangeDurationLabel: string
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
  // Lock-1 §K2 (提交人自选) — meaningful only when `sourceKind === 'requester_choice'`.
  // `single` = the requester picks exactly one approver at submit; `multi` = one or more.
  requesterChoiceMode: 'single' | 'multi'
  // §K2 scope discriminator. `company` = any active user; `members` / `role` narrow the
  // chooser to a configured list, carried in the SAME `idsText` chip carrier the static
  // pickers use (userIds for members, roleIds for role) — sourceFromStep re-shapes it.
  requesterChoiceScopeType: 'company' | 'members' | 'role'
  approvalMode: ApprovalMode
  emptyAssigneePolicy: EmptyAssigneePolicy
  // Self-approver authoring: the editable toggle (merge the requester in as an
  // auto-approval). `originalAutoApprovalPolicy` preserves the three non-merge
  // sub-fields (mergeAdjacentApprover / dedupeHistoricalApprover / actorMode),
  // which are out of UI scope but must survive hydrate→rebuild (no silent flatten),
  // mirroring `FieldAuthoringDraft.original`.
  mergeWithRequester: boolean
  originalAutoApprovalPolicy?: AutoApprovalPolicy
  // T1-4 node-level field permissions (linear editor). One entry per NON-editable form field
  // (`editable` is the absent default, so a field left editable carries no entry). Hydrated from
  // `config.fieldPermissions` and re-emitted by `buildStepConfig`, which prunes entries whose field
  // was deleted (backend cross-ref safety) and drops any `editable` entry. `hidden` and `readonly`
  // are BOTH enforced server-side (Lock-7 P4-B): `hidden` redacts the read echo + refuses a write;
  // `readonly` refuses a write at that node.
  fieldPermissions: NodeFieldPermission[]
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
  // L6-P1 carrier fix — the full persisted `policy` object as of hydrate (or `null`/undefined for
  // a never-published template), captured VERBATIM. The editor only authors `allowRevoke` above;
  // every other key (e.g. `autoApproval`, settable only through the publish API) must survive an
  // editor republish untouched. `buildPublishPolicy` spreads this and overlays `allowRevoke` —
  // mirrors the `originalAutoApprovalPolicy` / `amountConsistencyCheck` preserve-verbatim pattern
  // already used in this file.
  originalPolicy?: RuntimePolicy | null
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
// Lock-3 R-22 (CONFIRM-EXCLUDE): a graph containing a `handler` is COMPLEX (canvas-only); the linear
// steps editor is deliberately NOT taught the node type, so a handler graph is preserved verbatim.
const COMPLEX_GRAPH_NODE_TYPES = new Set(['cc', 'condition', 'parallel', 'handler'])

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
    recordLinkBaseId: '',
    recordLinkSheetId: '',
    numberCurrencySymbol: '',
    numberThousandsSeparator: false,
    numberUppercaseCny: false,
    dateRangeDateType: '',
    dateRangeStartLabel: '',
    dateRangeEndLabel: '',
    dateRangeDurationLabel: '',
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
    requesterChoiceMode: 'single',
    requesterChoiceScopeType: 'company',
    approvalMode: 'single',
    emptyAssigneePolicy: 'error',
    mergeWithRequester: false,
    fieldPermissions: [],
  }
}

/** True when `name` is still the untouched default `createEmptyStepDraft`/`buildApprovalGraph`
 * would give a step at 1-based `position` (`审批人 <position>`) — used by `insertStepAt` to tell
 * an author-renamed step apart from one that never got a custom name. */
export function isDefaultStepName(name: string, position: number): boolean {
  return name.trim() === `审批人 ${position}`
}

/**
 * G-B2-06 — insert a fresh blank step AFTER the existing step at `index` (0-based, matching the
 * `v-for="(step, index) in draft.steps"` position in `TemplateAuthoringView.vue`), instead of
 * `createEmptyStepDraft` being reachable only via end-of-list `addStep`. Any step AFTER the
 * insertion point whose `name` is still the untouched default for its OLD 1-based position gets
 * renumbered to match its new position, so the `审批人 N` numbering stays self-consistent after a
 * middle insert; a step the author has renamed is left untouched — insertion never overwrites
 * author-authored text. `moveStep`/`removeStep` are unaffected (separate functions, unchanged).
 */
export function insertStepAt(steps: ApprovalStepDraft[], index: number): ApprovalStepDraft[] {
  const insertAt = Math.min(Math.max(index + 1, 0), steps.length)
  const before = steps.slice(0, insertAt)
  const after = steps.slice(insertAt).map((step, offset) => {
    const oldPosition = insertAt + offset + 1
    const newPosition = oldPosition + 1
    return isDefaultStepName(step.name, oldPosition) ? { ...step, name: `审批人 ${newPosition}` } : step
  })
  const inserted = createEmptyStepDraft(insertAt + 1)
  return [...before, inserted, ...after]
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
    // A brand-new template has never been published, so there is no persisted policy to reflect
    // (L6-P1 §2.2: `allowRevoke` is the one RuntimePolicy field with no server default). `true`
    // stays the client-chosen create-time default, unchanged by the carrier fix below —
    // `originalPolicy` is correctly left absent (nothing to preserve yet).
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

function isNodeFieldAccess(value: unknown): value is NodeFieldAccess {
  return value === 'editable' || value === 'readonly' || value === 'hidden'
}

/**
 * T1-4: the access a step assigns to a form field — the matching `fieldPermissions` entry's access,
 * or `editable` (the absent default) when the field has no entry. Pure; used by the authoring UI.
 */
export function stepFieldAccess(step: ApprovalStepDraft, fieldId: string): NodeFieldAccess {
  const entry = step.fieldPermissions.find((permission) => permission.fieldId === fieldId)
  return entry ? entry.access : 'editable'
}

/**
 * T1-4: return a NEW `fieldPermissions` array with `fieldId` set to `access`. `editable` removes the
 * entry (absent === editable === the byte-stable default); a non-editable access updates the entry
 * IN PLACE (position-stable, so an untouched load→save keeps the hydrated order) or appends a new one.
 * Pure — the caller assigns the result back so Vue reactivity fires.
 */
export function setStepFieldPermission(
  permissions: NodeFieldPermission[],
  fieldId: string,
  access: NodeFieldAccess,
): NodeFieldPermission[] {
  if (access === 'editable') {
    return permissions.filter((permission) => permission.fieldId !== fieldId)
  }
  if (permissions.some((permission) => permission.fieldId === fieldId)) {
    return permissions.map((permission) => (permission.fieldId === fieldId ? { fieldId, access } : permission))
  }
  return [...permissions, { fieldId, access }]
}

function fieldDraftFromField(field: FormField): FieldAuthoringDraft | null {
  if (!isAuthorableFieldType(field.type)) return null
  const props = field.props && typeof field.props === 'object' ? field.props as Record<string, unknown> : {}
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
    recordLinkBaseId: field.type === 'record-link' && typeof props.baseId === 'string' ? props.baseId : '',
    recordLinkSheetId: field.type === 'record-link' && typeof props.sheetId === 'string' ? props.sheetId : '',
    // L8-C: typeof-guarded per key — a malformed stored value (wrong type) hydrates to the "unset"
    // default rather than throwing or coercing (mirrors numberFieldProps.ts's per-key discipline).
    // The backend now type-validates these three keys at publish (ApprovalProductService.ts), so a
    // freshly-saved template can never reach this hydration path with a malformed value; this stays
    // defensive for pre-existing/out-of-band data.
    numberCurrencySymbol: field.type === 'number' && typeof props.currencySymbol === 'string' ? props.currencySymbol : '',
    numberThousandsSeparator: field.type === 'number' && props.thousandsSeparator === true,
    numberUppercaseCny: field.type === 'number' && props.uppercaseCny === true,
    // L8-B: typeof/enum-guarded per key, mirroring L8-C's discipline — a malformed stored value
    // hydrates to the "unset" default rather than throwing or coercing. The backend type/enum
    // validates these at publish (ApprovalProductService.ts), so a freshly-saved template can never
    // reach this hydration path with a malformed value; this stays defensive for out-of-band data.
    dateRangeDateType:
      field.type === 'date_range' &&
      (props.dateType === 'date' || props.dateType === 'date_half_day' || props.dateType === 'date_minute')
        ? props.dateType
        : '',
    dateRangeStartLabel: field.type === 'date_range' && typeof props.startLabel === 'string' ? props.startLabel : '',
    dateRangeEndLabel: field.type === 'date_range' && typeof props.endLabel === 'string' ? props.endLabel : '',
    dateRangeDurationLabel: field.type === 'date_range' && typeof props.durationLabel === 'string' ? props.durationLabel : '',
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
  let requesterChoiceMode: 'single' | 'multi' = 'single'
  let requesterChoiceScopeType: 'company' | 'members' | 'role' = 'company'
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
  } else if (source?.kind === 'continuous_dept_heads') {
    // Lock-1 §K4: same shape as continuous_managers — reuses the shared `levels` field.
    sourceKind = 'continuous_dept_heads'
    levels = source.levels
  } else if (source?.kind === 'dept_head_at_level') {
    // Lock-1 §K5-b: same shape as manager_at_level — reuses the shared `level` field.
    sourceKind = 'dept_head_at_level'
    level = source.level
  } else if (source?.kind === 'requester_choice') {
    // Lock-1 §K2: hydrate mode + scope; a members/role scope's id list rides the shared
    // idsText chip carrier (sourceFromStep re-shapes it back per scope type).
    sourceKind = 'requester_choice'
    requesterChoiceMode = source.mode
    requesterChoiceScopeType = source.scope.type
    if (source.scope.type === 'members') idsText = formatIds(source.scope.userIds)
    else if (source.scope.type === 'role') idsText = formatIds(source.scope.roleIds)
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

  // T1-4: hydrate node-level field permissions. Only well-formed { fieldId, access-in-enum } entries
  // are carried; a malformed entry is separately caught by `unsupportedTemplateAuthoringReason`
  // (fail-closed read-only) so it is never silently re-saved.
  const fieldPermissions = Array.isArray(config.fieldPermissions)
    ? config.fieldPermissions
        .filter((entry): entry is NodeFieldPermission => !isBackendDroppedFieldPermission(entry))
        .map((entry) => ({ fieldId: entry.fieldId, access: entry.access }))
    : []

  return {
    localId: nextLocalId('step'),
    name: node.name ?? `审批人 ${index}`,
    sourceKind,
    idsText,
    fieldId,
    levels,
    level,
    requesterChoiceMode,
    requesterChoiceScopeType,
    approvalMode: config.approvalMode === 'all' || config.approvalMode === 'any' ? config.approvalMode : 'single',
    emptyAssigneePolicy: config.emptyAssigneePolicy === 'auto-approve' ? 'auto-approve' : 'error',
    mergeWithRequester,
    ...(autoApprovalPolicy ? { originalAutoApprovalPolicy: autoApprovalPolicy } : {}),
    fieldPermissions,
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
  // Lock-3 R-20: `handler` is recognised + load-preserved. WITHOUT this row a handler graph would
  // (correctly) force the whole template read-only with save blocked — the fail-closed positive control.
  'handler',
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
// `buildStepConfig`, which authors + re-emits `fieldPermissions` (T1-4) but NOT `timeout` /
// `approvalThreshold`, so the two allowlists must stay SEPARATE (sharing would let a linear node's
// unrepresented key through, then flatten it).
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
// autoApprovalPolicy / fieldPermissions bottom out in primitives / string-arrays; assigneeSources
// does too EXCEPT the Lock-1 §K2 `requester_choice` source, whose `scope` is a nested object —
// `requesterChoiceSourceHasBackendDrop` below carries that third level, so the check stays complete.
const BACKEND_ASSIGNEE_SOURCE_KEYS_BY_KIND: Record<string, string[]> = {
  static_user: ['kind', 'userIds'],
  static_role: ['kind', 'roleIds'],
  requester: ['kind'],
  direct_manager: ['kind'],
  dept_head: ['kind'],
  continuous_managers: ['kind', 'levels'],
  manager_at_level: ['kind', 'level'],
  // Lock-1 §K4: same flat 2-level shape as continuous_managers.
  continuous_dept_heads: ['kind', 'levels'],
  // Lock-1 §K5-b: same flat 2-level shape as manager_at_level.
  dept_head_at_level: ['kind', 'level'],
  form_field_user: ['kind', 'fieldId'],
  // Lock-1 §K2: `scope` is the ONE nested object in the source union (see
  // requesterChoiceSourceHasBackendDrop below for its per-type key check — the flat 2-level
  // allowlist alone cannot see inside it).
  requester_choice: ['kind', 'mode', 'scope'],
}

// Lock-1 §K2 — the requester_choice `scope` shapes the backend accepts (normalize REJECTS any
// other key/type rather than dropping it, but the FE posture is the same either way: a shape the
// backend won't re-emit verbatim must force read-only, never silently flatten on save).
const BACKEND_REQUESTER_CHOICE_SCOPE_KEYS_BY_TYPE: Record<string, string[]> = {
  company: ['type'],
  members: ['type', 'userIds'],
  role: ['type', 'roleIds'],
}

function requesterChoiceSourceHasBackendDrop(source: Record<string, unknown>): boolean {
  if (source.mode !== 'single' && source.mode !== 'multi') return true
  const scope = source.scope
  if (!isPlainRecord(scope)) return true
  const allowedScopeKeys = BACKEND_REQUESTER_CHOICE_SCOPE_KEYS_BY_TYPE[scope.type as string]
  if (!allowedScopeKeys || hasKeyOutside(scope, allowedScopeKeys)) return true
  if (scope.type === 'members' && !Array.isArray(scope.userIds)) return true
  if (scope.type === 'role' && !Array.isArray(scope.roleIds)) return true
  return false
}
const BACKEND_AUTO_APPROVAL_POLICY_KEYS = ['mergeWithRequester', 'mergeAdjacentApprover', 'dedupeHistoricalApprover', 'actorMode']
const BACKEND_FIELD_PERMISSION_KEYS = ['fieldId', 'access']

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function hasKeyOutside(value: unknown, allowed: string[]): boolean {
  return isPlainRecord(value) && Object.keys(value).some((key) => !allowed.includes(key))
}

// T1-4: a `fieldPermissions[]` entry the backend `normalizeApprovalGraph` re-emits verbatim is EXACTLY
// `{ fieldId: <non-empty string>, access: 'editable'|'readonly'|'hidden' }`. Anything else — an extra key,
// a non-string/empty fieldId, OR an out-of-enum access value — is dropped/normalized away on save. Both the
// linear authoring guard and the complex-drop check must treat such an entry as a backend-drop (fail-closed
// to read-only) so hydrate/buildStepConfig never SILENTLY flattens it. Single source of truth for both.
function isBackendDroppedFieldPermission(perm: unknown): boolean {
  return !isPlainRecord(perm)
    || hasKeyOutside(perm, BACKEND_FIELD_PERMISSION_KEYS)
    || typeof perm.fieldId !== 'string'
    || perm.fieldId.length === 0
    || !isNodeFieldAccess(perm.access)
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
      // Lock-1 §K2: the nested `scope` object needs its own per-type key/shape check.
      if (source.kind === 'requester_choice' && requesterChoiceSourceHasBackendDrop(source)) return true
    }
  }
  if (hasKeyOutside(config.autoApprovalPolicy, BACKEND_AUTO_APPROVAL_POLICY_KEYS)) return true
  const perms = config.fieldPermissions
  if (Array.isArray(perms)) {
    for (const perm of perms) {
      if (isBackendDroppedFieldPermission(perm)) return true
    }
  }
  return false
}

// The COMPLEX-path config shapes the backend re-emits for the OTHER node types (same silent-drop
// risk as approval): cc → {targetType, targetIds}; parallel → {branches, joinMode, joinNodeKey};
// condition → {branches, defaultEdgeKey} with each branch {edgeKey, conjunction?, rules, formula?}
// and each rule {fieldId, operator, value?} (the rule `value` is a free leaf, NOT shape-checked);
// start/end → {}. Formula branches are FC-2 authorable and round-trip through `conditionEdit.ts`.
const BACKEND_CC_CONFIG_KEYS = ['targetType', 'targetIds']
const BACKEND_PARALLEL_CONFIG_KEYS = ['branches', 'joinMode', 'joinNodeKey']
// Lock-3 R-21 — the handler config keys the backend `normalizeApprovalGraph` (case 'handler') re-emits.
// Any other key is silently dropped on save, so it must trip the backend-drop check (fail-closed).
const BACKEND_HANDLER_CONFIG_KEYS = ['assigneeSources', 'handlerMode', 'opinionRequired', 'fieldPermissions']
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
    case 'handler':
      // Lock-3 R-21: a handler key outside the backend allowlist is a silent backend-drop.
      return hasKeyOutside(config, BACKEND_HANDLER_CONFIG_KEYS)
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
    return `包含暂不支持编辑的字段类型：${unsupportedField.label || '未命名字段'}`
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
    return `包含暂不支持编辑的审批节点：${unknownNode.name || '未命名节点'}`
  }

  // Complex graphs (cc/condition/parallel or non-linear) are load-preserved verbatim via
  // spread-original-first — BUT the backend `normalizeApprovalGraph` rebuilds EVERY node's config
  // from a fixed per-type allowlist and silently DROPS any other key (top-level or nested) on save.
  // The FE deep-equal round-trip can't see that drop, so fail-closed: ANY node carrying a config key
  // the backend won't preserve is unsupported (read-only, save disabled), never silently flattened.
  if (isComplexApprovalGraph(template.approvalGraph)) {
    const unsupportedNode = template.approvalGraph.nodes.find((node) => complexNodeConfigHasBackendDrop(node))
    if (unsupportedNode) {
      return `节点含后端不会保留的配置（保存将丢失），已锁定为只读：${unsupportedNode.name || '未命名节点'}`
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
      // T1-4: `fieldPermissions` is now authored + preserved by the linear path (buildStepConfig),
      // so it is no longer an unknown config key that would force the whole template read-only.
      'fieldPermissions',
    ]
    if (Object.keys(config).some((key) => !allowedConfigKeys.includes(key))) return true
    const sources = config.assigneeSources
    if (sources !== undefined) {
      if (!Array.isArray(sources) || sources.length !== 1) return true
      const source = sources[0] as ApprovalAssigneeSource
      if (!['static_user', 'static_role', 'requester', 'form_field_user', 'direct_manager', 'dept_head', 'continuous_managers', 'manager_at_level', 'requester_choice', 'continuous_dept_heads', 'dept_head_at_level'].includes(source?.kind)) return true
      // Lock-1 §K2: a malformed requester_choice shape must fail-closed to read-only here too —
      // hydrate would otherwise re-derive a default mode/scope and silently flatten it on save.
      if (source?.kind === 'requester_choice' && requesterChoiceSourceHasBackendDrop(source as unknown as Record<string, unknown>)) return true
    }
    // T1-4: `buildStepConfig` re-emits only { fieldId, access } per entry (the backend allowlist),
    // so a linear node carrying an ARRAY-shaped fieldPermissions with an extra key or non-object
    // entry would be silently flattened on save — fail-closed to read-only instead (mirrors the
    // complex path's `complexApprovalConfigHasBackendDrop`).
    const perms = config.fieldPermissions
    if (perms !== undefined) {
      if (!Array.isArray(perms)) return true
      for (const perm of perms) {
        if (isBackendDroppedFieldPermission(perm)) return true
      }
    }
    return false
  })
  if (unsupportedApproval) {
    return `审批节点含暂不支持的配置：${unsupportedApproval.name || '未命名节点'}`
  }

  return null
}

/**
 * Legacy-named informational message for templates that use the graph editor instead of the
 * linear steps editor. Complex graphs remain editable and save-preserved; only genuinely unknown
 * node config is blocked by `unsupportedTemplateAuthoringReason`.
 */
export function graphReadOnlyReason(template: ApprovalTemplateDetailDTO): string | null {
  if (unsupportedTemplateAuthoringReason(template)) return null
  if (!isComplexApprovalGraph(template.approvalGraph)) return null
  return '该模板已启用分支流程编辑：可在画布调整流程结构，并在结构列表编辑各节点配置。'
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
    // L6-P1 carrier fix — was hardcoded `true` regardless of the persisted value, so a template
    // published with `allowRevoke:false` reverted to `true` on every editor load. `??` (not `||`)
    // is required: a persisted `false` must stay `false`, not fall through to the default. `null`/
    // absent `policy` (never-published template) keeps the create-time default of `true`.
    allowRevoke: template.policy?.allowRevoke ?? true,
    originalPolicy: template.policy ?? null,
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
      // FWB-0 Layer 2: record-link props are exactly { baseId, sheetId } (OpenAPI
      // RecordLinkFieldProps additionalProperties:false). Never spread original.props —
      // retyping text→record-link (or any other type→record-link) must not resurrect
      // stale unrelated keys (options-era displayField, etc.).
      if (field.type === 'record-link') {
        next.props = {
          baseId: field.recordLinkBaseId.trim(),
          sheetId: field.recordLinkSheetId.trim(),
        }
      } else if (field.type === 'number') {
        // L8-C (§1.3): editor is authoritative for the three NEW display keys only — preserve
        // min/max/step/precision/derivedFrom verbatim from `original` (unauthorable, §0.4) via the
        // starting spread, then overlay/delete the three authored keys so unchecking a toggle (or
        // clearing the currency select) does not resurrect a stale value from `original` (mirrors
        // the visibilityRule/options omit discipline above). The backend re-canonicalizes on save
        // regardless (OD-L8-7); this keeps the client-authored payload already clean.
        const props = next.props && typeof next.props === 'object'
          ? { ...next.props } as Record<string, unknown>
          : {}
        delete props.baseId
        delete props.sheetId
        delete props.currencySymbol
        delete props.thousandsSeparator
        delete props.uppercaseCny
        const currencySymbol = field.numberCurrencySymbol.trim()
        if (currencySymbol) props.currencySymbol = currencySymbol
        if (field.numberThousandsSeparator) props.thousandsSeparator = true
        if (field.numberUppercaseCny) props.uppercaseCny = true
        if (Object.keys(props).length === 0) delete next.props
        else next.props = props
      } else if (field.type === 'date_range') {
        // L8-B (§1.2): a BRAND NEW type — unlike number, no pre-existing template could carry
        // unrelated date_range props, so props are built fresh (mirrors record-link's discipline,
        // never spreading `next.props`/`original`, not L8-C's preserve-then-overlay one — there is
        // nothing legacy here to preserve). `dateType` has NO absent-default (§1.2): an unset draft
        // emits no `dateType` key at all, so publish's required-key check rejects it rather than
        // the client silently picking an arm.
        const props: Record<string, unknown> = {}
        if (field.dateRangeDateType) props.dateType = field.dateRangeDateType
        const startLabel = field.dateRangeStartLabel.trim()
        if (startLabel) props.startLabel = startLabel
        const endLabel = field.dateRangeEndLabel.trim()
        if (endLabel) props.endLabel = endLabel
        const durationLabel = field.dateRangeDurationLabel.trim()
        if (durationLabel) props.durationLabel = durationLabel
        next.props = props
      } else if (next.props && typeof next.props === 'object') {
        // Drop record-link pins + L8-C display keys + L8-B date_range keys when type changes away;
        // keep other type-specific props only if still meaningful (do not leave baseId/sheetId, a
        // formatted-number display flag, or a date_range prop on a text field).
        const props = { ...next.props } as Record<string, unknown>
        delete props.baseId
        delete props.sheetId
        delete props.currencySymbol
        delete props.thousandsSeparator
        delete props.uppercaseCny
        delete props.dateType
        delete props.startLabel
        delete props.endLabel
        delete props.durationLabel
        if (Object.keys(props).length === 0) delete next.props
        else next.props = props
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

/** Exported (G-B2-06) so `linearStepSpine.ts` can derive the same `ApprovalAssigneeSource` the
 * saved graph would carry and feed it to the shared `assigneeSourceSummary` humanizer, instead of
 * re-deriving a second sourceKind→text switch that could drift from this one. */
export function sourceFromStep(step: ApprovalStepDraft): ApprovalAssigneeSource {
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
  if (step.sourceKind === 'continuous_dept_heads') {
    // Lock-1 §K4: reuses the shared `levels` field (same shape as continuous_managers).
    return { kind: 'continuous_dept_heads', levels: step.levels }
  }
  if (step.sourceKind === 'dept_head_at_level') {
    // Lock-1 §K5-b: reuses the shared `level` field (same shape as manager_at_level).
    return { kind: 'dept_head_at_level', level: step.level }
  }
  if (step.sourceKind === 'requester_choice') {
    // Lock-1 §K2: re-shape the shared idsText carrier into the per-scope id list.
    const scope =
      step.requesterChoiceScopeType === 'members'
        ? { type: 'members' as const, userIds: parseIdsText(step.idsText) }
        : step.requesterChoiceScopeType === 'role'
          ? { type: 'role' as const, roleIds: parseIdsText(step.idsText) }
          : { type: 'company' as const }
    return { kind: 'requester_choice', mode: step.requesterChoiceMode, scope }
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
function buildStepConfig(step: ApprovalStepDraft, fieldIds: Set<string>): ApprovalNodeConfig {
  const autoApprovalPolicy: AutoApprovalPolicy = {
    ...step.originalAutoApprovalPolicy,
    ...(step.mergeWithRequester ? { mergeWithRequester: true } : {}),
  }
  // The toggle owns `mergeWithRequester`: when OFF, drop the flag but keep preserved
  // siblings. (Spread-only would resurrect a `mergeWithRequester:true` carrier.)
  if (!step.mergeWithRequester) {
    delete autoApprovalPolicy.mergeWithRequester
  }
  // T1-4: emit only NON-editable entries (editable === absent default) whose field still exists —
  // pruning an entry for a deleted field keeps the backend cross-reference
  // (`validateNodeFieldPermissionsAgainstFormSchema`) satisfied. Omit the key entirely when empty
  // (mirrors the autoApprovalPolicy omit-empty discipline so a bare `[]` is never persisted). Fresh
  // objects so the emitted graph never aliases the reactive draft.
  const fieldPermissions = step.fieldPermissions
    .filter((permission) => permission.access !== 'editable' && fieldIds.has(permission.fieldId))
    .map((permission) => ({ fieldId: permission.fieldId, access: permission.access }))
  return {
    assigneeSources: [sourceFromStep(step)],
    approvalMode: step.approvalMode,
    emptyAssigneePolicy: step.emptyAssigneePolicy,
    ...(Object.keys(autoApprovalPolicy).length > 0 ? { autoApprovalPolicy } : {}),
    ...(fieldPermissions.length > 0 ? { fieldPermissions } : {}),
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
  // T1-4: the set of live top-level form-field ids — `buildStepConfig` prunes any fieldPermission
  // whose field was deleted so a dangling fieldId can never reach the backend cross-reference.
  const fieldIds = new Set(draft.fields.map((field) => field.id.trim()).filter(Boolean))
  const approvalNodes = draft.steps.map((step, index) => ({
    key: `approval_${index + 1}`,
    type: 'approval' as const,
    name: step.name.trim() || `审批人 ${index + 1}`,
    config: buildStepConfig(step, fieldIds),
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
  return draftFromEditedGraph(draft, op(buildApprovalGraph(draft)))
}

/**
 * Apply a topology operation to any draft. Linear drafts are promoted to the graph authoring model
 * first, preserving the graph produced by their current steps. From this point on there is a single
 * structural source of truth (`preservedGraph`).
 */
export function applyTopologyToDraft(
  draft: TemplateAuthoringDraft,
  op: (graph: ApprovalGraph) => ApprovalGraph,
): TemplateAuthoringDraft {
  return draftFromEditedGraph(draft, op(buildApprovalGraph(draft)))
}

function draftFromEditedGraph(draft: TemplateAuthoringDraft, next: ApprovalGraph): TemplateAuthoringDraft {
  return {
    ...draft,
    steps: [],
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

// B2-03: split out of the former monolithic `validateTemplateDraft` so the publish pre-flight
// checklist can show a "表单字段" bucket independently (without re-deriving/duplicating the rules).
// `validateTemplateDraft` below composes this + `validateTemplateApprovalFlow` in the SAME order as
// before the split, so its combined output is byte-identical to the pre-split function.
export type RecordLinkCatalogValidationContext = {
  /** True only after a successful multitable catalog fetch. */
  loaded: boolean
  sheets: ReadonlyArray<{ id: string; baseId?: string | null }>
}

// P1-A0 (master §4 UI-0 "live validation count"; Lock-0 L0-3 typed-issue-record delta) — typed
// issue shape for the authoring validators. `target` reuses L0-3's exact `{ kind, key }` contract
// (`approval-lock0-d0-interaction-delta-20260817.md` L0-3) so a later slice adopting the header
// count can consume this same record instead of migrating a second shape.
//
// `severity` is a SUPERSET field L0-3 does not define. Every basic-info check today is a hard
// "must fix", so `severity` is currently ALWAYS `'error'` — it is declared for the future header
// count (which may eventually need to distinguish a soft warning) but has exactly one live value
// right now; do not read its presence as evidence a warning tier already exists.
//
// This is a typed SIBLING of the existing `string[]` validators, not a replacement — but not fully
// independent of them either: `validateTemplateFormFields` below now COMPOSES
// `validateTemplateBasicInfo`'s `.message`s for its first five entries (previously inlined). Both
// `validationErrors` (the save-blocking surface) and `publishChecklist` (the publish pre-flight,
// `TemplateAuthoringView.vue`) therefore transitively call through this new function, but their
// composition, values, and rendered strings are byte-identical to before this extraction (pinned
// by the regression tests below) — "sibling, not replacement" describes the OUTPUT contract, not
// the call graph. Only the NEW basic-info step-nav issue badge derives its displayed count from
// the typed shape directly (`AuthoringValidationIssue[].length`, never hand-counted).
export type AuthoringValidationSeverity = 'error' | 'warning'

export interface AuthoringValidationIssueTarget {
  kind: 'node' | 'field' | 'section'
  key: string
}

export interface AuthoringValidationIssue {
  /** Stable rule identifier (was informally "field" — renamed to avoid colliding with the
   * `target.kind === 'field'` case, since a basic-info issue like `visibility` targets the whole
   * 基础信息 section, not a `FieldAuthoringDraft`). */
  code: string
  message: string
  severity: AuthoringValidationSeverity
  target?: AuthoringValidationIssueTarget
}

/**
 * Typed basic-info issues — the SAME five checks `validateTemplateFormFields` has always run
 * first (`unsupportedReason` / key / name / visibility scope / SLA hours), extracted verbatim so
 * the 基础信息 step-nav badge can derive its count from a typed array instead of a hand-maintained
 * counter. `validateTemplateFormFields` below calls this and flattens `.message` into its existing
 * `string[]`, in the SAME order, so the combined validation set, order, and exact copy are
 * unchanged from before this extraction — this function adds a typed VIEW onto existing rules, it
 * does not add, remove, or reword any of them.
 *
 * `unsupportedReason` (an attachment-field/unknown-node structural block, not something an author
 * fixes by editing 基础信息 text) is included deliberately: `firstInvalidAuthoringSection` already
 * routes a validate() failure carrying it to the `'basic'` step (this file, `hasBasicSettingsError`
 * in `TemplateAuthoringView.vue`), so counting it here mirrors an existing attribution rather than
 * inventing a new one — it does not introduce a second, disagreeing classification.
 */
export function validateTemplateBasicInfo(
  draft: TemplateAuthoringDraft,
  unsupportedReason?: string | null,
): AuthoringValidationIssue[] {
  const issues: AuthoringValidationIssue[] = []
  if (unsupportedReason) {
    issues.push({
      code: 'unsupported',
      message: unsupportedReason,
      severity: 'error',
      target: { kind: 'section', key: 'basic' },
    })
  }
  if (!draft.key.trim()) {
    issues.push({
      code: 'key',
      message: '模板 Key 必填',
      severity: 'error',
      target: { kind: 'field', key: 'key' },
    })
  }
  if (!draft.name.trim()) {
    issues.push({
      code: 'name',
      message: '模板名称必填',
      severity: 'error',
      target: { kind: 'field', key: 'name' },
    })
  }
  if (draft.visibilityType !== 'all' && parseIdsText(draft.visibilityIdsText).length === 0) {
    issues.push({
      code: 'visibility',
      message: '非全员可见范围至少需要一个 id',
      severity: 'error',
      target: { kind: 'field', key: 'visibilityIdsText' },
    })
  }
  if (Number.isNaN(buildSlaHours(draft))) {
    issues.push({
      code: 'slaHours',
      message: 'SLA 必须是正整数小时或留空',
      severity: 'error',
      target: { kind: 'field', key: 'slaHoursText' },
    })
  }
  return issues
}

export function validateTemplateFormFields(
  draft: TemplateAuthoringDraft,
  unsupportedReason?: string | null,
  recordLinkCatalog?: RecordLinkCatalogValidationContext | null,
): string[] {
  const errors: string[] = validateTemplateBasicInfo(draft, unsupportedReason).map((issue) => issue.message)
  const fields = draft.fields.map((field) => field.id.trim()).filter(Boolean)
  if (fields.length !== draft.fields.length) errors.push('字段 id 必填')
  if (new Set(fields).size !== fields.length) errors.push('字段 id 不能重复')
  draft.fields.forEach((field, index) => {
    const authorLabel = field.label.trim() || `第 ${index + 1} 个字段`
    if (!field.label.trim()) errors.push(`第 ${index + 1} 个字段的名称必填`)
    if ((field.type === 'select' || field.type === 'multi-select')) {
      const options = parseOptionsText(field.optionsText)
      if (options.length === 0) errors.push(`${authorLabel}需要至少一个选项`)
      if (options.some((option) => !option.label.trim() || !option.value.trim())) {
        errors.push(`${authorLabel}的选项名称和值不能为空`)
      }
    }
    // detail / sub-form: mirror the backend `normalizeDetailFieldParts` reject-set client-side
    // (non-empty leaf-only unique-id columns, no nesting, minRows <= maxRows non-negative ints).
    if (field.type === 'detail') {
      errors.push(
        ...validateDetailColumnsDraft(
          field.label.trim() || `第 ${index + 1} 个明细字段`,
          field.detailColumns,
          field.minRowsText,
          field.maxRowsText,
        ),
      )
    }
    // FWB-0 Layer 2 record-link: server-pinned target base + sheet required (top-level only).
    // Ordinary UI never mentions raw id field names — validation copy stays values-free.
    if (field.type === 'record-link') {
      if (!field.recordLinkBaseId.trim() || !field.recordLinkSheetId.trim()) {
        errors.push(`字段 ${field.label.trim() || field.id}（关联记录）需要选择目标空间与目标表`)
      } else if (recordLinkCatalog?.loaded) {
        // When catalog has loaded successfully, block save if the pin is absent or belongs
        // to another base (hydrated mismatch retained as "目标不可用" option).
        const pinError = validateRecordLinkPinAgainstLoadedCatalog(field, recordLinkCatalog)
        if (pinError) errors.push(pinError)
      }
    }
  })
  // Mirror the server visibility-rule reject-set (normalizeFormFieldVisibilityRule +
  // validateFormFieldVisibilityRules): dependency must reference an existing field,
  // not itself; `in` needs >=1 value; and the dependency graph must be acyclic.
  // FWB-0 Layer 2 P1-2: record-link is v1-excluded as a visibility dependency (object values).
  // Lock-8 L8-B OD-L8-5(a): `dependsOn` may also be a dotted date_range endpoint address
  // (`${id}.start`/`${id}.end`) — mirrors the runtime resolver (fieldVisibility.ts
  // `resolveVisibilityFieldReference`) without importing it, since this validator works over
  // `FieldAuthoringDraft` (not `FormField`) and only needs id/type, which the draft already
  // carries. A bare reference straight at a date_range field is refused (its `{start,end}` value
  // is non-scalar, same reason as record-link); a dotted reference is accepted ONLY when its base
  // resolves to an actual date_range field — an unresolvable dotted address is "does not exist",
  // same as a bare id that isn't in `fieldIdSet`.
  const fieldIdSet = new Set(draft.fields.map((field) => field.id.trim()).filter(Boolean))
  const recordLinkFieldIds = new Set(
    draft.fields.filter((field) => field.type === 'record-link').map((field) => field.id.trim()).filter(Boolean),
  )
  const dateRangeFieldIds = new Set(
    draft.fields.filter((field) => field.type === 'date_range').map((field) => field.id.trim()).filter(Boolean),
  )
  const visibilityDeps = new Map<string, string>()
  draft.fields.forEach((field) => {
    const dependsOn = field.visibility.dependsOnFieldId.trim()
    if (!dependsOn) return
    const fieldId = field.id.trim()
    const label = field.label.trim() || fieldId || '(未命名)'
    const dotIndex = dependsOn.lastIndexOf('.')
    const dottedSuffix = dotIndex > 0 && dotIndex < dependsOn.length - 1 ? dependsOn.slice(dotIndex + 1) : ''
    const isDottedEndpoint = dottedSuffix === 'start' || dottedSuffix === 'end'
    const dependencyBaseId = isDottedEndpoint ? dependsOn.slice(0, dotIndex) : dependsOn
    if (isDottedEndpoint) {
      if (!dateRangeFieldIds.has(dependencyBaseId)) {
        errors.push(`字段 ${label} 的显隐依赖字段不存在`)
        return
      }
    } else if (!fieldIdSet.has(dependsOn)) {
      errors.push(`字段 ${label} 的显隐依赖字段不存在`)
      return
    } else if (dateRangeFieldIds.has(dependsOn)) {
      errors.push(`字段 ${label} 的显隐规则不能依赖日期区间字段的整体值（请选择起始或结束）`)
      return
    }
    if (dependencyBaseId === fieldId) {
      errors.push(`字段 ${label} 的显隐规则不能依赖自身`)
      return
    }
    if (recordLinkFieldIds.has(dependencyBaseId)) {
      errors.push(`字段 ${label} 的显隐规则不能依赖关联记录字段（v1）`)
      return
    }
    if (field.visibility.operator === 'in'
      && field.visibility.valueText.split('\n').map((line) => line.trim()).filter(Boolean).length === 0) {
      errors.push(`字段 ${label} 的显隐"包含"规则需要至少一个值`)
    }
    if (fieldId) visibilityDeps.set(fieldId, dependencyBaseId)
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
  return errors
}

// B2-03: the other half of the split — step / graph-edit ("审批流程") errors only. See
// `validateTemplateFormFields` above for the rationale.
export function validateTemplateApprovalFlow(draft: TemplateAuthoringDraft): string[] {
  const errors: string[] = []
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
    // Lock-1 §K2 PREVIEW (backend normalize is the final arbiter): a members/role scope needs
    // at least one configured id — the backend rejects an empty scope list the same way.
    if (
      step.sourceKind === 'requester_choice'
      && (step.requesterChoiceScopeType === 'members' || step.requesterChoiceScopeType === 'role')
      && parseIdsText(step.idsText).length === 0
    ) {
      errors.push(`${label} 的提交人自选范围需要选择成员/角色`)
    }
  })
  return errors
}

export function validateTemplateDraft(
  draft: TemplateAuthoringDraft,
  unsupportedReason?: string | null,
  recordLinkCatalog?: RecordLinkCatalogValidationContext | null,
): string[] {
  return [
    ...validateTemplateFormFields(draft, unsupportedReason, recordLinkCatalog),
    ...validateTemplateApprovalFlow(draft),
  ]
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

/**
 * L6-P1 carrier fix — the publish-time policy payload. MERGES onto `draft.originalPolicy`
 * (the persisted object hydrated verbatim by `draftFromTemplate`) and overlays only the field the
 * editor actually owns (`allowRevoke`). Was previously built inline at the call site as
 * `{ allowRevoke: draft.allowRevoke }` — a REPLACE, not a merge — which silently destroyed any
 * sibling policy field (e.g. `autoApproval`, `revokeBeforeNodeKeys`) set only through the publish
 * API on every editor republish. `draft.originalPolicy` is absent for a template that has never
 * been published, so a brand-new template still publishes exactly `{ allowRevoke }` (no field is
 * invented). The backend's `assertRuntimePolicy` re-validates every carried-through key, so
 * publishing a stale/foreign shape here fails closed there rather than persisting silently.
 */
export function buildPublishPolicy(draft: TemplateAuthoringDraft): RuntimePolicy {
  return {
    ...(draft.originalPolicy ?? {}),
    allowRevoke: draft.allowRevoke,
  }
}
