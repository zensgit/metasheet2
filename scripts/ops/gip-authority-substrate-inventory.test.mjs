import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, statSync, readlinkSync, rmSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  QUERY_ALLOWLIST,
  KNOWN_CERTIFIED_CONNECTOR_KINDS,
  KNOWN_CANONICAL_OBJECT_KEYS,
  EXTERNAL_SYSTEM_STATUSES,
  READ_SOURCE_CONFIG_STATUSES,
  assertReadOnlyAllowlist,
  isSafeNonNegativeInteger,
  INVALID_COUNT_REASON,
  runQuery,
  probeColumns,
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
  writePrivateArtifact,
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
// QUERY_ALLOWLIST entries — deep freeze (#4603 P3). `Object.freeze(QUERY_ALLOWLIST)` at the
// literal's own definition site only locks the OUTER object's key set — it does not freeze each
// nested `{ sql, describe }` entry object. Proven live before the fix: an importer could run
// `QUERY_ALLOWLIST['probe.columns'].sql = 'DELETE FROM integration_external_systems; -- pwned'`
// and BOTH runQuery() and probeColumns() would hand that exact mutated string to the executor —
// assertReadOnlyAllowlist() never re-runs after module load, so it would never catch this. This
// describe block holds every entry to the SAME standard KNOWN_CERTIFIED_CONNECTOR_KINDS /
// KNOWN_CANONICAL_OBJECT_KEYS / RESIDUAL_NOTES are already held to elsewhere in this file (a
// mutation attempt throws, not just "is frozen" as a comment).
// ---------------------------------------------------------------------------

// Best-effort restore for a module-level singleton mutation attempt. When the fix is in place the
// original assignment above already threw (nothing changed, so this is a silent no-op attempt
// that itself throws — swallowed here on purpose). When the fix is ABSENT the assignment above
// succeeded and corrupted shared state; this restores it so a discrimination run's failure surface
// stays limited to the tests in this describe block instead of cascading into every test below it
// in the file (which all reference the same QUERY_ALLOWLIST singleton via the fake-exec harness).
function attemptRestore(entry, key, original) {
  try {
    entry[key] = original
  } catch {
    // frozen (fix present) — nothing was mutated, nothing to restore
  }
}

describe('QUERY_ALLOWLIST entries are deep-frozen, not just the outer object (#4603 P3)', () => {
  test('every entry object is independently frozen (structural, not per-tag)', () => {
    for (const [tag, entry] of Object.entries(QUERY_ALLOWLIST)) {
      assert.ok(Object.isFrozen(entry), `QUERY_ALLOWLIST["${tag}"] entry is not frozen`)
    }
  })

  test('the exact mutation the owner\'s probe used throws (strict-mode ESM), and the entry is unchanged afterward', () => {
    const original = QUERY_ALLOWLIST['probe.columns'].sql
    try {
      assert.throws(() => {
        QUERY_ALLOWLIST['probe.columns'].sql = 'DELETE FROM integration_external_systems; -- pwned'
      }, TypeError)
      // Read back: the throw must have happened BEFORE the write took effect, not merely been
      // thrown after a silent mutation already landed.
      assert.equal(QUERY_ALLOWLIST['probe.columns'].sql, original)
      assert.doesNotMatch(QUERY_ALLOWLIST['probe.columns'].sql, /DELETE|pwned/)
    } finally {
      attemptRestore(QUERY_ALLOWLIST['probe.columns'], 'sql', original)
    }
  })

  test('describe is frozen too (not just sql — the whole entry object, no per-field carve-out)', () => {
    const original = QUERY_ALLOWLIST['probe.table_exists'].describe
    try {
      assert.throws(() => {
        QUERY_ALLOWLIST['probe.table_exists'].describe = 'SENTINEL_SHOULD_NEVER_STICK'
      }, TypeError)
      assert.equal(QUERY_ALLOWLIST['probe.table_exists'].describe, original)
    } finally {
      attemptRestore(QUERY_ALLOWLIST['probe.table_exists'], 'describe', original)
    }
  })

  test('positive control: after a (failed) mutation attempt, runQuery()/probeColumns() still hand the CORRECT, original SQL to the executor', async () => {
    const original = QUERY_ALLOWLIST['probe.columns'].sql
    try {
      let attemptFailed = false
      try {
        QUERY_ALLOWLIST['probe.columns'].sql = 'DELETE FROM integration_external_systems; -- pwned'
      } catch {
        attemptFailed = true
      }
      assert.ok(attemptFailed, 'setup invariant broken: the mutation attempt above must throw for this positive control to be meaningful')

      const received = []
      const exec = async (sql, params) => {
        received.push(sql)
        return { rows: [{ column_name: 'kind' }] }
      }
      await runQuery(exec, 'probe.columns', ['integration_external_systems'])
      await probeColumns(exec, 'integration_external_systems', ['kind'])
      assert.equal(received.length, 2)
      for (const sql of received) {
        assert.equal(sql, original)
        assert.doesNotMatch(sql, /DELETE|pwned/)
      }
    } finally {
      attemptRestore(QUERY_ALLOWLIST['probe.columns'], 'sql', original)
    }
  })

  // Discrimination (run manually, not automated — this file has no mutation-testing harness),
  // confirmed 2026-07-25 at HEAD (144-test suite): with the per-entry freeze loop in the source,
  // 144/144 green. Deleting ONLY that loop (leaving `Object.freeze(QUERY_ALLOWLIST)` on the outer
  // object intact) reds exactly the 4 tests in this describe block — 140/144 — and nothing else.
  // The mutation tests above restore mutated state in a `finally` (see attemptRestore()) precisely
  // so that a real gap here reds only its own tests instead of corrupting the module-level
  // QUERY_ALLOWLIST singleton every other test in this file reads through the same fake-exec
  // harness (SQL_TO_TAG, createFakeExec) — an earlier draft without the restore cascaded to ~40
  // unrelated failures when the freeze was absent.
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

  test("returns { status: 'ok', counts, detail } on success — status is always present, never absent from a good result", () => {
    const result = bucketByRegistry([{ kind: 'a', n: 1 }], [], { valueKey: 'kind' })
    assert.equal(result.status, 'ok')
  })
})

// ---------------------------------------------------------------------------
// isSafeNonNegativeInteger — #4603 owner-review P1(1): `Number(value) || 0` used to turn a
// missing, malformed, or non-finite count into a silent ZERO — the single most dangerous wrong
// answer for a precondition probe ("0 unregistered" is exactly the green light Wave 2 would
// consume). Every listed adversarial input must be rejected; a genuine 0 is the positive control
// proving the predicate does not just reject everything.
// ---------------------------------------------------------------------------

