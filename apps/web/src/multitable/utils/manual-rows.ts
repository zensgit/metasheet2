// 人工补充行 (manual supplementary rows) — the web half of ADR adr-stock-prep-manual-rows-20261030, slice B3: the PURE
// rules the workbench, the grid and the drawer share. No IO, no component state.
//
// WHERE THE GATE IS (ADR §3.7; #6664 note N2). Every editing control — 「新增人工补充行」, 「复制为新行」, the routing of the
// six fillable cells to PATCH /records/:recordId/manual-fields — is gated on /context's `stockPreparationManualRows`
// block: only the block says the sheet is a registered project sheet (P_reg), in which state, and that THIS actor may
// act (it is sent only to an actor who can create, edit or delete). The row mark `rowActions.manualSupplement` is a
// DISPLAY label (OQ3) that reaches every reader; it only says WHICH row is a manual row, never that anyone may edit it.
//
// FIELD PERMISSIONS (#6664 note N5). The block's id lists are sheet-level; the actor's per-subject field permissions
// narrow them here. The host folds the PLM column lock into `fieldPermissions.readOnly`
// (packages/core-backend/src/multitable/permission-derivation.ts isFieldReadOnlyForPeople), so on a LOCKED column
// `readOnly: true` says nothing about the actor and only `visible` is read; on an unlocked column both are. The manual-row
// routes re-check the per-subject rule on their own (a 403 there is surfaced as any other write failure).
//
// FAIL CLOSED. A block that is present but not well formed reads as `unavailable` with no ids: the generic create entries
// stay hidden (the sheet IS a project sheet as far as the server said), and no manual-row control appears.

import type {
  MetaField,
  MetaFieldPermission,
  MetaManualRowsBlock,
  MetaManualRowsUnavailableReason,
  MetaRowActions,
} from '../types'
import { isFieldAlwaysReadOnly, isFieldHumanWriteLocked, isPropertyHiddenField } from './field-permissions'
import type { ManualRowLabelKey } from './manual-row-labels'
import { isSystemField } from './system-fields'

export const MANUAL_ROWS_CONTEXT_KEY = 'stockPreparationManualRows' as const

export const MANUAL_ROWS_UNAVAILABLE_REASONS: readonly MetaManualRowsUnavailableReason[] = Object.freeze([
  'lock_missing', 'project_archived', 'project_sheets_off', 'contract_mismatch', 'registry_unreadable',
] as const)

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) if (typeof item === 'string' && item.trim() !== '' && !out.includes(item)) out.push(item)
  return out
}

function malformedBlock(): MetaManualRowsBlock {
  return { state: 'unavailable', editableFieldIds: [], requiredFieldIds: [], dialogFieldIds: [] }
}

/**
 * /context `capabilities.stockPreparationManualRows`, read fail-closed. Absent (or a capabilities source that is not an
 * object — the role-string fallback) → null: exactly the old behaviour. Present but malformed → `unavailable` with no ids.
 */
export function readManualRowsBlock(capabilities: unknown): MetaManualRowsBlock | null {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return null
  if (!Object.prototype.hasOwnProperty.call(capabilities, MANUAL_ROWS_CONTEXT_KEY)) return null
  const raw = (capabilities as Record<string, unknown>)[MANUAL_ROWS_CONTEXT_KEY]
  if (raw === undefined) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return malformedBlock()
  const block = raw as Record<string, unknown>
  const state = block.state
  if (state !== 'allowed' && state !== 'disabled' && state !== 'unavailable') return malformedBlock()
  const read: MetaManualRowsBlock = {
    state,
    editableFieldIds: idList(block.editableFieldIds),
    requiredFieldIds: idList(block.requiredFieldIds),
    dialogFieldIds: idList(block.dialogFieldIds),
  }
  if (state === 'unavailable' && typeof block.reason === 'string' && block.reason.trim() !== '') read.reason = block.reason
  return read
}

