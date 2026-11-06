/**
 * Task usability package 1b: the pure half of the people directory (src/tasks/task-people-search.ts)
 * — the query bounds, the member id rule, the LIKE escape and the masked email.
 */
import { describe, expect, it } from 'vitest'
import { isValidMemberId } from '../../src/services/task-create'
import {
  PEOPLE_IDS_QUERY_MAX_LENGTH,
  PEOPLE_PAGE_MAX,
  PEOPLE_QUERY_MAX_LENGTH,
  PEOPLE_RESOLVE_MAX_IDS,
  clampPeopleLimit,
  escapeLikeTerm,
  isPeopleId,
  maskEmail,
  normalizePeopleQuery,
  parsePeopleIds,
  parsePeopleRequest,
} from '../../src/tasks/task-people-search'
import { TASK_ASSIGNEE_SOFT_LIMIT } from '../../src/tasks/task-membership'

describe('people directory bounds', () => {
  it('the decided bounds: 20 rows, 50 ids (the assignee limit), terms up to 64 characters', () => {
    expect(PEOPLE_PAGE_MAX).toBe(20)
    expect(PEOPLE_RESOLVE_MAX_IDS).toBe(TASK_ASSIGNEE_SOFT_LIMIT)
    expect(PEOPLE_RESOLVE_MAX_IDS).toBe(50)
    expect(PEOPLE_QUERY_MAX_LENGTH).toBe(64)
    expect(PEOPLE_IDS_QUERY_MAX_LENGTH).toBe(4096)
  })
})

describe('normalizePeopleQuery', () => {
  it('trims; a blank term is empty; 64 characters pass and 65 do not; a non-string is refused', () => {
    expect(normalizePeopleQuery('  张三 ')).toBe('张三')
    expect(normalizePeopleQuery('   ')).toBe('')
    expect(normalizePeopleQuery('')).toBe('')
    expect(normalizePeopleQuery('a'.repeat(64))).toBe('a'.repeat(64))
    expect(normalizePeopleQuery('a'.repeat(65))).toBeNull()
    expect(normalizePeopleQuery(['a', 'b'])).toBeNull()
    expect(normalizePeopleQuery({ a: 'b' })).toBeNull()
    expect(normalizePeopleQuery(undefined)).toBeNull()
  })
})

describe('escapeLikeTerm', () => {
  it('escapes %, _ and the backslash, and leaves other text alone', () => {
    expect(escapeLikeTerm('%')).toBe('\\%')
    expect(escapeLikeTerm('_')).toBe('\\_')
    expect(escapeLikeTerm('\\')).toBe('\\\\')
    expect(escapeLikeTerm('a%b_c\\d')).toBe('a\\%b\\_c\\\\d')
    expect(escapeLikeTerm('张三 li')).toBe('张三 li')
  })
})

describe('clampPeopleLimit', () => {
  it('defaults to the maximum, clamps into [1, 20], and reads anything else as the maximum', () => {
    expect(clampPeopleLimit(undefined)).toBe(20)
    expect(clampPeopleLimit('0')).toBe(1)
    expect(clampPeopleLimit(0)).toBe(1)
    expect(clampPeopleLimit('5')).toBe(5)
    expect(clampPeopleLimit('99')).toBe(20)
    expect(clampPeopleLimit('abc')).toBe(20)
    expect(clampPeopleLimit('-3')).toBe(20)
    expect(clampPeopleLimit(['5'])).toBe(20)
  })
})

describe('isPeopleId', () => {
  it('member id rule matches the server\'s', () => {
    const vector: unknown[] = ['.', '..', '', 'u'.repeat(255), 'u'.repeat(256), 'usr\u00001', 'usr 1', '用户', 'usr_1', 42, null]
    expect(vector.map((value) => isPeopleId(value))).toEqual(vector.map((value) => isValidMemberId(value)))
    expect(isPeopleId('usr_1')).toBe(true)
    expect(isPeopleId('..')).toBe(false)
  })
})

