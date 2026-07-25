import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  QUERY_ALLOWLIST,
  KNOWN_CERTIFIED_CONNECTOR_KINDS,
  KNOWN_CANONICAL_OBJECT_KEYS,
  EXTERNAL_SYSTEM_STATUSES,
  READ_SOURCE_CONFIG_STATUSES,
  assertReadOnlyAllowlist,
  probeSchema,
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
  buildReport,
  buildDryRunReport,
  parseArgs,
  REPO_ROOT,
  DEFAULT_PRIVATE_OUTPUT_DIR,
} from './gip-authority-substrate-inventory.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// Fake DB harness — dispatch by EXACT SQL-string identity against
// QUERY_ALLOWLIST, same discipline as #4594's pattern: a query the script did
// not actually construct has no matching tag and throws, and a fixture that
// was never consumed (because the plan correctly marked it UNAVAILABLE)
// proves "never emits a query against an unverified shape" for real rather
// than by assertion.
// ---------------------------------------------------------------------------

const SQL_TO_TAG = new Map(Object.entries(QUERY_ALLOWLIST).map(([tag, e]) => [e.sql, tag]))

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
  integration_external_systems: { exists: true, columns: ['id', 'kind', 'status'] },
  integration_read_source_configs: { exists: true, columns: ['id', 'object', 'status', 'config'] },
})

function cloneSchema(overrides = {}) {
  const base = JSON.parse(JSON.stringify(FULL_SCHEMA))
  for (const [table, patch] of Object.entries(overrides)) {
    base[table] = { ...base[table], ...patch }
  }
  return base
}

const ZERO_COUNTS = Object.freeze({
  'count.external_system_kinds_all': [],
  'count.external_system_kinds_active': [],
  'count.read_source_config_objects_by_status': [],
  'count.read_source_config_object_config_divergence': [{ n: 0 }],
})

// ---------------------------------------------------------------------------
// assertReadOnlyAllowlist — structural read-only guard
// ---------------------------------------------------------------------------

describe('assertReadOnlyAllowlist', () => {
  test('accepts the real QUERY_ALLOWLIST (every entry is a SELECT)', () => {
    assert.doesNotThrow(() => assertReadOnlyAllowlist(QUERY_ALLOWLIST))
  })

  test('rejects a fixture allowlist containing a non-SELECT statement', () => {
    const bad = { 'evil.update': { sql: `UPDATE integration_external_systems SET kind = 'x'`, describe: 'x' } }
    assert.throws(() => assertReadOnlyAllowlist(bad), /not a SELECT statement/)
  })

  test('rejects DELETE/INSERT/DROP the same way', () => {
    for (const sql of [
      'DELETE FROM integration_external_systems',
      'INSERT INTO integration_external_systems VALUES (1)',
      'DROP TABLE integration_external_systems',
    ]) {
      assert.throws(() => assertReadOnlyAllowlist({ x: { sql, describe: 'x' } }), /not a SELECT statement/)
    }
  })

  test('rejects a SELECT with a non-trailing semicolon (stacked statement)', () => {
    for (const sql of [
      'SELECT 1; DROP TABLE integration_external_systems',
      'SELECT 1;DROP TABLE integration_external_systems',
      'SELECT 1; DELETE FROM integration_read_source_configs WHERE 1=1',
    ]) {
      assert.throws(() => assertReadOnlyAllowlist({ x: { sql, describe: 'x' } }), /non-trailing semicolon/)
    }
  })

  test('accepts a SELECT with a single harmless trailing semicolon (or none at all)', () => {
    assert.doesNotThrow(() => assertReadOnlyAllowlist({ x: { sql: 'SELECT 1;', describe: 'x' } }))
    assert.doesNotThrow(() => assertReadOnlyAllowlist({ x: { sql: 'SELECT 1', describe: 'x' } }))
  })
})

// ---------------------------------------------------------------------------
// QUERY_ALLOWLIST SQL semantic invariants — pins the SQL TEXT itself, not
// just the fake-exec plumbing (which would stay green under a corrupted
// table/literal because SQL_TO_TAG is rebuilt from the same corrupted text).
// ---------------------------------------------------------------------------

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim()
}
function extractTables(sql) {
  const re = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi
  const tables = new Set()
  let m
  while ((m = re.exec(sql))) tables.add(m[1].toLowerCase())
  return [...tables].sort()
}
function extractQuotedLiterals(sql) {
  const re = /'([^']*)'/g
  const out = []
  let m
  while ((m = re.exec(sql))) out.push(m[1])
  return out.sort()
}
function extractWhereClause(sql) {
  const normalized = normalizeSql(sql)
  const m = /\bWHERE\s+(.*?)(?:\s+GROUP BY\b|\s*$)/i.exec(normalized)
  return m ? m[1].trim() : null
}

describe('QUERY_ALLOWLIST SQL semantic invariants', () => {
  const EXPECTED = {
    'count.external_system_kinds_all': {
      tables: ['integration_external_systems'],
      literals: [],
      where: null,
    },
    'count.external_system_kinds_active': {
      tables: ['integration_external_systems'],
      literals: ['active'],
      where: "status = 'active'",
    },
    'count.read_source_config_objects_by_status': {
      tables: ['integration_read_source_configs'],
      literals: [],
      where: null,
    },
    'count.read_source_config_object_config_divergence': {
      tables: ['integration_read_source_configs'],
      literals: ['object'],
      where: "object is distinct from (config ->> 'object')",
    },
  }

  for (const [tag, expected] of Object.entries(EXPECTED)) {
    describe(tag, () => {
      test(`queries exactly {${expected.tables.join(', ')}} — no other table`, () => {
        assert.deepEqual(extractTables(QUERY_ALLOWLIST[tag].sql), expected.tables)
      })
      test(`quoted-literal set is exactly ${JSON.stringify(expected.literals)}`, () => {
        assert.deepEqual(extractQuotedLiterals(QUERY_ALLOWLIST[tag].sql), [...expected.literals].sort())
      })
      test(`WHERE predicate is exactly ${JSON.stringify(expected.where)}`, () => {
        const where = extractWhereClause(QUERY_ALLOWLIST[tag].sql)
        if (expected.where === null) assert.equal(where, null)
        else assert.equal(where.toLowerCase(), expected.where)
      })
    })
  }

  test('the EXTERNAL_SYSTEM_STATUSES active literal used in the active-only query is a real member of the status vocabulary', () => {
    assert.ok(EXTERNAL_SYSTEM_STATUSES.includes('active'))
    assert.match(QUERY_ALLOWLIST['count.external_system_kinds_active'].sql, /status = 'active'/)
  })

  test('no allowlisted SQL statement anywhere contains a WHERE on kind (kind must never be filtered — the inventory covers every observed kind, known or not)', () => {
    for (const [tag, entry] of Object.entries(QUERY_ALLOWLIST)) {
      assert.doesNotMatch(entry.sql, /WHERE\s+kind\s*=/i, `tag "${tag}" must not filter on a specific kind value`)
    }
  })
})

// ---------------------------------------------------------------------------
// Schema-drift guard — reads the REAL migration files, not a comment. §5's
// landmine: a previous inventory was NO-GO for four assumed-schema errors: a
// citation in a header comment is not load-bearing, this is.
// ---------------------------------------------------------------------------

