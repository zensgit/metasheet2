import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import fallbackTestRouter from '../fallback-test'

describe('fallback-test routes', () => {
  let app: express.Application

  beforeAll(() => {
    // Enable the route for testing
    process.env.ENABLE_FALLBACK_TEST = 'true'
    process.env.NODE_ENV = 'test'

    app = express()
    app.use(express.json())
    // Mount at /internal/test to match production mounting
    app.use('/internal/test', fallbackTestRouter)
  })

  afterAll(() => {
    delete process.env.ENABLE_FALLBACK_TEST
  })

  describe('POST /internal/test/fallback', () => {
    it('should be accessible at /internal/test/fallback (not /internal/test/internal/test/fallback)', async () => {
      const res = await request(app)
        .post('/internal/test/fallback')
        .send({ mode: 'cache_miss' })

      // Should get 200 for cache_miss mode
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
    })

    it('should return 500 for http_error mode', async () => {
      const res = await request(app)
        .post('/internal/test/fallback')
        .send({ mode: 'http_error' })

      expect(res.status).toBe(500)
      expect(res.body.ok).toBe(false)
      expect(res.body.error).toBe('simulated http error')
    })

    it('should return 504 for http_timeout mode', async () => {
      const res = await request(app)
        .post('/internal/test/fallback')
        .send({ mode: 'http_timeout' })

      expect(res.status).toBe(504)
      expect(res.body.ok).toBe(false)
    })

    it('should return 502 for message_error mode', async () => {
      const res = await request(app)
        .post('/internal/test/fallback')
        .send({ mode: 'message_error' })

      expect(res.status).toBe(502)
      expect(res.body.ok).toBe(false)
    })

    it('should return 503 for circuit_breaker mode', async () => {
      const res = await request(app)
        .post('/internal/test/fallback')
        .send({ mode: 'circuit_breaker' })

      expect(res.status).toBe(503)
      expect(res.body.ok).toBe(false)
    })

    it('should return 502 for upstream_error mode', async () => {
      const res = await request(app)
        .post('/internal/test/fallback')
        .send({ mode: 'upstream_error' })

      expect(res.status).toBe(502)
      expect(res.body.ok).toBe(false)
    })

    it('should return 520 for unknown mode', async () => {
      const res = await request(app)
        .post('/internal/test/fallback')
        .send({ mode: 'some_random_mode' })

      expect(res.status).toBe(520)
      expect(res.body.ok).toBe(false)
    })

    it('should default to unknown mode when no mode provided', async () => {
      const res = await request(app)
        .post('/internal/test/fallback')
        .send({})

      expect(res.status).toBe(520)
      expect(res.body.error).toBe('unknown error simulated')
    })
  })

  describe('route path regression test', () => {
    it('should NOT be accessible at double-nested path', async () => {
      const res = await request(app)
        .post('/internal/test/internal/test/fallback')
        .send({ mode: 'cache_miss' })

      // This path should not exist
      expect(res.status).toBe(404)
    })
  })
})
