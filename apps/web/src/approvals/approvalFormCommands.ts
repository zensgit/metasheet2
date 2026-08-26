import { DETAIL_LEAF_FIELD_TYPES, type DetailColumnDraft } from './detailField'
import { visibilityReferenceBaseFieldId } from './recordLinkField'
import type { FormFieldType } from '../types/approval'
import type {
  AuthorableFieldType,
  FieldAuthoringDraft,
  FieldVisibilityDraft,
  TemplateAuthoringDraft,
} from './templateAuthoring'

/**
 * D6-f1 form command algebra, amended by F1 of the RATIFIED
 * approval-form-builder-parity delta (FB-D3 anchors, FB-D5
 * `OPAQUE_COLLISION_RESISTANT` identity, FB-D6
 * `CURRENT_DRAFT_REFERENCES_PLUS_VERSION_PINNED_EXTERNALS` delete boundary)
 * and by F3 (typed property update / retype surface: named incompatible-type
 * refusal, detail-column commands, identity preservation across retype).
 * These commands use `localId` only as a view-model selection key. It is never
 * rendered as, or accepted from, ordinary-user input; persisted field ids
 * remain owned by the existing template-authoring serializer.
 */

export type FormCommandFailureReason =
  | 'field_not_found'
  | 'target_not_found'
  | 'unsupported_field_type'
  | 'invalid_field_identity'
  | 'field_identity_conflict'
  | 'field_is_referenced'
  | 'last_field_removal_forbidden'
  /** F3: a detail field must keep >=1 column (`validateDetailColumnsDraft`). */
  | 'last_detail_column_removal_forbidden'
  /**
   * F3 named incompatible-type refusal (FB-D6): the retype target conflicts
   * with at least one named dependency; `dependencies` carries every one. The
   * administrator removes or edits the dependency first, then retries. Never a
   * generic string error, and NEVER the legacy silent
   * `invalidateStaleRecordLinkDependencies` cleanup.
   */
  | 'field_type_incompatible_with_references'

export type FormDependencyKind =
  | 'visibility_rule'
  | 'step_assignee_source'
  | 'step_field_permission'
  | 'condition_rule'
  | 'condition_formula'
  | 'approval_node_assignee_source'
  | 'preserved_graph_reference'
  | 'amount_consistency_mapping'
  | 'external_reference'
  /** F3: the field's own detail configuration (columns/row bounds) a retype away from `detail` would destroy — or the one-nesting-level detail boundary a column retype would violate. */
  | 'detail_config'
  /** F3: the field's own record-link binding a retype away from `record-link` would drop — or the top-level-only record-link boundary a column retype would violate. */
  | 'record_link_config'
  /** F3: the attachment authoring boundary (FB-D8) — `attachment` is not an authorable retype target in this delta. */
  | 'attachment_boundary'

export interface FormFieldDependency {
  kind: FormDependencyKind
  /** Internal diagnostics for the inspector; this is never an ordinary-user label. */
  location: string
}

/**
 * Optional external-reference input for `collectFormFieldDependencies`, reserved
 * for a FUTURE same-version external reference owner. It is NOT an FWB
 * inventory: no template-keyed FWB reference inventory exists, and FWB mappings
 * are deliberately not live references to this mutable draft — they are pinned
 * to `sourceTemplateVersionId`, save/execute already require that pin to match
 * the active template version, and publishing any new version makes old
 * mappings stale and requires reconfirmation independently of which fields
 * changed (RATIFIED FB-D6). The production delete path therefore takes no
 * inventory; a future same-version external reference owner must add an
 * authoritative provider plus backend validation before delete safety can
 * widen — the UI must never fabricate such a provider.
 */
export interface CompleteFormReferenceInventory {
  readonly complete: true
  readonly references: readonly FormExternalReference[]
}

export interface FormExternalReference {
  readonly fieldId: string
  readonly location: string
}

/**
 * An identity allocated by the opaque collision-resistant allocator
 * (`approvalFormIdentity.ts` — RATIFIED FB-D5 `OPAQUE_COLLISION_RESISTANT`).
 * It is an internal command input, not a normal-user field-id API. The pure
 * command deliberately never derives persistent IDs from the current draft: a
 * deleted maximum suffix must not become a later field's identity. The opaque
 * allocator is the sole collision authority — this command validates each
 * candidate against the complete current draft, the adapter retries a
 * collision with a fresh candidate, and cross-version non-reuse is provided by
 * the allocator's opacity rather than an identity-history parameter or a
 * server reservation API.
 *
 * Detail fields need an explicit first-column identity because column IDs are
 * also persisted and may not collide with any live field or column identity.
 */
export interface FormFieldIdentity {
  readonly persistentId: string
  readonly localId: string
  readonly detailColumn?: {
    readonly persistentId: string
    readonly localId: string
  }
}

/** Opaque identity for one additional detail column (`addFormDetailColumn`). */
export interface FormDetailColumnIdentity {
  readonly persistentId: string
  readonly localId: string
}

/**
 * FB-D3 semantic insertion anchor: a slot is identified by its current
 * neighbors, never by a persisted index or pixel coordinate. Anchors are
 * re-resolved against the draft immediately before mutation; a stale `after`
 * anchor (field removed since drag start) is a values-free rejection with zero
 * draft mutation. `{ kind: 'start' }` prepends ATOMICALLY inside one
 * `addFormField` call — it is never implemented as an add-then-move pair.
 */
export type FormInsertionAnchor =
  | { kind: 'start' }
  | { kind: 'after'; localId: string }

export type FormCommandResult =
  | {
      ok: true
      draft: TemplateAuthoringDraft
      focusLocalId: string | null
    }
  | {
      ok: false
      reason: FormCommandFailureReason
      dependencies: readonly FormFieldDependency[]
    }

