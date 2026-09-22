/**
 * PROPOSED (H-3, 2026-09-22, round 2) — behavioural proof for the user-supplied
 * regex guard.
 *
 * Round 1 shipped a STATIC SHAPE detector and this file only ever asserted that
 * the catastrophic shapes were refused. That is exactly the half of the contract
 * that cannot go wrong quietly. The expensive half — "does the guard refuse
 * something it should not?" — had no test at all, and an independent gate found
 * six extremely common LINEAR patterns being refused (a write-path 422 and a
 * persisted `#ERROR!`). The FALSE-POSITIVE battery below is therefore the
 * load-bearing part of this file, not an afterthought: every one of those six
 * patterns is pinned as MUST-ACCEPT, on an adversarial subject at the ceiling.
 *
 * Timing assertions are deliberately LOOSE (seconds, not milliseconds). The
 * discriminating power is the 20000ms-vs-single-digit-ms gap measured on the
 * unguarded implementation, not a tight constant; a tight constant in a required
 * lane is a flake generator. The tight measured numbers live in
 * docs/development/input-regex-redos-census-verification-20260922.md §5.
 */
import { describe, expect, it } from 'vitest'
import { FormulaEngine } from '../engine'
import * as guard from '../regex-safety'
import { validateRecord } from '../../multitable/field-validation-engine'

const {
  substituteLiteral,
  runUserRegex,
  userRegexProbeLadder,
  userRegexProbeSubject,
  selectFitAnchor,
  USER_REGEX_DECISION_DYNAMIC_RANGE,
  USER_REGEX_MAX_SUBJECT_LEN,
  USER_REGEX_MAX_PATTERN_LEN,
  USER_REGEX_PROBE_FLOOR_MS,
  USER_REGEX_PROBE_BUDGET_MS,
  USER_REGEX_SUPERLINEAR_SLOPE,
  USER_REGEX_REMEASURE_BUDGET_MS,
} = guard

/**
 * COST-CURVE SEAM. `runUserRegex` takes the work it times as a parameter, so a
 * test can hand it a manufactured cost curve and drive any branch of the ladder
 * deterministically — no clock injection, no attack payload in the tree, and no
 * dependence on how fast this machine happens to run a real regex.
 *
 * Why this matters for the ACCEPT side specifically: the false-positive corpus
 * (the six linear patterns) never enters the deciding branch at all — measured,
 * 0 entries in 18000 calls — and the true-positive corpus is refused under every
 * single conjunct taken alone. So the branch's "do NOT refuse" paths have no
 * natural input that reaches them, and every guard on them was untested until
 * these cases: an independent gate mutated four of them and the whole suite
 * stayed green.
 *
 * `costMs(len, nth)` is the cost, in ms, of the `nth` measurement at probe
 * length `len`. The REAL call (len === the subject's own length) must be free —
 * it is not a rung, and charging it would just slow the suite down.
 */
function burnMs(ms: number): void {
  const until = performance.now() + ms
  // Busy-wait on purpose: a timer would yield and be descheduled, which is the
  // very thing these cases must not depend on.
  while (performance.now() < until) { /* deliberate */ }
}

function costSeam(costMs: (len: number, nth: number) => number) {
  const samples = new Map<number, number>()
  const execute = (re: RegExp, s: string): boolean => {
    const nth = (samples.get(s.length) ?? 0) + 1
    samples.set(s.length, nth)
    const ms = costMs(s.length, nth)
    if (ms > 0) burnMs(ms)
    return re.test(s)
  }
  return { execute, samples }
}

/** A subject of `n` lower-case characters; the pattern below matches all of them. */
const SEAM_PATTERN = '^[a-z]+$'
const seamSubject = (n: number) => 'a'.repeat(n)

const engine = new FormulaEngine({ db: undefined as never })
const ctx = { sheetId: 's', row: 1, col: 1, values: {} } as never

async function evalMs(formula: string): Promise<{ ms: number; result: unknown }> {
  const t0 = process.hrtime.bigint()
  const result = await engine.calculate(formula, ctx)
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, result }
}

const patternField = (regex: string) => [{
  id: 'f1', name: 'F1', type: 'string',
  config: { validation: [{ type: 'pattern' as const, params: { regex } }] },
}]

function validateMs(fields: Parameters<typeof validateRecord>[0], data: Record<string, unknown>) {
  const t0 = process.hrtime.bigint()
  const out = validateRecord(fields, data)
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out }
}

/**
 * The six patterns the round-1 static detector refused, each with an ADVERSARIAL
 * subject at the subject ceiling (long member run + a failing tail — the shape
 * that makes a genuinely catastrophic pattern explode). All six are linear; the
 * gate measured every one of them at <=0.06ms on this exact input.
 */
const SIX_LINEAR: Array<{ pattern: string; matching: string; adversarial: string; label: string }> = [
  { label: 'version number', pattern: '^\\d+(\\.\\d+)*$', matching: '1.2.3', adversarial: '1'.repeat(USER_REGEX_MAX_SUBJECT_LEN - 1) + '!' },
  { label: 'slug / kebab-case', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', matching: 'my-valid-slug', adversarial: ('abc-'.repeat(2600)).slice(0, USER_REGEX_MAX_SUBJECT_LEN - 1) + '!' },
  { label: 'dotted identifier', pattern: '^(\\w+\\.)*\\w+$', matching: 'com.example.app', adversarial: ('abc.'.repeat(2600)).slice(0, USER_REGEX_MAX_SUBJECT_LEN - 1) + '!' },
  { label: 'comma list', pattern: '^[a-z]+(,[a-z]+)*$', matching: 'aa,bb,cc', adversarial: ('abc,'.repeat(2600)).slice(0, USER_REGEX_MAX_SUBJECT_LEN - 1) + '!' },
  { label: 'e-mail', pattern: '^[^@]+@[^@]+(\\.[^@]+)+$', matching: 'a@b.co', adversarial: 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN - 10) + '@b.c.d.ef' },
  { label: 'path segments', pattern: '^(/[a-z0-9_-]+)+$', matching: '/usr/local/bin', adversarial: ('/abc'.repeat(2600)).slice(0, USER_REGEX_MAX_SUBJECT_LEN - 1) + '!' },
]

