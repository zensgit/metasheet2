/**
 * PROPOSED (H-3, 2026-09-22, round 2) — candidate mitigations for user-supplied
 * regular expressions. NOT ratified: `formula/engine.ts` is a runtime-contract
 * "frozen core" and `multitable/field-validation-engine.ts` decides whether a
 * record write is accepted, so every export here changes an observable
 * behaviour and the owner decides whether and which of these land.
 * See docs/development/input-regex-redos-census-*.md.
 *
 * Round 1 of this slice shipped a STATIC SHAPE detector
 * (`hasNestedUnboundedQuantifier`: "a quantified group whose body carries an
 * unbounded quantifier"). An independent gate measured it to be net-negative and
 * it has been deleted — see design MD §3C "Why the shape detector was dropped".
 * The short version, all measured, none of it inferred:
 *   - it REFUSED six extremely common LINEAR patterns (version numbers, slugs,
 *     dotted identifiers, comma lists, e-mail, path segments); each of those runs
 *     in ≤0.06ms on a 10000-character adversarial subject, so the refusal bought
 *     nothing and cost a write-path 422 / a persisted `#ERROR!`;
 *   - it ACCEPTED `^(a|a)*$`, which still blocked the event loop for 22 seconds.
 * A shape is not evidence. This round refuses only on EVIDENCE:
 *   1. a hard subject-length ceiling that does not depend on the field's own
 *      validation rules, and
 *   2. a bounded timing ladder that measures the actual cost curve of the actual
 *      (pattern, subject) pair and refuses only when the measured growth is
 *      super-quadratic AND the extrapolated cost exceeds the budget.
 *
 * This is a MITIGATION, not a fix for the class, and the honest claim is narrow:
 * measured 0 refusals in 1200 runs over the linear corpus (round 1 refused 6/6),
 * 600/600 refusals over the three named catastrophic shapes. It does NOT close the
 * class. A pattern whose cost is DISCONTINUOUS in subject length — a fixed-length
 * runway before a nested quantifier, `^.{64}(a+)+$` — is flat on every rung below
 * the runway and can still block; measured, one such shape made a ladder rung
 * itself run for minutes. A linear-time engine (RE2) or a killable worker is the
 * only complete answer; that is an owner/dependency decision. See the design MD
 * §3D "Residual: what this guard still cannot see".
 */

/**
 * Excel / Google-Sheets SUBSTITUTE is a LITERAL text replacement, not a regex
 * one. `split(old).join(new)` is O(n), matches the spec exactly, and removes the
 * ReDoS vector entirely — arg-2 never reaches a regex engine.
 *
 * Excel semantics preserved: an empty `old_text` returns `text` unchanged.
 */
export function substituteLiteral(text: string, oldText: string, newText: string): string {
  if (oldText === '') return text
  return text.split(oldText).join(newText)
}

/**
 * Hard ceiling on the SUBJECT a caller-supplied pattern may be run against.
 *
 * Derivation (all numbers measured on the census machine, recorded in the
 * verification MD §5.2 — they are machine-relative; the ratios are the evidence):
 *
 *  a) PARITY, so the ceiling is not a new narrowing for a default-ruled field:
 *     `getDefaultValidationRules` caps `string` / `longText` at
 *     `maxLength: 10000` (field-validation-engine.ts). A field that does NOT
 *     declare explicit validation therefore already rejects a >10000 value, so
 *     for that population this ceiling changes nothing. (It IS a narrowing for a
 *     field whose EXPLICIT rule list contains a pattern rule but no maxLength —
 *     `explicitRules ?? defaultRules` is a REPLACEMENT, so those fields have no
 *     length bound today. That residual population is disclosed to the owner; it
 *     cannot be censused from here.)
 *
 *  b) BUDGET for the shapes the timing ladder deliberately accepts. The ladder
 *     only refuses super-QUADRATIC growth (slope > 2), so a genuinely quadratic
 *     pattern is accepted and runs to completion; the ceiling is what bounds it.
 *     Worst quadratic shapes measured AT this ceiling (guarded / unguarded):
 *       whitespace trim idiom, /g .replace   ->  54ms / 45ms
 *       the zero-width edge-trim precedent, /gu ->  90ms / 90ms   <- worst measured
 *     Cost is quadratic in the ceiling, so 20000 would be ~360ms; 10000 is where
 *     parity (a) and a ~0.1s worst accepted shape coincide.
 *
 * NOTE, stated plainly: (b) is a budget over a MEASURED battery, not a proof, and
 * 90ms is NOT covered by USER_REGEX_PROBE_BUDGET_MS — that constant governs the
 * slope test's extrapolation, not the cost of a polynomial shape the slope test
 * deliberately accepts. An exponential pattern is unbounded at ANY ceiling; that
 * is what the ladder is for, and the two guards are independent on purpose.
 */
export const USER_REGEX_MAX_SUBJECT_LEN = 10000