describe('isSafeNonNegativeInteger — strict accept: non-negative safe integers only', () => {
  const REJECT = [
    ['undefined', undefined],
    ['null', null],
    ["''", ''],
    ["'abc'", 'abc'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['-1', -1],
    ['1.5', 1.5],
    ['2**53 (one past MAX_SAFE_INTEGER — not representable exactly, must not be trusted)', 2 ** 53],
    ["'3' (a numeric STRING — real int4 rows come back as a JS number already; do not coerce)", '3'],
    ['true', true],
    ['[]', []],
    ['{}', {}],
  ]
  for (const [label, value] of REJECT) {
    test(`rejects ${label}`, () => {
      assert.equal(isSafeNonNegativeInteger(value), false)
    })
  }

  test('POSITIVE CONTROL: accepts a genuine 0 — proves the predicate is not merely "reject everything"', () => {
    assert.equal(isSafeNonNegativeInteger(0), true)
  })

  test('accepts ordinary positive safe integers', () => {
    assert.equal(isSafeNonNegativeInteger(1), true)
    assert.equal(isSafeNonNegativeInteger(42), true)
    assert.equal(isSafeNonNegativeInteger(Number.MAX_SAFE_INTEGER), true)
  })
})

describe('bucketByRegistry — fails CLOSED (never defaults to 0) on an anomalous row count', () => {
  const BAD_COUNTS = [undefined, null, '', 'abc', NaN, Infinity, -1, 1.5, 2 ** 53]
  for (const bad of BAD_COUNTS) {
    test(`row count ${JSON.stringify(bad)} -> { status: 'invalid_count' }, never a silently-zeroed row`, () => {
      const result = bucketByRegistry([{ kind: 'a', n: bad }], [], { valueKey: 'kind' })
      assert.equal(result.status, 'invalid_count')
      assert.equal(result.reason, INVALID_COUNT_REASON)
      assert.equal(result.counts, undefined, 'an invalid result must not also carry a usable counts object')
    })
  }

  test('a genuine 0 count is still expressible — the positive control at the bucketing layer, not just the predicate layer', () => {
    const result = bucketByRegistry([{ kind: 'a', n: 0 }], [], { valueKey: 'kind' })
    assert.equal(result.status, 'ok')
    assert.equal(result.counts.totalRows, 0)
    assert.equal(result.counts.unregisteredDistinctCount, 1)
  })

  test('one bad row among otherwise-good rows invalidates the WHOLE bucket (no partial "mostly trustworthy" counts)', () => {
    const result = bucketByRegistry(
      [{ kind: 'a', n: 3 }, { kind: 'b', n: undefined }, { kind: 'c', n: 2 }],
      [],
      { valueKey: 'kind' },
    )
    assert.equal(result.status, 'invalid_count')
  })
})

describe('executeKindInventoryPlan / executeObjectKeyInventoryPlan: an invalid row count is UNAVAILABLE -> INCONCLUSIVE, never a silent 0', () => {
  test('β allStatuses count anomalous -> whole kindInventory unavailable, verdict INCONCLUSIVE (through buildReport end to end)', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({
      schema,
      counts: {
        ...ZERO_COUNTS,
        'count.external_system_kinds_all': [{ kind: 'x', n: undefined }],
        'count.external_system_kinds_active': [{ kind: 'x', n: 1 }],
      },
    })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.equal(report.coverage.connectorKindInventory.status, 'unavailable')
    assert.equal(report.coverage.connectorKindInventory.reason, INVALID_COUNT_REASON)
    assert.equal(report.verdicts.connectorKind.verdict, 'INCONCLUSIVE')
  })

  test('γ approved-status count anomalous -> whole canonicalObjectKeyInventory unavailable, verdict INCONCLUSIVE (through buildReport end to end)', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({
      schema,
      counts: {
        ...ZERO_COUNTS,
        'count.read_source_config_objects_by_status': [{ object: 'material', status: 'approved', n: NaN }],
      },
    })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.equal(report.coverage.canonicalObjectKeyInventory.status, 'unavailable')
    assert.equal(report.coverage.canonicalObjectKeyInventory.reason, INVALID_COUNT_REASON)
    assert.equal(report.verdicts.canonicalObjectKey.verdict, 'INCONCLUSIVE')
  })

  test("γ divergence count anomalous -> divergence sub-field unavailable, verdict INCONCLUSIVE (byStatus itself stays 'ok')", async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({
      schema,
      counts: {
        ...ZERO_COUNTS,
        'count.read_source_config_object_config_divergence': [{ n: '0' }], // numeric STRING, not a number
      },
    })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.equal(report.coverage.canonicalObjectKeyInventory.status, 'ok')
    assert.equal(report.coverage.canonicalObjectKeyInventory.objectVsConfigObjectDivergence.status, 'unavailable')
    assert.equal(report.coverage.canonicalObjectKeyInventory.objectVsConfigObjectDivergence.reason, INVALID_COUNT_REASON)
    assert.equal(report.verdicts.canonicalObjectKey.verdict, 'INCONCLUSIVE')
  })

  test('γ divergence query returning zero rows (never happens for a real COUNT(*), but must not default to 0 if it did) -> unavailable, INCONCLUSIVE', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({
      schema,
      counts: {
        ...ZERO_COUNTS,
        'count.read_source_config_object_config_divergence': [],
      },
    })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.equal(report.coverage.canonicalObjectKeyInventory.objectVsConfigObjectDivergence.status, 'unavailable')
    assert.equal(report.verdicts.canonicalObjectKey.verdict, 'INCONCLUSIVE')
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
// CLOSED VALUE DOMAIN — #4603 owner-review P2(a). The exact-key-set walk above
// (assertPublicReportKeySetsExactly) proves every KEY in the report is from the closed set the
// source can produce, but says nothing about VALUES: `covers`/`blindSpot` are hardcoded object-
// literal strings inside buildReport() — not derived from any row, not covered by the
// sentinel-substring scan (which only checks strings that flow THROUGH the row-count pipeline).
// Replace one with an arbitrary raw string and every existing test, including the key-set walk,
// stays green, because nothing ever checks what that field actually SAYS. Verified directly
// against 18f503bf0 — see the PR body / commit message for the two pasted mutation-probe runs.
//
// The check: collect every STRING leaf of a full report, normalize embedded digit runs to a
// single '#' (every dynamic component this module ever interpolates into a sentence is a
// bucketByRegistry-validated non-negative safe integer — never raw DB content; see
// isSafeNonNegativeInteger), and assert the resulting SET equals a hand-frozen expected array,
// one per fixture scenario. Set EQUALITY (not membership) means a substitution, a removal, or any
// new unauthored prose all fail the same way: a mismatch. Every NUMBER leaf is independently
// asserted to be a safe non-negative integer, and every BOOLEAN leaf is enumerated by position.
//
// The expected arrays below were captured by running buildReport() once against the FIXED source
// (see the PR body for the capture command) and are pasted here as FROZEN literals — not
// re-derived at test time — so a later source mutation (accidental or adversarial) diverges from
// this independent frozen copy instead of being validated against itself.
// ---------------------------------------------------------------------------

function normalizeDigits(s) {
  return s.replace(/\d+/g, '#')
}

function collectLeavesByType(node, out) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const v of node) collectLeavesByType(v, out)
    return
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) collectLeavesByType(node[k], out)
    return
  }
  if (typeof node === 'string') out.strings.push(node)
  else if (typeof node === 'number') out.numbers.push(node)
  else if (typeof node === 'boolean') out.booleans.push(node)
  else throw new Error(`unexpected leaf type ${typeof node}: ${JSON.stringify(node)}`)
}

// Every number leaf anywhere in the report must be a non-negative safe integer — the same
// discipline isSafeNonNegativeInteger() enforces at the row-count boundary, re-asserted here at
// the OUTPUT boundary so a bug anywhere in between (not just at ingestion) is still caught.
function assertClosedValueDomain(report, expectedNormalizedStrings) {
  const out = { strings: [], numbers: [], booleans: [] }
  collectLeavesByType(report, out)
  for (const n of out.numbers) {
    assert.ok(
      Number.isSafeInteger(n) && n >= 0,
      `number leaf ${n} is not a non-negative safe integer — every number in public output must come from a validated count`,
    )
  }
  const normalized = [...new Set(out.strings.map(normalizeDigits))].sort()
  assert.deepEqual(normalized, [...expectedNormalizedStrings].sort())
}

const EXPECTED_NOTHING_OWED = [
  '# distinct kind string(s) observed across integration_external_systems, all already in the (currently #-entry) known registry',
  '# distinct objectKey(s) referenced by approved read-source configs, all already in the (currently #-entry) known registry',
  '#-#-#T#:#:#.#Z',
  "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration #, External-API WRITE self-service W#). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§# step #.#, §#.# B-#) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  "Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.",
  'CANONICAL_OBJECT_BACKFILL_NOT_REQUIRED_WITHIN_COVERAGE',
  'CONNECTOR_KIND_MAPPING_NOT_REQUIRED_WITHIN_COVERAGE',
  'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
  'DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration #) — a second objectKey reference class in the same database this report never queries; see residualNotes.',
  'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  'a zero known-registry size makes this trivially true today — see residualNotes',
  'both',
  "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
  'integration_write_target_configs_object_deliberately_out_of_scope',
  'known_registries_empty_by_design',
  'no_customer_deployment_connection',
  'ok',
  'report',
  'skipped_by_flag',
]

