import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createMetricsAuthMiddleware, resolveMetricsScrapeToken } from '../../src/metrics/metrics'

describe('metrics auth middleware', () => {
  afterEach(() => {
    delete process.env.METRICS_SCRAPE_TOKEN
  })

  it('returns null when METRICS_SCRAPE_TOKEN is unset or blank', () => {
    delete process.env.METRICS_SCRAPE_TOKEN
    expect(resolveMetricsScrapeToken()).toBeNull()

    process.env.METRICS_SCRAPE_TOKEN = '   '
    expect(resolveMetricsScrapeToken()).toBeNull()
  })

  it('allows anonymous access when no metrics token is configured', async () => {
    const app = express()
    app.get('/metrics/prom', createMetricsAuthMiddleware(() => null), (_req, res) => {
      res.type('text/plain').send('metric_a 1\n')
    })

    const res = await request(app).get('/metrics/prom')
    expect(res.status).toBe(200)
    expect(res.text).toContain('metric_a 1')
  })

  it('rejects requests without the configured bearer token', async () => {
    const app = express()
    app.get('/metrics/prom', createMetricsAuthMiddleware(() => 'secret-token'), (_req, res) => {
      res.type('text/plain').send('metric_a 1\n')
    })

    const res = await request(app).get('/metrics/prom')
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toContain('Bearer')
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Metrics scrape token required',
      },
    })
  })

  it('accepts a matching bearer token', async () => {
    const app = express()
    app.get('/metrics/prom', createMetricsAuthMiddleware(() => 'secret-token'), (_req, res) => {
      res.type('text/plain').send('metric_a 1\n')
    })

    const res = await request(app)
      .get('/metrics/prom')
      .set('Authorization', 'Bearer secret-token')

    expect(res.status).toBe(200)
    expect(res.text).toContain('metric_a 1')
  })

  it('accepts the x-metrics-token header for non-Prometheus callers', async () => {
    const app = express()
    app.get('/metrics', createMetricsAuthMiddleware(() => 'secret-token'), (_req, res) => {
      res.json({ ok: true })
    })

    const res = await request(app)
      .get('/metrics')
      .set('x-metrics-token', 'secret-token')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
