import fs from 'node:fs/promises'
import path from 'node:path'

import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const migrationNames = [
  '057_create_integration_core_tables.sql',
  '068_create_integration_sealed_export_ingestion.sql',
  '069_create_integration_sealed_export_generation_kernel.sql',
  '070_create_integration_sealed_export_signer_authority.sql',
  '071_harden_integration_sealed_export_authority_lifecycle.sql',
  '072_harden_integration_sealed_export_terminal_signer_history.sql',
]

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

describeIfDatabase('sealed-export signer authority lifecycle migration (real Postgres)', () => {
  let pool: Pool
  let client: PoolClient
  let schema: string

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    })
    client = await pool.connect()
    schema = `s5_authority_${process.pid}_${Date.now()}`
    await client.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`)
    await client.query(
      `SET search_path TO ${quotedIdentifier(schema)}, public`,
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
      await client.query('SET search_path TO public')
      await client.query(
        `DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`,
      )
      client.release()
    }
    if (pool) await pool.end()
  })

  it('rejects terminal-key rotate-back and delete-reinsert while preserving fresh rotation', async () => {
    const keyA = 'a'.repeat(64)
    const keyB = 'b'.repeat(64)
    const keyC = 'd'.repeat(64)
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
        'tenant-s5',
        NULL,
        'tenant-domain-s5',
        'system-content-s5',
        'role-binding-s5',
        $1,
        'ACTIVE',
        '2099-01-01T00:00:00.000Z',
        TRUE,
        '2099-01-01T00:00:00.000Z',
        $2,
        TRUE,
        '2099-01-01T00:00:00.000Z'
      )`,
      [keyA, 'c'.repeat(64)],
    )

    await client.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_status = 'REVOKED'
       WHERE tenant_id = 'tenant-s5'`,
    )

    await expect(
      client.query(
        `UPDATE integration_sealed_export_authority_state
         SET signer_status = 'ACTIVE'
         WHERE tenant_id = 'tenant-s5'`,
      ),
    ).rejects.toMatchObject({ code: '55000' })

    const revoked = await client.query(
      `SELECT signer_key_id, signer_status
       FROM integration_sealed_export_authority_state
       WHERE tenant_id = 'tenant-s5'`,
    )
    expect(revoked.rows).toEqual([
      { signer_key_id: keyA, signer_status: 'REVOKED' },
    ])

    await client.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_key_id = $1, signer_status = 'ACTIVE'
       WHERE tenant_id = 'tenant-s5'`,
      [keyB],
    )
    const rotated = await client.query(
      `SELECT signer_key_id, signer_status
       FROM integration_sealed_export_authority_state
       WHERE tenant_id = 'tenant-s5'`,
    )
    expect(rotated.rows).toEqual([
      { signer_key_id: keyB, signer_status: 'ACTIVE' },
    ])

    await expect(
      client.query(
        `UPDATE integration_sealed_export_authority_state
         SET signer_key_id = $1, signer_status = 'ACTIVE'
         WHERE tenant_id = 'tenant-s5'`,
        [keyA],
      ),
    ).rejects.toMatchObject({ code: '55000' })

    await client.query(
      `UPDATE integration_sealed_export_authority_state
       SET signer_status = 'REVOKED'
       WHERE tenant_id = 'tenant-s5'`,
    )
    await client.query(
      `DELETE FROM integration_sealed_export_authority_state
       WHERE tenant_id = 'tenant-s5'`,
    )

    await expect(
      client.query(
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
          'tenant-s5',
          NULL,
          'tenant-domain-s5',
          'system-content-s5',
          'role-binding-s5',
          $1,
          'ACTIVE',
          '2099-01-01T00:00:00.000Z',
          TRUE,
          '2099-01-01T00:00:00.000Z',
          $2,
          TRUE,
          '2099-01-01T00:00:00.000Z'
        )`,
        [keyB, 'c'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '55000' })

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
        'tenant-s5',
        NULL,
        'tenant-domain-s5',
        'system-content-s5',
        'role-binding-s5',
        $1,
        'ACTIVE',
        '2099-01-01T00:00:00.000Z',
        TRUE,
        '2099-01-01T00:00:00.000Z',
        $2,
        TRUE,
        '2099-01-01T00:00:00.000Z'
      )`,
      [keyC, 'c'.repeat(64)],
    )

    const terminal = await client.query(
      `SELECT signer_key_id, terminal_status
       FROM integration_sealed_export_terminal_signer_keys
       WHERE tenant_id = 'tenant-s5'
       ORDER BY signer_key_id`,
    )
    expect(terminal.rows).toEqual([
      { signer_key_id: keyA, terminal_status: 'REVOKED' },
      { signer_key_id: keyB, terminal_status: 'REVOKED' },
    ])

    await expect(
      client.query(
        `DELETE FROM integration_sealed_export_terminal_signer_keys
         WHERE tenant_id = 'tenant-s5'`,
      ),
    ).rejects.toMatchObject({ code: '55000' })
  })
})
