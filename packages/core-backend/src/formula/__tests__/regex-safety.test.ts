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
} = guard

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
    const perRung = [...samplesAtLength.entries()].filter(([len]) => len < 40).map(([, n]) => n)
    expect(Math.max(...perRung)).toBeGreaterThanOrEqual(3)
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
