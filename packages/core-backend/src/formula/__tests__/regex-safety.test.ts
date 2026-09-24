/**
 * Behavioural pins for `../regex-safety.ts` and for the two sites that go
 * through it: the formula engine's REGEX* / SUBSTITUTE functions and the
 * field-validation `pattern` rule.
 *
 * The file is organised by CLAIM, and each claim names the mutation that
 * turns it red, so a reviewer can check the pin has teeth:
 *   - length gate: remove either length check          -> gate cases red
 *   - "before compile": swap the gate after `new RegExp` -> that one case red
 *   - shape warning never refuses: return a refusal      -> "log, not a gate" red
 *   - site equivalence: change a site's answer inside the limits -> tables/fuzz red
 *   - timing: put a site back on a bare `new RegExp`     -> that site's timing case red
 *
 * Timing assertions live in their own `describe` at the bottom and are LOOSE
 * on purpose (hundreds of milliseconds against a guarded path that is a length
 * comparison, and against an unguarded path measured in seconds). The tight
 * measured numbers are in docs/development/input-regex-redos-route-ii-verification-20260925.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FormulaEngine } from '../engine'
import {
  USER_REGEX_MAX_PATTERN_LEN,
  USER_REGEX_MAX_SUBJECT_LEN,
  USER_REGEX_SHAPE_WARNING_MEMORY,
  describeUserRegexRefusal,
  describeUserRegexShape,
  findUserRegexLengthRefusal,
  resetUserRegexShapeWarnings,
  runUserRegex,
  userRegexGuardHooks,
  type UserRegexShapeWarning,
} from '../regex-safety'
import { validateFieldValue, validateRecord } from '../../multitable/field-validation-engine'
import type { FieldValidationConfig } from '../../multitable/field-validation'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const engine = new FormulaEngine({ db: undefined as never })
const ctx = { sheetId: 's', spreadsheetId: 'sp', currentCell: { row: 1, col: 1 }, cache: new Map() } as never

type Fn = (...args: unknown[]) => unknown
const fn = (name: string): Fn => {
  const f = (engine as unknown as { functions: Map<string, Fn> }).functions.get(name)
  if (!f) throw new Error(`function ${name} is not registered`)
  return f
}

/**
 * The four sinks exactly as they were before this slice, used as the REFERENCE
 * for the equivalence claims below. They are copied, not imported, because the
 * point is to compare against the previous behaviour, not against the current
 * code's idea of it.
 */
const reference = {
  REGEXMATCH: (text: unknown, pattern: unknown) => {
    try { return new RegExp(String(pattern)).test(String(text)) } catch { return '#ERROR!' }
  },
  REGEXEXTRACT: (text: unknown, pattern: unknown) => {
    try { const m = String(text).match(new RegExp(String(pattern))); return m ? (m[1] ?? m[0]) : '#VALUE!' } catch { return '#ERROR!' }
  },
  REGEXREPLACE: (text: unknown, pattern: unknown, replacement: unknown) => {
    try { return String(text).replace(new RegExp(String(pattern), 'g'), String(replacement)) } catch { return '#ERROR!' }
  },
  SUBSTITUTE: (text: unknown, old: unknown, newText: unknown) =>
    String(text).replace(new RegExp(String(old), 'g'), String(newText)),
  /** The previous `validatePattern`: invalid regex counts as a failed validation. */
  pattern: (value: unknown, regex: string, flags?: string): boolean => {
    if (typeof value !== 'string') return false
    try { return new RegExp(regex, flags).test(value) } catch { return false }
  },
}

const patternField = (regex: string, message?: string) => [{
  id: 'f1', name: 'F1', type: 'string',
  config: { validation: [{ type: 'pattern' as const, params: { regex }, ...(message ? { message } : {}) }] },
}]

const ms = <T,>(work: () => T): { ms: number; out: T } => {
  const t0 = performance.now()
  const out = work()
  return { ms: performance.now() - t0, out }
}

/** Small deterministic PRNG (mulberry32) so the fuzz below is replayable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A pattern corpus that is LINEAR BY CONSTRUCTION: single atoms may carry a
 * quantifier, but no GROUP is ever quantified, so nothing in it can backtrack
 * super-linearly. That is deliberate — the equivalence claim is "inside the
 * limits the answer is unchanged", and a corpus that could hang would only test
 * this machine's patience. The subject alphabet overlaps the atoms so both
 * matches and misses occur (asserted below, so the corpus cannot degenerate).
 */
