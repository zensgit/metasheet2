import type { FormField, FormFieldType, FormOption, FormSchema } from '../types/approval'
import { getVisibleFormFields, pruneHiddenFormData } from './fieldVisibility'

/**
 * Pure (Element-Plus-free) helpers for the `detail` / sub-form (明细/子表单) field type.
 *
 * The Vue views (`ApprovalDetailView`, `ApprovalNewView`, `TemplateAuthoringView`) pull in
 * Element Plus CSS, which makes them un-importable under vitest. Everything testable about
 * detail rendering / authoring therefore lives here so it can be unit-tested directly.
 *
 * Mirrors the backend contract in `packages/core-backend/src/services/ApprovalProductService.ts`
 * (`normalizeDetailFieldParts`, `DETAIL_LEAF_FIELD_TYPES`): a `detail` field carries an ordered
 * `columns: FormField[]` of LEAF sub-fields (never another `detail` — one nesting level), plus
 * optional `minRows`/`maxRows`; a `detail` value is an array of row objects keyed by sub-field id.
 */

/**
 * Leaf sub-field types allowed inside a `detail` group's `columns` — the 8 authorable scalar
 * types (everything except `attachment`, which is not authorable, and `detail`, which would
 * nest). Mirrors backend `DETAIL_LEAF_FIELD_TYPES`.
 */
export const DETAIL_LEAF_FIELD_TYPES: readonly FormFieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'datetime',
  'select',
  'multi-select',
  'user',
]

export function isDetailLeafFieldType(type: FormFieldType): boolean {
  return DETAIL_LEAF_FIELD_TYPES.includes(type)
}

export function isDetailField(field: Pick<FormField, 'type'>): boolean {
  return field.type === 'detail'
}

/**
 * Editable draft of a single detail sub-field (`columns[]` entry). Kept narrow on purpose —
 * v1 authors id / type / label / required (+ select options); other leaf knobs ride `props`
 * server-side and are out of the v1 authoring UI.
 */
export interface DetailColumnDraft {
  localId: string
  id: string
  type: FormFieldType
  label: string
  required: boolean
  optionsText: string
  // The stored sub-field this draft hydrated from, preserved so backend-contract fields the v1
  // UI does NOT manage (`props` incl. min/max/pattern constraints, `placeholder`, `defaultValue`,
  // `visibilityRule`) round-trip intact instead of being silently flattened on save. Mirrors the
  // top-level `FieldAuthoringDraft.original` discipline.
  original?: FormField
}

let detailColumnSeq = 0

/** Stable-enough local id for `v-for` keying of unsaved sub-field rows. */
function nextDetailColumnLocalId(): string {
  detailColumnSeq += 1
  return `detailcol_${Date.now()}_${detailColumnSeq}`
}

export function createEmptyDetailColumnDraft(index = 1): DetailColumnDraft {
  return {
    localId: nextDetailColumnLocalId(),
    id: `col_${index}`,
    type: 'text',
    label: `子字段 ${index}`,
    required: false,
    optionsText: '',
  }
}

function formatOptionsText(options?: FormOption[]): string {
  return (options ?? []).map((option) => `${option.label}:${option.value}`).join('\n')
}

function parseOptionsText(value: string): FormOption[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':')
      if (separator === -1) return { label: line, value: line }
      return { label: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() }
    })
}

/** Hydrate editable sub-field drafts from a stored `detail` field's frozen `columns`. */
export function detailColumnDraftsFromField(field: FormField): DetailColumnDraft[] {
  return (field.columns ?? []).map((column) => ({
    localId: nextDetailColumnLocalId(),
    id: column.id,
    type: column.type,
    label: column.label,
    required: column.required === true,
    optionsText: formatOptionsText(column.options),
    original: column,
  }))
}

/**
 * Build the emitted `columns: FormField[]` for a detail field from its sub-field drafts. The
 * stored `original` is spread FIRST so unmanaged backend-contract fields (`props`, `placeholder`,
 * `defaultValue`, `visibilityRule`) survive, then only the UI-managed fields override it. `options`
 * is deleted for non-select types so a type change does not strand a stale options array from the
 * original (mirrors `buildFormSchema`'s top-level omit-empty discipline).
 */
