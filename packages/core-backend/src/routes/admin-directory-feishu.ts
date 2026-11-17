import type { Request, Response } from 'express'
import { Router } from 'express'
import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { isDirectoryIntegrationCapabilitiesEnabled } from '../integrations/directory-integration-capabilities-flag'
import {
  FEISHU_VERIFY_REQUEST_SENTENCES,
  parseFeishuVerifyBody,
  verifyFeishuConnection,
  type FeishuVerifyDeps,
  type FeishuVerifyIntegrationRow,
} from '../integrations/feishu/verify'
import { feishuLogLabel } from '../integrations/feishu/redaction'
import { feishuTenantTokens } from '../integrations/feishu/token'
import { decryptStoredSecretValue } from '../security/encrypted-secrets'
import { jsonError, jsonOk } from '../util/response'
import { ensurePlatformAdmin } from './admin-directory'

const logger = new Logger('AdminDirectoryFeishuRoutes')

/** Same code and sentence as the capability read route's switch-off answer. */
export const FEISHU_CONNECTION_DISABLED = {
  code: 'DIRECTORY_CAPABILITIES_DISABLED',
  sentence: 'Directory integration capabilities are not enabled',
} as const
export const FEISHU_VERIFY_REQUEST_INVALID = { code: 'FEISHU_VERIFY_REQUEST_INVALID' } as const
export const FEISHU_INTEGRATION_NOT_FOUND = { code: 'DIRECTORY_NOT_FOUND', sentence: 'Directory integration not found' } as const
export const FEISHU_PROVIDER_MISMATCH = {
  code: 'FEISHU_PROVIDER_MISMATCH',
  sentence: 'The integration is not a Feishu integration',
} as const
export const FEISHU_VERIFY_INTERNAL = {
  code: 'FEISHU_VERIFY_FAILED',
  sentence: 'Feishu connection verification failed',
} as const

export interface AdminDirectoryFeishuRouterDeps {
  /** The switch, read per request. */
  isEnabled(): boolean
  verify: FeishuVerifyDeps
}

/**
 * Feishu connection routes (administrators only).
 *
 * `POST /connection/verify`: nothing answers before the administrator check, and the switch
 * (DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED, default off) is read after it: off answers 404 and no
 * row is read and nothing is requested. The body is a closed whitelist and is validated before the
 * integration row is read. The report carries booleans, lengths, numeric codes and fixed sentences.
 *
 * This router is not mounted by the application entry point in this slice.
 */
export function createAdminDirectoryFeishuRouter(deps: AdminDirectoryFeishuRouterDeps): Router {
  const router = Router()

  router.post('/connection/verify', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    try {
      if (!deps.isEnabled()) {
        jsonError(res, 404, FEISHU_CONNECTION_DISABLED.code, FEISHU_CONNECTION_DISABLED.sentence)
        return
      }
      const parsed = parseFeishuVerifyBody(req.body)
      if (parsed.ok === false) {
        jsonError(res, 400, FEISHU_VERIFY_REQUEST_INVALID.code, FEISHU_VERIFY_REQUEST_SENTENCES[parsed.issue])
        return
      }
      const outcome = await verifyFeishuConnection(deps.verify, parsed.input)
      switch (outcome.kind) {
        case 'not_found':
          jsonError(res, 404, FEISHU_INTEGRATION_NOT_FOUND.code, FEISHU_INTEGRATION_NOT_FOUND.sentence)
          return
        case 'provider_mismatch':
          jsonError(res, 409, FEISHU_PROVIDER_MISMATCH.code, FEISHU_PROVIDER_MISMATCH.sentence)
          return
        case 'ok':
          jsonOk(res, outcome.report)
          return
      }
    } catch (error) {
      logger.error(`Feishu connection verification failed: ${feishuLogLabel(error)}`)
      jsonError(res, 500, FEISHU_VERIFY_INTERNAL.code, FEISHU_VERIFY_INTERNAL.sentence)
    }
  })

  return router
}

async function readIntegrationRow(integrationId: string): Promise<FeishuVerifyIntegrationRow | null> {
  const result = await query('SELECT id, provider, corp_id, config FROM directory_integrations WHERE id = $1', [integrationId])
  const row = (result.rows as Array<Record<string, unknown>>)[0]
  if (!row) return null
  return {
    id: String(row.id),
    provider: String(row.provider),
    corp_id: typeof row.corp_id === 'string' ? row.corp_id : '',
    config: row.config,
  }
}

/** Production router: bound to the production dependencies, accepts no arguments. */
export function adminDirectoryFeishuRouter(): Router {
  return createAdminDirectoryFeishuRouter({
    isEnabled: () => isDirectoryIntegrationCapabilitiesEnabled(),
    verify: {
      readIntegration: readIntegrationRow,
      decodeSecret: decryptStoredSecretValue,
      tokens: feishuTenantTokens,
    },
  })
}
