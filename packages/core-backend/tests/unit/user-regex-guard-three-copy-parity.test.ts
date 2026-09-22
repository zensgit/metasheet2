/**
 * PROPOSED (H-3, 2026-09-22, round 2) — three-way behavioural pin for the
 * user-supplied-regex guard.
 *
 * The guard exists in three copies because there is no import edge between the
 * three roots: `packages/core-backend/src/formula/regex-safety.ts` (server),
 * `apps/web/src/utils/userRegexGuard.ts` (browser; `apps/web` has no dependency
 * on the backend package — same constraint that forced the `permission-match`
 * mirror), and `plugins/plugin-integration-core/lib/user-regex-guard.cjs`
 * (plugin CJS, loaded at runtime by PluginLoader).
 *
 * Round 1's defect was a guard that disagreed with reality. A guard that
 * disagrees with ITSELF is the same defect one level up: the public form would
 * say "ok" and the write would 422, or the pipeline would accept a value the
 * record write refuses. So this pin is BEHAVIOURAL, not textual — it imports /
 * requires all three real modules and replays ONE shared case table through them,
 * asserting the same accept/refuse verdict and the same refusal kind. A
 * source-text diff would go green against a copy that had been edited into
 * agreement-by-comment.
 *
 * It lives in the backend lane on purpose: `apps/web`'s own spec lane is not a
 * required check, and the plugin's CJS chain does not see the other two roots.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as backend from '../../src/formula/regex-safety'
import * as web from '../../../../apps/web/src/utils/userRegexGuard'

const require_ = createRequire(__filename)
const plugin = require_('../../../../plugins/plugin-integration-core/lib/user-regex-guard.cjs') as typeof backend

const COPIES: Array<[string, typeof backend]> = [
  ['backend (packages/core-backend/src/formula/regex-safety.ts)', backend],
  ['web (apps/web/src/utils/userRegexGuard.ts)', web as unknown as typeof backend],
  ['plugin (plugins/plugin-integration-core/lib/user-regex-guard.cjs)', plugin],
]

const CONSTANTS = [
  'USER_REGEX_MAX_SUBJECT_LEN',
  'USER_REGEX_MAX_PATTERN_LEN',
  'USER_REGEX_PROBE_FLOOR_MS',
  'USER_REGEX_PROBE_BUDGET_MS',
  'USER_REGEX_SUPERLINEAR_SLOPE',
  'USER_REGEX_DECISION_DYNAMIC_RANGE',
  'USER_REGEX_REMEASURE_BUDGET_MS',
] as const

const CEILING = backend.USER_REGEX_MAX_SUBJECT_LEN

/**
 * ONE table, replayed through every copy. `refusalKind: null` means "must run the
 * real regex and return its real answer"; `matched` is then also pinned, so a copy
 * cannot pass by refusing everything or by accepting everything.
 */