const FUZZ_LITERALS = 'abz09-_.'
const FUZZ_SUBJECT_ALPHABET = 'abz09-_. @'
function fuzzPattern(rnd: () => number): string {
  const atoms: string[] = []
  const n = 1 + Math.floor(rnd() * 4)
  for (let i = 0; i < n; i++) {
    const r = rnd()
    let atom: string
    if (r < 0.4) {
      const ch = FUZZ_LITERALS[Math.floor(rnd() * FUZZ_LITERALS.length)]
      atom = ch === '.' ? '\\.' : ch
    } else if (r < 0.55) atom = '[a-z]'
    else if (r < 0.65) atom = '\\d'
    else if (r < 0.75) atom = '\\w'
    else if (r < 0.85) atom = '.'
    else atom = '[^@]'
    const q = rnd()
    if (q < 0.25) atom += '+'
    else if (q < 0.4) atom += '*'
    else if (q < 0.5) atom += '?'
    else if (q < 0.55) atom += '{1,3}'
    atoms.push(atom)
  }
  let body = atoms.join('')
  if (rnd() < 0.2) body = `(${body})` // an UNQUANTIFIED capture group — still linear
  if (rnd() < 0.15) body = `${body}|${FUZZ_LITERALS[Math.floor(rnd() * 3)]}`
  return `${rnd() < 0.5 ? '^' : ''}${body}${rnd() < 0.5 ? '$' : ''}`
}
function fuzzSubject(rnd: () => number): string {
  const len = Math.floor(rnd() * 65)
  let s = ''
  for (let i = 0; i < len; i++) s += FUZZ_SUBJECT_ALPHABET[Math.floor(rnd() * FUZZ_SUBJECT_ALPHABET.length)]
  return s
}
const FUZZ_PAIRS = 2000

// ---------------------------------------------------------------------------
// 1. Length gate
// ---------------------------------------------------------------------------

describe('length gate — findUserRegexLengthRefusal', () => {
  it('accepts lengths AT both limits (the limit is inside)', () => {
    expect(findUserRegexLengthRefusal(USER_REGEX_MAX_PATTERN_LEN, USER_REGEX_MAX_SUBJECT_LEN)).toBeNull()
    expect(findUserRegexLengthRefusal(0, 0)).toBeNull()
  })

  it('refuses a pattern one over the limit, naming the length and the limit', () => {
    expect(findUserRegexLengthRefusal(USER_REGEX_MAX_PATTERN_LEN + 1, 0)).toEqual({
      kind: 'pattern-too-long', length: USER_REGEX_MAX_PATTERN_LEN + 1, limit: USER_REGEX_MAX_PATTERN_LEN,
    })
  })

  it('refuses a subject one over the limit, naming the length and the limit', () => {
    expect(findUserRegexLengthRefusal(0, USER_REGEX_MAX_SUBJECT_LEN + 1)).toEqual({
      kind: 'subject-too-long', length: USER_REGEX_MAX_SUBJECT_LEN + 1, limit: USER_REGEX_MAX_SUBJECT_LEN,
    })
  })

  it('checks the pattern first when both are over', () => {
    expect(findUserRegexLengthRefusal(USER_REGEX_MAX_PATTERN_LEN + 1, USER_REGEX_MAX_SUBJECT_LEN + 1)?.kind).toBe('pattern-too-long')
  })

  it('the two limits are the documented product constraints', () => {
    // `getDefaultValidationRules` maxLength for string/longText, and the dry-run
    // route's expression cap. A change here is a visible edit, not drift.
    expect(USER_REGEX_MAX_SUBJECT_LEN).toBe(10000)
    expect(USER_REGEX_MAX_PATTERN_LEN).toBe(4000)
  })

  it('describes each refusal in one line that names the limit', () => {
    expect(describeUserRegexRefusal({ kind: 'subject-too-long', length: 1, limit: 7 }, 'Name')).toBe('Name exceeds the 7-character limit for pattern checks')
    expect(describeUserRegexRefusal({ kind: 'pattern-too-long', length: 1, limit: 9 }, 'Name')).toBe('Name has a pattern rule longer than the 9-character limit')
    expect(describeUserRegexRefusal({ kind: 'invalid-pattern', message: 'x' }, 'Name')).toBe('Name has an invalid pattern rule')
  })
})

