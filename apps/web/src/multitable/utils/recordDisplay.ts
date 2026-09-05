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
import type { LinkedRecordSummary, MetaAttachment, MetaField, MetaRowActions, PersonSummary } from '../types'
import { formatFieldDisplay } from './field-display'

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
 * which already used the field at position 0) — both now delegate here so the inspector title and
 * every other "what should we call this record" call site read the exact same field. Position 0 in
 * the caller's own field-ordering (the grid's `visibleFields`, already view-ordered) is the
 * convention itself, matching the second idiom exactly and the Airtable/Feishu "first field is the
 * primary field" convention; callers needing a text VALUE (not just the field) still guard on
 * `typeof value === 'string'` themselves, same discipline `bulkFillRecordName` already applied.
 */
export function resolvePrimaryField(fields: MetaField[] | null | undefined): MetaField | undefined {
  return fields?.[0]
}
