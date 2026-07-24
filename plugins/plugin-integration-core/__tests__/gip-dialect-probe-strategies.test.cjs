'use strict'

// GIP-D0 B1b — certified MySQL + SQL Server dialect probe strategies, and dialect-aware
// hardening of the probe's read-only guard. Plain node test. Hermetic (fake query fn),
// values-free, zero writes by construction. LATENT: nothing here is wired to any runtime.
//
// Runs AFTER B1a (same module: lib/gip-binding-qualification-spike.cjs). Mirrors, but does
// not duplicate, gip-binding-qualification-spike.test.cjs — that file owns the PG reference
// strategy, the digest/envelope/resolution-bound batteries; this file owns the two NEW
// dialect strategies and the guard extension that makes them safe to register.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  GipQualificationError,
  postgresTotalOrderProbeStrategy,
  mysqlTotalOrderProbeStrategy,
  sqlServerTotalOrderProbeStrategy,
  buildMysqlOrderingKeyDuplicateProbeSql,
  buildMysqlOrderingKeyNullProbeSql,
  buildMysqlOrderingKeyTotalOrderProbeSql,
  buildSqlServerOrderingKeyDuplicateProbeSql,
  buildSqlServerOrderingKeyNullProbeSql,
  buildSqlServerOrderingKeyTotalOrderProbeSql,
  createProbeStrategyRegistry,
  createBindingQualificationProber,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))

function rejectsWith(fn, reason) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof GipQualificationError, `expected qualification error (${reason})`)
  assert.equal(caught.reason, reason)
  return caught
}

async function rejectsWithAsync(fn, reason) {
  let caught = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof GipQualificationError, `expected qualification error (${reason})`)
  assert.equal(caught.reason, reason)
  return caught
}

const ENVELOPE_KEY = Object.freeze({ keyId: 'k2026b', secret: Buffer.alloc(32, 5) })

// ── EXACT PINS on the two new snapshot-semantics tokens ──────────────────────────────
// These are DIGEST-BEARING evidence: they flow into probe evidence → qualificationDigest,
// so a reworded token invalidates every qualification minted under the old one. A
// distinctness check ("all three differ") and a `notEqual(..., 'single_statement_mvcc')`
// check are NOT enough — both of them happily accept an OVERCLAIMING token such as
// `single_statement_snapshot_guaranteed_unconditionally`, which is distinct from PG's and
// is not the PG string, yet promises MORE than either. Only an exact pin catches that, and
// the mutation that proves it is run in the report. Deliberately duplicated: the literal
// also appears inline in strategyIdentity(), so editing this constant alone still reds.
const MYSQL_SNAPSHOT_TOKEN = 'single_statement_consistent_read_conditional_on_innodb_autocommit_and_isolation_read_committed_or_stricter'
const MSSQL_SNAPSHOT_TOKEN = 'no_single_statement_snapshot_under_default_read_committed'

// A registry carrying all THREE dialects, each bound to its own fixture actionProfileVersion
// — the shape the owner ruling describes ("不同 SQL 方言必须提供各自认证的 probe strategy").
const PG_PROFILE = 'fixture.postgres_read.v1'
const MYSQL_PROFILE = 'fixture.mysql_read.v1'
const MSSQL_PROFILE = 'fixture.mssql_read.v1'
const UNBOUND_PROFILE = 'fixture.unbound_dialect.v1' // deliberately NEVER registered

const REGISTRY = createProbeStrategyRegistry([
  { actionProfileVersion: PG_PROFILE, ...postgresTotalOrderProbeStrategy },
  { actionProfileVersion: MYSQL_PROFILE, ...mysqlTotalOrderProbeStrategy },
  { actionProfileVersion: MSSQL_PROFILE, ...sqlServerTotalOrderProbeStrategy },
])
const PROBER = createBindingQualificationProber(REGISTRY)

function baseInputs(actionProfileVersion) {
  return {
    actionProfileVersion,
    systemContentKey: 'sck_fixture_1',
    configContentKey: 'cck_fixture_1',
    objectKey: 'fixture_view',
    canonicalObjectVersion: 'material.v1',
  }
}

