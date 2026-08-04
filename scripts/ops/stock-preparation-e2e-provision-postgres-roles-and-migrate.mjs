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
//   2. runs the ordinary core-backend migration entry point against a connection string carrying both
//      role names via the standard libpq `options` query parameter (`-c name=value`), so every
//      migration — including 073 — sees them from the very first connection.
//
// Env in: PG_SUPERUSER_URL, RUNTIME_ROLE, RUNTIME_PASSWORD, PROVISIONING_ROLE, PROVISIONING_PASSWORD.
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

  const exitCode = await new Promise((resolve) => {
    const proc = spawn('pnpm', ['--filter', '@metasheet/core-backend', 'run', 'migrate'], {
      cwd: REPO_ROOT,
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