/** May a person ADD (新增 / 复制为新行) on this block's sheet? Only in state `allowed` (ADR §3.1: the one state that points at the entry). */
export function manualRowsCreateEnabled(block: MetaManualRowsBlock | null | undefined): boolean {
  return block?.state === 'allowed'
}

/**
 * May the six fillable cells of a manual row be edited through PATCH …/manual-fields? The edit route needs the
 * registered sheet, its structure and the key column's lock (ADR §3.4); the per-sheet switch, an archived project and
 * the deployment switch do NOT stop an edit (§4 「关闭的含义」, §6, the host's evaluateManualRowsGate mode 'edit'). The
 * create state tells the web which of those it is: `allowed` / `disabled`, or `unavailable` for an archived project or the
 * deployment switch. `lock_missing` (the sheet needs repair), `contract_mismatch`, `registry_unreadable` and an unknown
 * reason keep the cells as they are (fail closed).
 */
export function manualRowsEditEnabled(block: MetaManualRowsBlock | null | undefined): boolean {
  if (!block) return false
  if (block.state === 'allowed' || block.state === 'disabled') return true
  return block.state === 'unavailable' && (block.reason === 'project_archived' || block.reason === 'project_sheets_off')
}

/** The display mark (OQ3). Never an editing gate on its own. */
export function isManualSupplementMarked(rowActions: Pick<MetaRowActions, 'manualSupplement'> | null | undefined): boolean {
  return rowActions?.manualSupplement === true
}

export type ManualRowFieldAccess = 'writable' | 'read_only' | 'hidden' | 'absent'

/**
 * N5: what the actor's field permissions allow on one column of the block. `viewHiddenFieldIds` (the create dialog only)
 * names the columns the CURRENT VIEW hides: the host folds a view's hidden ids into `fieldPermissions.visible` too, so for
 * those a `visible: false` may be the view rather than a permission — the dialog still offers them (the 填写视图 hides
 * 单层用量), and the create route re-checks the per-subject rule. A column that is not view-hidden and reads
 * `visible: false` is hidden for this actor.
 */
export function manualRowFieldAccess(
  field: MetaField | null | undefined,
  permission: MetaFieldPermission | null | undefined,
  viewHiddenFieldIds?: ReadonlySet<string>,
): ManualRowFieldAccess {
  if (!field) return 'absent'
  if (isPropertyHiddenField(field)) return 'hidden'
  if (permission?.visible === false && !(viewHiddenFieldIds?.has(field.id) ?? false)) return 'hidden'
  if (isSystemField(field) || isFieldAlwaysReadOnly(field)) return 'read_only'
  // On a locked column the lock alone makes `readOnly` true (the host folds it in) — it carries no per-subject answer.
  if (permission?.readOnly === true && !isFieldHumanWriteLocked(field)) return 'read_only'
  return 'writable'
}

/**
 * The fillable columns this actor may edit on a manual row (grid single-cell edit and the drawer): the block's
 * `editableFieldIds` ∩ the actor's field permissions (N5), or none when the block does not allow editing.
 */
export function resolveManualRowEditableFieldIds(
  block: MetaManualRowsBlock | null | undefined,
  fields: readonly MetaField[],
  fieldPermissions: Readonly<Record<string, MetaFieldPermission>> | null | undefined,
): string[] {
  if (!block || !manualRowsEditEnabled(block)) return []
  const byId = new Map(fields.map((field) => [field.id, field]))
  return block.editableFieldIds.filter((id) => manualRowFieldAccess(byId.get(id), fieldPermissions?.[id]) === 'writable')
}

/** Cell types the 新增 dialog renders a control for; any other required column blocks the dialog (fill it in the grid). */
export const MANUAL_ROW_DIALOG_INPUT_TYPES: ReadonlySet<string> = new Set([
  'string', 'longText', 'number', 'currency', 'percent', 'rating', 'date', 'boolean', 'select',
])

export type ManualRowDialogField = { field: MetaField; required: boolean }
export type ManualRowDialogPlan = {
  fields: ManualRowDialogField[]
  /** Required columns the actor cannot fill here (hidden / read-only for them, or a type the dialog cannot render). */
  blockedRequiredCount: number
}

