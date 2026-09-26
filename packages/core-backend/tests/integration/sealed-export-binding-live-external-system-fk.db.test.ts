// #6076 residual R-073, owner ruling "option 1" — real-PostgreSQL gate for migration
// zzzz20260926140000_sealed_export_binding_live_external_system_fk.
//
// WHAT IS PROVEN (each case on its own throwaway schema built from the REAL migrations
// 057 + 068-075, then — where the case says so — the REAL up()/down() of the migration module):
//
//   A-*  THE PREMISE (no migration): the frozen S6-A writer takes no lock on the system row, so a
//        delete of a system that an ACTIVE 073 binding names lands, in the sequential case and in
//        both interleavings, and leaves the binding dangling.
//   B-1  after up(): the column is STORED generated and the FK exists, RESTRICT, NOT VALID.
//   B-2  a DELETE of a system an ACTIVE binding names is refused 23503 on this constraint.
//   B-3  a RETIRED binding does NOT block the delete (history, as the delete guard reads it).
//   B-4  retire-then-delete goes through.
//   B-5  ACTIVE insert / RETIRED -> ACTIVE flip at a missing system: 23503; RETIRED insert: allowed.
//   B-6  the FROZEN provisioning module, run as the provisioning role (no privilege at all on
//        integration_external_systems), still provisions against a live system, replays
//        idempotently, and does so through the frozen role-bound database handle too.
//   B-7  the same module against a MISSING system: refused with its fixed, values-free
//        SEALED_EXPORT_INTERNAL_ERROR, the underlying driver error is the 23503 on the binding
//        INSERT, and nothing was written (binding / public key / authority all rolled back).
//   B-8  delete-first interleaving: provisioning WAITS on the delete's row lock, then is refused
//        (INTERNAL_ERROR over 23503); zero dangling.
//   B-9  write-first interleaving: the DELETE WAITS on provisioning's RI lock, then is refused
//        23503; the system and the ACTIVE binding both remain.
//   B-10 the plugin delete guard in front of it: a same-tenant ACTIVE binding is still the 409 the
//        count raises; a TENANT-MISMATCHED binding (invisible to the tenant-scoped count) now meets
//        the constraint — a raw 23503 on this constraint, system kept. REGISTERED and asserted: the
//        route's `sendError` turns that driver error into an untyped, values-free 500 (design note
//        docs/development/sealed-export-binding-live-external-system-fk-20260926.md §4).
//   B-11 up() is idempotent.
//   C-1  NOT VALID: a pre-existing dangling ACTIVE row does not block up(); a non-key UPDATE of it
//        still works; VALIDATE fails 23503 until it is retired, then succeeds.
//   D-1  down() with data present (live ACTIVE, RETIRED at a missing system) succeeds, restores
//        the old behaviour (the delete lands, the binding dangles), and up() then succeeds again
//        over that dangling row and is idempotent.
//
// MIGRATION MODULE OVERRIDE (test-only, documented in the design note): the migration is loaded
// from SEALED_EXPORT_LIVE_FK_MIGRATION_MODULE when set, else from this repository. That is how the
// verification record shows the B/C/D cases RED against a no-op module ("old red") and against the
// two single-point mutants, without touching the working tree. The A-* premise cases never load it.
//
// Values-free: assertions are over SQLSTATEs, constraint names, reason tokens, wait states and
// counts. No row value is read into an assertion or a message.

import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const requireCjs = createRequire(import.meta.url)
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const MIGRATION_MODULE = process.env.SEALED_EXPORT_LIVE_FK_MIGRATION_MODULE
  ? path.resolve(process.env.SEALED_EXPORT_LIVE_FK_MIGRATION_MODULE)
  : path.join(
    repoRoot,
    'packages',
    'core-backend',
    'src',
    'db',
    'migrations',
    'zzzz20260926140000_sealed_export_binding_live_external_system_fk.ts',
  )

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Anti-skip-green sentinel — deliberately OUTSIDE `describeIfDatabase` (inside it, it would be
// skipped together with everything else exactly when DATABASE_URL is missing). A lane that
// exports EXPECT_DB=1 must be RED without DATABASE_URL; the default no-DB job skips it visibly.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const BASE_MIGRATIONS = [
  '057_create_integration_core_tables.sql',
  '068_create_integration_sealed_export_ingestion.sql',
  '069_create_integration_sealed_export_generation_kernel.sql',
  '070_create_integration_sealed_export_signer_authority.sql',
  '071_harden_integration_sealed_export_authority_lifecycle.sql',
  '072_harden_integration_sealed_export_terminal_signer_history.sql',
  '073_create_sealed_export_stock_prep_runtime_authority.sql',
  '074_repair_sealed_export_runtime_authority_privileges.sql',
  '075_grant_sealed_export_runtime_authority_row_lock.sql',
]

