/**
 * W2 S2 dedup (design-lock §7 S2 row; resolves S1 gate NIT-1 —
 * docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md):
 * `formatValue` / `textControlValue` / `resolvedCanComment` were deliberately DUPLICATED between
 * MetaRecordDrawer.vue and MetaRecordFieldsPanel.vue in S1 (see MetaRecordFieldsPanel.vue's header
 * comment at the time) because the drawer's still-inline `history` tab also needed them. Now that S2
 * extracts the history tab into MetaRecordHistoryPanel.vue too, there would be THREE copies — hoisted
 * here instead as small, pure, props-free wrappers so every consumer reads the exact same logic. No
 * behavior change: byte-identical to the prior duplicated bodies, just parameterized over explicit
 * arguments instead of a component's `props`.
 *
 * Consumers: MetaRecordFieldsPanel.vue (all three), MetaRecordHistoryPanel.vue (formatRecordFieldValue
 * + textControlValue, for the before/after diff), MetaRecordDrawer.vue (resolveCanComment, for its own
 * header comment-toggle button — the drawer no longer renders field values itself post-S2).
 */
import type { LinkedRecordSummary, MetaAttachment, MetaField, MetaFieldPermission, MetaRowActions, PersonSummary } from '../types'
import { formatFieldDisplay } from './field-display'
import { isFieldAlwaysReadOnly } from './field-permissions'
import { isSystemField } from './system-fields'

export interface RecordFieldDisplayContext {
  linkSummariesByField?: Record<string, LinkedRecordSummary[]>
  personSummariesByField?: Record<string, PersonSummary[]>
  attachmentSummariesByField?: Record<string, MetaAttachment[]>
  isZh: boolean
}

/** Field-type-aware read display value (record detail text, history diff before/after), delegating
 *  to the shared `formatFieldDisplay` formatter with this field's link/person/attachment summaries
 *  resolved by id from the per-field summary maps. */
export function formatRecordFieldValue(field: MetaField, value: unknown, ctx: RecordFieldDisplayContext): string {
  return formatFieldDisplay({
    field,
    value,
    linkSummaries: ctx.linkSummariesByField?.[field.id],
    personSummaries: ctx.personSummariesByField?.[field.id],
    attachmentSummaries: ctx.attachmentSummariesByField?.[field.id],
    isZh: ctx.isZh,
  })
}

/** null/undefined → '' for plain text-control value bindings (input/textarea `:value`). */
export function textControlValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

/** Row-level `canComment` (server-computed, permission-aware) wins when present; falls back to the
 *  coarser sheet-level `canComment` prop. */
export function resolveCanComment(rowActions: MetaRowActions | null | undefined, canComment: boolean): boolean {
  return rowActions?.canComment ?? canComment
}

/**
 * Record inspector v3 (design 2026-09-05, PR-A §1.2 header / §2 graft table): the record's
 * "primary field" — the one whose value doubles as the record's title in the inspector's Row B and
 * as the human label everywhere else a record needs a short display name. Hoisted here to replace
 * two WB idioms that had quietly diverged (MultitableWorkbench.vue's `bulkFillRecordName`, which
 * preferred the first `string`/`longText` field, and `captureSelectionLabels`/`batchRecordLabel`,
 * which already used the field at position 0) — all of them now delegate here, so there is ONE
 * definition of the rule ("position 0 of the array you hand me", the Airtable/Feishu "first field is
 * the primary field" convention). Callers needing a text VALUE (not just the field) still guard on
 * `typeof value === 'string'` themselves, same discipline `bulkFillRecordName` already applied.
 *
 * F1 correction (2026-09-05, round 3 — an earlier version of this comment claimed every call site
 * "read the exact same field"; that overclaimed). One RULE does not mean one FIELD, because the
 * callers hand this helper DIFFERENT arrays:
 *   - MetaRecordInspector.vue's title reads `resolvePrimaryField(props.fields)`, and the workbench
 *     binds `:fields="scopedAllFields"` — SHEET order, with view-hidden fields still present (only
 *     per-subject field-permission-hidden fields are filtered out). The title is sheet-order field 0.
 *   - `bulkFillRecordName` / `captureSelectionLabels` / `batchRecordLabel` (MultitableWorkbench.vue)
 *     read `resolvePrimaryField(grid.visibleFields.value)` — VIEW order, view-hidden fields removed.
 * The two agree whenever the active view shows field 0 first (the common case), and DIVERGE whenever
 * a view hides or reorders sheet-field 0: the inspector titles the record by a field the user may not
 * even see in the grid, while the bulk/label sites name it by the view's first visible field. Pinned
 * by multitable-record-inspector-header.spec.ts ("F1: title reads the sheet-order first field") so
 * the divergence is documented behavior, not an assumption; reconciling it (a single primary-field
 * source both sides read) is a follow-up — deliberately NOT changed here, since either direction is a
 * user-visible contract change that needs its own decision.
 */