const EXPECTED_SOMETHING_OWED = [
  '# of # distinct kind string(s) are not in the known registry (size #) — an explicit alias map / migration decision (β) is needed before these can bind under GIP',
  '# of # distinct objectKey(s) referenced by approved configs are not in the known registry (size #) — inventory + backfill of these is required BEFORE activation per decision (γ)',
  '#-#-#T#:#:#.#Z',
  "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration #, External-API WRITE self-service W#). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§# step #.#, §#.# B-#) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  "Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.",
  'CANONICAL_OBJECT_BACKFILL_REQUIRED',
  'CONNECTOR_KIND_MAPPING_REQUIRED',
  'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
  'DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration #) — a second objectKey reference class in the same database this report never queries; see residualNotes.',
  'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  'both',
  "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
  'incomplete_owed_disabled',
  'integration_write_target_configs_object_deliberately_out_of_scope',
  'known_registries_empty_by_design',
  'no_customer_deployment_connection',
  'ok',
  'raw kind strings are in the private artefact, if one was written — see privateArtifact',
  'raw objectKey strings are in the private artefact, if one was written — see privateArtifact',
  'report',
]

const EXPECTED_UNAVAILABLE_AND_NOT_RUN = [
  '# of # distinct kind string(s) are not in the known registry (size #) — an explicit alias map / migration decision (β) is needed before these can bind under GIP',
  '#-#-#T#:#:#.#Z',
  "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration #, External-API WRITE self-service W#). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§# step #.#, §#.# B-#) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  "Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.",
  'CONNECTOR_KIND_MAPPING_REQUIRED',
  'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
  'DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration #) — a second objectKey reference class in the same database this report never queries; see residualNotes.',
  'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  'beta',
  "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
  'incomplete_owed_disabled',
  "integration_external_systems.status column not found (probed via information_schema.tables/.columns, table_schema='public', as the DATABASE_URL role — a non-public search_path or missing SELECT/USAGE privileges reports the same as a genuinely absent object) — cannot separate active-only from all-statuses",
  'integration_write_target_configs_object_deliberately_out_of_scope',
  'known_registries_empty_by_design',
  'no_customer_deployment_connection',
  'not_run',
  'ok',
  'raw kind strings are in the private artefact, if one was written — see privateArtifact',
  'report',
  'unavailable',
]

const EXPECTED_DIVERGENCE_POSITIVE = [
  '# distinct kind string(s) observed across integration_external_systems, all already in the (currently #-entry) known registry',
  "# row(s) have integration_read_source_configs.object disagreeing with config->>'object' — a backfill/mapping decision built from the object column alone would be unreliable for those rows until the divergence is resolved",
  '#-#-#T#:#:#.#Z',
  "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration #, External-API WRITE self-service W#). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§# step #.#, §#.# B-#) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  "Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.",
  'CONNECTOR_KIND_MAPPING_NOT_REQUIRED_WITHIN_COVERAGE',
  'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
  'DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration #) — a second objectKey reference class in the same database this report never queries; see residualNotes.',
  'INCONCLUSIVE',
  'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  'a zero known-registry size makes this trivially true today — see residualNotes',
  'both',
  "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
  'integration_write_target_configs_object_deliberately_out_of_scope',
  'known_registries_empty_by_design',
  'no_customer_deployment_connection',
  'ok',
  'report',
  'skipped_by_flag',
  'this is reported regardless of registeredness — see coverage.canonicalObjectKeyInventory.objectVsConfigObjectDivergence',
]

const EXPECTED_UNEXPECTED_STATUS = [
  '# distinct kind string(s) observed across integration_external_systems, all already in the (currently #-entry) known registry',
  "# distinct objectKey(s) referenced by read-source config row(s) in an out-of-vocabulary (unexpected) status — a verdict scoped to 'approved' cannot be trusted while rows exist outside the known draft/approved/retired status vocabulary",
  '#-#-#T#:#:#.#Z',
  "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration #, External-API WRITE self-service W#). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§# step #.#, §#.# B-#) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  "Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.",
  'CONNECTOR_KIND_MAPPING_NOT_REQUIRED_WITHIN_COVERAGE',
  'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
  'DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration #) — a second objectKey reference class in the same database this report never queries; see residualNotes.',
  'INCONCLUSIVE',
  'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  'a zero known-registry size makes this trivially true today — see residualNotes',
  'both',
  "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
  'incomplete_owed_disabled',
  'integration_write_target_configs_object_deliberately_out_of_scope',
  'known_registries_empty_by_design',
  'no_customer_deployment_connection',
  'ok',
  'report',
  'this is reported regardless of registeredness — see coverage.canonicalObjectKeyInventory.byStatus.unexpected',
]

const EXPECTED_MISSING_TABLES = [
  '#-#-#T#:#:#.#Z',
  "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration #, External-API WRITE self-service W#). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§# step #.#, §#.# B-#) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  "Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.",
  'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
  'DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration #) — a second objectKey reference class in the same database this report never queries; see residualNotes.',
  'INCONCLUSIVE',
  'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  'both',
  "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  'coverage is partial — the all-statuses kind count is UNAVAILABLE',
  'coverage is partial — the approved-status objectKey count is UNAVAILABLE',
  "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
  'integration_write_target_configs_object_deliberately_out_of_scope',
  'known_registries_empty_by_design',
  'no_customer_deployment_connection',
  'report',
  'skipped_by_flag',
  "table integration_external_systems not found (probed via information_schema.tables/.columns, table_schema='public', as the DATABASE_URL role — a non-public search_path or missing SELECT/USAGE privileges reports the same as a genuinely absent object)",
  "table integration_read_source_configs not found (probed via information_schema.tables/.columns, table_schema='public', as the DATABASE_URL role — a non-public search_path or missing SELECT/USAGE privileges reports the same as a genuinely absent object)",
  'unavailable',
]

// Exercises the ACTUAL write path (not noPrivateOut: true like the six scenarios above) — the
// exact branch P2(b) was about. Differs from EXPECTED_NOTHING_OWED only by 'skipped_by_flag' ->
// 'written'; captured the same way (run once against the fixed source, pasted as a frozen
// literal), so a real filesystem path or err.message re-appearing in privateArtifact would show up
// here as an unauthored string, not just fail the narrower doesNotMatch(/private\.json/) checks
// elsewhere.
const EXPECTED_WRITTEN = [
  '# distinct kind string(s) observed across integration_external_systems, all already in the (currently #-entry) known registry',
  '# distinct objectKey(s) referenced by approved read-source configs, all already in the (currently #-entry) known registry',
  '#-#-#T#:#:#.#Z',
  "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration #, External-API WRITE self-service W#). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§# step #.#, §#.# B-#) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  "Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.",
  'CANONICAL_OBJECT_BACKFILL_NOT_REQUIRED_WITHIN_COVERAGE',
  'CONNECTOR_KIND_MAPPING_NOT_REQUIRED_WITHIN_COVERAGE',
  'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
  'DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration #) — a second objectKey reference class in the same database this report never queries; see residualNotes.',
  'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  'a zero known-registry size makes this trivially true today — see residualNotes',
  'both',
  "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
  'integration_write_target_configs_object_deliberately_out_of_scope',
  'known_registries_empty_by_design',
  'no_customer_deployment_connection',
  'ok',
  'report',
  'written',
]