const FIELD_LABELS: Record<AuthorableFieldType, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  date: '日期',
  datetime: '日期时间',
  select: '单选',
  'multi-select': '多选',
  user: '人员',
  detail: '明细',
  'record-link': '关联记录',
  date_range: '日期区间',
  explanation: '说明',
}

const AUTHORABLE_FIELD_TYPES = new Set<AuthorableFieldType>(
  Object.keys(FIELD_LABELS) as AuthorableFieldType[],
)

const DATE_RANGE_DATE_TYPES = new Set<FieldAuthoringDraft['dateRangeDateType']>([
  '',
  'date',
  'date_half_day',
  'date_minute',
])

function successful(
  draft: TemplateAuthoringDraft,
  focusLocalId: string | null,
): FormCommandResult {
  return { ok: true, draft, focusLocalId }
}

function rejected(
  reason: FormCommandFailureReason,
  dependencies: readonly FormFieldDependency[] = [],
): FormCommandResult {
  return { ok: false, reason, dependencies }
}

function newDetailColumn(
  identity: NonNullable<FormFieldIdentity['detailColumn']>,
): DetailColumnDraft {
  return {
    localId: identity.localId,
    id: identity.persistentId,
    type: 'text',
    label: '子字段 1',
    required: false,
    optionsText: '',
  }
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isUsableIdentity(
  fieldType: AuthorableFieldType,
  identity: FormFieldIdentity | undefined,
): identity is FormFieldIdentity {
  if (
    !identity ||
    !nonBlank(identity.persistentId) ||
    !nonBlank(identity.localId)
  )
    return false
  if (fieldType !== 'detail') return identity.detailColumn === undefined
  return Boolean(
    identity.detailColumn &&
      nonBlank(identity.detailColumn.persistentId) &&
      nonBlank(identity.detailColumn.localId),
  )
}

/**
 * Every identity token reserved by the COMPLETE current draft: field
 * persistent/local ids plus every detail column's persistent/local ids. This is
 * the FB-D5 collision domain — the opaque allocator (not an identity-history
 * parameter) owns cross-version non-reuse.
 */
function reservedDraftIdentityTokens(
  draft: TemplateAuthoringDraft,
): Set<string> {
  const reserved = new Set<string>()
  draft.fields.forEach((field) => {
    reserved.add(field.id)
    reserved.add(field.localId)
    field.detailColumns.forEach((column) => {
      reserved.add(column.id)
      reserved.add(column.localId)
    })
  })
  return reserved
}

/** True when candidates collide with each other or with the current draft. */
function candidateTokensConflict(
  draft: TemplateAuthoringDraft,
  candidates: readonly string[],
): boolean {
  if (new Set(candidates).size !== candidates.length) {
    return true
  }
  const reserved = reservedDraftIdentityTokens(draft)
  return candidates.some((candidate) => reserved.has(candidate))
}

function identityConflicts(
  draft: TemplateAuthoringDraft,
  identity: FormFieldIdentity,
): boolean {
  return candidateTokensConflict(draft, [
    identity.persistentId,
    identity.localId,
    ...(identity.detailColumn
      ? [identity.detailColumn.persistentId, identity.detailColumn.localId]
      : []),
  ])
}

/**
 * Add a supported top-level field at the anchor-selected slot. The caller
 * supplies a durable OPAQUE identity (RATIFIED FB-D5
 * `OPAQUE_COLLISION_RESISTANT`): the opaque allocator is the sole collision
 * authority, this command validates each candidate against the complete
 * current draft, and the production adapter retries a collision with a FRESH
 * candidate. Supplying the identity keeps this pure command deterministic for
 * replays while preventing the old max-suffix allocator from reusing deleted
 * persistent IDs.
 *
 * Anchor semantics (FB-D3): the anchor is resolved against `draft` at call
 * time — never a captured index. `{ kind: 'start' }` prepends ATOMICALLY in
 * this one command (one splice, never an add-then-move pair); a stale
 * `{ kind: 'after' }` anchor is a values-free `target_not_found` rejection
 * with zero mutation. Omitting the anchor keeps the legacy append convenience
 * used by palette click.
 */
export function addFormField(
  draft: TemplateAuthoringDraft,
  fieldType: AuthorableFieldType,
  identity: FormFieldIdentity,
  anchor?: FormInsertionAnchor,
): FormCommandResult {
  if (!AUTHORABLE_FIELD_TYPES.has(fieldType))
    return rejected('unsupported_field_type')
  if (!isUsableIdentity(fieldType, identity))
    return rejected('invalid_field_identity')

  let insertAt: number
  if (!anchor) {
    insertAt = draft.fields.length
  } else if (anchor.kind === 'start') {
    insertAt = 0
  } else {
    const index = draft.fields.findIndex(
      (candidate) => candidate.localId === anchor.localId,
    )
    if (index === -1) return rejected('target_not_found')
    insertAt = index + 1
  }

  if (identityConflicts(draft, identity))
    return rejected('field_identity_conflict')

  const field: FieldAuthoringDraft = {
    localId: identity.localId,
    id: identity.persistentId,
    type: fieldType,
    label: FIELD_LABELS[fieldType],
    required: false,
    placeholder: '',
    optionsText: '',
    visibility: { dependsOnFieldId: '', operator: 'eq', valueText: '' },
    detailColumns:
      fieldType === 'detail' ? [newDetailColumn(identity.detailColumn!)] : [],
    minRowsText: '',
    maxRowsText: '',
    recordLinkBaseId: '',
    recordLinkSheetId: '',
    // L8-C: neutral defaults, same discipline as recordLinkBaseId/recordLinkSheetId above — this
    // command layer feeds the Designer 2.0 canvas track (ApprovalFormFieldInspector.vue). F4
    // (approval-form-builder-parity-delta-design-20260811.md §5 F4) mounts that track in production
    // behind `approvalCanvasV2` (default ON) — it is no longer categorically unmounted, but
    // ApprovalFormFieldInspector.vue still has NO authoring affordance for these three keys (out of
    // Lock-8's citation scope, §1.3 names ApprovalFormInlineEditor.vue only); a freshly-added
    // `number` field simply carries no display props, same as today, on EITHER surface.
    numberCurrencySymbol: '',
    numberThousandsSeparator: false,
    numberUppercaseCny: false,
    // L8-B: same neutral-defaults discipline as the L8-C keys above — no authoring affordance for
    // date_range's four keys exists on ApprovalFormFieldInspector.vue either; a freshly-added
    // date_range field simply carries an unset dateType (matching §1.2's no-absent-default: it
    // stays publish-rejected until the OTHER surface — ApprovalFormInlineEditor — sets a
    // granularity). With F4's mount, a date_range field added via the Designer 2.0 palette while
    // `approvalCanvasV2` is ON has NO in-surface way to set that granularity (the legacy fallback
    // is unreachable while the flag is ON) — a known, flag-gated residual; see this PR's
    // description / the F4 execution ledger, not a defect this command layer introduces.
    dateRangeDateType: '',
    dateRangeStartLabel: '',
    dateRangeEndLabel: '',
    dateRangeDurationLabel: '',
    // L8-A: same neutral-defaults discipline as the L8-B/L8-C keys above — no authoring affordance
    // for `explanationText` exists here; a freshly-added explanation field simply carries an empty
    // body (matching §1.1's no-absent-default: it stays publish-rejected until the OTHER, live
    // authoring surface — ApprovalFormInlineEditor — writes one).
    explanationText: '',
  }

  const fields = [...draft.fields]
  fields.splice(insertAt, 0, field)
  return successful({ ...draft, fields }, field.localId)
}

/**
 * Append one additional column to an existing `detail` field with a supplied
 * OPAQUE identity (FB-D5 — column ids are persisted and share one collision
 * domain with every live field/column identity in the complete current draft).
 * The generated `子字段 N` label is display copy only — it is never identity,
 * and duplicate display labels after a deletion are legal and editable.
 */
export function addFormDetailColumn(
  draft: TemplateAuthoringDraft,
  fieldLocalId: string,
  identity: FormDetailColumnIdentity,
): FormCommandResult {
  const index = draft.fields.findIndex(
    (field) => field.localId === fieldLocalId,
  )
  if (index === -1) return rejected('field_not_found')
  const owner = draft.fields[index]
  if (owner.type !== 'detail') return rejected('unsupported_field_type')
  if (
    !identity ||
    !nonBlank(identity.persistentId) ||
    !nonBlank(identity.localId)
  )
    return rejected('invalid_field_identity')
  if (
    candidateTokensConflict(draft, [identity.persistentId, identity.localId])
  )
    return rejected('field_identity_conflict')

  const column: DetailColumnDraft = {
    localId: identity.localId,
    id: identity.persistentId,
    type: 'text',
    label: `子字段 ${owner.detailColumns.length + 1}`,
    required: false,
    optionsText: '',
  }
  const fields = [...draft.fields]
  fields[index] = {
    ...owner,
    detailColumns: [...owner.detailColumns, column],
  }
  return successful({ ...draft, fields }, owner.localId)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formulaReferencesField(value: string, fieldId: string): boolean {
  return new RegExp(`\\{${escapeRegExp(fieldId)}(?:\\.[^{}]+)?\\}`).test(value)
}

/** Exact `{ownerId.columnId}` detail-column token match (F3 column commands). */
function formulaReferencesDetailColumn(
  value: string,
  ownerFieldId: string,
  columnId: string,
): boolean {
  return new RegExp(
    `\\{${escapeRegExp(ownerFieldId)}\\.${escapeRegExp(columnId)}\\}`,
  ).test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Predicate pair for the preserved-graph/original walk: which `fieldId` values
 * and which formula `expression` strings count as references. The field-level
 * walk (F1, byte-identical behavior) and the F3 detail-column walk share the
 * one traversal so neither can silently diverge from the other.
 */
interface PreservedReferencePredicates {
  fieldIdMatches(value: string): boolean
  expressionMatches(value: string): boolean
}

function walkPreservedReferences(
  value: unknown,
  location: string,
  dependencies: FormFieldDependency[],
  predicates: PreservedReferencePredicates,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      walkPreservedReferences(
        entry,
        `${location}[${index}]`,
        dependencies,
        predicates,
      ),
    )
    return
  }
  if (!isRecord(value)) return

  if (typeof value.fieldId === 'string' && predicates.fieldIdMatches(value.fieldId)) {
    dependencies.push({ kind: 'preserved_graph_reference', location })
  }
  if (
    typeof value.expression === 'string' &&
    predicates.expressionMatches(value.expression)
  ) {
    dependencies.push({ kind: 'condition_formula', location })
  }
  Object.entries(value).forEach(([key, entry]) => {
    if (key !== 'fieldId' && key !== 'expression') {
      walkPreservedReferences(
        entry,
        `${location}.${key}`,
        dependencies,
        predicates,
      )
    }
  })
}

function fieldReferencePredicates(fieldId: string): PreservedReferencePredicates {
  return {
    fieldIdMatches: (value) => value.trim() === fieldId,
    expressionMatches: (value) => formulaReferencesField(value, fieldId),
  }
}

function detailColumnReferencePredicates(
  ownerFieldId: string,
  columnId: string,
): PreservedReferencePredicates {
  const dotted = `${ownerFieldId}.${columnId}`
  return {
    fieldIdMatches: (value) => value.trim() === dotted,
    expressionMatches: (value) =>
      formulaReferencesDetailColumn(value, ownerFieldId, columnId),
  }
}

function collectPreservedGraphReferences(
  value: unknown,
  fieldId: string,
  location: string,
  dependencies: FormFieldDependency[],
): void {
  walkPreservedReferences(
    value,
    location,
    dependencies,
    fieldReferencePredicates(fieldId),
  )
}

/**
 * Enumerate every reference represented by the current authoring draft —
 * complete by construction over the draft (visibility, assignee sources, field
 * permissions, condition rules/formulas, preserved graph, amount-consistency
 * mapping). Per RATIFIED FB-D6 this current-draft set is the authoritative
 * delete boundary; the optional `inventory` is only the seam for a FUTURE
 * authoritative same-version external reference owner (see
 * `CompleteFormReferenceInventory`). The walk is deliberately conservative: an
 * unrecognised graph `fieldId` or formula token blocks delete rather than
 * being rewritten to another field.
 */
export function collectFormFieldDependencies(
  draft: TemplateAuthoringDraft,
  fieldId: string,
  inventory?: CompleteFormReferenceInventory,
): FormFieldDependency[] {
  const dependencies: FormFieldDependency[] = []
  draft.fields.forEach((field) => {
    // Lock-8 L8-B OD-L8-5(a): a dotted `${fieldId}.start`/`${fieldId}.end` endpoint address still
    // counts as a reference to `fieldId` for delete/retype dependency-tracking purposes —
    // otherwise removing a date_range field whose endpoint an OTHER field's visibility rule
    // depends on would silently orphan that rule (it would fail at the next publish instead of
    // being caught here, same class of bug `clearStaleRecordLinkDependencies` guards for retype).
    if (
      field.id !== fieldId &&
      visibilityReferenceBaseFieldId(field.visibility.dependsOnFieldId.trim()) === fieldId
    ) {
      dependencies.push({
        kind: 'visibility_rule',
        location: `fields.${field.localId}.visibility`,
      })
    }
    if (field.id !== fieldId && field.original) {
      collectPreservedGraphReferences(
        field.original,
        fieldId,
        `fields.${field.localId}.original`,
        dependencies,
      )
    }
  })
  draft.steps.forEach((step) => {
    if (
      step.sourceKind === 'form_field_user' &&
      step.fieldId.trim() === fieldId
    ) {
      dependencies.push({
        kind: 'step_assignee_source',
        location: `steps.${step.localId}.fieldId`,
      })
    }
    if (
      step.fieldPermissions.some(
        (permission) => permission.fieldId.trim() === fieldId,
      )
    ) {
      dependencies.push({
        kind: 'step_field_permission',
        location: `steps.${step.localId}.fieldPermissions`,
      })
    }
  })
  Object.values(draft.conditionEdits ?? {}).forEach((edit) => {
    edit.branches.forEach((branch, branchIndex) => {
      if (branch.rules.some((rule) => rule.fieldId.trim() === fieldId)) {
        dependencies.push({
          kind: 'condition_rule',
          location: `conditionEdits.${edit.nodeKey}.branches.${branchIndex}.rules`,
        })
      }
      if (formulaReferencesField(branch.formulaExpression, fieldId)) {
        dependencies.push({
          kind: 'condition_formula',
          location: `conditionEdits.${edit.nodeKey}.branches.${branchIndex}.formula`,
        })
      }
    })
  })
  Object.values(draft.approvalNodeEdits ?? {}).forEach((edit) => {
    if (
      edit.assigneeSources.some(
        (source) =>
          source.kind === 'form_field_user' &&
          source.fieldId.trim() === fieldId,
      )
    ) {
      dependencies.push({
        kind: 'approval_node_assignee_source',
        location: `approvalNodeEdits.${edit.nodeKey}`,
      })
    }
  })
  if (draft.preservedGraph) {
    collectPreservedGraphReferences(
      draft.preservedGraph,
      fieldId,
      'preservedGraph',
      dependencies,
    )
  }
  const mapping = draft.amountConsistencyCheck
  if (
    mapping &&
    (mapping.totalFieldId.trim() === fieldId ||
      mapping.detailFieldId.trim() === fieldId ||
      mapping.amountColumnId.trim() === fieldId)
  ) {
    dependencies.push({
      kind: 'amount_consistency_mapping',
      location: 'amountConsistencyCheck',
    })
  }
  inventory?.references
    .filter((reference) => reference.fieldId === fieldId)
    .forEach((reference) =>
      dependencies.push({
        kind: 'external_reference',
        location: reference.location,
      }),
    )
  return dependencies
}

/**
 * Remove only a removable, unreferenced field. RATIFIED FB-D6
 * (`CURRENT_DRAFT_REFERENCES_PLUS_VERSION_PINNED_EXTERNALS`): the authoritative
 * reference set for delete is the complete-by-construction current-draft set
 * from `collectFormFieldDependencies`; FWB stays version-pinned-external (see
 * `CompleteFormReferenceInventory` for why no live FWB inventory exists), so
 * the production delete signature takes no inventory parameter.
 *
 * Removing the final remaining field is rejected HERE with
 * `last_field_removal_forbidden` BEFORE reference evaluation — the UI
 * disable/early-return is a convenience only, never the integrity boundary.
 */
export function removeFormField(
  draft: TemplateAuthoringDraft,
  localId: string,
): FormCommandResult {
  const index = draft.fields.findIndex((field) => field.localId === localId)
  if (index === -1) return rejected('field_not_found')
  if (draft.fields.length <= 1) {
    return rejected('last_field_removal_forbidden')
  }
  const dependencies = collectFormFieldDependencies(
    draft,
    draft.fields[index].id,
  )
  if (dependencies.length > 0)
    return rejected('field_is_referenced', dependencies)

  const fields = draft.fields.filter((field) => field.localId !== localId)
  return successful(
    { ...draft, fields },
    fields[index]?.localId ?? fields[index - 1]?.localId ?? null,
  )
}

// --- F3 typed property update / retype surface ------------------------------

/**
 * Typed property patch for `updateFormFieldProperties`. Deliberately EXCLUDES
 * identity (`id`/`localId` — FB-D5: commands never re-mint or accept identity
 * edits), `type` (that is `retypeFormField`), `detailColumns` (the dedicated
 * column commands), `original` (round-trip preservation is serializer-owned),
 * and the record-link base/sheet pins (their typed pickers arrive with the F4
 * production mount, where the parent-owned catalog lives).
 */
export interface FormFieldPropertyPatch {
  readonly label?: string
  readonly required?: boolean
  readonly placeholder?: string
  readonly optionsText?: string
  readonly visibility?: FieldVisibilityDraft
  readonly minRowsText?: string
  readonly maxRowsText?: string
  readonly numberCurrencySymbol?: string
  readonly numberThousandsSeparator?: boolean
  readonly numberUppercaseCny?: boolean
  readonly dateRangeDateType?: FieldAuthoringDraft['dateRangeDateType']
  readonly dateRangeStartLabel?: string
  readonly dateRangeEndLabel?: string
  readonly dateRangeDurationLabel?: string
  readonly explanationText?: string
}

/** Typed patch for one detail column (type changes go through `retypeFormDetailColumn`). */
export interface FormDetailColumnPropertyPatch {
  readonly label?: string
  readonly required?: boolean
  readonly optionsText?: string
}

/**
 * One committed inspector edit of the field's own properties (FB-D7: the
 * adapter turns one successful call into at most ONE history entry; a
 * value-identical patch is a zero-entry no-op by history construction).
 * Identity and type are untouched by construction of the patch type.
 *
 * Fail-closed boundaries (F3 gate P3-1/P3-4): a field whose CURRENT type is
 * not authorable (`attachment` or unknown persisted types) rejects every
 * property edit at the command level — §3.4's whole-template lock must not
 * depend on the UI `readOnly` prop alone. Row-bound keys are `detail`-only:
 * patching them onto any other type is rejected rather than parked as latent
 * state a later retype could resurrect.
 */
export function updateFormFieldProperties(
  draft: TemplateAuthoringDraft,
  localId: string,
  patch: FormFieldPropertyPatch,
): FormCommandResult {
  const index = draft.fields.findIndex((field) => field.localId === localId)
  if (index === -1) return rejected('field_not_found')
  const current = draft.fields[index]
  if (!AUTHORABLE_FIELD_TYPES.has(current.type))
    return rejected('unsupported_field_type')
  if (
    (patch.minRowsText !== undefined || patch.maxRowsText !== undefined) &&
    current.type !== 'detail'
  )
    return rejected('unsupported_field_type')
  if (
    (patch.numberCurrencySymbol !== undefined ||
      patch.numberThousandsSeparator !== undefined ||
      patch.numberUppercaseCny !== undefined) &&
    current.type !== 'number'
  )
    return rejected('unsupported_field_type')
  if (
    (patch.dateRangeDateType !== undefined ||
      patch.dateRangeStartLabel !== undefined ||
      patch.dateRangeEndLabel !== undefined ||
      patch.dateRangeDurationLabel !== undefined) &&
    current.type !== 'date_range'
  )
    return rejected('unsupported_field_type')
  if (patch.explanationText !== undefined && current.type !== 'explanation')
    return rejected('unsupported_field_type')
  if (
    patch.dateRangeDateType !== undefined &&
    !DATE_RANGE_DATE_TYPES.has(patch.dateRangeDateType)
  )
    return rejected('unsupported_field_type')
  const next: FieldAuthoringDraft = {
    ...current,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.required !== undefined ? { required: patch.required } : {}),
    ...(patch.placeholder !== undefined
      ? { placeholder: patch.placeholder }
      : {}),
    ...(patch.optionsText !== undefined
      ? { optionsText: patch.optionsText }
      : {}),
    ...(patch.visibility !== undefined
      ? { visibility: { ...patch.visibility } }
      : {}),
    ...(patch.minRowsText !== undefined
      ? { minRowsText: patch.minRowsText }
      : {}),
    ...(patch.maxRowsText !== undefined
      ? { maxRowsText: patch.maxRowsText }
      : {}),
    ...(patch.numberCurrencySymbol !== undefined
      ? { numberCurrencySymbol: patch.numberCurrencySymbol }
      : {}),
    ...(patch.numberThousandsSeparator !== undefined
      ? { numberThousandsSeparator: patch.numberThousandsSeparator }
      : {}),
    ...(patch.numberUppercaseCny !== undefined
      ? { numberUppercaseCny: patch.numberUppercaseCny }
      : {}),
    ...(patch.dateRangeDateType !== undefined
      ? { dateRangeDateType: patch.dateRangeDateType }
      : {}),
    ...(patch.dateRangeStartLabel !== undefined
      ? { dateRangeStartLabel: patch.dateRangeStartLabel }
      : {}),
    ...(patch.dateRangeEndLabel !== undefined
      ? { dateRangeEndLabel: patch.dateRangeEndLabel }
      : {}),
    ...(patch.dateRangeDurationLabel !== undefined
      ? { dateRangeDurationLabel: patch.dateRangeDurationLabel }
      : {}),
    ...(patch.explanationText !== undefined
      ? { explanationText: patch.explanationText }
      : {}),
  }
  const fields = [...draft.fields]
  fields[index] = next
  return successful({ ...draft, fields }, current.localId)
}

