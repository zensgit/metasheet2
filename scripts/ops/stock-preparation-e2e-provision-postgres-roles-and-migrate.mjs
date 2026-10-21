#!/usr/bin/env node
'use strict'

// Stock-preparation E2E functional smoke — Postgres role setup + migration runner.
//
// The sealed-export S6-A migration (073_create_sealed_export_stock_prep_runtime_authority.sql) grants
// its runtime/provisioning privilege matrix ONLY if the two `metasheet.sealed_export_*_role` settings
// are visible to the connection that FIRST applies that migration — see
// docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md §2. In an ephemeral CI
// Postgres this script:
//   1. creates the two login roles (NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS/
//      NOINHERIT, neither a member of the other, neither equal to the migration owner);
//   2. probes the role-safety predicate's own preconditions and, if one is violated, reports WHICH
//      one — see the pg_auth_members note below;
//   3. runs the ordinary core-backend migration entry point against a connection string carrying both
//      role names via the standard libpq `options` query parameter (`-c name=value`), so every
//      migration — including 073 — sees them from the very first connection.
//
// WHY STEP 2 EXISTS — the pg_auth_members / createrole_self_grant trap.
//   073:498-518 (and the identical preambles at 074:111-131 and 075:154-174) refuse a sealed-export
//   role with a single undifferentiated message, 'sealed-export role has unsafe authority', for any
//   of eight conditions. One of them is "the role participates in ANY pg_auth_members grant, in
//   either direction" (073:508-514).
//
//   That last condition is the one an on-prem DBA trips without knowing why. From PostgreSQL 16
//   onward, a NON-SUPERUSER role holding CREATEROLE is automatically granted membership WITH ADMIN
//   OPTION in every role it creates; that automatic grant IS a pg_auth_members row. The
//   `createrole_self_grant` GUC (also new in 16) only decides whether SET and/or INHERIT ride along
//   on that same grant — it does NOT decide whether the row exists, and its default value does not
//   suppress the row. So a DBA who follows the runbook's CREATE ROLE text to the letter while
//   connected as a CREATEROLE non-superuser produces two perfectly-attributed roles that the
//   migration still refuses, with no hint pointing at role membership.
//
//   The diagnostic cannot live in migration 073: 073 is a content-digest pin of the frozen S6-A
//   package (plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
//   migrations."073", asserted by verifyPinnedMigrations in sealed-export-package-provenance.cjs),
//   so amending it by one byte breaks the frozen package; 074 and 075 are already applied on main,
//   so an in-place edit would never re-run on an existing deployment. It lives here and in
//   docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md §2 instead. This
//   probe does NOT weaken the predicate — it refuses exactly the same roles the migration would,
//   only earlier and with the cause named.
//
// Env in: PG_SUPERUSER_URL, RUNTIME_ROLE, RUNTIME_PASSWORD, PROVISIONING_ROLE, PROVISIONING_PASSWORD.
// Optional (S10 package mode, all unset => byte-identical to before): E2E_MIGRATE_ROOT, E2E_MIGRATE_CMD,
// E2E_MIGRATE_ARGS — see the comment above the spawn in main().
// Never logs a password or a full connection string.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
// pnpm's strict node_modules means `pg` (a core-backend dependency) is not resolvable from a plain
// repo-root `import` — resolve it the same way the T4/S2/S5 harnesses resolve their own scoped deps.
const requireFromCoreBackend = createRequire(
  path.join(REPO_ROOT, 'packages/core-backend/package.json'),
)
const pg = requireFromCoreBackend('pg')

