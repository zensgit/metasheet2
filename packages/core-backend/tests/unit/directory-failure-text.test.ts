/**
 * R-41 — directory/directory-failure-text.ts: the one mapping from a caught value to the text an admin surface
 * (any HTTP status) or a persisted / outbound failure text may carry. Every branch is pinned here; the routes
 * and the persistence paths that use it are probed end-to-end in admin-directory-5xx-values-free.test.ts,
 * directory-sync-failure-text.test.ts and directory-batch-failure-text-route.test.ts.
 *
 * Markers are obviously fake (`MARKER_r41_…`) and the addresses are documentation ranges (192.0.2.0/24,
 * 203.0.113.0/24): they stand in for egress IPs, hosts, ports, request ids and SQL fragments.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyDirectoryFailureText,
  type FixedSentenceErrorClass,
} from '../../src/directory/directory-failure-text'
import {
  DingTalkBusinessError,
  DingTalkIncompleteResponseError,
  DingTalkMalformedResponseError,
  DingTalkRequestError,
  DingTalkTimeoutError,
} from '../../src/integrations/dingtalk/transport'
import { DingTalkConfigValidationError } from '../../src/integrations/dingtalk/config-validation-error'

const MARKER = 'MARKER_r41_cls'
const PROVIDER_TEXT = `${MARKER} egress 203.0.113.7:443 request-id 0f0f select * from users`
const FALLBACK = 'Failed to do the thing'

class SentenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SentenceError'
  }
}
class SubSentenceError extends SentenceError {}

const classify = (error: unknown, fixedSentenceClasses?: readonly FixedSentenceErrorClass[]) =>
  classifyDirectoryFailureText(error, { fallback: FALLBACK, fixedSentenceClasses })

describe('classifyDirectoryFailureText — fixed-sentence classes (R-41 rule 3)', () => {
  it('returns the message of an instance of a listed class, kind fixed_sentence', () => {
    expect(classify(new SentenceError('integrationId is required'), [SentenceError])).toEqual({
      kind: 'fixed_sentence',
      text: 'integrationId is required',
    })
  })

  it('matches subclasses of a listed class (instanceof)', () => {
    expect(classify(new SubSentenceError('appKey is required'), [SentenceError]).text).toBe('appKey is required')
  })

  it('falls back when the typed message is empty or blank', () => {
    expect(classify(new SentenceError(''), [SentenceError])).toEqual({ kind: 'fallback', text: FALLBACK })
    expect(classify(new SentenceError('   '), [SentenceError])).toEqual({ kind: 'fallback', text: FALLBACK })
  })

  it('does not show the sentence of a class that is NOT listed — the list is the whole allowance', () => {
    expect(classify(new SentenceError('integrationId is required'))).toEqual({ kind: 'fallback', text: FALLBACK })
    expect(classify(new SentenceError('integrationId is required'), [DingTalkConfigValidationError])).toEqual({ kind: 'fallback', text: FALLBACK })
  })

  it('is decided by the class, not by the name or the prose: a plain Error named like the class is the fallback', () => {
    const spoof = Object.assign(new Error(PROVIDER_TEXT), { name: 'SentenceError' })
    expect(classify(spoof, [SentenceError])).toEqual({ kind: 'fallback', text: FALLBACK })
  })

  it('tolerates a missing class in the list (a module factory left it undefined) instead of throwing', () => {
    const list = [undefined, SentenceError] as unknown as FixedSentenceErrorClass[]
    expect(classify(new SentenceError('appSecret is required'), list).text).toBe('appSecret is required')
    expect(classify(new Error(PROVIDER_TEXT), list)).toEqual({ kind: 'fallback', text: FALLBACK })
  })

  it('a listed class wins over the DingTalk branches (the caller decides what is a sentence)', () => {
    class ListedBusiness extends DingTalkBusinessError {}
    const error = new ListedBusiness('a developer sentence', { errcode: 1 })
    expect(classify(error, [ListedBusiness]).text).toBe('a developer sentence')
  })
})

describe('classifyDirectoryFailureText — typed DingTalk failures: fixed sentence + numeric code only', () => {
  it('DingTalkBusinessError → errcode, never errmsg / message / body', () => {
    const error = new DingTalkBusinessError(PROVIDER_TEXT, { errcode: 40089, errmsg: PROVIDER_TEXT, request_id: PROVIDER_TEXT })
    expect(classify(error)).toEqual({
      kind: 'provider',
      text: `${FALLBACK}: DingTalk rejected the request (errcode 40089)`,
      providerCode: 40089,
      providerCodeKind: 'errcode',
    })
  })

  it('DingTalkBusinessError reads a numeric-string errcode and the `code` alias', () => {
    expect(classify(new DingTalkBusinessError(PROVIDER_TEXT, { errcode: '60011', errmsg: PROVIDER_TEXT })).providerCode).toBe(60011)
    expect(classify(new DingTalkBusinessError(PROVIDER_TEXT, { code: -1, msg: PROVIDER_TEXT })).text)
      .toBe(`${FALLBACK}: DingTalk rejected the request (errcode -1)`)
  })

  it('DingTalkBusinessError without a usable numeric code → the sentence without a code', () => {
    for (const body of [null, {}, { errcode: PROVIDER_TEXT }, { code: 'Forbidden.AccessDenied' }, { errcode: 1e21 }, { errcode: 1.5 }]) {
      const result = classify(new DingTalkBusinessError(PROVIDER_TEXT, body as Record<string, unknown> | null))
      expect(result).toEqual({ kind: 'provider', text: `${FALLBACK}: DingTalk rejected the request` })
    }
  })

  it('DingTalkRequestError → HTTP status only', () => {
    const error = new DingTalkRequestError(PROVIDER_TEXT, 503, { message: PROVIDER_TEXT, code: PROVIDER_TEXT })
    expect(classify(error)).toEqual({
      kind: 'provider',
      text: `${FALLBACK}: DingTalk answered with an error status (HTTP 503)`,
      providerCode: 503,
      providerCodeKind: 'http_status',
    })
    const odd = new DingTalkRequestError(PROVIDER_TEXT, Number.NaN, null)
    expect(classify(odd)).toEqual({ kind: 'provider', text: `${FALLBACK}: DingTalk answered with an error status` })
  })

  it('DingTalkIncompleteResponseError → its envelope code (errcode 0 is reported as such), never its message', () => {
    expect(classify(new DingTalkIncompleteResponseError(PROVIDER_TEXT, { errcode: 0, errmsg: 'ok', message: PROVIDER_TEXT }))).toEqual({
      kind: 'provider',
      text: `${FALLBACK}: DingTalk returned a response without the expected data (errcode 0)`,
      providerCode: 0,
      providerCodeKind: 'errcode',
    })
    expect(classify(new DingTalkIncompleteResponseError(PROVIDER_TEXT, { message: PROVIDER_TEXT }))).toEqual({
      kind: 'provider',
      text: `${FALLBACK}: DingTalk returned a response without the expected data`,
    })
  })

  it('DingTalkMalformedResponseError → HTTP status only', () => {
    expect(classify(new DingTalkMalformedResponseError('missing_errcode', 200, PROVIDER_TEXT))).toEqual({
      kind: 'provider',
      text: `${FALLBACK}: DingTalk returned an unusable response (HTTP 200)`,
      providerCode: 200,
      providerCodeKind: 'http_status',
    })
  })

  it('DingTalkTimeoutError → a fixed sentence, no number', () => {
    expect(classify(new DingTalkTimeoutError(10_000))).toEqual({ kind: 'provider', text: `${FALLBACK}: DingTalk did not answer in time` })
  })
})

describe('classifyDirectoryFailureText — anything else is the caller\'s fixed sentence (R-41 rule 2)', () => {
  const unknowns: Array<[string, unknown]> = [
    ['plain Error', new Error(PROVIDER_TEXT)],
    ['driver-shaped error (detail / hint / where / code)', Object.assign(new Error(PROVIDER_TEXT), {
      code: '42P01', detail: PROVIDER_TEXT, hint: PROVIDER_TEXT, where: PROVIDER_TEXT, table: PROVIDER_TEXT,
    })],
    ['network error with a cause naming the peer', Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(`connect ECONNREFUSED ${PROVIDER_TEXT}`), { code: 'ECONNREFUSED', address: '203.0.113.7', port: 443 }),
    })],
    ['error with the marker only in its stack', Object.assign(new Error('boom'), { stack: `Error: boom\n    at ${PROVIDER_TEXT}` })],
    ['error carrying responseBody but no DingTalk type', Object.assign(new Error(PROVIDER_TEXT), { responseBody: { errcode: 1, errmsg: PROVIDER_TEXT } })],
    ['a string', PROVIDER_TEXT],
    ['an object with a message', { message: PROVIDER_TEXT, errcode: 40089 }],
    ['null', null],
    ['undefined', undefined],
    ['a number', 40089],
  ]
  for (const [label, value] of unknowns) {
    it(`${label} → the fallback, with none of its text`, () => {
      const result = classify(value, [SentenceError, DingTalkConfigValidationError])
      expect(result).toEqual({ kind: 'fallback', text: FALLBACK })
      expect(JSON.stringify(result)).not.toContain(MARKER)
      expect(JSON.stringify(result)).not.toContain('203.0.113')
    })
  }

  it('no non-fixed input ever yields the marker, whatever the shape (sweep)', () => {
    const shapes: unknown[] = [
      ...unknowns.map(([, value]) => value),
      new DingTalkBusinessError(PROVIDER_TEXT, { errcode: 1, errmsg: PROVIDER_TEXT }),
      new DingTalkRequestError(PROVIDER_TEXT, 500, { message: PROVIDER_TEXT }),
      new DingTalkIncompleteResponseError(PROVIDER_TEXT, { message: PROVIDER_TEXT }),
      new DingTalkMalformedResponseError('unparseable_body', 502, PROVIDER_TEXT),
      Object.assign(new DingTalkTimeoutError(1), { detail: PROVIDER_TEXT }),
    ]
    for (const shape of shapes) {
      const result = classify(shape)
      expect(result.kind).not.toBe('fixed_sentence')
      expect(result.text.startsWith(FALLBACK)).toBe(true)
      expect(JSON.stringify(result)).not.toContain(MARKER)
    }
  })
})
