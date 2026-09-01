import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import {
  __resetSqlArmBindingsForTests,
  sqlConnectionFingerprint,
  sqlSourceConnectionMatchesPin,
} from '../../src/data-adapters/sql-write-arm-binding'
import {
  OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID,
  OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS,
  OUTBOUND_SQL_WRITE_DISABLED,
  OUTBOUND_SQL_WRITE_ERROR_CODES,
  OUTBOUND_SQL_WRITE_OPERATIONS,
  OUTBOUND_SQL_WRITE_OPERATION_STATEMENT,
  OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
  OUTBOUND_SQL_WRITE_TARGETS_ENV,
  OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
  OutboundSqlWriteGateError,
  assertOutboundSqlWriteAuthorized,
  assertSqlStatementWriteAuthorized,
  evaluateOutboundSqlWrite,
  isPureReadStatement,
  isSqlWriteStatement,
  loadOutboundSqlWriteAllowlist,
} from '../../src/data-adapters/outbound-sql-write-gate'

/**
 * W-1(c) DEFAULT-DENY GATE FOR GENERIC OUTBOUND SQL WRITE.
 *
 * WHAT WAS OPEN BEFORE THIS GATE. On a `readOnly:false` generic SQL source the route's SELECT-only
 * classifier is SKIPPED (routes/data-sources.ts), so an arbitrary INSERT/UPDATE/DELETE/MERGE/EXEC fell
 * straight through to `DataSourceManager.query`. The previous mitigation tried to SNIFF THE
 * DESTINATION — parse the statement for K3 table names, probe the catalog — and four rounds of
 * adversarial verification defeated it with ordinary T-SQL. That is the option the owner rejected on
 * 2026-08-29; the ruling was to gate the CAPABILITY, exactly as the generic HTTP lane was closed.
 *
 * WHAT THIS SUITE PROVES:
 *   PART 1  THE LEAF. Load semantics, the closed key sets, identity-not-destination matching, the
 *           wildcard refusal, the operation vocabulary, values-free refusals, and the DEFAULT (env
 *           unset => every write refused, reads untouched).
 *   PART 2  THE WRITE/READ SPLIT, which is the ONLY classification the gate performs — and which must
 *           be fail-closed on every shape that defeated the destination sniffer.
 *   PART 3  THE ENFORCEMENT POINTS. Real DataSourceManager + real MSSQLAdapter: an unarmed write is
 *           refused before the driver; an ARMED target writes; every read passes either way.
 *
 * NOT A DUPLICATE OF THE K3 FENCES. Those are a permanent BAN with no runtime switch. This is a GATE
 * a deployment opens for named sources. Collapsing them would be the first step toward turning the
 * ban into a gate or the gate into a ban.
 */

const ENV_KEY = OUTBOUND_SQL_WRITE_TARGETS_ENV
const savedEnv = process.env[ENV_KEY]
const tempFiles: string[] = []

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  vi.restoreAllMocks()
  __resetSqlArmBindingsForTests() // the arm-binding registry is a process singleton
  for (const file of tempFiles.splice(0)) {
    try { fs.unlinkSync(file) } catch { /* best effort */ }
  }
})

function writeAllowlistFile(contents: unknown): string {
  const file = path.join(os.tmpdir(), `sql-write-allowlist-${Math.random().toString(36).slice(2)}.json`)
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  tempFiles.push(file)
  return file
}

function armFor(systemId: string, extra: Record<string, unknown> = {}): void {
  process.env[ENV_KEY] = writeAllowlistFile({
    allowlistId: 'test-allowlist',
    allowlistVersion: 1,
    targets: [{ entryId: 'e1', systemId, allObjects: true, ...extra }],
  })
}

const buildError = (status: number, code: string, message: string, details: Record<string, unknown>) =>
  Object.assign(new Error(message), { status, code, details })

