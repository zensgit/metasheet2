import type {
  ApprovalAssigneeSource,
  ApprovalGraph,
  ApprovalMode,
  ApprovalNode,
  ApprovalNodeConfig,
  ApprovalTemplateDetailDTO,
  ApprovalTemplateVisibilityScope,
  AutoApprovalPolicy,
  EmptyAssigneeFallback,
  EmptyAssigneePolicy,
  FormField,
  FormFieldType,
  FormFieldVisibilityOperator,
  FormFieldVisibilityRule,
  FormOption,
  FormSchema,
  NodeFieldAccess,
  NodeFieldPermission,
  NodeTimeoutConfig,
  NodeTimeoutEffect,
  SupportedNodeTimeoutEffect,
  NodeOperationPolicy,
  CreateApprovalTemplateRequest,
  UpdateApprovalTemplateRequest,
  RuntimePolicy,
} from '../types/approval'
import { NODE_TIMEOUT_MAX_AFTER_MINUTES, NODE_TIMEOUT_SUPPORTED_EFFECTS } from '../types/approval'
export { NODE_TIMEOUT_MAX_AFTER_MINUTES, NODE_TIMEOUT_SUPPORTED_EFFECTS } from '../types/approval'
export type { NodeTimeoutConfig, NodeTimeoutEffect, SupportedNodeTimeoutEffect } from '../types/approval'
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
// P1-C: reuse the EXISTING FE mirror of backend `collectParallelRegionNodeKeys`
// (ApprovalProductService.ts) — ported once already for the canvas's nested-parallel authoring
// guard. Do not duplicate; both the canvas guard and this slice's linear-only threshold/timeout gate
// must agree on exactly what "inside a parallel region" means.
import { collectParallelRegionNodeKeys } from './graphTopologyEdit'
export { collectParallelRegionNodeKeys } from './graphTopologyEdit'
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
export { placeholderRoleNodeKeys, isPlaceholderRoleSource, addAssigneeSourceCard, removeAssigneeSourceCard, legalPriorApproverNodeKeys } from './approvalNodeEdit'

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
  // Lock-8 L8-A (approval-lock8-field-vocabulary-20260817.md §1.1): display-only 说明. Top-level
  // only — excluded from `DETAIL_LEAF_FIELD_TYPES` (detailField.ts), never a whole-value
  // visibility/condition dependency (MS-8/MS-9/MS-10).
  'explanation',
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
  /**
   * Lock-8 L8-A (approval-lock8-field-vocabulary-20260817.md §1.1, OD-L8-3(a)): the authored body
   * (`props.text`) shown to the requester/approver. Meaningful only when `type === 'explanation'`.
   * `''` is the "not yet written" draft state — publish rejects a blank/missing `props.text`, never
   * silently defaults it.
   */
  explanationText: string
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
  // Lock-1 §K3 (节点审批人) — meaningful only when `sourceKind === 'prior_node_approver'`: the
  // `localId` of the EARLIER step whose actual decider(s) this step re-asks. Deliberately a
  // step-localId reference, NOT a raw node key: the linear builder regenerates node keys
  // positionally (`approval_${index+1}`), so a stored key would silently RETARGET when steps are
  // inserted/reordered — the localId reference follows the intended step and `sourceFromStep`
  // emits that step's CURRENT key at build time. `''` = not yet chosen (invalid to save).
  priorStepLocalId: string
  // Lock-1 §K1 (用户组) — meaningful only when `sourceKind === 'user_group'`. Group ids from the
  // TYPED bound-group picker (never free text) — the picker lists only groups bound to the
  // template's org (`/api/approval-templates/directory/member-groups?orgId=`); a group outside
  // the binding fails publish (values-free 400), never at dispatch. Dedicated array field
  // (NOT the shared `idsText` chip carrier `static_user`/`static_role` reuse) so the sub-form can
  // render a proper multi-select of resolved group names, never a raw-id text box.
  groupIds: string[]
  approvalMode: ApprovalMode
  // P1-C (T2-4 N-of-M / 门槛会签): meaningful ONLY when `approvalMode === 'threshold'`. Carried for
  // every step (mirrors `levels`/`level`'s always-present-but-conditionally-meaningful posture) so
  // switching mode back to 'threshold' restores the last-entered N rather than resetting to 1. The
  // backend's static N<=M publish bound applies ONLY to the legacy `assigneeType`/`assigneeIds`
  // shape (ApprovalProductService.ts :2292-2304) — this editor always emits `assigneeSources`
  // (`buildStepConfig`), so M is ALWAYS resolved at runtime and an unreachable N fails closed at
  // dispatch (`APPROVAL_THRESHOLD_UNREACHABLE`), never at save/publish. See
  // `validateTemplateApprovalFlow` for the (integer-only) client-side preview.
  approvalThreshold: number
  emptyAssigneePolicy: EmptyAssigneePolicy
  /**
   * Fix-round P1-1 (gate P3A-F4B-20260819) — PRESERVE-VERBATIM carrier for `'designated'`'s target
   * set. The linear editor has no typed userIds/roleIds picker yet (deferred follower work), so
   * this field is never authored here; it exists so hydrate → `buildStepConfig` re-emits the
   * persisted object unchanged instead of silently dropping it on save. Same role as
   * `nodeOperationPolicy` / `originalAutoApprovalPolicy`. Absent unless `emptyAssigneePolicy` is
   * `'designated'`, and omitted from the built config when absent (byte-stability).
   */
  emptyAssigneeFallback?: EmptyAssigneeFallback
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
  // P1-C (T1-1) node-level SLA timeout — a linear graph is BY CONSTRUCTION never inside a parallel
  // region (`orderedLinearNodes` admits no `parallel` node at all), so the backend's
  // `APPROVAL_NODE_TIMEOUT_PARALLEL_UNSUPPORTED` gate can never fire here; the linear editor offers
  // this control unconditionally. `timeoutEnabled` false ⇒ `buildStepConfig` omits `timeout` entirely
  // (byte-stable absence, mirrors the `autoApprovalPolicy`/`fieldPermissions` omit-empty discipline).
  timeoutEnabled: boolean
  // Raw text input, mirroring `slaHoursText`'s parse-on-build discipline — '' is the unset state.
  timeoutAfterMinutesText: string
  // '' is the "not yet chosen" draft state (mirrors `dateRangeDateType`) — publish-time validation
  // (`validateTemplateApprovalFlow`) rejects it while `timeoutEnabled` is true, never silently
  // coerced to a default effect. Restricted to `NODE_TIMEOUT_SUPPORTED_EFFECTS` — `auto_approve` /
  // `auto_reject` are reserved and this control never offers them (M6/M8: no invented capability).
  timeoutEffect: SupportedNodeTimeoutEffect | ''
  // Meaningful only when `timeoutEffect === 'transfer'`.
  timeoutTransferToUserId: string
  // Meaningful only when `timeoutEffect === 'jump'` — the TARGET approval step's `localId` (resolved
  // to the built node key by `buildStepConfig`, since node keys are assigned positionally at build
  // time and are not stable identity in the draft). Never the raw persisted node key on read either —
  // `stepDraftFromApprovalNode` re-resolves the persisted `jumpToNodeKey` to the matching step's
  // `localId` at hydrate time for the SAME reason.
  timeoutJumpToStepLocalId: string
  // '' (wall-clock, the backend absent-default) or 'business'. Mirrors `normalizeNodeTimeout`'s
  // emitted shape: 'wall_clock' is never persisted as an explicit value, only as key-absence.
  timeoutUnit: '' | 'business'
  /**
   * Lock-5 §1.1 L5-A — PRESERVE-VERBATIM carrier for the per-node 操作权限 object. The linear
   * editor has no `操作权限` surface (that tab lives in the canvas inspector), so this field is
   * never authored here; it exists so hydrate → `buildStepConfig` re-emits the persisted object
   * unchanged instead of silently dropping it on save. Same role as
   * `originalAutoApprovalPolicy` / `FieldAuthoringDraft.original`. Absent for the overwhelming
   * majority of steps, and omitted from the built config when absent (byte-stability).
   */
  nodeOperationPolicy?: NodeOperationPolicy
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
  /**
   * P3-B / Lock-6 L6-A (docs/development/approval-lock6-requester-global-policy-20260817.md §1) —
   * the editable projection of the TEMPLATE-level dedup tier. Mirrors the node-level
   * `mergeWithRequester` / `originalAutoApprovalPolicy` pattern immediately below: this is the ONE
   * sub-field of `originalPolicy.autoApproval` the editor authors; every other key (and the
   * both-flags-true combination this tier cannot express) survives verbatim via
   * `buildTemplateAutoApprovalPolicy`, which reads `originalPolicy.autoApproval` directly rather
   * than reconstructing it from this field alone. See `templateDedupTierFromPolicy` /
   * `isTemplateDedupTierLocked` for the hydrate-time projection and lock detection.
   */
  autoApprovalDedupTier: TemplateDedupTier
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
    explanationText: '',
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
    priorStepLocalId: '',
    groupIds: [],
    approvalMode: 'single',
    approvalThreshold: 1,
    emptyAssigneePolicy: 'error',
    mergeWithRequester: false,
    fieldPermissions: [],
    timeoutEnabled: false,
    timeoutAfterMinutesText: '',
    timeoutEffect: '',
    timeoutTransferToUserId: '',
    timeoutJumpToStepLocalId: '',
    timeoutUnit: '',
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
    // §2.2 "no shipped default may change": absent `autoApproval` === 不去重 for a brand-new
    // template, exactly like every pre-P3-B published template.
    autoApprovalDedupTier: 'none',
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
    // L8-A: typeof-guarded, same discipline as the L8-B/L8-C keys above — a malformed stored value
    // hydrates to the "unset" draft state rather than throwing or coercing. The backend requires a
    // non-blank `props.text` at publish, so a freshly-saved template can never reach this hydration
    // path with a malformed value; this stays defensive for out-of-band data.
    explanationText: field.type === 'explanation' && typeof props.text === 'string' ? props.text : '',
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
  let groupIds: string[] = []
  // Lock-1 §K3: hydrated as '' here (this per-node projection has no cross-step context);
  // `draftFromTemplate` resolves the stored nodeKey to the referenced EARLIER step's localId in a
  // post-pass over the ordered chain.
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
  } else if (source?.kind === 'prior_node_approver') {
    // Lock-1 §K3: the stored nodeKey → step-localId resolution happens in draftFromTemplate's
    // post-pass (see priorStepLocalId's field doc for why the draft carries a localId reference).
    sourceKind = 'prior_node_approver'
  } else if (source?.kind === 'user_group') {
    // Lock-1 §K1: dedicated array field — a group option list, never the shared idsText carrier.
    sourceKind = 'user_group'
    groupIds = [...source.groupIds]
  } else if (source?.kind === 'form_field_user_manager' || source?.kind === 'form_field_user_dept_head') {
    // Lock-2 §L2-C: field picker + single level — reuses the shared `fieldId` AND `level` fields
    // (they coexist on the draft; each is meaningful only for the kinds that read it).
    sourceKind = source.kind
    fieldId = source.fieldId
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

  // T1-4: hydrate node-level field permissions. Only well-formed { fieldId, access-in-enum } entries
  // are carried; a malformed entry is separately caught by `unsupportedTemplateAuthoringReason`
  // (fail-closed read-only) so it is never silently re-saved.
  const fieldPermissions = Array.isArray(config.fieldPermissions)
    ? config.fieldPermissions
        .filter((entry): entry is NodeFieldPermission => !isBackendDroppedFieldPermission(entry))
        .map((entry) => ({ fieldId: entry.fieldId, access: entry.access }))
    : []

  // P1-C (master lock §P1-C): the out-of-union coercion branch is DELETED — this used to map any
  // defined-but-unrecognized `approvalMode` to `'single'`, which is exactly the silent 会签→单人审批
  // downgrade the lock's deletion clause exists to make impossible. `unsupportedTemplateAuthoringReason`
  // (:1071-1076 below) is the SINGLE door for a defined-but-out-of-union `approvalMode`: it forces the
  // whole template read-only and blocks `persistDraft`, so this line never re-decides that question.
  // Hydration therefore preserves whatever was persisted verbatim (no substitution); only a genuinely
  // ABSENT `approvalMode` takes the documented single-approver default.
  const approvalMode: ApprovalMode =
    config.approvalMode === undefined ? 'single' : (config.approvalMode as ApprovalMode)
  const approvalThreshold =
    Number.isInteger(config.approvalThreshold) && (config.approvalThreshold as number) >= 1
      ? (config.approvalThreshold as number)
      : 1

  // P1-C: hydrate node-level timeout. Shape is already gated by `unsupportedTemplateAuthoringReason`
  // (`timeoutConfigHasBackendDrop`), so every field read here is well-typed.
  const timeout = config.timeout as
    | { afterMinutes: number; effect: string; transferToUserId?: string; jumpToNodeKey?: string; unit?: 'business' }
    | undefined
  const timeoutEnabled = timeout !== undefined
  const timeoutAfterMinutesText = timeout ? String(timeout.afterMinutes) : ''
  const timeoutEffect: ApprovalStepDraft['timeoutEffect'] =
    timeout && (NODE_TIMEOUT_SUPPORTED_EFFECTS as readonly string[]).includes(timeout.effect)
      ? (timeout.effect as SupportedNodeTimeoutEffect)
      : ''
  const timeoutTransferToUserId = timeout?.transferToUserId ?? ''
  // Resolved to the target step's `localId` in a second pass by `draftFromTemplate` (this function
  // has no visibility into sibling steps' generated localIds) — left '' here regardless of a raw
  // `jumpToNodeKey` being present, and fixed up by the caller.
  const timeoutJumpToStepLocalId = ''
  const timeoutUnit: ApprovalStepDraft['timeoutUnit'] = timeout?.unit === 'business' ? 'business' : ''

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
    priorStepLocalId: '',
    groupIds,
    approvalMode,
    approvalThreshold,
    // Fix-round P1-1 / P3-2 (gate P3A-F4B-20260819, master M4): the out-of-union coercion to
    // `'error'` is DELETED — this used to map `'designated'` (and any future value) to `'error'`,
    // exactly the silent downgrade M4's no-flatten clause exists to make impossible (the same
    // deletion `approvalMode` above already went through). `unsupportedTemplateAuthoringReason`'s
    // `emptyAssigneePolicy` out-of-union check is the SINGLE door for a genuinely unrecognised
    // value: it forces the whole template read-only and blocks `persistDraft`, so this line never
    // re-decides that question. Hydration therefore preserves whatever was persisted verbatim; only
    // a genuinely ABSENT `emptyAssigneePolicy` takes the documented `'error'` default.
    emptyAssigneePolicy: config.emptyAssigneePolicy === undefined ? 'error' : (config.emptyAssigneePolicy as EmptyAssigneePolicy),
    mergeWithRequester,
    ...(autoApprovalPolicy ? { originalAutoApprovalPolicy: autoApprovalPolicy } : {}),
    fieldPermissions,
    timeoutEnabled,
    timeoutAfterMinutesText,
    timeoutEffect,
    timeoutTransferToUserId,
    timeoutJumpToStepLocalId,
    timeoutUnit,
    // Lock-5 §1.1: stash the persisted 操作权限 object so `buildStepConfig` re-emits it verbatim.
    // A malformed shape is separately caught by `unsupportedTemplateAuthoringReason` (fail-closed
    // read-only, so save is blocked) — this hydrate never repairs or flattens it.
    ...(config.nodeOperationPolicy !== undefined
      ? { nodeOperationPolicy: config.nodeOperationPolicy as NodeOperationPolicy }
      : {}),
    // Fix-round P1-1 — stash the persisted `'designated'` target set so `buildStepConfig` re-emits
    // it verbatim (same rationale as `nodeOperationPolicy` immediately above).
    ...(config.emptyAssigneeFallback !== undefined
      ? { emptyAssigneeFallback: config.emptyAssigneeFallback as EmptyAssigneeFallback }
      : {}),
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
// (ApprovalProductService.ts:2331-2346). Any other key — TOP-LEVEL or NESTED — is silently dropped on
// save. NB: this is the COMPLEX path's allowlist ONLY — the linear path (`buildStepConfig`) has its
// OWN separate allowlist (`allowedConfigKeys`, below), because the two paths author + re-emit
// `fieldPermissions` / `approvalThreshold` / `timeout` through DIFFERENT code (one projects
// `ApprovalStepDraft` -> config, the other composes `ApprovalNodeSourceEdit` onto a preserved config)
// — sharing one allowlist between them would let a key one path can't actually represent through as
// if it round-trips, then silently flatten it on THAT path's save.
//
// P1-C CORRECTION (approval-parity-master-design-lock-20260817.md §P1-C): earlier revisions of this
// comment claimed the backend "silently drops" `approvalThreshold`/`timeout` on a complex graph — that
// was never true. `normalizeApprovalGraph`'s per-node-type switch has ONE `case 'approval':` branch
// (ApprovalProductService.ts :2256-2347) that runs identically regardless of the graph's overall
// topology; it re-emits both keys (:2339-2340, :2344) for EVERY approval node, complex or linear. The
// two keys were simply ABSENT from this allowlist, which forced every carrying template fully
// read-only (I12/I13) rather than actually losing data on save — this slice adds them (with the
// matching nested-shape checks below) now that the FE can represent + preserve them honestly.
const BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS = [
  'assigneeType',
  'assigneeIds',
  'assigneeSources',
  'approvalMode',
  'approvalThreshold',
  'emptyAssigneePolicy',
  // Fix-round P1-1 (gate P3A-F4B-20260819, Lock-4 §3 F4-B / §2.3) — allowlist 2 of 4. The backend
  // approval-node rebuild re-emits `emptyAssigneeFallback` (ApprovalProductService.ts, the
  // `case 'approval'` spread — landed as "allowlist 1 of 4" in the same PR that introduced the
  // key), so a template carrying it must stay EDITABLE rather than being forced read-only by the
  // drop-check below. All four allowlists move in ONE slice or the key inherits
  // `signaturePolicy`'s live state (read-only in both editors) — gate A-3's positive control
  // (reused below) is precisely that `signaturePolicy` STILL goes read-only here, proving the
  // guard was widened for this key and not removed. The NESTED shape check lives in
  // `emptyAssigneeFallbackHasBackendDrop` below (§2.3: "a widened enum and a new config key … the
  // nested shape needs its own key list").
  'emptyAssigneeFallback',
  'autoApprovalPolicy',
  'fieldPermissions',
  'timeout',
  // Lock-5 §1.1 / §2.2 — allowlist 2 of 4. The backend approval-node rebuild re-emits
  // `nodeOperationPolicy` (ApprovalProductService.ts, the `case 'approval'` spread), so a template
  // carrying it must stay EDITABLE rather than being forced read-only by the drop-check below. All
  // four allowlists move in ONE slice or the key inherits `signaturePolicy`'s live state (read-only
  // in both editors) — gate A-3, whose positive control is precisely that `signaturePolicy` STILL
  // goes read-only here, proving the guard was widened for this key and not removed.
  'nodeOperationPolicy',
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
  // Lock-1 §K3: flat 2-level shape — the referenced prior node's key.
  prior_node_approver: ['kind', 'nodeKey'],
  form_field_user: ['kind', 'fieldId'],
  // Lock-2 §L2-C: flat 3-key shape (field picker + single level).
  form_field_user_manager: ['kind', 'fieldId', 'level'],
  form_field_user_dept_head: ['kind', 'fieldId', 'level'],
  // Lock-1 §K2: `scope` is the ONE nested object in the source union (see
  // requesterChoiceSourceHasBackendDrop below for its per-type key check — the flat 2-level
  // allowlist alone cannot see inside it).
  requester_choice: ['kind', 'mode', 'scope'],
  // Lock-1 §K1: flat 2-level shape — a non-empty array of bound group ids.
  user_group: ['kind', 'groupIds'],
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
// Fix-round P1-1 (gate P3A-F4B-20260819, Lock-4 §3 F4-B / §2.3) — the nested key list beside
// `BACKEND_AUTO_APPROVAL_POLICY_KEYS`: the backend `normalizeEmptyAssigneeFallback`
// (ApprovalProductService.ts) rebuilds this object from a fixed sub-key set and REJECTS (400) any
// other sub-key — same posture as `requesterChoiceSourceHasBackendDrop` above: a shape the backend
// will not re-emit verbatim must still force read-only here, never silently flatten on save.
const BACKEND_EMPTY_ASSIGNEE_FALLBACK_KEYS = ['userIds', 'roleIds']

function emptyAssigneeFallbackHasBackendDrop(value: unknown): boolean {
  if (!isPlainRecord(value)) return true
  if (hasKeyOutside(value, BACKEND_EMPTY_ASSIGNEE_FALLBACK_KEYS)) return true
  if (value.userIds !== undefined && !Array.isArray(value.userIds)) return true
  if (value.roleIds !== undefined && !Array.isArray(value.roleIds)) return true
  return false
}
const BACKEND_AUTO_APPROVAL_POLICY_KEYS = ['mergeWithRequester', 'mergeAdjacentApprover', 'dedupeHistoricalApprover', 'actorMode']
const BACKEND_FIELD_PERMISSION_KEYS = ['fieldId', 'access']
// Lock-5 §1.1 / §2.2 — allowlist 4 of 4 (the NESTED one, beside BACKEND_AUTO_APPROVAL_POLICY_KEYS).
// `nodeOperationPolicy` is an OBJECT, so a top-level allowlist entry alone is incomplete: the
// backend `normalizeNodeOperationPolicy` rebuilds it from a fixed sub-key set and REJECTS (400) any
// other sub-key. On the FE the posture is the same either way — a shape the backend will not re-emit
// verbatim must force read-only, never silently flatten on save.
//
// NOTE the asymmetry with the backend, and why it is correct: the backend admits only
// `allowTransfer` + `commentRequired` on a HANDLER node (§1.6 / OD-L5-11(a)); that narrowing is
// carried by BACKEND_HANDLER_NODE_OPERATION_POLICY_KEYS below, not by this approval-node list.
const BACKEND_NODE_OPERATION_POLICY_KEYS = [
  'allowTransfer',
  'allowAddSign',
  'allowReduceSign',
  'allowReturn',
  'returnReviewMode',
  'commentRequired',
]
const BACKEND_HANDLER_NODE_OPERATION_POLICY_KEYS = ['allowTransfer', 'commentRequired']
const BACKEND_RETURN_REVIEW_MODES = ['resume_forward', 'jump_back_to_current']
const BACKEND_COMMENT_REQUIRED_VALUES = ['never', 'reject_only', 'always']

/**
 * Lock-5 §1.1 — true when a `nodeOperationPolicy` value is one the backend normalizer would REJECT
 * or not re-emit verbatim: a non-object, an unknown sub-key, a non-boolean switch, an out-of-enum
 * `returnReviewMode`/`commentRequired`, or (the emptiness rule) an object with no field at all,
 * which the backend OMITS rather than persisting as `{}`. Any of those makes the FE's verbatim
 * round-trip differ from the real save, so fail closed to read-only.
 */
function nodeOperationPolicyHasBackendDrop(value: unknown, allowedKeys: string[]): boolean {
  if (!isPlainRecord(value)) return true
  if (hasKeyOutside(value, allowedKeys)) return true
  if (Object.keys(value).length === 0) return true
  for (const key of ['allowTransfer', 'allowAddSign', 'allowReduceSign', 'allowReturn']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return true
  }
  if (value.returnReviewMode !== undefined && !BACKEND_RETURN_REVIEW_MODES.includes(value.returnReviewMode as string)) {
    return true
  }
  if (value.commentRequired !== undefined && !BACKEND_COMMENT_REQUIRED_VALUES.includes(value.commentRequired as string)) {
    return true
  }
  return false
}

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

// P1-C: the exact set of keys backend `normalizeNodeTimeout` re-emits on a `timeout` object
// (ApprovalProductService.ts :1468-1493) — SHAPE, not the (separate) VALIDITY rules
// `validateNodeTimeoutConfigs` layers on top. Deliberately mirrors normalize, not validate: the two
// disagree on `unit` (validate ACCEPTS `unit: 'wall_clock'` as input; normalize only ever EMITS
// `unit: 'business'`, silently dropping an explicit `'wall_clock'` back to the omitted default) — a
// byte-faithful "would this round-trip identically" check must follow the emitter, not the acceptor.
const BACKEND_NODE_TIMEOUT_CONFIG_KEYS = ['afterMinutes', 'effect', 'transferToUserId', 'jumpToNodeKey', 'unit']

/**
 * True when a persisted `timeout` value is NOT exactly the shape backend `normalizeNodeTimeout` would
 * re-emit — an extra/missing-typed key, OR `unit` carrying anything other than the literal
 * `'business'` (a stored `'wall_clock'` never happens; normalize omits the key for that default). Used
 * by BOTH the complex-path and linear-path backend-drop gates (§P1-C — one shared shape check; the two
 * TOP-LEVEL key allowlists stay separate, see the comment on `BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS`).
 */
function timeoutConfigHasBackendDrop(value: unknown): boolean {
  if (!isPlainRecord(value)) return true
  if (hasKeyOutside(value, BACKEND_NODE_TIMEOUT_CONFIG_KEYS)) return true
  if (typeof value.afterMinutes !== 'number') return true
  if (typeof value.effect !== 'string') return true
  if (value.transferToUserId !== undefined && typeof value.transferToUserId !== 'string') return true
  if (value.jumpToNodeKey !== undefined && typeof value.jumpToNodeKey !== 'string') return true
  if (value.unit !== undefined && value.unit !== 'business') return true
  return false
}

/**
 * P1-C: a `config.approvalThreshold` that survives on a node whose `approvalMode` is NOT `'threshold'`
 * is a backend-drop shape — `normalizeApprovalGraph` assigns `approvalThreshold` exclusively inside
 * the `approvalMode === 'threshold'` branch (ApprovalProductService.ts :2281-2305) and omits it
 * otherwise (:2340), so this combination can never come from a real save and must fail closed rather
 * than be silently carried or dropped.
 */
function thresholdConfigHasBackendDrop(config: Record<string, unknown>): boolean {
  return config.approvalThreshold !== undefined && config.approvalMode !== 'threshold'
}

/**
 * True when a COMPLEX approval node's config carries a key — TOP-LEVEL or NESTED in assigneeSources[]
 * / autoApprovalPolicy / fieldPermissions[] / timeout — that the backend `normalizeApprovalGraph` does
 * NOT re-emit (and silently DROPS on save). The FE preserves config verbatim, so without this the
 * deep-equal round-trip looks clean while the real save flattens the unknown key.
 */
function complexApprovalConfigHasBackendDrop(config: Record<string, unknown>): boolean {
  if (hasKeyOutside(config, BACKEND_PRESERVED_COMPLEX_APPROVAL_CONFIG_KEYS)) return true
  if (thresholdConfigHasBackendDrop(config)) return true
  if (config.timeout !== undefined && timeoutConfigHasBackendDrop(config.timeout)) return true
  // Fix-round P1-1 (gate P3A-F4B-20260819) — allowlist 4 of 4, the nested shape check for the key
  // added to allowlist 2 above.
  if (config.emptyAssigneeFallback !== undefined && emptyAssigneeFallbackHasBackendDrop(config.emptyAssigneeFallback)) return true
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
  // Lock-5 §1.1: the nested object shape-check (allowlist 4 of 4).
  if (
    config.nodeOperationPolicy !== undefined
    && nodeOperationPolicyHasBackendDrop(config.nodeOperationPolicy, BACKEND_NODE_OPERATION_POLICY_KEYS)
  ) {
    return true
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
// Lock-5 §1.6: `nodeOperationPolicy` joins the handler allowlist (narrowed sub-key set, checked
// separately in `complexNodeConfigHasBackendDrop` below).
const BACKEND_HANDLER_CONFIG_KEYS = ['assigneeSources', 'handlerMode', 'opinionRequired', 'fieldPermissions', 'nodeOperationPolicy']
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
      // Lock-5 §1.6: plus the NARROWED nodeOperationPolicy sub-key set — a handler carrying
      // allowAddSign/allowReduceSign/allowReturn is rejected 400 by the backend authoring choke, so
      // it must be read-only here rather than looking editable and failing at save.
      return hasKeyOutside(config, BACKEND_HANDLER_CONFIG_KEYS)
        || (config.nodeOperationPolicy !== undefined
          && nodeOperationPolicyHasBackendDrop(config.nodeOperationPolicy, BACKEND_HANDLER_NODE_OPERATION_POLICY_KEYS))
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
      // P1-C: `approvalThreshold`/`timeout` are now authored + preserved by the linear path
      // (buildStepConfig / stepDraftFromApprovalNode), so they are no longer unknown config keys
      // that would force the whole template read-only (master §P1-C I12/I13 no-flatten).
      'approvalThreshold',
      'emptyAssigneePolicy',
      // Fix-round P1-1 (gate P3A-F4B-20260819, Lock-4 §3 F4-B / §2.3) — allowlist 3 of 4. The
      // linear editor does NOT author `emptyAssigneeFallback` (no typed userIds/roleIds picker
      // ships in this fix round), but gate X-2's bar is "stays EDITABLE", not merely "round-trips
      // safely". `stepDraftFromApprovalNode` / `buildStepConfig` re-emit it VERBATIM (the
      // `nodeOperationPolicy` preserve-verbatim pattern immediately below), so this allowlist
      // entry does not by itself risk a silent flatten.
      'emptyAssigneeFallback',
      'autoApprovalPolicy',
      // T1-4: `fieldPermissions` is now authored + preserved by the linear path (buildStepConfig),
      // so it is no longer an unknown config key that would force the whole template read-only.
      'fieldPermissions',
      'timeout',
      // Lock-5 §1.1 / §2.2 — allowlist 3 of 4. The linear ("辅助编辑模式") editor does NOT author
      // `nodeOperationPolicy` (the `操作权限` tab is a CANVAS-inspector surface), but A-3's bar is
      // "stays EDITABLE", not merely "round-trips safely": a linear template carrying the key must
      // stay editable. That obliges `buildStepConfig` to re-emit it VERBATIM from
      // `ApprovalStepDraft.nodeOperationPolicy` — the `originalAutoApprovalPolicy` preserve-verbatim
      // pattern — or save would silently flatten it, which is exactly what this allowlist entry
      // would otherwise permit.
      'nodeOperationPolicy',
    ]
    if (Object.keys(config).some((key) => !allowedConfigKeys.includes(key))) return true
    // P1-C: `approvalMode` itself must be a KNOWN value — the key-only check above can't see this.
    // An out-of-union value can never come from a real save (backend authoring `normalizeApprovalMode`
    // `failValidation`s any value outside single/all/any/threshold, ApprovalProductService.ts :570),
    // so this must fail closed here — this check IS the single door: `stepDraftFromApprovalNode` no
    // longer coerces an out-of-union value to 'single', it preserves it verbatim, and this reason
    // string is what blocks `persistDraft` from ever re-saving it.
    if (
      config.approvalMode !== undefined
      && !['single', 'all', 'any', 'threshold'].includes(config.approvalMode as string)
    ) return true
    if (thresholdConfigHasBackendDrop(config)) return true
    if (config.approvalMode === 'threshold' && !(Number.isInteger(config.approvalThreshold) && (config.approvalThreshold as number) >= 1)) return true
    // Fix-round P1-1 / P3-2 (gate P3A-F4B-20260819, master M4 "no silent flatten of an unknown
    // persisted value") — mirrors the `approvalMode` check immediately above. `'designated'` is now
    // a KNOWN value (`stepDraftFromApprovalNode` preserves it verbatim, never coercing it to
    // `'error'`), so only a genuinely off-enum value fails closed to read-only here.
    if (
      config.emptyAssigneePolicy !== undefined
      && !['error', 'auto-approve', 'designated'].includes(config.emptyAssigneePolicy as string)
    ) return true
    // Fix-round P1-1 — the linear-path counterpart of `emptyAssigneeFallbackHasBackendDrop` above
    // (same predicate, reused rather than duplicated).
    if (config.emptyAssigneeFallback !== undefined && emptyAssigneeFallbackHasBackendDrop(config.emptyAssigneeFallback)) return true
    if (config.timeout !== undefined && timeoutConfigHasBackendDrop(config.timeout)) return true
    // The linear path preserves the object verbatim, so a shape the backend would reject or
    // re-emit differently must still fail closed to read-only (same predicate as the complex path).
    if (
      config.nodeOperationPolicy !== undefined
      && nodeOperationPolicyHasBackendDrop(config.nodeOperationPolicy, BACKEND_NODE_OPERATION_POLICY_KEYS)
    ) {
      return true
    }
    const sources = config.assigneeSources
    if (sources !== undefined) {
      if (!Array.isArray(sources) || sources.length !== 1) return true
      const source = sources[0] as ApprovalAssigneeSource
      if (!['static_user', 'static_role', 'requester', 'form_field_user', 'direct_manager', 'dept_head', 'continuous_managers', 'manager_at_level', 'requester_choice', 'continuous_dept_heads', 'dept_head_at_level', 'prior_node_approver', 'user_group', 'form_field_user_manager', 'form_field_user_dept_head'].includes(source?.kind)) return true
      // Lock-1 §K2: a malformed requester_choice shape must fail-closed to read-only here too —
      // hydrate would otherwise re-derive a default mode/scope and silently flatten it on save.
      if (source?.kind === 'requester_choice' && requesterChoiceSourceHasBackendDrop(source as unknown as Record<string, unknown>)) return true
      // Lock-1 §K3: a prior_node_approver whose nodeKey is NOT an earlier approval node of this
      // ordered linear chain (dangling / self / downstream) must fail-closed to read-only —
      // hydrate's post-pass could not resolve it to a step-localId, so a re-save through the
      // linear builder would silently emit an empty/retargeted reference. (The backend publish
      // dominance gate is the arbiter; this only refuses to EDIT what the linear model cannot
      // faithfully carry.)
      if (source?.kind === 'prior_node_approver') {
        const priorApprovalKeys = ordered
          .slice(0, ordered.indexOf(node))
          .filter((candidate) => candidate.type === 'approval')
          .map((candidate) => candidate.key)
        if (!priorApprovalKeys.includes(source.nodeKey)) return true
      }
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
  if (!complex) {
    // P1-C: second pass — resolve each step's `timeout.jumpToNodeKey` (a persisted node key) to the
    // TARGET step's freshly-generated `localId`. Needs every step's localId assigned first (done
    // above), so this can't happen inside `stepDraftFromApprovalNode` itself, which sees one node at
    // a time. `orderedApprovalNodes[i]` and `steps[i]` are 1:1 — `ordered` is filtered to exactly the
    // approval nodes that produced a non-null step, in the same relative order.
    const orderedApprovalNodes = ordered.filter((node) => node.type === 'approval')
    const nodeKeyToLocalId = new Map(orderedApprovalNodes.map((node, index) => [node.key, steps[index]?.localId]))
    orderedApprovalNodes.forEach((node, index) => {
      const jumpToNodeKey = (node.config as { timeout?: { jumpToNodeKey?: string } }).timeout?.jumpToNodeKey
      if (!jumpToNodeKey) return
      const step = steps[index]
      const targetLocalId = nodeKeyToLocalId.get(jumpToNodeKey)
      if (step && targetLocalId) step.timeoutJumpToStepLocalId = targetLocalId
    })
  }

  // Lock-1 §K3 post-pass: resolve each stored `prior_node_approver` nodeKey into the referenced
  // EARLIER step's localId (steps[i] ↔ the i-th approval node of the ordered linear chain). The
  // localId reference — not the raw key — is what the draft carries, so inserting/reordering
  // steps can never silently retarget the reference (the builder re-emits the referenced step's
  // CURRENT positional key). A reference that does not resolve to an earlier approval node stays
  // '' — `unsupportedTemplateAuthoringReason` already forces such a template read-only (save
  // disabled), so the '' default is unreachable on an editable draft.
  if (!complex) {
    const orderedApprovalNodes = ordered.filter((node) => node.type === 'approval')
    orderedApprovalNodes.forEach((node, index) => {
      const step = steps[index]
      if (!step || step.sourceKind !== 'prior_node_approver') return
      const config = node.config as Record<string, unknown>
      const source = Array.isArray(config.assigneeSources)
        ? config.assigneeSources[0] as ApprovalAssigneeSource | undefined
        : undefined
      if (source?.kind !== 'prior_node_approver') return
      const referencedIndex = orderedApprovalNodes.findIndex((candidate) => candidate.key === source.nodeKey)
      if (referencedIndex >= 0 && referencedIndex < index) {
        step.priorStepLocalId = steps[referencedIndex].localId
      }
    })
  }

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
    // P3-B / Lock-6 L6-A — projects the hydrated `policy.autoApproval` onto the 3-way tier. Reads
    // `template.policy?.autoApproval` (not `originalPolicy` above, though they are the same value)
    // for clarity that this is a pure function of the persisted definition, matching
    // `templateDedupTierFromPolicy`'s own signature.
    autoApprovalDedupTier: templateDedupTierFromPolicy(template.policy?.autoApproval),
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
      // Lock-8 L8-A (§1.1, OD-L8-2, A-1): explanation is DISPLAY-ONLY — force `required: false` and
      // strip `placeholder`/`defaultValue` regardless of what the draft or `original` spread carries.
      // `required`/`placeholder` are set UNCONDITIONALLY above from the draft (an author who toggled
      // 必填 before retyping AWAY... into explanation would otherwise still emit `required: true`);
      // `defaultValue` is never deleted anywhere else in this function — it only ever survives via
      // the `original` spread (a field retyped FROM a type that had one). None of the three may leak
      // through a retype. `options` is already handled by the non-select/multi-select delete below.
      if (field.type === 'explanation') {
        next.required = false
        delete next.placeholder
        delete next.defaultValue
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
      } else if (field.type === 'explanation') {
        // L8-A (§1.1, OD-L8-3(a)): a BRAND NEW type — same discipline as date_range, props built
        // fresh (never spreading `next.props`/`original`). `text` has no absent-default: an
        // unwritten draft emits an empty string, and publish's non-blank check rejects it rather
        // than the client silently picking a placeholder body.
        next.props = { text: field.explanationText.trim() }
      } else if (next.props && typeof next.props === 'object') {
        // Drop record-link pins + L8-C display keys + L8-B date_range keys + L8-A explanation
        // text when type changes away; keep other type-specific props only if still meaningful (do
        // not leave baseId/sheetId, a formatted-number display flag, a date_range prop, or a stale
        // explanation body on a field retyped to something else).
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
        delete props.text
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
 * re-deriving a second sourceKind→text switch that could drift from this one.
 *
 * Lock-1 §K3: `allSteps` (the draft's full ordered step list) is needed ONLY by
 * `prior_node_approver` — the emitted `nodeKey` is the referenced step's CURRENT positional key
 * (`approval_${index+1}`, the linear builder's own key scheme), derived from the step-localId
 * reference at build time so insert/reorder can never silently retarget it. Callers without the
 * list (none in-repo) would emit an empty `nodeKey`, which both the FE validation and the backend
 * normalize choke reject — fail-closed, never a silently-wrong reference. */
export function sourceFromStep(step: ApprovalStepDraft, allSteps?: ApprovalStepDraft[]): ApprovalAssigneeSource {
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
  if (step.sourceKind === 'form_field_user_manager' || step.sourceKind === 'form_field_user_dept_head') {
    // Lock-2 §L2-C: reuses the shared `fieldId` + `level` fields (field picker + single level).
    return { kind: step.sourceKind, fieldId: step.fieldId, level: step.level }
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
  if (step.sourceKind === 'prior_node_approver') {
    // Lock-1 §K3: emit the referenced step's CURRENT positional key (see the docstring). An
    // unresolved reference (missing localId / referenced step deleted or not EARLIER than this
    // one) emits '' — rejected by validateTemplateApprovalFlow and by the backend normalize
    // choke, never silently pointed elsewhere.
    const stepIndex = allSteps?.findIndex((candidate) => candidate.localId === step.localId) ?? -1
    const referencedIndex = allSteps?.findIndex((candidate) => candidate.localId === step.priorStepLocalId) ?? -1
    const nodeKey = referencedIndex >= 0 && stepIndex >= 0 && referencedIndex < stepIndex
      ? `approval_${referencedIndex + 1}`
      : ''
    return { kind: 'prior_node_approver', nodeKey }
  }
  if (step.sourceKind === 'user_group') {
    // Lock-1 §K1: dedicated `groupIds` array, from the typed bound-group picker.
    return { kind: 'user_group', groupIds: [...step.groupIds] }
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
/**
 * P1-C: build the `timeout` config for a step, or `undefined` when disabled/incomplete. Mirrors
 * backend `normalizeNodeTimeout`'s emit shape exactly (`timeoutConfigHasBackendDrop`'s allowlist) —
 * only the target field matching the chosen effect is included, `unit` is omitted for the wall-clock
 * default. `stepLocalIdToNodeKey` resolves the draft's stable `localId` jump reference to the
 * position-based node key `buildApprovalGraph` assigns this build (steps can reorder between saves).
 * Returns `undefined` (never a half-filled object) when a required field for the chosen effect is
 * still blank — `validateTemplateApprovalFlow` blocks save on that same incompleteness, so this is a
 * defensive "never emit a shape the backend would 400 on" floor, not the primary UX validation.
 */
function buildStepTimeoutConfig(
  step: ApprovalStepDraft,
  stepLocalIdToNodeKey: Map<string, string>,
): NodeTimeoutConfig | undefined {
  if (!step.timeoutEnabled) return undefined
  const afterMinutes = Number(step.timeoutAfterMinutesText.trim())
  if (!Number.isInteger(afterMinutes) || afterMinutes <= 0) return undefined
  if (!step.timeoutEffect) return undefined
  const effect: NodeTimeoutEffect = step.timeoutEffect
  if (effect === 'transfer') {
    const transferToUserId = step.timeoutTransferToUserId.trim()
    if (!transferToUserId) return undefined
    return {
      afterMinutes,
      effect,
      transferToUserId,
      ...(step.timeoutUnit === 'business' ? { unit: 'business' as const } : {}),
    }
  }
  if (effect === 'jump') {
    const jumpToNodeKey = stepLocalIdToNodeKey.get(step.timeoutJumpToStepLocalId)
    if (!jumpToNodeKey) return undefined
    return {
      afterMinutes,
      effect,
      jumpToNodeKey,
      ...(step.timeoutUnit === 'business' ? { unit: 'business' as const } : {}),
    }
  }
  // 'remind' — no target field.
  return {
    afterMinutes,
    effect,
    ...(step.timeoutUnit === 'business' ? { unit: 'business' as const } : {}),
  }
}

// P1-C rebase (K3 + P1-C unification): `buildStepConfig` needs TWO distinct localId resolutions —
// K3's `prior_node_approver` source (via `allSteps`, `sourceFromStep` below — requires the referenced
// step be STRICTLY EARLIER, an ordering check `allSteps` supplies) and P1-C's timeout jump target (via
// `stepLocalIdToNodeKey`, no ordering constraint — a jump may target any node). Both are threaded
// through rather than collapsed into one map: `stepLocalIdToNodeKey` alone cannot express "earlier
// than the current step" without re-deriving positions from its `approval_${index+1}` values, and
// `sourceFromStep` is an exported function also called directly by `linearStepSpine.ts`, so its
// existing `allSteps?: ApprovalStepDraft[]` contract is left untouched here.
function buildStepConfig(
  step: ApprovalStepDraft,
  fieldIds: Set<string>,
  allSteps: ApprovalStepDraft[],
  stepLocalIdToNodeKey: Map<string, string>,
): ApprovalNodeConfig {
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
  const timeout = buildStepTimeoutConfig(step, stepLocalIdToNodeKey)
  // Lock-5 §1.1: re-emit the preserved 操作权限 object VERBATIM (a fresh deep copy so the emitted
  // graph never aliases the reactive draft). The linear editor authors nothing here; omitting the
  // key when absent keeps every pre-Lock-5 linear template byte-identical.
  const nodeOperationPolicy = step.nodeOperationPolicy
    ? (JSON.parse(JSON.stringify(step.nodeOperationPolicy)) as NodeOperationPolicy)
    : undefined
  // Fix-round P1-1 — re-emit the preserved `'designated'` target set VERBATIM (fresh deep copy,
  // same discipline as `nodeOperationPolicy` immediately above).
  const emptyAssigneeFallback = step.emptyAssigneeFallback
    ? (JSON.parse(JSON.stringify(step.emptyAssigneeFallback)) as EmptyAssigneeFallback)
    : undefined
  return {
    assigneeSources: [sourceFromStep(step, allSteps)],
    approvalMode: step.approvalMode,
    // P1-C: `approvalThreshold` is emitted ONLY under `approvalMode === 'threshold'` — mirrors the
    // backend's own conditional emission (`thresholdConfigHasBackendDrop`'s invariant) so switching
    // mode away never leaves an orphaned threshold key behind.
    ...(step.approvalMode === 'threshold' ? { approvalThreshold: step.approvalThreshold } : {}),
    emptyAssigneePolicy: step.emptyAssigneePolicy,
    // Fix-round advisor catch (post-P1-1): emitted ONLY under `emptyAssigneePolicy === 'designated'`
    // — mirrors `approvalThreshold`'s own conditional emission immediately above. The 空审批人策略
    // `<el-select>` (TemplateAuthoringView.vue) offers only 报错/自动通过 as options but is bound
    // directly to `step.emptyAssigneePolicy`, which P1-1 now preserves as `'designated'` verbatim;
    // an author switching a designated node's select to either option must not leave an orphaned
    // `emptyAssigneeFallback` behind — P2-3's own validator would then 400 the save on a key no
    // linear UI can see or clear.
    ...(step.emptyAssigneePolicy === 'designated' && emptyAssigneeFallback ? { emptyAssigneeFallback } : {}),
    ...(Object.keys(autoApprovalPolicy).length > 0 ? { autoApprovalPolicy } : {}),
    ...(fieldPermissions.length > 0 ? { fieldPermissions } : {}),
    ...(timeout ? { timeout } : {}),
    ...(nodeOperationPolicy ? { nodeOperationPolicy } : {}),
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
  // P1-C: node keys are positional (`approval_${index+1}`) and are reassigned on every build — a
  // step's stable draft identity is its `localId`. Resolve jump targets through this map so a
  // `timeout.jumpToNodeKey` referencing a step that has since MOVED still lands on the right node.
  const stepLocalIdToNodeKey = new Map(draft.steps.map((step, index) => [step.localId, `approval_${index + 1}`]))
  const approvalNodes = draft.steps.map((step, index) => ({
    key: `approval_${index + 1}`,
    type: 'approval' as const,
    name: step.name.trim() || `审批人 ${index + 1}`,
    // Lock-1 §K3: the full step list rides along so a prior_node_approver step can emit its
    // referenced step's CURRENT positional key (localId reference → key at build time), enforcing
    // strict-earlier ordering. P1-C: `stepLocalIdToNodeKey` rides along too, for the (unordered)
    // timeout jump-target resolution — see `buildStepConfig`'s doc comment for why both are threaded
    // through rather than collapsed into one map.
    config: buildStepConfig(step, fieldIds, draft.steps, stepLocalIdToNodeKey),
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
    // P1-C: linear-only fail-closed — a preserved complex graph CAN mix parallel regions with plain
    // sequential ones, so gate threshold/timeout per-node against the FE mirror of the backend's
    // exact region definition. `draft.preservedGraph` is always present alongside `approvalNodeEdits`
    // (both seeded together, `draftFromEditedGraph`/`draftFromTemplate`'s `complex` branch).
    const parallelRegionNodeKeys = draft.preservedGraph
      ? collectParallelRegionNodeKeys(draft.preservedGraph)
      : new Set<string>()
    // fix-round P2-1: the FE mirror of backend `timeout.jumpToNodeKey references unknown node` /
    // `must target an approval node` — an edited graph (e.g. deleting a node the timeout jump still
    // points at) must not pass this preview with a dangling target.
    // `undefined` (not an empty Set) when there is no preserved graph to derive one from: per
    // `validateApprovalNodeEdits`'s own optional-param contract, omitted ⇒ skip the check, matching
    // `fields` above. An empty Set would invert that — "no approval nodes exist" — and reject every
    // jump target on a branch this code path never actually reaches in practice (`approvalNodeEdits`
    // is only ever populated alongside `preservedGraph`, see the comment above), but shipping the
    // wrong failure mode on an unreachable branch is still worth avoiding.
    const approvalNodeKeys = draft.preservedGraph
      ? new Set(draft.preservedGraph.nodes.filter((node) => node.type === 'approval').map((node) => node.key))
      : undefined
    errors.push(...validateApprovalNodeEdits(draft.approvalNodeEdits, draft.fields, parallelRegionNodeKeys, approvalNodeKeys))
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
    // Lock-1 §K3 PREVIEW (the backend publish dominance gate is the final arbiter): the
    // referenced step must exist and be STRICTLY EARLIER than this one — a missing choice, a
    // deleted referenced step, a self-reference, or a reference that ended up at/after this step
    // via reorder all fail here (matching what `sourceFromStep` would emit as an empty nodeKey).
    if (step.sourceKind === 'prior_node_approver') {
      const referencedIndex = draft.steps.findIndex((candidate) => candidate.localId === step.priorStepLocalId)
      if (referencedIndex < 0 || referencedIndex >= index) {
        errors.push(`${label} 需要引用一个位于其之前的审批步骤作为节点审批人`)
      }
    }
    // Lock-1 §K1 PREVIEW (backend normalize's non-empty-array check is the final arbiter): a
    // user_group source needs at least one bound group selected — mirrors the static_user/
    // static_role empty check above.
    if (step.sourceKind === 'user_group' && step.groupIds.length === 0) {
      errors.push(`${label} 需要选择至少一个用户组`)
    }
    // P1-C (T2-4) threshold PREVIEW: integer-only shape check, matching the ONE bound the backend
    // enforces UNCONDITIONALLY at publish for the `assigneeSources` shape this editor emits
    // (`APPROVAL_THRESHOLD_INVALID`, ApprovalProductService.ts :2282-2289). The backend's static
    // N<=M bound (:2292-2304) applies ONLY to the legacy `assigneeType`/`assigneeIds` shape — this
    // editor never emits that shape (`buildStepConfig` always writes `assigneeSources`) — so M is
    // ALWAYS resolved at runtime here, static_user source included. Do NOT invent a stricter
    // client-side bound the backend would not itself enforce (M8): an unreachable resolved M fails
    // closed at the backend's dispatch-time `assertThresholdReachable`
    // (`APPROVAL_THRESHOLD_UNREACHABLE`) when the running instance actually reaches the node — the
    // authoring UI surfaces that as non-blocking copy, not a save-blocking error.
    if (step.approvalMode === 'threshold' && (!Number.isInteger(step.approvalThreshold) || step.approvalThreshold < 1)) {
      errors.push(`${label} 的门槛会签人数必须是不小于 1 的整数`)
    }
    // P1-C (T1-1) timeout PREVIEW — mirrors `validateNodeTimeoutConfigs`'s shape/target rules (the
    // parallel-region rule is moot here: a linear graph is BY CONSTRUCTION never inside one).
    if (step.timeoutEnabled) {
      const afterMinutes = Number(step.timeoutAfterMinutesText.trim())
      if (!Number.isInteger(afterMinutes) || afterMinutes <= 0 || afterMinutes > NODE_TIMEOUT_MAX_AFTER_MINUTES) {
        errors.push(`${label} 的超时时长需为 1–${NODE_TIMEOUT_MAX_AFTER_MINUTES} 分钟之间的整数`)
      }
      if (!step.timeoutEffect) {
        errors.push(`${label} 需要选择超时后的处理方式`)
      } else if (step.timeoutEffect === 'transfer' && !step.timeoutTransferToUserId.trim()) {
        errors.push(`${label} 的超时转交需要选择接收人`)
      } else if (step.timeoutEffect === 'jump') {
        if (!step.timeoutJumpToStepLocalId) {
          errors.push(`${label} 的超时跳转需要选择目标审批节点`)
        } else if (step.timeoutJumpToStepLocalId === step.localId) {
          errors.push(`${label} 的超时跳转不能指向自身`)
        } else if (!draft.steps.some((candidate) => candidate.localId === step.timeoutJumpToStepLocalId)) {
          errors.push(`${label} 的超时跳转目标节点不存在`)
        }
      }
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
 * P3-B / Lock-6 L6-A (docs/development/approval-lock6-requester-global-policy-20260817.md §1) —
 * the template-level 审批人去重 tier. A 3-way projection over the SAME two booleans the backend
 * already server-enforces on `runtimeGraph.policy.autoApproval` (Lock-4 §2.6 /
 * `evaluateAutoApprovalAssignment`): `dedupeHistoricalApprover` (仅一次全自动同意) and
 * `mergeAdjacentApprover` (仅连续节点自动同意). `mergeWithRequester` is deliberately NOT part of this
 * tier — it stays a NODE-level-only field authored via the existing per-step
 * `mergeWithRequester` / `originalAutoApprovalPolicy` pair, never through this template control.
 */
export type TemplateDedupTier = 'none' | 'dedupe_historical' | 'merge_adjacent'

/**
 * Lock-6 §2.6 / gate X-1 (M4 unknown-persisted-values-stay-round-trip-safe) — a persisted policy
 * with BOTH booleans true is a combination this 3-way tier cannot express (the tier is a strict
 * partition: 不去重 / 仅一次全自动同意 / 仅连续节点自动同意, never "both"). `buildTemplateAutoApprovalPolicy`
 * must preserve that combination byte-unchanged rather than collapsing it onto any single tier.
 */
export function isTemplateDedupTierLocked(autoApproval?: AutoApprovalPolicy | null): boolean {
  return Boolean(autoApproval?.dedupeHistoricalApprover === true && autoApproval?.mergeAdjacentApprover === true)
}

/**
 * Hydrate-time projection: absent `autoApproval`, or absent/false on both flags, is 不去重 (§2.2 "no
 * shipped default may change" — byte-stable for every existing template). The locked (both-true)
 * combination also projects to `'none'` here PURELY for a deterministic radio value; the component
 * gates on `isTemplateDedupTierLocked` to render that state read-only, and
 * `buildTemplateAutoApprovalPolicy` independently re-checks the SAME predicate against
 * `originalPolicy` (not this projected tier) before ever touching the publish payload — so a
 * locked template can never be saved as if the author had picked 不去重.
 */
export function templateDedupTierFromPolicy(autoApproval?: AutoApprovalPolicy | null): TemplateDedupTier {
  if (!autoApproval || isTemplateDedupTierLocked(autoApproval)) return 'none'
  if (autoApproval.dedupeHistoricalApprover === true) return 'dedupe_historical'
  if (autoApproval.mergeAdjacentApprover === true) return 'merge_adjacent'
  return 'none'
}

/**
 * Builds the template-level `autoApproval` object `buildPublishPolicy` carries onto the publish
 * payload. Two disjoint paths, chosen by re-reading `draft.originalPolicy.autoApproval` (NOT the
 * projected `draft.autoApprovalDedupTier`) for the lock check every time, so a stale in-memory tier
 * value can never accidentally unlock a save:
 *
 *   - LOCKED (§2.6/X-1, both flags true in the hydrated original): return the original object
 *     VERBATIM. The tier control never touched it — this is preservation, not a no-op default.
 *   - editable: project `draft.autoApprovalDedupTier` onto the two tier-owned keys, but PRESERVE
 *     every OTHER key already present on the hydrated `autoApproval` (e.g. a `mergeWithRequester`
 *     or `actorMode` some other API caller set directly on the template-level object — extremely
 *     unlikely in practice, but this control must never be the mechanism that destroys it).
 *
 * Omits the whole `autoApproval` key when the result is empty, matching the node-level
 * `autoApprovalPolicy`-omit-when-empty convention elsewhere in this file (and §2.2: absent ===
 * 不去重 === today's behavior).
 */
export function buildTemplateAutoApprovalPolicy(draft: TemplateAuthoringDraft): AutoApprovalPolicy | undefined {
  const original = draft.originalPolicy?.autoApproval
  if (isTemplateDedupTierLocked(original)) return original

  const preserved: AutoApprovalPolicy = { ...(original ?? {}) }
  delete preserved.dedupeHistoricalApprover
  delete preserved.mergeAdjacentApprover
  if (draft.autoApprovalDedupTier === 'dedupe_historical') preserved.dedupeHistoricalApprover = true
  else if (draft.autoApprovalDedupTier === 'merge_adjacent') preserved.mergeAdjacentApprover = true

  return Object.keys(preserved).length > 0 ? preserved : undefined
}

/**
 * L6-P1 carrier fix — the publish-time policy payload. MERGES onto `draft.originalPolicy`
 * (the persisted object hydrated verbatim by `draftFromTemplate`) and overlays only the fields the
 * editor actually owns (`allowRevoke`, and now the P3-B dedup tier's projection of `autoApproval`).
 * Was previously built inline at the call site as `{ allowRevoke: draft.allowRevoke }` — a REPLACE,
 * not a merge — which silently destroyed any sibling policy field (e.g. `autoApproval`,
 * `revokeBeforeNodeKeys`) set only through the publish API on every editor republish.
 * `draft.originalPolicy` is absent for a template that has never been published, so a brand-new
 * template still publishes exactly `{ allowRevoke }` (no field is invented — a fresh draft's
 * `autoApprovalDedupTier` defaults to `'none'`, which `buildTemplateAutoApprovalPolicy` projects to
 * `undefined`/omitted, not an empty object). The backend's `assertRuntimePolicy` re-validates every
 * carried-through key, so publishing a stale/foreign shape here fails closed there rather than
 * persisting silently.
 */
export function buildPublishPolicy(draft: TemplateAuthoringDraft): RuntimePolicy {
  const { autoApproval: _originalAutoApproval, ...restOriginalPolicy } = draft.originalPolicy ?? {}
  const autoApproval = buildTemplateAutoApprovalPolicy(draft)
  return {
    ...restOriginalPolicy,
    allowRevoke: draft.allowRevoke,
    ...(autoApproval ? { autoApproval } : {}),
  }
}