// ── 1. Strategy identity: shape, freeze, and HONEST distinctness of snapshot claims ──
function strategyIdentity() {
  for (const strategy of [mysqlTotalOrderProbeStrategy, sqlServerTotalOrderProbeStrategy]) {
    assert.ok(Object.isFrozen(strategy), 'a certified strategy object must be frozen')
    assert.equal(typeof strategy.strategyId, 'string')
    assert.equal(strategy.strategyVersion, 'v1')
    assert.equal(typeof strategy.buildTotalOrderProbeSql, 'function')
  }
  assert.equal(mysqlTotalOrderProbeStrategy.strategyId, 'gip.total_order_probe.mysql')
  assert.equal(mysqlTotalOrderProbeStrategy.dialect, 'mysql')
  assert.equal(sqlServerTotalOrderProbeStrategy.strategyId, 'gip.total_order_probe.sqlserver')
  assert.equal(sqlServerTotalOrderProbeStrategy.dialect, 'sqlserver')

  // THE MONEY ASSERTION for "do not copy PG's token for prestige": all three snapshot
  // claims are PAIRWISE DISTINCT. Reusing PG's token for a dialect whose real guarantee is
  // conditional (MySQL) or absent (SQL Server) would silently overclaim what a downstream
  // consumer can rely on — these tokens are DIGEST-BEARING evidence, not documentation.
  const tokens = [
    postgresTotalOrderProbeStrategy.snapshotSemantics,
    mysqlTotalOrderProbeStrategy.snapshotSemantics,
    sqlServerTotalOrderProbeStrategy.snapshotSemantics,
  ]
  assert.equal(new Set(tokens).size, 3, 'all three dialect snapshot-semantics claims must be pairwise distinct')
  assert.equal(postgresTotalOrderProbeStrategy.snapshotSemantics, 'single_statement_mvcc')
  assert.notEqual(mysqlTotalOrderProbeStrategy.snapshotSemantics, 'single_statement_mvcc',
    'MySQL must not inherit the PG token — its guarantee is conditional (InnoDB + autocommit), not unconditional')
  assert.notEqual(sqlServerTotalOrderProbeStrategy.snapshotSemantics, 'single_statement_mvcc',
    'SQL Server must not inherit the PG token — default READ COMMITTED gives no single-statement snapshot at all')
  // the SQL Server token names the ABSENCE of a guarantee, honestly
  assert.match(sqlServerTotalOrderProbeStrategy.snapshotSemantics, /no_single_statement_snapshot/)

  // ── THE PIN THAT ACTUALLY CLOSES OVERCLAIMING (review P1-2) ──────────────────────
  // Distinctness + "not literally PG's string" are BOTH satisfied by an overclaiming
  // token, so neither can refuse one. These EXACT equalities can. Written as inline
  // literals AND compared to the module constants above, so a single-place edit reds.
  assert.equal(
    mysqlTotalOrderProbeStrategy.snapshotSemantics,
    'single_statement_consistent_read_conditional_on_innodb_autocommit_and_isolation_read_committed_or_stricter',
    'MySQL snapshot token is digest-bearing evidence and is pinned EXACTLY — it must name all THREE conditions (InnoDB, autocommit, isolation >= READ COMMITTED)')
  assert.equal(
    sqlServerTotalOrderProbeStrategy.snapshotSemantics,
    'no_single_statement_snapshot_under_default_read_committed',
    'SQL Server snapshot token is digest-bearing evidence and is pinned EXACTLY')
  assert.equal(mysqlTotalOrderProbeStrategy.snapshotSemantics, MYSQL_SNAPSHOT_TOKEN)
  assert.equal(sqlServerTotalOrderProbeStrategy.snapshotSemantics, MSSQL_SNAPSHOT_TOKEN)

  // The MySQL token must NAME the isolation condition, not just InnoDB+autocommit
  // (review P2-4): under READ UNCOMMITTED an InnoDB SELECT is a dirty, non-consistent read,
  // so a consumer that verified only the two named conditions and trusted the token could
  // still get exactly the torn check it promises not to. REASONED, to be confirmed by spike.
  assert.match(mysqlTotalOrderProbeStrategy.snapshotSemantics, /innodb/)
  assert.match(mysqlTotalOrderProbeStrategy.snapshotSemantics, /autocommit/)
  assert.match(mysqlTotalOrderProbeStrategy.snapshotSemantics, /isolation_read_committed_or_stricter/)
  // and it must stay a legal identity token (<=128 printable chars) — it is registered below
  assert.ok(mysqlTotalOrderProbeStrategy.snapshotSemantics.length <= 128)
}

// ── 2. MySQL builder: shape, quoting, single-statement, key hygiene ──────────────────
function mysqlBuilderShape() {
  const dup = buildMysqlOrderingKeyDuplicateProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  assert.match(dup, /^SELECT `item_no`, `rev`, COUNT\(\*\) AS duplicate_count FROM `fixture_view` GROUP BY `item_no`, `rev` HAVING COUNT\(\*\) > 1 LIMIT 1$/)

  const nul = buildMysqlOrderingKeyNullProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  assert.match(nul, /^SELECT 1 AS null_key_row FROM `fixture_view` WHERE `item_no` IS NULL OR `rev` IS NULL LIMIT 1$/)

  const combined = buildMysqlOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no'] })
  // ONE statement (never two reads — a torn check), no semicolon.
  assert.equal((combined.match(/;/g) || []).length, 0)
  assert.match(combined, /^SELECT CAST\(\(SELECT COUNT\(\*\) FROM \(SELECT /)
  // derived tables carry MySQL-required aliases
  assert.match(combined, /\) AS gip_duplicate_probe\) AS SIGNED\) AS duplicate_groups_sampled/)
  assert.match(combined, /\) AS gip_null_probe\) AS SIGNED\) AS null_key_rows$/)
  assert.equal(__internals.assertReadOnlySql(combined), combined)

  // identifier hygiene: backtick doubling on embedded backticks, never raw interpolation
  assert.equal(__internals.quoteMysqlIdentifier('we`ird'), '`we``ird`')

  // shared hygiene (normalizeKeyColumns is dialect-agnostic): duplicate columns rejected
  rejectsWith(() => buildMysqlOrderingKeyDuplicateProbeSql({ objectName: 'v', keyColumns: ['k', 'k'] }), 'QUALIFICATION_INPUT_INVALID')
}