/**
 * The 新增人工补充行 dialog (ADR §8 B3.3: 名称*、总用量*、图号、规格、材质、用量、备注): the block's `dialogFieldIds` in their
 * order, then any other `requiredFieldIds` (a column whose own validation requires it must be offered, or the create
 * fails), each ∩ the actor's field permissions (N5). A server that sends no `dialogFieldIds` falls back to the required
 * columns, then the editable ones. Required marks come from `requiredFieldIds` only (名称 and 总用量 on the template).
 */
export function resolveManualRowDialogPlan(
  block: MetaManualRowsBlock | null | undefined,
  fields: readonly MetaField[],
  fieldPermissions: Readonly<Record<string, MetaFieldPermission>> | null | undefined,
  viewHiddenFieldIds?: ReadonlySet<string>,
): ManualRowDialogPlan {
  if (!block) return { fields: [], blockedRequiredCount: 0 }
  const byId = new Map(fields.map((field) => [field.id, field]))
  const required = new Set(block.requiredFieldIds)
  const base = block.dialogFieldIds.length > 0 ? block.dialogFieldIds : [...block.requiredFieldIds, ...block.editableFieldIds]
  const order: string[] = []
  for (const id of [...base, ...block.requiredFieldIds]) if (!order.includes(id)) order.push(id)
  const plan: ManualRowDialogPlan = { fields: [], blockedRequiredCount: 0 }
  for (const id of order) {
    const field = byId.get(id)
    const access = manualRowFieldAccess(field, fieldPermissions?.[id], viewHiddenFieldIds)
    const renderable = !!field && MANUAL_ROW_DIALOG_INPUT_TYPES.has(field.type)
    if (field && access === 'writable' && renderable) {
      plan.fields.push({ field, required: required.has(id) })
    } else if (required.has(id)) {
      plan.blockedRequiredCount += 1
    }
  }
  return plan
}

/** A dialog value that counts as "not filled". */
export function isBlankManualRowValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (typeof value === 'number') return !Number.isFinite(value)
  return false
}

/** What the workbench shows where the generic create entries were: the 新增 entry, or the state's reason. */
export type ManualRowsNotice =
  | { kind: 'entry' }
  | { kind: 'reason'; key: ManualRowLabelKey; headlineKey?: ManualRowLabelKey }

const UNAVAILABLE_REASON_KEYS: Readonly<Record<MetaManualRowsUnavailableReason, ManualRowLabelKey>> = Object.freeze({
  lock_missing: 'reason.lockMissing',
  project_archived: 'reason.projectArchived',
  project_sheets_off: 'reason.projectSheetsOff',
  contract_mismatch: 'reason.contractMismatch',
  registry_unreadable: 'reason.registryUnreadable',
})

/** ADR §3.1: only `allowed` points at 「新增人工补充行」; every other state says why rows cannot be added. */
export function manualRowsNoticeOf(block: MetaManualRowsBlock): ManualRowsNotice {
  if (block.state === 'allowed') return { kind: 'entry' }
  if (block.state === 'disabled') return { kind: 'reason', key: 'reason.disabled' }
  const reason = block.reason as MetaManualRowsUnavailableReason | undefined
  if (reason === 'lock_missing') return { kind: 'reason', key: 'reason.lockMissing', headlineKey: 'reason.lockMissingHeadline' }
  const key = reason && Object.prototype.hasOwnProperty.call(UNAVAILABLE_REASON_KEYS, reason) ? UNAVAILABLE_REASON_KEYS[reason] : 'reason.unavailable'
  return { kind: 'reason', key }
}

/** The toast a refused generic-create gesture shows on a P_reg sheet (a stale emit): the same text as the note. */
export function manualRowsCreateRefusalKey(block: MetaManualRowsBlock): ManualRowLabelKey {
  const notice = manualRowsNoticeOf(block)
  return notice.kind === 'entry' ? 'notice.useManualRow' : notice.key
}
