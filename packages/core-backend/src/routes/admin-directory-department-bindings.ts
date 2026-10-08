import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { Logger } from '../core/logger'
import { ensurePlatformAdmin } from './admin-directory'
import { query } from '../db/pg'
import {
  suggestDepartmentBindings,
  sweepStaleDepartmentBindings,
} from '../directory/department-binding-reconciliation'
import { jsonError, jsonOk } from '../util/response'

const logger = new Logger('AdminDirectoryDepartmentBindingRoutes')

// Same single-tenant org resolution convention as admin-directory-local.ts / the routing-policy
// routes: org identity is NEVER read from the request.
const DEFAULT_ORG_ID = 'default'
function resolveOrgId(_req: Request): string {
  return DEFAULT_ORG_ID
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * B7 owner round (#4436) — the department-binding MANAGEMENT surface (the production entry the
 * first cut deliberately deferred):
 *
 *   GET  /             — list the org's bindings with their status + both sides' names (read-only).
 *   GET  /suggestions  — the §9 suggest-only proposals (read-only; ambiguous entries are not
 *                        appliable by construction).
 *   POST /sweep        — the Q6 ADMIN RETRY path for the post-sync auto-sweep: run the stale/heal
 *                        sweep now, optionally narrowed to one remote integration (the same
 *                        narrowing the sync hook uses). Values-free audit with the outcome counts.
 *
 * All admin-only; org server-resolved. Applying a suggestion (creating a binding) remains a
 * follow-up decision-workflow surface (§9 outcomes) — deliberately not a blind POST here.
 */
export function adminDirectoryDepartmentBindingsRouter(): Router {
  const router = Router()

  router.get('/', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    try {
      const orgId = resolveOrgId(req)
      const rows = await query(
        `SELECT b.id::text                    AS id,
                b.status                      AS status,
                b.local_integration_id::text  AS local_integration_id,
                b.local_department_id::text   AS local_department_id,
                ld.name                       AS local_department_name,
                b.remote_integration_id::text AS remote_integration_id,
                b.remote_department_id::text  AS remote_department_id,
                rd.name                       AS remote_department_name,
                b.remote_provider             AS remote_provider,
                b.updated_at::text            AS updated_at
           FROM directory_department_bindings b
           JOIN directory_departments ld ON ld.id = b.local_department_id
           JOIN directory_departments rd ON rd.id = b.remote_department_id
          WHERE b.org_id = $1
          ORDER BY b.updated_at DESC, b.id ASC
          LIMIT 500`,
        [orgId],
      )
      jsonOk(res, { orgId, bindings: rows.rows })
    } catch (error) {
      logger.error(`Failed to list department bindings: ${error instanceof Error ? error.message : 'unknown'}`)
      jsonError(res, 500, 'DEPARTMENT_BINDINGS_LIST_FAILED', 'Failed to list department bindings')
    }
  })

  router.get('/suggestions', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    try {
      const orgId = resolveOrgId(req)
      const result = await suggestDepartmentBindings(orgId)
      jsonOk(res, { orgId, ...result })
    } catch (error) {
      logger.error(`Failed to compute binding suggestions: ${error instanceof Error ? error.message : 'unknown'}`)
      jsonError(res, 500, 'DEPARTMENT_BINDINGS_SUGGEST_FAILED', 'Failed to compute binding suggestions')
    }
  })

  router.post('/sweep', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    const body = (req.body ?? {}) as Record<string, unknown>
    const extraKeys = Object.keys(body).filter((k) => k !== 'remoteIntegrationId')
    if (extraKeys.length > 0) {
      jsonError(res, 400, 'DEPARTMENT_BINDINGS_INVALID_INPUT', `Unexpected field(s): ${extraKeys.join(', ')}`)
      return
    }
    const remoteIntegrationId = body.remoteIntegrationId
    if (remoteIntegrationId !== undefined) {
      if (typeof remoteIntegrationId !== 'string' || !UUID_SHAPE.test(remoteIntegrationId)) {
        jsonError(res, 400, 'DEPARTMENT_BINDINGS_INVALID_INPUT', 'remoteIntegrationId must be a UUID when present')
        return
      }
    }

    try {
      const orgId = resolveOrgId(req)
      if (typeof remoteIntegrationId === 'string') {
        const owned = await query<{ id: string }>(
          `SELECT id::text AS id FROM directory_integrations WHERE id = $1::uuid AND org_id = $2`,
          [remoteIntegrationId, orgId],
        )
        if (owned.rows.length === 0) {
          jsonError(res, 404, 'DEPARTMENT_BINDINGS_INTEGRATION_NOT_FOUND', 'Integration not found in this organization')
          return
        }
      }
      const sweep = await sweepStaleDepartmentBindings(
        orgId,
        typeof remoteIntegrationId === 'string' ? { remoteIntegrationId } : {},
      )
      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.department_binding.sweep',
        resourceType: 'directory-department-binding',
        resourceId: `${orgId}:${typeof remoteIntegrationId === 'string' ? remoteIntegrationId : 'all'}`,
        // values-free: ids + outcome COUNTS only
        meta: { orgId, ...(typeof remoteIntegrationId === 'string' ? { remoteIntegrationId } : {}), staled: sweep.staled, healed: sweep.healed },
      })
      jsonOk(res, sweep)
    } catch (error) {
      logger.error(`Failed to sweep department bindings: ${error instanceof Error ? error.message : 'unknown'}`)
      jsonError(res, 500, 'DEPARTMENT_BINDINGS_SWEEP_FAILED', 'Failed to sweep department bindings')
    }
  })

  return router
}