// ── 3. SQL Server builder: shape, quoting, TOP not LIMIT, single-statement ───────────
function sqlServerBuilderShape() {
  const dup = buildSqlServerOrderingKeyDuplicateProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  assert.match(dup, /^SELECT TOP \(1\) \[item_no\], \[rev\], COUNT\(\*\) AS duplicate_count FROM \[fixture_view\] GROUP BY \[item_no\], \[rev\] HAVING COUNT\(\*\) > 1$/)
  assert.ok(!/\bLIMIT\b/i.test(dup), 'SQL Server has no LIMIT — must use TOP')

  const nul = buildSqlServerOrderingKeyNullProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  assert.match(nul, /^SELECT TOP \(1\) 1 AS null_key_row FROM \[fixture_view\] WHERE \[item_no\] IS NULL OR \[rev\] IS NULL$/)

  const combined = buildSqlServerOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no'] })
  assert.equal((combined.match(/;/g) || []).length, 0)
  assert.ok(!/\bLIMIT\b/i.test(combined))
  assert.match(combined, /^SELECT \(SELECT COUNT\(\*\) FROM \(SELECT TOP \(1\)/)
  // no CAST — T-SQL COUNT(*) is already `int`, not bigint (language fact, not driver quirk)
  assert.ok(!/CAST/i.test(combined), 'SQL Server COUNT(*) is already int — no narrowing cast needed')
  assert.match(combined, /\) AS gip_duplicate_probe\) AS duplicate_groups_sampled/)
  assert.match(combined, /\) AS gip_null_probe\) AS null_key_rows$/)
  assert.equal(__internals.assertReadOnlySql(combined), combined)

  // identifier hygiene: bracket doubling on embedded `]`, never raw interpolation
  assert.equal(__internals.quoteSqlServerIdentifier('we]ird'), '[we]]ird]')

  rejectsWith(() => buildSqlServerOrderingKeyDuplicateProbeSql({ objectName: 'v', keyColumns: ['k', 'k'] }), 'QUALIFICATION_INPUT_INVALID')
}

// ── 4. Registration + WIRING: probe through the registered strategy, not the bare builder ──
async function registrationAndWiring() {
  // MySQL: drive PROBER.probe() against the REGISTERED profile — proves the registry
  // resolves to the MySQL builder (not merely that the builder works in isolation).
  const mysqlSeenSql = []
  const mysqlQuery = async (sql) => { mysqlSeenSql.push(sql); return { rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] } }
  const mysqlQual = await PROBER.probe({
    ...baseInputs(MYSQL_PROFILE), envelopeKey: ENVELOPE_KEY, query: mysqlQuery,
    keyColumns: ['item_no', 'rev'], probedAt: '2026-07-24T00:00:00Z',
  })
  assert.equal(mysqlQual.status, 'candidate')
  assert.equal(mysqlSeenSql.length, 1, 'exactly one statement — no torn check')
  assert.equal((mysqlSeenSql[0].match(/;/g) || []).length, 0)
  assert.match(mysqlSeenSql[0], /`item_no`, `rev`/)
  assert.match(mysqlSeenSql[0], /LIMIT 1/)
  assert.match(mysqlSeenSql[0], /CAST\(.*AS SIGNED\)/)
  assert.equal(mysqlQual.evidence.probeStrategyId, 'gip.total_order_probe.mysql')
  assert.equal(mysqlQual.evidence.probeStrategyVersion, 'v1')
  assert.equal(mysqlQual.evidence.probeDialect, 'mysql')
  // NOT self-referential: comparing evidence to the strategy object proves only that the
  // module copied its own field. The token that reaches the DIGEST is pinned to a literal.
  assert.equal(mysqlQual.evidence.snapshotSemantics, MYSQL_SNAPSHOT_TOKEN,
    'the token that reaches the digest is pinned to a literal, not to the object it came from')
  assert.equal(mysqlQual.evidence.snapshotSemantics, mysqlTotalOrderProbeStrategy.snapshotSemantics)
  assert.equal(mysqlQual.evidence.checkedKeyColumnCount, 2)

  // SQL Server: same, against ITS registered profile.
  const mssqlSeenSql = []
  const mssqlQuery = async (sql) => { mssqlSeenSql.push(sql); return { rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] } }
  const mssqlQual = await PROBER.probe({
    ...baseInputs(MSSQL_PROFILE), envelopeKey: ENVELOPE_KEY, query: mssqlQuery,
    keyColumns: ['item_no', 'rev'], probedAt: '2026-07-24T00:00:00Z',
  })
  assert.equal(mssqlQual.status, 'candidate')
  assert.equal(mssqlSeenSql.length, 1)
  assert.equal((mssqlSeenSql[0].match(/;/g) || []).length, 0)
  assert.match(mssqlSeenSql[0], /\[item_no\], \[rev\]/)
  assert.match(mssqlSeenSql[0], /TOP \(1\)/)
  assert.ok(!/\bLIMIT\b/i.test(mssqlSeenSql[0]))
  assert.equal(mssqlQual.evidence.probeStrategyId, 'gip.total_order_probe.sqlserver')
  assert.equal(mssqlQual.evidence.probeDialect, 'sqlserver')
  assert.equal(mssqlQual.evidence.snapshotSemantics, MSSQL_SNAPSHOT_TOKEN,
    'the token that reaches the digest is pinned to a literal, not to the object it came from')
  assert.equal(mssqlQual.evidence.snapshotSemantics, sqlServerTotalOrderProbeStrategy.snapshotSemantics)

  // duplicates / nulls still fail closed through the registered MySQL/SQL Server strategies
  // (proves the shared fail-closed branches are dialect-agnostic — not PG-only).
  await rejectsWithAsync(() => PROBER.probe({
    ...baseInputs(MYSQL_PROFILE), envelopeKey: ENVELOPE_KEY,
    query: async () => ({ rows: [{ duplicate_groups_sampled: 3, null_key_rows: 0 }] }),
    keyColumns: ['item_no'], probedAt: '2026-07-24T00:00:00Z',
  }), 'ORDERING_KEY_DUPLICATE_FOUND')
  await rejectsWithAsync(() => PROBER.probe({
    ...baseInputs(MSSQL_PROFILE), envelopeKey: ENVELOPE_KEY,
    query: async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 2 }] }),
    keyColumns: ['item_no'], probedAt: '2026-07-24T00:00:00Z',
  }), 'ORDERING_KEY_NULL_FOUND')

  // ── COUNT SHAPE ACCEPTANCE (reasoned, not measured — see strategy comments) ──
  // MySQL: mysql2 may surface a bounded BIGINT count as either a JS number or a canonical
  // decimal string depending on driver config; the CAST to SIGNED is belt-and-braces, and
  // the acceptor already takes both shapes regardless.
  const mysqlStringShape = await PROBER.probe({
    ...baseInputs(MYSQL_PROFILE), envelopeKey: ENVELOPE_KEY,
    query: async () => ({ rows: [{ duplicate_groups_sampled: '0', null_key_rows: '0' }] }),
    keyColumns: ['item_no'], probedAt: '2026-07-24T00:00:00Z',
  })
  assert.equal(mysqlStringShape.status, 'candidate', 'MySQL string-shaped counts (bigNumberStrings config) must qualify')
  // SQL Server: T-SQL COUNT(*) is `int`; the documented tedious/mssql mapping is a plain JS
  // number. We also accept the string shape belt-and-braces, same acceptor as every dialect.
  const mssqlNumberShape = await PROBER.probe({
    ...baseInputs(MSSQL_PROFILE), envelopeKey: ENVELOPE_KEY,
    query: async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] }),
    keyColumns: ['item_no'], probedAt: '2026-07-24T00:00:00Z',
  })
  assert.equal(mssqlNumberShape.status, 'candidate')

  // junk count shapes still fail closed identically across dialects (shared acceptor)
  await rejectsWithAsync(() => PROBER.probe({
    ...baseInputs(MYSQL_PROFILE), envelopeKey: ENVELOPE_KEY,
    query: async () => ({ rows: [{ duplicate_groups_sampled: '1e3', null_key_rows: '0' }] }),
    keyColumns: ['item_no'], probedAt: '2026-07-24T00:00:00Z',
  }), 'PROBE_QUERY_FAILED')
}

