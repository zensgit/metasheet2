// @ts-nocheck
import { Router } from 'express'
import { recordFallback } from '../fallback/fallback-recorder'

const router = Router()

// Guard: only enable when explicitly allowed
router.use((req, res, next) => {
  const enabled = process.env.ENABLE_FALLBACK_TEST === 'true' || process.env.NODE_ENV !== 'production'
  if (!enabled) return res.status(404).json({ ok: false, error: 'Not enabled' })
  next()
})

// POST /fallback { mode }
// Mounted at /internal/test, so full path is /internal/test/fallback
router.post('/fallback', (req, res) => {
  const mode = (req.body?.mode as string) || 'unknown'
  switch (mode) {
    case 'http_error':
      recordFallback('http_error', true)
      return res.status(500).json({ ok: false, error: 'simulated http error' })
    case 'http_timeout':
      recordFallback('http_timeout', true)
      setTimeout(() => res.status(504).json({ ok: false, error: 'simulated timeout' }), 100)
      return
    case 'message_error':
      recordFallback('message_error', true)
      return res.status(502).json({ ok: false, error: 'simulated message bus error' })
    case 'message_timeout':
      recordFallback('message_timeout', true)
      setTimeout(() => res.status(504).json({ ok: false, error: 'simulated message timeout' }), 100)
      return
    case 'cache_miss':
      recordFallback('cache_miss', false)
      return res.status(200).json({ ok: true, note: 'simulated cache miss (raw only)' })
    case 'circuit_breaker':
      recordFallback('circuit_breaker', true)
      return res.status(503).json({ ok: false, error: 'simulated circuit breaker open' })
    case 'upstream_error':
      recordFallback('upstream_error', true)
      return res.status(502).json({ ok: false, error: 'simulated upstream error' })
    default:
      recordFallback('unknown', true)
      return res.status(520).json({ ok: false, error: 'unknown error simulated' })
  }
})

export default router
