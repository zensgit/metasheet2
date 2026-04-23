/**
 * /metrics endpoint smoke test.
 *
 * We build a throw-away Registry + Counter and an ad-hoc Express route
 * handler that matches the pattern used by `installMetrics()` in
 * `src/metrics/metrics.ts`.  The production module is NOT imported
 * because it has heavy side-effects (collectDefaultMetrics + ~60 metric
 * registrations) and a singleton registry we do not want polluted in
 * unit runs — the assertion here is the wiring contract (status,
 * content-type, body contains metric name), not the specific metrics
 * set.
 */

import express from 'express'
import client from 'prom-client'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

describe('/metrics endpoint — Prometheus text exposition smoke test', () => {
  it('returns 200 with text/plain body containing the registered metric name', async () => {
    const registry = new client.Registry()
    const counter = new client.Counter({
      name: 'metrics_endpoint_smoke_total',
      help: 'Throwaway counter for /metrics endpoint smoke test',
      labelNames: ['label'] as const,
      registers: [registry],
    })
    counter.labels('a').inc()
    counter.labels('a').inc()
    counter.labels('b').inc(3)

    const app = express()
    app.get('/metrics', async (_req, res) => {
      res.set('Content-Type', registry.contentType)
      res.end(await registry.metrics())
    })

    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    // prom-client's contentType looks like:
    //   'text/plain; version=0.0.4; charset=utf-8'
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.headers['content-type']).toContain('version=0.0.4')
    expect(res.text).toContain('metrics_endpoint_smoke_total')
    expect(res.text).toContain('metrics_endpoint_smoke_total{label="a"} 2')
    expect(res.text).toContain('metrics_endpoint_smoke_total{label="b"} 3')
  })

  it('multiple registries via DI stay isolated', async () => {
    const registryA = new client.Registry()
    const registryB = new client.Registry()
    new client.Counter({
      name: 'alpha_only_total',
      help: 'appears only in registry A',
      registers: [registryA],
    }).inc()
    new client.Counter({
      name: 'beta_only_total',
      help: 'appears only in registry B',
      registers: [registryB],
    }).inc()

    const app = express()
    app.get('/metrics/a', async (_req, res) => {
      res.set('Content-Type', registryA.contentType)
      res.end(await registryA.metrics())
    })
    app.get('/metrics/b', async (_req, res) => {
      res.set('Content-Type', registryB.contentType)
      res.end(await registryB.metrics())
    })

    const a = await request(app).get('/metrics/a')
    const b = await request(app).get('/metrics/b')
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(a.text).toContain('alpha_only_total 1')
    expect(a.text).not.toContain('beta_only_total')
    expect(b.text).toContain('beta_only_total 1')
    expect(b.text).not.toContain('alpha_only_total')
  })
})