// ── 5. FAIL-CLOSED: a dialect with no registered strategy — even alongside THREE others ──
async function unboundDialectFailsClosed() {
  await rejectsWithAsync(() => PROBER.probe({
    ...baseInputs(UNBOUND_PROFILE), envelopeKey: ENVELOPE_KEY,
    query: async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] }),
    keyColumns: ['item_no'], probedAt: '2026-07-24T00:00:00Z',
  }), 'PROBE_STRATEGY_UNBOUND')
  // POSITIVE CONTROL beside it: the SAME registry still answers all three REGISTERED
  // dialects — PROBE_STRATEGY_UNBOUND is not a blanket rejector.
  for (const profile of [PG_PROFILE, MYSQL_PROFILE, MSSQL_PROFILE]) {
    const ok = await PROBER.probe({
      ...baseInputs(profile), envelopeKey: ENVELOPE_KEY,
      query: async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] }),
      keyColumns: ['item_no'], probedAt: '2026-07-24T00:00:00Z',
    })
    assert.equal(ok.status, 'candidate', `${profile} must still resolve to its own registered strategy`)
  }
}

// ── 6. GUARD HARDENING — every newly-blocked construct, each with a positive control ──
function guardHardening() {
  const mysqlLegit = buildMysqlOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no'] })
  const mssqlLegit = buildSqlServerOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no'] })
  const pgLegit = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))
    .buildOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no'] })

  function blockedWithControls(sql) {
    rejectsWith(() => __internals.assertReadOnlySql(sql), 'PROBE_SQL_NOT_READ_ONLY')
    // POSITIVE CONTROL beside every rejection: the legitimate probes for ALL THREE
    // registered dialects must still pass — a guard that rejects everything must not pass.
    assert.equal(__internals.assertReadOnlySql(mysqlLegit), mysqlLegit)
    assert.equal(__internals.assertReadOnlySql(mssqlLegit), mssqlLegit)
    assert.equal(__internals.assertReadOnlySql(pgLegit), pgLegit)
  }

  // ── MySQL constructs (EMPIRICALLY CONFIRMED to pass before this slice — see B1B brief) ──
  blockedWithControls("SELECT GET_LOCK('x',10) FROM t")
  blockedWithControls("SELECT RELEASE_LOCK('x') FROM t")
  blockedWithControls('SELECT SLEEP(30) FROM t')
  blockedWithControls("SELECT BENCHMARK(100000000,MD5('x')) FROM t")
  blockedWithControls("SELECT LOAD_FILE('/etc/passwd') FROM t")
  // INTO OUTFILE/DUMPFILE already trips the EXISTING generic INTO token — confirming, not new.
  blockedWithControls("SELECT * FROM t INTO OUTFILE '/tmp/x'")
  blockedWithControls("SELECT * FROM t INTO DUMPFILE '/tmp/x'")
  // LOAD DATA is a standalone STATEMENT, not an expression. CORRECTED (round-2 re-verification
  // NEW-4): the earlier comment here claimed this "provably" exercises the structural first
  // branch of assertReadOnlySql rather than a token door. That was FALSE — measured, it trips
  // the ratified write-token door via `INTO`, so it does not isolate the structural branch at all.
  rejectsWith(() => __internals.assertReadOnlySql("LOAD DATA INFILE '/etc/passwd' INTO TABLE x"), 'PROBE_SQL_NOT_READ_ONLY')
  // The STRUCTURAL branch, actually isolated: this string trips NO token door in any dialect —
  // only the `^SELECT\b` anchor and the `/;/` multi-statement rule can reject it. Without this
  // discriminator, neutering BOTH structural rules left every suite green while
  // `SELECT 1; SELECT 2` went REJECTED -> ACCEPTED (a pre-existing gap in the ratified suite).
  rejectsWith(() => __internals.assertReadOnlySql('SELECT 1; SELECT 2'), 'PROBE_SQL_NOT_READ_ONLY')

  // ── SQL Server constructs (EMPIRICALLY CONFIRMED to pass before this slice) ──
  blockedWithControls("SELECT 1 FROM t WHERE 1=1 WAITFOR DELAY '0:0:5'")
  blockedWithControls("SELECT 1 FROM t WHERE 1=(EXEC xp_cmdshell 'dir')")
  blockedWithControls("SELECT * FROM OPENROWSET('SQLNCLI','...','SELECT 1')")
  blockedWithControls("SELECT * FROM OPENQUERY(linked_srv, 'SELECT 1')")
  blockedWithControls("SELECT * FROM OPENDATASOURCE('SQLNCLI','srv').db.dbo.t")
  // SELECT...INTO already trips the EXISTING generic INTO token — confirming, not new.
  blockedWithControls('SELECT * INTO newtable FROM t')

  // ── PostgreSQL constructs — this guard runs on EVERY dialect, including PG (one of the
  // THREE dialects THIS SLICE registers). A first pass covering only MySQL/SQL Server left
  // PG's own members of the exact classes just blocked (timing primitive, arbitrary file
  // read) untouched — pg_sleep is the direct analogue of MySQL SLEEP, and
  // pg_read_file/pg_read_binary_file/lo_import/lo_export are the direct analogues of
  // MySQL LOAD_FILE. EMPIRICALLY CONFIRMED to pass before this fix (self-confirmed, not from
  // the brief — found while extending the guard to "every dialect I register").
  blockedWithControls('SELECT pg_sleep(30) FROM t')
  blockedWithControls("SELECT pg_read_file('/etc/passwd') FROM t")
  blockedWithControls("SELECT pg_read_binary_file('/etc/passwd') FROM t")
  blockedWithControls("SELECT lo_import('/etc/passwd') FROM t")
  blockedWithControls("SELECT lo_export(1,'/tmp/x') FROM t")

  // ── SQL SERVER LOCK-TAKING: TABLE HINTS (review P1-1) ────────────────────────────────
  // T-SQL has NO `FOR UPDATE` / `FOR SHARE` syntax (language fact), so the RATIFIED
  // `\bFOR\s+(UPDATE|SHARE|…)\b` clause token matches NOTHING a T-SQL client can write:
  // before this fix, this dialect's entire lock-taking class had ZERO coverage while the
  // slice registered a `sqlserver` strategy. Locks are taken with table hints — VERIFIED
  // to pass the pre-fix guard by running it directly, not assumed from the review.
  blockedWithControls('SELECT * FROM t WITH (UPDLOCK)')
  blockedWithControls('SELECT * FROM t WITH (XLOCK, HOLDLOCK)')
  // XLOCK ALONE (round-2 re-verification NEW-1). The multi-hint probe above cannot pin it:
  // HOLDLOCK covers for it, so dropping XLOCK from the vocabulary left the suite green while
  // `WITH (XLOCK)` went REJECTED -> ACCEPTED. Door-level exclusivity does not pin TOKENS —
  // tokens inside one door still cover for each other. XLOCK is the exclusive-lock hint, the
  // most state-taking member of the class it belongs to.
  blockedWithControls('SELECT a FROM t WITH (XLOCK)')
  blockedWithControls('SELECT * FROM t WITH (TABLOCK)')
  blockedWithControls('SELECT * FROM t WITH (TABLOCKX)')
  blockedWithControls('SELECT * FROM t WITH (ROWLOCK)')
  blockedWithControls('SELECT * FROM t WITH (PAGLOCK)')
  blockedWithControls('SELECT * FROM t WITH (HOLDLOCK)')
  blockedWithControls('SELECT * FROM t WITH (SERIALIZABLE)')
  blockedWithControls('SELECT * FROM t WITH (REPEATABLEREAD)')
  blockedWithControls('SELECT * FROM t WITH (READCOMMITTEDLOCK)')
  blockedWithControls('SELECT * FROM t WITH (READPAST)')
  // …and the BARE (no `WITH`) legacy hint spelling, which is still accepted by T-SQL.
  blockedWithControls('SELECT * FROM t (NOLOCK)')
  // NOLOCK / READUNCOMMITTED are the OPPOSITE hazard and matter just as much here: they do
  // not take a lock, they DESTROY the read that this slice's `sqlserver` snapshot token
  // exists to describe (dirty reads). A probe carrying them would mint evidence under a
  // token describing a read that did not happen.
  blockedWithControls('SELECT * FROM t WITH (NOLOCK)')
  blockedWithControls('SELECT * FROM t WITH (READUNCOMMITTED)')
  blockedWithControls('SELECT * FROM t WITH (READCOMMITTED)')

  // ── MySQL LOCK-TAKING: the pre-8.0 spelling (review P2-2) ────────────────────────────
  // `LOCK IN SHARE MODE` is the pre-8.0 spelling of `FOR SHARE`, still supported, and it
  // still takes shared row locks (REASONED — to be confirmed by spike; no MySQL reachable
  // here). The ratified clause token only knows the `FOR …` spelling.
  blockedWithControls('SELECT * FROM t LOCK IN SHARE MODE')
  blockedWithControls('SELECT * FROM t WHERE a=1 lock in share mode')

  // ── SQL SERVER FILE-READ class: the `fn_` family (review P2-3) ───────────────────────
  // Neither `xp_` nor `sp_`, so the prefix pattern did not reach them before this fix.
  blockedWithControls("SELECT * FROM fn_get_audit_file('x',default,default)")
  blockedWithControls("SELECT * FROM ::fn_trace_gettable('x', default)")
  blockedWithControls("SELECT * FROM sys.fn_get_audit_file('x',default,default)")

  // ── `\b`-TERMINATION ESCAPES: longer identifiers sharing a blocked prefix (review P2-1a) ──
  // A `\b`-terminated token cannot match an identifier that CONTINUES past it, so every one
  // of these passed the pre-fix guard even though the class was claimed closed. The fix
  // applies the same `[A-Za-z0-9_]*` technique already used by the xp_/sp_ prefix pattern.
  blockedWithControls("SELECT pg_sleep_for('5 minutes') FROM t")
  blockedWithControls('SELECT pg_sleep_until(now()) FROM t')
  blockedWithControls('SELECT lo_get(1) FROM t')
  blockedWithControls("SELECT pg_ls_dir('/') FROM t")
  blockedWithControls('SELECT pg_ls_logdir() FROM t')
  blockedWithControls("SELECT pg_stat_file('/etc/passwd') FROM t")
  // RELEASE_ALL_LOCKS is NOT reachable by prefix-extending RELEASE_LOCK — listed explicitly.
  blockedWithControls('SELECT RELEASE_ALL_LOCKS() FROM t')

  // ── PRE-EXISTING GAP IN THE RATIFIED GUARD, closed here (review P2-1b) ───────────────
  // NOT introduced by B1b: `PG_ADVISORY_LOCK`/`PG_ADVISORY_XACT_LOCK`/`PG_TRY_ADVISORY_LOCK`
  // landed `\b`-terminated in the ratified token list, so the `_shared` variants — real
  // functions that take real advisory locks — escaped it. Closed additively (a new prefix
  // pattern), with the ratified alternation left byte-identical; pinned below.
  blockedWithControls('SELECT pg_advisory_lock_shared(1)')
  blockedWithControls('SELECT pg_advisory_xact_lock_shared(1)')
  blockedWithControls('SELECT pg_try_advisory_lock_shared(1)')
  blockedWithControls('SELECT pg_advisory_unlock_all()')

  // ── DISCRIMINATING PAIRS — isolate EACH pattern so a mutation of ONE cannot hide behind
  // the other (the brief's fused "EXEC xp_cmdshell" string trips BOTH DIALECT_UNSAFE_TOKEN_
  // PATTERN and MSSQL_PROCEDURE_PREFIX_PATTERN, so it alone cannot prove either is load-
  // bearing on its own) ──
  blockedWithControls('SELECT 1 FROM t WHERE 1=(EXEC someproc)') // EXEC, no xp_/sp_ prefix anywhere
  blockedWithControls('SELECT 1 FROM t WHERE 1=(EXECUTE someproc)') // EXECUTE, no prefix
  blockedWithControls('SELECT sp_configure FROM t') // sp_ prefix, no EXEC/EXECUTE token
  blockedWithControls('SELECT xp_cmdshell FROM t') // xp_ prefix, no EXEC/EXECUTE token

  // ── OVERBREADTH IS DELIBERATE AND PINNED: the xp_/sp_ prefix pattern runs in the SHARED
  // assertReadOnlySql on EVERY dialect (it is not SQL-Server-scoped), so it also rejects a
  // LEGITIMATE object merely named `sp_parts` through the SQL Server, MySQL AND PG builders
  // alike — fail-CLOSED, on purpose, everywhere it applies. Pinned cross-dialect so a future
  // "precision fix" (e.g. scoping the pattern to only the SQL Server strategy) cannot
  // silently reopen the xp_cmdshell/sp_ hole for the dialect it gets scoped BACK to. ──
  const spNamedObjectSql = buildSqlServerOrderingKeyTotalOrderProbeSql({ objectName: 'sp_parts', keyColumns: ['item_no'] })
  rejectsWith(() => __internals.assertReadOnlySql(spNamedObjectSql), 'PROBE_SQL_NOT_READ_ONLY')
  const spNamedObjectSqlMysql = buildMysqlOrderingKeyTotalOrderProbeSql({ objectName: 'sp_parts', keyColumns: ['item_no'] })
  rejectsWith(() => __internals.assertReadOnlySql(spNamedObjectSqlMysql), 'PROBE_SQL_NOT_READ_ONLY')
  const spNamedObjectSqlPg = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))
    .buildOrderingKeyTotalOrderProbeSql({ objectName: 'sp_parts', keyColumns: ['item_no'] })
  rejectsWith(() => __internals.assertReadOnlySql(spNamedObjectSqlPg), 'PROBE_SQL_NOT_READ_ONLY')
  // The overbreadth GREW with this fix (fn_ and lo_ are new two-letter prefix families, and
  // the lock-hint vocabulary is all bare words), so it is pinned by SAMPLE from each newly
  // broad rule rather than described in prose — the doc in lib and the behaviour here are
  // the same artifact. Each of these is a LEGITIMATE name that this guard now refuses:
  for (const objectName of ['fn_report', 'lo_batch', 'xp_report']) {
    const sql = buildSqlServerOrderingKeyTotalOrderProbeSql({ objectName, keyColumns: ['item_no'] })
    rejectsWith(() => __internals.assertReadOnlySql(sql), 'PROBE_SQL_NOT_READ_ONLY')
  }
  // …and a KEY COLUMN (not just an object) named after a bare token, on MySQL and PG too.
  for (const keyColumn of ['nolock', 'serializable', 'readpast', 'exec', 'waitfor', 'benchmark']) {
    const mysqlSql = buildMysqlOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: [keyColumn] })
    rejectsWith(() => __internals.assertReadOnlySql(mysqlSql), 'PROBE_SQL_NOT_READ_ONLY')
    const pgSql = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))
      .buildOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: [keyColumn] })
    rejectsWith(() => __internals.assertReadOnlySql(pgSql), 'PROBE_SQL_NOT_READ_ONLY')
  }
  // The keyword tokens are deliberately NOT prefix-extended, so an ordinary column whose
  // name merely STARTS with one is unaffected — this is the boundary of the trade-off, and
  // it is pinned so a later "make it consistent" edit has to face it.
  for (const keyColumn of ['execution_date', 'sleeper_agent_id', 'benchmarks_total']) {
    const sql = buildMysqlOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: [keyColumn] })
    assert.equal(__internals.assertReadOnlySql(sql), sql, `${keyColumn} must NOT be rejected — keyword tokens are exact-word by design`)
  }
  // …and the positive control: normally-named objects are unaffected, on all three dialects.
  assert.equal(__internals.assertReadOnlySql(mssqlLegit), mssqlLegit)
  assert.equal(__internals.assertReadOnlySql(mysqlLegit), mysqlLegit)
  assert.equal(__internals.assertReadOnlySql(pgLegit), pgLegit)

  // ── Existing (unmodified) tokens still work — NOTHING was weakened ──
  rejectsWith(() => __internals.assertReadOnlySql('DELETE FROM x'), 'PROBE_SQL_NOT_READ_ONLY')
  rejectsWith(() => __internals.assertReadOnlySql('SELECT 1; DROP TABLE x'), 'PROBE_SQL_NOT_READ_ONLY')
  rejectsWith(() => __internals.assertReadOnlySql('SELECT * FROM x FOR UPDATE'), 'PROBE_SQL_NOT_READ_ONLY')
  rejectsWith(() => __internals.assertReadOnlySql('SELECT pg_advisory_lock(1)'), 'PROBE_SQL_NOT_READ_ONLY')
  // and the reference PG probe still passes end to end (the legitimacy control the brief names)
  assert.equal(__internals.assertReadOnlySql(pgLegit), pgLegit)
}

