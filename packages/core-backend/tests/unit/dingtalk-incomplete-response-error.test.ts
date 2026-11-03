/**
 * R-41 follow-up (log hygiene) — the DingTalk errors that carry a provider body keep it NON-enumerable.
 *
 * DingTalkIncompleteResponseError keeps the 2xx body it was thrown with (the body of `contact/users/me` can carry
 * the user's profile fields); DingTalkBusinessError and DingTalkRequestError keep the oapi / v1.0 body of a
 * rejection (errmsg, request ids, whatever the provider echoed). On all three `responseBody` is still readable as
 * `error.responseBody` (the admin-surface classifier reads its errcode, the retry / ledger classifiers and the
 * person-delivery ledger read it explicitly) but is never written by JSON.stringify, by a `{ ...error }` copy or
 * by the real Logger serialising `{ error }` object meta.
 *
 * The positive control logs an Error carrying the same body as an ordinary own ENUMERABLE field through the same
 * Logger: it DOES reach the log line — proof the probe can see such a field, so the negative results above it
 * mean something.
 */
import { PassThrough } from 'node:stream'
import winston from 'winston'
import { describe, expect, it } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  DingTalkBusinessError,
  DingTalkIncompleteResponseError,
  DingTalkRequestError,
} from '../../src/integrations/dingtalk/transport'

const PROFILE_MARKER = 'MARKER_r41_profile'
const profileBody = () => ({
  errcode: 0,
  nick: `${PROFILE_MARKER}_nick`,
  email: `${PROFILE_MARKER}@example.com`,
  mobile: `${PROFILE_MARKER}_mobile`,
  unionId: `${PROFILE_MARKER}_union`,
})

/** A real Logger with two capturing transports: the logger-level JSON line and the console (simple) line. */
function captureLogger(): { logger: Logger; flush: () => Promise<string> } {
  const logger = new Logger('R41ProfileProbe')
  const inner = (logger as unknown as { winston: winston.Logger }).winston
  for (const transport of [...inner.transports]) inner.remove(transport)
  const chunks: string[] = []
  const jsonStream = new PassThrough()
  const simpleStream = new PassThrough()
  jsonStream.on('data', (chunk) => chunks.push(String(chunk)))
  simpleStream.on('data', (chunk) => chunks.push(String(chunk)))
  inner.add(new winston.transports.Stream({ stream: jsonStream, level: 'debug' }))
  inner.add(new winston.transports.Stream({ stream: simpleStream, level: 'debug', format: winston.format.simple() }))
  return {
    logger,
    flush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return chunks.join('')
    },
  }
}

/** Each class that carries a provider body, built the way the transport / client build it. */
const BODY_CARRIERS: ReadonlyArray<{ name: string; make: () => Error & { responseBody: unknown } }> = [
  { name: 'DingTalkIncompleteResponseError', make: () => new DingTalkIncompleteResponseError('Failed to resolve DingTalk openId', profileBody()) },
  { name: 'DingTalkBusinessError', make: () => new DingTalkBusinessError('rejected', profileBody()) },
  { name: 'DingTalkRequestError', make: () => new DingTalkRequestError('bad request', 400, profileBody()) },
]

describe.each(BODY_CARRIERS)('$name: responseBody is readable but never serialised', ({ name, make }) => {
  it('is readable, read-only and not enumerable', () => {
    const error = make()
    expect(error.responseBody).toMatchObject({ errcode: 0, nick: `${PROFILE_MARKER}_nick` })
    expect('responseBody' in error).toBe(true)
    expect(Object.keys(error)).not.toContain('responseBody')
    expect(Object.getOwnPropertyDescriptor(error, 'responseBody')).toMatchObject({ enumerable: false, writable: false })
    // Matchers that callers' tests use still see it (own property, read by name).
    expect(error).toMatchObject({ responseBody: expect.objectContaining({ errcode: 0 }) })
  })

  it('JSON.stringify(error) and a spread copy do not carry the body', () => {
    const error = make()
    expect(JSON.stringify(error)).not.toContain(PROFILE_MARKER)
    expect(JSON.stringify({ error })).not.toContain(PROFILE_MARKER)
    expect(JSON.stringify({ ...error })).not.toContain(PROFILE_MARKER)
    expect(JSON.stringify(Object.assign({}, error))).not.toContain(PROFILE_MARKER)
  })

  it('the real Logger\'s `{ error }` object-meta form does not write the body (both line formats)', async () => {
    const { logger, flush } = captureLogger()
    const error = make()
    logger.warn('R41 body probe', { error })
    logger.warn('R41 body probe nested', { failure: { error } })
    const output = await flush()
    expect(output).toContain('R41 body probe')
    expect(output).toContain(name)
    expect(output).not.toContain(PROFILE_MARKER)
  })
})

describe('the probe can see an enumerable body', () => {
  it('positive control: an Error carrying the same body as an own enumerable field does reach the log line', async () => {
    const { logger, flush } = captureLogger()
    logger.warn('R41 enumerable probe', { error: Object.assign(new Error('rejected'), { responseBody: profileBody() }) })
    expect(await flush()).toContain(PROFILE_MARKER)
  })

  it('positive control: the same enumerable field is written by JSON.stringify', () => {
    expect(JSON.stringify(Object.assign(new Error('rejected'), { responseBody: profileBody() }))).toContain(PROFILE_MARKER)
  })
})