describe('runUserRegex — gate before compile, compile, evaluate', () => {
  it('refuses an over-length pattern BEFORE compiling it (an invalid over-length pattern is "too long", not "invalid")', () => {
    let executed = 0
    // `[` alone is a syntax error; padded past the limit it must be refused for
    // its LENGTH, which is only possible if the gate runs before `new RegExp`.
    const outcome = runUserRegex('['.repeat(USER_REGEX_MAX_PATTERN_LEN + 1), undefined, 'x', () => { executed++; return true })
    expect(outcome).toEqual({ status: 'refused', refusal: { kind: 'pattern-too-long', length: USER_REGEX_MAX_PATTERN_LEN + 1, limit: USER_REGEX_MAX_PATTERN_LEN } })
    expect(executed).toBe(0)
  })

  it('refuses an over-length subject without running the pattern on it', () => {
    let executed = 0
    const outcome = runUserRegex('^a+$', undefined, 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN + 1), () => { executed++; return true })
    expect(outcome.status).toBe('refused')
    expect(outcome.status === 'refused' && outcome.refusal.kind).toBe('subject-too-long')
    expect(executed).toBe(0)
  })

  it('reports an invalid pattern inside the limits as invalid-pattern, with the engine message', () => {
    const outcome = runUserRegex('[', undefined, 'x', () => true)
    expect(outcome.status).toBe('refused')
    if (outcome.status === 'refused' && outcome.refusal.kind === 'invalid-pattern') {
      expect(outcome.refusal.message.length).toBeGreaterThan(0)
    } else {
      throw new Error('expected invalid-pattern')
    }
  })

  it('inside the limits hands execute the compiled RegExp (with flags) and the unchanged subject', () => {
    const seen: Array<[string, string, string]> = []
    const outcome = runUserRegex('a+', 'gi', 'xAAy', (re, s) => { seen.push([re.source, re.flags, s]); return s.replace(re, '-') })
    expect(outcome).toEqual({ status: 'ok', value: 'x-y' })
    expect(seen).toEqual([['a+', 'gi', 'xAAy']])
  })

  it('lets an exception thrown by execute propagate unchanged', () => {
    expect(() => runUserRegex('a', undefined, 'a', () => { throw new Error('from execute') })).toThrow('from execute')
  })
})

// ---------------------------------------------------------------------------
// 2. Shape warning
// ---------------------------------------------------------------------------

const kinds = (pattern: string) => describeUserRegexShape(pattern).map((w) => w.kind)

describe('shape warning — describeUserRegexShape', () => {
  it.each([
    ['(a+)+', ['nested-quantifier']],
    ['^(a*)*$', ['nested-quantifier']],
    ['^([a-z]+)*$', ['nested-quantifier']],
    ['(\\w+\\s?)+', ['nested-quantifier']],
    ['(x?a+)+', ['nested-quantifier']], // a leading OPTIONAL atom does not hide the unbounded one
    ['((a+)b)+', ['nested-quantifier']], // through an inner group
    ['(a+){2,}', ['nested-quantifier']], // {n,} is unbounded
    ['(a+)+?', ['nested-quantifier']], // lazy has the same bounds
    ['(a|aa)+', ['quantified-alternation']],
    ['^(a|b)*$', ['quantified-alternation']],
    ['(?:a|b)+', ['quantified-alternation']], // non-capturing groups count
    ['(?<n>a|b)+', ['quantified-alternation']], // named groups count
    ['(a+|b)*', ['nested-quantifier', 'quantified-alternation']],
  ])('flags %s as %j', (pattern, expected) => {
    expect(kinds(pattern)).toEqual(expected)
  })

  it.each([
    '^\\d+(\\.\\d+)*$', // version number: iterations start with a delimiter
    '^[a-z0-9]+(-[a-z0-9]+)*$', // slug
    '^[a-z]+(,[a-z]+)*$', // comma list
    '^[^@]+@[^@]+(\\.[^@]+)+$', // e-mail
    '^(/[a-z0-9_-]+)+$', // path segments
    '^[a-z]+$',
    '^(a+)$', // group is not quantified
    '(a+)?', // outer quantifier is bounded
    '(a+){2}', // outer quantifier is bounded
    '(a|b)', // alternation, but not quantified
    '\\(a+\\)+', // escaped parentheses are literals, not a group
    '[(a+)]+', // parentheses inside a class are literals
    'a{2,}b{3,}', // adjacent unbounded atoms, no group
    '(?=a+)b+', // lookahead is zero-width; not an atom that starts the sequence
    '',
  ])('does not flag %s', (pattern) => {
    expect(kinds(pattern)).toEqual([])
  })

  it('has a DOCUMENTED false positive: a group that starts unbounded but is delimiter-separated', () => {
    // Linear, but flagged — the scanner does not model the delimiter that makes
    // it so. This is why the warning is a log and not a gate; the case is
    // pinned so the documentation and the code cannot drift apart silently.
    expect(kinds('^(\\w+\\.)*\\w+$')).toEqual(['nested-quantifier'])
  })

  it('reports the index of the offending group', () => {
    const warnings: UserRegexShapeWarning[] = describeUserRegexShape('^ab(c+)+$')
    expect(warnings).toEqual([{ kind: 'nested-quantifier', at: 3 }])
  })

  it.each([
    '(', ')', '[', '\\', '(?', '(?<', '(?<x', '(?P<x>a)', '{', 'a{2,1}', '*', '+a', '[z-a]', '(a+', 'a)+', '(?=', '\\k<', '[\\', 'a{', 'a{1,',
  ])('never throws on the malformed input %s', (pattern) => {
    expect(() => describeUserRegexShape(pattern)).not.toThrow()
  })
})