// ── 7. THE GUARD'S DOORS MUST NOT COVER FOR EACH OTHER ───────────────────────────────
// assertReadOnlySql now ORs six regexes. If a new pattern's discriminating probe were also
// caught by a neighbour, neutering that new pattern would still leave the probe rejected —
// the mutation would go GREEN and prove nothing (fail-closed doors covering for each
// other). This asserts each discriminator is caught by EXACTLY ONE pattern, mechanically,
// so the mutation evidence in the report is real. It also pins the two RATIFIED patterns
// character-for-character: "no existing token was weakened" becomes a check, not a claim.
function guardPatternExclusivity() {
  const patterns = __internals.readOnlyGuardPatterns
  assert.deepEqual(Object.keys(patterns), [
    'ratifiedWriteTokens',
    'ratifiedRowLockClause',
    'dialectKeyword',
    'dialectRoutinePrefix',
    'mssqlProcedurePrefix',
    'dialectLockTaking',
  ], 'the guard is exactly these six doors — adding one must update this pin in the same edit')

  // RATIFIED, byte-identical. B1b extracted them to consts so they could be tested; it did
  // not add, remove, reorder or reword a single token.
  assert.equal(patterns.ratifiedWriteTokens.source,
    '\\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|INTO|SETVAL|NEXTVAL|PG_ADVISORY_LOCK|PG_ADVISORY_XACT_LOCK|PG_TRY_ADVISORY_LOCK)\\b')
  assert.equal(patterns.ratifiedWriteTokens.flags, 'i')
  assert.equal(patterns.ratifiedRowLockClause.source,
    '\\bFOR\\s+(UPDATE|SHARE|NO\\s+KEY\\s+UPDATE|KEY\\s+SHARE)\\b')
  assert.equal(patterns.ratifiedRowLockClause.flags, 'i')

  // [sql, the ONE door that must catch it]
  const discriminators = [
    ['DELETE FROM x', 'ratifiedWriteTokens'],
    // NOT `FOR UPDATE` — that is caught by the write-token door too (UPDATE), a
    // PRE-EXISTING overlap. `FOR KEY SHARE` isolates the clause door.
    ['SELECT * FROM x FOR KEY SHARE', 'ratifiedRowLockClause'],
    ['SELECT SLEEP(30) FROM t', 'dialectKeyword'],
    ['SELECT 1 FROM t WHERE 1=(EXEC someproc)', 'dialectKeyword'],
    ["SELECT * FROM OPENROWSET('SQLNCLI','...','SELECT 1')", 'dialectKeyword'],
    ["SELECT pg_sleep_for('5 minutes') FROM t", 'dialectRoutinePrefix'],
    ['SELECT lo_get(1) FROM t', 'dialectRoutinePrefix'],
    ["SELECT pg_stat_file('/etc/passwd') FROM t", 'dialectRoutinePrefix'],
    // the pre-existing-gap probe: proves the ratified door does NOT already catch it, so
    // the P2-1b mutation below is not vacuous
    ['SELECT pg_advisory_lock_shared(1)', 'dialectRoutinePrefix'],
    ['SELECT sp_configure FROM t', 'mssqlProcedurePrefix'],
    ["SELECT * FROM fn_get_audit_file('x',default,default)", 'mssqlProcedurePrefix'],
    ['SELECT * FROM t WITH (UPDLOCK)', 'dialectLockTaking'],
    ['SELECT * FROM t (NOLOCK)', 'dialectLockTaking'],
    ['SELECT * FROM t LOCK IN SHARE MODE', 'dialectLockTaking'],
  ]
  for (const [sql, expected] of discriminators) {
    // the structural branches (^SELECT anchor / semicolon) must not be the real cover either
    assert.ok(/^SELECT\b/i.test(sql) || expected === 'ratifiedWriteTokens', `${sql}: must reach the token branch`)
    assert.ok(!/;/.test(sql), `${sql}: must not be caught by the semicolon branch`)
    const caughtBy = Object.entries(patterns).filter(([, re]) => re.test(sql)).map(([name]) => name)
    assert.deepEqual(caughtBy, [expected], `${sql} must be caught by EXACTLY ONE door (got ${JSON.stringify(caughtBy)})`)
  }

  // …and the legitimate probes are caught by NONE of the six.
  const pg = require(path.join(__dirname, '..', 'lib', 'gip-binding-qualification-spike.cjs'))
    .buildOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  const my = buildMysqlOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  const ms = buildSqlServerOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['item_no', 'rev'] })
  for (const sql of [pg, my, ms]) {
    const caughtBy = Object.entries(patterns).filter(([, re]) => re.test(sql)).map(([name]) => name)
    assert.deepEqual(caughtBy, [], `a legitimate probe must trip NO door (got ${JSON.stringify(caughtBy)})`)
  }
}