/** True when leaving `detail` would destroy real (non-pristine) configuration. */
function detailFieldCarriesConfiguration(field: FieldAuthoringDraft): boolean {
  if (field.original) return true // hydrated persisted detail: columns are persisted ids
  if (field.minRowsText.trim() !== '' || field.maxRowsText.trim() !== '')
    return true
  if (field.detailColumns.length !== 1) return true
  const column = field.detailColumns[0]
  return Boolean(
    column.original ||
      column.type !== 'text' ||
      column.required ||
      column.optionsText.trim() !== '' ||
      column.label !== '子字段 1',
  )
}

/** True when leaving `record-link` would drop a configured/persisted binding. */
function recordLinkCarriesConfiguration(field: FieldAuthoringDraft): boolean {
  return Boolean(
    field.original ||
      field.recordLinkBaseId.trim() !== '' ||
      field.recordLinkSheetId.trim() !== '',
  )
}

/**
 * Every dependency that makes retyping `localId` to `nextType` incompatible
 * (RATIFIED FB-D6, master M3 as amended).
 *
 * v1 compatibility floor — deliberately CONSERVATIVE, mirroring the
 * complete-by-construction current-draft walk: EVERY inbound current-draft
 * reference (all `collectFormFieldDependencies` kinds — visibility, assignee
 * sources, field permissions, condition rules/formulas, preserved graph,
 * amount-consistency mapping, plus the optional external seam) is treated as
 * incompatible with a type change, because each consumer's semantics are bound
 * to the current value type. The administrator removes or edits the dependency
 * first, then retries. Loosening any kind to a finer per-type compatibility
 * matrix would widen what retype silently accepts and needs a new lock
 * decision — it must not be done to simplify a caller.
 *
 * On top of the inbound floor, two OWN-configuration kinds fail closed:
 * - `detail_config`: leaving `detail` while the field carries non-pristine
 *   column/row-bound configuration (persisted or edited columns would be
 *   destroyed);
 * - `record_link_config`: leaving `record-link` while a base/sheet binding is
 *   configured or persisted.
 * A value-identical retype (same type) is never incompatible.
 */
