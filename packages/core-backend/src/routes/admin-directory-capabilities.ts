import type { Request, Response } from 'express'
import { Router } from 'express'
import { getDingTalkRuntimeStatus } from '../auth/dingtalk-oauth'
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { isDirectoryIntegrationCapabilitiesEnabled } from '../integrations/directory-integration-capabilities-flag'
import {
  createDirectoryIntegrationCapabilitiesService,
  type CapabilitiesServiceDeps,
  type DirectoryIntegrationCapabilitiesService,
} from '../integrations/directory-integration-capabilities-service'
import { isCapabilityImplementationAvailable } from '../integrations/integration-capability-implementations'
import { resolveProviderCapabilityDescriptor } from '../integrations/provider-capability-registry'
import { isDingTalkIntegrationScopedCredentialsEnabled } from '../integrations/dingtalk/integration-scoped-credentials-flag'
import { jsonError, jsonOk } from '../util/response'
import { ensurePlatformAdmin } from './admin-directory'

const logger = new Logger('AdminDirectoryCapabilitiesRoutes')

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Same code and sentence as the integrationId check in routes/admin-directory.ts. */
export const INTEGRATION_ID_INVALID = {
  code: 'DIRECTORY_INTEGRATION_ID_INVALID',
  sentence: 'integrationId must be a UUID',
} as const
/** Same code and sentence as the not-found answers in routes/admin-directory.ts. */
export const INTEGRATION_NOT_FOUND = { code: 'DIRECTORY_NOT_FOUND', sentence: 'Directory integration not found' } as const

export const CAPABILITIES_DISABLED = {
  code: 'DIRECTORY_CAPABILITIES_DISABLED',
  sentence: 'Directory integration capabilities are not enabled',
} as const
export const CAPABILITIES_SCHEMA_UNAVAILABLE = {
  code: 'DIRECTORY_CAPABILITIES_SCHEMA_UNAVAILABLE',
  sentence: 'Directory integration capabilities are unavailable',
} as const
export const CAPABILITIES_INTERNAL = {
  code: 'DIRECTORY_CAPABILITIES_INTERNAL',
  sentence: 'Directory integration capabilities request failed',
} as const

function fixedLogText(error: unknown): string {
  const name = error instanceof Error ? error.name : 'non-error'
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${name} ${code}` : name
}

export interface AdminDirectoryCapabilitiesRouterDeps {
  readonly service: DirectoryIntegrationCapabilitiesService
}

/** Read-only display of one integration's capability state. */
export function createAdminDirectoryCapabilitiesRouter(deps: AdminDirectoryCapabilitiesRouterDeps): Router {
  const router = Router()

  router.get('/:integrationId', async (req: Request, res: Response) => {
    // Nothing of this route answers before the administrator gate: neither the switch nor the path.
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      if (!deps.service.isEnabled()) {
        jsonError(res, 404, CAPABILITIES_DISABLED.code, CAPABILITIES_DISABLED.sentence)
        return
      }
      const integrationId = String(req.params.integrationId ?? '')
      if (!UUID_SHAPE_RE.test(integrationId)) {
        jsonError(res, 400, INTEGRATION_ID_INVALID.code, INTEGRATION_ID_INVALID.sentence)
        return
      }
      const result = await deps.service.read(integrationId)
      switch (result.kind) {
        case 'disabled':
          jsonError(res, 404, CAPABILITIES_DISABLED.code, CAPABILITIES_DISABLED.sentence)
          return
        case 'schema_unavailable':
          jsonError(res, 503, CAPABILITIES_SCHEMA_UNAVAILABLE.code, CAPABILITIES_SCHEMA_UNAVAILABLE.sentence)
          return
        case 'not_found':
          jsonError(res, 404, INTEGRATION_NOT_FOUND.code, INTEGRATION_NOT_FOUND.sentence)
          return
        case 'ok':
          jsonOk(res, result.view)
          return
      }
    } catch (error) {
      logger.error(`Directory integration capabilities read failed: ${fixedLogText(error)}`)
      jsonError(res, 500, CAPABILITIES_INTERNAL.code, CAPABILITIES_INTERNAL.sentence)
    }
  })

  return router
}

const PRODUCTION_DEPS: CapabilitiesServiceDeps = Object.freeze({
  executor: Object.freeze({ query: (sql: string, params?: unknown[]) => query(sql, params) as never }),
  isEnabled: () => isDirectoryIntegrationCapabilitiesEnabled(),
  resolveDescriptor: resolveProviderCapabilityDescriptor,
  isImplementationAvailable: isCapabilityImplementationAvailable,
  readLoginRuntime: () => getDingTalkRuntimeStatus(),
  isIntegrationScopedCredentialsEnabled: () => isDingTalkIntegrationScopedCredentialsEnabled(),
})

/** Production router: bound to the production dependencies, accepts no arguments. */
export function adminDirectoryCapabilitiesRouter(): Router {
  return createAdminDirectoryCapabilitiesRouter({ service: createDirectoryIntegrationCapabilitiesService(PRODUCTION_DEPS) })
}