const CASES: Array<{
  name: string
  pattern: string
  flags?: string
  subject: string
  refusalKind: string | null
  matched?: boolean
}> = [
  // --- the six linear patterns the round-1 static detector refused ---
  { name: 'version number, matching', pattern: '^\\d+(\\.\\d+)*$', subject: '1.2.3', refusalKind: null, matched: true },
  { name: 'version number, not matching', pattern: '^\\d+(\\.\\d+)*$', subject: '1.2.x', refusalKind: null, matched: false },
  { name: 'slug, matching', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', subject: 'my-valid-slug', refusalKind: null, matched: true },
  { name: 'slug, adversarial at ceiling', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', subject: ('abc-'.repeat(2600)).slice(0, CEILING - 1) + '!', refusalKind: null, matched: false },
  { name: 'dotted identifier, matching', pattern: '^(\\w+\\.)*\\w+$', subject: 'com.example.app', refusalKind: null, matched: true },
  { name: 'comma list, matching', pattern: '^[a-z]+(,[a-z]+)*$', subject: 'aa,bb,cc', refusalKind: null, matched: true },
  { name: 'e-mail, matching', pattern: '^[^@]+@[^@]+(\\.[^@]+)+$', subject: 'a@b.co', refusalKind: null, matched: true },
  { name: 'path segments, matching', pattern: '^(/[a-z0-9_-]+)+$', subject: '/usr/local/bin', refusalKind: null, matched: true },
  // --- ordinary shapes ---
  { name: 'anchored class', pattern: '^[a-z]+$', subject: 'abc', refusalKind: null, matched: true },
  { name: 'quadratic trim idiom inside the ceiling', pattern: '^\\s+|\\s+$', flags: 'g', subject: 'Z' + ' '.repeat(2000) + 'Z', refusalKind: null, matched: false },
  // --- refusals ---
  { name: 'nested unbounded quantifier', pattern: '^(a+)+$', subject: 'a'.repeat(32) + '!', refusalKind: 'superlinear' },
  { name: 'alternation overlap', pattern: '^(a|a)*$', subject: 'a'.repeat(32) + '!', refusalKind: 'superlinear' },
  { name: 'class alternation overlap', pattern: '^([a-z]|[a-z])*$', subject: 'a'.repeat(32) + '!', refusalKind: 'superlinear' },
  { name: 'over-ceiling subject', pattern: '^[a-z]*$', subject: 'a'.repeat(CEILING + 1), refusalKind: 'subject-too-long' },
  { name: 'over-length pattern', pattern: 'x'.repeat(backend.USER_REGEX_MAX_PATTERN_LEN + 1), subject: 'x', refusalKind: 'pattern-too-long' },
  { name: 'invalid pattern', pattern: '(', subject: 'x', refusalKind: 'invalid-pattern' },
]

describe('user-regex guard — three copies, one case table', () => {
  it('the table is non-trivial in BOTH directions (a table of only-accepts or only-refuses proves nothing)', () => {
    expect(CASES.filter((c) => c.refusalKind === null).length).toBeGreaterThanOrEqual(8)
    expect(CASES.filter((c) => c.refusalKind !== null).length).toBeGreaterThanOrEqual(5)
    expect(CASES.some((c) => c.matched === true)).toBe(true)
    expect(CASES.some((c) => c.matched === false)).toBe(true)
    expect(new Set(CASES.filter((c) => c.refusalKind).map((c) => c.refusalKind)).size).toBeGreaterThanOrEqual(3)
  })

  it('all three copies really loaded (a missing module must fail loud, not silently skip)', () => {
    for (const [name, copy] of COPIES) {
      expect(typeof copy.runUserRegex, name).toBe('function')
      expect(typeof copy.userRegexProbeLadder, name).toBe('function')
    }
    expect(COPIES).toHaveLength(3)
  })

  it.each(CONSTANTS)('%s is identical in all three copies', (key) => {
    const values = COPIES.map(([, copy]) => copy[key])
    expect(values[1]).toBe(values[0])
    expect(values[2]).toBe(values[0])
    expect(typeof values[0]).toBe('number')
  })

  it('the fit anchor rule is identical in all three copies', () => {
    const cases: Array<[number[], number]> = [
      [[0.001, 0.05, 0.4, 1.3], 2.7],
      [[1.0, 1.4, 1.9], 2.2],
      [[], 99],
      [[0.25], 2.0],
    ]
    for (const [sampled, ms] of cases) {
      const picks = COPIES.map(([, copy]) => copy.selectFitAnchor(sampled, ms))
      expect(picks[1], `web for ${JSON.stringify(sampled)}`).toBe(picks[0])
      expect(picks[2], `plugin for ${JSON.stringify(sampled)}`).toBe(picks[0])
    }
    // Non-degenerate: the rule must actually discriminate, not return -1 for everything.
    expect(backend.selectFitAnchor([0.001, 0.05, 0.4, 1.3], 2.7)).toBeGreaterThanOrEqual(0)
    expect(backend.selectFitAnchor([1.0, 1.4, 1.9], 2.2)).toBe(-1)
  })

  it('the probe ladder is identical in all three copies', () => {
    for (const n of [0, 3, 33, 200, CEILING]) {
      const ladders = COPIES.map(([, copy]) => copy.userRegexProbeLadder(n))
      expect(ladders[1]).toEqual(ladders[0])
      expect(ladders[2]).toEqual(ladders[0])
    }
  })

  it.each(CASES.map((c) => [c.name, c] as const))('%s — same verdict in all three copies', (_name, c) => {
    for (const [name, copy] of COPIES) {
      const outcome = copy.runUserRegex(c.pattern, c.flags, c.subject, (re, s) => {
        re.lastIndex = 0
        return re.test(s)
      })
      if (c.refusalKind === null) {
        expect(outcome.status, `${name}: expected to run`).toBe('ok')
        if (outcome.status !== 'ok') throw new Error('unreachable')
        expect(outcome.value, `${name}: match verdict`).toBe(c.matched)
      } else {
        expect(outcome.status, `${name}: expected refusal`).toBe('refused')
        if (outcome.status === 'ok') throw new Error('unreachable')
        expect(outcome.refusal.kind, `${name}: refusal kind`).toBe(c.refusalKind)
      }
    }
  })

  it('refusal wording is identical in all three copies (the FE message the user reads is the backend one)', () => {
    const refusals = [
      { kind: 'pattern-too-long' as const, limit: backend.USER_REGEX_MAX_PATTERN_LEN, length: 9999 },
      { kind: 'subject-too-long' as const, limit: CEILING, length: 99999 },
      { kind: 'invalid-pattern' as const },
      { kind: 'superlinear' as const, slope: 9, predictedMs: 9999, measuredMs: 9, atLength: 9, subjectLength: 99 },
    ]
    for (const refusal of refusals) {
      const texts = COPIES.map(([, copy]) => copy.describeUserRegexRefusal(refusal))
      expect(texts[1]).toBe(texts[0])
      expect(texts[2]).toBe(texts[0])
      expect(texts[0].length).toBeGreaterThan(10)
      // Never echo the pattern or the value back to the caller.
      expect(texts[0]).not.toContain('(')
    }
  })
})

/**
 * The three COPIES being in agreement says nothing about whether the three CALL
 * SITES actually use them. These two blocks close that gap for the two sites the
 * backend lane can reach.
 */
describe('call sites — the guard has to be wired in, not merely present', () => {
  const validator = require_('../../../../plugins/plugin-integration-core/lib/validator.cjs') as {
    validateValue(value: unknown, rules: unknown, field?: string): Array<{ code: string; details?: Record<string, unknown> }>
  }

  it('plugin validator: a legitimate slug pattern still passes (round 1 would have refused it)', () => {
    const errors = validator.validateValue('my-valid-slug', [{ type: 'pattern', params: { regex: '^[a-z0-9]+(-[a-z0-9]+)*$' } }], 'f1')
    expect(errors).toEqual([])
  })

  it('plugin validator: an ordinary mismatch still reports PATTERN', () => {
    const errors = validator.validateValue('NOT A SLUG', [{ type: 'pattern', params: { regex: '^[a-z0-9]+(-[a-z0-9]+)*$' } }], 'f1')
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('PATTERN')
  })

  it('plugin validator: a catastrophic pattern is refused fast, under its OWN code', () => {
    const t0 = process.hrtime.bigint()
    const errors = validator.validateValue('a'.repeat(32) + '!', [{ type: 'pattern', params: { regex: '^(a+)+$' } }], 'f1')
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    expect(errors).toHaveLength(1)
    // Unguarded, this site was measured at 19.7s on a 33-character value.
    expect(ms).toBeLessThan(2000)
    expect(errors[0].code).toBe('PATTERN_NOT_EVALUATED')
    expect(errors[0].code).not.toBe('PATTERN')
  })

  it('plugin validator: an over-ceiling value is refused under the same code', () => {
    const errors = validator.validateValue('a'.repeat(CEILING + 1), [{ type: 'pattern', params: { regex: '^[a-z]*$' } }], 'f1')
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('PATTERN_NOT_EVALUATED')
  })

  /**
   * TEXT-LEVEL ONLY, and labelled as such. `apps/web`'s own spec lane is not a
   * required check and FormView is a full SFC, so this lane cannot execute the
   * browser call site. What it CAN do is fail when the call site is reverted to a
   * bare `new RegExp(validation.pattern)` — which is the exact regression this
   * pins. The sanity assertions exist so a moved/renamed file fails LOUD instead
   * of scraping zero matches and going quietly green.
   */
  it('FormView.vue routes its pattern check through the mirrored guard', () => {
    const formView = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/web/src/views/FormView.vue')
    const src = readFileSync(formView, 'utf8')
    expect(src.length).toBeGreaterThan(5000)
    expect(src).toContain('function validateField')      // anchor: the file is the one we think it is
    expect(src).toContain("from '../utils/userRegexGuard'")
    expect(src).toContain('runUserRegex(validation.pattern')
    expect(src).not.toContain('new RegExp(validation.pattern)')
  })
})
