/**
 * PROPOSED (H-3, 2026-09-22, round 2) — browser-side mirror of the backend guard
 * for user-supplied regular expressions.
 *
 * WHY A COPY AND NOT AN IMPORT: `apps/web` has no build or runtime dependency on
 * `@metasheet/core-backend` (the vite alias set is `@` -> `apps/web/src` only, and
 * the backend package is a server bundle). This is the same constraint that forced
 * `apps/web/src/utils/permission-match.ts` to be a mirror of
 * `packages/core-backend/src/auth/permission-match.ts`. The copy is held to the
 * original by a THREE-WAY behavioural pin that lives in the backend's required
 * lane — `packages/core-backend/tests/unit/user-regex-guard-three-copy-parity.test.ts`
 * imports this file, requires the plugin's `.cjs` copy, and replays ONE shared case
 * table through all three. `apps/web`'s own specs are not a required check, so a pin
 * that lived only here would not hold anything.
 *
 * Deliberately dependency-free: no Vue, no `@/` alias, no DOM API beyond
 * `performance.now()`, so the backend lane can import it directly.
 *
 * See docs/development/input-regex-redos-census-*.md for the derivation of every
 * constant and for what this guard still cannot see.
 */

/** Hard ceiling on the subject a caller-supplied pattern may be run against. */
export const USER_REGEX_MAX_SUBJECT_LEN = 10000

/** A caller-supplied pattern longer than this is refused before compilation. */
export const USER_REGEX_MAX_PATTERN_LEN = 1000

/** A ladder rung must cost at least this long before its measurement decides anything. */
export const USER_REGEX_PROBE_FLOOR_MS = 2

/** Extrapolated full-subject cost above which a super-quadratic pattern is refused. */
export const USER_REGEX_PROBE_BUDGET_MS = 100

/** Measured log-log growth exponent above which a pattern counts as "provably super-linear". */
export const USER_REGEX_SUPERLINEAR_SLOPE = 2

/** The deciding rung must be this many times more expensive than the rung it is fitted against. */
export const USER_REGEX_DECISION_DYNAMIC_RANGE = 8

const MIN_MEASURABLE_MS = 0.001

function nowMs(): number {
  return performance.now()
}

export function userRegexProbeLadder(n: number): number[] {
  const rungs: number[] = []
  let L = 2
  while (L < n) {
    rungs.push(L)
    if (L < 24) L += 1
    else if (L < 64) L += 4
    else L = Math.max(L + 4, Math.ceil(L * 1.25))
  }
  const last = () => (rungs.length > 0 ? rungs[rungs.length - 1] : 0)
  for (const delta of [16, 12, 8, 6, 4, 3, 2, 1]) {
    const rung = n - delta
    if (rung > last() && rung > 0) rungs.push(rung)
  }
  return rungs
}

export function userRegexProbeSubject(subject: string, len: number): string {
  if (subject.length <= len) return subject
  const tail = Math.min(8, Math.floor(len / 2))
  return subject.slice(0, len - tail) + subject.slice(subject.length - tail)
}

/**
 * Index of the rung the deciding rung's growth is fitted against: the most recent
 * sample at least USER_REGEX_DECISION_DYNAMIC_RANGE times cheaper, or -1 when no
 * such rung exists (the cost curve is flat over everything sampled, so there is
 * nothing measured to refuse on).
 *
 * Extracted and exported so the choice of anchor is DIRECTLY testable. The first
 * design fitted the ADJACENT rung; two adjacent rungs at the floor are ~1.3ms and
 * ~2.7ms and the verdict is their ratio, so scheduling noise could halve the fitted
 * exponent — measured, `^(a+)+$` at n=33 was then intermittently accepted and ran
 * for 22248ms. Because that failure is intermittent, a behavioural test cannot pin
 * it reliably (an adjacent-rung mutation passed the behavioural suite 5/5); this
 * function is what makes the rule pinnable at all.
 */
export function selectFitAnchor(sampledMs: number[], decisionMs: number): number {
  for (let i = sampledMs.length - 1; i >= 0; i--) {
    if (sampledMs[i] * USER_REGEX_DECISION_DYNAMIC_RANGE <= decisionMs) return i
  }
  return -1
}

export type UserRegexRefusal =
  | { kind: 'pattern-too-long'; limit: number; length: number }
  | { kind: 'subject-too-long'; limit: number; length: number }
  | { kind: 'invalid-pattern' }
  | {
      kind: 'superlinear'
      slope: number | null
      predictedMs: number | null
      measuredMs: number
      atLength: number
      subjectLength: number
    }

export type UserRegexOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'refused'; refusal: UserRegexRefusal }

