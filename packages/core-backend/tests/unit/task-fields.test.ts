import { describe, expect, it } from 'vitest'
import {
  TASK_FIELD_LIMITS,
  TASK_FIELD_TYPES,
  applyBindField,
  applySetFieldValue,
  applyUnbindField,
  canBindField,
  canManageFieldDefinition,
  canWriteFieldValue,
  checkFieldDefinitionQuota,
  listReusableTaskFieldIds,
  parseFieldDefinition,
  planDeleteFieldDefinition,
  resolveVisibleTaskFieldValues,
  validateFieldValue,
  type TaskFieldDefinition,
  type TaskFieldOptionRandom,
} from '../../src/tasks/task-fields'

const NOW = new Date('2026-10-07T08:00:00.000Z')

/** Deterministic option-id source: R1, R2, … */
function sequence(): TaskFieldOptionRandom {
  let n = 0
  return () => `R${++n}`
}

function def(type: TaskFieldDefinition['type'], config: TaskFieldDefinition['config'] = {}): TaskFieldDefinition {
  return { id: 'tfld_1', type, name: 'F', config }
}

const SELECT = def('select', { options: [{ id: 'opt_a', label: 'High' }, { id: 'opt_b', label: 'Low' }] })
const MULTI = def('multiSelect', { options: [{ id: 'opt_a', label: 'Red' }, { id: 'opt_b', label: 'Blue' }] })
const MEMBER = def('member', { single: false })
const CANDIDATES = new Set(['u1', 'u2', 'u3'])

