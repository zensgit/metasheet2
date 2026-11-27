import { createRequire } from 'node:module'
import { describe, expect, test, vi } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { authorizeStockPreparationProjectDeleteWithin } from '../../src/services/stock-preparation-project-delete-authority'

const require = createRequire(import.meta.url)
const plugin = '../../../../plugins/plugin-integration-core'
const { registerIntegrationRoutes } = require(plugin + '/lib/http-routes.cjs')
const { call, baseServices } = require(plugin + '/__tests__/support/stock-preparation-project-sheet-harness.cjs')
const access = '/api/integration/stock-preparation/project-delete/access'
const preview = '/api/integration/stock-preparation/projects/:projectNo/delete/preview'
const confirm = '/api/integration/stock-preparation/projects/:projectNo/delete/confirm'

export function defineStockPreparationProjectDeleteAuthorityRealDbCases() {
  describe('stock preparation project deletion live authority', () => {
    test('requires an operable live platform administrator with active membership on every request', async () => {
      vi.stubEnv('STOCK_PREPARATION_PROJECT_DELETE_ENABLED', 'true')
      try {
        await poolManager.get().transaction(async client => {
          await client.query(`CREATE TEMP TABLE users (
            id text PRIMARY KEY, name text, email text, username text, mobile text, role text,
            activation_status text DEFAULT 'activated', is_active boolean DEFAULT true, access_generation bigint DEFAULT 0,
            deleted_at timestamptz, purged_at timestamptz) ON COMMIT DROP`)
          await client.query('CREATE TEMP TABLE user_roles (user_id text, role_id text) ON COMMIT DROP')
          await client.query('CREATE TEMP TABLE user_orgs (user_id text, org_id text, is_active boolean) ON COMMIT DROP')
          await client.query("INSERT INTO users (id,role) VALUES ('project-cleanup-actor','user')")
          await client.query("INSERT INTO user_orgs VALUES ('project-cleanup-actor','own',true), ('project-cleanup-actor','other',true)")
          const tx = { query: async (sql: string, values?: unknown[]) => (await client.query(sql, values)).rows }
          const routes = new Map()
          const database = { transaction: (work: (handle: typeof tx) => Promise<unknown>) => work(tx) }
          const service = { preview: vi.fn().mockResolvedValue({}), confirm: vi.fn().mockResolvedValue({}) }
          registerIntegrationRoutes({
            services: {
              ...baseServices({}),
              stockPreparationProjectDelete: service,
              stockPreparationProjectDeleteAuthority: authorizeStockPreparationProjectDeleteWithin,
              tenantPrincipalDirectory: {
                verifyTenantMembership: async ({ userId, tenantId }: { userId: string; tenantId: string }) => ({
                  member: (await tx.query('SELECT 1 FROM user_orgs WHERE user_id=$1 AND org_id=$2 AND is_active', [userId, tenantId])).length > 0,
                }),
              },
            },
            context: { api: { database, http: { addRoute: (method: string, path: string, handler: unknown) => routes.set(method + ' ' + path, handler) } } },
          })
          const req = { params: { projectNo: 'SYNTHETIC' }, authenticatedTenantId: 'own', user: { id: 'project-cleanup-actor', role: 'admin', tenantId: 'own' } }
          const submit = () => call(routes, 'POST', confirm, { ...req, body: { challengeId: 'id', code: 'CODE' } })
          const canDelete = async () => (await call(routes, 'GET', access, req)).body.data.mayDelete
          expect(await canDelete()).toBe(false) // The token claims admin, but the live row does not.
          expect((await submit()).statusCode).toBe(403)
          await client.query("INSERT INTO user_roles VALUES ('project-cleanup-actor','admin')")
          expect(await canDelete()).toBe(true)
          expect((await call(routes, 'POST', preview, req)).statusCode).toBe(200)
          const headerOnly = { ...req, user: { ...req.user, tenantId: 'other' }, headers: { 'x-tenant-id': 'other' }, authenticatedTenantId: undefined }
          expect((await call(routes, 'GET', access, headerOnly)).body.data.mayDelete).toBe(false)
          expect((await call(routes, 'POST', preview, headerOnly)).statusCode).toBe(403)
          expect((await call(routes, 'POST', confirm, { ...headerOnly, body: { challengeId: 'id', code: 'CODE' } })).statusCode).toBe(403)
          await client.query('DELETE FROM user_roles')
          expect((await submit()).statusCode).toBe(403)
          await client.query("UPDATE users SET role='admin'")
          expect((await submit()).statusCode).toBe(200)
          expect((await call(routes, 'POST', preview, { ...req, query: { tenantId: 'other' } })).statusCode).toBe(403)
          await client.query('UPDATE user_orgs SET is_active=false')
          expect(await canDelete()).toBe(false)
          expect((await submit()).statusCode).toBe(403)
          await client.query('UPDATE user_orgs SET is_active=true')
          await client.query('UPDATE users SET deleted_at=now()')
          expect((await submit()).statusCode).toBe(403)
          expect(service.confirm).toHaveBeenCalledTimes(1)
        })
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })
}
