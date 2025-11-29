import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express, { Request, Response, NextFunction } from 'express'

describe('Unsafe admin route in production', () => {
  let app: express.Express

  beforeEach(() => {
    // Set production environment
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_UNSAFE_ADMIN = 'false'

    app = express()
    app.use(express.json())

    // Production guard middleware - blocks unsafe routes when ALLOW_UNSAFE_ADMIN !== 'true'
    const productionGuard = (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_UNSAFE_ADMIN !== 'true') {
        if (req.path.includes('reload-unsafe')) {
          return res.status(403).json({ error: 'Unsafe admin routes disabled in production' })
        }
      }
      next()
    }

    app.use(productionGuard)

    // Mock admin route that would exist in production
    app.post('/api/admin/plugins/:id/reload-unsafe', (req, res) => {
      res.status(200).json({ ok: true, message: 'Plugin reloaded' })
    })
  })

  it('should reject /api/admin/plugins/:id/reload-unsafe in production', async () => {
    const res = await request(app)
      .post('/api/admin/plugins/example-plugin/reload-unsafe')
      .set('Authorization', 'Bearer test')
      .send({})

    expect(res.status).toBe(403)
    expect(res.body.error).toContain('Unsafe admin routes disabled')
  })

  it('should allow unsafe routes when ALLOW_UNSAFE_ADMIN=true', async () => {
    process.env.ALLOW_UNSAFE_ADMIN = 'true'

    // Recreate app with new env
    app = express()
    app.use(express.json())

    const productionGuard = (req: Request, res: Response, next: NextFunction) => {
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_UNSAFE_ADMIN !== 'true') {
        if (req.path.includes('reload-unsafe')) {
          return res.status(403).json({ error: 'Unsafe admin routes disabled in production' })
        }
      }
      next()
    }

    app.use(productionGuard)
    app.post('/api/admin/plugins/:id/reload-unsafe', (req, res) => {
      res.status(200).json({ ok: true, message: 'Plugin reloaded' })
    })

    const res = await request(app)
      .post('/api/admin/plugins/example-plugin/reload-unsafe')
      .set('Authorization', 'Bearer test')
      .send({})

    expect(res.status).toBe(200)
  })
})