export function describeUserRegexRefusal(refusal: UserRegexRefusal): string {
  switch (refusal.kind) {
    case 'pattern-too-long':
      return `validation pattern exceeds ${refusal.limit} characters`
    case 'subject-too-long':
      return `value exceeds the ${refusal.limit}-character limit for pattern checking`
    case 'invalid-pattern':
      return 'validation pattern is not a valid regular expression'
    case 'superlinear':
      return 'validation pattern is too slow on this value to be evaluated safely'
  }
}

type Verdict = { slope: number; predictedMs: number; superlinear: boolean }

function verdictFor(
  prevLen: number,
  prevMs: number,
  len: number,
  ms: number,
  subjectLength: number,
): Verdict {
  const base = Math.max(prevMs, MIN_MEASURABLE_MS)
  const top = Math.max(ms, base)
  const slope = Math.log(top / base) / Math.log(len / prevLen)
  const predictedMs = ms * Math.pow(subjectLength / len, slope)
  return {
    slope,
    predictedMs,
    superlinear: slope > USER_REGEX_SUPERLINEAR_SLOPE && predictedMs > USER_REGEX_PROBE_BUDGET_MS,
  }
}

export function runUserRegex<T>(
  pattern: string,
  flags: string | undefined,
  subject: string,
  execute: (re: RegExp, subject: string) => T,
): UserRegexOutcome<T> {
  if (pattern.length > USER_REGEX_MAX_PATTERN_LEN) {
    return { status: 'refused', refusal: { kind: 'pattern-too-long', limit: USER_REGEX_MAX_PATTERN_LEN, length: pattern.length } }
  }
  if (subject.length > USER_REGEX_MAX_SUBJECT_LEN) {
    return { status: 'refused', refusal: { kind: 'subject-too-long', limit: USER_REGEX_MAX_SUBJECT_LEN, length: subject.length } }
  }
  try {
    new RegExp(pattern, flags)
  } catch {
    return { status: 'refused', refusal: { kind: 'invalid-pattern' } }
  }

  const timeAt = (len: number): number => {
    const probe = userRegexProbeSubject(subject, len)
    const re = new RegExp(pattern, flags)
    const started = nowMs()
    execute(re, probe)
    return nowMs() - started
  }
  const bestOf = (len: number, times: number): number => {
    let best = Infinity
    for (let i = 0; i < times; i++) best = Math.min(best, timeAt(len))
    return best
  }

  const sampledLen: number[] = []
  const sampledMs: number[] = []
  for (const len of userRegexProbeLadder(subject.length)) {
    const ms = timeAt(len)
    if (ms < USER_REGEX_PROBE_FLOOR_MS) {
      sampledLen.push(len)
      sampledMs.push(ms)
      continue
    }
    if (sampledLen.length === 0) {
      // The very first rung (a <=2-character subject) already burned floor-level
      // CPU. There is no curve to fit, but a 2-character subject costing >=2ms is
      // pathological on its face. Confirm, then refuse.
      const confirmed = bestOf(len, 3)
      if (confirmed >= USER_REGEX_PROBE_FLOOR_MS) {
        return {
          status: 'refused',
          refusal: { kind: 'superlinear', slope: null, predictedMs: null, measuredMs: confirmed, atLength: len, subjectLength: subject.length },
        }
      }
      break
    }
    // Fit the curve over a WIDE anchor, never against the adjacent rung. Two
    // adjacent rungs at the floor are only ~1.3ms and ~2.7ms apart and the whole
    // verdict is their RATIO, so ordinary scheduling noise on a 1.3ms sample can
    // halve the fitted exponent. MEASURED: an adjacent-rung fit accepted
    // `^(a+)+$` at n=33 intermittently and then paid 22248ms. Anchoring against
    // the most recent rung at least USER_REGEX_DECISION_DYNAMIC_RANGE times
    // cheaper makes the fit rest on a ratio no jitter can manufacture.
    const anchor = selectFitAnchor(sampledMs, ms)
    // Nothing in the sampled range is that much cheaper => the curve is flat over
    // everything measured. Refusing on that would be a guess, not a measurement.
    if (anchor < 0) break
    const verdict = verdictFor(sampledLen[anchor], sampledMs[anchor], len, ms, subject.length)
    if (verdict.superlinear) {
      const confirmedAnchor = bestOf(sampledLen[anchor], 2)
      const confirmedMs = bestOf(len, 2)
      const confirmed = verdictFor(sampledLen[anchor], confirmedAnchor, len, confirmedMs, subject.length)
      if (confirmed.superlinear) {
        return {
          status: 'refused',
          refusal: {
            kind: 'superlinear',
            slope: confirmed.slope,
            predictedMs: confirmed.predictedMs,
            measuredMs: confirmedMs,
            atLength: len,
            subjectLength: subject.length,
          },
        }
      }
    }
    // Measured above the floor and not refused: the curve is known well enough,
    // stop sampling and pay the real call once.
    break
  }

  return { status: 'ok', value: execute(new RegExp(pattern, flags), subject) }
}
