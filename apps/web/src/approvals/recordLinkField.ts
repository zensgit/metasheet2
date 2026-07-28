import type { FormField, FormFieldType } from '../types/approval'

/**
 * Pure helpers for the FWB-0 Layer 2 `record-link` approval form field.
 *
 * Contract (backend authority: ApprovalGraphExecutor.parseRecordLinkFormValue +
 * ApprovalProductService.normalizeFormField):
 *   - top-level only (never a detail leaf);
 *   - props.baseId + props.sheetId are non-blank server-pinned strings (persisted invisibly;
 *     ordinary authoring UI never shows raw IDs);
 *   - value shape is exactly one object `{ recordId: non-blank string }` —
 *     no arrays, free-text ids, or extra target overrides;
 *   - display never falls back to a raw record id (human label or generic selected-record).
 *
 * These helpers mirror that shape for authoring/fill UI and unit tests; the
 * server remains the security boundary (publish creator read + submit filler read).
 */

/** Values-free label when a saved pin is not among currently readable bases/sheets. */
export const RECORD_LINK_TARGET_UNAVAILABLE = '目标不可用'

/** Display when a record is selected but no human summary is available (never raw recordId). */
export const RECORD_LINK_SELECTED_GENERIC = '已选择记录'

/** Values-free client hint (server re-validates with the same no-oracle shape). */
export const RECORD_LINK_VALUE_HINT =
  '请选择一条关联记录（仅支持单条；提交时服务端按读权限校验）'

export interface RecordLinkNamedOption {
  id: string
  name: string
}

/** True when the field is a record-link (top-level product type). */
export function isRecordLinkField(field: Pick<FormField, 'type'>): boolean {
  return field.type === 'record-link'
}

/** Structural parse: exactly `{ recordId: non-blank string }` after trim. */
export function parseRecordLinkValue(
  value: unknown,
): { ok: true; recordId: string } | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length !== 1 || keys[0] !== 'recordId') return { ok: false }
  const recordId = (value as { recordId?: unknown }).recordId
  if (typeof recordId !== 'string' || !recordId.trim()) return { ok: false }
  return { ok: true, recordId: recordId.trim() }
}

export function isValidRecordLinkValue(value: unknown): boolean {
  return parseRecordLinkValue(value).ok
}

/** Authoring pins: both props must be non-blank strings. */
export function hasPinnedRecordLinkTarget(
  props: Record<string, unknown> | null | undefined,
): boolean {
  if (!props || typeof props !== 'object') return false
  const baseId = typeof props.baseId === 'string' ? props.baseId.trim() : ''
  const sheetId = typeof props.sheetId === 'string' ? props.sheetId.trim() : ''
  return baseId.length > 0 && sheetId.length > 0
}

export function recordLinkSheetId(field: Pick<FormField, 'props'>): string {
  const props = field.props && typeof field.props === 'object' ? field.props : null
  return props && typeof props.sheetId === 'string' ? props.sheetId.trim() : ''
}

export function recordLinkBaseId(field: Pick<FormField, 'props'>): string {
  const props = field.props && typeof field.props === 'object' ? field.props : null
  return props && typeof props.baseId === 'string' ? props.baseId.trim() : ''
}

/** Type-guard helper for authoring allowlists (mirrors backend FORM_FIELD_TYPES membership). */
export function isRecordLinkType(type: FormFieldType): boolean {
  return type === 'record-link'
}

/**
 * Whether a field type may appear in visibility/condition/formula selectors (v1).
 * record-link and detail are server-rejected as simple condition/visibility dependencies.
 */
export function isSelectableConditionOrVisibilityDependencyType(type: FormFieldType | string): boolean {
  return type !== 'record-link' && type !== 'detail'
}

/**
 * Drop visibility dependsOn / condition rule fieldIds that point at banned types after a retype.
 * Pure helper for authoring + unit tests.
 */
export function clearStaleRecordLinkDependencies<T extends {
  id: string
  type: string
  visibility?: { dependsOnFieldId: string; operator: string; valueText: string }
}>(
  fields: T[],
  conditionRules: Array<{ fieldId: string }>,
  changedFieldId: string,
  changedType: string,
): { fields: T[]; conditionRules: Array<{ fieldId: string }> } {
  if (changedType !== 'record-link' && changedType !== 'detail') {
    return { fields, conditionRules }
  }
  const id = changedFieldId.trim()
  if (!id) return { fields, conditionRules }
  const nextFields = fields.map((field) => {
    if (!field.visibility || field.visibility.dependsOnFieldId.trim() !== id) return field
    return {
      ...field,
      visibility: { dependsOnFieldId: '', operator: 'eq', valueText: '' },
    }
  })
  const nextRules = conditionRules.map((rule) => (
    rule.fieldId.trim() === id ? { ...rule, fieldId: '' } : rule
  ))
  return { fields: nextFields, conditionRules: nextRules }
}

/**
 * Fill / detail display: human label when available; otherwise a generic selected-record
 * label. NEVER falls back to the raw recordId (existence / id oracle surface).
 */
