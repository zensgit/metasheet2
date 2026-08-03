// Sealed-export S6-A — migration 075 authority-state ROW LOCK gate (real Postgres).
//
// Migration 073 grants the runtime role only SELECT on
// integration_sealed_export_authority_state, so the mandated re-verification in
// the final activation transaction (generation-kernel.cjs:934 ->
// generation-store.cjs:383 -> db.cjs:212's `... LIMIT 1 FOR UPDATE`) was refused
// 42501 and converted to SEALED_EXPORT_INTERNAL_ERROR. Migration 075 grants the
// minimal privilege PostgreSQL accepts for a row-level locking clause.
//
// This file proves FOUR things, in ONE fixture so necessity is provable without
// a second database:
//   1. NECESSITY   — before 075 the lock is refused 42501; after 075 it succeeds.
//   2. REALITY     — the lock acquired is a genuine, row-scoped row lock
//                    (a second session gets 55P03 NOWAIT on the same row, and is
//                    unaffected on a different row), not a privilege no-op.
//   3. MINIMALITY  — a narrower grant and a broader grant are both MEASURED, not
//                    argued, and the claim made about the chosen grant is exactly
//                    what the measurements support.
//   4. NO WIDENING — after 075 every authority-state mutation is still refused,
//                    the runtime role's updatable-column set is exactly
//                    {updated_at}, and that one column mutates nothing for any
//                    value signer_status may take. With a positive control.
//
// Values-free: assertions are over SQLSTATEs, privilege booleans, column names
// and counts. No authority row value is read into an assertion.

import fs from 'node:fs/promises'
import path from 'node:path'

import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')

const AUTHORITY_TABLE = 'integration_sealed_export_authority_state'

// The chain up to and including 074 — deliberately WITHOUT 075, so the
// necessity arm runs against the exact privilege state main is in today.
const BASE_MIGRATIONS = [
  '057_create_integration_core_tables.sql',
  '068_create_integration_sealed_export_ingestion.sql',
  '069_create_integration_sealed_export_generation_kernel.sql',
  '070_create_integration_sealed_export_signer_authority.sql',
  '071_harden_integration_sealed_export_authority_lifecycle.sql',
  '072_harden_integration_sealed_export_terminal_signer_history.sql',
  '073_create_sealed_export_stock_prep_runtime_authority.sql',
  '074_repair_sealed_export_runtime_authority_privileges.sql',
]
const LOCK_GRANT_MIGRATION =
  '075_grant_sealed_export_runtime_authority_row_lock.sql'

// Every authority-bearing column. Not a sample: the activation predicate
// authorityReason() (generation-kernel.cjs:259-285) reads signer_key_id,
// signer_status, signer_expires_at, binding_current, binding_expires_at,
// qualification_current, qualification_digest and qualification_expires_at, and
// the scope columns identify which row it reads.
const AUTHORITY_BEARING_COLUMNS = [
  'tenant_id',
  'workspace_id',
  'tenant_domain_binding',
  'system_content_key',
  'role_binding_fingerprint',
  'signer_key_id',
  'signer_status',
  'signer_expires_at',
  'binding_current',
  'binding_expires_at',
  'qualification_digest',
  'qualification_current',
  'qualification_expires_at',
]

// The full domain of 069's signer_status CHECK constraint.
const SIGNER_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const

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

