#!/usr/bin/env node

/**
 * Multitable O-2 — the **role-cascade witness** runner.
 *
 * WHY THIS EXISTS
 * ---------------
 * The L1 exercise battery (`scripts/ops/multitable-l1-battery.mjs`) excuses census site
 * `roles:delete` with reason `no-trigger-on-target-table`. That excuse rests on a FACTUAL PREMISE
 * about the target database: deleting a role writes into NO table that carries a recovery-authority
 * trigger, so a `DELETE FROM roles` reaches no triggered table and no 40001 — and therefore no 409 —
 * can be constructed for it.
 *
 * On the local/test schema the premise was verified empirically. On PRODUCTION it is currently only
 * INFERRED-STRONG: it is deduced from the prod migration ledger, which additionally ran the legacy
 * `033_create_rbac_core.sql` — the migration that creates exactly those FKs with `ON DELETE CASCADE`
 * (`role_permissions.role_id` at :17 AND `user_roles.role_id` at :36, each under its own no-op
 * `CREATE TABLE IF NOT EXISTS` on a chain that already created the table, but that is an inference
 * about ORDER, not an observation of the catalog).
 *
 * The premise is a CONJUNCTION, and the query that checks it says so: the foreign key must target
 * the session-resolved `roles` relation, the child table must carry a canonical recovery-authority
 * trigger, and the parent-delete action must actually write the child row. Widening any one conjunct
 * away produces a false ABSENT; narrowing to "cascading role_permissions FK" — which this witness
 * originally did — produced two of them at once. See `ROLE_CASCADE_WITNESS_QUERY`'s docblock in the
 * battery for the full argument, including why `view_permissions` must NOT be counted.
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
 * A DATABASE THAT CARRIES NO CANONICAL RECOVERY-AUTHORITY TRIGGER AT ALL NOW LANDS IN THE THIRD, not
 * the first. This is a change of behaviour, stated rather than slipped in: the widened query's
 * `EXISTS (…)` conjunct makes it structurally incapable of returning a row on such a database, so
 * its zero rows carry no information about the premise — exactly the wrong-target ambiguity the
 * presence control exists to refuse. The `relations_absent` detail names which half was missing so a
 * single dispatch is enough to diagnose it.
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
import { ROLES_RELATION_PRESENT_SQL, ROLE_CASCADE_WITNESS_QUERY, describeRoleCascadeRow, roleDeleteCascadeExists, roleDeleteChildWrites } from './multitable-l1-battery.mjs'
import { AUTHORITY_TRIGGER_FUNCTIONS } from './multitable-recovery-schema-containment.mjs'

/**
 * Line prefix of the probe↔runner wire protocol. Bumped if the shape ever changes.
 *
 * /2 (2026-08-24): ROWS grew `child_schema` + `child_table` (the witness no longer inspects a single
 * hard-coded child table, so a row without its identity is unauditable) and PRESENCE changed shape
 * to match the widened query's relation set. A /1 capture no longer parses at all — it lands in
 * `observation_incomplete` → INDETERMINATE, never in ABSENT.
 */
export const PROTOCOL = 'ROLE-CASCADE-WITNESS/2'

/** The canonical trigger functions, as a SQL literal list — same census the battery's query uses. */
const RECOVERY_AUTHORITY_TRIGGER_FUNCTION_SQL_LIST = AUTHORITY_TRIGGER_FUNCTIONS
  .map((name) => `'${name}'`)
  .join(', ')