/** A caller-supplied pattern longer than this is refused before compilation. */
export const USER_REGEX_MAX_PATTERN_LEN = 1000

/**
 * A ladder rung must cost at least this long before its measurement is allowed to
 * decide anything. MEASURED: across the six common linear patterns the round-1
 * detector wrongly refused, run against 10000-character adversarial subjects, the
 * worst SINGLE rung over the whole ladder is 0.069ms — ~29x under this floor — so
 * on a linear corpus the deciding branch is never entered at all and the verdict
 * is not timing-dependent. A 200x6 run refused 0 of 1200.
 */
export const USER_REGEX_PROBE_FLOOR_MS = 2

/** Extrapolated full-subject cost above which a super-quadratic pattern is refused. */
export const USER_REGEX_PROBE_BUDGET_MS = 100

/** Measured log-log growth exponent above which a pattern counts as "provably super-linear". */
export const USER_REGEX_SUPERLINEAR_SLOPE = 2

/**
 * The deciding rung must be at least this many times more expensive than the rung
 * its growth is fitted against. Two adjacent rungs at the floor are ~1.3ms and
 * ~2.7ms, and the verdict is their RATIO, so a noise-sized error there swings the
 * fitted exponent by a factor of two — measured, it intermittently accepted
 * `^(a+)+$` at n=33 and then paid 22248ms. A wide dynamic range makes the fit rest
 * on a ratio scheduling jitter cannot manufacture.
 */
export const USER_REGEX_DECISION_DYNAMIC_RANGE = 8

/** Floor used in place of a zero/unmeasurable previous rung so the slope stays finite. */
const MIN_MEASURABLE_MS = 0.001

function nowMs(): number {
  return performance.now()
}

/**
 * Subject lengths at which the cost curve is sampled, ascending, all strictly
 * below `n`. The real run at `n` is NOT a rung — it happens only after the
 * ladder has declined to refuse.
 *
 * Three regimes, each with a reason:
 *  - +1 up to 24: catastrophic backtracking lives at small n. Measured worst
 *    growth per +1 char on this machine is ~7x (`^((((((a+)+)+)+)+)+)+$`:
 *    n=6 → 2.0ms, n=7 → 14.7ms), so the first rung at/above the floor overshoots
 *    the floor by at most that factor.
 *  - +4 up to 64, then x1.25: by n=64 an exponential shape has crossed the floor
 *    many rungs earlier; above it the ladder only needs enough resolution to
 *    catch polynomial growth, and a geometric ladder keeps the rung count (and
 *    therefore the guard's own overhead) logarithmic in n.
 *  - a final approach (n-16 … n-1): the last geometric step is a LARGE absolute
 *    jump in subject length, and a pattern whose blow-up is driven by the SUFFIX
 *    (a fixed-length runway before a nested quantifier) is flat on every
 *    geometric rung and explodes only on the real run. These rungs bound that
 *    last step to <=4 characters. They are reached only when every earlier rung
 *    stayed under the floor, so on a benign pattern they cost microseconds.
 */
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

/**
 * Cost proxy for `subject` at length `len`: head + the real tail. Keeping the
 * tail matters — the classic catastrophic subject is "long member run + one
 * non-member character", and a plain prefix would drop exactly the character
 * that causes the backtracking.
 *
 * This is a COST proxy, not a semantic one: it may split a surrogate pair, and
 * the result is only ever timed, never returned to a caller.
 */
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
      /** measured log-log growth exponent between the last two rungs; null when only one rung was measurable */
      slope: number | null
      /** extrapolated cost at the real subject length, ms; null in the single-rung case */
      predictedMs: number | null
      measuredMs: number
      atLength: number
      subjectLength: number
    }

export type UserRegexOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'refused'; refusal: UserRegexRefusal }

/** Operator-facing, payload-free description of a refusal. Never echoes the pattern or the value. */
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

/**
 * Run `execute` against a caller-supplied pattern, refusing only on measured
 * evidence. Returns the real result of the real regex against the real subject
 * whenever it is not refused — byte-for-byte what the unguarded code returned.
 */
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
    // Validity is decided once, up front, so an invalid pattern never reaches the ladder.
    new RegExp(pattern, flags)
  } catch {
    return { status: 'refused', refusal: { kind: 'invalid-pattern' } }
  }

  // A fresh RegExp per timing rung: `lastIndex` on a /g pattern is per-object
  // state, and reusing one object across rungs would make every rung after the
  // first measure a different thing than the real call does.
  const timeAt = (len: number): number => {
    const probe = userRegexProbeSubject(subject, len)
    const re = new RegExp(pattern, flags)
    const started = nowMs()
    execute(re, probe)
    return nowMs() - started
  }
  // Re-measurement used only on the refusal path: a GC pause or a descheduled
  // slice can inflate one sample above the floor, and a refusal is a write-path
  // rejection. `min` of repeated samples removes that, and it costs nothing on
  // the overwhelmingly common accept path because it never runs there.
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
