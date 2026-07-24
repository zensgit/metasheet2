import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  QUERY_ALLOWLIST,
  SUPPORTED_DATA_SOURCE_TYPES,
  EXTERNAL_SYSTEM_STATUSES,
  TARGET_KIND,
  assertReadOnlyAllowlist,
  probeSchema,
  buildPlan,
  bucketDataSourceTypeCounts,
  bucketExternalSystemStatusCounts,
  executePlan,
  enumerateStaticCallSites,
  buildAccessLogRecipe,
  buildResidualBlindSpots,
  STATIC_RESIDUAL_BLIND_SPOTS,
  computeVerdict,
  buildReport,
  buildDryRunReport,
  parseArgs,
  main,
} from './data-source-exposure-inventory.mjs'

// ---------------------------------------------------------------------------
// Fake DB harness
// ---------------------------------------------------------------------------

const SQL_TO_TAG = new Map(Object.entries(QUERY_ALLOWLIST).map(([tag, e]) => [e.sql, tag]))

/**
 * Builds a fake query executor from a schema description and a set of count
 * fixtures. Dispatch is by exact SQL-string identity against QUERY_ALLOWLIST
 * (never by regex/substring guessing), so a query the script does not
 * actually construct simply has no matching tag and throws "unrecognized sql".
 *
 * `counts[tag]` fixtures are OPTIONAL by design: if the plan never resolves
 * that tag to 'ok' (because a schema probe said a table/column is missing),
 * the corresponding count query must never be sent — and if it were sent,
 * this fake would throw "no fixture configured", which is exactly the
 * "never emits a query against an unverified shape" assertion made real.
 */
function createFakeExec({ schema, counts = {} }, calls = null) {
  return async (sql, params) => {
    const tag = SQL_TO_TAG.get(sql)
    if (!tag) {
      throw new Error(`fake exec: SQL string is not on QUERY_ALLOWLIST (unrecognized): ${sql}`)
    }
    if (calls) calls.push({ tag, sql, params })

    if (tag === 'probe.table_exists') {
      const [tableName] = params
      const t = schema[tableName]
      return { rows: t && t.exists ? [{ '?column?': 1 }] : [] }
    }
    if (tag === 'probe.columns') {
      const [tableName] = params
      const t = schema[tableName]
      const cols = t && t.exists ? t.columns : []
      return { rows: cols.map((c) => ({ column_name: c })) }
    }

    const handler = counts[tag]
    if (!handler) {
      throw new Error(`fake exec: no count fixture configured for tag "${tag}" — the plan should never have run this query`)
    }
    const rows = typeof handler === 'function' ? handler(params) : handler
    return { rows }
  }
}

const FULL_SCHEMA = Object.freeze({
  data_sources: { exists: true, columns: ['type', 'is_active', 'deleted_at', 'status'] },
  integration_external_systems: { exists: true, columns: ['id', 'kind', 'status'] },
  integration_read_source_configs: { exists: true, columns: ['system_id', 'status'] },
  integration_pipelines: { exists: true, columns: ['id', 'source_system_id'] },
  integration_runs: { exists: true, columns: ['id', 'pipeline_id', 'created_at'] },
})

function cloneSchema(overrides = {}) {
  const base = JSON.parse(JSON.stringify(FULL_SCHEMA))
  for (const [table, patch] of Object.entries(overrides)) {
    base[table] = { ...base[table], ...patch }
  }
  return base
}

const ZERO_COUNTS = Object.freeze({
  'count.data_sources_all_types': [],
  'count.data_sources_active_types.with_deleted_at': [],
  'count.external_systems_status_by_kind': [],
  'count.approved_read_source_configs_by_kind': [{ n: 0 }],
  'count.pipelines_by_source_kind': [{ n: 0 }],
  'count.runs_by_kind_window': [{ n: 0 }],
})

// ---------------------------------------------------------------------------
// QUERY_ALLOWLIST semantic-invariant extraction helpers (P1).
//
// createFakeExec dispatches by exact SQL-string identity against a SQL_TO_TAG
// map built from the SAME QUERY_ALLOWLIST under test. That makes every test
// above this comment self-consistent under corruption of the allowlist's SQL
// text: if the SQL is mutated, SQL_TO_TAG is rebuilt from the mutated text and
// the fake exec still "recognizes" it — the mutation is invisible to those
// tests no matter how wrong the resulting query would be against a real
// database. These helpers instead read the allowlist's SQL TEXT directly and
// assert semantic invariants against it: which tables it touches, which
// literal values it compares against, and its WHERE-clause predicate — the
// three things the prior NO-GO's errors got wrong (wrong table name, wrong
// status literal) plus the window predicate direction.
//
// Whitespace/formatting differences are normalized away (collapsed to single
// spaces) so a harmless reformat of the template-literal SQL does not go red;
// a changed table, a changed/added literal, or a changed predicate does.
// ---------------------------------------------------------------------------

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim()
}

// Every identifier immediately following FROM or JOIN, lowercased and
// deduplicated. Catches a swapped table name anywhere in the statement
// (e.g. the prior NO-GO's `integration_pipeline_runs` for `integration_runs`).
function extractTables(sql) {
  const re = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
  const tables = new Set()
  let m
  while ((m = re.exec(sql))) tables.add(m[1].toLowerCase())
  return [...tables].sort()
}

// Every single-quoted string literal in the statement, sorted. Catches any
// reintroduced status-vocabulary literal (the prior NO-GO's `<> 'disabled'`
// is a comparison against the literal 'disabled' — this flags that literal's
// mere presence, not just that one exact operator/spelling).
function extractQuotedLiterals(sql) {
  const re = /'([^']*)'/g
  const out = []
  let m
  while ((m = re.exec(sql))) out.push(m[1])
  return out.sort()
}