describe('task-fields', () => {
  describe('constants', () => {
    it('six types (RULED(2026-10-09): [S25])', () => {
      expect(TASK_FIELD_TYPES).toEqual(['text', 'number', 'select', 'multiSelect', 'member', 'date'])
    })
    it('limits (RULED(2026-10-09): [S28]; ASSUMPTION(task-e): [D18][D10] + own-choice name ceiling and member-id ceiling)', () => {
      expect(TASK_FIELD_LIMITS).toEqual({
        maxDefinitionsPerOrg: 200,
        maxBindingsPerList: 50,
        maxOptionsPerField: 100,
        maxOptionLabelCodePoints: 100,
        maxNameCodePoints: 100,
        maxTextValueCodePoints: 2000,
        maxMemberValues: 50,
        maxMemberIdChars: 50,
        maxNumberMagnitudeExclusive: 1e15,
        maxDecimals: 6,
      })
    })
  })

  describe('parseFieldDefinition', () => {
    const parse = (type: unknown, config: unknown, extra: Record<string, unknown> = {}) =>
      parseFieldDefinition({ type, name: 'Priority', config, random: sequence(), ...extra })

    it('refuses types outside the closed set', () => {
      for (const type of ['url', 'checkbox', 'dateTime', 'person', 'formula', 7]) {
        expect(parse(type, {}), String(type)).toEqual({ ok: false, reason: 'invalid_type' })
      }
    })
    it('name: normalized, ≤ 100 code points, hygiene-checked', () => {
      expect(parseFieldDefinition({ type: 'date', name: '  Due on ', config: {} })).toEqual({ ok: true, type: 'date', name: 'Due on', config: {} })
      expect(parseFieldDefinition({ type: 'date', name: '   ', config: {} })).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseFieldDefinition({ type: 'date', name: 'a'.repeat(100), config: {} }).ok).toBe(true)
      expect(parseFieldDefinition({ type: 'date', name: 'a'.repeat(101), config: {} })).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseFieldDefinition({ type: 'date', name: 'a'.repeat(99) + '\u{1F600}', config: {} }).ok).toBe(true)
      expect(parseFieldDefinition({ type: 'date', name: 'bad\u0007name', config: {} })).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseFieldDefinition({ type: 'date', name: 'lost\uFFFDbytes', config: {} })).toEqual({ ok: false, reason: 'invalid_name' })
      expect(parseFieldDefinition({ type: 'date', name: 42, config: {} })).toEqual({ ok: false, reason: 'invalid_name' })
    })
    it('config must be an object (absent ⇒ defaults)', () => {
      expect(parse('number', undefined)).toEqual({ ok: true, type: 'number', name: 'Priority', config: { decimals: 0, format: 'plain' } })
      expect(parse('number', null)).toEqual({ ok: false, reason: 'invalid_config' })
      expect(parse('number', [])).toEqual({ ok: false, reason: 'invalid_config' })
    })
    it('text: optional maxLength 1..2000, no other key', () => {
      expect(parse('text', {})).toEqual({ ok: true, type: 'text', name: 'Priority', config: {} })
      expect(parse('text', { maxLength: 2000 })).toEqual({ ok: true, type: 'text', name: 'Priority', config: { maxLength: 2000 } })
      for (const maxLength of [0, 2001, 1.5, '5']) {
        expect(parse('text', { maxLength }), String(maxLength)).toEqual({ ok: false, reason: 'invalid_config' })
      }
      expect(parse('text', { rich: true })).toEqual({ ok: false, reason: 'invalid_config' })
    })
    it('number: decimals 0..6 and plain|percent (defaults 0 / plain)', () => {
      expect(parse('number', { decimals: 6, format: 'percent' })).toEqual({ ok: true, type: 'number', name: 'Priority', config: { decimals: 6, format: 'percent' } })
      expect(parse('number', { decimals: 7 })).toEqual({ ok: false, reason: 'invalid_config' })
      expect(parse('number', { decimals: -1 })).toEqual({ ok: false, reason: 'invalid_config' })
      expect(parse('number', { format: 'currency' })).toEqual({ ok: false, reason: 'invalid_config' })
      expect(parse('number', { unit: 'kg' })).toEqual({ ok: false, reason: 'invalid_config' })
    })
    it('member: single defaults to false; must be a boolean', () => {
      expect(parse('member', {})).toEqual({ ok: true, type: 'member', name: 'Priority', config: { single: false } })
      expect(parse('member', { single: true })).toEqual({ ok: true, type: 'member', name: 'Priority', config: { single: true } })
      expect(parse('member', { single: 'yes' })).toEqual({ ok: false, reason: 'invalid_config' })
      expect(parse('member', { limitSingleRecord: true })).toEqual({ ok: false, reason: 'invalid_config' })
    })
    it('date: no config key at all', () => {
      expect(parse('date', {})).toEqual({ ok: true, type: 'date', name: 'Priority', config: {} })
      expect(parse('date', { format: 'YYYY/MM/DD' })).toEqual({ ok: false, reason: 'invalid_config' })
    })
    describe('select / multiSelect options', () => {
      it('creates server-made ids, normalizes labels, expands colours', () => {
        expect(parse('select', { options: [{ label: '  High ', color: '#ABC' }, { label: 'Low', color: '#00FF7f' }, { label: 'Mid' }] })).toEqual({
          ok: true,
          type: 'select',
          name: 'Priority',
          config: {
            options: [
              { id: 'opt_R1', label: 'High', color: '#aabbcc' },
              { id: 'opt_R2', label: 'Low', color: '#00ff7f' },
              { id: 'opt_R3', label: 'Mid' },
            ],
          },
        })
      })
      it('labels are unique case-insensitively', () => {
        expect(parse('multiSelect', { options: [{ label: 'High' }, { label: 'high' }] })).toEqual({ ok: false, reason: 'invalid_config' })
      })
      it('refuses blank, over-long and malformed entries', () => {
        expect(parse('select', { options: [{ label: '  ' }] })).toEqual({ ok: false, reason: 'invalid_config' })
        expect(parse('select', { options: [{ label: 'a'.repeat(100) }] }).ok).toBe(true)
        expect(parse('select', { options: [{ label: 'a'.repeat(101) }] })).toEqual({ ok: false, reason: 'invalid_config' })
        expect(parse('select', { options: [{ label: 'A', value: 'A' }] })).toEqual({ ok: false, reason: 'invalid_config' })
        expect(parse('select', { options: [{ label: 'A', color: 'red' }] })).toEqual({ ok: false, reason: 'invalid_config' })
        expect(parse('select', { options: [{ label: 'A', color: '#12345' }] })).toEqual({ ok: false, reason: 'invalid_config' })
        expect(parse('select', { options: 'A,B' })).toEqual({ ok: false, reason: 'invalid_config' })
        expect(parse('select', {})).toEqual({ ok: false, reason: 'invalid_config' })
        expect(parse('select', { options: [], sort: 'asc' })).toEqual({ ok: false, reason: 'invalid_config' })
      })
      it('at most 100 options', () => {
        const options = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `L${i}` }))
        expect(parse('select', { options: options(100) }).ok).toBe(true)
        expect(parse('select', { options: options(101) })).toEqual({ ok: false, reason: 'limit' })
      })
      it('a create cannot name an id of its own', () => {
        expect(parse('select', { options: [{ id: 'opt_mine', label: 'A' }] })).toEqual({ ok: false, reason: 'invalid_config' })
      })
      it('an update keeps existing ids (rename), mints ids for new entries, may drop options', () => {
        const previous = { type: 'select' as const, config: { options: [{ id: 'opt_a', label: 'High' }, { id: 'opt_b', label: 'Low' }] } }
        expect(parse('select', { options: [{ id: 'opt_a', label: 'Urgent' }, { label: 'Later' }] }, { previous })).toEqual({
          ok: true,
          type: 'select',
          name: 'Priority',
          config: { options: [{ id: 'opt_a', label: 'Urgent' }, { id: 'opt_R1', label: 'Later' }] },
        })
      })
      it('an update refuses unknown ids and a repeated id', () => {
        const previous = { type: 'select' as const, config: { options: [{ id: 'opt_a', label: 'High' }] } }
        expect(parse('select', { options: [{ id: 'opt_zzz', label: 'X' }] }, { previous })).toEqual({ ok: false, reason: 'invalid_config' })
        expect(parse('select', { options: [{ id: 'opt_a', label: 'X' }, { id: 'opt_a', label: 'Y' }] }, { previous })).toEqual({
          ok: false,
          reason: 'invalid_config',
        })
      })
      it('the random source is required for new options and must behave', () => {
        expect(() => parseFieldDefinition({ type: 'select', name: 'P', config: { options: [{ label: 'A' }] } })).toThrow(TypeError)
        expect(() => parseFieldDefinition({ type: 'select', name: 'P', config: { options: [{ label: 'A' }] }, random: () => 'not ok' })).toThrow(TypeError)
        expect(() =>
          parseFieldDefinition({ type: 'select', name: 'P', config: { options: [{ label: 'A' }, { label: 'B' }] }, random: () => 'same' }),
        ).toThrow(TypeError)
      })
    })
    it('the type of an existing definition cannot change (own choice)', () => {
      expect(parse('text', {}, { previous: { type: 'number', config: { decimals: 0, format: 'plain' } } })).toEqual({ ok: false, reason: 'invalid_type' })
    })
    it('rejects a malformed call with TypeError', () => {
      expect(() => parseFieldDefinition('x' as never)).toThrow(TypeError)
      expect(() => parse('text', {}, { previous: { type: 'nope', config: {} } })).toThrow(TypeError)
    })
  })

  describe('validateFieldValue', () => {
    it('null and the empty string clear the value for every type (own choice)', () => {
      for (const field of [def('text'), def('number', { decimals: 0, format: 'plain' }), SELECT, MULTI, MEMBER, def('date')]) {
        expect(validateFieldValue(field, null, { memberCandidates: CANDIDATES }), field.type).toEqual({ ok: true, value: null })
        expect(validateFieldValue(field, '', { memberCandidates: CANDIDATES }), field.type).toEqual({ ok: true, value: null })
      }
    })
    describe('text', () => {
      it('normalizes and counts code points', () => {
        expect(validateFieldValue(def('text'), '  hello ')).toEqual({ ok: true, value: 'hello' })
        expect(validateFieldValue(def('text'), '   ')).toEqual({ ok: true, value: null })
        expect(validateFieldValue(def('text'), 'a'.repeat(2000))).toEqual({ ok: true, value: 'a'.repeat(2000) })
        expect(validateFieldValue(def('text'), '\u{1F600}'.repeat(2000))).toEqual({ ok: true, value: '\u{1F600}'.repeat(2000) })
        expect(validateFieldValue(def('text', { maxLength: 5 }), 'abcd\u{1F600}')).toEqual({ ok: true, value: 'abcd\u{1F600}' })
        expect(validateFieldValue(def('text'), 42)).toEqual({ ok: false, reason: 'invalid_value' })
      })
      // ASSUMPTION(task-e): [D18] over the 2000-code-point ceiling is `limit`; over the field's own
      // maxLength (and within 2000) is `too_long`.
      it('over 2000 code points is limit (D18), whatever maxLength says', () => {
        expect(validateFieldValue(def('text'), 'a'.repeat(2001))).toEqual({ ok: false, reason: 'limit' })
        expect(validateFieldValue(def('text', { maxLength: 5 }), 'a'.repeat(2001))).toEqual({ ok: false, reason: 'limit' })
        // A stored maxLength above the ceiling (parseFieldDefinition never produces one) does not lift it.
        expect(validateFieldValue(def('text', { maxLength: 5000 }), 'a'.repeat(2001))).toEqual({ ok: false, reason: 'limit' })
        expect(validateFieldValue(def('text', { maxLength: 5000 }), 'a'.repeat(2000))).toEqual({ ok: true, value: 'a'.repeat(2000) })
        expect(validateFieldValue(def('text'), '\u{1F600}'.repeat(2001))).toEqual({ ok: false, reason: 'limit' })
      })
      it('over the field maxLength (within 2000) is too_long', () => {
        expect(validateFieldValue(def('text', { maxLength: 5 }), 'abcdef')).toEqual({ ok: false, reason: 'too_long' })
        expect(validateFieldValue(def('text', { maxLength: 5 }), 'abcde')).toEqual({ ok: true, value: 'abcde' })
        expect(validateFieldValue(def('text', { maxLength: 2000 }), 'a'.repeat(2000))).toEqual({ ok: true, value: 'a'.repeat(2000) })
      })
    })
    describe('number', () => {
      const NUM = def('number', { decimals: 2, format: 'plain' })
      it('finite JSON numbers with |x| < 1e15', () => {
        expect(validateFieldValue(NUM, 3.14159)).toEqual({ ok: true, value: 3.14159 })
        expect(validateFieldValue(NUM, 999999999999999)).toEqual({ ok: true, value: 999999999999999 })
        expect(validateFieldValue(NUM, 1e15)).toEqual({ ok: false, reason: 'out_of_range' })
        expect(validateFieldValue(NUM, -1e15)).toEqual({ ok: false, reason: 'out_of_range' })
        expect(validateFieldValue(NUM, Number.NaN)).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(NUM, Number.POSITIVE_INFINITY)).toEqual({ ok: false, reason: 'invalid_value' })
      })
      it('a numeric STRING is refused (not coerced)', () => {
        expect(validateFieldValue(NUM, '12')).toEqual({ ok: false, reason: 'invalid_value' })
      })
    })
    describe('select', () => {
      it('stores the option id', () => {
        expect(validateFieldValue(SELECT, 'opt_a')).toEqual({ ok: true, value: 'opt_a' })
      })
      it('a label is not an option id', () => {
        expect(validateFieldValue(SELECT, 'High')).toEqual({ ok: false, reason: 'not_in_options' })
      })
      // M5-d style control: validating by label instead of id turns this red.
      it('after a rename the stored option id is still valid', () => {
        const renamed = def('select', { options: [{ id: 'opt_a', label: 'Urgent' }, { id: 'opt_b', label: 'Low' }] })
        expect(validateFieldValue(renamed, 'opt_a')).toEqual({ ok: true, value: 'opt_a' })
        expect(validateFieldValue(renamed, 'High')).toEqual({ ok: false, reason: 'not_in_options' })
      })
      it('a non-string is invalid_value', () => {
        expect(validateFieldValue(SELECT, 1)).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(SELECT, ['opt_a'])).toEqual({ ok: false, reason: 'invalid_value' })
      })
      it('ids are compared exactly: a padded id, a blank id, or another case is not an option', () => {
        for (const raw of [' opt_a', 'opt_a ', '  ', 'OPT_A']) {
          expect(validateFieldValue(SELECT, raw), JSON.stringify(raw)).toEqual({ ok: false, reason: 'not_in_options' })
        }
      })
      it('object-prototype names are not options', () => {
        for (const raw of ['__proto__', 'constructor', 'toString']) {
          expect(validateFieldValue(SELECT, raw), raw).toEqual({ ok: false, reason: 'not_in_options' })
        }
      })
    })
    describe('multiSelect', () => {
      it('deduplicates in first-seen order; an empty array clears', () => {
        expect(validateFieldValue(MULTI, ['opt_b', 'opt_a', 'opt_b'])).toEqual({ ok: true, value: ['opt_b', 'opt_a'] })
        expect(validateFieldValue(MULTI, [])).toEqual({ ok: true, value: null })
      })
      it('an unknown id (or a label) is not_in_options', () => {
        expect(validateFieldValue(MULTI, ['opt_a', 'opt_x'])).toEqual({ ok: false, reason: 'not_in_options' })
        expect(validateFieldValue(MULTI, ['Red'])).toEqual({ ok: false, reason: 'not_in_options' })
      })
      it('only an array of non-empty strings is a well-formed value', () => {
        expect(validateFieldValue(MULTI, 'opt_a')).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(MULTI, [1])).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(MULTI, [''])).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(MULTI, ['opt_a', null])).toEqual({ ok: false, reason: 'invalid_value' })
      })
      it('ids are compared exactly: padded or blank entries are refused, not trimmed or skipped', () => {
        expect(validateFieldValue(MULTI, [' opt_a'])).toEqual({ ok: false, reason: 'not_in_options' })
        expect(validateFieldValue(MULTI, ['opt_a', 'opt_b '])).toEqual({ ok: false, reason: 'not_in_options' })
        expect(validateFieldValue(MULTI, ['  '])).toEqual({ ok: false, reason: 'not_in_options' })
        expect(validateFieldValue(MULTI, ['opt_a', '  '])).toEqual({ ok: false, reason: 'not_in_options' })
      })
      it('object-prototype names are not options', () => {
        expect(validateFieldValue(MULTI, ['opt_a', '__proto__'])).toEqual({ ok: false, reason: 'not_in_options' })
      })
    })
    describe('member', () => {
      it('user ids from the candidate set, deduplicated', () => {
        expect(validateFieldValue(MEMBER, ['u2', 'u1', 'u2'], { memberCandidates: CANDIDATES })).toEqual({ ok: true, value: ['u2', 'u1'] })
        expect(validateFieldValue(MEMBER, [], { memberCandidates: CANDIDATES })).toEqual({ ok: true, value: null })
      })
      it('someone outside the candidate set is not_a_candidate', () => {
        expect(validateFieldValue(MEMBER, ['u1', 'outsider'], { memberCandidates: CANDIDATES })).toEqual({ ok: false, reason: 'not_a_candidate' })
      })
      it('single: at most one user', () => {
        const single = def('member', { single: true })
        expect(validateFieldValue(single, ['u1'], { memberCandidates: CANDIDATES })).toEqual({ ok: true, value: ['u1'] })
        expect(validateFieldValue(single, ['u1', 'u2'], { memberCandidates: CANDIDATES })).toEqual({ ok: false, reason: 'invalid_value' })
      })
      it('at most 50 users', () => {
        const many = Array.from({ length: 51 }, (_, i) => `u${i}`)
        const pool = new Set(many)
        expect(validateFieldValue(MEMBER, many.slice(0, 50), { memberCandidates: pool }).ok).toBe(true)
        expect(validateFieldValue(MEMBER, many, { memberCandidates: pool })).toEqual({ ok: false, reason: 'limit' })
      })
      it('malformed values and a missing candidate set', () => {
        expect(validateFieldValue(MEMBER, 'u1', { memberCandidates: CANDIDATES })).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(MEMBER, [7], { memberCandidates: CANDIDATES })).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(MEMBER, [''], { memberCandidates: CANDIDATES })).toEqual({ ok: false, reason: 'invalid_value' })
        expect(() => validateFieldValue(MEMBER, ['u1'])).toThrow(TypeError)
        expect(() => validateFieldValue(MEMBER, ['u1'], { memberCandidates: ['u1'] as never })).toThrow(TypeError)
      })
      it('ids are compared exactly: padded or blank entries are refused, not trimmed or skipped', () => {
        expect(validateFieldValue(MEMBER, [' u1'], { memberCandidates: CANDIDATES })).toEqual({ ok: false, reason: 'not_a_candidate' })
        expect(validateFieldValue(MEMBER, ['u1', 'u2 '], { memberCandidates: CANDIDATES })).toEqual({ ok: false, reason: 'not_a_candidate' })
        expect(validateFieldValue(MEMBER, ['  '], { memberCandidates: CANDIDATES })).toEqual({ ok: false, reason: 'not_a_candidate' })
      })
      it('a user id longer than 50 characters is refused even when it is a candidate (ASSUMPTION(task-e, own choice))', () => {
        const id50 = 'u'.repeat(50)
        const id51 = 'u'.repeat(51)
        const pool = new Set([id50, id51])
        expect(validateFieldValue(MEMBER, [id50], { memberCandidates: pool })).toEqual({ ok: true, value: [id50] })
        expect(validateFieldValue(MEMBER, [id51], { memberCandidates: pool })).toEqual({ ok: false, reason: 'not_a_candidate' })
      })
      it('duplicates do not count toward the 50-user limit', () => {
        const fifty = Array.from({ length: 50 }, (_, i) => `u${i}`)
        expect(validateFieldValue(MEMBER, [...fifty, 'u0', 'u49'], { memberCandidates: new Set(fifty) })).toEqual({ ok: true, value: fifty })
      })
      it('candidate membership is checked before the 50-user limit', () => {
        const many = Array.from({ length: 51 }, (_, i) => `u${i}`)
        expect(validateFieldValue(MEMBER, [...many, 'outsider'], { memberCandidates: new Set(many) })).toEqual({ ok: false, reason: 'not_a_candidate' })
      })
    })
    describe('date', () => {
      it('a floating YYYY-MM-DD only', () => {
        expect(validateFieldValue(def('date'), '2026-10-07')).toEqual({ ok: true, value: '2026-10-07' })
        expect(validateFieldValue(def('date'), '2026-02-30')).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(def('date'), '2026-10-07T00:00:00Z')).toEqual({ ok: false, reason: 'invalid_value' })
        expect(validateFieldValue(def('date'), 20261007)).toEqual({ ok: false, reason: 'invalid_value' })
      })
    })
    it('a malformed definition is a TypeError', () => {
      expect(() => validateFieldValue({ id: 'tfld_1', type: 'url', name: 'x', config: {} } as never, 'https://a')).toThrow(TypeError)
      expect(() => validateFieldValue('x' as never, 'x')).toThrow(TypeError)
    })
  })

  describe('applySetFieldValue', () => {
    it('emits field_value_changed when the stored value changes', () => {
      expect(applySetFieldValue({ def: SELECT, current: 'opt_b', next: 'opt_a', actorId: 'u1', now: NOW })).toEqual({
        ok: true,
        value: 'opt_a',
        noop: false,
        events: [{ type: 'field_value_changed', userId: 'u1', occurredAt: NOW, payload: { fieldId: 'tfld_1' } }],
      })
    })
    it('the same value (after normalization) is a no-op', () => {
      expect(applySetFieldValue({ def: MULTI, current: ['opt_a'], next: ['opt_a', 'opt_a'], actorId: 'u1', now: NOW })).toEqual({
        ok: true,
        value: ['opt_a'],
        noop: true,
        events: [],
      })
      expect(applySetFieldValue({ def: SELECT, current: undefined, next: null, actorId: 'u1', now: NOW })).toEqual({ ok: true, value: null, noop: true, events: [] })
    })
    it('clearing a stored value is a change', () => {
      const changed = { ok: true, value: null, noop: false, events: [{ type: 'field_value_changed', userId: 'u1', occurredAt: NOW, payload: { fieldId: 'tfld_1' } }] }
      expect(applySetFieldValue({ def: SELECT, current: 'opt_a', next: null, actorId: 'u1', now: NOW })).toEqual(changed)
      expect(applySetFieldValue({ def: SELECT, current: 'opt_a', next: '', actorId: 'u1', now: NOW })).toEqual(changed)
      expect(applySetFieldValue({ def: MULTI, current: ['opt_a'], next: [], actorId: 'u1', now: NOW })).toEqual(changed)
    })
    it('a refused value passes the reason through', () => {
      expect(applySetFieldValue({ def: SELECT, current: null, next: 'opt_x', actorId: 'u1', now: NOW })).toEqual({ ok: false, reason: 'not_in_options' })
    })
    it('requires an actor and a Date', () => {
      expect(() => applySetFieldValue({ def: SELECT, current: null, next: 'opt_a', actorId: '', now: NOW })).toThrow(TypeError)
      expect(() => applySetFieldValue({ def: SELECT, current: null, next: 'opt_a', actorId: 'u1', now: 'now' as never })).toThrow(TypeError)
    })
  })

  describe('permissions (RULED(2026-10-09): [S26])', () => {
    it('canManageFieldDefinition: creator, or edit/owner on a list binding the field', () => {
      expect(canManageFieldDefinition({ actorId: 'u1', createdBy: 'u1', actorEditsBindingList: false })).toBe(true)
      expect(canManageFieldDefinition({ actorId: 'u2', createdBy: 'u1', actorEditsBindingList: true })).toBe(true)
      expect(canManageFieldDefinition({ actorId: 'u2', createdBy: 'u1', actorEditsBindingList: false })).toBe(false)
      expect(canManageFieldDefinition({ actorId: '', createdBy: '', actorEditsBindingList: false })).toBe(false)
    })
    it('planDeleteFieldDefinition: creator only, and only with zero bindings', () => {
      expect(planDeleteFieldDefinition({ actorId: 'u1', createdBy: 'u1', bindingCount: 0 })).toEqual({ ok: true })
      expect(planDeleteFieldDefinition({ actorId: 'u1', createdBy: 'u1', bindingCount: 1 })).toEqual({ ok: false, reason: 'field_in_use' })
      expect(planDeleteFieldDefinition({ actorId: 'u2', createdBy: 'u1', bindingCount: 0 })).toEqual({ ok: false, reason: 'forbidden' })
      expect(planDeleteFieldDefinition({ actorId: 'u2', createdBy: 'u1', bindingCount: 3 })).toEqual({ ok: false, reason: 'forbidden' })
      // A blank actor never matches a blank creator.
      expect(planDeleteFieldDefinition({ actorId: '', createdBy: '', bindingCount: 0 })).toEqual({ ok: false, reason: 'forbidden' })
      expect(() => planDeleteFieldDefinition({ actorId: 'u1', createdBy: 'u1', bindingCount: -1 })).toThrow(TypeError)
    })
    it('canBindField: the list editor (edit/owner) only', () => {
      expect(canBindField('editor')).toBe(true)
      expect(canBindField('reader')).toBe(false)
      expect(canBindField(null)).toBe(false)
      expect(() => canBindField('owner' as never)).toThrow(TypeError)
    })
    it('canWriteFieldValue: edit on the task and the field bound to one of its lists', () => {
      expect(canWriteFieldValue({ taskRoles: ['assignee'], fieldBoundToTaskList: true })).toBe(true)
      expect(canWriteFieldValue({ taskRoles: ['list-editor'], fieldBoundToTaskList: true })).toBe(true)
      expect(canWriteFieldValue({ taskRoles: ['follower', 'list-reader'], fieldBoundToTaskList: true })).toBe(false)
      expect(canWriteFieldValue({ taskRoles: ['creator'], fieldBoundToTaskList: false })).toBe(false)
    })
    it('checkFieldDefinitionQuota: at most 200 per org', () => {
      expect(checkFieldDefinitionQuota(199)).toEqual({ ok: true })
      expect(checkFieldDefinitionQuota(200)).toEqual({ ok: false, reason: 'limit' })
      expect(() => checkFieldDefinitionQuota(-1)).toThrow(TypeError)
    })
  })

  describe('bindings', () => {
    const bind = (boundFieldIds: string[], fieldId = 'tfld_new') => applyBindField({ listId: 'tlst_1', fieldId, boundFieldIds, actorId: 'u1', now: NOW })
    it('binding emits field_bound on the list', () => {
      expect(bind([])).toEqual({
        ok: true,
        noop: false,
        events: [{ listId: 'tlst_1', type: 'field_bound', userId: 'u1', occurredAt: NOW, payload: { fieldId: 'tfld_new' } }],
      })
    })
    it('binding an already-bound field is a no-op', () => {
      expect(bind(['tfld_new'])).toEqual({ ok: true, noop: true, events: [] })
    })
    it('at most 50 bindings per list', () => {
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `tfld_${i}`)
      expect(bind(ids(49)).ok).toBe(true)
      expect(bind(ids(50))).toEqual({ ok: false, reason: 'limit' })
    })
    it('unbinding emits field_unbound; unbinding an unbound field is a no-op', () => {
      expect(applyUnbindField({ listId: 'tlst_1', fieldId: 'tfld_a', boundFieldIds: ['tfld_a'], actorId: 'u1', now: NOW })).toEqual({
        noop: false,
        events: [{ listId: 'tlst_1', type: 'field_unbound', userId: 'u1', occurredAt: NOW, payload: { fieldId: 'tfld_a' } }],
      })
      expect(applyUnbindField({ listId: 'tlst_1', fieldId: 'tfld_a', boundFieldIds: [], actorId: 'u1', now: NOW })).toEqual({ noop: true, events: [] })
    })
  })

  describe('resolveVisibleTaskFieldValues (RULED(2026-10-09): [S27])', () => {
    const bindings = [
      { listId: 'tlst_1', fieldId: 'tfld_b', position: 2, hidden: false },
      { listId: 'tlst_1', fieldId: 'tfld_a', position: 1, hidden: true },
      { listId: 'tlst_2', fieldId: 'tfld_c', position: 1, hidden: false },
      { listId: 'tlst_3', fieldId: 'tfld_d', position: 1, hidden: false },
    ]
    const values = [
      { fieldId: 'tfld_a', value: 'opt_x' },
      { fieldId: 'tfld_c', value: 3 },
    ]
    it('only lists that hold the task AND have the viewer as a member', () => {
      expect(
        resolveVisibleTaskFieldValues({ canView: true, viewerListIds: ['tlst_1', 'tlst_3'], taskListIds: ['tlst_1', 'tlst_2'], bindings, values }),
      ).toEqual([
        {
          listId: 'tlst_1',
          fields: [
            { fieldId: 'tfld_a', hidden: true, value: 'opt_x' },
            { fieldId: 'tfld_b', hidden: false, value: null },
          ],
        },
      ])
    })
    it('a viewer with only a direct role (no list membership) sees no custom-field values', () => {
      expect(resolveVisibleTaskFieldValues({ canView: true, viewerListIds: [], taskListIds: ['tlst_1', 'tlst_2'], bindings, values })).toEqual([])
    })
    it('no view ability, no values', () => {
      expect(resolveVisibleTaskFieldValues({ canView: false, viewerListIds: ['tlst_1'], taskListIds: ['tlst_1'], bindings, values })).toEqual([])
    })
    it('a list that binds no field is left out', () => {
      expect(resolveVisibleTaskFieldValues({ canView: true, viewerListIds: ['tlst_9'], taskListIds: ['tlst_9'], bindings, values })).toEqual([])
    })
    it('rejects malformed bindings', () => {
      expect(() =>
        resolveVisibleTaskFieldValues({ canView: true, viewerListIds: [], taskListIds: [], bindings: [{ listId: 'tlst_1', fieldId: 'f', position: 'x', hidden: false }] as never, values: [] }),
      ).toThrow(TypeError)
    })
  })

  describe('listReusableTaskFieldIds (RULED(2026-10-09): [S24])', () => {
    it('fields I created plus fields bound to lists I can edit', () => {
      const fields = [
        { id: 'tfld_mine', createdBy: 'me' },
        { id: 'tfld_bound', createdBy: 'other' },
        { id: 'tfld_elsewhere', createdBy: 'other' },
      ]
      const bindings = [
        { listId: 'tlst_edit', fieldId: 'tfld_bound' },
        { listId: 'tlst_read', fieldId: 'tfld_elsewhere' },
        { listId: 'tlst_edit', fieldId: 'tfld_deleted' },
      ]
      expect(listReusableTaskFieldIds({ actorId: 'me', fields, bindings, editableListIds: ['tlst_edit'] })).toEqual(['tfld_bound', 'tfld_mine'])
    })
  })
})