/**
 * Positive control, not scope creep.
 *
 * `ROLE_CASCADE_WITNESS_QUERY` answers "which foreign keys write a recovery-authority-triggered
 * child of `roles` when a role is deleted"; on a database that has no `roles` relation the session
 * can resolve, or no recovery-authority triggers at all, it answers "none" — which would read as
 * ABSENT/CONFIRMED while actually meaning "we are looking at the wrong database". A witness whose
 * CONFIRMED verdict is indistinguishable from a wrong-target dispatch is not a witness.
 *
 * COUPLED TO THE QUERY IT GUARDS — narrow one and you MUST narrow the other. Both halves of the
 * relation set the query consults are counted here, resolved the SAME way the query resolves them:
 *
 *   • `roles_relations` — `to_regclass('roles')`, session-resolved through `search_path`, exactly as
 *     `con.confrelid = to_regclass('roles')` resolves it. Deliberately UNQUALIFIED: a hard-coded
 *     `public.` literal would blind every real-DB golden this repo runs in a per-run random schema.
 *     `relkind IN ('r','p')` because `con.confrelid` can only ever be an ordinary or partitioned
 *     table — without it, a VIEW named `roles` would report presence for a query that returns zero.
 *   • `recovery_authority_relations` — how many relations carry a canonical recovery-authority
 *     trigger. This is the set the query's `EXISTS (…)` conjunct can match; if it is empty the query
 *     is STRUCTURALLY incapable of returning a row, so zero rows carries no information about the
 *     premise.
 *
 * `roles_referencing_fks` is AUDIT-ONLY and decides nothing: it counts every FK pointing at `roles`,
 * including ones on tables that carry no recovery-authority trigger (e.g. `view_permissions`, whose
 * FK `20250925_create_view_tables.sql:261` adds conditionally). Publishing it means the summary can
 * show that such FKs were SEEN AND EXCLUDED, rather than leaving the exclusion invisible — without
 * ever letting the count near the decision path, where it would manufacture a false PRESENT.
 */