export function collectFormFieldRetypeDependencies(
  draft: TemplateAuthoringDraft,
  localId: string,
  nextType: FormFieldType,
  inventory?: CompleteFormReferenceInventory,
): FormFieldDependency[] {
  const field = draft.fields.find((candidate) => candidate.localId === localId)
  if (!field || field.type === nextType) return []
  const dependencies = collectFormFieldDependencies(draft, field.id, inventory)
  if (field.type === 'detail') {
    // Leaving `detail` destroys every column, so each column's OWN reference
    // set (dotted `{field.column}` formulas/rules, amount `amountColumnId`,
    // preserved payload tokens) blocks the retype too (F3 gate P3-2 —
    // `formulaReferencesField` already catches dotted FORMULA tokens above;
    // this fold adds the exact-equality dotted rule/graph shapes).
    field.detailColumns.forEach((column) => {
      dependencies.push(
        ...collectFormDetailColumnDependencies(draft, field.id, column.id),
      )
    })
    if (detailFieldCarriesConfiguration(field)) {
      dependencies.push({
        kind: 'detail_config',
        location: `fields.${field.localId}.detailColumns`,
      })
    }
  }
  if (field.type === 'record-link' && recordLinkCarriesConfiguration(field)) {
    dependencies.push({
      kind: 'record_link_config',
      location: `fields.${field.localId}.recordLink`,
    })
  }
  return dependencies
}

