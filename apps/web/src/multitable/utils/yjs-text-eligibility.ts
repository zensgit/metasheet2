import type { MetaField } from '../types'

// grid-commit-reliability P3-1: extracted so MetaGridTable's D1 type-to-edit
// (which decides whether it is safe to seed a printable keystroke) and
// MetaCellEditor's own Yjs-binding setup (which decides whether to construct
// `useYjsCellBinding` at all) share ONE definition instead of two regexes
// that could silently drift apart.

const DATE_RE = /^\d{4}-\d{2}-\d{2}/
const DATE_FIELD_NAMES = /date|time|deadline|due|start|end|created|updated|birthday/i

/**
 * True when a `string` field renders as the date-like `<input type="date">`
 * branch (by field-name convention, or because the current value already
 * looks like an ISO date) rather than the plain text editor. Any other field
 * type is never date-like by definition.
 */
export function isDateLikeStringField(field: Pick<MetaField, 'type' | 'name'>, value: unknown): boolean {
  if (field.type !== 'string') return false
  if (DATE_FIELD_NAMES.test(field.name)) return true
  if (typeof value === 'string' && DATE_RE.test(value)) return true
  return false
}

/**
 * True when a cell is eligible for the Yjs text-binding opt-in path — the
 * SAME condition MetaCellEditor uses (at setup) to decide whether to
 * construct a live `useYjsCellBinding` at all: a plain, non-date-like
 * `string` field with a `recordId` supplied. This does NOT check whether the
 * `VITE_ENABLE_YJS_COLLAB` build flag is on — that gates only whether the
 * constructed binding ever goes `active`, a decision that happens
 * asynchronously well after this cell may already need to answer "is it
 * even POSSIBLE for a live binding to exist here" (see the P3-1 doc comment
 * at MetaGridTable's D1 call site for why the answer must be knowable
 * synchronously, before the editor ever mounts).
 *
 * A caller with no `recordId` wiring for this cell (MetaGridTable's grouped
 * render path passes none) is correctly never eligible — matching
 * MetaCellEditor's own `props.recordId` gating exactly.
 */
export function isYjsTextEligible(
  field: Pick<MetaField, 'type' | 'name'>,
  recordId: string | null | undefined,
  value: unknown,
): boolean {
  return field.type === 'string' && !isDateLikeStringField(field, value) && !!recordId
}
