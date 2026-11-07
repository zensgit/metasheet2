/**
 * Directory integration capability tables against real PostgreSQL: table structure and constraints,
 * the update and append-only guards, the guarded down() and its round trip, the existence probe on an
 * open transaction, the display read, and the login scope unique index.
 *
 * DATABASE_URL-gated. Rows that a test needs "enabled" are written directly: nothing in the product
 * writes them. Cleanup order: capability rows, then the history table (TRUNCATE; row deletes are
 * refused by its trigger), then the test integrations.
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import {
  DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED_CODE,
  down,
  up,
} from '../../src/db/migrations/zzzz20261106130000_create_directory_integration_capabilities'
import { createDirectoryIntegrationCapabilitiesService } from '../../src/integrations/directory-integration-capabilities-service'
import { probeCapabilityTables } from '../../src/integrations/integration-capability-evaluate'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import { resolveProviderCapabilityDescriptor } from '../../src/integrations/provider-capability-registry'
import { createAdminDirectoryCapabilitiesRouter } from '../../src/routes/admin-directory-capabilities'
import { usePinnedServer } from '../utils/pinned-server'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

// Module top level: it must run (and fail) when the gated describe below is skipped for want of a database.
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const CAPS = 'directory_integration_capabilities'
const HISTORY = 'directory_integration_capability_history'
const CAPABILITIES = ['directory', 'login', 'notification'] as const

interface PgError extends Error {
  code?: string
  constraint?: string
}

async function pgError(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise
  } catch (error) {
    return error as PgError
  }
  throw new Error('expected the statement to fail')
}

describeIfDatabase('directory integration capability tables (real database)', () => {
  const pinned = usePinnedServer()
  let pool: Pool
  let migrationDb: Kysely<unknown>
  const integrationIds: string[] = []

  const run = (text: string, values?: unknown[]) => pool.query(text, values)

  async function tablesExist(): Promise<boolean> {
    const result = await run(`SELECT to_regclass('${CAPS}') IS NOT NULL AS c, to_regclass('${HISTORY}') IS NOT NULL AS h`)
    return result.rows[0].c === true && result.rows[0].h === true
  }

  async function ensureTables(): Promise<void> {
    if (await tablesExist()) return
    await migrationDb.transaction().execute((trx) => up(trx))
  }

  async function insertIntegration(overrides: { provider?: string; orgId?: string; corp?: string; config?: unknown; status?: string } = {}): Promise<{ id: string; org: string }> {
    const org = overrides.orgId ?? `cap-db-${randomUUID()}`
    const result = await run(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id::text AS id`,
      [org, overrides.provider ?? 'dingtalk', `cap-db-${randomUUID()}`, overrides.status ?? 'active', overrides.corp ?? 'CorpOne', JSON.stringify(overrides.config ?? { appKey: 'AppOne' })],
    )
    const id = result.rows[0].id as string
    integrationIds.push(id)
    return { id, org }
  }

  async function insertCapabilityRow(integrationId: string, provider: string, org: string, extra: Record<string, unknown> = {}): Promise<void> {
    const row: Record<string, unknown> = {
      integration_id: integrationId, bound_provider: provider, bound_org_id: org,
      revision: 1, created_by: 'admin-1', updated_by: 'admin-1', ...extra,
    }
    const columns = Object.keys(row)
    await run(
      `INSERT INTO ${CAPS} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map((column) => row[column]),
    )
  }

  const enabledLogin = (tenant: string, appScope: string) => ({ login_enabled: true, login_bound_tenant: tenant, login_bound_app_scope: appScope })

  async function cleanup(): Promise<void> {
    if (!(await tablesExist())) await migrationDb.transaction().execute((trx) => up(trx))
    await run(`DELETE FROM ${CAPS} WHERE integration_id = ANY($1::uuid[])`, [integrationIds])
    await run(`TRUNCATE ${HISTORY}`)
    await run('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [integrationIds])
    integrationIds.length = 0
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }) })
  })

  beforeEach(async () => {
    await ensureTables()
  })

  afterEach(async () => {
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
    await migrationDb.destroy()
  })

  describe('structure', () => {
    it('defaults every capability to off with no anchor', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org)
      const row = (await run(`SELECT * FROM ${CAPS} WHERE integration_id = $1`, [id])).rows[0]
      for (const capability of CAPABILITIES) {
        expect(row[`${capability}_enabled`]).toBe(false)
        expect(row[`${capability}_bound_tenant`]).toBeNull()
        expect(row[`${capability}_bound_app_scope`]).toBeNull()
      }
      expect(String(row.revision)).toBe('1')
    })

    it('refuses a malformed provider name, a blank actor and a revision below one', async () => {
      const { id, org } = await insertIntegration()
      const name = await pgError(insertCapabilityRow(id, 'Bad-Name', org))
      expect([name.code, name.constraint]).toEqual(['23514', 'dic_row_shape_chk'])
      const blank = await pgError(insertCapabilityRow(id, 'dingtalk', org, { created_by: '  ' }))
      expect([blank.code, blank.constraint]).toEqual(['23514', 'dic_row_shape_chk'])
      const blankUpdater = await pgError(insertCapabilityRow(id, 'dingtalk', org, { updated_by: '' }))
      expect([blankUpdater.code, blankUpdater.constraint]).toEqual(['23514', 'dic_row_shape_chk'])
      const revision = await pgError(insertCapabilityRow(id, 'dingtalk', org, { revision: 0 }))
      expect([revision.code, revision.constraint]).toEqual(['23514', 'dic_revision_chk'])
    })

    it('refuses an enabled capability whose anchor is missing or malformed, and a disabled one that still has an anchor', async () => {
      const { id, org } = await insertIntegration()
      for (const capability of CAPABILITIES) {
        const constraint = `dic_${capability}_anchor_chk`
        const refusals: Array<Record<string, unknown>> = [
          { [`${capability}_enabled`]: true },
          { [`${capability}_enabled`]: true, [`${capability}_bound_tenant`]: 'tenant' },
          { [`${capability}_enabled`]: true, [`${capability}_bound_app_scope`]: 'app' },
          { [`${capability}_enabled`]: true, [`${capability}_bound_tenant`]: 'has space', [`${capability}_bound_app_scope`]: 'app' },
          { [`${capability}_enabled`]: true, [`${capability}_bound_tenant`]: 'tenant', [`${capability}_bound_app_scope`]: '应用' },
          { [`${capability}_enabled`]: true, [`${capability}_bound_tenant`]: 'tenant', [`${capability}_bound_app_scope`]: 'a'.repeat(257) },
          { [`${capability}_enabled`]: true, [`${capability}_bound_tenant`]: '', [`${capability}_bound_app_scope`]: 'app' },
          { [`${capability}_enabled`]: false, [`${capability}_bound_tenant`]: 'tenant' },
          { [`${capability}_enabled`]: false, [`${capability}_bound_app_scope`]: 'app' },
        ]
        for (const extra of refusals) {
          const error = await pgError(insertCapabilityRow(id, 'dingtalk', org, extra))
          expect([error.code, error.constraint], JSON.stringify(extra)).toEqual(['23514', constraint])
        }
        await insertCapabilityRow(id, 'dingtalk', org, {
          [`${capability}_enabled`]: true, [`${capability}_bound_tenant`]: 'tenant', [`${capability}_bound_app_scope`]: 'a'.repeat(256),
        })
        await run(`DELETE FROM ${CAPS} WHERE integration_id = $1`, [id])
      }
    })

    it('ties the row to the integration with its provider and its organization', async () => {
      const { id, org } = await insertIntegration()
      const provider = await pgError(insertCapabilityRow(id, 'wecom', org))
      expect([provider.code, provider.constraint]).toEqual(['23503', 'dic_integration_provider_fk'])
      const organization = await pgError(insertCapabilityRow(id, 'dingtalk', `${org}-other`))
      expect([organization.code, organization.constraint]).toEqual(['23503', 'dic_integration_org_fk'])
      const missing = await pgError(insertCapabilityRow(randomUUID(), 'dingtalk', org))
      expect(missing.code).toBe('23503')
    })

    it('refuses to delete an integration, or change its provider or organization, while a capability row exists', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org)
      expect((await pgError(run('DELETE FROM directory_integrations WHERE id = $1', [id]))).code).toBe('23503')
      expect((await pgError(run(`UPDATE directory_integrations SET provider = 'wecom' WHERE id = $1`, [id]))).code).toBe('23503')
      expect((await pgError(run(`UPDATE directory_integrations SET org_id = $2 WHERE id = $1`, [id, `${org}-moved`]))).code).toBe('23503')
      await run(`DELETE FROM ${CAPS} WHERE integration_id = $1`, [id])
      await run('DELETE FROM directory_integrations WHERE id = $1', [id])
    })

    it('guards updates: the revision advances by exactly one and the identity, binding and creation columns never change', async () => {
      const { id, org } = await insertIntegration()
      const other = await insertIntegration({ orgId: org })
      await insertCapabilityRow(id, 'dingtalk', org)
      for (const revision of [1, 3, 0]) {
        const error = await pgError(run(`UPDATE ${CAPS} SET revision = $2, updated_by = 'admin-2' WHERE integration_id = $1`, [id, revision]))
        expect([error.code, error.message], String(revision)).toEqual(['55000', 'directory integration capability revision refused'])
      }
      const unchanged = await pgError(run(`UPDATE ${CAPS} SET updated_by = 'admin-2' WHERE integration_id = $1`, [id]))
      expect(unchanged.code).toBe('55000')
      const immutable: Array<[string, unknown]> = [
        ['created_by', 'admin-9'],
        ['created_at', '2000-01-01T00:00:00Z'],
        ['integration_id', other.id],
      ]
      for (const [column, value] of immutable) {
        const error = await pgError(run(`UPDATE ${CAPS} SET ${column} = $2, revision = revision + 1 WHERE integration_id = $1`, [id, value]))
        expect([error.code, error.message], column).toEqual(['55000', 'directory integration capability immutable column refused'])
      }
      await run(`UPDATE ${CAPS} SET login_enabled = true, login_bound_tenant = 'CorpOne', login_bound_app_scope = 'AppOne', revision = revision + 1, updated_by = 'admin-2' WHERE integration_id = $1`, [id])
      const row = (await run(`SELECT revision::text AS revision, updated_by, login_enabled FROM ${CAPS} WHERE integration_id = $1`, [id])).rows[0]
      expect(row).toEqual({ revision: '2', updated_by: 'admin-2', login_enabled: true })
    })

    it('keeps the history append-only and admits only well-formed rows', async () => {
      const insert = (overrides: Record<string, unknown> = {}) => {
        const row: Record<string, unknown> = {
          integration_id: randomUUID(), bound_provider: 'dingtalk', revision: 1, actor_id: 'admin-1',
          changed: ['login'], anchor_rebound: [], directory_enabled: false, login_enabled: true, notification_enabled: false, ...overrides,
        }
        const columns = Object.keys(row)
        return run(`INSERT INTO ${HISTORY} (${columns.join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING id::text AS id`, columns.map((column) => row[column]))
      }
      const inserted = await insert()
      const historyId = inserted.rows[0].id as string
      expect((await pgError(run(`UPDATE ${HISTORY} SET actor_id = 'admin-2' WHERE id = $1`, [historyId]))).code).toBe('55000')
      expect((await pgError(run(`DELETE FROM ${HISTORY} WHERE id = $1`, [historyId]))).message).toBe('directory integration capability history is append-only')
      const refusals: Array<[Record<string, unknown>, string]> = [
        [{ changed: [] }, 'dich_changed_chk'],
        [{ changed: ['other'] }, 'dich_changed_chk'],
        [{ anchor_rebound: ['other'] }, 'dich_anchor_rebound_chk'],
        [{ actor_id: ' ' }, 'dich_actor_chk'],
        [{ revision: 0 }, 'dich_revision_chk'],
      ]
      for (const [overrides, constraint] of refusals) {
        const error = await pgError(insert(overrides))
        expect([error.code, error.constraint], constraint).toEqual(['23514', constraint])
      }
      // History outlives the integration: it carries no foreign key.
      await insert({ changed: ['directory', 'login', 'notification'], anchor_rebound: ['login'] })
    })
  })

  describe('down()', () => {
    it('refuses while a capability row exists, and leaves both tables and the row in place', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org)
      const error = await pgError(migrationDb.transaction().execute((trx) => down(trx)))
      expect(error.message).toMatch(new RegExp(`^${DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED_CODE}`))
      expect(await tablesExist()).toBe(true)
      expect((await run(`SELECT count(*)::int AS n FROM ${CAPS} WHERE integration_id = $1`, [id])).rows[0].n).toBe(1)
    })

    it('refuses while only the history table holds a row', async () => {
      await run(`INSERT INTO ${HISTORY} (integration_id, bound_provider, revision, actor_id, changed, directory_enabled, login_enabled, notification_enabled)
                 VALUES ($1, 'dingtalk', 1, 'admin-1', ARRAY['login'], false, true, false)`, [randomUUID()])
      const error = await pgError(migrationDb.transaction().execute((trx) => down(trx)))
      expect(error.message).toMatch(new RegExp(`^${DIRECTORY_INTEGRATION_CAPABILITIES_DOWN_BLOCKED_CODE}`))
      expect(await tablesExist()).toBe(true)
    })

    it('drops both tables and the guard functions when they are empty, and up() rebuilds them with their guards', async () => {
      await migrationDb.transaction().execute((trx) => down(trx))
      expect((await run(`SELECT to_regclass('${CAPS}') AS c, to_regclass('${HISTORY}') AS h`)).rows[0]).toEqual({ c: null, h: null })
      const functions = await run(`SELECT proname FROM pg_proc WHERE proname IN ('dic_guard_update', 'dich_guard_append_only')`)
      expect(functions.rows).toHaveLength(0)
      await migrationDb.transaction().execute((trx) => up(trx))
      expect(await tablesExist()).toBe(true)
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org)
      expect((await pgError(run(`UPDATE ${CAPS} SET updated_by = 'x' WHERE integration_id = $1`, [id]))).code).toBe('55000')
    })

    it('is a no-op when the tables are already gone', async () => {
      await migrationDb.transaction().execute((trx) => down(trx))
      await expect(migrationDb.transaction().execute((trx) => down(trx))).resolves.toBeUndefined()
      expect(await tablesExist()).toBe(false)
    })

    it('leaves the session lock and statement timeouts as it found them, for down() and up()', async () => {
      const settings = async (executor: Kysely<unknown>) => {
        const result = await sql<{ lock_timeout: string; statement_timeout: string }>`
          SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout
        `.execute(executor)
        return result.rows[0]
      }
      await migrationDb.transaction().execute(async (trx) => {
        await sql`SET LOCAL lock_timeout = '7s'`.execute(trx)
        await sql`SET LOCAL statement_timeout = '42s'`.execute(trx)
        const before = await settings(trx)
        expect(before).toEqual({ lock_timeout: '7s', statement_timeout: '42s' })
        await down(trx)
        expect(await settings(trx)).toEqual(before)
        await up(trx)
        expect(await settings(trx)).toEqual(before)
      })
    })
  })

  describe('existence probe and display read', () => {
    function appWith(switchOn: boolean) {
      const app = express()
      app.use((req: Request, _res: Response, next: NextFunction) => {
        req.user = { id: 'admin-1', role: 'admin' } as never
        next()
      })
      const service = createDirectoryIntegrationCapabilitiesService({
        executor: { query: (text: string, values?: unknown[]) => pool.query(text, values) as never },
        isEnabled: () => switchOn,
        resolveDescriptor: resolveProviderCapabilityDescriptor,
        isImplementationAvailable: isCapabilityImplementationAvailable,
        readLoginRuntime: () => ({ available: false, requireGrant: false, autoLinkEmail: false, autoProvision: false }),
        isIntegrationScopedCredentialsEnabled: () => false,
      })
      app.use('/api/admin/directory/integration-capabilities', createAdminDirectoryCapabilitiesRouter({ service }))
      return { app, service }
    }

    it('keeps an open transaction usable after it finds the tables missing', async () => {
      await migrationDb.transaction().execute((trx) => down(trx))
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        expect(await probeCapabilityTables(client as never)).toBe(false)
        expect((await client.query('SELECT 1 AS one')).rows[0].one).toBe(1)
        await client.query('COMMIT')
        // Contrast: reading the missing table directly poisons the transaction.
        await client.query('BEGIN')
        expect((await pgError(client.query(`SELECT 1 FROM ${CAPS}`))).code).toBe('42P01')
        expect((await pgError(client.query('SELECT 1 AS one'))).code).toBe('25P02')
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    })

    it('answers the display read with a schema-unavailable result and the route with 503 when the tables are gone', async () => {
      const { id } = await insertIntegration()
      await migrationDb.transaction().execute((trx) => down(trx))
      const { app, service } = appWith(true)
      expect(await service.read(id)).toEqual({ kind: 'schema_unavailable' })
      pinned.setApp(app)
      const response = await request(pinned.url()).get(`/api/admin/directory/integration-capabilities/${id}`)
      expect(response.status).toBe(503)
      expect(response.body.error.code).toBe('DIRECTORY_CAPABILITIES_SCHEMA_UNAVAILABLE')
    })

    it('shows a dingtalk integration with no row, with a stored row, and after its application key changes', async () => {
      const { id, org } = await insertIntegration({ corp: 'CorpOne', config: { appKey: 'AppOne' } })
      const { app, service } = appWith(true)
      pinned.setApp(app)
      const url = `/api/admin/directory/integration-capabilities/${id}`

      const empty = await request(pinned.url()).get(url)
      expect(empty.status).toBe(200)
      expect(empty.body.data.revision).toBe(0)
      expect(empty.body.data.updatedAt).toBeNull()
      for (const capability of CAPABILITIES) {
        expect(empty.body.data.capabilities[capability]).toMatchObject({ enabled: false, governance: 'legacy', effective: null, reason: 'governed_by_legacy_path', anchor: { bound: false, matchesCurrent: null } })
      }

      await insertCapabilityRow(id, 'dingtalk', org, enabledLogin('CorpOne', 'AppOne'))
      const stored = await request(pinned.url()).get(url)
      expect(stored.body.data.revision).toBe(1)
      expect(typeof stored.body.data.updatedAt).toBe('string')
      expect(stored.body.data.capabilities.login).toMatchObject({ enabled: true, effective: null, reason: 'governed_by_legacy_path', anchor: { bound: true, matchesCurrent: true } })
      expect(stored.body.data.capabilities.notification.anchor).toEqual({ bound: false, matchesCurrent: null })

      await run(`UPDATE directory_integrations SET config = jsonb_set(config, '{appKey}', '"AppTwo"') WHERE id = $1`, [id])
      const changed = await request(pinned.url()).get(url)
      expect(changed.body.data.capabilities.login.anchor).toEqual({ bound: true, matchesCurrent: false })
      expect(JSON.stringify(changed.body)).not.toMatch(/CorpOne|AppOne|AppTwo/)
      expect(await service.read(randomUUID())).toEqual({ kind: 'not_found' })
    })

    it('shows an integration of a provider that is not registered as not registered', async () => {
      const { id, org } = await insertIntegration({ provider: 'wecom' })
      await insertCapabilityRow(id, 'wecom', org)
      const { service } = appWith(true)
      const result = await service.read(id)
      if (result.kind !== 'ok') throw new Error('expected a view')
      for (const capability of CAPABILITIES) {
        expect(result.view.capabilities[capability]).toMatchObject({ governance: null, effective: null, reason: 'provider_not_registered' })
      }
    })

    it('reads without taking row locks: a writer holding both rows does not delay the display read', async () => {
      const { id, org } = await insertIntegration()
      await insertCapabilityRow(id, 'dingtalk', org)
      const { service } = appWith(true)
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT 1 FROM directory_integrations WHERE id = $1 FOR UPDATE', [id])
        await holder.query(`SELECT 1 FROM ${CAPS} WHERE integration_id = $1 FOR UPDATE`, [id])
        const outcome = await Promise.race([
          service.read(id).then((result) => result.kind),
          new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 5000)),
        ])
        expect(outcome).toBe('ok')
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
      }
    })

    it('issues no statement while the switch is off', async () => {
      const { id } = await insertIntegration()
      const { app } = appWith(false)
      pinned.setApp(app)
      const response = await request(pinned.url()).get(`/api/admin/directory/integration-capabilities/${id}`)
      expect(response.status).toBe(404)
      expect(response.body.error.code).toBe('DIRECTORY_CAPABILITIES_DISABLED')
    })
  })

  describe('login scope uniqueness', () => {
    it('refuses a second integration with the same provider, tenant and application, ignoring case', async () => {
      const org = `cap-db-${randomUUID()}`
      const first = await insertIntegration({ orgId: org })
      const second = await insertIntegration({ orgId: org })
      await insertCapabilityRow(first.id, 'dingtalk', org, enabledLogin('CorpOne', 'AppOne'))
      for (const [tenant, appScope] of [['CorpOne', 'AppOne'], ['corpone', 'appone'], ['CORPONE', 'APPONE']]) {
        const error = await pgError(insertCapabilityRow(second.id, 'dingtalk', org, enabledLogin(tenant, appScope)))
        expect([error.code, error.constraint], `${tenant}/${appScope}`).toEqual(['23505', 'dic_login_scope_uniq'])
      }
    })

    it('admits a different application or tenant, the same scope under another provider, and the same scope for other capabilities', async () => {
      const org = `cap-db-${randomUUID()}`
      const first = await insertIntegration({ orgId: org })
      const second = await insertIntegration({ orgId: org })
      const third = await insertIntegration({ orgId: org, provider: 'wecom' })
      const fourth = await insertIntegration({ orgId: org })
      await insertCapabilityRow(first.id, 'dingtalk', org, enabledLogin('CorpOne', 'AppOne'))
      await insertCapabilityRow(second.id, 'dingtalk', org, enabledLogin('CorpOne', 'AppTwo'))
      await insertCapabilityRow(third.id, 'wecom', org, enabledLogin('CorpOne', 'AppOne'))
      await insertCapabilityRow(fourth.id, 'dingtalk', org, {
        notification_enabled: true, notification_bound_tenant: 'CorpOne', notification_bound_app_scope: 'AppOne',
        directory_enabled: true, directory_bound_tenant: 'CorpOne', directory_bound_app_scope: 'AppOne',
      })
    })

    it('frees the slot when the first integration turns login off', async () => {
      const org = `cap-db-${randomUUID()}`
      const first = await insertIntegration({ orgId: org })
      const second = await insertIntegration({ orgId: org })
      await insertCapabilityRow(first.id, 'dingtalk', org, enabledLogin('CorpOne', 'AppOne'))
      expect((await pgError(insertCapabilityRow(second.id, 'dingtalk', org, enabledLogin('CorpOne', 'AppOne')))).code).toBe('23505')
      await run(`UPDATE ${CAPS} SET login_enabled = false, login_bound_tenant = NULL, login_bound_app_scope = NULL, revision = revision + 1, updated_by = 'admin-2' WHERE integration_id = $1`, [first.id])
      await insertCapabilityRow(second.id, 'dingtalk', org, enabledLogin('CorpOne', 'AppOne'))
    })
  })
})
