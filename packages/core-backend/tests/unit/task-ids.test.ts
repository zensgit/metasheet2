import { describe, expect, it } from 'vitest'
import {
  TASK_ID_PREFIXES,
  generateTaskDomainId,
  isValidPrintableAsciiId,
  isValidTaskDomainId,
  normalizeUserText,
  parseTaskProjectionRecordId,
} from '../../src/tasks/task-ids'

describe('task-ids', () => {
  describe('TASK_ID_PREFIXES', () => {
    it('is the closed three-kind set', () => {
      expect(TASK_ID_PREFIXES).toEqual({ task: 'tsk', list: 'tlst', comment: 'tcmt', event: 'tev' })
    })
  })

  describe('generateTaskDomainId — generation format', () => {
    const fixedRandom = (bytes: number): string => 'a1B2c3D4e5F6g7H8'.slice(0, bytes)

    it('task kind produces a tsk_-prefixed id matching the format', () => {
      const id = generateTaskDomainId('task', fixedRandom)
      expect(id).toMatch(/^tsk_[A-Za-z0-9]+$/)
      expect(id).toBe('tsk_a1B2c3D4e5F6g7H8')
    })

    it('list kind produces a tlst_-prefixed id matching the format', () => {
      expect(generateTaskDomainId('list', fixedRandom)).toMatch(/^tlst_[A-Za-z0-9]+$/)
    })

    it('event kind produces a tev_-prefixed id that passes the four-conjunct CHECK', () => {
      const id = generateTaskDomainId('event', fixedRandom)
      expect(id).toMatch(/^tev_[A-Za-z0-9]+$/)
      expect(isValidTaskDomainId(id)).toBe(true)
    })

    it('comment kind produces a tcmt_-prefixed id matching the format', () => {
      expect(generateTaskDomainId('comment', fixedRandom)).toMatch(/^tcmt_[A-Za-z0-9]+$/)
    })

    it('is pure: same kind + same random source yields the same id', () => {
      expect(generateTaskDomainId('task', fixedRandom)).toBe(generateTaskDomainId('task', fixedRandom))
    })

    it('every generated id also satisfies the four-conjunct CHECK', () => {
      expect(isValidTaskDomainId(generateTaskDomainId('task', fixedRandom))).toBe(true)
    })

    it('rejects an unknown kind', () => {
      expect(() => generateTaskDomainId('bogus' as unknown as 'task', fixedRandom)).toThrow()
    })

    it('rejects a random source that returns a non-alphanumeric string', () => {
      expect(() => generateTaskDomainId('task', () => 'has space')).toThrow()
      expect(() => generateTaskDomainId('task', () => '')).toThrow()
      expect(() => generateTaskDomainId('task', () => 'has_underscore')).toThrow()
    })
  })

  describe('isValidPrintableAsciiId — single conjunct (org_id / created_by)', () => {
    it('accepts printable ASCII including leading/trailing/double underscore', () => {
      expect(isValidPrintableAsciiId('org_123')).toBe(true)
      expect(isValidPrintableAsciiId('_leading')).toBe(true)
      expect(isValidPrintableAsciiId('trailing_')).toBe(true)
      expect(isValidPrintableAsciiId('a__b')).toBe(true)
    })

    it('rejects non-ASCII and space', () => {
      expect(isValidPrintableAsciiId('组织_123')).toBe(false)
      expect(isValidPrintableAsciiId('has space')).toBe(false)
    })

    it('rejects empty/non-string', () => {
      expect(isValidPrintableAsciiId('')).toBe(false)
      expect(isValidPrintableAsciiId(undefined)).toBe(false)
      expect(isValidPrintableAsciiId(null)).toBe(false)
      expect(isValidPrintableAsciiId(42)).toBe(false)
    })
  })

  describe('isValidTaskDomainId — four-conjunct CHECK (positive/negative)', () => {
    it('accepts a well-formed id', () => {
      expect(isValidTaskDomainId('tsk_abc123')).toBe(true)
      expect(isValidTaskDomainId('tlst_Zz9')).toBe(true)
    })

    it('rejects leading underscore', () => {
      expect(isValidTaskDomainId('_tsk_abc')).toBe(false)
    })

    it('rejects trailing underscore', () => {
      expect(isValidTaskDomainId('tsk_abc_')).toBe(false)
    })

    it('rejects double underscore anywhere', () => {
      expect(isValidTaskDomainId('tsk__abc')).toBe(false)
      expect(isValidTaskDomainId('tsk_ab__cd')).toBe(false)
    })

    it('rejects non-ASCII', () => {
      expect(isValidTaskDomainId('tsk_中文')).toBe(false)
    })

    it('rejects empty string', () => {
      expect(isValidTaskDomainId('')).toBe(false)
    })

    describe('mutation probes (per design §5 "去掉一个合取 ⇒ 对应反例翻绿 ⇒ 红")', () => {
      it('dropping the `!~ __` conjunct wrongly accepts tsk__abc — real function still rejects it', () => {
        const mutantMissingDoubleUnderscore = (s: unknown): boolean =>
          typeof s === 'string' && /^[!-~]+$/.test(s) && !s.startsWith('_') && !s.endsWith('_')
        expect(mutantMissingDoubleUnderscore('tsk__abc')).toBe(true)
        expect(isValidTaskDomainId('tsk__abc')).toBe(false)
      })

      it('dropping the `!~ ^_` conjunct wrongly accepts _tsk_abc — real function still rejects it', () => {
        const mutantMissingLeading = (s: unknown): boolean =>
          typeof s === 'string' && /^[!-~]+$/.test(s) && !s.includes('__') && !s.endsWith('_')
        expect(mutantMissingLeading('_tsk_abc')).toBe(true)
        expect(isValidTaskDomainId('_tsk_abc')).toBe(false)
      })

      it('dropping the `!~ _$` conjunct wrongly accepts tsk_abc_ — real function still rejects it', () => {
        const mutantMissingTrailing = (s: unknown): boolean =>
          typeof s === 'string' && /^[!-~]+$/.test(s) && !s.includes('__') && !s.startsWith('_')
        expect(mutantMissingTrailing('tsk_abc_')).toBe(true)
        expect(isValidTaskDomainId('tsk_abc_')).toBe(false)
      })

      it('dropping the printable-ASCII conjunct wrongly accepts tsk_中文 — real function still rejects it', () => {
        const mutantMissingAscii = (s: unknown): boolean =>
          typeof s === 'string' && !s.includes('__') && !s.startsWith('_') && !s.endsWith('_')
        expect(mutantMissingAscii('tsk_中文')).toBe(true)
        expect(isValidTaskDomainId('tsk_中文')).toBe(false)
      })
    })
  })

  describe('parseTaskProjectionRecordId', () => {
    it('parses a well-formed record id', () => {
      expect(parseTaskProjectionRecordId('rec_tsk_tlst_a__tsk_b')).toEqual({
        listId: 'tlst_a',
        taskId: 'tsk_b',
      })
    })

    it('boundary: listId containing a single underscore is not mistaken for the separator', () => {
      expect(parseTaskProjectionRecordId('rec_tsk_tlst_ab_cd__tsk_ef')).toEqual({
        listId: 'tlst_ab_cd',
        taskId: 'tsk_ef',
      })
    })

    // PINNED VALUE CHANGED (P1 finding): a taskId half containing a SECOND `__` fails the
    // four-conjunct `isValidTaskDomainId` CHECK (`!~ '__'`) — the exact lock §7 / gate-10 write-path
    // 422 negative ("listId 含 __") applied to the taskId half instead. Splitting at the first `__`
    // and then handing back a half that would never pass the DDL CHECK is itself the bug this test
    // used to enshrine (it asserted `{listId:'tlst_a', taskId:'tsk_b__c'}` — a taskId the CHECK
    // would reject). The function now validates BOTH halves and returns `null`.
    it('boundary: a SECOND __ inside the taskId half is a lock §7 negative — the split is invalid, not "first __ wins"', () => {
      expect(parseTaskProjectionRecordId('rec_tsk_tlst_a__tsk_b__c')).toBeNull()
    })

    describe('lock §7 / gate-10 write-path 422 negatives (P1 finding fix)', () => {
      it('listId half containing __ (found via the taskId side of a split) is rejected', () => {
        expect(parseTaskProjectionRecordId('rec_tsk_tlst_a__b__tsk_c')).toBeNull()
      })

      it('a half with a leading _ is rejected', () => {
        expect(parseTaskProjectionRecordId('rec_tsk_tlst_a___tsk_b')).toBeNull()
      })

      it('a half with a trailing _ is rejected', () => {
        expect(parseTaskProjectionRecordId('rec_tsk_tlst_a__tsk_b_')).toBeNull()
      })

      it('a listId half with a leading _ is rejected', () => {
        expect(parseTaskProjectionRecordId('rec_tsk__tlst_a__tsk_b')).toBeNull()
      })
    })

    it('rejects a non-matching fixed prefix (returns null, does not throw)', () => {
      expect(parseTaskProjectionRecordId('nope_tlst_a__tsk_b')).toBeNull()
    })

    it('rejects when no __ separator remains after the prefix', () => {
      expect(parseTaskProjectionRecordId('rec_tsk_noseparatorhere')).toBeNull()
    })

    it('rejects an empty listId or empty taskId half', () => {
      expect(parseTaskProjectionRecordId('rec_tsk___tsk_b')).toBeNull()
      expect(parseTaskProjectionRecordId('rec_tsk_tlst_a__')).toBeNull()
    })

    it('rejects non-string input without throwing', () => {
      expect(() => parseTaskProjectionRecordId(42)).not.toThrow()
      expect(parseTaskProjectionRecordId(42)).toBeNull()
      expect(parseTaskProjectionRecordId(undefined)).toBeNull()
      expect(parseTaskProjectionRecordId(null)).toBeNull()
    })
  })

  describe('normalizeUserText', () => {
    it('passes a normal CJK title through unchanged', () => {
      expect(normalizeUserText('备料复核')).toBe('备料复核')
    })

    it('tab-only input normalizes to null', () => {
      expect(normalizeUserText('\t')).toBeNull()
    })

    it('mixed whitespace/newline input normalizes to null', () => {
      expect(normalizeUserText('  \n ')).toBeNull()
    })

    it('ideographic space (U+3000, full-width) normalizes to null', () => {
      expect(normalizeUserText('　')).toBeNull()
    })

    it('zero-width marks (U+200B/200C/200D/FEFF) alone normalize to null', () => {
      expect(normalizeUserText('​‌‍﻿')).toBeNull()
    })

    it('empty string normalizes to null', () => {
      expect(normalizeUserText('')).toBeNull()
    })

    it('non-string input normalizes to null', () => {
      expect(normalizeUserText(undefined)).toBeNull()
      expect(normalizeUserText(null)).toBeNull()
      expect(normalizeUserText(42)).toBeNull()
    })

    it('NFC-composes a decomposed form to its precomposed equivalent', () => {
      const decomposed = 'é' // "e" + COMBINING ACUTE ACCENT
      expect(normalizeUserText(decomposed)).toBe('é') // "é"
      expect(normalizeUserText(decomposed)!.length).toBe(1)
    })

    it('trims leading/trailing whitespace but preserves internal spacing and zero-width-free content', () => {
      expect(normalizeUserText('  hello world  ')).toBe('hello world')
      expect(normalizeUserText('​hello​')).toBe('hello')
    })

    // P2 finding fix: the function used to strip zero-width marks EVERYWHERE (not just the edges)
    // and did so BEFORE re-checking NFC composition, which was both non-idempotent and destructive
    // of real content (emoji ZWJ sequences, Persian/Indic ZWNJ). It now trims zero-width marks only
    // at the two edges — exactly like whitespace — and re-applies NFC after stripping.
    describe('idempotence + interior zero-width marks are content, not noise (P2 finding fix)', () => {
      it('is idempotent on an interior zero-width mark that used to block NFC composition', () => {
        // "e" + ZERO WIDTH SPACE (U+200B) + COMBINING ACUTE ACCENT (U+0301) — the ZWSP sits BETWEEN
        // the base and the combining mark, so it blocks composition either way; the point is that
        // applying normalizeUserText twice must produce the SAME result both times.
        const input = 'e​́'
        const once = normalizeUserText(input)
        expect(once).not.toBeNull()
        expect(normalizeUserText(once as string)).toBe(once)
      })

      it('is idempotent on a Hangul jamo pair split by an interior zero-width mark', () => {
        const input = 'ᄀ​ᅡ' // ᄀ + ZWSP + ᅡ
        const once = normalizeUserText(input)
        expect(once).not.toBeNull()
        expect(normalizeUserText(once as string)).toBe(once)
      })

      it('preserves an interior ZWJ emoji sequence (family emoji) unchanged', () => {
        const familyEmoji = '👨‍👩‍👧 家庭'
        expect(normalizeUserText(familyEmoji)).toBe(familyEmoji)
        expect([...(normalizeUserText(familyEmoji) as string)].length).toBe([...familyEmoji].length)
      })

      it('preserves an interior ZWNJ in Persian text unchanged', () => {
        const persian = 'می‌خواهم' // contains U+200C ZWNJ between می and خواهم
        expect(normalizeUserText(persian)).toBe(persian)
      })

      it('a decomposed form with NO intervening zero-width mark still composes to NFC (unaffected by the edges-only change)', () => {
        expect(normalizeUserText('é')).toBe('é')
      })
    })
  })
})

describe('task-ids — review round 2 fixes', () => {
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty'])(
    'generateTaskDomainId rejects an Object.prototype key %j as kind',
    (kind) => {
      expect(() => generateTaskDomainId(kind as never, () => 'abc')).toThrow(TypeError)
    },
  )
})
