import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const require = createRequire(import.meta.url)
const {
  createStockPreparationRuntimeDatabase,
} = require(path.join(
  repoRoot,
  'plugins',
  'plugin-integration-core',
  'lib',
  'sealed-export',
  'stock-preparation-runtime-database.cjs',
))
const {
  failSealedExport,
} = require(path.join(
  repoRoot,
  'plugins',
  'plugin-integration-core',
  'lib',
  'sealed-export',
  'failure-vocabulary.cjs',
))
const migrationNames = [
  '057_create_integration_core_tables.sql',
  '068_create_integration_sealed_export_ingestion.sql',
  '069_create_integration_sealed_export_generation_kernel.sql',
  '070_create_integration_sealed_export_signer_authority.sql',
  '071_harden_integration_sealed_export_authority_lifecycle.sql',
  '072_harden_integration_sealed_export_terminal_signer_history.sql',
  '073_create_sealed_export_stock_prep_runtime_authority.sql',
]

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

describeIfDatabase('sealed-export S6-A runtime authority (real Postgres)', () => {
  let pool: Pool
  let client: PoolClient
  let schema: string
  let runtimeRole: string
  let runtimePassword: string
  let provisioningRole: string
  let provisioningPassword: string

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    })
    client = await pool.connect()
    const suffix = `${process.pid}_${Date.now().toString(36)}`
    schema = `s6a_authority_${suffix}`
    runtimeRole = `s6a_runtime_${suffix}`
    runtimePassword = `S6aRuntime_${suffix}`
    provisioningRole = `s6a_provision_${suffix}`
    provisioningPassword = `S6aProvision_${suffix}`
    await client.query(
      `CREATE ROLE ${quotedIdentifier(runtimeRole)}
       LOGIN NOINHERIT PASSWORD '${runtimePassword}'`,
    )
    await client.query(
      `CREATE ROLE ${quotedIdentifier(provisioningRole)}
       LOGIN NOINHERIT PASSWORD '${provisioningPassword}'`,
    )
    await client.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`)
    await client.query(
      `SET search_path TO ${quotedIdentifier(schema)}, public`,
    )
    await client.query(
      "SELECT set_config('metasheet.sealed_export_runtime_role', $1, false)",
      [runtimeRole],
    )
    await client.query(
      "SELECT set_config('metasheet.sealed_export_provisioning_role', $1, false)",
      [provisioningRole],
    )
    for (const name of migrationNames) {
      const sql = await fs.readFile(
        path.join(repoRoot, 'packages', 'core-backend', 'migrations', name),
        'utf8',
      )
      await client.query(sql)
    }
  })

  afterAll(async () => {
    if (client) {
      await client.query('RESET ROLE').catch(() => {})
      await client.query('SET search_path TO public').catch(() => {})
      if (schema) {
        await client.query(
          `DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`,
        ).catch(() => {})
      }
      if (runtimeRole) {
        await client.query(
          `DROP ROLE IF EXISTS ${quotedIdentifier(runtimeRole)}`,
        ).catch(() => {})
      }
      if (provisioningRole) {
        await client.query(
          `DROP ROLE IF EXISTS ${quotedIdentifier(provisioningRole)}`,
        ).catch(() => {})
      }
      client.release()
    }
    if (pool) await pool.end()
  })

  afterEach(async () => {
    if (client) await client.query('RESET ROLE').catch(() => {})
  })

  it('grants only the frozen runtime and provisioning capability matrix', async () => {
    const matrix = await client.query<{
      runtime_binding_select: boolean
      runtime_binding_insert: boolean
      runtime_authority_select: boolean
      runtime_authority_update: boolean
      runtime_run_insert: boolean
      runtime_run_update: boolean
      provisioning_binding_insert: boolean
      provisioning_generation_insert: boolean
      provisioning_run_select: boolean
      provisioning_terminal_select: boolean
      provisioning_terminal_insert: boolean
    }>(
      `SELECT
        has_table_privilege(
          $1,
          'integration_sealed_export_stock_prep_bindings',
          'SELECT'
        ) AS runtime_binding_select,
        has_table_privilege(
          $1,
          'integration_sealed_export_stock_prep_bindings',
          'INSERT'
        ) AS runtime_binding_insert,
        has_table_privilege(
          $1,
          'integration_sealed_export_authority_state',
          'SELECT'
        ) AS runtime_authority_select,
        has_table_privilege(
          $1,
          'integration_sealed_export_authority_state',
          'UPDATE'
        ) AS runtime_authority_update,
        has_table_privilege(
          $1,
          'integration_sealed_export_stock_prep_runs',
          'INSERT'
        ) AS runtime_run_insert,
        has_table_privilege(
          $1,
          'integration_sealed_export_stock_prep_runs',
          'UPDATE'
        ) AS runtime_run_update,
        has_table_privilege(
          $2,
          'integration_sealed_export_stock_prep_bindings',
          'INSERT'
        ) AS provisioning_binding_insert,
        has_table_privilege(
          $2,
          'integration_sealed_export_generations',
          'INSERT'
        ) AS provisioning_generation_insert,
        has_table_privilege(
          $2,
          'integration_sealed_export_stock_prep_runs',
          'SELECT'
        ) AS provisioning_run_select,
        has_table_privilege(
          $2,
          'integration_sealed_export_terminal_signer_keys',
          'SELECT'
        ) AS provisioning_terminal_select,
        has_table_privilege(
          $2,
          'integration_sealed_export_terminal_signer_keys',
          'INSERT'
        ) AS provisioning_terminal_insert`,
      [runtimeRole, provisioningRole],
    )
    expect(matrix.rows).toEqual([{
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
    }])
  })

  it('preserves trusted failures through the real role-bound transaction wrapper', async () => {
    const database = createStockPreparationRuntimeDatabase({
      connectionString: roleConnectionString(
        process.env.DATABASE_URL!,
        runtimeRole,
        runtimePassword,
      ),
      expectedRole: runtimeRole,
    })
    try {
      await expect(database.assertReady()).resolves.toMatchObject({
        roleVerified: true,
        valuesFree: true,
      })
      await expect(
        database.db.transaction(async () => {
          failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
        }),
      ).rejects.toMatchObject({
        reason: 'SEALED_EXPORT_MANIFEST_REPLAYED',
      })
      await expect(
        database.db.transaction(async () => {
          throw new Error('driver schema text must not escape')
        }),
      ).rejects.toMatchObject({
        reason: 'SEALED_EXPORT_INTERNAL_ERROR',
      })
    } finally {
      await database.close()
    }
  })

  it('refuses either direction of runtime/provisioning role inheritance', async () => {
    const sql = await fs.readFile(
      path.join(
        repoRoot,
        'packages',
        'core-backend',
        'migrations',
        '073_create_sealed_export_stock_prep_runtime_authority.sql',
      ),
      'utf8',
    )
    const inheritancePairs = [
      [provisioningRole, runtimeRole],
      [runtimeRole, provisioningRole],
    ]
    for (const [grantedRole, memberRole] of inheritancePairs) {
      await client.query(
        `GRANT ${quotedIdentifier(grantedRole)}
         TO ${quotedIdentifier(memberRole)}`,
      )
      try {
        await expect(client.query(sql)).rejects.toMatchObject({ code: '55000' })
      } finally {
        await client.query(
          `REVOKE ${quotedIdentifier(grantedRole)}
           FROM ${quotedIdentifier(memberRole)}`,
        )
      }
    }

    const otherRole = `s6a_other_${process.pid}_${Date.now().toString(36)}`
    await client.query(
      `CREATE ROLE ${quotedIdentifier(otherRole)} LOGIN NOINHERIT`,
    )
    try {
      await client.query(
        `GRANT ${quotedIdentifier(runtimeRole)}
         TO ${quotedIdentifier(otherRole)}`,
      )
      await expect(client.query(sql)).rejects.toMatchObject({ code: '55000' })
    } finally {
      await client.query(
        `REVOKE ${quotedIdentifier(runtimeRole)}
         FROM ${quotedIdentifier(otherRole)}`,
      ).catch(() => {})
      await client.query(
        `DROP ROLE IF EXISTS ${quotedIdentifier(otherRole)}`,
      ).catch(() => {})
    }
  })

  it('allows first-party provisioning but denies direct runtime authority writes', async () => {
    const signerKeyId = 'a'.repeat(64)
    const qualificationDigest = 'b'.repeat(64)
    await client.query(`SET ROLE ${quotedIdentifier(provisioningRole)}`)
    await client.query(
      `INSERT INTO integration_sealed_export_stock_prep_bindings (
        binding_id,
        tenant_id,
        workspace_id,
        external_system_id,
        object_key,
        relation_id,
        table_ref,
        approved_config_version_id,
        binding_version,
        config_content_key,
        canonical_object_version,
        tenant_domain_binding,
        system_content_key,
        role_binding_fingerprint,
        status,
        expires_at
      ) VALUES (
        'binding-s6a',
        'tenant-s6a',
        NULL,
        'system-s6a',
        'stock-preparation-bom',
        'sqlserver.relation.rowid_payload.v1',
        'dbo.stock_prep_sealed_rows',
        'config-s6a-v1',
        'binding-s6a-v1',
        'config-content-s6a',
        'stock-preparation-bom.v1',
        'tenant-domain-s6a',
        'system-content-s6a',
        'role-binding-s6a',
        'ACTIVE',
        '2099-01-01T00:00:00.000Z'
      )`,
    )
    await expect(
      client.query(
        `INSERT INTO integration_sealed_export_stock_prep_bindings (
          binding_id,
          tenant_id,
          workspace_id,
          external_system_id,
          object_key,
          relation_id,
          table_ref,
          approved_config_version_id,
          binding_version,
          config_content_key,
          canonical_object_version,
          tenant_domain_binding,
          system_content_key,
          role_binding_fingerprint,
          status,
          expires_at
        ) VALUES (
          'binding-s6a-other-customer',
          'tenant-s6a-other',
          NULL,
          'system-s6a-other',
          'stock-preparation-bom',
          'sqlserver.relation.rowid_payload.v1',
          'dbo.stock_prep_sealed_rows',
          'config-s6a-v1',
          'binding-s6a-other-v1',
          'config-content-s6a-other',
          'stock-preparation-bom.v1',
          'tenant-domain-s6a-other',
          'system-content-s6a-other',
          'role-binding-s6a-other',
          'ACTIVE',
          '2099-01-01T00:00:00.000Z'
        )`,
      ),
    ).rejects.toMatchObject({ code: '23505' })
    await client.query(
      `INSERT INTO integration_sealed_export_signer_public_keys (
        tenant_id,
        workspace_id,
        tenant_domain_binding,
        system_content_key,
        role_binding_fingerprint,
        signer_key_id,
        signature_algorithm,
        public_key_spki_der,
        public_key_spki_sha256
      ) VALUES (
        'tenant-s6a',
        NULL,
        'tenant-domain-s6a',
        'system-content-s6a',
        'role-binding-s6a',
        $1,
        'ED25519',
        decode('01', 'hex'),
        $1
      )`,
      [signerKeyId],
    )
    await client.query(
      `INSERT INTO integration_sealed_export_authority_state (
        tenant_id,
        workspace_id,
        tenant_domain_binding,
        system_content_key,
        role_binding_fingerprint,
        signer_key_id,
        signer_status,
        signer_expires_at,
        binding_current,
        binding_expires_at,
        qualification_digest,
        qualification_current,
        qualification_expires_at
      ) VALUES (
        'tenant-s6a',
        NULL,
        'tenant-domain-s6a',
        'system-content-s6a',
        'role-binding-s6a',
        $1,
        'ACTIVE',
        '2099-01-01T00:00:00.000Z',
        TRUE,
        '2099-01-01T00:00:00.000Z',
        $2,
        TRUE,
        '2099-01-01T00:00:00.000Z'
      )`,
      [signerKeyId, qualificationDigest],
    )
    await client.query('RESET ROLE')

    await client.query(`SET ROLE ${quotedIdentifier(runtimeRole)}`)
    const binding = await client.query(
      `SELECT binding_id
       FROM integration_sealed_export_stock_prep_bindings`,
    )
    expect(binding.rows).toEqual([{ binding_id: 'binding-s6a' }])
    await expect(
      client.query(
        `UPDATE integration_sealed_export_authority_state
         SET signer_status = 'REVOKED'`,
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      client.query(
        `INSERT INTO integration_sealed_export_stock_prep_bindings (
          binding_id,
          tenant_id,
          external_system_id,
          object_key,
          relation_id,
          table_ref,
          approved_config_version_id,
          binding_version,
          config_content_key,
          canonical_object_version,
          tenant_domain_binding,
          system_content_key,
          role_binding_fingerprint,
          status,
          expires_at
        ) VALUES (
          'forbidden',
          'tenant-s6a',
          'system-s6a',
          'stock-preparation-bom',
          'sqlserver.relation.rowid_payload.v1',
          'dbo.stock_prep_sealed_rows',
          'config-s6a-v1',
          'forbidden-v1',
          'config-content-s6a',
          'stock-preparation-bom.v1',
          'tenant-domain-s6a',
          'system-content-s6a',
          'role-binding-s6a',
          'ACTIVE',
          '2099-01-01T00:00:00.000Z'
        )`,
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      client.query(
        `SELECT *
         FROM integration_sealed_export_authority_state
         FOR UPDATE`,
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await client.query('RESET ROLE')
  })

  it('records terminal signer history through the provisioning role and replays', async () => {
    await client.query(`SET ROLE ${quotedIdentifier(provisioningRole)}`)
    await client.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_status = 'REVOKED',
           binding_current = FALSE,
           qualification_current = FALSE
       WHERE tenant_id = 'tenant-s6a'`,
    )
    await client.query('RESET ROLE')

    const terminal = await client.query(
      `SELECT terminal_status
       FROM integration_sealed_export_terminal_signer_keys
       WHERE tenant_id = 'tenant-s6a'`,
    )
    expect(terminal.rows).toEqual([{ terminal_status: 'REVOKED' }])

    const sql = await fs.readFile(
      path.join(
        repoRoot,
        'packages',
        'core-backend',
        'migrations',
        '073_create_sealed_export_stock_prep_runtime_authority.sql',
      ),
      'utf8',
    )
    await expect(client.query(sql)).resolves.toBeDefined()
  })

  it('makes capture one-shot and only permits monotonic replay checkpoints', async () => {
    await client.query(`SET ROLE ${quotedIdentifier(runtimeRole)}`)
    await client.query(
      `INSERT INTO integration_sealed_export_stock_prep_runs (
        run_id,
        tenant_id,
        workspace_id,
        operation_id,
        actor_id,
        binding_id,
        status
      ) VALUES (
        'run-s6a',
        'tenant-s6a',
        NULL,
        'operation-s6a',
        'operator-s6a',
        'binding-s6a',
        'CAPTURING'
      )`,
    )
    await expect(
      client.query(
        `INSERT INTO integration_sealed_export_stock_prep_runs (
          run_id,
          tenant_id,
          workspace_id,
          operation_id,
          actor_id,
          binding_id,
          status
        ) VALUES (
          'run-s6a-duplicate',
          'tenant-s6a',
          NULL,
          'operation-s6a',
          'operator-s6a',
          'binding-s6a',
          'CAPTURING'
        )`,
      ),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      client.query(
        `INSERT INTO integration_sealed_export_stock_prep_runs (
          run_id,
          tenant_id,
          workspace_id,
          operation_id,
          actor_id,
          binding_id,
          status
        ) VALUES (
          'run-s6a-concurrent',
          'tenant-s6a',
          NULL,
          'operation-s6a-concurrent',
          'operator-s6a',
          'binding-s6a',
          'CAPTURING'
        )`,
      ),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      client.query(
        `UPDATE integration_sealed_export_stock_prep_runs
         SET status = 'INGESTED',
             ingestion_session_id = 'session-skipped',
             ingested_at = NOW()
         WHERE run_id = 'run-s6a'`,
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await client.query(
      `UPDATE integration_sealed_export_stock_prep_runs
       SET status = 'CAPTURED',
           export_request_envelope = '{"request":"frozen"}'::jsonb,
           manifest = '{"manifest":"frozen"}'::jsonb,
           manifest_digest = $1,
           artifact_directory = '/private/s6a/run-s6a',
           chunk_paths = '["/private/s6a/run-s6a/chunk-0"]'::jsonb,
           captured_at = NOW()
       WHERE run_id = 'run-s6a'`,
      ['c'.repeat(64)],
    )
    await expect(
      client.query(
        `UPDATE integration_sealed_export_stock_prep_runs
         SET manifest = '{"manifest":"replaced"}'::jsonb
         WHERE run_id = 'run-s6a'`,
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await expect(
      client.query(
        `UPDATE integration_sealed_export_stock_prep_runs
         SET source_read_count = 2
         WHERE run_id = 'run-s6a'`,
      ),
    ).rejects.toMatchObject({ code: '55000' })
    await client.query(
      `UPDATE integration_sealed_export_stock_prep_runs
       SET status = 'INGESTING',
           ingestion_session_id = 'session-s6a',
           ingested_at = NOW()
       WHERE run_id = 'run-s6a'`,
    )
    await client.query(
      `UPDATE integration_sealed_export_stock_prep_runs
       SET status = 'INGESTED'
       WHERE run_id = 'run-s6a'`,
    )
    await client.query(
      `UPDATE integration_sealed_export_stock_prep_runs
       SET status = 'GENERATION_VERIFIED',
           generation_id = 'generation-s6a',
           generation_verified_at = NOW()
       WHERE run_id = 'run-s6a'`,
    )
    await client.query(
      `UPDATE integration_sealed_export_stock_prep_runs
       SET status = 'ACTIVATED',
           activated_at = NOW()
       WHERE run_id = 'run-s6a'`,
    )
    await client.query(
      `UPDATE integration_sealed_export_stock_prep_runs
       SET status = 'COMPLETED',
           stock_preparation_run_id = 'stock-prep-run-s6a',
           business_line_count = 2,
           completed_at = NOW()
       WHERE run_id = 'run-s6a'`,
    )
    const completed = await client.query(
      `SELECT
         status,
         source_read_count,
         business_line_count,
         manifest_digest
       FROM integration_sealed_export_stock_prep_runs
       WHERE run_id = 'run-s6a'`,
    )
    expect(completed.rows).toEqual([{
      business_line_count: 2,
      manifest_digest: 'c'.repeat(64),
      source_read_count: 1,
      status: 'COMPLETED',
    }])
    await expect(
      client.query(
        `INSERT INTO integration_sealed_export_stock_prep_runs (
          run_id,
          tenant_id,
          workspace_id,
          operation_id,
          actor_id,
          binding_id,
          status
        ) VALUES (
          'run-s6a-next',
          'tenant-s6a',
          NULL,
          'operation-s6a-next',
          'operator-s6a',
          'binding-s6a',
          'CAPTURING'
        )`,
      ),
    ).resolves.toBeDefined()
    await client.query('RESET ROLE')
  })
})