export const RELATION_PRESENCE_QUERY = `
  SELECT
    (CASE WHEN ${ROLES_RELATION_PRESENT_SQL} THEN 1 ELSE 0 END) AS roles_relations,
    (
      SELECT count(DISTINCT trg.tgrelid)
      FROM pg_catalog.pg_trigger trg
      JOIN pg_catalog.pg_proc prc ON prc.oid = trg.tgfoid
      WHERE NOT trg.tgisinternal
        AND prc.proname IN (${RECOVERY_AUTHORITY_TRIGGER_FUNCTION_SQL_LIST})
    ) AS recovery_authority_relations,
    (
      SELECT count(*)
      FROM pg_catalog.pg_constraint fk
      WHERE fk.contype = 'f'
        AND fk.confrelid = to_regclass('roles')
    ) AS roles_referencing_fks
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
      recovery_authority_relations: Number(p.recovery_authority_relations),
      roles_referencing_fks: Number(p.roles_referencing_fks),
    }))
    emit(PROTO + ' ROWS ' + JSON.stringify(((witness && witness.rows) || []).map(function (row) {
      return {
        child_schema: String(row.child_schema),
        child_table: String(row.child_table),
        conname: String(row.conname),
        confdeltype: String(row.confdeltype),
      }
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
 * @returns {{ ok: true,
 *             rows: {child_schema: string, child_table: string, conname: string, confdeltype: string}[],
 *             presence: {roles: number, recovery_authority_relations: number, roles_referencing_fks: number} }
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
    child_schema: String(row.child_schema ?? ''),
    child_table: String(row.child_table ?? ''),
    conname: String(row.conname ?? ''),
    confdeltype: String(row.confdeltype ?? ''),
  }))
  // Every field is load-bearing: the verdict is only auditable if each row names WHICH relation, in
  // WHICH schema, was written by WHICH action. A row missing any of them is an unreadable
  // observation, not a readable observation of nothing.
  if (normalisedRows.some((row) => row.child_schema === '' || row.child_table === '' || row.conname === '' || row.confdeltype === '')) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'a ROWS entry is missing child_schema, child_table, conname or confdeltype' }
  }

  if (!presence || typeof presence !== 'object' || Array.isArray(presence)) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'PRESENCE payload is not an object' }
  }
  const rolesCount = Number(presence.roles)
  const triggeredRelationCount = Number(presence.recovery_authority_relations)
  const rolesReferencingFkCount = Number(presence.roles_referencing_fks)
  if (!Number.isFinite(rolesCount) || !Number.isFinite(triggeredRelationCount) || !Number.isFinite(rolesReferencingFkCount)) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'PRESENCE counts are not numbers' }
  }
  // Positive control: zero rows from a database the query cannot even reach into is not evidence of
  // absence, it is evidence we observed the wrong database. Both halves of the query's relation set
  // are required, and the detail names WHICH half was missing so a first dispatch is diagnosable.
  if (rolesCount < 1 || triggeredRelationCount < 1) {
    const missing = []
    if (rolesCount < 1) missing.push("no session-resolvable `roles` table (to_regclass('roles') found none)")
    if (triggeredRelationCount < 1) missing.push('no relation carries a canonical recovery-authority trigger')
    return {
      ok: false,
      reason: INDETERMINATE_REASONS.relationsAbsent,
      detail: `the observed database cannot answer this question — ${missing.join('; ')} (roles=${rolesCount}, recovery_authority_relations=${triggeredRelationCount}); zero rows there is not evidence of absence`,
    }
  }

  return {
    ok: true,
    rows: normalisedRows,
    presence: {
      roles: rolesCount,
      recovery_authority_relations: triggeredRelationCount,
      roles_referencing_fks: rolesReferencingFkCount,
    },
  }
}

/**
 * Turn a parse result into the three-way verdict.
 *
 * The classification of the ROWS is delegated to `roleDeleteCascadeExists` — the battery's own
 * predicate — so `confdeltype 'a'` (NO ACTION) and `'r'` (RESTRICT), which refuse the parent delete
 * rather than write the child, can never be mistaken for a child write by a naive "is there any
 * FK?" reading, and `'n'` (SET NULL) / `'d'` (SET DEFAULT), which DO write the child, are not
 * mistaken for absence by a naive "is it CASCADE?" reading.
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
    // Name WHAT refuted the premise, not merely THAT something did. The offending rows come from
    // the battery's own predicate (`roleDeleteChildWrites`, which `roleDeleteCascadeExists` is
    // defined in terms of), so this list can never disagree with the branch above it.
    const offenders = roleDeleteChildWrites(parsed.rows).map((row) => describeRoleCascadeRow(row)).join('; ')
    return {
      verdict: 'PRESENT',
      premise: 'REFUTED',
      headline: HEADLINES.PRESENT,
      exitCode: 1,
      reason: 'cascading_fk_observed',
      detail: `deleting a role on this database writes into a recovery-authority-triggered table: ${offenders}`,
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
    detail: 'no foreign key writes a recovery-authority-triggered child of `roles` when a role is deleted on this database',
    rows: parsed.rows,
    presence: parsed.presence,
  }
}

function rowsTable(rows) {
  if (rows.length === 0) {
    return '_no foreign key from a recovery-authority-triggered table to `roles` was returned by the witness query_'
  }
  const header = '| child schema | child table | conname | confdeltype | meaning |\n| --- | --- | --- | --- | --- |'
  // Display only — this map decides nothing. The verdict is `roleDeleteCascadeExists`'s alone; this
  // exists so a reader of the summary does not have to know pg's parent-delete action letters.
  const meanings = { c: 'CASCADE', a: 'NO ACTION', r: 'RESTRICT', n: 'SET NULL', d: 'SET DEFAULT' }
  const body = rows
    .map((row) => `| \`${row.child_schema}\` | \`${row.child_table}\` | \`${row.conname}\` | \`${row.confdeltype}\` | ${meanings[row.confdeltype] ?? 'unknown'} |`)
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
    lines.push(
      `- relation presence (positive control): roles=${verdict.presence.roles},`
      + ` recovery_authority_relations=${verdict.presence.recovery_authority_relations}`,
    )
    // Audit-only, and labelled as such: it makes the NARROWING visible. A database can carry FKs
    // pointing at `roles` from tables that have no recovery-authority trigger (view_permissions is
    // the known one); those are seen, counted here, and deliberately excluded from the verdict.
    lines.push(
      `- foreign keys referencing \`roles\` (audit only, decides nothing):`
      + ` ${verdict.presence.roles_referencing_fks} in total,`
      + ` ${verdict.rows.length} on a table carrying a recovery-authority trigger`
      + ' (the rest cannot fire one and are excluded from the verdict)',
    )
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
      'Deleting a role on the observed database writes into no table that carries a'
      + ' recovery-authority trigger — no foreign key from such a table to `roles` carries CASCADE,'
      + ' SET NULL or SET DEFAULT — so the L1 battery\'s `roles:delete` NOT-DRIVEN excuse'
      + ' (`no-trigger-on-target-table`) still holds there. The premise moves from INFERRED-STRONG'
      + ' to **CONFIRMED** for this target.',
    )
  } else if (verdict.verdict === 'PRESENT') {
    lines.push(
      'Deleting a role on the observed database WRITES INTO a recovery-authority-triggered table'
      + ' (see the rows above: CASCADE deletes the child row, SET NULL and SET DEFAULT update it —'
      + ' all three fire a `BEFORE INSERT OR UPDATE OR DELETE` trigger). The `roles:delete` excuse'
      + ' has stopped being true there: the battery re-checks this premise at runtime and would exit'
      + ' 1 with `not_driven_reason_expired`, refusing to produce evidence. Amendment A1\'s'
      + ' production-inheritance clause does not hold for this target as written.',
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
