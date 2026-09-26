/**
 * Task feature — domain id generation/validation + record-id parsing + user-text normalization.
 * PURE, no I/O, no `crypto` (random source is caller-injected — see `generateTaskDomainId`).
 *
 * Design: docs/development/task-b-pure-functions-design-20260926.md §1, §2.1 (via §4.1), §3.2, §3.5
 * Lock:   task-feature-design-lock-20260917.md @ ce180c8850 §4.1 `:92-93`, §7 (record id), 门 10
 */

/**
 * Closed set of task-domain id prefixes (lock §4.1 `:92`). `event` (`tev`, for `task_events.id`)
 * was added by owner ruling 2026-09-26 (「按建议」 on the `tev_` proposal); lock §4.1 lists only
 * tsk/tlst/tcmt, so this is a recorded addition to that list.
 */
export const TASK_ID_PREFIXES = {
  task: 'tsk',
  list: 'tlst',
  comment: 'tcmt',
  event: 'tev',
} as const

export type TaskDomainIdKind = keyof typeof TASK_ID_PREFIXES

// ASSUMPTION(task-b): [design §3 item 5] the random source is caller-injected as `(bytes: number)
// => string`; this module does not itself encode/sanitize its output (no `crypto`, no base-N
// re-encoding) beyond validating the returned suffix is alphanumeric before composing the id — the
// caller owns both length and entropy.
/**
 * Caller-injected random source: `random(bytes)` must return a non-empty string made only of
 * `[A-Za-z0-9]` characters — at least `bytes` characters long is NOT required, the module treats
 * whatever comes back as the literal id suffix.
 */
export type TaskIdRandomSource = (bytes: number) => string

/** Suffix length requested from the injected random source. Fixed so callers get a stable shape. */
const TASK_ID_RANDOM_BYTES = 16

/** Server-generated id format (lock §4.1 `:92`, plus `tev`): `^(tsk|tlst|tcmt|tev)_[A-Za-z0-9]+$`. PURE. */
export function generateTaskDomainId(kind: TaskDomainIdKind, random: TaskIdRandomSource): string {
  const prefix = Object.prototype.hasOwnProperty.call(TASK_ID_PREFIXES, kind)
    ? TASK_ID_PREFIXES[kind]
    : undefined
  if (typeof prefix !== 'string') {
    throw new TypeError(`generateTaskDomainId: unknown kind "${String(kind)}"`)
  }
  const suffix = random(TASK_ID_RANDOM_BYTES)
  if (typeof suffix !== 'string' || !/^[A-Za-z0-9]+$/.test(suffix)) {
    throw new TypeError('generateTaskDomainId: random(bytes) must return a non-empty alphanumeric string')
  }
  return `${prefix}_${suffix}`
}

/**
 * Single conjunct of the id CHECK: printable ASCII, no space (`^[!-~]+$`). This is the WHOLE check
 * for `org_id` / `created_by` (lock §4.1 `:92`: those two columns get only this one conjunct).
 */
export function isValidPrintableAsciiId(s: unknown): boolean {
  return typeof s === 'string' && /^[!-~]+$/.test(s)
}

/**
 * Full four-conjunct CHECK for a task-domain generated id column (`tsk_…` / `tlst_…` / `tcmt_…`):
 * `^[!-~]+$ ∧ !~ '__' ∧ !~ '^_' ∧ !~ '_$'` (lock §4.1 `:92`).
 */
export function isValidTaskDomainId(s: unknown): boolean {
  if (!isValidPrintableAsciiId(s)) return false
  const str = s as string
  if (str.includes('__')) return false
  if (str.startsWith('_')) return false
  if (str.endsWith('_')) return false
  return true
}

export interface TaskProjectionRecordId {
  listId: string
  taskId: string
}

const TASK_PROJECTION_RECORD_ID_PREFIX = 'rec_tsk_'

/**
 * Parses `rec_tsk_<listId>__<taskId>` (lock §7): strip the fixed `rec_tsk_` prefix first (reject if
 * it does not match), then split the REMAINDER at its FIRST `__`. Never throws — returns `null` on
 * any failure so the write path can 422 without guessing a listId.
 *
 * BOTH halves must independently satisfy `isValidTaskDomainId` — the same four-conjunct CHECK a
 * real `tlst_…` / `tsk_…` id must pass at write time (lock §7 / gate 10's write-path 422 negatives:
 * a listId containing `__`, an id with a leading `_`, an id with a trailing `_`). A valid id can
 * never contain `__` by construction, so this costs nothing on well-formed input — it only rejects
 * splits that would hand a caller a listId/taskId the DDL CHECK would bounce anyway.
 */
export function parseTaskProjectionRecordId(recordId: unknown): TaskProjectionRecordId | null {
  if (typeof recordId !== 'string' || !recordId.startsWith(TASK_PROJECTION_RECORD_ID_PREFIX)) {
    return null
  }
  const rest = recordId.slice(TASK_PROJECTION_RECORD_ID_PREFIX.length)
  const sepIndex = rest.indexOf('__')
  if (sepIndex === -1) return null
  const listId = rest.slice(0, sepIndex)
  const taskId = rest.slice(sepIndex + 2)
  if (!isValidTaskDomainId(listId) || !isValidTaskDomainId(taskId)) return null
  return { listId, taskId }
}

/** Zero-width marks (U+200B/200C/200D/FEFF), for the edge-only trim class below. */
const ZERO_WIDTH_CHARS = '​‌‍﻿'

/** Unicode White_Space OR one of the zero-width marks, at either end of the string — a single
 * property-aware edge trim covering both classes together, so a mixed run (e.g. a space then a
 * ZWSP) at one edge is removed as one pass. */
const EDGE_TRIM_RE = new RegExp(`^[\\p{White_Space}${ZERO_WIDTH_CHARS}]+|[\\p{White_Space}${ZERO_WIDTH_CHARS}]+$`, 'gu')

// NOTE(task-b, correction — this replaces an earlier, INCORRECT assumption in this spot that called
// interior ZWJ/ZWNJ "DB-illegal" and "never meaningful mid-string"; both claims were false. The DB
// CHECK is only `btrim(col) <> ''` — an emptiness test, not a content rewrite — and ZWJ/ZWNJ carry
// real meaning inside emoji ZWJ sequences (e.g. the "family" emoji) and Persian/Indic text, so
// stripping them from the MIDDLE of a string silently corrupts it. Zero-width marks are now trimmed
// ONLY at the two edges, exactly like Unicode White_Space — never from the interior.
/**
 * Application-layer normalization for user text (`title` / `name`, lock §4.1): NFC-normalize, trim
 * Unicode White_Space AND the four zero-width marks from both EDGES only (never the interior),
 * NFC-normalize again (stripping an edge mark can expose a combining sequence that was only
 * "finished" by the mark just removed — e.g. base + ZWSP + combining-accent — so re-applying NFC
 * after the strip, not only before it, is what makes this function idempotent: `f(f(x)) === f(x)`
 * for every `x`). Returns the normalized string, or `null` when nothing is left (mirrors the
 * DB-side `CHECK (btrim(col) <> '')`, applied on top of the wider Unicode definition of whitespace
 * rather than just ASCII space/tab/newline, plus the four zero-width marks).
 */
export function normalizeUserText(s: unknown): string | null {
  if (typeof s !== 'string') return null
  const nfc = s.normalize('NFC')
  const trimmed = nfc.replace(EDGE_TRIM_RE, '')
  if (trimmed.length === 0) return null
  return trimmed.normalize('NFC')
}
