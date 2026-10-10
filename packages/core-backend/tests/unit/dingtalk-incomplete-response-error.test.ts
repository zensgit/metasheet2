/**
 * R-41 follow-up (log hygiene) — DingTalkIncompleteResponseError keeps the 2xx body it was thrown with, and the
 * body of `contact/users/me` can carry the user's profile fields. `responseBody` is therefore NON-enumerable:
 * still readable as `error.responseBody` (the admin-surface classifier reads its errcode), but never written by
 * JSON.stringify or by the real Logger serialising `{ error }` object meta.
 *
 * The positive control logs a DingTalkBusinessError carrying the same body through the same Logger: its
 * `responseBody` is an own enumerable field and DOES reach the log line — proof the probe can see such a field
 * (and the pre-existing classes' follow-up, left out of this change on purpose).
 */
import { PassThrough } from 'node:stream'
import winston from 'winston'
import { describe, expect, it } from 'vitest'
import { Logger } from '../../src/core/logger'
import { DingTalkBusinessError, DingTalkIncompleteResponseError } from '../../src/integrations/dingtalk/transport'

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

describe('DingTalkIncompleteResponseError.responseBody is readable but never serialised', () => {
  it('is readable, read-only and not enumerable', () => {
    const error = new DingTalkIncompleteResponseError('Failed to resolve DingTalk openId', profileBody())
    expect(error.responseBody).toMatchObject({ errcode: 0, nick: `${PROFILE_MARKER}_nick` })
    expect(Object.keys(error)).not.toContain('responseBody')
    expect(Object.getOwnPropertyDescriptor(error, 'responseBody')).toMatchObject({ enumerable: false, writable: false })
  })

  it('JSON.stringify(error) and a spread copy do not carry the profile', () => {
    const error = new DingTalkIncompleteResponseError('Failed to resolve DingTalk openId', profileBody())
    expect(JSON.stringify(error)).not.toContain(PROFILE_MARKER)
    expect(JSON.stringify({ error })).not.toContain(PROFILE_MARKER)
    expect(JSON.stringify({ ...error })).not.toContain(PROFILE_MARKER)
  })

  it('the real Logger\'s `{ error }` object-meta form does not write the profile (both line formats)', async () => {
    const { logger, flush } = captureLogger()
    const error = new DingTalkIncompleteResponseError('Failed to resolve DingTalk openId', profileBody())
    logger.warn('R41 incomplete probe', { error })
    logger.warn('R41 incomplete probe nested', { failure: { error } })
    const output = await flush()
    expect(output).toContain('R41 incomplete probe')
    expect(output).toContain('DingTalkIncompleteResponseError')
    expect(output).not.toContain(PROFILE_MARKER)
  })

  it('positive control: a DingTalkBusinessError with the same body does reach the log line (pre-existing class, follow-up)', async () => {
    const { logger, flush } = captureLogger()
    logger.warn('R41 business probe', { error: new DingTalkBusinessError('rejected', profileBody()) })
    expect(await flush()).toContain(PROFILE_MARKER)
  })
})