function requiredEnv(name) {
  const value = process.env[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

function quotedIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}

// CREATE ROLE is a utility (DDL) statement — PostgreSQL's grammar does not accept a $n bind parameter
// in the PASSWORD clause of a utility statement (only DML goes through the parameterized executor
// path), so the password must be inlined as a quoted SQL string literal.
function quotedLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`
}

// Mirrors the migration predicate leg-for-leg (073:498-518). Returns a list of human-readable
// causes; empty means the migration will accept the role. This is a REPORTING aid only: it never
// relaxes anything, and the migration remains the authority.
async function unsafeAuthorityCauses(client, roleName, duty) {
  const { rows } = await client.query(
    `SELECT
       r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
       r.rolbypassrls, r.rolcanlogin, r.rolinherit,
       r.rolname = current_user AS is_current_user,
       pg_has_role(r.rolname, current_user, 'MEMBER') AS member_of_current_user,
       (
         SELECT count(*)
         FROM pg_auth_members m
         WHERE m.member = r.oid OR m.roleid = r.oid
       ) AS membership_rows
     FROM pg_roles r
     WHERE r.rolname = $1`,
    [roleName],
  )
  if (rows.length === 0) {
    return [`${duty} role does not exist (073:494-497)`]
  }
  const row = rows[0]
  const causes = []
  const attributeLegs = [
    ['rolsuper', 'SUPERUSER'],
    ['rolcreatedb', 'CREATEDB'],
    ['rolcreaterole', 'CREATEROLE'],
    ['rolreplication', 'REPLICATION'],
    ['rolbypassrls', 'BYPASSRLS'],
    ['rolinherit', 'INHERIT'],
  ]
  for (const [column, label] of attributeLegs) {
    if (row[column] === true) {
      causes.push(`${duty} role holds ${label}; the runbook requires NO${label}`)
    }
  }
  if (row.rolcanlogin !== true) {
    causes.push(`${duty} role cannot LOGIN; the runbook requires LOGIN`)
  }
  if (row.is_current_user === true) {
    causes.push(`${duty} role is the migration owner; they must be distinct`)
  }
  if (row.member_of_current_user === true) {
    causes.push(`${duty} role is a member of the migration owner`)
  }
  if (Number(row.membership_rows) > 0) {
    causes.push(
      `${duty} role participates in ${row.membership_rows} pg_auth_members grant(s); ` +
        '073:508-514 requires ZERO in either direction. On PostgreSQL 16+ this is almost always the ' +
        'automatic ADMIN OPTION membership that a NON-SUPERUSER CREATEROLE role receives in every ' +
        'role it creates — see the createrole_self_grant documentation, noting that the GUC only ' +
        'controls whether SET/INHERIT ride along and does NOT suppress the pg_auth_members row. ' +
        'Remedy: create the sealed-export roles as a SUPERUSER, or REVOKE the automatic grant ' +
        '(REVOKE <role> FROM <creating-role>) before running migrations. Do not relax the predicate.',
    )
  }
  return causes
}

async function main() {
  const superuserUrl = requiredEnv('PG_SUPERUSER_URL')
  const runtimeRole = requiredEnv('RUNTIME_ROLE')
  const runtimePassword = requiredEnv('RUNTIME_PASSWORD')
  const provisioningRole = requiredEnv('PROVISIONING_ROLE')
  const provisioningPassword = requiredEnv('PROVISIONING_PASSWORD')

  const pool = new pg.Pool({ connectionString: superuserUrl, max: 1 })
  try {
    const client = await pool.connect()
    try {
      await client.query(
        `CREATE ROLE ${quotedIdentifier(runtimeRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${quotedLiteral(runtimePassword)}`,
      )
      await client.query(
        `CREATE ROLE ${quotedIdentifier(provisioningRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${quotedLiteral(provisioningPassword)}`,
      )

      // Fail here, with the cause named, rather than 40 migrations later with
      // 'sealed-export role has unsafe authority' and nothing to act on.
      const causes = [
        ...(await unsafeAuthorityCauses(client, runtimeRole, 'runtime')),
        ...(await unsafeAuthorityCauses(client, provisioningRole, 'provisioning')),
      ]
      if (causes.length > 0) {
        for (const cause of causes) {
          process.stderr.write(`[e2e-provision] UNSAFE AUTHORITY: ${cause}\n`)
        }
        throw new Error(
          'sealed-export roles would be refused by migrations 073/074/075; see the UNSAFE AUTHORITY lines above',
        )
      }
      process.stderr.write(
        '[e2e-provision] role-safety predicate preconditions hold (pg_auth_members rows: 0)\n',
      )
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
  process.stderr.write('[e2e-provision] sealed-export authority roles created\n')

  const options = `-c metasheet.sealed_export_runtime_role=${runtimeRole} -c metasheet.sealed_export_provisioning_role=${provisioningRole}`
  const migrateUrl = new URL(superuserUrl)
  migrateUrl.searchParams.set('options', options)

  // S10 package-mode override. Unset env => byte-identical to before: the repo tree's own
  // `pnpm --filter @metasheet/core-backend run migrate` (tsx over src/db/migrate.ts) in REPO_ROOT.
  // When the e2e lane runs its package-mode leg, the migrations must come from the PACKAGE's own
  // compiled runner (`node packages/core-backend/dist/src/db/migrate.js`, cwd = extracted package root
  // — the same invocation stock-prep-main-package-verify.yml and stock-prep-s6a-postgres17-validation.yml
  // already use), otherwise the "installed package in an isolated runtime" claim would quietly rest on
  // the repo checkout's TypeScript sources for its schema.
  const migrateRoot = process.env.E2E_MIGRATE_ROOT ? path.resolve(process.env.E2E_MIGRATE_ROOT) : REPO_ROOT
  const migrateCmd = (process.env.E2E_MIGRATE_CMD || '').trim() || 'pnpm'
  const migrateArgs = (process.env.E2E_MIGRATE_ARGS || '').trim()
    ? (process.env.E2E_MIGRATE_ARGS || '').trim().split(/\s+/).filter(Boolean)
    : ['--filter', '@metasheet/core-backend', 'run', 'migrate']
  const migrateMode = migrateRoot === REPO_ROOT ? 'repo' : 'package'
  // Values-free: a closed-set token, never the path (which is a runner temp location, not evidence).
  process.stdout.write(`migrateMode=${migrateMode}\n`)

  const exitCode = await new Promise((resolve) => {
    const proc = spawn(migrateCmd, migrateArgs, {
      cwd: migrateRoot,
      env: { ...process.env, DATABASE_URL: migrateUrl.toString() },
      stdio: 'inherit',
    })
    proc.on('close', (code) => resolve(code))
  })
  if (exitCode !== 0) {
    throw new Error(`migration run exited ${exitCode}`)
  }
  process.stderr.write('[e2e-provision] migrations applied with sealed-export roles visible\n')
}

main().catch((error) => {
  process.stderr.write(`[e2e-provision] fatal: ${error && error.message ? error.message : error}\n`)
  process.exitCode = 1
})
