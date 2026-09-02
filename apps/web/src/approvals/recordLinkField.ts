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
 * Whether a field type may appear in visibility/condition/formula selectors as a WHOLE-VALUE
 * dependency (v1). record-link and detail are server-rejected as simple condition/visibility
 * dependencies (non-scalar values). Lock-8 L8-B (approval-lock8-field-vocabulary-20260817.md §1.2,
 * OD-L8-5(a)) extends the same exclusion to `date_range` — its `{ start, end }` value is also
 * non-scalar and "never as one comparable value"; its two endpoints are separately selectable via
 * `dateRangeVisibilityEndpointOptions` below, a per-type ADDITIVE affordance, not a widening of
 * this boolean.
 *
 * Lock-8 L8-A (approval-lock8-field-vocabulary-20260817.md §1.1, MS-9) extends the SAME exclusion
 * to `explanation` — it carries no value at all (a stricter case than "non-scalar": there is
 * nothing to compare, ever), and unlike date_range it gets no endpoint fallback (it has none).
 */
export function isSelectableConditionOrVisibilityDependencyType(type: FormFieldType | string): boolean {
  return type !== 'record-link'
    && type !== 'detail'
    && type !== 'date_range'
    && type !== 'explanation'
    && type !== 'department'
}

/**
 * Lock-8 L8-B OD-L8-5(a): the sub-value choices a `date_range` field offers a visibility-rule
 * author (as `${fieldId}.start` / `${fieldId}.end` dotted addresses) — empty for every other type.
 * The UI affordance that turns a selected date_range field + endpoint choice into the dotted
 * `dependsOnFieldId` this array's caller must write (M7: no inert picker — selecting an endpoint
 * must produce a real, server-resolvable address).
 */
export function dateRangeVisibilityEndpointOptions(
  type: FormFieldType | string,
): ReadonlyArray<{ endpoint: 'start' | 'end'; label: string }> {
  if (type !== 'date_range') return []
  return [
    { endpoint: 'start', label: '起始' },
    { endpoint: 'end', label: '结束' },
  ]
}

/** Build the dotted `dependsOnFieldId` address for a date_range field's endpoint (OD-L8-5(a)). */
export function dateRangeVisibilityFieldId(fieldId: string, endpoint: 'start' | 'end'): string {
  return `${fieldId}.${endpoint}`
}

/**
 * Base field id a `dependsOnFieldId` string points at, stripping a Lock-8 OD-L8-5(a) dotted
 * endpoint suffix (`${id}.start` / `${id}.end`) when present. Used ONLY for dependency-tracking
 * (does this reference point at field X?) — not for evaluation, which needs the endpoint-aware
 * resolver in `fieldVisibility.ts`. A bare id with no dot returns unchanged.
 */
export function visibilityReferenceBaseFieldId(rawFieldId: string): string {
  const dot = rawFieldId.lastIndexOf('.')
  if (dot <= 0 || dot === rawFieldId.length - 1) return rawFieldId
  const suffix = rawFieldId.slice(dot + 1)
  return suffix === 'start' || suffix === 'end' ? rawFieldId.slice(0, dot) : rawFieldId
}

/**
 * Drop visibility dependsOn / condition rule fieldIds that point at banned types after a retype.
 * Pure helper for authoring + unit tests. Lock-8 L8-B: `date_range` joins record-link/detail as a
 * type whose retype-away must clear stale dependents — including a dotted endpoint address
 * (`${id}.start`/`${id}.end`), which `visibilityReferenceBaseFieldId` resolves to the same base id
 * a bare reference would use, so neither form survives orphaned. Lock-8 L8-A: `explanation` joins
 * too, matching record-link/detail's ONE-direction shape (nothing could ever validly have
 * depended on it, so only "became explanation" needs clearing — there is no endpoint fallback to
 * distinguish, unlike date_range).
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
  if (
    changedType !== 'record-link' &&
    changedType !== 'detail' &&
    changedType !== 'date_range' &&
    changedType !== 'explanation'
  ) {
    return { fields, conditionRules }
  }
  const id = changedFieldId.trim()
  if (!id) return { fields, conditionRules }
  const nextFields = fields.map((field) => {
    if (
      !field.visibility ||
      visibilityReferenceBaseFieldId(field.visibility.dependsOnFieldId.trim()) !== id
    ) {
      return field
    }
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