const LIVE_FK = 'fk_sealed_export_stock_prep_binding_live_external_system'
const BINDINGS = 'integration_sealed_export_stock_prep_bindings'
const SYSTEMS = 'integration_external_systems'
const PUBLIC_KEYS = 'integration_sealed_export_signer_public_keys'
const AUTHORITY = 'integration_sealed_export_authority_state'
const FK_VIOLATION = '23503'
const INTERNAL_ERROR = 'SEALED_EXPORT_INTERNAL_ERROR'
const LIVE_SYSTEM = 'sys-live'
const MISSING_SYSTEM = 'sys-missing'
const TENANT = 't1'
const OTHER_TENANT = 't2'

type QueryRows = Record<string, unknown>[]
type Gate = { reached: Promise<void>; release: () => void }
type DriverFailure = { code?: string; constraint?: string; sql: string }
type Settled<T> = { value: T | null; error: any }
type Migration = {
  up: (db: Kysely<unknown>) => Promise<void>
  down: (db: Kysely<unknown>) => Promise<void>
}

function libPath(...segments: string[]): string {
  return path.join(repoRoot, 'plugins', 'plugin-integration-core', 'lib', ...segments)
}

const { createDb } = requireCjs(libPath('db.cjs'))
const { createExternalSystemRegistry } = requireCjs(libPath('external-systems.cjs'))
const {
  createSealedExportLifecycleProvisioning,
} = requireCjs(libPath('sealed-export', 'sealed-export-lifecycle-provisioning.cjs'))
const {
  createStockPreparationProvisioningDatabase,
} = requireCjs(libPath('sealed-export', 'stock-preparation-runtime-database.cjs'))
const { OBJECT_KEY, RELATION_ID } = requireCjs(libPath('sealed-export', 'stock-preparation-runtime-store.cjs'))
const {
  CANONICAL_OBJECT_VERSION,
} = requireCjs(libPath('sealed-export', 'stock-preparation-sqlserver-source-authority.cjs'))

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then((value) => ({ value, error: null }), (error) => ({ value: null, error }))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: did not settle within ${ms} ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

