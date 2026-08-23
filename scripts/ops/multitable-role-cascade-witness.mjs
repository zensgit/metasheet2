#!/usr/bin/env node

/**
 * Multitable O-2 — the **role-cascade witness** runner.
 *
 * WHY THIS EXISTS
 * ---------------
 * The L1 exercise battery (`scripts/ops/multitable-l1-battery.mjs`) excuses census site
 * `roles:delete` with reason `no-trigger-on-target-table`. That excuse rests on a FACTUAL PREMISE
 * about the target database: no cascading `role_permissions → roles` foreign key exists, so a
 * `DELETE FROM roles` reaches no triggered table and no 40001 — and therefore no 409 — can be
 * constructed for it.
 *
 * On the local/test schema the premise was verified empirically. On PRODUCTION it is currently only
 * INFERRED-STRONG: it is deduced from the prod migration ledger, which additionally ran the legacy
 * `033_create_rbac_core.sql` — the migration that creates exactly that FK with `ON DELETE CASCADE`
 * (a no-op `CREATE TABLE IF NOT EXISTS` on a chain that already created the table, but that is an
 * inference about ORDER, not an observation of the catalog).
 *
 * The battery does not take the excuse on trust: it RE-CHECKS the premise at runtime and, if the
 * cascade does exist, exits 1 with `not_driven_reason_expired` and refuses to produce any evidence
 * at all. So a refuted premise would invalidate amendment A1's production-inheritance clause. This
 * runner turns INFERRED-STRONG into CONFIRMED (or REFUTED) with a single catalog-only read.
 *
 * ONE DEFINITION, TWO ENDS
 * ------------------------
 * There must remain exactly ONE definition of "what counts as the cascade". This module NEVER
 * re-types the SQL and NEVER re-implements the predicate; it imports both from the battery:
 *
 *   • `ROLE_CASCADE_WITNESS_QUERY` is embedded verbatim into the probe program that runs on the
 *     target host, so the host executes the same text the battery would execute.
 *   • `roleDeleteCascadeExists` classifies the observed rows back on the CI runner, so the verdict
 *     is computed by the same predicate the battery branches on.
 *
 * The probe carries NO cascade logic of its own — it only observes and reports. A second, narrower
 * copy of either half is the failure mode this arrangement exists to prevent.
 *
 * WHY THE PROBE IS GENERATED HERE RATHER THAN EXEC'D FROM THE IMAGE
 * ----------------------------------------------------------------
 * `.github/workflows/multitable-recovery-flag-containment-check.yml` runs its schema helper by
 * `docker exec`-ing a file that must already be baked into the deployed image, gated on that file's
 * exact sha256. Production runs an OLDER image that predates this witness, so that path cannot
 * observe production today. Generating the probe on the runner from the reviewed checkout makes the
 * witness independent of what happens to be deployed — and binds it to the reviewed source.
 *
 * FAIL-CLOSED: "NOTHING OBSERVED" IS NEVER "NO CASCADE"
 * ----------------------------------------------------
 * Three outcomes, kept explicitly distinct — a missing container, an unreadable DATABASE_URL, a
 * failed query, an unparseable result, or a database that does not even have the two relations all
 * land in the third, never the first:
 *
 *   ABSENT        → premise CONFIRMED   (exit 0)
 *   PRESENT       → premise REFUTED     (exit 1)  the battery would exit 1 not_driven_reason_expired
 *   INDETERMINATE → failed to observe   (exit 2)
 *
 * Usage:
 *   node scripts/ops/multitable-role-cascade-witness.mjs emit-probe
 *   node scripts/ops/multitable-role-cascade-witness.mjs verdict <observation-file> [--target X] [--out FILE]
 *
 * The module graph stays node_modules-free at the top level (the hermetic O-2 kit lane runs
 * `node --test` with no `pnpm install`); `pg` is reached lazily, inside the generated probe, on the
 * target host only.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { ROLE_CASCADE_WITNESS_QUERY, roleDeleteCascadeExists } from './multitable-l1-battery.mjs'

/** Line prefix of the probe↔runner wire protocol. Bumped if the shape ever changes. */
export const PROTOCOL = 'ROLE-CASCADE-WITNESS/1'

