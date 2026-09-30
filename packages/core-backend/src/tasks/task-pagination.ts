/**
 * Task feature — list-endpoint pagination: `limit`/`offset` parsing and the stable sort key every
 * M4 list endpoint must share. PURE, no I/O.
 *
 * Design: docs/development/task-d-m4-pure-functions-design-20260930.md §2 `task-pagination.ts`
 * Lock:   task-feature-design-lock-20260917.md §13-29 `:797` (suggested: limit/offset, upper bound
 *         100, return total, cursor deferred to P1)
 *
 * This whole module implements the M4 ruling pack v2 (PROPOSED, not owner-ratified) — every
 * `ASSUMPTION(task-d)` comment below names the ruling id it implements the RECOMMENDED value of.
 */

// ASSUMPTION(task-d): [R15, v2-revised] `limit` is `1..100`, DEFAULT 100 — the v2 pack revision
// explicitly OVERRODE the v1 recommendation of a default of 50: "v1 的默认 50 会让第 51–100 行静默
// 消失" (a default of 50 would silently drop rows 51-100 for any caller that omits `limit`, since
// M2's un-paginated list endpoints today effectively return up to 100 rows with a hard `LIMIT 100`
// and no `offset`). 100 keeps that behavior unchanged for a caller that never adds `limit`/`offset`
// at all.
export const TASK_PAGE_LIMIT_MIN = 1
export const TASK_PAGE_LIMIT_MAX = 100
export const TASK_PAGE_LIMIT_DEFAULT = 100
export const TASK_PAGE_OFFSET_DEFAULT = 0

// ASSUMPTION(task-d): [D9] the stable ORDER BY every M4 list/pagination endpoint must share —
// `updated_at` ties are broken by `id` (both DESC), so offset-based paging never skips or
// duplicates a row across pages even when two rows share the same `updated_at`. M2's `/api/tasks`
// today only orders by `updated_at DESC` (no tiebreaker) — D9: "offset 分页需要它,M2 现在只有
// updated_at DESC" — so this is a required addition for the endpoints R15 has M4 retrofit, not a
// new invention for greenfield ones only.
/** See the ASSUMPTION note immediately above. */
export const TASK_PAGE_SORT_KEY = '(updated_at DESC, id DESC)' as const

export type TaskPageParamsReason = 'invalid_limit' | 'invalid_offset'

export interface TaskPageParamsInput {
  /** Raw query-string value OR an already-parsed number; `undefined`/`null` ⇒ the default. */
  limit?: unknown
  offset?: unknown
}

export interface TaskPageParams {
  limit: number
  offset: number
}

export type ParsePageParamsResult = { ok: true; params: TaskPageParams } | { ok: false; reason: TaskPageParamsReason }

// ASSUMPTION(task-d, own choice — not ruling-derived, fixing a real bug found in independent
// review): the NUMBER branch used `Number.isInteger`, which is TRUE for values like `1e300` (no
// fractional part, but astronomically outside any real row-count/offset range and far beyond
// `Number.MAX_SAFE_INTEGER`) — `parsePageParams({ offset: 1e300 })` used to return `ok: true,
// params: { offset: 1e+300 }`, a value that would silently corrupt a downstream SQL `OFFSET` bind.
// `Number.isSafeInteger` closes this for BOTH branches (the string branch already used it).
/** Accepts a JS integer, OR a CANONICAL non-negative-integer STRING (`^(0|[1-9]\d*)$` — no leading
 * zeros, so `"007"`/`"00"` are rejected rather than silently parsed as `7`/`0`; an HTTP query value
 * arrives as a string, and this is the one place that boundary is crossed). Anything else (floats,
 * scientific notation, whitespace, a leading `+`/`-`, `NaN`/`Infinity`, a non-canonical digit
 * string, or a value outside `Number.MAX_SAFE_INTEGER`) is rejected outright — R15: "非整数或越界返回
 * 422,不静默夹取" (never silently clamp or coerce). */
function toStrictNonNegativeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

/**
 * `limit`: `1..100` inclusive, default `100`. `offset`: `>= 0`, default `0`. Either field out of
 * bounds or not a well-formed integer ⇒ 422 with a reason naming WHICH field failed — never a
 * silent clamp to the nearest valid value (R15).
 */
export function parsePageParams(input: TaskPageParamsInput): ParsePageParamsResult {
  let limit = TASK_PAGE_LIMIT_DEFAULT
  if (input.limit !== undefined && input.limit !== null) {
    const parsed = toStrictNonNegativeInteger(input.limit)
    if (parsed === null || parsed < TASK_PAGE_LIMIT_MIN || parsed > TASK_PAGE_LIMIT_MAX) {
      return { ok: false, reason: 'invalid_limit' }
    }
    limit = parsed
  }

  let offset = TASK_PAGE_OFFSET_DEFAULT
  if (input.offset !== undefined && input.offset !== null) {
    const parsed = toStrictNonNegativeInteger(input.offset)
    if (parsed === null) {
      return { ok: false, reason: 'invalid_offset' }
    }
    offset = parsed
  }

  return { ok: true, params: { limit, offset } }
}
