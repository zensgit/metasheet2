import type { DetailColumnDraft } from './detailField'
import type {
  AuthorableFieldType,
  FieldAuthoringDraft,
  TemplateAuthoringDraft,
} from './templateAuthoring'

/**
 * D6-f1 form command algebra, amended by F1 of the RATIFIED
 * approval-form-builder-parity delta (FB-D3 anchors, FB-D5
 * `OPAQUE_COLLISION_RESISTANT` identity, FB-D6
 * `CURRENT_DRAFT_REFERENCES_PLUS_VERSION_PINNED_EXTERNALS` delete boundary).
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
}

const AUTHORABLE_FIELD_TYPES = new Set<AuthorableFieldType>(
  Object.keys(FIELD_LABELS) as AuthorableFieldType[],
)

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

function formulaReferencesField(value: string, fieldId: string): boolean {
  const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\{${escaped}(?:\\.[^{}]+)?\\}`).test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectPreservedGraphReferences(
  value: unknown,
  fieldId: string,
  location: string,
  dependencies: FormFieldDependency[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectPreservedGraphReferences(
        entry,
        fieldId,
        `${location}[${index}]`,
        dependencies,
      ),
    )
    return
  }
  if (!isRecord(value)) return

  if (value.fieldId === fieldId) {
    dependencies.push({ kind: 'preserved_graph_reference', location })
  }
  if (
    typeof value.expression === 'string' &&
    formulaReferencesField(value.expression, fieldId)
  ) {
    dependencies.push({ kind: 'condition_formula', location })
  }
  Object.entries(value).forEach(([key, entry]) => {
    if (key !== 'fieldId' && key !== 'expression') {
      collectPreservedGraphReferences(
        entry,
        fieldId,
        `${location}.${key}`,
        dependencies,
      )
    }
  })
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
    if (
      field.id !== fieldId &&
      field.visibility.dependsOnFieldId.trim() === fieldId
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
      step.fieldPermissions.some((permission) => permission.fieldId === fieldId)
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
    (mapping.totalFieldId === fieldId || mapping.detailFieldId === fieldId)
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