export function buildDetailColumns(drafts: DetailColumnDraft[]): FormField[] {
  return drafts.map((draft) => {
    const base = draft.original ? { ...draft.original } : {}
    const column: FormField = {
      ...base,
      id: draft.id.trim(),
      type: draft.type,
      label: draft.label.trim(),
      required: draft.required,
    }
    if (draft.type === 'select' || draft.type === 'multi-select') {
      column.options = parseOptionsText(draft.optionsText)
    } else {
      delete column.options
    }
    return column
  })
}

/**
 * Client-side detail-columns validator, mirroring the backend `normalizeDetailFieldParts`
 * reject-set: non-empty columns; each sub-field id present + unique within the group; each
 * sub-field a leaf type (reject `detail` / unknown); select/multi-select needs >=1 option;
 * minRows/maxRows non-negative integers with `minRows <= maxRows`. `fieldLabel` prefixes each
 * message so the author can locate the offending detail field.
 *
 * `minRowsText`/`maxRowsText` are the raw input strings (`''` = unset); they are validated as
 * the authoring UI binds text inputs.
 */
export function validateDetailColumnsDraft(
  fieldLabel: string,
  columns: DetailColumnDraft[],
  minRowsText: string,
  maxRowsText: string,
): string[] {
  const errors: string[] = []
  const label = fieldLabel || '(未命名明细)'

  if (columns.length === 0) {
    errors.push(`明细字段 ${label} 至少需要一个子字段`)
  }

  const ids = columns.map((column) => column.id.trim())
  if (ids.some((id) => !id)) {
    errors.push(`明细字段 ${label} 的子字段 id 必填`)
  }
  const presentIds = ids.filter(Boolean)
  if (new Set(presentIds).size !== presentIds.length) {
    errors.push(`明细字段 ${label} 的子字段 id 不能重复`)
  }

  columns.forEach((column) => {
    const columnLabel = column.label.trim() || column.id.trim() || '(未命名)'
    if (!column.label.trim()) {
      errors.push(`明细字段 ${label} 的子字段 ${column.id.trim() || '(未命名)'} 名称必填`)
    }
    if (!isDetailLeafFieldType(column.type)) {
      // Guards against `detail` (no nesting) and any unknown leaf type.
      errors.push(`明细字段 ${label} 的子字段 ${columnLabel} 类型不支持`)
    }
    if (column.type === 'select' || column.type === 'multi-select') {
      const options = parseOptionsText(column.optionsText)
      if (options.length === 0) {
        errors.push(`明细字段 ${label} 的子字段 ${columnLabel} 需要至少一个选项`)
      } else if (options.some((option) => !option.label.trim() || !option.value.trim())) {
        errors.push(`明细字段 ${label} 的子字段 ${columnLabel} 的选项 label/value 不能为空`)
      }
    }
  })

  const minRows = parseRowBound(minRowsText)
  const maxRows = parseRowBound(maxRowsText)
  if (minRows === 'invalid') errors.push(`明细字段 ${label} 的最小行数必须是非负整数`)
  if (maxRows === 'invalid') errors.push(`明细字段 ${label} 的最大行数必须是非负整数`)
  if (
    typeof minRows === 'number'
    && typeof maxRows === 'number'
    && minRows > maxRows
  ) {
    errors.push(`明细字段 ${label} 的最小行数不能大于最大行数`)
  }

  return errors
}

/** Parse a row-bound text input → number | undefined (unset) | 'invalid' (non-negative-int rule). */
export function parseRowBound(value: string): number | undefined | 'invalid' {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < 0) return 'invalid'
  return parsed
}

/**
 * Build an empty fill row for a detail field's `columns`: each leaf cell seeded with a sensible
 * empty value (`[]` for multi-select so the multi `el-select` binds an array; `undefined`
 * otherwise). Pure → unit-tested; the fill view appends the result to `formData[field.id]`.
 */
export function createEmptyDetailRow(columns: FormField[] | undefined): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const column of columns ?? []) {
    row[column.id] = column.type === 'multi-select' ? [] : undefined
  }
  return row
}

/**
 * Per-row sub-field visibility (design-lock §4 "sub-field visibilityRule hides cells live").
 * A sub-field's `visibilityRule.fieldId` resolves to a SAME-ROW sub-field, so we evaluate the
 * existing `fieldVisibility` engine against a sub-schema `{ fields: columns }` and the row as its
 * form data. The fill view renders only the returned columns, and `pruneHiddenDetailRow` uses the
 * SAME evaluation to drop hidden cells before submit — so what the user can't see never submits.
 */
