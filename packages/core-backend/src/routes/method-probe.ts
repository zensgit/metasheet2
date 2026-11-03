/**
 * DELETE transport probe — `DELETE /api/method-probe`.
 *
 * Harmless authenticated endpoint the web client calls once after login to learn whether HTTP
 * DELETE reaches this server at all (a customer egress silently drops DELETE, see
 * middleware/method-override.ts). It reads no request input and touches no data: it only echoes
 * the verb the router saw, so the client can verify BOTH transports — a native DELETE and a
 * `POST` + `X-HTTP-Method-Override: DELETE` rewritten by the middleware — land on the same handler.
 * `overridden` reports which one it was.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'

export const METHOD_PROBE_PATH = '/api/method-probe'

export function methodProbeRouter(): Router {
  const r = Router()
  r.delete(METHOD_PROBE_PATH, (req: Request, res: Response) => {
    res.json({ ok: true, method: 'DELETE', overridden: req.methodOverride === 'DELETE' })
  })
  return r
}
