import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// S6-A privilege repair (migration 074) behavioural gate.
//
// 073 granted the provisioning role SELECT, INSERT on
// integration_sealed_export_signer_public_keys while
// provisionInitialStockPreparationBinding locks that row with
// SELECT ... FOR UPDATE, and granted the runtime role INSERT only on
// integration_sealed_export_generation_audit while every db.cjs write helper
// appends RETURNING *. Both arms below run the frozen product code against a
// real PostgreSQL: one schema WITHOUT 074 (must be refused with 42501) and one
// WITH it (must complete). Values-free: counts, SQLSTATEs and closed reason
// tokens only.

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const require = createRequire(import.meta.url)

function libPath(...segments: string[]): string {
  return path.join(
    repoRoot,
    'plugins',
    'plugin-integration-core',
    'lib',
    ...segments,
  )
}

const { createDb } = require(libPath('db.cjs'))
const {
  createSealedExportLifecycleProvisioning,
} = require(libPath('sealed-export', 'sealed-export-lifecycle-provisioning.cjs'))
const {
  createStockPreparationProvisioningDatabase,
} = require(libPath('sealed-export', 'stock-preparation-runtime-database.cjs'))
const {
  OBJECT_KEY,
  RELATION_ID,
} = require(libPath('sealed-export', 'stock-preparation-runtime-store.cjs'))
const {
  CANONICAL_OBJECT_VERSION,
} = require(libPath('sealed-export', 'stock-preparation-sqlserver-source-authority.cjs'))

const baseMigrations = [
  '057_create_integration_core_tables.sql',
  '068_create_integration_sealed_export_ingestion.sql',
  '069_create_integration_sealed_export_generation_kernel.sql',
  '070_create_integration_sealed_export_signer_authority.sql',
  '071_harden_integration_sealed_export_authority_lifecycle.sql',
  '072_harden_integration_sealed_export_terminal_signer_history.sql',
  '073_create_sealed_export_stock_prep_runtime_authority.sql',
]
const repairMigration =
  '074_repair_sealed_export_runtime_authority_privileges.sql'

const PUBLIC_KEY_TABLE = 'integration_sealed_export_signer_public_keys'
const AUDIT_TABLE = 'integration_sealed_export_generation_audit'
const INSUFFICIENT_PRIVILEGE = '42501'

interface DriverFailure {
  code?: string
  sql: string
}

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function roleConnectionString(
  source: string,
  role: string,
  password: string,
): string {
  const url = new URL(source)
  if (url.hostname) {
    url.username = role
    url.password = password
  } else {
    url.searchParams.set('user', role)
    url.searchParams.set('password', password)
  }
  return url.toString()
}

