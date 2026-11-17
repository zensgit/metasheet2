import { createRequire } from 'node:module'
import type { Express, RequestHandler } from 'express'
import { query } from '../../src/db/pg'
import { authenticate } from '../../src/middleware/auth'
import {
  findObjectSheet,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'

export const PERMISSION_LIFECYCLE_PREFLIGHT_PATH = '/api/integration/stock-preparation/preflight'

interface RegisteredRoutes {
  registerIntegrationRoutes?: (input: {
    context: {
      api: {
        multitable: {
          provisioning: {
            findObjectSheet: (input: { projectId: string; objectId: string }) => Promise<unknown>
            resolveFieldIds: () => never
            ensureObject: () => never
          }
        }
        http: {
          addRoute: (method: string, path: string, handler: RequestHandler) => void
        }
      }
    }
    services: Record<string, unknown>
  }) => void
}

/**
 * Mount the production stock-prep preflight handler behind real authenticate.
 * The child process and the suite share this registration.
 */
export function mountPermissionLifecyclePreflight(app: Express): void {
  const require = createRequire(import.meta.url)
  const loaded = require('../../../../plugins/plugin-integration-core/lib/http-routes.cjs') as RegisteredRoutes
  if (typeof loaded.registerIntegrationRoutes !== 'function') {
    throw new Error('registerIntegrationRoutes export is missing')
  }

  const inert: object = new Proxy({}, {
    get(): () => never {
      return () => {
        throw new Error('unexpected synthetic service call')
      }
    },
  })
  const services: Record<string, unknown> = {}
  for (const name of [
    'externalSystemRegistry',
    'adapterRegistry',
    'pipelineRegistry',
    'pipelineRunner',
    'deadLetterStore',
    'stagingInstaller',
    'templateRegistry',
    'readSourceConfigStore',
    'readSourceCompositionConfigStore',
    'bridgeAgentChecklistStore',
  ]) {
    services[name] = inert
  }

  const provisioningQuery: MultitableProvisioningQueryFn = async (sql, params) => {
    const result = await query(sql, params)
    return { rows: result.rows, rowCount: result.rowCount }
  }

  loaded.registerIntegrationRoutes({
    context: {
      api: {
        multitable: {
          provisioning: {
            findObjectSheet: ({ projectId, objectId }) => findObjectSheet(provisioningQuery, projectId, objectId),
            resolveFieldIds: () => {
              throw new Error('unexpected existing object')
            },
            ensureObject: () => {
              throw new Error('unexpected write')
            },
          },
        },
        http: {
          addRoute: (method, path, handler) => {
            if (method.toUpperCase() === 'GET' && path === PERMISSION_LIFECYCLE_PREFLIGHT_PATH) {
              app.get(path, authenticate, handler)
            }
          },
        },
      },
    },
    services,
  })
}
