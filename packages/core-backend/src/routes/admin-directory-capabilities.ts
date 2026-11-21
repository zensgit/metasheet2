import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { getDingTalkRuntimeStatus } from '../auth/dingtalk-oauth'
import { Logger } from '../core/logger'
import { query, transaction } from '../db/pg'
import { isDirectoryIntegrationCapabilitiesEnabled } from '../integrations/directory-integration-capabilities-flag'
import {
  createDirectoryIntegrationCapabilitiesService,
  type CapabilitiesServiceDeps,
  type DirectoryIntegrationCapabilitiesService,
} from '../integrations/directory-integration-capabilities-service'
import {
  PRODUCTION_CAPABILITY_ENABLE_GATES,
  createDirectoryIntegrationCapabilitiesWriteService,
  type CapabilitiesWriteServiceDeps,
  type CapabilityRefusalCode,
  type DirectoryIntegrationCapabilitiesWriteService,
} from '../integrations/directory-integration-capabilities-write-service'
import { isCapabilityImplementationAvailable } from '../integrations/integration-capability-implementations'
import {
  resolveProviderCapabilityDescriptor,
  type CapabilityTransactionClient,
} from '../integrations/provider-capability-registry'
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
export const CAPABILITIES_INVALID_INPUT = {
  code: 'DIRECTORY_CAPABILITIES_INVALID_INPUT',
  sentence: 'The capability change request is not valid',
} as const
export const CAPABILITIES_STALE = {
  code: 'DIRECTORY_CAPABILITIES_STALE',
  sentence: 'The capability state has changed; reload before applying',
} as const
export const CAPABILITIES_BUSY = {
  code: 'DIRECTORY_CAPABILITIES_BUSY',
  sentence: 'Directory integration capabilities are busy; retry later',
} as const

/** The fixed sentence of each refusal to turn a capability on. */
export const CAPABILITY_REFUSAL_SENTENCES: Readonly<Record<CapabilityRefusalCode, string>> = Object.freeze({
  CAPABILITY_PROVIDER_NOT_REGISTERED: 'The provider of this integration is not registered for capabilities',
  CAPABILITY_GOVERNED_BY_LEGACY_PATH: 'The capability is governed by the existing switches and configuration',
  CAPABILITY_UNSUPPORTED: 'The provider does not offer the capability',
  CAPABILITY_IMPLEMENTATION_MISSING: 'The capability has no registered implementation',
  CAPABILITY_INTEGRATION_INACTIVE: 'The integration is not active',
  CAPABILITY_SCOPE_INCOMPLETE: 'The integration scope is missing or malformed',
  CAPABILITY_PRECONDITION_FAILED: 'An enable precondition is not met',
  CAPABILITY_LOGIN_SCOPE_TAKEN: 'Another integration already has login enabled for the same scope',
})

function fixedLogText(error: unknown): string {
  const name = error instanceof Error ? error.name : 'non-error'
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${name} ${code}` : name
}

export interface AdminDirectoryCapabilitiesRouterDeps {
  readonly service: DirectoryIntegrationCapabilitiesService
  readonly writer: DirectoryIntegrationCapabilitiesWriteService
}

/**
 * One integration's capability state: the display read and the administrator write. Both handlers
 * answer in the same order: administrator check, switch, path, and only then the data.
 */
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

  router.patch('/:integrationId', async (req: Request, res: Response) => {
    // Nothing of this route answers before the administrator gate: neither the switch, the path nor the body.
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      if (!deps.writer.isEnabled()) {
        jsonError(res, 404, CAPABILITIES_DISABLED.code, CAPABILITIES_DISABLED.sentence)
        return
      }
      const integrationId = String(req.params.integrationId ?? '')
      if (!UUID_SHAPE_RE.test(integrationId)) {
        jsonError(res, 400, INTEGRATION_ID_INVALID.code, INTEGRATION_ID_INVALID.sentence)
        return
      }
      // The body is judged by the writer after it knows the integration exists; an invalid body is
      // answered with field tokens only, never with a name the caller sent.
      const result = await deps.writer.patch(integrationId, req.body as unknown, adminUserId)
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
        case 'invalid_input':
          jsonError(res, 422, CAPABILITIES_INVALID_INPUT.code, CAPABILITIES_INVALID_INPUT.sentence, { fields: result.fields })
          return
        case 'stale':
          jsonError(res, 409, CAPABILITIES_STALE.code, CAPABILITIES_STALE.sentence)
          return
        case 'refused':
          jsonError(
            res,
            409,
            result.code,
            CAPABILITY_REFUSAL_SENTENCES[result.code],
            result.reason === undefined
              ? { capability: result.capability }
              : { capability: result.capability, reason: result.reason },
          )
          return
        case 'busy':
          jsonError(res, 503, CAPABILITIES_BUSY.code, CAPABILITIES_BUSY.sentence)
          return
        case 'ok':
          jsonOk(res, result.view)
          return
      }
    } catch (error) {
      logger.error(`Directory integration capabilities write failed: ${fixedLogText(error)}`)
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

// The write side reads the same switch, registry and implementation table as the read side. Its gate
// table is the frozen, empty production table: nothing here accepts a gate, a descriptor or a switch
// from a caller.
const PRODUCTION_WRITE_DEPS: CapabilitiesWriteServiceDeps = Object.freeze({
  isEnabled: PRODUCTION_DEPS.isEnabled,
  resolveDescriptor: PRODUCTION_DEPS.resolveDescriptor,
  isImplementationAvailable: PRODUCTION_DEPS.isImplementationAvailable,
  readLoginRuntime: PRODUCTION_DEPS.readLoginRuntime,
  isIntegrationScopedCredentialsEnabled: PRODUCTION_DEPS.isIntegrationScopedCredentialsEnabled,
  transaction: <T>(work: (client: CapabilityTransactionClient) => Promise<T>): Promise<T> =>
    transaction<T>((client) => work(client)),
  capabilityGates: PRODUCTION_CAPABILITY_ENABLE_GATES,
  audit: (event) => auditLog(event),
})

/** Production router: bound to the production dependencies, accepts no arguments. */
export function adminDirectoryCapabilitiesRouter(): Router {
  return createAdminDirectoryCapabilitiesRouter({
    service: createDirectoryIntegrationCapabilitiesService(PRODUCTION_DEPS),
    writer: createDirectoryIntegrationCapabilitiesWriteService(PRODUCTION_WRITE_DEPS),
  })
}
