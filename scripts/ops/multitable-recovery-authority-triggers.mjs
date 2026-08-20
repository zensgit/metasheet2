#!/usr/bin/env node

/**
 * Enable / disable the Time Machine recovery-authority triggers — the ladder's trigger-level
 * switch (`docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md` §2 L1 and
 * §5 rollback).
 *
 * `disable` is the BIG RED ROLLBACK: it returns all recovery-authority triggers to the factory
 * inert posture (`tgenabled = 'D'`). `enable` is the L1 step and exists here only so the rollback
 * round-trip can be rehearsed; performing it against a real environment is OWNER-GATED by the
 * ladder — this script grants no authorization and reaches no host by itself.
 *
 * The target set is IMPORTED from `multitable-recovery-schema-containment.mjs`
 * (`EXPECTED_AUTHORITY_TRIGGERS`), which is the single census of record. A second hardcoded copy
 * would be a defect: census and rollback must never be able to diverge.
 *
 * Hard properties:
 *   - all ALTERs run in ONE transaction; a partial application can never persist;
 *   - idempotent (PostgreSQL ALTER TABLE ENABLE/DISABLE TRIGGER is itself idempotent);
 *   - after COMMIT the resulting posture is re-read from pg_trigger and printed as a count.
 *
 * Discretion mirrors the containment helper: it never prints DATABASE_URL, row data, or raw
 * database errors — only schema-metadata identifiers (trigger names) and SQLSTATE codes.
 *
 * Usage:  DATABASE_URL=... node scripts/ops/multitable-recovery-authority-triggers.mjs <enable|disable>
 * Exit:   0 = applied and verified, 1 = posture verification failed, 2 = usage/precondition/DB unavailable
 */

import { createRequire } from 'node:module'

import { EXPECTED_AUTHORITY_TRIGGERS } from './multitable-recovery-schema-containment.mjs'

const requireFromBackend = createRequire(
  new URL('../../packages/core-backend/package.json', import.meta.url),
)

const EXPECTED_TRIGGER_COUNT = 9
const DISABLED = 'D'
// tgenabled letters that mean "this trigger fires": O = origin (the ENABLE default),
// A = always, R = replica. Only 'D' means disabled.
const ENABLED_STATES = new Set(['O', 'A', 'R'])

const VERBS = {
  disable: {
    action: 'DISABLE',
    intent: 'disabled',
    isIntended: (enabled) => enabled === DISABLED,
  },
  enable: {
    action: 'ENABLE',
    intent: 'enabled',
    isIntended: (enabled) => ENABLED_STATES.has(enabled),
  },
}

const USAGE = [
  'usage: DATABASE_URL=... node scripts/ops/multitable-recovery-authority-triggers.mjs <enable|disable>',
  '  disable  return all recovery-authority triggers to the factory inert posture (rollback)',
  '  enable   arm all recovery-authority triggers (ladder L1 — owner-gated)',
].join('\n')

// Identifier shape gate: the census lives in-repo, so a violation here means the census itself
// drifted into something unquotable/malformed. Fail loudly rather than build SQL from it.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/**
 * Derive the ALTER targets from the census. Throws (loudly) if the census is not exactly the
 * expected 9 well-formed, unique triggers.
 */
function resolveTargets(census = EXPECTED_AUTHORITY_TRIGGERS) {
  if (!Array.isArray(census)) {
    throw new Error(
      'recovery-authority trigger census is not an array — refusing to act',
    )
  }
  if (census.length !== EXPECTED_TRIGGER_COUNT) {
    throw new Error(
      `recovery-authority trigger census has ${census.length} entries, expected exactly ${EXPECTED_TRIGGER_COUNT} — census/rollback divergence, refusing to act`,
    )
  }

  const seen = new Set()
  return census.map((entry) => {
    const schemaName = String(entry?.schemaName ?? '')
    const tableName = String(entry?.tableName ?? '')
    const triggerName = String(entry?.triggerName ?? '')
    for (const [label, value] of [
      ['schemaName', schemaName],
      ['tableName', tableName],
      ['triggerName', triggerName],
    ]) {
      if (!IDENTIFIER.test(value)) {
        throw new Error(
          `recovery-authority trigger census entry has a malformed ${label} — refusing to act`,
        )
      }
    }
    const key = `${schemaName}.${tableName}.${triggerName}`
    if (seen.has(key)) {
      throw new Error(
        `recovery-authority trigger census lists ${key} twice — refusing to act`,
      )
    }
    seen.add(key)
    return { schemaName, tableName, triggerName, key }
  })
}

function alterStatement(target, action) {
  return `ALTER TABLE ${quoteIdent(target.schemaName)}.${quoteIdent(
    target.tableName,
  )} ${action} TRIGGER ${quoteIdent(target.triggerName)}`
}

const POSTURE_QUERY = `
  SELECT
    ns.nspname AS schema_name,
    cls.relname AS table_name,
    trg.tgname AS trigger_name,
    trg.tgenabled AS enabled
  FROM pg_catalog.pg_trigger trg
  JOIN pg_catalog.pg_class cls ON cls.oid = trg.tgrelid
  JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
  WHERE NOT trg.tgisinternal
    AND ns.nspname = ANY($1::text[])
    AND cls.relname = ANY($2::text[])
    AND trg.tgname = ANY($3::text[])
`

async function readPosture(client, targets) {
  const result = await client.query(POSTURE_QUERY, [
    [...new Set(targets.map((target) => target.schemaName))],
    [...new Set(targets.map((target) => target.tableName))],
    [...new Set(targets.map((target) => target.triggerName))],
  ])
  const byKey = new Map(
    result.rows.map((row) => [
      `${row.schema_name}.${row.table_name}.${row.trigger_name}`,
      String(row.enabled ?? ''),
    ]),
  )
  return targets.map((target) => ({
    ...target,
    enabled: byKey.has(target.key) ? byKey.get(target.key) : null,
  }))
}

