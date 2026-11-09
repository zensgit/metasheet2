import { describe, expect, it } from 'vitest'
import {
  isDispatchKey,
  isTaskSourceRef,
  isValidSourceId,
  parseTaskSourceInput,
  TASK_SOURCE_ID_MAX_LENGTH,
} from '../../src/tasks/task-source-links'

const SOURCE = { sheetId: 'sht_1', recordId: 'rec_1' }
const KEY = '9d4c1b7e-2f3a-4c5d-8e6f-0a1b2c3d4e5f'

describe('task source ids', () => {
  it('accepts the member-id shape that is also a plain path segment', () => {
    for (const id of ['sht_1', 'rec_0f8e2c4a-6b1d-4e3f-9a7c-5d2b8e1f0a63', 'a', '...', 'x'.repeat(TASK_SOURCE_ID_MAX_LENGTH)]) {
      expect(isValidSourceId(id), id).toBe(true)
    }
  })

  it('refuses empty, too long, dot and dot-dot, non-printable and every path-segment breaker', () => {
    const refused: unknown[] = [
      '', 'x'.repeat(TASK_SOURCE_ID_MAX_LENGTH + 1), '.', '..', 'a b', 'a\u0000b', 'a\tb', '记录',
      'a/b', 'a?b', 'a#b', 'a%2F', 'a\\b', 7, null, undefined, {},
    ]
    for (const id of refused) expect(isValidSourceId(id), JSON.stringify(id)).toBe(false)
  })
})

describe('dispatch keys', () => {
  it('accepts 8..64 characters of [A-Za-z0-9_-], a uuid included', () => {
    for (const key of [KEY, 'abcdefgh', 'A_b-C_d-', 'k'.repeat(64)]) expect(isDispatchKey(key), key).toBe(true)
  })

  it('refuses anything else', () => {
    for (const key of ['abcdefg', 'k'.repeat(65), 'abc defgh', 'abcdefgh!', `${KEY}\n`, 12345678, null, undefined]) {
      expect(isDispatchKey(key), JSON.stringify(key)).toBe(false)
    }
  })
})

describe('parseTaskSourceInput', () => {
  it('a body without either key parses to nothing', () => {
    expect(parseTaskSourceInput({})).toEqual({ ok: true, source: null, dispatchKey: null })
    expect(parseTaskSourceInput({ source: undefined, dispatchKey: undefined })).toEqual({ ok: true, source: null, dispatchKey: null })
  })

  it('a source alone, with and without view and base; omitted and null optional ids are null', () => {
    expect(parseTaskSourceInput({ source: SOURCE })).toEqual({
      ok: true, source: { ...SOURCE, viewId: null, baseId: null }, dispatchKey: null,
    })
    expect(parseTaskSourceInput({ source: { ...SOURCE, viewId: null, baseId: null } })).toEqual({
      ok: true, source: { ...SOURCE, viewId: null, baseId: null }, dispatchKey: null,
    })
    expect(parseTaskSourceInput({ source: { ...SOURCE, viewId: 'viw_1', baseId: 'bas_1', extra: 'ignored' }, dispatchKey: KEY })).toEqual({
      ok: true, source: { ...SOURCE, viewId: 'viw_1', baseId: 'bas_1' }, dispatchKey: KEY,
    })
  })

  it('a malformed source is invalid_source, whatever the key', () => {
    const sources: unknown[] = [
      null, 'sht_1', 7, [SOURCE], {}, { sheetId: 'sht_1' }, { recordId: 'rec_1' },
      { sheetId: '..', recordId: 'rec_1' }, { sheetId: 'sht_1', recordId: 'rec/1' },
      { ...SOURCE, viewId: 'viw#1' }, { ...SOURCE, baseId: '' }, { ...SOURCE, viewId: 3 },
    ]
    for (const source of sources) {
      for (const dispatchKey of [undefined, KEY, 'bad']) {
        expect(parseTaskSourceInput({ source, dispatchKey }), JSON.stringify({ source, dispatchKey })).toEqual({ ok: false, reason: 'invalid_source' })
      }
    }
  })

  it('a key without a source, or of another shape, is invalid_dispatch_key', () => {
    expect(parseTaskSourceInput({ dispatchKey: KEY })).toEqual({ ok: false, reason: 'invalid_dispatch_key' })
    for (const dispatchKey of [null, '', 'short', 12345678, `${KEY} `]) {
      expect(parseTaskSourceInput({ source: SOURCE, dispatchKey }), JSON.stringify(dispatchKey)).toEqual({ ok: false, reason: 'invalid_dispatch_key' })
    }
  })

  it('isTaskSourceRef holds for every parsed source and refuses a malformed one', () => {
    const parsed = parseTaskSourceInput({ source: { ...SOURCE, viewId: 'viw_1' } })
    expect(parsed.ok && isTaskSourceRef(parsed.source)).toBe(true)
    for (const value of [null, 'x', { ...SOURCE }, { ...SOURCE, viewId: 'a/b', baseId: null }, { ...SOURCE, viewId: null, baseId: '..' }]) {
      expect(isTaskSourceRef(value), JSON.stringify(value)).toBe(false)
    }
  })
})