function refusalOf(fn: () => unknown): { code?: string; status?: number; message?: string; details?: Record<string, unknown> } {
  try {
    fn()
  } catch (error) {
    return error as { code?: string; status?: number; message?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected a refusal, but nothing was thrown')
}

// ─────────────────── PART 1 — THE LEAF ───────────────────

describe('outbound SQL write gate — the default is DENY', () => {
  it('env unset: every write is refused with the fixed code, before any file I/O', () => {
    delete process.env[ENV_KEY]
    const readSpy = vi.spyOn(fs, 'readFileSync')
    const decision = evaluateOutboundSqlWrite({ systemId: 's1', operation: OUTBOUND_SQL_WRITE_OPERATION_STATEMENT })
    expect(decision.authorized).toBe(false)
    expect(decision.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(decision.status).toBe(OUTBOUND_SQL_WRITE_REFUSAL_STATUS)
    expect(decision.reason).toBe('capability_not_authorized')
    expect(readSpy).not.toHaveBeenCalled() // the default path opens nothing
  })

  it('env blank is the same as unset', () => {
    process.env[ENV_KEY] = '   '
    expect(loadOutboundSqlWriteAllowlist()).toBeNull()
    expect(evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' }).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('the refusal codes are a frozen, distinct vocabulary', () => {
    expect([...OUTBOUND_SQL_WRITE_ERROR_CODES]).toEqual([
      'OUTBOUND_SQL_WRITE_DISABLED',
      'OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED',
      'OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID',
    ])
    // "gate shut" and "gate open, target not listed" must stay DISTINCT — different remedies.
    expect(OUTBOUND_SQL_WRITE_DISABLED).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(OUTBOUND_SQL_WRITE_REFUSAL_STATUS).toBe(403)
    expect(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS).toBe(500)
    expect([...OUTBOUND_SQL_WRITE_OPERATIONS]).toEqual(['statement'])
    expect(() => { (OUTBOUND_SQL_WRITE_OPERATIONS as unknown as string[]).push('x') }).toThrow(TypeError)
  })

  it('an unknown operation default-refuses (a new write path must be inventoried)', () => {
    armFor('s1')
    const decision = evaluateOutboundSqlWrite({ systemId: 's1', operation: 'exfiltrate' })
    expect(decision.authorized).toBe(false)
    expect(decision.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(decision.reason).toBe('unknown_write_operation')
  })
})

describe('outbound SQL write gate — arming', () => {
  it('an armed source is authorized; an unlisted source gets the DISTINCT not-authorized code', () => {
    armFor('armed-source')
    const ok = evaluateOutboundSqlWrite({ systemId: 'armed-source', operation: 'statement' })
    expect(ok.authorized).toBe(true)
    expect(ok.entryId).toBe('e1')
    expect(ok.code).toBeNull()

    const denied = evaluateOutboundSqlWrite({ systemId: 'other-source', operation: 'statement' })
    expect(denied.authorized).toBe(false)
    expect(denied.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(denied.reason).toBe('target_not_listed')
    expect(denied.allowlistTargetCount).toBe(1) // a COUNT, never the names
  })

  it('corroborating identities only NARROW a match, never widen one', () => {
    armFor('s1', { systemName: 'Staging', kind: 'sqlserver' })
    expect(evaluateOutboundSqlWrite({ systemId: 's1', systemName: 'Staging', kind: 'sqlserver', operation: 'statement' }).authorized).toBe(true)
    // Present-but-disagreeing corroboration refuses.
    expect(evaluateOutboundSqlWrite({ systemId: 's1', systemName: 'Other', kind: 'sqlserver', operation: 'statement' }).authorized).toBe(false)
    expect(evaluateOutboundSqlWrite({ systemId: 's1', systemName: 'Staging', kind: 'postgres', operation: 'statement' }).authorized).toBe(false)
  })

  it('fails closed on an under-specified subject', () => {
    armFor('s1')
    const d = evaluateOutboundSqlWrite({ systemId: null, operation: 'statement' })
    expect(d.authorized).toBe(false)
    expect(d.reason).toBe('missing_system_identity')
  })

  it('an ARMED but EMPTY allowlist authorizes nothing (a legal, visible state)', () => {
    process.env[ENV_KEY] = writeAllowlistFile({ allowlistId: 'empty', allowlistVersion: 1, targets: [] })
    const d = evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' })
    expect(d.authorized).toBe(false)
    expect(d.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
  })
})

describe('outbound SQL write gate — the allowlist file is validated, and a fault DENIES', () => {
  it('unreadable / malformed / not-an-object all throw INVALID and never echo the path', () => {
    process.env[ENV_KEY] = path.join(os.tmpdir(), 'definitely-not-here-9f2b.json')
    const unreadable = refusalOf(() => loadOutboundSqlWriteAllowlist())
    expect(unreadable.code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)
    expect(unreadable.message).toContain(ENV_KEY)
    expect(unreadable.message).not.toContain('definitely-not-here-9f2b') // the path is topology

    process.env[ENV_KEY] = writeAllowlistFile('{ not json')
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)

    process.env[ENV_KEY] = writeAllowlistFile([1, 2, 3])
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)
  })

  it('a load fault DEGRADES A PREVIEW into an honest refusal rather than throwing', () => {
    process.env[ENV_KEY] = writeAllowlistFile('{ not json')
    const d = evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' })
    expect(d.authorized).toBe(false)
    expect(d.code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)
    expect(d.status).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS)
  })

  it('DESTINATION keys are refused AT LOAD, by name, stating the rule', () => {
    for (const key of ['host', 'server', 'database', 'connectionString', 'dsn', 'port', 'linkedServer', 'password']) {
      process.env[ENV_KEY] = writeAllowlistFile({
        allowlistId: 'a', allowlistVersion: 1,
        targets: [{ entryId: 'e1', systemId: 's1', allObjects: true, [key]: 'anything' }],
      })
      const err = refusalOf(() => loadOutboundSqlWriteAllowlist())
      expect(err.code).toBe(OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID)
      expect(err.details?.reason).toBe('identity_matching_only')
    }
  })

  it('an objects enumeration is refused with its own message (no object scope on this lane)', () => {
    process.env[ENV_KEY] = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1,
      targets: [{ entryId: 'e1', systemId: 's1', objects: ['t'] }],
    })
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('object_scope_not_supported')
  })

  it('allObjects must be stated explicitly; wildcards and duplicates are refused', () => {
    process.env[ENV_KEY] = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1, targets: [{ entryId: 'e1', systemId: 's1' }],
    })
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('object_scope_required')

    for (const wildcard of ['*', 'all', 'any', 'pre*fix']) {
      process.env[ENV_KEY] = writeAllowlistFile({
        allowlistId: 'a', allowlistVersion: 1,
        targets: [{ entryId: 'e1', systemId: wildcard, allObjects: true }],
      })
      expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('wildcard_forbidden')
    }

    process.env[ENV_KEY] = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1,
      targets: [
        { entryId: 'dup', systemId: 's1', allObjects: true },
        { entryId: 'dup', systemId: 's2', allObjects: true },
      ],
    })
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('duplicate_entry_id')

    process.env[ENV_KEY] = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1,
      targets: [{ entryId: 'e1', systemId: 's1', allObjects: true, operations: ['drop-everything'] }],
    })
    expect(refusalOf(() => loadOutboundSqlWriteAllowlist()).details?.reason).toBe('unknown_operation')
  })

  it('NO CACHING: revoking an entry takes effect immediately', () => {
    const file = writeAllowlistFile({
      allowlistId: 'a', allowlistVersion: 1, targets: [{ entryId: 'e1', systemId: 's1', allObjects: true }],
    })
    process.env[ENV_KEY] = file
    expect(evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' }).authorized).toBe(true)
    fs.writeFileSync(file, JSON.stringify({ allowlistId: 'a', allowlistVersion: 2, targets: [] }), 'utf8')
    expect(evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' }).authorized).toBe(false)
  })
})

