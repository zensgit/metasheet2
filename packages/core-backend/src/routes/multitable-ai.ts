import { Router, type Request, type Response } from 'express'
import { requireAdminRole } from '../guards/audit-integration'
import { redactValue } from '../multitable/automation-log-redact'
import { resolveAiProviderReadiness } from '../services/ai-provider-readiness'

/**
 * Multitable AI readiness routes — A1 (M1b).
 *
 * **INTERNAL — not in OpenAPI.** Per the M0 ratification result
 * (docs/development/multitable-ai-field-staged-arc-m0-ratification-result-20260610.md,
 * OpenAPI Option B, scoped to A1 ONLY by 修正二): this operator-config surface
 * is deliberately kept out of `packages/openapi/` and the public SDK. The
 * openapi parity gate only asserts that public endpoints exist, so an internal
 * route never trips it. A2/A3 product surfaces (preview/run/display) must NOT
 * inherit this posture — they get their own design-locked permission model.
 *
 * Guards: platform JWT comes from the global `/api/**` middleware in
 * src/index.ts (R-1); this router adds `requireAdminRole()` (R-2 — admin flag
 * only, A1-scoped per 修正二; no new permission primitive, R-3). Non-admin /
 * missing user → 403; RBAC service failure → 503 fail-closed; 401 belongs to
 * the upstream jwtAuthMiddleware.
 *
 * Endpoint:
 *   GET /api/multitable/ai/readiness → flat AiProviderReadinessReport
 *   (single-object precedent: automation `/stats` returns flat, no envelope).
 *
 * The resolver output contains no env values by construction; the response is
 * additionally passed through the shared backend redactor defensively.
 */
export function createMultitableAiRoutes(): Router {
  const router = Router()

  router.get('/ai/readiness', requireAdminRole(), (_req: Request, res: Response) => {
    const report = resolveAiProviderReadiness(process.env)
    res.json(redactValue(report))
  })

  return router
}
