/**
 * Internal multitable AI readiness routes.
 *
 * Mount point: `/api/multitable` (via index.ts).
 *
 * A1/M1b deliberately keeps this route out of OpenAPI: it is an admin-only
 * declarative readiness surface for provider env, not a public product API.
 */

import type { RequestHandler } from 'express'
import { Router } from 'express'
import { requireAdminRole } from '../guards/audit-integration'
import { redactValue } from '../multitable/automation-log-redact'
import {
  resolveAiProviderReadiness,
  type AiProviderReadinessReport,
} from '../services/ai-provider-readiness'

export interface MultitableAiRouterOptions {
  adminGuard?: RequestHandler
  resolveReadiness?: () => AiProviderReadinessReport
}

export function createMultitableAiRouter(options: MultitableAiRouterOptions = {}): Router {
  const router = Router()
  const adminGuard = options.adminGuard ?? requireAdminRole()
  const resolveReadiness = options.resolveReadiness ?? (() => resolveAiProviderReadiness(process.env))

  router.get('/ai/readiness', adminGuard, (_req, res) => {
    const report = resolveReadiness()
    return res.json(redactValue(report))
  })

  return router
}
