/**
 * Three-way pin for the LENGTH GATE on caller-supplied regular expressions.
 *
 * The gate exists in three copies because there is no import edge between the
 * roots: `packages/core-backend/src/formula/regex-safety.ts` (server),
 * `apps/web/src/utils/userRegexLimits.ts` (public form, browser) and
 * `plugins/plugin-integration-core/lib/validator.cjs` (pipeline validator,
 * loaded at runtime). A gate that disagrees with itself is a defect one level
 * up — the form would say "ok" and the write would refuse, or the pipeline would
 * accept a value the record write refuses — so this pin is BEHAVIOURAL: it
 * loads all three real modules and replays ONE table through each of them. A
 * source-text diff would go green against a copy edited into agreement by
 * comment; this does not.
 *
 * It lives in the backend lane on purpose: `apps/web`'s own spec lane is not a
 * required check, and the plugin's CJS chain does not see the other two roots.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import * as backend from '../../src/formula/regex-safety'
import * as web from '../../../../apps/web/src/utils/userRegexLimits'

type Copy = {
  USER_REGEX_MAX_SUBJECT_LEN: number
  USER_REGEX_MAX_PATTERN_LEN: number
  findUserRegexLengthRefusal: (patternLength: number, subjectLength: number) => { kind: string; length: number; limit: number } | null
}

const require_ = createRequire(__filename)
const plugin = require_('../../../../plugins/plugin-integration-core/lib/validator.cjs') as Copy & {
  validateValue: (value: unknown, rules: unknown, field?: string) => Array<{ code: string; details: Record<string, unknown> }>
}

const COPIES: Array<[string, Copy]> = [
  ['backend (packages/core-backend/src/formula/regex-safety.ts)', backend],
  ['web (apps/web/src/utils/userRegexLimits.ts)', web],
  ['plugin (plugins/plugin-integration-core/lib/validator.cjs)', plugin],
]

const P = backend.USER_REGEX_MAX_PATTERN_LEN
const S = backend.USER_REGEX_MAX_SUBJECT_LEN

/** ONE table, replayed through every copy. */
const TABLE: Array<{ name: string; patternLength: number; subjectLength: number; expected: null | { kind: string; length: number; limit: number } }> = [
  { name: 'both zero', patternLength: 0, subjectLength: 0, expected: null },
  { name: 'both at the limit', patternLength: P, subjectLength: S, expected: null },
  { name: 'pattern one over', patternLength: P + 1, subjectLength: 0, expected: { kind: 'pattern-too-long', length: P + 1, limit: P } },
  { name: 'subject one over', patternLength: 0, subjectLength: S + 1, expected: { kind: 'subject-too-long', length: S + 1, limit: S } },
  { name: 'both over: pattern first', patternLength: P + 1, subjectLength: S + 1, expected: { kind: 'pattern-too-long', length: P + 1, limit: P } },
  { name: 'far over', patternLength: 1_000_000, subjectLength: 1_000_000, expected: { kind: 'pattern-too-long', length: 1_000_000, limit: P } },
]

describe('user-regex length limits — three copies agree', () => {
  it.each(COPIES)('%s carries the documented limits', (_name, copy) => {
    expect(copy.USER_REGEX_MAX_SUBJECT_LEN).toBe(10000)
    expect(copy.USER_REGEX_MAX_PATTERN_LEN).toBe(4000)
  })

  for (const [name, copy] of COPIES) {
    describe(name, () => {
      it.each(TABLE)('$name', ({ patternLength, subjectLength, expected }) => {
        expect(copy.findUserRegexLengthRefusal(patternLength, subjectLength)).toEqual(expected)
      })
    })
  }

  it('the plugin validator reports a length refusal under its own code, not as PATTERN', () => {
    const rule = [{ type: 'pattern', params: { regex: '^a+$' } }]
    expect(plugin.validateValue('a'.repeat(S), rule, 'f')).toEqual([])
    const over = plugin.validateValue('a'.repeat(S + 1), rule, 'f')
    expect(over.map((e) => e.code)).toEqual(['PATTERN_NOT_EVALUATED'])
    expect(over[0].details).toMatchObject({ reason: 'subject-too-long', length: S + 1, limit: S })
    const longPattern = plugin.validateValue('abc', [{ type: 'pattern', params: { regex: 'a'.repeat(P + 1) } }], 'f')
    expect(longPattern.map((e) => e.code)).toEqual(['PATTERN_NOT_EVALUATED'])
    expect(longPattern[0].details).toMatchObject({ reason: 'pattern-too-long', length: P + 1, limit: P })
  })
})
