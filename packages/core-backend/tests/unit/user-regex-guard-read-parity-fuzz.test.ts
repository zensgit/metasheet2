/**
 * PROPOSED (H-3, 2026-09-22, round 2) — differential fuzz: the guarded pattern
 * rule must return the SAME verdict as the unguarded one for every legitimate
 * (pattern, value) pair.
 *
 * This is the read-parity half of a narrowing fix (see the repo's
 * `narrowing fix = write-path reject + read-path byte parity` doctrine). The guard
 * is allowed to refuse NEW writes it can prove are dangerous; it is NOT allowed to
 * change the answer for any pattern rule and value that already exist in a
 * customer database. Round 1 failed exactly here — six common linear patterns
 * flipped from "valid" to "422 / #ERROR!" with no measurement behind the flip.
 *
 * REFERENCE IMPLEMENTATION: the body below is `validatePattern` as it stands on
 * `origin/main` (`new RegExp(regex, flags)` + `.test`, invalid regex => false).
 * It is inlined rather than imported because the point is to run the OLD code,
 * and the old code no longer exists in the tree.
 *
 * Seeded and reproducible. `H3_FUZZ_ITERATIONS` overrides the count; the number
 * actually run in the verification MD is 100000.
 */
import { describe, expect, it } from 'vitest'

import { runUserRegex, USER_REGEX_MAX_SUBJECT_LEN } from '../../src/formula/regex-safety'
import { validateRecord } from '../../src/multitable/field-validation-engine'

const ITERATIONS = Number(process.env.H3_FUZZ_ITERATIONS ?? 100_000)
const SEED = Number(process.env.H3_FUZZ_SEED ?? 0x5eed_1234)

/** mulberry32 — small, seeded, reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** origin/main's `validatePattern`, verbatim in behaviour. */
function unguardedValidatePattern(value: unknown, regex: string, flags?: string): boolean {
  if (typeof value !== 'string') return false
  try {
    const re = new RegExp(regex, flags)
    return re.test(value)
  } catch {
    return false
  }
}

function guardedValidatePattern(value: unknown, regex: string, flags?: string): boolean | 'refused' {
  if (typeof value !== 'string') return false
  const outcome = runUserRegex(regex, flags, value, (re, s) => re.test(s))
  if (outcome.status !== 'ok') return outcome.refusal.kind === 'invalid-pattern' ? false : 'refused'
  return outcome.value
}

/**
 * Atoms that cannot nest an unbounded quantifier inside a quantified group, so
 * every generated pattern is linear (or at worst mildly polynomial) by
 * construction. The corpus deliberately INCLUDES the shapes round 1 refused —
 * `(...)*` and `(...)+` over a character class — because those are the population
 * whose verdict must not move.
 */
const ATOMS = [
  'a', 'b', 'z', '0', '9', '-', '_', '\\.', '@', '/', ',', ':',
  '[a-z]', '[A-Z]', '[0-9]', '[a-z0-9]', '[^@]', '\\d', '\\w', '\\s',
  '[a-z]+', '[0-9]+', '\\d+', '\\w+', '[a-z]{1,4}', '\\d{2,4}',
  '(?:[a-z]+)', '([a-z]+)', '(\\.[a-z]+)', '(-[a-z0-9]+)', '(,[a-z]+)', '(/[a-z]+)',
]
const GROUP_QUANTIFIERS = ['', '', '', '*', '+', '?', '{0,3}']
const SUBJECT_ALPHABET = 'abz09-_.@/,: AZ\t'

function makePattern(r: () => number): string {
  const parts: string[] = []
  if (r() < 0.6) parts.push('^')
  const n = 1 + Math.floor(r() * 4)
  for (let i = 0; i < n; i++) {
    const atom = ATOMS[Math.floor(r() * ATOMS.length)]
    const quant = atom.startsWith('(') ? GROUP_QUANTIFIERS[Math.floor(r() * GROUP_QUANTIFIERS.length)] : ''
    parts.push(atom + quant)
  }
  if (r() < 0.6) parts.push('$')
  return parts.join('')
}

function makeSubject(r: () => number): string {
  const len = Math.floor(r() * 64)
  let out = ''
  for (let i = 0; i < len; i++) out += SUBJECT_ALPHABET[Math.floor(r() * SUBJECT_ALPHABET.length)]
  return out
}