describe('shape warning is a log, not a gate', () => {
  const originalWarn = userRegexGuardHooks.warn
  let warnings: Array<{ message: string; meta: Record<string, unknown> }> = []

  beforeEach(() => {
    warnings = []
    resetUserRegexShapeWarnings()
    userRegexGuardHooks.warn = (message, meta) => { warnings.push({ message, meta }) }
  })
  afterEach(() => {
    userRegexGuardHooks.warn = originalWarn
    resetUserRegexShapeWarnings()
  })

  it('evaluates a flagged pattern unchanged and returns its real answer, logging once', () => {
    const outcome = runUserRegex('^(a+)+$', undefined, 'aaa', (re, s) => re.test(s), { site: 'test' })
    expect(outcome).toEqual({ status: 'ok', value: true })
    expect(warnings).toHaveLength(1)
    expect(warnings[0].meta).toMatchObject({ site: 'test', kinds: ['nested-quantifier'], patternLength: 7, flags: '' })
  })

  it('does not log a second time for the same (pattern, flags) in the same process', () => {
    runUserRegex('^(a+)+$', undefined, 'a', (re, s) => re.test(s))
    runUserRegex('^(a+)+$', undefined, 'b', (re, s) => re.test(s))
    expect(warnings).toHaveLength(1)
    runUserRegex('^(a+)+$', 'i', 'b', (re, s) => re.test(s)) // different flags: a different compiled regex
    expect(warnings).toHaveLength(2)
  })

  it('does not log for a pattern the scanner does not flag', () => {
    runUserRegex('^[a-z0-9]+(-[a-z0-9]+)*$', undefined, 'my-slug', (re, s) => re.test(s))
    expect(warnings).toHaveLength(0)
  })

  it('still evaluates when the log sink itself throws', () => {
    userRegexGuardHooks.warn = () => { throw new Error('sink down') }
    const outcome = runUserRegex('^(a+)+$', undefined, 'aaa', (re, s) => re.test(s))
    expect(outcome).toEqual({ status: 'ok', value: true })
  })

  it('keeps the de-duplication memory bounded (the oldest entry is forgotten first)', () => {
    for (let i = 0; i < USER_REGEX_SHAPE_WARNING_MEMORY; i++) {
      runUserRegex(`^(a+)+${i}$`, undefined, 'x', (re, s) => re.test(s))
    }
    expect(warnings).toHaveLength(USER_REGEX_SHAPE_WARNING_MEMORY)
    runUserRegex('^(a+)+0$', undefined, 'x', (re, s) => re.test(s)) // still remembered
    expect(warnings).toHaveLength(USER_REGEX_SHAPE_WARNING_MEMORY)
    runUserRegex('^(a+)+overflow$', undefined, 'x', (re, s) => re.test(s)) // evicts pattern 0
    expect(warnings).toHaveLength(USER_REGEX_SHAPE_WARNING_MEMORY + 1)
    runUserRegex('^(a+)+0$', undefined, 'x', (re, s) => re.test(s)) // warned again
    expect(warnings).toHaveLength(USER_REGEX_SHAPE_WARNING_MEMORY + 2)
  })
})

