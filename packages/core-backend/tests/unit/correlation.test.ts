import express from 'express'
import cors from 'cors'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { getCorrelationId, getRequestContext, runWithRequestContext } from '../../src/context/request-context'
import { correlationIdMiddleware, isValidCorrelationId, resolveCorrelationId } from '../../src/middleware/correlation'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function buildApp() {
  const app = express()
  app.use(correlationIdMiddleware)
  app.get('/probe', (req, res) => {
    res.json({
      reqCorrelationId: req.correlationId,
      alsCorrelationId: getCorrelationId(),
      context: getRequestContext()
    })
  })
  return app
}

describe('resolveCorrelationId', () => {
  it('accepts a well-formed header value', () => {
    expect(isValidCorrelationId('abc-123_XYZ')).toBe(true)
    expect(resolveCorrelationId('abc-123_XYZ')).toBe('abc-123_XYZ')
  })

  it('rejects empty strings, too-long values, and disallowed characters', () => {
    expect(isValidCorrelationId('')).toBe(false)
    expect(isValidCorrelationId('x'.repeat(129))).toBe(false)
    expect(isValidCorrelationId('has space')).toBe(false)
    expect(isValidCorrelationId('semi;colon')).toBe(false)
  })

  it('falls back to a UUID when header is missing or invalid', () => {
    expect(resolveCorrelationId(undefined)).toMatch(UUID_PATTERN)
    expect(resolveCorrelationId('bad value!')).toMatch(UUID_PATTERN)
    expect(resolveCorrelationId(['', 'second'])).toMatch(UUID_PATTERN)
  })
})

describe('request-context AsyncLocalStorage', () => {
  it('returns undefined outside a context', () => {
    expect(getCorrelationId()).toBeUndefined()
    expect(getRequestContext()).toBeUndefined()
  })

  it('exposes the correlation id inside a run() scope', () => {
    const id = runWithRequestContext({ correlationId: 'scope-id' }, () => getCorrelationId())
    expect(id).toBe('scope-id')
  })
})

describe('correlationIdMiddleware (express integration)', () => {
  it('generates a uuid when the header is missing and echoes it on the response', async () => {
    const app = buildApp()
    const res = await request(app).get('/probe')
    expect(res.status).toBe(200)
    expect(res.headers['x-correlation-id']).toMatch(UUID_PATTERN)
    expect(res.body.reqCorrelationId).toBe(res.headers['x-correlation-id'])
    expect(res.body.alsCorrelationId).toBe(res.headers['x-correlation-id'])
  })

  it('preserves a valid inbound X-Correlation-ID header', async () => {
    const app = buildApp()
    const res = await request(app).get('/probe').set('X-Correlation-ID', 'trace_abc-123')
    expect(res.headers['x-correlation-id']).toBe('trace_abc-123')
    expect(res.body.reqCorrelationId).toBe('trace_abc-123')
    expect(res.body.context.correlationId).toBe('trace_abc-123')
  })

  it('replaces an invalid inbound header with a generated uuid', async () => {
    const app = buildApp()
    const res = await request(app).get('/probe').set('X-Correlation-ID', 'not valid!')
    expect(res.headers['x-correlation-id']).toMatch(UUID_PATTERN)
    expect(res.body.reqCorrelationId).not.toBe('not valid!')
  })

  it('keeps each request isolated across concurrent invocations', async () => {
    const app = buildApp()
    const [a, b] = await Promise.all([
      request(app).get('/probe').set('X-Correlation-ID', 'aaa-111'),
      request(app).get('/probe').set('X-Correlation-ID', 'bbb-222')
    ])
    expect(a.headers['x-correlation-id']).toBe('aaa-111')
    expect(b.headers['x-correlation-id']).toBe('bbb-222')
    expect(a.body.alsCorrelationId).toBe('aaa-111')
    expect(b.body.alsCorrelationId).toBe('bbb-222')
  })

  it('can wrap CORS preflight responses when installed before cors()', async () => {
    const app = express()
    app.use(correlationIdMiddleware)
    app.use(cors())

    const res = await request(app)
      .options('/probe')
      .set('Origin', 'https://example.test')
      .set('Access-Control-Request-Method', 'GET')

    expect(res.headers['x-correlation-id']).toMatch(UUID_PATTERN)
  })
})
