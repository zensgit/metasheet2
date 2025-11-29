import { describe, it, expect, beforeEach } from 'vitest'
import request from 'supertest'
import express, { Request, Response, NextFunction } from 'express'

describe('Production Guards', () => {
  let app: express.Express

  beforeEach(() => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_UNSAFE_ADMIN = 'false'
    process.env.ENABLE_FALLBACK_TEST = 'false'

    app = express()
    app.use(express.json())

    // Production guard middleware for fallback test routes
    const fallbackTestGuard = (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV === 'production' && process.env.ENABLE_FALLBACK_TEST !== 'true') {
        if (req.path.includes('/internal/test/fallback')) {
          return res.status(404).json({ error: 'Not found' })
        }
      }
      next()
    }

    app.use(fallbackTestGuard)

    // Mock fallback test route
    app.post('/internal/test/fallback', (req, res) => {
      res.status(200).json({ ok: true, mode: req.body.mode })
    })
  })

  it('hides fallback test route in production when disabled', async () => {
    const res = await request(app)
      .post('/internal/test/fallback')
      .send({ mode: 'http_error' })

    expect(res.status).toBe(404)
  })

  it('allows fallback test route when ENABLE_FALLBACK_TEST=true', async () => {
    process.env.ENABLE_FALLBACK_TEST = 'true'

    // Recreate app with new env
    app = express()
    app.use(express.json())

    const fallbackTestGuard = (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV === 'production' && process.env.ENABLE_FALLBACK_TEST !== 'true') {
        if (req.path.includes('/internal/test/fallback')) {
          return res.status(404).json({ error: 'Not found' })
        }
      }
      next()
    }

    app.use(fallbackTestGuard)
    app.post('/internal/test/fallback', (req, res) => {
      res.status(200).json({ ok: true, mode: req.body.mode })
    })

    const res = await request(app)
      .post('/internal/test/fallback')
      .send({ mode: 'http_error' })

    expect(res.status).toBe(200)
    expect(res.body.mode).toBe('http_error')
  })

  it('allows fallback test route in non-production environments', async () => {
    process.env.NODE_ENV = 'development'

    // Recreate app with new env
    app = express()
    app.use(express.json())

    const fallbackTestGuard = (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV === 'production' && process.env.ENABLE_FALLBACK_TEST !== 'true') {
        if (req.path.includes('/internal/test/fallback')) {
          return res.status(404).json({ error: 'Not found' })
        }
      }
      next()
    }

    app.use(fallbackTestGuard)
    app.post('/internal/test/fallback', (req, res) => {
      res.status(200).json({ ok: true, mode: req.body.mode })
    })

    const res = await request(app)
      .post('/internal/test/fallback')
      .send({ mode: 'http_error' })

    expect(res.status).toBe(200)
  })
})