// The WHERE-clause predicate text (up to GROUP BY or end of statement),
// whitespace-normalized. Catches an added/removed filter (status exclusion),
// a broadened/narrowed kind scope, or a flipped window-predicate direction
// (`>=` silently becoming `<=`).
function extractWhereClause(sql) {
  const normalized = normalizeSql(sql)
  const m = /\bWHERE\s+(.*?)(?:\s+GROUP BY\b|\s*$)/i.exec(normalized)
  return m ? m[1].trim() : null
}

// ---------------------------------------------------------------------------
// assertReadOnlyAllowlist — structural read-only guard
// ---------------------------------------------------------------------------

describe('assertReadOnlyAllowlist', () => {
  test('accepts the real QUERY_ALLOWLIST (every entry is a SELECT)', () => {
    assert.doesNotThrow(() => assertReadOnlyAllowlist(QUERY_ALLOWLIST))
  })

  test('rejects a fixture allowlist containing a non-SELECT statement', () => {
    const bad = {
      'evil.update': { sql: `UPDATE data_sources SET status = 'active'`, describe: 'x' },
    }
    assert.throws(() => assertReadOnlyAllowlist(bad), /not a SELECT statement/)
  })

  test('rejects DELETE/INSERT/DROP the same way', () => {
    for (const sql of ['DELETE FROM data_sources', 'INSERT INTO data_sources VALUES (1)', 'DROP TABLE data_sources']) {
      assert.throws(() => assertReadOnlyAllowlist({ x: { sql, describe: 'x' } }), /not a SELECT statement/)
    }
  })

  // P3-B: the start-anchored `/^\s*SELECT\b/i` check alone would let a stacked
  // multi-statement query through as long as it *starts* with SELECT.
  test('rejects a SELECT with a non-trailing semicolon (stacked statement)', () => {
    for (const sql of [
      'SELECT 1; DROP TABLE data_sources',
      'SELECT 1;DROP TABLE data_sources',
      "SELECT 1; DELETE FROM data_sources WHERE 1=1",
    ]) {
      assert.throws(() => assertReadOnlyAllowlist({ x: { sql, describe: 'x' } }), /non-trailing semicolon/)
    }
  })

  test('accepts a SELECT with a single harmless trailing semicolon (or none at all)', () => {
    assert.doesNotThrow(() => assertReadOnlyAllowlist({ x: { sql: 'SELECT 1;', describe: 'x' } }))
    assert.doesNotThrow(() => assertReadOnlyAllowlist({ x: { sql: 'SELECT 1;   ', describe: 'x' } }))
    assert.doesNotThrow(() => assertReadOnlyAllowlist({ x: { sql: 'SELECT 1', describe: 'x' } }))
  })
})

// ---------------------------------------------------------------------------
// P1 — QUERY_ALLOWLIST SQL semantic invariants.
//
// Pins the SQL, not just the plumbing around it. Every test in this block
// reads QUERY_ALLOWLIST[tag].sql directly (never goes through createFakeExec's
// SQL-string dispatch) so a corruption of the allowlist's actual SQL text —
// including the prior NO-GO's errors #1 (`<> 'disabled'`) and #2
// (`integration_pipeline_runs`) verbatim — cannot hide behind a
// self-consistent fake executor.
// ---------------------------------------------------------------------------

describe('QUERY_ALLOWLIST SQL semantic invariants (pins the SQL text itself, not just the plan/plumbing around it)', () => {
  const EXPECTED = {
    'count.data_sources_all_types': {
      tables: ['data_sources'],
      literals: [],
      where: null,
    },
    'count.data_sources_active_types.with_deleted_at': {
      tables: ['data_sources'],
      literals: [],
      where: 'is_active = true and deleted_at is null',
    },
    'count.data_sources_active_types.without_deleted_at': {
      tables: ['data_sources'],
      literals: [],
      where: 'is_active = true',
    },
    'count.external_systems_status_by_kind': {
      tables: ['integration_external_systems'],
      literals: [],
      where: 'kind = $1',
    },
    'count.approved_read_source_configs_by_kind': {
      tables: ['integration_external_systems', 'integration_read_source_configs'],
      literals: ['approved'],
      where: "s.kind = $1 and c.status = 'approved'",
    },
    'count.pipelines_by_source_kind': {
      tables: ['integration_external_systems', 'integration_pipelines'],
      literals: [],
      where: 's.kind = $1',
    },
    'count.runs_by_kind_window': {
      tables: ['integration_external_systems', 'integration_pipelines', 'integration_runs'],
      literals: [],
      where: 's.kind = $1 and r.created_at >= now() - make_interval(days => $2::int)',
    },
  }

  for (const [tag, expected] of Object.entries(EXPECTED)) {
    describe(tag, () => {
      test(`queries exactly {${expected.tables.join(', ')}} — no other table (this is what catches a swapped table name, e.g. integration_pipeline_runs, anywhere in the statement)`, () => {
        assert.deepEqual(extractTables(QUERY_ALLOWLIST[tag].sql), expected.tables)
      })

      test(`quoted-literal set is exactly ${JSON.stringify([...expected.literals].sort())} (this is what catches any reintroduced status-vocabulary literal, e.g. 'disabled')`, () => {
        assert.deepEqual(extractQuotedLiterals(QUERY_ALLOWLIST[tag].sql), [...expected.literals].sort())
      })

      test(`WHERE predicate is exactly ${JSON.stringify(expected.where)} (kind-scoping / window-predicate pin; whitespace-normalized so a harmless reformat stays green)`, () => {
        const where = extractWhereClause(QUERY_ALLOWLIST[tag].sql)
        if (expected.where === null) {
          assert.equal(where, null)
        } else {
          assert.equal(where.toLowerCase(), expected.where)
        }
      })
    })
  }

  test('no allowlisted SQL statement anywhere contains the literal "disabled" (the exact vocabulary word the prior NO-GO invented)', () => {
    for (const [tag, entry] of Object.entries(QUERY_ALLOWLIST)) {
      assert.doesNotMatch(entry.sql, /disabled/i, `tag "${tag}" must not reference a "disabled" status — that value was never part of any real vocabulary`)
    }
  })

  test('no allowlisted SQL statement anywhere references integration_pipeline_runs (the exact nonexistent table the prior NO-GO invented)', () => {
    for (const [tag, entry] of Object.entries(QUERY_ALLOWLIST)) {
      assert.doesNotMatch(entry.sql, /integration_pipeline_runs/i, `tag "${tag}" must not reference integration_pipeline_runs — that table does not exist`)
    }
  })
})

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('defaults', () => {
    const opts = parseArgs([])
    assert.equal(opts.dryRun, false)
    assert.equal(opts.windowDays, 30)
    assert.equal(opts.json, false)
  })

  test('--dry-run and --plan are aliases', () => {
    assert.equal(parseArgs(['--dry-run']).dryRun, true)
    assert.equal(parseArgs(['--plan']).dryRun, true)
  })

  test('--window-days accepts a valid integer', () => {
    assert.equal(parseArgs(['--window-days', '7']).windowDays, 7)
  })

  test('--window-days rejects out-of-range and non-numeric values', () => {
    assert.throws(() => parseArgs(['--window-days', '0']), /between/)
    assert.throws(() => parseArgs(['--window-days', '9999']), /between/)
    assert.throws(() => parseArgs(['--window-days', 'DROP TABLE x']), /between/)
  })

  test('unknown flag throws', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  })

  test('--help sets help flag', () => {
    assert.equal(parseArgs(['--help']).help, true)
  })
})