describe('outbound SQL write gate — refusals are values-free', () => {
  it('a refusal carries no SQL, table, host or path', () => {
    delete process.env[ENV_KEY]
    const err = refusalOf(() => assertOutboundSqlWriteAuthorized(buildError, { systemId: 'src-1', operation: 'statement' }))
    const serialized = JSON.stringify({ message: err.message, details: err.details })
    for (const leak of ['INSERT', 't_ICItem', 'K3SRV', 'sql.customer.local', '/tmp', 'password']) {
      expect(serialized).not.toContain(leak)
    }
    // It DOES name the source id — that is what an operator must add to the allowlist to fix it.
    expect(serialized).toContain('src-1')
  })

  it('the error type is the caller layer’s own, and carries the fixed code/status', () => {
    delete process.env[ENV_KEY]
    const err = refusalOf(() => assertOutboundSqlWriteAuthorized(buildError, { systemId: 's', operation: 'statement' }))
    expect(err.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(err.status).toBe(403)
    expect(new OutboundSqlWriteGateError(500, 'X', 'm').name).toBe('OutboundSqlWriteGateError')
  })
})

// ─────────────────── PART 2 — THE WRITE/READ SPLIT ───────────────────

// The statements that defeated the destination sniffer across four rounds. Under the capability gate
// they are not special: each is simply "not provably a pure read", therefore a write.
const DEFEATED_THE_SNIFFER = [
  "UPDATE t SET FNumber='X' FROM t_ICItem AS t WHERE t.FItemID=1", // round-3: UPDATE…FROM alias
  "DELETE t FROM t_ICItem t WHERE t.FItemID=1",                    // round-3: DELETE…FROM alias
  "UPDATE TOP (5) t_ICItem SET FNumber='X'",                       // round-3: TOP before the table
  "INSERT INTO srv.AIS.dbo.t_ICItem (FItemID) VALUES (1)",         // round-3: 4-part linked-server name
  "WITH c AS (SELECT 1 AS n) DELETE FROM t_ICItem",                // round-4: data-modifying CTE
  "WITH c AS (SELECT 1 AS n) UPDATE t_ICItem SET FNumber='X'",
  "SELECT * FROM OPENQUERY(K3SRV, 'DELETE FROM t_ICItem')",        // round-4: cross-server smuggling
]

// Unterminated batches: T-SQL needs no `;`, so these LEAD with SELECT and carry no separator.
const NO_SEMICOLON_BATCHES = [
  'SELECT 1\nDELETE FROM t_ICItem',
  "SELECT 1\nINSERT t_ICItem(FName) VALUES('x')", // INSERT without INTO
  'SELECT 1\nTRUNCATE TABLE t_ICItem',
  'SELECT 1\nEXEC dbo.usp_x',
]

// P0: the verbs that DEFEATED the write-verb BLOCKLIST — none was on the old list, so
// `SELECT 1\n<verb>` classified as a READ and skipped the gate. UPDATETEXT/WRITETEXT mutate table
// data; BACKUP/RESTORE exfiltrate or DoS; the rest are DDL/DCL/admin. Each is a RESERVED keyword
// outside the read grammar, so the allowlist now catches it — both bare and as a batch tail.
const BLOCKLIST_ESCAPERS = [
  'WRITETEXT t.c @p 0x41',
  'UPDATETEXT t.c @p 0 0 0x41',
  'BACKUP DATABASE AIS TO DISK = @p',
  'RESTORE DATABASE AIS FROM DISK = @p',
  'DBCC WRITEPAGE (1, 1, 1, 0, 1, 0x00)',
  'RECONFIGURE',
  'CHECKPOINT',
  'KILL 53',
  'RECEIVE TOP (1) * FROM my_queue',
  "WAITFOR DELAY '00:00:05'",
  'READTEXT t.c @p 0 1',
  'USE master',
  'SET NOCOUNT ON',
  'DECLARE @x INT',
]

const PLAIN_WRITES = [
  "INSERT INTO staging (a) VALUES (1)",
  "UPDATE staging SET a=1",
  "DELETE FROM staging",
  "MERGE INTO staging AS t USING s ON 1=1 WHEN MATCHED THEN UPDATE SET a=1",
  "EXEC dbo.usp_anything",
  "DROP TABLE staging",
]

const PURE_READS = [
  'SELECT 1',
  '  select * from t ',
  'SELECT TOP 10 * FROM t_ICItem WHERE a=1', // a read OF a K3 table is still a read
  'SELECT 1;',                                // a single trailing semicolon is fine
  'EXPLAIN SELECT 1',
  'show tables',
  "SELECT a FROM t WHERE note = 'DELETE FROM t_ICItem'", // a write verb only inside a literal
  'SELECT [delete] FROM t',                              // …or only inside a bracketed identifier
  'SELECT "update" FROM t',                              // …or a quoted identifier
  // The SHAPES MSSQLAdapter itself builds and runs — these must stay reads or every K3/PLM read breaks.
  'SELECT 1 AS ok',                                                    // testConnection
  'SELECT TOP (5) [FItemID], [FNumber], [FName] FROM [dbo].[t_ICItem]',// select() TOP form
  "SELECT TOP (10) [a] FROM [dbo].[t] INNER JOIN [dbo].[u] ON [t].[id] = [u].[id] WHERE [x] = @p0 ORDER BY [a] ASC OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY", // select() offset/fetch + join
  "SELECT TABLE_NAME AS table_name, TABLE_SCHEMA AS table_schema FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", // getSchema
  'SELECT i.name AS index_name, i.is_unique AS is_unique, c.name AS column_name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id JOIN sys.tables t ON t.object_id = i.object_id', // getTableInfo indexes
  'SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1', // exists probe
  // Common read grammar a federated/customer read might use.
  'SELECT a, ROW_NUMBER() OVER (PARTITION BY b ORDER BY c DESC) AS rn FROM t',
  'SELECT CASE WHEN a IS NULL THEN 0 ELSE 1 END, COALESCE(b, 0), CAST(c AS INT) FROM t',
  'SELECT a FROM t WHERE a IN (1,2,3) AND b BETWEEN 1 AND 9 AND c LIKE @p0',
  'SELECT a FROM t UNION SELECT a FROM u',
  'SELECT a FROM t GROUP BY a HAVING COUNT(*) > 1',
  'SELECT * FROM (VALUES (1),(2)) AS v(x)',
  'WITH c AS (SELECT * FROM t WHERE a > @p0) SELECT * FROM c JOIN u ON c.id = u.id', // CTE read
]

describe('outbound SQL write gate — the write/read split is the ONLY classification', () => {
  it('every statement that defeated the destination sniffer is simply a WRITE', () => {
    for (const sql of DEFEATED_THE_SNIFFER) {
      expect(isPureReadStatement(sql)).toBe(false)
      expect(isSqlWriteStatement(sql)).toBe(true)
    }
  })

  it('an unterminated multi-statement batch is a WRITE (no `;` to split on)', () => {
    for (const sql of NO_SEMICOLON_BATCHES) {
      expect(isPureReadStatement(sql)).toBe(false)
    }
  })

  it('EXECUTED P0: every verb that escaped the blocklist is a WRITE — bare and as a SELECT-batch tail', () => {
    for (const sql of BLOCKLIST_ESCAPERS) {
      expect(isPureReadStatement(sql)).toBe(false)                 // bare
      expect(isPureReadStatement(`SELECT 1\n${sql}`)).toBe(false)  // hidden behind a leading SELECT
    }
  })

  it('EXECUTED P0 (end to end): the escaper verbs are refused as unarmed writes', () => {
    delete process.env[ENV_KEY]
    for (const sql of BLOCKLIST_ESCAPERS) {
      const err = refusalOf(() => assertSqlStatementWriteAuthorized(buildError, `SELECT 1\n${sql}`, { id: 's1', name: 's1', type: 'sqlserver' }))
      expect(err.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    }
  })

  it('plain writes and explicit batches are writes', () => {
    for (const sql of [...PLAIN_WRITES, 'SELECT 1; DROP TABLE t', 'SELECT * INTO backup FROM t']) {
      expect(isPureReadStatement(sql)).toBe(false)
    }
  })

  it('pure reads pass — including reads of any table, and write words inside literals/identifiers', () => {
    for (const sql of PURE_READS) {
      expect(isPureReadStatement(sql)).toBe(true)
      expect(isSqlWriteStatement(sql)).toBe(false)
    }
  })

  it('empty / whitespace is NOT a pure read (fail-closed)', () => {
    for (const sql of ['', '   ', ';']) expect(isPureReadStatement(sql)).toBe(false)
  })

  it('a CTE that terminates in a SELECT is a READ; a CTE that hides a write is a WRITE', () => {
    // The read-grammar allowlist verifies the CTE terminates in a read, so a genuine CTE-read is now
    // correctly a READ (no bespoke parse). A CTE hiding a write carries a reserved write verb and
    // fails the allowlist.
    expect(isPureReadStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true)
    expect(isPureReadStatement('WITH a AS (SELECT 1 n), b AS (SELECT n*2 m FROM a) SELECT m FROM b')).toBe(true)
    for (const write of [
      'WITH c AS (SELECT 1 AS n) DELETE FROM t_ICItem',
      'WITH c AS (SELECT 1 AS n) UPDATE t_ICItem SET a=1',
      'WITH c AS (SELECT 1 AS n) INSERT INTO t SELECT n FROM c',
      'WITH c AS (SELECT 1) MERGE INTO t USING c ON 1=1 WHEN MATCHED THEN UPDATE SET a=1',
    ]) {
      expect(isPureReadStatement(write)).toBe(false)
    }
  })

  // FIX 1 (P0 lexer): a `/*` that is STRING CONTENT must not open a comment span, and a later `*/`
  // (also string content) must not close one. The old strip ran the block-comment regex INDEPENDENTLY
  // of and BEFORE the string-literal regex, so these payloads had the entire middle statement — a real
  // UPDATE/DELETE/INSERT — deleted as a "comment", collapsing to `SELECT ''` and classifying READ. A
  // single-pass tokenizer treats a `/*` inside a string as string content, so the write survives and
  // is seen. Each payload is an unterminated batch (no `;`) whose verdict therefore turns ENTIRELY on
  // the lexer: without the swallow it is plainly a write-verb-bearing batch.
  const STRING_EMBEDDED_COMMENT_SWALLOWERS = [
    "SELECT '/*'\nUPDATE t_ICItem SET FQty=0\nSELECT '*/'",       // swallows an UPDATE
    "SELECT '/*'\nDELETE FROM t_ICItem\nSELECT '*/'",             // swallows a DELETE
    "SELECT '/*'\nINSERT INTO t_ICItem(FItemID) VALUES(1)\nSELECT '*/'", // swallows an INSERT
  ]

  it('FIX 1: a comment marker that is STRING CONTENT cannot swallow a write (single-pass lexer)', () => {
    for (const sql of STRING_EMBEDDED_COMMENT_SWALLOWERS) {
      expect(isPureReadStatement(sql)).toBe(false)
      expect(isSqlWriteStatement(sql)).toBe(true)
    }
  })

  it('FIX 1 (end to end): the string-embedded-comment swallowers are refused as unarmed writes', () => {
    delete process.env[ENV_KEY]
    for (const sql of STRING_EMBEDDED_COMMENT_SWALLOWERS) {
      const err = refusalOf(() => assertSqlStatementWriteAuthorized(buildError, sql, { id: 's1', name: 's1', type: 'sqlserver' }))
      expect(err.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    }
  })

  it('FIX 1: a REAL block comment / line comment / bracket / quote around a read still strips to a READ', () => {
    // The tokenizer still recognises genuine comments and quoted/bracketed identifiers — it only
    // refuses to let STRING content open/close a comment. These remain reads.
    expect(isPureReadStatement('/* a real comment */ SELECT 1')).toBe(true)
    expect(isPureReadStatement('SELECT 1 -- trailing line comment that mentions DELETE FROM t')).toBe(true)
    expect(isPureReadStatement('SELECT [delete] /* c */ FROM t')).toBe(true)
    expect(isPureReadStatement('SELECT "update" FROM t /* note: UPDATE */')).toBe(true)
    // SQL Server nests block comments: the inner close must not end the outer comment early.
    expect(isPureReadStatement('SELECT 1 /* outer /* inner */ still comment */')).toBe(true)
    expect(isPureReadStatement('SELECT 1 /* outer /* inner */ DELETE FROM t */')).toBe(true)
  })

  // FIX 4 (P2 over-block): `@@ROWCOUNT` / `@@IDENTITY` are read-only global variables that cannot
  // mutate. The bare word `rowcount` / `identity` is reserved, so before this fix a SELECT of them was
  // classified a WRITE. Widening the read grammar to admit them is safe: the only mutating uses of
  // those words carry an OTHER non-read reserved token (`SET ROWCOUNT`, `SET IDENTITY_INSERT`) or lead
  // with a non-read verb, so no write can flip to a read. `FOR UPDATE` deliberately STAYS a write — it
  // would require admitting the primary write verb `update`, and it is not valid pure-read T-SQL.
  it('FIX 4: SELECT of the read-only @@ROWCOUNT / @@IDENTITY globals is a READ; SET/FOR UPDATE stay writes', () => {
    expect(isPureReadStatement('SELECT @@ROWCOUNT')).toBe(true)
    expect(isPureReadStatement('SELECT @@IDENTITY')).toBe(true)
    expect(isPureReadStatement('SELECT @@ROWCOUNT AS affected, @@IDENTITY AS last_id')).toBe(true)
    // Under-block guard: the session-control / DDL uses of the same words are STILL writes.
    expect(isPureReadStatement('SET ROWCOUNT 5')).toBe(false)
    expect(isPureReadStatement('SET IDENTITY_INSERT t ON')).toBe(false)
    expect(isPureReadStatement('SELECT 1\nSET ROWCOUNT 5')).toBe(false)
    expect(isPureReadStatement('SELECT * FROM t FOR UPDATE')).toBe(false) // update stays a write verb
  })
})

// ─────────────────── PART 3 — THE ENFORCEMENT POINTS ───────────────────

function sqlserverConfig(id: string): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'sqlserver',
    connection: { server: 'sql.customer.local', port: 1433, database: 'AIS' },
    options: { autoConnect: false, readOnly: false },
  }
}

async function managerWith(config: DataSourceConfig) {
  const m = new DataSourceManager()
  await m.addDataSource(config, { ownerId: 'owner-1' })
  return { m, adapter: m.getDataSource(config.id) }
}

// FIX 2: an armed source can only be PINNED from a source that existed at allowlist-LOAD time. So the
// enforcement tests provision the armed source the way a deployment does — as a persisted row observed
// by `loadFromDatabase` — rather than via the API `addDataSource` (which FIX 2 now refuses for an armed
// id). This minimal chainable stub returns the given rows for the load SELECT and swallows every other
// kysely call (persist / soft-delete ignore their result), so the manager's LOAD path pins without a
// live database.
function fakeLoadDb(records: Array<Record<string, unknown>>): unknown {
  const proxy: unknown = new Proxy(function () { /* callable */ }, {
    get(_target, prop) {
      if (prop === 'then') return undefined // never a thenable itself
      if (prop === 'execute') return async () => records
      if (prop === 'executeTakeFirst') return async () => records[0]
      return () => proxy
    },
    apply: () => proxy,
  })
  return proxy
}

function loadRow(config: DataSourceConfig, ownerId = 'owner-1'): Record<string, unknown> {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    config: { connection: config.connection, options: config.options },
    status: 'disconnected',
    last_error: null,
    owner_id: ownerId,
    workspace_id: null,
    is_active: true,
    auto_connect: false, // don't attempt a live connect during load
    deleted_at: null,
  }
}