function summarize(posture, verb) {
  const intended = posture.filter((entry) => verb.isIntended(entry.enabled))
  const offenders = posture
    .filter((entry) => !verb.isIntended(entry.enabled))
    .map((entry) =>
      entry.enabled === null
        ? `${entry.key} (absent)`
        : `${entry.key} (tgenabled='${entry.enabled}')`,
    )
  return { intendedCount: intended.length, offenders }
}

function classifyDatabaseError(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const known = {
    '55P03': 'could not acquire the table lock before lock_timeout',
    57014: 'statement timed out',
    '42P01': 'a target table does not exist',
    42704: 'a target trigger does not exist',
    42501: 'insufficient privilege to alter a target table',
    '3D000': 'database does not exist',
    '28P01': 'authentication failed',
    28000: 'authentication failed',
  }[code]
  const detail = known ?? 'connection, permission, or catalog failure'
  return code ? `${detail} (SQLSTATE ${code})` : detail
}

/**
 * Apply the verb to every target inside ONE transaction, then re-read the committed posture.
 * Injected `connect` keeps this unit-testable without a live database.
 */
async function applyAuthorityTriggerVerb({
  databaseUrl,
  verbName,
  targets = resolveTargets(),
  lockTimeoutMs = Number(process.env.RECOVERY_TRIGGER_LOCK_TIMEOUT_MS ?? 15_000),
  statementTimeoutMs = Number(
    process.env.RECOVERY_TRIGGER_STATEMENT_TIMEOUT_MS ?? 60_000,
  ),
  connect,
} = {}) {
  const verb = VERBS[verbName]
  if (!verb) {
    return { exitCode: 2, output: USAGE }
  }
  if (!databaseUrl) {
    return {
      exitCode: 2,
      output:
        'VERDICT: FAIL - recovery-authority trigger change not attempted (DATABASE_URL missing)',
    }
  }

  const openConnection = connect ?? defaultConnect
  let connection
  try {
    connection = await openConnection(databaseUrl)
  } catch {
    return {
      exitCode: 2,
      output:
        'VERDICT: FAIL - recovery-authority trigger change not attempted (database unreachable)',
    }
  }

  const { client, close } = connection
  let committed = false
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = ${Number(lockTimeoutMs)}`)
    await client.query(
      `SET LOCAL statement_timeout = ${Number(statementTimeoutMs)}`,
    )
    for (const target of targets) {
      await client.query(alterStatement(target, verb.action))
    }

    // Verify BEFORE committing: a posture that is not exactly N/N must not be made durable.
    const staged = summarize(await readPosture(client, targets), verb)
    if (staged.intendedCount !== targets.length) {
      await client.query('ROLLBACK')
      return {
        exitCode: 1,
        output: [
          `VERDICT: FAIL - ${verbName} rolled back: only ${staged.intendedCount}/${targets.length} recovery-authority triggers reached the ${verb.intent} state`,
          ...staged.offenders.map(
            (offender) => `  not ${verb.intent}: ${offender}`,
          ),
        ].join('\n'),
      }
    }

    await client.query('COMMIT')
    committed = true

    // Re-read after COMMIT so the printed count reflects durable state, not the transaction's view.
    const settled = summarize(await readPosture(client, targets), verb)
    if (settled.intendedCount !== targets.length) {
      return {
        exitCode: 1,
        output: [
          `VERDICT: FAIL - ${verbName} committed but only ${settled.intendedCount}/${targets.length} recovery-authority triggers are ${verb.intent}`,
          ...settled.offenders.map(
            (offender) => `  not ${verb.intent}: ${offender}`,
          ),
        ].join('\n'),
      }
    }

    return {
      exitCode: 0,
      output: `VERDICT: PASS - ${verbName} applied in one transaction; ${settled.intendedCount}/${targets.length} recovery-authority triggers are ${verb.intent}`,
    }
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => {})
    }
    return {
      exitCode: 2,
      output: `VERDICT: FAIL - ${verbName} not applied, transaction rolled back: ${classifyDatabaseError(error)}`,
    }
  } finally {
    await close().catch(() => {})
  }
}

async function defaultConnect(databaseUrl) {
  const pg = requireFromBackend('pg')
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    application_name: 'metasheet-recovery-authority-triggers',
  })
  let client
  try {
    client = await pool.connect()
  } catch (error) {
    await pool.end().catch(() => {})
    throw error
  }
  return {
    client,
    close: async () => {
      client.release()
      await pool.end()
    },
  }
}

async function runAuthorityTriggerCli({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const args = argv.filter((arg) => arg !== '')
  const verbName = args[0]
  if (args.length !== 1 || !Object.hasOwn(VERBS, verbName)) {
    return { exitCode: 2, output: USAGE }
  }

  let targets
  try {
    targets = resolveTargets()
  } catch (error) {
    return {
      exitCode: 2,
      output: `VERDICT: FAIL - ${error.message}`,
    }
  }

  return applyAuthorityTriggerVerb({
    databaseUrl: String(env.DATABASE_URL ?? '').trim(),
    verbName,
    targets,
  })
}

async function main() {
  const result = await runAuthorityTriggerCli()
  const stream = result.exitCode === 0 ? process.stdout : process.stderr
  stream.write(`${result.output}\n`)
  process.exitCode = result.exitCode
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}

export {
  EXPECTED_TRIGGER_COUNT,
  USAGE,
  VERBS,
  alterStatement,
  applyAuthorityTriggerVerb,
  quoteIdent,
  resolveTargets,
  runAuthorityTriggerCli,
}
