/**
 * Administrator diagnostics for realtime admission.
 *
 * GET /api/admin/realtime/diagnostics — reason codes, counters and timestamps of this instance's
 * realtime admission state. An unauthenticated caller answers 401 and an authenticated caller
 * without administrator access answers 403, both before anything is read.
 *
 * The public health endpoint is deliberately not involved: a notice shown here changes neither its
 * status code nor its fields.
 */
import type { Request, Response } from 'express'
import { Router } from 'express'
import { realtimeDiagnostics, type RealtimeDiagnostics } from '../realtime-authz/diagnostics'
import { jsonOk } from '../util/response'
import { ensurePlatformAdmin } from './admin-directory'

export type AdminGate = (req: Request, res: Response) => Promise<string | null>

export function adminRealtimeDiagnosticsRouter(
  deps: { diagnostics?: RealtimeDiagnostics; ensureAdmin?: AdminGate } = {},
): Router {
  const diagnostics = deps.diagnostics ?? realtimeDiagnostics
  const ensureAdmin = deps.ensureAdmin ?? ensurePlatformAdmin
  const router = Router()
  router.get('/diagnostics', async (req: Request, res: Response) => {
    const adminUserId = await ensureAdmin(req, res)
    if (!adminUserId) return
    jsonOk(res, diagnostics.snapshot())
  })
  return router
}
