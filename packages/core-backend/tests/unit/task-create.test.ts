import { describe, expect, it } from 'vitest'
import { isPrintableId, isStorableText, isValidMemberId, MEMBER_ID_MAX_LENGTH, resolveCreateAssigneeIds } from '../../src/services/task-create'
import { newTaskEventId } from '../../src/services/task-ids-runtime'

describe('task create assignees', () => {
  it('inserts the creator when the field is omitted', () => {
    expect(resolveCreateAssigneeIds({ assignees: undefined, creatorId: 'u1' })).toEqual(['u1'])
  })

  it('inserts nobody when the array is empty', () => {
    expect(resolveCreateAssigneeIds({ assignees: [], creatorId: 'u1' })).toEqual([])
  })

  it('inserts only the listed users', () => {
    expect(resolveCreateAssigneeIds({ assignees: ['u2', 'u2'], creatorId: 'u1' })).toEqual(['u2'])
  })

  it('rejects an assignee id the table check would refuse', () => {
    for (const assignees of [['bad id'], ['备料'], ['usr\n'], ['usr\u0000']]) {
      expect(() => resolveCreateAssigneeIds({ assignees, creatorId: 'u1' })).toThrowError(
        expect.objectContaining({ status: 422, code: 'INVALID_ASSIGNEES' }),
      )
    }
    expect(() => resolveCreateAssigneeIds({ assignees: undefined, creatorId: 'bad id' })).toThrowError(
      expect.objectContaining({ status: 422, code: 'INVALID_ASSIGNEES' }),
    )
  })

  it('rejects "." and ".." for both an explicit assignee and the omitted-field creator row', () => {
    for (const dot of ['.', '..']) {
      expect(() => resolveCreateAssigneeIds({ assignees: [dot], creatorId: 'u1' })).toThrowError(
        expect.objectContaining({ status: 422, code: 'INVALID_ASSIGNEES' }),
      )
      expect(() => resolveCreateAssigneeIds({ assignees: undefined, creatorId: dot })).toThrowError(
        expect.objectContaining({ status: 422, code: 'INVALID_ASSIGNEES' }),
      )
    }
  })

  it('bounds member ids at 255 characters for an explicit assignee, the creator row, and the shared validator', () => {
    expect(MEMBER_ID_MAX_LENGTH).toBe(255)
    const at = 'u'.repeat(255)
    const over = 'u'.repeat(256)
    expect(isValidMemberId(at)).toBe(true)
    expect(isValidMemberId(over)).toBe(false)
    expect(resolveCreateAssigneeIds({ assignees: [at], creatorId: 'u1' })).toEqual([at])
    expect(resolveCreateAssigneeIds({ assignees: undefined, creatorId: at })).toEqual([at])
    expect(() => resolveCreateAssigneeIds({ assignees: [over], creatorId: 'u1' })).toThrowError(
      expect.objectContaining({ status: 422, code: 'INVALID_ASSIGNEES' }),
    )
    expect(() => resolveCreateAssigneeIds({ assignees: undefined, creatorId: over })).toThrowError(
      expect.objectContaining({ status: 422, code: 'INVALID_ASSIGNEES' }),
    )
  })
})

describe('create assignee soft limit (M3R3-IN-2)', () => {
  const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`)

  it('accepts 50 distinct ids and 51 entries that are 50 distinct', () => {
    expect(resolveCreateAssigneeIds({ assignees: idsOf(50), creatorId: 'c' })).toHaveLength(50)
    expect(resolveCreateAssigneeIds({ assignees: [...idsOf(50), 'u0'], creatorId: 'c' })).toHaveLength(50)
  })

  it('rejects 51 distinct ids as 422 LIMIT', () => {
    expect(() => resolveCreateAssigneeIds({ assignees: idsOf(51), creatorId: 'c' })).toThrowError(
      expect.objectContaining({ status: 422, code: 'LIMIT' }),
    )
  })

  it('validates every id before counting', () => {
    expect(() => resolveCreateAssigneeIds({ assignees: [...idsOf(60), '..'], creatorId: 'c' })).toThrowError(
      expect.objectContaining({ status: 422, code: 'INVALID_ASSIGNEES' }),
    )
  })
})

describe('storable user text (M3R3-IN-3, M3R3-IN-4)', () => {
  it('rejects U+0000 and lone surrogates, accepts well-formed text including surrogate pairs', () => {
    for (const bad of ['a\u0000b', '\u0000', '\ud800', '\udfff', 'a\udc00b', 'x\ud83d', '\ude00y', '\ude00\ud83d']) {
      expect(isStorableText(bad), JSON.stringify(bad)).toBe(false)
    }
    for (const good of ['', 'abc', '任务', '\ud83d\ude00', 'a\ud83d\ude00b\ud83d\ude00', '\ufffd']) {
      expect(isStorableText(good), JSON.stringify(good)).toBe(true)
    }
  })
})

describe('printable lookup ids', () => {
  it('accepts printable ASCII and rejects U+0000, other controls, non-ASCII, empty and non-strings', () => {
    expect(isPrintableId('tsk_abc')).toBe(true)
    for (const bad of ['', 'a\u0000b', '\u0000', 'a b', 'tsk_\n', 'tsk_é', 42, null, undefined]) {
      expect(isPrintableId(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('task event ids', () => {
  it('uses the tev_ prefix', () => {
    expect(newTaskEventId().startsWith('tev_')).toBe(true)
  })
})
