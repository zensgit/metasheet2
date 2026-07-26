#!/usr/bin/env node
/**
 * gip-authority-substrate-inventory.mjs
 *
 * TWO READ-ONLY, values-free inventory probes feeding two of the four §4.0 owner decisions in
 * docs/development/database-system-integration-line-design-and-verification-20260724.md
 * ("the ledger"). This is a NEW, separate carrier — per the owner's task-brief ruling (NOT recorded
 * in the ledger; the ledger's §4.0/§3.0 sections define the four decisions this work feeds but say
 * nothing about a carrier for this script), scripts/ops/data-source-exposure-inventory.mjs (#4594)
 * must NOT be expanded or reused as the carrier for this work, so nothing here imports from or
 * depends on that script; the schema-probe-first / values-free QUERY_ALLOWLIST pattern is
 * independently re-implemented, because that is the pattern being reused, not the file. Also note:
 * #4594's script/test/workflow files live only on branch `claude/data-source-exposure-inventory-
 * 20260724` (PR #4594) — they are NOT in this tree, NOT on main, and this file makes no claim that
 * they are.
 *
 * ---------------------------------------------------------------------------------------------
 * (β) CONNECTOR-KIND PROBE — integration_external_systems.kind
 * ---------------------------------------------------------------------------------------------
 * Purpose, and nothing beyond it: produce the distinct-kind-string list and per-string row counts
 * a HUMAN uses to author the explicit alias map and migration list for decision (β)'s first-party
 * CLOSED connector-kind registry (ledger §4.0 row β, §4 step 1.2, §3.0 B-2). `kind` is a free-form
 * `requiredString` with no vocabulary anywhere today (external-systems.cjs L91; migration 057's
 * column comment lists illustrative EXAMPLES only, not an enum — there is no CHECK constraint on
 * this column, unlike `status`).
 *
 * FORBIDDEN, enforced structurally below, not just by convention: this probe NEVER auto-expands or
 * auto-populates KNOWN_CERTIFIED_CONNECTOR_KINDS from what it observes. That constant is frozen at
 * module load and is the ONLY thing this script ever compares an observed kind string against; the
 * probe has no code path that writes to it. It stays empty until a human, acting on decision (β),
 * edits this file in a follow-up change — never as a side effect of running the inventory.
 *
 * ---------------------------------------------------------------------------------------------
 * (γ) OBJECT-KEY PROBE — integration_read_source_configs.object
 * ---------------------------------------------------------------------------------------------
 * Purpose, and nothing beyond it: produce the distinct-objectKey list and per-key row counts a
 * HUMAN uses to author the missing-reference list and backfill list for decision (γ)'s first-party
 * canonical object contract registry (ledger §4.0 row γ, §4 step 1.3, §3.0 B-3).
 *
 * Terminology note, stated once because it is load-bearing and easy to get wrong: the ledger's
 * qualification-input tuple names this field `objectKey` (§3.1, §4 step 1). No column literally
 * named `objectKey` exists on main. The stored column is `integration_read_source_configs.object`
 * (migration 062 L28: `object TEXT NOT NULL`; both unique indexes key on it; the store's
 * `saveVersion` writes it from `normalized.object`, which is `read-source-config.cjs`'s validated
 * `object` field). This probe queries THAT column and reports it as the objectKey inventory the
 * task asked for — the mapping is asserted by a schema-drift test below, not merely commented.
 *
 * FORBIDDEN, enforced the same way as β: KNOWN_CANONICAL_OBJECT_KEYS is frozen, empty, and never
 * written to by this script. Canonical contracts must come from first-party frozen definitions
 * (decision γ ruling) — this inventory never generates, synthesises, or seeds one from what it
 * observes in a customer's approved configs.
 *
 * ---------------------------------------------------------------------------------------------
 * OUTPUT DISCIPLINE (owner ruling, quoted in the task brief)
 * ---------------------------------------------------------------------------------------------
 * Public/committed output (stdout, --json, the human summary): AGGREGATE COUNTS ONLY. The public
 * report object is built exclusively from: fixed status/verdict enum tokens, fixed label strings
 * authored in this file, and integers. It is structurally incapable of holding an observed kind or
 * objectKey string — see buildPublicKindSummary()/buildPublicObjectKeySummary() below, which never
 * receive the raw per-value rows, only the two counts already reduced from them. This is proven
 * by test (a sentinel value injected through the fake executor must not appear anywhere in
 * JSON.stringify(publicReport)) rather than merely asserted.
 *
 * Raw values (the actual kind / objectKey strings, with their row counts) go ONLY into a private,
 * gitignored local artefact file — see writePrivateArtifact() / DEFAULT_PRIVATE_OUTPUT_DIR — never
 * into this script's stdout in non-JSON mode beyond the artefact PATH, never into the committed
 * JSON report, never into a log line, never into a PR body.
 *
 * ---------------------------------------------------------------------------------------------
 * SCOPE (from the ledger's Gate — see the ledger's "B1a AUTHORITY-SUBSTRATE gate" wording)
 * ---------------------------------------------------------------------------------------------
 * Building and testing this tool is inside the B1a AUTHORITY-SUBSTRATE gate (bounded internal
 * work, no new request surface, no runtime consumer). CONNECTING IT TO A CUSTOMER DEPLOYMENT is a
 * separate, ops-gated read-only authorization this task does not carry — see main()'s DATABASE_URL
 * requirement and the PR body for the explicit statement that no such run has happened.
 *
 * Usage:
 *   DATABASE_URL=postgres://… node scripts/ops/gip-authority-substrate-inventory.mjs \
 *     [--probe beta|gamma|both] [--private-out <path> | --no-private-out] [--json]
 *   node scripts/ops/gip-authority-substrate-inventory.mjs --dry-run   # no DB required
 *
 * Exit codes: exit 1 is reached by TWO DIFFERENT routes through main() — they share the exit code
 * but not the code path, and neither leaks anything about the underlying failure (see the CLI
 * error-reason discipline right below the "CLI" section heading, and the exit-code contract test
 * describe block in the test file, which pins the second route directly by calling main()):
 *   0  ran successfully (a MAPPING_REQUIRED / BACKFILL_REQUIRED verdict is information, not failure)
 *   1  route A — an exception escaped buildReport()/buildDryRunReport()/parseArgs() (an unexpected
 *      runtime/DB error, OR the private artefact was owed — unregistered/unmapped count > 0 — but
 *      the write itself failed). Caught by main()'s try/catch; stderr gets a closed
 *      CLI_ERROR_REASON token (never the caught error's own .message), never returns to the
 *      `if (consumableByWave2 === false)` check below at all.
 *   1  route B — buildReport() returns NORMALLY but the private artefact was owed and
 *      --no-private-out disabled the write (report.privateArtifact.consumableByWave2 === false,
 *      checked explicitly in main(), ~L1107). The report is still printed to stdout in this case; only
 *      the exit code fails closed, so a caller relying on exit status alone (not reading stdout)
 *      still cannot mistake this for a complete inventory.
 *   Both routes fail closed rather than reporting aggregate-only success while silently dropping
 *   the raw detail a human needs to act on it, or letting a caller read "ran successfully" as "this
 *   run is a complete inventory". A failure to close the Postgres pool AFTER either route already
 *   determined its result (0/1/2) is swallowed silently by design (see safeClose()) — it never
 *   changes the exit code and never produces separate stderr output; the pool-close outcome itself
 *   is not signalled on any channel.
 *   2  required input missing (DATABASE_URL absent outside --dry-run)
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..')

// ---------------------------------------------------------------------------
// Frozen registries — see the FORBIDDEN paragraphs above. Empty until a human
// edits this file under decision (β) / decision (γ). No function in this
// module writes to either constant; the mutation-immunity tests below prove
// that, rather than trusting the comment.
// ---------------------------------------------------------------------------

// Decision (β): first-party CLOSED connector-kind registry. NOT populated by this script. Do not
// seed this from any single shipped example (e.g. a GIP *profile* `connectorKind` such as
// `bridge:legacy-sql-readonly` in gip-bridge-bounded-read-profile.cjs) — that is a DIFFERENT field
// (a certified read-action-profile's connector kind) from `integration_external_systems.kind`
// (an operator-supplied external-system registration kind), and conflating them would be exactly
// the "false certification via wrong artefact" class this ledger has been burned by before (§3.0
// B-2's retraction). Leave empty; only the owner's decision (β) may add entries here.
const KNOWN_CERTIFIED_CONNECTOR_KINDS = Object.freeze([])

// Decision (γ): first-party canonical object contract registry, keyed by the object identifiers
// this probe observes in `integration_read_source_configs.object`. NOT populated by this script.
// Only the owner's decision (γ) — first-party frozen definitions — may add entries here.
const KNOWN_CANONICAL_OBJECT_KEYS = Object.freeze([])

// CHECK constraint on integration_external_systems.status (migration 057).
const EXTERNAL_SYSTEM_STATUSES = Object.freeze(['active', 'inactive', 'error'])
// CHECK constraint on integration_read_source_configs.status (migration 062).
const READ_SOURCE_CONFIG_STATUSES = Object.freeze(['draft', 'approved', 'retired'])

const SCHEMA_PROBE_CAVEAT =
  "probed via information_schema.tables/.columns, table_schema='public', as the DATABASE_URL role — a non-public search_path or missing SELECT/USAGE privileges reports the same as a genuinely absent object"

const DEFAULT_PRIVATE_OUTPUT_DIR = 'artifacts/gip-authority-inventory'

// ---------------------------------------------------------------------------
// QUERY_ALLOWLIST — the ONLY SQL statements this script will ever execute.
// Every statement is SELECT-only; assertReadOnlyAllowlist() enforces that
// structurally at module load (same guard shape as #4594's, independently
// implemented per the owner's task-brief carrier ruling — see the header
// comment above; that ruling is not recorded in the ledger).
// ---------------------------------------------------------------------------

const QUERY_ALLOWLIST = Object.freeze({
  'probe.table_exists': {
    sql: `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    describe: 'schema probe: does table $1 exist',
  },
  'probe.columns': {
    sql: `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    describe: 'schema probe: which columns exist on table $1',
  },
  'count.external_system_kinds_all': {
    sql: `SELECT kind, count(*)::int AS n FROM integration_external_systems GROUP BY kind`,
    describe: 'all integration_external_systems rows (any status), grouped by kind',
  },
  'count.external_system_kinds_active': {
    sql: `SELECT kind, count(*)::int AS n FROM integration_external_systems WHERE status = 'active' GROUP BY kind`,
    describe: "active-only integration_external_systems rows, grouped by kind",
  },
  'count.read_source_config_objects_by_status': {
    sql: `SELECT object, status, count(*)::int AS n FROM integration_read_source_configs GROUP BY object, status`,
    describe: 'integration_read_source_configs rows grouped by (object, status) — covers draft/approved/retired in one pass',
  },
  'count.read_source_config_object_config_divergence': {
    sql: `SELECT count(*)::int AS n FROM integration_read_source_configs WHERE object IS DISTINCT FROM (config ->> 'object')`,
    describe:
      "rows where the object column and config->>'object' disagree — a values-free integrity check; a non-zero result means some backfill/mapping decision fed only by the object column would miss rows whose stored config JSON disagrees with it. IS DISTINCT FROM (not <>) is deliberate: a row whose config JSON carries no 'object' key at all has config->>'object' = NULL, and IS DISTINCT FROM (unlike <>) treats object <> NULL as true rather than UNKNOWN per the SQL standard's IS DISTINCT FROM semantics — a missing key in config counts as a divergence, not a silent pass. A prior session in this PR reported exercising this against a seeded row with no 'object' key on an ephemeral local Postgres instance that was discarded afterward with no transcript captured — see PR body's caveat on that claim; this fix pass did not have a live Postgres runtime available to reproduce it independently, so treat the missing-key behaviour as following from the documented SQL semantics of IS DISTINCT FROM, not as an independently-reproduced live-DB proof.",
  },
})

// A row count is only ever trustworthy if it is a non-negative SAFE integer. `Number(x) || 0`
// (the prior shape of this predicate) turns undefined/null/''/'abc'/NaN into a silent 0 — the
// single most dangerous wrong answer for a precondition probe, because "0 unregistered" is
// exactly the green light a downstream gate would consume. Fail closed instead: anything that is
// not a genuinely-observed non-negative safe integer must make the surrounding coverage
// UNAVAILABLE (-> INCONCLUSIVE at the verdict layer), never silently read as zero.
//
// `typeof value === 'number'` is correct against the real driver, not merely convenient in tests:
// every allowlisted count query casts with `count(*)::int` (int4), and node-postgres parses int4
// results to native JS numbers. An accidental switch to a bigint-returning cast (int8/count with
// no cast) would come back from `pg` as a STRING — and this predicate correctly fails that closed
// too, rather than coercing it.
function isSafeNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

// Fixed, values-free reason used whenever a row count fails the safe-integer check above. Never
// interpolates the observed value, the row index, or which row — those could themselves be, or be
// derived from, database content; the fact that this happened is the entire actionable signal.
const INVALID_COUNT_REASON =
  'a row count value returned by the connected database was not a non-negative safe integer — treated as INCONCLUSIVE, never defaulted to zero'

function assertReadOnlyAllowlist(allowlist) {
  for (const [tag, entry] of Object.entries(allowlist)) {
    if (!/^\s*SELECT\b/i.test(entry.sql)) {
      throw new Error(
        `gip-authority-substrate-inventory: QUERY_ALLOWLIST entry "${tag}" is not a SELECT statement — refusing to load a non-read-only query.`,
      )
    }
    const trimmed = entry.sql.trim()
    const withoutTrailingSemicolon = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed
    if (withoutTrailingSemicolon.includes(';')) {
      throw new Error(
        `gip-authority-substrate-inventory: QUERY_ALLOWLIST entry "${tag}" contains a non-trailing semicolon — refusing to load a possible multi-statement query.`,
      )
    }
  }
}
assertReadOnlyAllowlist(QUERY_ALLOWLIST)

async function runQuery(exec, tag, params = []) {
  const entry = QUERY_ALLOWLIST[tag]
  if (!entry) {
    throw new Error(`gip-authority-substrate-inventory: query tag not on allowlist: ${tag}`)
  }
  return exec(entry.sql, params)
}

// ---------------------------------------------------------------------------
// Schema probing
// ---------------------------------------------------------------------------

const TABLE_SPECS = Object.freeze({
  integration_external_systems: ['id', 'kind', 'status'],
  integration_read_source_configs: ['id', 'object', 'status', 'config'],
})

// Which TABLE_SPECS entries a given --probe value needs. "Strictly separated purposes" is enforced
// HERE, not only at the count-query layer: under --probe beta, integration_read_source_configs is
// never even schema-probed (no information_schema.tables/.columns call naming it) — a scoped run
// makes literally zero round-trips that mention the other probe's table, full stop.
function tableSpecsForProbe(probe) {
  if (probe === 'beta') {
    return { integration_external_systems: TABLE_SPECS.integration_external_systems }
  }
  if (probe === 'gamma') {
    return { integration_read_source_configs: TABLE_SPECS.integration_read_source_configs }
  }
  return TABLE_SPECS
}

async function tableExists(exec, tableName) {
  const { rows } = await runQuery(exec, 'probe.table_exists', [tableName])
  return rows.length > 0
}

async function probeColumns(exec, tableName, wantedColumns) {
  const { rows } = await runQuery(exec, 'probe.columns', [tableName])
  const present = new Set(rows.map((r) => r.column_name))
  const result = {}
  for (const col of wantedColumns) result[col] = present.has(col)
  return result
}

async function probeSchema(exec, tableSpecs = TABLE_SPECS) {
  const schema = {}
  for (const [table, cols] of Object.entries(tableSpecs)) {
    const exists = await tableExists(exec, table)
    const columns = exists
      ? await probeColumns(exec, table, cols)
      : Object.fromEntries(cols.map((c) => [c, false]))
    schema[table] = { exists, columns }
  }
  return schema
}

// ---------------------------------------------------------------------------
// Plan builder — pure function of schema. Decides OK vs UNAVAILABLE; never
// emits a query against an unverified column.
// ---------------------------------------------------------------------------

function planKindInventory(schema) {
  const t = schema.integration_external_systems
  if (!t.exists) {
    return { status: 'unavailable', reason: `table integration_external_systems not found (${SCHEMA_PROBE_CAVEAT})` }
  }
  if (!t.columns.kind) {
    return { status: 'unavailable', reason: `integration_external_systems.kind column not found (${SCHEMA_PROBE_CAVEAT})` }
  }
  const allStatuses = { status: 'ok', tag: 'count.external_system_kinds_all', params: [] }
  const activeOnly = t.columns.status
    ? { status: 'ok', tag: 'count.external_system_kinds_active', params: [] }
    : { status: 'unavailable', reason: `integration_external_systems.status column not found (${SCHEMA_PROBE_CAVEAT}) — cannot separate active-only from all-statuses` }
  return { status: 'ok', allStatuses, activeOnly }
}

function planObjectKeyInventory(schema) {
  const t = schema.integration_read_source_configs
  if (!t.exists) {
    return { status: 'unavailable', reason: `table integration_read_source_configs not found (${SCHEMA_PROBE_CAVEAT})` }
  }
  const missing = ['object', 'status'].filter((c) => !t.columns[c])
  if (missing.length) {
    return {
      status: 'unavailable',
      reason: `integration_read_source_configs missing column(s): ${missing.join(', ')} (${SCHEMA_PROBE_CAVEAT})`,
    }
  }
  const byStatus = { status: 'ok', tag: 'count.read_source_config_objects_by_status', params: [] }
  const divergence = t.columns.config
    ? { status: 'ok', tag: 'count.read_source_config_object_config_divergence', params: [] }
    : { status: 'unavailable', reason: `integration_read_source_configs.config column not found (${SCHEMA_PROBE_CAVEAT}) — cannot compute the object vs config->>'object' divergence check` }
  return { status: 'ok', byStatus, divergence }
}

// `probe` scopes WHICH plans get built, not just which summaries get rendered — a plan of
// { status: 'not_run' } short-circuits executeKindInventoryPlan/executeObjectKeyInventoryPlan
// below BEFORE any query is issued. This is what makes "strictly separated purposes" true at the
// query and private-artefact layer, not just in the printed summary: `--probe beta` must never
// query integration_read_source_configs, and must never write a γ objectKey value anywhere,
// private artefact included.
function buildPlan(schema, { probe = 'both' } = {}) {
  const runBeta = probe === 'both' || probe === 'beta'
  const runGamma = probe === 'both' || probe === 'gamma'
  return {
    kindInventory: runBeta ? planKindInventory(schema) : { status: 'not_run' },
    objectKeyInventory: runGamma ? planObjectKeyInventory(schema) : { status: 'not_run' },
  }
}

// ---------------------------------------------------------------------------
// Bucketing — the values-free chokepoint. Every function below reduces raw
// (value, n) rows into TWO integers (registered / unregistered) plus totals.
// The raw rows themselves are returned SEPARATELY as `detail`, and callers
// that assemble the PUBLIC report must never forward `detail` into it — only
// the counts. writePrivateArtifact() is the only place `detail` may land.
// ---------------------------------------------------------------------------

// Returns EITHER { status: 'ok', counts, detail } OR { status: 'invalid_count', reason } — never
// a throw a caller could swallow, and never counts built from a coerced/defaulted bad value. A
// single anomalous row count invalidates the whole bucket rather than silently zeroing just that
// row: a partial "mostly trustworthy" count is exactly the shape a human skims past.
function bucketByRegistry(rows, knownSet, { valueKey, countKey = 'n' }) {
  const known = new Set(knownSet)
  let registeredDistinct = 0
  let unregisteredDistinct = 0
  let registeredRows = 0
  let unregisteredRows = 0
  let totalRows = 0
  const detail = []
  for (const row of rows) {
    const value = row[valueKey]
    const rawCount = row[countKey]
    if (!isSafeNonNegativeInteger(rawCount)) {
      return { status: 'invalid_count', reason: INVALID_COUNT_REASON }
    }
    const n = rawCount
    totalRows += n
    const isKnown = known.has(value)
    if (isKnown) {
      registeredDistinct += 1
      registeredRows += n
    } else {
      unregisteredDistinct += 1
      unregisteredRows += n
    }
    detail.push({ value, count: n, registered: isKnown })
  }
  return {
    status: 'ok',
    counts: {
      distinctCount: rows.length,
      totalRows,
      knownRegistrySize: known.size,
      registeredDistinctCount: registeredDistinct,
      unregisteredDistinctCount: unregisteredDistinct,
      registeredRowCount: registeredRows,
      unregisteredRowCount: unregisteredRows,
    },
    detail,
  }
}

// ---------------------------------------------------------------------------
// Plan execution
// ---------------------------------------------------------------------------

async function executeKindInventoryPlan(exec, plan) {
  if (plan.status === 'not_run') return { status: 'not_run' }
  if (plan.status !== 'ok') return { status: 'unavailable', reason: plan.reason }

  const allRes = await runQuery(exec, plan.allStatuses.tag, plan.allStatuses.params)
  const all = bucketByRegistry(allRes.rows, KNOWN_CERTIFIED_CONNECTOR_KINDS, { valueKey: 'kind' })
  // allStatuses is what the verdict is computed from (see computeKindVerdict) — an invalid count
  // there invalidates the whole probe, not just this sub-field, the same way a missing table does.
  if (all.status !== 'ok') return { status: 'unavailable', reason: all.reason }

  let active
  if (plan.activeOnly.status !== 'ok') {
    active = { status: 'unavailable', reason: plan.activeOnly.reason }
  } else {
    const activeRes = await runQuery(exec, plan.activeOnly.tag, plan.activeOnly.params)
    const bucketed = bucketByRegistry(activeRes.rows, KNOWN_CERTIFIED_CONNECTOR_KINDS, { valueKey: 'kind' })
    active = bucketed.status === 'ok'
      ? { status: 'ok', counts: bucketed.counts, detail: bucketed.detail }
      : { status: 'unavailable', reason: bucketed.reason }
  }

  return {
    status: 'ok',
    allStatuses: { status: 'ok', counts: all.counts, detail: all.detail },
    activeOnly: active,
  }
}

// Splits one (object,status,n) row set into the three closed status buckets. Any status value NOT
// in READ_SOURCE_CONFIG_STATUSES is fail-closed into its own 'unexpected' group rather than
// silently dropped or merged into an existing bucket — the CHECK constraint should make this
// group always empty, but a report must never assume its own gate held.
function splitRowsByStatus(rows) {
  const byStatus = { draft: [], approved: [], retired: [], unexpected: [] }
  for (const row of rows) {
    const bucket = READ_SOURCE_CONFIG_STATUSES.includes(row.status) ? row.status : 'unexpected'
    byStatus[bucket].push(row)
  }
  return byStatus
}

async function executeObjectKeyInventoryPlan(exec, plan) {
  if (plan.status === 'not_run') return { status: 'not_run' }
  if (plan.status !== 'ok') return { status: 'unavailable', reason: plan.reason }

  const res = await runQuery(exec, plan.byStatus.tag, plan.byStatus.params)
  const split = splitRowsByStatus(res.rows)

  const byStatus = {}
  for (const key of ['draft', 'approved', 'retired', 'unexpected']) {
    const bucketed = bucketByRegistry(split[key], KNOWN_CANONICAL_OBJECT_KEYS, { valueKey: 'object' })
    // An invalid count in ANY status bucket invalidates the whole probe (computeObjectKeyVerdict
    // reads approved/unexpected together; a partial trustworthy read is not a safe read).
    if (bucketed.status !== 'ok') return { status: 'unavailable', reason: bucketed.reason }
    byStatus[key] = { status: 'ok', counts: bucketed.counts, detail: bucketed.detail }
  }

  let divergence
  if (plan.divergence.status !== 'ok') {
    divergence = { status: 'unavailable', reason: plan.divergence.reason }
  } else {
    const { rows } = await runQuery(exec, plan.divergence.tag, plan.divergence.params)
    // A COUNT(*) query always returns exactly one row; anything else (zero or several) is itself
    // an anomaly, not just the value inside it — fail closed rather than defaulting to 0.
    const rawCount = rows.length === 1 ? rows[0].n : undefined
    divergence = isSafeNonNegativeInteger(rawCount)
      ? { status: 'ok', count: rawCount }
      : { status: 'unavailable', reason: INVALID_COUNT_REASON }
  }

  return { status: 'ok', byStatus, divergence }
}

async function executePlan(exec, plan) {
  const [kindInventory, objectKeyInventory] = await Promise.all([
    executeKindInventoryPlan(exec, plan.kindInventory),
    executeObjectKeyInventoryPlan(exec, plan.objectKeyInventory),
  ])
  return { kindInventory, objectKeyInventory }
}

// ---------------------------------------------------------------------------
// PUBLIC report assembly — receives ONLY `.counts` objects (integers + fixed
// keys), never `.detail` (which carries the raw kind/objectKey strings). This
// is the structural boundary the values-free test below is written against.
// ---------------------------------------------------------------------------

function buildPublicKindSummary(kindInventory) {
  if (kindInventory.status === 'not_run') {
    return { status: 'not_run' }
  }
  if (kindInventory.status !== 'ok') {
    return { status: 'unavailable', reason: kindInventory.reason }
  }
  const out = { status: 'ok' }
  out.allStatuses = kindInventory.allStatuses.status === 'ok'
    ? { status: 'ok', ...kindInventory.allStatuses.counts }
    : { status: 'unavailable', reason: kindInventory.allStatuses.reason }
  out.activeOnly = kindInventory.activeOnly.status === 'ok'
    ? { status: 'ok', ...kindInventory.activeOnly.counts }
    : { status: 'unavailable', reason: kindInventory.activeOnly.reason }
  return out
}

function buildPublicObjectKeySummary(objectKeyInventory) {
  if (objectKeyInventory.status === 'not_run') {
    return { status: 'not_run' }
  }
  if (objectKeyInventory.status !== 'ok') {
    return { status: 'unavailable', reason: objectKeyInventory.reason }
  }
  const out = { status: 'ok', byStatus: {} }
  for (const key of ['draft', 'approved', 'retired', 'unexpected']) {
    out.byStatus[key] = { status: 'ok', ...objectKeyInventory.byStatus[key].counts }
  }
  out.objectVsConfigObjectDivergence = objectKeyInventory.divergence
  return out
}

// ---------------------------------------------------------------------------
// Verdicts — kept SEPARATE per probe (β and γ have strictly separated
// purposes; a blended verdict would let one probe's signal stand in for the
// other's). Each has three reachable outcomes; any UNAVAILABLE coverage
// forces INCONCLUSIVE — never a silent "0" read as "nothing to map".
// ---------------------------------------------------------------------------

function computeKindVerdict(publicKindSummary) {
  if (publicKindSummary.status !== 'ok' || publicKindSummary.allStatuses.status !== 'ok') {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [
        'coverage is partial — the all-statuses kind count is UNAVAILABLE',
        publicKindSummary.status !== 'ok' ? publicKindSummary.reason : publicKindSummary.allStatuses.reason,
      ],
    }
  }
  const { unregisteredDistinctCount, distinctKindCount } = {
    unregisteredDistinctCount: publicKindSummary.allStatuses.unregisteredDistinctCount,
    distinctKindCount: publicKindSummary.allStatuses.distinctCount,
  }
  if (unregisteredDistinctCount === 0) {
    return {
      verdict: 'CONNECTOR_KIND_MAPPING_NOT_REQUIRED_WITHIN_COVERAGE',
      reasons: [
        `${distinctKindCount} distinct kind string(s) observed across integration_external_systems, all already in the (currently ${KNOWN_CERTIFIED_CONNECTOR_KINDS.length}-entry) known registry`,
        'a zero known-registry size makes this trivially true today — see residualNotes',
      ],
    }
  }
  return {
    verdict: 'CONNECTOR_KIND_MAPPING_REQUIRED',
    reasons: [
      `${unregisteredDistinctCount} of ${distinctKindCount} distinct kind string(s) are not in the known registry (size ${KNOWN_CERTIFIED_CONNECTOR_KINDS.length}) — an explicit alias map / migration decision (β) is needed before these can bind under GIP`,
      'raw kind strings are in the private artefact, if one was written — see privateArtifact',
    ],
  }
}

function computeObjectKeyVerdict(publicObjectKeySummary) {
  if (publicObjectKeySummary.status !== 'ok' || publicObjectKeySummary.byStatus.approved.status !== 'ok') {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [
        'coverage is partial — the approved-status objectKey count is UNAVAILABLE',
        publicObjectKeySummary.status !== 'ok' ? publicObjectKeySummary.reason : publicObjectKeySummary.byStatus.approved.reason,
      ],
    }
  }
  const divergence = publicObjectKeySummary.objectVsConfigObjectDivergence
  if (!divergence || divergence.status !== 'ok') {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [
        'coverage is partial — the object vs config->>\'object\' divergence check is UNAVAILABLE',
        divergence ? divergence.reason : 'divergence field missing from summary',
      ],
    }
  }
  // A non-zero divergence means the `object` column — the field the backfill list above was
  // built from — disagrees with the config's own stored objectKey for at least one row. A
  // NOT_REQUIRED verdict built only from `object` would then be silently wrong for the disagreeing
  // rows: the backfill list a human builds from this report would miss whatever objectKey the
  // config JSON actually references. Fail closed rather than let that pass as "nothing to do".
  if (divergence.count > 0) {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [
        `${divergence.count} row(s) have integration_read_source_configs.object disagreeing with config->>'object' — a backfill/mapping decision built from the object column alone would be unreliable for those rows until the divergence is resolved`,
        'this is reported regardless of registeredness — see coverage.canonicalObjectKeyInventory.objectVsConfigObjectDivergence',
      ],
    }
  }
  // `unexpected` is where splitRowsByStatus() fail-closes any row whose status is outside the
  // CHECK-constraint vocabulary (draft/approved/retired) — see splitRowsByStatus(). The CHECK
  // constraint should make this bucket always empty, but a report must never assume its own gate
  // held: if it observes distinct objectKeys sitting in an out-of-vocabulary status, that is
  // exactly the "unregistered objectKeys coexisting with a NOT_REQUIRED verdict" shape the
  // divergence check above exists to prevent — a human reading NOT_REQUIRED must not be told
  // "nothing to map" while rows outside the known status vocabulary are sitting unaccounted for.
  const unexpected = publicObjectKeySummary.byStatus.unexpected
  if (!unexpected || unexpected.status !== 'ok') {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [
        'coverage is partial — the unexpected-status objectKey count is UNAVAILABLE',
        unexpected ? unexpected.reason : 'byStatus.unexpected field missing from summary',
      ],
    }
  }
  if (unexpected.distinctCount > 0) {
    return {
      verdict: 'INCONCLUSIVE',
      reasons: [
        `${unexpected.distinctCount} distinct objectKey(s) referenced by read-source config row(s) in an out-of-vocabulary (unexpected) status — a verdict scoped to 'approved' cannot be trusted while rows exist outside the known draft/approved/retired status vocabulary`,
        'this is reported regardless of registeredness — see coverage.canonicalObjectKeyInventory.byStatus.unexpected',
      ],
    }
  }
  const approved = publicObjectKeySummary.byStatus.approved
  if (approved.unregisteredDistinctCount === 0) {
    return {
      verdict: 'CANONICAL_OBJECT_BACKFILL_NOT_REQUIRED_WITHIN_COVERAGE',
      reasons: [
        `${approved.distinctCount} distinct objectKey(s) referenced by approved read-source configs, all already in the (currently ${KNOWN_CANONICAL_OBJECT_KEYS.length}-entry) known registry`,
        'a zero known-registry size makes this trivially true today — see residualNotes',
      ],
    }
  }
  return {
    verdict: 'CANONICAL_OBJECT_BACKFILL_REQUIRED',
    reasons: [
      `${approved.unregisteredDistinctCount} of ${approved.distinctCount} distinct objectKey(s) referenced by approved configs are not in the known registry (size ${KNOWN_CANONICAL_OBJECT_KEYS.length}) — inventory + backfill of these is required BEFORE activation per decision (γ)`,
      'raw objectKey strings are in the private artefact, if one was written — see privateArtifact',
    ],
  }
}

// ---------------------------------------------------------------------------
// Residual notes — always present; a zero elsewhere must never read as proof
// of zero live risk.
// ---------------------------------------------------------------------------

const RESIDUAL_NOTES = Object.freeze([
  {
    id: 'known_registries_empty_by_design',
    description:
      'Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.',
  },
  {
    id: 'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
    description:
      "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  },
  {
    id: 'no_customer_deployment_connection',
    description:
      'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  },
  {
    id: 'integration_write_target_configs_object_deliberately_out_of_scope',
    description:
      "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration 064, External-API WRITE self-service W1). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§4 step 1.3, §3.0 B-3) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  },
])

// ---------------------------------------------------------------------------
// Private artefact — the ONLY place raw kind/objectKey strings are ever
// written. Fails CLOSED: if there is at least one unregistered/unmapped item
// and the artefact cannot be written, buildReport()/main() treat that as a
// hard error rather than completing with an aggregate-only success that
// silently drops the one thing a human needs to act on it.
// ---------------------------------------------------------------------------

function shouldWritePrivateArtifact(coverage) {
  const kindUnregistered =
    coverage.kindInventory.status === 'ok' &&
    coverage.kindInventory.allStatuses.status === 'ok' &&
    coverage.kindInventory.allStatuses.counts.unregisteredDistinctCount > 0
  const objectUnregistered =
    coverage.objectKeyInventory.status === 'ok' &&
    ['draft', 'approved', 'retired', 'unexpected'].some(
      (k) => coverage.objectKeyInventory.byStatus[k].counts.unregisteredDistinctCount > 0,
    )
  return kindUnregistered || objectUnregistered
}

function buildPrivateArtifactContent(coverage, { generatedAt }) {
  return {
    generatedAt,
    warning:
      'PRIVATE ARTEFACT — contains raw connector kind / objectKey strings observed in this deployment. Never commit, never paste into a PR body or issue, never log. Local operator use only, for authoring the decision (β) alias map and the decision (γ) backfill list.',
    connectorKinds: {
      allStatuses: coverage.kindInventory.status === 'ok' ? coverage.kindInventory.allStatuses.detail ?? [] : [],
      activeOnly:
        coverage.kindInventory.status === 'ok' && coverage.kindInventory.activeOnly.status === 'ok'
          ? coverage.kindInventory.activeOnly.detail
          : [],
    },
    objectKeys:
      coverage.objectKeyInventory.status === 'ok'
        ? {
            draft: coverage.objectKeyInventory.byStatus.draft.detail,
            approved: coverage.objectKeyInventory.byStatus.approved.detail,
            retired: coverage.objectKeyInventory.byStatus.retired.detail,
            unexpected: coverage.objectKeyInventory.byStatus.unexpected.detail,
          }
        : {},
  }
}

// EXCLUSIVE CREATE ONLY. `flag: 'wx'` is O_CREAT|O_EXCL|O_WRONLY: per POSIX, open() with O_EXCL
// fails EEXIST if the path already names ANYTHING — a regular file, OR a symlink node, even a
// DANGLING one whose target does not exist — without ever following that symlink to write through
// it. This closes both refusals atomically (no separate "check then write" race): never overwrite
// an existing target, never follow a symlink at the target path. `mode: 0o600` only constrains the
// permissions of a file THIS call creates; it cannot and does not retroactively tighten a
// pre-existing target, which is exactly why exclusivity (not just the mode) is the real guard.
function writePrivateArtifact(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}

function defaultPrivateOutputPath(repoRoot, generatedAt) {
  const stamp = generatedAt.replace(/[:.]/g, '-')
  return path.join(repoRoot, DEFAULT_PRIVATE_OUTPUT_DIR, `gip-authority-inventory-${stamp}.json`)
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

async function buildReport({ exec, repoRoot = REPO_ROOT, probe = 'both', privateOutPath, noPrivateOut = false } = {}) {
  const generatedAt = new Date().toISOString()
  // `probe` scopes the SCHEMA PROBE itself, not just the count queries: under --probe beta,
  // integration_read_source_configs is never named in an information_schema.tables/.columns call
  // either — see tableSpecsForProbe().
  const schema = await probeSchema(exec, tableSpecsForProbe(probe))
  // `probe` is threaded into buildPlan(), not applied after the fact: an un-requested probe's plan
  // is { status: 'not_run' } BEFORE executePlan runs, so executeKindInventoryPlan /
  // executeObjectKeyInventoryPlan short-circuit and never issue that probe's query at all — under
  // `--probe beta`, integration_read_source_configs is never touched, and no γ objectKey value can
  // reach coverage, the public summary, or the private artefact (see shouldWritePrivateArtifact /
  // buildPrivateArtifactContent, both driven off this same `coverage`).
  const plan = buildPlan(schema, { probe })
  const coverage = await executePlan(exec, plan)

  const publicKindSummary = buildPublicKindSummary(coverage.kindInventory)
  const publicObjectKeySummary = buildPublicObjectKeySummary(coverage.objectKeyInventory)

  const kindVerdict = coverage.kindInventory.status === 'not_run' ? null : computeKindVerdict(publicKindSummary)
  const objectKeyVerdict = coverage.objectKeyInventory.status === 'not_run' ? null : computeObjectKeyVerdict(publicObjectKeySummary)

  // Computed unconditionally — needed BOTH to decide whether a disabled write is fail-closed
  // (below) and, unchanged from before, to decide whether a write failure is fail-closed.
  const owed = shouldWritePrivateArtifact(coverage)

  let privateArtifact
  if (noPrivateOut) {
    // A private artefact is the ONLY place raw kind/objectKey detail can go (see the header's
    // OUTPUT DISCIPLINE section). If one is owed (unregistered/unmapped values exist) and the
    // operator disabled the write, this run is NOT a complete inventory: the raw list a human
    // needs to author the (β)/(γ) decisions never landed anywhere. Say so structurally —
    // `consumableByWave2: false` — rather than reporting the same bare 'skipped_by_flag' a
    // genuinely-nothing-owed run gets; main() also turns this into a non-zero exit code (see the
    // header's Exit codes list) so a caller relying on exit status alone still fails closed.
    privateArtifact = owed
      ? { status: 'incomplete_owed_disabled', consumableByWave2: false }
      : { status: 'skipped_by_flag', consumableByWave2: true }
  } else {
    // Deterministic default target: DEFAULT_PRIVATE_OUTPUT_DIR + this report's own `generatedAt`
    // (see defaultPrivateOutputPath()) — an operator who did not pass --private-out can always
    // reconstruct a 'written' artefact's location from those two already-public values. The real
    // filesystem path is never echoed into privateArtifact itself: report.privateArtifact is
    // public/committed output (stdout, --json, the human summary — see the header's OUTPUT
    // DISCIPLINE section), and an operator-supplied --private-out path is untrusted input that
    // could itself carry a customer directory name or hostname, so it must never round-trip back
    // out through a channel this file promises is values-free.
    const targetPath = privateOutPath || defaultPrivateOutputPath(repoRoot, generatedAt)
    try {
      const content = buildPrivateArtifactContent(coverage, { generatedAt })
      writePrivateArtifact(targetPath, content)
      privateArtifact = { status: 'written', consumableByWave2: true }
    } catch (err) {
      if (owed) {
        // Fail closed: raw detail existed and needed a home; the write failed. The thrown message
        // stays values-free too — never interpolate the target path or the underlying err.message,
        // either of which can carry filesystem/OS detail (a customer directory name, a hostname)
        // that has no business in anything that could end up in a log or a PR body.
        throw new Error(
          'gip-authority-substrate-inventory: unregistered kind/objectKey values exist but the private artefact could not be written — refusing to report aggregate-only success while silently dropping the raw detail a human needs to act on it',
        )
      }
      // Nothing was owed (every observed value already matches the known registry, or there was
      // nothing to observe) — a write failure here is a filesystem nuisance, not a lost decision
      // input. Report it via a closed reason CODE only — never err.message or the target path.
      privateArtifact = { status: 'write_failed_but_nothing_owed', consumableByWave2: true, reasonCode: 'FILESYSTEM_WRITE_ERROR' }
    }
  }

  return {
    generatedAt,
    mode: 'report',
    probe,
    coverage: {
      connectorKindInventory: {
        covers:
          "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
        blindSpot:
          'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
        ...publicKindSummary,
      },
      canonicalObjectKeyInventory: {
        covers:
          "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
        blindSpot:
          "DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration 064) — a second objectKey reference class in the same database this report never queries; see residualNotes.",
        ...publicObjectKeySummary,
      },
    },
    verdicts: {
      connectorKind: kindVerdict,
      canonicalObjectKey: objectKeyVerdict,
    },
    residualNotes: RESIDUAL_NOTES,
    privateArtifact,
  }
}

// ---------------------------------------------------------------------------
// Dry-run / plan mode
// ---------------------------------------------------------------------------

async function buildDryRunReport({ exec, repoRoot = REPO_ROOT, probe = 'both' } = {}) {
  if (!exec) {
    return {
      generatedAt: new Date().toISOString(),
      mode: 'dry-run-static',
      probe,
      note: 'No query executor / DATABASE_URL supplied — schema was not probed. This lists every allowlisted query; see buildPlan() in the script source for exact resolution rules.',
      allowlist: Object.fromEntries(Object.entries(QUERY_ALLOWLIST).map(([tag, e]) => [tag, { describe: e.describe, sql: e.sql }])),
      knownRegistrySizes: {
        connectorKind: KNOWN_CERTIFIED_CONNECTOR_KINDS.length,
        canonicalObjectKey: KNOWN_CANONICAL_OBJECT_KEYS.length,
      },
      residualNotes: RESIDUAL_NOTES,
    }
  }
  // `probe` scopes the dry-run's schema probe exactly the same way buildReport() scopes report
  // mode's schema probe — see the identically-worded comment above buildReport()'s `probeSchema`
  // call. Without this, `--probe beta --dry-run` would still name/probe
  // integration_read_source_configs, which is exactly the drift `--probe beta` (report mode)
  // promises never happens, and the PR's "schema probe included" scoping claim would be false in
  // dry-run mode specifically.
  const schema = await probeSchema(exec, tableSpecsForProbe(probe))
  const plan = buildPlan(schema, { probe })
  return {
    generatedAt: new Date().toISOString(),
    mode: 'dry-run',
    probe,
    note: 'Schema WAS probed (read-only information_schema queries). No aggregate/count query below was executed — this is exactly what report mode would run next.',
    schema,
    plan,
    knownRegistrySizes: {
      connectorKind: KNOWN_CERTIFIED_CONNECTOR_KINDS.length,
      canonicalObjectKey: KNOWN_CANONICAL_OBJECT_KEYS.length,
    },
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHumanSummary(report) {
  const lines = []
  lines.push(`gip-authority-substrate-inventory — mode=${report.mode} probe=${report.probe ?? '(n/a)'} generatedAt=${report.generatedAt}`)
  if (report.mode !== 'report') {
    lines.push(report.note)
    return lines.join('\n') + '\n'
  }
  const ck = report.coverage.connectorKindInventory
  const ok = report.coverage.canonicalObjectKeyInventory
  lines.push('')
  lines.push('(β) connector-kind inventory:')
  if (ck.status === 'ok') {
    lines.push(`  all-statuses:  ${ck.allStatuses.status}${ck.allStatuses.status === 'ok' ? ` distinct=${ck.allStatuses.distinctCount} registered=${ck.allStatuses.registeredDistinctCount} unregistered=${ck.allStatuses.unregisteredDistinctCount}` : ` (${ck.allStatuses.reason})`}`)
    lines.push(`  active-only:   ${ck.activeOnly.status}${ck.activeOnly.status === 'ok' ? ` distinct=${ck.activeOnly.distinctCount} registered=${ck.activeOnly.registeredDistinctCount} unregistered=${ck.activeOnly.unregisteredDistinctCount}` : ` (${ck.activeOnly.reason})`}`)
  } else if (ck.status !== 'not_run') {
    lines.push(`  UNAVAILABLE (${ck.reason})`)
  } else {
    lines.push('  not run (--probe gamma)')
  }
  if (report.verdicts.connectorKind) {
    lines.push(`  verdict: ${report.verdicts.connectorKind.verdict}`)
  }
  lines.push('')
  lines.push('(γ) canonical-objectKey inventory (integration_read_source_configs.object):')
  if (ok.status === 'ok') {
    for (const key of ['draft', 'approved', 'retired', 'unexpected']) {
      const s = ok.byStatus[key]
      lines.push(`  ${key.padEnd(10)}: distinct=${s.distinctCount} registered=${s.registeredDistinctCount} unregistered=${s.unregisteredDistinctCount}`)
    }
    lines.push(`  object vs config->>'object' divergence: ${ok.objectVsConfigObjectDivergence.status}${ok.objectVsConfigObjectDivergence.status === 'ok' ? ` count=${ok.objectVsConfigObjectDivergence.count}` : ` (${ok.objectVsConfigObjectDivergence.reason})`}`)
  } else if (ok.status !== 'not_run') {
    lines.push(`  UNAVAILABLE (${ok.reason})`)
  } else {
    lines.push('  not run (--probe beta)')
  }
  if (report.verdicts.canonicalObjectKey) {
    lines.push(`  verdict: ${report.verdicts.canonicalObjectKey.verdict}`)
  }
  lines.push('')
  // No real filesystem path is ever printed here — see the (b) ruling above writePrivateArtifact()
  // in the source: an operator-supplied --private-out path is untrusted input, and this line is
  // public/committed output. An operator who used the default location can reconstruct it from
  // DEFAULT_PRIVATE_OUTPUT_DIR + this report's own generatedAt (see defaultPrivateOutputPath()).
  lines.push(`private artefact: ${report.privateArtifact.status}`)
  lines.push('')
  lines.push('residual notes:')
  for (const n of report.residualNotes) lines.push(`  - [${n.id}] ${n.description}`)
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// stderr values-free discipline (#4603 P2(a)): the report object's CLOSED VALUE DOMAIN (see the
// describe block of that name in the test file) was proven for stdout/--json in an earlier round,
// but the owner's probe showed stderr was NOT covered — an unrecognized flag echoed the operator's
// literal argv value verbatim, and a `pg` import failure echoed a foreign Error's .message, which
// on a `Cannot find package 'pg'` MODULE_NOT_FOUND carries an absolute filesystem path. Every
// string that can reach stderr from parseArgs()/main() below is now one of these fixed tokens —
// authored here, never argv- or env-derived — and nothing else.
const CLI_ERROR_REASON = Object.freeze({
  UNKNOWN_ARGUMENT: 'UNKNOWN_ARGUMENT',
  INVALID_PROBE_VALUE: 'INVALID_PROBE_VALUE',
  MISSING_PRIVATE_OUT_PATH: 'MISSING_PRIVATE_OUT_PATH',
  MUTUALLY_EXCLUSIVE_PRIVATE_OUT: 'MUTUALLY_EXCLUSIVE_PRIVATE_OUT',
  DATABASE_URL_REQUIRED: 'DATABASE_URL_REQUIRED',
  RUNTIME_FAILURE: 'RUNTIME_FAILURE',
})
// Membership set, not just "is it a CliArgError" — see closedCliErrorReason() below for why the
// extra check matters.
const CLI_REASON_VALUES = new Set(Object.values(CLI_ERROR_REASON))

// The ONLY error type parseArgs() is allowed to throw. `.reason` is always one of the frozen
// CLI_ERROR_REASON tokens above — never an interpolated argv value — enforced by construction at
// every throw site below (no template literal ever appears in a `new CliArgError(...)` call).
class CliArgError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'CliArgError'
    this.reason = reason
  }
}

// Maps ANY error that could reach a stderr write site in main() to a CLOSED reason token. This is
// deliberately NOT `err instanceof CliArgError ? err.message : RUNTIME_FAILURE` — that shape makes
// closedness a convention (a future `throw new CliArgError(\`unknown argument: ${a}\`)` would
// silently re-open the exact leak this fixes, and every test below would stay green because it
// only checks the class, not the value). Instead this re-validates that `.reason` is actually a
// member of the frozen CLI_ERROR_REASON set; anything else — a foreign Error's .message, a
// CliArgError constructed with a non-token string, a TypeError, a `pg` MODULE_NOT_FOUND carrying an
// absolute path, a Postgres connection error carrying a hostname — collapses to the single generic
// RUNTIME_FAILURE token. Mutation-confirmed (#4603 P2(a)): reverting this to the
// `err instanceof CliArgError ? err.message : RUNTIME_FAILURE` shape (while still constructing
// CliArgError with fixed tokens everywhere) keeps every test in this file green — the coverage gap
// is closed only by asserting membership, so a direct unit test on this function's own contract
// (feeding it a CliArgError built from a non-token string) is what actually pins it; see
// 'closedCliErrorReason' below in the test file.
function closedCliErrorReason(err) {
  return err instanceof CliArgError && CLI_REASON_VALUES.has(err.reason) ? err.reason : CLI_ERROR_REASON.RUNTIME_FAILURE
}

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, help: false, probe: 'both', privateOutPath: undefined, noPrivateOut: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case '--dry-run':
      case '--plan':
        opts.dryRun = true
        break
      case '--probe': {
        const next = argv[++i]
        if (!['beta', 'gamma', 'both'].includes(next)) {
          throw new CliArgError(CLI_ERROR_REASON.INVALID_PROBE_VALUE)
        }
        opts.probe = next
        break
      }
      case '--private-out':
        opts.privateOutPath = argv[++i]
        if (!opts.privateOutPath) throw new CliArgError(CLI_ERROR_REASON.MISSING_PRIVATE_OUT_PATH)
        break
      case '--no-private-out':
        opts.noPrivateOut = true
        break
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        opts.help = true
        break
      default:
        throw new CliArgError(CLI_ERROR_REASON.UNKNOWN_ARGUMENT)
    }
  }
  if (opts.privateOutPath && opts.noPrivateOut) {
    throw new CliArgError(CLI_ERROR_REASON.MUTUALLY_EXCLUSIVE_PRIVATE_OUT)
  }
  return opts
}

function printHelp() {
  process.stdout.write(
    [
      'gip-authority-substrate-inventory.mjs — two values-free, schema-probing inventory probes:',
      '  (β) integration_external_systems.kind distinct-value inventory',
      "  (γ) integration_read_source_configs.object (the ledger's objectKey) distinct-value inventory",
      '',
      'Usage:',
      '  DATABASE_URL=postgres://… node scripts/ops/gip-authority-substrate-inventory.mjs \\',
      '    [--probe beta|gamma|both] [--private-out <path> | --no-private-out] [--json]',
      '  node scripts/ops/gip-authority-substrate-inventory.mjs --dry-run',
      '',
      'Options:',
      '  --probe beta|gamma|both   Which probe(s) to run. Default both.',
      '  --private-out <path>      Where to write the RAW-VALUE private artefact. Default:',
      `                            ${DEFAULT_PRIVATE_OUTPUT_DIR}/gip-authority-inventory-<timestamp>.json (gitignored).`,
      '  --no-private-out          Skip writing the private artefact entirely (aggregate-only run).',
      '  --dry-run, --plan         Print the query plan without executing counts.',
      '  --json                    Print only the machine-readable JSON report.',
      '  --help                    Show this help.',
      '',
      'This script never connects to a customer deployment on its own — DATABASE_URL is supplied by',
      'the operator, and running it against one is a separate ops read-only authorization.',
      '',
    ].join('\n'),
  )
}

async function createPgExecutor(databaseUrl) {
  // Lazy import: `pg` must never be required at module load, or a hermetic `node --test` CI job
  // with no `node_modules` fails at import time before a single test runs. This is also the exact
  // failure the owner's #4603 P2(a) probe used: in that same hermetic environment `import('pg')`
  // rejects with a MODULE_NOT_FOUND Error whose .message is
  // `Cannot find package 'pg' imported from <absolute path>` — main() below must never let that
  // .message reach stderr/stdout verbatim.
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 })
  return {
    exec: (sql, params) => pool.query(sql, params),
    close: () => pool.end(),
  }
}

// A pool-close failure after the run already computed its own result (success OR a mapped failure)
// must never override that result, and must never leak the underlying close error's .message — same
// values-free discipline as everything else reaching stderr. Without this, a throw inside main()'s
// `finally { await executor.close() }` would reject main()'s own returned promise from OUTSIDE every
// try/catch above it, bypassing closedCliErrorReason() entirely and reaching the entry-point wrapper
// (see isEntry below) as an unmapped rejection.
async function safeClose(executor) {
  if (!executor) return
  try {
    await executor.close()
  } catch {
    // intentionally silent — see comment above
  }
}

async function main(argv = process.argv.slice(2), env = process.env, { createExecutor = createPgExecutor } = {}) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`[gip-authority-substrate-inventory] ERROR: ${closedCliErrorReason(err)}\n`)
    return 1
  }
  if (opts.help) {
    printHelp()
    return 0
  }

  const databaseUrl = (env.DATABASE_URL || '').trim()

  if (opts.dryRun) {
    let executor = null
    try {
      if (databaseUrl) executor = await createExecutor(databaseUrl)
      const report = await buildDryRunReport({ exec: executor ? executor.exec : null, probe: opts.probe })
      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      } else {
        process.stdout.write(renderHumanSummary(report))
        process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n')
      }
      return 0
    } catch (err) {
      process.stderr.write(`[gip-authority-substrate-inventory] ERROR: ${closedCliErrorReason(err)}\n`)
      return 1
    } finally {
      await safeClose(executor)
    }
  }

  if (!databaseUrl) {
    process.stderr.write(`[gip-authority-substrate-inventory] ERROR: ${CLI_ERROR_REASON.DATABASE_URL_REQUIRED}\n`)
    return 2
  }

  let executor
  try {
    executor = await createExecutor(databaseUrl)
    const report = await buildReport({
      exec: executor.exec,
      probe: opts.probe,
      privateOutPath: opts.privateOutPath ? path.resolve(process.cwd(), opts.privateOutPath) : undefined,
      noPrivateOut: opts.noPrivateOut,
    })
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    } else {
      process.stdout.write(renderHumanSummary(report))
      process.stdout.write('\n' + JSON.stringify(report, null, 2) + '\n')
    }
    // The report is still printed above even in this case — a caller reading stdout gets the full
    // explanation — but the run must not be mistakable for a complete inventory by exit code alone
    // (see the header's Exit codes list and the ruling on ~L672 in the PR that added this check).
    // Exit-code contract test coverage (#4603 P2(b)): see the 'main() exit-code contract' describe
    // block in the test file — this line was previously reachable by none of the 127 tests.
    if (report.privateArtifact.consumableByWave2 === false) {
      return 1
    }
    return 0
  } catch (err) {
    process.stderr.write(`[gip-authority-substrate-inventory] ERROR: ${closedCliErrorReason(err)}\n`)
    return 1
  } finally {
    await safeClose(executor)
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null
const isEntry = entryPath && entryPath === fileURLToPath(import.meta.url)
if (isEntry) {
  // Last-resort net, not the normal path: every branch inside main() already resolves to a mapped
  // exit code via its own try/catch (see closedCliErrorReason() and safeClose() above). The reject
  // handler here exists only in case something still escapes both — without it, Node prints the
  // raw rejection (including any absolute path in its stack) straight to real stderr, and that
  // print happens OUTSIDE main()'s own stderr writes, so nothing inside this file can intercept or
  // redact it. Never interpolate the rejection reason here, for the same values-free discipline as
  // every other stderr write in this file.
  main().then(
    (code) => {
      process.exitCode = code
    },
    () => {
      process.stderr.write(`[gip-authority-substrate-inventory] ERROR: ${CLI_ERROR_REASON.RUNTIME_FAILURE}\n`)
      process.exitCode = 1
    },
  )
}

export {
  QUERY_ALLOWLIST,
  KNOWN_CERTIFIED_CONNECTOR_KINDS,
  KNOWN_CANONICAL_OBJECT_KEYS,
  EXTERNAL_SYSTEM_STATUSES,
  READ_SOURCE_CONFIG_STATUSES,
  assertReadOnlyAllowlist,
  isSafeNonNegativeInteger,
  INVALID_COUNT_REASON,
  runQuery,
  tableExists,
  probeColumns,
  probeSchema,
  tableSpecsForProbe,
  buildPlan,
  bucketByRegistry,
  splitRowsByStatus,
  executePlan,
  buildPublicKindSummary,
  buildPublicObjectKeySummary,
  computeKindVerdict,
  computeObjectKeyVerdict,
  RESIDUAL_NOTES,
  shouldWritePrivateArtifact,
  buildPrivateArtifactContent,
  writePrivateArtifact,
  defaultPrivateOutputPath,
  buildReport,
  buildDryRunReport,
  renderHumanSummary,
  parseArgs,
  CLI_ERROR_REASON,
  CliArgError,
  closedCliErrorReason,
  main,
  REPO_ROOT,
  DEFAULT_PRIVATE_OUTPUT_DIR,
}