function digest(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

// One anchor for every timestamp in the provisioning input, so a replay in the same case presents
// byte-identical instants (the frozen module's idempotence match compares them exactly).
const ANCHOR_MS = Date.now()

function futureIso(daysAhead: number): string {
  return new Date(ANCHOR_MS + daysAhead * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function roleConnectionString(source: string, role: string, password: string, schema: string): string {
  const url = new URL(source)
  if (url.hostname) {
    url.username = role
    url.password = password
  } else {
    url.searchParams.set('user', role)
    url.searchParams.set('password', password)
  }
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

const scope = Object.freeze({
  tenantId: TENANT,
  workspaceId: null,
  tenantDomainBinding: digest('live-fk-tenant-domain'),
  systemContentKey: digest('live-fk-system-content'),
  roleBindingFingerprint: digest('live-fk-role-binding'),
})

function provisionInput(publicKey: crypto.KeyObject, externalSystemId: string): unknown {
  return {
    authority: {
      bindingExpiresAt: futureIso(30),
      publicKey,
      qualificationDigest: digest('live-fk-qualification'),
      qualificationExpiresAt: futureIso(20),
      scope: { ...scope },
      signerExpiresAt: futureIso(60),
    },
    binding: {
      approvedConfigVersionId: 'config-version-live-fk',
      bindingId: 'binding-live-fk',
      bindingVersion: 'binding-live-fk-v1',
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      configContentKey: digest('live-fk-config-content'),
      expiresAt: futureIso(25),
      externalSystemId,
      objectKey: OBJECT_KEY,
      relationId: RELATION_ID,
      roleBindingFingerprint: scope.roleBindingFingerprint,
      systemContentKey: scope.systemContentKey,
      tableRef: 'dbo.stock_prep_sealed_rows',
      tenantDomainBinding: scope.tenantDomainBinding,
      tenantId: scope.tenantId,
      workspaceId: null,
    },
  }
}

function credentialStore() {
  return {
    async encrypt(value: string) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
    async decrypt(value: string) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
    async fingerprint(value: string) { return `fp_${Buffer.from(value).toString('hex').slice(0, 8)}` },
  }
}

describeIfDatabase('073 sealed-export binding -> external system live FK (real Postgres)', () => {
  let ownerPool: Pool
  let admin: PoolClient
  let migration: Migration
  let publicKey: crypto.KeyObject
  const suffix = `${process.pid}_${Date.now().toString(36)}`
  const runtimeRole = `s073fk_rt_${suffix}`
  const runtimePassword = `S073FkRt_${suffix}`
  const provisioningRole = `s073fk_pv_${suffix}`
  const provisioningPassword = `S073FkPv_${suffix}`
  const schemas: string[] = []
  const pools: Pool[] = []
  const clients: PoolClient[] = []
  let appSeq = 0

  function nextApplicationName(kind: string): string {
    appSeq += 1
    return `s073fk_${kind}_${suffix}_${appSeq}`
  }

  async function buildSchema(tag: string): Promise<string> {
    const schema = `s073fk_${tag}_${suffix}`
    schemas.push(schema)
    await admin.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`)
    await admin.query(`SET search_path TO ${quotedIdentifier(schema)}`)
    await admin.query("SELECT set_config('metasheet.sealed_export_runtime_role', $1, false)", [runtimeRole])
    await admin.query("SELECT set_config('metasheet.sealed_export_provisioning_role', $1, false)", [provisioningRole])
    for (const name of BASE_MIGRATIONS) {
      await admin.query(readFileSync(path.join(repoRoot, 'packages', 'core-backend', 'migrations', name), 'utf8'))
    }
    await admin.query('SET search_path TO public')
    return schema
  }

  function kyselyFor(schema: string): Kysely<unknown> {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      options: `-c search_path=${quotedIdentifier(schema)}`,
    })
    return new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  }

  async function migrate(schema: string, direction: 'up' | 'down'): Promise<void> {
    const db = kyselyFor(schema)
    try {
      await migration[direction](db)
    } finally {
      await db.destroy()
    }
  }

  // An owner session pinned to one schema. `application_name` is unique so a lock wait can be
  // attributed to exactly this session by the observer.
  async function ownerSession(schema: string): Promise<{ client: PoolClient; app: string }> {
    const client = await ownerPool.connect()
    clients.push(client)
    const app = nextApplicationName('owner')
    await client.query(`SET search_path TO ${quotedIdentifier(schema)}`)
    await client.query(`SET application_name TO ${quotedIdentifier(app)}`)
    return { client, app }
  }

  async function q(schema: string, sql: string, params: unknown[] = []): Promise<QueryRows> {
    await admin.query(`SET search_path TO ${quotedIdentifier(schema)}`)
    try {
      return (await admin.query(sql, params)).rows
    } finally {
      await admin.query('SET search_path TO public')
    }
  }

  async function count(schema: string, table: string, where = 'TRUE', params: unknown[] = []): Promise<number> {
    const rows = await q(schema, `SELECT count(*)::int AS n FROM ${quotedIdentifier(table)} WHERE ${where}`, params)
    return Number(rows[0].n)
  }

  async function insertSystem(schema: string, id: string, tenantId = TENANT): Promise<void> {
    await q(
      schema,
      `INSERT INTO ${SYSTEMS} (id, tenant_id, workspace_id, name, kind, role, config, status)
       VALUES ($1, $2, NULL, $1, 'erp:k3-wise-sqlserver', 'source', '{}'::jsonb, 'active')`,
      [id, tenantId],
    )
  }

  function bindingSql(): string {
    return `INSERT INTO ${BINDINGS} (
        binding_id, tenant_id, workspace_id, external_system_id, object_key, relation_id, table_ref,
        approved_config_version_id, binding_version, config_content_key, canonical_object_version,
        tenant_domain_binding, system_content_key, role_binding_fingerprint, status, expires_at
      ) VALUES ($1, $2, NULL, $3, $4, $5, 'dbo.t', 'acv', $1, 'cck', $6, 'tdb', 'sck', 'rbf', $7, NOW() + interval '1 day')`
  }

  async function insertBinding(
    schema: string,
    { bindingId, systemId, status, tenantId = TENANT }: { bindingId: string; systemId: string; status: 'ACTIVE' | 'RETIRED'; tenantId?: string },
  ): Promise<void> {
    await q(schema, bindingSql(), [bindingId, tenantId, systemId, OBJECT_KEY, RELATION_ID, CANONICAL_OBJECT_VERSION, status])
  }

  async function tryQuery(schema: string, sql: string, params: unknown[] = []): Promise<Settled<QueryRows>> {
    return settle(q(schema, sql, params))
  }

  async function dangling(schema: string): Promise<number> {
    return count(
      schema,
      BINDINGS,
      `status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM ${SYSTEMS} s WHERE s.id = ${BINDINGS}.external_system_id)`,
    )
  }

  // Lock-wait observation is the evidence that a lock is being TAKEN, not merely that an outcome
  // happened to be right.
  async function waitsOnLock(applicationName: string, windowMs = 5000): Promise<boolean> {
    const deadline = Date.now() + windowMs
    while (Date.now() < deadline) {
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'",
        [applicationName],
      )
      if (Number(rows[0].n) > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  }

  // The frozen provisioning module's database seam, as the PROVISIONING ROLE, with (a) a recorder
  // for the raw driver error the sealed-export vocabulary deliberately masks and (b) a gate: the
  // next statement whose text starts with a registered prefix parks until released.
  function provisioningSession(schema: string) {
    const app = nextApplicationName('prov')
    const pool = new Pool({
      connectionString: roleConnectionString(process.env.DATABASE_URL!, provisioningRole, provisioningPassword, quotedIdentifier(schema)),
      application_name: app,
      max: 1,
    })
    pools.push(pool)
    const failures: DriverFailure[] = []
    const gates = new Map<string, { arrived: () => void; open: Promise<void> }>()
    async function run(executor: { query: (sql: string, params?: unknown[]) => Promise<{ rows: QueryRows }> }, sql: string, params?: unknown[]) {
      for (const [prefix, gate] of gates) {
        if (sql.startsWith(prefix)) {
          gates.delete(prefix)
          gate.arrived()
          await gate.open
          break
        }
      }
      try {
        return (await executor.query(sql, params)).rows
      } catch (error) {
        const e = error as { code?: string; constraint?: string }
        failures.push({ code: e.code, constraint: e.constraint, sql: sql.replace(/\s+/g, ' ').trim() })
        throw error
      }
    }
    const database = {
      query: (sql: string, params?: unknown[]) => run(pool, sql, params),
      async transaction(callback: (trx: unknown) => Promise<unknown>) {
        const client = await pool.connect()
        let finished = false
        try {
          await client.query('BEGIN')
          const trx = {
            query: (sql: string, params?: unknown[]) => run(client, sql, params),
            async commit() {
              if (finished) return
              await client.query('COMMIT')
              finished = true
            },
            async rollback() {
              if (finished) return
              await client.query('ROLLBACK')
              finished = true
            },
          }
          const result = await callback(trx)
          if (!finished) {
            await client.query('COMMIT')
            finished = true
          }
          return result
        } catch (error) {
          if (!finished) await client.query('ROLLBACK').catch(() => {})
          throw error
        } finally {
          client.release()
        }
      },
    }
    const lifecycle = createSealedExportLifecycleProvisioning({ db: createDb({ database }) })
    return {
      app,
      failures,
      provision: (systemId: string) => lifecycle.provisionInitialStockPreparationBinding(provisionInput(publicKey, systemId)),
      gateBefore(prefix: string): Gate {
        let arrived!: () => void
        let release!: () => void
        const reached = new Promise<void>((resolve) => { arrived = resolve })
        const open = new Promise<void>((resolve) => { release = resolve })
        gates.set(prefix, { arrived, open })
        return { reached, release }
      },
    }
  }

  // The plugin's own delete guard, over an owner session (the API role is the table owner).
  async function registryOn(schema: string) {
    const { client } = await ownerSession(schema)
    const database = {
      query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
      async transaction(callback: (trx: unknown) => Promise<unknown>) {
        await client.query('BEGIN')
        try {
          const result = await callback({
            query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows,
            commit: async () => {},
            rollback: async () => {},
          })
          await client.query('COMMIT')
          return result
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        }
      },
    }
    return createExternalSystemRegistry({ db: createDb({ database }), credentialStore: credentialStore() })
  }

  beforeAll(async () => {
    const moduleUrl = pathToFileURL(MIGRATION_MODULE).href
    migration = (await import(/* @vite-ignore */ moduleUrl)) as Migration
    ownerPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 })
    admin = await ownerPool.connect()
    publicKey = crypto.generateKeyPairSync('ed25519').publicKey
    await admin.query(`CREATE ROLE ${quotedIdentifier(runtimeRole)} LOGIN NOINHERIT PASSWORD '${runtimePassword}'`)
    await admin.query(`CREATE ROLE ${quotedIdentifier(provisioningRole)} LOGIN NOINHERIT PASSWORD '${provisioningPassword}'`)
  }, 60000)

  afterAll(async () => {
    for (const client of clients) {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
    for (const pool of pools) await pool.end().catch(() => {})
    if (admin) {
      await admin.query('SET search_path TO public').catch(() => {})
      for (const schema of schemas) {
        await admin.query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`).catch(() => {})
      }
      for (const role of [runtimeRole, provisioningRole]) {
        await admin.query(`DROP OWNED BY ${quotedIdentifier(role)} CASCADE`).catch(() => {})
        await admin.query(`DROP ROLE IF EXISTS ${quotedIdentifier(role)}`).catch(() => {})
      }
      admin.release()
    }
    if (ownerPool) await ownerPool.end()
  }, 60000)

  // ---------------------------------------------------------------------------------------------
  // A — the premise, on schemas WITHOUT the migration. These never load the module under test.
  // ---------------------------------------------------------------------------------------------

  it('A-1 (premise) without the migration a delete of a system an ACTIVE binding names lands and the binding dangles', async () => {
    const schema = await buildSchema('a1')
    await insertSystem(schema, LIVE_SYSTEM)
    await insertBinding(schema, { bindingId: 'b-a1', systemId: LIVE_SYSTEM, status: 'ACTIVE' })
    const deleted = await tryQuery(schema, `DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM])
    expect(deleted.error).toBeNull()
    expect(await dangling(schema)).toBe(1)
  }, 60000)

  it('A-2 (premise) delete-first: the frozen writer does not wait and the binding dangles', async () => {
    const schema = await buildSchema('a2')
    await insertSystem(schema, LIVE_SYSTEM)
    const { client: deleter } = await ownerSession(schema)
    const writer = provisioningSession(schema)
    await deleter.query('BEGIN')
    await deleter.query(`DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM])
    const written = await withTimeout(settle(writer.provision(LIVE_SYSTEM)), 10000, 'A-2 provisioning')
    await deleter.query('COMMIT')
    expect(written.error).toBeNull()
    expect(written.value).toMatchObject({ changed: true, operation: 'INITIAL_PROVISIONED' })
    expect(await dangling(schema)).toBe(1)
  }, 60000)

  it('A-3 (premise) write-first: the DELETE does not wait on the in-flight binding and the binding dangles', async () => {
    const schema = await buildSchema('a3')
    await insertSystem(schema, LIVE_SYSTEM)
    const writer = provisioningSession(schema)
    const gate = writer.gateBefore(`INSERT INTO "${PUBLIC_KEYS}"`)
    const written = settle(writer.provision(LIVE_SYSTEM))
    await gate.reached // the binding row is inserted, uncommitted
    const { client: deleter, app } = await ownerSession(schema)
    const deleted = settle(deleter.query(`DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM]))
    expect(await waitsOnLock(app, 1000)).toBe(false)
    expect((await deleted).error).toBeNull()
    gate.release()
    expect((await written).error).toBeNull()
    expect(await dangling(schema)).toBe(1)
  }, 60000)

  // ---------------------------------------------------------------------------------------------
  // B — after up() of the module under test.
  // ---------------------------------------------------------------------------------------------

  async function migratedSchema(tag: string): Promise<string> {
    const schema = await buildSchema(tag)
    await migrate(schema, 'up')
    return schema
  }

  async function fkState(schema: string): Promise<{ present: boolean; validated: boolean | null; restrict: boolean | null; generated: boolean }> {
    const rows = await q(
      schema,
      `SELECT
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)) AS present,
         (SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)) AS validated,
         (SELECT confdeltype = 'r' FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)) AS restrict,
         EXISTS (
           SELECT 1 FROM pg_attribute
            WHERE attrelid = to_regclass($2) AND attname = 'live_external_system_id'
              AND attgenerated = 's' AND NOT attisdropped
         ) AS generated`,
      [LIVE_FK, BINDINGS],
    )
    return rows[0] as { present: boolean; validated: boolean | null; restrict: boolean | null; generated: boolean }
  }

  it('B-1 after up(): the column is STORED generated and the FK exists — RESTRICT, NOT VALID, on integration_external_systems(id)', async () => {
    const schema = await migratedSchema('b1')
    expect(await fkState(schema)).toEqual({ present: true, validated: false, restrict: true, generated: true })
    const rows = await q(
      schema,
      `SELECT c.confrelid = to_regclass($2) AS on_systems,
              (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                WHERE a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)) AS referenced,
              (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) AS referencing
         FROM pg_constraint c WHERE c.conname = $1 AND c.conrelid = to_regclass($3)`,
      [LIVE_FK, SYSTEMS, BINDINGS],
    )
    expect(rows).toEqual([{ on_systems: true, referenced: ['id'], referencing: ['live_external_system_id'] }])
  }, 60000)

  it('B-2 a DELETE of a system an ACTIVE binding names is refused 23503 on this constraint; system and binding stay', async () => {
    const schema = await migratedSchema('b2')
    await insertSystem(schema, LIVE_SYSTEM)
    await insertBinding(schema, { bindingId: 'b-b2', systemId: LIVE_SYSTEM, status: 'ACTIVE' })
    const deleted = await tryQuery(schema, `DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM])
    expect(deleted.error?.code).toBe(FK_VIOLATION)
    expect(deleted.error?.constraint).toBe(LIVE_FK)
    expect(await count(schema, SYSTEMS)).toBe(1)
    expect(await count(schema, BINDINGS, "status = 'ACTIVE'")).toBe(1)
    expect(await dangling(schema)).toBe(0)
  }, 60000)

  it('B-3 a RETIRED binding does not block the delete', async () => {
    const schema = await migratedSchema('b3')
    await insertSystem(schema, LIVE_SYSTEM)
    await insertBinding(schema, { bindingId: 'b-b3', systemId: LIVE_SYSTEM, status: 'RETIRED' })
    const deleted = await tryQuery(schema, `DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM])
    expect(deleted.error).toBeNull()
    expect(await count(schema, SYSTEMS)).toBe(0)
  }, 60000)

  it('B-4 retire-then-delete goes through', async () => {
    const schema = await migratedSchema('b4')
    await insertSystem(schema, LIVE_SYSTEM)
    await insertBinding(schema, { bindingId: 'b-b4', systemId: LIVE_SYSTEM, status: 'ACTIVE' })
    const retired = await tryQuery(schema, `UPDATE ${BINDINGS} SET status = 'RETIRED' WHERE binding_id = 'b-b4'`)
    expect(retired.error).toBeNull()
    const deleted = await tryQuery(schema, `DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM])
    expect(deleted.error).toBeNull()
    expect(await count(schema, SYSTEMS)).toBe(0)
  }, 60000)

  it('B-5 at a missing system: ACTIVE insert and RETIRED -> ACTIVE flip are refused 23503; a RETIRED insert is history and allowed', async () => {
    const schema = await migratedSchema('b5')
    const activeInsert = await tryQuery(schema, bindingSql(), ['b-b5-a', TENANT, MISSING_SYSTEM, OBJECT_KEY, RELATION_ID, CANONICAL_OBJECT_VERSION, 'ACTIVE'])
    expect(activeInsert.error?.code).toBe(FK_VIOLATION)
    expect(activeInsert.error?.constraint).toBe(LIVE_FK)
    const retiredInsert = await tryQuery(schema, bindingSql(), ['b-b5-r', TENANT, MISSING_SYSTEM, OBJECT_KEY, RELATION_ID, CANONICAL_OBJECT_VERSION, 'RETIRED'])
    expect(retiredInsert.error).toBeNull()
    const flip = await tryQuery(schema, `UPDATE ${BINDINGS} SET status = 'ACTIVE' WHERE binding_id = 'b-b5-r'`)
    expect(flip.error?.code).toBe(FK_VIOLATION)
    expect(flip.error?.constraint).toBe(LIVE_FK)
    expect(await count(schema, BINDINGS, "status = 'ACTIVE'")).toBe(0)
  }, 60000)

  it('B-6 the frozen module, as the provisioning role with no privilege on integration_external_systems, still provisions a live system and replays idempotently', async () => {
    const schema = await migratedSchema('b6')
    await insertSystem(schema, LIVE_SYSTEM)
    const privileges = await q(
      schema,
      `SELECT has_table_privilege($1, to_regclass($2), 'SELECT') AS can_select,
              has_table_privilege($1, to_regclass($2), 'UPDATE') AS can_update,
              has_table_privilege($1, to_regclass($2), 'REFERENCES') AS can_reference`,
      [provisioningRole, SYSTEMS],
    )
    expect(privileges).toEqual([{ can_select: false, can_update: false, can_reference: false }])

    const writer = provisioningSession(schema)
    const first = await settle(writer.provision(LIVE_SYSTEM))
    expect(first.error).toBeNull()
    expect(first.value).toMatchObject({ changed: true, externalWrite: false, operation: 'INITIAL_PROVISIONED', valuesFree: true })
    const replay = await settle(writer.provision(LIVE_SYSTEM))
    expect(replay.error).toBeNull()
    expect(replay.value).toMatchObject({ changed: false, operation: 'INITIAL_PROVISIONED' })
    expect(writer.failures).toEqual([])

    // Through the frozen role-bound handle itself (its own pool, its own transaction boundary).
    const handle = createStockPreparationProvisioningDatabase({
      connectionString: roleConnectionString(process.env.DATABASE_URL!, provisioningRole, provisioningPassword, quotedIdentifier(schema)),
      expectedRole: provisioningRole,
    })
    try {
      await expect(handle.assertReady()).resolves.toMatchObject({ roleVerified: true })
      const lifecycle = createSealedExportLifecycleProvisioning({ db: handle.db })
      await expect(
        lifecycle.provisionInitialStockPreparationBinding(provisionInput(publicKey, LIVE_SYSTEM)),
      ).resolves.toMatchObject({ changed: false, operation: 'INITIAL_PROVISIONED' })
    } finally {
      await handle.close()
    }
    expect(await count(schema, BINDINGS, "status = 'ACTIVE' AND live_external_system_id IS NOT NULL")).toBe(1)
  }, 60000)

  it('B-7 the frozen module against a MISSING system is refused with its fixed values-free reason and writes nothing', async () => {
    const schema = await migratedSchema('b7')
    const writer = provisioningSession(schema)
    const outcome = await settle(writer.provision(MISSING_SYSTEM))
    expect(outcome.error?.reason).toBe(INTERNAL_ERROR)
    // The raw driver error the vocabulary masks: exactly one, the binding INSERT's 23503.
    expect(writer.failures).toHaveLength(1)
    expect(writer.failures[0].code).toBe(FK_VIOLATION)
    expect(writer.failures[0].constraint).toBe(LIVE_FK)
    expect(writer.failures[0].sql.startsWith(`INSERT INTO "${BINDINGS}"`)).toBe(true)
    // Values-free: nothing of the request (system id, tenant) travels on the rejection.
    const surfaced = JSON.stringify({ ...outcome.error, message: outcome.error?.message })
    expect(surfaced).not.toContain(MISSING_SYSTEM)
    expect(surfaced).not.toContain(TENANT)
    for (const table of [BINDINGS, PUBLIC_KEYS, AUTHORITY]) {
      expect(await count(schema, table)).toBe(0)
    }

    // Same through the frozen role-bound handle: its transaction wrapper is the real boundary.
    const handle = createStockPreparationProvisioningDatabase({
      connectionString: roleConnectionString(process.env.DATABASE_URL!, provisioningRole, provisioningPassword, quotedIdentifier(schema)),
      expectedRole: provisioningRole,
    })
    try {
      await handle.assertReady()
      const lifecycle = createSealedExportLifecycleProvisioning({ db: handle.db })
      const viaHandle = await settle(lifecycle.provisionInitialStockPreparationBinding(provisionInput(publicKey, MISSING_SYSTEM)))
      expect(viaHandle.error?.reason).toBe(INTERNAL_ERROR)
    } finally {
      await handle.close()
    }
    for (const table of [BINDINGS, PUBLIC_KEYS, AUTHORITY]) {
      expect(await count(schema, table)).toBe(0)
    }
  }, 60000)

  it('B-8 delete-first: provisioning waits on the delete, then is refused; zero dangling', async () => {
    const schema = await migratedSchema('b8')
    await insertSystem(schema, LIVE_SYSTEM)
    const { client: deleter } = await ownerSession(schema)
    const writer = provisioningSession(schema)
    await deleter.query('BEGIN')
    await deleter.query(`DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM])
    const written = settle(writer.provision(LIVE_SYSTEM))
    expect(await waitsOnLock(writer.app)).toBe(true)
    await deleter.query('COMMIT')
    const outcome = await withTimeout(written, 10000, 'B-8 provisioning')
    expect(outcome.error?.reason).toBe(INTERNAL_ERROR)
    expect(writer.failures.map((failure) => [failure.code, failure.constraint])).toEqual([[FK_VIOLATION, LIVE_FK]])
    expect(await count(schema, SYSTEMS)).toBe(0)
    expect(await count(schema, BINDINGS)).toBe(0)
    expect(await dangling(schema)).toBe(0)
  }, 60000)

  it('B-9 write-first: the DELETE waits on provisioning, then is refused 23503; system and ACTIVE binding both remain', async () => {
    const schema = await migratedSchema('b9')
    await insertSystem(schema, LIVE_SYSTEM)
    const writer = provisioningSession(schema)
    const gate = writer.gateBefore(`INSERT INTO "${PUBLIC_KEYS}"`)
    const written = settle(writer.provision(LIVE_SYSTEM))
    await gate.reached // the binding INSERT ran: its RI check holds KEY SHARE on the system row
    const { client: deleter, app } = await ownerSession(schema)
    const deleted = settle(deleter.query(`DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM]))
    expect(await waitsOnLock(app)).toBe(true)
    gate.release()
    const writeOutcome = await withTimeout(written, 10000, 'B-9 provisioning')
    expect(writeOutcome.error).toBeNull()
    expect(writeOutcome.value).toMatchObject({ changed: true })
    const deleteOutcome = await withTimeout(deleted, 10000, 'B-9 delete')
    expect(deleteOutcome.error?.code).toBe(FK_VIOLATION)
    expect(deleteOutcome.error?.constraint).toBe(LIVE_FK)
    expect(await count(schema, SYSTEMS)).toBe(1)
    expect(await count(schema, BINDINGS, "status = 'ACTIVE'")).toBe(1)
    expect(await dangling(schema)).toBe(0)
  }, 60000)

  it('B-10 the plugin delete guard: same-tenant ACTIVE binding is still its 409; a tenant-mismatched one now meets the constraint (raw 23503, system kept — registered)', async () => {
    const schema = await migratedSchema('b10')
    await insertSystem(schema, LIVE_SYSTEM)
    await insertBinding(schema, { bindingId: 'b-b10', systemId: LIVE_SYSTEM, status: 'ACTIVE' })
    const registry = await registryOn(schema)
    const refused = await settle(registry.deleteExternalSystem({ tenantId: TENANT, workspaceId: null, id: LIVE_SYSTEM }))
    expect(refused.error?.name).toBe('ExternalSystemConflictError')
    expect(refused.error?.details?.sealedExportBindingCount).toBe(1)
    expect(await count(schema, SYSTEMS)).toBe(1)

    await q(schema, `DELETE FROM ${BINDINGS}`)
    await insertBinding(schema, { bindingId: 'b-b10-x', systemId: LIVE_SYSTEM, status: 'ACTIVE', tenantId: OTHER_TENANT })
    const crossTenant = await settle(registry.deleteExternalSystem({ tenantId: TENANT, workspaceId: null, id: LIVE_SYSTEM }))
    expect(crossTenant.error?.code).toBe(FK_VIOLATION)
    expect(crossTenant.error?.constraint).toBe(LIVE_FK)
    expect(await count(schema, SYSTEMS)).toBe(1)
    expect(await dangling(schema)).toBe(0)

    // REGISTERED, not fixed here: what the HTTP route makes of that raw driver error. The route
    // wrapper hands every thrown error to `sendError` (http-routes.cjs registerIntegrationRoutes),
    // whose status inference has no branch for a driver error — so the admin sees an untyped 500.
    // It is values-free (pg's `message` names the table and the constraint, never the key; the key is
    // in `detail`, which `sendError` does not forward). Whoever maps this 23503 to the guard's 409
    // (external-systems.cjs, after #6076) must flip these three assertions.
    const { __internals: routeInternals } = requireCjs(libPath('http-routes.cjs'))
    const wire: { status?: number; body?: any } = {}
    routeInternals.sendError(
      { status(code: number) { wire.status = code; return { json(body: unknown) { wire.body = body } } } },
      crossTenant.error,
    )
    expect(wire.status).toBe(500)
    expect(wire.body?.error?.code).toBe(FK_VIOLATION)
    const serialized = JSON.stringify(wire.body)
    for (const value of [LIVE_SYSTEM, 'b-b10-x', OTHER_TENANT]) {
      expect(serialized).not.toContain(value)
    }
  }, 60000)

  it('B-11 up() is idempotent', async () => {
    const schema = await migratedSchema('b11')
    await migrate(schema, 'up')
    expect(await fkState(schema)).toEqual({ present: true, validated: false, restrict: true, generated: true })
    const rows = await q(schema, 'SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = $2', [BINDINGS, 'f'])
    expect(Number(rows[0].n)).toBe(1)
  }, 60000)

  // ---------------------------------------------------------------------------------------------
  // C — NOT VALID over a pre-existing dangling row.
  // ---------------------------------------------------------------------------------------------

  it('C-1 a pre-existing dangling ACTIVE row does not block up(); VALIDATE fails 23503 until it is retired, then succeeds', async () => {
    const schema = await buildSchema('c1')
    await insertBinding(schema, { bindingId: 'b-c1-active', systemId: MISSING_SYSTEM, status: 'ACTIVE' })
    await insertBinding(schema, { bindingId: 'b-c1-retired', systemId: 'sys-gone', status: 'RETIRED' })
    await migrate(schema, 'up')
    expect(await fkState(schema)).toEqual({ present: true, validated: false, restrict: true, generated: true })
    expect(await dangling(schema)).toBe(1)

    // A non-key UPDATE of the dangling row is not re-checked (the referencing key is unchanged).
    const touch = await tryQuery(schema, `UPDATE ${BINDINGS} SET expires_at = expires_at + interval '1 hour' WHERE binding_id = 'b-c1-active'`)
    expect(touch.error).toBeNull()

    const early = await tryQuery(schema, `ALTER TABLE ${BINDINGS} VALIDATE CONSTRAINT ${LIVE_FK}`)
    expect(early.error?.code).toBe(FK_VIOLATION)

    const retire = await tryQuery(schema, `UPDATE ${BINDINGS} SET status = 'RETIRED' WHERE binding_id = 'b-c1-active'`)
    expect(retire.error).toBeNull()
    const validate = await tryQuery(schema, `ALTER TABLE ${BINDINGS} VALIDATE CONSTRAINT ${LIVE_FK}`)
    expect(validate.error).toBeNull()
    expect((await fkState(schema)).validated).toBe(true)

    const after = await tryQuery(schema, bindingSql(), ['b-c1-new', TENANT, MISSING_SYSTEM, OBJECT_KEY, RELATION_ID, CANONICAL_OBJECT_VERSION, 'ACTIVE'])
    expect(after.error?.code).toBe(FK_VIOLATION)
  }, 60000)

  // ---------------------------------------------------------------------------------------------
  // D — down() with data present, then up() again.
  // ---------------------------------------------------------------------------------------------

  it('D-1 down() with data present restores the old behaviour; up() then succeeds again over the dangling row and is idempotent', async () => {
    const schema = await migratedSchema('d1')
    await insertSystem(schema, LIVE_SYSTEM)
    await insertBinding(schema, { bindingId: 'b-d1-active', systemId: LIVE_SYSTEM, status: 'ACTIVE' })
    await insertBinding(schema, { bindingId: 'b-d1-retired', systemId: MISSING_SYSTEM, status: 'RETIRED' })
    expect((await fkState(schema)).present).toBe(true)

    await migrate(schema, 'down')
    expect(await fkState(schema)).toEqual({ present: false, validated: null, restrict: null, generated: false })
    expect(await count(schema, BINDINGS)).toBe(2)
    const deleted = await tryQuery(schema, `DELETE FROM ${SYSTEMS} WHERE id = $1`, [LIVE_SYSTEM])
    expect(deleted.error).toBeNull()
    expect(await dangling(schema)).toBe(1)

    await migrate(schema, 'up')
    expect(await fkState(schema)).toEqual({ present: true, validated: false, restrict: true, generated: true })
    await migrate(schema, 'up')
    expect(await fkState(schema)).toEqual({ present: true, validated: false, restrict: true, generated: true })
    expect(await dangling(schema)).toBe(1)
  }, 60000)
})