describe('schema-drift guard (reads real migration SQL from disk)', () => {
  const migration057 = readFileSync(
    path.join(REPO_ROOT, 'packages/core-backend/migrations/057_create_integration_core_tables.sql'),
    'utf8',
  )
  const migration062 = readFileSync(
    path.join(REPO_ROOT, 'packages/core-backend/migrations/062_create_integration_read_source_configs.sql'),
    'utf8',
  )

  test('integration_external_systems.kind is TEXT NOT NULL with no CHECK constraint (free-form — the whole reason β needs a probe, not a hardcoded enum)', () => {
    assert.match(migration057, /kind\s+TEXT NOT NULL/)
    // Confirms kind carries no CHECK(...) immediately after its declaration, unlike status.
    const kindLine = migration057.split('\n').find((l) => /^\s*kind\s+TEXT NOT NULL/.test(l))
    assert.ok(kindLine, 'expected a `kind TEXT NOT NULL` column declaration in migration 057')
    assert.doesNotMatch(kindLine, /CHECK/)
  })

  test('integration_external_systems.status CHECK vocabulary matches EXTERNAL_SYSTEM_STATUSES exactly', () => {
    const m = /status\s+TEXT NOT NULL DEFAULT '[^']*' CHECK \(status IN \(([^)]+)\)\)/.exec(migration057)
    assert.ok(m, 'expected a status CHECK(...) clause in migration 057')
    const vocab = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort()
    assert.deepEqual(vocab, [...EXTERNAL_SYSTEM_STATUSES].sort())
  })

  // Line-anchored, same shape as the `kind` guard above (M8-proof): a loose
  // `/object\s+TEXT NOT NULL/` match over the WHOLE FILE is satisfied by a
  // rename to `canonical_object` — that identifier still CONTAINS the
  // substring "object" immediately followed by "        TEXT NOT NULL", so a
  // non-anchored regex cannot tell "the object column" from "a column whose
  // name happens to end in object". Anchoring the match to line-start (after
  // only whitespace) closes that hole: "canonical_object" does not begin a
  // line with the literal token "object".
  test('integration_read_source_configs.object is TEXT NOT NULL — this IS the column the ledger calls objectKey (line-anchored: a rename to e.g. `canonical_object` must NOT satisfy this via the trailing "object" substring)', () => {
    const objectLine = migration062.split('\n').find((l) => /^\s*object\s+TEXT NOT NULL/.test(l))
    assert.ok(
      objectLine,
      'expected an `object TEXT NOT NULL` column declaration in migration 062, anchored at line start — a substring match (e.g. against `canonical_object`) does not count',
    )
  })

  test('integration_read_source_configs.status CHECK vocabulary matches READ_SOURCE_CONFIG_STATUSES exactly', () => {
    const m = /status\s+TEXT NOT NULL DEFAULT '[^']*' CHECK \(status IN \(([^)]+)\)\)/.exec(migration062)
    assert.ok(m, 'expected a status CHECK(...) clause in migration 062')
    const vocab = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort()
    assert.deepEqual(vocab, [...READ_SOURCE_CONFIG_STATUSES].sort())
  })

  // Word-boundary anchored (not just line-anchored, because this column sits
  // mid-line in a comma-separated index column list — `system_id, object,
  // mode` — so a naive substring match against `canonical_object` would pass
  // exactly the same way the old declaration test did). `\bobject\b` fails to
  // match inside `canonical_object`: the character immediately before the
  // trailing "object" is `_`, a word character, so there is no `\b` boundary
  // there — the regex engine cannot find a standalone "object" token. The
  // clause is extracted by literal marker + terminating `;`, not a
  // paren-counting regex, because the column list also contains
  // `COALESCE(workspace_id, '')`, whose internal comma/paren would otherwise
  // truncate a naive `\(([^)]*)\)` capture at the wrong `)`.
  test('integration_read_source_configs has both a unique index and the store keys the identical-content family on the standalone `object` column (word-boundary anchored: a rename to e.g. `canonical_object` must NOT satisfy this)', () => {
    const marker = 'uniq_integration_read_source_configs_content'
    const start = migration062.indexOf(marker)
    assert.ok(start !== -1, `expected to find "${marker}" in migration 062`)
    const end = migration062.indexOf(';', start)
    assert.ok(end !== -1, `expected a terminating ";" after "${marker}"`)
    const clause = migration062.slice(start, end + 1)
    assert.match(
      clause,
      /\bobject\b/,
      `expected a standalone "object" column reference in the ${marker} index clause, got: ${JSON.stringify(clause)}`,
    )
  })
})

// ---------------------------------------------------------------------------
// Frozen-registry mutation immunity — proves the FORBIDDEN clauses, not just
// asserts them in a comment.
// ---------------------------------------------------------------------------

describe('KNOWN_CERTIFIED_CONNECTOR_KINDS / KNOWN_CANONICAL_OBJECT_KEYS — never auto-populated', () => {
  test('both registries are empty today (no first-party registry exists yet on main)', () => {
    assert.deepEqual(KNOWN_CERTIFIED_CONNECTOR_KINDS, [])
    assert.deepEqual(KNOWN_CANONICAL_OBJECT_KEYS, [])
  })

  test('both are frozen — a push/mutation attempt throws (strict-mode ESM), never silently succeeds', () => {
    assert.throws(() => KNOWN_CERTIFIED_CONNECTOR_KINDS.push('sql:not-really'), TypeError)
    assert.throws(() => KNOWN_CANONICAL_OBJECT_KEYS.push('material'), TypeError)
    assert.throws(() => { KNOWN_CERTIFIED_CONNECTOR_KINDS[0] = 'x' }, TypeError)
  })

  test('running a full report against fixture rows carrying novel kind/object values never changes either registry (referential + content immunity)', async () => {
    const schema = cloneSchema()
    const before = [KNOWN_CERTIFIED_CONNECTOR_KINDS, KNOWN_CANONICAL_OBJECT_KEYS]
    const exec = createFakeExec({
      schema,
      counts: {
        'count.external_system_kinds_all': [
          { kind: 'erp:k3-wise-webapi', n: 3 },
          { kind: 'SENTINEL_NEVER_SEEN_KIND', n: 1 },
        ],
        'count.external_system_kinds_active': [{ kind: 'erp:k3-wise-webapi', n: 2 }],
        'count.read_source_config_objects_by_status': [
          { object: 'material', status: 'approved', n: 5 },
          { object: 'SENTINEL_NEVER_SEEN_OBJECT', status: 'approved', n: 1 },
        ],
        'count.read_source_config_object_config_divergence': [{ n: 0 }],
      },
    })
    await buildReport({ exec, noPrivateOut: true })
    // Same array objects (module-level `const`, frozen) — identity AND content unchanged.
    assert.equal(KNOWN_CERTIFIED_CONNECTOR_KINDS, before[0])
    assert.equal(KNOWN_CANONICAL_OBJECT_KEYS, before[1])
    assert.deepEqual(KNOWN_CERTIFIED_CONNECTOR_KINDS, [])
    assert.deepEqual(KNOWN_CANONICAL_OBJECT_KEYS, [])
  })
})

// ---------------------------------------------------------------------------
// bucketByRegistry — pure bucketing logic
// ---------------------------------------------------------------------------