export function resolvePrimaryField(fields: MetaField[] | null | undefined): MetaField | undefined {
  return fields?.[0]
}

/**
 * P3-2 (2026-09-05, record inspector v3 header follow-up): a THIRD "what should we call this
 * record" idiom survived the `resolvePrimaryField` unification above —
 * `MultitableWorkbench.vue`'s own `mentionDisplayFieldId`, which needs a field whose VALUE renders
 * as readable text inside an `@mention` chip (a `string`/`longText` field specifically), not just
 * "the record's primary field" — the primary field can legitimately be a `number`/`date`/`select`/…
 * field, which would make a poor (or unreadable) mention label. Rather than leave that a fourth,
 * independently-diverging idiom (or forcibly re-point mentions at a non-text primary field, a real
 * behavior regression), this hoists ONE rule that PREFERS the primary field and only falls back to
 * "first string/longText field" when the primary field itself is not text-shaped — so the two
 * call sites read the SAME field whenever the sheet's primary field IS text (the common case), and
 * only diverge for the genuinely different question ("what names this record" vs. "what text value
 * can a mention chip render") when the primary field cannot answer the second one at all. Byte-
 * identical to the pre-unification `mentionDisplayFieldId` idiom for every input: when `fields[0]`
 * is itself `string`/`longText`, `.find()` over the SAME array returns that same first element
 * either way; the two orderings differ only in which field wins when `fields[0]` is NOT text, and in
 * that case both this function's fallback and the old code fall through to the identical
 * `.find(...)` call.
 */
export function resolveMentionDisplayField(fields: MetaField[] | null | undefined): MetaField | undefined {
  const primary = resolvePrimaryField(fields)
  if (primary && (primary.type === 'string' || primary.type === 'longText')) return primary
  return fields?.find((field) => field.type === 'string' || field.type === 'longText')
}

/**
 * Record inspector v3 (design 2026-09-05, PR-B1 §3 file list "`canEditField` hoisted"): the per-field
 * editability predicate MetaRecordFieldsPanel.vue's `canEditField` (moved VERBATIM from
 * MetaRecordDrawer.vue at W2 S1) and MetaRecordInspector.vue's PR-A `canEditPrimaryTitle` (an
 * inline copy of the same four clauses, see its own comment) both evaluated — hoisted here so the
 * title input and the field row can never disagree about whether the same field is editable. Byte-
 * identical clause set, in the same order: sheet-level `canEdit` ∧ row-level `rowActions.canEdit`
 * not false ∧ per-field `fieldPermissions[id].readOnly` not true ∧ not a system field ∧ not
 * always-read-only (B4 defense-in-depth mirror of the server predicate, see field-permissions.ts).
 * A `null`/`undefined` field is not editable (the fields-panel caller resolved it by id and may miss).
 */
export function canEditField(
  field: MetaField | null | undefined,
  ctx: {
    canEdit: boolean
    rowActions?: MetaRowActions | null
    fieldPermissions?: Record<string, MetaFieldPermission> | null
  },
): boolean {
  if (!field) return false
  return ctx.canEdit
    && ctx.rowActions?.canEdit !== false
    && ctx.fieldPermissions?.[field.id]?.readOnly !== true
    && !isSystemField(field)
    && !isFieldAlwaysReadOnly(field)
}

/**
 * Record inspector v3 (design 2026-09-05, PR-B1 §1.3 "Sections"): the workbench-computed field
 * layout the inspector's details tab renders as two sections. `ordered` = the active view's field
 * order ∩ layer-2 (property-hidden) ∩ layer-3 (per-subject field permissions) — what the grid shows,
 * in the order it shows it; `hiddenInView` = every other field the viewer is allowed to see at both
 * layers but the active view hides (rendered collapsed under `recordHiddenFieldsHeading`). The two
 * lists are disjoint by construction at the producer (MultitableWorkbench.vue); the consumer
 * (MetaRecordFieldsPanel.vue) re-applies both visibility layers to each list anyway (mask contract,
 * negative golden N3) and treats a missing prop as "render the flat `fields` list" (legacy path).
 */
export interface MetaRecordInspectorFieldLayout {
  ordered: MetaField[]
  hiddenInView: MetaField[]
}
