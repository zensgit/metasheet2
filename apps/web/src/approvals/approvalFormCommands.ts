import type { DetailColumnDraft } from './detailField'
import type {
  AuthorableFieldType,
  FieldAuthoringDraft,
  TemplateAuthoringDraft,
} from './templateAuthoring'

/**
 * D6-f1 form command algebra. These commands use `localId` only as a view-model
 * selection key. It is never rendered as, or accepted from, ordinary-user input;
 * persisted field ids remain owned by the existing template-authoring serializer.
 */

export type FormCommandFailureReason =
  | 'field_not_found'
  | 'target_not_found'
  | 'unsupported_field_type'
  | 'invalid_field_identity'
  | 'identity_history_missing'
  | 'field_identity_conflict'
  | 'reference_inventory_missing'
  | 'field_is_referenced'

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
 * FWB mappings and future persisted integrations are not stored on the authoring
 * draft. A delete must receive a complete inventory from their owner rather than
 * assuming that no out-of-draft reference exists.
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
 * An identity allocated by the authoring session's durable identity owner. It is
 * an internal command input, not a normal-user field-id API. The pure command
 * deliberately never derives persistent IDs from the current draft: a deleted
 * maximum suffix must not become a later field's identity.
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

/**
 * Complete reservation history for the template's published versions and current
 * draft. D6-f2's durable identity allocator must maintain this set as fields or
 * detail columns are introduced and retired. D6-f1 uses it as a fail-closed
 * command input now, so correctness is not left to an unverified caller policy.
 */
export interface CompleteFormIdentityHistory {
  readonly complete: true
  readonly persistentIds: readonly string[]
  readonly localIds: readonly string[]
}

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

function isCompleteIdentityHistory(
  history: CompleteFormIdentityHistory | undefined,
): history is CompleteFormIdentityHistory {
  return Boolean(
    history &&
      history.complete === true &&
      Array.isArray(history.persistentIds) &&
      Array.isArray(history.localIds) &&
      history.persistentIds.every(nonBlank) &&
      history.localIds.every(nonBlank),
  )
}

function identityConflicts(
  draft: TemplateAuthoringDraft,
  identity: FormFieldIdentity,
  history: CompleteFormIdentityHistory,
): boolean {
  const reserved = new Set<string>([
    ...history.persistentIds,
    ...history.localIds,
  ])
  draft.fields.forEach((field) => {
    reserved.add(field.id)
    reserved.add(field.localId)
    field.detailColumns.forEach((column) => {
      reserved.add(column.id)
      reserved.add(column.localId)
    })
  })
  const candidates = [
    identity.persistentId,
    identity.localId,
    ...(identity.detailColumn
      ? [identity.detailColumn.persistentId, identity.detailColumn.localId]
      : []),
  ]
  if (new Set(candidates).size !== candidates.length) {
    return true
  }
  return candidates.some((candidate) => reserved.has(candidate))
}

/**
 * Add a supported top-level field at the selected location. The caller supplies
 * a durable identity, making this pure command deterministic for retries while
 * preventing the old max-suffix allocator from reusing deleted persistent IDs.
 * Its complete history is mandatory: without it a deleted identity cannot be
 * distinguished from one that was never allocated, so add fails closed.
 */
export function addFormField(
  draft: TemplateAuthoringDraft,
  fieldType: AuthorableFieldType,
  identity: FormFieldIdentity,
  history: CompleteFormIdentityHistory,
  afterLocalId?: string,
): FormCommandResult {
  if (!AUTHORABLE_FIELD_TYPES.has(fieldType))
    return rejected('unsupported_field_type')
  if (!isUsableIdentity(fieldType, identity))
    return rejected('invalid_field_identity')
  if (!isCompleteIdentityHistory(history))
    return rejected('identity_history_missing')
  if (identityConflicts(draft, identity, history))
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
  }

  if (!afterLocalId) {
    return successful(
      { ...draft, fields: [...draft.fields, field] },
      field.localId,
    )
  }

  const index = draft.fields.findIndex(
    (candidate) => candidate.localId === afterLocalId,
  )
  if (index === -1) return rejected('target_not_found')
  const fields = [...draft.fields]
  fields.splice(index + 1, 0, field)
  return successful({ ...draft, fields }, field.localId)
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
 * Enumerate every reference represented by the current authoring draft. The
 * inventory is deliberately conservative: an unrecognised graph `fieldId` or
 * formula token blocks delete rather than being rewritten to another field.
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
 * Remove only an unreferenced field. The reference inventory is required because
 * writeback mappings are owned outside this draft; omission is a fail-closed
 * refusal, never an assumption that no mapping exists.
 */
export function removeFormField(
  draft: TemplateAuthoringDraft,
  localId: string,
  inventory?: CompleteFormReferenceInventory,
): FormCommandResult {
  const index = draft.fields.findIndex((field) => field.localId === localId)
  if (index === -1) return rejected('field_not_found')
  if (
    !inventory ||
    inventory.complete !== true ||
    !Array.isArray(inventory.references)
  ) {
    return rejected('reference_inventory_missing')
  }
  const dependencies = collectFormFieldDependencies(
    draft,
    draft.fields[index].id,
    inventory,
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