// ---------------------------------------------------------------------------
// probeSchema — schema-probe-first behaviour
// ---------------------------------------------------------------------------

describe('probeSchema', () => {
  test('reports exists=false and all columns false for a missing table, without guessing', async () => {
    const schema = cloneSchema({ integration_runs: { exists: false, columns: [] } })
    const exec = createFakeExec({ schema, counts: {} })
    const probed = await probeSchema(exec)
    assert.equal(probed.integration_runs.exists, false)
    assert.deepEqual(probed.integration_runs.columns, { id: false, pipeline_id: false, created_at: false })
  })

  test('reports only the columns actually present', async () => {
    const schema = cloneSchema({ data_sources: { exists: true, columns: ['type', 'status'] } })
    const exec = createFakeExec({ schema, counts: {} })
    const probed = await probeSchema(exec)
    assert.deepEqual(probed.data_sources.columns, { type: true, is_active: false, deleted_at: false, status: true })
  })
})

// ---------------------------------------------------------------------------
// buildPlan + executePlan — the core "refuse to guess" contract
// ---------------------------------------------------------------------------

describe('buildPlan / executePlan: missing table -> UNAVAILABLE, never a blind query', () => {
  test('missing integration_runs makes runsWindow UNAVAILABLE and the count query is never sent', async () => {
    const schema = cloneSchema({ integration_runs: { exists: false, columns: [] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed, { windowDays: 30 })
    assert.equal(plan.runsWindow.status, 'unavailable')
    assert.match(plan.runsWindow.reason, /integration_runs/)

    // No fixture registered for count.runs_by_kind_window: if executePlan tried
    // to run it anyway, this would throw. It must not.
    const exec = createFakeExec({ schema, counts: { ...ZERO_COUNTS, 'count.runs_by_kind_window': undefined } })
    const coverage = await executePlan(exec, plan)
    assert.equal(coverage.runsWindow.status, 'unavailable')
  })

  test('missing integration_pipelines table cascades to both pipelines and runsWindow', async () => {
    const schema = cloneSchema({ integration_pipelines: { exists: false, columns: [] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed, { windowDays: 30 })
    assert.equal(plan.pipelines.status, 'unavailable')
    assert.equal(plan.runsWindow.status, 'unavailable')
  })

  test('missing data_sources table makes that item UNAVAILABLE (no type-bucketing query sent)', async () => {
    const schema = cloneSchema({ data_sources: { exists: false, columns: [] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed, { windowDays: 30 })
    assert.equal(plan.dataSources.status, 'unavailable')
    assert.match(plan.dataSources.reason, /data_sources not found/)
  })
})

describe('buildPlan / executePlan: missing column -> UNAVAILABLE, never a blind query', () => {
  test('missing integration_pipelines.source_system_id column', async () => {
    const schema = cloneSchema({ integration_pipelines: { exists: true, columns: ['id'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed, { windowDays: 30 })
    assert.equal(plan.pipelines.status, 'unavailable')
    assert.match(plan.pipelines.reason, /source_system_id/)
    assert.equal(plan.runsWindow.status, 'unavailable')
  })

  // P3-A: pins the integration_runs.created_at column check in planRunsWindow
  // (deleting that check previously left the suite green — this is the schema
  // shape that check exists to catch: pipeline_id present, created_at absent).
  test('integration_runs missing created_at (but pipeline_id present) -> runsWindow UNAVAILABLE, never a blind window query', async () => {
    const schema = cloneSchema({ integration_runs: { exists: true, columns: ['id', 'pipeline_id'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed, { windowDays: 30 })
    assert.equal(plan.runsWindow.status, 'unavailable')
    assert.match(plan.runsWindow.reason, /created_at/)

    const exec = createFakeExec({ schema, counts: { ...ZERO_COUNTS, 'count.runs_by_kind_window': undefined } })
    const coverage = await executePlan(exec, plan)
    assert.equal(coverage.runsWindow.status, 'unavailable')
  })

  test('missing integration_external_systems.status column', async () => {
    const schema = cloneSchema({ integration_external_systems: { exists: true, columns: ['id', 'kind'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed, { windowDays: 30 })
    assert.equal(plan.externalSystems.status, 'unavailable')
    assert.match(plan.externalSystems.reason, /status/)
  })

  test('data_sources missing is_active -> active sub-item UNAVAILABLE but registered total still resolves (this is the exact #4 landmine: legacy 040_data_sources.sql shape)', async () => {
    const schema = cloneSchema({ data_sources: { exists: true, columns: ['type', 'status'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed, { windowDays: 30 })
    assert.equal(plan.dataSources.status, 'ok')
    assert.equal(plan.dataSources.active.status, 'unavailable')
    assert.match(plan.dataSources.active.reason, /is_active/)
  })

  test('data_sources has is_active but not deleted_at -> uses the without_deleted_at variant', async () => {
    const schema = cloneSchema({ data_sources: { exists: true, columns: ['type', 'is_active'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed, { windowDays: 30 })
    assert.equal(plan.dataSources.active.status, 'ok')
    assert.equal(plan.dataSources.active.tag, 'count.data_sources_active_types.without_deleted_at')
  })
})

// ---------------------------------------------------------------------------
// Status vocabulary correctness — the exact bug class this script replaces
// ---------------------------------------------------------------------------

describe('bucketing uses the REAL status vocabulary (catches the `<> \'disabled\'` bug class)', () => {
  test('external systems: inactive and error rows are NOT counted as active', () => {
    const rows = [
      { status: 'active', n: 3 },
      { status: 'inactive', n: 5 },
      { status: 'error', n: 2 },
    ]
    const { buckets, total } = bucketExternalSystemStatusCounts(rows)
    assert.equal(buckets.active, 3)
    assert.equal(buckets.inactive, 5)
    assert.equal(buckets.error, 2)
    assert.equal(total, 10)
    // The specific regression this guards: a `<> 'disabled'` filter would have
    // read inactive+error rows as "enabled" (7), not 3.
    assert.notEqual(buckets.active, 7)
  })

  test('an unrecognised status value buckets to "unexpected", never silently dropped or miscounted as active', () => {
    const { buckets, total } = bucketExternalSystemStatusCounts([{ status: 'pending_migration', n: 4 }])
    assert.equal(buckets.active, 0)
    assert.equal(buckets.unexpected, 4)
    assert.equal(total, 4)
  })

  test('EXTERNAL_SYSTEM_STATUSES is exactly the three-value CHECK-constraint vocabulary', () => {
    assert.deepEqual([...EXTERNAL_SYSTEM_STATUSES].sort(), ['active', 'error', 'inactive'])
  })

  test('data source types: unknown/unpinned types bucket to "other", never fabricate a new key', () => {
    const { buckets, total } = bucketDataSourceTypeCounts([
      { type: 'postgresql', n: 2 },
      { type: 'some-future-adapter', n: 1 },
    ])
    assert.equal(buckets.postgresql, 2)
    assert.equal(buckets.other, 1)
    assert.equal(total, 3)
    assert.equal(Object.prototype.hasOwnProperty.call(buckets, 'some-future-adapter'), false)
  })

  test('SUPPORTED_DATA_SOURCE_TYPES matches the pinned DataSourceManager roster', () => {
    assert.deepEqual(
      [...SUPPORTED_DATA_SOURCE_TYPES].sort(),
      ['http', 'mysql', 'plm', 'postgres', 'postgresql', 'sqlserver'],
    )
  })
})

// ---------------------------------------------------------------------------
// Verdict — positive control: three distinct reachable outcomes
// ---------------------------------------------------------------------------

describe('computeVerdict', () => {
  function coverageFrom({ externalSystemsActive = 0, approvedConfigs = 0, pipelines = 0, runsWindow = 0, gap = null } = {}) {
    if (gap) {
      const ok = {
        dataSources: { status: 'ok', active: { status: 'ok' } },
        externalSystems: { status: 'ok', byStatus: { active: 0 } },
        approvedConfigs: { status: 'ok', count: 0 },
        pipelines: { status: 'ok', count: 0 },
        runsWindow: { status: 'ok', count: 0 },
        staticCallSiteEnumeration: { status: 'ok' },
      }
      ok[gap.key] = { status: 'unavailable', reason: gap.reason }
      return ok
    }
    return {
      dataSources: { status: 'ok', active: { status: 'ok' } },
      externalSystems: { status: 'ok', kind: TARGET_KIND, byStatus: { active: externalSystemsActive, inactive: 0, error: 0, unexpected: 0 } },
      approvedConfigs: { status: 'ok', count: approvedConfigs },
      pipelines: { status: 'ok', count: pipelines },
      runsWindow: { status: 'ok', count: runsWindow },
      staticCallSiteEnumeration: { status: 'ok' },
    }
  }

  test('full coverage + all-zero risk surface -> MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE', () => {
    const { verdict } = computeVerdict(coverageFrom({}))
    assert.equal(verdict, 'MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE')
  })

  test('full coverage + nonzero pipelines -> MIGRATION_REQUIRED', () => {
    const { verdict, reasons } = computeVerdict(coverageFrom({ pipelines: 2 }))
    assert.equal(verdict, 'MIGRATION_REQUIRED')
    assert.match(reasons.join(' '), /pipelines=2/)
  })

  test('full coverage + nonzero runsWindow only -> MIGRATION_REQUIRED', () => {
    const { verdict } = computeVerdict(coverageFrom({ runsWindow: 1 }))
    assert.equal(verdict, 'MIGRATION_REQUIRED')
  })

  test('partial coverage (one gap) -> INCONCLUSIVE, never a bare "0" / never MIGRATION_NOT_REQUIRED', () => {
    const { verdict, reasons } = computeVerdict(coverageFrom({ gap: { key: 'runsWindow', reason: 'missing table(s): integration_runs' } }))
    assert.equal(verdict, 'INCONCLUSIVE')
    assert.notEqual(verdict, 'MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE')
    assert.ok(reasons.length > 0)
    assert.match(reasons.join(' '), /partial/)
  })

  test('verdict is never literally "0" or falsy for any coverage shape', () => {
    for (const cov of [coverageFrom({}), coverageFrom({ pipelines: 5 }), coverageFrom({ gap: { key: 'pipelines', reason: 'x' } })]) {
      const { verdict } = computeVerdict(cov)
      assert.ok(verdict && typeof verdict === 'string' && verdict !== '0')
    }
  })

  // P2 regression: every DB coverage group that can independently go UNAVAILABLE
  // must independently force INCONCLUSIVE — "a test per coverage group", not one
  // representative case standing in for all of them.
  describe('every declared coverage group forces INCONCLUSIVE on its own when UNAVAILABLE', () => {
    for (const key of ['dataSources', 'externalSystems', 'approvedConfigs', 'pipelines', 'runsWindow']) {
      test(`${key} UNAVAILABLE alone -> INCONCLUSIVE (never MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE)`, () => {
        const { verdict, reasons } = computeVerdict(coverageFrom({ gap: { key, reason: `${key} gap reason` } }))
        assert.equal(verdict, 'INCONCLUSIVE')
        assert.notEqual(verdict, 'MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE')
        assert.match(reasons.join(' '), new RegExp(key))
      })
    }

    test('dataSources.active UNAVAILABLE (nested) -> INCONCLUSIVE even though dataSources.status itself is ok', () => {
      const cov = coverageFrom({})
      cov.dataSources = { status: 'ok', active: { status: 'unavailable', reason: 'is_active column not present' } }
      const { verdict, reasons } = computeVerdict(cov)
      assert.equal(verdict, 'INCONCLUSIVE')
      assert.match(reasons.join(' '), /dataSources\.active/)
    })

    // THE P2 FIX ITSELF: staticCallSiteEnumeration is a declared coverage group
    // (see COVERAGE_LABELS.staticCallSiteEnumeration / report.coverage.staticCallSiteEnumeration)
    // with a real fail-closed UNAVAILABLE state (enumerateStaticCallSites returns
    // it when an anchor file is missing/drifted). Before the fix, computeVerdict
    // never received this group at all, so it could emit
    // MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE while this entire coverage axis was
    // blind — confirmed live via buildReport({ repoRoot: <empty tmpdir> }) before
    // this fix landed (see task report for the exact repro).
    test('staticCallSiteEnumeration UNAVAILABLE (anchor drift) -> INCONCLUSIVE even though all DB coverage is OK and the risk surface is zero', () => {
      const cov = coverageFrom({})
      cov.staticCallSiteEnumeration = {
        status: 'unavailable',
        reason: 'anchor file(s)/pattern(s) not verified: select_route',
      }
      const { verdict, reasons } = computeVerdict(cov)
      assert.equal(verdict, 'INCONCLUSIVE')
      assert.notEqual(verdict, 'MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE')
      assert.match(reasons.join(' '), /staticCallSiteEnumeration/)
    })

    test('staticCallSiteEnumeration key entirely absent from the coverage object -> INCONCLUSIVE (fail closed on a missing signal, never fail open)', () => {
      const cov = coverageFrom({})
      delete cov.staticCallSiteEnumeration
      const { verdict } = computeVerdict(cov)
      assert.equal(verdict, 'INCONCLUSIVE')
    })
  })

  // accessLogRecipe is a declared coverage group too, but by construction it
  // never resolves to ok/unavailable — it is always an operator-run manual
  // recipe (see buildAccessLogRecipe). Pin that explicitly so "a test per
  // coverage group" is complete by construction, not by omission: there is no
  // accessLogRecipe UNAVAILABLE case to gate on because that state does not
  // exist.
  test('buildAccessLogRecipe never produces an ok/unavailable status — it is unconditionally "manual"', () => {
    const recipe = buildAccessLogRecipe({ windowDays: 30 })
    assert.equal(recipe.status, 'manual')
  })
})

// ---------------------------------------------------------------------------
// residual blind spots — always present, non-empty
// ---------------------------------------------------------------------------

describe('residual blind spots', () => {
  test('STATIC_RESIDUAL_BLIND_SPOTS always includes the undeployed-telemetry field', () => {
    assert.ok(STATIC_RESIDUAL_BLIND_SPOTS.some((b) => b.id === 'adapter_telemetry_not_deployed'))
    assert.ok(STATIC_RESIDUAL_BLIND_SPOTS.length > 0)
  })

  test('buildResidualBlindSpots is non-empty even for a fully-OK coverage', () => {
    const coverage = {
      dataSources: { status: 'ok', active: { status: 'ok' } },
      externalSystems: { status: 'ok' },
      approvedConfigs: { status: 'ok' },
      pipelines: { status: 'ok' },
      runsWindow: { status: 'ok' },
    }
    const spots = buildResidualBlindSpots(coverage)
    assert.ok(spots.length >= STATIC_RESIDUAL_BLIND_SPOTS.length)
  })

  test('buildResidualBlindSpots grows with real coverage gaps', () => {
    const coverage = {
      dataSources: { status: 'unavailable', reason: 'table data_sources not found' },
      externalSystems: { status: 'ok' },
      approvedConfigs: { status: 'ok' },
      pipelines: { status: 'ok' },
      runsWindow: { status: 'ok' },
    }
    const spots = buildResidualBlindSpots(coverage)
    assert.ok(spots.length > STATIC_RESIDUAL_BLIND_SPOTS.length)
    assert.ok(spots.some((b) => b.id === 'data_sources_table_gap'))
  })
})

// ---------------------------------------------------------------------------
// No SQL string ever contains a caller-controlled value
// ---------------------------------------------------------------------------

describe('no caller-controlled value ever reaches SQL text or params', () => {
  test('every executed query in a full report run is on the allowlist and every param is an expected constant', async () => {
    const calls = []
    const exec = createFakeExec({ schema: FULL_SCHEMA, counts: ZERO_COUNTS }, calls)
    await buildReport({ exec, windowDays: 17 })

    assert.ok(calls.length > 0)
    for (const call of calls) {
      // Structural: sql text is drawn from the fixed allowlist (guaranteed by
      // createFakeExec's lookup, which throws otherwise), so this loop is really
      // asserting the *params*.
      for (const p of call.params) {
        const isKnownString = typeof p === 'string' && (p === TARGET_KIND || Object.keys(FULL_SCHEMA).includes(p))
        const isWindowInt = typeof p === 'number' && Number.isInteger(p) && p === 17
        assert.ok(
          isKnownString || isWindowInt,
          `unexpected query parameter leaked into SQL bind params: ${JSON.stringify(p)} (tag=${call.tag})`,
        )
      }
    }
  })

  test('a crafted CLI window-days value cannot become a SQL string fragment (it is bound as an integer)', async () => {
    // parseArgs already rejects non-numeric --window-days (see parseArgs suite),
    // so the only way an integer reaches executePlan is a real integer bind param.
    const calls = []
    const exec = createFakeExec({ schema: FULL_SCHEMA, counts: ZERO_COUNTS }, calls)
    await buildReport({ exec, windowDays: 30 })
    const runsCall = calls.find((c) => c.tag === 'count.runs_by_kind_window')
    assert.ok(runsCall)
    assert.equal(typeof runsCall.params[1], 'number')
    assert.doesNotMatch(runsCall.sql, /\$\{|`\s*\+|days=30/)
  })
})

// ---------------------------------------------------------------------------
// Values-free by construction — LOAD-BEARING TEST
// ---------------------------------------------------------------------------

describe('values-free by construction (load-bearing)', () => {
  test('sentinel strings seeded into row content never appear anywhere in the serialized report', async () => {
    const SENTINEL_TYPE = 'SENTINEL_TYPE_9f3a1c88'
    const SENTINEL_ACTIVE_TYPE = 'SENTINEL_ACTIVE_TYPE_ae21f0'
    const SENTINEL_STATUS = 'SENTINEL_STATUS_7b2e44aa'
    const SENTINEL_HOSTNAME = 'sentinel-host-should-never-appear.internal'
    const SENTINEL_ID = 'sentinel-row-id-4471'

    const counts = {
      'count.data_sources_all_types': [
        { type: 'postgresql', n: 2 },
        { type: SENTINEL_TYPE, n: 1 }, // unknown type -> must bucket to "other", never leak
      ],
      'count.data_sources_active_types.with_deleted_at': [
        { type: 'postgresql', n: 1 },
        { type: SENTINEL_ACTIVE_TYPE, n: 1 }, // same bucketing path, exercised on the ACTIVE query too
      ],
      'count.external_systems_status_by_kind': [
        { status: 'active', n: 1 },
        { status: SENTINEL_STATUS, n: 1 }, // unknown status -> must bucket to "unexpected"
      ],
      'count.approved_read_source_configs_by_kind': [{ n: 1 }],
      'count.pipelines_by_source_kind': [{ n: 1 }],
      'count.runs_by_kind_window': [{ n: 1 }],
    }

    // Also plant sentinels in places the script must never even read into the
    // report: extra/irrelevant columns and identifiers a naive implementation
    // might be tempted to pass through.
    const schema = cloneSchema({
      data_sources: {
        exists: true,
        columns: ['type', 'is_active', 'deleted_at', 'status', SENTINEL_HOSTNAME, SENTINEL_ID],
      },
    })

    const exec = createFakeExec({ schema, counts })
    const report = await buildReport({ exec, windowDays: 30 })
    const serialized = JSON.stringify(report)

    for (const sentinel of [SENTINEL_TYPE, SENTINEL_ACTIVE_TYPE, SENTINEL_STATUS, SENTINEL_HOSTNAME, SENTINEL_ID]) {
      assert.equal(
        serialized.includes(sentinel),
        false,
        `values-free violation: sentinel "${sentinel}" leaked into the serialized report`,
      )
    }

    // And confirm the sentinel rows were still counted (bucketed), not silently dropped.
    assert.equal(report.coverage.dbInventory.dataSources.registeredByType.other, 1)
    assert.equal(report.coverage.dbInventory.dataSources.active.byType.other, 1)
    assert.equal(report.coverage.dbInventory.externalSystemsByStatus.byStatus.unexpected, 1)
  })

  test('the dry-run report (schema-probed branch) is also values-free', async () => {
    const SENTINEL = 'SENTINEL_DRYRUN_c001d00d'
    const schema = cloneSchema({
      data_sources: { exists: true, columns: ['type', 'is_active', 'deleted_at', 'status', SENTINEL] },
    })
    const exec = createFakeExec({ schema, counts: {} })
    const report = await buildDryRunReport({ exec, windowDays: 30 })
    assert.equal(JSON.stringify(report).includes(SENTINEL), false)
  })
})

// ---------------------------------------------------------------------------
// Dry-run gating: never print a query the probe would have refused
// ---------------------------------------------------------------------------

describe('dry-run gating', () => {
  test('with is_active missing, the active-count SQL text is never printed (only the UNAVAILABLE reason)', async () => {
    const schema = cloneSchema({ data_sources: { exists: true, columns: ['type', 'status'] } })
    const exec = createFakeExec({ schema, counts: {} })
    const report = await buildDryRunReport({ exec, windowDays: 30 })
    const serialized = JSON.stringify(report)

    assert.equal(report.plan.dataSources.active.status, 'unavailable')
    assert.equal(serialized.includes('WHERE is_active = true AND deleted_at IS NULL'), false)
    assert.equal(serialized.includes('WHERE is_active = true GROUP BY type'), false)
  })

  test('with integration_runs missing, the runs-window SQL is never printed', async () => {
    const schema = cloneSchema({ integration_runs: { exists: false, columns: [] } })
    const exec = createFakeExec({ schema, counts: {} })
    const report = await buildDryRunReport({ exec, windowDays: 30 })
    assert.equal(report.plan.runsWindow.status, 'unavailable')
    assert.equal(JSON.stringify(report).includes('make_interval'), false)
  })

  test('with a full schema, the dry-run plan resolves every item to "ok" and shows the exact SQL that report mode would run', async () => {
    const exec = createFakeExec({ schema: FULL_SCHEMA, counts: {} })
    const report = await buildDryRunReport({ exec, windowDays: 12 })
    assert.equal(report.mode, 'dry-run')
    for (const key of ['dataSources', 'externalSystems', 'approvedConfigs', 'pipelines', 'runsWindow']) {
      assert.equal(report.plan[key].status, 'ok')
    }
    assert.equal(report.plan.runsWindow.params[1], 12)
  })

  test('with no executor at all (no DATABASE_URL, no DB), falls back to a fully static plan and stays values-free', async () => {
    const report = await buildDryRunReport({ exec: null, windowDays: 30 })
    assert.equal(report.mode, 'dry-run-static')
    assert.ok(Object.keys(report.allowlist).length > 0)
  })
})

// ---------------------------------------------------------------------------
// Static in-repo caller enumeration
// ---------------------------------------------------------------------------

describe('enumerateStaticCallSites', () => {
  let tmpRoot

  function makeTmpRepo() {
    const root = mkdtempSync(path.join(tmpdir(), 'ds-exposure-inventory-'))
    mkdirSync(path.join(root, 'src', 'routes'), { recursive: true })
    mkdirSync(path.join(root, 'src', 'adapters'), { recursive: true })
    mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true })
    writeFileSync(
      path.join(root, 'src', 'routes', 'data-sources.ts'),
      `router.post('/api/data-sources/:id/select', () => {})\n`,
    )
    writeFileSync(
      path.join(root, 'src', 'adapters', 'DataSourceManager.ts'),
      `class X {\n  async select() { return sourceAdapter.select('t', {}) }\n  async copyData() {}\n}\n`,
    )
    writeFileSync(
      path.join(root, 'src', 'adapters', 'sql-readonly.cjs'),
      `async function run() { return api.select('t', {}) }\n`,
    )
    // A real (non-test) caller of copyData, plus a test-only caller that must
    // not count toward "live caller".
    writeFileSync(path.join(root, 'src', 'adapters', 'caller.ts'), `x.copyData({})\n`)
    writeFileSync(path.join(root, 'src', '__tests__', 'caller.test.ts'), `x.copyData({})\n`)
    return root
  }

  function anchorsFor(root) {
    return [
      { id: 'select_route', file: 'src/routes/data-sources.ts', pattern: /router\.post\(\s*'\/api\/data-sources\/:id\/select'/ },
      { id: 'manager_select_internal', file: 'src/adapters/DataSourceManager.ts', pattern: /sourceAdapter\.select\(/ },
      { id: 'copy_data_definition', file: 'src/adapters/DataSourceManager.ts', pattern: /async\s+copyData\(/ },
      { id: 'sql_readonly_adapter_select', file: 'src/adapters/sql-readonly.cjs', pattern: /\bapi\.select\(/ },
    ]
  }

  test('positive control: a tree containing known callers yields nonzero counts', () => {
    tmpRoot = makeTmpRepo()
    try {
      const result = enumerateStaticCallSites({ repoRoot: tmpRoot, anchors: anchorsFor(tmpRoot), scanRoots: ['src'] })
      assert.equal(result.status, 'ok')
      assert.ok(result.counts.managerOrAdapterSelectCallSites.nonTest >= 2) // sourceAdapter.select + api.select
      assert.equal(result.counts.copyDataCallSites.nonTest, 1)
      assert.equal(result.counts.copyDataCallSites.test, 1)
      assert.equal(result.counts.selectRouteDefinitions.nonTest, 1)
      assert.equal(result.knownCallers.find((k) => k.id === 'copy_data').hasLiveCaller, true)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('negative control: an empty tree (no callers) yields zero, not a thrown error', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ds-exposure-inventory-empty-'))
    try {
      mkdirSync(path.join(root, 'src', 'routes'), { recursive: true })
      mkdirSync(path.join(root, 'src', 'adapters'), { recursive: true })
      writeFileSync(path.join(root, 'src', 'routes', 'data-sources.ts'), `router.post('/api/data-sources/:id/select', () => {})\n`)
      writeFileSync(path.join(root, 'src', 'adapters', 'DataSourceManager.ts'), `sourceAdapter.select('t')\nasync copyData() {}\n`)
      writeFileSync(path.join(root, 'src', 'adapters', 'sql-readonly.cjs'), `api.select('t')\n`)
      const result = enumerateStaticCallSites({ repoRoot: root, anchors: anchorsFor(root), scanRoots: ['src'] })
      assert.equal(result.status, 'ok')
      assert.equal(result.counts.copyDataCallSites.nonTest, 0)
      assert.equal(result.knownCallers.find((k) => k.id === 'copy_data').hasLiveCaller, false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fail-closed: a missing anchor file makes the whole item UNAVAILABLE rather than reporting a possibly-wrong zero', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ds-exposure-inventory-missing-'))
    try {
      // No files created at all -> every anchor is missing.
      const result = enumerateStaticCallSites({ repoRoot: root, anchors: anchorsFor(root), scanRoots: ['src'] })
      assert.equal(result.status, 'unavailable')
      assert.ok(result.anchorsMissing.length === 4)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fail-closed: an anchor file present but with drifted content also fails closed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ds-exposure-inventory-drift-'))
    try {
      mkdirSync(path.join(root, 'src', 'routes'), { recursive: true })
      writeFileSync(path.join(root, 'src', 'routes', 'data-sources.ts'), `// the route used to be here but is gone\n`)
      const result = enumerateStaticCallSites({
        repoRoot: root,
        anchors: [anchorsFor(root)[0]],
        scanRoots: ['src'],
      })
      assert.equal(result.status, 'unavailable')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('the real repo anchors resolve OK against this actual checkout (drift guard)', () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
    const result = enumerateStaticCallSites({ repoRoot })
    assert.equal(result.status, 'ok', result.reason)
    assert.ok(result.scannedFileCount > 0)
  })
})

// ---------------------------------------------------------------------------
// End-to-end buildReport smoke + human summary
// ---------------------------------------------------------------------------

describe('buildReport end-to-end', () => {
  test('full schema, all-zero counts -> MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE and a non-empty residual list', async () => {
    const exec = createFakeExec({ schema: FULL_SCHEMA, counts: ZERO_COUNTS })
    const report = await buildReport({ exec, windowDays: 30 })
    assert.equal(report.verdict, 'MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE')
    assert.ok(report.residualBlindSpots.length > 0)
    assert.equal(report.observationWindow.days, 30)
    assert.equal(report.targetKind, TARGET_KIND)
  })

  test('P2 regression: full-zero DB coverage but staticCallSiteEnumeration UNAVAILABLE (repoRoot with no anchor files) -> INCONCLUSIVE, never MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE', async () => {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'ds-exposure-inventory-p2-empty-'))
    try {
      const exec = createFakeExec({ schema: FULL_SCHEMA, counts: ZERO_COUNTS })
      const report = await buildReport({ exec, windowDays: 30, repoRoot: emptyRoot })
      assert.equal(report.coverage.staticCallSiteEnumeration.status, 'unavailable')
      assert.equal(report.verdict, 'INCONCLUSIVE')
      assert.notEqual(report.verdict, 'MIGRATION_NOT_REQUIRED_WITHIN_COVERAGE')
      assert.match(report.verdictReasons.join(' '), /staticCallSiteEnumeration/)
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })

  test('full schema, one active external system -> MIGRATION_REQUIRED', async () => {
    const counts = { ...ZERO_COUNTS, 'count.external_systems_status_by_kind': [{ status: 'active', n: 1 }] }
    const exec = createFakeExec({ schema: FULL_SCHEMA, counts })
    const report = await buildReport({ exec, windowDays: 30 })
    assert.equal(report.verdict, 'MIGRATION_REQUIRED')
  })

  test('partial schema -> INCONCLUSIVE and coverage item carries a human-readable reason', async () => {
    const schema = cloneSchema({ integration_read_source_configs: { exists: false, columns: [] } })
    const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
    const report = await buildReport({ exec, windowDays: 30 })
    assert.equal(report.verdict, 'INCONCLUSIVE')
    assert.equal(report.coverage.dbInventory.approvedReadSourceConfigsBoundToKind.status, 'unavailable')
    assert.match(report.coverage.dbInventory.approvedReadSourceConfigsBoundToKind.reason, /integration_read_source_configs/)
  })

  test('every coverage group states WHAT IT COVERS and its blind spot (brief item 1-3 requirement), not just the global residual list', async () => {
    const exec = createFakeExec({ schema: FULL_SCHEMA, counts: ZERO_COUNTS })
    const report = await buildReport({ exec, windowDays: 30 })
    for (const group of [report.coverage.dbInventory, report.coverage.staticCallSiteEnumeration, report.coverage.accessLogRecipe]) {
      assert.equal(typeof group.covers, 'string')
      assert.ok(group.covers.length > 0)
      assert.equal(typeof group.blindSpot, 'string')
      assert.ok(group.blindSpot.length > 0)
    }
    // And each label is specific to its own item, not a copy-pasted duplicate.
    const labels = [report.coverage.dbInventory.covers, report.coverage.staticCallSiteEnumeration.covers, report.coverage.accessLogRecipe.covers]
    assert.equal(new Set(labels).size, labels.length)
  })

  test('the dry-run report ALSO carries covers/blindSpot on every coverage group (both the static and schema-probed branches)', async () => {
    const staticReport = await buildDryRunReport({ exec: null, windowDays: 30 })
    for (const group of [staticReport.coverage.staticCallSiteEnumeration, staticReport.coverage.accessLogRecipe]) {
      assert.ok(group.covers && group.blindSpot)
    }

    const exec = createFakeExec({ schema: FULL_SCHEMA, counts: {} })
    const probedReport = await buildDryRunReport({ exec, windowDays: 30 })
    for (const group of [probedReport.plan, probedReport.coverage.staticCallSiteEnumeration, probedReport.coverage.accessLogRecipe]) {
      assert.ok(group.covers && group.blindSpot)
    }
  })
})

// ---------------------------------------------------------------------------
// CLI entrypoint (hermetic only — never sets DATABASE_URL, never imports `pg`)
// ---------------------------------------------------------------------------

describe('main() CLI (hermetic paths only)', () => {
  test('--dry-run with no DATABASE_URL succeeds without touching a live DB or importing pg', async () => {
    const code = await main(['--dry-run', '--json'], {})
    assert.equal(code, 0)
  })

  test('report mode with no DATABASE_URL fails closed with exit code 2', async () => {
    const code = await main([], {})
    assert.equal(code, 2)
  })

  test('an invalid flag fails with exit code 1', async () => {
    const code = await main(['--not-a-real-flag'], {})
    assert.equal(code, 1)
  })

  test('--help exits 0', async () => {
    const code = await main(['--help'], {})
    assert.equal(code, 0)
  })
})