function digest(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

function futureIso(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86400000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
}

const scope = Object.freeze({
  tenantId: 'tenant-grant-repair',
  workspaceId: null,
  tenantDomainBinding: digest('grant-repair-tenant-domain'),
  systemContentKey: digest('grant-repair-system-content'),
  roleBindingFingerprint: digest('grant-repair-role-binding'),
})

function provisionInput(publicKey: crypto.KeyObject): unknown {
  return {
    authority: {
      bindingExpiresAt: futureIso(30),
      publicKey,
      qualificationDigest: digest('grant-repair-qualification'),
      qualificationExpiresAt: futureIso(20),
      scope: { ...scope },
      signerExpiresAt: futureIso(60),
    },
    binding: {
      approvedConfigVersionId: 'config-version-grant-repair',
      bindingId: 'binding-grant-repair',
      bindingVersion: 'binding-grant-repair-v1',
      canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      configContentKey: digest('grant-repair-config-content'),
      expiresAt: futureIso(25),
      externalSystemId: 'external-system-grant-repair',
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

// Same statement shapes as stock-preparation-runtime-database.cjs, plus a
// recorder for the raw driver error that the sealed-export failure vocabulary
// deliberately masks (dbBoundary maps everything untrusted to
// SEALED_EXPORT_INTERNAL_ERROR).
function instrumentedDatabase(pool: Pool, failures: DriverFailure[]) {
  async function run(
    executor: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    sql: string,
    params?: unknown[],
  ): Promise<unknown[]> {
    try {
      const result = await executor.query(sql, params)
      return result.rows
    } catch (error) {
      failures.push({
        code: (error as { code?: string }).code,
        sql: sql.replace(/\s+/g, ' ').trim(),
      })
      throw error
    }
  }
  return {
    async query(sql: string, params?: unknown[]) {
      return run(pool, sql, params)
    },
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
}

interface Arm {
  schema: string
  runtimeRole: string
  runtimePassword: string
  provisioningRole: string
  provisioningPassword: string
}

describeIfDatabase('sealed-export S6-A grant repair (real Postgres)', () => {
  let pool: Pool
  let client: PoolClient
  let absent: Arm
  let present: Arm
  let publicKey: crypto.KeyObject

  function makeArm(name: string, suffix: string): Arm {
    return {
      schema: `s6a_repair_${name}_${suffix}`,
      runtimeRole: `s6a_rep_rt_${name}_${suffix}`,
      runtimePassword: `S6aRepairRt_${name}_${suffix}`,
      provisioningRole: `s6a_rep_pv_${name}_${suffix}`,
      provisioningPassword: `S6aRepairPv_${name}_${suffix}`,
    }
  }

  async function buildArm(arm: Arm, withRepair: boolean): Promise<void> {
    await client.query(
      `CREATE ROLE ${quotedIdentifier(arm.runtimeRole)}
       LOGIN NOINHERIT PASSWORD '${arm.runtimePassword}'`,
    )
    await client.query(
      `CREATE ROLE ${quotedIdentifier(arm.provisioningRole)}
       LOGIN NOINHERIT PASSWORD '${arm.provisioningPassword}'`,
    )
    await client.query(`CREATE SCHEMA ${quotedIdentifier(arm.schema)}`)
    const database = (
      await client.query<{ name: string }>('SELECT current_database() AS name')
    ).rows[0].name
    for (const role of [arm.runtimeRole, arm.provisioningRole]) {
      await client.query(
        `ALTER ROLE ${quotedIdentifier(role)}
         IN DATABASE ${quotedIdentifier(database)}
         SET search_path TO ${quotedIdentifier(arm.schema)}`,
      )
    }
    await client.query(`SET search_path TO ${quotedIdentifier(arm.schema)}`)
    await client.query(
      "SELECT set_config('metasheet.sealed_export_runtime_role', $1, false)",
      [arm.runtimeRole],
    )
    await client.query(
      "SELECT set_config('metasheet.sealed_export_provisioning_role', $1, false)",
      [arm.provisioningRole],
    )
    const names = withRepair
      ? [...baseMigrations, repairMigration]
      : [...baseMigrations]
    for (const name of names) {
      const sql = await fs.readFile(
        path.join(repoRoot, 'packages', 'core-backend', 'migrations', name),
        'utf8',
      )
      await client.query(sql)
    }
    await client.query('SET search_path TO public')
  }

  async function dropArm(arm: Arm): Promise<void> {
    await client.query(
      `DROP SCHEMA IF EXISTS ${quotedIdentifier(arm.schema)} CASCADE`,
    ).catch(() => {})
    for (const role of [arm.runtimeRole, arm.provisioningRole]) {
      await client.query(
        `DROP OWNED BY ${quotedIdentifier(role)} CASCADE`,
      ).catch(() => {})
      await client.query(
        `DROP ROLE IF EXISTS ${quotedIdentifier(role)}`,
      ).catch(() => {})
    }
  }

  function provisioningPool(arm: Arm): Pool {
    return new Pool({
      connectionString: roleConnectionString(
        process.env.DATABASE_URL!,
        arm.provisioningRole,
        arm.provisioningPassword,
      ),
      max: 2,
    })
  }

  function runtimePool(arm: Arm): Pool {
    return new Pool({
      connectionString: roleConnectionString(
        process.env.DATABASE_URL!,
        arm.runtimeRole,
        arm.runtimePassword,
      ),
      max: 2,
    })
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    client = await pool.connect()
    const suffix = `${process.pid}_${Date.now().toString(36)}`
    absent = makeArm('absent', suffix)
    present = makeArm('present', suffix)
    publicKey = crypto.generateKeyPairSync('ed25519').publicKey
    await buildArm(absent, false)
    await buildArm(present, true)
  }, 120000)

  afterAll(async () => {
    if (client) {
      await client.query('SET search_path TO public').catch(() => {})
      if (absent) await dropArm(absent)
      if (present) await dropArm(present)
      client.release()
    }
    if (pool) await pool.end()
  })

  it('refuses the locking read without migration 074 and completes with it', async () => {
    const withoutRepair = provisioningPool(absent)
    const withoutFailures: DriverFailure[] = []
    try {
      const lifecycle = createSealedExportLifecycleProvisioning({
        db: createDb({ database: instrumentedDatabase(withoutRepair, withoutFailures) }),
      })
      await expect(
        lifecycle.provisionInitialStockPreparationBinding(
          provisionInput(publicKey),
        ),
      ).rejects.toMatchObject({ reason: 'SEALED_EXPORT_INTERNAL_ERROR' })
    } finally {
      await withoutRepair.end()
    }
    expect(withoutFailures).toHaveLength(1)
    expect(withoutFailures[0].code).toBe(INSUFFICIENT_PRIVILEGE)
    expect(withoutFailures[0].sql).toContain(PUBLIC_KEY_TABLE)
    expect(withoutFailures[0].sql.endsWith('LIMIT 1 FOR UPDATE')).toBe(true)

    const withRepair = provisioningPool(present)
    const withFailures: DriverFailure[] = []
    try {
      const lifecycle = createSealedExportLifecycleProvisioning({
        db: createDb({ database: instrumentedDatabase(withRepair, withFailures) }),
      })
      await expect(
        lifecycle.provisionInitialStockPreparationBinding(
          provisionInput(publicKey),
        ),
      ).resolves.toMatchObject({
        changed: true,
        externalWrite: false,
        operation: 'INITIAL_PROVISIONED',
        valuesFree: true,
      })
    } finally {
      await withRepair.end()
    }
    expect(withFailures).toEqual([])
  }, 60000)

  it('provisions through the frozen role-bound database handle and replays idempotently', async () => {
    const handle = createStockPreparationProvisioningDatabase({
      applicationName: 's6a-grant-repair-gate',
      connectionString: roleConnectionString(
        process.env.DATABASE_URL!,
        present.provisioningRole,
        present.provisioningPassword,
      ),
      expectedRole: present.provisioningRole,
    })
    try {
      await expect(handle.assertReady()).resolves.toMatchObject({
        roleVerified: true,
        valuesFree: true,
      })
      const lifecycle = createSealedExportLifecycleProvisioning({ db: handle.db })
      await expect(
        lifecycle.provisionInitialStockPreparationBinding(
          provisionInput(publicKey),
        ),
      ).resolves.toMatchObject({
        changed: false,
        operation: 'INITIAL_PROVISIONED',
      })
    } finally {
      await handle.close()
    }

    await client.query(`SET search_path TO ${quotedIdentifier(present.schema)}`)
    const counts = await client.query<{
      bindings: number
      authority: number
      public_keys: number
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM integration_sealed_export_stock_prep_bindings) AS bindings,
         (SELECT COUNT(*)::int FROM integration_sealed_export_authority_state) AS authority,
         (SELECT COUNT(*)::int FROM integration_sealed_export_signer_public_keys) AS public_keys`,
    )
    await client.query('SET search_path TO public')
    expect(counts.rows).toEqual([{ bindings: 1, authority: 1, public_keys: 1 }])
  }, 60000)

  it('lets the runtime role read back its own audit insert only with migration 074', async () => {
    const generationId = 'generation-grant-repair'
    const manifestDigest = digest('grant-repair-manifest')
    const auditRow = (auditId: string) => ({
      audit_id: auditId,
      generation_id: generationId,
      tenant_id: scope.tenantId,
      workspace_id: null,
      tenant_domain_binding: scope.tenantDomainBinding,
      system_content_key: scope.systemContentKey,
      role_binding_fingerprint: scope.roleBindingFingerprint,
      manifest_digest: manifestDigest,
      event_type: 'SEALED',
      reason: null,
      row_count: 1,
      external_write: false,
      occurred_at: futureIso(0),
    })

    for (const arm of [absent, present]) {
      await client.query(`SET search_path TO ${quotedIdentifier(arm.schema)}`)
      await client.query(
        `INSERT INTO integration_sealed_export_generations (
           generation_id, session_id, tenant_id, workspace_id,
           tenant_domain_binding, system_content_key, role_binding_fingerprint,
           manifest_digest, signer_key_id, qualification_digest,
           canonical_object_version, approved_config_version_id,
           config_content_key, status, manifest_row_count, manifest_byte_count,
           manifest_chunk_count, manifest_artifact_digest,
           manifest_rowset_digest, manifest_chunk_set_digest,
           manifest_expires_at
         ) VALUES (
           $1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           'STAGING', 1, 1, 1, $13, $14, $15, $16
         )`,
        [
          generationId,
          'session-grant-repair',
          scope.tenantId,
          scope.tenantDomainBinding,
          scope.systemContentKey,
          scope.roleBindingFingerprint,
          manifestDigest,
          digest('grant-repair-signer'),
          digest('grant-repair-qualification'),
          CANONICAL_OBJECT_VERSION,
          'config-version-grant-repair',
          digest('grant-repair-config-content'),
          digest('grant-repair-manifest-artifact'),
          digest('grant-repair-manifest-rowset'),
          digest('grant-repair-manifest-chunkset'),
          futureIso(90),
        ],
      )
    }
    await client.query('SET search_path TO public')

    const withoutRepair = runtimePool(absent)
    try {
      const db = createDb({ database: instrumentedDatabase(withoutRepair, []) })
      await expect(
        db.insertOne(AUDIT_TABLE, auditRow('audit-grant-repair-absent')),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
    } finally {
      await withoutRepair.end()
    }

    const withRepair = runtimePool(present)
    try {
      const db = createDb({ database: instrumentedDatabase(withRepair, []) })
      const inserted = await db.insertOne(
        AUDIT_TABLE,
        auditRow('audit-grant-repair-present'),
      )
      const rows = Array.isArray(inserted) ? inserted : inserted.rows
      expect(rows).toHaveLength(1)
      // Append-only stays append-only: no UPDATE/DELETE privilege is granted.
      await expect(
        withRepair.query(`UPDATE ${AUDIT_TABLE} SET row_count = row_count + 1`),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
      await expect(
        withRepair.query(`DELETE FROM ${AUDIT_TABLE}`),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE })
    } finally {
      await withRepair.end()
    }
  }, 60000)

  it('adds row-lock capability without adding write capability', async () => {
    const provisioning = provisioningPool(present)
    const runtime = runtimePool(present)
    try {
      for (const statement of [
        `UPDATE ${PUBLIC_KEY_TABLE} SET public_key_spki_der = decode('02','hex')`,
        `UPDATE ${PUBLIC_KEY_TABLE} SET signature_algorithm = 'ED25519'`,
        `UPDATE ${PUBLIC_KEY_TABLE} SET signer_key_id = repeat('0', 64)`,
        `DELETE FROM ${PUBLIC_KEY_TABLE}`,
        'SELECT 1 FROM integration_sealed_export_stock_prep_runs',
        'INSERT INTO integration_sealed_export_ingestion_sessions DEFAULT VALUES',
      ]) {
        await expect(provisioning.query(statement)).rejects.toMatchObject({
          code: INSUFFICIENT_PRIVILEGE,
        })
      }

      // The one column the repair opens is overwritten by the BEFORE UPDATE
      // trigger from migration 070, so even the granted write is inert.
      await provisioning.query(
        `UPDATE ${PUBLIC_KEY_TABLE}
         SET updated_at = TIMESTAMPTZ '1999-01-01T00:00:00Z'`,
      )
      const stale = await provisioning.query<{ stale: number }>(
        `SELECT COUNT(*)::int AS stale
         FROM ${PUBLIC_KEY_TABLE}
         WHERE updated_at = TIMESTAMPTZ '1999-01-01T00:00:00Z'`,
      )
      expect(stale.rows[0].stale).toBe(0)

      // The runtime side of the frozen matrix is untouched, including the
      // authority-state lock that 073 deliberately refuses.
      for (const statement of [
        "UPDATE integration_sealed_export_authority_state SET signer_status = 'REVOKED'",
        'SELECT * FROM integration_sealed_export_authority_state FOR UPDATE',
      ]) {
        await expect(runtime.query(statement)).rejects.toMatchObject({
          code: INSUFFICIENT_PRIVILEGE,
        })
      }
    } finally {
      await provisioning.end()
      await runtime.end()
    }

    const view = await client.query<{
      prov_table_update: boolean
      prov_col_updated_at: boolean
      prov_col_key_material: boolean
      prov_table_delete: boolean
      runtime_audit_select: boolean
      runtime_audit_update: boolean
      runtime_authority_update: boolean
    }>(
      `SELECT
         has_table_privilege($1, $3, 'UPDATE') AS prov_table_update,
         has_column_privilege($1, $3, 'updated_at', 'UPDATE') AS prov_col_updated_at,
         has_column_privilege($1, $3, 'public_key_spki_der', 'UPDATE') AS prov_col_key_material,
         has_table_privilege($1, $3, 'DELETE') AS prov_table_delete,
         has_table_privilege($2, $4, 'SELECT') AS runtime_audit_select,
         has_table_privilege($2, $4, 'UPDATE') AS runtime_audit_update,
         has_table_privilege($2, $5, 'UPDATE') AS runtime_authority_update`,
      [
        present.provisioningRole,
        present.runtimeRole,
        `${present.schema}.${PUBLIC_KEY_TABLE}`,
        `${present.schema}.${AUDIT_TABLE}`,
        `${present.schema}.integration_sealed_export_authority_state`,
      ],
    )
    expect(view.rows).toEqual([{
      prov_table_update: false,
      prov_col_updated_at: true,
      prov_col_key_material: false,
      prov_table_delete: false,
      runtime_audit_select: true,
      runtime_audit_update: false,
      runtime_authority_update: false,
    }])
  }, 60000)

  it('leaves the ratified 073 capability matrix identical', async () => {
    const matrix = `SELECT
        has_table_privilege($1, $3 || '.integration_sealed_export_stock_prep_bindings', 'SELECT') AS runtime_binding_select,
        has_table_privilege($1, $3 || '.integration_sealed_export_stock_prep_bindings', 'INSERT') AS runtime_binding_insert,
        has_table_privilege($1, $3 || '.integration_sealed_export_authority_state', 'SELECT') AS runtime_authority_select,
        has_table_privilege($1, $3 || '.integration_sealed_export_authority_state', 'UPDATE') AS runtime_authority_update,
        has_table_privilege($1, $3 || '.integration_sealed_export_stock_prep_runs', 'INSERT') AS runtime_run_insert,
        has_table_privilege($1, $3 || '.integration_sealed_export_stock_prep_runs', 'UPDATE') AS runtime_run_update,
        has_table_privilege($2, $3 || '.integration_sealed_export_stock_prep_bindings', 'INSERT') AS provisioning_binding_insert,
        has_table_privilege($2, $3 || '.integration_sealed_export_generations', 'INSERT') AS provisioning_generation_insert,
        has_table_privilege($2, $3 || '.integration_sealed_export_stock_prep_runs', 'SELECT') AS provisioning_run_select,
        has_table_privilege($2, $3 || '.integration_sealed_export_terminal_signer_keys', 'SELECT') AS provisioning_terminal_select,
        has_table_privilege($2, $3 || '.integration_sealed_export_terminal_signer_keys', 'INSERT') AS provisioning_terminal_insert`
    const ratified = {
      runtime_binding_select: true,
      runtime_binding_insert: false,
      runtime_authority_select: true,
      runtime_authority_update: false,
      runtime_run_insert: true,
      runtime_run_update: true,
      provisioning_binding_insert: true,
      provisioning_generation_insert: false,
      provisioning_run_select: false,
      provisioning_terminal_select: true,
      provisioning_terminal_insert: true,
    }
    for (const arm of [absent, present]) {
      const result = await client.query(
        matrix,
        [arm.runtimeRole, arm.provisioningRole, arm.schema],
      )
      expect(result.rows).toEqual([ratified])
    }
  }, 60000)

  it('fails closed on partial, identical, missing and unsafe role inputs', async () => {
    const sql = await fs.readFile(
      path.join(
        repoRoot,
        'packages',
        'core-backend',
        'migrations',
        repairMigration,
      ),
      'utf8',
    )
    const suffix = `${process.pid}_${Date.now().toString(36)}`
    const unsafeRole = `s6a_rep_unsafe_${suffix}`
    const latentSchema = `s6a_repair_latent_${suffix}`

    await client.query(`SET search_path TO ${quotedIdentifier(present.schema)}`)
    try {
      // Only one setting supplied.
      await client.query(
        "SELECT set_config('metasheet.sealed_export_provisioning_role', '', false)",
      )
      await client.query(
        "SELECT set_config('metasheet.sealed_export_runtime_role', $1, false)",
        [present.runtimeRole],
      )
      await expect(client.query(sql)).rejects.toMatchObject({ code: '55000' })

      // The same role for both duties.
      await client.query(
        "SELECT set_config('metasheet.sealed_export_provisioning_role', $1, false)",
        [present.runtimeRole],
      )
      await expect(client.query(sql)).rejects.toMatchObject({ code: '55000' })

      // A role that does not exist.
      await client.query(
        "SELECT set_config('metasheet.sealed_export_provisioning_role', $1, false)",
        [`${unsafeRole}_absent`],
      )
      await expect(client.query(sql)).rejects.toMatchObject({ code: '55000' })

      // A role with unsafe authority.
      await client.query(
        `CREATE ROLE ${quotedIdentifier(unsafeRole)} LOGIN SUPERUSER`,
      )
      await client.query(
        "SELECT set_config('metasheet.sealed_export_provisioning_role', $1, false)",
        [unsafeRole],
      )
      await expect(client.query(sql)).rejects.toMatchObject({ code: '55000' })
      const unsafeGrants = await client.query<{ grants: number }>(
        `SELECT COUNT(*)::int AS grants
         FROM information_schema.role_table_grants
         WHERE grantee = $1`,
        [unsafeRole],
      )
      expect(unsafeGrants.rows[0].grants).toBe(0)

      // Neither setting supplied: a fresh database stays installable and no
      // grant is issued.
      await client.query(`CREATE SCHEMA ${quotedIdentifier(latentSchema)}`)
      await client.query(`SET search_path TO ${quotedIdentifier(latentSchema)}`)
      await client.query(
        "SELECT set_config('metasheet.sealed_export_runtime_role', '', false)",
      )
      await client.query(
        "SELECT set_config('metasheet.sealed_export_provisioning_role', '', false)",
      )
      for (const name of baseMigrations) {
        await client.query(await fs.readFile(
          path.join(repoRoot, 'packages', 'core-backend', 'migrations', name),
          'utf8',
        ))
      }
      await expect(client.query(sql)).resolves.toBeDefined()
      const latentGrants = await client.query<{ grants: number }>(
        `SELECT COUNT(*)::int AS grants
         FROM information_schema.role_table_grants
         WHERE table_schema = $1
           AND grantee NOT IN (current_user, 'PUBLIC')`,
        [latentSchema],
      )
      expect(latentGrants.rows[0].grants).toBe(0)
    } finally {
      await client.query(
        `DROP SCHEMA IF EXISTS ${quotedIdentifier(latentSchema)} CASCADE`,
      ).catch(() => {})
      await client.query(
        `DROP ROLE IF EXISTS ${quotedIdentifier(unsafeRole)}`,
      ).catch(() => {})
      await client.query('SET search_path TO public').catch(() => {})
      await client.query(
        "SELECT set_config('metasheet.sealed_export_runtime_role', '', false)",
      ).catch(() => {})
      await client.query(
        "SELECT set_config('metasheet.sealed_export_provisioning_role', '', false)",
      ).catch(() => {})
    }
  }, 120000)
})
