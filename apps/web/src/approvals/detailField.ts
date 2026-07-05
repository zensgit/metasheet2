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

// Per-cell live-hide decision for the fill table. Takes the OWNING detail field explicitly —
// NOT a reverse-lookup by column.id, because sub-field ids are unique only WITHIN a group, so
// two detail fields can both have a `note`/`kind` column. A cell is visible when its column has
// no rule, or the row makes that column visible among ITS OWN group's columns.
export function isDetailCellVisible(
  detailField: FormField,
  column: FormField,
  row: Record<string, unknown>,
): boolean {
  if (!column.visibilityRule) return true
  return visibleDetailColumnsForRow(detailField.columns, row).some((entry) => entry.id === column.id)
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

export interface DisplayField {
  /** Original formSnapshot key — used for `:key` binding and any cross-lookup (e.g. detailTables). */
  key: string
  label: string
  value: string
}

function matchOptionLabel(options: FormOption[] | undefined, value: unknown): string {
  const match = (options ?? []).find((option) => option.value === value)
  return match ? match.label : String(value)
}

/**
 * Mirrors the detail view's own zh-CN date formatting (`new Date(x).toLocaleString('zh-CN')`),
 * but — unlike that helper — passes the raw value through unchanged when it doesn't parse as a
 * date, instead of surfacing the JS-internal "Invalid Date" string to the reader.
 */
function formatDisplayDate(value: unknown): string {
  const raw = String(value)
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString('zh-CN')
}

/**
 * Formats a single scalar snapshot value for display, driven by its frozen schema field type.
 * null/undefined/'' always render as '-' regardless of type. `select` maps the stored value to
 * its option label, falling back to the raw value when no option matches (e.g. an option
 * renamed/removed after the instance was created); `multi-select` maps each stored value the
 * same way and joins with '、'; `date` uses `formatDisplayDate` (pass-through on unparsable);
 * `number` localizes finite values via zh-CN grouping. Everything else (text/textarea/user/
 * attachment) stringifies as-is.
 */
function formatDisplayValue(field: FormField, value: unknown): string {
  if (value === null || value === undefined || value === '') return '-'
  switch (field.type) {
    case 'select':
      return matchOptionLabel(field.options, value)
    case 'multi-select': {
      const values = Array.isArray(value) ? value : [value]
      return values.map((entry) => matchOptionLabel(field.options, entry)).join('、')
    }
    case 'date':
    case 'datetime':
      return formatDisplayDate(value)
    case 'number': {
      const num = Number(value)
      return Number.isFinite(num) ? num.toLocaleString('zh-CN') : String(value)
    }
    default:
      return String(value)
  }
}

/**
 * B1-02: humanized scalar-field display entries for the detail view's form snapshot — schema
 * order, resolved labels, and typed value formatting (option labels instead of raw stored
 * values, localized numbers, formatted dates) — instead of the raw-machine-key / raw-value
 * rendering the view previously fell back to for every snapshot entry.
 *
 * `detail` fields are deliberately excluded: they keep rendering via the existing
 * `buildDetailRowsForDisplay` / `detailTables` table path, untouched by this helper. Snapshot
 * keys that have no matching schema field (stale/legacy data) are appended AFTER the
 * schema-ordered entries, using the raw key as label — so unexpected data is surfaced, not
 * silently dropped.
 */
export function buildDisplayFields(
  formSchema: FormSchema | null | undefined,
  formSnapshot: Record<string, unknown> | null | undefined,
): DisplayField[] {
  const snapshot = formSnapshot ?? {}
  const fields = formSchema?.fields ?? []
  const knownFieldIds = new Set(fields.map((field) => field.id))
  const result: DisplayField[] = []

  for (const field of fields) {
    if (field.type === 'detail') continue
    if (!Object.prototype.hasOwnProperty.call(snapshot, field.id)) continue
    result.push({
      key: field.id,
      label: field.label || field.id,
      value: formatDisplayValue(field, snapshot[field.id]),
    })
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (knownFieldIds.has(key)) continue
    result.push({ key, label: key, value: String(value) })
  }

  return result
}

/**
 * B2-01 (待办列表关键字段摘要) — the first `limit` NON-attachment, NON-detail leaf fields, in
 * schema order, that are actually present in the snapshot. Reuses `buildDisplayFields` for every
 * bit of VALUE formatting (option labels, localized numbers, formatted dates) so that logic lives
 * exactly once; this function only narrows WHICH of its entries qualify for a glanceable summary.
 *
 * Deliberately does NOT inherit `buildDisplayFields`'s "snapshot keys absent from the schema" tail
 * (see that function's own doc comment) — those are raw/legacy data with no real label, and a
 * caller with no schema at all (e.g. a list row whose templateId has no live template, or none)
 * must degrade to NO summary rather than a raw-key dump of unrelated snapshot data. Returns `[]`
 * whenever `formSchema` is missing/empty or has no eligible leaf field.
 */
export function summaryFields(
  formSchema: FormSchema | null | undefined,
  formSnapshot: Record<string, unknown> | null | undefined,
  limit = 3,
): DisplayField[] {
  const fields = formSchema?.fields
  if (!Array.isArray(fields) || fields.length === 0) return []

  const eligibleFieldIds = new Set(
    fields
      .filter((field) => field.type !== 'attachment' && field.type !== 'detail')
      .map((field) => field.id),
  )
  if (eligibleFieldIds.size === 0) return []

  return buildDisplayFields(formSchema, formSnapshot)
    .filter((field) => eligibleFieldIds.has(field.key))
    .slice(0, limit)
}

/**
 * Joins `summaryFields`' output into the list-row glance line, e.g.
 * `请假类型：年假 · 时长：2 · 事由：出差`. A pure string join — the caller renders it inside a
 * single-line container with CSS `text-overflow: ellipsis`, so truncation stays purely visual
 * (never a substring cut here that could clip mid-character).
 */
export function formatSummaryLine(fields: DisplayField[]): string {
  return fields.map((field) => `${field.label}：${field.value}`).join(' · ')
}