// ── 8. KNOWN LIMITATION, recorded as behaviour: derived-table duplicate output column ──
// If a key column is itself named `duplicate_count` (or `null_key_row`), the derived table
// is asked for two output columns of the same name.
//   MEASURED here: the generated SQL really does contain the name twice — a fact about our
//   own generator, provable without any server.
//   REASONED, TO BE CONFIRMED BY SPIKE: MySQL rejects it (ER_DUP_FIELDNAME / 1060) and
//   T-SQL rejects it ("specified multiple times"); PostgreSQL tolerates duplicate output
//   names in a derived table when nothing references them ambiguously (nothing here does).
// Either way it is FAIL-CLOSED: the driver's rejection becomes PROBE_QUERY_FAILED and no
// qualification is minted. The second half simulates the driver rejection — it proves the
// catch path, NOT the server's error code.
async function derivedTableDuplicateOutputColumn() {
  const mysqlSql = buildMysqlOrderingKeyDuplicateProbeSql({ objectName: 'fixture_view', keyColumns: ['duplicate_count'] })
  assert.equal((mysqlSql.match(/duplicate_count/g) || []).length, 3,
    'MEASURED: the key column and the computed alias collide in the derived select list (2 in the projection + 1 in GROUP BY)')
  assert.match(mysqlSql, /^SELECT `duplicate_count`, COUNT\(\*\) AS duplicate_count FROM /)
  const mssqlSql = buildSqlServerOrderingKeyDuplicateProbeSql({ objectName: 'fixture_view', keyColumns: ['duplicate_count'] })
  assert.match(mssqlSql, /^SELECT TOP \(1\) \[duplicate_count\], COUNT\(\*\) AS duplicate_count FROM /)
  const mysqlNullSql = buildMysqlOrderingKeyNullProbeSql({ objectName: 'fixture_view', keyColumns: ['null_key_row'] })
  assert.match(mysqlNullSql, /^SELECT 1 AS null_key_row FROM `fixture_view` WHERE `null_key_row` IS NULL/)

  // The SQL is still guard-legal (this is a driver-level collision, not a read-only
  // violation) — POSITIVE CONTROL that the guard is not what is failing here.
  const combined = buildMysqlOrderingKeyTotalOrderProbeSql({ objectName: 'fixture_view', keyColumns: ['duplicate_count'] })
  assert.equal(__internals.assertReadOnlySql(combined), combined)

  // …and a driver that rejects it fails CLOSED, not into a mis-read.
  await rejectsWithAsync(() => PROBER.probe({
    ...baseInputs(MYSQL_PROFILE), envelopeKey: ENVELOPE_KEY,
    query: async () => { throw new Error('simulated driver rejection (ER_DUP_FIELDNAME shape) — code NOT verified against a real server') },
    keyColumns: ['duplicate_count'], probedAt: '2026-07-24T00:00:00Z',
  }), 'PROBE_QUERY_FAILED')
  // POSITIVE CONTROL: the same profile with a cooperating driver still qualifies, so
  // PROBE_QUERY_FAILED above is the REJECTION and not the ambient state of this fixture.
  const ok = await PROBER.probe({
    ...baseInputs(MYSQL_PROFILE), envelopeKey: ENVELOPE_KEY,
    query: async () => ({ rows: [{ duplicate_groups_sampled: 0, null_key_rows: 0 }] }),
    keyColumns: ['duplicate_count'], probedAt: '2026-07-24T00:00:00Z',
  })
  assert.equal(ok.status, 'candidate')
}

function main() {
  strategyIdentity()
  mysqlBuilderShape()
  sqlServerBuilderShape()
  guardHardening()
  guardPatternExclusivity()
  return Promise.resolve()
    .then(registrationAndWiring)
    .then(unboundDialectFailsClosed)
    .then(derivedTableDuplicateOutputColumn)
    .then(() => console.log('gip-dialect-probe-strategies.test.cjs OK'))
}

main().catch((error) => {
  console.error('gip-dialect-probe-strategies.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
