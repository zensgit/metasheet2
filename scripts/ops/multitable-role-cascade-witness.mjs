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
 * the CANONICALLY-bound `roles` relation, the child table must carry a canonical recovery-authority
 * trigger, and the parent-delete action must actually write the child row. Widening any one conjunct
 * away produces a false ABSENT; narrowing to "cascading role_permissions FK" — which this witness
 * originally did — produced two of them at once. See `buildRoleCascadeWitnessQuery`'s docblock in the
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
 *   • `buildRoleCascadeWitnessQuery` is embedded verbatim into the probe program that runs on the
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
 * INDETERMINATE carries exit code 2 and the dispatch FAILS. It IS a failure of the evidence gate —
 * legitimate and diagnosable (`INDETERMINATE_REASONS` discriminates, so one dispatch is enough to
 * say which half broke), but it must never be described as "not a failure": a run that ends there
 * yields no evidence and nothing about the premise may be inherited from it.
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
import { CANONICAL_ROLES_SCHEMA, FK_DELETE_ACTION_LETTERS, ROLE_CASCADE_BINDING_DOORS, buildRoleCascadeBindingSql, buildRoleCascadeWitnessQuery, classifyRoleCascadeBinding, describeRoleCascadeRow, readCatalogCount, roleDeleteCascadeExists, roleDeleteChildWrites } from './multitable-l1-battery.mjs'
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
 * `buildRoleCascadeWitnessQuery` answers "which foreign keys write a recovery-authority-triggered
 * child of `roles` when a role is deleted". On a database that is not the one we think we are
 * observing it answers "none" — which would read as ABSENT/CONFIRMED while actually meaning "we
 * looked somewhere else". A witness whose CONFIRMED verdict is indistinguishable from a wrong-target
 * dispatch is not a witness.
 *
 * DELIBERATELY NOT COUPLED TO THE QUERY'S OWN RESOLUTION — that coupling WAS the defect. The
 * control used to resolve `roles` the same way the query did (`to_regclass('roles')`, through the
 * session's `search_path`), so a decoy reached first satisfied the control AND retargeted the query,
 * and the two failed together. Everything published here is now bound to the canonical schema, and
 * the session's own resolution appears only as something to DISAGREE with.
 *
 *   • `canonical_roles_present` / `session_binds_canonical` / `session_roles_schema` /
 *     `visible_roles_relations` — the binding, and whether this session agrees with it.
 *   • `canonical_exact_carriers` — how many of the census's EXACT carrier identities (carrier
 *     table, trigger name, and function schema AND name) are present in the canonical schema. This
 *     is the control the verdict depends on. Counting carriers loosely — by function NAME and
 *     carrier schema only — let a trigger calling `evil.metasheet_recovery_authority_user_trigger`
 *     from another schema satisfy it on a catalog whose recovery-authority surface is not the
 *     canonical one.
 *   • `recovery_authority_relations` — the loose carrier count, kept AUDIT-ONLY since the exact
 *     control took over the decision, so a summary reader can see the gap between "something that
 *     looks like a carrier" and "a census identity".
 *
 * The doors themselves are NOT implemented here: `classifyRoleCascadeBinding` in the battery module
 * is the one implementation, shared with the battery's own preflight so the two cannot drift.
 *
 * `roles_referencing_fks` is AUDIT-ONLY and decides nothing: it counts every FK pointing at `roles`,
 * including ones on tables that carry no recovery-authority trigger (e.g. `view_permissions`, whose
 * FK `20250925_create_view_tables.sql:261` adds conditionally). Publishing it means the summary can
 * show that such FKs were SEEN AND EXCLUDED, rather than leaving the exclusion invisible — without
 * ever letting the count near the decision path, where it would manufacture a false PRESENT.
 */
export function buildRelationPresenceQuery(canonicalSchema) {
  const binding = buildRoleCascadeBindingSql(canonicalSchema)
  return `
  SELECT
    ${binding.canonicalRolesPresentSql} AS canonical_roles_present,
    ${binding.sessionBindsCanonicalSql} AS session_binds_canonical,
    ${binding.sessionRolesSchemaSql} AS session_roles_schema,
    ${binding.visibleRolesRelationsSql} AS visible_roles_relations,
    ${binding.canonicalExactCarriersSql} AS canonical_exact_carriers,
    ${binding.canonicalTriggerCarriersSql} AS recovery_authority_relations,
    ${binding.rolesReferencingFksSql} AS roles_referencing_fks
`
}

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
  canonicalRelationAbsent: 'canonical_relation_absent',
  bindingMismatch: 'binding_mismatch',
  relationAmbiguous: 'relation_ambiguous',
})

