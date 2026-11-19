import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import { afterEach, describe, expect, it } from 'vitest'

import { up as installReceiving } from '../../src/db/migrations/zzzz20261117173000_create_admin_grant_receiving_pins'
import { up as installInvalidation } from '../../src/db/migrations/zzzz20261117183000_admin_grant_receiving_invalidation'
import { up as installLoginRepairs } from '../../src/db/migrations/zzzz20261102150000_dingtalk_login_repairs'
import {
  ADMIN_GRANT_FIRST_BIRTH_DOWN_BLOCKED_CODE,
  ADMIN_GRANT_FIRST_BIRTH_DOWN_PREREQUISITE_CODE,
  ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_READ_COMMITTED_CODE,
  ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_TRANSACTION_CODE,
  ADMIN_GRANT_FIRST_BIRTH_UP_BLOCKED_CODE,
  ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE,
  ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_READ_COMMITTED_CODE,
  ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_TRANSACTION_CODE,
  down as removeFirstBirth,
  up as installFirstBirth,
} from '../../src/db/migrations/zzzz20261117193000_admin_grant_receiving_first_birth'

const databaseUrl = process.env.DATABASE_URL
if (process.env.EXPECT_DB === '1' && !databaseUrl) {
  throw new Error('EXPECT_DB=1 requires DATABASE_URL for admin-grant-receiving-first-birth.db.test.ts')
}

const describeFirstBirth = process.env.EXPECT_DB === '1' ? describe : describe.skip
const S3_PREFIX = 'Agr"-S3-'
const SHADOW_PREFIX = 'Agr"-S3x-'
const LEGAL_SCHEMA_PREFIX = 'Agr"-S3-$agr_s3$\'"\\'
const GENERATED_SCHEDULE_PREFIX = 'Agr"-S3-gencron-'
const GENERATED_PROFILE_PREFIX = 'Agr"-S3-genprof-'
type ParentShape = 'ordinary' | 'generated-schedule' | 'generated-profile'
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WAIT_MS = 2500
const FINGERPRINT = 'ab'.repeat(32)
const RECEIVING_RELATIONS = [
  'directory_connection_application_pins',
  'user_external_identity_binding_pins',
  'user_external_identity_evidence',
]
const S1_FUNCTIONS = [
  'admin_grant_evidence_insert_guard',
  'admin_grant_evidence_update_guard',
  'admin_grant_evidence_delete_guard',
]
const S2_FUNCTIONS = [
  'admin_grant_application_successor',
  'admin_grant_material_projection',
  'admin_grant_application_pin_update_guard',
  'admin_grant_application_pin_delete_guard',
  'admin_grant_binding_pin_update_guard',
  'admin_grant_binding_pin_delete_guard',
  'admin_grant_capability_delete_guard',
  'admin_grant_integration_invalidate',
  'admin_grant_identity_invalidate',
]
const S3_FUNCTIONS = ['admin_grant_receiving_admit']
const REPAIR_FUNCTIONS = [
  'guard_dingtalk_login_repair_chain',
  'guard_dingtalk_repaired_identity',
  'guard_repaired_directory_link',
]
const S2_TRIGGER_NAMES = [
  'admin_grant_application_pin_delete_guard',
  'admin_grant_application_pin_update_guard',
  'admin_grant_binding_pin_delete_guard',
  'admin_grant_binding_pin_update_guard',
  'admin_grant_capability_delete_guard',
  'admin_grant_evidence_delete_guard',
  'admin_grant_evidence_insert_guard',
  'admin_grant_evidence_update_guard',
  'admin_grant_identity_invalidate',
  'admin_grant_integration_invalidate',
]
const S3_TRIGGER_NAMES = [
  'admin_grant_application_pin_admit',
  'admin_grant_binding_pin_admit',
  'admin_grant_evidence_admit',
]

type PgError = Error & { code?: string }
type OwnedTable =
  | 'users'
  | 'directory_integrations'
  | 'directory_integration_capabilities'
  | 'user_external_identities'
  | 'directory_connection_application_pins'
  | 'user_external_identity_binding_pins'
  | 'user_external_identity_evidence'
  | 'directory_accounts'
  | 'directory_account_links'
  | 'dingtalk_login_repairs'
type Parent = {
  connectionId: string
  orgId: string
  corpId: string
  provider: string
  userId: string
  identityId: string
  externalKey: string
}
type IntegrationState = {
  ctid: string
  secret: string | null
  scheduleCron: string | null
  updatedAt: string
}
type IdentityState = {
  ctid: string
  externalKey: string
  profile: string
  updatedAt: string
}
type ReceivingCounts = { pins: number; bindings: number; evidence: number }
type Handled<T> = { ok: true; value: T } | { ok: false; error: PgError }
type PausedMigration = {
  db: Kysely<unknown>
  release: () => void
  abandon: () => void
  paused: () => boolean
  forwardedCreate: () => boolean
}

let adminPool: Pool | undefined
let testPool: Pool | undefined
let db: Kysely<unknown> | undefined
let schema = ''
let extraSchema = ''
let publicMarkers: string[] = []

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function isGenerated(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && UUID_TEXT.test(value.slice(prefix.length))
}

function isOwnedSchemaName(value: string): boolean {
  return isGenerated(value, LEGAL_SCHEMA_PREFIX)
    || isGenerated(value, GENERATED_SCHEDULE_PREFIX)
    || isGenerated(value, GENERATED_PROFILE_PREFIX)
    || isGenerated(value, S3_PREFIX)
}

function assertOwnedSchema(value: string): void {
  if (!isOwnedSchemaName(value)) throw new Error('owned schema name was not generated by this test')
}

function qTable(table: OwnedTable): string {
  assertOwnedSchema(schema)
  return `${quoteIdent(schema)}.${quoteIdent(table)}`
}

function searchPathValue(): string {
  assertOwnedSchema(schema)
  return `${quoteIdent(schema)}, pg_catalog`
}

function directoryConfig(secret: string): Record<string, unknown> {
  return {
    appKey: 'k',
    appSecret: secret,
    baseUrl: 'https://directory.invalid/s',
    workNotificationAgentId: 'agent-a',
  }
}

async function publicReceivingMarkers(pool: Pool): Promise<string[]> {
  const result = await pool.query(
    `SELECT marker FROM (
       SELECT n.nspname || '.' || c.relname || ':' || c.oid::text AS marker
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       UNION ALL
       SELECT n.nspname || '.' || p.proname || ':' || p.oid::text AS marker
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($2::text[])
     ) markers
     ORDER BY marker`,
    [RECEIVING_RELATIONS, [...S1_FUNCTIONS, ...S2_FUNCTIONS, ...S3_FUNCTIONS, ...REPAIR_FUNCTIONS]],
  )
  return result.rows.map((row) => String(row.marker))
}

async function pinKysely(trx: Kysely<unknown>): Promise<void> {
  await sql`SELECT set_config('search_path', ${searchPathValue()}, true)`.execute(trx)
  const seen = await sql<{ schema_name: string | null }>`SELECT current_schema() AS schema_name`.execute(trx)
  if (seen.rows[0]?.schema_name !== schema) {
    throw new Error('caller search_path was not pinned to the owned schema and pg_catalog')
  }
}

async function pinCaller(queryable: PoolClient): Promise<void> {
  await queryable.query(`SELECT set_config('search_path', $1, true)`, [searchPathValue()])
  const seen = await queryable.query<{ schema_name: string | null }>(`SELECT current_schema() AS schema_name`)
  if (seen.rows[0]?.schema_name !== schema) {
    throw new Error('caller search_path was not pinned to the owned schema and pg_catalog')
  }
}

async function functionNames(names: readonly string[]): Promise<string[]> {
  const result = await adminPool!.query<{ name: string }>(
    `SELECT p.proname AS name
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = ANY($2::text[])
      ORDER BY p.proname`,
    [schema, names],
  )
  return result.rows.map((row) => row.name)
}

async function triggerNames(): Promise<string[]> {
  const result = await adminPool!.query<{ name: string }>(
    `SELECT t.tgname AS name
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND NOT t.tgisinternal
      ORDER BY t.tgname`,
    [schema],
  )
  return result.rows.map((row) => row.name)
}

async function sessionTimeouts(): Promise<{ lockTimeout: string; statementTimeout: string }> {
  const result = await sql<{ lock_timeout: string; statement_timeout: string }>`
    SELECT current_setting('lock_timeout') AS lock_timeout,
           current_setting('statement_timeout') AS statement_timeout
  `.execute(db!)
  return {
    lockTimeout: String(result.rows[0]?.lock_timeout ?? ''),
    statementTimeout: String(result.rows[0]?.statement_timeout ?? ''),
  }
}

async function callerTimeouts(client: PoolClient): Promise<{ lockTimeout: string; statementTimeout: string }> {
  const result = await client.query<{ lock_timeout: string; statement_timeout: string }>(
    `SELECT current_setting('lock_timeout') AS lock_timeout,
            current_setting('statement_timeout') AS statement_timeout`,
  )
  return {
    lockTimeout: String(result.rows[0]?.lock_timeout ?? ''),
    statementTimeout: String(result.rows[0]?.statement_timeout ?? ''),
  }
}

async function pinLowerCallerTimeouts(client: PoolClient): Promise<{ lockTimeout: string; statementTimeout: string }> {
  await client.query(`SELECT set_config('lock_timeout', '1s', true), set_config('statement_timeout', '2s', true)`)
  return callerTimeouts(client)
}

async function rejection(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise
  } catch (error) {
    return error as PgError
  }
  throw new Error('expected the operation to be rejected')
}

function handled<T>(promise: Promise<T>): Promise<Handled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error: error as PgError }),
  )
}

function fulfilled<T>(outcome: Handled<T>): T {
  if (outcome.ok === false) {
    throw new Error(`expected the operation to succeed, received ${outcome.error.code ?? 'no sqlstate'}`)
  }
  return outcome.value
}

function refused<T>(outcome: Handled<T>): PgError {
  if (outcome.ok === true) throw new Error('expected the operation to be rejected')
  return outcome.error
}

function asPidList(value: unknown): number[] {
  if (value == null) return []
  if (Array.isArray(value)) {
    return value.map((item) => {
      const pid = Number(item)
      if (!Number.isInteger(pid)) throw new Error('blocking pid list was not numeric')
      return pid
    })
  }
  if (typeof value === 'string') {
    const body = value.trim().replace(/^\{/, '').replace(/\}$/, '')
    if (body === '') return []
    return body.split(',').map((item) => {
      const pid = Number(item.trim())
      if (!Number.isInteger(pid)) throw new Error('blocking pid list was not numeric')
      return pid
    })
  }
  throw new Error('blocking pid list had an unexpected shape')
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>(`SELECT pg_catalog.pg_backend_pid() AS pid`)
  const pid = Number(result.rows[0]?.pid)
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('backend pid was not visible')
  return pid
}

async function blockingPids(pid: number): Promise<number[]> {
  const result = await adminPool!.query<{ pids: unknown }>(
    `SELECT pg_catalog.pg_blocking_pids($1::integer) AS pids`,
    [pid],
  )
  return asPidList(result.rows[0]?.pids)
}

async function axGranted(pid: number, relation: OwnedTable): Promise<boolean> {
  const result = await adminPool!.query(
    `SELECT 1
       FROM pg_catalog.pg_locks l
       JOIN pg_catalog.pg_class c ON c.oid = l.relation
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE l.locktype = 'relation'
        AND l.mode = 'AccessExclusiveLock'
        AND l.granted
        AND l.pid = $1
        AND n.nspname = $2
        AND c.relname = $3`,
    [pid, schema, relation],
  )
  return (result.rowCount ?? 0) > 0
}

async function axWaiting(pid: number, relation: OwnedTable): Promise<boolean> {
  const result = await adminPool!.query(
    `SELECT 1
       FROM pg_catalog.pg_locks l
       JOIN pg_catalog.pg_class c ON c.oid = l.relation
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE l.locktype = 'relation'
        AND l.mode = 'AccessExclusiveLock'
        AND NOT l.granted
        AND l.pid = $1
        AND n.nspname = $2
        AND c.relname = $3`,
    [pid, schema, relation],
  )
  return (result.rowCount ?? 0) > 0
}

async function untilLockGate(visible: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() <= deadline) {
    if (await visible()) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(20, remaining))
    })
  }
  if (await visible()) return
  throw new Error('lock gate deadline exceeded')
}

type BackendActivity = { query: string; waitEventType: string | null }
type IdentitySlots = {
  ctid: string
  provider: string
  externalKey: string
  localUserId: string
  corpId: string | null
  providerOpenId: string | null
  providerUnionId: string | null
  profile: string
  updatedAt: string
}

async function expectShareNowaitRefused(relation: OwnedTable, id: string): Promise<void> {
  const probe = await testPool!.connect()
  try {
    await probe.query('BEGIN')
    const refused = await rejection(probe.query(
      `SELECT id FROM ${qTable(relation)} WHERE id = $1::uuid FOR SHARE NOWAIT`,
      [id],
    ))
    expect(refused.code).toBe('55P03')
    await probe.query('ROLLBACK')
  } finally {
    await probe.query('ROLLBACK').catch(() => undefined)
    probe.release()
  }
}

async function waitingActivity(pid: number, required?: true): Promise<BackendActivity>
async function waitingActivity(pid: number, required: false): Promise<BackendActivity | undefined>
async function waitingActivity(pid: number, required = true): Promise<BackendActivity | undefined> {
  const result = await adminPool!.query<{ query: string | null; wait_event_type: string | null }>(
    `SELECT query, wait_event_type
       FROM pg_catalog.pg_stat_activity
      WHERE pid = $1`,
    [pid],
  )
  const row = result.rows[0]
  if (!row?.query) {
    if (required) throw new Error('backend activity was not visible')
    return undefined
  }
  return { query: row.query, waitEventType: row.wait_event_type }
}