/** The shapes that are genuinely catastrophic. n is chosen so the UNGUARDED cost is ~20s+. */
const MALICIOUS = [
  { pattern: '^(a+)+$', label: 'nested unbounded quantifier' },
  { pattern: '^(a|a)*$', label: 'alternation overlap (round-1 detector let this through)' },
  { pattern: '^([a-z]|[a-z])*$', label: 'class alternation overlap' },
]
/**
 * n=33. The UNGUARDED implementation was measured at 20545ms on exactly this
 * input (verification MD §4.4), which is what gives the <2000ms bound below its
 * discriminating power — and keeps a guard-removal mutation finishable rather
 * than running for the ~45 minutes n=41 would take.
 */
const MALICIOUS_SUBJECT = 'a'.repeat(32) + '!'

describe('SUBSTITUTE — literal replacement (Excel/Sheets semantics), no regex', () => {
  it('replaces literally and treats arg-2 metacharacters as literal text', () => {
    expect(substituteLiteral('a.b.c', '.', '-')).toBe('a-b-c')
    // Prior regex impl would treat "a+" as a quantifier; literal must match "a+".
    expect(substituteLiteral('xa+y', 'a+', 'Z')).toBe('xZy')
    expect(substituteLiteral('hello', '', '-')).toBe('hello') // empty old-text: unchanged
  })

  it('POSITIVE: a nested-quantifier arg-2 no longer backtracks (was ~300ms+, now sub-ms)', async () => {
    const subject = 'a'.repeat(30) + '!'
    const { ms, result } = await evalMs(`SUBSTITUTE("${subject}", "^(a+)+$", "X")`)
    // Literal: no "^(a+)+$" substring is present, so the text is returned verbatim.
    expect(result).toBe(subject)
    expect(ms).toBeLessThan(1000)
  })

  it('LINEAR CONTROL: ordinary SUBSTITUTE stays correct and fast', async () => {
    const { ms, result } = await evalMs('SUBSTITUTE("2026-09-22", "-", "/")')
    expect(result).toBe('2026/09/22')
    expect(ms).toBeLessThan(1000)
  })
})

describe('probe ladder — the sampling schedule itself', () => {
  it('is strictly ascending, strictly below the subject length, and ends within 1 character of it', () => {
    for (const n of [0, 1, 2, 3, 5, 17, 33, 64, 100, 1000, USER_REGEX_MAX_SUBJECT_LEN]) {
      const rungs = userRegexProbeLadder(n)
      for (let i = 1; i < rungs.length; i++) expect(rungs[i]).toBeGreaterThan(rungs[i - 1])
      for (const rung of rungs) {
        expect(rung).toBeGreaterThan(0)
        expect(rung).toBeLessThan(n)
      }
      // The final approach exists so the last step into the real run is small: a
      // pattern whose blow-up is driven by the SUFFIX length is flat on every
      // geometric rung. Without this, the last jump at n=10000 is ~1200 characters.
      if (n > 2) expect(rungs[rungs.length - 1]).toBe(n - 1)
    }
  })

  it('stays logarithmic in n (the guard must not cost more than the call it guards)', () => {
    expect(userRegexProbeLadder(USER_REGEX_MAX_SUBJECT_LEN).length).toBeLessThan(80)
  })

  it('bounds the ladder\'s TOTAL work, which the rung COUNT does not', () => {
    // The rung count is the wrong bound, and the benign path is the common path:
    // on a linear pattern NO rung crosses USER_REGEX_PROBE_FLOOR_MS, so the loop
    // never breaks early and the guard pays EVERY rung on every record write.
    // Eight more final-approach rungs would move the count by 8 and the WORK by
    // 8n. Measured on the current ladder: n=20 -> 189 characters (9.4x the real
    // subject), 200 -> 1815 (9.1x), 1000 -> 13102 (13.1x), 10000 -> 124494 (12.4x).
    for (const n of [20, 200, 1000, USER_REGEX_MAX_SUBJECT_LEN]) {
      const total = userRegexProbeLadder(n).reduce((a, b) => a + b, 0)
      expect(total, `total probe characters at n=${n}`).toBeLessThanOrEqual(16 * n)
    }
    // Non-degenerate in the other direction: the bound must not be satisfiable by
    // an empty or trivial ladder, which would pass every assertion above.
    const atCeiling = userRegexProbeLadder(USER_REGEX_MAX_SUBJECT_LEN).reduce((a, b) => a + b, 0)
    expect(atCeiling).toBeGreaterThan(8 * USER_REGEX_MAX_SUBJECT_LEN)
  })

  it('probe subjects keep the real tail — the failing character is what makes a shape explode', () => {
    const subject = 'a'.repeat(100) + '!'
    const probe = userRegexProbeSubject(subject, 20)
    expect(probe.length).toBe(20)
    expect(probe.endsWith('!')).toBe(true)
    // A plain prefix would drop it and make every rung a MATCHING case.
    expect(subject.slice(0, 20).endsWith('!')).toBe(false)
    expect(userRegexProbeSubject('short', 100)).toBe('short')
  })
})