/**
 * F3 typed retype command (NEW on this baseline — master M3 prices it as new
 * command work, not a mount).
 *
 * - Reference-aware NAMED refusal (`field_type_incompatible_with_references`
 *   with the full dependency list) via
 *   `collectFormFieldRetypeDependencies`; never a generic string error and
 *   NEVER the legacy silent `invalidateStaleRecordLinkDependencies` cleanup.
 * - IDENTITY IS PRESERVED (FB-D5): the field keeps its `id` and `localId`
 *   byte-identical by construction — retype never re-mints identity.
 * - `attachment` target = the named `attachment_boundary` refusal (FB-D8).
 * - Retyping TO `detail` mints only the FIRST COLUMN identity, which the
 *   caller supplies from the opaque allocator (`detailColumnIdentity`); the
 *   adapter retries a collision with a fresh candidate.
 * - Value-identical retype (same type) is a zero-entry no-op by adapter
 *   history construction.
 * - The optional `inventory` is the same FUTURE external-owner seam as
 *   `collectFormFieldDependencies`; production callers pass none (FB-D6).
 */
export function retypeFormField(
  draft: TemplateAuthoringDraft,
  localId: string,
  // Accepts the FULL persisted union so a hostile/stale `attachment` (or any
  // unknown) input hits the runtime boundary checks instead of being
  // type-laundered by the caller.
  nextType: FormFieldType,
  detailColumnIdentity?: FormDetailColumnIdentity,
  inventory?: CompleteFormReferenceInventory,
): FormCommandResult {
  const index = draft.fields.findIndex((field) => field.localId === localId)
  if (index === -1) return rejected('field_not_found')
  const current = draft.fields[index]
  // Boundary checks run BEFORE the same-type no-op (F3 gate P3-1): an
  // `attachment`→`attachment` "retype" must be the named boundary refusal and
  // an unknown persisted type must stay fail-closed, never a silent success.
  if (nextType === 'attachment') {
    return rejected('field_type_incompatible_with_references', [
      { kind: 'attachment_boundary', location: 'fieldType.attachment' },
    ])
  }
  if (!AUTHORABLE_FIELD_TYPES.has(nextType as AuthorableFieldType))
    return rejected('unsupported_field_type')
  if (!AUTHORABLE_FIELD_TYPES.has(current.type))
    return rejected('unsupported_field_type')
  if (nextType === current.type) {
    return successful({ ...draft, fields: draft.fields.slice() }, localId)
  }
  const target = nextType as AuthorableFieldType

  const dependencies = collectFormFieldRetypeDependencies(
    draft,
    localId,
    target,
    inventory,
  )
  if (dependencies.length > 0)
    return rejected('field_type_incompatible_with_references', dependencies)

  let detailColumns: DetailColumnDraft[] = []
  if (target === 'detail') {
    if (
      !detailColumnIdentity ||
      !nonBlank(detailColumnIdentity.persistentId) ||
      !nonBlank(detailColumnIdentity.localId)
    )
      return rejected('invalid_field_identity')
    if (
      candidateTokensConflict(draft, [
        detailColumnIdentity.persistentId,
        detailColumnIdentity.localId,
      ])
    )
      return rejected('field_identity_conflict')
    detailColumns = [newDetailColumn(detailColumnIdentity)]
  }

  const next: FieldAuthoringDraft = {
    ...current,
    // Identity preservation by construction: `id`/`localId` are carried from
    // `current` and never reassigned here.
    //
    // DELIBERATE (not an accident — F3 gate NIT-2): `optionsText` is kept
    // across retype so select→other→select round-trips restore the options;
    // `buildFormSchema` already omits `options` for non-select types, so the
    // emitted schema stays clean while the draft preserves the admin's work.
    type: target,
    detailColumns,
    ...(target !== 'detail' ? { minRowsText: '', maxRowsText: '' } : {}),
  }
  const fields = [...draft.fields]
  fields[index] = next
  return successful({ ...draft, fields }, current.localId)
}