const FLAG_CHOICES: Array<string | undefined> = [undefined, undefined, undefined, 'i', 'g', 'gi', 'u']

describe('differential fuzz — guarded vs unguarded pattern rule', () => {
  it('POSITIVE CONTROL: the harness can actually detect a difference', () => {
    // Over-ceiling subject: the two implementations MUST disagree. If this case
    // passed as "equal", the comparison below would be comparing nothing.
    const long = 'a'.repeat(USER_REGEX_MAX_SUBJECT_LEN + 1)
    expect(unguardedValidatePattern(long, '^[a-z]*$')).toBe(true)
    expect(guardedValidatePattern(long, '^[a-z]*$')).toBe('refused')
    // And a genuinely catastrophic pair: the unguarded side is not even called
    // here (it would take ~20s); the guarded side refuses.
    expect(guardedValidatePattern('a'.repeat(32) + '!', '^(a+)+$')).toBe('refused')
  })

  it('POSITIVE CONTROL: the generator produces a non-degenerate corpus', () => {
    const r = rng(SEED)
    const patterns = new Set<string>()
    const subjects = new Set<string>()
    let matches = 0
    let misses = 0
    for (let i = 0; i < 2000; i++) {
      const p = makePattern(r)
      const s = makeSubject(r)
      patterns.add(p)
      subjects.add(s)
      if (unguardedValidatePattern(s, p)) matches++
      else misses++
    }
    expect(patterns.size).toBeGreaterThan(1000)
    expect(subjects.size).toBeGreaterThan(1000)
    // Both verdicts must occur, or "equal verdicts" would be trivially true.
    expect(matches).toBeGreaterThan(50)
    expect(misses).toBeGreaterThan(50)
    // The corpus must contain the shape round 1 refused.
    expect([...patterns].some((p) => /\([^)]*\+\)[*+]/.test(p))).toBe(true)
  })

  it(`agrees with the unguarded implementation on ${ITERATIONS} random linear (pattern, value) pairs`, () => {
    const r = rng(SEED)
    let compared = 0
    let refusals = 0
    const divergences: Array<{ pattern: string; flags?: string; subject: string; old: boolean; now: boolean | 'refused' }> = []
    for (let i = 0; i < ITERATIONS; i++) {
      const pattern = makePattern(r)
      const flags = FLAG_CHOICES[Math.floor(r() * FLAG_CHOICES.length)]
      const subject = makeSubject(r)
      const before = unguardedValidatePattern(subject, pattern, flags)
      const after = guardedValidatePattern(subject, pattern, flags)
      compared++
      if (after === 'refused') {
        refusals++
        divergences.push({ pattern, flags, subject, old: before, now: after })
        continue
      }
      if (after !== before) divergences.push({ pattern, flags, subject, old: before, now: after })
      if (divergences.length > 5) break
    }
    expect(compared).toBeGreaterThanOrEqual(Math.min(ITERATIONS, 1000))
    expect({ refusals, divergences: divergences.slice(0, 5) }).toEqual({ refusals: 0, divergences: [] })
  })

  it('agrees through the real validateRecord wiring, error text included', () => {
    const r = rng(SEED ^ 0x1234)
    const iterations = Math.min(ITERATIONS, 5000)
    for (let i = 0; i < iterations; i++) {
      const pattern = makePattern(r)
      const subject = makeSubject(r)
      const before = unguardedValidatePattern(subject, pattern)
      const out = validateRecord(
        [{ id: 'f1', name: 'F1', type: 'string', config: { validation: [{ type: 'pattern', params: { regex: pattern } }] } }],
        { f1: subject },
      )
      // `validateFieldValue` skips every rule for an empty value when there is no
      // `required` rule, so an empty/blank subject is vacuously valid on both sides.
      if (subject.trim() === '') {
        expect(out.valid, `empty subject with ${pattern}`).toBe(true)
        continue
      }
      expect(out.valid, `${pattern} / ${JSON.stringify(subject)}`).toBe(before)
      if (!before) {
        expect(out.errors[0].message, `${pattern} / ${JSON.stringify(subject)}`).toBe('F1 does not match the required format')
      }
    }
  })
})