describe('fit anchor — the rule that makes the verdict noise-proof', () => {
  it('anchors against the most recent rung at least DYNAMIC_RANGE times cheaper, never the neighbour', () => {
    // A real exponential ladder tail: the decision rung is 2.7ms, its NEIGHBOUR is
    // 1.3ms. Fitting the neighbour makes the verdict a ratio of two noisy ~1ms
    // samples; MEASURED, that design accepted `^(a+)+$` at n=33 intermittently and
    // then ran 22248ms. The anchor must skip back to a rung >= 8x cheaper.
    const sampled = [0.001, 0.05, 0.4, 1.3]
    expect(selectFitAnchor(sampled, 2.7)).toBe(1)          // 0.05 * 8 <= 2.7; 0.4 * 8 > 2.7
    expect(selectFitAnchor(sampled, 2.7)).not.toBe(sampled.length - 1) // never the neighbour
    expect(USER_REGEX_DECISION_DYNAMIC_RANGE).toBeGreaterThanOrEqual(4)
  })

  it('returns -1 when nothing sampled is that much cheaper (a flat curve is not evidence)', () => {
    expect(selectFitAnchor([1.0, 1.4, 1.9], 2.2)).toBe(-1)
    expect(selectFitAnchor([], 99)).toBe(-1)
  })

  it('honours the constant rather than a hard-coded 8', () => {
    const just_inside = 2.0 / USER_REGEX_DECISION_DYNAMIC_RANGE
    expect(selectFitAnchor([just_inside], 2.0)).toBe(0)
    expect(selectFitAnchor([just_inside * 1.01], 2.0)).toBe(-1)
  })
})

describe('confirmation re-measurement — the second guard on the refusal path', () => {
  it('re-measures a one-off spike instead of turning it into a refusal', () => {
    // The refusal path re-measures (`bestOf`) because a GC pause or a descheduled
    // slice can inflate ONE sample above the floor, and a refusal here is a
    // write-path rejection of a legitimate value. That re-measurement had NO test:
    // collapsing `bestOf` to a single sample left all 245 cases green, because in
    // a quiet process no sample is ever inflated — the classic untested guard.
    //
    // It is not hypothetical. Instrumented, the 100000-pair differential-fuzz
    // corpus crosses the floor on exactly ONE pair and the slope test calls that
    // pair super-linear; the re-measurement is what declines to refuse it.
    //
    // This case manufactures the inflation through the `execute` seam the guard
    // already takes, so no clock injection is needed: one rung is expensive for
    // its first TWO measurements — the shape of a pause spanning the ladder
    // sample AND the first confirmation sample — and free afterwards.
    const SPIKE_MS = USER_REGEX_PROBE_FLOOR_MS * 3
    const samplesAtLength = new Map<number, number>()
    const execute = (re: RegExp, s: string): boolean => {
      const n = (samplesAtLength.get(s.length) ?? 0) + 1
      samplesAtLength.set(s.length, n)
      if (s.length === 20 && n <= 2) {
        const until = performance.now() + SPIKE_MS
        while (performance.now() < until) { /* burn CPU, deliberately */ }
      }
      return re.test(s)
    }
    const outcome = runUserRegex('^[a-z]+$', undefined, 'a'.repeat(40), execute)

    // 1. BEHAVIOUR: a spike must not become a refusal.
    expect(outcome.status).toBe('ok')
    // 2. MECHANISM: and not merely because the deciding branch was never entered.
    //    Whichever rung decided must have been sampled three times (one ladder
    //    sample + two confirmation samples). With `bestOf` collapsed to a single
    //    sample the maximum is two, so this assertion is what kills that mutant —
    //    and it is a count of calls, not a duration, so it cannot flake.
    // Named by LENGTH, not `Math.max` over every rung: a maximum is satisfied by
    // ANY rung being sampled three times, so it could go green on a run where the
    // spike landed somewhere else entirely. 20 is the rung the spike is aimed at
    // and therefore the rung that decides; 19 is the anchor it is fitted against.
    expect(samplesAtLength.get(20), 'deciding rung sampled once + confirmed twice').toBe(3)
    expect(samplesAtLength.get(19), 'anchor rung sampled once + confirmed twice').toBe(3)
  })

  /**
   * P2-1 (r2 gate). The ONLY gate into the deciding branch is the floor test:
   * `ms >= USER_REGEX_PROBE_FLOOR_MS`. The confirmation re-measurement existed to
   * decide whether that sample was a pause — but it only fed the re-measured value
   * back into the SLOPE, never back into the floor test. So the guard could prove
   * the entry sample was noise and refuse on it anyway, contradicting the contract
   * `USER_REGEX_PROBE_FLOOR_MS` states in its own doc comment.
   *
   * Not hypothetical: under heap load the gate measured 1 refusal in 2000 runs of
   * ONE benign pair, and the refusal's own evidence read measuredMs=1.48ms against
   * a 2ms floor. This case reproduces that shape deterministically — first sample
   * above the floor, re-measurements below it.
   */
  it('a rung that re-measures BELOW the floor withdraws the refusal, not just the slope', () => {
    const N = 2000
    const DECIDE_AT = 20
    const { execute, samples } = costSeam((len, nth) => {
      if (len !== DECIDE_AT) return 0
      // Sample 1 crosses the floor (the inflated one). Samples 2 and 3 — the
      // confirmation — land BELOW it, which is what "that was a pause" looks like.
      return nth === 1 ? USER_REGEX_PROBE_FLOOR_MS * 3 : USER_REGEX_PROBE_FLOOR_MS * 0.75
    })
    const outcome = runUserRegex(SEAM_PATTERN, undefined, seamSubject(N), execute)

    // BEHAVIOUR: re-measured under the floor => not evidence => must not refuse.
    expect(outcome.status).toBe('ok')
    // MECHANISM: and not because the branch was never entered. One ladder sample
    // plus two confirmation samples at the deciding rung is the proof it ran.
    expect(samples.get(DECIDE_AT), 'deciding rung: 1 ladder + 2 confirmation').toBe(3)
  })

  /**
   * The other half of the withdrawal, and the half that matters more.
   *
   * "A rung below the floor decides nothing" has to mean the LADDER KEEPS GOING.
   * A first cut of this fix withdrew the refusal and then fell out of the loop
   * into the real call, which hands an unmeasured pattern the whole subject.
   * MEASURED on that cut: `^(a|a)*$` at n=33 entered the branch at a rung whose
   * first sample was above the floor and whose re-measurements were below it (the
   * FIRST sample at a length is systematically the slowest, so `bestOf`'s min is
   * biased DOWN, and this is warm-up rather than a pause), the refusal was
   * withdrawn, the ladder stopped, and the real call ran for 21884ms — 1 in 1000,
   * against 1000/1000 refusals on the round-2 code. The rung one step further up
   * is above the floor on every sample and refuses there.
   */
  it('a withdrawn refusal keeps climbing the ladder — a later rung can still refuse', () => {
    const N = 40
    const WITHDRAW_AT = 20
    const DECIDE_AT = 21
    const { execute, samples } = costSeam((len, nth) => {
      if (len >= N) return 0
      // The rung that looks expensive once and is cheap on every re-measurement.
      if (len === WITHDRAW_AT) return nth === 1 ? USER_REGEX_PROBE_FLOOR_MS * 3 : USER_REGEX_PROBE_FLOOR_MS * 0.75
      // The rung one step up, expensive on EVERY sample: real evidence.
      if (len === DECIDE_AT) return USER_REGEX_PROBE_FLOOR_MS * 15
      return 0
    })
    const outcome = runUserRegex(SEAM_PATTERN, undefined, seamSubject(N), execute)

    // BEHAVIOUR: the pattern is still refused. Stopping at the withdrawal would
    // accept it and pay the real call.
    expect(outcome.status).toBe('refused')
    // MECHANISM, by named length: the withdrawing rung was measured once and
    // confirmed twice, then re-used as the next rung's anchor (two more); the rung
    // above it was reached at all, which is the whole point — with a `break` there
    // it is never sampled.
    expect(samples.get(WITHDRAW_AT), 'withdrawing rung: ladder + confirmation + anchor confirmation').toBe(5)
    expect(samples.get(DECIDE_AT), 'the rung above it was reached and confirmed').toBe(3)
  })

  /**
   * P2-4 (r2 gate). The confirmation costs THREE runs of the deciding rung, and
   * the deciding rung's cost is unbounded: measured, a shape whose cost is
   * discontinuous in subject length crossed the floor on a single 660ms rung and
   * the guard paid 1927ms for a pattern the unguarded code answers in 0.005ms.
   * USER_REGEX_REMEASURE_BUDGET_MS bounds that multiplier.
   *
   * The assertion is a COUNT at a named length, not a duration: a duration
   * assertion tight enough to tell 1x from 3x would be a flake generator in a
   * required lane, and the count cannot flake.
   */
  it('stops re-measuring once the call has already spent the measurement budget', () => {
    const N = 2000
    const DECIDE_AT = 20
    const EXPENSIVE_MS = USER_REGEX_REMEASURE_BUDGET_MS * 1.5
    const { execute, samples } = costSeam((len) => (len === DECIDE_AT ? EXPENSIVE_MS : 0))
    const outcome = runUserRegex(SEAM_PATTERN, undefined, seamSubject(N), execute)

    // The verdict is unchanged — the budget bounds COST, never evidence.
    expect(outcome.status).toBe('refused')
    // One measurement of the expensive rung, not three. Without the budget this
    // is 3, and the anchor is re-measured too.
    expect(samples.get(DECIDE_AT), 'expensive rung measured exactly once').toBe(1)
    expect(samples.get(DECIDE_AT - 1), 'anchor not re-measured either').toBe(1)
    // Non-degenerate: the budget must be reachable by ONE rung but not by the
    // sub-floor sweep, or it would either never fire or fire on benign input.
    expect(EXPENSIVE_MS).toBeGreaterThan(USER_REGEX_REMEASURE_BUDGET_MS)
    expect(userRegexProbeLadder(USER_REGEX_MAX_SUBJECT_LEN).length * USER_REGEX_PROBE_FLOOR_MS)
      .toBeLessThan(USER_REGEX_REMEASURE_BUDGET_MS)
  })
})