/**
 * Positive control, not scope creep.
 *
 * `ROLE_CASCADE_WITNESS_QUERY` answers "which cascading FKs are there"; on a database that has no
 * `role_permissions` relation at all it answers "none" — which would read as ABSENT/CONFIRMED while
 * actually meaning "we are looking at the wrong database". A witness whose CONFIRMED verdict is
 * indistinguishable from a wrong-target dispatch is not a witness. Both relations must be observed
 * before any verdict on the cascade is admitted.
 *
 * Deliberately schema-UNQUALIFIED, matching the witness query's own `child.relname = '…'` /
 * `parent.relname = '…'` shape — a presence check narrower than the query it guards would pass on a
 * database the query still reads.
 */
export const RELATION_PRESENCE_QUERY = `
  SELECT
    (SELECT count(*) FROM pg_catalog.pg_class WHERE relname = 'roles' AND relkind = 'r') AS roles_relations,
    (SELECT count(*) FROM pg_catalog.pg_class WHERE relname = 'role_permissions' AND relkind = 'r') AS role_permissions_relations
`

/** Verdict headlines. Exact strings — the workflow summary and its tests both pin these. */
export const HEADLINES = Object.freeze({
  ABSENT: 'CASCADE ABSENT (premise CONFIRMED)',
  PRESENT: 'CASCADE PRESENT (premise REFUTED — battery would exit 1 not_driven_reason_expired)',
  INDETERMINATE: 'INDETERMINATE (failed to observe)',
})

/**
 * Distinct INDETERMINATE reasons. One undifferentiated "failed" would make a first dispatch that
 * died on module resolution indistinguishable from one that could not reach the database, costing a
 * whole second round-trip to diagnose.
 */
export const INDETERMINATE_REASONS = Object.freeze({
  observationMissing: 'observation_missing',
  observationEmpty: 'observation_empty',
  probeError: 'probe_error',
  incomplete: 'observation_incomplete',
  unparseable: 'observation_unparseable',
  relationsAbsent: 'relations_absent',
})

/**
 * The program that runs on the target host, inside the backend container.
 *
 * CommonJS on purpose: `node -e` evaluates as CommonJS, and `require` is unambiguous CJS syntax, so
 * this behaves identically whether or not the container's node auto-detects module type.
 *
 * READ-ONLY BY CONSTRUCTION: the only statements it issues are the two catalog SELECTs below, both
 * against `pg_catalog`. It reads DATABASE_URL from the container's own environment and never prints
 * it — every diagnostic is routed through `redact()`, which strips URI-shaped substrings, so a
 * connection error carrying credentials cannot leak into the job log or the uploaded artifact.
 */