// Exercises the write-FAILED-but-nothing-owed branch: the real filesystem error occurs (ENOTDIR,
// via the blocker-file trick used elsewhere in this file), and 'FILESYSTEM_WRITE_ERROR' is the
// only new leaf versus EXPECTED_WRITTEN (replacing 'written') — the raw err.message/path must NOT
// appear here either.
const EXPECTED_WRITE_FAILED_NOTHING_OWED = [
  '# distinct kind string(s) observed across integration_external_systems, all already in the (currently #-entry) known registry',
  '# distinct objectKey(s) referenced by approved read-source configs, all already in the (currently #-entry) known registry',
  '#-#-#T#:#:#.#Z',
  "A second objectKey reference class exists in the same database: integration_write_target_configs.object (migration #, External-API WRITE self-service W#). This inventory does NOT probe it. Reason: the ledger's decision (γ) scope (§# step #.#, §#.# B-#) is the READ-side qualification-input tuple's objectKey, and the task this script was built for is scoped to that tuple; the write-target config table is a separate, config-time-only surface (no dry-run/apply/runtime route per its migration header) that decision (γ)'s registry may also need to cover eventually, but that is a follow-up inventory scope decision, not an oversight in this one. A canonical object referenced ONLY by a write-target config (never by a read-source config) is invisible to this report.",
  "Both KNOWN_CERTIFIED_CONNECTOR_KINDS and KNOWN_CANONICAL_OBJECT_KEYS are empty. Neither decision (β) nor decision (γ) has produced a first-party registry yet, so today every distinct value observed is reported as unregistered — that is the correct, honest state, not a defect. This inventory exists to produce the raw list a human uses to populate those registries; it never populates them itself.",
  'CANONICAL_OBJECT_BACKFILL_NOT_REQUIRED_WITHIN_COVERAGE',
  'CONNECTOR_KIND_MAPPING_NOT_REQUIRED_WITHIN_COVERAGE',
  'DB rows only, in the ONE connected database, at the moment queried. Says nothing about kinds referenced only in code/fixtures, or about a different deployment/database this run was not pointed at.',
  'DB rows only, in the ONE connected database. A canonical object referenced by a still-in-development (never-saved) config, or by a config in a DIFFERENT database this run was not pointed at, is invisible here. Also deliberately out of scope: integration_write_target_configs.object (migration #) — a second objectKey reference class in the same database this report never queries; see residualNotes.',
  'FILESYSTEM_WRITE_ERROR',
  'This script has only ever been run against a hermetic fake executor (tests) and, if noted in the PR, a local/CI fixture database — never a customer deployment. Connecting to one is a separate ops-gated read-only authorization this task does not carry.',
  'a zero known-registry size makes this trivially true today — see residualNotes',
  'both',
  "computeObjectKeyVerdict() is scoped to status='approved' only, matching the task's literal scope ('approved read-source configs'). draft/retired counts are still reported under byStatus for completeness, but a draft config can be approved after this inventory runs — decision (γ)'s own 'before activation' framing means the approved-only headline can understate the eventual backfill list; re-run before activation, not once.",
  "distinct integration_external_systems.kind strings and their row counts — the raw material for decision (β)'s explicit alias map and migration list. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  "distinct integration_read_source_configs.object values (the ledger's `objectKey` tuple term) referenced by configs, split by status — the raw material for decision (γ)'s missing-reference and backfill lists. The count queries are UNSCOPED: every tenant and workspace visible in the connected database, not one tenant.",
  'draft_and_retired_object_keys_excluded_from_the_headline_verdict',
  'integration_write_target_configs_object_deliberately_out_of_scope',
  'known_registries_empty_by_design',
  'no_customer_deployment_connection',
  'ok',
  'report',
  'write_failed_but_nothing_owed',
]

describe('CLOSED VALUE DOMAIN — every public leaf is a safe non-negative integer or a string from a hand-frozen closed set (#4603 P2(a))', () => {
  test('report top-level key set is EXACTLY {generatedAt, mode, probe, coverage, verdicts, residualNotes, privateArtifact} — was previously unconstrained', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.deepEqual(
      Object.keys(report).sort(),
      ['coverage', 'generatedAt', 'mode', 'privateArtifact', 'probe', 'residualNotes', 'verdicts'],
    )
  })

  // report.residualNotes === RESIDUAL_NOTES pins OBJECT IDENTITY only — that buildReport() passes
  // the frozen array through unchanged (no copy/re-derivation). It does NOT pin note CONTENT: a
  // wording change to a note keeps the same object reference, so this assertion alone stays green.
  // Content is pinned separately by the 8 CLOSED VALUE DOMAIN scenario tests below, via
  // assertClosedValueDomain's hand-frozen EXPECTED_* string lists, which hardcode every
  // residual-note description and red on any change to a note's non-numeric text.
  // Mutation-confirmed (#4603 P2): inverting the meaning of the "no_customer_deployment_connection"
  // note (still non-numeric text) left this identity assertion green while all 8 scenario tests
  // below went red — proving the pin described above.
  // Residual gap, not closed by any test in this file: assertClosedValueDomain digit-normalizes
  // every string (s.replace(/\d+/g, '#')) before comparing, so a DIGITS-ONLY edit to a residual
  // note — e.g. "migration 064" to "migration 164", or "§4 step 1.3, §3.0 B-3" to "§9 step 9.9,
  // §9.0 B-9" (a wrong ledger citation) — normalizes identically and is invisible to all 8 scenario
  // tests AND this identity test. The separate 'RESIDUAL_NOTES' describe block below catches the
  // migration-064 digits specifically (a literal, non-normalized regex match), but nothing in this
  // file checks the §4 step 1.3 / §3.0 B-3 ledger-section digits — mutation-confirmed: that edit
  // alone (section digits only, migration number untouched) leaves all 127 tests in this file green.
  test('report.residualNotes is referentially IDENTICAL to the exported RESIDUAL_NOTES — pins object identity, not note content (see comment above)', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.equal(report.residualNotes, RESIDUAL_NOTES)
  })

  test('scenario: nothing owed (zero rows both probes) — closed value domain holds', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
    const report = await buildReport({ exec, noPrivateOut: true })
    assertClosedValueDomain(report, EXPECTED_NOTHING_OWED)
  })

  test('scenario: something owed (REQUIRED verdicts both probes, numeric interpolation exercised) — closed value domain holds', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({
      schema,
      counts: {
        'count.external_system_kinds_all': [{ kind: 'SENTINEL_KIND', n: 1 }, { kind: 'another-unseen-kind', n: 2 }],
        'count.external_system_kinds_active': [{ kind: 'SENTINEL_KIND', n: 1 }],
        'count.read_source_config_objects_by_status': [
          { object: 'SENTINEL_OBJECT', status: 'approved', n: 1 },
          { object: 'yet-another-object', status: 'draft', n: 1 },
        ],
        'count.read_source_config_object_config_divergence': [{ n: 0 }],
      },
    })
    const report = await buildReport({ exec, noPrivateOut: true })
    assertClosedValueDomain(report, EXPECTED_SOMETHING_OWED)
  })

  test('scenario: unavailable column + --probe beta (not_run branch) — closed value domain holds', async () => {
    const schema = cloneSchema({ integration_external_systems: { exists: true, columns: ['id', 'kind'] } })
    const exec = createFakeExec({
      schema,
      counts: { 'count.external_system_kinds_all': [{ kind: 'erp:k3-wise-webapi', n: 1 }] },
    })
    const report = await buildReport({ exec, probe: 'beta', noPrivateOut: true })
    assertClosedValueDomain(report, EXPECTED_UNAVAILABLE_AND_NOT_RUN)
  })

  test('scenario: objectVsConfigObjectDivergence > 0 (INCONCLUSIVE, exercises the R11/R12 reason templates) — closed value domain holds', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({ schema, counts: { ...ZERO_COUNTS, 'count.read_source_config_object_config_divergence': [{ n: 3 }] } })
    const report = await buildReport({ exec, noPrivateOut: true })
    assertClosedValueDomain(report, EXPECTED_DIVERGENCE_POSITIVE)
  })

  test('scenario: an out-of-vocabulary (unexpected) status bucket is populated (INCONCLUSIVE, exercises the R14/R15 reason templates) — closed value domain holds', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({
      schema,
      counts: { ...ZERO_COUNTS, 'count.read_source_config_objects_by_status': [{ object: 'material', status: 'some_future_status', n: 2 }] },
    })
    const report = await buildReport({ exec, noPrivateOut: true })
    assertClosedValueDomain(report, EXPECTED_UNEXPECTED_STATUS)
  })

  test('scenario: both tables missing (top-level UNAVAILABLE for both probes) — closed value domain holds', async () => {
    const schema = cloneSchema({
      integration_external_systems: { exists: false, columns: [] },
      integration_read_source_configs: { exists: false, columns: [] },
    })
    const exec = createFakeExec({ schema, counts: {} })
    const report = await buildReport({ exec, noPrivateOut: true })
    assertClosedValueDomain(report, EXPECTED_MISSING_TABLES)
  })

  // The two scenarios above (and all six before them) always pass noPrivateOut: true — they never
  // exercise the ACTUAL write path, which is exactly what P2(b) (report exposed caller paths and
  // raw error messages) was about. These two close that gap: a real 'written' artefact and a real
  // filesystem write failure, both through the closed-value-domain walk, not just the narrower
  // doesNotMatch(/private\.json/)-style checks in the "private artefact write behaviour" describe
  // block below.
  test("scenario: privateArtifact actually WRITTEN (real temp-dir write, nothing owed) — closed value domain holds; no real path leaks in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gip-authority-inventory-cvd-written-'))
    try {
      const schema = cloneSchema()
      const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
      const privateOutPath = path.join(dir, 'private.json')
      const report = await buildReport({ exec, privateOutPath })
      assert.equal(report.privateArtifact.status, 'written')
      assertClosedValueDomain(report, EXPECTED_WRITTEN)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("scenario: privateArtifact write FAILED but nothing owed (real ENOTDIR) — closed value domain holds; no real path or err.message leaks in", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gip-authority-inventory-cvd-writefail-'))
    try {
      const schema = cloneSchema()
      const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
      const blockerFile = path.join(dir, 'blocker')
      writeFileSync(blockerFile, 'x')
      const privateOutPath = path.join(blockerFile, 'sub', 'private.json')
      const report = await buildReport({ exec, privateOutPath })
      assert.equal(report.privateArtifact.status, 'write_failed_but_nothing_owed')
      assertClosedValueDomain(report, EXPECTED_WRITE_FAILED_NOTHING_OWED)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
          // (b) ruling: no err.message, no path.relative(...) of a real target, no stack — the
          // thrown message must be a fixed, closed-enum-shaped sentence, not filesystem detail.
          assert.doesNotMatch(err.message, /blocker/)
          assert.doesNotMatch(err.message, /ENOTDIR|ENOENT|EACCES/)
          assert.doesNotMatch(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
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
      // (b) ruling: closed enum only — a reason CODE, never the raw fs err.message and never the
      // attempted target path (both could carry filesystem/OS detail this report must not surface).
      assert.equal(report.privateArtifact.reasonCode, 'FILESYSTEM_WRITE_ERROR')
      assert.deepEqual(Object.keys(report.privateArtifact).sort(), ['consumableByWave2', 'reasonCode', 'status'])
      assert.equal(report.privateArtifact.consumableByWave2, true)
      const serialized = JSON.stringify(report.privateArtifact)
      assert.doesNotMatch(serialized, /blocker/)
      assert.doesNotMatch(serialized, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Pins the NEW fail-closed behaviour for #4603 owner-review P1(2): --no-private-out used to
  // report bare 'skipped_by_flag' even when a private artefact was genuinely owed (unregistered
  // kind/objectKey values existed) — a silent SUCCESS that a downstream Wave 2 gate could consume
  // as "nothing to map". This test formerly pinned that fail-open behaviour; it now pins the
  // fail-closed replacement — updated, not deleted, per the ruling.
  test('--no-private-out with something OWED: explicit INCOMPLETE status, not a bare skip — not consumable by Wave 2', async () => {
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
    assert.equal(report.privateArtifact.status, 'incomplete_owed_disabled')
    assert.equal(report.privateArtifact.consumableByWave2, false)
    assert.deepEqual(Object.keys(report.privateArtifact).sort(), ['consumableByWave2', 'status'])
  })

  // The complementary branch: nothing owed + --no-private-out is a genuinely fine, complete run —
  // must NOT be downgraded to 'incomplete_owed_disabled' just because the flag was passed.
  test('--no-private-out with NOTHING owed: plain skipped_by_flag, consumable', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
    const report = await buildReport({ exec, noPrivateOut: true })
    assert.equal(report.privateArtifact.status, 'skipped_by_flag')
    assert.equal(report.privateArtifact.consumableByWave2, true)
  })

  test("a 'written' privateArtifact carries no real filesystem path — closed status/flag only", async () => {
    const dir = scratchDir()
    try {
      const schema = cloneSchema()
      const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
      const privateOutPath = path.join(dir, 'private.json')
      const report = await buildReport({ exec, privateOutPath })
      assert.equal(report.privateArtifact.status, 'written')
      assert.equal(report.privateArtifact.consumableByWave2, true)
      assert.deepEqual(Object.keys(report.privateArtifact).sort(), ['consumableByWave2', 'status'])
      assert.doesNotMatch(JSON.stringify(report.privateArtifact), /private\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("renderHumanSummary's private-artefact line carries only the closed status token, never a real path (P2(b): stdout is public/committed output)", async () => {
    const dir = scratchDir()
    try {
      const schema = cloneSchema()
      const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
      const privateOutPath = path.join(dir, 'a-directory-name-that-must-not-leak.json')
      const report = await buildReport({ exec, privateOutPath })
      const summary = renderHumanSummary(report)
      assert.match(summary, /private artefact: written/)
      assert.doesNotMatch(summary, /a-directory-name-that-must-not-leak/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
// writePrivateArtifact — #4603 owner-review P2(c): EXCLUSIVE CREATE ONLY. The default `writeFileSync`
// flag ('w') follows a symlink at the target path and truncates/overwrites an existing regular
// file; `mode: 0o600` only constrains permissions on a file THIS call creates, it does not tighten
// an already-existing target. All three refusals below are proven directly at the writePrivateArtifact
// unit, plus the clean-create positive control that proves the guard does not just reject everything.
// ---------------------------------------------------------------------------

describe('writePrivateArtifact — exclusive create; refuses a symlink and refuses an existing target', () => {
  function scratchDir() {
    return mkdtempSync(path.join(tmpdir(), 'gip-authority-inventory-wpa-test-'))
  }

  test('POSITIVE CONTROL: clean create succeeds — new file, correct content, mode 0o600', () => {
    const dir = scratchDir()
    try {
      const target = path.join(dir, 'sub', 'private.json')
      writePrivateArtifact(target, { hello: 'world' })
      const written = JSON.parse(readFileSync(target, 'utf8'))
      assert.deepEqual(written, { hello: 'world' })
      const mode = statSync(target).mode & 0o777
      assert.equal(mode, 0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('REFUSAL 1: an existing regular file at the target is refused — throws, and its content is untouched (no overwrite)', () => {
    const dir = scratchDir()
    try {
      const target = path.join(dir, 'private.json')
      writeFileSync(target, 'PRE-EXISTING CONTENT — must survive')
      assert.throws(() => writePrivateArtifact(target, { should: 'never land' }))
      assert.equal(readFileSync(target, 'utf8'), 'PRE-EXISTING CONTENT — must survive')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('REFUSAL 2: a DANGLING symlink at the target (points at a nonexistent path) is refused — throws, symlink left unchanged, target never created', () => {
    const dir = scratchDir()
    try {
      const target = path.join(dir, 'private.json')
      const nonexistentDest = path.join(dir, 'this-path-does-not-exist.json')
      symlinkSync(nonexistentDest, target)
      assert.throws(() => writePrivateArtifact(target, { should: 'never land' }))
      // The symlink node itself must be untouched — writeFileSync's default 'w' flag would have
      // CREATED nonexistentDest and written through the dangling link; O_EXCL must refuse before that.
      assert.equal(readlinkSync(target), nonexistentDest)
      assert.throws(() => statSync(nonexistentDest)) // still does not exist — nothing was created through the link
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('REFUSAL 3: a symlink at the target pointing at a REAL file is refused — throws, and the pointed-to file is unmodified (proves the write never followed the link)', () => {
    const dir = scratchDir()
    try {
      const target = path.join(dir, 'private.json')
      const realFile = path.join(dir, 'some-other-real-file.json')
      writeFileSync(realFile, 'REAL FILE CONTENT — must survive, must never be overwritten via the symlink')
      symlinkSync(realFile, target)
      assert.throws(() => writePrivateArtifact(target, { should: 'never land' }))
      assert.equal(readFileSync(realFile, 'utf8'), 'REAL FILE CONTENT — must survive, must never be overwritten via the symlink')
      assert.equal(readlinkSync(target), realFile)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    assert.throws(() => parseArgs(['--probe', 'delta']), new RegExp(CLI_ERROR_REASON.INVALID_PROBE_VALUE))
  })

  test('--private-out and --no-private-out are mutually exclusive', () => {
    assert.throws(
      () => parseArgs(['--private-out', '/tmp/x.json', '--no-private-out']),
      new RegExp(CLI_ERROR_REASON.MUTUALLY_EXCLUSIVE_PRIVATE_OUT),
    )
  })

  test('--private-out requires a path argument', () => {
    assert.throws(() => parseArgs(['--private-out']), new RegExp(CLI_ERROR_REASON.MISSING_PRIVATE_OUT_PATH))
  })

  test('unknown flag throws', () => {
    assert.throws(() => parseArgs(['--nope']), new RegExp(CLI_ERROR_REASON.UNKNOWN_ARGUMENT))
  })

  // #4603 P2(a) — parseArgs must never echo the operator's literal argv value into the thrown
  // error's message, only the fixed CLOSED reason token. A sentinel proves this behaviourally
  // rather than by re-reading the source: if the old `unknown argument: ${a}` shape ever came
  // back, this would red on the sentinel appearing in err.message.
  test('unknown flag error message never echoes the flag itself, even a sentinel-bearing one', () => {
    const sentinel = 'SENTINEL_NEVER_ECHOED_ARGV_7f2c9a'
    assert.throws(
      () => parseArgs([`--${sentinel}`]),
      (err) => {
        assert.equal(err.message.includes(sentinel), false, 'sentinel leaked into parseArgs error message')
        assert.equal(err.message, CLI_ERROR_REASON.UNKNOWN_ARGUMENT)
        return true
      },
    )
  })

  test('--help sets help flag', () => {
    assert.equal(parseArgs(['--help']).help, true)
  })
})

// ---------------------------------------------------------------------------
// closedCliErrorReason — pinned at the UNIT level, not just via its call
// sites in main(). #4603 P2(a) review: an `err instanceof CliArgError ?
// err.message : RUNTIME_FAILURE` shape (no membership check) would make every
// test below pass while still re-opening the leak on a future regression
// where some CliArgError throw site goes back to interpolating argv. These
// tests exercise the function directly against inputs that a body-level
// regression could produce but that none of the call-site tests below can
// reach (the real parseArgs()/main() never construct these today).
// ---------------------------------------------------------------------------

describe('closedCliErrorReason — the mapping itself is pinned (#4603 P2(a))', () => {
  test('a CliArgError built from a real CLI_ERROR_REASON token passes through unchanged', () => {
    assert.equal(closedCliErrorReason(new CliArgError(CLI_ERROR_REASON.UNKNOWN_ARGUMENT)), CLI_ERROR_REASON.UNKNOWN_ARGUMENT)
  })

  test('a CliArgError built from a string OUTSIDE the frozen token set collapses to RUNTIME_FAILURE — this is the assertion an `instanceof`-only mapping (no membership check) cannot survive', () => {
    const sentinel = 'SENTINEL_NOT_A_TOKEN_leaked-argv-value'
    const err = new CliArgError(`unknown argument: --${sentinel}`)
    const mapped = closedCliErrorReason(err)
    assert.equal(mapped, CLI_ERROR_REASON.RUNTIME_FAILURE)
    assert.equal(mapped.includes(sentinel), false)
  })

  test('a foreign (non-CliArgError) Error is never trusted by content match alone, even when its .message happens to equal a real token string', () => {
    const foreign = new Error(CLI_ERROR_REASON.UNKNOWN_ARGUMENT)
    assert.equal(closedCliErrorReason(foreign), CLI_ERROR_REASON.RUNTIME_FAILURE)
  })

  test('a real absolute-path-bearing foreign Error (MODULE_NOT_FOUND shape) collapses to RUNTIME_FAILURE and never echoes the path', () => {
    const fakePath = '/Users/some-operator/secret-checkout-dir/scripts/ops/gip-authority-substrate-inventory.mjs'
    const foreign = new Error(`Cannot find package 'pg' imported from ${fakePath}`)
    const mapped = closedCliErrorReason(foreign)
    assert.equal(mapped, CLI_ERROR_REASON.RUNTIME_FAILURE)
    assert.equal(mapped.includes(fakePath), false)
  })
})

// ---------------------------------------------------------------------------
// stderr values-free discipline — REAL SUBPROCESS PROOF (#4603 P2(a))
// ---------------------------------------------------------------------------
// The owner's probe ran the actual CLI, not an in-process call to main(): an unrecognized flag's
// literal argv text landed on real stderr, and a `pg` load failure's absolute path landed there
// too. In-process interception of process.stderr.write would prove closedCliErrorReason() itself
// works, but would NOT prove the entry-point wrapper at the bottom of the source (main().then(...))
// actually routes through it, and structurally cannot observe anything that escapes main()'s own
// promise — an unhandled rejection prints on the real stderr file descriptor, bypassing any
// monkeypatch of process.stderr.write entirely (see safeClose() / the isEntry reject handler in the
// source, both added in this same pass to close exactly that gap). These tests spawn the real
// `node <script>` process and read its real stdout/stderr/exit code — no createExecutor injection
// possible here, by design.
// ---------------------------------------------------------------------------

const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'ops', 'gip-authority-substrate-inventory.mjs')

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1
    idx += needle.length
  }
  return count
}

function runCliSubprocess(args, env) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { env, encoding: 'utf8', timeout: 10_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('stderr values-free discipline — real subprocess (#4603 P2(a))', () => {
  test('sentinel-bearing unknown flag: exit 1; stderr is non-empty (positive control — an implementation that prints nothing would also pass a bare zero-count check); sentinel appears in NEITHER stdout NOR stderr', () => {
    const sentinel = 'SENTINEL_OPERATOR_SECRET_MARKER_c83fa1'
    // Minimal explicit env: no ambient DATABASE_URL/etc. from the test runner's own environment can
    // leak in and change which branch of main() this exercises.
    const env = { PATH: process.env.PATH }
    const res = runCliSubprocess([`--${sentinel}`], env)
    assert.equal(res.status, 1)
    assert.ok(res.stderr.length > 0, 'positive control failed: stderr was empty')
    assert.equal(countOccurrences(res.stderr, sentinel), 0, `sentinel leaked into stderr: ${res.stderr}`)
    assert.equal(countOccurrences(res.stdout, sentinel), 0, `sentinel leaked into stdout: ${res.stdout}`)
    assert.equal(res.stderr.trim(), `[gip-authority-substrate-inventory] ERROR: ${CLI_ERROR_REASON.UNKNOWN_ARGUMENT}`)
  })

  test('forced `pg` driver-load failure: exit 1; stderr non-empty (positive control); the absolute path fragment PROVEN present in the raw import error is absent from both stdout and stderr', async () => {
    // #4603 P3(b): this control does NOT rely on `pg` being genuinely absent from the ambient
    // dev/CI environment. The previous shape did — `await import('pg')` here (resolved from THIS
    // test file's own location) and `runCliSubprocess([], env)` (resolved from SCRIPT_PATH,
    // scripts/ops/ — the same directory) happened to coincide, but only because `pg` is a real
    // dependency of packages/core-backend/package.json; a contributor who ran `pnpm install` at
    // the repo root (an ordinary, unremarkable step) and then ran this test file directly would
    // resolve `pg` successfully via workspace hoisting, and the whole point of this test — proving
    // the redaction actually engaged — would silently stop being exercised while still reading
    // green (a false-negative-shaped risk this repo's doctrine treats as a defect, not a nuisance:
    // see feedback_positive_control_not_failclosed.md). The CI workflow itself never installs
    // (checkout + setup-node + `node --test`, no install step — see
    // .github/workflows/gip-authority-substrate-inventory.yml), so CI never actually saw this gap;
    // this only bites a contributor running the suite locally after `pnpm install`.
    //
    // Fix: measure the raw `import('pg')` failure and the CLI's redaction of it in an ISOLATED
    // directory with no `node_modules` anywhere in its ancestor chain up to the filesystem root —
    // a fresh `mkdtemp` under `os.tmpdir()`, never a location inside this repo/workspace. Node's
    // ESM bare-specifier resolution walks up from the IMPORTING FILE's own directory (NOT
    // `process.cwd()`, and NOT `NODE_PATH` — that's CJS-only) looking for `node_modules`, so a
    // copy of the script placed there resolves `pg` deterministically the same way regardless of
    // whether the repo's own workspace has `pg` installed. This makes the control robust to a
    // resolvable `pg` rather than merely documenting the fragility.
    //
    // Verified against the actual failure condition, not merely asserted, on 2026-07-25: with a
    // minimal stub package (`{"name":"pg","version":"0.0.0","main":"index.js"}` +
    // `module.exports = { Pool: class Pool {} }`) placed at the REPO ROOT's `node_modules/pg`
    // (the faithful stand-in for `pnpm install` hoisting `pg` from
    // packages/core-backend/package.json into the workspace root) — (1) `import('pg')` resolved
    // successfully from the repo root, confirming the stub genuinely reproduces the post-install
    // condition; (2) the full suite stayed 144/144 green with the stub present — this test's
    // isolated-directory construction is unaffected because `tmpdir()`'s ancestry never includes
    // the repo; (3) replaying the OLD (pre-fix) control shape — `await import('pg')` from this
    // test file's own location — against the same stub DID red with exactly the vacuous-control
    // message this comment warns about (`control failed: 'pg' imported successfully...`),
    // confirming the fragility being fixed was real, not hypothetical. Stub removed after
    // verification; `node_modules/` is gitignored (`.gitignore` line 2) so it was never a
    // candidate for being committed regardless.
    // realpathSync is REQUIRED here, not cosmetic: os.tmpdir() resolves under /var/folders on
    // macOS, which is itself a symlink to /private/var/folders. The script's own isEntry check
    // (`path.resolve(argv[1]) === fileURLToPath(import.meta.url)`) compares an UN-resolved argv[1]
    // against Node's REALPATH-resolved import.meta.url — on an unresolved symlinked path those
    // never match, isEntry is false, and main() never runs at all (silent exit 0, no output),
    // which would make every assertion below either vacuous or wrong for the wrong reason. Calling
    // realpathSync() up front makes the path we pass to spawnSync the SAME string Node's loader
    // will report back, so isEntry evaluates true exactly as it does for the real script at
    // SCRIPT_PATH (which is already realpath-stable, being inside this checkout). This is a
    // test-construction fix, not a claim that the source's isEntry check itself is safe against
    // symlinked invocation in general — see this PR's disclosure of that as a separate, narrower,
    // non-blocking observation (does not affect this repo's CI, which runs on ubuntu-latest where
    // /tmp is a real directory, not a symlink).
    const isolatedDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gip-authority-inventory-pgcontrol-')))
    try {
      const isolatedScriptPath = path.join(isolatedDir, 'gip-authority-substrate-inventory.mjs')
      // The script's only non-builtin import anywhere in its source is the lazy `import('pg')`
      // inside createPgExecutor() (see the source's "Lazy import" comment) — no relative imports
      // to sibling repo files — so a standalone byte-for-byte copy is a faithful, self-contained
      // subject; confirmed by this same copy running correctly below (help text, exit codes).
      writeFileSync(isolatedScriptPath, readFileSync(SCRIPT_PATH, 'utf8'))

      // Positive control FIRST — prove the raw failure createPgExecutor() would hit really does
      // carry an absolute path, measured from the SAME isolated location the CLI copy below runs
      // from (not this test file's own location, which is a different, incidental directory).
      const rawProbePath = path.join(isolatedDir, 'raw-pg-import-probe.mjs')
      writeFileSync(
        rawProbePath,
        "import('pg').then(() => { process.stdout.write('IMPORTED_OK') }, (e) => { process.stdout.write('FAILED:' + e.message) })\n",
      )
      const probeRes = spawnSync(process.execPath, [rawProbePath], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 10_000 })
      const rawOut = probeRes.stdout ?? ''
      assert.ok(
        rawOut.startsWith('FAILED:'),
        `control failed: \`pg\` imported successfully from the isolated directory — the driver-load-failure scenario below did not actually occur, so its redaction assertions would be vacuous. Raw probe stdout: ${rawOut}`,
      )
      assert.ok(
        rawOut.includes(isolatedDir),
        `control failed: raw import error does not carry the expected isolated-directory path fragment — got: ${rawOut}`,
      )

      const env = { PATH: process.env.PATH, DATABASE_URL: 'postgres://sentinel-host-should-never-appear/db' }
      const res = spawnSync(process.execPath, [isolatedScriptPath], { env, encoding: 'utf8', timeout: 10_000 })
      const stdout = res.stdout ?? ''
      const stderr = res.stderr ?? ''
      assert.equal(res.status, 1)
      assert.ok(stderr.length > 0, 'positive control failed: stderr was empty')
      assert.equal(countOccurrences(stderr, isolatedDir), 0, `path fragment leaked into stderr: ${stderr}`)
      assert.equal(countOccurrences(stdout, isolatedDir), 0, `path fragment leaked into stdout: ${stdout}`)
      assert.equal(
        countOccurrences(stderr, 'sentinel-host-should-never-appear'),
        0,
        `DATABASE_URL host leaked into stderr: ${stderr}`,
      )
      assert.equal(stderr.trim(), `[gip-authority-substrate-inventory] ERROR: ${CLI_ERROR_REASON.RUNTIME_FAILURE}`)
    } finally {
      rmSync(isolatedDir, { recursive: true, force: true })
    }
  })

  // --help is the one success-path (exit 0) public-output surface nothing else in this file
  // exercises via a real process: printHelp() interpolates DEFAULT_PRIVATE_OUTPUT_DIR, a
  // repo-relative constant, not an absolute path — but that is a claim about the source, and this
  // repo's own doctrine is that claims about output need a real capture, not a re-read of the code.
  test('--help: exit 0, and stdout never contains an absolute-path fragment', () => {
    const env = { PATH: process.env.PATH }
    const res = runCliSubprocess(['--help'], env)
    assert.equal(res.status, 0)
    assert.ok(res.stdout.length > 0)
    assert.equal(countOccurrences(res.stdout, __dirname), 0, `path fragment leaked into --help stdout: ${res.stdout}`)
    assert.equal(res.stderr, '')
  })
})

// ---------------------------------------------------------------------------
// main() exit-code contract (#4603 P2(b)) — `consumableByWave2 === false ⇒
// exit 1` (~L1038 in the source) gates Wave 2 consumption of this script's
// output and, before this pass, was reachable by NONE of this file's tests
// (none called main()). These call the REAL main() — the same function the
// entry-point wrapper at the bottom of the source invokes — via the
// injectable createExecutor seam added in this pass, so no real DATABASE_URL
// or `pg` package is needed; the fake executor is the same createFakeExec
// harness the buildReport()-level tests above already use.
// ---------------------------------------------------------------------------

async function withCapturedStdout(fn) {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString()
    return true
  }
  try {
    const result = await fn()
    return { result, stdout: buf }
  } finally {
    process.stdout.write = original
  }
}

function fakeExecutorFactory(schema, counts) {
  const exec = createFakeExec({ schema, counts })
  return async () => ({ exec, close: async () => {} })
}

describe('main() exit-code contract (#4603 P2(b))', () => {
  test('positive control: nothing owed ⇒ exit 0 (a success case must be provable too, not just the failure case)', async () => {
    const schema = cloneSchema()
    const createExecutor = fakeExecutorFactory(schema, ZERO_COUNTS)
    const { result: code } = await withCapturedStdout(() =>
      main(['--no-private-out'], { DATABASE_URL: 'postgres://fixture/db' }, { createExecutor }),
    )
    assert.equal(code, 0)
  })

  test('consumableByWave2 === false (something owed, --no-private-out disables the write) ⇒ exit 1 — the L1038 contract, previously untested by any of the 127 tests', async () => {
    const schema = cloneSchema()
    const counts = {
      'count.external_system_kinds_all': [{ kind: 'unregistered-kind', n: 1 }],
      'count.external_system_kinds_active': [{ kind: 'unregistered-kind', n: 1 }],
      'count.read_source_config_objects_by_status': [],
      'count.read_source_config_object_config_divergence': [{ n: 0 }],
    }
    const createExecutor = fakeExecutorFactory(schema, counts)
    const { result: code } = await withCapturedStdout(() =>
      main(['--no-private-out'], { DATABASE_URL: 'postgres://fixture/db' }, { createExecutor }),
    )
    assert.equal(code, 1)
  })

  test('DATABASE_URL missing outside --dry-run ⇒ exit 2 (documented in the header\'s Exit codes list, previously untested; needs no DB/executor)', async () => {
    const { result: code } = await withCapturedStdout(() => main([], {}))
    assert.equal(code, 2)
  })

  // Mutation-confirmed (#4603 P2(b)): flipping the source's `report.privateArtifact.consumableByWave2
  // === false` to `=== true` at the L1038 exit-code check reds BOTH tests above that depend on it —
  // the "consumableByWave2 === false ... ⇒ exit 1" test (now gets 0) and the "nothing owed ⇒ exit 0"
  // positive control (now gets 1, since a true nothing-owed run's consumableByWave2 is also true and
  // the inverted check fires on it) — while every other test in this file (all 127 pre-existing ones)
  // stays green, because none of them called main(). Reverted after confirming red; not re-run here
  // because this file has no automated mutation-testing harness, matching the existing
  // "Mutation-confirmed (#4603 P2)" comment style used elsewhere in this file for the same reason.
})

// ---------------------------------------------------------------------------
// safeClose() — pin the rejection-swallow through the SAME injectable createExecutor seam the
// exit-code contract tests above use (#4603 HOLD, accepted-gap item). Before this block, both of
// main()'s `finally { await safeClose(executor) }` sites (the --dry-run branch and the real-report
// branch) had zero coverage: an isolated mutation to bare `await executor.close()` at either site
// left all 138 pre-existing tests green. That gap is genuine, not cosmetic — via this exact seam,
// HEAD gives `{closeCalled:true, resolvedExitCode:0, mainRejectedWith:null}` for a rejecting
// close(), while a bare-`await executor.close()` version lets that rejection escape main()'s own
// try/catch from OUTSIDE (a `finally` block's own throw/reject supersedes whatever the try block
// was about to return), reaching the caller as an unhandled rejection instead of the exit code the
// run had already determined.
//
// The primary assertion in both tests below is that main() RESOLVES (does not reject) with the
// exit code its own branch already computed — not merely that stderr stays clean. A rejecting
// `close()` escaping main() would print on the REAL stderr file descriptor outside of any
// process.stderr.write monkeypatch (see the "REAL SUBPROCESS PROOF" comment above the real-CLI
// describe block for the same point made about the isEntry reject handler) — an in-process stderr
// capture structurally cannot observe that failure mode, so resolution is the load-bearing check
// and the stderr assertion is secondary defense-in-depth for the swallow itself.
// ---------------------------------------------------------------------------

async function withCapturedStdoutAndStderr(fn) {
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  let outBuf = ''
  let errBuf = ''
  process.stdout.write = (chunk) => {
    outBuf += typeof chunk === 'string' ? chunk : chunk.toString()
    return true
  }
  process.stderr.write = (chunk) => {
    errBuf += typeof chunk === 'string' ? chunk : chunk.toString()
    return true
  }
  try {
    const result = await fn()
    return { result, stdout: outBuf, stderr: errBuf }
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
}

// Builds a createExecutor whose `close()` always rejects with a marker that must never leak
// anywhere (a stand-in for safeClose()'s own worked example: `CLOSE_FAIL_MARKER…
// host=customer-db.internal`, an underlying DB-close error carrying a hostname). Tracks whether
// close() was actually invoked, so a version of main() that simply never calls close() cannot pass
// these tests vacuously.
function rejectingCloseExecutorFactory(exec) {
  const state = { closeCalled: false }
  const createExecutor = async () => ({
    exec,
    close: () => {
      state.closeCalled = true
      return Promise.reject(new Error('CLOSE_FAIL_MARKER — a real close error would carry operational detail like host=customer-db.internal here'))
    },
  })
  return { createExecutor, state }
}

describe('safeClose() rejection-swallow — pinned through the createExecutor seam (#4603 HOLD)', () => {
  test('--dry-run branch (L1112-ish finally): a rejecting executor.close() does not reject main(), and the exit code / stdout report are unaffected', async () => {
    const exec = async () => ({ rows: [] })
    const { createExecutor, state } = rejectingCloseExecutorFactory(exec)

    let mainRejectedWith = null
    let resolvedExitCode = null
    const { stdout, stderr } = await withCapturedStdoutAndStderr(async () => {
      try {
        resolvedExitCode = await main(['--dry-run'], { DATABASE_URL: 'postgres://fixture/db' }, { createExecutor })
      } catch (e) {
        mainRejectedWith = e
      }
    })

    assert.equal(mainRejectedWith, null, `main() rejected instead of resolving: ${mainRejectedWith && mainRejectedWith.stack}`)
    assert.equal(resolvedExitCode, 0, '--dry-run with no schema issues should still resolve exit 0 despite the close() failure')
    assert.ok(state.closeCalled, 'setup invariant broken: executor.close() was never called — this test would pass vacuously otherwise')
    assert.ok(stdout.length > 0, 'the dry-run report should still have been printed to stdout')
    assert.equal(countOccurrences(stderr, 'CLOSE_FAIL_MARKER'), 0, `close() rejection marker leaked onto stderr: ${stderr}`)
    assert.equal(countOccurrences(stderr, 'customer-db.internal'), 0, `close() rejection detail leaked onto stderr: ${stderr}`)
  })

  test('real-report branch (L1149-ish finally): a rejecting executor.close() does not reject main(), and the exit code / stdout report are unaffected', async () => {
    const schema = cloneSchema()
    const exec = createFakeExec({ schema, counts: ZERO_COUNTS })
    const { createExecutor, state } = rejectingCloseExecutorFactory(exec)

    let mainRejectedWith = null
    let resolvedExitCode = null
    const { stdout, stderr } = await withCapturedStdoutAndStderr(async () => {
      try {
        resolvedExitCode = await main(['--no-private-out'], { DATABASE_URL: 'postgres://fixture/db' }, { createExecutor })
      } catch (e) {
        mainRejectedWith = e
      }
    })

    assert.equal(mainRejectedWith, null, `main() rejected instead of resolving: ${mainRejectedWith && mainRejectedWith.stack}`)
    assert.equal(resolvedExitCode, 0, 'nothing owed + --no-private-out should still resolve exit 0 despite the close() failure')
    assert.ok(state.closeCalled, 'setup invariant broken: executor.close() was never called — this test would pass vacuously otherwise')
    assert.ok(stdout.length > 0, 'the report should still have been printed to stdout')
    assert.equal(countOccurrences(stderr, 'CLOSE_FAIL_MARKER'), 0, `close() rejection marker leaked onto stderr: ${stderr}`)
    assert.equal(countOccurrences(stderr, 'customer-db.internal'), 0, `close() rejection detail leaked onto stderr: ${stderr}`)
  })

  // Discrimination (run manually, not automated — this file has no mutation-testing harness; same
  // documentation style as the other "Mutation-confirmed" comments in this file), confirmed
  // 2026-07-25: replacing `await safeClose(executor)` with a bare `await executor.close()` at ONLY
  // the --dry-run site (~L1113) reds exactly the first test above (main() rejects:
  // mainRejectedWith !== null) — 143/144, nothing else. Reverting that and doing the same at ONLY
  // the real-report site (~L1150) reds the second test above AND the pre-existing 'forced `pg`
  // driver-load failure' real-subprocess test (142/144) — NOT test pollution: at that site
  // `executor` is declared `let executor` (no initial value) rather than `let executor = null`
  // (the --dry-run site's declaration), so when createExecutor() itself throws before ever
  // assigning `executor` — exactly what the real `pg`-absent subprocess test forces — a bare
  // `executor.close()` throws on undefined, escapes main()'s finally as a second rejection, and
  // the entry-point's last-resort reject handler (isEntry block, bottom of source) prints ITS OWN
  // "ERROR: RUNTIME_FAILURE" line on top of the one main()'s own catch already wrote — the exact
  // "printed that marker twice" failure mode the reviewer's probe described. Independent
  // confirmation from a pre-existing test, not a designed assertion of this new describe block.
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
