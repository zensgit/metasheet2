/**
 * PLM-COLLAB-P3-D2: authenticate an embed request by its `X-PLM-Embed-Token` header (a Yuantus
 * EdDSA embed JWT), verified OFFLINE with the Yuantus public key. A custom header (NOT
 * `Authorization: Bearer`) so it never collides with the session-JWT path. The embed routes are
 * whitelisted from the global session-JWT gate so THIS is their sole auth.
 *
 * Failure modes: no token -> 401; no Yuantus public key configured -> 503 (fail-closed, the
 * embed is simply unavailable, NOT a 401); bad/expired/wrong-aud/wrong-type token -> 401.
 */
import type { Request, Response, NextFunction } from 'express'
import { verifyEmbedToken, type EmbedTokenClaims } from '../auth/embed-token-verify'
import { embedAudience, embedPublicKeysByKid } from '../auth/embed-config'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      embedToken?: EmbedTokenClaims
    }
  }
}

export function embedTokenAuth(req: Request, res: Response, next: NextFunction): void {
  const raw = req.headers['x-plm-embed-token']
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (!token) {
    res.status(401).json({ ok: false, error: { code: 'EMBED_TOKEN_REQUIRED', message: 'embed token required' } })
    return
  }
  const publicKeys = embedPublicKeysByKid()
  if (Object.keys(publicKeys).length === 0) {
    res.status(503).json({ ok: false, error: { code: 'EMBED_UNAVAILABLE', message: 'embed verification not configured' } })
    return
  }
  try {
    req.embedToken = verifyEmbedToken(token, { publicKeysByKid: publicKeys, audience: embedAudience() })
  } catch {
    res.status(401).json({ ok: false, error: { code: 'INVALID_EMBED_TOKEN', message: 'invalid embed token' } })
    return
  }
  next()
}