/**
 * Every current-draft reference to one detail COLUMN (F3 column commands):
 * the amount-consistency `amountColumnId`, dotted `ownerId.columnId` condition
 * rules, `{ownerId.columnId}` condition formulas, and the same dotted tokens
 * anywhere in the preserved graph or hydrated `field.original` payloads (one
 * shared conservative walk with the field-level collector).
 */
export function collectFormDetailColumnDependencies(
  draft: TemplateAuthoringDraft,
  ownerFieldId: string,
  columnId: string,
): FormFieldDependency[] {
  const dependencies: FormFieldDependency[] = []
  const owner = ownerFieldId.trim()
  const column = columnId.trim()
  if (!owner || !column) return dependencies
  const dotted = `${owner}.${column}`
  const predicates = detailColumnReferencePredicates(owner, column)

  const mapping = draft.amountConsistencyCheck
  if (
    mapping &&
    (mapping.amountColumnId.trim() === column ||
      mapping.amountColumnId.trim() === dotted)
  ) {
    dependencies.push({
      kind: 'amount_consistency_mapping',
      location: 'amountConsistencyCheck.amountColumnId',
    })
  }
  Object.values(draft.conditionEdits ?? {}).forEach((edit) => {
    edit.branches.forEach((branch, branchIndex) => {
      if (branch.rules.some((rule) => rule.fieldId.trim() === dotted)) {
        dependencies.push({
          kind: 'condition_rule',
          location: `conditionEdits.${edit.nodeKey}.branches.${branchIndex}.rules`,
        })
      }
      if (predicates.expressionMatches(branch.formulaExpression)) {
        dependencies.push({
          kind: 'condition_formula',
          location: `conditionEdits.${edit.nodeKey}.branches.${branchIndex}.formula`,
        })
      }
    })
  })
  draft.fields.forEach((field) => {
    if (field.original) {
      walkPreservedReferences(
        field.original,
        `fields.${field.localId}.original`,
        dependencies,
        predicates,
      )
    }
  })
  if (draft.preservedGraph) {
    walkPreservedReferences(
      draft.preservedGraph,
      'preservedGraph',
      dependencies,
      predicates,
    )
  }
  return dependencies
}