describe('parsePeopleIds', () => {
  it('splits on commas, trims and dedupes, in order', () => {
    expect(parsePeopleIds('a,b,a')).toEqual({ ids: ['a', 'b'], truncated: false })
    expect(parsePeopleIds(' a , b ')).toEqual({ ids: ['a', 'b'], truncated: false })
    expect(parsePeopleIds('')).toEqual({ ids: [], truncated: false })
  })

  it('drops ids the member rule refuses', () => {
    expect(parsePeopleIds(['.', '..', '', 'u'.repeat(256), 'ok_1'].join(','))).toEqual({ ids: ['ok_1'], truncated: false })
  })

  it('keeps the first 50 of 51 ids and says some were dropped', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `u${i}`)
    expect(parsePeopleIds(ids.join(','))).toEqual({ ids: ids.slice(0, 50), truncated: true })
    expect(parsePeopleIds(ids.slice(0, 50).join(','))).toEqual({ ids: ids.slice(0, 50), truncated: false })
  })

  it('a raw value of 4096 characters is read; 4097 or a non-string is refused', () => {
    const at = (length: number) => `a,${'b'.repeat(length - 2)}`
    expect(at(4096)).toHaveLength(4096)
    expect(parsePeopleIds(at(4096))).toEqual({ ids: ['a'], truncated: false })
    expect(parsePeopleIds(at(4097))).toBeNull()
    expect(parsePeopleIds(['a', 'b'])).toBeNull()
    expect(parsePeopleIds(undefined)).toBeNull()
  })
})

describe('maskEmail', () => {
  it('keeps two characters of the local part and the domain', () => {
    expect(maskEmail('alice@example.com')).toBe('al***@example.com')
    expect(maskEmail('a@x')).toBe('a***@x')
    expect(maskEmail('  bob@corp.test ')).toBe('bo***@corp.test')
    expect(maskEmail('')).toBe('')
    expect(maskEmail('   ')).toBe('')
    expect(maskEmail('no-at-sign')).toBe('no***')
  })

  it('never returns the full local part of a longer address', () => {
    const masked = maskEmail('distinctive.person@example.com')
    expect(masked).not.toContain('distinctive')
    expect(masked.endsWith('@example.com')).toBe(true)
  })
})

describe('parsePeopleRequest', () => {
  it('no key, or a blank term, is the marker with the page size', () => {
    expect(parsePeopleRequest({})).toEqual({ kind: 'blank', limit: 20 })
    expect(parsePeopleRequest({ q: '  ' })).toEqual({ kind: 'blank', limit: 20 })
    expect(parsePeopleRequest({ q: '', limit: '5' })).toEqual({ kind: 'blank', limit: 5 })
  })

  it('one character is a search', () => {
    expect(parsePeopleRequest({ q: '张' })).toEqual({ kind: 'search', term: '张', limit: 20 })
  })

  it('ids is a resolve, an empty ids is a resolve of nobody', () => {
    expect(parsePeopleRequest({ ids: 'a,b' })).toEqual({ kind: 'resolve', ids: ['a', 'b'], truncated: false })
    expect(parsePeopleRequest({ ids: '' })).toEqual({ kind: 'resolve', ids: [], truncated: false })
  })

  it('both keys, a term of 65 characters, a repeated key or an ids value too long are refused', () => {
    expect(parsePeopleRequest({ q: 'a', ids: 'b' })).toBeNull()
    expect(parsePeopleRequest({ q: '', ids: '' })).toBeNull()
    expect(parsePeopleRequest({ q: 'a'.repeat(65) })).toBeNull()
    expect(parsePeopleRequest({ q: ['a', 'b'] })).toBeNull()
    expect(parsePeopleRequest({ ids: ['a', 'b'] })).toBeNull()
    expect(parsePeopleRequest({ ids: 'a'.repeat(4097) })).toBeNull()
  })
})