export function visibleDetailColumnsForRow(
  columns: FormField[] | undefined,
  row: Record<string, unknown>,
): FormField[] {
  if (!Array.isArray(columns) || columns.length === 0) return []
  return getVisibleFormFields({ fields: columns }, row ?? {})
}

/**
 * Drop hidden cells (and any unknown keys) from a single detail row, keyed by the row's visible
 * sub-fields. Mirrors the backend per-row `pruneHiddenFormData` recursion so the FE pre-submit
 * payload matches what the backend would freeze.
 */
export function pruneHiddenDetailRow(
  columns: FormField[] | undefined,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const visibleIds = new Set(visibleDetailColumnsForRow(columns, row).map((column) => column.id))
  const pruned: Record<string, unknown> = {}
  for (const id of visibleIds) {
    if (Object.prototype.hasOwnProperty.call(row, id)) pruned[id] = row[id]
  }
  return pruned
}

/**
 * Prune hidden cells from every row of a detail field's value array. Non-array values pass
 * through unchanged (the caller validates shape elsewhere).
 */
export function pruneHiddenDetailRows(field: Pick<FormField, 'columns'>, value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((entry) =>
    pruneHiddenDetailRow(field.columns, entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}),
  )
}

/**
 * Submit-time prune for an approval form that may contain `detail` fields. First applies the
 * existing top-level `pruneHiddenFormData` (drops hidden TOP-LEVEL fields), then recurses into
 * each surviving `detail` field's rows to drop per-row hidden cells (design-lock §3 prune-on-write,
 * §4 same per-row visibility). Kept here (not in `fieldVisibility.ts`) so the detail recursion does
 * not create an import cycle. Render and pre-submit prune therefore share `visibleDetailColumnsForRow`.
 */
export function pruneHiddenFormDataWithDetail(
  formSchema: FormSchema,
  formData: Record<string, unknown>,
): Record<string, unknown> {
  const topLevel = pruneHiddenFormData(formSchema, formData)
  const detailFieldsById = new Map(
    formSchema.fields.filter((field) => field.type === 'detail').map((field) => [field.id, field]),
  )
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(topLevel)) {
    const detailField = detailFieldsById.get(key)
    result[key] = detailField ? pruneHiddenDetailRows(detailField, value) : value
  }
  return result
}

export interface DetailDisplayColumn {
  id: string
  label: string
  type: FormFieldType
  options?: FormOption[]
}

export interface DetailDisplayTable {
  columns: DetailDisplayColumn[]
  /** One entry per snapshot row; `cells` is keyed by sub-field id (raw frozen value). */
  rows: Array<{ key: string; cells: Record<string, unknown> }>
}

/**
 * Build the read-only table model for a `detail` field's frozen snapshot value, driven by the
 * field's FROZEN `columns` (resolved from the instance's pinned template version — never the
 * live template). Returns `null` when the field has no `columns` (not a usable detail) or the
 * snapshot value is not an array — callers then fall back to the existing stringify rendering.
 */
export function buildDetailRowsForDisplay(
  field: Pick<FormField, 'columns'> | undefined,
  snapshotValue: unknown,
): DetailDisplayTable | null {
  const columns = field?.columns
  if (!Array.isArray(columns) || columns.length === 0) return null
  if (!Array.isArray(snapshotValue)) return null

  const displayColumns: DetailDisplayColumn[] = columns.map((column) => ({
    id: column.id,
    label: column.label || column.id,
    type: column.type,
    ...(column.options ? { options: column.options } : {}),
  }))

  const rows = snapshotValue.map((entry, index) => {
    const cells: Record<string, unknown> = {}
    const source = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    for (const column of displayColumns) {
      cells[column.id] = source[column.id]
    }
    return { key: `row_${index}`, cells }
  })

  return { columns: displayColumns, rows }
}

/**
 * Resolve a `formSchema` field by id, used by the detail view to find a snapshot key's frozen
 * `detail` definition. Returns the field only when it is a `detail` carrying `columns`.
 */
export function findDetailFieldInSchema(
  formSchema: FormSchema | null | undefined,
  fieldId: string,
): FormField | null {
  if (!formSchema || !Array.isArray(formSchema.fields)) return null
  const field = formSchema.fields.find((entry) => entry.id === fieldId)
  if (!field || field.type !== 'detail' || !Array.isArray(field.columns)) return null
  return field
}