interface LocatedDetailColumn {
  fieldIndex: number
  owner: FieldAuthoringDraft
  columnIndex: number
  column: DetailColumnDraft
}

function locateDetailColumn(
  draft: TemplateAuthoringDraft,
  fieldLocalId: string,
  columnLocalId: string,
): LocatedDetailColumn | FormCommandResult {
  const fieldIndex = draft.fields.findIndex(
    (field) => field.localId === fieldLocalId,
  )
  if (fieldIndex === -1) return rejected('field_not_found')
  const owner = draft.fields[fieldIndex]
  if (owner.type !== 'detail') return rejected('unsupported_field_type')
  const columnIndex = owner.detailColumns.findIndex(
    (column) => column.localId === columnLocalId,
  )
  if (columnIndex === -1) return rejected('target_not_found')
  return {
    fieldIndex,
    owner,
    columnIndex,
    column: owner.detailColumns[columnIndex],
  }
}

function isRejection(value: LocatedDetailColumn | FormCommandResult): value is FormCommandResult {
  return 'ok' in value
}

function withReplacedColumn(
  draft: TemplateAuthoringDraft,
  located: LocatedDetailColumn,
  nextColumn: DetailColumnDraft,
): FormCommandResult {
  const detailColumns = [...located.owner.detailColumns]
  detailColumns[located.columnIndex] = nextColumn
  const fields = [...draft.fields]
  fields[located.fieldIndex] = { ...located.owner, detailColumns }
  return successful({ ...draft, fields }, located.owner.localId)
}

/**
 * One committed inspector edit of one detail column's properties (FB-D7).
 * A column whose CURRENT type is outside the leaf allowlist (hostile/broken
 * persisted data) rejects edits fail-closed (P3-1 posture, same as the
 * field-level command).
 */
export function updateFormDetailColumn(
  draft: TemplateAuthoringDraft,
  fieldLocalId: string,
  columnLocalId: string,
  patch: FormDetailColumnPropertyPatch,
): FormCommandResult {
  const located = locateDetailColumn(draft, fieldLocalId, columnLocalId)
  if (isRejection(located)) return located
  if (!DETAIL_LEAF_FIELD_TYPES.includes(located.column.type))
    return rejected('unsupported_field_type')
  const next: DetailColumnDraft = {
    ...located.column,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.required !== undefined ? { required: patch.required } : {}),
    ...(patch.optionsText !== undefined
      ? { optionsText: patch.optionsText }
      : {}),
  }
  return withReplacedColumn(draft, located, next)
}

