/**
 * Write-verb transport probe — `DELETE|PUT|PATCH /api/method-probe`.
 *
 * Harmless authenticated endpoint the web client calls once after login to learn whether a
 * non-POST write verb reaches this server at all (a customer egress silently drops DELETE, and a
 * QA client path drops PUT/PATCH — see middleware/method-override.ts). It reads no request input
 * and touches no data: it only echoes the verb the router saw, so the client can verify BOTH
 * transports — a native verb and a `POST` + `X-HTTP-Method-Override` rewritten by the middleware —
 * land on the same handler. `overridden` reports which one it was.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import type { MethodOverrideVerb } from '../middleware/method-override'

export const METHOD_PROBE_PATH = '/api/method-probe'

function probeHandler(verb: MethodOverrideVerb) {
  return (req: Request, res: Response) => {
    res.json({ ok: true, method: verb, overridden: req.methodOverride === verb })
  }
}

export function methodProbeRouter(): Router {
  const r = Router()
  r.delete(METHOD_PROBE_PATH, probeHandler('DELETE'))
  r.put(METHOD_PROBE_PATH, probeHandler('PUT'))
  r.patch(METHOD_PROBE_PATH, probeHandler('PATCH'))
  return r
}
