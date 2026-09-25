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
import { validateFormField } from '../../../../apps/web/src/views/formViewValidation'
import type { FormField } from '../../../../apps/web/src/types/views'

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

const formField = (pattern: string, extra: Partial<FormField> = {}): FormField => ({
  id: 'f1', name: 'f1', label: 'F1', type: 'text', required: false, order: 0, validation: { pattern }, ...extra,
})

describe('user-regex length limits — every copy measures the caller\'s own string, not RegExp#source', () => {
  // `RegExp.prototype.source` re-escapes `/` (and line breaks), so it is never
  // shorter than the string it was compiled from. A copy that measured `source`
  // would refuse, at the limit, a pattern the other two accept — the exact
  // disagreement this file exists to catch, and one the numeric table above
  // cannot see. The fixture is one string, replayed through all three copies
  // and through the form's own caller.
  // MUTATION: plugin gate back on `regexp.source.length` -> the at-limit row is
  // refused there (reported length > P) while backend / web accept it.
  const SLASHY_AT_LIMIT = 'abc|' + '/'.repeat(P - 4) // P characters; matches 'abc'
  const SLASHY_ONE_OVER = 'abc|' + '/'.repeat(P - 3) // P + 1 characters

  it('sanity: the fixture is AT the limit as a string and longer as RegExp source', () => {
    expect(SLASHY_AT_LIMIT.length).toBe(P)
    expect(new RegExp(SLASHY_AT_LIMIT).source.length).toBeGreaterThan(P)
    expect(SLASHY_ONE_OVER.length).toBe(P + 1)
  })

  it('AT the limit, all three copies evaluate the pattern (and it matches)', () => {
    expect(backend.runUserRegex(SLASHY_AT_LIMIT, undefined, 'abc', (re, s) => re.test(s))).toEqual({ status: 'ok', value: true })
    expect(web.findUserRegexLengthRefusal(SLASHY_AT_LIMIT.length, 'abc'.length)).toBeNull()
    expect(validateFormField(formField(SLASHY_AT_LIMIT), 'abc')).toBeNull()
    expect(plugin.validateValue('abc', [{ type: 'pattern', params: { regex: SLASHY_AT_LIMIT } }], 'f')).toEqual([])
  })

  it('one over, all three copies refuse it for its length and report the STRING length', () => {
    const expected = { kind: 'pattern-too-long', length: P + 1, limit: P }
    expect(backend.runUserRegex(SLASHY_ONE_OVER, undefined, 'abc', (re, s) => re.test(s))).toEqual({ status: 'refused', refusal: expected })
    expect(web.findUserRegexLengthRefusal(SLASHY_ONE_OVER.length, 'abc'.length)).toEqual(expected)
    expect(validateFormField(formField(SLASHY_ONE_OVER), 'abc')).toBe('F1 的格式规则过长，无法校验')
    const out = plugin.validateValue('abc', [{ type: 'pattern', params: { regex: SLASHY_ONE_OVER } }], 'f')
    expect(out.map((e) => e.code)).toEqual(['PATTERN_NOT_EVALUATED'])
    expect(out[0].details).toMatchObject({ reason: 'pattern-too-long', length: P + 1, limit: P })
  })

  it('the plugin falls back to RegExp#source only when the rule carries a RegExp instance (no string to measure)', () => {
    const instance = new RegExp(SLASHY_AT_LIMIT) // source is longer than P
    const out = plugin.validateValue('abc', [{ type: 'pattern', params: { regex: instance } }], 'f')
    expect(out.map((e) => e.code)).toEqual(['PATTERN_NOT_EVALUATED'])
    expect(out[0].details).toMatchObject({ reason: 'pattern-too-long', length: instance.source.length, limit: P })
    expect(plugin.validateValue('abc', [{ type: 'pattern', params: { regex: /^abc$/ } }], 'f')).toEqual([])
  })
})

describe('user-regex length limits — the public form\'s own caller (validateFormField, which FormView.vue delegates to)', () => {
  // The gate call itself is pinned here in the backend lane; `FormView.vue`'s
  // one-line delegation to `validateFormField` is covered by vue-tsc only.
  // MUTATION: `findUserRegexLengthRefusal(...)` replaced by `null` in
  // formViewValidation.ts -> both rows below red (the pattern runs and answers).
  it('a value AT the subject limit gets the pattern answer; one over is refused with the length message', () => {
    expect(validateFormField(formField('^a+$'), 'a'.repeat(S))).toBeNull()
    expect(validateFormField(formField('^b+$'), 'a'.repeat(S))).toBe('F1 格式不正确')
    expect(validateFormField(formField('^a+$'), 'a'.repeat(S + 1))).toBe(`F1 不能超过 ${S} 个字符`)
  })

  it('a pattern one over the limit is refused with the rule-too-long message, before the subject limit', () => {
    expect(validateFormField(formField('a'.repeat(P + 1)), 'abc')).toBe('F1 的格式规则过长，无法校验')
    expect(validateFormField(formField('a'.repeat(P + 1)), 'a'.repeat(S + 1))).toBe('F1 的格式规则过长，无法校验')
  })
})