/**
 * P2-2 (r2 gate) — the deciding branch's ACCEPT side.
 *
 * Four guards decide NOT to refuse. An independent gate deleted each of them and
 * all 247 cases stayed green, then proved each mutation was effective by driving
 * a manufactured cost curve through the `execute` seam. These are those curves,
 * kept as cases. Each asserts the OUTCOME and, separately, that the branch was
 * actually reached — a count at a named rung, never `Math.max` over all rungs.
 */
describe('deciding branch, ACCEPT side — the guards that decline to refuse', () => {
  it('a FLAT curve is not evidence: no anchor DYNAMIC_RANGE times cheaper => accept', () => {
    // Every rung costs the same until the deciding one, and the deciding one is
    // only 4x the rest — under USER_REGEX_DECISION_DYNAMIC_RANGE, so nothing
    // sampled is a valid anchor and there is no growth to fit. Refusing here
    // would be a guess. (The killing mutation is the one the anchor rule exists
    // to prevent: falling back to the ADJACENT rung when nothing is 8x cheaper,
    // which turns this flat curve into slope 27 and refuses it.)
    const N = 40
    const DECIDE_AT = 20
    const FLAT_MS = USER_REGEX_PROBE_FLOOR_MS * 0.75
    const { execute, samples } = costSeam((len) => {
      if (len >= N) return 0
      return len === DECIDE_AT ? USER_REGEX_PROBE_FLOOR_MS * 3 : FLAT_MS
    })
    const outcome = runUserRegex(SEAM_PATTERN, undefined, seamSubject(N), execute)

    expect(outcome.status).toBe('ok')
    // The floor WAS crossed at the deciding rung (so the branch was entered) and
    // the rung was NOT re-measured (so the exit was the flat-curve break, not a
    // confirmation that happened to decline).
    expect(samples.get(DECIDE_AT), 'deciding rung measured once, never confirmed').toBe(1)
    expect(FLAT_MS * USER_REGEX_DECISION_DYNAMIC_RANGE)
      .toBeGreaterThan(USER_REGEX_PROBE_FLOOR_MS * 3)
  })

  it('LINEAR growth whose extrapolation exceeds the budget is still accepted (slope is a conjunct, not a tie-break)', () => {
    // Cost strictly proportional to subject length => slope 1.0 exactly. The
    // extrapolation to the full subject is 220ms, well over
    // USER_REGEX_PROBE_BUDGET_MS — and it must STILL be accepted, because a
    // linear pattern that is merely slow is not a ReDoS. This conjunct is also
    // the load-bearing premise of the subject ceiling's derivation (b): "the
    // ladder only refuses super-QUADRATIC growth, so a genuinely quadratic
    // pattern is accepted and the ceiling is what bounds it".
    const N = USER_REGEX_MAX_SUBJECT_LEN
    const PER_CHAR_MS = 0.022
    const { execute, samples } = costSeam((len) => (len >= N ? 0 : len * PER_CHAR_MS))
    const outcome = runUserRegex(SEAM_PATTERN, undefined, seamSubject(N), execute)

    expect(outcome.status).toBe('ok')
    // Rung 100 is the first at/above the floor, so it decides; rung 12 is the
    // most recent rung at least DYNAMIC_RANGE times cheaper, so it is the anchor.
    expect(samples.get(100), 'deciding rung measured once, never confirmed').toBe(1)
    expect(samples.get(80), 'the rung below the floor was sampled').toBe(1)
    // Non-degenerate: the predicted full-subject cost really is over budget, so
    // the ONLY thing declining the refusal is the slope conjunct.
    expect(100 * PER_CHAR_MS).toBeGreaterThanOrEqual(USER_REGEX_PROBE_FLOOR_MS)
    expect(100 * PER_CHAR_MS * (N / 100)).toBeGreaterThan(USER_REGEX_PROBE_BUDGET_MS)
  })

  it('the FIRST rung re-measures three times before refusing a 2-character subject', () => {
    // `sampledLen.length === 0` is its own branch: there is no curve to fit, so a
    // 2-character probe costing floor-level CPU is refused on its face. That makes
    // the confirmation the ONLY thing standing between a pause and a refusal
    // there, and it is a separate call site from the deciding rung's — the gate
    // found this one never entered by any case in the suite.
    const N = 40
    const FIRST = 2
    const { execute, samples } = costSeam((len, nth) => {
      if (len !== FIRST) return 0
      return nth <= 2 ? USER_REGEX_PROBE_FLOOR_MS * 3 : 0
    })
    const outcome = runUserRegex(SEAM_PATTERN, undefined, seamSubject(N), execute)

    expect(outcome.status).toBe('ok')
    // 1 ladder sample + 3 confirmation samples. Two of the four are expensive, so
    // a confirmation of fewer than three samples would still see only spikes —
    // which is exactly what makes `bestOf(len, 3)` here, not `bestOf(len, 2)`.
    expect(samples.get(FIRST), 'first rung: 1 ladder + 3 confirmation').toBe(4)
  })

  it('super-linear growth whose extrapolation stays INSIDE the budget is accepted (the budget is a conjunct too)', () => {
    // The mirror image of the case above it: slope over the threshold, extrapolated
    // cost under it. Both conjuncts have to hold, and neither is a tie-break.
    //
    // This one is here because the round-2 gate reported the budget conjunct as
    // pinned (its `Mh`, 1 red) and the round-3 re-run of the same mutation came
    // back GREEN — so whatever reddened it was not a deterministic case. Rather
    // than carry the round-2 claim forward unverified, the conjunct gets a case.
    //
    // Curve: the deciding rung is the LAST one before the real subject, so the
    // extrapolation ratio is ~1 and the prediction cannot clear the budget at ANY
    // fitted slope — with the base clamped at MIN_MEASURABLE_MS the steepest slope
    // this curve can produce still predicts ~11ms. The anchor is placed at a named
    // rung and the rungs after it are made too expensive to qualify, so the fit is
    // against a rung whose cost this case controls rather than whichever one
    // happened to be cheap.
    const N = 40
    const DECIDE_AT = N - 1
    const ANCHOR_AT = 20
    const DECIDE_MS = USER_REGEX_PROBE_FLOOR_MS * 4
    const ANCHOR_MS = USER_REGEX_PROBE_FLOOR_MS * 0.25
    const FILLER_MS = USER_REGEX_PROBE_FLOOR_MS * 0.75
    const { execute, samples } = costSeam((len) => {
      if (len >= N || len <= 2) return 0
      if (len === DECIDE_AT) return DECIDE_MS
      return len === ANCHOR_AT ? ANCHOR_MS : FILLER_MS
    })
    const outcome = runUserRegex(SEAM_PATTERN, undefined, seamSubject(N), execute)

    expect(outcome.status).toBe('ok')
    expect(samples.get(DECIDE_AT), 'deciding rung measured once, never confirmed').toBe(1)
    // Non-degenerate, both directions. The slope really does clear its threshold
    // (so the ONLY thing declining the refusal is the budget), the filler rungs
    // really are disqualified as anchors, and every rung below the deciding one
    // really is below the floor.
    const slope = Math.log(DECIDE_MS / ANCHOR_MS) / Math.log(DECIDE_AT / ANCHOR_AT)
    expect(slope).toBeGreaterThan(USER_REGEX_SUPERLINEAR_SLOPE)
    expect(DECIDE_MS * Math.pow(N / DECIDE_AT, slope)).toBeLessThan(USER_REGEX_PROBE_BUDGET_MS)
    // Even the steepest slope this curve can yield stays inside the budget, so the
    // case does not rest on the anchor sample landing on a particular number.
    const steepest = Math.log(DECIDE_MS / 0.001) / Math.log(DECIDE_AT / 2)
    expect(DECIDE_MS * Math.pow(N / DECIDE_AT, steepest)).toBeLessThan(USER_REGEX_PROBE_BUDGET_MS)
    expect(FILLER_MS).toBeLessThan(USER_REGEX_PROBE_FLOOR_MS)
    expect(ANCHOR_MS * USER_REGEX_DECISION_DYNAMIC_RANGE).toBeLessThanOrEqual(DECIDE_MS)
    expect(FILLER_MS * USER_REGEX_DECISION_DYNAMIC_RANGE).toBeGreaterThan(DECIDE_MS)
  })

  it('the ANCHOR is re-measured too, and the re-measured anchor is what the verdict uses', () => {
    // The refusal fits growth between two rungs, so a pause on the ANCHOR inflates
    // the base and FLATTENS the fitted slope — it hides a real refusal rather than
    // manufacturing a false one. That is why the anchor has its own confirmation,
    // and it is the call site the gate found unpinned: the suite's one spike case
    // aims at a single length, and that length is always the deciding rung.
    //
    // Curve: the anchor's ladder sample is cheap enough BOTH to be selected as the
    // anchor and to make the first verdict super-linear (that is the entry
    // condition, so it is not free to choose); its FIRST confirmation sample is
    // inflated and its SECOND is nearly free. `bestOf` takes the min, sees the
    // near-free one, and refuses. Re-measuring only ONCE sees the inflated sample
    // and accepts — that mutation is killed by the outcome.
    //
    // Deleting the anchor confirmation outright CANNOT be killed by an outcome, and
    // that is a property of the code rather than a gap here: without it the verdict
    // is recomputed from the very same value that let the branch be entered, so it
    // always refuses. It is killed by the sample COUNT at the named anchor length,
    // which is the only observable that distinguishes it — a count paired with an
    // outcome assertion, never a count alone.
    const N = 100
    const DECIDE_AT = 6
    const ANCHOR_AT = 2
    const ANCHOR_LADDER_MS = 0.35
    const ANCHOR_SPIKE_MS = 1.2
    const { execute, samples } = costSeam((len, nth) => {
      if (len >= N) return 0
      if (len === DECIDE_AT) return USER_REGEX_PROBE_FLOOR_MS * 3
      if (len === ANCHOR_AT) return nth === 1 ? ANCHOR_LADDER_MS : nth === 2 ? ANCHOR_SPIKE_MS : 0.05
      // Every rung in between is too expensive to qualify as an anchor, so the
      // anchor is forced to the one rung whose confirmation this case controls.
      return 1.0
    })
    const outcome = runUserRegex(SEAM_PATTERN, undefined, seamSubject(N), execute)

    expect(outcome.status).toBe('refused')
    expect(samples.get(ANCHOR_AT), 'anchor: 1 ladder + 2 confirmation').toBe(3)
    expect(samples.get(DECIDE_AT), 'deciding rung: 1 ladder + 2 confirmation').toBe(3)
    // Non-degenerate: the ladder sample really does qualify as an anchor, the
    // in-between rungs really do not, and the inflated confirmation sample really
    // would flatten the fit below the slope threshold.
    expect(ANCHOR_LADDER_MS * USER_REGEX_DECISION_DYNAMIC_RANGE).toBeLessThanOrEqual(USER_REGEX_PROBE_FLOOR_MS * 3)
    expect(1.0 * USER_REGEX_DECISION_DYNAMIC_RANGE).toBeGreaterThan(USER_REGEX_PROBE_FLOOR_MS * 3)
    const slopeWith = (anchorMs: number) =>
      Math.log((USER_REGEX_PROBE_FLOOR_MS * 3) / anchorMs) / Math.log(DECIDE_AT / ANCHOR_AT)
    expect(slopeWith(ANCHOR_LADDER_MS)).toBeGreaterThan(2)
    expect(slopeWith(ANCHOR_SPIKE_MS)).toBeLessThan(2)
  })
})