export function formatRecordLinkDisplay(humanLabel: string | null | undefined): string {
  const label = typeof humanLabel === 'string' ? humanLabel.trim() : ''
  return label || RECORD_LINK_SELECTED_GENERIC
}

/**
 * Authoring option label for a named multitable entity. Prefer the human name; when the name is
 * blank, use a values-free placeholder (never echo the id into ordinary UI).
 */
export function formatNamedOptionLabel(name: string | null | undefined): string {
  const n = typeof name === 'string' ? name.trim() : ''
  return n || RECORD_LINK_TARGET_UNAVAILABLE
}

/**
 * Resolve a human label for a saved pin among currently loaded options.
 * Missing/blank/unavailable → values-free `RECORD_LINK_TARGET_UNAVAILABLE` (never raw id).
 */
export function resolvePinnedTargetLabel(
  options: readonly RecordLinkNamedOption[],
  pinnedId: string | null | undefined,
): string {
  const id = typeof pinnedId === 'string' ? pinnedId.trim() : ''
  if (!id) return ''
  const match = options.find((opt) => opt.id === id)
  if (!match) return RECORD_LINK_TARGET_UNAVAILABLE
  const name = typeof match.name === 'string' ? match.name.trim() : ''
  return name || RECORD_LINK_TARGET_UNAVAILABLE
}

/**
 * el-select options for bases. Does not surface raw ids as labels.
 * When the current pin is absent from the list, append a values-free "unavailable" option so the
 * select can still bind without echoing the id into ordinary UI copy.
 */
export function buildRecordLinkBaseSelectOptions(
  bases: readonly RecordLinkNamedOption[],
  currentBaseId: string | null | undefined,
): Array<{ value: string; label: string }> {
  const options = bases
    .filter((b) => typeof b.id === 'string' && b.id.trim())
    .map((b) => ({
      value: b.id.trim(),
      label: formatNamedOptionLabel(b.name),
    }))
  const current = typeof currentBaseId === 'string' ? currentBaseId.trim() : ''
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: RECORD_LINK_TARGET_UNAVAILABLE })
  }
  return options
}

/**
 * el-select options for sheets scoped to a base. Same unavailable pin discipline as bases.
 */
export function buildRecordLinkSheetSelectOptions(
  sheets: readonly (RecordLinkNamedOption & { baseId?: string | null })[],
  baseId: string | null | undefined,
  currentSheetId: string | null | undefined,
): Array<{ value: string; label: string }> {
  const base = typeof baseId === 'string' ? baseId.trim() : ''
  const scoped = sheets.filter((s) => {
    if (typeof s.id !== 'string' || !s.id.trim()) return false
    if (!base) return false
    const sheetBase = typeof s.baseId === 'string' ? s.baseId.trim() : ''
    return sheetBase === base
  })
  const options = scoped.map((s) => ({
    value: s.id.trim(),
    label: formatNamedOptionLabel(s.name),
  }))
  const current = typeof currentSheetId === 'string' ? currentSheetId.trim() : ''
  if (current && !options.some((o) => o.value === current)) {
    options.unshift({ value: current, label: RECORD_LINK_TARGET_UNAVAILABLE })
  }
  return options
}

/**
 * When the multitable catalog has successfully loaded, prove a saved record-link pin is still
 * a sheet that belongs to the pinned base. Missing sheet or sheet.baseId mismatch → values-free
 * error (never echo raw ids). Server remains authority; this only blocks client save when the
 * loaded catalog can prove the pin is invalid.
 *
 * Returns null when the catalog is not loaded yet, pins are blank (handled elsewhere), or the
 * pin is consistent with the catalog.
 */
export function validateRecordLinkPinAgainstLoadedCatalog(
  field: {
    label?: string
    /** Present on draft fields; never used in user-facing mismatch copy (no internal-id oracle). */
    id?: string
    recordLinkBaseId?: string
    recordLinkSheetId?: string
  },
  catalog: {
    loaded: boolean
    sheets: ReadonlyArray<{ id: string; baseId?: string | null }>
  },
): string | null {
  if (!catalog.loaded) return null
  const baseId = typeof field.recordLinkBaseId === 'string' ? field.recordLinkBaseId.trim() : ''
  const sheetId = typeof field.recordLinkSheetId === 'string' ? field.recordLinkSheetId.trim() : ''
  if (!baseId || !sheetId) return null
  // Human label only — never field.id (ordinary users must not see internal ids).
  const humanLabel = typeof field.label === 'string' ? field.label.trim() : ''
  const label = humanLabel || '该字段'
  const match = catalog.sheets.find((s) => typeof s.id === 'string' && s.id.trim() === sheetId)
  if (!match) {
    return `字段 ${label}（关联记录）目标不可用，请重新选择目标空间与目标表`
  }
  const sheetBase = typeof match.baseId === 'string' ? match.baseId.trim() : ''
  // Catalog row must carry base membership to prove mismatch; absent baseId → cannot prove client-side.
  if (sheetBase && sheetBase !== baseId) {
    return `字段 ${label}（关联记录）目标不可用，请重新选择目标空间与目标表`
  }
  return null
}