// ---------------------------------------------------------------------------
// 3. Formula engine site (L1): REGEXMATCH / REGEXEXTRACT / REGEXREPLACE / SUBSTITUTE
// ---------------------------------------------------------------------------

describe('formula engine site — same answer as before inside the limits', () => {
  // Formula-text cases go through the engine's own string-literal parser, which
  // is unchanged here and does not carry backslash escapes through; the cases
  // therefore use bracket classes. Escaped atoms are covered by the fuzz below,
  // which calls the registered functions directly.
  it.each([
    ['=REGEXMATCH("my-valid-slug", "^[a-z0-9]+(-[a-z0-9]+)*$")', true],
    ['=REGEXMATCH("1.2.x", "^[0-9]+([.][0-9]+)*$")', false],
    ['=REGEXEXTRACT("v1.2.3", "([0-9]+([.][0-9]+)*)")', '1.2.3'],
    ['=REGEXEXTRACT("abc", "\\d+")', '#VALUE!'],
    ['=REGEXREPLACE("a1b22c333", "[0-9]+", "#")', 'a#b#c#'],
    ['=SUBSTITUTE("hello world", "world", "there")', 'hello there'],
    ['=SUBSTITUTE("a.b.c", ".", "-")', '-----'], // arg 2 is still compiled as a pattern (unchanged)
    ['=REGEXMATCH("abc", "[")', '#ERROR!'],
    ['=REGEXEXTRACT("abc", "[")', '#ERROR!'],
    ['=REGEXREPLACE("abc", "[", "x")', '#ERROR!'],
    ['=SUBSTITUTE("abc", "[", "x")', '#ERROR!'],
  ])('%s -> %j', async (formula, expected) => {
    expect(await engine.calculate(formula, ctx)).toEqual(expected)
  })

  it('REGEXMATCH / REGEXEXTRACT / REGEXREPLACE / SUBSTITUTE agree with the previous implementation on a linear fuzz corpus', () => {
    const rnd = mulberry32(0x5eed1)
    const patterns = new Set<string>()
    let trues = 0
    let falses = 0
    for (let i = 0; i < FUZZ_PAIRS; i++) {
      const pattern = fuzzPattern(rnd)
      const subject = fuzzSubject(rnd)
      patterns.add(pattern)
      const match = fn('REGEXMATCH')(subject, pattern)
      expect(match, `REGEXMATCH ${JSON.stringify([subject, pattern])}`).toEqual(reference.REGEXMATCH(subject, pattern))
      if (match === true) trues++
      else if (match === false) falses++
      expect(fn('REGEXEXTRACT')(subject, pattern), `REGEXEXTRACT ${JSON.stringify([subject, pattern])}`).toEqual(reference.REGEXEXTRACT(subject, pattern))
      expect(fn('REGEXREPLACE')(subject, pattern, 'X'), `REGEXREPLACE ${JSON.stringify([subject, pattern])}`).toEqual(reference.REGEXREPLACE(subject, pattern, 'X'))
      expect(fn('SUBSTITUTE')(subject, pattern, 'X'), `SUBSTITUTE ${JSON.stringify([subject, pattern])}`).toEqual(reference.SUBSTITUTE(subject, pattern, 'X'))
    }
    // Non-degeneracy: the corpus must contain many patterns and both verdicts.
    expect(patterns.size).toBeGreaterThan(FUZZ_PAIRS / 4)
    expect(trues).toBeGreaterThan(50)
    expect(falses).toBeGreaterThan(50)
  })
})

describe('formula engine site — refusals at the limits', () => {
  const atCap = 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN)
  const overCap = 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN + 1)
  const longPattern = 'a'.repeat(USER_REGEX_MAX_PATTERN_LEN + 1)

  it('a subject AT the limit gets its real answer', () => {
    expect(fn('REGEXMATCH')(atCap, '^a+$')).toBe(true)
    expect(fn('REGEXEXTRACT')(atCap, 'a')).toBe('a')
    expect(fn('REGEXREPLACE')(atCap, 'a', '')).toBe('')
    expect(fn('SUBSTITUTE')(atCap, 'a', '')).toBe('')
  })

  it.each(['REGEXMATCH', 'REGEXEXTRACT', 'REGEXREPLACE', 'SUBSTITUTE'])('%s reports #ERROR! for a subject one over the limit', (name) => {
    expect(fn(name)(overCap, '^a+$', '')).toBe('#ERROR!')
    // The previous implementation returned a real answer for this input; the
    // difference is the gate, not a changed answer inside the limits.
  })

  it.each(['REGEXMATCH', 'REGEXEXTRACT', 'REGEXREPLACE', 'SUBSTITUTE'])('%s reports #ERROR! for a pattern one over the limit', (name) => {
    expect(fn(name)('abc', longPattern, '')).toBe('#ERROR!')
  })
})