// Provision + PIN one or more sources via the deploy-controlled load path, then hand back the manager.
async function managerWithProvisioned(...configs: DataSourceConfig[]) {
  const m = new DataSourceManager({ db: fakeLoadDb(configs.map((c) => loadRow(c))) as never })
  await m.loadFromDatabase()
  return { m, adapter: m.getDataSource(configs[0].id) }
}

async function asyncRefusal(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p
  } catch (error) {
    return error as { code?: string; message?: string }
  }
  throw new Error('expected a refusal, but the promise resolved')
}

describe('enforcement — DataSourceManager.query / federatedQuery', () => {
  it('UNARMED: every write is refused before the driver; reads reach it', async () => {
    delete process.env[ENV_KEY]
    const { m, adapter } = await managerWith(sqlserverConfig('unarmed'))
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    const querySpy = vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)

    for (const sql of [...DEFEATED_THE_SNIFFER, ...NO_SEMICOLON_BATCHES, ...PLAIN_WRITES]) {
      expect((await asyncRefusal(m.query('unarmed', sql))).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    }
    expect(querySpy).not.toHaveBeenCalled() // nothing reached the driver

    // Reads are byte-identical to a deployment that never heard of this gate.
    await expect(m.query('unarmed', 'SELECT TOP 1 * FROM t_ICItem')).resolves.toBeDefined()
    expect(querySpy).toHaveBeenCalledTimes(1)
  })

  it('UNARMED: a federated write leg is refused', async () => {
    delete process.env[ENV_KEY]
    const { m, adapter } = await managerWith(sqlserverConfig('fed'))
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
    const refusal = await asyncRefusal(m.federatedQuery([
      { dataSourceId: 'fed', sql: 'INSERT INTO staging VALUES (1)', alias: 'a' },
    ]))
    expect(refusal.code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('ARMED: the same writes on the armed (non-K3) target are allowed', async () => {
    armFor('armed')
    const { m, adapter } = await managerWithProvisioned(sqlserverConfig('armed')) // pinned at load
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    const querySpy = vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
    await expect(m.query('armed', "INSERT INTO staging (a) VALUES (1)")).resolves.toBeDefined()
    await expect(m.query('armed', "UPDATE staging SET a=1")).resolves.toBeDefined()
    expect(querySpy).toHaveBeenCalledTimes(2)
  })

  it('ARMED for one source does not arm another', async () => {
    armFor('armed')
    const { m, adapter } = await managerWith(sqlserverConfig('not-armed'))
    vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
    vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
    const refusal = await asyncRefusal(m.query('not-armed', 'INSERT INTO staging VALUES (1)'))
    expect(refusal.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
  })
})

describe('enforcement — MSSQLAdapter.query (the raw-adapter chokepoint)', () => {
  // The real adapter.query: a refused write throws BEFORE the pool is touched; an allowed statement
  // passes the gate and then fails with "Not connected" (no live DB), so "not a gate code" proves it
  // got past the gate.
  it('UNARMED: getDataSource(id).query(<any write>) is refused, incl. every sniffer-defeating shape', async () => {
    delete process.env[ENV_KEY]
    const { adapter } = await managerWith(sqlserverConfig('raw-unarmed'))
    for (const sql of [...DEFEATED_THE_SNIFFER, ...NO_SEMICOLON_BATCHES]) {
      expect((await asyncRefusal(adapter.query(sql))).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
    }
  })

  it('UNARMED: getDataSource(id).insert(...) is refused at the same chokepoint', async () => {
    delete process.env[ENV_KEY]
    const { adapter } = await managerWith(sqlserverConfig('raw-insert'))
    // insert() builds `INSERT INTO [t] …` and calls query() — the gate catches it.
    expect((await asyncRefusal(adapter.insert('staging', { a: 1 }))).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('UNARMED: beginTransaction is refused (it vends a raw driver handle outside the funnel)', async () => {
    delete process.env[ENV_KEY]
    const { adapter } = await managerWith(sqlserverConfig('raw-txn'))
    expect((await asyncRefusal(adapter.beginTransaction())).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('UNARMED: a read passes the gate (fails only later, at connect)', async () => {
    delete process.env[ENV_KEY]
    const { adapter } = await managerWith(sqlserverConfig('raw-read'))
    const err = await asyncRefusal(adapter.query('SELECT TOP 1 * FROM t_ICItem'))
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(String(err.message)).toMatch(/Not connected/)
  })

  it('ARMED: a write passes the gate (fails only later, at connect)', async () => {
    armFor('raw-armed')
    const { adapter } = await managerWithProvisioned(sqlserverConfig('raw-armed')) // pinned at load
    const err = await asyncRefusal(adapter.query("INSERT INTO staging (a) VALUES (1)"))
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(String(err.message)).toMatch(/Not connected/)
  })
})

describe('outbound SQL write gate — env tampering cannot unlock it', () => {
  it('only the one env key arms the gate; neighbours and truthy values do nothing', async () => {
    delete process.env[ENV_KEY]
    const decoys = [
      'INTEGRATION_CORE_OUTBOUND_SQL_WRITE',
      'INTEGRATION_CORE_OUTBOUND_SQL_WRITE_TARGETS_ENABLED',
      'OUTBOUND_SQL_WRITE_DISABLED',
      'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS', // the OTHER lane's key must not arm this one
      'SQL_WRITE_ENABLED',
    ]
    const saved = decoys.map((k) => [k, process.env[k]] as const)
    try {
      for (const k of decoys) process.env[k] = 'true'
      const { m, adapter } = await managerWith(sqlserverConfig('tamper'))
      vi.spyOn(adapter, 'isConnected').mockReturnValue(true)
      vi.spyOn(adapter, 'query').mockResolvedValue({ data: [], rowCount: 0 } as never)
      expect((await asyncRefusal(m.query('tamper', 'INSERT INTO staging VALUES (1)'))).code)
        .toBe(OUTBOUND_SQL_WRITE_DISABLED)
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('pointing the env at a file that arms nothing still denies', () => {
    process.env[ENV_KEY] = writeAllowlistFile({ allowlistId: 'a', allowlistVersion: 1, targets: [] })
    expect(evaluateOutboundSqlWrite({ systemId: 's1', operation: 'statement' }).authorized).toBe(false)
  })
})

// ─────────────────── PART 4 — ARM-BINDING (P1): identity is not forgeable/redirectable ──────────

describe('SQL write arm-binding — the fingerprint', () => {
  it('depends on destination fields only, and is blind to options/credentials', () => {
    const a = { server: 'sql.local', port: 1433, database: 'AIS' }
    expect(sqlConnectionFingerprint(a)).toBe(sqlConnectionFingerprint({ ...a }))
    // case / whitespace normalized
    expect(sqlConnectionFingerprint(a)).toBe(sqlConnectionFingerprint({ server: 'SQL.LOCAL ', port: 1433, database: 'ais' }))
    // options / credentials do not change it
    expect(sqlConnectionFingerprint(a)).toBe(sqlConnectionFingerprint({ ...a, encrypt: true } as never))
    // a destination change DOES change it
    expect(sqlConnectionFingerprint(a)).not.toBe(sqlConnectionFingerprint({ ...a, database: 'K3' }))
    expect(sqlConnectionFingerprint(a)).not.toBe(sqlConnectionFingerprint({ ...a, server: 'k3.local' }))
    // no leakage: a fingerprint is a hex digest, not a host
    expect(sqlConnectionFingerprint(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(sqlConnectionFingerprint(a)).not.toContain('sql.local')
  })
})

describe('SQL write arm-binding — enforcement (P1)', () => {
  const armedConn = { server: 'staging.local', port: 1433, database: 'STAGE' }
  const k3Conn = { server: 'k3.local', port: 1433, database: 'AIS' }

  function config(id: string, connection: Record<string, unknown>): DataSourceConfig {
    return { id, name: id, type: 'sqlserver', connection, options: { autoConnect: false, readOnly: false } }
  }

  it('(honest) an armed source at its pinned connection still writes', async () => {
    armFor('honest')
    // FIX 2: the armed source is PROVISIONED at load (a deploy-controlled row), which is what pins it —
    // not an API create, which FIX 2 now refuses for an armed id.
    const { adapter: a } = await managerWithProvisioned(config('honest', armedConn))
    // passes gate + binding, then fails only at connect (no DB) — not with a gate/binding code.
    const err = await asyncRefusal(a.query("INSERT INTO staging (a) VALUES (1)"))
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(String(err.message)).toMatch(/Not connected/)
  })

  it('(ii redirect) redirecting an armed source drops its authorization', async () => {
    armFor('redir')
    const { m } = await managerWithProvisioned(config('redir', armedConn)) // pins staging.local at load
    // the operator PUT-redirects the connection to K3 (deep-merge mutable).
    await m.updateDataSource('redir', config('redir', k3Conn), { ownerId: 'owner-1' })
    const a = m.getDataSource('redir')
    // armed in the file, but its connection no longer matches the pin → refused.
    const err = await asyncRefusal(a.query("INSERT INTO t_ICItem (FItemID) VALUES (1)"))
    expect(err.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect((err as { details?: { reason?: string } }).details?.reason).toBe('arm_binding_connection_mismatch')
  })

  it('(i id-reuse/revival) recreating an armed id at a new connection cannot inherit authorization', async () => {
    armFor('reuse')
    const { m } = await managerWithProvisioned(config('reuse', armedConn)) // legit source pinned at load
    // attacker soft-deletes and revives the SAME id pointing at K3. The load-time pin persists, so the
    // revival is a legitimate re-observation of an already-provisioned id (not arm-ahead-of-
    // provisioning) — the create is allowed, but the WRITE is refused by the fingerprint mismatch.
    await m.removeDataSource('reuse')
    await m.addDataSource(config('reuse', k3Conn), { ownerId: 'owner-1' })
    const a = m.getDataSource('reuse')
    const err = await asyncRefusal(a.query("INSERT INTO t_ICItem (FItemID) VALUES (1)"))
    expect(err.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED) // pin (staging) ≠ current (K3)
    // and a revival to the SAME connection is not a privilege gain — it matches, but it is the legit destination.
    await m.removeDataSource('reuse')
    await m.addDataSource(config('reuse', armedConn), { ownerId: 'owner-1' })
    const b = m.getDataSource('reuse')
    const ok = await asyncRefusal(b.query("INSERT INTO staging VALUES (1)"))
    expect(ok.code).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(String(ok.message)).toMatch(/Not connected/)
  })

  it('the binding NEVER widens authorization: an unarmed source is still refused by the gate', async () => {
    delete process.env[ENV_KEY]
    const m = new DataSourceManager()
    await m.addDataSource(config('unarmed', armedConn), { ownerId: 'o' }) // unarmed ⇒ create is allowed
    const a = m.getDataSource('unarmed')
    expect((await asyncRefusal(a.query('INSERT INTO staging VALUES (1)'))).code).toBe(OUTBOUND_SQL_WRITE_DISABLED)
  })

  it('sqlSourceConnectionMatchesPin fails closed when a source was never observed', () => {
    __resetSqlArmBindingsForTests()
    expect(sqlSourceConnectionMatchesPin('never-seen', armedConn)).toBe(false)
  })

  it('a redirect drops write authorization but READS still pass on the redirected source', async () => {
    armFor('redir-read')
    const { m } = await managerWithProvisioned(config('redir-read', armedConn))
    await m.updateDataSource('redir-read', config('redir-read', k3Conn), { ownerId: 'owner-1' })
    const a = m.getDataSource('redir-read')
    // reads are never gated — they pass to the connect attempt regardless of the binding.
    const err = await asyncRefusal(a.query('SELECT TOP 1 * FROM t_ICItem'))
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(String(err.message)).toMatch(/Not connected/)
  })
})

// ─── FIX 2 — arming binds ONLY to a source provisioned at allowlist-load time ─────────────────────
describe('SQL write arm-binding — FIX 2: arm-ahead-of-provisioning is refused', () => {
  const attackerConn = { server: 'k3.local', port: 1433, database: 'AIS' }
  const armedConn = { server: 'staging.local', port: 1433, database: 'STAGE' }

  function config(id: string, connection: Record<string, unknown>): DataSourceConfig {
    return { id, name: id, type: 'sqlserver', connection, options: { autoConnect: false, readOnly: false } }
  }

  // A db that RECORDS every persisted row, so a test can prove a refused create never reached persist.
  function recordingDb(inserted: Array<Record<string, unknown>>): unknown {
    const proxy: unknown = new Proxy(function () { /* callable */ }, {
      get(_t, prop) {
        if (prop === 'then') return undefined
        if (prop === 'values') return (rec: Record<string, unknown>) => { inserted.push(rec); return proxy }
        if (prop === 'execute') return async () => []
        if (prop === 'executeTakeFirst') return async () => undefined
        return () => proxy
      },
      apply: () => proxy,
    })
    return proxy
  }

  it('a fresh API-tier create of an armed-but-never-provisioned id is REFUSED, not self-authorized', async () => {
    armFor('deploy-armed-never-provisioned')
    const m = new DataSourceManager() // no db, no load ⇒ the armed id was never provisioned at load
    const err = await asyncRefusal(
      m.addDataSource(config('deploy-armed-never-provisioned', attackerConn), { ownerId: 'attacker' }),
    )
    expect(err.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect((err as { details?: { reason?: string } }).details?.reason).toBe('arm_ahead_of_provisioning')
    // the source was never registered — so no create-time observation could have pinned the attacker.
    expect(() => m.getDataSource('deploy-armed-never-provisioned')).toThrow()
  })

  it('the refusal happens BEFORE persistence, so a later restart cannot pin the attacker either', async () => {
    armFor('armed-unprovisioned')
    const inserted: Array<Record<string, unknown>> = []
    const m = new DataSourceManager({ db: recordingDb(inserted) as never }) // no load ⇒ no pin for the id
    const err = await asyncRefusal(
      m.addDataSource(config('armed-unprovisioned', attackerConn), { ownerId: 'attacker' }),
    )
    expect((err as { details?: { reason?: string } }).details?.reason).toBe('arm_ahead_of_provisioning')
    expect(inserted).toHaveLength(0) // nothing was persisted, so no row exists for a restart to pin
  })

  it('an UNARMED id is created freely (the guard only fires for armed ids)', async () => {
    armFor('some-other-armed-id') // arms a DIFFERENT id
    const m = new DataSourceManager()
    await expect(m.addDataSource(config('an-ordinary-source', attackerConn), { ownerId: 'o' })).resolves.toBeDefined()
    expect(m.getDataSource('an-ordinary-source')).toBeDefined()
  })

  it('an armed id PROVISIONED at load is pinned and its write passes the gate + binding', async () => {
    armFor('provisioned-at-load')
    const { adapter } = await managerWithProvisioned(config('provisioned-at-load', armedConn))
    const ok = await asyncRefusal(adapter.query("INSERT INTO staging VALUES (1)"))
    expect(ok.code).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(ok.code).not.toBe(OUTBOUND_SQL_WRITE_DISABLED)
    expect(String(ok.message)).toMatch(/Not connected/)
  })
})

// ─── FIX 3 — an armed source must name an explicit destination database ───────────────────────────
describe('SQL write arm-binding — FIX 3: a blank destination database is refused', () => {
  const blankDbConn = { server: 'sql.local', port: 1433 } // NO database ⇒ resolves to the login default
  const explicitDbConn = { server: 'sql.local', port: 1433, database: 'STAGE' }

  function config(id: string, connection: Record<string, unknown>): DataSourceConfig {
    return { id, name: id, type: 'sqlserver', connection, options: { autoConnect: false, readOnly: false } }
  }

  it('an armed write on a BLANK-database source is refused (ambiguous, credential-redirectable target)', async () => {
    armFor('blank-db')
    const { adapter } = await managerWithProvisioned(config('blank-db', blankDbConn))
    const err = await asyncRefusal(adapter.query("INSERT INTO staging VALUES (1)"))
    expect(err.code).toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect((err as { details?: { reason?: string } }).details?.reason).toBe('arm_binding_ambiguous_database')
  })

  it('the same armed write with an EXPLICIT database passes the gate and the binding', async () => {
    armFor('explicit-db')
    const { adapter } = await managerWithProvisioned(config('explicit-db', explicitDbConn))
    const err = await asyncRefusal(adapter.query("INSERT INTO staging VALUES (1)"))
    expect(err.code).not.toBe(OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED)
    expect(String(err.message)).toMatch(/Not connected/)
  })

  it('WHY: a blank database is indistinguishable by fingerprint, an explicit one is not', () => {
    // Two blank-database connections on the same server hash identically — a login swap whose default
    // DB differs is invisible to the pin. An explicit database folds the catalog into the fingerprint,
    // so K3 vs STAGE on the SAME server are distinct pins and a redirect breaks the binding.
    expect(sqlConnectionFingerprint({ server: 'sql.local', port: 1433 }))
      .toBe(sqlConnectionFingerprint({ server: 'sql.local', port: 1433 }))
    expect(sqlConnectionFingerprint({ server: 'sql.local', port: 1433, database: 'STAGE' }))
      .not.toBe(sqlConnectionFingerprint({ server: 'sql.local', port: 1433, database: 'AIS' }))
  })
})
