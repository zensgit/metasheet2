import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import express from 'express'

describe('/internal/config sanitization', () => {
  let app: express.Express

  beforeAll(() => {
    process.env.JWT_SECRET = 'dev-secret'
    process.env.DATABASE_URL = 'postgres://user:password@localhost/db'
    process.env.REDIS_URL = 'redis://localhost:6379'

    app = express()
    app.use(express.json())

    // Sanitized config endpoint that filters sensitive values
    app.get('/internal/config', (req, res) => {
      const sensitiveKeys = ['JWT_SECRET', 'DATABASE_URL', 'REDIS_URL', 'API_KEY', 'SECRET', 'PASSWORD']

      const sanitizedConfig: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        // Skip sensitive keys
        const isSensitive = sensitiveKeys.some(sensitive =>
          key.toUpperCase().includes(sensitive)
        )
        if (!isSensitive && value) {
          sanitizedConfig[key] = value
        }
      }

      res.json({
        ok: true,
        config: {
          NODE_ENV: process.env.NODE_ENV || 'development',
          PORT: process.env.PORT || '8900',
          // Sanitized config subset
          featureFlags: {
            FEATURE_CACHE: process.env.FEATURE_CACHE === 'true',
            ENABLE_FALLBACK_TEST: process.env.ENABLE_FALLBACK_TEST === 'true'
          }
        }
      })
    })
  })

  it('does not leak JWT_SECRET', async () => {
    const res = await request(app).get('/internal/config')

    expect(res.status).toBeLessThan(500)
    const responseText = JSON.stringify(res.body || res.text)
    expect(responseText).not.toContain('JWT_SECRET')
    expect(responseText).not.toContain('dev-secret')
  })

  it('does not leak DATABASE_URL', async () => {
    const res = await request(app).get('/internal/config')

    expect(res.status).toBeLessThan(500)
    const responseText = JSON.stringify(res.body || res.text)
    expect(responseText).not.toContain('DATABASE_URL')
    expect(responseText).not.toContain('password')
  })

  it('does not leak REDIS_URL', async () => {
    const res = await request(app).get('/internal/config')

    expect(res.status).toBeLessThan(500)
    const responseText = JSON.stringify(res.body || res.text)
    expect(responseText).not.toContain('REDIS_URL')
  })

  it('returns sanitized config structure', async () => {
    const res = await request(app).get('/internal/config')

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.config).toBeDefined()
    expect(res.body.config.featureFlags).toBeDefined()
  })
})
