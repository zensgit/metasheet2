/**
 * Integration-style smoke: boots the correlation middleware inside a small
 * express app (supertest) and verifies the header contract end-to-end. A full
 * `MetaSheetServer` bootstrap is not required for this contract — the
 * middleware is the only surface being exercised.
 */

import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { correlationIdMiddleware } from '../../src/middleware/correlation'
import { getCorrelationId } from '../../src/context/request-context'

describe('correlation-id header integration', () => {
  const app = express()
  app.use(correlationIdMiddleware)
  app.get('/echo', (_req, res) => {
    res.json({ correlationId: getCorrelationId() })
  })

  it('generates a correlation id when the caller did not supply one', async () => {
    const res = await request(app).get('/echo')
    expect(res.status).toBe(200)
    expect(res.headers['x-correlation-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(res.body.correlationId).toBe(res.headers['x-correlation-id'])
  })

  it('echoes a valid inbound X-Correlation-ID back to the client', async () => {
    const res = await request(app).get('/echo').set('X-Correlation-ID', 'end-to-end_42')
    expect(res.headers['x-correlation-id']).toBe('end-to-end_42')
    expect(res.body.correlationId).toBe('end-to-end_42')
  })
})