export function buildProbeSource() {
  return `'use strict'
// GENERATED by scripts/ops/multitable-role-cascade-witness.mjs — do not edit by hand.
// The SQL below is embedded verbatim from ROLE_CASCADE_WITNESS_QUERY in
// scripts/ops/multitable-l1-battery.mjs. There is exactly ONE definition of it.
const PROTO = ${JSON.stringify(PROTOCOL)}
const WITNESS_SQL = ${JSON.stringify(ROLE_CASCADE_WITNESS_QUERY)}
const PRESENCE_SQL = ${JSON.stringify(RELATION_PRESENCE_QUERY)}

function emit(line) {
  process.stdout.write(String(line) + '\\n')
}

// Never let a database URL (or anything URI-shaped) reach stdout.
function redact(value) {
  return String(value == null ? '' : value)
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^\\s'"]*/g, '<redacted-uri>')
    .replace(/\\s+/g, ' ')
    .slice(0, 300)
}

function fail(code, detail) {
  emit(PROTO + ' ERROR ' + code + ' ' + redact(detail))
  emit(PROTO + ' END error')
  process.exitCode = 3
}

function loadPg() {
  const { createRequire } = require('node:module')
  const path = require('node:path')
  const attempts = [
    function () { return require('pg') },
    function () { return createRequire(path.join(process.cwd(), 'packages/core-backend/package.json'))('pg') },
    function () { return createRequire('/app/packages/core-backend/package.json')('pg') },
  ]
  let last = null
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      return attempts[i]()
    } catch (error) {
      last = error
    }
  }
  throw last || new Error('pg could not be resolved')
}

async function main() {
  emit(PROTO + ' BEGIN')
  const url = process.env.DATABASE_URL
  if (!url) {
    return fail('database_url_unreadable', 'DATABASE_URL is unset or empty inside this container')
  }
  let pg
  try {
    pg = loadPg()
  } catch (error) {
    return fail('pg_load_failed', error && error.message)
  }
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
  } catch (error) {
    return fail('connect_failed', error && error.message)
  }
  try {
    const presence = await client.query(PRESENCE_SQL)
    const witness = await client.query(WITNESS_SQL)
    const p = (presence && presence.rows && presence.rows[0]) || {}
    emit(PROTO + ' PRESENCE ' + JSON.stringify({
      roles: Number(p.roles_relations),
      role_permissions: Number(p.role_permissions_relations),
    }))
    emit(PROTO + ' ROWS ' + JSON.stringify(((witness && witness.rows) || []).map(function (row) {
      return { conname: String(row.conname), confdeltype: String(row.confdeltype) }
    })))
    emit(PROTO + ' END ok')
  } catch (error) {
    return fail('query_failed', error && error.message)
  } finally {
    try {
      await client.end()
    } catch (error) {
      /* closing a read-only connection cannot invalidate what was already observed */
    }
  }
}

main().catch(function (error) {
  fail('probe_crashed', error && error.message)
})
`
}

function protocolLines(text, keyword) {
  const prefix = `${PROTOCOL} ${keyword}`
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
}

/**
 * Parse a captured observation.
 *
 * Strict on purpose. Every shape that is not a complete, well-formed, positively-controlled
 * observation returns `{ ok: false }` with a distinct reason — the caller turns that into
 * INDETERMINATE, never into ABSENT.
 *
 * @returns {{ ok: true, rows: {conname: string, confdeltype: string}[], presence: {roles: number, role_permissions: number} }
 *          | { ok: false, reason: string, detail: string }}
 */
export function parseWitnessObservation(text) {
  const raw = String(text ?? '')
  if (raw.trim() === '') {
    return { ok: false, reason: INDETERMINATE_REASONS.observationEmpty, detail: 'the captured observation is empty' }
  }

  const errors = protocolLines(raw, 'ERROR')
  if (errors.length > 0) {
    return {
      ok: false,
      reason: INDETERMINATE_REASONS.probeError,
      detail: errors.map((line) => line.slice(`${PROTOCOL} ERROR `.length)).join('; '),
    }
  }

  const ends = protocolLines(raw, 'END')
  const okEnds = ends.filter((line) => line === `${PROTOCOL} END ok`)
  if (okEnds.length !== 1) {
    return {
      ok: false,
      reason: INDETERMINATE_REASONS.incomplete,
      detail: `expected exactly one '${PROTOCOL} END ok' terminator, found ${okEnds.length} (${ends.length} END line(s) total)`,
    }
  }

  const presenceLines = protocolLines(raw, 'PRESENCE')
  const rowsLines = protocolLines(raw, 'ROWS')
  if (presenceLines.length !== 1 || rowsLines.length !== 1) {
    return {
      ok: false,
      reason: INDETERMINATE_REASONS.incomplete,
      detail: `expected exactly one PRESENCE line and one ROWS line, found ${presenceLines.length} and ${rowsLines.length}`,
    }
  }

  let presence
  let rows
  try {
    presence = JSON.parse(presenceLines[0].slice(`${PROTOCOL} PRESENCE `.length))
    rows = JSON.parse(rowsLines[0].slice(`${PROTOCOL} ROWS `.length))
  } catch (error) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: `payload is not valid JSON: ${error.message}` }
  }

  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'ROWS payload is not an array of objects' }
  }
  const normalisedRows = rows.map((row) => ({
    conname: String(row.conname ?? ''),
    confdeltype: String(row.confdeltype ?? ''),
  }))
  if (normalisedRows.some((row) => row.conname === '' || row.confdeltype === '')) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'a ROWS entry is missing conname or confdeltype' }
  }

  if (!presence || typeof presence !== 'object' || Array.isArray(presence)) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'PRESENCE payload is not an object' }
  }
  const rolesCount = Number(presence.roles)
  const rolePermissionsCount = Number(presence.role_permissions)
  if (!Number.isFinite(rolesCount) || !Number.isFinite(rolePermissionsCount)) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'PRESENCE counts are not numbers' }
  }
  // Positive control: zero rows from a database that has neither relation is not evidence of
  // absence, it is evidence we observed the wrong database.
  if (rolesCount < 1 || rolePermissionsCount < 1) {
    return {
      ok: false,
      reason: INDETERMINATE_REASONS.relationsAbsent,
      detail: `the observed database does not carry both relations (roles=${rolesCount}, role_permissions=${rolePermissionsCount}); zero cascading FKs there is not evidence of absence`,
    }
  }

  return { ok: true, rows: normalisedRows, presence: { roles: rolesCount, role_permissions: rolePermissionsCount } }
}

