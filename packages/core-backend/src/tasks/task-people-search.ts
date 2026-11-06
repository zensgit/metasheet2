/**
 * Task usability package 1b — the people directory of the task pages: the bounds of
 * `GET /api/tasks/people` and the reading of its query. PURE, no I/O; the reads live in
 * `services/task-people.ts`.
 *
 * Two modes, never both in one request:
 * - search (`q`): active members of the caller's org whose name contains the term, or whose id is
 *   exactly the term; at most `PEOPLE_PAGE_MAX` rows, and a term of at least one character;
 * - resolve (`ids`, comma-separated): the subset of those ids that are active members of the
 *   caller's org, at most `PEOPLE_RESOLVE_MAX_IDS` of them.
 * Neither key answers the "type a name" marker. Anything malformed is 422 `PEOPLE_QUERY_INVALID`.
 */
import { TASK_ASSIGNEE_SOFT_LIMIT } from './task-membership'

/** Longest search term, after trimming. */
export const PEOPLE_QUERY_MAX_LENGTH = 64
/** Shortest search term; a blank one answers the marker instead of rows. */
export const PEOPLE_QUERY_MIN_LENGTH = 1
/** Most rows one search returns. */
export const PEOPLE_PAGE_MAX = 20
/** Most ids one resolve reads: the most assignees one task can carry. */
export const PEOPLE_RESOLVE_MAX_IDS = TASK_ASSIGNEE_SOFT_LIMIT
/** Longest raw `ids` value, before it is split. */
export const PEOPLE_IDS_QUERY_MAX_LENGTH = 4096
/** Candidates read per statement while a search fills its page. */
export const PEOPLE_SEARCH_BATCH = 100
/** Statements a search reads at most; past them it stops and says there may be more. */
export const PEOPLE_SEARCH_MAX_BATCHES = 10

/** The member id bound (`MEMBER_ID_MAX_LENGTH` in services/task-create.ts). */
const MEMBER_ID_MAX_LENGTH = 255
const PRINTABLE_ID = /^[!-~]+$/

/** The member id rule of the task writes (`isValidMemberId`, services/task-create.ts), copied so
 *  this module imports nothing from `services/`: printable ASCII, 1..255 long, not `.` or `..`. */
export function isPeopleId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MEMBER_ID_MAX_LENGTH
    && PRINTABLE_ID.test(value)
    && value !== '.'
    && value !== '..'
}

/** The trimmed term, `''` for a blank one, or `null` when the value is not text or too long. */
export function normalizePeopleQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const term = raw.trim()
  return term.length > PEOPLE_QUERY_MAX_LENGTH ? null : term
}

/** `\`, `%` and `_` escaped, so the term is matched as a literal substring (the backslash is the
 *  default LIKE escape character). */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** `limit` within [1, PEOPLE_PAGE_MAX]; anything that is not a whole number reads as the maximum. */
export function clampPeopleLimit(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(value)) return PEOPLE_PAGE_MAX
  return Math.min(PEOPLE_PAGE_MAX, Math.max(1, value))
}

/** The raw `ids` value split on commas, trimmed, deduplicated, each id kept only when the member id
 *  rule accepts it, and capped at `PEOPLE_RESOLVE_MAX_IDS` (`truncated` says the cap dropped some).
 *  `null` when the value is not text or longer than `PEOPLE_IDS_QUERY_MAX_LENGTH`. */
export function parsePeopleIds(raw: unknown): { ids: string[]; truncated: boolean } | null {
  if (typeof raw !== 'string' || raw.length > PEOPLE_IDS_QUERY_MAX_LENGTH) return null
  const ids: string[] = []
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (isPeopleId(id) && !ids.includes(id)) ids.push(id)
  }
  return ids.length > PEOPLE_RESOLVE_MAX_IDS
    ? { ids: ids.slice(0, PEOPLE_RESOLVE_MAX_IDS), truncated: true }
    : { ids, truncated: false }
}

/** The distinguishing detail shown next to a name: the first two characters of the local part,
 *  `***`, and the domain (`al***@example.com`). `''` for a blank value; a value without `@` keeps
 *  only its first two characters. */
export function maskEmail(email: string): string {
  const value = email.trim()
  if (value.length === 0) return ''
  const at = value.lastIndexOf('@')
  if (at < 0) return `${value.slice(0, 2)}***`
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`
}

export type PeopleRequest =
  | { kind: 'blank'; limit: number }
  | { kind: 'search'; term: string; limit: number }
  | { kind: 'resolve'; ids: string[]; truncated: boolean }

/** The query of `GET /api/tasks/people`, read; `null` is 422 `PEOPLE_QUERY_INVALID`. */
export function parsePeopleRequest(query: { q?: unknown; ids?: unknown; limit?: unknown }): PeopleRequest | null {
  if (query.q !== undefined && query.ids !== undefined) return null
  if (query.ids !== undefined) {
    const parsed = parsePeopleIds(query.ids)
    return parsed ? { kind: 'resolve', ids: parsed.ids, truncated: parsed.truncated } : null
  }
  const limit = clampPeopleLimit(query.limit)
  if (query.q === undefined) return { kind: 'blank', limit }
  const term = normalizePeopleQuery(query.q)
  if (term === null) return null
  return term.length < PEOPLE_QUERY_MIN_LENGTH ? { kind: 'blank', limit } : { kind: 'search', term, limit }
}