// ---------------------------------------------------------------------------
// 4. Field-validation site (L2): the `pattern` rule
// ---------------------------------------------------------------------------

describe('field-validation pattern rule — same answer as before inside the limits', () => {
  it.each([
    ['^[a-z0-9]+(-[a-z0-9]+)*$', 'my-valid-slug'],
    ['^[a-z0-9]+(-[a-z0-9]+)*$', 'Not A Slug'],
    ['^\\d+(\\.\\d+)*$', '1.2.3'],
    ['^[^@]+@[^@]+(\\.[^@]+)+$', 'a@b.co'],
    ['^(\\+\\d{1,3}[- ]?)?\\d{10}$', '+86 1234567890'],
    ['[', 'anything'], // invalid regex: still a failed validation
  ])('pattern %s on %j', (regex, value) => {
    const errs = validateFieldValue('f1', 'F1', 'string', value, patternField(regex)[0].config.validation as FieldValidationConfig)
    expect(errs.length === 0).toBe(reference.pattern(value, regex))
    if (errs.length) {
      expect(errs[0]).toEqual({ fieldId: 'f1', fieldName: 'F1', rule: 'pattern', message: 'F1 does not match the required format' })
    }
  })

  it('keeps a custom rule message for a format mismatch', () => {
    const errs = validateFieldValue('f1', 'F1', 'string', 'nope', patternField('^\\d+$', 'digits only')[0].config.validation as FieldValidationConfig)
    expect(errs.map((e) => e.message)).toEqual(['digits only'])
  })

  it('honours the flags parameter as before', () => {
    const rules: FieldValidationConfig = [{ type: 'pattern', params: { regex: '^abc$', flags: 'i' } }]
    expect(validateFieldValue('f1', 'F1', 'string', 'ABC', rules)).toEqual([])
  })

  it('agrees with the previous validatePattern on a linear fuzz corpus', () => {
    const rnd = mulberry32(0x5eed2)
    let passes = 0
    let fails = 0
    for (let i = 0; i < FUZZ_PAIRS; i++) {
      const regex = fuzzPattern(rnd)
      const value = fuzzSubject(rnd)
      if (value.trim() === '') continue // an empty value skips the rule (unchanged behaviour, not under test here)
      const errs = validateFieldValue('f1', 'F1', 'string', value, [{ type: 'pattern', params: { regex } }])
      const expected = reference.pattern(value, regex)
      expect(errs.length === 0, `pattern ${JSON.stringify([regex, value])}`).toBe(expected)
      if (expected) passes++
      else fails++
    }
    expect(passes).toBeGreaterThan(50)
    expect(fails).toBeGreaterThan(50)
  })
})

describe('field-validation pattern rule — refusals at the limits', () => {
  const atCap = 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN)
  const overCap = 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN + 1)

  it('a value AT the limit gets its real answer (a pattern-only rule list has no other length bound)', () => {
    // This field declares ONLY a pattern rule, so the default maxLength is not
    // in force (`explicitRules ?? defaultRules` replaces, it does not merge).
    expect(validateRecord(patternField('^a+$') as never, { f1: atCap })).toEqual({ valid: true, errors: [] })
    expect(validateRecord(patternField('^b+$') as never, { f1: atCap }).valid).toBe(false)
  })

  it('a value one over the limit fails the rule with the refusal message, not the format message', () => {
    const out = validateRecord(patternField('^a+$') as never, { f1: overCap })
    expect(out.valid).toBe(false)
    expect(out.errors).toEqual([{
      fieldId: 'f1', fieldName: 'F1', rule: 'pattern',
      message: `F1 exceeds the ${USER_REGEX_MAX_SUBJECT_LEN}-character limit for pattern checks`,
    }])
  })

  it('the refusal message wins over a custom rule message (the custom message describes a mismatch, not a refusal)', () => {
    const out = validateRecord(patternField('^a+$', 'letters a only') as never, { f1: overCap })
    expect(out.errors.map((e) => e.message)).toEqual([`F1 exceeds the ${USER_REGEX_MAX_SUBJECT_LEN}-character limit for pattern checks`])
  })

  it('a pattern one over the limit fails the rule with its own message', () => {
    const out = validateRecord(patternField('a'.repeat(USER_REGEX_MAX_PATTERN_LEN + 1)) as never, { f1: 'abc' })
    expect(out.errors.map((e) => e.message)).toEqual([`F1 has a pattern rule longer than the ${USER_REGEX_MAX_PATTERN_LEN}-character limit`])
  })

  it('an explicit maxLength rule below the limit still reports first, as before', () => {
    const fields = [{ id: 'f1', name: 'F1', type: 'string', config: { validation: [
      { type: 'maxLength' as const, params: { value: 5 } },
      { type: 'pattern' as const, params: { regex: '^a+$' } },
    ] } }]
    const out = validateRecord(fields as never, { f1: 'aaaaaa' })
    expect(out.errors.map((e) => e.rule)).toEqual(['maxLength'])
  })
})

