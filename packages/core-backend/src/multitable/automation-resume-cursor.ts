/**
 * A6-3-3 resume cursor — the position an admin resume re-enters an execution from.
 *
 * A6-2 top-level waits resume from a numeric top-level step index. A6-3-3
 * branch-local waits need a richer cursor that locates the suspended wait INSIDE
 * a selected `condition_branch`. This module owns the cursor type plus a
 * fail-closed parser.
 *
 * Safety invariant (the whole point of the A6-3-3 scope gate). A stored
 * `resume_cursor` value is interpreted as exactly one of:
 *   - NULL / absent        → legacy A6-2 top-level path (resume by `step_index`);
 *   - a valid cursor       → use it;
 *   - present-but-invalid  → FAIL CLOSED.
 *
 * A non-null but malformed / unknown-kind cursor must NEVER silently fall back to
 * the top-level `step_index` path: a corrupted branch-local suspension resumed as
 * top-level would re-enter at the wrong position (the `condition_branch` parent
 * index), re-running or skipping actions. The caller maps `invalid` to a
 * fail-closed `409` and never to a top-level resume.
 */

/** Non-secret action-sequence fingerprint (types only), matching the A6-2 guard. */
export interface ActionFingerprint {
  count: number
  hash: string
}

export interface ConditionBranchResumeCursor {
  kind: 'condition_branch'
  /** Top-level index of the `condition_branch` action that owns the selected branch. */
  parentStepIndex: number
  /** Selected branch key. */
  branchKey: string
  /** Index of the suspended `wait_for_callback` inside the selected branch. */
  branchActionIndex: number
  /** C1 job step key of the suspended branch child (`${parentStepIndex}.branch.${branchKey}.${branchActionIndex}`). */
  stepKey: string
  parentJobId: string
  branchJobId: string
  upstreamJobId: string | null
  /** Fingerprint of the SELECTED branch's action types — detects branch drift the top-level fingerprint cannot. */
  branchActionFingerprint: ActionFingerprint
}

export type AutomationResumeCursor = { kind: 'top_level' } | ConditionBranchResumeCursor

export type ParsedResumeCursor =
  | { kind: 'top_level' }
  | { kind: 'condition_branch'; cursor: ConditionBranchResumeCursor }
  | { kind: 'invalid'; reason: string }

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isFingerprint(value: unknown): value is ActionFingerprint {
  if (!value || typeof value !== 'object') return false
  const fp = value as Record<string, unknown>
  return isNonNegativeInt(fp.count) && typeof fp.hash === 'string'
}

/**
 * Parse a stored `resume_cursor` value into a discriminated result.
 *
 * Only `null` / `undefined` yields `top_level`. Any non-null value that is not a
 * fully valid cursor yields `invalid` (the caller MUST fail closed) — never a
 * silent top-level fallback.
 */
export function parseResumeCursor(raw: unknown): ParsedResumeCursor {
  if (raw == null) return { kind: 'top_level' }

  // Tolerate a JSON-encoded column value, but a non-null unparseable string is invalid, not top-level.
  if (typeof raw === 'string') {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      return { kind: 'invalid', reason: 'unparseable_json' }
    }
    // A JSON `null` string round-trips to the top-level path; anything else re-validates.
    return parseResumeCursor(decoded)
  }

  if (typeof raw !== 'object') return { kind: 'invalid', reason: 'not_an_object' }
  // Arrays have typeof 'object' but no `kind` → fall through to unknown_kind below.
  const cursor = raw as Record<string, unknown>

  if (cursor.kind === 'top_level') return { kind: 'top_level' }
  if (cursor.kind !== 'condition_branch') return { kind: 'invalid', reason: 'unknown_kind' }

  if (!isNonNegativeInt(cursor.parentStepIndex)) return { kind: 'invalid', reason: 'bad_parentStepIndex' }
  if (!isNonEmptyString(cursor.branchKey)) return { kind: 'invalid', reason: 'bad_branchKey' }
  if (!isNonNegativeInt(cursor.branchActionIndex)) return { kind: 'invalid', reason: 'bad_branchActionIndex' }
  if (!isNonEmptyString(cursor.stepKey)) return { kind: 'invalid', reason: 'bad_stepKey' }
  if (!isNonEmptyString(cursor.parentJobId)) return { kind: 'invalid', reason: 'bad_parentJobId' }
  if (!isNonEmptyString(cursor.branchJobId)) return { kind: 'invalid', reason: 'bad_branchJobId' }
  if (!(cursor.upstreamJobId === null || isNonEmptyString(cursor.upstreamJobId))) {
    return { kind: 'invalid', reason: 'bad_upstreamJobId' }
  }
  if (!isFingerprint(cursor.branchActionFingerprint)) return { kind: 'invalid', reason: 'bad_branchActionFingerprint' }

  return {
    kind: 'condition_branch',
    cursor: {
      kind: 'condition_branch',
      parentStepIndex: cursor.parentStepIndex,
      branchKey: cursor.branchKey,
      branchActionIndex: cursor.branchActionIndex,
      stepKey: cursor.stepKey,
      parentJobId: cursor.parentJobId,
      branchJobId: cursor.branchJobId,
      upstreamJobId: cursor.upstreamJobId === null ? null : (cursor.upstreamJobId as string),
      branchActionFingerprint: {
        count: (cursor.branchActionFingerprint as ActionFingerprint).count,
        hash: (cursor.branchActionFingerprint as ActionFingerprint).hash,
      },
    },
  }
}