async function identitySlots(id: string): Promise<IdentitySlots> {
  const result = await testPool!.query<{
    ctid: string
    provider: string
    external_key: string
    local_user_id: string
    corp_id: string | null
    provider_open_id: string | null
    provider_union_id: string | null
    profile: string
    updated_at: string
  }>(
    `SELECT ctid::text AS ctid,
            provider,
            external_key,
            local_user_id,
            corp_id,
            provider_open_id,
            provider_union_id,
            profile::text AS profile,
            updated_at::text AS updated_at
       FROM ${qTable('user_external_identities')}
      WHERE id = $1::uuid`,
    [id],
  )
  const row = result.rows[0]
  if (!row) throw new Error('identity row was not visible')
  return {
    ctid: row.ctid,
    provider: row.provider,
    externalKey: row.external_key,
    localUserId: row.local_user_id,
    corpId: row.corp_id,
    providerOpenId: row.provider_open_id,
    providerUnionId: row.provider_union_id,
    profile: row.profile,
    updatedAt: row.updated_at,
  }
}

async function userCtid(id: string): Promise<string> {
  const result = await testPool!.query<{ ctid: string }>(
    `SELECT ctid::text AS ctid FROM ${qTable('users')} WHERE id = $1`,
    [id],
  )
  const ctid = result.rows[0]?.ctid
  if (!ctid) throw new Error('user row was not visible')
  return ctid
}