/**
 * F3 detail-column retype (master M3 detail-column retype semantics). Column
 * identity (`id`/`localId`) is PRESERVED by construction. Boundary targets are
 * NAMED refusals, never generic errors: `detail` (one nesting level) →
 * `detail_config`; `record-link` (top-level only) → `record_link_config`;
 * `attachment` → `attachment_boundary`. Any current-draft reference to the
 * column (amount mapping / dotted rules / `{owner.column}` formulas /
 * preserved payloads) blocks the type change under the same conservative v1
 * floor as `retypeFormField`.
 */
export function retypeFormDetailColumn(
  draft: TemplateAuthoringDraft,
  fieldLocalId: string,
  columnLocalId: string,
  nextType: FormFieldType,
): FormCommandResult {
  const located = locateDetailColumn(draft, fieldLocalId, columnLocalId)
  if (isRejection(located)) return located
  const { owner, column } = located
  // Fail-closed on a non-leaf CURRENT column type (P3-1 posture) before the
  // same-type no-op, mirroring the field-level ordering.
  if (!DETAIL_LEAF_FIELD_TYPES.includes(column.type))
    return rejected('unsupported_field_type')
  if (nextType === column.type) {
    return successful({ ...draft, fields: draft.fields.slice() }, owner.localId)
  }
  const boundaryLocation = `fields.${owner.localId}.detailColumns.${column.localId}`
  if (nextType === 'attachment') {
    return rejected('field_type_incompatible_with_references', [
      { kind: 'attachment_boundary', location: boundaryLocation },
    ])
  }
  if (nextType === 'detail') {
    return rejected('field_type_incompatible_with_references', [
      { kind: 'detail_config', location: boundaryLocation },
    ])
  }
  if (nextType === 'record-link') {
    return rejected('field_type_incompatible_with_references', [
      { kind: 'record_link_config', location: boundaryLocation },
    ])
  }
  if (!DETAIL_LEAF_FIELD_TYPES.includes(nextType))
    return rejected('unsupported_field_type')

  const dependencies = collectFormDetailColumnDependencies(
    draft,
    owner.id,
    column.id,
  )
  if (dependencies.length > 0)
    return rejected('field_type_incompatible_with_references', dependencies)

  return withReplacedColumn(draft, located, { ...column, type: nextType })
}

/**
 * Remove one detail column. The LAST column is refused with the named
 * `last_detail_column_removal_forbidden` (a detail field needs >=1 column —
 * same command-level integrity posture as `last_field_removal_forbidden`);
 * a referenced column is the named `field_is_referenced` refusal with the
 * full dependency list. Zero mutation on refusal.
 */
export function removeFormDetailColumn(
  draft: TemplateAuthoringDraft,
  fieldLocalId: string,
  columnLocalId: string,
): FormCommandResult {
  const located = locateDetailColumn(draft, fieldLocalId, columnLocalId)
  if (isRejection(located)) return located
  const { owner, column } = located
  if (owner.detailColumns.length <= 1) {
    return rejected('last_detail_column_removal_forbidden')
  }
  const dependencies = collectFormDetailColumnDependencies(
    draft,
    owner.id,
    column.id,
  )
  if (dependencies.length > 0)
    return rejected('field_is_referenced', dependencies)

  const detailColumns = owner.detailColumns.filter(
    (candidate) => candidate.localId !== columnLocalId,
  )
  const fields = [...draft.fields]
  fields[located.fieldIndex] = { ...owner, detailColumns }
  return successful({ ...draft, fields }, owner.localId)
}

/**
 * Canonical semantic move used by both drag placement and keyboard controls.
 * Both input modalities invoke this one function, so they cannot disagree on
 * ordering semantics.
 */
export function moveFormField(
  draft: TemplateAuthoringDraft,
  movingLocalId: string,
  targetLocalId: string,
  placement: 'before' | 'after',
): FormCommandResult {
  const from = draft.fields.findIndex(
    (field) => field.localId === movingLocalId,
  )
  const target = draft.fields.findIndex(
    (field) => field.localId === targetLocalId,
  )
  if (from === -1) return rejected('field_not_found')
  if (target === -1) return rejected('target_not_found')
  if (from === target)
    return successful({ ...draft, fields: draft.fields.slice() }, movingLocalId)

  const fields = draft.fields.slice()
  const [moving] = fields.splice(from, 1)
  const targetAfterRemoval = fields.findIndex(
    (field) => field.localId === targetLocalId,
  )
  const insertAt =
    placement === 'before' ? targetAfterRemoval : targetAfterRemoval + 1
  fields.splice(insertAt, 0, moving)
  return successful({ ...draft, fields }, movingLocalId)
}

/** Keyboard equivalent of drag placement. */
export function moveFormFieldByOffset(
  draft: TemplateAuthoringDraft,
  localId: string,
  offset: -1 | 1,
): FormCommandResult {
  const from = draft.fields.findIndex((field) => field.localId === localId)
  if (from === -1) return rejected('field_not_found')
  const target = from + offset
  if (target < 0 || target >= draft.fields.length) {
    return successful({ ...draft, fields: draft.fields.slice() }, localId)
  }
  return moveFormField(
    draft,
    localId,
    draft.fields[target].localId,
    offset < 0 ? 'before' : 'after',
  )
}

/** Empty command sequences preserve a legacy draft by identity. */
export function applyFormCommands(
  draft: TemplateAuthoringDraft,
  commands: readonly ((current: TemplateAuthoringDraft) => FormCommandResult)[],
): FormCommandResult {
  let current = draft
  let focusLocalId: string | null = null
  for (const command of commands) {
    const result = command(current)
    if (!result.ok) return result
    current = result.draft
    focusLocalId = result.focusLocalId
  }
  return successful(current, focusLocalId)
}