describe('FALSE POSITIVES — the six common linear patterns the round-1 detector refused', () => {
  it.each(SIX_LINEAR.map((c) => [c.label, c] as const))(
    'ACCEPTS %s on a matching value (field-validation write path)',
    (_label, c) => {
      const { out } = validateMs(patternField(c.pattern), { f1: c.matching })
      expect(out.valid).toBe(true)
      expect(out.errors).toEqual([])
    },
  )

  it.each(SIX_LINEAR.map((c) => [c.label, c] as const))(
    'ACCEPTS %s on a ceiling-length adversarial value, and reports a real verdict',
    (_label, c) => {
      const { out, ms } = validateMs(patternField(c.pattern), { f1: c.adversarial })
      // The adversarial subject legitimately does NOT match (it ends in a failing
      // tail), so the assertion that matters is the ERROR SHAPE: an ordinary
      // format failure, never a guard refusal.
      for (const err of out.errors) {
        expect(err.message).toBe('F1 does not match the required format')
      }
      expect(ms).toBeLessThan(2000)
    },
  )

  it.each(SIX_LINEAR.map((c) => [c.label, c] as const))(
    'ACCEPTS %s in the formula engine (REGEXMATCH must not return #ERROR!)',
    async (_label, c) => {
      const { result } = await evalMs(`REGEXMATCH("${c.matching}", "${c.pattern.replace(/\\/g, '\\\\')}")`)
      expect(result).toBe(true)
    },
  )

  it('never enters the timing-decision branch FOR THESE SIX (measured 0 entries in 18000 calls)', () => {
    // Every rung of every one of the six stays far below the floor, so the
    // extrapolation branch — the only non-deterministic one — is never reached.
    //
    // Scope, because the earlier title generalised past the evidence: this holds
    // for THIS corpus. Over 100000 random linear pairs the branch is entered once
    // (verification MD §5.4), and there the confirmation re-measurement, not the
    // floor, is what prevents a refusal.
    for (const c of SIX_LINEAR) {
      let worst = 0
      for (const len of userRegexProbeLadder(c.adversarial.length)) {
        const probe = userRegexProbeSubject(c.adversarial, len)
        const re = new RegExp(c.pattern)
        const t0 = process.hrtime.bigint()
        re.test(probe)
        worst = Math.max(worst, Number(process.hrtime.bigint() - t0) / 1e6)
      }
      expect(worst).toBeLessThan(USER_REGEX_PROBE_FLOOR_MS)
    }
  })
})