/**
 * Door -> reason, as DATA rather than a chain of `if`s, so a door added to the shared classifier
 * without a reason here fails loudly (`undefined` reason) instead of silently degrading to ABSENT.
 */
const DOOR_TO_INDETERMINATE_REASON = Object.freeze({
  [ROLE_CASCADE_BINDING_DOORS.canonicalRelationAbsent]: INDETERMINATE_REASONS.canonicalRelationAbsent,
  [ROLE_CASCADE_BINDING_DOORS.bindingMismatch]: INDETERMINATE_REASONS.bindingMismatch,
  [ROLE_CASCADE_BINDING_DOORS.relationAmbiguous]: INDETERMINATE_REASONS.relationAmbiguous,
  [ROLE_CASCADE_BINDING_DOORS.relationsAbsent]: INDETERMINATE_REASONS.relationsAbsent,
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
export function buildProbeSource(canonicalSchema = CANONICAL_ROLES_SCHEMA) {
  return `'use strict'
// GENERATED by scripts/ops/multitable-role-cascade-witness.mjs — do not edit by hand.
// The SQL below is embedded verbatim from buildRoleCascadeWitnessQuery in
// scripts/ops/multitable-l1-battery.mjs. There is exactly ONE definition of it.
const PROTO = ${JSON.stringify(PROTOCOL)}
const CANONICAL_SCHEMA = ${JSON.stringify(buildRoleCascadeBindingSql(canonicalSchema).schema)}
const WITNESS_SQL = ${JSON.stringify(buildRoleCascadeWitnessQuery(canonicalSchema))}
const PRESENCE_SQL = ${JSON.stringify(buildRelationPresenceQuery(canonicalSchema))}

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
      canonical_schema: CANONICAL_SCHEMA,
      canonical_roles_present: p.canonical_roles_present === true,
      session_binds_canonical: p.session_binds_canonical === true,
      session_roles_schema: p.session_roles_schema == null ? null : String(p.session_roles_schema),
      visible_roles_relations: Number(p.visible_roles_relations),
      canonical_exact_carriers: Number(p.canonical_exact_carriers),
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

  // VALIDATE THE RAW JSON, THEN USE IT. This block used to be `String(row.child_schema ?? '')`,
  // which is a coercion, and a coercion turns malformed input into a well-formed-looking
  // observation: `{child_schema: 1, child_table: true, conname: 2, confdeltype: 7}` became four
  // non-empty strings, sailed past the "a field is missing" check, and — because `'7'` is not in
  // the child-write set — was reported as CASCADE ABSENT / exit 0. Verified against head
  // cd0977e3c0. A value the catalog could not have produced is an UNREADABLE observation, never an
  // observation of no-write.
  const ROW_FIELDS = ['child_schema', 'child_table', 'conname', 'confdeltype']
  // The three identifier fields must also be NON-EMPTY. This invariant predates the type check and
  // was swallowed when the coercion block was replaced: `''` is a string, so a row naming no schema,
  // no table or no constraint parsed cleanly and — with a legal non-writing `confdeltype` — was
  // reported as CASCADE ABSENT / exit 0. An observation that cannot say WHICH constraint, on WHICH
  // table, in WHICH schema was written by WHICH action is an unreadable observation, not a readable
  // observation of nothing. (`confdeltype` needs no separate emptiness check: `''` is not one of
  // the legal delete-action letters, so the enum check below rejects it.)
  const NON_EMPTY_ROW_FIELDS = ['child_schema', 'child_table', 'conname']
  for (const row of rows) {
    for (const field of ROW_FIELDS) {
      if (typeof row[field] !== 'string') {
        return {
          ok: false,
          reason: INDETERMINATE_REASONS.unparseable,
          detail: `a ROWS entry has a non-string ${field} (${typeof row[field]}); the catalog projection is all text, so this payload did not come from the probe`,
        }
      }
    }
    for (const field of NON_EMPTY_ROW_FIELDS) {
      if (row[field] === '') {
        return {
          ok: false,
          reason: INDETERMINATE_REASONS.unparseable,
          detail: `a ROWS entry has an empty ${field}; the catalog cannot produce an unnamed relation or constraint, so this observation cannot be read`,
        }
      }
    }
    // Not merely "not a write action" — not an action AT ALL. Derived from the battery's legal
    // letter set, so widening the catalog's vocabulary cannot leave this behind.
    if (!FK_DELETE_ACTION_LETTERS.includes(row.confdeltype)) {
      return {
        ok: false,
        reason: INDETERMINATE_REASONS.unparseable,
        detail: `a ROWS entry has confdeltype ${JSON.stringify(row.confdeltype)}, which is not a legal foreign-key delete action (${FK_DELETE_ACTION_LETTERS.join(', ')}); treating it as "no child write" would report an unreadable observation as absence`,
      }
    }
  }
  const normalisedRows = rows.map((row) => ({
    child_schema: row.child_schema,
    child_table: row.child_table,
    conname: row.conname,
    confdeltype: row.confdeltype,
  }))

  if (!presence || typeof presence !== 'object' || Array.isArray(presence)) {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'PRESENCE payload is not an object' }
  }
  const canonicalSchema = typeof presence.canonical_schema === 'string' ? presence.canonical_schema : ''
  // VALIDATED, NOT COERCED — `Number(true)` is 1, `Number(null)` is 0, `Number('')` is 0. Sending
  // `true` for all four counts produced an observation with every door open and a CONFIRMED
  // verdict. Verified against head cd0977e3c0. The probe emits real JSON numbers, so anything else
  // did not come from the probe.
  const visibleRolesCount = readCatalogCount(presence.visible_roles_relations)
  const exactCarrierCount = readCatalogCount(presence.canonical_exact_carriers)
  const triggeredRelationCount = readCatalogCount(presence.recovery_authority_relations)
  const rolesReferencingFkCount = readCatalogCount(presence.roles_referencing_fks)
  if (canonicalSchema === '') {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'PRESENCE names no canonical_schema' }
  }
  if (typeof presence.canonical_roles_present !== 'boolean' || typeof presence.session_binds_canonical !== 'boolean') {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'PRESENCE binding flags are not booleans' }
  }
  const badCounts = [
    ['visible_roles_relations', visibleRolesCount],
    ['canonical_exact_carriers', exactCarrierCount],
    ['recovery_authority_relations', triggeredRelationCount],
    ['roles_referencing_fks', rolesReferencingFkCount],
  ].filter(([, parsed]) => parsed === null).map(([name]) => name)
  if (badCounts.length > 0) {
    return {
      ok: false,
      reason: INDETERMINATE_REASONS.unparseable,
      detail: `PRESENCE counts are not non-negative integers: ${badCounts.join(', ')}`,
    }
  }
  if (presence.session_roles_schema != null && typeof presence.session_roles_schema !== 'string') {
    return { ok: false, reason: INDETERMINATE_REASONS.unparseable, detail: 'PRESENCE session_roles_schema is neither a string nor null' }
  }
  const sessionRolesSchema = presence.session_roles_schema ?? null
  const observed = {
    canonical_schema: canonicalSchema,
    canonical_roles_present: presence.canonical_roles_present,
    session_binds_canonical: presence.session_binds_canonical,
    session_roles_schema: sessionRolesSchema,
    visible_roles_relations: visibleRolesCount,
    canonical_exact_carriers: exactCarrierCount,
    recovery_authority_relations: triggeredRelationCount,
    roles_referencing_fks: rolesReferencingFkCount,
  }

  // THE DOORS ARE NOT IMPLEMENTED HERE. `classifyRoleCascadeBinding` is the single implementation,
  // shared with the battery's preflight, so the two can never drift into one certifying what the
  // other refuses — and so a neutered door reds a real input/output test instead of only a source
  // scan. This file's job is to map a door to THIS surface's vocabulary: an INDETERMINATE reason.
  const door = classifyRoleCascadeBinding(observed, { canonicalSchema })
  if (door) {
    return { ok: false, reason: DOOR_TO_INDETERMINATE_REASON[door.door], detail: door.detail }
  }

  return { ok: true, rows: normalisedRows, presence: observed }
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
    // NAME THE RELATION THE VERDICT DECIDED ON. The line this replaces read
    // "relation presence (positive control): roles=1, recovery_authority_relations=1" — and printed
    // exactly that while the two counts were satisfied by two DIFFERENT relations in two different
    // schemas. A verdict that does not say what it bound to cannot be audited after the fact.
    lines.push(
      `- bound to: \`${verdict.presence.canonical_schema}.roles\``
      + ` (session resolves \`roles\` to \`${verdict.presence.session_roles_schema ?? 'nothing'}\`;`
      + ` ${verdict.presence.visible_roles_relations} \`roles\` table(s) visible on the search_path)`,
    )
    lines.push(
      `- relation presence (positive control): recovery-authority-triggered relations in`
      + ` \`${verdict.presence.canonical_schema}\`=${verdict.presence.recovery_authority_relations}`,
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