/**
 * Turn a parse result into the three-way verdict.
 *
 * The classification of the ROWS is delegated to `roleDeleteCascadeExists` — the battery's own
 * predicate — so `confdeltype 'a'` (NO ACTION) and `'r'` (RESTRICT) can never be mistaken for a
 * cascade by a naive "is there any FK?" reading.
 */
export function classifyObservation(parsed) {
  if (!parsed || parsed.ok !== true) {
    // FAIL-CLOSED. An observation we could not read is NOT an observation of absence. Returning
    // ABSENT here would silently manufacture the CONFIRMED verdict this whole exercise exists to
    // earn honestly.
    return {
      verdict: 'INDETERMINATE',
      premise: 'NOT OBSERVED',
      headline: HEADLINES.INDETERMINATE,
      exitCode: 2,
      reason: parsed?.reason ?? INDETERMINATE_REASONS.unparseable,
      detail: parsed?.detail ?? 'no parse result',
      rows: [],
      presence: null,
    }
  }
  if (roleDeleteCascadeExists(parsed.rows)) {
    return {
      verdict: 'PRESENT',
      premise: 'REFUTED',
      headline: HEADLINES.PRESENT,
      exitCode: 1,
      reason: 'cascading_fk_observed',
      detail: 'a role_permissions → roles foreign key with ON DELETE CASCADE exists on this database',
      rows: parsed.rows,
      presence: parsed.presence,
    }
  }
  return {
    verdict: 'ABSENT',
    premise: 'CONFIRMED',
    headline: HEADLINES.ABSENT,
    exitCode: 0,
    reason: 'no_cascading_fk',
    detail: 'no role_permissions → roles foreign key carries ON DELETE CASCADE on this database',
    rows: parsed.rows,
    presence: parsed.presence,
  }
}

function rowsTable(rows) {
  if (rows.length === 0) {
    return '_no `role_permissions` → `roles` foreign-key rows returned by the witness query_'
  }
  const header = '| conname | confdeltype | meaning |\n| --- | --- | --- |'
  // Display only — this map decides nothing. The verdict is `roleDeleteCascadeExists`'s alone; this
  // exists so a reader of the summary does not have to know pg's ON DELETE action letters.
  const meanings = { c: 'CASCADE', a: 'NO ACTION', r: 'RESTRICT', n: 'SET NULL', d: 'SET DEFAULT' }
  const body = rows
    .map((row) => `| \`${row.conname}\` | \`${row.confdeltype}\` | ${meanings[row.confdeltype] ?? 'unknown'} |`)
    .join('\n')
  return `${header}\n${body}`
}