describe('TRUE POSITIVES — catastrophic shapes are refused on measured evidence', () => {
  it.each(MALICIOUS.map((c) => [c.label, c.pattern] as const))(
    'field-validation refuses %s fast (unguarded: 20545ms measured at this exact n)',
    (_label, pattern) => {
      const { ms, out } = validateMs(patternField(pattern), { f1: MALICIOUS_SUBJECT })
      expect(out.valid).toBe(false)
      expect(out.errors).toHaveLength(1)
      // A refusal must be distinguishable from an ordinary format mismatch.
      expect(out.errors[0].message).not.toBe('F1 does not match the required format')
      expect(out.errors[0].message).toContain('too slow')
      expect(ms).toBeLessThan(2000)
    },
  )

  it.each(MALICIOUS.map((c) => [c.label, c.pattern] as const))(
    'REGEXMATCH refuses %s fast',
    async (_label, pattern) => {
      const { ms, result } = await evalMs(`REGEXMATCH("${MALICIOUS_SUBJECT}", "${pattern}")`)
      expect(result).toBe('#ERROR!')
      expect(ms).toBeLessThan(2000)
    },
  )

  it('refuses DETERMINISTICALLY across repeats (the first design fitted adjacent rungs and was flaky)', () => {
    // An adjacent-rung fit decides on the ratio between two ~1-3ms samples, which
    // scheduling noise can halve. Measured on that design: `^(a+)+$` at n=33 was
    // intermittently ACCEPTED and then ran for 22248ms. The shipped design anchors
    // the fit against a rung at least USER_REGEX_DECISION_DYNAMIC_RANGE times
    // cheaper. This repeat count is a flake-catcher, not a proof: it has high but
    // not certain power against a regression to the adjacent-rung fit.
    for (const pattern of MALICIOUS.map((m) => m.pattern)) {
      for (let i = 0; i < 20; i++) {
        const outcome = runUserRegex(pattern, undefined, MALICIOUS_SUBJECT, (re, s) => re.test(s))
        expect(outcome.status, `${pattern} run ${i}`).toBe('refused')
      }
    }
  })

  it('the refusal carries measured evidence, not a shape judgement', () => {
    const outcome = runUserRegex('^(a+)+$', undefined, MALICIOUS_SUBJECT, (re, s) => re.test(s))
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'ok') throw new Error('unreachable')
    expect(outcome.refusal.kind).toBe('superlinear')
    if (outcome.refusal.kind !== 'superlinear') throw new Error('unreachable')
    expect(outcome.refusal.slope).toBeGreaterThan(2)
    expect(outcome.refusal.predictedMs).toBeGreaterThan(100)
    expect(outcome.refusal.atLength).toBeLessThan(MALICIOUS_SUBJECT.length)
  })
})

