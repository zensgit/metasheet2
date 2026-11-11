/**
 * User notification endpoints and preferences against real PostgreSQL: table structure and constraints,
 * the guarded down() and its round trip, the migration timeout round trip, the catalog snapshot, the
 * recipient resolver over real rows, and the endpoint and preference services.
 *
 * DATABASE_URL-gated. Cleanup order: preferences, endpoints, then the test integrations (the
 * references to directory_integrations are RESTRICT).
 */
import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import {
  down,
  up,
  USER_NOTIFICATION_DOWN_BLOCKED_CODE,
} from '../../src/db/migrations/zzzz20261111093417_create_user_notification_endpoints_preferences'
import { createRecipientResolver, type Db, type ResolveResult, type ResolvedTarget } from '../../src/notifications/recipient-resolver'
import { resolveProviderCapabilityDescriptor } from '../../src/integrations/provider-capability-registry'
import { findActiveOrgMembers } from '../../src/services/task-org-members'
import { createEndpointsService } from '../../src/notifications/endpoints-service'
import { createPreferencesService } from '../../src/notifications/preferences-service'
import { NotificationHttpError } from '../../src/notifications/notification-errors'
import type { AuditEvent, NotificationDbDeps } from '../../src/notifications/notification-tx'
import { createMeNotificationEndpointsRouter } from '../../src/routes/me-notification-endpoints'
import { createMeNotificationPreferencesRouter } from '../../src/routes/me-notification-preferences'
import { usePinnedServer } from '../utils/pinned-server'

// The real authentication is replaced by a header-driven stand-in; the routes under test read the user
// from req.user.id and the organization from req.authenticatedTenantId, exactly as the real one sets them.
vi.mock('../../src/middleware/auth', () => {
  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    const user = req.header('x-test-user')
    if (user) (req as unknown as { user: unknown }).user = { id: user, sub: 'not-the-user' }
    const tenant = req.header('x-test-tenant')
    if (tenant) (req as unknown as { authenticatedTenantId: string }).authenticatedTenantId = tenant
    next()
  }
  return { authenticate, default: authenticate }
})

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const EXPECT_DB = process.env.EXPECT_DB === '1'
const itIfExpectDb = EXPECT_DB ? it : it.skip

// Module top level: it must run (and fail) when the gated describe below is skipped for want of a database.
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const PREFIX = 'une-db'
const ENDPOINTS = 'user_notification_endpoints'
const PREFERENCES = 'user_notification_preferences'

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

const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex')