describe('bucketByRegistry', () => {
  test('empty registry: everything observed is unregistered', () => {
    const { counts } = bucketByRegistry(
      [{ kind: 'a', n: 3 }, { kind: 'b', n: 5 }],
      [],
      { valueKey: 'kind' },
    )
    assert.equal(counts.distinctCount, 2)
    assert.equal(counts.totalRows, 8)
    assert.equal(counts.knownRegistrySize, 0)
    assert.equal(counts.registeredDistinctCount, 0)
    assert.equal(counts.unregisteredDistinctCount, 2)
    assert.equal(counts.registeredRowCount, 0)
    assert.equal(counts.unregisteredRowCount, 8)
  })

  test('non-empty registry: correctly splits registered vs unregistered, both distinct and row counts', () => {
    const { counts, detail } = bucketByRegistry(
      [{ kind: 'a', n: 3 }, { kind: 'b', n: 5 }, { kind: 'c', n: 2 }],
      ['a', 'c'],
      { valueKey: 'kind' },
    )
    assert.equal(counts.distinctCount, 3)
    assert.equal(counts.totalRows, 10)
    assert.equal(counts.registeredDistinctCount, 2)
    assert.equal(counts.unregisteredDistinctCount, 1)
    assert.equal(counts.registeredRowCount, 5) // a(3) + c(2)
    assert.equal(counts.unregisteredRowCount, 5) // b(5)
    assert.deepEqual(
      detail.sort((x, y) => x.value.localeCompare(y.value)),
      [
        { value: 'a', count: 3, registered: true },
        { value: 'b', count: 5, registered: false },
        { value: 'c', count: 2, registered: true },
      ],
    )
  })

  test('zero rows: distinct/total are zero, never treated as UNAVAILABLE (that is a schema-plan concern, not a bucketing concern)', () => {
    const { counts } = bucketByRegistry([], [], { valueKey: 'kind' })
    assert.equal(counts.distinctCount, 0)
    assert.equal(counts.totalRows, 0)
    assert.equal(counts.registeredDistinctCount, 0)
    assert.equal(counts.unregisteredDistinctCount, 0)
  })
})

// ---------------------------------------------------------------------------
// splitRowsByStatus
// ---------------------------------------------------------------------------

describe('splitRowsByStatus', () => {
  test('splits into draft/approved/retired', () => {
    const rows = [
      { object: 'a', status: 'draft', n: 1 },
      { object: 'b', status: 'approved', n: 2 },
      { object: 'c', status: 'retired', n: 3 },
    ]
    const out = splitRowsByStatus(rows)
    assert.deepEqual(out.draft, [rows[0]])
    assert.deepEqual(out.approved, [rows[1]])
    assert.deepEqual(out.retired, [rows[2]])
    assert.deepEqual(out.unexpected, [])
  })

  test('an out-of-vocabulary status is fail-closed into `unexpected`, never dropped or merged', () => {
    const rows = [{ object: 'x', status: 'some_future_status', n: 1 }]
    const out = splitRowsByStatus(rows)
    assert.deepEqual(out.unexpected, rows)
    assert.deepEqual(out.draft, [])
    assert.deepEqual(out.approved, [])
    assert.deepEqual(out.retired, [])
  })
})

// ---------------------------------------------------------------------------
// buildPlan / executePlan — schema-probe-first: missing table/column ->
// UNAVAILABLE, and the corresponding count query must never be sent.
// ---------------------------------------------------------------------------