async function repairCount(): Promise<number> {
  const result = await testPool!.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${qTable('dingtalk_login_repairs')}`,
  )
  return Number(result.rows[0]?.count ?? 0)
}

function kyselyOnOpenClient(client: PoolClient): Kysely<unknown> {
  const bound = {
    query: (text: string, values?: unknown[]) => client.query(text, values),
    release: () => undefined,
  }
  return new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: {
        connect: () => Promise.resolve(bound),
        end: () => Promise.resolve(),
      } as Pool,
    }),
  })
}

function pauseAfterEvidenceLock(client: PoolClient): PausedMigration {
  let openGate: () => void = () => undefined
  let opened = false
  let abandoned = false
  const gate = new Promise<void>((resolve) => {
    openGate = resolve
  })
  let holdFollowing = false
  let sawCreate = false
  const bound = {
    query: async (text: string, values?: unknown[]) => {
      if (holdFollowing) await gate
      if (abandoned) throw new Error('first birth continuation abandoned')
      if (text.includes('CREATE FUNCTION') || text.includes('CREATE TRIGGER')) sawCreate = true
      const result = await client.query(text, values)
      if (
        text.includes('LOCK TABLE')
        && text.includes('IN ACCESS EXCLUSIVE MODE')
        && text.includes('"user_external_identity_evidence"')
      ) {
        holdFollowing = true
      }
      return result
    },
    release: () => undefined,
  }
  return {
    db: new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: {
          connect: () => Promise.resolve(bound),
          end: () => Promise.resolve(),
        } as Pool,
      }),
    }),
    release: () => {
      if (opened) return
      opened = true
      openGate()
    },
    abandon: () => {
      abandoned = true
    },
    paused: () => holdFollowing && !opened,
    forwardedCreate: () => sawCreate,
  }
}

function parentFixtureSql(owned: string, shape: ParentShape): string {
  const scheduleCron = shape === 'generated-schedule'
    ? `schedule_basis text,
      schedule_cron text GENERATED ALWAYS AS (schedule_basis) STORED`
    : 'schedule_cron text'
  const profile = shape === 'generated-profile'
    ? `profile_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
      profile jsonb GENERATED ALWAYS AS (profile_basis) STORED`
    : `profile jsonb NOT NULL DEFAULT '{}'::jsonb`
  return `
    CREATE TABLE ${owned}.users (
      id text PRIMARY KEY
    );
    CREATE TABLE ${owned}.directory_integrations (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      provider text NOT NULL,
      name text NOT NULL,
      status text,
      corp_id text,
      config jsonb,
      ${scheduleCron},
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_directory_integrations_id_provider UNIQUE (id, provider),
      CONSTRAINT uq_directory_integrations_id_org UNIQUE (id, org_id)
    );
    CREATE TABLE ${owned}.directory_integration_capabilities (
      integration_id uuid PRIMARY KEY,
      bound_provider text NOT NULL,
      bound_org_id text NOT NULL,
      revision bigint NOT NULL,
      login_enabled boolean NOT NULL DEFAULT false,
      login_bound_tenant text,
      login_bound_app_scope text,
      CONSTRAINT dic_integration_provider_fk FOREIGN KEY (integration_id, bound_provider)
        REFERENCES ${owned}.directory_integrations (id, provider) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT dic_integration_org_fk FOREIGN KEY (integration_id, bound_org_id)
        REFERENCES ${owned}.directory_integrations (id, org_id) ON DELETE RESTRICT ON UPDATE RESTRICT
    );
    CREATE TABLE ${owned}.user_external_identities (
      id uuid PRIMARY KEY,
      provider text NOT NULL,
      external_key text NOT NULL,
      local_user_id text NOT NULL,
      corp_id text,
      provider_open_id text,
      provider_union_id text,
      ${profile},
      last_login_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fk_user_external_identities_local_user
        FOREIGN KEY (local_user_id) REFERENCES ${owned}.users (id) ON DELETE CASCADE ON UPDATE CASCADE
    )
  `
}

async function createOwnedSchema(shape: ParentShape = 'ordinary', prefix = S3_PREFIX): Promise<void> {
  adminPool = new Pool({ connectionString: databaseUrl, max: 2 })
  publicMarkers = await publicReceivingMarkers(adminPool)
  schema = `${prefix}${randomUUID()}`
  assertOwnedSchema(schema)
  if (Buffer.byteLength(schema) > 63) throw new Error('owned schema name exceeds the PostgreSQL identifier limit')
  const owned = quoteIdent(schema)
  await adminPool.query(`CREATE SCHEMA ${owned}`)
  await adminPool.query(parentFixtureSql(owned, shape))
  testPool = new Pool({ connectionString: databaseUrl, max: 8 })
  db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })
}

function embeddedInstallSchema(body: string): string {
  const marker = 'install_schema text := '
  const start = body.indexOf(marker)
  if (start < 0) throw new Error('install schema assignment was not present')
  const literal = body.slice(start + marker.length)
  const opener = literal.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\$/)
  if (!opener) throw new Error('install schema literal was not dollar quoted')
  const closer = `$${opener[1]}$`
  const from = opener[0].length
  const end = literal.indexOf(closer, from)
  if (end < 0 || literal[end + closer.length] !== ';') throw new Error('install schema literal was not closed')
  return literal.slice(from, end)
}

async function columnMarks(
  table: 'directory_integrations' | 'user_external_identities',
  column: 'schedule_cron' | 'profile',
): Promise<{ generated: string; identity: string }> {
  const result = await adminPool!.query<{ generated: string; identity: string }>(
    `SELECT att.attgenerated::text AS generated, att.attidentity::text AS identity
       FROM pg_attribute att
       JOIN pg_class rel ON rel.oid = att.attrelid
       JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE ns.nspname = $1
        AND rel.relname = $2
        AND att.attname = $3
        AND att.attnum > 0
        AND NOT att.attisdropped`,
    [schema, table, column],
  )
  const row = result.rows[0]
  if (!row) throw new Error('parent column was not visible')
  return row
}

async function expectUpRefusesBeforeAdmitObjects(): Promise<void> {
  const beforeTimeouts = await sessionTimeouts()
  await db!.transaction().execute(async (trx) => {
    await pinKysely(trx)
    const refused = await rejection(installFirstBirth(trx))
    expect(refused.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE)
    const present = await sql<{ present: boolean }>`
      SELECT (
        EXISTS (
          SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = ${schema}
             AND p.proname = 'admin_grant_receiving_admit'
        )
        OR EXISTS (
          SELECT 1
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = ${schema}
             AND t.tgname IN (
               'admin_grant_application_pin_admit',
               'admin_grant_binding_pin_admit',
               'admin_grant_evidence_admit'
             )
        )
      ) AS present
    `.execute(trx)
    expect(present.rows[0]?.present).toBe(false)
  })
  expect(await sessionTimeouts()).toEqual(beforeTimeouts)
  await expectInvalidationWithoutFirstBirth()
}

async function installThroughInvalidation(): Promise<void> {
  await db!.transaction().execute(async (trx) => {
    await pinKysely(trx)
    await installReceiving(trx)
  })
  await db!.transaction().execute(async (trx) => {
    await pinKysely(trx)
    await installInvalidation(trx)
  })
}

async function installAll(): Promise<void> {
  await installThroughInvalidation()
  await db!.transaction().execute(async (trx) => {
    await pinKysely(trx)
    await installFirstBirth(trx)
  })
}

async function installOwnedRepair(): Promise<void> {
  assertOwnedSchema(schema)
  const owned = quoteIdent(schema)
  await adminPool!.query(`
    CREATE TABLE ${owned}.directory_accounts (
      id uuid PRIMARY KEY,
      provider text NOT NULL
    )
  `)
  await adminPool!.query(`
    CREATE TABLE ${owned}.directory_account_links (
      id uuid PRIMARY KEY,
      directory_account_id uuid NOT NULL REFERENCES ${owned}.directory_accounts (id) ON DELETE CASCADE,
      local_user_id text,
      link_status text NOT NULL
    )
  `)
  await db!.transaction().execute(async (trx) => {
    await pinKysely(trx)
    await installLoginRepairs(trx)
  })
}

async function expectRepairInstalled(): Promise<void> {
  expect(await functionNames(REPAIR_FUNCTIONS)).toEqual([...REPAIR_FUNCTIONS])
  const triggers = await adminPool!.query<{ tgname: string; relname: string; tgenabled: string }>(
    `SELECT t.tgname, c.relname, t.tgenabled::text AS tgenabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND t.tgname IN (
          'dingtalk_repaired_identity',
          'dingtalk_repaired_identity_insert',
          'repaired_directory_link'
        )
      ORDER BY t.tgname`,
    [schema],
  )
  expect(triggers.rows).toEqual([
    { tgname: 'dingtalk_repaired_identity', relname: 'user_external_identities', tgenabled: 'O' },
    { tgname: 'dingtalk_repaired_identity_insert', relname: 'user_external_identities', tgenabled: 'O' },
    { tgname: 'repaired_directory_link', relname: 'directory_account_links', tgenabled: 'O' },
  ])
}

async function expectInvalidationWithoutFirstBirth(): Promise<void> {
  expect(await functionNames(S3_FUNCTIONS)).toEqual([])
  expect(await functionNames(S2_FUNCTIONS)).toEqual([...S2_FUNCTIONS].sort())
  expect(await functionNames(S1_FUNCTIONS)).toEqual([...S1_FUNCTIONS].sort())
  expect(await triggerNames()).toEqual(S2_TRIGGER_NAMES)
}

async function expectFirstBirthInstalled(): Promise<void> {
  expect(await functionNames(S3_FUNCTIONS)).toEqual([...S3_FUNCTIONS])
  expect(await functionNames(S2_FUNCTIONS)).toEqual([...S2_FUNCTIONS].sort())
  expect(await functionNames(S1_FUNCTIONS)).toEqual([...S1_FUNCTIONS].sort())
  expect(await triggerNames()).toEqual([...S2_TRIGGER_NAMES, ...S3_TRIGGER_NAMES].sort())
}

async function insertParents(secret = 'cipher-a', provider = 'stub'): Promise<Parent> {
  const connectionId = randomUUID()
  const orgId = randomUUID()
  const corpId = randomUUID()
  const userId = randomUUID()
  const identityId = randomUUID()
  const externalKey = randomUUID()
  await testPool!.query(
    `INSERT INTO ${qTable('directory_integrations')}
       (id, org_id, provider, name, status, corp_id, config)
     VALUES ($1::uuid, $2, $3, 'stub-not-a-legacy-consumer', 'active', $4, $5::jsonb)`,
    [connectionId, orgId, provider, corpId, JSON.stringify(directoryConfig(secret))],
  )
  await testPool!.query(`INSERT INTO ${qTable('users')} (id) VALUES ($1)`, [userId])
  await testPool!.query(
    `INSERT INTO ${qTable('user_external_identities')}
       (id, provider, external_key, local_user_id, corp_id)
     VALUES ($1::uuid, $2, $3, $4, $5)`,
    [identityId, provider, externalKey, userId, corpId],
  )
  return { connectionId, orgId, corpId, provider, userId, identityId, externalKey }
}

async function insertApplicationPinOn(client: PoolClient, connectionId: string, revision: string): Promise<number | null> {
  const inserted = await client.query(
    `INSERT INTO ${qTable('directory_connection_application_pins')}
       (connection_id, application_revision, material_fingerprint, updated_by)
     VALUES ($1::uuid, $2, $3, 'suite')`,
    [connectionId, revision, FINGERPRINT],
  )
  return inserted.rowCount
}

async function insertApplicationPin(connectionId: string, revision: string): Promise<void> {
  const client = await testPool!.connect()
  try {
    expect(await insertApplicationPinOn(client, connectionId, revision)).toBe(1)
  } finally {
    client.release()
  }
}

async function insertBindingPinOn(
  client: PoolClient,
  parent: Pick<Parent, 'identityId' | 'externalKey' | 'userId' | 'provider'>,
  revision: string,
): Promise<number | null> {
  const inserted = await client.query(
    `INSERT INTO ${qTable('user_external_identity_binding_pins')}
       (identity_id, binding_revision, provider, local_user_id, external_key)
     VALUES ($1::uuid, $2, $3, $4, $5)`,
    [parent.identityId, revision, parent.provider, parent.userId, parent.externalKey],
  )
  return inserted.rowCount
}

async function insertBindingPin(parent: Parent, revision: string): Promise<void> {
  const client = await testPool!.connect()
  try {
    expect(await insertBindingPinOn(client, parent, revision)).toBe(1)
  } finally {
    client.release()
  }
}

async function insertEvidenceOn(client: PoolClient, parent: Parent, evidenceId: string, revision: string): Promise<number | null> {
  const inserted = await client.query(
    `INSERT INTO ${qTable('user_external_identity_evidence')}
       (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
        assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
        application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
        revocation_generation, slot_snapshot, created_by)
     VALUES ($1, $2, $3::text, ($3::text)::uuid, 2, 'fixture-not-a-producer',
             'self_authenticated', $4, 'synthetic-app', $5, $6::uuid, 1,
             $7, $8, 1, now() - interval '1 hour', now() + interval '1 day',
             0, '{}'::jsonb, 'suite')`,
    [evidenceId, randomUUID(), parent.identityId, parent.externalKey, parent.orgId, parent.connectionId, revision, FINGERPRINT],
  )
  return inserted.rowCount
}

async function insertEvidence(parent: Parent, evidenceId: string, revision: string): Promise<void> {
  const client = await testPool!.connect()
  try {
    expect(await insertEvidenceOn(client, parent, evidenceId, revision)).toBe(1)
  } finally {
    client.release()
  }
}

async function receivingCounts(): Promise<ReceivingCounts> {
  const counts = await testPool!.query<ReceivingCounts>(
    `SELECT
       (SELECT count(*)::int FROM ${qTable('directory_connection_application_pins')}) AS pins,
       (SELECT count(*)::int FROM ${qTable('user_external_identity_binding_pins')}) AS bindings,
       (SELECT count(*)::int FROM ${qTable('user_external_identity_evidence')}) AS evidence`,
  )
  return counts.rows[0]
}

async function readApplicationPin(connectionId: string): Promise<{ application_revision: string; material_fingerprint: string }> {
  const pin = await testPool!.query<{ application_revision: string; material_fingerprint: string }>(
    `SELECT application_revision, material_fingerprint
       FROM ${qTable('directory_connection_application_pins')}
      WHERE connection_id = $1::uuid`,
    [connectionId],
  )
  return pin.rows[0]
}

async function readBindingPin(identityId: string): Promise<{ binding_revision: string; external_key: string }> {
  const pin = await testPool!.query<{ binding_revision: string; external_key: string }>(
    `SELECT binding_revision::text AS binding_revision, external_key
       FROM ${qTable('user_external_identity_binding_pins')}
      WHERE identity_id = $1::uuid`,
    [identityId],
  )
  return pin.rows[0]
}

async function readEvidence(evidenceId: string): Promise<{ generation: string; live_identity_id: string | null; revoked: boolean; application_revision: string }> {
  const evidence = await testPool!.query<{ generation: string; live_identity_id: string | null; revoked: boolean; application_revision: string }>(
    `SELECT revocation_generation::text AS generation, live_identity_id::text AS live_identity_id,
            (revoked_at IS NOT NULL) AS revoked, application_revision
       FROM ${qTable('user_external_identity_evidence')}
      WHERE id = $1`,
    [evidenceId],
  )
  return evidence.rows[0]
}

async function integrationState(id: string, client?: PoolClient): Promise<IntegrationState> {
  const text = `SELECT ctid::text AS ctid,
                       config ->> 'appSecret' AS secret,
                       schedule_cron,
                       updated_at::text AS updated_at
                  FROM ${qTable('directory_integrations')}
                 WHERE id = $1::uuid`
  const result = client
    ? await client.query<{ ctid: string; secret: string | null; schedule_cron: string | null; updated_at: string }>(text, [id])
    : await testPool!.query<{ ctid: string; secret: string | null; schedule_cron: string | null; updated_at: string }>(text, [id])
  const row = result.rows[0]
  if (!row) throw new Error('integration row was not visible')
  return { ctid: row.ctid, secret: row.secret, scheduleCron: row.schedule_cron, updatedAt: row.updated_at }
}

async function identityState(id: string, client?: PoolClient): Promise<IdentityState> {
  const text = `SELECT ctid::text AS ctid,
                       external_key,
                       profile::text AS profile,
                       updated_at::text AS updated_at
                  FROM ${qTable('user_external_identities')}
                 WHERE id = $1::uuid`
  const result = client
    ? await client.query<{ ctid: string; external_key: string; profile: string; updated_at: string }>(text, [id])
    : await testPool!.query<{ ctid: string; external_key: string; profile: string; updated_at: string }>(text, [id])
  const row = result.rows[0]
  if (!row) throw new Error('identity row was not visible')
  return { ctid: row.ctid, externalKey: row.external_key, profile: row.profile, updatedAt: row.updated_at }
}

function materialUpdateSql(): string {
  return `UPDATE ${qTable('directory_integrations')}
             SET config = jsonb_set(config, '{appSecret}', to_jsonb($2::text))
           WHERE id = $1::uuid`
}

function slotUpdateSql(): string {
  return `UPDATE ${qTable('user_external_identities')}
             SET external_key = $2
           WHERE id = $1::uuid`
}

async function beginRepeatableRead(client: PoolClient): Promise<void> {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  await pinCaller(client)
}

async function seeRow(client: PoolClient, table: 'directory_integrations' | 'user_external_identities', id: string): Promise<void> {
  const seen = await client.query(`SELECT id FROM ${qTable(table)} WHERE id = $1::uuid`, [id])
  expect(seen.rowCount).toBe(1)
}

async function expectSerializationFailure(client: PoolClient, text: string, values: unknown[]): Promise<void> {
  const error = await rejection(client.query(text, values))
  expect(error.code).toBe('40001')
  const aborted = await rejection(client.query('SELECT 1'))
  expect(aborted.code).toBe('25P02')
  await client.query('ROLLBACK')
}

async function expectUpBlocked(): Promise<void> {
  const beforeTimeouts = await sessionTimeouts()
  const error = await rejection(db!.transaction().execute(async (trx) => {
    await pinKysely(trx)
    await installFirstBirth(trx)
  }))
  expect(error.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_BLOCKED_CODE)
  expect(await sessionTimeouts()).toEqual(beforeTimeouts)
  await expectInvalidationWithoutFirstBirth()
}

async function expectDownBlocked(): Promise<void> {
  const beforeTimeouts = await sessionTimeouts()
  const error = await rejection(db!.transaction().execute(async (trx) => {
    await pinKysely(trx)
    await removeFirstBirth(trx)
  }))
  expect(error.code).toBe(ADMIN_GRANT_FIRST_BIRTH_DOWN_BLOCKED_CODE)
  expect(await sessionTimeouts()).toEqual(beforeTimeouts)
  await expectFirstBirthInstalled()
}

async function expectFastIsolationRefusal(
  level: 'REPEATABLE READ' | 'SERIALIZABLE',
  run: (client: PoolClient) => Promise<unknown>,
  code: string,
): Promise<void> {
  const holder = await testPool!.connect()
  const reader = await testPool!.connect()
  try {
    await holder.query('BEGIN')
    await holder.query(`LOCK TABLE ${qTable('directory_connection_application_pins')} IN ACCESS EXCLUSIVE MODE`)
    await reader.query(`BEGIN ISOLATION LEVEL ${level}`)
    await pinCaller(reader)
    const started = Date.now()
    const refused = await rejection(run(reader))
    expect(Date.now() - started).toBeLessThan(WAIT_MS)
    expect(refused.code).toBe(code)
    const isolation = await reader.query<{ isolation: string }>(`SELECT current_setting('transaction_isolation') AS isolation`)
    expect(isolation.rows[0]?.isolation).toBe(level.toLowerCase())
    await reader.query('ROLLBACK')
  } finally {
    await reader.query('ROLLBACK').catch(() => undefined)
    reader.release()
    await holder.query('ROLLBACK').catch(() => undefined)
    holder.release()
  }
}

async function expectParentShareSerializesBirth(branch: 'integration' | 'identity'): Promise<void> {
  await createOwnedSchema()
  await installAll()
  expect(await functionNames(REPAIR_FUNCTIONS)).toEqual([])
  const parent = await insertParents('A')
  expect(parent.provider).toBe('stub')
  const integrationBefore = await integrationState(parent.connectionId)
  const identityBefore = await identityState(parent.identityId)
  const receivingTable = branch === 'integration'
    ? 'directory_connection_application_pins'
    : 'user_external_identity_binding_pins'
  const holder = await testPool!.connect()
  const birth = await testPool!.connect()
  let birthOutcome: Promise<Handled<number | null>> | undefined
  try {
    await holder.query('BEGIN')
    const holderPid = await backendPid(holder)
    const shared = branch === 'integration'
      ? await holder.query(
        `SELECT id FROM ${qTable('directory_integrations')} WHERE id = $1::uuid FOR SHARE`,
        [parent.connectionId],
      )
      : await holder.query(
        `SELECT id FROM ${qTable('user_external_identities')} WHERE id = $1::uuid FOR SHARE`,
        [parent.identityId],
      )
    expect(shared.rowCount).toBe(1)
    await birth.query('BEGIN')
    await pinCaller(birth)
    await birth.query(`SELECT set_config('lock_timeout', '8s', true)`)
    const birthPid = await backendPid(birth)
    expect(birthPid).not.toBe(holderPid)
    birthOutcome = handled(
      branch === 'integration'
        ? insertApplicationPinOn(birth, parent.connectionId, '4')
        : insertBindingPinOn(birth, parent, '2'),
    )
    await untilLockGate(async () => (await blockingPids(birthPid)).includes(holderPid))
    expect(await blockingPids(birthPid)).toContain(holderPid)
    const activity = await waitingActivity(birthPid)
    expect(activity.waitEventType).toBe('Lock')
    expect(activity.query).toContain('INSERT')
    expect(activity.query).toContain(quoteIdent(receivingTable))
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 0 })
    expect(await integrationState(parent.connectionId)).toEqual(integrationBefore)
    expect(await identityState(parent.identityId)).toEqual(identityBefore)
    await holder.query('COMMIT')
    expect(fulfilled(await birthOutcome)).toBe(1)
    birthOutcome = undefined
    await birth.query('COMMIT')
    if (branch === 'integration') {
      const integrationAfter = await integrationState(parent.connectionId)
      expect(integrationAfter.ctid).not.toBe(integrationBefore.ctid)
      expect(integrationAfter.secret).toBe('A')
      expect(integrationAfter.scheduleCron).toBe(integrationBefore.scheduleCron)
      expect(integrationAfter.updatedAt).toBe(integrationBefore.updatedAt)
      expect(await identityState(parent.identityId)).toEqual(identityBefore)
      expect(await readApplicationPin(parent.connectionId)).toEqual({
        application_revision: '4',
        material_fingerprint: FINGERPRINT,
      })
      expect(await receivingCounts()).toEqual({ pins: 1, bindings: 0, evidence: 0 })
    } else {
      const identityAfter = await identityState(parent.identityId)
      expect(identityAfter.ctid).not.toBe(identityBefore.ctid)
      expect(identityAfter.externalKey).toBe(identityBefore.externalKey)
      expect(identityAfter.profile).toBe(identityBefore.profile)
      expect(identityAfter.updatedAt).toBe(identityBefore.updatedAt)
      expect(await integrationState(parent.connectionId)).toEqual(integrationBefore)
      expect(await readBindingPin(parent.identityId)).toEqual({
        binding_revision: '2',
        external_key: parent.externalKey,
      })
      expect(await receivingCounts()).toEqual({ pins: 0, bindings: 1, evidence: 0 })
    }
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined)
    holder.release()
    if (birthOutcome) await birthOutcome
    await birth.query('ROLLBACK').catch(() => undefined)
    birth.release()
  }
}

describeFirstBirth('admin grant first birth on owned quoted parent stubs', () => {
  afterEach(async () => {
    const owned = schema
    const extra = extraSchema
    const markers = publicMarkers
    const pool = adminPool
    schema = ''
    extraSchema = ''
    publicMarkers = []
    try {
      if (pool) expect(await publicReceivingMarkers(pool)).toEqual(markers)
    } finally {
      await db?.destroy().catch(() => undefined)
      await testPool?.end().catch(() => undefined)
      db = undefined
      testPool = undefined
      if (pool && isOwnedSchemaName(owned)) await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(owned)} CASCADE`)
      if (pool && isGenerated(extra, SHADOW_PREFIX)) await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(extra)} CASCADE`)
      await pool?.end()
      adminPool = undefined
    }
  })

  it('installs fixed admit branches, the repair search path, and lowercase after-insert triggers', async () => {
    await createOwnedSchema()
    await installAll()
    await expectFirstBirthInstalled()
    const procedure = await adminPool!.query<{ prosrc: string; prosecdef: boolean; proconfig: string[] | string | null }>(
      `SELECT p.prosrc, p.prosecdef, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = 'admin_grant_receiving_admit'`,
      [schema],
    )
    const body = procedure.rows[0]?.prosrc ?? ''
    const configText = Array.isArray(procedure.rows[0]?.proconfig)
      ? procedure.rows[0].proconfig.map((item) => String(item)).join('\n')
      : String(procedure.rows[0]?.proconfig ?? '')
    expect(procedure.rows[0]?.prosecdef).toBe(false)
    expect(configText).toContain(`search_path=pg_catalog, ${quoteIdent(schema)}, pg_temp`)
    expect(body.split('GET DIAGNOSTICS affected = ROW_COUNT').length - 1).toBe(4)
    expect(body.split('SET schedule_cron = schedule_cron').length - 1).toBe(2)
    expect(body.split('SET profile = profile').length - 1).toBe(2)
    expect(body).toContain(schema)
    expect(body).not.toContain('SET id = id')
    expect(body).not.toContain('pg_advisory')
    expect(body).not.toContain('FROM users')
    const triggers = await adminPool!.query<{ tgname: string; tgtype: number; tgenabled: string; proname: string }>(
      `SELECT t.tgname, t.tgtype::int AS tgtype, t.tgenabled::text AS tgenabled, p.proname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = $1 AND t.tgname = ANY($2::text[])
        ORDER BY t.tgname`,
      [schema, S3_TRIGGER_NAMES],
    )
    expect(triggers.rows).toEqual(S3_TRIGGER_NAMES.map((tgname) => ({
      tgname,
      tgtype: 5,
      tgenabled: 'O',
      proname: 'admin_grant_receiving_admit',
    })))
  }, 20_000)

  it('refuses autocommit and non-read-committed up and down before receiving locks', async () => {
    await createOwnedSchema()
    await installThroughInvalidation()
    const beforeTimeouts = await sessionTimeouts()
    const autocommitUp = await rejection(installFirstBirth(db!))
    expect(autocommitUp.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_TRANSACTION_CODE)
    expect(await sessionTimeouts()).toEqual(beforeTimeouts)
    await expectInvalidationWithoutFirstBirth()
    await expectFastIsolationRefusal(
      'REPEATABLE READ',
      (client) => installFirstBirth(kyselyOnOpenClient(client)),
      ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_READ_COMMITTED_CODE,
    )
    await expectFastIsolationRefusal(
      'SERIALIZABLE',
      (client) => installFirstBirth(kyselyOnOpenClient(client)),
      ADMIN_GRANT_FIRST_BIRTH_UP_REQUIRES_READ_COMMITTED_CODE,
    )
    await expectInvalidationWithoutFirstBirth()
    await db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await installFirstBirth(trx)
    })
    await expectFirstBirthInstalled()
    const autocommitDown = await rejection(removeFirstBirth(db!))
    expect(autocommitDown.code).toBe(ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_TRANSACTION_CODE)
    await expectFirstBirthInstalled()
    await expectFastIsolationRefusal(
      'REPEATABLE READ',
      (client) => removeFirstBirth(kyselyOnOpenClient(client)),
      ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_READ_COMMITTED_CODE,
    )
    await expectFastIsolationRefusal(
      'SERIALIZABLE',
      (client) => removeFirstBirth(kyselyOnOpenClient(client)),
      ADMIN_GRANT_FIRST_BIRTH_DOWN_REQUIRES_READ_COMMITTED_CODE,
    )
    expect(await sessionTimeouts()).toEqual(beforeTimeouts)
    await expectFirstBirthInstalled()
  }, 20_000)

  it('refuses up or down when a fixed prerequisite is missing and leaves the prior objects', async () => {
    await createOwnedSchema()
    await db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await installReceiving(trx)
    })
    const missingInvalidation = await rejection(db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await installFirstBirth(trx)
    }))
    expect(missingInvalidation.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE)
    expect(await functionNames(S3_FUNCTIONS)).toEqual([])
    expect(await functionNames(S2_FUNCTIONS)).toEqual([])
    await db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await installInvalidation(trx)
    })
    const disabled = await rejection(db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await sql`ALTER TABLE ${sql.raw(qTable('directory_integrations'))} DISABLE TRIGGER admin_grant_integration_invalidate`.execute(trx)
      await installFirstBirth(trx)
    }))
    expect(disabled.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE)
    const enabled = await adminPool!.query<{ tgenabled: string }>(
      `SELECT t.tgenabled::text AS tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND t.tgname = 'admin_grant_integration_invalidate'`,
      [schema],
    )
    expect(enabled.rows[0]?.tgenabled).toBe('O')
    const keyed = await rejection(db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await sql`CREATE UNIQUE INDEX schedule_cron_key ON ${sql.raw(qTable('directory_integrations'))} (schedule_cron)`.execute(trx)
      await installFirstBirth(trx)
    }))
    expect(keyed.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE)
    const wrongForeignKey = await rejection(db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await sql`ALTER TABLE ${sql.raw(qTable('user_external_identity_evidence'))}
        DROP CONSTRAINT user_external_identity_evidence_connection_fk`.execute(trx)
      await sql`ALTER TABLE ${sql.raw(qTable('user_external_identity_evidence'))}
        ADD CONSTRAINT user_external_identity_evidence_connection_fk
        FOREIGN KEY (connection_id) REFERENCES ${sql.raw(qTable('directory_integrations'))} (id)
        ON DELETE CASCADE NOT VALID`.execute(trx)
      await installFirstBirth(trx)
    }))
    expect(wrongForeignKey.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE)
    const foreignKey = await adminPool!.query<{ delete_action: string; validated: boolean }>(
      `SELECT con.confdeltype AS delete_action, con.convalidated AS validated
         FROM pg_constraint con
         JOIN pg_class source ON source.oid = con.conrelid
         JOIN pg_namespace ns ON ns.oid = source.relnamespace
        WHERE ns.nspname = $1
          AND con.conname = 'user_external_identity_evidence_connection_fk'`,
      [schema],
    )
    expect(foreignKey.rows[0]).toEqual({ delete_action: 'r', validated: true })
    const catalogOnly = await rejection(db!.transaction().execute(async (trx) => {
      await sql`SELECT set_config('search_path', 'pg_catalog', true)`.execute(trx)
      await installFirstBirth(trx)
    }))
    expect(catalogOnly.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_PREREQUISITE_CODE)
    await expectInvalidationWithoutFirstBirth()
    await db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await installFirstBirth(trx)
    })
    const disabledDown = await rejection(db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await sql`ALTER TABLE ${sql.raw(qTable('user_external_identities'))} DISABLE TRIGGER admin_grant_identity_invalidate`.execute(trx)
      await removeFirstBirth(trx)
    }))
    expect(disabledDown.code).toBe(ADMIN_GRANT_FIRST_BIRTH_DOWN_PREREQUISITE_CODE)
    const identityTrigger = await adminPool!.query<{ tgenabled: string }>(
      `SELECT t.tgenabled::text AS tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND t.tgname = 'admin_grant_identity_invalidate'`,
      [schema],
    )
    expect(identityTrigger.rows[0]?.tgenabled).toBe('O')
    await expectFirstBirthInstalled()
  }, 20_000)

  it('blocks up when an application pin is already committed and does not bump the parent', async () => {
    await createOwnedSchema()
    await installThroughInvalidation()
    const parent = await insertParents()
    const before = await integrationState(parent.connectionId)
    await insertApplicationPin(parent.connectionId, '4')
    await expectUpBlocked()
    expect(await integrationState(parent.connectionId)).toEqual(before)
    expect(await readApplicationPin(parent.connectionId)).toEqual({
      application_revision: '4',
      material_fingerprint: FINGERPRINT,
    })
  }, 20_000)

  it('blocks up when a binding pin is already committed and does not bump the identity', async () => {
    await createOwnedSchema()
    await installThroughInvalidation()
    const parent = await insertParents()
    const before = await identityState(parent.identityId)
    await insertBindingPin(parent, '2')
    await expectUpBlocked()
    expect(await identityState(parent.identityId)).toEqual(before)
    expect(await readBindingPin(parent.identityId)).toEqual({
      binding_revision: '2',
      external_key: parent.externalKey,
    })
  }, 20_000)

  it('blocks up when evidence is already committed and does not bump either parent', async () => {
    await createOwnedSchema()
    await installThroughInvalidation()
    const parent = await insertParents()
    const evidenceId = randomUUID()
    const integrationBefore = await integrationState(parent.connectionId)
    const identityBefore = await identityState(parent.identityId)
    await insertEvidence(parent, evidenceId, '4')
    await expectUpBlocked()
    expect(await integrationState(parent.connectionId)).toEqual(integrationBefore)
    expect(await identityState(parent.identityId)).toEqual(identityBefore)
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', live_identity_id: parent.identityId, revoked: false })
  }, 20_000)

  it('blocks down when the only receiving row is an application pin', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    await insertApplicationPin(parent.connectionId, '4')
    expect(await receivingCounts()).toEqual({ pins: 1, bindings: 0, evidence: 0 })
    await expectDownBlocked()
    expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
  }, 20_000)

  it('blocks down when the only receiving row is a binding pin', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    await insertBindingPin(parent, '2')
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 1, evidence: 0 })
    await expectDownBlocked()
    expect((await readBindingPin(parent.identityId)).binding_revision).toBe('2')
  }, 20_000)

  it('blocks down when the only receiving row is evidence', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    const evidenceId = randomUUID()
    await insertEvidence(parent, evidenceId, '4')
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 1 })
    await expectDownBlocked()
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
  }, 20_000)

  it('blocks up when a pin commits after the lock wait and before the empty check', async () => {
    await createOwnedSchema()
    await installThroughInvalidation()
    const parent = await insertParents()
    const before = await integrationState(parent.connectionId)
    const inserter = await testPool!.connect()
    let upClient: PoolClient | undefined
    let upOutcome: Promise<Handled<void>> | undefined
    try {
      await inserter.query('BEGIN')
      expect(await insertApplicationPinOn(inserter, parent.connectionId, '4')).toBe(1)
      const inserterPid = await backendPid(inserter)
      upClient = await testPool!.connect()
      await upClient.query('BEGIN')
      await pinCaller(upClient)
      const priorTimeouts = await pinLowerCallerTimeouts(upClient)
      const upPid = await backendPid(upClient)
      upOutcome = handled(installFirstBirth(kyselyOnOpenClient(upClient)))
      await untilLockGate(async () => (
        (await blockingPids(upPid)).includes(inserterPid)
        && await axWaiting(upPid, 'directory_connection_application_pins')
      ))
      await inserter.query('COMMIT')
      const blocked = refused(await upOutcome)
      upOutcome = undefined
      expect(blocked.code).toBe(ADMIN_GRANT_FIRST_BIRTH_UP_BLOCKED_CODE)
      expect(await callerTimeouts(upClient)).toEqual(priorTimeouts)
      await upClient.query('ROLLBACK')
      await expectInvalidationWithoutFirstBirth()
      expect(await integrationState(parent.connectionId)).toEqual(before)
      expect(await receivingCounts()).toEqual({ pins: 1, bindings: 0, evidence: 0 })
    } finally {
      await inserter.query('ROLLBACK').catch(() => undefined)
      inserter.release()
      if (upOutcome) await upOutcome
      if (upClient) {
        await upClient.query('ROLLBACK').catch(() => undefined)
        upClient.release()
      }
    }
  }, 20_000)

  it('blocks down when a pin commits after the lock wait and before the empty check', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    const inserter = await testPool!.connect()
    let downClient: PoolClient | undefined
    let downOutcome: Promise<Handled<void>> | undefined
    try {
      await inserter.query('BEGIN')
      expect(await insertApplicationPinOn(inserter, parent.connectionId, '4')).toBe(1)
      const inserterPid = await backendPid(inserter)
      downClient = await testPool!.connect()
      await downClient.query('BEGIN')
      await pinCaller(downClient)
      const priorTimeouts = await pinLowerCallerTimeouts(downClient)
      const downPid = await backendPid(downClient)
      downOutcome = handled(removeFirstBirth(kyselyOnOpenClient(downClient)))
      await untilLockGate(async () => (
        (await blockingPids(downPid)).includes(inserterPid)
        && await axWaiting(downPid, 'directory_connection_application_pins')
      ))
      await inserter.query('COMMIT')
      const blocked = refused(await downOutcome)
      downOutcome = undefined
      expect(blocked.code).toBe(ADMIN_GRANT_FIRST_BIRTH_DOWN_BLOCKED_CODE)
      expect(await axGranted(downPid, 'directory_connection_application_pins')).toBe(true)
      expect(await axGranted(downPid, 'user_external_identity_evidence')).toBe(true)
      expect(await callerTimeouts(downClient)).toEqual(priorTimeouts)
      await downClient.query('ROLLBACK')
      await expectFirstBirthInstalled()
      expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
    } finally {
      await inserter.query('ROLLBACK').catch(() => undefined)
      inserter.release()
      if (downOutcome) await downOutcome
      if (downClient) {
        await downClient.query('ROLLBACK').catch(() => undefined)
        downClient.release()
      }
    }
  }, 20_000)

  it('runs the new trigger for an insert that waited on up', async () => {
    await createOwnedSchema()
    await installThroughInvalidation()
    const parent = await insertParents()
    const before = await integrationState(parent.connectionId)
    const upClient = await testPool!.connect()
    const pause = pauseAfterEvidenceLock(upClient)
    let inserter: PoolClient | undefined
    let upOutcome: Promise<Handled<void>> | undefined
    let insertOutcome: Promise<Handled<number | null>> | undefined
    try {
      await upClient.query('BEGIN')
      await pinCaller(upClient)
      const upPid = await backendPid(upClient)
      upOutcome = handled(installFirstBirth(pause.db))
      await untilLockGate(async () => pause.paused())
      expect(pause.forwardedCreate()).toBe(false)
      expect(await functionNames(S3_FUNCTIONS)).toEqual([])
      expect(await axGranted(upPid, 'directory_connection_application_pins')).toBe(true)
      expect(await axGranted(upPid, 'user_external_identity_binding_pins')).toBe(true)
      expect(await axGranted(upPid, 'user_external_identity_evidence')).toBe(true)
      expect(await axGranted(upPid, 'directory_integrations')).toBe(false)
      expect(await axGranted(upPid, 'user_external_identities')).toBe(false)
      inserter = await testPool!.connect()
      await inserter.query('BEGIN')
      const insertPid = await backendPid(inserter)
      insertOutcome = handled(insertApplicationPinOn(inserter, parent.connectionId, '4'))
      await untilLockGate(async () => (await blockingPids(insertPid)).includes(upPid))
      pause.release()
      fulfilled(await upOutcome)
      upOutcome = undefined
      await upClient.query('COMMIT')
      expect(fulfilled(await insertOutcome)).toBe(1)
      insertOutcome = undefined
      await inserter.query('COMMIT')
      await expectFirstBirthInstalled()
      const after = await integrationState(parent.connectionId)
      expect(after.ctid).not.toBe(before.ctid)
      expect(after.secret).toBe(before.secret)
      expect(after.scheduleCron).toBe(before.scheduleCron)
      expect(after.updatedAt).toBe(before.updatedAt)
      expect(await readApplicationPin(parent.connectionId)).toEqual({
        application_revision: '4',
        material_fingerprint: FINGERPRINT,
      })
    } finally {
      pause.release()
      if (upOutcome) await upOutcome
      await upClient.query('ROLLBACK').catch(() => undefined)
      upClient.release()
      if (insertOutcome) await insertOutcome
      if (inserter) {
        await inserter.query('ROLLBACK').catch(() => undefined)
        inserter.release()
      }
    }
  }, 20_000)

  it('leaves the prior schema when up rolls back, so a waiting insert does not bump', async () => {
    await createOwnedSchema()
    await installThroughInvalidation()
    const parent = await insertParents()
    const before = await integrationState(parent.connectionId)
    const upClient = await testPool!.connect()
    const pause = pauseAfterEvidenceLock(upClient)
    let inserter: PoolClient | undefined
    let upOutcome: Promise<Handled<void>> | undefined
    let insertOutcome: Promise<Handled<number | null>> | undefined
    try {
      await upClient.query('BEGIN')
      await pinCaller(upClient)
      const upPid = await backendPid(upClient)
      upOutcome = handled(installFirstBirth(pause.db))
      await untilLockGate(async () => pause.paused())
      inserter = await testPool!.connect()
      await inserter.query('BEGIN')
      const insertPid = await backendPid(inserter)
      insertOutcome = handled(insertApplicationPinOn(inserter, parent.connectionId, '4'))
      await untilLockGate(async () => (await blockingPids(insertPid)).includes(upPid))
      expect(pause.forwardedCreate()).toBe(false)
      pause.abandon()
      await upClient.query('ROLLBACK')
      pause.release()
      expect(refused(await upOutcome).message).toContain('first birth continuation abandoned')
      upOutcome = undefined
      expect(fulfilled(await insertOutcome)).toBe(1)
      insertOutcome = undefined
      await inserter.query('COMMIT')
      await expectInvalidationWithoutFirstBirth()
      expect(await integrationState(parent.connectionId)).toEqual(before)
      expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
    } finally {
      pause.abandon()
      pause.release()
      if (upOutcome) await upOutcome
      await upClient.query('ROLLBACK').catch(() => undefined)
      upClient.release()
      if (insertOutcome) await insertOutcome
      if (inserter) {
        await inserter.query('ROLLBACK').catch(() => undefined)
        inserter.release()
      }
    }
  }, 20_000)

  it('propagates lock timeout and creates no admit function', async () => {
    await createOwnedSchema()
    await installThroughInvalidation()
    const holder = await testPool!.connect()
    const upClient = await testPool!.connect()
    const baselineTimeouts = await callerTimeouts(upClient)
    let upOutcome: Promise<Handled<void>> | undefined
    try {
      await holder.query('BEGIN')
      const holderPid = await backendPid(holder)
      await holder.query(`LOCK TABLE ${qTable('directory_connection_application_pins')} IN ACCESS EXCLUSIVE MODE`)
      expect(await axGranted(holderPid, 'directory_connection_application_pins')).toBe(true)
      await upClient.query('BEGIN')
      await pinCaller(upClient)
      const upPid = await backendPid(upClient)
      upOutcome = handled(installFirstBirth(kyselyOnOpenClient(upClient)))
      await untilLockGate(async () => (await blockingPids(upPid)).includes(holderPid))
      const timedOut = refused(await upOutcome)
      upOutcome = undefined
      expect(timedOut.code).toBe('55P03')
      const followUp = await rejection(upClient.query('SELECT 1'))
      expect(followUp.code).toBe('25P02')
      await upClient.query('ROLLBACK')
      await holder.query('ROLLBACK')
      expect(await callerTimeouts(upClient)).toEqual(baselineTimeouts)
      await expectInvalidationWithoutFirstBirth()
    } finally {
      if (upOutcome) await upOutcome
      await upClient.query('ROLLBACK').catch(() => undefined)
      upClient.release()
      await holder.query('ROLLBACK').catch(() => undefined)
      holder.release()
    }
  }, 20_000)

  it('drops only the admit objects and a later birth no longer bumps', async () => {
    await createOwnedSchema()
    await installAll()
    const beforeTimeouts = await sessionTimeouts()
    await db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await removeFirstBirth(trx)
    })
    expect(await sessionTimeouts()).toEqual(beforeTimeouts)
    await expectInvalidationWithoutFirstBirth()
    const parent = await insertParents()
    const before = await integrationState(parent.connectionId)
    const identityBefore = await identityState(parent.identityId)
    await insertApplicationPin(parent.connectionId, '4')
    await insertBindingPin(parent, '2')
    const evidenceId = randomUUID()
    await insertEvidence(parent, evidenceId, '4')
    expect(await integrationState(parent.connectionId)).toEqual(before)
    expect(await identityState(parent.identityId)).toEqual(identityBefore)
    expect(await readApplicationPin(parent.connectionId)).toEqual({
      application_revision: '4',
      material_fingerprint: FINGERPRINT,
    })
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
  }, 20_000)

  it('rejects an unlocked repeatable-read integration update after a committed pin and evidence birth', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const evidenceId = randomUUID()
    const before = await integrationState(parent.connectionId)
    const writer = await testPool!.connect()
    try {
      await beginRepeatableRead(writer)
      await seeRow(writer, 'directory_integrations', parent.connectionId)
      await insertApplicationPin(parent.connectionId, '4')
      await insertEvidence(parent, evidenceId, '4')
      await expectSerializationFailure(writer, materialUpdateSql(), [parent.connectionId, 'B'])
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
    const after = await integrationState(parent.connectionId)
    expect(after.ctid).not.toBe(before.ctid)
    expect(after.secret).toBe('A')
    expect(after.scheduleCron).toBe(before.scheduleCron)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(await readApplicationPin(parent.connectionId)).toEqual({
      application_revision: '4',
      material_fingerprint: FINGERPRINT,
    })
    expect(await readEvidence(evidenceId)).toMatchObject({
      generation: '0',
      live_identity_id: parent.identityId,
      revoked: false,
      application_revision: '4',
    })
  }, 20_000)

  it('rejects an unlocked repeatable-read identity update after a committed binding and evidence birth', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    const evidenceId = randomUUID()
    const before = await identityState(parent.identityId)
    const writer = await testPool!.connect()
    try {
      await beginRepeatableRead(writer)
      await seeRow(writer, 'user_external_identities', parent.identityId)
      await insertBindingPin(parent, '2')
      await insertEvidence(parent, evidenceId, '4')
      await expectSerializationFailure(writer, slotUpdateSql(), [parent.identityId, `${parent.externalKey}-b`])
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
    const after = await identityState(parent.identityId)
    expect(after.ctid).not.toBe(before.ctid)
    expect(after.externalKey).toBe(before.externalKey)
    expect(after.profile).toBe(before.profile)
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(await readBindingPin(parent.identityId)).toEqual({
      binding_revision: '2',
      external_key: parent.externalKey,
    })
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
  }, 20_000)

  it('rejects the integration mutation after the application pin and before evidence', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const before = await integrationState(parent.connectionId)
    const writer = await testPool!.connect()
    try {
      await beginRepeatableRead(writer)
      await seeRow(writer, 'directory_integrations', parent.connectionId)
      await insertApplicationPin(parent.connectionId, '4')
      await expectSerializationFailure(writer, materialUpdateSql(), [parent.connectionId, 'B'])
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
    const after = await integrationState(parent.connectionId)
    expect(after.ctid).not.toBe(before.ctid)
    expect(after.secret).toBe('A')
    expect(await receivingCounts()).toEqual({ pins: 1, bindings: 0, evidence: 0 })
    expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
  }, 20_000)

  it('rejects the integration mutation after evidence and before the application pin', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const evidenceId = randomUUID()
    const before = await integrationState(parent.connectionId)
    const writer = await testPool!.connect()
    try {
      await beginRepeatableRead(writer)
      await seeRow(writer, 'directory_integrations', parent.connectionId)
      await insertEvidence(parent, evidenceId, '4')
      await expectSerializationFailure(writer, materialUpdateSql(), [parent.connectionId, 'B'])
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
    const after = await integrationState(parent.connectionId)
    expect(after.ctid).not.toBe(before.ctid)
    expect(after.secret).toBe('A')
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 1 })
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
  }, 20_000)

  it('rejects the identity mutation after the binding pin and before evidence', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    const before = await identityState(parent.identityId)
    const writer = await testPool!.connect()
    try {
      await beginRepeatableRead(writer)
      await seeRow(writer, 'user_external_identities', parent.identityId)
      await insertBindingPin(parent, '2')
      await expectSerializationFailure(writer, slotUpdateSql(), [parent.identityId, `${parent.externalKey}-b`])
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
    const after = await identityState(parent.identityId)
    expect(after.ctid).not.toBe(before.ctid)
    expect(after.externalKey).toBe(before.externalKey)
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 1, evidence: 0 })
    expect((await readBindingPin(parent.identityId)).binding_revision).toBe('2')
  }, 20_000)

  it('rejects the identity mutation after evidence and before the binding pin', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    const evidenceId = randomUUID()
    const before = await identityState(parent.identityId)
    const writer = await testPool!.connect()
    try {
      await beginRepeatableRead(writer)
      await seeRow(writer, 'user_external_identities', parent.identityId)
      await insertEvidence(parent, evidenceId, '4')
      await expectSerializationFailure(writer, slotUpdateSql(), [parent.identityId, `${parent.externalKey}-b`])
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
    const after = await identityState(parent.identityId)
    expect(after.ctid).not.toBe(before.ctid)
    expect(after.externalKey).toBe(before.externalKey)
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 1 })
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
  }, 20_000)

  it('rejects both later parent mutations when fresh evidence follows a pin-visible snapshot', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    await insertApplicationPin(parent.connectionId, '4')
    await insertBindingPin(parent, '2')
    const integrationWriter = await testPool!.connect()
    const identityWriter = await testPool!.connect()
    const evidenceId = randomUUID()
    try {
      await beginRepeatableRead(integrationWriter)
      await beginRepeatableRead(identityWriter)
      await seeRow(integrationWriter, 'directory_integrations', parent.connectionId)
      await seeRow(identityWriter, 'user_external_identities', parent.identityId)
      await insertEvidence(parent, evidenceId, '4')
      await expectSerializationFailure(integrationWriter, materialUpdateSql(), [parent.connectionId, 'B'])
      await expectSerializationFailure(identityWriter, slotUpdateSql(), [parent.identityId, `${parent.externalKey}-b`])
    } finally {
      await integrationWriter.query('ROLLBACK').catch(() => undefined)
      integrationWriter.release()
      await identityWriter.query('ROLLBACK').catch(() => undefined)
      identityWriter.release()
    }
    expect((await integrationState(parent.connectionId)).secret).toBe('A')
    expect((await identityState(parent.identityId)).externalKey).toBe(parent.externalKey)
    expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
    expect((await readBindingPin(parent.identityId)).binding_revision).toBe('2')
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
  }, 20_000)

  it('waits in read committed, then steps the new application pin once and revokes the new evidence once', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const evidenceId = randomUUID()
    const birth = await testPool!.connect()
    const writer = await testPool!.connect()
    let updateOutcome: Promise<Handled<QueryResult>> | undefined
    try {
      await birth.query('BEGIN')
      await pinCaller(birth)
      expect(await insertApplicationPinOn(birth, parent.connectionId, '4')).toBe(1)
      expect(await insertEvidenceOn(birth, parent, evidenceId, '4')).toBe(1)
      await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await pinCaller(writer)
      await writer.query(`SELECT set_config('lock_timeout', '8s', true)`)
      const birthPid = await backendPid(birth)
      const writerPid = await backendPid(writer)
      updateOutcome = handled(writer.query(materialUpdateSql(), [parent.connectionId, 'B']))
      await untilLockGate(async () => (await blockingPids(writerPid)).includes(birthPid))
      await birth.query('COMMIT')
      expect(fulfilled(await updateOutcome).rowCount).toBe(1)
      updateOutcome = undefined
      await writer.query('COMMIT')
      expect((await integrationState(parent.connectionId)).secret).toBe('B')
      expect(await readApplicationPin(parent.connectionId)).toEqual({
        application_revision: '5',
        material_fingerprint: FINGERPRINT,
      })
      expect(await readEvidence(evidenceId)).toMatchObject({
        generation: '1',
        live_identity_id: null,
        revoked: true,
        application_revision: '4',
      })
    } finally {
      await birth.query('ROLLBACK').catch(() => undefined)
      birth.release()
      if (updateOutcome) await updateOutcome
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
  }, 20_000)

  it('waits in read committed, then steps the new binding pin once and revokes the new evidence once', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    const evidenceId = randomUUID()
    const nextKey = `${parent.externalKey}-slot`
    const birth = await testPool!.connect()
    const writer = await testPool!.connect()
    let updateOutcome: Promise<Handled<QueryResult>> | undefined
    try {
      await birth.query('BEGIN')
      await pinCaller(birth)
      expect(await insertBindingPinOn(birth, parent, '2')).toBe(1)
      expect(await insertEvidenceOn(birth, parent, evidenceId, '4')).toBe(1)
      await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await pinCaller(writer)
      await writer.query(`SELECT set_config('lock_timeout', '8s', true)`)
      const birthPid = await backendPid(birth)
      const writerPid = await backendPid(writer)
      updateOutcome = handled(writer.query(slotUpdateSql(), [parent.identityId, nextKey]))
      await untilLockGate(async () => (await blockingPids(writerPid)).includes(birthPid))
      await birth.query('COMMIT')
      expect(fulfilled(await updateOutcome).rowCount).toBe(1)
      updateOutcome = undefined
      await writer.query('COMMIT')
      expect((await identityState(parent.identityId)).externalKey).toBe(nextKey)
      expect(await readBindingPin(parent.identityId)).toEqual({
        binding_revision: '3',
        external_key: nextKey,
      })
      expect(await readEvidence(evidenceId)).toMatchObject({
        generation: '1',
        live_identity_id: null,
        revoked: true,
      })
    } finally {
      await birth.query('ROLLBACK').catch(() => undefined)
      birth.release()
      if (updateOutcome) await updateOutcome
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
  }, 20_000)

  it('keeps parent values and live receiving rows when all three rows are born together', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const evidenceId = randomUUID()
    const integrationBefore = await integrationState(parent.connectionId)
    const identityBefore = await identityState(parent.identityId)
    const client = await testPool!.connect()
    try {
      await client.query('BEGIN')
      await pinCaller(client)
      expect(await insertApplicationPinOn(client, parent.connectionId, '4')).toBe(1)
      expect(await insertBindingPinOn(client, parent, '2')).toBe(1)
      expect(await insertEvidenceOn(client, parent, evidenceId, '4')).toBe(1)
      const integrationMid = await integrationState(parent.connectionId, client)
      const identityMid = await identityState(parent.identityId, client)
      expect(integrationMid.ctid).not.toBe(integrationBefore.ctid)
      expect(identityMid.ctid).not.toBe(identityBefore.ctid)
      expect(integrationMid.secret).toBe('A')
      expect(integrationMid.updatedAt).toBe(integrationBefore.updatedAt)
      expect(identityMid.externalKey).toBe(identityBefore.externalKey)
      expect(identityMid.profile).toBe(identityBefore.profile)
      expect(identityMid.updatedAt).toBe(identityBefore.updatedAt)
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
    expect(await readBindingPin(parent.identityId)).toEqual({
      binding_revision: '2',
      external_key: parent.externalKey,
    })
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
    expect(await receivingCounts()).toEqual({ pins: 1, bindings: 1, evidence: 1 })
  }, 20_000)

  it('commits dormant repeatable-read and read-committed parent writes without receiving rows', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const repeatable = await testPool!.connect()
    try {
      await beginRepeatableRead(repeatable)
      await seeRow(repeatable, 'directory_integrations', parent.connectionId)
      await seeRow(repeatable, 'user_external_identities', parent.identityId)
      expect((await repeatable.query(materialUpdateSql(), [parent.connectionId, 'B'])).rowCount).toBe(1)
      expect((await repeatable.query(slotUpdateSql(), [parent.identityId, `${parent.externalKey}-b`])).rowCount).toBe(1)
      await repeatable.query('COMMIT')
    } finally {
      await repeatable.query('ROLLBACK').catch(() => undefined)
      repeatable.release()
    }
    expect((await integrationState(parent.connectionId)).secret).toBe('B')
    expect((await identityState(parent.identityId)).externalKey).toBe(`${parent.externalKey}-b`)
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 0 })
    const committed = await testPool!.connect()
    try {
      await committed.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await pinCaller(committed)
      expect((await committed.query(materialUpdateSql(), [parent.connectionId, 'C'])).rowCount).toBe(1)
      expect((await committed.query(slotUpdateSql(), [parent.identityId, `${parent.externalKey}-c`])).rowCount).toBe(1)
      await committed.query('COMMIT')
    } finally {
      await committed.query('ROLLBACK').catch(() => undefined)
      committed.release()
    }
    expect((await integrationState(parent.connectionId)).secret).toBe('C')
    expect((await identityState(parent.identityId)).externalKey).toBe(`${parent.externalKey}-c`)
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 0 })
  }, 20_000)

  it('steps and revokes once when the receiving rows are already visible', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const evidenceId = randomUUID()
    await insertApplicationPin(parent.connectionId, '4')
    await insertBindingPin(parent, '2')
    await insertEvidence(parent, evidenceId, '4')
    const nextKey = `${parent.externalKey}-visible`
    const writer = await testPool!.connect()
    try {
      await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await pinCaller(writer)
      expect((await writer.query(materialUpdateSql(), [parent.connectionId, 'B'])).rowCount).toBe(1)
      expect((await writer.query(slotUpdateSql(), [parent.identityId, nextKey])).rowCount).toBe(1)
      await writer.query('COMMIT')
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
    }
    expect((await integrationState(parent.connectionId)).secret).toBe('B')
    expect((await identityState(parent.identityId)).externalKey).toBe(nextKey)
    expect(await readApplicationPin(parent.connectionId)).toEqual({
      application_revision: '5',
      material_fingerprint: FINGERPRINT,
    })
    expect(await readBindingPin(parent.identityId)).toEqual({
      binding_revision: '3',
      external_key: nextKey,
    })
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '1', live_identity_id: null, revoked: true })
  }, 20_000)

  it('restores the parent ctid and inserts nothing when the birth rolls back', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const integrationBefore = await integrationState(parent.connectionId)
    const identityBefore = await identityState(parent.identityId)
    const client = await testPool!.connect()
    try {
      await client.query('BEGIN')
      await pinCaller(client)
      expect(await insertApplicationPinOn(client, parent.connectionId, '4')).toBe(1)
      expect(await insertBindingPinOn(client, parent, '2')).toBe(1)
      const integrationMid = await integrationState(parent.connectionId, client)
      const identityMid = await identityState(parent.identityId, client)
      expect(integrationMid.ctid).not.toBe(integrationBefore.ctid)
      expect(identityMid.ctid).not.toBe(identityBefore.ctid)
      await client.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    expect(await integrationState(parent.connectionId)).toEqual(integrationBefore)
    expect(await identityState(parent.identityId)).toEqual(identityBefore)
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 0 })
  }, 20_000)

  it('leaves ctid unchanged on conflict do nothing and still invalidates a visible repeatable-read write', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const evidenceId = randomUUID()
    await insertApplicationPin(parent.connectionId, '4')
    await insertEvidence(parent, evidenceId, '4')
    const before = await integrationState(parent.connectionId)
    const writer = await testPool!.connect()
    const duplicate = await testPool!.connect()
    try {
      await beginRepeatableRead(writer)
      await seeRow(writer, 'directory_integrations', parent.connectionId)
      await duplicate.query(
        `INSERT INTO ${qTable('directory_connection_application_pins')}
           (connection_id, application_revision, material_fingerprint, updated_by)
         VALUES ($1::uuid, '9', $2, 'suite')
         ON CONFLICT (connection_id) DO NOTHING`,
        [parent.connectionId, FINGERPRINT],
      )
      expect(await integrationState(parent.connectionId)).toEqual(before)
      expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
      expect((await writer.query(materialUpdateSql(), [parent.connectionId, 'B'])).rowCount).toBe(1)
      await writer.query('COMMIT')
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined)
      writer.release()
      duplicate.release()
    }
    expect((await integrationState(parent.connectionId)).secret).toBe('B')
    expect(await readApplicationPin(parent.connectionId)).toEqual({
      application_revision: '5',
      material_fingerprint: FINGERPRINT,
    })
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '1', live_identity_id: null, revoked: true })
  }, 20_000)

  it('returns native 23503 for a missing parent and inserts nothing', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents()
    const missing = randomUUID()
    const application = await rejection(testPool!.query(
      `INSERT INTO ${qTable('directory_connection_application_pins')}
         (connection_id, application_revision, material_fingerprint, updated_by)
       VALUES ($1::uuid, '4', $2, 'suite')`,
      [missing, FINGERPRINT],
    ))
    expect(application.code).toBe('23503')
    const binding = await rejection(testPool!.query(
      `INSERT INTO ${qTable('user_external_identity_binding_pins')}
         (identity_id, binding_revision, provider, local_user_id, external_key)
       VALUES ($1::uuid, 2, 'stub', $2, $3)`,
      [missing, parent.userId, parent.externalKey],
    ))
    expect(binding.code).toBe('23503')
    const missingConnection = await rejection(testPool!.query(
      `INSERT INTO ${qTable('user_external_identity_evidence')}
         (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
          assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
          application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
          revocation_generation, slot_snapshot, created_by)
       VALUES ($1, $2, $3::text, ($3::text)::uuid, 2, 'fixture-not-a-producer',
               'self_authenticated', $4, 'synthetic-app', $5, $6::uuid, 1,
               '4', $7, 1, now() - interval '1 hour', now() + interval '1 day',
               0, '{}'::jsonb, 'suite')`,
      [randomUUID(), randomUUID(), parent.identityId, parent.externalKey, parent.orgId, missing, FINGERPRINT],
    ))
    expect(missingConnection.code).toBe('23503')
    const missingIdentity = randomUUID()
    const missingLive = await rejection(testPool!.query(
      `INSERT INTO ${qTable('user_external_identity_evidence')}
         (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id,
          assurance, subject_key, app_scope, org_id, connection_id, capability_revision_seen,
          application_revision, material_fingerprint, evidence_revision, witnessed_at, fresh_until,
          revocation_generation, slot_snapshot, created_by)
       VALUES ($1, $2, $3::text, ($3::text)::uuid, 2, 'fixture-not-a-producer',
               'self_authenticated', $4, 'synthetic-app', $5, $6::uuid, 1,
               '4', $7, 1, now() - interval '1 hour', now() + interval '1 day',
               0, '{}'::jsonb, 'suite')`,
      [randomUUID(), randomUUID(), missingIdentity, parent.externalKey, parent.orgId, parent.connectionId, FINGERPRINT],
    ))
    expect(missingLive.code).toBe('23503')
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 0 })
  }, 20_000)

  it('bumps the owned parents when the caller path and shadow tables disagree', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A')
    const integrationBefore = await integrationState(parent.connectionId)
    const identityBefore = await identityState(parent.identityId)
    extraSchema = `${SHADOW_PREFIX}${randomUUID()}`
    if (!isGenerated(extraSchema, SHADOW_PREFIX)) throw new Error('shadow schema name was not generated by this test')
    const shadow = quoteIdent(extraSchema)
    await adminPool!.query(`CREATE SCHEMA ${shadow}`)
    await adminPool!.query(`
      CREATE TABLE ${shadow}.directory_integrations (
        id uuid PRIMARY KEY,
        schedule_cron text,
        config jsonb
      );
      CREATE TABLE ${shadow}.user_external_identities (
        id uuid PRIMARY KEY,
        external_key text,
        profile jsonb
      )
    `)
    await adminPool!.query(
      `INSERT INTO ${shadow}.directory_integrations (id, schedule_cron, config)
       VALUES ($1::uuid, 'shadow-cron', '{"appSecret":"shadow"}'::jsonb)`,
      [parent.connectionId],
    )
    await adminPool!.query(
      `INSERT INTO ${shadow}.user_external_identities (id, external_key, profile)
       VALUES ($1::uuid, 'shadow-key', '{"shadow":true}'::jsonb)`,
      [parent.identityId],
    )
    const client = await testPool!.connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        CREATE TEMP TABLE directory_integrations (
          id uuid PRIMARY KEY,
          schedule_cron text,
          config jsonb
        ) ON COMMIT PRESERVE ROWS;
        CREATE TEMP TABLE user_external_identities (
          id uuid PRIMARY KEY,
          external_key text,
          profile jsonb
        ) ON COMMIT PRESERVE ROWS
      `)
      await client.query(
        `INSERT INTO pg_temp.directory_integrations (id, schedule_cron, config)
         VALUES ($1::uuid, 'temp-cron', '{"appSecret":"temp"}'::jsonb)`,
        [parent.connectionId],
      )
      await client.query(
        `INSERT INTO pg_temp.user_external_identities (id, external_key, profile)
         VALUES ($1::uuid, 'temp-key', '{"temp":true}'::jsonb)`,
        [parent.identityId],
      )
      await client.query(`SELECT set_config('search_path', $1, true)`, [`${quoteIdent(extraSchema)}, pg_temp`])
      expect(await insertApplicationPinOn(client, parent.connectionId, '4')).toBe(1)
      expect(await insertBindingPinOn(client, parent, '2')).toBe(1)
      const evidenceId = randomUUID()
      expect(await insertEvidenceOn(client, parent, evidenceId, '4')).toBe(1)
      const tempIntegration = await client.query<{ schedule_cron: string; same_config: boolean }>(
        `SELECT schedule_cron, config = '{"appSecret":"temp"}'::jsonb AS same_config
           FROM pg_temp.directory_integrations WHERE id = $1::uuid`,
        [parent.connectionId],
      )
      const tempIdentity = await client.query<{ external_key: string; same_profile: boolean }>(
        `SELECT external_key, profile = '{"temp":true}'::jsonb AS same_profile
           FROM pg_temp.user_external_identities WHERE id = $1::uuid`,
        [parent.identityId],
      )
      expect(tempIntegration.rows[0]).toEqual({ schedule_cron: 'temp-cron', same_config: true })
      expect(tempIdentity.rows[0]).toEqual({ external_key: 'temp-key', same_profile: true })
      await client.query('COMMIT')
      expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const shadowIntegration = await adminPool!.query<{ schedule_cron: string; same_config: boolean }>(
      `SELECT schedule_cron, config = '{"appSecret":"shadow"}'::jsonb AS same_config
         FROM ${shadow}.directory_integrations WHERE id = $1::uuid`,
      [parent.connectionId],
    )
    const shadowIdentity = await adminPool!.query<{ external_key: string; same_profile: boolean }>(
      `SELECT external_key, profile = '{"shadow":true}'::jsonb AS same_profile
         FROM ${shadow}.user_external_identities WHERE id = $1::uuid`,
      [parent.identityId],
    )
    expect(shadowIntegration.rows[0]).toEqual({ schedule_cron: 'shadow-cron', same_config: true })
    expect(shadowIdentity.rows[0]).toEqual({ external_key: 'shadow-key', same_profile: true })
    const integrationAfter = await integrationState(parent.connectionId)
    const identityAfter = await identityState(parent.identityId)
    expect(integrationAfter.ctid).not.toBe(integrationBefore.ctid)
    expect(identityAfter.ctid).not.toBe(identityBefore.ctid)
    expect(integrationAfter.secret).toBe('A')
    expect(integrationAfter.scheduleCron).toBe(integrationBefore.scheduleCron)
    expect(integrationAfter.updatedAt).toBe(integrationBefore.updatedAt)
    expect(identityAfter.externalKey).toBe(identityBefore.externalKey)
    expect(identityAfter.profile).toBe(identityBefore.profile)
    expect(identityAfter.updatedAt).toBe(identityBefore.updatedAt)
    expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
    expect((await readBindingPin(parent.identityId)).binding_revision).toBe('2')
  }, 20_000)

  it('installs and bumps ordinary parents in a schema containing the old delimiter, quotes, and a backslash', async () => {
    await createOwnedSchema('ordinary', LEGAL_SCHEMA_PREFIX)
    expect(schema.includes('$agr_s3$')).toBe(true)
    expect(schema.includes("'")).toBe(true)
    expect(schema.includes('"')).toBe(true)
    expect(schema.includes('\\')).toBe(true)
    expect(await columnMarks('directory_integrations', 'schedule_cron')).toEqual({ generated: '', identity: '' })
    expect(await columnMarks('user_external_identities', 'profile')).toEqual({ generated: '', identity: '' })
    await installThroughInvalidation()
    await db!.transaction().execute(async (trx) => {
      await pinKysely(trx)
      await sql`SELECT set_config('standard_conforming_strings', 'off', true)`.execute(trx)
      const setting = await sql<{ value: string }>`SELECT current_setting('standard_conforming_strings') AS value`.execute(trx)
      expect(setting.rows[0]?.value).toBe('off')
      await installFirstBirth(trx)
    })
    await expectFirstBirthInstalled()
    const procedure = await adminPool!.query<{ prosrc: string; proconfig: string[] | string | null }>(
      `SELECT p.prosrc, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = 'admin_grant_receiving_admit'`,
      [schema],
    )
    const body = procedure.rows[0]?.prosrc ?? ''
    const configText = Array.isArray(procedure.rows[0]?.proconfig)
      ? procedure.rows[0].proconfig.map((item) => String(item)).join('\n')
      : String(procedure.rows[0]?.proconfig ?? '')
    expect(embeddedInstallSchema(body)).toBe(schema)
    expect(configText).toContain(`search_path=pg_catalog, ${quoteIdent(schema)}, pg_temp`)
    const parent = await insertParents('A')
    const integrationBefore = await integrationState(parent.connectionId)
    const identityBefore = await identityState(parent.identityId)
    extraSchema = `${SHADOW_PREFIX}${randomUUID()}`
    if (!isGenerated(extraSchema, SHADOW_PREFIX)) throw new Error('shadow schema name was not generated by this test')
    const shadow = quoteIdent(extraSchema)
    await adminPool!.query(`CREATE SCHEMA ${shadow}`)
    await adminPool!.query(`
      CREATE TABLE ${shadow}.directory_integrations (
        id uuid PRIMARY KEY,
        schedule_cron text,
        config jsonb
      );
      CREATE TABLE ${shadow}.user_external_identities (
        id uuid PRIMARY KEY,
        external_key text,
        profile jsonb
      )
    `)
    await adminPool!.query(
      `INSERT INTO ${shadow}.directory_integrations (id, schedule_cron, config)
       VALUES ($1::uuid, 'shadow-cron', '{"appSecret":"shadow"}'::jsonb)`,
      [parent.connectionId],
    )
    await adminPool!.query(
      `INSERT INTO ${shadow}.user_external_identities (id, external_key, profile)
       VALUES ($1::uuid, 'shadow-key', '{"shadow":true}'::jsonb)`,
      [parent.identityId],
    )
    const client = await testPool!.connect()
    const evidenceId = randomUUID()
    try {
      await client.query('BEGIN')
      await client.query(`
        CREATE TEMP TABLE directory_integrations (
          id uuid PRIMARY KEY,
          schedule_cron text,
          config jsonb
        ) ON COMMIT PRESERVE ROWS;
        CREATE TEMP TABLE user_external_identities (
          id uuid PRIMARY KEY,
          external_key text,
          profile jsonb
        ) ON COMMIT PRESERVE ROWS
      `)
      await client.query(
        `INSERT INTO pg_temp.directory_integrations (id, schedule_cron, config)
         VALUES ($1::uuid, 'temp-cron', '{"appSecret":"temp"}'::jsonb)`,
        [parent.connectionId],
      )
      await client.query(
        `INSERT INTO pg_temp.user_external_identities (id, external_key, profile)
         VALUES ($1::uuid, 'temp-key', '{"temp":true}'::jsonb)`,
        [parent.identityId],
      )
      await client.query(`SELECT set_config('search_path', $1, true)`, [`${quoteIdent(extraSchema)}, pg_temp`])
      expect(await insertApplicationPinOn(client, parent.connectionId, '4')).toBe(1)
      expect(await insertBindingPinOn(client, parent, '2')).toBe(1)
      expect(await insertEvidenceOn(client, parent, evidenceId, '4')).toBe(1)
      const tempIntegration = await client.query<{ schedule_cron: string; same_config: boolean }>(
        `SELECT schedule_cron, config = '{"appSecret":"temp"}'::jsonb AS same_config
           FROM pg_temp.directory_integrations WHERE id = $1::uuid`,
        [parent.connectionId],
      )
      const tempIdentity = await client.query<{ external_key: string; same_profile: boolean }>(
        `SELECT external_key, profile = '{"temp":true}'::jsonb AS same_profile
           FROM pg_temp.user_external_identities WHERE id = $1::uuid`,
        [parent.identityId],
      )
      expect(tempIntegration.rows[0]).toEqual({ schedule_cron: 'temp-cron', same_config: true })
      expect(tempIdentity.rows[0]).toEqual({ external_key: 'temp-key', same_profile: true })
      await client.query('COMMIT')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
    const shadowIntegration = await adminPool!.query<{ schedule_cron: string; same_config: boolean }>(
      `SELECT schedule_cron, config = '{"appSecret":"shadow"}'::jsonb AS same_config
         FROM ${shadow}.directory_integrations WHERE id = $1::uuid`,
      [parent.connectionId],
    )
    const shadowIdentity = await adminPool!.query<{ external_key: string; same_profile: boolean }>(
      `SELECT external_key, profile = '{"shadow":true}'::jsonb AS same_profile
         FROM ${shadow}.user_external_identities WHERE id = $1::uuid`,
      [parent.identityId],
    )
    expect(shadowIntegration.rows[0]).toEqual({ schedule_cron: 'shadow-cron', same_config: true })
    expect(shadowIdentity.rows[0]).toEqual({ external_key: 'shadow-key', same_profile: true })
    const integrationAfter = await integrationState(parent.connectionId)
    const identityAfter = await identityState(parent.identityId)
    expect(integrationAfter.ctid).not.toBe(integrationBefore.ctid)
    expect(identityAfter.ctid).not.toBe(identityBefore.ctid)
    expect(integrationAfter.secret).toBe('A')
    expect(integrationAfter.scheduleCron).toBe(integrationBefore.scheduleCron)
    expect(integrationAfter.updatedAt).toBe(integrationBefore.updatedAt)
    expect(identityAfter.externalKey).toBe(identityBefore.externalKey)
    expect(identityAfter.profile).toBe(identityBefore.profile)
    expect(identityAfter.updatedAt).toBe(identityBefore.updatedAt)
    expect((await readApplicationPin(parent.connectionId)).application_revision).toBe('4')
    expect((await readBindingPin(parent.identityId)).binding_revision).toBe('2')
    expect(await readEvidence(evidenceId)).toMatchObject({ generation: '0', revoked: false, live_identity_id: parent.identityId })
  }, 20_000)

  it('refuses up before any admit object when schedule_cron is generated', async () => {
    await createOwnedSchema('generated-schedule', GENERATED_SCHEDULE_PREFIX)
    await installThroughInvalidation()
    expect(await columnMarks('directory_integrations', 'schedule_cron')).toEqual({ generated: 's', identity: '' })
    expect(await columnMarks('user_external_identities', 'profile')).toEqual({ generated: '', identity: '' })
    await expectInvalidationWithoutFirstBirth()
    await expectUpRefusesBeforeAdmitObjects()
  }, 20_000)

  it('refuses up before any admit object when profile is generated', async () => {
    await createOwnedSchema('generated-profile', GENERATED_PROFILE_PREFIX)
    await installThroughInvalidation()
    expect(await columnMarks('directory_integrations', 'schedule_cron')).toEqual({ generated: '', identity: '' })
    expect(await columnMarks('user_external_identities', 'profile')).toEqual({ generated: 's', identity: '' })
    await expectInvalidationWithoutFirstBirth()
    await expectUpRefusesBeforeAdmitObjects()
  }, 20_000)

  it('blocks an application pin birth on a real integration FOR SHARE and commits it after release', async () => {
    await expectParentShareSerializesBirth('integration')
  }, 20_000)

  it('blocks a binding pin birth on a real identity FOR SHARE and commits it after release', async () => {
    await expectParentShareSerializesBirth('identity')
  }, 20_000)

  it('runs the real repair guard on owned users during a hostile-path binding and evidence birth', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A', 'dingtalk')
    const neighbor = await insertParents('N', 'stub')
    expect(parent.provider).toBe('dingtalk')
    expect(neighbor.provider).toBe('stub')
    const integrationBefore = await integrationState(parent.connectionId)
    const identityBefore = await identitySlots(parent.identityId)
    const neighborIntegrationBefore = await integrationState(neighbor.connectionId)
    const neighborIdentityBefore = await identitySlots(neighbor.identityId)
    const parentUserBefore = await userCtid(parent.userId)
    const neighborUserBefore = await userCtid(neighbor.userId)
    await installOwnedRepair()
    await expectRepairInstalled()
    expect(await repairCount()).toBe(0)
    const shadowIdentity = {
      external_key: 'shadow-pinned',
      provider_open_id: 'shadow-open',
      corp_id: 'shadow-corp',
      provider_union_id: 'shadow-union',
    }
    const tempIdentity = {
      external_key: 'temp-pinned',
      provider_open_id: 'temp-open',
      corp_id: 'temp-corp',
      provider_union_id: 'temp-union',
    }
    extraSchema = `${SHADOW_PREFIX}${randomUUID()}`
    if (!isGenerated(extraSchema, SHADOW_PREFIX)) throw new Error('shadow schema name was not generated by this test')
    const shadow = quoteIdent(extraSchema)
    await adminPool!.query(`CREATE SCHEMA ${shadow}`)
    await adminPool!.query(`
      CREATE TABLE ${shadow}.users (
        id text PRIMARY KEY,
        sentinel text NOT NULL
      )
    `)
    await adminPool!.query(`
      CREATE TABLE ${shadow}.dingtalk_login_repairs (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        state text NOT NULL,
        expected_identity jsonb NOT NULL
      )
    `)
    await adminPool!.query(
      `INSERT INTO ${shadow}.users (id, sentinel) VALUES ($1, 'shadow-user')`,
      [parent.userId],
    )
    await adminPool!.query(
      `INSERT INTO ${shadow}.dingtalk_login_repairs (id, user_id, state, expected_identity)
       VALUES ($1::uuid, $2, 'applied', $3::jsonb)`,
      [randomUUID(), parent.userId, JSON.stringify(shadowIdentity)],
    )
    const birth = await testPool!.connect()
    const userNoKeyProbe = await testPool!.connect()
    const identityProbe = await testPool!.connect()
    const shadowProbe = await testPool!.connect()
    let userNoKeyWait: Promise<Handled<QueryResult<{ id: string }>>> | undefined
    let identityWait: Promise<Handled<QueryResult<{ id: string }>>> | undefined
    const evidenceId = randomUUID()
    try {
      await birth.query('BEGIN')
      await birth.query(`SELECT set_config('lock_timeout', '8s', true)`)
      await birth.query(`
        CREATE TEMP TABLE users (
          id text PRIMARY KEY,
          sentinel text NOT NULL
        ) ON COMMIT PRESERVE ROWS
      `)
      await birth.query(`
        CREATE TEMP TABLE dingtalk_login_repairs (
          id uuid PRIMARY KEY,
          user_id text NOT NULL,
          state text NOT NULL,
          expected_identity jsonb NOT NULL
        ) ON COMMIT PRESERVE ROWS
      `)
      await birth.query(
        `INSERT INTO pg_temp.users (id, sentinel) VALUES ($1, 'temp-user')`,
        [parent.userId],
      )
      await birth.query(
        `INSERT INTO pg_temp.dingtalk_login_repairs (id, user_id, state, expected_identity)
         VALUES ($1::uuid, $2, 'applied', $3::jsonb)`,
        [randomUUID(), parent.userId, JSON.stringify(tempIdentity)],
      )
      await birth.query(`SELECT set_config('search_path', $1, true)`, [`${shadow}, pg_temp`])
      expect(await insertBindingPinOn(birth, parent, '2')).toBe(1)
      expect(await insertEvidenceOn(birth, parent, evidenceId, '4')).toBe(1)
      const callerSchema = await birth.query<{ schema_name: string | null }>(
        `SELECT current_schema() AS schema_name`,
      )
      expect(callerSchema.rows[0]?.schema_name).toBe(extraSchema)
      const tempUser = await birth.query<{ sentinel: string }>(
        `SELECT sentinel FROM pg_temp.users WHERE id = $1`,
        [parent.userId],
      )
      const tempRepair = await birth.query<{ state: string; same_identity: boolean }>(
        `SELECT state, expected_identity = $2::jsonb AS same_identity
           FROM pg_temp.dingtalk_login_repairs WHERE user_id = $1`,
        [parent.userId, JSON.stringify(tempIdentity)],
      )
      expect(tempUser.rows).toEqual([{ sentinel: 'temp-user' }])
      expect(tempRepair.rows).toEqual([{ state: 'applied', same_identity: true }])
      const ownedRepairs = await birth.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${qTable('dingtalk_login_repairs')}`,
      )
      expect(ownedRepairs.rows[0]?.count).toBe(0)
      await userNoKeyProbe.query('BEGIN')
      await userNoKeyProbe.query(`SELECT set_config('lock_timeout', '8s', true)`)
      await identityProbe.query('BEGIN')
      await identityProbe.query(`SELECT set_config('lock_timeout', '8s', true)`)
      const birthPid = await backendPid(birth)
      const userNoKeyPid = await backendPid(userNoKeyProbe)
      const identityPid = await backendPid(identityProbe)
      expect(new Set([birthPid, userNoKeyPid, identityPid]).size).toBe(3)
      userNoKeyWait = handled(userNoKeyProbe.query<{ id: string }>(
        `SELECT id FROM ${qTable('users')} WHERE id = $1 FOR NO KEY UPDATE`,
        [parent.userId],
      ))
      await untilLockGate(async () => (await blockingPids(userNoKeyPid)).includes(birthPid))
      expect(await blockingPids(userNoKeyPid)).toContain(birthPid)
      const userNoKeyActivity = await waitingActivity(userNoKeyPid)
      expect(userNoKeyActivity.waitEventType).toBe('Lock')
      expect(userNoKeyActivity.query).toContain('FOR NO KEY UPDATE')
      expect(userNoKeyActivity.query).toContain(quoteIdent('users'))
      identityWait = handled(identityProbe.query<{ id: string }>(
        `SELECT id FROM ${qTable('user_external_identities')} WHERE id = $1::uuid FOR SHARE`,
        [parent.identityId],
      ))
      await untilLockGate(async () => (await blockingPids(identityPid)).includes(birthPid))
      expect(await blockingPids(identityPid)).toContain(birthPid)
      const identityActivity = await waitingActivity(identityPid)
      expect(identityActivity.waitEventType).toBe('Lock')
      expect(identityActivity.query).toContain('FOR SHARE')
      expect(identityActivity.query).toContain(quoteIdent('user_external_identities'))
      await shadowProbe.query('BEGIN')
      await shadowProbe.query(`SELECT set_config('lock_timeout', '8s', true)`)
      const shadowUser = await shadowProbe.query<{ sentinel: string }>(
        `SELECT sentinel FROM ${shadow}.users WHERE id = $1 FOR UPDATE`,
        [parent.userId],
      )
      expect(shadowUser.rows).toEqual([{ sentinel: 'shadow-user' }])
      const shadowRepair = await adminPool!.query<{ state: string; same_identity: boolean }>(
        `SELECT state, expected_identity = $2::jsonb AS same_identity
           FROM ${shadow}.dingtalk_login_repairs WHERE user_id = $1`,
        [parent.userId, JSON.stringify(shadowIdentity)],
      )
      expect(shadowRepair.rows).toEqual([{ state: 'applied', same_identity: true }])
      expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 0 })
      expect(await integrationState(parent.connectionId)).toEqual(integrationBefore)
      expect(await identitySlots(parent.identityId)).toEqual(identityBefore)
      await birth.query('COMMIT')
      expect(fulfilled(await identityWait).rows[0]?.id).toBe(parent.identityId)
      identityWait = undefined
      const userNoKey = fulfilled(await userNoKeyWait)
      userNoKeyWait = undefined
      expect(userNoKey.rowCount).toBe(1)
      expect(userNoKey.rows[0]?.id).toBe(parent.userId)
      await userNoKeyProbe.query('ROLLBACK')
      const tempUserAfter = await birth.query<{ sentinel: string }>(
        `SELECT sentinel FROM pg_temp.users WHERE id = $1`,
        [parent.userId],
      )
      const tempRepairAfter = await birth.query<{ state: string; same_identity: boolean }>(
        `SELECT state, expected_identity = $2::jsonb AS same_identity
           FROM pg_temp.dingtalk_login_repairs WHERE user_id = $1`,
        [parent.userId, JSON.stringify(tempIdentity)],
      )
      expect(tempUserAfter.rows).toEqual([{ sentinel: 'temp-user' }])
      expect(tempRepairAfter.rows).toEqual([{ state: 'applied', same_identity: true }])
    } finally {
      await birth.query('ROLLBACK').catch(() => undefined)
      if (identityWait) await identityWait
      await identityProbe.query('ROLLBACK').catch(() => undefined)
      identityProbe.release()
      if (userNoKeyWait) await userNoKeyWait
      await userNoKeyProbe.query('ROLLBACK').catch(() => undefined)
      userNoKeyProbe.release()
      await shadowProbe.query('ROLLBACK').catch(() => undefined)
      shadowProbe.release()
      birth.release()
    }
    const shadowUserAfter = await adminPool!.query<{ sentinel: string }>(
      `SELECT sentinel FROM ${shadow}.users WHERE id = $1`,
      [parent.userId],
    )
    const shadowRepairAfter = await adminPool!.query<{ state: string; same_identity: boolean }>(
      `SELECT state, expected_identity = $2::jsonb AS same_identity
         FROM ${shadow}.dingtalk_login_repairs WHERE user_id = $1`,
      [parent.userId, JSON.stringify(shadowIdentity)],
    )
    expect(shadowUserAfter.rows).toEqual([{ sentinel: 'shadow-user' }])
    expect(shadowRepairAfter.rows).toEqual([{ state: 'applied', same_identity: true }])
    expect(await repairCount()).toBe(0)
    const integrationAfter = await integrationState(parent.connectionId)
    const identityAfter = await identitySlots(parent.identityId)
    expect(integrationAfter.ctid).not.toBe(integrationBefore.ctid)
    expect(integrationAfter.secret).toBe('A')
    expect(integrationAfter.scheduleCron).toBe(integrationBefore.scheduleCron)
    expect(integrationAfter.updatedAt).toBe(integrationBefore.updatedAt)
    expect(identityAfter.ctid).not.toBe(identityBefore.ctid)
    expect({ ...identityAfter, ctid: identityBefore.ctid }).toEqual(identityBefore)
    expect(await userCtid(parent.userId)).toBe(parentUserBefore)
    expect(await userCtid(neighbor.userId)).toBe(neighborUserBefore)
    expect(await integrationState(neighbor.connectionId)).toEqual(neighborIntegrationBefore)
    expect(await identitySlots(neighbor.identityId)).toEqual(neighborIdentityBefore)
    expect(await readBindingPin(parent.identityId)).toEqual({
      binding_revision: '2',
      external_key: parent.externalKey,
    })
    expect(await readEvidence(evidenceId)).toMatchObject({
      generation: '0',
      revoked: false,
      live_identity_id: parent.identityId,
    })
    expect(await receivingCounts()).toEqual({ pins: 0, bindings: 1, evidence: 1 })
  }, 20_000)

  it('rolls back whichever real 40P01 victim loses the repair user share versus identity update', async () => {
    await createOwnedSchema()
    await installAll()
    const parent = await insertParents('A', 'dingtalk')
    const neighbor = await insertParents('N', 'stub')
    expect(parent.provider).toBe('dingtalk')
    expect(neighbor.provider).toBe('stub')
    expect(neighbor.userId).not.toBe(parent.userId)
    expect(neighbor.identityId).not.toBe(parent.identityId)
    await installOwnedRepair()
    await expectRepairInstalled()
    expect(await repairCount()).toBe(0)
    const integrationBefore = await integrationState(parent.connectionId)
    const identityBefore = await identitySlots(parent.identityId)
    const neighborIntegrationBefore = await integrationState(neighbor.connectionId)
    const neighborIdentityBefore = await identitySlots(neighbor.identityId)
    const parentUserBefore = await userCtid(parent.userId)
    const neighborUserBefore = await userCtid(neighbor.userId)
    type CycleOutcome =
      | { side: 'A' | 'B'; status: 'fulfilled'; rowCount: number | null }
      | { side: 'A' | 'B'; status: 'rejected'; error: PgError }
    const clients: PoolClient[] = []
    const pending: Promise<CycleOutcome>[] = []
    const outcomes: Partial<Record<'A' | 'B', CycleOutcome>> = {}
    let signalVictim: (outcome: CycleOutcome | null) => void = () => undefined
    const victimReady = new Promise<CycleOutcome | null>((resolve) => {
      signalVictim = resolve
    })
    const observe = (side: 'A' | 'B', query: Promise<{ rowCount: number | null }>): Promise<CycleOutcome> => {
      const observed = query.then(
        (result): CycleOutcome => {
          const outcome: CycleOutcome = { side, status: 'fulfilled', rowCount: result.rowCount }
          outcomes[side] = outcome
          if (outcomes.A?.status === 'fulfilled' && outcomes.B?.status === 'fulfilled') signalVictim(null)
          return outcome
        },
        (error: PgError): CycleOutcome => {
          const outcome: CycleOutcome = { side, status: 'rejected', error }
          outcomes[side] = outcome
          signalVictim(outcome)
          return outcome
        },
      )
      pending.push(observed)
      return observed
    }
    try {
      const clientA = await testPool!.connect()
      clients.push(clientA)
      const clientB = await testPool!.connect()
      clients.push(clientB)
      for (const client of clients) {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        await pinCaller(client)
        await client.query(
          `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)`,
          [`${WAIT_MS}ms`],
        )
      }
      const pidA = await backendPid(clientA)
      const pidB = await backendPid(clientB)
      expect(pidA).not.toBe(pidB)
      const detectable = await clientA.query<{ detectable: boolean }>(
        `SELECT current_setting('deadlock_timeout')::interval < $1::int * interval '1 millisecond' AS detectable`,
        [WAIT_MS],
      )
      expect(detectable.rows[0]?.detectable).toBe(true)
      const heldUser = await clientA.query(
        `SELECT id FROM ${qTable('users')} WHERE id = $1 FOR UPDATE`,
        [parent.userId],
      )
      expect(heldUser.rowCount).toBe(1)
      const statementB = observe('B', insertBindingPinOn(clientB, parent, '2').then((rowCount) => ({ rowCount })))
      await untilLockGate(async () => (await blockingPids(pidB)).includes(pidA))
      expect(outcomes.B).toBeUndefined()
      expect(await blockingPids(pidB)).toContain(pidA)
      const waitingBirth = await waitingActivity(pidB)
      expect(waitingBirth.waitEventType).toBe('Lock')
      expect(waitingBirth.query).toContain('INSERT')
      expect(waitingBirth.query).toContain(quoteIdent('user_external_identity_binding_pins'))
      await expectShareNowaitRefused('user_external_identities', parent.identityId)
      expect(outcomes.B).toBeUndefined()
      expect(await blockingPids(pidB)).toContain(pidA)
      const statementA = observe('A', clientA.query(
        `UPDATE ${qTable('user_external_identities')} SET profile = profile WHERE id = $1::uuid`,
        [parent.identityId],
      ).then((result) => ({ rowCount: result.rowCount })))
      const identityUpdate = quoteIdent('user_external_identities')
      const bindingInsert = quoteIdent('user_external_identity_binding_pins')
      let edgeSample: {
        blockA: number[]
        blockB: number[]
        activityA: BackendActivity
        activityB: BackendActivity
      } | undefined
      const pollStarted = Date.now()
      while (Date.now() - pollStarted < WAIT_MS && !outcomes.A && !outcomes.B) {
        const blockA = await blockingPids(pidA)
        const blockB = await blockingPids(pidB)
        if (blockA.includes(pidB) && blockB.includes(pidA)) {
          const activityA = await waitingActivity(pidA, false)
          const activityB = await waitingActivity(pidB, false)
          if (
            activityA
            && activityB
            && activityA.waitEventType === 'Lock'
            && activityA.query.includes('UPDATE')
            && activityA.query.includes('profile')
            && activityA.query.includes(identityUpdate)
            && activityB.waitEventType === 'Lock'
            && activityB.query.includes('INSERT')
            && activityB.query.includes(bindingInsert)
          ) {
            edgeSample = { blockA, blockB, activityA, activityB }
            break
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (!edgeSample) throw new Error('both native repair-cycle waits were not visible')
      expect(edgeSample.blockA).toContain(pidB)
      expect(edgeSample.blockB).toContain(pidA)
      expect(edgeSample.activityA.waitEventType).toBe('Lock')
      expect(edgeSample.activityA.query).toContain('UPDATE')
      expect(edgeSample.activityA.query).toContain('profile')
      expect(edgeSample.activityA.query).toContain(identityUpdate)
      expect(edgeSample.activityB.waitEventType).toBe('Lock')
      expect(edgeSample.activityB.query).toContain('INSERT')
      expect(edgeSample.activityB.query).toContain(bindingInsert)
      const victim = await victimReady
      if (victim === null || victim.status !== 'rejected') {
        throw new Error('expected one real repair-cycle deadlock victim')
      }
      const victimClient = victim.side === 'A' ? clientA : clientB
      const survivorClient = victim.side === 'A' ? clientB : clientA
      await victimClient.query('ROLLBACK')
      expect(victim.error.code).toBe('40P01')
      const survivor = await (victim.side === 'A' ? statementB : statementA)
      expect(survivor).toEqual({
        side: victim.side === 'A' ? 'B' : 'A',
        status: 'fulfilled',
        rowCount: 1,
      })
      await survivorClient.query('COMMIT')
      expect([outcomes.A, outcomes.B].filter((outcome) => outcome?.status === 'rejected')).toHaveLength(1)
      const identityAfter = await identitySlots(parent.identityId)
      expect(identityAfter.ctid).not.toBe(identityBefore.ctid)
      expect({ ...identityAfter, ctid: identityBefore.ctid }).toEqual(identityBefore)
      expect(await integrationState(parent.connectionId)).toEqual(integrationBefore)
      expect(await integrationState(neighbor.connectionId)).toEqual(neighborIntegrationBefore)
      expect(await identitySlots(neighbor.identityId)).toEqual(neighborIdentityBefore)
      expect(await userCtid(parent.userId)).toBe(parentUserBefore)
      expect(await userCtid(neighbor.userId)).toBe(neighborUserBefore)
      expect(await repairCount()).toBe(0)
      if (victim.side === 'B') {
        expect(await receivingCounts()).toEqual({ pins: 0, bindings: 0, evidence: 0 })
      } else {
        expect(await receivingCounts()).toEqual({ pins: 0, bindings: 1, evidence: 0 })
        const pin = await testPool!.query<{
          binding_revision: string
          external_key: string
          provider: string
          local_user_id: string
        }>(
          `SELECT binding_revision::text AS binding_revision, external_key, provider, local_user_id
             FROM ${qTable('user_external_identity_binding_pins')}
            WHERE identity_id = $1::uuid`,
          [parent.identityId],
        )
        expect(pin.rows).toEqual([{
          binding_revision: '2',
          external_key: parent.externalKey,
          provider: 'dingtalk',
          local_user_id: parent.userId,
        }])
      }
    } finally {
      await Promise.all(clients.map(async (client) => {
        try {
          await client.query('ROLLBACK').catch(() => undefined)
        } finally {
          client.release(true)
        }
      }))
      await Promise.all(pending)
    }
  }, 20_000)
})