const ENDPOINT_CONSTRAINTS: ReadonlyArray<readonly [string, string]> = [
  ['une_conn_org_fk', 'FOREIGN KEY (connection_id, org_id) REFERENCES directory_integrations(id, org_id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ['une_conn_provider_fk', 'FOREIGN KEY (connection_id, provider) REFERENCES directory_integrations(id, provider) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ['une_id_conn_uniq', 'UNIQUE (id, connection_id)'],
  ['une_id_org_user_uniq', 'UNIQUE (id, org_id, user_id)'],
  ['une_proof_kind_chk', "CHECK ((proof_kind = ANY (ARRAY['directory_link'::text, 'external_identity'::text])))"],
  ['une_revision_chk', 'CHECK ((revision >= 1))'],
  ['une_revoked_chk', "CHECK (((status = 'revoked'::text) = (revoked_at IS NOT NULL)))"],
  [
    'une_shape_chk',
    "CHECK (((org_id ~ '^[!-~]+$'::text) AND (user_id ~ '^[!-~]+$'::text) AND (provider ~ '^[a-z][a-z0-9_]{0,31}$'::text) AND (address_kind ~ '^[a-z][a-z0-9_]{0,63}$'::text) AND (bound_tenant ~ '^[!-~]+$'::text) AND (bound_app_scope ~ '^[!-~]+$'::text) AND (char_length(bound_app_scope) <= 256) AND (proof_witness ~ '^[0-9a-f]{64}$'::text) AND (address_witness ~ '^[0-9a-f]{64}$'::text) AND (tenant_address_witness ~ '^[0-9a-f]{64}$'::text)))",
  ],
  ['une_status_chk', "CHECK ((status = ANY (ARRAY['active'::text, 'stale'::text, 'revoked'::text])))"],
  ['user_notification_endpoints_pkey', 'PRIMARY KEY (id)'],
]

const ENDPOINT_INDEXES: ReadonlyArray<readonly [string, string]> = [
  ['une_id_conn_uniq', 'CREATE UNIQUE INDEX une_id_conn_uniq ON public.user_notification_endpoints USING btree (id, connection_id)'],
  ['une_id_org_user_uniq', 'CREATE UNIQUE INDEX une_id_org_user_uniq ON public.user_notification_endpoints USING btree (id, org_id, user_id)'],
  ['une_proof_uniq', 'CREATE UNIQUE INDEX une_proof_uniq ON public.user_notification_endpoints USING btree (org_id, user_id, connection_id, address_kind, proof_kind)'],
  [
    'une_tenant_address_active_uniq',
    "CREATE UNIQUE INDEX une_tenant_address_active_uniq ON public.user_notification_endpoints USING btree (provider, bound_tenant, address_kind, tenant_address_witness) WHERE (status = 'active'::text)",
  ],
  ['une_user_idx', 'CREATE INDEX une_user_idx ON public.user_notification_endpoints USING btree (org_id, user_id)'],
  ['user_notification_endpoints_pkey', 'CREATE UNIQUE INDEX user_notification_endpoints_pkey ON public.user_notification_endpoints USING btree (id)'],
]

const PREFERENCE_CONSTRAINTS: ReadonlyArray<readonly [string, string]> = [
  ['unp_distinct_chk', 'CHECK (((fallback_endpoint_id IS NULL) OR ((primary_endpoint_id IS NOT NULL) AND (fallback_endpoint_id <> primary_endpoint_id))))'],
  ['unp_fallback_fk', 'FOREIGN KEY (fallback_endpoint_id, org_id, user_id) REFERENCES user_notification_endpoints(id, org_id, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ['unp_primary_fk', 'FOREIGN KEY (primary_endpoint_id, org_id, user_id) REFERENCES user_notification_endpoints(id, org_id, user_id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
  ['unp_quiet_all_or_none_chk', 'CHECK ((((quiet_start IS NULL) = (quiet_end IS NULL)) AND ((quiet_start IS NULL) = (quiet_timezone IS NULL))))'],
  ['unp_quiet_minute_chk', 'CHECK (((quiet_start IS NULL) OR ((EXTRACT(second FROM quiet_start) = (0)::numeric) AND (EXTRACT(second FROM quiet_end) = (0)::numeric))))'],
  ['unp_quiet_nonempty_chk', 'CHECK (((quiet_start IS NULL) OR (quiet_start <> quiet_end)))'],
  ['unp_quiet_tz_shape_chk', "CHECK (((quiet_timezone IS NULL) OR (quiet_timezone ~ '^[A-Za-z0-9_+/-]{1,64}$'::text)))"],
  ['unp_revision_chk', 'CHECK ((revision >= 1))'],
  [
    'unp_shape_chk',
    "CHECK (((org_id ~ '^[!-~]+$'::text) AND (user_id ~ '^[!-~]+$'::text) AND (topic ~ '^[a-z][a-z0-9_]{0,63}$'::text) AND (updated_by ~ '^[!-~]+$'::text)))",
  ],
  ['user_notification_preferences_pkey', 'PRIMARY KEY (org_id, user_id, topic)'],
]

const PREFERENCE_INDEXES: ReadonlyArray<readonly [string, string]> = [
  ['unp_fallback_idx', 'CREATE INDEX unp_fallback_idx ON public.user_notification_preferences USING btree (fallback_endpoint_id) WHERE (fallback_endpoint_id IS NOT NULL)'],
  ['unp_primary_idx', 'CREATE INDEX unp_primary_idx ON public.user_notification_preferences USING btree (primary_endpoint_id) WHERE (primary_endpoint_id IS NOT NULL)'],
  ['user_notification_preferences_pkey', 'CREATE UNIQUE INDEX user_notification_preferences_pkey ON public.user_notification_preferences USING btree (org_id, user_id, topic)'],
]

describeIfDatabase('user notification endpoints and preferences (real database)', () => {
  let pool: Pool
  let migrationPool: Pool
  let migrationDb: Kysely<unknown>
  const integrationIds: string[] = []

  const run = (text: string, values?: unknown[]) => pool.query(text, values)

  async function tablesExist(): Promise<boolean> {
    const result = await run(`SELECT to_regclass('${ENDPOINTS}') IS NOT NULL AS e, to_regclass('${PREFERENCES}') IS NOT NULL AS p`)
    return result.rows[0].e === true && result.rows[0].p === true
  }

  async function ensureTables(): Promise<void> {
    if (await tablesExist()) return
    await migrationDb.transaction().execute((trx) => up(trx))
  }

  async function insertIntegration(
    overrides: { provider?: string; orgId?: string; corp?: string; config?: unknown; status?: string } = {},
  ): Promise<{ id: string; org: string }> {
    const org = overrides.orgId ?? `${PREFIX}-org-${randomUUID()}`
    const result = await run(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id::text AS id`,
      [
        org,
        overrides.provider ?? 'dingtalk',
        `${PREFIX}-${randomUUID()}`,
        overrides.status ?? 'active',
        overrides.corp ?? 'CorpOne',
        JSON.stringify(overrides.config ?? { appKey: 'AppOne' }),
      ],
    )
    const id = result.rows[0].id as string
    integrationIds.push(id)
    return { id, org }
  }

  type EndpointRow = {
    org: string
    user: string
    connection: string
    provider?: string
    addressKind?: string
    proofKind?: string
    proofId?: string
    address?: string
    tenant?: string
    appScope?: string
    status?: string
    revision?: number
    revokedAt?: string | null
  }

  async function insertEndpoint(row: EndpointRow): Promise<string> {
    const address = row.address ?? randomUUID()
    const tenant = row.tenant ?? 'CorpOne'
    const status = row.status ?? 'active'
    const result = await run(
      `INSERT INTO ${ENDPOINTS}
         (org_id, user_id, connection_id, provider, address_kind, proof_kind, proof_id, proof_witness, address_witness,
          tenant_address_witness, bound_tenant, bound_app_scope, status, revision, revoked_at)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)
       RETURNING id::text AS id`,
      [
        row.org,
        row.user,
        row.connection,
        row.provider ?? 'dingtalk',
        row.addressKind ?? 'dingtalk_userid',
        row.proofKind ?? 'directory_link',
        row.proofId ?? randomUUID(),
        sha(`proof:${row.user}:${address}`),
        sha(`addr:${row.connection}:${address}`),
        sha(`tenant:${tenant}:${address}`),
        tenant,
        row.appScope ?? 'AppOne',
        status,
        row.revision ?? 1,
        row.revokedAt === undefined ? (status === 'revoked' ? new Date().toISOString() : null) : row.revokedAt,
      ],
    )
    return result.rows[0].id as string
  }

  async function insertPreference(over: {
    org: string
    user: string
    topic?: string
    primary?: string | null
    fallback?: string | null
    quiet?: { start: string; end: string; tz: string } | null
    columns?: Record<string, unknown>
  }): Promise<void> {
    const columns: Record<string, unknown> = {
      org_id: over.org,
      user_id: over.user,
      topic: over.topic ?? 'task_reminder',
      primary_endpoint_id: over.primary ?? null,
      fallback_endpoint_id: over.fallback ?? null,
      quiet_start: over.quiet?.start ?? null,
      quiet_end: over.quiet?.end ?? null,
      quiet_timezone: over.quiet?.tz ?? null,
      updated_by: over.user,
      ...(over.columns ?? {}),
    }
    const names = Object.keys(columns)
    await run(
      `INSERT INTO ${PREFERENCES} (${names.join(', ')}) VALUES (${names.map((_, index) => `$${index + 1}`).join(', ')})`,
      names.map((name) => columns[name]),
    )
  }

  async function makeUser(org: string, label = 'u', membership = true): Promise<string> {
    const id = `${PREFIX}-user-${label}-${randomUUID()}`
    await run(`INSERT INTO users (id, password_hash, is_active, activation_status) VALUES ($1, 'x', TRUE, 'activated')`, [id])
    if (membership) await run(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [id, org])
    return id
  }

  async function makeAccount(o: {
    integration: string
    provider?: string
    corp?: string | null
    externalUserId?: string
    unionId?: string | null
    user?: string | null
    linkStatus?: string
    active?: boolean
    id?: string
  }): Promise<{ accountId: string; linkId: string | null }> {
    const provider = o.provider ?? 'dingtalk'
    const account = await run(
      `INSERT INTO directory_accounts (id, integration_id, provider, corp_id, external_user_id, union_id, external_key, name, is_active)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2::uuid, $3, $4, $5, $6, $7, 'une-db account', $8)
       RETURNING id::text AS id`,
      [
        o.id ?? null,
        o.integration,
        provider,
        o.corp === undefined ? 'CorpOne' : o.corp,
        o.externalUserId ?? `ext-${randomUUID()}`,
        o.unionId ?? null,
        `${provider}:${PREFIX}:${randomUUID()}`,
        o.active ?? true,
      ],
    )
    const accountId = account.rows[0].id as string
    let linkId: string | null = null
    if (o.user !== undefined && o.user !== null) {
      const link = await run(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
         VALUES ($1::uuid, $2, $3) RETURNING id::text AS id`,
        [accountId, o.user, o.linkStatus ?? 'linked'],
      )
      linkId = link.rows[0].id as string
    }
    return { accountId, linkId }
  }

  const resolver = createRecipientResolver({ isActiveOrgMembers: (db, orgId, userIds) => findActiveOrgMembers(db, orgId, userIds) })
  const poolDb = (): Db => ({ query: (text, values) => pool.query(text, values) as unknown as ReturnType<Db['query']> })

  async function targetOf(org: string, user: string, connection: string): Promise<ResolvedTarget> {
    const result = await resolver.resolveForConnection(poolDb(), { orgId: org, userId: user, connectionId: connection, proofKind: 'directory_link' })
    if (result.ok === false) throw new Error(`expected a target, got ${result.code}`)
    return result.target
  }

  async function endpointFromTarget(org: string, user: string, target: ResolvedTarget): Promise<string> {
    const result = await run(
      `INSERT INTO ${ENDPOINTS}
         (org_id, user_id, connection_id, provider, address_kind, proof_kind, proof_id, proof_witness, address_witness,
          tenant_address_witness, bound_tenant, bound_app_scope)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12) RETURNING id::text AS id`,
      [org, user, target.connectionId, target.provider, target.addressKind, target.proofKind, target.proofId,
        target.proofWitness, target.addressWitness, target.tenantAddressWitness, target.boundTenant, target.boundAppScope],
    )
    return result.rows[0].id as string
  }

  const codeOf = (result: ResolveResult): string => (result.ok === true ? 'ok' : result.code)

  const audits: AuditEvent[] = []
  const auditSink = async (event: AuditEvent): Promise<void> => {
    audits.push(event)
  }
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  /** A transaction runner over a pool; `intercept` sees every statement of the transaction before it runs. */
  function transactionOver(source: Pool, intercept?: (statement: string, state: { count: number; locks?: number }) => Promise<void>): NotificationDbDeps['transaction'] {
    return async <T>(fn: (client: Db) => Promise<T>): Promise<T> => {
      const client = await source.connect()
      const state: { count: number; locks?: number } = { count: 0 }
      try {
        await client.query('BEGIN')
        const wrapped: Db = {
          query: async (statement, values) => {
            if (intercept) await intercept(statement, state)
            state.count += 1
            return client.query(statement, values) as unknown as ReturnType<Db['query']>
          },
        }
        const out = await fn(wrapped)
        await client.query('COMMIT')
        return out
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // the original error is the one to report
        }
        throw error
      } finally {
        client.release()
      }
    }
  }

  function services(over: Partial<NotificationDbDeps> = {}) {
    const base: NotificationDbDeps = { db: poolDb(), transaction: transactionOver(pool) }
    const deps = { ...base, ...over, resolver, audit: auditSink }
    return { endpoints: createEndpointsService(deps), preferences: createPreferencesService(deps) }
  }

  /** One organization, one connection with its own tenant, and users that each own an account on it. */
  async function scene(userCount = 1, extra: { corp?: string; externalPrefix?: string } = {}) {
    const corp = extra.corp ?? `Corp-${randomUUID()}`
    const integration = await insertIntegration({ corp })
    const users: string[] = []
    const accounts: Array<{ accountId: string; linkId: string | null; external: string }> = []
    for (let index = 0; index < userCount; index += 1) {
      const user = await makeUser(integration.org, `s${index}`)
      const external = `${extra.externalPrefix ?? 'dt'}-${randomUUID()}`
      const account = await makeAccount({ integration: integration.id, corp, user, externalUserId: external })
      users.push(user)
      accounts.push({ ...account, external })
    }
    return { corp, ...integration, users, accounts }
  }

  const establish = (svc: ReturnType<typeof services>, org: string, user: string, connection: string) =>
    svc.endpoints.establish({ orgId: org, userId: user, connectionId: connection, proofKind: 'directory_link' })

  const rowsOf = async (table: string, where: string, values: unknown[]) =>
    (await run(`SELECT * FROM ${table} WHERE ${where}`, values)).rows

  async function failureOf(promise: Promise<unknown>): Promise<NotificationHttpError> {
    try {
      await promise
    } catch (error) {
      expect(error).toBeInstanceOf(NotificationHttpError)
      return error as NotificationHttpError
    }
    throw new Error('expected the call to fail')
  }

  /** Holds the user lock of (org, user) in a separate transaction until `release` is called. */
  async function holdUserLock(org: string, user: string): Promise<() => Promise<void>> {
    const client = await pool.connect()
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('notif-user:' || $1::text), hashtext($2::text))`, [org, user])
    return async () => {
      await client.query('COMMIT')
      client.release()
    }
  }

  /** Runs `operation` while the user lock is held elsewhere and asserts it waits for that lock. */
  async function expectWaitsForUserLock(org: string, user: string, operation: () => Promise<unknown>): Promise<void> {
    const release = await holdUserLock(org, user)
    let settled = false
    const running = operation().then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    let waiting = false
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && !settled) {
      const result = await run(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)
      if (result.rows[0].n > 0) {
        waiting = true
        break
      }
      await sleep(25)
    }
    const completedWhileHeld = settled
    await release()
    await running
    expect({ waiting, completedWhileHeld }).toEqual({ waiting: true, completedWhileHeld: false })
  }

  async function cleanup(): Promise<void> {
    if (!(await tablesExist())) await migrationDb.transaction().execute((trx) => up(trx))
    await run(`DELETE FROM ${PREFERENCES} WHERE org_id LIKE $1`, [`${PREFIX}-%`])
    await run(`DELETE FROM ${ENDPOINTS} WHERE org_id LIKE $1`, [`${PREFIX}-%`])
    await run('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [integrationIds])
    integrationIds.length = 0
    await run('DELETE FROM user_external_identities WHERE local_user_id LIKE $1', [`${PREFIX}-%`])
    await run('DELETE FROM user_orgs WHERE user_id LIKE $1', [`${PREFIX}-%`])
    await run('DELETE FROM users WHERE id LIKE $1', [`${PREFIX}-%`])
  }

  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl })
    migrationPool = new Pool({ connectionString: dbUrl, max: 1 })
    migrationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: migrationPool }) })
  })

  beforeEach(async () => {
    audits.length = 0
    await ensureTables()
  })

  afterEach(async () => {
    await cleanup()
  })

  afterAll(async () => {
    await migrationDb.destroy()
    await pool.end()
  })

  describe('#1 structure', () => {
    it('refuses rows that break a shape or closed-set check, naming the constraint', async () => {
      const { id: connection, org } = await insertIntegration()
      const bad: Array<[string, Partial<EndpointRow>, string]> = [
        ['une_shape_chk', { user: 'user with space' }, 'user id shape'],
        ['une_shape_chk', { user: 'u1', provider: 'DingTalk' }, 'provider shape'],
        ['une_shape_chk', { user: 'u1', addressKind: 'Bad Kind' }, 'address kind shape'],
        ['une_shape_chk', { user: 'u1', tenant: '' }, 'empty tenant'],
        ['une_shape_chk', { user: 'u1', appScope: 'x'.repeat(257) }, 'app scope length'],
        ['une_proof_kind_chk', { user: 'u1', proofKind: 'email' }, 'proof kind'],
        ['une_status_chk', { user: 'u1', status: 'gone' }, 'status'],
        ['une_revision_chk', { user: 'u1', revision: 0 }, 'revision'],
        ['une_revoked_chk', { user: 'u1', status: 'revoked', revokedAt: null }, 'revoked without timestamp'],
        ['une_revoked_chk', { user: 'u1', status: 'active', revokedAt: new Date().toISOString() }, 'timestamp without revoked'],
      ]
      for (const [constraint, overrides, label] of bad) {
        const error = await pgError(insertEndpoint({ org, connection, ...overrides, user: overrides.user ?? 'u1' }))
        expect([label, error.code, error.constraint]).toEqual([label, '23514', constraint])
      }
      for (const column of ['proof_witness', 'address_witness', 'tenant_address_witness']) {
        const error = await pgError(
          run(
            `INSERT INTO ${ENDPOINTS} (org_id, user_id, connection_id, provider, address_kind, proof_kind, proof_id,
               proof_witness, address_witness, tenant_address_witness, bound_tenant, bound_app_scope)
             VALUES ($1, 'u1', $2::uuid, 'dingtalk', 'dingtalk_userid', 'directory_link', $3::uuid,
               ${column === 'proof_witness' ? "'XYZ'" : `'${sha('a')}'`},
               ${column === 'address_witness' ? "'XYZ'" : `'${sha('b')}'`},
               ${column === 'tenant_address_witness' ? "'XYZ'" : `'${sha('c')}'`}, 'CorpOne', 'AppOne')`,
            [org, connection, randomUUID()],
          ),
        )
        expect([column, error.code, error.constraint]).toEqual([column, '23514', 'une_shape_chk'])
      }
    })

    it('ties an endpoint to the organization and the provider of its connection', async () => {
      const { id: connection, org } = await insertIntegration()
      const otherOrg = await pgError(insertEndpoint({ org: `${PREFIX}-org-${randomUUID()}`, user: 'u1', connection }))
      expect([otherOrg.code, otherOrg.constraint]).toEqual(['23503', 'une_conn_org_fk'])
      const otherProvider = await pgError(insertEndpoint({ org, user: 'u1', connection, provider: 'wecom' }))
      expect([otherProvider.code, otherProvider.constraint]).toEqual(['23503', 'une_conn_provider_fk'])
    })

    it('ties a preference to endpoints of the same organization and the same user', async () => {
      const a = await insertIntegration()
      const b = await insertIntegration()
      const mine = await insertEndpoint({ org: a.org, user: 'u1', connection: a.id })
      const otherUser = await insertEndpoint({ org: a.org, user: 'u2', connection: a.id, address: 'other-user' })
      const otherOrg = await insertEndpoint({ org: b.org, user: 'u1', connection: b.id, address: 'other-org' })
      await insertPreference({ org: a.org, user: 'u1', primary: mine })
      for (const [label, column, endpoint, constraint] of [
        ['primary of another user', 'primary', otherUser, 'unp_primary_fk'],
        ['primary of another organization', 'primary', otherOrg, 'unp_primary_fk'],
        ['fallback of another user', 'fallback', otherUser, 'unp_fallback_fk'],
        ['fallback of another organization', 'fallback', otherOrg, 'unp_fallback_fk'],
      ] as const) {
        const error = await pgError(
          insertPreference({
            org: a.org,
            user: 'u1',
            topic: `topic_${label.replace(/\W/g, '_')}`,
            primary: column === 'primary' ? endpoint : mine,
            fallback: column === 'fallback' ? endpoint : null,
          }),
        )
        expect([label, error.code, error.constraint]).toEqual([label, '23503', constraint])
      }
    })

    it('keeps one active endpoint per address within a provider and tenant, across users, connections and organizations', async () => {
      const first = await insertIntegration({ corp: 'CorpShared' })
      const second = await insertIntegration({ corp: 'CorpShared', orgId: first.org, config: { appKey: 'AppTwo' } })
      const crossOrg = await insertIntegration({ corp: 'CorpShared' })
      const base = { tenant: 'CorpShared', address: 'shared-address' }
      const winner = await insertEndpoint({ org: first.org, user: 'u1', connection: first.id, ...base })
      const sameConnectionOtherUser = await pgError(insertEndpoint({ org: first.org, user: 'u2', connection: first.id, ...base }))
      const otherConnectionOtherUser = await pgError(insertEndpoint({ org: first.org, user: 'u2', connection: second.id, ...base }))
      const otherConnectionSameUser = await pgError(insertEndpoint({ org: first.org, user: 'u1', connection: second.id, ...base }))
      const otherOrganization = await pgError(insertEndpoint({ org: crossOrg.org, user: 'u3', connection: crossOrg.id, ...base }))
      for (const error of [sameConnectionOtherUser, otherConnectionOtherUser, otherConnectionSameUser, otherOrganization]) {
        expect([error.code, error.constraint]).toEqual(['23505', 'une_tenant_address_active_uniq'])
      }
      await run(`UPDATE ${ENDPOINTS} SET status = 'stale' WHERE id = $1::uuid`, [winner])
      await insertEndpoint({ org: first.org, user: 'u2', connection: second.id, ...base })
      const reused = await pgError(insertEndpoint({ org: first.org, user: 'u2', connection: second.id, ...base }))
      expect([reused.code, reused.constraint]).toEqual(['23505', 'une_proof_uniq'])
    })

    it('keeps preference constraints: distinct endpoints, a primary for any fallback, and the quiet-hours shape', async () => {
      const { id: connection, org } = await insertIntegration()
      const one = await insertEndpoint({ org, user: 'u1', connection, address: 'one' })
      const two = await insertEndpoint({ org, user: 'u1', connection, address: 'two', proofKind: 'external_identity' })
      const cases: Array<[string, Parameters<typeof insertPreference>[0], string]> = [
        ['same endpoint twice', { org, user: 'u1', primary: one, fallback: one }, 'unp_distinct_chk'],
        ['fallback without primary', { org, user: 'u1', primary: null, fallback: one }, 'unp_distinct_chk'],
        ['start without end and zone', { org, user: 'u1', columns: { quiet_start: '22:00' } }, 'unp_quiet_all_or_none_chk'],
        ['zone without times', { org, user: 'u1', columns: { quiet_timezone: 'Asia/Shanghai' } }, 'unp_quiet_all_or_none_chk'],
        ['equal start and end', { org, user: 'u1', quiet: { start: '08:00', end: '08:00', tz: 'Asia/Shanghai' } }, 'unp_quiet_nonempty_chk'],
        ['non-zero seconds', { org, user: 'u1', quiet: { start: '08:00:30', end: '09:00', tz: 'Asia/Shanghai' } }, 'unp_quiet_minute_chk'],
        ['zone shape', { org, user: 'u1', quiet: { start: '08:00', end: '09:00', tz: 'Not a zone!' } }, 'unp_quiet_tz_shape_chk'],
        ['revision', { org, user: 'u1', columns: { revision: 0 } }, 'unp_revision_chk'],
        ['topic shape', { org, user: 'u1', topic: 'Bad Topic' }, 'unp_shape_chk'],
        ['updated_by shape', { org, user: 'u1', columns: { updated_by: 'has space' } }, 'unp_shape_chk'],
      ]
      for (const [label, input, constraint] of cases) {
        const error = await pgError(insertPreference({ topic: 'task_reminder', ...input }))
        expect([label, error.code, error.constraint]).toEqual([label, '23514', constraint])
      }
      await insertPreference({ org, user: 'u1', primary: one, fallback: two, quiet: { start: '22:00', end: '08:00', tz: 'Asia/Shanghai' } })
    })

    it('refuses to delete a connection or an endpoint that a row still references', async () => {
      const { id: connection, org } = await insertIntegration()
      const endpoint = await insertEndpoint({ org, user: 'u1', connection })
      const connectionDelete = await pgError(run('DELETE FROM directory_integrations WHERE id = $1::uuid', [connection]))
      expect(connectionDelete.code).toBe('23503')
      expect(['une_conn_org_fk', 'une_conn_provider_fk']).toContain(connectionDelete.constraint)
      await insertPreference({ org, user: 'u1', primary: endpoint })
      const endpointDelete = await pgError(run(`DELETE FROM ${ENDPOINTS} WHERE id = $1::uuid`, [endpoint]))
      expect([endpointDelete.code, endpointDelete.constraint]).toEqual(['23503', 'unp_primary_fk'])
    })
  })

  describe('#2 down guard and round trip', () => {
    it('refuses while a table holds a row, and round-trips on empty tables', async () => {
      const { id: connection, org } = await insertIntegration()
      const endpoint = await insertEndpoint({ org, user: 'u1', connection })
      let error = await pgError(migrationDb.transaction().execute((trx) => down(trx)))
      expect(error.code).toBe(USER_NOTIFICATION_DOWN_BLOCKED_CODE)
      expect(error.message).not.toMatch(/u1|dingtalk/)
      await run(`DELETE FROM ${ENDPOINTS} WHERE id = $1::uuid`, [endpoint])
      await insertPreference({ org, user: 'u1' })
      error = await pgError(migrationDb.transaction().execute((trx) => down(trx)))
      expect(error.code).toBe(USER_NOTIFICATION_DOWN_BLOCKED_CODE)
      await run(`DELETE FROM ${PREFERENCES} WHERE org_id = $1`, [org])
      try {
        await migrationDb.transaction().execute((trx) => down(trx))
        expect(await tablesExist()).toBe(false)
        await migrationDb.transaction().execute((trx) => up(trx))
        expect(await tablesExist()).toBe(true)
      } finally {
        await ensureTables()
      }
    })
  })


  describe('#3 resolution against live rows', () => {
    async function world() {
      const corp = `Corp-${randomUUID()}`
      const integration = await insertIntegration({ corp })
      const user = await makeUser(integration.org)
      const account = await makeAccount({ integration: integration.id, corp, user, externalUserId: 'dt-user-1', unionId: 'union-1' })
      const target = await targetOf(integration.org, user, integration.id)
      const endpoint = await endpointFromTarget(integration.org, user, target)
      return { ...integration, corp, user, ...account, target, endpoint }
    }
    const verify = async (w: { org: string; user: string; endpoint: string }) =>
      codeOf(await resolver.verifyEndpoint(poolDb(), { orgId: w.org, userId: w.user, endpointId: w.endpoint }))

    it('re-checks a healthy endpoint as ok', async () => {
      const w = await world()
      expect(await verify(w)).toBe('ok')
    })

    it('a link moved to another user is proof_wrong_user', async () => {
      const w = await world()
      const other = await makeUser(w.org, 'other')
      await run('UPDATE directory_account_links SET local_user_id = $1 WHERE id = $2::uuid', [other, w.linkId])
      expect(await verify(w)).toBe('proof_wrong_user')
    })

    it('a link whose status changed is proof_not_linked', async () => {
      const w = await world()
      await run(`UPDATE directory_account_links SET link_status = 'pending' WHERE id = $1::uuid`, [w.linkId])
      expect(await verify(w)).toBe('proof_not_linked')
    })

    it('an administrator unbind is proof_not_linked for the endpoint and proof_missing for a new resolution', async () => {
      const w = await world()
      await run(
        `UPDATE directory_account_links SET local_user_id = NULL, link_status = 'unmatched', match_strategy = 'manual_unbound' WHERE id = $1::uuid`,
        [w.linkId],
      )
      expect(await verify(w)).toBe('proof_not_linked')
      const fresh = await resolver.resolveForConnection(poolDb(), { orgId: w.org, userId: w.user, connectionId: w.id, proofKind: 'directory_link' })
      expect(codeOf(fresh)).toBe('proof_missing')
    })

    it('a deactivated account is proof_account_inactive', async () => {
      const w = await world()
      await run('UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid', [w.accountId])
      expect(await verify(w)).toBe('proof_account_inactive')
      const fresh = await resolver.resolveForConnection(poolDb(), { orgId: w.org, userId: w.user, connectionId: w.id, proofKind: 'directory_link' })
      expect(codeOf(fresh)).toBe('proof_account_inactive')
    })

    it('a deactivated integration is connection_inactive', async () => {
      const w = await world()
      await run(`UPDATE directory_integrations SET status = 'inactive' WHERE id = $1::uuid`, [w.id])
      expect(await verify(w)).toBe('connection_inactive')
      const fresh = await resolver.resolveForConnection(poolDb(), { orgId: w.org, userId: w.user, connectionId: w.id, proofKind: 'directory_link' })
      expect(codeOf(fresh)).toBe('connection_inactive')
    })

    it('a second linked account on the same connection is proof_ambiguous', async () => {
      const w = await world()
      await makeAccount({ integration: w.id, corp: w.corp, user: w.user, externalUserId: 'dt-user-2' })
      const fresh = await resolver.resolveForConnection(poolDb(), { orgId: w.org, userId: w.user, connectionId: w.id, proofKind: 'directory_link' })
      expect(codeOf(fresh)).toBe('proof_ambiguous')
    })

    it('a connection of another organization is not found', async () => {
      const w = await world()
      const fresh = await resolver.resolveForConnection(poolDb(), { orgId: `${PREFIX}-org-elsewhere`, userId: w.user, connectionId: w.id, proofKind: 'directory_link' })
      expect(codeOf(fresh)).toBe('connection_not_found')
    })

    it('a user who is recycled, deactivated, or deactivated in the organization is not an active member', async () => {
      for (const change of [
        (w: { user: string; org: string }) => run('UPDATE users SET deleted_at = now() WHERE id = $1', [w.user]),
        (w: { user: string; org: string }) => run('UPDATE users SET is_active = FALSE WHERE id = $1', [w.user]),
        (w: { user: string; org: string }) => run('UPDATE user_orgs SET is_active = FALSE WHERE user_id = $1 AND org_id = $2', [w.user, w.org]),
      ]) {
        const w = await world()
        await change(w)
        const fresh = await resolver.resolveForConnection(poolDb(), { orgId: w.org, userId: w.user, connectionId: w.id, proofKind: 'directory_link' })
        expect(codeOf(fresh)).toBe('user_not_active_member')
        expect(await verify(w)).toBe('user_not_active_member')
      }
    })

    it('a changed application key (scope anchor) is scope_changed', async () => {
      const w = await world()
      await run(`UPDATE directory_integrations SET config = '{"appKey":"AppTwo"}'::jsonb WHERE id = $1::uuid`, [w.id])
      expect(await verify(w)).toBe('scope_changed')
    })

    it('an account without a corp id is no proof: scope_unproven for a new resolution and a failed re-check', async () => {
      const w = await world()
      await run('UPDATE directory_accounts SET corp_id = NULL WHERE id = $1::uuid', [w.accountId])
      const fresh = await resolver.resolveForConnection(poolDb(), { orgId: w.org, userId: w.user, connectionId: w.id, proofKind: 'directory_link' })
      expect(codeOf(fresh)).toBe('scope_unproven')
      expect(await verify(w)).not.toBe('ok')
    })

    it('a changed union id (the identifier now belongs to someone else) is proof_changed', async () => {
      const w = await world()
      await run(`UPDATE directory_accounts SET union_id = 'union-2' WHERE id = $1::uuid`, [w.accountId])
      expect(await verify(w)).toBe('proof_changed')
    })

    it('an account moved to another integration is scope_changed', async () => {
      const w = await world()
      const target = await insertIntegration({ orgId: w.org })
      await run('UPDATE directory_accounts SET integration_id = $1::uuid WHERE id = $2::uuid', [target.id, w.accountId])
      expect(await verify(w)).toBe('scope_changed')
    })

    it('an endpoint of another user, of another organization and an unknown id read the same: endpoint_not_found', async () => {
      const w = await world()
      const other = await makeUser(w.org, 'other')
      const results = await Promise.all([
        resolver.verifyEndpoint(poolDb(), { orgId: w.org, userId: other, endpointId: w.endpoint }),
        resolver.verifyEndpoint(poolDb(), { orgId: `${PREFIX}-org-elsewhere`, userId: w.user, endpointId: w.endpoint }),
        resolver.verifyEndpoint(poolDb(), { orgId: w.org, userId: w.user, endpointId: randomUUID() }),
      ])
      expect(results).toEqual([
        { ok: false, code: 'endpoint_not_found' },
        { ok: false, code: 'endpoint_not_found' },
        { ok: false, code: 'endpoint_not_found' },
      ])
    })
  })

  describe('#10 candidate filtering happens before truncation', () => {
    const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const resolveOne = async (org: string, user: string, connection: string) =>
      codeOf(await resolver.resolveForConnection(poolDb(), { orgId: org, userId: user, connectionId: connection, proofKind: 'directory_link' }))

    it('two valid rows among invalid ones are ambiguous; one valid row after three invalid ones is used', async () => {
      const a = await insertIntegration()
      const user = await makeUser(a.org)
      await makeAccount({ integration: a.id, user, id: idOf(1), linkStatus: 'pending' })
      await makeAccount({ integration: a.id, user, id: idOf(2), active: false })
      await makeAccount({ integration: a.id, user, id: idOf(3), linkStatus: 'pending' })
      await makeAccount({ integration: a.id, user, id: idOf(4) })
      expect(await resolveOne(a.org, user, a.id)).toBe('ok')
      await makeAccount({ integration: a.id, user, id: idOf(5) })
      expect(await resolveOne(a.org, user, a.id)).toBe('proof_ambiguous')
    })

    it('names the reason of a zero-candidate request from the diagnostic statement', async () => {
      const a = await insertIntegration()
      const missing = await makeUser(a.org, 'missing')
      expect(await resolveOne(a.org, missing, a.id)).toBe('proof_missing')
      const pending = await makeUser(a.org, 'pending')
      await makeAccount({ integration: a.id, user: pending, linkStatus: 'pending' })
      expect(await resolveOne(a.org, pending, a.id)).toBe('proof_not_linked')
      const inactive = await makeUser(a.org, 'inactive')
      await makeAccount({ integration: a.id, user: inactive, active: false })
      expect(await resolveOne(a.org, inactive, a.id)).toBe('proof_account_inactive')
      const mismatch = await makeUser(a.org, 'mismatch')
      await makeAccount({ integration: a.id, user: mismatch, corp: 'CorpOther' })
      expect(await resolveOne(a.org, mismatch, a.id)).toBe('scope_unproven')
      const closed = await insertIntegration({ orgId: a.org, status: 'inactive' })
      const user = await makeUser(a.org, 'closed')
      await makeAccount({ integration: closed.id, user })
      expect(await resolveOne(a.org, user, closed.id)).toBe('connection_inactive')
      expect(await resolveOne(a.org, user, randomUUID())).toBe('connection_not_found')
    })
  })

  describe('#14 the resolver loads only the configuration keys the scope anchor reads', () => {
    it('returns a projected configuration and never a credential value', async () => {
      const integration = await insertIntegration({ config: { appKey: 'AppOne', appSecret: 'SECRET-VALUE', baseUrl: 'https://example.invalid' } })
      const user = await makeUser(integration.org)
      await makeAccount({ integration: integration.id, user })
      const returned: unknown[] = []
      const seen: Db = {
        query: async (text, values) => {
          const result = await pool.query(text, values)
          returned.push(...result.rows)
          return result as unknown as { rows: Array<Record<string, unknown>> }
        },
      }
      const result = await resolver.resolveForConnection(seen, { orgId: integration.org, userId: user, connectionId: integration.id, proofKind: 'directory_link' })
      expect(result.ok).toBe(true)
      expect(JSON.stringify(returned)).not.toContain('SECRET-VALUE')
      expect(JSON.stringify(returned)).not.toContain('example.invalid')
      const projected = returned.find((row) => (row as { scope_config?: unknown }).scope_config !== undefined) as { scope_config: unknown }
      expect(projected.scope_config).toEqual({ appKey: 'AppOne' })
      const descriptor = resolveProviderCapabilityDescriptor('dingtalk')!
      const full = { appKey: 'AppOne', appSecret: 'x', baseUrl: 'y' }
      expect(descriptor.scopeOf({ corp_id: 'CorpOne', config: { appKey: 'AppOne' } })).toEqual(descriptor.scopeOf({ corp_id: 'CorpOne', config: full }))
    })
  })

  describe('#17 set-based resolution over real rows', () => {
    const USERS = 300

    async function bulkWorld() {
      const one = await insertIntegration()
      const two = await insertIntegration({ orgId: one.org, config: { appKey: 'AppTwo' } })
      const stem = `${PREFIX}-bulk-${randomUUID()}`
      await run(`INSERT INTO users (id, password_hash, is_active, activation_status) SELECT $1 || '-' || g, 'x', TRUE, 'activated' FROM generate_series(1, $2::int) g`, [stem, USERS])
      await run(`INSERT INTO user_orgs (user_id, org_id, is_active) SELECT $1 || '-' || g, $3, TRUE FROM generate_series(1, $2::int) g`, [stem, USERS, one.org])
      for (const integration of [one, two]) {
        await run(
          `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
           SELECT $1::uuid, 'dingtalk', 'CorpOne', 'dt-' || g, 'dingtalk:' || $2 || ':' || g || ':' || $3, 'bulk', TRUE FROM generate_series(1, $4::int) g`,
          [integration.id, stem, integration.id, USERS],
        )
        await run(
          `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
           SELECT a.id, $2 || '-' || substring(a.external_user_id FROM 4), 'linked'
             FROM directory_accounts a WHERE a.integration_id = $1::uuid`,
          [integration.id, stem],
        )
      }
      const user = (n: number) => `${stem}-${n}`
      // Ambiguity (a second linked account), deactivation, unbind and a NULL corp id on distinct users.
      await makeAccount({ integration: one.id, user: user(1), externalUserId: 'dt-extra-1' })
      await run(`UPDATE directory_accounts SET is_active = FALSE WHERE integration_id = $1::uuid AND external_user_id = 'dt-2'`, [one.id])
      await run(
        `UPDATE directory_account_links SET local_user_id = NULL, link_status = 'unmatched', match_strategy = 'manual_unbound'
          WHERE directory_account_id = (SELECT id FROM directory_accounts WHERE integration_id = $1::uuid AND external_user_id = 'dt-3')`,
        [one.id],
      )
      await run(`UPDATE directory_accounts SET corp_id = NULL WHERE integration_id = $1::uuid AND external_user_id = 'dt-4'`, [one.id])
      return { one, two, user }
    }

    function counting(): { db: Db; count: () => number } {
      let count = 0
      return {
        db: {
          query: (text, values) => {
            count += 1
            return pool.query(text, values) as unknown as ReturnType<Db['query']>
          },
        },
        count: () => count,
      }
    }

    it('answers every user at once, equal to one-by-one answers, with a statement count that does not depend on the user count', async () => {
      const { one, two, user } = await bulkWorld()
      const requests = [one, two].flatMap((integration) =>
        Array.from({ length: USERS }, (_, index) => ({ userId: user(index + 1), connectionId: integration.id, proofKind: 'directory_link' as const })),
      )
      const everyone = counting()
      const all = await resolver.resolveMany(everyone.db, { orgId: one.org, requests })
      const sample = [0, 1, 2, 3, 4, 5, 150, USERS - 1, USERS, USERS + 1, USERS + 2, 2 * USERS - 1]
      for (const index of sample) {
        const single = await resolver.resolveMany(poolDb(), { orgId: one.org, requests: [requests[index]] })
        expect(JSON.stringify(all[index])).toEqual(JSON.stringify(single[0]))
      }
      expect(codeOf(all[0])).toBe('proof_ambiguous')
      expect(codeOf(all[1])).toBe('proof_account_inactive')
      expect(codeOf(all[2])).toBe('proof_missing')
      expect(codeOf(all[3])).toBe('scope_unproven')
      expect(codeOf(all[4])).toBe('ok')
      const small = counting()
      await resolver.resolveMany(small.db, { orgId: one.org, requests: requests.slice(0, 6) })
      expect(everyone.count()).toBe(small.count())

      const duplicated = counting()
      const doubled = await resolver.resolveMany(duplicated.db, { orgId: one.org, requests: [...requests.slice(4, 6), ...requests.slice(4, 6)] })
      expect(doubled.map(codeOf)).toEqual(['ok', 'ok', 'ok', 'ok'])
      expect(duplicated.count()).toBe(2)

      const defaults = counting()
      const derived = await resolver.deriveDefaultTargets(defaults.db, { orgId: one.org, connectionId: one.id, userIds: Array.from({ length: USERS }, (_, i) => user(i + 1)) })
      expect(derived.map(codeOf)).toEqual(all.slice(0, USERS).map(codeOf))

      const stored: Array<{ endpointId: string; userId: string }> = []
      const okRequests = requests.filter((_, index) => codeOf(all[index]) === 'ok').slice(0, 40)
      for (const request of okRequests) {
        const t = await targetOf(one.org, request.userId, request.connectionId)
        stored.push({ endpointId: await endpointFromTarget(one.org, request.userId, t), userId: request.userId })
      }
      const bigVerify = counting()
      const verified = await resolver.verifyEndpoints(bigVerify.db, { orgId: one.org, refs: stored })
      expect(verified.map(codeOf)).toEqual(stored.map(() => 'ok'))
      const smallVerify = counting()
      await resolver.verifyEndpoints(smallVerify.db, { orgId: one.org, refs: stored.slice(0, 2) })
      expect(bigVerify.count()).toBe(smallVerify.count())
    })
  })


  describe('#4 creating and refreshing endpoints', () => {
    it('eight parallel requests make one row and leave its revision at 1', async () => {
      const w = await scene()
      const svc = services()
      const results = await Promise.all(Array.from({ length: 8 }, () => establish(svc, w.org, w.users[0], w.id)))
      expect(results.filter((result) => result.created)).toHaveLength(1)
      const rows = await rowsOf(ENDPOINTS, 'org_id = $1', [w.org])
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].revision)).toBe(1)
      expect(JSON.stringify(results)).not.toContain(w.accounts[0].external)
    })

    it('an unchanged repeat keeps the revision; a revoked endpoint is re-enabled as the same row with revision + 1', async () => {
      const w = await scene()
      const svc = services()
      const first = await establish(svc, w.org, w.users[0], w.id)
      const again = await establish(svc, w.org, w.users[0], w.id)
      expect([first.created, again.created, again.endpoint.revision]).toEqual([true, false, 1])
      await svc.endpoints.revoke({ orgId: w.org, userId: w.users[0], endpointId: first.endpoint.id })
      const back = await establish(svc, w.org, w.users[0], w.id)
      expect([back.endpoint.id, back.endpoint.status, back.endpoint.revision, back.created]).toEqual([first.endpoint.id, 'active', 3, false])
      expect(await rowsOf(ENDPOINTS, 'org_id = $1', [w.org])).toHaveLength(1)
    })

    it('a request carries no identifier, and the answer and the audit carry none either', async () => {
      const w = await scene()
      const svc = services()
      const result = await establish(svc, w.org, w.users[0], w.id)
      const row = (await rowsOf(ENDPOINTS, 'id = $1::uuid', [result.endpoint.id]))[0]
      const text = JSON.stringify([result, audits])
      for (const secret of [w.accounts[0].external, row.address_witness, row.tenant_address_witness, row.proof_witness, row.proof_id]) {
        expect(text).not.toContain(String(secret))
      }
    })

    it('an address that changed hands: the new holder is made, the old endpoint becomes stale, audited as a system demotion', async () => {
      const w = await scene(2)
      const svc = services()
      const [a, b] = w.users
      const mine = await establish(svc, w.org, a, w.id)
      await run('UPDATE directory_account_links SET local_user_id = $1 WHERE id = $2::uuid', [b, w.accounts[0].linkId])
      await run('DELETE FROM directory_account_links WHERE id = $1::uuid', [w.accounts[1].linkId])
      const theirs = await establish(svc, w.org, b, w.id)
      expect(theirs.created).toBe(true)
      const old = (await rowsOf(ENDPOINTS, 'id = $1::uuid', [mine.endpoint.id]))[0]
      expect([old.status, Number(old.revision)]).toEqual(['stale', 2])
      const demote = audits.find((event) => event.action === 'notification.endpoint.demote')
      expect(demote).toMatchObject({ actorType: 'system', resourceId: mine.endpoint.id, meta: { reason: 'address_rebound' } })
      expect(demote?.actorId).toBeUndefined()
    })

    async function twoConnections(options: { sameUser: boolean }) {
      const corp = `Corp-${randomUUID()}`
      const first = await insertIntegration({ corp })
      const second = await insertIntegration({ corp, orgId: first.org, config: { appKey: 'AppTwo' } })
      const a = await makeUser(first.org, 'a')
      const b = options.sameUser ? a : await makeUser(first.org, 'b')
      const external = `dt-${randomUUID()}`
      const x1 = await makeAccount({ integration: first.id, corp, user: a, externalUserId: external })
      const x2 = await makeAccount({ integration: second.id, corp, user: b, externalUserId: external })
      return { org: first.org, first, second, a, b, x1, x2, corp, external }
    }

    it("another user's endpoint that still holds the address in this tenant is a 409 ADDRESS_ALREADY_BOUND", async () => {
      const w = await twoConnections({ sameUser: false })
      const svc = services()
      await establish(svc, w.org, w.a, w.first.id)
      const error = await failureOf(establish(svc, w.org, w.b, w.second.id))
      expect([error.status, error.code, error.details]).toEqual([409, 'ADDRESS_ALREADY_BOUND', undefined])
    })

    it("the caller's own endpoint on another connection of the tenant is a 409 ADDRESS_BOUND_ON_OTHER_CONNECTION, and the candidate says so", async () => {
      const w = await twoConnections({ sameUser: true })
      const svc = services()
      await establish(svc, w.org, w.a, w.first.id)
      const error = await failureOf(establish(svc, w.org, w.a, w.second.id))
      expect([error.status, error.code]).toEqual([409, 'ADDRESS_BOUND_ON_OTHER_CONNECTION'])
      const listing = await svc.endpoints.list({ orgId: w.org, userId: w.a })
      const second = listing.candidates.find((candidate) => candidate.connection.id === w.second.id && candidate.proofKind === 'directory_link')
      expect([second?.addressable, second?.reasonCode]).toEqual([false, 'address_bound_on_other_connection'])
    })

    it("the caller's earlier endpoint that no longer holds is demoted by the caller's own request, which then builds the new one", async () => {
      const w = await scene()
      const second = await insertIntegration({ corp: w.corp, orgId: w.org, config: { appKey: 'AppTwo' } })
      const svc = services()
      const user = w.users[0]
      const old = await establish(svc, w.org, user, w.id)
      await run('UPDATE directory_accounts SET integration_id = $1::uuid WHERE id = $2::uuid', [second.id, w.accounts[0].accountId])
      const fresh = await establish(svc, w.org, user, second.id)
      expect(fresh.created).toBe(true)
      const stale = (await rowsOf(ENDPOINTS, 'id = $1::uuid', [old.endpoint.id]))[0]
      expect([stale.status, Number(stale.revision)]).toEqual(['stale', 2])
      const demote = audits.find((event) => event.action === 'notification.endpoint.demote')
      expect(demote).toMatchObject({ actorType: 'user', actorId: user, meta: { reason: 'address_rebound' } })
    })

    it('two users that reach the same address together: one succeeds, the other gets a 409, never a 500 (same connection and across connections)', async () => {
      const corp = `Corp-${randomUUID()}`
      const first = await insertIntegration({ corp })
      const second = await insertIntegration({ corp, orgId: first.org, config: { appKey: 'AppTwo' } })
      const [a, b, c, d] = await Promise.all(['a', 'b', 'c', 'd'].map((label) => makeUser(first.org, label)))
      // The same address after trimming, on one connection.
      await makeAccount({ integration: first.id, corp, user: a, externalUserId: 'race-same' })
      await makeAccount({ integration: first.id, corp, user: b, externalUserId: ' race-same' })
      // The same address on two connections of one tenant.
      await makeAccount({ integration: first.id, corp, user: c, externalUserId: 'race-across' })
      await makeAccount({ integration: second.id, corp, user: d, externalUserId: 'race-across' })
      const svc = services()
      for (const [x, y, cx, cy] of [
        [a, b, first.id, first.id],
        [c, d, first.id, second.id],
      ] as const) {
        const settled = await Promise.allSettled([establish(svc, first.org, x, cx), establish(svc, first.org, y, cy)])
        expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
        const rejected = settled.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
        expect(rejected.reason).toBeInstanceOf(NotificationHttpError)
        expect((rejected.reason as NotificationHttpError).status).toBe(409)
        expect((rejected.reason as NotificationHttpError).code).toBe('ADDRESS_ALREADY_BOUND')
      }
    })

    it('the user lock is the same lock for a create, a revoke and a preference change', async () => {
      const w = await scene()
      const svc = services()
      const user = w.users[0]
      const mine = await establish(svc, w.org, user, w.id)
      await expectWaitsForUserLock(w.org, user, () => establish(svc, w.org, user, w.id))
      await expectWaitsForUserLock(w.org, user, () =>
        svc.preferences.patch({ orgId: w.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 0, enabled: false } }),
      )
      await expectWaitsForUserLock(w.org, user, () => svc.endpoints.revoke({ orgId: w.org, userId: user, endpointId: mine.endpoint.id }))
    })
  })

  describe('#5 revoking an endpoint', () => {
    async function twoEndpoints() {
      const org = `${PREFIX}-org-${randomUUID()}`
      const c1 = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
      const c2 = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
      const user = await makeUser(org)
      const e1 = await insertEndpoint({ org, user, connection: c1.id, tenant: 'T1' })
      const e2 = await insertEndpoint({ org, user, connection: c2.id, tenant: 'T2' })
      return { org, user, e1, e2 }
    }
    const preference = async (org: string, user: string, topic = 'task_reminder') =>
      (await rowsOf(PREFERENCES, 'org_id = $1 AND user_id = $2 AND topic = $3', [org, user, topic]))[0]

    it('promotes the backup to primary, clears the backup, raises the revisions and leaves enabled as it was', async () => {
      const w = await twoEndpoints()
      await insertPreference({ org: w.org, user: w.user, primary: w.e1, fallback: w.e2, columns: { enabled: false } })
      await insertPreference({ org: w.org, user: w.user, topic: 'topic_b', primary: w.e1 })
      const svc = services()
      const revoked = await svc.endpoints.revoke({ orgId: w.org, userId: w.user, endpointId: w.e1 })
      expect([revoked.status, revoked.revision]).toEqual(['revoked', 2])
      let row = await preference(w.org, w.user)
      expect([row.primary_endpoint_id, row.fallback_endpoint_id, Number(row.revision), row.enabled]).toEqual([w.e2, null, 2, false])
      row = await preference(w.org, w.user, 'topic_b')
      expect([row.primary_endpoint_id, row.fallback_endpoint_id, Number(row.revision), row.enabled]).toEqual([null, null, 2, true])
      await svc.endpoints.revoke({ orgId: w.org, userId: w.user, endpointId: w.e2 })
      row = await preference(w.org, w.user)
      expect([row.primary_endpoint_id, row.enabled]).toEqual([null, false])
    })

    it('a revoked backup is cleared and the primary stays', async () => {
      const w = await twoEndpoints()
      await insertPreference({ org: w.org, user: w.user, primary: w.e1, fallback: w.e2 })
      await services().endpoints.revoke({ orgId: w.org, userId: w.user, endpointId: w.e2 })
      const row = await preference(w.org, w.user)
      expect([row.primary_endpoint_id, row.fallback_endpoint_id, Number(row.revision)]).toEqual([w.e1, null, 2])
    })

    it('is idempotent, and an endpoint of another user is not found', async () => {
      const w = await twoEndpoints()
      const svc = services()
      const first = await svc.endpoints.revoke({ orgId: w.org, userId: w.user, endpointId: w.e1 })
      audits.length = 0
      const second = await svc.endpoints.revoke({ orgId: w.org, userId: w.user, endpointId: w.e1 })
      expect(second).toEqual(first)
      expect(audits).toEqual([])
      const other = await makeUser(w.org, 'other')
      const error = await failureOf(svc.endpoints.revoke({ orgId: w.org, userId: other, endpointId: w.e2 }))
      expect([error.status, error.code]).toEqual([404, 'NOT_FOUND'])
    })
  })

  describe('#6 preference writes', () => {
    const pools: Pool[] = []
    afterEach(async () => {
      await Promise.all(pools.splice(0).map((extra) => extra.end()))
    })

    async function withIsolation(level: 'read committed' | 'repeatable read'): Promise<Pool> {
      const extra = new Pool({ connectionString: dbUrl, options: `-c default_transaction_isolation=${level.replace(' ', '\\ ')}` })
      pools.push(extra)
      const shown = await extra.query('SHOW default_transaction_isolation')
      expect(shown.rows[0].default_transaction_isolation).toBe(level)
      return extra
    }

    for (const level of ['read committed', 'repeatable read'] as const) {
      it(`two writes with the same expected revision: one 200, one 409 PREFERENCE_STALE (default isolation: ${level})`, async () => {
        const w = await scene()
        const source = await withIsolation(level)
        const svc = services({ db: poolDb(), transaction: transactionOver(source) })
        const user = w.users[0]
        const created = await svc.preferences.patch({ orgId: w.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 0, enabled: true } })
        expect(created.preference?.revision).toBe(1)
        const settled = await Promise.allSettled([
          svc.preferences.patch({ orgId: w.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 1, enabled: false } }),
          svc.preferences.patch({ orgId: w.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 1, quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' } } }),
        ])
        expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
        const rejected = settled.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
        const error = rejected.reason as NotificationHttpError
        expect([error.status, error.code, error.details]).toEqual([409, 'PREFERENCE_STALE', { currentRevision: 2 }])
        const none = await Promise.allSettled([
          svc.preferences.patch({ orgId: w.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 0, enabled: false } }),
          svc.preferences.patch({ orgId: w.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 0, enabled: true } }),
        ])
        expect(none.every((outcome) => outcome.status === 'rejected')).toBe(true)
      })
    }

    it('creating at expected revision 0 by two writers: exactly one wins', async () => {
      const w = await scene()
      const svc = services()
      const settled = await Promise.allSettled([
        svc.preferences.patch({ orgId: w.org, userId: w.users[0], patch: { topic: 'task_reminder', expectedRevision: 0, enabled: false } }),
        svc.preferences.patch({ orgId: w.org, userId: w.users[0], patch: { topic: 'task_reminder', expectedRevision: 0, enabled: true } }),
      ])
      expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    })

    it('after a change racing a revoke in either order, no preference refers to a revoked endpoint', async () => {
      const org = `${PREFIX}-org-${randomUUID()}`
      const user = await makeUser(org)
      const svc = services()
      for (let round = 0; round < 10; round += 1) {
        const connection = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
        const endpoint = await insertEndpoint({ org, user, connection: connection.id, tenant: `T-${round}` })
        const topic = 'task_reminder'
        const current = (await rowsOf(PREFERENCES, 'org_id = $1 AND user_id = $2 AND topic = $3', [org, user, topic]))[0]
        const patch = svc.preferences.patch({ orgId: org, userId: user, patch: { topic, expectedRevision: current ? Number(current.revision) : 0, primaryEndpointId: endpoint } })
        const revoke = svc.endpoints.revoke({ orgId: org, userId: user, endpointId: endpoint })
        await Promise.allSettled(round % 2 === 0 ? [patch, revoke] : [revoke, patch])
        const dangling = await run(
          `SELECT count(*)::int AS n FROM ${PREFERENCES} p JOIN ${ENDPOINTS} e ON e.id IN (p.primary_endpoint_id, p.fallback_endpoint_id) WHERE p.org_id = $1 AND e.status = 'revoked'`,
          [org],
        )
        expect(dangling.rows[0].n).toBe(0)
      }
    })

    it("an endpoint of another user, of another organization and an unknown id answer identically, before any status or provider check", async () => {
      const w = await scene(2)
      const svc = services()
      const [a, b] = w.users
      const foreign = await insertIntegration()
      const theirs = await insertEndpoint({ org: w.org, user: b, connection: w.id, address: 'b-address' })
      const elsewhere = await insertEndpoint({ org: foreign.org, user: a, connection: foreign.id, address: 'a-elsewhere', provider: 'dingtalk' })
      const bodies: string[] = []
      for (const endpointId of [theirs, elsewhere, randomUUID()]) {
        const error = await failureOf(svc.preferences.patch({ orgId: w.org, userId: a, patch: { topic: 'task_reminder', expectedRevision: 0, primaryEndpointId: endpointId } }))
        expect(error.status).toBe(409)
        bodies.push(JSON.stringify({ code: error.code, ...(error.details ?? {}) }))
      }
      expect(new Set(bodies).size).toBe(1)
      expect(JSON.parse(bodies[0])).toEqual({ code: 'ENDPOINT_NOT_USABLE', reason: 'endpoint_not_found' })
      expect(await rowsOf(PREFERENCES, 'org_id = $1', [w.org])).toHaveLength(0)
    })

    it('rejects a stale endpoint, a provider the topic does not route, a same-provider backup and a backup without a primary', async () => {
      const org = `${PREFIX}-org-${randomUUID()}`
      const user = await makeUser(org)
      const dt1 = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
      const dt2 = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
      const wc = await insertIntegration({ orgId: org, provider: 'wecom', corp: `Corp-${randomUUID()}` })
      const active1 = await insertEndpoint({ org, user, connection: dt1.id, tenant: 'T1' })
      const active2 = await insertEndpoint({ org, user, connection: dt2.id, tenant: 'T2' })
      const stale = await insertEndpoint({ org, user, connection: dt1.id, tenant: 'T3', status: 'stale', address: 'stale-one', proofKind: 'external_identity' })
      const wecom = await insertEndpoint({ org, user, connection: wc.id, tenant: 'T4', provider: 'wecom', addressKind: 'wecom_userid' })
      const svc = services()
      const patch = (fields: Record<string, unknown>, expectedRevision = 0) =>
        svc.preferences.patch({ orgId: org, userId: user, patch: { topic: 'task_reminder', expectedRevision, ...fields } as never })
      expect((await failureOf(patch({ primaryEndpointId: stale }))).details).toEqual({ reason: 'endpoint_stale' })
      expect((await failureOf(patch({ primaryEndpointId: wecom }))).code).toBe('ENDPOINT_NOT_ALLOWED_FOR_TOPIC')
      const sameProvider = await failureOf(patch({ primaryEndpointId: active1, fallbackEndpointId: active2 }))
      expect([sameProvider.status, sameProvider.code]).toEqual([409, 'FALLBACK_PROVIDER_NOT_ALLOWED'])
      expect((await failureOf(patch({ fallbackEndpointId: active1 }))).status).toBe(422)
      expect(await rowsOf(PREFERENCES, 'org_id = $1', [org])).toHaveLength(0)
    })

    it('an unchanged write returns 200 without a revision change or an audit record; null clears a key; quiet hours round-trip', async () => {
      const w = await scene()
      const svc = services()
      const user = w.users[0]
      const mine = await establish(svc, w.org, user, w.id)
      const base = { orgId: w.org, userId: user }
      const first = await svc.preferences.patch({ ...base, patch: { topic: 'task_reminder', expectedRevision: 0, primaryEndpointId: mine.endpoint.id, quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' } } })
      expect(first.preference).toMatchObject({ revision: 1, primaryEndpointId: mine.endpoint.id, quietHours: { start: '22:00', end: '08:00', timeZone: 'Asia/Shanghai' } })
      audits.length = 0
      const same = await svc.preferences.patch({ ...base, patch: { topic: 'task_reminder', expectedRevision: 1, enabled: true, primaryEndpointId: mine.endpoint.id } })
      expect(same.preference?.revision).toBe(1)
      expect(audits).toEqual([])
      const cleared = await svc.preferences.patch({ ...base, patch: { topic: 'task_reminder', expectedRevision: 1, primaryEndpointId: null, quietHours: null } })
      expect(cleared.preference).toMatchObject({ revision: 2, primaryEndpointId: null, quietHours: null, enabled: true })
      expect(audits.map((event) => event.action)).toEqual(['notification.preference.update'])
      expect(first.applies).toEqual({ now: false, reason: 'topic_not_integrated' })
      expect(first.effective).toMatchObject({ source: 'user_primary', usable: true, fallback: null })
    })
  })

  describe('#7 a second organization', () => {
    it('cannot read, revoke or refer to the first organization endpoints; one user keeps separate rows per organization', async () => {
      const w = await scene()
      const svc = services()
      const user = w.users[0]
      const mine = await establish(svc, w.org, user, w.id)
      const otherOrg = await scene()
      const listing = await svc.endpoints.list({ orgId: otherOrg.org, userId: user })
      expect([listing.endpoints, listing.candidates]).toEqual([[], []])
      const revoke = await failureOf(svc.endpoints.revoke({ orgId: otherOrg.org, userId: user, endpointId: mine.endpoint.id }))
      expect(revoke.status).toBe(404)
      const refer = await failureOf(svc.preferences.patch({ orgId: otherOrg.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 0, primaryEndpointId: mine.endpoint.id } }))
      expect(refer.code).toBe('ENDPOINT_NOT_USABLE')
      await run('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [user, otherOrg.org])
      await svc.preferences.patch({ orgId: w.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 0, enabled: false } })
      await svc.preferences.patch({ orgId: otherOrg.org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 0, enabled: true } })
      const rows = await rowsOf(PREFERENCES, 'user_id = $1', [user])
      expect(rows.map((row) => [row.org_id === w.org, row.enabled]).sort()).toEqual([[false, true], [true, false]])
    })
  })

  describe('#8 the switch', () => {
    const pinned = usePinnedServer()

    it('with the switch off every route answers 404 and the tables are not queried; with it on they are', async () => {
      let queries = 0
      let transactions = 0
      const counted: NotificationDbDeps = {
        db: { query: (text, values) => { queries += 1; return pool.query(text, values) as unknown as ReturnType<Db['query']> } },
        transaction: (fn) => { transactions += 1; return transactionOver(pool)(fn) },
      }
      const deps = { ...counted, resolver, audit: auditSink }
      const build = (enabled: boolean) => {
        const app = express()
        app.use(express.json())
        app.use(createMeNotificationEndpointsRouter({ isEnabled: () => enabled, service: createEndpointsService(deps) }))
        app.use(createMeNotificationPreferencesRouter({ isEnabled: () => enabled, service: createPreferencesService(deps) }))
        return app
      }
      const headers = { 'x-test-user': `${PREFIX}-user-switch`, 'x-test-tenant': `${PREFIX}-org-switch` }
      const hit = async () => [
        (await request(pinned.url()).get('/api/me/notification-endpoints').set(headers)).status,
        (await request(pinned.url()).post('/api/me/notification-endpoints').set(headers).send({ connectionId: randomUUID(), proofKind: 'directory_link' })).status,
        (await request(pinned.url()).delete(`/api/me/notification-endpoints/${randomUUID()}`).set(headers)).status,
        (await request(pinned.url()).get('/api/me/notification-preferences').set(headers)).status,
        (await request(pinned.url()).patch('/api/me/notification-preferences').set(headers).send({ topic: 'task_reminder', expectedRevision: 0, enabled: false })).status,
      ]
      pinned.setApp(build(false))
      expect(await hit()).toEqual([404, 404, 404, 404, 404])
      expect([queries, transactions]).toEqual([0, 0])
      pinned.setApp(build(true))
      const on = await hit()
      expect(on[0]).toBe(200)
      expect(queries + transactions).toBeGreaterThan(0)
    })
  })

  describe('#9 unbinding keeps working while an endpoint refers to the proof', () => {
    it('removing an identity row or cancelling a directory link succeeds, and the endpoint is then found stale', async () => {
      const w = await scene()
      const svc = services()
      const user = w.users[0]
      const mine = await establish(svc, w.org, user, w.id)
      const identity = await run(
        `INSERT INTO user_external_identities (provider, external_key, provider_union_id, corp_id, local_user_id, profile)
         VALUES ('dingtalk', $1, 'union-x', $2, $3, '{}'::jsonb) RETURNING id::text AS id`,
        [`${PREFIX}:${randomUUID()}`, w.corp, user],
      )
      const identityEndpoint = await insertEndpoint({ org: w.org, user, connection: w.id, proofKind: 'external_identity', proofId: identity.rows[0].id, address: 'identity-address', tenant: w.corp })
      await run('DELETE FROM user_external_identities WHERE id = $1::uuid', [identity.rows[0].id])
      await run('DELETE FROM directory_account_links WHERE id = $1::uuid', [w.accounts[0].linkId])
      const listing = await svc.endpoints.list({ orgId: w.org, userId: user })
      const byId = new Map(listing.endpoints.map((endpoint) => [endpoint.id, endpoint]))
      expect(byId.get(mine.endpoint.id)).toMatchObject({ usable: false, unusableReason: 'proof_missing' })
      expect(byId.get(identityEndpoint)?.usable).toBe(false)
    })
  })

  describe('#11 two users and two locks', () => {
    it('two users whose addresses were swapped, posting together, finish without a deadlock', async () => {
      const w = await scene(2)
      const [a, b] = w.users
      const accounts = w.accounts
      const svc = services()
      await establish(svc, w.org, a, w.id)
      await establish(svc, w.org, b, w.id)
      // Swap the identifiers of the two accounts.
      await run('UPDATE directory_accounts SET external_user_id = $1 WHERE id = $2::uuid', ['swap-tmp', accounts[0].accountId])
      await run('UPDATE directory_accounts SET external_user_id = $1 WHERE id = $2::uuid', [accounts[0].external, accounts[1].accountId])
      await run('UPDATE directory_accounts SET external_user_id = $1 WHERE id = $2::uuid', [accounts[1].external, accounts[0].accountId])
      // Each transaction waits, after taking its first lock, until the other has taken its own (or a short time passes).
      const arrivals: Array<() => void> = []
      const barrier = (): Promise<void> =>
        new Promise<void>((resolve) => {
          arrivals.push(resolve)
          if (arrivals.length >= 2) arrivals.splice(0).forEach((release) => release())
          else setTimeout(resolve, 700)
        })
      const gated = transactionOver(pool, async (statement, state) => {
        if (!statement.includes('pg_advisory_xact_lock')) return
        state.locks = (state.locks ?? 0) + 1
        if (state.locks === 2) await barrier()
      })
      const raced = services({ transaction: gated })
      const settled = await Promise.allSettled([establish(raced, w.org, a, w.id), establish(raced, w.org, b, w.id)])
      expect(settled.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
      const duplicated = await run(
        `SELECT count(*)::int AS n FROM (SELECT tenant_address_witness FROM ${ENDPOINTS} WHERE org_id = $1 AND status = 'active' GROUP BY tenant_address_witness HAVING count(*) > 1) d`,
        [w.org],
      )
      expect(duplicated.rows[0].n).toBe(0)
    })
  })

  describe('#12 the same identifier under different tenants and applications', () => {
    it('never resolves across tenants; across applications of one tenant the address digest differs and the tenant digest is shared', async () => {
      const org = `${PREFIX}-org-${randomUUID()}`
      const tenantA = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
      const tenantB = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
      const sameTenantOtherApp = await insertIntegration({ orgId: org, corp: 'Shared-Corp', config: { appKey: 'AppX' } })
      const sameTenantApp2 = await insertIntegration({ orgId: org, corp: 'Shared-Corp', config: { appKey: 'AppY' } })
      const users = await Promise.all(['1', '2', '3', '4'].map((label) => makeUser(org, label)))
      const external = 'dt-identical-string'
      await makeAccount({ integration: tenantA.id, corp: (await run('SELECT corp_id FROM directory_integrations WHERE id = $1::uuid', [tenantA.id])).rows[0].corp_id, user: users[0], externalUserId: external })
      await makeAccount({ integration: tenantB.id, corp: (await run('SELECT corp_id FROM directory_integrations WHERE id = $1::uuid', [tenantB.id])).rows[0].corp_id, user: users[1], externalUserId: external })
      await makeAccount({ integration: sameTenantOtherApp.id, corp: 'Shared-Corp', user: users[2], externalUserId: external })
      await makeAccount({ integration: sameTenantApp2.id, corp: 'Shared-Corp', user: users[3], externalUserId: external })
      const a = await targetOf(org, users[0], tenantA.id)
      const b = await targetOf(org, users[1], tenantB.id)
      const c = await targetOf(org, users[2], sameTenantOtherApp.id)
      const d = await targetOf(org, users[3], sameTenantApp2.id)
      expect(new Set([a.addressWitness, b.addressWitness, c.addressWitness, d.addressWitness]).size).toBe(4)
      expect(new Set([a.tenantAddressWitness, b.tenantAddressWitness, c.tenantAddressWitness]).size).toBe(3)
      expect(c.tenantAddressWitness).toBe(d.tenantAddressWitness)
      // A connection's endpoint never resolves under the other connection.
      const crossed = await resolver.resolveForConnection(poolDb(), { orgId: org, userId: users[0], connectionId: tenantB.id, proofKind: 'directory_link' })
      expect(codeOf(crossed)).toBe('proof_missing')
      // Different tenants: both users hold the identifier at once. Same tenant: the second is refused by the index.
      await endpointFromTarget(org, users[0], a)
      await endpointFromTarget(org, users[1], b)
      await endpointFromTarget(org, users[2], c)
      const clash = await pgError(endpointFromTarget(org, users[3], d))
      expect([clash.code, clash.constraint]).toEqual(['23505', 'une_tenant_address_active_uniq'])
    })
  })

  describe('#13 suite cleanup', () => {
    it('a whole-table delete of the integrations succeeds once the endpoint rows are gone, and is refused while one remains', async () => {
      const w = await scene()
      await insertEndpoint({ org: w.org, user: w.users[0], connection: w.id })
      const wholeTable = async (): Promise<PgError | null> => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query('DELETE FROM directory_integrations')
          return null
        } catch (error) {
          return error as PgError
        } finally {
          await client.query('ROLLBACK')
          client.release()
        }
      }
      const refused = await wholeTable()
      expect(refused?.code).toBe('23503')
      await run(`DELETE FROM ${PREFERENCES} WHERE org_id = $1`, [w.org])
      await run(`DELETE FROM ${ENDPOINTS} WHERE org_id = $1`, [w.org])
      expect(await wholeTable()).toBeNull()
    })
  })

  describe('#15 a backup of the primary provider', () => {
    it('is refused by the write and shown as not usable when it was stored directly', async () => {
      const org = `${PREFIX}-org-${randomUUID()}`
      const user = await makeUser(org)
      const c1 = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
      const c2 = await insertIntegration({ orgId: org, corp: `Corp-${randomUUID()}` })
      const first = await insertEndpoint({ org, user, connection: c1.id, tenant: 'T1' })
      const second = await insertEndpoint({ org, user, connection: c2.id, tenant: 'T2' })
      const svc = services()
      const error = await failureOf(svc.preferences.patch({ orgId: org, userId: user, patch: { topic: 'task_reminder', expectedRevision: 0, primaryEndpointId: first, fallbackEndpointId: second } }))
      expect([error.status, error.code]).toEqual([409, 'FALLBACK_PROVIDER_NOT_ALLOWED'])
      expect(await rowsOf(PREFERENCES, 'org_id = $1', [org])).toHaveLength(0)
      await insertPreference({ org, user, primary: first, fallback: second })
      const view = (await svc.preferences.list({ orgId: org, userId: user })).topics[0]
      expect(view.preference?.fallbackEndpointId).toBe(second)
      expect(view.effective.fallback?.usable).toBe(false)
    })
  })

  describe('#19 collisions across organizations', () => {
    async function crossScene() {
      const corp = `Corp-${randomUUID()}`
      const a = await insertIntegration({ corp })
      const b = await insertIntegration({ corp })
      const external = `dt-${randomUUID()}`
      return { corp, a, b, external }
    }

    it("a user of another organization is refused with the same answer as a user of the same organization, and a gone proof lets the new holder replace the old endpoint", async () => {
      const w = await crossScene()
      const ua = await makeUser(w.a.org, 'ua')
      const ub = await makeUser(w.b.org, 'ub')
      const xa = await makeAccount({ integration: w.a.id, corp: w.corp, user: ua, externalUserId: w.external })
      await makeAccount({ integration: w.b.id, corp: w.corp, user: ub, externalUserId: w.external })
      const svc = services()
      const held = await establish(svc, w.a.org, ua, w.a.id)
      const crossOrg = await failureOf(establish(svc, w.b.org, ub, w.b.id))
      expect([crossOrg.status, crossOrg.code, crossOrg.details, crossOrg.message]).toEqual([409, 'ADDRESS_ALREADY_BOUND', undefined, 'ADDRESS_ALREADY_BOUND'])
      const sameOrg = await twoUsersOneTenantRefusal()
      expect(JSON.stringify({ code: crossOrg.code, details: crossOrg.details })).toBe(JSON.stringify({ code: sameOrg.code, details: sameOrg.details }))
      expect(JSON.stringify(crossOrg)).not.toContain(held.endpoint.id)
      await run('DELETE FROM directory_account_links WHERE id = $1::uuid', [xa.linkId])
      const replaced = await establish(svc, w.b.org, ub, w.b.id)
      expect(replaced.created).toBe(true)
      const old = (await rowsOf(ENDPOINTS, 'id = $1::uuid', [held.endpoint.id]))[0]
      expect(old.status).toBe('stale')
      expect(audits.find((event) => event.action === 'notification.endpoint.demote')).toMatchObject({
        actorType: 'system',
        resourceId: held.endpoint.id,
        meta: { reason: 'address_rebound' },
      })
      const both = await pgError(insertEndpoint({ org: w.a.org, user: ua, connection: w.a.id, tenant: w.corp, address: 'direct-write', proofKind: 'external_identity' }).then(() =>
        insertEndpoint({ org: w.b.org, user: ub, connection: w.b.id, tenant: w.corp, address: 'direct-write', proofKind: 'external_identity' }),
      ))
      expect([both.code, both.constraint]).toEqual(['23505', 'une_tenant_address_active_uniq'])
    })

    async function twoUsersOneTenantRefusal(): Promise<NotificationHttpError> {
      const corp = `Corp-${randomUUID()}`
      const first = await insertIntegration({ corp })
      const second = await insertIntegration({ corp, orgId: first.org, config: { appKey: 'AppTwo' } })
      const u1 = await makeUser(first.org, 'p')
      const u2 = await makeUser(first.org, 'q')
      const external = `dt-${randomUUID()}`
      await makeAccount({ integration: first.id, corp, user: u1, externalUserId: external })
      await makeAccount({ integration: second.id, corp, user: u2, externalUserId: external })
      const svc = services()
      await establish(svc, first.org, u1, first.id)
      return failureOf(establish(svc, first.org, u2, second.id))
    }

    it('the same user in two organizations: the other organization endpoint is not treated as the caller own, and stays active', async () => {
      const w = await crossScene()
      const user = await makeUser(w.a.org, 'both')
      await run('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [user, w.b.org])
      const xa = await makeAccount({ integration: w.a.id, corp: w.corp, user, externalUserId: w.external })
      await makeAccount({ integration: w.b.id, corp: w.corp, user, externalUserId: w.external })
      const svc = services()
      const inA = await establish(svc, w.a.org, user, w.a.id)
      const refused = await failureOf(establish(svc, w.b.org, user, w.b.id))
      expect([refused.status, refused.code]).toEqual([409, 'ADDRESS_ALREADY_BOUND'])
      const kept = (await rowsOf(ENDPOINTS, 'id = $1::uuid', [inA.endpoint.id]))[0]
      expect([kept.status, Number(kept.revision)]).toEqual(['active', 1])
      // The candidate list of the second organization reads only its own rows.
      const listing = await svc.endpoints.list({ orgId: w.b.org, userId: user })
      const candidate = listing.candidates.find((entry) => entry.connection.id === w.b.id && entry.proofKind === 'directory_link')
      expect([candidate?.addressable, candidate?.reasonCode, candidate?.endpointId]).toEqual([true, null, null])
      expect(JSON.stringify(listing)).not.toContain(inA.endpoint.id)
      await run('DELETE FROM directory_account_links WHERE id = $1::uuid', [xa.linkId])
      audits.length = 0
      const replaced = await establish(svc, w.b.org, user, w.b.id)
      expect(replaced.created).toBe(true)
      expect((await rowsOf(ENDPOINTS, 'id = $1::uuid', [inA.endpoint.id]))[0].status).toBe('stale')
      expect(audits.find((event) => event.action === 'notification.endpoint.demote')).toMatchObject({ actorType: 'system', resourceId: inA.endpoint.id })
    })

    it('the same user in two organizations posting to both at once: one wins, the other is a 409, no deadlock', async () => {
      const w = await crossScene()
      const user = await makeUser(w.a.org, 'both')
      await run('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [user, w.b.org])
      await makeAccount({ integration: w.a.id, corp: w.corp, user, externalUserId: w.external })
      await makeAccount({ integration: w.b.id, corp: w.corp, user, externalUserId: w.external })
      const svc = services()
      const settled = await Promise.allSettled([establish(svc, w.a.org, user, w.a.id), establish(svc, w.b.org, user, w.b.id)])
      expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      const rejected = settled.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult
      expect((rejected.reason as NotificationHttpError).code).toBe('ADDRESS_ALREADY_BOUND')
    })

    it('the candidates of one (organization, user) on a second connection of the tenant show address_bound_on_other_connection', async () => {
      const corp = `Corp-${randomUUID()}`
      const first = await insertIntegration({ corp })
      const second = await insertIntegration({ corp, orgId: first.org, config: { appKey: 'AppTwo' } })
      const user = await makeUser(first.org)
      const external = `dt-${randomUUID()}`
      await makeAccount({ integration: first.id, corp, user, externalUserId: external })
      await makeAccount({ integration: second.id, corp, user, externalUserId: external })
      const svc = services()
      await establish(svc, first.org, user, first.id)
      const listing = await svc.endpoints.list({ orgId: first.org, userId: user })
      const flagged = listing.candidates.find((entry) => entry.connection.id === second.id && entry.proofKind === 'directory_link')
      expect([flagged?.addressable, flagged?.reasonCode]).toEqual([false, 'address_bound_on_other_connection'])
    })
  })

  describe('#16 migration timeout round trip', () => {
    it('leaves lock_timeout and statement_timeout as they were after up() and after down()', async () => {
      const read = async (trx: Kysely<unknown>) => {
        const result = await sql<{ l: string; s: string }>`
          SELECT current_setting('lock_timeout') AS l, current_setting('statement_timeout') AS s
        `.execute(trx)
        return [result.rows[0].l, result.rows[0].s]
      }
      const leftover = await run(`SELECT 'e' AS t, org_id FROM ${ENDPOINTS} UNION ALL SELECT 'p', org_id FROM ${PREFERENCES}`)
      expect(leftover.rows).toEqual([])
      const sentinel = new Error('rollback')
      const seen: string[][] = []
      const outcome = await pgError(
        migrationDb.transaction().execute(async (trx) => {
          await sql`SELECT set_config('lock_timeout', '7s', true), set_config('statement_timeout', '42s', true)`.execute(trx)
          await down(trx)
          seen.push(await read(trx))
          await up(trx)
          seen.push(await read(trx))
          throw sentinel
        }),
      )
      expect(outcome).toBe(sentinel)
      expect(seen).toEqual([
        ['7s', '42s'],
        ['7s', '42s'],
      ])
      expect(await tablesExist()).toBe(true)
    })
  })

  describe('#18 catalog snapshot', () => {
    async function catalog(table: string) {
      const constraints = await run(
        `SELECT conname AS n, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
        [table],
      )
      const indexes = await run(
        `SELECT indexname AS n, indexdef AS d FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
        [table],
      )
      return {
        constraints: constraints.rows.map((row) => [row.n, row.d]),
        indexes: indexes.rows.map((row) => [row.n, row.d]),
      }
    }

    it('pins every constraint and index of both tables', async () => {
      expect(await catalog(ENDPOINTS)).toEqual({ constraints: ENDPOINT_CONSTRAINTS, indexes: ENDPOINT_INDEXES })
      expect(await catalog(PREFERENCES)).toEqual({ constraints: PREFERENCE_CONSTRAINTS, indexes: PREFERENCE_INDEXES })
    })
  })
})