/**
 * Shapes with STAR HEIGHT 1 — no quantified GROUP anywhere in the source, so no
 * nested quantifier and no quantified alternation for a static rule to find —
 * whose backtracking cost is nonetheless polynomial of degree >= 3 in the
 * subject length.
 *
 * These pin the guard against one specific proposed optimisation: "a pattern a
 * static rule can prove linear does not need the timing ladder, so skip it."
 * Round 1 of this slice already measured that a static shape rule cannot
 * separate the six common linear patterns from a catastrophic one in the REFUSE
 * direction. These two shapes are the same lesson in the ACCEPT direction, where
 * the failure mode is a guard BYPASS rather than a false positive: measured
 * unguarded on the census machine, `^a*a*a*a*b$` costs ~0.85s at n=250 and
 * ~39s at n=1000, and the subject ceiling is 10000 (verification MD §5.8.9).
 *
 * Each n is chosen so a regression that ACCEPTED the shape would still finish in
 * about a second — a hung required lane is a worse failure report than a red
 * assertion. The consequence, stated plainly: the discriminating assertion here
 * is the VERDICT, not a time bound. At these n the unguarded call is fast enough
 * that no loose millisecond bound would separate the two implementations, so
 * none is asserted.
 */
const STAR_HEIGHT_ONE_POLYNOMIAL: Array<{ label: string; pattern: string; n: number }> = [
  { label: 'four adjacent unbounded quantifiers over the same atom', pattern: '^a*a*a*a*b$', n: 250 },
  { label: 'three adjacent unbounded dot-stars', pattern: '^.*.*.*b$', n: 2000 },
]