describe('buildPlan / executePlan: missing table -> UNAVAILABLE, never a blind query', () => {
  test('missing integration_external_systems -> kindInventory UNAVAILABLE, no count query sent', async () => {
    const schema = cloneSchema({ integration_external_systems: { exists: false, columns: [] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed)
    assert.equal(plan.kindInventory.status, 'unavailable')
    assert.match(plan.kindInventory.reason, /integration_external_systems not found/)

    const exec = createFakeExec({ schema, counts: { ...ZERO_COUNTS, 'count.external_system_kinds_all': undefined, 'count.external_system_kinds_active': undefined } })
    const coverage = await executePlan(exec, plan)
    assert.equal(coverage.kindInventory.status, 'unavailable')
  })

  test('missing integration_read_source_configs -> objectKeyInventory UNAVAILABLE, no count query sent', async () => {
    const schema = cloneSchema({ integration_read_source_configs: { exists: false, columns: [] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed)
    assert.equal(plan.objectKeyInventory.status, 'unavailable')

    const exec = createFakeExec({
      schema,
      counts: { ...ZERO_COUNTS, 'count.read_source_config_objects_by_status': undefined, 'count.read_source_config_object_config_divergence': undefined },
    })
    const coverage = await executePlan(exec, plan)
    assert.equal(coverage.objectKeyInventory.status, 'unavailable')
  })
})

describe('buildPlan / executePlan: missing column -> UNAVAILABLE sub-item, never a blind query', () => {
  test('missing integration_external_systems.kind -> whole kindInventory unavailable', async () => {
    const schema = cloneSchema({ integration_external_systems: { exists: true, columns: ['id', 'status'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed)
    assert.equal(plan.kindInventory.status, 'unavailable')
    assert.match(plan.kindInventory.reason, /kind column not found/)
  })

  test('missing integration_external_systems.status -> allStatuses still ok, activeOnly unavailable, its count query never sent', async () => {
    const schema = cloneSchema({ integration_external_systems: { exists: true, columns: ['id', 'kind'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed)
    assert.equal(plan.kindInventory.status, 'ok')
    assert.equal(plan.kindInventory.allStatuses.status, 'ok')
    assert.equal(plan.kindInventory.activeOnly.status, 'unavailable')

    const exec = createFakeExec({
      schema,
      counts: {
        ...ZERO_COUNTS,
        'count.external_system_kinds_all': [{ kind: 'x', n: 1 }],
        'count.external_system_kinds_active': undefined,
      },
    })
    const coverage = await executePlan(exec, plan)
    assert.equal(coverage.kindInventory.allStatuses.status, 'ok')
    assert.equal(coverage.kindInventory.activeOnly.status, 'unavailable')
  })

  test('missing integration_read_source_configs.object -> whole objectKeyInventory unavailable', async () => {
    const schema = cloneSchema({ integration_read_source_configs: { exists: true, columns: ['id', 'status', 'config'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed)
    assert.equal(plan.objectKeyInventory.status, 'unavailable')
    assert.match(plan.objectKeyInventory.reason, /object/)
  })

  test('missing integration_read_source_configs.config -> byStatus still ok, divergence unavailable, its query never sent', async () => {
    const schema = cloneSchema({ integration_read_source_configs: { exists: true, columns: ['id', 'object', 'status'] } })
    const probed = await probeSchema(createFakeExec({ schema, counts: {} }))
    const plan = buildPlan(probed)
    assert.equal(plan.objectKeyInventory.status, 'ok')
    assert.equal(plan.objectKeyInventory.byStatus.status, 'ok')
    assert.equal(plan.objectKeyInventory.divergence.status, 'unavailable')

    const exec = createFakeExec({
      schema,
      counts: {
        ...ZERO_COUNTS,
        'count.read_source_config_objects_by_status': [],
        'count.read_source_config_object_config_divergence': undefined,
      },
    })
    const coverage = await executePlan(exec, plan)
    assert.equal(coverage.objectKeyInventory.divergence.status, 'unavailable')
  })
})

// ---------------------------------------------------------------------------
// Verdicts — three reachable outcomes each, INCONCLUSIVE forced by any
// UNAVAILABLE coverage (never a silent "0 unregistered" read as "nothing to
// map" when the underlying count could not actually be taken).
// ---------------------------------------------------------------------------

describe('computeKindVerdict', () => {
  test('INCONCLUSIVE when allStatuses coverage is unavailable', () => {
    const v = computeKindVerdict({ status: 'unavailable', reason: 'table gone' })
    assert.equal(v.verdict, 'INCONCLUSIVE')
  })

  test('CONNECTOR_KIND_MAPPING_NOT_REQUIRED_WITHIN_COVERAGE when zero rows observed', () => {
    const summary = buildPublicKindSummary({
      status: 'ok',
      allStatuses: { status: 'ok', counts: bucketByRegistry([], [], { valueKey: 'kind' }).counts, detail: [] },
      activeOnly: { status: 'ok', counts: bucketByRegistry([], [], { valueKey: 'kind' }).counts, detail: [] },
    })
    const v = computeKindVerdict(summary)
    assert.equal(v.verdict, 'CONNECTOR_KIND_MAPPING_NOT_REQUIRED_WITHIN_COVERAGE')
  })

  test('CONNECTOR_KIND_MAPPING_REQUIRED when any distinct kind is unregistered (registry is empty today, so any non-empty observation trips this)', () => {
    const bucketed = bucketByRegistry([{ kind: 'erp:k3-wise-webapi', n: 1 }], [], { valueKey: 'kind' })
    const summary = buildPublicKindSummary({
      status: 'ok',
      allStatuses: { status: 'ok', counts: bucketed.counts, detail: bucketed.detail },
      activeOnly: { status: 'ok', counts: bucketed.counts, detail: bucketed.detail },
    })
    const v = computeKindVerdict(summary)
    assert.equal(v.verdict, 'CONNECTOR_KIND_MAPPING_REQUIRED')
  })
})

describe('computeObjectKeyVerdict', () => {
  test('INCONCLUSIVE when the approved-status bucket is unavailable', () => {
    const v = computeObjectKeyVerdict({ status: 'unavailable', reason: 'table gone' })
    assert.equal(v.verdict, 'INCONCLUSIVE')
  })

  test('CANONICAL_OBJECT_BACKFILL_NOT_REQUIRED_WITHIN_COVERAGE when zero approved rows observed', () => {
    const empty = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const summary = buildPublicObjectKeySummary({
      status: 'ok',
      byStatus: {
        draft: { counts: empty, detail: [] },
        approved: { counts: empty, detail: [] },
        retired: { counts: empty, detail: [] },
        unexpected: { counts: empty, detail: [] },
      },
      divergence: { status: 'ok', count: 0 },
    })
    const v = computeObjectKeyVerdict(summary)
    assert.equal(v.verdict, 'CANONICAL_OBJECT_BACKFILL_NOT_REQUIRED_WITHIN_COVERAGE')
  })

  test('CANONICAL_OBJECT_BACKFILL_REQUIRED when an approved config references an unregistered object', () => {
    const approvedBucketed = bucketByRegistry([{ object: 'material', n: 4 }], [], { valueKey: 'object' })
    const empty = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const summary = buildPublicObjectKeySummary({
      status: 'ok',
      byStatus: {
        draft: { counts: empty, detail: [] },
        approved: { counts: approvedBucketed.counts, detail: approvedBucketed.detail },
        retired: { counts: empty, detail: [] },
        unexpected: { counts: empty, detail: [] },
      },
      divergence: { status: 'ok', count: 0 },
    })
    const v = computeObjectKeyVerdict(summary)
    assert.equal(v.verdict, 'CANONICAL_OBJECT_BACKFILL_REQUIRED')
  })

  test('draft-only references do NOT trip the (approved-scoped) verdict — pins the scope decision, not an oversight', () => {
    const draftBucketed = bucketByRegistry([{ object: 'material', n: 1 }], [], { valueKey: 'object' })
    const empty = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const summary = buildPublicObjectKeySummary({
      status: 'ok',
      byStatus: {
        draft: { counts: draftBucketed.counts, detail: draftBucketed.detail },
        approved: { counts: empty, detail: [] },
        retired: { counts: empty, detail: [] },
        unexpected: { counts: empty, detail: [] },
      },
      divergence: { status: 'ok', count: 0 },
    })
    const v = computeObjectKeyVerdict(summary)
    assert.equal(v.verdict, 'CANONICAL_OBJECT_BACKFILL_NOT_REQUIRED_WITHIN_COVERAGE')
  })

  // Same shape as the #4594-reviewer-caught bug this ledger's §1 records: a "within coverage"
  // verdict must never coexist with a KNOWN coverage defect. Here the defect is that `object`
  // (what the backfill list is built from) disagrees with config->>'object' for some row(s) — a
  // NOT_REQUIRED verdict alongside that would tell a human "nothing to do" while the very column
  // the report is built from is known-wrong for at least one row. Deliberately constructed so the
  // approved bucket ALONE would say NOT_REQUIRED (empty/all-registered) — divergence must be the
  // thing that flips it, not a confound.
  test('INCONCLUSIVE when divergence > 0, even though the approved bucket alone would say NOT_REQUIRED', () => {
    const empty = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const summary = buildPublicObjectKeySummary({
      status: 'ok',
      byStatus: {
        draft: { counts: empty, detail: [] },
        approved: { counts: empty, detail: [] },
        retired: { counts: empty, detail: [] },
        unexpected: { counts: empty, detail: [] },
      },
      divergence: { status: 'ok', count: 3 },
    })
    const v = computeObjectKeyVerdict(summary)
    assert.equal(v.verdict, 'INCONCLUSIVE')
    assert.ok(v.reasons.some((r) => r.includes('3 row(s)')))
  })

  test('INCONCLUSIVE when divergence > 0, even though the approved bucket alone would say REQUIRED (divergence reason still surfaces, not silently dropped behind the mapping-required reason)', () => {
    const approvedBucketed = bucketByRegistry([{ object: 'material', n: 1 }], [], { valueKey: 'object' })
    const empty = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const summary = buildPublicObjectKeySummary({
      status: 'ok',
      byStatus: {
        draft: { counts: empty, detail: [] },
        approved: { counts: approvedBucketed.counts, detail: approvedBucketed.detail },
        retired: { counts: empty, detail: [] },
        unexpected: { counts: empty, detail: [] },
      },
      divergence: { status: 'ok', count: 1 },
    })
    const v = computeObjectKeyVerdict(summary)
    assert.equal(v.verdict, 'INCONCLUSIVE')
  })

  test('INCONCLUSIVE when the divergence check itself is UNAVAILABLE, even with a clean approved bucket', () => {
    const empty = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const summary = buildPublicObjectKeySummary({
      status: 'ok',
      byStatus: {
        draft: { counts: empty, detail: [] },
        approved: { counts: empty, detail: [] },
        retired: { counts: empty, detail: [] },
        unexpected: { counts: empty, detail: [] },
      },
      divergence: { status: 'unavailable', reason: 'config column not found' },
    })
    const v = computeObjectKeyVerdict(summary)
    assert.equal(v.verdict, 'INCONCLUSIVE')
  })

  // splitRowsByStatus() fail-closes any row whose status is outside draft/approved/retired into
  // `unexpected` rather than dropping or merging it (see splitRowsByStatus tests above). Without
  // this check, a NOT_REQUIRED verdict could coexist with unregistered objectKeys sitting in an
  // unexpected status — exactly the "verdict alongside a known coverage defect" shape the
  // divergence check exists to prevent, just for a different coverage gap. Deliberately
  // constructed so the approved bucket ALONE and the divergence check ALONE would both say
  // "nothing wrong" (empty approved bucket, divergence count 0) — the unexpected bucket must be
  // the only thing flipping it, not a confound.
  test('INCONCLUSIVE when the unexpected-status bucket has any distinct objectKey, even though the approved bucket alone would say NOT_REQUIRED and divergence alone would say clean', () => {
    const empty = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const unexpectedBucketed = bucketByRegistry([{ object: 'material', n: 2 }], [], { valueKey: 'object' })
    const summary = buildPublicObjectKeySummary({
      status: 'ok',
      byStatus: {
        draft: { counts: empty, detail: [] },
        approved: { counts: empty, detail: [] },
        retired: { counts: empty, detail: [] },
        unexpected: { counts: unexpectedBucketed.counts, detail: unexpectedBucketed.detail },
      },
      divergence: { status: 'ok', count: 0 },
    })
    const v = computeObjectKeyVerdict(summary)
    assert.equal(v.verdict, 'INCONCLUSIVE')
    assert.ok(v.reasons.some((r) => r.includes('out-of-vocabulary')))
  })

  test('INCONCLUSIVE when the unexpected-status bucket has a distinct objectKey, even though the approved bucket alone would say REQUIRED (unexpected reason still surfaces, not silently dropped behind the mapping-required reason)', () => {
    const approvedBucketed = bucketByRegistry([{ object: 'material', n: 1 }], [], { valueKey: 'object' })
    const unexpectedBucketed = bucketByRegistry([{ object: 'other-thing', n: 1 }], [], { valueKey: 'object' })
    const empty = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const summary = buildPublicObjectKeySummary({
      status: 'ok',
      byStatus: {
        draft: { counts: empty, detail: [] },
        approved: { counts: approvedBucketed.counts, detail: approvedBucketed.detail },
        retired: { counts: empty, detail: [] },
        unexpected: { counts: unexpectedBucketed.counts, detail: unexpectedBucketed.detail },
      },
      divergence: { status: 'ok', count: 0 },
    })
    const v = computeObjectKeyVerdict(summary)
    assert.equal(v.verdict, 'INCONCLUSIVE')
  })
})

// ---------------------------------------------------------------------------
// EXACT KEY-SET assertion — a raw observed value can escape a plain
// sentinel-substring scan two different ways: (a) as a STRING VALUE (the
// sentinel-injection test below catches this), or (b) as an OBJECT KEY. A
// walk that does `for (const v of Object.values(node)) walk(v)` never once
// inspects `Object.keys(node)` — so a bug that keyed a bucket BY the
// observed kind/objectKey string (instead of by one of the fixed enum
// tokens this module actually uses: draft/approved/retired/unexpected,
// allStatuses/activeOnly, etc.) would sail through a values-walk undetected,
// because the walk never visits the key that carries the leak, only values
// nested under it. This asserts the key-set property DIRECTLY: at every
// level of coverage/verdicts/residualNotes, the object's key set is EXACTLY
// the fixed, closed set the source is structurally capable of producing —
// never a superset, so an unexpected key (a leaked raw value used as a key)
// fails loudly instead of silently passing a values-only scan.
// ---------------------------------------------------------------------------

const COUNTS_KEYS = [
  'status',
  'distinctCount',
  'totalRows',
  'knownRegistrySize',
  'registeredDistinctCount',
  'unregisteredDistinctCount',
  'registeredRowCount',
  'unregisteredRowCount',
]

function assertKeysExactly(obj, allowedKeys, ctx) {
  assert.ok(
    obj && typeof obj === 'object' && !Array.isArray(obj),
    `${ctx}: expected a plain object, got ${JSON.stringify(obj)}`,
  )
  const actual = Object.keys(obj).sort()
  const expected = [...allowedKeys].sort()
  assert.deepEqual(
    actual,
    expected,
    `${ctx}: key set mismatch — got ${JSON.stringify(actual)}, expected exactly ${JSON.stringify(expected)}`,
  )
}

function assertBucketKeysExactly(bucket, ctx) {
  if (bucket.status === 'ok') {
    assertKeysExactly(bucket, COUNTS_KEYS, ctx)
  } else {
    assertKeysExactly(bucket, ['status', 'reason'], ctx)
  }
}

// Walks the ACTUAL public report structure (not a hand-authored stand-in)
// and asserts, at every level, the exact key set. Covers every status
// branch (ok / unavailable / not_run) each field can take.
function assertPublicReportKeySetsExactly(report) {
  assertKeysExactly(report.coverage, ['connectorKindInventory', 'canonicalObjectKeyInventory'], 'report.coverage')

  const ck = report.coverage.connectorKindInventory
  if (ck.status === 'not_run') {
    assertKeysExactly(ck, ['covers', 'blindSpot', 'status'], 'coverage.connectorKindInventory (not_run)')
  } else if (ck.status !== 'ok') {
    assertKeysExactly(ck, ['covers', 'blindSpot', 'status', 'reason'], 'coverage.connectorKindInventory (unavailable)')
  } else {
    assertKeysExactly(
      ck,
      ['covers', 'blindSpot', 'status', 'allStatuses', 'activeOnly'],
      'coverage.connectorKindInventory (ok)',
    )
    assertBucketKeysExactly(ck.allStatuses, 'coverage.connectorKindInventory.allStatuses')
    assertBucketKeysExactly(ck.activeOnly, 'coverage.connectorKindInventory.activeOnly')
  }

  const okInv = report.coverage.canonicalObjectKeyInventory
  if (okInv.status === 'not_run') {
    assertKeysExactly(okInv, ['covers', 'blindSpot', 'status'], 'coverage.canonicalObjectKeyInventory (not_run)')
  } else if (okInv.status !== 'ok') {
    assertKeysExactly(
      okInv,
      ['covers', 'blindSpot', 'status', 'reason'],
      'coverage.canonicalObjectKeyInventory (unavailable)',
    )
  } else {
    assertKeysExactly(
      okInv,
      ['covers', 'blindSpot', 'status', 'byStatus', 'objectVsConfigObjectDivergence'],
      'coverage.canonicalObjectKeyInventory (ok)',
    )
    assertKeysExactly(
      okInv.byStatus,
      ['draft', 'approved', 'retired', 'unexpected'],
      'coverage.canonicalObjectKeyInventory.byStatus',
    )
    for (const key of ['draft', 'approved', 'retired', 'unexpected']) {
      assertBucketKeysExactly(okInv.byStatus[key], `coverage.canonicalObjectKeyInventory.byStatus.${key}`)
    }
    const div = okInv.objectVsConfigObjectDivergence
    if (div.status === 'ok') assertKeysExactly(div, ['status', 'count'], 'objectVsConfigObjectDivergence (ok)')
    else assertKeysExactly(div, ['status', 'reason'], 'objectVsConfigObjectDivergence (unavailable)')
  }

  assertKeysExactly(report.verdicts, ['connectorKind', 'canonicalObjectKey'], 'report.verdicts')
  for (const vk of ['connectorKind', 'canonicalObjectKey']) {
    const v = report.verdicts[vk]
    if (v !== null) {
      assertKeysExactly(v, ['verdict', 'reasons'], `report.verdicts.${vk}`)
      assert.ok(Array.isArray(v.reasons), `report.verdicts.${vk}.reasons must be an array`)
      for (const r of v.reasons) assert.equal(typeof r, 'string', `report.verdicts.${vk}.reasons[] must be strings`)
    }
  }

  assert.ok(Array.isArray(report.residualNotes), 'report.residualNotes must be an array')
  for (const note of report.residualNotes) {
    assertKeysExactly(note, ['id', 'description'], 'report.residualNotes[]')
  }
}

// ---------------------------------------------------------------------------
// VALUES-FREE PUBLIC OUTPUT — the load-bearing test. Injects sentinel raw
// strings through the fake executor and proves, mechanically, that they
// cannot reach the serialized public report — not by code review, by a
// positive control (the sentinel DOES appear in the private artefact file,
// so this is not "the sentinel never flows anywhere") and a negative control
// (it does NOT appear in the report object returned to the caller / printed
// to stdout).
// ---------------------------------------------------------------------------

describe('values-free public output (sentinel injection)', () => {
  const SENTINEL_KIND = 'SENTINEL_KIND_MUST_NEVER_LEAK_INTO_PUBLIC_OUTPUT_0xACAB'
  const SENTINEL_OBJECT = 'SENTINEL_OBJECT_MUST_NEVER_LEAK_INTO_PUBLIC_OUTPUT_0xFEED'

  function scratchDir() {
    return mkdtempSync(path.join(tmpdir(), 'gip-authority-inventory-test-'))
  }

  test('sentinel kind/object strings do not appear anywhere in JSON.stringify(report), even though they were the only rows observed', async () => {
    const dir = scratchDir()
    try {
      const schema = cloneSchema()
      const exec = createFakeExec({
        schema,
        counts: {
          'count.external_system_kinds_all': [{ kind: SENTINEL_KIND, n: 7 }],
          'count.external_system_kinds_active': [{ kind: SENTINEL_KIND, n: 7 }],
          'count.read_source_config_objects_by_status': [{ object: SENTINEL_OBJECT, status: 'approved', n: 9 }],
          'count.read_source_config_object_config_divergence': [{ n: 0 }],
        },
      })
      const privateOutPath = path.join(dir, 'private.json')
      const report = await buildReport({ exec, privateOutPath })

      const serialized = JSON.stringify(report)
      assert.doesNotMatch(serialized, new RegExp(SENTINEL_KIND))
      assert.doesNotMatch(serialized, new RegExp(SENTINEL_OBJECT))

      // Positive control: the raw values are NOT silently dropped — they exist,
      // just in the private artefact, not in the report. Confirms the previous
      // negative assertion means "moved to the right place", not "lost".
      const privateContent = readFileSync(privateOutPath, 'utf8')
      assert.match(privateContent, new RegExp(SENTINEL_KIND))
      assert.match(privateContent, new RegExp(SENTINEL_OBJECT))

      // The report's own pointer to that file must be a path only, never content.
      assert.equal(report.privateArtifact.status, 'written')
      assert.doesNotMatch(JSON.stringify(report.privateArtifact), new RegExp(SENTINEL_KIND))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('EXACT key-set check: coverage/verdicts/residualNotes carry exactly the fixed, authored key set at every level — not merely "no sentinel substring in a value" (a raw value used AS A KEY would pass a values-only scan; this catches that class directly)', async () => {
    const dir = scratchDir()
    try {
      const schema = cloneSchema()
      const exec = createFakeExec({
        schema,
        counts: {
          'count.external_system_kinds_all': [{ kind: SENTINEL_KIND, n: 1 }, { kind: 'another-unseen-kind', n: 2 }],
          'count.external_system_kinds_active': [{ kind: SENTINEL_KIND, n: 1 }],
          'count.read_source_config_objects_by_status': [
            { object: SENTINEL_OBJECT, status: 'approved', n: 1 },
            { object: 'yet-another-object', status: 'draft', n: 1 },
          ],
          'count.read_source_config_object_config_divergence': [{ n: 2 }],
        },
      })
      const privateOutPath = path.join(dir, 'private.json')
      const report = await buildReport({ exec, privateOutPath })

      // The exact-key-set walk subsumes the old sentinel-substring scan for
      // any leak reachable as a plain string VALUE too — deepEqual on a
      // key set diverges the instant an unexpected property name (including
      // one equal to a sentinel) appears anywhere in this shape.
      assertPublicReportKeySetsExactly(report)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('EXACT key-set check holds across the unavailable and not_run branches too (missing column / --probe scoping), not just the all-ok happy path', async () => {
    // unavailable: integration_external_systems.status column absent -> activeOnly UNAVAILABLE,
    // and canonicalObjectKeyInventory entirely not_run via --probe beta.
    const schema = cloneSchema({ integration_external_systems: { exists: true, columns: ['id', 'kind'] } })
    const exec = createFakeExec({
      schema,
      counts: {
        'count.external_system_kinds_all': [{ kind: 'erp:k3-wise-webapi', n: 1 }],
      },
    })
    const report = await buildReport({ exec, probe: 'beta', noPrivateOut: true })
    assert.equal(report.coverage.connectorKindInventory.activeOnly.status, 'unavailable')
    assert.equal(report.coverage.canonicalObjectKeyInventory.status, 'not_run')
    assertPublicReportKeySetsExactly(report)
  })
})

// ---------------------------------------------------------------------------
// Private artefact — fail-closed write behaviour
// ---------------------------------------------------------------------------

describe('private artefact write behaviour', () => {
  function scratchDir() {
    return mkdtempSync(path.join(tmpdir(), 'gip-authority-inventory-test-'))
  }

  test('shouldWritePrivateArtifact is true when any bucket has an unregistered distinct value', () => {
    const bucketed = bucketByRegistry([{ kind: 'x', n: 1 }], [], { valueKey: 'kind' })
    const emptyObj = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const owed = shouldWritePrivateArtifact({
      kindInventory: { status: 'ok', allStatuses: { status: 'ok', counts: bucketed.counts }, activeOnly: { status: 'ok', counts: bucketed.counts } },
      objectKeyInventory: {
        status: 'ok',
        byStatus: { draft: { counts: emptyObj }, approved: { counts: emptyObj }, retired: { counts: emptyObj }, unexpected: { counts: emptyObj } },
      },
    })
    assert.equal(owed, true)
  })

  test('shouldWritePrivateArtifact is false when both inventories are all-registered/empty', () => {
    const emptyKind = bucketByRegistry([], [], { valueKey: 'kind' }).counts
    const emptyObj = bucketByRegistry([], [], { valueKey: 'object' }).counts
    const owed = shouldWritePrivateArtifact({
      kindInventory: { status: 'ok', allStatuses: { status: 'ok', counts: emptyKind }, activeOnly: { status: 'ok', counts: emptyKind } },
      objectKeyInventory: {
        status: 'ok',
        byStatus: { draft: { counts: emptyObj }, approved: { counts: emptyObj }, retired: { counts: emptyObj }, unexpected: { counts: emptyObj } },
      },
    })
    assert.equal(owed, false)
  })

  test('FAIL CLOSED: write failure with something owed makes buildReport() reject, and the error message carries no raw value', async () => {
    const dir = scratchDir()
    try {
      const schema = cloneSchema()
      const exec = createFakeExec({
        schema,
        counts: {
          'count.external_system_kinds_all': [{ kind: 'SENTINEL_SHOULD_NOT_APPEAR_IN_ERROR', n: 1 }],
          'count.external_system_kinds_active': [],
          'count.read_source_config_objects_by_status': [],
          'count.read_source_config_object_config_divergence': [{ n: 0 }],
        },
      })
      // A regular FILE (not a directory) as the parent of the target path makes
      // mkdirSync throw ENOTDIR — a real, unmocked filesystem failure.
      const blockerFile = path.join(dir, 'blocker')
      writeFileSync(blockerFile, 'x')
      const privateOutPath = path.join(blockerFile, 'sub', 'private.json')

      await assert.rejects(
        () => buildReport({ exec, privateOutPath }),
        (err) => {
          assert.match(err.message, /could not be written/)
          assert.doesNotMatch(err.message, /SENTINEL_SHOULD_NOT_APPEAR_IN_ERROR/)
          return true
        },
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('write failure with NOTHING owed does not fail the run', async () => {
    const dir = scratchDir()
    try {
      const schema = cloneSchema()
      const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
      const blockerFile = path.join(dir, 'blocker')
      writeFileSync(blockerFile, 'x')
      const privateOutPath = path.join(blockerFile, 'sub', 'private.json')

      const report = await buildReport({ exec, privateOutPath })
      assert.equal(report.privateArtifact.status, 'write_failed_but_nothing_owed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('--no-private-out skips the write entirely, even when something is owed', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({
      schema,
      counts: {
        'count.external_system_kinds_all': [{ kind: 'x', n: 1 }],
        'count.external_system_kinds_active': [],
        'count.read_source_config_objects_by_status': [],
        'count.read_source_config_object_config_divergence': [{ n: 0 }],
      },
    })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.equal(report.privateArtifact.status, 'skipped_by_flag')
  })

  test('buildPrivateArtifactContent carries the raw detail (this is the ONLY function permitted to)', () => {
    const bucketed = bucketByRegistry([{ kind: 'erp:k3-wise-webapi', n: 1 }], [], { valueKey: 'kind' })
    const objBucketed = bucketByRegistry([{ object: 'material', n: 1 }], [], { valueKey: 'object' })
    const empty = bucketByRegistry([], [], { valueKey: 'object' })
    const content = buildPrivateArtifactContent(
      {
        kindInventory: { status: 'ok', allStatuses: { detail: bucketed.detail }, activeOnly: { status: 'ok', detail: bucketed.detail } },
        objectKeyInventory: {
          status: 'ok',
          byStatus: { draft: { detail: empty.detail }, approved: { detail: objBucketed.detail }, retired: { detail: empty.detail }, unexpected: { detail: empty.detail } },
        },
      },
      { generatedAt: '2026-07-25T00:00:00.000Z' },
    )
    assert.deepEqual(content.connectorKinds.allStatuses, bucketed.detail)
    assert.deepEqual(content.objectKeys.approved, objBucketed.detail)
    assert.match(content.warning, /Never commit/)
  })
})

// ---------------------------------------------------------------------------
// residualNotes — always present, never empty
// ---------------------------------------------------------------------------

describe('RESIDUAL_NOTES', () => {
  test('is non-empty and states the empty-registry caveat explicitly', () => {
    assert.ok(RESIDUAL_NOTES.length > 0)
    assert.ok(RESIDUAL_NOTES.some((n) => n.id === 'known_registries_empty_by_design'))
    assert.ok(RESIDUAL_NOTES.some((n) => n.id === 'no_customer_deployment_connection'))
  })

  // γ's ledger scope is the READ-side qualification-input tuple's objectKey
  // (integration_read_source_configs.object, migration 062). A second objectKey reference class —
  // integration_write_target_configs.object (migration 064) — exists in the same database and this
  // script never queries it. That must be a stated, findable residual note, not a silent gap.
  test('states the integration_write_target_configs.object (migration 064) out-of-scope caveat, naming both the table and the migration', () => {
    const note = RESIDUAL_NOTES.find((n) => n.id === 'integration_write_target_configs_object_deliberately_out_of_scope')
    assert.ok(note, 'expected a RESIDUAL_NOTES entry documenting integration_write_target_configs.object as out of scope')
    assert.match(note.description, /integration_write_target_configs/)
    assert.match(note.description, /migration 064/)
  })

  test('the γ coverage blindSpot string also names integration_write_target_configs.object as out of scope (not just buried in residualNotes)', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.match(report.coverage.canonicalObjectKeyInventory.blindSpot, /integration_write_target_configs/)
  })
})

// ---------------------------------------------------------------------------
// --probe beta|gamma|both
// ---------------------------------------------------------------------------

describe('--probe scoping', () => {
  // The property that actually matters: under --probe beta, NO query touching
  // integration_read_source_configs is ever issued — not merely that its summary is suppressed.
  // A fixture with NO count.read_source_config_* entries proves this by construction: if
  // executeObjectKeyInventoryPlan ran anyway, createFakeExec would throw "no count fixture
  // configured" before this test could even reach its assertions. The `calls` array is a second,
  // independent check of the same property, and also proves the schema for
  // integration_read_source_configs was never probed either — buildPlan() short-circuited BEFORE
  // planObjectKeyInventory ever looked at it.
  test('probe=beta issues zero queries against integration_read_source_configs (schema probe included) and writes no γ objectKey value into the private artefact', async () => {
    const schema = cloneSchema()
    const calls = []
    const exec = createFakeExec(
      {
        schema,
        counts: {
          'count.external_system_kinds_all': [{ kind: 'erp:k3-wise-webapi', n: 1 }],
          'count.external_system_kinds_active': [{ kind: 'erp:k3-wise-webapi', n: 1 }],
          // Deliberately NO count.read_source_config_* fixtures — if the γ probe ran under
          // --probe beta, the fake exec would throw before any assertion below runs.
        },
      },
      calls,
    )
    const report = await buildReport({ exec, probe: 'beta', noPrivateOut: true })
    assert.equal(report.coverage.connectorKindInventory.status, 'ok')
    assert.equal(report.coverage.canonicalObjectKeyInventory.status, 'not_run')
    assert.equal(report.verdicts.canonicalObjectKey, null)
    assert.notEqual(report.verdicts.connectorKind, null)

    // No probe.table_exists / probe.columns call for integration_read_source_configs, and no
    // count.read_source_config_* tag at all.
    const readSourceConfigCalls = calls.filter(
      (c) => c.tag.startsWith('count.read_source_config') || (c.params && c.params[0] === 'integration_read_source_configs'),
    )
    assert.deepEqual(readSourceConfigCalls, [])
  })

  test('probe=beta with something owed: shouldWritePrivateArtifact / buildPrivateArtifactContent see objectKeyInventory as not_run, never write a γ value', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({
      schema,
      counts: {
        'count.external_system_kinds_all': [{ kind: 'SENTINEL_BETA_ONLY_KIND', n: 1 }],
        'count.external_system_kinds_active': [{ kind: 'SENTINEL_BETA_ONLY_KIND', n: 1 }],
      },
    })
    const dir = mkdtempSync(path.join(tmpdir(), 'gip-authority-inventory-test-'))
    try {
      const privateOutPath = path.join(dir, 'private.json')
      const report = await buildReport({ exec, probe: 'beta', privateOutPath })
      assert.equal(report.privateArtifact.status, 'written')
      const content = JSON.parse(readFileSync(privateOutPath, 'utf8'))
      assert.deepEqual(content.objectKeys, {}) // γ never ran — nothing to have leaked, and nothing did
      assert.deepEqual(content.connectorKinds.allStatuses, [{ value: 'SENTINEL_BETA_ONLY_KIND', count: 1, registered: false }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('probe=gamma issues zero queries against integration_external_systems and writes no β kind value into the private artefact', async () => {
    const schema = cloneSchema()
    const calls = []
    const exec = createFakeExec(
      {
        schema,
        counts: {
          'count.read_source_config_objects_by_status': [{ object: 'material', status: 'approved', n: 1 }],
          'count.read_source_config_object_config_divergence': [{ n: 0 }],
          // Deliberately NO count.external_system_kinds_* fixtures.
        },
      },
      calls,
    )
    const report = await buildReport({ exec, probe: 'gamma', noPrivateOut: true })
    assert.equal(report.coverage.canonicalObjectKeyInventory.status, 'ok')
    assert.equal(report.coverage.connectorKindInventory.status, 'not_run')
    assert.equal(report.verdicts.connectorKind, null)

    const externalSystemCalls = calls.filter(
      (c) => c.tag.startsWith('count.external_system') || (c.params && c.params[0] === 'integration_external_systems'),
    )
    assert.deepEqual(externalSystemCalls, [])
  })
})

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

describe('buildDryRunReport', () => {
  test('no executor: static allowlist listing, no DB required', async () => {
    const report = await buildDryRunReport({ exec: null })
    assert.equal(report.mode, 'dry-run-static')
    assert.ok(Object.keys(report.allowlist).length === Object.keys(QUERY_ALLOWLIST).length)
    assert.equal(report.knownRegistrySizes.connectorKind, 0)
    assert.equal(report.knownRegistrySizes.canonicalObjectKey, 0)
  })

  test('with executor: schema IS probed, plan resolved, no count query executed', async () => {
    const schema = cloneSchema()
    const calls = []
    const exec = createFakeExec({ schema, counts: {} }, calls)
    const report = await buildDryRunReport({ exec })
    assert.equal(report.mode, 'dry-run')
    assert.equal(report.probe, 'both')
    assert.equal(report.plan.kindInventory.status, 'ok')
    // Only schema-probe tags were called — no count.* tag.
    assert.ok(calls.every((c) => c.tag.startsWith('probe.')))
  })

  // `--probe` must scope `--dry-run` the same way it scopes report mode — otherwise a PR claiming
  // "under --probe beta, no query naming integration_read_source_configs is ever issued — schema
  // probe included" is false specifically in dry-run mode, where buildDryRunReport() used to always
  // probe the FULL TABLE_SPECS regardless of the requested probe.
  test('probe=beta scopes the DRY-RUN schema probe too: zero information_schema calls name integration_read_source_configs, and the objectKeyInventory plan is not_run', async () => {
    const schema = cloneSchema()
    const calls = []
    const exec = createFakeExec({ schema, counts: {} }, calls)
    const report = await buildDryRunReport({ exec, probe: 'beta' })
    assert.equal(report.probe, 'beta')
    assert.equal(report.plan.kindInventory.status, 'ok')
    assert.equal(report.plan.objectKeyInventory.status, 'not_run')
    const readSourceConfigCalls = calls.filter((c) => c.params && c.params[0] === 'integration_read_source_configs')
    assert.deepEqual(readSourceConfigCalls, [])
  })

  test('probe=gamma scopes the DRY-RUN schema probe too: zero information_schema calls name integration_external_systems, and the kindInventory plan is not_run', async () => {
    const schema = cloneSchema()
    const calls = []
    const exec = createFakeExec({ schema, counts: {} }, calls)
    const report = await buildDryRunReport({ exec, probe: 'gamma' })
    assert.equal(report.probe, 'gamma')
    assert.equal(report.plan.objectKeyInventory.status, 'ok')
    assert.equal(report.plan.kindInventory.status, 'not_run')
    const externalSystemCalls = calls.filter((c) => c.params && c.params[0] === 'integration_external_systems')
    assert.deepEqual(externalSystemCalls, [])
  })

  test('no executor + probe supplied: the static (no-DB) report still records the requested probe, even though nothing was probed', async () => {
    const report = await buildDryRunReport({ exec: null, probe: 'beta' })
    assert.equal(report.mode, 'dry-run-static')
    assert.equal(report.probe, 'beta')
  })

  test('probe defaults to \'both\' when not supplied', async () => {
    const report = await buildDryRunReport({ exec: null })
    assert.equal(report.probe, 'both')
  })
})

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('defaults', () => {
    const opts = parseArgs([])
    assert.equal(opts.dryRun, false)
    assert.equal(opts.probe, 'both')
    assert.equal(opts.json, false)
    assert.equal(opts.noPrivateOut, false)
    assert.equal(opts.privateOutPath, undefined)
  })

  test('--probe accepts beta/gamma/both, rejects anything else', () => {
    assert.equal(parseArgs(['--probe', 'beta']).probe, 'beta')
    assert.equal(parseArgs(['--probe', 'gamma']).probe, 'gamma')
    assert.equal(parseArgs(['--probe', 'both']).probe, 'both')
    assert.throws(() => parseArgs(['--probe', 'delta']), /--probe must be one of/)
  })

  test('--private-out and --no-private-out are mutually exclusive', () => {
    assert.throws(() => parseArgs(['--private-out', '/tmp/x.json', '--no-private-out']), /mutually exclusive/)
  })

  test('--private-out requires a path argument', () => {
    assert.throws(() => parseArgs(['--private-out']), /requires a path argument/)
  })

  test('unknown flag throws', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown argument/)
  })

  test('--help sets help flag', () => {
    assert.equal(parseArgs(['--help']).help, true)
  })
})

// ---------------------------------------------------------------------------
// DEFAULT_PRIVATE_OUTPUT_DIR must be the gitignored directory — pins the
// constant against the .gitignore entry shipped in the same PR (read the real
// .gitignore, not just the constant's own string).
// ---------------------------------------------------------------------------

describe('DEFAULT_PRIVATE_OUTPUT_DIR is actually gitignored', () => {
  test('.gitignore contains an entry covering this directory', () => {
    const gitignore = readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')
    const covered = gitignore
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .some((pattern) => {
        const normalized = pattern.replace(/\/$/, '')
        return DEFAULT_PRIVATE_OUTPUT_DIR === normalized || DEFAULT_PRIVATE_OUTPUT_DIR.startsWith(normalized + '/')
      })
    assert.ok(covered, `.gitignore has no entry covering ${DEFAULT_PRIVATE_OUTPUT_DIR} — a real run's raw-value artefact could be committed`)
  })
})