// ---------------------------------------------------------------------------
// 5. Timing regression — its own describe, loose thresholds, one case per sink.
//
// The subject is the quadratic trim idiom `^\s+|\s+$` on 'Z' + N spaces + 'Z',
// N = 100000 (ten times the subject limit). Unguarded, every one of these
// sinks was measured at ~4.1 s on the census machine; guarded, each returns
// after a length comparison. The 500 ms threshold is therefore >1000x above
// the guarded path and >8x below the unguarded one on that machine; a slower
// host moves the unguarded number UP and leaves the guarded one where it is,
// so the gap only widens. The MUTATION that turns each case red is putting
// that one sink back on a bare `new RegExp(...)` call.
// ---------------------------------------------------------------------------

describe('timing regression — over-limit quadratic subject returns promptly at every sink', () => {
  const N = 100000
  const quadraticSubject = 'Z' + ' '.repeat(N) + 'Z'
  const TRIM = '^\\s+|\\s+$'
  const TAIL = '\\s+$'
  const THRESHOLD_MS = 500

  it('REGEXMATCH', () => {
    const r = ms(() => fn('REGEXMATCH')(quadraticSubject, TRIM))
    expect(r.out).toBe('#ERROR!')
    expect(r.ms).toBeLessThan(THRESHOLD_MS)
  })

  it('REGEXEXTRACT', () => {
    const r = ms(() => fn('REGEXEXTRACT')(quadraticSubject, TAIL))
    expect(r.out).toBe('#ERROR!')
    expect(r.ms).toBeLessThan(THRESHOLD_MS)
  })

  it('REGEXREPLACE', () => {
    const r = ms(() => fn('REGEXREPLACE')(quadraticSubject, TRIM, ''))
    expect(r.out).toBe('#ERROR!')
    expect(r.ms).toBeLessThan(THRESHOLD_MS)
  })

  it('SUBSTITUTE', () => {
    const r = ms(() => fn('SUBSTITUTE')(quadraticSubject, TAIL, ''))
    expect(r.out).toBe('#ERROR!')
    expect(r.ms).toBeLessThan(THRESHOLD_MS)
  })

  it('field-validation pattern rule', () => {
    const r = ms(() => validateRecord(patternField(TRIM) as never, { f1: quadraticSubject }))
    expect(r.out.valid).toBe(false)
    expect(r.out.errors[0]?.message).toContain('limit')
    expect(r.ms).toBeLessThan(THRESHOLD_MS)
  })

  it('AT the subject limit the same idiom runs to completion inside a loose budget (what the limit buys, not a guard)', () => {
    // Measured ~45 ms on the census machine for a subject of exactly the limit;
    // the budget below is ~40x that. This case does not turn red under the
    // sink mutation above — it documents the cost the limit still admits.
    const atCap = 'Z' + ' '.repeat(USER_REGEX_MAX_SUBJECT_LEN - 2) + 'Z'
    const r = ms(() => validateRecord(patternField(TRIM) as never, { f1: atCap }))
    expect(r.out).toEqual({ valid: false, errors: [{ fieldId: 'f1', fieldName: 'F1', rule: 'pattern', message: 'F1 does not match the required format' }] })
    expect(r.ms).toBeLessThan(2000)
  })
})