/** A quantified group — `)` followed by a quantifier — is what every "nested quantifier" rule keys on. */
const hasQuantifiedGroup = (pattern: string) => /\)(?:[*+?]|\{\d)/.test(pattern)

describe('STAR-HEIGHT-1 POLYNOMIALS — the shapes a static "provably linear" rule would wave through', () => {
  it('POSITIVE CONTROL: the named catastrophic shapes DO carry a quantified group, so the predicate is not vacuous', () => {
    for (const { pattern } of MALICIOUS) {
      expect(hasQuantifiedGroup(pattern), pattern).toBe(true)
    }
    for (const { pattern } of SIX_LINEAR) {
      // ... and so does every one of the six LINEAR patterns, which is precisely
      // why a nested-quantifier rule cannot be used to separate the two groups.
      expect(hasQuantifiedGroup(pattern), pattern).toBe(true)
    }
  })

  it.each(STAR_HEIGHT_ONE_POLYNOMIAL.map((c) => [c.label, c.pattern, c.n] as const))(
    'refuses %s on measured evidence even though it carries no quantified group at all',
    (_label, pattern, n) => {
      expect(hasQuantifiedGroup(pattern), `${pattern} must carry no quantified group`).toBe(false)

      const outcome = runUserRegex(pattern, undefined, 'a'.repeat(n), (re, s) => re.test(s))
      expect(outcome.status).toBe('refused')
      if (outcome.status === 'ok') throw new Error('unreachable')
      expect(outcome.refusal.kind).toBe('superlinear')
      if (outcome.refusal.kind !== 'superlinear') throw new Error('unreachable')
      // The refusal rests on the measured curve, not on the shape: both conjuncts
      // of the verdict are asserted separately so a fast path that skipped the
      // ladder could not satisfy either.
      expect(outcome.refusal.slope).toBeGreaterThan(USER_REGEX_SUPERLINEAR_SLOPE)
      expect(outcome.refusal.predictedMs).toBeGreaterThan(USER_REGEX_PROBE_BUDGET_MS)
      expect(outcome.refusal.atLength).toBeLessThan(n)
    },
  )

  it.each(STAR_HEIGHT_ONE_POLYNOMIAL.map((c) => [c.label, c.pattern, c.n] as const))(
    'the real validateRecord refuses %s with the too-slow wording, not the format-mismatch wording',
    (_label, pattern, n) => {
      const { out } = validateMs(patternField(pattern), { f1: 'a'.repeat(n) })
      expect(out.valid).toBe(false)
      expect(out.errors).toHaveLength(1)
      expect(out.errors[0].message).not.toBe('F1 does not match the required format')
      expect(out.errors[0].message).toContain('too slow')
    },
  )
})

describe('subject ceiling — independent of the field\'s own rule list', () => {
  it('refuses an over-ceiling value with its own wording (never the format-mismatch message)', () => {
    const { ms, out } = validateMs(patternField('^[a-z]*$'), { f1: 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN + 1) })
    expect(out.valid).toBe(false)
    expect(out.errors[0].message).toContain(`${USER_REGEX_MAX_SUBJECT_LEN}-character limit`)
    expect(out.errors[0].message).not.toBe('F1 does not match the required format')
    expect(ms).toBeLessThan(2000)
  })

  it('accepts a value exactly at the ceiling (the bound is inclusive, and it is the ONLY length bound here)', () => {
    // This field declares explicit validation with NO maxLength rule; the two call
    // sites merge as `explicitRules ?? defaultRules`, so the built-in
    // `maxLength: 10000` is gone and this ceiling is all there is.
    const { out } = validateMs(patternField('^[a-z]*$'), { f1: 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN) })
    expect(out.valid).toBe(true)
  })

  it('REGEXREPLACE refuses an over-ceiling subject fast (unguarded: quadratic, seconds)', async () => {
    const subject = 'Z' + ' '.repeat(USER_REGEX_MAX_SUBJECT_LEN + 50000) + 'Z'
    const { ms, result } = await evalMs(`REGEXREPLACE("${subject}", "^\\\\s+|\\\\s+$", "")`)
    expect(result).toBe('#ERROR!')
    expect(ms).toBeLessThan(2000)
  })

  it('accepts the worst measured QUADRATIC shape at the ceiling (slope 2 is not refused)', () => {
    const subject = 'Z' + ' '.repeat(USER_REGEX_MAX_SUBJECT_LEN - 2) + 'Z'
    const outcome = runUserRegex('^\\s+|\\s+$', 'g', subject, (re, s) => s.replace(re, ''))
    expect(outcome.status).toBe('ok')
  })
})

describe('pattern-length ceiling', () => {
  it('refuses an over-length pattern before compiling it', () => {
    const outcome = runUserRegex('x'.repeat(USER_REGEX_MAX_PATTERN_LEN + 1), undefined, 'x', (re, s) => re.test(s))
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'ok') throw new Error('unreachable')
    expect(outcome.refusal.kind).toBe('pattern-too-long')
  })

  it('accepts a pattern exactly at the limit', () => {
    const outcome = runUserRegex('x'.repeat(USER_REGEX_MAX_PATTERN_LEN), undefined, 'x', (re, s) => re.test(s))
    expect(outcome.status).toBe('ok')
  })
})

describe('REGEX* — the guarded call still returns exactly what the unguarded call returned', () => {
  it('LINEAR CONTROL: legitimate patterns keep their results', async () => {
    const m = await evalMs('REGEXMATCH("hello-world", "^[a-z-]+$")')
    expect(m.result).toBe(true)
    const r = await evalMs('REGEXREPLACE("a1b2c3", "[0-9]", "")')
    expect(r.result).toBe('abc')
    const e = await evalMs('REGEXEXTRACT("id=42", "id=([0-9]+)")')
    expect(e.result).toBe('42')
    const miss = await evalMs('REGEXEXTRACT("nope", "id=([0-9]+)")')
    expect(miss.result).toBe('#VALUE!')
  })

  it('an invalid pattern keeps the pre-existing contract', async () => {
    const m = await evalMs('REGEXMATCH("x", "(")')
    expect(m.result).toBe('#ERROR!')
    // field-validation side: invalid regex still fails validation with the ORDINARY
    // message — that branch predates this slice and is deliberately unchanged.
    const { out } = validateMs(patternField('('), { f1: 'x' })
    expect(out.valid).toBe(false)
    expect(out.errors[0].message).toBe('F1 does not match the required format')
  })

  it('an ordinary validation failure still reports the ordinary message', () => {
    const { out } = validateMs(patternField('^[0-9]+$'), { f1: 'abc' })
    expect(out.valid).toBe(false)
    expect(out.errors[0].message).toBe('F1 does not match the required format')
  })
})