/** Markdown for `$GITHUB_STEP_SUMMARY` and the uploaded artifact. */
export function renderSummary(verdict, { target = 'unknown' } = {}) {
  const lines = []
  lines.push('## Multitable role-cascade witness')
  lines.push('')
  lines.push(`**${verdict.headline}**`)
  lines.push('')
  lines.push(`- target: \`${target}\``)
  lines.push(`- verdict: \`${verdict.verdict}\``)
  lines.push(`- premise (\`roles:delete\` excused as \`no-trigger-on-target-table\`): **${verdict.premise}**`)
  lines.push(`- reason: \`${verdict.reason}\``)
  if (verdict.detail) lines.push(`- detail: ${verdict.detail}`)
  if (verdict.presence) {
    lines.push(`- relation presence (positive control): roles=${verdict.presence.roles}, role_permissions=${verdict.presence.role_permissions}`)
  }
  lines.push('')
  lines.push('### Raw rows observed')
  lines.push('')
  lines.push(rowsTable(verdict.rows))
  lines.push('')
  lines.push('### What this means')
  lines.push('')
  if (verdict.verdict === 'ABSENT') {
    lines.push(
      'No cascading `role_permissions` → `roles` foreign key exists on the observed database, so the'
      + ' L1 battery\'s `roles:delete` NOT-DRIVEN excuse (`no-trigger-on-target-table`) still holds'
      + ' there. The premise moves from INFERRED-STRONG to **CONFIRMED** for this target.',
    )
  } else if (verdict.verdict === 'PRESENT') {
    lines.push(
      'A cascading `role_permissions` → `roles` foreign key EXISTS on the observed database. The'
      + ' `roles:delete` excuse has stopped being true there: the battery re-checks this premise at'
      + ' runtime and would exit 1 with `not_driven_reason_expired`, refusing to produce evidence.'
      + ' Amendment A1\'s production-inheritance clause does not hold for this target as written.',
    )
  } else {
    lines.push(
      'The witness did not observe the database. This is **not** a finding of "no cascade" — it is'
      + ' the absence of a finding. Nothing about the premise may be inherited from this run.',
    )
  }
  lines.push('')
  lines.push(
    '_Read-only by construction: the only remote operations are `docker ps` and one `docker exec`'
    + ' running catalog-only `SELECT`s against `pg_catalog`. No writes, no restarts, no config edits,'
    + ' no migrations. DATABASE_URL is read inside the container and never printed._',
  )
  lines.push('')
  return lines.join('\n')
}

function readObservation(path) {
  try {
    return { text: readFileSync(path, 'utf8') }
  } catch (error) {
    return { missing: true, detail: `${error.code ?? 'read failed'}: ${path}` }
  }
}

/**
 * The `verdict` subcommand as a pure-ish function (filesystem in, verdict out) so the tests can
 * drive the whole path, not just the predicate.
 */
export function runVerdict({ observationPath, target = 'unknown' }) {
  const read = readObservation(observationPath)
  const parsed = read.missing
    ? { ok: false, reason: INDETERMINATE_REASONS.observationMissing, detail: read.detail }
    : parseWitnessObservation(read.text)
  const verdict = classifyObservation(parsed)
  return { verdict, summary: renderSummary(verdict, { target }) }
}

function usage() {
  return [
    'usage:',
    '  node scripts/ops/multitable-role-cascade-witness.mjs emit-probe',
    '  node scripts/ops/multitable-role-cascade-witness.mjs verdict <observation-file> [--target NAME] [--out FILE]',
  ].join('\n')
}

async function main(argv) {
  const [command, ...rest] = argv
  if (command === 'emit-probe') {
    process.stdout.write(buildProbeSource())
    return 0
  }
  if (command === 'verdict') {
    const positional = rest.filter((arg) => !arg.startsWith('--'))
    const observationPath = positional[0]
    if (!observationPath) {
      process.stderr.write(`missing <observation-file>\n${usage()}\n`)
      return 2
    }
    const flag = (name) => {
      const index = rest.indexOf(`--${name}`)
      return index >= 0 ? rest[index + 1] : undefined
    }
    const target = flag('target') ?? 'unknown'
    const out = flag('out')
    const { verdict, summary } = runVerdict({ observationPath, target })

    process.stdout.write(`${summary}\n`)
    if (out) writeFileSync(out, summary)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
    // The workflow annotation mirrors the exit code so the run list is readable without opening
    // the summary.
    const annotation = verdict.exitCode === 0 ? 'notice' : 'error'
    process.stdout.write(`::${annotation}::role-cascade witness [${target}] — ${verdict.headline} (${verdict.reason})\n`)
    return verdict.exitCode
  }
  process.stderr.write(`${usage()}\n`)
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2))
}