async function sqlstateOf(
  client: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<string> {
  try {
    await client.query(sql, params)
    return 'OK'
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : 'ERR'
  }
}

describeIfDatabase(
  'sealed-export S6-A authority-state row lock (migration 075, real Postgres)',
  () => {
    let ownerPool: Pool
    let owner: PoolClient
    let runtimePool: Pool
    let runtime: PoolClient
    let provisioningPool: Pool
    let provisioning: PoolClient
    let schema: string
    let runtimeRole: string
    let provisioningRole: string
    let runtimePassword: string
    let provisioningPassword: string

    async function readMigration(name: string): Promise<string> {
      return fs.readFile(
        path.join(repoRoot, 'packages', 'core-backend', 'migrations', name),
        'utf8',
      )
    }

    async function applyMigration(name: string): Promise<void> {
      await owner.query(await readMigration(name))
    }

    // The necessity arm is only valid BEFORE 075 is applied, so the arms share
    // one fixture and run in declaration order. This makes the post-grant arms
    // independent of that order anyway: any of them can be run alone (`-t`) and
    // will apply 075 itself. GRANT is idempotent, so the guard is an
    // optimisation, not a correctness crutch.
    let lockGrantApplied = false
    async function ensureLockGrantApplied(): Promise<void> {
      if (lockGrantApplied) return
      await applyMigration(LOCK_GRANT_MIGRATION)
      lockGrantApplied = true
    }

    // has_table_privilege(..., 'UPDATE') is FALSE for a column-level grant.
    // That is expected, not a missing grant (074:41-44).
    async function hasTableUpdate(role: string): Promise<boolean> {
      const result = await owner.query<{ ok: boolean }>(
        'SELECT has_table_privilege($1, $2, $3) AS ok',
        [role, `${schema}.${AUTHORITY_TABLE}`, 'UPDATE'],
      )
      return result.rows[0].ok
    }

    async function updatableColumns(role: string): Promise<string[]> {
      const result = await owner.query<{ attname: string }>(
        `SELECT attname
         FROM pg_attribute
         WHERE attrelid = $2::regclass
           AND attnum > 0
           AND NOT attisdropped
           AND has_column_privilege($1, $2::regclass, attname, 'UPDATE')
         ORDER BY attname`,
        [role, `${schema}.${AUTHORITY_TABLE}`],
      )
      return result.rows.map((row) => row.attname)
    }

    beforeAll(async () => {
      // max: 2 — the fail-closed arm needs a SECOND owner connection whose
      // session settings are independent of the fixture connection's.
      ownerPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
      owner = await ownerPool.connect()
      const suffix = `${process.pid}_${Date.now().toString(36)}`
      schema = `s6a_lock_${suffix}`
      runtimeRole = `s6a_lock_runtime_${suffix}`
      runtimePassword = `S6aLockRuntime_${suffix}`
      provisioningRole = `s6a_lock_provision_${suffix}`
      provisioningPassword = `S6aLockProvision_${suffix}`

      await owner.query(
        `CREATE ROLE ${quotedIdentifier(runtimeRole)}
         LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
         NOINHERIT PASSWORD '${runtimePassword}'`,
      )
      await owner.query(
        `CREATE ROLE ${quotedIdentifier(provisioningRole)}
         LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
         NOINHERIT PASSWORD '${provisioningPassword}'`,
      )
      await owner.query(`CREATE SCHEMA ${quotedIdentifier(schema)}`)
      await owner.query(`SET search_path TO ${quotedIdentifier(schema)}, public`)
      await owner.query(
        "SELECT set_config('metasheet.sealed_export_runtime_role', $1, false)",
        [runtimeRole],
      )
      await owner.query(
        "SELECT set_config('metasheet.sealed_export_provisioning_role', $1, false)",
        [provisioningRole],
      )
      for (const name of BASE_MIGRATIONS) await applyMigration(name)

      // Seed one authority row per signer_status the CHECK constraint permits,
      // through the provisioning role, which is the role 073 authorises to do it.
      const signerKeys = new Map(
        SIGNER_STATUSES.map((status, index) => [
          status,
          `${String.fromCharCode(97 + index)}`.repeat(64),
        ]),
      )
      for (const status of SIGNER_STATUSES) {
        const signerKeyId = signerKeys.get(status)!
        await owner.query(
          `INSERT INTO integration_sealed_export_signer_public_keys (
            tenant_id, workspace_id, tenant_domain_binding, system_content_key,
            role_binding_fingerprint, signer_key_id, signature_algorithm,
            public_key_spki_der, public_key_spki_sha256
          ) VALUES ($1, NULL, 'tdb-s6a', 'sck-s6a', 'rbf-s6a', $2, 'ED25519',
            decode('01', 'hex'), $2)`,
          [`tenant-${status.toLowerCase()}`, signerKeyId],
        )
        await owner.query(
          `INSERT INTO integration_sealed_export_authority_state (
            tenant_id, workspace_id, tenant_domain_binding, system_content_key,
            role_binding_fingerprint, signer_key_id, signer_status,
            signer_expires_at, binding_current, binding_expires_at,
            qualification_digest, qualification_current, qualification_expires_at
          ) VALUES ($1, NULL, 'tdb-s6a', 'sck-s6a', 'rbf-s6a', $2, $3,
            '2099-01-01T00:00:00.000Z', TRUE, '2099-01-01T00:00:00.000Z',
            $4, TRUE, '2099-01-01T00:00:00.000Z')`,
          [
            `tenant-${status.toLowerCase()}`,
            signerKeyId,
            status,
            'd'.repeat(64),
          ],
        )
      }

      const databaseUrl = process.env.DATABASE_URL!
      runtimePool = new Pool({
        connectionString: roleConnectionString(
          databaseUrl,
          runtimeRole,
          runtimePassword,
        ),
        max: 2,
      })
      provisioningPool = new Pool({
        connectionString: roleConnectionString(
          databaseUrl,
          provisioningRole,
          provisioningPassword,
        ),
        max: 1,
      })
      runtime = await runtimePool.connect()
      provisioning = await provisioningPool.connect()
      await runtime.query(`SET search_path TO ${quotedIdentifier(schema)}, public`)
      await provisioning.query(
        `SET search_path TO ${quotedIdentifier(schema)}, public`,
      )
    })

    afterAll(async () => {
      if (runtime) runtime.release()
      if (provisioning) provisioning.release()
      if (runtimePool) await runtimePool.end().catch(() => {})
      if (provisioningPool) await provisioningPool.end().catch(() => {})
      if (owner) {
        await owner.query('SET search_path TO public').catch(() => {})
        if (schema) {
          await owner
            .query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(schema)} CASCADE`)
            .catch(() => {})
        }
        for (const role of [runtimeRole, provisioningRole]) {
          if (!role) continue
          await owner
            .query(`DROP ROLE IF EXISTS ${quotedIdentifier(role)}`)
            .catch(() => {})
        }
        owner.release()
      }
      if (ownerPool) await ownerPool.end()
    })

    // ── 1. NECESSITY, and the narrower/broader counterfactuals ──────────────
    //
    // Ordered first and in one `it` because the necessity arm is only valid
    // BEFORE 075 is applied, and the counterfactual grants must be measured and
    // fully revoked before the real grant lands.
    it(
      'refuses the activation lock before 075, and bounds the grant from both '
        + 'sides (narrower / broader) before applying it',
      async () => {
        // --- NECESSITY: this is the exact statement db.cjs:212 emits, minus
        // the row predicate. `WHERE false` makes it a pure privilege probe:
        // PostgreSQL checks the privilege before it checks whether any row
        // qualifies, so no row is touched and no trigger can mask the result.
        expect(
          await sqlstateOf(
            runtime,
            `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE false FOR UPDATE`,
          ),
        ).toBe('42501')
        // Positive control for the probe itself: the NON-locking read of the
        // same table by the same role in the same session succeeds, so the
        // 42501 above is attributable to the locking clause and nothing else.
        expect(
          await sqlstateOf(
            runtime,
            `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE false`,
          ),
        ).toBe('OK')
        expect(await hasTableUpdate(runtimeRole)).toBe(false)
        expect(await updatableColumns(runtimeRole)).toEqual([])

        // --- NARROWER CANDIDATE, measured rather than assumed. A grant on the
        // GENERATED column workspace_scope_key also satisfies PostgreSQL's
        // any-column check and permits literally no write (a generated column
        // can only be assigned DEFAULT). It is therefore narrower than
        // UPDATE (updated_at) and it DOES enable the lock. 075 deliberately
        // does not use it: it diverges from 074's ratified convention on the
        // sibling table, a grant naming a never-writable column is an obscure
        // construction, and it would silently stop granting the lock if the
        // generated column were ever dropped. Recording the measurement here is
        // what keeps 075's minimality claim honest: the chosen grant is minimal
        // AMONG GRANTS FOLLOWING 074's CONVENTION, not minimal imaginable.
        await owner.query(
          `GRANT UPDATE (workspace_scope_key) ON TABLE ${AUTHORITY_TABLE}
           TO ${quotedIdentifier(runtimeRole)}`,
        )
        expect(
          await sqlstateOf(
            runtime,
            `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE false FOR UPDATE`,
          ),
        ).toBe('OK')
        expect(
          await sqlstateOf(
            runtime,
            `UPDATE ${AUTHORITY_TABLE} SET workspace_scope_key = '' WHERE false`,
          ),
        ).toBe('428C9')
        await owner.query(
          `REVOKE UPDATE (workspace_scope_key) ON TABLE ${AUTHORITY_TABLE}
           FROM ${quotedIdentifier(runtimeRole)}`,
        )
        // Restored: the counterfactual left nothing behind.
        expect(
          await sqlstateOf(
            runtime,
            `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE false FOR UPDATE`,
          ),
        ).toBe('42501')

        // --- BROADER CANDIDATE: what a table-level UPDATE would additionally
        // permit. `WHERE false` again, so the BEFORE UPDATE guard trigger
        // (072:90-179) cannot fire and mask the privilege answer — the arm
        // measures the PRIVILEGE LAYER, which must refuse on its own rather
        // than delegating to a trigger.
        await owner.query(
          `GRANT UPDATE ON TABLE ${AUTHORITY_TABLE}
           TO ${quotedIdentifier(runtimeRole)}`,
        )
        for (const column of ['signer_status', 'signer_key_id', 'binding_current']) {
          expect(
            await sqlstateOf(
              runtime,
              `UPDATE ${AUTHORITY_TABLE} SET ${column} = NULL WHERE false`,
            ),
          ).toBe('OK')
        }
        // ...and it would flip the ratified capability matrix
        // (sealed-export-s6a-runtime-authority.db.test.ts asserts
        // runtime_authority_update: false).
        expect(await hasTableUpdate(runtimeRole)).toBe(true)
        await owner.query(
          `REVOKE UPDATE ON TABLE ${AUTHORITY_TABLE}
           FROM ${quotedIdentifier(runtimeRole)}`,
        )
        expect(
          await sqlstateOf(
            runtime,
            `UPDATE ${AUTHORITY_TABLE} SET signer_status = NULL WHERE false`,
          ),
        ).toBe('42501')
        expect(await hasTableUpdate(runtimeRole)).toBe(false)
        expect(await updatableColumns(runtimeRole)).toEqual([])

        // --- APPLY 075. Everything after this point is the post-grant world.
        await ensureLockGrantApplied()
      },
    )

    // ── 2. SUFFICIENCY and REALITY ──────────────────────────────────────────
    it('grants a real, row-scoped lock after 075', async () => {
      await ensureLockGrantApplied()
      expect(
        await sqlstateOf(
          runtime,
          `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE false FOR UPDATE`,
        ),
      ).toBe('OK')
      expect(
        await sqlstateOf(
          runtime,
          `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE tenant_id = $1 FOR UPDATE`,
          ['tenant-active'],
        ),
      ).toBe('OK')

      // A privilege that yields no lock would be a no-op dressed as a fix.
      // Hold the row in one runtime session and prove a second runtime session
      // is genuinely blocked on THAT row (55P03 lock_not_available) and
      // genuinely NOT blocked on a different one.
      const holder = await runtimePool.connect()
      const contender = await runtimePool.connect()
      try {
        await holder.query(
          `SET search_path TO ${quotedIdentifier(schema)}, public`,
        )
        await contender.query(
          `SET search_path TO ${quotedIdentifier(schema)}, public`,
        )
        await holder.query('BEGIN')
        await holder.query(
          `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE tenant_id = $1 FOR UPDATE`,
          ['tenant-active'],
        )
        expect(
          await sqlstateOf(
            contender,
            `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE tenant_id = $1
             FOR UPDATE NOWAIT`,
            ['tenant-active'],
          ),
        ).toBe('55P03')
        expect(
          await sqlstateOf(
            contender,
            `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE tenant_id = $1
             FOR UPDATE NOWAIT`,
            ['tenant-expired'],
          ),
        ).toBe('OK')
        await holder.query('COMMIT')
        // Released, so the fixture is byte-identical for the arms that follow.
        expect(
          await sqlstateOf(
            contender,
            `SELECT 1 FROM ${AUTHORITY_TABLE} WHERE tenant_id = $1
             FOR UPDATE NOWAIT`,
            ['tenant-active'],
          ),
        ).toBe('OK')
      } finally {
        await holder.query('ROLLBACK').catch(() => {})
        await contender.query('ROLLBACK').catch(() => {})
        holder.release()
        contender.release()
      }
    })

    // ── 3. NO WIDENING ──────────────────────────────────────────────────────
    it('adds no authority-state mutation capability whatsoever', async () => {
      await ensureLockGrantApplied()
      // The privilege layer, enumerated over every authority-bearing column.
      for (const column of AUTHORITY_BEARING_COLUMNS) {
        expect(
          await sqlstateOf(
            runtime,
            `UPDATE ${AUTHORITY_TABLE} SET ${column} = NULL WHERE false`,
          ),
        ).toBe('42501')
      }
      expect(
        await sqlstateOf(
          runtime,
          `INSERT INTO ${AUTHORITY_TABLE} (
            tenant_id, tenant_domain_binding, system_content_key,
            role_binding_fingerprint, signer_key_id, signer_status,
            signer_expires_at, binding_current, binding_expires_at,
            qualification_digest, qualification_current, qualification_expires_at
          ) VALUES ('forbidden', 'tdb-s6a', 'sck-s6a', 'rbf-s6a', $1, 'ACTIVE',
            '2099-01-01T00:00:00.000Z', TRUE, '2099-01-01T00:00:00.000Z', $1,
            TRUE, '2099-01-01T00:00:00.000Z')`,
          ['9'.repeat(64)],
        ),
      ).toBe('42501')
      expect(
        await sqlstateOf(runtime, `DELETE FROM ${AUTHORITY_TABLE} WHERE false`),
      ).toBe('42501')
      expect(
        await sqlstateOf(runtime, `TRUNCATE ${AUTHORITY_TABLE}`),
      ).toBe('42501')

      // The whole delta is one column, and it is the one 074's convention names.
      expect(await hasTableUpdate(runtimeRole)).toBe(false)
      expect(await updatableColumns(runtimeRole)).toEqual(['updated_at'])
    })

    it(
      'cannot mutate a single authority row through the one column it may '
        + 'name, for any signer_status, with a positive control',
      async () => {
        await ensureLockGrantApplied()
        // updated_at is not read by authorityReason()
        // (generation-kernel.cjs:259-285) and the BEFORE UPDATE trigger
        // integration_set_updated_at (069:605-614, 057:182-188) overwrites it
        // with NOW() unconditionally, so no caller-supplied value could be
        // stored even if the statement were permitted. It is not: the guard
        // trigger (072:90-179) is NOT SECURITY DEFINER, so it runs as the
        // caller and touches integration_sealed_export_terminal_signer_keys —
        // on which the runtime role holds nothing — for EVERY value
        // signer_status may take (the 'ACTIVE' branch reads it; the
        // EXPIRED/REVOKED branches insert into it). The runtime role therefore
        // fails closed on every row state, which is the whole CHECK domain.
        for (const status of SIGNER_STATUSES) {
          expect(
            await sqlstateOf(
              runtime,
              `UPDATE ${AUTHORITY_TABLE} SET updated_at = NOW()
               WHERE tenant_id = $1`,
              [`tenant-${status.toLowerCase()}`],
            ),
          ).toBe('42501')
        }

        // POSITIVE CONTROL. Without it, "the runtime role's UPDATE is refused"
        // would not distinguish a privilege refusal from a trigger that is
        // broken for everyone. The provisioning role — which 073 authorises to
        // write authority state — runs the identical statement and succeeds.
        expect(
          await sqlstateOf(
            provisioning,
            `UPDATE ${AUTHORITY_TABLE} SET updated_at = NOW()
             WHERE tenant_id = $1`,
            ['tenant-active'],
          ),
        ).toBe('OK')
      },
    )

    // ── 4. NOTHING ELSE MOVED ───────────────────────────────────────────────
    it('leaves every other table 073/074 govern exactly as it was', async () => {
      await ensureLockGrantApplied()
      const others = [
        'integration_sealed_export_stock_prep_bindings',
        'integration_sealed_export_generation_rows',
        'integration_sealed_export_generation_audit',
        'integration_sealed_export_signer_public_keys',
        'integration_sealed_export_terminal_signer_keys',
      ]
      for (const table of others) {
        const result = await owner.query<{
          table_update: boolean
          any_column_update: boolean
        }>(
          `SELECT
             has_table_privilege($1, $2, 'UPDATE') AS table_update,
             COALESCE(bool_or(
               has_column_privilege($1, $2::regclass, attname, 'UPDATE')
             ), false) AS any_column_update
           FROM pg_attribute
           WHERE attrelid = $2::regclass
             AND attnum > 0
             AND NOT attisdropped`,
          [runtimeRole, `${schema}.${table}`],
        )
        expect({ table, ...result.rows[0] }).toEqual({
          table,
          table_update: false,
          any_column_update: false,
        })
      }

      // 075 grants nothing to the provisioning role.
      const provisioningLock = await owner.query<{ ok: boolean }>(
        `SELECT has_column_privilege($1, $2::regclass, 'updated_at', 'UPDATE')
         AS ok`,
        [provisioningRole, `${schema}.${AUTHORITY_TABLE}`],
      )
      // 073 already grants the provisioning role table-level UPDATE here, so
      // this is TRUE from 073, not from 075 — asserted so a future reader does
      // not mistake it for something 075 added.
      expect(provisioningLock.rows[0].ok).toBe(true)
      expect(await hasTableUpdate(provisioningRole)).toBe(true)
    })

    // ── 5. The migration is replayable and fails closed unconfigured ────────
    it('is idempotent on replay and stays latent without role settings', async () => {
      await ensureLockGrantApplied()
      await expect(applyMigration(LOCK_GRANT_MIGRATION)).resolves.toBeDefined()
      expect(await updatableColumns(runtimeRole)).toEqual(['updated_at'])

      const scratch = `${schema}_latent`
      await owner.query(`CREATE SCHEMA ${quotedIdentifier(scratch)}`)
      const latent = await ownerPool.connect()
      try {
        await latent.query(
          `SET search_path TO ${quotedIdentifier(scratch)}, public`,
        )
        // Neither setting configured: NOTICE and return, so a fresh CI database
        // stays installable.
        await expect(
          latent.query(await readMigration(LOCK_GRANT_MIGRATION)),
        ).resolves.toBeDefined()
        // Exactly one setting configured: fail closed, 55000.
        await latent.query(
          "SELECT set_config('metasheet.sealed_export_runtime_role', $1, false)",
          [runtimeRole],
        )
        await expect(
          latent.query(await readMigration(LOCK_GRANT_MIGRATION)),
        ).rejects.toMatchObject({ code: '55000' })
        // Same role for both duties: fail closed, 55000.
        await latent.query(
          `SELECT set_config('metasheet.sealed_export_provisioning_role', $1, false)`,
          [runtimeRole],
        )
        await expect(
          latent.query(await readMigration(LOCK_GRANT_MIGRATION)),
        ).rejects.toMatchObject({ code: '55000' })
      } finally {
        latent.release()
      }
      await owner
        .query(`DROP SCHEMA IF EXISTS ${quotedIdentifier(scratch)} CASCADE`)
        .catch(() => {})
    })
  },
)
